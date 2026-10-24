// The game's particle effects (particles/**/*.psys, binary, version 17; 18 since Crossout 2.41, laid
// out the same): read and simulated here,
// drawn by fxview.js. No three.js in this file (tools/fxcheck.mjs runs it in Node).
//
// Layout (little-endian; see CROSSOUT_FORMATS.md "Particle effects"):
//   header 48: u32 17 (or 18), u32 emitters, 0, 0, f32 bounds min xyz + max xyz, f32 duration, u32 flags (1: loops)
//   emitters x 272, spawners x 128 (each emitter's +0x28 of them, in emitter order), baked particles
//   x 32 (+0x2c), extra blocks x 176 (one per emitter whose +0x48 is set), then 80-byte parameter
//   slots (each emitter's spawn ones from +0x50, its life ones from +0x58), then a blob of names
//   (textures, meshes) and curve keys that the slots and emitters point into (byte offsets).
// Values are in the game's left-handed space; mirrored to glTF's (z -> -z) as they are read.

const HEADER = 48, EMITTER = 272, SPAWNER = 128, BAKED = 32, EXTRA = 176, SLOT = 80;

// parameter ids (slot +0x14)
export const P = { POS: 0, ROT3: 1, VEL: 2, RGB: 3, ALPHA: 4, SIZE: 5, SIZEX: 6, SIZEY: 7, P8: 8, ANGLE: 9, LIFE: 10, FRAME: 11 };
const MIRROR = { [P.POS]: [1, 1, -1], [P.VEL]: [1, 1, -1], [P.ROT3]: [-1, -1, 1] }; // (z mirrored: turns about x and y reverse)

// how an emitter draws its particles (+0x60)
export const ORIENT = { BILLBOARD: 0, VELOCITY: 1, TRAIL: 2, LIGHT: 3, MESH: 4 };
// how it blends (+0x66): 1 adds light; 0, 3, 7 cover; 2 and 5 are lit by the scene (smoke with a
// normal map); 4 and 6 bend what is behind (heat haze); 8 pushes the water's surface (all on
// particles/textures/water/layered: _v its displacement, _w its normal and foam: ripples, splashes,
// wakes, a cannon's blast over water), not seen as sprites
export const BLEND = { ALPHA: 0, ADD: 1, LIT: 2, ALPHA2: 3, HAZE2: 4, SMOKE: 5, HAZE: 6, ALPHA3: 7, WATER: 8 };

// Which of an emitter's four textures is what. Before 2.41: the colour, a normal map (lit smoke) or
// the mask a glow takes its heat from, -, a heat ramp. Since 2.41 the smoke, fire and explosion
// flip-books (particles/textures/smoke_new, fire_new, explosion_new) name motion vectors first (*_mv,
// BC5: how each frame's texels move on into the next, red / green around 0.5, green up), the picture
// second (*_naa, BC7: a normal map in red / green, the smoke's own shading in blue, its density in
// alpha), where it glows third (*_remap, BC4, through the ramp) and the ramp fourth; some name the
// _naa first, or a colour texture third. Told apart by the names' endings.
export function textureRoles(textures) {
  const is = (s, end) => !!s && s.replace(/\.dds$/i, '').toLowerCase().endsWith('_' + end);
  const find = (end) => textures.slice(0, 3).find((s) => is(s, end)) || null;
  const mv = find('mv'), naa = find('naa'), remap = find('remap');
  const plain = (s) => !!s && !is(s, 'mv') && !is(s, 'naa') && !is(s, 'remap');
  return {
    mv, naa, remap, ramp: textures[3] || null,
    // the colour: the first slot's, else (the vectors there, no _naa) the third's
    color: plain(textures[0]) ? textures[0] : mv && !naa && plain(textures[2]) ? textures[2] : null,
    // a normal map, or a glow's mask (heat ramps)
    second: plain(textures[1]) ? textures[1] : null,
  };
}

function cstr(u8, off) {
  if (off < 0 || off >= u8.length) return null;
  let e = off;
  while (e < u8.length && u8[e]) e++;
  return String.fromCharCode(...u8.subarray(off, e));
}

