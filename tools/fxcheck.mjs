// Checks ui/fx.js against the game's own particle files: every .psys is read, every effect that does
// not loop is played (a few seeds) and the space its particles fill is compared with the bounds the
// file stores (header +0x10, which the game's editor wrote). Nothing in the files says what each
// value means; this is how the readings in fx.js were chosen (see CROSSOUT_FORMATS.md, "Particle
// effects").
//   node tools/fxcheck.mjs [path filter, e.g. muzzle] [--runs N] [--list N]
// The files are extracted once with build\xotest.exe (read from the game, written to %TEMP%).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { parsePsys, FxRun, ORIENT } = await import(pathToFileURL(path.join(ROOT, 'ui', 'fx.js')).href);

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? +args[i + 1] : def; };
const filter = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || '';
const RUNS = opt('--runs', 3), LIST = opt('--list', 0);

const dir = path.join(os.tmpdir(), 'xo-fxcheck');
if (!fs.existsSync(path.join(dir, 'particles'))) {
  execFileSync(path.join(ROOT, 'build', 'xotest.exe'), ['extractall', 'particles/', dir, '.psys'], { stdio: 'inherit' });
}
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.psys')) files.push(p); } })(path.join(dir, 'particles'));

let read = 0, bad = 0;
const rows = [];
for (const file of files) {
  const rel = path.relative(dir, file).replace(/\\/g, '/');
  const B = fs.readFileSync(file);
  let sys;
  try { sys = parsePsys(B.buffer.slice(B.byteOffset, B.byteOffset + B.byteLength)); read++; } catch (e) { bad++; console.log(`unreadable ${rel}: ${e.message}`); continue; }
  if (!rel.includes(filter) || sys.loop) continue;
  // particles' reach: a sprite out to half its size times the square's corner (sqrt 2); a streak from
  // its head back along its flight; heat haze and lights left out (the renderer leaves them out too)
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let n = 0;
  for (let run = 0; run < RUNS; run++) {
    const fx = new FxRun(sys, { seed: 1 + run * 7919 });
    for (let t = 0; !fx.done && t < 12; t += 1 / 60) {
      fx.step(1 / 60);
      for (const { e, p } of fx.particles()) {
        if (e.orient === ORIENT.LIGHT || e.blend === 4 || e.blend === 6) continue;
        const o = p.out, pts = [p.pos];
        let r = 0.707 * Math.abs(o.size) * Math.max(Math.abs(o.sizeX), Math.abs(o.sizeY));
        if (e.orient === ORIENT.VELOCITY) {
          const sp = Math.hypot(...p.vel) || 1, len = Math.abs(o.size * o.sizeY) * (e.stretch ? sp : 1);
          pts.push(p.pos.map((x, k) => x - (p.vel[k] / sp) * len));
          r = 0.707 * Math.abs(o.size * o.sizeX);
        }
        for (const q of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k] - r); hi[k] = Math.max(hi[k], q[k] + r); }
        n++;
      }
    }
  }
  if (!n) continue;
  const sim = [...lo, ...hi], errs = [];
  for (let k = 0; k < 6; k++) {
    const f = Math.abs(sys.bounds[k]), s = Math.abs(sim[k]);
    if (f < 0.05 && s < 0.05) continue;
    errs.push(Math.log((s + 0.05) / (f + 0.05)));
  }
  rows.push({ rel, file: sys.bounds, sim, errs, mean: errs.reduce((a, x) => a + Math.abs(x), 0) / Math.max(1, errs.length) });
}
const all = rows.flatMap((r) => r.errs), abs = all.map(Math.abs).sort((a, b) => a - b);
console.log(`read ${read} of ${files.length} effects (${bad} unreadable)`);
console.log(`played ${rows.length}${filter ? ` matching "${filter}"` : ''}: across ${all.length} bound faces the simulated reach is off by ${(Math.exp(abs[abs.length >> 1]) * 100 - 100).toFixed(0)}% at the median; ${(abs.filter((x) => x < Math.log(1.25)).length / abs.length * 100).toFixed(0)}% within 25%`);
if (LIST) {
  rows.sort((a, b) => b.mean - a.mean);
  for (const r of rows.slice(0, LIST)) console.log(`${r.mean.toFixed(2)} ${r.rel}  file ${r.file.map((x) => x.toFixed(1)).join(' ')} | sim ${r.sim.map((x) => x.toFixed(1)).join(' ')}`);
}
process.exit(bad ? 1 : 0);
