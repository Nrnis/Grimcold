// Donations and bug reports: the top bar's Donations and Bug report pages, and the crash dialog
// after a crash. Following the publishing guides for a free fan tool:
//  - Donations: one quiet page, no pop-ups or reminders anywhere else; a donation is a voluntary gift
//    that unlocks nothing; the platforms' own pages take the money (GitHub Sponsors, Ko-fi,
//    Liberapay ...: support.json, the same keys as GitHub's FUNDING.yml), the app never sees payment
//    details; the official download is named, against fake copies.
//  - Bug reports, in layers. A person describes a bug on GitHub's issue form (an account keeps it
//    constructive; the app fills in the version and the details). An anonymous technical report
//    carries no text anyone typed (nothing abusive can be written into it) and goes to the report
//    server (Sentry) only from a build with a DSN and only when asked, or by itself once the user
//    agreed to automatic reports. The details are shown before they leave and copied on request. No
//    files, names or emails: the host takes the user's folder and names out of everything.
//  - Crashes: the host keeps a minidump and a summary (report.h); the next start offers them. The
//    page's own errors (uncaught exceptions, rejected promises, shader errors, a lost WebGL context)
//    are noted and logged, and sent like crashes while automatic reports are on (each kind once a
//    session, at most AUTO_PER_SESSION; the host allows 20 a day).
const MAX_CRUMBS = 40, MAX_PROBLEMS = 50, AUTO_PER_SESSION = 3, LOG_PER_SESSION = 400;

const PLATFORMS = { // (support.json donate keys: name, link; a user name of letters, digits, - _ .)
  github: ['GitHub Sponsors', (h) => `https://github.com/sponsors/${h}`],
  ko_fi: ['Ko-fi', (h) => `https://ko-fi.com/${h}`],
  liberapay: ['Liberapay', (h) => `https://liberapay.com/${h}/donate`],
  open_collective: ['Open Collective', (h) => `https://opencollective.com/${h}`],
  patreon: ['Patreon', (h) => `https://www.patreon.com/${h}`],
  buy_me_a_coffee: ['Buy Me a Coffee', (h) => `https://www.buymeacoffee.com/${h}`],
  polar: ['Polar', (h) => `https://polar.sh/${h}`],
};

let ctx = null; // { call, state, viewer, mapView }
let links = { repo: '', donate: {} };
let reports = false; // a DSN in this build: anonymous reports can be sent
let crashesWaiting = [];
let lostCount = 0;
let autoSent = 0, logged = 0;
const crumbs = [], problems = [], logQueue = [], logSeen = new Set();
const $ = (id) => document.getElementById(id);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---- what happened: breadcrumbs, problems, the log ----------------------------------------------

// A step the user took (the report's breadcrumbs): category, what.
export function crumb(category, message) {
  crumbs.push({ timestamp: Date.now() / 1000, category, message: clip(String(message), 200), level: 'info' });
  if (crumbs.length > MAX_CRUMBS) crumbs.shift();
}

function logLine(text) {
  const line = clip(String(text), 1500);
  if (logSeen.has(line) || logged >= LOG_PER_SESSION) return;
  logSeen.add(line);
  logged++;
  logQueue.push(line);
  if (logQueue.length === 1) setTimeout(flushLog, 800);
}

function flushLog() {
  if (!ctx || !logQueue.length) { if (logQueue.length) setTimeout(flushLog, 800); return; }
  ctx.call('log', { lines: logQueue.splice(0) }).catch(() => {});
}
// (the page going: a lost WebGL context reloads it, viewer.js; the message is posted at once)
window.addEventListener('pagehide', () => { try { flushLog(); } catch { /* going anyway */ } });

// The problems outlive the page's own reloads (a lost WebGL context reloads it, viewer.js; a crashed
// page is loaded again by the host): kept for the session, shown as before the reload.
const KEEP = 'xo.support.problems';
function keep() {
  try { sessionStorage.setItem(KEEP, JSON.stringify({ lost: lostCount, problems: problems.slice(-20).map((p) => ({ ...p, stack: clip(p.stack, 1500), time: p.time.toISOString() })) })); } catch { /* no storage: this page's alone */ }
}
function restore() {
  try {
    const k = JSON.parse(sessionStorage.getItem(KEEP) || 'null');
    if (!k) return;
    lostCount = k.lost || 0;
    for (const p of k.problems || []) problems.push({ ...p, time: new Date(p.time), before: true });
  } catch { /* none */ }
}
restore();
let lostAt = -1e9; // (when the WebGL context was last lost: shaders that fail to build then are its doing)

