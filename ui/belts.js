// Belts, chains, tracks and saw teeth drawn with the game's scrolling-belt shader (BA811382) do not
// move with bones: the game slides their texture along them, at a speed its code sets (nothing in
// the game files says how fast). Each such belt wraps a wheel, gear or pulley that its part's clips
// or pose sets turn round (the Porcupine's chain runs over gears01, a track over its road wheels, an
// engine belt over its pulleys), so here the texture moves with that wheel's rim: by the UV change
// per radian measured on the belt where it wraps the wheel. Pieces are measured one by one (the two
// chains of a double chainsaw run opposite ways), straight runs take the wheel whose circle they
// leave from, and a tyre that turns with its own wheel is no belt and stays as it is.
import * as THREE from 'three';

export const BELT_SLOTS = 16; // (moving pieces per material that can scroll apart: uniform vec2 xoBeltOff[16])
const SHADER = 'ba811382';
const AIM = /^aim(yaw|pitch)$/i; // (a turret turning round is no wheel a belt runs over)
const WHEELISH = /wheel|whl|pull?e?y|gear|sprocket|roller|rotator/i; // (of two coaxial drives, the wheel: not a saw blade beside it)
const SECTORS = 72; // 5 degrees each

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();

// The parts of a model that turn round (>= 179 degrees in a clip, or across a pose set): bone ->
// { bone, axis: in the bone's own frame, total }. Clip rotations are offsets after the bone's rest
// rotation (Animator.applyDelta), so their axis is in the bone's frame.
function turningNodes(a) {
  const out = new Map();
  const note = (bone, keys) => {
    if (bone < 0 || keys.length < 2) return;
    const steps = [];
    for (let k = 1; k < keys.length; k++) {
      _q.copy(keys[k - 1]).invert().multiply(keys[k]);
      const s = Math.hypot(_q.x, _q.y, _q.z);
      if (s < 1e-7) continue;
      let ang = 2 * Math.atan2(s, _q.w);
      if (ang > Math.PI) ang -= 2 * Math.PI;
      steps.push({ ang, axis: [_q.x / s, _q.y / s, _q.z / s] });
    }
    if (!steps.length) return;
    const ref = steps.reduce((b, s) => (Math.abs(s.ang) > Math.abs(b.ang) ? s : b)).axis;
    let total = 0;
    for (const s of steps) total += s.ang * Math.sign(s.axis[0] * ref[0] + s.axis[1] * ref[1] + s.axis[2] * ref[2] || 1);
    if (Math.abs(total) < (179 * Math.PI) / 180) return;
    const was = out.get(bone);
    if (!was || Math.abs(total) > Math.abs(was.total)) out.set(bone, { bone, axis: ref, total });
  };
  const keysOf = (tr) => Array.from({ length: tr.times.length }, (_, k) => new THREE.Quaternion().fromArray(tr.r, k * 4));
  for (const [name, clip] of a.clips) {
    if (AIM.test(a.layers.get(name)?.pose?.name || '')) continue;
    for (const tr of clip.tracks) if (tr.r && tr.times.length > 1) note(a.boneIndex(tr), keysOf(tr));
  }
  for (const [name, poses] of a.blends) {
    if (AIM.test(a.layers.get(name)?.pose?.name || '')) continue;
    const first = new Map(); // node -> a track of it (its bone index)
    for (const p of poses) for (const tr of p.tracks) if (tr.r && tr.times.length && !first.has(tr.node)) first.set(tr.node, tr);
    for (const [node, tr0] of first) { // (a pose without the bone has it at rest)
      const keys = poses.map((p) => { const tr = p.tracks.find((t) => t.node === node && t.r && t.times.length); return tr ? new THREE.Quaternion().fromArray(tr.r, 0) : new THREE.Quaternion(); });
      note(a.boneIndex(tr0), keys);
    }
  }
  return [...out.values()];
}

