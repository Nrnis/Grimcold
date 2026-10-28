// Stickers on the builder's vehicle: the game's own (textures/stickers/<pack>/<name>, 858 of them
// in 70 packs), projected onto a part where it was clicked (three.js DecalGeometry) and kept with
// that part: a child of its model, so it moves, turns and mirrors with it. A sticker is stored in the
// part's own space ({ base, pos, normal, up, size }: build.js transformOf), its mesh rebuilt from that.
import * as THREE from 'three';
import { DecalGeometry } from './lib/three/DecalGeometry.js';

const DATA = 'https://xo.data';
export const STICKER_DIR = 'textures/stickers/';
export const SIZE = { min: 0.1, max: 3, def: 0.6 }; // metres across
const DEPTH = 0.35; // how far in front of and behind the surface it reaches (metres): curved parts take it whole

// The packs from the game's file list ({ name } with .tfd names): pack -> its stickers' bases, sorted.
export function stickerPacks(files) {
  const packs = new Map();
  for (const f of files || []) {
    const n = f.name;
    if (!n.startsWith(STICKER_DIR) || !n.endsWith('.tfd')) continue;
    const rest = n.slice(STICKER_DIR.length, -4), cut = rest.indexOf('/');
    if (cut < 0) continue;
    const pack = rest.slice(0, cut);
    if (!packs.has(pack)) packs.set(pack, []);
    packs.get(pack).push(n.slice(0, -4));
  }
  for (const list of packs.values()) list.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return new Map([...packs.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })));
}

// A pack's folder as a label: 14feb -> 14 Feb, new_year2018 -> New year 2018, bp -> BP.
const MONTHS = { jan: 'Jan', feb: 'Feb', mar: 'Mar', march: 'March', apr: 'Apr', april: 'April', may: 'May', jun: 'Jun', jul: 'Jul', aug: 'Aug', sep: 'Sep', oct: 'Oct', nov: 'Nov', dec: 'Dec' };
export function packLabel(pack) {
  if (/^[a-z]{1,3}$/.test(pack)) return pack.toUpperCase();
  const s = pack.replace(/^(\d+)([a-z]+)$/, (m, d, w) => `${d} ${MONTHS[w] || w}`).replace(/_/g, ' ').replace(/([a-z])(\d)/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// A sticker's picture as the game's texture decoded (PNG from the host): a small one for the list,
// the full one on the vehicle. Textures are shared by every sticker of that base.
export const thumbUrl = (base, max = 96) => `${DATA}/png?base=${encodeURIComponent(base)}&max=${max}`;
const textures = new Map(); // base -> Promise<THREE.Texture>
export function stickerTexture(base) {
  if (!textures.has(base)) {
    textures.set(base, (async () => {
      const r = await fetch(thumbUrl(base, 512));
      if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
      // (a bitmap is not flipped by WebGL: flipped here, so the picture's top is the decal's +v)
      const img = await createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none' });
      const t = new THREE.Texture(img);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      t.needsUpdate = true;
      return t;
    })());
    textures.get(base).catch(() => textures.delete(base)); // (a failed read is tried again next time)
  }
  return textures.get(base);
}

// The model's own meshes of a part (not its stickers, firing arc or other helpers): what a sticker lies on.
export function surfaceMeshes(group) {
  const own = new Set(group.userData.materials || []);
  const out = [];
  group.traverse((o) => {
    if (!o.isMesh || o.userData.sticker || !o.geometry?.attributes?.position || !o.geometry.attributes.normal) return;
    for (let p = o.parent; p && p !== group; p = p.parent) if (p.name === 'arc' || p.userData.sticker) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (own.size && !mats.some((m) => own.has(m))) return;
    out.push(o);
  });
  return out;
}

// Where a sticker lies, in world space, from its part-local record: the projector's place and turn
// (its z along the surface's normal, out of it, so its x runs to the right as one looks at the
// surface: into it, the picture came out mirrored; its y the sticker's up) and its size.
function projector(group, s) {
  group.updateMatrixWorld(true);
  const M = group.matrixWorld, N = new THREE.Matrix3().getNormalMatrix(M);
  const pos = new THREE.Vector3().fromArray(s.pos).applyMatrix4(M);
  const n = new THREE.Vector3().fromArray(s.normal).applyMatrix3(N).normalize();
  let up = new THREE.Vector3().fromArray(s.up).transformDirection(M);
  up.addScaledVector(n, -up.dot(n));
  if (up.lengthSq() < 1e-8) up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1);
  up.normalize();
  const z = n.clone(), x = new THREE.Vector3().crossVectors(up, z).normalize(), y = new THREE.Vector3().crossVectors(z, x);
  const euler = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  return { pos, euler, size: new THREE.Vector3(s.size, s.size, DEPTH * 2) };
}

const material = (tex) => new THREE.MeshStandardMaterial({
  map: tex, transparent: true, depthWrite: false, alphaTest: 0.02, roughness: 0.55, metalness: 0,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
});

// The sticker's mesh on the part (a group of one mesh per surface mesh it touches, in the part's own
// space, a child of it), or null when it touches nothing. tex: its texture (preview: a see-through one).
export function stickerMesh(group, s, tex, { opacity = 1 } = {}) {
  const pr = projector(group, s);
  const inv = group.matrixWorld.clone().invert();
  const out = new THREE.Group();
  out.name = 'sticker';
  out.userData.sticker = true;
  const mat = material(tex);
  if (opacity < 1) mat.opacity = opacity;
  for (const m of surfaceMeshes(group)) {
    const g = new DecalGeometry(m, pr.pos, pr.euler, pr.size);
    if (!g.attributes.position || g.attributes.position.count === 0) { g.dispose(); continue; }
    g.applyMatrix4(inv); // (world -> the part's own space: it rides along as a child)
    const mesh = new THREE.Mesh(g, mat);
    mesh.userData.sticker = true;
    mesh.renderOrder = 2;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    out.add(mesh);
  }
  if (!out.children.length) { mat.dispose(); return null; }
  out.userData.base = s.base;
  return out;
}

export function disposeSticker(obj) {
  if (!obj) return;
  obj.parent?.remove(obj);
  const mats = new Set();
  obj.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); mats.add(o.material); } });
  for (const m of mats) m.dispose(); // (the texture stays: other stickers share it)
}

