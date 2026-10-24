// End-to-end test of Maps mode with real mouse and keys: the Maps tab and the map list (pictures,
// search), opening a map (terrain with its ground colour and surface textures, every model, water,
// spawn points), the flying camera (W A S D along the view, Space / Shift up and down, 1-9 for the
// speed, the wheel, dragging to look, never into the ground, keys that don't leak to other modes),
// the spawn / overview buttons and the minimap, the show toggles, view distance and detail, another
// game mode keeping the camera, the weather (its sky, light and sounds; a night, an overcast; the
// grass comes again; its snow or ash around the camera, lamps brighter at night), the map's own
// effects (antennas' signals, the nearest playing, Show > Effects), driving the builder's vehicle on
// it (W A S D, the wheels rolling, turning, braking, its turret following the view, V firing it, its
// engine and wheels heard, the horn, breaking what breaks, Esc), leaving and coming back (the other modes get their own lighting
// back), selecting objects (hover, click, Ctrl + click, all of a kind, F, H, Ctrl + drag, Esc, their
// export, the map's export without the hidden ones), and exporting the map through the bridge (validated).
//   node tools/e2e_maps.mjs [--snap-dir <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const MAP = 'bridge';

const app = await launch({ prefix: 'xo-e2e-maps-' });
const { js, waitFor, click, mouse, drag, send, key, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
const center = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const clickOn = async (sel) => { const p = await center(sel); if (!p) throw new Error('no element ' + sel); await click(p.x, p.y); };
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const cam = () => js(`(() => { const c = window.__xo.viewer.camera; const f = { x: 0, y: 0, z: -1 }; const q = c.quaternion;
  // forward = q * (0, 0, -1), right = q * (1, 0, 0)
  const rot = (v) => { const x = v.x, y = v.y, z = v.z, qx = q.x, qy = q.y, qz = q.z, qw = q.w; const ix = qw * x + qy * z - qz * y, iy = qw * y + qz * x - qx * z, iz = qw * z + qx * y - qy * x, iw = -qx * x - qy * y - qz * z;
    return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx]; };
  const m = window.__xo.maps; return { p: c.position.toArray(), f: rot(f), r: rot({ x: 1, y: 0, z: 0 }), level: m.fly.level, ground: m.heightAt(c.position.x, c.position.z), fov: c.fov, far: c.far }; })()`);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);
