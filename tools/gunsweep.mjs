// Fires every gun of the game once at the training target (headless, muted app) and lists what
// looks wrong: effects or round models missing, no rounds, rounds that land nowhere or miss the
// target, sounds missing, page errors. One gun per weapon folder (its main model).
//   node tools/gunsweep.mjs [filter] [--json out.json]
// A gun's line: its kind of round (fxmap.js), rounds fired by three shots, where they landed within
// 4 s (hits on the target), beams held. Streams (flamethrowers, frost guns) launch their rounds from
// the animation clock, not from the three shots: "no rounds" there is expected; so are mines, traps,
// fence poles, ion shields and drones that lie or hover before they go off (no hits within 4 s).
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const filter = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--json') || '';
const LIES = /^(mine|trap|fence|ionShield|drone|droneLegend)$/, STREAMS = /^(flame|frost)$/;

const app = await launch({ prefix: 'xo-gunsweep-', size: '1300,800' });
const { js, waitFor } = app;
const results = [];
let bad = 0;
try {
  await waitFor('window.__xoReady === true', 120000);
  await js(`window.__xo.state.settings.fxTarget = 10`);
  const guns = await js(`(async () => {
    const xo = window.__xo, { shotFor, muzzleFor } = await import('./fxmap.js');
    const byFolder = new Map();
    for (const f of xo.state.files) {
      const m = /^models\\/weapons\\/([^/]+)\\/([^/]+)\\.mdl$/.exec(f.name);
      if (!m || m[1] === 'projectiles' || m[1] === 'crossbow_arrow') continue;
      if (!byFolder.has(m[1]) || m[2] === m[1]) byFolder.set(m[1], f.name);
    }
    return [...byFolder.values()].filter((p) => shotFor(p) || muzzleFor(p)).sort();
  })()`);
  const list = guns.filter((g) => g.includes(filter));
  console.log(`${list.length} guns`);
  for (const mdl of list) {
    const errs0 = app.errors.length;
    let r;
    try {
      r = await js(`(async () => {
        const xo = window.__xo, v = xo.viewer, mdl = ${JSON.stringify(mdl)};
        await xo.openModel(mdl, { assembled: false });
        for (let i = 0; i < 400 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
        const a = xo.state.animator;
        if (!a) return { err: 'no animator' };
        const fire = [...a.layers.values()].find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || ''));
        if (!fire) return { err: 'no Fire' };
        const sel = document.getElementById('animSel'); sel.value = fire.name; sel.dispatchEvent(new Event('change'));
        a.playing = false;
        await new Promise((r) => setTimeout(r, 1200)); // (the target, the camera)
        v.stopShots(); v.fx.clear(); v.fx.paused = true;
        const info = xo.state.info, spec = v.shotFor(info.path), muzzle = v.fxFor(info.path), snd = v.soundFor(info.path, fire.activity);
        const loads = {};
        for (const p of [muzzle, spec?.proj, spec?.beam, spec?.rope, spec?.work, spec?.boom, spec?.fenceBeam, ...(spec?.hits || [])]) if (p) loads[p.split('/').pop()] = !!(await v.fx.load(p));
        const meshOk = spec?.mesh ? !!(await v.fx.meshOf(spec.mesh)) : null;
        const fams = snd ? ['shot', 'loop', 'start', 'end', 'tail', 'shells'].filter((k) => snd[k]).map((k) => snd[k]) : [];
        const sndMissing = [];
        for (const f of fams) if (!(await v.sounds.variants(f)).length) sndMissing.push(Array.isArray(f) ? f.join('|') : f);
        const fired = [], lands = [], fire0 = v.fx.fire.bind(v.fx), imp = v.fx.impact.bind(v.fx);
        v.fx.fire = (sp, ...rest) => { fired.push(sp.kind); return fire0(sp, ...rest); };
        v.fx.impact = (p, h) => { lands.push(h.surface); return imp(p, h); };
        for (let k = 0; k < 3; k++) v.onShot(v.part, fire.activity, k, info);
        await new Promise((r) => setTimeout(r, 300));
        let beams = 0;
        for (let t = 0; t < 4; t += 1 / 120) {
          v.fx.advance(1 / 120);
          beams = Math.max(beams, v.fx.beams.filter((b) => b.alive).length);
          if (t % 0.1 < 1 / 120) await new Promise((r) => setTimeout(r, 0));
        }
        const left = v.fx.shots.map((s) => s.state);
        v.stopShots();
        delete v.fx.fire; delete v.fx.impact;
        v.fx.clear(); v.fx.paused = false;
        return { kind: spec?.kind || null, loads, meshOk, snd: fams.length, sndMissing, fired: fired.length, lands: lands.length,
          onTarget: lands.filter((s) => s === 1).length, beams, left, target: !!v.target?.visible };
      })()`);
    } catch (e) {
      r = { err: String(e.message || e).slice(0, 200) };
    }
    r.mdl = mdl;
    r.pageErrors = app.errors.slice(errs0).map((e) => String(e).slice(0, 160));
    results.push(r);
    const why = [];
    if (r.err) why.push('ERR ' + r.err);
    if (r.loads && Object.values(r.loads).some((x) => !x)) why.push('effect missing: ' + Object.entries(r.loads).filter(([, x]) => !x).map(([k]) => k).join(','));
    if (r.meshOk === false) why.push('round model missing');
    if (r.kind && !r.fired && !r.beams && r.kind !== 'tntSpear' && !STREAMS.test(r.kind)) why.push('no rounds');
    if (r.fired && !r.lands && !r.beams && !LIES.test(r.kind)) why.push('rounds landed nowhere');
    if (r.kind && r.target && r.lands && !r.onTarget && !LIES.test(r.kind)) why.push('target missed');
    if (r.sndMissing?.length) why.push('sound missing: ' + r.sndMissing.join(','));
    if (!r.snd && !r.err) why.push('no sound');
    if (r.pageErrors.length) why.push('page errors: ' + r.pageErrors[0]);
    if (r.left?.includes('fly')) why.push('rounds still flying after 4 s');
    if (why.length) bad++;
    console.log(`${why.length ? 'BAD ' : 'ok  '}${mdl.replace('models/weapons/', '').padEnd(64)} ${r.kind || '-'} fired ${r.fired ?? '-'} landed ${r.lands ?? '-'} on target ${r.onTarget ?? '-'} beams ${r.beams ?? '-'}${why.length ? '  <- ' + why.join(' | ') : ''}`);
  }
} finally {
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1));
  await app.close();
}
console.log(bad ? `${bad} gun(s) to look at` : 'every gun fires');
process.exit(bad ? 1 : 0);
