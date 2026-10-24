#include "xo/Model.h"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace xo {
namespace {

template <class T> T rd(const std::vector<uint8_t> &b, size_t p) {
    T v;
    std::memcpy(&v, b.data() + p, sizeof(T));
    return v;
}

float halfToFloat(uint16_t h) {
    const uint32_t sign = (h & 0x8000u) << 16;
    uint32_t exp = (h >> 10) & 31, mant = h & 1023;
    uint32_t bits;
    if (exp == 0) {
        if (mant == 0) {
            bits = sign;
        } else { // subnormal: normalise
            exp = 127 - 15 + 1;
            while (!(mant & 1024)) {
                mant <<= 1;
                --exp;
            }
            mant &= 1023;
            bits = sign | (exp << 23) | (mant << 13);
        }
    } else if (exp == 31) {
        bits = sign | 0x7F800000u | (mant << 13);
    } else {
        bits = sign | ((exp - 15 + 127) << 23) | (mant << 13);
    }
    float f;
    std::memcpy(&f, &bits, 4);
    return f;
}

// Reads one vertex element as up to 4 floats (normalised formats mapped to [-1,1] / [0,1]).
// Returns the component count, 0 for an unknown format.
int readElement(const uint8_t *p, uint8_t fmt, float out[4]) {
    out[0] = out[1] = out[2] = 0;
    out[3] = 1;
    auto f32 = [&](int i) { float v; std::memcpy(&v, p + i * 4, 4); return v; };
    auto i16 = [&](int i) { int16_t v; std::memcpy(&v, p + i * 2, 2); return v; };
    auto u16 = [&](int i) { uint16_t v; std::memcpy(&v, p + i * 2, 2); return v; };
    switch (fmt) {
    case 0x02: out[0] = f32(0); out[1] = f32(1); return 2;
    case 0x03: out[0] = f32(0); out[1] = f32(1); out[2] = f32(2); return 3;
    case 0x04: for (int i = 0; i < 4; ++i) out[i] = f32(i); return 4;
    case 0x05: for (int i = 0; i < 4; ++i) out[i] = p[i] / 255.0f; return 4;              // ubyte4n
    case 0x06: for (int i = 0; i < 4; ++i) out[i] = p[i]; return 4;                        // ubyte4
    case 0x09: out[0] = std::max(-1.0f, i16(0) / 32767.0f); out[1] = std::max(-1.0f, i16(1) / 32767.0f); return 2; // short2n
    case 0x0A: for (int i = 0; i < 4; ++i) out[i] = std::max(-1.0f, i16(i) / 32767.0f); return 4;               // short4n
    case 0x0F: out[0] = halfToFloat(u16(0)); out[1] = halfToFloat(u16(1)); return 2;       // half2
    case 0x10: for (int i = 0; i < 4; ++i) out[i] = halfToFloat(u16(i)); return 4;         // half4
    case 0x14: for (int i = 0; i < 4; ++i) out[i] = std::max(-1.0f, static_cast<int8_t>(p[i]) / 127.0f); return 4; // byte4n
    default: return 0;
    }
}

int formatSize(uint8_t fmt) {
    switch (fmt) {
    case 0x02: return 8;
    case 0x03: return 12;
    case 0x04: return 16;
    case 0x05: case 0x06: case 0x09: case 0x0F: case 0x14: return 4;
    case 0x0A: case 0x10: return 8;
    case 0x12: return 4; // (Crossout 2.41's trees' second stream: what it holds is not known)
    default: return 0;
    }
}

void normalize3(float *v) {
    const float l = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if (l > 1e-12f) {
        v[0] /= l;
        v[1] /= l;
        v[2] /= l;
    }
}

// v' = q * v * q^-1 for a unit quaternion (x, y, z, w).
void rotate(const float q[4], const float v[3], float out[3]) {
    const float tx = 2 * (q[1] * v[2] - q[2] * v[1]);
    const float ty = 2 * (q[2] * v[0] - q[0] * v[2]);
    const float tz = 2 * (q[0] * v[1] - q[1] * v[0]);
    out[0] = v[0] + q[3] * tx + (q[1] * tz - q[2] * ty);
    out[1] = v[1] + q[3] * ty + (q[2] * tx - q[0] * tz);
    out[2] = v[2] + q[3] * tz + (q[0] * ty - q[1] * tx);
}

struct DrawRange {
    uint32_t material, lod, first, count;
};

bool parseMesh(const std::vector<uint8_t> &b, size_t off, size_t size, MeshInfo &me, std::vector<DrawRange> &ranges, std::string *err) {
    auto fail = [&](const char *m) {
        if (err)
            *err = m;
        return false;
    };
    if (size < 0xB0)
        return fail("mesh block too small");
    me.flags = rd<uint32_t>(b, off);
    for (int k = 0; k < 14; ++k) {
        const size_t e = off + 4 + static_cast<size_t>(k) * 4;
        if (rd<uint32_t>(b, e) == 0)
            break;
        me.elements.push_back({b[e], b[e + 1], b[e + 2], b[e + 3]});
    }
    me.stride = b[off + 63];
    for (int k = 0; k < 12; ++k)
        me.words[k] = rd<uint32_t>(b, off + 64 + static_cast<size_t>(k) * 4);
    me.material = me.words[0];
    me.vertexCount = me.words[1];
    me.indexCount = me.words[2];
    me.positionBytes = (me.flags & 0x10) ? 8 : 12; // half4 or float3
    // Crossout 2.41's newer trees keep a second stream after the first (elements of index 1: one of
    // 4 bytes a vertex): the stride byte is the two together; the first steps at the rest, and the
    // indices follow both
    const uint32_t both = me.stride;
    uint32_t second = 0;
    for (const auto &e : me.elements)
        if (e.index == 1)
            second += static_cast<uint32_t>(formatSize(e.format));
    if (second > 0 && second < me.stride)
        me.stride -= second;
    if (me.stride < (me.positionBytes == 8 ? 6u : 12u)) // decodeMesh reads 6 or 12 bytes per position
        return fail("bad vertex stride");
    for (const auto &e : me.elements)
        if (e.index == 0 && static_cast<uint32_t>(e.offset + formatSize(e.format)) > me.stride)
            return fail("vertex element outside the stride");
    me.vertexOffset = off + 0xB0;
    const size_t idxBytes = me.vertexCount > 65535 ? 4 : 2;
    me.indexOffset = me.vertexOffset + static_cast<size_t>(me.vertexCount) * both;
    const size_t idxEnd = me.indexOffset + static_cast<size_t>(me.indexCount) * idxBytes;
    if (idxEnd > off + size)
        return fail("mesh data runs past its block");
    const size_t bb = off + ((idxEnd - off + 3) & ~size_t(3));
    if (bb + 32 <= off + size) {
        for (int i = 0; i < 3; ++i) {
            me.bbMin[i] = rd<float>(b, bb + i * 4);
            me.bbMax[i] = rd<float>(b, bb + 16 + i * 4);
        }
    }
    // Trees: draw ranges after the box. Taken only when they tile the index list exactly. Crossout
    // 2.41's newer trees (two streams) keep 64 .. 128 bytes more between the indices and the box: theirs
    // are read back from the block's end (the box right before them) when the old place has none.
    ranges.clear();
    auto tiling = [&](size_t from, size_t to) {
        ranges.clear();
        uint64_t next = 0;
        bool ok = from < to && (to - from) % 16 == 0;
        for (size_t r = from; r + 16 <= to && ok; r += 16) {
            const DrawRange d{rd<uint32_t>(b, r), rd<uint32_t>(b, r + 4), rd<uint32_t>(b, r + 8), rd<uint32_t>(b, r + 12)};
            ok = d.material < 4096 && d.first == next && d.count > 0 && d.count % 3 == 0;
            next = static_cast<uint64_t>(d.first) + d.count;
            ranges.push_back(d);
        }
        if (!ok || next != me.indexCount)
            ranges.clear();
        return !ranges.empty();
    };
    if (me.material == 0xFFFFFFFFu && bb + 32 < off + size)
        tiling(bb + 32, off + size);
    for (size_t n = 1; me.material == 0xFFFFFFFFu && ranges.empty() && n <= 32 && bb + 32 + n * 16 <= off + size; ++n)
        if (tiling(off + size - n * 16, off + size)) {
            const size_t box = off + size - n * 16 - 32;
            for (int i = 0; i < 3; ++i) {
                me.bbMin[i] = rd<float>(b, box + i * 4);
                me.bbMax[i] = rd<float>(b, box + 16 + i * 4);
            }
        }
    me.speedTree = me.material == 0xFFFFFFFFu && me.positionBytes == 8 && me.stride == 24;
    for (const auto &e : me.elements)
        if ((e.semantic & 15) == 2)
            me.maxInfluences = 4;
    return true;
}

const char *semanticName(uint8_t s) {
    switch (s & 15) {
    case 1: return "weights";
    case 2: return "joints";
    case 3: return "normal";
    case 4: return "uv";
    case 5: return "tangent";
    case 7: return "color";
    case 9: return "qtangent";
    default: return "?";
    }
}
const char *formatName(uint8_t f) {
    switch (f) {
    case 0x02: return "float2";
    case 0x03: return "float3";
    case 0x04: return "float4";
    case 0x05: return "ubyte4n";
    case 0x06: return "ubyte4";
    case 0x09: return "short2n";
    case 0x0A: return "short4n";
    case 0x0F: return "half2";
    case 0x10: return "half4";
    case 0x14: return "byte4n";
    default: return "?";
    }
}

} // namespace

