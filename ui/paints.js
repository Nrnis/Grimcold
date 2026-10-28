// The game's paints, and the picker the 3D Viewer and the Vehicle Builder choose them with.
//
// A paint goes where a part's paint mask says (its gloss map's red), over the part's own colours by an
// overlay blend that keeps their shading (viewer.js xoAdjust, xo::applyPaint in the export):
//   { kind: 'color', color, amount }: one colour (sRGB 0..1);
//   { kind: 'pattern', tex, normal, color, amount, scale }: a texture of textures/patterns tiled over the
//     part's second UV set, where the game lays its paints (one set runs on unbroken over a whole cabin);
//     color tints it (white: as it is), scale is its repeats per unit of that set, normal its relief;
//   { kind: 'chameleon', tex, normal, color, amount }: a colour ramp (cham_*: 256 x 8 or 16 texels) read
//     by the angle the surface is seen at, the left end where it faces the camera, the right end where
//     it is seen edge-on.
// finish (any kind): 'metallic' or 'chrome' makes the painted surface shine as metal, as the game's
// metallic paints and its Chrome, Gold and Aluminium materials do (FINISHES; none: the part's own gloss).
// amount 0 is no paint at all (a part kept bare under a painted vehicle).
const enc = encodeURIComponent;
const DATA = 'https://xo.data';
import { t as tr } from './i18n.js';

export const DEFAULT_COLOR = [0.55, 0.13, 0.1];
// the colour swatches (the old ones first: builds and looks name them)
export const COLORS = [['#8c2119', 'Crimson'], ['#c96a1b', 'Rust orange'], ['#d9b44a', 'Steppe sand'], ['#56602f', 'Military olive'], ['#2f4f6f', 'Navy'], ['#1f7a6d', 'Teal'], ['#6b3fa0', 'Purple'], ['#e8e8e3', 'Arctic white'], ['#2b2b2b', 'Graphite'], ['#d93a8c', 'Neon pink'],
  ['#9a9c98', 'Steel grey'], ['#5b4636', 'Mud brown'], ['#3d6b35', 'Forest green'], ['#b8262b', 'Fire engine red'], ['#e3c21c', 'Signal yellow'], ['#1d6fd0', 'Cobalt blue'], ['#121212', 'Black'], ['#7fd2e8', 'Ice blue']];
