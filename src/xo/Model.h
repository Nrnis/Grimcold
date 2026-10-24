#pragma once
// Crossout "TCF MODEL" (.mdl), versions 8 and 9.
//
//  0x00 "TCF MODEL" (16 bytes)  0x10 u32 version  0x14 u32 blockCount  0x18 u64 directoryOffset
//  directory: blockCount x { u32 type, u32 size, u64 offset }
//   type 13  header: bbox min/max (vec4 x2), u16 lodStart[4] (descending), f32 lodDistance[4],
//            u16 meshCount, u16 (per-LOD group count)
//   type 0   mesh: u32 flags, 14 x vertex element {fmt, semantic, index, offset}, u8 streams,
//            u8 0, u8 elementCount (incl. position), u8 stride; u32 words[12] (material,
//            vertexCount, indexCount, ...); the stream's own copy of the declaration (64 bytes);
//            vertices at +0xB0; u16 indices; 4-byte align; bbox (vec4 x2). Trees (SpeedTree, material
//            0xFFFFFFFF) end with draw ranges {u32 material, u32 lod, u32 firstIndex, u32 indexCount}:
//            bark, leaves and billboard share one vertex buffer; parseModel makes one mesh per range.
//   type 1   nodes: u32 count, 44 bytes, then count x 240: name[32], i32 parent, ..., local
//            translation (+0x50), local rotation quaternion (+0x60), world matrix (+0x70),
//            inverse bind matrix (+0xB0)
//   type 6   slots (build-grid attachment points): u32 count, count x { name[32], matrix }
// Matrices are row-major with the translation in the last row (Direct3D). Space is
// left-handed (Y up), triangles are clockwise. decodeMesh() converts to glTF space by
// mirroring Z, which also turns the clockwise triangles counter-clockwise.
#include <cstdint>
#include <string>
#include <vector>

namespace xo {

struct VertexElement {
    uint8_t format = 0, semantic = 0, index = 0, offset = 0;
};

struct MeshInfo {
    uint32_t flags = 0;
    uint32_t material = 0;
    uint32_t vertexCount = 0, indexCount = 0;
    uint32_t stride = 0, positionBytes = 0; // 12 = float3, 8 = half4
    uint32_t maxInfluences = 0;             // derived from the elements
    int lod = 0;
    std::vector<VertexElement> elements;
    size_t vertexOffset = 0, indexOffset = 0; // into Model::data
    float bbMin[3]{}, bbMax[3]{};
    uint32_t words[12]{};
    int block = 0;          // the mesh block it came from (a tree's block is split into its draw ranges)
    bool compact = false;   // one draw range of a shared vertex buffer: decode only the vertices it uses
    bool speedTree = false; // tree layout: half4 position + half4 LOD position, the uv in their w components
};

struct Node {
    std::string name;
    int parent = -1;
    float translation[3]{};
    float rotation[4]{0, 0, 0, 1};
    float world[16]{};
    float inverseBind[16]{};
};

struct Slot {
    std::string name;
    float matrix[16]{};
};

struct Model {
    uint32_t version = 0;
    std::vector<uint8_t> data;
    std::vector<MeshInfo> meshes;
    std::vector<Node> nodes;
    std::vector<Slot> slots;
    float bbMin[3]{}, bbMax[3]{};
    uint16_t lodStart[4]{};   // as stored (descending, zeros = unused)
    float lodDistance[4]{};
    uint16_t meshCountField = 0, groupField = 0;
    int lodCount = 1;
    std::vector<float> lodSwitch;      // the game's switch value of LOD 1, 2, ... (in LOD order; see CROSSOUT_FORMATS.md)
    std::vector<uint32_t> otherBlocks; // types we do not interpret (16, 17: map-prop volumes)
};

bool parseModel(std::vector<uint8_t> bytes, Model &m, std::string *err);

// Decoded vertex data in glTF space (right-handed: Z mirrored). Triangles are CCW.
struct MeshGeometry {
    uint32_t vertexCount = 0;
    std::vector<float> position;   // xyz
    std::vector<float> normal;     // xyz (empty if the mesh has none)
    std::vector<float> tangent;    // xyzw, w = bitangent sign (glTF convention)
    std::vector<float> uv0, uv1;   // uv (origin top-left, as in glTF)
    std::vector<float> uv2;        // the third set (semantic 0x24): layered map materials read their colour map (_cm) through it
    std::vector<uint8_t> color;    // rgba8
    std::vector<uint8_t> joints;   // 4 per vertex (node indices)
    std::vector<float> weights;    // 4 per vertex, normalised
    std::vector<uint32_t> indices;
};

bool decodeMesh(const Model &m, const MeshInfo &mesh, MeshGeometry &g, std::string *err);

// Called by decodeMesh: rebuilds zero-length normals from the triangles and fixes degenerate
// tangents, so every vertex ends up with a unit frame.
void repairFrames(MeshGeometry &g);
// Also called by decodeMesh: bad UV numbers become 0 and a second set that is mostly garbage goes;
// a mesh almost all of whose triangles face away from their own normals gets its winding turned.
void cleanUvs(MeshGeometry &g);
void fixInsideOut(MeshGeometry &g);

// Mirrors a row-major D3D matrix into glTF space and returns it column-major (glTF node.matrix).
void toGltfMatrix(const float rowMajorD3D[16], float out[16]);

// Short description of a vertex element ("normal short4n") for the info panel.
std::string describeElement(const VertexElement &e);

} // namespace xo