std::string describeElement(const VertexElement &e) {
    std::string s = semanticName(e.semantic);
    if (e.semantic >> 4)
        s += std::to_string(e.semantic >> 4);
    s += ' ';
    s += formatName(e.format);
    return s;
}

bool parseModel(std::vector<uint8_t> bytes, Model &m, std::string *err) {
    m = Model{};
    m.data = std::move(bytes);
    const auto &b = m.data;
    auto fail = [&](const std::string &msg) {
        if (err)
            *err = msg;
        return false;
    };
    if (b.size() < 32 || std::memcmp(b.data(), "TCF MODEL", 9) != 0)
        return fail("not a TCF MODEL file");
    m.version = rd<uint32_t>(b, 16);
    const uint32_t blocks = rd<uint32_t>(b, 20);
    const uint64_t dir = rd<uint64_t>(b, 24);
    if (blocks > 100000 || dir > b.size() || static_cast<uint64_t>(blocks) * 16 > b.size() - dir)
        return fail("bad block directory");
    int blockMeshes = 0; // mesh blocks so far (a tree block becomes several meshes)
    bool rangeLods = false; // (a tree's draw ranges number their LODs)
    std::vector<int> v9Starts;
    std::vector<float> v9Dist;
    for (uint32_t i = 0; i < blocks; ++i) {
        const size_t d = static_cast<size_t>(dir) + static_cast<size_t>(i) * 16;
        const uint32_t type = rd<uint32_t>(b, d), size = rd<uint32_t>(b, d + 4);
        const uint64_t off = rd<uint64_t>(b, d + 8);
        if (off > b.size() || size > b.size() - off) // written so corrupt offsets cannot overflow
            return fail("block " + std::to_string(i) + " outside the file");
        const size_t o = static_cast<size_t>(off);
        if (type == 13) {
            if (size < 60)
                return fail("short header block");
            for (int k = 0; k < 3; ++k) {
                m.bbMin[k] = rd<float>(b, o + k * 4);
                m.bbMax[k] = rd<float>(b, o + 16 + k * 4);
            }
            for (int k = 0; k < 4; ++k) {
                m.lodStart[k] = rd<uint16_t>(b, o + 32 + k * 2);
                m.lodDistance[k] = rd<float>(b, o + 40 + k * 4);
            }
            m.meshCountField = rd<uint16_t>(b, o + 56);
            m.groupField = rd<uint16_t>(b, o + 58);
            // Version 9 leaves those LOD fields zero and lists the LODs further on: u16 count at 78,
            // then the first mesh block of LOD 1, 2, ... (then the switch distances as floats).
            if (m.version >= 9 && size >= 80) {
                const uint16_t n = rd<uint16_t>(b, o + 78);
                if (n >= 2 && n <= 32 && 80 + static_cast<size_t>(n - 1) * 2 <= size) {
                    for (int k = 1; k < n; ++k)
                        v9Starts.push_back(rd<uint16_t>(b, o + 80 + static_cast<size_t>(k - 1) * 2));
                    const size_t at = (80 + static_cast<size_t>(n - 1) * 2 + 3) & ~size_t(3);
                    if (at + static_cast<size_t>(n - 1) * 4 <= size)
                        for (int k = 1; k < n; ++k)
                            v9Dist.push_back(rd<float>(b, o + at + static_cast<size_t>(k - 1) * 4));
                }
            }
        } else if (type == 0) {
            MeshInfo me;
            std::vector<DrawRange> ranges;
            std::string e;
            if (!parseMesh(b, o, size, me, ranges, &e))
                return fail("mesh " + std::to_string(blockMeshes) + ": " + e);
            me.block = blockMeshes++;
            if (ranges.empty()) {
                m.meshes.push_back(std::move(me));
            } else { // a tree: one mesh per draw range (bark, leaves, billboard), all on the shared vertices
                const size_t idxBytes = me.vertexCount > 65535 ? 4 : 2;
                for (const DrawRange &dr : ranges) {
                    MeshInfo part = me;
                    part.material = part.words[0] = dr.material;
                    part.lod = static_cast<int>(std::min<uint32_t>(dr.lod, 7));
                    rangeLods = rangeLods || dr.lod > 0;
                    part.indexOffset = me.indexOffset + static_cast<size_t>(dr.first) * idxBytes;
                    part.indexCount = dr.count;
                    part.compact = ranges.size() > 1;
                    m.meshes.push_back(std::move(part));
                }
            }
        } else if (type == 1) {
            if (size < 4)
                return fail("short node block");
            const uint32_t n = rd<uint32_t>(b, o);
            if (48 + static_cast<size_t>(n) * 240 > size)
                return fail("node block too small");
            for (uint32_t k = 0; k < n; ++k) {
                const size_t r = o + 48 + static_cast<size_t>(k) * 240;
                Node nd;
                const char *nm = reinterpret_cast<const char *>(b.data() + r);
                nd.name.assign(nm, strnlen(nm, 32));
                nd.parent = rd<int32_t>(b, r + 32);
                for (int j = 0; j < 3; ++j)
                    nd.translation[j] = rd<float>(b, r + 80 + j * 4);
                for (int j = 0; j < 4; ++j)
                    nd.rotation[j] = rd<float>(b, r + 96 + j * 4);
                for (int j = 0; j < 16; ++j) {
                    nd.world[j] = rd<float>(b, r + 112 + j * 4);
                    nd.inverseBind[j] = rd<float>(b, r + 176 + j * 4);
                }
                if (nd.parent < -1 || nd.parent >= static_cast<int>(n))
                    nd.parent = -1;
                m.nodes.push_back(std::move(nd));
            }
        } else if (type == 6) {
            if (size < 4)
                return fail("short slot block");
            const uint32_t n = rd<uint32_t>(b, o);
            if (4 + static_cast<size_t>(n) * 96 > size)
                return fail("slot block too small");
            for (uint32_t k = 0; k < n; ++k) {
                const size_t r = o + 4 + static_cast<size_t>(k) * 96;
                Slot s;
                const char *nm = reinterpret_cast<const char *>(b.data() + r);
                s.name.assign(nm, strnlen(nm, 32));
                for (int j = 0; j < 16; ++j)
                    s.matrix[j] = rd<float>(b, r + 32 + j * 4);
                m.slots.push_back(std::move(s));
            }
        } else {
            m.otherBlocks.push_back(type);
        }
    }
    // LOD groups: lodStart holds the first mesh block of LOD 4,3,2,1 (zeros = unused).
    std::vector<int> starts;
    for (uint16_t s : m.lodStart)
        if (s > 0 && s < blockMeshes)
            starts.push_back(s);
    if (starts.empty())
        for (int s : v9Starts)
            if (s > 0 && s < blockMeshes)
                starts.push_back(s);
    std::sort(starts.begin(), starts.end());
    starts.erase(std::unique(starts.begin(), starts.end()), starts.end());
    if (starts.empty() && rangeLods) {
        // (no LODs in the header, but its trees' draw ranges number theirs, a block per LOD: Crossout
        // 2.41's ground cover and newer trees, some 2.40 bushes; they drew every LOD at once)
        int top = 0;
        for (const auto &me : m.meshes)
            top = std::max(top, me.lod);
        m.lodCount = top + 1;
    } else {
        for (auto &me : m.meshes) {
            int lod = 0;
            for (int s : starts)
                if (me.block >= s)
                    ++lod;
            me.lod = lod;
        }
        m.lodCount = static_cast<int>(starts.size()) + 1;
    }
    // each LOD's switch value, in LOD order (v8 lists them like lodStart: LOD 4, 3, 2, 1)
    std::vector<std::pair<int, float>> sw;
    for (int k = 0; k < 4; ++k)
        if (m.lodStart[k] > 0 && m.lodStart[k] < blockMeshes)
            sw.push_back({m.lodStart[k], m.lodDistance[k]});
    if (sw.empty())
        for (size_t k = 0; k < v9Starts.size(); ++k)
            if (v9Starts[k] > 0 && v9Starts[k] < blockMeshes)
                sw.push_back({v9Starts[k], k < v9Dist.size() ? v9Dist[k] : 0.0f});
    std::sort(sw.begin(), sw.end(), [](const auto &a, const auto &c) { return a.first < c.first; });
    m.lodSwitch.clear();
    for (size_t k = 0; k < sw.size(); ++k)
        if (k == 0 || sw[k].first != sw[k - 1].first)
            m.lodSwitch.push_back(sw[k].second);
    return true;
}

