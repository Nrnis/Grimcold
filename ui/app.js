// Grimcold UI: part browser, 3D viewer + inspector, vehicle builder, colour/texture
// edits, export.
import { initSupport, crumb } from './support.js'; // (first: it notes the page's errors from the start)
import { Viewer, CELL } from './viewer.js';
import { Build } from './build.js';
import { Embers } from './bgfx.js';
import { Animator, prettyName, firePointsOf } from './anim.js';
import { muzzleFor, muzzleChoices, shotFor } from './fxmap.js';
import { gunSound, activitySound, meleeSound, turretSound } from './soundmap.js';
import { Firing, MAP_GUN } from './firing.js';
import { Ambience } from './ambience.js';
import { MapEffects, weatherName } from './mapfx.js';
import { Drive, shotBreaks } from './drive.js';
import { Recorder, dataUrlOf } from './recorder.js';
import { weaponAim, ARC_SIZE } from './arcs.js';
import { stickerPacks, packLabel, thumbUrl as stickerThumb, SIZE as STICKER_SIZE } from './stickers.js';
import { PartStats, GarageCamera, hydrateIcons, resetIcons, vehicleStats, energyBarHtml, vehicleStatsHtml, partCardHtml, controlsHtml, keysHtml, MAP_CONTROLS, partTileHtml, sortParts, section, PART_LIMIT } from './garage.js';
import { MapView, SPEEDS } from './mapview.js';
import { weatherChoices, weatherLabel } from './weather.js';
import { References } from './refs.js';
import { parseList, NameIndex } from './checklist.js';
import { loadSkin, initRanges } from './skin.js';
import { initTooltips, initSelects, ask } from './gameui.js';
import { ShaderWarmup } from './warmup.js';
import { PaintPicker, paintCatalog, normPaint, paintForFile, paintLabel, thumbOf } from './paints.js';
// (i18n: the interface's translations. t is imported as tr, so a local `t` (a timer, a count) in this
// file keeps meaning what it did)
import { t as tr, tLines as trLines, tKey, applyStatic, sourceText, setLang, pickLang, getLang, LANG_NAMES } from './i18n.js';

const $ = (id) => document.getElementById(id);
const DATA = 'https://xo.data';
const enc = encodeURIComponent;
const ROW = 28;
initRanges(); // (the sliders filled up to their handle, as the game's: skin.js)
initTooltips(); // (the game's tooltips, drop-down lists and questions: gameui.js)
initSelects();

// ---- bridge to the C++ host -------------------------------------------------------------------
// Call ids start from the time the page loaded: after a reload (a crashed page is loaded again)
// a late reply to the old page's call can't be taken for the answer to a new one.
let seq = (Date.now() % 1e9) * 1000;
const pending = new Map();
const webview = window.chrome?.webview;
if (webview) {
  webview.addEventListener('message', (e) => {
    const m = e.data;
    if (m && m.event === 'progress') { pending.get(m.id)?.progress?.(m.fraction, m.stage); return; }
    if (m && m.event === 'window') { document.documentElement.classList.toggle('maximized', !!m.maximized); return; }
    const p = pending.get(m?.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'failed'));
  });
}
function call(cmd, args = {}, progress) {
  if (!webview) return Promise.reject(new Error('Open this page through Grimcold.exe'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, progress });
    webview.postMessage({ id, cmd, args });
  });
}

// ---- state ------------------------------------------------------------------------------------
// The parts menu, as the game's garage has it (its order, its names, its own icons from
// ui/textures/svg): All, Base (cabins and frames), Weapons, Hardware (modules), Movement parts,
// Structure, Decor; then this tool's own: the maps' gameplay objects, the rest, the maps' props.
// (The keys stay the tool's: settings and tests use them.)
const CATS = ['All', 'Cabins', 'Weapons', 'Modules', 'Movement', 'Structure', 'Decor', 'Gameplay', 'Other', 'Map props'];
const CAT_UI = {
  All: { label: 'All', icon: 'icn_showall', tip: 'Every part (the maps\' props are under Map props)' },
  Cabins: { label: 'Base', icon: 'module/icn_module_base', tip: 'Base: cabins and frames' },
  Weapons: { label: 'Weapons', icon: 'module/icn_module_weapon', tip: 'Weapons' },
  Modules: { label: 'Hardware', icon: 'module/icn_module_hardware', tip: 'Hardware: engines, coolers, generators, radars, drones, turrets…' },
  Movement: { label: 'Movement parts', icon: 'module/moduleicon_wheel', tip: 'Movement parts: wheels, tracks, legs, hovers, augers, rotors' },
  Structure: { label: 'Structure', icon: 'module/icn_module_structure', tip: 'Structure: armour and structural parts' },
  Decor: { label: 'Decor', icon: 'module/moduleicon_decor', tip: 'Decor' },
  Gameplay: { label: 'Gameplay', icon: 'module/icn_resourse', tip: 'The maps\' gameplay objects: loot, turrets, towers, gates…' },
  Other: { label: 'Other', icon: 'icn_cubes_parts', tip: 'Everything else among the models' },
  'Map props': { label: 'Map props', icon: 'module/icn_decoration', tip: 'The maps\' props: buildings, rocks, trees, vehicles…' },
};
const catLabel = (c) => tr(CAT_UI[c]?.label || c);
const state = {
  view: 'part', mode: 'parts', cat: 'Cabins', sub: null, catOpen: 'Cabins', query: '',
  files: [], folders: new Map(), catCounts: {}, expanded: new Set(), collapsed: new Set(), fileSel: null,
  rows: [], selected: null, selectedDir: null,
  info: null, lod: 0, skin: 'default', stats: null, loading: 0,
  checked: new Set(), filesView: [],
  adjust: {}, replace: {}, openAdjust: new Set(),
  exportFmt: 'glb', buildFmt: 'glb', settings: {}, test: false,
  // the game's paints (paints.js), the 3D Viewer's paint on its part, how the builder's Paint card paints
  paintCatalog: null, viewPaint: null, paintMode: 'all', buildRestored: false,
  buildFile: { path: '', print: '' }, // where the build was saved to / opened from, and what it held then
  assembly: [], assembled: false, // the 3D Viewer's part with what the game shows on its nodes (folderAssembly)
  map: { list: null, query: '', name: null, fmt: 'glb' }, // Maps mode
};

function categorize(path) {
  const p = path.split('/');
  if (p[0] === 'models') {
    if (p[1] === 'constructor') {
      switch (p[2]) {
        case 'cabins': return 'Cabins';
        case 'chassis': return p[3] === 'base' ? 'Cabins' : 'Movement'; // (frames: the game's Base, with the cabins)
        case 'structure': return 'Structure';
        case 'decor': return 'Decor';
        case 'modules': return 'Modules';
        default: return 'Other';
      }
    }
    if (p[1] === 'weapons') return 'Weapons';
    if (p[1] === 'gameplay') return 'Gameplay';
    return 'Other';
  }
  if (p[0] === 'assets') return 'Map props';
  return 'Other';
}

// A category's kinds (the arrow on its row), as the game's menu splits it: by the part's own type in
// the item table for cabins, weapons and hardware (light cabins, machine guns, engines...), by its
// folder for the rest (wheels, tracks, legs; a structure's faction kit, a decor theme, a map's prop
// kit). Folders the table does not have go under "Other ...".
const SUB_NAME = { 'Uncategorized weapon': 'Other weapons', Weapon: 'Other weapons', Cabin: 'Other cabins', Ammunition: 'Ammunition', Stealth: 'Stealth', 'Structure fortifiers': 'Structure fortifiers' };
const MOVE_NAME = { wheels: 'Wheels', tracks: 'Tracks', legs: 'Legs', leg_vertical: 'Legs', hovers: 'Hovers', air_cushion: 'Air cushions', propellers: 'Rotors' };
const SUB_FIRST = ['Light cabins', 'Medium cabins', 'Heavy cabins', 'Frames', 'Wheels', 'Tracks', 'Augers', 'Legs', 'Hovers', 'Air cushions', 'Rotors'];
const plural = (t) => SUB_NAME[t] || (/s$/.test(t) ? t : t + 's');
// decor: each piece has a folder of its own, so its kinds go by what it is (first match)
const DECOR_KINDS = [
  ['Holiday', /hallow|hlw|nyear|newyear|new_year|xmas|christmas|easter|april|anniversar|valentin|bday|birthday|firework|pumpkin|snowman/],
  ['Horns', /beep|horn|whistle|alarm|siren|bell|klaxon/],
  ['Lights', /light|lamp|flasher|led|neon|torch|lantern|hologram|projector|beacon|glow/],
  ['Exhausts', /exhaust|pipe|muffler/],
  ['Flags and banners', /flag|banner|pennant/],
  ['Mirrors and spoilers', /mirror|spoiler|wing|fender/],
  ['Signs and plates', /sign|plate|logo|license|number/],
  ['Wheel decor', /wheel_spin|wheel_cap|spare_wheel|wheel_med|spinner/],
  ['Spikes', /pike|spike|knobstick|centipede|spider/],
  ['Trophies', /reward|trophy|leaderboard|bounty|scoreboard|tako|question_mark/],
  ['Figures and toys', /duck|doll|bear|dino|figure|head|skull|gnome|toy|dog|cat|deer|cow|snake|goblet|statue|bust|idol|balloon|guitar|icecream|donut|flower|basket|football|mouse|mohawk|moby|lloyd|china/],
  ['Gear and cargo', /bag|barrel|box|crate|ammo|ammunition|belt|tool|wrench|hook|anchor|hose|tank_|seat|pillow|cover|radiator|intake|grille|speaker|antenna|launcher_pod|tactical|manhole|mudguard|rack|can_|fridge|atm|crane|lattice|tesla|camera|incubator|warrior_kit|wagon|claw|aim_|broken_missile/],
];
const words = (s) => { const w = String(s || '').replace(/^_+/, '').replace(/_(const)$/i, '').replace(/meele/i, 'melee').replace(/_/g, ' ').trim(); return w ? w[0].toUpperCase() + w.slice(1) : ''; };
function subOf(f) {
  if (f.sub !== undefined) return f.sub;
  const p = f.dir.split('/'), type = partStats.item(f.main)?.type || '';
  let s;
  switch (f.cat) {
    case 'Cabins': s = p[2] === 'chassis' ? 'Frames' : /cabin$/i.test(type) && type !== 'Cabin' ? plural(type) : 'Other cabins'; break;
    case 'Weapons': s = type ? plural(type) : 'Other weapons'; break;
    case 'Modules': s = !type ? 'Other hardware' : partStats.item(f.main)?.kind === 'weapon' && type !== 'Drone' ? 'Weapon modules' : plural(type); break;
    case 'Movement': s = type === 'Auger' ? 'Augers' : MOVE_NAME[p[3]] || words(p[3]); break;
    case 'Structure': s = words(p[3]); break; // (models/constructor/structure/<kit>/...)
    case 'Decor': { const n = (p[3] || f.name).toLowerCase(); s = (DECOR_KINDS.find(([, re]) => re.test(n)) || ['Other decor'])[0]; break; }
    case 'Gameplay': s = words(p[2]); break; // (models/gameplay/<group>/...)
    case 'Map props': s = words(p[1] === 'props' ? p[2] : p[1]); break; // (assets/props/<kit>/...)
    default: s = words(p[0] === 'models' ? (p[1] === 'constructor' ? p[2] : p[1]) : p[0]);
  }
  return (f.sub = s || 'Other');
}
// [{ s, n }]: a category's kinds and how many models each has (searching: how many match)
function subsOf(c) {
  if (c === 'All') return [];
  const counts = state.subHits ? state.subHits[c] || {} : (state.subCounts ||= countSubs())[c] || {};
  const all = state.subHits ? Object.keys((state.subCounts ||= countSubs())[c] || {}) : Object.keys(counts);
  const rank = (s) => { const i = SUB_FIRST.indexOf(s); return i >= 0 ? i : /^Other\b/.test(s) ? 1e4 : 100; };
  return all.map((s) => ({ s, n: counts[s] || 0 })).sort((a, b) => rank(a.s) - rank(b.s) || a.s.localeCompare(b.s));
}
function countSubs() {
  const out = {};
  for (const f of state.folders.values()) { const o = (out[f.cat] ||= {}), s = subOf(f); o[s] = (o[s] || 0) + f.models.length; }
  return out;
}

// ---- small helpers ----------------------------------------------------------------------------
let statusTimer = 0, lastStatus = null; // (the line as it came in: a language switch writes it again)
function status(text, error = false, sticky = false) {
  lastStatus = text ? { text, error, sticky } : null;
  text = text ? tr(text) : ''; // (the dictionary holds the whole sentence: one place to translate them all)
  const el = $('statusText');
  el.textContent = text || '';
  el.title = text || '';
  el.classList.toggle('err', !!error);
  clearTimeout(statusTimer);
  if (text && !sticky && !error) statusTimer = setTimeout(() => { if (el.textContent === text) { el.textContent = ''; lastStatus = null; } }, 8000);
}
let busyCount = 0, loadCount = 0, loadShown = false, loadTimer = 0;
const showBusy = () => { $('busy').hidden = busyCount === 0 && !loadShown; };
function busy(on, text) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (on && text) $('busyText').textContent = tr(text);
  showBusy();
}
// Opening a part: the pill only shows when it takes a while (most parts open in a fraction of a
// second, and a flashing spinner feels slower than none). state.loading counts open loads.
function loading(on, text) {
  loadCount = Math.max(0, loadCount + (on ? 1 : -1));
  state.loading = loadCount;
  if (on) {
    state.loadText = text;
    if (loadShown) $('busyText').textContent = tr(text);
    else if (!loadTimer) loadTimer = setTimeout(() => { loadTimer = 0; if (loadCount) { loadShown = true; $('busyText').textContent = tr(state.loadText); showBusy(); } }, 250);
  }
  if (!loadCount) { clearTimeout(loadTimer); loadTimer = 0; loadShown = false; showBusy(); }
}
function fmtBytes(n) { return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(0) + ' KB' : n + ' B'; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const leaf = (p) => p.slice(p.lastIndexOf('/') + 1);
const stem = (p) => leaf(p).replace(/\.[^.]+$/, '');
const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Model descriptions (/model JSON), cached per path + skin.
const infoCache = new Map();
// A model's description and its geometry (lod -1: all of them) as { info, entry } (entry: the viewer's
// geometry cache's, to release there): one request for both when neither is in or on its way (/modelgeo,
// the host reads the model once), else whatever is missing (another look of a model: its description).
const geoComing = new Map(); // `${path}|${lod}` -> /geo's bytes, while a /modelgeo brings them
async function getModel(path, skin = '', lod = 0) {
  const key = `${path}|${skin && skin !== 'default' ? skin : 'default'}`, geoKey = `${path}|${lod}`;
  if (infoCache.has(key) || viewer.geo.map.has(geoKey) || geoComing.has(geoKey)) {
    const coming = geoComing.get(geoKey);
    const info = await getInfo(path, skin);
    return { info, entry: viewer.acquireGeometry(info.path, lod, coming ? await coming.catch(() => null) : null) };
  }
  const both = (async () => {
    const r = await fetch(`${DATA}/modelgeo?path=${enc(path)}${skin && skin !== 'default' ? '&skin=' + enc(skin) : ''}&lod=${lod}`);
    if (!r.ok) throw new Error(await r.text());
    const buf = await r.arrayBuffer(), jl = new DataView(buf).getUint32(4, true);
    return { info: JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl))), geo: buf.slice((8 + jl + 3) & ~3) };
  })();
  const p = both.then((b) => b.info);
  p.catch(() => infoCache.delete(key));
  infoCache.set(key, p);
  const geo = both.then((b) => b.geo);
  geoComing.set(geoKey, geo);
  geo.then(() => geoComing.delete(geoKey), () => geoComing.delete(geoKey));
  const { info } = await both;
  return { info, entry: viewer.acquireGeometry(info.path, lod, await geo) };
}

function getInfo(path, skin = '') {
  const key = `${path}|${skin && skin !== 'default' ? skin : 'default'}`;
  if (!infoCache.has(key)) {
    const p = (async () => {
      const r = await fetch(`${DATA}/model?path=${enc(path)}${skin && skin !== 'default' ? '&skin=' + enc(skin) : ''}`);
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    })();
    p.catch(() => infoCache.delete(key));
    infoCache.set(key, p);
  }
  return infoCache.get(key);
}

// ---- viewer + builder -------------------------------------------------------------------------
// No WebGL 2 in WebView2 on this PC (a blocked driver, a virtual machine, Remote Desktop): nothing
// below can start, but Bug report and Donations still do, so it can be reported.
if (!(() => { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })()) {
  status('WebGL 2 is not available in WebView2 on this PC: Grimcold cannot draw. Bug report has the details.', true, true);
  call('init').then((init) => {
    state.settings = init.settings || {};
    state.test = init.test;
    return initSupport(init, { call, state, viewer: null, mapView: null });
  }).catch((e) => console.warn('Bug report could not start:', e));
  throw new Error('WebGL 2 is not available in WebView2 on this PC');
}
const viewer = new Viewer($('view'), {
  onHover: (h) => {
    const tip = $('hoverTip');
    if (!h) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = h.text;
    tip.style.left = h.x + 14 + 'px';
    tip.style.top = h.y + 12 + 'px';
  },
});
const warmup = new ShaderWarmup(viewer, { busy: () => busyCount > 0 || !state.gameReady }); // (maps' shaders built ahead)
const build = new Build(viewer, {
  nameOf: (info) => nameOrFile(info.path),
  tipOf: (inst) => { const it = partStats.item(inst.path); return `${nameOrFile(inst.path)}${it?.type ? ' · ' + it.type : ''}${inst.st ? ' · steering' : ''}`; },
  getInfo,
  onChange: () => { scheduleBuildPanel(); autosave(); },
  onPickPaint: (p, inst) => takePaint(p, inst), // (the brush, Alt+click on a part)
  onSelect: () => scheduleBuildPanel(),
  onHover: () => renderPartCard(),
  status: (t) => status(t, false, !!t),
  rules: (adds) => buildRules(adds),
  isCabin: (path) => partStats.item(path)?.kind === 'cabin',
  onePerVehicle: (path) => { const it = partStats.item(path); return it?.kind === 'cabin' || it?.type === 'Engine'; },
});
// The game's limits on adding parts: 80 parts, one cabin, one engine (none with No limits).
function buildRules(adds) {
  if (build.noLimits) return null;
  if (build.instances.length + adds.length > PART_LIMIT) return `Can't add it: a vehicle can have at most ${PART_LIMIT} parts`;
  const kind = (path) => { const it = partStats.item(path); return it?.kind === 'cabin' ? 'cabin' : it?.type === 'Engine' ? 'engine' : null; };
  const count = (k) => build.instances.filter((i) => kind(i.path) === k).length + adds.filter((a) => kind(a.path) === k).length;
  if (count('cabin') > 1) return "Can't add it: a vehicle has one cabin (delete the other one first)";
  if (count('engine') > 1) return "Can't add it: a vehicle can have one engine";
  return null;
}
// The garage's camera keys (W A S D, Space, Shift) move the builder's camera while held.
const partStats = new PartStats();
const garageCam = new GarageCamera(viewer, {
  enabled: () => state.view === 'build' && $('partsList').hidden && !refs.adjusting, // (lining up a picture: arrows and Shift are its own)
  onMove: () => { if (build.placing) build.updatePlacement(); },
});
// Rebuilding a vehicle from the game: screenshots over (or under) the view, and its parts as a checklist.
const refs = new References(viewer, { call, layer: $('refLayer'), onChange: () => autosave(), onList: () => renderRefs(), status: (t) => status(t, false, !!t) });
// Maps mode: a whole map, flown through with W A S D / Space / Shift, 1 .. 9 for the speed.
const mapView = new MapView(viewer, { getInfo, getModel, minimap: $('miniMap'), onChange: () => scheduleMapPanel(), onSpeed: () => renderMapSpeed(), onSelect: () => scheduleMapSelection() });
// Hold V: the vehicle's weapons fire in the builder, the picked gun from beside the camera on a map
// (firing.js), with the 3D Viewer's effects, rounds and sounds
const gunfire = new Firing(viewer, {
  build, mapView,
  gunOf: () => state.settings.mapGun || MAP_GUN,
  targetDist: () => (typeof state.settings.fxTarget === 'number' ? state.settings.fxTarget : 10),
});
// the map's own sounds in Maps mode (ambience.js: its soundscape, fires, windmills, rivers ...), while
// Show > Sounds is ticked
const ambience = new Ambience(viewer.sounds, { sceneOf: () => (state.view === 'map' && mapView.show.sound !== false ? mapView.scene : null), camera: () => viewer.camera });
viewer.frameHooks.push(() => ambience.tick());
// and its own effects (mapfx.js: fires, smoke, steam ... where they stand, the weather's snow or rain
// around the camera), while Show > Effects is ticked
const mapEffects = new MapEffects(viewer.fx, {
  sceneOf: () => (state.view === 'map' && mapView.show.effects !== false ? mapView.scene : null),
  envOf: () => mapView.env, camera: () => viewer.camera, level: () => mapView.sky?.level ?? 1,
});
viewer.frameHooks.push(() => mapEffects.tick());
// Drive (drive.js): the builder's vehicle on the open map, W A S D (Maps' Drive button)
// (a map coming in: drawn 10 times a second while nothing moves, see Viewer.slowFrames)
viewer.slowFrames = () => (viewer.mode === 'map' && mapView.loading && !mapView.loading.finished && !mapView.fly.active() && !drive.active ? 100 : 0);
const drive = new Drive(viewer, {
  build, mapView, item: (path, st) => partStats.item(path, st), firing: () => gunfire.on, cross: gunfire.cross,
  fire: (on) => (on ? gunfire.start() : gunfire.stop()),
  onChange: () => { mapView.driving = drive.active; $('mDrive').classList.toggle('on', drive.active); if (state.view === 'map') renderMapSpeed(); },
});
gunfire.drive = drive;
// what rounds hit on a map breaks if it breaks in the game (drive.js shotBreaks), driving or flying
viewer.onHit = (h, spec) => shotBreaks(viewer, mapView, h, spec);
// A turret turning in the 3D Viewer (its aim sliders, Look at me, Move these on their own): its servo
// whines while the aim moves and clunks as it stops (soundmap.js turretSound; the watchdog of a firing
// gun's loop ends it a moment after the last move)
let aimWas = null;
viewer.frameHooks.push(() => {
  const a = state.animator, part = viewer.part;
  if (state.view !== 'part' || !a?.loaded || !part || !('AimYaw' in a.pose || 'AimPitch' in a.pose)) { aimWas = null; return; }
  const now = [a.pose.AimYaw ?? 0, a.pose.AimPitch ?? 0];
  if (aimWas?.part === part) {
    const dy = Math.abs(now[0] - aimWas.v[0]), dp = Math.abs(now[1] - aimWas.v[1]);
    if (Math.max(dy, dp) > 0.05) { // (degrees a frame)
      const snd = turretSound(state.info?.path, dy >= dp, shotFor(state.info?.path)?.kind);
      if (snd) viewer.sounds.gun('turret', snd, part.userData.box.getCenter(part.position.clone()).toArray());
    }
  }
  aimWas = { part, v: now };
});
window.__xo = {
  state, viewer, build, call, getInfo, openModel: (...a) => openModel(...a), setView: (v) => setView(v), folderName: (dir) => folderName(state.folders.get(dir)), loadBuildFile: (d) => loadBuildFile(d), buildFile: () => buildFile(), editsForExport: () => editsForExport(), lookFile: () => lookFile(), applyLook: (l) => applyLook(l),
  saveBuild: (o) => saveBuild(o), shownPose: () => shownPose(), partName: (p) => partName(p), exportArgs: () => exportArgs(),
  garage: { stats: partStats, cam: garageCam, vehicle: () => currentVehicle(), setAR: (on) => setAR(on), setLift: (on) => setLift(on), setPartsList: (on) => setPartsList(on), thumbs: () => thumbs },
  refs, checklist: () => state.checklist.map((it) => ({ ...it, match: checkItem(it) })),
  maps: mapView, openMap: (name, o) => openMap(name, o), mapList: () => state.map.list, gunfire, ambience, mapEffects, drive, recorder: () => recorder,
  revealRow: (i) => revealRow(i), cardPics: () => cardPics, warmup: () => warmup,
  paints: { catalog: () => state.paintCatalog, setView: (p) => setViewPaint(p), view: () => state.viewPaint, setMode: (m) => setPaintMode(m), pick: (p, final = true) => pickBuildPaint(p, final), pickers: () => ({ view: viewPicker, build: buildPicker }) },
}; // e2e hooks

// ---- the title bar (the page draws it: the window has no Windows caption) -----------------------
for (const [id, op] of [['winMin', 'min'], ['winMax', 'max'], ['winClose', 'close']]) {
  $(id).addEventListener('click', async () => {
    try { const r = await call('window', { op }); document.documentElement.classList.toggle('maximized', !!r?.maximized); } catch { /* an old host */ }
  });
}
call('window', { op: 'state' }).then((r) => document.documentElement.classList.toggle('maximized', !!r?.maximized)).catch(() => {});

// ---- game data --------------------------------------------------------------------------------
function showGame(g) {
  state.lastGame = g; // (a language switch writes it all again)
  state.gameVer = g.gameVersion || ''; // (the cards' pictures are kept per game version)
  $('gameDot').className = 'dot ' + (g.ok ? 'ok' : 'err');
  // (the folder's name alone: its full path holds the Windows user's name, so it is only in the tooltip
  // and a screenshot of the app shows no one's name)
  $('gameLabel').textContent = g.ok ? g.root.split(/[\\/]/).filter(Boolean).pop() || g.root : tr(g.error || 'Crossout not found');
  $('gameBtn').title = g.ok ? trLines([`Crossout game folder: ${g.root}`, `Game data: ${g.dataDir}`, `${g.packs} archives, ${g.files.toLocaleString()} files (read-only). Click to choose another folder.`]) : tr('Choose the Crossout folder');
  $('statusRight').textContent = g.ok ? tr('{files} files in {packs} archives{v}', { files: g.files.toLocaleString(), packs: g.packs, v: g.gameVersion ? tr(' · Crossout {v}', { v: g.gameVersion }) : '' }) : '';
  // the version beside the folder: which Crossout the parts come from ("2.40.10.361437 (661aac453)")
  const ver = $('gameVer'), [num] = (g.gameVersion || '').split(' ');
  ver.hidden = !g.ok;
  ver.classList.toggle('unknown', !num);
  ver.textContent = num ? tr('Crossout {n}', { n: num }) : tr('version unknown');
  ver.title = num ? trLines([`The Crossout version loaded: ${g.gameVersion}`, `(read from bin\\win64\\Crossout.exe in ${g.root}). Exports note it in the file.`])
    : tr('No Crossout.exe with a version in {dir}\\bin\\win64 (a copied data folder?)', { dir: g.root });
  $('gameDialog').hidden = g.ok;
  if (!g.ok) $('gameDialogText').textContent = tr(g.error || 'Crossout was not found automatically.');
  if (g.warnings?.length) status(g.warnings[0], false, true);
}

