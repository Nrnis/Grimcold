// Closing the app in the middle of a long export: the export is cancelled, the process is gone
// within seconds, and no half-written file is left under a real name.
//   node tools/e2e_quit.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-quit-' });
const dir = app.dataDir;
const out = path.join(dir, 'out');
fs.mkdirSync(out, { recursive: true });
try {
  await app.waitFor('window.__xoReady === true', 60000);
  // 60 different parts with textures: tens of seconds of work
  const parts = await app.js(`(() => { const f = [...window.__xo.state.folders.values()].filter(f => f.cat === 'Cabins' || f.cat === 'Weapons'); const step = Math.floor(f.length / 60); return f.filter((_, i) => i % step === 0).slice(0, 60).map((f, i) => ({ path: f.main, skin: '', name: 'p' + i, matrix: [1,0,0,0, 0,1,0,0, 0,0,1,0, (i % 8) * 3, 0, Math.floor(i / 8) * 3, 1] })); })()`);
  const target = path.join(out, 'huge.glb');
  await app.js(`(() => { window.__exportResult = null; window.__xo.call('exportBuild', { parts: ${JSON.stringify(parts)}, name: 'huge', format: 'glb', lod: 0, textures: true, outPath: ${JSON.stringify(target)} }).then(r => window.__exportResult = { ok: true, r }, e => window.__exportResult = { ok: false, e: e.message }); })()`);
  await sleep(2500);
  const done = await app.js('window.__exportResult');
  ok(!done, `the export of ${parts.length} parts is still running after 2.5 s`);
  const exited = app.proc.exitCode !== null ? Promise.resolve() : new Promise((r) => app.proc.once('exit', r));
  const t0 = Date.now();
  await app.js(`window.__xo.call('quit', {})`).catch(() => {});
  const gone = await Promise.race([exited.then(() => true), sleep(15000).then(() => false)]);
  const took = Date.now() - t0;
  ok(gone && took < 6500, `closing the window ends the app in ${took} ms (export cancelled)`);
  const left = fs.readdirSync(out);
  ok(!left.includes('huge.glb'), `no unfinished export under its real name (${left.length ? left.join(', ') : 'folder empty'})`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  await app.close({ keep: true });
  if (!(await removeDir(dir))) console.log('note: could not delete ' + dir);
}
console.log(failures ? `${failures} failure(s)` : 'all quit checks passed');
process.exit(failures ? 1 : 0);
