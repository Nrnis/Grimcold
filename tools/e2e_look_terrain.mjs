// End-to-end test of the terrain's look in Maps (the ground as the game draws it): the surfaces'
// texture arrays (the game's own BC1 / BC3 blocks at its TextureArraySliceSize, anisotropic), their
// normal maps (relief), gloss (the sun's glint on bridge's wet riverbed, where the game's capture of
// that view has it), occlusion, metal and height blending (off where the map says so), the bake's
// roughness beyond them, parallax on displaced surfaces, the detail sets and their noise,
// hangar_newyear's snow lent by snow/snow1, the weather's cover (bridge's New Year snow; fix_dull_norain
// leaves it dry), a GPU without BC textures, the view distance, the export's terrain maps (normal,
// occlusion / roughness / metal) and the terrain's frame time.
//   node tools/e2e_look_terrain.mjs [--snap-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, sleep, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-terrain-', size: '1500,940' });
const { js, waitFor, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
const U = 'window.__xo.maps.terrainMat.userData.splat';
// a map (and weather) open, its models, ground and surface textures in, every texture fetched
const open = async (name, environment = '') => {
  await js(`window.__xo.openMap(${JSON.stringify(name)}${environment ? `, { environment: ${JSON.stringify(environment)} }` : ''})`);
  await waitFor(`window.__xo.maps.scene?.name === ${JSON.stringify(name)} && !!window.__xo.maps.loading?.finished && !!window.__xo.maps.splat && document.getElementById('busy').hidden`, 240000);
  const t0 = Date.now();
  while (Date.now() - t0 < 40000 && (await js(`(() => { let n = 0; for (const c of [window.__xo.viewer.tex, window.__xo.viewer.geo]) c.map.forEach((e) => { if (e && !e.value) n++; }); return n; })()`))) await sleep(300);
};
const show = (on, keys = ['props', 'trees', 'objects', 'grass', 'decals', 'spawns']) => js(`(() => { for (const k of ${JSON.stringify(keys)}) window.__xo.maps.setShow(k, ${on}); })()`);
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; m.v.dirty = true; })()`);
// a fresh frame drawn, then the luminance of a part of the view (shares of its width and height,
// from the top left): its mean, 99th percentile, detail (mean |laplacian|) and how far it is from the
// last one taken of the same size (mean |difference|)
const region = async (x0, y0, x1, y1) => {
  await js(`new Promise((r) => { window.__xo.maps.needsBucket = true; window.__xo.viewer.dirty = true; let k = 4; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
  await sleep(300);
  return js(`(() => {
    const c = window.__xo.viewer.canvas, g = c.getContext('webgl2'), W = g.drawingBufferWidth, H = g.drawingBufferHeight;
    const x = Math.round(W * ${x0}), w = Math.round(W * ${x1}) - x, h = Math.round(H * ${y1}) - Math.round(H * ${y0}), y = H - Math.round(H * ${y1});
    const px = new Uint8Array(w * h * 4);
    g.readPixels(x, y, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    const L = new Float32Array(w * h);
    let sum = 0, sat = 0;
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4], gr = px[i * 4 + 1], b = px[i * 4 + 2];
      L[i] = 0.2126 * r + 0.7152 * gr + 0.0722 * b; sum += L[i]; sat += Math.max(r, gr, b) - Math.min(r, gr, b);
    }
    let lap = 0, n = 0;
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++, n++) { const k = j * w + i; lap += Math.abs(4 * L[k] - L[k - 1] - L[k + 1] - L[k - w] - L[k + w]); }
    const s = Array.from(L).sort((a, b) => a - b), last = window.__lastRegion;
    let diff = 0;
    if (last?.length === L.length) for (let i = 0; i < L.length; i++) diff += Math.abs(L[i] - last[i]);
    window.__lastRegion = L;
    return { mean: sum / (w * h), p99: s[Math.floor(s.length * 0.99)], white: s.filter((v) => v >= 250).length / s.length, sat: sat / (w * h), detail: lap / n, diff: diff / L.length };
  })()`);
};

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- bridge: the arrays, what the surfaces carry, the bake's roughness ----
  await open('bridge');
  const b = await js(`(() => { const m = window.__xo.maps, u = ${U}, h = m.splat.head, sup = m.v.support;
    return { arrays: m.splat.arrays, slice: h.slice, hb: h.heightBlend, aniso: u.xoSurf.value.anisotropy, want: Math.min(16, sup.anisotropy),
      kinds: [u.xoSurf.value, u.xoSurfN.value, u.xoSurfG.value].map((t) => t.isCompressedArrayTexture ? t.format : 'rgba'),
      surfaces: h.surfaces.map((s) => ({ name: s.name, n: !!s.normal, g: !!s.gloss, blend: s.blend, amp: s.amp })),
      key: m.terrainMat.customProgramCacheKey(), orm: !!m.groundOrm && u.xoBakeOrm.value === m.groundOrm, fade: u.xoSplatFade.value.toArray(), view: m.viewDistance, errors: m.loading.errors }; })()`);
  ok(b.arrays.every((a) => a.compressed) && b.kinds.every((k) => k !== 'rgba') && b.slice === 2048 && b.arrays[0].size === 2048 && b.arrays[1].size === 2048,
    `bridge's surfaces: albedo, normal and gloss arrays of the game's blocks at its slice size ${b.slice} (${b.arrays.map((a) => a.size).join(' / ')} px)`);
  ok(b.aniso === b.want && b.want >= 8, `the arrays are filtered anisotropically (${b.aniso}x)`);
  const used = b.surfaces.filter((s) => s.name); // (2.41's bridge: 15 slots, two of them empty)
  ok(used.length >= 10 && used.every((s) => s.n && s.g) && used.some((s) => s.blend >= 8) && b.hb > 0,
    `every surface brings its normal and gloss map; height blending on (${used.map((s) => `${s.name.split('/').pop()} ${s.blend}`).join(', ')})`);
  const scrap = used.find((s) => /\/scrapmetal$/.test(s.name));
  ok(scrap && scrap.amp > 0.05, `the scrap heaps are a displaced surface (${scrap?.amp} m)`);
  ok(b.key === 'xo-terrain-2' && b.orm, 'the terrain shader, and the bake\'s occlusion / roughness / metal beyond the surfaces');
  ok(Math.abs(b.fade[1] - b.view) < 1 && b.fade[0] < b.fade[1], `the surfaces reach the view distance (${b.fade[0]}..${b.fade[1]} m)`);
  ok(b.errors.length === 0, `bridge loads without problems (${b.errors.slice(0, 2).join(' | ')})`);
  await js(`window.__xo.maps.setViewDistance(1000)`);
  ok((await js(`${U}.xoSplatFade.value.y`)) === 1000, 'a shorter view distance takes the surfaces with it');
  await js(`window.__xo.maps.setViewDistance(${b.view})`);

  // the game's capture from bridge's light probe (664236, at -23.6, 18.8, 55.4) shows the sun glinting on
  // the wet riverbed ahead and below (panorama u 0.75): the gloss maps must put it there
  const C = [-23.64, 18.83, 55.38], th = (0.75 - 0.5) * 2 * Math.PI, pt = (-20 * Math.PI) / 180;
  await show(false, ['spawns']);
  await pose(C, [C[0] + Math.cos(th) * Math.cos(pt) * 50, C[1] + Math.sin(pt) * 50, C[2] + Math.sin(th) * Math.cos(pt) * 50]);
  const glint = await region(0.3, 0.55, 0.7, 0.85);
  await snap('01-bridge-glint');
  await js(`${U}.xoRoughMin.value = 1`);
  const matte = await region(0.3, 0.55, 0.7, 0.85);
  await js(`${U}.xoRoughMin.value = 0.05`);
  // (the game's tone curve takes the sunlit bed itself near white: the glint shows as white pixels)
  ok(glint.white > Math.max(0.003, matte.white * 3) && glint.p99 > 150, `the sun glints on the wet riverbed where the game's capture has it (white: ${(glint.white * 100).toFixed(2)} % of the region, all matte ${(matte.white * 100).toFixed(2)} %)`);

  // the relief: the same ground with flat normals has less detail
  await show(false);
  const gx = 189, gz = 31; // (bridge's scrap heaps by the river)
  const gy = await js(`window.__xo.maps.heightAt(${gx}, ${gz})`);
  await pose([gx - 6, gy + 2.5, gz - 6], [gx + 4, gy, gz + 4]);
  const relief = await region(0.1, 0.5, 0.9, 0.95);
  await snap('02-bridge-relief');
  await js(`(async () => { const T = await import('three'); const u = ${U}; window.__keepN = u.xoSurfN.value;
    const t = new T.DataArrayTexture(new Uint8Array([255, 128, 255, 128]), 1, 1, 1); t.needsUpdate = true; u.xoSurfN.value = t; window.__flatN = t; })()`);
  const flat = await region(0.1, 0.5, 0.9, 0.95);
  await js(`(() => { ${U}.xoSurfN.value = window.__keepN; window.__flatN.dispose(); })()`);
  ok(relief.detail > flat.detail * 1.15, `the normal maps give the ground its relief (detail ${relief.detail.toFixed(2)}, flat normals ${flat.detail.toFixed(2)})`);
  // parallax: the scrap heaps in depth (their relief off: a different picture)
  await region(0.1, 0.5, 0.9, 0.95);
  await js(`(() => { window.__amp = [...${U}.xoAmp.value]; ${U}.xoAmp.value.fill(0); })()`);
  const noPom = await region(0.1, 0.5, 0.9, 0.95);
  await js(`(() => { const a = ${U}.xoAmp.value; window.__amp.forEach((v, i) => (a[i] = v)); })()`);
  ok(noPom.diff > 2, `displaced surfaces are drawn in depth near the camera (without: the picture changes by ${noPom.diff.toFixed(1)} a pixel)`);

  // the terrain's cost: a low view along the ground, the terrain alone (render + read back)
  const ms = await js(`(() => { const m = window.__xo.maps, v = m.v, c = m.centre, y = m.groundOr(c.x, c.z, 0), T = v.camera.position.constructor;
    m.fly.setPose(new T(c.x, y + 3, c.z), new T(c.x + 100, y + 1, c.z + 30)); m.tick();
    const gl = v.renderer.getContext(), px = new Uint8Array(4), t = [];
    v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); v.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); t.push(performance.now() - t0); }
    return t.sort((a, b) => a - b)[10]; })()`);
  ok(ms < 40, `the terrain draws in ${ms.toFixed(1)} ms a frame (low over bridge, the terrain alone)`);
  await show(true);

  // ---- the weather's cover: New Year's snow over bridge; the dull day without rain stays dry ----
  await open('bridge', '216895'); // (xmass)
  await show(false);
  await pose([gx - 30, gy + 12, gz - 30], [gx, gy, gz]);
  const d = await js(`${U}.xoDust.value.toArray()`);
  const snow = await region(0.1, 0.55, 0.9, 0.95);
  await snap('03-bridge-snow');
  await js(`${U}.xoDust.value.z = 0`);
  const bare = await region(0.1, 0.55, 0.9, 0.95);
  await js(`${U}.xoDust.value.z = ${d[2]}`);
  ok(d[2] > 0 && snow.mean > bare.mean * 1.3, `xmass covers bridge's ground in snow (mean ${snow.mean.toFixed(0)}, without ${bare.mean.toFixed(0)})`);
  await js(`window.__xo.maps.setShow('sky', false)`);
  ok((await js(`${U}.xoDust.value.z`)) === 0, 'without the weather shown, no cover');
  await js(`window.__xo.maps.setShow('sky', true)`);
  await open('bridge', '829134');
  // cloudy: no snow, Crossout 2.41's film low down alone (all over below its band, none from its top)
  const film = await js(`({ d: ${U}.xoDust.value.toArray(), band: ${U}.xoDustBand.value.toArray() })`);
  ok(film.d[3] === 2 && film.band[0] === 10 && film.band[1] === 20, `cloudy: no snow, the film low down alone (by height: all over below ${film.band[0]} m, none from ${film.band[1]} m)`);
  await show(false);
  const spots = await js(`(() => { const m = window.__xo.maps; let low = null, high = null;
    for (let r = 10; r < 800 && !(low && high); r += 10) for (let a = 0; a < 6.283 && !(low && high); a += 0.15) {
      const x = ${gx} + r * Math.cos(a), z = ${gz} + r * Math.sin(a), h = m.heightAt(x, z);
      if (!Number.isFinite(h) || m.waterOver(x, z)) continue;
      if (!low && h > 5.5 && h < 8) low = [x, h, z];
      if (!high && h > 30 && h < 60) high = [x, h, z];
    }
    return { low, high }; })()`);
  // the ground straight down from 10 m over a spot, with the film and without (its strength 0)
  const filmAt = async (p) => {
    await pose([p[0], p[1] + 10, p[2] + 0.01], [p[0], p[1], p[2]]);
    const on = await region(0.3, 0.3, 0.7, 0.7);
    await js(`${U}.xoDust.value.z = 0`);
    const off = await region(0.3, 0.3, 0.7, 0.7);
    await js(`${U}.xoDust.value.z = ${film.d[2]}`);
    return on.mean / Math.max(off.mean, 1e-6);
  };
  const lowR = spots.low ? await filmAt(spots.low) : null, highR = spots.high ? await filmAt(spots.high) : null;
  ok(lowR !== null && highR !== null && lowR < 0.99 && Math.abs(highR - 1) < 0.01,
    `the film darkens the ground ${spots.low?.[1].toFixed(1)} m up (x ${lowR?.toFixed(3)}), not ${spots.high?.[1].toFixed(1)} m up (x ${highR?.toFixed(3)})`);
  await show(true);

  // ---- maps that blend linearly, detail sets, lent textures ----
  await open('arena_plaza');
  const p = await js(`(() => ({ hb: window.__xo.maps.splat.head.heightBlend, blend: ${U}.xoBlend.value.slice(0, window.__xo.maps.splat.head.surfaces.length).map((v) => v.x) }))()`);
  // (Crossout 2.41's arena_plaza blends by height, and no map of 2.41's turns it off: then it is said)
  if (p.hb === 0) ok(p.blend.every((x) => x === 0), 'arena_plaza (LandscapeHeightBlendEnabled false) blends its surfaces by their weights alone');
  else ok(p.blend.some((x) => x > 0), 'arena_plaza blends by height since Crossout 2.41 (no map of 2.41 blends by weights alone: not checked)');
  await open('arena_football_old');
  const dt = await js(`(() => { const u = ${U}, h = window.__xo.maps.splat.head; return { detail: h.surfaces.map((s) => !!s.detail), set: u.xoSet.value[32].toArray(), noise: !!u.xoNoise.value }; })()`);
  ok(dt.detail[0] && dt.set[1] >= 0 && Math.abs(dt.set[0] - 1 / 20.2) < 1e-4 && dt.noise, `icethick's detail set (20.2 m) mixed in by the splat noise`);
  await open('hangar_newyear');
  const hn = await js(`(() => { const m = window.__xo.maps, ss = m.splat.head.surfaces; return { lent: ss.filter((s) => s.standIn === 'snow/snow1').length, note: m.loading.errors.find((e) => /snow\\/snow1/.test(e)) || '', arrays: m.splat.arrays,
    own: ss.filter((s) => /snow(crust|melt|flat)$/.test(s.name) && !s.standIn && s.normal).length }; })()`);
  // (2.40's files lacked its snow, lent snow/snow1's; 2.41's have it)
  ok((hn.lent === 3 && /snowcrust/.test(hn.note)) || (hn.lent === 0 && !hn.note && hn.own === 3),
    hn.lent ? `hangar_newyear's snow (not in the readable files) shown with snow/snow1's textures, and said so ("${hn.note.slice(0, 80)}…")` : `hangar_newyear's snow surfaces bring their own textures (${hn.own} of snowcrust, snowmelt, snowflat)`);
  await show(false, ['props', 'trees', 'objects', 'grass', 'decals', 'spawns', 'water']);
  await js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor, y = m.groundOr(40, -50, 0); m.fly.setPose(new T(30, y + 25, -40), new T(60, y, -70)); m.needsBucket = true; })()`);
  const white = await region(0.1, 0.5, 0.9, 0.95);
  await snap('04-hangar-newyear');
  ok(white.mean > 150 && white.sat < 30, `its ground is snow (mean ${white.mean.toFixed(0)}, saturation ${white.sat.toFixed(0)})`);
  await show(true, ['props', 'trees', 'objects', 'grass', 'decals', 'spawns', 'water']);

  // ---- a GPU without BC textures: the arrays decoded by the host ----
  await js(`window.__xo.viewer.support.s3tc = false`);
  await open('arena_football');
  const fb = await js(`(() => ({ arrays: window.__xo.maps.splat.arrays, kinds: [${U}.xoSurf.value, ${U}.xoSurfN.value].map((t) => !!t.isDataArrayTexture), errors: window.__xo.maps.loading.errors }))()`);
  await js(`window.__xo.viewer.support.s3tc = true`);
  ok(fb.arrays.every((a) => !a.compressed && a.size <= 1024) && fb.kinds.every(Boolean) && fb.errors.length === 0, `without BC textures the arrays are plain RGBA (${fb.arrays.map((a) => a.size).join(' / ')} px)`);
  await open('arena_football');
  ok((await js(`window.__xo.maps.splat.arrays.every((a) => a.compressed)`)), 'and the game\'s blocks again where the GPU takes them');

  // ---- the export: the terrain's relief and roughness baked beside its colour ----
  const glb = path.join(outDir, 'arena_football_terrain.glb');
  await js(`window.__xo.call('exportMap', { name: 'arena_football', festival: 'Empty', gameplay: 'auto', format: 'glb', ao: true, terrain: true, ground: 512, props: false, trees: false, objects: false, water: false, lod: 3, textures: true, maxTex: 128,
    decals: false, grass: false, sun: false, sky: false, outPath: ${JSON.stringify(glb)} })`);
  const gj = (() => { const buf = fs.readFileSync(glb); return JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12))); })();
  const tm = gj.materials.find((x) => x.name === 'terrain');
  const img = (t) => gj.images[gj.textures[t.index].source].name;
  ok(tm?.normalTexture && tm.pbrMetallicRoughness?.metallicRoughnessTexture && tm.occlusionTexture && img(tm.normalTexture) === 'terrain_ground_n.png' && img(tm.occlusionTexture) === 'terrain_ground_orm.png' &&
    tm.pbrMetallicRoughness.roughnessFactor === 1, `the exported terrain carries its relief (${tm && img(tm.normalTexture)}) and occlusion / roughness / metal (${tm && img(tm.occlusionTexture)})`);
  const v = validate(glb);
  ok(v.startsWith('ok'), 'the terrain GLB validates: ' + v.split('\n')[0]);

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
