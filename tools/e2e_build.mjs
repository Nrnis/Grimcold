// End-to-end test of the Vehicle Builder with real mouse clicks and key presses:
// frame on the grid, cabin on top, wheels with symmetry, weapon rotated, select/delete/undo/redo,
// move, save + reopen, export (validated), paint, and autosave across an app restart.
//   node tools/e2e_build.mjs [--snap-dir <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, removeDir, ROOT } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
const shot = (n) => (snapDir ? path.join(snapDir, n + '.png') : null);
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const FRAME = 'models/constructor/chassis/base/truck_base/truck_base_2x2.mdl';
const CABIN = 'models/constructor/cabins/buggy_start/buggy_start.mdl';
const WHEEL = 'models/constructor/chassis/wheels/wheel_r17.mdl';
const GUN = 'models/weapons/machinegun_smg/machinegun_smg.mdl';

let app = await launch({ prefix: 'xo-e2e-build-' });
const out = path.join(app.dataDir, 'out');
fs.mkdirSync(out, { recursive: true });
const { js, waitFor, click, key, mouse, drag } = app;
const CTRL = 2, SHIFT = 8; // DevTools modifier bits
const count = () => js('window.__xo.build.instances.length');
const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
// aim at a world point of an instance's box: fx/fy/fz in 0..1 across the box
const aimAt = async (id, fx, fy, fz) => js(`(() => { const i = window.__xo.build.get(${id}); const b = i.box; return window.__xo.viewer.project(b.min.x + (b.max.x - b.min.x) * ${fx}, b.min.y + (b.max.y - b.min.y) * ${fy}, b.min.z + (b.max.z - b.min.z) * ${fz}); })()`);
// a spot on the ground next to the vehicle where the cursor hits no part
const freeGroundPoint = () => js(`(() => { const b = window.__xo.build.box(), r = document.getElementById('view').getBoundingClientRect(), top = document.getElementById('buildTools').getBoundingClientRect().bottom;
  const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
  for (const [x, z] of [[b.max.x + 1.2, cz], [b.min.x - 1.2, cz], [cx, b.max.z + 1.2], [cx, b.min.z - 1.2], [b.max.x + 0.8, b.max.z + 0.8]]) {
    const p = window.__xo.viewer.project(x, 0, z);
    if (p.inFront && p.x > r.left + 30 && p.x < r.right - 30 && p.y > top + 30 && p.y < r.bottom - 70 && !window.__xo.build.instanceAt({ clientX: p.x, clientY: p.y })) return p;
  } return null; })()`);
async function place(pt) {
  await waitFor('!!window.__xo.build.placing', 20000);
  await mouse('mouseMoved', pt.x - 3, pt.y - 3);
  await sleep(80);
  await mouse('mouseMoved', pt.x, pt.y);
  await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
  const before = await count();
  await click(pt.x, pt.y);
  await waitFor(`window.__xo.build.instances.length > ${before} || (window.__xo.build.placing && window.__xo.build.placing.moveId != null)`, 20000);
  await settle();
}

