// Plays a part's animations the way its .model file describes them (see src/xo/Anim.h):
// activity layers (IDLE, FIRE, OPEN, ...) loop over time, pose-parameter layers (turret yaw, gun
// pitch, wheel steer / spin / suspension ...) follow a value, either through one clip or by
// blending evenly spaced single-key poses ("files"), and addLayer stacks layers. Clips hold local
// offsets from the rest pose, so every frame the bones start from rest and each clip's offset is
// composed on top.
import * as THREE from 'three';
import { setupBelts } from './belts.js';

const DATA = 'https://xo.data';
const clipCache = new Map(); // .anim path -> Promise<clip>

export function loadClip(path) {
  if (!clipCache.has(path)) {
    const p = fetch(`${DATA}/anim?path=${encodeURIComponent(path)}`).then(async (r) => {
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    });
    p.catch(() => { if (clipCache.get(path) === p) clipCache.delete(path); }); // a failed load is tried again next time
    clipCache.set(path, p);
  }
  return clipCache.get(path);
}

// After the game data changed.
export function flushClips() { clipCache.clear(); }

// Shots in one loop of a Fire clip: 6 when it turns a barrel bone round a full turn (a rotary gun).
function rotaryShots(clip) {
  for (const tr of clip?.tracks || []) {
    if (!/barrel/i.test(tr.node) || !tr.r || tr.times.length < 2) continue;
    let total = 0;
    for (let k = 1; k < tr.times.length; k++) {
      const a = tr.r, i = (k - 1) * 4, j = k * 4;
      const dot = Math.abs(a[i] * a[j] + a[i + 1] * a[j + 1] + a[i + 2] * a[j + 2] + a[i + 3] * a[j + 3]);
      total += 2 * Math.acos(Math.min(1, dot));
    }
    if (total >= (350 * Math.PI) / 180) return 6;
  }
  return 1;
}

// A gun's pace without an Animator (the builder's vehicle fires: firing.js): seconds between its
// shots as the 3D Viewer fires it, one a loop of its Fire clip (its stack's first clip), six for a
// rotary barrel; a gun that fires its barrels in turn (fireTurns), the longest of their Fires', as
// Animator.shotPeriod (its firing copy shows each shot's barrel); null when its Fire has no clip.
// shotFor: Viewer.shotFor.
export async function firePeriod(info, shotFor = null) {
  const layers = new Map((info?.layers || []).map((l) => [l.name, l]));
  const periodOf = async (fire) => {
    const order = [], seen = new Set();
    const walk = (n) => {
      const l = layers.get(n);
      if (!l || seen.has(n)) return;
      seen.add(n);
      if (l.file && !l.pose) order.push(l);
      for (const a of l.add || []) walk(a);
    };
    walk(fire.name);
    const tl = order[0];
    const clip = tl ? await loadClip(tl.file).catch(() => null) : null;
    return clip?.duration > 0 ? clip.duration / (tl.speed || 1) / rotaryShots(clip) : null;
  };
  const turns = fireTurns(info, shotFor);
  if (turns) {
    const ps = (await Promise.all(turns.map(periodOf))).filter((p) => p > 0);
    return ps.length ? Math.max(...ps) : null;
  }
  const fire = [...layers.values()].find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || ''));
  return fire ? periodOf(fire) : null;
}

// A gun's fire points: its fire_01, fire_02 ... nodes or bones; ten skins name theirs fire_fx_01 ...
// (those count when it has no fire_NN). firePointsOf(list): the ones in a list of named things;
// firePointNumber(name): a fire point's number (its barrel), else null.
export function firePointsOf(list) {
  const plain = (list || []).filter((x) => /^fire_\d+$/i.test(x.name));
  return plain.length ? plain : (list || []).filter((x) => /^fire_fx_\d+$/i.test(x.name));
}
export const firePointNumber = (name) => { const m = /^fire_(?:fx_)?(\d+)$/i.exec(name || ''); return m ? +m[1] : null; };
// The barrel a Fire activity fires alone: Fire 1, Fire 2 ... in the Animation list, whichever way the
// .model spells it (ACT_FIRE1, FIRE1, FIRE_1, ACT_FIRE_1); null for the others (FIRE, BURST ...).
export const fireNumber = (act) => { const m = /^(?:ACT_)?FIRE_?(\d+)$/i.exec(act || ''); return m ? +m[1] : null; };

