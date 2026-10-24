#include "xo/Texture.h"

#include "xo/Archive.h"
#include "xo/Parallel.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <list>
#include <mutex>
#include <unordered_map>

namespace xo {

const char *pixelFormatName(PixelFormat f) {
    switch (f) {
    case PixelFormat::RGBA8: return "RGBA8";
    case PixelFormat::RGBA8_SRGB: return "RGBA8 sRGB";
    case PixelFormat::BC1: return "BC1";
    case PixelFormat::BC1_SRGB: return "BC1 sRGB";
    case PixelFormat::BC2: return "BC2";
    case PixelFormat::BC2_SRGB: return "BC2 sRGB";
    case PixelFormat::BC3: return "BC3";
    case PixelFormat::BC3_SRGB: return "BC3 sRGB";
    case PixelFormat::BC4: return "BC4";
    case PixelFormat::BC5: return "BC5";
    case PixelFormat::BC7: return "BC7";
    case PixelFormat::BC7_SRGB: return "BC7 sRGB";
    case PixelFormat::BC6H: return "BC6H";
    case PixelFormat::R11G11B10F: return "R11G11B10F";
    default: return "unknown";
    }
}

bool isSrgb(PixelFormat f) {
    return f == PixelFormat::RGBA8_SRGB || f == PixelFormat::BC1_SRGB || f == PixelFormat::BC2_SRGB ||
           f == PixelFormat::BC3_SRGB || f == PixelFormat::BC7_SRGB;
}

PixelFormat baseFormat(PixelFormat f) {
    switch (f) {
    case PixelFormat::RGBA8_SRGB: return PixelFormat::RGBA8;
    case PixelFormat::BC1_SRGB: return PixelFormat::BC1;
    case PixelFormat::BC2_SRGB: return PixelFormat::BC2;
    case PixelFormat::BC3_SRGB: return PixelFormat::BC3;
    case PixelFormat::BC7_SRGB: return PixelFormat::BC7;
    default: return f;
    }
}

int blockBytes(PixelFormat f) {
    switch (baseFormat(f)) {
    case PixelFormat::BC1:
    case PixelFormat::BC4: return 8;
    case PixelFormat::BC2:
    case PixelFormat::BC3:
    case PixelFormat::BC5:
    case PixelFormat::BC7:
    case PixelFormat::BC6H: return 16;
    case PixelFormat::RGBA8:
    case PixelFormat::R11G11B10F: return 4;
    default: return 0;
    }
}

static PixelFormat formatFromCode(uint32_t code) {
    switch (code >> 3) {
    case 5: return PixelFormat::RGBA8;
    case 6: return PixelFormat::RGBA8_SRGB;
    case 7: return PixelFormat::BC1;
    case 9: return PixelFormat::BC2;
    case 10: return PixelFormat::BC3;
    case 11: return PixelFormat::BC1_SRGB;
    case 13: return PixelFormat::BC2_SRGB;
    case 14: return PixelFormat::BC3_SRGB;
    case 20: return PixelFormat::BC4;
    case 22: return PixelFormat::R11G11B10F;
    case 25: return PixelFormat::BC7;
    case 26: return PixelFormat::BC7_SRGB;
    case 27: return PixelFormat::BC5;
    case 30: return PixelFormat::BC6H;
    default: return PixelFormat::Unknown;
    }
}

bool parseTfh(const std::vector<uint8_t> &h, TextureInfo &info, std::string *err) {
    info = TextureInfo{};
    if (h.size() < 8) {
        if (err)
            *err = "texture header too short";
        return false;
    }
    uint32_t a, b;
    std::memcpy(&a, h.data(), 4);
    std::memcpy(&b, h.data() + 4, 4);
    info.kind = a & 15;
    info.width = (a >> 4) & 0x3FFF;
    info.height = a >> 18;
    info.depth = b & 15;
    info.mipCount = (b >> 11) & 15;
    info.code = (b >> 16) & 0xFF;
    info.format = formatFromCode(info.code);
    if (!info.width || !info.height || !info.mipCount || 8 + info.mipCount * 16 > h.size()) {
        if (err)
            *err = "unsupported texture header";
        return false;
    }
    auto word = [&](uint32_t at) {
        uint32_t v;
        std::memcpy(&v, h.data() + at, 4);
        return v;
    };
    // Layers: the first entry's data comes right after the table (which then holds mipCount x
    // layers entries), and every layer of a mip has that mip's size.
    const uint32_t row = info.mipCount * 16, first = word(8);
    if (first > 8 + row && (first - 8) % row == 0 && first <= h.size()) {
        const uint32_t n = (first - 8) / row;
        bool same = true;
        for (uint32_t m = 0; m < info.mipCount && same; ++m)
            for (uint32_t l = 1; l < n && same; ++l)
                same = word(12 + (m * n + l) * 16) == word(12 + m * n * 16);
        if (same)
            info.layers = n;
    }
    info.cube = info.layers == 6 && (b >> 24) == 2;
    const uint32_t count = info.mipCount * info.layers, hdr = 8 + count * 16;
    std::vector<MipLevel> all(count); // as stored: smallest mip first
    bool inTfd = false;
    uint32_t prev = 0;
    for (uint32_t i = 0; i < count; ++i) {
        MipLevel &m = all[i];
        m.offset = word(8 + i * 16);
        m.size = word(12 + i * 16);
        m.pitch = word(16 + i * 16);
        if (!inTfd && (m.offset < hdr || (i && m.offset < prev)))
            inTfd = true;
        m.inTfd = inTfd;
        info.needsTfd = info.needsTfd || inTfd;
        prev = m.offset;
        const uint32_t lv = info.mipCount - 1 - i / info.layers;
        m.width = std::max(1u, info.width >> lv);
        m.height = std::max(1u, info.height >> lv);
    }
    for (uint32_t lv = 0; lv < info.mipCount; ++lv)
        info.levels.push_back(all[(info.mipCount - 1 - lv) * info.layers]);
    if (info.layers > 1)
        for (uint32_t lv = 0; lv < info.mipCount; ++lv)
            for (uint32_t l = 0; l < info.layers; ++l)
                info.layerLevels.push_back(all[(info.mipCount - 1 - lv) * info.layers + l]);
    return true;
}

namespace {
// Where a level's bytes are in what was loaded, or null.
const uint8_t *levelBytes(const Texture &t, const MipLevel &m) {
    if (!m.inTfd)
        return static_cast<size_t>(m.offset) + m.size <= t.tfh.size() ? t.tfh.data() + m.offset : nullptr;
    if (!t.hasTfd || m.offset < t.tfdOffset || m.offset - t.tfdOffset + m.size > t.tfd.size())
        return nullptr;
    return t.tfd.data() + (m.offset - t.tfdOffset);
}
} // namespace

int Texture::firstLevel() const {
    for (size_t lv = 0; lv < info.levels.size(); ++lv)
        if (levelBytes(*this, info.levels[lv]))
            return static_cast<int>(lv);
    return -1;
}

bool Texture::levelData(int level, const uint8_t *&p, size_t &n, int layer) const {
    if (level < 0 || level >= static_cast<int>(info.levels.size()) || layer < 0 || layer >= static_cast<int>(info.layers))
        return false;
    const MipLevel &m = info.layers > 1 ? info.layerLevels[static_cast<size_t>(level) * info.layers + layer] : info.levels[level];
    p = levelBytes(*this, m);
    n = m.size;
    return p != nullptr;
}

namespace {
// The headers read so far, for one game data at a time, the most recently used first.
struct HeaderCache {
    std::mutex mu;
    uint64_t gd = 0;
    size_t bytes = 0;
    std::list<std::pair<std::string, std::shared_ptr<const Texture>>> order;
    std::unordered_map<std::string, decltype(order)::iterator> byBase;
} g_headers;
constexpr size_t kHeaderBytes = 256u << 20;
} // namespace

std::shared_ptr<const Texture> textureHeader(const GameData &gd, std::string_view base, std::string *err) {
    std::string key = normalizeGamePath(base);
    {
        std::lock_guard lk(g_headers.mu);
        if (g_headers.gd == gd.id())
            if (auto it = g_headers.byBase.find(key); it != g_headers.byBase.end()) {
                g_headers.order.splice(g_headers.order.begin(), g_headers.order, it->second);
                return it->second->second;
            }
    }
    auto t = std::make_shared<Texture>();
    t->base = key;
    if (!gd.read(t->base + ".tfh", t->tfh, err) || !parseTfh(t->tfh, t->info, err))
        return nullptr; // (not kept: asked again, read again)
    std::lock_guard lk(g_headers.mu);
    if (g_headers.gd != gd.id()) {
        g_headers.byBase.clear();
        g_headers.order.clear();
        g_headers.bytes = 0;
        g_headers.gd = gd.id();
    }
    if (auto it = g_headers.byBase.find(key); it != g_headers.byBase.end())
        return it->second->second; // (another thread read it meanwhile)
    g_headers.order.emplace_front(std::move(key), t);
    g_headers.byBase.emplace(g_headers.order.front().first, g_headers.order.begin());
    g_headers.bytes += t->tfh.size();
    while (g_headers.bytes > kHeaderBytes && g_headers.order.size() > 1) {
        g_headers.bytes -= g_headers.order.back().second->tfh.size();
        g_headers.byBase.erase(g_headers.order.back().first);
        g_headers.order.pop_back();
    }
    return t;
}

bool loadTextureHeader(const GameData &gd, std::string_view base, Texture &t, std::string *err) {
    auto h = textureHeader(gd, base, err);
    if (!h) {
        t = Texture{};
        t.base = normalizeGamePath(base);
        return false;
    }
    t = *h;
    return true;
}

bool loadTextureLevels(const GameData &gd, Texture &t, int from, int to, std::string *err) {
    uint64_t lo = UINT64_MAX, hi = 0;
    const std::vector<MipLevel> &all = t.info.layers > 1 ? t.info.layerLevels : t.info.levels; // (every layer of those levels)
    for (int lv = std::max(from, 0); lv <= to && lv < static_cast<int>(t.info.levels.size()); ++lv)
        for (uint32_t l = 0; l < t.info.layers; ++l) {
            const MipLevel &m = all[static_cast<size_t>(lv) * t.info.layers + l];
            if (m.inTfd) {
                lo = std::min<uint64_t>(lo, m.offset);
                hi = std::max<uint64_t>(hi, static_cast<uint64_t>(m.offset) + m.size);
            }
        }
    if (lo >= hi)
        return true; // all in the .tfh
    const Entry *e = gd.find(t.base + ".tfd");
    if (!e)
        return true; // (those levels stay unavailable)
    hi = std::min<uint64_t>(hi, e->size);
    if (lo >= hi)
        return true;
    t.hasTfd = gd.readRange(*e, lo, hi - lo, t.tfd, err);
    t.tfdOffset = t.hasTfd ? lo : 0;
    return t.hasTfd;
}

bool loadTexture(const GameData &gd, std::string_view base, Texture &t, std::string *err, bool loadTfd) {
    if (!loadTextureHeader(gd, base, t, err))
        return false;
    // Without the .tfd only the small mips exist; some textures keep every level there.
    if (t.info.needsTfd && (loadTfd || t.firstLevel() < 0)) {
        std::string e2;
        t.hasTfd = gd.read(t.base + ".tfd", t.tfd, &e2);
    }
    if (t.firstLevel() < 0) {
        if (err)
            *err = t.base + ": no mip level is available";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------------------------
// Block decoders
namespace {

inline void put(std::vector<uint8_t> &o, uint32_t w, uint32_t h, uint32_t x, uint32_t y, const uint8_t c[4]) {
    if (x >= w || y >= h)
        return;
    uint8_t *d = &o[(static_cast<size_t>(y) * w + x) * 4];
    d[0] = c[0];
    d[1] = c[1];
    d[2] = c[2];
    d[3] = c[3];
}

void rgb565(uint16_t c, uint8_t out[3]) {
    const uint32_t r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
    out[0] = static_cast<uint8_t>((r << 3) | (r >> 2));
    out[1] = static_cast<uint8_t>((g << 2) | (g >> 4));
    out[2] = static_cast<uint8_t>((b << 3) | (b >> 2));
}

void colorBlock(const uint8_t *b, uint8_t pal[4][4], bool fourAlways) {
    uint16_t c0, c1;
    std::memcpy(&c0, b, 2);
    std::memcpy(&c1, b + 2, 2);
    rgb565(c0, pal[0]);
    rgb565(c1, pal[1]);
    pal[0][3] = pal[1][3] = 255;
    if (c0 > c1 || fourAlways) {
        for (int i = 0; i < 3; ++i) {
            pal[2][i] = static_cast<uint8_t>((2 * pal[0][i] + pal[1][i] + 1) / 3);
            pal[3][i] = static_cast<uint8_t>((pal[0][i] + 2 * pal[1][i] + 1) / 3);
        }
        pal[2][3] = pal[3][3] = 255;
    } else {
        for (int i = 0; i < 3; ++i) {
            pal[2][i] = static_cast<uint8_t>((pal[0][i] + pal[1][i]) / 2);
            pal[3][i] = 0;
        }
        pal[2][3] = 255;
        pal[3][3] = 0;
    }
}

void alphaBlockBC4(const uint8_t *b, uint8_t out[16]) {
    const uint32_t a0 = b[0], a1 = b[1];
    uint8_t pal[8];
    pal[0] = static_cast<uint8_t>(a0);
    pal[1] = static_cast<uint8_t>(a1);
    if (a0 > a1) {
        for (int i = 1; i < 7; ++i)
            pal[i + 1] = static_cast<uint8_t>(((7 - i) * a0 + i * a1 + 3) / 7);
    } else {
        for (int i = 1; i < 5; ++i)
            pal[i + 1] = static_cast<uint8_t>(((5 - i) * a0 + i * a1 + 2) / 5);
        pal[6] = 0;
        pal[7] = 255;
    }
    uint64_t bits = 0;
    for (int i = 0; i < 6; ++i)
        bits |= static_cast<uint64_t>(b[2 + i]) << (8 * i);
    for (int i = 0; i < 16; ++i)
        out[i] = pal[(bits >> (3 * i)) & 7];
}

// ---- BC7 --------------------------------------------------------------------------------------
struct Bc7Mode {
    uint8_t subsets, partBits, rotBits, idxSelBits, colorBits, alphaBits, endpointPBits, sharedPBits, idxBits, idx2Bits;
};
const Bc7Mode kModes[8] = {
    {3, 4, 0, 0, 4, 0, 1, 0, 3, 0}, {2, 6, 0, 0, 6, 0, 0, 1, 3, 0}, {3, 6, 0, 0, 5, 0, 0, 0, 2, 0},
    {2, 6, 0, 0, 7, 0, 1, 0, 2, 0}, {1, 0, 2, 1, 5, 6, 0, 0, 2, 3}, {1, 0, 2, 0, 7, 8, 0, 0, 2, 2},
    {1, 0, 0, 0, 7, 7, 1, 0, 4, 0}, {2, 6, 0, 0, 5, 5, 1, 0, 2, 0},
};
const uint16_t kPart2[64] = {
    0xCCCC, 0x8888, 0xEEEE, 0xECC8, 0xC880, 0xFEEC, 0xFEC8, 0xEC80, 0xC800, 0xFFEC, 0xFE80, 0xE800, 0xFFE8, 0xFF00, 0xFFF0, 0xF000,
    0xF710, 0x008E, 0x7100, 0x08CE, 0x008C, 0x7310, 0x3100, 0x8CCE, 0x088C, 0x3110, 0x6666, 0x366C, 0x17E8, 0x0FF0, 0x718E, 0x399C,
    0xAAAA, 0xF0F0, 0x5A5A, 0x33CC, 0x3C3C, 0x55AA, 0x9696, 0xA55A, 0x73CE, 0x13C8, 0x324C, 0x3BDC, 0x6996, 0xC33C, 0x9966, 0x0660,
    0x0272, 0x04E4, 0x4E40, 0x2720, 0xC936, 0x936C, 0x39C6, 0x639C, 0x9336, 0x9CC6, 0x817E, 0xE718, 0xCCF0, 0x0FCC, 0x7744, 0xEE22,
};
const uint8_t kPart3[64][16] = {
    {0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 1, 2, 2, 2, 2}, {0, 0, 0, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 1},
    {0, 0, 0, 0, 2, 0, 0, 1, 2, 2, 1, 1, 2, 2, 1, 1}, {0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 1, 0, 1, 1, 1},
    {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2}, {0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 2, 2},
    {0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1}, {0, 0, 1, 1, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1},
    {0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2}, {0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2},
    {0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2}, {0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2},
    {0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2, 0, 1, 1, 2}, {0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2, 0, 1, 2, 2},
    {0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2, 1, 2, 2, 2}, {0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0, 2, 2, 2, 0},
    {0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 2, 1, 1, 2, 2}, {0, 1, 1, 1, 0, 0, 1, 1, 2, 0, 0, 1, 2, 2, 0, 0},
    {0, 0, 0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2}, {0, 0, 2, 2, 0, 0, 2, 2, 0, 0, 2, 2, 1, 1, 1, 1},
    {0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2, 0, 2, 2, 2}, {0, 0, 0, 1, 0, 0, 0, 1, 2, 2, 2, 1, 2, 2, 2, 1},
    {0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2}, {0, 0, 0, 0, 1, 1, 0, 0, 2, 2, 1, 0, 2, 2, 1, 0},
    {0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1, 0, 0, 0, 0}, {0, 0, 1, 2, 0, 0, 1, 2, 1, 1, 2, 2, 2, 2, 2, 2},
    {0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1, 0, 1, 1, 0}, {0, 0, 0, 0, 0, 1, 1, 0, 1, 2, 2, 1, 1, 2, 2, 1},
    {0, 0, 2, 2, 1, 1, 0, 2, 1, 1, 0, 2, 0, 0, 2, 2}, {0, 1, 1, 0, 0, 1, 1, 0, 2, 0, 0, 2, 2, 2, 2, 2},
    {0, 0, 1, 1, 0, 1, 2, 2, 0, 1, 2, 2, 0, 0, 1, 1}, {0, 0, 0, 0, 2, 0, 0, 0, 2, 2, 1, 1, 2, 2, 2, 1},
    {0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 2, 2, 2}, {0, 2, 2, 2, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 1, 1},
    {0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 2, 2, 0, 2, 2, 2}, {0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0, 0, 1, 2, 0},
    {0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0}, {0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0},
    {0, 1, 2, 0, 2, 0, 1, 2, 1, 2, 0, 1, 0, 1, 2, 0}, {0, 0, 1, 1, 2, 2, 0, 0, 1, 1, 2, 2, 0, 0, 1, 1},
    {0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 1, 1}, {0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2},
    {0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1}, {0, 0, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2, 1, 1, 2, 2},
    {0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 1, 1}, {0, 2, 2, 0, 1, 2, 2, 1, 0, 2, 2, 0, 1, 2, 2, 1},
    {0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 0, 1, 0, 1}, {0, 0, 0, 0, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1},
    {0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2}, {0, 2, 2, 2, 0, 1, 1, 1, 0, 2, 2, 2, 0, 1, 1, 1},
    {0, 0, 0, 2, 1, 1, 1, 2, 0, 0, 0, 2, 1, 1, 1, 2}, {0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2},
    {0, 2, 2, 2, 0, 1, 1, 1, 0, 1, 1, 1, 0, 2, 2, 2}, {0, 0, 0, 2, 1, 1, 1, 2, 1, 1, 1, 2, 0, 0, 0, 2},
    {0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2}, {0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 2, 2, 1, 1, 2},
    {0, 1, 1, 0, 0, 1, 1, 0, 2, 2, 2, 2, 2, 2, 2, 2}, {0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 2, 2},
    {0, 0, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 0, 0, 2, 2}, {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1},
    {0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1}, {0, 2, 2, 2, 1, 2, 2, 2, 0, 2, 2, 2, 1, 2, 2, 2},
    {0, 1, 0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2}, {0, 1, 1, 1, 2, 0, 1, 1, 2, 2, 0, 1, 2, 2, 2, 0},
};
const uint8_t kAnchor2[64] = {15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
                              15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15};
const uint8_t kAnchor3a[64] = {3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
                               8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3};
const uint8_t kAnchor3b[64] = {15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
                               15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8};
const uint8_t kW2[4] = {0, 21, 43, 64}, kW3[8] = {0, 9, 18, 27, 37, 46, 55, 64},
              kW4[16] = {0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64};

struct Bits {
    const uint8_t *b;
    uint32_t pos = 0;
    uint32_t get(uint32_t n) {
        uint32_t v = 0;
        for (uint32_t i = 0; i < n; ++i, ++pos)
            v |= static_cast<uint32_t>((b[pos >> 3] >> (pos & 7)) & 1) << i;
        return v;
    }
};

const uint8_t *weights(uint32_t bits) { return bits == 2 ? kW2 : bits == 3 ? kW3 : kW4; }

void bc7Block(const uint8_t *blk, uint8_t out[16][4]) {
    Bits br{blk};
    uint32_t mode = 0;
    while (mode < 8 && !br.get(1))
        ++mode;
    if (mode >= 8) {
        std::memset(out, 0, 64);
        return;
    }
    const Bc7Mode &M = kModes[mode];
    const uint32_t part = br.get(M.partBits), rot = br.get(M.rotBits), isel = br.get(M.idxSelBits);
    const uint32_t ne = M.subsets * 2u;
    uint32_t ep[6][4] = {};
    for (uint32_t c = 0; c < 3; ++c)
        for (uint32_t e = 0; e < ne; ++e)
            ep[e][c] = br.get(M.colorBits);
    for (uint32_t e = 0; e < ne; ++e)
        ep[e][3] = M.alphaBits ? br.get(M.alphaBits) : 255;
    uint32_t cb = M.colorBits, ab = M.alphaBits;
    if (M.endpointPBits) {
        for (uint32_t e = 0; e < ne; ++e) {
            const uint32_t p = br.get(1);
            for (uint32_t c = 0; c < 3; ++c)
                ep[e][c] = (ep[e][c] << 1) | p;
            if (ab)
                ep[e][3] = (ep[e][3] << 1) | p;
        }
        ++cb;
        if (ab)
            ++ab;
    }
    if (M.sharedPBits) {
        for (uint32_t s = 0; s < M.subsets; ++s) {
            const uint32_t p = br.get(1);
            for (uint32_t e : {2 * s, 2 * s + 1}) {
                for (uint32_t c = 0; c < 3; ++c)
                    ep[e][c] = (ep[e][c] << 1) | p;
                if (ab)
                    ep[e][3] = (ep[e][3] << 1) | p;
            }
        }
        ++cb;
        if (ab)
            ++ab;
    }
    for (uint32_t e = 0; e < ne; ++e) {
        for (uint32_t c = 0; c < 3; ++c) {
            ep[e][c] <<= (8 - cb);
            ep[e][c] |= ep[e][c] >> cb;
        }
        if (ab) {
            ep[e][3] <<= (8 - ab);
            ep[e][3] |= ep[e][3] >> ab;
        }
    }
    auto subsetOf = [&](uint32_t i) -> uint32_t {
        if (M.subsets == 1)
            return 0;
        if (M.subsets == 2)
            return (kPart2[part] >> i) & 1;
        return kPart3[part][i];
    };
    auto isAnchor = [&](uint32_t i) {
        if (i == 0)
            return true;
        if (M.subsets == 2)
            return i == kAnchor2[part];
        if (M.subsets == 3)
            return i == kAnchor3a[part] || i == kAnchor3b[part];
        return false;
    };
    uint32_t idx1[16], idx2[16] = {};
    for (uint32_t i = 0; i < 16; ++i)
        idx1[i] = br.get(M.idxBits - (isAnchor(i) ? 1 : 0));
    if (M.idx2Bits)
        for (uint32_t i = 0; i < 16; ++i)
            idx2[i] = br.get(M.idx2Bits - (i == 0 ? 1 : 0));
    for (uint32_t i = 0; i < 16; ++i) {
        const uint32_t s = subsetOf(i);
        const uint32_t *e0 = ep[2 * s], *e1 = ep[2 * s + 1];
        uint32_t cw, aw;
        if (M.idx2Bits) {
            const uint32_t a = weights(M.idxBits)[idx1[i]], c = weights(M.idx2Bits)[idx2[i]];
            cw = isel ? c : a;
            aw = isel ? a : c;
        } else {
            cw = aw = weights(M.idxBits)[idx1[i]];
        }
        uint8_t px[4];
        for (int c = 0; c < 3; ++c)
            px[c] = static_cast<uint8_t>(((64 - cw) * e0[c] + cw * e1[c] + 32) >> 6);
        px[3] = static_cast<uint8_t>(((64 - aw) * e0[3] + aw * e1[3] + 32) >> 6);
        if (rot) {
            std::swap(px[3], px[rot - 1]);
        }
        std::memcpy(out[i], px, 4);
    }
}


// ---- BC6H (unsigned half floats; the D3D11 BC6H layouts) ----------------------------------------
// Each mode's header after its mode bits, as runs of bits in stream order: field (r0 g0 b0 r1 g1 b1 r2
// g2 b2 r3 g3 b3, then the partition), the lowest bit, how many, and whether the run is stored from
// its top bit down (modes 12 and 13: "r0[10:15]").
struct Bc6Run {
    uint8_t field, lo, n, rev;
};
enum : uint8_t { R0, G0, B0, R1, G1, B1, R2, G2, B2, R3, G3, B3, D };
struct Bc6Mode {
    uint8_t transformed, regions, epBits, delta[3];
    std::vector<Bc6Run> runs;
};
const Bc6Mode &bc6Mode(int m) {
    auto r = [](uint8_t f, uint8_t lo, uint8_t n = 1, uint8_t rev = 0) { return Bc6Run{f, lo, n, rev}; };
    static const Bc6Mode modes[14] = {
        {1, 2, 10, {5, 5, 5}, {r(G2, 4), r(B2, 4), r(B3, 4), r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 5), r(G3, 4), r(G2, 0, 4), r(G1, 0, 5), r(B3, 0), r(G3, 0, 4),
                                r(B1, 0, 5), r(B3, 1), r(B2, 0, 4), r(R2, 0, 5), r(B3, 2), r(R3, 0, 5), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 7, {6, 6, 6}, {r(G2, 5), r(G3, 4), r(G3, 5), r(R0, 0, 7), r(B3, 0), r(B3, 1), r(B2, 4), r(G0, 0, 7), r(B2, 5), r(B3, 2), r(G2, 4), r(B0, 0, 7), r(B3, 3), r(B3, 5),
                              r(B3, 4), r(R1, 0, 6), r(G2, 0, 4), r(G1, 0, 6), r(G3, 0, 4), r(B1, 0, 6), r(B2, 0, 4), r(R2, 0, 6), r(R3, 0, 6), r(D, 0, 5)}},
        {1, 2, 11, {5, 4, 4}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 5), r(R0, 10), r(G2, 0, 4), r(G1, 0, 4), r(G0, 10), r(B3, 0), r(G3, 0, 4), r(B1, 0, 4), r(B0, 10),
                               r(B3, 1), r(B2, 0, 4), r(R2, 0, 5), r(B3, 2), r(R3, 0, 5), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 11, {4, 5, 4}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 4), r(R0, 10), r(G3, 4), r(G2, 0, 4), r(G1, 0, 5), r(G0, 10), r(G3, 0, 4), r(B1, 0, 4), r(B0, 10),
                               r(B3, 1), r(B2, 0, 4), r(R2, 0, 4), r(B3, 0), r(B3, 2), r(R3, 0, 4), r(G2, 4), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 11, {4, 4, 5}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 4), r(R0, 10), r(B2, 4), r(G2, 0, 4), r(G1, 0, 4), r(G0, 10), r(B3, 0), r(G3, 0, 4), r(B1, 0, 5),
                               r(B0, 10), r(B2, 0, 4), r(R2, 0, 4), r(B3, 1), r(B3, 2), r(R3, 0, 4), r(B3, 4), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 9, {5, 5, 5}, {r(R0, 0, 9), r(B2, 4), r(G0, 0, 9), r(G2, 4), r(B0, 0, 9), r(B3, 4), r(R1, 0, 5), r(G3, 4), r(G2, 0, 4), r(G1, 0, 5), r(B3, 0), r(G3, 0, 4), r(B1, 0, 5),
                              r(B3, 1), r(B2, 0, 4), r(R2, 0, 5), r(B3, 2), r(R3, 0, 5), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 8, {6, 5, 5}, {r(R0, 0, 8), r(G3, 4), r(B2, 4), r(G0, 0, 8), r(B3, 2), r(G2, 4), r(B0, 0, 8), r(B3, 3), r(B3, 4), r(R1, 0, 6), r(G2, 0, 4), r(G1, 0, 5), r(B3, 0),
                              r(G3, 0, 4), r(B1, 0, 5), r(B3, 1), r(B2, 0, 4), r(R2, 0, 6), r(R3, 0, 6), r(D, 0, 5)}},
        {1, 2, 8, {5, 6, 5}, {r(R0, 0, 8), r(B3, 0), r(B2, 4), r(G0, 0, 8), r(G2, 5), r(G2, 4), r(B0, 0, 8), r(G3, 5), r(B3, 4), r(R1, 0, 5), r(G3, 4), r(G2, 0, 4), r(G1, 0, 6),
                              r(G3, 0, 4), r(B1, 0, 5), r(B3, 1), r(B2, 0, 4), r(R2, 0, 5), r(B3, 2), r(R3, 0, 5), r(B3, 3), r(D, 0, 5)}},
        {1, 2, 8, {5, 5, 6}, {r(R0, 0, 8), r(B3, 1), r(B2, 4), r(G0, 0, 8), r(B2, 5), r(G2, 4), r(B0, 0, 8), r(B3, 5), r(B3, 4), r(R1, 0, 5), r(G3, 4), r(G2, 0, 4), r(G1, 0, 5),
                              r(B3, 0), r(G3, 0, 4), r(B1, 0, 6), r(B2, 0, 4), r(R2, 0, 5), r(B3, 2), r(R3, 0, 5), r(B3, 3), r(D, 0, 5)}},
        {0, 2, 6, {6, 6, 6}, {r(R0, 0, 6), r(G3, 4), r(B3, 0), r(B3, 1), r(B2, 4), r(G0, 0, 6), r(G2, 5), r(B2, 5), r(B3, 2), r(G2, 4), r(B0, 0, 6), r(G3, 5), r(B3, 3), r(B3, 5),
                              r(B3, 4), r(R1, 0, 6), r(G2, 0, 4), r(G1, 0, 6), r(G3, 0, 4), r(B1, 0, 6), r(B2, 0, 4), r(R2, 0, 6), r(R3, 0, 6), r(D, 0, 5)}},
        {0, 1, 10, {10, 10, 10}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 10), r(G1, 0, 10), r(B1, 0, 10)}},
        {1, 1, 11, {9, 9, 9}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 9), r(R0, 10), r(G1, 0, 9), r(G0, 10), r(B1, 0, 9), r(B0, 10)}},
        {1, 1, 12, {8, 8, 8}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 8), r(R0, 10, 2, 1), r(G1, 0, 8), r(G0, 10, 2, 1), r(B1, 0, 8), r(B0, 10, 2, 1)}},
        {1, 1, 16, {4, 4, 4}, {r(R0, 0, 10), r(G0, 0, 10), r(B0, 0, 10), r(R1, 0, 4), r(R0, 10, 6, 1), r(G1, 0, 4), r(G0, 10, 6, 1), r(B1, 0, 4), r(B0, 10, 6, 1)}},
    };
    return modes[m];
}

