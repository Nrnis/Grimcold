// Regression checks for the bugs a review of the whole app found on 2026-10-01, each set up the way
// it was found: the saved build survives opening the builder during start-up (H1), turning a part
// keeps it on the vehicle's grid (H2), a focused dropdown leaves the keys to the app (H3), a part
// inside another is refused (M1), the normal-map decode (M2), the viewer toolbar after a switch (M4),
// writes into the game folder (M7), navigation away from the app (M8), the last edit before closing
// (M9), camera clip planes (M10), the garage rules and the Symmetry plane.
//   node tools/e2e_fixes.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const FRAME = 'models/constructor/chassis/base/truck_base/truck_base_2x2.mdl';
const FRAME14 = 'models/constructor/chassis/base/truck_base/set_truck_base_1x4.mdl';
const CABIN = 'models/constructor/cabins/buggy_start/buggy_start.mdl';
const GUN = 'models/weapons/machinegun_smg/machinegun_smg.mdl';
const ENGINE = 'models/constructor/modules/engine_basic_common/engine_basic_common.mdl';
const MISSING = 'models/constructor/no_such_part/no_such_part.mdl';

// H1: a profile with a saved build (3 parts, plus one this game version doesn't have).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-e2e-fixes-'));
const autosavePath = path.join(dir, 'autosave.xobuild');
const savedParts = [
  { path: FRAME, skin: '', position: [0, 0.45, 0], quaternion: [0, 0, 0, 1], mirrored: false },
  { path: CABIN, skin: '', position: [0, 0.75, 0], quaternion: [0, 0, 0, 1], mirrored: false },
  { path: GUN, skin: '', position: [0, 2.4, 0], quaternion: [0, 0, 0, 1], mirrored: false },
  { path: MISSING, skin: '', position: [3, 0, 3], quaternion: [0, 0, 0, 1], mirrored: false },
];
fs.writeFileSync(autosavePath, JSON.stringify({ app: 'Grimcold', kind: 'build', version: 1, name: 'Keep me', parts: savedParts }));
const readAutosave = () => JSON.parse(fs.readFileSync(autosavePath, 'utf8'));

