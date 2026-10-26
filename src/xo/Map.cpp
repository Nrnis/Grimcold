#include "xo/Map.h"

#include "xo/Archive.h"
#include "xo/Parallel.h"
#include "xo/Sky.h"
#include "xo/Texture.h"
#include "xo/Zstd.h"

#include <algorithm>
#include <array>
#include <bit>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <list>
#include <memory>
#include <optional>
#include <set>
#include <thread>
#include <tuple>
#include <unordered_map>

namespace xo {
namespace {

constexpr float kPi = 3.14159265358979f;

std::string_view textOf(const std::vector<uint8_t> &b) { return {reinterpret_cast<const char *>(b.data()), b.size()}; }

// name="value" inside one tag (the map files always write it that way); whole names only, so
// "Name" does not match "SkinName".
std::string_view attrOf(std::string_view tag, std::string_view name) {
    size_t p = 0;
    while ((p = tag.find(name, p)) != std::string_view::npos) {
        const bool boundary = p > 0 && (tag[p - 1] == ' ' || tag[p - 1] == '\t' || tag[p - 1] == '\n' || tag[p - 1] == '\r');
        const size_t q = p + name.size();
        if (boundary && q + 1 < tag.size() && tag[q] == '=' && tag[q + 1] == '"') {
            const size_t end = tag.find('"', q + 2);
            if (end != std::string_view::npos)
                return tag.substr(q + 2, end - q - 2);
        }
        p = q;
    }
    return {};
}

// Calls f(name, value) for every name="value" of one tag, in order.
template <class F> void forEachAttr(std::string_view tag, F &&f) {
    size_t p = 0;
    while ((p = tag.find("=\"", p)) != std::string_view::npos) {
        size_t s = p;
        while (s > 0 && tag[s - 1] != ' ' && tag[s - 1] != '\t' && tag[s - 1] != '\n' && tag[s - 1] != '\r')
            --s;
        const size_t end = tag.find('"', p + 2);
        if (end == std::string_view::npos)
            return;
        f(tag.substr(s, p - s), tag.substr(p + 2, end - p - 2));
        p = end + 1;
    }
}

// Calls f(tag) for every start tag <name ...> in text (the text of the tag without "<" and ">").
template <class F> void forEachTag(std::string_view text, std::string_view name, F &&f) {
    size_t p = 0;
    while ((p = text.find('<', p)) != std::string_view::npos) {
        ++p;
        if (text.compare(p, name.size(), name) != 0 || p + name.size() >= text.size()) // (the next character must end the name)
            continue;
        const char c = text[p + name.size()];
        if (c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '/' && c != '>')
            continue;
        const size_t end = text.find('>', p);
        if (end == std::string_view::npos)
            return;
        f(text.substr(p, end - p));
        p = end + 1;
    }
}

float hexFloat(std::string_view s) {
    uint32_t v = 0;
    std::from_chars(s.data(), s.data() + s.size(), v, 16);
    return std::bit_cast<float>(v);
}

// "40f6c1cd 4215ec8b c3de308f" -> up to n floats (IEEE bits in hex); returns how many were read.
int hexFloats(std::string_view s, float *out, int n) {
    int k = 0;
    size_t p = 0;
    while (k < n && p < s.size()) {
        while (p < s.size() && s[p] == ' ')
            ++p;
        size_t q = p;
        while (q < s.size() && s[q] != ' ')
            ++q;
        if (q > p)
            out[k++] = hexFloat(s.substr(p, q - p));
        p = q;
    }
    return k;
}

float numberOf(std::string_view s, float fallback) {
    float v = fallback;
    if (!s.empty())
        std::from_chars(s.data(), s.data() + s.size(), v);
    return v;
}

bool listHas(std::string_view list, std::string_view item) {
    size_t p = 0;
    while (p <= list.size()) {
        size_t q = list.find(';', p);
        if (q == std::string_view::npos)
            q = list.size();
        if (list.substr(p, q - p) == item)
            return true;
        p = q + 1;
    }
    return false;
}

std::string lower(std::string_view s) {
    std::string o(s);
    for (char &c : o)
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return o;
}

// ---- terrain tiles ("TDNL": u32 0, 8-byte hash, tilesX, tilesZ, 1, tileBytes; then per tile
// u64 offset, u64 size, u32 hash, u32 0; each tile one zstd frame) ----
bool readTiles(const GameData &gd, const std::string &path, int &tilesX, int &tilesZ, std::vector<std::vector<uint8_t>> &tiles, std::string *err) {
    std::vector<uint8_t> b;
    if (!gd.read(path, b, err))
        return false;
    auto fail = [&](const std::string &m) {
        if (err)
            *err = path + ": " + m;
        return false;
    };
    if (b.size() < 32 || std::memcmp(b.data(), "TDNL", 4) != 0)
        return fail("not a TDNL tile file");
    uint32_t h[4];
    std::memcpy(h, b.data() + 16, 16);
    tilesX = static_cast<int>(h[0]);
    tilesZ = static_cast<int>(h[1]);
    const uint32_t tileBytes = h[3];
    if (tilesX <= 0 || tilesZ <= 0 || tilesX > 4096 || tilesZ > 4096 || tileBytes == 0 || tileBytes > (64u << 20) ||
        32 + static_cast<size_t>(tilesX) * tilesZ * 24 > b.size())
        return fail("bad tile table");
    tiles.assign(static_cast<size_t>(tilesX) * tilesZ, {});
    for (size_t i = 0; i < tiles.size(); ++i) {
        uint64_t off, size;
        std::memcpy(&off, b.data() + 32 + i * 24, 8);
        std::memcpy(&size, b.data() + 40 + i * 24, 8);
        if (off > b.size() || size > b.size() - off)
            return fail("tile " + std::to_string(i) + " lies outside the file");
        const uint8_t *src = b.data() + off;
        if (size >= 4 && src[0] == 0x28 && src[1] == 0xB5 && src[2] == 0x2F && src[3] == 0xFD) {
            tiles[i].resize(tileBytes);
            std::string zerr;
            const size_t n = zstdDecompress(tiles[i].data(), tiles[i].size(), src, static_cast<size_t>(size), &zerr);
            if (n == SIZE_MAX)
                return fail("tile " + std::to_string(i) + ": " + zerr);
            tiles[i].resize(n);
        } else {
            tiles[i].assign(src, src + size);
        }
    }
    return true;
}

// assets/surfaces.mxml: the presets as terrain surfaces (all but presetId and standIn).
std::map<uint32_t, TerrainSurface> readSurfacePresets(const GameData &gd) {
    std::map<uint32_t, TerrainSurface> out;
    std::vector<uint8_t> b;
    if (!gd.read("assets/surfaces.mxml", b, nullptr))
        return out;
    const std::string_view t = textOf(b);
    size_t p = 0;
    while ((p = t.find("<Preset ", p)) != std::string_view::npos) {
        const size_t tagEnd = t.find('>', p);
        size_t end = t.find("</Preset>", p);
        if (tagEnd == std::string_view::npos || end == std::string_view::npos)
            break;
        const std::string_view tag = t.substr(p + 1, tagEnd - p - 1), body = t.substr(tagEnd, end - tagEnd);
        TerrainSurface s;
        s.name = std::string(attrOf(tag, "name"));
        auto value = [](std::string_view in, std::string_view param) -> std::string_view {
            const size_t q = in.find(std::string("<") + std::string(param) + " ");
            if (q == std::string_view::npos)
                return {};
            const size_t e = in.find('>', q);
            return attrOf(in.substr(q + 1, e - q - 1), "value");
        };
        // the preset's own settings come before its texture sets: the base set (the whole body when it
        // has none) and the detail ("Additional") set
        auto setOf = [&](std::string_view name) {
            const size_t q = body.find("<" + std::string(name));
            return q == std::string_view::npos ? std::string_view() : body.substr(q, body.find("</" + std::string(name) + ">", q) - q);
        };
        const std::string_view own = body.substr(0, body.find("<TextureSets")), extra = setOf("Additional");
        const std::string_view set = setOf("Base").empty() ? body : setOf("Base");
        s.albedo = normalizeGamePath(value(set, "Albedo"));
        s.normal = normalizeGamePath(value(set, "Bump"));
        s.gloss = normalizeGamePath(value(set, "Spec"));
        s.tiling = std::max(0.05f, numberOf(value(set, "Tiling"), 8));
        s.rotation = static_cast<int>(numberOf(value(set, "UVRotation"), 0)) & 3;
        s.flip = value(set, "UVFlip") == "true";
        s.heightMid = numberOf(value(set, "HeightMid"), 0.5f);
        s.heightAmp = numberOf(value(set, "HeightAmplitude"), 0);
        s.physMaterial = std::string(value(own, "PhysMaterial"));
        s.blendRoughness = std::max(0.0f, numberOf(value(own, "BlendRoughness"), 0));
        s.invertBlend = value(own, "InvertBlend") == "true";
        if (!extra.empty()) {
            SurfaceDetail &d = s.detail;
            d.albedo = normalizeGamePath(value(extra, "Albedo"));
            d.normal = normalizeGamePath(value(extra, "Bump"));
            d.gloss = normalizeGamePath(value(extra, "Spec"));
            d.tiling = std::max(0.05f, numberOf(value(extra, "Tiling"), 8));
            d.heightMid = numberOf(value(extra, "HeightMid"), 0.5f);
            d.rotation = static_cast<int>(numberOf(value(extra, "UVRotation"), 0)) & 3;
            d.flip = value(extra, "UVFlip") == "true";
            d.noiseTiling = std::max(0.05f, numberOf(value(own, "NoiseTiling"), 1));
            d.noiseIn[0] = numberOf(value(own, "NoiseInMin"), 0);
            d.noiseIn[1] = numberOf(value(own, "NoiseInMax"), 1);
            d.noiseOut[0] = numberOf(value(own, "NoiseOutMin"), 0);
            d.noiseOut[1] = numberOf(value(own, "NoiseOutMax"), 1);
        }
        uint32_t id = 0;
        const std::string_view ids = attrOf(tag, "id");
        std::from_chars(ids.data(), ids.data() + ids.size(), id);
        out[id] = std::move(s);
        p = end;
    }
    return out;
}

// Can its pixels be read (the header, and the .tfd when the big levels live there)?
bool textureReadable(const GameData &gd, const std::string &base) {
    std::vector<uint8_t> h;
    TextureInfo info;
    return gd.read(base + ".tfh", h, nullptr) && parseTfh(h, info, nullptr) && (!info.needsTfd || gd.find(base + ".tfd"));
}

// Is a gloss map's red (the height) one value all over? (Judged on a small level: four that maps use
// are 0 throughout: rock_top02, querry_main, white_sandy, asphalt_clear.)
bool heightFlat(const GameData &gd, const std::string &gloss) {
    Texture tex;
    if (!loadTextureHeader(gd, gloss, tex, nullptr))
        return false;
    int lv = static_cast<int>(tex.info.levels.size()) - 1;
    while (lv > tex.firstLevel() && std::max(tex.info.levels[lv - 1].width, tex.info.levels[lv - 1].height) <= 64)
        --lv;
    std::vector<uint8_t> px;
    uint32_t w, h;
    if (lv < tex.firstLevel() || !decodeLevel(tex, lv, px, w, h, nullptr))
        return false;
    uint8_t lo = 255, hi = 0;
    for (size_t i = 0; i < px.size(); i += 4) {
        lo = std::min(lo, px[i]);
        hi = std::max(hi, px[i]);
    }
    return hi - lo <= 2;
}

// A readable preset to stand in for one of the given PhysMaterial: plain fresh snow for snow (the
// others of its kind are snow over bare ground or ice), else the first readable preset of that kind.
const TerrainSurface *standInFor(const std::map<uint32_t, TerrainSurface> &presets, const GameData &gd, const std::string &phys) {
    const TerrainSurface *first = nullptr;
    for (const auto &[id, p] : presets) {
        if (phys.empty() || p.physMaterial != phys || p.albedo.empty() || !textureReadable(gd, p.albedo))
            continue;
        if (phys == "Snow_Base" && p.name == "snow/snow1")
            return &p;
        if (!first)
            first = &p;
    }
    return first;
}

bool loadTerrain(const GameData &gd, const std::string &dir, Terrain &t, std::vector<std::string> &warnings, std::string *err) {
    std::vector<uint8_t> b;
    if (!gd.read(dir + "landscape/landscape.mxml", b, err))
        return false;
    const std::string_view x = textOf(b);
    auto fail = [&](const std::string &m) {
        if (err)
            *err = dir + "landscape: " + m;
        return false;
    };
    std::string_view dims;
    forEachTag(x, "Dimensions", [&](std::string_view tag) { dims = tag; });
    const int sectorsX = static_cast<int>(numberOf(attrOf(dims, "SectorsX"), 0)), sectorsZ = static_cast<int>(numberOf(attrOf(dims, "SectorsZ"), 0));
    t.cellsX = sectorsX * 16;
    t.cellsZ = sectorsZ * 16;
    t.cellSize = numberOf(attrOf(dims, "CellSize"), 0);
    t.texelsPerCell = static_cast<int>(numberOf(attrOf(dims, "SurfaceMapTexelsPerCell"), 0));
    t.overVertices = attrOf(dims, "SurfaceMapOverVertices") == "true";
    t.minY = numberOf(attrOf(dims, "MinY"), 0);
    t.maxY = numberOf(attrOf(dims, "MaxY"), 0);
    if (t.cellsX <= 0 || t.cellsZ <= 0 || t.cellsX > 65536 || t.cellsZ > 65536 || !(t.cellSize > 0))
        return fail("bad dimensions");

    // heights
    int tx, tz;
    std::vector<std::vector<uint8_t>> tiles;
    if (!readTiles(gd, dir + "landscape/heightmap.dat", tx, tz, tiles, err))
        return false;
    const int sx = t.samplesX(), sz = t.samplesZ();
    t.height.assign(static_cast<size_t>(sx) * sz, 0.0f);
    // Crossout 2.41 (the remaster): 16-bit heights, each tile 2 x 2 sectors of 19 x 19 samples (a
    // sector's 17 x 17 vertices and a one-sample border), scaled by the sector's (base, range) from
    // heightmap16_decode.dat: height = base + value / 65535 * range.
    if (gd.find(dir + "landscape/heightmap16_decode.dat")) {
        std::vector<uint8_t> d;
        if (!gd.read(dir + "landscape/heightmap16_decode.dat", d, err))
            return false;
        uint32_t hd[7];
        if (d.size() < 28 || std::memcmp(d.data(), "61MH", 4) != 0)
            return fail("heightmap16_decode.dat: not an HM16 file");
        std::memcpy(hd, d.data(), 28);
        const int secX = static_cast<int>(hd[2]), secZ = static_cast<int>(hd[3]), block = static_cast<int>(hd[4]);
        if (secX != sectorsX || secZ != sectorsZ || block != 19 || hd[5] != static_cast<uint32_t>(secX) * secZ ||
            d.size() < 28 + static_cast<size_t>(hd[5]) * 8)
            return fail("heightmap16_decode.dat does not fit the terrain");
        if (tx * 2 != sectorsX || tz * 2 != sectorsZ)
            return fail("the height tiles do not match the size");
        for (int cz = 0; cz < tz; ++cz)
            for (int cx = 0; cx < tx; ++cx) {
                const std::vector<uint8_t> &tile = tiles[static_cast<size_t>(cz) * tx + cx];
                if (tile.size() != 38u * 38u * 2u)
                    return fail("height tile " + std::to_string(cx) + "," + std::to_string(cz) + " has the wrong size");
                for (int bz = 0; bz < 2; ++bz)
                    for (int bx = 0; bx < 2; ++bx) {
                        const int sxi = cx * 2 + bx, szi = cz * 2 + bz;
                        float pr[2];
                        std::memcpy(pr, d.data() + 28 + (static_cast<size_t>(szi) * secX + sxi) * 8, 8);
                        for (int r = 1; r <= 17; ++r)
                            for (int c = 1; c <= 17; ++c) {
                                uint16_t v;
                                std::memcpy(&v, tile.data() + (static_cast<size_t>(bz * 19 + r) * 38 + bx * 19 + c) * 2, 2);
                                const int vz = szi * 16 + r - 1, vx = sxi * 16 + c - 1;
                                if (vz < sz && vx < sx)
                                    t.height[static_cast<size_t>(vz) * sx + vx] = pr[0] + v / 65535.0f * pr[1];
                            }
                    }
            }
    } else if (tx != (sx + 31) / 32 || tz != (sz + 31) / 32) {
        return fail("the height tiles do not match the size");
    } else {
    for (int cz = 0; cz < tz; ++cz)
        for (int cx = 0; cx < tx; ++cx) {
            const std::vector<uint8_t> &tile = tiles[static_cast<size_t>(cz) * tx + cx];
            const int w = std::min(32, sx - cx * 32), h = std::min(32, sz - cz * 32);
            if (tile.size() != static_cast<size_t>(w) * h * 4)
                return fail("height tile " + std::to_string(cx) + "," + std::to_string(cz) + " has the wrong size");
            for (int r = 0; r < h; ++r)
                std::memcpy(&t.height[static_cast<size_t>(cz * 32 + r) * sx + cx * 32], tile.data() + static_cast<size_t>(r) * w * 4, static_cast<size_t>(w) * 4);
        }
    }

    // how the game draws it
    forEachTag(x, "Renderer", [&](std::string_view tag) {
        t.sliceSize = std::clamp(static_cast<int>(numberOf(attrOf(tag, "TextureArraySliceSize"), 2048)), 256, 4096);
        t.heightBlend = attrOf(tag, "LandscapeHeightBlendEnabled") != "false";
        t.blendNoise = normalizeGamePath(attrOf(tag, "BlendNoiseTexture"));
    });
    if (t.blendNoise.empty())
        t.blendNoise = "textures/landscape/splat_map_noise"; // (the only one there is: hangar_newyear names it, the rest leave it out)

    // surfaces
    const auto presets = readSurfacePresets(gd);
    forEachTag(x, "Surface", [&](std::string_view tag) {
        const int index = static_cast<int>(numberOf(attrOf(tag, "Index"), -1));
        uint32_t id = 0;
        const std::string_view ids = attrOf(tag, "PresetId");
        std::from_chars(ids.data(), ids.data() + ids.size(), id);
        if (index < 0 || index >= 32)
            return;
        if (t.surfaces.size() <= static_cast<size_t>(index))
            t.surfaces.resize(index + 1);
        TerrainSurface &s = t.surfaces[index];
        auto it = presets.find(id);
        if (it == presets.end()) {
            s.presetId = id;
            warnings.push_back("surface preset " + std::to_string(id) + " not found");
            return;
        }
        s = it->second;
        s.presetId = id;
        if (!s.detail.albedo.empty() && !textureReadable(gd, s.detail.albedo))
            s.detail = {};
        // Textures that sit in the encrypted packs (hangar_newyear's snow: mapskit/textures/snow/ is not
        // in the readable archives) borrow a readable preset's of the same kind, by its PhysMaterial.
        if (s.albedo.empty() || textureReadable(gd, s.albedo))
            return;
        const TerrainSurface *by = standInFor(presets, gd, s.physMaterial);
        warnings.push_back("surface " + s.name + ": " + s.albedo + " is not in the readable archives" +
                           (by ? ", shown with " + by->name + "'s textures" : std::string()));
        if (!by) {
            s.albedo = s.normal = s.gloss = {};
            return;
        }
        s.albedo = by->albedo;
        s.normal = by->normal;
        s.gloss = by->gloss;
        s.tiling = by->tiling;
        s.rotation = by->rotation;
        s.flip = by->flip;
        s.heightMid = by->heightMid;
        s.heightAmp = by->heightAmp;
        s.detail = by->detail;
        s.standIn = by->name;
    });
    for (TerrainSurface &s : t.surfaces)
        s.flatHeight = !s.gloss.empty() && heightFlat(gd, s.gloss);

    // 2.41: the surface map holds ecotopes, which <EcotopeToSurface> turns into surfaces (no table:
    // the numbers are the surfaces; 31 stays "none")
    uint8_t ecoToSurface[32];
    for (int k = 0; k < 32; ++k)
        ecoToSurface[k] = static_cast<uint8_t>(k);
    const size_t e0 = x.find("<EcotopeToSurface"), e1 = e0 == std::string_view::npos ? e0 : x.find("</EcotopeToSurface>", e0);
    const bool ecotopes = e0 != std::string_view::npos && e1 != std::string_view::npos;
    if (ecotopes) {
        for (int k = 0; k < 31; ++k)
            ecoToSurface[k] = 31; // (an ecotope the table leaves out shows nothing)
        forEachTag(x.substr(e0, e1 - e0), "Element", [&](std::string_view tag) {
            const int e = static_cast<int>(numberOf(attrOf(tag, "Ecotope"), -1)), s2 = static_cast<int>(numberOf(attrOf(tag, "Surface"), -1));
            if (e >= 0 && e < 31 && s2 >= 0 && s2 < 31)
                ecoToSurface[e] = static_cast<uint8_t>(s2);
        });
    }

    // surface map: indices + weights, (32 x texelsPerCell)^2 texels per tile
    if (t.texelsPerCell > 0 && !t.surfaces.empty()) {
        std::vector<std::vector<uint8_t>> idx, wt;
        int ix = 0, iz = 0, wx = 0, wz = 0;
        std::string e;
        const int T = 32 * t.texelsPerCell, TX = t.texelsX(), TZ = t.texelsZ();
        if (!readTiles(gd, dir + "landscape/splatmap.dat", ix, iz, idx, &e) || !readTiles(gd, dir + "landscape/weightmap.dat", wx, wz, wt, &e)) {
            warnings.push_back(e);
        } else if (ix * 32 != t.cellsX || iz * 32 != t.cellsZ || wx != ix || wz != iz) {
            warnings.push_back("the surface map tiles do not match the terrain size");
        } else {
            t.surfIndex.assign(static_cast<size_t>(TX) * TZ, 0);
            t.surfWeight.assign(static_cast<size_t>(TX) * TZ * 2, 255);
            std::vector<uint8_t> rgba;
            bool ok = true;
            for (int cz = 0; cz < iz && ok; ++cz)
                for (int cx = 0; cx < ix && ok; ++cx) {
                    const auto &it = idx[static_cast<size_t>(cz) * ix + cx];
                    const auto &wtile = wt[static_cast<size_t>(cz) * ix + cx];
                    if (it.size() != static_cast<size_t>(T) * T * 2 || !decodePixels(PixelFormat::BC5, wtile.data(), wtile.size(), T, T, rgba, &e)) {
                        ok = false;
                        break;
                    }
                    for (int r = 0; r < T; ++r) {
                        const size_t row = static_cast<size_t>(cz * T + r) * TX + cx * T;
                        std::memcpy(&t.surfIndex[row], it.data() + static_cast<size_t>(r) * T * 2, static_cast<size_t>(T) * 2);
                        if (ecotopes)
                            for (int c = 0; c < T; ++c) {
                                const uint16_t v = t.surfIndex[row + c];
                                uint16_t o = 0;
                                for (int l = 0; l < 3; ++l)
                                    o |= static_cast<uint16_t>(ecoToSurface[(v >> (5 * l)) & 31] << (5 * l));
                                t.surfIndex[row + c] = o;
                            }
                        // (2.41's weights, on the vertices, count the other way: slot 0 = 1 - r,
                        // slot 1 = r (1 - g), slot 2 = r g; flipped here into 2.40's rule)
                        const uint8_t flip = t.overVertices ? 255 : 0;
                        for (int c = 0; c < T; ++c) {
                            t.surfWeight[(row + c) * 2] = static_cast<uint8_t>(rgba[(static_cast<size_t>(r) * T + c) * 4] ^ flip);
                            t.surfWeight[(row + c) * 2 + 1] = static_cast<uint8_t>(rgba[(static_cast<size_t>(r) * T + c) * 4 + 1] ^ flip);
                        }
                    }
                }
            if (!ok) {
                warnings.push_back("the surface map could not be read" + (e.empty() ? std::string() : ": " + e));
                t.surfIndex.clear();
                t.surfWeight.clear();
            }
        }
    }
    return true;
}

// ---- entity definitions -> models ----
// Def names follow the model names: Breakable_Trees_Midland_SpruceSmall is
// assets/props/trees/midland/spruce/spruce_small.mdl, Breakable_Stone_midland_rocks01 is
// assets/props/rocks/breakable/midland/destructible_rocks_01.mdl, Breakable_Fence_eprail6 is
// assets/props/constructions/ep_rail6.mdl. Names are compared without separators and leading
// zeros; the intact destructible version (_de) is preferred over its broken pieces (_bp).
std::string squash(std::string_view s) {
    std::string o = lower(s);
    for (const char *suf : {"_destructible", "_de"})
        if (o.size() > std::strlen(suf) && o.compare(o.size() - std::strlen(suf), std::strlen(suf), suf) == 0)
            o.resize(o.size() - std::strlen(suf));
    if (o.rfind("destructible_", 0) == 0)
        o.erase(0, 13);
    std::string r;
    for (size_t i = 0; i < o.size(); ++i) {
        const char c = o[i];
        if (c == '_' || c == '-' || c == ' ')
            continue;
        if (c == '0' && (r.empty() || !std::isdigit(static_cast<unsigned char>(r.back()))) && i + 1 < o.size() && std::isdigit(static_cast<unsigned char>(o[i + 1])))
            continue; // leading zero
        r += c;
    }
    return r;
}

std::vector<std::string> defWords(std::string_view def) {
    std::vector<std::string> w;
    std::string cur;
    for (size_t i = 0; i < def.size(); ++i) {
        const char c = def[i];
        const bool split = c == '_' || (std::isupper(static_cast<unsigned char>(c)) && i > 0 && std::islower(static_cast<unsigned char>(def[i - 1])));
        if (split && !cur.empty()) {
            w.push_back(lower(cur));
            cur.clear();
        }
        if (c != '_')
            cur += c;
    }
    if (!cur.empty())
        w.push_back(lower(cur));
    return w;
}

int editDistance(const std::string &a, const std::string &b) {
    std::vector<int> d(b.size() + 1);
    for (size_t j = 0; j <= b.size(); ++j)
        d[j] = static_cast<int>(j);
    for (size_t i = 1; i <= a.size(); ++i) {
        int prev = d[0];
        d[0] = static_cast<int>(i);
        for (size_t j = 1; j <= b.size(); ++j) {
            const int cur = d[j];
            d[j] = std::min({d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] == b[j - 1] ? 0 : 1)});
            prev = cur;
        }
    }
    return d[b.size()];
}

