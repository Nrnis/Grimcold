// End-to-end checks of the map props' materials (CROSSOUT_FORMATS.md, map materials): what the host says
// about them (the layered and two-layer shaders' further texture sets with their tilings, UV kinds and
// blend parameters, the vertex colour or colour map that weighs them, overlays shown by their gloss map,
// glow maps switched by User1 at their own brightness, detail normal maps), the raw geometry the view
// reads (UVs as stored, vertex colours, the third UV set), the view drawing them on a map (moss and grass
// on bridge's rocks, the Show > Material layers switch), the weather's snow on the props, map glass that
// keeps its reflection, vehicle parts left as they were, and exports that bake a two-layer material into
// one set of textures and describe the rest (validated).
//   node tools/e2e_look_mats.mjs [--snap-dir <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e;
const ROCK = 'assets/props/rocks/midland_rock01.mdl', STONES = 'assets/props/rocks/midland_bigstones01.mdl';
// (on Crossout 2.41's bridge: its rocks weighed by their vertex colour, its concrete blocks of two sets)
const MAP_ROCK = 'assets/props/rocks/mid_rocks/midlandrock5.mdl', MAP_BLOCK = 'assets/props/barricade/concrete_block1.mdl';
const XOTEST = path.join(ROOT, 'build', 'xotest.exe');