function where() {
  if (!ctx) return '';
  const s = ctx.state, m = ctx.mapView;
  if (s.view === 'map') return `Maps${m?.scene ? `: ${m.scene.name}` : ''}${m?.request?.environment ? ` (weather ${m.request.environment})` : ''}${m?.request?.festival && m.request.festival !== 'Empty' ? `, ${m.request.festival}` : ''}`;
  if (s.view === 'build') return 'Vehicle Builder';
  return `3D Viewer${s.info?.path ? `: ${s.info.path}` : ''}`;
}

// A problem: noted once per kind (count after that), logged, offered or sent.
function note(kind, type, message, stack, mechanism) {
  const msg = clip(String(message || ''), 800), st = clip(String(stack || ''), 4000);
  const sig = `${kind}|${type}|${msg.slice(0, 200)}|${(st.split('\n').find((l) => /\bat\b|@/.test(l)) || '').trim()}`;
  let p = problems.find((q) => q.sig === sig);
  if (p) p.count++;
  else {
    p = { sig, kind, type: type || 'Error', message: msg, stack: st, mechanism, count: 1, time: new Date(), where: where(), sent: null };
    problems.push(p);
    if (problems.length > MAX_PROBLEMS) problems.shift();
    logLine(`${kind}: ${p.type}: ${msg}${st ? ' | ' + st.split('\n').slice(0, 4).map((l) => l.trim()).join(' | ') : ''} (${p.where})`);
    crumb('error', `${p.type}: ${clip(msg, 120)}`);
    if (ctx) autoSend(p);
  }
  keep();
  showBadge();
  if (!$('reportDialog')?.hidden) renderProblems();
}

const fmt = (a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());

// (from the page's first moment: app.js imports this before anything runs)
window.addEventListener('error', (e) => {
  if (!(e instanceof ErrorEvent)) return; // (a picture that did not load: no bug of the page's)
  note('error', e.error?.name || 'Error', e.error?.message ?? e.message, e.error?.stack || `at ${e.filename}:${e.lineno}:${e.colno}`, 'onerror'); // (e.message: "Uncaught Error: ...")
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  note('rejection', r?.name || 'UnhandledRejection', r?.message ?? String(r), r?.stack || '', 'onunhandledrejection');
});
{
  const error = console.error, warn = console.warn;
  console.error = function (...args) {
    error.apply(console, args);
    try {
      const text = args.map(fmt).join(' ');
      const lost = performance.now() - lostAt < 5000 || !!ctx?.viewer.renderer.getContext().isContextLost?.();
      if (/Shader Error|VALIDATE_STATUS|CONTEXT_LOST|WebGLProgram/i.test(text) && !lost) note('shader', 'ShaderError', text, '', 'console');
      else logLine(`console.error: ${text}`); // (shaders failing while the context is gone: the loss is the problem)
    } catch { /* never let reporting break the page */ }
  };
  console.warn = function (...args) {
    warn.apply(console, args);
    try { logLine(`console.warn: ${args.map(fmt).join(' ')}`); } catch { /* as above */ }
  };
}

// The page's steps: what was clicked (its id, view or label: never typed text).
document.addEventListener('click', (e) => {
  const el = e.target?.closest?.('button, [role=tab], a, summary, .row-item, .map-row, label');
  if (!el || el.closest('.support-card')) return;
  const id = el.id ? `#${el.id}` : '', view = el.dataset?.view ? `[${el.dataset.view}]` : '';
  const text = clip((el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' '), 48);
  crumb('ui.click', `${el.tagName.toLowerCase()}${id}${view}${text ? ` "${text}"` : ''}`);
}, true);

// ---- the details --------------------------------------------------------------------------------