float halfBits(uint32_t h) {
    const uint32_t s = h >> 15, e = (h >> 10) & 31, m = h & 1023;
    float v = e == 0 ? std::ldexp(static_cast<float>(m), -24) : e == 31 ? 65504.0f : std::ldexp(static_cast<float>(m | 1024), static_cast<int>(e) - 25);
    return s ? -v : v;
}

// R11G11B10 floats: no sign, a 5-bit exponent (bias 15) over a 6-bit mantissa (red, green) or a
// 5-bit one (blue), red in the low bits
float smallFloat(uint32_t bits, int mantissa) {
    const uint32_t e = (bits >> mantissa) & 31, m = bits & ((1u << mantissa) - 1);
    return e == 0 ? std::ldexp(static_cast<float>(m), -14 - mantissa) : e == 31 ? 65504.0f : std::ldexp(static_cast<float>(m | (1u << mantissa)), static_cast<int>(e) - 15 - mantissa);
}
void r11g11b10(const uint8_t *p, float out[3]) {
    uint32_t v;
    std::memcpy(&v, p, 4);
    out[0] = smallFloat(v & 0x7FF, 6);
    out[1] = smallFloat((v >> 11) & 0x7FF, 6);
    out[2] = smallFloat(v >> 22, 5);
}

// a linear value as an sRGB byte, clamped at 1 (the float formats' 8-bit picture)
uint8_t srgbByte(float v) {
    v = std::clamp(v, 0.0f, 1.0f);
    const float sv = v <= 0.0031308f ? v * 12.92f : 1.055f * std::pow(v, 1 / 2.4f) - 0.055f;
    return static_cast<uint8_t>(std::lround(sv * 255));
}

