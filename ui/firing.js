// Firing outside the 3D Viewer, while V is held. In the Vehicle Builder every weapon on the vehicle
// fires, each at its own pace, out of its own fire points, with its effects, rounds and sounds
// (Viewer.shoot), at the training target stood in front of the vehicle (the "Shots hit" distance);
// the builder's parts are still copies, so an animated one of each gun stands in while it fires
// (its Fire clip: the recoil, a minigun's spinning barrels).
// On a map, a gun fires from beside the camera at whatever the middle of the view looks at: its
// rounds land on the ground and the map's objects (MapView.segmentHit), guided ones steer there.
// Each gun fires as in the 3D Viewer: on the game's beat when it has a reload time (once per reload, a
// rocket pod a salvo), or on the shot timer (Viewer.fireEvery: every gun together), holding still in
// between (anim.js gunBeat); the others at their own pace, a shot each loop of their Fire clip.
import * as THREE from 'three';
import { firePeriod, fireTurns, Animator, beatShot, rateOf } from './anim.js';

export const MAP_GUN = 'models/weapons/machinegun_kpvt/machinegun_kpvt.mdl';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// what shot k of a gun fires as: its barrels in turn (Fire 1, Fire 2 ...: each out of its own), else FIRE
const shotAct = (g, k) => (g.turns ? g.turns[k % g.turns.length] : 'FIRE');
const V = THREE.Vector3;

export class Firing {
  // gunOf(): the gun Maps fires (a weapon model path); targetDist(): how far out the builder's target
  // stands (0: none, the rounds land on the floor)
  constructor(viewer, { build, mapView, gunOf = () => MAP_GUN, targetDist = () => 10 }) {
    this.v = viewer;
    this.build = build;
    this.map = mapView;
    this.gunOf = gunOf;
    this.targetDist = targetDist;
    this.on = false;
    this.guns = []; // { group, info, spec, period, t, k, st, sk }
    this.last = 0;
    this.aim = null; // on a map: the point the middle of the view looks at
    // the map's gun: a fire point beside the camera (fire_01 at its origin, its +Z the barrel)
    this.mapGun = new THREE.Group();
    this.mapGun.name = 'map gun';
    this.mapGun.matrixAutoUpdate = false;
    viewer.rangeSubject = () => this.subject();
    viewer.mapHit = (p0, p1) => mapView.segmentHit(p0, p1);
    viewer.mapAim = () => (this.aim ? this.aim.toArray() : null);
    viewer.frameHooks.push(() => this.tick());
    window.addEventListener('blur', () => this.stop()); // (V let go in another window)
    // a crosshair in the middle of the view while the map's gun fires
    this.cross = document.createElement('div');
    this.cross.className = 'fire-cross';
    this.cross.hidden = true;
    viewer.canvas.parentElement.appendChild(this.cross);
  }

  get active() { return this.v.mode === 'build' || (this.v.mode === 'map' && !!this.map.scene); }

  // the vehicle's guns: its weapons with something to fire or a muzzle effect
  vehicleGuns() {
    return this.build.instances.filter((i) => i.path.startsWith('models/weapons/') && (this.v.shotFor?.(i.path) || this.v.fxFor?.(i.path)));
  }

  // what the builder's target stands in front of (Viewer.rangeOf): the vehicle, its guns
  subject() {
    const guns = this.vehicleGuns();
    if (!guns.length) return null;
    const b = this.build.box();
    return { box: b, groups: guns.map((i) => i.group), key: [...b.min.toArray(), ...b.max.toArray()].map((x) => x.toFixed(2)).join(',') + '|' + guns.length };
  }

  gunState(group, info) {
    const spec = this.v.shotFor?.(info.path) || null;
    // turns: a gun that fires its barrels one after the other (anim.js fireTurns), the activity of each
    const g = { group, info, spec, period: 1 / rateOf(spec), t: 0, k: 0, st: 0, sk: 0, held: null, turns: fireTurns(info, this.v.shotFor)?.map((l) => l.activity) || null };
    if (info.layers?.length) firePeriod(info, this.v.shotFor).then((p) => { if (p > 0.02) g.period = p; }, () => {});
    return g;
  }

  // V pressed: the guns start firing (the first shot at once). false when there is nothing to fire.
  start() {
    if (this.on || !this.active) return false;
    if (this.v.mode === 'build') {
      const insts = this.vehicleGuns();
      this.guns = insts.map((i) => this.gunState(i.group, i.info));
      if (!this.guns.length) return false;
      this.guns.forEach((g, k) => this.animate(g, insts[k]));
      this.v.setTarget(this.targetDist()).then(() => this.v.frameRange({ unseen: true })); // (the camera behind the vehicle when the target is out of view)
    } else if (this.drive?.active) { // (driving: the vehicle's own guns, where they point)
      this.guns = this.drive.guns().filter((g) => this.v.shotFor?.(g.info.path) || this.v.fxFor?.(g.info.path)).map((g) => this.gunState(g.group, g.info));
      if (!this.guns.length) return false;
    } else {
      const path = this.gunOf() || MAP_GUN;
      this.aim = null; // (worked out afresh)
      const info = { path, name: path, nodes: [{ name: 'fire_01', matrix: IDENTITY }] };
      this.mapGun.userData.info = info;
      this.mapGun.userData.fireNodes = null; // (Viewer.fireBones: read again for this gun)
      this.placeMapGun();
      this.guns = [this.gunState(this.mapGun, info)];
    }
    for (const g of this.guns) this.v.preloadShots(g.info);
    this.cross.hidden = this.v.mode !== 'map'; // (driving: it is up all the time)
    this.mode = this.v.mode; // (another view: they stop, tick())
    this.on = true;
    this.last = performance.now();
    this.clock = 0;
    return true;
  }

