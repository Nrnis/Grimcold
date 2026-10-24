#pragma once
// Crossout textures: <base>.tfh (header + small mips) and <base>.tfd (the large mips).
//
// .tfh: u32 a = kind(4) | width(14) << 4 | height(14) << 18
//       u32 b = depth(4) | ...(7) | mipCount(4) << 11 | flag << 15 | code(8) << 16 | shape(8) << 24
//       then mipCount x layers x { u32 offset, u32 size, u32 rowPitch, u32 sliceSize }, smallest
//       mip first, the layers of each mip together. Levels whose offsets restart below the header
//       live in the .tfd. layers = (first offset - 8) / 16 / mipCount: 1 for most, 6 for cube maps
//       (shape 2: the light probes, faces +X -X +Y -Y +Z -Z in game space), 4 or 64 for the layered
//       water textures (water_foam, water_default_w/_v).
// code >> 3 selects the pixel format (verified by decoding every code in the game):
//   5 RGBA8   6 RGBA8 sRGB   7 BC1   9 BC2   10 BC3   11 BC1 sRGB   13 BC2 sRGB   14 BC3 sRGB
//   20 BC4    25 BC7         26 BC7 sRGB    27 BC5   30 BC6H (unsigned half floats: sky panoramas, a light mask;
//   decoded to sRGB bytes, clamped at 1)   22 R11G11B10 floats (the light probes; the same)
// Vehicle parts use: _a albedo (BC1/BC3 sRGB), _n normal (BC3 "DXT5nm": X in alpha, Y in
// green, ambient occlusion in red; OpenGL/+Y convention), _g gloss map (BC1: R paint mask,
// G gloss, B specular level).
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace xo {

class GameData;

enum class PixelFormat : uint8_t { Unknown, RGBA8, RGBA8_SRGB, BC1, BC1_SRGB, BC2, BC2_SRGB, BC3, BC3_SRGB, BC4, BC5, BC7, BC7_SRGB, BC6H, R11G11B10F };

const char *pixelFormatName(PixelFormat f);
bool isSrgb(PixelFormat f);
int blockBytes(PixelFormat f); // 8/16 for BC formats, 4 (per pixel) for RGBA8 and R11G11B10F, 0 unknown
PixelFormat baseFormat(PixelFormat f); // sRGB variant -> linear twin

struct MipLevel {
    uint32_t width = 0, height = 0;
    bool inTfd = false;
    uint32_t offset = 0, size = 0, pitch = 0;
};

struct TextureInfo {
    uint32_t width = 0, height = 0, mipCount = 0, kind = 0, depth = 0;
    uint32_t code = 0; // raw format byte
    PixelFormat format = PixelFormat::Unknown;
    uint32_t layers = 1;          // array layers, or a cube map's 6 faces
    bool cube = false;            // the 6 layers are cube faces (+X -X +Y -Y +Z -Z)
    std::vector<MipLevel> levels; // level 0 = largest (layer 0)
    std::vector<MipLevel> layerLevels; // layers > 1: every layer's, [level * layers + layer]
    bool needsTfd = false;
};

bool parseTfh(const std::vector<uint8_t> &tfh, TextureInfo &info, std::string *err);

struct Texture {
    std::string base; // game path without extension
    TextureInfo info;
    std::vector<uint8_t> tfh, tfd;
    bool hasTfd = false;
    uint64_t tfdOffset = 0; // where tfd[0] sits in the .tfd (loadTextureLevels reads only a range)
    // Largest level whose data is present (1+ when the .tfd is missing).
    int firstLevel() const;
    bool levelData(int level, const uint8_t *&p, size_t &n, int layer = 0) const;
};

// base: "models/.../x_a" (".tfh" is appended). loadTfd=false only reads the small mips.
bool loadTexture(const GameData &gd, std::string_view base, Texture &t, std::string *err, bool loadTfd = true);
// The .tfh alone: sizes, format, the small mips, and where the others sit in the .tfd.
bool loadTextureHeader(const GameData &gd, std::string_view base, Texture &t, std::string *err);
// The same, shared: each texture's .tfh is read once per game data and kept (a map's opening asks for
// it once per model that shows it, then for the texture itself); the least recently used go first past
// 256 MB. loadTextureHeader and loadTexture copy from it.
std::shared_ptr<const Texture> textureHeader(const GameData &gd, std::string_view base, std::string *err);
// After loadTextureHeader: of the .tfd only what levels [from, to] need (a 512 px view of a 4096 px
// texture skips the big levels' chunks). A missing .tfd leaves those levels unavailable.
bool loadTextureLevels(const GameData &gd, Texture &t, int from, int to, std::string *err);

// Decodes block/pixel data of one level to RGBA8 (row-major, top row first).
bool decodePixels(PixelFormat fmt, const uint8_t *data, size_t size, uint32_t w, uint32_t h, std::vector<uint8_t> &rgba,
                  std::string *err);
bool decodeLevel(const Texture &t, int level, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err, int layer = 0);
// The same as linear RGB floats, unclamped for the float formats (R11G11B10F, BC6H); 8-bit texels
// come out as stored, / 255.
bool decodeLevelFloat(const Texture &t, int level, std::vector<float> &rgb, uint32_t &w, uint32_t &h, std::string *err, int layer = 0);

// Normal maps: how the XY(Z) components are packed.
enum class NormalLayout { AG, RG, RGB };
NormalLayout guessNormalLayout(PixelFormat fmt, const std::vector<uint8_t> &rgba);
// Rewrites packed normals into a standard RGB tangent-space normal map (+Y up, alpha 255).
// Returns the ambient-occlusion channel (red of AG-packed maps) through *ao when non-null.
void unpackNormals(std::vector<uint8_t> &rgba, NormalLayout layout, std::vector<uint8_t> *ao);

// A .dds file with every available mip (FourCC header for BC1-5, DX10 header for BC7).
bool makeDds(const Texture &t, std::vector<uint8_t> &out, std::string *err);

// Box-filter downscale by powers of two until both sides are <= maxSide.
void downscaleRgba(std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, uint32_t maxSide);

} // namespace xo