let app = await launch({ dataDir: dir });
try {
  const { js, waitFor, click, mouse } = app;
  const count = () => js('window.__xo.build.instances.length');
  const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
  const statusText = () => js(`document.getElementById('status').textContent`);
  const keyEvent = (type, k, extra = {}) => app.send('Input.dispatchKeyEvent', { type, key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Escape: 27 }[k] || 0, ...extra });
  const press = async (k, extra = {}) => { await keyEvent('keyDown', k, { text: k.length === 1 ? k : undefined, ...extra }); await keyEvent('keyUp', k); await sleep(60); };

  // ---- H1: the builder opened while the game is still being read -------------------------------
  for (let t = Date.now(); Date.now() - t < 20000; await sleep(20)) { try { if (await js('!!window.__xo')) break; } catch { /* page not up yet */ } }
  const early = !(await js('window.__xoReady === true'));
  await js(`window.__xo.setView('build')`);
  await waitFor('window.__xoReady === true', 60000);
  await waitFor('window.__xo.build.instances.length === 3', 60000);
  await settle();
  await sleep(1500); // longer than the autosave delay
  const kept = readAutosave();
  ok(kept.parts.length === 4 && kept.parts.some((p) => p.path === MISSING),
    `opening the builder ${early ? 'before the game was read' : '(the game was already read: timing not reproduced)'} restores the build (3 parts) and the saved file keeps all 4 entries, the missing part too`);
  ok((await statusText()).includes('could not be loaded'), 'the part that could not be loaded is named in a warning that stays');

  // ---- M2: the game's normal-map layouts are decoded in the shader that runs ---------------------
  // (a part's own material patches three's standard shader: both normal-map branches must decode)
  const nrm = await js(`(async () => { const THREE = await import('three'), b = window.__xo.build;
    const m = b.instances.flatMap((i) => i.group.userData.materials).find((x) => x.normalMap);
    if (!m) return null;
    const s = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {}, defines: {} };
    m.onBeforeCompile(s, window.__xo.viewer.renderer);
    const f = THREE.ShaderChunk.normal_fragment_maps.includes('USE_NORMALMAP_TANGENTSPACE') ? s.fragmentShader : '';
    return { decodes: (f.match(/xoNormal\\( texture2D\\( normalMap/g) || []).length, raw: (f.match(/texture2D\\( normalMap, vNormalMapUv \\)\\.xyz \\* 2\\.0 - 1\\.0/g) || []).length }; })()`);
  ok(nrm && nrm.decodes >= 2 && nrm.raw === 0, `normal maps go through the game's decode in both branches, tangent space included (${nrm?.decodes} decodes, ${nrm?.raw} plain reads left)`);

  // ---- the Symmetry plane runs through the middle of the cabin ----------------------------------
  const sym = await js(`(() => { const b = window.__xo.build, c = b.instances.find((i) => i.path === ${JSON.stringify(CABIN)}).box;
    b.setSymmetry(true); const r = { mx: b.mirrorX(), cx: (c.min.x + c.max.x) / 2, plane: b.symPlane.position.x }; b.setSymmetry(false); return r; })()`);
  ok(Math.abs(sym.mx - Math.round(sym.cx / 0.15) * 0.15) < 1e-9 && Math.abs(sym.plane - sym.mx) < 1e-9, `the Symmetry plane runs through the middle of the cabin (x = ${sym.mx.toFixed(2)})`);

  // ---- H3: a dropdown that has the focus leaves the keys to the app ------------------------------
  await js(`document.getElementById('bLightSel').focus()`);
  const light0 = await js(`document.getElementById('bLightSel').value`);
  const cam0 = await js('window.__xo.viewer.controls.target.toArray()');
  await keyEvent('keyDown', 's', { text: 's' });
  await sleep(450);
  await keyEvent('keyUp', 's');
  await sleep(350);
  const cam1 = await js('window.__xo.viewer.controls.target.toArray()');
  const moved = Math.hypot(...cam1.map((v, i) => v - cam0[i]));
  ok((await js(`document.getElementById('bLightSel').value`)) === light0 && moved > 0.2 && (await js(`document.activeElement !== document.getElementById('bLightSel')`)),
    `with the lighting dropdown focused, S moves the camera (${moved.toFixed(2)} m) and the dropdown stays "${light0}"`);
  await press('Home');

  // ---- H2: turning a selected part keeps it on the vehicle's grid --------------------------------
  // A 1x4 frame (odd one way, even the other) welded to a 2x2 one, turned a quarter about its middle.
  // Per axis the grid's cell boundaries fall on even or odd multiples of 0.15 m; the turn used to put
  // the part on the other ones (parity 010 -> 111, as found), half a cell off and unable to weld.
  const turned = async (where) => {
    await js(`window.__xo.build.clear()`);
    await settle();
    const base = await js(`(async () => { const b = window.__xo.build; const a = await b.createInstance({ path: ${JSON.stringify(FRAME)}, position: [0, 0.45, 0] }); b.commit(); b.frame(); return a.id; })()`);
    await waitFor('!window.__xo.viewer.tween', 5000);
    await js(`window.__xo.build.startPlacing(${JSON.stringify(FRAME14)})`);
    await waitFor('!!window.__xo.build.placing', 20000);
    const at = await js(`(() => { const b = window.__xo.build.get(${base}).box, v = window.__xo.viewer;
      return ${where === 'side'} ? v.project(b.max.x, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2) : v.project((b.min.x + b.max.x) / 2 + 0.05, b.max.y, (b.min.z + b.max.z) / 2 + 0.05); })()`);
    const x = where === 'side' ? at.x - 1 : at.x;
    await mouse('mouseMoved', x - 2, at.y);
    await sleep(80);
    await mouse('mouseMoved', x, at.y);
    await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
    await click(x, at.y);
    await waitFor('window.__xo.build.instances.length === 2', 20000);
    await press('Escape');
    await waitFor('!window.__xo.build.placing && !window.__xo.build.busy', 10000);
    const r = await js(`(() => { const b = window.__xo.build, f = b.instances[1], G = (i) => b.constructor.gridParity(i.slotsWorld).join('');
      const before = { groups: b.components().length, grid: G(f) };
      b.select(f.id); b.rotate('y', 1);
      return { before, after: { groups: b.components().length, grid: G(f) } }; })()`);
    await press('Escape');
    return r;
  };
  const side = await turned('side');
  ok(side.before.groups === 1 && side.after.grid === side.before.grid, `R on a 1x4 frame welded beside a 2x2 keeps it on the vehicle's grid (parity ${side.before.grid} -> ${side.after.grid}; it was 010 -> 111)`);
  const onTop = await turned('top');
  ok(onTop.before.groups === 1 && onTop.after.groups === 1 && onTop.after.grid === onTop.before.grid, `turned while lying on the 2x2, it stays on the grid and welded (groups ${onTop.before.groups} -> ${onTop.after.groups})`);
  const base = await js('window.__xo.build.instances[0].id');

  // ---- M1: a part that would sit inside another one is refused -----------------------------------
  const blockerY = await js(`window.__xo.build.get(${base}).group.position.y`);
  const blocker = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(FRAME)}, position: [2.4, ${blockerY}, 2.4] }); b.commit(); b.frame(); return i.id; })()`);
  await settle();
  await waitFor('!window.__xo.viewer.tween', 5000);
  await js(`window.__xo.build.startPlacing(${JSON.stringify(FRAME)})`);
  await waitFor('!!window.__xo.build.placing', 20000);
  // the ground half a part beside the blocker, on the camera's side (so the cursor sees the ground)
  const aim = await js(`(() => { const v = window.__xo.viewer, c = window.__xo.build.get(${blocker}).box.getCenter(v.camera.position.clone());
    const d = v.camera.position.clone().sub(c), ax = Math.abs(d.x) > Math.abs(d.z) ? [Math.sign(d.x), 0] : [0, Math.sign(d.z)];
    return v.project(c.x + ax[0] * 0.35, 0, c.z + ax[1] * 0.35); })()`);
  await mouse('mouseMoved', aim.x - 2, aim.y);
  await sleep(60);
  await mouse('mouseMoved', aim.x, aim.y);
  await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
  const n0 = await count();
  const red = await js('window.__xo.build.placing.valid === false');
  await click(aim.x, aim.y);
  await sleep(400);
  ok(red && (await count()) === n0 && (await statusText()).includes('overlaps') && (await js('!!window.__xo.build.placing')),
    'a frame pushed half into another turns red and is not dropped (the parts\' own collision hulls decide); the status line says why');
  await press('Escape');
  await js(`(() => { const b = window.__xo.build; b.removeInstance(b.get(${blocker})); b.commit(); })()`);
  await settle();

  // ---- the garage's rules: one cabin, one engine, 80 parts ---------------------------------------
  await js(`(async () => { const b = window.__xo.build; await b.createInstance({ path: ${JSON.stringify(CABIN)}, position: [0, 0.75, 0] }); b.commit(); })()`);
  await settle();
  const rules = await js(`(() => { const b = window.__xo.build; return { cabin: b.rules([{ path: ${JSON.stringify(CABIN)} }]), engine: b.rules([{ path: ${JSON.stringify(ENGINE)} }, { path: ${JSON.stringify(ENGINE)} }]),
    many: b.rules(new Array(81).fill({ path: ${JSON.stringify(GUN)} })), fine: b.rules([{ path: ${JSON.stringify(GUN)} }]) }; })()`);
  ok(/one cabin/.test(rules.cabin) && /one engine/.test(rules.engine) && /80 parts/.test(rules.many) && rules.fine === null,
    `the garage's rules: "${rules.cabin}" / "${rules.engine}" / "${rules.many}"`);
  const loose = await js(`(() => { const b = window.__xo.build, cab = b.instances.find((i) => b.isCabin(i.path));
    cab.group.position.set(4.2, cab.group.position.y, 4.2); b.updateInstance(cab); b.commit();
    return { loose: b.loose.size, parts: b.instances.length, cabinLoose: b.loose.has(cab.id), panel: document.getElementById('bGroups').textContent }; })()`);
  await js('window.__xo.build.undo()');
  await settle();
  ok(loose.parts === 3 && loose.loose === 2 && !loose.cabinLoose, 'parts not welded to the cabin are the loose ones (red), even when they outnumber it');

  // ---- keys: X held down mirrors once (no auto-repeat) -------------------------------------------
  await js(`window.__xo.build.select(window.__xo.build.instances[1].id)`);
  const mir0 = await js('window.__xo.build.instances[1].mirrored');
  await keyEvent('keyDown', 'x', { text: 'x' });
  for (let i = 0; i < 4; i++) { await sleep(40); await keyEvent('keyDown', 'x', { text: 'x', autoRepeat: true }); }
  await keyEvent('keyUp', 'x');
  await sleep(100);
  ok((await js('window.__xo.build.instances[1].mirrored')) === !mir0, 'holding X mirrors once (its auto-repeat is ignored)');
  await js('window.__xo.build.undo()');
  await settle();
  await press('Escape');

  // ---- leaving the builder in the middle of a pickup ----------------------------------------------
  js(`window.__xo.build.startPlacing(${JSON.stringify(GUN)})`).catch(() => {});
  await js(`window.__xo.setView('part')`);
  await sleep(1500);
  await js(`window.__xo.setView('build')`);
  await sleep(200);
  ok(!(await js('window.__xo.build.placing')) && (await js('window.__xo.viewer.hoverEnabled')) === true, 'switching views during a pickup drops the pickup and keeps hovering on');

  // ---- M10: the camera's clip planes belong to each view -----------------------------------------
  const clip0 = await js('[window.__xo.viewer.camera.near, window.__xo.viewer.camera.far]');
  await js(`window.__xo.state.stats = null`);
  await js(`window.__xo.openModel(${JSON.stringify(GUN)})`);
  await waitFor(`window.__xo.state.view === 'part' && !!window.__xo.state.stats`, 30000);
  await sleep(300);
  const clipPart = await js('[window.__xo.viewer.camera.near, window.__xo.viewer.camera.far]');
  await js(`window.__xo.setView('build')`);
  const clip1 = await js('[window.__xo.viewer.camera.near, window.__xo.viewer.camera.far]');
  ok(clip1[0] === clip0[0] && clip1[1] === clip0[1], `the builder gets its own clip planes back (far ${clip0[1].toFixed(1)} m; the viewer used ${clipPart[1].toFixed(1)} m)`);

  // ---- M4: leaving the 3D Viewer while a part loads ----------------------------------------------
  await js(`window.__xo.setView('part')`);
  await js(`(() => { window.__xo.state.stats = null; window.__m4 = window.__xo.openModel(${JSON.stringify(CABIN)}, { lod: 1 }); })()`);
  await waitFor(`window.__xo.state.info && window.__xo.state.info.path === ${JSON.stringify(CABIN)}`, 30000);
  await js(`window.__xo.setView('build')`);
  await js('window.__m4');
  await sleep(200);
  ok((await js(`document.getElementById('viewTools').hidden && document.getElementById('inspector').hidden`)), "the viewer's toolbar stays away when the load finishes in the builder");

  // ---- M7: nothing is written into the game folder -----------------------------------------------
  const fakeGame = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-fake-game-'));
  const realGameDir = (await js(`window.__xo.call('init', {})`)).settings.gameDir || '';
  await js(`window.__xo.call('setSettings', { gameDir: ${JSON.stringify(fakeGame)} })`);
  const refused = async (cmd, args) => js(`window.__xo.call(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(() => 'written', (e) => e.message)`);
  const r1 = await refused('saveText', { text: 'x', ext: 'txt', outPath: path.join(fakeGame, 'sub', 'look.txt') });
  const r2 = await refused('exportBuild', { parts: [{ path: GUN, skin: '', name: 'g', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }], name: 'g', format: 'glb', lod: 0, textures: false, outPath: path.join(fakeGame, 'data', 'g.glb') });
  const r3 = await refused('extract', { paths: [GUN], dir: path.join(fakeGame, 'data') });
  const r4 = await refused('saveText', { text: 'x', ext: 'txt', outPath: path.join(dir, 'out', 'look.txt') });
  // the builder's Save (to the file a build came from, no dialog) is held to the same rule, and only
  // ever writes a file of the kind asked for
  const r5 = await refused('saveText', { text: '{}', ext: 'xobuild', path: path.join(fakeGame, 'b.xobuild') });
  const odd = path.join(dir, 'out', 'odd.txt'), meant = path.join(dir, 'out', 'meant.xobuild');
  const r6 = await refused('saveText', { text: '{}', ext: 'xobuild', path: odd, outPath: meant });
  const left = fs.readdirSync(fakeGame);
  ok([r1, r2, r3, r5].every((r) => /game folder/.test(r)) && left.length === 0 && r4 === 'written' && r6 === 'written' && !fs.existsSync(odd) && fs.existsSync(meant),
    `saving, exporting or extracting into the game folder is refused ("${r1}"; the builder's Save too), elsewhere it works; Save never writes another kind of file`);
  await js(`window.__xo.call('setSettings', { gameDir: ${JSON.stringify(realGameDir)} })`);
  fs.rmSync(fakeGame, { recursive: true, force: true });

  // ---- one window per data folder: a second start ends at once (two shared one autosave) ----------
  {
    const t0 = Date.now();
    const second = spawn(path.join(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', 'Grimcold.exe'), ['--data-dir', dir, '--headless', '--size', '800,600'], { stdio: 'ignore' });
    const code = await Promise.race([new Promise((r) => second.once('exit', (c) => r(c))), sleep(15000).then(() => 'still running')]);
    if (code === 'still running') second.kill();
    ok(code === 0 && Date.now() - t0 < 15000 && (await js('window.__xoReady === true')), `a second start on the same data folder ends at once (exit ${code} after ${Date.now() - t0} ms), the first keeps running`);
  }

  // ---- M8: the page can't be sent anywhere else ---------------------------------------------------
  await js(`setTimeout(() => { location.href = 'file:///C:/Windows/win.ini'; }, 0)`);
  await sleep(1500);
  ok((await js('location.href')).startsWith('https://xo.app/') && (await js('window.__xoReady === true')), 'a navigation away from the app (e.g. a dropped file) is cancelled');

  // ---- second review round -----------------------------------------------------------------------
  // overlap depth: a thin shape enclosed by a thick one is deep in it (not just "as thick as it is");
  // a part without hulls keeps its size along its thick sides
  const thin = await js(`(async () => { const P = await import('./phys.js'), THREE = await import('three'), B = (a, b) => new THREE.Box3(new THREE.Vector3(...a), new THREE.Vector3(...b));
    const big = P.boxHull(B([-0.15, -0.15, -0.15], [0.15, 0.15, 0.15]), 0), plate = P.boxHull(B([-0.1, -0.01, -0.1], [0.1, 0.01, 0.1]), 0);
    const flat = P.boxHull(B([-0.5, -0.04, -0.5], [0.5, 0.04, 0.5])).box.getSize(new THREE.Vector3()).toArray();
    return { depth: P.hullDepth(plate, big), overlap: P.partsOverlap([plate], [big]), flat }; })()`);
  ok(thin.depth > 0.1 && thin.overlap && thin.flat[0] > 0.85 && thin.flat[2] > 0.85,
    `a 2 cm plate inside a 30 cm block is ${(thin.depth * 100).toFixed(0)} cm deep in it (refused), and a thin part without hulls keeps its size (${thin.flat.map((v) => v.toFixed(2)).join(' x ')} m)`);

  // Symmetry: two frames moved as a group along their row; their twins follow together (one twin
  // was blocked by the other, which was about to move away)
  await js(`window.__xo.build.clear()`);
  await settle();
  const row = await js(`(async () => { const b = window.__xo.build, y = 0.45, ids = [];
    for (const [x, z, m] of [[-0.6, 0, false], [-0.6, 0.6, false], [0.6, 0, true], [0.6, 0.6, true]]) ids.push((await b.createInstance({ path: ${JSON.stringify(FRAME)}, position: [x, y, z], mirrored: m })).id);
    b.commit(); b.setSymmetry(true); b.setSelection([ids[0], ids[1]]);
    await b.startPlacingGroup([b.get(ids[0]), b.get(ids[1])], { move: true });
    const p = b.placing; p.ghost.position.copy(p.origin).add(p.origin.clone().set(0, 0, 0.6)); p.ghost.quaternion.identity(); p.hasPos = true; p.valid = true;
    const done = await b.commitPlacing();
    const r = { done, twins: [ids[2], ids[3]].map((id) => +b.get(id).group.position.z.toFixed(3)), status: document.getElementById('status').textContent };
    b.setSymmetry(false); return r; })()`);
  ok(row.done && row.twins[0] === 0.6 && row.twins[1] === 1.2 && !row.status.includes('stayed'), `moving a row of two frames along itself with Symmetry on takes both twins along (twins now at z = ${row.twins.join(', ')})`);

  // Symmetry: a part dropped on the mirror plane can't take its twin along; the twin stays, so the
  // part must not land on it
  await js(`window.__xo.build.clear()`);
  await settle();
  const pair = await js(`(async () => { const b = window.__xo.build;
    const a = await b.createInstance({ path: ${JSON.stringify(FRAME)}, position: [-0.3, 0.45, 0] }), t = await b.createInstance({ path: ${JSON.stringify(FRAME)}, position: [0.3, 0.45, 0], mirrored: true });
    b.commit(); b.setSymmetry(true);
    const v = window.__xo.viewer; v.tween = null; v.camera.position.set(0, 9, 0.01); v.controls.target.set(0, 0, 0); v.controls.update(); v.render();
    await b.startPlacing(${JSON.stringify(FRAME)}, '', { moveId: a.id, twinId: t.id });
    return { a: a.id, t: t.id, at: v.project(-0.05, 0, 0) }; })()`); // (just off the twin's edge: the cursor sees the ground)
  await mouse('mouseMoved', pair.at.x + 3, pair.at.y);
  await sleep(60);
  await mouse('mouseMoved', pair.at.x, pair.at.y);
  await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
  const onPlane = await js(`(() => { const b = window.__xo.build, p = b.placing; return { x: +p.ghost.position.x.toFixed(3), twinShown: p.twin?.visible, valid: p.valid }; })()`);
  await click(pair.at.x, pair.at.y);
  await sleep(300);
  const afterDrop = await js(`(() => { const b = window.__xo.build, r = { stillHeld: !!b.placing, ax: +b.get(${pair.a}).group.position.x.toFixed(3) }; b.cancelPlacing(); b.setSymmetry(false); return r; })()`);
  ok(onPlane.x === 0 && !onPlane.twinShown && onPlane.valid === false && afterDrop.stillHeld && afterDrop.ax === -0.3,
    `moving a part onto the mirror plane, where its twin can't follow, is refused while the twin is in the way (${JSON.stringify({ ...onPlane, ...afterDrop })})`);

  // exports: an existing file another program holds locked fails the export whole, before anything is replaced
  const lockDir = path.join(dir, 'locked');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockGltf = path.join(lockDir, 'gun.gltf'), lockBin = path.join(lockDir, 'gun.bin');
  fs.writeFileSync(lockGltf, 'old gltf');
  fs.writeFileSync(lockBin, 'old bin');
  const holder = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${lockBin}', 'Open', 'Read', 'None'); 'locked'; Start-Sleep -Seconds 30; $f.Close()`], { windowsHide: true });
  await new Promise((r) => holder.stdout.once('data', r));
  const lockRes = await js(`window.__xo.call('export', { path: ${JSON.stringify(GUN)}, format: 'gltf', lod: 0, textures: false, outPath: ${JSON.stringify(lockGltf)} }).then(() => 'written', (e) => e.message)`);
  holder.kill();
  const leftParts = fs.readdirSync(lockDir).filter((f) => f.endsWith('.part'));
  ok(lockRes !== 'written' && fs.readFileSync(lockGltf, 'utf8') === 'old gltf' && leftParts.length === 0,
    `an export whose .bin is locked by another program fails ("${lockRes}") and leaves the old files and no temp files`);

  // a half-loaded build is never autosaved; the red outline is the red it says
  const half = await js(`(() => { const s = window.__xo.state; s.loadingBuild = true; const a = window.__xoFlush(); s.loadingBuild = false; return { during: a, after: typeof window.__xoFlush() }; })()`);
  const redLine = await js(`window.__xo.viewer.post.maskMaterial(0xff5a4f).uniforms.color.value.toArray().map((v) => Math.round(v * 255))`);
  ok(half.during === null && half.after === 'string' && redLine.join() === '255,90,79', `no autosave text while a build is loading; the outline's red is ${redLine.join(', ')} as given`);

  // ---- M9: an edit right before closing is not lost -----------------------------------------------
  await js(`(async () => { const b = window.__xo.build; await b.createInstance({ path: ${JSON.stringify(GUN)}, position: [0, 2.4, 0] }); b.commit(); })()`);
  const want = await count();
  const exited = new Promise((r) => app.proc.once('exit', r));
  await js(`window.__xo.call('quit', {})`).catch(() => {});
  const t0 = Date.now();
  const gone = await Promise.race([exited.then(() => true), sleep(10000).then(() => false)]);
  const last = readAutosave();
  const loaded = last.parts.filter((p) => p.path !== MISSING).length;
  ok(gone && loaded === want, `closing the window right after an edit saves it (${loaded} of ${want} parts in the autosave, closed in ${Date.now() - t0} ms)`);
  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  await app.close({ keep: true });
  if (!(await removeDir(dir))) console.log('note: could not delete ' + dir);
}
console.log(failures ? `${failures} failure(s)` : 'all fix checks passed');
process.exit(failures ? 1 : 0);