// out: linear RGB as floats (alpha 1)
void bc6hBlock(const uint8_t *blk, float out[16][3]) {
    Bits br{blk};
    uint32_t code = br.get(2);
    if (code >= 2)
        code |= br.get(3) << 2;
    static const int8_t modeOf[32] = {0, 1, 2, 10, -1, -1, 3, 11, -1, -1, 4, 12, -1, -1, 5, 13, -1, -1, 6, -1, -1, -1, 7, -1, -1, -1, 8, -1, -1, -1, 9, -1};
    const int mi = modeOf[code & 31];
    if (mi < 0) { // reserved: black
        for (int i = 0; i < 16; ++i)
            out[i][0] = out[i][1] = out[i][2] = 0;
        return;
    }
    const Bc6Mode &M = bc6Mode(mi);
    int32_t f[13] = {};
    for (const Bc6Run &run : M.runs)
        for (uint32_t k = 0; k < run.n; ++k) {
            const uint32_t bit = br.get(1);
            const uint32_t pos = run.rev ? run.lo + run.n - 1 - k : run.lo + k;
            f[run.field] |= static_cast<int32_t>(bit << pos);
        }
    const uint32_t shape = static_cast<uint32_t>(f[D]);
    int32_t ep[4][3] = {{f[R0], f[G0], f[B0]}, {f[R1], f[G1], f[B1]}, {f[R2], f[G2], f[B2]}, {f[R3], f[G3], f[B3]}};
    const int ne = M.regions * 2, eb = M.epBits;
    auto signExtend = [](int32_t v, int bits) { return (v & (1 << (bits - 1))) ? v - (1 << bits) : v; };
    if (M.transformed) {
        const int32_t mask = (1 << eb) - 1;
        for (int e = 1; e < ne; ++e)
            for (int c = 0; c < 3; ++c)
                ep[e][c] = (ep[0][c] + signExtend(ep[e][c], M.delta[c])) & mask;
    }
    auto unq = [&](int32_t x) -> int32_t {
        if (eb >= 15)
            return x;
        if (x == 0)
            return 0;
        if (x == (1 << eb) - 1)
            return 0xFFFF;
        return ((x << 16) + 0x8000) >> eb;
    };
    for (int e = 0; e < ne; ++e)
        for (int c = 0; c < 3; ++c)
            ep[e][c] = unq(ep[e][c]);
    const uint32_t ib = M.regions == 2 ? 3 : 4;
    const uint8_t *wt = ib == 3 ? kW3 : kW4;
    for (uint32_t i = 0; i < 16; ++i) {
        const uint32_t region = M.regions == 2 ? (kPart2[shape & 31] >> i) & 1 : 0;
        const bool anchor = i == 0 || (M.regions == 2 && i == kAnchor2[shape & 31]);
        const uint32_t w = wt[br.get(ib - (anchor ? 1 : 0))];
        for (int c = 0; c < 3; ++c) {
            const int32_t a = ep[region * 2][c], b = ep[region * 2 + 1][c];
            const int32_t v = (a * (64 - static_cast<int32_t>(w)) + b * static_cast<int32_t>(w) + 32) >> 6;
            out[i][c] = halfBits(static_cast<uint32_t>((v * 31) >> 6));
        }
    }
}

} // namespace