std::string digitsOf(const std::string &s) {
    std::string d;
    for (char c : s)
        if (std::isdigit(static_cast<unsigned char>(c)))
            d += c;
    return d;
}

class EntityResolver {
  public:
    explicit EntityResolver(const GameData &gd) {
        for (const auto &e : gd.entries()) {
            const std::string &n = e.name;
            if (n.size() < 5 || n.compare(n.size() - 4, 4, ".mdl") != 0)
                continue;
            if (n.rfind("assets/props/", 0) != 0 && n.rfind("models/gameplay/", 0) != 0 && n.rfind("models/objects/", 0) != 0 &&
                n.rfind("models/environment/", 0) != 0 && n.rfind("models/misc/", 0) != 0)
                continue;
            const size_t slash = n.rfind('/');
            const std::string base = n.substr(slash + 1, n.size() - slash - 5);
            if (isPiece(base))
                continue;
            byKey_[squash(base)].push_back(n);
            // the name with its folders before it, one more at a time (folder_name, folder2_folder_name ...)
            std::string tail = base;
            for (size_t end = slash; end != std::string::npos && end > 0;) {
                const size_t start = n.rfind('/', end - 1);
                tail = n.substr(start == std::string::npos ? 0 : start + 1, end - (start == std::string::npos ? 0 : start + 1)) + "_" + tail;
                byPath_[squash(tail)].push_back(n);
                end = start;
            }
        }
    }

    std::string resolve(const std::string &def) {
        auto cached = cache_.find(def);
        if (cached != cache_.end())
            return cached->second;
        std::vector<std::string> segs;
        for (size_t p = 0; p <= def.size();) {
            size_t q = def.find('_', p);
            if (q == std::string::npos)
                q = def.size();
            if (q > p)
                segs.push_back(def.substr(p, q - p));
            p = q + 1;
        }
        std::string best;
        if (!segs.empty()) {
            std::vector<std::string> keys{squash(segs.back())};
            std::string mid = segs.back(); // WillowMed -> willow_mid
            for (const char *from : {"Med", "Medium"}) {
                const size_t at = mid.rfind(from);
                if (at != std::string::npos && at + std::strlen(from) == mid.size() && at > 0)
                    keys.push_back(squash(mid.substr(0, at) + "Mid"));
            }
            if (segs.size() >= 2)
                keys.push_back(squash(segs[segs.size() - 2] + segs.back()));
            std::vector<std::string> cands;
            for (const auto &k : keys)
                if (auto f = byKey_.find(k); f != byKey_.end())
                    cands.insert(cands.end(), f->second.begin(), f->second.end());
            if (cands.empty()) { // a one-letter slip in a long name (barrellight / barel_light)
                const std::string &k = keys.front();
                if (k.size() >= 8)
                    for (const auto &[key, paths] : byKey_)
                        if (key.size() + 1 >= k.size() && key.size() <= k.size() + 1 && digitsOf(key) == digitsOf(k) && editDistance(key, k) <= 1)
                            cands.insert(cands.end(), paths.begin(), paths.end());
            }
            // the model's path spelled out (Objects_Visitor_AssetsPropsConstructionsPipesPipe2L8m:
            // assets/props/constructions/pipes/pipe2_l_8m, Objects_HangarAziaMallBanner2:
            // hangar/hangar_azia/mall_banner_2): its folders and name, the last word or the last two
            for (size_t n = 1; n <= std::min<size_t>(2, segs.size()) && cands.empty(); ++n) {
                std::string tail;
                for (size_t i = segs.size() - n; i < segs.size(); ++i)
                    tail += segs[i];
                if (auto f = byPath_.find(squash(tail)); f != byPath_.end())
                    cands = f->second;
            }
            const std::vector<std::string> words = defWords(def);
            double bestScore = -1;
            for (const auto &c : cands) {
                double s = 0;
                for (const auto &w : words)
                    if (w.size() >= 3 && c.find(w) != std::string::npos)
                        s += 1;
                if (c.rfind("assets/props/", 0) == 0)
                    s += 0.5;
                if (c.size() > 7 && (c.compare(c.size() - 7, 7, "_de.mdl") == 0 || c.find("/destructible_") != std::string::npos))
                    s += 0.25;
                s -= c.size() * 0.001;
                if (s > bestScore) {
                    bestScore = s;
                    best = c;
                }
            }
        }
        cache_[def] = best;
        return best;
    }

  private:
    static bool isPiece(const std::string &base) {
        // broken pieces (_bp1), collision / LOD helpers
        auto ends = [&](const char *s) { return base.size() > std::strlen(s) && base.compare(base.size() - std::strlen(s), std::strlen(s), s) == 0; };
        size_t i = base.size();
        while (i > 0 && std::isdigit(static_cast<unsigned char>(base[i - 1])))
            --i;
        const std::string stem = base.substr(0, i);
        return (stem.size() > 3 && stem.compare(stem.size() - 3, 3, "_bp") == 0) || (stem.size() > 4 && stem.compare(stem.size() - 4, 4, "_lod") == 0) ||
               ends("_col") || ends("_collision") || ends("_invis");
    }
    std::unordered_map<std::string, std::vector<std::string>> byKey_;
    std::unordered_map<std::string, std::vector<std::string>> byPath_; // the names with one or more of their folders before them
    std::unordered_map<std::string, std::string> cache_;
};

// Definitions whose model has another name (the bridge pieces were checked by placing them: they
// meet the bridge's pillars; the rest differ from their files by an abbreviation or a typo and are
// the most placed of the definitions the name match misses), and the skin a definition gives its
// model (an entity's own Skin="@": the taxis' colours). The fences and walls among them were checked
// by their length against how far apart the maps lay them end to end (street_mfence1_6m: 6.1 m, the
// pieces 6.1 m apart), the rest by placing them: each stands where the map leaves room for it (a taxi
// in a parking bay, a bus stop on its paving, a pavilion over its benches, barrels in the corners of
// walls, a projector's lamp where Lights_Projector shines from). A definition with no model ("") is one
// the name match gets wrong, with nothing better to put there: it stays out, counted as unresolved.
struct KnownModel {
    const char *def, *model, *skin = "";
};
const KnownModel *knownEntity(std::string_view def) {
    static const KnownModel known[] = {
        {"Gameplay_Destroy_AnimatedBridge", "assets/props/buildings/bridges/bridge_falling_up_center.mdl"},
        {"Gameplay_Destroy_AnimatedBridgeLeft", "assets/props/buildings/bridges/bridge_falling_up_left.mdl"},
        {"Vegetation_Arizona_CreosoteSmall", "assets/props/trees/arizona/creosotebush/creosotebush_small.mdl"},
        {"Vegetation_Arizona_CreosoteTiny", "assets/props/trees/arizona/creosotebush/creosotebush_tiny.mdl"},
        {"Breakable_Stone_stalker_stonegroup1", "assets/props/rocks/breakable/stalker/stonegroup_stkr1.mdl"},
        {"Breakable_Stone_stalker_stonegroup2", "assets/props/rocks/breakable/stalker/stonegroup_stkr2.mdl"},
        {"Breakable_LifeItems_Barrel", "assets/props/life_items/barrels/barrel_de/barel_de.mdl"},
        {"Breakable_Tyres_Tyer", "assets/props/hangar/tyres_de/tyre_de.mdl"},
        {"Breakable_Tyres_Tyers2", "assets/props/hangar/tyres_de/tyres_2_de.mdl"},
        {"Breakable_Tyres_Tyers3", "assets/props/hangar/tyres_de/tyres_3_de.mdl"},
        {"Breakable_Tyres_TyersGroup1", "assets/props/hangar/tyres_de/tyres_group1_de.mdl"},
        {"Breakable_Tyres_TyersGroup2", "assets/props/hangar/tyres_de/tyres_group2_de.mdl"},
        {"Breakable_Fence_WoodSharpFence", "assets/props/constructions/wood_const/sharpfence_de/sharpfence_de.mdl"},
        {"Breakable_LifeItems_City_FenceMetal6m", "assets/props/road/street_objects/street_mfence1_6m.mdl"},
        {"Breakable_LifeItems_City_FenceMetal3m", "assets/props/road/street_objects/street_mfence1_3m.mdl"},
        {"Breakable_LifeItems_City_FenceMetalStolb", "assets/props/road/street_objects/street_mfence1_stolb.mdl"},
        {"Breakable_Fence_CityFenceTiled", "assets/props/life_items/cybereast/cityfence_simple_1_tiled.mdl"},
        {"Breakable_Fence_CityFenceEnd", "assets/props/life_items/cybereast/cityfence_simple_1_end.mdl"},
        {"Breakable_Fence_CityFencePrettyTiled", "assets/props/life_items/cybereast/cityfence_pretty_1_tiled.mdl"},
        {"Breakable_Fence_CityFencePrettyEnd", "assets/props/life_items/cybereast/cityfence_pretty_1_end.mdl"},
        {"Breakable_LifeItems_City_FenceWoodBr1", "assets/props/buildings/kiber/fences/fence_wood_br_3m.mdl"},
        {"Breakable_Fence_HangarMet2", "assets/props/hangar/hangar_light/hangar_met_y_de/fence_yel_break_2.mdl"},
        {"Breakable_Fence_MilitaryWall", "assets/props/military/militarywall_de/military_wall3_de.mdl"},
        {"Breakable_Fence_MilitaryWallBroken", "assets/props/military/militarywall_de/military_wall1_de.mdl"},
        {"Breakable_Fence_MilitaryWallBroken2", "assets/props/military/militarywall_de/military_wall2_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsRusty1", "assets/props/life_items/barrels/barrel_de/barrel_rusthls_gr1_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsRusty2", "assets/props/life_items/barrels/barrel_de/barrel_rusthls_gr2_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsAsidRusty1", "assets/props/life_items/barrels/barrel_de/barrelasid_rusthls_gr1_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsAsidRusty2", "assets/props/life_items/barrels/barrel_de/barrelasid_rusthls_gr2_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesCorner1", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_corner1_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesCorner2", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_corner2_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesCorner3", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_corner3_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesCorner4", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_corner4_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesGroup1", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_group1_de.mdl"},
        {"Breakable_LifeItems_Barrels_BarrelsBoxesGroup2", "models/gameplay/loot/fuel_loot/fuel_loot_de/barrelswoodbox_group2_de.mdl"},
        {"Breakable_LifeItems_Boxes_NomadBoxesGroup1", "assets/props/settlement/nomads/nomad_boxes_de/nomad_boxes1_de.mdl"},
        {"Breakable_LifeItems_Boxes_NomadBoxesGroup2", "assets/props/settlement/nomads/nomad_boxes_de/nomad_boxes2_de.mdl"},
        {"Breakable_Wood_WoodBalcony", "assets/props/constructions/wood_const/wd_balkony_de/wd_balkony_de.mdl"},
        {"Breakable_Wood_WdStoika01", "assets/props/constructions/wood_const/wd_stoika_de/wd_stoika.mdl"},
        {"Breakable_LifeItems_Knights_Spikes", "assets/props/settlement/knights/spiked_de.mdl"},
        {"Breakable_LifeItems_City_Vending1", "assets/props/life_items/cybereast/city_rect_vending_1.mdl"},
        {"Breakable_LifeItems_City_Vending2", "assets/props/life_items/cybereast/city_rect_vending_2.mdl"},
        {"Breakable_LifeItems_City_Vending3", "assets/props/life_items/cybereast/city_rect_vending_3.mdl"},
        {"Breakable_LifeItems_City_Infobox1", "assets/props/life_items/cybereast/city_rect_infobox_1.mdl"},
        {"Breakable_LifeItems_City_Infobox2", "assets/props/life_items/cybereast/city_rect_infobox_2.mdl"},
        {"Breakable_LifeItems_City_Hydrant", "assets/props/life_items/cybereast/fire_hydrant.mdl"},
        {"Breakable_LifeItems_City_Alcove", "assets/props/life_items/cybereast/park/alcove_1.mdl"},
        {"Breakable_LifeItems_City_BusStop", "assets/props/life_items/cybereast/city_bus_stop_fine.mdl"},
        {"Breakable_LifeItems_City_Market1", "assets/props/life_items/cybereast/street_market_de.mdl"},
        {"Objects_Light_Projector1", "assets/props/settlement/lunatics/projector_de/projector_de.mdl"},
        {"Breakable_Vehicle_City_TaxiEast", "assets/props/vehicles/taxi_east/breakable/taxi_east_full.mdl"},
        {"Breakable_Vehicle_City_TaxiEastRed", "assets/props/vehicles/taxi_east/breakable/taxi_east_full.mdl", "red"},
        {"Breakable_Vehicle_City_TaxiEastGreen", "assets/props/vehicles/taxi_east/breakable/taxi_east_full.mdl", "green"},
        {"Breakable_Vehicle_City_TaxiEastBlue", "assets/props/vehicles/taxi_east/breakable/taxi_east_full.mdl", "blue"},
        {"Breakable_Vehicle_City_TaxiEastBroken", "assets/props/vehicles/taxi_east/breakable/taxi_east_partial.mdl"},
        {"Breakable_Vehicle_City_TaxiEastBrokenRed", "assets/props/vehicles/taxi_east/breakable/taxi_east_partial.mdl", "red"},
        {"Breakable_Vehicle_City_TaxiEastBrokenGreen", "assets/props/vehicles/taxi_east/breakable/taxi_east_partial.mdl", "green"},
        {"Breakable_Vehicle_City_TaxiEastBrokenBlue", "assets/props/vehicles/taxi_east/breakable/taxi_east_partial.mdl", "blue"},
        {"Breakable_Vehicle_City_TaxiEastWreck1", "assets/props/vehicles/taxi_east/breakable/taxi_wall_part_1.mdl"},
        {"Breakable_Vehicle_City_TaxiEastWreck2", "assets/props/vehicles/taxi_east/breakable/taxi_wall_part_2.mdl"},
        {"Breakable_Vehicle_City_TaxiEastWreck3", "assets/props/vehicles/taxi_east/breakable/taxi_wall_part_3.mdl"},
        {"Breakable_Vehicle_City_TaxiEastWreck4", "assets/props/vehicles/taxi_east/breakable/taxi_wall_part_4.mdl"},
        // The name match put buildings where the game's light-probe pictures show none. City_Parking
        // matched the multi-storey garage buildings/kiber/parking/parking.mdl (144 x 47 x 141 m) by its
        // last word; the maps name its placements after their model, city_rect_parking_1 (.1, .2 ...)
        // on 6 of its 7 maps, a 2.2 m post like the City_Vending / Infobox ones above. No capture of
        // cityruin (all six weathers) shows a garage at its 4 placements (old houses there, 200-280 m
        // from the probe), nor do hangar_china's and hangar_asia's (open street 97-184 m away).
        {"Breakable_LifeItems_City_Parking", "assets/props/life_items/cybereast/city_rect_parking_1.mdl"},
        // BricksWall2 matched factory/brick_wall2 (a 45 m long, 6.4 m high wall) as a one-letter slip;
        // castle's capture shows open field where two of its placements stand 150-175 m from the probe
        // (it would span 15 degrees), and BricksWall1, laid back to back with it among the ruins'
        // household debris, matches nothing. Garbage_Column matched the 50 m monorail pillar
        // buildings/monorails/column.mdl (38 placements, tilted up to 90 degrees: fallen ones); the_wall's
        // capture shows nothing where the app leant one across the view 54 m from the probe.
        {"Breakable_LifeItems_BricksWall2", ""},
        {"Breakable_Garbage_Column", ""},
    };
    for (const auto &k : known)
        if (def == k.def)
            return &k;
    return nullptr;
}

// Definitions that have no visible model of their own (helpers, gameplay logic, sounds, decals,
// effects, lights; the lamps lights shine from, Objects_Light_*, are models).
bool invisibleDef(std::string_view def) {
    for (const char *p : {"NewDecal", "Decal_", "Helpers_", "Clip", "Gameplay_", "Sound_", "EffectEntity", "EffectZone", "Lights_", "Logic_",
                          "CameraEntity", "BaseEntity", "Spline", "Trigger", "DroneBattle_Jumpad"})
        if (def.rfind(p, 0) == 0)
            return true;
    return false;
}

// "R G B" (0..255; "White" and "Black" by name) -> out; false (out untouched) when it is neither.
bool rgbOf(std::string_view s, uint8_t out[3]) {
    if (s == "White" || s == "Black") {
        std::memset(out, s == "White" ? 255 : 0, 3);
        return true;
    }
    int v[3]{}, k = 0;
    for (size_t p = 0; p < s.size() && k < 3;) {
        size_t q = s.find(' ', p);
        if (q == std::string_view::npos)
            q = s.size();
        if (q > p && std::from_chars(s.data() + p, s.data() + q, v[k]).ec == std::errc())
            ++k;
        p = q + 1;
    }
    if (k < 3)
        return false;
    for (int c = 0; c < 3; ++c)
        out[c] = static_cast<uint8_t>(std::clamp(v[c], 0, 255));
    return true;
}

// A Lights_ entity as a MapLight; false for what shows nothing here: lights switched off, the storms'
// lightning (flashes the game sets off) and the directional lights (Lights_DirectionalLight: light
// through a mask, in a box).
bool lightOf(std::string_view def, std::string_view tag, MapLight &l) {
    if (attrOf(tag, "isTurnedOn") == "0" || attrOf(tag, "start_disabled") == "1" || def.find("Lightning") != std::string_view::npos)
        return false;
    if (!attrOf(tag, "fovX").empty())
        l.kind = MapLight::Projector;
    else if (!attrOf(tag, "vis_angle").empty())
        l.kind = MapLight::Flare;
    else if (!attrOf(tag, "width").empty())
        l.kind = MapLight::Beam;
    else if (!attrOf(tag, "rad").empty())
        l.kind = MapLight::Point;
    else
        return false;
    hexFloats(attrOf(tag, "PosHex"), l.pos, 3);
    hexFloats(attrOf(tag, "YPRHex"), l.ypr, 3);
    rgbOf(attrOf(tag, "color"), l.color);
    l.power = std::max(0.0f, numberOf(attrOf(tag, "power"), 1));
    l.radius = std::max(0.01f, numberOf(attrOf(tag, "rad"), 1));
    l.fov[0] = std::clamp(numberOf(attrOf(tag, "fovX"), 30), 1.0f, 179.0f);
    l.fov[1] = std::clamp(numberOf(attrOf(tag, "fovY"), 30), 1.0f, 179.0f);
    l.farClip = std::max(0.01f, numberOf(attrOf(tag, "farClipPlane"), 10));
    l.nearClip = std::clamp(numberOf(attrOf(tag, "nearClipPlane"), 0), 0.0f, l.farClip * 0.5f);
    l.linearFalloff = attrOf(tag, "linearFalloff") == "1";
    l.shadows = attrOf(tag, "shadowsEnabled") == "1" || attrOf(tag, "enableSSCS") == "1";
    l.specular = attrOf(tag, "specularEnabled") != "0";
    l.luminance = numberOf(attrOf(tag, "luminanceEv100"), 0);
    l.size = std::max(0.01f, numberOf(attrOf(tag, "size"), 1));
    l.width = std::max(0.01f, numberOf(attrOf(tag, "width"), 1));
    l.nebulosity = std::clamp(numberOf(attrOf(tag, "nebulosity"), 0), 0.0f, 1.0f);
    l.visAngle = std::clamp(numberOf(attrOf(tag, "vis_angle"), 90), 1.0f, 360.0f);
    l.flicker = def.find("Flicker") != std::string_view::npos || !attrOf(tag, "flicker").empty();
    return true;
}

bool isTreeDef(std::string_view def) { return def.rfind("Vegetation_", 0) == 0 || def.rfind("Breakable_Trees_", 0) == 0; }

// Liquid surfaces: water (rivers, lakes, the sea) and acid (pools, a burning river), drawn by the
// same shader from the same settings.
bool isWaterDef(std::string_view def) { return def == "Helpers_WaterVolume" || def == "Helpers_AcidVolume"; }

// Where players start (MapSpawn): the teams' spots, and the free-for-all and race starts.
bool isSpawnDef(std::string_view def) {
    return def.rfind("Gameplay_SpawnSpotTeam", 0) == 0 || def == "Gameplay_PlayerSpawnSpotStartOnly" || def == "Gameplay_PlayerInitialSpawnSpot" ||
           def == "Gameplay_SpawnSpotRaceStart";
}

void rotationYPR(const float yprDeg[3], float r[9]) {
    // R = Rz(roll) Rx(pitch) Ry(yaw) (column vectors, game space): yaw first, then pitch and roll
    // about the world axes. Checked on the maps: trees standing on rocks sit on the rock surface
    // only with this order and these signs.
    const float y = yprDeg[0] * kPi / 180, p = yprDeg[1] * kPi / 180, ro = yprDeg[2] * kPi / 180;
    const float cy = std::cos(y), sy = std::sin(y), cp = std::cos(p), sp = std::sin(p), cr = std::cos(ro), sr = std::sin(ro);
    const float Ry[9] = {cy, 0, sy, 0, 1, 0, -sy, 0, cy};
    const float Rx[9] = {1, 0, 0, 0, cp, -sp, 0, sp, cp};
    const float Rz[9] = {cr, -sr, 0, sr, cr, 0, 0, 0, 1};
    auto mul = [](const float *a, const float *b, float *c) {
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j)
                c[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    };
    float t[9];
    mul(Rx, Ry, t);
    mul(Rz, t, r);
}

// Is (x, z) inside an outline? (even-odd)
bool insideOutline(const std::vector<std::array<float, 2>> &o, float x, float z) {
    bool in = false;
    for (size_t i = 0, j = o.size() - 1; i < o.size(); j = i++)
        if ((o[i][1] > z) != (o[j][1] > z) && x < (o[j][0] - o[i][0]) * (z - o[i][1]) / (o[j][1] - o[i][1]) + o[i][0])
            in = !in;
    return in;
}

// The water's look as the view draws it (ui/water.js TILE, WAVES, RIPPLES, ROUGH, BODY): the metres one
// repeat of its wave maps covers at tiling 1, the slope of its wave frames and of its detail maps per
// unit of bump height, its roughness, and the light it scatters against a plain surface of its colour.
constexpr float kWaterTile = 8, kWaves = 0.6f, kRipples = 0.3f, kWaterRoughness = 0.1f, kWaterBody = 0.74f;

// Ear clipping of a simple polygon (x, z). Returns triangle index triples, counter-clockwise in (x, z).
std::vector<uint32_t> triangulate(const std::vector<std::array<float, 2>> &pts) {
    std::vector<uint32_t> out;
    const size_t n = pts.size();
    if (n < 3)
        return out;
    double area = 0;
    for (size_t i = 0; i < n; ++i) {
        const auto &a = pts[i], &b = pts[(i + 1) % n];
        area += static_cast<double>(a[0]) * b[1] - static_cast<double>(b[0]) * a[1];
    }
    std::vector<uint32_t> v(n);
    for (size_t i = 0; i < n; ++i)
        v[i] = static_cast<uint32_t>(area > 0 ? i : n - 1 - i); // make it counter-clockwise
    auto cross = [&](uint32_t a, uint32_t b, uint32_t c) {
        return (static_cast<double>(pts[b][0]) - pts[a][0]) * (static_cast<double>(pts[c][1]) - pts[a][1]) -
               (static_cast<double>(pts[b][1]) - pts[a][1]) * (static_cast<double>(pts[c][0]) - pts[a][0]);
    };
    auto inside = [&](uint32_t p, uint32_t a, uint32_t b, uint32_t c) {
        return cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
    };
    size_t guard = 0;
    while (v.size() > 3 && guard++ < n * n) {
        bool clipped = false;
        for (size_t i = 0; i < v.size(); ++i) {
            const uint32_t a = v[(i + v.size() - 1) % v.size()], b = v[i], c = v[(i + 1) % v.size()];
            if (cross(a, b, c) <= 0)
                continue; // reflex
            bool empty = true;
            for (uint32_t p : v)
                if (p != a && p != b && p != c && inside(p, a, b, c)) {
                    empty = false;
                    break;
                }
            if (!empty)
                continue;
            out.insert(out.end(), {a, b, c});
            v.erase(v.begin() + static_cast<std::ptrdiff_t>(i));
            clipped = true;
            break;
        }
        if (!clipped) { // not simple: fan out the rest
            for (size_t i = 1; i + 1 < v.size(); ++i)
                out.insert(out.end(), {v[0], v[i], v[i + 1]});
            return out;
        }
    }
    if (v.size() == 3)
        out.insert(out.end(), {v[0], v[1], v[2]});
    return out;
}

float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
float linearToSrgb(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1 / 2.4f) - 0.055f; }

} // namespace