// A gun with a Fire for each barrel (Fire 1, Fire 2 ...: the Starfall's two) fires them one after the
// other in the game. Its barrels' Fire layers in barrel order, when it has two or more, each with its
// fire point and none of them a second fire mode (a round of its own: fxmap.js ALT_BY_FOLDER, the
// Hybrid's ACT_FIRE1 grenades); else null. shotFor: Viewer.shotFor.
export function fireTurns(info, shotFor = null) {
  const points = new Set(firePointsOf(info?.nodes).map((n) => firePointNumber(n.name)));
  const byBarrel = new Map();
  for (const l of info?.layers || []) {
    const n = fireNumber(l.activity);
    if (n != null && points.has(n) && !byBarrel.has(n)) byBarrel.set(n, l);
  }
  if (byBarrel.size < 2) return null;
  const kind = (act) => shotFor?.(info.path, act)?.kind ?? null;
  const turns = [...byBarrel.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  return turns.some((l) => kind(l.activity) !== kind(null)) ? null : turns;
}

// Shots a second by the kind of round (fxmap.js SHOTS): a gun whose Fire has no clip of its own fires
// this fast (firing.js; there also until its clip is read), and so do a rocket pod's tubes in a salvo
// (gunBeat). A held beam's shot keeps it on, a stream (a flamethrower's) launches its rounds every
// spec.stream seconds besides.
const RATE = {
  mg: 9, mgHeavy: 7, smg: 14, minigun: 20, autocannon: 4, autocannonRelic: 2.5, cannon: 0.5, cannonBig: 0.35, shotgun: 1, grenade: 1.6, mortar: 0.4,
  rocket: 4, guided: 1.2, rocketSpiral: 3, grenadeHeavy: 0.5, stickyGrenade: 1, cannonArtillery: 0.35, bladesFan: 0.8,
  crossbow: 0.8, crossbowSpike: 0.7, crossbowBurst: 2.5, ballista: 0.5, railCrossbow: 0.5, crossbowSticky: 0.8, crossbowTempo: 1.2, crossbowTempoLegend: 1.5,
  crossbowRevolver: 1.5, plasma: 0.7, fusion: 2.5, railgun: 0.4, revolver: 1.5, carabine: 1.5, nail: 1, coilgun: 0.4, frostArtillery: 0.5, sticky: 0.8,
  selfdamage: 0.4, plasmaCutter: 1, lightning: 1.5, laserRevolver: 1.2, harpoon: 0.5, sawLegend: 0.6, sawRelic: 0.6, disc: 0.8, blades: 0.8,
  wheelBomb: 0.4, wheelBombEpic: 0.4, trainWheel: 0.4, barrel: 0.5, mine: 0.6, trap: 0.3, ionShield: 0.2, drone: 0.15, droneLegend: 0.15, fence: 0.4, tntSpear: 0.5,
};
export const rateOf = (spec) => ((spec?.beam && !spec.pulse) || spec?.stream ? 1 : RATE[spec?.kind] || 1);

// When a gun's shots go out while it fires (Viewer.beatOf): null at its own pace, a shot each loop of
// its Fire clip (machine guns, autocannons, flamethrowers, beams: what fires non-stop in the game), else
// a pull of the trigger every so many seconds: the shot timer's (every: Viewer.fireEvery), or the game's
// reload time (stats.json: crosscalc's shooting_cooldown; only from a second up, below that it is the
// pace within a magazine, about the Fire clip's own). At each pull one shot goes out, a rocket pod with
// a reload time fires each of its tubes one after another (tubes: its fire points, Viewer.firePoints)
// at its own pace or its round's rate (period, rate), whichever is quicker, all within the first 60 %
// of the beat.
export function gunBeat({ every = 0, reload = 0, tubes = 1, period = 1, rate = 1 }) {
  const beat = every > 0 ? every : reload >= 1 ? reload : 0;
  if (!(beat > 0)) return null;
  const shots = reload >= 1 && tubes > 2 ? tubes : 1;
  return { every: beat, shots, gap: shots > 1 ? Math.max(0.03, Math.min(period, 1 / rate, (beat * 0.6) / shots)) : 0 };
}

// The shot of a beat that went out last by a clock (seconds since the gun began to fire, its first shot
// at once): its number (every shot of a salvo counts) and the seconds since it.
export function beatShot(clock, beat) {
  const s = Math.floor(clock / beat.every + 1e-9), t = clock - s * beat.every;
  const j = beat.shots > 1 ? Math.min(beat.shots - 1, Math.floor(t / beat.gap + 1e-9)) : 0;
  return { k: s * beat.shots + j, since: t - j * beat.gap };
}

const byNode = new WeakMap(); // clip -> Map(node name -> track)
function tracksByNode(clip) {
  let m = byNode.get(clip);
  if (!m) byNode.set(clip, (m = new Map(clip.tracks.map((tr) => [tr.node, tr]))));
  return m;
}

// "ACT_FIRE1" -> "Fire 1", "AimYaw" -> "Aim yaw", "TrackSuspension3" -> "Track suspension 3"
export function prettyName(s) {
  const t = s.replace(/^ACT_/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Za-z])(\d)/g, '$1 $2').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const _rest = new THREE.Quaternion(), _zero = new THREE.Vector3(), NONE = [null, null];
const _aimM = new THREE.Matrix4(), _aimP = new THREE.Vector3(), _aimS = new THREE.Vector3(), DEG = 180 / Math.PI;
const turnDiff = (a) => ((((a % 360) + 540) % 360) - 180); // an angle difference the short way round, -180..180

const isPoseLayer = (l) => !!(l?.pose && (l.file || l.files?.length > 1));
// Key k of a track as [tx, ty, tz, qx, qy, qz, qw]; no track (or no translation / rotation in it) is the rest pose.
function keyOf(tr, k) {
  const t = tr?.t, r = tr?.r;
  return (t ? [t[k * 3], t[k * 3 + 1], t[k * 3 + 2]] : [0, 0, 0]).concat(r ? [r[k * 4], r[k * 4 + 1], r[k * 4 + 2], r[k * 4 + 3]] : [0, 0, 0, 1]);
}
// Do two keys differ by more than half a degree or a millimetre?
const differ = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6]))) > Math.PI / 360 ||
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.001;

// The value of an aim parameter that points the gun at an angle, from its samples ([value, angle],
// angles running on past ±180 for yaw): inside a sampled stretch that spans the angle (yaw: or a
// whole turn either side of it), the one nearest the current value; out of reach, the sample that
// comes closest to the angle.
function aimValue(ax, angle, cur) {
  const t = ax.table, yaw = ax.yaw;
  const dist = (v) => (ax.full ? Math.abs(turnDiff(v - cur)) : Math.abs(v - cur));
  let best = null, cost = Infinity;
  for (let k = 0; k + 1 < t.length; k++) {
    const [v0, a0] = t[k], [v1, a1] = t[k + 1];
    if (a0 === a1) continue;
    for (const x of yaw ? [angle - 360, angle, angle + 360] : [angle]) {
      if (x < Math.min(a0, a1) || x > Math.max(a0, a1)) continue;
      const v = v0 + ((x - a0) / (a1 - a0)) * (v1 - v0), c = dist(v);
      if (c < cost) { cost = c; best = v; }
    }
  }
  if (best !== null) return best;
  for (const [v, a] of t) {
    const c = (yaw ? Math.abs(turnDiff(a - angle)) : Math.abs(a - angle)) * 1000 + dist(v);
    if (c < cost) { cost = c; best = v; }
  }
  return best;
}
// The sampled angle at a value (the samples run from the lowest value to the highest).
function aimAngle(ax, v) {
  const t = ax.table;
  if (v <= t[0][0]) return t[0][1];
  for (let k = 0; k + 1 < t.length; k++) {
    const [v0, a0] = t[k], [v1, a1] = t[k + 1];
    if (v <= v1) return v1 === v0 ? a1 : a0 + ((v - v0) / (v1 - v0)) * (a1 - a0);
  }
  return t[t.length - 1][1];
}