bool decodeMesh(const Model &m, const MeshInfo &me, MeshGeometry &g, std::string *err) {
    g = MeshGeometry{};
    const auto &b = m.data;
    const uint32_t n = me.vertexCount;
    g.vertexCount = n;
    const VertexElement *eNormal = nullptr, *eTangent = nullptr, *eQTan = nullptr, *eUv0 = nullptr, *eUv1 = nullptr, *eUv2 = nullptr,
                        *eColor = nullptr, *eJoints = nullptr, *eWeights = nullptr;
    for (const auto &e : me.elements) {
        switch (e.semantic) {
        case 0x03: eNormal = &e; break;
        case 0x05: eTangent = &e; break;
        case 0x09: eQTan = &e; break;
        case 0x04: eUv0 = &e; break;
        case 0x14: eUv1 = &e; break;
        case 0x24: eUv2 = &e; break;
        case 0x07: eColor = &e; break;
        case 0x02: eJoints = &e; break;
        case 0x01: eWeights = &e; break;
        default: break;
        }
    }
    g.position.resize(static_cast<size_t>(n) * 3);
    if (eQTan || eNormal || me.speedTree) // (trees store none: repairFrames builds them from the triangles)
        g.normal.resize(static_cast<size_t>(n) * 3);
    if (eQTan || (eNormal && eTangent))
        g.tangent.resize(static_cast<size_t>(n) * 4);
    if (eUv0)
        g.uv0.resize(static_cast<size_t>(n) * 2);
    if (eUv1)
        g.uv1.resize(static_cast<size_t>(n) * 2);
    if (eUv2)
        g.uv2.resize(static_cast<size_t>(n) * 2);
    if (eColor)
        g.color.resize(static_cast<size_t>(n) * 4);
    if (eJoints) {
        g.joints.resize(static_cast<size_t>(n) * 4);
        g.weights.resize(static_cast<size_t>(n) * 4);
    }
    // A skinned mesh's bone numbers count from its first bone, words[6]: its bones are the nodes
    // words[6] .. words[6] + words[7] - 1. Read as node numbers, 1,043 of the game's 3,781 skinned
    // meshes were bound to the wrong bones (the Aggressor's exhaust pipes swung with the flaps two
    // nodes before them; the catapult's barrels hung on the wrong joints).
    const uint32_t firstBone = eJoints && me.words[6] < m.nodes.size() ? me.words[6] : 0;
    float t[4];
    for (uint32_t v = 0; v < n; ++v) {
        const uint8_t *p = b.data() + me.vertexOffset + static_cast<size_t>(v) * me.stride;
        float *P = &g.position[static_cast<size_t>(v) * 3];
        if (me.positionBytes == 8) {
            uint16_t h[3];
            std::memcpy(h, p, 6);
            P[0] = halfToFloat(h[0]);
            P[1] = halfToFloat(h[1]);
            P[2] = halfToFloat(h[2]);
        } else {
            std::memcpy(P, p, 12);
        }
        P[2] = -P[2];
        // (no normal stored, as on trees: left zero, so repairFrames builds it from the triangles; a
        // default here gave every tree trunk the one normal and lit it like a flat card)
        float N[3] = {0, 0, 0}, T[3] = {1, 0, 0}, w = 1;
        bool haveT = false;
        if (eQTan) {
            readElement(p + eQTan->offset, eQTan->format, t);
            float q[4] = {t[0], t[1], t[2], t[3]};
            const float l = std::sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            if (l > 1e-6f) {
                for (float &c : q)
                    c /= l;
            } else {
                q[0] = q[1] = q[2] = 0;
                q[3] = 1;
            }
            const float z[3] = {0, 0, 1}, x[3] = {1, 0, 0};
            rotate(q, z, N);
            rotate(q, x, T);
            w = q[3] < 0 ? -1.0f : 1.0f;
            haveT = true;
        } else if (eNormal) {
            readElement(p + eNormal->offset, eNormal->format, t);
            N[0] = t[0];
            N[1] = t[1];
            N[2] = t[2];
            if (eTangent) {
                readElement(p + eTangent->offset, eTangent->format, t);
                T[0] = t[0];
                T[1] = t[1];
                T[2] = t[2];
                w = t[3] < 0 ? -1.0f : 1.0f;
                haveT = true;
            }
        }
        if (!g.normal.empty()) {
            normalize3(N);
            float *o = &g.normal[static_cast<size_t>(v) * 3];
            o[0] = N[0];
            o[1] = N[1];
            o[2] = -N[2];
        }
        if (!g.tangent.empty() && haveT) {
            normalize3(T);
            float *o = &g.tangent[static_cast<size_t>(v) * 4];
            o[0] = T[0];
            o[1] = T[1];
            o[2] = -T[2];
            o[3] = -w; // mirroring flips the handedness
        }
        if (me.speedTree && eUv0) { // position w = u, LOD position (bytes 8..15) w = v
            uint16_t hu, hv;
            std::memcpy(&hu, p + 6, 2);
            std::memcpy(&hv, p + 14, 2);
            g.uv0[static_cast<size_t>(v) * 2] = halfToFloat(hu);
            g.uv0[static_cast<size_t>(v) * 2 + 1] = halfToFloat(hv);
        } else if (eUv0) {
            readElement(p + eUv0->offset, eUv0->format, t);
            g.uv0[static_cast<size_t>(v) * 2] = t[0];
            g.uv0[static_cast<size_t>(v) * 2 + 1] = t[1];
        }
        if (eUv1) {
            readElement(p + eUv1->offset, eUv1->format, t);
            g.uv1[static_cast<size_t>(v) * 2] = t[0];
            g.uv1[static_cast<size_t>(v) * 2 + 1] = t[1];
        }
        if (eUv2) {
            readElement(p + eUv2->offset, eUv2->format, t);
            g.uv2[static_cast<size_t>(v) * 2] = t[0];
            g.uv2[static_cast<size_t>(v) * 2 + 1] = t[1];
        }
        if (eColor) {
            std::memcpy(&g.color[static_cast<size_t>(v) * 4], p + eColor->offset,
                        eColor->format == 0x05 || eColor->format == 0x06 ? 4 : 0);
        }
        if (eJoints) {
            uint8_t *J = &g.joints[static_cast<size_t>(v) * 4];
            float *W = &g.weights[static_cast<size_t>(v) * 4];
            readElement(p + eJoints->offset, eJoints->format, t);
            for (int k = 0; k < 4; ++k)
                J[k] = static_cast<uint8_t>(std::clamp(t[k] + static_cast<float>(firstBone), 0.0f, 255.0f));
            if (eWeights) {
                readElement(p + eWeights->offset, eWeights->format, t);
                for (int k = 0; k < 4; ++k)
                    W[k] = std::max(0.0f, t[k]);
            } else {
                W[0] = 1;
                W[1] = W[2] = W[3] = 0;
            }
            float s = W[0] + W[1] + W[2] + W[3];
            if (s <= 1e-6f) {
                W[0] = 1;
                W[1] = W[2] = W[3] = 0;
                s = 1;
            }
            for (int k = 0; k < 4; ++k) {
                W[k] /= s;
                if (W[k] == 0)
                    J[k] = 0; // glTF: unused influences should point at joint 0
            }
        }
    }
    g.indices.resize(me.indexCount);
    const bool wide = me.vertexCount > 65535;
    for (uint32_t i = 0; i < me.indexCount; ++i) {
        uint32_t idx;
        if (wide) {
            idx = rd<uint32_t>(b, me.indexOffset + static_cast<size_t>(i) * 4);
        } else {
            idx = rd<uint16_t>(b, me.indexOffset + static_cast<size_t>(i) * 2);
        }
        if (idx >= n) {
            if (err)
                *err = "index out of range";
            return false;
        }
        g.indices[i] = idx;
    }
    if (me.compact) { // keep only the vertices this draw range uses, in first-use order
        std::vector<uint32_t> remap(n, UINT32_MAX), keep;
        for (uint32_t &i : g.indices) {
            if (remap[i] == UINT32_MAX) {
                remap[i] = static_cast<uint32_t>(keep.size());
                keep.push_back(i);
            }
            i = remap[i];
        }
        auto pick = [&](auto &arr, size_t comps) {
            if (arr.empty())
                return;
            std::remove_reference_t<decltype(arr)> out(keep.size() * comps);
            for (size_t k = 0; k < keep.size(); ++k)
                for (size_t c = 0; c < comps; ++c)
                    out[k * comps + c] = arr[static_cast<size_t>(keep[k]) * comps + c];
            arr.swap(out);
        };
        pick(g.position, 3);
        pick(g.normal, 3);
        pick(g.tangent, 4);
        pick(g.uv0, 2);
        pick(g.uv1, 2);
        pick(g.uv2, 2);
        pick(g.color, 4);
        pick(g.joints, 4);
        pick(g.weights, 4);
        g.vertexCount = static_cast<uint32_t>(keep.size());
    }
    if (me.speedTree) {
        // Trees are wound the other way round (inward once mirrored): every SpeedTree trunk measured
        // so had a negative volume, so it was drawn inside out and its normals, built from the
        // triangles below, pointed in. Turned when the volume says so, before the normals are made.
        double vol = 0, c[3] = {0, 0, 0};
        for (uint32_t v = 0; v < g.vertexCount; ++v)
            for (int k = 0; k < 3; ++k)
                c[k] += g.position[v * 3 + k] / std::max<uint32_t>(1, g.vertexCount);
        for (size_t tri = 0; tri + 2 < g.indices.size(); tri += 3) {
            double p[3][3];
            for (int i = 0; i < 3; ++i)
                for (int k = 0; k < 3; ++k)
                    p[i][k] = g.position[g.indices[tri + i] * 3 + k] - c[k];
            vol += p[0][0] * (p[1][1] * p[2][2] - p[1][2] * p[2][1]) - p[0][1] * (p[1][0] * p[2][2] - p[1][2] * p[2][0]) +
                   p[0][2] * (p[1][0] * p[2][1] - p[1][1] * p[2][0]);
        }
        if (vol < 0)
            for (size_t tri = 0; tri + 2 < g.indices.size(); tri += 3)
                std::swap(g.indices[tri + 1], g.indices[tri + 2]);
    }
    repairFrames(g);
    cleanUvs(g);
    if (!me.speedTree)
        fixInsideOut(g);
    return true;
}