float Terrain::heightAt(float x, float z) const {
    if (height.empty())
        return 0;
    const float gx = std::clamp((x - x0()) / cellSize, 0.0f, static_cast<float>(cellsX)), gz = std::clamp((z - z0()) / cellSize, 0.0f, static_cast<float>(cellsZ));
    const int i = std::min(static_cast<int>(gx), cellsX - 1), j = std::min(static_cast<int>(gz), cellsZ - 1);
    const float fx = gx - i, fz = gz - j;
    const int sx = samplesX();
    auto H = [&](int a, int b) { return height[static_cast<size_t>(b) * sx + a]; };
    return (H(i, j) * (1 - fx) + H(i + 1, j) * fx) * (1 - fz) + (H(i, j + 1) * (1 - fx) + H(i + 1, j + 1) * fx) * fz;
}

std::vector<std::string> listMaps(const GameData &gd) {
    std::set<std::string> names;
    const std::string pre = "levels/maps/";
    for (const auto &e : gd.entries()) {
        if (e.name.compare(0, pre.size(), pre) != 0)
            continue;
        const size_t slash = e.name.find('/', pre.size());
        if (slash == std::string::npos)
            continue;
        const std::string_view rest = std::string_view(e.name).substr(slash + 1);
        if (rest == "props.mxml" || rest == "scene.mxml" || rest == "landscape/landscape.mxml")
            names.insert(e.name.substr(pre.size(), slash - pre.size()));
    }
    return {names.begin(), names.end()};
}

std::vector<MapSummary> listMapSummaries(const GameData &gd) {
    std::vector<MapSummary> out;
    // the game's own minimaps (one or more per map; the first by name), shown for maps that have no
    // loading picture (arenas, hangars, event maps)
    std::map<std::string, std::string> hudmaps;
    {
        const std::string pre = "levels/maps/";
        for (const auto &e : gd.entries()) {
            if (e.name.size() < pre.size() + 5 || e.name.compare(0, pre.size(), pre) != 0 || e.name.compare(e.name.size() - 4, 4, ".tfh") != 0)
                continue;
            const size_t slash = e.name.find('/', pre.size());
            if (slash == std::string::npos || e.name.compare(slash + 1, 15, "hudmaps/hudmap_") != 0)
                continue;
            std::string base = e.name.substr(0, e.name.size() - 4);
            auto [it, added] = hudmaps.emplace(e.name.substr(pre.size(), slash - pre.size()), base);
            if (!added && base < it->second)
                it->second = std::move(base);
        }
    }
    for (const auto &name : listMaps(gd)) {
        MapSummary s;
        s.name = name;
        const std::string dir = "levels/maps/" + name + "/";
        std::vector<uint8_t> b;
        if (gd.find(dir + "landscape/landscape.mxml") && gd.read(dir + "landscape/landscape.mxml", b, nullptr)) {
            forEachTag(textOf(b), "Dimensions", [&](std::string_view tag) {
                const float cell = numberOf(attrOf(tag, "CellSize"), 0);
                s.sizeX = numberOf(attrOf(tag, "SectorsX"), 0) * 16 * cell;
                s.sizeZ = numberOf(attrOf(tag, "SectorsZ"), 0) * 16 * cell;
            });
            s.terrain = s.sizeX > 0 && s.sizeZ > 0;
        }
        const std::string pic = "ui/textures/levels/level_" + name;
        if (gd.find(pic + ".tfh"))
            s.picture = pic;
        if (auto h = hudmaps.find(name); h != hudmaps.end())
            s.hudmap = h->second;
        out.push_back(std::move(s));
    }
    return out;
}

std::string resolveEntityModel(const GameData &gd, const std::string &def) {
    EntityResolver r(gd);
    return r.resolve(def);
}

void mapObjectMatrix(const MapObject &o, float out[16]) {
    float r[9];
    rotationYPR(o.ypr, r);
    // game: world = R * S * local + T; glTF = F (that) F with F = diag(1, 1, -1)
    const float f[3] = {1, 1, -1};
    for (int c = 0; c < 3; ++c) {
        for (int row = 0; row < 3; ++row)
            out[c * 4 + row] = r[row * 3 + c] * o.scale[c] * f[row] * f[c];
        out[c * 4 + 3] = 0;
    }
    out[12] = o.pos[0];
    out[13] = o.pos[1];
    out[14] = -o.pos[2];
    out[15] = 1;
}

bool loadMap(const GameData &gd, const std::string &name, const MapFilter &filter, MapScene &scene, std::string *err) {
    scene = MapScene{};
    scene.name = name;
    const std::string dir = "levels/maps/" + normalizeGamePath(name) + "/";
    const bool hasLandscape = gd.find(dir + "landscape/landscape.mxml") != nullptr;
    if (!hasLandscape && !gd.find(dir + "props.mxml") && !gd.find(dir + "scene.mxml")) {
        if (err)
            *err = "no map named " + name;
        return false;
    }
    if (hasLandscape) {
        std::string e;
        if (loadTerrain(gd, dir, scene.terrain, scene.warnings, &e))
            scene.hasTerrain = true;
        else
            scene.warnings.push_back(e);
    }
    std::vector<uint8_t> b;
    // the map's settings (Crossout 2.41): the flow map its rivers' currents come from
    if (gd.read(dir + "settings.mxml", b, nullptr))
        forEachTag(textOf(b), "Water", [&](std::string_view tag) { scene.waterFlowMap = normalizeGamePath(attrOf(tag, "FlowMapTexture")); });

    // props.mxml, then props_generated.mxml: what the map editor's generators placed (forests on the hills,
    // desert plants, a space station's wall plates, road curbs: 207,772 on 72 maps). The game reads both
    // (Crossout.exe names props_generated.mxml beside props.mxml). Ids: the top byte 0 for props.mxml, 3
    // for the generated ones (1 and 2 are the scene files'), the low 24 bits the place in the file.
    for (const auto &[file, top] : {std::pair{"props.mxml", 0u}, std::pair{"props_generated.mxml", 3u}}) {
        if (!filter.props || !gd.read(dir + file, b, nullptr))
            continue;
        uint32_t place = 0; // (every instance counts, so ids do not depend on what is left out)
        forEachTag(textOf(b), "instance", [&, top = top](std::string_view tag) {
            const uint32_t uid = top << 24 | (place++ & 0xFFFFFF);
            const std::string_view n = attrOf(tag, "Name");
            if (n.empty())
                return;
            MapObject o;
            o.uid = uid;
            o.name = std::string(n);
            o.model = "assets/props/" + normalizeGamePath(n) + ".mdl";
            o.skin = std::string(attrOf(tag, "SkinName"));
            o.group = o.name.rfind("trees/", 0) == 0 ? "trees" : "props";
            if (o.group == "trees" && !filter.trees)
                return;
            hexFloats(attrOf(tag, "PosHex"), o.pos, 3);
            hexFloats(attrOf(tag, "YPRHex"), o.ypr, 3);
            hexFloats(attrOf(tag, "ScaleHex"), o.scale, 3);
            scene.objects.push_back(std::move(o));
        });
    }

    // the modes and festivals that change what is shown (lists on invisible helpers change nothing),
    // and the mode "auto" stands for
    std::vector<std::vector<uint8_t>> sceneFiles;
    std::vector<uint32_t> sceneSource; // (1 scene.mxml, 2 scene_generated.mxml: the top byte of their objects' ids)
    for (const char *file : {"scene.mxml", "scene_generated.mxml"})
        if (gd.read(dir + file, b, nullptr)) {
            sceneFiles.push_back(std::move(b));
            sceneSource.push_back(std::string_view(file) == "scene.mxml" ? 1u : 2u);
        }
    for (const auto &f : sceneFiles)
        forEachTag(textOf(f), "Entity", [&](std::string_view tag) {
            const std::string_view def = attrOf(tag, "Def");
            if (def.empty() || (!isSpawnDef(def) && !isWaterDef(def) && def != "NewDecal" && !knownEntity(def) && invisibleDef(def)))
                return;
            for (const auto &[attr, set] : {std::pair{"GameplaysList", &scene.gameplays}, std::pair{"FestivalsList", &scene.festivals}}) {
                const std::string_view list = attrOf(tag, attr);
                if (set == &scene.festivals && listHas(list, "Empty"))
                    continue; // (there every day too: only festival-only decorations make a festival look different)
                for (size_t p = 0; p < list.size();) {
                    size_t q = list.find(';', p);
                    if (q == std::string_view::npos)
                        q = list.size();
                    if (q > p)
                        set->insert(std::string(list.substr(p, q - p)));
                    p = q + 1;
                }
            }
        });
    scene.gameplay = filter.gameplay;
    if (scene.gameplay == "auto") {
        scene.gameplay.clear();
        for (const char *m : {"Assault", "Domination", "Conquer", "TeamDeathmatch", "Deathmatch", "TeamPvp", "FreeForAll", "Race", "FreePlay"})
            if (scene.gameplay.empty() && scene.gameplays.count(m))
                scene.gameplay = m;
        if (scene.gameplay.empty() && !scene.gameplays.empty())
            scene.gameplay = *scene.gameplays.begin();
    }
    const std::string &gameplay = scene.gameplay;

    // the environment (weather, time of day): the one the filter names when the map has it, else the
    // festival's own when it has one (its decorations are limited to it), else the first one the map
    // uses outside festivals; one made for the mode if there is one. Every one of them is listed
    // (scene.environments: the view offers them).
    if (gd.read(dir + "envsettings.mxml", b, nullptr)) {
        const bool festive = !filter.festival.empty() && filter.festival != "Empty";
        std::string pick[4]; // festival-only + mode, festival + mode, everyday + mode, everyday
        forEachTag(textOf(b), "Item", [&](std::string_view tag) {
            const std::string_view fest = attrOf(tag, "Festivals"), games = attrOf(tag, "Gameplays");
            const std::string id(attrOf(tag, "Id"));
            const bool modeOk = gameplay.empty() || games.empty() || listHas(games, gameplay);
            const bool everyday = fest.empty() || listHas(fest, "Empty");
            MapEnvChoice c;
            c.id = id;
            c.name = std::string(attrOf(tag, "Name"));
            c.modeOk = modeOk;
            for (size_t p = 0; p < fest.size();) {
                size_t q = fest.find(';', p);
                if (q == std::string_view::npos)
                    q = fest.size();
                if (q > p)
                    c.festivals.emplace_back(fest.substr(p, q - p));
                p = q + 1;
            }
            if (!id.empty())
                scene.environments.push_back(std::move(c));
            if (festive && listHas(fest, filter.festival) && modeOk) {
                if (pick[0].empty() && !everyday)
                    pick[0] = id;
                if (pick[1].empty())
                    pick[1] = id;
            }
            if (everyday && modeOk && pick[2].empty())
                pick[2] = id;
            if (everyday && pick[3].empty())
                pick[3] = id;
        });
        for (const auto &c : scene.environments)
            if (c.id == filter.environment)
                scene.environment = c.id;
        for (const auto &id : pick)
            if (scene.environment.empty() && !id.empty())
                scene.environment = id;
    }
    if (scene.environment.empty())
        scene.environment = filter.environment;

    std::vector<std::string> zoneTags; // (the sound zones' tags that name the environment)
    if (filter.entities || filter.water || filter.trees || filter.decals) {
        EntityResolver resolver(gd);
        for (size_t fi = 0; fi < sceneFiles.size(); ++fi) {
            const auto &f = sceneFiles[fi];
            uint32_t place = 0; // (every entity counts, so ids do not depend on what is left out)
            forEachTag(textOf(f), "Entity", [&](std::string_view tag) {
                const uint32_t uid = sceneSource[fi] << 24 | (place++ & 0xFFFFFF);
                const std::string def(attrOf(tag, "Def"));
                const bool water = isWaterDef(def);
                const KnownModel *known = knownEntity(def);
                // where players start (filtered like everything else: spots differ per mode)
                const bool spawn = isSpawnDef(def);
                if (spawn) {
                    const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                    if ((!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                        (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)) ||
                        (!scene.environment.empty() && !envs.empty() && !listHas(envs, scene.environment)))
                        return;
                    MapSpawn sp;
                    sp.def = def;
                    sp.team = def == "Gameplay_SpawnSpotTeam1" ? 1 : def == "Gameplay_SpawnSpotTeam2" ? 2 : 0;
                    hexFloats(attrOf(tag, "PosHex"), sp.pos, 3);
                    float ypr[3]{};
                    hexFloats(attrOf(tag, "YPRHex"), ypr, 3);
                    sp.yaw = ypr[0];
                    scene.spawns.push_back(sp);
                    return;
                }
                if (def == "NewDecal") { // projected decals (buildDecalMeshes puts them on what they lie on)
                    const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                    if (!filter.decals || (!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                        (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)) ||
                        (!scene.environment.empty() && !envs.empty() && !listHas(envs, scene.environment)))
                        return;
                    MapDecal d;
                    d.name = std::string(attrOf(tag, "Name"));
                    const std::string_view pid = attrOf(tag, "decalPresetId");
                    std::from_chars(pid.data(), pid.data() + pid.size(), d.preset);
                    hexFloats(attrOf(tag, "PosHex"), d.pos, 3);
                    hexFloats(attrOf(tag, "YPRHex"), d.ypr, 3);
                    hexFloats(attrOf(tag, "ScaleHex"), d.scale, 3);
                    d.opacity = numberOf(attrOf(tag, "opacity"), 1);
                    d.sharpness = numberOf(attrOf(tag, "sharpness"), 0.5f);
                    d.height = numberOf(attrOf(tag, "height"), 1);
                    d.customColor = attrOf(tag, "useCustomUniformAlbedo") == "1";
                    const std::string_view col = attrOf(tag, "customUniformAlbedo");
                    for (size_t p = 0, k = 0; p < col.size() && k < 3;) {
                        size_t q = col.find(' ', p);
                        if (q == std::string_view::npos)
                            q = col.size();
                        int v = 255;
                        std::from_chars(col.data() + p, col.data() + q, v);
                        d.color[k++] = static_cast<uint8_t>(std::clamp(v, 0, 255));
                        p = q + 1;
                    }
                    d.onLandscape = attrOf(tag, "drawOnLandscape") != "0";
                    d.onStatic = attrOf(tag, "drawOnStatic") == "1";
                    d.layer = static_cast<int>(numberOf(attrOf(tag, "layer"), 0));
                    d.sublayer = static_cast<int>(numberOf(attrOf(tag, "sublayer"), 0));
                    d.customGlow = attrOf(tag, "useCustomUniformGlow") == "1" && rgbOf(attrOf(tag, "customUniformGlow"), d.glowColor);
                    d.customGlowEv = attrOf(tag, "useCustomGlowEV100") == "1";
                    d.glowEv = numberOf(attrOf(tag, "customGlowEV100"), 0);
                    if (d.preset)
                        scene.decals.push_back(std::move(d));
                    return;
                }
                if (def == "EffectEntity" || def == "EffectZone_Area") { // the map's effects, and where the weather's changes
                    const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                    if ((!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                        (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)) ||
                        (!scene.environment.empty() && !envs.empty() && !listHas(envs, scene.environment)))
                        return;
                    if (def == "EffectEntity") {
                        const std::string_view fx = attrOf(tag, "Effect");
                        if (fx.empty() || attrOf(tag, "isPlayed") == "0") // (0: set off by the game: a scene's explosions)
                            return;
                        MapEffect e;
                        e.effect = std::string(fx);
                        hexFloats(attrOf(tag, "PosHex"), e.pos, 3);
                        hexFloats(attrOf(tag, "YPRHex"), e.ypr, 3);
                        e.scale = numberOf(attrOf(tag, "env_scale"), 1);
                        if (!(e.scale > 0))
                            e.scale = 1;
                        scene.effects.push_back(std::move(e));
                        return;
                    }
                    MapArea a;
                    a.effect = std::string(attrOf(tag, "areaEffect"));
                    a.screen = std::string(attrOf(tag, "screenEffect"));
                    a.stopsWeather = attrOf(tag, "turnOffGlobalEffect") == "1";
                    hexFloats(attrOf(tag, "PosHex"), a.pos, 3);
                    hexFloats(attrOf(tag, "YPRHex"), a.ypr, 3);
                    hexFloats(attrOf(tag, "ScaleHex"), a.size, 3);
                    if (a.stopsWeather || !a.effect.empty() || !a.screen.empty())
                        scene.areas.push_back(std::move(a));
                    return;
                }
                if (def == "Sound_AmbientSoundSpot" || def == "Sound_SplineSound" || def == "Sound_SoundZone") { // the map's sounds
                    const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                    if ((!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                        (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)))
                        return;
                    const bool envOk = scene.environment.empty() || envs.empty() || listHas(envs, scene.environment);
                    if (def == "Sound_SoundZone") { // (which soundscape the environment plays: below)
                        if (envOk)
                            zoneTags.emplace_back(attrOf(tag, "tags"));
                        return;
                    }
                    if (!envOk || attrOf(tag, "start_silent") == "1")
                        return;
                    MapSound ms;
                    ms.event = std::string(attrOf(tag, def == "Sound_SplineSound" ? "cueName" : "soundname"));
                    if (ms.event.empty())
                        return;
                    hexFloats(attrOf(tag, "PosHex"), ms.pos, 3);
                    if (def == "Sound_SplineSound") { // its points, from the entity, turned with it
                        float ypr[3]{}, r[9];
                        hexFloats(attrOf(tag, "YPRHex"), ypr, 3);
                        rotationYPR(ypr, r);
                        const std::string_view pts = attrOf(tag, "Positions");
                        std::vector<float> v(static_cast<size_t>(std::count(pts.begin(), pts.end(), ' ') + 1));
                        v.resize(static_cast<size_t>(hexFloats(pts, v.data(), static_cast<int>(v.size()))));
                        for (size_t i = 0; i + 2 < v.size(); i += 3)
                            ms.line.push_back({ms.pos[0] + r[0] * v[i] + r[1] * v[i + 1] + r[2] * v[i + 2], ms.pos[1] + r[3] * v[i] + r[4] * v[i + 1] + r[5] * v[i + 2],
                                               ms.pos[2] + r[6] * v[i] + r[7] * v[i + 1] + r[8] * v[i + 2]});
                    }
                    scene.sounds.push_back(std::move(ms));
                    return;
                }
                if (def.rfind("Lights_", 0) == 0) { // the map's lights (their environments are how the game switches lamps on at dusk)
                    const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                    if ((!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                        (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)) ||
                        (!scene.environment.empty() && !envs.empty() && !listHas(envs, scene.environment)))
                        return;
                    MapLight l;
                    if (lightOf(def, tag, l))
                        scene.lights.push_back(l);
                    return;
                }
                if (def.empty() || (!water && !known && invisibleDef(def)))
                    return;
                const bool tree = isTreeDef(def);
                if ((water && !filter.water) || (tree && !filter.trees) || (!water && !tree && !filter.entities))
                    return;
                const std::string_view games = attrOf(tag, "GameplaysList"), fests = attrOf(tag, "FestivalsList"), envs = attrOf(tag, "EnvironmentsList");
                if ((!gameplay.empty() && !games.empty() && !listHas(games, gameplay)) ||
                    (!filter.festival.empty() && !fests.empty() && !listHas(fests, filter.festival)) ||
                    (!scene.environment.empty() && !envs.empty() && !listHas(envs, scene.environment))) {
                    ++scene.filteredOut;
                    return;
                }
                float pos[3]{};
                hexFloats(attrOf(tag, "PosHex"), pos, 3);
                if (water) {
                    MapWater w;
                    w.name = std::string(attrOf(tag, "Name"));
                    w.acid = def == "Helpers_AcidVolume";
                    w.level = pos[1];
                    // The outline's points are in the entity's space, turned with it like a prop's
                    // (vulkan's sea lies along its east coast only turned half round, drcross's and
                    // sinto's pools in their basins). The surface stays level at the entity's height
                    // where the entity is tilted too: on arizona_silo and zombie_escape_3 its turned
                    // y = 0 plane meets the ground 4 to 55 m further from the outline than the level
                    // does (tower's slightly tilted rivers fit either about as well). The points' own
                    // heights only follow the ground the outline was drawn on.
                    float ypr[3]{}, r[9];
                    hexFloats(attrOf(tag, "YPRHex"), ypr, 3);
                    rotationYPR(ypr, r);
                    const std::string_view pts = attrOf(tag, "Points");
                    std::vector<float> v(static_cast<size_t>(std::count(pts.begin(), pts.end(), ' ') + 1));
                    v.resize(static_cast<size_t>(hexFloats(pts, v.data(), static_cast<int>(v.size()))));
                    for (size_t i = 0; i + 2 < v.size(); i += 5) // x y z (from the entity), then two flags (-1 -1)
                        w.outline.push_back({pos[0] + r[0] * v[i] + r[1] * v[i + 1] + r[2] * v[i + 2], pos[2] + r[6] * v[i] + r[7] * v[i + 1] + r[8] * v[i + 2]});
                    const std::string_view col = attrOf(tag, "color");
                    int rgb[3] = {52, 51, 50}, k = 0;
                    for (size_t p = 0; p < col.size() && k < 3;) {
                        size_t q = col.find(' ', p);
                        if (q == std::string_view::npos)
                            q = col.size();
                        std::from_chars(col.data() + p, col.data() + q, rgb[k++]);
                        p = q + 1;
                    }
                    for (int c = 0; c < 3; ++c)
                        w.color[c] = static_cast<uint8_t>(std::clamp(rgb[c], 0, 255));
                    // the look (see MapWater): user_param0 = uv0Tiling, uv1Tiling, uv0Speed, uv1Speed and
                    // user_param1 = bump0Height, bump1Height, density, noiseTiling, on every volume (the
                    // older ones have no named copies of them)
                    float up0[4] = {1, 1, 0, 0}, up1[4] = {1, 1, 1, 1};
                    hexFloats(attrOf(tag, "user_param0_hex"), up0, 4);
                    hexFloats(attrOf(tag, "user_param1_hex"), up1, 4);
                    for (int l = 0; l < 2; ++l) {
                        w.uvTiling[l] = up0[l];
                        w.uvSpeed[l] = up0[2 + l];
                        w.bumpHeight[l] = up1[l];
                        float dir = 0; // (a third of them hold leftovers: denormals, NaN, 9.4e12)
                        hexFloats(attrOf(tag, l ? "bump1Direction_hex" : "bump0Direction_hex"), &dir, 1);
                        w.bumpDir[l] = std::isfinite(dir) && std::abs(dir) > 1e-3f && std::abs(dir) <= 360 ? dir : 0;
                    }
                    w.density = std::isfinite(up1[2]) && up1[2] > 0 ? up1[2] : 1;
                    w.noiseTiling = up1[3];
                    hexFloats(attrOf(tag, "depth_hex"), &w.depth, 1);
                    w.type = static_cast<int>(numberOf(attrOf(tag, "waterType"), 0));
                    w.user2 = static_cast<int>(numberOf(attrOf(tag, "user2"), 0));
                    w.user3 = static_cast<int>(numberOf(attrOf(tag, "user3"), 0));
                    w.frames = normalizeGamePath(attrOf(tag, "BumpAnimationFramesDirectory"));
                    while (!w.frames.empty() && w.frames.back() == '/')
                        w.frames.pop_back();
                    w.detail[0] = normalizeGamePath(attrOf(tag, "DetailMapPath"));
                    w.detail[1] = normalizeGamePath(attrOf(tag, "Detail2MapPath"));
                    w.colorMap = normalizeGamePath(attrOf(tag, "ColorMapPath"));
                    // Crossout 2.41's water (water_material_version 3, every volume) has none of the legacy
                    // settings above: its waves are the 64 layers of BaseWaveWaterSamplerPath (256 px, the
                    // legacy frames in one texture, x in alpha and y in green, about 2.5 x as steep), tiled at
                    // baseWaveTiling per metre and as strong as baseWaveNormalStrength; its colour
                    // waterScatterColor at waterScatterDensity
                    if (w.frames.empty() && attrOf(tag, "user_param0_hex").empty() && !attrOf(tag, "BaseWaveWaterSamplerPath").empty()) {
                        w.frames = normalizeGamePath(attrOf(tag, "BaseWaveWaterSamplerPath"));
                        w.uvTiling[0] = numberOf(attrOf(tag, "baseWaveTiling"), 0.125f) * kWaterTile;
                        w.uvTiling[1] = numberOf(attrOf(tag, "flowWaveTiling"), 0.5f) * kWaterTile;
                        // (each layer's flipbook at 15 fps x AnimSpeed / 0.1333: the layered default the 2.40
                        // volumes with both shaders kept while the view ran their legacy flipbook at 15; the
                        // flow waves their own frames, carried by the wind where flowWaveAffectedByWind and
                        // by the map's currents where flowWaveFlowEnabled; the base waves do not drift; a
                        // layer switched off is flat)
                        const auto on = [&](const char *k) { return attrOf(tag, k) != "false"; };
                        w.uvSpeed[0] = w.uvSpeed[1] = 0;
                        w.bumpHeight[0] = on("baseWaveEnabled") ? numberOf(attrOf(tag, "baseWaveNormalStrength"), 0.25f) : 0;
                        w.bumpHeight[1] = on("flowWaveEnabled") ? numberOf(attrOf(tag, "flowWaveNormalStrength"), 0.5f) : 0;
                        w.fps[0] = 15 * std::max(0.0f, numberOf(attrOf(tag, "baseWaveAnimSpeed"), 0.1333f)) / 0.1333f;
                        w.fps[1] = 15 * std::max(0.0f, numberOf(attrOf(tag, "flowWaveAnimSpeed"), 0.3555f)) / 0.1333f;
                        w.flowFrames = normalizeGamePath(attrOf(tag, "FlowWaveWaterSamplerPath"));
                        if (w.flowFrames.empty())
                            w.flowFrames = w.frames;
                        w.windMul = on("flowWaveAffectedByWind") ? numberOf(attrOf(tag, "windSpeedMultiplier"), 1.0f) : 0;
                        if (attrOf(tag, "flowWaveFlowEnabled") == "true")
                            w.current = std::max(0.0f, numberOf(attrOf(tag, "flowWaveFlowSpeed"), 5.0f) * numberOf(attrOf(tag, "flowMapStrength"), 0.1f));
                        w.density = std::max(0.01f, numberOf(attrOf(tag, "waterScatterDensity"), 3.0f));
                        w.noiseTiling = numberOf(attrOf(tag, "waterNoiseTiling"), 0.5f);
                        const std::string_view sc = attrOf(tag, "waterScatterColor");
                        int s3[3] = {52, 51, 50}, n = 0;
                        for (size_t p = 0; p < sc.size() && n < 3;) {
                            size_t q = sc.find(' ', p);
                            if (q == std::string_view::npos)
                                q = sc.size();
                            std::from_chars(sc.data() + p, sc.data() + q, s3[n++]);
                            p = q + 1;
                        }
                        for (int c = 0; c < 3; ++c)
                            w.color[c] = static_cast<uint8_t>(std::clamp(s3[c], 0, 255));
                    }
                    if (!attrOf(tag, "FoamSamplerPath").empty()) // (the 12 volumes made over for the layered shader)
                        forEachAttr(tag, [&](std::string_view key, std::string_view val) {
                            for (const char *prefix : {"water", "indexOfRefraction", "refractionBlur", "flowMap", "bigwave", "medwave", "caustics", "dirtLayer", "coastline"})
                                if (key.rfind(prefix, 0) == 0) {
                                    w.layered.emplace_back(key, val);
                                    return;
                                }
                            if (key.size() > 11 && key.compare(key.size() - 11, 11, "SamplerPath") == 0)
                                w.layered.emplace_back(key, val);
                        });
                    if (w.outline.size() >= 3)
                        scene.water.push_back(std::move(w));
                    return;
                }
                MapObject o;
                const std::string_view model = attrOf(tag, "Model");
                if (known) {
                    o.model = known->model;
                } else if (!model.empty() && model != "@") {
                    o.model = normalizeGamePath(model);
                    if (o.model.size() < 4 || o.model.compare(o.model.size() - 4, 4, ".mdl") != 0)
                        o.model += ".mdl";
                } else {
                    o.model = resolver.resolve(def);
                }
                if (o.model.empty() || !gd.find(o.model)) {
                    ++scene.unresolved[def];
                    return;
                }
                const std::string_view skin = attrOf(tag, "Skin");
                o.skin = skin == "@" && known ? known->skin : skin == "@" || skin == "default" ? std::string() : std::string(skin);
                o.name = std::string(attrOf(tag, "Name"));
                if (o.name.empty())
                    o.name = def;
                o.def = def;
                o.group = tree ? "trees" : "objects";
                o.uid = uid;
                std::memcpy(o.pos, pos, sizeof(pos));
                hexFloats(attrOf(tag, "YPRHex"), o.ypr, 3);
                hexFloats(attrOf(tag, "ScaleHex"), o.scale, 3);
                scene.objects.push_back(std::move(o));
            });
        }
    }
    // the environment's soundscape: soundscapes.xml names one per zone tag (env_day, env_cloudy,
    // env_winter_night ...); the zone tags that name the environment pick it (an env_ one first)
    if (gd.read(dir + "soundscapes.xml", b, nullptr)) {
        std::map<std::string, std::string> cues;
        forEachTag(textOf(b), "soundscape", [&](std::string_view tag) { cues.emplace(std::string(attrOf(tag, "tag")), std::string(attrOf(tag, "cue-name"))); });
        for (int pass = 0; pass < 2 && scene.soundscape.empty(); ++pass)
            for (const auto &t : zoneTags)
                if ((pass == 1 || t.rfind("env_", 0) == 0) && cues.count(t) && scene.soundscape.empty())
                    scene.soundscape = cues[t];
        if (scene.soundscape.empty() && cues.count("env_default"))
            scene.soundscape = cues["env_default"];
    }

    if (!scene.hasTerrain && scene.objects.empty() && scene.water.empty() && scene.decals.empty()) {
        if (err)
            *err = name + ": nothing to show (no terrain, props or objects)";
        return false;
    }
    return true;
}