// One value source of a parameter slot (16 bytes): type 2 a constant, 3 a straight line between
// two values, 1 a polyline and 0 a Bezier curve over an input, 4 a table over two inputs. Inputs
// ("channels"): 0 the effect's time (0..1 over its duration), 1 the particle's age (0..1 over its
// life), 2..7 random numbers each particle draws once.
function readComp(dv, u8, at, blob) {
  const type = u8[at], ch = u8[at + 1], ch2 = u8[at + 2], n = dv.getUint32(at + 4, true), off = dv.getUint32(at + 8, true);
  if (type === 2) return { type, value: dv.getFloat32(at + 8, true) };
  const b = blob + off;
  if (type === 3) return { type, ch, a: dv.getFloat32(b, true), b: dv.getFloat32(b + 4, true) };
  if (type === 1 || type === 0) {
    const step = type === 1 ? 8 : 16, t = new Float32Array(n), v = new Float32Array(n), i = new Float32Array(n), o = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const q = b + k * step;
      t[k] = dv.getUint32(q, true) / 65535;
      v[k] = dv.getFloat32(q + 4, true);
      i[k] = type === 0 ? dv.getFloat32(q + 8, true) : v[k];
      o[k] = type === 0 ? dv.getFloat32(q + 12, true) : v[k];
    }
    return { type, ch, t, v, i, o };
  }
  if (type === 4) { // (n: columns - 1 | rows - 1 << 16), row by row
    const nx = (n & 0xffff) + 1, ny = (n >>> 16) + 1, data = new Float32Array(nx * ny);
    for (let k = 0; k < data.length; k++) data[k] = dv.getFloat32(b + k * 4, true);
    return { type, ch, ch2, nx, ny, data };
  }
  return { type: 2, value: 0 };
}

export function evalComp(c, ch) {
  switch (c.type) {
    case 2: return c.value;
    case 3: return c.a + (c.b - c.a) * ch[c.ch];
    case 0: case 1: {
      const x = ch[c.ch], t = c.t, n = t.length;
      if (!n) return 0;
      if (x <= t[0]) return c.v[0];
      if (x >= t[n - 1]) return c.v[n - 1];
      let k = 1;
      while (k < n - 1 && t[k] < x) k++;
      const u = (x - t[k - 1]) / Math.max(1e-9, t[k] - t[k - 1]);
      if (c.type === 1) return c.v[k - 1] + (c.v[k] - c.v[k - 1]) * u;
      const p0 = c.v[k - 1], p1 = c.o[k - 1], p2 = c.i[k], p3 = c.v[k], w = 1 - u; // (keys: time, value, in handle, out handle)
      return w * w * w * p0 + 3 * w * w * u * p1 + 3 * w * u * u * p2 + u * u * u * p3;
    }
    case 4: {
      const fx = Math.min(1, Math.max(0, ch[c.ch])) * (c.nx - 1), fy = Math.min(1, Math.max(0, ch[c.ch2])) * (c.ny - 1);
      const x0 = Math.min(c.nx - 2, Math.floor(fx)), y0 = Math.min(c.ny - 2, Math.floor(fy));
      const at = (x, y) => c.data[Math.max(0, y) * c.nx + Math.max(0, x)];
      if (c.nx === 1 && c.ny === 1) return c.data[0];
      const ux = c.nx > 1 ? fx - x0 : 0, uy = c.ny > 1 ? fy - y0 : 0, x1 = c.nx > 1 ? x0 + 1 : x0, y1 = c.ny > 1 ? y0 + 1 : y0;
      const a = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * ux, b = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * ux;
      return a + (b - a) * uy;
    }
  }
  return 0;
}

// A parameter slot: kind 0 sets, adds to or multiplies one particle value (mode 0 =, 1 += per
// second, 2 *=: a factor on what is shown, except on the velocity, where it is a drag per frame
// unless the slot's factor flag is set), other kinds are forces (1: a pull along a direction,
// m/s^2) and effects we leave out (2..6: attractors, planes, vortices, wind).
function readSlot(dv, u8, at, blob) {
  const kind = dv.getUint32(at + 8, true);
  if (kind === 1) {
    return { kind, world: dv.getUint32(at + 16, true) === 1, dir: [dv.getFloat32(at + 32, true), dv.getFloat32(at + 36, true), -dv.getFloat32(at + 40, true)], strength: dv.getFloat32(at + 48, true) };
  }
  if (kind !== 0) return { kind };
  const nc = u8[at + 16], mode = u8[at + 17], factor = !!u8[at + 18], id = dv.getUint16(at + 20, true);
  const comps = [];
  for (let k = 0; k < Math.min(3, nc); k++) comps.push(readComp(dv, u8, at + 32 + k * 16, blob));
  return { kind, id, mode, factor, sign: MIRROR[id] || [1, 1, 1], comps };
}