bool decodePixels(PixelFormat fmt, const uint8_t *data, size_t size, uint32_t w, uint32_t h, std::vector<uint8_t> &o,
                  std::string *err) {
    const PixelFormat f = baseFormat(fmt);
    // The size check comes before the allocation: a damaged header can claim 16384 x 16384.
    o.clear();
    if (f == PixelFormat::RGBA8) {
        if (size < static_cast<size_t>(w) * h * 4) {
            if (err)
                *err = "texture data too short";
            return false;
        }
        o.assign(data, data + static_cast<size_t>(w) * h * 4);
        return true;
    }
    if (f == PixelFormat::R11G11B10F) { // linear floats -> sRGB bytes, clamped at 1
        const size_t n = static_cast<size_t>(w) * h;
        if (size < n * 4) {
            if (err)
                *err = "texture data too short";
            return false;
        }
        o.assign(n * 4, 255);
        for (size_t i = 0; i < n; ++i) {
            float c[3];
            r11g11b10(data + i * 4, c);
            for (int k = 0; k < 3; ++k)
                o[i * 4 + k] = srgbByte(c[k]);
        }
        return true;
    }
    const int bb = blockBytes(f);
    if (!bb) {
        if (err)
            *err = "unsupported texture format";
        return false;
    }
    const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    if (size < static_cast<size_t>(bw) * bh * bb) {
        if (err)
            *err = "texture data too short";
        return false;
    }
    o.assign(static_cast<size_t>(w) * h * 4, 0);
    parallelRows(bh, [&](size_t row) { // (block rows side by side: each writes only its own pixels)
        const uint32_t by = static_cast<uint32_t>(row);
        for (uint32_t bx = 0; bx < bw; ++bx) {
            const uint8_t *blk = data + (static_cast<size_t>(by) * bw + bx) * bb;
            uint8_t px[16][4];
            if (f == PixelFormat::BC1) {
                uint8_t pal[4][4];
                colorBlock(blk, pal, false);
                uint32_t idx;
                std::memcpy(&idx, blk + 4, 4);
                for (int i = 0; i < 16; ++i)
                    std::memcpy(px[i], pal[(idx >> (2 * i)) & 3], 4);
            } else if (f == PixelFormat::BC2 || f == PixelFormat::BC3) {
                uint8_t pal[4][4];
                colorBlock(blk + 8, pal, true);
                uint32_t idx;
                std::memcpy(&idx, blk + 12, 4);
                uint8_t al[16];
                if (f == PixelFormat::BC3) {
                    alphaBlockBC4(blk, al);
                } else {
                    for (int i = 0; i < 16; ++i)
                        al[i] = static_cast<uint8_t>(((blk[i >> 1] >> ((i & 1) * 4)) & 15) * 17);
                }
                for (int i = 0; i < 16; ++i) {
                    std::memcpy(px[i], pal[(idx >> (2 * i)) & 3], 3);
                    px[i][3] = al[i];
                }
            } else if (f == PixelFormat::BC4) {
                uint8_t r[16];
                alphaBlockBC4(blk, r);
                for (int i = 0; i < 16; ++i) {
                    px[i][0] = px[i][1] = px[i][2] = r[i];
                    px[i][3] = 255;
                }
            } else if (f == PixelFormat::BC5) {
                uint8_t r[16], g[16];
                alphaBlockBC4(blk, r);
                alphaBlockBC4(blk + 8, g);
                for (int i = 0; i < 16; ++i) {
                    px[i][0] = r[i];
                    px[i][1] = g[i];
                    px[i][2] = 0;
                    px[i][3] = 255;
                }
            } else if (f == PixelFormat::BC6H) { // linear half floats -> sRGB bytes, clamped at 1
                float hdr[16][3];
                bc6hBlock(blk, hdr);
                for (int i = 0; i < 16; ++i) {
                    for (int c = 0; c < 3; ++c)
                        px[i][c] = srgbByte(hdr[i][c]);
                    px[i][3] = 255;
                }
            } else { // BC7
                bc7Block(blk, px);
            }
            for (int i = 0; i < 16; ++i)
                put(o, w, h, bx * 4 + (i & 3), by * 4 + (i >> 2), px[i]);
        }
    }, 8);
    return true;
}