// Connected pieces of a mesh (vertices welded by position): [{ verts: [...], tris: [first index...] }].
function piecesOf(g) {
  const pos = g.attributes.position, n = pos.count, idx = g.index;
  const par = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  const join = (x, y) => { x = find(x); y = find(y); if (x !== y) par[y] = x; };
  const at = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const j = at.get(k);
    if (j === undefined) at.set(k, i); else join(j, i);
  }
  const tri = idx ? idx.count : n;
  const v = (t) => (idx ? idx.getX(t) : t);
  for (let t = 0; t + 2 < tri; t += 3) { join(v(t), v(t + 1)); join(v(t), v(t + 2)); }
  const pieces = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let p = pieces.get(r);
    if (!p) pieces.set(r, (p = { verts: [], tris: [] }));
    p.verts.push(i);
  }
  for (let t = 0; t + 2 < tri; t += 3) pieces.get(find(v(t))).tris.push(t);
  return [...pieces.values()];
}

// How far round a turning axis a piece's vertices at one radius reach (gaps up to 45 degrees
// bridged): { span (radians), r0, r1 } for the best radius band.
function wrapOf(g, verts, c, a) {
  const pos = g.attributes.position, e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p = new THREE.Vector3();
  e1.set(1, 0, 0).cross(a);
  if (e1.lengthSq() < 0.1) e1.set(0, 1, 0).cross(a);
  e1.normalize();
  e2.crossVectors(a, e1);
  const pts = verts.map((i) => {
    p.fromBufferAttribute(pos, i).sub(c);
    p.addScaledVector(a, -p.dot(a));
    const sec = Math.floor(((Math.atan2(p.dot(e2), p.dot(e1)) + Math.PI) / (2 * Math.PI)) * SECTORS) % SECTORS;
    return { d: p.length(), sec };
  }).sort((x, y) => x.d - y.d);
  const count = new Int32Array(SECTORS);
  const span = () => {
    let occupied = 0;
    for (let s = 0; s < SECTORS; s++) if (count[s]) occupied++;
    if (!occupied) return 0;
    if (occupied === SECTORS) return 2 * Math.PI;
    let start = 0;
    while (!count[start]) start++;
    let lost = 0, run = 0; // empty runs longer than 9 sectors (45 degrees) are not crossed
    for (let k = 1; k <= SECTORS; k++) {
      if (!count[(start + k) % SECTORS]) run++;
      else { if (run > 9) lost += run; run = 0; }
    }
    return ((SECTORS - lost) / SECTORS) * 2 * Math.PI;
  };
  let best = { span: 0, r0: 0, r1: 0 }, j = 0;
  for (let i = 0; i < pts.length; i++) {
    const d0 = pts[i].d, hi = d0 + Math.max(0.008, 0.18 * d0);
    while (j < pts.length && pts[j].d <= hi) count[pts[j++].sec]++;
    if (d0 >= 0.004 && j - i >= 3) {
      const s = span();
      if (s > best.span + 1e-9) best = { span: s, r0: d0, r1: hi };
    }
    count[pts[i].sec]--;
  }
  return best;
}

// UV change per radian of the drive (a around c) on a piece's triangles: samples of du and dv,
// from each triangle's UV gradient against the rim's motion there. arc: only the band [r0, r1]
// around the axis, and only faces the motion lies in.
function slopes(g, tris, c, a, arc) {
  const pos = g.attributes.position, uv = g.attributes.uv, idx = g.index;
  const v = (t) => (idx ? idx.getX(t) : t);
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const n = new THREE.Vector3(), cen = new THREE.Vector3(), rad = new THREE.Vector3(), vel = new THREE.Vector3();
  const ku = [], kv = [];
  for (const t of tris) {
    const i0 = v(t), i1 = v(t + 1), i2 = v(t + 2);
    p0.fromBufferAttribute(pos, i0); p1.fromBufferAttribute(pos, i1); p2.fromBufferAttribute(pos, i2);
    cen.copy(p0).add(p1).add(p2).multiplyScalar(1 / 3);
    rad.copy(cen).sub(c);
    if (arc) {
      const rr = rad.clone().addScaledVector(a, -rad.dot(a)).length();
      if (rr < arc.r0 - 0.002 || rr > arc.r1 + 0.002) continue;
    }
    e1.subVectors(p1, p0); e2.subVectors(p2, p0);
    n.crossVectors(e1, e2);
    if (n.lengthSq() < 1e-14) continue;
    vel.crossVectors(a, rad); // (metres per radian)
    if (arc) { // (faces the motion runs into say nothing about it)
      const vn = vel.dot(n) / n.length();
      if (vel.lengthSq() - vn * vn < 0.81 * vel.lengthSq()) continue;
    }
    const a11 = e1.dot(e1), a12 = e1.dot(e2), a22 = e2.dot(e2), det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-18) continue;
    const ve1 = vel.dot(e1), ve2 = vel.dot(e2); // grad(f) . vel, with grad(f) = al e1 + be e2 in the plane
    const along = (f0, f1, f2) => {
      const g1 = f1 - f0, g2 = f2 - f0, al = (g1 * a22 - g2 * a12) / det, be = (g2 * a11 - g1 * a12) / det;
      return al * ve1 + be * ve2;
    };
    ku.push(along(uv.getX(i0), uv.getX(i1), uv.getX(i2)));
    kv.push(along(uv.getY(i0), uv.getY(i1), uv.getY(i2)));
  }
  return { ku, kv };
}