function webgl() {
  const r = ctx.viewer.renderer, gl = r.getContext();
  let renderer = '', vendor = '';
  try {
    const x = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = gl.getParameter(x ? x.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '';
    vendor = gl.getParameter(x ? x.UNMASKED_VENDOR_WEBGL : gl.VENDOR) || '';
  } catch { /* a lost context */ }
  return { renderer, vendor, maxTexture: r.capabilities.maxTextureSize, programs: r.info.programs?.length || 0, textures: r.info.memory.textures, geometries: r.info.memory.geometries, lost: lostCount, bcTextures: !!ctx.viewer.support?.s3tc };
}

// The settings that say how the view draws (on / off and numbers: nothing a person typed).
function settings() {
  const out = {};
  for (const [k, v] of Object.entries(ctx.state.settings || {})) if ((typeof v === 'boolean' || typeof v === 'number') && !/^(window|report|install)/i.test(k)) out[k] = v;
  return out;
}

// Everything a report shows: the host's part (machine, game, log, crashes) and the page's.
async function gather() {
  const host = await ctx.call('diagnostics', { lines: 200 });
  crashesWaiting = host.crashes || crashesWaiting;
  return { host, page: { where: where(), webgl: webgl(), settings: settings(), problems: problems.map((p) => ({ type: p.type, message: p.message, count: p.count, where: p.where, sent: p.sent })) } };
}

// The details as Markdown (Copy details, the GitHub form); full: with the log's last lines.
export function detailsText(info, { full = true } = {}) {
  const h = info.host, p = info.page, os = h.os || {}, d = h.display || {};
  const L = [`**Grimcold ${h.app?.version}** (built ${h.app?.built})`];
  L.push(`- ${os.name || 'Windows'}${os.version ? ' ' + os.version : ''} (build ${os.build}, ${os.arch})`);
  L.push(`- CPU: ${h.cpu?.name || '?'}, ${h.cpu?.threads} threads · RAM ${h.memory?.total} GB (${h.memory?.free} GB free)`);
  for (const g of h.gpus || []) L.push(`- GPU: ${g.name}, driver ${g.driver || '?'}, ${g.vram} GB`);
  L.push(`- WebGL: ${p.webgl.renderer || '?'} · max texture ${p.webgl.maxTexture}${p.webgl.bcTextures ? '' : ' · no BC textures'}${p.webgl.lost ? ` · context lost ${p.webgl.lost} time(s)` : ''}`);
  L.push(`- WebView2 ${h.webview2 || '?'} · ${d.dpi} dpi (${Math.round((d.scale || 1) * 100)} %), window ${d.width} × ${d.height}`);
  L.push(`- Crossout ${h.game?.found ? h.game.version || '(version unknown)' : 'not found'}`);
  L.push(`- Where: ${p.where || '?'}`);
  const s = Object.entries(p.settings).map(([k, v]) => `${k} ${v}`).join(', ');
  if (s) L.push(`- Settings: ${s}`);
  if ((h.crashes || []).length) {
    L.push('', '**Crashes since the last start**');
    for (const c of h.crashes) L.push(`- ${c.time}: ${crashLine(c)}`);
  }
  if (p.problems.length) {
    L.push('', '**Problems this session**');
    for (const q of p.problems.slice(-12)) L.push(`- ${q.count > 1 ? q.count + '× ' : ''}${q.type}: ${clip(q.message, 300)} (${q.where})`);
  }
  if (full && h.log?.length) L.push('', `<details><summary>Log (${h.log.length === 1 ? 'the last line' : `the last ${h.log.length} lines`})</summary>`, '', '```', ...h.log, '```', '</details>');
  return L.join('\n');
}

function crashLine(c) {
  if (c.kind === 'crash') return `the app crashed: ${c.what} in ${c.module}+${c.offset} (${c.code})${c.dump ? ', minidump kept' : ''}`;
  return `${c.what}${c.reason ? ` (${c.reason})` : ''}, exit code ${c.code}`;
}

// ---- out of the app: links, the clipboard ------------------------------------------------------

// A web page in the real browser (tests: noted, nothing opened).
function openExternal(url) {
  if (ctx?.state.test) { window.__xoOpened = url; return; }
  window.open(url, '_blank', 'noopener');
}

async function copy(text) {
  window.__xoCopied = text; // (tests)
  try { // (a window without the focus may never answer: not for long)
    if (await Promise.race([navigator.clipboard.writeText(text).then(() => true), new Promise((r) => setTimeout(() => r(false), 1500))])) return true;
  } catch { /* no permission: the old way */ }
  const t = document.createElement('textarea');
  t.value = text;
  t.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(t);
  t.select();
  const ok = document.execCommand('copy');
  t.remove();
  return ok;
}

const handle = (h) => typeof h === 'string' && /^[A-Za-z0-9._-]{1,60}$/.test(h);
const repoUrl = () => (/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(links.repo || '') ? links.repo : '');

// The GitHub issue form filled in (bug_report.yml's fields); the details too long for a link stay
// on the clipboard instead.
function issueUrl(info, title) {
  const repo = repoUrl();
  if (!repo) return '';
  const q = new URLSearchParams({ template: 'bug_report.yml', title: title || '', version: info.host.app?.version || '', diagnostics: detailsText(info, { full: false }) });
  if (`${repo}/issues/new?${q}`.length > 7000) q.set('diagnostics', '(The app copied the details: paste them here.)');
  return `${repo}/issues/new?${q}`;
}

async function openIssue(title) {
  const info = await gather();
  const url = issueUrl(info, title);
  if (!url) return false;
  if (url.includes('paste+them+here')) await copy(detailsText(info, { full: false }));
  openExternal(url);
  return true;
}

// ---- sending ------------------------------------------------------------------------------------

// A JS stack as Sentry's frames (oldest first).
function frames(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n')) {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (m) out.push({ function: m[1] || '?', filename: m[2].replace(/^https:\/\/xo\.app\//, ''), abs_path: m[2], lineno: +m[3], colno: +m[4], in_app: /xo\.app/.test(m[2]) });
  }
  return out.length ? { frames: out.reverse() } : undefined;
}

