// 游戏模式（GameplaysList）与节日（FestivalsList）的中文名生成器。
// 下游界面里「游戏模式」「节日」两个下拉框显示的其实是场景文件里的内部标识
// （Assault、Brawl_Coilgun、Pve_Oilevac…），这里把它们对到官方中文文本表。
//
// 用法：
//   node tools/zh_modes.mjs <本地化键全量表.csv> [游戏目录]
// 游戏目录缺省取 %LOCALAPPDATA%\Grimcold\settings.json 的 gameDir。
//
// 匹配规则（两族键，都是官方的，不猜）：
//   1) GAMEPLAY_<标识>            —— 名字键（排除 _INFO / _desc / _hint_N）
//   2) Mission_<标识>_Name        —— 部分乱斗只有这一族（键名里常带 MBrawl_/Brawl_ 前缀）
//   比较时统一小写、去掉非字母数字，并剥掉 brawl_/mbrawl_ 前缀。
// 匹配不上的保持英文（界面照旧）。EXCLUDE 里是查过但判断为不同东西的，宁可留空。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eachPack, readEntry, dataDirOf, gameDirFromSettings } from './xo_data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_JSON = path.join(ROOT, 'ui', 'modes.zh.json');
const OUT_TXT = path.join(ROOT, 'build', 'zh', 'modes.zh.txt'); // (报告不放 ui\：发布包会整个带上 ui 文件夹)

// 查到了同名键、但内容不是这个模式的名字：不采信（说明写在报告里）
const EXCLUDE = {
  Exploration: '命中 mission_exploration_name（觉醒/Awakening）：那是任务名，不是「探索」模式的模式名，故不采用',
};

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
const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\'/g, "'");
const zhQuote = (s) => s.replace(/"([^"]*)"/g, '\u300c$1\u300d');

function readTable(csvPath) {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const head = rows[0];
  const iCn = head.indexOf('中文'), iEn = head.indexOf('英文'), iKey = head.indexOf('本地化键');
  if (iCn < 0 || iKey < 0) throw new Error('本地化表里没有 中文 / 本地化键 列：' + csvPath);
  return rows.slice(1)
    .filter((r) => r[iKey])
    .map((r) => ({ key: r[iKey].trim(), cn: zhQuote(unesc(r[iCn] || '').trim()), en: unesc(r[iEn] || '').trim() }));
}

// ---- 标识的各种等价写法 ------------------------------------------------------------------------
const nz = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function forms(id, { stripName = false } = {}) {
  let s = id;
  if (stripName) s = s.replace(/_name$/i, '');
  const out = new Set([nz(s)]);
  for (const p of ['mbrawl_', 'brawl_', 'mission_']) {
    if (s.toLowerCase().startsWith(p)) out.add(nz(s.slice(p.length)));
  }
  out.delete('');
  return [...out];
}
const isNameKey = (k) => !/_(info|desc|description)$/i.test(k) && !/_hint_\d+$/i.test(k);

function indexKeys(rows) {
  const gameplay = new Map(); // 归一化名 → [行]
  const mission = new Map();
  const add = (m, n, it) => { if (!m.has(n)) m.set(n, []); const l = m.get(n); if (!l.some((x) => x.key === it.key)) l.push(it); };
  for (const it of rows) {
    if (/^gameplay_/i.test(it.key) && isNameKey(it.key)) {
      for (const n of forms(it.key.replace(/^gameplay_/i, ''), { stripName: true })) add(gameplay, n, it);
    }
    const m = it.key.match(/^mission_(.+)_name$/i);
    if (m) for (const n of forms(m[1])) add(mission, n, it);
  }
  return { gameplay, mission };
}

// ---- 游戏里真正的标识（读每张图的 scene.mxml） --------------------------------------------------
function scanModes(dataDir) {
  const games = new Set();
  const fests = new Set();
  const perMap = {};
  const stat = eachPack(dataDir, (pack, fd) => {
    for (const name of pack.entries.keys()) {
      if (!/^levels\/maps\/[^/]+\/scene\.mxml$/.test(name)) continue;
      const buf = readEntry(fd, pack, pack.entries.get(name));
      if (!buf) continue;
      const txt = buf.toString('utf8');
      const map = name.split('/')[2];
      const got = new Set(perMap[map] || []);
      for (const attr of ['GameplaysList', 'FestivalsList']) {
        const re = new RegExp(attr + '\\s*=\\s*"([^"]*)"', 'g');
        let m;
        while ((m = re.exec(txt))) {
          for (const v of m[1].split(/[,;\s]+/)) {
            if (!v) continue;
            (attr === 'GameplaysList' ? games : fests).add(v);
            got.add(v);
          }
        }
      }
      perMap[map] = [...got];
    }
  });
  return { games: [...games].sort(), fests: [...fests].sort(), perMap, stat };
}

