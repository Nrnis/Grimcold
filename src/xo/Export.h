#pragma once
// Model bundles (mesh + materials + skins) and export to glTF 2.0 (.glb / .gltf) and OBJ.
#include "xo/Anim.h"
#include "xo/Image.h"
#include "xo/Material.h"
#include "xo/Model.h"
#include "xo/Paint.h"

#include <array>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace xo {

class GameData;

struct TextureRef {
    std::string role;  // albedo / normal / gloss / ao / detail / colormap / albedo2 / ...
    std::string param; // DiffuseSampler ...
    std::string base;  // game path without extension
    bool exists = false;
};

// A glow shader's look, read from its parameters by loadBundle: the lamp shader F3007363, its twin on
// map props 644D00C3, and layered materials with AdditiveBlend (39E61427, A7516479). The glow is
// d x c x gain, added onto what is behind (or, for 644D00C3 with User4, blended by the two textures'
// alpha), d read through uv0 and c through uv1 (swap: the other way round); see CROSSOUT_FORMATS.md.
struct GlowLook {
    bool on = false;
    bool additive = true;
    std::string d, c;          // texture bases (c empty: plain white)
    bool swap = false;
    float gain = 1;            // intensity / 10 (1 = as bright as other glow maps)
    float scroll[4] = {};      // UV per second: d (xy), c (zw)
    float spin = 0;            // d's UV turned about (0.5, 0.5), degrees per second
    bool twoSided = false;     // pin User2: seen from both sides (garland strings, signs)
};

// A glow material (GlowLook) as an export bakes it. In the game the glow is d x c x intensity, each
// texture on its own UV set (see ui/viewer.js LAMP_SHADER); a file has one texture per slot, so the
// texture that spreads over the piece gives the colour and the other one (a blink timeline, a tint
// picked at one point, plain white) adds its mean colour over the piece. Both on the very same UVs:
// multiplied texel by texel. Filled in by exportScene.
struct LampBake {
    bool on = false;
    bool additive = true;         // false: see-through by the textures' alpha (GlowLook::additive)
    std::string color;            // texture base of the colour (empty: nothing to show)
    std::string other;            // the other texture (product: multiplied in; else its mean is tint)
    bool product = false;
    float tint[4] = {1, 1, 1, 1}; // linear colour and alpha
    float gain = 1;               // intensity / 10 (1 = as bright as other glow maps)
    int uvSet = 0;                // the set the colour is read through (moved to uv0 for the export)
    bool twoSided = false;        // GlowLook::twoSided
};

// A further texture set of a map material that blends several (its textures: roles "albedo2" /
// "normal2" / "gloss2" for the first, "albedo3" ... for the next): where it covers the one shown as
// albedo / normal / gloss is worked out per texel by the view (ui/viewer.js LAYER_FRAG) from its height
// (the gloss map's red channel), the blend parameters and a weight: the layered shader 64177E0A's
// vertex colour or colour map, the two-layer shaders' amount and world-up term. See CROSSOUT_FORMATS.md.
struct MapLayer {
    int index = 1;        // the game's layer number (64177E0A: 1 weighs by red, 2 by green)
    float tiling = 1;     // repeats per UV unit; world-planar: metres per repeat
    int uv = 0;           // 0 = uv0, 1 = uv1, 2 = world-planar (game x / z)
    bool invert = false;  // its height map read upside down (MatkInvBlendMap)
    float blend[4] = {};  // 64177E0A UserParam{k}; 62BD5A8E UserParam0.zw + UserParam1.xy; E611362B contrast in x
};

struct MaterialView {
    std::string guid;
    std::vector<MaterialParam> params;
    std::vector<TextureRef> textures;
    GlowLook glow;
    LampBake lamp;
    bool alphaTest = false; // cut-outs: texels with low albedo alpha are dropped (nets, grates, fences)
    bool blend = false;     // glass shader: see-through by the albedo's alpha (windows, propeller blur)
    bool heat = false;      // weapon heat / charge glow map: dark at rest, lit while the weapon fires
    bool invisible = false; // skins hide geometry by marking material slots Invisible
    float uvScale = 1;      // layered map materials: the first layer's tiling (the two-layer shaders': the base's)
    int uvSet = 0;          // ... and which UV set it uses (1 = the mesh's second set)
    std::vector<MapLayer> layers; // map materials that blend texture sets: the further ones
    int weights = 0;        // 64177E0A: what weighs its layers (1 = vertex colour red / green, 2 = colour map on uv2)
    float emissiveGain = 1; // map props' glow maps: how bright (UserParam1.z; 1 = as bright as other glow maps)
    float detailTiling = 0; // 16B15FE6 with User2: the detail normal map's repeats (UserParam1.x); 0 = none
    bool maskFromGloss = false; // overlays (85F3A2ED) whose albedo has no alpha: where they show is the gloss map's red
    bool foliage = false;   // tree leaves / billboards: the game lights them as a volume, not as flat cards
    bool billboard = false; // a tree's far picture (SpeedTree Type 2): its own planes, wound both ways already
    float color[3] = {1, 1, 1}; // base colour factor (linear): the plain-colour shader DE4D728D keeps it in UserParam0
    const TextureRef *texture(std::string_view role) const;
};