export function parsePsys(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const version = u8.length >= HEADER ? dv.getUint32(0, true) : 0;
  if (version !== 17 && version !== 18) throw new Error('not a version 17 or 18 particle file');
  const n = dv.getUint32(4, true);
  const f = (o) => dv.getFloat32(o, true), i32 = (o) => dv.getInt32(o, true), u32 = (o) => dv.getUint32(o, true);
  const bounds = [f(16), f(20), f(24), f(28), f(32), f(36)];
  const sys = { duration: f(40), loop: !!(u32(44) & 1), flags: u32(44), bounds: [bounds[0], bounds[1], -bounds[5], bounds[3], bounds[4], -bounds[2]], emitters: [] };
  let spawners = 0, baked = 0, extras = 0, slots = 0;
  const raw = [];
  for (let e = 0; e < n; e++) {
    const o = HEADER + e * EMITTER;
    const r = { o, nSpawn: u32(o + 0x28), nBaked: u32(o + 0x2c), nS: u32(o + 0x30), nL: u32(o + 0x34), extra: i32(o + 0x48), s0: i32(o + 0x50), l0: i32(o + 0x58) };
    spawners += r.nSpawn; baked += r.nBaked; slots += r.nS + r.nL;
    if (r.extra !== -1) extras++;
    raw.push(r);
  }
  const spawnAt = HEADER + n * EMITTER, slotAt = spawnAt + spawners * SPAWNER + baked * BAKED + extras * EXTRA, blob = slotAt + slots * SLOT;
  if (blob > u8.length) throw new Error('particle file too short');
  const name = (off) => (off >= 0 ? cstr(u8, blob + off) : null);
  let si = 0;
  for (const r of raw) {
    const o = r.o;
    const col = u32(o + 0x24);
    const em = {
      quality: u32(o), flags: u32(o + 4),
      // seconds after the effect starts that the emitter begins: the smoke a beat after the flash
      // (a flamethrower projectile's three fireballs 0.07 s apart, each placed 2 m further back:
      // where the projectile was when it set off, at 28.6 m/s)
      delay: Math.max(0, f(o + 8)),
      life: [f(o + 0x10), f(o + 0x14)],
      base: [f(o + 0x1c), f(o + 0x20)], // (width and height when no slot sizes it; a streak's height: seconds of its flight)
      color: [((col >>> 16) & 255) / 255, ((col >>> 8) & 255) / 255, (col & 255) / 255, (col >>> 24) / 255], // (0xAARRGGBB: the railgun's plasma is blue, flashes warm)
      orient: u8[o + 0x60], orientFlags: u8[o + 0x62], blend: u8[o + 0x66],
      // a streak (ORIENT.VELOCITY) is its height in seconds of flight long when +0x63 bit 0 is set
      // (sparks: "height 2 x 1/30" = two frames of travel), else in metres; a billboard with
      // +0x62 bit 7 set turns its height along the flight (spark sprites) without stretching
      stretch: !!(u8[o + 0x63] & 1),
      alongFlight: u8[o + 0x60] === 1 || (u8[o + 0x60] === 0 && !!(u8[o + 0x62] & 0x80)),
      grid: [Math.max(1, u8[o + 0x70]), Math.max(1, u8[o + 0x71])],
      // +0x6f bit 3 with a fourth texture (a colour ramp, explosions/emissive_ramp*): a fireball's
      // look. Its colour slots then carry heat (red: where the normal map's alpha glows, read
      // through the ramp), a glow boost (green) and the soot's own brightness (blue).
      heatRamp: !!(u8[o + 0x6f] & 8),
      glow: f(o + 0xa8),
      mesh: name(i32(o + 0xd4)),
      textures: [0, 1, 2, 3].map((k) => name(i32(o + 0xe0 + k * 4))),
      spawners: [], spawn: [], live: [],
    };
    em.roles = textureRoles(em.textures);
    for (let k = 0; k < r.nSpawn; k++, si++) {
      const s = spawnAt + si * SPAWNER;
      const curveType = u8[s + 0x70];
      const sp = {
        shape: u8[s], mode: u8[s + 2], count: u32(s + 4), rate: f(s + 8),
        repeat: f(s + 0x10), interval: f(s + 0x14),
        speed: f(s + 0x18), speedRand: f(s + 0x1c),
        pos: [f(s + 0x20), f(s + 0x24), -f(s + 0x28)],
        rot: [-f(s + 0x30), -f(s + 0x34), f(s + 0x38), f(s + 0x3c)], // (x, y, z, w)
        shapeArgs: [0, 1, 2, 3, 4, 5, 6, 7].map((k2) => f(s + 0x50 + k2 * 4)),
        rateCurve: curveType <= 1 && u32(s + 0x74) ? readComp(dv, u8, s + 0x70, blob) : null,
      };
      if (sp.rateCurve) sp.rateCurve.ch = 0;
      em.spawners.push(sp);
    }
    for (let k = 0; k < r.nS; k++) em.spawn.push(readSlot(dv, u8, slotAt + (r.s0 + k) * SLOT, blob));
    for (let k = 0; k < r.nL; k++) em.live.push(readSlot(dv, u8, slotAt + (r.l0 + k) * SLOT, blob));
    sys.emitters.push(em);
  }
  return sys;
}

