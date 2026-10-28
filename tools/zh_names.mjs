// Lists the part names that ui\names.zh.json does not hold yet, as a list to fill in. Run it after a
// game update to see what is new: nothing breaks if you never run it (a part with no Chinese entry
// keeps its English name), it only tells you what is left to name.
//
//   node tools\zh_names.mjs           -> names.json's parts (no game, no build needed)
//   node tools\zh_names.mjs --app     -> every model the game has, through a running Grimcold
//                                       (Parts with no English name either show up only this way)
//
// Writes build\zh\names.zh.todo.txt (UTF-8 with a BOM: Notepad and Excel read it right) and prints the count.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODO = path.join(ROOT, 'build', 'zh', 'names.zh.todo.txt'); // (not in ui\: the release zip takes that folder whole)
const asApp = process.argv.includes('--app');

const readJson = (p, fallback) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } };
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.?\//, '').trim();
const dirOf = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const parentOf = (d) => { const i = d.lastIndexOf('/'); return i < 0 ? '' : d.slice(0, i); };

const zh = readJson(path.join(ROOT, 'ui', 'names.zh.json'), {});
const en = readJson(path.join(ROOT, 'ui', 'names.json'), {});
const zhParts = new Map(Object.entries(zh.parts || {}).map(([k, v]) => [norm(k), v]));
const zhDirs = new Map(Object.entries(zh.dirs || {}).map(([k, v]) => [norm(k), v]));
const zhFolders = new Map(Object.entries(zh.folders || {}).map(([k, v]) => [norm(k), v]));
const enParts = new Map(Object.entries(en.parts || {}).map(([k, v]) => [norm(k), v]));

// A model path counts as named when it has its own entry, or when a folder above it does (a part's
// skins, drones and pieces are separate files that share one name).
function covered(p) {
  if (zhParts.has(p)) return true;
  for (let d = dirOf(p), i = 0; d && i < 6; i++) {
    if (zhDirs.has(d)) return true;
    d = parentOf(d);
  }
  return false;
}

const paths = new Set(enParts.keys());
if (asApp) {
  // Every model the archives hold: through the app's own page (it lists them once the game is read).
  const { launch } = await import('./cdp.mjs');
  const app = await launch({ size: '1200,800' });
  try {
    await app.waitFor('window.__xoReady === true', 300000);
    const all = await app.js(`[...window.__xo.state.folders.values()].flatMap((f) => f.models)`);
    for (const p of all) paths.add(norm(p));
  } finally {
    await app.close();
  }
}

const todo = [...paths].filter((p) => !covered(p)).sort();
const done = paths.size - todo.length;

// Grouped by folder, so a folder of like parts is named in one sitting.
const groups = new Map();
for (const p of todo) {
  const d = dirOf(p);
  if (!groups.has(d)) groups.set(d, []);
  groups.get(d).push(p);
}

const lines = [
  '# Grimcold 中文部件名：待翻译清单',
  `# 生成时间 ${new Date().toLocaleString('zh-CN')}${asApp ? '（来自游戏文件，含无英文名的部件）' : '（来自 names.json）'}`,
  '#',
  '# 在 ui\\names.zh.json 的 "parts" 里加一行：  "模型路径": "中文名"',
  '# 同一个部件有多个文件（皮肤、无人机、碎片）时，改在 "dirs" 里写文件夹路径，一次覆盖全部。',
  '# 同目录几种不同部件共用一个列表行时，用 "folders" 改这一行的标题。',
  '# 没列进去的部件照旧显示英文名，所以这份清单留着不填也完全不影响使用。',
  '#',
  `# 共 ${paths.size} 个模型，已有中文名 ${done}，待翻译 ${todo.length}`,
  '',
];
for (const [d, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
  const title = zhFolders.get(d) || enFolders(d);
  lines.push(`${d}${title ? `   ——   ${title}` : ''}   (${list.length})`);
  for (const p of list) lines.push(`  ${p}   ${enParts.get(p)?.name || ''}`);
  lines.push('');
}
if (!todo.length) lines.push('（没有待翻译的部件：全部都有中文名了。）', '');

fs.mkdirSync(path.dirname(TODO), { recursive: true });
fs.writeFileSync(TODO, '\uFEFF' + lines.join('\r\n'), 'utf8');

// The title names.json gives a folder that holds several different parts (else empty).
function enFolders(d) { return (en.folders || {})[d] || ''; }

console.log(`[zh-names] ${paths.size} models: ${done} named, ${todo.length} to go`);
console.log(`[zh-names] wrote ${path.relative(ROOT, TODO)}`);
if (todo.length) {
  const sample = todo.slice(0, 12).map((p) => `  ${p}  ${enParts.get(p)?.name || ''}`);
  console.log('[zh-names] first ones:\n' + sample.join('\n'));
  if (todo.length > 12) console.log(`  … and ${todo.length - 12} more`);
}