// The value most samples agree on, or null: the median, when at least 60% lie within 15% of it and
// few run the other way (faces mapped as mirror images of each other, as on a mudguard or a hub
// that only sits near a wheel, say nothing about a belt's motion).
function agreed(list) {
  if (list.length < 2) return null;
  const s = [...list].sort((x, y) => x - y), m = s[s.length >> 1], tol = Math.max(0.15 * Math.abs(m), 0.002);
  let near = 0, against = 0;
  for (const x of s) {
    if (Math.abs(x - m) <= tol) near++;
    else if (x * m < 0 && Math.abs(x) > tol) against++;
  }
  return near >= 0.6 * s.length && against <= 0.2 * s.length ? m : null;
}

// From u and v slopes: the scroll per radian [ku, kv], or null when they say nothing clear.
function scrollOf({ ku, kv }) {
  const u = agreed(ku), v = agreed(kv);
  const mu = u === null ? 0 : u, mv = v === null ? 0 : v, main = Math.max(Math.abs(mu), Math.abs(mv));
  if (main < 1e-3) return null;
  return [Math.abs(mu) >= 0.05 * main ? mu : 0, Math.abs(mv) >= 0.05 * main ? mv : 0];
}

// Sets up a part's belts (3D Viewer, with its Animator's clips loaded): a BeltRig, or null when it
// has none that move. Each belt material gets XO_BELT, the vertex slots (xoBeltSlot: which of its
// moving pieces a vertex is on, -1 none) and their offsets (xoBeltOff), written by update().
export function setupBelts(group, info, animator) {
  const beltMats = (info.materials || []).map((m, i) => ((m.guid || '').toLowerCase().startsWith(SHADER) && !m.invisible ? i : -1)).filter((i) => i >= 0);
  if (!beltMats.length || !animator?.skel) return null;
  const meshes = group.children.filter((c) => c.isMesh && beltMats.includes(c.userData.material) && c.geometry.attributes.uv);
  if (!meshes.length) return null;
  const nodes = info.nodes || [];
  const drives = turningNodes(animator).map((d) => {
    const m = nodes[d.bone]?.matrix;
    if (!m) return null;
    const W = new THREE.Matrix4().fromArray(m);
    const a = new THREE.Vector3(...d.axis).transformDirection(W); // (normalised)
    return { ...d, a, c: new THREE.Vector3().setFromMatrixPosition(W), name: nodes[d.bone].name || '' };
  }).filter(Boolean);
  if (!drives.length) return null;
  const carries = (bone, carriers) => { // does this bone (or one it turns) carry the piece?
    for (let c of carriers) for (let n = 0; c >= 0 && n < 512; c = nodes[c]?.parent ?? -1, n++) if (c === bone) return true;
    return false;
  };
  // every piece of every belt mesh: what it wraps, and how its UVs follow
  const all = [];
  for (const mesh of meshes) {
    const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    for (const piece of piecesOf(g)) {
      const carriers = new Set();
      if (si && sw && mesh.isSkinnedMesh) for (const i of piece.verts) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0.3) carriers.add(si.getComponent(i, k));
      piece.mesh = mesh;
      piece.carriers = carriers;
      let best = null;
      for (const d of drives) {
        if (carries(d.bone, carriers)) continue;
        const w = wrapOf(g, piece.verts, d.c, d.a);
        const score = w.span + (WHEELISH.test(d.name) ? Math.PI / 6 : 0);
        if (w.span >= (100 * Math.PI) / 180 && (!best || score > best.score)) best = { d, w, score };
      }
      if (best) {
        const k = scrollOf(slopes(g, piece.tris, best.d.c, best.d.a, best.w));
        if (k) Object.assign(piece, { drive: best.d, band: best.w, k, how: 'wraps' });
      }
      all.push(piece);
    }
  }
  // Straight runs: the belt of a wrapped piece whose circle they leave from. Its texture moves at the
  // same rate as round the wheel (as one slide of the whole texture would move it); the run's own
  // UVs only say which way (they may run the other way round). (Measured on the run itself, its
  // inner and outer faces would differ by the belt's thickness.)
  const wrapped = all.filter((p) => p.drive);
  for (const piece of all) {
    if (piece.drive || !wrapped.length) continue;
    const g = piece.mesh.geometry, pos = g.attributes.position, p = new THREE.Vector3();
    let best = null;
    for (const w of wrapped) {
      const d = w.drive;
      if (carries(d.bone, piece.carriers)) continue;
      let dmin = Infinity;
      for (const i of piece.verts) {
        p.fromBufferAttribute(pos, i).sub(d.c);
        dmin = Math.min(dmin, p.addScaledVector(d.a, -p.dot(d.a)).length());
      }
      if (dmin < w.band.r0 - 0.01 || dmin > w.band.r1 + 0.01) continue;
      const s = slopes(g, piece.tris, d.c, d.a, null);
      const axis = Math.abs(w.k[0]) >= Math.abs(w.k[1]) ? 0 : 1, list = axis ? s.kv : s.ku, ref = Math.abs(w.k[axis]);
      const pos2 = list.filter((x) => x > 0.3 * ref), neg = list.filter((x) => x < -0.3 * ref);
      const side = pos2.length >= neg.length ? pos2 : neg;
      if (!list.length || side.length < 0.75 * list.length) continue;
      const m = [...side].sort((x, y) => x - y)[side.length >> 1];
      if (Math.abs(m) < 0.5 * ref || Math.abs(m) > 2 * ref) continue; // (its UVs do not follow this belt)
      const flip = Math.sign(m) === Math.sign(w.k[axis]) ? 1 : -1;
      const miss = Math.abs(dmin - (w.band.r0 + w.band.r1) / 2);
      if (!best || miss < best.miss) best = { d, k: [w.k[0] * flip, w.k[1] * flip], miss };
    }
    if (best) Object.assign(piece, { drive: best.d, k: best.k, how: 'runs off' });
  }
  // slots per material (meshes sharing a material share its uniforms); the vertex attribute per mesh
  const byMat = new Map(); // material -> { index, slots: [{ drive, k }] }
  for (const piece of all) {
    if (!piece.drive) continue;
    const mat = piece.mesh.material;
    let e = byMat.get(mat);
    if (!e) byMat.set(mat, (e = { index: piece.mesh.userData.material, slots: [] }));
    const same = (s) => s.drive === piece.drive && Math.abs(s.k[0] - piece.k[0]) < 1e-3 && Math.abs(s.k[1] - piece.k[1]) < 1e-3;
    let slot = e.slots.findIndex(same);
    if (slot < 0 && e.slots.length < BELT_SLOTS) { e.slots.push({ drive: piece.drive, k: piece.k }); slot = e.slots.length - 1; }
    piece.slot = slot;
  }
  if (!byMat.size) return null;
  for (const mesh of meshes) {
    const g = mesh.geometry, n = g.attributes.position.count;
    let attr = g.attributes.xoBeltSlot;
    if (!attr || attr.count !== n) g.setAttribute('xoBeltSlot', (attr = new THREE.BufferAttribute(new Float32Array(n), 1)));
    attr.array.fill(-1);
    for (const piece of all) if (piece.mesh === mesh && piece.drive && piece.slot >= 0) for (const i of piece.verts) attr.array[i] = piece.slot;
    attr.needsUpdate = true;
  }
  const rig = new BeltRig(animator, byMat);
  rig.pieces = all.map((p) => ({ material: p.mesh.userData.material, verts: p.verts.length, drive: p.drive?.name || null, how: p.how || null, k: p.k || null, band: p.band ? [p.band.r0, p.band.r1] : null }));
  return rig;
}

