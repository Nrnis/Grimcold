#include "xo/Anim.h"

#include "xo/Archive.h"

#include <cstring>

namespace xo {
namespace {

template <typename T> T rd(const std::vector<uint8_t> &b, size_t p) {
    T v;
    std::memcpy(&v, b.data() + p, sizeof(T));
    return v;
}

bool fail(std::string *err, const std::string &m) {
    if (err)
        *err = m;
    return false;
}

} // namespace

// timesInHeaderOrder: key times follow the track headers' order (true) or the data's
// format-grouped order (false). Exposed for xotest, which checks both against every file.
bool parseAnimEx(const std::vector<uint8_t> &b, Animation &out, std::string *err, bool timesInHeaderOrder) {
    out = Animation{};
    if (b.size() < 32 || std::memcmp(b.data(), "TCF ANIM", 8) != 0)
        return fail(err, "not a TCF ANIM file");
    const uint32_t blocks = rd<uint32_t>(b, 0x14);
    const uint64_t dir = rd<uint64_t>(b, 0x18);
    if (blocks == 0 || blocks > 64 || dir > b.size() || static_cast<uint64_t>(blocks) * 16 > b.size() - dir)
        return fail(err, "bad block directory");
    for (uint32_t i = 0; i < blocks; ++i) {
        const size_t d = static_cast<size_t>(dir) + static_cast<size_t>(i) * 16;
        const uint32_t type = rd<uint32_t>(b, d), size = rd<uint32_t>(b, d + 4);
        const uint64_t off = rd<uint64_t>(b, d + 8);
        if (off > b.size() || size > b.size() - off)
            return fail(err, "block outside the file");
        if (type != 2)
            continue;
        const size_t o = static_cast<size_t>(off), end = o + size;
        if (size < 0x50)
            return fail(err, "short animation block");
        out.unknown0 = rd<float>(b, o);
        out.duration = rd<float>(b, o + 4);
        const uint32_t n = rd<uint32_t>(b, o + 8);
        if (n > 4096 || 0x50 + static_cast<size_t>(n) * 48 > size)
            return fail(err, "bad track count");
        out.tracks.resize(n);
        size_t keysTotal = 0;
        for (uint32_t t = 0; t < n; ++t) {
            const size_t h = o + 0x50 + static_cast<size_t>(t) * 48;
            AnimTrack &tr = out.tracks[t];
            const char *nm = reinterpret_cast<const char *>(b.data() + h);
            tr.node.assign(nm, strnlen(nm, 32));
            tr.bone = rd<uint32_t>(b, h + 32);
            const uint32_t keys = rd<uint32_t>(b, h + 36);
            tr.format = rd<uint32_t>(b, h + 40);
            if (tr.format > 2 || keys > 100000)
                return fail(err, "track " + tr.node + ": unknown format " + std::to_string(tr.format));
            // every key takes at least 18 bytes (16 of data, 2 of time): check before allocating
            keysTotal += keys;
            if (keysTotal * 18 > size)
                return fail(err, "track " + tr.node + ": more keys than the block holds");
            tr.times.resize(keys);
        }
        // key data, grouped by format
        size_t p = o + 0x50 + static_cast<size_t>(n) * 48;
        std::vector<uint32_t> dataOrder;
        for (uint32_t f = 0; f <= 2; ++f)
            for (uint32_t t = 0; t < n; ++t)
                if (out.tracks[t].format == f)
                    dataOrder.push_back(t);
        for (uint32_t t : dataOrder) {
            AnimTrack &tr = out.tracks[t];
            const size_t keys = tr.times.size();
            const size_t per = tr.format == 0 ? 32 : 16;
            if (p + keys * per > end)
                return fail(err, "track " + tr.node + ": key data runs past the block");
            if (tr.format != 2)
                tr.translation.resize(keys * 3);
            if (tr.format != 1)
                tr.rotation.resize(keys * 4);
            for (size_t k = 0; k < keys; ++k) {
                const size_t q = p + k * per;
                if (tr.format != 2) { // translation (x, y, z, 0); glTF: mirror Z
                    tr.translation[k * 3] = rd<float>(b, q);
                    tr.translation[k * 3 + 1] = rd<float>(b, q + 4);
                    tr.translation[k * 3 + 2] = -rd<float>(b, q + 8);
                }
                if (tr.format != 1) { // rotation quaternion; mirroring Z negates x and y
                    const size_t r = q + (tr.format == 0 ? 16 : 0);
                    tr.rotation[k * 4] = -rd<float>(b, r);
                    tr.rotation[k * 4 + 1] = -rd<float>(b, r + 4);
                    tr.rotation[k * 4 + 2] = rd<float>(b, r + 8);
                    tr.rotation[k * 4 + 3] = rd<float>(b, r + 12);
                }
            }
            p += keys * per;
        }
        // key times, u16 fractions of the duration
        if (p + keysTotal * 2 > end)
            return fail(err, "key times run past the block");
        std::vector<uint32_t> timeOrder = dataOrder;
        if (timesInHeaderOrder)
            for (uint32_t t = 0; t < n; ++t)
                timeOrder[t] = t;
        for (uint32_t t : timeOrder) {
            AnimTrack &tr = out.tracks[t];
            for (size_t k = 0; k < tr.times.size(); ++k, p += 2)
                tr.times[k] = rd<uint16_t>(b, p) / 32767.0f * out.duration;
        }
        return true;
    }
    return fail(err, "no animation block");
}

bool parseAnim(const std::vector<uint8_t> &bytes, Animation &out, std::string *err) {
    return parseAnimEx(bytes, out, err, false);
}

ModelDesc parseModelDesc(std::string_view text, std::string_view dir) {
    // tokens: words, quoted strings and braces; "//" comments to the end of the line
    std::vector<std::string> tok;
    for (size_t i = 0; i < text.size();) {
        const char c = text[i];
        if (c == '/' && i + 1 < text.size() && text[i + 1] == '/') {
            while (i < text.size() && text[i] != '\n')
                ++i;
        } else if (c == '{' || c == '}') {
            tok.emplace_back(1, c);
            ++i;
        } else if (c == '"') {
            const size_t e = text.find('"', i + 1);
            tok.emplace_back(text.substr(i + 1, (e == std::string_view::npos ? text.size() : e) - i - 1));
            i = e == std::string_view::npos ? text.size() : e + 1;
        } else if (static_cast<unsigned char>(c) <= ' ') {
            ++i;
        } else {
            size_t e = i;
            while (e < text.size() && static_cast<unsigned char>(text[e]) > ' ' && text[e] != '{' && text[e] != '}')
                ++e;
            tok.emplace_back(text.substr(i, e - i));
            i = e;
        }
    }
    ModelDesc d;
    auto lower = [](std::string s) {
        for (char &ch : s)
            if (ch >= 'A' && ch <= 'Z')
                ch = static_cast<char>(ch - 'A' + 'a');
        return s;
    };
    auto num = [](const std::string &s) { return static_cast<float>(std::atof(s.c_str())); };
    for (size_t i = 0; i < tok.size(); ++i) {
        const std::string k = lower(tok[i]);
        if (k == "mesh" && i + 1 < tok.size()) {
            d.mesh = tok[++i];
        } else if (k == "skin" && i + 2 < tok.size() && lower(tok[i + 1]) == "default") {
            d.skin = tok[i + 2];
            i += 2;
        } else if ((k == "anim" || k == "jigglebone") && i + 2 < tok.size() && tok[i + 2] == "{") {
            const bool anim = k == "anim";
            AnimLayer l;
            l.name = tok[i + 1];
            size_t j = i + 3;
            int depth = 1;
            for (; j < tok.size() && depth > 0; ++j) {
                if (tok[j] == "{") {
                    ++depth;
                    continue;
                }
                if (tok[j] == "}") {
                    --depth;
                    continue;
                }
                if (!anim || depth != 1)
                    continue;
                const std::string key = lower(tok[j]);
                auto resolve = [&](const std::string &name) {
                    std::string f = normalizeGamePath(name);
                    if (f.size() < 5 || f.compare(f.size() - 5, 5, ".anim") != 0)
                        f += ".anim";
                    return f.find('/') == std::string::npos ? std::string(dir) + "/" + f : f;
                };
                if (key == "files" && j + 1 < tok.size() && tok[j + 1] == "{") {
                    for (j += 2; j < tok.size() && tok[j] != "}"; ++j)
                        l.files.push_back(resolve(tok[j]));
                    continue; // j sits on the closing brace, which belongs to this list
                }
                if (key == "file" && j + 1 < tok.size()) {
                    std::string f = normalizeGamePath(tok[++j]);
                    if (f.size() < 5 || f.compare(f.size() - 5, 5, ".anim") != 0)
                        f += ".anim";
                    l.file = f.find('/') == std::string::npos ? std::string(dir) + "/" + f : f;
                } else if (key == "activity" && j + 1 < tok.size()) {
                    l.activity = tok[++j];
                } else if (key == "poseparameter" && j + 3 < tok.size()) {
                    l.poseParameter = tok[j + 1];
                    l.poseMin = num(tok[j + 2]);
                    l.poseMax = num(tok[j + 3]);
                    j += 3;
                } else if (key == "speed" && j + 1 < tok.size()) {
                    l.speed = num(tok[++j]);
                } else if (key == "addlayer" && j + 1 < tok.size()) {
                    l.addLayers.push_back(tok[++j]);
                }
            }
            if (anim)
                d.layers.push_back(std::move(l));
            i = j - 1;
        }
    }
    return d;
}

} // namespace xo
