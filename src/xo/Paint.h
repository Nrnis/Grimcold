#pragma once
// A paint on a part, baked into its textures for an export, as the view draws it (ui/paints.js,
// ui/viewer.js PAINT_AT / PAINT_NORMAL): where the part's paint mask says (its gloss map's red), over its
// colours by the overlay blend of xo::applyColorAdjust. One colour; a pattern of textures/patterns tiled
// over the part's second UV set (where the game lays its paints: on most parts 0.69 repeats a metre, one
// set running on unbroken over a whole cabin); or a chameleon's colour ramp, read by the angle the
// surface is seen at - an export is seen from no angle, so it takes the colour the ramp shows on average.
// A pattern's relief (its normal map) goes into the part's normal map the same way, and a metallic or
// chrome finish into its roughness and metalness.
#include <cstdint>
#include <string>
#include <vector>

namespace xo {

struct Paint {
    enum class Kind { Color, Pattern, Chameleon } kind = Kind::Color;
    float color[3] = {1, 1, 1}; // sRGB 0..1: the colour; a pattern's or ramp's tint (white: as it is)
    float amount = 0;           // 0..1 (0: no paint at all)
    std::string tex;            // the pattern's or ramp's texture (game path, no extension)
    std::string normal;         // its relief's ("" none)
    float scale = 1;            // a pattern's repeats per unit of the second UV set
    // how it shines (ui/paints.js FINISHES): as the part does, as a metallic paint, as polished metal
    enum class Finish { None, Metallic, Chrome } finish = Finish::None;
    float finishRough() const { return finish == Finish::Chrome ? 0.08f : 0.32f; } // (where it covers the part)
    float finishMetal() const { return finish == Finish::Chrome ? 1.0f : 0.65f; }
    bool on() const { return amount > 0 && (kind == Kind::Color || !tex.empty()); }
    // laid through the second UV set (its texels differ from part to part)
    bool usesUvs() const { return on() && (kind == Kind::Pattern || !normal.empty()); }
    std::string key() const;    // (two paints with one key make the same images)
    std::string fileTag() const; // what an image painted with it is called after ("camouflage01", "paint")
};

// One piece of a model the paint is laid over: its triangles' corners in the painted texture's UVs (uv0)
// and on the paint (uv1; null: the piece has no second set, and a pattern shows its mean colour there).
struct PaintMesh {
    const float *pos = nullptr;     // xyz per vertex (for the relief's frames)
    const float *uv0 = nullptr;     // uv per vertex
    const float *uv1 = nullptr;     // uv per vertex, or null
    const uint32_t *idx = nullptr;  // three per triangle
    size_t triangles = 0;
};

// An RGBA8 image: a colour texture (sRGB), a gloss map, or a normal map as the export writes them
// (RGB = xyz * 0.5 + 0.5, +Y up the texture).
struct PaintImage {
    const uint8_t *rgba = nullptr;
    uint32_t w = 0, h = 0;
    explicit operator bool() const { return rgba && w && h; }
};

// The paint over an albedo (rgba, w x h, sRGB, its colour edits made) where mask (the gloss map: red;
// any size) says. tex: the pattern or ramp (RGBA8 sRGB); meshes: the pieces that show this albedo
// (a pattern goes over their second set: texels none of them covers take the colour of the nearest one
// that does, the rest the pattern's mean colour).
void applyPaint(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const Paint &p, const PaintImage &mask,
                const PaintImage &tex, const std::vector<PaintMesh> &meshes);

// The paint's relief (relief: its normal map, unpacked) added onto a normal map (rgba, w x h, unpacked)
// where mask says, turned from the second set's frame into the first's triangle by triangle.
void applyPaintRelief(std::vector<uint8_t> &rgba, uint32_t w, uint32_t h, const Paint &p, const PaintImage &mask,
                      const PaintImage &relief, const std::vector<PaintMesh> &meshes);

} // namespace xo