async function loadFiles() {
  busy(true, 'Reading the game archives…');
  try {
    const r = await fetch(`${DATA}/files`);
    if (!r.ok) throw new Error(await r.text());
    const text = await r.text();
    const files = [];
    const folders = new Map();
    const counts = Object.fromEntries(CATS.map((c) => [c, 0]));
    for (const line of text.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const name = line.slice(0, tab);
      files.push({ name, size: +line.slice(tab + 1) });
      if (!name.endsWith('.mdl')) continue;
      const dir = dirOf(name);
      let f = folders.get(dir);
      if (!f) {
        f = { dir, name: leaf(dir), cat: categorize(name), models: [] };
        folders.set(dir, f);
      }
      f.models.push(name);
      counts[f.cat]++;
      if (f.cat !== 'Map props') counts.All++;
    }
    for (const f of folders.values()) {
      f.models.sort((a, b) => a.localeCompare(b));
      const exact = f.models.find((m) => stem(m) === f.name);
      const pick = names.mains[f.dir];
      f.main = pick && f.models.includes(pick) ? pick : exact || [...f.models].sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
    }
    state.files = files;
    state.folders = folders;
    state.catCounts = counts;
    state.paintCatalog = paintCatalog(files.map((f) => f.name)); // (the game's paints: paints.js)
    if (state.view === 'build') fillStickers(); // (the builder open already: its stickers now)
    applyPaintZh(); // (the Chinese names of the paints, from ui\\paints.zh.json)
    viewPicker.refresh();
    buildPicker.refresh();
    state.subCounts = null; // (counted again for these folders)
    renderCats();
    rebuildRows();
    status(tr('{files} files, {models} models', { files: files.length.toLocaleString(), models: [...folders.values()].reduce((a, f) => a + f.models.length, 0).toLocaleString() }));
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
}

// ---- left list ----------------------------------------------------------------------------------
// The parts menu, drawn as the game's: each category a row with its icon, its name and, where it
// splits further, an arrow that opens its kinds under it (one open at a time); the picked one lit
// orange. While searching, each category and kind shows how many parts match there (the search looks
// in the one picked).
const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="5.5,9 12,15.5 18.5,9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function renderCats() {
  const hits = state.mode !== 'files' && state.catHits;
  $('cats').innerHTML = CATS.map((c) => {
    const subs = subsOf(c), open = state.catOpen === c && subs.length > 1, ui = CAT_UI[c];
    // (a kind picked, its list shut: the row says which, with its count)
    const kind = c === state.cat && state.sub && !open ? subs.find((x) => x.s === state.sub) : null;
    const n = kind ? kind.n : hits ? hits[c] || 0 : state.catCounts[c] || 0;
    const row = `<div class="cat-row${c === state.cat ? ' on' : ''}${open ? ' open' : ''}${hits && !n ? ' none' : ''}">`
      + `<button class="cat" data-cat="${c}" title="${esc(tr(ui.tip))}"><i class="gi" data-gi="${ui.icon}"></i><span class="lbl">${esc(tr(ui.label))}${kind ? `<small> · ${esc(kind.s)}</small>` : ''}</span><span class="n${hits ? ' hit' : ''}">${n.toLocaleString()}</span></button>`
      + (subs.length > 1 ? `<button class="more" data-more="${c}" aria-expanded="${open}" title="${open ? tr('Hide') : tr('Show')} its kinds">${CHEVRON}</button>` : '<span class="more"></span>')
      + '</div>';
    if (!open) return row;
    return row + `<div class="cat-subs">${subs.map((x) => `<button class="sub${c === state.cat && state.sub === x.s ? ' on' : ''}${hits && !x.n ? ' none' : ''}" data-parent="${c}" data-sub="${esc(x.s)}" title="${esc(tr(ui.label))}: ${esc(tr(x.s))}"><span class="lbl">${esc(tr(x.s))}</span><span class="n${hits ? ' hit' : ''}">${x.n.toLocaleString()}</span></button>`).join('')}</div>`;
  }).join('');
  hydrateIcons($('cats'));
}

// ---- part names: the in-game names from names.json, or the user's own ----
// builtin: model path -> { name, confidence }; folders: titles of folders that hold several different
// parts; mains: the model a folder opens with when the file-name rule would pick an outdated one.
const names = { builtin: {}, user: {}, folders: {}, mains: {}, zh: null, gen: 0 };
async function loadNames() {
  let doc = {};
  try { doc = await (await fetch('names.json', { cache: 'no-store' })).json(); } catch { /* no names */ }
  names.builtin = doc.parts || {};
  names.folders = doc.folders || {};
  names.mains = doc.mains || {};
  await loadZhNames();
  await loadPaintZh();
  await loadMapZh();
  await loadModesZh();
  names.user = { ...(state.settings.partNames || {}) };
  names.gen++;
}
// Chinese part names: an optional layer over the English ones (names.zh.json, a plain file in ui\:
// edit it, click the button in the top bar, and the new names are there: no rebuild, no restart).
// Every entry is optional; no file at all is fine too.
async function loadZhNames() {
  names.zh = null;
  try {
    const z = await (await fetch('names.zh.json', { cache: 'no-store' })).json();
    names.zh = { parts: z.parts || {}, dirs: z.dirs || {}, folders: z.folders || {} };
  } catch { /* English names only */ }
}

// 喷漆的中文名：又一层（paints.zh.json）。图鉴里的「图案」就是游戏里的喷漆，
// 只收能在游戏本地化表里找到对应键的那部分；没有的保持英文（名字只在加密数据里）。
let paintZh = null;
async function loadPaintZh() {
  paintZh = null;
  try {
    const z = await (await fetch('paints.zh.json', { cache: 'no-store' })).json();
    paintZh = { patterns: z.patterns || {}, chameleons: z.chameleons || {} };
  } catch { /* English names only */ }
}
// 地图的中文名（maps.zh.json）：levels/maps 下的文件夹名 → 官方 MAP_TITLE_* 的中文。
// 与部件名同一个开关：关掉顶栏的「中文名」，地图名也一起回到英文。
let mapsZh = null;
async function loadMapZh() {
  mapsZh = null;
  try {
    const z = await (await fetch('maps.zh.json', { cache: 'no-store' })).json();
    mapsZh = z.maps || {};
  } catch { /* 只有英文地图名 */ }
}

