#pragma once
// The game's sky for exports, worked out on the CPU the way the view draws it (ui/sky.js): Eric
// Bruneton's precomputed atmosphere over the game's own tables, the sun, and the sky dome's clouds.
#include "xo/Map.h"

#include <string>
#include <vector>

namespace xo {

class GameData;

// Game light units per light-probe unit: the probes store radiance / 16 (measured three ways, 14-21:
// sunlit and shaded snow, the clear sky against the atmosphere, the presets' exposure ranges).
constexpr double kProbeUnit = 16;
// The sun as the probes' own captures show it: their sunlit ground has kSunK of the preset's sun at
// kProbeUnit on it, against their own light from all around (ui/sky.js SUN_K: the median over bare sand,
// rock and snow at the probe centres of 13 day, sunset and night presets).
constexpr double kSunK = 0.82;

struct SkyLight {
    float sun[3]{0, 1, 0};   // towards the sun (glTF space)
    float color[3]{1, 1, 1}; // the sun's colour (linear, brightest channel 1)
    float intensity = 2.7f;  // the view's key light (glTF lux; Blender reads a sun's as W/m²)
    float horizon[3]{};      // the sky just above the horizon as the view shows it (linear): the haze's colour
    float fogDensity = 0;    // the fog (ui/fog.js presetFog): per metre (base 2) at fogHeight ...
    float fogHeight = 0;     // ... an altitude (m), halving every fogHalving m up
    float fogHalving = 100;
    float fogStart = 0;      // none nearer than this (m)
    float fogAerialGain = 0; // the air's own haze over this x the distance ...
    float fogAirSun = 1;     // ... its light x this: the preset's sun against the air's own (at most 1)
    float exposure = 1;      // the game's exposure for it: light-probe units -> these (the sun's, the sky's)
    float ev100 = 0;         // ... its EV100 (before ExposureCompensation)
};

// An environment's sun, sky and haze, in the game's units of light at its exposure (as the view has
// them before its tone curve). width: of the sky panorama (0 = only the light); it is width x width /
// 2, linear RGB floats, top row straight up, without the sun's disc (the sun is a light of its own):
// with probeSky the game's own light probe (its HDR capture of the map: sky, clouds, haze, the land
// around) when the environment has one, else the sky worked out from its atmosphere. clouds: the sky
// dome model's cloud cards (and stars at night) drawn into it. The panorama is mapped the way
// Blender's Environment Texture and three.js read equirectangular images: the centre column looks
// along glTF +X, the column a quarter of the width to its left along glTF -Z, so it lines up with an
// exported map.
bool renderSky(const GameData &gd, const MapEnvironment &env, int width, bool clouds, SkyLight &light, std::vector<float> &rgb,
               std::vector<std::string> &warnings, std::string *err, bool probeSky = true);

// Crossout 2.41's skies with no picture of them (BackdropPath kAirSky + ":<map>:<environment>": lit by a
// SkyAtmosphere entity) worked out from their air's numbers (SkyAtmosphere, SkyAtmosphereSun: Map.cpp),
// laid out as a sky picture is (Sky.cpp Backdrop): width x width / 4, the top row straight up, elevation
// linear in the rows, column 0 towards the sun's azimuth; light-probe units, held to the environment's
// capture by colour (gains: what by, 1 1 1 without one). kNoSky: no sky at all (black).
inline constexpr char kAirSky[] = "@air";
inline constexpr char kNoSky[] = "@none";
bool renderAirSky(const GameData &gd, const MapEnvironment &env, int width, std::vector<float> &rgb, std::string *err, double *gains = nullptr);

// A cube map (a light probe) as linear RGB floats: 6 faces of size x size in D3D order (+X -X +Y -Y
// +Z -Z, game space: glTF with z mirrored), rows top-down.
struct CubeMap {
    int size = 0;
    std::vector<float> rgb;
    // the colour towards a glTF direction (bilinear within its face)
    void sample(double x, double y, double z, float out[3]) const;
};
// One mip level of a cube texture (0 = the largest).
bool loadCubeMap(const GameData &gd, const std::string &base, int level, CubeMap &out, std::string *err);
// As a panorama laid out like renderSky's: width x width / 2, top row straight up.
void cubePanorama(const CubeMap &c, int width, std::vector<float> &rgb);
// Its luminance averaged over every direction (solid-angle weighted); logAverage: the geometric mean.
double cubeLuminance(const CubeMap &c, bool logAverage);

// A picture in light-probe units as the view shows it in that environment (ui/post.js xoGrade): at the
// exposure (SkyLight::exposure), white-balanced, through the toe, the filmic curve and the preset's
// colour LUT. rgb: linear floats; rgba: sRGB bytes out.
bool gradeLikeView(const GameData &gd, const MapEnvironment &env, double exposure, const std::vector<float> &rgb, std::vector<uint8_t> &rgba, std::string *err);

// Radiance .hdr (RGBE, run-length encoded scanlines), top row first.
std::vector<uint8_t> encodeHdr(const float *rgb, int w, int h);
// Reads one back (for checks): RGB floats, top row first.
bool decodeHdr(const std::vector<uint8_t> &file, std::vector<float> &rgb, int &w, int &h, std::string *err);

} // namespace xo