// ---- simulation ------------------------------------------------------------------------------
// A small deterministic random source (mulberry32), so a seed gives the same effect.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIM = {
  FPS: 30, // damping factors ("*=" without b2) are per frame of this rate
  STEP: 1 / 60, // simulation step (s)
  MAX: 400, // particles per emitter at most
};

function qrot(q, v, out) { // rotate v by quaternion q (x, y, z, w)
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[0] = vx + w * tx + (y * tz - z * ty);
  out[1] = vy + w * ty + (z * tx - x * tz);
  out[2] = vz + w * tz + (x * ty - y * tx);
  return out;
}

function inSphere(r, out) {
  for (;;) {
    const x = r() * 2 - 1, y = r() * 2 - 1, z = r() * 2 - 1;
    if (x * x + y * y + z * z <= 1) { out[0] = x; out[1] = y; out[2] = z; return out; }
  }
}

// Origin: a 4x4 column-major matrix (three.js Matrix4.elements) the effect hangs on; null = identity.
function xform(m, p, out) {
  if (!m) { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; }
  const [x, y, z] = p;
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}
function xdir(m, d, out) {
  if (!m) { out[0] = d[0]; out[1] = d[1]; out[2] = d[2]; return out; }
  const [x, y, z] = d;
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0], ZERO = [0, 0, 0];

// One playing effect. origin(): the matrix it hangs on now, read as each particle is born; most
// particles then fly on in the world (spawner mode 2: a shell's steam trail stays in the air), but
// a spawner of mode 3 makes particles that ride along with whatever carries the effect (a bullet's
// glowing dot and its tracer streak). step(dt) moves it on; done once it stopped emitting and every
// particle died.
export class FxRun {
  // inherit: the carrier's velocity (a projectile's), given to the particles of emitters whose spawn
  // slots scale their velocity ("vel *= 1": the flamethrower projectile's fireballs fly along with it,
  // its steam trail does not)
  // loop: plays on past its duration as if it looped (a beam held while the gun fires)
  // scale: the particles' sizes too (a map's effect at its env_scale; origin's matrix scales where
  // they go and how fast)
  constructor(sys, { seed = 1, origin = null, inherit = null, loop = null, scale = 1 } = {}) {
    this.sys = sys;
    this.loop = loop ?? sys.loop;
    this.scale = scale;
    this.r = rng(seed);
    this.origin = origin;
    this.inherit = inherit;
    this.t = 0;
    this.stopped = false;
    this.spawned = 0; // (particles born so far)
    this.em = sys.emitters.map((e) => {
      const ids = new Set([...e.spawn, ...e.live].filter((sl) => sl.kind === 0).map((sl) => sl.id));
      const sized = ids.has(P.SIZE);
      return {
        e, parts: [], acc: e.spawners.map(() => 0), bursts: e.spawners.map(() => 0), primed: e.spawners.map(() => false), seq: 0,
        posSet: e.live.some((sl) => sl.kind === 0 && sl.id === P.POS && sl.mode === 0),
        takes: e.spawn.find((sl) => sl.kind === 0 && sl.id === P.VEL && sl.mode === 2) || null, // (see inherit)
        // width and height before the slots: the emitter's own unless a slot sets them (on a
        // sprite, a size slot does; a streak keeps its own as factors of its size: the rare machine
        // gun's flash is "size 0.5..0.85", height 1/3 of that a metre a second, about 1 m long)
        w0: ids.has(P.SIZEX) || (sized && e.orient !== ORIENT.VELOCITY) ? 1 : e.base[0],
        h0: ids.has(P.SIZEY) || (sized && e.orient !== ORIENT.VELOCITY) ? 1 : e.base[1],
      };
    });
  }

