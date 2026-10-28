// The Crossout garage around the Vehicle Builder: the energy bar over the vehicle, the card of the
// part under the cursor, the parts list with the vehicle's stats (H), the controls bar, and the
// garage's camera keys (W A S D move, Space up, Shift down).
//
// Icons are the game's own: plain SVG files in its archives (ui/textures/svg/...), read at run time
// through https://xo.data/raw, so nothing of the game is copied into this tool. Part stats come from
// stats.json, made from crosscalc.net's item table (the game keeps its own in encrypted files).
import * as THREE from 'three';
import { t as tr, typeLabel } from './i18n.js';

const DATA = 'https://xo.data';
const SVG = 'ui/textures/svg/';

// name -> path under ui/textures/svg (without .svg)
export const ICONS = {
  energy: 'icn_energy', health: 'icn_health', mass: 'icn_mass', speed: 'icn_speed', payload: 'icn_payload',
  parts: 'icn_object', steering: 'icn_steering',
  modules: 'module/icn_module_hardware', weapons: 'module/icn_module_weapon', cabin: 'module/icn_module_base',
  generator: 'module/moduleicon_generator', movement: 'module/icn_module_chassis', frame: 'module/icn_module_structure',
  structure: 'module/icn_module_structure', decor: 'module/moduleicon_decor',
  ar: 'build/icn_showar', lift: 'build/icn_carlifting', list: 'icn_object',
};
// key caps (the game's keyboard / mouse glyphs)
const KEYS = {
  space: 'control/control/icn_keyb_space_mid', shift: 'control/control/icn_keyb_shift_mid', ctrl: 'control/control/icn_keyb_control',
  del: 'control/control/icn_keyb_delete', esc: 'control/control/icn_keyb_escape', home: 'control/control/icn_keyb_home_mid',
  lmb: 'control/mouse/icn_mouse_1', rmb: 'control/mouse/icn_mouse_2',
};
const keyPath = (k) => KEYS[k] || `control/character/icn_keyb_${k}`;

const svgCache = new Map(); // path -> Promise<string | null>