export class BeltRig {
  constructor(animator, byMat) {
    this.a = animator;
    this.mats = [...byMat.entries()].map(([m, e]) => ({ m, index: e.index, slots: e.slots }));
    this.drives = [...new Set(this.mats.flatMap((x) => x.slots.map((s) => s.drive)))].map((d) => ({ d, prev: null, last: 0, acc: 0 }));
    for (const { m } of this.mats) {
      const u = m.userData.xo.u;
      u.xoBeltOff ||= { value: Array.from({ length: BELT_SLOTS }, () => new THREE.Vector2()) };
      m.defines = { ...(m.defines || {}), XO_BELT: '' };
      m.needsUpdate = true;
    }
    this.update();
  }

  // How far each drive has turned since the start (its turn about its axis from rest, unwrapped
  // frame to frame: a step of more than 120 degrees is taken in the direction it was turning), and
  // each moving piece's texture offset from that (kept within one repeat: the textures wrap).
  update() {
    const { bones, rest } = this.a.skel;
    for (const s of this.drives) {
      const b = bones[s.d.bone], r = rest[s.d.bone];
      if (!b || !r) continue;
      _q2.copy(r.q).invert().multiply(b.quaternion);
      const ax = s.d.axis, th = 2 * Math.atan2(_q2.x * ax[0] + _q2.y * ax[1] + _q2.z * ax[2], _q2.w);
      if (s.prev === null) { s.prev = th; continue; }
      let step = th - s.prev;
      step -= 2 * Math.PI * Math.round(step / (2 * Math.PI)); // (-pi, pi]
      if (Math.abs(step) > (2 * Math.PI) / 3) {
        const alt = step - 2 * Math.PI * Math.sign(step);
        if (Math.abs(alt - s.last) < Math.abs(step - s.last)) step = alt;
      }
      s.prev = th;
      s.last = step;
      s.acc += step;
    }
    const accOf = new Map(this.drives.map((s) => [s.d, s.acc]));
    for (const { m, slots } of this.mats) {
      const off = m.userData.xo.u.xoBeltOff.value;
      slots.forEach((s, i) => {
        const t = accOf.get(s.drive) || 0, x = -s.k[0] * t, y = -s.k[1] * t;
        off[i].set(x - Math.floor(x), y - Math.floor(y));
      });
    }
  }

