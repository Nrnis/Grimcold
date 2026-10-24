// End-to-end test of a map's own lights, decal switches and the objects found for its definitions
// (Maps mode): the night's lamps lighting the snow around them (and nothing behind walls: their
// shadows, lampshadows.js), their flares and beams, none of the
// dark weathers' lamps by day and the same lamps dim in daylight, Show > Lights, flickering lights
// moving; decals kept off walls their preset forbids, glossy and glowing decals, laid in the map's
// order; lamp models where the lights shine from, fences, barrels and taxis (with the definition's
// colour) placed, a definition that spells out its model's path.
//   node tools/e2e_look_scene.mjs [--snap-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-scene-' });
const { js, waitFor, errors } = app;
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
const open = async (name, o = {}) => {
  await js(`window.__xo.openMap(${JSON.stringify(name)}, ${JSON.stringify(o)})`);
  await waitFor(`window.__xo.maps.scene?.name === ${JSON.stringify(name)} && window.__xo.maps.loading?.finished && !window.__xo.maps.loading.sky`, 240000);
  await frames(4);
};
const pose = async (p, t) => {
  await js(`(() => { const m = window.__xo.maps, T = m.v.camera.position.constructor; m.fly.setPose(new T(${p.join(',')}), new T(${t.join(',')})); m.needsBucket = true; })()`);
  await frames(4);
};
// mean brightness of the view's middle (the default framebuffer keeps its last frame)
const brightness = () => js(`(() => { const g = document.getElementById('view').getContext('webgl2'), w = g.drawingBufferWidth, h = g.drawingBufferHeight;
  const W = Math.floor(w / 3), H = Math.floor(h / 3), px = new Uint8Array(W * H * 4); g.readPixels(W, H, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
  let s = 0; for (let i = 0; i < px.length; i += 4) s += px[i] + px[i + 1] + px[i + 2]; return s / (W * H * 3); })()`);
const lit = () => js(`(() => { const L = window.__xo.maps.lights; return L.pool.filter((s) => s.light.intensity > 0).map((s) => ({ kind: s.kind, i: s.light.intensity, d: s.light.position.distanceTo(window.__xo.viewer.camera.position) })); })()`);

