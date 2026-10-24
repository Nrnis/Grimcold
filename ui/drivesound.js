// A driven vehicle's sounds (drive.js), from the game's banks (sound.js):
//  - its engine: a set of loops from idle to top, crossfaded and pitched by the revs as it goes
//    through four gears (harder under load). Which engine the game gives a cabin sits in its
//    encrypted item data: a set named like the cabin when there is one (buggy, tribal, ravager,
//    wyvern ...), else one for its weight (light: viper, medium: dc_hemi70, heavy: mb)
//  - its wheels or tracks rolling on what is under them (ground, sand, snow, mud, concrete), slow
//    and fast loops crossfaded by speed, and their skid when the tyres are pushed past their grip
//    or it brakes hard; a hover's turbines
//  - the suspension as it lands, the brakes at speed, and its horn (H)
const LEVELS = { idle: 0, onidle: 0.04, lowest: 0.15, low: 0.3, mid: 0.55, high: 0.8, top: 1 };
const BY_WEIGHT = { light: 'viper', medium: 'dc_hemi70', heavy: 'mb' };
const ROLL = {
  ground: ['wheels_ground_roll_slow', 'wheels_ground_roll_fast'], sand: ['wheels_sand_roll', 'wheels_sand_roll'],
  snow: ['wheels_snow_roll_slow', 'wheels_snow_roll_fast'], mud: ['wheels_mud_roll', 'wheels_mud_roll'],
  concrete: ['wheels_cocnrete_roll_slow', 'wheels_cocnrete_roll_slow'], // (the game's own spelling)
  water: ['wheels_water_roll', 'wheels_water_roll'], // (wading: wheels and tracks alike)
};
const SKID = { ground: 'wheels_skid_ground', sand: 'wheeld_sand_skid', snow: 'wheels_snow_slip', mud: 'wheels_skid_ground', concrete: 'wheels_concrete_slip' };
const TRACKS = { light: ['treads_light_slow', 'treads_light_fast'], heavy: ['treads_heavy_slow', 'treads_heavy_fast'] };
const HORN = { light: ['buggy_horn_loop', 'buggy_horn_end'], medium: ['pickup_horn_loop', 'pickup_horn_end'], heavy: ['kamaz_horn_loop', 'kamaz_horn_end'] };
const GAIN = { engine: 0.55, roll: 0.45, skid: 0.5, hover: 0.5 };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

export class DriveSound {
  // sounds: sound.js Sounds; car: { cabinPath, cabinType ('Light cabin' ...), mass, mover ('wheel',
  // 'track', 'hover', 'leg') }
  constructor(sounds, car) {
    this.s = sounds;
    this.car = car;
    this.weight = /heavy/i.test(car.cabinType || '') || car.mass > 9000 ? 'heavy' : /light/i.test(car.cabinType || '') || car.mass < 3000 ? 'light' : 'medium';
    this.engine = []; // { r, v }
    this.roll = null; // { key, slow, fast }
    this.skid = null; // { key, v }
    this.hover = null;
    this.horn = null;
    this.rpm = 0;
    this.on = false;
    this.asking = false;
    this.gen = 0;
  }

  has(family) { return this.s.variants(family).then((v) => v.length > 0, () => false); }

  // the engine set: one named like the cabin (a word of its folder), else the weight's
  async pickEngine() {
    const words = (this.car.cabinPath || '').split('/').slice(-2, -1).join('').toLowerCase().split(/[_\d]+/).filter((w) => w.length > 2);
    for (const w of words) if ((await this.has(`${w}_idle`)) && (await this.has(`${w}_mid`))) return w;
    return BY_WEIGHT[this.weight];
  }

  async start(pos) {
    this.on = true;
    if (this.asking || this.engine.length || performance.now() - (this.tried || 0) < 1000) return; // (asked again at most once a second)
    this.asking = true;
    this.tried = performance.now();
    const gen = this.gen;
    try {
      const set = (this.engineSet ||= await this.pickEngine());
      const have = [];
      for (const [l, r] of Object.entries(LEVELS)) if (await this.has(`${set}_${l}`)) have.push({ l, r });
      if (have.some((x) => x.l === 'idle')) { const i = have.findIndex((x) => x.l === 'onidle'); if (i >= 0) have.splice(i, 1); }
      const voices = await Promise.all(have.map((x) => this.s.play(`${set}_${x.l}`, pos, { loop: true, gain: 0, ref: 9, rolloff: 0.7, offset: 'random' })));
      if (gen !== this.gen || !this.on) { voices.forEach((v) => v?.stop()); return; }
      this.engine = have.map((x, k) => ({ ...x, v: voices[k] })).filter((x) => x.v);
      if (this.car.mover === 'hover') {
        const [a, b] = await Promise.all([this.s.play('hover_main', pos, { loop: true, gain: 0, ref: 8 }), this.s.play('hover_turbine_add', pos, { loop: true, gain: 0, ref: 8 })]);
        if (gen === this.gen && this.on) this.hover = { a, b }; else { a?.stop(); b?.stop(); }
      }
    } finally { this.asking = false; }
  }

  stop() {
    this.on = false;
    this.gen++;
    for (const x of this.engine) x.v?.stop(0.4);
    this.engine = [];
    for (const v of [this.roll?.slow, this.roll?.fast, this.skid?.v, this.hover?.a, this.hover?.b]) v?.stop(0.3);
    this.roll = this.skid = this.hover = null;
    this.hornOff();
  }

  // set a playing loop's loudness and pitch, smoothly
  set(v, gain, rate = 1) {
    if (!v || v.ended) return;
    const t = v.src.context.currentTime;
    v.gain.gain.setTargetAtTime(gain, t, 0.06);
    v.src.playbackRate.setTargetAtTime(rate, t, 0.06);
  }