  // An animated copy of a vehicle's gun (skinned, its Fire clip playing in step with its shots) in
  // place of the builder's still part, until V is let go (stop). Guns that do not move keep theirs.
  async animate(g, inst) {
    const v = this.v, info = inst.info;
    if (!(info.layers || []).some((l) => l.file || l.files?.length > 1)) return;
    const live = () => this.on && this.guns.includes(g) && v.mode === 'build' && inst.group.parent;
    let copy = null;
    try {
      copy = await v.makeModel(info, 0, { texMax: this.build.texMax, animate: true, paint: v.paintOf(inst.group) }); // (painted as the part is)
      if (!live() || !copy.userData.skeleton) throw 0;
      const a = new Animator(v, info, copy);
      await a.load();
      const fire = [...a.layers.values()].find((l) => l.turns) || [...a.layers.values()].find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || '')); // (its barrels in turn: Animator)
      if (!live() || !fire) throw 0;
      a.active = fire.name;
      a.time = this.clock; // (in step with its shots, which began with V)
      inst.group.updateMatrixWorld(true);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(inst.group.matrixWorld);
      a.apply();
      v.scene.add(copy);
      inst.group.visible = false;
      v.shadowDirty = true;
      g.anim = { a, copy, inst };
    } catch {
      if (copy) v.disposeModel(copy);
    }
  }

  // V let go: held beams and flows end, motors run down, bursts echo (Viewer.stopShots)
  stop() {
    if (!this.on) return;
    this.on = false;
    this.cross.hidden = !this.drive?.active;
    for (const g of this.guns) {
      if (!g.anim) continue;
      g.anim.inst.group.visible = true;
      this.v.disposeModel(g.anim.copy);
      g.anim = null;
    }
    this.guns = [];
    this.v.stopShots();
  }

  tick() {
    if (!this.on) return;
    if (!this.active || this.v.mode !== this.mode) { this.stop(); return; } // (V still held: the builder's guns fired on into the map)
    const now = performance.now(), dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    if (this.v.mode === 'map' && !this.drive?.active) this.placeMapGun();
    for (const g of this.guns) {
      const beat = this.v.beatOf(g.group, g.info, 'FIRE', g.period);
      let going = true; // (in its shot's own stretch: a stream flows)
      if (beat) {
        const { k, since } = beatShot(this.clock, beat);
        for (let n = 0; g.k <= k && n < 4; n++) { this.v.shoot(g.group, shotAct(g, g.k), g.k++, g.info); g.st = 0; } // (a stream starts again with each shot)
        g.k = Math.max(g.k, k + 1); // (after a stall: on with the beat, not every shot missed at once)
        going = since < g.period;
        if (g.anim) { g.anim.a.time = k * g.period + Math.min(since, g.period * 0.999); g.anim.a.apply(); }
        // once its shot has had its stretch, its held beam, flow or motor stops until the next
        if (!going && g.held !== k) { g.held = k; this.v.stopShots(g.group); }
      } else {
        if (g.anim) { g.anim.a.time = this.clock; g.anim.a.apply(); }
        g.t -= dt;
        for (let n = 0; g.t <= 0 && n < 4; n++) { this.v.shoot(g.group, shotAct(g, g.k), g.k++, g.info); g.t += g.period; }
      }
      if (g.spec?.stream && going) {
        g.st -= dt;
        for (let n = 0; g.st <= 0 && n < 4; n++) { this.v.shootStream(g.group, 'FIRE', g.sk++, g.spec); g.st += g.spec.stream; }
      }
    }
    this.v.dirty = true;
  }

  // The map's gun: a little ahead of the camera, below and to the right of the middle of the view (its
  // flash low on the right, out of the way of the aim), its barrel at what the middle of the view
  // looks at (the ground or an object; else far out).
  placeMapGun() {
    const cam = this.v.camera;
    cam.updateMatrixWorld();
    const e = cam.matrixWorld.elements;
    const right = new V(e[0], e[1], e[2]).normalize(), up = new V(e[4], e[5], e[6]).normalize(), fwd = new V(-e[8], -e[9], -e[10]).normalize(), eye = new V(e[12], e[13], e[14]);
    // (what the view looks at: worked out again when the camera moved, else ten times a second)
    const now = performance.now(), key = e.join(',');
    if (!this.aim || key !== this.aimKey || now - this.aimAt > 100) {
      const far = Math.max(200, this.map.viewDistance || 1500);
      const h = this.map.segmentHit(eye.toArray(), eye.clone().addScaledVector(fwd, far).toArray());
      this.aim = h ? new V().fromArray(h.point) : eye.clone().addScaledVector(fwd, far);
      this.aimKey = key;
      this.aimAt = now;
    }
    const o = eye.clone().addScaledVector(right, 0.9).addScaledVector(up, -0.85).addScaledVector(fwd, 2.4);
    const z = this.aim.clone().sub(o);
    if (z.lengthSq() < 1e-6) z.copy(fwd); else z.normalize();
    const x = new V().crossVectors(up, z);
    if (x.lengthSq() < 1e-8) x.copy(right); else x.normalize();
    const y = new V().crossVectors(z, x);
    this.mapGun.matrix.makeBasis(x, y, z).setPosition(o);
    this.mapGun.matrixWorld.copy(this.mapGun.matrix);
  }
}