// A point in a texture set's repeat: (x, z) / tiling, mirrored (u = -u) and turned by quarter turns,
// as the view's terrain shader does it (mapview.js xoTurn).
static void turnUv(float &u, float &v, int rotation, bool flip) {
    if (flip)
        u = -u;
    const float a = u, b = v;
    if (rotation == 1) {
        u = -b;
        v = a;
    } else if (rotation == 2) {
        u = -a;
        v = -b;
    } else if (rotation == 3) {
        u = b;
        v = -a;
    }
}

bool bakeGround(const GameData &gd, const Terrain &t, int size, ImageRGBA &out, std::vector<std::string> &warnings, std::string *err,
                const Progress &progress, ImageRGBA *normal, ImageRGBA *metalRough) {
    if (t.height.empty() || size <= 0) {
        if (err)
            *err = "no terrain";
        return false;
    }
    const float longest = std::max(t.sizeX(), t.sizeZ());
    const uint32_t W = std::max(1u, static_cast<uint32_t>(std::lround(size * t.sizeX() / longest)));
    const uint32_t H = std::max(1u, static_cast<uint32_t>(std::lround(size * t.sizeZ() / longest)));
    const float texel = t.sizeX() / W; // metres per pixel

    // each surface's textures at the mip that matches the pixel size: the albedo as linear RGB, the
    // gloss map as height, gloss, metal and the normal map as x, y (+X along u, +Y towards row 0), AO
    struct Plane {
        std::vector<float> px; // 3 per pixel
        uint32_t w = 0, h = 0;
    };
    struct Layer {
        Plane albedo, gloss, normal;
        float tiling = 8;
        float avg[3]{0.5f, 0.5f, 0.5f};
        float blend = 0, mid = 0.5f; // height blending (blend 0: none)
        bool invert = false, flat = false;
        int rotation = 0;
        bool flip = false;
    };
    std::vector<Layer> layers(t.surfaces.size());
    float lut[256];
    for (int i = 0; i < 256; ++i)
        lut[i] = srgbToLinear(i / 255.0f);
    enum class Kind { Albedo, Gloss, Normal };
    auto load = [&](const std::string &base, float tiling, Kind kind, Plane &P) {
        Texture tex;
        std::string e;
        if (!loadTextureHeader(gd, base, tex, &e)) {
            warnings.push_back(e);
            return;
        }
        const int n = static_cast<int>(tex.info.levels.size());
        int lv = 0;
        const float want = tiling / texel; // pixels of the texture per repeat that the bake can show
        while (lv + 1 < n && tex.info.levels[lv + 1].width >= want && tex.info.levels[lv + 1].width >= 4)
            ++lv;
        loadTextureLevels(gd, tex, lv, n - 1, nullptr); // (levels it cannot read stay unavailable)
        const uint8_t *p;
        size_t bytes;
        while (lv + 1 < n && !tex.levelData(lv, p, bytes))
            ++lv;
        std::vector<uint8_t> rgba;
        if (!decodeLevel(tex, lv, rgba, P.w, P.h, &e)) {
            warnings.push_back(base + ": " + e);
            P.w = P.h = 0;
            return;
        }
        const bool ag = kind == Kind::Normal && guessNormalLayout(tex.info.format, rgba) == NormalLayout::AG;
        P.px.resize(static_cast<size_t>(P.w) * P.h * 3);
        for (size_t i = 0; i < static_cast<size_t>(P.w) * P.h; ++i) {
            const uint8_t *s = &rgba[i * 4];
            float *o = &P.px[i * 3];
            if (kind == Kind::Albedo) {
                for (int c = 0; c < 3; ++c)
                    o[c] = lut[s[c]];
            } else if (kind == Kind::Gloss) {
                for (int c = 0; c < 3; ++c)
                    o[c] = s[c] / 255.0f;
            } else { // (DXT5nm: x in alpha, AO in red; plain normal maps have no AO)
                o[0] = (ag ? s[3] : s[0]) / 127.5f - 1;
                o[1] = s[1] / 127.5f - 1;
                o[2] = ag ? s[0] / 255.0f : 1.0f;
            }
        }
    };
    for (size_t s = 0; s < t.surfaces.size(); ++s) {
        const TerrainSurface &S = t.surfaces[s];
        Layer &L = layers[s];
        L.tiling = S.tiling;
        L.rotation = S.rotation;
        L.flip = S.flip;
        L.blend = t.heightBlend ? S.blendRoughness * terrainHeightBlend : 0;
        L.mid = S.heightMid;
        L.invert = S.invertBlend;
        L.flat = S.flatHeight;
        if (S.albedo.empty())
            continue;
        load(S.albedo, L.tiling, Kind::Albedo, L.albedo);
        if (!S.gloss.empty() && (L.blend > 0 || metalRough))
            load(S.gloss, L.tiling, Kind::Gloss, L.gloss);
        if (!S.normal.empty() && (normal || metalRough))
            load(S.normal, L.tiling, Kind::Normal, L.normal);
        if (!L.albedo.w)
            continue;
        double sum[3]{};
        for (size_t i = 0; i < static_cast<size_t>(L.albedo.w) * L.albedo.h; ++i)
            for (int c = 0; c < 3; ++c)
                sum[c] += L.albedo.px[i * 3 + c];
        for (int c = 0; c < 3; ++c)
            L.avg[c] = static_cast<float>(sum[c] / (static_cast<double>(L.albedo.w) * L.albedo.h));
    }
    if (progress)
        progress(0.1, "Baking the ground");

    const int TX = t.texelsX(), TZ = t.texelsZ();
    const bool splat = !t.surfIndex.empty() && TX > 0 && TZ > 0;
    out.w = W;
    out.h = H;
    out.rgba.assign(static_cast<size_t>(W) * H * 4, 255);
    for (ImageRGBA *img : {normal, metalRough})
        if (img) {
            img->w = W;
            img->h = H;
            img->rgba.assign(static_cast<size_t>(W) * H * 4, 255);
        }
    std::vector<uint8_t> toSrgb(4096);
    for (int i = 0; i < 4096; ++i)
        toSrgb[i] = static_cast<uint8_t>(std::lround(std::clamp(linearToSrgb(i / 4095.0f), 0.0f, 1.0f) * 255));

    // bilinear, wrapping (u, v in repeats)
    auto sample = [](const Plane &P, float u, float v, float o[3]) {
        u = (u - std::floor(u)) * P.w - 0.5f;
        v = (v - std::floor(v)) * P.h - 0.5f;
        const int i0 = static_cast<int>(std::floor(u)), j0 = static_cast<int>(std::floor(v));
        const float fu = u - i0, fv = v - j0;
        const uint32_t ia = static_cast<uint32_t>((i0 % static_cast<int>(P.w) + static_cast<int>(P.w)) % static_cast<int>(P.w)), ib = (ia + 1) % P.w;
        const uint32_t ja = static_cast<uint32_t>((j0 % static_cast<int>(P.h) + static_cast<int>(P.h)) % static_cast<int>(P.h)), jb = (ja + 1) % P.h;
        const float *p00 = &P.px[(static_cast<size_t>(ja) * P.w + ia) * 3], *p10 = &P.px[(static_cast<size_t>(ja) * P.w + ib) * 3];
        const float *p01 = &P.px[(static_cast<size_t>(jb) * P.w + ia) * 3], *p11 = &P.px[(static_cast<size_t>(jb) * P.w + ib) * 3];
        for (int c = 0; c < 3; ++c)
            o[c] = (p00[c] * (1 - fu) + p10[c] * fu) * (1 - fv) + (p01[c] * (1 - fu) + p11[c] * fu) * fv;
    };

    auto rows = [&](uint32_t y0, uint32_t y1) {
        std::vector<float> wsum(std::max<size_t>(1, layers.size()));
        for (uint32_t py = y0; py < y1; ++py) {
            const float z = t.z0() + t.sizeZ() - (py + 0.5f) * t.sizeZ() / H; // top row = the +Z edge
            for (uint32_t px = 0; px < W; ++px) {
                const float x = t.x0() + (px + 0.5f) * t.sizeX() / W;
                std::fill(wsum.begin(), wsum.end(), 0.0f);
                if (splat) {
                    // the four surface texels around the point, each a blend of its three surfaces
                    const float gx = (x - t.x0()) / t.sizeX() * TX - t.texelOffset(), gz = (z - t.z0()) / t.sizeZ() * TZ - t.texelOffset();
                    const int i0 = static_cast<int>(std::floor(gx)), j0 = static_cast<int>(std::floor(gz));
                    const float fx = gx - i0, fz = gz - j0;
                    for (int k = 0; k < 4; ++k) {
                        const int i = std::clamp(i0 + (k & 1), 0, TX - 1), j = std::clamp(j0 + (k >> 1), 0, TZ - 1);
                        const float wk = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fz : 1 - fz);
                        const size_t at = static_cast<size_t>(j) * TX + i;
                        const uint16_t ix = t.surfIndex[at];
                        const float r = t.surfWeight[at * 2] / 255.0f, g = t.surfWeight[at * 2 + 1] / 255.0f;
                        const float w3[3] = {r, (1 - r) * g, (1 - r) * (1 - g)};
                        for (int l = 0; l < 3; ++l) {
                            const size_t s = (ix >> (5 * l)) & 31;
                            if (s < wsum.size())
                                wsum[s] += wk * w3[l];
                        }
                    }
                } else {
                    wsum[0] = 1;
                }
                // each surface by its weight, scaled by how high it stands (height blending)
                float col[3]{}, tot = 0, gloss = 0, metal = 0, nx = 0, ny = 0, ao = 0;
                for (size_t s = 0; s < layers.size(); ++s) {
                    if (wsum[s] < 1e-4f)
                        continue;
                    const Layer &L = layers[s];
                    float u = x / L.tiling, v = z / L.tiling;
                    turnUv(u, v, L.rotation, L.flip);
                    float g[3]{L.mid, 0.07f, 0}, c[3], n[3]{0, 0, 1};
                    if (L.gloss.w)
                        sample(L.gloss, u, v, g);
                    float w = wsum[s];
                    if (L.blend > 0) // (over its mid: inverted, under it)
                        w *= std::exp2(L.blend * (L.flat ? 0 : L.invert ? L.mid - g[0] : g[0] - L.mid));
                    if (L.albedo.w)
                        sample(L.albedo, u, v, c);
                    else
                        std::memcpy(c, L.avg, sizeof(c));
                    for (int k = 0; k < 3; ++k)
                        col[k] += c[k] * w;
                    tot += w;
                    gloss += g[1] * w;
                    metal += g[2] * w;
                    if (L.normal.w) { // (into the world: x along +x, y along -z, turned back from the set's turn)
                        sample(L.normal, u, v, n);
                        float dx = n[0], dz = -n[1];
                        turnUv(dx, dz, (4 - L.rotation) & 3, false);
                        if (L.flip)
                            dx = -dx;
                        n[0] = dx;
                        n[1] = -dz;
                    }
                    nx += n[0] * w;
                    ny += n[1] * w;
                    ao += n[2] * w;
                }
                const size_t o = (static_cast<size_t>(py) * W + px) * 4;
                for (int k = 0; k < 3; ++k)
                    out.rgba[o + k] = toSrgb[std::clamp(static_cast<int>((tot > 0 ? col[k] / tot : 0.5f) * 4095 + 0.5f), 0, 4095)];
                const float inv = tot > 0 ? 1 / tot : 0;
                if (normal) { // (the picture's up is the game's +Z: the textures' y points to -Z)
                    const float a = nx * inv, b = -ny * inv, c = std::sqrt(std::max(0.0f, 1 - a * a - b * b));
                    for (int k = 0; k < 3; ++k)
                        normal->rgba[o + k] = static_cast<uint8_t>(std::lround(std::clamp(((k == 0 ? a : k == 1 ? b : c) + 1) * 127.5f, 0.0f, 255.0f)));
                }
                if (metalRough) { // occlusion, roughness (no smoother than the view's map materials), metal: glTF packs them so
                    metalRough->rgba[o] = static_cast<uint8_t>(std::lround(std::clamp(tot > 0 ? ao * inv : 1.0f, 0.0f, 1.0f) * 255));
                    metalRough->rgba[o + 1] = static_cast<uint8_t>(std::lround(std::clamp(tot > 0 ? 1 - gloss * inv : 0.93f, 0.05f, 1.0f) * 255));
                    metalRough->rgba[o + 2] = static_cast<uint8_t>(std::lround(std::clamp(metal * inv, 0.0f, 1.0f) * 255));
                }
            }
        }
    };
    const unsigned threads = std::clamp(std::thread::hardware_concurrency(), 1u, 16u);
    std::vector<std::thread> pool;
    const uint32_t per = (H + threads - 1) / threads;
    for (unsigned i = 0; i < threads; ++i) {
        const uint32_t a = i * per, b2 = std::min(H, a + per);
        if (a < b2)
            pool.emplace_back(rows, a, b2);
    }
    for (auto &th : pool)
        th.join();
    if (progress)
        progress(1, "Baked the ground");
    return true;
}

TerrainLight bakeTerrainLight(const Terrain &t, int step, const float sun[3]) {
    TerrainLight out;
    if (t.height.empty())
        return out;
    out.step = std::max(1, step);
    out.w = t.cellsX / out.step + 1;
    out.h = t.cellsZ / out.step + 1;
    out.rg.assign(static_cast<size_t>(out.w) * out.h * 2, 255);
    const float stepM = t.cellSize * out.step;
    // towards the sun in the game's space (glTF z mirrored), and how high it stands
    const float sx = sun[0], sz = -sun[2], flat = std::hypot(sx, sz);
    const float sunEl = std::atan2(sun[1], flat), soft = 1.27f * kPi / 180; // (the sun's radius and a degree)
    const float reach = std::hypot(t.sizeX(), t.sizeZ());
    constexpr int kSky = 8;
    constexpr float kSkyReach = 300;
    auto rows = [&](int j0, int j1) {
        for (int j = j0; j < j1; ++j)
            for (int i = 0; i < out.w; ++i) {
                const float x = t.x0() + i * stepM, z = t.z0() + j * stepM;
                const float y0 = t.height[static_cast<size_t>(std::min(j * out.step, t.cellsZ)) * t.samplesX() + std::min(i * out.step, t.cellsX)];
                // the steepest rise of the land along (dx, dz) out to maxDist (the tangent of its horizon);
                // the march stops once nothing further could rise above max(that, low), or it reached high
                auto horizon = [&](float dx, float dz, float maxDist, float low, float high) {
                    float best = -1e9f;
                    for (float s = stepM * 1.5f; s < maxDist; s += std::max(stepM, s * 0.04f)) {
                        best = std::max(best, (t.heightAt(x + dx * s, z + dz * s) - y0) / s);
                        if (best >= high || (t.maxY - y0) / s <= std::max(best, low))
                            break;
                    }
                    return best;
                };
                uint8_t *o = &out.rg[(static_cast<size_t>(j) * out.w + i) * 2];
                if (std::isfinite(flat) && flat > 1e-4f) { // (an infinite sun would march heightAt to NaN)
                    const float a = sunEl - std::atan(horizon(sx / flat, sz / flat, reach, std::tan(sunEl - soft), std::tan(sunEl + soft)));
                    const float v = std::clamp((a + soft) / (2 * soft), 0.0f, 1.0f);
                    o[0] = static_cast<uint8_t>(std::lround(v * v * (3 - 2 * v) * 255));
                }
                float sky = 0;
                for (int k = 0; k < kSky; ++k) {
                    const float az = (k + 0.5f) * 2 * kPi / kSky;
                    const float rise = std::max(0.0f, horizon(std::cos(az), std::sin(az), kSkyReach, 0, 1e9f));
                    sky += 1 / (1 + rise * rise); // (cos² of the horizon's angle: the sky a level patch sees past it)
                }
                o[1] = static_cast<uint8_t>(std::lround(sky / kSky * 255));
            }
    };
    const int threads = static_cast<int>(std::clamp(std::thread::hardware_concurrency(), 1u, 16u));
    std::vector<std::thread> pool;
    const int per = (out.h + threads - 1) / threads;
    for (int k = 0; k < threads; ++k)
        if (k * per < out.h)
            pool.emplace_back(rows, k * per, std::min(out.h, (k + 1) * per));
    for (auto &th : pool)
        th.join();
    // the sky's part smoothed over 5 x 5 samples (eight directions leave rings around single peaks)
    std::vector<float> sky(static_cast<size_t>(out.w) * out.h), pass(sky.size());
    for (size_t i = 0; i < sky.size(); ++i)
        sky[i] = out.rg[i * 2 + 1];
    for (int dir = 0; dir < 2; ++dir) {
        for (int j = 0; j < out.h; ++j)
            for (int i = 0; i < out.w; ++i) {
                float sum = 0;
                for (int d = -2; d <= 2; ++d) {
                    const int a = dir ? i : std::clamp(i + d, 0, out.w - 1), b = dir ? std::clamp(j + d, 0, out.h - 1) : j;
                    sum += sky[static_cast<size_t>(b) * out.w + a];
                }
                pass[static_cast<size_t>(j) * out.w + i] = sum / 5;
            }
        sky.swap(pass);
    }
    for (size_t i = 0; i < sky.size(); ++i)
        out.rg[i * 2 + 1] = static_cast<uint8_t>(std::lround(sky[i]));
    return out;
}

