// Firing arcs: the space a weapon can aim into, drawn as a see-through dome around its turret the
// way the garage shows it. The limits come from the weapon's own animation layers (.model):
// "poseParameter AimYaw -180 180" (turn) and "poseParameter AimPitch -22 30" (tilt; files list
// some ranges high-to-low, e.g. 60 -29). Measured on the models: at rest a weapon points along +Z,
// positive pitch tilts it up, positive yaw turns it towards -X. The dome is centred on the turn
// axis at the height of the tilt axis; those pivots are the nodes the two layers rotate.
import * as THREE from 'three';
import { loadClip } from './anim.js';

const DEG = Math.PI / 180;
const cache = new Map(); // model path -> Promise<aim | null>

// After the game data changed.
export function flushAims() { cache.clear(); }

// { yaw: [min, max], pitch: [min, max], center: Vector3 } in model space, or null (no aim layers:
// fixed weapons, melee, guided launchers).
export function weaponAim(info) {
  if (!info?.path?.startsWith('models/weapons/')) return Promise.resolve(null);
  if (!cache.has(info.path)) {
    const p = findAim(info).catch(() => null);
    cache.set(info.path, p);
  }
  return cache.get(info.path);
}

async function findAim(info) {
  const layers = info.layers || [];
  const layer = (name) => layers.find((l) => l.pose && l.pose.name === name && (l.file || l.files?.length));
  const yawL = layer('AimYaw'), pitchL = layer('AimPitch');
  if (!yawL && !pitchL) return null;
  const range = (l) => (l ? [Math.min(l.pose.min, l.pose.max), Math.max(l.pose.min, l.pose.max)] : [0, 0]);
  const nodes = info.nodes || [];
  const index = new Map(nodes.map((n, i) => [n.name, i]));
  const depth = (i) => { let d = 0; while (d < 64 && nodes[i] && nodes[i].parent >= 0 && nodes[i].parent !== i) { i = nodes[i].parent; d++; } return d; };
  const at = (i) => new THREE.Vector3(nodes[i].matrix[12], nodes[i].matrix[13], nodes[i].matrix[14]);
  // The top-most node the layer turns: one whose rotation strays from where it starts, at any key
  // (a full -180..180 turn ends where it began: comparing the two ends found nothing, and the dome
  // was centred on the gun's trunnion instead of the turret's axis) or in any pose of a blend (a
  // pose without the node has it at rest).
  const pivot = async (l) => {
    if (!l) return null;
    const clips = l.file ? [await loadClip(l.file)] : await Promise.all(l.files.map(loadClip));
    const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(), rest = new THREE.Quaternion();
    const turn = new Map(); // node index -> largest angle away from its first key / pose
    const note = (node, a) => { const i = index.get(node); if (i !== undefined) turn.set(i, Math.max(turn.get(i) || 0, a)); };
    if (clips.length === 1) {
      for (const tr of clips[0].tracks) {
        if (!tr.r) continue;
        q0.fromArray(tr.r, 0);
        for (let k = 1; k < tr.r.length / 4; k++) note(tr.node, q0.angleTo(q1.fromArray(tr.r, k * 4)));
      }
    } else {
      const nodes = new Set(clips.flatMap((c) => c.tracks.filter((t) => t.r).map((t) => t.node)));
      for (const node of nodes) {
        const qs = clips.map((c) => { const t = c.tracks.find((x) => x.node === node && x.r); return t ? new THREE.Quaternion().fromArray(t.r, 0) : rest; });
        for (const q of qs) note(node, qs[0].angleTo(q));
      }
    }
    const turned = [...turn].filter(([, a]) => a > 2 * DEG).map(([i]) => i);
    turned.sort((a, b) => depth(a) - depth(b));
    return turned.length ? at(turned[0]) : null;
  };
  const [yp, pp] = await Promise.all([pivot(yawL), pivot(pitchL)]);
  const base = yp || pp;
  if (!base) return null;
  const center = new THREE.Vector3(base.x, (pp || base).y, base.z);
  return { yaw: range(yawL), pitch: range(pitchL), center };
}

// The unit direction for a yaw / pitch pair (degrees).
function dir(y, p) {
  const yr = y * DEG, pr = p * DEG;
  return new THREE.Vector3(-Math.sin(yr) * Math.cos(pr), Math.sin(pr), Math.cos(yr) * Math.cos(pr));
}

