// Collision hulls: the game's own physics shapes (<model>.mdp, "TCF MODEL_PHYS", beside the .mdl).
// Each part has one or a few convex hulls (a frame: a box; a cabin or a wheel: 16-20 points). The
// garage refuses a part whose hulls would sit inside another part's, and so does the builder, with
// the same shapes. Read from the archives at run time.
//
// Layout (little-endian). Header "TCF MODEL_PHYS\0\0", u32 version, u32 blocks, u64 directory
// offset; directory entries { u32 type, u32 size, u64 offset }. Block type 9:
//   u32 kind (19, 20: a 4x4 matrix per shape; 21: quaternion + offset), u32 hash, u32 shapes, u32 0
//   u32 0, u32 string table size, u32 geometry size, u32 0
//   per shape (128 bytes; 96 for kind 21): transform (row vectors: translation in the last row),
//     then u32 type (3 convex hull; 4 triangle mesh, not convex: left out), +0x18 u32 material name
//     offset, +0x20 u32 geometry offset, node references
//   string table (material and node names)
//   per shape, at its geometry offset: vec4 box min, vec4 box max, u32 point count (16-byte row),
//     u32 index count (16-byte row), points (vec4), indices (u32, triangles)
// 2,060 of the 2,066 .mdp files under models/ read this way (the 6 others: one laser weapon and
// its projectiles; parts without hulls are tested by their box instead).
// Game space; glTF space (the viewer's) mirrors z like the meshes.
import * as THREE from 'three';

const cache = new Map(); // model path -> Promise<hulls (model space) | null>

// After the game data changed.
export function flushPhys() { cache.clear(); }

export function physShapes(path) {
  if (!path) return Promise.resolve(null);
  if (!cache.has(path)) {
    const url = 'https://xo.data/raw?path=' + encodeURIComponent(path.replace(/\.mdl$/i, '.mdp'));
    cache.set(path, fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? parsePhys(b) : null)).catch(() => null));
  }
  return cache.get(path);
}

// [{ points: Float32Array (x y z ...), normals: [Vector3], edges: [Vector3], box: Box3 }] in the
// model's (glTF) space, or null.
export function parsePhys(buf) {
  if (buf.byteLength < 32) return null;
  const dv = new DataView(buf);
  const u32 = (o) => dv.getUint32(o, true), f32 = (o) => dv.getFloat32(o, true);
  if (String.fromCharCode(...new Uint8Array(buf, 0, 14)) !== 'TCF MODEL_PHYS') return null;
  const blocks = u32(0x14), dir = Number(dv.getBigUint64(0x18, true));
  for (let b = 0; b < blocks && dir + b * 16 + 16 <= buf.byteLength; b++) {
    const d = dir + b * 16, type = u32(d), size = u32(d + 4), off = Number(dv.getBigUint64(d + 8, true));
    if (type !== 9 || off + size > buf.byteLength || size < 32) continue;
    const kind = u32(off), count = u32(off + 8), strings = u32(off + 0x14);
    const quat = kind === 21, hs = quat ? 96 : 128, ts = quat ? 32 : 64;
    const geo = off + 32 + count * hs + strings, end = off + size;
    if (count > 256 || geo > end) return null;
    const hulls = [];
    for (let k = 0; k < count; k++) {
      const h = off + 32 + k * hs;
      if (u32(h + ts) !== 3) continue; // not a convex hull
      const m = new THREE.Matrix4();
      if (quat) {
        m.compose(new THREE.Vector3(f32(h + 16), f32(h + 20), f32(h + 24)), new THREE.Quaternion(f32(h), f32(h + 4), f32(h + 8), f32(h + 12)).normalize(), new THREE.Vector3(1, 1, 1));
      } else {
        const e = [];
        for (let j = 0; j < 16; j++) e.push(f32(h + j * 4));
        m.fromArray(e); // row-vector data read column-major: the column-vector matrix
      }
      const g = geo + u32(h + ts + 0x20);
      if (g + 64 > end) continue;
      const nv = u32(g + 32), ni = u32(g + 48);
      if (nv < 4 || nv > 4096 || ni % 3 || g + 64 + nv * 16 + ni * 4 > end) continue;
      const points = new Float32Array(nv * 3), v = new THREE.Vector3();
      for (let j = 0; j < nv; j++) {
        v.set(f32(g + 64 + j * 16), f32(g + 68 + j * 16), f32(g + 72 + j * 16)).applyMatrix4(m);
        points.set([v.x, v.y, -v.z], j * 3);
      }
      const at = (i) => new THREE.Vector3().fromArray(points, i * 3);
      const normals = [], edges = [];
      for (let t = 0; t < ni; t += 3) {
        const ia = u32(g + 64 + nv * 16 + t * 4), ib = u32(g + 68 + nv * 16 + t * 4), ic = u32(g + 72 + nv * 16 + t * 4);
        if (ia >= nv || ib >= nv || ic >= nv) continue;
        const a = at(ia), bb = at(ib), c = at(ic);
        addAxis(normals, bb.clone().sub(a).cross(c.clone().sub(a)));
        addAxis(edges, bb.clone().sub(a));
        addAxis(edges, c.clone().sub(bb));
        addAxis(edges, a.clone().sub(c));
      }
      if (!normals.length) continue;
      hulls.push({ points, normals, edges, box: new THREE.Box3().setFromArray(points) });
    }
    return hulls.length ? hulls : null;
  }
  return null;
}