try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('map')`);
  await waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- a night's lamps (newyear_foray's night) ----
  await open('newyear_foray', { environment: '237103' });
  const night = await js(`(() => { const m = window.__xo.maps, L = m.lights, s = m.stats(), kinds = {};
    for (const l of m.scene.lights) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
    return { kinds, counts: s.lights, pool: L.pool.length, points: L.pool.filter((p) => p.kind === 'point').length, spots: L.pool.filter((p) => p.kind === 'spot').length,
      perLux: L.perLux, lum: L.lum, F: m.sky.levels.F, E: parseFloat(m.env.values.EmissiveLumScale), glow: L.glow.value, panel: document.getElementById('mpStats').textContent, toggle: !!document.querySelector('#mapPanel [data-show="lights"]') }; })()`);
  ok(night.kinds.point > 250 && night.kinds.spot > 40 && night.kinds.flare > 300 && night.kinds.beam > 60, `newyear_foray at night: ${night.kinds.point} point lights, ${night.kinds.spot} projectors, ${night.kinds.flare} flares, ${night.kinds.beam} beams`);
  ok(night.points === 16 && night.spots === 8, `a fixed pool of real lights for the map (${night.points} point, ${night.spots} spot)`);
  ok(/Lights/.test(night.panel) && night.toggle, 'the panel counts the lights and Show has a Lights switch');
  // a porch lamp's light on the snow, seen from the game's light probe there
  await pose([215.37, 21.5, 22.21], [218.5, 5.5, 1.7]);
  const near = await lit();
  ok(near.length > 0 && near.some((l) => l.kind === 'point' && l.d < 30), `lamps near the camera are lit (${near.length}; the nearest ${Math.min(...near.map((l) => l.d)).toFixed(1)} m off)`);
  const on = await brightness();
  await js(`window.__xo.maps.setShow('lights', false)`);
  await frames(4);
  const off = await brightness();
  const dark = await js(`(() => { const L = window.__xo.maps.lights; return { lit: L.pool.filter((s) => s.light.intensity > 0).length, flares: L.flares.mesh.visible, beams: L.beams.mesh.visible, count: L.pool.length }; })()`);
  ok(on > off * 1.08, `the porch lamp lights the snow around it (the view's middle ${off.toFixed(1)} -> ${on.toFixed(1)})`);
  ok(dark.lit === 0 && !dark.flares && !dark.beams && dark.count === 24, 'Show > Lights off: the lamps go dark (no shaders built again), flares and beams hidden');
  await js(`window.__xo.maps.setShow('lights', true)`);
  await frames(4);
  ok((await lit()).length > 0, 'Show > Lights on again: lit');
  await snap('01-night-porch');
  // glowing decals (light_quad: painted light at the lamps) at the night's exposure
  const glowing = await js(`(() => { const m = window.__xo.maps; let n = 0, e = 0; m.decals.group.traverse((o) => { const x = o.material; if (x?.emissiveIntensity > 0 && x.emissive.getHex()) { n += o.userData.decals || 1; e = Math.max(e, x.emissiveIntensity); } }); return { n, e, glow: m.lights.glow.value }; })()`);
  ok(glowing.n > 50 && glowing.glow > 0, `glowing decals: ${glowing.n}, at the view's glow per unit of luminance ${glowing.glow.toFixed(4)}`);

  // ---- the same lamps by day ----
  await open('newyear_foray', { environment: '447082' });
  const day = await js(`(() => { const m = window.__xo.maps, L = m.lights; return { perLux: L.perLux, lum: L.lum, F: m.sky.levels.F, E: parseFloat(m.env.values.EmissiveLumScale), n: m.scene.lights.length }; })()`);
  const lumOf = (x) => (2 * Math.min(8, Math.max(0.25, x.F * 2 ** (x.E - 1)))) / x.F; // (sky.js presetLevels' glow, held to 0.25 .. 8)
  // (the game sets its lamps with the weather's emissive EC: 0 at this night, 5 by day, EmissiveLumScale
  // -6 and -1; at the night's exposure, 5.75 EV under the day's, they are still brighter on screen)
  ok(night.E === -6 && day.E === -1 && Math.abs(night.lum - lumOf(night)) < 1e-6 && Math.abs(day.lum - lumOf(day)) < 1e-6,
    `the lamps at the weather's EmissiveLumScale: ${night.E} EV at night, ${day.E} by day (x${night.lum.toFixed(3)}, x${day.lum.toFixed(3)} as the view holds them)`);
  ok(day.n > 250 && night.perLux * night.lum > day.perLux * day.lum * 1.25, `the same lamps by day: ${((night.perLux * night.lum) / (day.perLux * day.lum)).toFixed(1)} times dimmer against the day's light (lost in the sun)`);

  // ---- a day without the dark weathers' lamps; decal switches (bridge) ----
  await open('bridge');
  const br = await js(`(() => { const m = window.__xo.maps; return { lights: m.scene.lights.length, pool: m.lights.pool.length,
    lamps: m.models.filter((r) => r.def === 'Objects_Light_Projector1').reduce((a, r) => a + r.n, 0), lampPath: m.models.find((r) => r.def === 'Objects_Light_Projector1')?.path }; })()`);
  ok(br.lights === 0 && br.pool === 0, 'bridge by day: its projectors, flares and beams belong to the dark weathers, no lights (and no light in any shader)');
  ok(br.lamps > 0 && /projector_de\.mdl$/.test(br.lampPath || ''), `the projectors' lamps stand on their towers (${br.lamps}, ${br.lampPath?.split('/').pop()})`);
  await open('bridge', { environment: '181044', festival: 'Halloween' });
  const brn = await js(`(() => { const m = window.__xo.maps, s = m.scene.lights; const p = s.find((l) => l.kind === 'spot'), f = s.find((l) => l.kind === 'flare');
    const lamp = m.models.find((r) => r.def === 'Objects_Light_Projector1');
    let near = Infinity; if (lamp && p) for (let i = 0; i < lamp.n; i++) near = Math.min(near, Math.hypot(lamp.mats[i * 16 + 12] - p.pos[0], lamp.mats[i * 16 + 13] - p.pos[1], lamp.mats[i * 16 + 14] - p.pos[2]));
    return { spots: s.filter((l) => l.kind === 'spot').length, flares: s.filter((l) => l.kind === 'flare').length, beams: s.filter((l) => l.kind === 'beam').length, near, skin: lamp?.skin, down: p ? p.dir[1] : 0 }; })()`);
  ok(brn.spots === 7 && brn.flares === 7 && brn.beams === 7, `bridge at Halloween: ${brn.spots} projectors, ${brn.flares} flares, ${brn.beams} beams`);
  // (its default skin: 2.41's scene no longer asks for the yellow one)
  ok(brn.near < 1 && brn.skin === '' && brn.down < 0, `a projector shines down from its lamp (${brn.near.toFixed(2)} m from the lamp model, lit skin "${brn.skin}")`);
  await pose([100, 38, -30], [96.6, 36.3, -34.2]);
  await snap('02-bridge-tower-lamp');

  // ---- decals: what their presets allow, gloss, order (arena_football) ----
  await open('arena_football');
  const dec = await js(`(async () => { const q = window.__xo.maps.query; const buf = await (await fetch('https://xo.data/mapdecals?' + q)).arrayBuffer();
    const jl = new DataView(buf).getUint32(4, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jl)));
    const plates = new Set(head.decals.map((d, i) => (/plates2rust2/.test(d.name) ? i : -1)).filter((i) => i >= 0));
    let platesOnObjects = 0, platesOnGround = 0;
    for (let i = 0; i + 5 < head.meshes.length; i += 6) if (plates.has(head.meshes[i])) { if (head.meshes[i + 5] >= 0) platesOnObjects++; else platesOnGround++; }
    const fields = head.decals.every((d) => 'gloss' in d && 'metal' in d && 'layer' in d && 'sublayer' in d);
    const m = window.__xo.maps, meshes = m.decals.group.children;
    const order = meshes.map((x) => x.renderOrder), sorted = order.every((r) => r > 0.5 - 1e-9 && r < 1);
    const gloss = new Map(head.decals.map((d) => [d.name, d.gloss]));
    const matched = meshes.every((x) => Math.abs(x.material.roughness - (1 - gloss.get(x.name))) < 1e-6);
    return { plates: plates.size, platesOnObjects, platesOnGround, fields, sorted, matched }; })()`);
  ok(dec.plates > 0 && dec.platesOnObjects === 0, `metal/plates2rust2 (DrawMask onStatic false) stays off the ramps and walls: ${dec.plates} decals, ${dec.platesOnGround} pieces on the ground, ${dec.platesOnObjects} on objects`);
  ok(dec.fields, 'the decals carry their gloss, metal, layer and sublayer');
  ok(dec.sorted, 'decals are laid in the map\'s order, before the water');
  ok(dec.matched, 'each decal is as glossy as its preset says (roughness = 1 - UniformGloss)');

  // ---- objects found for their definitions (helicopter_asia_city) ----
  await open('helicopter_asia_city');
  const objs = await js(`(() => { const m = window.__xo.maps, un = new Set(m.scene.unresolved.map((u) => u[0])), by = (d) => m.models.filter((r) => r.def === d);
    const taxis = by('Breakable_Vehicle_City_TaxiEastBrokenBlue'), fences = by('Breakable_LifeItems_City_FenceMetal6m');
    return { un: m.scene.unresolved.reduce((a, u) => a + u[1], 0), taxi: taxis.reduce((a, r) => a + r.n, 0), taxiSkins: [...new Set(taxis.map((r) => r.skin))], fence: fences.reduce((a, r) => a + r.n, 0), fencePath: fences[0]?.path,
      gone: ['Breakable_LifeItems_City_FenceMetal6m', 'Breakable_LifeItems_City_FenceMetal3m', 'Breakable_Vehicle_City_TaxiEastBroken', 'Breakable_LifeItems_City_BusStop'].every((d) => !un.has(d)) }; })()`);
  ok(objs.fence > 50 && /street_mfence1_6m\.mdl$/.test(objs.fencePath || ''), `metal fences along the streets: ${objs.fence} pieces of street_mfence1_6m`);
  ok(objs.taxi > 0 && objs.taxiSkins.includes('blue'), `blue broken taxis wear the definition's colour (${objs.taxi}, skins ${objs.taxiSkins.join(', ')})`);
  ok(objs.gone, `fences, taxis and bus stops are no longer missing (${objs.un} placements still are)`);
  await open('hangar_china');
  const spelled = await js(`(() => { const m = window.__xo.maps, r = m.models.find((x) => x.def === 'Objects_HangarAziaMallBanner2'); return r ? r.path : null; })()`);
  ok(spelled === 'assets/props/hangar/hangar_azia/mall_banner_2.mdl', `a definition spelling out its model's path finds it (Objects_HangarAziaMallBanner2 -> ${spelled})`);
  // (the name match made Breakable_LifeItems_City_Parking a 144 m garage; its placements are named city_rect_parking_1.
  // The map's one real garage is a prop of props.mxml, not this definition's.)
  const park = await js(`(() => { const m = window.__xo.maps, r = m.models.filter((x) => x.def === 'Breakable_LifeItems_City_Parking');
    return { n: r.reduce((a, x) => a + x.n, 0), paths: [...new Set(r.map((x) => x.path))] }; })()`);
  ok(park.n === 4 && park.paths.join() === 'assets/props/life_items/cybereast/city_rect_parking_1.mdl', `parking posts, not garages: ${park.n} x ${park.paths.join(', ')}`);

  // ---- flickering lights (bentmetal's fires and lamps); its puddles shine ----
  await open('bentmetal');
  const wet = await js(`(() => { let n = 0; window.__xo.maps.decals.group.traverse((o) => { if (/puddle/.test(o.name) && o.material?.roughness < 0.1) n += o.userData.decals || 1; }); return n; })()`); // (a batched mesh holds several)
  ok(wet > 20, `bentmetal's puddles are glossy (${wet} decals at roughness under 0.1)`);
  await pose([-80, 8, -285], [-87, 2.5, -294.5]);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    await sleep(120);
    seen.push(await js(`(() => window.__xo.maps.lights.pool.filter((s) => s.rec && s.rec.flicker >= 0 && s.light.intensity > 0).map((s) => s.light.intensity).reduce((a, b) => a + b, 0))()`));
  }
  ok(seen[0] > 0 && new Set(seen.map((v) => v.toFixed(4))).size > 2, `flickering lights flicker (${seen.map((v) => v.toFixed(2)).join(', ')})`);

  // ---- lamps behind walls (tower in the rain: four 1500-power lamps inside two high-rises lit a
  // dozen floors' windows through the floors; the game's capture shows two or three red dots) ----
  await open('tower', { environment: '600893' }); // (its overcast: 2.41's tower has no night)
  const C = [25.94, 105.6, -19.36], th = 0.25 * 2 * Math.PI, pc = (-20 * Math.PI) / 180; // (the probe centre, u 0.75, 20 degrees down)
  await js(`(() => { const c = window.__xo.viewer.camera; window.__fov0 = c.fov; c.fov = 60; c.updateProjectionMatrix(); })()`);
  await pose(C, [C[0] + Math.cos(th) * Math.cos(pc) * 50, C[1] + Math.sin(pc) * 50, C[2] + Math.sin(th) * Math.cos(pc) * 50]);
  const waitShade = async () => { for (let i = 0; i < 80; i++) { if (!(await js(`(() => { const L = window.__xo.maps.lights; return L.shade.queue.length + L.pool.filter((s) => s.rec?.shadows && s.weight > 0 && s.drawn !== s.rec).length; })()`))) return; await frames(2); } };
  await waitShade();
  const packed = await js(`(async () => {
    const L = window.__xo.maps.lights, xl = await import('./xolights.js'), X = xl.XO_LIGHTS, v = window.__xo.viewer;
    v.render();
    const n = xl.litCount(), A = X.xoLtA.value, D = X.xoLtD.value;
    const at = (s) => { for (let k = 0; k < n; k++) if (Math.abs(A[k * 4] - s.light.position.x) < 1e-3 && Math.abs(A[k * 4 + 1] - s.light.position.y) < 1e-3 && Math.abs(A[k * 4 + 2] - s.light.position.z) < 1e-3) return k; return -1; };
    const lit = L.pool.filter((s) => s.rec && s.light.intensity > 0);
    let three = 0; v.scene.traverse((o) => { if (o.isPointLight || o.isSpotLight) three++; });
    return { lit: lit.length, n, three, ok: lit.every((s) => { const k = at(s); return k >= 0 && D[k * 4 + 1] === (s.rec.spec ? 1 : 0) && (D[k * 4 + 2] > 0) === (s.rec.shadows && s.drawn === s.rec); }) };
  })()`);
  ok(packed.ok && packed.lit > 0 && packed.n >= packed.lit && packed.three === 0, `the lit lamps go through the one shader loop with their shadows and gloss (${packed.lit} lamps, ${packed.n} lights packed, ${packed.three} three lights in the scene)`);
  const ls = await js(`(() => {
    const m = window.__xo.maps, L = m.lights, v = window.__xo.viewer, map = L.shade.light.shadow.map;
    const order = true, spec = true;
    // the atlas against rays from the lamps (the finest LOD's triangles) to points the camera sees
    const T = v.camera.position.constructor, TILE = L.shade.tile, COLS = L.shade.cols, buf = new Uint8Array(4), cam = v.camera;
    const depthAt = (block, d) => { let x = d.x, y = d.y, z = d.z; const s = 1 / Math.max(Math.abs(x), Math.abs(y), Math.abs(z)), t = 1 / (2 * TILE), one = 1 - 1.5 * t;
      const ax = Math.abs(x) * s, ay = Math.abs(y) * s, az = Math.abs(z) * s; x *= s * (1 - 2 * t); y *= s * (1 - 2 * t); z *= s * (1 - 2 * t);
      let px = x, py = y; if (az >= one) { if (z > 0) px = 4 - x; } else if (ax >= one) { const g = Math.sign(x); px = z * g + 2 * g; } else if (ay >= one) { const g = Math.sign(y); px = x + 2 * g + 2; py = z * g - 2; }
      v.renderer.readRenderTargetPixels(map, Math.floor((block % COLS) * 4 * TILE + (0.125 * px + 0.375) * 4 * TILE), Math.floor(Math.floor(block / COLS) * 2 * TILE + (0.25 * py + 0.75) * 2 * TILE), 1, 1, buf);
      return buf[0] / 256 + buf[1] / 65536 + buf[2] / 16777216 + buf[3] / 4278190080; };
    const lamps = L.pool.filter((s) => s.rec?.shadows && s.drawn === s.rec && s.rec.reach >= 30);
    let same = 0, blocked = 0, n = 0;
    const q = new T(), dir = new T();
    for (let iy = 0; iy < 22; iy++) for (let ix = 0; ix < 22; ix++) { // (the leaning high-rise's upper half)
      q.set(-0.64 + (0.24 * (ix + 0.5)) / 22, 0.86 - (0.7 * (iy + 0.5)) / 22, 0.5).unproject(cam);
      dir.copy(q).sub(cam.position).normalize();
      const h = m.segmentHit(cam.position.toArray(), cam.position.clone().addScaledVector(dir, 800).toArray(), { water: false });
      if (!h?.path) continue;
      const P = new T(...h.point).addScaledVector(dir, -0.02); // (on the side the camera sees)
      for (const s of lamps) {
        const d = P.clone().sub(s.rec.pos), len = d.length();
        if (len >= s.rec.reach - 0.2 || len <= s.rec.near + 0.2) continue;
        // the truth where it is clear: nothing on the way, or something a metre or more before the point
        const g = m.segmentHit(s.rec.pos.toArray(), P.toArray(), { water: false });
        const truth = !g || g.dist >= len - 0.01 ? false : g.dist < len - 1 ? true : null;
        if (truth === null) continue;
        const atlas = (len - 0.03 - s.rec.near) / (s.rec.reach - s.rec.near) > depthAt(s.block, d.normalize());
        n++; if (truth === atlas) same++; if (truth) blocked++;
      }
    }
    return { order, spec, lamps: lamps.length, n, same, blocked, drawn: L.shade.drawn, shadowed: L.points.concat(L.spots).filter((r) => r.shadows).length, all: L.points.length + L.spots.length };
  })()`);
  ok(ls.shadowed === ls.all && ls.lamps >= 3, `tower's lamps all keep their light off what is behind walls (${ls.shadowed}/${ls.all}: shadowsEnabled or enableSSCS), ${ls.lamps} of the high-rises' lamps drawn`);
  // (2.41's tower: 0.947; 2.40's above 0.95)
  ok(ls.n > 100 && ls.blocked > 50 && ls.same / ls.n > 0.93, `the lamps' shadows agree with rays from the lamps (${ls.same}/${ls.n} points, ${ls.blocked} behind floors and walls)`);
  // the high-rises' windows: orange through the floors without the shadows, fewer with them (what is
  // left is the broken top floors the lamps see directly: 0.44 -> 0.26 % at the probe's own framing)
  const orange = () => js(`(() => { const g = document.getElementById('view').getContext('webgl2'), w = g.drawingBufferWidth, h = g.drawingBufferHeight;
    const x0 = Math.floor(w * 0.18), y0 = Math.floor(h * 0.58), W = Math.floor(w * 0.14), H = Math.floor(h * 0.35), px = new Uint8Array(W * H * 4); g.readPixels(x0, y0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] > 90 && px[i] > px[i + 1] * 1.4 && px[i] > px[i + 2] * 1.6) n++; return n / (W * H); })()`);
  await frames(4);
  const shaded = await orange();
  await js(`(() => { const L = window.__xo.maps.lights; for (const r of L.points.concat(L.spots)) { r._sh = r.shadows; r.shadows = false; } L.apply(); window.__xo.viewer.dirty = true; })()`);
  await frames(4);
  const through = await orange();
  await js(`(() => { const L = window.__xo.maps.lights; for (const r of L.points.concat(L.spots)) r.shadows = r._sh; L.apply(); const c = window.__xo.viewer.camera; c.fov = window.__fov0; c.updateProjectionMatrix(); })()`);
  ok(through > 0.003 && shaded < through * 0.75, `the high-rises' windows no longer lit through the floors (orange ${(through * 100).toFixed(2)} % of the tower -> ${(shaded * 100).toFixed(2)} %)`);
  await snap('03-tower-lamps');

  ok(errors.length === 0, `no page errors (${errors.slice(0, 2).join(' | ')})`);
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