// 游戏模式与节日的中文名（modes.zh.json）：场景里 GameplaysList / FestivalsList 的标识 → 官方文本。
let modesZh = null;
async function loadModesZh() {
  modesZh = null;
  try {
    const z = await (await fetch('modes.zh.json', { cache: 'no-store' })).json();
    modesZh = { gameplays: z.gameplays || {}, festivals: z.festivals || {} };
  } catch { /* 只有英文模式名 */ }
}
// 一个模式标识 → 显示名：有中文用中文，否则上游的写法（下划线换空格）
function modeName(id) {
  if (!id) return tr('Any');
  const cn = wantZh() && modesZh && modesZh.gameplays[id];
  return cn || id.replace(/_/g, ' ');
}
// 一个节日标识 → 显示名（Empty 上游写作 None）
function festivalName(id) {
  if (id === 'Empty') return tr('None');
  const cn = wantZh() && modesZh && modesZh.festivals[id];
  return cn || id;
}
function applyPaintZh() {
  const c = state.paintCatalog;
  if (!c) return;
  const on = wantZh();
  for (const [key, list] of [['patterns', c.patterns], ['chameleons', c.chameleons]]) {
    const zh = paintZh && paintZh[key];
    for (const it of list) {
      if (!it.en) { it.en = it.name; it.game0 = !!it.game; } // (the English name and whether the game itself has one)
      const cn = on && zh ? zh[it.stem] : '';
      it.name = cn || it.en;
      it.game = it.game0 || !!cn; // (a name the game has: no "file name only" note)
    }
  }
}
// Show the Chinese names? A setting of its own: the interface's language and the parts' names are
// two different wishes (an English UI with Chinese part names is a normal one).
// (on by default when names.zh.json is there: this build is for a Chinese reader; the button turns it off
// and the choice is kept)
const wantZh = () => state.settings.zhNames !== false && !!names.zh;
// The Chinese name of a model path: its own entry, else its folder's (a part's skins, drones and
// pieces are separate files that share one name: writing the folder once covers them all).
function zhName(path) {
  const z = names.zh;
  if (!z) return null;
  if (z.parts[path]) return z.parts[path];
  for (let d = dirOf(path), i = 0; d && i < 6; i++) {
    if (z.dirs[d]) return z.dirs[d];
    const cut = d.lastIndexOf('/');
    if (cut < 0) break;
    d = d.slice(0, cut);
  }
  return null;
}
// Your own name > the Chinese name > the game's English name > the file name.
function partName(path) { return names.user[path] || (wantZh() && zhName(path)) || names.builtin[path]?.name || null; }
function nameOrFile(path) { return partName(path) || stem(path); }
const plainName = (n) => n.replace(/ (·|\().*$/, ''); // "Ghost", not "Ghost (before 2021)" or "Ghost · kit"
// A folder row: the part's plain name. A folder of several different parts (not just one part's
// skins, drones and pieces) takes its title from names.json, else lists them: "Stronghold / Frontier".
// A folder whose parts all have the same name keeps it whole ("Contact 2M (old model)").
function folderName(f) {
  if (f.labelGen === names.gen) return f.label;
  f.labelGen = names.gen;
  if (wantZh() && names.zh?.folders[f.dir]) return (f.label = names.zh.folders[f.dir]);
  if (names.folders[f.dir]) return (f.label = names.folders[f.dir]);
  const all = new Set(f.models.map(partName).filter(Boolean));
  if (all.size === 1) return (f.label = [...all][0]);
  const main = partName(f.main);
  const bases = main ? [plainName(main)] : [];
  const same = (a, b) => a === b || a.startsWith(b + ' ') || b.startsWith(a + ' ');
  for (const m of f.models) {
    const n = partName(m);
    if (n && !bases.some((b) => same(b, plainName(n)))) bases.push(plainName(n));
  }
  if (!bases.length) return (f.label = null);
  return (f.label = bases.length > 3 ? bases.slice(0, 3).join(' / ') + ' …' : bases.join(' / '));
}
function setPartName(path, name) {
  name = (name || '').trim();
  const base = (wantZh() && zhName(path)) || names.builtin[path]?.name; // (the name before any of yours)
  if (name && name !== base) names.user[path] = name; else delete names.user[path];
  names.gen++;
  call('setSettings', { partNames: names.user }).catch(() => {});
  rebuildRows();
  if (state.info?.path === path) renderInspector();
  renderBuildPanel();
}

// The Chinese part names on or off (the Language menu, when ui\\names.zh.json is there). Kept in the settings.
function syncZhBtn() {
  $('zhNamesWrap').hidden = !names.zh;
  $('zhNamesChk').checked = wantZh();
}
function setZhNames(on) {
  state.settings.zhNames = !!on;
  call('setSettings', { zhNames: state.settings.zhNames }).catch(() => {});
  names.gen++; // (folder titles are cached by it: they change with the names)
  syncZhBtn();
  rebuildRows();
  if (state.info) renderInspector();
  renderBuildPanel();
  applyPaintZh(); // (the paints follow the same switch)
  renderMapList(); // (the maps' names follow it too: the list is built once, so build it again)
  if (state.view === 'map') renderMapPanel(); // (the mode and festival menus follow it as well)
  viewPicker.refresh();
  buildPicker.refresh();
}

// ---- 界面语言: the Language button beside Bug report and its menu -------------------------------
function syncLangBtn() {
  $('langName').textContent = getLang() === 'zh' ? '简体中文' : LANG_NAMES[getLang()];
  for (const b of $('langMenu').querySelectorAll('[data-lang]')) {
    b.classList.toggle('on', b.dataset.lang === getLang());
    b.setAttribute('aria-checked', String(b.dataset.lang === getLang()));
  }
}
function showLangMenu(on) {
  const m = $('langMenu');
  if (on) {
    const r = $('langBtn').getBoundingClientRect();
    m.hidden = false;
    m.style.top = `${Math.round(r.bottom + 4)}px`;
    m.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - m.offsetWidth - 8)))}px`;
    syncLangBtn();
    syncZhBtn();
    m.querySelector('button.on[data-lang]')?.focus(); // (the keyboard starts on the language in use)
  } else {
    const back = m.contains(document.activeElement); // (chosen or closed from inside: back to the button)
    m.hidden = true;
    if (back) $('langBtn').focus();
  }
  $('langBtn').classList.toggle('on', on);
  $('langBtn').setAttribute('aria-expanded', String(!!on));
}
// Switches the whole interface: the static chrome (i18n's walk over index.html), then everything the
// code builds (the parts list, the inspector, the build panel) is drawn again through t().
function setUiLang(l) {
  const last = lastStatus; // (before anything below writes a line of its own)
  state.settings.uiLang = setLang(l);
  call('setSettings', { uiLang: state.settings.uiLang }).catch(() => {});
  applyStatic(document.body, hydrateIcons);
  syncLangBtn();
  syncZhBtn(); // (its label and tooltip are words too: they follow the interface's language)
  rebuildRows();
  if (state.info) renderInspector();
  renderBuildPanel();
  syncSaveState(); // (the file line under the build's name)
  renderGarage(); // (the energy bar and the stats: drawn in code)
  viewPicker.refresh(); // (the paint pickers too: switching back left "无涂装" in English)
  buildPicker.refresh();
  // the rest the code wrote in words: the game's tooltips, the search box, the 3D Viewer's LOD menu and
  // gun card, the checklist, the sticker packs, the maps' list, panel and keys, the status line
  if (state.lastGame) showGame(state.lastGame);
  syncSearchPlaceholder();
  if (state.info) { renderViewTools(); renderAnimCard(); }
  renderChecklist();
  if (stickerPackList) fillStickers();
  if ($('mapList').innerHTML) renderMapList(); // (once it was drawn: before, it says what it waits for)
  $('mapKeys').innerHTML = '';
  if (mapView.scene) renderMapSpeed();
  renderMapPanel();
  // (a line given in English comes again in the new language; one the code had already put into the old
  // language goes, unless it is an error or one that stays)
  if (last && (last.error || last.sticky || !/[\u3000-\u9fff]/.test(last.text))) status(last.text, last.error, last.sticky);
  else status('');
  syncMapView?.();
}

function rebuildRows() {
  const q = state.query.trim().toLowerCase();
  const rows = [];
  if (state.mode === 'files') {
    const view = q ? state.files.filter((f) => f.name.includes(q)) : state.files;
    state.filesView = view;
    for (const f of view) rows.push({ type: 'file', name: f.name, size: f.size });
    updateFilesBar();
  } else {
    const folders = [...state.folders.values()].filter((f) => (state.cat === 'All' ? f.cat !== 'Map props' || q : f.cat === state.cat && (!state.sub || subOf(f) === state.sub)));
    const label = (f) => (folderName(f) || f.name).toLowerCase();
    folders.sort((a, b) => label(a).localeCompare(label(b)) || a.dir.localeCompare(b.dir));
    // (the Chinese name too, even while it is not shown; and the English name even while Chinese is:
    // typing "scorpion" should find 天蝎)
    const matches = (m) => m.includes(q)
      || (partName(m) || '').toLowerCase().includes(q)
      || (zhName(m) || '').includes(q)
      || (names.builtin[m]?.name || '').toLowerCase().includes(q)
      || (names.user[m] || '').toLowerCase().includes(q);
    const folderHit = (f) => f.dir.includes(q) || label(f).includes(q); // (its title too: "Lightweight frames")
    // matches in every category, for the pills and for a search that finds nothing here
    state.catHits = null;
    state.subHits = null;
    if (q) {
      const hits = {}, subs = {};
      for (const f of state.folders.values()) {
        const n = f.models.filter(matches).length || (folderHit(f) ? f.models.length : 0);
        if (n) {
          hits[f.cat] = (hits[f.cat] || 0) + n; hits.All = (hits.All || 0) + n;
          const o = (subs[f.cat] ||= {}), s = subOf(f);
          o[s] = (o[s] || 0) + n;
        }
      }
      state.catHits = hits;
      state.subHits = subs;
    }
    renderCats();
    for (const f of folders) {
      const hits = q ? f.models.filter(matches) : f.models;
      if (q && !hits.length && !folderHit(f)) continue;
      const open = state.expanded.has(f.dir) || (q && hits.length && hits.length <= 40 && !state.collapsed.has(f.dir));
      rows.push({ type: 'folder', f, open, hits: hits.length });
      if (open) for (const m of q && hits.length ? hits : f.models) rows.push({ type: 'model', path: m, f });
    }
  }
  state.rows = rows;
  renderList();
}

function updateFilesBar() {
  $('filesCount').textContent = `${state.filesView.length.toLocaleString()} files${state.checked.size ? ` · ${state.checked.size} checked` : ''}`;
  $('extractBtn').disabled = state.checked.size === 0;
}

function currentPath() { return state.view === 'build' ? build.placing?.path || null : state.selected; }

function rowHtml(r, i, at = null) {
  const top = at ? at.top : i * ROW;
  const cur = currentPath();
  if (r.type === 'folder') {
    const whole = state.view === 'part' && state.assembled && cur === r.f.main; // (the part with what goes on it: the folder's row)
    const sel = (!r.open && cur && dirOf(cur) === r.f.dir) || whole ? ' sel' : '';
    const sub = r.f.dir.replace(/^models\/(constructor\/)?/, '').replace(/\/[^/]+$/, '');
    const nm = folderName(r.f);
    const n = r.f.models.length, shown = state.query && r.hits && r.hits < n ? r.hits : n;
    const badgeTip = `${n} model${n === 1 ? '' : 's'} in this folder${shown < n ? ` (${shown} match the search)` : ''}: the part, and its ${n > 1 ? 'other pieces (projectiles, wreck pieces, skins…)' : 'own model'}`;
    return `<div class="row-item${sel}" data-i="${i}" style="top:${top}px" title="${esc(r.f.dir)}"><span class="name">${esc(nm || r.f.name)}</span><span class="sub">${esc(nm ? r.f.name : sub)}</span><span class="badge" title="${esc(badgeTip)}">${shown < n ? `${shown}/${n}` : n}</span></div>`;
  }
  if (r.type === 'model') {
    const sel = cur === r.path && !(state.view === 'part' && state.assembled && r.f.main === r.path) ? ' sel' : '';
    const nm = partName(r.path);
    const box = at ? `;left:${at.left}px;width:${at.width}px` : '';
    return `<div class="row-item child${at ? ' in-strip' : ''}${sel}" data-i="${i}" style="top:${top}px;height:${ROW}px${box}" title="${esc(r.path)}"><span class="name">${esc(nm || stem(r.path))}</span>${nm ? `<span class="sub">${esc(stem(r.path))}</span>` : ''}</div>`;
  }
  const ext = r.name.slice(r.name.lastIndexOf('.') + 1);
  const chk = state.checked.has(r.name) ? ' checked' : '';
  const sel = cur === r.name || state.fileSel === r.name ? ' sel' : '';
  return `<div class="row-item${sel}" data-i="${i}" style="top:${top}px" title="${esc(r.name)} (${fmtBytes(r.size)})"><input type="checkbox" data-chk="${i}"${chk}><span class="kind">${esc(ext)}</span><span class="name">${esc(leaf(r.name))}</span><span class="sub">${esc(dirOf(r.name))}</span></div>`;
}

function renderList() {
  const wrap = $('listWrap'), list = $('list');
  const rows = state.rows;
  // (the list's height set once per mode: the cards' read their width first, and a wrong height
  // in between would pull the scroll back to it)
  if (state.mode !== 'parts' || !rows.length) list.style.height = rows.length * ROW + 'px';
  if (!rows.length) {
    const elsewhere = state.mode !== 'files' && state.catHits ? CATS.filter((c) => (c !== state.cat || state.sub) && c !== 'All' && state.catHits[c]) : []; // (a kind picked: its category's other kinds too)
    let msg;
    if (!state.files.length) msg = tr('No game data loaded.');
    else if (!elsewhere.length) msg = tr('Nothing matches.');
    else {
      const where = elsewhere.map((c) => `<a data-go-cat="${c}">${esc(catLabel(c))} (${state.catHits[c]})</a>`).join(', ');
      msg = tr('Nothing in {cat}{sub}. Found in: {where}', { cat: esc(catLabel(state.cat)), sub: state.sub ? ` (${esc(state.sub)})` : '', where });
    }
    list.innerHTML = `<div class="list-empty">${msg}</div>`;
    return;
  }
  if (state.mode === 'parts') { renderCards(wrap, list); return; }
  state.cardLayout = null;
  const first = Math.max(0, Math.floor(wrap.scrollTop / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((wrap.scrollTop + wrap.clientHeight) / ROW) + 8);
  let html = '';
  for (let i = first; i < last; i++) html += rowHtml(rows[i], i);
  list.innerHTML = html;
}

// ---- the parts as the game's cards ----
// Each folder a card (its part as the game shows it), as many across as fit; a folder opened (its
// skins and pieces) lists its models under the line of its card. Only the lines in view are drawn.
const CARD = { min: 142, h: 176, gap: 8, pad: 10 }; // least width, height, the gap between, the edge
const RARITY_NAME = { common: 'Common', base: 'Basic', rare: 'Rare', special: 'Special', epic: 'Epic', legendary: 'Legendary', relic: 'Relic' };
function cardLayout(width) {
  const cols = Math.max(1, Math.floor((width - 2 * CARD.pad + CARD.gap) / (CARD.min + CARD.gap)));
  const cw = Math.floor((width - 2 * CARD.pad - (cols - 1) * CARD.gap) / cols);
  const rows = state.rows, lines = [], at = new Map(); // (row -> its line)
  let y = CARD.pad, cur = null;
  const flush = () => { if (cur) { lines.push(cur); y += CARD.h + CARD.gap; cur = null; } };
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.type !== 'folder') continue;
    if (!cur) cur = { kind: 'cards', top: y, h: CARD.h, items: [] };
    at.set(i, cur);
    cur.items.push(i);
    const models = [];
    if (r.open && r.f.models.length > 1) for (let j = i + 1; j < rows.length && rows[j].type === 'model'; j++) models.push(j);
    if (cur.items.length === cols || models.length) flush();
    if (models.length) {
      const strip = { kind: 'strip', top: y, h: models.length * ROW + 8, items: models };
      for (const j of models) at.set(j, strip);
      lines.push(strip);
      y += strip.h + CARD.gap;
    }
  }
  flush();
  return { lines, at, cols, cw, height: Math.max(0, y - CARD.gap + CARD.pad), width };
}
function renderCards(wrap, list) {
  const L = (state.cardLayout = cardLayout(wrap.clientWidth || 300));
  list.style.height = L.height + 'px';
  const top = wrap.scrollTop - 300, bottom = wrap.scrollTop + wrap.clientHeight + 300;
  let html = '';
  for (const line of L.lines) {
    if (line.top + line.h < top || line.top > bottom) continue;
    if (line.kind === 'cards') line.items.forEach((i, k) => { html += cardHtml(state.rows[i], i, CARD.pad + k * (L.cw + CARD.gap), line.top, L.cw); });
    else {
      html += `<div class="card-strip" style="left:${CARD.pad}px;top:${line.top}px;width:${L.width - 2 * CARD.pad}px;height:${line.h}px"></div>`;
      line.items.forEach((i, k) => { html += rowHtml(state.rows[i], i, { top: line.top + 4 + k * ROW, left: CARD.pad + 1, width: L.width - 2 * CARD.pad - 2 }); });
    }
  }
  list.innerHTML = html;
  hydrateIcons(list);
  queueCardPics();
}
function cardHtml(r, i, x, y, w) {
  const f = r.f, cur = currentPath();
  const sel = cur && dirOf(cur) === f.dir ? ' sel' : ''; // (lit while any of its folder's models is open, as the game lights the part picked)
  const it = partStats.item(f.main), nm = folderName(f);
  const n = f.models.length, shown = state.query && r.hits && r.hits < n ? r.hits : n;
  const pic = cardPics.get(picKey(f.main));
  const tip = [nm || f.name, it ? [RARITY_NAME[it.rarity], it.type].filter(Boolean).join(' ') : '', f.dir].filter(Boolean).join('\n');
  const badgeTip = `${n} model${n === 1 ? '' : 's'} in this folder${shown < n ? ` (${shown} match the search)` : ''}: the part, and its other pieces (projectiles, wreck pieces, skins…)`;
  return `<div class="row-item card r-${it?.rarity || 'none'}${sel}" data-i="${i}" style="left:${x}px;top:${y}px;width:${w}px" title="${esc(tip)}">`
    + `<span class="name">${esc(nm || f.name)}</span>`
    + (pic ? `<img class="pic" src="${pic}" alt="" draggable="false">` : `<i class="gi pic ph" data-gi="${CAT_UI[f.cat]?.icon || 'icn_cubes_parts'}"></i>`)
    + `<span class="sub">${esc(nm ? f.name : it?.type || '')}</span>`
    + (n > 1 || shown < n ? `<span class="badge" title="${esc(badgeTip)}">${shown < n ? `${shown}/${n}` : n}</span>` : '')
    + '</div>';
}
// where a row is in the list now: its top and height (cards: its card's line, or its line in a strip)
function rowBox(i) {
  const L = state.mode === 'parts' && state.cardLayout;
  if (!L) return { top: i * ROW, h: ROW };
  const line = L.at.get(i);
  if (!line) return { top: 0, h: ROW };
  if (line.kind === 'strip') return { top: line.top + 4 + line.items.indexOf(i) * ROW, h: ROW };
  return { top: line.top, h: line.h };
}
// scrolls the list so that row i is in view (keyboard steps; the e2e)
function revealRow(i) {
  const wrap = $('listWrap'), b = rowBox(i);
  if (b.top < wrap.scrollTop || b.top + b.h > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = Math.max(0, b.top - (wrap.clientHeight - b.h) / 2);
  renderList();
}

// The cards' pictures: each part pictured once as built (viewer.thumbnail), while its card is on
// screen, one at a time; kept in the browser's storage between runs (per game version).
const cardPics = new Map(); // key -> data URL ('' : nothing to picture)
const PIC = 300; // its size (px, square: drawn at twice that, cut to the part, shrunk to fit it)
const picKey = (path) => `5|${state.gameVer || ''}|${path}`; // (4: the look matched to the game's cards; 5: wheels at their height)
// the picture cut to the part (its clear margins off, a little room left), so it fills the card
async function trimPic(url) {
  if (!url) return url;
  const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (d[(y * c.width + x) * 4 + 3] <= 12) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return url;
  const pad = 4, w = x1 - x0 + 1 + 2 * pad, h = y1 - y0 + 1 + 2 * pad;
  let src = document.createElement('canvas');
  src.width = w;
  src.height = h;
  src.getContext('2d').drawImage(c, x0 - pad, y0 - pad, w, h, 0, 0, w, h);
  // shrunk by halves to at most PIC across (smooth, no shimmer), then once more to fit
  let sw = w, sh = h;
  while (Math.max(sw, sh) > PIC * 2) {
    const half = document.createElement('canvas');
    half.width = Math.round(sw / 2);
    half.height = Math.round(sh / 2);
    const hg = half.getContext('2d');
    hg.imageSmoothingQuality = 'high';
    hg.drawImage(src, 0, 0, half.width, half.height);
    src = half; sw = half.width; sh = half.height;
  }
  const k = Math.min(1, PIC / Math.max(sw, sh)), o = document.createElement('canvas');
  o.width = Math.max(1, Math.round(sw * k));
  o.height = Math.max(1, Math.round(sh * k));
  const og = o.getContext('2d');
  og.imageSmoothingQuality = 'high';
  og.drawImage(src, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}
const picStore = (() => {
  let db = null;
  const open = () => (db ||= new Promise((ok, no) => {
    const q = indexedDB.open('xo-card-pictures', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('pics');
    q.onsuccess = () => ok(q.result);
    q.onerror = () => no(q.error);
  }));
  return {
    async get(k) { try { const d = await open(); return await new Promise((ok) => { const q = d.transaction('pics').objectStore('pics').get(k); q.onsuccess = () => ok(q.result ?? null); q.onerror = () => ok(null); }); } catch { return null; } },
    async put(k, v) { try { (await open()).transaction('pics', 'readwrite').objectStore('pics').put(v, k); } catch { /* no storage: pictured again next time */ } },
  };
})();
let picJobs = [], picRunning = false;
function queueCardPics() {
  if (state.view === 'map' || state.mode !== 'parts') return;
  const want = [];
  for (const el of $('list').querySelectorAll('.card')) {
    const r = state.rows[+el.dataset.i];
    if (r?.f && !cardPics.has(picKey(r.f.main)) && !want.includes(r.f.main)) want.push(r.f.main);
  }
  picJobs = want; // (what is on screen now: scrolled past, it waits)
  if (want.length && !picRunning) runCardPics();
}
async function runCardPics() {
  picRunning = true;
  try {
    while (picJobs.length && state.view !== 'map') {
      const path = picJobs.shift(), key = picKey(path);
      if (cardPics.has(key)) continue;
      let url = await picStore.get(key);
      if (url === null) {
        try { url = await viewer.iconPicture(await getInfo(path), { size: PIC, texMax: 1024 }); if (url) url = await trimPic(url); } catch { url = ''; }
        if (url === null) continue; // (its textures still loading: asked again when it is on screen)
        picStore.put(key, url || '');
      }
      cardPics.set(key, url || '');
      if (cardPics.size > 800) for (const k of [...cardPics.keys()].slice(0, 200)) cardPics.delete(k); // (the oldest go: kept in storage)
      if (url) for (const el of $('list').querySelectorAll('.card')) {
        if (state.rows[+el.dataset.i]?.f?.main !== path) continue;
        const ph = el.querySelector('.pic.ph');
        if (!ph) continue;
        const img = new Image();
        img.className = 'pic';
        img.alt = '';
        img.draggable = false;
        img.src = url;
        ph.replaceWith(img);
      }
    }
  } finally {
    picRunning = false;
  }
}

$('listWrap').addEventListener('scroll', () => requestAnimationFrame(renderList));
new ResizeObserver(() => renderList()).observe($('listWrap'));

// A build still loading (your last one coming back at start-up, or Open): parts to place wait for it
// (picked up first, the restore dropped them again).
async function afterBuildLoads() {
  if (!state.restoring && !state.loadingBuild) return;
  status('One moment: the build is still loading');
  await state.buildJob?.catch(() => {});
}

// Choosing a part: 3D viewer opens it, the builder puts it on the cursor.
// What the game shows on a part's nodes, read from its folder (the game's own list of it is in its
// encrypted archives): a launcher's loaded projectiles on its deploy points, as in the garage (the
// Porcupine's two barrels). The main model's nodes named deploy, deploy_01 ... take
//   - the folder's models made for them ("wheel_bomb_deploy"; "…_deploy_02" on deploy_02), else
//   - its one projectile: a smaller model that is not a wreck, broken piece, flying or stuck copy,
//     charge or effect (or, of several, the one named after the weapon with the shortest name; of
//     numbered variants of one, "bullet1" / "bullet2" for two ammo types, the first).
// [] when nothing fits; each entry { path, node, nodeName }.
const assemblies = new Map(); // folder dir -> Promise<[...]>
function folderAssembly(f) {
  if (!f) return Promise.resolve([]);
  let a = assemblies.get(f.dir);
  if (!a) assemblies.set(f.dir, (a = computeAssembly(f).catch(() => [])));
  return a;
}
async function computeAssembly(f) {
  const main = await getInfo(f.main);
  const deploy = (main.nodes || []).map((n, i) => ({ i, name: n.name })).filter((n) => /^deploy(_?\d+)?$/i.test(n.name));
  if (!deploy.length) return [];
  const skip = /(wreck|_bp\d|brpart|_fly$|_fly_|_stuck|charge|_exp$|destroy|digits|emission|_part_|_eng$|copy|_col$)/i;
  let cands = f.models.filter((m) => m !== f.main && !skip.test(stem(m)));
  const size = (i) => Math.hypot(...i.bbMax.map((v, k) => v - i.bbMin[k]));
  const infos = await Promise.all(cands.map((m) => getInfo(m).catch(() => null)));
  cands = cands.filter((m, k) => infos[k] && size(infos[k]) < size(main) * 0.8); // (a skin of the weapon itself is as big as it)
  const num = (t) => { const m = /(\d+)$/.exec(t); return m ? +m[1] : null; };
  const made = cands.filter((m) => /_deploy(_?\d+)?$/i.test(stem(m)));
  if (made.length) {
    const out = [];
    for (const m of made) {
      const n = /_deploy_?(\d+)$/i.test(stem(m)) ? num(stem(m)) : null;
      for (const d of deploy) if (n === null || num(d.name) === n) out.push({ path: m, node: d.i, nodeName: d.name });
    }
    return out;
  }
  let pick = cands.length === 1 ? cands[0] : null;
  if (!pick) {
    const own = cands.filter((m) => stem(m).startsWith(stem(f.main) + '_')).sort((a, b) => stem(a).length - stem(b).length || (num(stem(a)) ?? 0) - (num(stem(b)) ?? 0));
    const plain = (m) => stem(m).replace(/_?\d+$/, '');
    if (own.length === 1 || (own.length > 1 && stem(own[0]).length < stem(own[1]).length)) pick = own[0];
    // numbered variants of one projectile (two ammo types, "bullet1" / "bullet2"): the first
    else if (own.length > 1 && num(stem(own[0])) !== null && own.every((m) => plain(m) === plain(own[0]))) pick = own[0];
  }
  return pick ? deploy.map((d) => ({ path: pick, node: d.i, nodeName: d.name })) : [];
}

async function choosePart(path, { assembled = false } = {}) {
  if (state.view === 'build') {
    await afterBuildLoads();
    if (state.view !== 'build') return;
    build.startPlacing(path).then(renderList, (e) => status(e.message, true));
    renderList();
  } else {
    openModel(path, { assembled });
  }
}

$('list').addEventListener('click', (e) => {
  const chk = e.target.closest('[data-chk]');
  const item = e.target.closest('.row-item');
  if (!item) return;
  const r = state.rows[+item.dataset.i];
  if (!r) return;
  if (chk) {
    if (chk.checked) state.checked.add(r.name); else state.checked.delete(r.name);
    updateFilesBar();
    return;
  }
  if (r.type === 'folder') {
    if (r.open) {
      state.expanded.delete(r.f.dir);
      if (state.query) state.collapsed.add(r.f.dir); // also closes folders a search opened
    } else {
      state.expanded.add(r.f.dir);
      state.collapsed.delete(r.f.dir);
    }
    state.selectedDir = r.f.dir;
    rebuildRows();
    // (the folder's row: the part as the game shows it, its projectiles in place; its own row: alone)
    if (state.view === 'part' ? !(state.assembled && state.info?.path === r.f.main) : !r.open) choosePart(r.f.main, { assembled: true });
  } else if (r.type === 'model') {
    choosePart(r.path);
  } else if (r.type === 'file') {
    if (r.name.endsWith('.mdl')) choosePart(r.name);
    else if (r.name.endsWith('.tfh') || r.name.endsWith('.tfd')) showTexture(r.name.replace(/\.tf[hd]$/, ''));
    else { state.fileSel = r.name; renderList(); status(`${r.name} · ${fmtBytes(r.size)} · tick it and use "Extract checked…" to save it`); }
  }
});

$('list').addEventListener('click', (e) => { // "Found in: Weapons (3)" when the search finds nothing in this category
  const a = e.target.closest('[data-go-cat]');
  if (!a) return;
  state.cat = a.dataset.goCat;
  state.sub = null;
  state.catOpen = state.cat;
  renderCats();
  $('listWrap').scrollTop = 0;
  rebuildRows();
});
// The menu: a category picks it and opens its kinds (picked again: shuts them, all of it shown); its
// arrow only opens or shuts them; a kind shows that kind alone (again: the whole category)
$('cats').addEventListener('click', (e) => {
  const more = e.target.closest('[data-more]');
  if (more) {
    state.catOpen = state.catOpen === more.dataset.more ? null : more.dataset.more;
    renderCats();
    return;
  }
  const k = e.target.closest('[data-sub]');
  if (k) {
    const c = k.dataset.parent;
    state.sub = state.cat === c && state.sub === k.dataset.sub ? null : k.dataset.sub;
    state.cat = c;
  } else {
    const b = e.target.closest('button[data-cat]');
    if (!b) return;
    const c = b.dataset.cat;
    if (state.cat === c) state.catOpen = state.catOpen === c && !state.sub ? null : c;
    else state.catOpen = c;
    state.cat = c;
    state.sub = null;
  }
  renderCats();
  $('listWrap').scrollTop = 0;
  rebuildRows();
});

document.querySelector('.modes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b) return;
  state.mode = b.dataset.mode;
  document.querySelectorAll('.modes button').forEach((x) => x.classList.toggle('on', x === b));
  syncLeft(); // (parts: the menu and the cards; all files: the files alone)
  syncSearchPlaceholder();
  $('listWrap').scrollTop = 0;
  rebuildRows();
});
function syncSearchPlaceholder() {
  $('search').placeholder = state.mode === 'files' ? tr('Filter all files (Ctrl+F)') : tr('Search parts (Ctrl+F)');
}

let searchTimer = 0;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.query = $('search').value; state.collapsed.clear(); $('listWrap').scrollTop = 0; rebuildRows(); }, 120);
});

$('extractBtn').addEventListener('click', async () => {
  const paths = [...state.checked];
  try {
    const r = await call('extract', { paths });
    if (!r) return;
    status(`Extracted ${r.written} file(s) to ${r.dir}${r.errors.length ? ` · ${r.errors.length} failed` : ''}`, r.errors.length > 0);
  } catch (e) { status(e.message, true); }
});

// ---- main mode: 3D viewer / vehicle builder -----------------------------------------------------------
function setView(mode) {
  if (state.view === mode) return;
  gunfire.stop(); // (V held: its guns, hidden behind their firing copies, would be left out of a test drive)
  state.view = mode;
  crumb('view', mode);
  document.querySelectorAll('#mainMode button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
  viewer.setMode(mode);
  build.onModeChanged();
  build.setBrush(mode === 'build' && state.paintMode === 'brush'); // (its cursor only over the builder's view)
  if (mode !== 'build' && build.stickerTool) setStickerTool(null);
  refs.modeChanged(mode);
  mapView.modeChanged(mode);
  const part = mode === 'part', bld = mode === 'build', map = mode === 'map';
  if (bld && state.files?.length && (!stickerPackList || stickerPackList.files !== state.files)) fillStickers(); // (the game's stickers, once its files are read)
  $('viewTools').hidden = !part || !state.info;
  $('empty').hidden = !part || !!state.info;
  $('inspector').hidden = !part || !state.info;
  $('buildTools').hidden = !bld;
  $('buildHint').hidden = !bld;
  $('garageHud').hidden = !bld;
  if (!bld) { setPartsList(false); garageCam.clear(); }
  layoutCompact();
  $('buildEmpty').hidden = !bld || build.instances.length > 0 || !!build.placing || !!state.restoring || state.loadingBuild > 0; // the builder's empty-state card (not while a build loads)
  $('buildPanel').hidden = !bld;
  syncMapView();
  syncRight();
  syncLeft();
  embers.setEnabled(!map && $('bgSel').value === 'crossout'); // (the map has its own sky)
  if (part) syncTarget(); // (the training target comes back with the 3D Viewer while a gun fires)
  $('texPreview').hidden = true;
  $('hoverTip').hidden = true;
  if (bld) {
    // the last build comes back the first time the builder opens, once the game data is ready
    if (!state.buildRestored) { if (state.gameReady) restoreAutosave(); else state.restorePending = true; }
    renderBuildPanel();
    renderRefs();
    $('bTarget').value = String(typeof state.settings.fxTarget === 'number' ? state.settings.fxTarget : 10);
    if (!build.instances.length) build.frame();
  }
  if (map) {
    if (!state.map.list && state.gameReady) loadMapList();
    renderMapPanel();
    renderMapSpeed();
  }
  renderList();
}
// The left side: the parts / files list, or (Maps) the maps.
function syncLeft() {
  const map = state.view === 'map', parts = state.mode === 'parts';
  $('layout').classList.toggle('cards', !map && parts);
  $('layout').classList.toggle('files', !map && !parts);
  $('menuCol').hidden = map || !parts;
  $('partsCol').hidden = map;
  $('modesBar').hidden = map;
  $('cats').hidden = map || state.mode !== 'parts';
  $('searchRow').hidden = map;
  $('listHint').hidden = state.view !== 'build';
  $('listWrap').hidden = map;
  $('filesBar').hidden = map || state.mode !== 'files';
  $('mapSide').hidden = !map;
}
// The right column only while something is in it (the 3D Viewer has nothing there until a part
// opens); the view takes its room meanwhile. The viewer resizes at once: a part framed next fits
// the narrower view.
function syncRight(show = ['inspector', 'mapPanel', 'buildPanel'].some((id) => !$(id).hidden)) {
  if ($('right').hidden !== show) return;
  $('right').hidden = !show;
  viewer.resize();
}
function syncMapView() {
  const map = state.view === 'map', open = !!mapView.scene;
  $('mapTools').hidden = $('mapHud').hidden = !map || !open;
  $('mapEmpty').hidden = !map || open;
  $('mapPanel').hidden = !map;
  if (map) renderMapGun();
}

// The gun Maps fires (hold V): every weapon of the game that fires something, by its in-game name
// (a folder's main model stands for it), remembered.
function renderMapGun() {
  const sel = $('mpGun');
  if (!state.mapGuns && state.files?.length) {
    const byFolder = new Map();
    for (const f of state.files) {
      const m = /^models\/weapons\/([^/]+)\/([^/]+)\.mdl$/.exec(f.name);
      if (!m || m[1] === 'projectiles' || m[1] === 'crossbow_arrow') continue;
      if (!byFolder.has(m[1]) || m[2] === m[1]) byFolder.set(m[1], f.name);
    }
    state.mapGuns = [...byFolder.values()].filter((p) => shotFor(p) || muzzleFor(p)).map((p) => ({ path: p, name: nameOrFile(p) })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const want = state.settings.mapGun || MAP_GUN;
  if (sel.options.length !== (state.mapGuns?.length || 0)) sel.innerHTML = (state.mapGuns || []).map((g) => `<option value="${esc(g.path)}">${esc(g.name)}</option>`).join('');
  sel.value = want;
}
$('mpGun').addEventListener('change', () => {
  state.settings.mapGun = $('mpGun').value;
  call('setSettings', { mapGun: state.settings.mapGun }).catch(() => {});
  if (gunfire.on) { gunfire.stop(); gunfire.start(); } // (held V: the new gun takes over)
});
document.querySelectorAll('#mainMode button[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view))); // (Donations, Bug report: not views)

// ---- 3D viewer: one part --------------------------------------------------------------------------
let loadToken = 0;
async function openModel(path, { skin = '', lod = 0, keepCamera = false, assembled } = {}) {
  const token = ++loadToken;
  crumb('part', path);
  const assemble = assembled ?? (state.assembled && state.info?.path === path); // (another LOD or skin keeps it)
  const viewAtStart = state.view;
  loading(true, `Loading ${nameOrFile(path)}…`);
  $('texPreview').hidden = true;
  try {
    const info = await getInfo(path, skin);
    if (token !== loadToken) return false;
    if (state.view !== viewAtStart) return false; // (the user went to another view meanwhile: not pulled back)
    state.selected = path; // (the list shows the choice at once)
    state.fileSel = null;
    state.selectedDir = dirOf(path);
    renderList();
    if (state.view !== 'part') setView('part');
    // the part's state changes when it goes on screen, not before (Export, Add to build and the
    // inspector acted on the next part while the previous one was still shown)
    const partLod = Math.min(Math.max(0, lod), info.lodCount - 1);
    // what the game shows on its nodes (the folder's row asked for it): their models too
    const f = state.folders.get(dirOf(path));
    const assembly = assemble && f && f.main === path ? await folderAssembly(f) : [];
    const attInfo = await Promise.all(assembly.map((a) => getInfo(a.path).catch(() => null)));
    if (token !== loadToken) return false;
    const attachments = assembly.map((a, k) => ({ ...a, info: attInfo[k], label: partName(a.path) || stem(a.path) })).filter((a) => a.info);
    let before = null; // (the previous part's animator, set aside as it leaves the screen)
    let placed = null;
    const onScreen = new Promise((res) => (placed = res));
    const loaded = viewer.load(info, partLod, {
      keepCamera,
      attachments,
      onShown: () => {
        if (token !== loadToken) return;
        state.info = info;
        state.skin = info.skin;
        state.lod = partLod;
        state.assembly = attachments.map(({ path: p, node, nodeName }) => ({ path: p, node, nodeName }));
        state.assembled = attachments.length > 0;
        renderList(); // (the folder row or the part's own row lights up)
        before = state.animator;
        state.animator = null;
        if (state.view === 'part') syncRight(true); // (the first part: before it is framed)
      },
      onPlaced: (st) => placed(st),
    });
    // The panels follow the part as soon as it is on screen: they waited for every texture (up to
    // 15 s), while the header still named the last part and its menus fed into this one.
    const first = await Promise.race([onScreen, loaded]);
    if (token !== loadToken || !first) return false;
    state.stats = first;
    // animations: same part (other LOD / skin) keeps what was playing and the slider values
    const prev = before && before.path === info.path ? before : null;
    const anim = new Animator(viewer, info, viewer.part);
    anim.path = info.path;
    state.animator = null;
    if (anim.available) {
      await anim.load();
      if (token !== loadToken) return false;
      if (prev) {
        Object.assign(anim, { playing: prev.playing, speed: prev.speed, sweep: prev.sweep, time: prev.time });
        for (const k of Object.keys(anim.pose)) if (k in prev.pose) anim.pose[k] = prev.pose[k];
        if (prev.active === null || anim.layers.has(prev.active)) anim.active = prev.active;
        anim.apply();
      }
      anim.onPoseChange = syncPoseSliders;
      state.animator = anim;
    }
    renderAnimCard();
    weaponAim(info).then((aim) => { if (state.info === info) { $('arcWrap').hidden = !aim; syncArcSize(); } });
    if (state.view === 'part') {
      $('empty').hidden = true;
      $('viewTools').hidden = false;
      $('inspector').hidden = false;
    }
    renderViewTools();
    renderInspector();
    for (const [base, rep] of Object.entries(state.replace)) viewer.setReplacement(base, { id: rep.id });
    status(tr('{name}: {t} triangles, {m} mesh(es) in LOD {lod}', { name: nameOrFile(info.path), t: first.tris.toLocaleString(), m: first.meshes, lod: state.lod }));
    const stats = await loaded; // (its textures in: only the status line still waits for them)
    if (token !== loadToken || !stats) return true;
    state.stats = stats;
    const warn = stats.errors?.length ? tr(' · {n} texture(s) failed: {first}', { n: stats.errors.length, first: stats.errors[0] }) : '';
    status(tr('{name}: {t} triangles, {m} mesh(es) in LOD {lod}{warn}', { name: nameOrFile(info.path), t: stats.tris.toLocaleString(), m: stats.meshes, lod: state.lod, warn }), !!warn);
    return true;
  } catch (e) {
    if (token === loadToken) {
      if (state.info && state.selected !== state.info.path) { state.selected = state.info.path; renderList(); } // (the part shown stays the one chosen)
      status(e.message, true);
    }
    return false;
  } finally {
    loading(false);
  }
}

// Arrow-key browsing: the part after the one just opened is fetched in the background (geometry
// and textures into the caches), so the next key press shows it at once.
function prefetch(path) {
  getInfo(path).then((info) => viewer.prefetch(info, 0), () => {});
}

// ---- animation (3D viewer) ----
const fmtPose = (p, v) => (Math.abs(p.max - p.min) >= 10 ? Math.round(v) + (/aim|yaw|pitch|steer|rot/i.test(p.name) ? '°' : '') : v.toFixed(2));
// "Skeleton & animations" in the export card: for parts that move, in glTF (OBJ has no animation).
function syncAnimOption() {
  $('expAnimWrap').hidden = $('expPoseWrap').hidden = !state.animator?.animated; // (a part that only fires has no clips to export)
  $('expAnim').disabled = state.exportFmt === 'obj';
}

function renderAnimCard() {
  syncAnimOption();
  const a = state.animator;
  const heat = viewer.materials.some((m) => m.userData.xo.info.heat);
  $('animCard').hidden = !a && !heat;
  $('animControls').hidden = !a;
  $('animHint').hidden = !a?.animated;
  $('heatRow').hidden = $('heatHint').hidden = !heat;
  $('heatSlider').value = Math.round(state.heatUser * 100);
  $('heatVal').textContent = `${Math.round(state.heatUser * 100)}%`;
  renderFxRow(a);
  if (state.view === 'part') syncTarget(); // (the builder's target is firing.js's: setView('part') syncs this one on the way back)
  if (!a) return;
  const acts = a.activities();
  const dup = (act) => acts.filter((x) => x.activity === act).length > 1;
  $('animSel').innerHTML = `<option value="">${tr('Still')}</option>` +
    acts.map((l) => `<option value="${esc(l.name)}" ${l.name === a.active ? 'selected' : ''}>${esc(tr(l.label || prettyName(l.activity)))}${dup(l.activity) ? ' · ' + esc(l.name) : ''}</option>`).join('');
  $('animPlay').textContent = a.playing ? tr('Pause') : tr('Play');
  $('animSpeed').value = String(a.speed);
  const poses = a.poses();
  $('animPoses').innerHTML = poses.map((p) => `<div class="ar"><span title="${esc(p.name)}">${esc(tr(prettyName(p.name)))}</span>
    <input type="range" data-pose="${esc(p.name)}" min="${p.min}" max="${p.max}" step="any" value="${p.value}"><span class="val">${fmtPose(p, p.value)}</span></div>`).join('');
  $('animSweepWrap').hidden = !poses.length;
  $('animSweep').checked = a.sweep;
  $('animLookWrap').hidden = !poses.some((p) => p.name === 'AimYaw' || p.name === 'AimPitch');
  $('animLook').checked = state.lookAtMe;
}
function syncPoseSliders() {
  const a = state.animator;
  if (!a) return;
  for (const p of a.poses()) {
    const el = document.querySelector(`#animPoses [data-pose="${CSS.escape(p.name)}"]`);
    if (!el || document.activeElement === el) continue;
    el.value = p.value;
    el.nextElementSibling.textContent = fmtPose(p, p.value);
  }
}
$('animSel').addEventListener('change', () => {
  const a = state.animator;
  if (!a) return;
  a.setActive($('animSel').value);
  a.playing = true;
  renderAnimCard(); // (the sliders follow the picked activity's layers: the two-mode wheel's suspension range changes)
  if (!state.lookAtMe) viewer.frameRange({ unseen: true }); // (firing at the target: the camera behind the gun when the target is out of view)
});
$('animPlay').addEventListener('click', () => {
  const a = state.animator;
  if (!a) return;
  a.playing = !a.playing;
  if (!a.playing) viewer.stopShots(); // (a flamethrower's flow stops with the gun)
  renderAnimCard();
});
$('animSpeed').addEventListener('change', () => { if (state.animator) state.animator.speed = +$('animSpeed').value; });

// Firing effects: when a Fire activity plays, the gun's muzzle flash, smoke and sparks (the game's
// own .psys effects, fx.js) come out of its fire points. Which effect a gun uses is matched by name
// (fxmap.js); the menu picks another one or none, remembered per part.
const fxShort = (p) => p.replace(/^particles\/(weapons\/)?/, '');
function fxPickOf(path) { return (state.settings.fxPick || {})[path] || ''; }
viewer.fxFor = (path) => {
  const pick = fxPickOf(path);
  return pick === 'off' ? null : pick || muzzleFor(path);
};
viewer.shotFor = (path, act) => (fxPickOf(path) === 'off' ? null : shotFor(path, act)); // (the rounds, their tracers and hits; act: a second fire mode's)
viewer.soundFor = (path, act) => gunSound(path, act, shotFor(path, act)?.kind); // (its shots' sound: soundmap.js)
viewer.activitySoundFor = (path, act, layer) => activitySound(path, act, layer, shotFor(path)?.kind); // (its reloads, charges, a saw's attack)
// Sound: the game's own sounds for the gun's shots, its hits and blasts, this loud (one setting)
const fxVolume = () => (typeof state.settings.fxVolume === 'number' ? state.settings.fxVolume : 0.7);
// (the same slider in the 3D Viewer's Animation card and the builder's and Maps' Fire cards)
const VOLUMES = ['fxVolume', 'bVolume', 'mVolume'];
function showVolume() {
  for (const id of VOLUMES) {
    $(id).value = String(Math.round(fxVolume() * 100));
    $(id + 'Val').textContent = fxVolume() > 0 ? Math.round(fxVolume() * 100) + '%' : 'off';
  }
}
for (const id of VOLUMES) {
  $(id).addEventListener('input', () => {
    state.settings.fxVolume = +$(id).value / 100;
    viewer.sounds.setVolume(fxVolume());
    showVolume();
  });
  $(id).addEventListener('change', () => call('setSettings', { fxVolume: fxVolume() }).catch(() => {}));
}
// Shot every: the shot timer, seconds from one shot to the next (the 3D Viewer's Fire, the builder's and
// Maps' V: anim.js gunBeat); empty or 0: each gun as in the game, once per its reload time (a rocket pod
// a salvo), what fires non-stop at its own pace. One setting, as Sound.
const EVERY = ['fxEvery', 'bEvery', 'mEvery'];
const fireEvery = () => { const v = +state.settings.fireEvery; return Number.isFinite(v) && v > 0 ? v : 0; };
viewer.reloadOf = (path) => partStats.item(path)?.reload || 0; // (the game's: stats.json)
function showEvery() {
  viewer.fireEvery = fireEvery();
  for (const id of EVERY) if (document.activeElement !== $(id)) $(id).value = fireEvery() ? String(fireEvery()) : '';
  // (empty: the 3D Viewer's says what its gun does then)
  const r = viewer.reloadOf(state.info?.path);
  $('fxEvery').placeholder = r >= 1 ? tr('game: {r}', { r }) : tr('own pace');
}
for (const id of EVERY) {
  $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value);
    state.settings.fireEvery = Number.isFinite(v) && v > 0 ? Math.min(600, Math.max(0.1, Math.round(v * 100) / 100)) : 0;
    $(id).value = fireEvery() ? String(fireEvery()) : '';
    showEvery();
    state.animator?.restartFire(); // (the next shot at once, then on the new beat)
    call('setSettings', { fireEvery: state.settings.fireEvery }).catch(() => {});
    status(fireEvery() ? tr('A shot every {s} s', { s: fireEvery() }) : 'Each gun fires as in the game again: once per its reload time');
  });
}
// Shots hit: the training target that far down-range (stood there while a Fire activity is picked),
// or only the ground; one setting for every gun.
const firingPicked = () => { const a = state.animator; return !!(a?.active && /^(ACT_)?FIRE|^BURST/i.test(a.layers.get(a.active)?.activity || '')); };
function syncTarget() {
  const dist = typeof state.settings.fxTarget === 'number' ? state.settings.fxTarget : 10;
  const guns = !$('fxRow').hidden && !!viewer.shotFor(state.info?.path);
  const firing = state.view === 'part' && guns && firingPicked();
  if (firing) viewer.preloadShots(state.info); // (the first shot then has its effects and model)
  viewer.setTarget(firing ? dist : 0);
}
$('fxTarget').addEventListener('change', () => {
  state.settings.fxTarget = +$('fxTarget').value;
  call('setSettings', { fxTarget: state.settings.fxTarget }).catch(() => {});
  syncTarget();
  if (!state.lookAtMe) viewer.frameRange({ unseen: true });
});
// the builder's Fire card: the same setting; the target moves (or goes) at once where it stands
$('bTarget').addEventListener('change', () => {
  state.settings.fxTarget = +$('bTarget').value;
  $('fxTarget').value = $('bTarget').value;
  call('setSettings', { fxTarget: state.settings.fxTarget }).catch(() => {});
  if (state.view === 'build' && viewer.target?.visible) viewer.setTarget(state.settings.fxTarget);
});
function renderFxRow(a) {
  const info = state.info;
  const guns = !!(a && firePointsOf(info?.nodes).length);
  $('fxRow').hidden = !guns;
  if (!guns) { $('fxTargetRow').hidden = $('fxEveryRow').hidden = true; $('fxSoundRow').hidden = !(a && meleeSound(info?.path)); if (!$('fxSoundRow').hidden) { viewer.sounds.setVolume(fxVolume()); showVolume(); } return; }
  const pick = fxPickOf(info.path), auto = muzzleFor(info.path);
  state.fxChoices ||= muzzleChoices(state.files.map((f) => f.name));
  $('fxSel').innerHTML = `<option value="">${auto ? tr('Matched: {name}', { name: esc(fxShort(auto)) }) : tr('Matched: none')}</option><option value="off">${tr('Off')}</option>`
    + `<optgroup label="${tr('All muzzle effects')}">${state.fxChoices.map((c) => `<option value="${esc(c)}">${esc(fxShort(c))}</option>`).join('')}</optgroup>`;
  $('fxSel').value = pick;
  $('fxTargetRow').hidden = !viewer.shotFor(info.path);
  $('fxEveryRow').hidden = false;
  showEvery();
  $('fxTarget').value = String(typeof state.settings.fxTarget === 'number' ? state.settings.fxTarget : 10);
  $('fxSoundRow').hidden = !viewer.soundFor(info.path);
  viewer.sounds.setVolume(fxVolume());
  showVolume();
}
$('fxSel').addEventListener('change', () => {
  const path = state.info?.path;
  if (!path) return;
  const fxPick = { ...(state.settings.fxPick || {}) };
  if ($('fxSel').value) fxPick[path] = $('fxSel').value; else delete fxPick[path];
  state.settings.fxPick = fxPick;
  call('setSettings', { fxPick }).catch(() => {});
  viewer.stopShots();
  viewer.fx.clear();
  renderFxRow(state.animator);
  syncTarget();
});
$('animSweep').addEventListener('change', () => {
  if (state.animator) state.animator.sweep = $('animSweep').checked;
  if ($('animSweep').checked && state.lookAtMe) setLookAtMe(false);
});
// Look at me: a gun (or a searchlight, a drone's gun ...) keeps turning to face the camera, as far as
// it can turn (Animator.lookAt). One setting for every part, remembered; moving its aim sliders by
// hand, or "Move these on their own", turns it off.
state.lookAtMe = false;
function setLookAtMe(on, save = true) {
  state.lookAtMe = on;
  $('animLook').checked = on;
  if (on && state.animator?.sweep) { state.animator.sweep = false; $('animSweep').checked = false; }
  if (save) call('setSettings', { lookAtMe: on }).catch(() => {});
}
$('animLook').addEventListener('change', () => setLookAtMe($('animLook').checked));
$('animPoses').addEventListener('input', (e) => {
  const el = e.target.closest('[data-pose]');
  const a = state.animator;
  if (!el || !a) return;
  if (state.lookAtMe && (el.dataset.pose === 'AimYaw' || el.dataset.pose === 'AimPitch')) setLookAtMe(false);
  a.setPose(el.dataset.pose, +el.value);
  const p = a.poses().find((x) => x.name === el.dataset.pose);
  el.nextElementSibling.textContent = fmtPose(p, +el.value);
});
// Barrel heat: weapons' heat-glow maps are dark at rest. The slider sets a steady glow (also used by
// the export); while the FIRE animation plays the barrels warm up on top of it and cool down after.
state.heatUser = 0;
state.fireHeat = 0;
$('heatSlider').addEventListener('input', () => {
  state.heatUser = +$('heatSlider').value / 100;
  $('heatVal').textContent = `${$('heatSlider').value}%`;
});
const firing = () => { const a = state.animator; return !!(a && a.playing && a.active && a.layers.get(a.active)?.activity === 'FIRE'); };
let animClock = performance.now();
viewer.frameHooks.push(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - animClock) / 1000);
  animClock = now;
  if (state.view === 'part') state.animator?.tick(dt);
  viewer.fxSpeed = state.animator?.playing ? state.animator.speed : 1; // (effects slow down with the animation)
  if (state.lookAtMe && state.view === 'part' && state.animator?.lookAt(viewer.camera.position, dt)) syncPoseSliders();
  const hot = state.view === 'part' && firing();
  state.fireHeat = Math.min(1, Math.max(0, state.fireHeat + (hot ? dt / 2.5 : -dt / 4))); // 2.5 s to overheat, 4 s to cool
  viewer.setHeat(state.view === 'part' ? Math.max(state.heatUser, state.fireHeat) : 0); // (the 3D Viewer's heat: the builder's barrels are cold, as in the garage)
});