  // a loop family for a key (a surface): started when the key changes, the old one let go
  async loop(slot, key, family, pos) {
    const cur = this[slot];
    if (cur?.key === key || cur?.asking) return;
    if (cur) for (const v of [cur.slow, cur.fast, cur.v]) v?.stop(0.25);
    const gen = this.gen;
    this[slot] = { key, asking: true };
    const fams = Array.isArray(family) ? family : [family];
    const vs = await Promise.all(fams.map((f) => (f ? this.s.play(f, pos, { loop: true, gain: 0, ref: 7, rolloff: 0.8, offset: 'random' }) : null)));
    if (gen !== this.gen || this[slot]?.key !== key) { vs.forEach((v) => v?.stop()); return; }
    this[slot] = Array.isArray(family) ? { key, slow: vs[0], fast: vs[1] } : { key, v: vs[0] };
  }

  // st: { pos, v (m/s), top, throttle (-1..1), skid (0..1), surface, grounded, landed (impact m/s or 0), braking }
  update(dt, st) {
    if (!this.on) return;
    if (!this.engine.length && !this.asking) this.start(st.pos); // (audio was held back before: asked again)
    const sp = Math.abs(st.v), f = clamp(sp / Math.max(1, st.top), 0, 1);
    // revs: four gears over the top speed, each from about a third of the revs to the top; on the
    // spot, a blip of throttle revs it; off the throttle they fall back
    const gear = Math.min(3, Math.floor(f * 4)), inGear = f * 4 - gear;
    let want = sp < 0.6 ? 0 : 0.28 + 0.72 * inGear * (gear === 3 ? 0.9 : 1) + (gear === 3 ? 0.1 * inGear : 0);
    if (st.throttle && sp < 1) want = 0.35;
    if (!st.grounded && st.throttle) want = Math.min(1, want + 0.25); // (wheels spinning in the air)
    this.rpm += (want - this.rpm) * (1 - Math.exp(-(want > this.rpm ? 5 : 3) * dt));
    const load = st.throttle ? 1 : 0.55;
    const lv = this.engine;
    for (let k = 0; k < lv.length; k++) {
      const x = lv[k], lo = lv[k - 1]?.r ?? -1, hi = lv[k + 1]?.r ?? 2;
      let w = 0;
      if (this.rpm >= x.r) w = hi > 1.5 ? 1 : clamp(1 - (this.rpm - x.r) / (hi - x.r), 0, 1);
      else w = lo < -0.5 ? 1 : clamp(1 - (x.r - this.rpm) / (x.r - lo), 0, 1);
      this.set(x.v, w * GAIN.engine * load, clamp(1 + (this.rpm - x.r) * 0.7, 0.75, 1.35));
      this.s.move(x.v, st.pos);
    }
    // rolling: tracks by weight, wheels by the surface; hovers hum instead
    const mover = this.car.mover;
    if (mover === 'hover') {
      this.set(this.hover?.a, GAIN.hover * (0.6 + 0.4 * f), 0.9 + 0.3 * f);
      this.set(this.hover?.b, GAIN.hover * 0.6 * f, 0.9 + 0.4 * f);
      for (const v of [this.hover?.a, this.hover?.b]) this.s.move(v, st.pos);
    } else if (mover !== 'leg') {
      const wet = st.surface === 'water';
      const key = wet ? 'water' : mover === 'track' ? `track:${this.weight === 'heavy' ? 'heavy' : 'light'}` : `wheel:${st.surface}`;
      const fam = wet ? ROLL.water : mover === 'track' ? TRACKS[this.weight === 'heavy' ? 'heavy' : 'light'] : ROLL[st.surface] || ROLL.ground;
      this.loop('roll', key, fam, st.pos);
      const r = this.roll, t = clamp((sp - 6) / 12, 0, 1), g = st.grounded ? clamp(sp / 4, 0, 1) * GAIN.roll : 0;
      this.set(r?.slow, g * (1 - t), 0.9 + 0.2 * f);
      this.set(r?.fast, g * t, 0.9 + 0.2 * f);
      for (const v of [r?.slow, r?.fast]) this.s.move(v, st.pos);
      if (mover === 'wheel') {
        this.loop('skid', `skid:${st.surface}`, SKID[st.surface] || SKID.ground, st.pos);
        this.set(this.skid?.v, st.grounded && st.surface !== 'water' ? st.skid * GAIN.skid : 0, 1);
        this.s.move(this.skid?.v, st.pos);
      }
    }
    // landing: the suspension takes it; braking hard at speed: the brakes
    if (st.landed > 3) this.s.play(`${this.weight === 'heavy' ? 'heavy' : 'light'}_suspension_${st.landed > 7 ? 'high' : 'low'}_intense`, st.pos, { gain: clamp(st.landed / 8, 0.4, 1), ref: 8 });
    if (st.braking && sp > 9) this.s.play(this.weight === 'heavy' ? 'maz_brakes' : 'light_truck_brakes', st.pos, { gain: 0.5, ref: 8, every: 2.5 });
    if (this.horn?.v) this.s.move(this.horn.v, st.pos);
  }

  // H held: the horn (its loop, then its end)
  async hornOn(pos) {
    if (this.horn) return;
    const [loop, end] = HORN[this.weight];
    this.horn = { end, asking: true };
    const v = await this.s.play(loop, pos, { loop: true, gain: 0.8, ref: 10 });
    if (!this.horn || this.horn.v !== undefined) { v?.stop(); return; }
    this.horn.v = v;
    this.horn.asking = false;
  }

  hornOff(pos = null) {
    const h = this.horn;
    if (!h) return;
    this.horn = null;
    if (h.v) { h.v.stop(0.08); this.s.play(h.end, pos, { gain: 0.8, ref: 10 }); }
  }
}
