// End-to-end test of how a held part snaps onto a build in the Vehicle Builder (build.js pickSnap):
// a big gun (AA Gun-4 Starfall) held over a cabin that already carries one (tribal_cab3), the cursor
// swept across it in 4 px steps from two views. Over the cabin's top it welds on; it follows the
// cursor a cell at a time (no jumps of several cells while it stays welded and free on the same face),
// hardly ever against the cursor; pointed at the other gun it slides on along the roof behind it; just
// off the roof's edge it stays where it was; R / T / Y and Q / E (real keys) turn it a quarter turn as
// the user sees it (spin on its face, tip towards the camera, roll about the view), shown turning, and
// the part card's arrows turn a placed one the way they point; dropped at a free spot it is welded to
// the cabin.
//   node tools/e2e_place.mjs
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const CAB = 'models/constructor/cabins/tribal_cab3/tribal_cab3.mdl';
const GUN = 'models/weapons/autocannon_airdefense/autocannon_airdefense.mdl';

const app = await launch({ prefix: 'xo-e2e-place-' });
const { js, waitFor } = app;
try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.setView('build')`);
  await sleep(1000);
  await js(`(async () => { const b = window.__xo.build;
    await b.createInstance({ path: ${JSON.stringify(CAB)}, skin: 'default', position: [-0.9, 0.15, -1.2], quaternion: [0, 0, 0, 1] });
    await b.createInstance({ path: ${JSON.stringify(GUN)}, skin: 'default', position: [-0.6, 1.35, -1.95], quaternion: [0, 0, 0, 1] });
    b.commit(); })()`);
  await waitFor('!window.__xo.build.busy && window.__xo.build.instances.length === 2', 30000);
  await js(`window.__xo.build.startPlacing(${JSON.stringify(GUN)})`);
  await waitFor('!!window.__xo.build.placing && !window.__xo.build.busy', 30000);

  // one view's sweep: the camera along dir from the build's middle, 9 lines across the cabin, 4 px steps
  const sweep = (dir) => js(`(() => {
    const b = window.__xo.build, v = window.__xo.viewer, T = v.camera.position.constructor;
    const box = b.box(), c = box.getCenter(new T()), size = box.getSize(new T()).length();
    v.camera.position.copy(c).addScaledVector(new T(${dir.join(',')}).normalize(), size * 1.6); v.controls.target.copy(c); v.camera.lookAt(c); v.controls.update(); v.camera.updateMatrixWorld();
    const r = v.canvas.getBoundingClientRect(), cab = b.instances[0], xs = [], ys = [];
    for (const x of [cab.box.min.x, cab.box.max.x]) for (const y of [cab.box.min.y, cab.box.max.y]) for (const z of [cab.box.min.z, cab.box.max.z]) {
      const p = new T(x, y, z).project(v.camera); xs.push(r.left + (p.x + 1) / 2 * r.width); ys.push(r.top + (1 - p.y) / 2 * r.height); }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    let top = 0, welded = 0, steps = 0, pure = 0, back = 0;
    for (let k = 1; k <= 9; k++) {
      let prev = null;
      for (let x = x0; x <= x1; x += 4) {
        const y = y0 + (y1 - y0) * k / 10;
        b.lastPointer = { clientX: x, clientY: y };
        b.updatePlacement();
        const p = b.placing, hit = b.lastHit, at = p.ghost.position.clone();
        const cur = { on: p.onPart, snapped: p.snapped, valid: p.valid, welds: p.covered ? p.covered.size : 0, face: p.snapFace, q: p.ghost.quaternion.clone(), g: at, hit: hit && hit.clone() };
        if (cur.on === cab && hit && hit.y > 1.2) { top++; if (cur.snapped && cur.welds > 0) welded++; }
        if (prev && cur.on && prev.on) {
          steps++;
          const d = Math.max(Math.abs(at.x - prev.g.x), Math.abs(at.y - prev.g.y), Math.abs(at.z - prev.g.z));
          if (d > 0.31 && cur.snapped && prev.snapped && cur.valid && prev.valid && cur.face === prev.face && cur.q.equals(prev.q)) pure++;
          if (hit && prev.hit && d > 0.01 && hit.clone().sub(prev.hit).dot(at.clone().sub(prev.g)) < 0) back++;
        }
        prev = cur.on ? cur : null;
      }
    }
    return { top, welded, steps, pure, back };
  })()`);
  for (const [name, dir] of [['from the front, above', [-1, 0.8, -1.1]], ['from above', [0, 1.6, -0.2]]]) {
    const s = await sweep(dir);
    ok(s.top > 40 && s.welded >= 0.9 * s.top, `${name}: over the cabin's top the held gun welds onto it (${s.welded} of ${s.top} cursor points)`);
    ok(s.steps > 200 && s.pure <= 0.02 * s.steps, `${name}: it follows the cursor a cell at a time (${s.pure} jumps of more than a cell in ${s.steps} steps of 4 px while it stays welded and free on the same face)`);
    ok(s.back <= 0.03 * s.steps, `${name}: it hardly ever moves against the cursor (${s.back} of ${s.steps} steps)`);
    if (name === 'from above') {
      // pointed at the other gun's body just above its base: the roof behind it is what it lands on
      const g = await js(`(() => {
        const b = window.__xo.build, v = window.__xo.viewer, T = v.camera.position.constructor, r = v.canvas.getBoundingClientRect(), cab = b.instances[0], gun = b.instances[1];
        const c = gun.box.getCenter(new T()); c.y = gun.box.min.y + 0.4;
        const p0 = c.project(v.camera), at = { clientX: r.left + (p0.x + 1) / 2 * r.width, clientY: r.top + (1 - p0.y) / 2 * r.height };
        b.lastPointer = at; b.updatePlacement();
        const p = b.placing;
        return { first: b.instanceAt(at) === gun, on: p.onPart === cab, snapped: p.snapped, y0: p.ghost.position.y };
      })()`);
      ok(g.first && g.on && g.snapped && Math.abs(g.y0 - 1.35) < 0.01, `pointed at the other gun, it slides on along the roof behind it (snapped ${g.snapped}, on the cabin ${g.on}, its base ${g.y0.toFixed(2)} m up)`);
    }
  }
  // just off the roof's edge: it stays where it was
  const edge = await js(`(() => {
    const b = window.__xo.build, v = window.__xo.viewer, T = v.camera.position.constructor, r = v.canvas.getBoundingClientRect();
    // from the roof's middle upwards on screen, snapped all the way, until the cursor is off the build
    const cab = b.instances[0], p0 = new T((cab.box.min.x + cab.box.max.x) / 2, cab.box.max.y, (cab.box.min.z + cab.box.max.z) / 2).project(v.camera);
    let x = r.left + (p0.x + 1) / 2 * r.width, y = r.top + (1 - p0.y) / 2 * r.height, snap = null;
    for (; y > r.top + 4; y -= 4) {
      b.lastPointer = { clientX: x, clientY: y }; b.updatePlacement();
      const p = b.placing;
      if (!b.instanceAt({ clientX: x, clientY: y })) break;
      if (p.snapped) snap = p.ghost.position.clone();
    }
    const p = b.placing;
    return { off: !b.instanceAt({ clientX: x, clientY: y }), had: !!snap, snapped: p.snapped, same: !!snap && p.ghost.position.distanceTo(snap) < 1e-6 };
  })()`);
  ok(edge.off && edge.had && edge.snapped && edge.same, `just off the roof's edge it stays where it was (snapped ${edge.snapped}, unmoved ${edge.same})`);
  // ---- turning (real keys): R spins the held gun on the face it sits on and Shift+R turns it back, T
  // tips it about the screen's horizontal (its top towards the camera), Y rolls it about the view; a
  // quarter turn of the gun as it is shown each, shown turning over a moment ----
  const turnSpot = await js(`(() => {
    const b = window.__xo.build, v = window.__xo.viewer, T = v.camera.position.constructor;
    const box = b.box(), c = box.getCenter(new T()), size = box.getSize(new T()).length();
    v.camera.position.copy(c).addScaledVector(new T(-1, 0.8, -1.1).normalize(), size * 1.6); v.controls.target.copy(c); v.camera.lookAt(c); v.controls.update(); v.camera.updateMatrixWorld();
    const r = v.canvas.getBoundingClientRect(), cab = b.instances[0], xs = [], ys = [];
    for (const x of [cab.box.min.x, cab.box.max.x]) for (const y of [cab.box.min.y, cab.box.max.y]) for (const z of [cab.box.min.z, cab.box.max.z]) {
      const p = new T(x, y, z).project(v.camera); xs.push(r.left + (p.x + 1) / 2 * r.width); ys.push(r.top + (1 - p.y) / 2 * r.height); }
    for (let y = Math.min(...ys); y <= Math.max(...ys); y += 6) for (let x = Math.min(...xs); x <= Math.max(...xs); x += 6) {
      b.lastPointer = { clientX: x, clientY: y }; b.updatePlacement();
      const p = b.placing;
      if (p.snapped && p.valid && p.onPart === cab && p.snapFace && p.snapFace.y > 0.9) return { x, y };
    }
    return null; })()`);
  ok(!!turnSpot, 'a free spot on the roof to turn the gun on');
  if (turnSpot) {
    // what the last key did to the gun as shown: the angle, the axis, welded, its up now
    const turned = async (k, shift = false) => {
      const q0 = await js('window.__xo.build.placing.effQuat.toArray()');
      await app.key(k, { shift });
      return js(`(() => { const b = window.__xo.build, p = b.placing, v = window.__xo.viewer, Q = p.effQuat.constructor, V = v.camera.position.constructor;
        const q1 = p.effQuat.clone(), shown = p.ghost.quaternion.clone(), d = q1.clone().multiply(new Q(...${JSON.stringify(q0)}).invert());
        const ang = 2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI, ax = new V(d.x, d.y, d.z).normalize().multiplyScalar(d.w < 0 ? -1 : 1);
        return { ang, axis: ax.toArray(), welded: !!(p.snapped && p.covered && p.covered.size), midway: 2 * Math.acos(Math.min(1, Math.abs(shown.dot(q1)))) * 180 / Math.PI,
          right: new V(1, 0, 0).applyQuaternion(v.camera.quaternion).toArray(), into: new V(0, 0, -1).applyQuaternion(v.camera.quaternion).toArray(), up: new V(0, 1, 0).applyQuaternion(q1).toArray() }; })()`);
    };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const spin = await turned('r');
    ok(Math.abs(spin.ang - 90) < 0.5 && spin.axis[1] > 0.99 && spin.welded, `R spins the held gun a quarter turn on the roof, about its normal (${spin.ang.toFixed(1)}° about ${spin.axis.map((x) => x.toFixed(2)).join(' ')}), still welded`);
    ok(spin.midway > 2, `it is shown turning (${spin.midway.toFixed(0)}° from its end just after the key)`);
    await sleep(400);
    ok((await js('(() => { const p = window.__xo.build.placing; return p.ghost.quaternion.angleTo(p.effQuat) * 180 / Math.PI; })()')) < 0.1, 'and ends where the snap put it');
    const back = await turned('r', true);
    ok(Math.abs(back.ang - 90) < 0.5 && back.axis[1] < -0.99, `Shift+R spins it back (${back.ang.toFixed(1)}°)`);
    const tip = await turned('t');
    ok(Math.abs(tip.ang - 90) < 0.5 && Math.abs(dot(tip.axis, tip.right)) > 0.7 && dot(tip.up, tip.into) < -0.5, `T tips it about the screen's horizontal (${tip.ang.toFixed(1)}° about ${tip.axis.map((x) => x.toFixed(2)).join(' ')}), its top towards the camera`);
    await turned('t', true);
    const roll = await turned('y');
    ok(Math.abs(roll.ang - 90) < 0.5 && dot(roll.axis, roll.into) > 0.5 && Math.abs(dot(roll.axis, tip.axis)) < 0.01 && Math.abs(dot(roll.axis, spin.axis)) < 0.01,
      `Y rolls it about the view (${roll.ang.toFixed(1)}° about ${roll.axis.map((x) => x.toFixed(2)).join(' ')}, square to the spin and the tip)`);
    await turned('y', true);
    // a drop in the middle of a turn takes its end (commitPlacing: finishTurn)
    await app.key('r');
    const end = await js(`(() => { const b = window.__xo.build, p = b.placing; b.finishTurn(); return p.ghost.quaternion.angleTo(p.effQuat) * 180 / Math.PI; })()`);
    ok(end < 0.1, "a drop during a turn takes the turn's end");
    await app.key('r', { shift: true });
    // Q / E spin it left / right: Q anticlockwise as seen from above (as R), E clockwise
    const qk = await turned('q');
    ok(Math.abs(qk.ang - 90) < 0.5 && qk.axis[1] > 0.99 && dot(qk.axis, qk.into) < 0, `Q spins it left, anticlockwise as seen (${qk.ang.toFixed(1)}°, as R)`);
    const ek = await turned('e');
    ok(Math.abs(ek.ang - 90) < 0.5 && ek.axis[1] < -0.99, `E spins it right, clockwise as seen (${ek.ang.toFixed(1)}°, back)`);
    // a placed part: R spins it about the way its welds face (the roof gun: the vertical)
    const placed = await js(`(async () => { const b = window.__xo.build, v = window.__xo.viewer, V = v.camera.position.constructor; b.cancelPlacing(); const gun = b.instances[1]; b.select(gun.id);
      const q0 = gun.group.quaternion.clone(); b.turn('spin', 1); const q1 = gun.group.quaternion.clone(), d = q1.clone().multiply(q0.clone().invert());
      const out = { ang: 2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI, y: Math.abs(d.y) / Math.max(1e-9, Math.hypot(d.x, d.y, d.z)) };
      b.turn('spin', -1); out.back = gun.group.quaternion.angleTo(q0) * 180 / Math.PI;
      // the card's arrows as the camera sees the gun (> 0: anticlockwise): ↺ as R, ↻ as Shift+R
      const seen = (qa, qb) => { const e = qb.clone().multiply(qa.clone().invert()); return new V(e.x, e.y, e.z).multiplyScalar(e.w < 0 ? -1 : 1).dot(v.camera.position.clone().sub(gun.box.getCenter(new V()))); };
      const arrow = (t) => [...document.querySelectorAll('#bSelCard [data-turn]')].find((el) => el.textContent.trim() === t);
      const a0 = gun.group.quaternion.clone(); arrow('↺').click(); const a1 = gun.group.quaternion.clone(); arrow('↻').click();
      Object.assign(out, { ccw: seen(a0, a1), ccwAng: a1.angleTo(a0) * 180 / Math.PI, cw: seen(a1, gun.group.quaternion.clone()), arrowBack: gun.group.quaternion.angleTo(a0) * 180 / Math.PI, titles: [arrow('↺').title, arrow('↻').title] });
      await b.startPlacing(${JSON.stringify(GUN)}); return out; })()`);
    ok(Math.abs(placed.ang - 90) < 0.5 && placed.y > 0.99 && placed.back < 0.1, `R spins a placed gun about the way its welds face (${placed.ang.toFixed(1)}°, about the vertical; Shift+R back)`);
    ok(Math.abs(placed.ccwAng - 90) < 0.5 && placed.ccw > 0 && placed.cw < 0 && placed.arrowBack < 0.1 && /\(R\)/.test(placed.titles[0]) && /Shift\+R/.test(placed.titles[1]),
      `the card's ↺ turns it anticlockwise as seen, as R; ↻ clockwise, as Shift+R (${placed.titles.join(' / ')})`);
  }
  // dropped at a free welded spot: it is a part of the vehicle, welded to the cabin
  const dropped = await js(`(async () => {
    const b = window.__xo.build, v = window.__xo.viewer, T = v.camera.position.constructor, r = v.canvas.getBoundingClientRect();
    const cab = b.instances[0];
    for (let fx = 0.2; fx <= 0.8; fx += 0.05) {
      const p0 = new T(cab.box.min.x + (cab.box.max.x - cab.box.min.x) * fx, cab.box.max.y, (cab.box.min.z + cab.box.max.z) / 2 + 0.3).project(v.camera);
      b.lastPointer = { clientX: r.left + (p0.x + 1) / 2 * r.width, clientY: r.top + (1 - p0.y) / 2 * r.height }; b.updatePlacement();
      if (b.placing.snapped && b.placing.valid && b.placing.covered?.size > 0) {
        const placed = await b.commitPlacing();
        b.cancelPlacing();
        return { placed, parts: b.instances.length, groups: b.components().length, loose: b.loose.size };
      }
    }
    return null;
  })()`);
  ok(dropped && dropped.placed && dropped.parts === 3 && dropped.groups === 1 && dropped.loose === 0, `dropped at a free spot, it is welded to the cabin (${dropped ? dropped.parts + ' parts in ' + dropped.groups + ' group, ' + dropped.loose + ' loose' : 'no free spot found'})`);
  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  const dir = app.dataDir;
  await app.close();
  if (!(await removeDir(dir))) console.log('note: could not delete ' + dir);
}
console.log(failures ? `${failures} failure(s)` : 'all placement checks passed');
process.exit(failures ? 1 : 0);