function renderViewTools() {
  const info = state.info;
  $('lodSel').innerHTML = Array.from({ length: info.lodCount }, (_, i) => `<option value="${i}" ${i === state.lod ? 'selected' : ''}>${i === 0 ? tr('{n} (best)', { n: i }) : i}</option>`).join('');
  const skins = info.skins.filter((s) => s.exists).map((s) => s.name);
  // (skins without a "default" entry: the look on screen is a choice too, or the menu showed the
  // first skin while the own look was on, and there was no way back to it)
  if (!skins.includes(state.skin)) skins.unshift(state.skin);
  $('skinWrap').hidden = skins.length < 2;
  $('skinSel').innerHTML = skins.map((n) => `<option value="${esc(n)}" ${n === state.skin ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

$('lodSel').addEventListener('change', () => state.info && openModel(state.info.path, { skin: state.skin, lod: +$('lodSel').value, keepCamera: true }));
$('skinSel').addEventListener('change', () => state.info && openModel(state.info.path, { skin: $('skinSel').value, lod: state.lod, keepCamera: true }));
for (const [id, key] of [['optTextures', 'textures'], ['optWire', 'wireframe'], ['optPivots', 'pivots'], ['optGrid', 'grid']])
  $(id).addEventListener('change', () => { viewer.setOption(key, $(id).checked); syncToggles(); });
// 3D Viewer: the part's weld points and a weapon's firing arc, each on its own switch. The builder
// has the garage's augmented reality instead (F): the vehicle's weld points and firing arcs together.
// Soft shadows: one setting for both views. All remembered.
function setWelds(on, save = true) {
  viewer.setOption('slots', on);
  $('optSlots').checked = on;
  if (save) call('setSettings', { welds: on }).catch(() => {});
}
function setShadows(on, save = true) {
  viewer.setShadows(on);
  if (state.view === 'map') mapView.needsBucket = true; // (the sun's shadow follows the camera there)
  $('optShadows').checked = $('bShadows').checked = $('mShadows').checked = on;
  if (save) call('setSettings', { shadows: on }).catch(() => {});
}
$('optSlots').addEventListener('change', () => setWelds($('optSlots').checked));
$('optShadows').addEventListener('change', () => setShadows($('optShadows').checked));
function setArcs(on, save = true) {
  viewer.setOption('arcs', on);
  $('optArcs').checked = on;
  syncArcSize();
  if (save) call('setSettings', { arcs: on }).catch(() => {});
}
$('optArcs').addEventListener('change', () => setArcs($('optArcs').checked));
// Arc size and Cones: one setting each for the 3D Viewer's arc and the builder's (Aug. reality).
// The size is times each weapon's size; the 3D Viewer shows the radius it makes for the part on
// screen. Cones: the ones that close an arc above its highest and below its lowest tilt (a gun that
// cannot turn has none: no switch for it). Remembered.
function syncArcSize() {
  const f = viewer.arcSize, arc = viewer.arc;
  $('arcSize').value = $('bArcSize').value = String(f);
  $('arcSizeWrap').hidden = $('arcWrap').hidden || !$('optArcs').checked;
  $('arcSizeVal').textContent = arc ? `${(arc.userData.base * f).toFixed(arc.userData.base * f < 10 ? 1 : 0)} m` : '';
  $('arcConesWrap').hidden = $('arcSizeWrap').hidden || !arc?.userData.cones;
  $('arcCones').checked = $('bArcCones').checked = viewer.arcCones;
  $('bArcSizeWrap').hidden = $('bArcConesWrap').hidden = !state.ar;
  $('bArcSizeVal').textContent = `${Math.round(f * 100)}%`;
}
function setArcSize(f, save = true) {
  viewer.setArcSize(Math.min(ARC_SIZE.max, Math.max(ARC_SIZE.min, f)));
  syncArcSize();
  if (save) call('setSettings', { arcSize: viewer.arcSize }).catch(() => {});
}
for (const id of ['arcSize', 'bArcSize']) {
  $(id).addEventListener('input', () => setArcSize(+$(id).value, false));
  $(id).addEventListener('change', () => setArcSize(+$(id).value)); // (saved when let go)
}
function setArcCones(on, save = true) {
  viewer.setArcCones(on);
  syncArcSize();
  if (save) call('setSettings', { arcCones: on }).catch(() => {});
}
for (const id of ['arcCones', 'bArcCones']) $(id).addEventListener('change', () => setArcCones($(id).checked));
$('bShadows').addEventListener('change', () => setShadows($('bShadows').checked));
$('frameBtn').addEventListener('click', () => viewer.frame());
function setLighting(kind, save = true) {
  viewer.setLighting(kind);
  $('lightSel').value = $('bLightSel').value = kind;
  if (save) call('setSettings', { lighting: kind }).catch(() => {});
}
$('lightSel').addEventListener('change', () => setLighting($('lightSel').value));
$('bLightSel').addEventListener('change', () => setLighting($('bLightSel').value));
const embers = new Embers($('center'));
function setBackground(bg, save = true) {
  $('bgSel').value = bg;
  const c = $('center'); // (only the background classes: "compact" stays)
  for (const x of [...c.classList]) if (x.startsWith('bg-')) c.classList.remove(x);
  if (bg !== 'dark') c.classList.add('bg-' + bg);
  embers.setEnabled(bg === 'crossout');
  if (save) call('setSettings', { background: bg }).catch(() => {});
}
$('bgSel').addEventListener('change', () => setBackground($('bgSel').value));
// Record: the view as a video clip with the game's sounds (recorder.js); the buttons beside Screenshot
// start it and stop it (saved where the user picks)
const recorder = new Recorder(viewer, viewer.sounds, { onChange: () => showRecording() });
function showRecording() {
  const s = Math.floor(recorder.seconds());
  for (const id of ['recBtn', 'bRec', 'mRec']) {
    $(id).classList.toggle('on', recorder.recording);
    $(id).textContent = recorder.recording ? `Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'Record';
  }
}
setInterval(() => { if (recorder.recording) showRecording(); }, 500);
async function toggleRecording(name) {
  if (!recorder.recording) {
    if (!recorder.start()) status('The view cannot be recorded here (no video recorder in this WebView2).', true);
    return;
  }
  const r = await recorder.stop();
  if (!r) return;
  busy(true, 'Saving the recording…');
  try {
    const res = await call('saveVideo', { dataUrl: await dataUrlOf(r.blob), ext: r.ext, name });
    if (res) status(`Recording saved: ${res.path}`);
  } catch (e) {
    status(e.message, true);
  } finally {
    busy(false);
  }
}
$('recBtn').addEventListener('click', () => toggleRecording((state.info?.name || 'view') + '_clip'));
$('bRec').addEventListener('click', () => toggleRecording(build.name + '_clip'));
$('mRec').addEventListener('click', () => toggleRecording(`${state.map.name || 'map'}_clip`));