void cleanUvs(MeshGeometry &g) {
    // A UV set the game evidently never reads (radio tower radar parts: the second "half2" set holds
    // other data, infinities and 65504s) goes; stray bad numbers elsewhere (a few vertices of bridge
    // cranes and space-station rings) become 0, so nothing downstream sees NaN or infinity.
    for (std::vector<float> *uv : {&g.uv0, &g.uv1, &g.uv2}) {
        size_t bad = 0;
        for (float &f : *uv)
            if (!std::isfinite(f) || std::abs(f) > 1e4f) {
                f = 0;
                ++bad;
            }
        if (uv != &g.uv0 && bad * 4 > uv->size()) // (a quarter of the values: not a UV set)
            uv->clear();
    }
}

void fixInsideOut(MeshGeometry &g) {
    // A mesh whose triangles nearly all turn their back on their own normals (mirrored copies: the
    // right-hand ladder of builders_town, a carrier propeller, hull plates) was mirrored with its
    // normals but not its winding; the normals are right (they light it), so the winding follows them.
    if (g.normal.empty() || g.indices.size() < 24)
        return;
    size_t valid = 0, against = 0;
    for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
        const uint32_t a = g.indices[t], b = g.indices[t + 1], c = g.indices[t + 2];
        const float *pa = &g.position[a * 3], *pb = &g.position[b * 3], *pc = &g.position[c * 3];
        const float e1[3] = {pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]}, e2[3] = {pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]};
        const float fn[3] = {e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
        if (fn[0] * fn[0] + fn[1] * fn[1] + fn[2] * fn[2] < 1e-20f)
            continue;
        float vn[3] = {0, 0, 0};
        for (uint32_t i : {a, b, c})
            for (int q = 0; q < 3; ++q)
                vn[q] += g.normal[i * 3 + q];
        ++valid;
        against += fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2] < 0;
    }
    if (valid < 8 || against * 10 < valid * 9)
        return;
    for (size_t t = 0; t + 2 < g.indices.size(); t += 3)
        std::swap(g.indices[t + 1], g.indices[t + 2]);
}

