// End-to-end test of the reports' hard cases (src/app/report.cpp, ui/support.js): every kind of
// crash the host catches leaves a minidump and a summary (an access violation, a stack overflow, an
// uncaught C++ exception, abort, an invalid parameter to the C runtime, a pure virtual call); the
// page's own process crashing (reloaded, offered); the GPU process crashing (the page notes the lost
// context, the host logs it); a lost WebGL context, a rejected promise, a shader error noted; the
// user's folder, user name and computer name taken out of the log and of reports in every spelling;
// the log rotating; sending when the server is down, fails, asks to wait, and the daily limit; ten
// crashes kept at most; several crashes offered at once; crashes sent by themselves at the next
// start when automatic reports are on; two threads crashing at once (one record, a whole dump);
// abort, terminate, an invalid parameter and a pure call named by their callers' frames; an end no
// handler sees (fail-fast) noted at the next start; half and lone dumps cleaned up; a crash's dump
// sent with the names overwritten; an account named "user"; reports sent side by side within the
// day's limit.
//   node tools/e2e_reports.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launch, sleep, removeDir, ROOT } from './cdp.mjs';

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
const records = () => (fs.existsSync(crashDir) ? fs.readdirSync(crashDir).filter((f) => f.endsWith('.json') && f !== 'sending.json' && f !== 'running.json').map((f) => JSON.parse(fs.readFileSync(path.join(crashDir, f), 'utf8'))) : []);
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
    ['two', 'EXCEPTION_ACCESS_VIOLATION', '0xC0000005'], // (two threads at once: the second waits for the first's dump)
    ['stack', 'EXCEPTION_STACK_OVERFLOW', '0xC00000FD'],
    // (an exception nobody caught on a thread of its own: std::terminate, named by where it was thrown)
    ['cpp', 'std::terminate (a C++ exception nobody caught, or one through a noexcept function)', '0xE0000001'],
    ['abort', 'abort()', '0xE0000004'],
    ['invalid', 'an invalid parameter to a C runtime function', '0xE0000002'],
    ['purecall', 'a pure virtual function call', '0xE0000003'],
  ];
  // (the link map names a frame: build\Grimcold.map, from build.cmd)
  const map = (() => {
    try {
      const t = fs.readFileSync(path.join(ROOT, 'build', 'Grimcold.map'), 'latin1');
      const load = BigInt('0x' + (/Preferred load address is ([0-9a-f]+)/i.exec(t)?.[1] || '140000000'));
      const list = [...t.matchAll(/^\s*[0-9a-f]{4}:[0-9a-f]{8}\s+(\S+)\s+([0-9a-f]{16})\s/gim)].map((m) => [BigInt('0x' + m[2]), m[1]]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return list.length ? { load, list } : null;
    } catch { return null; }
  })();
  const symbolAt = (offset) => {
    if (!map) return '';
    const at = map.load + BigInt(offset);
    let best = '';
    for (const [v, name] of map.list) { if (v <= at) best = name; else break; }
    return best;
  };
  const CALLER = { abort: /testCrashNow/, purecall: /testCrashNow/, invalid: /cpy_s/, cpp: /testCrashNow/ }; // (an invalid parameter: the CRT function given it, strcpy_s)
  const where = {};
  for (const [kind, what, code] of KINDS) {
    await start();
    const before = new Set(records().map((r) => r.id));
    if (kind === 'native') await app.js(`window.__xo.call('testReport', { watchExit: true })`); // (a crash on record: no "stopped unexpectedly" too)
    await app.js(`window.__xo.call('testReport', { crash: ${JSON.stringify(kind)} })`).catch(() => {});
    const gone = await ended(app);
    await app.close({ keep: true });
    const fresh = records().filter((r) => !before.has(r.id)), rec = fresh[0];
    const dmp = rec ? path.join(crashDir, rec.id + '.dmp') : '';
    const head = dmp && fs.existsSync(dmp) ? fs.readFileSync(dmp).subarray(0, 4).toString() : '';
    const raised = code.startsWith('0xE000000'); // (abort, terminate, invalid parameter, pure call: named by their callers, not RaiseException)
    const named = rec && rec.module === 'Grimcold.exe' ? symbolAt(rec.offset) : '';
    if (rec) where[kind] = `${rec.module}+${rec.offset}`;
    ok(gone && fresh.length === 1 && !fs.existsSync(path.join(crashDir, 'running.json')) && rec.what === what && rec.code === code && rec.dumped === true && head === 'MDMP' && /\.(exe|dll)$/i.test(rec.module) && typeof rec.ms === 'number' &&
      rec.stack?.length > 1 && rec.stack[0] === `${rec.module}+${rec.offset}` && (!raised || !/kernelbase/i.test(rec.module)) && (!CALLER[kind] || CALLER[kind].test(named)),
      `${kind}: the host ended and left its minidump and summary (${rec ? `${rec.what}, ${rec.code}, in ${rec.module}+${rec.offset}${named ? ` (${named.slice(0, 40)})` : ''}${rec.stack?.length ? `, ${rec.stack.length} frames` : ''}, ${(fs.statSync(dmp).size / 1024).toFixed(0)} KB` : 'nothing'}${fresh.length > 1 ? `, ${fresh.length} records` : ''})`);
  }
  ok(!!map, `the link map names the frames (${map ? map.list.length + ' symbols' : 'build\\Grimcold.map missing'})`);
  const raisedWheres = ['cpp', 'abort', 'invalid', 'purecall'].map((k) => where[k]);
  ok(new Set(raisedWheres).size === raisedWheres.length, `abort, an uncaught exception, an invalid parameter and a pure call each named by their own caller (${raisedWheres.join(', ')})`);
  await start();
  let { js, waitFor } = app;
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const multi = await js(`document.getElementById('crashWhat').textContent`);
  ok(new RegExp(`^${KINDS.length} crashes since the last start; the last one: the app crashed: a pure virtual function call`).test(multi) && !records().some((r) => r.kind === 'exit'), `the next start offers them all, and no "stopped unexpectedly" besides: "${multi.slice(0, 90)}…"`);
  await js(`document.getElementById('crashDrop').click()`);
  await sleep(500);
  ok(records().length === 0 && fs.readdirSync(crashDir).filter((f) => f.endsWith('.dmp')).length === 0, 'Don\'t send forgets them all, minidumps too');

  // ---- a fault inside the crash catcher itself: the app still ends (it never hangs) ----
  await js(`window.__xo.call('testReport', { crash: 'inside' })`).catch(() => {});
  const goneIn = await ended(app, 20000);
  await app.close({ keep: true });
  ok(goneIn, 'a fault inside the crash catcher: the app ends at once instead of hanging');
  for (const r of records()) { fs.rmSync(path.join(crashDir, r.id + '.json'), { force: true }); fs.rmSync(path.join(crashDir, r.id + '.dmp'), { force: true }); }
  await start();
  ({ js, waitFor } = app);

  // ---- an end no handler sees (fail-fast, as heap corruption and broken stack cookies end) ----
  const running = path.join(crashDir, 'running.json');
  await js(`window.__xo.call('testReport', { watchExit: true })`); // (tests leave it off: they end the app by killing it)
  await js(`window.__xo.call('testReport', { crash: 'fastfail' })`).catch(() => {});
  const goneFF = await ended(app);
  await app.close({ keep: true });
  ok(goneFF && records().length === 0 && fs.existsSync(running), 'a fail-fast end: no crash record, the run\'s running.json left behind');
  await start();
  ({ js, waitFor } = app);
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const ff = { title: await js(`document.getElementById('crashTitle').textContent`), rec: records().find((r) => r.kind === 'exit') };
  ok(ff.rec && !fs.existsSync(running) && /stopped unexpectedly/.test(ff.title), `the next start offers it: "${ff.title}" (${ff.rec ? ff.rec.what : 'no record'})`);
  await js(`document.getElementById('crashDrop').click()`);
  await sleep(300);

  // ---- a quit, logging off, Restart Manager: none is "stopped unexpectedly" ----
  await js(`window.__xo.call('testReport', { watchExit: true })`);
  const markedQ = fs.existsSync(running);
  await js(`window.__xo.call('quit', {})`).catch(() => {});
  const goneQ = await ended(app, 20000);
  await app.close({ keep: true });
  ok(markedQ && goneQ && !fs.existsSync(running), 'a normal quit removes the run\'s running.json');
  await start();
  ({ js, waitFor } = app);
  await js(`window.__xo.call('testReport', { watchExit: true })`);
  await js(`window.__xo.call('testReport', { endSession: 'logoff' })`);
  await sleep(1000);
  ok(!fs.existsSync(running) && app.proc.exitCode === null, 'logging off: the running.json goes at once (Windows ends the process itself)');
  await app.close({ keep: true });
  await start();
  ({ js, waitFor } = app);
  await js(`window.__xo.call('testReport', { watchExit: true })`);
  await js(`window.__xo.call('testReport', { endSession: 'closeapp' })`);
  const goneRM = await ended(app, 20000);
  await app.close({ keep: true });
  ok(goneRM && !fs.existsSync(running), 'Restart Manager closing the app: it closes as by the user, its running.json gone');
  await start();
  ({ js, waitFor } = app);
  await sleep(1500);
  ok(!records().some((r) => r.kind === 'exit') && (await js(`document.getElementById('crashDialog').hidden`)), 'and none of them is offered as a crash at the next start');

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

  // ---- a crash's report: its minidump goes, the names overwritten (as text and as UTF-16) ----
  await js(`window.__xo.call('testReport', { crash: 'native' })`).catch(() => {});
  await ended(app);
  await app.close({ keep: true });
  await start();
  ({ js, waitFor } = app);
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  await js(`document.getElementById('crashDialog').hidden = true`);
  const crashed = records().find((r) => r.kind === 'crash');
  const raw = crashed ? fs.readFileSync(path.join(crashDir, crashed.id + '.dmp')).toString('latin1') : '';
  const rd = await js(`window.__xo.call('report', { event: { message: { formatted: 'reports test dump' } }, crash: ${JSON.stringify(crashed?.id || '')}, log: false })`);
  const envBuf = got[got.length - 1]?.body || Buffer.alloc(0), latin = envBuf.toString('latin1');
  const wide16 = (s) => new RegExp(s.split('').map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\x00').join(''), 'i');
  const inWide = [user, pc].filter((s) => s && s.length >= 3).some((s) => wide16(s).test(latin));
  const rawHad = personal(raw) || [user, pc].filter((s) => s && s.length >= 3).some((s) => wide16(s).test(raw));
  ok(rd.ok && /MDMP/.test(latin) && !personal(latin) && !inWide, `a crash's report carries its minidump (${(envBuf.length / 1024).toFixed(0)} KB) with no user or computer name (the dump itself ${rawHad ? 'had some: overwritten' : 'had none; the scrub is checked on known bytes below'})`);

  // ---- an account named "user": the event's keys stay, placeholders are not replaced again ----
  const realUser = process.env.USERNAME;
  await app.close({ keep: true });
  process.env.USERNAME = 'user';
  try { await start(); } finally { process.env.USERNAME = realUser; }
  ({ js, waitFor } = app);
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  await js(`window.__xo.call('log', { lines: ['reports test: the user clicked Export in C:\\\\Users\\\\user\\\\Desktop'] })`);
  const ru = await js(`window.__xo.call('report', { event: { user: { id: 'abc123def456ghi7' }, message: { formatted: 'the user clicked' } }, crash: '', log: true })`);
  const bu = got[got.length - 1]?.body.toString('latin1') || '';
  ok(ru.ok && /"user":\{"id":"abc123def456ghi7"/.test(bu) && /the <user> clicked/.test(bu) && !/<<user>>/.test(bu), 'an account named "user": the install ID\'s key stays, the word is taken out once');
  const scrubIn = 'USER32.dll user32.pdb userenv.dll C:\\Users\\user\\x the user; Users', scrubWant = 'USER32.dll user32.pdb userenv.dll C:\\Users\\____\\x the ____; Users';
  const sc = await js(`window.__xo.call('testReport', { scrub: ${JSON.stringify(scrubIn)} })`);
  ok(sc.text === scrubWant && sc.wide === scrubWant, `a minidump's scrub overwrites the name only as a word, as text and as UTF-16 ("${sc.text}")`);
  // (an account named like one of the details' own words: only the page's free text loses it)
  await app.close({ keep: true });
  const realPc = process.env.COMPUTERNAME;
  process.env.USERNAME = 'texture';
  process.env.COMPUTERNAME = 'texture-pc'; // (a name holding another: the longer goes whole)
  try { await start(); } finally { process.env.USERNAME = realUser; process.env.COMPUTERNAME = realPc; }
  ({ js, waitFor } = app);
  const folder = path.basename(profile), withFolder = folder.length >= 3 && !/^texture/i.test(folder);
  const scrub2 = await js(`window.__xo.call('testReport', { scrub: ${JSON.stringify(`texture-pc texture pretexturex${withFolder ? ` ${folder}\\x pre${folder}x` : ''}`)} })`);
  const want2 = `__________ _______ pretexturex${withFolder ? ` ${'_'.repeat(folder.length)}\\x pre${folder}x` : ''}`;
  ok(scrub2.text === want2 && scrub2.wide === want2, `the scrub takes the computer's name whole (it holds the user's) and the profile folder's name ("${scrub2.text}")`);
  await js(`setTimeout(() => { throw new Error('reports test: C:\\\\Users\\\\texture\\\\a.glb has no texture'); }, 0)`);
  await waitFor(`window.__xo.support.problems().some((p) => /reports test: C:/.test(p.message))`, 10000);
  await js(`document.getElementById('bugReportBtn').click(); document.getElementById('repView').click()`);
  await waitFor(`/reports test/.test(document.getElementById('repDetails').textContent)`, 20000);
  const tx = await js(`document.getElementById('repDetails').textContent`);
  ok(/max texture \d/.test(tx) && /Users\\<user>\\a\.glb has no <user>/.test(tx), `an account named "texture": the details keep "max texture", the error loses the name ("${(/reports test: [^\n(]*/.exec(tx) || [''])[0]}")`);
  await js(`document.getElementById('reportDialog').hidden = true`);
  await app.close({ keep: true });
  await start(); // (the real user name again for the rest)
  ({ js, waitFor } = app);
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);

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

  // ---- reports side by side stay within the day's limit ----
  fs.writeFileSync(path.join(crashDir, 'sending.json'), JSON.stringify({ day: '20000101', count: 0, waitUntil: 0 }));
  const n8 = got.length;
  const side = await js(`Promise.all(Array.from({ length: 26 }, () => window.__xo.call('report', { event: {}, crash: '', log: false })))`);
  const sideOk = side.filter((r) => r.ok).length, st8 = JSON.parse(fs.readFileSync(path.join(crashDir, 'sending.json'), 'utf8'));
  ok(sideOk === 20 && got.length - n8 === 20 && st8.count === 20, `26 reports at once (the reports' own thread takes them in turn): ${sideOk} sent, ${got.length - n8} reached the server, the count ${st8.count}`);
  fs.writeFileSync(path.join(crashDir, 'sending.json'), JSON.stringify({ day: '20000101', count: 0, waitUntil: 0 })); // (today's 20 used up: free for what follows)

  // ---- half and lone dumps ----
  const lone = path.join(crashDir, 'crash-20000101-000000-1.dmp'), half = path.join(crashDir, 'crash-20000101-000001-2');
  fs.writeFileSync(lone, 'MDMP lone');
  fs.utimesSync(lone, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
  fs.writeFileSync(half + '.json', JSON.stringify({ id: 'crash-20000101-000001-2', kind: 'crash', time: '2000-01-01 00:00:01', code: '0xC0000005', what: 'EXCEPTION_ACCESS_VIOLATION', module: 'Grimcold.exe', offset: '0x1', version: '1', dumped: false }));
  fs.writeFileSync(half + '.dmp', 'MDMP half');
  const halfRec = await js(`window.__xo.call('diagnostics', {}).then((d) => d.crashes.find((c) => c.id === 'crash-20000101-000001-2'))`);
  ok(!fs.existsSync(lone) && !fs.existsSync(half + '.dmp') && halfRec && halfRec.dump === 0, 'a dump with no summary and half a dump (its summary says not dumped) are cleaned up; the crash itself is still offered');
  fs.unlinkSync(half + '.json');

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
