// End-to-end test: starts Grimcold.exe headless (DWM-cloaked, never activated, muted,
// throwaway profile), drives the real UI over the DevTools protocol, exports through the real
// bridge and validates the files. Screenshots go to --snap-dir when given.
//
//   node tools/e2e.mjs [--snap-dir <dir>] [--keep]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep, ROOT } from './cdp.mjs';
import { loadGltf, poseAt } from './gltf_pose.mjs';

const args = process.argv.slice(2);
const snapDir = args.includes('--snap-dir') ? args[args.indexOf('--snap-dir') + 1] : null;
const keep = args.includes('--keep');
if (snapDir) fs.mkdirSync(snapDir, { recursive: true });

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const app = await launch({ prefix: 'xo-e2e-' });
const { js, waitFor, mouse } = app;
const outDir = path.join(app.dataDir, 'out');
fs.mkdirSync(outDir, { recursive: true });
const snap = (name) => app.snap(snapDir ? path.join(snapDir, name + '.png') : null);
const idle = () => waitFor(`!window.__xo.state.loading && !window.__xo.viewer.tween && document.getElementById('busy').hidden && window.__xo.viewer.materials.every(m => !m.userData.xo.info.textures?.some(t => t.exists && ['albedo','normal','gloss'].includes(t.role)) || m.map)`, 60000);
const call = (cmd, a) => js(`window.__xo.call(${JSON.stringify(cmd)}, ${JSON.stringify(a)})`);
const validate = (file) => execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), file]).toString().trim();
// Compares two xo.data RGBA sources inside the page; returns the number of differing bytes (-1 = size mismatch).
const rgbaDiff = (a, b) => js(`(async () => {
  const get = async (q) => { const r = await fetch('https://xo.data/rgba?' + q); if (!r.ok) throw new Error(q + ': ' + r.status); return new Uint8Array(await r.arrayBuffer()); };
  const [x, y] = await Promise.all([get(${JSON.stringify(a)}), get(${JSON.stringify(b)})]);
  if (x.length !== y.length) return -1;
  let n = 0; for (let i = 12; i < x.length; i++) if (x[i] !== y[i]) n++;
  return n;
})()`);
const rgbaOf = (q) => js(`(async () => { const r = await fetch('https://xo.data/rgba?' + ${JSON.stringify(q)}); const b = new Uint8Array(await r.arrayBuffer()); const d = new DataView(b.buffer); return { w: d.getUint32(4, true), h: d.getUint32(8, true), px: Array.from(b.subarray(12)) }; })()`);

// Small TGA files: 32-bit RLE bottom-up (with an all-zero alpha that must read as opaque),
// 24-bit raw top-down, and 8-bit grey. Pixels, top row first: red red blue / white grey black,
// so a flipped image is caught and the RLE stream has a repeat run and a multi-pixel raw run.
const TGA_PX = [[255, 0, 0], [255, 0, 0], [0, 0, 255], [255, 255, 255], [128, 128, 128], [0, 0, 0]];
function tga({ bits, rle, topDown, grey = false }) {
  const w = 3, h = 2;
  const head = Buffer.alloc(18);
  head[2] = (grey ? 3 : 2) + (rle ? 8 : 0);
  head.writeUInt16LE(w, 12);
  head.writeUInt16LE(h, 14);
  head[16] = bits;
  head[17] = topDown ? 0x20 : 0;
  const rows = topDown ? [0, 1] : [1, 0];
  const px = [];
  for (const r of rows) for (let x = 0; x < w; x++) {
    const [R, G, B] = TGA_PX[r * w + x];
    px.push(grey ? [Math.round((R + G + B) / 3)] : bits === 32 ? [B, G, R, 0] : [B, G, R]);
  }
  if (!rle) return Buffer.concat([head, Buffer.from(px.flat())]);
  const out = []; // repeat runs become RLE packets, the rest raw packets
  for (let i = 0; i < px.length;) {
    let run = 1;
    while (i + run < px.length && px[i + run].join() === px[i].join()) run++;
    if (run > 1) { out.push(0x80 | (run - 1), ...px[i]); i += run; continue; }
    let raw = 1;
    while (i + raw < px.length && px[i + raw].join() !== px[i + raw - 1].join() && (i + raw + 1 >= px.length || px[i + raw + 1].join() !== px[i + raw].join())) raw++;
    out.push(raw - 1, ...px.slice(i, i + raw).flat());
    i += raw;
  }
  return Buffer.concat([head, Buffer.from(out)]);
}