async function screenshot(name) {
  try {
    const r = await call('saveScreenshot', { dataUrl: viewer.screenshot(), name });
    if (r) status(`Screenshot saved: ${r.path}`);
  } catch (e) { status(e.message, true); }
}
$('shotBtn').addEventListener('click', () => screenshot((state.info?.name || 'view') + '_view'));
$('mWith').addEventListener('click', (e) => { if (e.target.dataset.alone && state.info) openModel(state.info.path, { skin: state.skin, lod: state.lod, keepCamera: true, assembled: false }); });
// Export… beside Add to build: the Export card's button, without scrolling down to it first (the
// card comes into view, so its progress and result are seen)
$('quickExport').addEventListener('click', () => {
  if (!state.info || $('exportBtn').disabled) return;
  $('exportBtn').closest('.card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('exportBtn').click();
});
$('addToBuild').addEventListener('click', async () => {
  if (!state.info) return;
  const { path } = state.info, skin = state.skin;
  setView('build'); // (the first time, this starts bringing back your last build: the part waits for it)
  await afterBuildLoads();
  if (state.view !== 'build') return;
  build.startPlacing(path, skin).then(renderList, (e) => status(e.message, true));
});

// the textures / grid toggles are shared by both modes
function syncToggles() {
  $('bTextures').checked = $('optTextures').checked = $('mTextures').checked = viewer.options.textures;
  $('bGrid').checked = $('optGrid').checked = viewer.options.grid;
}

// ---- inspector ----------------------------------------------------------------------------------
function usedMaterials() {
  const used = new Set(state.info.meshes.filter((m) => m.lod === state.lod).map((m) => m.material));
  return [...used].sort((a, b) => a - b);
}

function renderInspector() {
  const info = state.info, st = state.stats;
  const nm = partName(info.path);
  $('mName').textContent = nm || info.name;
  $('mName').closest('.card').className = 'card r-' + (partStats.item(info.path)?.rarity || 'none'); // (the part's rarity, as its card on the left)
  const b = names.builtin[info.path];
  const zh = wantZh() && zhName(info.path);
  $('mName').title = names.user[info.path] ? tr('Your name for this part')
    : zh ? tr('Chinese name (from ui\\names.zh.json)')
    : b ? tr('In-game name') + (b.confidence && b.confidence !== 'high' ? tr(' (best match, not fully certain)') : '')
    : tr('File name (no in-game name known yet: ✎ to name it)');
  $('mFile').hidden = !nm;
  // (shown with what the game puts on its nodes: say so, and how to see it alone)
  const withList = state.assembled ? [...new Set(state.assembly.map((a) => a.path))].map((p) => {
    const k = state.assembly.filter((a) => a.path === p).length;
    return `${k > 1 ? k + ' × ' : ''}${esc(partName(p) || stem(p))}`;
  }).join(', ') : '';
  $('mWith').hidden = !withList;
  $('mWith').innerHTML = withList ? tr('With {list} in place, as in the game. <a data-alone="1">Show it alone</a>', { list: withList }) : '';
  $('mFile').textContent = nm ? tr('file: {name}', { name: info.name }) : '';
  $('mNameEdit').hidden = true;
  $('mPath').innerHTML = esc(info.path).replace(/\//g, '/<wbr>'); // (broken after a slash, not inside a name)
  const size = info.bbMax.map((v, i) => v - info.bbMin[i]);
  const lodTris = info.meshes.filter((m) => m.lod === state.lod && !info.materials[m.material]?.invisible).reduce((a, m) => a + m.triangleCount, 0);
  const fmt = [...new Set(info.meshes.filter((m) => m.lod === state.lod).map((m) => (m.halfPositions ? 'half' : 'float') + (m.skinned ? ', skinned' : '')))].join(' / ');
  const used = usedMaterials();
  const rows = [
    [tr('Triangles (LOD {n})', { n: state.lod }), lodTris.toLocaleString()],
    [tr('Vertices'), st ? st.verts.toLocaleString() : ''],
    [tr('LODs'), info.lodCount],
    [tr('Materials'), used.length + (info.materials.length > used.length ? tr(' of {n}', { n: info.materials.length }) : '')],
    [tr('Size (m)'), size.map((v) => v.toFixed(2)).join(' × ')],
    [tr('Size (build cells)'), size.map((v) => Math.max(1, Math.round(v / CELL))).join(' × ')],
    [tr('Weld points'), info.slots.length],
    [tr('Pivots / bones'), info.nodes.length],
    [tr('Skins'), info.skins.length ? info.skins.map((s) => s.name).join(', ') : tr('default')],
    [tr('Vertex format'), fmt],
  ];
  $('mStats').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('mWarnings').innerHTML = (info.warnings || []).map((w) => `<div><i class="gi" data-gi="icn_attention"></i>${esc(w)}</div>`).join('');
  hydrateIcons($('mWarnings'));
  syncPaintMask();
  renderMaterials();
}

const ROLE_ORDER = ['albedo', 'normal', 'gloss', 'emissive', 'ao', 'detail', 'colormap', 'albedo2'];
const ROLE_LABEL = { albedo: 'Albedo', normal: 'Normal', gloss: 'Gloss / paint mask', emissive: 'Emissive / glow', ao: 'Occlusion', detail: 'Detail normal', colormap: 'Colour map', albedo2: 'Albedo layer 2' };
const roleLabel = (r) => tr(ROLE_LABEL[r] || r);
const LAMP_LABEL = { DiffuseSampler: 'Glow · diffuse', ColormapSampler: 'Glow · colour map', MaterialLayers0: 'Glow · layer 1', MaterialLayers1: 'Glow · layer 2' }; // (multiplied: either can be the colour or the mask)
const THUMB_VIEW = { albedo: 'opaque', albedo2: 'opaque', normal: 'normal' };
const roleRank = (r) => { const i = ROLE_ORDER.indexOf(r); return i < 0 ? 99 : i; };

function thumbUrl(t) {
  const rep = state.replace[t.base];
  const view = THUMB_VIEW[t.role] || 'opaque';
  return rep ? `${DATA}/png?image=${enc(rep.id)}&max=96&view=opaque` : `${DATA}/png?base=${enc(t.base)}&max=96&view=${view}`;
}

function renderMaterials() {
  const info = state.info;
  const html = [];
  for (const mi of usedMaterials()) {
    const m = info.materials[mi] || { textures: [] };
    if (m.invisible) { html.push(`<div class="mat"><div class="mat-head"><b>Material ${mi}</b> · hidden in this skin</div></div>`); continue; }
    const texs = [...m.textures].sort((a, b) => roleRank(a.role) - roleRank(b.role));
    // (glow shaders: a glow laid over the part, its two textures multiplied; see viewer.js LAMP_VERT)
    const lamp = Viewer.isLamp(m);
    const label = (t) => tr((lamp && LAMP_LABEL[t.param]) || ROLE_LABEL[t.role] || t.role);
    html.push(`<div class="mat${viewer.partSel === mi ? ' sel' : ''}" data-mat="${mi}"><div class="mat-head" title="Show where it is on the part (a click on the part does the same)"><b>Material ${mi}</b>${m.alphaTest ? ' · alpha test' : ''}${lamp ? (m.glow.additive === false ? ' · <span title="A see-through marker drawn over the part (its textures\' alpha)">see-through layer</span>' : ' · <span title="Light added onto the part: its two glow textures multiplied (black shows nothing)">glow layer</span>') : ''}</div>`);
    if (!texs.length) html.push('<div class="hint">No textures.</div>');
    for (const t of texs) {
      const rep = state.replace[t.base];
      const meta = t.exists ? (rep ? `replaced by ${esc(rep.name)} (${rep.w}×${rep.h})` : t.error ? esc(t.error) : `${t.width}×${t.height} · ${esc(t.format)}${t.mips > 1 ? ` · ${t.mips} mips` : ''}`) : 'missing in the archives';
      html.push(`<div class="tex${t.exists ? '' : ' missing'}" data-base="${esc(t.base)}" data-role="${t.role}">
        <div class="thumb" data-act="view" style="background-image:url('${t.exists ? thumbUrl(t) : ''}')" title="Open the texture"></div>
        <div class="info">
          <div class="role${rep || (t.role === 'albedo' && isAdjusted(state.adjust[t.base])) ? ' custom' : ''}">${esc(label(t))}</div>
          <div class="tname" title="${esc(t.base)}">${esc(leaf(t.base))}</div>
          <div class="tmeta">${meta}</div>
          ${t.exists ? `<div class="acts">
            <button data-act="png" title="Save as PNG${t.role === 'normal' ? ' (rebuilt RGB normal map)' : ''}">PNG</button>
            <button data-act="dds" title="Save the game's texture unchanged as DDS">DDS</button>
            <button data-act="replace" title="Use your own image instead (PNG/JPG/…)">Replace…</button>
            ${rep ? '<button data-act="unreplace">Reset</button>' : ''}
            ${t.role === 'albedo' ? `<button data-act="adjust">${state.openAdjust.has(t.base) ? 'Hide colours' : 'Colours…'}</button>` : ''}
          </div>` : ''}
          ${t.role === 'albedo' && state.openAdjust.has(t.base) ? adjustHtml(t.base, !!texs.find((x) => x.role === 'gloss' && x.exists)) : ''}
        </div>
      </div>`);
    }
    html.push('</div>');
  }
  $('materials').innerHTML = html.join('') || '<div class="hint">No materials.</div>';
}

// The part's materials and the view: the one clicked on the part is marked here (and scrolled to),
// the one under the mouse here is outlined there, a click on its name selects it.
viewer.onPartSelect = (mi) => {
  let el = null;
  for (const m of document.querySelectorAll('#materials .mat[data-mat]')) {
    const on = mi !== null && +m.dataset.mat === mi;
    m.classList.toggle('sel', on);
    if (on) el = m;
  }
  el?.scrollIntoView({ block: 'nearest' });
};
$('materials').addEventListener('mouseover', (e) => { const m = e.target.closest('.mat[data-mat]'); viewer.setPartHover(m ? +m.dataset.mat : null); });
$('materials').addEventListener('mouseleave', () => viewer.setPartHover(null));
$('materials').addEventListener('click', (e) => {
  const h = e.target.closest('.mat-head');
  const m = h?.closest('.mat[data-mat]');
  if (m) viewer.selectPartMaterial(viewer.partSel === +m.dataset.mat ? null : +m.dataset.mat);
});

// ---- colour adjust ----
const DEFAULT_ADJ = { hue: 0, saturation: 1, brightness: 0, contrast: 1, tint: [1, 1, 1], tintAmount: 0, paint: [0.55, 0.13, 0.1], paintAmount: 0 };
const PAINTS = [['#8c2119', 'Crimson'], ['#c96a1b', 'Rust orange'], ['#d9b44a', 'Steppe sand'], ['#56602f', 'Military olive'], ['#2f4f6f', 'Navy'], ['#1f7a6d', 'Teal'], ['#6b3fa0', 'Purple'], ['#e8e8e3', 'Arctic white'], ['#2b2b2b', 'Graphite'], ['#d93a8c', 'Neon pink']];
function isAdjusted(a) { return !!a && (a.hue !== 0 || a.saturation !== 1 || a.brightness !== 0 || a.contrast !== 1 || a.tintAmount > 0 || a.paintAmount > 0); }
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const fmtAdj = (k, v) => (k === 'hue' ? Math.round(v) + '°' : k === 'brightness' ? (v > 0 ? '+' : '') + Math.round(v * 100) : Math.round(v * 100) + '%');

function adjustHtml(base, hasMask) {
  const a = state.adjust[base] || DEFAULT_ADJ;
  const painted = !!state.viewPaint; // (the part's paint, the Paint card's, covers its textures' own)
  const slider = (k, label, min, max, step) => `<div class="ar"><span>${label}</span><input type="range" data-adj="${k}" min="${min}" max="${max}" step="${step}" value="${a[k]}"><span class="val">${fmtAdj(k, a[k])}</span></div>`;
  return `<div class="adjust" data-base="${esc(base)}">
    ${slider('hue', 'Hue', -180, 180, 1)}
    ${slider('saturation', 'Saturation', 0, 2, 0.01)}
    ${slider('brightness', 'Brightness', -0.5, 0.5, 0.01)}
    ${slider('contrast', 'Contrast', 0.4, 1.8, 0.01)}
    <div class="ar"><span>Tint</span><input type="color" data-adj-color="tint" value="${hex(a.tint)}"><span></span></div>
    ${slider('tintAmount', 'Tint amount', 0, 1, 0.01)}
    ${hasMask && painted ? '<div class="hint warn-hint">The part\'s paint (the Paint card above) covers this texture\'s own paint while it is on.</div>' : ''}
    ${hasMask ? `<div class="ar"><span>Paint</span><input type="color" data-adj-color="paint" value="${hex(a.paint)}"><span></span></div>
    <div class="swatches">${PAINTS.map(([c, n]) => `<button data-paint="${c}" title="${n}" style="background:${c}"></button>`).join('')}</div>
    ${slider('paintAmount', 'Paint amount', 0, 1, 0.01)}
    <div class="hint">Paint goes where the part's paint mask (red channel of its gloss map) says, like the in-game paints.</div>` : ''}
    <div class="row right"><button class="btn small" data-adj-reset>Reset colours</button></div>
  </div>`;
}

// Colour edits: state.adjust holds each albedo's own edits (the 3D Viewer's "Colours…"), on every part
// that uses the texture; the paints (the 3D Viewer's, the builder's) go over them part by part
// (viewer.setModelPaint). The view, and what exports bake, is the two together.
function effectiveAdjust(base) {
  const own = state.adjust[base];
  return own && isAdjusted(own) ? own : null;
}
function showAdjust(base) { viewer.setAdjust(base, effectiveAdjust(base)); }
function setAdjust(base, patch) {
  const a = { ...(state.adjust[base] || DEFAULT_ADJ), ...patch };
  if (isAdjusted(a)) state.adjust[base] = a; else delete state.adjust[base];
  showAdjust(base);
  clearThumbs();
  autosave(); // (a build part's colours are the build's: its Save dot and autosave follow)
  return a;
}

function syncSliders(box, base) {
  const a = state.adjust[base] || DEFAULT_ADJ;
  box.querySelectorAll('[data-adj]').forEach((s) => {
    s.value = a[s.dataset.adj];
    const val = s.nextElementSibling;
    if (val) val.textContent = fmtAdj(s.dataset.adj, a[s.dataset.adj]);
  });
  box.querySelectorAll('[data-adj-color]').forEach((c) => (c.value = hex(a[c.dataset.adjColor])));
}

function markCustom(base) {
  const row = [...document.querySelectorAll('.tex')].find((t) => t.dataset.base === base && t.dataset.role === 'albedo');
  row?.querySelector('.role')?.classList.toggle('custom', isAdjusted(state.adjust[base]) || !!state.replace[base]);
}

$('materials').addEventListener('input', (e) => {
  const box = e.target.closest('.adjust');
  if (!box) return;
  const base = box.dataset.base;
  if (e.target.dataset.adj) {
    const k = e.target.dataset.adj;
    const a = setAdjust(base, { [k]: +e.target.value });
    const val = e.target.nextElementSibling;
    if (val) val.textContent = fmtAdj(k, a[k]);
  } else if (e.target.dataset.adjColor) {
    const k = e.target.dataset.adjColor;
    const patch = { [k]: unhex(e.target.value) };
    const cur = state.adjust[base] || DEFAULT_ADJ;
    if (k === 'tint' && !cur.tintAmount) patch.tintAmount = 0.6;
    if (k === 'paint' && !cur.paintAmount) patch.paintAmount = 0.85;
    setAdjust(base, patch);
    syncSliders(box, base);
  }
  markCustom(base);
});

$('materials').addEventListener('click', async (e) => {
  const box = e.target.closest('.adjust');
  if (box && e.target.dataset.paint) {
    setAdjust(box.dataset.base, { paint: unhex(e.target.dataset.paint), paintAmount: state.adjust[box.dataset.base]?.paintAmount || 0.85 });
    syncSliders(box, box.dataset.base);
    markCustom(box.dataset.base);
    return;
  }
  if (box && e.target.hasAttribute('data-adj-reset')) {
    delete state.adjust[box.dataset.base];
    showAdjust(box.dataset.base);
    clearThumbs();
    renderMaterials();
    return;
  }
  const act = e.target.closest('[data-act]')?.dataset.act;
  const row = e.target.closest('.tex');
  if (!act || !row) return;
  const base = row.dataset.base, role = row.dataset.role;
  try {
    if (act === 'view') showTexture(base, role);
    if (act === 'adjust') { if (state.openAdjust.has(base)) state.openAdjust.delete(base); else state.openAdjust.add(base); renderMaterials(); }
    if (act === 'png' || act === 'dds') {
      const rep = state.replace[base];
      const view = act === 'png' && role === 'normal' && !rep ? 'normal' : 'rgb';
      const eff = act === 'png' && role === 'albedo' ? effectiveAdjust(base) : null; // (its colour edits; a part's paint goes with the part's export)
      const adj = eff && isAdjusted(eff) ? eff : null;
      // the paint mask is the gloss map of the material this albedo belongs to
      const owner = adj ? state.info?.materials.find((m) => (m.textures || []).some((x) => x.base === base && x.role === 'albedo')) : null;
      const mask = owner?.textures.find((t) => t.role === 'gloss' && t.exists)?.base || '';
      const r = await call('exportTexture', { base, as: act, view, image: act === 'png' && rep ? rep.id : '', adjust: adj, mask, maskImage: state.replace[mask]?.id || '' });
      if (r) status(r.warning ? `Saved ${r.path} · ${r.warning}` : `Saved ${r.path}`, !!r.warning);
    }
    if (act === 'replace') {
      const r = await call('importImage', {});
      if (!r) return;
      if (state.replace[base]) call('releaseImage', { id: state.replace[base].id }).catch(() => {});
      state.replace[base] = { id: r.id, file: r.file, name: r.name, w: r.w, h: r.h };
      await viewer.setReplacement(base, { id: r.id });
      renderMaterials();
      clearThumbs(); // (the parts list pictures show the new image; a build using it saves it)
      autosave();
      status(`${leaf(base)} now uses ${r.name} (${r.w}×${r.h})`);
    }
    if (act === 'unreplace') {
      call('releaseImage', { id: state.replace[base]?.id }).catch(() => {});
      delete state.replace[base];
      await viewer.setReplacement(base, null);
      renderMaterials();
      clearThumbs();
      autosave();
    }
  } catch (err) { status(err.message, true); }
});

// Naming a part: ✎ turns the title into a text box; Enter keeps it, Esc cancels, empty removes it.
$('mRename').addEventListener('click', () => {
  if (!state.info) return;
  const ed = $('mNameEdit');
  ed.value = names.user[state.info.path] || partName(state.info.path) || '';
  ed.hidden = false;
  ed.focus();
  ed.select();
});
$('mNameEdit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { setPartName(state.info.path, $('mNameEdit').value); $('mNameEdit').hidden = true; status(`Named ${stem(state.info.path)}`); }
  if (e.key === 'Escape') $('mNameEdit').hidden = true;
});
$('mNameEdit').addEventListener('blur', () => { $('mNameEdit').hidden = true; });

$('mPath').addEventListener('click', () => { navigator.clipboard?.writeText(state.info?.path || ''); status('Path copied'); });

// ---- texture preview ----
let texCurrent = null;
function showTexture(base, role) {
  texCurrent = { base, role };
  const view = role === 'normal' ? 'normal' : role === 'gloss' ? 'rgb' : 'opaque';
  $('texView').value = view;
  $('texTitle').textContent = base.slice(base.lastIndexOf('/') + 1);
  $('texTitle').title = base;
  $('texPreview').hidden = false;
  loadPreview();
}
function loadPreview() {
  const { base } = texCurrent;
  const rep = state.replace[base];
  $('texImg').src = rep ? `${DATA}/png?image=${enc(rep.id)}&max=2048&view=${$('texView').value}` : `${DATA}/png?base=${enc(base)}&max=2048&view=${$('texView').value}`;
}
$('texImg').addEventListener('error', () => { if (!$('texPreview').hidden) status(`Cannot show ${texCurrent?.base}`, true); });
$('texView').addEventListener('change', loadPreview);
$('texClose').addEventListener('click', () => ($('texPreview').hidden = true));
for (const [id, as] of [['texPng', 'png'], ['texDds', 'dds']])
  $(id).addEventListener('click', async () => {
    try {
      const rep = state.replace[texCurrent.base];
      const r = await call('exportTexture', { base: texCurrent.base, as, view: $('texView').value, image: as === 'png' && rep ? rep.id : '' });
      if (r) status(r.warning ? `Saved ${r.path} · ${r.warning}` : `Saved ${r.path}`, !!r.warning);
    } catch (e) { status(e.message, true); }
  });

// ---- looks (one part) ----
async function reattachImages(replaceMap) {
  const missing = [];
  const out = {};
  for (const [base, rep] of Object.entries(replaceMap || {})) {
    if (!rep?.file) continue;
    try {
      const img = await call('loadImagePath', { file: rep.file });
      out[base] = { id: img.id, file: rep.file, name: rep.name || leaf(rep.file.replace(/\\/g, '/')), w: img.w, h: img.h };
    } catch { missing.push(rep.file); }
  }
  return { out, missing };
}

// A look = the open part plus every colour edit and replaced texture (image files by path).
function lookFile() {
  return {
    app: 'Grimcold', kind: 'look', version: 1, model: state.info.path, skin: state.skin, lod: state.lod,
    adjust: state.adjust,
    ...(state.viewPaint ? { paint: paintForFile(state.viewPaint) } : {}),
    replace: Object.fromEntries(Object.entries(state.replace).map(([b, r]) => [b, { file: r.file, name: r.name }])),
  };
}

// Applies a look: its edits replace the current ones, its images are read again from disk.
async function applyLook(look, from = '') {
  if (!look || !look.model) throw new Error('not a Grimcold look');
  await getInfo(look.model, look.skin || ''); // (a part this game version lacks: nothing is changed)
  // The look's edits take the place of the others; the build keeps its own on the textures it uses
  // that the look leaves alone (they went too, without a word, and the autosave kept that).
  const used = usedTextures(), lookAdj = look.adjust || {}, lookRep = look.replace || {};
  const before = Object.keys(state.adjust);
  state.adjust = { ...Object.fromEntries(Object.entries(state.adjust).filter(([b]) => used.has(b) && !(b in lookAdj))), ...lookAdj };
  for (const base of new Set([...before, ...Object.keys(state.adjust)])) showAdjust(base);
  setViewPaint(look.paint ? normPaint(look.paint) : null); // (its paint, or none)
  clearThumbs();
  for (const [base, rep] of Object.entries(state.replace)) {
    if (used.has(base) && !(base in lookRep)) continue;
    await viewer.setReplacement(base, null);
    call('releaseImage', { id: rep.id }).catch(() => {});
    delete state.replace[base];
  }
  const { out, missing } = await reattachImages(lookRep);
  Object.assign(state.replace, out);
  autosave();
  const opened = await openModel(look.model, { skin: look.skin, lod: look.lod || 0 });
  if (opened) status(missing.length ? `Look opened, but these images are missing: ${missing.join(', ')}` : `Look opened${from ? ': ' + from : ''}`, missing.length > 0);
  return { missing };
}

$('lookSave').addEventListener('click', async () => {
  if (!state.info) return;
  try {
    const r = await call('saveText', { text: JSON.stringify(lookFile(), null, 2), ext: 'xolook', name: state.info.name + '_look', title: 'Save look', label: 'Grimcold look' });
    if (r) status(`Look saved: ${r.path}`);
  } catch (e) { status(e.message, true); }
});

$('lookOpen').addEventListener('click', async () => {
  try {
    const r = await call('openText', { ext: 'xolook', title: 'Open look', label: 'Grimcold look' });
    if (r) await applyLook(JSON.parse(r.text), r.path);
  } catch (e) { status(e.message, true); }
});

$('lookReset').addEventListener('click', async () => {
  // (it takes the build's colour edits too, and the autosave keeps that: asked first; the builder's
  // paints are the build's, undone there)
  const edits = Object.keys(state.adjust).length + Object.keys(state.replace).length + (state.viewPaint ? 1 : 0);
  if (!edits) { status('Nothing to reset'); return; }
  if (!(await ask('Remove the part\'s paint and every colour edit and replaced texture (the Vehicle Builder\'s parts use them too)? This cannot be undone.', { title: 'Reset all', yes: 'Reset all' }))) return;
  const before = Object.keys(state.adjust);
  for (const [base, rep] of Object.entries(state.replace)) { await viewer.setReplacement(base, null); call('releaseImage', { id: rep.id }).catch(() => {}); }
  state.adjust = {};
  state.replace = {};
  for (const base of before) showAdjust(base);
  setViewPaint(null);
  clearThumbs();
  if (state.info) renderMaterials();
  renderBuildPanel();
  autosave();
  status('The paint, all colour edits and replaced textures removed');
});

// ---- export (one part) ----
function segPick(segId, key) {
  $(segId).addEventListener('click', (e) => {
    const b = e.target.closest('button[data-fmt]');
    if (!b) return;
    state[key] = b.dataset.fmt;
    $(segId).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (segId === 'fmtSeg') syncAnimOption();
  });
}
segPick('fmtSeg', 'exportFmt');
// "Extra maps" (gloss, AO beside the textures) and the texture size need "Textures": greyed out without it (they did nothing)
for (const [tex, ...deps] of [['expTextures', 'expExtra', 'expMaxTex'], ['bExpTextures', 'bExpExtra', 'bMaxTex']]) {
  const sync = () => { for (const d of deps) { $(d).disabled = !$(tex).checked; $(d).closest('label').classList.toggle('dim', !$(tex).checked); } };
  $(tex).addEventListener('change', sync);
  sync();
}
segPick('bFmtSeg', 'buildFmt');

// Remembered between sessions: the export formats and options, and the map view's detail and texture
// size (the settings file keeps them as "prefs"). The view distance is each map's own.
const PREF_SEGS = { fmtSeg: 'exportFmt', bFmtSeg: 'buildFmt', mxFmtSeg: 'mapFmt', msFmtSeg: 'selFmt' };
const PREF_CHECKS = ['expTextures', 'expDds', 'expExtra', 'expAo', 'bExpAo', 'mxAo', 'expSplit', 'bExpSplit', 'expSlots', 'expAnim', 'expPose', 'expColors', 'bExpTextures', 'bExpDds', 'bExpExtra', 'msKeepPos',
  'mxTerrain', 'mxGround', 'mxProps', 'mxTrees', 'mxObjects', 'mxWater', 'mxDecals', 'mxGrass', 'mxSun', 'mxSky', 'mxTextures'];
const PREF_VALUES = ['expLod', 'expMaxTex', 'bLod', 'bMaxTex', 'mxLod', 'mxMaxTex', 'mxSkySize', 'mxGrassAmt', 'mpDetail', 'mpTex'];
let prefs = {};
const savePrefs = debounce(() => call('setSettings', { prefs }).catch(() => {}), 300);
function watchPrefs() {
  for (const [seg, key] of Object.entries(PREF_SEGS)) $(seg).addEventListener('click', () => { prefs[key] = state[key]; savePrefs(); });
  for (const id of [...PREF_CHECKS, ...PREF_VALUES]) $(id)?.addEventListener('change', () => { prefs[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; savePrefs(); });
}
function restorePrefs(saved) {
  prefs = saved && typeof saved === 'object' ? { ...saved } : {};
  for (const [seg, key] of Object.entries(PREF_SEGS)) {
    const b = prefs[key] && $(seg).querySelector(`button[data-fmt="${CSS.escape(prefs[key])}"]`);
    if (b) b.click();
  }
  for (const id of PREF_CHECKS) if (typeof prefs[id] === 'boolean' && $(id) && $(id).checked !== prefs[id]) { $(id).checked = prefs[id]; $(id).dispatchEvent(new Event('change')); }
  for (const id of PREF_VALUES) {
    const el = $(id);
    if (el && prefs[id] != null && el.value !== String(prefs[id]) && [...(el.options || [])].some((o) => o.value === String(prefs[id]))) { el.value = String(prefs[id]); el.dispatchEvent(new Event('change')); }
  }
}

// Cards fold to their header: a click on a card's own header (its first line, not a button in it) folds
// it, another opens it; the folded ones are kept with the prefs ("folded": "panel/card" keys).
// (a header's English, whatever the language: a card folded in one stays folded in the other)
const headText = (h) => { const f = h.firstChild; return (f?.nodeType === 3 ? sourceText(f) : f?.textContent || '').trim(); };
const cardKey = (card) => `${card.closest('.inspector')?.id || ''}/${card.id || card.firstElementChild.id || headText(card.firstElementChild) || ''}`;
document.addEventListener('click', (e) => {
  const h = e.target.closest('.inspector .card > h3:first-child');
  if (!h || e.target.closest('button, input, select, a, label')) return;
  const card = h.parentElement, folded = !card.classList.contains('folded'), keys = new Set(prefs.folded || []);
  card.classList.toggle('folded', folded);
  if (folded) keys.add(cardKey(card)); else keys.delete(cardKey(card));
  prefs.folded = [...keys];
  savePrefs();
});
function restoreFolds() {
  const keys = new Set(prefs.folded || []);
  for (const h of document.querySelectorAll('.inspector .card > h3:first-child')) {
    h.parentElement.classList.toggle('folded', keys.has(cardKey(h.parentElement)));
    h.title ||= 'Click to fold or open';
  }
}

// The textures' colour edits and replaced images, as the view shows them (the paints go with the parts).
function editsForExport() {
  const adjust = {};
  for (const b of Object.keys(state.adjust)) {
    const e = effectiveAdjust(b);
    if (e) adjust[b] = e;
  }
  return { adjust, replace: Object.fromEntries(Object.entries(state.replace).map(([b, r]) => [b, r.id])) };
}

async function runExport(cmd, args, bar, res, btn) {
  res.innerHTML = '';
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  btn.disabled = true;
  try {
    const r = await call(cmd, args, (f, stage) => { bar.firstElementChild.style.width = Math.round(f * 100) + '%'; status(stage, false, true); });
    if (!r) { status(''); return null; }
    res.innerHTML = `<div class="ok">Exported ${r.files.length} file(s)</div><div>${esc(r.path)}</div><a data-reveal="${esc(r.path)}">Show in folder</a>` +
      (r.warnings.length ? `<div class="err">${r.warnings.slice(0, 12).map(esc).join('<br>')}${r.warnings.length > 12 ? `<br>… and ${r.warnings.length - 12} more` : ''}</div>` : '');
    status(`Exported ${leaf(r.path.replace(/\\/g, '/'))}`);
    return r;
  } catch (e) {
    res.innerHTML = `<div class="err">${esc(e.message)}</div>`;
    status(e.message, true);
    return null;
  } finally {
    bar.hidden = true;
    btn.disabled = false;
  }
}

// The pose the viewer shows (aim, steering, the moment of an animation, Look at me): every bone's
// local translation, rotation and scale, in node order. The export bakes it in (or, with the
// skeleton, starts there). undefined: the part does not move, or "Pose as shown" is off.
function shownPose() {
  const a = state.animator;
  if (!a?.skel || a.path !== state.info?.path || !$('expPose').checked) return undefined;
  const r = (v) => Math.round(v * 1e7) / 1e7;
  return a.skel.bones.map((b) => [...b.position.toArray(), ...b.quaternion.toArray(), ...b.scale.toArray()].map(r));
}

// What the viewer shows on the part's nodes (its assembly), for the export: each model, the node it
// is on and the pose its meshes are baked in.
function shownAttachments() {
  return (viewer.part?.userData.attached || []).filter((g) => g.visible).map((g) => ({
    path: g.userData.info.path, node: g.userData.attachedTo, ...(g.userData.pose ? { pose: g.userData.pose.trs } : {}),
  }));
}

// What the Export button asks the host for: the part as shown, with the panel's options.
function exportArgs() {
  return {
    path: state.info.path, name: partName(state.info.path) || '', format: state.exportFmt, lod: $('expLod').value === 'all' ? -1 : state.lod, skin: state.skin,
    textures: $('expTextures').checked, maxTex: +$('expMaxTex').value || 0, dds: $('expDds').checked, extraMaps: $('expExtra').checked, ao: $('expAo').checked, split: $('expSplit').checked, slots: $('expSlots').checked,
    vertexColors: $('expColors').checked, tangents: true, heat: state.heatUser, ...editsForExport(),
    animations: !$('expAnimWrap').hidden && !$('expAnim').disabled && $('expAnim').checked, pose: shownPose(),
    attachments: state.assembled ? shownAttachments() : undefined, // (its projectiles in place, as shown)
    ...(state.viewPaint ? { paint: state.viewPaint } : {}), // (its paint, baked into its textures)
  };
}

$('exportBtn').addEventListener('click', () => {
  if (!state.info) return;
  runExport('export', exportArgs(), $('expProgress'), $('expResult'), $('exportBtn'));
});
for (const id of ['expResult', 'bResult'])
  $(id).addEventListener('click', (e) => { const p = e.target.dataset.reveal; if (p) call('reveal', { path: p }); });
$('mxResult').addEventListener('click', (e) => { const p = e.target.dataset.reveal; if (p) call('reveal', { path: p }); });

// ---- vehicle builder panel ---------------------------------------------------------------------------
let buildPanelQueued = false;
function scheduleBuildPanel() {
  if (buildPanelQueued) return;
  buildPanelQueued = true;
  requestAnimationFrame(() => { buildPanelQueued = false; renderBuildPanel(); });
}

function renderBuildPanel() {
  if (state.view !== 'build') return;
  const st = build.stats();
  $('buildEmpty').hidden = st.parts > 0 || !!build.placing || !!state.restoring || state.loadingBuild > 0;
  if (document.activeElement !== $('bName')) $('bName').value = build.name === 'My build' ? tr('My build') : build.name; // (the default name is data: only its look is translated)
  $('bStats').innerHTML = [
    [tr('Parts'), st.parts],
    [tr('Triangles'), st.tris.toLocaleString()],
    [tr('Size (m)'), st.size.map((v) => v.toFixed(2)).join(' × ')],
    [tr('Size (cells)'), st.size.map((v) => Math.round(v / CELL)).join(' × ')],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  const comps = st.parts ? build.components({ all: true }) : []; // (parts on the cursor where they were)
  const cabin = build.instances.some((i) => build.isCabin(i.path));
  $('bGroups').innerHTML = !st.parts ? '' : comps.length === 1 ? `<span class="ok"><i class="gi" data-gi="ui/icn_check"></i>${tr('Every part is attached to the rest')}</span>`
    : `<span class="warn"><i class="gi" data-gi="icn_attention"></i>${tr(cabin ? "{n} separate groups: {m} part(s) aren't welded to the cabin" : "{n} separate groups: {m} part(s) don't touch the main body at a connection point", { n: comps.length, m: build.loose.size })}</span>`;
  hydrateIcons($('bGroups'));
  $('bUndo').disabled = build.history.length < 2 && !build.placing;
  $('bRedo').disabled = !build.future.length;
  // parts list
  $('bCount').textContent = st.parts ? `(${st.parts})` : '';
  $('bList').innerHTML = build.instances.map((i) => `<div class="brow${build.isSelected(i.id) ? ' sel' : ''}${i.id === build.selected ? ' primary' : ''}${build.loose.has(i.id) ? ' loose' : ''}" data-id="${i.id}">
      <span class="bn" title="${esc(i.path)}">${esc(instName(i))}${i.mirrored ? ' ⇋' : ''}</span>${i.skin !== 'default' ? `<span class="bs">${esc(i.skin)}</span>` : ''}${i.paint ? paintDot(i.paint) : ''}<button class="bx" data-del="${i.id}" title="Delete">✕</button></div>`).join('') +
    build.unloaded.map((u, k) => `<div class="brow missing" title="${esc(u.path || '')}: not in this game version. It stays in the build file until you remove it."><span class="bn">${esc(stem(u.path || '?'))}</span><span class="bs">missing</span><button class="bx" data-drop="${k}" title="Remove it from the build">✕</button></div>`).join('')
    || '<div class="hint">No parts yet.</div>';
  // selection
  const inst = build.get(build.selected); // the primary part
  const sel = build.selection();
  $('bSelCard').hidden = !inst;
  if (inst) {
    const many = sel.length > 1;
    $('bSelCard').className = 'card r-' + (many ? 'none' : (partStats.item(inst.path, inst.st)?.rarity || 'none'));
    $('bSelTitle').textContent = many ? `${sel.length} parts selected` : 'Selected part';
    if (many) {
      const counts = new Map();
      for (const i of sel) counts.set(nameOrFile(i.path), (counts.get(nameOrFile(i.path)) || 0) + 1);
      $('bSelName').textContent = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
      $('bSelPath').textContent = `X, Y, Z are ${nameOrFile(inst.path)}'s; typing new ones moves all ${sel.length}`;
    } else {
      $('bSelName').textContent = instName(inst) + (inst.mirrored ? ' (mirrored)' : '');
      $('bSelPath').textContent = inst.path;
    }
    // wheels that come as a plain and a steering (ST) version, which share the model
    $('bStWrap').hidden = !partStats.hasSteering(inst.path) || sel.some((i) => i.path !== inst.path);
    $('bSt').checked = inst.st;
    const stickers = sel.reduce((k, i) => k + (i.stickers?.length || 0), 0);
    $('bStickerRow').hidden = !stickers;
    $('bStickerCount').textContent = stickers === 1 ? tr('1 sticker') : tr('{n} stickers', { n: stickers });
    const twins = build.selectionTwins().length;
    $('bTwinHint').hidden = !twins;
    $('bTwinHint').textContent = many
      ? `Symmetry is on: ${twins} mirror twin${twins > 1 ? 's' : ''} (blue boxes) follow these parts.`
      : 'Symmetry is on: moves, turns, skin and delete also apply to its mirror twin (blue box).';
    const skins = inst.info.skins.filter((s) => s.exists);
    $('bSkinWrap').hidden = skins.length < 2 || sel.some((i) => i.path !== inst.path);
    $('bSkin').innerHTML = skins.map((s) => `<option value="${esc(s.name)}" ${s.name === inst.skin ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    const p = inst.group.position;
    for (const [id, v] of [['bPx', p.x], ['bPy', p.y], ['bPz', p.z]]) if (document.activeElement !== $(id)) $(id).value = (Math.round(v * 1000) / 1000).toString();
    $('bOpenPart').disabled = many;
  }
  $('bExpSel').disabled = !sel.length;
  $('bExpSelWrap').classList.toggle('dim', !sel.length);
  syncBuildPaint();
  renderChecklist();
  renderGarage();
}

// ---- rebuilding a vehicle from the game: the parts checklist ------------------------------------------
// The parts a vehicle needs ("4 Bigfoot ST", "Werewolf" ...; checklist.js reads the list), counted off
// against the build as they are placed. A line with a known part puts it on the cursor.
state.checklist = []; // { name, count, st, done } (done: ticked by hand, for names no model has)
let nameIdx = null, nameIdxGen = -1;
function nameIndex() {
  if (nameIdxGen !== names.gen) {
    const paths = new Set([...Object.keys(names.builtin), ...Object.keys(names.user), ...Object.keys(names.zh?.parts || {})]); // (a part named only in names.zh.json is still a part: a pasted Chinese line finds it)
    nameIdx = new NameIndex([...paths].map((p) => [p, partName(p)]));
    nameIdxGen = names.gen;
  }
  return nameIdx;
}
// The part a line means ({ paths, name, guessed, suggest }) and how many of it the build has.
function checkItem(it) {
  const r = nameIndex().resolve(it.name);
  const paths = new Set(r.paths);
  const placed = paths.size ? build.instances.filter((i) => paths.has(i.path) && (!partStats.hasSteering(i.path) || !!i.st === !!it.st)).length : 0;
  return { ...r, placed };
}
// The model a line puts on the cursor: the part itself, not one of its kits or older models.
function lineModel(paths, name) {
  const own = paths.filter((p) => partName(p) === name);
  const pool = own.length ? own : paths;
  return pool.find((p) => state.folders.get(dirOf(p))?.main === p) || pool.find((p) => !/\(old model\)|\(before \d{4}\)/i.test(partName(p) || '')) || pool[0];
}
function renderChecklist() {
  const list = state.checklist;
  let need = 0, have = 0;
  $('ckList').innerHTML = list.map((it, k) => {
    const c = checkItem(it);
    need += it.count;
    if (!c.paths.length) {
      if (it.done) have += it.count;
      const why = c.suggest?.length
        ? `Which one? ${c.suggest.map((s) => `<button data-sug="${k}" data-name="${esc(s)}">${esc(s)}</button>`).join('')}`
        : `No part has this name: tick it off yourself, or <button data-find="${k}">search for it</button>`;
      return `<div class="ck-row${it.done ? ' done' : ''}" data-k="${k}"><input type="checkbox" data-tick="${k}"${it.done ? ' checked' : ''} title="Tick it off">` +
        `<span class="cn" title="${esc(it.name)}">${esc(it.name)}${it.st ? ' ST' : ''}<span class="cs warn">${why}</span></span><span class="cq">×${it.count}</span></div>`;
    }
    have += Math.min(c.placed, it.count);
    const shown = c.name + (it.st ? ' ST' : '');
    const cls = c.placed >= it.count ? 'done' : c.placed > 0 ? 'part' : 'todo';
    return `<div class="ck-row go ${cls}" data-k="${k}" title="Put ${esc(shown)} on the cursor"><span class="cq">${c.placed}/${it.count}</span>` +
      `<span class="cn">${esc(shown)}${c.guessed ? `<span class="cs">you wrote “${esc(it.name)}”</span>` : ''}</span><button class="cgo" data-go="${k}" tabindex="-1">Place</button></div>`;
  }).join('');
  $('ckCount').textContent = list.length ? tr('({have} of {need} placed)', { have, need }) : '';
  $('ckSummary').textContent = list.length ? tr('Edit the list') : tr('Type or paste the parts');
}
$('ckApply').addEventListener('click', () => {
  state.checklist = parseList($('ckText').value);
  $('ckEdit').open = !state.checklist.length;
  renderChecklist();
  autosave();
  status(state.checklist.length ? `${state.checklist.length} line${state.checklist.length > 1 ? 's' : ''} on the list: click one to place that part` : 'No parts in that text');
});
$('ckClear').addEventListener('click', async () => {
  if (state.checklist.length && !(await ask('Clear the parts list?', { title: 'Clear the list', yes: 'Clear' }))) return;
  state.checklist = [];
  $('ckText').value = '';
  renderChecklist();
  autosave();
});
$('ckList').addEventListener('click', (e) => {
  const tick = e.target.closest('[data-tick]');
  if (tick) { const it = state.checklist[+tick.dataset.tick]; if (it) { it.done = tick.checked; renderChecklist(); autosave(); } return; }
  const sug = e.target.closest('[data-sug]');
  if (sug) { const it = state.checklist[+sug.dataset.sug]; if (it) { it.name = sug.dataset.name; renderChecklist(); autosave(); } return; }
  const find = e.target.closest('[data-find]');
  if (find) {
    const it = state.checklist[+find.dataset.find];
    if (it) { $('search').value = it.name; $('search').dispatchEvent(new Event('input')); $('search').focus(); }
    return;
  }
  const row = e.target.closest('.ck-row.go');
  if (!row) return;
  const it = state.checklist[+row.dataset.k];
  const c = it && checkItem(it);
  if (!c?.paths.length) return;
  // (the builder may have been left while the build loaded: placing then went on in the 3D Viewer)
  afterBuildLoads().then(() => (state.view === 'build' ? build.startPlacing(lineModel(c.paths, c.name), '', { st: !!it.st }) : null)).then(renderList, (err) => status(err.message, true));
});

// ---- rebuilding a vehicle from the game: reference pictures ---------------------------------------------
function renderRefs() {
  const list = refs.list, r = refs.current();
  $('refCount').textContent = list.length ? `(${list.length})` : '';
  $('refEmptyHint').hidden = list.length > 0;
  $('refList').innerHTML = list.map((x, i) => `<div class="ref-row${i === refs.active ? ' on' : ''}" data-i="${i}" title="${esc(x.file)}${x.pinned ? '\nClick: back to its view' : ''}">` +
    `<img src="${DATA}/png?image=${enc(x.id)}&max=160" alt=""><span class="rn">${esc(x.name)}<span class="rs${x.pinned ? ' pin' : ''}">${x.pinned ? 'Pinned to a view' : 'Not pinned to a view yet'}</span></span>` +
    `<button class="rx" data-rm="${i}" title="Remove the picture">✕</button></div>`).join('');
  $('refControls').hidden = !r;
  $('refToggle').hidden = !list.length;
  $('refToggle').textContent = r && refs.shown ? 'Hide (P)' : 'Show (P)';
  if (!r) return;
  $('refOpacity').value = r.opacity;
  $('refOpacityVal').textContent = Math.round(r.opacity * 100) + '%';
  $('refLens').value = r.view.fov;
  $('refLensVal').textContent = Math.round(r.view.fov) + '°';
  $('refFront').checked = r.front;
  $('refAdjust').classList.toggle('on', refs.adjusting);
  $('refAdjust').textContent = refs.adjusting ? 'Done lining up' : 'Line it up';
  $('refPin').classList.toggle('primary', !r.pinned);
  $('refGo').disabled = !r.pinned;
}
$('refAdd').addEventListener('click', () => refs.add().catch((e) => status(e.message, true)));
$('refToggle').addEventListener('click', () => refs.toggle());
$('refList').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { refs.remove(+rm.dataset.rm); return; }
  const row = e.target.closest('.ref-row');
  if (row) refs.activate(+row.dataset.i);
});
$('refOpacity').addEventListener('input', () => { refs.set(refs.active, { opacity: +$('refOpacity').value }); $('refOpacityVal').textContent = Math.round(+$('refOpacity').value * 100) + '%'; });
$('refLens').addEventListener('input', () => { refs.setFov(+$('refLens').value); $('refLensVal').textContent = Math.round(+$('refLens').value) + '°'; });
$('refFront').addEventListener('change', () => refs.set(refs.active, { front: $('refFront').checked }));
$('refAdjust').addEventListener('click', () => refs.setAdjust(!refs.adjusting));
$('refPin').addEventListener('click', () => refs.pin());
$('refGo').addEventListener('click', () => { const r = refs.current(); if (r?.pinned) { refs.shown = true; refs.goTo(r); renderRefs(); } });

// ---- the garage (Vehicle Builder) ------------------------------------------------------------------------
// Like Crossout's garage: the energy bar over the vehicle, the card of the part under the cursor, the
// parts list with the vehicle's stats (H), augmented reality (F: weld points + firing arcs), the lift
// (C), and the camera keys (W A S D, Space, Shift; garage.js).
const instName = (i) => nameOrFile(i.path) + (i.st && partStats.hasSteering(i.path) ? ' ST' : '');
const buildParts = () => build.instances.map((i) => ({ id: i.id, path: i.path, st: i.st, name: instName(i) }));
const currentVehicle = () => vehicleStats(buildParts(), partStats);

function renderGarage() {
  if (state.view !== 'build') return;
  const v = currentVehicle();
  $('energyBar').innerHTML = energyBarHtml(v, { limits: !build.noLimits });
  $('bVehicle').innerHTML = vehicleStatsHtml(v, { limits: !build.noLimits });
  hydrateIcons($('energyBar'));
  hydrateIcons($('bVehicle'));
  if (!$('partsList').hidden) renderPartsList(v);
  renderPartCard();
}

// The part on the cursor, else the one under it, else the selected one.
function renderPartCard() {
  const el = $('partCard');
  const p = build.placing && !build.placing.group ? build.placing : build.hovered || build.get(build.selected);
  if (!p || state.view !== 'build' || !$('partsList').hidden) { el.hidden = true; return; }
  // (data-card, not data-key: hydrateIcons takes every [data-key] for a key cap, and a language switch
  // runs it over the whole page)
  const key = `${p.path}|${!!p.st}|${names.gen}|${getLang()}`;
  if (el.dataset.card !== key) {
    el.innerHTML = partCardHtml(nameOrFile(p.path) + (p.st && partStats.hasSteering(p.path) ? ' ST' : ''), p.path, partStats.item(p.path, p.st), { st: p.st && partStats.hasSteering(p.path) });
    el.dataset.card = key;
    hydrateIcons(el);
  }
  el.hidden = false;
}

function setAR(on, save = true) {
  state.ar = on;
  build.setWelds(on);
  build.setArcs(on);
  $('bAR').classList.toggle('on', on);
  syncArcSize();
  if (save) call('setSettings', { ar: on }).catch(() => {});
}
function setLift(on) {
  viewer.setLift(on);
  $('bLift').classList.toggle('on', on);
  status(on ? 'Car lifted: build underneath it, C lowers it again' : '');
}
$('bAR').addEventListener('click', () => setAR(!state.ar));
$('bLift').addEventListener('click', () => setLift(!viewer.lifted));

// Parts list (H): a picture per part, with its energy, and the vehicle's stats beside them.
const thumbs = new Map(); // `${path}|${skin}` -> PNG data URL, or the promise of one
let thumbGen = 0, thumbChain = Promise.resolve(), plQueued = false;
function thumbFor(inst) {
  const key = `${inst.path}|${inst.skin}`;
  const t = thumbs.get(key);
  if (typeof t === 'string') return t || null;
  if (!t) {
    const gen = thumbGen;
    const job = thumbChain.then(() => (gen === thumbGen && !$('partsList').hidden ? viewer.thumbnail(inst.info, { size: 96, texMax: build.texMax }).then((u) => u || '') : null)).catch(() => '');
    thumbChain = job;
    thumbs.set(key, job);
    job.then((url) => {
      if (gen !== thumbGen) return;
      if (url) thumbs.set(key, url);
      else if (url === '') thumbs.set(key, ''); // could not be pictured: no picture, no retry
      else thumbs.delete(key); // skipped (the list was closed): ask again next time
      schedulePartsList();
    });
  }
  return null;
}
function clearThumbs() { thumbs.clear(); thumbGen++; schedulePartsList(); }
function schedulePartsList() {
  if (plQueued || $('partsList').hidden) return;
  plQueued = true;
  requestAnimationFrame(() => { plQueued = false; if (!$('partsList').hidden) renderPartsList(); });
}
function renderPartsList(v = currentVehicle()) {
  const groups = { parts: [], structure: [], decor: [] };
  for (const p of sortParts(buildParts(), partStats)) groups[section(p.path)].push(p);
  const tiles = (list) => list.map((p) => {
    const i = build.get(p.id);
    return partTileHtml(p, partStats.item(p.path, p.st), p.name, { selected: build.isSelected(p.id), loose: build.loose.has(p.id), thumb: thumbFor(i) });
  }).join('');
  const scroll = $('plMain').scrollTop;
  $('plMain').innerHTML = [['parts', 'Parts of the blueprint'], ['structure', 'Structural parts of the blueprint'], ['decor', 'Decor']]
    .filter(([k]) => k === 'parts' || groups[k].length)
    .map(([k, title]) => `<h2>${title} <span class="count">${groups[k].length}</span></h2><div class="pl-grid">${tiles(groups[k]) || '<div class="hint">No parts yet.</div>'}</div>`).join('');
  $('plMain').scrollTop = scroll;
  $('plStats').innerHTML = vehicleStatsHtml(v, { limits: !build.noLimits });
  hydrateIcons($('partsList'));
}
function setPartsList(on) {
  if (on && state.view !== 'build') return;
  $('partsList').hidden = !on;
  $('bPartsList').classList.toggle('on', on);
  garageCam.clear();
  if (on) renderPartsList();
  renderPartCard();
}
$('bPartsList').addEventListener('click', () => setPartsList($('partsList').hidden));
$('plClose').addEventListener('click', () => setPartsList(false));
$('plMain').addEventListener('click', (e) => {
  const t = e.target.closest('.pl-tile');
  if (!t) return;
  const id = +t.dataset.id;
  if (e.ctrlKey || e.metaKey) { build.select(id, { toggle: true }); return; }
  build.select(id);
  setPartsList(false);
});
$('bSt').addEventListener('change', () => build.setSteering(build.selected, $('bSt').checked));

// The HUD, the minimap and the texture preview sit below the toolbar, however many lines it wraps to
// (whichever view's toolbar is showing).
const toolsObserver = new ResizeObserver(() => {
  const t = ['viewTools', 'buildTools', 'mapTools'].map((id) => $(id)).find((x) => !x.hidden && x.offsetHeight);
  if (t) $('center').style.setProperty('--tools-bottom', `${t.offsetTop + t.offsetHeight}px`);
});
for (const id of ['viewTools', 'buildTools', 'mapTools']) toolsObserver.observe($(id));
// Small 3D view (a laptop screen): toolbar buttons show only their icons, and the key list folds
// away behind a "Keys" button, so the vehicle isn't hidden behind them.
function layoutCompact() {
  const c = $('center'), compact = c.clientWidth < 1100 || c.clientHeight < 650;
  c.classList.toggle('compact', compact);
  $('keysBtn').hidden = !compact || state.view !== 'build';
}
new ResizeObserver(layoutCompact).observe($('center'));
$('keysBtn').addEventListener('click', () => $('buildHint').classList.toggle('open'));

let listAnchor = null; // the row a Shift+click range starts from
$('bList').addEventListener('click', (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) { build.unloaded.splice(+drop.dataset.drop, 1); renderBuildPanel(); autosave(); status('The missing part is out of the build'); return; }
  const del = e.target.closest('[data-del]');
  if (del) { // (with Symmetry on, the mirror twin goes too, as with Del)
    if (build.loadingNow) return; // (an edit while the build loads: see Build.setSelection)
    const inst = build.get(+del.dataset.del);
    if (inst) { const twin = build.symmetry ? build.twinOf(inst) : null; build.removeInstance(inst); if (twin) build.removeInstance(twin); build.commit(); }
    return;
  }
  const row = e.target.closest('.brow');
  if (!row || row.classList.contains('missing')) return; // (no part to select: it cleared the selection, and dropped a held part)
  const id = +row.dataset.id;
  if (e.shiftKey && build.get(listAnchor)) {
    const ids = build.instances.map((i) => i.id);
    const [a, b] = [ids.indexOf(listAnchor), ids.indexOf(id)].sort((x, y) => x - y);
    build.selectMany(ids.slice(a, b + 1).filter((x) => x !== id).concat(id), { add: e.ctrlKey });
    return;
  }
  if (e.ctrlKey || e.metaKey) build.select(id, { toggle: true });
  else build.select(id);
  listAnchor = id;
});
$('bName').addEventListener('input', () => { build.name = $('bName').value.trim() || 'My build'; autosave(); });
$('ckText').addEventListener('input', () => autosave()); // (it is saved with the build: the dot and the autosave missed it)
const buildBusy = () => { if (!state.restoring && !state.loadingBuild) return false; status('The build is still loading: New and Open wait until it is in', true); return true; };
// Open before the last build came back (the game data still being read): the opened build stays, the old one
// does not come back over it later (it is kept as the host's autosave.previous.xobuild). Not New: before the
// restore there is nothing on the screen to throw away, and the last build still comes back.
const claimRestore = () => { if (!state.buildRestored) { state.buildRestored = true; state.restorePending = false; } };
// (Export and Test drive took the parts loaded so far: a part of the build, said to be all of it)
const buildLoading = (what) => { if (!state.restoring && !state.loadingBuild) return false; status(`The build is still loading: ${what} when it is in`, true); return true; };
$('bNew').addEventListener('click', async () => {
  if (buildBusy()) return;
  if (buildDirty() && !(await ask('Start a new build? Parts, pictures and the parts list that are not saved will be lost.', { title: 'New build', yes: 'Start a new one' }))) return;
  if (buildBusy()) return; // (one began loading while the question was up)
  const old = usedTextures();
  // B7: the old build's replaced textures go too, not only its colour edits (they came back on the
  // same parts in the new build, and into its file)
  for (const b of old) if (state.replace[b]) { call('releaseImage', { id: state.replace[b].id }).catch(() => {}); viewer.setReplacement(b, null); delete state.replace[b]; }
  state.replaceKept = {};
  await build.clear();
  build.unloaded = [];
  build.name = 'My build';
  for (const b of old) { delete state.adjust[b]; showAdjust(b); }
  await refs.clear();
  state.checklist = [];
  $('ckText').value = '';
  clearThumbs();
  state.buildFile = { path: '', print: '' };
  renderBuildPanel();
  build.frame();
  autosave();
  syncSaveState();
});
$('bSave').addEventListener('click', () => saveBuild());
$('bSaveAs').addEventListener('click', () => saveBuild({ as: true }));
$('bQuickSave').addEventListener('click', () => saveBuild());
$('bOpen').addEventListener('click', async () => {
  if (buildBusy()) return;
  try {
    const r = await call('openText', { ext: 'xobuild', title: 'Open build', label: 'Grimcold build' });
    if (!r) return;
    // (as New asks: Open replaced the build and its autosave without a word)
    if (buildDirty() && !(await ask('Open this build in place of the current one? Parts, pictures and the parts list that are not saved will be lost.', { title: 'Open build', yes: 'Open it' }))) return;
    if (buildBusy()) return; // (one began loading while the file dialog or the question was up)
    const data = JSON.parse(r.text); // (checked first: a file that is no build leaves the last build to come back)
    if (!data || data.kind !== 'build' || !Array.isArray(data.parts)) throw new Error('not a Grimcold build');
    claimRestore();
    const failed = await loadBuildFile(data, r.path);
    if (failed) { // (null: another build took over meanwhile)
      state.buildFile = { path: r.path, print: buildPrint() };
      autosave();
      syncSaveState();
    }
  } catch (e) { status(e.message, true); }
});
$('bUndo').addEventListener('click', () => build.undo());
$('bRedo').addEventListener('click', () => build.redo());
$('bSym').addEventListener('change', () => build.setSymmetry($('bSym').checked).then(renderBuildPanel).catch((e) => status(e.message, true)));
// Limits (the game's garage rules) or No limits (none at all), remembered.
function setLimits(on, save = true) {
  build.setNoLimits(!on);
  $('bLimitsSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.dataset.l === 'on') === on));
  renderGarage();
  if (save) {
    status(on ? 'Limits: the game\'s garage rules' : 'No limits: any number of parts, cabins and engines, parts inside each other');
    call('setSettings', { buildLimits: on }).catch(() => {});
  }
}
$('bLimitsSeg').addEventListener('click', (e) => { const b = e.target.closest('button[data-l]'); if (b) setLimits(b.dataset.l === 'on'); });
$('bGizmo').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-g]');
  if (!b) return;
  $('bGizmo').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  build.setGizmoMode(b.dataset.g);
});
$('bTextures').addEventListener('change', () => { viewer.setOption('textures', $('bTextures').checked); syncToggles(); });
for (const id of ['optTextures', 'optGrid', 'bTextures', 'bGrid', 'mTextures']) // (remembered, like Shadows; after the box's own handler has
  $(id).addEventListener('change', () => setTimeout(() => call('setSettings', { textures: viewer.options.textures, grid: viewer.options.grid }).catch(() => {}))); // applied it)
$('bGrid').addEventListener('change', () => { viewer.setOption('grid', $('bGrid').checked); syncToggles(); });
$('bFrame').addEventListener('click', () => build.frame({ animate: true }));
$('buildHint').innerHTML = controlsHtml();
$('bShot').addEventListener('click', () => screenshot(build.name + '_view'));
for (const [id, axis] of [['bPx', 0], ['bPy', 1], ['bPz', 2]])
  $(id).addEventListener('change', () => {
    const inst = build.get(build.selected);
    if (!inst) return;
    const p = inst.group.position.toArray();
    let v = parseFloat($(id).value);
    // (a part half a cell off the boxes' 0.3 m steps: their arrows step half a cell, which went nowhere one
    // way; it is a whole cell that way)
    if (Math.abs(Math.abs(v - p[axis]) - CELL / 2) < 1e-4) v = p[axis] + Math.sign(v - p[axis]) * CELL;
    p[axis] = v;
    build.setPosition(inst.id, p);
    $(id).value = (Math.round(inst.group.position.getComponent(axis) * 1000) / 1000).toString(); // (it went by whole cells: the box shows where)
  });
document.querySelector('#bSelCard .rot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-turn]');
  if (!b) return;
  const [kind, sign] = b.dataset.turn.split(',');
  build.turn(kind, +sign);
});
$('bMove').addEventListener('click', () => build.moveSelected().catch((e) => status(e.message, true)));
$('bDup').addEventListener('click', () => build.duplicateSelected().catch((e) => status(e.message, true)));
$('bMirror').addEventListener('click', () => build.toggleMirror());
$('bMirrorSide').addEventListener('click', () => build.mirrorToOtherSide().catch((e) => status(e.message, true)));
$('bStickerClear').addEventListener('click', () => build.clearStickers());

// ---- stickers (stickers.js): the game's, stuck on the builder's vehicle -------------------------------
let stickerPackList = null; // pack -> bases (from the game's file list)
function fillStickers() {
  if (!stickerPackList || stickerPackList.files !== state.files || stickerPackList.lang !== getLang()) {
    stickerPackList = { files: state.files, packs: stickerPacks(state.files), lang: getLang() };
    const sel = $('bStickerPack'), keep = state.settings.stickerPack;
    sel.innerHTML = [...stickerPackList.packs.keys()].map((p) => `<option value="${p}">${esc(tKey('sticker pack:' + p, packLabel(p)))} (${stickerPackList.packs.get(p).length})</option>`).join('');
    if (keep && stickerPackList.packs.has(keep)) sel.value = keep;
    $('bStickerCard').hidden = !stickerPackList.packs.size;
  }
  const bases = stickerPackList.packs.get($('bStickerPack').value) || [];
  $('bStickerGrid').innerHTML = bases.map((b) => `<button class="sticker" data-base="${b}" title="${b.split('/').pop()}"><img loading="lazy" alt="" src="${stickerThumb(b)}"></button>`).join('');
  syncStickers();
}
function stickerSize() { return Math.min(STICKER_SIZE.max, Math.max(STICKER_SIZE.min, +$('bStickerSize').value || STICKER_SIZE.def)); }
function stickerAngle() { return ((+$('bStickerAngle').value || 0) * Math.PI) / 180; }
function syncStickers() {
  const t = build.stickerTool;
  for (const b of $('bStickerGrid').children) b.classList.toggle('on', !!t && b.dataset.base === t.base);
  $('bStickerDone').hidden = !t;
  $('bStickerSizeV').textContent = `${stickerSize().toFixed(2)} m`;
  $('bStickerAngleV').textContent = `${Math.round(+$('bStickerAngle').value || 0)}°`;
}
function setStickerTool(base) {
  if (base && state.paintMode === 'brush') setPaintMode('all'); // (one tool on the vehicle at a time)
  build.setStickerTool(base ? { base, size: stickerSize(), angle: stickerAngle() } : null);
  syncStickers();
  if (base) status('Click the vehicle to stick it · Q / E turn · − / + size · Esc: done', false, true);
  else status('');
}
function stickerChanged() {
  if (build.stickerTool) build.setStickerTool({ ...build.stickerTool, size: stickerSize(), angle: stickerAngle() });
  syncStickers();
}
// keys while sticking: Q / E turn it 15°, - / + size it, Esc puts the tool away
function stickerKey(k) {
  if (k === 'escape') { setStickerTool(null); return true; }
  if (k === 'q' || k === 'e') {
    const a = (+$('bStickerAngle').value || 0) + (k === 'q' ? 15 : -15);
    $('bStickerAngle').value = String(((((a + 180) % 360) + 360) % 360) - 180);
  } else if (k === '-' || k === '_' || k === '=' || k === '+') {
    $('bStickerSize').value = String(Math.round(Math.min(STICKER_SIZE.max, Math.max(STICKER_SIZE.min, stickerSize() * (k === '-' || k === '_' ? 1 / 1.15 : 1.15))) * 100) / 100);
  } else return false;
  stickerChanged();
  return true;
}
$('bStickerPack').addEventListener('change', () => { call('setSettings', { stickerPack: $('bStickerPack').value }).catch(() => {}); state.settings.stickerPack = $('bStickerPack').value; fillStickers(); });
$('bStickerGrid').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-base]');
  if (!b) return;
  setStickerTool(build.stickerTool?.base === b.dataset.base ? null : b.dataset.base);
});
$('bStickerSize').addEventListener('input', stickerChanged);
$('bStickerAngle').addEventListener('input', stickerChanged);
$('bStickerDone').addEventListener('click', () => setStickerTool(null));
$('bDel').addEventListener('click', () => build.deleteSelected());
$('bSkin').addEventListener('change', () => build.setSkin(build.selected, $('bSkin').value).catch((e) => status(e.message, true)));
$('bOpenPart').addEventListener('click', () => { const inst = build.get(build.selected); if (inst) openModel(inst.path, { skin: inst.skin }); });

// ---- paint (paints.js) ------------------------------------------------------------------------------
// The game's paints, as the garage paints: the 3D Viewer's on its part; in the builder the vehicle's
// (every part without a paint of its own), the selected parts', or the brush's (a click on a part paints
// it, a drag paints every part it passes over, Alt+click takes a part's paint).
const viewPicker = new PaintPicker($('vPaintPicker'), { catalog: () => state.paintCatalog, onChange: (p) => setViewPaint(p) });
function setViewPaint(p) {
  state.viewPaint = p ? normPaint(p) : null;
  viewer.setPartPaint(state.viewPaint);
  viewPicker.setValue(state.viewPaint);
  $('vPaintOff').disabled = !state.viewPaint;
  if (state.info && state.openAdjust.size) renderMaterials(); // (its textures' own paint is covered now, or not)
}
$('vPaintOff').addEventListener('click', () => { setViewPaint(null); status('The part has no paint now (its textures\' own colours show)'); });
// whether the open part has a paint mask anywhere (a gloss map: its red says where paint goes)
function syncPaintMask() {
  const masked = !!state.info && usedMaterials().some((mi) => (state.info.materials[mi]?.textures || []).some((t) => t.role === 'gloss' && t.exists));
  $('vPaintNoMask').hidden = !state.info || masked;
}

const PAINT_MODES = {
  all: 'The vehicle\'s paint: on every part that has no paint of its own (parts added later too).',
  sel: 'Paints the selected parts (click a part, Shift+drag a box, Ctrl+A) and, with Symmetry on, their mirror twins.',
  brush: 'Click a part to paint it, or drag over several. Alt+click a part to take its paint. Esc stops.',
};
const buildPicker = new PaintPicker($('bPaintPicker'), { catalog: () => state.paintCatalog, onChange: (p, final) => pickBuildPaint(p, final) });
// The paint the card shows: the vehicle's, the primary selected part's, or the brush's.
function shownBuildPaint() {
  if (state.paintMode === 'sel') { const i = build.get(build.selected); return i ? build.paintOf(i) : null; }
  if (state.paintMode === 'brush') return build.brush;
  return build.paint;
}
function pickBuildPaint(p, final) {
  if (state.paintMode === 'sel') {
    const sel = build.selection();
    if (!sel.length) { status('Select the parts to paint first: click one, or Shift+drag a box around several', true); syncBuildPaint(); return; }
    build.setPartsPaint(sel, p, { commit: final });
  } else if (state.paintMode === 'brush') {
    build.setBrush(true, p);
    if (final) status(`Brush: ${paintLabel(p, state.paintCatalog).name}. Click parts to paint them, or drag over several.`);
  } else if (!build.setVehiclePaint(p, { commit: final })) { syncBuildPaint(); return; } // (refused: the picker shows the build's again)
  clearThumbs();
}
function setPaintMode(mode) {
  state.paintMode = mode;
  $('bPaintMode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (mode === 'brush' && !build.brush) build.brush = build.paint || normPaint({ kind: 'color', color: build.paintColor, amount: 0.85 }); // (it starts with the vehicle's paint)
  if (mode === 'brush' && build.stickerTool) setStickerTool(null); // (one tool on the vehicle at a time)
  build.setBrush(mode === 'brush' && state.view === 'build');
  if (mode === 'brush') status(PAINT_MODES.brush);
  syncBuildPaint();
}
$('bPaintMode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b) setPaintMode(b.dataset.mode); });
// Alt+click with the brush: the part's paint becomes the brush's.
function takePaint(p, inst) {
  build.setBrush(true, p || { kind: 'color', color: build.paintColor, amount: 0 });
  syncBuildPaint();
  status(`Took ${p ? paintLabel(p, state.paintCatalog).name : 'no paint'} from ${instName(inst)}`);
}
$('bPaintOff').addEventListener('click', () => {
  const m = state.paintMode;
  if (m === 'sel') {
    const sel = build.selection();
    if (!sel.length) { status('Select the parts first', true); return; }
    build.setPartsPaint(sel, { kind: 'color', color: build.paintColor, amount: 0 }); // (bare, under a painted vehicle too)
    status(`No paint on ${sel.length > 1 ? sel.length + ' parts' : instName(sel[0])}`);
  } else if (m === 'brush') {
    build.setBrush(true, { kind: 'color', color: build.paintColor, amount: 0 });
    status('The brush takes paint off now: click or drag over parts');
  } else {
    if (!build.setVehiclePaint(null)) return; // (refused: it said why)
    status('The vehicle has no paint now (parts painted on their own keep theirs)');
  }
  clearThumbs();
  syncBuildPaint();
});
$('bPaintOwnClear').addEventListener('click', () => {
  const n = build.clearPartPaints();
  if (n) status(`${n} part${n > 1 ? 's' : ''} now take${n > 1 ? '' : 's'} the vehicle's paint`);
  clearThumbs();
});
$('bPaintSelVehicle').addEventListener('click', () => {
  const sel = build.selection();
  if (!sel.length) return;
  build.setPartsPaint(sel, null);
  status(`${sel.length > 1 ? sel.length + ' parts take' : instName(sel[0]) + ' takes'} the vehicle's paint`);
  clearThumbs();
});
function syncBuildPaint() {
  const m = state.paintMode, sel = build.selection(), own = build.instances.filter((i) => i.paint).length;
  buildPicker.setValue(shownBuildPaint());
  $('bPaintHint').textContent = m === 'sel' && !sel.length ? 'Select the parts to paint: click one, or Shift+drag a box around several.' : PAINT_MODES[m];
  $('bPaintOff').textContent = m === 'sel' ? 'Remove their paint' : m === 'brush' ? 'Brush takes paint off' : 'Remove the vehicle\'s paint';
  $('bPaintOff').disabled = m === 'all' ? !build.paint : m === 'sel' ? !sel.length : false;
  $('bPaintSelVehicle').hidden = m !== 'sel' || !sel.some((i) => i.paint);
  $('bPaintOwnRow').hidden = m !== 'all' || !own;
  $('bPaintOwnText').textContent = `${own} part${own > 1 ? 's have their' : ' has its'} own paint.`;
}
// a part's own paint in the parts list: its colour, pattern or ramp
function paintDot(p) {
  const l = paintLabel(p, state.paintCatalog);
  const bg = p.amount <= 0 ? '' : p.kind === 'color' ? `background:${hex(p.color)}` : `background:url('${thumbOf(p.tex, 32)}') center / cover`;
  return `<span class="bp${p.amount <= 0 ? ' bare' : ''}" style="${bg}" title="Own paint: ${esc(l.name)}${l.kind && l.kind !== 'bare' ? ' (' + esc(l.kind) + ')' : ''}"></span>`;
}

// build files carry the parts plus the colour edits / replaced images of the textures they use
function usedTextures() {
  const used = new Set();
  for (const i of build.instances) for (const m of i.info.materials) for (const t of m.textures || []) used.add(t.base);
  return used;
}
function buildFile() {
  const data = build.serialize();
  data.parts.push(...build.unloaded); // parts this game version could not load stay in the file
  const used = usedTextures();
  data.adjust = Object.fromEntries(Object.entries(state.adjust).filter(([b, a]) => used.has(b) && isAdjusted(a)));
  data.replace = { ...Object.fromEntries(Object.entries(state.replaceKept || {}).filter(([b]) => used.has(b) && !state.replace[b])),
    ...Object.fromEntries(Object.entries(state.replace).filter(([b]) => used.has(b)).map(([b, r]) => [b, { file: r.file, name: r.name }])) };
  // rebuilding aids: the reference pictures (by file) and the parts checklist
  if (refs.list.length || refs.unread.length) data.refs = refs.serialize(); // (also when none of them can be read now)
  if (state.checklist.length || $('ckText').value.trim()) data.checklist = { text: $('ckText').value, items: state.checklist.map(({ name, count, st, done }) => ({ name, count, st, done })) };
  return data;
}

// Save writes to the build's own file without asking, once it has one (saved there, or opened from
// there); Save as… (and the first save) asks where. What the file held is kept as a fingerprint, so
// the Save button shows a dot while the build has changes the file does not.
function fingerprint(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(16)}:${text.length}`;
}
// (which reference picture is up is not a change of the build: clicking one showed "unsaved changes")
const printOf = (data) => fingerprint(JSON.stringify(data.refs ? { ...data, refs: { ...data.refs, active: undefined } } : data));
const buildPrint = () => printOf(buildFile());
const buildHasContent = () => !!(build.instances.length || build.unloaded.length || refs.list.length || refs.unread.length || state.checklist.length || $('ckText').value.trim());
function buildDirty() {
  if (!state.buildRestored || state.loadingBuild) return false;
  return state.buildFile.path ? buildPrint() !== state.buildFile.print : buildHasContent();
}
function syncSaveState() {
  const dirty = buildDirty(), path = state.buildFile.path, name = path ? path.split(/[\\/]/).pop() : '';
  $('bQuickSave').classList.toggle('dirty', dirty);
  $('bQuickSave').title = `${path ? tr('Save to {path}', { path }) : tr('Save the build to a file')} (Ctrl+S)${dirty ? tr(' · it has unsaved changes') : ''}`;
  $('bFile').textContent = path ? `${name} · ${dirty ? tr('unsaved changes') : tr('saved')}` : dirty ? tr('Not saved to a file yet') : '';
  $('bFile').title = path ? `${path}${dirty ? '\n' + tr('The build has changes the file does not have yet: Save (Ctrl+S)') : ''}` : '';
  $('bFile').classList.toggle('unsaved', dirty);
}
async function saveBuild({ as = false, outPath } = {}) { // (outPath: the tests' answer to the dialog)
  if (state.loadingBuild) { status('The build is still loading', true); return false; }
  try {
    const data = buildFile(), path = !as && state.buildFile.path;
    const r = await call('saveText', { text: JSON.stringify(data, null, 2), ext: 'xobuild', name: build.name, title: as ? 'Save build as' : 'Save build', label: 'Grimcold build', ...(path ? { path } : {}), ...(outPath ? { outPath } : {}) });
    if (!r) return false;
    state.buildFile = { path: r.path, print: printOf(data) };
    autosave(); // (the autosave remembers the file: after a restart Save still goes there)
    syncSaveState();
    status(`Build saved: ${r.path}`);
    return true;
  } catch (e) { status(e.message, true); return false; }
}

// Opens a build: its colour edits and replaced images take the place of the old build's (they are
// not merged in). Parts that can't be loaded are kept in the build file (build.unloaded) and named
// in a warning that stays on the status line.
async function loadBuildFile(data, from = '', { quiet = false } = {}) {
  if (!data || data.kind !== 'build' || !Array.isArray(data.parts)) throw new Error('not a Grimcold build');
  busy(true, 'Loading the build…');
  state.loadingBuild = (state.loadingBuild || 0) + 1; // (a count: an older load ending must not say "done" for a newer one)
  let job, held = null;
  state.buildJob = new Promise((res) => (job = res));
  try {
    const old = usedTextures();
    for (const b of old) {
      delete state.adjust[b];
      if (state.replace[b]) { call('releaseImage', { id: state.replace[b].id }).catch(() => {}); delete state.replace[b]; viewer.setReplacement(b, null); }
    }
    for (const [b, a] of Object.entries(data.adjust || {})) state.adjust[b] = a;
    const { out, missing } = await reattachImages(data.replace);
    // (an image that can't be read now, on a stick or renamed, stays in the build: it was dropped from
    // the autosave 0.6 s later)
    state.replaceKept = Object.fromEntries(Object.entries(data.replace || {}).filter(([b, r]) => r?.file && !out[b]));
    for (const [b, r] of Object.entries(out)) {
      if (state.replace[b]) call('releaseImage', { id: state.replace[b].id }).catch(() => {});
      state.replace[b] = r;
      viewer.setReplacement(b, { id: r.id });
    }
    const failed = await build.load(data, { onProgress: (k, n) => $('busyText').textContent = `Loading the build… ${k}/${n}` });
    if (failed === null) return null; // (another build, or New, took over)
    // (its pictures are still to come: no edits until they are in either, as during build.load; Open takes the
    // file's print after this, so an edit meanwhile showed as saved)
    held = build.loadGen;
    build.loadingNow = true;
    for (const b of new Set([...old, ...Object.keys(data.adjust || {})])) showAdjust(b);
    clearThumbs();
    $('bName').value = build.name;
    // the rebuilding aids that came with it (a build without them clears the old ones)
    const missingRefs = await refs.load(data.refs);
    state.checklist = (Array.isArray(data.checklist?.items) ? data.checklist.items : [])
      .map((it) => ({ name: String(it.name || '').trim(), count: Math.max(1, Math.round(+it.count) || 1), st: !!it.st, done: !!it.done })).filter((it) => it.name);
    $('ckText').value = typeof data.checklist?.text === 'string' ? data.checklist.text : '';
    $('ckEdit').open = false;
    build.frame();
    renderBuildPanel();
    missing.push(...missingRefs);
    const problems = [...failed.map((f) => `${f.part.path}: ${f.error}`), ...missing.map((m) => 'missing image ' + m)];
    if (problems.length) status(`${failed.length ? `${failed.length} part${failed.length > 1 ? 's' : ''} could not be loaded (kept in the build file)` : 'Build loaded'}${missing.length ? `, ${missing.length} image${missing.length > 1 ? 's' : ''} missing` : ''}: ${problems.slice(0, 3).join('; ')}`, true, true);
    else if (!quiet) status(from ? tr('Build loaded: {from} ({n} parts)', { from, n: build.instances.length }) : tr('Build loaded ({n} parts)', { n: build.instances.length }));
    return failed;
  } finally {
    if (held !== null && held === build.loadGen) build.loadingNow = false; // (not a newer load's)
    state.loadingBuild--;
    job();
    busy(false); // (each load its own: two at once left the pill up for the session)
    if (!state.loadingBuild) autosave(); // (the whole build, now that it is in)
  }
}

$('bExport').addEventListener('click', () => {
  if (buildLoading('export it')) return;
  if (!build.instances.length) { status('The build is empty', true); return; }
  runExport('exportBuild', {
    parts: build.exportItems({ onlySelected: $('bExpSel').checked }).map((p) => ({ ...p, name: (partName(p.path) || p.name) + (p.st && partStats.hasSteering(p.path) ? ' ST' : '') })), // (named as in the game, as instName())
    name: build.name, format: state.buildFmt, lod: +$('bLod').value, textures: $('bExpTextures').checked, maxTex: +$('bMaxTex').value || 0,
    dds: $('bExpDds').checked, extraMaps: $('bExpExtra').checked, ao: $('bExpAo').checked, split: $('bExpSplit').checked, heat: 0, ...editsForExport(), // (cold, as the builder shows them)
    stickers: build.exportStickers({ onlySelected: $('bExpSel').checked }),
  }, $('bProgress'), $('bResult'), $('bExport'));
});

// autosave: the build survives closing the app
// Autosave: the build survives closing the app. Nothing is written until the last build has been
// restored (so a start-up hiccup can never overwrite it), and the host asks for one last save
// (window.__xoFlush) when the window closes, so the last edits are not lost.
// (nothing while a build file is still loading: a half-loaded build is not worth saving)
const autosaveText = () => (state.buildRestored && !state.loadingBuild ? JSON.stringify({ ...buildFile(), ...(state.buildFile.path ? { file: state.buildFile } : {}) }) : null);
let autosaveError = ''; // (said once, not on every edit)
const autosave = debounce(() => {
  const text = autosaveText();
  if (text) call('autosave', { text }).then(() => { autosaveError = ''; }, (e) => {
    if (e.message !== autosaveError) { autosaveError = e.message; status(`Autosave: ${e.message}`, true, true); }
  });
  syncSaveState();
}, 600);
window.__xoFlush = autosaveText;

// Runs once the game data is open (at start-up, or after the game folder is picked). Parts that
// can't be loaded (a model the current game no longer has) stay in the file, untouched.
function restoreAutosave() {
  if (state.buildRestored || state.restoring) return state.buildJob;
  state.restoring = true;
  state.buildJob = restoreJob();
  return state.buildJob;
}
async function restoreJob() {
  try {
    const r = await call('autoload', {});
    const data = r?.text ? JSON.parse(r.text) : null;
    let failed = [];
    if (data && !data.parts?.length && !data.refs && !data.checklist) { // (no parts: its name and paint)
      build.name = data.name || build.name;
      $('bName').value = build.name;
      build.loadPaint(data);
      build.history = [build.snapshot()];
      build.future = [];
    }
    else if (data) {
      failed = await loadBuildFile(data, '', { quiet: true });
      if (failed && !failed.length) status(`Restored your last build (${build.instances.length} parts)`);
    }
    // (tied to its file again, unless another build took its place while it loaded)
    if (failed && typeof data?.file?.path === 'string' && data.file.path) state.buildFile = { path: data.file.path, print: String(data.file.print || '') };
    state.buildRestored = true;
    state.restorePending = false;
  } catch (e) {
    // (new work is saved as usual; the host keeps the file it could not read as autosave.previous.xobuild
    // in the data folder before its first save of the session)
    status(`Could not restore the last build (${e.message}). It is kept as autosave.previous.xobuild in the app's data folder.`, true, true);
    state.buildRestored = true;
  } finally {
    state.restoring = false;
    if (state.view === 'build') renderBuildPanel();
    syncSaveState();
  }
}

