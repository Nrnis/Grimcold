// End-to-end test of the builder's stickers (ui/stickers.js): the game's packs listed, a sticker picked
// and stuck on a cabin with a real click (the see-through one follows the cursor first), Q / E and
// - / + while sticking, Esc; undo / redo; the part card's count and "Take stickers off"; the build
// file keeps them and loading it brings them back; the export carries them (a mesh with the
// sticker's picture), and moving the part takes them along.
//   node tools/e2e_stickers.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const CABIN = 'models/constructor/cabins/buggy_start/buggy_start.mdl';

const app = await launch({ prefix: 'xo-e2e-stickers-' });
const { js, waitFor, key, mouse, click } = app;
const out = path.join(app.dataDir, 'out');
fs.mkdirSync(out, { recursive: true });
const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
const stickersOf = (id) => js(`(() => { const i = window.__xo.build.get(${id}); return { n: i.stickers.length, meshes: i.group.children.filter((c) => c.userData.sticker && c !== window.__xo.build.stickerPreview).length,
  tris: i.group.children.filter((c) => c.userData.sticker && c !== window.__xo.build.stickerPreview).reduce((k, c) => k + c.children.reduce((t, m) => t + m.geometry.attributes.position.count / 3, 0), 0) }; })()`);
try {
  await waitFor('window.__xoReady === true', 60000);
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 10000).catch(() => {});
  await settle();
  const cab = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(CABIN)}, position: [0, 0, 0] }); b.commit(); b.frame(); return i.id; })()`);
  await settle();
  await sleep(600);

  // ---- the packs and their pictures ----
  await waitFor(`document.querySelectorAll('#bStickerGrid button').length > 0`, 20000);
  const packs = await js(`[...document.getElementById('bStickerPack').options].map((o) => o.value)`);
  ok(packs.length > 50 && packs.includes('numbers') && packs.includes('factions'), `the game's sticker packs are listed (${packs.length})`);
  await js(`(() => { const s = document.getElementById('bStickerPack'); s.value = 'numbers'; s.dispatchEvent(new Event('change')); })()`);
  await waitFor(`document.querySelector('#bStickerGrid button')?.dataset.base?.startsWith('textures/stickers/numbers/')`, 10000);
  await waitFor(`[...document.querySelectorAll('#bStickerGrid img')].slice(0, 4).some((i) => i.complete && i.naturalWidth > 0)`, 20000).then(() => ok(true, 'its stickers show as pictures'), () => ok(false, 'its stickers show as pictures'));
  const base = await js(`document.querySelector('#bStickerGrid button').dataset.base`);
  await js(`document.querySelector('#bStickerGrid button').click()`);
  ok(await js(`window.__xo.build.stickerTool?.base === ${JSON.stringify(base)} && document.querySelector('#bStickerGrid button').classList.contains('on')`), `picking one takes it up (${base.split('/').pop()})`);

  // ---- the cursor over the cabin: the see-through one; a click sticks it ----
  const pt = await js(`(() => { const b = window.__xo.build.get(${cab}).box, c = b.getCenter(new (b.min.constructor)()); return window.__xo.viewer.project(c.x, c.y, b.max.z); })()`);
  await mouse('mouseMoved', pt.x - 4, pt.y);
  await sleep(60);
  await mouse('mouseMoved', pt.x, pt.y);
  await waitFor('!!window.__xo.build.stickerPreview', 10000).then(() => ok(true, 'the sticker, see-through, follows the cursor over the part'), () => ok(false, 'the sticker, see-through, follows the cursor over the part'));
  await click(pt.x, pt.y);
  await waitFor(`window.__xo.build.get(${cab}).stickers.length === 1`, 10000).catch(() => {});
  await settle();
  const s1 = await stickersOf(cab);
  ok(s1.n === 1 && s1.meshes === 1 && s1.tris > 2, `a click sticks it on the cabin (${s1.tris} triangles)`);
  // the way round it reads, as the camera sees it: the picture's right (u up) on the screen's right, its top (v up) higher
  const way = await js(`(() => { const i = window.__xo.build.get(${cab}), m = i.group.children.find((c) => c.userData.sticker && c !== window.__xo.build.stickerPreview).children[0], g = m.geometry, uv = g.attributes.uv, p = g.attributes.position, V = i.group.position.constructor;
    let lo = 0, hi = 0, bot = 0, top = 0;
    for (let k = 0; k < uv.count; k++) { if (uv.getX(k) < uv.getX(lo)) lo = k; if (uv.getX(k) > uv.getX(hi)) hi = k; if (uv.getY(k) < uv.getY(bot)) bot = k; if (uv.getY(k) > uv.getY(top)) top = k; }
    m.updateMatrixWorld(true); const at = (k) => { const w = new V().fromBufferAttribute(p, k).applyMatrix4(m.matrixWorld); return window.__xo.viewer.project(w.x, w.y, w.z); };
    return { left: at(lo).x, right: at(hi).x, bottom: at(bot).y, top: at(top).y }; })()`);
  ok(way.right > way.left && way.top < way.bottom, `it reads the right way round: not mirrored, not upside down (left ${Math.round(way.left)} < right ${Math.round(way.right)}, top ${Math.round(way.top)} above bottom ${Math.round(way.bottom)})`);
  await js(`window.__xo.build.select(${cab})`);
  await sleep(300);
  ok(await js(`!document.getElementById('bStickerRow').hidden && /^1 sticker$/.test(document.getElementById('bStickerCount').textContent)`), 'the part card counts it');

  // ---- keys while sticking ----
  const a0 = await js(`+document.getElementById('bStickerAngle').value`), s0 = await js(`+document.getElementById('bStickerSize').value`);
  await key('q');
  await key('+');
  const a1 = await js(`+document.getElementById('bStickerAngle').value`), sz1 = await js(`+document.getElementById('bStickerSize').value`);
  ok(a1 === a0 + 15 && sz1 > s0 && Math.abs(await js('window.__xo.build.stickerTool.angle') - (a1 * Math.PI) / 180) < 1e-6, `Q turns it 15°, + makes it bigger (${a0}° -> ${a1}°, ${s0} -> ${sz1} m)`);
  await key('Escape');
  ok(await js(`window.__xo.build.stickerTool === null && !window.__xo.build.stickerPreview`), 'Esc puts the sticker away');

  // ---- undo / redo ----
  await key('z', { ctrl: true });
  await settle();
  const u = await stickersOf(cab);
  await key('y', { ctrl: true });
  await settle();
  await sleep(300);
  const r = await stickersOf(cab);
  ok(u.n === 0 && u.meshes === 0 && r.n === 1 && r.meshes === 1, 'Ctrl+Z takes it off, Ctrl+Y puts it back');

  // ---- it moves with the part ----
  // (the sticker's middle in the world: its mesh's box through its matrix)
  const where = () => js(`(() => { const i = window.__xo.build.get(${cab}), s = i.group.children.find((c) => c.userData.sticker), m = s.children[0]; m.updateMatrixWorld(true); m.geometry.computeBoundingBox();
    return m.geometry.boundingBox.getCenter(new (i.group.position.constructor)()).applyMatrix4(m.matrixWorld).toArray(); })()`);
  const before = await where();
  await js(`window.__xo.build.setPosition(${cab}, [1.2, 0, 0])`);
  await settle();
  const moved = await where();
  ok(Math.abs(moved[0] - before[0] - 1.2) < 0.01 && Math.abs(moved[1] - before[1]) < 0.01, 'moving the part takes its sticker along');

  // ---- the file ----
  const file = await js('window.__xo.buildFile()');
  const fs1 = file.parts[0]?.stickers;
  ok(fs1?.length === 1 && fs1[0].base === base && fs1[0].pos.length === 3 && fs1[0].size > 0, 'the build file keeps it (its picture, place, size)');
  await js(`window.__xo.loadBuildFile(${JSON.stringify(file)})`);
  await settle();
  await sleep(500);
  const reloaded = await js(`(() => { const i = window.__xo.build.instances[0]; return { n: i.stickers.length, meshes: i.group.children.filter((c) => c.userData.sticker).length }; })()`);
  ok(reloaded.n === 1 && reloaded.meshes === 1, 'loading the file brings it back');
  const id2 = await js('window.__xo.build.instances[0].id');

  // ---- the export ----
  const glb = path.join(out, 'stickers.glb');
  const res = await js(`window.__xo.call('exportBuild', { parts: window.__xo.build.exportItems(), stickers: window.__xo.build.exportStickers(), name: 'stickers', format: 'glb', lod: 0, textures: true, outPath: ${JSON.stringify(glb)} })`);
  const buf = fs.existsSync(glb) ? fs.readFileSync(glb) : null;
  const doc = buf ? JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) : null;
  const mat = doc?.materials?.find((m) => /^sticker_numbers_/.test(m.name || ''));
  const tex = mat?.pbrMetallicRoughness?.baseColorTexture;
  ok(res && mat && tex && mat.alphaMode === 'BLEND' && doc.meshes.some((m) => /^sticker_/.test(m.name || '')), `the export carries it: a mesh with the sticker's picture (${mat?.name}, ${mat?.alphaMode})`);

  // ---- Take stickers off ----
  await js(`window.__xo.build.select(${id2})`);
  await js(`document.getElementById('bStickerClear').click()`);
  await settle();
  const off = await stickersOf(id2);
  await key('z', { ctrl: true });
  await settle();
  await sleep(300);
  const back = await stickersOf(id2);
  ok(off.n === 0 && off.meshes === 0 && back.n === 1 && back.meshes === 1, '"Take stickers off" takes it off, Ctrl+Z puts it back');
  const left = app.errors.filter(Boolean);
  ok(left.length === 0, `no page errors (${left.slice(0, 2).join(' | ')})`);
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
