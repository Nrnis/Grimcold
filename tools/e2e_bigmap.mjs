// End-to-end test of a map too big to hand over whole: zombie_escape_3 (GitHub issue #1) ended the app
// halfway through loading, its decals 13.9 million triangles in one 1.56 GB response that WebView2's
// in-process part cannot take. Now its decals stay within kDecalTriangles (the volume boxes' shares on
// objects left out, said in the panel) and the map loads whole; and a response too big for the view
// is refused (the map goes on without that part) instead of ending the app.
//   node tools/e2e_bigmap.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch, sleep, removeDir, ROOT } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-e2e-bigmap-'));
let app = await launch({ dataDir });
const alive = () => app.proc.exitCode === null && app.proc.signalCode === null;
const loaded = (ms = 240000) => app.waitFor(`(() => { const m = window.__xo.maps, l = m && m.loading; return !!l && l.finished !== undefined && !l.decals && !l.terrain && !l.ground && l.models > 0 && l.done >= l.models; })()`, ms);
try {
  await app.waitFor('window.__xoReady === true', 120000);
  await app.js(`document.querySelector('#mainMode [data-view="map"]').click()`);
  await app.waitFor('Array.isArray(window.__xo.mapList()) && window.__xo.mapList().length > 0', 60000);

  // ---- the map that ended the app ----
  const t0 = Date.now();
  await app.js(`window.__xo.openMap('zombie_escape_3')`);
  await loaded();
  const st = await app.js(`(() => { const m = window.__xo.maps, s = m.stats(); return { models: s.models, ready: m.models.filter((r) => r.ready).length, errors: m.loading.errors.slice(),
    decals: m.decals ? m.decals.count : -1, tris: m.decals ? [...new Set(m.decals.group.children.map((c) => c.geometry))].reduce((n, g) => n + (g?.index ? g.index.count / 3 : 0), 0) : -1 }; })()`);
  const said = st.errors.find((e) => /^decals: .*left out/.test(e)) || '';
  ok(alive() && st.ready === st.models && st.models > 500, `zombie_escape_3 loads whole: all ${st.ready} of ${st.models} models in ${((Date.now() - t0) / 1000).toFixed(0)} s, the app still running`);
  // what was left out, against the decals counted without the limit (xotest): every volume box off the
  // objects inside it, nothing else touched, the panel's numbers the real ones
  const rk = /ranks uncapped (\d+) (\d+) (\d+) (\d+) capped (\d+) (\d+) (\d+) (\d+)/.exec(execFileSync(path.join(ROOT, 'build', 'xotest.exe'), ['decalinfo', 'zombie_escape_3', '--ranks'], { encoding: 'utf8' }));
  const [u0, u1, u2, u3, c0, c1, c2, c3] = rk ? rk.slice(1).map(Number) : [];
  ok(rk && c0 === 0 && c1 === u1 && c2 === u2 && c3 === u3 && u0 > 0, `only the volume decals' shares on objects are left out, all of them (${rk ? `${(u0 / 1e6).toFixed(1)} million triangles; the rest as built: ${u1} + ${u2} + ${u3}` : 'xotest gave no counts'})`);
  ok(st.decals > 0 && rk && Math.abs(st.tris - (c0 + c1 + c2 + c3)) <= 0.01 * (c0 + c1 + c2 + c3) && st.tris <= 3.5e6 && !st.errors.some((e) => /^decals: (?!.*left out)/.test(e)), `the view draws just those (${(st.tris / 1e6).toFixed(2)} million triangles in ${st.decals} meshes)`);
  const nums = /^decals: ([\d.]+) of the decals' ([\d.]+) million triangles left out.*the volume decals on the objects inside them \((\d+)\)$/.exec(said);
  ok(nums && rk && Math.abs(Number(nums[1]) - u0 / 1e6) < 0.06 && Math.abs(Number(nums[2]) - (u0 + u1 + u2 + u3) / 1e6) < 0.06, `the panel says what was left out, in the real numbers ("${said.slice(0, 160)}")`);

  // ---- a response too big for the view: refused, the map goes on ----
  await app.js(`window.__xo.call('testReport', { maxResponse: 256 * 1024, route: '/mapdecals' })`); // (bridge's decals: about 5 MB)
  await app.js(`window.__xo.openMap('bridge')`);
  await sleep(500);
  await loaded();
  const br = await app.js(`(() => { const m = window.__xo.maps; return { errors: m.loading.errors.slice(), models: m.loading.models, done: m.loading.done }; })()`);
  const refused = br.errors.find((e) => /^decals: .*too big for the view/.test(e)) || '';
  ok(alive() && refused && br.done === br.models, `a response over the limit is refused, the app goes on ("${refused.slice(0, 90)}")`);
  await app.js(`window.__xo.call('testReport', { maxResponse: 0 })`);
  const log = fs.readFileSync(path.join(dataDir, 'logs', 'grimcold.log'), 'utf8');
  ok(/a response was refused: too big for the view/.test(log), 'the log says so');
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
  await removeDir(dataDir);
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