export class Animator {
  constructor(viewer, info, group) {
    this.v = viewer;
    this.info = info;
    this.group = group;
    this.belts = null; // (belts, chains and tracks whose texture slides with a wheel: belts.js)
    this.skel = group.userData.skeleton || null;
    this.layers = new Map((info.layers || []).map((l) => [l.name, l]));
    // A gun the game gives no Fire (17 models: no animations at all, the guided rocket launchers and
    // the twin bomb launcher among them, or none for firing, the lock-on launcher with only OPEN and
    // IDLE): a Fire of the viewer's own, with no clip, so it fires the way a flamethrower's pose-only
    // Fire does, again as its muzzle effect ends (Viewer.shotPeriod)
    if (firePointsOf(info.nodes).length && viewer.shotFor?.(info.path)
      && ![...this.layers.values()].some((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || ''))) {
      let name = 'fire';
      while (this.layers.has(name)) name += '_';
      this.layers.set(name, { name, activity: 'FIRE', file: null, files: null, pose: null, add: [], own: true });
      this.ownFire = name;
    }
    // A gun that fires its barrels in turn (fireTurns): one more Fire, "Fire 1 + 2", that plays their Fires
    // one after the other, a shot each, each from its own barrel (turns: their layers' names)
    const turns = fireTurns(info, viewer.shotFor);
    if (turns) {
      let name = 'fire_in_turn';
      while (this.layers.has(name)) name += '_';
      const label = `Fire ${turns.map((l) => fireNumber(l.activity)).join(' + ')}`;
      this.layers.set(name, { name, activity: 'FIRE_IN_TURN', label, file: null, files: null, pose: null, add: [], own: true, turns: turns.map((l) => l.name) });
    }
    this.clips = new Map(); // layer name -> clip
    this.blends = new Map(); // layer name -> [pose clips] spread over the pose range
    this.active = null;
    this.playing = true;
    this.speed = 1;
    this.time = 0;
    this.sweep = false;
    this.loaded = false;
    this.playCache = new Map(); // active layer -> { layers: the pose layers that play, ranges: the sliders }
    this.moveCache = new Map(); // layer name -> does it move anything
    this.rigCache = new Map(); // active layer -> how the gun aims (aimRig), or null
    this.noTime = false; // apply() leaves the time clips out (while the aim is measured)
    // every parameter starts at 0, the rest pose (straight ahead, level, centred), within its layers' ranges
    this.pose = {};
    const span = {};
    for (const l of this.layers.values()) {
      if (!isPoseLayer(l)) continue;
      const s = (span[l.pose.name] ||= [Infinity, -Infinity]);
      s[0] = Math.min(s[0], l.pose.min, l.pose.max);
      s[1] = Math.max(s[1], l.pose.min, l.pose.max);
    }
    for (const [name, [lo, hi]] of Object.entries(span)) this.pose[name] = Math.min(hi, Math.max(lo, 0));
    this.boneOf = new Map(this.skel ? this.skel.bones.map((b, i) => [b.name, i]) : []);
    this.timeCache = new Map(); // active layer -> its time clips (fixed once the clips are loaded)
  }

  // Can this part move at all? (a skeleton plus at least one clip; or fire: ownFire)
  get available() { return (!!this.skel && [...this.layers.values()].some((l) => l.file || l.files?.length > 1)) || !!this.ownFire; }

  // Does it have clips of its own (a skeleton that moves)? A part that only fires has none.
  get animated() { return !!this.skel && [...this.layers.values()].some((l) => l.file || l.files?.length > 1); }

  // Activity layers the user can pick, in file order.
  activities() {
    return [...this.layers.values()].filter((l) => l.activity && (l.own || this.stackHasClip(l.name, new Set())));
  }

  stackHasClip(name, seen) {
    if (seen.has(name)) return false;
    seen.add(name);
    const l = this.layers.get(name);
    if (!l) return false;
    return !!l.file || l.files?.length > 1 || l.add.some((a) => this.stackHasClip(a, seen));
  }

  // The sliders: one per parameter that moves something in the layers playing now, over their
  // ranges low to high (many .model files declare them high to low, "AimPitch 60 -29", and a range
  // input whose min is above its max cannot move; apply() maps the value onto each clip in the
  // declared order).
  poses() {
    return Object.entries(this.playingPoses().ranges).map(([name, r]) => ({ name, ...r, value: Math.min(r.max, Math.max(r.min, this.pose[name])) }));
  }

  // An activity's stack: its layer and the layers it adds, recursively.
  stackOf(name, out = new Set()) {
    const l = this.layers.get(name);
    if (!l || out.has(name)) return out;
    out.add(name);
    for (const a of l.add || []) this.stackOf(a, out);
    return out;
  }

