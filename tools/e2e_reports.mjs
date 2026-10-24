// End-to-end test of the reports' hard cases (src/app/report.cpp, ui/support.js): every kind of
// crash the host catches leaves a minidump and a summary (an access violation, a stack overflow, an
// uncaught C++ exception, abort, an invalid parameter to the C runtime, a pure virtual call); the
// page's own process crashing (reloaded, offered); the GPU process crashing (the page notes the lost
// context, the host logs it); a lost WebGL context, a rejected promise, a shader error noted; the
// user's folder, user name and computer name taken out of the log and of reports in every spelling;
// the log rotating; sending when the server is down, fails, asks to wait, and the daily limit; ten
// crashes kept at most; several crashes offered at once; crashes sent by themselves at the next
// start when automatic reports are on.
//   node tools/e2e_reports.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// ---- a stand-in for Sentry: answers 200, 500 or 429 (Retry-After) ----
const got = [];
let mode = 200;
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    got.push({ url: req.url, body: Buffer.concat(parts) });
    if (mode === 429) { res.writeHead(429, { 'retry-after': '2' }); res.end(); return; }
    res.writeHead(mode, { 'content-type': 'application/json' });
    res.end(mode === 200 ? '{"id":"x"}' : '{"detail":"broken"}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const DSN = `http://e2ekey@127.0.0.1:${server.address().port}/7`;
const DEAD = (() => { const s = http.createServer(); return new Promise((r) => s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(`http://e2ekey@127.0.0.1:${p}/7`)); })); })();

