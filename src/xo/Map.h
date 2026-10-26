#pragma once
// Crossout maps: levels/maps/<name>/ in the readable archives (see CROSSOUT_FORMATS.md, "Maps").
//
//  landscape/landscape.mxml   size (SectorsX/Z x 16 cells of CellSize metres), height range, the
//                             surface presets (assets/surfaces.mxml) by index
//  landscape/heightmap.dat    "TDNL" tile file: 32 x 32 float heights per tile, zstd
//  landscape/splatmap.dat     per surface texel: three 5-bit surface indices (u16)
//  landscape/weightmap.dat    per surface texel: two blend weights (BC5)
//  props.mxml                 static props: assets/props/<Name>.mdl at PosHex / YPRHex / ScaleHex
//  scene.mxml, scene_generated.mxml   entities by game definition (Def); the definitions live in
//                             the encrypted packs, so their models are found by name (resolveEntityModel)
//
// Space is the game's (left-handed, Y up, metres); the terrain is centred on the origin.
#include "xo/Export.h"

#include <array>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <vector>

namespace xo {

class GameData;

// A surface's second texture set (surfaces.mxml <Additional>): mostly the same textures at another
// scale, turned and / or mirrored, mixed with the first by a tiling noise (hides the repeats).
struct SurfaceDetail {
    std::string albedo, normal, gloss; // texture bases ("" = no second set)
    float tiling = 8, heightMid = 0.5f;
    int rotation = 0;
    bool flip = false;
    // the mix: noise (BlendNoiseTexture red) every noiseTiling metres, remapped from in to out
    float noiseTiling = 1, noiseIn[2]{0, 1}, noiseOut[2]{0, 1};
};

struct TerrainSurface {
    uint32_t presetId = 0;
    std::string name;                  // "midland_surfaces/grass"
    std::string albedo, normal, gloss; // texture bases ("" = none)
    float tiling = 8;                  // metres per repeat of the textures
    int rotation = 0;                  // quarter turns of the textures (UVRotation)
    bool flip = false;                 // mirrored (UVFlip)
    std::string physMaterial;          // what it is to the physics ("Snow_Base", "Ground_Base")
    // Height blending: where surfaces meet, the one whose height (the gloss map's red) stands higher
    // over its heightMid shows, more sharply the higher blendRoughness (0 = a plain cross-fade).
    float blendRoughness = 0, heightMid = 0.5f;
    float heightAmp = 0;               // relief in metres (HeightAmplitude: the game displaces the ground by it)
    bool invertBlend = false;          // the height map counts down
    bool flatHeight = false;           // its height map is one value (blended as if at heightMid)
    std::string standIn;               // the preset whose textures stand in for missing ones ("" = its own)
    SurfaceDetail detail;
};

struct Terrain {
    int cellsX = 0, cellsZ = 0;     // heights: (cellsX + 1) x (cellsZ + 1) samples, row = z
    float cellSize = 0;             // metres
    int texelsPerCell = 0;          // surface map resolution
    bool overVertices = false;      // its texels sit on the vertices (SurfaceMapOverVertices: 2.41 on), not mid-cell
    float minY = 0, maxY = 0;
    int sliceSize = 2048;           // the game's surface texture size (Renderer TextureArraySliceSize)
    bool heightBlend = true;        // Renderer LandscapeHeightBlendEnabled
    std::string blendNoise;         // Renderer BlendNoiseTexture (the detail sets' mix)
    std::vector<float> height;
    std::vector<uint16_t> surfIndex; // texelsX x texelsZ: surfaces low | mid << 5 | high << 10
    std::vector<uint8_t> surfWeight; // texelsX x texelsZ x 2 (r, g): low = r, mid = (1 - r) g, high = (1 - r)(1 - g)
                                     // (2.41's maps store 255 - r, 255 - g: flipped as they load)
    std::vector<TerrainSurface> surfaces;

