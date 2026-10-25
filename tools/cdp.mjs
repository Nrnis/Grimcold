// Shared helpers for the end-to-end tools: start Grimcold.exe headless (DWM-cloaked,
// never activated, muted, throwaway profile) and drive it over the DevTools protocol.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deletes a folder, retrying while WebView2's helper processes still hold files in it.
export async function removeDir(dir) {
  for (let i = 0; i < 40; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { await sleep(250); }
  }
  return false;
}

// A debugging port nothing listens on yet: tests run side by side (each picking at random) must not
// end up driving each other's app.
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const p = 9500 + Math.floor(Math.random() * 400);
    const free = await new Promise((res) => { const s = net.createServer(); s.once('error', () => res(false)); s.listen(p, '127.0.0.1', () => s.close(() => res(true))); });
    if (free) return p;
  }
  throw new Error('no free debugging port');
}

// dataDir: reuse a profile (e.g. to test what survives a restart); otherwise a throwaway one is
// made and close() deletes it.
export async function launch({ dataDir = null, size = '1500,940', prefix = 'xo-cdp-' } = {}) {
  const ownDir = !dataDir;
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const port = await freePort();
  // XO_EXE: test another build of the app (it must sit in the project folder, beside ui\)
  const proc = spawn(path.join(ROOT, process.env.XO_EXE || 'Grimcold.exe'), ['--data-dir', dir, '--debug-port', String(port), '--headless', '--size', size], { stdio: 'ignore' });
  let url;
  for (let i = 0; i < 300 && !url; i++) {
    try { url = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page' && t.url.startsWith('https://xo.app/'))?.webSocketDebuggerUrl; } catch { /* not up yet */ }
    if (!url) await sleep(100);
  }
  if (!url) { proc.kill(); throw new Error('the app did not expose its page'); }
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  // (the app gone, its page with it: what still waits for an answer fails instead of waiting for good)
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('the app\'s page closed')); pending.clear(); };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (ws.readyState >= WebSocket.CLOSING) { reject(new Error('the app\'s page closed')); return; }
    const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const js = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page error: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result.value;
  };
  const waitFor = async (expression, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await js(expression)) return true; await sleep(80); }
    throw new Error('timed out waiting for ' + expression);
  };
  // modifiers: DevTools bit field, 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. held: a move with the button down.
  const mouse = async (type, x, y, button = 'left', { modifiers = 0, held = false } = {}) => send('Input.dispatchMouseEvent', {
    type, x, y, modifiers, button: type === 'mouseMoved' && !held ? 'none' : button,
    buttons: type === 'mousePressed' || held ? (button === 'left' ? 1 : 2) : 0, clickCount: type === 'mouseMoved' ? 0 : 1,
  });
  const click = async (x, y, button = 'left', { modifiers = 0 } = {}) => {
    await mouse('mouseMoved', x, y, button, { modifiers });
    await sleep(60);
    await mouse('mousePressed', x, y, button, { modifiers });
    await mouse('mouseReleased', x, y, button, { modifiers });
    await sleep(60);
  };
  const drag = async (x0, y0, x1, y1, { modifiers = 0, steps = 10 } = {}) => {
    await mouse('mouseMoved', x0, y0, 'left', { modifiers });
    await sleep(40);
    await mouse('mousePressed', x0, y0, 'left', { modifiers });
    for (let i = 1; i <= steps; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, 'left', { modifiers, held: true });
      await sleep(16);
    }
    await mouse('mouseReleased', x1, y1, 'left', { modifiers });
    await sleep(60);
  };
  const key = async (k, { shift = false, ctrl = false } = {}) => {
    const code = k.length === 1 ? `Key${k.toUpperCase()}` : k;
    const vk = k.length === 1 ? k.toUpperCase().charCodeAt(0) : { Escape: 27, Delete: 46, Backspace: 8, Enter: 13 }[k] || 0;
    const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(40);
  };
  const snap = async (file) => { if (!file) return; await sleep(250); const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
  // Ends the app and waits for its process to be gone. keep: leave the profile folder (for a
  // restart with the same dataDir); a folder the caller passed in is never deleted here.
  const close = async ({ keep = false } = {}) => {
    try { ws.close(); } catch {}
    const exited = proc.exitCode !== null ? Promise.resolve() : new Promise((r) => proc.once('exit', r));
    proc.kill();
    await Promise.race([exited, sleep(5000)]);
    if (ownDir && !keep) await removeDir(dir);
  };
  return { dataDir: dir, send, js, waitFor, mouse, click, drag, key, snap, close, errors, proc };
}