try {
  await waitFor('window.__xoReady === true', 60000);
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 10000).catch(() => {}); // (the saved build, if any, comes back first)
  ok(await js(`!document.getElementById('buildPanel').hidden && !document.getElementById('buildEmpty').hidden`), 'builder opens with an empty build');
  await app.snap(shot('b01-empty'));

  // Frame: pick it from the list (Base: cabins and frames, as the game's menu has them), drop it on the grid centre
  await js(`document.querySelector('.cats button[data-cat="Cabins"]').click()`);
  await sleep(150);
  const row = await js(`(() => { const i = window.__xo.state.rows.findIndex(r => r.type === 'folder' && r.f.dir === ${JSON.stringify(path.posix.dirname(FRAME))}); if (i < 0) return -1; window.__xo.revealRow(i); return i; })()`);
  ok(row >= 0, 'frame folder found in the Base list');
  await sleep(150);
  await js(`document.querySelector('#list .row-item[data-i="${row}"]').click()`);
  await waitFor('!!window.__xo.build.placing', 20000);
  const placingPath = await js('window.__xo.build.placing.path');
  ok(placingPath === FRAME, `clicking the list row puts the part on the cursor (${placingPath})`);
  const centre = await js('window.__xo.viewer.project(0, 0, 0)');
  await place(centre);
  ok((await count()) === 1, 'frame dropped on the grid');
  const frameId = await js('window.__xo.build.instances[0].id');
  const fpos = await js(`window.__xo.build.instances[0].group.position.toArray()`);
  ok(fpos.every((v) => Math.abs(v / 0.15 - Math.round(v / 0.15)) < 1e-6), `frame origin on the 0.15 m lattice (${fpos.map((v) => v.toFixed(2)).join(', ')})`);

  // Cabin on top of the frame: must snap onto the frame's top slots and count as attached
  await js(`window.__xo.build.startPlacing(${JSON.stringify(CABIN)})`);
  await place(await aimAt(frameId, 0.5, 1.0, 0.5));
  ok((await count()) === 2, 'cabin dropped on the frame');
  const cab = await js(`(() => { const b = window.__xo.build; const i = b.instances[1]; return { snapped: b.lastPlaced === i.id, groups: b.components().length, y: i.box.min.y, top: b.get(${frameId}).box.max.y }; })()`);
  ok(cab.groups === 1, `cabin is attached to the frame at connection slots (groups: ${cab.groups})`);
  await app.snap(shot('b02-frame-cabin'));

  // Wheels on the side with symmetry: one click places both sides
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  await js(`window.__xo.build.startPlacing(${JSON.stringify(WHEEL)})`);
  await waitFor('!!window.__xo.build.placing && (!window.__xo.build.symmetry || !!window.__xo.build.placing.twin)', 20000);
  await place(await aimAt(frameId, 1.0, 0.5, 0.25));
  const afterWheels = await count();
  ok(afterWheels === 4, `symmetry placed a wheel on both sides (${afterWheels} parts)`);
  const mirrored = await js('window.__xo.build.instances.filter(i => i.mirrored).length');
  ok(mirrored === 1, 'the twin wheel is mirrored');
  const wx = await js('window.__xo.build.instances.slice(2).map(i => i.group.position.x)');
  ok(Math.abs(wx[0] + wx[1]) < 1e-6, `twin sits mirrored across the centre (x = ${wx.map((v) => v.toFixed(2)).join(' / ')})`);
  const wheelGroups = await js('window.__xo.build.components().length');
  ok(wheelGroups === 1, `both wheels snap onto side slots of the vehicle (auto-turned to face it; groups: ${wheelGroups})`);
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
  await key('Escape');

  // Weapon rotated with R before dropping it on the cabin roof
  await js(`window.__xo.build.startPlacing(${JSON.stringify(GUN)})`);
  await waitFor('!!window.__xo.build.placing', 20000);
  const cabId = await js('window.__xo.build.instances[1].id');
  const roof = await aimAt(cabId, 0.5, 1.0, 0.5);
  await mouse('mouseMoved', roof.x, roof.y);
  await key('r');
  const q = await js('window.__xo.build.placing.quat.toArray()');
  ok(Math.abs(Math.abs(q[1]) - Math.SQRT1_2) < 1e-6, 'R turns the part 90° around Y while placing');
  await mouse('mouseMoved', roof.x + 1, roof.y);
  await sleep(150);
  const ghostW = await js(`(() => { const p = window.__xo.build.placing, m = p && p.weldMesh, o = p && p.mateMesh, vm = p && p.vehicleWelds; if (!m || !o || !vm) return null;
    const e = vm.instanceMatrix.array; let hidden = 0;
    for (let i = 0; i < vm.count; i++) if (Math.abs(e[i * 16]) + Math.abs(e[i * 16 + 1]) + Math.abs(e[i * 16 + 2]) < 1e-9) hidden++;
    return { free: m.count, mates: o.count, kind: o.userData.weldKind, tex: o.material.uniforms.map.value.name, snapped: p.snapped, vehicle: vm.count, hidden }; })()`);
  ok(ghostW && ghostW.mates > 0 && ghostW.kind === 'mate' && ghostW.snapped && ghostW.vehicle > ghostW.mates && ghostW.hidden === ghostW.mates,
    `while placing, the vehicle's weld points the part will weld onto turn orange (${ghostW?.mates}, "${ghostW?.tex}"), the white ones there step aside (${ghostW?.hidden}), and the other ${(ghostW?.vehicle ?? 0) - (ghostW?.hidden ?? 0)} vehicle points and ${ghostW?.free} free points of the part stay white`);
  const held = await js(`(() => { const p = window.__xo.build.placing, o = window.__xo.viewer.outlines, m = p.ghost.userData.materials[0];
    return { ghost: o.some((x) => x.object === p.ghost && x.color === 0xffffff), target: o.some((x) => x.object === p.onPart?.group), onCab: p.onPart?.id === ${cabId},
      tint: m.userData.xo.u.xoOverlay.value.getHex(), opacity: m.opacity }; })()`);
  ok(held.ghost && held.target && held.onCab && held.tint === 0xdde9ff && held.opacity === 0.5,
    'the held part is a see-through whitish ghost with a white outline, and the cabin it goes on is outlined too (as in the garage)');
  await place(roof);
  ok((await count()) === 5, 'weapon dropped on the cabin');
  const weldState = await js(`(() => { const b = window.__xo.build; return { loose: b.loose.size, groups: b.components().length, free: b.weldMarks.children.reduce((a, m) => a + m.count, 0), on: document.getElementById('bAR').classList.contains('on'),
    tinted: b.instances.filter((i) => i.group.userData.materials.some((m) => m.userData.xo.u.xoOverlayAmt.value > 0)).length }; })()`);
  ok(weldState.on && weldState.free > 0 && weldState.groups === 1 && weldState.loose === 0 && weldState.tinted === 0,
    `the vehicle's free weld points are shown (${weldState.free}) and no part is tinted as loose`);
  const gunGroups = await js('window.__xo.build.components().length');
  ok(gunGroups === 1, `weapon attached to the cabin roof (groups: ${gunGroups})`);
  await key('Escape');
  await app.snap(shot('b03-vehicle'));
  const loose = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(GUN)}, position: [3.0, 0, 3.0] }); b.commit();
    return { loose: b.loose.has(i.id), amt: i.group.userData.materials[0].userData.xo.u.xoOverlayAmt.value }; })()`);
  ok(loose.loose && loose.amt > 0.2, `a part that is not welded to the vehicle is tinted red (overlay ${loose.amt})`);
  await js('window.__xo.build.undo()');
  await settle();
  ok((await count()) === 5 && (await js('window.__xo.build.loose.size')) === 0, 'undo takes it away again');
  const gunArc = await js(`(() => { const b = window.__xo.build, g = b.instances.find((i) => i.path === ${JSON.stringify(GUN)}).group, a = g.children.find((c) => c.name === 'arc');
    return a ? { visible: a.visible, yaw: a.userData.aim.yaw } : null; })()`);
  ok(gunArc && gunArc.visible, `the weapon on the vehicle shows its firing arc (turns ${gunArc?.yaw.join('..')}°)`);
  // F: augmented reality, as in the garage: the weld points and the firing arcs together
  const arState = () => js(`(() => { const b = window.__xo.build; return { welds: b.weldMarks.children.reduce((a, m) => a + m.count, 0),
    arcs: b.instances.some((i) => i.group.children.some((c) => c.name === 'arc' && c.visible)), btn: document.getElementById('bAR').classList.contains('on'),
    springs: b.wheelMarks.group.children.filter((c) => c.isMesh && c.geometry === b.wheelMarks.parts?.spring).length,
    size: !document.getElementById('bArcSizeWrap').hidden }; })()`);
  await key('f');
  await sleep(100);
  const arOff = await arState();
  await key('f');
  await waitFor('window.__xo.build.wheelMarks.group.children.length > 0', 10000).catch(() => {});
  const arOn = await arState();
  ok(arOff.welds === 0 && !arOff.arcs && !arOff.btn && arOff.springs === 0 && arOn.welds > 0 && arOn.arcs && arOn.btn && arOn.springs === 2,
    `F turns augmented reality off (no weld points, firing arcs or wheel springs) and on again (${arOn.welds} weld points, the game's suspension spring on each of the ${arOn.springs} wheels)`);
  { // Arc size (the 3D Viewer's setting too): every arc on the vehicle is its weapon's size times it
    const arcScale = () => js(`(() => { const b = window.__xo.build, a = b.instances.find((i) => i.path === ${JSON.stringify(GUN)}).group.children.find((c) => c.name === 'arc');
      return { r: a.scale.x / a.userData.base, label: document.getElementById('bArcSizeVal').textContent, viewer: +document.getElementById('arcSize').value }; })()`);
    const before = await arcScale();
    await js(`(() => { const s = document.getElementById('bArcSize'); s.value = 0.6; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
    const after = await arcScale();
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8')).arcSize;
    await js(`(() => { const s = document.getElementById('bArcSize'); s.value = 1.2; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
    ok(arOn.size && !arOff.size && Math.abs(before.r - 1.2) < 1e-6 && before.label === '120%' && Math.abs(after.r - 0.6) < 1e-6 && after.label === '60%' && after.viewer === 0.6 && saved === 0.6,
      `the Arcs slider next to Aug. reality (shown with it) sizes the vehicle's firing arcs: ${before.label} of each weapon's size by default, ${after.label} when moved (the 3D Viewer's slider follows, remembered)`);
    const gunCones = () => js(`(() => { const a = window.__xo.build.instances.find((i) => i.path === ${JSON.stringify(GUN)}).group.children.find((c) => c.name === 'arc');
      return { has: !!a.userData.cones, on: !!a.userData.cones?.visible, viewerBox: document.getElementById('arcCones').checked }; })()`);
    await js(`(() => { const s = document.getElementById('bArcCones'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
    const off = await gunCones();
    await js(`(() => { const s = document.getElementById('bArcCones'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
    const on = await gunCones();
    ok(off.has && !off.on && !off.viewerBox && on.on && on.viewerBox, `the builder's Cones box takes the cones off the vehicle's firing arcs and puts them back (the 3D Viewer's box follows)`);
  }

  { // the garage: its own names stay in this block
  // ---- the garage HUD: energy bar, part card, vehicle stats ----
  const G = 'window.__xo.garage';
  const cabItem = await js(`${G}.stats.item(${JSON.stringify(CABIN)})`), gunItem = await js(`${G}.stats.item(${JSON.stringify(GUN)})`);
  const bar = await js(`[...document.querySelectorAll('#energyBar .eb-cell b')].map((b) => b.textContent)`);
  const want = ['0', `−${gunItem.cost}`, `+${cabItem.power - gunItem.cost}`, `+${cabItem.power}`, ''];
  ok(JSON.stringify(bar) === JSON.stringify(want), `energy bar: modules, weapons, free, cabin, generators = ${bar.join(' | ')} (${cabItem.name} gives ${cabItem.power}, ${gunItem.name} uses ${gunItem.cost})`);
  const icons = await js(`[...document.querySelectorAll('#energyBar .gi')].filter((g) => g.querySelector('svg')).length`);
  ok(icons === 5, `the energy bar uses the game's own icons (${icons} of 5 loaded from its archives)`);
  const veh = await js(`${G}.vehicle()`);
  ok(veh.parts === 5 && veh.durability === cabItem.hp && veh.energy.free === cabItem.power - gunItem.cost && veh.massLimit === cabItem.massLimit && veh.speed === cabItem.speed && veh.unknown === 2,
    `vehicle stats: durability ${veh.durability}, energy ${veh.energy.used}/${veh.energy.supply}, mass ${veh.mass}/${veh.massLimit} kg, ${veh.speed} km/h (2 wheels without stats noted)`);
  const card0 = await js(`document.getElementById('bVehicle').textContent`);
  ok(card0.includes('5/80') && card0.includes(`${veh.energy.used}/${veh.energy.supply} pts`), 'the builder panel shows the vehicle stats');
  const gunInst = await js(`window.__xo.build.instances.find((i) => i.path === ${JSON.stringify(GUN)}).id`);
  const onGun = await js(`(() => { const b = window.__xo.build, bx = b.get(${gunInst}).box;
    for (const fy of [0.5, 0.7, 0.3]) for (const fx of [0.5, 0.3, 0.7]) { const p = window.__xo.viewer.project(bx.min.x + (bx.max.x - bx.min.x) * fx, bx.min.y + (bx.max.y - bx.min.y) * fy, (bx.min.z + bx.max.z) / 2);
      if (b.instanceAt({ clientX: p.x, clientY: p.y })?.id === ${gunInst}) return p; } return null; })()`);
  await mouse('mouseMoved', onGun.x, onGun.y);
  const cardShown = await waitFor(`!document.getElementById('partCard').hidden && document.getElementById('partCard').textContent.includes(${JSON.stringify(gunItem.name)})`, 5000).catch(() => false);
  const cardText = await js(`document.getElementById('partCard').textContent.replace(/\\s+/g, ' ').trim()`);
  ok(cardShown && cardText.replace(/ /g, '').includes(`Usesenergy${gunItem.cost}pts`), `hovering a part shows its card: "${cardText}"`);
  // ... and the garage's white outline (counted on screen: near-white pixels that go when it is off)
  const outl = await js(`(() => { const v = window.__xo.viewer, o = v.outlines, g = document.getElementById('view').getContext('webgl2');
    const grab = () => { v.render(); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
    const a = grab(); v.outlines = []; const b = grab(); v.outlines = o; v.render();
    let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i] > 235 && a[i + 1] > 235 && a[i + 2] > 235 && (b[i] < 200 || b[i + 1] < 200 || b[i + 2] < 200)) n++;
    return { n: o.length, gun: o[0]?.object === window.__xo.build.get(${gunInst}).group, color: o[0]?.color, px: n }; })()`);
  ok(outl.n === 1 && outl.gun && outl.color === 0xffffff && outl.px > 150, `the part under the cursor gets the garage's white outline (${outl.px} pixels of line)`);
  // ... and its name beside the cursor (as the 3D Viewer and Maps do)
  await mouse('mouseMoved', onGun.x + 1, onGun.y);
  await sleep(150);
  const tip = await js(`(() => { const t = document.getElementById('hoverTip'), r = t.getBoundingClientRect(), v = document.getElementById('view').getBoundingClientRect(); return { shown: !t.hidden, text: t.textContent, x: r.left - v.left, y: r.top - v.top }; })()`);
  ok(tip.shown && tip.text.startsWith(gunItem.name) && tip.text.includes(gunItem.type) && Math.abs(tip.x - (onGun.x + 1 - (await js(`document.getElementById('view').getBoundingClientRect().left`)) + 14)) < 3,
    `hovering a part names it by the cursor: "${tip.text}"`);

  // armour and decor: named from the game's item data; today's numbers where crosscalc lists the
  // part, else the old data's (marked, and the card says so)
  const armour = await js(`${G}.stats.item('models/constructor/structure/avia_const/av_box_4x1x2.mdl')`);
  const decor = await js(`${G}.stats.item('models/constructor/decor/alpha_sign/alpha_sign_big.mdl')`);
  const decorCard = await js(`(async () => { const { partCardHtml } = await import('./garage.js'); return partCardHtml("Large 'Alpha' sign", 'models/constructor/decor/alpha_sign/alpha_sign_big.mdl', ${G}.stats.item('models/constructor/decor/alpha_sign/alpha_sign_big.mdl')); })()`);
  ok(armour?.kind === 'structure' && armour.hp > 0 && armour.mass > 0 && !armour.old && decor?.kind === 'decor' && decor.old && decor.mass > 0 && decorCard.includes('2018-19 game data'),
    `armour and decor have numbers: Avia panel ${armour?.hp} pts / ${armour?.mass} kg (today's), Large 'Alpha' sign ${decor?.mass} kg (old game data, the card says so)`);

  // ---- the garage camera: W A S D move it over the ground, Space up, Shift down ----
  const camState = () => js(`(() => { const v = window.__xo.viewer; return { t: v.controls.target.toArray(), p: v.camera.position.toArray() }; })()`);
  const hold = async (keyName, code, vk, ms, modifiers = 0) => {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(ms);
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, modifiers: 0 });
    await sleep(300); // it glides to a stop
  };
  await mouse('mouseMoved', 5, 5); // off the canvas
  let cam0 = await camState();
  const fwd = [cam0.t[0] - cam0.p[0], 0, cam0.t[2] - cam0.p[2]], fl = Math.hypot(fwd[0], fwd[2]);
  await hold('w', 'KeyW', 87, 450);
  let cam1 = await camState();
  const moved = [cam1.t[0] - cam0.t[0], cam1.t[1] - cam0.t[1], cam1.t[2] - cam0.t[2]];
  const along = (moved[0] * fwd[0] + moved[2] * fwd[2]) / fl;
  const same = cam1.p.every((v, i) => Math.abs(v - cam0.p[i] - moved[i]) < 1e-6);
  ok(along > 0.3 && Math.abs(moved[1]) < 1e-9 && same, `W moves the camera forward over the ground (${along.toFixed(2)} m, level, camera and pivot together)`);
  await hold('d', 'KeyD', 68, 300);
  let cam2 = await camState();
  const side = ((cam2.t[0] - cam1.t[0]) * -fwd[2] + (cam2.t[2] - cam1.t[2]) * fwd[0]) / fl;
  ok(side > 0.2, `D moves it to the right (${side.toFixed(2)} m)`);
  await hold(' ', 'Space', 32, 300);
  const cam3 = await camState();
  ok(cam3.t[1] - cam2.t[1] > 0.2, `Space raises it (${(cam3.t[1] - cam2.t[1]).toFixed(2)} m)`);
  // Shift held, then used for Shift+click: the camera goes back to where it was when Shift went down
  // any spot on the canvas with no part under it (the camera has moved about by now)
  const gp0 = await js(`(() => { const r = document.getElementById('view').getBoundingClientRect(), top = document.getElementById('buildTools').getBoundingClientRect().bottom;
    for (const fy of [0.75, 0.6, 0.85, 0.5]) for (const fx of [0.2, 0.8, 0.35, 0.65, 0.5]) { const p = { clientX: r.left + r.width * fx, clientY: top + (r.bottom - top) * fy };
      if (!window.__xo.build.instanceAt(p)) return { x: p.clientX, y: p.clientY }; } return null; })()`);
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
  await sleep(450);
  const mid = await camState();
  await click(gp0.x, gp0.y, 'left', { modifiers: SHIFT });
  const back = await camState();
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 0 });
  await sleep(300);
  const after = await camState();
  ok(mid.t[1] < cam3.t[1] - 0.1 && back.t.every((v, i) => Math.abs(v - cam3.t[i]) < 1e-6) && after.t.every((v, i) => Math.abs(v - cam3.t[i]) < 1e-6),
    `Shift held lowers the camera (${(cam3.t[1] - mid.t[1]).toFixed(2)} m), and Shift+click (a selection) puts it back where it was when Shift went down`);
  await hold('Shift', 'ShiftLeft', 16, 450, 8);
  const cam4 = await camState();
  ok(cam4.t[1] < cam3.t[1] - 0.2, `Shift alone lowers it (${(cam3.t[1] - cam4.t[1]).toFixed(2)} m)`);
  await key('Home');
  await waitFor('!window.__xo.viewer.tween', 5000);

  // ---- C lifts the car ----
  cam0 = await camState();
  await key('c');
  await waitFor('!window.__xo.viewer.liftTween', 5000);
  const lifted = await js(`(() => { const v = window.__xo.viewer; return { lift: v.lift, grid: v.grid.position.y, floor: v.floor.position.y, ground: v.groundLevel(),
    lowest: Math.min(0, v.stages.build.min.y), on: document.getElementById('bLift').classList.contains('on') }; })()`);
  cam1 = await camState();
  // (the ground is under whatever hangs lowest, wheels included; the grid sits just above the floor)
  ok(Math.abs(lifted.lift - 1.2) < 1e-9 && Math.abs(lifted.ground - (lifted.lowest - 1.2)) < 1e-6 && Math.abs(lifted.grid - (lifted.ground - 0.001)) < 1e-6 &&
    lifted.floor < lifted.grid && lifted.on && Math.abs(cam0.t[1] - cam1.t[1] - 1.2) < 1e-6,
    `C lifts the car 1.2 m (floor and grid go down, the view follows: grid at ${lifted.grid.toFixed(3)} m)`);
  await app.snap(shot('b03c-lifted'));
  await key('c');
  await waitFor('!window.__xo.viewer.liftTween', 5000);
  cam2 = await camState();
  ok((await js('window.__xo.viewer.lift')) === 0 && Math.abs(cam2.t[1] - cam0.t[1]) < 1e-6, 'C again sets it back down');

  // ---- V held: the vehicle fires ----
  // its gun fires at its own pace with the 3D Viewer's effects, rounds and sounds, the training
  // target stood 10 m in front of the vehicle; letting go stops it
  await js(`(() => { const v = window.__xo.viewer, fire = v.fx.fire.bind(v.fx); window.__rounds = 0; v.fx.fire = (...a) => { window.__rounds++; return fire(...a); }; })()`);
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await sleep(1300);
  const fireNow = await js(`(async () => { const v = window.__xo.viewer, b = window.__xo.build.box(), g = window.__xo.gunfire.guns[0], { firePeriod } = await import('./anim.js');
    return { on: window.__xo.gunfire.on, guns: window.__xo.gunfire.guns.length, runs: v.fx.runs.length, period: g?.period, clip: await firePeriod(g?.info),
    target: v.target?.visible ? v.target.position.z : null, front: b.max.z, asked: v.sounds.asked, rounds: window.__rounds }; })()`);
  await app.snap(shot('b03e-firing'));
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await sleep(300);
  const fireAfter = await js(`(() => { delete window.__xo.viewer.fx.fire; return { on: window.__xo.gunfire.on, guns: window.__xo.viewer.sounds.guns.size }; })()`);
  // (the gun sits turned across the vehicle: its rounds fly off to the side)
  ok(fireNow.on && fireNow.guns === 1 && fireNow.runs > 0 && fireNow.rounds >= 4 && fireNow.asked > 0 && fireNow.target !== null && Math.abs(fireNow.target - fireNow.front - 10) < 0.01,
    `holding V fires the vehicle's gun (${fireNow.rounds} rounds in 1.3 s, ${fireNow.runs} effects playing, its sounds), the target stood 10 m in front of it`);
  ok(!fireAfter.on && fireAfter.guns === 0, 'letting go of V stops it');
  ok(fireNow.clip > 0 && Math.abs(fireNow.period - fireNow.clip) < 1e-9, `the gun fires at its own pace, one shot a loop of its Fire clip (${fireNow.period?.toFixed(3)} s)`);
  // the shot timer: Shot every 3 s fires it once every 3 s, holding still between (its clip's time stays
  // put); emptied, its own pace is back (the SMG fires non-stop in the game). The Firing clock stepped by hand.
  const timerFire = (every) => js(`(async () => {
    const e = document.getElementById('bEvery'); e.value = ${JSON.stringify(String(every))}; e.dispatchEvent(new Event('change'));
    const f = window.__xo.gunfire, v = window.__xo.viewer;
    if (!f.start()) return null;
    await new Promise((r) => setTimeout(r, 400)); // (its clip read: its own pace known)
    f.clock = 0; for (const g of f.guns) { g.k = 0; g.t = 0; g.held = null; }
    const shots = [], shoot = v.shoot;
    let clock = 0;
    v.shoot = function (...x) { shots.push(+clock.toFixed(2)); return shoot.apply(this, x); };
    try { for (let i = 0; i < 140; i++) { f.last = performance.now() - 50; f.tick(); clock += 0.05; } }
    finally { v.shoot = shoot; f.stop(); }
    return { shots, setting: window.__xo.state.settings.fireEvery || 0 };
  })()`);
  const every3 = await timerFire(3), ownPace = await timerFire('');
  ok(every3 && every3.setting === 3 && every3.shots.length === 3 && every3.shots.every((t, i) => Math.abs(t - i * 3) <= 0.06),
    `Shot every 3 s: holding V fires the gun once every 3 s (${every3?.shots.join(', ')})`);
  ok(ownPace && ownPace.setting === 0 && ownPace.shots.length >= 20, `emptied, it fires at its own pace again (${ownPace?.shots.length} shots in 7 s)`);
  const cannonCard = await js(`(async () => { const { partCardHtml } = await import('./garage.js'), p = 'models/weapons/heavygun_6pounder/heavygun_6pounder.mdl';
    return partCardHtml('Avenger 57mm', p, window.__xo.garage.stats.item(p)).replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' '); })()`);
  ok(/Reload time 6 s/.test(cannonCard), `a weapon's card shows its reload time from the game ("${(cannonCard.match(/Reload time [^A-Z]*/) || ['none'])[0].trim()}")`);
  await key('Home');
  await waitFor('!window.__xo.viewer.tween', 5000);

  // ---- H: the parts list ----
  await key('h');
  const plOpen = await js(`!document.getElementById('partsList').hidden && document.querySelectorAll('#plMain .pl-tile').length`);
  ok(plOpen === 5, `H opens the parts list (${plOpen} parts)`);
  const pics = await waitFor(`document.querySelectorAll('#plMain .pl-tile img').length >= 3`, 20000).catch(() => false);
  ok(pics, `the parts list shows a picture of each part (${await js(`document.querySelectorAll('#plMain .pl-tile img').length`)} rendered)`);
  const badges = await js(`[...document.querySelectorAll('#plMain .pl-badge')].map((b) => b.textContent.trim()).sort()`);
  ok(JSON.stringify(badges) === JSON.stringify([`+${cabItem.power}`, `−${gunItem.cost}`].sort()), `energy badges on the cabin and the gun (${badges.join(', ')})`);
  const plStats = await js(`document.getElementById('plStats').textContent`);
  ok(plStats.includes('Durability') && plStats.includes('5/80') && plStats.includes('Tonnage'), 'the vehicle stats sit beside the list');
  await app.snap(shot('b03d-parts-list'));
  const gunTile = await js(`(() => { const r = document.querySelector('#plMain .pl-tile[data-id="${gunInst}"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(gunTile.x, gunTile.y);
  ok((await js('window.__xo.build.selected')) === gunInst && (await js(`document.getElementById('partsList').hidden`)), 'clicking a part in the list selects it and closes the list');
  await key('Escape');

  // ---- a steering wheel (ST): same model, other stats ----
  const ST = 'models/constructor/chassis/wheels/wheel_elementary.mdl';
  const stId = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(ST)}, position: [3, 0, -3] }); b.commit(); b.select(i.id); return i.id; })()`);
  await settle();
  const ton0 = await js(`${G}.vehicle().tonnage`);
  ok(await waitFor(`!document.getElementById('bStWrap').hidden`, 5000).catch(() => false), 'a wheel that has a steering version offers "Steering wheel (ST)"');
  const steerMarks = () => js(`(() => { const m = window.__xo.build.wheelMarks; return m.group.children.filter((c) => c.isMesh && c.geometry === m.parts?.ring).length; })()`);
  const rings0 = await steerMarks();
  await js(`document.getElementById('bSt').click()`);
  const ton1 = await js(`${G}.vehicle().tonnage`);
  const [plain, steer] = await js(`[${G}.stats.item(${JSON.stringify(ST)}), ${G}.stats.item(${JSON.stringify(ST)}, true)]`);
  ok((await js(`window.__xo.build.get(${stId}).st`)) === true && ton0 - ton1 === plain.tonnageAdd - steer.tonnageAdd,
    `ticking it makes it the ${steer.name} (tonnage ${ton0} -> ${ton1} kg)`);
  const rings1 = await waitFor(`(() => { const m = window.__xo.build.wheelMarks; return m.group.children.filter((c) => c.isMesh && c.geometry === m.parts?.ring).length === ${rings0 + 1}; })()`, 5000).then(() => rings0 + 1, () => rings0);
  ok(rings1 === rings0 + 1, `the steering wheel gets the garage's steering mark at its foot (${rings0} -> ${rings1})`);
  await js('window.__xo.build.undo()');
  await settle();
  ok((await js(`window.__xo.build.get(${stId}).st`)) === false, 'undo sets it back');
  await js('window.__xo.build.undo()');
  await settle();
  ok((await count()) === 5, 'and the test wheel is gone again');
  }

  // Select by clicking a part, delete it, undo, redo, undo
  const gunId = await js('window.__xo.build.instances[4].id');
  const gp = await aimAt(gunId, 0.5, 0.6, 0.5);
  await click(gp.x, gp.y);
  const sel = await js('window.__xo.build.selected');
  ok(sel != null, `clicking a part selects it (selected ${sel})`);
  await key('Delete');
  ok((await count()) === 4, 'Delete removes the selected part');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);
  ok(true, 'Ctrl+Z brings it back');
  await key('y', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 4', 20000);
  ok(true, 'Ctrl+Y deletes it again');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);

  // Move a wheel with G: pick it up and drop it further back on the frame side
  const wheelId = await js('window.__xo.build.instances[2].id');
  await js(`window.__xo.build.select(${wheelId})`);
  const oldPos = await js(`window.__xo.build.get(${wheelId}).group.position.toArray()`);
  await key('g');
  await waitFor('!!window.__xo.build.placing && window.__xo.build.placing.moveId != null', 20000);
  const target = await aimAt(frameId, 1.0, 0.5, 0.8);
  await mouse('mouseMoved', target.x, target.y);
  await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
  await click(target.x, target.y);
  await waitFor('!window.__xo.build.placing', 10000);
  const newPos = await js(`window.__xo.build.get(${wheelId}).group.position.toArray()`);
  ok((await count()) === 5 && newPos.some((v, i) => Math.abs(v - oldPos[i]) > 0.01), `G moves the part (${oldPos.map((v) => v.toFixed(2))} -> ${newPos.map((v) => v.toFixed(2))})`);

  { // Grab and drag, as in the garage: press on the gun, drag it off onto the ground, let go
    const gid = await js(`window.__xo.build.instances.find((i) => i.path === ${JSON.stringify(GUN)}).id`);
    const from = await js(`(() => { const b = window.__xo.build, bx = b.get(${gid}).box;
      for (const fy of [0.5, 0.7, 0.3]) for (const fx of [0.5, 0.3, 0.7]) for (const fz of [0.5, 0.3, 0.7]) { const p = window.__xo.viewer.project(bx.min.x + (bx.max.x - bx.min.x) * fx, bx.min.y + (bx.max.y - bx.min.y) * fy, bx.min.z + (bx.max.z - bx.min.z) * fz);
        if (b.instanceAt({ clientX: p.x, clientY: p.y })?.id === ${gid}) return p; } return null; })()`);
    const to = await freeGroundPoint();
    const cam0 = await js('window.__xo.viewer.camera.position.toArray()');
    const p0 = await js(`window.__xo.build.get(${gid}).group.position.toArray()`);
    ok(!!from && !!to && (await js('window.__xo.build.gizmoMode')) === 'off' && (await js(`document.getElementById('view').style.cursor`)) === 'crosshair',
      'no axis handles by default, and the cursor is a small cross');
    await drag(from.x, from.y, to.x, to.y, { steps: 16 });
    await waitFor('!window.__xo.build.placing && !window.__xo.build.busy && !window.__xo.build.committing', 15000);
    const p1 = await js(`window.__xo.build.get(${gid}).group.position.toArray()`);
    const cam1 = await js('window.__xo.viewer.camera.position.toArray()');
    const moved = p1.some((v, i) => Math.abs(v - p0[i]) > 0.01);
    ok(moved && cam1.every((v, i) => Math.abs(v - cam0[i]) < 1e-9) && p1.every((v) => Math.abs(v / 0.15 - Math.round(v / 0.15)) < 1e-6) && (await count()) === 5,
      `dragging a part picks it up and drops it where you let go, snapped (${p0.map((v) => v.toFixed(2))} -> ${p1.map((v) => v.toFixed(2))}); the camera does not turn`);
    ok((await js('window.__xo.build.selected')) === gid, 'the dragged part ends up selected');
    await key('z', { ctrl: true });
    await waitFor(`window.__xo.build.get(${gid}).group.position.toArray().every((v, i) => Math.abs(v - ${JSON.stringify(p0)}[i]) < 1e-6)`, 15000);
    ok(true, 'Ctrl+Z puts it back');
    await key('Escape');
  }

  // Rotate buttons on the selected part
  const quatOf = (id) => js(`window.__xo.build.get(${id}).group.quaternion.toArray()`);
  const turn = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])))) * 180 / Math.PI;
  await js(`window.__xo.build.select(${wheelId})`);
  await sleep(100);
  const q0 = await quatOf(wheelId);
  await js(`document.querySelector('#bSelCard [data-turn="spin,1"]').click()`);
  const q1 = await quatOf(wheelId);
  ok(Math.abs(turn(q0, q1) - 90) < 0.01, `rotate button turns the selected part 90° (${turn(q0, q1).toFixed(2)}°)`);
  await js(`document.querySelector('#bSelCard [data-turn="spin,-1"]').click()`);
  ok(turn(q0, await quatOf(wheelId)) < 0.01, 'the opposite button turns it back');

  // Symmetry on: edits to a part also apply to its mirror twin (like the game's garage)
  const otherWheel = await js('window.__xo.build.instances[3].id');
  const op = await js(`window.__xo.build.get(${otherWheel}).group.position.toArray()`);
  await js(`window.__xo.build.setPosition(${wheelId}, [${-op[0]}, ${op[1]}, ${op[2]}])`); // back to the mirror spot
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  await js(`window.__xo.build.select(${wheelId})`);
  ok((await js(`window.__xo.build.editTwin()?.id`)) === otherWheel && (await js('window.__xo.viewer.outlines.some((o) => o.color === 0x4cc3ff)')), 'with Symmetry on the selected wheel finds its mirror twin (and outlines it blue)');
  const t0 = await quatOf(otherWheel);
  await js(`document.querySelector('#bSelCard [data-turn="tip,1"]').click()`);
  ok(Math.abs(turn(t0, await quatOf(otherWheel)) - 90) < 0.01 && (await js(`window.__xo.build.twinOf(window.__xo.build.get(${wheelId}))?.id`)) === otherWheel, 'turning it turns the twin the mirrored way');
  await js(`document.querySelector('#bSelCard [data-turn="tip,-1"]').click()`);
  await js(`window.__xo.build.setPosition(${wheelId}, [${-op[0]}, ${op[1]}, ${(op[2] + 0.3).toFixed(4)}])`);
  const tp = await js(`window.__xo.build.get(${otherWheel}).group.position.toArray()`);
  ok(Math.abs(tp[2] - (op[2] + 0.3)) < 1e-6 && Math.abs(tp[0] - op[0]) < 1e-6, `typing a position moves the twin to the mirror spot (z ${op[2].toFixed(2)} -> ${tp[2].toFixed(2)})`);
  await js(`window.__xo.build.setPosition(${wheelId}, [${-op[0]}, ${op[1]}, ${op[2]}])`);
  await key('Delete');
  ok((await count()) === 3, 'Delete removes the wheel and its twin');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);
  ok((await js(`window.__xo.build.twinOf(window.__xo.build.get(${wheelId}))?.id`)) === otherWheel, 'Ctrl+Z brings both back as a mirrored pair');
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
  ok(!(await js('window.__xo.viewer.outlines.some((o) => o.color === 0x4cc3ff)')), 'with Symmetry off, edits apply to one part only');

  // ---- Multi-select --------------------------------------------------------------------------------
  const idOf = (p) => js(`window.__xo.build.instances.filter(i => i.path === ${JSON.stringify(p)}).map(i => i.id)`);
  const [cabinId2] = await idOf(CABIN);
  const [gunId2] = await idOf(GUN);
  const [wA, wB] = await idOf(WHEEL);
  const allIds = await js('window.__xo.build.instances.map(i => i.id)');
  const selIds = () => js('[...window.__xo.build.sel]');
  const posOf = (id) => js(`window.__xo.build.get(${id}).group.position.toArray()`);
  const mirOf = (id) => js(`window.__xo.build.get(${id}).mirrored`);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const onLattice = (p) => p.every((v) => Math.abs(v / 0.15 - Math.round(v / 0.15)) < 1e-6);
  const fmt = (p) => p.map((v) => v.toFixed(2)).join(',');
  // a screen point where the mouse ray really hits part id (tries points across its box)
  const pointOn = (id) => js(`(() => { const b = window.__xo.build, bx = b.get(${id}).box;
    for (const fz of [0.5, 0.3, 0.7, 0.15, 0.85]) for (const fy of [0.5, 0.7, 0.3, 0.85, 0.15]) for (const fx of [0.5, 0.3, 0.7, 0.15, 0.85]) {
      const p = window.__xo.viewer.project(bx.min.x + (bx.max.x - bx.min.x) * fx, bx.min.y + (bx.max.y - bx.min.y) * fy, bx.min.z + (bx.max.z - bx.min.z) * fz);
      if (b.instanceAt({ clientX: p.x, clientY: p.y })?.id === ${id}) return p;
    } return null; })()`);
  // a spot on the ground next to the vehicle where the cursor hits no part
  const freeGround = () => js(`(() => { const b = window.__xo.build.box(), r = document.getElementById('view').getBoundingClientRect(), top = document.getElementById('buildTools').getBoundingClientRect().bottom;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    for (const [x, z] of [[b.max.x + 1.2, cz], [b.min.x - 1.2, cz], [cx, b.max.z + 1.2], [cx, b.min.z - 1.2], [b.max.x + 0.8, b.max.z + 0.8]]) {
      const p = window.__xo.viewer.project(x, 0, z);
      if (p.inFront && p.x > r.left + 30 && p.x < r.right - 30 && p.y > top + 30 && p.y < r.bottom - 70 && !window.__xo.build.instanceAt({ clientX: p.x, clientY: p.y })) return p;
    } return null; })()`);
  // parts-list row clicks with modifier keys
  const rowClick = (id, { ctrl = false, shift = false } = {}) => js(`document.querySelector('#bList .brow[data-id="${id}"] .bn').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${ctrl}, shiftKey: ${shift} }))`);

  await key('Escape');
  const pc = await pointOn(cabinId2), pg = await pointOn(gunId2);
  ok(!!pc && !!pg, 'found spots on screen that hit the cabin and the gun');
  await click(pc.x, pc.y);
  await click(pg.x, pg.y, 'left', { modifiers: CTRL });
  let s = await selIds();
  ok(s.length === 2 && s.includes(cabinId2) && s[1] === gunId2, `Ctrl+click adds a part to the selection (${s.length} selected)`);
  ok((await js(`document.getElementById('bSelTitle').textContent`)) === '2 parts selected' && (await js(`window.__xo.viewer.outlines.filter((o) => o.color === 0xffa43c || o.color === 0xc8843e).length`)) === 2, 'the panel says "2 parts selected" and both are outlined orange');
  await click(pg.x, pg.y, 'left', { modifiers: SHIFT });
  s = await selIds();
  ok(s.length === 1 && s[0] === cabinId2, 'Shift+click on a selected part takes it out again');

  // Box selection
  await key('Escape');
  const rect = await js(`(() => { const b = window.__xo.build.box(), pts = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) pts.push(window.__xo.viewer.project(x, y, z));
    const r = document.getElementById('view').getBoundingClientRect(), top = document.getElementById('buildTools').getBoundingClientRect().bottom;
    return { x0: Math.max(r.left + 4, Math.min(...pts.map(p => p.x)) - 15), y0: Math.max(top + 6, Math.min(...pts.map(p => p.y)) - 15),
             x1: Math.min(r.right - 4, Math.max(...pts.map(p => p.x)) + 15), y1: Math.min(r.bottom - 4, Math.max(...pts.map(p => p.y)) + 15) }; })()`);
  await drag(rect.x0, rect.y0, rect.x1, rect.y1, { modifiers: SHIFT });
  s = await selIds();
  ok(s.length === 5 && (await js(`document.querySelector('#center .marquee').hidden`)), `Shift+drag draws a box that selects the whole vehicle (${s.length} parts)`);
  const gcen = await js(`(() => { const b = window.__xo.build.get(${gunId2}).box; return window.__xo.viewer.project((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2); })()`);
  await drag(gcen.x - 9, gcen.y - 9, gcen.x + 9, gcen.y + 9, { modifiers: CTRL });
  s = await selIds();
  ok(s.length === 4 && !s.includes(gunId2), 'Ctrl+drag box takes the gun out of the selection');
  await key('Escape');
  await key('a', { ctrl: true });
  ok((await selIds()).length === 5, 'Ctrl+A selects every part');
  await key('Escape');
  ok((await selIds()).length === 0 && !(await js('window.__xo.viewer.outlines.some((o) => o.color === 0xffa43c || o.color === 0xc8843e)')), 'Esc clears the selection (and its outline)');

  // Parts list: Shift+click selects a range, Ctrl+click adds / removes
  await rowClick(allIds[0]);
  await rowClick(allIds[2], { shift: true });
  s = await selIds();
  ok(s.length === 3 && s[2] === allIds[2], `Shift+click in the parts list selects a range (${s.length} rows)`);
  await rowClick(allIds[1], { ctrl: true });
  const listSel = await waitFor(`document.querySelectorAll('#bList .brow.sel').length === 2`, 5000).catch(() => false);
  ok((await selIds()).length === 2 && listSel, `Ctrl+click in the list takes one out; the list highlights the selected rows (${(await selIds()).length} selected)`);

  // Turn, mirror, delete the two wheels together
  await rowClick(wA);
  await rowClick(wB, { ctrl: true });
  const a0 = await posOf(wA), b0 = await posOf(wB), ma = await mirOf(wA), mb = await mirOf(wB);
  await key('r');
  const a1 = await posOf(wA), b1 = await posOf(wB);
  const r0 = sub(a0, b0), r1 = sub(a1, b1);
  ok(Math.abs(dist(a0, b0) - dist(a1, b1)) < 1e-6 && Math.abs(r0[0] * r1[0] + r0[1] * r1[1] + r0[2] * r1[2]) < 1e-6 && onLattice(a1) && onLattice(b1),
    `R turns both selected wheels 90° around their middle, on the grid (${fmt(a1)} / ${fmt(b1)})`);
  await key('r', { shift: true });
  ok(dist(await posOf(wA), a0) < 1e-6 && dist(await posOf(wB), b0) < 1e-6, 'Shift+R turns them back exactly');
  await key('x');
  ok(dist(await posOf(wA), b0) < 1e-6 && dist(await posOf(wB), a0) < 1e-6 && (await mirOf(wA)) === mb && (await mirOf(wB)) === ma, 'X mirrors the selection in place (the two wheels trade sides, mirrored)');
  await key('x');
  ok(dist(await posOf(wA), a0) < 1e-6 && (await mirOf(wA)) === ma, 'X again restores them');
  await app.snap(shot('b04a-multiselect'));
  await key('Delete');
  ok((await count()) === 3, 'Delete removes both selected wheels');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);
  ok(dist(await posOf(wA), a0) < 1e-6 && dist(await posOf(wB), b0) < 1e-6, 'Ctrl+Z brings both back in place');

  // The gizmo moves / turns the whole selection (its drag handler, fed like a real drag)
  await rowClick(wA);
  await rowClick(wB, { ctrl: true });
  await js(`(() => { const b = window.__xo.build; b.beginDrag(); b.pivot.position.z += 0.62; b.dragUpdate(); b.gizmoDone(); })()`);
  const a2 = await posOf(wA), b2 = await posOf(wB);
  ok(Math.abs(a2[2] - a0[2] - 0.6) < 1e-6 && Math.abs(b2[2] - b0[2] - 0.6) < 1e-6 && a2[0] === a0[0] && b2[0] === b0[0], 'dragging the gizmo moves every selected part, in whole cells (0.62 m -> 0.6 m)');
  await js(`(() => { const b = window.__xo.build; b.beginDrag(); b.pivot.quaternion.setFromAxisAngle(b.pivot.up.clone().set(0, 1, 0), Math.PI / 2); b.dragUpdate(); b.gizmoDone(); })()`);
  const a3 = await posOf(wA), b3 = await posOf(wB), r3 = sub(a3, b3);
  ok(Math.abs(r0[0] * r3[0] + r0[1] * r3[1] + r0[2] * r3[2]) < 1e-6 && onLattice(a3) && onLattice(b3), 'turning the gizmo turns the selection around its middle');
  await key('z', { ctrl: true });
  await key('z', { ctrl: true });
  await waitFor(`window.__xo.build.get(${wA}).group.position.z === ${a0[2]}`, 20000);
  ok(dist(await posOf(wA), a0) < 1e-6 && dist(await posOf(wB), b0) < 1e-6, 'two Ctrl+Z undo both gizmo edits');

  // Symmetry on: twins of selected parts follow the group
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  await rowClick(wA);
  await rowClick(gunId2, { ctrl: true });
  const hint = await waitFor(`!document.getElementById('bTwinHint').hidden`, 5000).catch(() => false);
  ok((await js('window.__xo.build.selectionTwins().length')) === 1 && hint, `with Symmetry on, the selected wheel's twin follows the group (${await js('window.__xo.build.selectionTwins().length')} twin, hint shown: ${hint})`);
  await key('Delete');
  ok((await count()) === 2, 'Delete removes the selected wheel, its mirror twin and the gun');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);
  await js(`(() => { const s = document.getElementById('bSym'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);

  // G picks up the cabin with the gun on it; they land together and stay attached
  const c0 = await posOf(cabinId2), g0 = await posOf(gunId2);
  await rowClick(cabinId2);
  await rowClick(gunId2, { ctrl: true });
  const spot = await freeGround();
  ok(!!spot, 'found a free spot on the ground next to the vehicle');
  await mouse('mouseMoved', spot.x, spot.y);
  await key('g');
  await waitFor('!!window.__xo.build.placing && window.__xo.build.placing.group === true && window.__xo.build.placing.hasPos', 20000);
  ok((await js('window.__xo.build.instances.filter(i => !i.group.visible).length')) === 2, 'G picks up both selected parts (they follow the cursor as one ghost)');
  await mouse('mouseMoved', spot.x + 3, spot.y + 2);
  await sleep(80);
  await click(spot.x, spot.y);
  await waitFor('!window.__xo.build.placing', 10000);
  const c1 = await posOf(cabinId2), g1 = await posOf(gunId2);
  ok(dist(c0, c1) > 0.5 && dist(sub(g1, c1), sub(g0, c0)) < 1e-6 && onLattice(c1), `cabin and gun moved together (cabin ${fmt(c0)} -> ${fmt(c1)}), the gun kept its spot on the roof`);
  const comps = await js('window.__xo.build.components().map(g => g.map(i => i.id))');
  // (the starter cabin also carries the wheels' side slots, so the frame and wheels come loose)
  ok(comps.some((g) => g.length === 2 && g.includes(cabinId2) && g.includes(gunId2)), `the gun is still attached to the moved cabin (groups now: ${JSON.stringify(comps)})`);
  ok((await selIds()).length === 2, 'the moved parts stay selected');
  await key('z', { ctrl: true });
  await waitFor(`window.__xo.build.get(${cabinId2}).group.position.x === ${c0[0]} && window.__xo.build.get(${cabinId2}).group.position.z === ${c0[2]}`, 20000);
  ok(dist(await posOf(gunId2), g0) < 1e-6 && (await js('window.__xo.build.components().length')) === 1, 'Ctrl+Z puts them back on the frame');

  // Ctrl+D copies the selection as a group. A copy that would add a second cabin is refused, as
  // in the game (one cabin per vehicle); the frame and the gun copy fine.
  const statusText = () => js(`document.getElementById('status').textContent`);
  await rowClick(cabinId2);
  await rowClick(gunId2, { ctrl: true });
  let gp2 = await freeGround();
  await mouse('mouseMoved', gp2.x, gp2.y);
  await key('d', { ctrl: true });
  await waitFor('!!window.__xo.build.placing && window.__xo.build.placing.group === true && window.__xo.build.placing.hasPos', 20000);
  await click(gp2.x, gp2.y);
  await sleep(400);
  ok((await count()) === 5 && (await statusText()).includes('one cabin') && (await js('!!window.__xo.build.placing')),
    'copying the cabin is refused: a vehicle has one cabin (the copy stays on the cursor, the status line says why)');
  await key('Escape');
  const f0 = await posOf(frameId);
  await rowClick(frameId);
  await rowClick(gunId2, { ctrl: true });
  gp2 = await freeGround();
  await mouse('mouseMoved', gp2.x, gp2.y);
  await key('d', { ctrl: true });
  await waitFor('!!window.__xo.build.placing && window.__xo.build.placing.group === true && window.__xo.build.placing.hasPos', 20000);
  await click(gp2.x, gp2.y);
  await waitFor('window.__xo.build.instances.length === 7', 20000);
  const copies = await js('window.__xo.build.instances.slice(5).map(i => ({ path: i.path, pos: i.group.position.toArray() }))');
  const cf = copies.find((c) => c.path === FRAME), cg = copies.find((c) => c.path === GUN);
  ok(!!cf && !!cg && dist(sub(cg.pos, cf.pos), sub(g0, f0)) < 1e-6, 'Ctrl+D copies the frame and gun together, same arrangement');
  await key('Escape');
  await key('z', { ctrl: true });
  await waitFor('window.__xo.build.instances.length === 5', 20000);
  ok(true, 'Ctrl+Z removes the copies');

  // Export just the selection
  await rowClick(cabinId2);
  await rowClick(gunId2, { ctrl: true });
  ok(await waitFor(`!document.getElementById('bExpSel').disabled`, 5000).catch(() => false), 'the "Only the selected parts" export option is available');
  const selGlb = path.join(out, 'turret.glb');
  await js(`window.__xo.call('exportBuild', { parts: window.__xo.build.exportItems({ onlySelected: true }), name: 'turret', format: 'glb', lod: 0, textures: false, outPath: ${JSON.stringify(selGlb)} })`);
  const sdoc = JSON.parse(fs.readFileSync(selGlb).subarray(20, 20 + fs.readFileSync(selGlb).readUInt32LE(12)).toString());
  ok(sdoc.nodes.filter((n) => n.extras?.source).length === 2, 'exporting only the selection writes just those 2 parts');
  await key('Escape');

  // Paint, Whole vehicle: one paint for every part without its own, ones added later too
  await js(`window.__xo.paints.setMode('all')`);
  await js(`(() => { const s = document.querySelector('#bPaintPicker .pp-grid [data-pick="color"][data-color="#2f4f6f"]'); s.click(); })()`);
  const paintOn = (id) => js(`window.__xo.build.get(${id}).group.userData.materials.some((m) => m.userData.xo.u.xoPaintAmt.value > 0)`);
  const paintedSets = () => js(`window.__xo.build.instances.filter((i) => i.group.userData.materials.some((m) => m.userData.xo.u.xoPaintAmt.value > 0)).length`);
  const painted = await paintedSets();
  ok(painted >= 3 && (await paintOn(cabinId2)) && (await js('window.__xo.build.paint?.kind')) === 'color', `Paint, Whole vehicle paints its ${painted} parts (in the view and in exports)`);
  await app.snap(shot('b04-painted'));
  // ... a pattern on the selected part alone (and its mirror twin with Symmetry on); undone and done again
  const camo = { kind: 'pattern', tex: 'textures/patterns/camouflage01', color: [1, 1, 1], amount: 1, scale: 1 };
  await js(`window.__xo.paints.setMode('sel')`);
  await rowClick(gunId2);
  await js(`window.__xo.paints.pick(${JSON.stringify(camo)})`);
  const own = () => js(`window.__xo.build.instances.map((i) => i.paint?.kind || '-').join(',')`);
  const ownAfter = await own();
  const gunDraws = await js(`window.__xo.build.get(${gunId2}).group.userData.materials.some((m) => m.defines.XO_PAINT_PATTERN !== undefined)`);
  const dot = await waitFor(`!!document.querySelector('#bList .brow[data-id="${gunId2}"] .bp')`, 5000).catch(() => false); // (the list is drawn on the next frame)
  await key('z', { ctrl: true });
  await settle();
  const ownUndone = await own();
  await key('y', { ctrl: true });
  await settle();
  ok(gunDraws && dot && /pattern/.test(ownAfter) && !/pattern/.test(ownUndone) && (await own()) === ownAfter, `Paint, Selected parts: the gun alone takes the camo (${ownAfter}; the list marks it), Ctrl+Z / Ctrl+Y take it off and put it back`);
  // ... the brush: a click on the cabin paints it, it does not pick the cabin up; Alt+click takes a paint; Esc puts the brush away
  await js(`window.__xo.build.select(null)`);
  await js(`window.__xo.paints.setMode('brush')`);
  await js(`window.__xo.paints.pick({ kind: 'chameleon', tex: 'textures/patterns/cham_blackblue', color: [1, 1, 1], amount: 1 })`);
  // (a spot over the cabin where the view itself is under the mouse, not one of its overlays, and a part shows)
  const cabAt = await js(`(() => { const b = window.__xo.build, v = window.__xo.viewer, bx = b.get(${cabinId2}).box;
    for (const fy of [0.4, 0.6, 0.25, 0.8]) for (const fx of [0.5, 0.3, 0.7]) for (const fz of [0.5, 0.3, 0.7]) {
      const p = v.project(bx.min.x + (bx.max.x - bx.min.x) * fx, bx.min.y + (bx.max.y - bx.min.y) * fy, bx.min.z + (bx.max.z - bx.min.z) * fz);
      if (p.inFront && document.elementFromPoint(p.x, p.y) === v.canvas && b.instanceAt({ clientX: p.x, clientY: p.y })) return p;
    }
    return { x: -1, y: -1 }; })()`);
  const under = await js(`(() => { const e = { clientX: ${cabAt.x}, clientY: ${cabAt.y} }; return window.__xo.build.instanceAt(e)?.id ?? null; })()`);
  await app.click(cabAt.x, cabAt.y);
  await settle();
  const brushed = await js(`window.__xo.build.get(${under}).paint?.kind`);
  const cursor = await js(`window.__xo.viewer.canvas.style.cursor`);
  await js(`window.__xo.paints.pick({ kind: 'color', color: [1, 0, 0], amount: 1 })`);
  await app.click(cabAt.x, cabAt.y, 'left', { modifiers: 1 });
  const took = await js('window.__xo.build.brush?.kind');
  await key('Escape');
  ok(under != null && brushed === 'chameleon' && /svg/.test(cursor) && took === 'chameleon' && (await js('window.__xo.state.paintMode')) === 'all' && !(await js('!!window.__xo.build.placing')),
    `the brush paints the part clicked (${brushed}) with its own cursor, Alt+click takes a part's paint (${took}), Esc puts it away`);
  // ... exports take each part's paint: the camo is baked into the gun's albedo
  const pItems = await js('window.__xo.build.exportItems().map((p) => p.paint?.kind || "-")');
  ok(pItems.includes('pattern') && pItems.includes('chameleon') && pItems.includes('color'), `the export gets each part's paint (${pItems.join(', ')})`);
  await js(`window.__xo.build.setPartsPaint(window.__xo.build.instances.filter((i) => i.paint?.kind === 'chameleon'), null)`); // (the cabin back to the vehicle's paint)
  await settle();
  const extraId = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(GUN)}, position: [3, 0, -3] }); b.commit(); return i.id; })()`);
  await settle();
  ok(await waitFor(`window.__xo.build.get(${extraId}).group.userData.materials.some((m) => m.userData.xo.u.xoPaintAmt.value > 0)`, 5000).catch(() => false),
    'a part added after painting gets the vehicle paint too');
  await js('window.__xo.build.undo()');
  await settle();

  // Save + reopen
  const buildPath = path.join(out, 'test.xobuild');
  await js(`window.__xo.call('saveText', { text: JSON.stringify(window.__xo.buildFile(), null, 2), ext: 'xobuild', outPath: ${JSON.stringify(buildPath)} })`);
  const saved = JSON.parse(fs.readFileSync(buildPath, 'utf8'));
  ok(saved.kind === 'build' && saved.parts.length === 5 && saved.paint?.amount > 0, `build saved (${saved.parts.length} parts, vehicle paint ${saved.paint?.amount})`);
  await js(`window.__xo.build.clear()`);
  ok((await count()) === 0, 'New/clear empties the build');
  await js(`window.__xo.loadBuildFile(${JSON.stringify(saved)})`);
  await settle();
  const reopened = await js('window.__xo.build.serialize()');
  const same = reopened.parts.length === 5 && reopened.parts.every((p, i) => p.path === saved.parts[i].path && p.position.every((v, k) => Math.abs(v - saved.parts[i].position[k]) < 1e-4));
  const reopenedOwn = await own();
  ok(same && (await paintedSets()) === painted && reopenedOwn === ownAfter, `reopened build matches the saved one (paths, positions, the vehicle's paint and the parts' own: ${reopenedOwn})`);

  // The Save button: the first save asks where (the test answers the dialog with a path), after
  // that Save and Ctrl+S write to that file without asking; a dot on the button and the line under
  // the name show unsaved changes
  const quickPath = path.join(out, 'quick save.xobuild');
  const saveState = () => js(`({ dot: document.getElementById('bQuickSave').classList.contains('dirty'), line: document.getElementById('bFile').textContent, file: window.__xo.state.buildFile.path })`);
  const before = await saveState();
  await js(`window.__xo.saveBuild({ outPath: ${JSON.stringify(quickPath)} })`);
  const first = await saveState();
  ok(before.dot && !first.dot && first.file === quickPath && /quick save\.xobuild · saved/.test(first.line) && JSON.parse(fs.readFileSync(quickPath, 'utf8')).parts.length === 5,
    `the first Save writes the file and clears the unsaved dot (before: ${before.dot ? 'dot' : 'no dot'}, "${before.line}"; after: "${first.line}")`);
  const movedId = await js('window.__xo.build.instances[4].id');
  await js(`window.__xo.build.setPosition(${movedId}, window.__xo.build.get(${movedId}).group.position.toArray().map((v, i) => i === 2 ? v - 0.6 : v))`);
  await waitFor(`document.getElementById('bQuickSave').classList.contains('dirty')`, 5000).catch(() => {});
  const changed = await saveState();
  ok(changed.dot && /unsaved changes/.test(changed.line), `a change shows the dot and "${changed.line}"`);
  const btn = await js(`(() => { const r = document.getElementById('bQuickSave').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, shown: r.width > 0 }; })()`);
  await app.click(btn.x, btn.y);
  await waitFor(`!document.getElementById('bQuickSave').classList.contains('dirty')`, 5000).catch(() => {});
  const zMoved = JSON.parse(fs.readFileSync(quickPath, 'utf8')).parts.find((p, i) => i === 4)?.position[2];
  const zNow = await js(`window.__xo.build.get(${movedId}).group.position.z`);
  ok(btn.shown && !(await saveState()).dot && Math.abs(zMoved - zNow) < 1e-4, `the toolbar's Save writes the same file again without asking (moved part saved at z ${zMoved?.toFixed(2)})`);
  await js(`window.__xo.build.setPosition(${movedId}, window.__xo.build.get(${movedId}).group.position.toArray().map((v, i) => i === 2 ? v + 0.6 : v))`);
  await waitFor(`document.getElementById('bQuickSave').classList.contains('dirty')`, 5000).catch(() => {});
  await app.key('s', { ctrl: true });
  await waitFor(`!document.getElementById('bQuickSave').classList.contains('dirty')`, 5000).catch(() => {});
  const zBack = JSON.parse(fs.readFileSync(quickPath, 'utf8')).parts[4]?.position[2];
  ok(!(await saveState()).dot && Math.abs(zBack - (await js(`window.__xo.build.get(${movedId}).group.position.z`))) < 1e-4, 'Ctrl+S saves to it too');

  // Ctrl+Z right after a drop undoes the drop (it only put the copy on the cursor away)
  const n0 = await count();
  await js(`window.__xo.build.startPlacing(${JSON.stringify(GUN)})`);
  await place(await freeGroundPoint());
  const dropped = await count();
  await key('z', { ctrl: true });
  await settle();
  ok(dropped === n0 + 1 && (await count()) === n0 && !(await js('!!window.__xo.build.placing')), `Ctrl+Z right after a drop takes the dropped part back (${n0} -> ${dropped} -> ${await count()}) and puts the copy on the cursor away`);
  // a part a game update removed is listed, greyed, and can be taken out of the build
  await js(`(() => { window.__xo.build.unloaded.push({ path: 'models/weapons/gone/gone_gun.mdl', skin: 'default', position: [0, 0, 0], rotation: [0, 0, 0, 1], mirrored: false }); window.__xo.build.onChange(); })()`);
  await waitFor(`!!document.querySelector('#bList .brow.missing [data-drop]')`, 5000).catch(() => {});
  const missingRow = await js(`document.querySelector('#bList .brow.missing')?.textContent || ''`);
  await js(`document.querySelector('#bList .brow.missing [data-drop]')?.click()`);
  ok(/gone_gun/.test(missingRow) && /missing/.test(missingRow) && (await js('window.__xo.build.unloaded.length')) === 0 && !(await js(`!!document.querySelector('#bList .brow.missing')`)),
    `a part that is not in the game any more is listed ("${missingRow.trim()}") and its ✕ takes it out of the build`);
  // New and Open wait while a build is loading (New during a restore was undone, and Save then wrote into the old file)
  await js('window.__xo.state.loadingBuild = (window.__xo.state.loadingBuild || 0) + 1');
  await js(`document.getElementById('bNew').click()`);
  const refusedNew = await js(`document.getElementById('statusText').textContent`);
  await js('window.__xo.state.loadingBuild--');
  ok(/still loading/.test(refusedNew) && (await count()) === n0, `New waits while a build loads ("${refusedNew}")`);
  // the X / Y / Z boxes step by whole cells and show where the part went
  const xyz = await js(`(() => { const b = window.__xo.build, i = b.instances[0]; b.select(i.id); const box = document.getElementById('bPx'), x0 = i.group.position.x;
    box.value = String(x0 + 0.3); box.dispatchEvent(new Event('change')); const x1 = i.group.position.x, shown = +box.value;
    box.value = String(x0); box.dispatchEvent(new Event('change')); return { step: box.step, x0, x1, shown, back: i.group.position.x }; })()`);
  ok(xyz.step === '0.3' && Math.abs(xyz.x1 - xyz.x0 - 0.3) < 1e-6 && Math.abs(xyz.shown - xyz.x1) < 1e-3 && Math.abs(xyz.back - xyz.x0) < 1e-6,
    `the X box steps by whole 0.3 m cells and shows where the part is (${xyz.x0.toFixed(2)} -> ${xyz.x1.toFixed(2)}, box ${xyz.shown})`);
  await js('window.__xo.build.select(null)');
  await waitFor(`!document.getElementById('bQuickSave').classList.contains('dirty')`, 3000).catch(() => {});
  if (await js(`document.getElementById('bQuickSave').classList.contains('dirty')`)) { await key('s', { ctrl: true }); await settle(); } // (the build as saved again, for the restart check)

  // Export the build and validate it
  const glb = path.join(out, 'vehicle.glb');
  const res = await js(`window.__xo.call('exportBuild', { parts: window.__xo.build.exportItems(), name: 'e2e vehicle', format: 'glb', lod: 0, textures: true, ...window.__xo.editsForExport(), outPath: ${JSON.stringify(glb)} })`);
  ok(res && fs.existsSync(glb), `build exported (${fs.statSync(glb).size} bytes${res.warnings.length ? ', warnings: ' + res.warnings.join('; ') : ''})`);
  const v = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), glb]).toString().trim();
  ok(v.startsWith('ok'), 'exported build validates: ' + v);
  const doc = JSON.parse(fs.readFileSync(glb).subarray(20, 20 + fs.readFileSync(glb).readUInt32LE(12)).toString());
  const partNodes = doc.nodes.filter((n) => n.extras?.source).length;
  // (a mirrored part brings a mirrored copy of its model's mesh: no node is scaled negatively)
  const looks = new Set((await js('window.__xo.build.serialize().parts')).map((p) => p.path + (p.mirrored ? '|m' : ''))).size;
  const negative = doc.nodes.filter((n) => n.matrix && n.matrix[0] * (n.matrix[5] * n.matrix[10] - n.matrix[9] * n.matrix[6]) - n.matrix[4] * (n.matrix[1] * n.matrix[10] - n.matrix[9] * n.matrix[2]) + n.matrix[8] * (n.matrix[1] * n.matrix[6] - n.matrix[5] * n.matrix[2]) < 0).length;
  // (a part's meshes: its own, or with one object per material (the default, for Cinema 4D) its children's)
  const meshesOf = (n) => n.mesh !== undefined ? [n.mesh] : (n.children || []).map((k) => doc.nodes[k]).filter((c) => c.mesh !== undefined).map((c) => c.mesh);
  const partSets = new Set(doc.nodes.filter((n) => n.extras?.source).map((n) => meshesOf(n).sort((a, b) => a - b).join(',')));
  const usedMeshes = new Set(doc.nodes.filter((n) => n.extras?.source).flatMap(meshesOf));
  ok(partNodes === 5 && partSets.size === looks && usedMeshes.size === doc.meshes.length && doc.meshes.every((m) => m.primitives.length === 1) && negative === 0,
    `one node per part (${partNodes}), one set of meshes per model and side (${partSets.size} for ${looks}; ${doc.meshes.length} meshes, one per material), none scaled negatively`);
  const objPath = path.join(out, 'vehicle.obj');
  await js(`window.__xo.call('exportBuild', { parts: window.__xo.build.exportItems(), name: 'e2e vehicle', format: 'obj', lod: 0, textures: false, outPath: ${JSON.stringify(objPath)} })`);
  const objText = fs.readFileSync(objPath, 'utf8');
  ok((objText.match(/^o /gm) || []).length >= 5, `OBJ build export (${(objText.match(/^o /gm) || []).length} objects)`);

  // Autosave survives a restart
  await sleep(1800);
  const autosaved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'autosave.xobuild'), 'utf8'));
  ok(autosaved.parts.length === 5, 'the build is autosaved');
  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);
  const dataDir = app.dataDir;
  await app.close({ keep: true });
  app = await launch({ dataDir });
  await app.waitFor('window.__xoReady === true', 60000);
  await app.js(`window.__xo.setView('build')`);
  await app.waitFor('window.__xo.build.instances.length === 5', 60000);
  ok(true, 'restarting the app restores the build');
  await app.waitFor('!!window.__xo.state.buildRestored', 30000);
  await sleep(800);
  const tied = await app.js(`({ file: window.__xo.state.buildFile.path, dot: document.getElementById('bQuickSave').classList.contains('dirty'), line: document.getElementById('bFile').textContent })`);
  ok(tied.file === quickPath && !tied.dot && /· saved/.test(tied.line), `after a restart the build is still tied to its file, with nothing unsaved ("${tied.line}")`);
  await app.waitFor('document.getElementById("busy").hidden', 30000);
  await sleep(500);
  await app.snap(shot('b05-restored'));
  ok(app.errors.length === 0, `no page errors after restart${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  const dir = app.dataDir;
  await app.close();
  if (!(await removeDir(dir))) console.log('note: could not delete ' + dir);
}
console.log(failures ? `${failures} failure(s)` : 'all builder checks passed');
process.exit(failures ? 1 : 0);