// ---- environment -------------------------------------------------------------------------------
namespace {

// Every <Name value="..."/> setting of one preset body (the presets are flat lists).
std::vector<std::pair<std::string, std::string>> presetValues(std::string_view body) {
    std::vector<std::pair<std::string, std::string>> out;
    size_t p = 0;
    while ((p = body.find('<', p)) != std::string_view::npos) {
        ++p;
        if (p >= body.size() || body[p] == '/' || body[p] == '!' || body[p] == '?')
            continue;
        size_t q = p;
        while (q < body.size() && (std::isalnum(static_cast<unsigned char>(body[q])) || body[q] == '_'))
            ++q;
        const size_t end = body.find('>', p);
        if (end == std::string_view::npos)
            break;
        const std::string_view tag = body.substr(p, end - p);
        const std::string_view v = attrOf(tag, "value");
        if (q > p && (!v.empty() || tag.find(" value=\"\"") != std::string_view::npos))
            out.emplace_back(std::string(body.substr(p, q - p)), std::string(v));
        p = end + 1;
    }
    return out;
}

// The body of <Preset id="id" ...> ... </Preset> in a preset list, or "" (tag: the start tag).
std::string_view presetBody(std::string_view text, std::string_view id, std::string_view *tag = nullptr) {
    const std::string key = "<Preset id=\"" + std::string(id) + "\"";
    const size_t p = text.find(key);
    if (p == std::string_view::npos)
        return {};
    const size_t tagEnd = text.find('>', p), end = text.find("</Preset>", p);
    if (tagEnd == std::string_view::npos || end == std::string_view::npos)
        return {};
    if (tag)
        *tag = text.substr(p + 1, tagEnd - p - 1);
    return text.substr(tagEnd + 1, end - tagEnd - 1);
}

float half2f(uint16_t h) {
    const uint32_t sign = (h & 0x8000u) << 16;
    uint32_t exp = (h >> 10) & 31, mant = h & 1023, bits;
    if (exp == 0) {
        if (mant == 0) {
            bits = sign;
        } else {
            exp = 127 - 15 + 1;
            while (!(mant & 1024)) {
                mant <<= 1;
                --exp;
            }
            bits = sign | (exp << 23) | ((mant & 1023) << 13);
        }
    } else if (exp == 31) {
        bits = sign | 0x7F800000u | (mant << 13);
    } else {
        bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    return std::bit_cast<float>(bits);
}

} // namespace

std::string MapEnvironment::value(std::string_view key) const {
    for (const auto &[k, v] : values)
        if (k == key)
            return v;
    return {};
}

// ---- Crossout 2.41's environments: the map scene's own entities ----------------------------------
// The remaster left each environment's preset in assets/envsettings.mxml a stub (no atmosphere, no fog,
// a sun of 1000) and put its look into entities of the map's scene.mxml, Unreal-style, each for the
// environments its EnvironmentsList names (none: all of the map's): EnvironmentBackdrop (the sky: an
// HDR picture of it), SkyAtmosphere (a sky worked out from the air, where there is no picture),
// SkyDirectionalLight (the sun), ExponentialHeightFog, PostProcessing (exposure, white balance, colour
// LUT), Dust (the weather's cover) and WeatherConditions (wind, the weather's particles). PostProcessing
// and Dust are volumes: the map's own (layer -10, every setting) under the environment's (layer 0),
// each taking the settings its override_ flags name; box-shaped ones are local (a tunnel's) and left
// out. They are written into the preset's own settings in its units (game light = lux / 128: 2.40's
// sun above the air, LIGHT_K x the atmospheres' solar irradiance, is 2.41's 135000 lux / 128 to 0.3 %),
// with Backdrop* and HeightFog* for what the presets had no setting for (CROSSOUT_FORMATS.md,
// "Environments in 2.41").
namespace {

constexpr double kPiD = 3.14159265358979323846;
constexpr double kLuxPerGameUnit = 128; // (7 EV)
// The fog's density per unit of an ExponentialHeightFog layer's baseDensity (per metre, base 2), no
// layer thicker than at its height (heightOffset; with a falloff below 0, thicker above it): fitted on
// the game's light probes, each capture against its sky alone from 12 degrees up (40 environments whose
// fog takes under 0.6 of the sky's colour; its probeInscatteringIntesityScale came back as that share):
// 0.0035, the environments within x 1.5 of it (without the cap x 1.75, and storms 400 m deep far off).
constexpr double kHeightFogDensity = 0.0035;

using Attrs = std::vector<std::pair<std::string, std::string>>;

std::string_view attrIn(const Attrs &a, std::string_view k) {
    for (const auto &[n, v] : a)
        if (n == k)
            return v;
    return {};
}
double numIn(const Attrs *a, std::string_view k, double def) {
    const std::string_view v = a ? attrIn(*a, k) : std::string_view{};
    return v.empty() ? def : numberOf(v, static_cast<float>(def));
}
// "r g b" (0..255) -> 0..1 each
std::array<double, 3> color255(const Attrs *a, std::string_view k, std::array<double, 3> def) {
    const std::string_view v = a ? attrIn(*a, k) : std::string_view{};
    std::array<double, 3> c{};
    int n = 0;
    size_t p = 0;
    while (n < 3 && p < v.size()) {
        while (p < v.size() && v[p] == ' ')
            ++p;
        size_t q = p;
        while (q < v.size() && v[q] != ' ')
            ++q;
        if (q > p)
            c[n++] = numberOf(v.substr(p, q - p), 0) / 255.0;
        p = q;
    }
    return n == 3 ? c : def;
}
double lumOf(const std::array<double, 3> &c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
std::string num6(double v) {
    char b[32];
    std::snprintf(b, sizeof(b), "%.6g", v);
    return b;
}
double srgbToLinear(double c) { return c <= 0.04045 ? c / 12.92 : std::pow((c + 0.055) / 1.055, 2.4); }
double linearToSrgb(double c) { return c <= 0.0031308 ? c * 12.92 : 1.055 * std::pow(c, 1 / 2.4) - 0.055; }
// a linear colour as the presets write one: "0xFFRRGGBB" (sRGB), its brightest channel full
std::string argbHex(const std::array<double, 3> &c) {
    const double m = std::max({c[0], c[1], c[2], 1e-9});
    int v[3];
    for (int i = 0; i < 3; ++i)
        v[i] = std::clamp(static_cast<int>(std::lround(linearToSrgb(std::max(0.0, c[i]) / m) * 255)), 0, 255);
    char b[16];
    std::snprintf(b, sizeof(b), "0xFF%02X%02X%02X", v[0], v[1], v[2]);
    return b;
}
void setValue(MapEnvironment &env, std::string_view key, std::string value) {
    for (auto &[k, v] : env.values)
        if (k == key) {
            v = std::move(value);
            return;
        }
    env.values.emplace_back(std::string(key), std::move(value));
}

// A volume's override_ flag and the setting it names, where the two differ (more than in case: the
// fog's layer0BaseDensity names layer0baseDensity; its BaseHeight the layer's height, collectScene's)
std::string_view overridden(std::string_view flag) {
    static constexpr std::pair<std::string_view, std::string_view> alias[] = {
        {"exposureCompensation", "exposureEC"}, {"exposureManualEV100", "exposureEV100"},
        {"exposureEmissiveAndLocalLightsLuminanceCompensation", "exposureEmissiveAndLocalLightsEC"},
        {"temperatureValue", "temperature"}, {"colorLut", "colorLutFilename"},
        {"layer0BaseHeight", "layer0height"}, {"layer1BaseHeight", "layer1height"},
        {"environmentInscatteringScale", "probeInscatteringIntesityScale"}, {"directionalLightScatteringScale", "directionalLightScatteringIntensityScale"}};
    for (const auto &[f, s] : alias)
        if (flag == f)
            return s;
    return flag;
}
bool sameNoCase(std::string_view a, std::string_view b) {
    if (a.size() != b.size())
        return false;
    for (size_t i = 0; i < a.size(); ++i)
        if (std::tolower(static_cast<unsigned char>(a[i])) != std::tolower(static_cast<unsigned char>(b[i])))
            return false;
    return true;
}

struct SceneVolume {
    double layer = 0;
    int listed = 0; // (the environment's own over the map's at the same layer)
    Attrs attrs;
};

// The volumes' settings as they stack up: the lowest layer's all, each later one's the ones its flags
// name (all of them without flags).
Attrs stackVolumes(std::vector<SceneVolume> vols) {
    std::stable_sort(vols.begin(), vols.end(), [](const SceneVolume &a, const SceneVolume &b) { return a.layer != b.layer ? a.layer < b.layer : a.listed < b.listed; });
    Attrs out;
    auto put = [&](const std::string &k, const std::string &v) {
        for (auto &[n, x] : out)
            if (n == k) {
                x = v;
                return;
            }
        out.emplace_back(k, v);
    };
    for (size_t i = 0; i < vols.size(); ++i) {
        const Attrs &a = vols[i].attrs;
        bool flags = false;
        for (const auto &[k, v] : a)
            flags = flags || k.rfind("override_", 0) == 0;
        for (const auto &[k, v] : a) {
            if (k.rfind("override_", 0) == 0)
                continue;
            bool take = i == 0 || !flags;
            for (size_t j = 0; j < a.size() && !take; ++j)
                take = a[j].first.rfind("override_", 0) == 0 && a[j].second == "true" && sameNoCase(overridden(std::string_view(a[j].first).substr(9)), k);
            if (take)
                put(k, v);
        }
    }
    return out;
}

struct SceneEnv {
    bool any = false;
    std::optional<Attrs> backdrop, atmosphere, light, weather; // the environment's own, else the map's
    std::vector<SceneVolume> post, dust, fog;
};

void collectScene(std::string_view text, std::string_view envId, SceneEnv &se) {
    static constexpr std::string_view kinds[] = {"EnvironmentBackdrop", "SkyAtmosphere", "SkyDirectionalLight", "ExponentialHeightFog", "WeatherConditions", "PostProcessing", "Dust"};
    struct Pick {
        Attrs attrs;
        int rank = -1;
    } picks[5];
    forEachTag(text, "Entity", [&](std::string_view tag) {
        const std::string_view def = attrOf(tag, "Def");
        int kind = -1;
        for (int k = 0; k < 7 && kind < 0; ++k)
            if (def == kinds[k])
                kind = k;
        if (kind < 0)
            return;
        const std::string_view list = attrOf(tag, "EnvironmentsList");
        if (!list.empty() && !listHas(list, envId))
            return;
        Attrs a;
        forEachAttr(tag, [&](std::string_view k, std::string_view v) { a.emplace_back(std::string(k), std::string(v)); });
        se.any = true;
        if (kind >= 5 || kind == 3) { // (the post-processing, the dust and the fog: volumes)
            const std::string_view shape = attrIn(a, "volumeShape");
            if (!shape.empty() && shape != "infinite")
                return; // (a local one: a tunnel's, a hangar's hall)
            if (numIn(&a, "volumeWeight", 1) <= 0)
                return; // (switched off: the storms' second fog)
            if (kind == 3) { // (each layer's height where its own volume puts it)
                float pos[3]{};
                hexFloats(attrIn(a, "PosHex"), pos, 3);
                for (const std::string L : {"layer0", "layer1"})
                    a.emplace_back(L + "height", num6(pos[1] + numIn(&a, L + "heightOffset", 0)));
            }
            SceneVolume vol{numIn(&a, "volumeLayer", 0), list.empty() ? 0 : 1, std::move(a)};
            (kind == 5 ? se.post : kind == 6 ? se.dust : se.fog).push_back(std::move(vol));
            return;
        }
        const int rank = list.empty() ? 0 : 1;
        if (rank > picks[kind].rank)
            picks[kind] = {std::move(a), rank};
    });
    std::optional<Attrs> *slots[] = {&se.backdrop, &se.atmosphere, &se.light, nullptr, &se.weather};
    for (int k = 0; k < 5; ++k)
        if (picks[k].rank >= 0 && slots[k])
            *slots[k] = std::move(picks[k].attrs);
}

// The sun's way (game space, towards it) from a SkyDirectionalLight's YPRHex (degrees): +Z turned about
// Y by the yaw, then about X by the pitch, then about Z by the roll. Checked on bridge against the
// game's captures (its light probes): day 18.4 degrees up towards -Z (pitch 18.36), xmass 13.2 degrees
// up towards +X (yaw 90, roll 13.32), fog 60 degrees up (pitch 60).
std::array<double, 3> lightDirection(const float ypr[3]) {
    const double y = ypr[0] * kPiD / 180, p = ypr[1] * kPiD / 180, r = ypr[2] * kPiD / 180;
    const double x0 = std::sin(y), z0 = std::cos(y);
    const double y1 = -z0 * std::sin(p), z1 = z0 * std::cos(p);
    return {x0 * std::cos(r) - y1 * std::sin(r), x0 * std::sin(r) + y1 * std::cos(r), z1};
}

// A light's colour at a colour temperature (K), linear sRGB against 6500 K's (Planck's locus by
// Krystek's fit, as ui/sky.js whiteBalance).
std::array<double, 3> blackbody(double t) {
    auto rgbAt = [](double T) {
        T = std::clamp(T, 1000.0, 25000.0);
        const double u = (0.860117757 + 1.54118254e-4 * T + 1.28641212e-7 * T * T) / (1 + 8.42420235e-4 * T + 7.08145163e-7 * T * T);
        const double v = (0.317398726 + 4.22806245e-5 * T + 4.20481691e-8 * T * T) / (1 - 2.89741816e-5 * T + 1.61456053e-7 * T * T);
        const double x = 3 * u / (2 * u - 8 * v + 4), y = 2 * v / (2 * u - 8 * v + 4), X = x / y, Z = (1 - x - y) / y;
        return std::array<double, 3>{3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z};
    };
    const auto c = rgbAt(t), w = rgbAt(6500);
    return {std::max(0.0, c[0] / w[0]), std::max(0.0, c[1] / w[1]), std::max(0.0, c[2] / w[2])};
}

// What the air lets through of the sun (rgb) at elevation el (radians), seen from the ground: UE's sky
// atmosphere with a SkyAtmosphere entity's numbers (per km; UE's own defaults without one): Rayleigh and
// Mie in exponential layers, ozone in a tent 15 km either side of 25 km up.
std::array<double, 3> airTransmittance(const Attrs *a, double el) {
    const double R = numIn(a, "planetRadius", 6360), top = R + numIn(a, "atmosphereHeight", 60), r0 = R + numIn(a, "altitudeOverSeaLevel", 0) / 1000;
    const auto ray = color255(a, "rayleighScatteringCoefficient", {0.175287, 0.409607, 1}), mieS = color255(a, "mieScatteringCoefficient", {1, 1, 1}),
               mieA = color255(a, "mieAbsorptionCoefficient", {1, 1, 1}), oz = color255(a, "absorptionCoefficient", {0.345561, 1, 0.045188});
    const double rs = numIn(a, "rayleighScatteringScale", 0.0331), rh = std::max(0.1, numIn(a, "rayleighHeight", 8)), ms = numIn(a, "mieScatteringScale", 0.003996),
                 ma = numIn(a, "mieAbsorptionScale", 0.000444), mh = std::max(0.05, numIn(a, "mieHeight", 1.2)), os = numIn(a, "absorptionScale", 0.001881);
    const double mu = std::sin(el);
    if (mu < 0 && r0 * r0 * (mu * mu - 1) + R * R >= 0)
        return {0, 0, 0}; // (below the horizon)
    const double d = -r0 * mu + std::sqrt(std::max(0.0, r0 * r0 * (mu * mu - 1) + top * top));
    constexpr int N = 256;
    double tau[3]{};
    for (int i = 0; i < N; ++i) {
        const double s = (i + 0.5) / N * d, h = std::sqrt(r0 * r0 + s * s + 2 * r0 * s * mu) - R;
        const double dr = std::exp(-h / rh), dm = std::exp(-h / mh), dz = std::max(0.0, 1 - std::abs(h - 25) / 15);
        for (int c = 0; c < 3; ++c)
            tau[c] += (ray[c] * rs * dr + (mieS[c] * ms + mieA[c] * ma) * dm + oz[c] * os * dz) * d / N;
    }
    return {std::exp(-tau[0]), std::exp(-tau[1]), std::exp(-tau[2])};
}

// A SkyAtmosphere entity's numbers as Sky.cpp's AirModel reads them (km; per km): planet radius, top,
// the camera; Rayleigh rgb, its height; Mie scattering rgb, absorption rgb, its height, phase g; ozone
// rgb; the ground's albedo (its bytes sRGB, as Unreal's GroundAlbedo); UE's defaults where one is missing.
std::string airNumbers(const Attrs *a) {
    const double R = numIn(a, "planetRadius", 6360);
    std::string s = num6(R) + " " + num6(R + numIn(a, "atmosphereHeight", 60)) + " " + num6(R + std::max(1.0, numIn(a, "altitudeOverSeaLevel", 0)) / 1000);
    auto add = [&](std::string_view k, std::array<double, 3> def, double scale) {
        for (double v : color255(a, k, def))
            s += " " + num6(v * scale);
    };
    add("rayleighScatteringCoefficient", {0.175287, 0.409607, 1}, numIn(a, "rayleighScatteringScale", 0.0331));
    s += " " + num6(numIn(a, "rayleighHeight", 8));
    add("mieScatteringCoefficient", {1, 1, 1}, numIn(a, "mieScatteringScale", 0.003996));
    add("mieAbsorptionCoefficient", {1, 1, 1}, numIn(a, "mieAbsorptionScale", 0.000444));
    s += " " + num6(numIn(a, "mieHeight", 1.2)) + " " + num6(numIn(a, "miePhase", 0.8));
    add("absorptionCoefficient", {0.345561, 1, 0.045188}, numIn(a, "absorptionScale", 0.001881));
    for (double v : color255(a, "planetGroundAlbedo", {170 / 255.0, 170 / 255.0, 170 / 255.0}))
        s += " " + num6(srgbToLinear(v));
    return s;
}

void applySceneEnvironment(const GameData &gd, const std::string &map, MapEnvironment &env) {
    std::vector<uint8_t> b;
    if (!gd.read("levels/maps/" + normalizeGamePath(map) + "/scene.mxml", b, nullptr))
        return;
    SceneEnv se;
    collectScene(textOf(b), env.id, se);
    if (!se.any)
        return; // (a 2.40 map: its preset is its look)
    setValue(env, "SceneEnvironment", "true");

    // the sun: where it is, how bright on the ground and of what colour (through the air unless
    // ignoreAtmosphere: then its groundLevelIlluminance numbers say it), its disc and light shafts
    if (const Attrs *L = se.light ? &*se.light : nullptr) {
        float ypr[3]{};
        hexFloats(attrIn(*L, "YPRHex"), ypr, 3);
        const auto d = lightDirection(ypr);
        const double el = std::asin(std::clamp(d[1], -1.0, 1.0)), az = std::atan2(-d[0], -d[2]);
        setValue(env, "SunDirVert", num6(el * 180 / kPiD + 90));
        const double hor = az * 180 / kPiD - env.rotation[0];
        setValue(env, "SunDirHor", num6(std::abs(hor) < 1e-9 ? 0 : hor)); // (the light stands in the map already: no turn of the map's)
        const bool ignoreAir = attrIn(*L, "ignoreAtmosphere") != "false";
        const auto bb = blackbody(numIn(L, "colorTemperature", 6500));
        const auto tint = ignoreAir ? color255(L, "groundLevelIlluminanceColorTint", {1, 1, 1}) : std::array<double, 3>{1, 1, 1};
        const double sun = std::max(0.0, numIn(L, "outerSpaceIlluminance", 0)) / kLuxPerGameUnit * std::max(0.0, numIn(L, "groundLevelIlluminanceScale", 1));
        std::array<double, 3> c{};
        for (int i = 0; i < 3; ++i)
            c[i] = srgbToLinear(tint[i]) * bb[i] * sun;
        if (!ignoreAir) {
            const auto T = airTransmittance(se.atmosphere ? &*se.atmosphere : nullptr, el);
            for (int i = 0; i < 3; ++i)
                c[i] *= T[i];
            setValue(env, "AtmosphereSunIllum", num6(c[0]) + " " + num6(c[1]) + " " + num6(c[2]));
        } else {
            setValue(env, "AtmosphereSunIllum", ""); // (the stub's 0 0 0 would put out the sun's disc)
        }
        setValue(env, "UseAtmosphereSunIllum", ignoreAir ? "false" : "true");
        setValue(env, "UseAtmosphereSunColor", ignoreAir ? "false" : "true");
        setValue(env, "SunIlluminance", num6(lumOf(c)));
        setValue(env, "SunColor", argbHex(lumOf(c) > 0 ? c : bb));
        setValue(env, "SunShadowsEnabled", attrIn(*L, "castShadows") != "false" && lumOf(c) > 0 ? "true" : "false"); // (no sun: no shadows of it)
        setValue(env, "SunDiscVisible", attrIn(*L, "drawDisk") == "false" ? "false" : "true");
        setValue(env, "SunDiscDiameter", num6(numIn(L, "diskAngularDiameter", 0.54)));
        setValue(env, "EnableLightShaft", attrIn(*L, "enableLightshafts") == "true" ? "true" : "false");
        const bool custom = attrIn(*L, "lightshaftsUseCustomColor") == "true";
        setValue(env, "LightShaftUseSunColor", custom ? "false" : "true");
        if (custom) {
            const auto t = color255(L, "lightshaftsCustomColor", {1, 1, 1});
            const uint32_t argb = 0xFF000000u | static_cast<uint32_t>(std::lround(t[0] * 255)) << 16 | static_cast<uint32_t>(std::lround(t[1] * 255)) << 8 | static_cast<uint32_t>(std::lround(t[2] * 255));
            setValue(env, "LightShaftTint", std::to_string(argb));
        }
    } else {
        setValue(env, "SunIlluminance", "0");
        setValue(env, "AtmosphereSunIllum", "");
        setValue(env, "UseAtmosphereSunIllum", "false");
        setValue(env, "SunShadowsEnabled", "false");
        setValue(env, "EnableLightShaft", "false");
    }

    // the sky: the backdrop's picture; else the air worked out from its SkyAtmosphere (Sky.cpp
    // renderAirSky: drawn as a picture is, its values light-probe units, column 0 towards the sun), lit by
    // the sun above it at its colour temperature; else none (the game's captures of the two such, the
    // screenshot map's and long_time_ago's night, are black)
    if (const Attrs *B = se.backdrop ? &*se.backdrop : nullptr) {
        setValue(env, "BackdropPath", std::string(attrIn(*B, "textureName")));
        setValue(env, "BackdropLuminance", num6(numIn(B, "luminanceScale", 1)));
        setValue(env, "BackdropUvShift", num6(numIn(B, "textureUvShift", 0)));
        const auto g = color255(B, "groundColor", {1, 1, 1});
        const double gl = numIn(B, "groundLuminance", 0) / kLuxPerGameUnit;
        setValue(env, "BackdropGround", num6(numIn(B, "groundOpacity", 0)) + " " + num6(srgbToLinear(g[0]) * gl) + " " + num6(srgbToLinear(g[1]) * gl) + " " + num6(srgbToLinear(g[2]) * gl));
        // its drift (ui/sky.js drift): "angle (degrees, in the picture's turn) zenith speed (degrees a
        // second) horizon correction, blend time (s), range (degrees)"
        const std::string_view range = attrIn(*B, "motionRangeAngles");
        setValue(env, "BackdropMotion", num6(numIn(B, "motionDirAngle", 0)) + " " + num6(numIn(B, "motionZenithSpeed", 0)) + " " + num6(numIn(B, "motionHorizonCorrection", 0.95)) + " " +
                                            num6(numIn(B, "motionBlendTime", 8)) + " " + (range.empty() ? std::string("-30 30") : std::string(range)));
        setValue(env, "AtmosphereId", "");
    } else {
        const Attrs *S = se.atmosphere ? &*se.atmosphere : nullptr, *L = se.light ? &*se.light : nullptr;
        if (S) {
            const auto bb = blackbody(numIn(L, "colorTemperature", 6500));
            const double top = L ? std::max(0.0, numIn(L, "outerSpaceIlluminance", 0)) / kLuxPerGameUnit / kProbeUnit : 0;
            setValue(env, "SkyAtmosphere", airNumbers(S));
            setValue(env, "SkyAtmosphereSun", num6(top * bb[0]) + " " + num6(top * bb[1]) + " " + num6(top * bb[2]));
        }
        setValue(env, "BackdropPath", S ? std::string(kAirSky) + ":" + map + ":" + env.id : std::string(kNoSky));
        setValue(env, "BackdropLuminance", "2048"); // (light-probe units already)
        setValue(env, "BackdropUvShift", "0");
        setValue(env, "BackdropGround", "0 0 0 0");
        setValue(env, "BackdropMotion", "");
        setValue(env, "AtmosphereId", "");
    }
    setValue(env, "SkyDomeModelPath", ""); // (the backdrop has its clouds in it)

    // the camera: exposure (EV100 - 7: lux / 128), its compensation, the glow of lamps and windows
    // (exposureEmissiveAndLocalLightsEC against the sun's: EmissiveLumScale = it - 6), white balance,
    // tone curve's toe, colour LUT
    const Attrs post = stackVolumes(se.post);
    if (!post.empty()) {
        const Attrs *P = &post;
        const bool manual = attrIn(post, "exposureMode") == "manual";
        setValue(env, "MinEV100", num6((manual ? numIn(P, "exposureEV100", 12) : numIn(P, "exposureMinEV100", -10)) - 7));
        setValue(env, "MaxEV100", num6((manual ? numIn(P, "exposureEV100", 12) : numIn(P, "exposureMaxEV100", 22)) - 7));
        setValue(env, "ExposureCompensation", num6(numIn(P, "exposureEC", 0)));
        setValue(env, "EmissiveLumScale", num6(numIn(P, "exposureEmissiveAndLocalLightsEC", 7) - 6));
        setValue(env, "WhiteTemperature", num6(numIn(P, "temperature", 6500)));
        setValue(env, "WhiteTint", num6(numIn(P, "temperatureTint", 0)));
        setValue(env, "TonemapToe", num6(numIn(P, "tonemapToe", 0)));
        setValue(env, "ColorRemapPath", std::string(attrIn(post, "colorLutFilename")));
    }

    // the fog (its volumes stacked): two layers, each "density (per metre, base 2) falloff (per metre,
    // base 2) height", none thicker than at its height; its colour the sky's x HeightFogInscatter (the
    // view takes it from the sky near the horizon), the sun's glow in it x HeightFogSunScatter; none
    // nearer than HeightFogStart. The layers' near fades and cutoffs (layerNnearFade*, nearCutoff,
    // farCutoff) are left out: read as a fade of the density towards the camera they fit the probes
    // worse (CROSSOUT_FORMATS.md)
    setValue(env, "FogDensity", "0");
    setValue(env, "FogAerialGain", "0");
    const Attrs fog = stackVolumes(se.fog);
    if (!fog.empty()) {
        const Attrs *F = &fog;
        auto layer = [&](const std::string &n) {
            return num6(std::max(0.0, numIn(F, n + "baseDensity", 0)) * kHeightFogDensity) + " " + num6(numIn(F, n + "heightFalloff", 0)) + " " + num6(numIn(F, n + "height", 0));
        };
        setValue(env, "HeightFog0", layer("layer0"));
        setValue(env, "HeightFog1", layer("layer1"));
        setValue(env, "HeightFogStart", num6(std::max(0.0, numIn(F, "drawDistanceStart", 0))));
        const auto alb = color255(F, "participatingMediaAlbedo", {1, 1, 1});
        const double s = std::max(0.0, numIn(F, "probeInscatteringIntesityScale", 1));
        setValue(env, "HeightFogInscatter", num6(s * alb[0]) + " " + num6(s * alb[1]) + " " + num6(s * alb[2]));
        setValue(env, "HeightFogSunScatter", num6(std::max(0.0, numIn(F, "directionalLightScatteringIntensityScale", 0))));
    }

    // the weather: wind, its particles
    if (const Attrs *W = se.weather ? &*se.weather : nullptr) {
        if (const std::string_view v = attrIn(*W, "windYaw"); !v.empty())
            setValue(env, "WindYaw", std::string(v));
        if (const std::string_view v = attrIn(*W, "windForce"); !v.empty())
            setValue(env, "WindForce", std::string(v));
        setValue(env, "AreaEffect", std::string(attrIn(*W, "areaEffect")));
        setValue(env, "AreaScreenEffect", std::string(attrIn(*W, "areaScreenEffect")));
    }

    // the weather's cover: snow, sand or a wet film on the faces turned up (byNormalsToUpVector: the
    // presets' DustByNormals), or a film low down (byHeightLinearGradient, 9 maps' everyday weathers:
    // all over below its gradient's min, thinning to none at its max, world heights: DustByHeight;
    // bridge's day capture is 0.45 EV darker below 10 m than above 20 m against the view without it)
    const Attrs dust = stackVolumes(se.dust);
    if (!dust.empty()) {
        const Attrs *D = &dust;
        const std::string_view mode = attrIn(dust, "dustBlendMode");
        const bool byNormals = mode == "byNormalsToUpVector", byHeight = mode == "byHeightLinearGradient", up = byNormals || byHeight;
        const bool props = attrIn(dust, "dustProps") == "true", land = attrIn(dust, "dustLandscape") == "true";
        const double strength = std::clamp(numIn(D, "dustTransparency", 0), 0.0, 1.0);
        const std::string mask(attrIn(dust, "dustMaskFilename"));
        const auto alb = color255(D, "dustAlbedo", {1, 1, 1});
        setValue(env, "DustEnabled", up && strength > 0 && (props || land) ? "true" : "false");
        setValue(env, "DustEnabledOnLand", up && strength > 0 && land ? "true" : "false");
        setValue(env, "DustEnabledOnProps", props ? "true" : "false");
        setValue(env, "DustEnabledOnCar", attrIn(dust, "dustCars") == "true" ? "true" : "false");
        char hex[16];
        std::snprintf(hex, sizeof(hex), "0xFF%02X%02X%02X", static_cast<int>(std::lround(alb[0] * 255)), static_cast<int>(std::lround(alb[1] * 255)), static_cast<int>(std::lround(alb[2] * 255)));
        setValue(env, "DustColor", hex); // (sRGB as written, as the presets' was)
        setValue(env, "DustTransparency", num6(strength));
        setValue(env, "DustGloss", num6(numIn(D, "dustGloss", 0)));
        setValue(env, "DustMetalness", num6(numIn(D, "dustMetalness", 0)));
        setValue(env, "DustByNormals", byNormals ? "true" : "false");
        setValue(env, "DustByHeight", byHeight ? std::string(attrIn(dust, "dustBlendModeGradientMinMax")) : std::string());
        // (the presets' DustHeight: the cover starts where a face turns up by 1 - it; 2.41's threshold is
        // that up-ness itself)
        const double up01 = 1 - std::clamp(numIn(D, "dustBlendModeThreshold", 0.5), 0.0, 1.0);
        setValue(env, "DustHeight", num6(up01));
        setValue(env, "DustSharpness", num6(numIn(D, "dustBlendModeSharpness", 0.5)));
        setValue(env, "DustLandHeight", num6(up01));
        setValue(env, "DustLandSharpness", num6(numIn(D, "dustBlendModeSharpness", 0.5)));
        setValue(env, "DustMaskEnabled", mask.empty() ? "false" : "true");
        setValue(env, "DustMaskPath", mask);
        setValue(env, "DustMaskScale", num6(numIn(D, "dustMaskCoverageSize", 128)));
    }
}

} // namespace

bool loadEnvironment(const GameData &gd, const std::string &map, const std::string &id, MapEnvironment &env, std::string *err) {
    env = MapEnvironment{};
    env.id = id;
    env.map = map;
    if (id.empty()) {
        if (err)
            *err = map + " names no environment";
        return false;
    }
    std::vector<uint8_t> b;
    if (gd.read("levels/maps/" + normalizeGamePath(map) + "/envsettings.mxml", b, nullptr))
        forEachTag(textOf(b), "Item", [&](std::string_view tag) {
            if (attrOf(tag, "Id") == id && env.name.empty()) {
                env.name = std::string(attrOf(tag, "Name"));
                hexFloats(attrOf(tag, "RotHex"), env.rotation, 3);
            }
        });
    if (!gd.read("assets/envsettings.mxml", b, err))
        return false;
    std::string_view tag;
    const std::string_view body = presetBody(textOf(b), id, &tag);
    if (body.empty()) {
        if (err)
            *err = "environment preset " + id + " not found";
        return false;
    }
    if (env.name.empty())
        env.name = std::string(attrOf(tag, "name"));
    env.values = presetValues(body);
    applySceneEnvironment(gd, map, env); // (Crossout 2.41: the scene's entities)
    return true;
}

bool loadLightProbes(const GameData &gd, const std::string &map, const std::string &envId, MapProbes &out, std::string *err) {
    out = MapProbes{};
    const std::string dir = "levels/maps/" + normalizeGamePath(map) + "/";
    std::vector<uint8_t> b;
    if (envId.empty() || !gd.read(dir + "light_probes/" + envId + ".xml", b, nullptr)) {
        if (err)
            *err = map + " has no light probes for environment " + envId;
        return false;
    }
    std::string global;
    std::vector<uint8_t> es;
    if (gd.read(dir + "envsettings.mxml", es, nullptr))
        forEachTag(textOf(es), "EnvSettings", [&](std::string_view tag) { global = lower(attrOf(tag, "GlobalLightProbeID")); });
    // "light_probes/x.dds": the .tfh/.tfd pair x, in the map's folder
    auto base = [&](std::string_view p) {
        std::string s = normalizeGamePath(p);
        if (s.size() > 4 && s.compare(s.size() - 4, 4, ".dds") == 0)
            s.resize(s.size() - 4);
        return s.empty() ? s : dir + s;
    };
    // The older files name captures the game has baked again since under the newer names (reflection_
    // -> specular_, irradiance_ -> diffuse_, fog_inscattering_ -> fog_inscattering_probe_), and two
    // name ones that are gone, baked again under another number: the newer one
    auto newer = [&](const std::string &name, std::string_view from, std::string_view to) {
        const size_t at = name.rfind('/') + 1;
        if (name.compare(at, from.size(), from) != 0)
            return name;
        const std::string again = name.substr(0, at) + std::string(to) + name.substr(at + from.size());
        if (gd.find(again + ".tfh"))
            return again;
        if (gd.find(name + ".tfh"))
            return name;
        for (int n = 0; n < 8; ++n)
            if (const std::string other = dir + "light_probes/" + std::string(to) + envId + "_" + std::to_string(n); gd.find(other + ".tfh"))
                return other;
        return name;
    };
    forEachTag(textOf(b), "FogLightingProbe", [&](std::string_view tag) { out.inscattering = newer(base(attrOf(tag, "Inscattering")), "fog_inscattering_", "fog_inscattering_probe_"); });
    forEachTag(textOf(b), "LightProbe", [&](std::string_view tag) {
        LightProbe p;
        p.id = std::string(attrOf(tag, "ProbeID"));
        p.specular = newer(base(attrOf(tag, "Specular")), "reflection_", "specular_");
        p.diffuse = newer(base(attrOf(tag, "Diffuse")), "irradiance_", "diffuse_");
        hexFloats(attrOf(tag, "Center"), p.center, 3);
        hexFloats(attrOf(tag, "Rotation"), p.rotation, 3);
        hexFloats(attrOf(tag, "HalfExtendsMin"), p.halfMin, 3);
        hexFloats(attrOf(tag, "HalfExtendsMax"), p.halfMax, 3);
        hexFloats(attrOf(tag, "EnvColor"), p.envColor, 3);
        p.global = !global.empty() && lower(p.id) == global;
        if (!p.specular.empty())
            out.probes.push_back(std::move(p));
    });
    if (out.probes.empty()) {
        if (err)
            *err = dir + "light_probes/" + envId + ".xml names no light probe";
        return false;
    }
    // the global one first (a file without a match: its first probe)
    std::stable_partition(out.probes.begin(), out.probes.end(), [](const LightProbe &p) { return p.global; });
    out.probes[0].global = true;
    return true;
}

uint16_t floatToHalf(float f) {
    uint32_t x;
    std::memcpy(&x, &f, 4);
    const uint32_t sign = (x >> 16) & 0x8000, exp8 = (x >> 23) & 0xff;
    uint32_t m = x & 0x7fffff;
    if (exp8 == 0xff)
        return static_cast<uint16_t>(sign | 0x7c00 | (m ? 0x200 : 0)); // inf, nan
    const int e = static_cast<int>(exp8) - 127 + 15;
    if (e >= 31)
        return static_cast<uint16_t>(sign | 0x7c00);
    if (e <= 0) { // a subnormal half, or zero
        if (e < -10)
            return static_cast<uint16_t>(sign);
        m |= 0x800000;
        const int shift = 14 - e;
        uint32_t h = m >> shift;
        if ((m >> (shift - 1)) & 1)
            ++h;
        return static_cast<uint16_t>(sign | h);
    }
    uint32_t h = (static_cast<uint32_t>(e) << 10) | (m >> 13);
    if (m & 0x1000)
        ++h; // (a carry runs into the exponent, as it should)
    return static_cast<uint16_t>(sign | h);
}

bool loadAtmosphere(const GameData &gd, const std::string &guid, Atmosphere &a, std::string *err) {
    a = Atmosphere{};
    a.guid = guid;
    auto fail = [&](const std::string &m) {
        if (err)
            *err = m;
        return false;
    };
    const std::string pre = "levels/atmospheres/";
    std::vector<uint8_t> b;
    const std::string want = lower(guid);
    for (const auto &e : gd.entries()) {
        if (e.name.rfind(pre, 0) != 0 || e.name.size() < 15 || e.name.compare(e.name.size() - 15, 15, "/atmosphere.xml") != 0)
            continue;
        if (!gd.read(e.name, b, nullptr))
            continue;
        bool match = false;
        forEachTag(textOf(b), "Atmosphere", [&](std::string_view tag) { match = match || lower(attrOf(tag, "Guid")) == want; });
        if (!match)
            continue;
        a.dir = e.name.substr(0, e.name.size() - 15);
        forEachTag(textOf(b), "Uniforms", [&](std::string_view tag) {
            // name="value" pairs, in order
            size_t p = 0;
            while ((p = tag.find('=', p)) != std::string_view::npos) {
                size_t k = p;
                while (k > 0 && tag[k - 1] != ' ')
                    --k;
                if (p + 1 >= tag.size() || tag[p + 1] != '"')
                    break;
                const size_t q = tag.find('"', p + 2);
                if (q == std::string_view::npos)
                    break;
                a.uniforms.emplace_back(std::string(tag.substr(k, p - k)), std::string(tag.substr(p + 2, q - p - 2)));
                p = q + 1;
            }
        });
        break;
    }
    if (a.dir.empty())
        return fail("atmosphere " + guid + " not found");
    struct Want {
        const char *name;
        size_t bytes;
        std::vector<uint8_t> *dst;
    } wants[] = {{"transmittance", 256 * 64 * 16, &a.transmittance}, {"irradiance", 64 * 16 * 16, &a.irradiance}, {"scattering", 256 * 128 * 32 * 8, &a.scattering}};
    for (const auto &w : wants) {
        Texture t;
        std::string e;
        if (!loadTexture(gd, a.dir + "/" + w.name, t, &e))
            return fail(e);
        const uint8_t *p = nullptr;
        size_t n = 0;
        if (t.levelData(0, p, n) && w.dst == &a.scattering && n == w.bytes * 2) {
            // some atmospheres (atmosphere_dense, bright_moon) keep it as 32-bit floats: to halves,
            // as the others have it
            w.dst->resize(w.bytes);
            for (size_t i = 0; i < w.bytes / 2; ++i) {
                float f;
                std::memcpy(&f, p + i * 4, 4);
                const uint16_t h = floatToHalf(f);
                std::memcpy(w.dst->data() + i * 2, &h, 2);
            }
            continue;
        }
        if (!p || n != w.bytes)
            return fail(a.dir + "/" + w.name + ": unexpected size " + std::to_string(n));
        w.dst->assign(p, p + n);
    }
    return true;
}

// ---- grass ---------------------------------------------------------------------------------------
namespace {

// The terrain's size in metres (x, z) from landscape.mxml (SectorsX x 16 x CellSize ...), centred
// on the origin; false without one.
bool terrainSize(const GameData &gd, const std::string &map, float size[2]) {
    std::vector<uint8_t> lx;
    size[0] = size[1] = 0;
    if (gd.read("levels/maps/" + normalizeGamePath(map) + "/landscape/landscape.mxml", lx, nullptr))
        forEachTag(textOf(lx), "Dimensions", [&](std::string_view tag) {
            const float cell = numberOf(attrOf(tag, "CellSize"), 0);
            size[0] = numberOf(attrOf(tag, "SectorsX"), 0) * 16 * cell;
            size[1] = numberOf(attrOf(tag, "SectorsZ"), 0) * 16 * cell;
        });
    return size[0] > 0 && size[1] > 0;
}

} // namespace

bool loadGrass(const GameData &gd, const std::string &map, MapGrass &g, std::string *err) {
    g = MapGrass{};
    const std::string path = "levels/maps/" + normalizeGamePath(map) + "/grass.dat";
    auto fail = [&](const std::string &m) {
        if (err)
            *err = path + ": " + m;
        return false;
    };
    if (!gd.find(path))
        return fail("no grass on this map");
    std::vector<uint8_t> b;
    if (!gd.read(path, b, err))
        return false;
    if (b.size() < 48)
        return fail("too short");
    uint32_t h[12];
    std::memcpy(h, b.data(), sizeof(h));
    // Version 15: u16 version, u16 ffff, 0, 2, types, records, blocks, 0, gridX, gridZ, f32 cell size,
    // 0, 0, then the types' grass preset ids. Version 13 (bentmetal, the drone-battle arenas,
    // craterarena_duel, experimental_map): u16 13, u16 ffff, 0, 1|2, types, records, blocks, 0, 0, then
    // the ids at byte 32; no grid (worked out below from where the tufts lie).
    const uint32_t version = h[0] & 0xFFFF, nTypes = h[3], nRecords = h[4], nBlocks = h[5];
    size_t presets = 48;
    if (version == 15) {
        g.gridX = static_cast<int>(h[7]);
        g.gridZ = static_cast<int>(h[8]);
        g.cellSize = std::bit_cast<float>(h[9]);
        if (nTypes == 0 || nTypes > 256 || g.gridX <= 0 || g.gridZ <= 0 || g.gridX > 4096 || g.gridZ > 4096 || !(g.cellSize > 0))
            return fail("unknown header");
    } else if (version == 13) {
        presets = 32;
        if (nTypes == 0 || nTypes > 256)
            return fail("unknown header");
    } else {
        return fail("unknown header");
    }
    const size_t head = presets + static_cast<size_t>(nTypes) * 4;
    if (head + static_cast<size_t>(nBlocks) * 32 + static_cast<size_t>(nRecords) * 32 != b.size())
        return fail("size does not match its header");
    std::vector<uint8_t> gx;
    const bool haveList = gd.read("assets/grass.mxml", gx, nullptr);
    for (uint32_t i = 0; i < nTypes; ++i) {
        GrassType t;
        std::memcpy(&t.preset, b.data() + presets + i * 4, 4);
        std::string_view tag;
        const std::string_view body = haveList ? presetBody(textOf(gx), std::to_string(t.preset), &tag) : std::string_view{};
        t.name = std::string(attrOf(tag, "name"));
        for (const auto &[k, v] : presetValues(body)) {
            if (k == "model")
                t.model = normalizeGamePath(v) + ".mdl";
            else if (k == "dist_factor")
                t.distFactor = numberOf(v, 0.3f);
            else if (k == "wind_intensity")
                t.wind = numberOf(v, 0);
            else if (k == "luminance_modifier")
                t.luminance = numberOf(v, 10);
            else if (k == "align_to_normal")
                t.alignToNormal = v == "true";
            else if (k == "cloaking_range_max")
                t.cloak = std::clamp(numberOf(v, 0.5f), 0.0f, 1.0f);
        }
        g.types.push_back(std::move(t));
    }
    g.items.reserve(nRecords);
    size_t o = head;
    for (uint32_t k = 0; k < nBlocks; ++k) {
        uint32_t bh[8];
        std::memcpy(bh, b.data() + o, 32);
        GrassCell c;
        c.count = bh[0];
        c.cell = static_cast<int>(bh[1]);
        c.type = static_cast<int>(bh[2]);
        c.minY = std::bit_cast<float>(bh[4]);
        c.maxY = std::bit_cast<float>(bh[5]);
        c.first = static_cast<uint32_t>(g.items.size());
        o += 32;
        if (c.type < 0 || c.type >= static_cast<int>(nTypes) || o + static_cast<size_t>(c.count) * 32 > b.size())
            return fail("bad block " + std::to_string(k));
        for (uint32_t r = 0; r < c.count; ++r, o += 32) {
            const uint8_t *p = b.data() + o;
            GrassInstance it;
            std::memcpy(it.pos, p, 12);
            if (version == 13) {
                // u16 scale * 8192, half rank, f32 quaternion x y z w
                uint16_t sc, rk;
                std::memcpy(&sc, p + 12, 2);
                std::memcpy(&rk, p + 14, 2);
                float q[4];
                std::memcpy(q, p + 16, 16);
                float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
                if (!(l > 1e-6f) || !std::isfinite(l))
                    q[0] = q[1] = q[2] = 0, q[3] = 1, l = 1;
                for (int i = 0; i < 4; ++i)
                    it.rot[i] = q[i] / l;
                it.scale = sc / 8192.0f;
                it.rank = half2f(rk);
                g.items.push_back(it);
                continue;
            }
            uint16_t v[6];
            std::memcpy(v, p + 12, 12);
            // u16 (scale + 1) x 16384, half rank, half quaternion x y z (w >= 0 from the rest), a half
            // that is the scale / 2048 on most maps (garbage near 200 on helicopter_asia_city and fuji:
            // the u16 is the one to read), 8 zero bytes
            it.scale = std::max(0.05f, v[0] / 16384.0f - 1);
            it.rank = half2f(v[1]);
            it.rot[0] = half2f(v[2]);
            it.rot[1] = half2f(v[3]);
            it.rot[2] = half2f(v[4]);
            it.rot[3] = std::sqrt(std::max(0.0f, 1 - it.rot[0] * it.rot[0] - it.rot[1] * it.rot[1] - it.rot[2] * it.rot[2]));
            g.items.push_back(it);
        }
        g.cells.push_back(c);
    }
    if (version == 13) {
        // The cells: a square grid of G x G (a power of two) centred on the terrain, cell = row * G +
        // col; exactly one G puts the tufts in their own cells (32, 16, 8, 32, 128 on the five maps).
        float sizes[2];
        terrainSize(gd, map, sizes);
        bool found = false;
        for (float S : sizes) {
            if (!(S > 0) || found)
                continue;
            for (int G = 2; G <= 1024 && !found; G *= 2) {
                const float cs = S / G, x0 = -S / 2;
                size_t tried = 0, inside = 0;
                const size_t step = std::max<size_t>(1, g.cells.size() / 400);
                for (size_t k = 0; k < g.cells.size(); k += step) {
                    const GrassCell &c = g.cells[k];
                    for (uint32_t r = 0; r < std::min<uint32_t>(c.count, 4); ++r) {
                        const GrassInstance &it = g.items[c.first + r];
                        const int col = static_cast<int>(std::floor((it.pos[0] - x0) / cs)), row = static_cast<int>(std::floor((it.pos[2] - x0) / cs));
                        ++tried;
                        inside += col >= 0 && row >= 0 && col < G && row < G && row * G + col == c.cell;
                    }
                }
                if (tried && inside * 100 >= tried * 99) {
                    g.gridX = g.gridZ = G;
                    g.cellSize = cs;
                    found = true;
                }
            }
        }
        if (!found)
            return fail("version 13: no cell grid fits the tufts");
    }
    g.x0 = -g.gridX * g.cellSize * 0.5f;
    g.z0 = -g.gridZ * g.cellSize * 0.5f;
    return true;
}

void grassMatrix(const GrassInstance &g, float out[16]) {
    // the quaternion's rotation in game space, then mirrored like everything else (F R F, F = diag(1, 1, -1))
    const float x = g.rot[0], y = g.rot[1], z = g.rot[2], w = g.rot[3];
    const float r[9] = {1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
                        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
                        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)}; // row-major
    const float f[3] = {1, 1, -1};
    for (int c = 0; c < 3; ++c) {
        for (int row = 0; row < 3; ++row)
            out[c * 4 + row] = r[row * 3 + c] * g.scale * f[row] * f[c];
        out[c * 4 + 3] = 0;
    }
    out[12] = g.pos[0];
    out[13] = g.pos[1];
    out[14] = -g.pos[2];
    out[15] = 1;
}

namespace {

// One of a map's grass colour maps: a picture of the ground from above (RGBA8, row 0 = its +Z edge)
// over a box in game space turned by yaw about Y (the terrain's own: the whole terrain, any height).
struct GroundColors {
    ImageRGBA img;
    float centre[3]{}, half[3]{}, yaw = 0;
};

// How strongly the ground's colour carries into the grass: tint = (ground / the mean ground under
// all the map's grass) ^ this (fitted to the light probes' and loading pictures' grass).
constexpr float kGrassTint = 0.5f;

} // namespace

bool grassTints(const GameData &gd, const std::string &map, const MapGrass &g, std::vector<float> &rgb, std::string *err) {
    rgb.assign(g.items.size() * 3, 1.0f);
    const std::string dir = "levels/maps/" + normalizeGamePath(map) + "/";
    auto load = [&](const std::string &guid, GroundColors &c, std::string *e) {
        Texture t;
        return loadTexture(gd, dir + "grasslms/" + guid, t, e) && decodeLevel(t, t.firstLevel(), c.img.rgba, c.img.w, c.img.h, e);
    };
    std::vector<GroundColors> maps(1);
    float size[2];
    if (!terrainSize(gd, map, size)) {
        if (err)
            *err = map + " has no terrain";
        return false;
    }
    if (!load("00000000000000000000000000000000", maps[0], err))
        return false;
    maps[0].half[0] = size[0] / 2;
    maps[0].half[1] = 1e9f;
    maps[0].half[2] = size[1] / 2;
    // the boxes' own maps, the smallest first (it is the one a tuft in several boxes takes)
    std::vector<uint8_t> xml;
    std::vector<GroundColors> boxes;
    if (gd.read(dir + "colormaps.xml", xml, nullptr))
        forEachTag(textOf(xml), "Colormap", [&](std::string_view tag) {
            GroundColors c;
            std::string guid;
            for (char ch : lower(attrOf(tag, "Guid")))
                if (ch != '-')
                    guid += ch;
            if (hexFloats(attrOf(tag, "Center"), c.centre, 3) == 3 && hexFloats(attrOf(tag, "HalfExtents"), c.half, 3) == 3 && load(guid, c, nullptr)) {
                c.yaw = hexFloat(attrOf(tag, "YawDeg")) * kPi / 180;
                boxes.push_back(std::move(c));
            }
        });
    std::sort(boxes.begin(), boxes.end(), [](const GroundColors &a, const GroundColors &b) { return a.half[0] * a.half[1] * a.half[2] < b.half[0] * b.half[1] * b.half[2]; });
    boxes.push_back(std::move(maps[0]));
    float lut[256];
    for (int i = 0; i < 256; ++i)
        lut[i] = srgbToLinear(i / 255.0f);
    std::vector<uint8_t> found(g.items.size(), 0);
    double sum[3] = {};
    size_t n = 0;
    for (size_t i = 0; i < g.items.size(); ++i) {
        const float *p = g.items[i].pos;
        for (const GroundColors &c : boxes) {
            // the box's own frame (its texture's x runs along local x, its rows down from local +z)
            const float dx = p[0] - c.centre[0], dz = p[2] - c.centre[2], cs = std::cos(c.yaw), sn = std::sin(c.yaw);
            const float lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
            if (std::abs(lx) > c.half[0] || std::abs(lz) > c.half[2] || std::abs(p[1] - c.centre[1]) > c.half[1])
                continue;
            const float x = std::clamp((lx / c.half[0] * 0.5f + 0.5f) * c.img.w - 0.5f, 0.0f, c.img.w - 1.0f);
            const float y = std::clamp((0.5f - lz / c.half[2] * 0.5f) * c.img.h - 0.5f, 0.0f, c.img.h - 1.0f);
            const uint32_t x0 = static_cast<uint32_t>(x), y0 = static_cast<uint32_t>(y), x1 = std::min(x0 + 1, c.img.w - 1), y1 = std::min(y0 + 1, c.img.h - 1);
            const float fx = x - x0, fy = y - y0;
            auto at = [&](uint32_t xi, uint32_t yi, int k) { return lut[c.img.rgba[(static_cast<size_t>(yi) * c.img.w + xi) * 4 + k]]; };
            for (int k = 0; k < 3; ++k) {
                rgb[i * 3 + k] = (at(x0, y0, k) * (1 - fx) + at(x1, y0, k) * fx) * (1 - fy) + (at(x0, y1, k) * (1 - fx) + at(x1, y1, k) * fx) * fy;
                sum[k] += rgb[i * 3 + k];
            }
            found[i] = 1;
            ++n;
            break;
        }
    }
    for (int k = 0; k < 3; ++k) {
        const float ref = static_cast<float>(sum[k] / std::max<size_t>(1, n));
        for (size_t i = 0; i < g.items.size(); ++i) // (off the terrain: its own colour)
            rgb[i * 3 + k] = found[i] && ref > 0 ? std::clamp(std::pow(rgb[i * 3 + k] / ref, kGrassTint), 0.6f, 1.6f) : 1.0f;
    }
    return true;
}

// ---- decals --------------------------------------------------------------------------------------
std::map<uint32_t, DecalPreset> readDecalPresets(const GameData &gd) {
    std::map<uint32_t, DecalPreset> out;
    std::vector<uint8_t> b;
    if (!gd.read("assets/decals.mxml", b, nullptr))
        return out;
    const std::string_view t = textOf(b);
    auto floats = [](std::string_view v, float *dst, int n) {
        int k = 0;
        for (size_t a = 0; a < v.size() && k < n;) {
            size_t z = v.find(' ', a);
            if (z == std::string_view::npos)
                z = v.size();
            if (z > a)
                dst[k++] = numberOf(v.substr(a, z - a), 0);
            a = z + 1;
        }
        return k;
    };
    size_t p = 0;
    while ((p = t.find("<Preset ", p)) != std::string_view::npos) {
        const size_t tagEnd = t.find('>', p), end = t.find("</Preset>", p);
        if (tagEnd == std::string_view::npos || end == std::string_view::npos)
            break;
        const std::string_view tag = t.substr(p + 1, tagEnd - p - 1), body = t.substr(tagEnd + 1, end - tagEnd - 1);
        DecalPreset d;
        const std::string_view ids = attrOf(tag, "id");
        std::from_chars(ids.data(), ids.data() + ids.size(), d.id);
        d.name = std::string(attrOf(tag, "name"));
        bool albedoRect = false;
        for (const auto &[k, v] : presetValues(body)) {
            if (k == "AlbedoPath")
                d.albedo = normalizeGamePath(v);
            else if (k == "NormalPath")
                d.normal = normalizeGamePath(v);
            else if (k == "SpecularPath")
                d.spec = normalizeGamePath(v);
            else if (k == "NormalRect")
                floats(v, d.normalRect, 4);
            else if (k == "AlbedoRect")
                albedoRect = floats(v, d.albedoRect, 4) == 4;
            else if (k == "UniformAlbedo") {
                float c[4]{255, 255, 255, 0};
                floats(v, c, 4);
                for (int i = 0; i < 3; ++i)
                    d.uniform[i] = static_cast<uint8_t>(std::clamp(c[i], 0.0f, 255.0f));
            } else if (k == "DefaultSize")
                d.size = numberOf(v, 1);
            else if (k == "DefaultThickness")
                d.thickness = numberOf(v, 1);
            else if (k == "ZFadeFactor")
                d.zFade = numberOf(v, 0.4f);
            else if (k == "AngleFadeFactor")
                d.angleFade = numberOf(v, 0.2f);
            else if (k == "AlbedoOpacity")
                d.albedoOpacity = numberOf(v, 1);
            else if (k == "UseFadeByNormal")
                d.fadeByNormal = v == "true";
            else if (k == "UniformGloss")
                d.gloss = std::clamp(numberOf(v, 0), 0.0f, 1.0f);
            else if (k == "UniformMetalness")
                d.metal = std::clamp(numberOf(v, 0), 0.0f, 1.0f);
            else if (k == "NormalOpacity")
                d.normalOpacity = std::clamp(numberOf(v, 1), 0.0f, 1.0f);
            else if (k == "UseGlow")
                d.glow = v == "true";
            else if (k == "UseGlowColorFromAlbedo")
                d.glowFromAlbedo = v == "true";
            else if (k == "UniformGlow")
                rgbOf(v, d.glowColor);
            else if (k == "GlowLuminance")
                d.glowEv = numberOf(v, 0);
        }
        forEachTag(body, "DrawMask", [&](std::string_view m) { // (onStatic="false": never on walls and props, whatever the decal says)
            d.onStatic = attrOf(m, "onStatic") != "false";
            d.onLandscape = attrOf(m, "onLandscape") != "false";
        });
        if (!albedoRect)
            std::memcpy(d.albedoRect, d.normalRect, sizeof(d.albedoRect));
        if (d.id)
            out[d.id] = std::move(d);
        p = end;
    }
    return out;
}

namespace {

// Triangles of a model's finest LOD (glTF space, the model's own frame), without see-through and
// foliage materials (decals do not lie on glass or leaves).
struct DecalTarget {
    bool ok = false;
    float mn[3]{}, mx[3]{};
    std::vector<float> pos;
    std::vector<uint32_t> idx;
};

const DecalTarget &decalTarget(const GameData &gd, const std::string &path, std::unordered_map<std::string, DecalTarget> &cache) {
    auto it = cache.find(path);
    if (it != cache.end())
        return it->second;
    DecalTarget &t = cache[path];
    ModelBundle b;
    if (!loadBundle(gd, path, "", b, nullptr))
        return t;
    for (const auto &me : b.model.meshes) {
        if (me.lod != 0)
            continue;
        const MaterialView *mv = me.material < b.materials.size() ? &b.materials[me.material] : nullptr;
        if (mv && (mv->invisible || mv->blend || mv->foliage))
            continue;
        MeshGeometry g;
        if (!decodeMesh(b.model, me, g, nullptr))
            continue;
        const uint32_t base = static_cast<uint32_t>(t.pos.size() / 3);
        t.pos.insert(t.pos.end(), g.position.begin(), g.position.end());
        for (uint32_t i : g.indices)
            t.idx.push_back(base + i);
    }
    if (t.pos.empty())
        return t;
    for (int k = 0; k < 3; ++k) {
        t.mn[k] = 1e30f;
        t.mx[k] = -1e30f;
    }
    for (size_t i = 0; i < t.pos.size(); ++i) {
        t.mn[i % 3] = std::min(t.mn[i % 3], t.pos[i]);
        t.mx[i % 3] = std::max(t.mx[i % 3], t.pos[i]);
    }
    t.ok = true;
    return t;
}

struct V3 {
    float x, y, z;
};
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator*(V3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
inline float dot3(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline V3 cross3(V3 a, V3 b) { return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }
inline float comp(const V3 &v, int k) { return k == 0 ? v.x : k == 1 ? v.y : v.z; }

} // namespace

bool buildDecalMeshes(const GameData &gd, const MapScene &scene, const std::map<uint32_t, DecalPreset> &presets, int terrainStep,
                      std::vector<DecalMesh> &out, std::vector<std::string> &warnings, size_t maxTriangles) {
    out.clear();
    std::unordered_map<std::string, DecalTarget> targets;
    std::unordered_map<std::string, std::pair<uint32_t, uint32_t>> texSize; // texture base -> width, height
    auto sizeOf = [&](const std::string &base) {
        auto it = texSize.find(base);
        if (it != texSize.end())
            return it->second;
        Texture t;
        std::pair<uint32_t, uint32_t> wh{1, 1};
        if (!base.empty() && loadTexture(gd, base, t, nullptr, false) && t.info.width && t.info.height)
            wh = {t.info.width, t.info.height};
        texSize[base] = wh;
        return wh;
    };
    // the static objects decals can lie on (not trees), with their glTF matrices and world boxes
    struct Obj {
        float m[16];
        float mn[3], mx[3];
        const DecalTarget *t;
        int index; // in scene.objects
    };
    std::vector<Obj> objs;
    auto prepareObjects = [&]() {
        for (size_t oi = 0; oi < scene.objects.size(); ++oi) {
            const MapObject &o = scene.objects[oi];
            if (o.group == "trees")
                continue;
            const DecalTarget &t = decalTarget(gd, o.model, targets);
            if (!t.ok)
                continue;
            Obj ob;
            mapObjectMatrix(o, ob.m);
            ob.t = &t;
            ob.index = static_cast<int>(oi);
            for (int k = 0; k < 3; ++k) {
                ob.mn[k] = 1e30f;
                ob.mx[k] = -1e30f;
            }
            for (int c = 0; c < 8; ++c) {
                const float lx = c & 1 ? t.mx[0] : t.mn[0], ly = c & 2 ? t.mx[1] : t.mn[1], lz = c & 4 ? t.mx[2] : t.mn[2];
                for (int k = 0; k < 3; ++k) {
                    const float v = ob.m[k] * lx + ob.m[4 + k] * ly + ob.m[8 + k] * lz + ob.m[12 + k];
                    ob.mn[k] = std::min(ob.mn[k], v);
                    ob.mx[k] = std::max(ob.mx[k], v);
                }
            }
            objs.push_back(ob);
        }
    };
    const Terrain &tr = scene.terrain;
    const int step = terrainStep > 0 ? terrainStep : std::max(1, (std::max(tr.cellsX, tr.cellsZ) + 1023) / 1024);
    std::set<uint32_t> missing;
    // each decal's preset and its texture's size (one by one: they are cached), and the objects they
    // can lie on, their models read side by side (the slow part: every model's mesh)
    std::vector<const DecalPreset *> preset(scene.decals.size(), nullptr);
    std::vector<std::pair<uint32_t, uint32_t>> texWh(scene.decals.size());
    bool anyStatic = false;
    for (size_t di = 0; di < scene.decals.size(); ++di) {
        const MapDecal &d = scene.decals[di];
        auto pit = presets.find(d.preset);
        if (pit == presets.end()) {
            missing.insert(d.preset);
            continue;
        }
        preset[di] = &pit->second;
        texWh[di] = sizeOf(pit->second.albedo.empty() ? pit->second.normal : pit->second.albedo);
        anyStatic = anyStatic || (d.onStatic && pit->second.onStatic);
    }
    if (anyStatic) {
        std::vector<std::string> paths;
        std::set<std::string> seen;
        for (const MapObject &o : scene.objects)
            if (o.group != "trees" && seen.insert(o.model).second)
                paths.push_back(o.model);
        std::vector<DecalTarget> read(paths.size());
        parallelFor(paths.size(), [&](size_t i) {
            std::unordered_map<std::string, DecalTarget> one;
            decalTarget(gd, paths[i], one);
            read[i] = std::move(one[paths[i]]);
        });
        for (size_t i = 0; i < paths.size(); ++i)
            targets.emplace(paths[i], std::move(read[i]));
        prepareObjects();
    }
    // every decal's meshes side by side, each its own list (put together after, in the decals' order)
    std::vector<std::vector<DecalMesh>> made(scene.decals.size());
    parallelFor(scene.decals.size(), [&](size_t di) {
        if (!preset[di])
            return;
        const MapDecal &d = scene.decals[di];
        const DecalPreset &pr = *preset[di];
        const float *rect = pr.albedo.empty() ? pr.normalRect : pr.albedoRect;
        // the box: X across the texture's width, Z along its height (keeping the texels square),
        // Y the projection depth
        const auto wh = texWh[di];
        const float aspect = rect[2] > 0 && rect[3] > 0 ? (rect[3] * wh.second) / (rect[2] * wh.first) : 1.0f;
        const float hx = 0.5f * pr.size * std::max(0.01f, d.scale[0]);
        const float hz = 0.5f * pr.size * std::max(0.01f, d.scale[2]) * aspect;
        const float hy = 0.5f * pr.thickness * std::max(0.01f, d.scale[1]);
        MapObject box;
        std::memcpy(box.pos, d.pos, sizeof(box.pos));
        std::memcpy(box.ypr, d.ypr, sizeof(box.ypr));
        float M[16];
        mapObjectMatrix(box, M);
        const V3 C{M[12], M[13], M[14]}, AX{M[0], M[1], M[2]}, AY{M[4], M[5], M[6]}, AZ{M[8], M[9], M[10]};
        float bmn[3], bmx[3]; // world bounds of the box
        for (int k = 0; k < 3; ++k) {
            const float e = std::abs(comp(AX, k)) * hx + std::abs(comp(AY, k)) * hy + std::abs(comp(AZ, k)) * hz;
            bmn[k] = comp(C, k) - e;
            bmx[k] = comp(C, k) + e;
        }
        // what lies on one surface (the terrain, then each object in turn) goes out as a mesh of its own
        DecalMesh mesh;
        mesh.decal = static_cast<int>(di);
        auto flush = [&](int object) {
            if (!mesh.indices.empty()) {
                mesh.object = object;
                made[di].push_back(std::move(mesh));
            }
            mesh = DecalMesh{};
            mesh.decal = static_cast<int>(di);
        };
        auto local = [&](V3 p) {
            const V3 q = p - C;
            return V3{dot3(q, AX) / hx, dot3(q, AY) / hy, dot3(q, AZ) / hz};
        };
        const float angleFade = pr.fadeByNormal ? std::max(0.02f, pr.angleFade) : 0.0f;
        const float zFade = std::clamp(pr.zFade, 0.0f, 1.0f);
        std::vector<V3> poly, next;
        auto addTriangle = [&](V3 a, V3 b, V3 c) {
            V3 n = cross3(b - a, c - a);
            const float len = std::sqrt(dot3(n, n));
            if (len < 1e-9f)
                return;
            n = n * (1 / len);
            const float facing = dot3(n, AY);
            // (faces away from the projection) The volume presets (UseFadeByNormal false: light_quad,
            // volume_quad / _z / gradient / asid, football_shadow and 4 more) paint every face in their
            // box: newyear_foray's light_quad boxes stand on the roof ridges with Y across them, and the
            // game's capture shows their glow on the slope facing the probe, the one turned away from Y.
            if (pr.fadeByNormal && facing <= 0.02f)
                return;
            // clip against the box: |x|, |y|, |z| <= 1 in box units
            poly = {local(a), local(b), local(c)};
            for (int plane = 0; plane < 6 && !poly.empty(); ++plane) {
                const int axis = plane / 2;
                const float sgn = plane % 2 ? -1.0f : 1.0f;
                auto dist = [&](const V3 &v) { return 1 - sgn * comp(v, axis); }; // >= 0 inside
                next.clear();
                for (size_t i = 0; i < poly.size(); ++i) {
                    const V3 &p = poly[i], &q = poly[(i + 1) % poly.size()];
                    const float dp = dist(p), dq = dist(q);
                    if (dp >= 0)
                        next.push_back(p);
                    if ((dp >= 0) != (dq >= 0))
                        next.push_back(p + (q - p) * (dp / (dp - dq)));
                }
                poly.swap(next);
            }
            if (poly.size() < 3)
                return;
            const float fa = angleFade > 0 ? std::clamp((facing - 0.02f) / angleFade, 0.0f, 1.0f) : 1.0f;
            const uint32_t base = static_cast<uint32_t>(mesh.position.size() / 3);
            for (const V3 &l : poly) {
                const V3 w = C + AX * (l.x * hx) + AY * (l.y * hy) + AZ * (l.z * hz) + n * 0.02f; // (a little above the surface)
                mesh.position.insert(mesh.position.end(), {w.x, w.y, w.z});
                mesh.normal.insert(mesh.normal.end(), {n.x, n.y, n.z});
                const float u = 0.5f + 0.5f * l.x, v = 0.5f + 0.5f * l.z;
                mesh.uv.insert(mesh.uv.end(), {rect[0] + u * rect[2], rect[1] + v * rect[3]});
                const float fz = zFade > 0 ? std::clamp((1 - std::abs(l.y)) / zFade, 0.0f, 1.0f) : 1.0f;
                mesh.fade.push_back(fa * fz);
            }
            for (size_t i = 1; i + 1 < poly.size(); ++i)
                mesh.indices.insert(mesh.indices.end(), {base, base + static_cast<uint32_t>(i), base + static_cast<uint32_t>(i + 1)});
        };
        if (d.onLandscape && pr.onLandscape && scene.hasTerrain) {
            // the terrain's own triangles (as /mapterrain and the export draw them)
            auto H = [&](int i, int j) { return tr.height[static_cast<size_t>(std::min(j, tr.cellsZ)) * tr.samplesX() + std::min(i, tr.cellsX)]; };
            auto P = [&](int i, int j) {
                const int si = std::min(i * step, tr.cellsX), sj = std::min(j * step, tr.cellsZ);
                return V3{tr.x0() + si * tr.cellSize, H(si, sj), -(tr.z0() + sj * tr.cellSize)};
            };
            const float cs = tr.cellSize * step;
            const int qx = tr.cellsX / step, qz = tr.cellsZ / step;
            const int i0 = std::clamp(static_cast<int>(std::floor((bmn[0] - tr.x0()) / cs)), 0, qx), i1 = std::clamp(static_cast<int>(std::ceil((bmx[0] - tr.x0()) / cs)), 0, qx);
            const int j0 = std::clamp(static_cast<int>(std::floor((-bmx[2] - tr.z0()) / cs)), 0, qz), j1 = std::clamp(static_cast<int>(std::ceil((-bmn[2] - tr.z0()) / cs)), 0, qz);
            for (int j = j0; j < j1; ++j)
                for (int i = i0; i < i1; ++i) {
                    const V3 a = P(i, j), bq = P(i + 1, j), c = P(i, j + 1), dq = P(i + 1, j + 1);
                    addTriangle(a, bq, c);
                    addTriangle(bq, dq, c);
                }
            flush(-1);
        }
        if (d.onStatic && pr.onStatic) {
            for (const Obj &ob : objs) {
                if (ob.mx[0] < bmn[0] || ob.mn[0] > bmx[0] || ob.mx[1] < bmn[1] || ob.mn[1] > bmx[1] || ob.mx[2] < bmn[2] || ob.mn[2] > bmx[2])
                    continue;
                const DecalTarget &t = *ob.t;
                const float *m = ob.m;
                const float det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
                auto W = [&](uint32_t i) {
                    const float *p = &t.pos[static_cast<size_t>(i) * 3];
                    return V3{m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]};
                };
                for (size_t k = 0; k + 2 < t.idx.size(); k += 3) {
                    const V3 a = W(t.idx[k]), b2 = W(t.idx[k + 1]), c = W(t.idx[k + 2]);
                    // (a triangle wholly outside the box's world bounds is skipped before clipping)
                    if (std::max({a.x, b2.x, c.x}) < bmn[0] || std::min({a.x, b2.x, c.x}) > bmx[0] || std::max({a.y, b2.y, c.y}) < bmn[1] ||
                        std::min({a.y, b2.y, c.y}) > bmx[1] || std::max({a.z, b2.z, c.z}) < bmn[2] || std::min({a.z, b2.z, c.z}) > bmx[2])
                        continue;
                    if (det < 0)
                        addTriangle(a, c, b2);
                    else
                        addTriangle(a, b2, c);
                }
                flush(ob.index);
            }
        }
    });
    // Within maxTriangles (kDecalTriangles: what a view takes): zombie_escape_3's volume boxes
    // (volume_quad_z, up to 3.8 km deep, painting every face inside) came to 13.9 million triangles on
    // its buildings, 1.56 GB, more than WebView2 takes in one response (the app ended). Over it whole
    // kinds go in turn (decalRank): every volume box off all the objects inside it (not some of them,
    // by size), then off the ground, then the other decals off objects; were the ordinary decals on the
    // ground still too many, their biggest pieces would go.
    std::array<size_t, 4> rankTris{};
    size_t total = 0;
    for (size_t di = 0; di < made.size(); ++di)
        for (const DecalMesh &m : made[di]) {
            rankTris[decalRank(preset[di], m)] += m.indices.size() / 3;
            total += m.indices.size() / 3;
        }
    if (total > maxTriangles) {
        static const char *const kind[] = {"the volume decals on the objects inside them", "the volume decals on the ground", "the other decals on objects", "the biggest decals on the ground"};
        const size_t before = total;
        std::string what;
        auto said = [&](int r, size_t decals) { what += (what.empty() ? "" : ", ") + std::string(kind[r]) + " (" + std::to_string(decals) + ")"; };
        for (int r = 0; r < 3 && total > maxTriangles; ++r) {
            std::set<size_t> decals;
            for (size_t di = 0; di < made.size(); ++di)
                for (DecalMesh &m : made[di])
                    if (decalRank(preset[di], m) == r && !m.indices.empty()) {
                        m.indices.clear(); // (left out below)
                        decals.insert(di);
                    }
            total -= rankTris[r];
            said(r, decals.size());
        }
        if (total > maxTriangles) {
            std::vector<DecalMesh *> ground;
            for (size_t di = 0; di < made.size(); ++di)
                for (DecalMesh &m : made[di])
                    if (!m.indices.empty())
                        ground.push_back(&m);
            std::sort(ground.begin(), ground.end(), [](const DecalMesh *a, const DecalMesh *b) { return a->indices.size() > b->indices.size(); });
            std::set<int> decals;
            for (DecalMesh *m : ground) {
                if (total <= maxTriangles)
                    break;
                total -= m->indices.size() / 3;
                decals.insert(m->decal);
                m->indices.clear();
            }
            said(3, decals.size());
        }
        char b[384];
        std::snprintf(b, sizeof b, "%.1f of the decals' %.1f million triangles left out, more than the view takes (%.1f million): %s", (before - total) / 1e6, before / 1e6,
                      maxTriangles / 1e6, what.c_str());
        warnings.push_back(b);
    }
    for (auto &meshes : made)
        for (DecalMesh &m : meshes)
            if (!m.indices.empty())
                out.push_back(std::move(m));
    for (uint32_t id : missing)
        warnings.push_back("decal preset " + std::to_string(id) + " not found");
    return true;
}

// ---- map export ----------------------------------------------------------------------------------
namespace {

// A decal's look in one texture, cut to its preset's rectangle: the colour (the albedo, tinted when
// the decal sets a colour of its own; white for plain-coloured decals, whose colour goes in the
// material) and, in alpha, where it shows: the normal map's height mask through the decal's height
// and sharpness, times the albedo's alpha, as the view draws it (ui/mapview.js decalMaterial()).
class DecalBaker {
  public:
    DecalBaker(const GameData &gd, int maxSide, std::vector<std::string> &warnings) : gd_(gd), maxSide_(maxSide), warnings_(warnings) {}

