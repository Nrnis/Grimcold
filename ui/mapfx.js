// A map's own particle effects in Maps mode, played the way the 3D Viewer plays a gun's (fx.js,
// fxview.js):
//  - what is placed on it (scene.effects, the game's EffectEntity: fires, burning tyres, torches,
//    smoke columns, steam, water leaks, sparks, an antenna's signal ...): the nearest within their
//    reach play where they stand, looping, at their own scale; one starting near the camera (or as
//    the map opens) has been burning a while already
//  - the weather's (the environment's AreaEffect: snow, rain, ash, petals, dust) around the camera;
//    none in the map's boxes that keep it out (under bridges, in tunnels), a box's own in a box that
//    has one (scene.areas)
// Like the map's sounds (ambience.js): off with Show > Effects, stopped while the window is in the
// background; they move on 30 times a second (fxview.js calm), lit by the map's light.
import * as THREE from 'three';

const MOST = 24; // effects playing at once: the nearest (by distance against reach)
const STAY = 1.15; // a playing one stops this much past its reach (no flicker at the edge)
const WARM = 2; // seconds one starting near the camera has played already
const REACH = [70, 1500]; // how far an effect is seen, metres: 40 times its size, held between these

// how far an effect is seen: from the space its file says it fills (its bounds), at its scale
export function reachOf(sys, scale = 1) {
  const b = sys.bounds;
  const size = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]) * 0.5 * scale;
  return Math.min(REACH[1], Math.max(REACH[0], (Number.isFinite(size) ? size : 1) * 40));
}

// what the panel calls a weather effect (particles/levels/snow_areal -> "snow")
export function weatherName(path) {
  const n = String(path || '').split('/').pop();
  if (!n) return '';
  if (/snow/.test(n)) return 'snow';
  if (/rain/.test(n)) return 'rain';
  if (/conflagration/.test(n)) return 'ash';
  if (/sakura/.test(n)) return 'petals';
  if (/fuzz/.test(n)) return 'fluff';
  if (/sand/.test(n)) return 'sand';
  if (/dust|basic/.test(n)) return 'dust';
  return n.replace(/_areal?$/, '').replace(/_/g, ' ');
}

// moves an effect on so many seconds at once (one starting where it has been going a while)
function warm(run, seconds) {
  for (let t = 0; t < seconds; t += 0.25) run.step(0.25);
}

export class MapEffects {
  // fx: FxView; sceneOf(): the map scene to play (null: nothing); envOf(): its environment (/mapenv)
  // or null; camera(): the camera; level(): how bright the unlit particles may be under the map's sky
  // (sky.js level: 1 on a clear day, low at night)
  constructor(fx, { sceneOf, envOf, camera, level }) {
    this.fx = fx;
    this.sceneOf = sceneOf;
    this.envOf = envOf;
    this.camera = camera;
    this.level = level;
    this.scene = null;
    this.spots = [];
    this.areas = [];
    this.weather = null; // { path, run }
    this.next = 0;
    this.away = false; // (the window in the background)
    window.addEventListener('blur', () => { this.away = true; this.stop(); });
    window.addEventListener('focus', () => { this.away = false; });
  }

  // the scene to play now (called every frame: cheap unless something changed)
  tick() {
    const want = this.away || document.hidden ? null : this.sceneOf();
    if (want !== this.scene) {
      this.stop();
      if (want) this.start(want);
    }
    if (!this.scene) return;
    const t = performance.now() / 1000;
    if (t < this.next) return;
    this.next = t + 0.25;
    this.update(t);
  }

  start(scene) {
    this.scene = scene;
    this.t0 = performance.now() / 1000;
    this.spots = (scene.effects || []).map((e) => {
      const m = e.m; // (3 x 4: the columns, then where it stands)
      return {
        path: e.effect, scale: e.scale || 1, pos: [m[9], m[10], m[11]], reach: null, run: null, asking: false,
        mat: [m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, m[9], m[10], m[11], 1],
      };
    });
    for (const p of new Set(this.spots.map((s) => s.path))) {
      this.fx.load(p).then((sys) => {
        if (this.scene !== scene) return;
        for (const s of this.spots) if (s.path === p) s.reach = sys ? reachOf(sys, s.scale) : 0;
      });
    }
    this.areas = (scene.areas || []).map((a) => {
      const m = a.m, M = new THREE.Matrix4().set(m[0], m[3], m[6], m[9], m[1], m[4], m[7], m[10], m[2], m[5], m[8], m[11], 0, 0, 0, 1);
      return { effect: a.effect || '', stops: !!a.stopsWeather, inv: M.invert() };
    });
  }

