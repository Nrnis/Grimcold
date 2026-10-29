// Drive (Maps): the Vehicle Builder's vehicle taken for a drive on the open map with W A S D. The
// game's numbers set how it goes (garage.js vehicleStats): its cabin's engine power and top speed,
// its mass against its tonnage (an overloaded one is slow to pull away), its movement parts' power
// penalties and speed caps, an engine's bonus. Arcade physics: its wheels, tracks, legs or hovers rest
// on the ground and on the map's objects (bridges, ramps, rooftops: mapview.js segmentHit), the body
// tilts with them, it leaves the ground over a crest and lands; buildings and walls steeper than 50
// degrees stop it, what breaks in the game breaks (with the game's destruction effects and sounds).
// Steering (ST) wheels turn it like a car; tracks, legs and a vehicle without ST wheels skid round.
// A gamepad drives it too (readPad): the left stick (or the triggers) drives and steers, the right
// stick looks round, A or the right bumper fires, B brakes, Y sounds the horn, Back / Start ends it.
// Its wheels roll on their own animation (only the wheel turns, not its arms), steer and ride their
// springs over the ground under each (the game's WheelRotation / WheelSteer / WheelSuspension poses:
// wheelRig), and throw up dust or water; it wades through water (slower the deeper, a splash going
// in; hovers ride over it); its exhausts smoke (the game's effect for its cabin, on the cabin's fx
// nodes) and at night its headlights light the way; its tracks run (their wheels turned by the
// game's WheelRotation / TrackRotation poses, the belt texture with them: belts.js), its legs walk
// (each foot planted until it is a stride out, then the game's own step carries it ahead: gaitOf),
// its hover jets tilt their exhaust against the way it pulls and turns (tiltOf), what moves by itself moves
// (a radar's dish, a fan, an engine's belts: their idle clips; motors faster with the revs), its
// turrets turn to where the middle of the
// view looks (anim.js aimAt), and V fires its guns (firing.js). Its engine, wheels, skids, landings,
// brakes and horn (H) sound (drivesound.js). The camera follows behind it, over it (drag to look
// around, the wheel for nearer or farther); a crosshair marks what the guns aim at.
import * as THREE from 'three';
import { addLights } from './xolights.js';
import { isWheel } from './wheelmarks.js';
import { vehicleStats } from './garage.js';
import { Animator } from './anim.js';
import { DriveSound } from './drivesound.js';

const V = THREE.Vector3;
const G = 9.81;
const STEP = 1 / 60; // physics step, s
const HP = 745.7; // watts in a horsepower
const PULL = 0.3; // the game pulls away more gently than power over mass would (arcade)
const GRIP = 4; // m/s² the tyres give at most, pulling away
const SIDE = 7; // m/s² sideways at most: how sharply it turns at speed (a car's tyres, about 0.7 g)
const BRAKE = 9; // m/s² braking
const COAST = { wheel: 0.8, hover: 0.5, track: 2.5, leg: 6 }; // m/s² it slows by, let go of (legs stop walking)
const CLIMB = Math.tan(THREE.MathUtils.degToRad(50)); // ground steeper than this ahead is a wall
const SAMPLES = 8; // ground samples (the contacts farthest apart)
const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
// what a vehicle goes through, as in the game: bushes and smaller trees, small props (barrels,
// crates), and what breaks (Breakable_ entities, _de models: fences, road barriers, sheds); a
// bigger tree's trunk and anything else stop it and carry it
const BREAKS = /_de(?:_|\d|\.mdl$)/i;
const passable = (rec, i) => (rec.group === 'trees' ? rec.radii[i] < 6 : rec.radii[i] < 1.6) || /^Breakable_/.test(rec.def || '') || BREAKS.test(rec.path || '');
// what it breaks as it goes through (the rest of what it goes through, bushes and small props, it
// just goes through)
export const breakable = (rec, i) => /^Breakable_/.test(rec.def || '') || BREAKS.test(rec.path || '') || (rec.group === 'trees' && rec.radii[i] >= 1.2 && rec.radii[i] < 6);
const bush = (rec, i) => rec.group === 'trees' && rec.radii[i] < 1.2;
// the dust its wheels throw up, by what is under them (and when they skid)
const DUST = {
  ground: ['particles/materials/ground/wheel_ground', 'particles/materials/ground/wheel_ground_skid'],
  sand: ['particles/materials/sand/wheel_sand', 'particles/materials/sand/wheel_sand_arizona_skid'],
  snow: ['particles/materials/ground/wheel_ground_snow', 'particles/materials/ground/wheel_ground_snow'],
  mud: ['particles/materials/mud/wheel_mud', 'particles/materials/mud/wheel_mud_skid'],
  concrete: ['particles/materials/stone/wheel_stone', 'particles/materials/stone/wheel_stone_skid'],
  water: ['particles/materials/water/wheel_water', 'particles/materials/water/wheel_water_slip'],
};
// over water, a hover's spray by what it is (air cushions and propellers have their own)
const HOVER_WATER = (path) => (/air_cushion/.test(path) ? 'particles/materials/water/air_cushion_water' : /propeller/.test(path) ? 'particles/materials/water/propeller_water' : 'particles/materials/water/hover_water');
const WET = 0.12; // m of water under it: it wades
const UP = new V(0, 1, 0);
const turn = (a) => Math.atan2(Math.sin(a), Math.cos(a)); // (an angle into -pi..pi)

