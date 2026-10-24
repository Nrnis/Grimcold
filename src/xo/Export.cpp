#include "xo/Export.h"

#include "thirdparty/json.hpp"
#include "xo/Archive.h"
#include "xo/Paint.h"
#include "xo/Parallel.h"
#include "xo/Texture.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <functional>
#include <memory>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <set>
#include <unordered_map>
#include <sstream>

namespace xo {
namespace {

bool endsWith(std::string_view s, std::string_view suf) {
    return s.size() >= suf.size() && s.compare(s.size() - suf.size(), suf.size(), suf) == 0;
}

std::string fileStem(std::string_view gamePath) {
    const size_t slash = gamePath.rfind('/');
    std::string_view name = slash == std::string_view::npos ? gamePath : gamePath.substr(slash + 1);
    const size_t dot = name.rfind('.');
    return std::string(dot == std::string_view::npos ? name : name.substr(0, dot));
}

std::string baseLeaf(std::string_view base) {
    const size_t slash = base.rfind('/');
    return std::string(slash == std::string_view::npos ? base : base.substr(slash + 1));
}

bool truthy(const std::string &v) { return v == "1" || v == "true" || v == "True"; }

// Shader GUIDs appear in either case; prefix is lower case.
bool shaderIs(std::string_view guid, std::string_view prefix) {
    if (guid.size() < prefix.size())
        return false;
    for (size_t i = 0; i < prefix.size(); ++i)
        if (static_cast<char>(std::tolower(static_cast<unsigned char>(guid[i]))) != prefix[i])
            return false;
    return true;
}
// The glass / transparent shader (windows, propeller motion-blur discs).
bool isGlassShader(std::string_view guid) { return shaderIs(guid, "0ba5c7a3"); }
// The lamp shader: glow layers over a part's own surface (see LampBake).
bool isLampShader(std::string_view guid) { return shaderIs(guid, "f3007363"); }

float linFromSrgb(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
float srgbFromLin(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1 / 2.4f) - 0.055f; }

// A number the game wrote as text (a .model's pose range) as it was written: the float's shortest
// decimal form (0.55, not 0.550000011920929).
double asWritten(float f) {
    char buf[32];
    const auto r = std::to_chars(buf, buf + sizeof buf - 1, f);
    *r.ptr = 0;
    return std::strtod(buf, nullptr);
}

// Albedos stored with an alpha channel (BC2/BC3/BC7/RGBA8; BC1 albedos have none).
bool hasAlphaChannel(const GameData &gd, const std::string &base) {
    Texture t;
    std::string e;
    if (!loadTexture(gd, base, t, &e, false))
        return false;
    const PixelFormat f = baseFormat(t.info.format);
    return f == PixelFormat::BC2 || f == PixelFormat::BC3 || f == PixelFormat::BC7 || f == PixelFormat::RGBA8;
}

// What a texture's alpha holds: 0 nothing (no channel, or 1 everywhere: the factory windows' band),
// 1 a cut-out (texels all in or all out: chain-link, grids, nets, water lilies), 2 real see-through
// (cloth, frosted wire). Read at about 256 px, where thin wires still show as in or out; cached.
int alphaKind(const GameData &gd, const std::string &base) {
    static std::mutex mu;
    static std::unordered_map<std::string, int> cache;
    {
        std::lock_guard<std::mutex> lk(mu);
        if (auto it = cache.find(base); it != cache.end())
            return it->second;
    }
    int kind = 0;
    Texture t;
    std::string e;
    if (loadTextureHeader(gd, base, t, &e)) {
        const PixelFormat f = baseFormat(t.info.format);
        if (f == PixelFormat::BC2 || f == PixelFormat::BC3 || f == PixelFormat::BC7 || f == PixelFormat::RGBA8) {
            kind = 2; // (unreadable: keep blending)
            int level = 0;
            while (level + 1 < static_cast<int>(t.info.levels.size()) && std::max(t.info.levels[level].width, t.info.levels[level].height) > 256)
                ++level;
            if (level < static_cast<int>(t.info.levels.size()) && t.info.levels[level].inTfd)
                loadTextureLevels(gd, t, level, level, &e);
            std::vector<uint8_t> rgba;
            uint32_t w = 0, h = 0;
            bool ok = decodeLevel(t, level, rgba, w, h, &e);
            if (!ok && t.firstLevel() > level)
                ok = decodeLevel(t, t.firstLevel(), rgba, w, h, &e);
            if (ok && rgba.size() >= 4) {
                const size_t n = rgba.size() / 4;
                size_t below = 0, partial = 0;
                for (size_t i = 0; i < n; ++i) {
                    const uint8_t a = rgba[i * 4 + 3];
                    below += a < 250;
                    partial += a > 25 && a < 230;
                }
                kind = below * 500 < n ? 0 : partial * 10 < n * 3 ? 1 : 2;
            }
        }
    }
    std::lock_guard<std::mutex> lk(mu);
    cache[base] = kind;
    return kind;
}

// Whether an export bakes a map material's further texture set into its own (TextureWork::composeLayers):
// a two-layer material whose blend needs nothing but its textures, both sets on the first UV set.
bool bakesLayers(const MaterialView &m) {
    if (m.layers.size() != 1 || m.layers[0].uv != 0)
        return false;
    const TextureRef *a = m.texture("albedo"), *a2 = m.texture("albedo2");
    return a && a->exists && a2 && a2->exists && ((shaderIs(m.guid, "62bd5a8e") && m.layers[0].blend[3] == 0) || shaderIs(m.guid, "e611362b"));
}

// Two-sided glow pieces (pin User2: garland strings, signs) shine this much brighter than their
// intensity / 10 says: fitted to newyear_foray's night capture (958203) with the strings drawn from both
// sides, x10.2 over its views (4.6-20.7 view by view; read as an EV100 luminance their intensity of 11
// would give x6.1). The bulbs along the eaves and gables then show as the capture has them.
constexpr float kTwoSidedGlow = 10;

std::vector<uint16_t> narrowIndices(const std::vector<uint32_t> &in) {
    std::vector<uint16_t> out(in.size());
    for (size_t i = 0; i < in.size(); ++i)
        out[i] = static_cast<uint16_t>(in[i]);
    return out;
}

} // namespace

std::string safeFileName(std::string_view s) {
    std::string o;
    for (char c : s) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        o += ok ? c : '_';
    }
    if (o.empty())
        o = "unnamed";
    return o;
}

std::string companionStem(const std::filesystem::path &file) {
    const std::string full = utf8(file.stem());
    std::string o;
    for (char c : full) {
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
        if (ok)
            o += c;
        else if (!o.empty() && o.back() != '_')
            o += '_';
    }
    while (!o.empty() && (o.back() == '_' || o.back() == '.'))
        o.pop_back();
    if (o == full)
        return o;
    // Characters were dropped: add a hash of the real name so "Танк" and "Машина" stay apart.
    uint32_t hsh = 2166136261u;
    for (unsigned char c : full)
        hsh = (hsh ^ c) * 16777619u;
    char suf[16];
    std::snprintf(suf, sizeof(suf), "%s%08x", o.empty() ? "export_" : "_", hsh);
    return o + suf;
}

const TextureRef *MaterialView::texture(std::string_view role) const {
    for (const auto &t : textures)
        if (t.role == role)
            return &t;
    return nullptr;
}

void applyMaterialToMesh(const MaterialView *mv, MeshGeometry &g, bool uvs) {
    if (!mv)
        return;
    if (uvs && mv->uvSet == 1 && !g.uv1.empty())
        g.uv0 = g.uv1;
    if (uvs && mv->uvScale != 1)
        for (float &c : g.uv0)
            c *= mv->uvScale;
    if (mv->foliage && !mv->billboard && !g.normal.empty()) {
        // Trees store no normals. Leaf cards with their own flat normals light like playing cards
        // (half the crown black); outward from the trunk, tilted up, they light as a crown.
        for (uint32_t v = 0; v < g.vertexCount; ++v) {
            const float *p = &g.position[v * 3];
            const float n[3] = {p[0], 0.4f * std::sqrt(p[0] * p[0] + p[2] * p[2]) + 0.3f, p[2]};
            const float l = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
            float *o = &g.normal[v * 3];
            if (l > 1e-6f) {
                o[0] = n[0] / l;
                o[1] = n[1] / l;
                o[2] = n[2] / l;
            } else {
                o[0] = 0;
                o[1] = 1;
                o[2] = 0;
            }
        }
        g.tangent.clear(); // (no normal map is meant for these normals)
        // Leaf cards are seen from both sides. Each triangle a second time, wound the other way, keeps
        // the outward normal on both sides (a double-sided material would flip it on the back).
        const size_t n = g.indices.size();
        g.indices.reserve(n * 2);
        for (size_t t = 0; t + 2 < n; t += 3)
            g.indices.insert(g.indices.end(), {g.indices[t], g.indices[t + 2], g.indices[t + 1]});
    }
}

