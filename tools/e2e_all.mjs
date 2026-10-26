// Runs every end-to-end suite in turn (each starts the app hidden, muted, on a throwaway profile)
// and sums up. XO_EXE (see cdp.mjs) is passed on.
//   node tools/e2e_all.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './cdp.mjs';

const suites = ['e2e.mjs', 'e2e_build.mjs', 'e2e_rebuild.mjs', 'e2e_place.mjs', 'e2e_maps.mjs', 'e2e_bigmap.mjs', 'e2e_fixes.mjs', 'e2e_quit.mjs', 'e2e_support.mjs', 'e2e_reports.mjs',
  // (the maps' look: light probes, fog and shadows, terrain, water, materials, grass and trees, lights and decals)
  'e2e_look_ibl.mjs', 'e2e_look_atmos.mjs', 'e2e_look_terrain.mjs', 'e2e_look_water.mjs', 'e2e_look_mats.mjs', 'e2e_look_veg.mjs', 'e2e_look_scene.mjs',
  // (maps' shaders built ahead in the garage)
  'e2e_warmup.mjs'];
let failed = 0, total = 0;
for (const s of suites) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', s)], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const passed = (out.match(/^ok {2}/gm) || []).length;
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  total += passed;
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${s}: ${passed} checks passed${fails.length ? `, ${fails.length} failed` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
  for (const f of fails) console.log('       ' + f);
  if (r.status !== 0) failed++;
}
console.log(failed ? `${failed} suite(s) failed` : `all ${suites.length} suites passed (${total} checks)`);
process.exit(failed ? 1 : 0);
