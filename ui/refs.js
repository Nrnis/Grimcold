// Reference pictures (Vehicle Builder): screenshots of a vehicle from the game, shown over or under the
// 3D view, to build on top of them the way modellers trace blueprint pictures.
//
// A screenshot was taken from one angle, so a picture belongs to one view of the builder's camera.
// Freshly added it simply stays on the screen; "Pin to this view" ties it to the camera's view of the
// moment. A pinned picture fades out as soon as the camera turns or moves away (it would no longer line
// up) and comes back with its view: a click on it in the list, or P. Its place on the screen (offset,
// zoom) is kept relative to the view's height, like the camera's own vertical field of view, so it
// lines up whatever the window size. "Lens" sets the camera's field of view for that picture, for
// screenshots taken with another one.
//
// "Line it up": the picture takes the mouse (drag moves it, the wheel zooms around the cursor, the
// arrow keys nudge it, + and - zoom); Enter or Esc ends it.
import * as THREE from 'three';

const DEG = Math.PI / 180;
export const DEFAULT_OPACITY = 0.5;

export class References {
  constructor(viewer, { call, layer, onChange = () => {}, onList = () => {}, status = () => {}, data = 'https://xo.data' }) {
    this.v = viewer;
    this.call = call;
    this.layer = layer;
    this.img = layer.querySelector('img');
    this.onChange = onChange; // something worth saving changed (debounce it)
    this.onList = onList; // the list or the active picture changed (re-render the card)
    this.status = status;
    this.data = data;
    this.list = [];
    this.unread = []; // (saved pictures that could not be read: kept for the file)
    this.active = -1;
    this.shown = true;
    this.adjusting = false;
    this.defaultFov = viewer.camera.fov;
    this.fade = 0; // how much of the active picture shows (1 at its view)
    this.applied = '';
    viewer.frameHooks.push(() => this.update());

    layer.addEventListener('pointerdown', (e) => {
      if (!this.adjusting || e.button !== 0) return;
      const r = this.current();
      if (!r) return;
      e.preventDefault();
      try { layer.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      this.drag = { x: e.clientX, y: e.clientY, rx: r.x, ry: r.y };
    });
    layer.addEventListener('pointermove', (e) => {
      const d = this.drag, r = this.current();
      if (!d || !r) return;
      const H = this.layer.clientHeight || 1;
      r.x = d.rx + (e.clientX - d.x) / H;
      r.y = d.ry + (e.clientY - d.y) / H;
      this.changed();
    });
    const end = (e) => { if (this.drag) { this.drag = null; try { layer.releasePointerCapture(e.pointerId); } catch { /* not captured */ } } };
    layer.addEventListener('pointerup', end);
    layer.addEventListener('pointercancel', end);
    layer.addEventListener('wheel', (e) => {
      if (!this.adjusting) return;
      e.preventDefault();
      const rect = layer.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * 0.0012), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    layer.addEventListener('dblclick', () => { if (this.adjusting) this.setAdjust(false); });
  }

  current() { return this.list[this.active] || null; }

  // The camera's view now: position, target, vertical field of view.
  view() {
    const c = this.v.camera;
    return { pos: c.position.toArray().map(round), target: this.v.controls.target.toArray().map(round), fov: Math.round(c.fov * 100) / 100 };
  }

  // Adds a picture (the file dialog, or `file` for the tests). Returns the new picture or null.
  async add(file = null) {
    const r = await this.call('importImage', { title: 'Add a screenshot of your vehicle', ...(file ? { file } : {}) });
    if (!r) return null;
    const ref = { id: r.id, file: r.file, name: r.name, w: r.w, h: r.h, pinned: false, view: this.view(), x: 0, y: 0, scale: 1, opacity: DEFAULT_OPACITY, front: true };
    this.list.push(ref);
    this.activate(this.list.length - 1, { fly: false });
    this.status(`${ref.name} added: turn the view until your build lines up with it (or "Line it up" to move and zoom it), then "Pin to this view"`);
    this.onChange();
    return ref;
  }

  remove(i) {
    const r = this.list[i];
    if (!r) return;
    this.call('releaseImage', { id: r.id }).catch(() => {});
    this.list.splice(i, 1);
    if (this.active === i) { this.setAdjust(false); this.active = -1; this.restoreLens(); }
    else if (this.active > i) this.active--;
    this.applied = '';
    this.onList();
    this.onChange();
  }

  // Shows picture i; fly: glide the camera to its view (a pinned picture).
  activate(i, { fly = true } = {}) {
    const r = this.list[i];
    if (!r) return;
    if (this.active !== i) this.setAdjust(false);
    this.active = i;
    this.shown = true;
    if (r.pinned && fly) this.goTo(r);
    else this.setLens(r.view.fov);
    this.applied = '';
    this.onList();
  }

  goTo(r) {
    const v = this.v, cam = v.camera;
    this.setLens(r.view.fov);
    v.tween = { from: cam.position.clone(), fromT: v.controls.target.clone(), to: new THREE.Vector3().fromArray(r.view.pos), toT: new THREE.Vector3().fromArray(r.view.target), near: cam.near, far: cam.far, t0: performance.now(), dur: 450 };
    v.dirty = true;
  }

  // Ties the active picture to the camera's view of the moment.
  pin(i = this.active) {
    const r = this.list[i];
    if (!r) return;
    r.view = this.view();
    r.pinned = true;
    if (i !== this.active) this.activate(i, { fly: false });
    this.applied = '';
    this.status(`${r.name} is pinned to this view: it fades when you turn away, and a click on it in the list (or P) brings this view back`);
    this.onList();
    this.onChange();
  }

  // The 3D Viewer shares the camera: it gets the normal lens, the builder its picture's again.
  modeChanged(mode) {
    if (mode === 'build' && this.current()) this.setLens(this.current().view.fov);
    else { this.setAdjust(false); if (mode !== 'map') this.restoreLens(); } // (Maps sets its own lens)
    this.applied = '';
  }

  setLens(fov) {
    const cam = this.v.camera;
    fov = THREE.MathUtils.clamp(fov || this.defaultFov, 10, 100);
    if (Math.abs(cam.fov - fov) < 1e-3) return;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    this.v.dirty = true;
  }
  restoreLens() { this.setLens(this.defaultFov); }

  // The active picture's field of view (its view keeps it).
  setFov(fov) {
    const r = this.current();
    if (!r) return;
    r.view.fov = Math.round(fov * 100) / 100;
    this.setLens(r.view.fov);
    this.changed();
  }

  set(i, patch) {
    const r = this.list[i];
    if (!r) return;
    Object.assign(r, patch);
    this.changed();
  }

  // P: the active picture on and off (the first one when none is active yet).
  toggle() {
    if (!this.list.length) { this.status('No reference pictures yet: "Add picture…" in the panel on the right'); return; }
    if (this.active < 0) { this.activate(0); return; }
    this.shown = !this.shown;
    if (!this.shown) this.setAdjust(false);
    else if (this.current().pinned && this.match(this.current().view) < 0.99) this.goTo(this.current());
    this.applied = '';
    this.onList();
  }

  // Shift+P: the next picture, with its view.
  next() {
    if (!this.list.length) { this.toggle(); return; }
    this.activate((this.active + 1) % this.list.length);
  }

  setAdjust(on) {
    on = !!on && !!this.current() && this.shown;
    if (on === this.adjusting) return;
    this.adjusting = on;
    this.drag = null;
    this.applied = '';
    if (on) this.status('Line it up: drag the picture, zoom it with the wheel (arrow keys and + / - for small steps). Enter or Esc when it fits');
    else this.status('');
    this.onList();
  }

  // Zoom by k around a point of the layer (px from its top-left corner).
  zoomAt(k, px, py) {
    const r = this.current();
    if (!r) return;
    const W = this.layer.clientWidth || 1, H = this.layer.clientHeight || 1;
    const s = THREE.MathUtils.clamp(r.scale * k, 0.05, 20);
    k = s / r.scale;
    const cx = W / 2 + r.x * H, cy = H / 2 + r.y * H; // the picture's centre now
    r.x = (px - (px - cx) * k - W / 2) / H;
    r.y = (py - (py - cy) * k - H / 2) / H;
    r.scale = s;
    this.changed();
  }

  // Keys while lining up: arrows nudge (Shift: 10 px), + / - zoom (Shift: 10 %), Enter / Esc done.
  key(e) {
    if (!this.adjusting) return false;
    const r = this.current(), H = this.layer.clientHeight || 1, step = (e.shiftKey ? 10 : 1) / H;
    switch (e.key) {
      case 'ArrowLeft': r.x -= step; break;
      case 'ArrowRight': r.x += step; break;
      case 'ArrowUp': r.y -= step; break;
      case 'ArrowDown': r.y += step; break;
      case '+': case '=': this.zoomAt(e.shiftKey ? 1.1 : 1.01, this.layer.clientWidth / 2, this.layer.clientHeight / 2); return true;
      case '-': case '_': this.zoomAt(e.shiftKey ? 1 / 1.1 : 1 / 1.01, this.layer.clientWidth / 2, this.layer.clientHeight / 2); return true;
      case 'Enter': case 'Escape': this.setAdjust(false); return true;
      default: return false;
    }
    this.changed();
    return true;
  }

  changed() {
    this.applied = '';
    this.onChange();
  }

  // 1 at the picture's view, fading to 0 once the camera has turned about 5° or moved 6 % of its
  // distance away from it.
  match(view) {
    const cam = this.v.camera, t = this.v.controls.target;
    const p0 = new THREE.Vector3().fromArray(view.pos), t0 = new THREE.Vector3().fromArray(view.target);
    const d0 = t0.clone().sub(p0), d1 = t.clone().sub(cam.position);
    const dist = Math.max(1e-3, d0.length());
    const turn = d0.angleTo(d1) / DEG;
    const moved = cam.position.distanceTo(p0) / dist;
    const lens = Math.abs(cam.fov - view.fov) / Math.max(1, view.fov);
    const e = Math.max(turn / 5, moved / 0.06, lens / 0.08);
    return THREE.MathUtils.clamp(1 - (e - 0.1) / 0.9, 0, 1);
  }

  // Every frame: where the active picture goes on the screen, and how much of it shows.
  update() {
    const r = this.current();
    const on = !!r && this.shown && this.v.mode === 'build';
    this.fade = !on ? 0 : this.adjusting || !r.pinned ? 1 : this.match(r.view);
    if (!on && this.layer.hidden && this.applied.startsWith(`${r?.id}|0.000|`)) return; // (hidden and staying so: no layout read every frame)
    const W = this.layer.clientWidth, H = this.layer.clientHeight;
    const h = r ? r.scale * H : 0, w = r ? (h * r.w) / r.h : 0;
    const cx = r ? W / 2 + r.x * H : 0, cy = r ? H / 2 + r.y * H : 0;
    const opacity = on ? (this.adjusting ? Math.max(0.35, r.opacity) : r.opacity * this.fade) : 0;
    const key = `${r?.id}|${opacity.toFixed(3)}|${w.toFixed(1)}|${h.toFixed(1)}|${cx.toFixed(1)}|${cy.toFixed(1)}|${r?.front}|${this.adjusting}`;
    if (key === this.applied) return;
    this.applied = key;
    this.layer.hidden = !on || opacity <= 0.002;
    this.layer.classList.toggle('front', !!r?.front || this.adjusting);
    this.layer.classList.toggle('lining', this.adjusting);
    if (!r) return;
    const src = `${this.data}/png?image=${encodeURIComponent(r.id)}&max=4096`;
    if (this.img.dataset.src !== src) { this.img.dataset.src = src; this.img.src = src; }
    Object.assign(this.img.style, { width: `${w}px`, height: `${h}px`, left: `${cx}px`, top: `${cy}px`, opacity: String(opacity) });
  }

  // For the build file: the pictures by file (they are read again from disk when it is opened).
  serialize() {
    return {
      list: [...this.list.map((r) => ({ file: r.file, name: r.name, pinned: r.pinned, view: r.view, x: round(r.x), y: round(r.y), scale: round(r.scale), opacity: r.opacity, front: r.front })),
        ...this.unread], // (pictures that could not be read now stay, with their views: on a stick, renamed, offline)
      active: this.active,
    };
  }

  async clear() {
    for (const r of this.list) this.call('releaseImage', { id: r.id }).catch(() => {});
    this.list = [];
    this.unread = [];
    this.active = -1;
    this.setAdjust(false);
    this.restoreLens();
    this.applied = '';
    this.onList();
  }

  // Brings back the pictures of a build file. Returns the files that could not be read.
  async load(saved) {
    await this.clear();
    const missing = [];
    for (const s of saved?.list || []) {
      try {
        const img = await this.call('loadImagePath', { file: s.file });
        this.list.push({
          id: img.id, file: s.file, name: s.name || s.file.split(/[\\/]/).pop(), w: img.w, h: img.h, pinned: !!s.pinned,
          view: s.view && Array.isArray(s.view.pos) ? s.view : this.view(), x: +s.x || 0, y: +s.y || 0, scale: +s.scale || 1,
          opacity: s.opacity >= 0 ? +s.opacity : DEFAULT_OPACITY, front: s.front !== false,
        });
      } catch { missing.push(s.file); if (s?.file) this.unread.push(s); }
    }
    // (the active picture comes back without moving the camera: the opened build is framed instead)
    const a = Math.min(saved?.active ?? -1, this.list.length - 1);
    if (a >= 0) { this.active = a; this.setLens(this.list[a].view.fov); }
    this.applied = '';
    this.onList();
    return missing;
  }
}

const round = (v) => Math.round(v * 1e4) / 1e4;