  get done() { return (this.stopped || (!this.loop && this.t >= this.sys.duration)) && this.em.every((s) => !s.parts.length); }

  stop() { this.stopped = true; }

  // its carrier is gone (a bullet hit something): no more particles, and the ones riding it go too
  end() {
    this.stopped = true;
    for (const s of this.em) s.parts = s.parts.filter((p) => !p.local && !p.rides);
  }

  // (in steps of at most SIM.STEP; the first call also lets the start's bursts out)
  step(dt) {
    let left = Math.min(dt, 0.25);
    if (!this.started) { this.started = true; this.tick(0); }
    while (left > 1e-9) {
      const h = Math.min(SIM.STEP, left);
      this.tick(h);
      left -= h;
    }
  }

  // Older particles move on first, then new ones are born: a flash that lives 1/50 s shows at
  // full strength on its first frame.
  tick(dt) {
    this.t += dt;
    const D = Math.max(1e-3, this.sys.duration), emitting = !this.stopped && (this.loop || this.t < D);
    const tn = this.loop ? (this.t % D) / D : Math.min(1, this.t / D);
    let now; // (where the carrier is this step, for the particles riding it)
    for (const s of this.em) {
      const e = s.e, te = this.t - e.delay; // (the emitter's own clock)
      for (let i = s.parts.length - 1; i >= 0; i--) {
        const p = s.parts[i];
        p.age += dt;
        if (p.age >= p.life) { s.parts[i] = s.parts[s.parts.length - 1]; s.parts.pop(); continue; }
        if (p.local) this.ride(s, p, dt, tn, (now ||= this.origin ? Float64Array.from(this.origin()) : null));
        else this.live(s, p, dt, tn);
      }
      if (emitting && te >= -1e-9) {
        e.spawners.forEach((sp, k) => {
          // bursts: one at the start, or sp.repeat of them sp.interval apart
          const reps = sp.interval > 0 ? Math.max(1, Math.round(sp.repeat)) : 1;
          while (s.bursts[k] < reps && te + 1e-9 >= s.bursts[k] * sp.interval) {
            for (let i = 0; i < sp.count; i++) this.born(s, sp, tn);
            s.bursts[k]++;
          }
          const rate = sp.rateCurve ? evalComp(sp.rateCurve, [tn, tn, 0, 0, 0, 0, 0, 0]) : sp.rate;
          if (rate > 0) {
            // the first one at once (a bullet's tracer and glow are "1 a second" for its whole flight)
            if (!s.primed[k]) { s.primed[k] = true; s.acc[k] = Math.max(s.acc[k], 1); }
            s.acc[k] += rate * dt;
            while (s.acc[k] >= 1) { s.acc[k] -= 1; this.born(s, sp, tn); }
          }
        });
      }
    }
  }

