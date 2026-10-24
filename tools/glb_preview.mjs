// Renders an exported .glb to a PNG with three.js in a headless Edge (no window, muted, throwaway
// profile), to look at map exports without opening anything on screen.
//   node tools/glb_preview.mjs <file.glb> <out.png> [--cam x,y,z] [--target x,y,z] [--fov 50]
//        [--size 1600x900] [--top] [--game-light]
//   --top: straight down over the whole scene; --game-light: the file's own sun (KHR_lights_punctual)
//   and the sky panorama a map export writes beside it (asset.extras.sky) as background and light.
// Coordinates are glTF space (the game's x, y, -z).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ROOT, sleep, removeDir } from './cdp.mjs';

const args = process.argv.slice(2);
const [file, out] = args;
if (!file || !out) {
  console.log('usage: node tools/glb_preview.mjs <file.glb> <out.png> [--cam x,y,z] [--target x,y,z] [--fov deg] [--size WxH] [--top]');
  process.exit(2);
}
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const [W, H] = opt('--size', '1600x900').split('x').map(Number);
const query = new URLSearchParams({ cam: opt('--cam', ''), target: opt('--target', ''), fov: opt('--fov', '50'), top: args.includes('--top') ? '1' : '',
  gamelight: args.includes('--game-light') ? '1' : '' });
// the sky panorama beside the file (map exports name it in asset.extras.sky)
let skyFile = null;
try {
  const fd = fs.openSync(path.resolve(file), 'r'), head = Buffer.alloc(20);
  fs.readSync(fd, head, 0, 20, 0);
  const jl = head.readUInt32LE(12), js = Buffer.alloc(jl);
  fs.readSync(fd, js, 0, jl, 20);
  fs.closeSync(fd);
  const sky = JSON.parse(js.toString('utf8')).asset?.extras?.sky;
  if (sky) skyFile = path.join(path.dirname(path.resolve(file)), sky);
} catch { /* not a .glb we can read: the page reports it */ }

const files = {
  '/view.html': { type: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:#000}canvas{display:block}</style><script type="module" src="/glb_preview_page.js"></script>` },
};
const serve = (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = url.pathname;
  try {
    if (files[p]) { res.writeHead(200, { 'content-type': files[p].type }); res.end(files[p].body); return; }
    let real;
    if (p === '/model.glb') real = path.resolve(file);
    else if (p === '/sky.hdr') real = skyFile;
    else if (p === '/glb_preview_page.js') real = path.join(ROOT, 'tools', 'glb_preview_page.js');
    else if (p.startsWith('/lib/three/')) real = path.join(ROOT, 'ui', 'lib', 'three', path.basename(p));
    if (!real || !fs.existsSync(real)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', 'content-length': fs.statSync(real).size });
    fs.createReadStream(real).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
};
const server = http.createServer(serve);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const httpPort = server.address().port;

const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!edge) { console.error('Edge not found'); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xo-glb-'));
const port = 9900 + Math.floor(Math.random() * 90);
const proc = spawn(edge, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--mute-audio', '--no-first-run',
  '--disable-extensions', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', `--window-size=${W},${H}`, 'about:blank'], { stdio: 'ignore' });
let code = 1;
try {
  let wsUrl;
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch { /* starting */ }
    if (!wsUrl) await sleep(100);
  }
  if (!wsUrl) throw new Error('Edge did not start');
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/view.html?${query}` });
  const t0 = Date.now();
  let state;
  while (Date.now() - t0 < 600000) {
    state = (await send('Runtime.evaluate', { expression: 'window.__state || ""', returnByValue: true })).result.value;
    if (state === 'done' || String(state).startsWith('error')) break;
    await sleep(250);
  }
  for (const l of logs) console.log('  page:', l);
  if (state !== 'done') throw new Error('render did not finish: ' + state);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`rendered ${path.basename(file)} -> ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  ws.close();
  code = 0;
} catch (e) {
  console.error('FAIL', e.message);
} finally {
  proc.kill();
  server.close();
  await sleep(300);
  await removeDir(profile);
}
process.exit(code);
