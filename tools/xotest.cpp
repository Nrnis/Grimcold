// xotest: command-line checks for the Grimcold core (no window).
//   xotest [--data <dir>] scan                 parse + decode every .mdl in the game
//   xotest [--data <dir>] md5 [prefix]         extract every file (under prefix) and verify its MD5
//   xotest [--data <dir>] texscan              parse every .tfh and decode its smallest usable level
//   xotest [--data <dir>] tex <base> <out.png> [level]
//   xotest [--data <dir>] dds <base> <out.dds>
//   xotest [--data <dir>] hdr <base> <out.hdr> [width]   a float texture as Radiance .hdr (level 0); a cube
//                                                        map as a panorama width x width / 2 (default 1024)
//   xotest [--data <dir>] export <model.mdl> <out.glb|.gltf|.obj> [--lod N|--all-lods] [--skin S]
//   xotest [--data <dir>] geo <model.mdl> <out.bin> [lod]
//   xotest [--data <dir>] extract <game path> <out file>
//   xotest [--data <dir>] extractall <prefix> <out dir> [suffix ...]
//   xotest [--data <dir>] maps | mapinfo <map> [--models] | map <map> <out.glb|.gltf|.obj> [options] | ground <map> <out.png> [size]
//   xotest [--data <dir>] sky <map> <out.hdr|.png> [width] [--no-clouds] [--computed] | envinfo <map> | grassinfo <map> | decalinfo <map>
//   xotest [--data <dir>] probe <map> <envId> <out.png|.hdr> [width] [--diffuse|--fog] [--level n] [--local] | probescan [map ...]
//   xotest [--data <dir>] meshes <model.mdl> | vdump <model.mdl> <mesh> [n] | treescan | v9scan [n]
//   xotest [--data <dir>] shaderscan <prefix> | pinscan <prefix> <shader guid prefix>
//   xotest [--data <dir>] emisscan [prefix] [list] | lampscan [prefix] [shader] | matscan [prefix ...] | flagscan [prefix ...]
//   xotest [--data <dir>] geoscan [prefix ...] | texrole [prefix ...] | posescan [parameter|*] [prefix] | animdump <x.anim> [keys]
//   xotest [--data <dir>] sounds [substring] | sound <name> <out.ogg> | soundscan
#include "xo/Anim.h"
#include "xo/Archive.h"
#include "xo/Export.h"
#include "xo/Map.h"
#include "xo/Material.h"
#include "xo/Model.h"
#include "xo/Sky.h"
#include "xo/Sound.h"
#include "xo/Texture.h"
#include "xo/Zstd.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

using namespace xo;

static std::filesystem::path defaultDataDir() {
    wchar_t buf[MAX_PATH];
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", buf, MAX_PATH))
        return std::filesystem::path(buf) / L"Crossout Launcher" / L"data";
    return {};
}

// Arguments are kept as UTF-8; this turns one back into a path without the ANSI code page.
static std::filesystem::path P(const std::string &s) { return std::filesystem::path(std::u8string(s.begin(), s.end())); }

static int fail(const std::string &m) {
    std::fprintf(stderr, "FAIL: %s\n", m.c_str());
    return 1;
}

