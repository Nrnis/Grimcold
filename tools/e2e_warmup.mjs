// End-to-end checks of Maps' shaders built ahead (ui/warmup.js): a map's shader recipes kept once it is
// in; after a restart (the GPU's own shader cache emptied, as an update that changes the shaders
// leaves it) the garage builds them while the app is idle, none while the mouse is busy, then opening
// the map asks for no shader that was not built ahead (three's cache keys: the same sources, which the
// GPU's cache keeps), and it waits on far fewer builds than the first time.
//   node tools/e2e_warmup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const MAP = 'bridge';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-e2e-warmup-'));

// The shaders the map's materials draw with now (made by makeMaterial, or the ground, water and
// decals: those with a recipe), three's cache keys.
const mapKeys = (js) => js(`(() => { const R = window.__xo.viewer.renderer, keys = new Set();
  window.__xo.maps.root.traverse((o) => { const m = o.material; if (!o.isMesh || !m || Array.isArray(m) || (!m.userData.warmKind && (!m.userData.xo?.info || m.userData.xo.lamp))) return;
    const p = R.properties.get(m).currentProgram; if (p) keys.add(p.cacheKey); });
  return [...keys]; })()`);
// Opens the map; resolves to the time the page spent waiting on shader builds while it came in.
const openMap = async ({ js, waitFor }) => {
  await js(`(() => { const r = window.__xo.viewer.renderer, gl = r.getContext(); window.__buildWait = 0;
    if (!window.__waitHook) { window.__waitHook = true; const seen = new WeakSet(), f = gl.getProgramInfoLog.bind(gl);
      gl.getProgramInfoLog = (p) => { if (seen.has(p)) return f(p); seen.add(p); const t0 = performance.now(), v = f(p); window.__buildWait += performance.now() - t0; return v; }; } })()`);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);
  await js(`window.__xo.openMap(${JSON.stringify(MAP)})`);
  await waitFor(`window.__xo.maps.scene?.name === ${JSON.stringify(MAP)} && window.__xo.maps.loading?.finished`, 600000);
  await sleep(2000);
  return js('window.__buildWait');
};

let app = await launch({ dataDir: dir });
try {
  let { js, waitFor } = app;
  await waitFor('window.__xoReady === true', 120000);
  ok((await js('window.__xo.warmup().left')) === 0, 'a new profile has no shaders to build ahead');
  const wait1 = await openMap(app);
  const keys1 = await mapKeys(js);
  await waitFor(`JSON.parse(localStorage.getItem('xo.mapShaders.v1') || '[]').length > 0`, 30000).catch(() => {});
  const kept = await js(`JSON.parse(localStorage.getItem('xo.mapShaders.v1') || '[]').length`);
  ok(kept >= keys1.length && keys1.length > 10, `the map's shader recipes are kept once it is in (${kept} recipes for the ${keys1.length} shaders its materials draw with)`);
  await app.close({ keep: true });

  // ---- a restart, with the GPU's cache gone (as an update that changes the shaders leaves it) ----
  fs.rmSync(path.join(dir, 'WebView2', 'EBWebView', 'Default', 'GPUCache'), { recursive: true, force: true });
  app = await launch({ dataDir: dir });
  ({ js, waitFor } = app);
  await waitFor('window.__xoReady === true', 120000);
  ok((await js('window.__xo.warmup().left')) === kept, `the garage has them to build (${await js('window.__xo.warmup().left')})`);
  // the mouse moving over the app: nothing built (a build holds the GPU up to 0.8 s)
  const left0 = await js('window.__xo.warmup().left');
  for (let i = 0; i < 40; i++) { await app.mouse('mouseMoved', 600 + (i % 20) * 10, 400); await sleep(100); }
  ok((await js('window.__xo.warmup().left')) === left0, 'none is built while the mouse moves over the app');
  const t0 = Date.now();
  await waitFor('window.__xo.warmup().left === 0', 300000);
  const built = await js('window.__xo.warmup().built');
  ok(built.length === kept, `once it is idle, all are built (${built.length} in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  const wait2 = await openMap(app);
  const keys2 = await mapKeys(js);
  const missing = keys2.filter((k) => !built.includes(k));
  ok(keys2.length > 10 && missing.length === 0, `the map asks for no shader that was not built ahead (${keys2.length - missing.length} of ${keys2.length})`);
  const kinds = await js(`(() => { const k = new Set(); window.__xo.maps.root.traverse((o) => { if (o.material?.userData?.warmKind) k.add(o.material.userData.warmKind); }); return [...k].sort(); })()`);
  ok(['decal', 'terrain', 'under', 'water'].every((k) => kinds.includes(k)), `the ground, the water (and its underside) and the decals among them (${kinds.join(', ')})`);
  ok(wait2 < wait1 / 3, `opening it waits on shader builds ${(wait2 / 1000).toFixed(1)} s, against ${(wait1 / 1000).toFixed(1)} s the first time`);
  ok(app.errors.length === 0, `no page errors (${app.errors.slice(0, 2).join(' | ').slice(0, 300)})`);
} catch (e) {
  ok(false, 'run: ' + e.message);
} finally {
  await app.close();
  await removeDir(dir);
}
console.log(failures ? `${failures} FAILED` : 'all passed');
process.exit(failures ? 1 : 0);
