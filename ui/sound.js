// The game's sounds, played where they happen (Web Audio). The samples are the game's own: its FMOD
// banks' (the host lists them at /sounds and hands one out as Ogg Vorbis at /sound), each decoded once
// and kept. soundmap.js names families of them; each time one plays, a variant is picked at random
// (never the one played just before). The listener rides the camera and every sound sits where it
// happens, fading with distance. Audio starts with the user's first click (the browser's rule), and
// everything stops while the window is hidden.
const DATA = 'https://xo.data';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The samples of a family: name1, name2 ... (with or without _p), or the name alone.
export function variantsOf(family, names) {
  const re = new RegExp(`^${esc(family)}\\d*(_p)?$`);
  return names.filter((n) => re.test(n));
}

const MAX_VOICES = 40;
const now = () => performance.now() / 1000;

export class Sounds {
  constructor() {
    this.list = null; // Promise<Map name -> { seconds, channels, loop: [start s, end s] | null }>
    this.buffers = new Map(); // name -> Promise<AudioBuffer | null>
    this.families = new Map(); // family -> Promise<names>
    this.last = new Map(); // family -> the name it played last
    this.lastAt = new Map(); // family -> when it last played (s): a beam's hits sound at most so often
    this.voices = [];
    this.guns = new Map(); // a firing gun (gun()) -> { sound, pos, until, loop, last }
    this.periods = new Map(); // a gun -> seconds between its shots, as last seen
    this.ctx = null;
    this.master = null;
    this.volume = 0.7;
    this.gen = 0; // (silence() moves it on: what was asked for before then does not start after)
    this.asked = 0; // (tests: how many sounds were asked for, and how many started)
    this.played = 0;
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.silence(); });
  }

  names() {
    return (this.list ||= fetch(`${DATA}/sounds`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => {
        const m = new Map();
        for (const line of t.split('\n')) {
          const f = line.split('\t');
          if (f.length < 3) continue;
          m.set(f[0], { seconds: +f[1], channels: +f[2], loop: f.length >= 5 ? [+f[3], +f[4]] : null });
        }
        return m;
      })
      .catch(() => new Map()));
  }

  context() {
    if (!this.ctx) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master) this.master.gain.value = this.volume;
    if (this.volume <= 0) this.silence();
  }

  buffer(name) {
    if (!this.buffers.has(name)) {
      const ctx = this.context();
      this.buffers.set(name, !ctx ? Promise.resolve(null) : fetch(`${DATA}/sound?name=${encodeURIComponent(name)}`)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? ctx.decodeAudioData(b) : null))
        .catch(() => null));
    }
    return this.buffers.get(name);
  }

  // a family's samples (an array of families: all of theirs)
  variants(family) {
    const key = Array.isArray(family) ? family.join('|') : family;
    if (!this.families.has(key)) {
      this.families.set(key, this.names().then((m) => {
        const all = [...m.keys()];
        return (Array.isArray(family) ? family : [family]).flatMap((f) => variantsOf(f, all));
      }));
    }
    return this.families.get(key);
  }

  async pick(family) {
    const v = await this.variants(family);
    if (!v.length) return null;
    const key = Array.isArray(family) ? family.join('|') : family, was = this.last.get(key);
    let name = v[Math.floor(Math.random() * v.length)];
    if (name === was && v.length > 1) name = v[(v.indexOf(name) + 1 + Math.floor(Math.random() * (v.length - 1))) % v.length];
    this.last.set(key, name);
    return name;
  }

  // reads a few of each family's samples ahead (a gun's, as it is picked to fire)
  preload(...families) {
    if (this.volume <= 0) return;
    for (const f of families.flat(2)) if (f) this.variants(f).then((v) => v.slice(0, 6).forEach((n) => this.buffer(n)));
  }

  // Plays a family where it happens: pos [x, y, z] (null: at the listener). loop: held (over its loop
  // points when it has them) until stopped; every: at most once that often (seconds); ref: how near
  // it is at full loudness (metres) and rolloff how fast it fades past that; fade: seconds it takes to
  // come up; offset: where it starts ('random': anywhere in its loop, so two of one family do not
  // play in step); delay: seconds before it is heard (far off: sound takes its time). Resolves to the
  // voice ({ stop(fade) }) or null. Before the user's first click the browser holds audio back: what
  // is asked for then is skipped, not saved up to burst out later.
  async play(family, pos = null, { gain = 1, loop = false, every = 0, ref = 4, rolloff = 0.8, fade = 0, offset = 0, delay = 0 } = {}) {
    if (!family || this.volume <= 0) return null;
    const key = Array.isArray(family) ? family.join('|') : family;
    if (every) {
      const t = this.lastAt.get(key);
      if (t !== undefined && now() - t < every) return null;
      this.lastAt.set(key, now());
    }
    const ctx = this.context();
    if (!ctx) return null;
    this.asked++;
    const gen = this.gen;
    const name = await this.pick(family);
    if (!name) return null;
    const [buf, info] = await Promise.all([this.buffer(name), this.names().then((m) => m.get(name))]);
    if (!buf || this.volume <= 0 || ctx.state !== 'running' || gen !== this.gen) return null;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (loop) {
      src.loop = true;
      if (info?.loop && info.loop[1] > info.loop[0]) { src.loopStart = info.loop[0]; src.loopEnd = Math.min(info.loop[1], buf.duration); }
    }
    const g = ctx.createGain();
    if (fade > 0) {
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(gain, ctx.currentTime + fade);
    } else g.gain.value = gain;
    src.connect(g);
    let panner = null;
    if (pos) {
      panner = ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = ref;
      panner.rolloffFactor = rolloff;
      panner.maxDistance = 3000;
      this.place(panner, pos);
      g.connect(panner);
      panner.connect(this.master);
    } else g.connect(this.master);
    const v = { name, loop, src, gain: g, panner, ended: false };
    v.stop = (fade = 0.06) => {
      if (v.ended) return;
      v.ended = true;
      const i = this.voices.indexOf(v);
      if (i >= 0) this.voices.splice(i, 1);
      const t = ctx.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + fade);
        src.stop(t + fade + 0.01);
      } catch { /* already stopped */ }
    };
    src.onended = () => { v.ended = true; const i = this.voices.indexOf(v); if (i >= 0) this.voices.splice(i, 1); };
    let at = typeof offset === 'number' ? offset : 0;
    if (offset === 'random') at = src.loop && src.loopEnd > src.loopStart ? src.loopStart + Math.random() * (src.loopEnd - src.loopStart) : Math.random() * buf.duration;
    src.start(delay > 0 ? ctx.currentTime + delay : 0, Math.min(at, Math.max(0, buf.duration - 0.01)));
    this.played++;
    this.voices.push(v);
    if (this.voices.length > MAX_VOICES) this.voices.find((x) => !x.loop && !x.ended && x !== v)?.stop(0.03); // (the oldest one-shot gives way)
    return v;
  }

  place(panner, pos) {
    if (panner.positionX) { panner.positionX.value = pos[0]; panner.positionY.value = pos[1]; panner.positionZ.value = pos[2]; } else panner.setPosition(pos[0], pos[1], pos[2]);
  }

  // moves a playing sound (a hovering drone's engine)
  move(v, pos) {
    if (v?.panner && !v.ended) this.place(v.panner, pos);
  }

  // A gun fires (Viewer.onShot): its shot; at the first shot of a burst its start and its held loop;
  // once no shot has come for a while (as long as two of its gaps between shots, a held beam's whole
  // clip), its end and its tail (tick). key: the gun (its fire point).
  gun(key, sound, pos) {
    if (!sound || this.volume <= 0) return;
    const t = now();
    let g = this.guns.get(key);
    if (g && g.last) this.periods.set(key, Math.min(4, t - g.last));
    if (!g) {
      g = { sound, pos, until: 0, loop: null, asking: false, last: 0 };
      this.guns.set(key, g);
      if (sound.start) this.play(sound.start, pos);
    }
    if (sound.loop && !g.loop && !g.asking) { // (asked again next shot if the audio was still held back)
      g.asking = true;
      this.play(sound.loop, pos, { loop: true, gain: sound.loopGain ?? 0.9 }).then((v) => { g.asking = false; if (this.guns.get(key) === g) g.loop = v; else v?.stop(); });
    }
    if (g.loop) this.move(g.loop, pos);
    g.pos = pos;
    g.last = t;
    g.until = t + Math.max(0.3, 2 * (this.periods.get(key) || 0.6));
    if (sound.shot) this.play(sound.shot, pos, { gain: sound.gain || 1 });
  }

  // a gun stopped (all of them: key null): its loop fades, its end and tail play
  gunStop(key = null) {
    for (const [k, g] of [...this.guns]) {
      if (key !== null && k !== key) continue;
      this.guns.delete(k);
      g.loop?.stop(0.12);
      if (g.sound.end) this.play(g.sound.end, g.pos);
      if (g.sound.tail) this.play(g.sound.tail, g.pos, { gain: 0.7 });
      if (g.sound.shells) this.play(g.sound.shells, [g.pos[0], g.pos[1] - 0.8, g.pos[2]], { gain: 0.55, delay: 0.25 }); // (the spent cases land)
    }
  }

  // every frame: the listener where the camera is, guns that went quiet stopped
  listen(camera) {
    if (this.guns.size) {
      const t = now();
      for (const [k, g] of [...this.guns]) if (t > g.until) this.gunStop(k);
    }
    if (!this.ctx) return;
    const l = this.ctx.listener, e = camera.matrixWorld.elements;
    if (l.positionX) {
      l.positionX.value = e[12]; l.positionY.value = e[13]; l.positionZ.value = e[14];
      l.forwardX.value = -e[8]; l.forwardY.value = -e[9]; l.forwardZ.value = -e[10];
      l.upX.value = e[4]; l.upY.value = e[5]; l.upZ.value = e[6];
    } else {
      l.setPosition(e[12], e[13], e[14]);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
  }

  // everything stops (the window hidden, the view left, the volume at 0)
  silence() {
    this.gen++;
    this.guns.clear();
    for (const v of [...this.voices]) v.stop(0.03);
  }
}