// ---- Maps ----------------------------------------------------------------------------------------
// 文件夹名 → 显示名：上游的英文写法（下划线换空格、首字母大写），有中文名时用中文
const mapTitleEn = (name) => name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const mapTitle = (name) => (wantZh() && mapsZh && mapsZh[name]) || mapTitleEn(name);

// (opened with a map at once, as Test drive does, the list waits behind the map's own files; it
// says so meanwhile, and asks again if it fails)
async function loadMapList(tries = 3) {
  if (state.map.listLoading) return;
  state.map.listLoading = true;
  renderMapList();
  try {
    const r = await fetch(`${DATA}/maps`);
    if (!r.ok) throw new Error(await r.text());
    state.map.list = await r.json();
  } catch (e) {
    state.map.list = null;
    if (tries > 1 && state.gameReady) setTimeout(() => { if (!state.map.list) loadMapList(tries - 1); }, 2000);
    else status(e.message, true);
  } finally {
    state.map.listLoading = false;
  }
  renderMapList();
  revealMapSel();
}
const revealMapSel = () => $('mapList').querySelector('.map-row.sel')?.scrollIntoView({ block: 'nearest' });

function renderMapList() {
  const all = state.map.list || [];
  const q = state.map.query.trim().toLowerCase();
  // (中文名开着的时候英文也要搜得到：两种写法都比一遍)
  const list = all.filter((m) => !q || m.name.includes(q.replace(/ /g, '_'))
    || mapTitleEn(m.name).toLowerCase().includes(q) || mapTitle(m.name).toLowerCase().includes(q));
  const size = (m) => (m.terrain ? `${Math.round(m.sizeX)} × ${Math.round(m.sizeZ)} m` : tr('no terrain'));
  // a variant without a loading picture of its own ("arena_canyon_dronebattle") shows its map's
  const pics = new Map(all.filter((m) => m.picture).map((m) => [m.name, m.picture]));
  // (its own loading picture, else its map's, else the game's minimap of it: arenas and hangars have no picture)
  const picture = (m) => { if (m.picture) return m.picture; for (let n = m.name; n.includes('_');) { n = n.slice(0, n.lastIndexOf('_')); if (pics.has(n)) return pics.get(n); } return m.hudmap || ''; };
  $('mapList').innerHTML = list.length ? list.map((m) => `<div class="map-row${m.name === state.map.name ? ' sel' : ''}" data-map="${esc(m.name)}" title="levels/maps/${esc(m.name)}">
    ${picture(m) ? `<img loading="lazy" src="${DATA}/png?base=${enc(picture(m))}&max=160&view=opaque" alt="">` : '<span class="ph"></span>'}
    <div><div class="mn">${esc(mapTitle(m.name))}</div><div class="ms">${size(m)}</div></div></div>`).join('')
    : `<div class="list-empty">${state.map.list ? (all.length ? tr('Nothing matches.') : tr('No maps found.')) : state.map.listLoading ? tr('Loading the maps…') : tr('No game data loaded.')}</div>`;
}
$('mapList').addEventListener('click', (e) => {
  const r = e.target.closest('[data-map]');
  if (!r) return;
  if (r.dataset.map === state.map.name && (mapView.scene?.name === r.dataset.map || (mapView.loading && !mapView.loading.finished))) { status(`${mapTitle(r.dataset.map)} is open`); return; }
  openMap(r.dataset.map);
});
$('mapSearch').addEventListener('input', debounce(() => { state.map.query = $('mapSearch').value; renderMapList(); }, 100));

