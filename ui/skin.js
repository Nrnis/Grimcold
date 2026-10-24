// The game's own UI kit: its buttons, frames, tabs, window headers, list rows and scrollbar thumb,
// cut out of the game's UI atlases (read from its archives like every other file, never written)
// and handed to app.css as CSS variables: --sp-<name>: url(blob:…). <html> gets the class "skin"
// once they are in; without the game (or before it is read) app.css draws look-alikes of its own.

const DATA = 'https://xo.data';

// [atlas texture, sprite name in the game's atlas file, our name, hidpi variant?]
// (the game keeps two of most buttons: a plain one, and a "hidpi" one drawn for twice the pixels,
// whose 9-slice keeps the side ears their shape at any height: those suit our small buttons)
const SPRITES = [
  ['ui/textures/ui_elements', 'ui_btn_normal', 'btn', true],
  ['ui/textures/ui_elements', 'ui_btn_hover', 'btn-hover', true],
  ['ui/textures/ui_elements', 'ui_btn_pressed', 'btn-pressed', true],
  ['ui/textures/ui_elements', 'ui_btn_preselect', 'btn-preselect', true],
  ['ui/textures/ui_elements', 'ui_btnflat_normal', 'flat', true],
  ['ui/textures/ui_elements', 'ui_btnflat_hover', 'flat-hover', true],
  ['ui/textures/ui_elements', 'ui_btnflat_pressed', 'flat-pressed', true],
  ['ui/textures/ui_elements', 'ui_btnflat_normal_1', 'flat1', true],
  ['ui/textures/ui_elements', 'ui_btnflat_hover_1', 'flat1-hover', true],
  ['ui/textures/ui_elements', 'ui_btnflat_pressed_1', 'flat1-pressed', true],
  ['ui/textures/ui_elements', 'ui_frame_normal', 'frame', false],
  ['ui/textures/ui_elements', 'ui_frame_hover', 'frame-hover', false],
  ['ui/textures/ui_elements', 'ui_frame_glow', 'frame-glow', false],
  ['ui/textures/ui_elements', 'ui_menuList_normal', 'row', false],
  ['ui/textures/ui_elements', 'ui_menuList_hover', 'row-hover', false],
  ['ui/textures/ui_elements', 'ui_windowheader', 'header', false],
  ['ui/textures/ui_elements', 'ui_dialogwindow', 'dialog', false],
  ['ui/textures/ui_elements', 'ui_scrollbar_thumb_normal', 'thumb', false],
  ['ui/textures/ui_elements', 'ui_scrollbar_thumb_hover', 'thumb-hover', false],
  ['ui/textures/ui_elements', 'ui_progressbar_bckg', 'progress', false],
  ['ui/textures/ui_elements', 'ui_divider_figure', 'divider', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'hangar_tab_default', 'tab', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'hangar_tab_hover', 'tab-hover', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'hangar_tab_select', 'tab-select', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'hangar_tab_short_select', 'tab-short-select', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'wizard_item_select', 'glow-select', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'bookmark_default', 'bookmark', false],
  ['ui/textures/main_hangar_tabs_bookmarks_new', 'bookmark_select', 'bookmark-select', false],
  ['ui/textures/play_button', 'hangar_testdrive_btn_idle', 'go', false],
  ['ui/textures/play_button', 'hangar_testdrive_btn_over', 'go-hover', false],
  ['ui/textures/play_button', 'addtogarage_button_idle', 'act', false],
  ['ui/textures/play_button', 'addtogarage_button_hover', 'act-hover', false],
  // the 2026 interface's own widgets: the arrow tabs of its filters (first, middle, last), its quiet
  // framed button
  ...['idle', 'over', 'pressed', 'checked'].flatMap((st) => ['left', 'both', 'right'].map((k) => ['ui/textures/ui/textures', `arrow_tab_${k}_${st}`, `arrow-${k}-${st}`, false])),
  ['ui/textures/cursors/cursor_ordinary', '*', 'cursor', false], // (a whole texture: the game's arrow)
  ['ui/textures/ui/textures', 'button_tertiary_idle', 'tert', false],
  ['ui/textures/ui/textures', 'button_tertiary_hover', 'tert-hover', false],
  ['ui/textures/ui/textures', 'button_tertiary_pressed', 'tert-pressed', false],
];
// the atlas files that describe where each sprite sits
// colour multipliers applied as a sprite is cut (the game tints these grey sprites itself)
const TINT = { header: [0.215, 0.25, 0.295] };
// sprites that also get a lit copy (--sp-<name>-lit), their hatching a solid white bar: the headers
// show it under the mouse (skin.css)
const LIT = { header: true };