const KEY = { w: ['w', 'KeyW', 87], a: ['a', 'KeyA', 65], s: ['s', 'KeyS', 83], d: ['d', 'KeyD', 68], space: [' ', 'Space', 32], shift: ['Shift', 'ShiftLeft', 16], home: ['Home', 'Home', 36], v: ['v', 'KeyV', 86], h: ['h', 'KeyH', 72], escape: ['Escape', 'Escape', 27] };
const keyOf = (k) => KEY[k] || (/^\d$/.test(k) ? [k, 'Digit' + k, 48 + +k] : /^num\d$/.test(k) ? [k.slice(3), 'Numpad' + k.slice(3), 96 + +k.slice(3)] : null);
async function hold(k, ms) {
  const [key, code, vk] = keyOf(k);
  const modifiers = k === 'shift' ? 8 : 0;
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
  await sleep(ms);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  await sleep(450); // (it glides to a stop)
}
const tap = (k) => hold(k, 30);
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; })()`);
const loaded = () => waitFor('window.__xo.maps.scene && window.__xo.maps.loading && window.__xo.maps.loading.finished && document.getElementById("busy").hidden', 240000);
const byGroup = () => js(`(() => { const o = {}; for (const r of window.__xo.maps.models) { if (!r.ready) continue; o[r.group] = (o[r.group] || 0) + r.lods.reduce((a, l) => a + l.count, 0); } return o; })()`);
const lodHist = () => js(`(() => { const h = []; for (const r of window.__xo.maps.models) r.lods.forEach((l, i) => (h[i] = (h[i] || 0) + l.count)); return h.map((v) => v || 0); })()`);
const pixels = () => js(`(() => { const c = document.getElementById('view'); const g = c.getContext('webgl2'); const w = g.drawingBufferWidth, h = g.drawingBufferHeight; const px = new Uint8Array(4 * 128); g.readPixels(w / 2 - 64, Math.round(h * 0.35), 128, 1, g.RGBA, g.UNSIGNED_BYTE, px); const seen = new Set(); let lit = 0; for (let i = 0; i < px.length; i += 4) { if (px[i + 3] > 0) lit++; seen.add((px[i] >> 3) + ',' + (px[i + 1] >> 3) + ',' + (px[i + 2] >> 3)); } return { lit, colours: seen.size }; })()`);

try {
  await waitFor('window.__xoReady === true', 120000);

  // ---- the Maps tab and the list ----
  await clickOn('#mainMode [data-view="map"]');
  await waitFor('window.__xo.state.view === "map"', 10000);
  await waitFor('Array.isArray(window.__xo.mapList()) && document.querySelectorAll("#mapList .map-row").length > 0', 60000);
  const list = await js(`({ rows: document.querySelectorAll('#mapList .map-row').length, maps: window.__xo.mapList().length, pics: document.querySelectorAll('#mapList .map-row img').length,
    left: ['modesBar', 'cats', 'searchRow', 'listWrap'].every((id) => document.getElementById(id).hidden), side: !document.getElementById('mapSide').hidden,
    empty: !document.getElementById('mapEmpty').hidden, panel: !document.getElementById('mapPanel').hidden, tools: document.getElementById('mapTools').hidden })`);
  ok(list.rows === list.maps && list.maps >= 50, `the Maps tab lists the game's maps (${list.maps})`);
  ok(list.left && list.side, 'the parts list makes way for the map list');
  ok(list.empty && list.panel && list.tools, 'nothing open yet: the "pick a map" card, no map toolbar');
  ok(list.pics >= list.maps * 0.6, `maps show their loading picture (${list.pics} of ${list.maps}, variants borrow their map's)`);
  await waitFor(`[...document.querySelectorAll('#mapList .map-row img')].some((i) => i.complete && i.naturalWidth > 0)`, 30000).then(() => ok(true, 'a map picture loads'), () => ok(false, 'a map picture loads'));
  await clickOn('#mapSearch');
  await send('Input.insertText', { text: 'brid' });
  await waitFor(`document.querySelectorAll('#mapList .map-row').length < 10`, 5000).catch(() => {});
  const found = await js(`[...document.querySelectorAll('#mapList .map-row')].map((r) => r.dataset.map)`);
  ok(found.includes(MAP) && found.length < 10, `searching "brid" finds ${found.join(', ')}`);
  await snap('01-maps-list');

  // ---- opening a map ----
  await js('performance.clearResourceTimings(), performance.setResourceTimingBufferSize(100000)'); // (every request it makes, counted below)
  const t0 = Date.now();
  await clickOn(`#mapList .map-row[data-map="${MAP}"]`);
  await loaded();
  const st = await js(`(() => { const m = window.__xo.maps, s = m.stats(); return { s: { ...s, unresolved: s.unresolved.length }, chunks: m.terrainGroup ? m.terrainGroup.children.length : 0, splat: !!m.splat, ground: !!m.groundTex,
    surfaces: m.splat ? m.splat.head.surfaces.length : 0, water: m.waterGroup.children.length, spawns: m.spawnGroup.children.length, ready: m.models.filter((r) => r.ready).length, scene: { water: m.scene.water.length, spawns: m.scene.spawns.length },
    hud: !document.getElementById('mapHud').hidden, tools: !document.getElementById('mapTools').hidden, empty: document.getElementById('mapEmpty').hidden, sel: document.querySelector('#mapList .map-row.sel')?.dataset.map,
    name: document.getElementById('mpName').textContent, speed: document.getElementById('mapSpeed').textContent, keys: document.querySelectorAll('#mapKeys .gk').length }; })()`);
  ok(st.s.models > 50 && st.ready === st.s.models && st.s.loading.failed === 0, `${MAP}: all ${st.s.models} models loaded (${st.s.placed} placements) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // each model asked for once, its description and geometry in one request (the host reads it once); a
  // model in two looks (skins): the second look's description alone, its geometry not again
  const asks = await js(`(() => { const by = {}; for (const e of performance.getEntriesByType('resource')) { const m = /xo\\.data\\/(model|geo|modelgeo)\\?path=([^&]+)(?:&skin=([^&]+))?/.exec(e.name); if (m) (by[decodeURIComponent(m[2])] ||= []).push({ kind: m[1], skin: decodeURIComponent(m[3] || '') }); }
    const recs = window.__xo.maps.models, paths = new Set(recs.map((r) => r.path));
    let looks = 0, lookOnce = 0, geoOnce = 0, combined = 0;
    for (const p of paths) {
      const asked = by[p] || [];
      for (const skin of new Set(recs.filter((r) => r.path === p).map((r) => r.skin || ''))) { looks++; if (asked.filter((a) => a.kind !== 'geo' && a.skin === skin).length === 1) lookOnce++; }
      if (asked.filter((a) => a.kind !== 'model').length === 1) geoOnce++;
      if (asked.some((a) => a.kind === 'modelgeo')) combined++;
    }
    return { paths: paths.size, looks, lookOnce, geoOnce, combined }; })()`);
  ok(asks.paths > 50 && asks.combined === asks.paths && asks.geoOnce === asks.paths && asks.lookOnce === asks.looks,
    `each model asked for once, its description and geometry together (${asks.combined} of its ${asks.paths} models through /modelgeo, each one's geometry once: ${asks.geoOnce}; ${asks.lookOnce} of ${asks.looks} looks described once)`);
  ok(st.chunks > 16 && st.ground && st.splat && st.surfaces > 1, `terrain: ${st.chunks} chunks, baked ground colour, ${st.surfaces} surface textures up close`);
  ok(st.water === st.scene.water && st.water > 0, `water: ${st.water} area(s)`);
  ok(st.spawns === st.scene.spawns && st.spawns > 0, `spawn points marked: ${st.spawns}`);
  ok(st.s.drawn.placements > 100 && st.s.drawn.triangles > 1e5, `drawn: ${st.s.drawn.placements} placements, ${(st.s.drawn.triangles / 1e6).toFixed(1)} M triangles`);
  ok(st.hud && st.tools && st.empty && st.sel === MAP && st.name === 'Bridge', 'the HUD, the toolbar and the panel show the open map; its row is selected');
  ok(/20 m\/s/.test(st.speed) && st.keys === 10, `speed box "${st.speed.slice(0, 32)}…", ${st.keys} key hints`);
  const px = await pixels();
  ok(px.lit === 128 && px.colours > 12, `the view is drawn (${px.colours} colours across a line of pixels)`);
  const c0 = await cam();
  ok(c0.fov === 60 && c0.p[1] > c0.ground + 1, `camera starts behind team 1, ${(c0.p[1] - c0.ground).toFixed(1)} m above the ground, 60° lens`);
  // the game's sky, grass and decals
  const world = await js(`(() => { const m = window.__xo.maps, s = m.stats(), v = window.__xo.viewer; return { sky: s.sky, env: s.environment, grass: s.grass, decals: s.decals,
    skyShown: !!m.sky && m.sky.group.visible, dome: v.skyDome.visible, clouds: !!m.sky?.clouds && m.sky.clouds.children.length, panel: document.getElementById('mapPanel').textContent }; })()`);
  ok(world.sky && world.skyShown && !world.dome && world.env, `the game's sky (${world.env}) instead of the plain one, ${world.clouds} cloud layer(s)`);
  ok(world.grass && world.grass.kinds >= 2 && world.grass.placed > 10000, `grass: ${world.grass?.placed} tufts of ${world.grass?.kinds} kinds`);
  ok(world.decals > 100, `decals: ${world.decals}`);
  ok(/Grass/.test(world.panel) && /Decals/.test(world.panel) && /Sky/.test(world.panel), 'the panel lists grass, decals and the sky');
  ok(errors.length === 0, `no page errors while loading (${errors.slice(0, 2).join(' | ')})`);
  await snap('02-map-open');

  // grass near the camera, how far it reaches, and the toggles for grass, decals and the sky
  const grassSpot = await js(`(() => { const m = window.__xo.maps, d = m.grass.data, i = Math.floor(d.length / 13 / 2) * 13; return [d[i + 9], d[i + 10], d[i + 11]]; })()`);
  await pose([grassSpot[0] + 6, grassSpot[1] + 3, grassSpot[2] + 6], grassSpot);
  await frames(4);
  const grassDrawn = async () => { await frames(3); return js('window.__xo.maps.stats().grass.drawn'); };
  const g150 = await grassDrawn();
  await js(`(() => { const r = document.getElementById('mpGrass'); r.value = 40; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const g40 = await grassDrawn();
  await js(`(() => { const r = document.getElementById('mpGrass'); r.value = 400; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const g400 = await grassDrawn();
  ok(g150 > 0 && g40 < g150 && g400 > g150 && (await js(`document.getElementById('mpGrassVal').textContent`)) === '400 m', `grass drawn near the camera: ${g40} up to 40 m, ${g150} up to 150 m, ${g400} up to 400 m`);
  await js(`(() => { const r = document.getElementById('mpGrass'); r.value = 150; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await clickOn('#mapPanel [data-show="grass"]');
  const gOff = await grassDrawn();
  await clickOn('#mapPanel [data-show="grass"]');
  ok(gOff === 0 && (await grassDrawn()) > 0, 'unticking Grass hides it, ticking it brings it back');
  await clickOn('#mapPanel [data-show="decals"]');
  await frames();
  const dOff = await js('window.__xo.maps.decals.group.visible');
  await clickOn('#mapPanel [data-show="decals"]');
  await frames();
  ok(!dOff && (await js('window.__xo.maps.decals.group.visible')), 'unticking Decals hides them, ticking them shows them');
  // a decal's share on an object goes with the object (hidden with H, or its kind switched off) and
  // comes back with it; each decal stays one mesh (one draw call) that leaves those triangles out
  // (a share whose object is the only one of its kind under the decal: switching the kind off takes just that share)
  const dShare = await js(`(() => { const m = window.__xo.maps, kindOf = (id) => m.models.find((r) => r.ids?.includes(id))?.group;
    let e = null, p = null;
    for (const x of m.decals.split) {
      const on = x.pieces.filter((q) => q.object >= 0);
      p = x.pieces.some((q) => q.object < 0) ? on.find((q) => on.filter((o) => kindOf(o.object) === kindOf(q.object)).length === 1) : null;
      if (p) { e = x; break; }
    }
    if (!e) return null;
    const kind = kindOf(p.object);
    const at = () => ({ drawn: e.mesh.geometry.drawRange.count, visible: e.mesh.visible });
    const before = at();
    m.restoreIds({ hidden: [p.object] });
    const hidden = at();
    m.showHidden();
    const back = at();
    m.setShow(kind, false);
    const kindOff = at();
    m.setShow(kind, true);
    return { meshes: m.decals.count, total: e.full.length, share: p.count, kind, before, hidden, back, kindOff, after: at() };
  })()`);
  ok(dShare && dShare.meshes < 300 && dShare.before.drawn === dShare.total && dShare.hidden.drawn === dShare.total - dShare.share && dShare.hidden.visible &&
    dShare.back.drawn === dShare.total && dShare.kindOff.drawn === dShare.total - dShare.share && dShare.after.drawn === dShare.total,
    `a decal's share on an object hides with it (${dShare?.share} of ${dShare?.total} indices; with its kind "${dShare?.kind}" off too) and comes back; ${dShare?.meshes} decal meshes`);
  // decals on the ground go with the terrain (they hung in the air)
  const dGround = await js(`(() => { const m = window.__xo.maps, groundOnly = m.decals.group.children.filter((x) => !x.userData.split);
    const e = m.decals.split.find((x) => x.pieces.some((p) => p.object < 0)), g = e ? e.pieces.filter((p) => p.object < 0).reduce((a, p) => a + p.count, 0) : 0;
    m.setShow('terrain', false);
    const off = { ground: groundOnly.filter((x) => x.visible).length, drawn: e?.mesh.geometry.drawRange.count };
    m.setShow('terrain', true);
    const on = { ground: groundOnly.filter((x) => x.visible).length, drawn: e?.mesh.geometry.drawRange.count };
    return { groundOnly: groundOnly.length, off, on, total: e?.full.length, g };
  })()`);
  ok(dGround.groundOnly > 0 && dGround.off.ground === 0 && dGround.on.ground === dGround.groundOnly && dGround.off.drawn === dGround.total - dGround.g && dGround.on.drawn === dGround.total,
    `with the terrain off its decals go too (${dGround.groundOnly} on the ground alone; one lying on both keeps its share on the object), and come back`);
  const lightNow = () => js(`(() => { const v = window.__xo.viewer, m = window.__xo.maps; return { dome: v.skyDome.visible, game: m.sky.group.visible, key: v.key.intensity, env: v.scene.environment === m.sky.envMap }; })()`);
  await clickOn('#mapPanel [data-show="sky"]');
  await frames();
  const skyOff = await lightNow();
  await clickOn('#mapPanel [data-show="sky"]');
  await frames();
  const skyOn = await lightNow();
  ok(skyOff.dome && !skyOff.game && !skyOff.env && skyOn.game && !skyOn.dome && skyOn.env && Math.abs(skyOn.key - skyOff.key) > 1e-3,
    `unticking Game sky goes back to the plain sky and light (sun ${skyOff.key.toFixed(2)}), ticking it brings the game's (sun ${skyOn.key.toFixed(2)}, lit by its sky)`);
  await tap('home');

  // ---- flying: real keys ----
  await pose([0, 60, 0], [0, 60, -100]); // level, looking along -z, high enough not to touch anything
  await frames();
  let a = await cam();
  await hold('w', 700);
  let b = await cam();
  let d = sub(b.p, a.p);
  ok(dot(d, a.f) > 0.95 * len(d) && len(d) > 5 && len(d) < 25, `W flies forward: ${len(d).toFixed(1)} m in 0.7 s at 20 m/s`);
  a = b; await hold('s', 600); b = await cam(); d = sub(b.p, a.p);
  ok(dot(d, a.f) < -0.95 * len(d) && len(d) > 3, `S flies back: ${len(d).toFixed(1)} m`);
  a = b; await hold('d', 600); b = await cam(); d = sub(b.p, a.p);
  ok(dot(d, a.r) > 0.95 * len(d) && len(d) > 3, `D goes right: ${len(d).toFixed(1)} m`);
  a = b; await hold('a', 600); b = await cam(); d = sub(b.p, a.p);
  ok(dot(d, a.r) < -0.95 * len(d) && len(d) > 3, `A goes left: ${len(d).toFixed(1)} m`);
  a = b; await hold('space', 600); b = await cam(); d = sub(b.p, a.p);
  ok(d[1] > 3 && Math.abs(d[0]) + Math.abs(d[2]) < 0.5, `Space goes straight up: +${d[1].toFixed(1)} m`);
  a = b; await hold('shift', 600); b = await cam(); d = sub(b.p, a.p);
  ok(d[1] < -3 && Math.abs(d[0]) + Math.abs(d[2]) < 0.5, `Shift goes straight down: ${d[1].toFixed(1)} m`);
  // W follows the view up and down too (a flying camera)
  await pose([0, 80, 0], [0, 30, -50]);
  await frames();
  a = await cam(); await hold('w', 500); b = await cam(); d = sub(b.p, a.p);
  ok(d[1] < -2 && dot(d, a.f) > 0.95 * len(d), `W dives where the camera looks (${d[1].toFixed(1)} m down)`);
  ok(!(await js('window.__xo.viewer.options.wireframe')) && (await js('window.__xo.state.view')) === 'map', "the keys stay the map's (W is not the 3D Viewer's wireframe key)");

  // ---- 1 .. 9: the speed ----
  await tap('1');
  ok((await cam()).level === 0 && /\b2 m\/s/.test(await js(`document.getElementById('mapSpeed').textContent`)), 'key 1: 2 m/s (the speed box says so)');
  await pose([0, 60, 0], [0, 60, -100]);
  a = await cam(); await hold('w', 500); b = await cam();
  const slow = len(sub(b.p, a.p));
  await tap('9');
  ok((await cam()).level === 8 && /400 m\/s/.test(await js(`document.getElementById('mapSpeed').textContent`)), 'key 9: 400 m/s');
  await pose([0, 60, 0], [0, 60, -100]);
  a = await cam(); await hold('w', 500); b = await cam();
  const fast = len(sub(b.p, a.p));
  ok(slow > 0.2 && slow < 2.5 && fast > 60 * slow, `same key press: ${slow.toFixed(2)} m at speed 1, ${fast.toFixed(0)} m at speed 9`);
  const levels = [];
  for (const k of ['2', '3', '5', '6', '7', '8', 'num4']) { await tap(k); levels.push((await cam()).level); }
  ok(levels.join() === '1,2,4,5,6,7,3', `keys 2 3 5 6 7 8 and the number pad's 4 pick speeds ${levels.map((l) => l + 1).join(' ')}`);
  const vc = await center('#view');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: -120 });
  await frames();
  const up1 = (await cam()).level;
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: 120 });
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vc.x, y: vc.y, deltaX: 0, deltaY: 120 });
  await frames();
  ok(up1 === 4 && (await cam()).level === 2, 'the mouse wheel steps the speed up and down');
  await tap('4');

  // ---- looking around: drag ----
  await pose([0, 60, 0], [0, 60, -100]);
  a = await cam();
  await drag(vc.x, vc.y, vc.x + 220, vc.y);
  b = await cam();
  const yaw = Math.acos(Math.max(-1, Math.min(1, dot(a.f, b.f))));
  ok(yaw > 0.4 && Math.abs(b.f[1]) < 0.02 && len(sub(b.p, a.p)) < 0.01, `dragging sideways turns the view ${(yaw * 180 / Math.PI).toFixed(0)}° (level, not moving)`);
  await drag(vc.x, vc.y, vc.x, vc.y + 150);
  b = await cam();
  ok(b.f[1] < -0.3, `dragging down looks down (pitch ${(Math.asin(b.f[1]) * 180 / Math.PI).toFixed(0)}°)`);
  await mouse('mousePressed', vc.x, vc.y, 'right');
  for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', vc.x - i * 25, vc.y, 'right', { held: true }); await sleep(16); }
  await mouse('mouseReleased', vc.x - 150, vc.y, 'right');
  const c2 = await cam();
  ok(Math.acos(Math.max(-1, Math.min(1, dot(c2.f, b.f)))) > 0.3, 'the right mouse button looks around too');

  // ---- never into the ground ----
  const gx = 60, gz = -40;
  await js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor, g = m.heightAt(${gx}, ${gz}); m.fly.setPose(new T(${gx}, g + 4, ${gz}), new T(${gx}, g + 4, ${gz} - 50)); })()`);
  await tap('7');
  await hold('shift', 900);
  b = await cam();
  ok(b.p[1] >= b.ground + 1.19 && b.p[1] < b.ground + 1.5, `Shift stops at the ground (${(b.p[1] - b.ground).toFixed(2)} m above it)`);
  await js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor, g = m.heightAt(${gx}, ${gz}); m.fly.setPose(new T(${gx}, g + 3, ${gz}), new T(${gx}, g - 40, ${gz} - 20)); })()`);
  await hold('w', 700);
  b = await cam();
  ok(b.p[1] >= b.ground + 1.19, 'flying into a slope slides along it');
  await tap('4');

  // ---- buttons, keys and the minimap ----
  await clickOn('#mapTools [data-go="overview"]');
  await frames();
  b = await cam();
  ok(b.p[1] > 200 && b.f[1] < -0.2, `Overview: high above the map (${b.p[1].toFixed(0)} m), looking down`);
  const t2 = await js(`(() => { const s = window.__xo.maps.spawnsOf(2); return s.reduce((a, x) => [a[0] + x.pos[0] / s.length, a[1] + x.pos[1] / s.length, a[2] + x.pos[2] / s.length], [0, 0, 0]); })()`);
  await clickOn('#mapTools [data-go="team2"]');
  await frames();
  b = await cam();
  ok(Math.hypot(b.p[0] - t2[0], b.p[2] - t2[2]) < 40, `Team 2: behind team 2's spawn (${Math.hypot(b.p[0] - t2[0], b.p[2] - t2[2]).toFixed(0)} m from it)`);
  // Space with the button still focused flies up instead of pressing it again
  await js(`document.querySelector('#mapTools [data-go="overview"]').focus()`);
  a = await cam(); await hold('space', 400); b = await cam();
  ok(b.p[1] > a.p[1] + 2 && Math.hypot(b.p[0] - a.p[0], b.p[2] - a.p[2]) < 0.5, 'Space on a focused toolbar button flies up (does not press it)');
  await tap('home');
  b = await cam();
  ok(Math.hypot(b.p[0] - c0.p[0], b.p[2] - c0.p[2]) < 1, 'Home: back to the start');
  const mm = await js(`(() => { const r = document.getElementById('miniMap').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; })()`);
  await click(mm.x + mm.w * 0.25, mm.y);
  b = await cam();
  const span = await js(`window.__xo.maps.scene.terrain.sizeX`);
  ok(Math.abs(b.p[0] - span * 0.25) < span * 0.03 && Math.abs(b.p[2]) < span * 0.03, `a click on the minimap flies there (${b.p[0].toFixed(0)}, ${b.p[2].toFixed(0)})`);
  const mini = await js(`(() => { const c = document.getElementById('miniMap'), g = c.getContext('2d'), d = g.getImageData(0, 0, c.width, c.height).data; const s = new Set(); for (let i = 0; i < d.length; i += 4 * 97) s.add(d[i] >> 4 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4) << 8); return s.size; })()`);
  ok(mini > 20, `the minimap shows the ground (${mini} colours)`);

  // ---- show toggles, view distance, detail ----
  await clickOn('#mapTools [data-go="overview"]');
  await frames();
  let g = await byGroup();
  ok(g.trees > 0 && g.props > 0, `from above: ${g.props} props, ${g.trees} trees, ${g.objects || 0} objects drawn`);
  await clickOn('#mapPanel [data-show="trees"]');
  await frames();
  g = await byGroup();
  ok(g.trees === 0 && g.props > 0, 'unticking Trees hides every tree, nothing else');
  await clickOn('#mapPanel [data-show="trees"]');
  await clickOn('#mapPanel [data-show="terrain"]');
  await frames();
  g = await byGroup();
  ok(g.trees > 0 && !(await js('window.__xo.maps.terrainGroup.visible')), 'trees back; unticking Terrain hides the ground');
  await clickOn('#mapPanel [data-show="terrain"]');
  ok(await js('window.__xo.maps.terrainGroup.visible'), 'and ticking it shows it again');
  await js(`(() => { const r = document.getElementById('mpDist'); r.value = 600; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await frames();
  b = await cam();
  const fog = await js(`(() => { const f = window.__xo.viewer.scene.fog; return f && [f.near, f.far]; })()`);
  ok(Math.abs(b.far - 630) < 1 && fog && Math.abs(fog[1] - 600) < 1 && (await js(`document.getElementById('mpDistVal').textContent`)) === '600 m', `view distance 600 m: haze up to 600 m, nothing drawn past ${b.far.toFixed(0)} m`);
  const near = (await lodHist()).reduce((x, y) => x + y, 0);
  await js(`(() => { const r = document.getElementById('mpDist'); r.value = 2000; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await frames();
  const farN = (await lodHist()).reduce((x, y) => x + y, 0);
  ok(farN > near, `a longer view distance draws more (${near} -> ${farN} placements)`);
  const setDetail = async (v) => { await js(`(() => { const s = document.getElementById('mpDetail'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await frames(); return lodHist(); };
  const low = await setDetail('low'), ultra = await setDetail('ultra');
  const fine = (h) => (h[0] || 0) + (h[1] || 0);
  ok(fine(ultra) > fine(low), `Detail Ultra keeps more of the finest LODs than Low (${fine(ultra)} vs ${fine(low)} placements at LOD 0-1)`);
  await setDetail('high');
  await snap('03-overview');

  // ---- another game mode / festival: the map comes again, the camera stays ----
  await tap('home');
  const before = await cam();
  const modes = await js(`[...document.getElementById('mpMode').options].map((o) => o.value)`);
  const other = modes.find((m) => m && m !== 'Assault') || '';
  await js(`(() => { const s = document.getElementById('mpMode'); s.value = ${JSON.stringify(other)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.gameplay === ${JSON.stringify(other)}`, 60000).catch(() => {});
  await loaded();
  const after = await cam();
  ok((await js('window.__xo.maps.scene.gameplay')) === other && len(sub(after.p, before.p)) < 0.01 && dot(after.f, before.f) > 0.9999, `game mode ${other}: loaded again, the camera stayed where it was`);
  // (back to the main mode: the festival's decorations are Assault's)
  await js(`(() => { const s = document.getElementById('mpMode'); s.value = 'Assault'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.gameplay === 'Assault'`, 60000).catch(() => {});
  await loaded();
  ok((await js('window.__xo.maps.scene.gameplay')) === 'Assault', 'and back to Assault');
  // an object's id is the same in every mode and festival (it was its place in that one's own list:
  // another mode or festival hid, selected and exported other objects)
  const stable = await js(`(async () => {
    const get = async (f) => (await (await fetch('https://xo.data/mapscene?name=${MAP}&gameplay=Assault&festival=' + f)).json());
    const a = await get('Empty'), b = await get('NewYear'); // (a festival adds its decorations in between the other entities)
    const at = (s) => { const m = new Map(); for (const r of s.models) r.ids.forEach((id, i) => m.set(id, r.path + '|' + r.m.slice(i * 12 + 9, i * 12 + 12).map((v) => v.toFixed(2)).join(','))); return m; };
    const A = at(a), B = at(b);
    let same = 0, diff = 0, ents = 0;
    for (const [id, v] of A) if (B.has(id)) { if (B.get(id) === v) { same++; if (id >= 2 ** 24) ents++; } else diff++; }
    return { same, diff, ents, a: A.size, b: B.size };
  })()`);
  ok(stable.same > 100 && stable.ents > 0 && stable.diff === 0 && stable.a !== stable.b,
    `object ids are the same without and with New Year's decorations (${stable.same} objects in both, ${stable.ents} of them from scene.mxml, none with another object's id; ${stable.a} vs ${stable.b} objects)`);
  // a reload that starts before the last one is in keeps what was hidden (it was lost)
  await loaded();
  const chainId = await js(`(() => { const m = window.__xo.maps, r = m.models.find((x) => x.ids?.length && x.ids[0] < 2 ** 24); m.restoreIds({ hidden: [r.ids[0]] }); return r.ids[0]; })()`);
  await js(`(() => { window.__xo.openMap(${JSON.stringify(MAP)}, { gameplay: 'Assault', keepCamera: true }); window.__xo.openMap(${JSON.stringify(MAP)}, { gameplay: 'Assault', keepCamera: true }); })()`);
  await waitFor(`!!window.__xo.maps.scene && !!window.__xo.maps.loading?.finished`, 60000).catch(() => {});
  await loaded();
  ok((await js(`window.__xo.maps.hiddenIds().includes(${chainId})`)), 'two reloads one after the other keep the hidden object hidden');
  // the ground is baked once per map and size (a mode or festival switch baked it again), and a map
  // the page has left gets no more work (its late requests pushed the new map out of the host's cache)
  const reqs = await js(`(async () => {
    const q = 'https://xo.data/mapground?name=${MAP}&festival=Empty&gameplay=Assault&size=768';
    const t0 = performance.now(); const r1 = await fetch(q); await r1.arrayBuffer();
    const t1 = performance.now(); const r2 = await fetch(q); await r2.arrayBuffer();
    const t2 = performance.now(); const left = await fetch('https://xo.data/mapdecals?name=arena_canyon&festival=Empty&gameplay=auto');
    return { first: t1 - t0, again: t2 - t1, ok: r1.ok && r2.ok, left: left.status };
  })()`);
  ok(reqs.ok && reqs.again < Math.max(30, reqs.first / 3) && reqs.left === 410,
    `the ground is baked once per map and size (${Math.round(reqs.first)} ms, then ${Math.round(reqs.again)} ms); a map the page left is refused (${reqs.left})`);
  await js(`window.__xo.maps.showHidden()`);
  const fests = await js(`[...document.getElementById('mpFestival').options].map((o) => o.value)`);
  ok(fests.includes('NewYear') && !(await js(`document.getElementById('mpFestival').parentElement.hidden`)), `festivals with their own decorations: ${fests.join(', ')}`);
  if (fests.includes('NewYear')) {
    const n0 = await js('window.__xo.maps.stats().placed');
    await js(`(() => { const s = document.getElementById('mpFestival'); s.value = 'NewYear'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.festival === 'NewYear'`, 60000).catch(() => {});
    await loaded();
    const n1 = await js('window.__xo.maps.stats().placed');
    ok((await js('window.__xo.maps.scene.festival')) === 'NewYear' && n1 > n0, `festival New Year: its decorations (${n0} -> ${n1} objects)`);
    await js(`(() => { const s = document.getElementById('mpFestival'); s.value = 'Empty'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.festival === 'Empty'`, 60000).catch(() => {});
    await loaded();
  }

  // ---- the weather: every environment the map has; another one brings its sky, its light (an
  // overcast has next to no sun, Halloween is a night) and its sounds, the camera and the grass stay;
  // another festival brings its own weather back ----
  const pickEnv = async (id) => {
    await js(`(() => { const s = document.getElementById('mpEnv'); s.value = ${JSON.stringify(id)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.environment === ${JSON.stringify(id)}`, 60000).catch(() => {});
    await loaded();
  };
  const wMenu = await js(`(() => { const s = document.getElementById('mpEnv'); return { opts: [...s.options].map((o) => [o.value, o.textContent, o.title]), sel: s.value, hidden: s.closest('label').hidden }; })()`);
  ok(wMenu.opts.length === 5 && !wMenu.hidden && wMenu.sel === '447082' && wMenu.opts.map((o) => o[1]).join('|') === 'Day|Xmass (New Year)|Halloween|Fog|Cloudy' && wMenu.opts[4][2] === 'cloudy',
    `Weather menu: ${wMenu.opts.map((o) => o[1]).join(' | ')} (the day's picked)`);
  const dayLight = await js(`(() => { const v = window.__xo.viewer; return { key: v.key.intensity }; })()`);
  const dayGlow = await js('window.__xo.viewer.glowAll.value'); // (the day's lamps: 2.41's day glows above 1)
  const dayHor = await js('(() => { const h = window.__xo.maps.sky.horizon; return h.r + h.g + h.b; })()');
  const camW = await cam();
  await pickEnv('829134');
  const w1 = await js(`(() => { const m = window.__xo.maps, s = m.stats(), v = window.__xo.viewer; return { req: m.request.environment, sel: document.getElementById('mpEnv').value, sky: s.sky, envName: s.environment, soundscape: m.scene.soundscape,
    skyRow: [...document.querySelectorAll('#mpStats dt')].find((d) => d.textContent === 'Sky')?.nextElementSibling.textContent, key: v.key.intensity, grass: !!m.grass, errors: m.loading.errors.slice() }; })()`);
  const camW1 = await cam();
  ok(w1.req === '829134' && w1.sel === '829134' && w1.sky && /cloudy$/.test(w1.envName) && w1.skyRow === 'Cloudy' && /bridge_cloudy$/.test(w1.soundscape) && len(sub(camW1.p, camW.p)) < 0.5,
    `weather "Cloudy": its sky (${w1.envName}) and sounds (${w1.soundscape.split('/').pop()}), the camera stays`);
  ok(w1.key < dayLight.key * 0.2 && w1.grass && !w1.errors.length,
    `the overcast has next to no sun (key light ${w1.key.toFixed(2)} against the day's ${dayLight.key.toFixed(2)}); the grass comes again, nothing failed (${w1.errors.join('; ')})`);
  await pickEnv('181044');
  const night = await js(`(async () => { const xo = window.__xo, m = xo.maps, h = m.sky.horizon;
    for (let i = 0; i < 30 && !xo.mapEffects.weather?.run; i++) await new Promise((r) => setTimeout(r, 100));
    return { hor: h.r + h.g + h.b, key: xo.viewer.key.intensity, req: m.request.festival, glow: xo.viewer.glowAll.value, levelGlow: m.sky.levels.glow, weather: xo.mapEffects.weather?.path || '', ash: !!xo.mapEffects.weather?.run,
      row: [...document.querySelectorAll('#mpStats dt')].find((d) => d.textContent === 'Effects')?.nextElementSibling.textContent }; })()`);
  ok(night.hor < dayHor * 0.6 && night.key < dayLight.key * 0.35 && night.req === 'Empty', `Halloween's weather without its festival: a night, a darker sky (${night.hor.toFixed(2)} against the day's ${dayHor.toFixed(2)}) and the moon's light (${night.key.toFixed(2)})`);
  ok(Math.abs(night.glow - night.levelGlow) < 1e-6 && Math.abs(night.glow - dayGlow) > 0.1 && /midland_leafs_yaw_0$/.test(night.weather) && night.ash && /· midland leafs yaw 0$/.test(night.row || ''),
    `at night its lamps glow as the weather says (x${night.glow.toFixed(1)}, the day's x${dayGlow.toFixed(1)}), and its leaves drift around the camera (${night.row})`);
  await js(`(() => { const s = document.getElementById('mpFestival'); s.value = 'NewYear'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.festival === 'NewYear'`, 60000).catch(() => {});
  await loaded();
  const ny = await js(`(async () => { const xo = window.__xo;
    for (let i = 0; i < 30 && !xo.mapEffects.weather?.run; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 600));
    const w = xo.mapEffects.weather, flakes = w?.run ? w.run.em.reduce((a, s) => a + s.parts.length, 0) : 0, cam = xo.viewer.camera.position;
    let near = 0; if (w?.run) for (const s of w.run.em) for (const p of s.parts) if (Math.hypot(p.pos[0] - cam.x, p.pos[1] - cam.y, p.pos[2] - cam.z) < 45) near++; // (snow_yaw_0: a box 25 m wide and high over the camera, its flakes falling on below it)
    return { env: xo.maps.scene.environment, req: xo.maps.request.environment, sel: document.getElementById('mpEnv').value, snow: w?.path || '', flakes, near }; })()`);
  ok(/snow_yaw_0$/.test(ny.snow) && ny.flakes > 100 && ny.near > ny.flakes * 0.75, `New Year's snow falls around the camera (${ny.flakes} flakes, ${ny.near} within 45 m)`);
  await js(`(() => { const s = document.getElementById('mpFestival'); s.value = 'Empty'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.festival === 'Empty'`, 60000).catch(() => {});
  await loaded();
  const back = await js(`({ env: window.__xo.maps.scene.environment, key: window.__xo.viewer.key.intensity, glow: window.__xo.viewer.glowAll.value })`);
  ok(ny.env === '216895' && ny.req === '' && ny.sel === '216895' && back.env === '447082' && Math.abs(back.key - dayLight.key) < 1e-3 && Math.abs(back.glow - dayGlow) < 1e-3,
    `another festival brings its own weather (New Year: ${ny.env}); back without one, the day's (${back.env}, the same light and lamps)`);
  // in the rain, drops on the lens (the game's raindrops_screen hung on the camera; a rainy weather
  // for a moment), gone again with it
  const lens = await js(`(async () => { const fx = window.__xo.mapEffects, was = fx.weatherAt, wait = (t) => new Promise((r) => setTimeout(r, t));
    fx.weatherAt = () => 'particles/levels/area/stalker_rain';
    for (let i = 0; i < 40 && !fx.lens?.run; i++) await wait(100);
    await wait(600);
    let drops = 0; for (const em of fx.lens?.run?.em || []) drops += em.parts.length;
    const cam = window.__xo.viewer.camera.position, run = fx.lens?.run; let near = 0;
    if (run) for (const em of run.em) for (const p of em.parts) if (Math.hypot(p.pos[0] - cam.x, p.pos[1] - cam.y, p.pos[2] - cam.z) < 6) near++;
    fx.weatherAt = was;
    for (let i = 0; i < 30 && fx.lens; i++) await wait(100);
    return { drops, near, gone: !fx.lens }; })()`);
  ok(lens.drops > 5 && lens.near === lens.drops && lens.gone, `in the rain, drops on the lens (${lens.drops} of the game's raindrops_screen, all within 6 m of the camera), gone with the rain`);

  // ---- the map's own effects: the nearest of those placed on it play where they stand (the bridge's
  // antennas' signals), looping, moved on 30 times a second; Show > Effects stops them (remembered) ----
  const efx = await js(`(async () => {
    const xo = window.__xo, m = xo.maps, fx = xo.mapEffects, T = m.v.camera.position.constructor;
    const e = m.scene.effects.find((x) => /signal_antenna$/.test(x.effect)), p = [e.m[9], e.m[10], e.m[11]];
    for (let i = 0; i < 40 && fx.spots.some((s) => s.reach === null); i++) await new Promise((r) => setTimeout(r, 100));
    m.fly.setPose(new T(p[0] + 12, p[1] + 4, p[2] + 12), new T(p[0], p[1], p[2]));
    const spot = fx.spots.find((s) => s.pos[0] === p[0] && s.pos[2] === p[2]);
    for (let i = 0; i < 40 && !spot?.run; i++) await new Promise((r) => setTimeout(r, 100));
    const runs = xo.viewer.fx.runs.filter((r) => r.run.ambient).length;
    m.fly.setPose(new T(p[0] + 1500, p[1] + 300, p[2] + 1500), new T(p[0], p[1], p[2]));
    for (let i = 0; i < 40 && spot?.run; i++) await new Promise((r) => setTimeout(r, 100));
    return { placed: m.scene.effects.length, kinds: [...new Set(m.scene.effects.map((x) => x.effect.split('/').pop()))], reach: spot?.reach, near: !!spot && runs > 0, far: !!spot?.run, calm: xo.viewer.fx.calm };
  })()`);
  ok(efx.placed === 14 && efx.near && !efx.far && efx.calm && efx.reach >= 70,
    `the bridge's ${efx.placed} effects (${efx.kinds.join(', ')}): flying up to an antenna its signal plays (seen ${Math.round(efx.reach)} m out), far away it stops; they alone move on 30 times a second`);
  await clickOn('#mapPanel [data-show="effects"]');
  await sleep(700);
  const fxOff = await js(`({ runs: window.__xo.viewer.fx.runs.filter((r) => r.run.ambient && !r.run.stopped).length, saved: window.__xo.state.settings.mapEffects, weather: !!window.__xo.mapEffects.weather })`);
  await clickOn('#mapPanel [data-show="effects"]');
  ok(fxOff.runs === 0 && fxOff.saved === false && !fxOff.weather, 'Show > Effects off stops the map\'s effects and its weather (remembered)');

  // ---- Drive: the Vehicle Builder's vehicle on the map, W A S D ----
  const press = (k) => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyOf(k)[0], code: keyOf(k)[1], windowsVirtualKeyCode: keyOf(k)[2] });
  const release = (k) => send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyOf(k)[0], code: keyOf(k)[1], windowsVirtualKeyCode: keyOf(k)[2] });
  const driveState = () => js(`(() => { const d = window.__xo.drive, s = d.state; return s ? { pos: s.pos.toArray(), yaw: s.yaw, kmh: s.v * 3.6, grounded: s.grounded, wheel: d.car.wheels[0]?.angle || 0 } : null; })()`);
  const noCar = await js(`(() => { document.getElementById('mDrive').click(); return { active: window.__xo.drive.active, status: document.getElementById('status').textContent }; })()`);
  ok(!noCar.active && /Vehicle Builder/.test(noCar.status), `Drive with nothing built says so (${noCar.status})`);
  const built = await js(`(async () => {
    const xo = window.__xo, b = xo.build;
    xo.setView('build');
    for (let i = 0; i < 100 && !xo.state.buildRestored; i++) await new Promise((r) => setTimeout(r, 50));
    const W = 'models/constructor/chassis/wheels/wheel_r17.mdl';
    const cab = await b.createInstance({ path: 'models/constructor/cabins/raider_cab1/raider_cab1.mdl', position: [0, 0, 0] });
    const probe = await b.createInstance({ path: W, position: [0, 0, 0] });
    const cb = cab.box.clone(), wb = probe.box.clone();
    b.removeInstance(probe);
    const wr = (wb.max.y - wb.min.y) / 2, ww = wb.max.x - wb.min.x, cx = (wb.min.x + wb.max.x) / 2;
    cab.group.position.y += wr * 1.2 - cb.min.y; cab.group.updateMatrixWorld(true); cab.box = cab.group.userData.box.clone().applyMatrix4(cab.group.matrixWorld);
    const zf = cb.max.z - (cb.max.z - cb.min.z) * 0.2, zb = cb.min.z + (cb.max.z - cb.min.z) * 0.2, ids = [];
    for (const [side, z] of [[1, zf], [-1, zf], [1, zb], [-1, zb]]) {
      const x = side > 0 ? cb.max.x + ww * 0.55 : cb.min.x - ww * 0.55;
      ids.push((await b.createInstance({ path: W, position: [x - cx * side, -wb.min.y, z], mirrored: side < 0 })).id);
    }
    b.setSteering(ids[0], true); b.setSteering(ids[1], true);
    await b.createInstance({ path: 'models/weapons/machinegun_kpvt/machinegun_kpvt.mdl', position: [0, cab.box.max.y, 0] });
    b.commit();
    xo.setView('map');
    await new Promise((r) => setTimeout(r, 800));
    // open, flat ground near team 1's spawn with a clear run ahead: the view looks down at it
    const m = xo.maps, T = m.v.camera.position.constructor;
    m.goTo('team1');
    await new Promise((r) => setTimeout(r, 300));
    const c0 = m.v.camera.position.clone();
    const clear = (x, z) => { const y = m.heightAt(x, z); if (!Number.isFinite(y)) return false; const h = m.segmentHit([x, y + 40, z], [x, y - 5, z]); return h && h.surface === 0 && Math.abs(h.point[1] - y) < 0.3; };
    for (let r = 20; r <= 300; r += 20) for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2, x = c0.x + Math.cos(ang) * r, z = c0.z + Math.sin(ang) * r, y = m.heightAt(x, z);
      if (![[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8]].every(([dx, dz]) => clear(x + dx, z + dz) && Math.abs(m.heightAt(x + dx, z + dz) - y) < 1.2)) continue;
      for (let k = 0; k < 8; k++) {
        const d = (k / 8) * Math.PI * 2, fx = Math.sin(d), fz = Math.cos(d);
        let run = true;
        for (let t = 10; t <= 60 && run; t += 10) if (!clear(x + fx * t, z + fz * t) || Math.abs(m.heightAt(x + fx * t, z + fz * t) - y) > 6) run = false;
        if (!run) continue;
        m.fly.setPose(new T(x - fx * 12, y + 7, z - fz * 12), new T(x, y, z));
        return { parts: b.instances.length, spot: [x, y, z] };
      }
    }
    return { parts: b.instances.length, spot: null };
  })()`);
  await frames();
  const go = await js(`(() => { document.getElementById('mDrive').click(); const d = window.__xo.drive; return { active: d.active, fly: window.__xo.maps.fly.enabled(), top: d.car ? d.car.top * 3.6 : 0, carLike: d.car?.carLike, guns: d.car?.guns.length, on: document.getElementById('mDrive').classList.contains('on') }; })()`);
  ok(built.spot && go.active && !go.fly && go.on && go.carLike && go.guns === 1 && Math.round(go.top) === 106,
    `Drive takes the builder's ${built.parts} parts onto the map (an Aggressor on four wheels, the front two ST: ${Math.round(go.top)} km/h top speed); the keys are its, not the flying camera's`);
  await sleep(1200);
  for (let i = 0; i < 28 && !(await driveState())?.grounded; i++) await sleep(100); // (standing, off its springs' bounce)
  const d0 = await driveState();
  await press('w'); await sleep(2500);
  const d1 = await driveState();
  await press('a'); await sleep(1000); await release('a');
  const d2 = await driveState();
  await release('w');
  const panel = await js(`document.getElementById('mapSpeed').textContent`);
  await press('space'); await sleep(900); await release('space');
  const d3 = await driveState();
  ok(d0.grounded && d1.kmh > 25 && Math.hypot(d1.pos[0] - d0.pos[0], d1.pos[2] - d0.pos[2]) > 10 && Math.abs(d1.wheel) > 0 && /km\/h/.test(panel),
    `W: it pulls away (${d1.kmh.toFixed(0)} km/h after 2.5 s, ${Math.hypot(d1.pos[0] - d0.pos[0], d1.pos[2] - d0.pos[2]).toFixed(0)} m on; it stood: ${d0.grounded}), its wheels rolling (${d1.wheel.toFixed(2)}), the speedometer up (${panel.slice(0, 24)})`);
  ok(d2.yaw - d1.yaw > 0.15 && d3.kmh < d2.kmh - 15, `A turns it left (${((d2.yaw - d1.yaw) * 180 / Math.PI).toFixed(0)}°), Space brakes it (${d2.kmh.toFixed(0)} -> ${d3.kmh.toFixed(0)} km/h)`);
  await press('v'); await sleep(700);
  const vfire = await js(`({ guns: window.__xo.gunfire.guns.length, on: window.__xo.gunfire.on, runs: window.__xo.viewer.fx.runs.filter((r) => !r.run.ambient).length, cross: !document.querySelector('.fire-cross').hidden })`);
  await release('v');
  ok(vfire.on && vfire.guns === 1 && vfire.runs > 0 && vfire.cross, `V fires the vehicle's gun (${vfire.runs} effects), the crosshair up while it drives`);
  // its turret turns to where the middle of the view looks; its engine and wheels are heard; H: the horn
  const tur0 = await js(`(async () => { const d = window.__xo.drive; for (let i = 0; i < 40 && !d.car.guns[0].anim; i++) await new Promise((r) => setTimeout(r, 100)); const g = d.car.guns[0]; return g.anim ? g.anim.pose.AimYaw : null; })()`);
  await js(`(() => { const L = window.__xo.drive.look; L.heading += 1.0; L.lastDrag = performance.now(); })()`);
  await sleep(1200);
  const tur1 = await js(`(() => { const d = window.__xo.drive, g = d.car.guns[0], sv = window.__xo.viewer.sounds; return { yaw: g.anim?.pose.AimYaw, firing: g.group === g.copy, engine: d.sound.engine.length, set: d.sound.engineSet, ctx: sv.ctx?.state }; })()`);
  await js(`(() => { const L = window.__xo.drive.look; L.heading -= 1.0; })()`);
  ok(tur0 !== null && Math.abs(tur1.yaw - tur0) > 40 && tur1.firing, `its turret turns with the view (AimYaw ${tur0?.toFixed(0)} -> ${tur1.yaw?.toFixed(0)} for a 57° turn), and fires from there`);
  ok(tur1.ctx !== 'running' || (tur1.engine >= 2 && tur1.set === 'viper'), `its engine is heard: the light cabins' set (${tur1.set}, ${tur1.engine} loops from idle to top)`);
  await press('h'); await sleep(500);
  const honk = await js(`!!window.__xo.drive.sound?.horn?.v`);
  await release('h');
  ok(tur1.ctx !== 'running' || honk, 'H: its horn');
  // its wheels on their own animation: only the wheel turns (not its arms), the ST ones steer, each
  // on its spring (a third of the way out on the ground, hanging all the way in the air)
  const wheelState = () => js(`(() => { const d = window.__xo.drive; return d.car.wheels.map((w) => {
    if (!w.anim) return { anim: false };
    const sk = w.anim.skel, wi = sk.bones.findIndex((b) => b.name === w.roll.wheel);
    let arm = 0; sk.bones.forEach((b, i) => { if (i === wi) return; for (let p = b.parent; p; p = p.parent) if (p === sk.bones[wi]) return; const q = b.quaternion.clone().multiply(sk.rest[i].q.clone().invert()); arm = Math.max(arm, 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI); });
    return { anim: true, still: w.still.visible, st: w.st, roll: w.roll.value, steer: w.rig.steer ? w.anim.pose.WheelSteer : null, ext: w.ext, hi: w.rig.spring?.hi, arm }; }); })()`);
  // (set down standing on the flat ground found for it: after the brakes it may still be rolling into something)
  await js(`(() => { const d = window.__xo.drive, s = d.state, p = ${JSON.stringify(built.spot)}; s.pos.set(p[0], p[1] + 0.3, p[2]); s.v = 0; s.vy = 0; s.grounded = false; })()`);
  await sleep(1500);
  const wh0 = await wheelState();
  await press('w'); await press('a'); await sleep(900);
  const wh1 = await wheelState();
  await release('a'); await release('w');
  await js(`(() => { const s = window.__xo.drive.state; s.pos.y += 5; s.grounded = false; s.vy = 0; })()`);
  await sleep(450);
  const wh2 = await wheelState();
  await sleep(2000);
  ok(wh0.length === 4 && wh0.every((w) => w.anim && !w.still && w.ext > 0.05 && w.ext < 0.25) && wh1.every((w, k) => w.roll !== wh0[k].roll && w.arm < 30)
    && wh1.filter((w) => w.st).every((w) => Math.abs(w.steer) > 10) && wh1.filter((w) => !w.st).every((w) => w.steer === 0) && wh2.every((w) => w.ext > 0.95 * w.hi),
    `its wheels roll on their own animation (their arms still: at most ${Math.max(...wh1.map((w) => w.arm)).toFixed(0)}°, the steering knuckles), the front ones steer, each on its spring (${wh0.map((w) => w.ext.toFixed(2)).join(', ')} of ${wh0[0].hi}; in the air all the way out)`);
  // into the river from its shore: a splash, the wheels' water, slower the deeper
  const river = await js(`(() => {
    const m = window.__xo.maps, w = m.scene.water[0]; if (!w) return null;
    const o = w.outline; let best = null, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i + 1 < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    for (let x = x0; x <= x1; x += 3) for (let z = z0; z <= z1; z += 3) { const lvl = m.waterAt(x, z), bed = m.heightAt(x, z); if (lvl === null || !Number.isFinite(bed)) continue; const dep = lvl - bed; if (dep > 0.6 && dep < 1.2 && (!best || dep > best.dep)) best = { x, z, dep, lvl }; }
    if (!best) return null;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2, dx = Math.sin(ang), dz = Math.cos(ang);
      let r = 0; for (; r < 80; r += 1) { const lv = m.waterAt(best.x + dx * r, best.z + dz * r), bd = m.heightAt(best.x + dx * r, best.z + dz * r); if (lv === null || lv - bd < 0.02) break; }
      if (r >= 80) continue;
      const sx = best.x + dx * (r + 14), sz = best.z + dz * (r + 14), sy = m.heightAt(sx, sz);
      if (!Number.isFinite(sy) || Math.abs(sy - best.lvl) > 4) continue;
      let clear = true; for (let t = 0; t <= r + 14 && clear; t += 2) { const px = best.x + dx * t, pz = best.z + dz * t, h = m.segmentHit([px, sy + 25, pz], [px, sy - 15, pz], { water: false }); if (h && h.surface !== 0) clear = false; }
      if (clear) return { ...best, start: [sx, sy, sz], yaw: Math.atan2(-dx, -dz) };
    }
    return null;
  })()`);
  let wade = null;
  if (river) {
    await js(`(() => { const d = window.__xo.drive, s = d.state; s.pos.set(${river.start[0]}, ${river.start[1]} + 0.5, ${river.start[2]}); s.yaw = ${river.yaw}; s.v = 0; s.vy = 0; s.grounded = false; d.look.heading = s.yaw; d.splashes = 0; })()`);
    await sleep(800);
    await press('w');
    for (let k = 0; k < 50 && !wade?.deep; k++) {
      await sleep(150);
      const st = await js(`(() => { const d = window.__xo.drive, s = d.state; return { surface: s.surface, depth: s.depth || 0, kmh: s.v * 3.6, top: d.car.top * 3.6, splashes: d.splashes || 0, spray: d.dust.filter((x) => /wheel_water/.test(x.path || '')).length }; })()`);
      if (st.surface === 'water') { wade ||= { first: st }; if (st.depth > 0.6) wade.deep = st; }
    }
    if (wade?.deep) { await sleep(1500); wade.after = await js(`(() => { const d = window.__xo.drive, s = d.state; return { depth: s.depth, kmh: s.v * 3.6, top: d.car.top * 3.6, roll: d.sound?.roll?.key || '', surface: s.surface }; })()`); }
    await release('w');
  }
  // its exhausts smoke (the cabin's fx nodes: the raider cab's four), and its headlights light at
  // night only (the light level made a night's for a moment)
  const lights = await js(`(async () => { const d = window.__xo.drive, sky = window.__xo.maps.sky, was = sky.level, wait = (t) => new Promise((r) => setTimeout(r, t));
    const day = d.beams.map((l) => l.intensity); sky.level = 0.2; await wait(300); const night = d.beams.map((l) => l.intensity); sky.level = was; await wait(300);
    return { day, night, after: d.beams.map((l) => l.intensity), lamps: d.car.lamps.length, smoke: d.smoke.filter((r) => r.fx).length, exhausts: d.car.exhausts.length }; })()`);
  ok(lights.exhausts === 4 && lights.smoke === 4 && lights.day.every((x) => x === 0) && lights.after.every((x) => x === 0) && lights.lamps === 2 && lights.night.every((x) => x > 0),
    `its exhausts smoke (${lights.smoke} of the cabin's ${lights.exhausts}); its headlights are dark by day and shine at night (${lights.night.map((x) => x.toFixed(0)).join(', ')})`);
  ok(river && wade?.first.splashes >= 1 && wade.first.spray >= 2 && wade.after?.surface === 'water' && wade.after.kmh < wade.after.top * Math.max(0.2, 1 - wade.after.depth / 1.2) + 12,
    `into the river: a splash going in, the wheels' water spray, and wading ${wade?.after?.depth.toFixed(1)} m deep at ${wade?.after?.kmh.toFixed(0)} km/h (of ${wade?.after?.top.toFixed(0)})`);
  // what breaks in the game breaks: driven into, gone (with its effect and sound) until the drive ends
  const brk = await js(`(async () => {
    const xo = window.__xo, m = xo.maps, d = xo.drive, s = d.state;
    const recs = m.models.filter((r) => r.ready && r.centers && (/^Breakable_/.test(r.def || '') || /_de(?:_|\\d|\\.mdl$)/i.test(r.path)));
    for (const r of recs) for (let i = 0; i < r.n; i++) {
      const x = r.centers[i * 3], z = r.centers[i * 3 + 2], y = m.heightAt(x, z);
      if (!Number.isFinite(y) || r.radii[i] > 4) continue;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2, sx = x - Math.sin(a) * 20, sz = z - Math.cos(a) * 20, sy = m.heightAt(sx, sz);
        if (!Number.isFinite(sy) || Math.abs(sy - y) > 2) continue;
        let clear = true;
        for (let t = 4; t <= 16 && clear; t += 2) { const px = sx + Math.sin(a) * t, pz = sz + Math.cos(a) * t, h = m.segmentHit([px, sy + 30, pz], [px, sy - 5, pz]); if (!h || h.surface !== 0 || Math.abs(m.heightAt(px, pz) - sy) > 1.5) clear = false; }
        if (!clear) continue;
        s.pos.set(sx, sy + 0.3, sz); s.yaw = a; s.v = 0; s.grounded = false; d.look.heading = a;
        return { name: r.path.split('/').pop(), id: m.idOf(r, i) };
      }
    }
    return null;
  })()`);
  let broke = false;
  if (brk) {
    await press('w');
    for (let t = 0; t < 40 && !broke; t++) { await sleep(150); broke = await js(`!!window.__xo.maps.broken?.has(${JSON.stringify(brk.id)})`); }
    await release('w');
  }
  ok(brk && broke, `driven into a ${brk?.name || '(none found)'}, it breaks`);
  await press('escape'); await release('escape');
  await sleep(300);
  const afterDrive = await js(`({ active: window.__xo.drive.active, fly: window.__xo.maps.fly.enabled(), car: !!window.__xo.viewer.mapRoot.getObjectByName('driven vehicle'), broken: window.__xo.maps.broken?.size || 0, cross: !document.querySelector('.fire-cross').hidden,
    loops: window.__xo.viewer.sounds.voices.filter((v) => v.loop && !v.ended && /^(viper|wheels|treads)/.test(v.name)).length })`);
  ok(!afterDrive.active && afterDrive.fly && !afterDrive.car && afterDrive.broken === 0 && !afterDrive.cross && afterDrive.loops === 0,
    'Esc: back to flying, the vehicle, its sounds and the crosshair gone, what it broke standing again');
  // rounds break what breaks: a bullet in three hits, a rocket at once, and its blast what stands round it
  const sb = await js(`(() => {
    const xo = window.__xo, m = xo.maps, v = xo.viewer;
    const recs = m.models.filter((r) => r.ready && r.centers && (/^Breakable_/.test(r.def || '') || /_de(?:_|\d|\.mdl$)/i.test(r.path)));
    const pick = []; for (const r of recs) for (let i = 0; i < r.n && pick.length < 2; i++) if (!r.hide?.[i]) pick.push({ r, i });
    const hitOf = ({ r, i }) => ({ point: [r.centers[i * 3], r.centers[i * 3 + 1], r.centers[i * 3 + 2]], normal: [0, 1, 0], surface: 3, rec: r, index: i });
    const gone = ({ r, i }) => !!r.hide?.[i], a = pick[0], b = pick[1], seen = [];
    for (let k = 0; k < 3; k++) { v.onHit(hitOf(a), { hit: 'small' }); seen.push(gone(a)); }
    const n = v.onHit(hitOf(b), { hit: 'rocket' });
    const out = { seen, rocket: gone(b), n, broken: m.broken.size, hidden: m.hiddenIds().length };
    m.mendBroken();
    out.mended = !gone(a) && !gone(b);
    return out;
  })()`);
  ok(sb.seen.join() === 'false,false,true' && sb.rocket && sb.n >= 1 && sb.broken >= 2 && sb.hidden === 0 && sb.mended,
    `a round breaks what breaks: bullets in three hits, a rocket at once (its blast too: ${sb.n} broken), not hidden for the export, and it stands again`);
  // Test drive (the builder's button): onto the map, at team 1's spawn facing team 2
  await js(`window.__xo.setView('build')`);
  await sleep(500);
  await clickOn('#bDrive');
  await waitFor('window.__xo.drive.active', 60000).catch(() => {});
  const td = await js(`(() => { const xo = window.__xo, m = xo.maps, d = xo.drive, s = d.state; if (!s) return null; const t1 = m.spawnsOf(1), t2 = m.spawnsOf(2);
    const c = (l) => l.reduce((a, p) => [a[0] + p.pos[0] / l.length, a[1] + p.pos[2] / l.length], [0, 0]), c1 = c(t1), c2 = c(t2), want = Math.atan2(c2[0] - c1[0], c2[1] - c1[1]);
    return { view: xo.state.view, off: Math.hypot(s.pos.x - c1[0], s.pos.z - c1[1]), yawErr: Math.abs(Math.atan2(Math.sin(s.yaw - want), Math.cos(s.yaw - want))) }; })()`);
  ok(td && td.view === 'map' && td.off < 1 && td.yawErr < 0.05, "Test drive in the builder: the vehicle onto the map at team 1's spawn, facing team 2");
  // the mouse caught (a click on the view; simulated here: a hidden window cannot take the pointer): it aims, its left button fires
  const ml = await js(`(() => { const d = window.__xo.drive, g = window.__xo.gunfire; d.locked = true; const h0 = d.look.heading;
    d.lookBy(200, 0, 0.0022, 0.0017); const turned = h0 - d.look.heading;
    d.pointerDown({ button: 0, pointerId: 1 }); const fired = g.on; d.pointerUp({ button: 0, pointerId: 1 }); const stopped = !g.on; d.locked = false;
    return { turned, fired, stopped }; })()`);
  ok(Math.abs(ml.turned - 0.44) < 0.01 && ml.fired && ml.stopped, 'with the mouse caught, moving it aims and its left button fires');
  // a gamepad drives it too (a pretend one: navigator.getGamepads stood in for): the left stick drives
  // and steers, A fires, Back ends the drive
  await js(`(() => { const btn = () => ({ pressed: false, value: 0 }); window.__pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn) }; window.__realPads = navigator.getGamepads; navigator.getGamepads = () => [window.__pad]; })()`);
  await sleep(300);
  const padState = () => js(`(() => { const d = window.__xo.drive, s = d.state; return d.car ? { kmh: s.v * 3.6, yaw: s.yaw, pad: !!d.pad, fire: window.__xo.gunfire.on, hint: /left stick drives/.test(document.getElementById('mapSpeed').textContent) } : null; })()`);
  const pd0 = await padState();
  await js(`window.__pad.axes[1] = -1`); await sleep(1500);
  const pd1 = await padState();
  await js(`window.__pad.axes[0] = -1`); await sleep(800);
  const pd2 = await padState();
  await js(`window.__pad.axes[0] = 0; window.__pad.axes[1] = 0; window.__pad.buttons[0] = { pressed: true, value: 1 }`); await sleep(400);
  const pd3 = await padState();
  await js(`window.__pad.buttons[0] = { pressed: false, value: 0 }`); await sleep(300);
  const pd4 = await padState();
  await js(`window.__pad.buttons[8] = { pressed: true, value: 1 }`); await sleep(400);
  const pd5 = await padState();
  await js(`(() => { navigator.getGamepads = window.__realPads; delete window.__pad; })()`);
  ok(pd0?.pad && pd0.hint && pd1.kmh > 15 && pd2.yaw - pd1.yaw > 0.1 && pd3.fire && !pd4.fire && pd5 === null,
    `a gamepad drives it: its left stick pulls away (${pd1?.kmh.toFixed(0)} km/h) and steers (${((pd2?.yaw - pd1?.yaw) * 180 / Math.PI).toFixed(0)}°), A fires, Back ends the drive; the speed box shows its buttons`);
  await press('escape'); await release('escape');
  await sleep(300);
  // tracks: how each track model's rotation parameters turn its wheels (measured on the model: the
  // belt's wheel, its radius, which way is forward; an auger's thread a screw), then a tracked
  // vehicle: on the spot its tracks run opposite ways, and the belt as far as the ground goes by
  const rolls = await js(`(async () => {
    const xo = window.__xo, v = xo.viewer, THREE = await import('three');
    const { Animator } = await import('./anim.js');
    const { rollsOf } = await import('./drive.js');
    const out = {};
    for (const f of [...xo.state.folders.values()].filter((f) => f.dir.startsWith('models/constructor/chassis/tracks/'))) {
      const info = await xo.getInfo(f.main), g = await v.makeModel(info, 0, { animate: true }), a = new Animator(v, info, g);
      await a.load();
      const sides = [new THREE.Matrix4(), new THREE.Matrix4().makeScale(-1, 1, 1), new THREE.Matrix4().makeRotationY(Math.PI)].map((M) => rollsOf(a, g, M));
      out[f.name] = { n: sides[0].length, per: sides[0].every((r) => Math.abs(r.per - 1) < 0.01), signs: sides.map((l) => l.map((r) => r.sign).join()).join('|'), screw: sides[0].filter((r) => r.screw).length, belt: !!a.belts };
      v.disposeModel(g);
    }
    return out;
  })()`);
  const rollOk = Object.values(rolls).every((r) => r.n >= 1 && r.per && r.signs === [1, 1, -1].map((x) => Array(r.n).fill(x).join()).join('|'));
  ok(Object.keys(rolls).length >= 8 && rollOk && rolls.track_raider_01?.n === 4 && rolls.shneck?.screw === 2 && Object.entries(rolls).filter(([k]) => k !== 'shneck').every(([, r]) => r.belt),
    `every track's wheels roll forward placed either way round or mirrored, back turned round (${Object.keys(rolls).length} models: the raider track's four wheel sizes, the auger's two screws)`);
  const tracked = await js(`(async () => {
    const xo = window.__xo, b = xo.build;
    xo.setView('build');
    for (const i of [...b.instances]) b.removeInstance(i);
    const T = 'models/constructor/chassis/tracks/track_dow/track_dow.mdl';
    const cab = await b.createInstance({ path: 'models/constructor/cabins/scientists_cab7/scientists_cab7.mdl', position: [0, 0, 0] });
    const probe = await b.createInstance({ path: T, position: [0, 0, 0] });
    const cb = cab.box.clone(), tb = probe.box.clone();
    b.removeInstance(probe);
    const tw = tb.max.x - tb.min.x, cx = (tb.min.x + tb.max.x) / 2;
    cab.group.position.y += (tb.max.y - tb.min.y) * 0.6 - cb.min.y; cab.group.updateMatrixWorld(true); cab.box = cab.group.userData.box.clone().applyMatrix4(cab.group.matrixWorld);
    for (const side of [1, -1]) {
      const x = side > 0 ? cb.max.x + tw * 0.55 : cb.min.x - tw * 0.55;
      await b.createInstance({ path: T, position: [x - cx * side, -tb.min.y, (cb.min.z + cb.max.z) / 2 - (tb.min.z + tb.max.z) / 2], mirrored: side < 0 });
    }
    b.commit();
    await new Promise((r) => setTimeout(r, 500));
    return b.instances.length;
  })()`);
  await clickOn('#bDrive');
  await waitFor('window.__xo.drive.active && window.__xo.drive.car.tracks.length === 2 && window.__xo.drive.car.tracks.every((t) => t.anim)', 60000).catch(() => {});
  await sleep(800);
  const trackState = () => js(`(() => { const d = window.__xo.drive; return d.car ? d.car.tracks.map((t) => ({ x: t.x, ran: t.ran || 0, belt: t.anim ? t.anim.belts.drives[0].acc * t.rolls.find((r) => r.wheel === t.anim.belts.drives[0].d.name).r : NaN, still: t.group.visible })) : null; })()`);
  const tk0 = await trackState();
  await press('a'); await sleep(1200); await release('a');
  const tk1 = await trackState();
  await press('w'); await sleep(1500); await release('w');
  const tk2 = await trackState();
  const ranOf = (l, k) => l[k].ran - tk0[k].ran;
  const left = tk1 ? tk1.findIndex((t) => t.x > 0) : -1, right = tk1 ? tk1.findIndex((t) => t.x < 0) : -1;
  ok(tracked === 3 && tk0 && tk0.every((t) => !t.still) && left >= 0 && right >= 0 && ranOf(tk1, left) < -0.5 && ranOf(tk1, right) > 0.5,
    `a tracked vehicle's tracks run (animated in place of the still ones): turning left on the spot, the left one back ${ranOf(tk1, left).toFixed(1)} m, the right one on ${ranOf(tk1, right).toFixed(1)} m`);
  ok(tk2 && tk2.every((t, k) => Math.abs(t.belt - tk0[k].belt - (t.ran - tk0[k].ran)) < 0.02 + 0.03 * Math.abs(t.ran - tk0[k].ran)) && tk2.every((t, k) => t.ran - tk1[k].ran > 0.5),
    `the belts run as far as the ground goes by (${tk2.map((t, k) => (t.belt - tk0[k].belt).toFixed(2) + ' / ' + (t.ran - tk0[k].ran).toFixed(2) + ' m').join(', ')})`);
  // its road wheels ride their springs (the game's TrackSuspension: down to the ground under each,
  // hanging all the way in the air)
  const springState = () => js(`(() => window.__xo.drive.car.tracks.map((t) => (t.springs || []).map((S) => ({ ext: S.ext, lo: S.lo, hi: S.hi }))))()`);
  const sp0 = await springState();
  await js(`(() => { const s = window.__xo.drive.state; s.pos.y += 5; s.grounded = false; s.vy = 0; })()`);
  await sleep(450);
  const sp1 = await springState();
  await sleep(2000);
  const flat0 = sp0.flat(), flat1 = sp1.flat();
  ok(sp0.length === 2 && sp0.every((l) => l.length === 6) && flat0.filter((S) => S.ext > S.lo + 0.02 && S.ext < S.hi - 0.02).length >= 0.8 * flat0.length && flat1.every((S) => S.ext > 0.95 * S.hi),
    `its road wheels ride their springs (${sp0[0]?.length} a track; ${flat0.map((S) => S.ext.toFixed(2)).slice(0, 6).join(', ')} of ${flat0[0]?.hi} on the ground, all the way out in the air)`);
  await press('escape'); await release('escape');
  await sleep(300);
  // legs walk: how LegX / LegY / LegZ place each walking leg's foot (measured on the model), the
  // vertical legs (no clips) standing; a four-legged vehicle steps in two sets by turns, its feet
  // planted while they stand, with the game's footsteps, and back under it when it stops
  const gaits = await js(`(async () => {
    const xo = window.__xo, v = xo.viewer, THREE = await import('three');
    const { Animator } = await import('./anim.js');
    const { gaitOf, placeFoot } = await import('./drive.js');
    const out = {};
    for (const path of ['legs/leg02/leg02.mdl', 'legs/legs_new_mech_01/legs_new_mech_01.mdl', 'legs/leg_millipede/leg_millipede_leg_01.mdl', 'leg_vertical/leg_vertical_epic/leg_vertical_epic.mdl']) {
      const info = await xo.getInfo('models/constructor/chassis/' + path), g = await v.makeModel(info, 0, { animate: true }), a = new Animator(v, info, g);
      await a.load();
      const k = gaitOf(a, g, new THREE.Matrix4());
      // the foot where it is asked to go: 0.4 m ahead and 0.2 m down
      let err = null;
      if (k) {
        placeFoot(a, k, new THREE.Matrix4(), new THREE.Vector3(0, -0.2, 0.4));
        g.updateMatrixWorld(true);
        const at = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld.clone().invert().multiply(a.skel.bones[k.bone].matrixWorld));
        err = at.sub(k.foot).sub(new THREE.Vector3(0, -0.2, 0.4)).length();
      }
      out[path.split('/').pop()] = k ? { step: k.step?.name, dur: k.step?.dur, err } : null;
      v.disposeModel(g);
    }
    return out;
  })()`);
  ok(gaits['leg02.mdl']?.step === 'step' && gaits['legs_new_mech_01.mdl']?.step === 'step' && gaits['leg_millipede_leg_01.mdl']?.step === 'step' && gaits['leg_vertical_epic.mdl'] === null
    && ['leg02.mdl', 'legs_new_mech_01.mdl'].every((k) => gaits[k].err < 0.02),
    `the walking legs place their feet where they are asked (the spider and mechanical legs ${['leg02.mdl', 'legs_new_mech_01.mdl'].map((k) => (gaits[k]?.err * 100).toFixed(1) + ' cm').join(' and ')} off), each with the game's step (${gaits['leg02.mdl']?.dur.toFixed(2)} s); the vertical legs stand`);
  const walker = await js(`(async () => {
    const xo = window.__xo, b = xo.build;
    xo.setView('build');
    for (const i of [...b.instances]) b.removeInstance(i);
    const L = 'models/constructor/chassis/legs/leg02/leg02.mdl';
    const probe = await b.createInstance({ path: L, position: [0, 0, 0] });
    const lb = probe.box.clone();
    b.removeInstance(probe);
    const cab = await b.createInstance({ path: 'models/constructor/cabins/scientists_cab7/scientists_cab7.mdl', position: [0, 0, 0] });
    const cb = cab.box.clone(), hip = -lb.min.y;
    cab.group.position.y += hip - 0.3 - cb.min.y; cab.group.updateMatrixWorld(true); cab.box = cab.group.userData.box.clone().applyMatrix4(cab.group.matrixWorld);
    for (const z of [cb.max.z - (cb.max.z - cb.min.z) * 0.15, cb.min.z + (cb.max.z - cb.min.z) * 0.15]) {
      await b.createInstance({ path: L, position: [cb.min.x, hip, z] });
      await b.createInstance({ path: L, position: [cb.max.x, hip, z], mirrored: true });
    }
    b.commit();
    const s = xo.viewer.sounds, play = s.play.bind(s); window.__steps = 0;
    s.play = (f, ...r) => { if (/^legs_step/.test(f)) window.__steps++; return play(f, ...r); };
    s.unwrap = () => { s.play = play; };
    await new Promise((r) => setTimeout(r, 500));
    return b.instances.length;
  })()`);
  await clickOn('#bDrive');
  await waitFor('window.__xo.drive.active && window.__xo.drive.car.legs.length === 4 && window.__xo.drive.car.legs.every((l) => l.anim)', 60000).catch(() => {});
  await sleep(800);
  const legState = () => js(`(() => { const d = window.__xo.drive; return d.car ? d.car.legs.map((l) => { const b = l.anim.skel.bones[l.gait.bone]; b.updateMatrixWorld(true); const e = b.matrixWorld.elements;
    return { team: l.team, steps: l.steps || 0, lift: !!l.lift, p: l.lift?.p ?? 1, f: Math.hypot(l.f.x, l.f.z), at: [e[12], e[14]], still: l.group.visible }; }) : null; })()`);
  await press('w');
  const walkFrames = [];
  for (let k = 0; k < 8; k++) { await sleep(100); walkFrames.push(await legState()); }
  await sleep(700);
  await release('w');
  const walked = await legState();
  await sleep(3500);
  const stood = await legState();
  await js(`window.__xo.viewer.sounds.unwrap?.()`);
  const heard = await js(`window.__steps`);
  // planted: a standing foot (the same step) moves little between frames while the vehicle walks on
  let slip = 0, both = 0;
  for (let k = 1; k < walkFrames.length; k++) walkFrames[k].forEach((l, i) => { const o = walkFrames[k - 1][i]; if (!l.lift && !o.lift && l.steps === o.steps) slip = Math.max(slip, Math.hypot(l.at[0] - o.at[0], l.at[1] - o.at[1])); });
  for (const fr of walkFrames) if (fr.some((l) => l.lift && l.p < 0.5 && l.team === 0) && fr.some((l) => l.lift && l.p < 0.5 && l.team === 1)) both++;
  ok(walker === 5 && walked && walked.every((l) => l.steps >= 2 && !l.still) && new Set(walked.map((l) => l.team)).size === 2 && both === 0 && slip < 0.06 && heard >= 4,
    `a four-legged vehicle walks: every leg stepped (${walked?.map((l) => l.steps).join(', ')} steps in 1.5 s), the two sets by turns, a standing foot planted (at most ${(slip * 100).toFixed(1)} cm a frame), ${heard} footsteps`);
  ok(stood && stood.every((l) => !l.lift && l.f < 0.15), `stopped, its feet step back under it (${stood?.map((l) => l.f.toFixed(2)).join(', ')} m off)`);
  await press('escape'); await release('escape');
  await sleep(300);
  // hover jets tilt their thrust (W: back; turning left: out to the right), and what moves by itself
  // moves (the cabin's idle, an engine's belts, a radar; the motors faster with the revs)
  const hoverBuild = await js(`(async () => {
    const xo = window.__xo, b = xo.build;
    xo.setView('build');
    for (const i of [...b.instances]) b.removeInstance(i);
    const H = 'models/constructor/chassis/hovers/hover_jet/hover_jet.mdl';
    const probe = await b.createInstance({ path: H, position: [0, 0, 0] });
    const hb = probe.box.clone();
    b.removeInstance(probe);
    const cab = await b.createInstance({ path: 'models/constructor/cabins/raider_cab1/raider_cab1.mdl', position: [0, 0, 0] });
    const cb = cab.box.clone();
    cab.group.position.y += hb.max.y - hb.min.y - cb.min.y; cab.group.updateMatrixWorld(true); cab.box = cab.group.userData.box.clone().applyMatrix4(cab.group.matrixWorld);
    const cx = (hb.min.x + hb.max.x) / 2, cz = (hb.min.z + hb.max.z) / 2, hw = (hb.max.x - hb.min.x) / 2, hd = (hb.max.z - hb.min.z) / 2;
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      await b.createInstance({ path: H, position: [(sx > 0 ? cb.max.x - hw : cb.min.x + hw) - cx, -hb.min.y, (sz > 0 ? cb.max.z - hd : cb.min.z + hd) - cz], mirrored: sx < 0 });
    }
    await b.createInstance({ path: 'models/constructor/modules/engine_flat10/engine_flat10.mdl', position: [0, cab.box.max.y, cb.min.z + 0.4] });
    await b.createInstance({ path: 'models/constructor/modules/radar_common/radar_common.mdl', position: [0.6, cab.box.max.y, cb.max.z - 0.4] });
    b.commit();
    await new Promise((r) => setTimeout(r, 500));
    return b.instances.length;
  })()`);
  await clickOn('#bDrive');
  await waitFor('window.__xo.drive.active && window.__xo.drive.car.hovers.length === 4 && window.__xo.drive.car.hovers.every((h) => h.anim) && window.__xo.drive.car.idles.filter((p) => p.anim).length === 3', 60000).catch(() => {});
  await sleep(500);
  // where each jet's thrust goes now (straight down at rest), in the vehicle's frame: the turn of the
  // bone its pitch (roll) turns, applied to straight down
  const jets = (key) => js(`(async () => { const THREE = await import('three'), d = window.__xo.drive; return d.car.hovers.map((h) => {
    const t = h.tilt[${JSON.stringify(key)}]; if (!t) return null;
    const b = h.anim.skel.bones[t.bone], now = new THREE.Quaternion(), rest = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    h.copy.updateMatrixWorld(true);
    h.copy.matrixWorld.clone().invert().multiply(b.matrixWorld).decompose(p, now, s);
    new THREE.Matrix4().fromArray(h.info.nodes[t.bone].matrix).decompose(p, rest, s);
    const R = new THREE.Matrix4().extractRotation(h.copy.matrix);
    return new THREE.Vector3(0, -1, 0).applyMatrix4(R.clone().invert()).applyQuaternion(now.multiply(rest.invert())).applyMatrix4(R).toArray(); }); })()`);
  const idleState = () => js(`(() => window.__xo.drive.car ? window.__xo.drive.car.idles.filter((p) => p.anim).map((p) => { const sk = p.anim.skel; let turn = 0; sk.bones.forEach((b, i) => { const q = b.quaternion.clone().multiply(sk.rest[i].q.clone().invert()); turn += Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z); });
    return { name: p.info.path.split('/').pop(), motor: p.motor, time: p.anim.time, turn }; }) : [])()`);
  const id0 = await idleState();
  await sleep(600);
  const id1 = await idleState();
  await press('w'); await sleep(1300);
  const pitched = await jets('pitch');
  const id2 = await idleState(); await sleep(500); const id3 = await idleState();
  await release('w');
  await press('a'); await sleep(1300);
  const rolled = await jets('roll');
  await release('a');
  ok(hoverBuild === 7 && pitched.length === 4 && pitched.every((v) => v && v[2] < -0.4) && rolled.every((v) => v && v[0] < -0.2),
    `hover jets tilt: pulling ahead their exhaust goes back (${pitched.map((v) => v?.[2].toFixed(2)).join(', ')}), turning left out to the right (${rolled.map((v) => v?.[0].toFixed(2)).join(', ')}), mirrored ones alike`);
  // a hover rides over the river (its spray under it)
  if (river) {
    await js(`(() => { const d = window.__xo.drive, s = d.state; s.pos.set(${river.x}, ${river.lvl} + 2, ${river.z}); s.v = 0; s.vy = 0; s.grounded = false; })()`);
    await sleep(1800);
  }
  const afloat = river ? await js(`(() => { const d = window.__xo.drive, s = d.state; return { y: s.pos.y, spray: d.dust.filter((x) => /hover_water/.test(x.path || '')).length, surface: s.surface }; })()`) : null;
  ok(afloat && Math.abs(afloat.y - (river.lvl + 0.7)) < 0.25 && afloat.spray >= 2 && afloat.surface === 'water',
    `a hover rides over the river (${afloat ? (afloat.y - river.lvl).toFixed(2) : '?'} m over the water, ${afloat?.spray} sprays under it)`);
  const rate = (a, b, k) => (b[k].time - a[k].time) / 0.5;
  ok(id1.length === 3 && id1.every((p, k) => p.time > id0[k].time && Math.abs(p.turn - id0[k].turn) > 1e-3) && id3.every((p, k) => (p.motor ? rate(id2, id3, k) > 1.3 : Math.abs(rate(id2, id3, k) - 1) < 0.2)),
    `what moves by itself moves: ${id1.map((p) => p.name.replace('.mdl', '')).join(', ')} (the motors at ${id3.filter((p) => p.motor).map((p) => rate(id2, id3, id3.indexOf(p)).toFixed(1) + 'x').join(', ')} with the revs)`);
  await press('escape'); await release('escape');
  await sleep(300);
  await js(`(() => { const b = window.__xo.build; for (const i of [...b.instances]) b.removeInstance(i); b.commit(); })()`);

  // ---- leaving and coming back ----
  const inMap = await cam();
  await clickOn('#mainMode [data-view="part"]');
  await frames();
  const part = await js(`(() => { const v = window.__xo.viewer; return { fog: v.scene.fog, sky: v.skyDome.visible, env: v.scene.environmentIntensity, key: v.key.intensity, map: v.mapRoot.visible, floor: v.floor.visible, fov: v.camera.fov, orbit: v.controls.enabled,
    hud: document.getElementById('mapHud').hidden && document.getElementById('mapPanel').hidden && document.getElementById('mapTools').hidden, list: !document.getElementById('listWrap').hidden && document.getElementById('mapSide').hidden }; })()`);
  ok(!part.fog && !part.sky && !part.map && part.floor && part.orbit && part.fov === 38, '3D Viewer: no haze or sky, its floor and orbit camera back, its own lens');
  ok(part.env === 1 && Math.abs(part.key - 1.7) < 1e-6, `3D Viewer: its own lighting again (sky ${part.env}, sun ${part.key})`);
  ok(part.hud && part.list, "the map's HUD and panel go, the parts list comes back");
  await tap('w');
  ok(await js('window.__xo.viewer.options.wireframe'), 'W is the wireframe key again in the 3D Viewer');
  await tap('w');
  await clickOn('#mainMode [data-view="map"]');
  await frames();
  b = await cam();
  ok(len(sub(b.p, inMap.p)) < 0.01 && dot(b.f, inMap.f) > 0.9999 && b.fov === 60 && (await js('!!window.__xo.viewer.scene.fog && window.__xo.maps.sky.group.visible && !window.__xo.viewer.skyDome.visible')),
    "back in Maps: the same map, the camera where it was, haze and the game's sky back");

  // ---- selecting objects: hover, click, Ctrl + click, all of a kind, F, H, Ctrl + drag, Esc, export ----
  const CAR = 'carbroken1_gr03';
  const carRec = `window.__xo.maps.models.find((r) => r.path.includes('${CAR}'))`;
  const nCar = await js(`${carRec}.n`);
  // (the one with the most other objects within 40 m: another to Ctrl + click near it)
  const carAt = await js(`(() => { const m = window.__xo.maps, car = ${carRec}; let best = null;
    for (let i = 0; i < car.n; i++) { const c = car.centers.subarray(i * 3, i * 3 + 3); let k = 0;
      for (const r of m.models) { if (r === car || !r.centers) continue; for (let j = 0; j < r.n; j++) if (r.radii[j] >= 0.8 && Math.hypot(r.centers[j * 3] - c[0], r.centers[j * 3 + 2] - c[2]) < 40) k++; }
      if (!best || k > best.k) best = { k, c: Array.from(c) }; }
    return best.c; })()`);
  await pose([carAt[0] + 7, carAt[1] + 4, carAt[2] + 7], carAt);
  await frames(4);
  const screenOf = (c) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor, p = new T(${c.join(',')}).project(m.v.camera), r = m.v.canvas.getBoundingClientRect();
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height }; })()`);
  const sp = await screenOf(carAt);
  await mouse('mouseMoved', sp.x, sp.y);
  await sleep(150);
  await frames(3);
  const hov = await js(`(() => { const m = window.__xo.maps, t = document.getElementById('hoverTip'); return { hover: m.hover?.rec.path, tip: t.hidden ? '' : t.textContent, colors: m.v.outlines.map((o) => o.color), cursor: m.v.canvas.style.cursor }; })()`);
  ok(hov.hover?.includes(CAR) && /carbroken1 gr03/.test(hov.tip) && hov.colors.includes(0xffffff) && hov.cursor === 'pointer', `hovering a burnt car: white outline, "${hov.tip}" by the cursor`);
  await click(sp.x, sp.y);
  await waitFor(`/Position/.test(document.getElementById('mpSelStats').textContent)`, 10000).catch(() => {});
  const s1 = await js(`(() => { const m = window.__xo.maps; return { sel: m.selected().map((q) => q.rec.path), ids: m.selectedIds(), card: !document.getElementById('mpSelCard').hidden, title: document.getElementById('mpSelTitle').textContent,
    kind: document.getElementById('mpSelKind').textContent, stats: document.getElementById('mpSelStats').textContent, colors: m.v.outlines.map((o) => o.color), all: document.getElementById('mpSelAll').textContent }; })()`);
  ok(s1.sel.length === 1 && s1.sel[0].includes(CAR) && s1.card && s1.title === 'Carbroken1 gr03' && /car burnt/.test(s1.kind) && s1.colors.includes(0xffa43c),
    `a click selects it: orange outline, the card "${s1.title}" (${s1.kind})`);
  ok(new RegExp(`On this map\\s*${nCar}`).test(s1.stats) && /Position/.test(s1.stats) && /Turned/.test(s1.stats) && /Object number\s*\d+/.test(s1.stats) && s1.all === `Select all ${nCar}`,
    'the card: how many the map has, where it stands and how it is turned, its object number');
  const neighbour = await js(`(() => { const m = window.__xo.maps, cam = m.v.camera, r = m.v.canvas.getBoundingClientRect(), T = cam.position.constructor; let best = null;
    for (const rec of m.models) { if (!rec.centers || rec.path.includes('${CAR}')) continue; for (let i = 0; i < rec.n; i++) { const w = new T().fromArray(rec.centers, i * 3), d = w.distanceTo(cam.position); if (d > 60 || rec.radii[i] < 0.8) continue;
      const c = w.clone().project(cam); if (Math.abs(c.x) > 0.8 || Math.abs(c.y) > 0.8 || c.z > 1) continue; const x = r.left + (c.x + 1) / 2 * r.width, y = r.top + (1 - c.y) / 2 * r.height;
      const h = m.pickAt(x, y); if (h && h.rec === rec && h.i === i && (!best || d < best.d)) best = { x, y, d }; } } return best; })()`);
  if (neighbour) {
    await click(neighbour.x, neighbour.y, 'left', { modifiers: 2 });
    const two = await js(`({ n: window.__xo.maps.sel.size, title: document.getElementById('mpSelTitle').textContent, kinds: document.querySelectorAll('#mpSelKinds [data-k]').length })`);
    await click(neighbour.x, neighbour.y, 'left', { modifiers: 2 });
    ok(two.n === 2 && two.title === '2 objects' && two.kinds === 2 && (await js('window.__xo.maps.sel.size')) === 1, 'Ctrl + click adds another object (the card lists both models), and takes it away again');
  } else ok(false, 'another object near the car to Ctrl + click');
  await clickOn('#mpSelAll');
  ok((await js('window.__xo.maps.sel.size')) === nCar && (await js(`document.getElementById('mpSelTitle').textContent`)) === `Carbroken1 gr03 × ${nCar}`, `"Select all ${nCar}": every one of them on the map`);
  // H hides them (from the view and from the map's export), Show them brings them back
  const drawnBefore = await js('window.__xo.maps.drawn.placements');
  await key('h'); // (from the focused button too: it gives the map its keys)
  await frames(3);
  const hid = await js(`(() => { const m = window.__xo.maps; return { sel: m.sel.size, hidden: m.hidden.size, row: !document.getElementById('mpHiddenRow').hidden, note: document.getElementById('mxHiddenNote').textContent, drawn: m.drawn.placements,
    picked: (() => { const r = m.v.canvas.getBoundingClientRect(), T = m.v.camera.position.constructor, p = new T(${carAt.join(',')}).project(m.v.camera); const h = m.pickAt(r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height); return h ? h.rec.path : ''; })() }; })()`);
  ok(hid.sel === 0 && hid.hidden === nCar && hid.row && hid.note.includes(`${nCar} hidden objects`) && hid.drawn < drawnBefore && !hid.picked.includes(CAR), `H hides all ${nCar} (drawn ${drawnBefore} -> ${hid.drawn}; no longer picked; the export card says they stay out)`);
  const without = path.join(outDir, `${MAP}_without_cars.glb`);
  await js(`window.__xo.call('exportMap', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', format: 'glb', terrain: false, props: true, trees: false, objects: true, water: false, lod: 3, textures: false, decals: false, grass: false, sun: false, sky: false,
    exclude: window.__xo.maps.hiddenIds(), outPath: ${JSON.stringify(without)} })`);
  const wj = (() => { const b = fs.readFileSync(without); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const nonTrees = await js(`window.__xo.maps.models.filter((r) => r.group !== 'trees').reduce((a, r) => a + r.n, 0)`);
  ok(wj.asset.extras.parts === nonTrees - nCar && !wj.nodes.some((n) => n.extras?.source?.includes(CAR)), `the map export leaves the hidden cars out (${wj.asset.extras.parts} of ${nonTrees} objects)`);
  await clickOn('#mpShowHidden');
  await frames(3);
  ok((await js('window.__xo.maps.hidden.size')) === 0 && (await js('window.__xo.maps.drawn.placements')) === drawnBefore && (await js(`document.getElementById('mpHiddenRow').hidden`)), '"Show them": back in the view');
  // F flies to the selection
  await click(sp.x, sp.y);
  await pose([carAt[0] + 150, carAt[1] + 90, carAt[2] + 150], carAt);
  await key('f');
  const flyDist = await js(`window.__xo.maps.v.camera.position.distanceTo(new (window.__xo.maps.v.camera.position.constructor)(${carAt.join(',')}))`);
  ok(flyDist < 30, `F flies to the selected car (${flyDist.toFixed(1)} m from it)`);
  // Ctrl + drag: a box
  await pose([carAt[0] + 40, carAt[1] + 25, carAt[2] + 40], carAt);
  await key('Escape');
  await frames(4);
  const vr = await js(`(() => { const r = window.__xo.maps.v.canvas.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; })()`);
  await drag(vr.l + vr.w * 0.3, vr.t + vr.h * 0.3, vr.l + vr.w * 0.7, vr.t + vr.h * 0.7, { modifiers: 2 });
  const box = await js(`({ n: window.__xo.maps.sel.size, kinds: document.querySelectorAll('#mpSelKinds [data-k]').length, gone: !window.__xo.maps.boxEl || window.__xo.maps.boxEl.hidden })`);
  ok(box.n > 5 && box.kinds > 2 && box.gone, `Ctrl + drag selects what lies in the box: ${box.n} objects of ${box.kinds} models`);
  // the selection exported: as the objects stand to each other, on the origin
  const sel = path.join(outDir, `${MAP}_selection.glb`);
  const nSel = box.n;
  await js(`window.__xo.call('exportMapObjects', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', ids: window.__xo.maps.selectedIds(), format: 'glb', keepPosition: false, lod: 0, textures: true, maxTex: 256, outPath: ${JSON.stringify(sel)} })`);
  const sj = (() => { const b = fs.readFileSync(sel); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const placed = sj.nodes.filter((n) => n.extras?.source);
  const midX = placed.reduce((a, n) => a + (n.matrix ? n.matrix[12] : 0), 0) / Math.max(1, placed.length);
  const vs = validate(sel);
  ok(placed.length === nSel && Math.abs(midX) < 1 && vs.startsWith('ok'), `"Export selection": ${placed.length} objects around the origin, validates`);
  await key('Escape');
  const esc = await js(`({ n: window.__xo.maps.sel.size, card: document.getElementById('mpSelCard').hidden, outlines: window.__xo.viewer.outlines.length })`);
  ok(esc.n === 0 && esc.card && esc.outlines === 0, 'Esc lets go: no selection, no card, no outline');
  await pose([carAt[0] + 7, carAt[1] + 4, carAt[2] + 7], carAt);
  await frames(3);
  await click(sp.x, sp.y);
  await clickOn('#mainMode [data-view="part"]');
  const inPart = await js('window.__xo.viewer.outlines.length');
  await clickOn('#mainMode [data-view="map"]');
  await frames();
  ok(inPart === 0 && (await js('window.__xo.viewer.outlines.length')) === 1 && (await js('window.__xo.maps.sel.size')) === 1, "the outline stays in Maps (none in the 3D Viewer), the selection comes back with it");
  await key('Escape');

  // ---- V held: the Fire card's gun fires from beside the camera at the middle of the view ----
  // its rounds land where the view's middle looks (the ground, or water: a splash), with the game's
  // hit effects and sounds; letting go stops it
  const guns = await js(`(() => { const s = document.getElementById('mpGun'); return { n: s.options.length, value: s.value, name: s.selectedOptions[0]?.textContent }; })()`);
  ok(guns.n > 100 && guns.value.endsWith('machinegun_kpvt.mdl') && guns.name === 'Vector', `the Fire card lists the game's guns (${guns.n}) and picks the Vector`);
  await js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(0, m.heightAt(0, 0) + 6, 0), new T(0, m.heightAt(0, 40), 40)); m.needsBucket = true;
    const v = m.v, imp = v.fx.impact.bind(v.fx); window.__hits = []; v.fx.impact = (p, h) => { window.__hits.push({ s: h.surface, at: h.point, p }); return imp(p, h); }; })()`);
  await sleep(400);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await sleep(1200);
  const mf = await js(`(() => { const v = window.__xo.viewer, a = v.mapAim(), c = document.querySelector('.fire-cross'), r = c.getBoundingClientRect(), vr = v.canvas.getBoundingClientRect();
    return { on: window.__xo.gunfire.on, aim: a, hits: window.__hits.map((h) => ({ s: h.s, d: Math.hypot(h.at[0] - a[0], h.at[1] - a[1], h.at[2] - a[2]), p: h.p.split('/').pop() })), asked: v.sounds.asked,
      cross: !c.hidden && Math.abs((r.left + r.right) / 2 - (vr.left + vr.right) / 2) < 2 && Math.abs((r.top + r.bottom) / 2 - (vr.top + vr.bottom) / 2) < 2 }; })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await sleep(300);
  const mfAfter = await js(`(() => { delete window.__xo.viewer.fx.impact; return window.__xo.gunfire.on || !document.querySelector('.fire-cross').hidden; })()`);
  const atAim = mf.hits.filter((h) => h.d < 1.5);
  ok(mf.on && mf.hits.length >= 5 && atAim.length === mf.hits.length && mf.asked > 0 && !mfAfter,
    `holding V fires the Vector from beside the camera: ${mf.hits.length} rounds land where the view's middle looks (${[...new Set(mf.hits.map((h) => h.p))].join(', ')}), and letting go stops it`);
  ok(mf.cross, 'a crosshair marks the middle of the view while it fires');

  // ---- the map's own sounds: its environment's soundscape (soundscapes.xml by the sound zone that
  // names the environment) as an air bed, and the sounds placed on it where they stand (crickets) or
  // along a line (the marsh); Show > Sounds silences them (remembered) ----
  const amb = await js(`(async () => {
    const xo = window.__xo, a = xo.ambience, sc = xo.maps.scene;
    for (let i = 0; i < 40 && !a.bed; i++) await new Promise((r) => setTimeout(r, 100));
    return { soundscape: sc.soundscape, sounds: sc.sounds.length, crickets: sc.sounds.filter((x) => /crickets_bridge$/.test(x.event)).length,
      line: sc.sounds.find((x) => x.line)?.event || null, bed: a.bed?.name || null, spots: a.spots.length };
  })()`);
  ok(amb.soundscape === 'event:/ambient/soundscape/bridge_day' && amb.sounds === 7 && amb.crickets === 6 && /marsh$/.test(amb.line) && /^bridge_air_main/.test(amb.bed || '') && amb.spots === 7,
    `the bridge plays its soundscape (${amb.soundscape?.split('/').pop()}: ${amb.bed}) with its ${amb.sounds} placed sounds (${amb.crickets} cricket spots, the marsh along a line)`);
  const crickets = await js(`(async () => {
    const xo = window.__xo, a = xo.ambience, m = xo.maps, T = m.v.camera.position.constructor;
    const p = a.spots.find((x) => x.def.fam === 'leaves_crickets'), w = p.pos;
    m.fly.setPose(new T(w[0] + 3, w[1] + 2, w[2] + 3), new T(w[0], w[1], w[2]));
    for (let i = 0; i < 40 && !p.voice; i++) await new Promise((r) => setTimeout(r, 100));
    const near = !!p.voice;
    m.fly.setPose(new T(w[0] + 400, w[1] + 60, w[2] + 400), new T(w[0], w[1], w[2]));
    for (let i = 0; i < 40 && p.voice; i++) await new Promise((r) => setTimeout(r, 100));
    return { near, far: !!p.voice };
  })()`);
  ok(crickets.near && !crickets.far, 'flying up to a cricket spot its crickets start; far away they stop');
  await clickOn('#mapPanel [data-show="sound"]');
  await sleep(800);
  const hush2 = await js(`({ playing: !!window.__xo.ambience.scene, loops: window.__xo.viewer.sounds.voices.filter((v) => v.loop).length, saved: window.__xo.state.settings.mapSound })`);
  await clickOn('#mapPanel [data-show="sound"]');
  ok(!hush2.playing && hush2.loops === 0 && hush2.saved === false, 'Show > Sounds off silences the map (remembered)');

  // ---- export (the bridge, as the Export button sends it; a path instead of the dialog) ----
  const glb = path.join(outDir, `${MAP}.glb`);
  const r = await js(`window.__xo.call('exportMap', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', format: 'glb', terrain: true, ground: 512, props: true, trees: false, objects: true, water: true, lod: 3, textures: false, maxTex: 256, outPath: ${JSON.stringify(glb)} })`);
  ok(fs.existsSync(glb) && r.files.length >= 1 && r.unresolved > 0, `map exported: ${r.files.length} file(s), ${(fs.statSync(glb).size / 1048576).toFixed(1)} MB (${r.unresolved} objects without a model left out)`);
  const v = validate(glb);
  ok(v.startsWith('ok'), 'the map GLB validates: ' + v.split('\n')[0]);
  const exp = await js(`(() => { const b = document.getElementById('mxExport'); return { disabled: b.disabled, label: b.textContent }; })()`);
  ok(!exp.disabled, 'the Export map button is ready for the open map');

  // the export's options for decals, grass, sun and sky (each greyed out when what it needs is off)
  const opts = () => js(`(() => { const o = {}; for (const id of ['mxDecals', 'mxGrass', 'mxGrassAmt', 'mxSun', 'mxSky', 'mxSkySize']) { const e = document.getElementById(id); o[id] = { on: e.type === 'checkbox' ? e.checked : e.value, off: e.disabled }; } return o; })()`);
  const o0 = await opts();
  ok(o0.mxDecals.on && o0.mxGrass.on && o0.mxGrassAmt.on === '0.25' && o0.mxSun.on && o0.mxSky.on && o0.mxSkySize.on === '2048' && !Object.values(o0).some((x) => x.off),
    'export options: decals, grass (a quarter), sun and a 2048 px sky, all on by default');
  await clickOn('#mxGrass');
  const o1 = await opts();
  await clickOn('#mxGrass');
  await clickOn('#mxTerrain');
  const o2 = await opts();
  await clickOn('#mxTerrain');
  await clickOn('#mxTextures');
  const o3 = await opts();
  await clickOn('#mxTextures');
  await clickOn('#mxSky');
  const o4 = await opts();
  await clickOn('#mxSky');
  const o5 = await opts();
  ok(o1.mxGrassAmt.off && o2.mxGrass.off && o2.mxGrassAmt.off && o3.mxDecals.off && !o3.mxGrass.off && o4.mxSkySize.off && !Object.values(o5).some((x) => x.off),
    'the grass amount needs Grass, grass needs the terrain, decals need textures, the sky size needs the sky');

  // a full export: decals with their textures, grass as copies, the sun as a light, the sky beside it
  const full = path.join(outDir, `${MAP}_full.glb`);
  const rf = await js(`window.__xo.call('exportMap', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', format: 'glb', terrain: true, ground: 512, props: true, trees: false, objects: true, water: true, lod: 3, textures: true, maxTex: 256,
    decals: true, grass: true, grassAmount: 0.1, sun: true, sky: true, skySize: 1024, outPath: ${JSON.stringify(full)} })`);
  const hdrFile = rf.files.find((f) => /_sky\.hdr$/.test(f));
  const fj = (() => { const b = fs.readFileSync(full); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const named = (n) => fj.nodes.find((x) => x.name === n);
  const decalGroup = named('decals'), grassGroup = named('grass'), sunNode = named('sun');
  const copies = (grassGroup?.children || []).reduce((a, c) => a + (fj.accessors[fj.nodes[c].extensions?.EXT_mesh_gpu_instancing?.attributes?.TRANSLATION]?.count || 0), 0);
  ok(decalGroup?.children?.length > 100 && fj.materials.some((m) => m.name.startsWith('decal_') && m.alphaMode === 'BLEND' && m.normalTexture), `exported decals: ${decalGroup?.children?.length} meshes, blended, with their relief`);
  ok(grassGroup?.children?.length >= 2 && copies > 1000 && fj.extensionsUsed?.includes('EXT_mesh_gpu_instancing'), `exported grass: ${grassGroup?.children?.length} kinds, ${copies} copies (EXT_mesh_gpu_instancing)`);
  ok(sunNode?.extensions?.KHR_lights_punctual && fj.extensions?.KHR_lights_punctual?.lights?.[0]?.type === 'directional' && fj.extensionsUsed?.includes('KHR_lights_punctual'), 'exported sun: a directional glTF light');
  const hdrHead = hdrFile ? fs.readFileSync(hdrFile).subarray(0, 120).toString('latin1') : '';
  ok(hdrFile && fj.asset?.extras?.sky === path.basename(hdrFile) && hdrHead.startsWith('#?RADIANCE') && /-Y 512 \+X 1024/.test(hdrHead), `exported sky: ${hdrFile ? path.basename(hdrFile) : 'none'} (Radiance, 1024 x 512), named in the file`);
  const vf = validate(full);
  ok(vf.startsWith('ok'), 'the full map GLB validates: ' + vf.split('\n')[0]);
  // the weather the view shows goes into an export: its sun (an overcast's: next to none) and sky
  const over = path.join(outDir, `${MAP}_overcast.glb`);
  const ro = await js(`window.__xo.call('exportMap', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', environment: '829134', format: 'glb', terrain: false, props: false, trees: false, objects: true, water: false, lod: 3, textures: false,
    decals: false, grass: false, sun: true, sky: true, skySize: 256, outPath: ${JSON.stringify(over)} })`);
  const oj = (() => { const b = fs.readFileSync(over); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const sunI = oj.extensions?.KHR_lights_punctual?.lights?.[0]?.intensity;
  const fullSun = fj.extensions?.KHR_lights_punctual?.lights?.[0]?.intensity;
  ok(/^829134 /.test(oj.asset?.extras?.environment || '') && sunI < fullSun * 0.2 && ro.files.some((f) => /_sky\.hdr$/.test(f)),
    `an export takes the weather: ${oj.asset?.extras?.environment}, its sun ${sunI?.toFixed(2)} (the day's ${fullSun?.toFixed(2)}) and its sky`);

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