  // The pose layers that play now, in file order. The game plays the picked activity's stack, and
  // different activities may hold the same clip on the same parameter (a flamethrower's "aim" for
  // IDLE and "fire" for FIRE; a leg's "move" for IDLE and "move_z" for WALK): playing every layer
  // at once turned those bones twice as far. With nothing picked it is IDLE's stack (else the first
  // activity's). Pose layers no activity adds always play, and a parameter the stack leaves out (a
  // rolling mech leg's wheel while it walks, a pop-up gun's Height outside OPEN) takes its layers
  // from the first stack that has it, so no slider goes missing.
  playingPoses() {
    const key = this.active || '';
    let p = this.playCache.get(key);
    if (p) return p;
    const all = [...this.layers.values()], acts = all.filter((l) => l.activity);
    let root = (this.active && this.layers.get(this.active)) || acts.find((l) => l.activity === 'IDLE') || acts[0];
    if (root?.turns) root = this.layers.get(root.turns[0]) || root; // (fired in turn: it aims as its barrels' Fires do)
    const stacks = acts.map((a) => this.stackOf(a.name));
    const inStack = new Set(stacks.flatMap((s) => [...s]));
    const base = root ? this.stackOf(root.name) : new Set();
    const chosen = new Set(all.filter((l) => isPoseLayer(l) && (base.has(l.name) || !inStack.has(l.name))).map((l) => l.name));
    const driven = new Set(all.filter((l) => chosen.has(l.name) && this.moves(l)).map((l) => l.pose.name));
    for (const s of stacks) {
      const add = [...s].map((n) => this.layers.get(n)).filter((l) => isPoseLayer(l) && !driven.has(l.pose.name));
      for (const l of add) chosen.add(l.name);
      for (const l of add) if (this.moves(l)) driven.add(l.pose.name);
    }
    const layers = all.filter((l) => chosen.has(l.name)), ranges = {};
    for (const l of layers) {
      if (!this.moves(l)) continue;
      const r = (ranges[l.pose.name] ||= { min: Infinity, max: -Infinity });
      r.min = Math.min(r.min, l.pose.min, l.pose.max);
      r.max = Math.max(r.max, l.pose.min, l.pose.max);
    }
    p = { layers, ranges };
    this.playCache.set(key, p);
    return p;
  }

  // Does a pose layer move anything? Some do not (an empty clip, one unchanging key, a 0..0 range:
  // ballcannon's and catapult's yaw, wheel_launcher's pitch, track_dow's suspension 1 and 8), and
  // get no slider. Until the clips are loaded every layer with a clip counts.
  moves(l) {
    if (!this.loaded) return true;
    let m = this.moveCache.get(l.name);
    if (m === undefined) this.moveCache.set(l.name, (m = this.measureMoves(l)));
    return m;
  }

  measureMoves(l) {
    if (!this.skel || l.pose.min === l.pose.max) return false;
    const clip = this.clips.get(l.name), poses = this.blends.get(l.name);
    if (clip) return clip.tracks.some((tr) => this.boneIndex(tr) >= 0 && tr.times.some((_, k) => differ(keyOf(tr, 0), keyOf(tr, k))));
    if (!poses) return false;
    const nodes = new Set();
    for (const p of poses) for (const tr of p.tracks) if (tr.times.length && this.boneIndex(tr) >= 0) nodes.add(tr.node);
    for (const node of nodes) { // (a pose without the bone has it at rest)
      const keys = poses.map((p) => { const tr = tracksByNode(p).get(node); return keyOf(tr?.times.length ? tr : null, 0); });
      if (keys.some((k) => differ(k, keys[0]))) return true;
    }
    return false;
  }

  async load() {
    const jobs = [...this.layers.values()].filter((l) => l.file || l.files?.length > 1).map(async (l) => {
      try { // a missing clip only disables that layer
        if (l.file) this.clips.set(l.name, await loadClip(l.file));
        else this.blends.set(l.name, await Promise.all(l.files.map(loadClip)));
      } catch { /* ignore */ }
    });
    await Promise.all(jobs);
    this.loaded = true;
    this.moveCache.clear();
    this.playCache.clear();
    this.rigCache.clear();
    this.timeCache.clear();
    // start on the idle loop when there is one that actually moves something over time
    const idle = this.activities().find((l) => l.activity === 'IDLE' && this.timeClips(l.name).length);
    this.active = idle ? idle.name : null;
    this.apply();
    this.belts = setupBelts(this.group, this.info, this);
  }

  // Layers of a stack that play over time (no pose parameter); cached per stack (no allocation per frame).
  timeClipsOf(name) {
    let out = this.timeCache.get(name);
    if (!out) this.timeCache.set(name, (out = this.timeClips(name)));
    return out;
  }

  // The stack's own clip first, then the layers it adds, on top of it (as "addLayer" says): a
  // later layer's offsets are in the frame the earlier ones left the bone in. The order shows where
  // one clip moves a bone another one turns: the Porcupine's FIRE and reload roll the next barrel
  // 61 cm forward while the added idle spins it, and with the idle first that roll turned with the
  // spin (3 turns a second) and swung the barrel round a circle through the cage.
  timeClips(name, seen = new Set(), out = []) {
    if (seen.has(name)) return out;
    seen.add(name);
    const l = this.layers.get(name);
    if (!l) return out;
    if (l.file && !l.pose && this.clips.has(l.name)) out.push(l);
    for (const a of l.add) this.timeClips(a, seen, out);
    return out;
  }

  setActive(name) {
    this.active = name || null;
    this.time = 0;
    this.fireClock = 0;
    this.heldFor = null;
    this.shotCycle = this.projCycle = this.actCycle = null; // (the new activity fires on its first frame)
    this.v.stopShots?.(this.group);
    this.apply();
  }

  // The shot timer changed: the Fire starts over (its first shot at once, then on the new beat: gunBeat).
  restartFire() {
    if (!this.firing()) return;
    this.time = 0;
    this.fireClock = 0;
    this.heldFor = null;
    this.shotCycle = this.projCycle = null;
    this.v.stopShots?.(this.group);
    this.apply();
  }