int wmain(int argc, wchar_t **argv) {
    SetConsoleOutputCP(CP_UTF8);
    setvbuf(stdout, nullptr, _IONBF, 0); // (progress shows as it happens when the output is piped)
    std::vector<std::string> args;
    std::filesystem::path data = defaultDataDir();
    for (int i = 1; i < argc; ++i) {
        std::wstring a = argv[i];
        if (a == L"--data" && i + 1 < argc) {
            data = argv[++i];
            continue;
        }
        args.push_back(utf8(std::filesystem::path(a))); // UTF-8; paths go back through P()
    }
    if (args.empty()) {
        std::puts("usage: xotest [--data dir] scan|md5|texscan|tex|dds|export|scene|geo|extract|extractall|maps|mapinfo|map|ground|meshes|vdump ... (see the top of tools/xotest.cpp)");
        return 2;
    }
    const auto t0 = std::chrono::steady_clock::now();
    GameData gd;
    std::string err;
    if (!gd.open(data, &err))
        return fail(err);
    std::printf("zstd %s | %zu packs, %zu files (%s)\n", zstdVersion().c_str(), gd.packs().size(), gd.entries().size(),
                utf8(data).c_str());
    for (const auto &w : gd.warnings())
        std::printf("warning: %s\n", w.c_str());
    const std::string cmd = args[0];

    if (cmd == "scan") {
        size_t files = 0, meshes = 0, verts = 0, tris = 0, errors = 0, v9 = 0, slots = 0, nodes = 0;
        std::map<std::string, size_t> layouts;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            ++files;
            std::vector<uint8_t> bytes;
            Model m;
            if (!gd.read(e, bytes, &err) || !parseModel(std::move(bytes), m, &err)) {
                if (errors++ < 10)
                    std::printf("error: %s: %s\n", e.name.c_str(), err.c_str());
                continue;
            }
            if (m.version == 9)
                ++v9;
            slots += m.slots.size();
            nodes += m.nodes.size();
            for (const auto &me : m.meshes) {
                MeshGeometry g;
                if (!decodeMesh(m, me, g, &err)) {
                    if (errors++ < 10)
                        std::printf("error: %s: decode: %s\n", e.name.c_str(), err.c_str());
                    continue;
                }
                ++meshes;
                verts += g.vertexCount;
                tris += g.indices.size() / 3;
                std::string key = std::to_string(me.positionBytes);
                for (const auto &el : me.elements)
                    key += "," + describeElement(el);
                ++layouts[key];
            }
        }
        std::printf("scan: %zu models (%zu v9), %zu meshes, %zu vertices, %zu triangles, %zu slots, %zu nodes, %zu errors\n",
                    files, v9, meshes, verts, tris, slots, nodes, errors);
        std::printf("vertex layouts: %zu distinct\n", layouts.size());
        const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::printf("time: %.1f s\n", s);
        return errors ? 1 : 0;
    }
    if (cmd == "sounds" || cmd == "sound" || cmd == "soundscan") { // the effect banks' samples (xo/Sound.h)
        SoundBanks sb;
        if (!sb.open(gd.dataDir() / L"sound", &err))
            return fail(err);
        for (const auto &w : sb.warnings())
            std::printf("warning: %s\n", w.c_str());
        size_t playable = 0;
        for (const auto &x : sb.samples())
            playable += SoundBanks::playable(x);
        std::printf("sounds: %zu samples in %zu banks, %zu playable\n", sb.samples().size(), sb.banks().size(), playable);
        if (cmd == "sounds") {
            const std::string sub = args.size() > 1 ? args[1] : "";
            for (const auto &x : sb.samples())
                if (sub.empty() || x.name.find(sub) != std::string::npos)
                    std::printf("  %-44s %s %uch %u Hz %.2f s%s\n", x.name.c_str(), utf8(sb.banks()[x.bank].filename()).c_str(), x.channels, x.rate,
                                x.rate ? double(x.frames) / x.rate : 0.0, SoundBanks::playable(x) ? "" : " (no setup)");
            return 0;
        }
        if (cmd == "sound") {
            if (args.size() < 3)
                return fail("sound <name> <out.ogg>");
            const SoundSample *x = sb.find(args[1]);
            if (!x)
                return fail("no sound " + args[1]);
            std::vector<uint8_t> ogg;
            if (!sb.readOgg(*x, ogg, &err) || !writeFileBytes(P(args[2]), ogg.data(), ogg.size(), &err))
                return fail(err);
            std::printf("%s: %zu bytes, %u frames\n", x->name.c_str(), ogg.size(), x->frames);
            return 0;
        }
        // soundscan: every playable sample as Ogg: its pages and their checksums, its last granule = its frames
        size_t bad = 0, bytes = 0, n = 0;
        for (const auto &x : sb.samples()) {
            if (!SoundBanks::playable(x))
                continue;
            ++n;
            std::vector<uint8_t> ogg;
            std::string why;
            int64_t last = -1;
            if (sb.readOgg(x, ogg, &why)) {
                for (size_t o = 0; o < ogg.size();) {
                    if (o + 27 > ogg.size() || std::memcmp(ogg.data() + o, "OggS", 4) != 0) {
                        why = "no page at " + std::to_string(o);
                        break;
                    }
                    const size_t segs = ogg[o + 26];
                    size_t len = 27 + segs;
                    for (size_t k = 0; k < segs && o + 27 + k < ogg.size(); ++k)
                        len += ogg[o + 27 + k];
                    if (o + len > ogg.size()) {
                        why = "page cut short";
                        break;
                    }
                    uint32_t crc;
                    std::memcpy(&crc, ogg.data() + o + 22, 4);
                    std::vector<uint8_t> pg(ogg.begin() + o, ogg.begin() + o + len);
                    std::memset(pg.data() + 22, 0, 4);
                    if (oggCrc(pg.data(), pg.size()) != crc) {
                        why = "bad page checksum";
                        break;
                    }
                    if (ogg[o + 5] & 4)
                        std::memcpy(&last, ogg.data() + o + 6, 8);
                    o += len;
                }
                if (why.empty() && last != static_cast<int64_t>(x.frames))
                    why = "ends at granule " + std::to_string(last) + ", not " + std::to_string(x.frames);
            }
            bytes += ogg.size();
            if (!why.empty() && bad++ < 10)
                std::printf("bad: %s: %s\n", x.name.c_str(), why.c_str());
        }
        std::printf("soundscan: %zu of %zu bad, %.1f MB of Ogg, %.1f s\n", bad, n, bytes / 1048576.0,
                    std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
        return bad ? 1 : 0;
    }
    if (cmd == "md5") {
        const std::string prefix = args.size() > 1 ? normalizeGamePath(args[1]) : "";
        size_t n = 0, bad = 0, bytes = 0, readOnly = 0;
        std::vector<uint8_t> buf;
        for (const auto &e : gd.entries()) {
            if (!prefix.empty() && e.name.rfind(prefix, 0) != 0)
                continue;
            ++n;
            uint8_t md5[16];
            // (a v5 pack lists XXH3-128s, not MD5s: its files are read and unpacked, not compared)
            const bool md5Listed = gd.packs()[e.pack].md5Sums;
            readOnly += !md5Listed;
            if (!gd.read(e, buf, &err) || (md5Listed && (!md5Of(buf.data(), buf.size(), md5) || std::memcmp(md5, e.md5, 16) != 0))) {
                if (bad++ < 10)
                    std::printf("mismatch: %s %s\n", e.name.c_str(), err.c_str());
                err.clear();
            }
            bytes += buf.size();
        }
        const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        std::printf("md5: %zu files, %.2f GB, %zu mismatches (%zu only read: their packs list XXH3-128s), %.1f s\n", n, bytes / 1e9, bad, readOnly, s);
        return bad ? 1 : 0;
    }
    if (cmd == "texscan") {
        size_t n = 0, bad = 0, unknown = 0;
        std::map<std::string, size_t> formats;
        std::map<std::string, std::string> example; // first texture of each format (the tests use these)
        std::map<std::string, size_t> unknownCodes;
        std::map<std::string, std::string> unknownExample;
        std::map<std::string, size_t> layered; // cube maps and arrays
        std::map<std::string, std::string> layeredExample;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".tfh") != 0)
                continue;
            ++n;
            Texture t;
            if (!loadTexture(gd, e.name.substr(0, e.name.size() - 4), t, &err, false)) {
                if (bad++ < 10)
                    std::printf("error: %s\n", err.c_str());
                continue;
            }
            ++formats[pixelFormatName(t.info.format)];
            example.emplace(pixelFormatName(t.info.format), e.name.substr(0, e.name.size() - 4));
            if (t.info.layers > 1) {
                const std::string key = std::to_string(t.info.layers) + (t.info.cube ? " (cube)" : "") + " " + pixelFormatName(t.info.format);
                ++layered[key];
                layeredExample.emplace(key, e.name.substr(0, e.name.size() - 4));
            }
            if (t.info.format == PixelFormat::Unknown) {
                ++unknown;
                const std::string key = "code " + std::to_string(t.info.code) + (e.name.rfind("models/", 0) == 0 ? " (models/)" : "");
                ++unknownCodes[key];
                unknownExample.emplace(key, e.name.substr(0, e.name.size() - 4) + " " + std::to_string(t.info.width) + "x" +
                                                std::to_string(t.info.height) + " kind " + std::to_string(t.info.kind) + " depth " +
                                                std::to_string(t.info.depth));
                continue;
            }
            // smallest-but-real level that lives in the .tfh
            int lv = -1;
            for (int k = static_cast<int>(t.info.levels.size()) - 1; k >= 0; --k)
                if (!t.info.levels[k].inTfd && t.info.levels[k].width >= 16) {
                    lv = k;
                    break;
                }
            if (lv < 0)
                continue;
            std::vector<uint8_t> rgba;
            uint32_t w, h;
            if (!decodeLevel(t, lv, rgba, w, h, &err) || !decodeLevel(t, lv, rgba, w, h, &err, static_cast<int>(t.info.layers) - 1)) {
                if (bad++ < 10)
                    std::printf("error: %s: %s\n", e.name.c_str(), err.c_str());
            }
        }
        std::printf("texscan: %zu textures, %zu errors, %zu in formats we do not decode\n", n, bad, unknown);
        for (const auto &[k, v] : formats)
            std::printf("  %-12s %-7zu e.g. %s\n", k.c_str(), v, example[k].c_str());
        for (const auto &[k, v] : layered)
            std::printf("  layers %-22s %-6zu e.g. %s\n", k.c_str(), v, layeredExample[k].c_str());
        for (const auto &[k, v] : unknownCodes)
            std::printf("  unknown %-24s %-6zu e.g. %s\n", k.c_str(), v, unknownExample[k].c_str());
        return bad ? 1 : 0;
    }
    if (cmd == "posescan") { // posescan [parameter|*] [prefix]: pose layers (AimPitch by default): how far their clips turn, and whether their bones exist in the model
        const std::string param = args.size() > 1 ? args[1] : "AimPitch";
        const std::string prefix = args.size() > 2 ? args[2] : "models/";
        size_t n = 0, still = 0, unmatched = 0, reversed = 0, mixed = 0, doubled = 0, lost = 0, stacks = 0;
        std::map<std::string, size_t> perParam;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 6 || e.name.compare(e.name.size() - 6, 6, ".model") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            std::vector<uint8_t> raw;
            if (!gd.read(e, raw, nullptr))
                continue;
            const std::string dir = e.name.substr(0, e.name.rfind('/'));
            const ModelDesc md = parseModelDesc(std::string_view(reinterpret_cast<const char *>(raw.data()), raw.size()), dir);
            // the model's nodes (by name), from its mesh
            std::set<std::string> nodeNames;
            // ("mesh" is often a bare name: machinegun_browning -> <folder>/machinegun_browning.mdl)
            std::string mdl = md.mesh.empty() ? e.name.substr(0, e.name.size() - 6) + ".mdl" : normalizeGamePath(md.mesh);
            if (!mdl.empty() && mdl.find('/') == std::string::npos)
                mdl = dir + "/" + mdl;
            if (mdl.size() < 4 || mdl.compare(mdl.size() - 4, 4, ".mdl") != 0)
                mdl += ".mdl";
            {
                std::vector<uint8_t> mb;
                Model m;
                if (gd.find(mdl) && gd.read(mdl, mb, nullptr) && parseModel(std::move(mb), m, nullptr))
                    for (const auto &nd : m.nodes)
                        nodeNames.insert(nd.name);
            }
            std::map<std::string, std::set<std::pair<float, float>>> rangesOf; // parameter -> its moving layers' ranges, low to high
            std::map<std::string, std::set<std::string>> movedBy;              // pose layer -> the nodes it moves
            for (const auto &l : md.layers) {
                if (l.poseParameter.empty() || (param != "*" && l.poseParameter != param))
                    continue;
                ++n;
                ++perParam[l.poseParameter];
                std::vector<std::string> files = l.files;
                if (!l.file.empty())
                    files.insert(files.begin(), l.file);
                double maxAngle = 0, maxMove = 0;
                std::string movers;
                size_t tracksTotal = 0, tracksMatched = 0;
                std::vector<Animation> clips;
                for (const auto &f : files) {
                    std::vector<uint8_t> ar;
                    Animation a;
                    if (gd.find(f) && gd.read(f, ar, nullptr) && parseAnim(ar, a, nullptr))
                        clips.push_back(std::move(a));
                }
                // per bone: the largest turn between any two keys (one clip) or between the poses (files)
                std::map<std::string, std::vector<std::array<float, 7>>> keysOf; // node -> [tx ty tz qx qy qz qw]
                for (const auto &a : clips)
                    for (const auto &t : a.tracks) {
                        ++tracksTotal;
                        tracksMatched += nodeNames.count(t.node) ? 1 : 0;
                        const size_t k = t.times.size();
                        for (size_t i = 0; i < k; ++i) {
                            std::array<float, 7> v{0, 0, 0, 0, 0, 0, 1};
                            if (t.translation.size() >= (i + 1) * 3)
                                for (int c = 0; c < 3; ++c)
                                    v[c] = t.translation[i * 3 + c];
                            if (t.rotation.size() >= (i + 1) * 4)
                                for (int c = 0; c < 4; ++c)
                                    v[3 + c] = t.rotation[i * 4 + c];
                            keysOf[t.node].push_back(v);
                        }
                    }
                // blended poses ("files"): a bone missing from a pose is at rest in it (minigun_relict's
                // fire_mode_0.anim has no tracks, fire_mode_90.anim turns one bone 90 degrees)
                if (clips.size() > 1)
                    for (const auto &a : clips)
                        for (auto &[node, ks] : keysOf)
                            if (std::none_of(a.tracks.begin(), a.tracks.end(), [&](const AnimTrack &t) { return t.node == node && !t.times.empty(); }))
                                ks.push_back({0, 0, 0, 0, 0, 0, 1});
                for (const auto &[node, ks] : keysOf) {
                    double ang = 0, mov = 0;
                    for (size_t i = 0; i < ks.size(); ++i)
                        for (size_t j = i + 1; j < ks.size(); ++j) {
                            const double d = std::abs(ks[i][3] * ks[j][3] + ks[i][4] * ks[j][4] + ks[i][5] * ks[j][5] + ks[i][6] * ks[j][6]);
                            ang = std::max(ang, 2 * std::acos(std::min(1.0, d)) * 180 / 3.14159265358979);
                            mov = std::max(mov, std::sqrt(std::pow(ks[i][0] - ks[j][0], 2) + std::pow(ks[i][1] - ks[j][1], 2) + std::pow(ks[i][2] - ks[j][2], 2)));
                        }
                    if (ang > 0.5 || mov > 0.001) {
                        movers += node + (nodeNames.count(node) ? "" : "(NOT IN MODEL)") + " " + std::to_string(static_cast<int>(ang)) + "deg; ";
                        if (nodeNames.count(node))
                            movedBy[l.name].insert(node);
                    }
                    maxAngle = std::max(maxAngle, ang);
                    maxMove = std::max(maxMove, mov);
                }
                const bool isStill = maxAngle < 0.5 && maxMove < 0.001;
                const bool isUnmatched = tracksTotal && !tracksMatched;
                still += isStill;
                unmatched += isUnmatched;
                reversed += l.poseMin > l.poseMax;
                if (!isStill && !isUnmatched)
                    rangesOf[l.poseParameter].insert({std::min(l.poseMin, l.poseMax), std::max(l.poseMin, l.poseMax)});
                std::printf("%s%s %s %s layer %s%s%s range %g..%g, %zu clip(s), %zu tracks (%zu in the model), turns up to %.1f deg, moves %.3f m | %s\n",
                            isStill ? "STILL" : isUnmatched ? "UNMATCHED" : "ok   ", l.poseMin > l.poseMax ? " high-to-low" : "", e.name.c_str(), l.poseParameter.c_str(), l.name.c_str(),
                            l.activity.empty() ? "" : " activity ", l.activity.c_str(), l.poseMin, l.poseMax, clips.size(), tracksTotal, tracksMatched, maxAngle, maxMove,
                            movers.substr(0, 200).c_str());
            }
            // one slider drives every layer of a parameter: do the moving layers agree on the range?
            for (const auto &[p, rs] : rangesOf)
                if (rs.size() > 1) {
                    ++mixed;
                    std::printf("RANGES %s %s:", e.name.c_str(), p.c_str());
                    for (const auto &[lo, hi] : rs)
                        std::printf(" %g..%g", lo, hi);
                    std::printf("\n");
                }
            // Which pose layers play together (the viewer's rule, ui/anim.js poseLayers): the picked
            // activity's stack (its layer and what it adds, recursively), with nothing picked IDLE's
            // stack (else the first activity's), plus the pose layers no activity adds. In such a set
            // no bone may be driven twice through one parameter (flame_thrower's "aim" for IDLE and
            // "fire" for FIRE play the same pitch clip), and with nothing picked every parameter that
            // moves something should have a layer (a slider).
            if (param == "*") {
                std::map<std::string, const AnimLayer *> byName;
                for (const auto &l : md.layers)
                    byName[l.name] = &l; // (a repeated name: the last one, as in the viewer)
                auto stackOf = [&](const std::string &root) {
                    std::set<std::string> s;
                    std::vector<std::string> todo{root};
                    while (!todo.empty()) {
                        const std::string x = todo.back();
                        todo.pop_back();
                        const auto it = byName.find(x);
                        if (it == byName.end() || !s.insert(x).second)
                            continue;
                        for (const auto &a : it->second->addLayers)
                            todo.push_back(a);
                    }
                    return s;
                };
                std::vector<const AnimLayer *> acts;
                std::set<std::string> inStack;
                const AnimLayer *idle = nullptr;
                for (const auto &l : md.layers)
                    if (!l.activity.empty() && byName[l.name] == &l) {
                        acts.push_back(&l);
                        if (!idle && l.activity == "IDLE")
                            idle = &l;
                        for (const auto &x : stackOf(l.name))
                            inStack.insert(x);
                    }
                auto playing = [&](const AnimLayer *root) {
                    const std::set<std::string> s = root ? stackOf(root->name) : std::set<std::string>{};
                    std::vector<const AnimLayer *> out;
                    for (const auto &[name, l] : byName)
                        if (!l->poseParameter.empty() && (s.count(name) || !inStack.count(name)))
                            out.push_back(l);
                    return out;
                };
                auto doubles = [&](const std::vector<const AnimLayer *> &ls, const std::string &what) {
                    std::map<std::pair<std::string, std::string>, std::string> driver; // (parameter, node) -> layer
                    for (const AnimLayer *l : ls)
                        for (const auto &nd : movedBy[l->name]) {
                            auto [it, fresh] = driver.emplace(std::make_pair(l->poseParameter, nd), l->name);
                            if (!fresh) {
                                ++doubled;
                                std::printf("DOUBLE %s (%s): %s moves %s through both %s and %s\n", e.name.c_str(), what.c_str(), l->poseParameter.c_str(), nd.c_str(),
                                            it->second.c_str(), l->name.c_str());
                            }
                        }
                };
                const AnimLayer *def = idle ? idle : acts.empty() ? nullptr : acts.front();
                const auto base = playing(def);
                doubles(base, "nothing picked");
                ++stacks;
                for (const AnimLayer *a : acts) {
                    doubles(playing(a), a->activity + " " + a->name);
                    ++stacks;
                }
                std::set<std::string> moving, inBase;
                for (const auto &[name, l] : byName)
                    if (!l->poseParameter.empty() && !movedBy[name].empty())
                        moving.insert(l->poseParameter);
                for (const AnimLayer *l : base)
                    if (!movedBy[l->name].empty())
                        inBase.insert(l->poseParameter);
                for (const auto &p : moving)
                    if (!inBase.count(p)) {
                        ++lost;
                        std::printf("NOSLIDER %s: %s has no layer with nothing picked (default stack: %s)\n", e.name.c_str(), p.c_str(), def ? def->name.c_str() : "none");
                    }
            }
        }
        std::printf("posescan %s: %zu layers, %zu that move nothing, %zu whose bones are not in the model, %zu declared high to low, %zu parameters whose layers disagree on the range\n",
                    param.c_str(), n, still, unmatched, reversed, mixed);
        if (param == "*") {
            std::printf("  layer sets that play together: %zu checked, %zu bones driven twice through one parameter, %zu parameters without a slider when nothing is picked\n",
                        stacks, doubled, lost);
            std::printf("  parameters:");
            for (const auto &[k, v] : perParam)
                std::printf(" %s=%zu", k.c_str(), v);
            std::printf("\n");
        }
        return 0;
    }
    if (cmd == "rangecheck") { // rangecheck [n]: every level of n textures read through loadTextureLevels (only the .tfd chunks it needs) against a whole read
        const size_t limit = args.size() > 1 ? std::stoul(args[1]) : 1000000;
        size_t textures = 0, levels = 0, bad = 0, partial = 0;
        double fullBytes = 0, partBytes = 0;
        for (const auto &e : gd.entries()) {
            if (textures >= limit)
                break;
            if (e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".tfd") != 0)
                continue;
            const std::string base = e.name.substr(0, e.name.size() - 4);
            Texture full;
            if (!loadTexture(gd, base, full, nullptr))
                continue;
            ++textures;
            fullBytes += static_cast<double>(full.tfd.size());
            const int n = static_cast<int>(full.info.levels.size());
            for (int from = 0; from < n; ++from) {
                for (int to : {from, n - 1}) {
                    Texture part;
                    std::string why;
                    if (!loadTextureHeader(gd, base, part, &why) || !loadTextureLevels(gd, part, from, to, &why)) {
                        if (bad++ < 5)
                            std::printf("  FAIL %s levels %d..%d: %s\n", base.c_str(), from, to, why.c_str());
                        continue;
                    }
                    partBytes += static_cast<double>(part.tfd.size());
                    partial += part.tfd.size() < full.tfd.size();
                    for (int lv = from; lv <= to; ++lv)
                        for (int l = 0; l < static_cast<int>(full.info.layers); ++l) { // (every layer of a cube map or array)
                            const uint8_t *a, *b;
                            size_t na, nb;
                            const bool ha = full.levelData(lv, a, na, l), hb = part.levelData(lv, b, nb, l);
                            ++levels;
                            if (ha != hb || (ha && (na != nb || std::memcmp(a, b, na) != 0))) {
                                if (bad++ < 5)
                                    std::printf("  MISMATCH %s level %d layer %d (asked %d..%d)\n", base.c_str(), lv, l, from, to);
                            }
                        }
                }
            }
        }
        std::printf("rangecheck: %zu textures, %zu level reads compared, %zu bad; %zu partial reads were smaller than the whole .tfd\n", textures, levels, bad,
                    partial);
        (void)fullBytes;
        (void)partBytes;
        return bad ? 1 : 0;
    }
    if (cmd == "animdump" && args.size() > 1) { // animdump <x.anim> [keys]: every track's keys (translation, rotation as axis + angle)
        std::vector<uint8_t> raw;
        Animation a;
        if (!gd.read(args[1], raw, &err) || !parseAnim(raw, a, &err)) {
            std::printf("FAIL: %s\n", err.c_str());
            return 1;
        }
        const size_t maxKeys = args.size() > 2 ? std::stoul(args[2]) : 4;
        std::printf("%s: %zu bytes, duration %g s, unknown0 %g, %zu tracks\n", args[1].c_str(), raw.size(), a.duration, a.unknown0, a.tracks.size());
        for (const auto &t : a.tracks) {
            std::printf("  %-32s bone %-3u format %u, %zu keys\n", t.node.c_str(), t.bone, t.format, t.times.size());
            for (size_t k = 0; k < t.times.size() && k < maxKeys; ++k) {
                std::printf("    t %-8.4g", t.times[k]);
                if (t.translation.size() >= (k + 1) * 3)
                    std::printf(" T (%.4f %.4f %.4f)", t.translation[k * 3], t.translation[k * 3 + 1], t.translation[k * 3 + 2]);
                if (t.rotation.size() >= (k + 1) * 4) {
                    const float *q = &t.rotation[k * 4];
                    const double s = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
                    const double ang = 2 * std::atan2(s, std::abs(q[3])) * 180 / 3.14159265358979;
                    const double sg = q[3] < 0 ? -1 : 1;
                    std::printf(" R (%.4f %.4f %.4f %.4f) = %.2f deg about (%.3f %.3f %.3f)", q[0], q[1], q[2], q[3], ang, s > 1e-9 ? sg * q[0] / s : 0.0,
                                s > 1e-9 ? sg * q[1] / s : 0.0, s > 1e-9 ? sg * q[2] / s : 0.0);
                }
                std::printf("\n");
            }
        }
        return 0;
    }
    if (cmd == "animscan") { // parse every .anim (both key-time orders) and every .model's layers
        size_t files = 0, bad = 0, okGrouped = 0, okHeader = 0, differ = 0, badQuat = 0, tracks = 0;
        std::map<uint32_t, size_t> formats;
        std::string firstErr;
        auto timesOk = [](const Animation &a) {
            for (const auto &t : a.tracks) {
                if (t.times.size() < 2)
                    continue;
                if (t.times.front() != 0 || std::abs(t.times.back() - a.duration) > 1e-4f)
                    return false;
                for (size_t k = 1; k < t.times.size(); ++k)
                    if (t.times[k] < t.times[k - 1])
                        return false;
            }
            return true;
        };
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 5 || e.name.compare(e.name.size() - 5, 5, ".anim") != 0)
                continue;
            ++files;
            std::vector<uint8_t> raw;
            Animation g, h;
            std::string e1, e2;
            if (!gd.read(e, raw, &e1) || !parseAnimEx(raw, g, &e1, false) || !parseAnimEx(raw, h, &e2, true)) {
                if (bad++ == 0)
                    firstErr = e.name + ": " + e1 + e2;
                continue;
            }
            const bool og = timesOk(g), oh = timesOk(h);
            okGrouped += og;
            okHeader += oh;
            bool same = true;
            for (size_t t = 0; t < g.tracks.size(); ++t)
                same = same && g.tracks[t].times == h.tracks[t].times;
            differ += !same;
            if (!same && og != oh && differ <= 3)
                std::printf("  times differ: %s grouped %s, header %s\n", e.name.c_str(), og ? "ok" : "BAD", oh ? "ok" : "BAD");
            for (const auto &t : g.tracks) {
                ++tracks;
                ++formats[t.format];
                for (size_t k = 0; k + 3 < t.rotation.size(); k += 4) {
                    const float n = t.rotation[k] * t.rotation[k] + t.rotation[k + 1] * t.rotation[k + 1] + t.rotation[k + 2] * t.rotation[k + 2] +
                                    t.rotation[k + 3] * t.rotation[k + 3];
                    if (std::abs(n - 1) > 0.02f) {
                        ++badQuat;
                        break;
                    }
                }
            }
        }
        std::printf("animscan: %zu .anim files, %zu failed to parse%s%s\n", files, bad, bad ? ": " : "", firstErr.c_str());
        std::printf("  %zu tracks (format 0: %zu, 1: %zu, 2: %zu), %zu tracks with non-unit rotations\n", tracks, formats[0], formats[1], formats[2], badQuat);
        std::printf("  key times valid: grouped order %zu files, header order %zu files (%zu files where the orders differ)\n", okGrouped, okHeader, differ);
        // .model layer definitions
        size_t models = 0, layers = 0, missing = 0;
        std::map<std::string, size_t> activities, poses;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 6 || e.name.compare(e.name.size() - 6, 6, ".model") != 0)
                continue;
            std::vector<uint8_t> raw;
            if (!gd.read(e, raw, &err))
                continue;
            ++models;
            const std::string dir = e.name.substr(0, e.name.rfind('/'));
            const ModelDesc md = parseModelDesc(std::string_view(reinterpret_cast<const char *>(raw.data()), raw.size()), dir);
            for (const auto &l : md.layers) {
                ++layers;
                if (!l.activity.empty())
                    ++activities[l.activity];
                if (!l.poseParameter.empty())
                    ++poses[l.poseParameter];
                if (!l.file.empty() && !gd.find(l.file) && missing++ < 3)
                    std::printf("  missing anim %s (layer %s in %s)\n", l.file.c_str(), l.name.c_str(), e.name.c_str());
            }
        }
        std::printf("  %zu .model files, %zu anim layers, %zu missing .anim files\n  activities:", models, layers, missing);
        for (const auto &[k, v] : activities)
            std::printf(" %s=%zu", k.c_str(), v);
        std::printf("\n  pose parameters:");
        for (const auto &[k, v] : poses)
            std::printf(" %s=%zu", k.c_str(), v);
        std::printf("\n");
        return bad ? 1 : 0;
    }
    if (cmd == "rigidscan") { // meshes without skinning: is words[6] a valid node (the one they ride on)?
        size_t rigid = 0, attached = 0, invalid = 0, skinned = 0, models = 0, withAnim = 0, withAnimAttached = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0 || e.name.rfind("models/", 0) != 0)
                continue;
            std::vector<uint8_t> raw;
            Model m;
            if (!gd.read(e, raw, &err) || !parseModel(std::move(raw), m, &err))
                continue;
            ++models;
            const bool anim = gd.find(e.name.substr(0, e.name.size() - 4) + ".model") != nullptr;
            bool att = false;
            for (const auto &me : m.meshes) {
                if (me.maxInfluences > 0 || me.words[5] != 0) {
                    ++skinned;
                    continue;
                }
                ++rigid;
                if (me.words[6] >= m.nodes.size() && !m.nodes.empty()) {
                    if (invalid++ < 3)
                        std::printf("  node index %u >= %zu nodes: %s\n", me.words[6], m.nodes.size(), e.name.c_str());
                } else if (me.words[6] != 0) {
                    ++attached;
                    att = true;
                }
            }
            withAnim += anim;
            withAnimAttached += anim && att;
        }
        std::printf("rigidscan: %zu models, %zu skinned meshes, %zu rigid meshes (%zu on a node other than the root, %zu with an invalid node)\n",
                    models, skinned, rigid, attached, invalid);
        std::printf("  %zu models have a .model file, %zu of them with rigid meshes riding on a node\n", withAnim, withAnimAttached);
        return 0;
    }
    if (cmd == "nodes" && args.size() >= 2) { // nodes <model.mdl>: skeleton + which meshes are skinned to it
        ModelBundle b;
        if (!loadBundle(gd, args[1], "", b, &err))
            return fail(err);
        for (size_t i = 0; i < b.model.nodes.size(); ++i) {
            const Node &n = b.model.nodes[i];
            std::printf("node %2zu %-24s parent %2d  t(%.3f %.3f %.3f) r(%.3f %.3f %.3f %.3f)  world t(%.3f %.3f %.3f)\n", i, n.name.c_str(), n.parent,
                        n.translation[0], n.translation[1], n.translation[2], n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3], n.world[12],
                        n.world[13], n.world[14]);
        }
        for (size_t m = 0; m < b.model.meshes.size(); ++m) {
            MeshGeometry g;
            if (!decodeMesh(b.model, b.model.meshes[m], g, &err))
                continue;
            int maxJ = -1;
            std::map<int, size_t> used;
            for (size_t v = 0; v < g.joints.size(); ++v)
                if (g.weights[v] > 0) {
                    maxJ = std::max(maxJ, static_cast<int>(g.joints[v]));
                    ++used[g.joints[v]];
                }
            std::printf("mesh %zu lod %d words[", m, b.model.meshes[m].lod);
            for (int w = 0; w < 12; ++w)
                std::printf("%s%u", w ? " " : "", b.model.meshes[m].words[w]);
            std::printf("] flags %08x: %u verts, %s", b.model.meshes[m].flags, g.vertexCount, g.joints.empty() ? "not skinned" : "skinned, joints used:");
            for (const auto &[j, c] : used)
                std::printf(" %d", j);
            std::printf("\n");
        }
        return 0;
    }
    if (cmd == "find" && args.size() >= 2) { // find <substring> [max]: archive paths containing it (with sizes)
        const std::string needle = normalizeGamePath(args[1]);
        const size_t max = args.size() > 2 ? std::stoul(args[2]) : 200;
        size_t n = 0;
        for (const auto &e : gd.entries())
            if (e.name.find(needle) != std::string::npos && n++ < max)
                std::printf("%10llu  %s\n", static_cast<unsigned long long>(e.size), e.name.c_str());
        std::printf("find: %zu matches\n", n);
        return 0;
    }
    if (cmd == "alphalist") { // alphalist [prefix]: models with cut-out or glass materials (for visual checks)
        const std::string prefix = args.size() > 1 ? args[1] : "models/";
        size_t cut = 0, glass = 0, models = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            ModelBundle b;
            if (!loadBundle(gd, e.name, "", b, &err))
                continue;
            ++models;
            bool c = false, g = false, visible = false;
            for (const auto &m : b.materials) {
                c = c || m.alphaTest;
                g = g || m.blend;
                const TextureRef *alb = m.texture("albedo");
                if (m.alphaTest && alb && alb->exists && !visible) { // does the cut-out actually remove texels?
                    Texture t;
                    std::string e2;
                    if (loadTexture(gd, alb->base, t, &e2, false)) {
                        int lv = -1;
                        for (int k = static_cast<int>(t.info.levels.size()) - 1; k >= 0; --k)
                            if (!t.info.levels[k].inTfd && t.info.levels[k].width >= 32) {
                                lv = k;
                                break;
                            }
                        std::vector<uint8_t> px;
                        uint32_t w, h;
                        if (lv >= 0 && decodeLevel(t, lv, px, w, h, &e2)) {
                            size_t low = 0;
                            for (size_t i = 3; i < px.size(); i += 4)
                                low += px[i] < 128;
                            visible = low * 50 > px.size() / 4;
                        }
                    }
                }
            }
            cut += c;
            glass += g;
            if (c || g)
                std::printf("%s %s%s%s\n", e.name.c_str(), c ? "cutout" : "", g ? (c ? "+glass" : "glass") : "", visible ? " holes" : "");
        }
        std::printf("alphalist: %zu models, %zu with cut-outs, %zu with glass\n", models, cut, glass);
        return 0;
    }
    if (cmd == "mdfscan") { // material switches (pins, alpha flags) vs. albedos whose alpha has holes
        struct Stat {
            size_t n = 0, holes = 0, solid = 0;
            std::vector<std::string> ex;
        };
        std::map<std::string, Stat> stats;
        std::map<std::string, int> alphaOf; // albedo base -> 1 has cut-out holes, 0 solid, -1 unknown
        auto holes = [&](const std::string &base) -> int {
            auto it = alphaOf.find(base);
            if (it != alphaOf.end())
                return it->second;
            int r = -1;
            Texture t;
            std::string e;
            if (loadTexture(gd, base, t, &e, false)) {
                int lv = -1;
                for (int k = static_cast<int>(t.info.levels.size()) - 1; k >= 0; --k)
                    if (!t.info.levels[k].inTfd && t.info.levels[k].width >= 32) {
                        lv = k;
                        break;
                    }
                std::vector<uint8_t> px;
                uint32_t w, h;
                if (lv >= 0 && decodeLevel(t, lv, px, w, h, &e)) {
                    size_t low = 0;
                    for (size_t i = 3; i < px.size(); i += 4)
                        low += px[i] < 128;
                    r = low * 50 > px.size() / 4 ? 1 : 0; // more than 2% of the texels see-through
                }
            }
            return alphaOf[base] = r;
        };
        const std::string prefix = args.size() > 1 ? args[1] : "models/";
        size_t files = 0, mats = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdf") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            std::vector<uint8_t> raw;
            std::vector<Material> ms;
            if (!gd.read(e, raw, &err) || !parseMdf(std::string_view(reinterpret_cast<const char *>(raw.data()), raw.size()), ms, &err))
                continue;
            ++files;
            for (size_t k = 0; k < ms.size(); ++k) {
                const Material &m = ms[k];
                ++mats;
                const std::string alb = textureBase(m.value("DiffuseSampler"));
                const int hl = alb.empty() ? -1 : holes(alb);
                if (hl == 1 && args.size() > 2 && args[2] == "list") {
                    std::string pins;
                    for (const auto &p : m.params)
                        if (p.type == "pin")
                            pins += p.name + "=" + p.value + " ";
                    std::printf("HOLES %s#%zu shader %s | %s| %s\n", e.name.c_str(), k, m.guid.substr(0, 8).c_str(), pins.c_str(), alb.c_str());
                }
                std::vector<std::string> keys = {"(all)", "shader " + m.guid.substr(0, 8)};
                for (const auto &p : m.params)
                    if (p.type == "pin" || p.name.find("Alpha") != std::string::npos || p.name.find("Discard") != std::string::npos ||
                        p.name.find("Blend") != std::string::npos || p.name.find("Transp") != std::string::npos)
                        keys.push_back(p.name + "=" + p.value);
                for (const auto &key : keys) {
                    Stat &s = stats[key];
                    ++s.n;
                    s.holes += hl == 1;
                    s.solid += hl == 0;
                    if (s.ex.size() < 3 && (hl == 1 || s.ex.empty()))
                        s.ex.push_back(e.name + "#" + std::to_string(k) + (hl == 1 ? " (holes)" : ""));
                }
            }
        }
        // by albedo pixel format: how many of those albedos have see-through texels
        std::map<std::string, std::pair<size_t, size_t>> byFormat;
        for (const auto &[base, hl] : alphaOf) {
            Texture t;
            std::string e;
            if (hl < 0 || !loadTexture(gd, base, t, &e, false))
                continue;
            auto &f = byFormat[pixelFormatName(t.info.format)];
            (hl ? f.first : f.second)++;
        }
        std::printf("albedo formats (textures with holes / without):\n");
        for (const auto &[k, v] : byFormat)
            std::printf("  %-12s %6zu %6zu\n", k.c_str(), v.first, v.second);
        std::printf("mdfscan: %zu .mdf files, %zu materials under %s\n", files, mats, prefix.c_str());
        std::printf("  %-34s %7s %7s %7s  examples\n", "switch", "mats", "holes", "solid");
        for (const auto &[k, s] : stats)
            if (s.n >= 3)
                std::printf("  %-34s %7zu %7zu %7zu  %s\n", k.c_str(), s.n, s.holes, s.solid, s.ex.empty() ? "" : s.ex.back().c_str());
        return 0;
    }
    if (cmd == "emisscan") { // emisscan [prefix] [list]: glow-map slots by shader and suffix, with their UserParams
        struct Stat {
            size_t n = 0;
            std::map<std::string, size_t> params;
            std::vector<std::string> ex;
        };
        std::map<std::string, Stat> stats;
        const std::string prefix = args.size() > 1 ? args[1] : "models/";
        size_t files = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdf") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            std::vector<uint8_t> raw;
            std::vector<Material> ms;
            if (!gd.read(e, raw, &err) || !parseMdf(std::string_view(reinterpret_cast<const char *>(raw.data()), raw.size()), ms, &err))
                continue;
            ++files;
            for (size_t k = 0; k < ms.size(); ++k) {
                const Material &m = ms[k];
                for (const auto &p : m.params) {
                    const std::string role = textureRole(p.name);
                    if (role != "albedo2" && role != "colormap")
                        continue;
                    const std::string base = textureBase(p.value);
                    const std::string leaf = base.substr(base.rfind('/') + 1);
                    std::string suf;
                    for (const char *s : {"_e", "_glow", "_glow2", "_anim"})
                        if (leaf.size() > std::strlen(s) && leaf.compare(leaf.size() - std::strlen(s), std::strlen(s), s) == 0)
                            suf = s;
                    if (suf.empty())
                        continue;
                    const std::string key = m.guid.substr(0, 8) + " " + p.name + " " + suf;
                    Stat &s = stats[key];
                    ++s.n;
                    std::string others;
                    for (const auto &q : m.params)
                        if (textureRole(q.name).empty())
                            others += q.name + "=" + q.value + "; ";
                    for (const auto &q : m.params)
                        if (textureRole(q.name).empty())
                            ++s.params[q.name + (q.name.rfind("UserParam", 0) == 0 || q.type == "pin" ? "=" + q.value : "")];
                    if (s.ex.size() < 4)
                        s.ex.push_back(e.name + "#" + std::to_string(k) + " " + leaf);
                    if (args.size() > 2 && args[2] == "list")
                        std::printf("GLOW %s#%zu %s %s | %s\n", e.name.c_str(), k, key.c_str(), leaf.c_str(), others.c_str());
                }
            }
        }
        std::printf("emisscan: %zu .mdf files under %s\n", files, prefix.c_str());
        for (const auto &[k, s] : stats) {
            std::printf("%-58s %6zu  e.g. %s\n", k.c_str(), s.n, s.ex.front().c_str());
            std::vector<std::pair<size_t, std::string>> top;
            for (const auto &[pk, pn] : s.params)
                top.emplace_back(pn, pk);
            std::sort(top.rbegin(), top.rend());
            for (size_t i = 0; i < top.size() && i < 8; ++i)
                std::printf("      %6zu  %s\n", top[i].first, top[i].second.c_str());
        }
        return 0;
    }
    if (cmd == "texrole") { // texrole [prefix ...]: material textures by role: sRGB flags, normal-map layout guesses against the others, gloss channels
        std::vector<std::string> prefixes(args.begin() + 1, args.end());
        if (prefixes.empty())
            prefixes = {"models/"};
        std::map<std::string, std::set<std::string>> byRole; // role -> texture bases
        std::map<std::string, std::string> example;           // base -> a model using it
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            if (std::none_of(prefixes.begin(), prefixes.end(), [&](const std::string &p) { return e.name.rfind(p, 0) == 0; }))
                continue;
            ModelBundle b;
            if (!loadBundle(gd, e.name, "", b, nullptr))
                continue;
            for (const auto &mv : b.materials) {
                if (mv.invisible || mv.glow.on)
                    continue;
                for (const auto &t : mv.textures)
                    if (t.exists) {
                        byRole[t.role].insert(t.base);
                        example.emplace(t.base, e.name);
                    }
            }
        }
        auto smallLevel = [&](Texture &t, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h) {
            int lv = t.firstLevel();
            while (lv + 1 < static_cast<int>(t.info.levels.size()) && std::max(t.info.levels[lv].width, t.info.levels[lv].height) > 128)
                ++lv;
            return lv >= 0 && decodeLevel(t, lv, rgba, w, h, nullptr);
        };
        for (const auto &[role, bases] : byRole) {
            std::map<std::string, size_t> fmts;
            for (const auto &base : bases) {
                Texture t;
                if (loadTexture(gd, base, t, nullptr, false))
                    ++fmts[pixelFormatName(t.info.format)];
            }
            std::printf("%-10s %5zu textures:", role.c_str(), bases.size());
            for (const auto &[f, n] : fmts)
                std::printf("  %s %zu", f.c_str(), n);
            std::printf("\n");
        }
        // normal maps: how normal-like each layout makes them (unit length before z is rebuilt, z > 0)
        size_t checked = 0, flagged = 0;
        for (const auto &base : byRole["normal"]) {
            Texture t;
            std::vector<uint8_t> rgba;
            uint32_t w = 0, h = 0;
            if (!loadTexture(gd, base, t, nullptr) || !smallLevel(t, rgba, w, h))
                continue;
            ++checked;
            const NormalLayout guess = guessNormalLayout(t.info.format, rgba);
            auto quality = [&](NormalLayout L) { // share of texels whose decoded x, y fit a unit normal facing out (|xy| < 0.97)
                size_t good = 0, n = rgba.size() / 4;
                double sumZ = 0;
                for (size_t i = 0; i < n; ++i) {
                    const uint8_t *p = &rgba[i * 4];
                    double x, y, z;
                    if (L == NormalLayout::RGB) {
                        x = p[0] / 127.5 - 1, y = p[1] / 127.5 - 1, z = p[2] / 127.5 - 1;
                        const double l = std::sqrt(x * x + y * y + z * z);
                        if (std::abs(l - 1) < 0.2 && z > 0.2)
                            ++good;
                        sumZ += z;
                        continue;
                    }
                    if (L == NormalLayout::AG)
                        x = p[3] / 127.5 - 1, y = p[1] / 127.5 - 1;
                    else
                        x = p[0] / 127.5 - 1, y = p[1] / 127.5 - 1;
                    const double r2 = x * x + y * y;
                    z = std::sqrt(std::max(0.0, 1 - r2));
                    if (r2 < 0.94)
                        ++good;
                    sumZ += z;
                }
                return std::pair<double, double>(n ? static_cast<double>(good) / n : 0, n ? sumZ / n : 0);
            };
            const char *names[3] = {"RGB", "RG", "AG"};
            const NormalLayout all[3] = {NormalLayout::RGB, NormalLayout::RG, NormalLayout::AG};
            std::pair<double, double> q[3];
            int gi = 0;
            for (int i = 0; i < 3; ++i) {
                q[i] = quality(all[i]);
                if (all[i] == guess)
                    gi = i;
            }
            // flag: the guess's texels look much less like normals than another layout's, or the guess
            // leaves the surface tilted on average (mean z low)
            int best = gi;
            for (int i = 0; i < 3; ++i)
                if (q[i].first > q[best].first + 0.15 && q[i].second > q[gi].second + 0.05)
                    best = i;
            if (best != gi || q[gi].second < 0.75) {
                ++flagged;
                std::printf("NRM %s (%s %ux%u) guess %s good %.2f meanZ %.2f | RGB %.2f/%.2f RG %.2f/%.2f AG %.2f/%.2f | e.g. %s\n", base.c_str(), pixelFormatName(t.info.format), w, h,
                            names[gi], q[gi].first, q[gi].second, q[0].first, q[0].second, q[1].first, q[1].second, q[2].first, q[2].second, example[base].c_str());
            }
        }
        std::printf("normal maps: %zu checked, %zu flagged\n", checked, flagged);
        // colour textures stored without the sRGB flag, and gloss maps' channels
        for (const char *role : {"albedo", "emissive"}) {
            size_t lin = 0;
            for (const auto &base : byRole[role]) {
                Texture t;
                if (loadTexture(gd, base, t, nullptr, false) && !isSrgb(t.info.format) && t.info.format != PixelFormat::Unknown) {
                    if (lin++ < 12)
                        std::printf("LIN %s %s (%s) e.g. %s\n", role, base.c_str(), pixelFormatName(t.info.format), example[base].c_str());
                }
            }
            std::printf("%s textures without the sRGB flag: %zu\n", role, lin);
        }
        size_t gl = 0, metal = 0, shiny = 0;
        for (const auto &base : byRole["gloss"]) {
            Texture t;
            std::vector<uint8_t> rgba;
            uint32_t w = 0, h = 0;
            if (!loadTexture(gd, base, t, nullptr) || !smallLevel(t, rgba, w, h))
                continue;
            ++gl;
            double g = 0, bl = 0;
            const size_t n = rgba.size() / 4;
            for (size_t i = 0; i < n; ++i)
                g += rgba[i * 4 + 1], bl += rgba[i * 4 + 2];
            g /= 255.0 * n, bl /= 255.0 * n;
            if (bl > 0.8 && metal++ < 10)
                std::printf("METAL %s mean metal %.2f gloss %.2f e.g. %s\n", base.c_str(), bl, g, example[base].c_str());
            if (g > 0.9 && shiny++ < 10)
                std::printf("SHINY %s mean gloss %.2f metal %.2f e.g. %s\n", base.c_str(), g, bl, example[base].c_str());
        }
        std::printf("gloss maps: %zu, mostly metal %zu, mirror-glossy %zu\n", gl, metal, shiny);
        return 0;
    }
    if (cmd == "geoscan") { // geoscan [prefix ...]: mesh health: bad numbers, inside-out normals, tangents against the UVs, LODs, skins
        std::vector<std::string> prefixes(args.begin() + 1, args.end());
        if (prefixes.empty())
            prefixes = {"models/", "assets/"};
        struct Bad {
            std::string model, what;
            int mesh = 0, lod = 0;
            uint32_t material = 0;
            double score = 0;
        };
        std::vector<Bad> bads;
        size_t models = 0, meshes = 0, tris = 0, tanTris = 0, tanAgree = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            if (std::none_of(prefixes.begin(), prefixes.end(), [&](const std::string &p) { return e.name.rfind(p, 0) == 0; }))
                continue;
            std::vector<uint8_t> bytes;
            Model m;
            if (!gd.read(e, bytes, nullptr) || !parseModel(std::move(bytes), m, nullptr))
                continue;
            ++models;
            // the header box in glTF space (z mirrored), a little wider
            const float mn[3] = {m.bbMin[0], m.bbMin[1], -m.bbMax[2]}, mx[3] = {m.bbMax[0], m.bbMax[1], -m.bbMin[2]};
            const float pad = 0.02f + 0.02f * std::max({mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]});
            std::map<int, std::array<float, 6>> lodBox;
            for (size_t k = 0; k < m.meshes.size(); ++k) {
                const MeshInfo &me = m.meshes[k];
                MeshGeometry g;
                if (!decodeMesh(m, me, g, nullptr))
                    continue;
                ++meshes;
                auto bad = [&](const std::string &what, double score) { bads.push_back({e.name, what, static_cast<int>(k), me.lod, me.material, score}); };
                size_t nonFinite = 0;
                std::string where;
                const char *names[5] = {"position", "normal", "uv0", "uv1", "tangent"};
                const std::vector<float> *arrs[5] = {&g.position, &g.normal, &g.uv0, &g.uv1, &g.tangent};
                for (int q = 0; q < 5; ++q) {
                    size_t nf = 0, huge = 0;
                    for (float f : *arrs[q])
                        nf += !std::isfinite(f), huge += std::isfinite(f) && std::abs(f) > 1000;
                    if (nf || huge)
                        where += std::string(" ") + names[q] + " " + std::to_string(nf) + " non-finite, " + std::to_string(huge) + " beyond 1000;";
                    nonFinite += nf;
                }
                if (!where.empty())
                    bad("bad numbers:" + where + " (" + std::to_string(g.vertexCount) + " vertices)", nonFinite ? 1e9 : 1e8);
                auto &bx = lodBox.try_emplace(me.lod, std::array<float, 6>{1e30f, 1e30f, 1e30f, -1e30f, -1e30f, -1e30f}).first->second;
                size_t outside = 0;
                float uvMax = 0;
                for (uint32_t v = 0; v < g.vertexCount; ++v) {
                    const float *p = &g.position[v * 3];
                    for (int c = 0; c < 3; ++c) {
                        bx[c] = std::min(bx[c], p[c]);
                        bx[3 + c] = std::max(bx[3 + c], p[c]);
                    }
                    if (!me.speedTree && g.joints.empty())
                        for (int c = 0; c < 3; ++c)
                            if (p[c] < mn[c] - pad || p[c] > mx[c] + pad) {
                                ++outside;
                                break;
                            }
                    for (size_t q = 0; q < 2 && !g.uv0.empty(); ++q)
                        uvMax = std::max(uvMax, std::abs(g.uv0[v * 2 + q]));
                }
                if (outside > g.vertexCount / 100 + 2)
                    bad("vertices outside the model box: " + std::to_string(outside) + "/" + std::to_string(g.vertexCount), static_cast<double>(outside) / g.vertexCount);
                if (uvMax > 256)
                    bad("uv0 up to " + std::to_string(static_cast<int>(uvMax)), uvMax / 256);
                // triangles: degenerate, normals against the winding, tangents against the UVs
                size_t nt = 0, degenerate = 0, flipped = 0, tAgree = 0, tTotal = 0;
                for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
                    const uint32_t a = g.indices[t], b = g.indices[t + 1], c = g.indices[t + 2];
                    const float *pa = &g.position[a * 3], *pb = &g.position[b * 3], *pc = &g.position[c * 3];
                    const float e1[3] = {pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]}, e2[3] = {pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]};
                    const float fn[3] = {e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
                    const float area2 = std::sqrt(fn[0] * fn[0] + fn[1] * fn[1] + fn[2] * fn[2]);
                    ++nt;
                    if (area2 < 1e-10f) {
                        ++degenerate;
                        continue;
                    }
                    if (!g.normal.empty()) {
                        float vn[3] = {0, 0, 0};
                        for (uint32_t i : {a, b, c})
                            for (int q = 0; q < 3; ++q)
                                vn[q] += g.normal[i * 3 + q];
                        if (fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2] < 0)
                            ++flipped;
                    }
                    if (!g.tangent.empty() && !g.uv0.empty() && !g.normal.empty()) {
                        const float du1 = g.uv0[b * 2] - g.uv0[a * 2], dv1 = g.uv0[b * 2 + 1] - g.uv0[a * 2 + 1];
                        const float du2 = g.uv0[c * 2] - g.uv0[a * 2], dv2 = g.uv0[c * 2 + 1] - g.uv0[a * 2 + 1];
                        const float det = du1 * dv2 - du2 * dv1;
                        if (std::abs(det) < 1e-12f)
                            continue;
                        // the UV triangle's handedness against its winding, and the stored frame's
                        const float uvSign = det > 0 ? 1.0f : -1.0f;
                        float w = 0;
                        for (uint32_t i : {a, b, c})
                            w += g.tangent[i * 4 + 3];
                        ++tTotal;
                        if ((w > 0 ? 1.0f : -1.0f) == uvSign)
                            ++tAgree;
                    }
                }
                tris += nt;
                tanTris += tTotal;
                tanAgree += tAgree;
                if (nt >= 8 && degenerate > nt / 4)
                    bad("degenerate triangles: " + std::to_string(degenerate) + "/" + std::to_string(nt), static_cast<double>(degenerate) / nt);
                const size_t valid = nt - degenerate;
                if (valid >= 8 && flipped > valid / 2)
                    bad("normals against the winding: " + std::to_string(flipped) + "/" + std::to_string(valid) + " triangles", static_cast<double>(flipped) / valid);
                if (tTotal >= 8)
                    bads.push_back({e.name, "tangent-agree " + std::to_string(tAgree) + "/" + std::to_string(tTotal), static_cast<int>(k), me.lod, me.material,
                                    -static_cast<double>(tAgree) / tTotal}); // (sorted out below against the global convention)
                // skin: joints that exist
                if (!g.joints.empty()) {
                    size_t badJ = 0;
                    for (size_t i = 0; i < g.joints.size(); ++i)
                        if (g.weights[i] > 0 && g.joints[i] >= m.nodes.size())
                            ++badJ;
                    if (badJ)
                        bad("skin joints past the node list: " + std::to_string(badJ), 1e6);
                }
            }
            // LODs: each against LOD 0's box
            auto l0 = lodBox.find(0);
            if (l0 != lodBox.end())
                for (const auto &[lod, b] : lodBox) {
                    if (lod == 0)
                        continue;
                    const auto &a = l0->second;
                    const float s0 = std::max({a[3] - a[0], a[4] - a[1], a[5] - a[2]}), s1 = std::max({b[3] - b[0], b[4] - b[1], b[5] - b[2]});
                    float off = 0;
                    for (int c = 0; c < 3; ++c)
                        off = std::max(off, std::abs((a[c] + a[3 + c]) - (b[c] + b[3 + c])) / 2);
                    if (s0 > 0.05f && (s1 < s0 * 0.5f || s1 > s0 * 2.0f || off > s0 * 0.5f))
                        bads.push_back({e.name, "LOD " + std::to_string(lod) + " box size " + std::to_string(s1) + " vs LOD 0 " + std::to_string(s0) + ", centre off " + std::to_string(off),
                                        -1, lod, 0, std::max(s1 / s0, s0 / std::max(1e-6f, s1))});
                }
        }
        const double conv = tanTris ? static_cast<double>(tanAgree) / tanTris : 0.5; // the convention most tangents follow
        std::printf("geoscan: %zu models, %zu meshes, %zu triangles; tangents agree with the UV winding on %.1f%% of %zu triangles\n", models, meshes, tris, 100 * conv, tanTris);
        std::map<std::string, size_t> kinds;
        std::vector<Bad> out;
        for (auto &b : bads) {
            if (b.what.rfind("tangent-agree", 0) == 0) {
                const double agree = -b.score, off = conv > 0.5 ? 1 - agree : agree; // share against the convention
                if (off < 0.5)
                    continue;
                b.what = "tangents against the UVs on " + std::to_string(static_cast<int>(100 * off)) + "% (" + b.what.substr(14) + " agree)";
                b.score = off;
            }
            const std::string kind = b.what.substr(0, b.what.find_first_of(":0123456789("));
            ++kinds[kind];
            out.push_back(b);
        }
        for (const auto &[k, n] : kinds)
            std::printf("  %-45s %zu\n", k.c_str(), n);
        std::sort(out.begin(), out.end(), [](const Bad &a, const Bad &b) { return a.score > b.score; });
        for (const auto &b : out)
            std::printf("BAD %s mesh %d lod %d material %u | %s\n", b.model.c_str(), b.mesh, b.lod, b.material, b.what.c_str());
        return 0;
    }
    if (cmd == "flagscan") { // flagscan [prefix ...]: every material's look flags (shader, blend, alphaTest, glow), to compare two builds
        std::vector<std::string> prefixes(args.begin() + 1, args.end());
        if (prefixes.empty())
            prefixes = {"models/", "assets/"};
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            if (std::none_of(prefixes.begin(), prefixes.end(), [&](const std::string &p) { return e.name.rfind(p, 0) == 0; }))
                continue;
            ModelBundle b;
            if (!loadBundle(gd, e.name, "", b, nullptr))
                continue;
            for (size_t k = 0; k < b.materials.size(); ++k) {
                const MaterialView &mv = b.materials[k];
                if (mv.invisible)
                    continue;
                std::printf("%s#%zu %s blend=%d test=%d glow=%s uv=%d,%.3g\n", e.name.c_str(), k, mv.guid.substr(0, 8).c_str(), mv.blend ? 1 : 0, mv.alphaTest ? 1 : 0,
                            mv.glow.on ? (mv.glow.additive ? "add" : "alpha") : "-", mv.uvSet, mv.uvScale);
            }
        }
        return 0;
    }
    if (cmd == "matscan") { // matscan [prefix ...]: materials (every skin, LOD 0 meshes) the viewer may draw wrong: unhandled shaders, additive layers, no texture
        std::vector<std::string> prefixes(args.begin() + 1, args.end());
        if (prefixes.empty())
            prefixes = {"models/"};
        const std::set<std::string> known = {"fbb75fb5", "ba811382", "0ba5c7a3", "f3007363"}; // standard, scrolling belts, glass, lamp
        struct Row {
            std::string cls, shader, model, skin, detail;
            uint32_t mat = 0;
            size_t tris = 0;
        };
        std::vector<Row> rows;
        std::map<std::string, std::string> texOk; // texture base -> "" (readable) or why not
        size_t models = 0, mats = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            if (std::none_of(prefixes.begin(), prefixes.end(), [&](const std::string &p) { return e.name.rfind(p, 0) == 0; }))
                continue;
            ModelBundle b0;
            if (!loadBundle(gd, e.name, "", b0, nullptr))
                continue;
            ++models;
            std::vector<std::string> skins = {""};
            for (const auto &s : b0.skins)
                if (s.name != "default")
                    skins.push_back(s.name);
            std::set<std::string> seen; // (skin-independent findings once per model)
            for (const auto &skin : skins) {
                ModelBundle sb;
                const ModelBundle *b = &b0;
                if (!skin.empty()) {
                    if (!loadBundle(gd, e.name, skin, sb, nullptr) || sb.skin != skin)
                        continue;
                    b = &sb;
                }
                std::map<uint32_t, size_t> used;
                for (const auto &me : b->model.meshes)
                    if (me.lod == 0)
                        used[me.material] += me.indexCount / 3;
                for (const auto &[k, tris] : used) {
                    if (k >= b->materials.size())
                        continue;
                    const MaterialView &mv = b->materials[k];
                    if (mv.invisible)
                        continue;
                    ++mats;
                    const std::string sh = mv.guid.substr(0, 8);
                    auto add = [&](const std::string &cls, const std::string &detail) {
                        const std::string key = cls + "|" + std::to_string(k) + "|" + detail;
                        if (!seen.insert(key).second)
                            return;
                        rows.push_back({cls, sh, e.name, skin, detail, k, tris});
                    };
                    std::string pins, texs;
                    for (const auto &p : mv.params)
                        if (textureRole(p.name).empty() && p.name != "MaterialLayers")
                            pins += p.name + "=" + p.value + ";";
                    bool anyTex = false, albedo = false;
                    for (const auto &t : mv.textures) {
                        texs += t.param + ":" + t.base.substr(t.base.rfind('/') + 1) + (t.exists ? "" : "(MISSING)") + " ";
                        anyTex = anyTex || t.exists;
                        albedo = albedo || (t.exists && t.role == "albedo");
                    }
                    const bool layered = std::any_of(mv.params.begin(), mv.params.end(), [](const MaterialParam &p) { return p.name == "MaterialLayers"; });
                    const bool additive = std::any_of(mv.params.begin(), mv.params.end(), [](const MaterialParam &p) { return p.name == "AdditiveBlend" && (p.value == "1" || p.value == "true"); });
                    // (glow shaders are drawn from their GlowLook: the lamp shader, 644d00c3, additive layers)
                    if (!known.count(sh) && !mv.glow.on && !layered)
                        add("shader", texs + "| " + pins);
                    if (layered && additive && !mv.glow.on)
                        add("additive-layers", texs + "| " + pins);
                    if (sh != "f3007363" && !albedo)
                        add(anyTex ? "no-albedo" : "untextured", texs + "| " + pins);
                    for (const auto &t : mv.textures)
                        if (!t.exists && !t.base.empty())
                            add("missing-texture", t.param + ":" + t.base);
                    // textures it has but we cannot read (an unknown format, or a level that fails to decode)
                    for (const auto &t : mv.textures) {
                        if (!t.exists)
                            continue;
                        auto it = texOk.find(t.base);
                        if (it == texOk.end()) {
                            std::string why;
                            Texture tx;
                            if (!loadTexture(gd, t.base, tx, &why, false)) {
                            } else if (tx.info.format == PixelFormat::Unknown) {
                                why = "format code " + std::to_string(tx.info.code) + " (kind " + std::to_string(tx.info.kind) + ", depth " + std::to_string(tx.info.depth) + ")";
                            } else {
                                int lv = -1;
                                for (int q = static_cast<int>(tx.info.levels.size()) - 1; q >= 0; --q)
                                    if (!tx.info.levels[q].inTfd && tx.info.levels[q].width >= 4) {
                                        lv = q;
                                        break;
                                    }
                                std::vector<uint8_t> px;
                                uint32_t w = 0, h = 0;
                                if (lv >= 0 && !decodeLevel(tx, lv, px, w, h, &why) && why.empty())
                                    why = "decode failed";
                            }
                            it = texOk.emplace(t.base, why).first;
                        }
                        if (!it->second.empty())
                            add("bad-texture", t.param + ":" + t.base + " (" + it->second + ")");
                    }
                    // a glow map as the main texture of an ordinary material (drawn lit, not glowing?)
                    if (!mv.glow.on)
                        for (const auto &t : mv.textures) {
                            const std::string leaf = t.base.substr(t.base.rfind('/') + 1);
                            auto ends = [&](const char *suf) { const size_t n = std::strlen(suf); return leaf.size() > n && leaf.compare(leaf.size() - n, n, suf) == 0; };
                            if (t.exists && t.role == "albedo" && (ends("_e") || ends("_glow") || ends("_emit") || ends("_emission") || ends("_light_e")))
                                add("glow-albedo", t.param + ":" + leaf + " | " + texs + "| " + pins);
                        }
                    // second texture slots the view does not show (not read as glow, nor a further layer, the colour
                    // map weighing the layers or a detail map it blends): what are they?
                    for (const auto &t : mv.textures)
                        if (t.exists && (t.role == "albedo2" || t.role == "colormap" || t.role == "detail" || t.role == "ao") && !mv.glow.on &&
                            !(t.role == "albedo2" && !mv.layers.empty()) && !(t.role == "colormap" && mv.weights == 2) && !(t.role == "detail" && mv.detailTiling > 0))
                            add("second-slot", t.param + ":" + t.base.substr(t.base.rfind('/') + 1) + " | " + pins);
                }
            }
        }
        std::map<std::string, std::map<std::string, int>> counts;
        for (const auto &r : rows)
            ++counts[r.cls][r.shader];
        std::printf("matscan: %zu models, %zu material uses under", models, mats);
        for (const auto &p : prefixes)
            std::printf(" %s", p.c_str());
        std::printf("\n");
        for (const auto &[cls, by] : counts) {
            std::printf("%s:", cls.c_str());
            for (const auto &[sh, n] : by)
                std::printf(" %s x%d", sh.c_str(), n);
            std::printf("\n");
        }
        for (const auto &r : rows)
            std::printf("ROW %s %s %s%s#%u tris=%zu | %s\n", r.cls.c_str(), r.shader.c_str(), r.model.c_str(), r.skin.empty() ? "" : ("@" + r.skin).c_str(), r.mat, r.tris,
                        r.detail.c_str());
        return 0;
    }
    if (cmd == "lampscan") { // lampscan [prefix] [shader]: lamp-shader (F3007363, or another glow shader) pieces: their textures, pins, UV sets and the texels they hit
        const std::string prefix = args.size() > 1 ? args[1] : "models/";
        const std::string shader = args.size() > 2 ? args[2] : "f3007363";
        struct Img {
            std::vector<uint8_t> rgba;
            uint32_t w = 0, h = 0, fullW = 0, fullH = 0;
            const char *fmt = "-";
        };
        std::map<std::string, Img> imgs;
        auto image = [&](const std::string &base) -> const Img & {
            auto it = imgs.find(base);
            if (it != imgs.end())
                return it->second;
            Img im;
            Texture t;
            if (loadTexture(gd, base, t, nullptr)) {
                im.fullW = t.info.width;
                im.fullH = t.info.height;
                im.fmt = pixelFormatName(t.info.format);
                int lv = t.firstLevel();
                while (lv + 1 < static_cast<int>(t.info.levels.size()) && t.info.levels[lv].width > 256)
                    ++lv;
                if (!decodeLevel(t, lv, im.rgba, im.w, im.h, nullptr))
                    im.rgba.clear();
            }
            return imgs.emplace(base, std::move(im)).first->second;
        };
        auto texel = [](const Img &im, float u, float v) {
            char s[32] = "-";
            if (!im.rgba.empty()) {
                u -= std::floor(u);
                v -= std::floor(v);
                const uint32_t x = std::min(im.w - 1, static_cast<uint32_t>(u * im.w)), y = std::min(im.h - 1, static_cast<uint32_t>(v * im.h));
                const uint8_t *p = &im.rgba[(static_cast<size_t>(y) * im.w + x) * 4];
                std::snprintf(s, sizeof(s), "%02x%02x%02x%02x", p[0], p[1], p[2], p[3]);
            }
            return std::string(s);
        };
        size_t n = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            ModelBundle b;
            if (!loadBundle(gd, e.name, "", b, nullptr))
                continue;
            for (size_t k = 0; k < b.materials.size(); ++k) {
                const MaterialView &mv = b.materials[k];
                if (mv.guid.rfind(shader, 0) != 0)
                    continue;
                std::string diff, cmap, pins;
                for (const auto &t : mv.textures)
                    (t.param == "DiffuseSampler" ? diff : t.param == "ColormapSampler" ? cmap : pins) = t.base;
                pins.clear();
                for (const auto &p : mv.params)
                    if (textureRole(p.name).empty())
                        pins += p.name + "=" + p.value + ";";
                float mn[2][2] = {{1e9f, 1e9f}, {1e9f, 1e9f}}, mx[2][2] = {{-1e9f, -1e9f}, {-1e9f, -1e9f}};
                bool has[2] = {false, false};
                size_t tris = 0;
                std::vector<std::pair<float, float>> pts[2];
                for (const auto &me : b.model.meshes) {
                    if (me.material != k || me.lod != 0)
                        continue;
                    MeshGeometry g;
                    if (!decodeMesh(b.model, me, g, nullptr))
                        continue;
                    tris += g.indices.size() / 3;
                    const std::vector<float> *uv[2] = {&g.uv0, &g.uv1};
                    for (int s = 0; s < 2; ++s) {
                        if (uv[s]->empty())
                            continue;
                        has[s] = true;
                        for (uint32_t v = 0; v < g.vertexCount; ++v) {
                            const float u = (*uv[s])[v * 2], w = (*uv[s])[v * 2 + 1];
                            mn[s][0] = std::min(mn[s][0], u), mn[s][1] = std::min(mn[s][1], w);
                            mx[s][0] = std::max(mx[s][0], u), mx[s][1] = std::max(mx[s][1], w);
                            if (v % std::max<uint32_t>(1, g.vertexCount / 6) == 0 && pts[s].size() < 6)
                                pts[s].emplace_back(u, w);
                        }
                    }
                }
                if (!tris)
                    continue;
                ++n;
                const Img &di = image(diff), &ci = image(cmap);
                std::printf("LAMP %s#%zu tris=%zu D=%s(%ux%u %s) C=%s(%ux%u %s) | %s", e.name.c_str(), k, tris, diff.substr(diff.rfind('/') + 1).c_str(), di.fullW, di.fullH,
                            di.fmt, cmap.substr(cmap.rfind('/') + 1).c_str(), ci.fullW, ci.fullH, ci.fmt, pins.c_str());
                for (int s = 0; s < 2; ++s) {
                    if (!has[s]) {
                        std::printf(" | uv%d none", s);
                        continue;
                    }
                    std::printf(" | uv%d [%.3f %.3f]-[%.3f %.3f] D:", s, mn[s][0], mn[s][1], mx[s][0], mx[s][1]);
                    for (const auto &[u, w] : pts[s])
                        std::printf("%s,", texel(di, u, w).c_str());
                    std::printf(" C:");
                    for (const auto &[u, w] : pts[s])
                        std::printf("%s,", texel(ci, u, w).c_str());
                }
                std::printf("\n");
            }
        }
        std::printf("lampscan: %zu lamp materials with geometry under %s\n", n, prefix.c_str());
        return 0;
    }
    if (cmd == "texsample" && args.size() >= 3) { // texsample <per-format count> <out dir>: DDS + our PNG pairs
        const int per = std::stoi(args[1]);
        const std::filesystem::path dir = P(args[2]);
        std::filesystem::create_directories(dir);
        std::map<std::string, int> taken;
        size_t k = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".tfh") != 0 || (k++ % 7) != 0)
                continue;
            Texture t;
            if (!loadTexture(gd, e.name.substr(0, e.name.size() - 4), t, &err) || t.info.format == PixelFormat::Unknown)
                continue;
            if (t.info.kind != 1 || t.info.depth > 1 || t.firstLevel() != 0 || t.info.width > 2048 || t.info.height > 2048)
                continue;
            std::string fmt = pixelFormatName(t.info.format);
            for (char &c : fmt)
                if (c == ' ')
                    c = '_';
            if (taken[fmt] >= per)
                continue;
            std::vector<uint8_t> dds, rgba;
            uint32_t w, h;
            if (!makeDds(t, dds, &err) || !decodeLevel(t, 0, rgba, w, h, &err))
                continue;
            const std::string stem = fmt + "_" + std::to_string(taken[fmt]++);
            writeFileBytes(dir / (stem + ".dds"), dds.data(), dds.size(), &err);
            writePng(dir / (stem + ".png"), rgba.data(), w, h, &err);
            std::printf("%s %s %ux%u\n", stem.c_str(), t.base.c_str(), w, h);
        }
        return 0;
    }
    if (cmd == "tex" && args.size() >= 3) {
        Texture t;
        if (!loadTexture(gd, args[1], t, &err))
            return fail(err);
        const int lv = args.size() > 3 ? std::stoi(args[3]) : t.firstLevel();
        std::vector<uint8_t> rgba;
        uint32_t w, h;
        if (!decodeLevel(t, lv, rgba, w, h, &err))
            return fail(err);
        if (!writePng(P(args[2]), rgba.data(), w, h, &err))
            return fail(err);
        std::printf("%s: %ux%u %s, %u mips (tfd %s), level %d -> %s\n", t.base.c_str(), t.info.width, t.info.height,
                    pixelFormatName(t.info.format), t.info.mipCount, t.hasTfd ? "yes" : "no", lv, args[2].c_str());
        return 0;
    }
    if (cmd == "dds" && args.size() >= 3) {
        Texture t;
        std::vector<uint8_t> dds;
        if (!loadTexture(gd, args[1], t, &err) || !makeDds(t, dds, &err) || !writeFileBytes(P(args[2]), dds.data(), dds.size(), &err))
            return fail(err);
        std::printf("%s -> %s (%zu bytes, %s)\n", t.base.c_str(), args[2].c_str(), dds.size(), pixelFormatName(t.info.format));
        return 0;
    }
    if (cmd == "hdr" && args.size() >= 3) {
        Texture t;
        if (!loadTextureHeader(gd, args[1], t, &err))
            return fail(err);
        std::vector<float> rgb;
        int w = 0, h = 0;
        if (t.info.cube) {
            CubeMap c;
            if (!loadCubeMap(gd, args[1], 0, c, &err))
                return fail(err);
            w = args.size() > 3 ? std::max(16, std::atoi(args[3].c_str())) : 1024;
            h = w / 2;
            cubePanorama(c, w, rgb);
        } else {
            uint32_t uw = 0, uh = 0;
            if (!loadTextureLevels(gd, t, 0, 0, &err) || !decodeLevelFloat(t, 0, rgb, uw, uh, &err))
                return fail(err);
            w = static_cast<int>(uw);
            h = static_cast<int>(uh);
        }
        const std::vector<uint8_t> file = encodeHdr(rgb.data(), w, h);
        if (!writeFileBytes(P(args[2]), file.data(), file.size(), &err))
            return fail(err);
        std::printf("%s -> %s (%d x %d%s, %s)\n", t.base.c_str(), args[2].c_str(), w, h, t.info.cube ? ", cube map as a panorama" : "", pixelFormatName(t.info.format));
        return 0;
    }
    if (cmd == "export" && args.size() >= 3) {
        ExportOptions opt;
        const std::string out = args[2];
        if (out.size() > 5 && out.substr(out.size() - 5) == ".gltf")
            opt.format = ExportOptions::Format::GLTF;
        else if (out.size() > 4 && out.substr(out.size() - 4) == ".obj")
            opt.format = ExportOptions::Format::OBJ;
        for (size_t i = 3; i < args.size(); ++i) {
            if (args[i] == "--lod" && i + 1 < args.size())
                opt.lod = std::stoi(args[++i]);
            else if (args[i] == "--all-lods")
                opt.lod = -1;
            else if (args[i] == "--skin" && i + 1 < args.size())
                opt.skin = args[++i];
            else if (args[i] == "--dds")
                opt.ddsCopies = true;
            else if (args[i] == "--extra")
                opt.extraMaps = true;
            else if (args[i] == "--no-textures")
                opt.textures = false;
            else if (args[i] == "--anims")
                opt.animations = true;
        }
        std::vector<std::filesystem::path> written;
        std::vector<std::string> warnings;
        if (!exportModel(gd, args[1], P(out), opt, written, warnings, &err,
                         [](double f, const std::string &s) { std::printf("  [%3.0f%%] %s\n", f * 100, s.c_str()); }))
            return fail(err);
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        for (const auto &p : written)
            std::printf("wrote %s (%llu bytes)\n", utf8(p).c_str(), static_cast<unsigned long long>(std::filesystem::file_size(p)));
        return 0;
    }
    if (cmd == "scene" && args.size() >= 3) { // scene <out.glb|.gltf|.obj> <path@x,y,z[,yawDeg[,m]]> ...
        ExportOptions opt;
        const std::string out = args[1];
        if (out.size() > 5 && out.substr(out.size() - 5) == ".gltf")
            opt.format = ExportOptions::Format::GLTF;
        else if (out.size() > 4 && out.substr(out.size() - 4) == ".obj")
            opt.format = ExportOptions::Format::OBJ;
        std::vector<SceneItem> items;
        for (size_t i = 2; i < args.size(); ++i) {
            SceneItem it;
            const size_t at = args[i].find('@');
            it.path = args[i].substr(0, at);
            float x = 0, y = 0, z = 0, yaw = 0;
            char mirror = 0;
            if (at != std::string::npos)
                sscanf_s(args[i].c_str() + at + 1, "%f,%f,%f,%f,%c", &x, &y, &z, &yaw, &mirror, 1u);
            const float c = std::cos(yaw * 3.14159265f / 180), s = std::sin(yaw * 3.14159265f / 180), sx = mirror == 'm' ? -1.0f : 1.0f;
            const float m[16] = {c * sx, 0, -s * sx, 0, 0, 1, 0, 0, s, 0, c, 0, x, y, z, 1}; // R_y(yaw) * S(sx,1,1), column-major
            std::memcpy(it.matrix, m, sizeof(m));
            items.push_back(it);
        }
        std::vector<std::filesystem::path> written;
        std::vector<std::string> warnings;
        if (!exportScene(gd, items, "test build", P(out), opt, written, warnings, &err))
            return fail(err);
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        for (const auto &p : written)
            std::printf("wrote %s (%llu bytes)\n", utf8(p).c_str(), static_cast<unsigned long long>(std::filesystem::file_size(p)));
        return 0;
    }
    if (cmd == "exportall" && args.size() >= 3) { // exportall <count> <out dir> [prefix]: spread across the list
        const int count = std::stoi(args[1]);
        const std::filesystem::path dir = P(args[2]);
        const std::string prefix = args.size() > 3 ? args[3] : "models/";
        std::vector<const Entry *> mdls;
        for (const auto &e : gd.entries())
            if (e.name.size() > 4 && e.name.compare(e.name.size() - 4, 4, ".mdl") == 0 && e.name.rfind(prefix, 0) == 0)
                mdls.push_back(&e);
        const size_t step = std::max<size_t>(1, mdls.size() / std::max(1, count));
        int ok = 0, bad = 0;
        size_t warnCount = 0;
        for (size_t i = 0; i < mdls.size() && ok + bad < count; i += step) {
            ExportOptions opt;
            opt.lod = (i / step) % 3 == 2 ? -1 : 0;
            std::vector<std::filesystem::path> written;
            std::vector<std::string> warnings;
            std::string name = mdls[i]->name.substr(mdls[i]->name.rfind('/') + 1);
            name = std::to_string(ok + bad) + "_" + name.substr(0, name.size() - 4) + ".glb";
            if (exportModel(gd, mdls[i]->name, dir / name, opt, written, warnings, &err)) {
                ++ok;
                warnCount += warnings.size();
            } else {
                ++bad;
                std::printf("error: %s: %s\n", mdls[i]->name.c_str(), err.c_str());
            }
        }
        std::printf("exportall: %d exported, %d failed, %zu warnings (%s)\n", ok, bad, warnCount, utf8(dir).c_str());
        return bad ? 1 : 0;
    }
    if (cmd == "geo" && args.size() >= 3) {
        ModelBundle b;
        std::vector<uint8_t> out;
        const int lod = args.size() > 3 ? std::stoi(args[3]) : 0;
        if (!loadBundle(gd, args[1], "", b, &err) || !packGeometry(b, lod, out, &err) || !writeFileBytes(P(args[2]), out.data(), out.size(), &err))
            return fail(err);
        std::printf("geo %s lod %d: %zu bytes, %zu meshes, %d LODs, %zu materials, %zu skins\n", b.mdlPath.c_str(), lod, out.size(),
                    b.model.meshes.size(), b.model.lodCount, b.materials.size(), b.skins.size());
        return 0;
    }
    if (cmd == "extract" && args.size() >= 3) {
        std::vector<uint8_t> buf;
        if (!gd.read(args[1], buf, &err) || !writeFileBytes(P(args[2]), buf.data(), buf.size(), &err))
            return fail(err);
        std::printf("%s -> %s (%zu bytes)\n", args[1].c_str(), args[2].c_str(), buf.size());
        return 0;
    }
    if (cmd == "skindetail" && args.size() >= 2) { // skindetail <model.mdl>: per skinned mesh and bone number: its vertices' box, and the node each numbering names
        std::vector<uint8_t> bytes;
        Model m;
        if (!gd.read(args[1], bytes, &err) || !parseModel(std::move(bytes), m, &err))
            return fail(err);
        for (size_t mi = 0; mi < m.meshes.size(); ++mi) {
            const MeshInfo &me = m.meshes[mi];
            MeshGeometry g;
            if (me.lod != 0 || !decodeMesh(m, me, g, &err) || g.joints.empty())
                continue;
            std::printf("mesh %zu: words[5..7] %u %u %u, %u vertices\n", mi, me.words[5], me.words[6], me.words[7], g.vertexCount);
            std::map<int, std::array<float, 7>> box; // min xyz, max xyz, count
            for (uint32_t v = 0; v < g.vertexCount; ++v) {
                int best = 0;
                for (int c = 1; c < 4; ++c)
                    if (g.weights[v * 4 + c] > g.weights[v * 4 + best])
                        best = c;
                auto it = box.find(g.joints[v * 4 + best]);
                if (it == box.end())
                    it = box.emplace(g.joints[v * 4 + best], std::array<float, 7>{1e9f, 1e9f, 1e9f, -1e9f, -1e9f, -1e9f, 0}).first;
                for (int k = 0; k < 3; ++k) {
                    it->second[k] = std::min(it->second[k], g.position[v * 3 + k]);
                    it->second[3 + k] = std::max(it->second[3 + k], g.position[v * 3 + k]);
                }
                it->second[6] += 1;
            }
            auto node = [&](size_t n) {
                if (n >= m.nodes.size())
                    return std::string("(none)");
                float w[16];
                toGltfMatrix(m.nodes[n].world, w);
                char t[160];
                std::snprintf(t, sizeof(t), "%zu:%s @(%.2f %.2f %.2f)", n, m.nodes[n].name.c_str(), w[12], w[13], w[14]);
                return std::string(t);
            };
            for (const auto &[j, b] : box)
                std::printf("  bone %2d: %5.0f vertices in (%.2f %.2f %.2f)..(%.2f %.2f %.2f)   as node: %-40s from words[6]: %s\n", j, b[6], b[0], b[1], b[2], b[3], b[4], b[5],
                            node(j).c_str(), node(j + me.words[6]).c_str());
        }
        return 0;
    }
    if (cmd == "skinscan") { // skinscan [prefix] [list]: skinned meshes: are vertex bone numbers node indices, or counted from words[6]?
        // Judged by where each bone's vertices sit: the mean distance of a bone's vertices from the
        // pivot of the node each numbering names (a turret's vertices sit around its pivot, not around
        // another bone's).
        const std::string prefix = args.size() >= 2 ? args[1] : "models/";
        const bool list = args.size() >= 3 && args[2] == "list";
        size_t models = 0, skinned = 0, zeroOffset = 0, shiftWins = 0, directWins = 0, tie = 0, outOfRange = 0;
        std::map<std::string, size_t> wordsSeen;
        for (const auto &e : gd.entries()) {
            if (e.name.compare(0, prefix.size(), prefix) != 0 || e.name.size() < 4 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            std::vector<uint8_t> bytes;
            Model m;
            std::string err2;
            if (!gd.read(e, bytes, &err2) || !parseModel(std::move(bytes), m, &err2))
                continue;
            ++models;
            std::vector<std::array<float, 3>> pivot(m.nodes.size());
            for (size_t i = 0; i < m.nodes.size(); ++i) {
                float w[16];
                toGltfMatrix(m.nodes[i].world, w);
                pivot[i] = {w[12], w[13], w[14]};
            }
            bool shown = false;
            for (const MeshInfo &me : m.meshes) {
                MeshGeometry g;
                if (!decodeMesh(m, me, g, &err2) || g.joints.size() < static_cast<size_t>(g.vertexCount) * 4 || g.weights.size() < g.joints.size())
                    continue;
                ++skinned;
                char key[64];
                std::snprintf(key, sizeof(key), "%u %u %u %u %u", me.words[3], me.words[4], me.words[5], me.words[6], me.words[7]);
                ++wordsSeen[key];
                const uint32_t off = me.words[6];
                std::map<int, std::array<double, 4>> sum; // by bone number: position sum, count
                for (uint32_t v = 0; v < g.vertexCount; ++v) {
                    int best = 0;
                    for (int c = 1; c < 4; ++c)
                        if (g.weights[v * 4 + c] > g.weights[v * 4 + best])
                            best = c;
                    auto &s = sum[g.joints[v * 4 + best]];
                    for (int k = 0; k < 3; ++k)
                        s[k] += g.position[v * 3 + k];
                    s[3] += 1;
                }
                double dDirect = 0, dShift = 0;
                bool range = true;
                for (const auto &[j, s] : sum) {
                    const double c[3] = {s[0] / s[3], s[1] / s[3], s[2] / s[3]};
                    auto dist = [&](size_t n) { return std::sqrt((c[0] - pivot[n][0]) * (c[0] - pivot[n][0]) + (c[1] - pivot[n][1]) * (c[1] - pivot[n][1]) + (c[2] - pivot[n][2]) * (c[2] - pivot[n][2])) * s[3]; };
                    if (static_cast<size_t>(j) >= m.nodes.size() || static_cast<size_t>(j) + off >= m.nodes.size()) {
                        range = false;
                        continue;
                    }
                    dDirect += dist(j);
                    dShift += dist(j + off);
                }
                if (!range)
                    ++outOfRange;
                if (off == 0)
                    ++zeroOffset;
                else if (dShift < dDirect * 0.8)
                    ++shiftWins;
                else if (dDirect < dShift * 0.8)
                    ++directWins;
                else
                    ++tie;
                if (list && off != 0 && !shown && (args.size() < 4 || (args[3] == "direct" && dDirect < dShift * 0.8) || (args[3] == "tie" && !(dShift < dDirect * 0.8) && !(dDirect < dShift * 0.8)))) {
                    std::printf("%s  words %s  bones used %zu  mean distance: as node %.2f m, from words[6] %.2f m%s\n", e.name.c_str(), key, sum.size(),
                                dDirect / g.vertexCount, dShift / g.vertexCount, range ? "" : "  (a number past the nodes)");
                    shown = true;
                }
            }
        }
        std::printf("%zu models, %zu skinned meshes: words[6] = 0 in %zu; with an offset the offset numbering fits better in %zu, the node numbering in %zu, "
                    "undecided %zu; %zu meshes number a bone past the nodes one way or the other\n",
                    models, skinned, zeroOffset, shiftWins, directWins, tie, outOfRange);
        std::vector<std::pair<size_t, std::string>> top;
        for (const auto &[k, n] : wordsSeen)
            top.push_back({n, k});
        std::sort(top.rbegin(), top.rend());
        for (size_t i = 0; i < top.size() && i < 12; ++i)
            std::printf("  words[3..7] %-20s %zu meshes\n", top[i].second.c_str(), top[i].first);
        return 0;
    }
    if (cmd == "meshes" && args.size() >= 2) { // meshes <model.mdl>: every mesh's LOD, material, sizes and raw words
        std::vector<uint8_t> bytes;
        Model m;
        if (!gd.read(args[1], bytes, &err) || !parseModel(std::move(bytes), m, &err))
            return fail(err);
        std::printf("%s: v%u, %zu meshes, %d LODs (lodStart %u %u %u %u), %zu nodes, other blocks", args[1].c_str(), m.version, m.meshes.size(), m.lodCount,
                    m.lodStart[0], m.lodStart[1], m.lodStart[2], m.lodStart[3], m.nodes.size());
        for (uint32_t b : m.otherBlocks)
            std::printf(" %u", b);
        std::printf("\n");
        for (size_t i = 0; i < m.meshes.size(); ++i) {
            const MeshInfo &me = m.meshes[i];
            std::printf("  mesh %2zu lod %d material %d verts %6u idx %7u flags %08x stride %2u words", i, me.lod, static_cast<int>(me.material), me.vertexCount,
                        me.indexCount, me.flags, me.stride);
            for (const auto &el : me.elements)
                std::printf(" [%s @%u]", describeElement(el).c_str(), el.offset);
            for (uint32_t wd : me.words)
                std::printf(" %u", wd);
            std::printf("\n");
        }
        return 0;
    }
    if (cmd == "shaderscan" && args.size() >= 2) { // shaderscan <prefix>: material shaders under prefix, their parameters and albedo alpha
        struct Info {
            int mats = 0, alphaAlbedo = 0;
            std::map<std::string, int> params;
            std::string example;
        };
        std::map<std::string, Info> shaders;
        const std::string prefix = normalizeGamePath(args[1]);
        for (const auto &e : gd.entries()) {
            if (e.name.rfind(prefix, 0) != 0 || e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".mdf") != 0)
                continue;
            std::vector<uint8_t> bytes;
            std::vector<Material> mats;
            if (!gd.read(e, bytes, nullptr) || !parseMdf(std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()), mats, nullptr))
                continue;
            for (const auto &m : mats) {
                std::string g = m.guid;
                for (char &c : g)
                    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                Info &in = shaders[g.substr(0, 8)];
                ++in.mats;
                if (in.example.empty())
                    in.example = e.name;
                std::set<std::string> seen;
                for (const auto &p : m.params)
                    if (seen.insert(p.name).second)
                        ++in.params[p.name];
                const std::string alb = m.value("DiffuseSampler");
                if (!alb.empty()) {
                    std::string base = alb[0] == '*' ? e.name.substr(0, e.name.rfind('/') + 1) + alb.substr(1) : alb;
                    Texture t;
                    if (loadTexture(gd, normalizeGamePath(base), t, nullptr, false)) {
                        const PixelFormat f = baseFormat(t.info.format);
                        in.alphaAlbedo += f == PixelFormat::BC2 || f == PixelFormat::BC3 || f == PixelFormat::BC7 || f == PixelFormat::RGBA8;
                    }
                }
            }
        }
        for (const auto &[g, in] : shaders) {
            std::printf("%s  %5d materials, %5d with an alpha albedo  (e.g. %s)\n   ", g.c_str(), in.mats, in.alphaAlbedo, in.example.c_str());
            std::vector<std::pair<int, std::string>> ps;
            for (const auto &[p, c] : in.params)
                ps.emplace_back(c, p);
            std::sort(ps.rbegin(), ps.rend());
            for (size_t i = 0; i < ps.size() && i < 14; ++i)
                std::printf(" %s:%d", ps[i].second.c_str(), ps[i].first);
            std::printf("\n");
        }
        return 0;
    }
    if (cmd == "pinscan" && args.size() >= 3) { // pinscan <prefix> <shader guid prefix>: pin combinations x albedo alpha, with examples
        std::map<std::string, std::pair<int, std::string>> combos;
        const std::string prefix = normalizeGamePath(args[1]), shader = args[2];
        for (const auto &e : gd.entries()) {
            if (e.name.rfind(prefix, 0) != 0 || e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".mdf") != 0)
                continue;
            std::vector<uint8_t> bytes;
            std::vector<Material> mats;
            if (!gd.read(e, bytes, nullptr) || !parseMdf(std::string_view(reinterpret_cast<const char *>(bytes.data()), bytes.size()), mats, nullptr))
                continue;
            for (const auto &m : mats) {
                std::string g = m.guid;
                for (char &c : g)
                    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                if (g.rfind(shader, 0) != 0)
                    continue;
                std::string key;
                for (const auto &p : m.params)
                    if (p.name.rfind("User", 0) == 0 && p.name.find("Param") == std::string::npos)
                        key += p.name + "=" + p.value + " ";
                const std::string alb = m.value("DiffuseSampler");
                std::string fmt = "none";
                if (!alb.empty()) {
                    std::string base = alb[0] == '*' ? e.name.substr(0, e.name.rfind('/') + 1) + alb.substr(1) : alb;
                    Texture t;
                    if (loadTexture(gd, normalizeGamePath(base), t, nullptr, false))
                        fmt = pixelFormatName(t.info.format);
                }
                key += "| " + fmt;
                auto &c = combos[key];
                ++c.first;
                if (c.second.empty())
                    c.second = e.name + " " + alb;
            }
        }
        std::vector<std::pair<int, std::string>> list;
        for (const auto &[k, c] : combos)
            list.emplace_back(c.first, k + "   e.g. " + c.second);
        std::sort(list.rbegin(), list.rend());
        for (size_t i = 0; i < list.size() && i < 40; ++i)
            std::printf("%5d  %s\n", list[i].first, list[i].second.c_str());
        return 0;
    }
    if (cmd == "v9scan") { // v9scan [max]: version-9 model headers (the part after the v8 fields) with mesh vertex counts
        const size_t max = args.size() > 1 ? std::stoul(args[1]) : 30;
        size_t shown = 0;
        std::map<std::string, int> shapes;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            std::vector<uint8_t> b;
            if (!gd.read(e, b, nullptr) || b.size() < 32 || *reinterpret_cast<const uint32_t *>(b.data() + 16) != 9)
                continue;
            const uint32_t blocks = *reinterpret_cast<const uint32_t *>(b.data() + 20);
            const uint64_t dir = *reinterpret_cast<const uint64_t *>(b.data() + 24);
            std::string verts, hdr;
            int meshes = 0;
            for (uint32_t i = 0; i < blocks && dir + i * 16 + 16 <= b.size(); ++i) {
                const uint8_t *d = b.data() + dir + i * 16;
                const uint32_t type = *reinterpret_cast<const uint32_t *>(d), size = *reinterpret_cast<const uint32_t *>(d + 4);
                const uint64_t off = *reinterpret_cast<const uint64_t *>(d + 8);
                if (off + size > b.size())
                    break;
                if (type == 0) {
                    ++meshes;
                    verts += std::to_string(*reinterpret_cast<const uint32_t *>(b.data() + off + 68)) + "/m" + std::to_string(*reinterpret_cast<const uint32_t *>(b.data() + off + 64)) + " ";
                } else if (type == 13) {
                    char buf[16];
                    for (uint32_t k = 56; k + 2 <= size && k < 96; k += 2) {
                        std::snprintf(buf, sizeof(buf), "%u ", *reinterpret_cast<const uint16_t *>(b.data() + off + k));
                        hdr += buf;
                    }
                    hdr += "| size " + std::to_string(size);
                }
            }
            ++shapes["header " + hdr.substr(hdr.find('|'))];
            if (shown++ < max)
                std::printf("%-70s meshes %d: %s\n    u16 from 56: %s\n", e.name.c_str(), meshes, verts.c_str(), hdr.c_str());
        }
        for (const auto &[s, c] : shapes)
            std::printf("%6d %s\n", c, s.c_str());
        return 0;
    }
    if (cmd == "grassinfo" && args.size() >= 2) { // grassinfo <map>: grass.dat types, counts, and checks against the terrain
        MapGrass g;
        if (!loadGrass(gd, args[1], g, &err))
            return fail(err);
        MapScene s;
        MapFilter f;
        f.props = f.entities = f.trees = f.water = f.decals = false;
        if (!loadMap(gd, args[1], f, s, &err))
            return fail(err);
        std::printf("grid %d x %d cells of %.1f m from (%.0f, %.0f), %zu blocks, %zu instances\n", g.gridX, g.gridZ, g.cellSize, g.x0, g.z0, g.cells.size(), g.items.size());
        std::vector<size_t> perType(g.types.size());
        size_t outside = 0;
        for (const auto &c : g.cells) {
            perType[c.type] += c.count;
            const float cx0 = g.x0 + (c.cell % g.gridX) * g.cellSize, cz0 = g.z0 + (c.cell / g.gridX) * g.cellSize;
            for (uint32_t i = c.first; i < c.first + c.count; ++i) {
                const auto &it = g.items[i];
                if (it.pos[0] < cx0 - 0.01f || it.pos[0] > cx0 + g.cellSize + 0.01f || it.pos[2] < cz0 - 0.01f || it.pos[2] > cz0 + g.cellSize + 0.01f)
                    ++outside;
            }
        }
        for (size_t t = 0; t < g.types.size(); ++t)
            std::printf("  type %zu: %u %s -> %s (dist %.2f, align %d, wind %.1f, lum %.1f) x%zu\n", t, g.types[t].preset, g.types[t].name.c_str(),
                        g.types[t].model.c_str(), g.types[t].distFactor, g.types[t].alignToNormal ? 1 : 0, g.types[t].wind, g.types[t].luminance, perType[t]);
        std::printf("  outside their cell: %zu\n", outside);
        if (s.hasTerrain) {
            // up vector of the rotation vs the terrain normal (q and its conjugate), height above the ground
            const Terrain &t = s.terrain;
            size_t n = 0, okQ = 0, okConj = 0, onGround = 0;
            double sumQ = 0, sumC = 0;
            for (const auto &c : g.cells) {
                if (!g.types[c.type].alignToNormal)
                    continue;
                for (uint32_t i = c.first; i < c.first + c.count; i += 7) {
                    const auto &it = g.items[i];
                    const float hgt = t.heightAt(it.pos[0], it.pos[2]);
                    if (std::abs(it.pos[1] - hgt) > 0.3f)
                        continue;
                    ++onGround;
                    const float e = t.cellSize;
                    const float dx = (t.heightAt(it.pos[0] + e, it.pos[2]) - t.heightAt(it.pos[0] - e, it.pos[2])) / (2 * e);
                    const float dz = (t.heightAt(it.pos[0], it.pos[2] + e) - t.heightAt(it.pos[0], it.pos[2] - e)) / (2 * e);
                    const float l = std::sqrt(dx * dx + 1 + dz * dz), N[3] = {-dx / l, 1 / l, -dz / l};
                    const float x = it.rot[0], y = it.rot[1], z = it.rot[2], w = it.rot[3];
                    const float up[3] = {2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)};
                    const float upC[3] = {2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)};
                    const float a = std::acos(std::clamp(up[0] * N[0] + up[1] * N[1] + up[2] * N[2], -1.0f, 1.0f)) * 57.2958f;
                    const float ac = std::acos(std::clamp(upC[0] * N[0] + upC[1] * N[1] + upC[2] * N[2], -1.0f, 1.0f)) * 57.2958f;
                    sumQ += a;
                    sumC += ac;
                    okQ += a < 4;
                    okConj += ac < 4;
                    ++n;
                }
            }
            std::printf("  on the ground (within 0.3 m): %zu of the sampled; tilt vs terrain normal: q mean %.2f deg (%zu within 4), conj mean %.2f deg (%zu within 4) of %zu\n",
                        onGround, n ? sumQ / n : 0, okQ, n ? sumC / n : 0, okConj, n);
        }
        double smin = 1e9, smax = 0;
        for (const auto &it : g.items) {
            smin = std::min<double>(smin, it.scale);
            smax = std::max<double>(smax, it.scale);
        }
        std::printf("  scale %.3f .. %.3f\n", smin, smax);
        return 0;
    }
    if (cmd == "envinfo" && args.size() >= 2) { // envinfo <map> [festival]: the environment the map uses, its atmosphere
        MapScene s;
        MapFilter f;
        f.props = f.entities = f.trees = f.water = f.decals = false;
        if (args.size() > 2)
            f.festival = args[2];
        if (!loadMap(gd, args[1], f, s, &err))
            return fail(err);
        MapEnvironment env;
        if (!loadEnvironment(gd, args[1], s.environment, env, &err))
            return fail(err);
        std::printf("environment %s %s, rot %.1f %.1f %.1f\n", env.id.c_str(), env.name.c_str(), env.rotation[0], env.rotation[1], env.rotation[2]);
        for (const char *k : {"SunColor", "SunIlluminance", "SunDirVert", "SunDirHor", "UseAtmosphereSunIllum", "AtmosphereSunIllum", "FogColor", "FogDensity",
                              "FogNear", "FogExpMul", "FogHeight", "ExposureCompensation", "MinEV100", "MaxEV100", "SkyDomeModelPath", "AtmosphereId"})
            std::printf("  %-22s %s\n", k, env.value(k).c_str());
        if (env.value("SceneEnvironment") == "true") // (Crossout 2.41: from the scene's entities)
            for (const char *k : {"BackdropPath", "BackdropLuminance", "BackdropUvShift", "BackdropGround", "BackdropMotion", "DustEnabled", "DustByHeight", "SkyAtmosphere", "SkyAtmosphereSun", "SunDiscVisible", "SunDiscDiameter", "HeightFog0", "HeightFog1",
                                  "HeightFogStart", "HeightFogInscatter", "HeightFogSunScatter", "EmissiveLumScale", "WhiteTemperature", "WhiteTint", "TonemapToe",
                                  "ColorRemapPath", "WindYaw", "WindForce", "AreaEffect", "DustEnabled", "DustEnabledOnLand", "DustColor", "DustTransparency"})
                std::printf("  %-22s %s\n", k, env.value(k).c_str());
        Atmosphere a;
        if (!env.value("AtmosphereId").empty()) {
            if (!loadAtmosphere(gd, env.value("AtmosphereId"), a, &err))
                return fail(err);
            std::printf("atmosphere %s:", a.dir.c_str());
            for (const auto &[k, v] : a.uniforms)
                std::printf(" %s=%s", k.c_str(), v.c_str());
            std::printf("\n  tables %zu + %zu + %zu bytes\n", a.transmittance.size(), a.irradiance.size(), a.scattering.size());
        }
        return 0;
    }
    if (cmd == "envkeys" && args.size() >= 2) { // envkeys <key,key...> [map ...]: those values of every map's environments, and how often each comes
        std::vector<std::string> keys;
        for (size_t p = 0; p <= args[1].size();) {
            size_t q = args[1].find(',', p);
            if (q == std::string::npos)
                q = args[1].size();
            if (q > p)
                keys.push_back(args[1].substr(p, q - p));
            p = q + 1;
        }
        std::vector<std::string> names(args.begin() + 2, args.end());
        if (names.empty())
            names = listMaps(gd);
        std::map<std::string, std::map<std::string, int>> counts;
        for (const auto &n : names) {
            MapScene s;
            MapFilter f;
            f.props = f.entities = f.trees = f.water = f.decals = false;
            if (!loadMap(gd, n, f, s, &err))
                continue;
            for (const auto &c : s.environments) {
                MapEnvironment env;
                std::string e;
                if (!loadEnvironment(gd, n, c.id, env, &e)) {
                    std::printf("%-30s %-8s FAIL %s\n", n.c_str(), c.id.c_str(), e.c_str());
                    continue;
                }
                std::printf("%-30s %-8s %-40s", n.c_str(), c.id.c_str(), c.name.c_str());
                for (const auto &k : keys) {
                    const std::string v = env.value(k);
                    std::printf("  %s=%s", k.c_str(), v.c_str());
                    counts[k][v]++;
                }
                std::printf("\n");
            }
        }
        for (const auto &[k, m] : counts) {
            std::printf("%s:\n", k.c_str());
            for (const auto &[v, c] : m)
                std::printf("  %4d  %s\n", c, v.c_str());
        }
        return 0;
    }
    if (cmd == "envscan") { // envscan [map ...]: every map's environments (the Maps view's Weather menu): id, name, festivals, mode fit, the default pick
        std::vector<std::string> names(args.begin() + 1, args.end());
        if (names.empty())
            names = listMaps(gd);
        std::map<std::string, int> byName;
        for (const auto &n : names) {
            MapScene s;
            MapFilter f;
            f.props = f.entities = f.trees = f.water = f.decals = false;
            if (!loadMap(gd, n, f, s, &err)) {
                std::printf("%-36s FAIL %s\n", n.c_str(), err.c_str());
                continue;
            }
            std::printf("%s (%s, default %s)\n", n.c_str(), s.gameplay.c_str(), s.environment.c_str());
            for (const auto &c : s.environments) {
                std::string fests;
                for (const auto &x : c.festivals)
                    fests += (fests.empty() ? "" : ";") + x;
                std::printf("  %-8s %-48s %-28s%s\n", c.id.c_str(), c.name.c_str(), fests.c_str(), c.modeOk ? "" : "  (other modes)");
                byName[c.name]++;
            }
        }
        std::printf("names: %zu\n", byName.size());
        std::map<std::string, int> fx;
        size_t effects = 0, areas = 0, stops = 0, own = 0;
        for (const auto &n : names) { // (the effects each map plays where they stand, and its weather boxes)
            MapScene s;
            if (!loadMap(gd, n, MapFilter{}, s, &err))
                continue;
            effects += s.effects.size();
            for (const auto &e : s.effects)
                fx[e.effect]++;
            for (const auto &a : s.areas) {
                ++areas;
                stops += a.stopsWeather;
                own += !a.effect.empty();
                if (!a.effect.empty() || !a.screen.empty())
                    std::printf("  area on %s: effect '%s' screen '%s' stops %d, %.1f x %.1f x %.1f m\n", n.c_str(), a.effect.c_str(), a.screen.c_str(), a.stopsWeather ? 1 : 0,
                                a.size[0], a.size[1], a.size[2]);
            }
        }
        std::printf("effects placed: %zu (%zu kinds), weather boxes: %zu (%zu stop the weather, %zu with their own effect)\n", effects, fx.size(), areas, stops, own);
        std::vector<std::pair<int, std::string>> top;
        for (const auto &[k, c] : fx)
            top.emplace_back(c, k);
        std::sort(top.rbegin(), top.rend());
        for (size_t i = 0; i < top.size() && i < 60; ++i)
            std::printf("  %5d  %s\n", top[i].first, top[i].second.c_str());
        for (const auto &[k, v] : byName)
            std::printf("  %4d  %s\n", v, k.c_str());
        return 0;
    }
    if (cmd == "sky" && args.size() >= 3) { // sky <map> <out.hdr|.png> [width] [--no-clouds] [--computed] [--festival f] [--env id]: the sky an export writes (.png: graded like the view)
        MapScene s;
        MapFilter f;
        f.props = f.entities = f.trees = f.water = f.decals = false;
        int width = 2048;
        bool clouds = true, probeSky = true;
        for (size_t i = 3; i < args.size(); ++i) {
            if (args[i] == "--no-clouds")
                clouds = false;
            else if (args[i] == "--computed")
                probeSky = false;
            else if (args[i] == "--festival" && i + 1 < args.size())
                f.festival = args[++i];
            else if (args[i] == "--env" && i + 1 < args.size())
                f.environment = args[++i];
            else
                width = std::stoi(args[i]);
        }
        if (!loadMap(gd, args[1], f, s, &err))
            return fail(err);
        MapEnvironment env;
        if (!loadEnvironment(gd, args[1], s.environment, env, &err))
            return fail(err);
        SkyLight light;
        std::vector<float> rgb;
        std::vector<std::string> warnings;
        const auto t0s = std::chrono::steady_clock::now();
        if (!renderSky(gd, env, width, clouds, light, rgb, warnings, &err, probeSky))
            return fail(err);
        const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0s).count();
        const int W = std::clamp(width, 64, 16384), H = W / 2;
        std::printf("environment %s %s: sky %dx%d in %.2f s\n", env.id.c_str(), env.name.c_str(), W, H, secs);
        std::printf("  sun towards %.3f %.3f %.3f, colour %.3f %.3f %.3f, intensity %.3f\n", light.sun[0], light.sun[1], light.sun[2], light.color[0], light.color[1],
                    light.color[2], light.intensity);
        std::printf("  horizon %.3f %.3f %.3f, haze %.6f / m, %.0f m; EV100 %.2f, exposure %.4f\n", light.horizon[0], light.horizon[1], light.horizon[2], light.fogDensity,
                    light.fogHeight, light.ev100, light.exposure);
        double up[3]{}, down[3]{}, mx = 0;
        for (int y = 0; y < H; ++y)
            for (int x = 0; x < W; ++x)
                for (int c = 0; c < 3; ++c) {
                    const float v = rgb[(static_cast<size_t>(y) * W + x) * 3 + c];
                    (y < H / 2 ? up : down)[c] += v / (static_cast<double>(W) * H / 2);
                    mx = std::max(mx, static_cast<double>(v));
                }
        std::printf("  mean above the horizon %.3f %.3f %.3f, below %.3f %.3f %.3f, max %.3f\n", up[0], up[1], up[2], down[0], down[1], down[2], mx);
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        const std::string out = args[2];
        if (out.size() > 4 && out.substr(out.size() - 4) == ".png") { // graded as the view shows it (it is at the exposure already)
            std::vector<uint8_t> px;
            if (!gradeLikeView(gd, env, 1, rgb, px, &err))
                return fail(err);
            if (!writePng(P(out), px.data(), W, H, &err))
                return fail(err);
        } else {
            const std::vector<uint8_t> hdr = encodeHdr(rgb.data(), W, H);
            if (!writeFileBytes(P(out), hdr.data(), hdr.size(), &err))
                return fail(err);
            std::vector<float> back;
            int bw = 0, bh = 0;
            if (!decodeHdr(hdr, back, bw, bh, &err))
                return fail("read back: " + err);
            double worst = 0;
            for (size_t i = 0; i < back.size() && bw == W && bh == H; ++i) {
                const double a = rgb[i], b = back[i], m = std::max({std::abs(rgb[(i / 3) * 3]), std::abs(rgb[(i / 3) * 3 + 1]), std::abs(rgb[(i / 3) * 3 + 2])});
                if (m > 1e-6)
                    worst = std::max(worst, std::abs(a - b) / m);
            }
            std::printf("  wrote %zu bytes (%.1f%% of raw RGBE); read back %dx%d, worst error %.4f of the pixel's brightest channel\n", hdr.size(),
                        100.0 * hdr.size() / (static_cast<double>(W) * H * 4), bw, bh, worst);
            if (bw != W || bh != H || worst > 0.01)
                return fail("the .hdr does not read back as written");
        }
        return 0;
    }
    if (cmd == "probe" && args.size() >= 4) { // probe <map> <envId> <out.png|.hdr> [width] [--diffuse|--fog] [--level n] [--local]: a light probe as a panorama (.png: graded like the view)
        MapProbes mp;
        if (!loadLightProbes(gd, args[1], args[2], mp, &err))
            return fail(err);
        int width = 0, level = 0;
        std::string which = "specular";
        bool local = false;
        for (size_t i = 4; i < args.size(); ++i) {
            if (args[i] == "--diffuse" || args[i] == "--fog")
                which = args[i].substr(2);
            else if (args[i] == "--level" && i + 1 < args.size())
                level = std::stoi(args[++i]);
            else if (args[i] == "--local")
                local = true;
            else
                width = std::stoi(args[i]);
        }
        for (const auto &p : mp.probes)
            std::printf("  %s probe %s: centre %.2f %.2f %.2f (glTF z %.2f), box %.1f %.1f %.1f .. %.1f %.1f %.1f, turned %.1f, EnvColor %.3f %.3f %.3f\n    %s\n    %s\n",
                        p.global ? "global" : "local", p.id.c_str(), p.center[0], p.center[1], p.center[2], -p.center[2], p.halfMin[0], p.halfMin[1], p.halfMin[2], p.halfMax[0],
                        p.halfMax[1], p.halfMax[2], p.rotation[0], p.envColor[0], p.envColor[1], p.envColor[2], p.specular.c_str(), p.diffuse.c_str());
        if (local && mp.probes.size() < 2)
            return fail("this environment has no local probe");
        const LightProbe &lp = mp.probes[local ? 1 : 0];
        const std::string base = which == "fog" ? mp.inscattering : which == "diffuse" ? lp.diffuse : lp.specular;
        CubeMap cube;
        if (!loadCubeMap(gd, base, level, cube, &err))
            return fail(err);
        const int W = width > 0 ? width : cube.size * 4, H = W / 2;
        std::vector<float> rgb;
        cubePanorama(cube, W, rgb);
        double up[3]{}, down[3]{}, mx = 0;
        for (int y = 0; y < H; ++y) // (cos-weighted: every row's share of the sphere)
            for (int x = 0; x < W; ++x)
                for (int c = 0; c < 3; ++c) {
                    const double v = rgb[(static_cast<size_t>(y) * W + x) * 3 + c], w = std::cos(((y + 0.5) / H - 0.5) * 3.14159265358979) * 3.14159265358979 / 2 / (W * H / 2.0);
                    (y < H / 2 ? up : down)[c] += v * w;
                    mx = std::max(mx, v);
                }
        std::printf("%s level %d: %d px faces -> %dx%d; luminance mean %.4f, geometric mean %.4f; mean above the horizon %.3f %.3f %.3f, below %.3f %.3f %.3f, max %.1f\n",
                    base.c_str(), level, cube.size, W, H, cubeLuminance(cube, false), cubeLuminance(cube, true), up[0], up[1], up[2], down[0], down[1], down[2], mx);
        const std::string out = args[3];
        if (out.size() > 4 && out.substr(out.size() - 4) == ".png") {
            MapEnvironment env;
            SkyLight light;
            std::vector<float> none;
            std::vector<std::string> warnings;
            if (!loadEnvironment(gd, args[1], args[2], env, &err) || !renderSky(gd, env, 0, false, light, none, warnings, &err))
                return fail(err);
            std::printf("  graded like the view: EV100 %.2f, exposure %.4f\n", light.ev100, light.exposure);
            std::vector<uint8_t> px;
            if (!gradeLikeView(gd, env, light.exposure, rgb, px, &err))
                return fail(err);
            if (!writePng(P(out), px.data(), W, H, &err))
                return fail(err);
        } else {
            const std::vector<uint8_t> hdr = encodeHdr(rgb.data(), W, H);
            if (!writeFileBytes(P(out), hdr.data(), hdr.size(), &err))
                return fail(err);
        }
        return 0;
    }
    if (cmd == "probescan") { // probescan [map ...]: every environment's light probes: the auto exposure they give against the preset's EV100 range
        std::vector<std::string> names(args.begin() + 1, args.end());
        if (names.empty())
            names = listMaps(gd);
        size_t envs = 0, none = 0, inside = 0, below = 0, above = 0, local = 0;
        for (const auto &n : names) {
            MapScene s;
            MapFilter f;
            f.props = f.entities = f.trees = f.water = f.decals = false;
            if (!loadMap(gd, n, f, s, &err))
                continue;
            for (const auto &c : s.environments) {
                ++envs;
                MapProbes mp;
                MapEnvironment env;
                CubeMap cube;
                std::string why;
                if (!loadLightProbes(gd, n, c.id, mp, &why) || !loadEnvironment(gd, n, c.id, env, &why) || !loadCubeMap(gd, mp.probes[0].specular, 0, cube, &why)) {
                    ++none;
                    std::printf("%-28s %-8s none: %s\n", n.c_str(), c.id.c_str(), why.c_str());
                    continue;
                }
                local += mp.probes.size() > 1;
                const double mean = cubeLuminance(cube, false), geo = cubeLuminance(cube, true);
                const double lo = std::strtod(env.value("MinEV100").c_str(), nullptr), hi = std::strtod(env.value("MaxEV100").c_str(), nullptr);
                const double ev = std::log2(std::max(mean, 1e-6) * kProbeUnit * 8), evGeo = std::log2(std::max(geo, 1e-6) * kProbeUnit * 8);
                inside += ev >= lo && ev <= hi;
                below += ev < lo;
                above += ev > hi;
                std::printf("%-28s %-8s %-44s mean %8.4f geo %8.4f  EV %5.2f (geo %5.2f) in %4.1f..%4.1f  comp %s%s\n", n.c_str(), c.id.c_str(), env.name.c_str(), mean, geo, ev, evGeo,
                            lo, hi, env.value("ExposureCompensation").c_str(), mp.probes.size() > 1 ? "  +local" : "");
            }
        }
        std::printf("probescan: %zu environments, %zu without probes, %zu with a local probe; the mean's EV100 inside the range %zu, below %zu, above %zu\n", envs, none, local,
                    inside, below, above);
        return 0;
    }
    if (cmd == "decalinfo" && args.size() >= 2) { // decalinfo <map>: decals, their presets, the meshes they make
        MapScene s;
        if (!loadMap(gd, args[1], MapFilter{}, s, &err))
            return fail(err);
        const auto presets = readDecalPresets(gd);
        std::vector<DecalMesh> meshes;
        std::vector<std::string> warnings;
        const auto t1 = std::chrono::steady_clock::now();
        const bool uncapped = std::find(args.begin(), args.end(), "--uncapped") != args.end();
        buildDecalMeshes(gd, s, presets, 0, meshes, warnings, uncapped ? SIZE_MAX : kDecalTriangles);
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t1).count();
        // (--ranks: the triangles of each kind decalRank leaves out in turn, as built and without the limit)
        if (std::find(args.begin(), args.end(), "--ranks") != args.end()) {
            auto ranks = [&](const std::vector<DecalMesh> &ms2) {
                std::array<size_t, 4> t{};
                for (const auto &m : ms2) {
                    auto p = presets.find(s.decals[m.decal].preset);
                    t[decalRank(p == presets.end() ? nullptr : &p->second, m)] += m.indices.size() / 3;
                }
                return t;
            };
            std::vector<DecalMesh> all;
            std::vector<std::string> w2;
            buildDecalMeshes(gd, s, presets, 0, all, w2, SIZE_MAX);
            const auto a = ranks(all), c = ranks(meshes);
            std::printf("ranks uncapped %zu %zu %zu %zu capped %zu %zu %zu %zu\n", a[0], a[1], a[2], a[3], c[0], c[1], c[2], c[3]);
        }
        size_t tris = 0, onStatic = 0, onLand = 0, pieces = 0;
        for (const auto &m : meshes) {
            tris += m.indices.size() / 3;
            pieces += m.object >= 0;
        }
        for (const auto &d : s.decals) {
            onStatic += d.onStatic;
            onLand += d.onLandscape;
        }
        std::printf("%zu decals (%zu on the ground, %zu on objects), %zu presets known; %zu meshes (%zu of them on an object), %zu triangles in %.0f ms\n", s.decals.size(),
                    onLand, onStatic, presets.size(), meshes.size(), pieces, tris, ms);
        // (--top: the vertices and bytes /mapdecals sends, and the meshes and presets with the most triangles)
        if (std::find(args.begin(), args.end(), "--top") != args.end()) {
            size_t verts = 0;
            for (const auto &m : meshes)
                verts += m.position.size() / 3;
            std::printf("%zu vertices: %.0f MB as /mapdecals sends them (36 bytes a vertex, 12 a triangle)\n", verts, (verts * 36.0 + tris * 12.0) / 1048576);
            std::vector<size_t> order(meshes.size());
            for (size_t i = 0; i < order.size(); ++i)
                order[i] = i;
            std::sort(order.begin(), order.end(), [&](size_t a, size_t b) { return meshes[a].indices.size() > meshes[b].indices.size(); });
            for (size_t k = 0; k < std::min<size_t>(15, order.size()); ++k) {
                const auto &m = meshes[order[k]];
                const auto &d = s.decals[m.decal];
                std::printf("  %8zu tris  decal %d '%s' preset %u scale %.1f %.1f %.1f on %s\n", m.indices.size() / 3, m.decal, d.name.c_str(), d.preset, d.scale[0], d.scale[1], d.scale[2],
                            m.object < 0 ? "the terrain" : s.objects[m.object].model.c_str());
            }
            std::map<uint32_t, std::pair<size_t, size_t>> byPreset; // preset -> decals' meshes, triangles
            for (const auto &m : meshes) {
                auto &e = byPreset[s.decals[m.decal].preset];
                e.first++;
                e.second += m.indices.size() / 3;
            }
            std::vector<std::pair<uint32_t, std::pair<size_t, size_t>>> bp(byPreset.begin(), byPreset.end());
            std::sort(bp.begin(), bp.end(), [](const auto &a, const auto &b) { return a.second.second > b.second.second; });
            for (size_t k = 0; k < std::min<size_t>(10, bp.size()); ++k) {
                auto p = presets.find(bp[k].first);
                std::printf("  preset %u (%s): %zu meshes, %zu tris\n", bp[k].first, p == presets.end() ? "?" : (p->second.albedo.empty() ? p->second.normal : p->second.albedo).c_str(), bp[k].second.first, bp[k].second.second);
            }
            size_t land = 0, onObj = 0;
            for (const auto &m : meshes)
                (m.object < 0 ? land : onObj) += m.indices.size() / 3;
            std::printf("  on the terrain %zu tris, on objects %zu tris\n", land, onObj);
        }
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        return 0;
    }
    if (cmd == "files") { // files <substring> ...: archive file names containing every substring (case-insensitive), with sizes
        size_t shown = 0;
        for (const auto &e : gd.entries()) {
            std::string low = e.name;
            for (char &c : low)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            bool all = true;
            for (size_t i = 1; i < args.size() && all; ++i) {
                std::string a = args[i];
                for (char &c : a)
                    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
                all = low.find(a) != std::string::npos;
            }
            if (all) {
                std::printf("%10llu %s\n", static_cast<unsigned long long>(e.size), e.name.c_str());
                ++shown;
            }
        }
        std::printf("%zu file(s)\n", shown);
        return 0;
    }
    if (cmd == "lodscan") { // lodscan <prefix> [n]: LOD switch values next to the model's size (what the values mean)
        const std::string prefix = args.size() > 1 ? args[1] : "assets/props/";
        const size_t max = args.size() > 2 ? std::stoul(args[2]) : 40;
        size_t shown = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0 || e.name.rfind(prefix, 0) != 0)
                continue;
            std::vector<uint8_t> bytes;
            Model m;
            if (!gd.read(e, bytes, nullptr) || !parseModel(std::move(bytes), m, nullptr) || m.lodCount < 2)
                continue;
            const float dx = m.bbMax[0] - m.bbMin[0], dy = m.bbMax[1] - m.bbMin[1], dz = m.bbMax[2] - m.bbMin[2];
            std::printf("%-64s v%u lods %d  r %.2f  dist", e.name.c_str(), m.version, m.lodCount, 0.5 * std::sqrt(dx * dx + dy * dy + dz * dz));
            for (float d : m.lodDistance)
                std::printf(" %.3f", d);
            for (float d : m.lodSwitch)
                std::printf(" | %.3f", d);
            std::printf("\n");
            if (++shown >= max)
                break;
        }
        return 0;
    }
    if (cmd == "treescan") { // treescan: meshes without a material index (SpeedTree trees): layouts, shaders, the marker byte
        std::map<std::string, int> layouts;
        std::map<std::string, std::string> example;
        size_t models = 0;
        for (const auto &e : gd.entries()) {
            if (e.name.size() < 5 || e.name.compare(e.name.size() - 4, 4, ".mdl") != 0)
                continue;
            std::vector<uint8_t> bytes;
            Model m;
            if (!gd.read(e, bytes, nullptr) || !parseModel(std::move(bytes), m, nullptr))
                continue;
            bool any = false;
            for (const auto &me : m.meshes) {
                if (me.material != 0xFFFFFFFFu)
                    continue;
                any = true;
                std::string key = "stride " + std::to_string(me.stride) + " pos " + std::to_string(me.positionBytes) + " lod " + std::to_string(me.lod);
                for (const auto &el : me.elements)
                    key += " [" + describeElement(el) + " @" + std::to_string(el.offset) + "]";
                if (me.stride == 24) { // the marker byte 23: which values occur
                    std::set<int> v;
                    for (uint32_t k = 0; k < me.vertexCount && v.size() < 6; ++k)
                        v.insert(m.data[me.vertexOffset + static_cast<size_t>(k) * me.stride + 23]);
                    key += " b23:";
                    for (int x : v)
                        key += " " + std::to_string(x);
                }
                ++layouts[key];
                example.emplace(key, e.name);
            }
            models += any;
        }
        for (const auto &[k, c] : layouts)
            std::printf("%6d  %s  (e.g. %s)\n", c, k.c_str(), example[k].c_str());
        std::printf("treescan: %zu models with meshes that have no material index\n", models);
        return 0;
    }
    if (cmd == "vdump" && args.size() >= 3) { // vdump <model.mdl> <mesh> [count]: raw vertex bytes + position (for new layouts)
        std::vector<uint8_t> bytes;
        Model m;
        if (!gd.read(args[1], bytes, &err) || !parseModel(std::move(bytes), m, &err))
            return fail(err);
        const size_t mi = std::stoul(args[2]);
        if (mi >= m.meshes.size())
            return fail("no such mesh");
        const MeshInfo &me = m.meshes[mi];
        MeshGeometry g;
        if (!decodeMesh(m, me, g, &err))
            return fail(err);
        const size_t count = std::min<size_t>(me.vertexCount, args.size() > 3 ? std::stoul(args[3]) : 12);
        std::printf("stride %u, position bytes %u\n", me.stride, me.positionBytes);
        for (size_t v = 0; v < count; ++v) {
            const uint8_t *p = m.data.data() + me.vertexOffset + v * me.stride;
            std::printf("%4zu pos %8.3f %8.3f %8.3f |", v, g.position[v * 3], g.position[v * 3 + 1], -g.position[v * 3 + 2]);
            for (uint32_t k = 0; k < me.stride; ++k)
                std::printf("%s%02x", k % 4 ? "" : " ", p[k]);
            if (!g.uv0.empty())
                std::printf(" | uv %.3f %.3f", g.uv0[v * 2], g.uv0[v * 2 + 1]);
            std::printf("\n");
        }
        const uint16_t *ix = reinterpret_cast<const uint16_t *>(m.data.data() + me.indexOffset);
        std::printf("first indices:");
        for (size_t i = 0; i < std::min<size_t>(me.indexCount, 24); ++i)
            std::printf(" %u", ix[i]);
        std::printf("\n");
        return 0;
    }
    if (cmd == "maps") { // maps: every map with its terrain size and object counts
        const auto names = listMaps(gd);
        size_t unresolvedTotal = 0, objectsTotal = 0;
        for (const auto &n : names) {
            MapScene s;
            if (!loadMap(gd, n, MapFilter{}, s, &err)) {
                std::printf("%-36s FAIL %s\n", n.c_str(), err.c_str());
                continue;
            }
            size_t props = 0, trees = 0, ents = 0, unresolved = 0;
            for (const auto &o : s.objects)
                (o.group == "props" ? props : o.group == "trees" ? trees : ents)++;
            for (const auto &[d, c] : s.unresolved)
                unresolved += c;
            unresolvedTotal += unresolved;
            objectsTotal += s.objects.size();
            std::printf("%-36s %s %5.0f x %5.0f m  props %6zu  trees %6zu  objects %6zu  water %2zu  unresolved %5zu  filtered %5d  env %s%s\n", n.c_str(),
                        s.hasTerrain ? "terrain" : "  -    ", s.terrain.sizeX(), s.terrain.sizeZ(), props, trees, ents, s.water.size(), unresolved,
                        s.filteredOut, s.environment.c_str(), s.warnings.empty() ? "" : ("  [" + s.warnings.front() + "]").c_str());
        }
        std::printf("maps: %zu, objects placed %zu, entities without a model %zu\n", names.size(), objectsTotal, unresolvedTotal);
        return 0;
    }
    if (cmd == "mapinfo" && args.size() >= 2) { // mapinfo <map> [--models] [--gameplay m] [--festival f]: unresolved definitions, surfaces, models used
        MapScene s;
        MapFilter filter;
        for (size_t i = 2; i + 1 < args.size(); ++i) {
            if (args[i] == "--gameplay")
                filter.gameplay = args[++i];
            else if (args[i] == "--festival")
                filter.festival = args[++i];
        }
        if (!loadMap(gd, args[1], filter, s, &err))
            return fail(err);
        const Terrain &t = s.terrain;
        std::printf("%s: terrain %s, %d x %d cells of %.2f m, heights %.2f .. %.2f, surface map %d x %d\n", s.name.c_str(), s.hasTerrain ? "yes" : "no",
                    t.cellsX, t.cellsZ, t.cellSize, t.minY, t.maxY, t.texelsX(), t.texelsZ());
        for (size_t i = 0; i < t.surfaces.size(); ++i)
            std::printf("  surface %zu: %u %s (%s, tiling %.1f)\n", i, t.surfaces[i].presetId, t.surfaces[i].name.c_str(), t.surfaces[i].albedo.c_str(), t.surfaces[i].tiling);
        std::map<std::string, int> models;
        for (const auto &o : s.objects)
            ++models[o.group + " " + o.model];
        std::printf("objects %zu (%zu models), water %zu, filtered out %d, environment %s, mode %s\n", s.objects.size(), models.size(), s.water.size(), s.filteredOut,
                    s.environment.c_str(), s.gameplay.c_str());
        // each water: where it lies, and how much of the ground inside its outline is under it (a
        // basin the right way round has nearly all of it)
        for (const auto &w : s.water) {
            float x0 = 1e30f, x1 = -1e30f, z0 = 1e30f, z1 = -1e30f;
            for (const auto &p : w.outline) {
                x0 = std::min(x0, p[0]), x1 = std::max(x1, p[0]);
                z0 = std::min(z0, p[1]), z1 = std::max(z1, p[1]);
            }
            int in = 0, under = 0;
            for (int j = 0; j < 32 && s.hasTerrain; ++j)
                for (int i = 0; i < 32; ++i) {
                    const float x = x0 + (x1 - x0) * (i + 0.5f) / 32, z = z0 + (z1 - z0) * (j + 0.5f) / 32;
                    bool inside = false;
                    for (size_t a = 0, b = w.outline.size() - 1; a < w.outline.size(); b = a++) {
                        const auto &p = w.outline[a], &q = w.outline[b];
                        if ((p[1] > z) != (q[1] > z) && x < (q[0] - p[0]) * (z - p[1]) / (q[1] - p[1]) + p[0])
                            inside = !inside;
                    }
                    if (inside && x >= t.x0() && x <= -t.x0() && z >= t.z0() && z <= -t.z0())
                        ++in, under += t.heightAt(x, z) < w.level;
                }
            std::printf("  %s %-24s type %d  level %.2f  x %.0f .. %.0f  z %.0f .. %.0f  colour %d %d %d  density %.2f  ground under it %d/%d  %s\n",
                        w.acid ? "acid " : "water", w.name.c_str(), w.type, w.level, x0, x1, z0, z1, w.color[0], w.color[1], w.color[2], w.density, under, in,
                        w.frames.c_str());
        }
        for (const auto &[label, set] : {std::pair{"modes", &s.gameplays}, std::pair{"festivals", &s.festivals}}) {
            std::printf("  %s:", label);
            for (const auto &x : *set)
                std::printf(" %s", x.c_str());
            std::printf("\n");
        }
        std::vector<std::pair<int, std::string>> un;
        for (const auto &[d, c] : s.unresolved)
            un.emplace_back(c, d);
        std::sort(un.rbegin(), un.rend());
        for (const auto &[c, d] : un)
            std::printf("  unresolved %5d %s\n", c, d.c_str());
        if (args.size() > 2 && args[2] == "--models")
            for (const auto &[m, c] : models)
                std::printf("  %5d %s\n", c, m.c_str());
        std::map<std::string, int> sounds;
        for (const auto &x : s.sounds)
            ++sounds[x.event + (x.line.empty() ? "" : " (along " + std::to_string(x.line.size()) + " points)")];
        std::printf("soundscape %s, %zu sounds\n", s.soundscape.empty() ? "-" : s.soundscape.c_str(), s.sounds.size());
        for (const auto &[e, c] : sounds)
            std::printf("  sound %3d %s\n", c, e.c_str());
        for (const auto &w : s.warnings)
            std::printf("warning: %s\n", w.c_str());
        return 0;
    }
    if (cmd == "map" && args.size() >= 3) { // map <name> <out.glb|.gltf|.obj> [options]: terrain + props + objects + water
        ExportOptions opt;
        MapExportOptions mo;
        MapFilter filter;
        opt.slots = false;
        opt.maxTextureSize = 1024;
        const std::string out = args[2];
        if (out.size() > 5 && out.substr(out.size() - 5) == ".gltf")
            opt.format = ExportOptions::Format::GLTF;
        else if (out.size() > 4 && out.substr(out.size() - 4) == ".obj")
            opt.format = ExportOptions::Format::OBJ;
        for (size_t i = 3; i < args.size(); ++i) {
            const bool more = i + 1 < args.size();
            if (args[i] == "--lod" && more)
                opt.lod = std::stoi(args[++i]);
            else if (args[i] == "--tree-lod" && more)
                mo.treeLod = std::stoi(args[++i]);
            else if (args[i] == "--ground" && more)
                mo.groundTexture = std::stoi(args[++i]);
            else if (args[i] == "--step" && more)
                mo.terrainStep = std::stoi(args[++i]);
            else if (args[i] == "--max-tex" && more)
                opt.maxTextureSize = std::stoi(args[++i]);
            else if (args[i] == "--gameplay" && more)
                filter.gameplay = args[++i];
            else if (args[i] == "--festival" && more)
                filter.festival = args[++i];
            else if (args[i] == "--env" && more)
                filter.environment = args[++i];
            else if (args[i] == "--no-textures")
                opt.textures = false;
            else if (args[i] == "--no-props")
                filter.props = false;
            else if (args[i] == "--no-objects")
                filter.entities = false;
            else if (args[i] == "--no-trees")
                filter.trees = false;
            else if (args[i] == "--no-water")
                filter.water = false;
            else if (args[i] == "--no-decals")
                mo.decals = false;
            else if (args[i] == "--grass" && more)
                mo.grass = std::stof(args[++i]);
            else if (args[i] == "--no-sun")
                mo.sun = false;
            else if (args[i] == "--sky" && more)
                mo.sky = std::stoi(args[++i]);
            else if (args[i] == "--no-sky")
                mo.sky = 0;
            else if (args[i] == "--no-clouds")
                mo.clouds = false;
            else if (args[i] == "--computed-sky")
                mo.probeSky = false;
        }
        MapScene s;
        if (!loadMap(gd, args[1], filter, s, &err))
            return fail(err);
        std::vector<std::filesystem::path> written;
        std::vector<std::string> warnings = s.warnings;
        int last = -1;
        if (!exportMap(gd, s, P(out), opt, mo, written, warnings, &err, [&](double f, const std::string &st) {
                const int pct = static_cast<int>(f * 100);
                if (pct / 5 != last / 5) {
                    last = pct;
                    std::printf("  [%3d%%] %s\n", pct, st.c_str());
                }
            }))
            return fail(err);
        size_t unresolved = 0;
        for (const auto &[d, c] : s.unresolved)
            unresolved += c;
        std::printf("map %s: %zu objects, %zu water, %d filtered out, %zu entities without a model (%zu definitions)\n", s.name.c_str(), s.objects.size(),
                    s.water.size(), s.filteredOut, unresolved, s.unresolved.size());
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        for (const auto &p : written)
            std::printf("wrote %s (%llu bytes)\n", utf8(p).c_str(), static_cast<unsigned long long>(std::filesystem::file_size(p)));
        return 0;
    }
    if (cmd == "ground" && args.size() >= 3) { // ground <map> <out.png> [size]: the baked ground colour alone
        MapScene s;
        MapFilter f;
        f.props = f.entities = f.trees = f.water = false;
        if (!loadMap(gd, args[1], f, s, &err))
            return fail(err);
        ImageRGBA img;
        std::vector<std::string> warnings;
        const auto t0g = std::chrono::steady_clock::now();
        if (!bakeGround(gd, s.terrain, args.size() > 3 ? std::stoi(args[3]) : 2048, img, warnings, &err) || !writePng(P(args[2]), img.rgba.data(), img.w, img.h, &err))
            return fail(err);
        for (const auto &w : warnings)
            std::printf("warning: %s\n", w.c_str());
        std::printf("ground %s: %ux%u in %.2f s -> %s\n", args[1].c_str(), img.w, img.h,
                    std::chrono::duration<double>(std::chrono::steady_clock::now() - t0g).count(), args[2].c_str());
        return 0;
    }
    if (cmd == "extractall" && args.size() >= 3) { // extractall <prefix> <out dir> [suffix ...]: keeps the game paths under out dir
        const std::string prefix = normalizeGamePath(args[1]);
        size_t n = 0, bytes = 0;
        std::vector<uint8_t> buf;
        for (const auto &e : gd.entries()) {
            if (e.name.compare(0, prefix.size(), prefix) != 0)
                continue;
            bool want = args.size() == 3;
            for (size_t i = 3; i < args.size() && !want; ++i)
                want = e.name.size() >= args[i].size() && e.name.compare(e.name.size() - args[i].size(), args[i].size(), args[i]) == 0;
            if (!want)
                continue;
            const std::filesystem::path out = P(args[2]) / P(e.name);
            std::error_code ec;
            std::filesystem::create_directories(out.parent_path(), ec);
            if (!gd.read(e.name, buf, &err) || !writeFileBytes(out, buf.data(), buf.size(), &err))
                return fail(err);
            ++n;
            bytes += buf.size();
        }
        std::printf("extractall %s: %zu files, %.1f MB -> %s\n", prefix.c_str(), n, bytes / 1048576.0, args[2].c_str());
        return 0;
    }
    return fail("unknown command or missing arguments");
}