bool decodeLevel(const Texture &t, int level, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err, int layer) {
    const uint8_t *p;
    size_t n;
    if (!t.levelData(level, p, n, layer)) {
        if (err)
            *err = t.base + ": mip level " + std::to_string(level) + (layer ? " of layer " + std::to_string(layer) : "") + " is not available";
        return false;
    }
    w = t.info.levels[level].width;
    h = t.info.levels[level].height;
    return decodePixels(t.info.format, p, n, w, h, rgba, err);
}

bool decodeLevelFloat(const Texture &t, int level, std::vector<float> &rgb, uint32_t &w, uint32_t &h, std::string *err, int layer) {
    const PixelFormat f = baseFormat(t.info.format);
    rgb.clear();
    if (f != PixelFormat::R11G11B10F && f != PixelFormat::BC6H) {
        std::vector<uint8_t> rgba;
        if (!decodeLevel(t, level, rgba, w, h, err, layer))
            return false;
        rgb.resize(rgba.size() / 4 * 3);
        for (size_t i = 0; i < rgba.size() / 4; ++i)
            for (int c = 0; c < 3; ++c)
                rgb[i * 3 + c] = rgba[i * 4 + c] / 255.0f;
        return true;
    }
    const uint8_t *p;
    size_t n;
    if (!t.levelData(level, p, n, layer)) {
        if (err)
            *err = t.base + ": mip level " + std::to_string(level) + (layer ? " of layer " + std::to_string(layer) : "") + " is not available";
        return false;
    }
    w = t.info.levels[level].width;
    h = t.info.levels[level].height;
    const size_t px = static_cast<size_t>(w) * h;
    const uint32_t bw = (w + 3) / 4, bh = (h + 3) / 4;
    if (n < (f == PixelFormat::BC6H ? static_cast<size_t>(bw) * bh * 16 : px * 4)) {
        if (err)
            *err = "texture data too short";
        return false;
    }
    rgb.assign(px * 3, 0.0f);
    if (f == PixelFormat::R11G11B10F) {
        for (size_t i = 0; i < px; ++i)
            r11g11b10(p + i * 4, &rgb[i * 3]);
        return true;
    }
    for (uint32_t by = 0; by < bh; ++by)
        for (uint32_t bx = 0; bx < bw; ++bx) {
            float hdr[16][3];
            bc6hBlock(p + (static_cast<size_t>(by) * bw + bx) * 16, hdr);
            for (uint32_t i = 0; i < 16; ++i) {
                const uint32_t x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                if (x < w && y < h)
                    std::memcpy(&rgb[(static_cast<size_t>(y) * w + x) * 3], hdr[i], sizeof(hdr[i]));
            }
        }
    return true;
}