    int samplesX() const { return cellsX + 1; }
    int samplesZ() const { return cellsZ + 1; }
    int texelsX() const { return cellsX * texelsPerCell; }
    int texelsZ() const { return cellsZ * texelsPerCell; }
    float sizeX() const { return cellsX * cellSize; }
    float sizeZ() const { return cellsZ * cellSize; }
    float x0() const { return -sizeX() * 0.5f; } // world x of sample column 0
    float z0() const { return -sizeZ() * 0.5f; } // world z of sample row 0
    float heightAt(float x, float z) const;      // bilinear; clamped at the edges
    // where surface texel i sits, in texels from the map's edge: i + this (mid-cell 0.5, on the vertices 0)
    float texelOffset() const { return overVertices ? 0.0f : 0.5f; }
};

struct MapObject {
    std::string model;  // .mdl game path
    std::string skin;   // "" = default
    std::string name;   // as the map names it
    std::string def;    // entities: their game definition ("" = a prop from props.mxml)
    std::string group;  // "props", "trees", "objects"
    float pos[3]{}, ypr[3]{}, scale[3]{1, 1, 1}; // game space; degrees
    // Its id: the file it comes from (props.mxml 0, scene.mxml 1, scene_generated.mxml 2, props_generated.mxml 3) << 24 | its
    // place among that file's instances / entities. The same whichever mode, festival or kinds are
    // loaded (a place in the filtered list was not: another mode hid and exported other objects).
    uint32_t uid = 0;
};

// A water surface (Helpers_WaterVolume) or a pool of acid (Helpers_AcidVolume): level at the
// entity's height inside its outline (turned with the entity), and how the game's water shader draws
// it (its legacy shader's settings; the newer layered one's as written, see CROSSOUT_FORMATS.md "Water").
struct MapWater {
    std::string name;
    bool acid = false;                         // Helpers_AcidVolume (it burns in the game)
    int type = 0;                              // waterType: 0 water, 1 acid (no light gets through), 2 rusty (rust-coloured water)
    float level = 0;                           // world y of the surface
    std::vector<std::array<float, 2>> outline; // world x, z
    uint8_t color[3]{52, 51, 50};              // what the water scatters (sRGB): its colour where it is deep
    float density = 1;                         // per metre: of what lies under it, exp(-density x metres seen through) shows
    float depth = 1;
    // the two layers of waves: tiling (times the view's base tile), scroll speed (tiles per second),
    // direction (degrees) and strength; layer 0 carries the animated frames
    float uvTiling[2]{1, 1}, uvSpeed[2]{}, bumpDir[2]{}, bumpHeight[2]{1, 1};
    float noiseTiling = 1;
    // Crossout 2.41's water: each layer's flipbook rate (frames a second; the legacy volumes' 15); the
    // second layer's own frames (its flow waves; empty on legacy volumes), carried by the weather's wind
    // times windMul and by the map's currents (MapScene::waterFlowMap) at `current` of its tiles a
    // second where the current is full (0: not)
    float fps[2]{15, 15}, windMul = 0, current = 0;
    std::string flowFrames;
    int user2 = 0, user3 = 0;                  // user3 = 1: calm water (its frames are flat)
    std::string frames;                        // folder of the wave animation's 64 frames (01 .. 64)
    std::string detail[2], colorMap;           // the layers' normal maps, the noise over them (texture bases)
    std::vector<std::pair<std::string, std::string>> layered; // the layered shader's settings and textures, on the volumes that have its textures
};

// Which of the map's objects to take. Entities can be limited to game modes, festivals and
// environments (weather / time of day); the defaults give the everyday look.
struct MapFilter {
    std::string gameplay = "auto";    // "" = every mode's objects, "auto" = the map's main mode (MapScene::gameplay)
    std::string festival = "Empty";   // "Empty" = no festival, "" = every festival's decorations
    std::string environment;          // envsettings Item Id; "" = the map's first one used without a festival
    bool props = true, entities = true, trees = true, water = true, decals = true;
};

// Where players start (game space): Gameplay_SpawnSpotTeam1 / 2 and the like.
struct MapSpawn {
    std::string def;
    int team = 0; // 1, 2, or 0 when the spot is not a team's
    float pos[3]{}, yaw = 0;
};

// A projected decal (NewDecal entity): a box at pos / ypr whose texture is projected along its
// local Y onto the terrain and / or the static objects inside it (game space, degrees).
struct MapDecal {
    std::string name;
    uint32_t preset = 0;               // assets/decals.mxml preset id
    float pos[3]{}, ypr[3]{}, scale[3]{1, 1, 1};
    float opacity = 1, sharpness = 0.5f, height = 1;
    bool customColor = false;
    uint8_t color[3]{255, 255, 255};   // customUniformAlbedo (sRGB) when customColor
    bool onLandscape = true, onStatic = false;
    int layer = 0, sublayer = 0;       // the order decals are laid in: a higher one on top
    bool customGlow = false, customGlowEv = false;
    uint8_t glowColor[3]{0, 0, 0};     // customUniformGlow (sRGB) when customGlow
    float glowEv = 0;                  // customGlowEV100 when customGlowEv
};

// A decal preset: the textures (an atlas rectangle of them) and how it blends.
struct DecalPreset {
    uint32_t id = 0;
    std::string name;
    std::string albedo, normal, spec;  // texture bases ("" = none: then the uniform colour)
    float albedoRect[4]{0, 0, 1, 1}, normalRect[4]{0, 0, 1, 1}; // u, v, width, height in the textures
    uint8_t uniform[3]{255, 255, 255}; // UniformAlbedo (sRGB)
    float size = 1, thickness = 1;     // DefaultSize (metres across), DefaultThickness (projection depth)
    float zFade = 0.4f, angleFade = 0.2f;
    float albedoOpacity = 1;
    bool fadeByNormal = true;
    bool onStatic = true, onLandscape = true; // DrawMask: what it may lie on at all (and the decal's own drawOn... too)
    float gloss = 0, metal = 0;        // UniformGloss, UniformMetalness (with a spec map: its red is the gloss, its green the metal)
    float normalOpacity = 1;           // how much of its relief shows
    bool glow = false, glowFromAlbedo = false; // UseGlow: UniformGlow at GlowLuminance; UseGlowColorFromAlbedo: tinted by the albedo
    uint8_t glowColor[3]{0, 0, 0};     // UniformGlow (sRGB)
    float glowEv = 0;                  // GlowLuminance (EV100)
};

// A sound the map plays where it stands (Sound_AmbientSoundSpot: a fire, a windmill, crickets, rain on
// a roof) or along a line (Sound_SplineSound: a river, a marsh; heard from its nearest point), by the
// game's FMOD event name. Scripted ones (start_silent: a bomb going off on cue) are left out.
struct MapSound {
    std::string event;                      // "event:/ambient/soundspot/wreck_fire_large"
    float pos[3]{};                         // game space
    std::vector<std::array<float, 3>> line; // a spline's points (game space), else empty
};

// An effect the map plays where it stands (EffectEntity with isPlayed="1": fires, burning tyres,
// torches, smoke columns, steam, an antenna's signal), in game space; scale: its env_scale.
struct MapEffect {
    std::string effect;       // "particles/levels/fire/fire_on_ground" (a .psys)
    float pos[3]{}, ypr[3]{}; // game space, degrees
    float scale = 1;
};

// A box where the weather's effect changes (EffectZone_Area): its own area and screen effects inside,
// and whether the environment's (the rain, the snow) stops in it (under a bridge, in a tunnel).
struct MapArea {
    std::string effect, screen;
    bool stopsWeather = false;              // turnOffGlobalEffect="1"
    float pos[3]{}, ypr[3]{}, size[3]{1, 1, 1}; // game space; size: ScaleHex, the box's edges
};

// A light the map places (Lights_ entities), in game space: it shines along its local +Z.
//  - point: Lights_PointLight and its kin (HugeLight, FlameGoal, the flickering ones): a power and a
//    radius it reaches
//  - projector: Lights_Projector, a spot light: opening angles across and up, how far it reaches
//  - flare: Lights_Flare, the glow of a lamp's bulb or glass: a luminance, a size, how soft it is
//    (nebulosity) and the angle around +Z it shows in (vis_angle)
//  - beam: Lights_Beam, a lamp's light seen in the air: a cone size metres long, width across
// Lights switched off (isTurnedOn="0", start_disabled="1"), the storms' lightning flashes and the
// directional ones (light through a hangar's windows) are left out.
struct MapLight {
    enum Kind { Point, Projector, Flare, Beam } kind = Point;
    float pos[3]{}, ypr[3]{};          // game space, degrees
    uint8_t color[3]{255, 255, 255};   // sRGB
    float power = 1;                   // point, projector: how strong (the game's units of light)
    float radius = 1;                  // point: how far it reaches (metres)
    float fov[2]{30, 30};              // projector: opening angles across (X) and up (Y), degrees
    float farClip = 10;                // projector: where its light ends along +Z (metres: farClipPlane)
    float nearClip = 0;                // projector: its nearClipPlane (metres; what is nearer casts no shadow)
    bool linearFalloff = false;        // point, projector: as strong anywhere within its reach (fading out at the end), not power / distance²
    // point, projector: what stands in its way keeps its light off what is behind (shadowsEnabled: a
    // shadow map, or enableSSCS: the game's screen-space contact shadows; 93 % of the point lights and
    // 81 % of the projectors have one or the other); without either it shines through walls in the game too
    bool shadows = false;
    bool specular = true;              // point, projector: shines on gloss (specularEnabled; off on 79 % of the point lights)
    float luminance = 0;               // flare, beam: luminanceEv100
    float size = 1, width = 1;         // flare: its size; beam: its length and width (metres)
    float nebulosity = 0, visAngle = 90; // flare: softness 0..1; the angle it shows in (degrees)
    bool flicker = false;              // flickering kinds (Lights_*Flicker*), beams with a flicker pattern
};

// One of the map's environments (envsettings.mxml Item: weather and time of day), for picking.
struct MapEnvChoice {
    std::string id, name;              // "664236", "_midland/day_clear_al120_az330"
    std::vector<std::string> festivals; // where it is used ("Empty" = every day; none listed = any)
    bool modeOk = true;                 // usable in the mode the scene was read for
};

struct MapScene {
    std::string name;
    bool hasTerrain = false;
    Terrain terrain;
    std::vector<MapObject> objects;
    std::vector<MapWater> water;              // water and acid
    std::vector<MapSpawn> spawns;
    std::vector<MapDecal> decals;
    std::vector<MapSound> sounds;
    std::vector<MapEffect> effects;           // what burns, smokes and steams on the map
    std::vector<MapArea> areas;               // where the weather's effect changes
    std::vector<MapLight> lights;             // its lamps, fires' light, projectors, flares and beams
    // the soundscape the environment plays all over the map (its ambience): soundscapes.xml's event for
    // the tag of the Sound_SoundZone that names the environment ("" = none)
    std::string soundscape;
    std::string environment;                  // the environment the filter used
    // Crossout 2.41: the rivers' currents (settings.mxml <Water FlowMapTexture>: x in alpha, z in green,
    // over the terrain's square, its rows running -z; "" = none)
    std::string waterFlowMap;
    std::vector<MapEnvChoice> environments;   // every environment the map has (envsettings.mxml)
    std::map<std::string, int> unresolved;    // entity definitions with no model found -> count
    int filteredOut = 0;                      // entities of other modes / festivals / environments
    std::set<std::string> gameplays, festivals; // every mode / festival the map's entities name (what the filter can pick)
    std::string gameplay;                     // the mode the filter used ("auto" resolved: Assault where the map has it)
    std::vector<std::string> warnings;
};

// Map folder names (levels/maps/<name>/ with props, entities or a terrain).
std::vector<std::string> listMaps(const GameData &gd);

// What the map list shows, read cheaply (landscape.mxml only).
struct MapSummary {
    std::string name;
    bool terrain = false;
    float sizeX = 0, sizeZ = 0; // metres
    std::string picture;        // the loading-screen texture (ui/textures/levels/level_<name>), "" if none
    std::string hudmap;         // the game's minimap of it (levels/maps/<name>/hudmaps/hudmap_<id>), "" if none
};
std::vector<MapSummary> listMapSummaries(const GameData &gd);

bool loadMap(const GameData &gd, const std::string &name, const MapFilter &filter, MapScene &scene, std::string *err);

// The model of an entity definition ("Breakable_Trees_Midland_SpruceSmall" ->
// assets/props/trees/midland/spruce/spruce_small.mdl), or "" when no model matches its name.
std::string resolveEntityModel(const GameData &gd, const std::string &def);

// Game-space placement -> glTF node matrix (column-major, Z mirrored like the models).
void mapObjectMatrix(const MapObject &o, float out[16]);

struct MapExportOptions {
    int groundTexture = 4096; // baked ground colour, pixels per side (0 = untextured terrain)
    int terrainStep = 0;      // 0 = auto (at most 1024 quads per side), else every Nth height sample
    int treeLod = -1;         // -1 = the export's LOD
    bool decals = true;       // the decals: meshes on what they lie on, their look baked into textures
    float grass = 0;          // share of the grass tufts (0 = none, 1 = all), taken in the game's own thinning order
    bool sun = true;          // the environment's sun as a light (glTF)
    int sky = 2048;           // the sky as an equirectangular <stem>_sky.hdr beside the file, this wide (0 = none)
    bool clouds = true;       // ... with the sky dome's clouds
    bool probeSky = true;     // ... the game's light probe of the map instead, when the environment has one
};

// How strongly the surfaces' heights decide where they meet: weight x 2^(terrainHeightBlend x
// BlendRoughness x (height - HeightMid)), on maps that blend by height. (The game's formula is in its
// encrypted shaders: this is a plain height blend driven by its data; of 0, 0.5, 1 and 2, 1 looked
// most like its loading pictures. The view gets it from /mapsplat.)
inline constexpr float terrainHeightBlend = 1.0f;

// Bakes the terrain's ground colour from its surfaces (indices + weights + tiled albedos, blended by
// height like the view). size x size pixels over the whole terrain, top row = the +Z edge (glTF: -Z),
// like a map seen from above. normal / metalRough (optional) get the surfaces' relief as a tangent-space
// normal map (+X = +x, +Y = up the picture, the game's +Z) and their occlusion, roughness and metal in
// red, green and blue (glTF's packing) at the same size.
bool bakeGround(const GameData &gd, const Terrain &t, int size, ImageRGBA &out, std::vector<std::string> &warnings, std::string *err,
                const Progress &progress = {}, ImageRGBA *normal = nullptr, ImageRGBA *metalRough = nullptr);

// The light the terrain's own hills leave each height sample (every step-th, row 0 = the game's z0
// edge): how much of the sun's disc is in sight (marching towards it, soft over the sun's size and a
// degree more) and how much of the sky (cosine-weighted above the horizon, 8 directions out to 300 m,
// smoothed over 5 x 5 samples).
// sun: towards the sun (glTF space).
struct TerrainLight {
    int w = 0, h = 0, step = 1;
    std::vector<uint8_t> rg; // per sample: sun, sky (0..255)
};
TerrainLight bakeTerrainLight(const Terrain &t, int step, const float sun[3]);

bool exportMap(const GameData &gd, const MapScene &scene, const std::filesystem::path &outFile, const ExportOptions &opt,
               const MapExportOptions &mo, std::vector<std::filesystem::path> &written, std::vector<std::string> &warnings, std::string *err,
               const Progress &progress = {});

// ---- environment: sky, sun, fog ----------------------------------------------------------------
// The environment item the map uses (envsettings.mxml Item Id = an assets/envsettings.mxml preset):
// sun colour / direction (SunDirVert: 90 = horizon, 180 = zenith; SunDirHor: degrees), fog,
// exposure, the sky dome model (cloud layers) and the AtmosphereId of its sky.
struct MapEnvironment {
    std::string id, name, map;
    float rotation[3]{};                                     // the map item's RotHex (degrees)
    std::vector<std::pair<std::string, std::string>> values; // every <Setting value="..."/> of the preset
    std::string value(std::string_view key) const;
};
bool loadEnvironment(const GameData &gd, const std::string &map, const std::string &id, MapEnvironment &env, std::string *err);

// The game's own light for one environment of a map (levels/maps/<map>/light_probes/<envId>.xml):
// HDR captures of the map from a point (sky, clouds, ground, props, water; not the sun's disc), in
// game light units / 16. Each LightProbe has a specular cube (256 px, 9 mips prefiltered for
// roughness) and a diffuse one (32 px: Lambert irradiance / pi of the same). The global probe lights
// the map (the one envsettings.mxml names, GlobalLightProbeID); hangars and tunnels add a local one
// with a box (HalfExtendsMin/Max; 1 1 1 / 2 2 2 on the global one).
struct LightProbe {
    std::string id;                  // ProbeID
    std::string specular, diffuse;   // the cube maps (.tfh/.tfd bases; R11G11B10F, faces +X -X +Y -Y +Z -Z in game space)
    float center[3]{};               // game space
    float rotation[3]{};             // degrees
    float halfMin[3]{}, halfMax[3]{};
    float envColor[3]{};
    bool global = false;
};
struct MapProbes {
    std::string inscattering;        // FogLightingProbe: the sky alone, with the sun's disc (the fog's colour)
    std::vector<LightProbe> probes;  // the global one first
};
bool loadLightProbes(const GameData &gd, const std::string &map, const std::string &envId, MapProbes &out, std::string *err);

// A precomputed atmosphere (Eric Bruneton's "Precomputed Atmospheric Scattering", 2017), as the game
// ships it in levels/atmospheres/<name>/: transmittance (256 x 64 RGBA32F), irradiance (64 x 16
// RGBA32F), scattering (256 x 128 x 32 RGBA16F; single Mie scattering's red in alpha), and the
// model's constants (atmosphere.xml <Uniforms>: radii, phase g, mu_s_min, sun size, ...).
struct Atmosphere {
    std::string guid, dir;
    std::vector<std::pair<std::string, std::string>> uniforms;
    std::vector<uint8_t> transmittance, irradiance, scattering; // raw texel data, rows from v = 0
};
bool loadAtmosphere(const GameData &gd, const std::string &guid, Atmosphere &a, std::string *err);
// float -> half (round to nearest; the atmospheres' tables and the light probes stay far inside its range)
uint16_t floatToHalf(float f);

// ---- grass ---------------------------------------------------------------------------------------
// levels/maps/<map>/grass.dat: the game's grass, generated in advance (see CROSSOUT_FORMATS.md):
// per 32 m cell and grass type, instances with position, rotation and size.
struct GrassType {
    uint32_t preset = 0;
    std::string name, model;           // assets/grass.mxml: "midland_old/basegrass01", its .mdl
    float distFactor = 0.3f;           // how far out it is drawn (relative)
    float wind = 0, luminance = 10;
    float cloak = 0.5f;                // cloaking_range_max: the share of its reach over which it thins out
    bool alignToNormal = true;
};
struct GrassInstance {
    float pos[3]{};                    // game space
    float rot[4]{0, 0, 0, 1};          // quaternion (x, y, z, w), game space
    float scale = 1;
    float rank = 0;                    // 0..1 within its cell: the game thins grass out by it
};
struct GrassCell {
    int cell = 0, type = 0;            // cell = row * gridX + column
    uint32_t first = 0, count = 0;     // into MapGrass::items
    float minY = 0, maxY = 0;
};
struct MapGrass {
    int gridX = 0, gridZ = 0;
    float cellSize = 0, x0 = 0, z0 = 0; // cell (0, 0) starts at game (x0, z0)
    std::vector<GrassType> types;
    std::vector<GrassCell> cells;
    std::vector<GrassInstance> items;
};
bool loadGrass(const GameData &gd, const std::string &map, MapGrass &g, std::string *err);
// glTF node matrix of a grass instance (column-major, Z mirrored like the models)
void grassMatrix(const GrassInstance &g, float out[16]);
// The tint the grass takes from the ground it stands on (the map's grass colour maps, grasslms; see
// CROSSOUT_FORMATS.md): per item linear r g b, 1 = its own colour. false (all 1) without a colour map.
bool grassTints(const GameData &gd, const std::string &map, const MapGrass &g, std::vector<float> &rgb, std::string *err);

// ---- decals --------------------------------------------------------------------------------------
std::map<uint32_t, DecalPreset> readDecalPresets(const GameData &gd);

// A decal projected onto what lies in its box: glTF space, uv = the textures' coordinates (inside the
// preset's rectangle), fade = how much of the decal shows there (box ends, steep surfaces).
// One mesh per surface a decal lies on: the terrain, and each object in turn (so a view can hide a
// decal's share on an object with the object).
struct DecalMesh {
    int decal = -1;  // index into MapScene::decals
    int object = -1; // the object it lies on (index into MapScene::objects); -1 = the terrain
    std::vector<float> position, normal, uv, fade;
    std::vector<uint32_t> indices;
};
// terrainStep: the height samples the terrain is drawn with (0 = auto, as /mapterrain and the export).
// At most maxTriangles in all (kDecalTriangles: what a view takes; zombie_escape_3's volume decals made
// 13.9 million, every other map stays under it): over it whole kinds of pieces are left out in turn
// (decalRank), with a warning.
constexpr size_t kDecalTriangles = 3500000;
bool buildDecalMeshes(const GameData &gd, const MapScene &scene, const std::map<uint32_t, DecalPreset> &presets, int terrainStep,
                      std::vector<DecalMesh> &out, std::vector<std::string> &warnings, size_t maxTriangles = kDecalTriangles);
// The order a decal's pieces are left out in over the limit: 0 a volume preset's (UseFadeByNormal
// false: it paints every face in its box) on an object, 1 a volume preset's on the ground, 2 any
// other on an object, 3 any other on the ground.
inline int decalRank(const DecalPreset *preset, const DecalMesh &m) {
    const bool volume = preset && !preset->fadeByNormal, onObject = m.object >= 0;
    return volume && onObject ? 0 : volume ? 1 : onObject ? 2 : 3;
}

} // namespace xo