// Opens a map (keepCamera: the same map again in another mode / festival / weather, seen from where
// it was; environment: '' = the map's own weather for the festival and mode).
let mapToken = 0;
async function openMap(name, { festival = 'Empty', gameplay = 'auto', environment = '', keepCamera = false } = {}) {
  const token = ++mapToken;
  crumb('map', `${name}${environment ? ' weather ' + environment : ''}${festival !== 'Empty' ? ' ' + festival : ''}`);
  if (state.view !== 'map') setView('map');
  state.map.name = name;
  renderMapList();
  revealMapSel();
  $('mxResult').innerHTML = '';
  $('msResult').innerHTML = '';
  mapObjects.clear();
  loading(true, `Loading ${mapTitle(name)}…`);
  // (the same map again keeps the camera, what was hidden and the selection: MapView.load)
  try {
    const scene = await mapView.load(name, { festival, gameplay, environment, keepCamera });
    if (!scene || token !== mapToken) return null;
    syncMapView();
    hydrateIcons($('mapKeys'));
    renderMapPanel();
    renderMapSpeed();
    const n = scene.models.reduce((a, m) => a + m.m.length / 12, 0);
    status(tr('{name}: {n} objects of {m} models · W A S D to fly, 1-9 for the speed', { name: mapTitle(name), n: n.toLocaleString(), m: scene.models.length }));
    return scene;
  } catch (e) {
    if (token === mapToken) { status(e.message, true); syncMapView(); renderMapPanel(); }
    return null;
  } finally {
    loading(false);
  }
}

let mapPanelQueued = false;
function scheduleMapPanel() {
  if (mapPanelQueued) return;
  mapPanelQueued = true;
  requestAnimationFrame(() => { mapPanelQueued = false; renderMapPanel(); });
}

function renderMapPanel() {
  if (state.view !== 'map') return;
  const s = mapView.stats();
  $('mxExport').disabled = !s || state.mapExporting; // (a second whole-map export ran alongside: gigabytes)
  if (!s) {
    $('mpName').textContent = state.map.name && mapView.loading ? mapTitle(state.map.name) : tr('No map open');
    $('mpPath').textContent = '';
    $('mpStats').innerHTML = '';
    $('mpLoad').hidden = true;
    $('mpErrors').innerHTML = '';
    $('mpMode').innerHTML = $('mpFestival').innerHTML = $('mpEnv').innerHTML = '';
    $('mpMode').disabled = $('mpFestival').disabled = $('mpEnv').disabled = true;
    $('mpMode').closest('label').hidden = $('mpFestival').closest('label').hidden = $('mpEnv').closest('label').hidden = true; // (empty menus said nothing)
    $('mpMissingCard').hidden = true;
    return;
  }
  $('mpName').textContent = mapTitle(s.name);
  $('mpPath').textContent = `levels/maps/${s.name}`;
  const row = (k, v, id = '') => `<dt>${esc(tr(k))}</dt><dd${id ? ` id="${id}"` : ''}>${v}</dd>`;
  $('mpStats').innerHTML = (s.size ? row('Size', `${Math.round(s.size[0])} × ${Math.round(s.size[1])} m`) : row('Terrain', tr('none'))) +
    row('Objects', s.placed.toLocaleString()) + row('Different models', s.models.toLocaleString()) +
    row('Drawn now', drawnText(), 'mpDrawn') +
    (s.grass ? row('Grass', tr('{n} ({k} kinds)', { n: s.grass.placed.toLocaleString(), k: s.grass.kinds })) + row('Grass drawn', grassText(), 'mpGrassDrawn') : '') +
    (s.decals ? row('Decals', s.decals.toLocaleString()) : '') +
    (s.lights && s.lights.lights + s.lights.flares + s.lights.beams ? row('Lights', [s.lights.lights ? tr('{n} lights', { n: s.lights.lights.toLocaleString() }) : '', s.lights.flares ? tr('{n} flares', { n: s.lights.flares.toLocaleString() }) : '', s.lights.beams ? tr('{n} beams', { n: s.lights.beams.toLocaleString() }) : ''].filter(Boolean).join(' · ')) : '') +
    (s.environment ? row('Sky', `<span title="${esc(s.environment)}">${esc(weatherLabel({ name: s.environment }, s.name))}</span>`) : '') +
    (s.water ? row('Water areas', s.water) : '') + row('Spawn points', s.spawns) +
    (s.soundscape || s.sounds ? row('Sounds', esc([s.soundscape ? s.soundscape.split('/').pop().replace(/_/g, ' ') : '', s.sounds ? tr('{n} placed', { n: s.sounds }) : ''].filter(Boolean).join(' · '))) : '') +
    (s.effects || s.weatherFx ? row('Effects', esc([s.effects ? tr('{n} placed', { n: s.effects.toLocaleString() }) : '', weatherName(s.weatherFx)].filter(Boolean).join(' · '))) : '') +
    (s.filteredOut ? row('Other modes, festivals', s.filteredOut.toLocaleString()) : '');
  const L = s.loading;
  const busy = L && !L.finished;
  $('mpLoad').hidden = !busy;
  if (busy) {
    const parts = [];
    if (L.done < L.models) parts.push(tr('models {done} / {all}', { done: L.done, all: L.models }));
    if (L.terrain) parts.push(tr('terrain'));
    else if (L.ground) parts.push(tr('ground colour'));
    if (L.sky) parts.push(tr('sky'));
    if (L.grass) parts.push(tr('grass'));
    if (L.decals) parts.push(tr('decals'));
    const parts5 = ['terrain', 'ground', 'sky', 'grass', 'decals'].filter((k) => !L[k]).length;
    $('mpLoad').querySelector('.progress div').style.width = `${Math.round((L.done + parts5) / (L.models + 5) * 100)}%`;
    $('mpLoad').querySelector('span').textContent = parts.length ? tr('Loading {what}…', { what: parts.join(tr(', ')) }) : tr('Loading…');
  }
  $('mpErrors').innerHTML = L?.errors?.length ? tr('{n} problem(s) while loading: {first}', { n: L.errors.length, first: esc(L.errors[0]) }) : '';
  const opt = (v, label, sel) => `<option value="${esc(v)}"${v === sel ? ' selected' : ''}>${esc(label)}</option>`;
  $('mpMode').innerHTML = (s.gameplays.length ? s.gameplays : [s.gameplay || '']).map((g) => opt(g, modeName(g), s.gameplay)).join('') + opt('', tr('All modes together'), s.gameplay);
  $('mpFestival').innerHTML = opt('Empty', festivalName('Empty'), s.festival) + s.festivals.filter((f) => f !== 'Empty').map((f) => opt(f, festivalName(f), s.festival)).join('');
  // the weather: every one the map has (the festival's and other modes' marked)
  const weathers = weatherChoices(s.environments, s.name);
  $('mpEnv').innerHTML = weathers.map((w) => `<option value="${esc(w.id)}"${w.id === s.environmentId ? ' selected' : ''} title="${esc(w.name)}">${esc(w.label)}</option>`).join('');
  $('mpEnv').closest('label').hidden = weathers.length < 2;
  $('mpMode').disabled = $('mpFestival').disabled = $('mpEnv').disabled = !!busy && L.done === 0;
  $('mpMode').parentElement.hidden = s.gameplays.length < 2; // (only choices that change what is shown)
  for (const el of [$('mxTerrain'), document.querySelector('#mapPanel [data-show="terrain"]')]) {
    el.disabled = !s.size; // (a map without terrain)
    el.closest('label').classList.toggle('dim', !s.size);
  }
  $('mxGround').disabled = !s.size || !$('mxTerrain').checked;
  $('mpFestival').parentElement.hidden = !s.festivals.some((f) => f !== 'Empty');
  $('mpDist').value = mapView.viewDistance;
  $('mpDistVal').textContent = `${mapView.viewDistance} m`;
  $('mpGrass').value = mapView.grassRange;
  $('mpGrassVal').textContent = `${mapView.grassRange} m`;
  $('mpGrass').closest('.ar').hidden = !s.grass;
  $('mpDetail').value = mapView.detail;
  $('mpTex').value = String(mapView.texMax);
  const un = s.unresolved;
  $('mpMissingCard').hidden = !un.length;
  $('mpMissingCount').textContent = un.length ? `${un.reduce((a, u) => a + u[1], 0).toLocaleString()} objects, ${un.length} kinds` : '';
  $('mpMissing').innerHTML = un.slice(0, 40).map(([d, c]) => `<div title="${esc(d)}"><span>${esc(d.replace(/^Breakable_/, '').replace(/_/g, ' '))}</span><b>${c}</b></div>`).join('') +
    (un.length > 40 ? `<div><span>… and ${un.length - 40} more</span></div>` : '');
}
// (rows of their own, each one line: the panel must not shift while flying)
const drawnText = () => `${mapView.drawn.placements.toLocaleString()} · ${tr('{n} M tris', { n: (mapView.drawn.triangles / 1e6).toFixed(1) })}`;
const grassText = () => (mapView.drawn.grass || 0).toLocaleString();

function renderMapSpeed() {
  if (!$('mapKeys').innerHTML) { $('mapKeys').innerHTML = keysHtml(MAP_CONTROLS); hydrateIcons($('mapKeys')); } // (a language switch empties it: driving too)
  const sp = drive.speedo;
  if (sp) { // (driving: a speedometer)
    const f = Math.min(1, sp.kmh / Math.max(1, sp.top));
    $('mapSpeed').innerHTML = `<div class="ms-bars">${SPEEDS.map((_, i) => `<i class="${i < Math.round(f * SPEEDS.length) ? 'on' : ''}" style="height:${6 + i * 2}px"></i>`).join('')}</div>` +
      `<b>${Math.round(sp.kmh)} <small>km/h${sp.reverse ? ' R' : ''}${sp.air ? tr(' · in the air') : ''}</small></b><span>${tr('top speed {v} km/h', { v: Math.round(sp.top) })}</span>` +
      (sp.pad ? `<span class="ms-keys"><i>${tr('left stick drives')}</i> · <i>${tr('right stick looks')}</i> · <i>${tr('A fires')}</i> · <i>${tr('B brakes')}</i> · <i>${tr('Y horn')}</i> · <i>${tr('Back stops')}</i></span>`
        : `<span class="ms-keys"><i><kbd>W A S D</kbd> ${tr('drive')}</i> · <i><kbd>Space</kbd> ${tr('brake')}</i> · <i><kbd>V</kbd> ${tr('fire')}</i> · <i><kbd>H</kbd> ${tr('horn')}</i> · ${sp.locked ? `<i>${tr('mouse aims')}</i> · <i>${tr('left button fires')}</i> · <i><kbd>Esc</kbd> ${tr('frees the mouse')}</i>` : `<i>${tr('drag to look')}</i> · <i>${tr('click to aim with the mouse')}</i> · <i><kbd>Esc</kbd> ${tr('fly')}</i>`}</span>`);
    return;
  }
  const l = mapView.fly.level, v = SPEEDS[l];
  $('mapSpeed').innerHTML = `<div class="ms-bars">${SPEEDS.map((_, i) => `<i class="${i <= l ? 'on' : ''}" style="height:${6 + i * 2}px"></i>`).join('')}</div>` +
    `<b>${v} <small>m/s</small></b><span>${Math.round(v * 3.6)} km/h · ${tr('speed {n} of {max}', { n: l + 1, max: SPEEDS.length })}</span>` +
    `<span class="ms-keys"><i><kbd>W A S D</kbd> ${tr('fly')}</i> · <i><kbd>Space</kbd> ${tr('up')}</i> · <i><kbd>Shift</kbd> ${tr('down')}</i> · <i><kbd>1–9</kbd> ${tr('speed')}</i> · <i>${tr('drag to look')}</i> · <i>${tr('click to select')}</i></span>`; // (small windows: instead of the key bar)
}

// the numbers that change while flying: a few times a second
let mapHudTime = 0;
viewer.frameHooks.push(() => {
  if (state.view !== 'map' || !mapView.scene) return;
  const now = performance.now();
  if (now - mapHudTime < 250) return;
  mapHudTime = now;
  const p = viewer.camera.position, g = mapView.heightAt(p.x, p.z);
  $('mapPos').textContent = `x ${p.x.toFixed(0)}  z ${(-p.z).toFixed(0)}  ${tr('height {h} m', { h: p.y.toFixed(0) })}${Number.isFinite(g) ? `\n${tr('{d} m above the ground', { d: (p.y - g).toFixed(1) })}` : ''}`;
  const d = $('mpDrawn'), gd = $('mpGrassDrawn');
  if (d) d.textContent = drawnText();
  if (gd) gd.textContent = grassText();
});