// ---- 主流程 -----------------------------------------------------------------------------------
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('用法: node tools/zh_modes.mjs <CrossOut_本地化键_全量分类.csv> [游戏目录]');
  process.exit(2);
}
const gameDir = process.argv[3] || gameDirFromSettings();
if (!gameDir) throw new Error('不知道游戏目录：请在命令行给出，或先让 Grimcold 选好游戏目录');
const dataDir = dataDirOf(gameDir);

const table = readTable(csvPath);
const { gameplay, mission } = indexKeys(table);
const scan = scanModes(dataDir);

const modes = {}, modeSrc = {}, noName = [], excluded = [];
for (const id of scan.games) {
  const fs2 = forms(id);
  const hit1 = fs2.map((n) => gameplay.get(n)).find(Boolean);
  const hit2 = fs2.map((n) => mission.get(n)).find(Boolean);
  if (EXCLUDE[id]) { excluded.push({ id, why: EXCLUDE[id], keys: (hit1 || hit2 || []).map((x) => x.key) }); continue; }
  const hit = hit1 || hit2;
  if (hit && hit[0].cn) {
    modes[id] = hit[0].cn;
    modeSrc[id] = hit.map((x) => x.key).join(' + ');
  } else {
    noName.push(id);
  }
}

// 节日：官方文本表里没有独立的节日名键（查过 FESTIVAL_*/事件名都不是），保持英文。
const festivals = {};
for (const f of scan.fests) {
  if (f === 'Empty') festivals[f] = '无'; // 界面本来就把它显示成 None
}

const doc = {
  _note: '游戏模式中文名（由官方简体中文文本表的 GAMEPLAY_* / Mission_*_Name 生成，键 = 场景里的 GameplaysList / FestivalsList 标识）。'
    + '没有条目的照样显示英文。重生成：node tools/zh_modes.mjs <本地化键全量表.csv>。逐条来源见 build/zh/modes.zh.txt。',
  gameplays: modes,
  sources: modeSrc,
  festivals,
};
fs.writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const L = [];
L.push('游戏模式中文名对照表  （生成：node tools/zh_modes.mjs）');
L.push('');
L.push(`游戏：${path.basename(path.dirname(dataDir)) || path.basename(dataDir)}   档案包 ${scan.stat.packs} 个，条目 ${scan.stat.entries} 个，读不出 ${scan.stat.bad} 个`);
L.push(`模式标识 ${scan.games.length} 个：官方键对上 ${Object.keys(modes).length} 个，无名字 ${noName.length} 个，查过但不采信 ${excluded.length} 个`);
L.push(`节日标识 ${scan.fests.length} 个：官方表里没有节日名键，保持英文（Empty 显示为「无」）`);
L.push('');
L.push('规则：');
L.push('  1) GAMEPLAY_<标识>         名字键（排除 _INFO / _desc / _hint_N）');
L.push('  2) Mission_<标识>_Name     部分乱斗只有这一族');
L.push('  比较时统一小写、去非字母数字，并剥掉 brawl_ / mbrawl_ 前缀；对不上就留英文，不猜。');
L.push('');
L.push('== 对照明细（标识 → 中文 | English | 键）==');
for (const id of Object.keys(modes)) {
  const key = modeSrc[id].split(' + ')[0];
  const row = table.find((r) => r.key === key);
  L.push(`  ${id}\t${modes[id]}\t${row ? row.en : ''}\t${modeSrc[id]}`);
}
L.push('');
L.push('== 无名字（保持英文）==');
L.push(noName.length ? noName.map((n) => '  ' + n).join('\n') : '  （无）');
L.push('');
L.push('== 查过但不采信 ==');
L.push(excluded.length ? excluded.map((e) => `  ${e.id}\t${e.why}\t${e.keys.join(' , ')}`).join('\n') : '  （无）');
L.push('');
L.push('== 节日标识 ==');
L.push(scan.fests.map((f) => '  ' + f).join('\n'));
fs.mkdirSync(path.dirname(OUT_TXT), { recursive: true });
fs.writeFileSync(OUT_TXT, L.join('\n') + '\n', 'utf8');

console.log(`模式 ${scan.games.length} 个 → 写入 ${Object.keys(modes).length} 条，留英文 ${noName.length}，不采信 ${excluded.length}`);
console.log(`  ${OUT_JSON}`);
console.log(`  ${OUT_TXT}`);
