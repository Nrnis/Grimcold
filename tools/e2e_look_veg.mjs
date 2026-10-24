// End-to-end checks of the maps' vegetation look (ui/foliage.js, xo::grassTints): the grass tinted
// per tuft by the map's grass colour maps (and a colour-map box's own), brightened by its preset's
// luminance_modifier, solid groundcover (debris, bricks) left as it is, light through blades and
// leaves, the darker inside of crowns, trees' far pictures in a LOD of their own (cut at 0.5, fading
// edge-on), the wind (moving on only with frames drawn anyway: a still view is not redrawn for it),
// and the map export's grass (blades wound both ways and single-sided, tinted per copy, no billboard
// planes through the trees).
//   node tools/e2e_look_veg.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, ROOT } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-veg-' });
const { js, waitFor, click, errors } = app;
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const open = async (name) => {
  await js(`window.__xo.openMap(${JSON.stringify(name)})`);
  await waitFor(`window.__xo.maps.scene?.name === ${JSON.stringify(name)} && window.__xo.maps.loading?.finished && document.getElementById("busy").hidden`, 240000);
  await frames(4);
};
const clickOn = async (sel) => { const p = await js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`); await click(p.x, p.y); };
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; })()`);
// the wind's clock, as the drawn programs have it
const windTime = () => js(`(() => { const v = window.__xo.viewer, m = window.__xo.maps; for (const t of m.grass?.types || []) for (const x of t.materials) { const u = v.renderer.properties.get(x).uniforms; if (u?.xoWindTime) return u.xoWindTime.value; } return null; })()`);

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- bridge: grass tinted by the ground, its kinds' brightness, trees ----
  await open('bridge');
  const g = await js(`(() => { const m = window.__xo.maps, g = m.grass, t = g.tints, n = g.head.count;
    let lo = 255, hi = 0, sum = 0, inBox = 0;
    for (let i = 0; i < n; i++) { const r = t[i] & 255; lo = Math.min(lo, r); hi = Math.max(hi, r); sum += r; }
    // the tufts under the bridge (colormaps.xml's box: its own ground map, not the deck's)
    const d = g.data; let under = 0, uSum = [0, 0, 0];
    for (let i = 0; i < n; i++) { const x = d[i * 13 + 9], y = d[i * 13 + 10], z = -d[i * 13 + 11]; if (Math.abs(x - 2.74) < 67 && Math.abs(z - 17.5) < 14.7 && Math.abs(y - 3.86) < 6) { under++; for (let k = 0; k < 3; k++) uSum[k] += (t[i] >> (8 * k)) & 255; } }
    return { n, len: t.length, lo, hi, mean: sum / n, under, uMean: uSum.map((s) => s / Math.max(1, under)),
      kinds: g.types.map((k) => ({ name: k.name, lum: k.luminance, keys: k.materials.map((x) => x.customProgramCacheKey()), colour: k.materials.map((x) => x.color.r), tinted: k.meshes.every((me) => me.instanceColor === k.tint), side: k.materials.map((x) => x.side) })) }; })()`);
  ok(g.len === g.n && g.n > 100000, `the host sends a tint per tuft (${g.len} of ${g.n})`);
  ok(g.lo < 120 && g.hi > 140 && Math.abs(g.mean - 128) < 12, `the tints follow the ground (red ${g.lo}..${g.hi} of 255 = 2, mean ${g.mean.toFixed(1)}: about its own colour on average)`);
  ok(g.under > 0 && g.uMean[2] < 140, `tufts under the bridge take its box's own ground map, not the deck and river the big map sees there (${g.under} tufts, tint ${g.uMean.map((c) => (c / 127.5).toFixed(2)).join(' ')}; the big map's would be about 1.1 1.0 1.3)`);
  const base = g.kinds.find((k) => k.name === 'au/midland/basegrass/basegrass4');
  ok(g.kinds.every((k) => k.keys.every((s) => s.endsWith('-grass3')) && k.tinted && k.side.every((s) => s === 2)), 'every blade kind has the grass look: both sides lit as the front, the ground tint per copy');
  ok(base && Math.abs(base.colour[0] - base.lum / 10) < 1e-3, `blades as bright as luminance_modifier / 10 (basegrass4: ${base?.lum.toFixed(2)} -> x${base?.colour[0].toFixed(2)})`);
  const trees = await js(`(() => { const m = window.__xo.maps, keys = new Set(); let bb = 0, bbOk = 0;
    for (const r of m.models) { if (!r.ready || r.group !== 'trees') continue;
      for (const x of r.materials) { const k = x.customProgramCacheKey(); keys.add(k.slice(k.lastIndexOf('-') + 1)); }
      const last = r.lods[r.lods.length - 1];
      if (r.materials.some((x) => x.customProgramCacheKey().endsWith('-board1'))) { bb++; if (r.lods.length === r.sw.length + 1 && last.meshes.length && last.meshes.every((me) => me.material.customProgramCacheKey().endsWith('-board1'))) bbOk++; } }
    return { keys: [...keys], bb, bbOk }; })()`);
  ok(['leaves1', 'bark1', 'board1'].every((k) => trees.keys.includes(k)), `trees: leaves, bark and far pictures get their looks (${trees.keys.join(', ')})`);
  ok(trees.bb >= 3 && trees.bbOk === trees.bb, `each tree's far picture is a LOD of its own after its last (${trees.bbOk} of ${trees.bb} tree models)`);
  // the look as calibrated against the game's light-probe captures (ui/foliage.js, viewer.js): leaves
  // cut by their mask's mip level, light through a leaf by its alpha squared and through its crown
  // (Unreal's two-sided foliage lobe), the blades' faint sheen
  const look = await js(`(async () => { const THREE = await import('three'); const m = window.__xo.maps, v = window.__xo.viewer;
    const src = (x) => { const s = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {}, defines: {} }; x.onBeforeCompile(s, v.renderer); return s; };
    const leaf = m.models.flatMap((r) => r.materials).find((x) => x.customProgramCacheKey().endsWith('-leaves1'));
    const blade = m.grass.types.flatMap((t) => t.materials).find((x) => x.customProgramCacheKey().endsWith('-grass3'));
    const ls = src(leaf), lf = ls.fragmentShader, gf = src(blade).fragmentShader;
    return { cut: THREE.ShaderChunk.alphamap_fragment.includes('min( 1.0 + 0.08 * xoMaskLod, 1.3 )'), leaf: lf.includes('pow( texture2D( map, vMapUv ).a, 2.0 ) * 6.00'),
      crown: lf.includes('xoCrownLight( directLight, geometryPosition )') && lf.includes('exp( - 0.150 * depth )') && ls.vertexShader.includes('vXoCrownR =') && !!ls.uniforms.xoCrownBox,
      blade: gf.includes('texture2D( roughnessMap, vRoughnessMapUv ).r * 1.00') && gf.includes('material.specularColor *= 0.40') && !gf.includes('xoCrownLight') }; })()`);
  ok(look.cut && look.leaf && look.crown && look.blade, `the calibrated look: leaves cut at their mask x (1 + 0.08 x its mip level) up to 1.3 (${look.cut}), light through a leaf by its alpha squared (${look.leaf}) and through its crown, thinned by its depth (${look.crown}), blades with a faint sheen and light through x 1 (${look.blade})`);
  // far away the trees are their pictures, near they are trees
  const far = await js(`(() => { const m = window.__xo.maps, r = m.models.find((x) => x.ready && x.path.endsWith('piceaabies_huge.mdl')); const c = r.centers;
    const T = m.v.camera.position.constructor; m.fly.setPose(new T(c[0] + 900, c[1] + 80, c[2]), new T(c[0], c[1], c[2])); m.needsBucket = true; return r.path; })()`);
  await frames(4);
  const farLods = await js(`window.__xo.maps.models.find((x) => x.path === ${JSON.stringify(far)}).lods.map((l) => l.count)`);
  const spot = await js(`(() => { const r = window.__xo.maps.models.find((x) => x.path === ${JSON.stringify(far)}); return [r.centers[0], r.centers[1], r.centers[2], r.radii[0]]; })()`);
  await pose([spot[0] + spot[3] * 2.5, spot[1] + 2, spot[2] + spot[3] * 2.5], spot.slice(0, 3));
  await frames(4);
  const nearLods = await js(`window.__xo.maps.models.find((x) => x.path === ${JSON.stringify(far)}).lods.map((l) => l.count)`);
  ok(farLods[farLods.length - 1] > 0 && nearLods[0] > 0, `piceaabies_huge: its far picture from 900 m (LODs ${farLods.join('/')}), the tree itself up close (${nearLods.join('/')})`);
  // the shaders compile and draw (no warnings about pieces the patches did not find)
  ok(errors.length === 0, `no page errors or shader warnings on bridge (${errors.slice(0, 2).join(' | ')})`);

  // ---- the wind: on with frames drawn anyway, still with a still view ----
  const grassSpot = await js(`(() => { const d = window.__xo.maps.grass.data, i = Math.floor(d.length / 13 / 2) * 13; return [d[i + 9], d[i + 10], d[i + 11]]; })()`);
  await pose([grassSpot[0] + 5, grassSpot[1] + 2, grassSpot[2] + 5], grassSpot);
  // (the map's effects, its weather, blinking lamps and the water's waves move on 30 times a second: off and
  // held, the view is still)
  await clickOn('#mapPanel [data-show="effects"]');
  await clickOn('#mapPanel [data-show="water"]');
  await js('window.__xo.viewer.holdLamps(0)');
  await waitFor('!window.__xo.viewer.fx.busy', 20000); // (the last particles die out)
  await frames(6);
  await sleep(300);
  const env = await js(`window.__xo.maps.env?.values?.WindForce`);
  const w0 = await windTime(), f0 = await js('window.__xo.viewer.frames');
  await sleep(700);
  const w1 = await windTime(), f1 = await js('window.__xo.viewer.frames');
  ok(w0 !== null && w1 === w0 && f1 - f0 <= 2, `a still view is not redrawn for the wind (${f1 - f0} frames in 0.7 s), the wind waits (t ${w0?.toFixed(2)} -> ${w1?.toFixed(2)})`);
  await js(`(() => { const m = window.__xo.maps; m.__spin = setInterval(() => { m.v.camera.rotateY(0.01); m.v.camera.updateMatrixWorld(); }, 16); })()`);
  await sleep(700);
  await js(`clearInterval(window.__xo.maps.__spin)`);
  const w2 = await windTime();
  ok(w2 > w1 + 0.2 && w2 < w1 + 1, `turning the view, the grass sways on (t ${w1?.toFixed(2)} -> ${w2?.toFixed(2)}; the environment's WindForce ${env})`);
  await clickOn('#mapPanel [data-show="effects"]');
  await clickOn('#mapPanel [data-show="water"]');
  await js('window.__xo.viewer.holdLamps(null)');

  // ---- render cost of the look (the grass close up, its whole reach) ----
  const cost = await js(`(() => { const v = window.__xo.viewer; v.render(); const t0 = performance.now(); for (let i = 0; i < 20; i++) v.render(); v.renderer.getContext().finish(); return (performance.now() - t0) / 20; })()`);
  const drawn = await js('window.__xo.maps.stats().grass.drawn');
  ok(cost < 120, `a frame with ${drawn} tufts in view takes ${cost.toFixed(1)} ms`);

  // ---- cityruin: solid groundcover (concrete debris) stays as it is; Crossout 2.41 has none (its
  // ground cover is all of the new kind, stones too, on the grass's shader: all take the grass look) ----
  await open('cityruin');
  const solid = await js(`(() => { const g = window.__xo.maps.grass; const k = g.types.find((t) => /concdebris/.test(t.name));
    return { kind: k ? { keys: k.materials.map((x) => x.customProgramCacheKey()), colour: k.materials.map((x) => x.color.r), tint: k.meshes.map((me) => !!me.instanceColor), side: k.materials.map((x) => x.side) } : null,
      kinds: g.types.length, grassLook: g.types.every((t) => t.materials.every((x) => x.customProgramCacheKey().endsWith('-grass3'))) }; })()`);
  if (solid.kind)
    ok(solid.kind.keys.every((s) => !s.includes('grass')) && solid.kind.colour.every((c) => c === 1) && solid.kind.tint.every((t) => !t) && solid.kind.side.every((s) => s === 0),
      'solid groundcover (concrete debris): its own normals, one-sided, no brightening or tint');
  else ok(solid.kinds > 3 && solid.grassLook, `no solid groundcover on cityruin (Crossout 2.41): its ${solid.kinds} kinds, stones too, all take the grass look of their shader`);
  ok(errors.length === 0, `no page errors on cityruin (${errors.slice(0, 2).join(' | ')})`);

  // ---- the export: grass blades both ways and single-sided, tinted copies; trees without their far planes ----
  const file = path.join(outDir, 'bridge_veg.glb');
  await js(`window.__xo.call('exportMap', { name: 'bridge', festival: 'Empty', gameplay: 'Assault', format: 'glb', terrain: true, ground: 256, props: false, trees: true, objects: false, water: false, lod: 2, textures: true, maxTex: 128,
    decals: false, grass: true, grassAmount: 0.05, sun: false, sky: false, outPath: ${JSON.stringify(file)} })`);
  const fj = (() => { const b = fs.readFileSync(file); return JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12))); })();
  const grassGroup = fj.nodes.find((x) => x.name === 'grass');
  const kinds = (grassGroup?.children || []).map((c) => fj.nodes[c]);
  const baseNode = kinds.find((n) => /basegrass4$/.test(n.name));
  const prim = baseNode && fj.meshes[baseNode.mesh].primitives[0];
  const inst = baseNode?.extensions?.EXT_mesh_gpu_instancing?.attributes;
  ok(kinds.length >= 3 && kinds.every((n) => n.extensions?.EXT_mesh_gpu_instancing?.attributes?._COLOR_0 !== undefined), `exported grass: ${kinds.length} kinds, each copy tinted by the ground (_COLOR_0)`);
  ok(prim && fj.accessors[prim.indices].count === 1170 && !fj.materials[prim.material].doubleSided && fj.accessors[inst._COLOR_0].type === 'VEC3',
    `basegrass4's blades wound both ways (${prim && fj.accessors[prim.indices].count} indices of the model's 585), single-sided, so the back lights as the front`);
  const boards = fj.materials.filter((m) => Object.values(m.extras?.textures || {}).some((t) => /_billboard_/.test(t)));
  ok(fj.materials.some((m) => m.extras?.crossoutShader?.startsWith('06bc377b')) && boards.length === 0, `trees exported without their far pictures' planes (${boards.length} billboard materials)`);
  const vf = validate(file);
  ok(vf.startsWith('ok'), 'the export validates: ' + vf.split('\n')[0]);
  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