    struct Look {
        std::shared_ptr<const ImageRGBA> image;  // null: its textures are missing (the decal is left out)
        std::shared_ptr<const ImageRGBA> normal; // its normal map's rectangle (one per preset; null without one)
        std::string name;                        // "decal_<preset>", "decal_<preset>_2" ... (material and texture)
        std::string normalName;                  // "decal_<preset>_n.png"
        float color[4]{1, 1, 1, 1};              // the material's factor (linear; alpha = opacity)
        float roughness = 1, metallic = 0;       // 1 - the preset's gloss, its metal (with a spec map: their average over its picture)
    };

    // (decals that differ only in where they lie share a look)
    const Look &look(const MapDecal &d, const DecalPreset &pr) {
        const int hq = static_cast<int>(std::lround(std::clamp(d.height, 0.0f, 1.0f) * 64));
        const int sq = static_cast<int>(std::lround(std::clamp(d.sharpness, 0.0f, 1.0f) * 64));
        int tint[3] = {64, 64, 64}; // (1/64ths)
        float factor[4] = {1, 1, 1, std::clamp(d.opacity, 0.0f, 1.0f) * std::clamp(pr.albedoOpacity, 0.0f, 1.0f)};
        { // the colour (the preset's, or the decal's own) times the albedo: coloured presets' albedos
          // are near-white detail (rust leaks, plates, scorch marks)
            const uint8_t *c8 = d.customColor ? d.color : pr.uniform;
            for (int c = 0; c < 3; ++c)
                factor[c] = srgbToLinear(c8[c] / 255.0f);
        }
        const std::string bakeKey = std::to_string(pr.id) + "|" + std::to_string(hq) + "|" + std::to_string(sq);
        std::string key = bakeKey;
        for (float f : factor)
            key += "|" + std::to_string(std::lround(f * 255));
        auto it = looks_.find(key);
        if (it != looks_.end())
            return it->second;
        Look l;
        l.image = bake(bakeKey, pr, hq / 64.0f, sq / 64.0f, tint);
        auto nit = normals_.find(pr.id);
        if (nit != normals_.end())
            l.normal = nit->second;
        for (int c = 0; c < 4; ++c)
            l.color[c] = std::round(factor[c] * 255) / 255;
        float gloss = pr.gloss, metal = pr.metal;
        if (const ImageRGBA *S = pr.spec.empty() ? nullptr : atlas(pr.spec, 64)) { // (its spec map: red the gloss, green the metal)
            double sum[2]{}, s[4];
            for (int y = 0; y < 16; ++y)
                for (int x = 0; x < 16; ++x) {
                    sample(*S, pr.albedo.empty() ? pr.normalRect : pr.albedoRect, (x + 0.5) / 16, (y + 0.5) / 16, s);
                    sum[0] += s[0] / 255;
                    sum[1] += s[1] / 255;
                }
            gloss = static_cast<float>(sum[0] / 256);
            metal = static_cast<float>(sum[1] / 256);
        }
        l.roughness = std::round((1 - gloss) * 100) / 100;
        l.metallic = std::round(metal * 100) / 100;
        const size_t slash = pr.name.rfind('/');
        const std::string leaf = safeFileName(pr.name.empty() ? std::to_string(pr.id) : slash == std::string::npos ? pr.name : pr.name.substr(slash + 1));
        int &n = variants_[leaf];
        l.name = "decal_" + leaf + (n ? "_" + std::to_string(n + 1) : std::string());
        l.normalName = "decal_" + leaf + "_n.png";
        ++n;
        return looks_.emplace(key, std::move(l)).first->second;
    }