  born(s, sp, tn) {
    const e = s.e;
    if (s.parts.length >= SIM.MAX) return;
    const r = this.r, ch = new Float32Array(8);
    ch[0] = tn; ch[1] = tn;
    for (let k = 2; k < 8; k++) ch[k] = r();
    const p = {
      ch, age: 0, life: 1, lifeK: 1, seq: s.seq++, // (a trail joins its particles in this order)
      pos: [0, 0, 0], vel: [0, 0, 0], home: null, origin: null,
      size: 1, sizeX: s.w0, sizeY: s.h0, alpha: e.color[3], rgb: [e.color[0], e.color[1], e.color[2]],
      angle: 0, frame: 0, rot3: [0, 0, 0], p8: 0,
      out: { size: 1, sizeX: 1, sizeY: 1, alpha: 1, rgb: [1, 1, 1], speedK: 1 },
    };
    // where: the spawner's place and shape, turned by its rotation; which way: its +Y
    const a = sp.shapeArgs;
    _a[0] = 0; _a[1] = 0; _a[2] = 0;
    _b[0] = 0; _b[1] = 1; _b[2] = 0;
    if (sp.shape === 1) { // a cone of half-angle a[2] (radians) round +Y; a[0], a[1] unknown
      const th = Math.acos(1 - r() * (1 - Math.cos(Math.min(Math.PI, Math.max(0, a[2]))))), ph = r() * 2 * Math.PI;
      _b[0] = Math.sin(th) * Math.cos(ph); _b[1] = Math.cos(th); _b[2] = Math.sin(th) * Math.sin(ph);
    } else if (sp.shape === 6 || sp.shape === 8 || sp.shape === 9) { // a ring (arc a[0], radius a[4]) round +Y
      const ang = (r() - 0.5) * (a[0] || Math.PI * 2), rad = a[4] || a[5] || 0;
      _a[0] = Math.cos(ang) * rad; _a[2] = Math.sin(ang) * rad;
    } else if (sp.shape === 5) { // a box
      _a[0] = (r() * 2 - 1) * a[1]; _a[1] = (r() * 2 - 1) * a[2]; _a[2] = (r() * 2 - 1) * a[3];
    } else if (sp.shape === 0 && a[1] > 0) { // a ball of radius a[1] (a map's ground fire, fog: they fill their bounds so)
      inSphere(r, _a);
      _a[0] *= a[1]; _a[1] *= a[1]; _a[2] *= a[1];
    }
    const len = Math.hypot(_b[0], _b[1], _b[2]) || 1;
    _b[0] /= len; _b[1] /= len; _b[2] /= len;
    qrot(sp.rot, _a, _c);
    const lp = [sp.pos[0] + _c[0], sp.pos[1] + _c[1], sp.pos[2] + _c[2]];
    qrot(sp.rot, _b, _c);
    const speed = sp.speed + r() * sp.speedRand;
    const lv = [_c[0] * speed, _c[1] * speed, _c[2] * speed], way = [_c[0], _c[1], _c[2]];
    for (const sl of e.spawn) this.first(p, sl, lp, lv);
    p.life = e.life[0] + (e.life[1] - e.life[0]) * Math.min(1, Math.max(0, p.lifeK));
    if (!(p.life > 0)) p.life = Math.max(e.life[0], e.life[1]);
    if (!(p.life > 0)) return;
    // into the world
    const m = this.origin ? this.origin() : null;
    p.origin = m ? Float64Array.from(m) : null;
    xform(p.origin, lp, p.pos);
    xdir(p.origin, lv, p.vel);
    p.dir = xdir(p.origin, way, [0, 0, 0]); // (which way it flies: a streak standing still keeps it)
    const dl = Math.hypot(p.dir[0], p.dir[1], p.dir[2]) || 1;
    for (let k = 0; k < 3; k++) p.dir[k] /= dl;
    p.home = xform(p.origin, [0, 0, 0], [0, 0, 0]);
    // Riding the carrier: it lives in the effect's own frame. On a flying round (inherit) a streak
    // rides it even from a world spawner: the minigun's tracer (1 m ahead of its round, a 5..8 m
    // streak behind, hidden for its first 1/100 s while that would still reach back into the gun)
    // and a rocket's flame (held at the rocket by its position slot) would otherwise hang in the air
    // where they were born, pointing back through the gun.
    const rides = (sp.mode === 3 || (this.inherit && e.orient === ORIENT.VELOCITY && !s.takes)) && !!this.origin;
    // first seen half a frame old: a flash that lives one frame (1/50 s) shows as it is halfway,
    // not at its first instant (the rare machine gun's flash is 0 wide then and grows over its life);
    // a round's own particles start at 0 (that minigun tracer's first 1/100 s)
    if (!rides || !this.inherit) p.age = Math.min(p.life * 0.5, SIM.STEP * 0.5);
    if (rides) {
      p.local = true;
      p.lpos = lp; p.lvel = lv;
      this.ride(s, p, 0, tn, p.origin);
    } else {
      if (this.inherit && s.takes) {
        const k = s.takes.comps[0] ? evalComp(s.takes.comps[0], p.ch) : 1;
        for (let j = 0; j < 3; j++) p.vel[j] += this.inherit[j] * k;
        p.rides = true;
      }
      this.live(s, p, 0, tn);
    }
    s.parts.push(p);
    this.spawned++;
  }