  // a Fire activity plays (FIRE, ACT_FIRE2, BURST, FIRE_LAST ...)
  firing() { return /^(ACT_)?FIRE|^BURST/i.test(this.layers.get(this.active)?.activity || ''); }

  // How long one shot takes: a loop of the stack's first clip (a sixth of one for a rotary gun), or for a
  // gun whose Fire has no clip, its muzzle effect's length (Viewer.shotPeriod). Fired in turn: the
  // longest of its barrels' (each barrel's Fire has its shot's time to play out).
  shotPeriod() {
    const l = this.active ? this.layers.get(this.active) : null;
    return l?.turns ? Math.max(...l.turns.map((n) => this.periodOf(n))) : this.periodOf(this.active);
  }
  periodOf(name) {
    const tl = name ? this.timeClipsOf(name)[0] : null;
    return tl ? (this.clips.get(tl.name)?.duration || 1) / (tl.speed || 1) / this.shotsPerLoop(tl.name) : Math.max(0.1, this.v.shotPeriod?.(this.info) || 1);
  }

  // The stack whose clips play now, and its clock: the active one's, looping; fired in turn, shot k's
  // barrel's Fire (the k-th in turn), once from the start of that shot. act: the activity of shot k.
  nowPlaying() {
    const l = this.active ? this.layers.get(this.active) : null;
    if (!l?.turns) return { name: this.active, time: this.time, once: false };
    const period = this.shotPeriod(), k = Math.max(0, Math.floor(this.time / period + 1e-6));
    return { name: l.turns[k % l.turns.length], time: this.time - k * period, once: true };
  }
  shotActivity(k) {
    const l = this.active ? this.layers.get(this.active) : null;
    return (l?.turns ? this.layers.get(l.turns[k % l.turns.length])?.activity : l?.activity) || '';
  }
  // does the active stack play anything over time (fired in turn: any of its barrels' Fires)
  timed() {
    const l = this.active ? this.layers.get(this.active) : null;
    return !!l && (l.turns ? l.turns.some((n) => this.timeClipsOf(n).length) : this.timeClipsOf(this.active).length > 0);
  }

  // The clock runs on. While a Fire plays on a beat (gunBeat: the game's reload time, the shot timer)
  // each shot plays its own stretch of the Fire clip (a shot's period of it at the animation's speed:
  // the recoil, a rotary gun's sixth of a turn) and the gun holds still there until the next (a beat
  // quicker than the gun cuts the stretch short); as the stretch ends, what the gun keeps going while
  // it fires (a held beam, a flamethrower's flow, a minigun's motor) stops, as when it stops firing.
  advance(dt) {
    const beat = this.firing() ? this.beat() : null;
    if (!beat) { this.time += dt * this.speed; return; }
    this.fireClock = (this.fireClock || 0) + dt;
    const period = this.shotPeriod(), { k, since } = beatShot(this.fireClock, beat);
    this.time = k * period + Math.min(since * this.speed, period * 0.999);
    if (since * this.speed >= period && this.heldFor !== k) {
      this.heldFor = k;
      this.v.stopShots?.(this.group);
    }
  }
  // the beat the playing Fire fires on (Viewer.beatOf); null: at its own pace
  beat() {
    return this.v.beatOf?.(this.group, this.info, this.layers.get(this.active)?.activity || '', this.shotPeriod()) || null;
  }
  setPose(name, value) { this.pose[name] = value; this.apply(); }

  tick(dt) {
    if (this.v.part !== this.group) return; // (a part on its way out while the next one's textures load)
    if (!this.skel) { // (a part that only fires: ownFire)
      if (this.playing && this.active) { this.advance(dt); this.checkShot(); }
      return;
    }
    const moving = (this.playing && this.timed()) || this.sweep;
    if (!moving) {
      // a gun whose Fire is only an aim pose (flamethrowers) fires all the same: its clock runs on
      if (this.playing && this.active) { this.advance(dt); this.checkShot(); }
      return;
    }
    if (this.playing) {
      this.advance(dt);
      this.v.stepShots?.(this.group, dt * this.speed); // (a fired projectile flies on: syncAttached)
      this.checkShot();
    }
    if (this.sweep) {
      const t = performance.now() / 1000;
      Object.entries(this.playingPoses().ranges).forEach(([name, r], i) => {
        const mid = (r.min + r.max) / 2, half = (r.max - r.min) / 2;
        this.pose[name] = /rotation/i.test(name) // wheels spin round and round
          ? r.min + (((t * 90) % (r.max - r.min)) + (r.max - r.min)) % (r.max - r.min)
          : mid + half * 0.8 * Math.sin(t * (0.6 + 0.17 * i) + i);
      });
      this.onPoseChange?.();
    }
    this.apply();
  }

  // A Fire activity (FIRE, ACT_FIRE2, BURST, FIRE_LAST ...) fires a shot each time its stack's
  // first clip starts over, and the viewer plays the gun's muzzle effect (Viewer.onShot). A rotary
  // gun's clip turns its barrels round once (the miniguns: 360 degrees in 0.42 s at speed 1.5),
  // six shots; a gun whose Fire is only an aim pose (a flamethrower) fires again as its effect ends.
  checkShot() {
    const l = this.active ? this.layers.get(this.active) : null;
    const act = l?.activity || '';
    if (!/^(ACT_)?FIRE|^BURST/i.test(act)) {
      this.shotCycle = null;
      // another activity (a reload, a charge, a hatch, a saw's attack): once each time its clip starts over
      const tl = act ? this.timeClipsOf(this.active)[0] : null, dur = tl ? (this.clips.get(tl.name)?.duration || 0) / (tl.speed || 1) : 0;
      if (dur > 0) {
        const k = Math.floor(this.time / dur + 1e-6);
        if (k !== this.actCycle) { this.actCycle = k; this.v.onActivity?.(this.group, act, k, this.info, l.name); }
      }
      return;
    }
    const period = this.shotPeriod();
    const k = Math.floor(this.time / period + 1e-6);
    if (k !== this.shotCycle) {
      this.shotCycle = k;
      this.v.onShot?.(this.group, this.shotActivity(k), k, this.info); // (fired in turn: from that shot's barrel)
    }
    // a flamethrower's flame rides projectiles, launched so many a second while it fires
    const proj = this.v.projectileOf?.(this.info);
    if (proj) {
      const kp = Math.floor(this.time / proj.every + 1e-6);
      if (kp !== this.projCycle) { this.projCycle = kp; this.v.onProjectile?.(this.group, act, kp, this.info, proj); }
    }
  }