  private:
    const TextureInfo *info(const std::string &base) {
        auto it = infos_.find(base);
        if (it == infos_.end()) {
            Texture t;
            std::string e;
            if (!loadTexture(gd_, base, t, &e, false)) {
                warnings_.push_back("decal texture: " + e);
                t.info = TextureInfo{};
            }
            it = infos_.emplace(base, t.info).first;
        }
        return it->second.levels.empty() ? nullptr : &it->second;
    }

    // an atlas at the smallest mip with `across` texels over its width (at most 2048), a few kept
    // decoded (the decals are baked atlas by atlas)
    const ImageRGBA *atlas(const std::string &base, double across) {
        const TextureInfo *ti = info(base);
        if (!ti)
            return nullptr;
        const double want = std::min(across, 2048.0);
        int lv = 0;
        while (lv + 1 < static_cast<int>(ti->levels.size()) && ti->levels[lv + 1].width >= want)
            ++lv;
        const std::string key = base + "@" + std::to_string(lv);
        for (auto it = lru_.begin(); it != lru_.end(); ++it)
            if (it->first == key) {
                lru_.splice(lru_.begin(), lru_, it);
                return &lru_.front().second;
            }
        Texture t;
        std::string e;
        ImageRGBA img;
        if (!loadTexture(gd_, base, t, &e) || !decodeLevel(t, std::max(lv, t.firstLevel()), img.rgba, img.w, img.h, &e)) {
            warnings_.push_back("decal texture " + base + ": " + e);
            return nullptr;
        }
        lru_.emplace_front(key, std::move(img));
        if (lru_.size() > 6)
            lru_.pop_back();
        return &lru_.front().second;
    }

