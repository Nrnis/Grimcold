// End-to-end test of Maps' air and light: the game's height fog (the preset's density, falloff,
// altitude, start distance and colour on every material, the sky and the far scenery, no white wall
// at the view distance, which reaches the backdrop mountains; a sandstorm's fog below the ground's
// height; the map's particles in it), the sun's shadows over the whole view (cascades, only the ones
// the camera moved drawn again, shadows far out, none where the weather turns them off, the garage's
// own shadow back), the light the terrain's hills leave it (the host's bake on the terrain), the
// bloom, lens dirt and light shafts towards the sun (Maps only), the sky picture's drift, and a sky
// worked out from its air.
//   node tools/e2e_look_atmos.mjs [--snap-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-atmos-' });
const { js, waitFor, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const settle = async (ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const n = await js(`(() => { let n = 0; for (const c of [window.__xo.viewer.tex, window.__xo.viewer.geo]) c.map.forEach((e) => { if (e && !e.value) n++; }); return n; })()`).catch(() => 0);
    if (!n) break;
    await sleep(300);
  }
  await frames(4);
};
const open = async (name, environment = '') => {
  await js(`window.__xo.openMap(${JSON.stringify(name)}${environment ? `, { environment: ${JSON.stringify(environment)} }` : ''})`);
  await waitFor(`!!(window.__xo.maps.scene && window.__xo.maps.scene.name === ${JSON.stringify(name)} && window.__xo.maps.loading && window.__xo.maps.loading.finished && window.__xo.maps.sky && window.__xo.maps.sky.ready)`, 300000);
  await settle();
};
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; })()`);
// the drawn picture (the canvas): mean colour of a box (fractions of the canvas, y from the top) and
// how many of its pixels are almost white
const region = (x0, y0, x1, y1) => js(`(() => { const c = document.getElementById('view'), g = c.getContext('webgl2'); window.__xo.viewer.render();
  const W = g.drawingBufferWidth, H = g.drawingBufferHeight, x = Math.round(W * ${x0}), w = Math.max(1, Math.round(W * (${x1} - ${x0}))), y = Math.round(H * (1 - ${y1})), h = Math.max(1, Math.round(H * (${y1} - ${y0})));
  const px = new Uint8Array(w * h * 4); g.readPixels(x, y, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
  let r = 0, gg = 0, b = 0, white = 0; for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; if (px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235) white++; }
  const n = px.length / 4; return { r: r / n, g: gg / n, b: b / n, white: white / n }; })()`);
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
// the shadow map's work: how many times it was drawn, how many cascades in all
const countShadows = () => js(`(() => { const v = window.__xo.viewer, sm = v.renderer.shadowMap;
  if (!sm.xoCounted) { const orig = sm.render; sm.render = function (...a) { if (sm.needsUpdate) { window.__shadowRuns = (window.__shadowRuns || 0) + 1; window.__shadowCascades = (window.__shadowCascades || 0) + v.key.shadow.getViewportCount(); } return orig.apply(this, a); }; sm.xoCounted = true; }
  window.__shadowRuns = 0; window.__shadowCascades = 0; })()`);

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- bridge, a clear day (664236): the fog as the preset sets it ----
  await open('bridge');
  // (fog.js FOG_DENSITY_K, FOG_START_ADD: the land in the game's own captures has the fog thinner and
  // starting further out than the preset's numbers say; AIR_K: the air's haze over FogAerialGain x the way)
  const fog = await js(`(async () => { const F = await import('./fog.js'); const { FOG } = F; const THREE = await import('./lib/three/three.module.min.js'); const v = window.__xo.viewer, m = window.__xo.maps, vals = m.env.values;
    return { a: { ...FOG.a }, b: { ...FOG.b }, color: { ...FOG.color }, airK: { ...FOG.airK }, air: Array.from(FOG.air.slice(0, 3)), k: { dens: F.FOG_DENSITY_K, start: F.FOG_START_ADD, air: F.AIR_K },
      vals: { d: +vals.FogDensity, k: +vals.FogExpMul, h: +vals.FogHeight, near: +vals.FogNear, sunNear: +vals.FogSunNear, power: +vals.FogSunPower, gain: +vals.FogAerialGain,
        l0: String(vals.HeightFog0 || '').split(' ').map(Number), l1: String(vals.HeightFog1 || '').split(' ').map(Number), start: +vals.HeightFogStart },
      c: { ...FOG.c },
      sceneFog: v.scene.fog && { near: v.scene.fog.near, far: v.scene.fog.far }, view: m.viewDistance, far: v.camera.far, env: m.env.id,
      chunk: THREE.ShaderChunk.fog_fragment.includes('xoFogTo') && THREE.ShaderChunk.fog_fragment.includes('xoFogTint') && !THREE.ShaderChunk.fog_fragment.includes('fogFar * 0.8') }; })()`);
  const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b));
  // (Crossout 2.41: the scene's ExponentialHeightFog, its two layers as Map.cpp writes them)
  ok(fog.env === '447082' && fog.b.z === 1 && near(fog.a.x, fog.vals.l0[0]) && near(fog.a.y, fog.vals.l0[1]) && near(fog.a.z, fog.vals.l0[2]) && near(fog.a.w, fog.vals.start)
    && near(fog.c.x, fog.vals.l1[0]) && near(fog.c.y, fog.vals.l1[1]) && near(fog.c.z, fog.vals.l1[2]),
    `the fog is the scene's: ${fog.a.x.toExponential(2)} per metre at ${fog.a.z} m halving every ${(1 / fog.a.y).toFixed(0)} m up, and ${fog.c.x.toExponential(2)} at ${fog.c.z} m every ${(1 / fog.c.y).toFixed(0)} m, none thicker below; from ${fog.a.w} m out`);
  ok(fog.airK.w === 0, 'no air\'s haze of its own: the fog takes the sky\'s colour');
  ok(near(fog.b.x, fog.vals.start) && fog.b.y > 1 && fog.color.z > fog.color.y && fog.color.y > fog.color.x,
    `its glow towards the sun from ${fog.b.x} m (exponent ${fog.b.y.toFixed(1)}); its colour the sky's blue near the horizon (${[fog.color.x, fog.color.y, fog.color.z].map((v) => v.toFixed(2)).join(', ')})`);
  ok(fog.chunk && fog.sceneFog && fog.sceneFog.far === fog.view && fog.sceneFog.near === fog.vals.start && near(fog.far, fog.view * 1.05),
    `the fog chunks carry it (no fade-out at the view distance any more); scene.fog reaches the view distance ${fog.view} m`);
  // the view reaches what is placed: the backdrop mountains kilometres out
  const reach = await js(`(() => { const m = window.__xo.maps; let r = 0; for (const rec of m.models) if (rec.ready) for (let i = 0; i < rec.n; i++) r = Math.max(r, Math.hypot(rec.centers[i * 3], rec.centers[i * 3 + 2]) + rec.radii[i]); return { r, size: m.size }; })()`);
  ok(fog.view >= reach.r && fog.view > reach.size * 1.5, `the view distance (${fog.view} m) reaches the farthest thing placed (${reach.r.toFixed(0)} m from the middle; the terrain is ${reach.size} m)`);
  // from high up: the backdrop under haze, no white wall over it
  await js(`window.__xo.maps.goTo('overview')`);
  await settle(20000);
  const over = await region(0.05, 0.1, 0.95, 0.5);
  ok(over.white < 0.02, `seen from high up the far land is not a white wall (${(over.white * 100).toFixed(1)} % near-white pixels in the upper half)`);
  await snap('01-bridge-overview');

  // ---- the sun's shadows: cascades over the whole view ----
  const sh = await js(`(async () => { const { CSM } = await import('./shadows.js'); const v = window.__xo.viewer, s = v.key.shadow;
    return { cascades: s.cascades, radius: s.radius, map: s.map && [s.map.width, s.map.height], tile: s.tile, reach: [CSM.reach.x, CSM.reach.y, CSM.reach.z, CSM.reach.w], cast: v.key.castShadow, view: window.__xo.maps.viewDistance }; })()`);
  ok(sh.cascades === 4 && sh.radius < 0 && sh.map && sh.map[0] === sh.tile * 4 && sh.map[1] === sh.tile && sh.reach.every((r, k) => k === 0 || r > sh.reach[k - 1]) && sh.reach[3] === sh.view,
    `4 cascades in a ${sh.map?.join(' x ')} map, reaching ${sh.reach.map((r) => r.toFixed(0)).join(' / ')} m (the last the view distance)`);
  // far shadows: from high up, looking towards the sun (the shadows fall towards the camera), the far
  // half darker with shadows than without
  await js(`(() => { const m = window.__xo.maps, v = m.v, c = v.camera, T = c.position.constructor, s = v.keyDir, p = c.position.clone(), h = Math.hypot(s.x, s.z); m.fly.setPose(p, new T(p.x + (s.x / h) * 600, p.y - 350, p.z + (s.z / h) * 600)); m.needsBucket = true; })()`);
  await settle(20000);
  const shotsOn = await js(`(() => { const c = document.getElementById('view'), g = c.getContext('webgl2'), v = window.__xo.viewer; v.shadowDirty = true; v.render();
    const W = g.drawingBufferWidth, H = g.drawingBufferHeight, px = new Uint8Array(W * H * 4); g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px); window.__on = px; return [W, H]; })()`);
  await js(`window.__xo.viewer.setShadows(false)`);
  await frames(3);
  const shadowed = await js(`(() => { const c = document.getElementById('view'), g = c.getContext('webgl2'), v = window.__xo.viewer; v.render();
    const W = g.drawingBufferWidth, H = g.drawingBufferHeight, px = new Uint8Array(W * H * 4); g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    let dark = 0, n = 0; for (let y = Math.round(H * 0.5); y < Math.round(H * 0.85); y++) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4; const a = window.__on[i] + window.__on[i + 1] + window.__on[i + 2], b = px[i] + px[i + 1] + px[i + 2]; n++; if (a < b * 0.95) dark++; }
    return dark / n; })()`);
  await js(`window.__xo.viewer.setShadows(true)`);
  ok(shadowed > 0.02, `shadows far out: from high up ${(shadowed * 100).toFixed(1)} % of the far half of the view lies in shadow`);
  // only what moved is drawn again: none while still, a cascade now and then while flying
  await js(`window.__xo.maps.goTo('start')`);
  await settle(20000);
  await countShadows();
  await js(`(() => { const v = window.__xo.viewer; for (let i = 0; i < 20; i++) v.render(); })()`);
  const still = await js('[window.__shadowRuns, window.__shadowCascades]');
  await countShadows();
  await js(`(() => { const v = window.__xo.viewer, m = window.__xo.maps, c = v.camera; for (let i = 0; i < 40; i++) { c.position.x += 0.4; c.updateMatrixWorld(); m.tick(); v.render(); } })()`);
  const fly = await js('[window.__shadowRuns, window.__shadowCascades]');
  ok(still[0] === 0 && fly[1] > 0 && fly[1] / 40 < 1, `the shadow map is drawn again only when it must: still ${still[0]} times in 20 frames; flying 16 m, ${fly[1]} cascade(s) in 40 frames`);

  // ---- the terrain's own light (the host's bake for this sun) ----
  const tl = await js(`(async () => { const m = window.__xo.maps, t = m.terrain, L = m.terrainLight;
    const r = await fetch('https://xo.data/mapterrainlight?' + m.query + '&step=' + t.step + '&sun=' + m.sky.sun.toArray().join(','));
    const b = new Uint8Array(await r.arrayBuffer()); const jl = new DataView(b.buffer).getUint32(4, true); const head = JSON.parse(new TextDecoder().decode(b.subarray(8, 8 + jl))); const off = (8 + jl + 3) & ~3;
    let shade = 0, sky = 0; const n = head.w * head.h; for (let i = 0; i < n; i++) { if (b[off + i * 2] < 128) shade++; sky += b[off + i * 2 + 1] / 255; }
    return { magic: String.fromCharCode(...b.subarray(0, 4)), head, grid: [t.w, t.h], bytes: b.length - off, shade: shade / n, sky: sky / n, on: L && L.u.xoTerrainOn.value, tex: L && L.u.xoTerrainLight.value && [L.u.xoTerrainLight.value.image.width, L.u.xoTerrainLight.value.image.height],
      define: 'XO_TERRAIN_LIGHT' in (m.terrainMat.defines || {}) }; })()`);
  ok(tl.magic === 'XOTL' && tl.head.w === tl.grid[0] && tl.head.h === tl.grid[1] && tl.bytes === tl.head.w * tl.head.h * 2 && tl.shade > 0.001 && tl.shade < 0.5 && tl.sky > 0.7 && tl.sky < 1,
    `/mapterrainlight: ${tl.head.w} x ${tl.head.h} (the terrain's grid), ${(tl.shade * 100).toFixed(1)} % in the hills' shadow, ${(tl.sky * 100).toFixed(0)} % of the sky seen on average`);
  ok(tl.on === 1 && tl.define && tl.tex && tl.tex[0] === tl.head.w, "the terrain takes it (its sun as a shadow, its sky on the ambient light)");
  await js(`(() => { const b = document.querySelector('#mapPanel [data-show="sky"]'); b.click(); })()`);
  await frames(3);
  const plain = await js('window.__xo.maps.terrainLight.u.xoTerrainOn.value');
  await js(`(() => { const b = document.querySelector('#mapPanel [data-show="sky"]'); b.click(); })()`);
  await frames(3);
  ok(plain === 0 && (await js('window.__xo.maps.terrainLight.u.xoTerrainOn.value')) === 1, 'under the plain sky (another sun) it is off, with the game sky on again');

  // ---- bloom, lens dirt and light shafts, looking at the sun ----
  await waitFor('!!(window.__xo.viewer.post.glow && window.__xo.viewer.post.glow.dirt)', 30000).catch(() => {});
  const glow = await js(`(() => { const g = window.__xo.viewer.post.glow; return g && { shafts: !!g.shafts, exponent: g.shafts && g.shafts.exponent, dirt: !!g.dirt }; })()`);
  ok(glow && glow.shafts && glow.exponent === 20 && glow.dirt, `Maps glow: the weather's light shafts (exponent ${glow?.exponent}) and the game's lens dirt (textures/lens_dirt)`);
  await js(`(() => { const m = window.__xo.maps, v = m.v, c = v.camera, T = c.position.constructor, s = v.keyDir, p = c.position.clone(); m.fly.setPose(p, new T(p.x + s.x * 100, p.y + s.y * 100, p.z + s.z * 100)); m.needsBucket = true; })()`);
  await settle(20000);
  const withGlow = await region(0.3, 0.3, 0.7, 0.7);
  const saved = await js(`(() => { const p = window.__xo.viewer.post, g = p.glow; p.glow = null; window.__glow = g; return 1; })()`);
  const without = await region(0.3, 0.3, 0.7, 0.7);
  await js(`window.__xo.viewer.post.glow = window.__glow`);
  ok(saved && lum(withGlow) > lum(without) + 1, `towards the sun the glow brightens the view around it (${lum(without).toFixed(1)} -> ${lum(withGlow).toFixed(1)})`);
  await snap('02-bridge-sun');

  // ---- leaving Maps: the garage's plain shadow, no fog, no glow; back again ----
  await js(`window.__xo.setView('part')`);
  await frames(3);
  const garage = await js(`(() => { const v = window.__xo.viewer; return { cascades: v.key.shadow.cascades, radius: v.key.shadow.radius, size: v.key.shadow.mapSize.x, fog: !!v.scene.fog, glow: v.post.glow }; })()`);
  ok(garage.cascades === 0 && garage.radius >= 0 && garage.size >= 2048 && !garage.fog && garage.glow === null, `the 3D Viewer: three's plain shadow (${garage.size} px), no fog, no glow`);
  await js(`window.__xo.setView('map')`);
  await frames(3);
  ok((await js('window.__xo.viewer.key.shadow.cascades')) === 4 && (await js('!!window.__xo.viewer.post.glow && !!window.__xo.viewer.scene.fog')), 'back in Maps: the cascades, the fog and the glow');

  // ---- a sandstorm (arizona_silo's storm, 386174): its dust lying deep on the ground, its yellow over the distance ----
  await open('arizona_silo', '386174');
  const storm = await js(`(async () => { const { FOG } = await import('./fog.js'); return { a: { ...FOG.a }, c: { ...FOG.c }, b: { ...FOG.b }, color: { ...FOG.color } }; })()`);
  ok(storm.b.z === 1 && storm.c.x > 0 && storm.c.y >= 0.4 && storm.c.z > 5 && storm.color.x > storm.color.z,
    `the storm's dust: a layer ${storm.c.z.toFixed(1)} m deep (thinning every ${(1 / storm.c.y).toFixed(1)} m above it), its colour the storm's sky's (${[storm.color.x, storm.color.y, storm.color.z].map((v) => v.toFixed(2)).join(', ')})`);
  await pose([-14.87, 92, 245.24], [-14.87 + 1000, 60, 245.24]);
  await settle(20000);
  const horizon = await region(0.2, 0.47, 0.8, 0.53), ground = await region(0.2, 0.85, 0.8, 0.95);
  ok(horizon.r > horizon.b * 1.15 && Math.abs(horizon.r - horizon.b) < Math.abs(ground.r - ground.b) * 2 + 40,
    `the far distance fades into the sand-coloured fog (horizon ${[horizon.r, horizon.g, horizon.b].map(Math.round).join(', ')}; the ground near by ${[ground.r, ground.g, ground.b].map(Math.round).join(', ')})`);
  await snap('03-sandstorm');
  const fxFog = await js(`(() => { const fx = window.__xo.viewer.fx; const draws = []; window.__xo.viewer.scene.traverse((o) => { if (o.name === 'fx' && o.material && o.material.isShaderMaterial) draws.push(o.material); }); return { n: draws.length, fogged: draws.filter((m) => m.fog && m.uniforms.xoFogA).length }; })()`);
  ok(fxFog.n === 0 || fxFog.fogged === fxFog.n, `the map's particles take the fog (${fxFog.fogged} of ${fxFog.n} emitters)`);

  // ---- a weather without sun shadows (arena_football_china's cloudy, 829134: no sun) ----
  await open('arena_football_china', '829134');
  await frames(3);
  ok((await js('window.__xo.maps.env.values.SunShadowsEnabled')) === 'false' && !(await js('window.__xo.viewer.key.castShadow')), 'a weather without a sun casts no sun shadows (SunShadowsEnabled false)');

  // ---- the sky picture drifts (bridge's day: EnvironmentBackdrop motion*) ----
  await open('bridge', '447082');
  // the canvas' middle (64 x 64) after a redraw, and how far another such grab is from it (mean |diff|)
  const grab = () => js(`(() => { const v = window.__xo.viewer, g = v.canvas.getContext('webgl2'); v.render(); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(64 * 64 * 4);
    g.readPixels((w >> 1) - 32, (h >> 1) - 32, 64, 64, g.RGBA, g.UNSIGNED_BYTE, px); return Array.from(px); })()`);
  const apart = (a, b) => a.reduce((s, x, i) => s + (i % 4 === 3 ? 0 : Math.abs(x - b[i])), 0) / (a.length * 0.75);
  const drift = await js(`(() => { const s = window.__xo.maps.sky, d = s.drift, u = s.uniforms; if (!d) return null; s.stepDrift(d.t0 - d.t);
    return { motion: window.__xo.maps.env.values.BackdropMotion, speed: d.speed, z: u.xoDrift.value.z, mix: u.xoDriftMix.value }; })()`);
  ok(drift && Math.abs(drift.z) < 1e-6 && drift.mix === 1 && drift.speed > 0,
    `the sky picture drifts as the game's does (${drift?.motion}: ${drift?.speed} degrees a second overhead), starting where it lies undrifted`);
  const step = (sec) => js(`(() => { const m = window.__xo.maps; m.sky.stepDrift(${sec}); m.v.dirty = true; })()`);
  const at = await js(`window.__xo.viewer.camera.position.toArray()`);
  await pose(at, [at[0], at[1] + 1000, at[2] + 1]);
  await frames(3);
  const up0 = await grab();
  await step(6);
  const up1 = await grab();
  await pose(at, [at[0] + 1000, at[1] + 2, at[2]]);
  await frames(3);
  const low0 = await grab();
  await step(6);
  const low1 = await grab();
  ok(apart(up0, up1) > 2 * apart(low0, low1) && apart(up0, up1) > 0.5,
    `overhead its clouds move on (6 s: ${apart(up0, up1).toFixed(2)} levels a pixel), at the horizon hardly (${apart(low0, low1).toFixed(2)})`);
  // across the end of a pass: the next fades in over the blend time, no jump
  await pose(at, [at[0], at[1] + 1000, at[2] + 1]);
  const toEnd = await js(`(() => { const d = window.__xo.maps.sky.drift; return d.P - (d.t - Math.floor(d.t / d.P) * d.P); })()`);
  await step(toEnd - 0.05);
  const e0 = await grab();
  await step(0.1);
  const e1 = await grab(), mid = await js('window.__xo.maps.sky.uniforms.xoDriftMix.value');
  await step(0.1);
  const e2 = await grab();
  ok(mid < 0.05 && apart(e0, e1) < 3 * apart(e1, e2) + 1,
    `a pass fades into the next without a jump (its weight ${mid.toFixed(3)} just after; ${apart(e0, e1).toFixed(2)} across the change against ${apart(e1, e2).toFixed(2)} after it)`);
  // (bridge's falling leaves keep a still view drawing: the drift may ask for no more)
  const drawn = () => js(`new Promise((r) => { const v = window.__xo.viewer, f0 = v.frames; setTimeout(() => r(v.frames - f0), 1500); })`);
  await sleep(1500);
  await js(`(() => { const s = window.__xo.maps.sky; s.keptDrift = s.drift; s.drift = null; })()`);
  const noDrift = await drawn();
  await js(`(() => { const s = window.__xo.maps.sky; s.drift = s.keptDrift; delete s.keptDrift; })()`);
  const withDrift = await drawn();
  ok(withDrift <= noDrift + 3, `the drift asks for no redraws of its own (a still view: ${withDrift} frames in 1.5 s with it, ${noDrift} without)`);

  // ---- a sky with no picture (Crossout 2.41: helicopter_gorge's day, 447082), worked out from its air ----
  await open('helicopter_gorge', '447082');
  const air = await js(`(async () => {
    const m = window.__xo.maps, s = m.sky, t = s.uniforms.xoBackdrop?.value, { fetchProbe } = await import('./sky.js'), p = await fetchProbe(m.query);
    const h2f = (h) => { const e = (h >> 10) & 31, f = h & 1023, v = e === 0 ? (f / 1024) * 2 ** -14 : (1 + f / 1024) * 2 ** (e - 15); return h & 0x8000 ? -v : v; };
    const lum = (d, o) => 0.2126 * h2f(d[o]) + 0.7152 * h2f(d[o + 1]) + 0.0722 * h2f(d[o + 2]), med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    const W = t.image.width, H = t.image.height, [sw, sh] = p.sky;
    // (the picture's rows from the horizon up; the probe's panorama's from the nadir)
    const rows = [20, 35, 60].map((deg) => {
      const el = (deg * Math.PI) / 180, jp = Math.min(H - 1, Math.floor((el / (Math.PI / 2)) * H)), jq = Math.min(sh - 1, Math.floor((el / Math.PI + 0.5) * sh)), a = [], b = [];
      for (let x = 0; x < W; x++) a.push(lum(t.image.data, (jp * W + x) * 4));
      for (let x = 0; x < sw; x++) b.push(lum(p.skyData, (jq * sw + x) * 4));
      return Math.log2((med(a) * s.backdrop.scale) / med(b));
    });
    const blue = (j) => { let r = 0, b = 0; for (let x = 0; x < W; x++) { r += h2f(t.image.data[(j * W + x) * 4]); b += h2f(t.image.data[(j * W + x) * 4 + 2]); } return b / r; };
    return { path: m.env.values.BackdropPath, dome: s.dome?.name, size: [W, H], rows, top: blue(H - 1), low: blue(2) };
  })()`);
  ok(air.path === '@air:helicopter_gorge:447082' && air.dome === 'sky picture' && air.size[0] === 1024 && air.size[1] === 256,
    `a weather with no picture of its sky works it out from its air (${air.path}: a ${air.size.join(' x ')} picture)`);
  ok(air.rows.every((d) => Math.abs(d) < 0.15) && air.top > air.low,
    `as bright as the game's capture of it 20, 35 and 60 degrees up (${air.rows.map((d) => d.toFixed(2)).join(', ')} EV), bluer overhead than low down (blue / red ${air.top.toFixed(2)} against ${air.low.toFixed(2)})`);
  await snap('04-air-sky');

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