  // shots in one loop of a Fire clip (rotaryShots)
  shotsPerLoop(name) {
    const was = (this.loopShots ||= new Map()).get(name);
    if (was) return was;
    const n = rotaryShots(this.clips.get(name));
    this.loopShots.set(name, n);
    return n;
  }

  // Rest pose, then the playing pose layers at their values, then the active stack's time clips.
  apply() {
    if (!this.skel) return;
    const { bones, rest } = this.skel;
    bones.forEach((b, i) => { b.position.copy(rest[i].p); b.quaternion.copy(rest[i].q); });
    for (const l of this.playingPoses().layers) {
      const u = Math.min(1, Math.max(0, l.pose.max === l.pose.min ? 0 : (this.pose[l.pose.name] - l.pose.min) / (l.pose.max - l.pose.min)));
      const clip = this.clips.get(l.name), poses = this.blends.get(l.name);
      if (clip) this.applyClip(clip, u * clip.duration);
      else if (poses) { // between the two poses around the value
        const x = u * (poses.length - 1), i = Math.min(poses.length - 2, Math.floor(x));
        this.applyBlend(poses[i], poses[i + 1], x - i);
      }
    }
    if (this.active && !this.noTime) {
      const now = this.nowPlaying();
      for (const l of this.timeClipsOf(now.name)) {
        const clip = this.clips.get(l.name);
        // (fired in turn: the barrel's own Fire once from its shot; the layers it adds, an idle spin, run on
        // the clock as with one Fire, where they started over with every shot)
        const once = now.once && l.name === now.name;
        const d = clip.duration || 1, t = (once ? now.time : this.time) * (l.speed || 1);
        this.applyClip(clip, once ? Math.min(Math.max(t, 0), d) : ((t % d) + d) % d);
      }
    }
    this.skel.version = (this.skel.version || 0) + 1; // the viewer's hover picking re-measures on change
    if (!this.noTime) { // (not while the aim is measured)
      this.belts?.update();
      // (the projectiles shown on its nodes: which show, and which one is fired: only when firing, a
      // reload rolls a new one in the same way)
      this.v.syncAttached?.(this.group, /^FIRE/i.test(this.layers.get(this.active)?.activity || ''));
    }
    this.v.shadowDirty = true; // moving parts move their shadows
    this.v.dirty = true;
  }

  // ---- Look at me: the gun turns to face a point (the camera) ----
  // The game aims by setting AimYaw / AimPitch to the target's angles in degrees, and on 226 of the
  // 254 parts that aim, the gun turns by exactly that. On the rest the clip turns it by other
  // amounts: the rocket crossbow 34° over its -29..60, the quadrocopter gun 12° low, the harpoon's
  // pitch the other way round, mortars from straight up. So the aim is measured, not assumed: the
  // gun bone's +Z is the barrel, where it points is sampled across each parameter once (per
  // activity), and each frame the values that point it at the target are read back from the samples.
  aimRig() {
    const key = this.active || '';
    if (!this.rigCache.has(key)) this.rigCache.set(key, this.measureAim());
    return this.rigCache.get(key);
  }

  // How much of the part a bone carries: the skin weight of its vertices and its children's (the
  // same for every activity: worked out once).
  carried(b) {
    if (!this.carriedBy) {
      const own = new Map();
      for (const m of this.group.children) {
        if (!m.isSkinnedMesh) continue;
        const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
        for (let k = 0; k < si.count; k++)
          for (let c = 0; c < 4; c++) {
            const w = sw.getComponent(k, c);
            if (w > 0) { const bn = m.skeleton.bones[si.getComponent(k, c)]; own.set(bn, (own.get(bn) || 0) + w); }
          }
      }
      this.carriedBy = new Map();
      const sum = (x) => {
        let t = own.get(x) || 0;
        for (const c of x.children) if (c.isBone) t += sum(c);
        this.carriedBy.set(x, t);
        return t;
      };
      for (const x of this.skel.bones) if (!this.carriedBy.has(x)) sum(x);
    }
    return this.carriedBy.get(b) || 0;
  }