// (a weather picked stays through mode changes; another festival brings its own)
$('mpMode').addEventListener('change', () => state.map.name && openMap(state.map.name, { festival: $('mpFestival').value || 'Empty', gameplay: $('mpMode').value, environment: mapView.request?.environment || '', keepCamera: true }));
$('mpFestival').addEventListener('change', () => state.map.name && openMap(state.map.name, { festival: $('mpFestival').value || 'Empty', gameplay: $('mpMode').value, keepCamera: true }));
$('mpEnv').addEventListener('change', () => state.map.name && openMap(state.map.name, { festival: mapView.request?.festival || 'Empty', gameplay: mapView.request?.gameplay ?? 'auto', environment: $('mpEnv').value, keepCamera: true }));
$('mapPanel').addEventListener('change', (e) => {
  const k = e.target.dataset?.show;
  if (k) mapView.setShow(k, e.target.checked);
  if (k === 'sound') { state.settings.mapSound = e.target.checked; call('setSettings', { mapSound: e.target.checked }).catch(() => {}); } // (remembered)
  if (k === 'effects') { state.settings.mapEffects = e.target.checked; call('setSettings', { mapEffects: e.target.checked }).catch(() => {}); }
});
$('mpDist').addEventListener('input', () => { mapView.setViewDistance(+$('mpDist').value); $('mpDistVal').textContent = `${mapView.viewDistance} m`; });
$('mpGrass').addEventListener('input', () => { mapView.setGrassRange(+$('mpGrass').value); $('mpGrassVal').textContent = `${mapView.grassRange} m`; });
$('mpDetail').addEventListener('change', () => mapView.setDetail($('mpDetail').value));
$('mpTex').addEventListener('change', () => {
  mapView.texMax = +$('mpTex').value;
  if (state.map.name && mapView.scene) openMap(state.map.name, { ...mapView.request, keepCamera: true });
});
$('mapTools').addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) { drive.stop(); mapView.goTo(b.dataset.go); b.blur(); } });
// Test drive (the builder's toolbar): the vehicle onto the map last opened in Maps (else the
// bridge), at team 1's spawn facing team 2, once the map is in
$('bDrive').addEventListener('click', async () => {
  $('bDrive').blur();
  if (buildLoading('drive it')) return;
  if (!build.instances.length) { status('Build a vehicle first: a cabin and wheels, tracks, legs or hovers.', true); return; }
  const name = state.map.name || 'bridge';
  drive.stop();
  if (mapView.scene?.name === name) setView('map');
  else if (!(await openMap(name))) return;
  for (let i = 0; i < 150 && mapView.loading && !mapView.loading.finished; i++) await new Promise((r) => setTimeout(r, 100)); // (its objects in: they stop it)
  if (state.view !== 'map' || mapView.scene?.name !== name) return;
  const t1 = mapView.spawnsOf(1), t2 = mapView.spawnsOf(2), from = t1.length ? t1 : mapView.scene.spawns || [];
  let at = null, yaw = null;
  if (from.length) {
    at = MapView.centreOf(from);
    const look = t2.length ? MapView.centreOf(t2) : mapView.centre;
    yaw = Math.atan2(look.x - at.x, look.z - at.z);
  }
  if (buildLoading('drive it')) return; // (one may have begun while the map opened)
  const why = drive.start({ at, yaw });
  status(why || `Test drive on ${mapTitle(name)}: W A S D, Space to brake, click the view to aim with the mouse (V or the left button fires), H the horn · Esc to fly`, !!why);
});
// Drive: the builder's vehicle on this map (again: back to flying)
$('mDrive').addEventListener('click', () => {
  $('mDrive').blur();
  if (drive.active) { drive.stop(); return; }
  if (buildLoading('drive it')) return;
  const why = drive.start();
  if (why) status(why, true);
  else status('Driving: W A S D, Space to brake, drag to look around, V fires its guns · Esc to fly again');
});
$('mTextures').addEventListener('change', () => { viewer.setOption('textures', $('mTextures').checked); syncToggles(); });
$('mShadows').addEventListener('change', () => setShadows($('mShadows').checked));
$('mShot').addEventListener('click', () => screenshot(`${state.map.name || 'map'}_view`));
segPick('mxFmtSeg', 'mapFmt');
state.mapFmt = 'glb';
// (what each export option needs: grass grows on the terrain; decals are nothing but textures)
function syncMapExportOptions() {
  const terrain = $('mxTerrain').checked, textures = $('mxTextures').checked;
  $('mxGround').disabled = !terrain;
  $('mxMaxTex').disabled = !textures;
  $('mxDecals').disabled = !textures;
  $('mxGrass').disabled = !terrain;
  $('mxGrassAmt').disabled = !terrain || !$('mxGrass').checked;
  $('mxSkySize').disabled = !$('mxSky').checked;
}
for (const id of ['mxTerrain', 'mxTextures', 'mxGrass', 'mxSky']) $(id).addEventListener('change', syncMapExportOptions);
syncMapExportOptions();
$('mxExport').addEventListener('click', async () => {
  const s = mapView.scene;
  if (!s || state.mapExporting) return;
  state.mapExporting = true;
  try {
  await runExport('exportMap', {
    name: s.name, festival: mapView.request?.festival ?? s.festival, gameplay: mapView.request?.gameplay ?? s.gameplay, environment: mapView.request?.environment || '', format: state.mapFmt,
    terrain: $('mxTerrain').checked, ground: +$('mxGround').value, props: $('mxProps').checked, trees: $('mxTrees').checked,
    objects: $('mxObjects').checked, water: $('mxWater').checked, lod: +$('mxLod').value, textures: $('mxTextures').checked, maxTex: +$('mxMaxTex').value, ao: $('mxAo').checked,
    decals: $('mxDecals').checked, grass: $('mxGrass').checked, grassAmount: +$('mxGrassAmt').value,
    sun: $('mxSun').checked, sky: $('mxSky').checked, skySize: +$('mxSkySize').value,
    exclude: mapView.hiddenIds(), // (what was hidden in the view stays out)
  }, $('mxProgress'), $('mxResult'), $('mxExport'));
  } finally { state.mapExporting = false; renderMapPanel(); }
});

// ---- the selected map objects (click, Ctrl + click, Ctrl + drag in the view) ----
const GROUP_NAME = { props: 'Prop', trees: 'Tree / plant', objects: 'Object' };
const mapObjects = new Map(); // object id -> /mapobject (the open map's)
const capital = (t) => t.replace(/^./, (c) => c.toUpperCase());
let mapSelQueued = false, mapSelKinds = [];
function scheduleMapSelection() {
  if (mapSelQueued) return;
  mapSelQueued = true;
  requestAnimationFrame(() => { mapSelQueued = false; renderMapSelection(); });
}
// What the map says about one object (fetched once, then kept).
function mapObjectInfo(id) {
  if (!mapObjects.has(id)) {
    const p = fetch(`${DATA}/mapobject?${mapView.query}&id=${id}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    mapObjects.set(id, p);
    p.then((o) => { if (!o) mapObjects.delete(id); });
  }
  return mapObjects.get(id);
}
function renderMapSelection() {
  const sel = mapView.selected(), hidden = mapView.hidden.size;
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  $('mpHiddenRow').hidden = !hidden;
  $('mpHiddenText').textContent = `${plural(hidden, 'object')} hidden`;
  $('mxHiddenNote').hidden = !hidden;
  $('mxHiddenNote').textContent = hidden ? ` The ${plural(hidden, 'hidden object')} stay${hidden === 1 ? 's' : ''} out.` : '';
  $('mpSelCard').hidden = !sel.length;
  if (!sel.length) { $('msResult').innerHTML = ''; mapSelKinds = []; return; } // (it held the last selection's models: a closed map's too)
  const kinds = new Map(); // model -> its selected placements
  for (const p of sel) { if (!kinds.has(p.rec)) kinds.set(p.rec, []); kinds.get(p.rec).push(p.i); }
  const one = sel.length === 1, oneKind = kinds.size === 1, rec = sel[0].rec;
  const shown = (r) => r.n - (r.hide ? r.hide.reduce((a, h) => a + h, 0) : 0);
  $('mpSelTitle').textContent = oneKind ? capital(MapView.nameOf(rec)) + (one ? '' : ` × ${sel.length.toLocaleString()}`) : plural(sel.length, 'object');
  $('mpSelKind').textContent = oneKind ? [GROUP_NAME[rec.group] || 'Object', MapView.kindOf(rec)].filter(Boolean).join(' · ') : `${kinds.size} different models`;
  $('mpSelPath').hidden = !oneKind;
  $('mpSelPath').textContent = oneKind ? rec.path : '';
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  let rows = '';
  if (oneKind && rec.skin) rows += row('Skin', esc(rec.skin));
  if (oneKind) rows += row('On this map', shown(rec) < rec.n ? `${shown(rec).toLocaleString()} (+${(rec.n - shown(rec)).toLocaleString()} hidden)` : rec.n.toLocaleString());
  if (oneKind && !one) rows += row('Selected', `${sel.length.toLocaleString()} of ${shown(rec).toLocaleString()}`);
  $('mpSelStats').innerHTML = rows;
  if (one) { // what the map says about it (position, turn, scale; an entity's name and definition)
    const id = mapView.selectedIds()[0];
    if (id !== undefined) mapObjectInfo(id).then((x) => {
      if (!x || mapView.sel.size !== 1 || mapView.selectedIds()[0] !== id) return;
      const f = (v) => (Math.abs(v) < 0.05 ? '0' : v.toFixed(1));
      let extra = '';
      if (x.def) extra += row('Name', esc(x.name)) + row('Definition', esc(x.def));
      extra += row('Position', `x ${f(x.pos[0])} · z ${f(x.pos[2])}<br>height ${f(x.pos[1])} m`);
      const [yaw, pitch, roll] = x.ypr;
      extra += row('Turned', `${f(yaw)}°` + (Math.abs(pitch) >= 0.05 || Math.abs(roll) >= 0.05 ? `<br>pitch ${f(pitch)}° · roll ${f(roll)}°` : ''));
      const sc = x.scale;
      if (sc.some((v) => Math.abs(v - 1) > 0.005)) extra += row('Scale', sc.every((v) => Math.abs(v - sc[0]) < 0.005) ? `${sc[0].toFixed(2)}×` : sc.map((v) => v.toFixed(2)).join(' × '));
      extra += row('Object number', String(x.id));
      $('mpSelStats').innerHTML = rows + extra;
    });
  }
  // several models: one line each (a click keeps only that one)
  const list = [...kinds].sort((a, b) => b[1].length - a[1].length);
  mapSelKinds = list;
  $('mpSelKinds').innerHTML = oneKind ? '' : list.slice(0, 60).map(([r, is], k) => `<div data-k="${k}" title="Keep only these (${esc(r.path)})"><span>${esc(capital(MapView.nameOf(r)))}${MapView.kindOf(r) ? ` · ${esc(MapView.kindOf(r))}` : ''}</span><b>${is.length}</b></div>`).join('') +
    (list.length > 60 ? `<div><span>… and ${list.length - 60} more</span></div>` : '');
  $('mpSelOpen').disabled = !oneKind;
  const all = $('mpSelAll');
  all.hidden = !oneKind || sel.length >= shown(rec);
  all.textContent = `Select all ${shown(rec).toLocaleString()}`;
}
$('mpSelClose').addEventListener('click', () => mapView.selectOnly([]));
$('mpSelOpen').addEventListener('click', () => { const p = mapView.selected()[0]; if (p) openModel(p.rec.path, { skin: p.rec.skin }); });
$('mpSelFly').addEventListener('click', () => mapView.focusSelection());
$('mpSelAll').addEventListener('click', () => { const p = mapView.selected()[0]; if (p) mapView.selectKind(p.rec); });
$('mpSelHide').addEventListener('click', () => mapView.hideSelected());
$('mpShowHidden').addEventListener('click', () => mapView.showHidden());
$('mpSelPath').addEventListener('click', () => { navigator.clipboard?.writeText($('mpSelPath').textContent); status('Path copied'); });
$('mpSelKinds').addEventListener('click', (e) => {
  const k = e.target.closest('[data-k]')?.dataset.k;
  const kind = k !== undefined ? mapSelKinds[+k] : null;
  if (kind) mapView.selectOnly(kind[1].map((i) => ({ rec: kind[0], i })));
});
segPick('msFmtSeg', 'selFmt');
state.selFmt = 'glb';
$('msExport').addEventListener('click', () => {
  const s = mapView.scene, ids = mapView.selectedIds();
  if (!s || !ids.length) return;
  const recs = new Set(mapView.selected().map((p) => p.rec));
  const fileName = recs.size === 1 ? [...recs][0].path.split('/').pop().replace(/\.mdl$/i, '') + (ids.length > 1 ? `_x${ids.length}` : '') : `${s.name}_selection`;
  runExport('exportMapObjects', {
    name: s.name, festival: mapView.request?.festival ?? s.festival, gameplay: mapView.request?.gameplay ?? s.gameplay, environment: mapView.request?.environment || '', ids, format: state.selFmt, keepPosition: $('msKeepPos').checked,
    lod: 0, textures: true, maxTex: 2048, ao: $('mxAo').checked, fileName,
  }, $('msProgress'), $('msResult'), $('msExport'));
});
$('msResult').addEventListener('click', (e) => { const p = e.target.dataset.reveal; if (p) call('reveal', { path: p }); });

// ---- game folder ----
// Returns true when new game data is in use.
async function afterGameChange(g) {
  if (g.changed === false && g.ok) { // that folder failed; the game data already loaded stays in use
    status(g.error || 'That folder has no Crossout game data', true);
    return false;
  }
  showGame(g);
  infoCache.clear();
  assemblies.clear();
  mapView.unload(); // (its models came from the old game data)
  state.map.list = null;
  state.map.name = null;
  syncMapView();
  renderMapPanel();
  viewer.flushCaches(); // new game data: load fresh meshes and textures from now on
  build.wheelMarks.flush();
  build.updateWheelMarks();
  thumbs.clear();
  thumbGen++;
  if (g.ok) {
    resetIcons(document.body);
    loadSkin(state.gameVer);
    await loadFiles();
    if (state.info && state.view === 'part') openModel(state.info.path, { skin: state.skin, lod: state.lod, keepCamera: true });
    state.gameReady = true;
    if (state.restorePending || state.view === 'build') restoreAutosave();
    if (state.view === 'map') loadMapList();
  }
  return g.ok;
}
async function gameCommand(cmd, text) {
  const btns = [$('gameBtn'), $('reloadBtn'), $('gameDialogPick')];
  btns.forEach((b) => (b.disabled = true));
  let shown = false;
  try {
    // the dialog (pick) comes first; only show "busy" once indexing starts, i.e. after a short delay
    const t = setTimeout(() => { busy(true, text); shown = true; }, cmd === 'reload' ? 0 : 400);
    const g = await call(cmd, {}).finally(() => { clearTimeout(t); if (shown) busy(false); });
    if (g && (await afterGameChange(g)) && cmd === 'reload') status('Game archives re-read');
  } catch (e) {
    status(e.message, true);
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}
$('gameBtn').addEventListener('click', () => gameCommand('pickGameDir', 'Reading the game archives…'));
$('gameDialogPick').addEventListener('click', () => gameCommand('pickGameDir', 'Reading the game archives…'));
$('reloadBtn').addEventListener('click', () => gameCommand('reload', 'Re-reading the game archives…'));
$('zhNamesChk').addEventListener('change', async () => {
  const on = $('zhNamesChk').checked;
  await loadZhNames(); // (the file may have just been edited: read it again, then switch)
  await loadPaintZh();
  await loadMapZh();
  await loadModesZh();
  setZhNames(on);
});
$('langBtn').addEventListener('click', (e) => { e.stopPropagation(); showLangMenu($('langMenu').hidden); });
$('langMenu').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('button[data-lang]');
  if (!b) return;
  if (b.dataset.lang !== getLang()) setUiLang(b.dataset.lang);
  showLangMenu(false);
});
document.addEventListener('click', () => { if (!$('langMenu').hidden) showLangMenu(false); });
// (while it is open the keys are the menu's: the app's up / down would open another part behind it)
document.addEventListener('keydown', (e) => {
  const m = $('langMenu');
  if (m.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); showLangMenu(false); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    const items = [...m.querySelectorAll('button[data-lang], #zhNamesChk')].filter((x) => x.getClientRects().length);
    const at = items.indexOf(document.activeElement), last = items.length - 1;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? last : at < 0 ? (e.key === 'ArrowDown' ? 0 : last) : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[to]?.focus();
  } else if (e.key === 'Tab') showLangMenu(false);
  else if (m.contains(document.activeElement) && e.key !== 'Enter' && e.key !== ' ') e.stopPropagation(); // (letters: not the app's shortcuts)
}, true);
window.addEventListener('resize', () => { if (!$('langMenu').hidden) showLangMenu(false); });

// ---- keyboard ----
// The next openable row from row i in direction dir: { i, path } or null.
function nextRow(i, dir) {
  const rows = state.rows;
  for (let k = 0; k < rows.length; k++) {
    i = (i + dir + rows.length) % rows.length;
    const r = rows[i];
    const path = r.type === 'model' ? r.path : r.type === 'folder' && !r.open ? r.f.main : r.type === 'file' && r.name.endsWith('.mdl') ? r.name : null;
    if (path) return { i, path, folder: r.type === 'folder' };
  }
  return null;
}

let stepTimer = 0;
function stepModel(dir, { held = false } = {}) {
  const rows = state.rows;
  if (!rows.length) return;
  const cur = state.fileSel || state.selected;
  // (a collapsed folder stands for every model in it, as its highlight does)
  let at = rows.findIndex((r) => (r.type === 'model' ? r.path === cur : r.type === 'file' ? r.name === cur : r.type === 'folder' && !r.open && !!cur && (r.f.main === cur || dirOf(cur) === r.f.dir)));
  if (at < 0) at = dir > 0 ? -1 : rows.length; // nothing open yet: start at the first (or last) row
  const n = nextRow(at, dir);
  if (!n) return;
  { const wrap = $('listWrap'), b = rowBox(n.i); if (b.top < wrap.scrollTop || b.top + b.h > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = b.top - (wrap.clientHeight - b.h) / 2; }
  const open = () => openModel(n.path, { assembled: n.folder }).then(() => {
    const after = nextRow(n.i, dir);
    if (after && after.path !== n.path && state.selected === n.path) prefetch(after.path);
  });
  clearTimeout(stepTimer);
  if (!held) { open(); return; }
  state.selected = n.path; // (the highlight moves at once; the part it stops on opens)
  state.fileSel = null;
  renderList();
  stepTimer = setTimeout(open, 160);
}

// Keys go to text boxes and lists while they have the focus; a focused button or checkbox gives them
// up (Space would press it, and the builder's keys would do nothing after a click on the toolbar).
// A key's name for the shortcuts: the letter on the key, also with a non-Latin layout on (a Russian
// one gives 'к' for R; the camera keys already go by the key itself). Not with AltGr (Ctrl+Alt), and not for a
// Latin letter or a sign: a Polish ś (AltGr+S) saved, AZERTY's ',' (on M) turned Symmetry on.
const keyName = (e) => (e.key.length === 1 && !e.altKey && !e.getModifierState?.('AltGraph') && /\p{L}/u.test(e.key) && !/\p{Script=Latin}/u.test(e.key) && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : e.key).toLowerCase();
const typing = (el) => !!el && el.nodeType === 1 && (el.isContentEditable || el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=button]), select, textarea'));
function releaseFocus() {
  const el = document.activeElement;
  if (el && el !== document.body && !typing(el)) el.blur?.();
}

document.addEventListener('keyup', (e) => { garageCam.up(e); drive.key(e, false); mapView.fly.key(e, false); if (keyName(e) === 'v') gunfire.stop(); });
document.addEventListener('keydown', (e) => {
  // (Bug report, Donations, a crash's dialog: the app's keys wait; support.js closes them on Escape. A yes / no
  // question too: Space presses its button, Delete deleted the selected parts behind it)
  if (document.querySelector('.support-modal:not([hidden]), .xo-ask')) return;
  const k = keyName(e);
  if (e.ctrlKey && k === 'f') { e.preventDefault(); const s = state.view === 'map' ? $('mapSearch') : $('search'); s.focus(); s.select(); return; }
  if (state.view === 'build' && e.ctrlKey && k === 's') { e.preventDefault(); saveBuild({ as: e.shiftKey }); return; } // also from a text box
  if (state.view === 'build' && e.ctrlKey && k === 'o' && !e.shiftKey) { e.preventDefault(); $('bOpen').click(); return; }
  // A dropdown keeps the focus after a mouse pick; its type-to-select would change it (S picked
  // "Studio light", D a skin). It gives up the app's keys: letters, Space, Esc, Home, Delete.
  // (the builder's Ctrl+Z / Y / D / A too: right after a skin pick, Ctrl+Z did nothing)
  const fromSelect = e.target?.tagName === 'SELECT' && !e.altKey && !e.metaKey && (e.ctrlKey ? state.view === 'build' && ['z', 'y', 'd', 'a'].includes(k) :
    e.key.length === 1 || ['Escape', 'Home', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown'].includes(e.key) ||
      (state.view === 'map' && ['ArrowLeft', 'ArrowRight', 'Shift'].includes(e.key)));
  if (fromSelect) { e.preventDefault(); e.target.blur(); }
  else if (typing(e.target)) {
    if (k === 'escape' && e.target !== $('mNameEdit')) e.target.blur(); // Esc leaves a text box
    return;
  }
  if (e.repeat && ['x', 'm', 'g', 'delete', 'backspace', 'escape'].includes(k)) { e.preventDefault(); return; } // toggles and one-shots don't auto-repeat
  if ((state.view === 'build' || state.view === 'map') && k === 'v' && !e.ctrlKey && !e.altKey && !e.metaKey) { // hold V: fire (firing.js)
    e.preventDefault();
    if (!e.repeat && !gunfire.start() && state.view === 'build') status('Nothing to fire: put a weapon on the vehicle.');
    return;
  }
  if (state.view === 'map') {
    // the map's flying camera: W A S D, Space, Shift (held), 1 .. 9 for the speed
    if (drive.key(e, true)) { e.preventDefault(); releaseFocus(); return; }
    if (mapView.fly.key(e, true)) { e.preventDefault(); releaseFocus(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (k === 'home') { e.preventDefault(); mapView.goTo('start'); }
    // the selection: Esc lets go, F flies to it, H / Delete hides it
    if (k === 'escape' && mapView.sel.size) { e.preventDefault(); mapView.selectOnly([]); }
    if (k === 'f') { e.preventDefault(); if (!e.repeat) mapView.focusSelection(); }
    if ((k === 'h' || k === 'delete') && !e.repeat) { e.preventDefault(); mapView.hideSelected(); }
    return;
  }
  if (state.view === 'build') {
    // lining up a reference picture: arrows nudge, + / - zoom, Enter / Esc end it
    if (refs.key(e)) { e.preventDefault(); releaseFocus(); return; }
    // the garage camera: W A S D, Space, Shift (held)
    if (garageCam.enabled() && garageCam.down(e)) { e.preventDefault(); releaseFocus(); return; }
    if (e.ctrlKey && k === 'z') { e.preventDefault(); if (e.shiftKey) build.redo(); else build.undo(); return; }
    if (e.ctrlKey && k === 'y') { e.preventDefault(); build.redo(); return; }
    if (e.ctrlKey && k === 'd') { e.preventDefault(); build.duplicateSelected().catch((e) => status(e.message, true)); return; }
    if (e.ctrlKey && k === 'a') { e.preventDefault(); if (!build.placing) build.selectAll(); return; }
    // (the game's garage turns a part vertically with Ctrl+Q / E, horizontally with Shift+Q / E: below, as Q / E)
    if (e.ctrlKey && !e.altKey && (k === 'q' || k === 'e')) { e.preventDefault(); build.turn('tip', k === 'q' ? 1 : -1); releaseFocus(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (build.stickerTool && $('partsList').hidden && stickerKey(k)) { e.preventDefault(); releaseFocus(); return; }
    const dir = e.shiftKey ? -1 : 1;
    if (!$('partsList').hidden && k !== 'h' && k !== 'escape') return; // the list is in front of the vehicle
    switch (k) {
      case 'r': build.turn('spin', dir); break; // (as the user sees the part: build.js turnAxes)
      case 't': build.turn('tip', dir); break;
      case 'y': build.turn('roll', dir); break;
      case 'q': build.turn('spin', 1); break; // (left: anticlockwise as seen, as R)
      case 'e': build.turn('spin', -1); break;
      case 'x': if (e.shiftKey) build.mirrorToOtherSide().catch((e2) => status(e2.message, true)); else build.toggleMirror(); break;
      case 'm': $('bSym').checked = !$('bSym').checked; build.setSymmetry($('bSym').checked).then(renderBuildPanel).catch((e) => status(e.message, true)); break;
      case 'g': build.moveSelected().catch((e) => status(e.message, true)); break;
      case 'delete': case 'backspace': build.deleteSelected(); break;
      case 'escape':
        if (!$('texPreview').hidden) $('texPreview').hidden = true; // (a texture opened from the file list)
        else if (!$('partsList').hidden) setPartsList(false);
        else if (build.placing || build.busy) build.cancelPlacing(); // (also a part still being picked up)
        else if (state.paintMode === 'brush') { setPaintMode('all'); status('Brush put away'); }
        else build.select(null);
        renderList();
        break;
      case 'f': if (!e.repeat) setAR(!state.ar); break; // augmented reality, as in the garage
      case 'c': if (!e.repeat) setLift(!viewer.lifted); break;
      case 'h': if (!e.repeat) setPartsList($('partsList').hidden); break;
      case 'p': if (!e.repeat) { if (e.shiftKey) refs.next(); else refs.toggle(); } break; // reference pictures
      case 'home': build.frame({ animate: true }); break;
      default: return;
    }
    e.preventDefault();
    releaseFocus();
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  // (held keys do not repeat these: W flickered the wireframe on and off)
  if ((k === 'f' || k === 'home') && !e.repeat) { e.preventDefault(); viewer.frame(); } // Home frames too, as in the builder and Maps
  if (k === 'w' && !e.repeat) { $('optWire').checked = !$('optWire').checked; viewer.setOption('wireframe', $('optWire').checked); }
  if (k === 'escape') { $('texPreview').hidden = true; viewer.selectPartMaterial(null); }
  // up / down browse the parts, except on a slider that has the focus (they move it, as left / right do)
  if ((k === 'arrowdown' || k === 'arrowup') && e.target?.type !== 'range') { e.preventDefault(); stepModel(k === 'arrowdown' ? 1 : -1, { held: e.repeat }); }
});

// ---- start ----
(async function start() {
  setLang(pickLang(null)); // (the system's language for the first paint: the settings are read below)
  applyStatic(document.body);
  if (!webview) { status('Open this page through Grimcold.exe', true, true); return; }
  const gameBtns = [$('gameBtn'), $('reloadBtn'), $('gameDialogPick')];
  gameBtns.forEach((b) => (b.disabled = true)); // until the startup scan of the game folder is done
  try {
    busy(true, 'Reading the game archives…');
    const init = await call('init').finally(() => busy(false));
    gameBtns.forEach((b) => (b.disabled = false));
    state.settings = init.settings || {};
    // the interface's language: what was chosen before, else the system's (Chinese Windows -> 中文).
    // The chrome was already drawn in the system's language; this settles it once the settings are in.
    const bootLang = pickLang(state.settings.uiLang);
    if (bootLang !== getLang()) { setLang(bootLang); applyStatic(document.body); }
    syncLangBtn();
    await Promise.all([loadNames(), partStats.load()]);
    if (partStats.source) $('bStatsSource').textContent = `Part stats: ${partStats.source}.`;
    state.test = init.test;
    initSupport(init, { call, state, viewer, mapView }).catch((e) => console.warn('Bug report could not start:', e)); // (Donations, Bug report, a crash's report)
    setBackground(state.settings.background || 'crossout', false);
    if (state.settings.lighting === 'studio') setLighting('studio', false);
    setWelds(state.settings.welds !== false, false);
    setShadows(state.settings.shadows !== false, false);
    setArcs(state.settings.arcs !== false, false);
    setAR(state.settings.ar !== false, false);
    setLimits(state.settings.buildLimits !== false, false);
    setLookAtMe(state.settings.lookAtMe === true, false);
    viewer.sounds.setVolume(fxVolume()); // (the builder and Maps fire with it too)
    showVolume();
    showEvery(); // (the shot timer: the same for every gun)
    if (state.settings.mapSound === false) { document.querySelector('#mapPanel [data-show="sound"]').checked = false; mapView.setShow('sound', false); }
    if (state.settings.mapEffects === false) { document.querySelector('#mapPanel [data-show="effects"]').checked = false; mapView.setShow('effects', false); }
    setArcSize(typeof state.settings.arcSize === 'number' ? state.settings.arcSize : ARC_SIZE.def, false);
    setArcCones(state.settings.arcCones !== false, false);
    viewer.setOption('textures', state.settings.textures !== false);
    viewer.setOption('grid', state.settings.grid !== false);
    syncToggles();
    restorePrefs(state.settings.prefs);
    restoreFolds();
    watchPrefs();
    showGame(init.game);
    syncZhBtn(); // (the Chinese part names: names.zh.json, off unless turned on)
    if (init.game.ok) { hydrateIcons(document.body); loadSkin(state.gameVer); } // the game's own icons and UI kit (read from its archives)
    if (!viewer.support.s3tc) status('This GPU/driver has no BC texture support in WebView2; textures are decoded on the CPU instead.', false, true);
    if (init.game.ok) {
      await loadFiles();
      state.gameReady = true;
      renderMapGun(); // (the Fire card's guns: from the file list)
      if (state.restorePending) restoreAutosave(); // the builder was opened while the archives were read
      if (state.view === 'map') loadMapList();
      warmup.start(); // (maps' shaders, built while the app is idle: warmup.js)
    }
    window.__xoReady = true;
  } catch (e) {
    status(e.message, true, true);
  }
})();
