#pragma once
// PNG writing and image-file reading through the Windows Imaging Component (no extra libraries).
// Every function initialises COM for the calling thread if needed.
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace xo {

bool encodePng(const uint8_t *rgba, uint32_t w, uint32_t h, std::vector<uint8_t> &out, std::string *err);
// JPEG (no alpha), quality 0..1.
bool encodeJpeg(const uint8_t *rgba, uint32_t w, uint32_t h, float quality, std::vector<uint8_t> &out, std::string *err);
// Written as "<name>.part" and renamed into place, so nothing half-written has the real name.
bool writeFileBytes(const std::filesystem::path &path, const void *data, size_t size, std::string *err);
bool writePng(const std::filesystem::path &path, const uint8_t *rgba, uint32_t w, uint32_t h, std::string *err);

// Files that belong together (an export and its .bin, .mtl, textures): all of them are written as
// .part first and renamed only once every one is complete, so a failure (disk full, no access)
// leaves none of them behind.
struct FileOut {
    std::filesystem::path path;
    const void *data = nullptr;
    size_t size = 0;
    std::vector<std::pair<const void *, size_t>> then; // written straight after data (a .glb's binary chunk: its pieces where they are)
};
bool writeFilesTogether(const std::vector<FileOut> &files, std::string *err);

// Deletes the .part files still being written (a forced quit calls this before ending the process).
void removePartialFiles();

// PNG, JPEG, BMP, TIFF, GIF (first frame) through WIC; TGA and DDS (BC1-BC5, BC7, 8-bit
// RGBA) by the decoders below. Always RGBA8, top row first.
bool readImageFile(const std::filesystem::path &path, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err);
bool decodeTga(const uint8_t *data, size_t size, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err);
bool decodeDds(const uint8_t *data, size_t size, std::vector<uint8_t> &rgba, uint32_t &w, uint32_t &h, std::string *err);

// Bilinear resample (used when an imported replacement has another size than the original).
void resizeRgba(const std::vector<uint8_t> &src, uint32_t sw, uint32_t sh, std::vector<uint8_t> &dst, uint32_t dw, uint32_t dh);

// Colour edits applied to an albedo texture. The same maths runs in the viewer's shader
// (ui/viewer.js, adjustColor()), so what you see is what gets exported. Works on sRGB values.
struct ColorAdjust {
    float hue = 0;        // degrees
    float saturation = 1; // multiplier
    float brightness = 0; // -1 .. 1 (added)
    float contrast = 1;   // multiplier around 0.5
    float tint[3] = {1, 1, 1};
    float tintAmount = 0;  // 0 .. 1, multiply blend
    float paint[3] = {1, 1, 1};
    float paintAmount = 0; // 0 .. 1, overlay blend where the paint mask is set
    bool isIdentity() const;
};
// mask: optional RGBA of the gloss map (_g), red = paint mask; resampled to the albedo size.
void applyColorAdjust(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const ColorAdjust &a,
                      const std::vector<uint8_t> *mask, uint32_t mw, uint32_t mh);

} // namespace xo