  measureAim() {
    const sl = Object.fromEntries(this.poses().map((p) => [p.name, p]));
    const Y = sl.AimYaw, P = sl.AimPitch;
    if (!this.skel || (!Y && !P)) return null;
    const bones = this.skel.bones, index = new Map(bones.map((b, i) => [b, i]));
    const saved = { ...this.pose };
    this.noTime = true; // (an idle wobble would end up in the samples)
    const carried = (b) => this.carried(b);
    const neutral = () => { for (const p of [Y, P]) if (p) this.pose[p.name] = Math.min(p.max, Math.max(p.min, 0)); };
    const frame = (b) => { b.updateWorldMatrix(true, false); return _aimM.copy(this.group.matrixWorld).invert().multiply(b.matrixWorld); };
    const turnOf = (b) => { const q = new THREE.Quaternion(); frame(b).decompose(_aimP, q, _aimS); return q; };
    // How far each bone turns as a parameter goes from a quarter to three quarters of its range.
    const turnsBy = (p) => {
      neutral();
      this.pose[p.name] = p.min + 0.25 * (p.max - p.min); this.apply();
      const qa = bones.map(turnOf);
      this.pose[p.name] = p.min + 0.75 * (p.max - p.min); this.apply();
      return bones.map((b, i) => qa[i].angleTo(turnOf(b)));
    };
    // The gun: of the bones every aim parameter turns, the one carrying the most of the part, then on
    // down a chain while a child turns further and still carries at least 30% of it (the head at the
    // end of a legendary weapon's neck, not a gear, which turns further but carries little).
    // machinegun_side pitches first and then yaws: its gun is the yaw bone under the pitch bone.
    const pickGun = (turns) => {
      const last = turns[turns.length - 1];
      let best = -1;
      bones.forEach((b, i) => { if (turns.every((t) => t[i] > 2 / DEG) && (best < 0 || carried(b) > carried(bones[best]))) best = i; });
      for (let next = best; next >= 0;) {
        best = next;
        next = -1;
        for (const c of bones[best].children) {
          const k = index.get(c);
          if (k !== undefined && turns.every((t) => t[k] > 2 / DEG) && last[k] > last[best] + 1 / DEG && carried(c) >= 0.3 * carried(bones[best]) &&
            (next < 0 || carried(c) > carried(bones[next]))) next = k;
        }
      }
      return best;
    };
    const yt = Y ? turnsBy(Y) : null, pt = P ? turnsBy(P) : null;
    let gun = yt && pt ? pickGun([yt, pt]) : -1;
    if (gun < 0 && pt) gun = pickGun([pt]);
    if (gun < 0 && yt) gun = pickGun([yt]);
    if (gun < 0) { Object.assign(this.pose, saved); this.noTime = false; this.apply(); return null; }
    // The barrel is one of the gun bone's axes: the one that best follows the game's own aim
    // (yaw turns it towards -X, pitch tilts it up, from +Z) over a few poses. That is +Z on nearly
    // every part; -Y on the assassins drone (which shoots down from a hover), -Z on the heavy gun.
    const axisOf = (i, ax) => { const e = frame(bones[i]).elements; return new THREE.Vector3(e[ax.c * 4] * ax.s, e[ax.c * 4 + 1] * ax.s, e[ax.c * 4 + 2] * ax.s).normalize(); };
    const axes = [{ c: 2, s: 1 }, { c: 2, s: -1 }, { c: 0, s: 1 }, { c: 0, s: -1 }, { c: 1, s: 1 }, { c: 1, s: -1 }];
    const barrelOf = (i, ys, ps) => {
      const err = axes.map(() => 0);
      for (const yv of ys) for (const pv of ps) {
        neutral();
        if (Y && yv !== null) this.pose[Y.name] = yv;
        if (P && pv !== null) this.pose[P.name] = pv;
        this.apply();
        const y = (Y && yv !== null ? yv : 0) / DEG, p = (P && pv !== null ? pv : 0) / DEG;
        const want = new THREE.Vector3(-Math.sin(y) * Math.cos(p), Math.sin(p), Math.cos(y) * Math.cos(p));
        axes.forEach((ax, k) => { err[k] += axisOf(i, ax).angleTo(want); });
      }
      let best = 0;
      err.forEach((e, k) => { if (e < err[best] - 1e-3) best = k; }); // (+Z first on a tie)
      return axes[best];
    };
    const spread = (p) => (p ? [p.min, (p.min + p.max) / 2, p.max] : [null]);
    const yawSpread = Y ? (Y.max - Y.min >= 358 ? [-90, 0, 90] : spread(Y)) : [null];
    const barrel = barrelOf(gun, yawSpread, spread(P));
    let yaw = null, pitch = null;
    if (pt && pt[gun] > 2 / DEG) { // elevation of the barrel for each pitch value
      neutral();
      const table = [];
      for (let k = 0; k <= 36; k++) {
        const v = P.min + ((P.max - P.min) * k) / 36;
        this.pose[P.name] = v; this.apply();
        table.push([v, Math.asin(Math.max(-1, Math.min(1, axisOf(gun, barrel).y))) * DEG]);
      }
      pitch = { name: P.name, min: P.min, max: P.max, table };
    }
    if (yt) { // heading of the barrel for each yaw value, held as level as it goes
      // (if the yaw does not turn the gun, the bone it turns that carries the most stands in)
      const b = yt[gun] > 2 / DEG ? gun : pickGun([yt]);
      const bAxis = b < 0 ? null : b === gun ? barrel : barrelOf(b, yawSpread, [null]);
      neutral();
      if (pitch) this.pose[P.name] = pitch.table.reduce((s, x) => (Math.abs(x[1]) < Math.abs(s[1]) ? x : s))[0];
      const full = Y.max - Y.min >= 358, n = full ? 72 : 36, table = [];
      for (let k = 0; b >= 0 && k <= n; k++) {
        const v = Y.min + ((Y.max - Y.min) * k) / n;
        this.pose[Y.name] = v; this.apply();
        const z = axisOf(b, bAxis);
        if (Math.abs(z.y) > 0.97) continue; // straight up or down: no heading
        let a = Math.atan2(-z.x, z.z) * DEG;
        if (table.length) a += 360 * Math.round((table[table.length - 1][1] - a) / 360); // running on past ±180
        table.push([v, a]);
      }
      if (table.length > 1) yaw = { name: Y.name, min: Y.min, max: Y.max, full, yaw: true, onGun: b === gun, table };
    }
    Object.assign(this.pose, saved);
    this.noTime = false;
    this.apply();
    return yaw || pitch ? { gun, barrel, yaw, pitch } : null;
  }

  // The barrel's origin and direction in the part's frame (Look at me).
  barrel(rig) {
    const g = this.skel.bones[rig.gun];
    g.updateWorldMatrix(true, false);
    const e = _aimM.copy(this.group.matrixWorld).invert().multiply(g.matrixWorld).elements, { c, s } = rig.barrel;
    return { o: new THREE.Vector3(e[12], e[13], e[14]), d: new THREE.Vector3(e[c * 4] * s, e[c * 4 + 1] * s, e[c * 4 + 2] * s).normalize() };
  }