bool loadBundle(const GameData &gd, std::string_view mdlPath, std::string_view skin, ModelBundle &b, std::string *err) {
    b = ModelBundle{};
    b.mdlPath = normalizeGamePath(mdlPath);
    if (!endsWith(b.mdlPath, ".mdl")) {
        if (err)
            *err = "not a .mdl file: " + b.mdlPath;
        return false;
    }
    const size_t slash = b.mdlPath.rfind('/');
    b.dir = slash == std::string::npos ? std::string() : b.mdlPath.substr(0, slash);
    b.baseName = fileStem(b.mdlPath);
    std::vector<uint8_t> bytes;
    if (!gd.read(b.mdlPath, bytes, err))
        return false;
    if (!parseModel(std::move(bytes), b.model, err))
        return false;

    const std::string stem = b.mdlPath.substr(0, b.mdlPath.size() - 4);
    std::vector<uint8_t> tmp;
    if (gd.find(stem + ".skins") && gd.read(stem + ".skins", tmp, nullptr))
        b.skins = parseSkins(std::string_view(reinterpret_cast<const char *>(tmp.data()), tmp.size()), b.dir);
    if (gd.find(stem + ".model") && gd.read(stem + ".model", tmp, nullptr))
        b.desc = parseModelDesc(std::string_view(reinterpret_cast<const char *>(tmp.data()), tmp.size()), b.dir);
    b.mdfPath = stem + ".mdf";
    b.skin = "default";
    if (!skin.empty() && skin != "default") {
        auto it = std::find_if(b.skins.begin(), b.skins.end(), [&](const Skin &s) { return s.name == skin; });
        if (it != b.skins.end() && gd.find(it->mdf)) {
            b.mdfPath = it->mdf;
            b.skin = it->name;
        } else {
            b.warnings.push_back("skin '" + std::string(skin) + "' not found, using the default look");
        }
    }
    // Some models only ship skins: the "default" entry of the .skins file, or else its first skin
    // (knight helmets on sulfur, the scoreboard digits: no own .mdf, no "default" skin; they were white).
    if (!gd.find(b.mdfPath)) {
        auto it = std::find_if(b.skins.begin(), b.skins.end(), [&](const Skin &s) { return s.name == "default" && gd.find(s.mdf); });
        if (it == b.skins.end())
            it = std::find_if(b.skins.begin(), b.skins.end(), [&](const Skin &s) { return gd.find(s.mdf) != nullptr; });
        if (it != b.skins.end())
            b.mdfPath = it->mdf;
    }
    std::vector<Material> mats;
    if (gd.find(b.mdfPath) && gd.read(b.mdfPath, tmp, nullptr)) {
        std::string perr;
        if (!parseMdf(std::string_view(reinterpret_cast<const char *>(tmp.data()), tmp.size()), mats, &perr))
            b.warnings.push_back(b.mdfPath + ": " + perr);
    } else {
        b.warnings.push_back("no material file (" + b.mdfPath + ")");
    }
    // "*name" = a texture in the model's own folder (trees)
    auto resolveBase = [&](const std::string &value) {
        std::string s = value;
        if (!s.empty() && s[0] == '*')
            s = b.dir + "/" + s.substr(1);
        return textureBase(s);
    };
    const bool mapProp = b.mdlPath.rfind("assets/", 0) == 0;
    for (const auto &m : mats) {
        MaterialView v;
        v.guid = m.guid;
        v.params = m.params;
        const bool speedTree = shaderIs(m.guid, "06bc377b");
        const bool twoLayer = shaderIs(m.guid, "62bd5a8e") || shaderIs(m.guid, "e611362b"); // (a whole second material: see textureRole)
        std::vector<std::pair<int, std::string>> layers; // MaterialLayers: per layer albedo, normal, gloss
        for (const auto &p : m.params) {
            if (p.name == "MaterialLayers") {
                layers.emplace_back(p.index >= 0 ? p.index : static_cast<int>(layers.size()), resolveBase(p.value));
                continue;
            }
            std::string role = textureRole(p.name, m.guid);
            if (role.empty())
                continue;
            const std::string base = resolveBase(p.value);
            if (base.empty())
                continue;
            if (speedTree && role == "albedo2") {
                role = "mask"; // the leaves' alpha-test mask (_at)
            } else if (role == "albedo2" && (shaderIs(m.guid, "16b15fe6") || shaderIs(m.guid, "85f3a2ed"))) {
                // The map props' main shader lights its second slot with User1 = 1, whatever the file is
                // called (projectors_race_red_g, container_house_light); without it the slot holds a dirt
                // or detail layer, or a glow the game leaves off (the hangars' windows01_glow). Overlays
                // (85F3A2ED) also light their second slot only with User1 = 1: the new-year houses'
                // wood_detales_8m_glow windows stay dark in newyear_foray's night capture, while
                // oracle_altar's coal_e (User1 = 1) glows (ui/viewer.js Viewer.glowOff).
                if (std::atoi(m.value("User1").c_str()) == 1)
                    role = "emissive";
            } else if ((role == "albedo2" && !twoLayer) || role == "colormap") {
                // Second diffuse / colour-map slots mostly carry glow maps (_e, _glow, _anim).
                const std::string leaf = base.substr(base.rfind('/') + 1);
                for (const char *suf : {"_e", "_glow", "_glow2", "_anim"})
                    if (endsWith(leaf, suf) && std::none_of(v.textures.begin(), v.textures.end(), [](const TextureRef &t) { return t.role == "emissive"; }))
                        role = "emissive";
            }
            v.textures.push_back({role, p.name, base, gd.find(base + ".tfh") != nullptr});
        }
        // Emission layers: layered materials with AdditiveBlend and the two emission shaders 39E61427
        // (parts' separate light models) and A7516479 (gameplay objects, map props: garlands, a moon,
        // pumpkins): one colour texture per layer, multiplied into a glow (GlowLook below), added on
        // with AdditiveBlend and otherwise blended by its alpha; UserParam0 is the intensity, not a
        // tiling (a barrier's "turned_off" skin has 3 where "on" has 12).
        const bool additiveLayers = !layers.empty() && truthy(m.value("AdditiveBlend"));
        const bool emissionLayers = !layers.empty() && (additiveLayers || shaderIs(m.guid, "39e61427") || shaderIs(m.guid, "a7516479"));
        if (emissionLayers) {
            std::sort(layers.begin(), layers.end());
            for (const auto &[ix, base] : layers)
                if (ix < 2 && !base.empty())
                    v.textures.push_back({ix == 0 ? "albedo" : "colormap", "MaterialLayers" + std::to_string(ix), base, gd.find(base + ".tfh") != nullptr});
        } else if (!layers.empty()) {
            // Layered map material: layers blend by vertex colour and height, which glTF has no
            // way to say; the first layer stands for the material, with its tiling and UV set. A
            // layer whose albedo the game files lack (some mapskit grounds, snow) gives way to the next.
            std::sort(layers.begin(), layers.end());
            auto layerBase = [&](int ix) {
                for (const auto &[i, base] : layers)
                    if (i == ix)
                        return base;
                return std::string();
            };
            int use = 0;
            for (int k = 0; k < 4; ++k) {
                const std::string a = layerBase(3 * k);
                if (!a.empty() && gd.find(a + ".tfh")) {
                    use = k;
                    break;
                }
            }
            const char *roles[3] = {"albedo", "normal", "gloss"};
            for (int r = 0; r < 3; ++r) {
                const std::string base = layerBase(3 * use + r);
                if (!base.empty())
                    v.textures.push_back({roles[r], "MaterialLayers" + std::to_string(3 * use + r), base, gd.find(base + ".tfh") != nullptr});
            }
            float tiling[4] = {0, 0, 0, 0};
            {
                const std::string t = m.value("UserParam0_Float4");
                const char *q = t.c_str();
                for (int i = 0; i < 4 && *q; ++i) {
                    char *end = nullptr;
                    tiling[i] = std::strtof(q, &end);
                    if (end == q)
                        break;
                    q = end;
                }
            }
            if (tiling[use] > 0.01f && tiling[use] < 1000)
                v.uvScale = tiling[use];
            v.uvSet = std::atoi(m.value("Mat" + std::to_string(use) + "UvType").c_str()) == 1 ? 1 : 0;
            // The layers over it, up to LayersCount, for the view to blend (MapLayer): each with its
            // tiling, UV kind (MatkUvType 2 = laid over the world, tiling in metres), inverted height
            // map and blend parameters (UserParam1 / 2), weighed by the vertex colour (User5) or the
            // colour map (ColormapSampler, read through uv2).
            const int count = std::clamp(std::atoi(m.value("LayersCount").c_str()), 1, 3);
            for (int k = use + 1; k < count; ++k) {
                const std::string a = layerBase(3 * k);
                if (a.empty() || !gd.find(a + ".tfh"))
                    continue;
                const std::string set = std::to_string(v.layers.size() + 2); // (the first over it: albedo2 ...)
                for (int r = 0; r < 3; ++r) {
                    const std::string base = layerBase(3 * k + r);
                    if (!base.empty())
                        v.textures.push_back({roles[r] + set, "MaterialLayers" + std::to_string(3 * k + r), base, gd.find(base + ".tfh") != nullptr});
                }
                MapLayer L;
                L.index = k;
                L.tiling = tiling[k] > 0.01f && tiling[k] < 1000 ? tiling[k] : 1;
                L.uv = std::clamp(std::atoi(m.value("Mat" + std::to_string(k) + "UvType").c_str()), 0, 2);
                L.invert = truthy(m.value("Mat" + std::to_string(k) + "InvBlendMap"));
                v.layers.push_back(L); // (its blend parameters below, with the other Float4 values)
            }
            const TextureRef *cm = v.texture("colormap");
            v.weights = cm && cm->exists ? 2 : std::atoi(m.value("User5").c_str()) >= 1 ? 1 : 0;
        }
        // A material with only a second colour layer (the map bulldozer's paint skins: Diffuse2Sampler
        // and no DiffuseSampler) shows that layer rather than plain white.
        if (std::none_of(v.textures.begin(), v.textures.end(), [](const TextureRef &t) { return t.role == "albedo" && t.exists; }))
            for (auto &t : v.textures)
                if (t.role == "albedo2" && t.exists) {
                    t.role = "albedo";
                    break;
                }
        // Glow shaders (GlowLook): the lamp shader, its map-prop twin and additive layers.
        auto float4 = [&](std::string_view name, float out[4]) { // (returns how many numbers it has)
            std::fill(out, out + 4, 0.0f);
            const std::string s = m.value(name);
            const char *p = s.c_str();
            int n = 0;
            for (; n < 4 && *p; ++n) {
                char *end = nullptr;
                const float f = std::strtof(p, &end);
                if (end == p)
                    break;
                out[n] = std::isfinite(f) ? f : 0.0f;
                p = end;
            }
            return n;
        };
        auto texBase = [&](std::string_view param) {
            for (const auto &t : v.textures)
                if (t.param == param)
                    return t.base;
            return std::string();
        };
        float p0[4], p1[4];
        float4("UserParam0_Float4", p0);
        const int p1Given = float4("UserParam1_Float4", p1);
        // The layered material's blend parameters: UserParam1 / 2 for its layers 1 / 2.
        if (!layers.empty() && !emissionLayers)
            for (MapLayer &L : v.layers)
                float4("UserParam" + std::to_string(L.index) + "_Float4", L.blend);
        // The two-layer shaders: a second material (albedo2 / normal2 / gloss2) over the first, each
        // with its own tiling (UserParam0.x / .y); 62BD5A8E's amount, sharpness, offset and world-up
        // term in UserParam0.zw and UserParam1.xy, E611362B's contrast in UserParam0.z. User4 reads the
        // second through uv1 (1) or lays it over the world (2: metres).
        if (twoLayer) {
            const TextureRef *a = v.texture("albedo"), *a2 = v.texture("albedo2");
            if (a && a->param == "DiffuseSampler" && p0[0] > 0.01f && p0[0] < 1000)
                v.uvScale = p0[0];
            if (a && a->exists && a2 && a2->exists) {
                MapLayer L;
                L.tiling = p0[1] > 0.01f && p0[1] < 1000 ? p0[1] : 1;
                L.uv = std::clamp(std::atoi(m.value("User4").c_str()), 0, 2);
                const float blend[4] = {p0[2], p0[3], p1[0], p1[1]};
                if (shaderIs(m.guid, "62bd5a8e"))
                    std::copy(blend, blend + 4, L.blend);
                else
                    L.blend[0] = p0[2];
                v.layers.push_back(L);
            }
        }
        if (isLampShader(m.guid) || shaderIs(m.guid, "644d00c3")) {
            GlowLook &g = v.glow;
            g.on = true;
            g.d = texBase("DiffuseSampler");
            g.c = texBase("ColormapSampler");
            g.gain = std::max(0.0f, p0[0]) / 10;
            g.swap = std::atoi(m.value("User5").c_str()) == 1;
            std::copy(p1, p1 + 4, g.scroll);
            g.spin = p0[2];
            g.additive = !(shaderIs(m.guid, "644d00c3") && truthy(m.value("User4"))); // (build-slot markers: see-through white)
            // (pin User2: both sides - the New Year garland strings face away from the street, down
            // and in, and only showed from below - and kTwoSidedGlow brighter)
            g.twoSided = shaderIs(m.guid, "644d00c3") && truthy(m.value("User2"));
            if (g.twoSided)
                g.gain *= kTwoSidedGlow;
        } else if (emissionLayers) {
            GlowLook &g = v.glow;
            g.on = true;
            g.additive = additiveLayers;
            g.d = texBase("MaterialLayers0");
            g.c = texBase("MaterialLayers1");
            g.gain = std::max(0.0f, p0[0]) / 10;
            if (truthy(m.value("StaticAnimationUv0"))) { // (a flare turning: the lamp shader's 1000 deg/s sits in .y here)
                g.spin = p0[1];
                g.scroll[0] = p1[0], g.scroll[1] = p1[1];
            }
            if (truthy(m.value("StaticAnimationUv1")))
                g.scroll[2] = p1[2], g.scroll[3] = p1[3];
            g.twoSided = truthy(m.value("User2")); // (hangar_newyear's tree and hill strings)
            if (g.twoSided)
                g.gain *= kTwoSidedGlow;
        }
        // Transparency. Vehicle parts: the game drops texels whose albedo alpha is low (nets, grates,
        // chain-link, wires, foliage) with no material switch for it: such materials carry all sorts
        // of pins or none. Only albedos stored with an alpha channel have any, so the format decides.
        // The glass shader blends by that alpha instead.
        // Map props keep heights and masks in the albedo alpha, so there the pins decide: User0 = 1 / 2
        // cut out, 3 blends (windows); the overlay shader 85f3a2ed (cracks, markings, dirt) blends; the
        // layered shader is solid; tree leaves and billboards cut out by their _at mask.
        // The map-prop shaders keep those meanings on gameplay objects and other models outside
        // assets/ (16b15fe6, 62bd5a8e, e611362b, the overlays), so the shader decides, not the folder;
        // in models/ only the vehicle shaders (main, scrolling belts, doll eyes, the bootcamp mine's)
        // go by the albedo alone. Glow shaders blend by themselves (GlowLook).
        const TextureRef *alb = v.texture("albedo");
        const bool albAlpha = alb && alb->exists && hasAlphaChannel(gd, alb->base);
        const bool vehicleShader = shaderIs(m.guid, "fbb75fb5") ||
                                   (!mapProp && (shaderIs(m.guid, "ba811382") || shaderIs(m.guid, "98e16772") || shaderIs(m.guid, "5eef185a")));
        v.blend = isGlassShader(m.guid);
        if (v.glow.on) {
            v.blend = false;
        } else if (speedTree) {
            const TextureRef *mask = v.texture("mask");
            v.alphaTest = std::atoi(m.value("Type").c_str()) != 1 && ((mask && mask->exists) || albAlpha);
            v.foliage = std::atoi(m.value("Type").c_str()) != 1;
            v.billboard = std::atoi(m.value("Type").c_str()) == 2;
        } else if (shaderIs(m.guid, "63ba6d0f")) {
            // 2.41's ground cover: cut out by its own mask (_at), as a tree's leaves are; its colour's
            // alpha is something else (mostly opaque)
            const TextureRef *mask = v.texture("mask");
            v.alphaTest = mask && mask->exists;
        } else if (shaderIs(m.guid, "a658e182")) {
            // The grass shader (mapskit/models/groundcover, the arctic snow chunks) has no switch: the
            // blades' atlases carry a cut-out alpha (cover_a: 87 % holes), the solid debris kinds
            // (stones, bricks, snow chunks) have none.
            v.alphaTest = albAlpha;
        } else if (!layers.empty()) {
            v.blend = false;
            // Grates, railings, ladders, stencilled numbers: the first layer's alpha cuts them out
            // (Mat0AlphaTest / HasDiscard), when that layer is the one shown.
            if (truthy(m.value("Mat0AlphaTest")) || truthy(m.value("HasDiscard")))
                for (const auto &[ix, base] : layers)
                    if (ix == 0 && !base.empty() && gd.find(base + ".tfh"))
                        v.alphaTest = hasAlphaChannel(gd, base);
        } else if (shaderIs(m.guid, "85f3a2ed")) {
            // Overlays blend by the albedo's alpha; a flat colour in an albedo without one (the road
            // markings' color_yellow4_a, painted stripes) shows where the gloss map's red says, the
            // mask every overlay keeps there (the same as the alpha where both exist: corr 0.99).
            const TextureRef *g = v.texture("gloss");
            v.maskFromGloss = !albAlpha && g && g->exists;
            v.blend = albAlpha || v.maskFromGloss;
        } else if (mapProp && shaderIs(m.guid, "98e16772")) {
            v.blend = albAlpha; // (on map props it is glass: windows, broken panes, coach windows)
        } else if (!vehicleShader && !v.blend) {
            const int user0 = std::atoi(m.value("User0").c_str());
            v.alphaTest = albAlpha && (user0 == 1 || user0 == 2);
            v.blend = albAlpha && user0 == 3;
            if (v.blend) { // (by what the alpha really holds)
                const int k = alphaKind(gd, alb->base);
                if (k == 0)
                    v.blend = false; // windows whose alpha is 1 everywhere: solid, with shadows and depth
                else if (k == 1)
                    v.blend = false, v.alphaTest = true; // chain-link, grids, nets, lilies: cut out
            }
        } else {
            v.alphaTest = !v.blend && (truthy(m.value("HasDiscard")) || truthy(m.value("Mat0AlphaTest")) || truthy(m.value("AlphaTest")) || albAlpha);
        }
        v.invisible = truthy(m.value("Invisible"));
        // The plain-colour shader (arctic greybox buildings, castle and funicular details, a cooling
        // tower's inner wall): no textures, the colour in UserParam0 (linear: 0.18 = middle grey).
        if (shaderIs(m.guid, "de4d728d") && std::none_of(v.textures.begin(), v.textures.end(), [](const TextureRef &t) { return t.exists; })) {
            float c[4];
            float4("UserParam0_Float4", c);
            if (c[0] > 0 || c[1] > 0 || c[2] > 0)
                for (int i = 0; i < 3; ++i)
                    v.color[i] = std::clamp(c[i], 0.0f, 1.0f);
        }
        // Heat glow. On a weapon's skinned body the standard shader's second diffuse slot is a heat
        // or charge mask (hot barrels, plasma cells) that the game lights only while the weapon
        // fires: dark in the garage and on the item icons. Separate glow pieces (lights, glowing
        // inserts, projectiles; DisableSkinning) are lit at rest and stay ordinary glow maps.
        const TextureRef *em = v.texture("emissive");
        v.heat = em && textureRole(em->param) == "albedo2" && b.mdlPath.rfind("models/weapons/", 0) == 0 && shaderIs(m.guid, "fbb75fb5") &&
                 !truthy(m.value("DisableSkinning"));
        // Map props' glow maps shine at UserParam1.z times (1 when not given): windows 1 (as bright as
        // the new-year houses' windows show in the game's night pictures), projectors and torches 10-15,
        // dim coach glass 0.1.
        if (em && (shaderIs(m.guid, "16b15fe6") || shaderIs(m.guid, "85f3a2ed")))
            v.emissiveGain = std::max(0.0f, p1Given >= 3 ? p1[2] : 1.0f);
        // 16B15FE6's detail normal map (User2 = 1: det2_n, rust_simple_02_n) repeats UserParam1.x times
        // over the base's UVs.
        const TextureRef *detail = v.texture("detail");
        if (detail && detail->exists && shaderIs(m.guid, "16b15fe6") && truthy(m.value("User2")) && p1[0] > 0)
            v.detailTiling = p1[0];
        b.materials.push_back(std::move(v));
    }
    // A52275F8 without textures is a helper the game does not draw (physics primitives, AR locators,
    // collision or shadow proxies inside props: a 7,014-triangle one in the sand valley's aircraft
    // hangar, a weld clip). Hidden when the model has anything else to show; a model of helpers only
    // (the physics primitives) stays as it is.
    {
        auto helper = [&](size_t k) {
            return k < mats.size() && shaderIs(mats[k].guid, "a52275f8") &&
                   std::none_of(b.materials[k].textures.begin(), b.materials[k].textures.end(), [](const TextureRef &t) { return t.exists; });
        };
        bool others = false;
        for (const auto &me : b.model.meshes)
            if (me.material < b.materials.size() && !b.materials[me.material].invisible && !helper(me.material))
                others = true;
        if (others)
            for (size_t k = 0; k < b.materials.size(); ++k)
                if (helper(k))
                    b.materials[k].invisible = true;
    }
    uint32_t maxMat = 0;
    for (const auto &me : b.model.meshes)
        maxMat = std::max(maxMat, me.material);
    if (!b.model.meshes.empty() && b.materials.size() <= maxMat) {
        if (maxMat >= 4096) { // damaged file: don't make millions of empty materials
            if (err)
                *err = b.mdlPath + ": mesh material index " + std::to_string(maxMat) + " is out of range";
            return false;
        }
        b.warnings.push_back("material list shorter than the mesh expects");
        b.materials.resize(maxMat + 1);
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
bool packGeometry(const ModelBundle &b, int lod, std::vector<uint8_t> &out, std::string *err, bool raw) {
    std::vector<uint8_t> data;
    auto append = [&](const void *p, size_t n) {
        while (data.size() % 4)
            data.push_back(0);
        const size_t off = data.size();
        data.insert(data.end(), static_cast<const uint8_t *>(p), static_cast<const uint8_t *>(p) + n);
        ujson::Value a = ujson::Value::array();
        a.push(static_cast<double>(off));
        a.push(static_cast<double>(n));
        return a;
    };
    ujson::Value meshes = ujson::Value::array();
    for (size_t k = 0; k < b.model.meshes.size(); ++k) {
        const MeshInfo &me = b.model.meshes[k];
        if (lod >= 0 && me.lod != lod)
            continue;
        MeshGeometry g;
        if (!decodeMesh(b.model, me, g, err)) {
            if (err)
                *err = "mesh " + std::to_string(k) + ": " + *err;
            return false;
        }
        const MaterialView *mv = me.material < b.materials.size() ? &b.materials[me.material] : nullptr;
        applyMaterialToMesh(mv, g, !raw);
        ujson::Value m = ujson::Value::object();
        m.set("index", static_cast<double>(k));
        m.set("material", static_cast<double>(me.material));
        m.set("lod", me.lod);
        m.set("vertexCount", static_cast<double>(g.vertexCount));
        m.set("indexCount", static_cast<double>(g.indices.size()));
        m.set("position", append(g.position.data(), g.position.size() * 4));
        if (!g.normal.empty())
            m.set("normal", append(g.normal.data(), g.normal.size() * 4));
        if (!g.tangent.empty())
            m.set("tangent", append(g.tangent.data(), g.tangent.size() * 4));
        if (!g.uv0.empty())
            m.set("uv0", append(g.uv0.data(), g.uv0.size() * 4));
        if (!g.uv1.empty())
            m.set("uv1", append(g.uv1.data(), g.uv1.size() * 4));
        if (raw && !g.uv2.empty())
            m.set("uv2", append(g.uv2.data(), g.uv2.size() * 4));
        if (!g.color.empty() && (!raw || (mv && mv->weights == 1)))
            m.set("color", append(g.color.data(), g.color.size()));
        if (!g.joints.empty()) {
            m.set("joints", append(g.joints.data(), g.joints.size()));
            m.set("weights", append(g.weights.data(), g.weights.size() * 4));
        } else if (me.words[5] == 0 && me.words[6] > 0 && me.words[6] < b.model.nodes.size()) {
            m.set("node", static_cast<double>(me.words[6])); // a rigid mesh riding on this node (a wheel's tyre on its hub)
        }
        if (g.vertexCount <= 65535) {
            const std::vector<uint16_t> idx = narrowIndices(g.indices);
            ujson::Value a = append(idx.data(), idx.size() * 2);
            a.push(2);
            m.set("indices", std::move(a));
        } else {
            ujson::Value a = append(g.indices.data(), g.indices.size() * 4);
            a.push(4);
            m.set("indices", std::move(a));
        }
        meshes.push(std::move(m));
    }
    ujson::Value root = ujson::Value::object();
    root.set("meshes", std::move(meshes));
    const std::string json = root.dump();
    out.clear();
    out.insert(out.end(), {'X', 'O', 'G', 'M'});
    const uint32_t jl = static_cast<uint32_t>(json.size());
    out.insert(out.end(), reinterpret_cast<const uint8_t *>(&jl), reinterpret_cast<const uint8_t *>(&jl) + 4);
    out.insert(out.end(), json.begin(), json.end());
    while (out.size() % 4)
        out.push_back(' ');
    out.insert(out.end(), data.begin(), data.end());
    return true;
}

// ---------------------------------------------------------------------------------------------
namespace {

struct PngFile {
    std::string fileName; // "x_a.png"
    std::vector<uint8_t> png;
    bool extra = false;   // gloss / AO maps written beside the model, never referenced by it
    bool cut = false;     // some texel's alpha is below one half (an alpha-tested material has holes)
};

// Everything the exporter derives from one material's textures.
struct MaterialImages {
    int albedo = -1, normal = -1, orm = -1, emissive = -1; // indices into images
    bool hasAo = false;
    int glow = -1; // a lamp material's baked glow: colour = its light, alpha = how strongly it shows
};

// A two-layer map material's blend, baked (TextureWork::composeLayers): its albedo, normal and gloss
// under names of their own, and their images (held only while that material's images are made).
struct Composite {
    TextureRef ref[3];
    ImageRGBA img[3];
    PixelFormat fmt[3] = {PixelFormat::RGBA8, PixelFormat::BC3, PixelFormat::RGBA8}; // (the normals read back as DXT5nm: the export takes their occlusion from red)
};

// A model's own paint on one of its materials (SceneItem::paint): it takes the place of the paint the
// albedo's colour edit has. meshes: the material's pieces, when the paint goes through their second UV
// set (a pattern, a relief), whose images are then theirs alone (geoKey: the model's).
struct PaintJob {
    Paint paint;
    std::string geoKey;
    std::vector<const MeshGeometry *> meshes;
};

// The pieces a paint is laid over, as Paint.cpp reads them.
std::vector<PaintMesh> paintMeshes(const PaintJob &j) {
    std::vector<PaintMesh> out;
    for (const MeshGeometry *g : j.meshes) {
        if (!g || g->uv0.size() < static_cast<size_t>(g->vertexCount) * 2 || g->position.size() < static_cast<size_t>(g->vertexCount) * 3 || g->indices.size() < 3)
            continue;
        PaintMesh pm;
        pm.pos = g->position.data();
        pm.uv0 = g->uv0.data();
        pm.uv1 = g->uv1.size() >= static_cast<size_t>(g->vertexCount) * 2 ? g->uv1.data() : nullptr;
        pm.idx = g->indices.data();
        pm.triangles = g->indices.size() / 3;
        out.push_back(pm);
    }
    return out;
}

// Whether a paint shows on a material: one with an albedo and a paint mask (its gloss map), not a glow
// and not glass (the game draws it with a shader of its own; the view's rule: ui/viewer.js noPaint).
bool paintable(const MaterialView &m) {
    const TextureRef *a = m.texture("albedo"), *g = m.texture("gloss");
    const bool glass = isGlassShader(m.guid) || (m.blend && shaderIs(m.guid, "98e16772"));
    return !m.lamp.on && !m.glow.on && !glass && a && a->exists && g && g->exists;
}

class TextureWork {
  public:
    TextureWork(const GameData &gd, const ExportOptions &opt, std::vector<std::string> &warnings)
        : gd_(gd), opt_(opt), warnings_(warnings) {}

    std::vector<PngFile> images;

    // Every material's images (one MaterialImages per mats[i]) made on several cores, a material per
    // thread, with the same files, names and order as made one by one: an image is made by the first
    // material to get to it (the others only refer to it), and they are all taken in afterwards in the
    // materials' order. As many materials at once as the memory has room for (each holds its decoded
    // textures while it works). progress(done) after each material (from the worker threads, one at a
    // time); an exception thrown in it (the app closing) stops the rest and comes out of here.
    // jobs: each material's own paint (null: none)
    std::vector<MaterialImages> buildAll(const std::vector<const MaterialView *> &mats, const std::vector<float> &gains, const std::vector<const PaintJob *> &jobs,
                                         const std::function<void(size_t)> &progress) {
        const size_t n = mats.size();
        std::vector<MaterialImages> out(n);
        std::vector<Task> tasks(n);
        size_t done = 0;
        std::mutex progressMu;
        parallelFor(n, [&](size_t i) {
            tlTask = &tasks[i];
            try {
                if (mats[i])
                    out[i] = build(*mats[i], gains[i], i < jobs.size() ? jobs[i] : nullptr);
            } catch (...) {
                tlTask = nullptr;
                throw;
            }
            tlTask = nullptr;
            std::lock_guard lk(progressMu);
            progress(++done);
        }, workersByMemory());
        for (size_t i = 0; i < n; ++i) { // (taken in as one by one: this material's images in the order it asked for them)
            Task &t = tasks[i];
            for (std::string &w : t.warnings)
                warnings_.push_back(std::move(w));
            for (const std::string &key : t.keys) {
                if (byKey_.count(key))
                    continue;
                Made &m = *made_.at(key);
                if (!m.ok)
                    continue; // (it failed: no image, a warning)
                m.file.fileName = uniqueName(safeFileName(m.fileName));
                images.push_back(std::move(m.file));
                byKey_[key] = static_cast<int>(images.size()) - 1;
            }
            auto take = [&](int &v) {
                if (v < -1) {
                    auto it = byKey_.find(t.keys[static_cast<size_t>(-v - 2)]);
                    v = it == byKey_.end() ? -1 : it->second;
                }
            };
            take(out[i].albedo), take(out[i].normal), take(out[i].orm), take(out[i].emissive), take(out[i].glow);
        }
        made_.clear();
        return out;
    }

    // gain: the albedo's brightness (a linear factor; a map's grass kinds brighten their shared atlas);
    // job: the model's own paint on it (null: none)
    MaterialImages build(const MaterialView &m, float gain = 1, const PaintJob *job = nullptr) {
        if (m.lamp.on)
            return buildGlow(m.lamp);
        MaterialImages mi;
        const TextureRef *alb = m.texture("albedo");
        const TextureRef *nrm = m.texture("normal");
        const TextureRef *gls = m.texture("gloss");
        Composite composed;
        const bool baked = composeLayers(m, composed); // (a two-layer map material: its blend, baked)
        if (baked)
            alb = &composed.ref[0], nrm = &composed.ref[1], gls = &composed.ref[2];
        // a texture's image: the baked blend's own (moved out, each read once: freed with this material,
        // not held for the whole export), else the game's
        auto read = [&](const TextureRef *t, ImageRGBA &img, PixelFormat *fmt) {
            for (int r = 0; r < 3; ++r)
                if (baked && t == &composed.ref[r]) {
                    img = std::move(composed.img[r]);
                    if (fmt)
                        *fmt = composed.fmt[r];
                    return !img.rgba.empty();
                }
            return get(t->base, img, fmt);
        };
        ImageRGBA gloss, aoImg;
        bool haveGloss = false, haveAo = false;
        if (gls && gls->exists)
            haveGloss = read(gls, gloss, nullptr);
        // the model's own paint, where the gloss map's red says (Paint.cpp)
        const bool painted = job && haveGloss && !baked;
        const bool paintOn = painted && job->paint.on();
        const PaintImage paintMask{gloss.rgba.data(), gloss.w, gloss.h};
        if (nrm && nrm->exists) {
            const bool relief = paintOn && !job->paint.normal.empty();
            const std::string key = "n:" + nrm->base + (relief ? "|relief=" + job->paint.key() + "|geo=" + job->geoKey : std::string());
            ImageRGBA n;
            PixelFormat fmt = PixelFormat::Unknown;
            const bool replaced = opt_.replace.count(nrm->base) > 0;
            if (read(nrm, n, &fmt)) {
                std::vector<uint8_t> ao;
                const NormalLayout layout = replaced ? NormalLayout::RGB : guessNormalLayout(fmt, n.rgba);
                unpackNormals(n.rgba, layout, &ao);
                if (layout == NormalLayout::AG) {
                    haveAo = true;
                    aoImg.w = n.w;
                    aoImg.h = n.h;
                    aoImg.rgba.resize(ao.size() * 4);
                    for (size_t i = 0; i < ao.size(); ++i) {
                        uint8_t *p = &aoImg.rgba[i * 4];
                        p[0] = p[1] = p[2] = ao[i];
                        p[3] = 255;
                    }
                }
                if (relief) { // (its normal map, unpacked, added on where the paint is)
                    ImageRGBA r;
                    PixelFormat rf = PixelFormat::Unknown;
                    if (get(job->paint.normal, r, &rf)) {
                        unpackNormals(r.rgba, guessNormalLayout(rf, r.rgba), nullptr);
                        applyPaintRelief(n.rgba, n.w, n.h, job->paint, paintMask, PaintImage{r.rgba.data(), r.w, r.h}, paintMeshes(*job));
                    }
                }
                mi.normal = addImage(key, baseLeaf(nrm->base) + (relief ? "_" + job->paint.fileTag() : std::string()) + ".png", n);
                if (opt_.extraMaps && haveAo)
                    addImage("ao:" + nrm->base, baseLeaf(nrm->base) + "_ao.png", aoImg, true);
            }
        }
        if (haveGloss || haveAo) {
            // (a metallic or chrome paint: its roughness and metal where it covers the part, as the view's PAINT_FINISH)
            const bool finish = paintOn && haveGloss && job->paint.finish != Paint::Finish::None;
            const std::string name = (haveGloss ? baseLeaf(gls->base) : baseLeaf(nrm->base)) + (finish ? "_" + job->paint.fileTag() : std::string());
            const std::string key = "orm:" + (haveGloss ? gls->base : std::string()) + "|" + (haveAo ? nrm->base : std::string()) + (finish ? "|paint=" + job->paint.key() : std::string());
            const uint32_t w = haveGloss ? gloss.w : aoImg.w, h = haveGloss ? gloss.h : aoImg.h;
            ImageRGBA orm;
            orm.w = w;
            orm.h = h;
            orm.rgba.assign(static_cast<size_t>(w) * h * 4, 255);
            std::vector<uint8_t> aoRes;
            if (haveAo) {
                if (aoImg.w == w && aoImg.h == h)
                    aoRes = aoImg.rgba;
                else
                    resizeRgba(aoImg.rgba, aoImg.w, aoImg.h, aoRes, w, h);
            }
            for (size_t i = 0; i < static_cast<size_t>(w) * h; ++i) {
                uint8_t *p = &orm.rgba[i * 4];
                p[0] = haveAo ? aoRes[i * 4] : 255;                           // occlusion
                p[1] = haveGloss ? static_cast<uint8_t>(std::max(51, 255 - gloss.rgba[i * 4 + 1])) : 140; // roughness = 1 - gloss, >= 0.2 like the viewer (0.55 without a gloss map)
                p[2] = haveGloss ? gloss.rgba[i * 4 + 2] : 0;                 // metalness = the gloss map's blue, like the viewer
                p[3] = 255;
                if (finish) {
                    const float mk = gloss.rgba[i * 4] / 255.0f * job->paint.amount;
                    p[1] = static_cast<uint8_t>(std::lround(p[1] + (job->paint.finishRough() * 255 - p[1]) * mk));
                    p[2] = static_cast<uint8_t>(std::lround(p[2] + (job->paint.finishMetal() * 255 - p[2]) * mk));
                }
            }
            mi.orm = addImage(key, name + "_orm.png", orm);
            mi.hasAo = haveAo;
            if (opt_.extraMaps && haveGloss)
                addImage("g:" + gls->base, baseLeaf(gls->base) + ".png", gloss, true);
        }
        if (alb && alb->exists) {
            // The finished image's key first: an albedo another material already made (a map's atlases
            // serve many materials) is not decoded and edited all over again.
            // (a baked blend has its first set's edits in it already, under a name of its own:
            // composeLayers; its file is still named as edited)
            const TextureRef *orig = baked ? m.texture("albedo") : alb;
            auto adj = opt_.adjust.find(orig->base);
            ColorAdjust eff = adj != opt_.adjust.end() ? adj->second : ColorAdjust{};
            if (painted)
                eff.paintAmount = 0; // (the model's own paint takes the place of its texture's)
            const bool edits = !eff.isIdentity();
            const bool adjusted = edits && !baked;
            const TextureRef *mask = m.texture("mask");
            const bool masked = mask && mask->exists && m.alphaTest; // trees: the leaves' cut-out is a separate mask (_at)
            // Only cut-outs and glass read the albedo's alpha: an opaque material's PNG goes without
            // it (a quarter smaller, and nothing for an importer to wire up as transparency).
            const bool keepAlpha = m.alphaTest || m.blend;
            const bool glossMask = m.maskFromGloss && haveGloss; // (overlays with a flat colour: where they show is the gloss map's red)
            std::string key = "a:" + alb->base + (masked ? "|mask:" + mask->base : std::string()) + (glossMask ? "|glossmask:" + gls->base : std::string()) +
                              (keepAlpha ? "" : "|opaque");
            if (adjusted) {
                const ColorAdjust &c = eff;
                std::ostringstream k;
                k << key << '|' << c.hue << ',' << c.saturation << ',' << c.brightness << ',' << c.contrast << ',' << c.tintAmount << ',' << c.tint[0]
                  << ',' << c.tint[1] << ',' << c.tint[2] << ',' << c.paintAmount << ',' << c.paint[0] << ',' << c.paint[1] << ',' << c.paint[2];
                if (c.paintAmount > 0) // (the paint goes through this material's gloss map: another material's is another image)
                    k << "|paintmask:" << (haveGloss ? gls->base : std::string("-"));
                key = k.str();
            }
            if (paintOn) // (through this material's gloss map; a pattern through these pieces' second UV set)
                key += "|paint=" + job->paint.key() + "|paintmask:" + gls->base + (job->paint.usesUvs() ? "|geo=" + job->geoKey : std::string());
            const int pct = static_cast<int>(std::lround(gain * 100));
            if (std::abs(gain - 1) > 1e-3f)
                key += "|gain=" + std::to_string(pct);
            ImageRGBA a;
            if (const int done = known(key); done != -1) {
                mi.albedo = done;
            } else if (read(alb, a, nullptr)) {
                const bool edited = edits || opt_.replace.count(orig->base);
                if (masked) {
                    ImageRGBA mk;
                    if (get(mask->base, mk, nullptr)) {
                        std::vector<uint8_t> res;
                        const std::vector<uint8_t> *src = &mk.rgba;
                        if (mk.w != a.w || mk.h != a.h) {
                            resizeRgba(mk.rgba, mk.w, mk.h, res, a.w, a.h);
                            src = &res;
                        }
                        // (x 1.125: the view cuts leaves at their mask x (1 + 0.08 x mip level, at most 1.3), x 1 up
                        // close to about x 1.25 from 50 m out (viewer.js ALPHAMAP_TO); one texture takes x 1.125, the
                        // crowns' coverage the game's bridge capture shows at mid range; a billboard's mask is a distance
                        // field whose 0.5 level is the outline, ui/foliage.js treeLook)
                        const int k = m.billboard ? 8 : 9;
                        for (size_t i = 0; i < static_cast<size_t>(a.w) * a.h; ++i)
                            a.rgba[i * 4 + 3] = static_cast<uint8_t>(std::min(255, ((*src)[i * 4] * k + 4) / 8));
                    }
                }
                if (glossMask) { // (at the larger of the two sizes: road markings are a 4 x 4 yellow over a 1024 px mask)
                    if (static_cast<size_t>(gloss.w) * gloss.h > static_cast<size_t>(a.w) * a.h) {
                        std::vector<uint8_t> up;
                        resizeRgba(a.rgba, a.w, a.h, up, gloss.w, gloss.h);
                        a.rgba.swap(up);
                        a.w = gloss.w, a.h = gloss.h;
                    }
                    std::vector<uint8_t> res;
                    const std::vector<uint8_t> *src = &gloss.rgba;
                    if (gloss.w != a.w || gloss.h != a.h) {
                        resizeRgba(gloss.rgba, gloss.w, gloss.h, res, a.w, a.h);
                        src = &res;
                    }
                    for (size_t i = 0; i < static_cast<size_t>(a.w) * a.h; ++i)
                        a.rgba[i * 4 + 3] = (*src)[i * 4];
                }
                if (adjusted)
                    applyColorAdjust(a.rgba, a.w, a.h, eff, haveGloss ? &gloss.rgba : nullptr, gloss.w, gloss.h);
                if (paintOn) {
                    ImageRGBA pt; // (its pattern or ramp; a texture that can't be read leaves the albedo unpainted, and says so)
                    if (job->paint.kind == Paint::Kind::Color || get(job->paint.tex, pt, nullptr))
                        applyPaint(a.rgba, a.w, a.h, job->paint, paintMask, PaintImage{pt.rgba.empty() ? nullptr : pt.rgba.data(), pt.w, pt.h}, paintMeshes(*job));
                }
                std::string suffix = std::string(edited ? "_custom" : "") + (paintOn ? "_" + job->paint.fileTag() : std::string());
                if (std::abs(gain - 1) > 1e-3f) {
                    uint8_t lut[256];
                    for (int i = 0; i < 256; ++i) {
                        const float c = i / 255.0f, lin = c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f);
                        const float o = std::min(1.0f, lin * gain);
                        lut[i] = static_cast<uint8_t>(std::lround(std::clamp(o <= 0.0031308f ? o * 12.92f : 1.055f * std::pow(o, 1 / 2.4f) - 0.055f, 0.0f, 1.0f) * 255));
                    }
                    for (size_t i = 0; i < static_cast<size_t>(a.w) * a.h; ++i)
                        for (int c = 0; c < 3; ++c)
                            a.rgba[i * 4 + c] = lut[a.rgba[i * 4 + c]];
                    suffix += "_x" + std::to_string(pct);
                }
                if (!keepAlpha)
                    for (size_t i = 3; i < a.rgba.size(); i += 4)
                        a.rgba[i] = 255;
                mi.albedo = addImage(key, baseLeaf(alb->base) + suffix + ".png", a);
            }
        }
        // (a weapon's heat map only when exported hot: at heat 0 Cinema 4D lit it at full whatever the
        // material's emissive factor said, a red-hot barrel on a cold gun)
        if (const TextureRef *em = m.texture("emissive"); em && em->exists && !(m.heat && opt_.heat <= 0)) {
            ImageRGBA e;
            if (get(em->base, e, nullptr))
                mi.emissive = addImage("e:" + em->base, baseLeaf(em->base) + ".png", e);
        }
        return mi;
    }

    // A glow material in one image (see LampBake): the colour texture times the other one (or its
    // mean), with colour edits of the colour texture as the view shows them; alpha = the glow's
    // brightest channel, so where it is black the layer is see-through (a see-through glow keeps the
    // two textures' alpha instead).
    MaterialImages buildGlow(const LampBake &L) {
        MaterialImages mi;
        ImageRGBA a;
        if (L.color.empty() || !get(L.color, a, nullptr))
            return mi;
        std::string key = "glow:" + L.color;
        if (auto adj = opt_.adjust.find(L.color); adj != opt_.adjust.end() && !adj->second.isIdentity()) {
            applyColorAdjust(a.rgba, a.w, a.h, adj->second, nullptr, 0, 0);
            const ColorAdjust &c = adj->second;
            std::ostringstream k;
            k << "|adj=" << c.hue << ',' << c.saturation << ',' << c.brightness << ',' << c.contrast << ',' << c.tintAmount << ',' << c.tint[0] << ','
              << c.tint[1] << ',' << c.tint[2];
            key += k.str();
        }
        std::vector<uint8_t> other;
        if (L.product) {
            ImageRGBA o;
            if (get(L.other, o, nullptr)) {
                if (o.w != a.w || o.h != a.h)
                    resizeRgba(o.rgba, o.w, o.h, other, a.w, a.h);
                else
                    other = std::move(o.rgba);
                key += "|x" + L.other;
            }
        } else {
            char t[80];
            std::snprintf(t, sizeof(t), "|tint=%.4f,%.4f,%.4f,%.4f", L.tint[0], L.tint[1], L.tint[2], L.tint[3]);
            key += t;
        }
        if (!L.additive)
            key += "|alpha";
        float lin[256];
        for (int i = 0; i < 256; ++i)
            lin[i] = linFromSrgb(i / 255.0f);
        const size_t n = static_cast<size_t>(a.w) * a.h;
        for (size_t i = 0; i < n; ++i) {
            uint8_t *p = &a.rgba[i * 4];
            uint8_t top = 0;
            for (int c = 0; c < 3; ++c) {
                const float f = other.empty() ? L.tint[c] : lin[other[i * 4 + c]];
                p[c] = static_cast<uint8_t>(std::lround(std::clamp(srgbFromLin(std::min(1.0f, lin[p[c]] * f)), 0.0f, 1.0f) * 255));
                top = std::max(top, p[c]);
            }
            if (L.additive)
                p[3] = top;
            else
                p[3] = static_cast<uint8_t>(std::lround(p[3] * (other.empty() ? std::clamp(L.tint[3], 0.0f, 1.0f) : other[i * 4 + 3] / 255.0f)));
        }
        mi.glow = addImage(key, baseLeaf(L.color) + "_glow.png", a);
        return mi;
    }

    // Images the exporter made itself (a map's baked ground, its water): (key, file name, image) each;
    // their indices, encoded side by side and taken in in this order (one key: one image, as addImage).
    struct Own {
        std::string key, fileName;
        const ImageRGBA *img;
    };
    std::vector<int> addOwn(const std::vector<Own> &own) {
        std::vector<Task> tasks(own.size());
        parallelFor(own.size(), [&](size_t i) {
            tlTask = &tasks[i];
            if (!byKey_.count(own[i].key)) // (made by a material already: as addImage)
                addImage(own[i].key, own[i].fileName, *own[i].img);
            tlTask = nullptr;
        }, workersByMemory());
        std::vector<int> idx(own.size(), -1);
        for (size_t i = 0; i < own.size(); ++i) {
            for (std::string &w : tasks[i].warnings)
                warnings_.push_back(std::move(w));
            const std::string &key = own[i].key;
            if (!byKey_.count(key)) {
                auto it = made_.find(key);
                if (it == made_.end() || !it->second->ok)
                    continue;
                Made &m = *it->second;
                m.file.fileName = uniqueName(safeFileName(m.fileName));
                images.push_back(std::move(m.file));
                byKey_[key] = static_cast<int>(images.size()) - 1;
            }
            idx[i] = byKey_.at(key);
        }
        made_.clear();
        return idx;
    }

    // A two-layer map material whose second set covers the first by their textures alone (62BD5A8E
    // without a world-up term, E611362B), both read through the first UV set: glTF has one set of
    // textures, so the view's blend (ui/viewer.js LAYER_FRAG, the same rule) is baked into one over one
    // repeat of the first set (exact where a mesh's UVs stay inside it, as on atlas-mapped props; tiled
    // ones repeat it). out: albedo, normal (DXT5nm-style, AO in red) and gloss of the result, named
    // after both sets; false when the material is not such a one. The user's colour edits of the
    // material's albedo go on the first set before the blend, as the view makes them (xoAdjust on the
    // first set's map, its gloss map the paint's mask; the second set as it is).
    bool composeLayers(const MaterialView &m, Composite &out) {
        if (!bakesLayers(m))
            return false;
        const MapLayer &L = m.layers[0];
        const TextureRef *src[2][3] = {{m.texture("albedo"), m.texture("normal"), m.texture("gloss")}, {m.texture("albedo2"), m.texture("normal2"), m.texture("gloss2")}};
        const float ratio = L.tiling / (m.uvScale > 0 ? m.uvScale : 1); // (the second set's repeats per repeat of the first)
        char tag[160];
        std::snprintf(tag, sizeof(tag), "%s|%.4f|%.4f,%.4f,%.4f,%.4f,%d", m.guid.substr(0, 8).c_str(), ratio, L.blend[0], L.blend[1], L.blend[2], L.blend[3], L.invert ? 1 : 0);
        std::string key = tag;
        for (const auto &set : src)
            for (const TextureRef *t : set)
                key += "|" + (t && t->exists ? t->base : std::string("-"));
        const auto adj = opt_.adjust.find(src[0][0]->base);
        const ColorAdjust *edit = adj != opt_.adjust.end() && !adj->second.isIdentity() ? &adj->second : nullptr;
        if (edit) { // (an edited blend is another image: another name)
            std::ostringstream k;
            k << "|adj=" << edit->hue << ',' << edit->saturation << ',' << edit->brightness << ',' << edit->contrast << ',' << edit->tintAmount << ',' << edit->tint[0]
              << ',' << edit->tint[1] << ',' << edit->tint[2] << ',' << edit->paintAmount << ',' << edit->paint[0] << ',' << edit->paint[1] << ',' << edit->paint[2];
            key += k.str();
        }
        uint32_t h32 = 2166136261u; // (a short name for this blend: the same textures blend other ways in other materials)
        for (unsigned char c : key)
            h32 = (h32 ^ c) * 16777619u;
        char hex[12];
        std::snprintf(hex, sizeof(hex), "_%08x", h32);
        auto has = [&](int k, int r) { return src[k][r] && src[k][r]->exists; };
        const char *kinds[3] = {"albedo", "normal", "gloss"};
        for (int r = 0; r < 3; ++r) { // (named after both sets' textures of the kind, or their albedos)
            const TextureRef *first = has(0, r) ? src[0][r] : src[0][0], *second = has(1, r) ? src[1][r] : src[1][0];
            out.ref[r] = {kinds[r], first->param, first->base + "+" + baseLeaf(second->base) + hex, true};
        }
        // the six images: colour (sRGB), normals as unit vectors with their occlusion, gloss maps as stored
        struct Set {
            ImageRGBA albedo, normal, gloss;
            std::vector<uint8_t> ao;
            bool hasGloss = false;
        } sets[2];
        for (int k = 0; k < 2; ++k) {
            Set &S = sets[k];
            if (!get(src[k][0]->base, S.albedo, nullptr))
                return false;
            PixelFormat fmt = PixelFormat::Unknown;
            if (has(k, 1) && get(src[k][1]->base, S.normal, &fmt))
                unpackNormals(S.normal.rgba, opt_.replace.count(src[k][1]->base) ? NormalLayout::RGB : guessNormalLayout(fmt, S.normal.rgba), &S.ao);
            else
                S.normal = {{128, 128, 255, 255}, 1, 1}, S.ao.assign(1, 255);
            S.hasGloss = has(k, 2) && get(src[k][2]->base, S.gloss, nullptr);
            if (!S.hasGloss)
                S.gloss = {{128, 115, 0, 255}, 1, 1}; // (as the view's PLAIN_GLOSS)
        }
        if (edit) // (the paint's mask: the first set's gloss map; none without one)
            applyColorAdjust(sets[0].albedo.rgba, sets[0].albedo.w, sets[0].albedo.h, *edit, sets[0].hasGloss ? &sets[0].gloss.rgba : nullptr, sets[0].gloss.w, sets[0].gloss.h);
        // (the first set's size, or finer where the second needs it, up to the export's texture size)
        const uint32_t cap = opt_.maxTextureSize > 0 ? static_cast<uint32_t>(opt_.maxTextureSize) : 4096;
        auto side = [&](uint32_t a, uint32_t b) {
            uint32_t s = std::max(a, std::min(cap, static_cast<uint32_t>(std::ceil(b * ratio))));
            uint32_t p = 1;
            while (p < s)
                p <<= 1;
            return std::min(std::max(p, a), std::max(a, cap));
        };
        const uint32_t W = side(sets[0].albedo.w, sets[1].albedo.w), H = side(sets[0].albedo.h, sets[1].albedo.h);
        auto sample = [](const ImageRGBA &img, float u, float v, float out4[4]) { // bilinear, wrapped
            const float x = (u - std::floor(u)) * img.w - 0.5f, y = (v - std::floor(v)) * img.h - 0.5f;
            const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
            const float fx = x - x0, fy = y - y0;
            auto at = [&](int xi, int yi, int c) {
                xi = ((xi % static_cast<int>(img.w)) + img.w) % img.w;
                yi = ((yi % static_cast<int>(img.h)) + img.h) % img.h;
                return img.rgba[(static_cast<size_t>(yi) * img.w + xi) * 4 + c] / 255.0f;
            };
            for (int c = 0; c < 4; ++c)
                out4[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
        };
        auto sampleAo = [](const Set &S, float u, float v) { // (nearest: occlusion is soft)
            const uint32_t x = std::min(S.normal.w - 1, static_cast<uint32_t>((u - std::floor(u)) * S.normal.w));
            const uint32_t y = std::min(S.normal.h - 1, static_cast<uint32_t>((v - std::floor(v)) * S.normal.h));
            return S.ao.empty() ? 1.0f : S.ao[static_cast<size_t>(y) * S.normal.w + x] / 255.0f;
        };
        const bool pair = shaderIs(m.guid, "62bd5a8e");
        const float soft = std::max(1 - L.blend[1], 0.02f), amount = L.blend[0] + L.blend[2];
        ImageRGBA ca{std::vector<uint8_t>(static_cast<size_t>(W) * H * 4), W, H}, cn = ca, cg = ca;
        for (uint32_t y = 0; y < H; ++y)
            for (uint32_t x = 0; x < W; ++x) {
                const float u = (x + 0.5f) / W, v = (y + 0.5f) / H;
                float a0[4], a1[4], n0[4], n1[4], g0[4], g1[4];
                sample(sets[0].albedo, u, v, a0), sample(sets[0].normal, u, v, n0), sample(sets[0].gloss, u, v, g0);
                sample(sets[1].albedo, u * ratio, v * ratio, a1), sample(sets[1].normal, u * ratio, v * ratio, n1), sample(sets[1].gloss, u * ratio, v * ratio, g1);
                const float h1 = L.invert ? 1 - g1[0] : g1[0];
                const float t = std::clamp(pair ? (h1 + amount - L.blend[1]) / soft : (g0[0] - h1) * L.blend[0] + 0.5f, 0.0f, 1.0f); // (62BD5A8E: a ramp ending at 1 - amount, as viewer.js xoCover)
                const size_t o = (static_cast<size_t>(y) * W + x) * 4;
                for (int c = 0; c < 3; ++c)
                    ca.rgba[o + c] = static_cast<uint8_t>(std::lround(std::clamp(srgbFromLin(linFromSrgb(a0[c]) * (1 - t) + linFromSrgb(a1[c]) * t), 0.0f, 1.0f) * 255));
                ca.rgba[o + 3] = static_cast<uint8_t>(std::lround(a0[3] * 255)); // (cut-outs keep the first set's alpha)
                float nv[3], len = 0;
                for (int c = 0; c < 3; ++c) {
                    nv[c] = (n0[c] * 2 - 1) * (1 - t) + (n1[c] * 2 - 1) * t;
                    len += nv[c] * nv[c];
                }
                len = len > 1e-12f ? 1 / std::sqrt(len) : 0;
                const float ao = sampleAo(sets[0], u, v) * (1 - t) + sampleAo(sets[1], u * ratio, v * ratio) * t;
                cn.rgba[o] = static_cast<uint8_t>(std::lround(ao * 255));
                cn.rgba[o + 1] = static_cast<uint8_t>(std::lround(std::clamp(nv[1] * len * 0.5f + 0.5f, 0.0f, 1.0f) * 255));
                cn.rgba[o + 2] = 255;
                cn.rgba[o + 3] = static_cast<uint8_t>(std::lround(std::clamp(nv[0] * len * 0.5f + 0.5f, 0.0f, 1.0f) * 255));
                for (int c = 0; c < 3; ++c)
                    cg.rgba[o + c] = static_cast<uint8_t>(std::lround(std::clamp(g0[c] * (1 - t) + (c == 0 ? h1 : g1[c]) * t, 0.0f, 1.0f) * 255));
                cg.rgba[o + 3] = 255;
            }
        out.img[0] = std::move(ca);
        out.img[1] = std::move(cn);
        out.img[2] = std::move(cg);
        return true;
    }

    // The untouched game textures as .dds, kept in memory until the whole export is written.
    void ddsCopies(const MaterialView &m, const std::filesystem::path &dir, std::vector<std::pair<std::filesystem::path, std::vector<uint8_t>>> &out) {
        for (const auto &t : m.textures) {
            if (!t.exists || !ddsDone_.insert(t.base).second)
                continue;
            Texture tex;
            std::string e;
            std::vector<uint8_t> dds;
            if (loadTexture(gd_, t.base, tex, &e) && makeDds(tex, dds, &e))
                out.emplace_back(dir / uniqueName(safeFileName(baseLeaf(t.base)) + ".dds"), std::move(dds));
            else
                warn(t.base + ": " + e);
        }
    }

  private:
    // (a material's work on a worker thread: the keys of the images it asked for, in order, and its warnings)
    struct Task {
        std::vector<std::string> keys;
        std::vector<std::string> warnings;
    };
    // (an image made on a worker thread, by the first material to get to it)
    struct Made {
        std::string fileName;
        PngFile file;
        bool ok = false;
    };
    static inline thread_local Task *tlTask = nullptr; // (this thread's material, while buildAll runs)

    // (the threads to make images on: one per core, as many as the free memory has room for at about
    // 1 GB each - a big two-layer blend holds nine 4096 px images - at least 2)
    static unsigned workersByMemory() { return workersForMemory(1024); }

    void warn(std::string w) {
        if (tlTask)
            tlTask->warnings.push_back(std::move(w));
        else
            warnings_.push_back(std::move(w));
    }

    // An image made (its index) or, at work on a thread, claimed by a material (a reference to it,
    // resolved by buildAll: -2 - its place in this material's keys); -1 if not.
    int known(const std::string &key) {
        if (Task *t = tlTask) {
            {
                std::lock_guard lk(madeMu_);
                if (!made_.count(key))
                    return -1;
            }
            t->keys.push_back(key);
            return -static_cast<int>(t->keys.size()) - 1;
        }
        auto it = byKey_.find(key);
        return it == byKey_.end() ? -1 : it->second;
    }

    bool get(const std::string &base, ImageRGBA &img, PixelFormat *fmt) {
        auto rep = opt_.replace.find(base);
        if (rep != opt_.replace.end() && rep->second) {
            img = *rep->second;
            if (fmt)
                *fmt = PixelFormat::RGBA8;
            return true;
        }
        Texture t;
        std::string e;
        if (!loadTexture(gd_, base, t, &e)) {
            warn(e);
            return false;
        }
        int lv = t.firstLevel();
        if (lv > 0)
            warn(base + ": full-size mip missing, exported a smaller one");
        if (opt_.maxTextureSize > 0) // a smaller mip of the game's own chain instead of the full size
            while (lv + 1 < static_cast<int>(t.info.levels.size()) &&
                   std::max(t.info.levels[lv].width, t.info.levels[lv].height) > static_cast<uint32_t>(opt_.maxTextureSize))
                ++lv;
        if (!decodeLevel(t, lv, img.rgba, img.w, img.h, &e)) {
            warn(base + ": " + e);
            return false;
        }
        if (fmt)
            *fmt = t.info.format;
        return true;
    }

    int addImage(const std::string &key, const std::string &fileName, const ImageRGBA &img, bool extra = false) {
        if (Task *t = tlTask) { // (on a worker: the first to get to the key makes it; buildAll takes it in)
            std::shared_ptr<Made> m;
            {
                std::lock_guard lk(madeMu_);
                auto [it, fresh] = made_.try_emplace(key);
                if (fresh)
                    it->second = m = std::make_shared<Made>();
            }
            if (m) {
                m->fileName = fileName;
                m->file.extra = extra;
                for (size_t i = 3; i < img.rgba.size() && !m->file.cut; i += 4)
                    m->file.cut = img.rgba[i] < 128;
                std::string e;
                m->ok = encodePng(img.rgba.data(), img.w, img.h, m->file.png, &e);
                if (!m->ok)
                    warn(fileName + ": " + e);
            }
            t->keys.push_back(key);
            return -static_cast<int>(t->keys.size()) - 1;
        }
        auto it = byKey_.find(key);
        if (it != byKey_.end())
            return it->second;
        PngFile f;
        f.fileName = uniqueName(safeFileName(fileName));
        f.extra = extra;
        for (size_t i = 3; i < img.rgba.size() && !f.cut; i += 4)
            f.cut = img.rgba[i] < 128;
        std::string e;
        if (!encodePng(img.rgba.data(), img.w, img.h, f.png, &e)) {
            warn(fileName + ": " + e);
            return -1;
        }
        images.push_back(std::move(f));
        const int idx = static_cast<int>(images.size()) - 1;
        byKey_[key] = idx;
        return idx;
    }

    std::string uniqueName(const std::string &n) {
        // (told apart without case, as Windows does: a map's "decal_Crack" and "decal_crack" were one file)
        auto lower = [](std::string s) {
            for (char &c : s)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            return s;
        };
        std::string candidate = n;
        int k = 2;
        while (!names_.insert(lower(candidate)).second) {
            const size_t dot = n.rfind('.');
            candidate = n.substr(0, dot) + "_" + std::to_string(k++) + (dot == std::string::npos ? "" : n.substr(dot));
        }
        return candidate;
    }

    const GameData &gd_;
    const ExportOptions &opt_;
    std::vector<std::string> &warnings_;
    std::map<std::string, int> byKey_;
    std::set<std::string> names_, ddsDone_;
    std::mutex madeMu_;
    std::map<std::string, std::shared_ptr<Made>> made_; // (key -> its image, while buildAll / addOwn run)
};

struct GltfWriter {
    ujson::Value accessors = ujson::Value::array(), views = ujson::Value::array();
    std::vector<uint8_t> bin; // the buffer's bytes, but for those that stay where they are:
    struct Stay {
        size_t at; // (they go before bin[at])
        const uint8_t *p;
        size_t n;
    };
    std::vector<Stay> stays;
    size_t stayBytes = 0;

    size_t size() const { return bin.size() + stayBytes; }
    void pad() {
        while (size() % 4)
            bin.push_back(0);
    }
    // stay: the bytes go to the file from p, which must live until it is written (a .glb's images: copied
    // in, a big map's half a gigabyte of PNGs was copied again each time the buffer grew)
    int view(const void *p, size_t n, int target, bool stay = false) {
        pad();
        ujson::Value v = ujson::Value::object();
        v.set("buffer", 0);
        v.set("byteOffset", static_cast<double>(size()));
        v.set("byteLength", static_cast<double>(n));
        if (target)
            v.set("target", target);
        if (stay) {
            stays.push_back({bin.size(), static_cast<const uint8_t *>(p), n});
            stayBytes += n;
        } else {
            bin.insert(bin.end(), static_cast<const uint8_t *>(p), static_cast<const uint8_t *>(p) + n);
        }
        views.push(std::move(v));
        return static_cast<int>(views.size()) - 1;
    }
    // The buffer in order, as pieces to write.
    std::vector<std::pair<const void *, size_t>> pieces() const {
        std::vector<std::pair<const void *, size_t>> out;
        size_t from = 0;
        for (const Stay &s : stays) {
            if (s.at > from)
                out.push_back({bin.data() + from, s.at - from});
            out.push_back({s.p, s.n});
            from = s.at;
        }
        if (bin.size() > from)
            out.push_back({bin.data() + from, bin.size() - from});
        return out;
    }
    int accessor(int bufferView, int componentType, size_t count, const char *type, bool normalized = false,
                 const float *mn = nullptr, const float *mx = nullptr, int comps = 0) {
        ujson::Value a = ujson::Value::object();
        a.set("bufferView", bufferView);
        a.set("componentType", componentType);
        a.set("count", static_cast<double>(count));
        a.set("type", type);
        if (normalized)
            a.set("normalized", true);
        if (mn && mx) {
            ujson::Value lo = ujson::Value::array(), hi = ujson::Value::array();
            for (int i = 0; i < comps; ++i) {
                lo.push(static_cast<double>(mn[i]));
                hi.push(static_cast<double>(mx[i]));
            }
            a.set("min", std::move(lo));
            a.set("max", std::move(hi));
        }
        accessors.push(std::move(a));
        return static_cast<int>(accessors.size()) - 1;
    }
};

constexpr int kFloat = 5126, kUShort = 5123, kUInt = 5125, kUByte = 5121;
constexpr int kArrayBuffer = 34962, kElementBuffer = 34963;

ujson::Value matrixValue(const float m[16]) {
    ujson::Value a = ujson::Value::array();
    for (int i = 0; i < 16; ++i)
        a.push(static_cast<double>(std::abs(m[i]) < 1e-9f ? 0.0f : m[i]));
    return a;
}

bool isIdentityMatrix(const float m[16]) {
    for (int i = 0; i < 16; ++i)
        if (std::abs(m[i] - ((i % 5 == 0) ? 1.0f : 0.0f)) > 1e-6f)
            return false;
    return true;
}

} // namespace


namespace {

struct ScenePart {
    int lod = 0;
    uint32_t material = 0;
    size_t meshIndex = 0;
    MeshGeometry g;
};

struct SceneModel {
    ModelBundle b;
    std::vector<int> lods;
    std::vector<ScenePart> parts;
    Paint paint;              // its own paint (SceneItem::paint)
    bool hasPaint = false;
    float gain = 1;           // (instanced grass: its blades' albedo brightened)
    bool blades = false;      // (... and tinted per copy)
    bool mirrored = false;    // the mirror image (x -> -x) of the model, for parts placed mirrored
    std::map<uint32_t, int> gltfMaterial; // model material index -> scene material index
    std::map<int, int> gltfMesh;          // lod -> glTF mesh index
    std::map<int, int> gltfSkinnedMesh;   // lod -> glTF mesh of the parts that move with the skeleton (animated export)
};

// The mean linear colour of a texture read at these UVs (wrapped), from a mip of at most 256 pixels.
bool meanTexel(const GameData &gd, const ExportOptions &opt, const std::string &base, const std::vector<std::pair<float, float>> &uvs, float out[4]) {
    ImageRGBA img;
    if (auto rep = opt.replace.find(base); rep != opt.replace.end() && rep->second) {
        img = *rep->second;
    } else {
        Texture t;
        if (!loadTexture(gd, base, t, nullptr))
            return false;
        int lv = t.firstLevel();
        while (lv + 1 < static_cast<int>(t.info.levels.size()) && std::max(t.info.levels[lv].width, t.info.levels[lv].height) > 256)
            ++lv;
        if (!decodeLevel(t, lv, img.rgba, img.w, img.h, nullptr))
            return false;
    }
    if (!img.w || !img.h || uvs.empty())
        return false;
    double sum[4] = {};
    for (auto [u, v] : uvs) {
        u -= std::floor(u);
        v -= std::floor(v);
        const uint32_t x = std::min(img.w - 1, static_cast<uint32_t>(u * img.w)), y = std::min(img.h - 1, static_cast<uint32_t>(v * img.h));
        const uint8_t *p = &img.rgba[(static_cast<size_t>(y) * img.w + x) * 4];
        for (int c = 0; c < 3; ++c)
            sum[c] += linFromSrgb(p[c] / 255.0f);
        sum[3] += p[3] / 255.0;
    }
    for (int c = 0; c < 4; ++c)
        out[c] = static_cast<float>(sum[c] / uvs.size());
    return true;
}

// How a glow material's pieces are baked (GlowLook -> LampBake): the texture spread wider over them
// gives the colour; the other one is multiplied in texel by texel when both use the same UVs, or else
// as its mean over the pieces (a blink timeline at its start, a tint read at one point, plain white).
// The colour's UV set becomes uv0, the one glTF's TEXCOORD_0 and the OBJ's texture coordinates carry.
void prepareLamp(const GameData &gd, const ExportOptions &opt, SceneModel &sm, uint32_t k) {
    MaterialView &mv = sm.b.materials[k];
    const GlowLook &G = mv.glow;
    LampBake &L = mv.lamp;
    L = LampBake{};
    L.on = true;
    L.gain = G.gain;
    L.additive = G.additive;
    L.twoSided = G.twoSided;
    const bool swap = G.swap; // (d on uv1, c on uv0)
    auto byBase = [&](const std::string &base) -> const TextureRef * {
        for (const auto &t : mv.textures)
            if (t.exists && !base.empty() && t.base == base)
                return &t;
        return nullptr;
    };
    const TextureRef *d = byBase(G.d), *c = byBase(G.c);
    std::vector<ScenePart *> parts;
    for (auto &p : sm.parts)
        if (p.material == k && !p.g.uv0.empty())
            parts.push_back(&p);
    if (!d || parts.empty())
        return; // (no glow to show: the pieces export see-through)
    // (a mesh without a second set reads (0, 0) there, as the view does)
    auto uvAt = [](const MeshGeometry &g, int set, uint32_t v) {
        const std::vector<float> &uv = set ? g.uv1 : g.uv0;
        return uv.empty() ? std::pair<float, float>(0.0f, 0.0f) : std::pair<float, float>(uv[v * 2], uv[v * 2 + 1]);
    };
    float lo[2][2] = {{1e30f, 1e30f}, {1e30f, 1e30f}}, hi[2][2] = {{-1e30f, -1e30f}, {-1e30f, -1e30f}};
    bool same = true;
    for (const ScenePart *p : parts) {
        const MeshGeometry &g = p->g;
        same = same && g.uv1.size() == g.uv0.size();
        for (uint32_t v = 0; v < g.vertexCount; ++v)
            for (int s = 0; s < 2; ++s) {
                const auto [u, w] = uvAt(g, s, v);
                lo[s][0] = std::min(lo[s][0], u), lo[s][1] = std::min(lo[s][1], w);
                hi[s][0] = std::max(hi[s][0], u), hi[s][1] = std::max(hi[s][1], w);
            }
        for (size_t i = 0; same && i < g.uv0.size(); ++i)
            same = std::abs(g.uv0[i] - g.uv1[i]) < 1e-4f;
    }
    auto area = [&](int s) { return std::max(0.0f, hi[s][0] - lo[s][0]) * std::max(0.0f, hi[s][1] - lo[s][1]); };
    const int setD = swap ? 1 : 0, setC = 1 - setD;
    const bool colorIsC = c && !same && area(setC) > area(setD);
    const TextureRef *col = colorIsC ? c : d, *oth = colorIsC ? d : c;
    const int colSet = colorIsC ? setC : setD, othSet = 1 - colSet;
    L.color = col->base;
    L.uvSet = colSet;
    if (oth) {
        L.other = oth->base;
        if (same) {
            L.product = true;
        } else {
            std::vector<std::pair<float, float>> uvs;
            for (const ScenePart *p : parts)
                for (uint32_t v = 0; v < p->g.vertexCount; ++v)
                    uvs.push_back(uvAt(p->g, othSet, v));
            if (!meanTexel(gd, opt, oth->base, uvs, L.tint))
                std::fill(L.tint, L.tint + 4, 1.0f);
        }
    }
    if (colSet == 1)
        for (ScenePart *p : parts) {
            if (p->g.uv1.empty())
                p->g.uv1.assign(p->g.uv0.size(), 0.0f);
            std::swap(p->g.uv0, p->g.uv1);
        }
}

// ---- skeleton and animation (animated export) ----
float normalMatrix(const float m[16], float n[9]); // (below)

// Column-major 4x4 product c = a * b.
void mul4(const float a[16], const float b[16], float c[16]) {
    float r[16];
    for (int col = 0; col < 4; ++col)
        for (int row = 0; row < 4; ++row)
            r[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    std::memcpy(c, r, sizeof(r));
}
// Inverse of an affine column-major matrix (any invertible 3x3 + translation).
void invertAffine(const float m[16], float o[16]) {
    float n[9];
    normalMatrix(m, n); // n row-major = (M^-1)^T: its rows are the columns of M^-1
    float r[16] = {n[0], n[1], n[2], 0, n[3], n[4], n[5], 0, n[6], n[7], n[8], 0, 0, 0, 0, 1};
    for (int i = 0; i < 3; ++i)
        r[12 + i] = -(r[i] * m[12] + r[4 + i] * m[13] + r[8 + i] * m[14]);
    std::memcpy(o, r, sizeof(r));
}
// Translation, rotation (x y z w) and scale of an affine matrix without shear (a mirror goes into scale.x).
void decompose(const float m[16], float t[3], float q[4], float s[3]) {
    t[0] = m[12], t[1] = m[13], t[2] = m[14];
    for (int c = 0; c < 3; ++c)
        s[c] = std::sqrt(m[c * 4] * m[c * 4] + m[c * 4 + 1] * m[c * 4 + 1] + m[c * 4 + 2] * m[c * 4 + 2]);
    const float det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    if (det < 0)
        s[0] = -s[0];
    float r[9];
    for (int c = 0; c < 3; ++c)
        for (int k = 0; k < 3; ++k)
            r[c * 3 + k] = std::abs(s[c]) > 1e-12f ? m[c * 4 + k] / s[c] : (c == k ? 1.0f : 0.0f);
    // r is column-major: r[c*3+k] = R(k, c)
    const float m00 = r[0], m11 = r[4], m22 = r[8], tr = m00 + m11 + m22;
    if (tr > 0) {
        const float S = std::sqrt(tr + 1.0f) * 2;
        q[3] = 0.25f * S, q[0] = (r[5] - r[7]) / S, q[1] = (r[6] - r[2]) / S, q[2] = (r[1] - r[3]) / S;
    } else if (m00 > m11 && m00 > m22) {
        const float S = std::sqrt(1.0f + m00 - m11 - m22) * 2;
        q[3] = (r[5] - r[7]) / S, q[0] = 0.25f * S, q[1] = (r[3] + r[1]) / S, q[2] = (r[6] + r[2]) / S;
    } else if (m11 > m22) {
        const float S = std::sqrt(1.0f + m11 - m00 - m22) * 2;
        q[3] = (r[6] - r[2]) / S, q[0] = (r[3] + r[1]) / S, q[1] = 0.25f * S, q[2] = (r[7] + r[5]) / S;
    } else {
        const float S = std::sqrt(1.0f + m22 - m00 - m11) * 2;
        q[3] = (r[1] - r[3]) / S, q[0] = (r[6] + r[2]) / S, q[1] = (r[7] + r[5]) / S, q[2] = 0.25f * S;
    }
    const float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
    for (int i = 0; i < 4; ++i)
        q[i] /= l > 0 ? l : 1;
}
void quatMul(const float a[4], const float b[4], float o[4]) {
    const float x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
    const float y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
    const float z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
    const float w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
    o[0] = x, o[1] = y, o[2] = z, o[3] = w;
}
// The rest pose in glTF space: every node's world matrix and its local TRS (from the world
// matrices, as the viewer builds its skeleton).
struct RestPose {
    std::vector<std::array<float, 16>> world;
    std::vector<std::array<float, 3>> t, s;
    std::vector<std::array<float, 4>> q;
    std::vector<int> parent;
};
RestPose restPose(const Model &m) {
    RestPose rp;
    const size_t n = m.nodes.size();
    rp.world.resize(n), rp.t.resize(n), rp.s.resize(n), rp.q.resize(n), rp.parent.resize(n);
    for (size_t i = 0; i < n; ++i)
        toGltfMatrix(m.nodes[i].world, rp.world[i].data());
    for (size_t i = 0; i < n; ++i) {
        const int p = m.nodes[i].parent;
        rp.parent[i] = p >= 0 && static_cast<size_t>(p) < n && static_cast<size_t>(p) != i ? p : -1;
    }
    for (size_t i = 0; i < n; ++i) { // a damaged file must not make the node tree loop: cut the link
        int at = rp.parent[i];
        for (size_t steps = 0; at >= 0 && steps <= n; ++steps)
            at = static_cast<size_t>(at) == i ? (rp.parent[i] = -1, -1) : rp.parent[at];
    }
    for (size_t i = 0; i < n; ++i) {
        float local[16];
        if (rp.parent[i] >= 0) {
            float inv[16];
            invertAffine(rp.world[rp.parent[i]].data(), inv);
            mul4(inv, rp.world[i].data(), local);
        } else {
            std::memcpy(local, rp.world[i].data(), sizeof(local));
        }
        decompose(local, rp.t[i].data(), rp.q[i].data(), rp.s[i].data());
    }
    return rp;
}

std::string materialSignature(const MaterialView &m) {
    std::string s = m.blend ? "B|" : m.alphaTest ? "A|" : "O|";
    if (m.heat)
        s += "H|";
    if (m.color[0] != 1 || m.color[1] != 1 || m.color[2] != 1) {
        char t[48];
        std::snprintf(t, sizeof(t), "C%.3f,%.3f,%.3f|", m.color[0], m.color[1], m.color[2]);
        s += t;
    }
    if (m.lamp.on) { // (the same textures read another way are another glow)
        char t[96];
        std::snprintf(t, sizeof(t), "L%d,%d,%d,%d,%.3f,%.3f,%.3f,%.3f,%.3f|", m.lamp.additive ? 1 : 0, m.lamp.product ? 1 : 0, m.lamp.twoSided ? 1 : 0, m.lamp.uvSet,
                      m.lamp.tint[0], m.lamp.tint[1], m.lamp.tint[2], m.lamp.tint[3], m.lamp.gain);
        s += t + m.lamp.color + "|";
    }
    for (const auto &t : m.textures)
        if (t.exists)
            s += t.role + "=" + t.base + ";";
    for (const auto &L : m.layers) { // (the same textures blended another way)
        char t[128];
        std::snprintf(t, sizeof(t), "|L%d,%.4f,%d,%d,%.4f,%.4f,%.4f,%.4f", L.index, L.tiling, L.uv, L.invert ? 1 : 0, L.blend[0], L.blend[1], L.blend[2], L.blend[3]);
        s += t;
    }
    if (!m.layers.empty()) { // (what weighs the layers: extras.layerWeights; a baked blend's repeats of its second set per the first's)
        char t[48];
        std::snprintf(t, sizeof(t), "|W%d", m.weights);
        s += t;
        if (bakesLayers(m)) {
            std::snprintf(t, sizeof(t), "|R%.4f", m.layers[0].tiling / (m.uvScale > 0 ? m.uvScale : 1));
            s += t;
        }
    }
    if (m.emissiveGain != 1 || m.maskFromGloss) {
        char t[48];
        std::snprintf(t, sizeof(t), "|E%.4f,%d", m.emissiveGain, m.maskFromGloss ? 1 : 0);
        s += t;
    }
    return s;
}

// Column-major 4x4 (glTF) helpers.
void xformPoint(const float m[16], const float *p, float *o) {
    o[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    o[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    o[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
}
// Inverse-transpose of the upper 3x3 (for normals); returns the determinant of the 3x3.
float normalMatrix(const float m[16], float n[9]) {
    const float a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
    const float det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    const float inv = std::abs(det) > 1e-12f ? 1.0f / det : 0.0f;
    // cofactor matrix / det = inverse transpose (row-major n: n[r*3+c])
    n[0] = (e * i - f * h) * inv;
    n[1] = -(d * i - f * g) * inv;
    n[2] = (d * h - e * g) * inv;
    n[3] = -(b * i - c * h) * inv;
    n[4] = (a * i - c * g) * inv;
    n[5] = -(a * h - b * g) * inv;
    n[6] = (b * f - c * e) * inv;
    n[7] = -(a * f - c * d) * inv;
    n[8] = (a * e - b * d) * inv;
    return det;
}
void xformNormal(const float n9[9], const float *v, float *o) {
    // n9 holds the inverse-transpose with rows = rows of (M^-1)^T expressed against the input basis
    o[0] = n9[0] * v[0] + n9[1] * v[1] + n9[2] * v[2];
    o[1] = n9[3] * v[0] + n9[4] * v[1] + n9[5] * v[2];
    o[2] = n9[6] * v[0] + n9[7] * v[1] + n9[8] * v[2];
    const float l = std::sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]);
    if (l > 1e-12f) {
        o[0] /= l;
        o[1] /= l;
        o[2] /= l;
    }
}

// The pose the 3D Viewer showed (ExportOptions::pose): every node's world matrix, from its local
// translation, rotation and scale under its parent (the rest pose's links), and its skin matrix, which
// takes what is bound to the node at rest to where the pose puts it (world x rest world^-1). False
// when the pose does not fit the model (another node count, numbers that are not numbers).
bool shownPose(const RestPose &rp, const std::vector<std::array<float, 10>> &pose, std::vector<std::array<float, 16>> &world,
               std::vector<std::array<float, 16>> &skin) {
    const size_t n = rp.world.size();
    if (!n || pose.size() != n)
        return false;
    std::vector<std::array<float, 16>> local(n);
    for (size_t i = 0; i < n; ++i) {
        const auto &p = pose[i];
        for (float f : p)
            if (!std::isfinite(f))
                return false;
        float q[4] = {p[3], p[4], p[5], p[6]};
        const float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (l < 1e-6f)
            return false;
        for (float &c : q)
            c /= l;
        const float x = q[0], y = q[1], z = q[2], w = q[3];
        float *m = local[i].data(); // (as three.js composes a bone's matrix)
        m[0] = (1 - 2 * (y * y + z * z)) * p[7], m[1] = 2 * (x * y + w * z) * p[7], m[2] = 2 * (x * z - w * y) * p[7], m[3] = 0;
        m[4] = 2 * (x * y - w * z) * p[8], m[5] = (1 - 2 * (x * x + z * z)) * p[8], m[6] = 2 * (y * z + w * x) * p[8], m[7] = 0;
        m[8] = 2 * (x * z + w * y) * p[9], m[9] = 2 * (y * z - w * x) * p[9], m[10] = (1 - 2 * (x * x + y * y)) * p[9], m[11] = 0;
        m[12] = p[0], m[13] = p[1], m[14] = p[2], m[15] = 1;
    }
    world.assign(n, {});
    std::vector<char> done(n, 0);
    for (size_t left = n, pass = 0; left && pass <= n; ++pass) // parents before their children
        for (size_t i = 0; i < n; ++i) {
            const int pa = rp.parent[i];
            if (done[i] || (pa >= 0 && !done[pa]))
                continue;
            if (pa >= 0)
                mul4(world[pa].data(), local[i].data(), world[i].data());
            else
                world[i] = local[i];
            done[i] = 1;
            --left;
        }
    skin.assign(n, {});
    for (size_t i = 0; i < n; ++i) {
        float inv[16];
        invertAffine(rp.world[i].data(), inv);
        mul4(world[i].data(), inv, skin[i].data());
    }
    return true;
}

// Does the pose move anything (a skin matrix that is not the identity)?
bool poseMoves(const std::vector<std::array<float, 16>> &skin) {
    for (const auto &m : skin)
        for (int e = 0; e < 16; ++e)
            if (std::abs(m[e] - (e % 5 == 0 ? 1.0f : 0.0f)) > 1e-5f)
                return true;
    return false;
}

// A mesh in the pose the viewer showed: each vertex moved by its bones' skin matrices blended by
// weight (as the viewer skins it: only when every bone it uses is one of the model's nodes; a vertex
// on no bone goes with the first node, as in the animated export), or all of it by one node's for a
// rigid piece riding on that node (a wheel's tyre). Triangles the pose shrinks to nothing (bones
// scaled away: a mortar's spent shell, hidden flashes) are left out. False when nothing is left.
bool poseGeometry(MeshGeometry &g, int rigid, const std::vector<std::array<float, 16>> &skin) {
    const size_t nodes = skin.size(), nv = g.vertexCount;
    bool weighted = rigid < 0 && g.joints.size() >= nv * 4 && g.weights.size() >= nv * 4 && nv > 0;
    if (weighted) {
        int maxJoint = -1;
        for (size_t i = 0; i < nv * 4; ++i)
            if (g.weights[i] > 0)
                maxJoint = std::max<int>(maxJoint, g.joints[i]);
        weighted = maxJoint >= 0 && static_cast<size_t>(maxJoint) < nodes;
    }
    if (!weighted && (rigid < 0 || static_cast<size_t>(rigid) >= nodes))
        return true; // a static piece: it stays where it is
    const std::vector<float> rest = g.position;
    for (size_t v = 0; v < nv; ++v) {
        float m[16];
        if (weighted) {
            std::fill(m, m + 16, 0.0f);
            float sum = 0;
            for (int c = 0; c < 4; ++c) {
                const float w = g.weights[v * 4 + c];
                const size_t j = g.joints[v * 4 + c];
                if (!(w > 0) || j >= nodes)
                    continue;
                for (int e = 0; e < 16; ++e)
                    m[e] += w * skin[j][e];
                sum += w;
            }
            if (sum < 1e-6f)
                std::copy(skin[0].begin(), skin[0].end(), m);
            else if (std::abs(sum - 1) > 1e-4f)
                for (float &e : m)
                    e /= sum;
        } else {
            std::copy(skin[rigid].begin(), skin[rigid].end(), m);
        }
        float o[3];
        xformPoint(m, &g.position[v * 3], o);
        std::copy(o, o + 3, &g.position[v * 3]);
        if (g.normal.size() >= (v + 1) * 3) {
            float nm[9], nn[3];
            normalMatrix(m, nm);
            xformNormal(nm, &g.normal[v * 3], nn);
            if (nn[0] * nn[0] + nn[1] * nn[1] + nn[2] * nn[2] > 0.5f) // (a bone scaled to nothing: the normal stays)
                std::copy(nn, nn + 3, &g.normal[v * 3]);
        }
        if (g.tangent.size() >= (v + 1) * 4) {
            float *t = &g.tangent[v * 4];
            const float tx = m[0] * t[0] + m[4] * t[1] + m[8] * t[2], ty = m[1] * t[0] + m[5] * t[1] + m[9] * t[2],
                        tz = m[2] * t[0] + m[6] * t[1] + m[10] * t[2];
            const float l = std::sqrt(tx * tx + ty * ty + tz * tz);
            if (l > 1e-6f)
                t[0] = tx / l, t[1] = ty / l, t[2] = tz / l;
        }
    }
    auto area2 = [](const float *a, const float *b, const float *c) { // (twice the area, squared)
        const float u[3] = {b[0] - a[0], b[1] - a[1], b[2] - a[2]}, w[3] = {c[0] - a[0], c[1] - a[1], c[2] - a[2]};
        const float x = u[1] * w[2] - u[2] * w[1], y = u[2] * w[0] - u[0] * w[2], z = u[0] * w[1] - u[1] * w[0];
        return x * x + y * y + z * z;
    };
    std::vector<uint32_t> kept;
    kept.reserve(g.indices.size());
    for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
        const uint32_t a = g.indices[t], b = g.indices[t + 1], c = g.indices[t + 2];
        if (a >= nv || b >= nv || c >= nv)
            continue;
        const float before = area2(&rest[a * 3], &rest[b * 3], &rest[c * 3]), after = area2(&g.position[a * 3], &g.position[b * 3], &g.position[c * 3]);
        if (before > 0 && after < before * 1e-8f) // (less than 1/10,000 of its area left: a bone scaled below 1 %)
            continue;
        kept.insert(kept.end(), {a, b, c});
    }
    g.indices.swap(kept);
    return !g.indices.empty();
}

// Leaves out the vertices no triangle uses (after poseGeometry dropped some: importers such as
// Blender's would keep them as loose points).
void compactVertices(MeshGeometry &g) {
    const size_t nv = g.vertexCount;
    std::vector<char> used(nv, 0);
    for (uint32_t i : g.indices)
        if (i < nv)
            used[i] = 1;
    std::vector<uint32_t> remap(nv, 0);
    uint32_t next = 0;
    for (size_t v = 0; v < nv; ++v)
        if (used[v])
            remap[v] = next++;
    if (next == nv)
        return;
    for (uint32_t &i : g.indices)
        i = remap[i];
    auto squeeze = [&](auto &arr, size_t per) {
        if (arr.size() < nv * per) {
            arr.clear(); // (absent, or too short to belong to these vertices)
            return;
        }
        size_t o = 0;
        for (size_t v = 0; v < nv; ++v)
            if (used[v]) {
                for (size_t c = 0; c < per; ++c)
                    arr[o * per + c] = arr[v * per + c];
                ++o;
            }
        arr.resize(o * per);
    };
    squeeze(g.position, 3);
    squeeze(g.normal, 3);
    squeeze(g.tangent, 4);
    squeeze(g.uv0, 2);
    squeeze(g.uv1, 2);
    squeeze(g.uv2, 2);
    squeeze(g.color, 4);
    squeeze(g.joints, 4);
    squeeze(g.weights, 4);
    g.vertexCount = next;
}

// A mirror image of a mesh (x -> -x), built into the geometry so that the node placing it needs no
// negative scale (Blender edits such objects inside out; three.js-based viewers flip their normal
// maps). The tangent's handedness turns with it, and the triangles' winding.
void mirrorGeometry(MeshGeometry &g) {
    for (size_t i = 0; i < g.position.size(); i += 3)
        g.position[i] = -g.position[i];
    for (size_t i = 0; i < g.normal.size(); i += 3)
        g.normal[i] = -g.normal[i];
    for (size_t i = 0; i + 3 < g.tangent.size(); i += 4) {
        g.tangent[i] = -g.tangent[i];
        g.tangent[i + 3] = -g.tangent[i + 3];
    }
    for (size_t t = 0; t + 2 < g.indices.size(); t += 3)
        std::swap(g.indices[t + 1], g.indices[t + 2]);
}

float det3(const float m[16]) {
    return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

class UniqueNames {
  public:
    std::string get(const std::string &want) {
        std::string n = want.empty() ? "part" : want;
        if (used_.insert(n).second)
            return n;
        int &k = next_[n]; // (a map places thousands of the same tree: don't count up from 1 each time)
        for (;;) {
            char suf[16];
            std::snprintf(suf, sizeof(suf), ".%03d", ++k);
            if (used_.insert(n + suf).second)
                return n + suf;
        }
    }

  private:
    std::set<std::string> used_;
    std::map<std::string, int> next_;
};

// Every clip of the part's .model layers as a glTF animation: activities (FIRE, IDLE ...) over
// their own time, a pose layer's clip over the pose parameter's range, and a pose blend ("files")
// as one key per pose, a second apart. glTF wants each node's local TRS; the clips hold offsets
// from the rest pose, composed the way the viewer plays them: the translation added in the parent's
// frame (Maya's translate), the rotation after the rest rotation.
ujson::Value buildAnimations(const GameData &gd, const ModelBundle &b, const RestPose &rp, int firstJoint, GltfWriter &w, std::vector<std::string> &warnings) {
    ujson::Value anims = ujson::Value::array();
    UniqueNames names;
    const size_t n = rp.world.size();
    auto nodeOf = [&](const std::string &name, uint32_t bone) -> int {
        for (size_t i = 0; i < n; ++i)
            if (b.model.nodes[i].name == name)
                return static_cast<int>(i);
        return bone < n ? static_cast<int>(bone) : -1;
    };
    auto load = [&](const std::string &path, Animation &a) {
        std::vector<uint8_t> raw;
        std::string e;
        if (gd.read(path, raw, &e) && parseAnim(raw, a, &e))
            return true;
        warnings.push_back(path + ": " + e);
        return false;
    };
    for (const AnimLayer &l : b.desc.layers) {
        // node -> keys: times, offsets (translation x3 / rotation x4; empty when the clip has none)
        struct Keys {
            std::vector<float> times, t, r;
        };
        std::map<int, Keys> keys;
        if (!l.file.empty()) {
            Animation a;
            if (!load(l.file, a))
                continue;
            for (const auto &tr : a.tracks) {
                const int node = nodeOf(tr.node, tr.bone);
                if (node < 0 || tr.times.empty() || keys.count(node))
                    continue;
                keys[node] = {tr.times, tr.translation, tr.rotation};
            }
        } else if (l.files.size() > 1) {
            std::vector<Animation> poses(l.files.size());
            bool ok = true;
            for (size_t k = 0; k < poses.size() && ok; ++k)
                ok = load(l.files[k], poses[k]);
            if (!ok)
                continue;
            // every node any pose moves; a pose without a track for it (a wheel's -180° and 180°
            // poses are empty files) has it at rest
            for (const auto &pose : poses) {
                for (const auto &tr0 : pose.tracks) {
                    const int node = nodeOf(tr0.node, tr0.bone);
                    if (node < 0 || tr0.times.empty() || keys.count(node))
                        continue;
                    bool hasT = false, hasR = false;
                    for (const auto &other : poses)
                        for (const auto &t : other.tracks)
                            if (t.node == tr0.node && !t.times.empty())
                                hasT = hasT || !t.translation.empty(), hasR = hasR || !t.rotation.empty();
                    Keys k;
                    for (size_t p = 0; p < poses.size(); ++p) {
                        const AnimTrack *tr = nullptr;
                        for (const auto &t : poses[p].tracks)
                            if (t.node == tr0.node && !t.times.empty())
                                tr = &t;
                        k.times.push_back(static_cast<float>(p));
                        if (hasT)
                            for (int c = 0; c < 3; ++c)
                                k.t.push_back(tr && !tr->translation.empty() ? tr->translation[c] : 0.0f);
                        if (hasR)
                            for (int c = 0; c < 4; ++c)
                                k.r.push_back(tr && !tr->rotation.empty() ? tr->rotation[c] : (c == 3 ? 1.0f : 0.0f));
                    }
                    keys[node] = std::move(k);
                }
            }
        } else {
            continue;
        }
        ujson::Value channels = ujson::Value::array(), samplers = ujson::Value::array();
        auto addSampler = [&](const std::vector<float> &times, const std::vector<float> &values, int comps, const char *path, int node) {
            const float mn = times.front(), mx = times.back();
            ujson::Value s = ujson::Value::object();
            s.set("input", w.accessor(w.view(times.data(), times.size() * 4, 0), kFloat, times.size(), "SCALAR", false, &mn, &mx, 1));
            s.set("output", w.accessor(w.view(values.data(), values.size() * 4, 0), kFloat, values.size() / comps, comps == 3 ? "VEC3" : "VEC4"));
            s.set("interpolation", "LINEAR");
            samplers.push(std::move(s));
            ujson::Value target = ujson::Value::object(), c = ujson::Value::object();
            target.set("node", firstJoint + node);
            target.set("path", path);
            c.set("sampler", static_cast<double>(samplers.size() - 1));
            c.set("target", std::move(target));
            channels.push(std::move(c));
        };
        for (const auto &[node, k] : keys) {
            // keys in strictly increasing time (glTF requires it; equal times keep the first)
            std::vector<size_t> use;
            for (size_t i = 0; i < k.times.size(); ++i)
                if (use.empty() || k.times[i] > k.times[use.back()] + 1e-6f)
                    use.push_back(i);
            std::vector<float> times;
            for (size_t i : use)
                times.push_back(k.times[i]);
            const float *rt = rp.t[node].data(), *rq = rp.q[node].data();
            if (k.t.size() >= k.times.size() * 3) {
                std::vector<float> v;
                for (size_t i : use)
                    v.insert(v.end(), {rt[0] + k.t[i * 3], rt[1] + k.t[i * 3 + 1], rt[2] + k.t[i * 3 + 2]});
                addSampler(times, v, 3, "translation", node);
            }
            if (k.r.size() >= k.times.size() * 4) {
                std::vector<float> v;
                for (size_t i : use) {
                    float o[4];
                    quatMul(rq, &k.r[i * 4], o);
                    const float len = std::sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2] + o[3] * o[3]);
                    for (float &x : o)
                        x /= len > 0 ? len : 1;
                    if (v.size() >= 4 && o[0] * v[v.size() - 4] + o[1] * v[v.size() - 3] + o[2] * v[v.size() - 2] + o[3] * v[v.size() - 1] < 0)
                        for (float &x : o) // the same rotation, on the side the last key was on (no long way round)
                            x = -x;
                    v.insert(v.end(), o, o + 4);
                }
                addSampler(times, v, 4, "rotation", node);
            }
        }
        if (!channels.size())
            continue;
        ujson::Value a = ujson::Value::object(), ex = ujson::Value::object();
        a.set("name", names.get(l.name.empty() ? std::string("animation") : l.name));
        a.set("channels", std::move(channels));
        a.set("samplers", std::move(samplers));
        if (!l.activity.empty())
            ex.set("activity", l.activity);
        if (!l.poseParameter.empty()) { // the clip runs from min to max as declared (often high to low: AimPitch 60 -29)
            ex.set("poseParameter", l.poseParameter);
            ex.set("min", asWritten(l.poseMin));
            ex.set("max", asWritten(l.poseMax));
        }
        if (l.speed != 1)
            ex.set("speed", static_cast<double>(l.speed));
        a.set("extras", std::move(ex));
        anims.push(std::move(a));
    }
    return anims;
}

} // namespace

namespace {

// OBJ text in a std::string, numbers as a fixed 6-decimal stream writes them.
struct ObjText {
    std::string text;
    ObjText &operator<<(const char *v) { return text += v, *this; }
    ObjText &operator<<(const std::string &v) { return text += v, *this; }
    ObjText &operator<<(char v) { return text += v, *this; }
    ObjText &operator<<(float v) { return real(v); }
    ObjText &operator<<(double v) { return real(v); }
    ObjText &operator<<(size_t v) { return whole(v); }
    ObjText &operator<<(uint32_t v) { return whole(v); }
    ObjText &operator<<(int v) { return whole(v); }

  private:
    template <class T> ObjText &whole(T v) {
        char b[24];
        const auto r = std::to_chars(b, b + sizeof(b), v);
        text.append(b, r.ptr);
        return *this;
    }
    template <class T> ObjText &real(T v) {
        char b[64];
        const auto r = std::to_chars(b, b + sizeof(b), v, std::chars_format::fixed, 6);
        if (r.ec == std::errc())
            text.append(b, r.ptr);
        else
            text += '0'; // (beyond any coordinate a model has)
        return *this;
    }
};

} // namespace

bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::string &sceneName, const std::filesystem::path &outFile,
                 const ExportOptions &opt, std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress) {
    return exportScene(gd, items, {}, sceneName, outFile, opt, written, warnings, err, progress);
}

bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::vector<CustomMesh> &custom, const std::string &sceneName,
                 const std::filesystem::path &outFile, const ExportOptions &opt, std::vector<std::filesystem::path> &written,
                 std::vector<std::string> &warnings, std::string *err, const Progress &progress) {
    return exportScene(gd, items, custom, SceneExtras{}, sceneName, outFile, opt, written, warnings, err, progress);
}

bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::vector<CustomMesh> &custom, const SceneExtras &extras,
                 const std::string &sceneName, const std::filesystem::path &outFile, const ExportOptions &opt,
                 std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress) {
    auto report = [&](double f, const std::string &s) {
        if (progress)
            progress(f, s);
    };
    auto fail = [&](const std::string &m) {
        if (err)
            *err = m;
        return false;
    };
    const bool objFormat = opt.format == ExportOptions::Format::OBJ;
    static const std::vector<InstancedItem> kNoCopies;
    const std::vector<InstancedItem> &instanced = objFormat ? kNoCopies : extras.instanced;
    if (objFormat && !extras.instanced.empty())
        warnings.push_back("grass is left out: OBJ cannot place copies of a mesh (GLB and glTF can)");
    if (objFormat && !extras.lights.empty())
        warnings.push_back("the sun is left out: OBJ has no lights (GLB and glTF have)");
    if (items.empty() && custom.empty() && instanced.empty())
        return fail("nothing to export");
    const bool single = items.size() == 1 && custom.empty() && instanced.empty() && isIdentityMatrix(items[0].matrix);
    const bool animatedExport = single && opt.animations && !objFormat;
    // Where each part goes. A mirrored one (negative scale) gets the mirror image of its model and,
    // in place of its own matrix, that matrix times the mirror (x -> -x), which turns it back.
    std::vector<std::array<float, 16>> itemMatrix(items.size());
    std::vector<char> itemMirrored(items.size(), 0);
    for (size_t k = 0; k < items.size(); ++k) {
        std::copy(items[k].matrix, items[k].matrix + 16, itemMatrix[k].begin());
        if (det3(items[k].matrix) < 0) {
            itemMirrored[k] = 1;
            for (int r = 0; r < 3; ++r)
                itemMatrix[k][r] = -itemMatrix[k][r];
        }
    }
    // the pose the viewer showed (one part), as world matrices of the model's nodes
    std::vector<std::array<float, 16>> shownWorld;

    // ---- models (each path + skin + LOD once) ----
    report(0.02, "Reading the models");
    std::map<std::string, SceneModel> models;
    std::vector<SceneModel *> itemModel(items.size(), nullptr), instancedModel(instanced.size(), nullptr);
    // (one part: the models shown on its nodes load with it)
    static const std::vector<Attachment> kNoAttachments;
    const std::vector<Attachment> &attach = single ? opt.attachments : kNoAttachments;
    std::vector<SceneModel *> attachModel(attach.size(), nullptr);
    const size_t loads = items.size() + instanced.size() + attach.size();
    // What placement k (the items, then the copies, then what is shown on the part) needs: its model's
    // key and how to read it. One model is read for every distinct key.
    struct Want {
        SceneItem it;
        const InstancedItem *ii = nullptr;
        const Attachment *at = nullptr;
        const std::vector<std::array<float, 10>> *pose = nullptr;
        bool att = false, inst = false, mirror = false, mainPart = false, skip = false;
        int lod = 0;
        std::string key;
    };
    std::vector<Want> want(loads);
    for (size_t k = 0; k < loads; ++k) {
        Want &w = want[k];
        const bool att = k >= items.size() + instanced.size();
        const bool inst = !att && k >= items.size();
        const InstancedItem *ii = inst ? &instanced[k - items.size()] : nullptr;
        const Attachment *at = att ? &attach[k - items.size() - instanced.size()] : nullptr;
        w.it = att ? SceneItem{at->path, at->skin} : inst ? SceneItem{ii->path, ii->skin, ii->name, ii->group, ii->lod} : items[k];
        const SceneItem &it = w.it;
        w.ii = ii, w.at = at, w.att = att, w.inst = inst;
        if (inst && ii->trs.size() < 8) {
            w.skip = true;
            continue;
        }
        const bool mainPart = single && !att; // (what is shown on it is no reason to fail the export)
        const int itemLod = it.lod >= 0 ? it.lod : opt.lod;
        const bool mirror = !inst && !att && itemMirrored[k];
        // the pose its meshes are baked in: one part's is the viewer's (opt.pose), a build's parts have their own
        const std::vector<std::array<float, 10>> &itemPose = att ? at->pose : single && !opt.pose.empty() ? opt.pose : it.pose;
        w.mainPart = mainPart, w.lod = itemLod, w.mirror = mirror, w.pose = &itemPose;
        std::string key = normalizeGamePath(it.path) + "|" + (it.skin.empty() ? std::string("default") : it.skin) + "|" + std::to_string(itemLod);
        if (inst) // (copies with their own normals / look are models of their own)
            key += "|i" + std::to_string(ii->grass) + "|" + std::to_string(std::lround(ii->gain * 100));
        if (mirror)
            key += "|mirror";
        if (!inst && !att && it.hasPaint) // (a painted part: its materials and images are its paint's)
            key += "|paint=" + it.paint.key();
        if (!itemPose.empty()) { // (parts in the same pose share their meshes)
            uint64_t h = 1469598103934665603ull;
            for (const auto &bone : itemPose)
                for (float f : bone) {
                    uint32_t u;
                    std::memcpy(&u, &f, 4);
                    for (int b = 0; b < 4; ++b)
                        h = (h ^ ((u >> (8 * b)) & 0xFF)) * 1099511628211ull;
                }
            char hex[24];
            std::snprintf(hex, sizeof(hex), "|pose%016llx", static_cast<unsigned long long>(h));
            key += hex;
        }
        w.key = std::move(key);
    }
    // One model (w: the first placement that wants it): read and turned into the export's meshes.
    // warns: what to say about it; fatal: why the export fails (one part's own model); shown: the
    // pose's world matrices for one part. false: it is left out.
    auto readModel = [&](const Want &w, SceneModel &sm, std::vector<std::string> &warns, std::string &fatal, std::vector<std::array<float, 16>> *shown) -> bool {
        const SceneItem &it = w.it;
        const InstancedItem *ii = w.ii;
        const bool att = w.att, inst = w.inst, mainPart = w.mainPart, mirror = w.mirror;
        const int itemLod = w.lod;
        const std::vector<std::array<float, 10>> &itemPose = *w.pose;
        auto fail = [&](const std::string &m) {
            fatal = m;
            return false;
        };
        std::vector<std::string> &warnings = warns;
        {
            std::string e;
            if (!loadBundle(gd, it.path, it.skin, sm.b, &e)) {
                if (mainPart)
                    return fail(e);
                warnings.push_back(att ? it.path + " (shown on it) is left out: " + e : e);
                return false;
            }
            sm.mirrored = mirror;
            sm.hasPaint = !inst && !att && it.hasPaint;
            sm.paint = it.paint;
            for (const auto &w2 : sm.b.warnings)
                warnings.push_back(mainPart ? w2 : sm.b.baseName + ": " + w2);
            // In the pose the 3D Viewer or the builder showed, when it moves anything. (One part with
            // animations: the skeleton starts in it instead; see below.)
            std::vector<std::array<float, 16>> poseSkin;
            if (!itemPose.empty()) {
                std::vector<std::array<float, 16>> world;
                if (!shownPose(restPose(sm.b.model), itemPose, world, poseSkin))
                    warnings.push_back(mainPart ? "the pose shown did not fit the model: exported at rest" : sm.b.baseName + ": its pose did not fit the model: exported at rest");
                else if (!poseMoves(poseSkin))
                    poseSkin.clear();
                else if (mainPart && shown)
                    *shown = std::move(world);
                if (animatedExport && mainPart && sm.b.model.nodes.size() > 1) // (one node: no skeleton is written, so the pose is baked in)
                    poseSkin.clear();
            }
            if (itemLod < 0) {
                for (int l = 0; l < sm.b.model.lodCount; ++l)
                    sm.lods.push_back(l);
            } else {
                sm.lods.push_back(std::clamp(itemLod, 0, sm.b.model.lodCount - 1));
            }
            for (size_t m = 0; m < sm.b.model.meshes.size(); ++m) {
                const MeshInfo &me = sm.b.model.meshes[m];
                if (std::find(sm.lods.begin(), sm.lods.end(), me.lod) == sm.lods.end())
                    continue;
                if (me.material < sm.b.materials.size() && sm.b.materials[me.material].invisible)
                    continue; // hidden in this skin
                if (!single && me.material < sm.b.materials.size() && sm.b.materials[me.material].billboard)
                    continue; // a tree's far picture (crossed planes through it): a scene has the tree itself
                ScenePart p;
                p.lod = me.lod;
                p.material = me.material;
                p.meshIndex = m;
                if (!decodeMesh(sm.b.model, me, p.g, &e)) {
                    if (mainPart)
                        return fail(sm.b.baseName + ": " + e);
                    warnings.push_back(sm.b.baseName + ": " + e + " (mesh skipped)");
                    continue;
                }
                p.g.indices.resize(p.g.indices.size() / 3 * 3); // (whole triangles only)
                if (!p.g.vertexCount || p.g.indices.empty())
                    continue; // an empty piece (glTF has no empty accessors)
                if (!poseSkin.empty()) {
                    const int rigid = me.words[5] == 0 && me.words[6] > 0 && me.words[6] < sm.b.model.nodes.size() ? static_cast<int>(me.words[6]) : -1;
                    if (!poseGeometry(p.g, p.g.joints.empty() ? rigid : -1, poseSkin))
                        continue; // all of it shrunk away in this pose
                    compactVertices(p.g);
                }
                if (mirror)
                    mirrorGeometry(p.g);
                applyMaterialToMesh(me.material < sm.b.materials.size() ? &sm.b.materials[me.material] : nullptr, p.g);
                if (inst && ii->grass && p.g.tangent.empty()) {
                    // A blade's normals point up (lit like the ground, as the view does). Each triangle a
                    // second time, wound the other way, keeps them on its back too (a double-sided
                    // material would turn them down there).
                    const size_t n = p.g.indices.size();
                    p.g.indices.reserve(n * 2);
                    for (size_t t = 0; t + 2 < n; t += 3)
                        p.g.indices.insert(p.g.indices.end(), {p.g.indices[t], p.g.indices[t + 2], p.g.indices[t + 1]});
                    sm.blades = true;
                    sm.gain = ii->gain;
                }
                sm.parts.push_back(std::move(p));
            }
            if (sm.parts.empty()) {
                if (mainPart)
                    return fail("the model has no geometry for that LOD");
                warnings.push_back(sm.b.baseName + ": no visible geometry, skipped");
            }
        }
        return true;
    };
    // the distinct models, in the order placements first want them: read side by side (one part: one
    // by one, its own model's errors fail the export), then taken in in that order
    std::vector<size_t> firstWant;
    {
        std::set<std::string> seen;
        for (size_t k = 0; k < loads; ++k)
            if (!want[k].skip && seen.insert(want[k].key).second)
                firstWant.push_back(k);
    }
    std::vector<SceneModel> read(firstWant.size());
    std::vector<std::vector<std::string>> readWarns(firstWant.size());
    std::vector<std::string> readFatal(firstWant.size());
    std::vector<char> readOk(firstWant.size(), 0);
    size_t readDone = 0;
    std::mutex readMu;
    parallelFor(firstWant.size(), [&](size_t j) {
        readOk[j] = readModel(want[firstWant[j]], read[j], readWarns[j], readFatal[j], single ? &shownWorld : nullptr);
        std::lock_guard lk(readMu);
        ++readDone;
        if (readDone % 16 == 0 || readDone == firstWant.size())
            report(0.02 + 0.08 * readDone / firstWant.size(), "Reading the models (" + std::to_string(readDone) + "/" + std::to_string(firstWant.size()) + ")");
    }, single ? 1 : workersForMemory(512));
    for (size_t j = 0; j < firstWant.size(); ++j) {
        if (!readFatal[j].empty())
            return fail(readFatal[j]);
        for (std::string &w : readWarns[j])
            warnings.push_back(std::move(w));
        if (readOk[j]) // (one left out is said once, however often the map places it)
            models.emplace(want[firstWant[j]].key, std::move(read[j]));
    }
    for (size_t k = 0; k < loads; ++k) {
        if (want[k].skip)
            continue;
        auto found = models.find(want[k].key);
        if (found == models.end())
            continue;
        if (want[k].att)
            attachModel[k - items.size() - instanced.size()] = &found->second;
        else
            (want[k].inst ? instancedModel[k - items.size()] : itemModel[k]) = &found->second;
    }
    if (custom.empty() && std::none_of(models.begin(), models.end(), [](const auto &m) { return !m.second.parts.empty(); }))
        return fail(warnings.empty() ? std::string("nothing visible to export") : "nothing visible to export: " + warnings.front());
    // What is shown on the part's nodes stands where its node is: in the pose shown, else at rest.
    std::vector<std::array<float, 16>> attachMatrix(attach.size());
    for (size_t i = 0; i < attach.size(); ++i) {
        const Model *mm = itemModel.empty() || !itemModel[0] ? nullptr : &itemModel[0]->b.model;
        const int n = attach[i].node;
        if (!mm || n < 0 || static_cast<size_t>(n) >= mm->nodes.size())
            attachModel[i] = nullptr; // (no such node: left out)
        else if (shownWorld.size() == mm->nodes.size())
            attachMatrix[i] = shownWorld[n];
        else
            toGltfMatrix(mm->nodes[n].world, attachMatrix[i].data());
    }
    auto attachOn = [&](size_t i) -> std::string { // the name of the node it is shown on
        const Model &mm = itemModel[0]->b.model;
        const int n = attach[i].node;
        return n >= 0 && static_cast<size_t>(n) < mm.nodes.size() && !mm.nodes[n].name.empty() ? mm.nodes[n].name : "node" + std::to_string(n);
    };
    auto attachName = [&](size_t i) { return attachModel[i]->b.baseName + "_" + attachOn(i); };
    const bool anyAttached = std::any_of(attachModel.begin(), attachModel.end(), [](const SceneModel *m) { return m && !m->parts.empty(); });
    // lamp-shader glow pieces: how each is baked (before the materials are told apart by their look)
    for (auto &[key, sm] : models)
        for (size_t k = 0; k < sm.b.materials.size(); ++k)
            if (sm.b.materials[k].glow.on)
                prepareLamp(gd, opt, sm, static_cast<uint32_t>(k));

    // ---- materials (same texture set = same material, across all parts) ----
    std::vector<const MaterialView *> matViews;
    std::vector<const SceneModel *> matModel; // (whose look: brightened grass; whose paint)
    std::vector<uint32_t> matIndex;           // (its index in that model)
    std::vector<std::string> matKey;          // (that model's key)
    std::map<std::string, int> matBySig;
    for (auto &[key, sm] : models) {
        for (const auto &p : sm.parts) {
            if (sm.gltfMaterial.count(p.material))
                continue;
            const MaterialView *mv = p.material < sm.b.materials.size() ? &sm.b.materials[p.material] : nullptr;
            std::string sig = mv ? materialSignature(*mv) : std::string("none");
            if (std::abs(sm.gain - 1) > 1e-3f)
                sig += "|look=" + std::to_string(std::lround(sm.gain * 100));
            if (sm.hasPaint && mv && paintable(*mv)) // (painted: another look; through its own pieces, its own)
                sig += "|paint=" + sm.paint.key() + (sm.paint.usesUvs() ? "|geo=" + key : std::string());
            auto f = matBySig.find(sig);
            int gi;
            if (f == matBySig.end()) {
                gi = static_cast<int>(matViews.size());
                matViews.push_back(mv);
                matModel.push_back(&sm);
                matIndex.push_back(p.material);
                matKey.push_back(key);
                matBySig[sig] = gi;
            } else {
                gi = f->second;
            }
            sm.gltfMaterial[p.material] = gi;
        }
    }
    const std::filesystem::path dir = outFile.parent_path();
    // .bin / .mtl and the texture folder: plain ASCII names that every importer can resolve.
    // Textures go in their own folder so two exports in one folder never overwrite each other's.
    const std::string stem = companionStem(outFile);
    const std::string texFolder = stem + "_textures";
    const std::filesystem::path texDir = dir / texFolder;
    // the models' own paints on their materials (a pattern goes through the pieces of its material in the
    // model's finest LOD exported: the others share their textures)
    std::vector<PaintJob> paintJobs(matViews.size());
    std::vector<const PaintJob *> jobs(matViews.size(), nullptr);
    for (size_t i = 0; i < matViews.size(); ++i) {
        const SceneModel &sm = *matModel[i];
        if (!sm.hasPaint || !matViews[i] || !paintable(*matViews[i]))
            continue;
        PaintJob &j = paintJobs[i];
        j.paint = sm.paint;
        j.geoKey = matKey[i];
        if (j.paint.usesUvs()) {
            int lod = INT32_MAX;
            for (const auto &p : sm.parts)
                if (p.material == matIndex[i])
                    lod = std::min(lod, p.lod);
            for (const auto &p : sm.parts)
                if (p.material == matIndex[i] && p.lod == lod)
                    j.meshes.push_back(&p.g);
        }
        jobs[i] = &j;
    }
    TextureWork tw(gd, opt, warnings);
    std::vector<MaterialImages> matImages(matViews.size());
    if (opt.textures) { // (on several cores at once: TextureWork::buildAll)
        std::vector<float> gains(matViews.size());
        for (size_t i = 0; i < matViews.size(); ++i)
            gains[i] = matModel[i]->gain;
        const std::string of = "/" + std::to_string(matViews.size()) + ")";
        report(0.1, "Converting textures (0" + of);
        matImages = tw.buildAll(matViews, gains, jobs, [&](size_t done) {
            report(0.1 + 0.6 * done / std::max<size_t>(1, matViews.size()), "Converting textures (" + std::to_string(done) + of);
        });
    }
    std::vector<std::pair<std::filesystem::path, std::vector<uint8_t>>> ddsFiles;
    if (opt.ddsCopies)
        for (const MaterialView *mv : matViews)
            if (mv)
                tw.ddsCopies(*mv, texDir, ddsFiles);
    UniqueNames matNames;
    std::vector<std::string> materialName(matViews.size());
    for (size_t i = 0; i < matViews.size(); ++i) {
        const TextureRef *alb = matViews[i] ? matViews[i]->texture("albedo") : nullptr;
        if (matViews[i] && matViews[i]->lamp.on && !matViews[i]->lamp.color.empty())
            materialName[i] = matNames.get(baseLeaf(matViews[i]->lamp.color) + "_glow");
        else
            materialName[i] = matNames.get(alb ? baseLeaf(alb->base) + (jobs[i] && jobs[i]->paint.on() ? "_" + jobs[i]->paint.fileTag() : std::string()) : "material" + std::to_string(i));
    }
    // The exporter's own meshes (terrain, water): one material per material name and look. (Every
    // water body of a map is called "water" but has its own colour: by the name alone they all took
    // the first one's.)
    struct CustomMaterial {
        const CustomMesh *first = nullptr;
        int albedo = -1, normal = -1, metalRough = -1; // indices into tw.images
        std::string name;
    };
    std::vector<CustomMaterial> customMats;
    std::vector<int> customMatOf(custom.size());
    std::vector<TextureWork::Own> own; // (their images: encoded side by side once all are known)
    std::vector<std::pair<size_t, int>> ownAt; // (customMats index, 0 albedo / 1 normal / 2 metalRough)
    {
        std::map<std::string, int> byLook;
        for (size_t i = 0; i < custom.size(); ++i) {
            const CustomMesh &c = custom[i];
            std::string look = c.material + '|';
            for (float f : c.color)
                look += std::to_string(std::lround(f * 1e4)) + ',';
            look += std::to_string(std::lround(c.roughness * 1e4)) + ',' + std::to_string(std::lround(c.metallic * 1e4)) + ',' + (c.blend ? 'b' : '-') +
                    (c.doubleSided ? 'd' : '-') + '|' + std::to_string(reinterpret_cast<uintptr_t>(c.albedo.get())) + '|' +
                    std::to_string(reinterpret_cast<uintptr_t>(c.normal.get())) + ',' + std::to_string(std::lround(c.normalScale * 1e4)) + '|' +
                    std::to_string(reinterpret_cast<uintptr_t>(c.metalRough.get()));
            for (float f : {c.transmission, c.ior, c.thickness, c.attenuationDistance, c.attenuationColor[0], c.attenuationColor[1], c.attenuationColor[2]})
                look += ',' + std::to_string(std::lround(f * 1e4));
            auto f = byLook.find(look);
            if (f == byLook.end()) {
                CustomMaterial cm;
                cm.first = &custom[i];
                cm.name = matNames.get(custom[i].material.empty() ? custom[i].name : custom[i].material);
                const size_t at = customMats.size();
                if (opt.textures && custom[i].albedo && custom[i].albedo->w && custom[i].albedo->h) { // (one file per image, however many materials use it)
                    own.push_back({"own:" + std::to_string(reinterpret_cast<uintptr_t>(custom[i].albedo.get())),
                                   custom[i].albedoName.empty() ? cm.name + ".png" : custom[i].albedoName, custom[i].albedo.get()});
                    ownAt.push_back({at, 0});
                }
                if (opt.textures && custom[i].normal && custom[i].normal->w && custom[i].normal->h) {
                    own.push_back({"own:" + std::to_string(reinterpret_cast<uintptr_t>(custom[i].normal.get())),
                                   custom[i].normalName.empty() ? cm.name + "_n.png" : custom[i].normalName, custom[i].normal.get()});
                    ownAt.push_back({at, 1});
                }
                if (opt.textures && !objFormat && custom[i].metalRough && custom[i].metalRough->w && custom[i].metalRough->h) {
                    own.push_back({"own:" + std::to_string(reinterpret_cast<uintptr_t>(custom[i].metalRough.get())),
                                   custom[i].metalRoughName.empty() ? cm.name + "_orm.png" : custom[i].metalRoughName, custom[i].metalRough.get()});
                    ownAt.push_back({at, 2});
                }
                f = byLook.emplace(look, static_cast<int>(customMats.size())).first;
                customMats.push_back(std::move(cm));
            }
            customMatOf[i] = f->second;
        }
    }
    {
        const std::vector<int> idx = tw.addOwn(own);
        for (size_t k = 0; k < own.size(); ++k) {
            CustomMaterial &cm = customMats[ownAt[k].first];
            (ownAt[k].second == 0 ? cm.albedo : ownAt[k].second == 1 ? cm.normal : cm.metalRough) = idx[k];
        }
    }

    report(0.75, "Writing the file");
    // Everything goes to disk in one step at the end: all of the files, or none of them.
    std::vector<FileOut> files;
    auto writeAll = [&]() {
        for (const auto &d : ddsFiles)
            files.push_back({d.first, d.second.data(), d.second.size()});
        for (const auto &f : extras.files)
            files.push_back({f.first, f.second.data(), f.second.size()});
        if (!writeFilesTogether(files, err))
            return false;
        for (const auto &f : files)
            written.push_back(f.path);
        report(1, "Done");
        return true;
    };
    if (objFormat) {
      try {
        ObjText obj; // (a whole map can pass 2 GB of text: more than MSVC's string streams hold)
        std::ostringstream mtl;
        obj << "# Exported by Grimcold";
        if (single) {
            obj << " from " << itemModel[0]->b.mdlPath << " (skin " << itemModel[0]->b.skin << ")";
        } else {
            std::string oneLine = sceneName;
            std::replace_if(oneLine.begin(), oneLine.end(), [](char c) { return c == '\r' || c == '\n'; }, ' ');
            obj << ": " << oneLine << " (" << items.size() << " parts)";
        }
        obj << "\n";
        for (size_t i = 0; i < attach.size(); ++i)
            if (attachModel[i]) {
                std::string with = attachModel[i]->b.mdlPath + " on " + attachOn(i);
                std::replace_if(with.begin(), with.end(), [](char c) { return c == '\r' || c == '\n'; }, ' ');
                obj << "# with " << with << "\n";
            }
        obj << "mtllib " << stem << ".mtl\n";
        size_t base = 1;
        UniqueNames objNames;
        // one model's meshes at `matrix`, each an object named after `name` (then its LOD and mesh number)
        auto writeModel = [&](const SceneModel *sm, const float *matrix, std::string name) {
            float nm[9];
            const float det = normalMatrix(matrix, nm);
            const bool flip = det < 0;
            for (char &c : name) // one word per name: some importers stop at a space, a line break would end it
                if (static_cast<unsigned char>(c) <= ' ' || c == '#')
                    c = '_';
            for (const auto &p : sm->parts) {
                const auto &g = p.g;
                std::string oname = name;
                if (sm->lods.size() > 1 || p.lod > 0)
                    oname += "_LOD" + std::to_string(p.lod);
                obj << "o " << objNames.get(oname + "_mesh" + std::to_string(p.meshIndex)) << "\n";
                for (uint32_t v = 0; v < g.vertexCount; ++v) {
                    float o[3];
                    xformPoint(matrix, &g.position[v * 3], o);
                    obj << "v " << o[0] << ' ' << o[1] << ' ' << o[2] << "\n";
                }
                for (uint32_t v = 0; v < g.vertexCount; ++v)
                    obj << "vt " << (g.uv0.empty() ? 0.0f : g.uv0[v * 2]) << ' ' << (g.uv0.empty() ? 0.0f : 1.0f - g.uv0[v * 2 + 1]) << "\n";
                for (uint32_t v = 0; v < g.vertexCount; ++v) {
                    float o[3] = {0, 1, 0};
                    if (!g.normal.empty())
                        xformNormal(nm, &g.normal[v * 3], o);
                    obj << "vn " << o[0] << ' ' << o[1] << ' ' << o[2] << "\n";
                }
                auto mit = sm->gltfMaterial.find(p.material);
                if (mit != sm->gltfMaterial.end())
                    obj << "usemtl " << materialName[mit->second] << "\n";
                for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
                    obj << 'f';
                    for (int c = 0; c < 3; ++c) {
                        const size_t i = base + g.indices[t + (flip ? 2 - c : c)];
                        obj << ' ' << i << '/' << i << '/' << i;
                    }
                    obj << "\n";
                }
                base += g.vertexCount;
            }
        };
        for (size_t k = 0; k < items.size(); ++k)
            if (const SceneModel *sm = itemModel[k])
                writeModel(sm, itemMatrix[k].data(), items[k].name.empty() ? (single && !opt.name.empty() ? opt.name : sm->b.baseName) : items[k].name);
        for (size_t i = 0; i < attach.size(); ++i)
            if (attachModel[i])
                writeModel(attachModel[i], attachMatrix[i].data(), attachName(i));
        for (size_t k = 0; k < custom.size(); ++k) {
            const MeshGeometry &g = custom[k].g;
            obj << "o " << objNames.get(safeFileName(custom[k].name)) << "\n";
            for (uint32_t v = 0; v < g.vertexCount; ++v)
                obj << "v " << g.position[v * 3] << ' ' << g.position[v * 3 + 1] << ' ' << g.position[v * 3 + 2] << "\n";
            for (uint32_t v = 0; v < g.vertexCount; ++v)
                obj << "vt " << (g.uv0.empty() ? 0.0f : g.uv0[v * 2]) << ' ' << (g.uv0.empty() ? 0.0f : 1.0f - g.uv0[v * 2 + 1]) << "\n";
            for (uint32_t v = 0; v < g.vertexCount; ++v) {
                const float *n = g.normal.empty() ? nullptr : &g.normal[v * 3];
                obj << "vn " << (n ? n[0] : 0.0f) << ' ' << (n ? n[1] : 1.0f) << ' ' << (n ? n[2] : 0.0f) << "\n";
            }
            obj << "usemtl " << customMats[customMatOf[k]].name << "\n";
            for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
                obj << 'f';
                for (int c = 0; c < 3; ++c) {
                    const size_t i = base + g.indices[t + c];
                    obj << ' ' << i << '/' << i << '/' << i;
                }
                obj << "\n";
            }
            base += g.vertexCount;
        }
        for (const auto &cm : customMats) {
            const CustomMesh &c = *cm.first;
            mtl << "newmtl " << cm.name << "\nKd " << c.color[0] << ' ' << c.color[1] << ' ' << c.color[2] << "\nKs 0.05 0.05 0.05\nNs 16\n";
            if (c.blend)
                mtl << "d " << c.color[3] << "\n";
            if (c.transmission > 0) // (OBJ knows no transmission: water is see-through by its dissolve)
                mtl << "Ni " << c.ior << "\nd " << 1 - 0.3f * c.transmission << "\n";
            if (cm.albedo >= 0) {
                mtl << "map_Kd " << texFolder << "/" << tw.images[cm.albedo].fileName << "\n";
                if (c.blend) // (decals: where they show is in the texture's alpha)
                    mtl << "map_d " << texFolder << "/" << tw.images[cm.albedo].fileName << "\n";
            }
            if (cm.normal >= 0)
                mtl << "map_Bump -bm 1 " << texFolder << "/" << tw.images[cm.normal].fileName << "\nbump " << texFolder << "/" << tw.images[cm.normal].fileName << "\n";
            mtl << "\n";
        }
        for (size_t i = 0; i < matViews.size(); ++i) {
            auto ref = [&](int img) { return texFolder + "/" + tw.images[img].fileName; };
            if (matViews[i] && matViews[i]->lamp.on) { // a glow layer: black, see-through but for its own light
                mtl << "newmtl " << materialName[i] << "\nKd 0 0 0\nKs 0 0 0\nNs 1\n";
                if (matImages[i].glow >= 0) {
                    const float g = matViews[i]->lamp.gain;
                    mtl << "Ke " << g << ' ' << g << ' ' << g << "\nmap_Ke " << ref(matImages[i].glow) << "\nmap_d " << ref(matImages[i].glow) << "\n\n";
                } else {
                    mtl << "d 0\n\n";
                }
                continue;
            }
            const float *kd = matViews[i] ? matViews[i]->color : nullptr;
            mtl << "newmtl " << materialName[i] << "\nKd " << (kd ? kd[0] : 1.0f) << ' ' << (kd ? kd[1] : 1.0f) << ' ' << (kd ? kd[2] : 1.0f) << "\nKs 0.2 0.2 0.2\nNs 64\n";
            if (matImages[i].albedo >= 0)
                mtl << "map_Kd " << ref(matImages[i].albedo) << "\n";
            if (matImages[i].normal >= 0)
                mtl << "map_Bump -bm 1 " << ref(matImages[i].normal) << "\nbump " << ref(matImages[i].normal) << "\n"; // (Blender reads map_Bump, Cinema 4D only the spec's lowercase bump)
            if (matImages[i].emissive >= 0) {
                const float k = (matViews[i] && matViews[i]->heat ? std::clamp(opt.heat, 0.0f, 1.0f) : 1.0f) * (matViews[i] ? matViews[i]->emissiveGain : 1.0f);
                mtl << "Ke " << k << ' ' << k << ' ' << k << "\nmap_Ke " << ref(matImages[i].emissive) << "\n";
            }
            if (matViews[i] && matImages[i].albedo >= 0 && (matViews[i]->blend || (matViews[i]->alphaTest && tw.images[matImages[i].albedo].cut)))
                mtl << "map_d " << ref(matImages[i].albedo) << "\n";
            mtl << "\n";
        }
        const std::string &o = obj.text;
        const std::string m = mtl.str();
        files.push_back({outFile, o.data(), o.size()});
        files.push_back({dir / (stem + ".mtl"), m.data(), m.size()});
        for (const auto &img : tw.images)
            files.push_back({texDir / img.fileName, img.png.data(), img.png.size()});
        return writeAll();
      } catch (const std::bad_alloc &) {
        return fail("the OBJ is too big to build in memory; export GLB instead (or fewer objects, a lower LOD)");
      }
    }

    // ---- glTF ----
    const bool glb = opt.format == ExportOptions::Format::GLB;
    GltfWriter w;
    ujson::Value images = ujson::Value::array(), textures = ujson::Value::array(), materials = ujson::Value::array();
    std::map<int, int> imageToTexture;
    auto textureFor = [&](int imageIndex) -> int {
        if (imageIndex < 0)
            return -1;
        auto it = imageToTexture.find(imageIndex);
        if (it != imageToTexture.end())
            return it->second;
        ujson::Value im = ujson::Value::object();
        PngFile &f = tw.images[imageIndex];
        im.set("name", f.fileName);
        if (glb) {
            im.set("bufferView", w.view(f.png.data(), f.png.size(), 0, true)); // (written from here)
            im.set("mimeType", "image/png");
        } else {
            im.set("uri", texFolder + "/" + f.fileName); // ASCII only, so no URI escaping needed
        }
        images.push(std::move(im));
        ujson::Value t = ujson::Value::object();
        t.set("sampler", 0);
        t.set("source", static_cast<double>(images.size() - 1));
        textures.push(std::move(t));
        const int ti = static_cast<int>(textures.size()) - 1;
        imageToTexture[imageIndex] = ti;
        return ti;
    };
    auto texRef = [](int index) {
        ujson::Value r = ujson::Value::object();
        r.set("index", index);
        return r;
    };
    bool emissiveStrength = false; // (KHR_materials_emissive_strength used)
    bool transmission = false;     // (KHR_materials_transmission, _ior and _volume used: water)
    for (size_t i = 0; i < matViews.size(); ++i) {
        const MaterialView *mv = matViews[i];
        const MaterialImages &mi = matImages[i];
        ujson::Value m = ujson::Value::object();
        m.set("name", materialName[i]);
        ujson::Value pbr = ujson::Value::object();
        if (mv && mv->lamp.on) {
            // A glow layer on the part's surface (LampBake): black and see-through but for its own
            // light (the game adds it on; glTF blends, which looks the same where the glow is bright).
            const int tg = textureFor(mi.glow);
            ujson::Value col = ujson::Value::array();
            for (int c = 0; c < 3; ++c)
                col.push(0.0);
            col.push(tg >= 0 ? 1.0 : 0.0); // (without its texture nothing shows)
            pbr.set("baseColorFactor", std::move(col));
            pbr.set("metallicFactor", 0);
            pbr.set("roughnessFactor", 1);
            if (tg >= 0) {
                pbr.set("baseColorTexture", texRef(tg)); // (its alpha)
                m.set("emissiveTexture", texRef(tg));
                const double g = mv->lamp.gain;
                ujson::Value f = ujson::Value::array();
                for (int c = 0; c < 3; ++c)
                    f.push(std::round(std::min(1.0, g) * 1e4) / 1e4);
                m.set("emissiveFactor", std::move(f));
                if (g > 1.0) {
                    ujson::Value es = ujson::Value::object(), ext = ujson::Value::object();
                    es.set("emissiveStrength", std::round(g * 1e4) / 1e4);
                    ext.set("KHR_materials_emissive_strength", std::move(es));
                    m.set("extensions", std::move(ext));
                    emissiveStrength = true;
                }
            }
            m.set("pbrMetallicRoughness", std::move(pbr));
            m.set("alphaMode", "BLEND");
            if (mv->lamp.twoSided)
                m.set("doubleSided", true);
            ujson::Value ex = ujson::Value::object();
            ex.set("crossoutShader", mv->guid);
            ex.set("lampGlow", true); // see-through glow over the part's own surface
            ujson::Value tex = ujson::Value::object();
            for (const auto &t : mv->textures)
                tex.set(t.param, t.base);
            ex.set("textures", std::move(tex));
            m.set("extras", std::move(ex));
            materials.push(std::move(m));
            continue;
        }
        // Metalness and roughness come from the packed texture (gloss map); without one the part
        // is plain and as rough as the viewer shows it. Glass is never metal (its gloss maps' blue
        // channel is near 1).
        pbr.set("metallicFactor", mi.orm >= 0 && !(mv && isGlassShader(mv->guid)) ? 1 : 0);
        pbr.set("roughnessFactor", mi.orm >= 0 ? 1 : 0.55);
        if (const int ta = textureFor(mi.albedo); ta >= 0)
            pbr.set("baseColorTexture", texRef(ta));
        if (mv && (mv->color[0] != 1 || mv->color[1] != 1 || mv->color[2] != 1)) {
            ujson::Value col = ujson::Value::array();
            for (int c = 0; c < 3; ++c)
                col.push(std::round(static_cast<double>(mv->color[c]) * 1e4) / 1e4);
            col.push(1.0);
            pbr.set("baseColorFactor", std::move(col));
        }
        if (const int to = textureFor(mi.orm); to >= 0) {
            pbr.set("metallicRoughnessTexture", texRef(to));
            if (mi.hasAo && opt.occlusion)
                m.set("occlusionTexture", texRef(to));
        }
        if (const int tn = textureFor(mi.normal); tn >= 0)
            m.set("normalTexture", texRef(tn));
        if (const int te = textureFor(mi.emissive); te >= 0) {
            m.set("emissiveTexture", texRef(te)); // (a heat map only comes when exported hot: TextureWork::build)
            const double k = (mv && mv->heat ? std::clamp(opt.heat, 0.0f, 1.0f) : 1.0) * (mv ? mv->emissiveGain : 1.0f);
            ujson::Value f = ujson::Value::array();
            for (int c = 0; c < 3; ++c)
                f.push(std::round(std::min(1.0, k) * 1e4) / 1e4);
            m.set("emissiveFactor", std::move(f));
            if (k > 1.0) { // (map props' projectors and torches: brighter than a texture holds)
                ujson::Value es = ujson::Value::object(), ext = ujson::Value::object();
                es.set("emissiveStrength", std::round(k * 1e4) / 1e4);
                ext.set("KHR_materials_emissive_strength", std::move(es));
                m.set("extensions", std::move(ext));
                emissiveStrength = true;
            }
        }
        m.set("pbrMetallicRoughness", std::move(pbr));
        if (mv && mv->blend) {
            m.set("alphaMode", "BLEND");
        } else if (mv && mv->alphaTest && mi.albedo >= 0 && tw.images[mi.albedo].cut) { // (an albedo without holes stays opaque)
            m.set("alphaMode", "MASK");
            m.set("alphaCutoff", 0.5);
        }
        if (mv) {
            ujson::Value ex = ujson::Value::object();
            ex.set("crossoutShader", mv->guid);
            if (mv->heat)
                ex.set("heatGlow", true); // emissiveTexture is the weapon's heat mask (scale emissiveFactor 0..1)
            ujson::Value tex = ujson::Value::object();
            for (const auto &t : mv->textures)
                tex.set(t.param, t.base);
            ex.set("textures", std::move(tex));
            if (!mv->layers.empty()) { // the further texture sets the game blends over these (baked in, or for an importer to blend)
                ujson::Value ls = ujson::Value::array();
                for (const auto &L : mv->layers) {
                    ujson::Value lo = ujson::Value::object(), bl = ujson::Value::array();
                    lo.set("layer", L.index);
                    lo.set("tiling", static_cast<double>(L.tiling));
                    lo.set("uv", L.uv == 2 ? "world" : L.uv == 1 ? "uv1" : "uv0");
                    lo.set("invertHeight", L.invert);
                    for (float f : L.blend)
                        bl.push(static_cast<double>(f));
                    lo.set("blend", std::move(bl));
                    ls.push(std::move(lo));
                }
                ex.set("layers", std::move(ls));
                ex.set("layerWeights", mv->weights == 2 ? "colormap" : mv->weights == 1 ? "vertexColor" : "none");
                ex.set("layersBaked", bakesLayers(*mv));
            }
            m.set("extras", std::move(ex));
        }
        materials.push(std::move(m));
    }
    const int firstCustomMaterial = static_cast<int>(materials.size());
    for (const auto &cm : customMats) {
        const CustomMesh &c = *cm.first;
        ujson::Value m = ujson::Value::object();
        m.set("name", cm.name);
        ujson::Value pbr = ujson::Value::object();
        ujson::Value col = ujson::Value::array();
        for (int i = 0; i < 4; ++i) // (see-through water: its colour is its volume's, a base colour would tint all light through it)
            col.push(c.transmission > 0 ? 1.0 : static_cast<double>(c.color[i]));
        pbr.set("baseColorFactor", std::move(col));
        pbr.set("metallicFactor", static_cast<double>(c.metallic));
        pbr.set("roughnessFactor", static_cast<double>(c.roughness));
        if (const int ta = textureFor(cm.albedo); ta >= 0)
            pbr.set("baseColorTexture", texRef(ta));
        const int tm = textureFor(cm.metalRough);
        if (tm >= 0)
            pbr.set("metallicRoughnessTexture", texRef(tm));
        m.set("pbrMetallicRoughness", std::move(pbr));
        if (const int tn = textureFor(cm.normal); tn >= 0) {
            ujson::Value nt = texRef(tn);
            if (c.normalScale != 1)
                nt.set("scale", std::round(static_cast<double>(c.normalScale) * 1e4) / 1e4);
            m.set("normalTexture", std::move(nt));
        }
        if (tm >= 0 && opt.occlusion) // (Cinema 4D makes an occlusion map Redshift's Overall Tint: the terrain went dark)
            m.set("occlusionTexture", texRef(tm));
        if (c.blend)
            m.set("alphaMode", "BLEND");
        if (c.doubleSided)
            m.set("doubleSided", true);
        if (c.transmission > 0) { // (water: see-through by transmission, its depth's colour by the volume)
            ujson::Value ext = ujson::Value::object(), tr = ujson::Value::object(), io = ujson::Value::object(), vo = ujson::Value::object();
            tr.set("transmissionFactor", static_cast<double>(c.transmission));
            io.set("ior", static_cast<double>(c.ior));
            vo.set("thicknessFactor", std::round(static_cast<double>(c.thickness) * 1e3) / 1e3);
            vo.set("attenuationDistance", std::round(static_cast<double>(c.attenuationDistance) * 1e4) / 1e4);
            ujson::Value ac = ujson::Value::array();
            for (float f : c.attenuationColor)
                ac.push(std::round(static_cast<double>(f) * 1e4) / 1e4);
            vo.set("attenuationColor", std::move(ac));
            ext.set("KHR_materials_transmission", std::move(tr));
            ext.set("KHR_materials_ior", std::move(io));
            ext.set("KHR_materials_volume", std::move(vo));
            m.set("extensions", std::move(ext));
            transmission = true;
        }
        materials.push(std::move(m));
    }

    // Animated export (one part): its skeleton, with the pieces that move (skinned meshes, and rigid
    // ones riding on a node, like a wheel's tyre on its hub) in a mesh skinned to it.
    SceneModel *skel = animatedExport && itemModel[0] && itemModel[0]->b.model.nodes.size() > 1 ? itemModel[0] : nullptr;
    auto rigidNode = [](const SceneModel &sm, const ScenePart &p) -> int {
        const MeshInfo &me = sm.b.model.meshes[p.meshIndex];
        return p.g.joints.empty() && me.words[5] == 0 && me.words[6] > 0 && me.words[6] < sm.b.model.nodes.size() ? static_cast<int>(me.words[6]) : -1;
    };

    // meshes: one per model and LOD, shared by every part that uses it
    ujson::Value meshes = ujson::Value::array();
    UniqueNames meshNames;
    for (auto &[key, sm] : models) {
        for (int lod : sm.lods) {
          for (int moving = 0; moving < (&sm == skel ? 2 : 1); ++moving) {
            ujson::Value prims = ujson::Value::array();
            for (const auto &p : sm.parts) {
                if (p.lod != lod)
                    continue;
                const int rigid = &sm == skel ? rigidNode(sm, p) : -1;
                const bool skinned = &sm == skel && (!p.g.joints.empty() || rigid >= 0);
                if (skinned != (moving == 1))
                    continue;
                const auto &g = p.g;
                ujson::Value attrs = ujson::Value::object();
                float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
                for (uint32_t v = 0; v < g.vertexCount; ++v)
                    for (int c = 0; c < 3; ++c) {
                        mn[c] = std::min(mn[c], g.position[v * 3 + c]);
                        mx[c] = std::max(mx[c], g.position[v * 3 + c]);
                    }
                attrs.set("POSITION", w.accessor(w.view(g.position.data(), g.position.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC3", false, mn, mx, 3));
                if (!g.normal.empty())
                    attrs.set("NORMAL", w.accessor(w.view(g.normal.data(), g.normal.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC3"));
                if (opt.tangents && !g.tangent.empty() && !g.normal.empty())
                    attrs.set("TANGENT", w.accessor(w.view(g.tangent.data(), g.tangent.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC4"));
                if (!g.uv0.empty()) {
                    attrs.set("TEXCOORD_0", w.accessor(w.view(g.uv0.data(), g.uv0.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC2"));
                } else if (opt.textures && sm.gltfMaterial.count(p.material)) { // (its material's textures read set 0: glTF wants one)
                    const std::vector<float> zeros(static_cast<size_t>(g.vertexCount) * 2, 0.0f);
                    attrs.set("TEXCOORD_0", w.accessor(w.view(zeros.data(), zeros.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC2"));
                }
                // (one UV set: no exported texture reads the model's second, and Cinema 4D's glTF import keeps
                // only the last set and maps every texture through it: parts came out as dark streaks)
                if (opt.vertexColors && !g.color.empty())
                    attrs.set("COLOR_0", w.accessor(w.view(g.color.data(), g.color.size(), kArrayBuffer), kUByte, g.vertexCount, "VEC4", true));
                if (skinned) { // joints = the model's node indices (the skin lists every node, in order)
                    std::vector<uint16_t> joints(static_cast<size_t>(g.vertexCount) * 4, 0);
                    std::vector<float> weights(static_cast<size_t>(g.vertexCount) * 4, 0.0f);
                    for (uint32_t v = 0; v < g.vertexCount; ++v) {
                        float sum = 0;
                        if (rigid < 0 && g.weights.size() >= g.joints.size())
                            for (int c = 0; c < 4; ++c) {
                                joints[v * 4 + c] = g.joints[v * 4 + c];
                                sum += (weights[v * 4 + c] = g.weights[v * 4 + c]);
                            }
                        if (sum < 1e-6f) { // rigid, or a vertex on no bone: all on one node
                            joints[v * 4] = static_cast<uint16_t>(std::max(rigid, 0));
                            weights[v * 4] = 1;
                            for (int c = 1; c < 4; ++c)
                                joints[v * 4 + c] = 0, weights[v * 4 + c] = 0;
                        } else if (std::abs(sum - 1) > 1e-4f) {
                            for (int c = 0; c < 4; ++c)
                                weights[v * 4 + c] /= sum;
                        }
                    }
                    attrs.set("JOINTS_0", w.accessor(w.view(joints.data(), joints.size() * 2, kArrayBuffer), kUShort, g.vertexCount, "VEC4"));
                    attrs.set("WEIGHTS_0", w.accessor(w.view(weights.data(), weights.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC4"));
                }
                ujson::Value prim = ujson::Value::object();
                prim.set("attributes", std::move(attrs));
                int ia;
                if (g.vertexCount <= 65535) {
                    const std::vector<uint16_t> idx = narrowIndices(g.indices);
                    ia = w.accessor(w.view(idx.data(), idx.size() * 2, kElementBuffer), kUShort, idx.size(), "SCALAR");
                } else {
                    ia = w.accessor(w.view(g.indices.data(), g.indices.size() * 4, kElementBuffer), kUInt, g.indices.size(), "SCALAR");
                }
                prim.set("indices", ia);
                auto mit = sm.gltfMaterial.find(p.material);
                if (mit != sm.gltfMaterial.end())
                    prim.set("material", mit->second);
                prims.push(std::move(prim));
            }
            if (!prims.size())
                continue;
            ujson::Value mesh = ujson::Value::object();
            mesh.set("name", meshNames.get(sm.b.baseName + (sm.mirrored ? "_mirrored" : "") + (moving ? "_skinned" : "") + (sm.lods.size() > 1 || lod > 0 ? "_LOD" + std::to_string(lod) : std::string())));
            mesh.set("primitives", std::move(prims));
            meshes.push(std::move(mesh));
            (moving ? sm.gltfSkinnedMesh : sm.gltfMesh)[lod] = static_cast<int>(meshes.size()) - 1;
          }
        }
    }
    std::vector<int> customMesh(custom.size(), -1);
    for (size_t k = 0; k < custom.size(); ++k) {
        const MeshGeometry &g = custom[k].g;
        if (!g.vertexCount || g.indices.size() < 3)
            continue;
        ujson::Value attrs = ujson::Value::object();
        float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
        for (uint32_t v = 0; v < g.vertexCount; ++v)
            for (int c = 0; c < 3; ++c) {
                mn[c] = std::min(mn[c], g.position[v * 3 + c]);
                mx[c] = std::max(mx[c], g.position[v * 3 + c]);
            }
        attrs.set("POSITION", w.accessor(w.view(g.position.data(), g.position.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC3", false, mn, mx, 3));
        if (!g.normal.empty())
            attrs.set("NORMAL", w.accessor(w.view(g.normal.data(), g.normal.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC3"));
        if (!g.uv0.empty())
            attrs.set("TEXCOORD_0", w.accessor(w.view(g.uv0.data(), g.uv0.size() * 4, kArrayBuffer), kFloat, g.vertexCount, "VEC2"));
        if (g.color.size() == static_cast<size_t>(g.vertexCount) * 4) // (decals: how much shows at each corner, in alpha)
            attrs.set("COLOR_0", w.accessor(w.view(g.color.data(), g.color.size(), kArrayBuffer), kUByte, g.vertexCount, "VEC4", true));
        ujson::Value prim = ujson::Value::object();
        prim.set("attributes", std::move(attrs));
        if (g.vertexCount <= 65535) {
            const std::vector<uint16_t> idx = narrowIndices(g.indices);
            prim.set("indices", w.accessor(w.view(idx.data(), idx.size() * 2, kElementBuffer), kUShort, idx.size(), "SCALAR"));
        } else {
            prim.set("indices", w.accessor(w.view(g.indices.data(), g.indices.size() * 4, kElementBuffer), kUInt, g.indices.size(), "SCALAR"));
        }
        prim.set("material", firstCustomMaterial + customMatOf[k]);
        ujson::Value prims = ujson::Value::array();
        prims.push(std::move(prim));
        ujson::Value mesh = ujson::Value::object();
        mesh.set("name", meshNames.get(custom[k].name));
        mesh.set("primitives", std::move(prims));
        meshes.push(std::move(mesh));
        customMesh[k] = static_cast<int>(meshes.size()) - 1;
    }

    ujson::Value nodes = ujson::Value::array(), rootChildren = ujson::Value::array();
    UniqueNames nodeNames;
    // Maps sort their objects into group nodes (terrain, water, props, trees ...), in first-use order.
    std::vector<std::pair<std::string, ujson::Value>> groups;
    auto groupKids = [&](const std::string &group) -> ujson::Value & {
        if (group.empty())
            return rootChildren;
        for (auto &gk : groups)
            if (gk.first == group)
                return gk.second;
        groups.emplace_back(group, ujson::Value::array());
        return groups.back().second;
    };
    auto addLodNodes = [&](const SceneModel &sm, const std::string &name, ujson::Value &kids) {
        for (int lod : sm.lods) {
            auto mi = sm.gltfMesh.find(lod);
            if (mi == sm.gltfMesh.end())
                continue;
            ujson::Value node = ujson::Value::object();
            node.set("name", nodeNames.get(name + (sm.lods.size() > 1 || lod > 0 ? "_LOD" + std::to_string(lod) : std::string())));
            node.set("mesh", mi->second);
            nodes.push(std::move(node));
            kids.push(static_cast<double>(nodes.size() - 1));
        }
    };
    auto addEmpties = [&](const char *groupName, auto &&list, ujson::Value &kids) {
        ujson::Value groupKids = ujson::Value::array();
        for (const auto &x : list) {
            ujson::Value n = ujson::Value::object();
            n.set("name", nodeNames.get(x.first));
            if (!isIdentityMatrix(x.second.data()))
                n.set("matrix", matrixValue(x.second.data()));
            nodes.push(std::move(n));
            groupKids.push(static_cast<double>(nodes.size() - 1));
        }
        ujson::Value group = ujson::Value::object();
        group.set("name", nodeNames.get(groupName));
        group.set("children", std::move(groupKids));
        nodes.push(std::move(group));
        kids.push(static_cast<double>(nodes.size() - 1));
    };
    // A model shown on the part (attachName): its node (its LODs under it when there are several) at
    // `matrix`, or where its parent is (null). -1 when it has nothing to show.
    auto addAttachment = [&](size_t i, const float *matrix) -> int {
        const SceneModel *am = attachModel[i];
        if (!am || am->gltfMesh.empty())
            return -1;
        const std::string name = attachName(i);
        ujson::Value node = ujson::Value::object();
        node.set("name", nodeNames.get(name));
        if (am->lods.size() == 1) {
            node.set("mesh", am->gltfMesh.begin()->second);
        } else {
            ujson::Value kids = ujson::Value::array();
            addLodNodes(*am, name, kids);
            node.set("children", std::move(kids));
        }
        if (matrix && !isIdentityMatrix(matrix))
            node.set("matrix", matrixValue(matrix));
        ujson::Value ex = ujson::Value::object();
        ex.set("source", am->b.mdlPath);
        ex.set("skin", am->b.skin);
        ex.set("shownOn", attachOn(i));
        node.set("extras", std::move(ex));
        nodes.push(std::move(node));
        return static_cast<int>(nodes.size()) - 1;
    };
    // The top node: one part is named for what it is in the game (else its file); a build or a map
    // for itself. Its name is taken first, so nothing under it ends up as "name.001" beside it.
    std::string rootName = single ? (opt.name.empty() ? itemModel[0]->b.baseName : opt.name) : sceneName;
    if (rootName.empty())
        rootName = "build";
    const std::string rootNodeName = nodeNames.get(rootName);
    int aloneNode = -1; // a part with nothing else to show is its own top node (one object in Blender, not an empty over it)
    ujson::Value skins = ujson::Value::array(), animations = ujson::Value::array();
    if (single) {
        const SceneModel &sm = *itemModel[0];
        const bool empties = opt.slots && (!sm.b.model.slots.empty() || (sm.b.model.nodes.size() > 1 && !skel));
        if (!skel && !empties && !anyAttached && sm.gltfMesh.size() == 1 && (objFormat || extras.lights.empty())) {
            ujson::Value node = ujson::Value::object(), ex = ujson::Value::object();
            node.set("name", rootNodeName);
            node.set("mesh", sm.gltfMesh.begin()->second);
            ex.set("source", sm.b.mdlPath);
            ex.set("skin", sm.b.skin);
            node.set("extras", std::move(ex));
            nodes.push(std::move(node));
            aloneNode = static_cast<int>(nodes.size()) - 1;
        } else {
            addLodNodes(sm, sm.b.baseName == rootNodeName ? sm.b.baseName + "_mesh" : sm.b.baseName, rootChildren);
        }
        if (!skel) // what is shown on its nodes, where they stand (with a skeleton: under the joints, below)
            for (size_t i = 0; i < attach.size(); ++i)
                if (const int a = addAttachment(i, attachMatrix[i].data()); a >= 0)
                    rootChildren.push(static_cast<double>(a));
        if (skel) { // the skeleton (in the pose shown, else at rest), the skin over every node, the moving meshes, the clips
            const RestPose rp = restPose(sm.b.model);
            const size_t n = rp.world.size();
            // what is shown on its nodes hangs under their joints, so the clips carry it (made first:
            // the joints' children name them)
            std::vector<ujson::Value> kids(n, ujson::Value::array());
            for (size_t i = 0; i < attach.size(); ++i)
                if (attach[i].node >= 0 && static_cast<size_t>(attach[i].node) < n)
                    if (const int a = addAttachment(i, nullptr); a >= 0)
                        kids[attach[i].node].push(static_cast<double>(a));
            const int first = static_cast<int>(nodes.size());
            std::vector<std::array<float, 16>> posedWorld, posedSkin; // (the skin keeps the bind pose: an importer's rest)
            const bool posed = !opt.pose.empty() && shownPose(rp, opt.pose, posedWorld, posedSkin) && poseMoves(posedSkin);
            for (size_t i = 0; i < n; ++i)
                if (rp.parent[i] >= 0)
                    kids[rp.parent[i]].push(static_cast<double>(first + i));
            int skeletonRoot = -1, roots = 0; // ("skeleton" must be every joint's ancestor: only with one root)
            ujson::Value joints = ujson::Value::array();
            for (size_t i = 0; i < n; ++i) {
                const Node &nd = sm.b.model.nodes[i];
                ujson::Value node = ujson::Value::object();
                node.set("name", nodeNames.get(nd.name.empty() ? "node" + std::to_string(i) : nd.name));
                auto vec = [](const float *v, int c) {
                    ujson::Value a = ujson::Value::array();
                    for (int k = 0; k < c; ++k)
                        a.push(static_cast<double>(std::abs(v[k]) < 1e-9f ? 0.0f : v[k]));
                    return a;
                };
                float t[3], q[4], s[3];
                std::copy(rp.t[i].begin(), rp.t[i].end(), t);
                std::copy(rp.q[i].begin(), rp.q[i].end(), q);
                std::copy(rp.s[i].begin(), rp.s[i].end(), s);
                if (posed) {
                    const auto &p = opt.pose[i];
                    const float l = std::sqrt(p[3] * p[3] + p[4] * p[4] + p[5] * p[5] + p[6] * p[6]);
                    for (int c = 0; c < 3; ++c)
                        t[c] = p[c], s[c] = p[7 + c];
                    for (int c = 0; c < 4; ++c)
                        q[c] = p[3 + c] / l;
                }
                node.set("translation", vec(t, 3));
                node.set("rotation", vec(q, 4));
                if (std::abs(s[0] - 1) > 1e-4f || std::abs(s[1] - 1) > 1e-4f || std::abs(s[2] - 1) > 1e-4f)
                    node.set("scale", vec(s, 3));
                if (kids[i].size())
                    node.set("children", std::move(kids[i]));
                nodes.push(std::move(node));
                joints.push(static_cast<double>(first + i));
                if (rp.parent[i] < 0) {
                    rootChildren.push(static_cast<double>(first + i));
                    if (roots++ == 0)
                        skeletonRoot = first + static_cast<int>(i);
                }
            }
            if (roots != 1)
                skeletonRoot = -1;
            std::vector<float> ibm(n * 16);
            for (size_t i = 0; i < n; ++i)
                invertAffine(rp.world[i].data(), &ibm[i * 16]);
            ujson::Value skin = ujson::Value::object();
            skin.set("name", sm.b.baseName + "_skeleton");
            skin.set("joints", std::move(joints));
            skin.set("inverseBindMatrices", w.accessor(w.view(ibm.data(), ibm.size() * 4, 0), kFloat, n, "MAT4"));
            if (skeletonRoot >= 0)
                skin.set("skeleton", skeletonRoot);
            skins.push(std::move(skin));
            for (int lod : sm.lods) { // (a skinned mesh's node transform is ignored: it sits at the root)
                auto mi = sm.gltfSkinnedMesh.find(lod);
                if (mi == sm.gltfSkinnedMesh.end())
                    continue;
                ujson::Value node = ujson::Value::object();
                node.set("name", nodeNames.get(sm.b.baseName + "_skinned" + (sm.lods.size() > 1 || lod > 0 ? "_LOD" + std::to_string(lod) : std::string())));
                node.set("mesh", mi->second);
                node.set("skin", 0);
                nodes.push(std::move(node));
                rootChildren.push(static_cast<double>(nodes.size() - 1));
            }
            animations = buildAnimations(gd, sm.b, rp, first, w, warnings);
        }
        if (opt.slots && !sm.b.model.slots.empty()) {
            std::vector<std::pair<std::string, std::array<float, 16>>> list;
            for (const auto &s : sm.b.model.slots) {
                std::array<float, 16> m;
                toGltfMatrix(s.matrix, m.data());
                list.emplace_back(s.name, m);
            }
            addEmpties("slots", list, rootChildren);
        }
        if (opt.slots && sm.b.model.nodes.size() > 1 && !skel) { // (with a skeleton, its nodes are the pivots)
            std::vector<std::pair<std::string, std::array<float, 16>>> list;
            for (size_t i = 0; i < sm.b.model.nodes.size(); ++i) {
                std::array<float, 16> m;
                if (shownWorld.size() == sm.b.model.nodes.size()) // (where the pose put them, like the meshes)
                    m = shownWorld[i];
                else
                    toGltfMatrix(sm.b.model.nodes[i].world, m.data());
                list.emplace_back(sm.b.model.nodes[i].name, m);
            }
            addEmpties("pivots", list, rootChildren);
        }
    } else {
        for (size_t k = 0; k < items.size(); ++k) {
            const SceneModel *sm = itemModel[k];
            if (!sm || sm->gltfMesh.empty())
                continue;
            const std::string name = items[k].name.empty() ? sm->b.baseName : items[k].name;
            const float *matrix = itemMatrix[k].data();
            ujson::Value node = ujson::Value::object();
            if (sm->lods.size() == 1) {
                node.set("name", nodeNames.get(name));
                node.set("mesh", sm->gltfMesh.begin()->second);
            } else {
                node.set("name", nodeNames.get(name));
                ujson::Value kids = ujson::Value::array();
                addLodNodes(*sm, name, kids);
                node.set("children", std::move(kids));
            }
            if (!isIdentityMatrix(matrix))
                node.set("matrix", matrixValue(matrix));
            ujson::Value ex = ujson::Value::object();
            ex.set("source", sm->b.mdlPath);
            ex.set("skin", sm->b.skin);
            if (sm->mirrored)
                ex.set("mirrored", true);
            node.set("extras", std::move(ex));
            nodes.push(std::move(node));
            groupKids(items[k].group).push(static_cast<double>(nodes.size() - 1));
        }
    }
    for (size_t k = 0; k < custom.size(); ++k) {
        if (customMesh[k] < 0)
            continue;
        ujson::Value node = ujson::Value::object();
        node.set("name", nodeNames.get(custom[k].name));
        node.set("mesh", customMesh[k]);
        nodes.push(std::move(node));
        groupKids(custom[k].group).push(static_cast<double>(nodes.size() - 1));
    }
    // copies of one mesh (grass): EXT_mesh_gpu_instancing, one node per kind
    bool instancing = false;
    for (size_t k = 0; k < instanced.size(); ++k) {
        const SceneModel *sm = instancedModel[k];
        if (!sm || sm->gltfMesh.empty())
            continue;
        const InstancedItem &ii = instanced[k];
        const size_t n = ii.trs.size() / 8;
        std::vector<float> t(n * 3), r(n * 4), s(n * 3);
        float mn[3] = {1e30f, 1e30f, 1e30f}, mx[3] = {-1e30f, -1e30f, -1e30f};
        for (size_t i = 0; i < n; ++i) {
            const float *c = &ii.trs[i * 8];
            for (int j = 0; j < 3; ++j) {
                t[i * 3 + j] = c[j];
                mn[j] = std::min(mn[j], c[j]);
                mx[j] = std::max(mx[j], c[j]);
                s[i * 3 + j] = c[7];
            }
            for (int j = 0; j < 4; ++j)
                r[i * 4 + j] = c[3 + j];
        }
        ujson::Value attrs = ujson::Value::object();
        attrs.set("TRANSLATION", w.accessor(w.view(t.data(), t.size() * 4, 0), kFloat, n, "VEC3", false, mn, mx, 3));
        attrs.set("ROTATION", w.accessor(w.view(r.data(), r.size() * 4, 0), kFloat, n, "VEC4"));
        attrs.set("SCALE", w.accessor(w.view(s.data(), s.size() * 4, 0), kFloat, n, "VEC3"));
        if (sm->blades && ii.color.size() == n * 3) // (the tint they take from the ground: three.js reads it as each copy's colour)
            attrs.set("_COLOR_0", w.accessor(w.view(ii.color.data(), ii.color.size() * 4, 0), kFloat, n, "VEC3"));
        ujson::Value ext = ujson::Value::object(), gpu = ujson::Value::object();
        gpu.set("attributes", std::move(attrs));
        ext.set("EXT_mesh_gpu_instancing", std::move(gpu));
        ujson::Value node = ujson::Value::object();
        node.set("name", nodeNames.get(ii.name.empty() ? sm->b.baseName : ii.name));
        node.set("mesh", sm->gltfMesh.begin()->second);
        node.set("extensions", std::move(ext));
        ujson::Value ex = ujson::Value::object();
        ex.set("source", sm->b.mdlPath);
        ex.set("copies", static_cast<double>(n));
        node.set("extras", std::move(ex));
        nodes.push(std::move(node));
        groupKids(ii.group).push(static_cast<double>(nodes.size() - 1));
        instancing = true;
    }
    // lights (KHR_lights_punctual): a node turned so that its -Z runs along the light
    ujson::Value lights = ujson::Value::array();
    if (!objFormat)
        for (const SceneLight &l : extras.lights) {
            ujson::Value light = ujson::Value::object(), col = ujson::Value::array();
            light.set("name", l.name);
            light.set("type", "directional");
            for (int c = 0; c < 3; ++c)
                col.push(static_cast<double>(std::clamp(l.color[c], 0.0f, 1.0f)));
            light.set("color", std::move(col));
            light.set("intensity", static_cast<double>(l.intensity));
            lights.push(std::move(light));
            const float bx = l.direction[0], by = l.direction[1], bz = l.direction[2]; // rotate (0, 0, -1) onto b
            float q[4] = {by, -bx, 0, 1 - bz};
            if (1 - bz < 1e-6f)
                q[0] = 1, q[1] = 0, q[2] = 0, q[3] = 0; // (b = +Z: half a turn about X)
            const float ql = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            ujson::Value rot = ujson::Value::array(), pos = ujson::Value::array();
            for (int c = 0; c < 4; ++c)
                rot.push(static_cast<double>(q[c] / ql));
            for (int c = 0; c < 3; ++c)
                pos.push(static_cast<double>(l.position[c]));
            ujson::Value node = ujson::Value::object(), ext = ujson::Value::object(), ref = ujson::Value::object();
            node.set("name", nodeNames.get(l.name));
            node.set("translation", std::move(pos));
            node.set("rotation", std::move(rot));
            ref.set("light", static_cast<double>(lights.size() - 1));
            ext.set("KHR_lights_punctual", std::move(ref));
            node.set("extensions", std::move(ext));
            nodes.push(std::move(node));
            rootChildren.push(static_cast<double>(nodes.size() - 1));
        }
    for (auto &[name, kids] : groups) {
        ujson::Value group = ujson::Value::object();
        group.set("name", nodeNames.get(name));
        group.set("children", std::move(kids));
        nodes.push(std::move(group));
        rootChildren.push(static_cast<double>(nodes.size() - 1));
    }
    if (!meshes.size())
        return fail("nothing visible to export");
    if (aloneNode < 0) {
        ujson::Value root = ujson::Value::object();
        root.set("name", rootNodeName);
        root.set("children", std::move(rootChildren));
        if (single) {
            ujson::Value ex = ujson::Value::object();
            ex.set("source", itemModel[0]->b.mdlPath);
            ex.set("skin", itemModel[0]->b.skin);
            root.set("extras", std::move(ex));
        }
        nodes.push(std::move(root));
    }
    const int topNode = aloneNode >= 0 ? aloneNode : static_cast<int>(nodes.size()) - 1;

    ujson::Value doc = ujson::Value::object();
    ujson::Value asset = ujson::Value::object();
    asset.set("version", "2.0");
    asset.set("generator", "Grimcold");
    ujson::Value aex = ujson::Value::object();
    if (single) {
        aex.set("source", itemModel[0]->b.mdlPath);
        aex.set("skin", itemModel[0]->b.skin);
        if (!opt.name.empty())
            aex.set("name", opt.name);
        if (!shownWorld.empty())
            aex.set("pose", skel ? "the skeleton starts in the pose shown in the viewer" : "as shown in the viewer");
        if (anyAttached) { // (what the viewer showed on its nodes, as the game does)
            ujson::Value with = ujson::Value::array();
            for (size_t i = 0; i < attach.size(); ++i)
                if (attachModel[i])
                    with.push(attachModel[i]->b.mdlPath + " on " + attachOn(i));
            aex.set("shownWith", std::move(with));
        }
    } else {
        aex.set(custom.empty() && instanced.empty() ? "build" : "map", sceneName);
        aex.set("parts", static_cast<double>(items.size()));
    }
    if (!opt.gameVersion.empty())
        aex.set("gameVersion", "Crossout " + opt.gameVersion);
    for (const auto &[k, v] : extras.info)
        aex.set(k, v);
    asset.set("extras", std::move(aex));
    doc.set("asset", std::move(asset));
    ujson::Value used = ujson::Value::array();
    if (instancing)
        used.push("EXT_mesh_gpu_instancing");
    if (emissiveStrength)
        used.push("KHR_materials_emissive_strength");
    if (transmission)
        for (const char *e : {"KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_volume"})
            used.push(e);
    if (lights.size()) {
        used.push("KHR_lights_punctual");
        ujson::Value ext = ujson::Value::object(), kl = ujson::Value::object();
        kl.set("lights", std::move(lights));
        ext.set("KHR_lights_punctual", std::move(kl));
        doc.set("extensions", std::move(ext));
    }
    if (used.size()) // (not required: without them a reader shows one tuft of each grass kind, and no sun)
        doc.set("extensionsUsed", std::move(used));
    // One mesh per material (opt.splitMaterials): Cinema 4D's glTF import (2026) drops every mesh with
    // several primitives and normals (the part went missing). Each material's primitive becomes a mesh of
    // its own, drawn by a child of the node that drew them all (a skinned one's children keep its skin);
    // the first takes the old mesh's place, so no mesh is left unused. Instanced nodes stay as they are.
    if (opt.splitMaterials) {
        const size_t meshCount = meshes.size();
        std::vector<bool> keep(meshCount, false);
        for (const auto &n : nodes.items())
            if (const ujson::Value *m = n.find("mesh"); m && n.has("extensions"))
                keep[static_cast<size_t>(m->integer())] = true;
        std::vector<std::vector<std::pair<int, std::string>>> split(meshCount); // mesh -> its meshes, by material name
        for (size_t mi = 0; mi < meshCount; ++mi) {
            if (keep[mi] || meshes.items()[mi]["primitives"].size() < 2)
                continue;
            ujson::Value prims = std::move(*meshes.items()[mi].find("primitives"));
            const std::string base = meshes.items()[mi]["name"].str();
            for (size_t k = 0; k < prims.size(); ++k) {
                ujson::Value &p = prims.items()[k];
                const ujson::Value *mat = p.find("material");
                std::string matName = mat ? materials.items()[static_cast<size_t>(mat->integer())]["name"].str() : std::string();
                if (matName.empty())
                    matName = "part" + std::to_string(k);
                ujson::Value one = ujson::Value::object(), list = ujson::Value::array();
                one.set("name", meshNames.get(base + " (" + matName + ")"));
                list.push(std::move(p));
                one.set("primitives", std::move(list));
                if (k == 0) {
                    meshes.items()[mi] = std::move(one);
                    split[mi].push_back({static_cast<int>(mi), matName});
                } else {
                    meshes.push(std::move(one));
                    split[mi].push_back({static_cast<int>(meshes.size()) - 1, matName});
                }
            }
        }
        const size_t nodeCount = nodes.size();
        for (size_t ni = 0; ni < nodeCount; ++ni) {
            const ujson::Value *m = nodes.items()[ni].find("mesh");
            if (!m || split[static_cast<size_t>(m->integer())].empty())
                continue;
            const auto &parts = split[static_cast<size_t>(m->integer())];
            const ujson::Value *skin = nodes.items()[ni].find("skin");
            const ujson::Value skinIndex = skin ? *skin : ujson::Value();
            const std::string name = nodes.items()[ni]["name"].str();
            std::vector<int> kids;
            for (const auto &[meshIndex, matName] : parts) {
                ujson::Value child = ujson::Value::object();
                child.set("name", (name.empty() ? std::string("part") : name) + " (" + matName + ")");
                child.set("mesh", meshIndex);
                if (!skinIndex.isNull())
                    child.set("skin", skinIndex);
                nodes.push(std::move(child));
                kids.push_back(static_cast<int>(nodes.size()) - 1);
            }
            ujson::Value &parent = nodes.items()[ni]; // (after the pushes: the array may have moved)
            parent.erase("mesh");
            parent.erase("skin");
            ujson::Value *children = parent.find("children");
            if (!children)
                children = &parent.set("children", ujson::Value::array());
            for (int k : kids)
                children->push(k);
        }
    }
    doc.set("scene", 0);
    ujson::Value scene = ujson::Value::object(), sceneNodes = ujson::Value::array();
    scene.set("name", rootNodeName);
    sceneNodes.push(static_cast<double>(topNode));
    scene.set("nodes", std::move(sceneNodes));
    ujson::Value scenes = ujson::Value::array();
    scenes.push(std::move(scene));
    doc.set("scenes", std::move(scenes));
    doc.set("nodes", std::move(nodes));
    doc.set("meshes", std::move(meshes));
    if (skins.size())
        doc.set("skins", std::move(skins));
    if (animations.size())
        doc.set("animations", std::move(animations));
    if (materials.size())
        doc.set("materials", std::move(materials));
    if (textures.size()) {
        doc.set("textures", std::move(textures));
        doc.set("images", std::move(images));
        ujson::Value samplers = ujson::Value::array(), s = ujson::Value::object();
        s.set("magFilter", 9729);
        s.set("minFilter", 9987);
        s.set("wrapS", 10497);
        s.set("wrapT", 10497);
        samplers.push(std::move(s));
        doc.set("samplers", std::move(samplers));
    }
    doc.set("accessors", std::move(w.accessors));
    doc.set("bufferViews", std::move(w.views));
    w.pad();
    ujson::Value buffers = ujson::Value::array(), buf = ujson::Value::object();
    buf.set("byteLength", static_cast<double>(w.size()));
    if (!glb)
        buf.set("uri", stem + ".bin");
    buffers.push(std::move(buf));
    doc.set("buffers", std::move(buffers));

    std::vector<uint8_t> glbHead; // the .glb's header and JSON chunk; the binary chunk is written from w's pieces as they are
    std::string pretty;
    if (glb) {
        std::string json = doc.dump();
        while (json.size() % 4)
            json += ' ';
        const uint64_t total = 12ull + 8 + json.size() + 8 + w.size();
        if (total > 0xFFFFFFFFull)
            return fail("the export is larger than 4 GB; export fewer parts or turn textures off");
        std::vector<uint8_t> &out = glbHead;
        out.reserve(12 + 8 + json.size() + 8);
        auto u32 = [&](uint32_t v) { out.insert(out.end(), reinterpret_cast<uint8_t *>(&v), reinterpret_cast<uint8_t *>(&v) + 4); };
        u32(0x46546C67);
        u32(2);
        u32(static_cast<uint32_t>(total));
        u32(static_cast<uint32_t>(json.size()));
        u32(0x4E4F534A);
        out.insert(out.end(), json.begin(), json.end());
        u32(static_cast<uint32_t>(w.size()));
        u32(0x004E4942);
        files.push_back({outFile, out.data(), out.size(), w.pieces()});
        if (opt.extraMaps) // the extra maps are not referenced by the .glb: they go beside it
            for (const auto &img : tw.images)
                if (img.extra)
                    files.push_back({texDir / img.fileName, img.png.data(), img.png.size()});
    } else {
        pretty = doc.dump(2);
        files.push_back({outFile, pretty.data(), pretty.size()});
        files.push_back({dir / (stem + ".bin"), nullptr, 0, w.pieces()});
        for (const auto &img : tw.images)
            files.push_back({texDir / img.fileName, img.png.data(), img.png.size()});
    }
    return writeAll();
}

bool exportModel(const GameData &gd, const std::string &mdlPath, const std::filesystem::path &outFile, const ExportOptions &opt,
                 std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress) {
    SceneItem it;
    it.path = mdlPath;
    it.skin = opt.skin;
    it.paint = opt.paint;
    it.hasPaint = opt.hasPaint;
    for (int i = 0; i < 16; ++i)
        it.matrix[i] = (i % 5 == 0) ? 1.0f : 0.0f;
    return exportScene(gd, {it}, "", outFile, opt, written, warnings, err, progress);
}

} // namespace xo
