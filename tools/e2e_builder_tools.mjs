// End-to-end test of the builder's tools asked for after the release: Limits | No limits (No limits:
// a second cabin, past 80 parts, Symmetry's copy of a cabin, a copy onto a taken spot, nothing red;
// remembered), the game's Ctrl+Q / E (tip a part, as T), and
// To the other side (Shift+X, the card's button: mirrored copies across the mirror plane, none on
// the plane, none twice, none overlapping; one undo step).
//   node tools/e2e_builder_tools.mjs
import { launch, sleep } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const CABIN = 'models/constructor/cabins/buggy_start/buggy_start.mdl';
const WHEEL = 'models/constructor/chassis/wheels/wheel_r17.mdl';
const GUN = 'models/weapons/machinegun_smg/machinegun_smg.mdl';

const app = await launch({ prefix: 'xo-e2e-buildtools-' });
const { js, waitFor, key } = app;
const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
const add = (path, position) => js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(path)}, position: ${JSON.stringify(position)} }); b.commit(); return i.id; })()`);
const quat = (id) => js(`window.__xo.build.get(${id}).group.quaternion.toArray().map((v) => Math.round(v * 1e4) / 1e4)`);
try {
  await waitFor('window.__xoReady === true', 60000);
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 10000).catch(() => {});
  await settle();

  // ---- Limits | No limits ----
  const LIM = (l) => `document.querySelector('#bLimitsSeg [data-l="${l}"]').click()`;
  const cab = await add(CABIN, [0, 0, 0]);
  await settle();
  const on = await js(`window.__xo.build.rules([{ path: ${JSON.stringify(CABIN)} }])`);
  const many = await js(`window.__xo.build.rules(Array.from({ length: 80 }, () => ({ path: ${JSON.stringify(GUN)} })))`);
  // (Limits: a loose part far off is red; Symmetry makes no copy of a second cabin)
  const loose = await add(GUN, [6, 0, 6]);
  await settle();
  const redOf = (id) => js(`window.__xo.build.get(${id}).group.userData.materials.some((m) => m.userData.xo.u.xoOverlayAmt.value > 0)`);
  const redOn = await redOf(loose);
  await js(`(async () => { const b = window.__xo.build; document.getElementById('bSym').checked = true; await b.setSymmetry(true); await b.startPlacing(${JSON.stringify(CABIN)}); })()`);
  await waitFor('!!window.__xo.build.placing', 20000);
  await sleep(500);
  const twinOn = await js('!!window.__xo.build.placing.twin');
  await js(LIM('off'));
  await sleep(800);
  const twinOff = await js('!!window.__xo.build.placing?.twin');
  await key('Escape');
  await js(`(async () => { document.getElementById('bSym').checked = false; await window.__xo.build.setSymmetry(false); })()`);
  await settle();
  const off = await js(`window.__xo.build.rules([{ path: ${JSON.stringify(CABIN)} }])`), manyOff = await js(`window.__xo.build.rules(Array.from({ length: 80 }, () => ({ path: ${JSON.stringify(GUN)} })))`);
  ok(/one cabin/.test(on || '') && /80 parts/.test(many || '') && off === null && manyOff === null, `Limits: a second cabin and an 81st part are refused ("${on}"); No limits: both go`);
  ok(!twinOn && twinOff, 'No limits: Symmetry makes a mirrored copy of a cabin too (Limits: none, one cabin a vehicle)');
  ok(redOn && !(await redOf(loose)), 'No limits: a part that is not welded on is not red (Limits: red)');
  // (the stats: nothing red for going past the game's limits)
  const red = await js(`(async () => { const g = await import('./garage.js'); const v = { parts: 95, energy: { used: 30, supply: 10, free: -20, weapons: 30, modules: 0, cabin: 10, generators: 0, nGenerators: 0 }, mass: 9000, massLimit: 5000, tooHeavy: true, tonnage: 9000, cabin: true, cabins: ['a', 'b'], engines: 1, unknown: 0 };
    const n = (html) => (html.match(/vs-row bad|eb-cell neg big/g) || []).length;
    return { on: n(g.vehicleStatsHtml(v)) + n(g.energyBarHtml(v)), off: n(g.vehicleStatsHtml(v, { limits: false })) + n(g.energyBarHtml(v, { limits: false })) }; })()`);
  ok(red.on >= 4 && red.off === 0, `No limits: no red for too many parts, too little energy or too much mass (Limits: ${red.on} red)`);
  await js('location.reload()').catch(() => {});
  await sleep(1500);
  await waitFor('window.__xoReady === true', 60000);
  ok(await js(`document.querySelector('#bLimitsSeg [data-l="off"]').classList.contains('on') && window.__xo.build.noLimits === true`), 'the switch is remembered after a restart');
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 20000).catch(() => {});
  await settle();
  await js(`(() => { const b = window.__xo.build; for (const i of [...b.instances]) b.removeInstance(i); b.commit(); })()`);
  await settle();
  // (No limits: a held part may go inside another, and is dropped there; Limits: red, refused)
  const cA = await add(CABIN, [0, 0, 0]);
  await settle();
  await js('window.__xo.build.frame()');
  await sleep(600);
  const holdAt = async () => {
    const gp = await js(`(() => { const b = window.__xo.build.get(${cA}).box; return window.__xo.viewer.project(b.max.x + 0.25, 0, (b.min.z + b.max.z) / 2); })()`);
    await js(`window.__xo.build.startPlacing(${JSON.stringify(CABIN)})`);
    await waitFor('!!window.__xo.build.placing', 20000);
    await app.mouse('mouseMoved', gp.x - 3, gp.y);
    await sleep(80);
    await app.mouse('mouseMoved', gp.x, gp.y);
    await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
    await sleep(200);
    return { gp, valid: await js('window.__xo.build.placing.valid'), inside: await js(`(() => { const p = window.__xo.build.placing, b = window.__xo.build.get(${cA}).box; const c = p.ghost.position; return c.x < b.max.x + 1.2; })()`) };
  };
  const held = await holdAt();
  const nA = await js('window.__xo.build.instances.length');
  await app.click(held.gp.x, held.gp.y);
  await settle();
  const droppedIn = (await js('window.__xo.build.instances.length')) === nA + 1;
  await key('Escape');
  await key('z', { ctrl: true });
  await settle();
  await js(LIM('on'));
  await sleep(300);
  const heldOn = await holdAt();
  await key('Escape');
  await settle();
  await js(LIM('off'));
  ok(held.valid && held.inside && droppedIn && heldOn.valid === false, `No limits: a cabin held inside another is not red and is dropped there (Limits: red, ${heldOn.valid === false ? 'refused' : 'NOT refused'})`);
  await js(`(() => { const b = window.__xo.build; for (const i of [...b.instances]) b.removeInstance(i); b.commit(); })()`);
  await settle();
  // (No limits: To the other side copies onto a spot that is taken)
  const c0 = await add(CABIN, [0, 0, 0]);
  const wa = await add(GUN, [1.5, 0, 0.9]);
  await settle();
  const mx = await js('window.__xo.build.mirrorX()');
  await add(GUN, [2 * mx - 1.5, 0, 0.9]); // (another gun, not mirrored, where the copy would go: a gun's middle is its origin, a wheel's is not)
  await settle();
  const n0 = await js('window.__xo.build.instances.length');
  await js(`window.__xo.build.setSelection([${wa}])`);
  await js(`document.getElementById('bMirrorSide').click()`);
  await settle();
  const madeOff = (await js('window.__xo.build.instances.length')) - n0;
  await key('z', { ctrl: true });
  await settle();
  await js(LIM('on')); // (back to Limits for the rest)
  await sleep(300);
  await js(`window.__xo.build.setSelection([${wa}])`);
  await js(`document.getElementById('bMirrorSide').click()`);
  await settle();
  const madeOn = (await js('window.__xo.build.instances.length')) - n0, msgOn = await js(`document.getElementById('statusText').textContent`);
  ok(madeOff === 1 && madeOn === 0 && /would overlap/.test(msgOn), `No limits: To the other side copies onto a taken spot too (Limits: "${msgOn}")`);
  await js(`(() => { const b = window.__xo.build; for (const i of [...b.instances]) b.removeInstance(i); b.commit(); })()`);
  await settle();
  void c0;

  // ---- Ctrl+Q / E: tip, as T ----
  const g = await add(GUN, [1.2, 0, 0]);
  await settle();
  await js(`window.__xo.build.select(${g})`);
  const q0 = await quat(g);
  await key('t');
  await settle();
  await sleep(400);
  const qT = await quat(g);
  await key('t', { shift: true });
  await settle();
  await sleep(400);
  await key('q', { ctrl: true });
  await settle();
  await sleep(400);
  const qQ = await quat(g);
  await key('e', { ctrl: true });
  await settle();
  await sleep(400);
  const qE = await quat(g);
  const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-3) || a.every((v, i) => Math.abs(v + b[i]) < 1e-3);
  ok(!same(q0, qT) && same(qQ, qT) && same(qE, q0), `Ctrl+Q tips the part as T does, Ctrl+E tips it back (${JSON.stringify(q0)} -> ${JSON.stringify(qQ)} -> ${JSON.stringify(qE)})`);

  // ---- To the other side ----
  await js(`(() => { const b = window.__xo.build; for (const i of [...b.instances]) b.removeInstance(i); b.commit(); })()`);
  await settle();
  const c2 = await add(CABIN, [0, 0, 0]);
  const w1 = await add(WHEEL, [1.5, 0, 0.9]), w2 = await add(WHEEL, [1.5, 0, -0.9]);
  await settle();
  const before = await js('window.__xo.build.instances.length');
  await js(`window.__xo.build.setSelection([${w1}, ${w2}, ${c2}])`);
  await key('x', { shift: true });
  await settle();
  await sleep(300);
  const after = await js(`(() => { const b = window.__xo.build, mx = b.mirrorX(); return { n: b.instances.length, mx, copies: b.instances.filter((i) => i.path.endsWith('wheel_r17.mdl') && i.mirrored).map((i) => i.group.position.toArray().map((v) => Math.round(v * 100) / 100)),
    status: document.getElementById('statusText').textContent, sel: b.selection().length }; })()`);
  const mirrored = (x) => after.copies.some((p) => Math.abs(p[0] - x) < 0.02);
  ok(after.n === before + 2 && after.copies.length === 2 && mirrored(2 * after.mx - 1.5) && /Mirrored 2 parts to the other side/.test(after.status) && /mirror plane/.test(after.status),
    `Shift+X copies the two wheels mirrored to the other side, the cabin on the plane gets none ("${after.status}")`);
  await js(`window.__xo.build.setSelection([${w1}])`);
  await js(`document.getElementById('bMirrorSide').click()`);
  await settle();
  await sleep(300);
  const again = await js(`({ n: window.__xo.build.instances.length, status: document.getElementById('statusText').textContent })`);
  ok(again.n === before + 2 && /has its copy there already/.test(again.status), `the card's button makes no second copy ("${again.status}")`);
  await key('z', { ctrl: true });
  await settle();
  await sleep(300);
  ok(await js(`window.__xo.build.instances.length`) === before, 'one Ctrl+Z takes both copies back');
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