function installId() {
  let id = ctx.state.settings.installId;
  if (typeof id !== 'string' || id.length < 16) {
    id = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    setSetting('installId', id);
  }
  return id;
}

function setSetting(key, value) {
  ctx.state.settings[key] = value;
  ctx.call('setSettings', { [key]: value }).catch(() => {});
}

// One report: a problem of this session, a crash waiting, or (neither) what the session saw.
async function sendReport({ problem = null, crash = null } = {}) {
  const info = await gather();
  const w = info.page.webgl;
  const ev = {
    platform: crash?.kind === 'crash' ? 'native' : 'javascript',
    level: crash ? 'fatal' : problem ? 'error' : 'info',
    tags: { view: ctx.state.view, map: ctx.mapView?.scene?.name || '', game_version: info.host.game?.version || '', webview2: (info.host.webview2 || '').split('.')[0], gpu_webgl: clip(w.renderer, 120) },
    contexts: { webgl: w, view: { where: info.page.where } },
    breadcrumbs: { values: crumbs.slice() },
    extra: { settings: info.page.settings, problems: info.page.problems.slice(-20), crashes: (info.host.crashes || []).map(crashLine) },
    user: { id: installId() },
  };
  if (crash) {
    const type = crash.kind === 'crash' ? crash.what : crash.kind === 'page' ? 'PageCrash' : 'WebView2Crash';
    ev.exception = { values: [{ type, value: crashLine(crash), mechanism: { type: crash.kind === 'crash' ? 'minidump' : 'webview2', handled: false } }] };
    ev.tags.crash_kind = crash.kind;
  } else if (problem) {
    ev.exception = { values: [{ type: problem.type, value: problem.message, stacktrace: frames(problem.stack), mechanism: { type: problem.mechanism || 'generic', handled: false } }] };
    ev.tags.where = problem.where;
  } else {
    ev.message = { formatted: `A report from Bug report: ${problems.length} problem(s) this session` };
  }
  const r = await ctx.call('report', { event: ev, crash: crash?.id || '', log: true });
  if (r.ok) {
    if (problem) { problem.sent = r.id; keep(); }
    if (crash) crashesWaiting = crashesWaiting.filter((c) => c.id !== crash.id);
  }
  return r;
}

// A new problem while automatic reports are on (once per kind, a few a session).
function autoSend(p) {
  if (!reports || ctx.state.settings.reportAuto !== true || autoSent >= AUTO_PER_SESSION) return;
  autoSent++;
  sendReport({ problem: p }).then(() => showBadge(), () => {});
}

// ---- the pages ----------------------------------------------------------------------------------

function showBadge() {
  const b = $('bugReportBtn');
  if (b) b.classList.toggle('alert', problems.some((p) => !p.sent) || crashesWaiting.length > 0);
}

function open(id) {
  for (const d of document.querySelectorAll('.support-modal')) d.hidden = d.id !== id;
  crumb('ui.page', id);
}
function close(id) { $(id).hidden = true; }