    // bilinear, kept inside the rectangle (the atlas' neighbouring pictures do not bleed in)
    static void sample(const ImageRGBA &im, const float *r, double u, double v, double o[4]) {
        const double lx = static_cast<double>(r[0]) * im.w, hx = std::max(lx, static_cast<double>(r[0] + r[2]) * im.w - 1);
        const double ly = static_cast<double>(r[1]) * im.h, hy = std::max(ly, static_cast<double>(r[1] + r[3]) * im.h - 1);
        const double x = std::clamp((r[0] + u * r[2]) * im.w - 0.5, lx, hx), y = std::clamp((r[1] + v * r[3]) * im.h - 0.5, ly, hy);
        const int x0 = static_cast<int>(std::floor(x)), y0 = static_cast<int>(std::floor(y));
        const double fx = x - x0, fy = y - y0;
        auto at = [&](int xi, int yi, int c) -> double {
            xi = std::clamp(xi, 0, static_cast<int>(im.w) - 1);
            yi = std::clamp(yi, 0, static_cast<int>(im.h) - 1);
            return im.rgba[(static_cast<size_t>(yi) * im.w + xi) * 4 + c];
        };
        for (int c = 0; c < 4; ++c)
            o[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
    }

    std::shared_ptr<const ImageRGBA> bake(const std::string &key, const DecalPreset &pr, float height, float sharpness, const int tint[3]) {
        auto found = bakes_.find(key);
        if (found != bakes_.end())
            return found->second;
        std::shared_ptr<const ImageRGBA> &slot = bakes_[key];
        const bool albedo = !pr.albedo.empty();
        const float *rect = albedo ? pr.albedoRect : pr.normalRect;
        const TextureInfo *mi = info(albedo ? pr.albedo : pr.normal);
        if (!mi || rect[2] <= 0 || rect[3] <= 0 || (!pr.normal.empty() && (pr.normalRect[2] <= 0 || pr.normalRect[3] <= 0)))
            return slot;
        // the rectangle's own texels, at most maxSide on the longer side
        const double rw = rect[2] * mi->width, rh = rect[3] * mi->height, k = std::min(1.0, maxSide_ / std::max({rw, rh, 1.0}));
        const uint32_t ow = std::max<uint32_t>(1, static_cast<uint32_t>(std::lround(rw * k))), oh = std::max<uint32_t>(1, static_cast<uint32_t>(std::lround(rh * k)));
        const ImageRGBA *A = albedo ? atlas(pr.albedo, ow / pr.albedoRect[2]) : nullptr;
        if (albedo && !A)
            return slot;
        const ImageRGBA *N = pr.normal.empty() ? nullptr : atlas(pr.normal, ow / pr.normalRect[2]); // (none: shows all over, as in the view)
        if (N && !normals_.count(pr.id)) { // its relief: the normal map's rectangle at the same size (RGB = the normal, +Y up as glTF has it)
            auto nm = std::make_shared<ImageRGBA>();
            nm->w = ow;
            nm->h = oh;
            nm->rgba.assign(static_cast<size_t>(ow) * oh * 4, 255);
            parallelRows(oh, [&](size_t row) { // (rows side by side)
                const uint32_t y = static_cast<uint32_t>(row);
                double s[4];
                for (uint32_t x = 0; x < ow; ++x) {
                    sample(*N, pr.normalRect, (x + 0.5) / ow, (y + 0.5) / oh, s);
                    uint8_t *o = &nm->rgba[(static_cast<size_t>(y) * ow + x) * 4];
                    for (int c = 0; c < 3; ++c)
                        o[c] = static_cast<uint8_t>(std::clamp(static_cast<int>(std::lround(s[c])), 0, 255));
                }
            });
            normals_[pr.id] = nm;
        }
        uint8_t lut[3][256];
        for (int c = 0; c < 3; ++c)
            for (int i = 0; i < 256; ++i)
                lut[c][i] = tint[c] == 64 ? static_cast<uint8_t>(i)
                                          : static_cast<uint8_t>(std::lround(std::clamp(linearToSrgb(std::min(1.0f, srgbToLinear(i / 255.0f) * tint[c] / 64.0f)), 0.0f, 1.0f) * 255));
        auto img = std::make_shared<ImageRGBA>();
        img->w = ow;
        img->h = oh;
        img->rgba.assign(static_cast<size_t>(ow) * oh * 4, 255);
        const double t = 1 - height, w = 1 / std::max(0.02, 1.0 - sharpness);
        parallelRows(oh, [&](size_t row) { // (rows side by side)
            const uint32_t y = static_cast<uint32_t>(row);
            for (uint32_t x = 0; x < ow; ++x) {
                const double u = (x + 0.5) / ow, v = (y + 0.5) / oh;
                uint8_t *o = &img->rgba[(static_cast<size_t>(y) * ow + x) * 4];
                double alpha = 1, s[4];
                if (A) {
                    sample(*A, pr.albedoRect, u, v, s);
                    for (int c = 0; c < 3; ++c)
                        o[c] = lut[c][std::clamp(static_cast<int>(std::lround(s[c])), 0, 255)];
                    alpha = s[3] / 255;
                }
                if (N) {
                    sample(*N, pr.normalRect, u, v, s);
                    alpha *= std::clamp((s[3] / 255 - t) * w, 0.0, 1.0);
                } else {
                    alpha *= std::clamp((1 - t) * w, 0.0, 1.0);
                }
                o[3] = static_cast<uint8_t>(std::lround(std::clamp(alpha, 0.0, 1.0) * 255));
            }
        });
        slot = img;
        return slot;
    }

    const GameData &gd_;
    double maxSide_;
    std::vector<std::string> &warnings_;
    std::map<std::string, Look> looks_;
    std::map<std::string, int> variants_;
    std::map<std::string, std::shared_ptr<const ImageRGBA>> bakes_;
    std::map<uint32_t, std::shared_ptr<const ImageRGBA>> normals_; // preset -> its normal map's rectangle
    std::unordered_map<std::string, TextureInfo> infos_;
    std::list<std::pair<std::string, ImageRGBA>> lru_;
};

} // namespace

bool exportMap(const GameData &gd, const MapScene &scene, const std::filesystem::path &outFile, const ExportOptions &opt,
               const MapExportOptions &mo, std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
               const Progress &progress) {
    auto report = [&](double f, const std::string &s) {
        if (progress)
            progress(f, s);
    };
    std::vector<CustomMesh> custom;
    if (scene.hasTerrain) {
        const Terrain &t = scene.terrain;
        // its look baked from the surfaces: colour, relief (a normal map over the height grid's normals)
        // and roughness / metal / occlusion
        std::shared_ptr<ImageRGBA> ground, relief, orm;
        if (opt.textures && mo.groundTexture > 0) {
            report(0.01, "Baking the ground");
            auto img = std::make_shared<ImageRGBA>(), nrm = std::make_shared<ImageRGBA>(), mr = std::make_shared<ImageRGBA>();
            std::string e;
            if (bakeGround(gd, t, mo.groundTexture, *img, warnings, &e, [&](double f, const std::string &s) { report(0.01 + 0.07 * f, s); }, nrm.get(), mr.get())) {
                ground = img;
                relief = nrm;
                orm = mr;
            } else {
                warnings.push_back("ground texture: " + e);
            }
        }
        // the height grid in chunks of at most 128 x 128 quads (16-bit indices)
        int step = mo.terrainStep > 0 ? mo.terrainStep : std::max(1, (std::max(t.cellsX, t.cellsZ) + 1023) / 1024);
        const int qx = t.cellsX / step, qz = t.cellsZ / step, sx = t.samplesX();
        const int chunk = 128;
        auto heightAtSample = [&](int i, int j) { return t.height[static_cast<size_t>(std::min(j, t.cellsZ)) * sx + std::min(i, t.cellsX)]; };
        for (int cz = 0; cz < qz; cz += chunk)
            for (int cx = 0; cx < qx; cx += chunk) {
                const int nx = std::min(chunk, qx - cx), nz = std::min(chunk, qz - cz);
                CustomMesh m;
                char nm[64];
                std::snprintf(nm, sizeof(nm), "terrain_%02d_%02d", cx / chunk, cz / chunk);
                m.name = nm;
                m.group = "terrain";
                m.material = "terrain";
                m.albedo = ground;
                m.albedoName = "terrain_ground.png";
                m.normal = relief;
                m.normalName = "terrain_ground_n.png";
                m.metalRough = orm;
                m.metalRoughName = "terrain_ground_orm.png";
                m.color[0] = m.color[1] = m.color[2] = ground ? 1.0f : 0.35f;
                m.roughness = orm ? 1.0f : 0.95f; // (glTF scales the texture's by these)
                m.metallic = orm ? 1.0f : 0.0f;
                MeshGeometry &g = m.g;
                g.vertexCount = static_cast<uint32_t>((nx + 1) * (nz + 1));
                g.position.reserve(g.vertexCount * 3);
                g.normal.reserve(g.vertexCount * 3);
                g.uv0.reserve(g.vertexCount * 2);
                for (int j = 0; j <= nz; ++j)
                    for (int i = 0; i <= nx; ++i) {
                        const int si = (cx + i) * step, sj = (cz + j) * step;
                        const float x = t.x0() + si * t.cellSize, z = t.z0() + sj * t.cellSize;
                        g.position.insert(g.position.end(), {x, heightAtSample(si, sj), -z});
                        const float dx = (heightAtSample(si + step, sj) - heightAtSample(std::max(0, si - step), sj)) / ((std::min(si + step, t.cellsX) - std::max(0, si - step)) * t.cellSize);
                        const float dz = (heightAtSample(si, sj + step) - heightAtSample(si, std::max(0, sj - step))) / ((std::min(sj + step, t.cellsZ) - std::max(0, sj - step)) * t.cellSize);
                        const float l = std::sqrt(dx * dx + 1 + dz * dz);
                        g.normal.insert(g.normal.end(), {-dx / l, 1 / l, dz / l}); // game (-dx, 1, -dz), z mirrored
                        g.uv0.insert(g.uv0.end(), {(x - t.x0()) / t.sizeX(), 1 - (z - t.z0()) / t.sizeZ()});
                    }
                for (int j = 0; j < nz; ++j)
                    for (int i = 0; i < nx; ++i) {
                        const uint32_t a = static_cast<uint32_t>(j * (nx + 1) + i), b = a + 1, c = a + static_cast<uint32_t>(nx + 1), d = c + 1;
                        g.indices.insert(g.indices.end(), {a, b, c, b, d, c});
                    }
                custom.push_back(std::move(m));
            }
    }
    // The water: its surface (its outline turned with its entity), see-through by transmission with
    // the colour of its depth (KHR_materials_volume: light keeps its colour for 1 / density metres), and
    // its waves as a normal map (the first frame of its animation, else its detail map) tiled and as
    // strong as the view draws them; acid lets no light through: a sheet of its colour.
    std::map<std::string, std::shared_ptr<const ImageRGBA>> waterMaps; // texture base -> RGB normal map
    auto waterMap = [&](const std::string &base) -> std::shared_ptr<const ImageRGBA> {
        auto [it, fresh] = waterMaps.emplace(base, nullptr);
        if (!fresh || !opt.textures)
            return it->second;
        Texture t;
        std::string e;
        auto img = std::make_shared<ImageRGBA>();
        if (!loadTexture(gd, base, t, &e) || !decodeLevel(t, t.firstLevel(), img->rgba, img->w, img->h, &e)) {
            warnings.push_back("water texture " + base + ": " + e);
            return nullptr;
        }
        unpackNormals(img->rgba, t.info.layers > 1 ? NormalLayout::AG : guessNormalLayout(t.info.format, img->rgba), nullptr); // (2.41's layered waves: x in alpha, y in green)
        if (opt.maxTextureSize > 0)
            downscaleRgba(img->rgba, img->w, img->h, static_cast<uint32_t>(opt.maxTextureSize));
        return it->second = img;
    };
    for (const auto &w : scene.water) {
        CustomMesh m;
        m.name = "water_" + (w.name.empty() ? std::to_string(custom.size()) : safeFileName(w.name));
        m.group = "water";
        m.material = w.type == 1 ? "acid" : "water";
        const float lin[3] = {srgbToLinear(w.color[0] / 255.0f), srgbToLinear(w.color[1] / 255.0f), srgbToLinear(w.color[2] / 255.0f)};
        const bool layered = !w.frames.empty() && gd.find(w.frames + ".tfh"); // (Crossout 2.41: one texture of frames)
        const bool frames = layered || (!w.frames.empty() && gd.find(w.frames + "/01.tfh"));
        const std::string waves = layered ? w.frames : frames ? w.frames + "/01" : w.detail[0] != "textures/nm" ? w.detail[0] : std::string();
        if (!waves.empty() && (m.normal = waterMap(waves))) {
            m.normalName = safeFileName(waves.substr(waves.find('/') + 1)) + "_n.png";
            m.normalScale = std::clamp(w.bumpHeight[0] * (frames ? kWaves : kRipples), 0.05f, 2.0f);
        }
        m.roughness = kWaterRoughness;
        for (int c = 0; c < 3; ++c) // (the light it scatters, as the view's BODY: the acid's opaque colour, OBJ's Kd)
            m.color[c] = lin[c] * kWaterBody;
        if (w.type != 1) {
            // the volume's thickness: how deep it is on average over the ground under it
            float thick = std::max(w.depth, 0.5f);
            if (scene.hasTerrain) {
                float x0 = 1e30f, x1 = -1e30f, z0 = 1e30f, z1 = -1e30f, sum = 0;
                for (const auto &p : w.outline) {
                    x0 = std::min(x0, p[0]), x1 = std::max(x1, p[0]);
                    z0 = std::min(z0, p[1]), z1 = std::max(z1, p[1]);
                }
                int n = 0;
                for (int j = 0; j < 24; ++j)
                    for (int i = 0; i < 24; ++i) {
                        const float x = x0 + (x1 - x0) * (i + 0.5f) / 24, z = z0 + (z1 - z0) * (j + 0.5f) / 24;
                        const float d = w.level - scene.terrain.heightAt(x, z);
                        if (d > 0 && insideOutline(w.outline, x, z))
                            sum += d, ++n;
                    }
                if (n)
                    thick = sum / n;
            }
            m.transmission = 1;
            m.ior = 1.333f;
            m.thickness = thick;
            m.attenuationDistance = 1 / w.density;
            const float top = std::max({lin[0], lin[1], lin[2], 1e-4f});
            for (int c = 0; c < 3; ++c) // (the hue of what it scatters, as bright as light gets)
                m.attenuationColor[c] = lin[c] / top;
        }
        const std::vector<uint32_t> tri = triangulate(w.outline);
        MeshGeometry &g = m.g;
        g.vertexCount = static_cast<uint32_t>(w.outline.size());
        const float uv = w.uvTiling[0] / kWaterTile;
        for (const auto &p : w.outline) {
            g.position.insert(g.position.end(), {p[0], w.level, -p[1]});
            g.normal.insert(g.normal.end(), {0.0f, 1.0f, 0.0f});
            g.uv0.insert(g.uv0.end(), {p[0] * uv, p[1] * uv});
        }
        // counter-clockwise in game (x, z) stays counter-clockwise seen from above in glTF (x, -z)
        g.indices = tri;
        custom.push_back(std::move(m));
    }

    // the decals: projected onto the terrain and the objects (as the view draws them), their look
    // (colour + where they show) baked into one texture per kind; how much of each shows at its
    // corners (the box's ends, steep surfaces) in the vertex colours' alpha
    if (mo.decals && opt.textures && !scene.decals.empty()) {
        report(0.08, "Projecting the decals");
        const std::map<uint32_t, DecalPreset> presets = readDecalPresets(gd);
        std::vector<DecalMesh> dms;
        buildDecalMeshes(gd, scene, presets, mo.terrainStep, dms, warnings);
        { // (one mesh per decal again: its pieces on the terrain and on each object come one after another)
            std::vector<DecalMesh> whole;
            for (DecalMesh &m : dms) {
                if (whole.empty() || whole.back().decal != m.decal) {
                    whole.push_back(std::move(m));
                    continue;
                }
                DecalMesh &w = whole.back();
                const uint32_t base = static_cast<uint32_t>(w.position.size() / 3);
                w.position.insert(w.position.end(), m.position.begin(), m.position.end());
                w.normal.insert(w.normal.end(), m.normal.begin(), m.normal.end());
                w.uv.insert(w.uv.end(), m.uv.begin(), m.uv.end());
                w.fade.insert(w.fade.end(), m.fade.begin(), m.fade.end());
                for (uint32_t i : m.indices)
                    w.indices.push_back(base + i);
            }
            dms.swap(whole);
        }
        report(0.1, "Baking the decals");
        // the looks first, atlas by atlas (each atlas decoded once)
        std::vector<size_t> order(dms.size());
        for (size_t i = 0; i < order.size(); ++i)
            order[i] = i;
        auto presetOf = [&](size_t i) -> const DecalPreset & { return presets.at(scene.decals[dms[i].decal].preset); };
        std::stable_sort(order.begin(), order.end(), [&](size_t a, size_t b) {
            const DecalPreset &pa = presetOf(a), &pb = presetOf(b);
            return std::tie(pa.albedo, pa.normal) < std::tie(pb.albedo, pb.normal);
        });
        DecalBaker baker(gd, opt.maxTextureSize > 0 ? std::min(opt.maxTextureSize, 2048) : 2048, warnings);
        std::vector<const DecalBaker::Look *> looks(dms.size(), nullptr);
        for (size_t i : order)
            looks[i] = &baker.look(scene.decals[dms[i].decal], presetOf(i));
        for (size_t i = 0; i < dms.size(); ++i) {
            const DecalBaker::Look &l = *looks[i];
            if (!l.image)
                continue;
            DecalMesh &dm = dms[i];
            const DecalPreset &pr = presetOf(i);
            const float *rect = pr.albedo.empty() ? pr.normalRect : pr.albedoRect;
            CustomMesh c;
            c.name = l.name;
            c.group = "decals";
            c.material = l.name;
            c.albedo = l.image;
            c.albedoName = l.name + ".png";
            c.normal = l.normal;
            c.normalName = l.normalName;
            std::memcpy(c.color, l.color, sizeof(c.color));
            c.roughness = l.roughness;
            c.metallic = l.metallic;
            c.blend = true;
            MeshGeometry &g = c.g;
            g.vertexCount = static_cast<uint32_t>(dm.position.size() / 3);
            g.position = std::move(dm.position);
            g.normal = std::move(dm.normal);
            g.uv0.resize(static_cast<size_t>(g.vertexCount) * 2);
            g.color.assign(static_cast<size_t>(g.vertexCount) * 4, 255);
            for (uint32_t v = 0; v < g.vertexCount; ++v) { // (the texture holds just the preset's rectangle)
                g.uv0[v * 2] = (dm.uv[v * 2] - rect[0]) / rect[2];
                g.uv0[v * 2 + 1] = (dm.uv[v * 2 + 1] - rect[1]) / rect[3];
                g.color[v * 4 + 3] = static_cast<uint8_t>(std::lround(std::clamp(dm.fade[v], 0.0f, 1.0f) * 255));
            }
            g.indices = std::move(dm.indices);
            custom.push_back(std::move(c));
        }
    }

    // the grass: every kind's tufts as copies of its model (EXT_mesh_gpu_instancing), lit,
    // brightened and tinted by the ground as the view draws them; a share of them, in the order the
    // game thins them out
    SceneExtras extras;
    if (mo.grass > 0 && scene.hasTerrain) {
        report(0.12, "Placing the grass");
        MapGrass g;
        std::string e;
        if (loadGrass(gd, scene.name, g, &e)) {
            const float keep = std::clamp(mo.grass, 0.0f, 1.0f);
            std::vector<float> tint;
            const bool tinted = grassTints(gd, scene.name, g, tint, nullptr);
            for (size_t t = 0; t < g.types.size(); ++t) {
                const GrassType &ty = g.types[t];
                if (ty.model.empty())
                    continue;
                InstancedItem ii;
                ii.path = ty.model;
                std::string kind = ty.name.empty() ? std::to_string(ty.preset) : ty.name;
                std::replace(kind.begin(), kind.end(), '/', '_');
                ii.name = "grass_" + safeFileName(kind);
                ii.group = "grass";
                ii.lod = 0;
                ii.grass = true;
                ii.gain = std::round(std::max(0.0f, ty.luminance) * 10) / 100; // (luminance_modifier / 10, as the view)
                for (const GrassCell &c : g.cells) {
                    if (c.type != static_cast<int>(t))
                        continue;
                    for (uint32_t i = c.first; i < c.first + c.count && i < g.items.size(); ++i) {
                        const GrassInstance &gi = g.items[i];
                        if (gi.rank >= keep)
                            continue;
                        // game -> glTF: z mirrored; the rotation mirrored with it (F R F = quaternion -x, -y, z, w)
                        float q[4] = {-gi.rot[0], -gi.rot[1], gi.rot[2], gi.rot[3]};
                        const float ql = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
                        for (float &x : q)
                            x = ql > 0 ? x / ql : 0;
                        if (!(ql > 0))
                            q[3] = 1;
                        ii.trs.insert(ii.trs.end(), {gi.pos[0], gi.pos[1], -gi.pos[2], q[0], q[1], q[2], q[3], gi.scale});
                        if (tinted)
                            ii.color.insert(ii.color.end(), tint.begin() + i * 3, tint.begin() + i * 3 + 3);
                    }
                }
                if (!ii.trs.empty())
                    extras.instanced.push_back(std::move(ii));
            }
        } else if (e.find("no grass") == std::string::npos) {
            warnings.push_back("grass: " + e);
        }
    }

    // the sun (a light) and the sky (an .hdr panorama beside the file, for Blender's World)
    if ((mo.sun || mo.sky > 0) && !scene.environment.empty()) {
        report(0.13, "Working out the sky");
        MapEnvironment env;
        SkyLight light;
        std::vector<float> pano;
        std::string e;
        const int width = mo.sky > 0 ? std::clamp(mo.sky, 256, 8192) : 0;
        if (!loadEnvironment(gd, scene.name, scene.environment, env, &e) || !renderSky(gd, env, width, mo.clouds, light, pano, warnings, &e, mo.probeSky)) {
            warnings.push_back("sky: " + e);
        } else {
            extras.info.emplace_back("environment", env.id + (env.name.empty() ? std::string() : " " + env.name));
            if (mo.sun) {
                SceneLight l;
                l.name = "sun";
                const float top = scene.hasTerrain ? scene.terrain.maxY : 0;
                for (int c = 0; c < 3; ++c) {
                    l.direction[c] = -light.sun[c];
                    l.color[c] = light.color[c];
                    l.position[c] = light.sun[c] * 300; // (where Blender shows its lamp: above the map, towards the sun)
                }
                l.position[1] += top;
                l.intensity = light.intensity;
                extras.lights.push_back(l);
            }
            if (width > 0 && !pano.empty()) {
                const std::string name = companionStem(outFile) + "_sky.hdr";
                extras.files.emplace_back(outFile.parent_path() / name, encodeHdr(pano.data(), width, width / 2));
                extras.info.emplace_back("sky", name);
            }
            char haze[400];
            if (!env.value("HeightFog0").empty()) // (Crossout 2.41: the scene's ExponentialHeightFog)
                std::snprintf(haze, sizeof(haze), "height fog of two layers (density per m, base 2; falloff per m, base 2; altitude): %s and %s, none thicker than at its altitude, none nearer than %s m; its colour the sky's x %s",
                              env.value("HeightFog0").c_str(), env.value("HeightFog1").c_str(), env.value("HeightFogStart").c_str(), env.value("HeightFogInscatter").c_str());
            else
                std::snprintf(haze, sizeof(haze), "UE4 exponential height fog: %.6f per m (base 2) at %.0f m altitude, halving every %.0f m up, none nearer than %.0f m; colour FogColor x 0.68 x 2^FogLuminanceEv100 / 8; the air's own haze (Bruneton's in-scattering) over %.2f x the distance, its light x %.3f (the preset's sun against the air's own)",
                              light.fogDensity, light.fogHeight, light.fogHalving, light.fogStart, light.fogAerialGain, light.fogAirSun);
            extras.info.emplace_back("haze", haze);
            char exposure[200];
            std::snprintf(exposure, sizeof(exposure), "EV100 %.2f: the sun and the sky are the game's light x %.5f (light-probe units x %.4f), before its tone curve",
                          light.ev100, light.exposure / kProbeUnit, light.exposure);
            extras.info.emplace_back("exposure", exposure);
        }
    }

    std::vector<SceneItem> items;
    items.reserve(scene.objects.size());
    for (const auto &o : scene.objects) {
        SceneItem it;
        it.path = o.model;
        it.skin = o.skin;
        it.name = o.name.find('/') != std::string::npos ? o.name.substr(o.name.rfind('/') + 1) : o.name;
        it.group = o.group;
        if (o.group == "trees" && mo.treeLod >= 0)
            it.lod = mo.treeLod;
        mapObjectMatrix(o, it.matrix);
        items.push_back(std::move(it));
    }
    return exportScene(gd, items, custom, extras, scene.name, outFile, opt, written, warnings, err,
                       [&](double f, const std::string &s) { report(0.15 + 0.85 * f, s); });
}

} // namespace xo