  // A riding particle: its slots and motion in the effect's own frame, then placed in the world by
  // where the carrier is now (m); its velocity there turned only, so a tracer is as long as its own
  // speed makes it, not the bullet's. On a flying round it moves the way the round does plus its own
  // drift (p.flow, which way a streak lies: back from its head along the flight). The game's tracers
  // are made so: a cannon shell's streak is held 1.2 m ahead of the shell and 6.7 m long, the newer
  // bullet's 3..5 m ahead and 12.9 m long; both drift backwards at 1 m/s, and drawn along that drift
  // they would lie wholly ahead of their rounds.
  ride(s, p, dt, tn, m) {
    const pos = p.pos, vel = p.vel, origin = p.origin, home = p.home;
    p.pos = p.lpos; p.vel = p.lvel; p.origin = null; p.home = ZERO;
    this.live(s, p, dt, tn);
    p.lpos = p.pos; p.lvel = p.vel;
    p.pos = xform(m, p.lpos, pos); p.vel = xdir(m, p.lvel, vel); p.origin = origin; p.home = home;
    if (this.inherit && m) {
      const k = Math.hypot(this.inherit[0], this.inherit[1], this.inherit[2]); // (the round's speed; m's +Z its way now)
      const f = (p.flow ||= [0, 0, 1]);
      for (let j = 0; j < 3; j++) f[j] = m[8 + j] * k + p.vel[j];
      const fl = Math.hypot(f[0], f[1], f[2]) || 1;
      for (let j = 0; j < 3; j++) f[j] /= fl;
    }
    const l = Math.hypot(p.vel[0], p.vel[1], p.vel[2]);
    if (l > 1e-6) for (let k = 0; k < 3; k++) p.dir[k] = p.vel[k] / l;
  }

  // a spawn slot: sets, adds to or multiplies the new particle's value (positions and velocities in
  // the effect's frame)
  first(p, sl, lp, lv) {
    if (sl.kind !== 0) return;
    const c = sl.comps, mode = sl.mode;
    const val = (k) => (c[k] ? evalComp(c[k], p.ch) * (mode === 2 ? 1 : sl.sign[k]) : mode === 2 ? 1 : 0); // (a factor is not mirrored)
    const op = (cur, v) => (mode === 0 ? v : mode === 1 ? cur + v : cur * v);
    switch (sl.id) {
      case P.POS: for (let k = 0; k < 3; k++) if (c[k]) lp[k] = op(lp[k], val(k)); return;
      case P.VEL: for (let k = 0; k < 3; k++) if (c[k]) lv[k] = op(lv[k], val(k)); return;
      case P.ROT3: for (let k = 0; k < 3; k++) if (c[k]) p.rot3[k] = op(p.rot3[k], val(k)); return;
      case P.RGB: for (let k = 0; k < 3; k++) if (c[k]) p.rgb[k] = op(p.rgb[k], val(k)); return;
      case P.ALPHA: p.alpha = op(p.alpha, val(0)); return;
      case P.SIZE: p.size = op(p.size, val(0)); return;
      case P.SIZEX: p.sizeX = op(p.sizeX, val(0)); return;
      case P.SIZEY: p.sizeY = op(p.sizeY, val(0)); return;
      case P.ANGLE: p.angle = op(p.angle, val(0)); return;
      case P.FRAME: p.frame = op(p.frame, val(0)); return;
      case P.LIFE: p.lifeK = op(p.lifeK, val(0)); return;
      case P.P8: p.p8 = op(p.p8, val(0)); return;
    }
  }