// What a material changes about the mesh it is on: the UV set and tiling of layered map materials
// (applied to uv0; uvs = false leaves the UVs as they are), and leaf normals pointing away from the
// trunk for foliage.
void applyMaterialToMesh(const MaterialView *mv, MeshGeometry &g, bool uvs = true);

struct ModelBundle {
    std::string mdlPath, mdfPath, dir, baseName, skin;
    Model model;
    std::vector<MaterialView> materials; // index = mesh material index
    std::vector<Skin> skins;              // from <base>.skins (may be empty)
    ModelDesc desc;                       // from <base>.model: animation layers (may be empty)
    std::vector<std::string> warnings;
};

// skin: "" or "default" = the model's own .mdf; otherwise a name from the .skins file.
bool loadBundle(const GameData &gd, std::string_view mdlPath, std::string_view skin, ModelBundle &b, std::string *err);

struct ImageRGBA {
    std::vector<uint8_t> rgba;
    uint32_t w = 0, h = 0;
};

// A model the game shows on one of a part's nodes (a launcher's loaded projectiles on its deploy
// points): its origin sits at the node, turned with it.
struct Attachment {
    std::string path, skin; // .mdl game path; "" = the default look
    int node = -1;          // the part's node
    std::vector<std::array<float, 10>> pose; // the pose its meshes are baked in (as ExportOptions::pose)
};

struct ExportOptions {
    enum class Format { GLB, GLTF, OBJ } format = Format::GLB;
    int lod = 0;               // -1 = every LOD as its own object
    std::string skin;          // "" = default
    bool textures = true;      // PNG textures (embedded in .glb)
    bool ddsCopies = false;    // also the untouched game textures as .dds
    bool extraMaps = false;    // also gloss map + ambient occlusion as separate PNGs
    bool splitMaterials = true; // glTF: a mesh per material, children of the part's node (Cinema 4D's import
                               // drops a mesh with several materials and normals: the part went missing)
    bool occlusion = false;    // a part's baked ambient occlusion as its material's occlusion map (engines darken
                               // only ambient light with it; Cinema 4D makes it Redshift's Overall Tint: the whole
                               // part much darker, the game's AO being dark; Blender does not render it)
    bool slots = false;        // empties at the weld points (build-grid attachment points) and the model's nodes:
                               // for modding and rigging (a cabin has 150 or more; in Blender they clutter the view)
    bool vertexColors = false;
    bool tangents = true;
    bool animations = false;   // one part as glTF: its skeleton, the moving meshes skinned to it, and every animation clip
                               // of its .model (activities like FIRE / IDLE, and the pose sweeps: turret yaw, steering ...)
    float heat = 0;            // how strongly heat-glow maps glow (0 = at rest, as in the garage; 1 = overheated)
    int maxTextureSize = 0;    // 0 = full size; else the largest mip whose sides fit (maps hold hundreds of textures)
    std::map<std::string, ColorAdjust> adjust;                     // key: albedo texture base
    std::map<std::string, std::shared_ptr<const ImageRGBA>> replace; // key: texture base
    std::string name;          // one part: the name of the file's top node (its in-game name); "" = the model's file name
    std::string gameVersion;   // the Crossout version the files came from (written into the file's asset info)
    // One part: the pose the 3D Viewer shows, per model node its local translation (3), rotation
    // quaternion x y z w (4) and scale (3) under its parent, in glTF space. A static export bakes it
    // into the meshes; with animations it is the skeleton's starting pose. Empty = the bind pose (on
    // 50 of the 264 animated weapons it is more than 1 cm off what the viewer shows: a mortar's barrel stands straight up).
    std::vector<std::array<float, 10>> pose;
    // One part: models shown on its nodes. A static export places them where the pose puts their
    // nodes; with the skeleton they hang under their joints, so the clips carry them.
    std::vector<Attachment> attachments;
    // One part: its paint (the 3D Viewer's), as SceneItem::paint.
    Paint paint;
    bool hasPaint = false;
};

using Progress = std::function<void(double fraction, const std::string &stage)>;

bool exportModel(const GameData &gd, const std::string &mdlPath, const std::filesystem::path &outFile, const ExportOptions &opt,
                 std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress = {});