// A few game meshes store zero-length normals/tangents on some vertices. Rebuild those normals
// from the surrounding triangles and give degenerate tangents a perpendicular axis, so every
// vertex has a unit frame (glTF requires it; the viewer would shade those spots black).
void repairFrames(MeshGeometry &g) {
    const uint32_t n = g.vertexCount;
    auto len = [](const float *v) { return std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); };
    std::vector<uint32_t> badN;
    if (!g.normal.empty())
        for (uint32_t v = 0; v < n; ++v)
            if (!(len(&g.normal[v * 3]) > 0.5f))
                badN.push_back(v);
    if (!badN.empty()) {
        std::vector<float> acc(static_cast<size_t>(n) * 3, 0.0f);
        for (size_t t = 0; t + 2 < g.indices.size(); t += 3) {
            const uint32_t a = g.indices[t], b = g.indices[t + 1], c = g.indices[t + 2];
            const float *pa = &g.position[a * 3], *pb = &g.position[b * 3], *pc = &g.position[c * 3];
            const float e1[3] = {pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]}, e2[3] = {pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]};
            const float fn[3] = {e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]};
            for (uint32_t k : {a, b, c})
                for (int i = 0; i < 3; ++i)
                    acc[k * 3 + i] += fn[i];
        }
        for (uint32_t v : badN) {
            float *o = &g.normal[v * 3];
            const float *s = &acc[v * 3];
            const float l = len(s);
            if (l > 1e-12f) {
                o[0] = s[0] / l;
                o[1] = s[1] / l;
                o[2] = s[2] / l;
            } else {
                o[0] = 0;
                o[1] = 1;
                o[2] = 0;
            }
        }
    }
    if (!g.tangent.empty()) {
        for (uint32_t v = 0; v < n; ++v) {
            float *t = &g.tangent[v * 4];
            if (len(t) > 0.5f && (t[3] == 1.0f || t[3] == -1.0f))
                continue;
            const float *N = g.normal.empty() ? nullptr : &g.normal[v * 3];
            float axis[3] = {1, 0, 0};
            if (N && std::abs(N[0]) > 0.9f) {
                axis[0] = 0;
                axis[1] = 1;
            }
            float o[3] = {axis[0], axis[1], axis[2]};
            if (N) { // o = normalize(axis - N * dot(axis, N))
                const float d = axis[0] * N[0] + axis[1] * N[1] + axis[2] * N[2];
                for (int i = 0; i < 3; ++i)
                    o[i] = axis[i] - N[i] * d;
            }
            const float l = len(o);
            t[0] = o[0] / l;
            t[1] = o[1] / l;
            t[2] = o[2] / l;
            t[3] = t[3] < 0 ? -1.0f : 1.0f;
        }
    }
}

void toGltfMatrix(const float in[16], float out[16]) {
    static const float s[4] = {1, 1, -1, 1};
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c)
            out[r * 4 + c] = in[r * 4 + c] * s[r] * s[c];
}

} // namespace xo
