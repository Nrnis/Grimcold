// End-to-end test of Donations and Bug report (ui/support.js, src/app/report.cpp): the pages, the
// links (only well-formed ones, opened outside the app), the details (no user name, no computer name
// in them), copying them, GitHub's form filled in, the page's errors noted and logged, reports sent
// to a local stand-in for Sentry (the envelope as Sentry reads it: event, log, minidump; nothing
// personal in it), automatic reports, the crash dialog after a crash record and after a real crash
// of the host (its minidump written and sent), Don't send; the page's own text with the user's folder
// and names taken out before it is shown, copied or put in the link; the app's keys waiting behind the
// dialog; details too long for the link with the clipboard refusing; a list row's text kept out of the
// steps; in a build that sends nothing, the crash dialog's words, its close button, a crash reported
// on GitHub not asked about again, crashes kept at the top of the list.
//   node tools/e2e_support.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launch, sleep, removeDir } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// ---- a local stand-in for Sentry's envelope endpoint ----
const got = [];
const server = http.createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"x"}');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const DSN = `http://e2ekey@127.0.0.1:${server.address().port}/42`;

// An envelope's items: [{ header, payload (Buffer) }] after its own header.
function envelope(buf) {
  let i = buf.indexOf(10);
  const head = JSON.parse(buf.subarray(0, i).toString());
  const items = [];
  i++;
  while (i < buf.length) {
    const e = buf.indexOf(10, i);
    if (e < 0) break;
    const h = JSON.parse(buf.subarray(i, e).toString());
    const payload = buf.subarray(e + 1, e + 1 + h.length);
    items.push({ header: h, payload });
    i = e + 1 + h.length + 1;
  }
  return { head, items };
}
const waitGot = async (n, ms = 20000) => { const t0 = Date.now(); while (got.length < n && Date.now() - t0 < ms) await sleep(100); return got.length >= n; };

