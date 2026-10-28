// 地图中文名的生成器：把「游戏里真实存在的地图文件夹」与官方本地化表里的 MAP_TITLE_* 对上，
// 写出 ui/maps.zh.json（界面在运行时叠加，英文原文一个字不改）和 ui/maps.zh.txt（逐条来源）。
//
// 用法：
//   node tools/zh_maps.mjs <本地化键全量表.csv> [游戏目录]
// 游戏目录缺省取 %LOCALAPPDATA%\Grimcold\settings.json 里的 gameDir（地图在里面 data\*.index 里）。
//
// 原则（与部件名一致）：只写有官方中文名的那几条；表里没有的保持英文，绝不按字面猜。
// 唯一例外是 MANUAL 里几条「技术场景」：它们在游戏里没有正式名，只在程序内部用，
// 给的是描述性的中文，并在报告里标明，不要时删一行即可。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eachPack, dataDirOf, gameDirFromSettings } from './xo_data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_JSON = path.join(ROOT, 'ui', 'maps.zh.json');
const OUT_TXT = path.join(ROOT, 'ui', 'maps.zh.txt');

// 游戏里没有正式名字的技术场景（非官方名，描述性翻译；不想要就删掉那几行）
const MANUAL = {
  layout_the_wall: '兄弟会要塞（布局）', // the_wall 的布局版，道具/场景齐全，没有地形
  mainmenu: '主菜单',                   // 主菜单背景场景
  mp_lobby: '联机大厅',                 // 联机大厅场景（只有两个文件）
  screenshot: '截图场景',               // 截图用的布景
  training_polygon: '训练场',           // 训练场地形
};
const MANUAL_NOTE = '技术场景：游戏里没有正式地图名（非官方译名，可删）';

// ---- 本地化表 ---------------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; if (row.length > 1) rows.push(row); row = []; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); if (row.length > 1) rows.push(row); }
  return rows;
}

// 源表里引号有两种毛病：转义写重（\"沃德库芬\"）和普通引号；统一成中文的直角引号，与部件名一致
const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\'/g, "'");
const zhQuote = (s) => s.replace(/"([^"]*)"/g, '\u300c$1\u300d');

function readTitles(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const head = rows[0];
  const iCn = head.indexOf('中文'), iEn = head.indexOf('英文'), iKey = head.indexOf('本地化键');
  if (iCn < 0 || iKey < 0) throw new Error('本地化表里没有 中文 / 本地化键 列：' + csvPath);
  const out = new Map();
  for (const r of rows.slice(1)) {
    const key = r[iKey];
    if (!key || !/^MAP_TITLE_/i.test(key)) continue;
    out.set(key.toUpperCase(), { key, cn: zhQuote(unesc(r[iCn]).trim()), en: unesc(r[iEn] || '').trim() });
  }
  return out;
}

// ---- 游戏里的地图（判定与 src/xo/Map.cpp listMaps() 一致） --------------------------------------
// 一张地图 = levels/maps/<名>/ 下出现 props.mxml / scene.mxml / landscape/landscape.mxml
const PRE = 'levels/maps/';
function listMaps(dataDir) {
  const maps = new Set();
  const stat = eachPack(dataDir, (pack) => {
    for (const n of pack.entries.keys()) {
      if (!n.startsWith(PRE)) continue;
      const slash = n.indexOf('/', PRE.length);
      if (slash < 0) continue;
      const rest = n.slice(slash + 1);
      if (rest === 'props.mxml' || rest === 'scene.mxml' || rest === 'landscape/landscape.mxml')
        maps.add(n.slice(PRE.length, slash));
    }
  });
  return { maps: [...maps].sort(), stat };
}

// ---- 主流程 -----------------------------------------------------------------------------------
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('用法: node tools/zh_maps.mjs <CrossOut_本地化键_全量分类.csv> [游戏目录]');
  process.exit(2);
}
const gameDir = process.argv[3] || gameDirFromSettings();
if (!gameDir) throw new Error('不知道游戏目录：请在命令行给出，或先让 Grimcold 选好游戏目录');
const dataDir = dataDirOf(gameDir);

const titles = readTitles(csvPath);
const scan = listMaps(dataDir);
const maps = {};
const sources = {};
const miss = [];
const used = new Map();
for (const name of scan.maps) {
  const t = titles.get(('MAP_TITLE_' + name).toUpperCase());
  if (t) {
    maps[name] = t.cn;
    sources[name] = t.key;
    used.set(t.key.toUpperCase(), name);
  } else if (MANUAL[name]) {
    maps[name] = MANUAL[name];
    sources[name] = MANUAL_NOTE;
  } else {
    miss.push(name);
  }
}

const doc = {
  _note: '地图中文名（由官方简体中文文本表的 MAP_TITLE_* 生成，键 = levels/maps 下的文件夹名）。'
    + '没有条目的地图像素保持英文名；技术场景（主菜单/大厅等）是描述性译名，已在 sources 里标明。'
    + '重生成：node tools/zh_maps.mjs <本地化键全量表.csv>。逐条来源见 ui/maps.zh.txt。',
  maps,
  sources,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n', 'utf8');

// ---- 报告 -------------------------------------------------------------------------------------
const lines = [];
const nManual = Object.keys(maps).filter((m) => sources[m] === MANUAL_NOTE).length;
lines.push('地图中文名对照表  （生成：node tools/zh_maps.mjs）');
lines.push('');
lines.push(`游戏：${dataDir}   档案包 ${scan.stat.packs} 个，读入 ${scan.stat.entries} 个文件条目，损坏 ${scan.stat.bad} 个`);
lines.push(`地图文件夹 ${scan.maps.length} 个：官方键对上 ${Object.keys(maps).length - nManual} 个，技术场景 ${nManual} 个，留空 ${miss.length} 个`);
lines.push('');
lines.push('规则：文件夹名的全大写 = 本地化键的后缀（levels/maps/bridge → MAP_TITLE_BRIDGE）；');
lines.push('      官方表里有中文才写，没有就保持英文（eg 不按字面猜）。');
lines.push('');
lines.push('== 对照明细（文件夹 → 中文 | English | 键）==');
for (const name of Object.keys(maps)) {
  const t = titles.get(('MAP_TITLE_' + name).toUpperCase());
  lines.push(`  ${name}\t${maps[name]}\t${t ? t.en : '-'}\t${sources[name]}`);
}
lines.push('');
lines.push('== 留空（没找到官方键，保持英文）==');
lines.push(miss.length ? miss.map((m) => '  ' + m).join('\n') : '  （无）');
lines.push('');
const unused = [...titles.values()].filter((t) => !used.has(t.key.toUpperCase()));
lines.push('== 表里有键、但本机游戏里没有这个文件夹（没写进表）==');
for (const t of unused) lines.push(`  ${t.key}\t${t.cn}\t${t.en}`);
fs.writeFileSync(OUT_TXT, lines.join('\n') + '\n', 'utf8');

console.log(`地图 ${scan.maps.length} 个 → 写入 ${Object.keys(maps).length} 条（技术场景 ${nManual}），留空 ${miss.length}，未用键 ${unused.length}`);
console.log(`  ${OUT_JSON}`);
console.log(`  ${OUT_TXT}`);
