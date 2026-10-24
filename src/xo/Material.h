#pragma once
// Crossout materials (.mdf, XML), skins (.skins) and model descriptors (.model).
//
// <Materials><Material guid="shader-guid"><Parameter name="DiffuseSampler">models/.../x_a</Parameter>
//   ...</Material>...</Materials>. Mesh words[0] indexes the <Material> list in document order.
// Texture parameter values are game paths without extension (the texture is <path>.tfh/.tfd).
// A .skins file lists "skin <name> <mdf base name>" lines; each skin is another .mdf in the
// same folder (e.g. m_bumper1_skin2.mdf) with the same material order but other textures.
#include <string>
#include <string_view>
#include <vector>

namespace xo {

struct MaterialParam {
    std::string name, type, value;
    int index = -1; // <Parameter name="MaterialLayers" index="3"> (layered map materials)
};

struct Material {
    std::string guid;
    std::vector<MaterialParam> params;
    const MaterialParam *find(std::string_view name) const;
    std::string value(std::string_view name) const;
};

bool parseMdf(std::string_view xml, std::vector<Material> &out, std::string *err);

struct Skin {
    std::string name; // "default", "skin1", ...
    std::string mdf;  // full game path of the .mdf
};
// dir: folder of the .skins file (game path, no trailing '/').
std::vector<Skin> parseSkins(std::string_view text, std::string_view dir);

// Texture role for a sampler parameter name ("albedo", "normal", "gloss", "ao", "detail",
// "colormap", "albedo2" ...), or "" when the parameter is not a texture. With the material's shader
// GUID the roles follow what its slots hold: the two-layer map shaders 62BD5A8E and E611362B keep a
// whole second material in Diffuse2Sampler / DetailSampler / AmbOcclSampler ("albedo2" / "normal2" /
// "gloss2": a normal map and a gloss map, not a detail normal and occlusion). Crossout 2.41's ground
// cover shader 63BA6D0F names its slots _a, _n, _g, _at (albedo, normal, gloss, mask).
std::string textureRole(std::string_view paramName, std::string_view shader = {});

// Parameter values that look like texture paths are normalised: lowercase, '/' separators,
// extension removed. Returns "" when the value is not a path.
std::string textureBase(std::string_view value);

} // namespace xo