function renderDonate() {
  const box = $('donateLinks');
  box.replaceChildren();
  const add = (name, url) => {
    const a = document.createElement('button');
    a.className = 'btn donate-link';
    a.textContent = name;
    a.title = url;
    a.addEventListener('click', () => openExternal(url));
    box.appendChild(a);
  };
  const d = links.donate || {};
  for (const [key, [name, url]] of Object.entries(PLATFORMS)) if (handle(d[key])) add(name, url(d[key]));
  for (const c of (Array.isArray(d.custom) ? d.custom : []).slice(0, 4)) if (c && /^https:\/\/[^\s"<>]+$/.test(c.url || '')) add(clip(String(c.name || c.url), 40), c.url);
  $('donateNone').hidden = box.children.length > 0;
  const repo = repoUrl();
  $('donateOfficial').hidden = !repo;
  if (repo) {
    const a = $('donateOfficialLink');
    a.textContent = repo.replace('https://', '') + '/releases';
    a.onclick = (e) => { e.preventDefault(); openExternal(`${repo}/releases`); };
  }
}

function renderReport() {
  const repo = repoUrl();
  $('repGithub').disabled = !repo;
  $('repGithubNote').textContent = repo ? '' : 'The project\'s GitHub page is not set up in this build yet: copy the details instead.';
  $('repKnown').hidden = !repo;
  $('repSendSec').hidden = !reports;
  $('repNoSend').hidden = reports;
  $('repAuto').checked = ctx.state.settings.reportAuto === true;
  renderProblems();
}

function renderProblems() {
  const list = $('repProblemList');
  list.replaceChildren();
  const rows = [
    ...crashesWaiting.map((c) => ({ when: c.time, text: crashLine(c), state: 'waiting' })),
    ...problems.map((p) => ({ when: p.time.toLocaleTimeString() + (p.before ? ' (earlier)' : ''), text: `${p.count > 1 ? p.count + '× ' : ''}${p.type}: ${clip(p.message, 160)}`, state: p.sent ? 'sent' : '' })),
  ];
  for (const r of rows.slice(-15)) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="when"></span><span class="what"></span><span class="state"></span>';
    li.children[0].textContent = r.when;
    li.children[1].textContent = r.text;
    li.children[2].textContent = r.state;
    list.appendChild(li);
  }
  $('repProblems').hidden = rows.length === 0;
}

function busyButton(btn, text, work) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = text;
  return Promise.resolve().then(work).finally(() => { btn.disabled = false; btn.textContent = was; });
}

async function showDetails(pre) {
  pre.textContent = detailsText(await gather());
  pre.hidden = false;
}

// Copy details: what is shown, else gathered now.
async function copyDetails(pre, state) {
  const text = pre.hidden ? detailsText(await gather()) : pre.textContent;
  state.textContent = (await copy(text)) ? 'Details copied.' : 'Could not copy: select the details and copy them from there.';
  if (pre.hidden) { pre.textContent = text; pre.hidden = false; } // (to copy by hand if need be)
}

// The crash dialog: crashes since the last start (sent at once when automatic reports are on).
async function offerCrashes() {
  if (!crashesWaiting.length) return;
  if (reports && ctx.state.settings.reportAuto === true) {
    for (const c of crashesWaiting.slice()) await sendReport({ crash: c }).catch(() => {});
    showBadge();
    return;
  }
  const last = crashesWaiting[crashesWaiting.length - 1], n = crashesWaiting.length;
  $('crashTitle').textContent = last.kind === 'crash' ? 'Grimcold crashed. Sorry about that.' : 'The view crashed and was reloaded. Sorry about that.';
  const what = `${n > 1 ? `${n} crashes since the last start; the last one: ` : ''}${crashLine(last)}.`;
  $('crashWhat').textContent = what[0].toUpperCase() + what.slice(1);
  $('crashSend').hidden = !reports;
  $('crashAutoRow').hidden = !reports;
  $('crashAsk').hidden = !reports;
  $('crashNoSend').hidden = reports;
  $('crashAuto').checked = false;
  $('crashDetails').hidden = true;
  $('crashGithub').disabled = !repoUrl();
  open('crashDialog');
}

// ---- start ---------------------------------------------------------------------------------------