  // Turns the gun towards a point in the scene (the camera), easing there in about a tenth of a
  // second (dt: seconds since the last call; 0 goes straight there). True when anything moved.
  lookAt(point, dt) {
    if (this.v.part !== this.group) return false; // (on its way out)
    return this.aimAt(point, dt);
  }

  // The same for any copy of the part (a driven vehicle's turret: drive.js)
  aimAt(point, dt) {
    const rig = this.aimRig();
    if (!rig) return false;
    const target = this.group.worldToLocal(_aimP.copy(point)); // (the barrel's frame is the part's)
    const { o, d } = this.barrel(rig);
    const dx = target.x - o.x, dy = target.y - o.y, dz = target.z - o.z, flat = Math.hypot(dx, dz);
    // where the barrel points now, against where the samples say it should: on a few parts the yaw
    // and the pitch do not quite keep out of each other's way (the ravagers drone, machinegun_side),
    // and the difference is aimed off, frame by frame
    const now = { heading: Math.abs(d.y) < 0.97 ? Math.atan2(-d.x, d.z) * DEG : null, elev: Math.asin(Math.max(-1, Math.min(1, d.y))) * DEG };
    const k = dt > 0 ? 1 - Math.exp(-dt / 0.1) : 1;
    let moved = false;
    for (const [ax, angle] of [[rig.yaw, Math.atan2(-dx, dz) * DEG], [rig.pitch, Math.atan2(dy, flat) * DEG]]) {
      if (!ax || (ax.yaw && flat < 0.05 * Math.abs(dy))) continue; // (straight above or below: any heading will do)
      const cur = this.pose[ax.name];
      const off = ax.yaw ? (now.heading === null || !ax.onGun ? 0 : turnDiff(now.heading - aimAngle(ax, cur))) : now.elev - aimAngle(ax, cur);
      const goal = aimValue(ax, angle - (Math.abs(off) < 20 ? off : 0), cur);
      const step = ax.full ? turnDiff(goal - cur) : goal - cur;
      if (Math.abs(step) < 0.01) continue;
      let v = cur + step * k;
      if (ax.full) v = ax.min + ((((v - ax.min) % 360) + 360) % 360);
      v = Math.min(ax.max, Math.max(ax.min, v));
      if (Math.abs(v - cur) < 1e-4) continue; // (held at a limit: nothing moved, nothing to redraw)
      this.pose[ax.name] = v;
      moved = true;
    }
    if (moved) this.apply();
    return moved;
  }

  boneIndex(tr) {
    const bones = this.skel.bones;
    return this.boneOf.get(tr.node) ?? (tr.bone < bones.length ? tr.bone : -1);
  }

  // A track's offset at time t -> (t: Vector3 | null, r: Quaternion | null).
  sample(tr, t, outT, outR) {
    const ts = tr.times, n = ts.length;
    let k = 0;
    while (k + 1 < n && ts[k + 1] <= t) k++;
    const k2 = Math.min(n - 1, k + 1);
    const f = k2 === k || ts[k2] === ts[k] ? 0 : (t - ts[k]) / (ts[k2] - ts[k]);
    const T = tr.t ? outT.set(tr.t[k * 3] + (tr.t[k2 * 3] - tr.t[k * 3]) * f, tr.t[k * 3 + 1] + (tr.t[k2 * 3 + 1] - tr.t[k * 3 + 1]) * f, tr.t[k * 3 + 2] + (tr.t[k2 * 3 + 2] - tr.t[k * 3 + 2]) * f) : null;
    const R = tr.r ? outR.fromArray(tr.r, k * 4).slerp(_q2.fromArray(tr.r, k2 * 4), f) : null;
    return [T, R];
  }

  // Offset from rest: the translation in the parent's frame (as Maya keys a joint's translate:
  // recoils go back along the barrel, a crossbow's two limbs snap forward as mirror images; read in
  // the bone's own frame they kicked forward, up or sideways, and one limb swung back), the
  // rotation after the bone's rest rotation.
  applyDelta(b, T, R) {
    if (T) b.position.add(T);
    if (R) b.quaternion.multiply(R);
  }

  applyClip(clip, t) {
    const bones = this.skel.bones;
    for (const tr of clip.tracks) {
      const i = this.boneIndex(tr);
      if (i < 0 || !tr.times.length) continue;
      const [T, R] = this.sample(tr, t, _v, _q);
      this.applyDelta(bones[i], T, R);
    }
  }

  // Blend two single-key poses bone by bone (tracks matched by bone name). A bone missing from one
  // of them is at rest there: a wheel's -180° and 180° spin poses are empty files (28 wheels), and
  // minigun_relict's fire_mode_0 pose is; taking only the first pose's bones left those wheels
  // still for a third of a turn and stuck for another.
  applyBlend(a, b, f) {
    const ta = tracksByNode(a), tb = tracksByNode(b);
    for (const tr of a.tracks) this.blendTrack(tr, tb.get(tr.node), f);
    for (const tr of b.tracks) if (!ta.has(tr.node)) this.blendTrack(null, tr, f);
  }

  blendTrack(x, y, f) {
    const i = this.boneIndex(x || y);
    if (i < 0) return;
    const [T, R] = x?.times.length ? this.sample(x, 0, _v, _q) : NONE;
    const [T2, R2] = y?.times.length ? this.sample(y, 0, _v2, _q3) : NONE;
    const t = T || T2 ? (T || _v.set(0, 0, 0)).lerp(T2 || _zero, f) : null;
    const r = R || R2 ? (R || _q.identity()).slerp(R2 || _rest, f) : null;
    if (t || r) this.applyDelta(this.skel.bones[i], t, r);
  }
}