// The layout under which the texels look most like normals: each candidate is scored by the share of
// texels that make a unit normal facing out of the surface (AG / RG: |xy| below 0.97, z rebuilt; RGB:
// length about 1 and z > 0.2). Near-ties go to the format's usual layout (BC3: DXT5nm, X in alpha;
// otherwise plain RGB). A flat DXT5nm map (alpha a constant 128, red 255) used to be read as RG: every
// normal then lay in the surface, lit edge-on (glass panes, belts, the shared blank_parts_n / flat_n,
// junk and buggy structure parts...).
NormalLayout guessNormalLayout(PixelFormat fmt, const std::vector<uint8_t> &rgba) {
    if (baseFormat(fmt) == PixelFormat::BC5)
        return NormalLayout::RG;
    const size_t n = rgba.size() / 4;
    if (!n)
        return NormalLayout::RGB;
    const size_t step = std::max<size_t>(1, n / 4096);
    size_t k = 0, goodAG = 0, goodRG = 0, goodRGB = 0;
    for (size_t i = 0; i < n; i += step, ++k) {
        const uint8_t *p = &rgba[i * 4];
        const double r = p[0] / 127.5 - 1, g = p[1] / 127.5 - 1, b = p[2] / 127.5 - 1, a = p[3] / 127.5 - 1;
        goodAG += a * a + g * g < 0.94;
        goodRG += r * r + g * g < 0.94;
        goodRGB += std::abs(std::sqrt(r * r + g * g + b * b) - 1) < 0.2 && b > 0.2;
    }
    const double qAG = static_cast<double>(goodAG) / k, qRG = static_cast<double>(goodRG) / k, qRGB = static_cast<double>(goodRGB) / k;
    const PixelFormat f = baseFormat(fmt);
    const bool dxt5 = f == PixelFormat::BC3 || f == PixelFormat::BC2 || f == PixelFormat::BC7;
    // in order of preference for this format; another layout wins only by a clear margin
    std::pair<NormalLayout, double> order[3];
    if (dxt5) {
        order[0] = {NormalLayout::AG, qAG};
        order[1] = {NormalLayout::RGB, qRGB};
        order[2] = {NormalLayout::RG, qRG};
    } else {
        order[0] = {NormalLayout::RGB, qRGB};
        order[1] = {NormalLayout::RG, qRG};
        order[2] = {NormalLayout::AG, qAG};
    }
    std::pair<NormalLayout, double> best = order[0];
    for (int i = 1; i < 3; ++i)
        if (order[i].second > best.second + 0.03)
            best = order[i];
    return best.first;
}

