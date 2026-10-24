// End-to-end test of the maps' light from the game's own light probes: /mapprobe (the capture, its
// irradiance and sky, the probe's place; the glint of the sun on the river where the preset puts the
// sun), the map lit by it (the environment map at the game's exposure, a mirror ball reflecting the
// capture the right way round, the diffuse light from its irradiance, the sun in the same units),
// the game's camera after it (white balance, tone curve, colour LUT: only in Maps), another weather
// fetching its own probe (an overcast held at its MinEV100, a night's moon), a sky without a probe,
// leaving Maps (the garage's light and camera back), the export's sun and sky .hdr in the same units,
// a hangar's hall lit by its local probe, and the frame time on a big map.
//   node tools/e2e_look_ibl.mjs [--snap-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const MAP = 'bridge';

const app = await launch({ prefix: 'xo-e2e-ibl-' });
const { js, waitFor, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const loaded = () => waitFor('window.__xo.maps.scene && window.__xo.maps.loading && window.__xo.maps.loading.finished && document.getElementById("busy").hidden', 240000);
const open = async (name, environment = '') => {
  await js(`window.__xo.openMap(${JSON.stringify(name)}${environment ? `, { environment: ${JSON.stringify(environment)} }` : ''}).then(() => true)`);
  await loaded();
  await waitFor('!!window.__xo.maps.sky && window.__xo.maps.sky.ready', 60000);
};
// the light the view has now (sky.js levels, viewer.js IRRADIANCE, post.js grade)
const light = () => js(`(async () => { const { IRRADIANCE } = await import('./viewer.js'); const { SUN_K } = await import('./sky.js'); const xo = window.__xo, v = xo.viewer, s = xo.maps.sky, k = v.key;
  return { env: xo.maps.env.id, probe: !!s.probe, mean: s.probe?.mean, ev: s.levels.ev, exposure: s.levels.exposure, envIs: v.scene.environment === s.envMap, envI: v.scene.environmentIntensity,
    irr: IRRADIANCE[0].toArray(), keyLum: k.intensity * (0.2126 * k.color.r + 0.7152 * k.color.g + 0.0722 * k.color.b), keyI: k.intensity, eSun: s.levels.eSun, grade: !!v.post.grade, toe: v.post.grade?.toe,
    lutW: v.post.grade?.lut.image.width, horizon: s.horizon.toArray(), level: s.level, sunK: SUN_K }; })()`);
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);
  await open(MAP);
  const q = await js('window.__xo.maps.query');

  // ---- /mapprobe ----
  const pr = await js(`(async () => { const { fetchProbe, sunDirection } = await import('./sky.js'); const p = await fetchProbe(${JSON.stringify(q)});
    const H = (x) => { const e = (x >> 10) & 31, m = x & 1023; return e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15); };
    const [w, h] = p.specular; let best = -1, bu = 0, bv = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const o = (j * w + i) * 4, l = 0.2126 * H(p.specularData[o]) + 0.7152 * H(p.specularData[o + 1]) + 0.0722 * H(p.specularData[o + 2]); if (j < h / 2 && l > best) { best = l; bu = (i + 0.5) / w; bv = (j + 0.5) / h; } }
    const sun = sunDirection(window.__xo.maps.env.values, window.__xo.maps.env.rotation), su = Math.atan2(sun.z, sun.x) / (2 * Math.PI) + 0.5;
    return { id: p.id, center: p.center, envColor: p.envColor, mean: p.mean, local: p.local, spec: p.specular, diff: p.diffuse, sky: p.sky, lens: [p.specularData.length, p.diffuseData.length, p.skyData.length], glint: [bu, bv, best], sunU: su }; })()`);
  ok(pr.spec[0] === 1024 && pr.spec[1] === 512 && pr.diff[0] === 64 && pr.sky[0] === 128 && pr.lens[0] === 1024 * 512 * 4 && pr.lens[1] === 64 * 32 * 4 && pr.lens[2] === 128 * 64 * 4,
    `/mapprobe: the capture as a ${pr.spec.join(' x ')} panorama, its irradiance ${pr.diff.join(' x ')}, its sky ${pr.sky.join(' x ')} (RGBA halves)`);
  ok(Math.abs(pr.center[0] + 25) < 0.01 && Math.abs(pr.center[2] - 78.5) < 0.01 && Math.abs(pr.mean - 1.095) < 0.02 && pr.local === 0,
    `the bridge's global probe at ${pr.center.map((x) => x.toFixed(2)).join(', ')} (glTF), luminance ${pr.mean.toFixed(3)} on average, no local one`);
  const du = Math.abs(((pr.glint[0] - pr.sunU + 1.5) % 1) - 0.5);
  ok(du < 0.02 && pr.glint[1] < 0.5, `the sun's glint on the river lies under the preset's sun (u ${pr.glint[0].toFixed(3)} against ${pr.sunU.toFixed(3)}): the capture is turned right`);

  // ---- the bridge's clear day lit by it ----
  const day = await light();
  ok(day.probe && day.envIs && Math.abs(day.envI - day.exposure) < 1e-9 && day.ev === 5.75,
    `lit by its probe at the game's exposure: EV100 ${day.ev.toFixed(2)} (held at its 12.75, lux / 128), x ${day.exposure.toFixed(3)} on the probe`);
  ok(lum(day.irr) > 0.5, `the diffuse light comes from the probe's irradiance (${day.irr.map((x) => x.toFixed(2)).join(', ')})`);
  // (x SUN_K: the share of the preset's sun the probes' own captures show on their sunlit ground)
  ok(Math.abs(day.keyLum - (day.eSun / 16) * day.exposure * day.sunK) < 1e-3 && Math.abs(day.eSun - 475.51) < 0.1 && day.sunK > 0.7 && day.sunK < 0.9,
    `the sun in the same units: ${day.eSun.toFixed(1)} game units (its light's 135000 lux x 0.552 x its tint / 128) / 16 x the exposure x ${day.sunK} (as the captures show it) = ${day.keyLum.toFixed(2)} in the view`);
  ok(day.grade && day.lutW === 256 && Math.abs(day.toe - 0.01) < 1e-9, `the game's camera: white balance, toe ${day.toe}, its colour LUT (${day.lutW} x 16)`);
  const lut = await js(`(() => { const d = window.__xo.viewer.post.grade.lut.image.data; let diff = 0; for (let i = 0; i < 256 * 16; i++) diff += Math.abs(d[i * 4] - (i % 16) * 17); return diff / 4096; })()`);
  ok(lut > 1, `the colour LUT (textures/posteffects/colorgrading) is no identity: red moves ${lut.toFixed(1)} steps on average`);
  // a mirror ball at the probe's centre reflects the capture the right way round: towards the glint
  // it shows the glint, half a turn away the darker land
  const el = (pr.glint[1] - 0.5) * Math.PI;
  const mirror = await js(`(async () => {
    const THREE = await import('three'), xo = window.__xo, v = xo.viewer, m = xo.maps, c = m.sky.probe.center;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 32), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0 }));
    ball.position.set(c[0], c[1], c[2]);
    v.mapRoot.add(ball);
    const seen = (u, el) => { const ph = (u - 0.5) * 2 * Math.PI, d = new THREE.Vector3(Math.cos(ph) * Math.cos(el), Math.sin(el), Math.sin(ph) * Math.cos(el));
      m.fly.setPose(ball.position.clone().addScaledVector(d, 2.5), ball.position.clone()); v.render();
      const g = v.renderer.getContext(), px = new Uint8Array(4); g.readPixels(g.drawingBufferWidth >> 1, g.drawingBufferHeight >> 1, 1, 1, g.RGBA, g.UNSIGNED_BYTE, px);
      return 0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]; };
    try { return { glint: seen(${pr.glint[0]}, ${el}), away: seen(${pr.glint[0] + 0.5}, ${el}) }; } finally { ball.removeFromParent(); ball.geometry.dispose(); ball.material.dispose(); }
  })()`);
  ok(mirror.glint > 200 && mirror.glint > mirror.away * 1.5, `a mirror ball at the probe reflects its glint where the capture has it (${mirror.glint.toFixed(0)} against ${mirror.away.toFixed(0)} half a turn away)`);
  // warm sunlit ground under a blue sky (the old sky-only light left a blue-white veil on everything)
  await js(`window.__xo.maps.goTo('start')`);
  await sleep(2500);
  const px = await js(`(() => { const c = document.getElementById('view'), g = c.getContext('webgl2'), w = g.drawingBufferWidth, h = g.drawingBufferHeight; window.__xo.viewer.render();
    const read = (y0, y1) => { const n = (y1 - y0) * w, p = new Uint8Array(4 * n); g.readPixels(0, y0, w, y1 - y0, g.RGBA, g.UNSIGNED_BYTE, p); const s = [0, 0, 0]; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) s[k] += p[i * 4 + k] / n; return s; };
    return { ground: read(Math.round(h * 0.05), Math.round(h * 0.3)), sky: read(Math.round(h * 0.8), Math.round(h * 0.95)) }; })()`);
  ok(px.ground[0] > px.ground[2] * 1.15 && px.sky[2] > px.sky[0], `sunlit ground warm (${px.ground.map((x) => x.toFixed(0)).join(' ')}), sky blue (${px.sky.map((x) => x.toFixed(0)).join(' ')})`);
  await snap('01-bridge-day');

  // ---- another weather: its own probe ----
  await open(MAP, '829134');
  const dull = await light();
  ok(dull.env === '829134' && dull.probe && Math.abs(dull.mean - pr.mean) > 0.5 && dull.ev === 0.25 && dull.keyLum < day.keyLum * 0.2,
    `weather "Cloudy" fetches its own probe (luminance ${dull.mean.toFixed(4)}), held at its EV100 (${dull.ev}: 7.25 - 7), next to no sun (${dull.keyLum.toFixed(2)})`);
  await open(MAP, '181044');
  const night = await light();
  ok(night.ev === 0.5 && lum(night.horizon) < lum(day.horizon) && night.level < day.level && night.keyLum < day.keyLum * 0.35,
    `Halloween's night: held at EV100 ${night.ev} (7.5 - 7), a darker sky (${lum(night.horizon).toFixed(3)} against the day's ${lum(day.horizon).toFixed(3)}), no sun (${night.keyLum.toFixed(2)}), the light level of a night (${night.level.toFixed(2)} against ${day.level.toFixed(2)})`);
  await snap('02-bridge-halloween');
  await open(MAP, '447082');
  const back = await light();
  ok(Math.abs(back.keyLum - day.keyLum) < 1e-6 && Math.abs(back.exposure - day.exposure) < 1e-9, 'back on the clear day: the same light again');

  // ---- a sky without a probe: the atmosphere lights the map, metered from it ----
  const bare = await js(`(async () => { const { GameSky } = await import('./sky.js'); const xo = window.__xo, s = new GameSky(xo.viewer, { getInfo: xo.maps.getInfo });
    try { await s.load({ ...xo.maps.env, values: { ...xo.maps.env.values, SkyDomeModelPath: '' } }, null); // (no clouds: it goes again at once)
       return { ev: s.levels.ev, exposure: s.levels.exposure, envMap: !!s.envMap, envI: s.envIntensity, irr: s.irradiance, sun: s.sunIntensity }; } finally { s.dispose(); } })()`);
  ok(bare.envMap && bare.envI === 1 && bare.irr === null && bare.ev === 5.75 && Math.abs(bare.sun / bare.exposure - day.keyI / day.exposure) < 0.5,
    `without a probe the sky lights it (metered at EV100 ${bare.ev.toFixed(2)}), three's own diffuse light, the same sun at that exposure`);

  // ---- leaving Maps: the garage's light and camera ----
  await js(`window.__xo.setView('part')`);
  await sleep(500);
  const part = await js(`(async () => { const { IRRADIANCE } = await import('./viewer.js'); const v = window.__xo.viewer; return { irr: IRRADIANCE.every((x) => x.length() === 0), grade: v.post.grade, tone: v.renderer.toneMapping }; })()`);
  ok(part.irr && part.grade === null && part.tone === 7, '3D Viewer: three\'s own diffuse light and its Neutral tone curve again (no map grade)');
  await js(`window.__xo.setView('map')`);
  await sleep(800);
  const again = await light();
  ok(again.grade && lum(again.irr) > 0.5, 'back in Maps: the probe\'s light and the game\'s camera again');

  // ---- the export: the sun and the sky .hdr in the same units ----
  const glb = path.join(outDir, `${MAP}_light.glb`);
  const r = await js(`window.__xo.call('exportMap', { name: ${JSON.stringify(MAP)}, festival: 'Empty', gameplay: 'Assault', format: 'glb', terrain: false, props: false, trees: false, objects: true, water: false, lod: 3, textures: false,
    decals: false, grass: false, sun: true, sky: true, skySize: 1024, outPath: ${JSON.stringify(glb)} })`);
  const j = (() => { const b = fs.readFileSync(glb); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const sunL = j.extensions?.KHR_lights_punctual?.lights?.[0];
  const hdr = r.files.find((f) => /_sky\.hdr$/.test(f));
  const head = hdr ? fs.readFileSync(hdr).subarray(0, 120).toString('latin1') : '';
  ok(sunL && Math.abs(sunL.intensity * lum(sunL.color) - day.keyLum) < 0.05 && /EV100 5\.75/.test(j.asset?.extras?.exposure || '') && /-Y 512 \+X 1024/.test(head),
    `exported: the sun as the view has it (${sunL?.intensity.toFixed(2)}), the exposure noted (${j.asset?.extras?.exposure}), the probe's sky .hdr`);

  // ---- a hangar: its local probe (inside the hall) beside the global one ----
  await open('hangar');
  const hangar = await js(`(async () => { const r = await fetch('https://xo.data/mapprobe?' + window.__xo.maps.query + '&probe=1'); if (!r.ok) return { status: r.status }; const b = await r.arrayBuffer(); const jl = new DataView(b).getUint32(4, true); return JSON.parse(new TextDecoder().decode(new Uint8Array(b, 8, jl))); })()`);
  ok(hangar.halfMax && hangar.halfMax[0] > 5 && hangar.local === 1, `a hangar's local probe has a real box (half extents up to ${hangar.halfMax?.map((x) => x.toFixed(1)).join(' x ')} m)`);
  // inside its hall the hall's own (darker) capture lights and is mirrored, not the open sky's
  const hall = await js(`(async () => { const { LOCAL_PROBE } = await import('./viewer.js'); const xo = window.__xo, v = xo.viewer, m = xo.maps, c = ${JSON.stringify(hangar.center)}, T = v.camera.position.constructor;
    m.fly.setPose(new T(c[0], c[1] + 2, c[2]), new T(c[0] + 20, c[1], c[2])); m.needsBucket = true;
    await new Promise((r) => setTimeout(r, 1500));
    const g = v.renderer.getContext(), mean = () => { v.render(); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(w * h * 4); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); let s = 0; for (let i = 0; i < px.length; i += 4) s += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]; return s / (w * h); };
    const on = { local: !!m.sky.local, flag: LOCAL_PROBE.on.value, lit: mean() };
    LOCAL_PROBE.on.value = 0; on.open = mean(); LOCAL_PROBE.on.value = 1;
    return on; })()`);
  ok(hall.local && hall.flag === 1 && hall.lit < hall.open * 0.9, `inside the hangar its hall's probe lights it (view ${hall.lit.toFixed(1)} against ${hall.open.toFixed(1)} with the open sky's)`);
  await snap('03-hangar-hall');

  // ---- frame time on a big map with everything on ----
  await open('fuji'); // (red_rocks_territory is gone since Crossout 2.41)
  await js(`window.__xo.maps.goTo('overview')`);
  await sleep(3000);
  const ft = await js(`(() => { const v = window.__xo.viewer, g = v.renderer.getContext(); v.render(); g.finish(); const t0 = performance.now(); for (let i = 0; i < 10; i++) v.render(); g.finish(); return (performance.now() - t0) / 10; })()`);
  ok(ft < 60, `fuji overview: ${ft.toFixed(1)} ms a frame`);
  await snap('04-red-rocks');

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