// One placed part of a build: which model, which skin, where (glTF space, column-major).
struct SceneItem {
    std::string path;  // .mdl game path
    std::string skin;  // "" = default look
    std::string name;  // node name ("" = the model's name)
    std::string group; // "" = directly under the root; else a group node of that name (maps: props, trees ...)
    int lod = -1;      // -1 = opt.lod
    float matrix[16]{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    std::vector<std::array<float, 10>> pose; // the pose its meshes are baked in (as ExportOptions::pose); empty = the bind pose
    // Its own paint (the builder's: a part's, or the vehicle's), baked into its textures where their paint
    // mask says; it takes the place of the paint the textures' colour edits have (amount 0: none at all).
    Paint paint;
    bool hasPaint = false;
};

// Geometry the exporter makes itself (a map's terrain, water and decals), already in glTF space.
struct CustomMesh {
    std::string name, group;
    MeshGeometry g;                           // position, normal, uv0 (optional), color (optional: COLOR_0), indices
    std::string material;                     // meshes with the same material name share one material
    std::shared_ptr<const ImageRGBA> albedo;  // base colour texture (optional; its alpha counts with blend)
    std::string albedoName;                   // its file name ("terrain_ground.png")
    std::shared_ptr<const ImageRGBA> normal;  // tangent-space normal map (optional; glTF's +Y-up convention)
    std::string normalName;
    float normalScale = 1;
    std::shared_ptr<const ImageRGBA> metalRough; // glTF's packing (optional): occlusion R, roughness G, metal B (glTF only)
    std::string metalRoughName;
    float color[4]{1, 1, 1, 1};               // base colour factor (alpha < 1 with blend)
    float roughness = 1, metallic = 0;
    bool blend = false, doubleSided = false;
    // see-through like water (KHR_materials_transmission, _ior, _volume; 0 = not): how much light goes
    // through, its index of refraction, how thick the body is taken to be and how far light gets in it
    // before only attenuationColor is left of it (metres). glTF then leaves color white (it would tint
    // all light through it); OBJ, which knows none of this, draws color see-through by its dissolve.
    float transmission = 0, ior = 1.5f, thickness = 0, attenuationDistance = 0;
    float attenuationColor[3]{1, 1, 1};
};

// Many copies of one model (a map's grass): its mesh is written once and the copies are placed with
// EXT_mesh_gpu_instancing (glTF; OBJ leaves them out).
struct InstancedItem {
    std::string path, skin, name, group;
    int lod = 0;
    bool grass = false;       // grass blades (pieces without tangents: stones and debris have them and stay as they are)
                              // are seen from both sides, lit by their own up-tilted normals, brightened and tinted
    float gain = 1;           // the blades' albedo brightness (linear factor, baked into a copy of the texture)
    std::vector<float> trs;   // per copy, glTF space: translation xyz, rotation quaternion xyzw, uniform scale (8 floats)
    std::vector<float> color; // per copy: the blades' tint, linear r g b (_COLOR_0; empty = none)
};

// A directional light (KHR_lights_punctual), such as a map's sun.
struct SceneLight {
    std::string name = "sun";
    float direction[3]{0, -1, 0}; // the way the light travels (glTF space, unit length)
    float color[3]{1, 1, 1};      // linear
    float intensity = 3;          // lux (Blender reads a sun's as W/m²)
    float position[3]{};          // where its node sits (a directional light shines the same everywhere)
};

// What else a scene export carries (map exports).
struct SceneExtras {
    std::vector<InstancedItem> instanced;
    std::vector<SceneLight> lights;
    std::vector<std::pair<std::filesystem::path, std::vector<uint8_t>>> files; // written with the export (all or nothing)
    std::vector<std::pair<std::string, std::string>> info;                     // added to the file's asset extras
};

// Exports several placed parts as one file. Meshes are written once per model and LOD and
// shared by every part that uses them; parts with the same texture set share materials. A
// mirrored part (negative scale) gets a mirrored copy of its mesh, so no node is scaled negatively.
// .gltf/.obj textures (and DDS copies / extra maps) go in <stem>_textures\ beside the file.
// opt.skin is ignored (each item has its own); opt.slots, name and pose only apply to single-part exports.
bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::string &sceneName, const std::filesystem::path &outFile,
                 const ExportOptions &opt, std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress = {});
// The same with extra meshes of the exporter's own (a map's terrain, water).
bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::vector<CustomMesh> &custom, const std::string &sceneName,
                 const std::filesystem::path &outFile, const ExportOptions &opt, std::vector<std::filesystem::path> &written,
                 std::vector<std::string> &warnings, std::string *err, const Progress &progress = {});
// ... and instanced copies, lights, files beside it.
bool exportScene(const GameData &gd, const std::vector<SceneItem> &items, const std::vector<CustomMesh> &custom, const SceneExtras &extras,
                 const std::string &sceneName, const std::filesystem::path &outFile, const ExportOptions &opt,
                 std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
                 const Progress &progress = {});

// Binary geometry for the viewer: "XOGM", u32 jsonLength, JSON, padding to 4, then the arrays
// the JSON points at (byte offsets relative to the data start). lod -1 = all LODs. raw: the UVs as
// the mesh stores them (the view tiles them per material and layer itself), with the third set, and
// vertex colours only where a material weighs its layers by them.
bool packGeometry(const ModelBundle &b, int lod, std::vector<uint8_t> &out, std::string *err, bool raw = false);

// Makes a string safe as a Windows file name (keeps letters, digits, - _ .).
std::string safeFileName(std::string_view s);

// ASCII name for the files an export writes beside the main file (.bin, .mtl, <stem>_textures):
// the file's stem when it is plain ASCII, else the ASCII part plus a hash of the full name.
std::string companionStem(const std::filesystem::path &file);

} // namespace xo