void unpackNormals(std::vector<uint8_t> &rgba, NormalLayout layout, std::vector<uint8_t> *ao) {
    const size_t n = rgba.size() / 4;
    if (ao)
        ao->assign(n, 255);
    for (size_t i = 0; i < n; ++i) {
        uint8_t *p = &rgba[i * 4];
        float x, y;
        if (layout == NormalLayout::RGB) {
            p[3] = 255;
            continue;
        }
        if (layout == NormalLayout::AG) {
            if (ao)
                (*ao)[i] = p[0];
            x = p[3] / 127.5f - 1;
            y = p[1] / 127.5f - 1;
        } else {
            x = p[0] / 127.5f - 1;
            y = p[1] / 127.5f - 1;
        }
        const float z = std::sqrt(std::max(0.0f, 1 - x * x - y * y));
        p[0] = static_cast<uint8_t>(std::clamp(std::lround((x * 0.5f + 0.5f) * 255), 0L, 255L));
        p[1] = static_cast<uint8_t>(std::clamp(std::lround((y * 0.5f + 0.5f) * 255), 0L, 255L));
        p[2] = static_cast<uint8_t>(std::clamp(std::lround((z * 0.5f + 0.5f) * 255), 0L, 255L));
        p[3] = 255;
    }
}

bool makeDds(const Texture &t, std::vector<uint8_t> &out, std::string *err) {
    const int first = t.firstLevel();
    const PixelFormat f = baseFormat(t.info.format);
    if (first < 0 || !blockBytes(f)) {
        if (err)
            *err = "cannot write this texture as DDS";
        return false;
    }
    const MipLevel &top = t.info.levels[first];
    const uint32_t mips = static_cast<uint32_t>(t.info.levels.size()) - first;
    // BC1-BC5 and RGBA8 keep the classic header, which every DDS reader opens. It can't say
    // "sRGB" (the DX10 header can, but many readers, Pillow included, can't open BC1/BC3 written
    // that way), and the colours look the same either way. BC7, BC6H, R11G11B10F and layered
    // textures (arrays, cube maps) only exist with the DX10 header.
    const bool dx10 = f == PixelFormat::BC7 || f == PixelFormat::BC6H || f == PixelFormat::R11G11B10F || t.info.layers > 1;
    const bool srgb = isSrgb(t.info.format);
    const uint32_t dxgi = f == PixelFormat::RGBA8 ? (srgb ? 29 : 28) : f == PixelFormat::BC1 ? (srgb ? 72 : 71) : f == PixelFormat::BC2 ? (srgb ? 75 : 74)
                          : f == PixelFormat::BC3 ? (srgb ? 78 : 77) : f == PixelFormat::BC4 ? 80 : f == PixelFormat::BC5 ? 83 : f == PixelFormat::BC6H ? 95
                          : f == PixelFormat::R11G11B10F ? 26 : srgb ? 99 : 98; // DXGI_FORMAT_*
    out.clear();
    auto u32 = [&](uint32_t v) { out.insert(out.end(), reinterpret_cast<uint8_t *>(&v), reinterpret_cast<uint8_t *>(&v) + 4); };
    auto fourcc = [](const char *s) { return static_cast<uint32_t>(s[0]) | (s[1] << 8) | (s[2] << 16) | (static_cast<uint32_t>(s[3]) << 24); };
    u32(fourcc("DDS "));
    u32(124);
    const bool rgba = f == PixelFormat::RGBA8, perPixel = rgba || f == PixelFormat::R11G11B10F;
    u32(0x1 | 0x2 | 0x4 | 0x1000 | 0x20000 | (perPixel ? 0x8 : 0x80000)); // CAPS|HEIGHT|WIDTH|PIXELFORMAT|MIPMAPCOUNT|PITCH/LINEARSIZE
    u32(top.height);
    u32(top.width);
    u32(perPixel ? top.width * 4 : top.size);
    u32(0);    // depth
    u32(mips); // mip count
    for (int i = 0; i < 11; ++i)
        u32(0);
    // DDS_PIXELFORMAT
    u32(32);
    if (dx10) {
        u32(0x4); // FOURCC
        u32(fourcc("DX10"));
        for (int i = 0; i < 5; ++i)
            u32(0);
    } else if (rgba) {
        u32(0x40 | 0x1); // RGB | ALPHAPIXELS
        u32(0);
        u32(32);
        u32(0x000000FF);
        u32(0x0000FF00);
        u32(0x00FF0000);
        u32(0xFF000000);
    } else {
        u32(0x4); // FOURCC
        const char *cc = f == PixelFormat::BC1 ? "DXT1" : f == PixelFormat::BC2 ? "DXT3" : f == PixelFormat::BC3 ? "DXT5"
                         : f == PixelFormat::BC4 ? "ATI1" : "ATI2";
        u32(fourcc(cc));
        for (int i = 0; i < 5; ++i)
            u32(0);
    }
    u32(0x1000 | 0x8 | 0x400000); // TEXTURE | COMPLEX | MIPMAP
    u32(t.info.cube ? 0xFE00 : 0); // CUBEMAP with all six faces
    u32(0);
    u32(0);
    u32(0);
    if (dx10) {
        u32(dxgi);
        u32(3); // D3D10_RESOURCE_DIMENSION_TEXTURE2D
        u32(t.info.cube ? 4 : 0); // RESOURCE_MISC_TEXTURECUBE
        u32(t.info.cube ? 1 : t.info.layers);
        u32(0);
    }
    for (uint32_t l = 0; l < t.info.layers; ++l) // (each layer with all its mips)
        for (size_t lv = first; lv < t.info.levels.size(); ++lv) {
            const uint8_t *p;
            size_t n;
            if (!t.levelData(static_cast<int>(lv), p, n, static_cast<int>(l))) {
                if (err)
                    *err = "missing mip data";
                return false;
            }
            out.insert(out.end(), p, p + n);
        }
    return true;
}

void downscaleRgba(std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, uint32_t maxSide) {
    while ((w > maxSide || h > maxSide) && (w > 1 || h > 1)) {
        const uint32_t nw = std::max(1u, w / 2), nh = std::max(1u, h / 2);
        std::vector<uint8_t> o(static_cast<size_t>(nw) * nh * 4);
        for (uint32_t y = 0; y < nh; ++y)
            for (uint32_t x = 0; x < nw; ++x)
                for (int c = 0; c < 4; ++c) {
                    uint32_t s = 0, k = 0;
                    for (uint32_t dy = 0; dy < 2; ++dy)
                        for (uint32_t dx = 0; dx < 2; ++dx) {
                            const uint32_t sx = std::min(w - 1, x * 2 + dx), sy = std::min(h - 1, y * 2 + dy);
                            s += rgba[(static_cast<size_t>(sy) * w + sx) * 4 + c];
                            ++k;
                        }
                    o[(static_cast<size_t>(y) * nw + x) * 4 + c] = static_cast<uint8_t>((s + k / 2) / k);
                }
        rgba.swap(o);
        w = nw;
        h = nh;
    }
}

} // namespace xo