// A tinted sprite's hatching, filled in solid white: the window header's slanted bar, rows broken by four
// or more short gaps (see-through runs of 1-3 px inside the band), from the first gap to the last one, in
// a block of four rows or more (the dotted strip under the rule, two rows, keeps its own look).
function dashes(p, w, h) {
  const keep = new Uint8Array(w * h), solid = (x, y) => p[(y * w + x) * 4 + 3] >= 64, span = new Array(h).fill(null);
  for (let y = 0; y < h; y++) {
    const gaps = [];
    for (let x = 0; x < w;) {
      if (solid(x, y)) { x++; continue; }
      const x0 = x;
      while (x < w && !solid(x, y)) x++;
      if (x - x0 <= 3 && x0 > 0 && x < w) gaps.push([x0, x]);
    }
    if (gaps.length >= 4) span[y] = [Math.max(0, gaps[0][0] - 1), Math.min(w - 1, gaps[gaps.length - 1][1])];
  }
  for (let y = 0; y < h;) {
    if (!span[y]) { y++; continue; }
    let y1 = y;
    while (y1 < h && span[y1]) y1++;
    if (y1 - y >= 4) for (let r = y; r < y1; r++) for (let x = span[r][0]; x <= span[r][1]; x++) keep[r * w + x] = 1;
    y = y1;
  }
  return keep;
}
const ATLAS_FILES = ['ui/textures/common/ui_elements.xml', 'ui/textures/common/main_hangar_tabs_bookmarks_new.xml', 'ui/textures/common/play_button.xml', 'ui/textures/common/ui.xml'];

let urls = [];

// Sliders filled up to their handle, as the game's are: each range input carries --p (0-100%),
// kept up when it is dragged, when code sets its value, and when one is added to the page.
function fillRange(el) {
  const min = +el.min || 0, max = el.max === '' ? 100 : +el.max, v = +el.value;
  el.style.setProperty('--p', `${max > min ? Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100)) : 0}%`);
}
export function initRanges() {
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    ...desc,
    set(v) { desc.set.call(this, v); if (this.type === 'range') fillRange(this); },
  });
  const num = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'valueAsNumber');
  Object.defineProperty(HTMLInputElement.prototype, 'valueAsNumber', {
    ...num,
    set(v) { num.set.call(this, v); if (this.type === 'range') fillRange(this); },
  });
  document.addEventListener('input', (e) => { if (e.target?.type === 'range') fillRange(e.target); }, true);
  const all = (root) => { for (const el of root.querySelectorAll?.('input[type=range]') || []) fillRange(el); };
  all(document);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes') { if (m.target.type === 'range') fillRange(m.target); continue; }
      for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.type === 'range') fillRange(n); else all(n); }
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'value'] });
}

// The sprites of the atlas files: { texture: { name: [{ x, y, w, h, hidpi }] } } (the files hold
// several <Atlas> roots one after another, so they are read as text, not as one XML document)
function parseAtlases(text, into) {
  for (const [, tex, body] of text.matchAll(/<Atlas\s+texture="([^"]+)"\s*>([\s\S]*?)<\/Atlas>/g)) {
    const sprites = (into[tex] ||= {});
    for (const [, attrs] of body.matchAll(/<Sprite\b([^>]*?)\/?>/g)) {
      const name = /name="([^"]+)"/.exec(attrs)?.[1], rect = /rect="([^"]+)"/.exec(attrs)?.[1];
      if (!name || !rect) continue;
      const [x, y, w, h] = rect.trim().split(/\s+/).map(Number);
      (sprites[name] ||= []).push({ x, y, w, h, hidpi: /hidpi="true"/.test(attrs) });
    }
  }
}

// a texture as raw pixels (no PNG made and read back: the host decodes it, the page cuts from it)
async function image(base) {
  const r = await fetch(`${DATA}/rgba?base=${encodeURIComponent(base)}`);
  if (!r.ok) throw new Error(`${base}: ${r.status}`);
  const buf = await r.arrayBuffer(), dv = new DataView(buf);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== 0x47524f58) throw new Error(`${base}: bad image data`);
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  return new ImageData(new Uint8ClampedArray(buf, 12, w * h * 4), w, h);
}