  stop() {
    for (const s of this.spots) { s.run?.stop(); s.run = null; }
    this.spots = [];
    this.areas = [];
    this.weather?.run?.stop();
    this.weather = null;
    this.lens?.run?.stop();
    this.lens = null;
    this.scene = null;
  }

  // the weather the camera is in: the environment's, a box's own, or none in a box that keeps it out
  weatherAt(cam) {
    let want = this.envOf()?.values?.AreaEffect || '';
    const p = new THREE.Vector3();
    for (const a of this.areas) {
      p.copy(cam).applyMatrix4(a.inv);
      if (Math.abs(p.x) > 0.5 || Math.abs(p.y) > 0.5 || Math.abs(p.z) > 0.5) continue;
      if (a.effect) return a.effect;
      if (a.stops) want = '';
    }
    return want;
  }

  update(t) {
    const cam = this.camera().position;
    // the placed effects: the nearest within their reach
    const near = [];
    for (const s of this.spots) {
      if (!s.reach) continue;
      const d = Math.hypot(s.pos[0] - cam.x, s.pos[1] - cam.y, s.pos[2] - cam.z);
      if (d < (s.run || s.asking ? s.reach * STAY : s.reach)) near.push({ s, d, k: d / s.reach });
    }
    near.sort((a, b) => a.k - b.k);
    const keep = new Set(near.slice(0, MOST).map((x) => x.s));
    for (const s of this.spots) if (s.run && !keep.has(s)) { s.run.stop(); s.run = null; }
    for (const { s, d } of near.slice(0, MOST)) {
      if (s.run || s.asking) continue;
      s.asking = true;
      const hot = t - this.t0 < 4 || d < s.reach * 0.6, scene = this.scene;
      this.fx.play(s.path, () => s.mat, { loop: true, scale: s.scale, coverGain: this.level, ambient: true }).then((run) => {
        s.asking = false;
        if (!run) { s.reach = 0; return; } // (not in the game's files: not asked again)
        if (this.scene !== scene || !this.spots.includes(s)) { run.stop(); return; }
        run.onEnd = () => { if (s.run === run) s.run = null; }; // (cleared with the rest: asked again)
        s.run = run;
        if (hot) warm(run, WARM);
      });
    }
    // the weather, around the camera: the game's boxes are born 1..16 m above their origin (snow,
    // falling 5 m in its life; rain from 8..10 m) and some +-15 m about it, so the origin goes 8 m
    // below the camera and 6 m ahead along the view: the box fills what the camera sees
    const want = this.weatherAt(cam);
    if ((this.weather?.path || '') !== want) {
      this.weather?.run?.stop();
      this.weather = want ? { path: want, run: null } : null;
      const w = this.weather;
      if (w) {
        const c = this.camera(), f = new THREE.Vector3();
        const at = () => {
          c.getWorldDirection(f);
          const l = Math.hypot(f.x, f.z) || 1;
          return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, c.position.x + (f.x / l) * 6, c.position.y - 8, c.position.z + (f.z / l) * 6, 1];
        };
        // (at least 3 pixels across, and twice as bright: a 2 cm flake drawn that big samples its
        // texture's smallest, blurred levels; the game's snow reads as clear white dots)
        const gain = () => this.level() * 2;
        this.fx.play(want, at, { loop: true, gain, coverGain: this.level, ambient: true, minPx: 3 }).then((run) => {
          if (!run) return;
          if (this.weather !== w) { run.stop(); return; }
          run.onEnd = () => { if (this.weather === w) this.weather = null; }; // (cleared: asked again)
          w.run = run;
          warm(run, 3);
        });
      }
    }
    // in the rain, drops on the lens: the game's raindrops_screen, heat-haze drops in a ball 2 to 5 m
    // round the camera that bend the view behind them (drawn by the haze pass), hung on the camera
    const wet = /rain/i.test(want) && !/norain/i.test(want);
    if (wet && !this.lens) {
      const lens = (this.lens = { run: null }), c = this.camera();
      this.fx.play('particles/levels/raindrops_screen', () => c.matrixWorld.elements, { loop: true, ambient: true }).then((run) => {
        if (!run) return; // (not in the game's files: not asked again while it rains)
        if (this.lens !== lens) { run.stop(); return; }
        run.onEnd = () => { if (this.lens === lens) this.lens = null; };
        lens.run = run;
        warm(run, 1.5);
      });
    } else if (!wet && this.lens) {
      this.lens.run?.stop();
      this.lens = null;
    }
  }

  // what plays now (for the panel and tests)
  get playing() { return this.spots.filter((s) => s.run).length; }
}
