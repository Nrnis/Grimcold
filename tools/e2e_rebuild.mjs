// End-to-end test of the rebuilding aids in the Vehicle Builder, with real mouse and keys:
// the parts checklist (typed list, names matched to parts, a line puts its part on the cursor,
// counts as parts are placed, ST wheels, suggestions, ticking by hand) and the reference pictures
// (added, pinned to a view, fading when the camera turns away, back with a click or P, lined up by
// dragging / zooming / keys, behind or in front, lens, opacity), saved with the build and restored
// after a restart.
//   node tools/e2e_rebuild.mjs [--snap-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { launch, sleep, removeDir } from './cdp.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });
const shot = (n) => (snapDir ? path.join(snapDir, n + '.png') : null);
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A test "screenshot": 640 x 360, a dark gradient with a bright cross in the middle.
function png(w, h, pixel) {
  const row = w * 3 + 1, raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * row + 1 + x * 3);
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const LIST = `4 Bigfoot ST
Werewolf
2x Scorpion
Sledge
Bogus part name
Lightweight frame`;

let app = await launch({ prefix: 'xo-e2e-rebuild-' });
const out = path.join(app.dataDir, 'out');
fs.mkdirSync(out, { recursive: true });
const picture = path.join(out, 'garage screenshot.png');
fs.writeFileSync(picture, png(640, 360, (x, y) => (Math.abs(x - 320) < 6 || Math.abs(y - 180) < 6 ? [255, 220, 60] : [20 + (x >> 3), 30, 40 + (y >> 3)])));
let { js, waitFor, click, mouse, key, send } = app;
const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
const frames = (n = 3) => js(`new Promise((r) => { let k = ${n}; const f = () => (--k ? requestAnimationFrame(f) : r()); requestAnimationFrame(f); })`);
// (scrolled into view first, like a user scrolling the panel to it)
const center = (sel) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
async function place(pt) {
  await waitFor('!!window.__xo.build.placing', 20000);
  await mouse('mouseMoved', pt.x - 3, pt.y - 3);
  await sleep(80);
  await mouse('mouseMoved', pt.x, pt.y);
  await waitFor('window.__xo.build.placing && window.__xo.build.placing.hasPos', 10000);
  const before = await js('window.__xo.build.instances.length');
  await click(pt.x, pt.y);
  await waitFor(`window.__xo.build.instances.length > ${before}`, 20000);
  await settle();
}
// a spot on the ground beside the build that is on screen and free of parts
const freeGround = () => js(`(() => { const b = window.__xo.build.box(), r = document.getElementById('view').getBoundingClientRect(), top = document.getElementById('buildTools').getBoundingClientRect().bottom;
  const cx = b.isEmpty() ? 0 : (b.min.x + b.max.x) / 2, cz = b.isEmpty() ? 0 : (b.min.z + b.max.z) / 2, ex = b.isEmpty() ? 0 : b.max.x, nx = b.isEmpty() ? 0 : b.min.x, ez = b.isEmpty() ? 0 : b.max.z, nz = b.isEmpty() ? 0 : b.min.z;
  for (const [x, z] of [[ex + 1.2, cz], [nx - 1.2, cz], [cx, ez + 1.2], [cx, nz - 1.2], [ex + 0.9, ez + 0.9], [nx - 0.9, nz - 0.9], [ex + 2, cz], [nx - 2, cz]]) {
    const p = window.__xo.viewer.project(x, 0, z);
    if (p.inFront && p.x > r.left + 30 && p.x < r.right - 30 && p.y > top + 40 && p.y < r.bottom - 80 && !window.__xo.build.instanceAt({ clientX: p.x, clientY: p.y })) return p;
  } return null; })()`);
const item = (name) => js(`window.__xo.checklist().find((i) => i.name === ${JSON.stringify(name)})`);
const pic = () => js(`(() => { const L = document.getElementById('refLayer'), img = document.getElementById('refImg'), r = window.__xo.refs.current();
  return { shown: !L.hidden, front: L.classList.contains('front'), adjust: L.classList.contains('lining'), opacity: +img.style.opacity, src: img.src, loaded: img.complete && img.naturalWidth > 0,
    rect: img.getBoundingClientRect().toJSON(), fov: window.__xo.viewer.camera.fov, ref: r && { ...r } }; })()`);
// turns the builder's camera about its target by deg degrees
const turn = (deg) => js(`(() => { const v = window.__xo.viewer, t = v.controls.target, p = v.camera.position.clone().sub(t); p.applyAxisAngle({ x: 0, y: 1, z: 0, isVector3: true }, ${deg} * Math.PI / 180); v.camera.position.copy(t).add(p); v.tween = null; v.controls.update(); v.dirty = true; })()`);