  // for tests: each belt material's moving pieces (drive name, UV per radian) and the turn so far
  describe() {
    return this.mats.map(({ index, slots }) => ({ material: index, slots: slots.map((s) => ({ drive: s.drive.name, k: s.k.map((x) => Math.round(x * 1e4) / 1e4), turned: this.drives.find((x) => x.d === s.drive).acc })) }));
  }
}

// Shader parts (Viewer.makeMaterial): a belt's UVs slide by its piece's offset.
export const BELT_VERT_HEAD = /* glsl */ `
#ifdef XO_BELT
attribute float xoBeltSlot;
uniform vec2 xoBeltOff[ ${BELT_SLOTS} ];
#endif
`;
export const BELT_VERT = /* glsl */ `
#ifdef XO_BELT
if ( xoBeltSlot > -0.5 ) {
	vec2 xoOff = xoBeltOff[ int( xoBeltSlot + 0.5 ) ];
	#ifdef USE_MAP
		vMapUv += xoOff;
	#endif
	#ifdef USE_NORMALMAP
		vNormalMapUv += xoOff;
	#endif
	#ifdef USE_ROUGHNESSMAP
		vRoughnessMapUv += xoOff;
	#endif
	#ifdef USE_AOMAP
		vAoMapUv += xoOff;
	#endif
	#ifdef USE_EMISSIVEMAP
		vEmissiveMapUv += xoOff;
	#endif
	#ifdef USE_ALPHAMAP
		vAlphaMapUv += xoOff;
	#endif
}
#endif
`;
