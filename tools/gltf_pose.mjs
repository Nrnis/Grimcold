// Poses an exported glTF's skeleton at a time of one of its animations (LINEAR keys, quaternions
// slerped), so the tests can compare an exported clip with what the app's viewer plays.
import fs from 'node:fs';
import path from 'node:path';

// { doc, bin } of a .gltf (with its .bin) or a .glb.
export function loadGltf(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) === 0x46546c67) { // glb
    const jl = buf.readUInt32LE(12);
    const doc = JSON.parse(buf.subarray(20, 20 + jl).toString());
    const bin = buf.subarray(20 + jl + 8, 20 + jl + 8 + buf.readUInt32LE(20 + jl));
    return { doc, bin };
  }
  const doc = JSON.parse(buf.toString());
  return { doc, bin: fs.readFileSync(path.join(path.dirname(file), doc.buffers[0].uri)) };
}

function floats(doc, bin, i) {
  const a = doc.accessors[i], v = doc.bufferViews[a.bufferView];
  const n = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const off = (v.byteOffset || 0) + (a.byteOffset || 0);
  return new Float32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * n * 4));
}

const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = d < 0 ? -1 : 1;
  d = Math.abs(d);
  let k0 = 1 - t, k1 = t * s;
  if (d < 0.9995) { const th = Math.acos(d), sn = Math.sin(th); k0 = Math.sin((1 - t) * th) / sn; k1 = (Math.sin(t * th) / sn) * s; }
  const q = [0, 1, 2, 3].map((i) => a[i] * k0 + b[i] * k1);
  const l = Math.hypot(...q);
  return q.map((x) => x / l);
};

function sample(times, values, n, t) {
  let k = 0;
  while (k + 1 < times.length && times[k + 1] <= t) k++;
  const k2 = Math.min(times.length - 1, k + 1);
  const f = k2 === k ? 0 : Math.min(1, Math.max(0, (t - times[k]) / (times[k2] - times[k])));
  const a = Array.from(values.subarray(k * n, k * n + n)), b = Array.from(values.subarray(k2 * n, k2 * n + n));
  return n === 4 ? slerp(a, b, f) : a.map((x, i) => x + (b[i] - x) * f);
}

// Column-major 4x4 from translation, rotation (xyzw), scale.
function compose(t, q, s) {
  const [x, y, z, w] = q, [sx, sy, sz] = s;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0, 2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, t[0], t[1], t[2], 1];
}
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
}

// World matrices (column-major) of every node, with animation `name` at time t on top of the
// nodes' own TRS (no animation: the rest pose).
export function poseAt({ doc, bin }, name, t) {
  const local = doc.nodes.map((n) => ({ t: n.translation || [0, 0, 0], q: n.rotation || [0, 0, 0, 1], s: n.scale || [1, 1, 1], m: n.matrix }));
  const anim = name == null ? null : doc.animations.find((a) => a.name === name);
  if (name != null && !anim) throw new Error('no animation ' + name);
  for (const ch of anim?.channels || []) {
    const s = anim.samplers[ch.sampler];
    const times = floats(doc, bin, s.input), values = floats(doc, bin, s.output);
    const L = local[ch.target.node];
    if (ch.target.path === 'translation') L.t = sample(times, values, 3, t);
    if (ch.target.path === 'rotation') L.q = sample(times, values, 4, t);
  }
  const parent = new Array(doc.nodes.length).fill(-1);
  doc.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const world = [];
  const get = (i) => {
    if (world[i]) return world[i];
    const L = local[i];
    const m = L.m || compose(L.t, L.q, L.s);
    return (world[i] = parent[i] >= 0 ? mul(get(parent[i]), m) : m);
  };
  return doc.nodes.map((n, i) => ({ name: n.name, world: get(i) }));
}