// Unique directions only (a box has 3 face normals and 3 edge directions, whatever its triangles).
function addAxis(list, v) {
  const l = v.length();
  if (l < 1e-6) return;
  v.divideScalar(l);
  if (!list.some((u) => Math.abs(u.dot(v)) > 0.9999)) list.push(v);
}

// The hulls where a part would be: matrix is its world matrix (mirroring included).
export function placeHulls(hulls, matrix) {
  const n3 = new THREE.Matrix3().setFromMatrix4(matrix); // rotation (and mirror): axes turn with the points
  return hulls.map((h) => {
    const points = new Float32Array(h.points.length), v = new THREE.Vector3();
    for (let i = 0; i < points.length; i += 3) {
      v.fromArray(h.points, i).applyMatrix4(matrix);
      points[i] = v.x; points[i + 1] = v.y; points[i + 2] = v.z;
    }
    return { points, normals: h.normals.map((a) => a.clone().applyMatrix3(n3).normalize()), edges: h.edges.map((a) => a.clone().applyMatrix3(n3).normalize()), box: new THREE.Box3().setFromArray(points) };
  });
}

// A stand-in for a part without hulls: its box, pulled in by `inset` on every side (a side
// thinner than that becomes its middle plane; the other sides keep their size).
export function boxHull(box, inset = 0.05) {
  const c = box.getCenter(new THREE.Vector3());
  const b = new THREE.Box3(
    new THREE.Vector3(Math.min(box.min.x + inset, c.x), Math.min(box.min.y + inset, c.y), Math.min(box.min.z + inset, c.z)),
    new THREE.Vector3(Math.max(box.max.x - inset, c.x), Math.max(box.max.y - inset, c.y), Math.max(box.max.z - inset, c.z)));
  const points = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) points.push(x, y, z);
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  return { points: new Float32Array(points), normals: axes, edges: axes, box: b };
}

// How deep two hulls sit in each other: the smallest overlap along any separating axis candidate
// (face normals of both, cross products of their edges). 0 when they are apart or only touch.
export function hullDepth(a, b) {
  if (!a.box.intersectsBox(b.box)) return 0;
  let depth = Infinity;
  const test = (axis) => {
    const o = overlapOn(a.points, b.points, axis);
    if (o < depth) depth = o;
    return depth > 0;
  };
  for (const n of a.normals) if (!test(n)) return 0;
  for (const n of b.normals) if (!test(n)) return 0;
  const c = new THREE.Vector3();
  for (const ea of a.edges) {
    for (const eb of b.edges) {
      c.crossVectors(ea, eb);
      const l = c.length();
      if (l < 1e-4) continue;
      if (!test(c.divideScalar(l))) return 0;
    }
  }
  return depth === Infinity ? 0 : depth;
}

// How far one shape would have to move along n to come free of the other (negative: apart). Not
// just the shared length of the two spans: a thin shape inside a thick one is deep in it.
function overlapOn(pa, pb, n) {
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let i = 0; i < pa.length; i += 3) { const d = pa[i] * n.x + pa[i + 1] * n.y + pa[i + 2] * n.z; if (d < a0) a0 = d; if (d > a1) a1 = d; }
  for (let i = 0; i < pb.length; i += 3) { const d = pb[i] * n.x + pb[i + 1] * n.y + pb[i + 2] * n.z; if (d < b0) b0 = d; if (d > b1) b1 = d; }
  return Math.min(a1 - b0, b1 - a0);
}

// Two parts (lists of placed hulls) overlap when any pair of their hulls sits deeper in each other
// than `allow` metres. Parts that are welded together only touch (or graze, within the allowance).
export const OVERLAP_ALLOWANCE = 0.03;
export function partsOverlap(a, b, allow = OVERLAP_ALLOWANCE) {
  for (const ha of a) for (const hb of b) if (ha.box.intersectsBox(hb.box) && hullDepth(ha, hb) > allow) return true;
  return false;
}