const user = os.userInfo().username, pc = process.env.COMPUTERNAME || '', profile = os.homedir();
const personal = (text) => [user, pc].filter((s) => s && s.length >= 3).some((s) => new RegExp(`(^|[^A-Za-z0-9_])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-e2e-support-'));
let app = await launch({ dataDir });

try {
  let { js, waitFor } = app;
  await waitFor('window.__xoReady === true && !!window.__xo.support', 120000);
  ok(await js(`document.getElementById('crashDialog').hidden`), 'a first start offers no crash');

  // ---- Donations ----
  await js(`document.getElementById('donationsBtn').click()`);
  const d0 = await js(`(() => ({ open: !document.getElementById('donateDialog').hidden, none: !document.getElementById('donateNone').hidden, links: document.querySelectorAll('#donateLinks button').length, view: window.__xo.state.view }))()`);
  ok(d0.open && d0.none && d0.links === 0 && d0.view === 'part', 'Donations opens (no links set up yet: it says so) and leaves the view as it was');
  await app.key('Escape');
  ok(await js(`document.getElementById('donateDialog').hidden`), 'Escape closes it');
  await js(`window.__xo.support.links({ repo: 'https://github.com/e2e/xo', donate: { github: 'tester', ko_fi: 'tester', liberapay: 'not a name!', custom: [{ name: 'Site', url: 'https://example.org/give' }, { name: 'Bad', url: 'javascript:alert(1)' }] } })`);
  await js(`document.getElementById('donationsBtn').click()`);
  const d1 = await js(`(() => ({ names: [...document.querySelectorAll('#donateLinks button')].map((b) => b.textContent), official: document.getElementById('donateOfficialLink').textContent, shown: !document.getElementById('donateOfficial').hidden }))()`);
  ok(d1.names.join('|') === 'GitHub Sponsors|Ko-fi|Site', `the well-formed links only (${d1.names.join(', ')})`);
  ok(d1.shown && d1.official === 'github.com/e2e/xo/releases', `the official download named (${d1.official})`);
  await js(`[...document.querySelectorAll('#donateLinks button')].find((b) => b.textContent === 'Ko-fi').click()`);
  ok((await js('window.__xoOpened')) === 'https://ko-fi.com/tester', 'a platform\'s page opens outside the app');
  // the legal notice (NOTICE.md: the GPL's Appropriate Legal Notices with the author's credit)
  const legal = await js(`(() => { const p = document.getElementById('legalNote'); return { shown: !!p && p.offsetParent !== null, text: (p?.textContent || '').replace(/\\s+/g, ' ').trim() }; })()`);
  ok(legal.shown && /Grimcold by Nrnis/.test(legal.text) && /GNU GPL v3/.test(legal.text) && /no warranty/.test(legal.text), `the page shows the legal notice (${legal.text})`);
  await js(`document.getElementById('legalSource').click()`);
  ok((await js('window.__xoOpened')) === 'https://github.com/Nrnis/Grimcold', 'its source link opens the original repository, whatever the links say');
  await js(`document.querySelector('#donateDialog [data-close]').click()`);

  // ---- Bug report: the details ----
  await js(`document.getElementById('bugReportBtn').click()`);
  const r0 = await js(`(() => ({ open: !document.getElementById('reportDialog').hidden, send: !document.getElementById('repSendSec').hidden, noSend: !document.getElementById('repNoSend').hidden, gh: !document.getElementById('repGithub').disabled }))()`);
  const built = (await js(`window.__xo.call('diagnostics', {})`)).app.reports; // (a DSN in this build: %SENTRY_DSN% when it was built)
  ok(r0.open && r0.send === built && r0.noSend === !built && r0.gh, `Bug report opens; ${built ? 'this build has a DSN: Send report' : 'a build without a DSN offers no sending, says so'}, and offers GitHub`);
  await js(`document.getElementById('repView').click()`);
  await waitFor(`!document.getElementById('repDetails').hidden`, 20000);
  const details = await js(`document.getElementById('repDetails').textContent`);
  ok(/Grimcold \d+\.\d+\.\d+/.test(details) && /Windows/.test(details) && /GPU: /.test(details) && /WebGL: /.test(details) && /WebView2 \d/.test(details), 'the details: version, Windows, graphics card, WebGL, WebView2');
  ok(/```/.test(details) && /\[host\]/.test(details), 'the details end with the log\'s last lines');
  ok(!personal(details), `no user or computer name in them (${user}, ${pc})`);
  const diag = await js(`window.__xo.call('diagnostics', {})`);
  ok(/Users[\\/]<user>/.test(diag.dataDir) || !/Users/i.test(diag.dataDir), `the data folder as reported: ${diag.dataDir}`);
  await js(`document.getElementById('repCopy').click()`);
  await waitFor(`document.getElementById('repState').textContent !== ''`, 20000); // (a hidden test window has no focus: the clipboard may refuse it)
  ok((await js('window.__xoCopied')) === details, `Copy details copies exactly what was shown (${await js(`document.getElementById('repState').textContent`)})`);
  await js(`document.getElementById('repGithub').click()`);
  await waitFor(`/issues\\/new/.test(window.__xoOpened || '')`, 20000);
  const issue = new URL(await js('window.__xoOpened'));
  ok(issue.origin + issue.pathname === 'https://github.com/e2e/xo/issues/new' && issue.searchParams.get('template') === 'bug_report.yml' && /^\d+\.\d+\.\d+$/.test(issue.searchParams.get('version')) && /Windows/.test(issue.searchParams.get('diagnostics')) && issue.href.length < 8000,
    `GitHub's form filled in: version ${issue.searchParams.get('version')}, the details (${issue.href.length} characters)`);
  const form = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8');
  ok(/id: version/.test(form) && /id: diagnostics/.test(form), 'the form has the fields the app fills in');

  // ---- the page's own text, as it may leave the app: names taken out ----
  const named = `support test boom path ${profile}\\Documents\\x.glb by ${user} on ${pc}`;
  await js(`setTimeout(() => { throw new Error(${JSON.stringify(named)}); }, 0)`);
  await waitFor(`window.__xo.support.problems().some((p) => /support test boom path/.test(p.message))`, 10000);
  await js(`document.getElementById('repView').click()`);
  await waitFor(`/support test boom path/.test(document.getElementById('repDetails').textContent)`, 20000);
  const shown = await js(`document.getElementById('repDetails').textContent`);
  await js(`window.__xoOpened = ''; document.getElementById('repGithub').click()`);
  await waitFor(`/issues\\/new/.test(window.__xoOpened || '')`, 20000);
  const sent0 = new URL(await js('window.__xoOpened')).searchParams.get('diagnostics') || '';
  ok(!personal(shown) && !personal(sent0) && /Users\\<user>\\Documents/.test(shown) && /by <user> on <pc>/.test(sent0), 'an error naming the user\'s folder and names: shown, copied and put in the link without them');
  // the app's keys wait behind the open dialog (they changed the part the report described)
  const keys0 = await js(`({ path: window.__xo.state.info?.path || '', wire: document.getElementById('optWire').checked })`);
  await app.key('ArrowDown');
  await app.key('w');
  await sleep(300);
  const keys1 = await js(`({ path: window.__xo.state.info?.path || '', wire: document.getElementById('optWire').checked })`);
  ok(keys1.path === keys0.path && keys1.wire === keys0.wire, 'the app\'s keys wait while Bug report is open (no part change, no wireframe)');
  // a list row's text (it can be a name the user gave a part) stays out of the steps
  await js(`(() => { const d = document.createElement('div'); d.className = 'row-item'; d.textContent = 'secret name 4711'; document.body.appendChild(d); d.click(); d.remove(); })()`);
  ok(!/secret name 4711/.test(JSON.stringify(await js('window.__xo.support.crumbs()'))), 'a list row\'s text is not kept as a step');
  // details too long for the link, the clipboard refusing: said so, the details shown to copy by hand
  for (let i = 0; i < 14; i++) await js(`setTimeout(() => { throw new Error('support test boom long ${'\u00e9'.repeat(5)} ' + ${i} + ' ' + 'x'.repeat(240)); }, 0)`);
  await waitFor(`window.__xo.support.problems().filter((p) => /support test boom long/.test(p.message)).length === 14`, 10000);
  await js(`(() => { window.__clip = navigator.clipboard.writeText; navigator.clipboard.writeText = () => Promise.reject(new Error('no')); window.__exec = document.execCommand; document.execCommand = () => false; document.getElementById('repDetails').hidden = true; window.__xoOpened = ''; document.getElementById('repState').textContent = ''; document.getElementById('repGithub').click(); })()`);
  await waitFor(`/issues\\/new/.test(window.__xoOpened || '')`, 20000);
  const longUrl = await js('window.__xoOpened'), longState = await js(`document.getElementById('repState').textContent`);
  ok(longUrl.length <= 2000 && /Paste the details/.test(new URL(longUrl).searchParams.get('diagnostics')) && /could not be copied/.test(longState) && (await js(`!document.getElementById('repDetails').hidden`)),
    `details too long for the link, the clipboard refusing: the form asks to paste, the dialog says so and shows them (${longUrl.length} characters)`);
  await js(`(() => { navigator.clipboard.writeText = window.__clip; document.execCommand = window.__exec; const ps = window.__xo.support.problems(); ps.splice(0, ps.length); document.querySelector('#reportDialog [data-close]').click(); })()`); // (the next checks start without these)

  // ---- the page's errors ----
  await js(`setTimeout(() => { throw new Error('support test boom'); }, 0)`);
  await waitFor(`window.__xo.support.problems().some((p) => p.message === 'support test boom')`, 10000);
  ok(await js(`document.getElementById('bugReportBtn').classList.contains('alert')`), 'an error marks Bug report');
  await sleep(1500); // (the page's log lines go to the host in batches)
  const log = await js(`window.__xo.call('diagnostics', { lines: 50 }).then((d) => d.log.join('\\n'))`);
  ok(/\[page\] error: Error: support test boom/.test(log), 'and goes into the app\'s log');

  // ---- sending (a stand-in for Sentry) ----
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  await js(`window.__xo.support.setReports(true)`);
  await js(`document.querySelector('#reportDialog [data-close]').click(); document.getElementById('bugReportBtn').click()`);
  ok(await js(`!document.getElementById('repSendSec').hidden && document.getElementById('repNoSend').hidden`), 'with a DSN: Send report and the automatic switch');
  await js(`document.getElementById('repSend').click()`);
  ok(await waitGot(1), 'Send report reaches the report server');
  const p1 = got[0], e1 = envelope(p1.body);
  const ev = JSON.parse(e1.items.find((x) => x.header.type === 'event').payload.toString());
  ok(p1.method === 'POST' && p1.url === '/api/42/envelope/' && /sentry_key=e2ekey/.test(p1.headers['x-sentry-auth'] || '') && /x-sentry-envelope/.test(p1.headers['content-type']), 'as a Sentry envelope, to the project, with the key');
  ok(/^[0-9a-f]{32}$/.test(e1.head.event_id) && ev.event_id === e1.head.event_id && /^grimcold@\d/.test(ev.release), `event ${ev.event_id.slice(0, 8)}…, release ${ev.release}`);
  ok(ev.exception?.values?.[0]?.value === 'support test boom' && ev.exception.values[0].stacktrace?.frames?.length > 0, 'the error with its stack');
  ok(/^Windows/.test(ev.contexts?.os?.name || '') && ev.contexts?.gpu?.name && ev.contexts?.webgl?.renderer && ev.breadcrumbs?.values?.length > 0, `contexts: ${ev.contexts.os.name}, ${ev.contexts.gpu.name}; ${ev.breadcrumbs.values.length} steps`);
  ok(e1.items.some((x) => x.header.type === 'attachment' && x.header.filename === 'grimcold.log' && x.payload.length > 0), 'the log goes with it');
  ok(!personal(p1.body.toString('latin1')) && !ev.server_name && !ev.user?.email && /^[0-9a-f-]{16,}$/.test(ev.user?.id || ''), 'nothing personal in it: a random install id only');
  ok(await js(`window.__xo.support.problems().find((p) => p.message === 'support test boom').sent !== null`), 'the problem is marked sent');

  // automatic reports
  await js(`document.getElementById('repAuto').click()`);
  ok(await js(`window.__xo.state.settings.reportAuto === true`), 'the automatic switch is remembered');
  const before = got.length;
  await js(`setTimeout(() => { throw new TypeError('support test auto'); }, 0)`);
  ok(await waitGot(before + 1), 'with it on, a new error is sent by itself');
  ok(/support test auto/.test(got[got.length - 1].body.toString('latin1')), 'that error');
  await js(`document.getElementById('repAuto').click()`);

  // ---- the crash dialog: a crash record, Don't send ----
  await js(`window.__xo.call('testReport', { crash: 'record' })`);
  await js('location.reload()').catch(() => {}); // (the page goes: no answer)
  await sleep(1500);
  await waitFor('window.__xoReady === true && !!window.__xo.support', 120000);
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const c1 = await js(`(() => ({ title: document.getElementById('crashTitle').textContent, what: document.getElementById('crashWhat').textContent, send: !document.getElementById('crashSend').hidden }))()`);
  ok(/crashed/.test(c1.title) && /EXCEPTION_ACCESS_VIOLATION in Grimcold\.exe\+0x1234/.test(c1.what) && c1.send, `the next start offers it: "${c1.what}"`);
  await js(`document.getElementById('crashDrop').click()`);
  await sleep(500);
  ok(await js(`document.getElementById('crashDialog').hidden && window.__xo.call('diagnostics', {}).then((d) => d.crashes.length === 0)`), 'Don\'t send forgets it');

  // ---- a real crash of the host: its minidump, sent ----
  await js(`window.__xo.call('testReport', { crash: 'native' })`).catch(() => {});
  const exited = await Promise.race([new Promise((r) => (app.proc.exitCode !== null ? r(true) : app.proc.once('exit', () => r(true)))), sleep(60000).then(() => false)]);
  ok(exited, 'the host crashed (a test access violation) and ended');
  await app.close({ keep: true });
  const left = fs.readdirSync(path.join(dataDir, 'crashes')).filter((f) => f.endsWith('.dmp'));
  const dump = left.length ? fs.readFileSync(path.join(dataDir, 'crashes', left[0])) : Buffer.alloc(0);
  ok(dump.length > 10000 && dump.subarray(0, 4).toString() === 'MDMP', `a minidump was written (${(dump.length / 1024).toFixed(0)} KB)`);
  app = await launch({ dataDir });
  ({ js, waitFor } = app);
  await waitFor('window.__xoReady === true && !!window.__xo.support', 120000);
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const c2 = await js(`document.getElementById('crashWhat').textContent`);
  ok(/EXCEPTION_ACCESS_VIOLATION in Grimcold\.exe\+0x[0-9A-F]+/.test(c2), `after the restart it is offered: "${c2}"`);
  ok((await js(`document.getElementById('crashSend').hidden`)) === !built, built ? 'Send report offered' : 'this build has no DSN: no Send (copy or GitHub instead)');
  await js(`window.__xo.call('testReport', { dsn: ${JSON.stringify(DSN)} })`);
  await js(`window.__xo.support.setReports(true)`);
  await js(`document.getElementById('crashDialog').hidden = true`);
  const n0 = got.length;
  await js(`window.__xo.call('diagnostics', {}).then((d) => Promise.all(d.crashes.map((c) => window.__xo.support.sendReport({ crash: c }))))`);
  ok(await waitGot(n0 + 1), 'Send report sends the crash');
  const e2 = envelope(got[got.length - 1].body), ev2 = JSON.parse(e2.items.find((x) => x.header.type === 'event').payload.toString());
  const md = e2.items.find((x) => x.header.attachment_type === 'event.minidump');
  ok(ev2.level === 'fatal' && ev2.platform === 'native' && ev2.exception.values[0].type === 'EXCEPTION_ACCESS_VIOLATION', 'as a fatal native crash');
  ok(md && md.payload.length === dump.length && md.payload.subarray(0, 4).toString() === 'MDMP', `with its minidump (${md ? (md.payload.length / 1024).toFixed(0) : 0} KB)`);
  ok(await js(`window.__xo.call('diagnostics', {}).then((d) => d.crashes.length === 0)`), 'and is forgotten once sent');

  // ---- a build that sends nothing: the crash dialog ----
  await js(`window.__xo.call('testReport', { dsn: '' })`);
  await js(`window.__xo.call('testReport', { crash: 'record' })`);
  const reload = async () => { await js('location.reload()').catch(() => {}); await sleep(1500); await waitFor('window.__xoReady === true && !!window.__xo.support', 120000); };
  await reload();
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  const c3 = await js(`(() => ({ view: document.getElementById('crashView').textContent, drop: document.getElementById('crashDrop').textContent, send: !document.getElementById('crashSend').hidden, x: !!document.querySelector('#crashDialog .modal-x') }))()`);
  ok(c3.view === 'Show details' && c3.drop === 'Forget this crash' && !c3.send && c3.x, `nothing to send: the dialog says "${c3.view}" / "${c3.drop}", no Send, and has a close button`);
  await js(`document.querySelector('#crashDialog .modal-x').click()`);
  ok(await js(`document.getElementById('crashDialog').hidden && window.__xo.call('diagnostics', {}).then((d) => d.crashes.length === 1)`), 'closing it keeps the crash (for Bug report)');
  await reload();
  await waitFor(`!document.getElementById('crashDialog').hidden`, 20000);
  await js(`window.__xoOpened = ''; document.getElementById('crashGithub').click()`);
  await waitFor(`/issues\\/new/.test(window.__xoOpened || '')`, 20000);
  ok(/^Crash: /.test(new URL(await js('window.__xoOpened')).searchParams.get('title')), 'Open GitHub issue: the form titled after the crash');
  await sleep(500);
  await reload();
  await sleep(1500);
  ok(await js(`document.getElementById('crashDialog').hidden`), 'reported on GitHub, it is not asked about again at the next start');
  for (let i = 0; i < 16; i++) await js(`setTimeout(() => { throw new Error('support test boom many ' + ${i}); }, 0)`);
  await waitFor(`window.__xo.support.problems().filter((p) => /support test boom many/.test(p.message)).length === 16`, 10000);
  await js(`document.getElementById('bugReportBtn').click()`);
  const rows = await js(`[...document.querySelectorAll('#repProblemList li')].map((li) => li.textContent)`);
  ok(rows.length === 15 && /EXCEPTION_ACCESS_VIOLATION/.test(rows[0]) && /reported/.test(rows[0]), `with 16 problems the crash stays at the top of the list, marked reported (${rows.length} rows)`);
  await js(`window.__xo.call('diagnostics', {}).then((d) => Promise.all(d.crashes.map((c) => window.__xo.call('dropCrash', { id: c.id }))))`);

  const left2 = app.errors.filter((e) => !/support test (boom|auto)/.test(e));
  ok(left2.length === 0, `no other page errors (${left2.slice(0, 2).join(' | ')})`);

  // ---- no WebGL 2 on the PC: Bug report and Donations still open ----
  const { identifier } = await app.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const get = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (type, ...a) { return /webgl/i.test(type) ? null : get.call(this, type, ...a); }; })()`,
  });
  await js('location.reload()').catch(() => {});
  await sleep(1500);
  await waitFor('!!(window.__xo && window.__xo.support)', 60000);
  await js(`document.getElementById('bugReportBtn').click(); document.getElementById('repView').click()`);
  await waitFor(`/WebGL: not available/.test(document.getElementById('repDetails').textContent)`, 20000);
  const nogl = await js(`(() => { const r = !document.getElementById('reportDialog').hidden; document.getElementById('reportDialog').hidden = true; document.getElementById('donationsBtn').click(); return { report: r, donate: !document.getElementById('donateDialog').hidden, status: document.getElementById('status')?.textContent || '' }; })()`);
  ok(nogl.report && nogl.donate, `no WebGL 2: Bug report (its details say "WebGL: not available") and Donations still open (status: "${nogl.status.slice(0, 60)}")`);
  await app.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
  await removeDir(dataDir);
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
