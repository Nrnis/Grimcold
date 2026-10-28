// Build mode: put parts together like Crossout's garage.
//
// Crossout builds on 0.3 m cubes. Every part's connection slots sit at cube-face centres
// (0.15 m lattice) and a slot's +Y axis points out of the part; two parts are attached where a
// slot of each sits in the same spot facing the other way. Part origins sit on grid corners, so
// placing origins on the 0.15 m lattice and rotating in 90-degree steps reproduces the game.
//
// A held part snaps where the cursor is (pickSnap): onto the face under it (the way the vehicle's weld
// points there look), its own points facing back laid onto them, at the placement whose weld face's
// middle is nearest the cursor, a free one (no overlap) first; it stays put until another is clearly
// nearer, a part in front without points there (a gun) gives way to the one behind it, and just off an
// edge it stays where it was.
//
// Selection: any number of parts (click, Ctrl/Shift+click, Shift+drag box, Ctrl+A). Moves, turns,
// mirroring, copying and deleting act on the whole selection; the last part picked is the
// "primary" one the side panel shows.
//
// Paint (paints.js), as the garage paints: the vehicle's paint on every part without one of its own,
// and parts painted one by one (inst.paint; amount 0 keeps a part bare), with the brush or the
// selection. Copies take their part's paint; undo and the build file keep it.
import * as THREE from 'three';
import { TransformControls } from 'three/addons/TransformControls.js';
import { CELL, Viewer } from './viewer.js';
import { physShapes, placeHulls, boxHull, partsOverlap } from './phys.js';
import { WheelMarks, isWheel } from './wheelmarks.js';
import { normPaint, paintForFile, DEFAULT_COLOR } from './paints.js';
import { stickerMesh, stickerTexture, disposeSticker, stickerAt, stickerExport, surfaceMeshes } from './stickers.js';
import { t as tr } from './i18n.js';

// A sticker record as a file or the undo history holds it (stickers.js stickerAt).
const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const validSticker = (s) => s && typeof s.base === 'string' && s.base.startsWith('textures/stickers/') && vec3(s.pos) && vec3(s.normal) && vec3(s.up) && s.size > 0 && s.size < 100;

const HALF = CELL / 2;
const OUTLINE = 0xffffff, OUTLINE_BAD = 0xff5a4f; // the garage's part outline (and for a part that can't go there)
// the selection's outline (the primary part brighter; the same orange as a map's selection) and the
// mirror twins that follow it
const OUTLINE_SEL = 0xffa43c, OUTLINE_SEL2 = 0xc8843e, OUTLINE_TWIN = 0x4cc3ff;
const GHOST = 0xdde9ff, GHOST_BAD = 0xef5b5b; // the held part: see-through whitish, red when it can't be dropped
// the brush's cursor: a paint brush, its tip where it paints
const BRUSH_CURSOR = `url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M21.6 1.4c.6.6.6 1.5 0 2.1l-8.4 9.6-2.5-2.5 9.6-8.4c.4-.5 1-.6 1.3-.8z' fill='#d8d8d8' stroke='#111' stroke-width='1'/><path d='M10.2 11.1l2.7 2.7c-.3 2.6-1.7 4.5-4.2 5.6-2.3 1-4.6 1.4-7.2 2.2 1.6-1.9 1.9-3.6 2.4-5.4.7-2.6 3.1-4.9 6.3-5.1z' fill='#ff6600' stroke='#111' stroke-width='1'/></svg>")}") 1 22, crosshair`;
const snap = (v, step) => Math.round(v / step) * step;
const cleanSnap = (v) => (Math.abs(v - snap(v, HALF)) < 0.02 ? snap(v, HALF) : Math.round(v * 1e4) / 1e4);
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
// The held part's snap (pickSnap): the six ways a build's face can look; how near weld points must be
// to the cursor to tell which way the face under it looks; how far the part may slide from the
// placement nearest the cursor to a free one; how much nearer another placement must be before the
// part leaves the one it is on (no flicker between two cells).
const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map((a) => new THREE.Vector3(...a));
const FACE_REACH = 0.6, SLIDE = 0.75, KEEP = 0.12, STICK = 1;
const TURN_TIME = 140; // ms a held part takes to turn (turn(): the eye can follow it)

// A part's collision hulls placed with its world matrix; a part without any (no .mdp) stands in
// with its box.
function hullsAt(phys, matrix, localBox) {
  return phys ? placeHulls(phys, matrix) : [boxHull(localBox.clone().applyMatrix4(matrix))];
}

function axisAlign(n) {
  const a = [Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)];
  const i = a.indexOf(Math.max(...a));
  const v = new THREE.Vector3();
  v.setComponent(i, Math.sign(n.getComponent(i)) || 1);
  return v;
}

// The 24 rotations of a cube (grid-aligned orientations), identity first, then by angle.
const ROTATIONS = (() => {
  const seen = new Map();
  const steps = [0, 1, 2, 3];
  for (const x of steps) for (const y of steps) for (const z of steps) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((x * Math.PI) / 2, (y * Math.PI) / 2, (z * Math.PI) / 2, 'XYZ'));
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements.map((v) => Math.round(v)).join(',');
    if (!seen.has(m)) seen.set(m, q);
  }
  // (rounded: float noise made -90° come out a hair bigger than +90°, so a roll sorted before it)
  const angle = (q) => Math.round(2 * Math.acos(Math.min(1, Math.abs(q.w))) * 1e6) / 1e6;
  const yaw = (q) => Math.abs(q.x) < 1e-6 && Math.abs(q.z) < 1e-6; // prefer turning around the vertical axis
  return [...seen.values()].sort((a, b) => angle(a) - angle(b) || Number(yaw(b)) - Number(yaw(a)));
})();

function boxCorners(b) {
  const out = [];
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new THREE.Vector3(x, y, z));
  return out;
}

// The nearest of the 24 grid rotations to q (a gizmo turn about a free axis lands on one of them).
function nearestRotation(q) {
  let best = ROTATIONS[0], bd = -1;
  for (const r of ROTATIONS) { const d = Math.abs(r.dot(q)); if (d > bd) { bd = d; best = r; } }
  return best.clone();
}

