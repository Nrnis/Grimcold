// Record: the view as a video clip with the game's sounds (the browser's MediaRecorder on the canvas and
// on everything sound.js plays), saved through the host like a screenshot. MP4 (H.264 + AAC) where the
// browser can write it, else WebM; at most MAX_S seconds. While it records the view is drawn every
// frame, so the clip runs smoothly even where nothing moves.
const MAX_S = 180;
const TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

export class Recorder {
  constructor(viewer, sounds, { onChange = () => {} } = {}) {
    this.v = viewer;
    this.s = sounds;
    this.onChange = onChange;
    this.rec = null;
    this.t0 = 0;
    viewer.frameHooks.push(() => {
      if (!this.rec) return;
      viewer.dirty = true; // (every frame drawn while it records)
      if (this.seconds() >= MAX_S) this.stop();
    });
  }

  get recording() { return !!this.rec; }
  seconds() { return this.rec ? (performance.now() - this.t0) / 1000 : 0; }

  // starts recording; false when the browser cannot
  start() {
    if (this.rec || typeof MediaRecorder === 'undefined' || !this.v.canvas.captureStream) return false;
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    if (!type) return false;
    const stream = this.v.canvas.captureStream(60);
    const ctx = this.s.context(); // (the sounds: what the master gain plays goes into the clip too)
    if (ctx && this.s.master) {
      this.dest = ctx.createMediaStreamDestination();
      this.s.master.connect(this.dest);
      for (const t of this.dest.stream.getAudioTracks()) stream.addTrack(t);
    }
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12e6, audioBitsPerSecond: 192e3 });
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    this.done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: type.split(';')[0] })); });
    rec.start(1000);
    this.rec = rec;
    this.stream = stream;
    this.type = type;
    this.t0 = performance.now();
    this.onChange();
    return true;
  }

  // stops; resolves to { blob, ext } (null when it was not recording)
  async stop() {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    rec.stop();
    const blob = await this.done;
    for (const t of this.stream.getTracks()) t.stop();
    if (this.dest) { try { this.s.master.disconnect(this.dest); } catch { /* gone */ } this.dest = null; }
    this.onChange();
    return { blob, ext: this.type.startsWith('video/mp4') ? 'mp4' : 'webm' };
  }
}

// a blob as a data: URL (for the host's save)
export const dataUrlOf = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
