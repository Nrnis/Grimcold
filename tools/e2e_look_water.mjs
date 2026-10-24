// End-to-end test of the maps' water and acid (ui/water.js, mapview.js buildWater): every volume drawn
// with the water shader (its wave frames, the depth under it baked from the terrain, front side only),
// the waves moving while water is in view and resting while it is not, the shallows showing their bed
// and deep water its own colour, the sun's glint, the view sinking into the water's colour under its
// level, outlines turned with their entity (vulkan's sea on the east coast, drcross's pools in their
// basins), the acid volumes, a round hitting the turned surface, and the export (see-through by
// transmission, its waves as a normal map, acid opaque; validated).
//   node tools/e2e_look_water.mjs [--snap-dir <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-water-' });
const { js, waitFor, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; })()`);
const open = async (name, o = {}) => {
  await js(`window.__xo.openMap(${JSON.stringify(name)}, ${JSON.stringify(o)})`);
  await waitFor(`window.__xo.maps.scene?.name === ${JSON.stringify(name)} && window.__xo.maps.loading?.finished && document.getElementById('busy').hidden`, 240000);
};
// the textures the view still waits for
const settle = async () => { for (let i = 0; i < 100 && (await js(`(() => { let n = 0; for (const c of [window.__xo.viewer.tex, window.__xo.viewer.geo]) c.map.forEach((e) => { if (e && !e.value) n++; }); return n; })()`)); i++) await sleep(200); };
// the canvas' centre pixel, sRGB
const centre = () => js(`(() => { const c = window.__xo.viewer.canvas, g = c.getContext('webgl2'), p = new Uint8Array(4 * 25); g.readPixels(g.drawingBufferWidth / 2 - 2, g.drawingBufferHeight / 2 - 2, 5, 5, g.RGBA, g.UNSIGNED_BYTE, p);
  const s = [0, 0, 0]; for (let i = 0; i < p.length; i += 4) for (let k = 0; k < 3; k++) s[k] += p[i + k] / 25; return s; })()`);
const drawn = async () => { await js('window.__xo.viewer.dirty = true'); await frames(3); };
// a point of water k where it is as deep as wanted (closest to want, metres), or null
const spot = (k, want) => js(`(() => { const m = window.__xo.maps, w = m.scene.water[${k}], o = w.outline; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
  let best = null; for (let j = 0; j < 120; j++) for (let i = 0; i < 120; i++) { const x = x0 + (x1 - x0) * (i + 0.5) / 120, z = z0 + (z1 - z0) * (j + 0.5) / 120;
    if (m.waterOver(x, z) !== w) continue; const d = w.level - m.heightAt(x, z); if (!Number.isFinite(d) || d < 0) continue;
    if (!best || Math.abs(d - ${want}) < Math.abs(best.d - ${want})) best = { x, z, d, y: w.level }; } return best; })()`);
// how much of the ground inside a water's outline lies under its level
const under = (k) => js(`(() => { const m = window.__xo.maps, w = m.scene.water[${k}], o = w.outline; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
  let n = 0, u = 0; for (let j = 0; j < 40; j++) for (let i = 0; i < 40; i++) { const x = x0 + (x1 - x0) * (i + 0.5) / 40, z = z0 + (z1 - z0) * (j + 0.5) / 40;
    if (m.waterOver(x, z) !== w) continue; const h = m.heightAt(x, z); if (!Number.isFinite(h)) continue; n++; if (h < w.level) u++; } return n ? u / n : 0; })()`);

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- bridge: the river ----
  await open('bridge', { gameplay: 'Assault' });
  await settle();
  await waitFor('window.__xo.maps.water.items.every((it) => it.m.defines.XO_FRAMES !== undefined) && window.__xo.maps.water.items.every((it) => it.u.xoDepthRect.value.z > 0)', 60000).catch(() => {});
  const look = await js(`(() => { const m = window.__xo.maps, w = m.water, it = w.items[0]; return { n: m.waterGroup.children.length, scene: m.scene.water.length, frames: it.u.xoFrames.value.image.depth, size: it.u.xoFrames.value.image.width,
    depth: it.u.xoDepthRect.value.z > 0, side: it.m.side, under: it.mesh.children[0]?.material.side, write: it.m.depthWrite, order: it.mesh.renderOrder, blend: it.m.blending, src: it.m.blendSrc, dst: it.m.blendDst,
    params: Object.keys(m.scene.water[0]).filter((k) => ['type', 'density', 'tiling', 'speed', 'dir', 'bump', 'noiseTiling', 'frames', 'detail', 'colorMap', 'user3'].includes(k)).length }; })()`);
  ok(look.n === look.scene && look.n > 0 && look.params === 11, `bridge: ${look.n} water area(s) drawn, each with its look from the map (type, density, tilings, speeds, directions, bumps, maps)`);
  ok(look.frames === 64 && look.size === 256, `its wave animation: ${look.frames} frames of ${look.size} px`);
  ok(look.depth, 'its depth under the surface is baked from the terrain');
  ok(look.side === 0 && look.under === 1 && look.write && look.order === 2 && look.blend === 5 && look.src === 201 && look.dst === 205,
    'front side only (its underside a mesh of its own), depth written, premultiplied over what is under it, after the decals');

  // the waves move while the water is in view and rest while it is not
  const shallow = await spot(0, 0.3), deep = await spot(0, 3);
  ok(shallow && deep && Math.abs(shallow.d - 0.3) < 0.1 && deep.d > 2, `a shallow spot (${shallow?.d.toFixed(2)} m) and a deep one (${deep?.d.toFixed(2)} m) on the river`);
  await pose([deep.x, deep.y + 12, deep.z + 0.01], [deep.x, deep.y, deep.z]);
  await drawn();
  const f0 = await js('window.__xo.maps.water.items[0].u.xoFrame.value.toArray()');
  await sleep(400); await frames(3);
  const f1 = await js('window.__xo.maps.water.items[0].u.xoFrame.value.toArray()');
  ok(f0[0] !== f1[0] || f0[2] !== f1[2], `the waves move on while the water is in view (frame ${f0[0]} + ${f0[2].toFixed(2)} -> ${f1[0]} + ${f1[2].toFixed(2)})`);
  await js(`window.__xo.maps.setShow('water', false)`);
  await drawn(); await sleep(700); await frames(2);
  const r0 = await js('window.__xo.maps.water.items[0].u.xoFrame.value.toArray()');
  await sleep(400); await frames(3);
  const r1 = await js('window.__xo.maps.water.items[0].u.xoFrame.value.toArray()');
  await js(`window.__xo.maps.setShow('water', true)`);
  ok(r0.join() === r1.join(), 'and rest while it is not drawn (no redraws for it)');

  // the shallows show their bed, deep water hides it (the centre pixel with and without the water)
  const through = async (p) => {
    await pose([p.x, p.y + 6, p.z + 0.01], [p.x, p.y, p.z]);
    await drawn();
    const a = await centre();
    await js(`window.__xo.maps.setShow('water', false)`); await drawn();
    const b = await centre();
    await js(`window.__xo.maps.setShow('water', true)`); await drawn();
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  };
  const dShallow = await through(shallow), dDeep = await through(deep);
  ok(dDeep > 15 && dShallow < dDeep * 0.75, `the shallows show their bed (the water changes the pixel by ${dShallow.toFixed(0)}), deep water its own colour (by ${dDeep.toFixed(0)})`);
  await snap('01-bridge-river');

  // the sun's glint (checked on customgame_fiery_river below: bridge's light probe has its glint, at
  // u 0.747 and 27 degrees down, on the wet riverbed beside the river's outline, not on the water)
  // (the brightest of the lower half of the view: the bed there, or the glint on the water over it)
  const glint = async () => js(`(() => { const c = window.__xo.viewer.canvas, g = c.getContext('webgl2'), W = g.drawingBufferWidth, H = g.drawingBufferHeight, p = new Uint8Array(W * (H >> 1) * 4); g.readPixels(0, 0, W, H >> 1, g.RGBA, g.UNSIGNED_BYTE, p);
    const l = []; for (let i = 0; i < p.length; i += 16) l.push(0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]); l.sort((a, b) => a - b); return { top: l[Math.floor(l.length * 0.995)], white: l.filter((v) => v >= 250).length / l.length }; })()`);
  const P = [-23.64, 18.83, 55.38], th = 0.26 * 2 * Math.PI, pi = (-35 * Math.PI) / 180;
  await pose(P, [P[0] + Math.cos(th) * Math.cos(pi) * 50, P[1] + Math.sin(pi) * 50, P[2] + Math.sin(th) * Math.cos(pi) * 50]);
  await settle(); await drawn();
  await snap('02-bridge-glint');

  // under the water the view sinks into its colour; coming up gives the sky's haze back
  const dive = await spot(0, 6);
  await pose([dive.x, dive.y - 1, dive.z], [dive.x + 10, dive.y - 1, dive.z]);
  await drawn();
  // (fog.js FOG, shared by every fogged material: the sky's uniforms reach it)
  const sub = await js(`(() => { const m = window.__xo.maps, f = m.sky.uniforms.xoFogA.value; return { under: m.under?.name, fog: { ...f }, density: m.under?.density }; })()`);
  await pose([dive.x, dive.y + 5, dive.z], [dive.x + 10, dive.y, dive.z]);
  await drawn();
  const up = await js(`(() => { const m = window.__xo.maps, f = m.sky.uniforms.xoFogA.value; return { under: m.under, fog: { ...f }, haze: m.v.mapHaze?.density }; })()`);
  const e = Math.exp(-(sub.fog.x * Math.LN2 * Math.LN2)); // (what a metre of it lets through)
  ok(sub.under && Math.abs(e - Math.exp(-sub.density)) < 1e-6 && sub.fog.y === 0 && up.under === null && Math.abs(up.fog.x - up.haze) < 1e-9,
    `under ${sub.under} (${dive.d.toFixed(1)} m deep) the fog is the water's (a metre lets ${(e * 100).toFixed(1)} % through, density ${sub.density}); above it the sky's again (${up.fog.x})`);
  const perf = await js(`(() => { const v = window.__xo.viewer, g = v.renderer.getContext(), m = window.__xo.maps; const time = () => { const t = []; for (let i = 0; i < 12; i++) { const a = performance.now(); v.render(); g.finish(); t.push(performance.now() - a); } t.sort((a, b) => a - b); return t[6]; };
    const T = v.camera.position.constructor; m.fly.setPose(new T(-23.64, 18.83, 55.38), new T(-23.64, 4, -5)); m.tick(); const on = time(); m.setShow('water', false); m.tick(); const off = time(); m.setShow('water', true); m.tick(); return { on, off }; })()`);
  ok(perf.on < perf.off + Math.max(4, perf.off * 0.25), `a frame over the river takes ${perf.on.toFixed(1)} ms with the water, ${perf.off.toFixed(1)} ms without`);

  // ---- vulkan: its sea, turned half round with its entity, lies along the east coast ----
  await open('vulkan');
  const sea = await js(`(() => { const m = window.__xo.maps, w = m.scene.water[0], o = w.outline; let x0 = 1e9, x1 = -1e9; for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); }
    return { x0, x1, size: m.scene.terrain.sizeX, east: m.waterAt(480, 0), west: m.waterAt(-480, 0) }; })()`);
  ok(sea.x0 > 0 && sea.x0 < sea.size / 2 && sea.x1 > 3000 && sea.east !== null && sea.west === null, `vulkan's sea spans x ${sea.x0.toFixed(0)} .. ${sea.x1.toFixed(0)} m: the east coast, not 3.4 km off the map`);
  await pose([0, 600, 1000], [700, 0, 0]);
  await settle(); await drawn();
  await snap('03-vulkan-sea');

  // ---- drcross: its pools turned into their basins, its acid, a round meeting the surface ----
  await open('drcross');
  const dr = await js(`(() => { const s = window.__xo.maps.scene.water; return s.map((w, k) => ({ k, name: w.name, acid: w.acid, type: w.type })); })()`);
  const acid = dr.filter((w) => w.acid), turned = dr.find((w) => w.name === 'AcidVolume.4');
  ok(acid.length >= 1 && acid.every((w) => w.type === 1), `drcross: its acid (${acid.map((w) => w.name).join(', ')}) is drawn too`);
  const basin = turned ? await under(turned.k) : 0;
  ok(basin > 0.5, `its pool ${turned?.name}, turned with its entity (yaw -120), lies in its basin: ${(basin * 100).toFixed(0)} % of the ground inside under its level (0 % unturned)`);
  const hp = turned ? await spot(turned.k, 1) : null;
  const hit = hp ? await js(`(() => { const h = window.__xo.maps.segmentHit([${hp.x}, ${hp.y + 20}, ${hp.z}], [${hp.x}, ${hp.y - 20}, ${hp.z}]); return h && { surface: h.surface, y: h.point[1] }; })()`) : null;
  ok(hit?.surface === 2 && Math.abs(hit.y - hp.y) < 0.01, `a round falling into it splashes on its surface (${hit?.y.toFixed(2)} m)`);
  const box = await js(`(() => { const w = window.__xo.maps.scene.water.find((x) => x.name === 'AcidVolume.4'), o = w.outline; let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); } return { min: [x0, w.level, z0], max: [x1, w.level, z1] }; })()`);

  // ---- customgame_fiery_river: the acid river lets no light through ----
  await open('customgame_fiery_river', { environment: '447082' }); // (its day: the sun's glint below)
  const fr = await js(`(() => { const m = window.__xo.maps, w = m.scene.water.find((x) => x.acid), it = m.water.items.find((x) => x.w === w); return w && { name: w.name, type: w.type, density: it.u.xoLook.value.x, own: w.density }; })()`);
  ok(fr && fr.type === 1 && fr.density === fr.own * 3, `customgame_fiery_river's river is acid (${fr?.name}), three times as dense as water of its density`);
  // the sun's glint on it: the camera where a point of the acid mirrors the sun to it (the sun's way with
  // its height turned over, 120 m out), that point a little under the view's centre
  const gp = await js(`(() => { const m = window.__xo.maps, w = m.scene.water.find((x) => x.acid), s = m.sky.sun, o = w.outline;
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (let i = 0; i < o.length; i += 2) { x0 = Math.min(x0, o[i]); x1 = Math.max(x1, o[i]); z0 = Math.min(z0, o[i + 1]); z1 = Math.max(z1, o[i + 1]); }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2; let best = null;
    for (let x = x0; x <= x1; x += 4) for (let z = z0; z <= z1; z += 4) { const l = m.waterAt(x, z); if (l === null) continue; const d = Math.hypot(x - cx, z - cz); if (!best || d < best.d) best = { x, z, l, d }; }
    return best && { p: [best.x, best.l, best.z], s: [s.x, s.y, s.z] }; })()`);
  const GD = 120, [gx, gy, gz] = gp.p, [sx, sy, sz] = gp.s;
  await pose([gx - sx * GD, gy + sy * GD, gz - sz * GD], [gx, gy + GD * 0.06, gz]);
  await settle();
  await js(`(() => { const w = window.__xo.maps.water; w.tick = () => false; w.setTime(3); })()`);
  await drawn();
  const gOn = await glint();
  await js(`window.__xo.maps.setShow('water', false)`); await drawn();
  const gOff = await glint();
  await js(`window.__xo.maps.setShow('water', true)`); await drawn();
  // (the game's tone curve takes the sunlit canyon itself near white: the glint shows as white pixels)
  ok(gOn.white > Math.max(0.002, gOff.white * 2), `the sun glints on the acid below it (white: ${(gOn.white * 100).toFixed(2)} % of the view's lower half, ${(gOff.white * 100).toFixed(2)} % without it)`);
  await snap('04-fiery-river');

  // ---- the export: the water see-through by transmission, its waves, acid opaque ----
  const file = path.join(outDir, 'drcross_water.glb');
  await js(`window.__xo.call('exportMap', { name: 'drcross', festival: 'Empty', gameplay: 'auto', format: 'glb', terrain: false, props: false, trees: false, objects: false, water: true, lod: 0, textures: true, maxTex: 256,
    decals: false, grass: false, sun: false, sky: false, outPath: ${JSON.stringify(file)} })`);
  const gj = (() => { const b = fs.readFileSync(file); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const mats = gj.materials || [];
  const water = mats.filter((m) => m.extensions?.KHR_materials_transmission), acidMats = mats.filter((m) => m.name.startsWith('acid'));
  const used = gj.extensionsUsed || [];
  ok(water.length > 0 && water.every((m) => m.extensions.KHR_materials_transmission.transmissionFactor === 1 && Math.abs(m.extensions.KHR_materials_ior.ior - 1.333) < 1e-3 && m.extensions.KHR_materials_volume.attenuationDistance > 0 && m.normalTexture)
    && ['KHR_materials_transmission', 'KHR_materials_ior', 'KHR_materials_volume'].every((e) => used.includes(e)), `exported water: ${water.length} material(s) see-through by transmission (index 1.333, its colour by depth), with its waves as a normal map`);
  ok(acidMats.length > 0 && acidMats.every((m) => !m.extensions && !m.alphaMode), `exported acid: ${acidMats.length} opaque material(s)`);
  // the exported surface lies where the view draws it (the turned outline, at its level)
  const node = gj.nodes.find((n) => n.name === 'water_AcidVolume.4');
  const acc = node ? gj.accessors[gj.meshes[node.mesh].primitives[0].attributes.POSITION] : null;
  ok(acc && acc.min.every((v, i) => Math.abs(v - box.min[i]) < 0.01) && acc.max.every((v, i) => Math.abs(v - box.max[i]) < 0.01), 'the exported pool lies where the view draws it (turned, at its level)');
  const v = validate(file);
  ok(v.startsWith('ok'), 'the water GLB validates: ' + v.split('\n')[0]);

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