const user = os.userInfo().username, pc = process.env.COMPUTERNAME || '', profile = os.homedir();
const personal = (text) => [user, pc].filter((s) => s && s.length >= 3).some((s) => new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-e2e-reports-'));
const crashDir = path.join(dataDir, 'crashes'), logDir = path.join(dataDir, 'logs');
const records = () => (fs.existsSync(crashDir) ? fs.readdirSync(crashDir).filter((f) => f.endsWith('.json') && f !== 'sending.json').map((f) => JSON.parse(fs.readFileSync(path.join(crashDir, f), 'utf8'))) : []);
let app = null;
const start = async () => {
  app = await launch({ dataDir });
  await app.waitFor('window.__xoReady === true && !!window.__xo.support', 120000);
  return app;
};
const ended = (a, ms = 60000) => Promise.race([new Promise((r) => (a.proc.exitCode !== null ? r(true) : a.proc.once('exit', () => r(true)))), sleep(ms).then(() => false)]);

try {
  // ---- every kind of crash the host catches ----
  const KINDS = [
    ['native', 'EXCEPTION_ACCESS_VIOLATION', '0xC0000005'],
    ['stack', 'EXCEPTION_STACK_OVERFLOW', '0xC00000FD'],
    // (an exception nobody caught on a thread of its own: MSVC's std::terminate there calls abort)
    ['cpp', 'abort() (also where a C++ exception nobody caught ends on another thread)', '0xE0000004'],
    ['abort', 'abort() (also where a C++ exception nobody caught ends on another thread)', '0xE0000004'],
    ['invalid', 'an invalid parameter to a C runtime function', '0xE0000002'],
    ['purecall', 'a pure virtual function call', '0xE0000003'],
  ];
  for (const [kind, what, code] of KINDS) {
    await start();
    const before = new Set(records().map((r) => r.id));
    await app.js(`window.__xo.call('testReport', { crash: ${JSON.stringify(kind)} })`).catch(() => {});
    const gone = await ended(app);
    await app.close({ keep: true });
    const rec = records().find((r) => !before.has(r.id));
    const dmp = rec ? path.join(crashDir, rec.id + '.dmp') : '';
    const head = dmp && fs.existsSync(dmp) ? fs.readFileSync(dmp).subarray(0, 4).toString() : '';
    ok(gone && rec && rec.what === what && rec.code === code && rec.dumped === true && head === 'MDMP' && /\.(exe|dll)$/i.test(rec.module),
      `${kind}: the host ended and left its minidump and summary (${rec ? `${rec.what}, ${rec.code}, in ${rec.module}+${rec.offset}, ${(fs.statSync(dmp).size / 1024).toFixed(0)} KB` : 'nothing'})`);
  }
  await start();
  let { js, waitFor } = app;
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const multi = await js(`document.getElementById('crashWhat').textContent`);
  ok(new RegExp(`^${KINDS.length} crashes since the last start; the last one: the app crashed: a pure virtual function call`).test(multi), `the next start offers them all: "${multi.slice(0, 90)}…"`);
  await js(`document.getElementById('crashDrop').click()`);
  await sleep(500);
  ok(records().length === 0 && fs.readdirSync(crashDir).filter((f) => f.endsWith('.dmp')).length === 0, 'Don\'t send forgets them all, minidumps too');

  // ---- the page's own errors ----
  await js(`setTimeout(() => { Promise.reject(new Error('reports test rejection')); }, 0)`); // (not awaited here: unhandled in the page)
  await js(`console.error('THREE.WebGLProgram: Shader Error 1282 - VALIDATE_STATUS false (reports test)')`);
  await js(`window.__xo.viewer.renderer.getContext().getExtension('WEBGL_lose_context').loseContext()`);
  await sleep(1500);
  const kinds = await js(`window.__xo.support.problems().map((p) => p.kind + ':' + p.type)`);
  ok(kinds.includes('rejection:Error') && kinds.includes('shader:ShaderError') && kinds.includes('webgl:WebGLContextLost'), `a rejected promise, a shader error and a lost WebGL context are noted (${kinds.join(', ')})`);
  await js(`window.__xo.viewer.renderer.getContext().getExtension('WEBGL_lose_context').restoreContext()`).catch(() => {});
  await app.close({ keep: true });

  // ---- the GPU process crashing ----
  await start();
  ({ js, waitFor } = app);
  const port = app.proc.spawnargs[app.proc.spawnargs.indexOf('--debug-port') + 1];
  const bws = new WebSocket((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  await new Promise((r) => (bws.onopen = r));
  bws.send(JSON.stringify({ id: 1, method: 'Browser.crashGpuProcess' }));
  await sleep(5000);
  bws.close();
  let gpu = false; // (the view reloads itself once the context comes back, viewer.js: the problem outlives it)
  for (let i = 0; i < 60 && !gpu; i++) { gpu = await Promise.race([js(`window.__xoReady === true && !!window.__xo.support && window.__xo.support.problems().some((p) => p.type === 'WebGLContextLost')`).catch(() => false), sleep(3000).then(() => false)]); if (!gpu) await sleep(500); }
  const tail1 = await js(`window.__xo.call('diagnostics', { lines: 60 }).then((d) => d.log.join('\\n'))`).catch(() => '');
  ok(gpu && /WebView2's gpu process ended/.test(tail1), 'the GPU process crashing: the page notes its lost context, the host logs it, the app goes on');
  ok(records().length === 0, 'and keeps no crash for it (WebView2 starts another)');

  // ---- the page's process crashing: reloaded, offered ----
  await Promise.race([app.send('Page.crash').catch(() => {}), sleep(3000)]);
  let reloaded = false;
  for (let i = 0; i < 120 && !reloaded; i++) {
    await sleep(500);
    reloaded = await Promise.race([js(`window.__xoReady === true && !!window.__xo.support && !document.getElementById('crashDialog').hidden`).catch(() => false), sleep(3000).then(() => false)]); // (a call into a crashed page may never answer)
  }
  const page = records().find((r) => r.kind === 'page');
  ok(page && /the page's process ended/.test(page.what), `the page's process crashing is kept (${page ? `${page.what}, ${page.reason}, exit code ${page.code}` : 'nothing'})`);
  ok(reloaded && /^The view crashed and was reloaded/.test(await js(`document.getElementById('crashTitle').textContent`)), 'the page is loaded again and offers it');
  await js(`document.getElementById('crashDrop').click()`);
  await sleep(300);

  // ---- names taken out: the log ----
  const forms = [
    `${profile}\\Desktop\\my build.xobuild`, profile.replace(/\\/g, '/') + '/Downloads/x.glb', JSON.stringify(`${profile}\\AppData\\x`).slice(1, -1),
    `C:\\Users\\SomeoneElse\\Documents\\y.png`, `opened by ${user} on ${pc}`,
  ];
  await js(`window.__xo.call('log', { lines: ${JSON.stringify(forms.map((f) => 'reports test: ' + f))} })`);
  const logText = fs.readdirSync(logDir).map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n');
  const testLines = logText.split('\n').filter((l) => l.includes('reports test:')).join('\n');
  ok(!personal(logText) && !/SomeoneElse/.test(testLines), 'the log keeps no user folder, user name or computer name, in any spelling');
  ok(/C:\\Users\\<user>\\Desktop/.test(testLines) && /C:\/Users\/<user>\/Downloads/.test(testLines) && /C:\\\\Users\\\\<user>\\\\AppData/.test(testLines) && /opened by <user> on <pc>/.test(testLines), 'they read <user> and <pc> instead');

  // ---- the log rotating ----
  const big = 'x'.repeat(3900);
  for (let k = 0; k < 4; k++) await js(`window.__xo.call('log', { lines: Array.from({ length: 80 }, (_, i) => 'reports test rotation ${k} ' + i + ' ${big}') })`);
  const files = fs.readdirSync(logDir).sort();
  const tail2 = await js(`window.__xo.call('diagnostics', { lines: 300 }).then((d) => d.log)`);
  ok(files.includes('grimcold.1.log') && fs.statSync(path.join(logDir, 'grimcold.log')).size < 1.1 * 1024 * 1024, `the log goes on in a new file past 1 MB (${files.join(', ')})`);
  ok(tail2.length === 300 && /rotation 3 79/.test(tail2[tail2.length - 1]), 'its last lines still read across both files');

  // ---- sending: names taken out of what goes ----
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  await js(`window.__xo.support.setReports(true)`);
  mode = 200;
  const r1 = await js(`window.__xo.call('report', { event: { message: { formatted: 'reports test' }, extra: { paths: ${JSON.stringify(forms)} } }, crash: '', log: true })`);
  const body1 = got[got.length - 1]?.body.toString('latin1') || '';
  ok(r1.ok && !personal(body1) && /<user>/.test(body1), 'a report keeps no user folder, user name or computer name either');

  // ---- sending: the server down, failing, asking to wait ----
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(await DEAD)} })`);
  const r2 = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
  ok(!r2.ok && /could not reach/.test(r2.error), `the server down: not sent, said why ("${r2.error}")`);
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  mode = 500;
  const r3 = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
  ok(!r3.ok && /answered 500/.test(r3.error), `the server failing: not sent ("${r3.error}")`);
  mode = 429;
  const r4 = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
  mode = 200;
  const n4 = got.length;
  const r5 = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
  ok(!r4.ok && /busy/.test(r4.error) && !r5.ok && /asked to wait/.test(r5.error) && got.length === n4, 'the server asking to wait (429): nothing more is sent meanwhile');
  await sleep(2300);
  const r6 = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
  ok(r6.ok, 'and after its Retry-After, reports go again');

  // ---- the daily limit ----
  let sent = 0, refused = null;
  for (let i = 0; i < 25 && !refused; i++) {
    const r = await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`);
    if (r.ok) sent++; else refused = r.error;
  }
  const state = JSON.parse(fs.readFileSync(path.join(crashDir, 'sending.json'), 'utf8'));
  ok(refused && /enough reports for today/.test(refused) && state.count === 20, `at most 20 reports a day (${state.count} today, then "${refused}")`);
  // (a new day: the count starts again)
  fs.writeFileSync(path.join(crashDir, 'sending.json'), JSON.stringify({ day: '20000101', count: 20, waitUntil: 0 }));
  ok((await js(`window.__xo.call('report', { event: {}, crash: '', log: false })`)).ok, 'the next day, reports go again');

  // ---- ten crashes kept at most; several offered; sent by themselves at the next start ----
  for (let i = 0; i < 12; i++) { await js(`window.__xo.call('testReport', { crash: 'record' })`); await sleep(1100); }
  const kept = await js(`window.__xo.call('diagnostics', {}).then((d) => d.crashes.length)`);
  ok(kept === 10 && records().length === 10, `ten crashes kept at most (${kept})`);
  for (const r of records()) fs.unlinkSync(path.join(crashDir, r.id + '.json'));
  await js(`window.__xo.call('testReport', { crash: 'record' })`);
  await js(`window.__xo.call('setSettings', { reportAuto: true })`);
  const n7 = got.length;
  await js('location.reload()').catch(() => {});
  await sleep(1500);
  await waitFor('window.__xoReady === true && !!window.__xo.support', 120000);
  for (let i = 0; i < 40 && got.length === n7; i++) await sleep(250);
  const auto = got.slice(n7).map((g) => g.body.toString('latin1'));
  ok(auto.length === 1 && /EXCEPTION_ACCESS_VIOLATION/.test(auto[0]) && (await js(`document.getElementById('crashDialog').hidden`)) && records().length === 0,
    'with automatic reports on, the next start sends a crash by itself (no dialog) and forgets it');

  const left = app.errors.filter((e) => !/reports test|WebGL|CONTEXT_LOST|context/i.test(e));
  ok(left.length === 0, `no other page errors (${left.slice(0, 2).join(' | ')})`);
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  if (app) await app.close();
  await removeDir(dataDir);
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