// A sticker record from a hit on a part: the point and the surface's normal (world), turned by angle
// (radians, about the normal) from upright, size in metres; stored in the part's own space.
export function stickerAt(group, base, point, normal, angle, size) {
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert(), Ninv = new THREE.Matrix3().getNormalMatrix(inv);
  const n = normal.clone().normalize();
  let up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, -1); // (on a roof: up towards the front)
  up.addScaledVector(n, -up.dot(n)).normalize().applyAxisAngle(n, -angle);
  const r = (v) => v.toArray().map((x) => Math.round(x * 1e5) / 1e5);
  return {
    base, size: Math.round(size * 1000) / 1000,
    pos: r(point.clone().applyMatrix4(inv)),
    normal: r(n.clone().applyMatrix3(Ninv).normalize()),
    up: r(up.clone().transformDirection(inv)),
  };
}

// The sticker meshes of a part for an export: world space, one entry per mesh piece.
export function stickerExport(group) {
  const out = [];
  group.updateMatrixWorld(true);
  for (const c of group.children) {
    if (!c.userData.sticker || !c.userData.base) continue;
    c.traverse((m) => {
      if (!m.isMesh) return;
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      const pos = Array.from(g.attributes.position.array), nor = Array.from(g.attributes.normal.array), uv = Array.from(g.attributes.uv.array);
      g.dispose();
      for (let i = 1; i < uv.length; i += 2) uv[i] = 1 - uv[i]; // (glTF's v runs down from the picture's top)
      out.push({ base: c.userData.base, positions: pos, normals: nor, uvs: uv });
    });
  }
  return out;
}
