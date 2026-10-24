#pragma once
// Crossout animations.
//
// .anim ("TCF ANIM", the same container as TCF MODEL: u32 version 8, u32 block count, u64
// directory offset; directory = { u32 type, u32 size, u64 offset }) holds one block of type 2:
//   f32 ?, f32 duration (s), u32 trackCount, u32 0, u8 boneMask[32], u8 affectedMask[32],
//   trackCount x { char node[32], u32 boneIndex, u32 keyCount, u32 format, u32 0 },
//   key data grouped by format: all format-0 tracks (per key: vec4 translation, quat
//   rotation), then format-1 tracks (vec4 translation), then format-2 tracks (quat xyzw),
//   then u16 key times (0..0x7fff = 0..duration) per track, padding to 16 bytes.
// Values are local (relative to the parent node) in the game's space; parseAnim converts them
// to glTF space (Z mirrored) like the models.
//
// A part's .model text file lists its animation layers:
//   anim <name> { activity IDLE|FIRE|...  file <x.anim>  poseParameter AimYaw -180 180
//                 speed 1.5  addLayer <other layer> }
// A layer with a pose parameter is not played over time: the parameter's value picks the
// point in the clip (turret yaw / gun pitch). Instead of one file a layer may list several,
// "files { a.anim b.anim ... }": single-key poses spread evenly over the parameter's range
// (wheel spin: -180, -60, 60, 180; steering: -20, 20) that the value blends between.
// Activity layers loop; addLayer stacks others.
#include <cstdint>
#include <string>
#include <string_view>
#include <vector>

namespace xo {

struct AnimTrack {
    std::string node;         // bone name (matches a model node)
    uint32_t bone = 0;        // index into the model's node list
    uint32_t format = 0;      // 0 translation + rotation, 1 translation, 2 rotation
    std::vector<float> times; // seconds
    std::vector<float> translation; // keys x 3, glTF space (empty for format 2)
    std::vector<float> rotation;    // keys x 4 (x, y, z, w), glTF space (empty for format 1)
};

struct Animation {
    float duration = 0;
    float unknown0 = 0;
    std::vector<AnimTrack> tracks;
};

bool parseAnim(const std::vector<uint8_t> &bytes, Animation &out, std::string *err);
// The same, choosing the key-time order explicitly (see Anim.cpp); for the format checks.
bool parseAnimEx(const std::vector<uint8_t> &bytes, Animation &out, std::string *err, bool timesInHeaderOrder);

struct AnimLayer {
    std::string name;
    std::string file;     // game path of the .anim ("" when missing)
    std::vector<std::string> files; // "files { }": blend poses over the pose parameter's range
    std::string activity; // "IDLE", "FIRE", ... ("" for pure pose / helper layers)
    std::string poseParameter;
    float poseMin = 0, poseMax = 0;
    float speed = 1;
    std::vector<std::string> addLayers;
};

struct ModelDesc {
    std::string mesh, skin;
    std::vector<AnimLayer> layers;
};

// text: the .model file; dir: its folder (game path) to resolve "file" names.
ModelDesc parseModelDesc(std::string_view text, std::string_view dir);

} // namespace xo