// init: the host's init reply ({ crashes, reports, test }); c: { call, state, viewer, mapView }.
export async function initSupport(init, c) {
  ctx = c;
  reports = !!init.reports;
  crashesWaiting = init.crashes || [];
  try {
    const r = await fetch('support.json', { cache: 'no-store' });
    if (r.ok) links = await r.json();
  } catch { /* no links: the pages say so */ }
  window.__xo.support = { links: (l) => { links = { ...links, ...l }; }, problems: () => problems, crumbs: () => crumbs, gather, detailsText, sendReport, setReports: (on) => { reports = on; } }; // (tests)
  flushLog();
  c.viewer.canvas.addEventListener('webglcontextlost', () => { lostCount++; lostAt = performance.now(); note('webgl', 'WebGLContextLost', `the WebGL context was lost (${where()})`, '', 'webglcontextlost'); });

  $('donationsBtn').addEventListener('click', () => { renderDonate(); open('donateDialog'); });
  // (the legal notice, NOTICE.md: the original's address, whatever support.json says)
  $('legalSource').addEventListener('click', (e) => { e.preventDefault(); openExternal(e.currentTarget.dataset.url); });
  $('bugReportBtn').addEventListener('click', () => { renderReport(); $('repDetails').hidden = true; $('repState').textContent = ''; open('reportDialog'); });
  for (const d of document.querySelectorAll('.support-modal')) {
    d.addEventListener('mousedown', (e) => { if (e.target === d && d.id !== 'crashDialog') d.hidden = true; }); // (the dark around it)
    for (const b of d.querySelectorAll('[data-close]')) b.addEventListener('click', () => (d.hidden = true));
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const d = [...document.querySelectorAll('.support-modal')].find((x) => !x.hidden);
    if (d) { d.hidden = true; e.stopPropagation(); }
  }, true);

  // Bug report
  $('repGithub').addEventListener('click', (e) => busyButton(e.currentTarget, 'Opening…', () => openIssue('')));
  $('repKnown').addEventListener('click', () => repoUrl() && openExternal(`${repoUrl()}/blob/main/KNOWN_ISSUES.md`));
  $('repView').addEventListener('click', (e) => busyButton(e.currentTarget, 'Gathering…', () => showDetails($('repDetails'))));
  $('repCopy').addEventListener('click', (e) => busyButton(e.currentTarget, 'Copying…', () => copyDetails($('repDetails'), $('repState'))));
  $('repLogs').addEventListener('click', () => ctx.call('openLogs').catch(() => {}));
  $('repAuto').addEventListener('change', (e) => setSetting('reportAuto', e.target.checked));
  $('repSend').addEventListener('click', (e) => busyButton(e.currentTarget, 'Sending…', async () => {
    const st = $('repState');
    try {
      const todo = [...crashesWaiting.map((c) => ({ crash: c })), ...problems.filter((p) => !p.sent).slice(-5).map((p) => ({ problem: p }))];
      if (!todo.length) todo.push({});
      let ok = 0, err = '';
      for (const t of todo) { const r = await sendReport(t); if (r.ok) ok++; else err ||= r.error; }
      st.textContent = ok ? `Sent ${ok === 1 ? 'the report' : ok + ' reports'}. Thank you!` : `Not sent: ${err}`;
    } catch (x) { st.textContent = `Not sent: ${x.message}`; }
    renderProblems();
    showBadge();
  }));

  // the crash dialog
  $('crashSend').addEventListener('click', (e) => busyButton(e.currentTarget, 'Sending…', async () => {
    if ($('crashAuto').checked) setSetting('reportAuto', true);
    let ok = 0, err = '';
    for (const cr of crashesWaiting.slice()) { const r = await sendReport({ crash: cr }).catch((x) => ({ ok: false, error: x.message })); if (r.ok) ok++; else err ||= r.error; }
    if (ok && !err) close('crashDialog');
    else $('crashState').textContent = err ? `Not sent: ${err}` : '';
    showBadge();
  }));
  $('crashDrop').addEventListener('click', async () => {
    for (const cr of crashesWaiting) await ctx.call('dropCrash', { id: cr.id }).catch(() => {});
    crashesWaiting = [];
    close('crashDialog');
    showBadge();
  });
  $('crashView').addEventListener('click', (e) => busyButton(e.currentTarget, 'Gathering…', () => showDetails($('crashDetails'))));
  $('crashCopy').addEventListener('click', (e) => busyButton(e.currentTarget, 'Copying…', () => copyDetails($('crashDetails'), $('crashState'))));
  $('crashGithub').addEventListener('click', (e) => busyButton(e.currentTarget, 'Opening…', () => openIssue('Crash: ' + crashLine(crashesWaiting[crashesWaiting.length - 1] || {}).slice(0, 80))));
  $('crashLogs').addEventListener('click', () => ctx.call('openLogs').catch(() => {}));

  showBadge();
  offerCrashes();
}