const VERT = /* glsl */ `
varying vec3 vN, vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
// Glassy: faint where the surface faces the camera, brighter towards the silhouette.
const FRAG = /* glsl */ `
uniform vec3 color;
uniform float base, rim;
varying vec3 vN, vV;
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  gl_FragColor = vec4(color, base + rim * f * f);
}`;

let sharedMat = null, sharedLineMat = null;
function materials() {
  if (!sharedMat) {
    sharedMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG,
      uniforms: { color: { value: new THREE.Color(0xdfe9f2) }, base: { value: 0.05 }, rim: { value: 0.42 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    sharedLineMat = new THREE.LineBasicMaterial({ color: 0xeaf2f8, transparent: true, opacity: 0.4, depthWrite: false });
  }
  return [sharedMat, sharedLineMat];
}

// A group holding the dome (radius 1, around aim.center: its scale is its radius, see arcBase) and
// its outline. The cones that close it at the highest and lowest tilt are a mesh of their own
// (userData.cones, null when there are none) that the Cones switch hides. Not pickable, casts no
// shadow, writes no depth.
export function arcObject(aim) {
  const R = 1;
  const [y0, y1] = aim.yaw, [p0, p1] = aim.pitch;
  const full = y1 - y0 >= 359;
  const flatYaw = y1 - y0 < 0.5; // no turning: a vertical fan
  const ny = flatYaw ? 0 : Math.max(2, Math.ceil((y1 - y0) / 5)), np = Math.max(1, Math.ceil((p1 - p0) / 5));
  const ys = Array.from({ length: ny + 1 }, (_, i) => y0 + ((y1 - y0) * i) / Math.max(1, ny));
  const ps = Array.from({ length: np + 1 }, (_, j) => p0 + ((p1 - p0) * j) / np);
  const shell = { pos: [], nrm: [] }, cone = { pos: [], nrm: [] };
  const O = new THREE.Vector3();
  const tri = (a, b, c, na, nb, nc, to = shell) => {
    to.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    if (!na) { na = nb = nc = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize(); }
    to.nrm.push(na.x, na.y, na.z, nb.x, nb.y, nb.z, nc.x, nc.y, nc.z);
  };
  const P = (y, p) => dir(y, p).multiplyScalar(R);
  if (!flatYaw) {
    for (let i = 0; i < ny; i++) for (let j = 0; j < np; j++) { // the outer shell
      const a = dir(ys[i], ps[j]), b = dir(ys[i + 1], ps[j]), c = dir(ys[i + 1], ps[j + 1]), d = dir(ys[i], ps[j + 1]);
      tri(a.clone().multiplyScalar(R), b.clone().multiplyScalar(R), c.clone().multiplyScalar(R), a, b, c);
      tri(a.clone().multiplyScalar(R), c.clone().multiplyScalar(R), d.clone().multiplyScalar(R), a, c, d);
    }
    for (let i = 0; i < ny; i++) { // the cones at the highest and lowest pitch close the shape
      if (Math.abs(p1) < 89.5) tri(O, P(ys[i], p1), P(ys[i + 1], p1), null, null, null, cone);
      if (Math.abs(p0) < 89.5 && p1 - p0 > 0.5) tri(O, P(ys[i + 1], p0), P(ys[i], p0), null, null, null, cone);
    }
  }
  if (!full) for (const y of flatYaw ? [y0] : [y0, y1]) // the side walls (a turret that cannot go all the way round)
    for (let j = 0; j < np; j++) tri(O, P(y, ps[j]), P(y, ps[j + 1]));
  const geometry = ({ pos, nrm }) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    return g;
  };
  const g = geometry(shell);
  // outline: the top and bottom rims, and the edges of the side walls
  const lp = [];
  const seg = (a, b) => lp.push(a.x, a.y, a.z, b.x, b.y, b.z);
  if (!flatYaw) for (let i = 0; i < ny; i++) { seg(P(ys[i], p1), P(ys[i + 1], p1)); if (p1 - p0 > 0.5) seg(P(ys[i], p0), P(ys[i + 1], p0)); }
  if (!full) for (const y of flatYaw ? [y0] : [y0, y1]) {
    for (let j = 0; j < np; j++) seg(P(y, ps[j]), P(y, ps[j + 1]));
    seg(O, P(y, p0));
    seg(O, P(y, p1));
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const [mat, lineMat] = materials();
  const mesh = new THREE.Mesh(g, mat), lines = new THREE.LineSegments(lg, lineMat);
  const cones = cone.pos.length ? new THREE.Mesh(geometry(cone), mat) : null;
  const group = new THREE.Group();
  group.name = 'arc';
  group.add(mesh, lines);
  if (cones) { cones.name = 'cones'; group.add(cones); }
  group.position.copy(aim.center);
  for (const o of [mesh, lines, cones]) if (o) { o.raycast = () => {}; o.renderOrder = 6; }
  group.userData.aim = aim;
  group.userData.cones = cones;
  return group;
}

export function disposeArc(group) {
  if (!group) return;
  group.parent?.remove(group);
  group.traverse((o) => o.geometry?.dispose());
}

// The dome's radius is the part's size (half its box's diagonal) times the Arc size setting
// (ARC_SIZE.def unless the user picked another; one setting for every weapon, so each dome keeps
// to its own weapon's scale). It used to be the whole diagonal, held within 1 and 3.5 m.
export const ARC_SIZE = { min: 0.4, max: 3, def: 1.2 };
export function arcBase(box) { return Math.max(0.1, box.getSize(new THREE.Vector3()).length() / 2); }