try {
  await waitFor('window.__xoReady === true', 60000);
  await js(`window.__xo.setView('build')`);
  await sleep(300);

  // ---------------- the parts checklist ----------------
  ok(await js(`document.getElementById('ckList').children.length === 0 && document.getElementById('ckSummary').textContent === 'Type or paste the parts'`), 'an empty build has an empty parts list');
  await js(`(() => { document.getElementById('ckEdit').open = true; document.getElementById('ckText').value = ${JSON.stringify(LIST)}; })()`);
  await click(...Object.values(await center('#ckApply')));
  await sleep(200);
  const ck = await js('window.__xo.checklist()');
  ok(ck.length === 6, `the typed list makes 6 lines (${ck.length})`);
  const bf = ck.find((i) => i.name === 'Bigfoot');
  ok(bf && bf.count === 4 && bf.st && bf.match.paths.length > 0, `"4 Bigfoot ST" = 4 of the Bigfoot's steering version (${JSON.stringify(bf && { count: bf.count, st: bf.st, models: bf.match.paths.length })})`);
  ok(ck.find((i) => i.name === 'Scorpion')?.count === 2, '"2x Scorpion" = 2 Scorpions');
  const sl = ck.find((i) => i.name === 'Sledge');
  ok(sl && sl.match.paths.length > 0 && sl.match.guessed && sl.match.name === 'Sledgehammer', `a short name finds its part ("Sledge" → ${sl?.match?.name})`);
  ok(await js(`document.querySelector('#ckList .ck-row[data-k="3"]').textContent.includes('Sledgehammer') && document.querySelector('#ckList .ck-row[data-k="3"]').textContent.includes('you wrote')`), 'the row shows the part it matched and what was typed');
  const bogus = ck.find((i) => i.name === 'Bogus part name');
  ok(bogus && bogus.match.paths.length === 0 && !bogus.match.suggest.length, 'an unknown name stays unmatched');
  const lw = ck.find((i) => i.name === 'Lightweight frame');
  ok(lw && lw.match.paths.length === 0 && lw.match.suggest.length >= 2, `a name that fits several parts offers them (${lw?.match?.suggest?.join(' / ')})`);
  ok(await js(`document.getElementById('ckCount').textContent`) === '(0 of 10 placed)', `header counts what is placed (${await js(`document.getElementById('ckCount').textContent`)})`);
  ok(!(await js(`document.getElementById('ckEdit').open`)), 'making the list folds the text box away');
  await app.snap(shot('r01-checklist'));

  // a line puts its part on the cursor; dropping it ticks the line
  await click(...Object.values(await center('#ckList .ck-row[data-k="1"] .cn')));
  await waitFor('!!window.__xo.build.placing', 20000);
  const werePath = await js('window.__xo.build.placing.path');
  ok(/cabins\//.test(werePath), `clicking "Werewolf" puts the Werewolf cabin on the cursor (${werePath})`);
  await place(await js('window.__xo.viewer.project(0, 0, 0)'));
  ok((await item('Werewolf')).match.placed === 1, 'the Werewolf line counts the placed cabin');
  ok(await js(`document.querySelector('#ckList .ck-row[data-k="1"]').classList.contains('done')`), 'and shows it done');

  // the ST wheel: placed from its line it is a steering wheel, and only steering Bigfoots count
  await click(...Object.values(await center('#ckList .ck-row[data-k="0"] .cgo')));
  await waitFor('!!window.__xo.build.placing', 20000);
  ok(await js('window.__xo.build.placing.st === true'), 'the "Bigfoot ST" line holds a steering wheel');
  await place(await freeGround());
  ok((await item('Bigfoot')).match.placed === 1, 'one ST Bigfoot placed: 1 of 4');
  ok(await js(`document.querySelector('#ckList .ck-row[data-k="0"]').classList.contains('part')`), 'a partly placed line looks partly done');
  const hasSt = await js(`window.__xo.garage.stats.hasSteering(${JSON.stringify(bf.match.paths[0])})`);
  await js(`window.__xo.build.startPlacing(${JSON.stringify(bf.match.paths[0])}, '', { st: false })`);
  await place(await freeGround());
  ok((await item('Bigfoot')).match.placed === (hasSt ? 1 : 2), hasSt ? 'a plain (non-steering) Bigfoot does not count for "Bigfoot ST"' : 'Bigfoot has no ST version: any Bigfoot counts');

  // suggestions, ticking by hand, searching
  await click(...Object.values(await center('#ckList .ck-row[data-k="5"] [data-sug]')));
  await sleep(150);
  const picked = await js('window.__xo.state.checklist[5].name');
  ok(/^Lightweight frame/.test(picked) && (await js('window.__xo.checklist()[5].match.paths.length')) > 0, `picking a suggestion settles the line (${picked})`);
  await click(...Object.values(await center('#ckList .ck-row[data-k="4"] [data-tick]')));
  await sleep(150);
  ok(await js('window.__xo.state.checklist[4].done === true') && await js(`document.querySelector('#ckList .ck-row[data-k="4"]').classList.contains('done')`), 'an unmatched line can be ticked by hand');
  ok(await js(`document.getElementById('ckCount').textContent`) === '(3 of 10 placed)', `header: 1 Werewolf + 1 Bigfoot ST + the ticked line (${await js(`document.getElementById('ckCount').textContent`)})`);

  // ---------------- reference pictures ----------------
  await js('window.__xo.build.select(null)');
  await js('window.__xo.build.frame()');
  await waitFor('!window.__xo.viewer.tween', 5000);
  ok(await js(`!document.getElementById('refEmptyHint').hidden && document.getElementById('refControls').hidden`), 'no pictures yet: the card explains them');
  await js(`window.__xo.refs.add(${JSON.stringify(picture)})`);
  await waitFor(`document.getElementById('refImg').complete && document.getElementById('refImg').naturalWidth > 0`, 15000);
  await frames();
  let p = await pic();
  ok(p.shown && p.front && p.loaded && near(p.opacity, 0.5, 0.01), `an added picture shows over the view, half see-through (${JSON.stringify({ shown: p.shown, front: p.front, opacity: p.opacity })})`);
  const H = await js(`document.getElementById('refLayer').clientHeight`);
  ok(near(p.rect.height, H, 1), `it fills the view's height (${p.rect.height.toFixed(0)} of ${H})`);
  ok(await js(`document.querySelectorAll('#refList .ref-row').length === 1 && document.querySelector('#refList .ref-row').classList.contains('on')`), 'the card lists it, active');
  await app.snap(shot('r02-picture-added'));
  await turn(25);
  await frames();
  ok(near((await pic()).opacity, 0.5, 0.01), 'not pinned yet: it stays while the view turns');
  await turn(-25);
  await frames();

  // pinned: it fades when the camera turns away, and comes back with its view
  await click(...Object.values(await center('#refPin')));
  await frames();
  p = await pic();
  ok(p.ref.pinned && near(p.ref.view.fov, p.fov, 0.01), 'pinned to the camera view');
  await turn(2);
  await frames();
  const halfway = (await pic()).opacity;
  ok(halfway > 0.05 && halfway < 0.5, `turned 2°: it fades (${halfway.toFixed(2)})`);
  await turn(28);
  await frames();
  ok(!(await pic()).shown, 'turned 30°: gone');
  await click(...Object.values(await center('#refList .ref-row .rn')));
  await waitFor('!window.__xo.viewer.tween', 5000);
  await frames();
  p = await pic();
  ok(p.shown && near(p.opacity, 0.5, 0.01), `a click on it in the list brings its view back, and the picture (${p.opacity})`);
  await key('p');
  await frames();
  ok(!(await pic()).shown, 'P hides it');
  await key('p');
  await frames();
  ok((await pic()).shown, 'P shows it again');

  // lining it up: drag, wheel, keys
  await click(...Object.values(await center('#refAdjust')));
  await frames();
  p = await pic();
  ok(p.adjust && (await js(`document.getElementById('refAdjust').textContent`)) === 'Done lining up', 'Line it up: the picture takes the mouse');
  const c0 = { x: p.rect.left + p.rect.width / 2, y: p.rect.top + p.rect.height / 2 + 40 };
  await mouse('mouseMoved', c0.x, c0.y);
  await mouse('mousePressed', c0.x, c0.y);
  for (let k = 1; k <= 6; k++) { await mouse('mouseMoved', c0.x + 10 * k, c0.y - 5 * k, 'left', { held: true }); await sleep(16); }
  await mouse('mouseReleased', c0.x + 60, c0.y - 30);
  await frames();
  p = await pic();
  ok(near(p.ref.x * H, 60, 1.5) && near(p.ref.y * H, -30, 1.5), `dragging moves it (${(p.ref.x * H).toFixed(1)}, ${(p.ref.y * H).toFixed(1)} px)`);
  ok(await js('window.__xo.build.instances.length') === 3 && await js('window.__xo.build.sel.length') === 0, 'the drag went to the picture, not to the parts under it');
  const s0 = p.ref.scale;
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: c0.x + 60, y: c0.y - 30, deltaX: 0, deltaY: -240 });
  await frames();
  p = await pic();
  ok(p.ref.scale > s0 * 1.2, `the wheel zooms it (${s0.toFixed(2)} → ${p.ref.scale.toFixed(2)})`);
  const x1 = p.ref.x;
  await key('ArrowRight');
  await frames();
  const dxKey = ((await pic()).ref.x - x1) * H;
  ok(near(dxKey, 1, 0.01), `arrow keys nudge it by a pixel (${dxKey.toFixed(3)} px)`);
  await key('Enter');
  await frames();
  ok(!(await pic()).adjust, 'Enter ends lining up');
  await app.snap(shot('r03-lined-up'));

  // behind the parts, lens, opacity
  await click(...Object.values(await center('#refFront')));
  await frames();
  ok(!(await pic()).front, '"In front of the parts" off: the picture goes behind them');
  await app.snap(shot('r04-behind'));
  await js(`(() => { const s = document.getElementById('refLens'); s.value = 55; s.dispatchEvent(new Event('input')); })()`);
  await frames();
  p = await pic();
  ok(near(p.fov, 55, 0.01) && near(p.ref.view.fov, 55, 0.01) && near(p.opacity, 0.5, 0.01), `Lens sets the camera's field of view with the picture (${p.fov}°)`);
  await js(`(() => { const s = document.getElementById('refOpacity'); s.value = 0.8; s.dispatchEvent(new Event('input')); })()`);
  await frames();
  ok(near((await pic()).opacity, 0.8, 0.01), 'Opacity');
  await js(`window.__xo.setView('part')`);
  await frames();
  p = await pic();
  ok(!p.shown && near(p.fov, 38, 0.01), `the 3D Viewer: no picture, the normal lens (${p.fov}°)`);
  await js(`window.__xo.setView('build')`);
  await frames();
  p = await pic();
  ok(p.shown && near(p.fov, 55, 0.01), 'back in the builder: the picture and its lens');

  // saved with the build, opened again
  const file = await js('window.__xo.buildFile()');
  const saved = file.refs?.list?.[0];
  ok(saved && saved.file === picture && saved.pinned && near(saved.view.fov, 55, 0.01) && saved.front === false && near(saved.opacity, 0.8, 0.001), 'the build file keeps the picture (file, view, place, lens, opacity, behind)');
  ok(file.checklist?.items?.length === 6 && file.checklist.items[4].done && /Bigfoot ST/.test(file.checklist.text), 'and the parts list (lines, ticks, the typed text)');
  await js(`window.__xo.loadBuildFile(${JSON.stringify(file)})`);
  await waitFor(`window.__xo.refs.list.length === 1 && document.getElementById('refImg').complete && document.getElementById('refImg').naturalWidth > 0`, 15000);
  p = await pic();
  ok(p.ref.file === picture && p.ref.pinned && near(p.ref.x, saved.x, 1e-6) && near(p.ref.scale, saved.scale, 1e-6) && near(p.fov, 55, 0.01), 'opening the build brings the picture back (read again from its file)');
  ok((await js('window.__xo.checklist()')).map((i) => `${i.count} ${i.name}${i.done ? ' ✓' : ''}`).join('|') === file.checklist.items.map((i) => `${i.count} ${i.name}${i.done ? ' ✓' : ''}`).join('|'), 'and the parts list');
  const gone = JSON.parse(JSON.stringify(file));
  gone.refs.list[0].file = path.join(out, 'no such picture.png');
  await js(`window.__xo.loadBuildFile(${JSON.stringify(gone)})`);
  await settle();
  ok(await js('window.__xo.refs.list.length') === 0 && /missing image .*no such picture\.png/.test(await js(`document.getElementById('statusText').textContent`)), 'a picture whose file is gone is named in a warning');
  await js(`window.__xo.loadBuildFile(${JSON.stringify(file)})`);
  await waitFor('window.__xo.refs.list.length === 1', 15000);

  // removing it
  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);

  // restart: the autosave keeps both
  await sleep(1500);
  const auto = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'autosave.xobuild'), 'utf8'));
  ok(auto.refs?.list?.length === 1 && auto.checklist?.items?.length === 6, 'the autosave has the picture and the parts list');
  const dataDir = app.dataDir;
  await app.close({ keep: true });
  app = await launch({ dataDir });
  ({ js, waitFor, click, mouse, key, send } = app);
  await waitFor('window.__xoReady === true', 60000);
  await js(`window.__xo.setView('build')`);
  await waitFor('window.__xo.build.instances.length === 3 && window.__xo.refs.list.length === 1', 60000);
  ok((await js('window.__xo.checklist()')).length === 6, 'after a restart: parts, picture and parts list are back');
  await click(...Object.values(await center('#refList .ref-row .rx')));
  await frames();
  p = await pic();
  ok(!p.shown && near(p.fov, 38, 0.01) && (await js('window.__xo.refs.list.length')) === 0, 'removing the picture: gone, normal lens');
  ok(app.errors.length === 0, `no page errors after restart${app.errors.length ? ': ' + app.errors.slice(0, 4).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  const dir = app.dataDir;
  await app.close();
  if (!(await removeDir(dir))) console.log('note: could not delete ' + dir);
}
console.log(failures ? `${failures} failure(s)` : 'all rebuilding checks passed');
process.exit(failures ? 1 : 0);