export class Build {
  // rules(adds): the game's limits for adding parts ([{ path }]); returns why not, or null.
  constructor(viewer, { getInfo, onChange = () => {}, onSelect = () => {}, onHover = () => {}, status = () => {}, nameOf = (info) => info.name, tipOf = (inst) => inst.path, rules = () => null, isCabin = (path) => path.startsWith('models/constructor/cabins/'), onePerVehicle = () => false, onPickPaint = () => {} }) {
    this.v = viewer;
    this.nameOf = nameOf; // display name of a part (its in-game name when known)
    this.tipOf = tipOf;   // what the part under the cursor is called beside the cursor
    this.getInfo = getInfo;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onHover = onHover; // the part under the cursor changed (the garage shows its card)
    this.status = status;
    this.rules = rules;
    this.isCabin = isCabin;
    this.onePerVehicle = onePerVehicle; // (cabin, engine: never mirrored by Symmetry)
    this.onPickPaint = onPickPaint; // (the brush took a part's paint: Alt+click)
    this.unloaded = []; // parts of an opened build this game version could not load (kept for the file)
    this.name = 'My build';
    this.instances = [];
    this.nextId = 1;
    this.sel = []; // selected part ids in the order they were picked; the last one is the primary
    this.placing = null;
    this.symmetry = false;
    this.texMax = 2048;
    this.paint = null; // the vehicle's paint (parts without their own); null: none
    this.paintColor = DEFAULT_COLOR.slice(); // (the last colour, kept in the file while there is no paint)
    this.brushOn = false; // painting with the brush: a click (or a drag) paints the parts under it
    this.brush = null;    // what it paints (amount 0: it takes paint off)
    this.stickerTool = null; // sticking stickers: { base, size, angle (radians) }: a click on a part sticks it there
    this.noLimits = false; // No limits: none of the garage's rules (parts, cabins, engines, overlaps; no red warnings)
    this.history = [this.snapshot()];
    this.future = [];
    this.busy = 0;

    this.root = new THREE.Group();
    this.root.name = 'build-parts';
    this.decor = new THREE.Group();
    viewer.buildRoot.add(this.root, this.decor);
    this.symPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x4cc3ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }));
    this.symPlane.rotation.y = Math.PI / 2;
    this.symPlane.visible = false;
    this.slotMarks = new THREE.Group();
    this.weldMarks = new THREE.Group(); // the vehicle's free weld points (and the ghost's, while placing)
    this.welds = true;
    this.arcs = true; // weapons' firing arcs
    this.loose = new Set();
    this.pivot = new THREE.Object3D(); // what the gizmo actually moves; dragUpdate() applies its motion to the selection
    this.wheelMarks = new WheelMarks(viewer, (path) => this.getInfo(path, '')); // AR: suspension springs and steering marks
    viewer.frameHooks.push(() => this.stepTurn()); // (a held part turning: turn())
    this.decor.add(this.symPlane, this.slotMarks, this.weldMarks, this.wheelMarks.group, this.pivot);
    this.ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.gizmo = new TransformControls(viewer.camera, viewer.canvas);
    // No translation snap on the gizmo itself: dragUpdate() rounds the distance moved to whole
    // cells, so parts keep their grid offset to each other and to the rest of the build.
    this.gizmo.setRotationSnap(Math.PI / 2);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.8);
    // Off unless asked for: like the garage, parts are moved by grabbing and dragging them.
    this.gizmoMode = 'off';
    this.gizmoHelper = this.gizmo.getHelper();
    viewer.scene.add(this.gizmoHelper);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      if (e.value) this.beginDrag();
      else this.gizmoDone();
    });
    this.gizmo.addEventListener('mouseDown', () => (this.gizmoClick = true));
    this.gizmo.addEventListener('objectChange', () => this.dragUpdate());
    this.gizmo.addEventListener('change', () => (this.v.dirty = true));

    const c = viewer.canvas;
    // (the presses below are cancelled, which also kept the focus in a text box: an X typed for one part
    // moved the part clicked next, and the builder's keys went into the box)
    const leaveField = () => { const a = document.activeElement; if (a && a !== document.body && a !== c) a.blur?.(); };
    this.marqueeEl = document.createElement('div');
    this.marqueeEl.className = 'marquee';
    this.marqueeEl.hidden = true;
    c.parentElement.appendChild(this.marqueeEl);
    // Shift/Ctrl + left button: a click adds or removes the part under the cursor, a drag draws a
    // selection box (Shift adds, Ctrl removes). Caught before the camera controls, which would pan.
    c.addEventListener('pointerdown', (e) => {
      if (viewer.mode !== 'build' || e.button !== 0 || !(e.shiftKey || e.ctrlKey || e.metaKey) || this.placing) return;
      e.stopImmediatePropagation();
      leaveField();
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      this.marquee = { x0: e.clientX, y0: e.clientY, remove: (e.ctrlKey || e.metaKey) && !e.shiftKey, active: false };
    }, { capture: true });
    // The sticker tool: the left button on a part sticks the chosen sticker where the cursor is (on
    // empty space it turns the camera, as ever); the see-through sticker follows the cursor.
    c.addEventListener('pointerdown', (e) => {
      if (viewer.mode !== 'build' || e.button !== 0 || !this.stickerTool || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.placing || this.busy || this.loadingNow) return;
      const hit = this.stickerHit(e);
      if (!hit) return;
      e.stopImmediatePropagation();
      leaveField();
      e.preventDefault();
      this.placeSticker(hit).catch((err) => this.status(err.message));
    }, { capture: true });
    // The brush: the left button on a part paints it, and every part the cursor passes over while it is
    // held (a mirror twin too, with Symmetry on); Alt+click takes the part's paint into the brush. On
    // empty space it turns the camera, as ever; Shift / Ctrl still select.
    c.addEventListener('pointerdown', (e) => {
      if (viewer.mode !== 'build' || e.button !== 0 || !this.brushOn || e.shiftKey || e.ctrlKey || e.metaKey) return;
      if (this.placing || this.busy || this.loadingNow || this.gizmo.axis !== null) return;
      const inst = this.instanceAt(e);
      if (!inst) return;
      e.stopImmediatePropagation();
      leaveField();
      e.preventDefault();
      if (e.altKey) { this.onPickPaint(this.paintOf(inst), inst); return; }
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      this.stroke = { done: new Set() };
      this.strokePaint(inst);
    }, { capture: true });
    // Left button on a part, as in the garage: a click selects it, a drag picks it up (the whole
    // selection when it is selected) and moves it with the cursor, snapping from weld point to weld
    // point; letting go drops it. Caught before the camera controls, which would turn the view.
    // On empty space the left button still turns the camera.
    c.addEventListener('pointerdown', (e) => {
      if (viewer.mode !== 'build' || e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.placing || this.busy || this.loadingNow || this.gizmo.axis !== null) return; // (a gizmo handle under the cursor gets the drag)
      const inst = this.instanceAt(e);
      if (!inst) return;
      e.stopImmediatePropagation();
      leaveField();
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
      this.press = { id: inst.id, x: e.clientX, y: e.clientY, moving: false, released: false };
    }, { capture: true });
    c.addEventListener('pointercancel', () => {
      if (this.stroke) this.endStroke();
      if (this.marquee) { this.marquee = null; this.marqueeEl.hidden = true; }
      if (this.press) { this.press = null; if (this.placing) this.cancelPlacing(); }
    });
    c.addEventListener('pointerdown', (e) => {
      if (viewer.mode !== 'build') return;
      this.down = { x: e.clientX, y: e.clientY, button: e.button };
      viewer.onHover(null); // (the name by the cursor goes while a button is down)
    });
    c.addEventListener('pointerup', (e) => {
      if (viewer.mode !== 'build') return;
      if (this.stroke) { try { c.releasePointerCapture(e.pointerId); } catch { /* not captured */ } this.endStroke(); return; }
      if (this.marquee) { this.endMarquee(e); return; }
      if (this.press) { this.endPress(e); return; }
      if (!this.down) return;
      const d = this.down;
      this.down = null;
      const gz = this.gizmoClick;
      this.gizmoClick = false;
      if (gz || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      if (d.button === 2) { if (this.placing) this.cancelPlacing(); return; }
      if (d.button !== 0) return;
      if (this.placing) this.commitPlacing();
      else this.select(this.instanceAt(e)?.id ?? null);
    });
    c.addEventListener('pointermove', (e) => {
      if (viewer.mode !== 'build') return;
      this.lastPointer = e;
      if (this.stroke) { const inst = this.instanceAt(e); if (e.buttons & 1) this.strokePaint(inst); this.hover(inst, e); return; }
      if (this.marquee) { this.moveMarquee(e); return; }
      const pr = this.press;
      if (pr && !pr.moving && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > 6) this.beginDragMove();
      if (this.placing) this.updatePlacement();
      else if (!this.down && !pr) this.hover(this.instanceAt(e), e);
      if (this.stickerTool && !this.down) this.previewSticker(e);
    });
    c.addEventListener('pointerleave', () => { if (viewer.mode === 'build') { this.hover(null); this.clearStickerPreview(); } });
    c.addEventListener('contextmenu', (e) => { if (viewer.mode === 'build') e.preventDefault(); });
  }

  // ---- grab and drag (the garage's way of moving parts) -----------------------------------------
  async beginDragMove() {
    const pr = this.press;
    pr.moving = true;
    const inst = this.get(pr.id);
    if (!inst) { this.press = null; return; }
    this.hover(null);
    try {
      if (this.isSelected(inst.id) && this.sel.length > 1) {
        await this.startPlacingGroup(this.selection(), { move: true });
      } else {
        const twin = this.symmetry ? this.twinOf(inst) : null;
        await this.startPlacing(inst.path, inst.skin, { moveId: inst.id, twinId: twin?.id ?? null });
      }
    } catch (e) {
      if (this.press === pr) this.press = null;
      this.status(`Could not pick it up: ${e.message}`);
      return;
    }
    if (this.press !== pr) return; // cancelled meanwhile (Esc, another view)
    if (this.placing) this.status(`Moving ${this.placing.group ? this.placing.members.length + ' parts' : this.nameOf(inst.info)}: let go to drop · R spin · T tip · Y roll · X mirror · Esc cancel`);
    if (pr.released) { // let go before the part was picked up
      this.press = null;
      if (this.placing) await this.dropOrPutBack();
    }
  }

  endPress(e) {
    const pr = this.press;
    try { this.v.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!pr.moving) { this.press = null; this.select(pr.id); return; } // a click: select it
    if (this.placing) { this.press = null; this.dropOrPutBack(); return; }
    if (this.busy) { pr.released = true; return; } // still picking it up: drop it when it is ready
    this.press = null; // cancelled meanwhile (Esc)
  }

  // End of a drag: drop the part where it is, or, when it can't go there, put it back.
  async dropOrPutBack() {
    const p = this.placing;
    if (p.hasPos && p.valid) { await this.commitPlacing(); return; }
    this.cancelPlacing();
    if (p.hasPos) this.status("Can't place it there: it overlaps another part. Put back where it was.");
  }

  get(id) { return this.instances.find((i) => i.id === id) || null; }

  // ---- selection --------------------------------------------------------------------------------
  get selected() { return this.sel.length ? this.sel[this.sel.length - 1] : null; } // the primary part
  selection() { return this.sel.map((id) => this.get(id)).filter(Boolean); }
  isSelected(id) { return this.sel.includes(id); }

  // The new selection, in picking order (the last id becomes the primary).
  setSelection(ids, { keepPlacing = false } = {}) {
    if (!keepPlacing && this.placing) this.cancelPlacing();
    const seen = new Set();
    // (nothing is selected while a build loads: what is selected gets edited, and load() made those edits the
    // start of the undo history)
    this.sel = this.loadingNow ? [] : ids.filter((id) => id != null && !seen.has(id) && seen.add(id) && this.get(id));
    this.attachGizmo();
    this.showSelection();
    this.hover(this.hovered);
    this.onSelect(this.get(this.selected));
    this.v.dirty = true;
  }

  // select(id): just that part (null: nothing). add: keep the others too. toggle: add or remove it.
  select(id, { keepPlacing = false, add = false, toggle = false } = {}) {
    if (id == null) return this.setSelection(add || toggle ? this.sel : [], { keepPlacing });
    if (toggle && this.isSelected(id)) return this.setSelection(this.sel.filter((x) => x !== id), { keepPlacing });
    return this.setSelection(add || toggle ? [...this.sel.filter((x) => x !== id), id] : [id], { keepPlacing });
  }

  selectMany(ids, { add = false, remove = false } = {}) {
    if (remove) return this.setSelection(this.sel.filter((id) => !ids.includes(id)));
    return this.setSelection(add ? [...this.sel.filter((id) => !ids.includes(id)), ...ids] : ids);
  }

  selectAll() { this.setSelection(this.instances.filter((i) => i.group.visible).map((i) => i.id)); }

  // The grid point nearest the middle of the selection: turns and mirroring happen around it, so
  // parts on the 0.15 m lattice stay on it.
  selectionCenter(parts = this.selection()) {
    const b = new THREE.Box3();
    for (const i of parts) b.union(i.box);
    const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
    return new THREE.Vector3(snap(c.x, HALF), snap(c.y, HALF), snap(c.z, HALF));
  }

  attachGizmo() {
    if (this.sel.length && this.gizmoMode !== 'off' && !this.placing) {
      if (!this.drag) this.placePivot();
      this.gizmo.attach(this.pivot);
      this.gizmo.setMode(this.gizmoMode);
    } else {
      this.gizmo.detach();
    }
  }

  placePivot() {
    this.pivot.position.copy(this.selectionCenter());
    this.pivot.quaternion.identity();
    this.pivot.updateMatrixWorld(true);
  }

  // Box selection: the parts whose middle shows inside the page rectangle.
  partsInRect(x0, y0, x1, y1) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    return this.instances.filter((i) => {
      if (!i.group.visible) return false;
      const c = i.box.getCenter(new THREE.Vector3());
      const p = this.v.project(c.x, c.y, c.z);
      return p.inFront && p.x >= ax && p.x <= bx && p.y >= ay && p.y <= by;
    });
  }

  selectInRect(x0, y0, x1, y1, { add = true, remove = false } = {}) {
    const ids = this.partsInRect(x0, y0, x1, y1).map((i) => i.id);
    this.selectMany(ids, { add, remove });
    return ids.length;
  }

  moveMarquee(e) {
    const m = this.marquee;
    if (!m.active && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) > 5) m.active = true;
    if (!m.active) return;
    const r = this.marqueeEl.parentElement.getBoundingClientRect();
    Object.assign(this.marqueeEl.style, {
      left: `${Math.min(m.x0, e.clientX) - r.left}px`, top: `${Math.min(m.y0, e.clientY) - r.top}px`,
      width: `${Math.abs(e.clientX - m.x0)}px`, height: `${Math.abs(e.clientY - m.y0)}px`,
    });
    this.marqueeEl.classList.toggle('remove', m.remove);
    this.marqueeEl.hidden = false;
  }

  endMarquee(e) {
    const m = this.marquee;
    this.marquee = null;
    this.marqueeEl.hidden = true;
    try { this.v.canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (m.active) {
      const n = this.selectInRect(m.x0, m.y0, e.clientX, e.clientY, { add: !m.remove, remove: m.remove });
      this.status(n ? `${m.remove ? 'Removed' : 'Added'} ${n} part${n > 1 ? 's' : ''} ${m.remove ? 'from' : 'to'} the selection` : 'No parts inside the box');
    } else {
      const inst = this.instanceAt(e);
      if (inst) this.select(inst.id, { toggle: true });
    }
  }

  // ---- instances -------------------------------------------------------------------------------
  // st: a wheel's steering version (same model, other stats: "Array ST").
  // paint: its own paint (normPaint), or none (the vehicle's shows on it).
  async createInstance({ path, skin = '', position = [0, 0, 0], quaternion = [0, 0, 0, 1], mirrored = false, st = false, id = null, paint = null, stickers = null }) {
    const own = paint ? normPaint(paint) : null;
    const [info, phys] = await Promise.all([this.getInfo(path, skin), physShapes(path)]);
    const group = await this.v.makeModel(info, 0, { texMax: this.texMax, paint: own ?? this.paint });
    const inst = { id: id ?? this.nextId++, path: info.path, skin: info.skin, info, group, mirrored: !!mirrored, st: !!st, phys, paint: own };
    if (id != null) this.nextId = Math.max(this.nextId, id + 1);
    group.position.fromArray(position);
    group.quaternion.fromArray(quaternion).normalize();
    group.scale.set(mirrored ? -1 : 1, 1, 1);
    group.userData.instanceId = inst.id;
    this.root.add(group);
    this.instances.push(inst);
    this.updateInstance(inst);
    this.applyPaints([inst]); // (the vehicle's paint may have changed while it loaded)
    this.addArc(group);
    inst.stickers = Array.isArray(stickers) ? stickers.filter(validSticker).map((s) => ({ ...s })) : [];
    if (inst.stickers.length) await this.drawStickers(inst);
    return inst;
  }

  // ---- stickers (stickers.js) ---------------------------------------------------------------------
  // A part's stickers drawn anew from its records (children of its model, in its own space).
  async drawStickers(inst) {
    const gen = (inst.stickerGen = (inst.stickerGen || 0) + 1);
    const texs = await Promise.all(inst.stickers.map((s) => stickerTexture(s.base).catch(() => null)));
    if (gen !== inst.stickerGen || inst.group.userData.disposed) return; // (redrawn meanwhile, or gone)
    for (const c of [...inst.group.children]) if (c.userData.sticker) disposeSticker(c);
    let missing = 0;
    inst.stickers.forEach((s, k) => {
      const m = texs[k] && stickerMesh(inst.group, s, texs[k]);
      if (m) inst.group.add(m);
      else missing++;
    });
    if (missing) this.status(`${missing} sticker${missing > 1 ? 's' : ''} on ${this.nameOf(inst.info)} could not be shown (not in this game version's files)`);
    this.v.dirty = true;
  }

  // tool: { base, size (m), angle (radians) } or null (off)
  setStickerTool(tool) {
    this.stickerTool = tool ? { ...tool } : null;
    if (tool && this.placing) this.cancelPlacing();
    this.clearStickerPreview();
    this.v.canvas.style.cursor = tool ? 'copy' : this.v.mode === 'build' ? 'crosshair' : '';
    if (tool && this.lastPointer) this.previewSticker(this.lastPointer);
    this.onChange();
  }

  // The part's surface under the cursor: { inst, point, normal } (world; the normal towards the camera), or null.
  stickerHit(e) {
    const rc = this.v.raycaster;
    rc.setFromCamera(this.v.ndc(e), this.v.camera);
    const meshes = this.instances.filter((i) => i.group.visible).flatMap((i) => surfaceMeshes(i.group));
    const hit = rc.intersectObjects(meshes, false).find((h) => h.face);
    if (!hit) return null;
    const inst = this.instanceOfObject(hit.object);
    if (!inst) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    if (n.dot(rc.ray.direction) > 0) n.negate();
    return { inst, point: hit.point.clone(), normal: n };
  }

  clearStickerPreview() {
    if (this.stickerPreview) { disposeSticker(this.stickerPreview); this.stickerPreview = null; this.v.dirty = true; }
  }

  // The chosen sticker, see-through, where a click would stick it (once a frame at most).
  previewSticker(e) {
    this.stickerPointer = e;
    if (this.stickerFrame) return;
    this.stickerFrame = requestAnimationFrame(async () => {
      this.stickerFrame = 0;
      const t = this.stickerTool, ev = this.stickerPointer;
      if (!t || !ev) return this.clearStickerPreview();
      const hit = this.stickerHit(ev);
      const tex = hit ? await stickerTexture(t.base).catch(() => null) : null;
      this.clearStickerPreview();
      if (!hit || !tex || this.stickerTool !== t) return;
      const m = stickerMesh(hit.inst.group, stickerAt(hit.inst.group, t.base, hit.point, hit.normal, t.angle, t.size), tex, { opacity: 0.6 });
      if (!m) return;
      hit.inst.group.add(m);
      this.stickerPreview = m;
      this.v.dirty = true;
    });
  }

  async placeSticker(hit) {
    const t = this.stickerTool;
    if (!t) return;
    const s = stickerAt(hit.inst.group, t.base, hit.point, hit.normal, t.angle, t.size);
    hit.inst.stickers.push(s);
    this.clearStickerPreview();
    await this.drawStickers(hit.inst);
    this.commit();
    this.status(`Sticker stuck on ${this.nameOf(hit.inst.info)} (Ctrl+Z takes it off)`);
    this.onChange();
  }

  // No limits (on) or the garage's rules: the held part and its twin, the red parts and the panel follow.
  setNoLimits(on) {
    if (this.noLimits === !!on) return; // (the start-up's restore of the same setting is no change: no autosave, no redraw)
    this.noLimits = !!on;
    this.markLoose();
    if (this.placing) this.syncTwin().then(() => this.updatePlacement()).catch(() => {});
    this.onChange();
  }

  // Takes every sticker off the selected parts.
  clearStickers() {
    const sel = this.selection().filter((i) => i.stickers?.length);
    if (!sel.length) return;
    const n = sel.reduce((k, i) => k + i.stickers.length, 0);
    for (const inst of sel) {
      inst.stickers = [];
      inst.stickerGen = (inst.stickerGen || 0) + 1;
      for (const c of [...inst.group.children]) if (c.userData.sticker) disposeSticker(c);
    }
    this.v.dirty = true;
    this.commit();
    this.status(`${n} sticker${n > 1 ? 's' : ''} taken off (Ctrl+Z puts ${n > 1 ? 'them' : 'it'} back)`);
    this.onChange();
  }

  // The stickers for an export: world space, each piece with its sticker's texture.
  exportStickers({ onlySelected = false } = {}) {
    return (onlySelected && this.sel.length ? this.selection() : this.instances).flatMap((i) => stickerExport(i.group));
  }

  // A weapon's firing arc rides along as a child of its model (moves, turns and mirrors with it).
  async addArc(group) {
    const arc = await this.v.addArc(group, { force: true });
    if (arc) arc.visible = this.arcs;
  }

  setArcs(on) {
    this.arcs = on;
    const groups = [...this.instances.map((i) => i.group), this.placing?.ghost, this.placing?.twin].filter(Boolean);
    for (const g of groups) for (const c of g.children) if (c.name === 'arc') c.visible = on;
    this.v.dirty = true;
  }

  updateInstance(inst) {
    const g = inst.group;
    this.v.shadowDirty = true;
    g.updateMatrixWorld(true);
    inst.box = g.userData.box.clone().applyMatrix4(g.matrixWorld);
    inst.slotsWorld = g.userData.slots.map((s) => ({ pos: s.pos.clone().applyMatrix4(g.matrixWorld), normal: s.normal.clone().transformDirection(g.matrixWorld), ring: s.ring, lift: s.lift }));
    inst.hulls = hullsAt(inst.phys, g.matrixWorld, g.userData.box);
  }

  removeInstance(inst) {
    this.instances = this.instances.filter((i) => i !== inst);
    if (this.stickerPreview?.parent === inst.group) this.clearStickerPreview();
    for (const c of [...inst.group.children]) if (c.userData.sticker) disposeSticker(c); // (their own geometry and materials)
    inst.stickerGen = (inst.stickerGen || 0) + 1;
    this.v.disposeModel(inst.group);
    if (this.hovered === inst) this.hover(null);
    if (this.placing?.onPart === inst) this.placing.onPart = null; // (no outline left on a removed part)
    if (this.isSelected(inst.id)) this.setSelection(this.sel.filter((id) => id !== inst.id), { keepPlacing: true });
    this.updateOutlines();
    this.v.dirty = true;
  }

  transformOf(inst) {
    const t = { path: inst.path, skin: inst.skin, position: inst.group.position.toArray().map((v) => Math.round(v * 1e5) / 1e5), quaternion: inst.group.quaternion.toArray().map((v) => Math.round(v * 1e6) / 1e6), mirrored: inst.mirrored };
    if (inst.st) t.st = true;
    if (inst.paint) t.paint = inst.paint; // (its own paint: undo, copies and the file keep it)
    if (inst.stickers?.length) t.stickers = inst.stickers;
    return t;
  }

  // ---- placing (a ghost follows the cursor, click drops it) ----------------------------------------
  // paint: a copy's own paint (its part's)
  async startPlacing(path, skin = '', { moveId = null, twinId = null, quaternion = null, mirrored = false, st = false, paint = null } = {}) {
    this.cancelPlacing();
    const prevSel = [...this.sel];
    const token = (this.placeToken = (this.placeToken || 0) + 1);
    this.busy++;
    try {
      const own = moveId != null ? this.get(moveId)?.paint ?? null : paint ? normPaint(paint) : null;
      const [info, phys] = await Promise.all([this.getInfo(path, skin), physShapes(path)]);
      const ghost = await this.v.makeModel(info, 0, { texMax: this.texMax, ghost: true, paint: own ?? this.paint });
      ghost.userData.phys = phys;
      if (token !== this.placeToken) { this.v.disposeModel(ghost); return; }
      const moving = moveId != null ? this.get(moveId) : null;
      const twinInst = moving && twinId != null ? this.get(twinId) : null;
      if (moving) {
        quaternion = moving.group.quaternion.toArray();
        mirrored = moving.mirrored;
        moving.group.visible = false;
      }
      // a twin that follows the move steps aside too (a mirrored ghost shows where it will go)
      if (twinInst) twinInst.group.visible = false;
      this.placing = { info, path: info.path, skin: info.skin, st: moving ? moving.st : !!st, paint: own, ghost, twin: null, quat: new THREE.Quaternion().fromArray(quaternion || [0, 0, 0, 1]), mirrored: !!mirrored, moveId: moving ? moving.id : null, moveIds: moving ? [moving.id] : [], twinId: twinInst ? twinInst.id : null, hiddenTwins: twinInst ? [twinInst.id] : [], prevSel: moving ? prevSel : [], valid: true, twinValid: true, hasPos: false };
      ghost.visible = false;
      this.root.add(ghost);
      this.addArc(ghost);
      await this.syncTwin();
      this.select(null, { keepPlacing: true });
      this.v.hoverEnabled = false;
      this.hover(null);
      if (this.lastPointer) this.updatePlacement();
      this.status(`${moving ? 'Moving' : 'Placing'} ${this.nameOf(info)}: click to drop · R spin · T tip · Y roll · X mirror · M symmetry · Esc cancel`);
      this.onChange();
    } finally {
      this.busy--;
    }
  }

  // Several parts on the cursor at once (moving or copying a selection). They keep their places
  // relative to each other and snap as one piece.
  async startPlacingGroup(parts, { move = false } = {}) {
    this.cancelPlacing();
    const prevSel = [...this.sel];
    const token = (this.placeToken = (this.placeToken || 0) + 1);
    const twinPairs = move ? this.selectionTwins().filter(([a]) => parts.includes(a)).map(([a, t]) => [a.id, t.id]) : [];
    // The group hangs off its last part's origin (a grid corner), so snapping the group to whole
    // cells keeps every part on the build's grid.
    const origin = parts[parts.length - 1].group.position.clone();
    const members = parts.map((i) => ({ path: i.path, skin: i.skin, st: i.st, paint: i.paint, info: i.info, position: i.group.position.clone(), quaternion: i.group.quaternion.clone(), mirrored: i.mirrored }));
    this.busy++;
    try {
      const ghost = await this.makeCompound(members, origin);
      if (token !== this.placeToken) { this.disposeGhost(ghost); return; }
      const moveIds = move ? parts.map((i) => i.id) : [];
      const hiddenTwins = twinPairs.map(([, t]) => t);
      for (const id of [...moveIds, ...hiddenTwins]) { const i = this.get(id); if (i) i.group.visible = false; }
      this.placing = { group: true, members, origin, info: null, path: null, skin: null, ghost, twin: null, quat: new THREE.Quaternion(), mirrored: false, moveId: null, moveIds, twinPairs, hiddenTwins, prevSel: move ? prevSel : [], valid: true, twinValid: true, hasPos: false };
      ghost.visible = false;
      this.root.add(ghost);
      await this.syncTwin();
      this.select(null, { keepPlacing: true });
      this.v.hoverEnabled = false;
      this.hover(null);
      if (this.lastPointer) this.updatePlacement();
      this.status(`${move ? 'Moving' : 'Copying'} ${parts.length} parts: click to drop · R spin · T tip · Y roll · X mirror · Esc cancel`);
      this.onChange();
    } finally {
      this.busy--;
    }
  }

  // A ghost made of several parts. Its slots are the members' slots that do not join two
  // members, so it snaps onto the build like one big part.
  async makeCompound(members, origin) {
    const root = new THREE.Group();
    const ud = { materials: [], slots: [], box: new THREE.Box3(), members: [] };
    root.userData = ud;
    try {
      for (const m of members) {
        const [g, phys] = await Promise.all([this.v.makeModel(m.info, 0, { texMax: this.texMax, ghost: true, paint: m.paint ?? this.paint }), physShapes(m.path)]);
        g.position.copy(m.position).sub(origin);
        g.quaternion.copy(m.quaternion);
        g.scale.set(m.mirrored ? -1 : 1, 1, 1);
        g.updateMatrix();
        root.add(g);
        ud.members.push({ group: g, local: g.matrix.clone(), phys });
        ud.materials.push(...g.userData.materials);
        ud.box.union(g.userData.box.clone().applyMatrix4(g.matrix));
      }
    } catch (e) {
      this.disposeGhost(root);
      throw e;
    }
    const all = ud.members.flatMap((m, mi) => m.group.userData.slots.map((s) => ({ mi, pos: s.pos.clone().applyMatrix4(m.local), normal: s.normal.clone().transformDirection(m.local), ring: s.ring, lift: s.lift })));
    ud.slots = all.filter((a) => !all.some((b) => b.mi !== a.mi && b.pos.distanceTo(a.pos) < 0.02 && b.normal.dot(a.normal) < -0.9));
    return root;
  }

  disposeGhost(g) {
    if (!g) return;
    if (!g.userData.members) { this.v.disposeModel(g); return; }
    for (const m of g.userData.members) this.v.disposeModel(m.group);
    g.parent?.remove(g);
    this.v.dirty = true;
  }

  // World transform of one member of a (placed) compound ghost.
  memberTransform(container, k) {
    container.updateMatrix();
    const M = container.matrix.clone().multiply(container.userData.members[k].local);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    M.decompose(pos, q, sc);
    return { position: [cleanSnap(pos.x), cleanSnap(pos.y), cleanSnap(pos.z)], quaternion: q.normalize().toArray(), mirrored: sc.x < 0 };
  }

  // Also called to stop a part that is still being picked up (the token makes the load drop it).
  cancelPlacing() {
    this.placeToken = (this.placeToken || 0) + 1;
    const p = this.placing;
    if (!p) return;
    this.placing = null;
    this.disposeGhost(p.ghost);
    if (p.twin) this.disposeGhost(p.twin);
    for (const id of [...(p.moveIds || []), ...(p.hiddenTwins || [])]) {
      const inst = this.get(id);
      if (inst) inst.group.visible = true;
    }
    this.v.hoverEnabled = true;
    this.v.dirty = true;
    this.status('');
    if (p.prevSel?.length) this.setSelection(p.prevSel.filter((id) => this.get(id)), { keepPlacing: true });
    this.showWelds();
    this.updateOutlines();
    this.onChange();
  }

  // The mirror ghost while Symmetry is on: for new parts and copies, and for a part being moved
  // whose twin follows it (a group move's twins just follow on the drop).
  async syncTwin() {
    const p = this.placing;
    if (!p) return;
    const moving = p.moveIds.length > 0;
    // (a vehicle has one cabin and one engine: those get no mirror copy; the cabin sets the mirror
    // plane anyway, and its twin made Symmetry refuse it as a second cabin)
    const single = !this.noLimits && (p.group ? p.members.some((m) => this.onePerVehicle(m.path)) : this.onePerVehicle(p.path));
    const want = this.symmetry && !single && (!moving || (!p.group && p.twinId != null));
    if (want && !p.twin) {
      const twin = p.group ? await this.makeCompound(p.members, p.origin) : await this.v.makeModel(p.info, 0, { texMax: this.texMax, ghost: true, paint: p.paint ?? this.paint });
      if (this.placing !== p || p.twin || !this.symmetry) { this.disposeGhost(twin); return; } // (Symmetry went off while it loaded)
      twin.visible = false;
      p.twin = twin;
      this.root.add(twin);
      if (!p.group) this.addArc(twin); // (a weapon's mirror copy shows its firing arc too)
    } else if (!want && p.twin) {
      this.disposeGhost(p.twin);
      p.twin = null;
    }
    this.updatePlacement();
  }

  // ---- the build grid --------------------------------------------------------------------------
  // Along each axis, the build's cell boundaries fall on even (0) or odd (1) multiples of 0.15 m.
  // Every weld point tells: it lies on a boundary along its normal and at cell centres across it.
  // Parts only weld where they agree, so these parities are what "on the vehicle's grid" means.
  static gridParity(slots) {
    const votes = [[0, 0], [0, 0], [0, 0]];
    for (const s of slots) {
      const n = s.normal, ax = Math.abs(n.x), ay = Math.abs(n.y), az = Math.abs(n.z);
      const a = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
      [s.pos.x, s.pos.y, s.pos.z].forEach((v, k) => { const par = ((Math.round(v / HALF) % 2) + 2) % 2; votes[k][k === a ? par : 1 - par]++; });
    }
    return votes.map(([even, odd]) => (even + odd === 0 ? null : even >= odd ? 0 : 1));
  }

  // After a turn: parts turned about a point of the other parity land half a cell off the grid
  // (still on the 0.15 m lattice, but no longer able to weld). Shift them back onto the vehicle's
  // grid, in the half-cell direction that welds the most points. want: the grid to keep when the
  // turned parts are the whole vehicle (their own grid before the turn).
  alignToGrid(parts, want) {
    const ids = new Set(parts.map((i) => i.id));
    const rest = this.instances.filter((i) => !ids.has(i.id) && i.group.visible);
    const target = rest.length ? Build.gridParity(rest.flatMap((i) => i.slotsWorld)) : want;
    const have = Build.gridParity(parts.flatMap((i) => i.slotsWorld));
    const axes = [0, 1, 2].filter((k) => target[k] != null && have[k] != null && target[k] !== have[k]);
    if (!axes.length) return;
    const index = this.slotIndex(ids);
    let best = null, bestScore = -1;
    for (let m = 0; m < 1 << axes.length; m++) {
      const d = new THREE.Vector3();
      axes.forEach((k, j) => d.setComponent(k, (m >> j) & 1 ? -HALF : HALF));
      let score = 0;
      for (const inst of parts) for (const s of inst.slotsWorld) if (this.mates(index, null, { pos: s.pos.clone().add(d), normal: s.normal }).length) score++;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    for (const inst of parts) {
      const g = inst.group;
      g.position.add(best);
      g.position.set(cleanSnap(g.position.x), cleanSnap(g.position.y), cleanSnap(g.position.z));
      this.updateInstance(inst);
    }
  }

  // The axes a turn goes about, as the user sees the part: spin about the normal of the face it sits on
  // (+: anticlockwise as you look at that face; a held part: the face it snapped to; a placed one: the
  // way its welds face; else the vertical), tip about the axis of the two others nearest the screen's
  // horizontal (+: its top towards the camera), roll about the last one (+: clockwise as the camera
  // sees it). Grid axes, signed.
  turnAxes(inst = null) {
    let spin = null;
    if (this.placing) { const p = this.placing; spin = (p.snapped || p.refused) && p.snapFace ? p.snapFace.clone() : null; } // (shown turned on a face, unwelded: still that face)
    else if (inst) { // (the way its welds face: the surface it sits on looks the other way)
      const index = this.slotIndex(), sum = new THREE.Vector3();
      inst.slotsWorld.forEach((s) => { if (this.mates(index, inst, s).length) sum.sub(s.normal); });
      if (sum.lengthSq() > 1e-6) spin = axisAlign(sum);
    }
    spin = spin || new THREE.Vector3(0, 1, 0);
    const cam = this.v.camera, right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), into = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const others = FACES.filter((a) => Math.abs(a.dot(spin)) < 0.5);
    const tip = others.reduce((b, a) => (a.dot(right) > b.dot(right) ? a : b)).clone();
    const roll = spin.clone().cross(tip);
    if (roll.dot(into) < 0) roll.negate();
    return { spin, tip, roll };
  }

  // R / T / Y (and the part card's buttons): a quarter turn of the held part or the selection as the
  // user sees it (turnAxes), Shift the other way. Turns in a row keep their axes (the same part or
  // selection, the same view, the held part on the same face): R and Shift+R undo each other exactly,
  // though a turn can unweld a placed part.
  turn(kind, sign = 1) {
    if (!this.placing && this.busy) return; // (a part still being picked up: the selected one turned instead)
    const p = this.placing, held = p ? `held ${p.snapped || p.refused ? FACES.indexOf(p.snapFace) : -1}` : this.sel.join(',');
    const key = `${held}|${this.v.camera.quaternion.toArray().map((x) => Math.round(x * 1000)).join(',')}`;
    // (a selection keeps them only while nothing but these turns moved it: after a move, an undo or a
    // part added, R goes about the way its weld points face now)
    const pose = () => (p ? '' : `${this.instances.length};${this.selection().map((i) => [i.id, ...i.group.position.toArray(), ...i.group.quaternion.toArray()].map((x) => Math.round(x * 1000)).join(',')).join(';')}`);
    if (this.turnMemo?.key !== key || this.turnMemo.pose !== pose()) this.turnMemo = { key, axes: this.turnAxes(p || this.sel.length !== 1 ? null : this.get(this.selected)) };
    const axes = this.turnMemo.axes;
    this.rotate(axes[kind] || axes.spin, sign);
    this.turnMemo.pose = pose();
  }

  // The held part's turn, played over TURN_TIME: from where it was shown to where the snap put it
  // after the turn, about the middle of its box.
  stepTurn() {
    const p = this.placing, fx = p?.turnFx;
    if (!fx || !fx.to) return;
    const g = p.ghost, k = Math.min(1, (performance.now() - fx.t0) / TURN_TIME), e = k * k * (3 - 2 * k);
    const lc = g.userData.box.getCenter(new THREE.Vector3()), S = new THREE.Vector3(p.mirrored ? -1 : 1, 1, 1);
    const q = fx.q0.clone().slerp(fx.to.q, e), c1 = lc.clone().multiply(S).applyQuaternion(fx.to.q).add(fx.to.pos);
    g.quaternion.copy(q);
    g.position.copy(fx.c0.clone().lerp(c1, e)).sub(lc.clone().multiply(S).applyQuaternion(q));
    g.updateMatrixWorld(true);
    this.v.dirty = true;
    if (k >= 1) { g.position.copy(fx.to.pos); g.quaternion.copy(fx.to.q); g.updateMatrixWorld(true); p.turnFx = null; }
  }

  // The held part's turn shown at once (a drop must not take the pose it is passing through).
  finishTurn() {
    const fx = this.placing?.turnFx;
    if (fx) { fx.t0 = -Infinity; this.stepTurn(); }
  }

  // axis: 'x' / 'y' / 'z' (the world's) or a vector (a grid axis: turnAxes()).
  rotate(axis, sign = 1) {
    const q = new THREE.Quaternion().setFromAxisAngle(typeof axis === 'string' ? AXES[axis] : axis, (sign * Math.PI) / 2);
    if (this.placing) { // (the part as it is shown turns: the snap's own turn included)
      const p = this.placing, g = p.ghost;
      this.finishTurn();
      const shown = p.hasPos ? g.quaternion.clone() : null, box = shown ? g.userData.box.clone().applyMatrix4(g.matrixWorld) : null;
      p.quat = nearestRotation(q.clone().multiply(p.effQuat || p.quat));
      p.turnedOn = p.snapped || p.refused ? p.snapFace : null; // (shown turned on it, unwelded: still that face; the next turn snapped it back)
      p.turnFx = shown ? { q0: shown, c0: box.getCenter(new THREE.Vector3()), t0: performance.now(), to: null } : null;
      this.updatePlacement();
      return;
    }
    const sel = this.selection();
    if (!sel.length) return;
    const twins = this.selectionTwins();
    const before = this.overlapsOf([...sel, ...twins.map(([, t]) => t)]);
    const grid = Build.gridParity(sel.flatMap((i) => i.slotsWorld));
    // A turn about the same axis straight after the last one can go about the point that one turned about in
    // effect (its middle, plus the half cells that put it back on the grid). The turn back always does, so R then
    // Shift+R comes back exactly (the half cells went the same way every time: a lone part walked off a cell);
    // the same way again only while that welds as much as the turn about its middle (two Rs on a welded part
    // put it a cell off the vehicle), so four Rs on a lone part come back too.
    const n = typeof axis === 'string' ? AXES[axis] : axis;
    const pose = () => sel.map((i) => [...i.group.position.toArray(), ...i.group.quaternion.toArray()].map((x) => Math.round(x * 1e4)).join(',')).join(';');
    const start = sel.map((i) => [i.group.position.clone(), i.group.quaternion.clone()]);
    const turnAbout = (c) => {
      sel.forEach((inst, k) => {
        const g = inst.group;
        g.position.copy(start[k][0]).sub(c).applyQuaternion(q).add(c);
        g.quaternion.copy(start[k][1]).premultiply(q).normalize();
        g.position.set(cleanSnap(g.position.x), cleanSnap(g.position.y), cleanSnap(g.position.z));
        this.updateInstance(inst);
      });
      const p0 = sel[0].group.position.clone();
      this.alignToGrid(sel, grid);
      return { c, d: sel[0].group.position.clone().sub(p0) }; // (turning about c, then moving d, is turning about c + (d + q d) / 2)
    };
    const ids = new Set(sel.map((i) => i.id));
    const welds = () => { const index = this.slotIndex(ids); return sel.reduce((s, i) => s + this.connectedSlots(i, index).size, 0); };
    const last = this.turnPivot, middle = this.selectionCenter(sel);
    const reuse = last && last.pose === pose() && Math.abs(last.axis.dot(n)) > 0.99;
    let r = turnAbout(reuse ? last.at.clone() : middle);
    if (reuse && q.angleTo(last.q) < 1e-3) { // (the same way again)
      const w = welds();
      r = turnAbout(middle);
      if (welds() <= w) r = turnAbout(last.at.clone());
    }
    const { c, d } = r;
    this.turnPivot = Math.abs(d.dot(n)) < 1e-6 ? { axis: n.clone(), q: q.clone(), at: c.clone().add(d.clone().add(d.clone().applyQuaternion(q)).multiplyScalar(0.5)), pose: pose() } : null;
    for (const [inst, twin] of twins) if (!this.onPlane(inst)) this.matchTwin(inst, twin);
    this.showSelection();
    this.commitEdit([...sel, ...twins.map(([, t]) => t)], before, 'turn it');
  }

  // Mirrors the selection left/right (across the build's X axis) in place.
  toggleMirror() {
    if (!this.placing && this.busy) return; // (a part still being picked up: the selected one was mirrored instead)
    if (this.placing) { this.placing.mirrored = !this.placing.mirrored; this.updatePlacement(); return; }
    const sel = this.selection();
    if (!sel.length) return;
    const twins = this.selectionTwins();
    const before = this.overlapsOf([...sel, ...twins.map(([, t]) => t)]);
    const cx = this.selectionCenter(sel).x;
    for (const inst of sel) {
      const g = inst.group;
      g.position.x = cleanSnap(2 * cx - g.position.x);
      g.quaternion.set(g.quaternion.x, -g.quaternion.y, -g.quaternion.z, g.quaternion.w);
      inst.mirrored = !inst.mirrored;
      g.scale.x = inst.mirrored ? -1 : 1;
      this.updateInstance(inst);
    }
    for (const [inst, twin] of twins) if (!this.onPlane(inst)) this.matchTwin(inst, twin);
    this.showSelection();
    this.commitEdit([...sel, ...twins.map(([, t]) => t)], before, 'mirror it');
  }

  // A mirrored copy of each selected part on the other side of the mirror plane (the middle of the
  // cabin, as Symmetry's), for a side built without Symmetry. A part on the plane, one whose copy is
  // there already, a cabin or engine (onePerVehicle, under the garage's limits) and a copy that would
  // overlap a part get none; the status line says what was made and what not. One undo step.
  async mirrorToOtherSide() {
    if (this.placing || this.busy) return;
    const sel = this.selection();
    if (!sel.length) { this.status('Select the parts to copy to the other side first'); return; }
    const todo = [], skip = { plane: 0, there: 0, one: 0, overlap: 0 };
    for (const inst of sel) {
      if (this.onPlane(inst)) skip.plane++;
      else if (this.twinOf(inst)) skip.there++;
      else todo.push(inst);
    }
    const allowed = todo.filter((inst) => this.noLimits || !this.onePerVehicle(inst.path) || !this.rules([{ path: inst.path }])); // (a second cabin / engine only with No limits)
    skip.one = todo.length - allowed.length;
    const why = allowed.length ? this.rules(allowed.map((i) => ({ path: i.path }))) : null;
    if (why) { this.status(why); return; }
    this.busy = true;
    const made = [];
    try {
      for (const inst of allowed) {
        const tw = this.twinTransform(inst.group.position, inst.group.quaternion, inst.mirrored);
        const copy = await this.createInstance({ path: inst.path, skin: inst.skin, st: inst.st, paint: inst.paint, position: tw.position.toArray(), quaternion: tw.quaternion.toArray(), mirrored: tw.mirrored });
        if (!this.noLimits && this.instances.some((o) => o !== copy && partsOverlap(copy.hulls, o.hulls))) { this.removeInstance(copy); skip.overlap++; continue; }
        made.push(copy);
      }
    } finally {
      this.busy = false;
    }
    if (made.length) {
      this.setSelection(made.map((i) => i.id));
      this.commit();
    }
    const one = (n, a, b) => tr(n === 1 ? a : b, { n });
    const left = [skip.there && one(skip.there, '{n} has its copy there already', '{n} have their copies there already'), skip.plane && one(skip.plane, '{n} lies on the mirror plane', '{n} lie on the mirror plane'),
      skip.one && tr("{n} can't have a second (one cabin, one engine)", { n: skip.one }), skip.overlap && one(skip.overlap, '{n} would overlap a part', '{n} would overlap parts')].filter(Boolean);
    const head = made.length ? one(made.length, 'Mirrored {n} part to the other side', 'Mirrored {n} parts to the other side') : tr('Nothing mirrored');
    this.status(`${head}${left.length ? tr(' ({list})', { list: left.join(tr(', ')) }) : ''}`);
    this.onChange();
  }

  // The pairs of parts that overlap, of the given parts with each other and with the rest.
  overlapsOf(parts) {
    const edited = new Set(parts.filter(Boolean)), out = new Set();
    const list = [...edited], others = this.instances.filter((i) => !edited.has(i));
    list.forEach((a, k) => {
      for (const b of others) if (partsOverlap(a.hulls, b.hulls)) out.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
      for (const b of list.slice(k + 1)) if (partsOverlap(a.hulls, b.hulls)) out.add(a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);
    });
    return out;
  }

  // In-place edits (a turn, a mirror, the handles, typed coordinates) are committed, and when the
  // edited parts (and the twins that followed) now overlap a part they did not overlap before
  // (before: overlapsOf them ahead of the edit), the status line says so: placing refuses an
  // overlap, but a part turned in place is often moved clear next (and Ctrl+Z takes it back).
  commitEdit(parts, before, what) {
    const after = this.overlapsOf(parts);
    this.commit();
    const fresh = this.noLimits ? 0 : [...after].filter((k) => !before.has(k)).length;
    if (fresh) this.status(`Careful: after that ${what.replace(/ it$/, '')} it overlaps ${fresh > 1 ? `${fresh} other parts` : 'another part'} (move it clear, or Ctrl+Z)`);
    return !fresh;
  }

  async setSymmetry(on) {
    this.symmetry = on;
    const p = this.placing;
    if (!on && p?.hiddenTwins?.length) { // (a move's twins stepped aside to follow it: now they stay, seen and in the way)
      for (const id of p.hiddenTwins) { const i = this.get(id); if (i) i.group.visible = true; }
      p.hiddenTwins = [];
      p.twinId = null;
      if (p.twinPairs) p.twinPairs = [];
    }
    this.symPlane.visible = on && this.v.mode === 'build';
    this.updateSymPlane();
    await this.syncTwin();
    this.showSelection();
    if (this.placing) this.updatePlacement(); // (showSelection redraws the weld points without the held part's)
    this.onChange();
  }

  // The mirror plane for Symmetry runs through the middle of the cabin (snapped to the 0.15 m
  // lattice), so a vehicle whose base is an odd number of cells wide is symmetric too; without a
  // cabin it is x = 0.
  mirrorX() {
    const cab = this.instances.find((i) => this.isCabin(i.path));
    return cab ? snap((cab.box.min.x + cab.box.max.x) / 2, HALF) : 0;
  }

  // With Symmetry on, edits to a part also apply to its mirror twin, like in the game's garage.
  // The twin is the same model at the mirrored spot with the mirrored turn; a part lying across
  // the mirror plane (its middle on it) is its own mirror image and has none.
  twinOf(inst) {
    if (!inst || this.onPlane(inst)) return null;
    const tw = this.twinTransform(inst.group.position, inst.group.quaternion, inst.mirrored);
    return this.instances.find((o) => o !== inst && o.path === inst.path && o.mirrored === tw.mirrored &&
      o.group.position.distanceTo(tw.position) < 0.01 && Math.abs(o.group.quaternion.dot(tw.quaternion)) > 0.9999) || null;
  }

  // A part whose middle lies on the mirror plane: its own mirror image. Edits that bring a part there
  // leave its twin where it was (matchTwin would put it inside the part).
  onPlane(inst) { return Math.abs((inst.box.min.x + inst.box.max.x) / 2 - this.mirrorX()) < 0.01; }

  // [part, twin] for each selected part whose mirror twin is not selected itself (Symmetry on):
  // edits to the part are repeated, mirrored, on the twin.
  selectionTwins() {
    if (!this.symmetry) return [];
    const out = [];
    for (const inst of this.selection()) {
      const t = this.twinOf(inst);
      if (t && !this.isSelected(t.id) && !out.some(([, o]) => o === t)) out.push([inst, t]);
    }
    return out;
  }

  // The primary part's twin (when it has one that follows it).
  editTwin() { return this.selectionTwins().find(([i]) => i.id === this.selected)?.[1] || null; }

  // Puts twin at the mirror image of inst.
  matchTwin(inst, twin) {
    if (!inst || !twin || twin === inst || !this.get(twin.id)) return;
    const tw = this.twinTransform(inst.group.position, inst.group.quaternion, inst.mirrored);
    twin.group.position.copy(tw.position);
    twin.group.quaternion.copy(tw.quaternion);
    twin.mirrored = tw.mirrored;
    twin.group.scale.x = tw.mirrored ? -1 : 1;
    this.updateInstance(twin);
  }

  // Ghost position for the current pointer: snap onto a slot of the part under the cursor,
  // or onto the ground grid. When the part's current rotation has no slot facing the surface,
  // the closest of the 24 grid rotations that has one is used instead (the user's own rotation
  // is kept for the next placement).
  updatePlacement() {
    const p = this.placing;
    if (!p || !this.lastPointer) return;
    const rc = this.v.raycaster;
    rc.setFromCamera(this.v.ndc(this.lastPointer), this.v.camera);
    const moving = new Set(p.moveIds);
    const targets = this.instances.filter((i) => !moving.has(i.id) && i.group.visible).map((i) => i.group);
    const hits = rc.intersectObjects(targets, true).filter((h) => h.object.isMesh && h.face), hit = hits[0];
    const S = new THREE.Vector3(p.mirrored ? -1 : 1, 1, 1);
    let q = p.quat;
    let pos = null, snapped = false, onPart = null, kept = null, away = null;
    const frame = (quat) => {
      const A = new THREE.Matrix4().compose(new THREE.Vector3(), quat, S);
      const box = p.ghost.userData.box.clone().applyMatrix4(A);
      const slots = p.ghost.userData.slots.map((s) => ({ pos: s.pos.clone().applyMatrix4(A), normal: s.normal.clone().transformDirection(A), ring: s.ring, lift: s.lift }));
      return { A, box, center: box.getCenter(new THREE.Vector3()), slots };
    };
    let F = frame(q);
    this.lastHit = null;
    if (hit) {
      let inst = this.instanceOfObject(hit.object), P = hit.point.clone(), N = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      // the first part along the ray with weld points to lay it on near the cursor: one in front without
      // any there (a gun) gives way to the next part behind it (its own far faces passed over)
      let s = this.pickSnap(P, N, rc.ray.direction, moving, F, frame, S);
      for (let k = 1, from = inst; !s && !p.refused && k < hits.length && k < 12; k++) {
        const h = hits[k], other = this.instanceOfObject(h.object);
        if (!other || other === from || h.distance - hit.distance > 4) continue;
        from = other;
        const Nk = h.face.normal.clone().transformDirection(h.object.matrixWorld);
        s = this.pickSnap(h.point.clone(), Nk, rc.ray.direction, moving, F, frame, S);
        if (s) { inst = other; P = h.point.clone(); N = Nk; }
      }
      s = s || this.keptSnap(hit.point, null, frame);
      onPart = inst;
      this.lastHit = P.clone();
      if (s) {
        ({ pos, q, F } = s);
        snapped = true;
      } else { // no weld point to lay it on near the cursor: against the surface, on the grid
        const NT = axisAlign(N);
        const pos0 = P.clone().sub(F.center);
        let mn = Infinity;
        for (const k of boxCorners(F.box)) mn = Math.min(mn, k.dot(NT));
        pos = pos0.addScaledVector(NT, P.dot(NT) - mn - pos0.dot(NT));
        // (off the surface, never into it: rounded the nearest way it went up to 7.5 cm in, and the grid's half
        // cell below too, so it showed red where it fits)
        const a = [0, 1, 2].find((k) => NT.getComponent(k) !== 0), out = pos.getComponent(a);
        pos.set(snap(pos.x, HALF), snap(pos.y, HALF), snap(pos.z, HALF));
        pos.setComponent(a, NT.getComponent(a) > 0 ? Math.ceil(out / HALF - 1e-4) * HALF : Math.floor(out / HALF + 1e-4) * HALF);
        away = { axis: a, dir: NT.getComponent(a) };
      }
    } else if ((kept = this.keptSnap(null, rc.ray, frame))) { // (just off the build's edge: it stays on)
      ({ pos, q, F } = kept);
      snapped = true;
    } else {
      const P = new THREE.Vector3();
      if (rc.ray.intersectPlane(this.ground, P)) {
        this.lastHit = P.clone();
        p.refused = false; // (off the vehicle: no face it was turned on any more, R spun it about the wall's)
        pos = new THREE.Vector3(snap(P.x - F.center.x, CELL), Math.ceil((-F.box.min.y - 1e-4) / HALF) * HALF, snap(P.z - F.center.z, CELL));
      } else { // over the sky: it stays where it is shown, but a turn, a mirror or a drop count (a second click
        // dropped a copy inside the part just dropped, and X mirrored the drop but not the ghost)
        if (!p.hasPos) return;
        const g = p.ghost;
        if (p.turnFx || p.effQuat) { q = p.turnFx ? p.quat : p.effQuat; F = frame(q); }
        const at = g.userData.box.clone().applyMatrix4(new THREE.Matrix4().compose(g.position, g.quaternion, g.scale)).getCenter(new THREE.Vector3());
        pos = at.sub(F.center); // (turned or mirrored about its middle)
        pos.set(snap(pos.x, HALF), snap(pos.y, HALF), snap(pos.z, HALF));
        snapped = !!p.snapped;
        onPart = p.onPart;
      }
    }
    if (!snapped) p.snap = null;
    if (!snapped) { // dropped on a bare surface or the ground: still onto the vehicle's grid (half a cell either way)
      if (p.grid === undefined) p.grid = Build.gridParity(this.instances.filter((i) => !moving.has(i.id) && i.group.visible).flatMap((i) => i.slotsWorld));
      const have = Build.gridParity(F.slots.map((s) => ({ pos: s.pos.clone().add(pos), normal: s.normal })));
      const toward = this.lastHit ? this.lastHit.clone().sub(F.center).sub(pos) : new THREE.Vector3();
      for (let k = 0; k < 3; k++) {
        if (p.grid[k] == null || have[k] == null || p.grid[k] === have[k]) continue;
        const dir = away?.axis === k ? away.dir : k === 1 ? 1 : Math.sign(toward.getComponent(k)) || 1; // never down into the ground, nor into the surface
        pos.setComponent(k, pos.getComponent(k) + dir * HALF);
      }
    }
    pos.set(cleanSnap(pos.x), cleanSnap(pos.y), cleanSnap(pos.z));
    p.effQuat = q.clone();
    const g = p.ghost;
    g.position.copy(pos);
    g.quaternion.copy(q);
    g.scale.copy(S);
    g.visible = true;
    g.updateMatrixWorld(true);
    if (p.turnFx) { p.turnFx.to = { pos: pos.clone(), q: q.clone() }; this.stepTurn(); } // (shown turning; the rest goes by where it ends)
    // Overlaps are judged like the game does, by the parts' collision hulls (a group: each member's);
    // welded parts only touch, so a few centimetres of contact are allowed.
    const others = this.instances.filter((i) => !moving.has(i.id) && i.group.visible);
    const held = this.heldHulls(g, new THREE.Matrix4().compose(pos, q, S));
    p.twinValid = true;
    if (p.twin) {
      const mx = this.mirrorX();
      const tw = this.twinTransform(pos, q, p.mirrored);
      p.twin.position.copy(tw.position);
      p.twin.quaternion.copy(tw.quaternion);
      p.twin.scale.set(tw.mirrored ? -1 : 1, 1, 1);
      p.twin.visible = Math.abs(pos.x + F.center.x - mx) > 0.01; // a part centred on the mirror plane has no twin
      if (p.twin.visible) { // the mirror copy must not overlap anything either (nor the part itself)
        const twinHulls = this.heldHulls(p.twin, new THREE.Matrix4().compose(tw.position, tw.quaternion, new THREE.Vector3(tw.mirrored ? -1 : 1, 1, 1)));
        p.twinValid = this.noLimits || (!partsOverlap(twinHulls, held) && !others.some((i) => partsOverlap(twinHulls, i.hulls)));
      }
      this.tint(p.twin, p.twinValid ? GHOST : GHOST_BAD);
    }
    // A moved part's twin steps aside while it is held, and follows it on the drop; one that can't
    // follow (its mirrored spot taken, or the part on the mirror plane) stays, and is in the way.
    const stays = p.twinId != null && this.symmetry && !(p.twin?.visible && p.twinValid) ? this.get(p.twinId) : null;
    p.valid = this.noLimits || (!others.some((i) => partsOverlap(held, i.hulls)) && !(stays && partsOverlap(held, stays.hulls)));
    p.hasPos = true;
    p.snapped = snapped;
    p.onPart = onPart;
    this.tint(g, p.valid ? GHOST : GHOST_BAD);
    this.showGhostWelds(F.slots.map((s) => ({ pos: s.pos.clone().add(pos), normal: s.normal, ring: s.ring, lift: s.lift })));
    this.updateOutlines();
    this.v.dirty = true;
  }

  // Where the held part snaps with the cursor at P on the build (the surface's normal N there), as the
  // garage does it. The face the cursor is on is the way the vehicle's weld points around it look (the
  // mesh's own slopes and bevels would flip it from cell to cell); the part's weld face is its points
  // looking back (in its own turn, else the smallest turn that has some), laid onto the vehicle's points
  // there at every placement where they meet. The cursor drags the weld face by its middle: the
  // placement whose face middle lies nearest it wins, a free one (no overlap) first if there is one
  // within SLIDE of the nearest, and the part stays where it is while that is within KEEP of the best.
  // Returns { pos, q, F } (F: frame() of the turn taken), or null: no weld points near the cursor.
  pickSnap(P, N, rayDir, moving, F0, frame, S) {
    const p = this.placing;
    p.refused = false;
    const live = this.instances.filter((i) => !moving.has(i.id) && i.group.visible);
    let NT = null, top = 0;
    const votes = new Map();
    for (const a of FACES) {
      if (-a.dot(rayDir) < 0.05) continue; // (a face turned away from the camera)
      let v = 0;
      for (const inst of live) for (const t of inst.slotsWorld) {
        if (t.normal.dot(a) < 0.9) continue;
        const d = t.pos.distanceTo(P);
        if (d < FACE_REACH) v += FACE_REACH - d;
      }
      v *= 0.5 + Math.max(0, a.dot(N)); // (the surface's own way counts too)
      votes.set(a, v);
      if (v > top) { top = v; NT = a; }
    }
    if (!NT) return null;
    if (p.snapFace && p.snapFace !== NT && (votes.get(p.snapFace) || 0) >= 0.5 * top) NT = p.snapFace; // (the face it was on, unless another counts twice as much)
    let q = p.quat, F = F0, face = F.slots.filter((t) => t.normal.dot(NT) < -0.9);
    if (!face.length && p.turnedOn === NT) { p.refused = true; return null; } // (turned this way on this face by the user: shown as turned, unwelded)
    if (!face.length) {
      for (const r of ROTATIONS) {
        const alt = r.clone().multiply(p.quat), fr = frame(alt), c = fr.slots.filter((t) => t.normal.dot(NT) < -0.9);
        if (c.length) { q = alt; F = fr; face = c; break; }
      }
      if (!face.length) return null;
    }
    const mid = face.reduce((a, t) => a.add(t.pos), new THREE.Vector3()).multiplyScalar(1 / face.length);
    let reach = 0;
    for (const t of face) reach = Math.max(reach, t.pos.distanceTo(mid));
    // the vehicle's points looking NT on (about) the cursor's surface, as far out as the face can reach
    const targets = [];
    for (const inst of live) for (const t of inst.slotsWorld) {
      if (t.normal.dot(NT) < 0.9) continue;
      const d = t.pos.clone().sub(P), along = d.dot(NT);
      if (Math.abs(along) <= 0.35 && d.addScaledVector(NT, -along).length() <= reach + SLIDE + CELL) targets.push(t);
    }
    if (!targets.length) return null;
    // every placement that lays a point of the face on one of them; how far its face middle is from the cursor
    const cands = new Map();
    for (const t of targets) for (const g of face) {
      const X = t.pos.clone().sub(g.pos);
      const key = `${Math.round(X.x / 0.05)},${Math.round(X.y / 0.05)},${Math.round(X.z / 0.05)}`;
      if (cands.has(key)) continue;
      const m = mid.clone().add(X).sub(P), along = m.dot(NT);
      cands.set(key, { key, X, d: m.addScaledVector(NT, -along).length() + 0.5 * Math.abs(along) });
    }
    const list = [...cands.values()].sort((a, b) => a.d - b.d);
    const known = new Map();
    const free = (c) => { // (no overlap with any other part's hulls: the parts whose boxes meet first)
      if (this.noLimits) return true; // (any spot will do)
      if (known.has(c.key)) return known.get(c.key);
      const box = F.box.clone().translate(c.X), held = this.heldHulls(p.ghost, new THREE.Matrix4().compose(c.X, q, S));
      const ok = !live.some((i) => i.box.intersectsBox(box) && partsOverlap(held, i.hulls));
      known.set(c.key, ok);
      return ok;
    };
    let pick = null;
    for (let k = 0; k < list.length && k < 32 && list[k].d <= list[0].d + SLIDE; k++) if (free(list[k])) { pick = list[k]; break; }
    pick = pick || list[0];
    const last = p.snap;
    if (last && last.face === NT && last.q.equals(q) && last.key !== pick.key) {
      const again = cands.get(last.key);
      if (again && again.d <= pick.d + KEEP && (free(again) || !free(pick))) pick = again;
    }
    p.snap = { key: pick.key, face: NT, q: q.clone(), X: pick.X.clone(), at: mid.clone().add(pick.X), base: p.quat.clone(), mirrored: p.mirrored, parts: live.length };
    p.snapFace = NT;
    return { pos: pick.X.clone(), q, F };
  }

  // The last snap, kept while the cursor is still about it: its point P within STICK of the snapped
  // weld face's middle, or (no surface under the cursor) its ray passing that near. Not after a turn, a
  // mirror or a change of the build.
  keptSnap(P, ray, frame) {
    const p = this.placing, last = p?.snap;
    if (!last?.at || !last.base.equals(p.quat) || last.mirrored !== p.mirrored || last.parts !== this.instances.filter((i) => i.group.visible).length) return null;
    if ((P ? P.distanceTo(last.at) : ray.distanceToPoint(last.at)) > STICK) return null;
    return { pos: last.X.clone(), q: last.q.clone(), F: frame(last.q) };
  }

  // Mirror image across the Symmetry plane (mirrorX()).
  twinTransform(position, quaternion, mirrored) {
    return {
      position: new THREE.Vector3(2 * this.mirrorX() - position.x, position.y, position.z),
      quaternion: new THREE.Quaternion(quaternion.x, -quaternion.y, -quaternion.z, quaternion.w),
      mirrored: !mirrored,
    };
  }

  // The held part's look: washed out towards the colour, see-through (the ghost materials).
  tint(group, color) {
    for (const m of group.userData.materials) {
      m.userData.xo.u.xoOverlay.value.set(color);
      m.userData.xo.u.xoOverlayAmt.value = color === GHOST ? 0.5 : 0.42;
    }
  }

  // Drops the held part(s), unless the game would refuse: overlapping another part, or past its
  // limits for new parts (rules: one cabin, one engine, 80 parts). Refused, the part stays on the
  // cursor and the status line says why. A mirror copy that would overlap is left out.
  // Returns true when something was placed or moved.
  async commitPlacing() {
    const p = this.placing;
    if (!p || !p.hasPos || this.committing) return false;
    this.finishTurn();
    if (!p.valid) { this.status("Can't place it there: it overlaps another part"); return false; }
    const moving = p.moveIds.length > 0;
    const twinShown = !!(p.twin && p.twin.visible && this.symmetry);
    const withTwin = twinShown && p.twinValid;
    if (!moving) {
      const adds = p.group ? p.members.map((m) => ({ path: m.path })) : [{ path: p.path }];
      const why = this.rules(withTwin ? [...adds, ...adds] : adds);
      if (why) { this.status(why); return false; }
    }
    const note = twinShown && !p.twinValid ? 'The mirrored copy was left out: it would overlap another part' : '';
    this.committing = true;
    try {
      if (p.group) {
        const placed = p.members.map((m, k) => ({ path: m.path, skin: m.skin, st: m.st, paint: m.paint, ...this.memberTransform(p.ghost, k) }));
        if (moving) { // the moved parts take their new places; twins outside the group follow
          this.cancelPlacing();
          const moved = p.moveIds.map((id) => this.get(id)).filter(Boolean);
          const before = moved.map((i) => this.transformState(i));
          p.moveIds.forEach((id, k) => {
            const inst = this.get(id);
            if (!inst) return;
            inst.group.position.fromArray(placed[k].position);
            inst.group.quaternion.fromArray(placed[k].quaternion);
            inst.mirrored = placed[k].mirrored;
            inst.group.scale.x = inst.mirrored ? -1 : 1;
            this.updateInstance(inst);
          });
          const twins = this.symmetry ? this.followTwins(p.twinPairs.map(([a, t]) => [this.get(a), this.get(t)])) : { stayed: [], undo: () => {} };
          // a twin that couldn't follow stays where it was: if the moved parts landed on it, the move is off
          if (!this.noLimits && twins.stayed.some((t) => moved.some((i) => partsOverlap(t.hulls, i.hulls)))) {
            twins.undo();
            moved.forEach((i, k) => this.restoreTransform(i, before[k]));
            this.setSelection(p.moveIds);
            this.status("Can't move them there: a mirror twin that can't follow would be in the way");
            this.commit();
            return false;
          }
          this.setSelection(p.moveIds);
          const kept = twins.stayed.length;
          if (kept) this.status(`${kept} mirror twin${kept > 1 ? 's' : ''} stayed where ${kept > 1 ? 'they were' : 'it was'}: the mirrored spot is taken`);
        } else { // copies (and their mirror twins); the copy stays on the cursor for more
          const twinPlaced = withTwin ? p.members.map((m, k) => ({ path: m.path, skin: m.skin, st: m.st, paint: m.paint, ...this.memberTransform(p.twin, k) })) : [];
          const made = [];
          for (const t of [...placed, ...twinPlaced]) made.push(await this.createInstance(t));
          this.lastPlaced = made[0]?.id ?? null;
          if (this.placing === p) p.dropped = true;
          if (note) this.status(note);
        }
        this.commit();
        if (this.placing) this.updatePlacement();
        return true;
      }
      const t = { path: p.path, skin: p.skin, st: p.st, paint: p.paint, position: p.ghost.position.toArray(), quaternion: (p.effQuat || p.quat).toArray(), mirrored: p.mirrored };
      if (p.moveId != null) {
        const inst = this.get(p.moveId), twin = this.symmetry ? this.get(p.twinId) : null;
        const tw = withTwin ? { position: p.twin.position.toArray(), quaternion: p.twin.quaternion.toArray() } : null;
        this.cancelPlacing();
        if (inst) {
          inst.group.position.fromArray(t.position);
          inst.group.quaternion.fromArray(t.quaternion);
          inst.mirrored = t.mirrored;
          inst.group.scale.x = t.mirrored ? -1 : 1;
          inst.group.visible = true;
          this.updateInstance(inst);
          if (twin && tw) { // the twin goes where its ghost showed (or stays put when that spot was taken)
            twin.group.position.fromArray(tw.position);
            twin.group.quaternion.fromArray(tw.quaternion);
            twin.mirrored = !t.mirrored;
            twin.group.scale.x = twin.mirrored ? -1 : 1;
            this.updateInstance(twin);
          }
          this.select(inst.id);
          if (twin && !tw) this.status('Its mirror twin stayed where it was: the mirrored spot is taken or on the mirror plane');
        }
      } else {
        const made = [await this.createInstance(t)];
        if (withTwin) made.push(await this.createInstance({ ...t, position: p.twin.position.toArray(), quaternion: p.twin.quaternion.toArray(), mirrored: !t.mirrored }));
        this.lastPlaced = made[0].id;
        if (this.placing === p) p.dropped = true; // (Ctrl+Z now undoes this drop)
        if (note) this.status(note);
      }
      this.commit();
      if (this.placing) this.updatePlacement();
      return true;
    } finally {
      this.committing = false;
    }
  }

  // Twins following moved parts across the mirror plane, all at once: one twin must not block
  // another that is about to move away. A twin whose mirrored spot is taken (by anything but the
  // other twins, which mirror a layout that already fits), or whose part now lies across the
  // plane, stays where it was. Returns { stayed: [twins], undo() } (undo puts every twin back).
  followTwins(pairs) {
    pairs = pairs.filter(([inst, twin]) => inst && twin);
    const twins = new Set(pairs.map(([, t]) => t));
    const old = pairs.map(([, t]) => this.transformState(t));
    for (const [inst, twin] of pairs) this.matchTwin(inst, twin);
    const stayed = [];
    pairs.forEach(([inst, twin], k) => {
      if (this.onPlane(inst) || (!this.noLimits && this.instances.some((o) => o !== twin && !twins.has(o) && o.group.visible && partsOverlap(twin.hulls, o.hulls)))) {
        this.restoreTransform(twin, old[k]);
        stayed.push(twin);
      }
    });
    // (a twin that stayed was passed over as "about to move away": one that followed may have landed on it)
    for (let changed = true; changed;) {
      changed = false;
      pairs.forEach(([, twin], k) => {
        if (this.noLimits || stayed.includes(twin) || !stayed.some((s) => partsOverlap(twin.hulls, s.hulls))) return;
        this.restoreTransform(twin, old[k]);
        stayed.push(twin);
        changed = true;
      });
    }
    return { stayed, undo: () => pairs.forEach(([, twin], k) => this.restoreTransform(twin, old[k])) };
  }

  transformState(inst) {
    return { pos: inst.group.position.clone(), q: inst.group.quaternion.clone(), mirrored: inst.mirrored };
  }

  restoreTransform(inst, s) {
    inst.group.position.copy(s.pos);
    inst.group.quaternion.copy(s.q);
    inst.mirrored = s.mirrored;
    inst.group.scale.x = s.mirrored ? -1 : 1;
    this.updateInstance(inst);
  }

  // Collision hulls of a held part, or of every member of a held group, for its matrix M. (A mirror
  // twin of a single part is the same model as the ghost.)
  heldHulls(container, M) {
    const ud = container.userData;
    if (ud.members) return ud.members.flatMap((m) => hullsAt(m.phys, M.clone().multiply(m.local), m.group.userData.box));
    return hullsAt(ud.phys ?? this.placing?.ghost.userData.phys, M, ud.box);
  }

  // ---- selection ------------------------------------------------------------------------------------
  instanceOfObject(o) {
    while (o && o.userData.instanceId == null) o = o.parent;
    return o ? this.get(o.userData.instanceId) : null;
  }

  instanceAt(e) {
    const rc = this.v.raycaster;
    rc.setFromCamera(this.v.ndc(e), this.v.camera);
    const hit = rc.intersectObjects(this.instances.filter((i) => i.group.visible).map((i) => i.group), true).find((h) => h.object.isMesh);
    return hit ? this.instanceOfObject(hit.object) : null;
  }

  // e: the pointer event (the part's name goes beside the cursor, as in the 3D Viewer and Maps)
  hover(inst, e = null) {
    if (inst !== this.hovered) { this.hovered = inst; this.v.dirty = true; this.onHover(inst); }
    this.updateOutlines();
    if (!inst) this.v.onHover(null);
    else if (e) {
      const r = this.v.canvas.getBoundingClientRect();
      this.v.onHover({ x: e.clientX - r.left, y: e.clientY - r.top, text: this.tipOf(inst) });
    }
  }

  // The garage's outlines: the selected parts orange (the primary one brighter) with the mirror
  // twins that follow them blue, the part under the cursor white; while placing, the held part
  // (red when it can't go there), its mirror twin and the part it lands on.
  updateOutlines() {
    const list = [];
    const p = this.placing;
    if (this.v.mode !== 'build') { /* nothing */ } else if (p) {
      if (p.hasPos && p.ghost.visible) list.push({ object: p.ghost, color: p.valid ? OUTLINE : OUTLINE_BAD });
      if (p.twin?.visible) list.push({ object: p.twin, color: p.twinValid ? OUTLINE : OUTLINE_BAD });
      if (p.hasPos && p.onPart && this.get(p.onPart.id)) list.push({ object: p.onPart.group, color: OUTLINE });
    } else {
      for (const inst of this.selection()) if (inst.group.visible) list.push({ object: inst.group, color: inst.id === this.selected ? OUTLINE_SEL : OUTLINE_SEL2 });
      for (const [, t] of this.selectionTwins()) if (t.group.visible) list.push({ object: t.group, color: OUTLINE_TWIN });
      if (this.hovered && this.hovered.group.visible && !this.isSelected(this.hovered.id)) list.push({ object: this.hovered.group, color: OUTLINE });
    }
    this.v.setOutlines(list);
  }

  setGizmoMode(mode) {
    this.gizmoMode = mode;
    this.attachGizmo();
    this.v.dirty = true;
  }

  // Gizmo drags move / turn the pivot; every selected part follows it (twins mirror it).
  beginDrag() {
    this.drag = {
      start: this.pivot.position.clone(),
      startQ: this.pivot.quaternion.clone(),
      members: this.selection().map((inst) => ({ inst, pos: inst.group.position.clone(), quat: inst.group.quaternion.clone() })),
      twins: this.selectionTwins(),
      grid: Build.gridParity(this.selection().flatMap((i) => i.slotsWorld)),
    };
    this.drag.twinStart = this.drag.twins.map(([, t]) => this.transformState(t)); // (a part dragged onto the mirror plane: its twin goes back)
    this.drag.before = this.overlapsOf([...this.drag.members.map((m) => m.inst), ...this.drag.twins.map(([, t]) => t)]);
  }

  dragUpdate() {
    const d = this.drag;
    if (!d) return;
    const move = this.pivot.position.clone().sub(d.start);
    move.set(snap(move.x, CELL), snap(move.y, CELL), snap(move.z, CELL)); // whole cells
    // 90° steps about one axis (the gizmo's snap); the free trackball and view ring could turn about
    // any axis, so the turn is snapped to the nearest of the 24 grid rotations
    const turn = nearestRotation(this.pivot.quaternion.clone().multiply(d.startQ.clone().invert()));
    for (const m of d.members) {
      const g = m.inst.group;
      g.position.copy(m.pos).sub(d.start).applyQuaternion(turn).add(d.start).add(move);
      g.quaternion.copy(turn).multiply(m.quat).normalize();
      this.updateInstance(m.inst);
    }
    if (this.gizmoMode === 'translate') this.pivot.position.copy(d.start).add(move); // the gizmo sits on the snapped spot
    this.followDrag(d);
    this.showSelection({ fast: true });
  }

  // The twins follow the dragged parts, but not onto the mirror plane: there a part has none, and its
  // twin stays where it was before the drag.
  followDrag(d) {
    d.twins.forEach(([inst, twin], k) => (this.onPlane(inst) ? this.restoreTransform(twin, d.twinStart[k]) : this.matchTwin(inst, twin)));
  }

  gizmoDone() {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    for (const m of d.members) {
      const g = m.inst.group;
      g.position.set(cleanSnap(g.position.x), cleanSnap(g.position.y), cleanSnap(g.position.z));
      this.updateInstance(m.inst);
    }
    if (d.members.some((m) => Math.abs(m.inst.group.quaternion.dot(m.quat)) < 0.9999)) this.alignToGrid(d.members.map((m) => m.inst), d.grid);
    this.followDrag(d);
    this.showSelection();
    this.commitEdit([...d.members.map((m) => m.inst), ...d.twins.map(([, t]) => t)], d.before, 'move it');
  }

  // The selected parts' outline (and the twins' that follow them, see updateOutlines), the gizmo
  // on the selection, and the selected parts' slots: green = attached to a neighbour, orange = free.
  // fast: skip the slot markers (while dragging).
  showSelection({ fast = false } = {}) {
    const sel = this.selection();
    this.updateOutlines();
    if (!this.drag && sel.length) this.placePivot();
    for (const c of [...this.slotMarks.children]) { this.slotMarks.remove(c); Viewer.disposeHelper(c); }
    if (!fast && sel.length && this.welds) {
      const index = this.slotIndex();
      const items = [];
      for (const inst of sel) {
        const joined = this.connectedSlots(inst, index);
        inst.slotsWorld.forEach((s, i) => items.push({ pos: s.pos, normal: s.normal, ring: s.ring, lift: s.lift, color: joined.has(i) ? Viewer.WELD.welded : Viewer.WELD.free }));
      }
      if (items.length) this.slotMarks.add(this.v.weldMarkers('slots', items));
    }
    if (!fast) this.showWelds();
    this.v.dirty = true;
  }

  // ---- the garage look: weld points, loose parts, floor ---------------------------------------------
  // Crossout's garage shows weld points as white see-through boxes and tints parts that are not
  // welded to the vehicle red. Here: the vehicle's free weld points (Weld points toggle; always
  // while a part is being placed), the selected parts' points (green where welded, drawn by
  // showSelection) and the ghost's points (bright green where they would weld).
  refreshWorld() {
    this.v.setStage(this.instances.length ? this.box() : null, 'build');
    this.markLoose();
    this.showWelds();
    this.updateSymPlane();
  }

  // Parts not welded to the cabin (as in the game) are tinted red; without a cabin, the ones
  // outside the biggest group of welded parts.
  markLoose() {
    const comps = this.instances.length > 1 ? this.components({ all: true }) : []; // (a commit while a part is held: Esc must not leave parts red)
    const main = comps.find((g) => g.some((i) => this.isCabin(i.path))) || comps[0];
    this.loose = new Set(comps.filter((g) => g !== main).flat().map((i) => i.id));
    for (const inst of this.instances) {
      const on = !this.noLimits && this.loose.has(inst.id); // (No limits: a part may float)
      for (const m of inst.group.userData.materials) {
        const u = m.userData.xo.u;
        if (on) u.xoOverlay.value.set(0xef5b5b);
        u.xoOverlayAmt.value = on ? 0.32 : 0;
      }
    }
    this.v.dirty = true;
  }

  showWelds() {
    for (const c of [...this.weldMarks.children]) { this.weldMarks.remove(c); Viewer.disposeHelper(c); }
    const p = this.placing;
    if (p) { p.weldMesh = p.mateMesh = p.vehicleWelds = null; p.covered = new Set(); p.grid = undefined; }
    if (this.welds || p) {
      const index = this.slotIndex(); // hidden parts (the ones being moved) are left out
      const shown = new Set(p ? [] : this.sel); // selected parts show their own points
      const items = [];
      for (const inst of this.instances) {
        if (!inst.group.visible || shown.has(inst.id)) continue;
        inst.slotsWorld.forEach((s, i) => { if (!this.mates(index, inst, s).length) items.push({ pos: s.pos, normal: s.normal, ring: s.ring, lift: s.lift, key: `${inst.id}:${i}` }); });
      }
      if (items.length) {
        const mesh = this.v.weldMarkers('welds', items);
        mesh.userData.keyIndex = new Map(items.map((it, i) => [it.key, i]));
        this.weldMarks.add(mesh);
        if (p) p.vehicleWelds = mesh;
      }
      if (p) p.index = index;
    }
    this.updateWheelMarks();
    this.v.dirty = true;
  }

  // Augmented reality on wheels, as in the garage: suspension springs, and the steering mark on
  // steering (ST) wheels. Parts being moved are left out.
  updateWheelMarks() {
    const on = this.welds && this.v.mode === 'build';
    const wheels = on ? this.instances.filter((i) => i.group.visible && isWheel(i.path)).map((inst) => ({ inst, steer: !!inst.st })) : [];
    this.wheelMarks.update(wheels, on).catch(() => {});
  }

  // While a part is held, as in the garage: the vehicle's weld points it would weld onto turn
  // orange (the white marker there steps aside), every other point stays white, and the held part
  // shows its own points that would stay free (white).
  showGhostWelds(slots) {
    const p = this.placing;
    if (!p) return;
    if (!p.index) p.index = this.slotIndex();
    const free = [], mates = [], covered = new Set();
    for (const s of slots) {
      const m = this.mates(p.index, null, s);
      if (!m.length) { free.push({ pos: s.pos, normal: s.normal, ring: s.ring, lift: s.lift }); continue; }
      for (const o of m) {
        const key = `${o.inst.id}:${o.i}`;
        if (covered.has(key)) continue;
        covered.add(key);
        mates.push({ pos: o.s.pos, normal: o.s.normal, ring: o.s.ring, lift: o.s.lift, key });
      }
    }
    const put = (field, name, items, kind) => {
      const mesh = this.v.weldMarkers(name, items, Viewer.WELD_SIZE, p[field], { kind });
      if (mesh !== p[field]) {
        if (p[field]) { this.weldMarks.remove(p[field]); Viewer.disposeHelper(p[field]); }
        p[field] = mesh;
        this.weldMarks.add(mesh);
      }
    };
    put('weldMesh', 'ghost-welds', free, 'free');
    put('mateMesh', 'mate-welds', mates, 'mate');
    const vm = p.vehicleWelds;
    if (vm) {
      for (const k of p.covered || []) if (!covered.has(k)) this.v.placeWeld(vm, vm.userData.keyIndex.get(k), true);
      for (const k of covered) if (!p.covered?.has(k)) this.v.placeWeld(vm, vm.userData.keyIndex.get(k), false);
    }
    p.covered = covered;
  }

  setWelds(on) {
    this.welds = on;
    this.showSelection();
    this.updateWheelMarks();
    if (this.placing) this.updatePlacement();
  }

  // ---- connections ------------------------------------------------------------------------------------
  // Slots are bucketed by 0.15 m lattice cell. Keys use the cell index (not a finer rounding,
  // which would put mating slots at 0.4499999 / 0.4500001 into different buckets), and lookups
  // also visit the neighbouring cells so the few off-lattice slots still find their partner.
  static cellKey(x, y, z) { return `${x},${y},${z}`; }
  static cellOf(p) { return [Math.round(p.x / HALF), Math.round(p.y / HALF), Math.round(p.z / HALF)]; }

  // exclude: ids of parts to leave out (besides the hidden ones being moved); all: the hidden ones too
  slotIndex(exclude = null, { all = false } = {}) {
    const map = new Map();
    for (const inst of this.instances) {
      if ((!all && !inst.group.visible) || exclude?.has(inst.id)) continue;
      inst.slotsWorld.forEach((s, i) => {
        const k = Build.cellKey(...Build.cellOf(s.pos));
        if (!map.has(k)) map.set(k, []);
        map.get(k).push({ inst, i, s });
      });
    }
    return map;
  }

  // Slots of other parts that mate with slot s: same spot (< 2 cm), facing the other way.
  mates(index, inst, s) {
    const [cx, cy, cz] = Build.cellOf(s.pos);
    const out = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++)
      for (const o of index.get(Build.cellKey(cx + dx, cy + dy, cz + dz)) || [])
        if (o.inst !== inst && o.s.pos.distanceTo(s.pos) < 0.02 && o.s.normal.dot(s.normal) < -0.9) out.push(o);
    return out;
  }

  connectedSlots(inst, index = this.slotIndex()) {
    const out = new Set();
    inst.slotsWorld.forEach((s, i) => { if (this.mates(index, inst, s).length) out.add(i); });
    return out;
  }

  // Groups of parts that are attached to each other (Crossout wants one group). Parts hidden while
  // they are being moved are left out (they are on the cursor, not loose); all: they count where they
  // were (what is attached does not change while a part is only held).
  components({ all = false } = {}) {
    const index = this.slotIndex(null, { all });
    const live = all ? this.instances : this.instances.filter((i) => i.group.visible);
    const parent = new Map(live.map((i) => [i.id, i.id]));
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const inst of live) {
      for (const s of inst.slotsWorld) for (const o of this.mates(index, inst, s)) parent.set(find(inst.id), find(o.inst.id));
    }
    const groups = new Map();
    for (const i of live) {
      const r = find(i.id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    return [...groups.values()].sort((a, b) => b.length - a.length);
  }

  // ---- edits ------------------------------------------------------------------------------------------
  async duplicateSelected() {
    const sel = this.selection();
    if (sel.length > 1) return this.startPlacingGroup(sel);
    const inst = sel[0];
    if (inst) await this.startPlacing(inst.path, inst.skin, { quaternion: inst.group.quaternion.toArray(), mirrored: inst.mirrored, st: inst.st, paint: inst.paint });
  }

  async moveSelected() {
    const sel = this.selection();
    if (sel.length > 1) return this.startPlacingGroup(sel, { move: true });
    const inst = sel[0];
    if (inst) await this.startPlacing(inst.path, inst.skin, { moveId: inst.id, twinId: this.editTwin()?.id ?? null });
  }

  deleteSelected() {
    const sel = this.selection();
    if (!sel.length) return;
    const twins = this.selectionTwins().map(([, t]) => t);
    this.setSelection([], { keepPlacing: true });
    for (const inst of [...sel, ...twins]) this.removeInstance(inst);
    const tw = twins.length ? (sel.length === 1 ? ' and its mirror twin' : ` and ${twins.length} mirror twin${twins.length > 1 ? 's' : ''}`) : '';
    this.status(sel.length === 1 ? `Deleted ${this.nameOf(sel[0].info)}${tw}` : `Deleted ${sel.length} parts${tw}`);
    this.commit();
  }

  // Puts part id at xyz (a coordinate that is not a number stays as it was). It moves by whole
  // 0.3 m cells, so it stays on the grid its weld points need. When it is selected, the rest of
  // the selection moves along with it.
  setPosition(id, xyz) {
    const inst = this.get(id);
    if (!inst) return;
    const cur = inst.group.position;
    const target = new THREE.Vector3(...xyz.map((v, k) => (Number.isFinite(v) ? v : cur.getComponent(k))));
    const d = target.sub(cur);
    d.set(snap(d.x, CELL), snap(d.y, CELL), snap(d.z, CELL));
    if (d.lengthSq() < 1e-10) { this.onChange(); return; } // (nothing to move: the boxes show the position again)
    const group = this.isSelected(id) ? this.selection() : [inst];
    const twins = this.isSelected(id) ? this.selectionTwins() : [];
    const before = this.overlapsOf([...group, ...twins.map(([, t]) => t)]);
    for (const m of group) {
      m.group.position.add(d);
      m.group.position.set(cleanSnap(m.group.position.x), cleanSnap(m.group.position.y), cleanSnap(m.group.position.z));
      this.updateInstance(m);
    }
    for (const [a, t] of twins) if (!this.onPlane(a)) this.matchTwin(a, t);
    this.showSelection();
    this.commitEdit([...group, ...twins.map(([, t]) => t)], before, 'move it');
  }

  // Skin for part id; when it is selected, for every selected part of the same model (and twins).
  // One change at a time: a second pick (arrow keys on the Skin list) while the first skin still
  // loads would replace a part already replaced (two copies with one id).
  setSkin(id, skin) {
    const run = (this.skinJob || Promise.resolve()).then(() => this.applySkin(id, skin));
    this.skinJob = run.catch(() => {});
    return run;
  }

  async applySkin(id, skin) {
    const inst = this.get(id);
    if (!inst) return;
    const targets = this.isSelected(id) ? this.selection().filter((i) => i.path === inst.path) : [inst];
    const twins = this.isSelected(id) ? this.selectionTwins().filter(([a]) => targets.includes(a)).map(([, t]) => t) : [];
    const change = [...targets, ...twins].filter((i) => i.skin !== skin);
    if (!change.length) return;
    const keep = [...this.sel];
    for (const i of change) { // the new skin loads first; only then does the old part go
      const t = this.transformOf(i);
      const fresh = await this.createInstance({ ...t, skin });
      if (!this.instances.includes(i)) { this.removeInstance(fresh); continue; } // (deleted or undone meanwhile)
      const at = this.instances.indexOf(i);
      this.removeInstance(i);
      this.instances.splice(this.instances.indexOf(fresh), 1);
      this.instances.splice(Math.min(at, this.instances.length), 0, fresh); // same place in the list
      fresh.id = i.id;
      fresh.group.userData.instanceId = i.id;
    }
    this.setSelection(keep);
    this.commit();
  }

  // Steering (the "ST" version of a wheel: same model, turns the car, less tonnage). Applies to
  // every selected part of the same model when id is selected (and to their twins).
  setSteering(id, on) {
    const inst = this.get(id);
    if (!inst) return;
    const targets = this.isSelected(id) ? this.selection().filter((i) => i.path === inst.path) : [inst];
    const twins = this.isSelected(id) ? this.selectionTwins().filter(([a]) => targets.includes(a)).map(([, t]) => t) : [];
    const change = [...targets, ...twins].filter((i) => i.st !== !!on);
    if (!change.length) return;
    for (const i of change) i.st = !!on;
    this.commit();
  }

  // ---- paint ----------------------------------------------------------------------------------------
  // The paint a part shows: its own, else the vehicle's (null: none).
  paintOf(inst) { return inst.paint ?? this.paint ?? null; }

  applyPaints(insts = this.instances) {
    for (const i of insts) this.v.setModelPaint(i.group, this.paintOf(i));
    this.v.dirty = true;
  }

  // The vehicle's paint (null: none). commit: an undo step (not while a slider is dragged). false: refused (a
  // build still loading).
  setVehiclePaint(p, { commit = true } = {}) {
    if (this.loadingNow) { this.status('The build is still loading'); return false; }
    this.paint = p ? normPaint(p) : null;
    if (this.paint?.kind === 'color') this.paintColor = this.paint.color.slice();
    this.applyPaints();
    if (commit) this.commit(); else this.onChange();
    return true;
  }

  // These parts' own paint (null: back to the vehicle's; amount 0: bare), and their mirror twins' with
  // Symmetry on.
  setPartsPaint(insts, p, { commit = true } = {}) {
    const all = new Set(insts);
    if (this.symmetry) for (const i of insts) { const t = this.twinOf(i); if (t) all.add(t); }
    const own = p ? normPaint(p) : null;
    for (const i of all) i.paint = own;
    this.applyPaints([...all]);
    if (commit) this.commit(); else this.onChange();
  }

  // Every part back to the vehicle's paint.
  clearPartPaints() {
    if (this.loadingNow) return 0;
    const own = this.instances.filter((i) => i.paint);
    if (!own.length) return 0;
    for (const i of own) i.paint = null;
    this.applyPaints(own);
    this.commit();
    return own.length;
  }

  // The brush: on (a click or a drag over parts paints them with p; amount 0 takes their paint off) or off.
  setBrush(on, p = this.brush) {
    this.brushOn = !!on;
    this.brush = p ? normPaint(p) : null;
    this.v.canvas.style.cursor = this.brushOn ? BRUSH_CURSOR : this.v.mode === 'build' ? 'crosshair' : '';
    if (!this.brushOn && this.stroke) this.endStroke();
  }

  strokePaint(inst) {
    const s = this.stroke;
    if (!inst || !s || s.done.has(inst.id)) return;
    const list = [inst];
    if (this.symmetry) { const t = this.twinOf(inst); if (t && !s.done.has(t.id)) list.push(t); }
    const own = this.brush ? normPaint(this.brush) : { kind: 'color', color: this.paintColor.slice(), amount: 0 };
    for (const i of list) { s.done.add(i.id); i.paint = own; }
    this.applyPaints(list);
  }

  endStroke() {
    const s = this.stroke;
    this.stroke = null;
    if (!s?.done.size) return;
    this.status(`Painted ${s.done.size} part${s.done.size > 1 ? 's' : ''}`);
    this.commit();
  }

  // ---- history (undo/redo) + persistence ---------------------------------------------------------------
  // (the build's name is not in it: a rename must not count as an edit, which cleared redo)
  snapshot() {
    return JSON.stringify({ parts: this.instances.map((i) => ({ id: i.id, ...this.transformOf(i) })), paint: this.paint });
  }

  commit() {
    const s = this.snapshot();
    if (this.history[this.history.length - 1] !== s) {
      this.history.push(s);
      if (this.history.length > 200) this.history.shift();
      this.future = [];
    }
    if (this.sel.length) this.showSelection();
    this.refreshWorld();
    this.onChange();
  }

  // (the build's name is not part of undo: a rename stays when edits are undone)
  async restore(s) {
    const data = JSON.parse(s);
    const want = new Map(data.parts.map((p) => [p.id, p]));
    const keep = [...this.sel], swapped = new Set(); // (a part of another skin comes back as a new one with its id: still selected)
    for (const inst of [...this.instances]) {
      const w = want.get(inst.id);
      if (!w || w.path !== inst.path || w.skin !== inst.skin) {
        if (w && this.isSelected(inst.id)) swapped.add(inst.id);
        this.removeInstance(inst);
      }
    }
    const left = [...this.sel]; // (a part picked while parts load stays picked)
    let missing = 0;
    for (const p of data.parts) {
      let inst = this.get(p.id);
      if (!inst) {
        try { inst = await this.createInstance(p); } catch { missing++; continue; } // (the game data changed: that part is gone)
      }
      inst.group.position.fromArray(p.position);
      inst.group.quaternion.fromArray(p.quaternion);
      inst.mirrored = !!p.mirrored;
      inst.st = !!p.st;
      inst.paint = p.paint ? normPaint(p.paint) : null;
      inst.group.scale.x = inst.mirrored ? -1 : 1;
      this.updateInstance(inst);
      const want = Array.isArray(p.stickers) ? p.stickers : [];
      if (JSON.stringify(want) !== JSON.stringify(inst.stickers || [])) { inst.stickers = want.map((s) => ({ ...s })); await this.drawStickers(inst); }
    }
    this.paint = data.paint ? normPaint(data.paint) : null;
    this.applyPaints();
    const order = new Map(data.parts.map((p, k) => [p.id, k])); // parts brought back keep their place in the list
    this.instances.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
    const same = this.sel.length === left.length && this.sel.every((id, k) => id === left[k]);
    const sel = same ? keep.filter((id) => this.get(id) && (this.sel.includes(id) || swapped.has(id))) : this.sel.filter((id) => this.get(id));
    if (sel.length !== this.sel.length || sel.some((id, k) => id !== this.sel[k])) this.setSelection(sel, { keepPlacing: true });
    this.showSelection();
    this.refreshWorld();
    this.onChange();
    if (missing) this.status(`${missing} part${missing > 1 ? 's' : ''} could not be brought back (no longer in the game data)`);
  }

  async undo() {
    if (this.loadingNow) return; // (a build is still loading)
    if (this.placing) { // (the copy left on the cursor after a drop goes away and the drop is undone; a move is only put back)
      const dropped = this.placing.dropped;
      this.cancelPlacing();
      if (!dropped) return;
    }
    if (this.history.length < 2 || this.restoring) return;
    this.restoring = true;
    try {
      this.future.push(this.history.pop());
      await this.restore(this.history[this.history.length - 1]);
    } finally { this.restoring = false; }
  }

  async redo() {
    if (this.loadingNow) return;
    if (this.placing) this.cancelPlacing();
    if (!this.future.length || this.restoring) return;
    this.restoring = true;
    try {
      const s = this.future.pop();
      this.history.push(s);
      await this.restore(s);
    } finally { this.restoring = false; }
  }

  serialize() {
    return {
      app: 'Grimcold', kind: 'build', version: 1, name: this.name,
      parts: this.instances.map((i) => { const t = this.transformOf(i); return { path: t.path, skin: t.skin, position: t.position, rotation: t.quaternion, mirrored: t.mirrored, ...(t.st ? { st: true } : {}), ...(t.paint ? { paint: paintForFile(t.paint) } : {}), ...(t.stickers ? { stickers: t.stickers } : {}) }; }),
      paint: this.paint ? paintForFile(this.paint) : { color: this.paintColor, amount: 0 },
    };
  }

  async clear() {
    this.loadGen = (this.loadGen || 0) + 1; // (a build still loading stops)
    this.loadingNow = false;
    this.cancelPlacing();
    this.select(null);
    for (const inst of [...this.instances]) this.removeInstance(inst);
    this.nextId = 1;
    this.paint = null; // (the last colour stays: the colour box keeps it)
    this.history = [this.snapshot()];
    this.future = [];
    this.v.collect();
    this.refreshWorld();
    this.onChange();
  }

  // data: serialize() output. Parts that cannot be loaded are skipped and reported. Resolves to null
  // when another load (or New) took over before this one finished: nothing of it stays.
  async load(data, { onProgress } = {}) {
    await this.clear();
    const gen = this.loadGen;
    this.loadingNow = true;
    try {
      this.unloaded = []; // (the previous build's: never mixed into this one, even half way)
      this.name = data.name || 'My build';
      this.loadPaint(data);
      const failed = [];
      let k = 0;
      for (const p of data.parts || []) {
        try {
          const inst = await this.createInstance({ path: p.path, skin: p.skin || '', position: p.position, quaternion: p.rotation || p.quaternion, mirrored: p.mirrored, st: p.st, paint: p.paint, stickers: p.stickers });
          if (gen !== this.loadGen) { this.removeInstance(inst); return null; }
        } catch (e) {
          if (gen !== this.loadGen) return null;
          failed.push({ part: p, error: e.message });
        }
        onProgress?.(++k, data.parts.length);
      }
      this.unloaded = failed.map((f) => f.part);
      this.history = [];
      this.future = [];
      this.commit();
      return failed;
    } finally {
      if (gen === this.loadGen) this.loadingNow = false;
    }
  }

  // The vehicle's paint of a build file (also one without parts). An old build's { color, amount } is a
  // colour; amount 0 is no paint, its colour kept for the colour box.
  loadPaint(data) {
    this.paint = data.paint?.amount > 0 ? normPaint(data.paint) : null;
    if (Array.isArray(data.paint?.color) && data.paint.color.length >= 3) this.paintColor = data.paint.color.slice(0, 3).map((v) => Math.min(1, Math.max(0, +v || 0)));
  }

  // For the exporter: every placed part with its world matrix (glTF space, column-major).
  exportItems({ onlySelected = false } = {}) {
    return (onlySelected && this.sel.length ? this.selection() : this.instances).map((i) => {
      i.group.updateMatrixWorld(true);
      const pose = i.group.userData.pose?.trs; // (the pose its meshes are shown in: the export bakes the same one)
      const paint = this.paintOf(i); // (as it shows: its own, else the vehicle's; the export bakes it in)
      return { path: i.path, skin: i.skin, st: !!i.st, name: i.info.name, matrix: i.group.matrixWorld.toArray().map((v) => Math.round(v * 1e6) / 1e6), ...(pose ? { pose } : {}), ...(paint ? { paint } : {}) };
    });
  }

  box() {
    const b = new THREE.Box3();
    for (const i of this.instances) b.union(i.box);
    return b;
  }

  frame(opts) { this.v.frameBox(this.instances.length ? this.box() : new THREE.Box3(new THREE.Vector3(-1.5, 0, -1.5), new THREE.Vector3(1.5, 1, 1.5)), opts); }

  stats() {
    let tris = 0;
    for (const i of this.instances) tris += i.group.userData.tris;
    const b = this.box();
    const size = b.isEmpty() ? [0, 0, 0] : b.getSize(new THREE.Vector3()).toArray();
    return { parts: this.instances.length, tris, size, groups: this.instances.length ? this.components({ all: true }).length : 0 };
  }

  onModeChanged() {
    const on = this.v.mode === 'build';
    this.v.canvas.style.cursor = on ? 'crosshair' : ''; // the garage's small cross
    if (on) this.attachGizmo(); else this.gizmo.detach(); // (attach/detach show and hide the handles)
    this.updateOutlines(); // (the selection's outline is the builder's only)
    this.symPlane.visible = on && this.symmetry;
    if (on) this.updateWheelMarks(); // (a build restored while the 3D Viewer was open has none yet)
    if (!on) { // nothing of the builder's pointer work survives a switch to the 3D Viewer
      this.cancelPlacing();
      this.hover(null);
      this.press = null;
      this.down = null;
      if (this.marquee) { this.marquee = null; this.marqueeEl.hidden = true; }
      this.v.hoverEnabled = true;
    }
  }

  // The Symmetry plane: on the mirror line, a little bigger than the vehicle.
  updateSymPlane() {
    const b = this.box();
    const s = b.isEmpty() ? 3 : Math.max(3, b.getSize(new THREE.Vector3()).length() * 1.2);
    this.symPlane.scale.set(s, s, 1);
    this.symPlane.position.set(this.mirrorX(), b.isEmpty() ? s / 2 - 0.5 : (b.min.y + b.max.y) / 2, b.isEmpty() ? 0 : (b.min.z + b.max.z) / 2);
    this.v.dirty = true;
  }
}