// The cut sprites are kept in the browser's storage per game version (the next start puts them on
// at once; a game update cuts them again).
const store = (() => {
  let db = null;
  const open = () => (db ||= new Promise((ok, no) => {
    const q = indexedDB.open('xo-skin', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('kits');
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  }));
  return {
    async get(k) { try { const d = await open(); return await new Promise((ok) => { const q = d.transaction('kits').objectStore('kits').get(k); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => ok(null); }); } catch { return null; } },
    async put(k, v) { try { (await open()).transaction('kits', 'readwrite').objectStore('kits').put(v, k); } catch { /* no storage: cut again next time */ } },
  };
})();
const KIT_VERSION = 8; // (bump when SPRITES, TINT or the cutting change)

function apply(blobs) {
  const root = document.documentElement, made = [];
  for (const [css, blob] of Object.entries(blobs)) {
    const url = URL.createObjectURL(blob);
    made.push(url);
    root.style.setProperty(`--sp-${css}`, `url("${url}")`);
  }
  for (const u of urls) URL.revokeObjectURL(u); // (a reload of the game: the old ones go)
  urls = made;
  const on = made.length >= SPRITES.length - 4; // (a game update that moved a few: still on, those fall back)
  root.classList.toggle('skin', on);
  return on;
}

// Reads the kit and sets the variables; resolves true when the skin is on (false: kept the look-alikes).
export async function loadSkin(gameVersion = '') {
  const key = `${KIT_VERSION}|${gameVersion}`;
  try {
    const kept = await store.get(key);
    if (kept && Object.keys(kept).length) return apply(kept);
    const atlases = {};
    await Promise.all(ATLAS_FILES.map(async (f) => {
      const r = await fetch(`${DATA}/raw?path=${encodeURIComponent(f)}`);
      if (r.ok) parseAtlases(await r.text(), atlases);
    }));
    const textures = [...new Set(SPRITES.map((s) => s[0]))];
    const images = Object.fromEntries(await Promise.all(textures.map(async (t) => [t, await image(t).catch(() => null)])));
    const blobs = {};
    for (const [tex, name, css, hidpi] of SPRITES) {
      const img = images[tex], list = name === '*' && img ? [{ x: 0, y: 0, w: img.width, h: img.height, hidpi: false }] : atlases[tex]?.[name];
      if (!img || !list?.length) continue;
      const s = list.find((v) => v.hidpi === hidpi) || list[0];
      if (s.w <= 0 || s.h <= 0 || s.x + s.w > img.width || s.y + s.h > img.height) continue;
      const c = document.createElement('canvas');
      c.width = s.w;
      c.height = s.h;
      const g2 = c.getContext('2d');
      g2.putImageData(img, -s.x, -s.y, s.x, s.y, s.w, s.h); // (just that sprite's pixels)
      if (TINT[css] || css.startsWith('arrow-')) {
        const d = g2.getImageData(0, 0, s.w, s.h), p = d.data, t = TINT[css];
        for (let i = 0; i < p.length; i += 4) {
          const r = p[i], g = p[i + 1], b = p[i + 2];
          if (t) { p[i] = r * t[0]; p[i + 1] = g * t[1]; p[i + 2] = b * t[2]; continue; }
          const k = Math.max(r, g, b) < 120 ? 1.15 : 1; // (sand -> slate, #ccffff -> cream)
          p[i] = Math.min(255, b * k); p[i + 1] = Math.min(255, g * k); p[i + 2] = Math.min(255, r * k);
        }
        g2.putImageData(d, 0, 0);
        if (LIT[css]) { // the lit copy: the same, its hatching a solid white bar
          const keep = dashes(p, s.w, s.h), lit = new ImageData(new Uint8ClampedArray(p), s.w, s.h);
          for (let k = 0; k < keep.length; k++) if (keep[k]) lit.data.fill(255, k * 4, k * 4 + 4);
          const c2 = document.createElement('canvas');
          c2.width = s.w;
          c2.height = s.h;
          c2.getContext('2d').putImageData(lit, 0, 0);
          const b2 = await new Promise((ok) => c2.toBlob(ok, 'image/png'));
          if (b2) blobs[`${css}-lit`] = b2;
        }
      }
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/png'));
      if (blob) blobs[css] = blob;
    }
    const on = apply(blobs);
    if (on && gameVersion) store.put(key, blobs);
    return on;
  } catch {
    document.documentElement.classList.remove('skin');
    return false;
  }
}