const app = await launch({ prefix: 'xo-e2e-mats-' });
const { js, waitFor, click, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
const model = (p, skin = '') => js(`fetch('https://xo.data/model?path=' + encodeURIComponent(${JSON.stringify(p)}) + '&skin=${skin}').then((r) => r.json())`);
// /geo's JSON head (its meshes' arrays) and one array's numbers
const geo = (p, lod = 0) => js(`fetch('https://xo.data/geo?lod=${lod}&path=' + encodeURIComponent(${JSON.stringify(p)})).then((r) => r.arrayBuffer()).then((b) => {
  const jl = new DataView(b).getUint32(4, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(b, 8, jl))), base = (8 + jl + 3) & ~3;
  return head.meshes.map((m) => ({ material: m.material, keys: Object.keys(m), uv0: m.uv0 ? [...new Float32Array(b, base + m.uv0[0], 8)] : null })); })`);
const roles = (m) => (m.textures || []).filter((t) => t.exists).map((t) => t.role);
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const pose = (p, t) => js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; window.__xo.viewer.dirty = true; })()`);
const loaded = () => waitFor('window.__xo.maps.scene && window.__xo.maps.loading && window.__xo.maps.loading.finished && document.getElementById("busy").hidden', 300000);
const settled = async () => { // (every geometry and texture in)
  await waitFor(`(() => { let n = 0; for (const c of [window.__xo.viewer.tex, window.__xo.viewer.geo]) c.map.forEach((e) => { if (e && !e.value) n++; }); return n === 0; })()`, 60000).catch(() => {});
  await frames(6);
};
// the mean colour (0..255) of a box in the middle of the view: x0, y0, w, h as fractions of it
const colour = (box = [0.3, 0.3, 0.4, 0.4]) => js(`(() => { window.__xo.viewer.render(); const c = document.getElementById('view'); const g = c.getContext('webgl2'); const W = g.drawingBufferWidth, H = g.drawingBufferHeight;
  const x = Math.round(W * ${box[0]}), y = Math.round(H * (1 - ${box[1]} - ${box[3]})), w = Math.round(W * ${box[2]}), h = Math.round(H * ${box[3]}); const px = new Uint8Array(w * h * 4); g.readPixels(x, y, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
  const s = [0, 0, 0]; for (let i = 0; i < px.length; i += 4) for (let k = 0; k < 3; k++) s[k] += px[i + k]; return s.map((v) => v / (w * h)); })()`);
const greenness = (c) => c[1] - (c[0] + c[2]) / 2;
const setShow = (key, on) => js(`(() => { const el = document.querySelector('#mapPanel [data-show="${key}"]'); if (el.checked !== ${on}) el.click(); return el.checked; })()`);

try {
  await waitFor('window.__xoReady === true', 120000);

  // ---- what the host says about the materials ----
  const rock = (await model(ROCK)).materials[0];
  const rl = rock.layers?.[0];
  ok(rock.guid.startsWith('62bd5a8e') && near(rock.uvScale, 0.8) && rock.layers?.length === 1 && near(rl.tiling, 2) && rl.uv === 0 &&
     [0.0947, 0.671, 0.037, -0.794].every((v, i) => near(rl.blend[i], v)), `two-layer rock (62BD5A8E): base tiling ${rock.uvScale}, its grass layer tiled ${rl?.tiling}, blend ${rl?.blend?.map((v) => v.toFixed(3))}`);
  ok(['albedo2', 'normal2', 'gloss2'].every((r) => roles(rock).includes(r)) && !roles(rock).includes('ao') && !roles(rock).includes('detail'),
    `its second set is albedo2 / normal2 / gloss2, not occlusion and detail (${roles(rock).join(' ')})`);
  const stones = (await model(STONES)).materials[0];
  ok(stones.guid.startsWith('64177e0a') && stones.weights === 'vertex' && stones.layers?.length === 1 && stones.layers[0].index === 1 && near(stones.layers[0].tiling, 2) &&
     roles(stones).includes('albedo2'), `layered boulders (64177E0A): ${stones.layers?.length} layer over the first, weighed by the vertex colour`);
  const mount = (await model('assets/props/rocks/seaside/backgr_mount1.mdl')).materials[0];
  ok(mount.weights === 'colormap' && mount.layers?.length === 2 && mount.layers[1].uv === 1 && roles(mount).includes('colormap') && roles(mount).includes('albedo3'),
    `backdrop mountain: 2 layers weighed by its colour map (${mount.weights}), the second on uv1`);
  const marks = (await model('assets/props/buildings/kiber/parking/stiker_road_marks.mdl')).materials[0];
  ok(marks.blend && marks.maskFromGloss, 'road markings (a flat yellow without alpha) blend by their gloss map\'s red');
  const lamp = (await model('assets/props/lamps/wall_lamp01.mdl', 'blue')).materials.find((m) => roles(m).includes('emissive'));
  ok(lamp && near(lamp.emissiveGain, 13.8) && lamp.textures.find((t) => t.role === 'emissive').base.endsWith('projectors_race_blue_g'),
    `a lamp's glow map is switched on by User1 whatever its name (projectors_race_blue_g), at UserParam1.z = ${lamp?.emissiveGain}`);
  const wind = (await model('assets/props/buildings/factory/fac_building/hangar_wind.mdl')).materials;
  ok(wind.every((m) => !roles(m).includes('emissive')), 'windows01_glow without User1 stays dark (the game leaves it off)');
  const nyWin = (await model('assets/props/newyear/newyear_house_17m19m13m.mdl')).materials.find((m) => m.guid.startsWith('85f3a2ed') && (m.textures || []).some((t) => t.base.endsWith('wood_detales_8m_glow')));
  const nySlots = nyWin ? await js(`window.__xo.viewer.materialTextures(${JSON.stringify(nyWin)}).map((s) => s.slot)`) : null;
  ok(nySlots && !nySlots.includes('emissive') && nySlots.includes('albedo'), `an overlay's glow map without User1 stays dark too (the new-year houses' windows in the game's night capture; drawn: ${nySlots?.join(' ')})`);
  const car = (await model('assets/props/car_burnt/carbroken2_gr01.mdl')).materials.find((m) => m.detailTiling);
  ok(car && near(car.detailTiling, 16) && roles(car).includes('detail'), `a burnt car's detail normal map (User2), tiled ${car?.detailTiling} times`);

  // ---- the geometry the view reads ----
  const gStones = await geo(STONES), gRock = await geo(ROCK), gMount = await geo('assets/props/rocks/seaside/backgr_mount1.mdl');
  ok(gStones.every((m) => m.keys.includes('color')) && gRock.every((m) => !m.keys.includes('color')), 'vertex colours come with the meshes whose layers they weigh, and only those');
  ok(gMount.some((m) => m.keys.includes('uv2')), 'the colour map\'s third UV set (semantic 0x24) comes along');
  const baked = path.join(outDir, 'rock_geo.bin');
  execFileSync(XOTEST, ['geo', ROCK, baked, '0']);
  const bb = fs.readFileSync(baked), bj = JSON.parse(bb.toString('utf8', 8, 8 + bb.readUInt32LE(4))), bbase = (8 + bb.readUInt32LE(4) + 3) & ~3;
  const bakedUv = [...new Float32Array(bb.buffer, bb.byteOffset + bbase + bj.meshes[0].uv0[0], 8)];
  ok(bakedUv.every((v, i) => near(v, gRock[0].uv0[i] * 0.8, 1e-4)), 'the view gets the UVs as stored; an export still bakes the base tiling into them');

  // ---- a map: bridge's rocks ----
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);
  // (every shader program three builds from here on, marked: see the check after the textures are in)
  await js(`(() => { const P = window.__xo.viewer.renderer.info.programs, push = P.push; P.push = function (...a) { for (const p of a) p.__xoNew = true; return push.apply(this, a); }; })()`);
  await js(`window.__xo.openMap('bridge')`);
  await loaded();
  const mats = await js(`(() => { const m = window.__xo.maps, out = {}; for (const p of [${JSON.stringify(MAP_BLOCK)}, ${JSON.stringify(MAP_ROCK)}]) { const r = m.models.find((x) => x.path === p);
    out[p] = r.lods[0].meshes.map((me) => ({ d: me.material.defines, color: !!me.geometry.attributes.color, dust: me.material.defines.XO_DUST !== undefined })); } return out; })()`);
  const rk = mats[MAP_BLOCK][0], st = mats[MAP_ROCK][0];
  ok(rk.d.XO_LAYERS === 1 && rk.d.XO_KIND === 2 && rk.dust, 'the concrete block\'s material blends its second set');
  ok(st.d.XO_LAYERS === 2 && st.d.XO_KIND === 1 && st.d.XO_WEIGHTS === 2, 'the rocks\' material blends two more sets, weighed by its colour map (through the third UV set)');
  const rockAt = await js(`(() => { const r = window.__xo.maps.models.find((x) => x.path === ${JSON.stringify(MAP_ROCK)}); let b = 0; for (let i = 1; i < r.n; i++) if (r.radii[i] > r.radii[b]) b = i; return { c: [...r.centers.slice(b * 3, b * 3 + 3)], r: r.radii[b] }; })()`);
  // the map's biggest rock of that kind, from above it
  await pose([rockAt.c[0] + rockAt.r * 1.2, rockAt.c[1] + rockAt.r * 1.4, rockAt.c[2] + rockAt.r * 1.2], rockAt.c);
  await settled();
  // A material shows stand-ins for the textures still loading (viewer.js LOADING), so it is drawn with
  // the shader it ends with from the first frame: three keeps every program a material had, and none
  // but the one it draws with now was built for it while its textures came in.
  const progs = await js(`(() => { const R = window.__xo.viewer.renderer; let mats = 0, extra = 0; for (const m of window.__xo.viewer.live) { const pr = R.properties.get(m); if (!pr.programs || !pr.currentProgram) continue; mats++; for (const p of pr.programs.values()) if (p !== pr.currentProgram && p.__xoNew) extra++; } return { mats, extra }; })()`);
  ok(progs.mats > 50 && progs.extra === 0, `the map's materials are drawn with their own shader from the first frame: none built for them while their textures came in (${progs.extra} for ${progs.mats} materials)`);
  const on = await js(`(() => { let n = 0, lit = 0; for (const m of window.__xo.viewer.live) { const u = m.userData.xo.u; if (u && u.xoLayersOn && m.defines.XO_LAYERS) { n++; lit += u.xoLayersOn.value; } } return { n, lit }; })()`);
  ok(on.n > 20 && on.lit === on.n, `every layered material on the map draws its layers once its textures are in (${on.lit} of ${on.n})`);
  const cOn = await colour();
  await snap('01-rock-layers');
  ok(!(await setShow('layers', false)), 'Show > Material layers turns them off');
  await frames(3);
  const cOff = await colour();
  const change = Math.abs(cOn[0] - cOff[0]) + Math.abs(cOn[1] - cOff[1]) + Math.abs(cOn[2] - cOff[2]);
  ok(change > 4, `the rock's second layer shows with the layers (colour ${cOn.map((c) => c.toFixed(0)).join(' ')} against ${cOff.map((c) => c.toFixed(0)).join(' ')} without)`);
  await setShow('layers', true);
  ok(errors.length === 0, `no shader or page errors (${errors.slice(0, 2).join(' | ').slice(0, 400)})`);

  // ---- the new-year weather's snow on the props ----
  const homeEnv = await js('window.__xo.maps.scene.environment');
  await js(`(() => { const s = document.getElementById('mpEnv'); s.value = '216895'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.environment === '216895'`, 60000).catch(() => {});
  await loaded();
  const dust = await js(`(() => { for (const m of window.__xo.viewer.live) { const u = m.userData.xo.u; if (u && u.xoDustOn) return { on: u.xoDustOn.value, col: u.xoDustColor.value.toArray(), look: u.xoDustLook.value.toArray(), shape: u.xoDustShape.value.toArray() }; } return null; })()`);
  ok(dust?.on === 1 && dust.col[2] > dust.col[0] && dust.look[3] === 1 && near(dust.shape[0], 0.75), `xmass lays snow on the props (DustColor ${dust?.col.map((v) => v.toFixed(2))}, by normals, from up-ness 0.25: height ${dust?.shape[0]})`);
  const [cx, cy, cz] = rockAt.c, R = rockAt.r;
  await pose([cx + R * 0.4, cy + R * 1.6, cz + R * 0.4], [cx, cy + R * 0.3, cz]);
  await settled();
  const snowOn = await colour([0.4, 0.4, 0.2, 0.2]);
  await snap('02-rock-snow');
  await js(`(() => { for (const m of window.__xo.viewer.live) { const u = m.userData.xo.u; if (u && u.xoDustOn) { u.xoDustOn.value = 0; break; } } window.__xo.viewer.dirty = true; })()`);
  await frames(3);
  const snowOff = await colour([0.4, 0.4, 0.2, 0.2]);
  const lum = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
  ok(lum(snowOn) > lum(snowOff) * 1.15, `the rock's top is snowed over (brightness ${lum(snowOn).toFixed(0)} against ${lum(snowOff).toFixed(0)} without)`);
  await js(`(() => { const s = document.getElementById('mpEnv'); s.value = ${JSON.stringify(homeEnv)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.__xo.maps.scene && window.__xo.maps.scene.environment === ${JSON.stringify(homeEnv)}`, 60000).catch(() => {});
  await loaded();
  const dustAfter = await js(`(() => { for (const m of window.__xo.viewer.live) { const u = m.userData.xo.u; if (u && u.xoDustOn) return { on: u.xoDustOn.value, mode: u.xoDustLook.value.w }; } return null; })()`);
  ok(dustAfter && (dustAfter.on === 0 || dustAfter.mode === 2), `a summer weather has no snow on the props again (${dustAfter?.on ? "only Crossout 2.41's film low down, by height" : 'no cover'})`);

  // ---- glass and overlays as map props get them; a vehicle part as it was ----
  const props = await js(`(async () => { const v = window.__xo.viewer, out = {};
    for (const [k, p] of [['glass', 'assets/props/hangar/hangar_window_de.mdl'], ['marks', 'assets/props/buildings/kiber/parking/stiker_road_marks.mdl']]) {
      const mi = (await (await fetch('https://xo.data/model?path=' + encodeURIComponent(p))).json()).materials[0];
      const m = v.makeMaterial(mi, true, { roughMin: 0.05, prop: true });
      out[k] = { d: m.defines, pm: m.premultipliedAlpha, offset: m.polygonOffset, units: m.polygonOffsetUnits, depthWrite: m.depthWrite };
      v.disposeMaterial(m);
    }
    return out; })()`);
  ok(props.glass.d.XO_GLASS !== undefined && props.glass.pm && !props.glass.depthWrite, 'map glass keeps its whole reflection (premultiplied: only what it lets through is scaled by its alpha)');
  ok(props.marks.d.XO_MASK_GLOSS !== undefined && props.marks.d.XO_GLASS === undefined && props.marks.offset && props.marks.units < 0, 'overlays: masked by their gloss map, straight alpha, drawn over the surface they lie on');
  await js(`window.__xo.setView('part')`);
  await js(`window.__xo.openModel('models/constructor/cabins/engineers_cab2/engineers_cab2.mdl')`);
  await waitFor('!!(window.__xo && window.__xo.state.info && window.__xo.state.info.path.endsWith("engineers_cab2.mdl") && window.__xo.viewer.part)', 60000);
  await sleep(500);
  const part = await js(`window.__xo.viewer.part.userData.materials.map((m) => ({ d: Object.keys(m.defines || {}), pm: m.premultipliedAlpha, key: m.customProgramCacheKey ? m.customProgramCacheKey() : '' }))`);
  ok(part.length > 1 && part.every((m) => !m.d.some((k) => k.startsWith('XO_')) && !m.pm), `a vehicle cabin's ${part.length} materials (its glass too) are drawn as before: no map-prop additions`);

  // ---- exports ----
  const exp = (p, name, skin = '') => { const f = path.join(outDir, name + '.gltf'); execFileSync(XOTEST, ['export', p, f, ...(skin ? ['--skin', skin] : [])]); return { f, j: JSON.parse(fs.readFileSync(f, 'utf8')) }; };
  const blk = exp('assets/props/barricade/concrete_block1.mdl', 'concrete_block1');
  const bm = blk.j.materials[0], img = blk.j.images[blk.j.textures[bm.pbrMetallicRoughness.baseColorTexture.index].source].name;
  ok(bm.extras?.layersBaked === true && /^concrete_damaged_a_concrete_crack_a_[0-9a-f]{8}\.png$/.test(img), `a two-layer concrete block exports its blend baked into one albedo (${img})`);
  ok(validate(blk.f).startsWith('ok'), 'that export validates');
  const rk2 = exp(ROCK, 'midland_rock01').j.materials[0];
  ok(rk2.extras?.layersBaked === false && rk2.extras.layers?.[0]?.blend?.length === 4 && rk2.extras.textures?.Diffuse2Sampler,
    'the rock (its grass needs the world\'s up) exports its first set, with the second and its blend described in extras');
  const lampX = exp('assets/props/lamps/wall_lamp01.mdl', 'wall_lamp01_blue', 'blue').j;
  const lm = lampX.materials.find((m) => m.emissiveTexture);
  ok(near(lm?.extensions?.KHR_materials_emissive_strength?.emissiveStrength, 13.8) && lampX.extensionsUsed?.includes('KHR_materials_emissive_strength'), 'the lamp exports its glow at its brightness (KHR_materials_emissive_strength 13.8)');
  const mk = exp('assets/props/buildings/kiber/parking/stiker_road_marks.mdl', 'road_marks').j.materials[0];
  ok(mk.alphaMode === 'BLEND', 'road markings export see-through where their mask says');

  ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ').slice(0, 400)})`);
} catch (e) {
  ok(false, 'unexpected: ' + (e.stack || e.message));
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