// How a finish lights the painted surface: its roughness and how metallic it is (the part's own gloss map
// says that elsewhere). The game's values are in its encrypted data; these look like its metallic paints
// (a car's metallic lacquer) and its polished metals.
export const FINISHES = { metallic: { rough: 0.32, metal: 0.65, label: 'Metallic' }, chrome: { rough: 0.08, metal: 1, label: 'Chrome' } };
// the game's material paints (Material: Chrome, Gold, Aluminium), as a colour with a finish
// (their colours: the metals' own reflectance, as physically based shading takes it, in sRGB)
export const MATERIALS = [['#dfe2e5', 'Chrome', 'chrome'], ['#ffd88c', 'Gold', 'chrome'], ['#c9cdd2', 'Aluminium', 'metallic']];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const hex = (c) => '#' + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
export const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A paint in its one shape (from a file, a picker, an old build's { color, amount }); null for none.
export function normPaint(p) {
  if (!p || typeof p !== 'object') return null;
  const color = Array.isArray(p.color) && p.color.length >= 3 && p.color.slice(0, 3).every((v) => Number.isFinite(+v)) ? p.color.slice(0, 3).map((v) => clamp(+v, 0, 1)) : null;
  const amount = clamp(Number.isFinite(+p.amount) ? +p.amount : 0, 0, 1);
  const tex = typeof p.tex === 'string' ? p.tex : '';
  const finish = FINISHES[p.finish] ? { finish: p.finish } : {};
  if ((p.kind === 'pattern' || p.kind === 'chameleon') && tex) {
    const out = { kind: p.kind, tex, color: color || [1, 1, 1], amount };
    if (typeof p.normal === 'string' && p.normal) out.normal = p.normal;
    if (p.kind === 'pattern') out.scale = clamp(Number.isFinite(+p.scale) && +p.scale > 0 ? +p.scale : 1, 1 / 16, 16);
    return { ...out, ...finish };
  }
  return { kind: 'color', color: color || DEFAULT_COLOR.slice(), amount, ...finish };
}
export function paintKey(p) {
  if (!p) return '';
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return [p.kind, ...p.color.map(r), r(p.amount), p.tex || '', p.normal || '', r(p.scale || 1), p.finish || ''].join('|');
}

// A paint as a build or look file keeps it: a colour as { color, amount } (as builds always had it).
export function paintForFile(p) {
  if (!p) return null;
  if (p.kind === 'color') return { color: p.color, amount: p.amount, ...(p.finish ? { finish: p.finish } : {}) };
  return { ...p };
}

// ---- the catalog --------------------------------------------------------------------------------
// From the game's file list: every texture in textures/patterns but the developers' tests, with its
// relief map (its own _n, or the one its numbered or _d variants share: lava_skin01 -> lava_skin_n),
// patterns and chameleon ramps apart. (arena04 is the one 256 x 16 ramp outside cham_*; measured over
// all 554 textures there. stress_test01 and 02 are paints: Graffiti Dusk and Dawn.)
const SKIP = /^(test\d*|pbr_test|dye_test_\w+|delete_after_cinematic|td_512px_1m|checker_alpha|checker_direction_tile)$/;
const RAMPS = new Set(['arena04']);
// The paints' names in the game, where its text names them: its English strings of 2018-19 (the paints'
// "Pic_<name>" and "Dye_<name>" entries, matched to the textures by name; the newer paints' are only in
// the encrypted data). Near matches were checked by eye: Digital Desert is camo_desert's pixel camouflage.
export const GAME_NAMES = {
  ryuusui01: 'Flowing river', shimapan: 'Shimapan', spider_web01: 'Nocturnal Hunter', spider_web02: 'Camouflage: Web',
  trypophobia01: 'Camouflage: Crater', australia1: 'Pattern: Aboriginal', australia2: 'Pattern: Down under', alien_skin: "Pattern: Will-o'-wisp",
  blood_hand: 'Easy target', crash_test01: 'Material: Test Dummy', crash_test02: 'Material: Crash Tester', etno_pattern: 'Pattern: Tribal',
  gold_tiger: 'Golden Tiger', jail_scratches01: 'Pattern: Calendar', khaki_sharp: 'Pattern: Larch', lava_skin01: 'Pattern: Lava',
  scale_fish01: 'Material: Alligator', scale_fish02: 'Material: Snake', scary_faces01: 'The Harvest', school_desk01: 'Pattern: Blackboard',
  st_muerte01: 'Death mask', st_muerte02: 'Death dance', stress_test01: 'Pattern: Graffiti Dusk', stress_test02: 'Pattern: Graffiti Dawn',
  teutonique_cross01: 'Teutonic Cross', teutonique_eagle: 'Teutonic Eagle', teutonique_stripes: 'Teutonic Stripes', turtle_shell01: 'Pattern: Turtle',
  us_line: "'Lone ranger' stripes", us_stars: "'Lone ranger' stars", youtube02: 'Brotherhood of viewers',
  camo_desert: 'Pattern: Digital Desert', electric_pattern: 'Pattern: Lightning', flames: 'Pattern: Flame', taxi_crack: 'Old salt',
  black_crack: 'Pattern: Scorched Earth', bullet_holes03: 'Metal fatigue', rusted01: 'Material: Rust', checker_01: 'Pattern: Checkers',
  danger_stripes01: 'Pattern: Danger!', carbon: 'Material: Carbon', grid_d: 'Material: Grid', newyear2016: 'New Year',
};
export function paintCatalog(names) {
  const have = new Set();
  for (const n of names) { const m = /^textures\/patterns\/(.+)\.tfh$/.exec(n); if (m) have.add(m[1]); }
  const out = { patterns: [], chameleons: [] };
  for (const leaf of [...have].sort()) {
    if (/_n$/.test(leaf)) continue; // (relief maps go with their colours; the ones alone have none)
    const stem = leaf.replace(/_a$/, '');
    if (SKIP.test(stem)) continue;
    const base = stem.replace(/(_d|\d+)$/, '');
    const normal = have.has(stem + '_n') ? stem + '_n' : base !== stem && have.has(base + '_n') ? base + '_n' : '';
    const cham = /^cham_/.test(stem) || RAMPS.has(stem);
    const item = { tex: 'textures/patterns/' + leaf, name: GAME_NAMES[stem] || paintName(stem, cham), stem };
    if (GAME_NAMES[stem]) item.game = true;
    if (normal) item.normal = 'textures/patterns/' + normal;
    (cham ? out.chameleons : out.patterns).push(item);
  }
  out.byTex = new Map([...out.patterns, ...out.chameleons].map((i) => [i.tex, i]));
  return out;
}

// "camouflage_urban03" -> "Camouflage urban 03"; a chameleon's run-together colours apart
// ("cham_velvetgreycyan" -> "Velvet grey cyan").
const COLOR_WORDS = /(black|blue|green|red|yellow|pink|violet|orange|white|grey|gray|cyan|gold|silver|sky|chrome|velvet|laser|neon|demon|cyber|east|glitter)/g;
export function paintName(stem, cham = /^cham_/.test(stem)) {
  let s = stem.replace(/^cham_/, '');
  if (cham) s = s.replace(COLOR_WORDS, ' $1 ');
  s = s.replace(/_/g, ' ').replace(/([a-z])(\d)/gi, '$1 $2').replace(/(\d)([a-z])/gi, '$1 $2').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : stem;
}

export const thumbOf = (tex, max = 64) => `${DATA}/png?base=${enc(tex)}&max=${max}&view=opaque`;

// What a paint is called ("Camouflage 01", "Crimson", "#5a7c33", "Chrome"), and what kind it is.
export function paintLabel(p, catalog) {
  if (!p) return { name: tr('No paint'), kind: '' };
  if (p.amount <= 0) return { name: tr('No paint'), kind: 'bare' };
  const pct = Math.round(p.amount * 100) + '%', fin = p.finish ? ` · ${tr(FINISHES[p.finish].label).toLowerCase()}` : '';
  if (p.kind === 'color') {
    const h = hex(p.color), mat = MATERIALS.find(([c, , f]) => c === h && f === p.finish), known = COLORS.find(([c]) => c === h);
    if (mat) return { name: tr(mat[1]), kind: tr('Material · {pct}', { pct }) };
    return { name: known ? tr(known[1]) : h.toUpperCase(), kind: tr('Colour{fin} · {pct}', { fin, pct }) };
  }
  const it = catalog?.byTex.get(p.tex);
  const name = it ? it.name : paintName(p.tex.split('/').pop().replace(/_a$/, ''));
  return { name, kind: (p.kind === 'chameleon' ? tr('Chameleon') : tr('Pattern')) + tr('{what}{fin} · {pct}', { what: '', fin, pct }) };
}

// ---- the picker ---------------------------------------------------------------------------------
// The paint shown (its picture, name and kind), the choices in three tabs (colours with the game's
// metal materials, patterns, chameleons, the last two searchable), and its colour (a pattern's tint),
// finish, amount and pattern size. onChange(paint, final): a pick (final) or an edit (not final while a
// slider is dragged; final when it is let go).
export class PaintPicker {
  constructor(el, { onChange = () => {}, catalog = () => null, tabs = true } = {}) {
    this.el = el;
    this.onChange = onChange;
    this.catalog = catalog;
    this.value = null;
    this.tab = 'color';
    this.query = '';
    el.classList.add('pp');
    el.innerHTML = `
      <div class="pp-now"><span class="pp-chip"></span><div class="pp-what"><b class="pp-name">${tr('No paint')}</b><span class="pp-kind"></span></div></div>
      <div class="seg small pp-tabs"${tabs ? '' : ' hidden'}><button data-tab="color" class="on" title="Plain colours, and the game's metal materials">${tr('Colours')}</button><button data-tab="pattern" title="The game's patterns: camouflage, carbon, flames, scales …">${tr('Patterns')}</button><button data-tab="chameleon" title="The game's chameleon paints: their colour changes with the angle you see the surface at">${tr('Chameleon')}</button></div>
      <input type="search" class="pp-search" placeholder="${tr('Search paints')}" spellcheck="false" hidden>
      <div class="pp-grid"></div>
      <div class="pp-mats"></div>
      <div class="pp-ar pp-color-row"><span class="pp-color-label">${tr('Colour')}</span><input type="color" class="pp-color" value="#8c2119"><span></span></div>
      <div class="pp-ar pp-finish-row" title="How the paint shines: as the part does (Matte), as a metallic paint, or as polished metal (Chrome)"><span>${tr('Finish')}</span><div class="seg small pp-finish"><button data-finish="" class="on">${tr('Matte')}</button><button data-finish="metallic">${tr('Metallic')}</button><button data-finish="chrome">${tr('Chrome')}</button></div><span></span></div>
      <div class="pp-ar"><span>${tr('Amount')}</span><input type="range" class="pp-amount" min="0" max="1" step="0.01" value="0"><span class="val pp-amount-val">0%</span></div>
      <div class="pp-ar pp-size-row" hidden title="How big the pattern is laid over the part (1× as the game lays it; double-click: back to 1×)"><span>${tr('Size')}</span><input type="range" class="pp-size" min="-3" max="3" step="0.1" value="0"><span class="val pp-size-val">1×</span></div>`;
    this.q = (s) => el.querySelector(s);
    this.q('.pp-mats').innerHTML = MATERIALS.map(([c, n, f]) => `<button data-pick="material" data-color="${c}" data-finish="${f}" title="${tr('Material')}: ${tr(n)}"><i style="background:${c}"></i>${tr(n)}</button>`).join('');
    this.q('.pp-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-tab]'); if (b) this.showTab(b.dataset.tab); });
    this.q('.pp-search').addEventListener('input', () => { this.query = this.q('.pp-search').value.trim().toLowerCase(); this.renderGrid(); });
    this.q('.pp-grid').addEventListener('click', (e) => this.pick(e.target.closest('[data-pick]')));
    this.q('.pp-mats').addEventListener('click', (e) => this.pick(e.target.closest('[data-pick]')));
    this.q('.pp-finish').addEventListener('click', (e) => { const b = e.target.closest('button[data-finish]'); if (b) this.edit({ finish: b.dataset.finish || undefined }, true); });
    const color = this.q('input.pp-color');
    color.addEventListener('input', () => this.edit({ color: unhex(color.value) }, false));
    color.addEventListener('change', () => this.edit({ color: unhex(color.value) }, true));
    const amt = this.q('.pp-amount');
    amt.addEventListener('input', () => this.edit({ amount: +amt.value }, false));
    amt.addEventListener('change', () => this.edit({ amount: +amt.value }, true));
    const size = this.q('.pp-size');
    size.addEventListener('input', () => this.edit({ scale: 2 ** -+size.value }, false));
    size.addEventListener('change', () => this.edit({ scale: 2 ** -+size.value }, true));
    size.addEventListener('dblclick', () => { size.value = 0; this.edit({ scale: 1 }, true); }); // (back to the game's size)
    this.renderGrid();
    this.sync();
  }

  // The paint shown (it does not call onChange; the same again changes nothing, so a slider being
  // dragged keeps its place).
  setValue(p) {
    const v = p ? normPaint(p) : null;
    if (paintKey(v) === paintKey(this.value) && this.synced) return;
    this.synced = true;
    const first = this.value === null && v && !this.shownOnce;
    this.value = v;
    if (first) { this.shownOnce = true; this.showTab(v.kind === 'chameleon' ? 'chameleon' : v.kind === 'pattern' ? 'pattern' : 'color'); }
    this.sync();
  }

  // The catalog came (the game's files were read).
  // (and the language changed: the search box's words too)
  refresh() { if (this.tab) this.q('.pp-search').placeholder = this.searchWords(); this.renderGrid(); this.sync(); }

  searchWords() { return this.tab === 'chameleon' ? tr('Search chameleon paints') : tr('Search patterns'); }

  showTab(tab) {
    this.tab = tab;
    this.el.querySelectorAll('.pp-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    const search = this.q('.pp-search');
    search.hidden = tab === 'color';
    search.placeholder = this.searchWords();
    this.q('.pp-mats').hidden = tab !== 'color';
    this.renderGrid();
    this.sync();
  }

  renderGrid() {
    const grid = this.q('.pp-grid'), cat = this.catalog();
    grid.className = `pp-grid pp-tab-${this.tab}`; // (not pp-color: the colour box's class)
    if (this.tab === 'color') {
      grid.innerHTML = COLORS.map(([c, n]) => `<button data-pick="color" data-color="${c}" title="${n}" style="background:${c}"></button>`).join('');
    } else if (!cat) {
      grid.innerHTML = '<div class="hint">The game\'s paints show once its files are read.</div>';
    } else {
      const list = this.tab === 'pattern' ? cat.patterns : cat.chameleons;
      const q = this.query, hits = q ? list.filter((it) => it.name.toLowerCase().includes(q) || it.stem.includes(q)) : list;
      grid.innerHTML = hits.map((it) => {
        const tip = esc(`${it.name}${it.game ? '' : tr(" (no name in the game's text: its file's)")}${it.normal ? tr(', with relief') : ''}`);
        return this.tab === 'pattern'
          ? `<button data-pick="pattern" data-tex="${esc(it.tex)}" title="${tip}"><img loading="lazy" decoding="async" alt="" src="${thumbOf(it.tex)}"></button>`
          : `<button data-pick="chameleon" data-tex="${esc(it.tex)}" title="${tip}: ${tr('facing you on the left, seen edge-on on the right')}"><span class="pp-ramp" style="background-image:url('${thumbOf(it.tex)}')"></span><span class="pp-rn">${esc(it.name)}</span></button>`;
      }).join('') || `<div class="hint">No ${this.tab === 'pattern' ? 'pattern' : 'chameleon paint'} matches “${esc(q)}”.</div>`;
    }
    this.mark();
  }

  // the picked choice lit in the grid (and among the materials)
  mark() {
    const v = this.value, h = v?.kind === 'color' ? hex(v.color) : '';
    for (const b of this.el.querySelectorAll('.pp-grid [data-pick], .pp-mats [data-pick]')) {
      const on = !!v && v.amount > 0 && (b.dataset.pick === 'material' ? v.kind === 'color' && b.dataset.color === h && b.dataset.finish === (v.finish || '')
        : b.dataset.pick === 'color' ? v.kind === 'color' && b.dataset.color === h : v.tex === b.dataset.tex);
      b.classList.toggle('on', on);
    }
  }

  pick(b) {
    if (!b) return;
    const cur = this.value, cat = this.catalog();
    // (the finish stays with the next pick, but a material's: a colour or pattern after Chrome is matte)
    const wasMaterial = cur?.kind === 'color' && MATERIALS.some(([c, , f]) => c === hex(cur.color) && f === cur.finish);
    const finish = wasMaterial ? undefined : cur?.finish;
    let p;
    if (b.dataset.pick === 'material') {
      p = { kind: 'color', color: unhex(b.dataset.color), amount: 1, finish: b.dataset.finish };
    } else if (b.dataset.pick === 'color') {
      p = { kind: 'color', color: unhex(b.dataset.color), amount: cur?.amount > 0 ? cur.amount : 0.85, finish };
    } else {
      const it = cat?.byTex.get(b.dataset.tex);
      if (!it) return;
      const kind = b.dataset.pick;
      p = { kind, tex: it.tex, normal: it.normal || '', color: cur && cur.kind !== 'color' ? cur.color : [1, 1, 1], amount: cur?.amount > 0 ? cur.amount : 1, finish };
      if (kind === 'pattern') p.scale = cur?.kind === 'pattern' ? cur.scale : 1;
    }
    this.value = normPaint(p);
    this.sync();
    this.onChange(this.value, true);
  }

  edit(patch, final) {
    const cur = this.value || { kind: 'color', color: DEFAULT_COLOR.slice(), amount: 0 };
    const next = { ...cur, ...patch };
    if ((patch.color || 'finish' in patch) && !('amount' in patch) && !(cur.amount > 0)) next.amount = cur.kind === 'color' ? 0.85 : 1; // (a colour picked: it shows)
    this.value = normPaint(next);
    this.sync({ keepInputs: !final });
    this.onChange(this.value, final);
  }

  // The shown paint's picture, name and kind, and its values in the inputs. keepInputs: a slider being
  // dragged keeps its own value (set again it would stutter).
  sync({ keepInputs = false } = {}) {
    const v = this.value, cat = this.catalog();
    const chip = this.q('.pp-chip');
    chip.className = 'pp-chip' + (!v || v.amount <= 0 ? ' none' : ` ${v.kind}`) + (v?.finish ? ' shiny' : '');
    chip.style.background = '';
    if (v && v.amount > 0) {
      if (v.kind === 'color') chip.style.background = hex(v.color);
      else chip.style.background = `url('${thumbOf(v.tex)}') center / ${v.kind === 'chameleon' ? '100% 100%' : 'cover'}`;
    }
    const l = paintLabel(v, cat);
    this.q('.pp-name').textContent = l.name;
    this.q('.pp-kind').textContent = l.kind === 'bare' ? tr('Bare: no paint on it') : tr(l.kind);
    const tinted = !!v && v.kind !== 'color';
    this.q('.pp-color-label').textContent = tinted ? tr('Tint') : tr('Colour');
    this.q('.pp-color-row').title = tinted ? tr('Tints the pattern (white: as the game has it)') : tr("The paint's colour");
    this.q('.pp-size-row').hidden = v?.kind !== 'pattern';
    this.el.querySelectorAll('.pp-finish button').forEach((b) => b.classList.toggle('on', (b.dataset.finish || '') === (v?.finish || '')));
    if (!keepInputs) {
      this.q('input.pp-color').value = hex(v ? v.color : DEFAULT_COLOR);
      this.q('.pp-amount').value = v ? v.amount : 0;
      this.q('.pp-size').value = v?.kind === 'pattern' ? -Math.log2(v.scale || 1) : 0;
    }
    this.q('.pp-amount-val').textContent = Math.round((v ? v.amount : 0) * 100) + '%';
    const sz = v?.kind === 'pattern' ? 1 / (v.scale || 1) : 1;
    this.q('.pp-size-val').textContent = (sz >= 10 ? sz.toFixed(0) : sz >= 1 ? +sz.toFixed(1) : +sz.toFixed(2)) + '×';
    this.mark();
  }
}