// The game's SVG as markup to put inline: sized by CSS, scripts and event attributes dropped, and
// (mono) its white paint turned into currentColor so CSS can colour it.
function loadSvg(path, mono) {
  const key = `${path}|${mono ? 1 : 0}`;
  if (!svgCache.has(key)) {
    svgCache.set(key, (async () => {
      const r = await fetch(`${DATA}/raw?path=${encodeURIComponent(SVG + path + '.svg')}`);
      if (!r.ok) return null;
      const doc = new DOMParser().parseFromString(await r.text(), 'image/svg+xml');
      const svg = doc.documentElement;
      if (!svg || svg.nodeName !== 'svg') return null;
      for (const el of [...svg.querySelectorAll('script, foreignObject, title, desc, metadata')]) el.remove(); // (no text of its own: labels keep theirs)
      for (const el of [svg, ...svg.querySelectorAll('*')]) {
        for (const a of [...el.attributes]) {
          if (/^on/i.test(a.name) || /^(href|xlink:href)$/i.test(a.name)) el.removeAttribute(a.name);
          else if (mono && (a.name === 'fill' || a.name === 'stroke') && /^(white|#fff(fff)?)$/i.test(a.value)) el.setAttribute(a.name, 'currentColor');
        }
      }
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('aria-hidden', 'true');
      return svg.outerHTML;
    })().catch(() => null));
  }
  return svgCache.get(key);
}

// Fills every <i data-gi="name"> (icon) and <i data-key="w"> (key cap) under root.
export function hydrateIcons(root) {
  for (const el of root.querySelectorAll('[data-gi]:not([data-done]), [data-key]:not([data-done])')) {
    el.dataset.done = '1';
    const icon = el.dataset.gi;
    const p = icon ? loadSvg(ICONS[icon] || icon, true) : loadSvg(keyPath(el.dataset.key), false);
    p.then((svg) => { if (svg) el.innerHTML = svg; else el.textContent = icon ? '' : el.dataset.key.toUpperCase(); });
  }
}

// After the game folder changed: fetch the icons again (the ones that failed without game data too).
export function resetIcons(root) {
  svgCache.clear();
  for (const el of root.querySelectorAll('[data-done]')) delete el.dataset.done;
  hydrateIcons(root);
}

const gi = (name, cls = '') => `<i class="gi${cls ? ' ' + cls : ''}" data-gi="${name}"></i>`;
const keycap = (k) => `<i class="kc${KEYS[k] && /_mid|control$/.test(KEYS[k]) ? ' wide' : ''}" data-key="${k}"></i>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v));
const pct = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + (Math.round(Math.abs(v) * 10) / 10) + ' %';

// ---- part stats --------------------------------------------------------------------------------
export class PartStats {
  constructor() { this.items = {}; this.paths = {}; this.source = ''; }
  async load() {
    try {
      const d = await (await fetch('stats.json', { cache: 'no-store' })).json();
      this.items = d.items || {};
      this.paths = d.paths || {};
      this.source = d.source || '';
    } catch { /* no stats: the HUD shows what it can */ }
    return this;
  }
  // The item a model is (st: the steering version of a wheel, which uses the same model).
  item(path, st = false) {
    const n = this.paths[path];
    if (!n) return null;
    const name = st && this.items[n].st ? this.items[n].st : n;
    return { name, ...this.items[name] };
  }
  hasSteering(path) { const n = this.paths[path]; return !!(n && this.items[n].st); }
}

// Where a part sits in the parts list, like the game: armour ("structural parts") and decor apart.
export function section(path) {
  if (path.startsWith('models/constructor/structure/')) return 'structure';
  if (path.startsWith('models/constructor/decor/')) return 'decor';
  return 'parts';
}

export const PART_LIMIT = 80; // the most parts a vehicle can have (Engineers level 30 and up)

// The vehicle's numbers, as the garage shows them. parts: [{ path, st }].
//  energy: the cabin's energy plus generators', used by weapons and modules
//  durability: the cabin plus armour (structure parts add theirs, frames do not)
//  tonnage: the cabin's plus what movement parts and engines add, up to the mass limit; above it
//           the vehicle loses speed and acceleration
//  speed: the cabin's top speed (engines add), capped by the slowest movement part (hovers, legs...)
export function vehicleStats(parts, stats) {
  const v = {
    parts: parts.length, cabins: [], unknown: 0, unknownArmour: 0, hpArmour: 0, mass: 0,
    energy: { cabin: 0, generators: 0, nGenerators: 0, weapons: 0, modules: 0 },
    tonnageAdd: 0, massLimitAdd: 0, speedMul: 0, speedLimitMul: 0, limits: [], engines: 0,
  };
  for (const p of parts) {
    const it = stats.item(p.path, p.st);
    if (!it) {
      v.unknown++;
      if (section(p.path) === 'structure') v.unknownArmour++;
      continue;
    }
    v.mass += it.mass || 0;
    switch (it.kind) {
      case 'cabin': v.cabins.push(it); break;
      case 'generator': v.energy.generators += it.power || 0; v.energy.nGenerators++; break;
      case 'weapon': v.energy.weapons += it.cost || 0; break;
      case 'module': v.energy.modules += it.cost || 0; break;
      case 'structure': v.hpArmour += it.hp || 0; break;
      default: break;
    }
    if (it.type === 'Engine' && ++v.engines > 1) continue; // a vehicle has one engine: only the first one counts
    if (it.kind !== 'cabin') {
      v.tonnageAdd += it.tonnageAdd || 0;
      v.massLimitAdd += it.massLimitAdd || 0;
      v.speedMul += it.speedMul || 0;
      v.speedLimitMul += it.speedLimitMul || 0;
      if (it.kind === 'movement' && it.speedLimit) v.limits.push(it.speedLimit);
    }
  }
  const cab = v.cabins[0] || null;
  const e = v.energy;
  e.cabin = cab?.power || 0;
  e.supply = e.cabin + e.generators;
  e.used = e.weapons + e.modules;
  e.free = e.supply - e.used;
  v.cabin = cab;
  v.durability = cab ? cab.hp + v.hpArmour : null;
  v.massLimit = cab ? cab.massLimit + v.massLimitAdd : null;
  v.tonnage = cab ? Math.min(v.massLimit, cab.tonnage + v.tonnageAdd) : null;
  const top = cab ? cab.speed * (1 + v.speedMul / 100) : null;
  const cap = v.limits.length ? Math.min(...v.limits) * (1 + v.speedLimitMul / 100) : Infinity;
  v.speed = cab ? Math.min(top, cap) : null;
  v.speedCapped = cab ? cap < top : false;
  v.overloaded = !!cab && v.mass > v.tonnage;
  v.tooHeavy = !!cab && v.mass > v.massLimit;
  return v;
}

// ---- HUD pieces (HTML) ---------------------------------------------------------------------------
// The energy bar at the top of the garage: modules' and weapons' use, the free energy, the cabin's
// and the generators' supply.
// limits false (No limits): the free energy is not shown red when it runs short.
export function energyBarHtml(v, { limits = true } = {}) {
  const e = v.energy;
  const cell = (icon, value, cls, tip, big = false) => `<div class="eb-cell ${cls}${big ? ' big' : ''}" title="${esc(tip)}">${gi(icon)}<b>${value}</b></div>`;
  return [
    cell('modules', e.modules ? signed(-e.modules) : '0', e.modules ? 'neg' : 'zero', `Modules use ${e.modules} energy`),
    cell('weapons', e.weapons ? signed(-e.weapons) : '0', e.weapons ? 'neg' : 'zero', `Weapons use ${e.weapons} energy`),
    cell('energy', e.free > 0 ? '+' + fmt(e.free) : e.free < 0 ? signed(e.free) : '0', e.free > 0 ? 'pos' : e.free < 0 && limits ? 'neg' : 'zero',
      e.free >= 0 ? `Free energy: ${e.free} of ${e.supply}` : `Not enough energy: ${e.used} needed, ${e.supply} available`, true),
    cell('cabin', v.cabin ? '+' + fmt(e.cabin) : '—', v.cabin ? 'pos' : 'zero', v.cabin ? `The cabin gives ${e.cabin} energy` : 'No cabin yet'),
    cell('generator', e.nGenerators ? '+' + fmt(e.generators) : '', e.nGenerators ? 'pos' : 'off', e.nGenerators ? `Generators give ${e.generators} energy` : 'No generator'),
  ].join('');
}

// The vehicle's stats column (parts list, builder panel). limits false (No limits): nothing red for
// going past the game's limits (parts, energy, mass limit).
export function vehicleStatsHtml(v, { limits = true } = {}) {
  const row = (icon, value, label, cls = '', tip = '') => `<div class="vs-row ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${gi(icon)}<div><b>${value}</b><span>${tr(label)}</span></div></div>`;
  const out = [];
  const armourNote = v.unknownArmour ? ` (${v.unknownArmour} armour part${v.unknownArmour > 1 ? 's' : ''} not counted: no stats for them yet)` : '';
  out.push(row('health', v.durability != null ? `${fmt(v.durability)} pts` : '—', 'Durability', '',
    v.cabin ? `The cabin's durability plus what armour adds (frames add none)${armourNote}` : 'A vehicle needs a cabin'));
  out.push(row('parts', `${v.parts}/${PART_LIMIT}`, 'Total parts', limits && v.parts > PART_LIMIT ? 'bad' : '', `${PART_LIMIT} parts is the most a vehicle can have (Engineers level 30 and up)`));
  const e = v.energy;
  out.push(row('energy', `${e.used}/${e.supply} pts`, 'Energy', limits && e.used > e.supply ? 'bad' : '', `Weapons ${e.weapons} + modules ${e.modules} of cabin ${e.cabin} + generators ${e.generators}`));
  const massTip = v.unknown ? `${v.unknown} part${v.unknown > 1 ? 's have' : ' has'} no stats yet and ${v.unknown > 1 ? 'are' : 'is'} left out` : '';
  out.push(row('mass', `${fmt(v.mass)}${v.unknown ? '+' : ''}${v.massLimit != null ? (v.unknown ? ' / ' : '/') + fmt(v.massLimit) : ''} kg`, 'Mass', limits && v.tooHeavy ? 'bad' : '',
    [v.massLimit != null ? `Mass limit ${fmt(v.massLimit)} kg: a heavier vehicle cannot go into battle` : '', massTip].filter(Boolean).join('. ')));
  out.push('<div class="vs-head">' + tr('When driving') + '</div>');
  out.push(row('speed', v.speed != null ? `${fmt(v.speed)} km/h` : '—', v.speedCapped ? 'Top speed (slowest movement part)' : 'Top speed', '',
    v.overloaded ? 'Slower in practice: the vehicle is heavier than its tonnage' : 'Without overload'));
  if (v.tonnage != null) {
    const f = Math.min(1, v.mass / v.tonnage), over = v.overloaded;
    out.push(`<div class="vs-row vs-bar${over ? ' warn' : ''}" title="${esc(`Mass ${fmt(v.mass)} kg of ${fmt(v.tonnage)} kg tonnage${over ? ': overloaded, the vehicle loses speed and acceleration' : ''}`)}">${gi('payload')}<div><b>${esc(tr('Tonnage'))}</b>
      <span class="bar"><span style="width:${(f * 100).toFixed(1)}%"></span></span><span>${fmt(v.mass)} / ${fmt(v.tonnage)} kg${over ? ' · ' + esc(tr('overloaded')) : ''}</span></div></div>`);
  }
  const notes = [];
  if (!v.cabin && v.parts) notes.push(tr('No cabin: the energy, tonnage and speed come from the cabin.'));
  if (v.cabins.length > 1) notes.push(tr(limits ? '{n} cabins: a vehicle has one; the first one counts.' : '{n} cabins: the first one counts.', { n: v.cabins.length }));
  if (v.engines > 1) notes.push(tr(limits ? '{n} engines: a vehicle has one; the first one counts.' : '{n} engines: the first one counts.', { n: v.engines }));
  if (v.unknown) {
    notes.push(tr(v.unknownArmour
      ? (v.unknown > 1 ? 'No stats yet for {n} parts (armour and other parts this tool has no in-game name for): the mass and durability leave them out.'
        : 'No stats yet for {n} part (armour and other parts this tool has no in-game name for): the mass and durability leave it out.')
      : (v.unknown > 1 ? 'No stats yet for {n} parts (parts this tool has no in-game name for): the mass leaves them out.'
        : 'No stats yet for {n} part (parts this tool has no in-game name for): the mass leaves it out.'), { n: v.unknown }));
  }
  if (notes.length) out.push(`<div class="vs-note">${notes.map(esc).join('<br>')}</div>`);
  return out.join('');
}

const KIND_ICON = { cabin: 'cabin', weapon: 'weapons', module: 'modules', generator: 'generator', movement: 'movement', frame: 'frame', structure: 'structure' };
export const kindIcon = (it, path) => KIND_ICON[it?.kind] || (section(path) === 'decor' ? 'decor' : section(path) === 'structure' ? 'structure' : 'frame');

// The card of one part (under the cursor, or on it while placing), like the garage's tooltip.
export function partCardHtml(name, path, it, { st = false } = {}) {
  const rows = [];
  const add = (label, value) => rows.push(`<div class="pc-row"><span>${esc(tr(label))}</span><b>${value}</b></div>`);
  if (it) {
    if (it.kind === 'cabin') {
      add('Max. cabin speed', `${fmt(it.speed)} <small>km/h</small>`);
      add('Tonnage', `${fmt(it.tonnage)} <small>kg</small>`);
      add('Mass limit', `${fmt(it.massLimit)} <small>kg</small>`);
      add('Adds energy', `${fmt(it.power)} <small>pts</small>`);
      if (it.enginePower) add('Cabin power', `${fmt(it.enginePower)} <small>hp</small>`);
    }
    if (it.kind === 'generator') add('Adds energy', `${fmt(it.power)} <small>pts</small>`);
    if (it.cost) add('Uses energy', `${fmt(it.cost)} <small>pts</small>`);
    if (it.reload) add('Reload time', `${it.reload} <small>s</small>`);
    if (it.tonnageAdd) add('Tonnage', `${signed(it.tonnageAdd)} <small>kg</small>`);
    if (it.massLimitAdd) add('Mass limit', `${signed(it.massLimitAdd)} <small>kg</small>`);
    if (it.speedMul) add('Max. cabin speed', pct(it.speedMul));
    if (it.speedLimit) add('Max. speed', `${fmt(it.speedLimit)} <small>km/h</small>`);
    if (it.speedLimitMul) add('Speed limit', pct(it.speedLimitMul));
    if (it.powerMul) add('Cabin power', pct(it.powerMul));
  }
  const type = it ? typeLabel(it.type) + (st ? tr(' · steering') : '') : '';
  return `<div class="pc-head r-${esc(it?.rarity || 'none')}">${gi(kindIcon(it, path), 'pc-icon')}<div><div class="pc-name">${esc(name)}</div><div class="pc-type">${esc(type || (it ? '' : tr('No stats for this part yet')))}</div></div></div>
    ${rows.length ? `<div class="pc-rows">${rows.join('')}</div>` : ''}
    ${it ? `<div class="pc-rows pc-base"><div class="pc-row">${gi('health')}<span>${esc(tr('Durability'))}</span><b>${fmt(it.hp || 0)} <small>pts</small></b></div>
      <div class="pc-row">${gi('mass')}<span>${esc(tr('Mass'))}</span><b>${fmt(it.mass || 0)} <small>kg</small></b></div></div>` : ''}
    ${it?.old ? `<div class="pc-note">${esc(tr('From the 2018-19 game data: may have changed since'))}</div>` : ''}`;
}

// The controls bar at the bottom of the garage: [keys, label] per entry.
export const CONTROLS = [
  [['lmb'], 'Place / select'],
  [['lmb'], 'Drag a part: move'],
  [['ctrl', '+', 'lmb'], 'Add to selection'],
  [['shift', '+', 'lmb'], 'Box select'],
  [['rmb'], 'Cancel'],
  [['w', 'a', 's', 'd'], 'Camera'],
  [['space'], 'Camera up'],
  [['shift'], 'Camera down'],
  [['c'], 'Lift car'],
  [['f'], 'Aug. reality'],
  [['h'], 'Parts list'],
  [['p'], 'Reference picture'],
  [['v'], 'Fire (hold)'],
  null, // line break
  [['r'], 'Spin'],
  [['t'], 'Tip'],
  [['y'], 'Roll'],
  [['x'], 'Mirror'],
  [['shift', '+', 'x'], 'To other side'],
  [['ctrl', '+', 'q'], 'Tip (as the game)'],
  [['m'], 'Symmetry'],
  [['g'], 'Move'],
  [['ctrl', '+', 'd'], 'Copy'],
  [['del'], 'Delete'],
  [['home'], 'Frame'],
  [['ctrl', '+', 's'], 'Save'],
  [['ctrl', '+', 'z'], 'Undo'],
  [['ctrl', '+', 'y'], 'Redo'],
];
// A controls bar: [keys, label] per entry, null = line break; '+' and '-' between keys are text.
export function keysHtml(list) {
  return list.map((c) => (c ? `<div class="gk"><div class="gk-keys">${c[0].map((k) => (k === '+' || k === '-' ? `<span class="plus">${k === '-' ? '–' : '+'}</span>` : keycap(k))).join('')}</div><span>${esc(tr(c[1]))}</span></div>` : '<div class="gk-break"></div>')).join('');
}
export function controlsHtml() { return keysHtml(CONTROLS); }
// Maps mode (mapview.js)
export const MAP_CONTROLS = [
  [['w', 'a', 's', 'd'], 'Fly'],
  [['space'], 'Up'],
  [['shift'], 'Down'],
  [['1', '-', '9'], 'Camera speed'],
  [['lmb'], 'Drag: look around'],
  [['lmb'], 'Click: select'],
  [['ctrl', '+', 'lmb'], 'Add · drag: box'],
  [['f'], 'Fly to it'],
  [['h'], 'Hide it'],
  [['v'], 'Fire (hold)'],
];

// ---- the parts list (H) ------------------------------------------------------------------------------
const KIND_ORDER = { cabin: 0, weapon: 1, module: 2, generator: 3, movement: 4, frame: 5, structure: 6, decor: 7 };
export function partTileHtml(p, it, name, { selected = false, loose = false, thumb = null } = {}) {
  let badge = '';
  const e = it?.kind === 'cabin' || it?.kind === 'generator' ? it.power : it?.cost ? -it.cost : 0;
  if (e) badge = `<span class="pl-badge ${e > 0 ? 'pos' : 'neg'}">${e > 0 ? '+' : '−'}${Math.abs(e)}${gi('energy')}</span>`;
  const tip = [name, it ? typeLabel(it.type) + (p.st ? tr(' · steering') : '') : tr('no stats yet'), it ? `${fmt(it.mass || 0)} kg · ${fmt(it.hp || 0)} pts` : '', loose ? tr('not welded to the vehicle') : ''].filter(Boolean).join('\n');
  return `<button class="pl-tile r-${esc(it?.rarity || 'none')}${selected ? ' sel' : ''}${loose ? ' loose' : ''}" data-id="${p.id}" title="${esc(tip)}">
    ${thumb ? `<img src="${thumb}" alt="">` : gi(kindIcon(it, p.path), 'pl-ph')}
    ${p.st ? gi('steering', 'pl-st') : ''}${badge}</button>`;
}

export function sortParts(list, stats) {
  const key = (p) => { const it = stats.item(p.path, p.st); return [KIND_ORDER[it?.kind] ?? 9, it?.name || p.name || p.path]; };
  return [...list].sort((a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || String(ka[1]).localeCompare(String(kb[1])) || a.id - b.id; });
}

// ---- camera keys ---------------------------------------------------------------------------------------
// Crossout's garage camera: W A S D move it over the ground (relative to where it looks), Space
// raises it and Shift lowers it. Shift is also the builder's modifier (Shift+click, Shift+drag,
// Shift+R): as soon as it is used that way, the camera goes back to where it was when Shift went down.
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space']);
export class GarageCamera {
  constructor(viewer, { enabled = () => true, onMove = () => {} } = {}) {
    this.v = viewer;
    this.enabled = enabled;
    this.onMove = onMove;
    this.keys = new Set();
    this.vel = new THREE.Vector3();
    this.shift = null; // { t0, pos, target, used }
    this.clock = 0;
    // (on the window: the builder's own Shift+click handler stops other canvas listeners)
    window.addEventListener('pointerdown', (e) => { if (e.shiftKey) this.shiftUsed(); }, { capture: true });
    window.addEventListener('blur', () => this.clear());
    viewer.frameHooks.push(() => this.tick());
  }

  get moving() { return this.keys.size > 0 || (this.shift && !this.shift.used) || this.vel.lengthSq() > 1e-6; }

  // keydown: true when the key belongs to the camera (then it does nothing else)
  down(e) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      // (with Ctrl / Alt already down it is a modifier from the start: Ctrl+Shift+S lowered the camera for good)
      if (!this.shift) this.shift = { t0: performance.now(), pos: this.v.camera.position.clone(), target: this.v.controls.target.clone(), used: e.ctrlKey || e.altKey || e.metaKey };
      return true;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) { this.shiftUsed(); return false; }
    if (MOVE.has(e.code)) { this.keys.add(e.code); return true; }
    this.shiftUsed(); // Shift + another key: Shift is a modifier there (Shift+R turns the other way)
    return false;
  }

  up(e) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { this.shift = null; return; }
    this.keys.delete(e.code);
  }

  shiftUsed() {
    const s = this.shift;
    if (!s || s.used) return;
    s.used = true;
    if (performance.now() - s.t0 < 130) return; // too short to have moved
    const d = s.target.clone().sub(this.v.controls.target);
    this.v.camera.position.add(d);
    this.v.controls.target.add(d);
    this.vel.set(0, 0, 0);
    this.v.dirty = true;
  }

  clear() { this.keys.clear(); this.shift = null; this.vel.set(0, 0, 0); }

  tick() {
    const now = performance.now();
    const dt = this.clock ? Math.min(0.05, (now - this.clock) / 1000) : 0;
    this.clock = now;
    if (!this.enabled()) { if (this.keys.size || this.shift) this.clear(); return; }
    const k = this.keys;
    const fwdIn = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const sideIn = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    let upIn = k.has('Space') ? 1 : 0;
    if (this.shift && !this.shift.used && now - this.shift.t0 > 130) upIn -= 1;
    const cam = this.v.camera, target = this.v.controls.target;
    const fwd = target.clone().sub(cam.position);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    const want = new THREE.Vector3(-fwd.z, 0, fwd.x).multiplyScalar(sideIn).addScaledVector(fwd, fwdIn);
    if (want.lengthSq() > 1) want.normalize();
    want.y = upIn;
    const speed = THREE.MathUtils.clamp(cam.position.distanceTo(target) * 0.9, 1.2, 14); // m/s
    want.multiplyScalar(speed);
    const idle = want.lengthSq() === 0;
    if (idle && this.vel.lengthSq() < 0.01) { this.vel.set(0, 0, 0); return; } // stops crisply
    this.vel.lerp(want, 1 - Math.exp(-(idle ? 18 : 10) * dt));
    const d = this.vel.clone().multiplyScalar(dt);
    const minY = this.v.groundY() + 0.05; // the pivot stays above the floor
    if (d.y < 0 && target.y + d.y < minY) d.y = Math.min(0, minY - target.y);
    if (d.lengthSq() === 0) return;
    cam.position.add(d);
    target.add(d);
    this.v.tween = null;
    this.v.dirty = true;
    this.onMove();
  }
}