  // the life slots, in order: "=" sets a value, "+=" adds so much a second, "*=" scales what is
  // shown (on the velocity: a drag, so much a frame, unless the slot is flagged a plain factor)
  live(s, p, dt, tn) {
    const e = s.e, ch = p.ch, o = p.out;
    ch[0] = tn;
    ch[1] = Math.min(1, p.age / p.life);
    let fs = 1, fx = 1, fy = 1, fa = 1, fr = 1, fg = 1, fb = 1, fv = 1;
    for (const sl of e.live) {
      if (sl.kind === 1) { // a pull (gravity: 9.8 down)
        if (!dt) continue;
        xdir(sl.world ? null : p.origin, sl.dir, _a);
        for (let k = 0; k < 3; k++) p.vel[k] += _a[k] * sl.strength * dt;
        continue;
      }
      if (sl.kind !== 0) continue;
      const c = sl.comps, mode = sl.mode;
      const val = (k) => (c[k] ? evalComp(c[k], ch) * (mode === 2 ? 1 : sl.sign[k]) : NaN); // (a factor is not mirrored)
      if (mode === 2 && (sl.id !== P.VEL || sl.factor)) { // a factor on what is shown
        const v0 = c[0] ? val(0) : 1;
        switch (sl.id) {
          case P.SIZE: fs *= v0; break;
          case P.SIZEX: fx *= v0; break;
          case P.SIZEY: fy *= v0; break;
          case P.ALPHA: fa *= v0; break;
          case P.RGB: fr *= v0; fg *= c[1] ? val(1) : 1; fb *= c[2] ? val(2) : 1; break;
          case P.VEL: fv *= v0; break;
        }
        continue;
      }
      const set = (cur, v) => (Number.isNaN(v) ? cur : mode === 0 ? v : cur + v * dt);
      switch (sl.id) {
        case P.SIZE: p.size = set(p.size, val(0)); break;
        case P.SIZEX: p.sizeX = set(p.sizeX, val(0)); break;
        case P.SIZEY: p.sizeY = set(p.sizeY, val(0)); break;
        case P.ALPHA: p.alpha = set(p.alpha, val(0)); break;
        case P.RGB: for (let k = 0; k < 3; k++) p.rgb[k] = set(p.rgb[k], val(k)); break;
        case P.ANGLE: p.angle = set(p.angle, val(0)); break;
        case P.FRAME: p.frame = set(p.frame, val(0)); break;
        case P.ROT3: for (let k = 0; k < 3; k++) p.rot3[k] = set(p.rot3[k], val(k)); break;
        case P.VEL: {
          if (mode === 2) { for (let k = 0; k < 3; k++) if (c[k]) p.vel[k] *= Math.pow(Math.max(0, val(k)), dt * SIM.FPS); break; }
          _b[0] = c[0] ? val(0) : 0; _b[1] = c[1] ? val(1) : 0; _b[2] = c[2] ? val(2) : 0;
          xdir(p.origin, _b, _a);
          if (mode === 0) for (let k = 0; k < 3; k++) p.vel[k] = _a[k];
          else for (let k = 0; k < 3; k++) p.vel[k] += _a[k] * dt;
          break;
        }
        case P.POS: {
          _b[0] = c[0] ? val(0) : 0; _b[1] = c[1] ? val(1) : 0; _b[2] = c[2] ? val(2) : 0;
          xdir(p.origin, _b, _a);
          if (mode === 0) for (let k = 0; k < 3; k++) p.pos[k] = p.home[k] + _a[k];
          else if (mode === 1) for (let k = 0; k < 3; k++) p.pos[k] += _a[k] * dt;
          break;
        }
      }
    }
    o.size = p.size * fs * this.scale; o.sizeX = p.sizeX * fx; o.sizeY = p.sizeY * fy;
    o.alpha = p.alpha * fa;
    o.rgb[0] = p.rgb[0] * fr; o.rgb[1] = p.rgb[1] * fg; o.rgb[2] = p.rgb[2] * fb;
    o.speedK = fv;
    if (dt && !s.posSet) for (let k = 0; k < 3; k++) p.pos[k] += p.vel[k] * fv * dt;
  }

  // every live particle (for bounds and the renderer)
  *particles() {
    for (const s of this.em) for (const p of s.parts) yield { e: s.e, p };
  }
}