// what moves a part (by its folder): 'wheel', 'track', 'leg', 'hover', or null
export function moverOf(path) {
  const p = path || '';
  if (isWheel(p)) return 'wheel';
  if (p.includes('/chassis/tracks/')) return 'track';
  if (/\/chassis\/(legs|leg_vertical)\//.test(p)) return 'leg';
  if (/\/chassis\/(hovers|air_cushion|propellers)\//.test(p)) return 'hover';
  return null;
}

// What breaking something looks and sounds like: the game's destruction effect and sound for what
// it is made of (by its name, else its surface: 3 stone, 4 wood; trees uproot)
export function smashOf(path, surface, radius, tree) {
  const n = (path || '').toLowerCase();
  if (tree) return radius > 3 ? ['particles/destruction/tree/tree_med_uprooting', 'tree_breakable_med'] : ['particles/destruction/tree/tree_small_uprooting', 'tree_breakable_small'];
  if (/glass|window|showcase/.test(n)) return ['particles/destruction/glass/square_glass', 'car_breakable_glass'];
  if (/pumpkin/.test(n)) return ['particles/destruction/fruitage/pumpkin', 'car_breakable_pumpkin'];
  if (/sand_?bag/.test(n)) return ['particles/destruction/sand/sand_small', 'car_breakable_sandbag'];
  if (/box|crate|carton|cardboard|container_small/.test(n)) return ['particles/destruction/cardboard/boxmassive1', 'car_breakable_plastic_container'];
  if (/barrel|gas|cylinder|canister|tank_small/.test(n)) return ['particles/destruction/dust/universal', 'car_breakable_gascylinder'];
  if (/trash|garbage|rubbish|bag/.test(n)) return ['particles/destruction/dust/universal', 'car_breakable_trashbag'];
  if (/tyre|tire|wheel/.test(n)) return ['particles/destruction/dust/universal', 'car_breakable_rubber'];
  if (/brick/.test(n)) return ['particles/destruction/brick/brick_brokenpart_small', 'car_breakable_bricks'];
  if (surface === 4 || /wood|fence|plank|board|shed|barn|pallet|hut/.test(n)) return [radius > 2.5 ? 'particles/destruction/wood/wood_med' : 'particles/destruction/wood/wood_small', 'car_breakable_wood'];
  if (surface === 3 || /concrete|barier|barrier|block|stone|wall/.test(n)) return ['particles/destruction/concrete/concrete_small', 'car_breakable_bricks'];
  if (/pipe|tube/.test(n)) return ['particles/destruction/dust/universal', 'car_breakable_metal_tube'];
  return ['particles/destruction/dust/universal', 'car_breakable_metal_constr'];
}

// Breaks a map placement with the game's effect and sound for what it is made of (false: it was
// already gone)
export function smashPlacement(viewer, map, rec, i, at, surface) {
  if (!map.breakPlacement(rec, i)) return false;
  const [fx, snd] = smashOf(rec.path, surface, rec.radii[i], rec.group === 'trees');
  const m = new THREE.Matrix4().setPosition(at[0], at[1], at[2]).elements;
  viewer.fx.play(fx, () => m).catch(() => {});
  viewer.sounds.play(snd, at, { gain: 0.85, ref: 9 });
  return true;
}

// What a round does to what breaks on a map (Viewer.onHit, for every round that lands): a shell, a
// rocket, an explosive bolt or a blast breaks what it hits at once, and an explosion what stands
// within its blast too (metres, by the kind of hit); bullets, flames and beams wear it down, a few
// hits to an object (the game gives breakables health).
const BLAST = { grenade: 3, rocket: 3.5, bomb: 6, blast: 4, shell: 2.5, huge: 4, bolt: 2, plasma: 2, fusion: 3, sticky: 3, stickyHybrid: 3 };
const STRONG = new Set([...Object.keys(BLAST), 'big', 'coil']);
const worn = new Map(); // object id -> hits taken
export function shotBreaks(viewer, map, h, spec) {
  if (viewer.mode !== 'map' || !map.scene || !h?.point) return 0;
  let n = 0;
  if (h.rec && breakable(h.rec, h.index)) {
    const id = map.idOf(h.rec, h.index), k = (worn.get(id) || 0) + 1;
    worn.set(id, k);
    if ((STRONG.has(spec?.hit) || k >= 3) && smashPlacement(viewer, map, h.rec, h.index, h.point, h.surface)) { worn.delete(id); n++; }
  }
  const r = BLAST[spec?.hit] || 0;
  if (r) for (const p of map.placementsNear(h.point, r, breakable).slice(0, 6)) if (smashPlacement(viewer, map, p.rec, p.i, p.center, p.surface)) n++;
  if (worn.size > 500) worn.clear();
  return n;
}

// A part's model again (its meshes and materials shared), as a group of its own: its fire points
// are read for it afresh (Viewer.fireBones keeps them per group). (Object3D.clone would copy each
// node's user data through JSON, which cannot take the textures some of them hold.)
function copyNode(o) {
  const c = o.isMesh || o.isLine || o.isPoints ? new o.constructor(o.geometry, o.material) : new THREE.Group();
  c.name = o.name;
  c.position.copy(o.position);
  c.quaternion.copy(o.quaternion);
  c.scale.copy(o.scale);
  c.matrixAutoUpdate = o.matrixAutoUpdate;
  c.matrix.copy(o.matrix);
  c.visible = o.visible;
  c.castShadow = o.castShadow;
  c.receiveShadow = o.receiveShadow;
  c.renderOrder = o.renderOrder;
  c.frustumCulled = o.frustumCulled;
  c.userData = { ...o.userData };
  if (o.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) c.onBeforeRender = o.onBeforeRender; // (a lamp's clock)
  if (c.isMesh) c.raycast = () => {}; // (the map's picking goes through it)
  for (const ch of o.children) if (ch.name !== 'arc') c.add(copyNode(ch)); // (the builder's AR dome of a weapon's firing arc stays there)
  return c;
}
function copyOf(g) {
  const c = copyNode(g);
  c.userData.fireNodes = undefined;
  return c;
}

// ---- tracks ----
const ROLL = /^(Track|Wheel)Rotation\d*$/i; // (the parameters that turn a track's wheels round)

// How a track's rotation parameters turn its wheels, measured on the model (its Animator a with its
// clips loaded, on the group g; M: the part in the vehicle's frame): [{ name, per, r, sign }]:
// parameter degrees per degree its wheel turns, the radius the belt runs round that wheel at (where
// the belt wraps it, belts.js; a wheel inside the belt: its rim), and 1 when a higher value rolls it
// forward (-1 back). The game turns all the wheels one parameter drives alike; most tracks have one
// (WheelRotation), the raider track one per wheel size (TrackRotation1..4). An auger turns about
// the way it goes: a screw, its thread's pitch a turn (screwOf) in place of a rim's round.
export function rollsOf(a, g, M) {
  const sk = a.skel, out = [];
  const names = a.poses().map((p) => p.name).filter((n) => ROLL.test(n));
  if (!sk || !names.length) return out;
  const saved = { ...a.pose }, p = new V(), sc = new V();
  const frame = () => { // (each bone in the model's frame)
    a.apply();
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    return sk.bones.map((b) => { const q = new THREE.Quaternion(), at = new V(); inv.clone().multiply(b.matrixWorld).decompose(at, q, sc); return { q, at }; });
  };
  const turnOf = (q0, q1) => { // (from q0 to q1: the angle and the axis, in the model's frame)
    const d = q1.clone().multiply(q0.clone().invert());
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const n = Math.hypot(d.x, d.y, d.z);
    return { ang: 2 * Math.atan2(n, d.w), axis: n > 1e-9 ? new V(d.x / n, d.y / n, d.z / n) : new V(1, 0, 0) };
  };
  // where the belt wraps a wheel: its bone's name -> the belt's inner radius there (the median)
  const wraps = new Map();
  for (const piece of a.belts?.pieces || []) {
    if (piece.how !== 'wraps' || !piece.band) continue;
    if (!wraps.has(piece.drive)) wraps.set(piece.drive, []);
    wraps.get(piece.drive).push(piece.band[0]);
  }
  const median = (list) => [...list].sort((x, y) => x - y)[list.length >> 1];
  const index = new Map(sk.bones.map((b, i) => [b, i]));
  const flip = M.determinant() < 0 ? -1 : 1; // (a mirrored part turns the other way round its mirrored axis)
  for (const name of names) {
    for (const n of names) a.pose[n] = 0;
    const f0 = frame();
    a.pose[name] = 10;
    const f1 = frame();
    a.pose[name] = 0;
    const turned = new Map(); // bone -> its turn
    f0.forEach((b, i) => { const t = turnOf(b.q, f1[i].q); if (t.ang > 0.02) turned.set(i, t); });
    if (!turned.size) continue;
    // the wheels: bones it turns whose parent it does not (each with what it carries)
    const wheels = new Map();
    for (const i of turned.keys()) {
      let top = i;
      for (let up = index.get(sk.bones[top].parent); up !== undefined && turned.has(up); up = index.get(sk.bones[up].parent)) top = up;
      if (!wheels.has(top)) wheels.set(top, new Set());
      wheels.get(top).add(i);
    }
    // the belt's wheel when it turns one (the belt stands still on the ground), else its biggest
    let ref = null, r = 0;
    for (const top of wheels.keys()) {
      const w = wraps.get(sk.bones[top].name);
      if (w) { ref = top; r = median(w); break; }
    }
    if (ref === null) {
      for (const [top, bones] of wheels) {
        const rim = rimOf(g, f0[top].at, turned.get(top).axis, bones);
        if (rim > r) { r = rim; ref = top; }
      }
    }
    if (ref === null || r < 0.03) continue;
    const t = turned.get(ref), ax = t.axis.clone().transformDirection(M).multiplyScalar(flip);
    const roll = { name, per: 10 / THREE.MathUtils.radToDeg(t.ang), r, sign: Math.sign(ax.x), wheel: sk.bones[ref].name, value: 0 };
    if (Math.abs(ax.x) >= 0.5) { out.push(roll); continue; }
    // an auger: a higher value drives it along its axis one way or the other, by its thread's hand
    // (a real direction: a mirrored auger is the other hand and turns the other way)
    const screw = screwOf(g, f0[ref].at, t.axis, wheels.get(ref));
    const ahead = screw && t.axis.clone().multiplyScalar(screw.hand).transformDirection(M);
    if (!screw || Math.abs(ahead.z) < 0.5) continue; // (turned crosswise: it does not roll as the vehicle goes)
    out.push({ ...roll, r: screw.pitch / (2 * Math.PI), sign: Math.sign(ahead.z), screw: +screw.pitch.toFixed(3) });
  }
  Object.assign(a.pose, saved);
  a.apply();
  return out;
}

// An auger's thread (its vertices skinned to its bones, turning about axis through c): { hand: 1
// right-handed, -1 left (a higher turn drives a right-handed screw along its axis), pitch: metres a
// turn }, from the edges along its outer rim (the angle round the axis against the way along it).
function screwOf(g, c, axis, bones) {
  const e1 = new V(1, 0, 0).cross(axis);
  if (e1.lengthSq() < 0.1) e1.set(0, 1, 0).cross(axis);
  e1.normalize();
  const e2 = new V().crossVectors(axis, e1), p = new V();
  const meshes = [];
  let rim = 0;
  for (const m of g.children) {
    const at = m.geometry?.attributes, si = at?.skinIndex, sw = at?.skinWeight;
    if (!m.isSkinnedMesh || !si || !sw || !m.geometry.index) continue;
    const n = at.position.count, rho = new Float32Array(n), th = new Float32Array(n), al = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (bones.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      if (w < 0.5) { rho[i] = -1; continue; }
      p.fromBufferAttribute(at.position, i).sub(c);
      al[i] = p.dot(axis);
      p.addScaledVector(axis, -al[i]);
      rho[i] = p.length();
      th[i] = Math.atan2(p.dot(e2), p.dot(e1));
      rim = Math.max(rim, rho[i]);
    }
    meshes.push({ idx: m.geometry.index, rho, th, al });
  }
  let vote = 0;
  const ks = [];
  for (const { idx, rho, th, al } of meshes) {
    const edge = (i, j) => {
      if (rho[i] < 0.85 * rim || rho[j] < 0.85 * rim) return;
      let dt = th[j] - th[i];
      dt -= 2 * Math.PI * Math.round(dt / (2 * Math.PI));
      const ds = al[j] - al[i];
      if (Math.abs(dt) < 0.01 || Math.abs(ds) < 1e-4) return;
      vote += Math.sign(dt * ds) * Math.abs(dt);
      ks.push(Math.abs(dt / ds));
    };
    for (let t = 0; t + 2 < idx.count; t += 3) {
      const a = idx.getX(t), b = idx.getX(t + 1), d = idx.getX(t + 2);
      edge(a, b); edge(b, d); edge(d, a);
    }
  }
  if (ks.length < 8 || !vote) return null;
  const k = [...ks].sort((x, y) => x - y)[ks.length >> 1], pitch = (2 * Math.PI) / k;
  return pitch > 0.05 && pitch < 20 ? { hand: Math.sign(vote), pitch } : null;
}

// A wheel's rim: the farthest its vertices (skinned to its bones) lie from its axis (through c).
function rimOf(g, c, axis, bones) {
  const p = new V();
  let rim = 0;
  for (const m of g.children) {
    const at = m.geometry?.attributes, si = at?.skinIndex, sw = at?.skinWeight;
    if (!m.isSkinnedMesh || !si || !sw) continue;
    for (let i = 0; i < at.position.count; i++) {
      let w = 0;
      for (let k = 0; k < 4; k++) if (bones.has(si.getComponent(i, k))) w += sw.getComponent(i, k);
      if (w < 0.5) continue;
      p.fromBufferAttribute(at.position, i).sub(c);
      rim = Math.max(rim, p.addScaledVector(axis, -p.dot(axis)).length());
    }
  }
  return rim;
}

// ---- legs ----
const LEG = ['LegX', 'LegY', 'LegZ']; // (where a leg's foot goes from where it stands: out, down, ahead)

// How a leg's LegX / LegY / LegZ move its foot (the bone they move most; about a metre a unit),
// measured on the model (its Animator a with its clips loaded, on the group g; M: the part in the
// vehicle's frame): { K: a move of the foot in the vehicle's frame -> the three values, foot: where
// it stands (vehicle frame), lo / hi: their ranges, reach: how far it goes before it steps, most:
// how far it can (metres), step: its WALK activity (the game's lift of the foot, 0.3 to 0.4 s) }, or
// null: it does not walk (the vertical legs have no clips; a model whose foot they cannot place).
export function gaitOf(a, g, M) {
  const sk = a.skel, poses = Object.fromEntries(a.poses().map((p) => [p.name, p]));
  if (!sk || !LEG.every((n) => poses[n])) return null;
  const saved = { ...a.pose };
  const where = () => {
    a.apply();
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    return sk.bones.map((b) => new V().setFromMatrixPosition(inv.clone().multiply(b.matrixWorld)));
  };
  for (const n of LEG) a.pose[n] = 0;
  const p0 = where();
  const cols = LEG.map((n) => { // (each bone's move for a unit of it)
    const h = (0.1 * (poses[n].max - poses[n].min)) / 2;
    a.pose[n] = h;
    const p1 = where();
    a.pose[n] = 0;
    return p1.map((q, i) => q.sub(p0[i]).divideScalar(h));
  });
  Object.assign(a.pose, saved);
  a.apply();
  let foot = 0, most = -1;
  p0.forEach((_, i) => { const m = cols[0][i].length() + cols[1][i].length() + cols[2][i].length(); if (m > most) { most = m; foot = i; } });
  const [cx, cy, cz] = cols.map((c) => c[foot]);
  const J = new THREE.Matrix3().set(cx.x, cy.x, cz.x, cx.y, cy.y, cz.y, cx.z, cy.z, cz.z);
  if (Math.abs(J.determinant()) < 0.05) return null;
  const K = J.clone().invert().multiply(new THREE.Matrix3().setFromMatrix4(M).invert()); // (the vehicle's frame -> the part's -> the values)
  const walk = a.activities().find((l) => l.activity === 'WALK' && a.timeClipsOf(l.name).length);
  const dur = walk ? Math.max(...a.timeClipsOf(walk.name).map((t) => (a.clips.get(t.name)?.duration || 0) / (t.speed || 1))) : 0;
  const ahead = ((poses.LegZ.max - poses.LegZ.min) / 2) * cz.length() * new V().setFromMatrixScale(M).z; // (metres forward or back it can go)
  const chain = [];
  for (let b = sk.bones[foot]; b?.isBone; b = b.parent) chain.unshift(b);
  return {
    K, bone: foot, chain, foot: p0[foot].clone().applyMatrix4(M), lo: LEG.map((n) => poses[n].min), hi: LEG.map((n) => poses[n].max),
    reach: ahead * 0.45, most: ahead * 0.9, step: walk && dur > 0 ? { name: walk.name, dur: Math.max(0.15, dur) } : null,
  };
}

// A track's road wheels on their springs (TrackSuspension1..N, each one wheel, the bone it moves most,
// down about a metre a unit; at 0, as built, all the way up), measured on the model (its Animator a,
// on the group g; M: the part in the vehicle's frame; bottom: the height of its belt's underside as
// built): [{ name, lo, hi, rest, down, hub: the wheel as built (vehicle frame), r: from it down to
// the belt's underside }]
export function springsOf(a, g, M, bottom) {
  const sk = a.skel, out = [];
  const list = a.poses().filter((p) => /^TrackSuspension\d+$/i.test(p.name) && p.max > p.min);
  if (!sk || !list.length) return out;
  const saved = { ...a.pose }, L = new THREE.Matrix3().setFromMatrix4(M);
  const where = () => {
    a.apply();
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    return sk.bones.map((b) => new V().setFromMatrixPosition(inv.clone().multiply(b.matrixWorld)));
  };
  const p0 = where();
  for (const P of list) {
    const rest = saved[P.name] ?? P.min, step = 0.25 * (P.max - P.min);
    a.pose[P.name] = rest + step;
    const p1 = where();
    a.pose[P.name] = rest;
    let best = -1, most = 1e-4;
    p1.forEach((q, i) => { const m = q.distanceTo(p0[i]); if (m > most) { most = m; best = i; } });
    if (best < 0) continue;
    const d = p1[best].clone().sub(p0[best]).divideScalar(step).applyMatrix3(L);
    if (-d.y < 0.3) continue;
    const hub = p0[best].clone().applyMatrix4(M);
    out.push({ name: P.name, lo: P.min, hi: P.max, rest, down: -d.y, hub, r: Math.max(0.05, hub.y - bottom), ext: rest });
  }
  Object.assign(a.pose, saved);
  a.apply();
  return out;
}

// ---- exhausts and headlights ----
// The game's exhaust smoke for a cabin or an engine (by its folder: its own, its family's, else the
// plain one): the effects to try, in order
export function exhaustOf(path) {
  const dir = (path || '').split('/').slice(-2, -1)[0] || '', fam = dir.replace(/_?(cab|cabin)?_?\d+$/i, '');
  const own = { diesel_cab1: 'exhaust_smoke_diesel_cab1', diesel_cab2: 'exhaust_smoke_diesel_cab2', tribal_cab4: 'exhaust_smoke_tribal_cab4', mi24: 'exhaust_smoke_mi24', engine_flat10: 'exhaust_smoke_engine_flat10' }[dir];
  const family = { military: 'exhaust_smoke_military_cab', ravagers: 'exhaust_smoke_ravagers', workers: 'exhaust_smoke_workers', tribal: 'exhaust_tribal', scientists: 'exhaust_scientists01', diesel: 'exhaust_smoke_diesel_cab1', engine_v10: 'exhaust_smoke_engine_v10' }[fam]
    || (/^engine_v10/.test(dir) ? 'exhaust_smoke_engine_v10' : null);
  return [own, family, 'exhaust_smoke_a'].filter(Boolean).map((n) => `particles/constructor/${n}`);
}

// Where its headlights are (vehicle frame): the lamps at its front, one a side (left +X, right -X;
// one in the middle alone), else two at the front of its box. (body: its copies, as built)
function headlightsOf(body, box) {
  body.updateMatrixWorld(true);
  const inv = body.matrixWorld.clone().invert(), len = box.max.z - box.min.z, sides = new Map();
  body.traverse((o) => {
    if (!o.isMesh || !o.userData.lamp || !o.geometry?.boundingBox) return;
    const c = o.geometry.boundingBox.getCenter(new V()).applyMatrix4(o.matrixWorld).applyMatrix4(inv);
    if (c.z < box.max.z - 0.35 * len) return;
    const side = c.x > 0.2 ? 1 : c.x < -0.2 ? -1 : 0;
    if (!sides.has(side)) sides.set(side, []);
    sides.get(side).push(c);
  });
  const mean = (l) => l.reduce((a, p) => a.add(p), new V()).divideScalar(l.length);
  if (sides.has(1) || sides.has(-1)) return [1, -1].filter((k) => sides.has(k)).map((k) => mean(sides.get(k)));
  if (sides.has(0)) return [mean(sides.get(0))];
  const w = box.max.x - box.min.x, y = box.min.y + 0.45 * (box.max.y - box.min.y);
  return [new V(0.32 * w + (box.min.x + box.max.x) / 2, y, box.max.z), new V(-0.32 * w + (box.min.x + box.max.x) / 2, y, box.max.z)];
}

// ---- wheels ----
// How a wheel's WheelSuspension and WheelSteer move it, measured on the model (its Animator a with its
// clips loaded, on the group g; M: the part in the vehicle's frame; wheel: the bone its WheelRotation
// turns): { spring: { name, lo, hi, rest: its value as built (mid-travel: Animator.restSprings), down:
// metres the hub goes down a unit, hub: where it is as built (vehicle frame) } or null, steer: {
// name, lo, hi, per: values a degree, sign: 1 when a higher value turns it left (about +Y) } or null
// (a moto wheel's WheelSteer leans it: no steering) }.
export function wheelRig(a, g, M, wheel) {
  const sk = a.skel, poses = Object.fromEntries(a.poses().map((p) => [p.name, p])), out = { spring: null, steer: null };
  const i = sk ? sk.bones.findIndex((b) => b.name === wheel) : -1;
  if (i < 0) return out;
  const saved = { ...a.pose }, L = new THREE.Matrix3().setFromMatrix4(M), flip = M.determinant() < 0 ? -1 : 1;
  const at = () => {
    a.apply();
    g.updateMatrixWorld(true);
    const p = new V(), q = new THREE.Quaternion();
    g.matrixWorld.clone().invert().multiply(sk.bones[i].matrixWorld).decompose(p, q, new V());
    return { p, q };
  };
  const S = poses.WheelSuspension, T = poses.WheelSteer;
  if (S && S.max > S.min) {
    const rest = saved.WheelSuspension ?? S.min, step = 0.25 * (S.max - S.min) * (rest + 0.25 * (S.max - S.min) <= S.max ? 1 : -1);
    const p0 = at().p;
    a.pose.WheelSuspension = rest + step;
    const d = at().p.sub(p0).divideScalar(step).applyMatrix3(L); // (the hub's move a unit, vehicle frame)
    a.pose.WheelSuspension = rest;
    if (-d.y > 0.3) out.spring = { name: 'WheelSuspension', lo: S.min, hi: S.max, rest, down: -d.y, hub: p0.applyMatrix4(M) };
  }
  if (T && T.max > T.min) {
    a.pose.WheelSteer = 0;
    const q0 = at().q;
    a.pose.WheelSteer = 10;
    const q1 = at().q;
    a.pose.WheelSteer = 0;
    const d = q1.multiply(q0.invert());
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const n = Math.hypot(d.x, d.y, d.z), ang = 2 * Math.atan2(n, d.w);
    const ax = n > 1e-9 ? new V(d.x / n, d.y / n, d.z / n).applyMatrix3(L).normalize().multiplyScalar(flip) : new V();
    if (ang > 0.02 && Math.abs(ax.y) > 0.7) out.steer = { name: 'WheelSteer', lo: T.min, hi: T.max, per: 10 / THREE.MathUtils.radToDeg(ang), sign: Math.sign(ax.y) };
  }
  Object.assign(a.pose, saved);
  a.apply();
  return out;
}

// ---- what moves by itself ----
// Does a part play something over time when idle (an IDLE activity whose stack has a clip without a
// pose parameter: a radar's dish, a fan, an engine's belts)? From its .model's layers alone.
export function idleOf(info) {
  const layers = new Map((info?.layers || []).map((l) => [l.name, l]));
  const timed = (name, seen = new Set()) => {
    const l = layers.get(name);
    if (!l || seen.has(name)) return false;
    seen.add(name);
    return (!!l.file && !l.pose) || (l.add || []).some((x) => timed(x, seen));
  };
  return [...layers.values()].some((l) => l.activity === 'IDLE' && timed(l.name));
}

// ---- hover jets ----
// How a hover jet's HoverRotPitch / HoverRotRoll tilt it (its Animator a with its clips loaded, on the
// group g; M: the part in the vehicle's frame): { pitch, roll: { name, per: values a degree, sign: 1
// when a higher value turns it about the vehicle's +X (pitch: its exhaust back, as it pulls ahead) or
// +Z (roll: its exhaust to the left) }, or null }, measured on the bone each turns most.
export function tiltOf(a, g, M) {
  const sk = a.skel, poses = new Set(a.poses().map((p) => p.name)), out = { pitch: null, roll: null };
  if (!sk) return out;
  const saved = { ...a.pose }, sc = new V();
  const frame = () => {
    a.apply();
    g.updateMatrixWorld(true);
    const inv = g.matrixWorld.clone().invert();
    return sk.bones.map((b) => { const q = new THREE.Quaternion(); inv.clone().multiply(b.matrixWorld).decompose(new V(), q, sc); return q; });
  };
  const flip = M.determinant() < 0 ? -1 : 1;
  for (const [key, name, axis] of [['pitch', 'HoverRotPitch', 'x'], ['roll', 'HoverRotRoll', 'z']]) {
    if (!poses.has(name)) continue;
    a.pose[name] = 0;
    const q0 = frame();
    a.pose[name] = 10;
    const q1 = frame();
    a.pose[name] = 0;
    let best = null;
    q0.forEach((q, i) => {
      const d = q1[i].clone().multiply(q.clone().invert());
      if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
      const n = Math.hypot(d.x, d.y, d.z), ang = 2 * Math.atan2(n, d.w);
      if (ang > 0.02 && (!best || ang > best.ang)) best = { i, ang, axis: new V(d.x / n, d.y / n, d.z / n) };
    });
    if (!best) continue;
    const ax = best.axis.transformDirection(M).multiplyScalar(flip)[axis];
    if (Math.abs(ax) < 0.5) continue;
    out[key] = { name, bone: best.i, per: 10 / THREE.MathUtils.radToDeg(best.ang), sign: Math.sign(ax) };
  }
  Object.assign(a.pose, saved);
  a.apply();
  return out;
}

// Sets a leg's LegX / LegY / LegZ (its Animator a, its gait, M: the part in the vehicle's frame) so
// its foot goes D (vehicle frame) from where it stands: the values for D, then once more for what the
// clips' bends leave off (the mechanical legs' feet go a few centimetres wide at a stride; lifting,
// up and down is the step's own).
const _P = new V(), _E = new V(), _F = new THREE.Matrix4();
export function placeFoot(a, gait, M, D, lifting = false) {
  const set = () => {
    LEG.forEach((n, i) => { a.pose[n] = THREE.MathUtils.clamp(_P.getComponent(i), gait.lo[i], gait.hi[i]); });
    a.apply();
    _P.set(a.pose.LegX, a.pose.LegY, a.pose.LegZ);
  };
  _P.copy(D).applyMatrix3(gait.K);
  set();
  _F.identity();
  for (const b of gait.chain) { b.updateMatrix(); _F.multiply(b.matrix); }
  _E.setFromMatrixPosition(_F).applyMatrix4(M).sub(gait.foot); // (where it went)
  _E.subVectors(D, _E);
  if (lifting) _E.y = 0;
  _P.add(_E.applyMatrix3(gait.K));
  set();
}

// Least squares plane through points (x, z, h): h = a + b x + c z (a little held back on a narrow
// footprint, so a single row of wheels does not tip over)
function fitPlane(pts) {
  let n = 0, sx = 0, sz = 0, sh = 0, sxx = 0, szz = 0, sxz = 0, sxh = 0, szh = 0;
  for (const p of pts) {
    n++; sx += p.x; sz += p.z; sh += p.h;
    sxx += p.x * p.x; szz += p.z * p.z; sxz += p.x * p.z; sxh += p.x * p.h; szh += p.z * p.h;
  }
  if (!n) return null;
  const mx = sx / n, mz = sz / n, mh = sh / n;
  const cxx = sxx / n - mx * mx + 0.02, czz = szz / n - mz * mz + 0.02, cxz = sxz / n - mx * mz;
  const cxh = sxh / n - mx * mh, czh = szh / n - mz * mh;
  const det = cxx * czz - cxz * cxz;
  const b = det > 1e-9 ? (cxh * czz - czh * cxz) / det : 0, c = det > 1e-9 ? (czh * cxx - cxh * cxz) / det : 0;
  return { a: mh - b * mx - c * mz, b, c };
}

export class Drive {
  // build: the Vehicle Builder (build.js); mapView: Maps (mapview.js); item(path, st): a part's stats
  // (garage.js PartStats); firing(): are its guns firing (V held: firing.js); cross: the crosshair
  // element; fire(on): V pressed or let go (the mouse's left button while it aims); onChange():
  // something the panel shows changed (speed, on / off, the mouse caught)
  constructor(viewer, { build, mapView, item, firing = () => false, cross = null, fire = () => {}, onChange = () => {} }) {
    this.v = viewer;
    this.fire = fire;
    this.locked = false; // (the mouse caught: it aims, its left button fires)
    this.build = build;
    this.map = mapView;
    this.item = item;
    this.firing = firing;
    this.cross = cross;
    this.onChange = onChange;
    this.car = null; // the vehicle being driven (assemble)
    // its headlights: two spotlights lit through xolights.js's one shader loop, dark by day, lit at
    // night from its front lamps (headlights)
    this.beams = [0, 1].map(() => {
      const l = new THREE.SpotLight(0xfff0dc, 0, 80, 0.48, 0.6, 1.5);
      l.castShadow = false;
      return l;
    });
    const litBeams = this.beams.map((light) => ({ light }));
    addLights(() => litBeams);
    this.keys = new Set();
    this.look = { heading: 0, pitch: 0.28, dist: 10, drag: null, lastDrag: -1e9 };
    this.clock = 0;
    this.acc = 0;
    const c = viewer.canvas;
    c.addEventListener('pointerdown', (e) => this.pointerDown(e));
    c.addEventListener('pointermove', (e) => this.pointerMove(e));
    c.addEventListener('pointerup', (e) => this.pointerUp(e));
    c.addEventListener('pointercancel', (e) => this.pointerUp(e));
    c.addEventListener('wheel', (e) => {
      if (!this.car) return;
      e.preventDefault();
      const d = e.deltaY || e.deltaX;
      if (d) this.look.dist = THREE.MathUtils.clamp(this.look.dist * Math.exp(Math.sign(d) * 0.12), this.car.size * 0.9, this.car.size * 12 + 20);
    }, { passive: false });
    // a click on the view while it drives catches the mouse (as the game has it): moving it aims, its
    // left button fires; Esc lets it go (and Esc again stops driving)
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = !!this.car && document.pointerLockElement === c;
      if (was && !this.locked) this.fire(false);
      this.onChange();
    });
    document.addEventListener('mousemove', (e) => { if (this.locked && this.car) this.lookBy(e.movementX || 0, e.movementY || 0, 0.0022, 0.0017); });
    // (another window: the keys let go, the sounds stop; back: they come again)
    window.addEventListener('blur', () => { this.keys.clear(); this.sound?.stop(); });
    window.addEventListener('focus', () => { if (this.car) this.sound?.start(this.state.pos.toArray()); });
    viewer.frameHooks.push(() => this.tick());
  }

  get active() { return !!this.car; }

  // ---- the vehicle ----
  // Copies of the builder's parts in its own frame (+Z ahead, +Y up), where its wheels, tracks, legs
  // and hovers touch the ground, and the game's numbers for it. { why } when it cannot go.
  assemble() {
    const b = this.build;
    b.root.updateMatrixWorld(true);
    const inv = b.root.matrixWorld.clone().invert();
    const parts = b.instances.filter((i) => i.group && i.group.visible !== false);
    if (!parts.length) return { why: 'Build a vehicle in the Vehicle Builder first (a cabin and wheels, tracks, legs or hovers).' };
    const contacts = [], wheels = [], box = new THREE.Box3();
    const body = new THREE.Group();
    body.name = 'driven vehicle';
    body.matrixAutoUpdate = false;
    const guns = [], tracks = [], legs = [], hovers = [], idles = [], exhausts = [];
    let hoverLift = 0;
    for (const i of parts) {
      const M = inv.clone().multiply(i.group.matrixWorld); // (the part in the builder's frame)
      const lb = i.group.userData.box;
      box.union(lb.clone().applyMatrix4(M));
      const copy = copyOf(i.group);
      copy.matrixAutoUpdate = false;
      const kind = moverOf(i.path);
      if (kind === 'wheel') {
        // the wheel turns about its hub: about the vehicle's X (rolling) and, a steering one, Y
        const hub = lb.getCenter(new V()).applyMatrix4(M);
        const r = Math.max(0.15, ((lb.max.y - lb.min.y) / 2) * new V().setFromMatrixScale(M).y);
        const steer = new THREE.Group(), spin = new THREE.Group();
        steer.position.copy(hub);
        steer.add(spin);
        copy.matrix.copy(new THREE.Matrix4().makeTranslation(-hub.x, -hub.y, -hub.z).multiply(M));
        spin.add(copy);
        body.add(steer);
        wheels.push({ steer, spin, r, st: !!i.st, angle: 0, still: copy, info: i.info, matrix: M.clone(), contact: contacts.length });
        contacts.push({ p: hub.clone().add(new V(0, -r, 0)), kind, st: !!i.st, path: i.path });
      } else {
        copy.matrix.copy(M);
        body.add(copy);
        if (kind) {
          const at = (x, y, z) => new V(x, y, z).applyMatrix4(M);
          const c = lb.getCenter(new V());
          if (kind === 'track') { // (along its length: both ends and the middle)
            const end = Math.min(0.4, (lb.max.z - lb.min.z) * 0.2), first = contacts.length;
            for (const z of [lb.min.z + end, c.z, lb.max.z - end]) contacts.push({ p: at(c.x, lb.min.y, z), kind, path: i.path });
            tracks.push({ group: copy, info: i.info, matrix: M.clone(), centre: at(c.x, c.y, c.z), contacts: [first, first + 1, first + 2], bottom: at(c.x, lb.min.y, c.z).y });
          } else {
            contacts.push({ p: at(c.x, lb.min.y, c.z), kind, path: i.path });
            if (kind === 'hover') { hoverLift = 0.7; hovers.push({ group: copy, info: i.info, matrix: M.clone() }); }
            if (kind === 'leg') legs.push({ group: copy, info: i.info, matrix: M.clone() });
          }
        }
      }
      if (i.path.startsWith('models/weapons/')) guns.push({ group: copy, info: i.info, matrix: M.clone() });
      // its exhausts: a cabin's (or an engine's) fx nodes, the game's smoke along each one's +Y
      if (/\/cabins\/|\/modules\/engine_/.test(i.path)) {
        for (const n of i.info.nodes || []) if (/^fx_?\d*$/i.test(n.name || '') && exhausts.length < 6) exhausts.push({ m: M.clone().multiply(new THREE.Matrix4().fromArray(n.matrix)), path: i.path });
      }
      if (kind !== 'wheel' && idleOf(i.info)) idles.push({ group: copy, info: i.info, matrix: M.clone(), motor: /\/cabins\/|\/modules\/engine_/.test(i.path) });
    }
    if (!contacts.length) {
      for (const c of [...body.children]) this.dropCopy(c);
      return { why: 'This vehicle has nothing to drive on: give it wheels, tracks, legs or hovers in the Vehicle Builder.' };
    }
    // where it stands: the middle of its footprint, at the height of its contacts
    const pivot = new V();
    for (const c of contacts) pivot.add(c.p);
    pivot.divideScalar(contacts.length);
    const rel = contacts.map((c) => ({ ...c, x: c.p.x - pivot.x, y: c.p.y - pivot.y, z: c.p.z - pivot.z }));
    // the ground is felt at the contacts farthest apart (corners first); the dust comes off the
    // outermost four
    const byReach = rel.slice().sort((a, b) => (b.x * b.x + b.z * b.z) - (a.x * a.x + a.z * a.z));
    const samples = byReach.slice(0, SAMPLES);
    const dusty = byReach.filter((c) => c.kind === 'wheel' || c.kind === 'track').slice(0, 4)
      .concat(byReach.filter((c) => c.kind === 'hover').slice(0, 4)); // (hovers: spray over water)
    for (const w of wheels) { w.rel = rel[w.contact]; w.x = w.rel.x; } // (its contact, as the ground is felt there)
    for (const t of tracks) t.rels = t.contacts.map((k) => rel[k]);
    // steering: ST wheels turn it like a car about the axle of the others (a rear-steered one turns
    // the other way); tracks, legs, hovers and a vehicle without ST wheels skid round
    const st = rel.filter((c) => c.kind === 'wheel' && c.st), fixed = rel.filter((c) => !(c.kind === 'wheel' && c.st));
    const zSt = st.length ? st.reduce((a, c) => a + c.z, 0) / st.length : 0, zFix = fixed.length ? fixed.reduce((a, c) => a + c.z, 0) / fixed.length : 0;
    const carLike = st.length > 0 && fixed.length > 0 && !rel.some((c) => c.kind === 'track' || c.kind === 'leg');
    // what mostly moves it (for its sounds)
    const count = {};
    for (const c of rel) count[c.kind] = (count[c.kind] || 0) + (c.kind === 'track' ? 1 / 3 : 1);
    const mover = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
    // the game's numbers (vehicleStats: the cabin's top speed and power, the mass, the tonnage)
    const vs = vehicleStats(parts.map((i) => ({ path: i.path, st: i.st })), { item: this.item });
    let powerMul = 0, engines = 0, cabinPath = '';
    for (const i of parts) {
      const it = this.item(i.path, i.st);
      if (it?.kind === 'cabin' && !cabinPath) cabinPath = i.path;
      if (!it || it.kind === 'cabin') continue;
      if (it.type === 'Engine' && ++engines > 1) continue; // (one engine counts)
      powerMul += it.powerMul || 0;
    }
    if (!cabinPath) cabinPath = parts.find((i) => i.path.includes('/cabins/'))?.path || '';
    const mass = Math.max(400, vs.mass || parts.length * 250);
    const size = box.getSize(new V());
    const local = box.clone().translate(pivot.clone().negate()); // (the body's box about where it stands)
    for (const t of tracks) t.x = t.centre.x - pivot.x; // (its side: skidding round, the outer one runs faster)
    return {
      body, wheels, guns, tracks, legs, hovers, idles, exhausts, pivot, samples, dusty, box: local, size: Math.max(size.x, size.y, size.z), height: size.y,
      carLike, wheelbase: Math.max(0.8, Math.abs(zSt - zFix)), steerSign: zSt >= zFix ? 1 : -1, mover, cabinPath, cabinType: vs.cabin?.type || '',
      top: Math.max(5, (vs.speed || 70) / 3.6), mass, watts: (vs.cabin?.enginePower || 1500) * Math.max(0.2, 1 + powerMul / 100) * HP,
      over: vs.tonnage && vs.mass > vs.tonnage ? Math.max(0.35, vs.tonnage / vs.mass) : 1, lift: hoverLift, stats: vs,
    };
  }

  dropCopy(c) { c.removeFromParent(); } // (shared geometry and materials stay the builder's)

  // Its turrets: an animated copy of each gun that aims (the game's AimYaw / AimPitch), in place of
  // the still one, turned each frame towards what the middle of the view looks at (aimAt) and playing
  // its Fire clip while V is held. Guns that cannot turn keep their still copies.
  async armTurrets(car) {
    for (const g of car.guns) {
      if (!(g.info.layers || []).some((l) => l.pose)) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(g.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(g.group) });
        if (this.car !== car || !copy.userData.skeleton) throw 0;
        const a = new Animator(this.v, g.info, copy);
        await a.load();
        if (this.car !== car || !a.aimRig()) throw 0;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(g.matrix);
        car.body.add(copy);
        g.group.visible = false;
        g.still = g.group;
        g.group = copy;
        g.anim = a;
        g.fire = [...a.layers.values()].find((l) => l.turns) || [...a.layers.values()].find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || '')) || null; // (its barrels in turn: Animator)
        g.idle = a.active; // (its idle, when that moves anything: played between shots)
        g.copy = copy;
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
  }

  // Its wheels: an animated copy of each that has the game's WheelRotation (only the wheel turns: the
  // still copy spun whole, its arms and shocks with it), in place of the still one; steered and on
  // its springs (wheelRig): it stands where the builder shows it, mid-travel as the game does, so a
  // wheel can rise over a bump and drop into a dip.
  async armWheels(car) {
    for (const w of car.wheels) {
      if (!(w.info.layers || []).some((l) => l.pose?.name === 'WheelRotation')) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(w.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(w.still) });
        if (this.car !== car || !copy.userData.skeleton) throw 0;
        const a = new Animator(this.v, w.info, copy);
        await a.load();
        if (this.car !== car) throw 0;
        const roll = rollsOf(a, copy, w.matrix).find((r) => r.name === 'WheelRotation');
        if (!roll) throw 0;
        const rig = wheelRig(a, copy, w.matrix, roll.wheel);
        copy.matrixAutoUpdate = false;
        if (rig.steer) {
          copy.matrix.copy(w.matrix);
          car.body.add(copy);
        } else { // (no steering of its own: it turns with the steering group, about its hub)
          const hub = w.steer.position;
          copy.matrix.copy(new THREE.Matrix4().makeTranslation(-hub.x, -hub.y, -hub.z).multiply(w.matrix));
          w.steer.add(copy);
        }
        w.still.visible = false;
        Object.assign(w, { anim: a, copy, roll, rig, ext: rig.spring?.rest ?? 0 });
        if (rig.spring) {
          // (its contact where its tyre stands as built: the vehicle up on it)
          const S = rig.spring;
          w.ext = S.rest;
          w.rel.y = S.hub.y - roll.r - car.pivot.y;
        }
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
  }

  // Its tracks: an animated copy of each (the game's WheelRotation / TrackRotation poses turn its
  // wheels) in place of the still one, its wheels rolled as it goes (pose) and the belt texture
  // running round with them (belts.js), standing still where it lies on the ground.
  async armTracks(car) {
    for (const t of car.tracks) {
      if (!(t.info.layers || []).some((l) => ROLL.test(l.pose?.name || ''))) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(t.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(t.group) });
        if (this.car !== car || !copy.userData.skeleton) throw 0;
        const a = new Animator(this.v, t.info, copy);
        await a.load();
        if (this.car !== car) throw 0;
        const rolls = rollsOf(a, copy, t.matrix);
        if (!rolls.length) throw 0;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(t.matrix);
        car.body.add(copy);
        t.group.visible = false;
        Object.assign(t, { anim: a, copy, rolls });
        // its road wheels on their springs: it stands a third of the way down them (as wheels do)
        t.springs = springsOf(a, copy, t.matrix, t.bottom);
        if (t.springs.length) {
          let lift = 0;
          for (const S of t.springs) { const ride = 0.35 * (S.hi - S.rest); S.ext = S.rest + ride; lift += ride * S.down; }
          lift /= t.springs.length;
          for (const r of t.rels) r.y -= lift; // (its contacts that much lower: the hull up on them)
        }
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
  }

  // Its legs: an animated copy of each that walks (gaitOf) in place of the still one; the legs step in
  // two sets by turns (beside and behind each other, the other set), as walkers go.
  async armLegs(car) {
    for (const l of car.legs) {
      if (!LEG.every((n) => (l.info.layers || []).some((x) => x.pose?.name === n))) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(l.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(l.group) });
        if (this.car !== car || !copy.userData.skeleton) throw 0;
        const a = new Animator(this.v, l.info, copy);
        await a.load();
        if (this.car !== car) throw 0;
        const gait = gaitOf(a, copy, l.matrix);
        if (!gait) throw 0;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(l.matrix);
        car.body.add(copy);
        l.group.visible = false;
        Object.assign(l, { anim: a, copy, gait, f: new V(), dy: 0, lift: null, team: 0 });
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
    const armed = car.legs.filter((l) => l.gait);
    for (const side of [1, -1]) {
      armed.filter((l) => (l.gait.foot.x >= car.pivot.x ? 1 : -1) === side).sort((p, q) => q.gait.foot.z - p.gait.foot.z)
        .forEach((l, k) => { l.team = (k + (side > 0 ? 0 : 1)) % 2; });
    }
  }

  // Its hover jets: an animated copy of each that tilts (tiltOf) in place of the still one.
  async armHovers(car) {
    for (const h of car.hovers) {
      if (!(h.info.layers || []).some((l) => /^HoverRot(Pitch|Roll)$/.test(l.pose?.name || ''))) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(h.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(h.group) });
        if (this.car !== car || !copy.userData.skeleton) throw 0;
        const a = new Animator(this.v, h.info, copy);
        await a.load();
        if (this.car !== car) throw 0;
        const tilt = tiltOf(a, copy, h.matrix);
        if (!tilt.pitch && !tilt.roll) throw 0;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(h.matrix);
        car.body.add(copy);
        h.group.visible = false;
        const ranges = Object.fromEntries(a.poses().map((p) => [p.name, p]));
        Object.assign(h, { anim: a, copy, tilt, ranges, pitch: 0, roll: 0 });
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
  }

  // What moves by itself and nothing else here moves (once the turrets, tracks, legs and jets have
  // their copies: a part they took is hidden): an animated copy of each, its idle playing.
  async armIdle(car) {
    for (const p of car.idles) {
      if (!p.group.visible) continue;
      let copy = null;
      try {
        copy = await this.v.makeModel(p.info, 0, { texMax: this.build.texMax, animate: true, paint: this.v.paintOf(p.group) });
        if (this.car !== car || !copy.userData.skeleton || !p.group.visible) throw 0;
        const a = new Animator(this.v, p.info, copy);
        await a.load(); // (it starts on its idle when that moves anything)
        if (this.car !== car || !a.active || !p.group.visible) throw 0;
        copy.matrixAutoUpdate = false;
        copy.matrix.copy(p.matrix);
        car.body.add(copy);
        p.group.visible = false;
        Object.assign(p, { anim: a, copy });
      } catch {
        if (copy) this.v.disposeModel(copy);
      }
    }
  }

  // ---- on and off ----
  // Starts driving where the middle of the view looks at the ground (else under the camera), facing
  // the way the camera looks. Returns '' or why it cannot.
  // (at, yaw: somewhere else, facing a heading: a test drive from a spawn point)
  start({ at: atOpt = null, yaw: yawOpt = null } = {}) {
    if (this.car) return '';
    if (this.v.mode !== 'map' || !this.map.scene) return 'Open a map first.';
    const car = this.assemble();
    if (car.why) return car.why;
    const cam = this.v.camera;
    cam.updateMatrixWorld();
    const eye = cam.position.clone(), fwd = cam.getWorldDirection(new V());
    const hit = atOpt ? null : this.map.segmentHit(eye.toArray(), eye.clone().addScaledVector(fwd, 300).toArray(), { water: false, skip: passable });
    const at = atOpt ? new V().copy(atOpt) : hit ? new V().fromArray(hit.point) : eye.clone().addScaledVector(new V(fwd.x, 0, fwd.z).normalize(), 20);
    const yaw = yawOpt ?? Math.atan2(fwd.x, fwd.z);
    this.car = car;
    this.scene = this.map.scene;
    // (parts not welded to the cabin wear the builder's red; on the road they look as they are)
    for (const i of this.build.instances) if (this.build.loose?.has(i.id)) for (const m of i.group.userData.materials || []) m.userData.xo.u.xoOverlayAmt.value = 0;
    this.v.mapRoot.add(car.body);
    this.state = { pos: new V(at.x, this.groundAt(at.x, at.z, at.y + 20) + 0.4 + car.lift, at.z), yaw, v: 0, vy: 0, grounded: false, up: UP.clone(), slope: 0, steer: 0, skid: 0, landed: 0, surface: 'ground', onObject: false };
    this.look = { heading: yaw, pitch: 0.28, dist: THREE.MathUtils.clamp(car.size * 2.2 + 4, 6, 40), drag: null, lastDrag: -1e9, snap: true };
    this.keys.clear();
    this.clock = 0;
    this.acc = 0;
    this.lastPose = 0;
    this.why = null;
    this.dust = car.dusty.map((c) => ({ c, run: null, path: '' }));
    car.lamps = headlightsOf(car.body, car.box.clone().translate(car.pivot)).slice(0, 2);
    // its exhausts smoke as long as it drives
    this.smoke = [];
    for (const e of car.exhausts) {
      const run = { stop: false, fx: null };
      this.smoke.push(run);
      const at = new THREE.Matrix4();
      const origin = () => at.multiplyMatrices(car.body.matrixWorld, e.m).elements;
      const tryOne = (list) => {
        if (!list.length || run.stop || this.car !== car) return;
        this.v.fx.play(list[0], origin, { loop: true, ambient: true }).then((r) => {
          if (!r) { tryOne(list.slice(1)); return; }
          if (run.stop || this.car !== car) { r.stop(); return; }
          run.fx = r;
        }, () => tryOne(list.slice(1)));
      };
      tryOne(exhaustOf(e.path));
    }
    this.biome = this.biomeOf();
    this.pose();
    Promise.all([this.armTurrets(car), this.armWheels(car), this.armTracks(car), this.armLegs(car), this.armHovers(car)]).then(() => this.armIdle(car)).catch(() => {});
    this.sound = new DriveSound(this.v.sounds, { cabinPath: car.cabinPath, cabinType: car.cabinType, mass: car.mass, mover: car.mover });
    this.sound.start(this.state.pos.toArray());
    if (this.cross) this.cross.hidden = false;
    this.v.shadowDirty = true;
    this.onChange();
    return '';
  }

  stop() {
    if (!this.car) return;
    if (this.locked && document.exitPointerLock) document.exitPointerLock();
    this.locked = false;
    if (this.pad?.fire) this.fire(false);
    this.pad = null;
    for (const g of [...this.car.guns, ...this.car.wheels, ...this.car.tracks, ...this.car.legs, ...this.car.hovers, ...this.car.idles]) if (g.copy) { this.v.disposeModel(g.copy); g.copy = null; }
    for (const d of this.dust || []) d.run?.stop();
    for (const r of this.smoke || []) { r.stop = true; r.fx?.stop(); }
    this.smoke = [];
    for (const l of this.beams) l.intensity = 0;
    this.dust = [];
    this.sound?.stop();
    this.sound = null;
    this.dropCopy(this.car.body);
    this.car = null;
    this.map.mendBroken(); // (what it broke stands again)
    this.build.markLoose?.(); // (the builder's red back on loose parts)
    this.state = null;
    this.keys.clear();
    this.look.drag = null;
    if (this.cross) this.cross.hidden = true;
    if (this.v.mode === 'map') { this.v.canvas.style.cursor = ''; this.map.fly.sync(); } // (flying on from where the camera is; left for the builder, its cursor stays)
    this.v.shadowDirty = true;
    this.v.dirty = true;
    this.onChange();
  }

  // keydown / keyup from the page while driving: true when the key was the vehicle's (H: the horn)
  key(e, down) {
    if (!this.car) return false;
    if (e.code === 'KeyH') {
      if (down && !e.repeat) this.sound?.hornOn(this.state.pos.toArray());
      if (!down) this.sound?.hornOff(this.state.pos.toArray());
      return !(e.ctrlKey || e.altKey || e.metaKey);
    }
    if (!down) return this.keys.delete(e.code) || KEYS.has(e.code);
    if (e.ctrlKey || e.altKey || e.metaKey) return false;
    if (e.code === 'Escape') { this.stop(); return true; }
    if (!KEYS.has(e.code)) return false;
    this.keys.add(e.code);
    return true;
  }

  // ---- a gamepad ----
  // The first one connected, read each tick while it drives (the standard layout): the left stick
  // drives and steers (the triggers too: right ahead, left back), the right stick looks round, A or
  // the right bumper fires, B brakes, Y sounds the horn, Back or Start ends the drive. (this.pad:
  // what step() takes from it; null without one)
  readPad(dt) {
    let p = null;
    try { p = [...(navigator.getGamepads?.() || [])].find((g) => g && g.connected !== false) || null; } catch { /* not allowed */ }
    const was = this.pad;
    if (!p) {
      if (was?.fire) this.fire(false);
      if (was?.horn) this.sound?.hornOff(this.state.pos.toArray());
      if (was) { this.pad = null; this.onChange(); }
      return;
    }
    const dz = (v) => (Math.abs(v || 0) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85); // (a dead zone round the middle)
    const val = (i) => p.buttons[i]?.value ?? 0, held = (i) => !!p.buttons[i]?.pressed;
    const now = {
      thr: THREE.MathUtils.clamp(-dz(p.axes[1]) + val(7) - val(6), -1, 1), turn: -dz(p.axes[0]),
      brake: held(1), fire: held(0) || held(5), horn: held(3), quit: held(8) || held(9),
    };
    const lx = dz(p.axes[2]), ly = dz(p.axes[3]);
    if (lx || ly) this.lookBy(lx * 1100 * dt, ly * 700 * dt, 0.0022, 0.0017);
    if (now.fire !== !!was?.fire) this.fire(now.fire);
    if (now.horn && !was?.horn) this.sound?.hornOn(this.state.pos.toArray());
    if (!now.horn && was?.horn) this.sound?.hornOff(this.state.pos.toArray());
    this.pad = now;
    if (!was) this.onChange();
    if (now.quit && !was?.quit) this.stop();
  }

  // its guns (for V: firing.js), riding on it (a turret: its animated copy)
  guns() { return this.car ? this.car.guns : []; }

  // ---- the ground ----
  // the ground or an object's top under (x, z), looking down from y (water does not hold it);
  // this.underObject: whether it was an object's
  groundAt(x, z, y) {
    const h = this.map.segmentHit([x, y + 2.5, z], [x, y - 40, z], { water: false, skip: passable });
    this.underObject = !!h && h.surface !== 0;
    const t = this.map.heightAt(x, z), g = h ? h.point[1] : Number.isFinite(t) ? t : y - 40;
    if (this.car?.mover !== 'hover') return g;
    const w = this.map.waterAt(x, z); // (a hover rides over water)
    return w !== null && w > g ? w : g;
  }

  // going into water fast: the game's splash (its collision with water) at the front, and its sound
  splash(level) {
    const c = this.car, s = this.state, fwd = new V(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const at = s.pos.clone().addScaledVector(fwd, s.v >= 0 ? c.box.max.z : c.box.min.z);
    at.y = level ?? at.y;
    const m = new THREE.Matrix4().setPosition(at).elements;
    this.v.fx.play('particles/materials/water/collision_water', () => m).catch(() => {});
    this.v.sounds.play('wheels_water_start', at.toArray(), { gain: THREE.MathUtils.clamp(Math.abs(s.v) / 12, 0.4, 1), ref: 8 });
    this.splashes = (this.splashes || 0) + 1;
  }

  // what the map's ground is like, for the wheels' sound and dust: snow (a snowy weather, a winter
  // map), sand, mud, else ground
  biomeOf() {
    const env = this.map.env?.values?.AreaEffect || '', names = (this.map.scene?.terrain?.surfaces || []).join(' ').toLowerCase();
    if (/snow/.test(env) || /snow|ice|winter|arctic/.test(names) && !/sand/.test(names)) return 'snow';
    if (/sand|desert|arizona|dune|redrock/.test(names)) return 'sand';
    if (/mud|swamp/.test(names)) return 'mud';
    return 'ground';
  }

  // ---- moving on ----
  tick() {
    if (!this.car) return;
    if (this.v.mode !== 'map' || this.map.scene !== this.scene) { this.stop(); return; }
    const now = performance.now(), dt = this.clock ? Math.min(0.1, (now - this.clock) / 1000) : 0;
    this.clock = now;
    this.readPad(dt);
    if (!this.car) return; // (Back / Start ended it)
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP && n < 6) { this.step(STEP); this.acc -= STEP; n++; }
    if (n === 6) this.acc = 0;
    this.pose();
    this.follow(dt);
    this.aimTurrets(dt);
    this.raiseDust();
    this.headlights();
    const s = this.state, on = (...codes) => (codes.some((x) => this.keys.has(x)) ? 1 : 0);
    this.sound?.update(dt, {
      pos: s.pos.clone().addScaledVector(s.up, 0.8).toArray(), v: s.v, top: this.car.top, throttle: on('KeyW', 'ArrowUp') || on('KeyS', 'ArrowDown') || (this.pad?.thr ? 1 : 0),
      skid: s.skid, surface: s.surface, grounded: s.grounded, landed: s.landed, braking: on('Space') || !!this.pad?.brake || ((on('KeyS', 'ArrowDown') || (this.pad?.thr || 0) < 0) && s.v > 1),
    });
    s.landed = 0;
    this.v.shadowDirty = true;
    this.v.dirty = true;
    if (now - (this.told || 0) > 100) { this.told = now; this.onChange(); }
  }

  step(h) {
    const c = this.car, s = this.state, k = this.keys;
    const on = (...codes) => (codes.some((x) => k.has(x)) ? 1 : 0);
    const pad = this.pad || { thr: 0, turn: 0, brake: false };
    const thr = THREE.MathUtils.clamp(on('KeyW', 'ArrowUp') - on('KeyS', 'ArrowDown') + pad.thr, -1, 1);
    const turnIn = THREE.MathUtils.clamp(on('KeyA', 'ArrowLeft') - on('KeyD', 'ArrowRight') + pad.turn, -1, 1);
    const braking = on('Space') || pad.brake;
    s.thr = thr;
    s.turn = turnIn;
    let skid = 0;
    if (s.grounded) {
      // pulling away (power over mass, at most the tyres' grip; overloaded: less), braking, reversing
      const pull = Math.min(GRIP, (c.watts * PULL) / (c.mass * Math.max(Math.abs(s.v), 2))) * c.over;
      let a;
      if (braking) { a = -Math.sign(s.v) * Math.min(Math.abs(s.v) / h, BRAKE); skid = Math.abs(s.v) > 5 ? 0.8 : 0; }
      else if (thr > 0) a = s.v < -0.3 ? BRAKE : s.v < c.top ? pull : 0;
      else if (thr < 0) a = s.v > 0.3 ? -BRAKE : s.v > -c.top * 0.4 ? -pull * 0.7 : 0;
      else a = -Math.sign(s.v) * Math.min(Math.abs(s.v) / h, (COAST[c.mover] ?? 0.8) + 0.0015 * s.v * s.v); // (rolling, the legs' stopping, and air)
      a -= G * s.slope; // (uphill slows it, downhill runs on)
      // wading: no faster than the water lets it (under a third of its speed a metre deep), its
      // wheels slipping; hovers ride over it
      if (s.surface === 'water' && c.mover !== 'hover') {
        const most = c.top * THREE.MathUtils.clamp(1 - s.depth / 1.2, 0.2, 1);
        if (thr && Math.sign(a) === Math.sign(s.v || thr)) a *= THREE.MathUtils.clamp(1 - s.depth / 2, 0.4, 1);
        if (Math.abs(s.v) > most) a -= Math.sign(s.v) * (4 + 2 * (Math.abs(s.v) - most));
      }
      s.v += a * h;
      if (Math.abs(s.v) > c.top * 1.15) s.v = Math.sign(s.v) * c.top * 1.15;
    }
    // turning: like a car on its ST wheels, else skidding round
    const sp = Math.abs(s.v);
    const want = turnIn * THREE.MathUtils.degToRad(34) / (1 + sp / 16);
    s.steer += (want - s.steer) * (1 - Math.exp(-10 * h));
    let rate = c.carLike ? (s.v * Math.tan(s.steer) / c.wheelbase) * c.steerSign : turnIn * 1.3 / (1 + sp / 14);
    const most = SIDE / Math.max(sp, 1); // (the tyres hold it to so much sideways)
    if (c.carLike && sp > 6) skid = Math.max(skid, THREE.MathUtils.clamp((Math.abs(rate) / most - 0.85) * 3, 0, 1)); // (pushed to the tyres' limit: they squeal)
    rate = THREE.MathUtils.clamp(rate, -most, most);
    if (!s.grounded) rate *= 0.15;
    s.yaw += rate * h;
    s.rate = rate;
    s.skid += (skid - s.skid) * (1 - Math.exp(-8 * h));
    // on along the ground's level (stopped by what it runs into; breaking what breaks)
    const fwd = new V(Math.sin(s.yaw), 0, Math.cos(s.yaw)), move = s.v * h;
    if (Math.abs(move) > 1e-5) {
      this.smash(fwd, move);
      if (this.blocked(fwd, move)) s.v *= -0.15; // (a bump back off it)
      else s.pos.addScaledVector(fwd, move);
    }
    this.settle(h);
  }

  // the bumper's rays (at its height, across its width) along fwd for this move
  bumper(fwd, move, heights = [0.4]) {
    const c = this.car, s = this.state, dir = move > 0 ? fwd : fwd.clone().negate(), len = Math.abs(move) + 0.3;
    const face = move > 0 ? c.box.max.z : c.box.min.z, H = c.box.max.y - c.box.min.y;
    const right = new V(Math.cos(s.yaw), 0, -Math.sin(s.yaw)), out = [];
    for (const k of heights) {
      const y = c.box.min.y + Math.max(0.3, H * k);
      for (const x of [c.box.min.x * 0.85, (c.box.min.x + c.box.max.x) / 2, c.box.max.x * 0.85]) {
        const p = s.pos.clone().addScaledVector(fwd, face).addScaledVector(right, x).addScaledVector(UP, y);
        out.push([p.toArray(), p.addScaledVector(dir, len).toArray()]);
      }
    }
    return out;
  }

  // what breaks in its way breaks (the game's effect and sound; it loses a little speed); through a
  // bush it rustles
  smash(fwd, move) {
    for (const [p0, p1] of this.bumper(fwd, move, [0.2, 0.55])) {
      const hit = this.map.segmentHit(p0, p1, { water: false, skip: (rec, i) => !breakable(rec, i) });
      if (hit?.rec && smashPlacement(this.v, this.map, hit.rec, hit.index, hit.point, hit.surface)) this.state.v *= 0.88;
    }
    const [p0, p1] = this.bumper(fwd, move, [0.15])[1];
    if (this.map.segmentHit(p0, p1, { water: false, skip: (rec, i) => !bush(rec, i) })) this.v.sounds.play('bush', p1, { gain: 0.6, ref: 6, every: 0.35 });
  }

  // what is in the way of moving so far along fwd (negative: backwards): the map's objects at the
  // bumper (not the ground: it is driven up), or a slope steeper than CLIMB just ahead
  blocked(fwd, move) {
    const c = this.car, s = this.state;
    for (const [p0, p1] of this.bumper(fwd, move)) {
      const hit = this.map.segmentHit(p0, p1, { water: false, skip: passable });
      if (hit && hit.surface !== 0) { this.why = { object: hit.path, at: hit.point }; return true; }
    }
    const dir = move > 0 ? fwd : fwd.clone().negate(), face = move > 0 ? c.box.max.z : c.box.min.z;
    const front = s.pos.clone().addScaledVector(fwd, face), ahead = front.clone().addScaledVector(dir, 0.6);
    const h0 = this.groundAt(front.x, front.z, s.pos.y + 1), h1 = this.groundAt(ahead.x, ahead.z, s.pos.y + 1);
    if ((h1 - h0) / 0.6 > CLIMB) { this.why = { slope: +((h1 - h0) / 0.6).toFixed(2), h0, h1 }; return true; }
    return false;
  }

  // onto the ground: the plane through its contacts sets its height and tilt; off a crest it flies
  settle(h) {
    const c = this.car, s = this.state;
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    let onObj = 0;
    const pts = c.samples.map((p) => {
      const x = s.pos.x + p.x * cy + p.z * sy, z = s.pos.z - p.x * sy + p.z * cy;
      const g = this.groundAt(x, z, s.pos.y + p.y);
      if (this.underObject) onObj++;
      return { x: p.x, z: p.z, h: g - p.y };
    });
    s.onObject = onObj * 2 >= pts.length;
    s.surface = s.onObject ? 'concrete' : this.biome;
    const f = fitPlane(pts);
    if (!f) return;
    // in water (not on a bridge over it): it wades, the deeper the slower; going in fast, a splash
    const lvl = this.map.waterAt(s.pos.x, s.pos.z), bed = this.map.heightAt(s.pos.x, s.pos.z);
    s.depth = lvl === null || s.onObject || !Number.isFinite(bed) ? 0 : Math.max(0, lvl - bed);
    if (s.depth > WET) s.surface = 'water';
    if (s.surface === 'water' && !s.wet && Math.abs(s.v) > 4) this.splash(lvl);
    s.wet = s.surface === 'water';
    const ground = f.a + c.lift;
    if (s.grounded) {
      // the ground falls away faster than it can follow it down: off a crest, at the speed it was
      // climbing; else it stays on it (its rise and fall smoothed into vy)
      if (ground < s.pos.y + s.vy * h - 0.5 * G * h * h - 0.03) s.grounded = false;
      else {
        s.vy = s.vy * 0.6 + THREE.MathUtils.clamp((ground - s.pos.y) / h, -30, 30) * 0.4;
        s.pos.y = ground;
      }
    }
    if (!s.grounded) {
      s.vy -= G * h;
      s.pos.y += s.vy * h;
      if (s.pos.y <= ground) { s.landed = Math.max(s.landed, -s.vy); s.pos.y = ground; s.vy = 0; s.grounded = true; }
    }
    if (s.grounded) {
      // tilt with the ground (its normal, from the plane, turned by the heading)
      const n = new V(-f.b, 1, -f.c).normalize();
      const nw = new V(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
      s.up.lerp(nw, 1 - Math.exp(-14 * h)).normalize();
    } else s.up.lerp(UP, 1 - Math.exp(-0.8 * h)).normalize();
    const fwd = new V(sy, 0, cy);
    s.slope = THREE.MathUtils.clamp(-s.up.dot(fwd), -0.95, 0.95); // (sin of the climb ahead)
  }

  // the body where it is, its wheels rolling and steering
  pose() {
    const c = this.car, s = this.state;
    const fh = new V(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const z = fh.clone().addScaledVector(s.up, -fh.dot(s.up)).normalize(), x = new V().crossVectors(s.up, z).normalize();
    const M = new THREE.Matrix4().makeBasis(x, s.up, z).setPosition(s.pos);
    M.multiply(new THREE.Matrix4().makeTranslation(-c.pivot.x, -c.pivot.y, -c.pivot.z));
    c.body.matrix.copy(M);
    c.body.matrixWorldNeedsUpdate = true;
    const dt = this.lastPose ? Math.min(0.1, (performance.now() - this.lastPose) / 1000) : 0;
    this.lastPose = performance.now();
    for (const w of c.wheels) {
      if (w.anim) { this.wheelPose(w, dt); continue; }
      w.angle = (w.angle + (s.v * dt) / w.r) % (Math.PI * 2);
      w.spin.quaternion.setFromAxisAngle(new V(1, 0, 0), w.angle);
      w.steer.quaternion.setFromAxisAngle(UP, w.st && c.carLike ? s.steer * c.steerSign : 0);
    }
    // the tracks: each side as fast as it goes (skidding round, the outer one faster; in the air
    // they run on as they were)
    for (const t of c.tracks) {
      if (!t.anim) continue;
      const run = (s.v - (s.rate || 0) * t.x) * dt; // (metres)
      t.ran = (t.ran || 0) + run;
      for (const r of t.rolls) {
        const v = r.value + THREE.MathUtils.radToDeg(run / r.r) * r.per * r.sign;
        r.value = ((((v + 180) % 360) + 360) % 360) - 180; // (round and round: -180 and 180 are one)
        t.anim.pose[r.name] = r.value;
      }
      // its road wheels down on their springs to the ground under each (up over a bump; hanging in the air)
      for (const S of t.springs || []) {
        if (!dt) break;
        const hub = (this._hub ||= new V()).copy(S.hub).applyMatrix4(c.body.matrix), reach = S.r + S.down * (S.hi - S.rest) + 0.3;
        const h = s.grounded ? this.map.segmentHit([hub.x, hub.y + 0.3, hub.z], [hub.x, hub.y - reach, hub.z], { water: false, skip: passable }) : null;
        const want = h ? S.rest + (hub.y - S.r - h.point[1]) / S.down : S.hi;
        S.ext += (THREE.MathUtils.clamp(want, S.lo, S.hi) - S.ext) * (1 - Math.exp(-25 * dt));
        t.anim.pose[S.name] = S.ext;
      }
      t.anim.apply();
    }
    this.walk(dt);
    // what moves by itself (motors faster with the revs)
    for (const p of c.idles) {
      if (!p.anim || !dt) continue;
      p.anim.time += dt * (p.motor ? 1 + 2 * (this.sound?.rpm || 0) : 1);
      p.anim.apply();
    }
    // the hover jets: their exhaust back as it pulls ahead (forward to brake or reverse), out to the
    // side as it turns (away from the turn: their push takes it round)
    for (const h of c.hovers) {
      if (!h.anim || !dt) continue;
      const k = 1 - Math.exp(-4 * dt), brake = this.keys.has('Space') && Math.abs(s.v) > 1 ? -Math.sign(s.v) : 0;
      h.pitch += ((brake || s.thr || 0) * 35 - h.pitch) * k;
      h.roll += (-(s.turn || 0) * 20 - h.roll) * k;
      for (const [t, deg] of [[h.tilt.pitch, h.pitch], [h.tilt.roll, h.roll]]) {
        if (!t) continue;
        const r = h.ranges[t.name];
        h.anim.pose[t.name] = THREE.MathUtils.clamp(deg * t.per * t.sign, r.min, r.max);
      }
      if (h.anim.active) h.anim.time += dt; // (its own idle: the turbines)
      h.anim.apply();
    }
    c.body.updateMatrixWorld(true);
  }

  // a wheel on its own animation: rolled as far as it goes on its side (the outer ones further round
  // a bend), steered, and its spring out to the ground under it (up over what it rolls on; in the
  // air hanging all the way down)
  wheelPose(w, dt) {
    const c = this.car, s = this.state, a = w.anim, R = w.roll, T = w.rig.steer, S = w.rig.spring;
    if (dt) {
      const turned = ((s.v - (s.rate || 0) * w.x) * dt) / R.r; // (radians)
      const v = R.value + THREE.MathUtils.radToDeg(turned) * R.per * R.sign;
      R.value = ((((v + 180) % 360) + 360) % 360) - 180;
      w.angle = (w.angle + turned) % (Math.PI * 2); // (as far round as a still wheel would be)
    }
    a.pose[R.name] = R.value;
    const steer = w.st && c.carLike ? s.steer * c.steerSign : 0;
    if (T) a.pose[T.name] = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(steer) * T.per * T.sign, T.lo, T.hi);
    else w.steer.quaternion.setFromAxisAngle(UP, steer); // (no steering of its own: its group turns it)
    if (S && dt) {
      const hub = (this._hub ||= new V()).copy(S.hub).applyMatrix4(c.body.matrix), reach = S.down * (S.hi - S.rest) + R.r + 0.3;
      const h = s.grounded ? this.map.segmentHit([hub.x, hub.y + 0.3, hub.z], [hub.x, hub.y - reach, hub.z], { water: false, skip: passable }) : null;
      const want = h ? S.rest + (hub.y - R.r - h.point[1]) / S.down : S.hi;
      w.ext += (THREE.MathUtils.clamp(want, Math.min(S.lo, S.hi), Math.max(S.lo, S.hi)) - w.ext) * (1 - Math.exp(-30 * dt));
      a.pose[S.name] = w.ext;
    }
    a.apply();
  }

  // ---- walking ----
  // A foot stays where it stands on the ground as the vehicle goes (in the vehicle's frame it goes
  // back, or round as it turns) until it is a stride out; then it steps, the game's own step lifting
  // it, ahead as far again, while the other set of legs stands. Each is set down on the ground under
  // it (LegY), and lands with the game's footstep (a splash in water).
  walk(dt) {
    const c = this.car, s = this.state, w = s.rate || 0;
    const legs = c.legs.filter((l) => l.gait);
    if (!legs.length || !dt) return;
    const busy = [0, 0]; // (legs of each set early in their step: the other set waits for them)
    for (const l of legs) if (l.lift?.p < 0.5) busy[l.team]++;
    const D = new V(), at = new V();
    for (const l of legs) {
      const g = l.gait, x = g.foot.x - c.pivot.x + l.f.x, z = g.foot.z - c.pivot.z + l.f.z;
      const vx = w * z, vz = s.v - w * x, speed = Math.hypot(vx, vz); // (the foot over the ground; the ground goes by the other way)
      const reach = Math.min(0.8 * g.most, g.reach + 0.06 * speed); // (longer strides as it goes faster; room left to wait)
      if (!l.lift) {
        if (s.grounded) { l.f.x -= vx * dt; l.f.z -= vz * dt; }
        const out = Math.hypot(l.f.x, l.f.z);
        if (out > g.most) l.f.multiplyScalar(g.most / out); // (held back too long: it slides)
        if (s.grounded && g.step && !busy[1 - l.team] && (out > reach || (speed < 0.3 && out > 0.12))) {
          l.lift = { p: 0, T: Math.min(g.step.dur, Math.max(0.08, (0.9 * reach) / Math.max(speed, 0.01))), from: l.f.clone() };
          busy[l.team]++;
        }
      }
      if (l.lift) {
        const L = l.lift, k = speed > 0.3 ? (0.8 * reach) / speed : 0; // (as far ahead as it went behind)
        L.p = Math.min(1, L.p + dt / L.T);
        const e = L.p * L.p * (3 - 2 * L.p);
        l.f.set(L.from.x + (vx * k - L.from.x) * e, 0, L.from.z + (vz * k - L.from.z) * e);
      }
      // the ground under it
      at.set(g.foot.x + l.f.x, g.foot.y, g.foot.z + l.f.z).applyMatrix4(c.body.matrix);
      const h = this.map.segmentHit([at.x, at.y + 1.5, at.z], [at.x, at.y - 2.5, at.z], { water: false, skip: passable });
      l.dy += ((h ? THREE.MathUtils.clamp(h.point[1] - at.y, -1, 1) : 0) - l.dy) * (1 - Math.exp(-20 * dt));
      const a = l.anim;
      a.active = l.lift ? g.step.name : null;
      a.time = l.lift ? l.lift.p * g.step.dur * 0.999 : 0;
      placeFoot(a, g, l.matrix, D.set(l.f.x, l.dy, l.f.z), !!l.lift);
      if (l.lift?.p >= 1) {
        l.lift = null;
        l.steps = (l.steps || 0) + 1;
        this.footfall(l, at);
      }
    }
  }

  // a foot set down: the game's footstep for the legs (the mechanical ones by the vehicle's weight),
  // in water a splash
  footfall(l, at) {
    const wet = this.map.segmentHit([at.x, at.y + 3, at.z], [at.x, at.y - 1, at.z], { skip: () => true })?.surface === 2;
    const weight = this.sound?.weight || 'medium';
    const fam = wet ? 'legs_step_water' : /legs_new_mech/.test(l.info.path || '') ? { light: 'ml_light_step', medium: 'ml_med_base', heavy: 'ml_heavy_base' }[weight] : 'legs_step_base';
    this.v.sounds.play(fam, at.toArray(), { gain: 0.7, ref: 6 });
    if (wet) { const m = new THREE.Matrix4().setPosition(at.x, this.map.waterAt(at.x, at.z) ?? at.y, at.z).elements; this.v.fx.play('particles/materials/water/leg_landing_water', () => m).catch(() => {}); }
  }

  // ---- aiming ----
  // what the middle of the view looks at (the ground, an object; else far out)
  aimPoint() {
    const cam = this.v.camera, eye = cam.position, d = cam.getWorldDirection(new V());
    const far = eye.clone().addScaledVector(d, 1500);
    const hit = this.map.segmentHit(eye.toArray(), far.toArray(), { skip: passable });
    return hit ? new V().fromArray(hit.point) : far;
  }

  // the turrets turn to it (within their limits), and play their Fire clip while V is held
  aimTurrets(dt) {
    const guns = this.car.guns.filter((g) => g.anim);
    if (!guns.length) return;
    const aim = (this.aim = this.aimPoint()), firing = this.firing();
    for (const g of guns) {
      const a = g.anim;
      a.aimAt(aim, dt);
      const act = firing && g.fire ? g.fire.name : g.idle || null;
      if (act !== a.active) { a.active = act; a.time = 0; a.fireClock = 0; a.heldFor = null; } // (a burst starts at its first shot)
      else if (act) a.advance(dt); // (a Fire on a beat as firing.js fires it: the shot timer, the game's reload; else on its own clock)
      a.apply();
    }
  }

  // ---- the wheels' dust ----
  // off the outermost wheels or tracks while it rolls on the ground (the skid's while it skids),
  // the effect hung at each, facing the way it goes
  raiseDust() {
    const s = this.state, c = this.car, moving = s.grounded && Math.abs(s.v) > 3;
    const kind = DUST[s.surface] || DUST.ground, wheels = moving ? kind[s.skid > 0.4 ? 1 : 0] : '';
    for (const d of this.dust) {
      // (a hover throws up spray over water, at any speed; wheels and tracks their dust, or water)
      const want = d.c.kind === 'hover' ? (s.surface === 'water' ? HOVER_WATER(d.c.path || '') : '') : wheels;
      if (d.path === want) continue;
      d.run?.stop();
      d.run = null;
      d.path = want;
      if (!want) continue;
      const local = c.pivot.clone().add(new V(d.c.x, d.c.y + 0.05, d.c.z));
      const at = new THREE.Matrix4(), turnBack = new THREE.Matrix4().makeRotationY(s.v < 0 ? 0 : Math.PI);
      this.v.fx.play(want, () => at.multiplyMatrices(c.body.matrixWorld, new THREE.Matrix4().setPosition(local)).multiply(turnBack).elements, { loop: true, ambient: true }).then((run) => {
        if (!run) return;
        if (d.path !== want || !this.car) { run.stop(); return; }
        d.run = run;
        run.onEnd = () => { if (d.run === run) { d.run = null; d.path = ''; } };
      });
    }
  }

  // ---- headlights ----
  // At night (the map's light level low: full on Halloween's 0.2, a glimmer on an overcast day's 0.57)
  // its headlights shine ahead and a little down from its front lamps, as strong as the weather's
  // exposure makes its other lights (its F: 55 on Halloween's night); by day they are dark
  headlights() {
    const c = this.car, sky = this.map.sky, night = THREE.MathUtils.clamp((0.6 - (sky?.level ?? 1)) / 0.4, 0, 1);
    this.night = night;
    this.beams.forEach((l, i) => {
      const p = c?.lamps?.[i];
      if (!p || night <= 0) { if (l.intensity) { l.intensity = 0; this.v.dirty = true; } return; }
      l.position.copy(p).applyMatrix4(c.body.matrixWorld);
      l.target.position.set(p.x, p.y - 1.8, p.z + 14).applyMatrix4(c.body.matrixWorld);
      l.target.updateMatrixWorld();
      l.intensity = 18 * (sky?.levels?.F || 1) * night;
    });
  }

  // ---- the camera: behind it and over it; its middle where the guns aim ----
  follow(dt) {
    const c = this.car, s = this.state, L = this.look, cam = this.v.camera;
    // back behind it as it drives on, unless the view was turned lately (then it holds its heading)
    if (!L.drag && performance.now() - L.lastDrag > 2500 && Math.abs(s.v) > 3) L.heading += turn(s.yaw - L.heading) * (1 - Math.exp(-1.5 * dt));
    const yaw = L.heading, pitch = THREE.MathUtils.clamp(L.pitch, -0.3, 1.2);
    const pivot = s.pos.clone().addScaledVector(s.up, Math.max(0.8, c.height * 0.75 + 0.3));
    const want = pivot.clone().add(new V(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).multiplyScalar(L.dist));
    // nothing between it and the camera: a rock or a wall in the way brings the camera in before it
    const gap = this.map.segmentHit(pivot.toArray(), want.toArray(), { water: false, skip: passable });
    if (gap) want.lerpVectors(pivot, want, Math.max(0.15, (gap.dist - 0.6) / L.dist));
    want.y = Math.max(want.y, this.groundAt(want.x, want.z, want.y + 5) + 1); // (never under the ground)
    if (L.snap) { cam.position.copy(want); L.snap = false; } else cam.position.lerp(want, 1 - Math.exp(-7 * dt));
    // looking a little over it: it sits low in the view, the crosshair out in front
    const a = -pitch * 0.6 + 0.12;
    const look = new V(Math.sin(yaw) * Math.cos(a), Math.sin(a), Math.cos(yaw) * Math.cos(a));
    cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, cam.position.clone().add(look), UP));
    cam.updateMatrixWorld();
  }

  // turns the view by a mouse movement (radians a pixel across, up)
  lookBy(dx, dy, ky, kp) {
    this.look.heading -= dx * ky;
    this.look.pitch = THREE.MathUtils.clamp(this.look.pitch + dy * kp, -0.3, 1.2);
    this.look.lastDrag = performance.now();
  }

  pointerDown(e) {
    if (!this.car || (e.button !== 0 && e.button !== 2)) return;
    if (this.locked) { if (e.button === 0) this.fire(true); return; } // (the mouse caught: the left button fires)
    this.look.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now() };
    try { this.v.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    this.v.canvas.style.cursor = 'grabbing';
  }

  pointerMove(e) {
    const d = this.look.drag;
    if (!this.car || this.locked || !d || d.id !== e.pointerId) return;
    this.lookBy(e.clientX - d.x, e.clientY - d.y, 0.006, 0.004);
    d.x = e.clientX;
    d.y = e.clientY;
  }

  pointerUp(e) {
    if (this.locked) { if (e.button === 0) this.fire(false); return; }
    const d = this.look.drag;
    if (!d || d.id !== e.pointerId) return;
    this.look.drag = null;
    this.look.lastDrag = performance.now();
    this.v.canvas.style.cursor = '';
    // a click (not a drag): the mouse is caught to aim with
    if (this.car && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4 && performance.now() - d.t < 500) {
      try { const p = this.v.canvas.requestPointerLock?.(); p?.catch?.(() => {}); } catch { /* not allowed here */ }
    }
  }

  // what the panel shows: speed in km/h, top speed, airborne
  get speedo() { return this.car ? { kmh: Math.abs(this.state.v) * 3.6, top: this.car.top * 3.6, air: !this.state.grounded, reverse: this.state.v < -0.3, locked: this.locked, pad: !!this.pad } : null; }
}
