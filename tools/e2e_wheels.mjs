// End-to-end test of the wheels' rest pose (Reddit: the light wheels leant in, the others up in their
// arches, against the game): every copy of a wheel starts with its spring at the height the model was
// made at, as the game shows it (ui/anim.js restSprings), not at 0 (the spring all the way up): its
// bones on the model's own pose, the builder's part as tall as the model, the test drive's spring
// from there.
//   node tools/e2e_wheels.mjs
import { launch } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const W = 'models/constructor/chassis/wheels/';
const CASES = [
  ['wheel_light.mdl', 'Small wheel (a swing arm: leant in 8 degrees at 0)'],
  ['wheel_raider_01.mdl', 'Buggy wheel'],
  ['wheel_elementary.mdl', 'Starter wheel'],
  ['wheel_heavy.mdl', 'Medium wheel'],
  ['wheel_r17.mdl', 'r17 (0..0.32)'],
  ['tribal_big1/tribal_big1.mdl', 'Bigfoot (0..0.8)'],
  ['wheel_stance/wheel_stance.mdl', 'Camber (its own 10 degrees)'],
  ['wheel_workers_2modes/wheel_workers_2modes.mdl', 'Widget (standing: 0.55..1.6)'],
  ['wheel_ilon.mdl', 'Omni (TrackSuspension1)'],
];

const app = await launch({ prefix: 'xo-e2e-wheels-' });
const { js, waitFor } = app;
try {
  await waitFor('window.__xoReady === true', 60000);

  // ---- the pose every copy starts from (the Animator's), against the model's own ----
  for (const [file, label] of CASES) {
    const r = await js(`(async () => {
      const { Animator } = await import('./anim.js');
      const v = window.__xo.viewer, info = await window.__xo.getInfo(${JSON.stringify(W + file)});
      const g = await v.makeModel(info, 0, { animate: true });
      try {
        const a = new Animator(v, info, g);
        await a.load();
        const name = 'WheelSuspension' in a.pose ? 'WheelSuspension' : Object.keys(a.pose).find((n) => /^TrackSuspension\\d+$/.test(n));
        const range = a.poses().find((p) => p.name === name);
        const { bones, rest } = g.userData.skeleton, V = bones[0].position.constructor, Q = bones[0].quaternion.constructor;
        // the bone the tyre turns on, and its axle (its own frame): the tyre itself is left out of the
        // positions (WheelRotation 0 has it half a turn round from the model's own), its axle is the camber
        let wb = -1, axis = null;
        if ('WheelRotation' in a.pose) {
          const value = a.pose.WheelRotation;
          a.apply();
          const q0 = bones.map((b) => b.quaternion.clone());
          a.pose.WheelRotation = value + 90;
          a.apply();
          bones.forEach((b, i) => { const d = q0[i].clone().invert().multiply(b.quaternion); if (wb < 0 && 2 * Math.acos(Math.min(1, Math.abs(d.w))) > 1) { wb = i; axis = new V(d.x, d.y, d.z).normalize(); } });
          a.pose.WheelRotation = value;
        }
        const tyre = new Set();
        if (wb >= 0) bones[wb].traverse((o) => { if (o !== bones[wb]) tyre.add(o); });
        const look = () => {
          g.updateMatrixWorld(true);
          const at = bones.map((b) => (tyre.has(b) ? null : b.getWorldPosition(new V())));
          const axle = wb >= 0 ? axis.clone().applyQuaternion(bones[wb].parent.getWorldQuaternion(new Q())) : null;
          return { at, axle };
        };
        bones.forEach((b, i) => { b.position.copy(rest[i].p); b.quaternion.copy(rest[i].q); });
        const own = look();
        const dev = () => {
          a.apply();
          const now = look();
          let cm = 0;
          now.at.forEach((p, i) => { if (p) cm = Math.max(cm, p.distanceTo(own.at[i]) * 100); });
          const deg = now.axle ? (Math.acos(Math.min(1, Math.abs(now.axle.dot(own.axle)))) * 180) / Math.PI : 0;
          return { cm, deg };
        };
        const value = a.pose[name], now = dev();
        a.pose[name] = range.min;
        const up = dev();
        return { name, value, lo: range.min, hi: range.max, ...now, upCm: up.cm, upDeg: up.deg };
      } finally { v.disposeModel(g); }
    })()`);
    ok(r.cm < 1.5 && r.deg < 1.5 && r.upCm > 10,
      `${label}: ${r.name} starts at ${r.value} of ${r.lo}..${r.hi}, on the model's own pose (${r.cm.toFixed(2)} cm, axle ${r.deg.toFixed(2)} deg off; at ${r.lo} the spring all the way up: ${r.upCm.toFixed(1)} cm, axle ${r.upDeg.toFixed(1)} deg)`);
  }

  // ---- the builder's part: as tall as the model (its tyre's underside where the model has it) ----
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 10000).catch(() => {});
  for (const file of ['wheel_light.mdl', 'tribal_big1/tribal_big1.mdl']) {
    const b = await js(`(async () => {
      const v = window.__xo.viewer, B = window.__xo.build, path = ${JSON.stringify(W + file)}, info = await window.__xo.getInfo(path);
      const i = await B.createInstance({ path, position: [0, 0, 0] });
      B.commit();
      const built = i.group.userData.box;
      const g = await v.makeModel(info, 0, { animate: true }), own = g.userData.box.clone();
      v.disposeModel(g);
      const out = { built: [built.min.y, built.max.y], own: [own.min.y, own.max.y] };
      B.setSelection([]); B.removeInstance(i); B.commit();
      return out;
    })()`);
    const d = Math.abs(b.built[0] - b.own[0]) * 100;
    ok(d < 1.5, `the builder's ${file.split('/').pop()} stands as the model does: its underside at ${b.built[0].toFixed(3)} m, the model's ${b.own[0].toFixed(3)} m (${d.toFixed(2)} cm)`);
  }

  // ---- the test drive's spring: from the same height, room both ways ----
  const rig = await js(`(async () => {
    const { Animator } = await import('./anim.js'), { wheelRig, rollsOf } = await import('./drive.js');
    const v = window.__xo.viewer, info = await window.__xo.getInfo(${JSON.stringify(W + 'wheel_r17.mdl')});
    const g = await v.makeModel(info, 0, { animate: true });
    try {
      const a = new Animator(v, info, g);
      await a.load();
      const M = g.matrix.clone().identity(), roll = rollsOf(a, g, M).find((r) => r.name === 'WheelRotation');
      const s = wheelRig(a, g, M, roll.wheel).spring;
      return s && { rest: s.rest, lo: s.lo, hi: s.hi, down: s.down };
    } finally { v.disposeModel(g); }
  })()`);
  ok(rig && rig.rest > rig.lo + 0.1 && rig.rest < rig.hi - 0.1 && rig.down > 0.3, `the test drive's spring starts mid-travel, with room to rise and drop (${JSON.stringify(rig)})`);
  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 3).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