try {
  await waitFor('window.__xoReady === true', 60000);
  const files = await js('window.__xo.state.files.length');
  ok(files > 50000, `game archives listed (${files} files)`);
  const support = await js('window.__xo.viewer.support');
  ok(support.s3tc && support.rgtc && support.bptc, `GPU takes BC textures directly (s3tc ${support.s3tc}, rgtc ${support.rgtc}, bptc ${support.bptc})`);
  await snap('01-start');

  // Parts list: categories and a click on the first cabin folder
  const cabins = await js(`window.__xo.state.rows.filter(r => r.type === 'folder').length`);
  ok(cabins > 50, `Cabins category lists ${cabins} part folders`);
  await js(`document.querySelector('#list .row-item').click()`);
  await idle();
  ok(await js('window.__xo.viewer.meshes.length > 0'), `clicking the first cabin opened ${await js('window.__xo.state.info.path')}`);
  // the parts are the game's cards: as many across as fit, each line right after the last (a folder
  // opened lists its models under its card's line)
  const cardBox = await js(`(() => { const L = window.__xo.state.cardLayout, c = document.querySelector('#list .card');
    return { h: c.getBoundingClientRect().height, cols: L.cols, lines: L.lines.length, tiled: L.lines.every((l, k) => k === 0 || Math.abs(l.top - (L.lines[k - 1].top + L.lines[k - 1].h + 8)) < 0.5), pics: document.querySelectorAll('#list .card').length }; })()`);
  ok(Math.abs(cardBox.h - 176) < 0.5 && cardBox.tiled && cardBox.cols >= 1, `the parts are cards like the game's: ${cardBox.cols} across, ${cardBox.h} px tall, ${cardBox.lines} lines, each right after the last`);
  // the game's look (skin.js / skin.css): its UI sprites cut out of its atlases into CSS variables,
  // the buttons and tabs drawn with them, the toolbars' game icons, the sliders filled to their handle
  const skin = await js(`(async () => {
    for (let i = 0; i < 100 && !document.documentElement.classList.contains('skin'); i++) await new Promise((r) => setTimeout(r, 100));
    const root = getComputedStyle(document.documentElement), names = ['btn', 'btn-hover', 'flat', 'tab-select', 'go', 'act', 'dialog', 'thumb', 'header', 'arrow-both-checked', 'bookmark-select'];
    const missing = names.filter((n) => !/^url\\("?blob:/.test(root.getPropertyValue('--sp-' + n).trim()));
    const btn = getComputedStyle(document.getElementById('addToBuild')).borderImageSource, tab = getComputedStyle(document.querySelector('#mainMode button.on')).borderImageSource;
    const icons = ['bUndo', 'bRedo', 'frameBtn', 'bDrive'].filter((id) => document.querySelector('#' + id + ' .gi svg')).length;
    const r = document.getElementById('fxVolume'), old = r.value; r.value = 25; const p = r.style.getPropertyValue('--p'); r.value = old;
    return { on: document.documentElement.classList.contains('skin'), missing, btn: /blob:/.test(btn), tab: /blob:/.test(tab), icons, p, font: getComputedStyle(document.querySelector('.btn')).fontFamily };
  })()`);
  ok(skin.on && !skin.missing.length && skin.btn && skin.tab, `the game's own UI sprites dress the app (buttons, the modes' hangar tabs${skin.missing.length ? '; missing: ' + skin.missing.join(', ') : ''})`);
  ok(skin.icons === 4 && skin.p === '25%' && /Segoe UI Variable/.test(skin.font), `the toolbars carry the game's icons (${skin.icons} of 4), sliders fill up to their handle (--p ${skin.p} when set from code), the game-like face`);
  // a card far down brought into view (keyboard steps, a part opened from elsewhere): centred in
  // the column, drawn (the list's height once flickered to its rows' and held the scroll short)
  const far = await js(`(() => { const rows = window.__xo.state.rows; let i = Math.floor(rows.length * 0.75); while (i > 0 && rows[i].type !== 'folder') i--;
    window.__xo.revealRow(i);
    const w = document.getElementById('listWrap'), line = window.__xo.state.cardLayout.at.get(i);
    const want = Math.min(w.scrollHeight - w.clientHeight, Math.max(0, line.top - (w.clientHeight - line.h) / 2));
    const el = document.querySelector('#list .card[data-i="' + i + '"]'), r = el?.getBoundingClientRect(), wr = w.getBoundingClientRect();
    return { i, st: w.scrollTop, want, shown: !!el && r.top >= wr.top - 1 && r.bottom <= wr.bottom + 1 }; })()`);
  ok(Math.abs(far.st - far.want) < 2 && far.shown, `a card far down is brought into view, centred (row ${far.i}: scrolled to ${Math.round(far.st)}, ${Math.round(far.want)} wanted)`);
  await js(`document.getElementById('listWrap').scrollTop = 0`);
  // the cards' pictures (the icon studio): one part at a time (two asked at once both come back,
  // each its own part, the studio empty after), lit like the game's cards (the key light above the
  // part, to the right) and graded like them (greyer than the view's colours)
  const studio = await js(`(async () => {
    const xo = window.__xo, v = xo.viewer, A = 'models/constructor/cabins/buggy_start/buggy_start.mdl', B = 'models/constructor/cabins/bug/cab_bug.mdl';
    const [a, b] = await Promise.all([A, B].map(async (p) => v.iconPicture(await xo.getInfo(p), { size: 120 })));
    v.iconLook = { grade: null };
    const plain = await v.iconPicture(await xo.getInfo(B), { size: 120 });
    v.iconLook = null;
    const sat = async (url) => { const im = new Image(); im.src = url; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
      const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < 200) continue; s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); n++; }
      return n ? s / n : 0; }; // (colourfulness: max - min, 0..255)
    const st = v.iconStudio, key = st.key.position.clone().applyMatrix4(st.cam.matrixWorldInverse);
    const left = st.scene.children.filter((o) => !o.isLight && ![st.key.target, st.fill.target, st.rim.target].includes(o)).length;
    return { a: a?.length || 0, b: b?.length || 0, differ: a !== b, left, keyX: key.x, keyY: key.y, graded: await sat(b), plain: await sat(plain) };
  })()`);
  ok(studio.a > 1000 && studio.b > 1000 && studio.differ && studio.left === 0, `two cards' pictures asked at once both come back, each its own part (the studio holds one at a time; ${studio.left} left in it)`);
  ok(studio.keyX > 0 && studio.keyY > 0, `the cards' pictures are lit like the game's: the key light above the part and to the right (${studio.keyX.toFixed(2)}, ${studio.keyY.toFixed(2)} from the camera)`);
  ok(studio.graded > 0 && studio.graded < studio.plain * 0.93, `...and graded like the game's: greyer (colourfulness ${studio.graded.toFixed(1)}, ${studio.plain.toFixed(1)} ungraded)`);

  for (const model of ['models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl', 'models/weapons/crossbow_rocket/crossbow_rocket.mdl', 'models/constructor/structure/newyear_trailer_const/newyear_trailer_lower.mdl']) {
    await js(`window.__xo.openModel(${JSON.stringify(model)})`);
    await idle();
    const st = await js(`({ meshes: window.__xo.viewer.meshes.length, tris: window.__xo.state.stats.tris, maps: window.__xo.viewer.materials.filter(m => m.map).length, normals: window.__xo.viewer.materials.filter(m => m.normalMap).length, err: document.getElementById('statusText').classList.contains('err') ? document.getElementById('statusText').textContent : '' })`);
    ok(st.meshes > 0 && st.tris > 0 && !st.err, `${path.basename(model)}: ${st.meshes} meshes, ${st.tris} tris, ${st.maps} albedo + ${st.normals} normal maps ${st.err}`);
    await snap('02-' + path.basename(model, '.mdl'));
  }

  await js(`window.__xo.openModel('models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl')`);
  await idle();
  await waitFor('window.__xo.viewer.materials.some(m => m.emissiveMap)', 20000).catch(() => {});
  ok(await js('window.__xo.viewer.materials.some(m => m.emissiveMap)'), 'glow map (_e) shown as emissive on bell_uh1_oracle');
  await js(`window.__xo.openModel('models/constructor/structure/newyear_trailer_const/newyear_trailer_lower.mdl')`);
  await idle();

  // Frame drawn with real pixels (not an empty canvas)
  const lit = await js(`(() => { const c = document.getElementById('view'); const g = c.getContext('webgl2'); const w = g.drawingBufferWidth, h = g.drawingBufferHeight; const px = new Uint8Array(4 * 64); g.readPixels(w/2 - 32, h/2, 64, 1, g.RGBA, g.UNSIGNED_BYTE, px); let n = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++; return n; })()`);
  ok(lit > 10, `model pixels drawn in the middle of the view (${lit}/64 covered)`);

  // LOD and slots
  await js(`(() => { const s = document.getElementById('lodSel'); s.value = '2'; s.dispatchEvent(new Event('change')); })()`);
  await idle();
  ok((await js('window.__xo.state.lod')) === 2, 'LOD switch to 2');
  await js(`(() => { const s = document.getElementById('optSlots'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  await snap('03-trailer-lod2-slots');
  await js(`(() => { const s = document.getElementById('optSlots'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
  ok(!(await js(`window.__xo.viewer.helpers.children.find((c) => c.name === 'slots').visible`)), 'the Weld points box hides them');
  await js(`(() => { const s = document.getElementById('optSlots'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  await js(`(() => { const s = document.getElementById('lodSel'); s.value = '0'; s.dispatchEvent(new Event('change')); })()`);
  await idle();

  // Colour edit on the first albedo, shows in the view
  const base = await js(`window.__xo.state.info.materials[0].textures.find(t => t.role === 'albedo').base`);
  const glossBase = await js(`window.__xo.state.info.materials[0].textures.find(t => t.role === 'gloss' && t.exists)?.base || ''`);
  await js(`document.querySelector('.tex[data-role="albedo"] [data-act="adjust"]').click()`);
  await js(`(() => { const b = document.querySelector('.adjust button[data-paint="#2f4f6f"]'); b.click(); const h = document.querySelector('.adjust [data-adj="hue"]'); h.value = 40; h.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const adj = await js(`window.__xo.state.adjust[${JSON.stringify(base)}]`);
  ok(adj && adj.paintAmount > 0 && adj.hue === 40, `colour edit stored for ${base.split('/').pop()} (hue ${adj?.hue}, paint ${adj?.paintAmount})`);
  await snap('04-trailer-painted');

  // Export through the real bridge (test mode passes the path instead of the save dialog)
  const glb = path.join(outDir, 'trailer.glb');
  const res = await js(`window.__xo.call('export', { path: window.__xo.state.info.path, format: 'glb', lod: 0, skin: '', textures: true, slots: true, adjust: window.__xo.state.adjust, replace: {}, outPath: ${JSON.stringify(glb)} })`);
  ok(fs.existsSync(glb) && res.files.length >= 1, `export wrote ${res.files.length} file(s), ${fs.statSync(glb).size} bytes`);
  const v = validate(glb);
  ok(v.startsWith('ok'), 'exported GLB validates: ' + v);
  const glbJson = JSON.parse(fs.readFileSync(glb).subarray(20, 20 + fs.readFileSync(glb).readUInt32LE(12)).toString());
  ok(glbJson.images.some((i) => i.name.includes('_custom')), 'the edited albedo went into the GLB as *_custom.png');
  const tRoot = glbJson.nodes[glbJson.scenes[0].nodes[0]], tKids = (tRoot.children || []).map((k) => glbJson.nodes[k].name);
  ok(tKids.includes('slots') && !/\.\d{3}$/.test(tRoot.name) && tKids.every((n) => !/\.\d{3}$/.test(n)),
    `with weld points asked for, they come in a "slots" group under "${tRoot.name}" (${tKids.join(', ')}), no ".001" names`);

  // Paint on a PNG save only goes where the paint mask says (no other colour change)
  if (glossBase) {
    const paintOnly = { hue: 0, saturation: 1, brightness: 0, contrast: 1, tint: [1, 1, 1], tintAmount: 0, paint: [0.18, 0.31, 0.44], paintAmount: 1 };
    const painted = path.join(outDir, 'painted_albedo.png');
    await call('exportTexture', { base, as: 'png', view: 'rgb', adjust: paintOnly, mask: glossBase, outPath: painted });
    const imp = await call('importImage', { file: painted });
    const m = await js(`(async () => {
      const get = async (q) => { const b = new Uint8Array(await (await fetch('https://xo.data/rgba?' + q)).arrayBuffer()); const d = new DataView(b.buffer); return { w: d.getUint32(4, true), h: d.getUint32(8, true), px: b.subarray(12) }; };
      const [a, p, g] = await Promise.all([get('base=' + encodeURIComponent(${JSON.stringify(base)})), get('image=${imp.id}'), get('base=' + encodeURIComponent(${JSON.stringify(glossBase)}))]);
      let off = 0, offN = 0, on = 0, onN = 0;
      for (let y = 0; y < a.h; y += 3) for (let x = 0; x < a.w; x += 3) {
        const mx = Math.min(g.w - 1, Math.floor((x + 0.5) * g.w / a.w)), my = Math.min(g.h - 1, Math.floor((y + 0.5) * g.h / a.h));
        const mask = g.px[(my * g.w + mx) * 4];
        const i = (y * a.w + x) * 4;
        const d = Math.abs(a.px[i] - p.px[i]) + Math.abs(a.px[i + 1] - p.px[i + 1]) + Math.abs(a.px[i + 2] - p.px[i + 2]);
        if (mask === 0) { off += d; offN++; } else if (mask === 255) { on += d; onN++; }
      }
      return { off: off / Math.max(1, offN), offN, on: on / Math.max(1, onN), onN, same: a.w === p.w && a.h === p.h };
    })()`);
    ok(m.same && m.offN > 100 && m.onN > 100 && m.off < 3 && m.on > 20, `PNG save paints only inside the paint mask (outside Δ ${m.off.toFixed(2)} over ${m.offN} px, inside Δ ${m.on.toFixed(1)} over ${m.onN} px)`);
    await call('releaseImage', { id: imp.id });
  } else ok(false, 'trailer material 0 has no gloss map to test the paint mask with');

  const objPath = path.join(outDir, 'bell.obj');
  await js(`window.__xo.openModel('models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl')`);
  await idle();
  const r2 = await js(`window.__xo.call('export', { path: window.__xo.state.info.path, format: 'obj', lod: 0, textures: true, outPath: ${JSON.stringify(objPath)} })`);
  const mtl = fs.readFileSync(path.join(outDir, 'bell.mtl'), 'utf8');
  const maps = [...mtl.matchAll(/^map_\w+ (?:-bm 1 )?(.+)$/gm)].map((x) => x[1]);
  ok(fs.existsSync(objPath) && maps.length > 0 && maps.every((m) => m.startsWith('bell_textures/') && fs.existsSync(path.join(outDir, m))),
    `OBJ export (${r2.files.length} files; ${maps.length} texture references, all in bell_textures/ and present)`);
  const bumps = [...mtl.matchAll(/^map_Bump -bm 1 (.+)$/gm)].map((x) => x[1]), specBumps = [...mtl.matchAll(/^bump (.+)$/gm)].map((x) => x[1]);
  ok(bumps.length > 0 && bumps.join('|') === specBumps.join('|'), `OBJ normal maps named both ways: map_Bump (Blender) and bump (Cinema 4D) (${bumps.length} each)`);

  // glTF with separate files under a name with spaces and Cyrillic: companion files get ASCII names
  const uniName = path.join(outDir, 'Танк Leo.gltf');
  const r3 = await call('export', { path: 'models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl', format: 'gltf', lod: 0, textures: true, outPath: uniName });
  const gj = JSON.parse(fs.readFileSync(uniName, 'utf8'));
  const ascii = (s) => /^[\x21-\x7e]+$/.test(s);
  const refs = [gj.buffers[0].uri, ...gj.images.map((i) => i.uri)];
  ok(refs.every(ascii) && refs.every((u) => fs.existsSync(path.join(outDir, u))) && /^Leo_[0-9a-f]{8}_textures\//.test(gj.images[0].uri),
    `glTF named "Танк Leo" writes ${refs.length} ASCII-named companions (${gj.buffers[0].uri}, ${path.dirname(gj.images[0].uri)}/)`);
  ok(validate(uniName).startsWith('ok'), 'that glTF validates: ' + validate(uniName));
  ok(r3.files.length === refs.length + 1, `export reports every file it wrote (${r3.files.length})`);
  // the baked ambient occlusion goes into the material only when asked (Cinema 4D darkens the whole part by it)
  const aoFile = path.join(outDir, 'ao_on.gltf');
  await call('export', { path: 'models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl', format: 'gltf', lod: 0, textures: true, maxTex: 256, ao: true, outPath: aoFile });
  const withAo = JSON.parse(fs.readFileSync(aoFile, 'utf8')).materials.filter((m) => m.occlusionTexture).length;
  const without = gj.materials.filter((m) => m.occlusionTexture).length;
  ok(without === 0 && withAo > 0, `ambient occlusion stays out of the materials by default (${without}), in when ticked (${withAo} material(s))`);
  // one UV set: no exported texture reads the model's second, and Cinema 4D maps every texture through the last one
  const uvFile = path.join(outDir, 'uv_sets.gltf');
  await call('export', { path: 'models/constructor/cabins/raider_cab1/raider_cab1.mdl', format: 'gltf', lod: 0, textures: false, outPath: uvFile });
  const uvPrims = JSON.parse(fs.readFileSync(uvFile, 'utf8')).meshes.flatMap((m) => m.primitives);
  ok(uvPrims.length > 0 && uvPrims.every((p) => p.attributes.TEXCOORD_0 !== undefined && p.attributes.TEXCOORD_1 === undefined),
    `a part goes out with one UV set (${uvPrims.length} primitive(s), none with TEXCOORD_1)`);
  // one mesh per material by default (Cinema 4D drops a mesh with several materials and normals), one mesh when unticked
  const twoMat = 'models/constructor/cabins/bulldozer/bulldozer.mdl';
  const splitFile = path.join(outDir, 'split_on.gltf'), wholeFile = path.join(outDir, 'split_off.gltf');
  await call('export', { path: twoMat, format: 'gltf', lod: 0, textures: false, outPath: splitFile });
  await call('export', { path: twoMat, format: 'gltf', lod: 0, textures: false, split: false, outPath: wholeFile });
  const sj = JSON.parse(fs.readFileSync(splitFile, 'utf8')), wj = JSON.parse(fs.readFileSync(wholeFile, 'utf8'));
  const top = sj.nodes[sj.scenes[0].nodes[0]];
  const kidsDraw = (top.children || []).map((k) => sj.nodes[k]).filter((n) => n.mesh !== undefined);
  ok(sj.meshes.length >= 2 && sj.meshes.every((m) => m.primitives.length === 1) && top.mesh === undefined && kidsDraw.length === sj.meshes.length &&
    new Set(sj.meshes.map((m) => m.primitives[0].material)).size === sj.meshes.length && validate(splitFile).startsWith('ok'),
    `a part with ${sj.meshes.length} materials goes out as ${sj.meshes.length} meshes under "${top.name}" (${kidsDraw.map((n) => n.name).join(', ')}), valid`);
  ok(wj.meshes.length === 1 && wj.meshes[0].primitives.length === sj.meshes.length, `unticked: one mesh with ${wj.meshes[0]?.primitives.length} materials`);

  // Texture tools: PNG + DDS of a normal map, and the preview's channel views
  const nbase = await js(`window.__xo.state.info.materials[0].textures.find(t => t.role === 'normal').base`);
  const npng = path.join(outDir, 'normal.png'), ndds = path.join(outDir, 'normal.dds');
  await call('exportTexture', { base: nbase, as: 'png', view: 'normal', outPath: npng });
  await call('exportTexture', { base: nbase, as: 'dds', outPath: ndds });
  ok(fs.readFileSync(npng).subarray(1, 4).toString() === 'PNG' && fs.readFileSync(ndds).subarray(0, 4).toString() === 'DDS ', 'normal map saved as PNG and DDS');
  const alphaPng = path.join(outDir, 'Текстура alpha.png');
  await call('exportTexture', { base: nbase, as: 'png', view: 'alpha', outPath: alphaPng });
  const aimp = await call('importImage', { file: alphaPng });
  const apx = await js(`(async () => { const b = new Uint8Array(await (await fetch('https://xo.data/rgba?image=${aimp.id}')).arrayBuffer()); let grey = true, opaque = true; for (let i = 12; i < b.length; i += 4) { if (b[i] !== b[i + 1] || b[i] !== b[i + 2]) grey = false; if (b[i + 3] !== 255) opaque = false; } return { grey, opaque }; })()`);
  ok(apx.grey && apx.opaque, `saving the "alpha" view writes that channel as grey (non-ASCII file name too)`);

  // Replacement images: PNG, DDS in every block format the game uses, TGA; release frees them
  const imp = await call('importImage', { file: npng });
  ok(imp && imp.id && imp.w > 0, `image import (${imp.w}x${imp.h})`);
  const ddsCases = [['BC3 (the normal map)', nbase], ['BC7 sRGB', 'assets/skies/wintershine_rk/wintershine02_anim'], ['BC5', 'assets/props/trees/stalker/pine/pine_bark_small_n'], ['BC4', 'assets/props/trees/arizona/beardtongue/beardtongue_at'], ['BC1', 'assets/props/base/lloyd_base/module_g']];
  for (const [label, b] of ddsCases) {
    const f = path.join(outDir, 'rt_' + b.split('/').pop() + '.dds');
    await call('exportTexture', { base: b, as: 'dds', outPath: f });
    const di = await call('importImage', { file: f }).catch((e) => ({ error: e.message }));
    const diff = di.id ? await rgbaDiff(`base=${encodeURIComponent(b)}`, `image=${di.id}`) : -2;
    ok(diff === 0, `DDS ${label} saved and imported back pixel-identical${di.error ? ': ' + di.error : diff ? ` (${diff} bytes differ)` : ''}`);
    if (di.id) await call('releaseImage', { id: di.id });
  }
  const want = TGA_PX.flatMap(([r, g, b]) => [r, g, b, 255]);
  for (const [label, opts] of [['32-bit RLE bottom-up', { bits: 32, rle: true, topDown: false }], ['24-bit raw top-down', { bits: 24, rle: false, topDown: true }], ['8-bit grey', { bits: 8, rle: false, topDown: false, grey: true }]]) {
    const f = path.join(outDir, `test_${opts.bits}.tga`);
    fs.writeFileSync(f, tga(opts));
    const ti = await call('importImage', { file: f }).catch((e) => ({ error: e.message }));
    const px = ti.id ? (await rgbaOf(`image=${ti.id}`)).px : [];
    const expect = opts.grey ? TGA_PX.flatMap(([r, g, b]) => { const v = Math.round((r + g + b) / 3); return [v, v, v, 255]; }) : want;
    ok(ti.w === 3 && ti.h === 2 && px.join() === expect.join(), `TGA ${label} imports with the right pixels${ti.error ? ': ' + ti.error : ''}`);
  }
  await call('releaseImage', { id: imp.id });
  const gone = await js(`fetch('https://xo.data/png?image=${imp.id}').then(r => r.status)`);
  ok(gone === 404, `a released image is freed (${gone})`);

  // Looks: colour edits + a replaced texture saved to a .xolook, removed, and opened again
  const albBase = await js(`window.__xo.state.info.materials[0].textures.find(t => t.role === 'albedo').base`);
  await js(`(async () => { const r = await window.__xo.call('importImage', { file: ${JSON.stringify(npng)} }); window.__xo.state.replace[${JSON.stringify(nbase)}] = { id: r.id, file: r.file, name: r.name, w: r.w, h: r.h }; await window.__xo.viewer.setReplacement(${JSON.stringify(nbase)}, { id: r.id }); })()`);
  await js(`(() => { const a = { hue: 25, saturation: 1.2, brightness: 0, contrast: 1, tint: [1, 1, 1], tintAmount: 0, paint: [0.5, 0.1, 0.1], paintAmount: 0.5 }; window.__xo.state.adjust[${JSON.stringify(albBase)}] = a; window.__xo.viewer.setAdjust(${JSON.stringify(albBase)}, a); })()`);
  const lookPath = path.join(outDir, 'bell look.xolook');
  await js(`window.__xo.call('saveText', { text: JSON.stringify(window.__xo.lookFile()), ext: 'xolook', outPath: ${JSON.stringify(lookPath)} })`);
  // (a hidden window cannot answer a confirmation: the test does, and notes what was asked)
  await js(`(() => { window.__confirms = []; window.confirm = (m) => (window.__confirms.push(m), true); })()`);
  await js(`document.getElementById('lookReset').click()`);
  await sleep(200);
  const cleared = await js(`Object.keys(window.__xo.state.adjust).length + Object.keys(window.__xo.state.replace).length`);
  const askedReset = await js(`window.__confirms.length`);
  ok(askedReset === 1 && cleared === 0, `Reset all asks first (it takes the part's paint and the build's colour edits too), then removes every edit`);
  const opened = await js(`(async () => { const r = await window.__xo.call('openText', { ext: 'xolook', file: ${JSON.stringify(lookPath)} }); return window.__xo.applyLook(JSON.parse(r.text)); })()`);
  await idle();
  const lk = await js(`({ hue: window.__xo.state.adjust[${JSON.stringify(albBase)}]?.hue, rep: window.__xo.state.replace[${JSON.stringify(nbase)}]?.file, id: window.__xo.state.replace[${JSON.stringify(nbase)}]?.id })`);
  ok(cleared === 0 && opened.missing.length === 0 && lk.hue === 25 && lk.rep === npng && lk.id, `a look saves and reopens colour edits and replaced textures (hue ${lk.hue}, ${path.basename(lk.rep || '?')})`);
  const lkPx = lk.id ? await rgbaDiff(`image=${lk.id}`, `image=${lk.id}`) : -1;
  ok(lkPx === 0, 'the reopened look re-imported the image from disk');
  await js(`document.getElementById('lookReset').click()`);

  // Paint (paints.js): the game's paints from the Paint card's picker, on the part and baked into its export
  const pcat = await js(`(() => { const c = window.__xo.paints.catalog(); return { p: c.patterns.length, c: c.chameleons.length, test: [...c.patterns, ...c.chameleons].some((i) => /^(test\d*|pbr_test|dye_test|delete_after|td_512px|checker_alpha|checker_direction)/.test(i.stem)) }; })()`);
  ok(pcat.p > 250 && pcat.c >= 40 && !pcat.test, `the game's paints: ${pcat.p} patterns and ${pcat.c} chameleon paints, its developers' test textures left out`);
  await js(`document.querySelector('#vPaintPicker .pp-tabs [data-tab="pattern"]').click()`);
  await js(`(() => { const s = document.querySelector('#vPaintPicker .pp-search'); s.value = 'camouflage 01'; s.dispatchEvent(new Event('input')); })()`);
  const tile = await js(`(() => { const b = document.querySelector('#vPaintPicker .pp-grid [data-pick="pattern"]'); if (!b) return null; b.click(); return b.dataset.tex; })()`);
  await idle();
  const vp = await js(`({ paint: window.__xo.paints.view(), drawn: window.__xo.viewer.materials.filter((m) => m.defines.XO_PAINT_PATTERN !== undefined).length, name: document.querySelector('#vPaintPicker .pp-name').textContent, lit: !!document.querySelector('#vPaintPicker .pp-grid button.on') })`);
  ok(tile === 'textures/patterns/camouflage01' && vp.paint?.tex === tile && vp.drawn > 0 && vp.lit, `a pattern picked in the Paint card goes on the part ("${vp.name}": ${vp.drawn} material(s) draw it, its tile lit)`);
  await snap('06-painted-camo');
  const pGlb = path.join(outDir, 'painted part.glb');
  await js(`window.__xo.call('export', { ...window.__xo.exportArgs(), format: 'glb', outPath: ${JSON.stringify(pGlb)} })`);
  const pdoc = JSON.parse(fs.readFileSync(pGlb).subarray(20, 20 + fs.readFileSync(pGlb).readUInt32LE(12)).toString());
  ok(pdoc.images.some((i) => /_camouflage01(\.png)?$/.test(i.name)) && validate(pGlb).startsWith('ok'), `the export bakes the pattern into the albedo (${pdoc.images.map((i) => i.name).filter((n) => /camouflage/.test(n)).join(', ')})`);
  const lookPaint = await js('window.__xo.lookFile().paint');
  await js(`window.__xo.paints.setView({ kind: 'chameleon', tex: 'textures/patterns/cham_blackblue', color: [1, 1, 1], amount: 1 })`);
  const cham = await js(`window.__xo.viewer.materials.filter((m) => m.defines.XO_PAINT_CHAM !== undefined).length`);
  await js(`document.getElementById('vPaintOff').click()`);
  const offDraw = await js(`window.__xo.viewer.materials.filter((m) => Object.keys(m.defines).some((k) => k.startsWith('XO_PAINT'))).length`);
  ok(lookPaint?.tex === tile && cham > 0 && offDraw === 0 && !(await js('window.__xo.paints.view()')), `a look keeps the paint; a chameleon paint draws by the view angle (${cham}); Remove paint takes it off`);
  const gameNames = await js(`(() => { const c = window.__xo.paints.catalog(), by = (s) => c.patterns.find((p) => p.stem === s)?.name; return { lava: by('lava_skin01'), dusk: by('stress_test01'), named: c.patterns.filter((p) => p.game).length }; })()`);
  ok(gameNames.lava === 'Pattern: Lava' && gameNames.dusk === 'Pattern: Graffiti Dusk' && gameNames.named >= 40, `the paints the game's text names go by those names (${gameNames.named}: "${gameNames.lava}", "${gameNames.dusk}")`);
  // a finish: the painted surface shines as metal, in the view and in the export's roughness / metal image; glass takes no paint
  await js(`document.querySelector('#vPaintPicker .pp-tabs [data-tab="color"]').click()`);
  await js(`document.querySelector('#vPaintPicker .pp-mats [data-pick="material"]').click()`); // (Chrome)
  const fin = await js(`({ paint: window.__xo.paints.view(), drawn: window.__xo.viewer.materials.filter((m) => m.defines?.XO_PAINT_FINISH !== undefined).length, glass: window.__xo.viewer.materials.filter((m) => m.userData.xo.noPaint && m.defines && Object.keys(m.defines).some((k) => k.startsWith('XO_PAINT'))).length, label: document.querySelector('#vPaintPicker .pp-name').textContent })`);
  const fGlb = path.join(outDir, 'chrome part.glb');
  await js(`window.__xo.call('export', { ...window.__xo.exportArgs(), format: 'glb', outPath: ${JSON.stringify(fGlb)} })`);
  const fdoc = JSON.parse(fs.readFileSync(fGlb).subarray(20, 20 + fs.readFileSync(fGlb).readUInt32LE(12)).toString());
  ok(fin.paint?.finish === 'chrome' && fin.label === 'Chrome' && fin.drawn > 0 && fin.glass === 0 && fdoc.images.some((i) => /_paint_orm(\.png)?$/.test(i.name)),
    `the Chrome material shines as metal in the view (${fin.drawn} material(s)) and in the export's roughness / metal image; glass takes no paint`);
  await js(`document.getElementById('vPaintOff').click()`);

  // Screenshot of the view
  const shotPath = path.join(outDir, 'view.png');
  await js(`window.__xo.call('saveScreenshot', { dataUrl: window.__xo.viewer.screenshot(), name: 'view', outPath: ${JSON.stringify(shotPath)} })`);
  ok(fs.existsSync(shotPath) && fs.readFileSync(shotPath).subarray(1, 4).toString() === 'PNG' && fs.statSync(shotPath).size > 10000, `screenshot saved (${fs.existsSync(shotPath) ? fs.statSync(shotPath).size : 0} bytes)`);

  // Skins
  await js(`window.__xo.openModel('models/constructor/structure/big_trucks/m_bumper1.mdl')`);
  await idle();
  const skins = await js(`window.__xo.state.info.skins.map(s => s.name)`);
  ok(skins.length > 1, `skins listed: ${skins.join(', ')}`);
  if (skins.length > 1) {
    await js(`(() => { const s = document.getElementById('skinSel'); s.value = ${JSON.stringify(skins[1])}; s.dispatchEvent(new Event('change')); })()`);
    await idle();
    ok((await js('window.__xo.state.skin')) === skins[1], `skin switch to ${skins[1]}`);
    await snap('05-bumper-skin');
  }

  // The parts menu, as the game's garage draws it: its order and names, its own icons; a category
  // opens its kinds (Weapons: machine guns, shotguns ...), a kind shows that kind alone, the arrow
  // shuts them (the row then says the kind); frames sit in Base with the cabins
  const menu = await js(`(async () => {
    const xo = window.__xo, $c = (c) => document.querySelector('#cats button[data-cat="' + c + '"]'), wait = (t) => new Promise((r) => setTimeout(r, t));
    for (let i = 0; i < 40 && [...document.querySelectorAll('#cats .gi')].some((g) => !g.querySelector('svg')); i++) await wait(100);
    const out = { rows: [...document.querySelectorAll('#cats .cat-row .lbl')].map((l) => l.textContent), icons: [...document.querySelectorAll('#cats .gi svg')].length };
    $c('Weapons').click(); await wait(100);
    out.kinds = [...document.querySelectorAll('#cats .sub .lbl')].map((l) => l.textContent);
    const all = xo.state.rows.filter((r) => r.type === 'folder').length;
    [...document.querySelectorAll('#cats .sub')].find((b) => b.dataset.sub === 'Shotguns').click(); await wait(100);
    out.shotguns = xo.state.rows.filter((r) => r.type === 'folder').length; out.all = all;
    document.querySelector('#cats [data-more="Weapons"]').click(); await wait(100);
    out.shut = !document.querySelector('#cats .sub') && /Shotguns/.test(document.querySelector('#cats .cat-row.on').textContent);
    $c('Cabins').click(); await wait(100);
    out.base = [...document.querySelectorAll('#cats .sub .lbl')].map((l) => l.textContent);
    out.frames = xo.state.rows.some((r) => r.type === 'folder' && r.f.dir.startsWith('models/constructor/chassis/base/'));
    return out; })()`);
  ok(menu.rows.join() === 'All,Base,Weapons,Hardware,Movement parts,Structure,Decor,Gameplay,Other,Map props' && menu.icons === 10,
    `the parts menu is the game's: ${menu.rows.slice(0, 7).join(', ')} (then Gameplay, Other, Map props), each with the game's own icon (${menu.icons})`);
  ok(menu.kinds.includes('Machine guns') && menu.kinds.includes('Shotguns') && menu.shotguns > 5 && menu.shotguns < menu.all && menu.shut,
    `a category opens its kinds (Weapons: ${menu.kinds.length}, ${menu.kinds.slice(0, 4).join(', ')} ...); a kind shows it alone (${menu.shotguns} of ${menu.all} weapon folders); the arrow shuts them, the row naming the kind`);
  ok(menu.base.join() === 'Light cabins,Medium cabins,Heavy cabins,Frames,Other cabins' && menu.frames, `Base holds the cabins by weight and the frames, as the game's does`);

  // Search opens matching folders; clicking an open one closes it even while searching
  await js(`(() => { const s = document.getElementById('search'); s.value = 'harvester'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  const hits = await js(`window.__xo.state.rows.length`);
  await js(`document.querySelector('.cats button[data-cat="All"]').click()`);
  await sleep(200);
  const hitsAll = await js(`window.__xo.state.rows.filter(r => r.type === 'model').length`);
  ok(hitsAll > 0, `search "harvester" finds ${hitsAll} models (${hits} rows in Cabins)`);
  const beforeRows = await js(`window.__xo.state.rows.length`);
  await js(`(() => { const i = window.__xo.state.rows.findIndex(r => r.type === 'folder' && r.open); document.querySelector('#list .row-item[data-i="' + i + '"]').click(); })()`);
  await sleep(150);
  const afterRows = await js(`window.__xo.state.rows.length`);
  ok(afterRows < beforeRows, `an open search result folder collapses on click (${beforeRows} -> ${afterRows} rows)`);
  await snap('06-search');

  // All-files mode: selecting a plain file keeps the open model; extract (and refuse odd paths)
  await js(`window.__xo.openModel('models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl')`);
  await idle();
  await js(`document.querySelector('.modes button[data-mode="files"]').click()`);
  await js(`(() => { const s = document.getElementById('search'); s.value = 'bell_uh1_oracle.mdf'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  await js(`document.querySelector('#list .row-item .name').click()`);
  await sleep(100);
  const sel = await js(`({ selected: window.__xo.state.selected, fileSel: window.__xo.state.fileSel })`);
  ok(sel.selected.endsWith('.mdl') && sel.fileSel?.endsWith('.mdf'), `clicking a file row highlights it without replacing the open model (${sel.fileSel})`);
  await js(`(() => { const s = document.getElementById('lodSel'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
  await idle();
  ok((await js('window.__xo.state.lod')) === 1 && (await js('window.__xo.state.info.path')).endsWith('.mdl'), 'the LOD menu still works after selecting a plain file');
  await js(`(() => { const s = document.getElementById('search'); s.value = 'kpvt.model'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  const ex = await js(`window.__xo.call('extract', { paths: window.__xo.state.filesView.map(f => f.name), dir: ${JSON.stringify(path.join(outDir, 'raw'))} })`);
  ok(ex.written >= 1 && fs.existsSync(path.join(outDir, 'raw', 'models', 'blendertut', 'kpvt.model')), `raw extract (${ex.written} file)`);
  const bad = await call('extract', { paths: ['../escape.txt', 'c:/windows/x', 'models/../../x'], dir: path.join(outDir, 'raw2') });
  ok(bad.written === 0 && bad.errors.length === 3 && !fs.existsSync(path.join(outDir, 'escape.txt')), 'extract refuses paths that would leave the chosen folder');
  await js(`(() => { const s = document.getElementById('search'); s.value = 'bell_uh1'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  await snap('07-files');

  // Texture viewer on a normal map, shown as a rebuilt RGB normal map
  await js(`document.querySelector('.modes button[data-mode="parts"]').click()`);
  await js(`window.__xo.openModel('models/constructor/cabins/bell_uh1_oracle/bell_uh1_oracle.mdl')`);
  await idle();
  await js(`document.querySelector('.tex[data-role="normal"] .thumb').click()`);
  await waitFor(`!document.getElementById('texPreview').hidden && document.getElementById('texImg').complete && document.getElementById('texImg').naturalWidth > 0`, 30000);
  ok(await js(`document.getElementById('texImg').naturalWidth >= 1024`), `texture viewer shows the normal map (${await js(`document.getElementById('texImg').naturalWidth`)} px wide)`);
  await snap('08-texture-viewer');
  await js(`document.getElementById('texClose').click()`);

  // Transparency: nets / grates are cut out, glass is blended, and exports say so too
  const BUGGY = 'models/constructor/cabins/buggy_start/buggy_start.mdl', GLASSCAB = 'models/constructor/cabins/engineers_cab2/engineers_cab2.mdl';
  await js(`window.__xo.openModel(${JSON.stringify(BUGGY)})`);
  await idle();
  ok(await js('window.__xo.viewer.materials.some(m => m.alphaTest === 0.5 && m.map)'), "the starter buggy's nets and grating are cut out (alpha test)");
  // render the side view with and without the cut-outs; pixels that change are where you now see through
  const seeThrough = await js(`(() => { const v = window.__xo.viewer, g = document.getElementById('view').getContext('webgl2');
    const b = v.part.userData.box, ctr = b.getCenter(b.min.clone()), s = b.getSize(b.min.clone()).length();
    v.controls.target.copy(ctr); v.camera.position.set(ctr.x + s * 1.2, ctr.y + s * 0.05, ctr.z); v.controls.update();
    const grab = () => { v.renderer.render(v.scene, v.camera); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
    const cut = grab();
    const saved = v.materials.map(m => [m.alphaTest, m.alphaToCoverage]); // (alpha to coverage: the cut-outs' soft edges)
    v.materials.forEach(m => { m.alphaTest = 0; m.alphaToCoverage = false; m.needsUpdate = true; });
    const solid = grab();
    v.materials.forEach((m, i) => { [m.alphaTest, m.alphaToCoverage] = saved[i]; m.needsUpdate = true; });
    v.dirty = true;
    let n = 0, total = 0; for (let i = 0; i < cut.length; i += 4) { if (solid[i + 3]) total++; if (Math.abs(cut[i] - solid[i]) + Math.abs(cut[i + 1] - solid[i + 1]) + Math.abs(cut[i + 2] - solid[i + 2]) + Math.abs(cut[i + 3] - solid[i + 3]) > 30) n++; }
    return { n, total }; })()`);
  ok(seeThrough.n > 0.03 * seeThrough.total, `you can see through the nets: ${seeThrough.n} of ${seeThrough.total} model pixels change when the cut-outs are on`);
  await js(`window.__xo.openModel(${JSON.stringify(GLASSCAB)})`);
  await idle();
  ok(await js('window.__xo.state.info.materials.some(m => m.blend) && window.__xo.viewer.materials.some(m => m.transparent && !m.depthWrite && m.map)'), 'cabin glass is see-through (blended)');
  const tGlb = path.join(outDir, 'transparency.glb');
  await call('exportBuild', { parts: [{ path: BUGGY, skin: '', name: 'buggy', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, { path: GLASSCAB, skin: '', name: 'cab', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1] }], name: 'transparency', format: 'glb', lod: 0, textures: true, outPath: tGlb });
  const tDoc = JSON.parse(fs.readFileSync(tGlb).subarray(20, 20 + fs.readFileSync(tGlb).readUInt32LE(12)).toString());
  const modes = tDoc.materials.map((m) => m.alphaMode || 'OPAQUE');
  ok(modes.includes('MASK') && modes.includes('BLEND') && validate(tGlb).startsWith('ok'), `exported materials keep it: ${modes.join(', ')}`);

  // Game folder: re-reading runs in the background (the page keeps getting answers), a bad folder
  // keeps the loaded data
  const t0 = Date.now();
  const reload = js(`window.__xo.call('reload', {})`);
  await sleep(30);
  const t1 = Date.now();
  await call('setSettings', {});
  const answered = Date.now() - t1;
  const rr = await reload;
  const took = Date.now() - t0;
  ok(rr.ok && rr.changed && rr.files === files, `reload re-reads the archives (${took} ms) while the page still gets answers (${answered} ms)`);
  const badPick = await call('pickGameDir', { dir: outDir });
  ok(badPick.ok && badPick.changed === false && /no crossout game data/i.test(badPick.error) && badPick.files === files, `picking a folder without game data keeps the loaded data ("${badPick.error.slice(0, 50)}…")`);
  await js(`window.__xo.openModel('models/weapons/crossbow_rocket/crossbow_rocket.mdl')`);
  await idle();
  ok(await js('window.__xo.viewer.meshes.length > 0'), 'models still open after that');

  // Animations: the game's clips drive the part's bones (turret yaw / gun pitch / firing / wheel steer)
  const renderDiff = (fn) => js(`(async () => { const v = window.__xo.viewer, g = document.getElementById('view').getContext('webgl2');
    const grab = () => { v.scene.updateMatrixWorld(true); v.render(); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
    const a = grab(); ${fn}; const b = grab();
    let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]) > 40) n++;
    return n; })()`);
  await js(`window.__xo.openModel('models/weapons/minigun_explosive/minigun_explosive.mdl')`);
  await idle();
  await waitFor('!!window.__xo.state.animator', 10000).catch(() => {});
  const an = await js(`(() => { const a = window.__xo.state.animator; return a ? { acts: a.activities().map(l => l.activity), poses: a.poses().map(p => p.name), card: !document.getElementById('animCard').hidden, options: document.getElementById('animSel').options.length, sliders: document.querySelectorAll('#animPoses [data-pose]').length } : null; })()`);
  ok(an && an.card && an.acts.includes('FIRE') && an.poses.includes('AimYaw') && an.poses.includes('AimPitch') && an.sliders === 2,
    `minigun animations listed (${an ? an.acts.join(', ') + ' + sliders ' + an.poses.join(', ') : 'none'})`);
  const yawPx = await renderDiff(`window.__xo.state.animator.setPose('AimYaw', 90)`);
  ok(yawPx > 2000, `turning the turret (AimYaw 90) moves it on screen (${yawPx} pixels change)`);
  const barrel = await js(`(() => { const a = window.__xo.state.animator; a.playing = false; a.setActive('fire'); const b = a.skel.bones[a.boneOf.get('barrel')]; const q0 = b.quaternion.clone(); a.time = 0.1; a.apply(); return 2 * Math.acos(Math.min(1, Math.abs(q0.dot(b.quaternion)))) * 180 / Math.PI; })()`);
  ok(barrel > 10, `firing spins the barrels (${barrel.toFixed(0)}° after 0.1 s)`);
  { // Pose sliders take the .model's range even when it is declared high to low (AimPitch 60 -29 on
    // 194 of the game's 256 pitch layers): the slider runs low to high from 0 and moving it (the input
    // event a drag fires) turns the gun; the slider used to be stuck at -29
    await js(`window.__xo.openModel('models/weapons/machinegun_browning/machinegun_browning.mdl')`);
    await idle();
    await waitFor(`!!window.__xo.state.animator && !!document.querySelector('#animPoses [data-pose="AimPitch"]')`, 10000).catch(() => {});
    const sl = await js(`(() => { const el = document.querySelector('#animPoses [data-pose="AimPitch"]'); return el ? { min: +el.min, max: +el.max, value: +el.value, step: +el.step } : null; })()`);
    const pitchAt = (v) => js(`(() => { const el = document.querySelector('#animPoses [data-pose="AimPitch"]'); el.value = ${v}; el.dispatchEvent(new Event('input', { bubbles: true }));
      const a = window.__xo.state.animator, i = a.boneOf.get('joint3'), b = a.skel.bones[i], r = a.skel.rest[i].q;
      return { value: +el.value, angle: 2 * Math.acos(Math.min(1, Math.abs(r.dot(b.quaternion)))) * 180 / Math.PI, shown: el.nextElementSibling.textContent }; })()`);
    const up = await pitchAt(60), down = await pitchAt(-29), level = await pitchAt(0);
    ok(sl && sl.min === -29 && sl.max === 60 && sl.value === 0 && up.value === 60 && Math.abs(up.angle - 60) < 2 && Math.abs(down.angle - 29) < 2 && level.angle < 1,
      `the Aim pitch slider works on a range declared high to low (Browning, AimPitch 60 -29): slider ${sl?.min}..${sl?.max} starting at ${sl?.value}; up to ${up.shown} turns the gun ${up.angle.toFixed(0)}°, down to ${down.shown} ${down.angle.toFixed(0)}°, level at 0`);
    await js(`window.__xo.openModel('models/weapons/minigun_explosive/minigun_explosive.mdl')`); // (the checks below work on the minigun)
    await idle();
    await waitFor(`!!window.__xo.state.animator && window.__xo.state.info.path.endsWith('minigun_explosive.mdl')`, 10000).catch(() => {});
  }
  // Animated export: the skeleton and every clip as glTF animations. Each bone of the exported file,
  // posed by one of its animations, must sit where the viewer puts it playing that clip alone.
  const viewerPose = (setup) => js(`(() => { const a = window.__xo.state.animator, { bones, rest, root } = a.skel;
    bones.forEach((b, i) => { b.position.copy(rest[i].p); b.quaternion.copy(rest[i].q); });
    ${setup};
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert(), out = bones.map((b) => inv.clone().multiply(b.matrixWorld).toArray());
    a.apply(); return out; })()`);
  const comparePose = (gl, name, t, page) => {
    const world = poseAt(gl, name, t), rest = poseAt(gl, null, 0), joints = gl.doc.skins[0].joints;
    let worstP = 0, worstR = 0, moved = 0;
    page.forEach((m, i) => {
      const g = world[joints[i]].world, r = rest[joints[i]].world;
      worstP = Math.max(worstP, Math.hypot(g[12] - m[12], g[13] - m[13], g[14] - m[14]));
      for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) { worstR = Math.max(worstR, Math.abs(g[k] - m[k])); moved = Math.max(moved, Math.abs(g[k] - r[k])); }
    });
    // (moved: the pose really differs from rest, so matching it means something)
    return { worstP: moved > 0.05 ? worstP : Infinity, worstR, bones: page.length };
  };
  const animFile = path.join(outDir, 'minigun_anim.gltf');
  await call('export', { path: 'models/weapons/minigun_explosive/minigun_explosive.mdl', format: 'gltf', lod: 0, textures: false, animations: true, outPath: animFile });
  const gl = loadGltf(animFile);
  const animNames = (gl.doc.animations || []).map((a) => a.name);
  const fire = comparePose(gl, 'fire', 0.1, await viewerPose(`a.applyClip(a.clips.get('fire'), 0.1)`));
  const yawT = await js(`window.__xo.state.animator.clips.get('gun_rot').duration * 0.25`);
  const yaw = comparePose(gl, 'gun_rot', yawT, await viewerPose(`a.applyClip(a.clips.get('gun_rot'), ${yawT})`));
  ok(gl.doc.skins?.length === 1 && animNames.includes('fire') && animNames.includes('gun_rot') && fire.worstP < 1e-3 && fire.worstR < 2e-3 && yaw.worstP < 1e-3 && yaw.worstR < 2e-3,
    `the export carries the skeleton (${fire.bones} bones) and the clips (${animNames.join(', ')}); posed by "fire" at 0.1 s and by the turret turn, every bone sits where the viewer puts it (off by ${(Math.max(fire.worstP, yaw.worstP) * 1000).toFixed(2)} mm at most)`);
  const v2 = execFileSync(process.execPath, [path.join(ROOT, 'tests', 'validate_gltf.mjs'), animFile]).toString().trim();
  ok(v2.startsWith('ok'), 'the animated export validates: ' + v2.split('\n')[0]);
  // Firing arc: the dome of directions the gun can aim into, from its AimYaw / AimPitch layers
  await waitFor('!!window.__xo.viewer.arc', 5000).catch(() => {});
  const arc = await js(`(() => { const a = window.__xo.viewer.arc; if (!a) return null; const m = a.children.find((c) => c.isMesh);
    return { yaw: a.userData.aim.yaw, pitch: a.userData.aim.pitch, visible: a.visible, tris: m.geometry.attributes.position.count / 3, box: !document.getElementById('arcWrap').hidden,
      onAxis: Math.abs(a.position.x) < 0.2 && Math.abs(a.position.z) < 0.3 }; })()`);
  ok(arc && arc.visible && arc.box && arc.yaw[0] === -180 && arc.yaw[1] === 180 && arc.pitch[0] < 0 && arc.pitch[1] > 0 && arc.tris > 100 && arc.onAxis,
    `a turret weapon shows its firing arc: turns ${arc?.yaw.join('..')}°, tilts ${arc?.pitch.join('..')}° (${arc?.tris} triangles)`);
  await js(`(() => { const s = document.getElementById('optArcs'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
  const arcHidden = await js('!window.__xo.viewer.arc.visible');
  await js(`(() => { const s = document.getElementById('optArcs'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
  ok(arcHidden && (await js('window.__xo.viewer.arc.visible')), 'the Firing arc box hides and shows it');
  { // Arc size: the radius is the weapon's size (half its box's diagonal) times the slider, 1.2 at
    // first (it used to be the whole diagonal, held within 1 and 3.5 m); shown in metres, remembered
    const sz = () => js(`(() => { const a = window.__xo.viewer.arc; return { r: a.scale.x, base: a.userData.base, shown: !document.getElementById('arcSizeWrap').hidden,
      label: document.getElementById('arcSizeVal').textContent }; })()`);
    const def = await sz();
    await js(`(() => { const s = document.getElementById('arcSize'); s.value = 0.5; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
    const small = await sz();
    await sleep(300);
    const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8')).arcSize;
    await js(`(() => { const s = document.getElementById('optArcs'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
    const hiddenWithArc = await js(`document.getElementById('arcSizeWrap').hidden`);
    await js(`(() => { const s = document.getElementById('optArcs'); s.checked = true; s.dispatchEvent(new Event('change'));
      const z = document.getElementById('arcSize'); z.value = 1.2; z.dispatchEvent(new Event('input')); z.dispatchEvent(new Event('change')); })()`);
    ok(def.shown && Math.abs(def.r - def.base * 1.2) < 1e-6 && def.label === `${(def.base * 1.2).toFixed(1)} m` && Math.abs(small.r - small.base * 0.5) < 1e-6 &&
      small.label === `${(small.base * 0.5).toFixed(1)} m` && saved === 0.5 && hiddenWithArc,
      `the firing arc's size slider: ${def.label} for this minigun by default (was ${Math.min(3.5, Math.max(1, def.base * 2)).toFixed(1)} m), ${small.label} when moved down, remembered, and hidden with the arc`);
    // Cones: the ones closing the dome above its highest and below its lowest tilt, on and off
    const cones = () => js(`(() => { const a = window.__xo.viewer.arc, c = a.userData.cones, m = a.children.find((o) => o.isMesh && o !== c);
      return { tris: c ? c.geometry.attributes.position.count / 3 : 0, on: !!c && c.visible, shell: m.visible, box: !document.getElementById('arcConesWrap').hidden }; })()`);
    const withCones = await cones();
    await js(`(() => { const s = document.getElementById('arcCones'); s.checked = false; s.dispatchEvent(new Event('change')); })()`);
    const noCones = await cones();
    await sleep(300);
    const conesSaved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8')).arcCones;
    await js(`(() => { const s = document.getElementById('arcCones'); s.checked = true; s.dispatchEvent(new Event('change')); })()`);
    const back = await cones();
    ok(withCones.tris > 0 && withCones.on && withCones.box && !noCones.on && noCones.shell && conesSaved === false && back.on,
      `the Cones box takes the firing arc's top and bottom cones away (${withCones.tris} triangles) and back, the dome stays; remembered`);
  }
  await js(`window.__xo.openModel('models/constructor/chassis/wheels/wheel_r17.mdl')`);
  await idle();
  await waitFor('!!window.__xo.state.animator', 10000).catch(() => {});
  const steerPx = await renderDiff(`window.__xo.state.animator.setPose('WheelSteer', 20)`);
  ok(steerPx > 2000, `steering turns the tyre too (a rigid mesh riding on the hub bone; ${steerPx} pixels change)`);
  { // a pose blend (wheel spin: single-key poses) exports as one key per pose, a second apart
    const f = path.join(outDir, 'wheel_anim.glb');
    await call('export', { path: 'models/constructor/chassis/wheels/wheel_r17.mdl', format: 'glb', lod: 0, textures: false, animations: true, outPath: f });
    const w = loadGltf(f);
    const names = (w.doc.animations || []).map((a) => a.name);
    // (a quarter of the way from the -60° pose to the +60° one: half way would be the rest pose)
    const spin = names.includes('rotation') ? comparePose(w, 'rotation', 1.25, await viewerPose(`const p = a.blends.get('rotation'); a.applyBlend(p[1], p[2], 0.25)`)) : null;
    const tyre = w.doc.meshes.some((m) => /_skinned/.test(m.name) && m.primitives.every((p) => p.attributes.JOINTS_0 != null && p.attributes.WEIGHTS_0 != null));
    ok(spin && spin.worstP < 1e-3 && spin.worstR < 2e-3 && tyre, `a wheel exports its spin, steering and suspension (${names.join(', ')}); between two spin poses the bones match the viewer, and the rigid tyre rides on its hub as a skinned mesh`);
  }
  ok(!(await js('window.__xo.viewer.arc')) && (await js(`document.getElementById('arcWrap').hidden`)), 'a wheel has no firing arc (and no Firing arc box)');
  { // Pose layers as the game plays them (posescan * checks the rule over the whole game)
    const open = async (mdl) => {
      await js(`window.__xo.openModel(${JSON.stringify(mdl)})`);
      await idle();
      await waitFor(`!!window.__xo.state.animator && window.__xo.state.info.path === ${JSON.stringify(mdl)}`, 10000).catch(() => {});
    };
    // the bone's turn from rest about its axis, 0..360 (axis: 'x') or unsigned 0..180 (no axis)
    const turnAt = (bone, param, v, axis) => js(`(() => { const a = window.__xo.state.animator; a.setPose(${JSON.stringify(param)}, ${v});
      const i = a.boneOf.get(${JSON.stringify(bone)}), d = a.skel.rest[i].q.clone().invert().multiply(a.skel.bones[i].quaternion);
      return ${axis ? `((2 * Math.atan2(d.${axis}, d.w) * 180 / Math.PI) % 360 + 360) % 360` : 'Math.min(180, 2 * Math.acos(Math.min(1, Math.abs(d.w))) * 180 / Math.PI)'}; })()`);
    const sliders = () => js(`[...document.querySelectorAll('#animPoses [data-pose]')].map((el) => el.dataset.pose + ' ' + el.min + '..' + el.max)`);
    // A bone missing from a blended pose is at rest there: wheel_military's -180° and 180° spin poses
    // are empty files, which left the hub still for the first third of the slider and stuck for the last.
    await open('models/constructor/chassis/wheels/wheel_military.mdl');
    const vals = [-180, -150, -120, -90, -60, 0, 60, 90, 120, 150, 180], spin = [];
    for (const v of vals) spin.push(await turnAt('wheel_center', 'WheelRotation', v, 'x'));
    const spinOk = vals.every((v, k) => Math.abs((((spin[k] - (v + 180)) % 360) + 540) % 360 - 180) < 2);
    const f = path.join(outDir, 'wheel_military_anim.glb');
    await call('export', { path: 'models/constructor/chassis/wheels/wheel_military.mdl', format: 'glb', lod: 0, textures: false, animations: true, outPath: f });
    const w = loadGltf(f);
    const first = comparePose(w, 'rotation', 0.5, await viewerPose(`const p = a.blends.get('rotation'); a.applyBlend(p[0], p[1], 0.5)`));
    const last = comparePose(w, 'rotation', 2.5, await viewerPose(`const p = a.blends.get('rotation'); a.applyBlend(p[2], p[3], 0.5)`));
    ok(spinOk && first.worstP < 1e-3 && first.worstR < 2e-3 && last.worstP < 1e-3 && last.worstR < 2e-3,
      `a wheel whose end spin poses are empty files turns all the way round with the slider (wheel_military hub at ${vals.map((v, k) => v + '→' + spin[k].toFixed(0) + '°').join(' ')}), and the export matches the viewer in the thirds that start or end on an empty pose`);
    // Activities each play their own stack: the flamethrower's "aim" (IDLE) and "fire" (FIRE) hold the
    // same pitch clip; both played at once and the gun tilted twice as far.
    await open('models/weapons/flame_thrower/flame_thrower.mdl');
    const fl = await js(`(() => { const a = window.__xo.state.animator; a.playing = false; a.setActive(''); return a.playingPoses().layers.map((l) => l.name); })()`);
    const flUp = await turnAt('joint3', 'AimPitch', 30), flDown = await turnAt('joint3', 'AimPitch', -27);
    const flFire = await js(`(() => { const a = window.__xo.state.animator; a.setActive('fire'); a.playing = false; a.time = 0; a.apply(); return a.playingPoses().layers.map((l) => l.name); })()`);
    const flFireUp = await turnAt('joint3', 'AimPitch', 30);
    await js(`(() => { const a = window.__xo.state.animator; a.setActive(''); a.setPose('AimPitch', 0); })()`);
    ok(fl.includes('aim') && !fl.includes('fire') && flFire.includes('fire') && !flFire.includes('aim') && Math.abs(flUp - 30) < 2 && Math.abs(flDown - 27) < 2 && Math.abs(flFireUp - 30) < 2,
      `each activity plays its own layers: the flamethrower pitches through "aim" (${fl.join(', ')}) or, firing, "fire" (${flFire.join(', ')}), never both; up to 30 turns the gun ${flUp.toFixed(0)}° (was twice that), down to -27 ${flDown.toFixed(0)}°, firing ${flFireUp.toFixed(0)}°`);
    // No slider for a parameter whose layers move nothing (the catapult's yaw clip is empty)
    await open('models/weapons/catapult/catapult.mdl');
    const cat = await sliders();
    ok(cat.length === 1 && cat[0].startsWith('AimPitch '), `a parameter whose clip moves nothing gets no slider (catapult: ${cat.join(', ')}; its AimYaw clip is empty)`);
    // A blend whose first pose is empty (minigun_relict's fire_mode_0.anim) moves the bone the other pose turns
    await open('models/weapons/minigun_relict/minigun_relict.mdl');
    const mode = await turnAt('fire_mode_switch', 'Barrels', 1);
    await js(`window.__xo.state.animator.setPose('Barrels', 0)`);
    ok(Math.abs(mode - 90) < 2, `minigun_relict's fire-mode switch turns ${mode.toFixed(0)}° at Barrels 1 (its first pose is an empty file; it used to stay put)`);
    // The two-mode wheel: STAND_UP drives the suspension over 0.55..1.6 and SIT_DOWN over 0..0.35;
    // the slider follows the picked activity
    await open('models/constructor/chassis/wheels/wheel_workers_2modes/wheel_workers_2modes.mdl');
    const s0 = await sliders();
    await js(`(() => { const s = document.getElementById('animSel'); s.value = 'suspension_down'; s.dispatchEvent(new Event('change')); })()`);
    const s1 = await sliders();
    ok(s0.includes('WheelSuspension 0.55..1.6') && s1.includes('WheelSuspension 0..0.35') && s1.includes('WheelSteer -45..45'),
      `the sliders follow the picked activity (two-mode wheel: ${s0.join(', ')}; sitting down: ${s1.join(', ')})`);
    const wheelHides = await js(`document.getElementById('animLookWrap').hidden`);
    // Look at me: the gun keeps turning to face the camera, as far as it can turn. Measured as the
    // angle between the barrel (the gun bone's +Z) and the line from the barrel's origin to the camera.
    const turnDiff = (a) => ((((a % 360) + 540) % 360) - 180);
    const place = (az, el, dist = 4) => js(`(() => { const a = window.__xo.state.animator, v = window.__xo.viewer, g = a.skel.bones[a.aimRig().gun];
      g.updateWorldMatrix(true, false);
      const o = new (v.camera.position.constructor)().setFromMatrixPosition(g.matrixWorld), r = Math.PI / 180;
      v.tween = null;
      v.camera.position.set(o.x - Math.sin(${az} * r) * Math.cos(${el} * r) * ${dist}, o.y + Math.sin(${el} * r) * ${dist}, o.z + Math.cos(${az} * r) * Math.cos(${el} * r) * ${dist});
      v.controls.target.copy(o); v.controls.update(); v.dirty = true; })()`);
    const aim = async (az, el) => {
      await place(az, el);
      await sleep(1200); // (it eases in over about a tenth of a second)
      return js(`(() => { const a = window.__xo.state.animator, v = window.__xo.viewer, rig = a.aimRig(), b = a.barrel(rig);
        const to = a.group.worldToLocal(v.camera.position.clone()).sub(b.o).normalize();
        const sl = (n) => { const el = document.querySelector('#animPoses [data-pose="' + n + '"]'); return el ? +el.value : null; };
        return { err: b.d.angleTo(to) * 180 / Math.PI, axis: (rig.barrel.s > 0 ? '+' : '-') + 'XYZ'[rig.barrel.c], yaw: a.pose.AimYaw, pitch: a.pose.AimPitch,
          yawSlider: sl('AimYaw'), pitchSlider: sl('AimPitch') }; })()`);
    };
    await open('models/weapons/machinegun_browning/machinegun_browning.mdl');
    await js(`(() => { const el = document.getElementById('animLook'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
    const shown = await js(`!document.getElementById('animLookWrap').hidden && window.__xo.state.lookAtMe`);
    const front = await aim(60, 20), back = await aim(170, 10), high = await aim(-120, 80);
    const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8')).lookAtMe;
    ok(wheelHides && shown && saved === true && front.err < 2 && Math.abs(front.yaw - 60) < 3 && Math.abs(front.yawSlider - front.yaw) < 0.5 && back.err < 2 &&
      Math.abs(high.pitch - 60) < 0.5 && Math.abs(turnDiff(high.yaw + 120)) < 3,
      `Look at me: the Browning faces the camera in front (off by ${front.err.toFixed(1)}°, yaw ${front.yaw.toFixed(0)}, the slider follows) and behind (${back.err.toFixed(1)}°), and stops at its 60° limit when the camera is higher; the option is remembered and a wheel has none`);
    // parts whose clips do not turn the gun by the value (mortar from straight up, the rocket
    // crossbow 34° over -29..60, the quadrocopter gun 12° low) or whose barrel is not the gun
    // bone's +Z (the assassins drone shoots down along its -Y): aimed by the barrel all the same
    const odd = [];
    for (const [mdl, az, el, axis] of [['models/weapons/mortar_cannon/mortar_cannon.mdl', 30, 30, '+Z'], ['models/weapons/crossbow_rocket/crossbow_rocket.mdl', -45, 15, '+Z'],
      ['models/constructor/modules/quadrocopter/q_mgun.mdl', 90, -15, '+Z'], ['models/constructor/cabins/assassins_cab1/assassins_cab1_drone.mdl', 120, -50, '-Y']]) {
      await open(mdl);
      const r = await aim(az, el);
      odd.push(`${mdl.split('/').pop()} ${r.err.toFixed(1)}° (barrel ${r.axis}, pitch value ${r.pitch.toFixed(1)} for ${el}°)`);
      if (!(r.err < 2) || r.axis !== axis) odd.push('FAIL');
    }
    ok(!odd.includes('FAIL'), `Look at me aims the barrel itself where a clip turns it by other amounts: ${odd.join(', ')}`);
    await js(`(() => { const el = document.querySelector('#animPoses [data-pose="AimPitch"]'); el.value = 5; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    const off = await js(`!window.__xo.state.lookAtMe && !document.getElementById('animLook').checked`);
    const savedOff = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8')).lookAtMe;
    ok(off && savedOff === false, 'moving an aim slider by hand turns Look at me off (and that is remembered too)');
  }
  // Framing measures the rest pose: a skinned mesh's own bounds follow bones that have no world
  // matrices before the first render, which used to frame only the mount and cut the tyre off.
  await js(`window.__xo.openModel('models/constructor/chassis/wheels/wheel_heavy.mdl')`);
  await idle();
  const corners = await js(`(() => { const v = window.__xo.viewer, b = v.part.userData.box, r = v.canvas.getBoundingClientRect(); let inside = 0;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) { const p = v.project(x, y, z); if (p.inFront && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) inside++; }
    return { inside, skinned: v.part.children.some(c => c.isSkinnedMesh) }; })()`);
  ok(corners.skinned && corners.inside === 8, `an animated wheel is framed whole: all 8 corners of its box in view (${corners.inside}/8)`);
  // Heat glow: a weapon's heat map is dark at rest (garage, item icons), glows with the Barrel heat
  // slider or while firing, and the export follows the slider. Other glow maps always glow.
  const HEATGUN = 'models/weapons/minigun_m134/minigun_m134.mdl';
  await js(`window.__xo.openModel(${JSON.stringify(HEATGUN)})`);
  await idle();
  await waitFor('!!window.__xo.state.animator', 10000).catch(() => {});
  await js(`(() => { const x = window.__xo, a = x.state.animator; a.playing = false; a.setActive(''); x.state.fireHeat = 0; x.viewer.setHeat(0); })()`);
  const cold = await js(`(() => { const h = window.__xo.viewer.materials.filter(m => m.userData.xo.info.heat); return { n: h.length, dark: h.every(m => m.emissiveMap && m.emissive.r === 0), row: !document.getElementById('heatRow').hidden }; })()`);
  ok(cold.n > 0 && cold.dark && cold.row, `a minigun's barrel glow is a heat map: dark at rest, with a Barrel heat slider (${cold.n} material)`);
  const heatPx = await renderDiff(`(() => { const s = document.getElementById('heatSlider'); s.value = 100; s.dispatchEvent(new Event('input')); window.__xo.viewer.setHeat(1); })()`);
  ok(heatPx > 500, `Barrel heat 100% makes the barrels glow (${heatPx} pixels change)`);
  await js(`(() => { const x = window.__xo, s = document.getElementById('heatSlider'); s.value = 0; s.dispatchEvent(new Event('input')); x.viewer.setHeat(0); const a = x.state.animator; a.setActive('fire'); a.playing = true; })()`);
  await sleep(3200);
  const fired = await js(`window.__xo.viewer.options.heat`);
  await js(`window.__xo.state.animator.setActive('')`);
  ok(fired > 0.9, `firing heats the barrels up by itself (heat ${fired.toFixed(2)} after 3 s)`);
  const heatExport = async (heat) => {
    const f = path.join(outDir, `heat_${heat}.gltf`);
    await call('export', { path: HEATGUN, format: 'gltf', lod: 0, textures: true, heat, outPath: f });
    const m = JSON.parse(fs.readFileSync(f, 'utf8')).materials.find((x) => x.extras?.heatGlow);
    return !m ? 'no heat material' : m.emissiveTexture ? m.emissiveFactor.join(' ') : 'no heat map';
  };
  const [e0, e5] = [await heatExport(0), await heatExport(0.5)];
  ok(e0 === 'no heat map' && e5 === '0.5 0.5 0.5', `the export follows the slider: a cold gun without its heat map (Cinema 4D lit it at full), hot at 50% (${e0}; ${e5})`);
  await js(`window.__xo.openModel('models/constructor/decor/hologram_projector/hologram_projector.mdl')`);
  await idle();
  ok(await js(`window.__xo.viewer.materials.some(m => m.emissiveMap && !m.userData.xo.info.heat && m.emissive.r === 1)`), 'a decor hologram still glows (not a heat map)');
  // The look: soft shadows on a floor that only shows shadow, ambient occlusion (post pass), metal
  // from the gloss map, and the part's weld points drawn like the garage's.
  await js(`window.__xo.openModel(${JSON.stringify(BUGGY)})`);
  await idle();
  const look = await js(`(() => { const v = window.__xo.viewer, p = v.post; v.render();
    const w = p.blurRT.width, h = p.blurRT.height, px = new Uint8Array(4 * w * h); v.renderer.readRenderTargetPixels(p.blurRT, 0, 0, w, h, px);
    let dark = 0; for (let i = 0; i < px.length; i += 4) if (px[i] < 200) dark++;
    const box = v.part.userData.box;
    return { post: !!p.scene, ao: p.ao, dark, shadows: v.key.castShadow && v.renderer.shadowMap.enabled, floor: v.floor.visible && Math.abs(v.floor.position.y - (box.min.y - 0.002)) < 1e-6,
      receive: v.part.children.filter((c) => c.isMesh).every((c) => c.receiveShadow && c.castShadow), metal: v.metal.value }; })()`);
  ok(look.post && look.ao && look.dark > 300 && look.shadows && look.floor && look.receive && look.metal === 1,
    `the part stands on a shadow floor with soft shadows and ambient occlusion (${look.dark} occluded pixels)`);
  const shadowPx = await renderDiff(`window.__xo.viewer.setShadows(false)`);
  await js(`window.__xo.viewer.setShadows(true)`);
  ok(shadowPx > 1500, `turning Shadows off changes the picture (${shadowPx} pixels)`);
  const welds = await js(`(() => { const v = window.__xo.viewer, g = v.helpers.children.find((c) => c.name === 'slots'), m = g && g.children[0];
    return { on: document.getElementById('optSlots').checked, visible: !!g && g.visible, count: m ? m.count : 0, slots: window.__xo.state.info.slots.length, tex: v.weldMats?.free?.uniforms?.map?.value?.name || '',
      fill: (() => { const t = v.weldMats?.free?.uniforms?.map?.value, n = t?.image?.width || 0, d = t?.image?.data; if (!d) return null; const vals = new Set();
        for (let y = Math.round(n * 0.2); y < n * 0.8; y++) for (let x = Math.round(n * 0.2); x < n * 0.8; x++) vals.add(d[(y * n + x) * 4 + 3]); return [...vals]; })() }; })()`);
  ok(welds.on && welds.visible && welds.slots > 0 && welds.count === welds.slots && welds.tex === 'weld point' && welds.fill?.length === 1,
    `weld points are shown like the garage's: ${welds.count} pads for ${welds.slots} slots, a thin frame around an even fill (inside alpha ${welds.fill})`);
  const pad = await js(`(() => { const v = window.__xo.viewer, m = v.helpers.children.find((c) => c.name === 'slots').children[0];
    const it = m.userData.items.find((i) => i.normal.dot(v.camera.position.clone().sub(i.pos).normalize()) > 0.3) || m.userData.items[0];
    return { ...v.project(it.pos.x, it.pos.y, it.pos.z), name: it.name }; })()`);
  await mouse('mouseMoved', pad.x - 2, pad.y - 2);
  await mouse('mouseMoved', pad.x, pad.y);
  await waitFor(`!document.getElementById('hoverTip').hidden && document.getElementById('hoverTip').textContent.startsWith('Weld point')`, 5000).catch(() => {});
  const tip = await js(`document.getElementById('hoverTip').textContent`);
  ok(tip === `Weld point: ${pad.name}`, `hovering a pad names the weld point ("${tip}")`);
  await mouse('mouseMoved', 5, 5);
  // A part opened next goes on screen with its textures already in (the old one stays meanwhile)
  const atAdd = await js(`(async () => { const v = window.__xo.viewer, add = v.partRoot.add.bind(v.partRoot); let r = null;
    v.partRoot.add = (g) => { r = g.userData.materials.every((m) => !m.userData.xo.info.textures?.some((t) => t.exists && t.role === 'albedo') || m.map); return add(g); };
    try { await window.__xo.openModel('models/constructor/cabins/military_cab5/military_cab5.mdl'); } finally { v.partRoot.add = add; }
    return r; })()`);
  await idle();
  ok(atAdd === true, 'a newly opened part replaces the old one only once its textures are in (no untextured flash)');
  ok((await js(`document.getElementById('search').closest('#left') !== null`)) && (await js(`document.getElementById('bgSel').value`)) === 'crossout', 'search box sits in the parts panel; the Crossout background is the default');

  // Names: in-game names from names.json, search by name, your own names
  await js(`document.querySelector('.modes button[data-mode="parts"]').click()`);
  await js(`window.__xo.openModel('models/constructor/cabins/buggy_start/buggy_start.mdl')`);
  await idle();
  ok((await js(`document.getElementById('mName').textContent`)) === 'Sprinter' && (await js(`document.getElementById('mFile').textContent`)) === 'file: buggy_start', 'the starter buggy shows its in-game name, Sprinter (file name underneath)');
  await js(`(() => { const s = document.getElementById('search'); s.value = 'sprint'; s.dispatchEvent(new Event('input')); })()`);
  await sleep(400);
  ok(await js(`window.__xo.state.rows.some(r => r.type === 'folder' && r.f.main.endsWith('buggy_start.mdl'))`), 'searching "sprint" finds it by name');
  await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
  await js(`window.__xo.openModel('models/constructor/cabins/arena_cab1/arena_cab1.mdl')`);
  await idle();
  await js(`document.getElementById('mRename').click()`);
  await js(`(() => { const e = document.getElementById('mNameEdit'); e.value = 'Test Name 42'; e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(300);
  const renamed = await js(`({ title: document.getElementById('mName').textContent, row: window.__xo.state.rows.some(r => r.type === 'folder' && r.f.main.endsWith('arena_cab1.mdl')) && [...document.querySelectorAll('#list .row-item .name')].some(n => n.textContent === 'Test Name 42') })`);
  ok(renamed.title === 'Test Name 42', `✎ names a part yourself ("${renamed.title}")`);
  await js(`document.getElementById('mRename').click()`);
  await js(`(() => { const e = document.getElementById('mNameEdit'); e.value = ''; e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await sleep(200);
  ok((await js(`document.getElementById('mName').textContent`)) === 'Kensei', 'clearing your own name goes back to the in-game name (Kensei)');
  const labels = await js(`(() => { const x = window.__xo; return { wheels: x.folderName('models/constructor/chassis/wheels'), two: x.folderName('models/constructor/cabins/ford_pickup'),
    drone: x.folderName('models/constructor/cabins/assassins_cab1'), icarus: x.state.folders.get('models/constructor/chassis/hovers/hover_jet').main }; })()`);
  ok(labels.wheels === 'Wheels' && /^(Huntsman \/ Guerilla|Guerilla \/ Huntsman)$/.test(labels.two) && labels.drone === 'Ark' && labels.icarus.endsWith('/hover_jet01.mdl'),
    `folder rows: a folder of many parts gets a title ("${labels.wheels}"), two cabins in one folder are both named ("${labels.two}"), a cabin with its drone stays "${labels.drone}", and a folder opens its current model`);

  { // Weld pads stand clear of their own part: a centimetre off the face, higher over bumps (a domed hatch)
    const CAB5 = 'models/constructor/cabins/military_cab5/military_cab5.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(CAB5)})`);
    await idle();
    const lifts = await js(`(() => { const v = window.__xo.viewer, sl = v.part.userData.slots, l = sl.map((s) => s.lift);
      const mesh = v.helpers.children.find((g) => g.name === 'slots')?.children[0], m = new (v.camera.matrix.constructor)(), p = new (v.camera.position.constructor)();
      const i = l.indexOf(Math.max(...l)); mesh.getMatrixAt(i, m); p.setFromMatrixPosition(m);
      const want = sl[i].pos.clone().addScaledVector(sl[i].normal, l[i]);
      return { n: l.length, min: Math.min(...l), max: Math.max(...l), over2: l.filter((x) => x > 0.02).length, drawnOff: p.distanceTo(want) }; })()`);
    ok(lifts.min >= 0.01 - 1e-6 && lifts.max > 0.03 && lifts.max <= 0.15 + 1e-6 && lifts.over2 >= 3 && lifts.drawnOff < 1e-4,
      `weld pads clear the part: ${lifts.n} pads at least 1 cm off their faces, ${lifts.over2} raised over the domed hatch (up to ${(lifts.max * 100).toFixed(1)} cm), drawn there`);
  }

  { // Lamp-shader pieces (F3007363: head lights, signs, flashers) are light added onto the part, not
    // solid white pieces: Diffuse x Colormap, each on its own UV set (User5 swaps them), out of shadows
    // and picking; blinking ones keep the view drawing only while on screen; exported as a glow layer.
    const CAB5 = 'models/constructor/cabins/military_cab5/military_cab5.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(CAB5)})`);
    await idle();
    const lamp = await js(`(() => { const v = window.__xo.viewer, ms = v.part.children.filter((c) => c.isMesh && c.userData.lamp), m = ms[0]?.material, u = m?.userData.xo.u;
      const hits = []; for (const c of ms) c.raycast(v.raycaster, hits);
      return { n: ms.length, basic: !!m?.isMeshBasicMaterial, custom: m?.blending === 5, depthWrite: !!m?.depthWrite, visible: !!m?.visible, swap: u?.xoLampSwap.value, gain: u?.xoLampGain.value,
        d: m?.map?.name || '', c: u?.xoLampC.value?.name || '', shadows: ms.some((c) => c.castShadow || c.receiveShadow), hits: hits.length,
        label: document.querySelector('#materials .mat[data-mat="0"] .mat-head')?.textContent || '' }; })()`);
    ok(lamp.n > 0 && lamp.basic && lamp.custom && !lamp.depthWrite && lamp.visible && lamp.swap === 1 && Math.abs(lamp.gain - 1.2) < 1e-6 && lamp.d.endsWith('military_cab05_anim') && // (UserParam0's x / 10: 12 since 2.41)
      lamp.c.endsWith('military_cab05_e') && !lamp.shadows && lamp.hits === 0 && lamp.label.includes('glow layer'),
      `a cabin's lamp pieces are a glow layer: Diffuse on uv1 x Colormap on uv0 (User5), gain ${lamp.gain}, no shadows, not picked, marked in the Materials card`);
    // looking at the lamps (outward from the part's middle through them): the layer only ever adds light
    await js(`(() => { const v = window.__xo.viewer, T = v.camera.position.constructor, part = v.part; part.updateMatrixWorld(true);
      const lo = new T(1e9, 1e9, 1e9), hi = new T(-1e9, -1e9, -1e9), p = new T();
      for (const m of part.children.filter((c) => c.isMesh && c.userData.lamp)) { const P = m.geometry.attributes.position; for (let i = 0; i < P.count; i++) { p.fromBufferAttribute(P, i); if (m.isSkinnedMesh) m.applyBoneTransform(i, p); p.applyMatrix4(m.matrixWorld); lo.min(p); hi.max(p); } }
      const c = part.userData.box.getCenter(new T()), lc = lo.clone().add(hi).multiplyScalar(0.5), dir = lc.clone().sub(c); dir.y = Math.max(dir.y, 0) + 0.25 * dir.length(); dir.normalize();
      v.controls.target.copy(lc); v.camera.position.copy(lc).addScaledVector(dir, hi.distanceTo(lo) * 1.6 + 0.3); v.controls.update(); v.dirty = true; })()`);
    await sleep(200);
    const glow = await js(`(async () => { const v = window.__xo.viewer, g = document.getElementById('view').getContext('webgl2'), m = v.part.children.find((c) => c.userData.lamp).material;
      const grab = () => { v.render(); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
      m.visible = false; const off = grab(); m.visible = true; const on = grab();
      let brighter = 0, darker = 0; for (let i = 0; i < on.length; i += 4) { const d = on[i] + on[i + 1] + on[i + 2] - off[i] - off[i + 1] - off[i + 2]; if (d > 30) brighter++; else if (d < -30) darker++; }
      return { brighter, darker }; })()`);
    ok(glow.brighter > 150 && glow.darker <= glow.brighter * 0.02, `the head lights glow: ${glow.brighter} pixels brighter with the layer, ${glow.darker} darker`);
    // blinking: drawn about 30 times a second while a flasher is on screen; not at all once it's gone
    const frames = async (ms) => { const a = await js('window.__xo.viewer.frames || 0'); await sleep(ms); return (await js('window.__xo.viewer.frames || 0')) - a; };
    await js(`window.__xo.openModel('models/constructor/decor/police_flasher/police_flasher.mdl')`);
    await idle();
    const flashing = await frames(1500);
    await js('window.__xo.viewer.holdLamps(0)');
    await sleep(100);
    const held = await frames(1000);
    await js('window.__xo.viewer.holdLamps(null)');
    const scroll = await js(`(() => { const v = window.__xo.viewer, m = v.part.children.find((c) => c.userData.lamp)?.material; return m ? m.userData.xo.lamp.scroll.join(' ') : ''; })()`);
    await js(`window.__xo.openModel('models/constructor/decor/bulldozer_headlight/bulldozer_headlight_left.mdl')`);
    await idle();
    await sleep(700);
    const still = await frames(1000);
    ok(flashing >= 20 && held <= 2 && still <= 2 && scroll === '0 0 0 0.5',
      `a police flasher blinks (its Colormap scrolls 0.5/s): ${Math.round(flashing / 1.5)} frames/s while shown, ${held} while held, ${still} once a still lamp is shown`);
    // exported: one glow image (colour x the other texture), black base, see-through by its alpha, the colour's UVs first
    const lampGltf = path.join(outDir, 'taxi_light.gltf'), lampObj = path.join(outDir, 'taxi_light.obj');
    await call('export', { path: 'models/constructor/decor/taxi_light/taxi_light.mdl', format: 'gltf', lod: 0, textures: true, outPath: lampGltf });
    await call('export', { path: 'models/constructor/decor/taxi_light/taxi_light.mdl', format: 'obj', lod: 0, textures: true, outPath: lampObj });
    const lg = JSON.parse(fs.readFileSync(lampGltf, 'utf8')), lbin = fs.readFileSync(path.join(outDir, lg.buffers[0].uri));
    const li = lg.materials.findIndex((m) => m.extras?.lampGlow), lm = lg.materials[li];
    const prim = lg.meshes.flatMap((m) => m.primitives).find((p) => p.material === li);
    const vRange = (() => { if (!prim) return 0; const a = lg.accessors[prim.attributes.TEXCOORD_0], bv = lg.bufferViews[a.bufferView], o = (bv.byteOffset || 0) + (a.byteOffset || 0), st = bv.byteStride || 8;
      let lo = 1e9, hi = -1e9; for (let k = 0; k < a.count; k++) { const v = lbin.readFloatLE(o + k * st + 4); lo = Math.min(lo, v); hi = Math.max(hi, v); } return hi - lo; })();
    const glowImg = lm ? lg.images[lg.textures[lm.emissiveTexture?.index]?.source]?.uri || '' : '';
    const mtl = fs.readFileSync(lampObj.replace(/\.obj$/, '.mtl'), 'utf8'), mtlGlow = mtl.split('newmtl ').find((b) => b.startsWith('taxi_light_e_glow')) || '';
    ok(lm && lm.alphaMode === 'BLEND' && lm.pbrMetallicRoughness.baseColorFactor.join() === '0,0,0,1' && lm.pbrMetallicRoughness.baseColorTexture?.index === lm.emissiveTexture?.index &&
      glowImg.endsWith('taxi_light_e_glow.png') && lm.extensions?.KHR_materials_emissive_strength?.emissiveStrength === 1.1 && lg.extensionsUsed?.includes('KHR_materials_emissive_strength') &&
      vRange > 0.5 && /Kd 0 0 0/.test(mtlGlow) && /map_Ke \S+_glow\.png/.test(mtlGlow) && /map_d \S+_glow\.png/.test(mtlGlow) && validate(lampGltf).startsWith('ok'),
      `the export writes the taxi sign as a glow layer (${glowImg.split('/').pop()}, strength ${lm?.extensions?.KHR_materials_emissive_strength?.emissiveStrength}, its colour's UVs moved first: v spans ${vRange.toFixed(2)}; OBJ Ke/map_Ke/map_d)`);
  }

  { // The other glow shaders: additive layered light models (not tiled by their intensity), map-prop
    // glows (644D00C3), the see-through build-slot marker; overlay decals blend outside the map folder too
    const look = async (model) => {
      await js(`window.__xo.openModel(${JSON.stringify(model)})`);
      await idle();
      return js(`(() => { const v = window.__xo.viewer, info = window.__xo.state.info;
        const ms = v.part.children.filter((c) => c.isMesh && c.userData.lamp), m = ms[0]?.material;
        let uvMax = 0; for (const c of ms) { const a = c.geometry.attributes.uv; for (let i = 0; i < a.count; i++) uvMax = Math.max(uvMax, Math.abs(a.getX(i)), Math.abs(a.getY(i))); }
        return { n: ms.length, basic: !!m?.isMeshBasicMaterial, src: m?.blendSrc, gain: m?.userData.xo.u.xoLampGain.value, uvMax, visible: !!m?.visible,
          label: document.querySelector('#materials .mat-head')?.textContent || '', blends: info.materials.map((x) => !!x.blend), shaders: info.materials.map((x) => (x.guid || '').slice(0, 8)) }; })()`);
    };
    const moto = await look('models/constructor/chassis/wheels/wheel_moto_military_01_light.mdl');
    ok(moto.n > 0 && moto.basic && moto.src === 201 /* OneFactor: added */ && Math.abs(moto.gain - 1) < 1e-6 && moto.uvMax < 1.05 && moto.visible,
      `an additive layered light model (39E61427) is a glow, intensity ${moto.gain}, its UVs untiled (up to ${moto.uvMax.toFixed(2)}; they were x10)`);
    const slot = await look('models/misc/slot.mdl');
    ok(slot.n > 0 && slot.src === 204 /* SrcAlphaFactor: see-through */ && slot.label.includes('see-through layer'), 'the build-slot marker (644D00C3 with User4) is a see-through layer, not a white slab');
    const garland = await look('assets/props/newyear/garland_4m_v1.mdl');
    ok(garland.n > 0 && garland.src === 201 && garland.visible, `a map garland's bulbs glow (additive layers on a map prop: ${garland.n} glow mesh(es))`);
    const tower = await look('models/gameplay/ex_tower/ex_tower.mdl');
    const decal = tower.shaders.indexOf('85f3a2ed');
    ok(decal >= 0 && tower.blends[decal] && tower.n > 0, `a gameplay object's overlay decal (85F3A2ED) blends by its alpha and its glowing panel is a glow layer`);
  }

  { // Health fixes (xotest matscan / geoscan / texrole): BC6H textures, skins-only models, inside-out
    // mirrored meshes, flat DXT5nm normal maps, glass that is not metal, the plain-colour shader, a
    // non-additive emission layer
    const view = async (model, expr) => {
      await js(`window.__xo.openModel(${JSON.stringify(model)})`);
      await idle();
      return js(`(() => { const v = window.__xo.viewer, info = window.__xo.state.info, ms = v.part.children.filter((c) => c.isMesh); ${expr} })()`);
    };
    const sky = await view('assets/skies/space/nebula_planet.mdl', `return { maps: ms.filter((c) => c.material.map).length, n: ms.length, err: document.getElementById('statusText').classList.contains('err') };`);
    ok(sky.n > 0 && sky.maps === sky.n && !sky.err, `a BC6H sky panorama (texture code 244) loads: ${sky.maps}/${sky.n} meshes textured`);
    const helmet = await view('assets/props/settlement/knights/helmet1.mdl', `return { mats: info.materials.length, tex: info.materials.filter((m) => (m.textures || []).some((t) => t.exists && t.role === 'albedo')).length };`);
    ok(helmet.mats > 0 && helmet.tex > 0, `a model with skins only (no default) shows its first skin (${helmet.tex} textured material(s), not white)`);
    const ladder = await view('assets/props/buildings/builders_town/ladder_side_right.mdl', `let n = 0, agree = 0; const T = v.camera.position.constructor;
      for (const c of ms) { const P = c.geometry.attributes.position, N = c.geometry.attributes.normal, I = c.geometry.index;
        for (let k = 0; k + 2 < I.count; k += 3) { const a = I.getX(k), b = I.getX(k + 1), d = I.getX(k + 2);
          const pa = new T().fromBufferAttribute(P, a), fn = new T().fromBufferAttribute(P, b).sub(pa).cross(new T().fromBufferAttribute(P, d).sub(pa));
          const vn = new T().fromBufferAttribute(N, a).add(new T().fromBufferAttribute(N, b)).add(new T().fromBufferAttribute(N, d));
          if (fn.lengthSq() < 1e-20) continue; n++; if (fn.dot(vn) > 0) agree++; } }
      return { n, agree };`);
    ok(ladder.n > 0 && ladder.agree / ladder.n > 0.9, `a mirrored prop's triangles face their normals (right-hand ladder: ${ladder.agree}/${ladder.n}; it showed its inside)`);
    const flat = await view('models/constructor/chassis/air_cushion/air_cushion_01/air_cushion_01_2.mdl', `const m = v.materials.find((x) => (x.userData.xo.info.textures || []).some((t) => t.base === 'textures/blank_parts_n'));
      return m ? { layout: m.userData.xo.u.xoNmLayout.value, normalMap: !!m.normalMap } : null;`);
    ok(flat && flat.normalMap && flat.layout === 0, `the shared flat normal map (blank_parts_n, DXT5nm) is read X-in-alpha, not as RG (layout ${flat?.layout})`);
    const glass = await view('models/constructor/cabins/bug/cab_bug_air.mdl', `const g = v.materials.filter((x) => (x.userData.xo.info.guid || '').startsWith('0ba5c7a3'));
      return { n: g.length, metal: g.map((x) => x.userData.xo.u.xoMetal.value), shared: v.metal.value };`);
    ok(glass.n > 0 && glass.metal.every((x) => x === 0) && glass.shared === 1, `glass is never metal (${glass.n} glass material(s), metal ${glass.metal.join(',')}), other materials keep the gloss map's metal`);
    const pad = await view('assets/props/buildings/arctic/helipad.mdl', `return v.materials.map((m) => m.color.r);`);
    ok(pad.length > 0 && pad.every((r) => r < 0.7), `the plain-colour shader (DE4D728D) shows its colour, not white (${pad.map((r) => r.toFixed(2)).join(', ')} linear)`);
    const moon = await view('assets/props/helloween/moon.mdl', `const g = ms.filter((c) => c.userData.lamp); let uvMax = 0;
      for (const c of g) { const a = c.geometry.attributes.uv; for (let i = 0; i < a.count; i++) uvMax = Math.max(uvMax, Math.abs(a.getX(i)), Math.abs(a.getY(i))); }
      return { glow: g.length, additive: g[0]?.material.userData.xo.lamp.additive, uvMax };`);
    ok(moon.glow > 0 && moon.additive === false && moon.uvMax < 1.05, `a non-additive emission layer (the Halloween moon) is one glow blended by its alpha, untiled (UVs up to ${moon.uvMax.toFixed(2)})`);
  }

  { // The part's materials outlined as the builder outlines parts: white under the cursor, orange when clicked
    await js(`window.__xo.openModel('models/constructor/cabins/engineers_cab2/engineers_cab2.mdl')`);
    await idle();
    await sleep(300);
    // a point on the part for each material (seen from the camera, that material in front there)
    const spots = await js(`(() => { const v = window.__xo.viewer, out = {}, r = v.canvas.getBoundingClientRect(); v.part.updateMatrixWorld(true);
      for (const c of v.part.children) { if (!c.isMesh || out[c.userData.material]) continue; const pos = c.geometry.attributes.position, idx = c.geometry.index, n = idx ? idx.count : pos.count;
        for (let k = 0; k + 2 < n && !out[c.userData.material]; k += 3 * Math.max(1, Math.floor(n / 900))) {
          const P = (j) => new (v.camera.position.constructor)().fromBufferAttribute(pos, idx ? idx.getX(j) : j).applyMatrix4(c.matrixWorld);
          const m = P(k).add(P(k + 1)).add(P(k + 2)).multiplyScalar(1 / 3), s = v.project(m.x, m.y, m.z);
          if (!s.inFront || s.x < r.left + 5 || s.x > r.right - 5 || s.y < r.top + 5 || s.y > r.bottom - 5) continue;
          const hit = v.partMeshAt({ clientX: s.x, clientY: s.y }); if (hit && hit.object.userData.material === c.userData.material) out[c.userData.material] = s; } }
      return out; })()`);
    const mats = Object.keys(spots).map(Number);
    const st = () => js(`(() => { const v = window.__xo.viewer; return { hover: v.partHover, sel: v.partSel, outlines: v.outlines.map((o) => o.color + ':' + o.object.userData.material), marked: [...document.querySelectorAll('#materials .mat.sel')].map((m) => +m.dataset.mat) }; })()`);
    const WHITE = 0xffffff, ORANGE = 0xffa43c;
    ok(mats.length >= 2, `the cabin shows ${mats.length} materials to point at`);
    const [m0, m1] = mats;
    await mouse('mouseMoved', spots[m0].x, spots[m0].y);
    await sleep(250);
    let s = await st();
    ok(s.hover === m0 && s.outlines.includes(`${WHITE}:${m0}`), `hovering the part outlines the material under the cursor white (material ${m0})`);
    await app.click(spots[m0].x, spots[m0].y);
    await sleep(150);
    s = await st();
    ok(s.sel === m0 && s.outlines.includes(`${ORANGE}:${m0}`) && !s.outlines.includes(`${WHITE}:${m0}`) && s.marked.join() === String(m0), 'a click selects it: orange outline, the material marked in the Materials card');
    const head = await js(`(() => { const el = document.querySelector('#materials .mat[data-mat="${m1}"] .mat-head'); el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mouse('mouseMoved', head.x, head.y);
    await sleep(150);
    s = await st();
    ok(s.hover === m1 && s.outlines.includes(`${WHITE}:${m1}`) && s.outlines.includes(`${ORANGE}:${m0}`), 'the mouse over another material in the card outlines it in the view (the selected one stays orange)');
    await app.click(head.x, head.y);
    await sleep(150);
    s = await st();
    ok(s.sel === m1 && s.marked.join() === String(m1), 'a click on its name selects that one');
    const vr = await js(`(() => { const r = window.__xo.viewer.canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left }; })()`);
    await app.key('Escape');
    await sleep(100);
    s = await st();
    ok(s.sel === null && !s.outlines.some((o) => o.startsWith(`${ORANGE}:`)) && s.marked.length === 0, 'Esc lets go (no orange outline, nothing marked)');
    await app.click(spots[m0].x, spots[m0].y);
    await js(`window.__xo.setView('build')`);
    await sleep(150);
    const inBuild = await js('window.__xo.viewer.outlines.filter((o) => window.__xo.viewer.part.children.includes(o.object)).length'); // (the builder's own may show)
    await js(`window.__xo.setView('part')`);
    await sleep(150);
    ok(inBuild === 0 && (await st()).outlines.includes(`${ORANGE}:${m0}`), "the 3D Viewer's outline stays in the 3D Viewer (none in the builder, back when you return)");
    await app.click(vr.l + 6, vr.y);
    ok((await st()).sel === null, 'a click beside the part lets go too');
    await app.click(spots[m0].x, spots[m0].y);
    await app.drag(vr.x, vr.y, vr.x + 120, vr.y + 10);
    ok((await st()).sel === m0, 'turning the view with a drag keeps the selection');
    await app.key('Escape');
  }

  // Exports that come out right in Blender: one object named as in the game (no empties unless asked),
  // the pose the viewer shows baked in (a mortar's bind pose has its barrel standing straight up), opaque albedos
  // without an alpha channel, the game version noted, textures capped on request, mirrored build
  // parts without negative scale.
  {
    const MORTAR = 'models/weapons/mortar_cannon/mortar_cannon.mdl';
    const glbDoc = (f) => { const b = fs.readFileSync(f), jl = b.readUInt32LE(12); return { doc: JSON.parse(b.subarray(20, 20 + jl).toString()), bin: b.subarray(20 + jl + 8) }; };
    const yTop = (g) => Math.max(...g.doc.meshes.flatMap((m) => m.primitives.map((p) => g.doc.accessors[p.attributes.POSITION].max[1])));
    const pngOf = (g, im) => { const bv = g.doc.bufferViews[im.bufferView]; return g.bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength); };
    await js(`window.__xo.openModel(${JSON.stringify(MORTAR)})`);
    await idle();
    await waitFor(`!!window.__xo.state.animator && window.__xo.state.animator.path === ${JSON.stringify(MORTAR)}`, 15000);
    const shownTop = await js(`(() => { const part = window.__xo.viewer.part, q = new (part.position.constructor)(); let top = -Infinity;
      part.updateMatrixWorld(true);
      for (const c of part.children) { if (!c.isMesh || c.userData.lamp) continue; if (c.isSkinnedMesh) c.skeleton.update();
        const pos = c.geometry.attributes.position, idx = c.geometry.index.array;
        for (let t = 0; t < idx.length; t += 3) { // (triangles the pose shrinks to a point do not count: they are not seen)
          const v = [0, 1, 2].map((k) => { const p = new (part.position.constructor)(); if (c.isSkinnedMesh) c.getVertexPosition(idx[t + k], p); else p.fromBufferAttribute(pos, idx[t + k]); return p; });
          if (v[1].clone().sub(v[0]).cross(v[2].clone().sub(v[0])).length() < 1e-9) continue;
          for (const p of v) top = Math.max(top, p.y); } }
      return top; })()`);
    const posedFile = path.join(outDir, 'mortar_posed.glb'), restFile = path.join(outDir, 'mortar_rest.glb');
    await js(`window.__xo.call('export', { path: ${JSON.stringify(MORTAR)}, name: 'Mortar (test)', format: 'glb', lod: 0, textures: true, pose: window.__xo.shownPose(), outPath: ${JSON.stringify(posedFile)} })`);
    await call('export', { path: MORTAR, format: 'glb', lod: 0, textures: false, outPath: restFile });
    const posed = glbDoc(posedFile), rest = glbDoc(restFile);
    ok(Math.abs(yTop(posed) - shownTop) < 0.01 && yTop(rest) > shownTop + 1,
      `the export shows the mortar as the viewer does (top at ${yTop(posed).toFixed(2)} m, viewer ${shownTop.toFixed(2)} m; in its bind pose the barrel stands up to ${yTop(rest).toFixed(2)} m)`);
    const top = posed.doc.nodes[posed.doc.scenes[0].nodes[0]];
    ok(posed.doc.nodes.length === 1 && top.name === 'Mortar (test)' && top.mesh != null && top.extras?.source === MORTAR && /^Crossout \d/.test(posed.doc.asset.extras?.gameVersion || '') && posed.doc.asset.extras?.pose,
      `a part is one object named as in the game ("${top.name}", ${posed.doc.nodes.length} node), with the game version (${posed.doc.asset.extras?.gameVersion}) noted`);
    ok(validate(posedFile).startsWith('ok') && validate(restFile).startsWith('ok'), 'both mortar exports validate');
    // the builder's static copy of the part (and a build's export of it) stand in the same pose
    const builderCopy = await js(`(async () => { const v = window.__xo.viewer, info = await window.__xo.getInfo(${JSON.stringify(MORTAR)}), g = await v.makeModel(info, 0);
      const r = { top: g.userData.box.max.y, trs: g.userData.pose?.trs }; v.disposeModel(g); return r; })()`);
    const inBuild = path.join(outDir, 'mortar_in_build.glb');
    await call('exportBuild', { parts: [{ path: MORTAR, skin: '', name: 'Mandrake', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1], pose: builderCopy.trs }], name: 'one gun', format: 'glb', lod: 0, textures: false, outPath: inBuild });
    ok(builderCopy.trs && Math.abs(builderCopy.top - shownTop) < 0.01 && Math.abs(yTop(glbDoc(inBuild)) - shownTop) < 0.01,
      `the builder shows it in that pose too (top at ${builderCopy.top.toFixed(2)} m) and a build exports it so (${yTop(glbDoc(inBuild)).toFixed(2)} m)`);
    const opaque = posed.doc.materials.filter((m) => !m.alphaMode && m.pbrMetallicRoughness?.baseColorTexture);
    const types = opaque.map((m) => pngOf(posed, posed.doc.images[posed.doc.textures[m.pbrMetallicRoughness.baseColorTexture.index].source])[25]);
    ok(opaque.length > 0 && types.every((t) => t === 2), `opaque materials' albedos are RGB PNGs without alpha (colour types ${types.join(', ')})`);

    const CAB = 'models/constructor/cabins/military_cab5/military_cab5.mdl', ARMOR = 'models/constructor/structure/scrap_armor/armor_thorns/armor_thorns.mdl';
    const small = path.join(outDir, 'cab_512.glb');
    await call('export', { path: CAB, format: 'glb', lod: 0, textures: true, maxTex: 512, outPath: small });
    const sm = glbDoc(small), sizes = sm.doc.images.map((im) => { const p = pngOf(sm, im); return Math.max(p.readUInt32BE(16), p.readUInt32BE(20)); });
    ok(sizes.length && Math.max(...sizes) <= 512 && fs.statSync(small).size < 4e6, `Textures up to 512 px: ${sizes.length} images, the largest ${Math.max(...sizes)} px, ${(fs.statSync(small).size / 1e6).toFixed(1)} MB`);

    const mirFile = path.join(outDir, 'mirrored.glb');
    await call('exportBuild', { parts: [{ path: ARMOR, skin: '', name: 'Thorns', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1] },
      { path: ARMOR, skin: '', name: 'Thorns', matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1] }], name: 'mirror test', format: 'glb', lod: 0, textures: false, outPath: mirFile });
    const mir = glbDoc(mirFile), det = (m) => m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
    const meshNames = mir.doc.meshes.map((m) => m.name), parts = mir.doc.nodes.filter((n) => n.extras?.source);
    const box = (name) => { const m = mir.doc.meshes.find((x) => x.name === name), a = mir.doc.accessors[m.primitives[0].attributes.POSITION]; return [a.min[0], a.max[0]]; };
    const [plain, mirrored] = [meshNames.find((n) => !n.includes('_mirrored')), meshNames.find((n) => n.includes('_mirrored'))];
    ok(parts.length === 2 && parts.every((n) => !n.matrix || det(n.matrix) > 0) && mirrored && Math.abs(box(mirrored)[0] + box(plain)[1]) < 1e-5 && validate(mirFile).startsWith('ok') && parts.map((n) => n.name).join() === 'Thorns,Thorns.001',
      `a mirrored part gets a mirrored mesh (${meshNames.join(', ')}) and no negative scale; parts are named as given (${parts.map((n) => n.name).join(', ')})`);
  }

  // A dropdown picked with the mouse gives the arrows back: ↓ goes to the next part (it changed the
  // dropdown: another LOD, skin or export option)
  {
    const partBefore = await js('window.__xo.state.info.path'), lodBefore = await js(`document.getElementById('lodSel').value`);
    const focused = await js(`(() => { const s = document.getElementById('lodSel'); s.focus(); return document.activeElement === s; })()`);
    await app.key('ArrowDown');
    await waitFor(`window.__xo.state.info.path !== ${JSON.stringify(partBefore)}`, 20000).catch(() => {});
    const partAfter = await js('window.__xo.state.info.path');
    ok(focused && partAfter !== partBefore && (await js(`document.activeElement?.id !== 'lodSel'`)) && lodBefore === '0',
      `↓ on a dropdown picked with the mouse goes to the next part (${partBefore.split('/').pop()} -> ${partAfter.split('/').pop()}) and leaves the dropdown alone`);
    await idle();
  }

  // A skinned mesh's bone numbers count from its first bone (the mesh's words[6]): read as node
  // numbers, 1,043 meshes hung on the wrong bones; the Aggressor's exhaust pipes swung 35 cm with the
  // flaps two nodes before them
  {
    const AGG = 'models/constructor/cabins/raider_cab1/raider_cab1.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(AGG)})`);
    await idle();
    await waitFor(`!!window.__xo.state.animator && window.__xo.state.animator.path === ${JSON.stringify(AGG)}`, 15000);
    const r = await js(`(() => {
      const a = window.__xo.state.animator, part = window.__xo.viewer.part, V3 = part.position.constructor, q = new V3();
      a.playing = false;
      const { bones, rest } = a.skel;
      const mesh = part.children.find((c) => c.isSkinnedMesh), pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
      const on = [];
      for (let i = 0; i < pos.count; i++) if (sw.getComponent(i, 0) > 0.99 && /^exhaust/.test(bones[si.getComponent(i, 0)].name)) on.push(i);
      bones.forEach((b, i) => { b.position.copy(rest[i].p); b.quaternion.copy(rest[i].q); });
      part.updateMatrixWorld(true);
      mesh.skeleton.update();
      const restAt = on.map((i) => { mesh.getVertexPosition(i, q); return q.clone(); });
      const byBone = new Map();
      on.forEach((i, k) => { const j = si.getComponent(i, 0), e = byBone.get(j) || { s: new V3(), n: 0 }; e.s.add(restAt[k]); e.n++; byBone.set(j, e); });
      let far = 0;
      for (const [j, e] of byBone) far = Math.max(far, e.s.divideScalar(e.n).distanceTo(part.worldToLocal(new V3().setFromMatrixPosition(bones[j].matrixWorld))));
      const len = a.clips.get('idle')?.duration || 1.3;
      let moved = 0;
      a.setActive('idle');
      for (let t = 0; t <= 1.0001; t += 0.05) {
        a.time = t * len; a.apply(); part.updateMatrixWorld(true); mesh.skeleton.update();
        on.forEach((i, k) => { mesh.getVertexPosition(i, q); moved = Math.max(moved, q.distanceTo(restAt[k])); });
      }
      a.time = 0; a.apply();
      return { verts: on.length, bones: byBone.size, far, moved };
    })()`);
    ok(r.verts > 500 && r.bones === 4 && r.far < 0.5 && r.moved < 0.03,
      `the Aggressor's exhaust pipes hang on their own bones (${r.bones} bones, ${r.verts} vertices, at most ${r.far.toFixed(2)} m from them) and shake ${(r.moved * 100).toFixed(1)} cm while it idles`);
  }
  // A folder's row is the part as the game shows it: the Porcupine with a barrel on each deploy point
  // (its own row: alone; the badge counts the folder's models, "2/6" when the search matches 2). The
  // export takes them along: where the viewer has them, and under their joints with the skeleton.
  {
    const POR = 'models/weapons/barrel_launcher/barrel_launcher.mdl', J = JSON.stringify;
    await js(`document.querySelector('#cats button[data-cat="Weapons"]').click()`);
    await js(`(() => { const s = document.getElementById('search'); s.value = 'porcupine'; s.dispatchEvent(new Event('input')); })()`);
    await waitFor(`window.__xo.state.query === 'porcupine' && window.__xo.state.rows.some((r) => r.type === 'folder' && r.f.main === ${J(POR)})`, 5000);
    const fi = await js(`window.__xo.state.rows.findIndex((r) => r.type === 'folder' && r.f.main === ${J(POR)})`);
    const badge = await js(`document.querySelector('#list .row-item[data-i="${fi}"] .badge').textContent`);
    await js(`document.querySelector('#list .row-item[data-i="${fi}"]').click()`);
    await waitFor(`window.__xo.state.info?.path === ${J(POR)} && window.__xo.state.assembled`, 30000);
    await idle();
    const shown = await js(`(() => {
      const a = window.__xo.state.animator; if (a) a.playing = false; // (the barrels ride the reload clip: hold still to compare)
      const part = window.__xo.viewer.part; part.updateMatrixWorld(true);
      const inv = part.matrixWorld.clone().invert(), nodes = window.__xo.state.info.nodes;
      const att = part.userData.attached || [];
      return { names: att.map((g) => g.userData.info.path.split('/').pop() + '@' + nodes[g.userData.attachedTo].name), at: att.map((g) => inv.clone().multiply(g.matrixWorld).elements.slice(12, 15)),
        line: document.getElementById('mWith').textContent, folderSel: !!document.querySelector('#list .row-item.sel:not(.child)') };
    })()`);
    ok(shown.names.join() === 'barrel.mdl@deploy_01,barrel.mdl@deploy_02' && shown.folderSel && /^With 2 × .+ in place/.test(shown.line) && /^2\/\d+$/.test(badge),
      `the Porcupine's folder row shows it as in the game: ${shown.names.join(', ')} ("${shown.line}"; badge ${badge})`);
    // pointing at a barrel names it (no outline on the launcher's material behind it)
    const spot = await js(`(() => {
      const v = window.__xo.viewer, r = v.canvas.getBoundingClientRect();
      for (const g of v.part.userData.attached || []) {
        let found = null;
        g.traverse((c) => {
          if (found || !c.isMesh) return;
          const pos = c.geometry.attributes.position, idx = c.geometry.index, n = idx ? idx.count : pos.count;
          for (let k = 0; k + 2 < n && !found; k += 3 * Math.max(1, Math.floor(n / 600))) {
            const P = (j) => new (v.camera.position.constructor)().fromBufferAttribute(pos, idx ? idx.getX(j) : j).applyMatrix4(c.matrixWorld);
            const m = P(k).add(P(k + 1)).add(P(k + 2)).multiplyScalar(1 / 3), s = v.project(m.x, m.y, m.z);
            if (!s.inFront || s.x < r.left + 5 || s.x > r.right - 5 || s.y < r.top + 5 || s.y > r.bottom - 5) continue;
            if (!v.partMeshAt({ clientX: s.x, clientY: s.y }) && v.attachedAt()?.group === g) found = s;
          }
        });
        if (found) return found;
      }
      return null;
    })()`);
    let tip = '', hov = 'none';
    if (spot) {
      await mouse('mouseMoved', spot.x - 2, spot.y - 2);
      await mouse('mouseMoved', spot.x, spot.y);
      await sleep(250);
      ({ tip, hov } = await js(`({ tip: document.getElementById('hoverTip').hidden ? '' : document.getElementById('hoverTip').textContent, hov: window.__xo.viewer.partHover })`));
      await mouse('mouseMoved', 5, 5);
    }
    ok(!!spot && /barrel · on deploy_0[12] · shown with the part$/.test(tip) && hov === null, `pointing at a barrel names it ("${tip}") and outlines none of the launcher's materials`);
    const args = await js(`window.__xo.exportArgs()`);
    const stat = path.join(outDir, 'porcupine.glb'), anim = path.join(outDir, 'porcupine_anim.gltf');
    await call('export', { ...args, format: 'glb', animations: false, outPath: stat });
    await call('export', { ...args, format: 'gltf', animations: true, pose: undefined, outPath: anim });
    const st = loadGltf(stat), W = poseAt(st, null, 0);
    const barrels = st.doc.nodes.map((n, i) => ({ n, w: W[i].world })).filter(({ n }) => n.extras?.shownOn);
    const off = Math.max(...barrels.map(({ w }) => Math.min(...shown.at.map((p) => Math.hypot(p[0] - w[12], p[1] - w[13], p[2] - w[14])))));
    const an = loadGltf(anim), parent = new Array(an.doc.nodes.length).fill(-1);
    an.doc.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
    const hung = an.doc.nodes.map((n, i) => (n.extras?.shownOn ? an.doc.nodes[parent[i]]?.name : null)).filter(Boolean);
    const reload = an.doc.animations.find((a) => a.name === 'reload');
    let rolled = 0;
    if (reload) {
      const rest = poseAt(an, null, 0), idx = an.doc.nodes.map((n, i) => (n.extras?.shownOn ? i : -1)).filter((i) => i >= 0);
      for (let t = 0; t <= 3; t += 0.1) { const p = poseAt(an, 'reload', t); for (const i of idx) rolled = Math.max(rolled, Math.hypot(...[12, 13, 14].map((k) => p[i].world[k] - rest[i].world[k]))); }
    }
    ok(barrels.length === 2 && off < 1e-4 && st.doc.asset.extras?.shownWith?.length === 2 && validate(stat).startsWith('ok') && hung.join() === 'deploy_01,deploy_02' && rolled > 0.3 && validate(anim).startsWith('ok'),
      `its export takes both barrels: where the viewer has them (${(off * 1000).toFixed(2)} mm off), and with the skeleton under ${hung.join(' and ')} (the reload rolls them ${(rolled * 100).toFixed(0)} cm)`);
    await js(`document.querySelector('#mWith a[data-alone]').click()`);
    await waitFor(`window.__xo.state.info?.path === ${J(POR)} && !window.__xo.state.assembled && !window.__xo.state.loading`, 30000);
    const alone = await js(`({ attached: (window.__xo.viewer.part.userData.attached || []).length, line: document.getElementById('mWith').hidden, rowSel: document.querySelector('#list .row-item.child.sel')?.title || '', args: window.__xo.exportArgs().attachments })`);
    ok(alone.attached === 0 && alone.line && alone.args === undefined, `"Show it alone" shows the launcher by itself and exports it so${alone.rowSel ? ' (its own row lights up)' : ''}`);
    await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await idle();
  }

  // Belts on the game's scrolling-belt shader (BA811382) slide their texture with the wheel they
  // wrap (belts.js): the Porcupine's chain with gears01 as its idle turns it, a tractor track with its
  // wheels (the WheelRotation slider). A tyre that turns with its own wheel does not slide.
  {
    const beltState = (steps) => js(`(() => { const a = window.__xo.state.animator, rig = a?.belts; if (!rig) return null;
      a.playing = false; a.sweep = false; ${steps.before} a.apply();
      const m = rig.mats[0], s = m.slots[0], d = rig.drives.find((x) => x.d === s.drive), acc0 = d.acc;
      ${steps.after} a.apply();
      const off = m.m.userData.xo.u.xoBeltOff.value[0].x, want = ((-s.k[0] * d.acc) % 1 + 1) % 1;
      return { drive: s.drive.name, k: s.k[0], turned: (d.acc - acc0) * 180 / Math.PI, off, want, xoBelt: 'XO_BELT' in m.m.defines,
        moving: rig.pieces.filter((p) => p.drive).length, pieces: rig.pieces.length };
    })()`);
    await js(`window.__xo.openModel('models/weapons/barrel_launcher/barrel_launcher.mdl', { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.belts`, 15000).catch(() => {});
    const chain = await beltState({ before: 'a.time = 0;', after: 'a.time = 0.02;' });
    ok(chain && chain.drive === 'gears01' && Math.abs(Math.abs(chain.k) - 0.34) < 0.02 && Math.abs(Math.abs(chain.turned) - 23) < 2 && Math.abs(chain.off - chain.want) < 1e-4 && chain.xoBelt && chain.moving === 2,
      `the Porcupine's chain slides with gears01 (${chain?.moving}/${chain?.pieces} pieces, ${chain?.k?.toFixed(3)} UV per radian; ${chain?.turned?.toFixed(1)}° of turn in 0.02 s)`);
    await js(`window.__xo.openModel('models/constructor/chassis/tracks/track_tractor/track_tractor.mdl')`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.belts`, 15000).catch(() => {});
    const track = await beltState({ before: `a.pose.WheelRotation = 0;`, after: `a.pose.WheelRotation = 30;` });
    ok(track && /^whl_rot_/.test(track.drive) && Math.abs(Math.abs(track.turned) - 30) < 1 && Math.abs(track.off - track.want) < 1e-4 && track.moving === track.pieces,
      `a tractor track slides with its wheels (${track?.moving}/${track?.pieces} pieces on ${track?.drive}; WheelRotation +30 turns it ${track?.turned?.toFixed(1)}°)`);
    await js(`window.__xo.openModel('models/constructor/chassis/wheels/wheel_light.mdl')`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded`, 15000).catch(() => {});
    ok(await js(`window.__xo.state.animator?.loaded === true && window.__xo.state.animator.belts === null`), 'a wheel on that shader keeps its tyre still on the wheel (it turns with it)');
  }

  // The Porcupine's FIRE: the next barrel rolls straight in from the back slot, 61 cm along the
  // launcher (its own clip first, then the idle it adds: with the idle first, the idle's spin swung
  // the roll round a 61 cm circle through the cage); the barrel resting in the back slot gives way
  // while that one passes through its place; the front one flies off as a round of its own when it
  // fires (the game's barrel model, FxView: no copy of the loaded one left behind); a reload rolls a
  // new one in without firing.
  {
    await js(`window.__xo.openModel('models/weapons/barrel_launcher/barrel_launcher.mdl', { assembled: true })`);
    await idle();
    await waitFor(`window.__xo.state.assembled && !!window.__xo.state.animator?.loaded`, 15000);
    const r = await js(`(() => {
      const a = window.__xo.state.animator, v = window.__xo.viewer, part = v.part, att = part.userData.attached, V3 = v.camera.position.constructor;
      const front = () => { part.updateMatrixWorld(true); return att[0].getWorldPosition(new V3()).applyMatrix4(part.matrixWorld.clone().invert()); };
      a.playing = true; a.sweep = false; a.speed = 1;
      a.setActive('inactive'); for (let i = 0; i < 5; i++) a.tick(0.02);
      v.fx.clear();
      a.setActive('fire');
      const fired = (part.userData.shots || []).length;
      let offAxis = 0, minZ = 1e9, maxZ = -1e9, backHidden = false, backBack = false;
      for (let i = 0; i < 40; i++) {
        a.tick(0.02);
        const p = front();
        offAxis = Math.max(offAxis, Math.abs(p.y - 0.482), Math.abs(p.x));
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
        if (i === 5) backHidden = !att[1].visible;
        if (i >= 36 && att[1].visible) backBack = true;
      }
      const flown = (part.userData.shots || []).length;
      const rounds = v.fx.shots.filter((s) => (s.spec.mesh || '').endsWith('barrel_launcher/barrel.mdl')).length;
      a.setActive('inactive'); for (let i = 0; i < 3; i++) a.tick(0.02);
      v.fx.clear();
      a.setActive('reload'); for (let i = 0; i < 20; i++) a.tick(0.02);
      const reloadShots = (part.userData.shots || []).length + v.fx.shots.length;
      a.setActive('inactive');
      v.fx.clear();
      return { offAxis, minZ, maxZ, fired, flown, rounds, backHidden, backBack, reloadShots, names: att.map((g) => g.userData.nodeName) };
    })()`);
    ok(r.names.join() === 'deploy_01,deploy_02' && r.offAxis < 0.01 && r.minZ < -0.2 && r.maxZ > 0.38,
      `firing, the Porcupine's next barrel rolls straight in from the back slot (z ${r.minZ.toFixed(2)} to ${r.maxZ.toFixed(2)} m, at most ${(r.offAxis * 100).toFixed(1)} cm off its line)`);
    ok(r.fired === 0 && r.flown === 0 && r.rounds === 1 && r.backHidden && r.backBack && r.reloadShots === 0,
      `the front barrel flies off as the game's barrel when it fires (${r.rounds} round, no copy of the loaded one), the back one gives way while the next one passes, and a reload fires nothing`);
  }
  // Clip translations are in the parent's frame (Maya's translate): a recoil kicks the barrel back,
  // a crossbow's limbs snap forward as mirror images. Read in the bone's own frame, the heavy gun's
  // barrel kicked forward and the triple crossbow's right limb swung back while the left went forward.
  {
    const slide = async (mdl, act, t, bones) => {
      await js(`window.__xo.openModel(${JSON.stringify(mdl)}, { assembled: false })`);
      await idle();
      await waitFor(`!!window.__xo.state.animator?.loaded`, 15000);
      return js(`(() => {
        const a = window.__xo.state.animator, v = window.__xo.viewer, part = v.part, V3 = v.camera.position.constructor;
        const at = () => { part.updateMatrixWorld(true); const inv = part.matrixWorld.clone().invert(); return ${JSON.stringify(bones)}.map((n) => a.skel.bones[a.boneOf.get(n)].getWorldPosition(new V3()).applyMatrix4(inv)); };
        a.playing = false; a.sweep = false; a.setActive(null); const rest = at();
        a.setActive(${JSON.stringify(act)}); a.time = ${t} / (a.layers.get(${JSON.stringify(act)}).speed || 1); a.apply(); const moved = at(); // (t: the clip's own time)
        a.setActive(null);
        return moved.map((p, i) => p.sub(rest[i]).toArray());
      })()`);
    };
    const [recoil] = await slide('models/weapons/heavygun_2types_legend/heavygun_2types_legend.mdl', 'fire_1', 0.1, ['recoil_barel']);
    const limbs = await slide('models/weapons/trible_crossbow/trible_crossbow.mdl', 'fire', 0.11, ['arc_left', 'arc_right']);
    const [l, r] = limbs;
    ok(recoil[2] < -0.1 && Math.abs(recoil[0]) < 0.01 && Math.abs(recoil[1]) < 0.01,
      `a recoil kicks back along the barrel (the heavy gun's barrel ${(recoil[2] * 100).toFixed(1)} cm along Z)`);
    ok(l[2] > 0.05 && r[2] > 0.05 && Math.abs(l[2] - r[2]) < 0.01 && Math.abs(l[0] + r[0]) < 0.01,
      `a crossbow's limbs snap forward as mirror images (left ${l.map((x) => (x * 100).toFixed(1)).join('/')} cm, right ${r.map((x) => (x * 100).toFixed(1)).join('/')} cm)`);
  }
  // Firing effects (fx.js reads the game's particle files, fxview.js draws them, fxmap.js says which
  // gun fires which): every .psys in the game reads; each gun's matched effect is there; firing the
  // 57 mm cannon plays its effect at its fire point (the flash, flame and smoke on screen) and it
  // ends on its own; the Effects menu shows for guns only, and Off stops them.
  {
    const parse = await js(`(async () => {
      const { parsePsys } = await import('./fx.js');
      const names = window.__xo.state.files.map((f) => f.name).filter((n) => n.startsWith('particles/') && n.endsWith('.psys'));
      let good = 0, emitters = 0; const bad = [];
      for (let i = 0; i < names.length; i += 64) {
        await Promise.all(names.slice(i, i + 64).map(async (n) => {
          try { const s = parsePsys(await (await fetch('https://xo.data/raw?path=' + encodeURIComponent(n))).arrayBuffer()); emitters += s.emitters.length; good++; } catch (e) { bad.push(n + ': ' + e.message); }
        }));
      }
      return { n: names.length, good, emitters, bad: bad.slice(0, 3) };
    })()`);
    ok(parse.n > 2000 && parse.good === parse.n, `every particle effect in the game reads (${parse.good} of ${parse.n}, ${parse.emitters} emitters)${parse.bad.length ? ': ' + parse.bad.join(' | ') : ''}`);
    const mapped = await js(`(async () => { const { FX_TABLE } = await import('./fxmap.js'); const have = new Set(window.__xo.state.files.map((f) => f.name));
      const all = [...Object.values(FX_TABLE.BY_FOLDER), ...Object.values(FX_TABLE.BY_MODEL)]; return { n: all.length, missing: all.filter((p) => !have.has('particles/' + p + '.psys')) }; })()`);
    ok(mapped.n > 150 && !mapped.missing.length, `every gun's matched muzzle effect is in the game (${mapped.n} guns${mapped.missing.length ? '; missing ' + mapped.missing.join(', ') : ''})`);
    const gun = 'models/weapons/heavygun_6pounder/heavygun_6pounder.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(gun)}, { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded`, 15000);
    const fxState = `(() => { const v = window.__xo.viewer; let quads = 0;
      for (const r of v.fx.runs) for (const d of r.draws) { if (!d) continue; if (d.items) for (const it of d.items) quads += it.im.count; else quads += d.mesh.geometry.drawRange.count / 6; }
      return { runs: v.fx.runs.length, quads }; })()`;
    const menu = await js(`(() => { const sel = document.getElementById('fxSel'); return { shown: !document.getElementById('fxRow').hidden, first: sel.options[0]?.textContent, n: sel.options.length }; })()`);
    ok(menu.shown && /cannon\/tank_cannon_muzzle$/.test(menu.first) && menu.n > 100, `a gun's Animation card offers its firing effects (${menu.first}; ${menu.n} to pick from)`);
    // (sampled frame by frame: the flash and flame live a fifth of a second)
    const firing = await js(`(async () => {
      const v = window.__xo.viewer, a = window.__xo.state.animator, b = v.part.userData.skeleton.bones.find((x) => x.name === 'fire_01');
      a.setActive([...a.layers.values()].find((l) => l.activity === 'FIRE').name);
      a.playing = true;
      let quads = 0, spawned = 0, off = Infinity, runs = 0;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        let q = 0;
        b.updateWorldMatrix(true, false);
        const e = b.matrixWorld.elements;
        for (const r of v.fx.runs) {
          spawned = Math.max(spawned, r.run.spawned);
          for (const d of r.draws) { if (!d) continue; if (d.items) for (const it of d.items) q += it.im.count; else q += d.mesh.geometry.drawRange.count / 6; }
          for (const { p } of r.run.particles()) off = Math.min(off, Math.hypot(p.home[0] - e[12], p.home[1] - e[13], p.home[2] - e[14]));
        }
        quads = Math.max(quads, q);
        runs = Math.max(runs, v.fx.runs.length);
      }
      return { quads, spawned, off, runs };
    })()`);
    ok(firing.runs >= 1 && firing.spawned >= 5 && firing.quads >= 3, `firing the 57 mm cannon plays its muzzle effect (${firing.runs} shot(s), ${firing.spawned} particles, up to ${firing.quads} sprites on screen)`);
    ok(firing.off < 1e-3, `its particles come from the gun's fire_01 node (${(firing.off * 1000).toFixed(2)} mm off)`);
    await js(`window.__xo.state.animator.playing = false; window.__xo.viewer.stopShots();`);
    await waitFor(`window.__xo.viewer.fx.runs.length === 0`, 8000).catch(() => {});
    ok((await js(fxState)).runs === 0, 'the effect ends on its own once the gun stops firing (nothing left drawing)');
    await js(`(() => { const s = document.getElementById('fxSel'); s.value = 'off'; s.dispatchEvent(new Event('change')); const a = window.__xo.state.animator; a.time = 0; a.shotCycle = null; a.playing = true; })()`);
    await sleep(400);
    const off = await js(fxState);
    await js(`(() => { window.__xo.state.animator.playing = false; const s = document.getElementById('fxSel'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
    ok(off.runs === 0 && (await js(`!(window.__xo.state.settings.fxPick || {})[${JSON.stringify(gun)}]`)), 'Off in the menu fires without effects (and Matched brings them back, remembered per part)');
    // 2.41 flip-books (fx.js textureRoles): a hit on a car (hit_car_mid, the AC96 Anomaly's on the
    // target) draws its smoke from the _naa (shading, density) morphing along the _mv motion vectors.
    // The vectors drawn as its colour showed as a plain olive square: now the sprite's corners stay
    // see-through and its middle shows the smoke (the view with and without it; 4 m up in the open,
    // clear of the stage floor that sprites fade into).
    const book = await js(`(async () => {
      const v = window.__xo.viewer, fx = v.fx, M = v.camera.matrixWorld.constructor, T = v.camera.position.constructor, g = document.getElementById('view').getContext('webgl2');
      const cp = v.camera.position.clone(), ct = v.controls.target.clone(), y = v.floor.position.y + 4;
      v.camera.position.set(0, y, -10); v.controls.target.set(0, y, 0); v.controls.update(); v.camera.updateMatrixWorld();
      fx.clear(); fx.paused = true;
      const m = new M().makeTranslation(0, y, 0).elements;
      const run = await fx.play('particles/materials/car/hit_car_mid', () => m, { seed: 10 }); // (a dense one: its alpha x a random 0..1)
      const d = fx.runs.find((r) => r.run === run)?.draws[0];
      if (!d) return { err: 'no smoke layer' };
      for (let i = 0; i < 100 && !(d.u.ready.value && d.u.hasMv?.value); i++) await new Promise((r) => setTimeout(r, 50));
      for (let t = 0; t < 0.12; t += 1 / 60) fx.advance(1 / 60);
      const w = g.drawingBufferWidth, h = g.drawingBufferHeight;
      const grab = (shown) => { fx.root.visible = shown; if (fx.hazeScene) fx.hazeScene.visible = shown; v.render(); const px = new Uint8Array(4 * w * h); g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
      const without = grab(false), withIt = grab(true);
      fx.root.visible = true; if (fx.hazeScene) fx.hazeScene.visible = true;
      // the quad's corners and middle on screen; 3x3 pixels around a point: how much the smoke changed them
      const corner = [0, 1, 2, 3].map((k) => new T(d.pos[k * 3], d.pos[k * 3 + 1], d.pos[k * 3 + 2]));
      const mid = corner.reduce((a, c) => a.add(c), new T()).multiplyScalar(0.25);
      const scr = (p) => { const q = p.clone().project(v.camera); return [Math.round((q.x + 1) / 2 * w), Math.round((q.y + 1) / 2 * h)]; };
      const change = ([x, y]) => { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const i = (Y * w + X) * 4; s += (Math.abs(withIt[i] - without[i]) + Math.abs(withIt[i + 1] - without[i + 1]) + Math.abs(withIt[i + 2] - without[i + 2])) / 3; n++; } return n ? s / n : 0; };
      const corners = corner.map((c) => change(scr(mid.clone().lerp(c, 0.85))));
      const middle = change(scr(mid));
      const out = { map: (d.u.map.value?.name || '').split('/').pop(), naa: d.u.naa?.value, mv: d.u.hasMv?.value, k: d.nx?.[2], corners, middle, n: d.mesh.geometry.drawRange.count / 6 };
      fx.clear(); fx.paused = false;
      v.camera.position.copy(cp); v.controls.target.copy(ct); v.controls.update(); v.dirty = true;
      return out;
    })()`);
    ok(!book.err && book.map === 'smoke_naa' && book.naa === 1 && book.mv === 1 && book.n >= 1 && Math.max(...book.corners) < 3 && book.middle > 6,
      `a 2.41 flip-book (a hit on a car) draws its smoke from smoke_naa, morphing along smoke_mv (frame blend ${book.k?.toFixed(2)}): no square, its corners unchanged (${book.corners?.map((x) => x.toFixed(1)).join(' / ')}), its middle smoke (${book.middle?.toFixed(1)})${book.err ? ': ' + book.err : ''}`);
    // the water's own deformation layers (blend 8, particles/textures/water/layered: _v displacement,
    // _w normal and foam) push its surface in the game and are not drawn: the CC-18 Typhoon's muzzle
    // showed its two as rainbow squares along the barrel
    const wet = await js(`(async () => {
      const fx = window.__xo.viewer.fx, M = window.__xo.viewer.camera.matrixWorld.constructor, m = new M().elements;
      fx.clear(); fx.paused = true;
      const run = await fx.play('particles/weapons/cannon/tank_cannon_relic_muzzle', () => m, { seed: 1 });
      const r = fx.runs.find((x) => x.run === run), es = run.sys.emitters;
      const out = { water: es.filter((e) => e.blend === 8).length, waterDrawn: r.draws.filter((d, i) => d && es[i].blend === 8).length, drawn: r.draws.filter(Boolean).length, of: es.length };
      fx.clear(); fx.paused = false;
      return out;
    })()`);
    ok(wet.water === 2 && wet.waterDrawn === 0 && wet.drawn >= 6, `the water's deformation layers are not drawn as sprites: the CC-18 Typhoon's muzzle draws ${wet.drawn} of its ${wet.of} layers, none of its ${wet.water} water ones (${wet.waterDrawn})`);
    // The beat (anim.js gunBeat): the cannon fires as in the game, once per its reload time (6 s: the
    // Shot every box says so), holding still in between; the shot timer overrides it, and emptied, the
    // game's pace is back. A rocket pod with a reload fires a salvo (a rocket from each tube, one after
    // another), a machine gun fires non-stop at its own pace. (The clock stepped by hand, 50 ms a time.)
    const beatRun = (secs) => js(`(() => {
      const a = window.__xo.state.animator, v = window.__xo.viewer;
      const fire = a.activities().find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity));
      const sel = document.getElementById('animSel'); sel.value = fire.name; sel.dispatchEvent(new Event('change'));
      const shots = [], times = [], onShot = v.onShot;
      let clock = 0;
      v.onShot = function (...x) { shots.push(+clock.toFixed(2)); return onShot.apply(this, x); };
      try { for (let i = 0; i < ${secs} / 0.05; i++) { a.playing = true; a.tick(0.05); a.playing = false; clock += 0.05; times.push(a.time); } }
      finally { v.onShot = onShot; v.stopShots(); }
      return { shots, still: times.slice(30, 100).every((t) => t === times[30]), holder: document.getElementById('fxEvery').placeholder };
    })()`);
    const setEvery = (s) => js(`(() => { const e = document.getElementById('fxEvery'); e.value = ${JSON.stringify(String(s))}; e.dispatchEvent(new Event('change')); return window.__xo.viewer.fireEvery; })()`);
    const near = (a, b) => Math.abs(a - b) <= 0.06;
    await setEvery('');
    const game = await beatRun(13);
    ok(game.holder === 'game: 6' && game.shots.length === 3 && near(game.shots[1], 6) && near(game.shots[2], 12) && game.still,
      `the 57 mm cannon fires as in the game, once per its 6 s reload, holding still in between (shots at ${game.shots.join(', ')} s; the box says "${game.holder}")`);
    const timed = (await setEvery(2)) === 2 ? await beatRun(7) : null;
    ok(timed && timed.shots.length === 4 && timed.shots.every((t, i) => near(t, i * 2)), `Shot every 2 s fires it every 2 s instead (${timed?.shots.join(', ')})`);
    await setEvery('');
    const back = await beatRun(7);
    ok(back.shots.length === 2 && near(back.shots[1], 6) && !(await js('window.__xo.state.settings.fireEvery')), `emptied, the game's 6 s is back (${back.shots.join(', ')})`);
    const podPath = 'models/weapons/nurs_multy/nurs_multy.mdl', mgun = 'models/weapons/machinegun_kpvt/machinegun_kpvt.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(podPath)}, { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded && window.__xo.state.info?.path === ${JSON.stringify(podPath)}`, 15000);
    const salvo = await beatRun(7);
    const first = salvo.shots.filter((t) => t < 5), gaps = first.slice(1).map((t, i) => t - first[i]);
    ok(salvo.holder === 'game: 5.5' && first.length === 10 && gaps.every((g) => g > 0.15 && g < 0.35) && near(salvo.shots[10], 5.5),
      `a rocket pod with a reload fires a salvo: the Cricket's 10 tubes one after another (${first.length} rockets in ${(first[first.length - 1] || 0).toFixed(2)} s), the next salvo at ${salvo.shots[10]} s`);
    await js(`window.__xo.openModel(${JSON.stringify(mgun)}, { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded && window.__xo.state.info?.path === ${JSON.stringify(mgun)}`, 15000);
    const mgBeat = await beatRun(2);
    ok(mgBeat.holder === 'own pace' && mgBeat.shots.length >= 9, `a machine gun fires non-stop at its own pace, as in the game (${mgBeat.shots.length} shots in 2 s)`);
    // Rounds: they leave the fire points with the game's projectile effects (a machine gun round's
    // glowing dot and tracer streak ride it) and land with its hit effects: on the training target
    // (a car's sheet metal) standing 10 m out while Fire is picked, the camera swung behind the gun
    // to see it; on the ground when "Shots hit" says only the ground.
    const mg = 'models/weapons/machinegun_kpvt/machinegun_kpvt.mdl';
    await js(`window.__xo.openModel(${JSON.stringify(mg)}, { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded`, 15000);
    await js(`(() => { const t = document.getElementById('fxTarget'); t.value = '10'; t.dispatchEvent(new Event('change')); })()`);
    const volley = (pick) => js(`(async () => {
      const xo = window.__xo, v = xo.viewer, a = xo.state.animator;
      const lands = [], fired = [];
      const imp = v.fx.impact.bind(v.fx), fire = v.fx.fire.bind(v.fx);
      v.fx.impact = (p, h) => { lands.push({ p, s: h.surface, at: h.point }); return imp(p, h); };
      v.fx.fire = (...args) => { const s = fire(...args); fired.push(s); return s; };
      ${pick ? `const sel = document.getElementById('animSel'); sel.value = [...a.layers.values()].find((l) => l.activity === 'FIRE').name; sel.dispatchEvent(new Event('change'));` : 'a.time = 0; a.shotCycle = null; a.playing = true;'}
      const t0 = performance.now(); // (1.6 s of real time: frames come faster than 60 a second on some screens)
      while (performance.now() - t0 < 1600) await new Promise((r) => requestAnimationFrame(r));
      a.playing = false;
      delete v.fx.impact; delete v.fx.fire;
      const box = v.part.userData.box, tb = v.target?.visible ? new box.constructor().setFromObject(v.target) : null;
      v.camera.updateMatrixWorld();
      const c = tb && tb.getCenter(box.min.clone()).applyMatrix4(v.camera.matrixWorldInverse);
      const seen = !!c && c.z < 0 && (c.applyMatrix4(v.camera.projectionMatrix), Math.abs(c.x) < 1 && Math.abs(c.y) < 1);
      return { shown: !!tb, row: !document.getElementById('fxTargetRow').hidden, tz: tb ? [tb.min.z, tb.max.z] : null, ty: tb ? tb.min.y : null, front: box.max.z, back: box.min.z, ground: v.groundY(),
        camZ: v.camera.position.z, seen, fired: fired.length, proj: fired.filter((s) => s.run).length, lands };
    })()`);
    const range = await volley(true);
    const tMid = range.tz ? (range.tz[0] + range.tz[1]) / 2 : 0;
    ok(range.shown && range.row && tMid > range.front + 9 && tMid < range.front + 12.5 && Math.abs(range.ty - range.ground) < 0.1,
      `picking Fire stands the training target down-range on the floor (its middle ${range.tz ? (tMid - range.front).toFixed(1) : '-'} m beyond the gun)`);
    ok(range.camZ < range.back && range.seen, `the camera swings behind the gun with the target in view (camera z ${range.camZ.toFixed(1)}, the gun's back ${range.back.toFixed(2)})`);
    const onTarget = range.lands.filter((l) => l.s === 1 && l.p === 'particles/materials/car/hit_car_small' && l.at[2] >= range.tz[0] - 0.01 && l.at[2] <= range.tz[1] + 0.01);
    ok(range.fired >= 5 && range.proj >= 3 && range.lands.length >= 3 && onTarget.length === range.lands.length,
      `rounds fly from the gun with their projectile effect (${range.proj} of ${range.fired}) and land on the target with the game's sparks for a car (${onTarget.length} of ${range.lands.length} hits)`);
    // one round held still in flight (650 m/s: it crosses the 10 m in a frame), 7.8 m out: its tracer
    // streak rides it and trails back from its head along the flight, never back past the muzzle
    // (measured on a shot whose tracer draws one streak: with two alive, the first quad drawn need not
    // be the particle measured; up to four shots)
    const tracer = await js(`(async () => {
      const xo = window.__xo, v = xo.viewer, a = xo.state.animator;
      a.playing = false;
      let out = {};
      for (let attempt = 0; attempt < 4; attempt++) {
      v.fx.clear();
      v.fx.paused = true;
      v.onShot(v.part, 'FIRE', 0, xo.state.info);
      for (let i = 0; i < 30 && !v.fx.shots[0]?.run; i++) await new Promise((r) => setTimeout(r, 50)); // (its effect file)
      v.fx.advance(0.012);
      const s = v.fx.shots[0];
      out = { round: !!s, run: !!s?.run, attempt };
      if (s?.run) {
        const l = Math.hypot(...s.vel), f = s.vel.map((x) => x / l);
        const r = v.fx.runs.find((x) => x.run === s.run), k = s.run.em.findIndex((e) => e.e.orient === 1);
        const p = s.run.em[k]?.parts.find((q) => q.local), d = r?.draws[k];
        if (p && d) {
          const g = d.pos, c = [0, 1, 2].map((j) => (g[j] + g[3 + j] + g[6 + j] + g[9 + j]) / 4);
          out.flow = p.flow ? p.flow.reduce((acc, x, j) => acc + x * f[j], 0) : 0;
          out.behind = c.reduce((acc, x, j) => acc + (x - p.pos[j]) * f[j], 0); // (the streak's middle, along the flight from its head)
          out.ahead = p.pos.reduce((acc, x, j) => acc + (x - s.pos[j]) * f[j], 0); // (its head, from the round)
          out.tail = c.reduce((acc, x, j) => acc + (2 * x - p.pos[j] - s.run.start[j]) * f[j], 0); // (its tail, from the muzzle)
          out.drawn = d.mesh.geometry.drawRange.count / 6;
        }
      }
      if (out.drawn === 1) break;
      }
      v.fx.clear();
      v.fx.paused = false;
      return out;
    })()`);
    ok(tracer.run && tracer.flow > 0.999 && tracer.behind < -0.5 && Math.abs(tracer.ahead) <= 6.01 && tracer.tail > -1e-3 && tracer.drawn >= 1,
      `a round's tracer streak rides it, trailing back along its flight (its head ${tracer.ahead?.toFixed(1)} m from the round, the streak's middle ${tracer.behind === undefined ? '-' : (-tracer.behind).toFixed(1)} m behind the head, its tail ${tracer.tail?.toFixed(2)} m past the muzzle)`);
    // only the ground: the target goes; the gun aimed down lands its rounds on the floor
    await js(`(() => { const t = document.getElementById('fxTarget'); t.value = '0'; t.dispatchEvent(new Event('change'));
      const a = window.__xo.state.animator, p = a.poses().find((x) => x.name === 'AimPitch'); a.setPose('AimPitch', Math.max(p.min, -12)); })()`);
    const ground = await volley(false);
    const onGround = ground.lands.filter((l) => l.s === 0 && l.p === 'particles/materials/ground/hit_ground_small' && Math.abs(l.at[1] - ground.ground) < 1e-6 && l.at[2] > ground.front && l.at[2] < ground.front + 15);
    ok(!ground.shown && ground.lands.length >= 3 && onGround.length === ground.lands.length, `"only the ground" takes the target away; aimed down, rounds hit the floor with the game's ground hits (${onGround.length} of ${ground.lands.length})`);
    // a grenade drops: fired level 1 m over the floor at 75 m/s, it lands 75 x sqrt(2 / 9.8) m out
    // (the target still away)
    const arc = await js(`(async () => {
      const { shotFor } = await import('./fxmap.js');
      const v = window.__xo.viewer, spec = shotFor('models/weapons/grenade_launcher/grenade_launcher.mdl');
      v.fx.paused = true;
      const y = v.groundY() + 1;
      let land = null;
      const imp = v.fx.impact.bind(v.fx);
      v.fx.impact = (p, h) => { land = { p, at: h.point, n: h.normal, s: h.surface }; return imp(p, h); };
      v.fx.fire(spec, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, y, 0, 1], [0, 0, 1], v.hitTest);
      for (let i = 0; i < 120 && v.fx.shots.length; i++) v.fx.advance(1 / 60);
      delete v.fx.impact;
      v.fx.paused = false;
      return { land, speed: spec.speed, g: spec.gravity, floor: y - 1 };
    })()`);
    const reach = arc.speed * Math.sqrt(2 / arc.g);
    ok(arc.land && arc.land.s === 0 && Math.abs(arc.land.at[2] - reach) < 1 && Math.abs(arc.land.at[1] - arc.floor) < 1e-6 && arc.land.n[1] === 1 && arc.land.p.endsWith('/explosion_ground_ags'),
      `a grenade arcs down onto the floor ${arc.land ? arc.land.at[2].toFixed(1) : '-'} m out (${reach.toFixed(1)} by the drop) and bursts with the game's ground explosion`);
    await js(`(() => { const a = window.__xo.state.animator; a.setPose('AimPitch', 0); const t = document.getElementById('fxTarget'); t.value = '10'; t.dispatchEvent(new Event('change')); })()`);
    // a gun whose barrel is at the cut-out's see-through height (the 57 mm cannon's, 0.72 m): the
    // target stands where its line meets metal
    await js(`window.__xo.openModel(${JSON.stringify(gun)}, { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded`, 15000);
    const meets = await js(`(async () => {
      const xo = window.__xo, v = xo.viewer, a = xo.state.animator;
      const sel = document.getElementById('animSel'); sel.value = [...a.layers.values()].find((l) => l.activity === 'FIRE').name; sel.dispatchEvent(new Event('change'));
      a.playing = false;
      v.stopShots();
      await new Promise((r) => setTimeout(r, 1500));
      const b = v.part.userData.skeleton.bones.find((x) => x.name === 'fire_01');
      b.updateWorldMatrix(true, false);
      const e = b.matrixWorld.elements, o = [e[12], e[13], e[14]], d = [e[8], e[9], e[10]], l = Math.hypot(...d);
      const h = v.hitTest(o, o.map((x, k) => x + d[k] / l * 40));
      return { y: o[1] - v.groundY(), surface: h ? h.surface : -1, shift: v.target.position.x - v.part.userData.box.getCenter(b.position.clone()).x };
    })()`);
    ok(meets.surface === 1, `the target stands where the cannon's barrel line meets it (barrel ${meets.y.toFixed(2)} m up; target ${meets.shift.toFixed(2)} m to the side)`);
    await js(`window.__xo.state.animator.playing = false; window.__xo.viewer.stopShots(); window.__xo.viewer.fx.clear();`);
    // Rockets, bolts, grenades fly as the game's models: every one named is in the game; a rocket
    // pod's rockets leave nose first, their smoke and flame at the rocket's nozzle (0.44 m back on the
    // slim rocket), and are gone once they land; a crossbow's bolts fly too
    const meshes = await js(`(async () => { const { FX_TABLE } = await import('./fxmap.js'); const have = new Set(window.__xo.state.files.map((f) => f.name));
      const all = [...new Set(Object.values(FX_TABLE.MESH_BY_FOLDER))]; return { n: all.length, missing: all.filter((p) => !have.has(p + '.mdl')) }; })()`);
    ok(meshes.n > 20 && !meshes.missing.length, `every round's model named is in the game (${meshes.n} models${meshes.missing.length ? '; missing ' + meshes.missing.join(', ') : ''})`);
    const flies = (mdl, t) => js(`(async () => {
      const xo = window.__xo;
      await xo.openModel(${JSON.stringify(mdl)}, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== ${JSON.stringify(mdl)} || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      const v = xo.viewer, a = xo.state.animator;
      const sel = document.getElementById('animSel'); sel.value = [...a.layers.values()].find((l) => /^(ACT_)?FIRE/.test(l.activity || '')).name; sel.dispatchEvent(new Event('change'));
      a.playing = false;
      v.stopShots(); v.fx.clear(); v.fx.paused = true;
      const spec = v.shotFor(xo.state.info.path);
      await v.fx.meshOf(spec.mesh);
      v.onShot(v.part, 'FIRE', 0, xo.state.info);
      await new Promise((r) => setTimeout(r, 400));
      for (let left = ${t}; left > 1e-6; left -= 1 / 120) v.fx.advance(Math.min(1 / 120, left));
      const rounds = v.fx.shots.map((s) => {
        s.obj?.updateMatrixWorld();
        const e = s.obj?.matrixWorld.elements, l = Math.hypot(...s.vel), f = s.vel.map((x) => x / l);
        const fx = s.run?.origin?.();
        return { inScene: !!s.obj?.parent, meshes: s.obj?.children.length || 0, nose: e ? (e[8] * f[0] + e[9] * f[1] + e[10] * f[2]) / Math.hypot(e[8], e[9], e[10]) : 0,
          at: e ? Math.hypot(e[12] - s.pos[0], e[13] - s.pos[1], e[14] - s.pos[2]) : 1, back: fx ? [12, 13, 14].reduce((acc, k, j) => acc + (s.pos[j] - fx[k]) * f[j], 0) : null };
      });
      for (let i = 0; i < 400 && v.fx.shots.length; i++) v.fx.advance(1 / 60);
      const left = v.fx.root.children.filter((c) => c.name === 'round').length;
      v.fx.clear(); v.fx.paused = false;
      return { mesh: spec.mesh, rounds, left };
    })()`);
    const pod = await flies('models/weapons/nurs_single/nurs_single.mdl', 0.03);
    const podOk = pod.rounds.length >= 1 && pod.rounds.every((r) => r.inScene && r.meshes > 0 && r.nose > 0.999 && r.at < 1e-6 && Math.abs(r.back - 0.444) < 0.01);
    ok(podOk && pod.left === 0 && /projectiles\/missile_01\.mdl$/.test(pod.mesh),
      `a rocket pod's rockets fly as the game's rocket, nose first, smoke and flame at its nozzle (${pod.rounds.length} in flight, ${pod.rounds.map((r) => r.back?.toFixed(2)).join(', ')} m behind the nose), gone once they land (${pod.left} left)`);
    const bow = await flies('models/weapons/crossbow_tempo_legend/crossbow_tempo_legend.mdl', 0.03);
    ok(bow.rounds.length >= 1 && bow.rounds.every((r) => r.inScene && r.meshes > 0 && r.nose > 0.999) && bow.left === 0 && /crossbow_tempo_legend_arrow\.mdl$/.test(bow.mesh),
      `a crossbow's bolt flies as its model, tip first (${bow.mesh.split('/').pop()})`);
    // A gun the game gives no animations (the vertical guided launcher) still offers Fire (and no
    // clips to export); its missiles go up out of their tubes and steer down onto the target
    const vls = await js(`(async () => {
      const xo = window.__xo, mdl = 'models/weapons/guided_support_epic/guided_support_epic.mdl';
      await xo.openModel(mdl, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      const v = xo.viewer, a = xo.state.animator;
      if (!a) return { animator: false };
      const sel = document.getElementById('animSel'), opts = [...sel.options].map((o) => o.textContent);
      const fire = [...a.layers.values()].find((l) => l.activity === 'FIRE');
      sel.value = fire.name; sel.dispatchEvent(new Event('change'));
      a.playing = false;
      await new Promise((r) => setTimeout(r, 1500)); // (the target)
      v.stopShots(); v.fx.clear(); v.fx.paused = true;
      const lands = [], imp = v.fx.impact.bind(v.fx);
      v.fx.impact = (p, h) => { lands.push(h.surface); return imp(p, h); };
      v.onShot(v.part, 'FIRE', 0, xo.state.info);
      await new Promise((r) => setTimeout(r, 400));
      const up = v.fx.shots.map((s) => s.vel[1] / Math.hypot(...s.vel));
      for (let i = 0; i < 360 && v.fx.shots.length; i++) v.fx.advance(1 / 120);
      delete v.fx.impact;
      v.fx.clear(); v.fx.paused = false;
      return { animator: true, opts, card: !document.getElementById('animCard').hidden, exportAnim: !document.getElementById('expAnimWrap').hidden, own: !!a.ownFire, up, lands };
    })()`);
    ok(vls.animator && vls.own && vls.card && vls.opts.includes('Fire') && !vls.exportAnim,
      `a launcher with no animations of its own still offers Fire (${vls.opts?.join(' / ')}; no clips offered to the export)`);
    ok(vls.up?.length >= 1 && vls.up.every((y) => y > 0.9) && vls.lands.length === vls.up.length && vls.lands.every((x) => x === 1),
      `its guided missiles leave straight up (${vls.up?.map((y) => y.toFixed(2)).join(', ')}) and steer down onto the target (${vls.lands.filter((x) => x === 1).length} of ${vls.up?.length} hit it)`);
    // Sound: the game's own samples (its FMOD banks: the host lists them at /sounds and hands one out
    // as Ogg Vorbis, which the page decodes). Once a click has let the page's audio start, a gun
    // firing sounds its shots where it fires and its hits where they land, and its burst's echo once
    // it stops; a minigun's motor spins up, its firing loop holds while it fires and it runs down
    // after; the volume at 0 is silence. (The test app runs muted.)
    const sndList = await js(`(async () => {
      const s = window.__xo.viewer.sounds, m = await s.names(), b = await s.buffer('hmg_grain1_p');
      return { n: m.size, loops: [...m.values()].filter((x) => x.loop).length, dur: b?.duration, listed: m.get('hmg_grain1_p')?.seconds, ch: b?.numberOfChannels };
    })()`);
    ok(sndList.n > 4000 && sndList.loops > 50 && Math.abs(sndList.dur - sndList.listed) < 0.002 && sndList.ch === 2,
      `the game's sounds are listed (${sndList.n} effect samples, ${sndList.loops} with loop points) and decode (hmg_grain1_p: ${sndList.dur?.toFixed(3)} s, ${sndList.ch} channels)`);
    const hearFire = (mdl) => js(`(async () => {
      const xo = window.__xo, v = xo.viewer, s = v.sounds, mdl = ${JSON.stringify(mdl)};
      await xo.openModel(mdl, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      const a = xo.state.animator, asked = [], play = s.play.bind(s), p0 = s.played;
      s.play = (f, pos, o) => { asked.push({ f: Array.isArray(f) ? f.join('|') : f, pos: !!pos, loop: !!o?.loop }); return play(f, pos, o); };
      const sel = document.getElementById('animSel'); sel.value = [...a.layers.values()].find((l) => /^(ACT_)?FIRE/.test(l.activity || '')).name; sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 2000));
      const firing = s.guns.size, loops = s.voices.filter((x) => x.loop).length;
      a.playing = false; v.stopShots();
      await new Promise((r) => setTimeout(r, 300));
      delete s.play;
      return { row: !document.getElementById('fxSoundRow').hidden, state: s.ctx?.state, asked, played: s.played - p0, firing, loops, after: s.guns.size + s.voices.filter((x) => x.loop).length };
    })()`);
    await js(`window.__xo.openModel('models/weapons/machinegun_kpvt/machinegun_kpvt.mdl', { assembled: false })`);
    await idle();
    const head = await js(`(() => { const h = [...document.querySelectorAll('h3')].find((x) => x.textContent === 'Animation' && x.offsetParent); const r = h.getBoundingClientRect(); return [r.left + 8, r.top + r.height / 2]; })()`);
    await app.click(head[0], head[1]); // (a click: the page may start its audio)
    const fam = (r, f) => r.asked.filter((x) => x.f === f).length;
    const kp = await hearFire('models/weapons/machinegun_kpvt/machinegun_kpvt.mdl');
    ok(kp.row && kp.state === 'running' && fam(kp, 'hmg_grain') >= 3 && fam(kp, 'mg_bullet_car|mg_bullet_car_armor') >= 2 && fam(kp, 'dshk_tail_add') === 1 && kp.asked.every((x) => x.pos) && kp.played >= 5 && kp.after === 0,
      `firing, the Vector sounds the game's heavy machine gun shots at the gun (${fam(kp, 'hmg_grain')}), bullets hitting a car at the target (${fam(kp, 'mg_bullet_car|mg_bullet_car_armor')}) and its burst's echo once it stops (${kp.played} sounds started)`);
    const mini = await hearFire('models/weapons/minigun_m134/minigun_m134.mdl');
    ok(fam(mini, 'minigun_motor_start_loop') === 1 && mini.asked.some((x) => x.f === 'minigun_loop_p' && x.loop) && mini.loops === 1 && fam(mini, 'minigun_motor_stop') === 1 && mini.after === 0,
      `a minigun's motor spins up and its firing loop holds while it fires (${mini.loops} held), then runs down once it stops (nothing left playing: ${mini.after})`);
    await js(`(() => { const r = document.getElementById('fxVolume'); r.value = '0'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
    const hush = await hearFire('models/weapons/machinegun_kpvt/machinegun_kpvt.mdl');
    const hushShown = await js(`document.getElementById('fxVolumeVal').textContent`);
    await js(`(() => { const r = document.getElementById('fxVolume'); r.value = '70'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()`);
    ok(hush.played === 0 && hushShown === 'off' && (await js(`window.__xo.state.settings.fxVolume`)) === 0.7, `the Sound slider at 0 is silence ("${hushShown}"; ${hush.played} started), and it is remembered`);
    // other activities sound too: a chainsaw's attack holds its motor while it plays, the Porcupine's
    // reload clanks once a loop; far off a blast sounds as the game's distant one, a bullet not at all
    const actSound = (mdl, act) => js(`(async () => {
      const xo = window.__xo, v = xo.viewer, s = v.sounds, mdl = ${JSON.stringify(mdl)};
      await xo.openModel(mdl, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      const a = xo.state.animator, asked = [], play = s.play.bind(s);
      s.play = (f, pos, o) => { asked.push((Array.isArray(f) ? f.join('|') : f) + (o?.loop ? ' (loop)' : '')); return play(f, pos, o); };
      const layer = [...a.layers.values()].find((l) => l.activity === ${JSON.stringify(act)});
      const sel = document.getElementById('animSel'); sel.value = layer.name; sel.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 1500));
      const held = s.guns.has(v.part), row = !document.getElementById('fxSoundRow').hidden;
      a.playing = false; v.stopShots();
      await new Promise((r) => setTimeout(r, 300));
      delete s.play;
      return { asked: [...new Set(asked)], held, row, after: s.guns.size };
    })()`);
    const chainsaw = await actSound('models/weapons/chainsaw/chainsaw.mdl', 'ATTACK');
    ok(chainsaw.asked.includes('melee_top_p (loop)') && chainsaw.held && chainsaw.row && chainsaw.after === 0, `a chainsaw's attack holds its motor while it plays (${chainsaw.asked.join(', ')}), with the Sound slider shown`);
    const reload = await actSound('models/weapons/barrel_launcher/barrel_launcher.mdl', 'CUSTOM1');
    ok(reload.asked.includes('catapult_ready'), `the Porcupine's reload sounds (${reload.asked.join(', ')})`);
    // Record: a clip of the view with the game's sounds (the Vector firing), saved as MP4 with a video
    // and a sound track; the button shows the time while it records
    {
      const recAt = await js(`(async () => {
        const xo = window.__xo, mdl = 'models/weapons/machinegun_kpvt/machinegun_kpvt.mdl';
        await xo.openModel(mdl, { assembled: false });
        for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
        const r = document.getElementById('recBtn').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];
      })()`);
      await app.click(recAt[0], recAt[1]);
      await js(`(() => { const a = window.__xo.state.animator; const sel = document.getElementById('animSel'); sel.value = [...a.layers.values()].find((l) => l.activity === 'FIRE').name; sel.dispatchEvent(new Event('change')); })()`);
      await sleep(1800);
      const clipFile = path.join(outDir, 'clip');
      const rec = await js(`(async () => {
        const rec = window.__xo.recorder(), { dataUrlOf } = await import('./recorder.js'), label = document.getElementById('recBtn').textContent;
        const res = await rec.stop();
        window.__xo.state.animator.playing = false; window.__xo.viewer.stopShots();
        const saved = res && await window.__xo.call('saveVideo', { dataUrl: await dataUrlOf(res.blob), ext: res.ext, outPath: ${JSON.stringify(clipFile)} + '.' + res.ext });
        return { label, ext: res?.ext, saved, after: document.getElementById('recBtn').textContent };
      })()`);
      const clip = rec.saved?.path && fs.existsSync(rec.saved.path) ? fs.readFileSync(rec.saved.path) : null;
      const tracks = clip && rec.ext === 'mp4' ? ['vide', 'soun'].filter((h) => clip.indexOf(Buffer.from('hdlr')) >= 0 && clip.includes(Buffer.from(h))) : [];
      ok(clip && clip.length > 20000 && /^Stop 0:0[12]$/.test(rec.label) && rec.after === 'Record' && (rec.ext === 'webm' ? clip.readUInt32BE(0) === 0x1a45dfa3 : clip.toString('latin1', 4, 8) === 'ftyp' && tracks.length === 2),
        `Record saves a clip of the view with its sounds (${rec.ext}, ${clip ? Math.round(clip.length / 1024) : 0} KB, ${tracks.join(' + ') || 'tracks?'}; the button read "${rec.label}")`);
    }
    const far = await js(`(async () => { const { heardFrom } = await import('./soundmap.js'); return [heardFrom('medium_explosion_close', 30), heardFrom('medium_explosion_close', 200), heardFrom('mg_bullet_car', 60), heardFrom('mg_bullet_car', 200)]; })()`);
    ok(far[0] === 'medium_explosion_close' && far[1] === 'common_explosion_far' && far[2] === 'mg_bullet_car' && far[3] === null,
      `far off a blast sounds as the game's distant one (${far[1]} at 200 m), a bullet's hit is not heard past earshot`);
    // One shot of a gun held still and moved on by hand (the target 10 m out): what its rounds do,
    // step by step. act: the activity that fires (a second fire mode); t: seconds; every: a snapshot so often.
    const trace = (mdl, { act = null, t = 2, every = 0.1 } = {}) => js(`(async () => {
      const xo = window.__xo, v = xo.viewer, mdl = ${JSON.stringify(mdl)};
      await xo.openModel(mdl, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      const a = xo.state.animator, fire = [...a.layers.values()].find((l) => /^(ACT_)?FIRE|^BURST/i.test(l.activity || ''));
      const sel = document.getElementById('animSel'); sel.value = fire.name; sel.dispatchEvent(new Event('change'));
      a.playing = false;
      await new Promise((r) => setTimeout(r, 1500)); // (the target, the camera)
      v.stopShots(); v.fx.clear(); v.fx.paused = true;
      const act = ${JSON.stringify(act)} || fire.activity, spec = v.shotFor(xo.state.info.path, act);
      if (spec?.mesh) await v.fx.meshOf(spec.mesh);
      if (spec?.stuck) await v.fx.meshOf(spec.stuck);
      for (const p of [spec?.proj, spec?.beam, spec?.rope, spec?.work, spec?.boom, spec?.fenceBeam, ...(spec?.hits || [])]) if (p) await v.fx.load(p);
      const lands = [], imp = v.fx.impact.bind(v.fx), played = [], play = v.fx.play.bind(v.fx);
      v.fx.impact = (p, h) => { lands.push({ p: p.split('/').pop(), s: h.surface, at: h.point }); return imp(p, h); };
      v.fx.play = (p, ...r) => { played.push(p.split('/').pop()); return play(p, ...r); };
      const b = v.fireBones(v.part)[0]; b.updateWorldMatrix(true, false);
      const muzzle = [12, 13, 14].map((k) => b.matrixWorld.elements[k]), dl = Math.hypot(...[8, 9, 10].map((k) => b.matrixWorld.elements[k]));
      const dir = [8, 9, 10].map((k) => b.matrixWorld.elements[k] / dl);
      v.onShot(v.part, act, 0, xo.state.info);
      await new Promise((r) => setTimeout(r, 300));
      const steps = [];
      let next = 0, light = 0, haze = 0, beams = 0;
      for (let t = 0; t < ${t}; t += 1 / 120) {
        v.fx.advance(1 / 120);
        light = Math.max(light, ...v.fx.lights.map((l) => l.intensity));
        haze = Math.max(haze, v.fx.hazeScene?.children.length || 0);
        beams = Math.max(beams, v.fx.beams.filter((x) => x.alive).length);
        if (t >= next) { next += ${every}; steps.push({ t: +t.toFixed(3), shots: v.fx.shots.map((s) => ({ st: s.state, pos: s.pos.slice(), obj: !!s.obj?.parent, rope: !!s.rope?.alive, link: !!s.link?.alive, kind: s.spec.kind })) }); }
        if (t > 0.2 && t % 0.05 < 1 / 120) await new Promise((r) => setTimeout(r, 0)); // (the effect files of hits as they start)
      }
      const beamMark = v.fx.beams[0]?.mark?.surface ?? null;
      v.stopShots();
      const after = v.fx.beams.filter((x) => x.alive).length;
      delete v.fx.impact; delete v.fx.play;
      v.fx.clear(); v.fx.paused = false;
      return { kind: spec?.kind, spec: { lob: spec?.lob, spiral: spec?.spiral, speed: spec?.speed }, muzzle, dir, steps, lands, played: [...new Set(played)], light, haze, beams, beamMark, after, tz: v.target?.position.z };
    })()`);
    const states = (r) => new Set(r.steps.flatMap((x) => x.shots.map((s) => s.st)));
    // a cannon's flash lights up its surroundings for a moment, and its blast shimmers (heat haze)
    const can = await trace('models/weapons/heavygun_6pounder/heavygun_6pounder.mdl', { t: 0.6 });
    ok(can.light > 1 && can.haze > 0, `a cannon's shot throws a flash of light (${can.light.toFixed(1)} cd at its peak) and heat haze (${can.haze} haze sprites)`);
    // beams: the Tesla's lightning reaches the target and holds while it fires; letting go ends it
    const tesla = await trace('models/weapons/tesla_gun/tesla_gun.mdl', { t: 0.6 });
    ok(tesla.beams === 1 && tesla.beamMark === 1 && tesla.lands.some((l) => l.s === 1 && /teslagun/.test(l.p)) && tesla.after === 0,
      `the Tesla's lightning reaches the target with the game's beam effect, hits with its sparks (${tesla.lands.length}), and ends when it stops`);
    // a harpoon sticks with its rope back to the gun; a saw sticks, its work effect plays, it goes off
    const harp = await trace('models/weapons/harpoon_epic/harpoon_epic.mdl', { t: 3.2 });
    const harpStuck = harp.steps.find((x) => x.shots.some((s) => s.st === 'stay'));
    ok(harpStuck && harpStuck.shots.some((s) => s.st === 'stay' && s.rope && s.obj) && harp.steps.at(-1).shots.length === 0,
      `a harpoon sticks into the target as its model, its rope back to the gun, and lets go after a while`);
    const saw = await trace('models/weapons/saw_launcher_relict/saw_launcher_relict.mdl', { t: 3.5 });
    ok(states(saw).has('stay') && saw.played.includes('saw_launcher_proj_work') && saw.played.includes('saw_launcher_proj_exp'),
      `a saw sticks into the target, spins on there (its work effect) and goes off (${saw.played.filter((p) => /saw/.test(p)).join(', ')})`);
    // a wheel bomb lands and rolls on to the target; a mine lands, blinks and goes off
    const wheel = await trace('models/weapons/wheel_launcher/wheel_launcher.mdl', { t: 4 });
    ok(states(wheel).has('roll') && wheel.lands.some((l) => l.s === 1), `a wheel bomb lands, rolls on along the ground and blows up on the target`);
    const mine = await trace('models/weapons/minelayer/minelayer.mdl', { t: 7, every: 0.25 }); // (in flight ~1 s, lies 4 s)
    ok(states(mine).has('stay') && mine.played.includes('mine_active') && mine.played.includes('explosion_small_ags'), 'a mine lands on the ground, blinks and goes off');
    // a drone flies out over the way to the target and shoots at it
    const drone = await trace('models/weapons/drone_launcher_epic/drone_launcher_epic.mdl', { t: 3, every: 0.5 });
    const hovering = drone.steps.flatMap((x) => x.shots).filter((s) => s.st === 'hover');
    ok(hovering.length > 0 && hovering.some((s) => s.pos[1] > drone.muzzle[1] + 1) && drone.lands.filter((l) => l.s === 1).length >= 3,
      `a drone flies out above the way to the target and shoots at it (${drone.lands.filter((l) => l.s === 1).length} hits)`);
    // fence poles: thrown out in turn, each joins the one before with the fence's bolt
    const fence = await js(`(async () => {
      const xo = window.__xo, v = xo.viewer, mdl = 'models/weapons/electric_fence_epic/electric_fence_epic.mdl';
      await xo.openModel(mdl, { assembled: false });
      for (let i = 0; i < 300 && (xo.state.info?.path !== mdl || xo.state.loading || !xo.state.animator?.loaded); i++) await new Promise((r) => setTimeout(r, 50));
      v.stopShots(); v.fx.clear(); v.fx.paused = true;
      const spec = v.shotFor(mdl); await v.fx.meshOf(spec.mesh); await v.fx.load(spec.fenceBeam);
      const act = [...xo.state.animator.layers.values()].find((l) => /^(ACT_)?FIRE/.test(l.activity || '')).activity;
      v.onShot(v.part, act, 0, xo.state.info); v.onShot(v.part, act, 1, xo.state.info);
      for (let i = 0; i < 240; i++) { v.fx.advance(1 / 120); if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0)); }
      const poles = v.fx.shots.filter((s) => s.state === 'stay'), links = poles.filter((s) => s.link?.alive).length;
      const apart = poles.length === 2 ? Math.hypot(poles[0].pos[0] - poles[1].pos[0], poles[0].pos[2] - poles[1].pos[2]) : 0;
      v.fx.clear(); v.fx.paused = false;
      return { poles: poles.length, links, apart };
    })()`);
    ok(fence.poles === 2 && fence.links === 1 && fence.apart > 1, `fence poles stand where they land, ${fence.apart.toFixed(1)} m apart, the fence's bolt between them`);
    // second fire modes: the Hybrid's sticky grenade sticks, fuses and goes off; the Compiler lobs its
    // artillery shell high onto the target; the Waltz's rockets corkscrew round their line
    const hyb = await trace('models/weapons/machinegun_2modes_legend/machinegun_2modes_legend.mdl', { act: 'ACT_FIRE1', t: 3 });
    ok(hyb.kind === 'stickyGrenade' && states(hyb).has('stay') && hyb.played.includes('sticky_bomb_2mode_prepare') && hyb.played.includes('explosion_2mode_sticky_bomb'),
      `the Hybrid's second mode fires a grenade that sticks, fuses and goes off`);
    const comp = await trace('models/weapons/heavygun_2types_legend/heavygun_2types_legend.mdl', { act: 'FIRE_SPECIAL', t: 3.5, every: 0.05 });
    const peak = Math.max(...comp.steps.flatMap((x) => x.shots.map((s) => s.pos[1])));
    ok(comp.kind === 'cannonArtillery' && peak > comp.muzzle[1] + 3 && comp.lands.some((l) => l.s === 1),
      `the Compiler's artillery shell goes up ${(peak - comp.muzzle[1]).toFixed(1)} m and comes down on the target`);
    const waltz = await trace('models/weapons/missile_3x_spiral_legend/missile_3x_spiral_legend.mdl', { t: 0.15, every: 0.01 });
    const path0 = waltz.steps.map((x) => x.shots[0]?.pos).filter(Boolean);
    const fromLine = (p) => { const w = p.map((x, k) => x - waltz.muzzle[k]), t = w[0] * waltz.dir[0] + w[1] * waltz.dir[1] + w[2] * waltz.dir[2]; return Math.hypot(...w.map((x, k) => x - t * waltz.dir[k])); };
    const swing = path0.length > 4 ? Math.max(...path0.map(fromLine)) : 0;
    ok(waltz.kind === 'rocketSpiral' && swing > 0.4 && swing < 1.5, `the Waltz's rockets corkscrew round their line (${swing.toFixed(2)} m out from it)`);
    // found by firing every gun (scratch sweep): the Porcupine's barrels rolled through the target's
    // see-through gap (a big round now meets things with its top and sides too); the Swarm's and the
    // Heather's rockets, launched upwards, flew off into the sky (they home in and plunge); the bomb
    // discharger's 45° barrel threw its bombs 300 m (a steep mortar's arc comes down on the target)
    for (const [mdl, what] of [['barrel_launcher/barrel_launcher.mdl', "the Porcupine's barrels roll into the target"], ['missile_8x_legend/missile_8x_legend.mdl', "the Swarm's rockets home in on the target"],
      ['rocket_artillery_legend/rocket_artillery_legend.mdl', "the Heather's artillery rockets plunge onto the target"], ['grenade_system/grenade_system.mdl', "the bomb discharger's bombs arc down onto the target"]]) {
      const r = await trace('models/weapons/' + mdl, { t: 4, every: 1 });
      ok(r.lands.some((l) => l.s === 1), `${what} (${r.lands.filter((l) => l.s === 1).length} of ${r.lands.length} hits on it)`);
    }
    // a flamethrower's flame rides projectiles (28.6 m/s, 12 a second: fxmap.js), even though its
    // Fire is only an aim pose with no clip of its own
    await js(`window.__xo.openModel('models/weapons/flame_thrower/flame_thrower.mdl', { assembled: false })`);
    await idle();
    await waitFor(`!!window.__xo.state.animator?.loaded`, 15000);
    const flame = await js(`(async () => {
      const v = window.__xo.viewer, a = window.__xo.state.animator, b = v.part.userData.skeleton.bones.find((x) => x.name === 'fire_01');
      a.setActive([...a.layers.values()].find((l) => l.activity === 'FIRE').name);
      a.playing = true;
      let carried = 0, far = 0;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        b.updateWorldMatrix(true, false);
        const e = b.matrixWorld.elements;
        carried = Math.max(carried, v.fx.shots.filter((s) => s.run).length);
        for (const r of v.fx.runs) for (const { p } of r.run.particles()) far = Math.max(far, Math.hypot(p.pos[0] - e[12], p.pos[1] - e[13], p.pos[2] - e[14]));
      }
      a.playing = false;
      v.stopShots();
      return { carried, far };
    })()`);
    ok(flame.carried >= 3 && flame.far > 4, `a flamethrower's flame rides projectiles (${flame.carried} in flight at once, fire ${flame.far.toFixed(1)} m out)`);
    await js(`window.__xo.openModel('models/constructor/cabins/arm_pickup/arm_pickup.mdl', { assembled: false })`);
    await idle();
    ok(await js(`document.getElementById('fxRow').hidden`), 'parts without fire points show no Effects menu');
  }
  // The builder's "Your build is empty" card stays in the builder
  await js(`window.__xo.setView('build')`);
  await sleep(300);
  const shownInBuilder = await js(`!document.getElementById('buildEmpty').hidden`);
  await js(`window.__xo.setView('part')`);
  await sleep(200);
  ok(shownInBuilder && (await js(`document.getElementById('buildEmpty').hidden`)), 'the empty-build card does not follow you back into the 3D Viewer');

  ok(app.errors.length === 0, `no page errors${app.errors.length ? ': ' + app.errors.slice(0, 5).join(' | ') : ''}`);
} catch (e) {
  console.log('FAIL ' + e.message);
  failures++;
} finally {
  await app.close({ keep });
  if (keep) console.log('kept ' + app.dataDir);
}
console.log(failures ? `${failures} failure(s)` : 'all e2e checks passed');
process.exit(failures ? 1 : 0);
