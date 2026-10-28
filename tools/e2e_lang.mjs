// End-to-end test of the interface's languages (ui/i18n.js, ui/lang/zh-CN.js; pull request #3): the
// Language button beside Bug report opens its menu; 简体中文 turns the chrome and what the code draws
// into Chinese (the tabs, the builder's cards, the 1.0.4 texts, the keys bar, a status line, the
// search box, the vehicle's notes, the sticker packs, the mirror copy's reasons, the host's messages);
// the choice is remembered; English comes back exactly as it was, every text and tooltip of the page
// (none left Chinese, none put back stale); a card folded in one language stays so in the other; the
// menu closes on Esc and outside it.
//   node tools/e2e_lang.mjs
import { launch, sleep } from './cdp.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const GUN = 'models/weapons/machinegun_smg/machinegun_smg.mdl';
const app = await launch({ prefix: 'xo-e2e-lang-' });
const { js, waitFor, key } = app;
const settle = () => waitFor('!window.__xo.build.busy && !window.__xo.build.committing && document.getElementById("busy").hidden', 30000);
// every text of the page, in order (the status line aside: a switch clears it; and the builder's part
// card and the busy pill, hidden with the last part's card and the last job's words in them), and
// every tooltip, placeholder and aria-label: English must come back as it was
const texts = () => js(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentNode.closest('#statusText, #partCard, #busyText, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); const o = []; while (w.nextNode()) { const v = w.currentNode.nodeValue.trim(); if (v) o.push(v); } return o.join('|'); })()`);
const attrs = () => js(`[...document.body.querySelectorAll('[title], [placeholder], [aria-label]')].filter((e) => !e.closest('#statusText, #partCard')).flatMap((e, i) => ['title', 'placeholder', 'aria-label'].filter((a) => e.hasAttribute(a)).map((a) => (e.id || e.tagName + i) + '.' + a + '=' + e.getAttribute(a))).join('|')`);
const firstDiff = (x, y) => { const a = x.split('|'), b = y.split('|'), at = a.findIndex((s, i) => s !== b[i]); return at < 0 ? '' : `"${a.slice(Math.max(0, at - 1), at + 2).join(' / ')}" vs "${b.slice(Math.max(0, at - 1), at + 2).join(' / ')}"`; };
const pick = (l) => js(`(() => { document.getElementById('langBtn').click(); document.querySelector('#langMenu [data-lang="${l}"]').click(); })()`);
const q = (sel) => js(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim()`);
// a card of the builder's panel with no id (its fold is kept under its header's text)
const FOLD = `[...document.querySelectorAll('#buildPanel .card > h3:first-child')].find((h) => !h.parentElement.id && !h.id && h.firstChild?.nodeType === 3 && h.offsetParent)`;
try {
  await waitFor('window.__xoReady === true', 60000);
  if (await js(`document.documentElement.lang === 'zh-CN'`)) { await pick('en'); await sleep(300); } // (a Chinese Windows starts in Chinese)
  // a gun in the 3D Viewer (its LOD menu and gun card are drawn in code), then the builder
  await js(`window.__xo.setView('part')`);
  await js(`window.__xo.openModel(${JSON.stringify(GUN)})`);
  await waitFor(`window.__xo.state.info?.path === ${JSON.stringify(GUN)} && !window.__xo.state.loading`, 30000);
  await js(`window.__xo.setView('build')`);
  await waitFor('!window.__xo.state.restoring && !window.__xo.state.loadingBuild', 10000).catch(() => {});
  await settle();
  await sleep(500);
  const en = await texts(), enAttrs = await attrs();
  const enLod = await js(`[...document.querySelectorAll('#lodSel option')].map((o) => o.textContent).join(',')`);
  const enPack = await js(`document.querySelector('#bStickerPack option[value="14feb"]')?.textContent || ''`);

  // ---- the button and its menu ----
  const btn = await js(`(() => { const b = document.getElementById('langBtn'); return { text: b.textContent.trim(), inTabs: !!b.closest('#mainMode'), afterBug: b.previousElementSibling?.id === 'bugReportBtn' }; })()`);
  await js(`document.getElementById('langBtn').click()`);
  const menu = await js(`(() => { const m = document.getElementById('langMenu'); return { shown: !m.hidden, items: [...m.querySelectorAll('[data-lang]')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')), names: !document.getElementById('zhNamesWrap').hidden }; })()`);
  ok(btn.inTabs && btn.afterBug && btn.text === 'English', `a Language button of its own, beside Bug report ("${btn.text}")`);
  ok(menu.shown && menu.items.join(',') === 'English*,简体中文' && !menu.names, `its menu: ${menu.items.join(', ')} (no Chinese part names without ui\\names.zh.json)`);
  // (by keyboard: it starts on the language in use, the arrows move in it and reach nothing behind it)
  await js(`window.__arrows = 0; window.addEventListener('keydown', (e) => { if (e.key.startsWith('Arrow')) window.__arrows++; })`);
  const focus = () => js(`(() => { const a = document.activeElement; return a?.id || a?.dataset?.lang || a?.tagName; })()`);
  const f0 = await focus();
  await key('ArrowDown');
  const f1 = await focus();
  await key('ArrowDown');
  const f2 = await focus(), leaked = await js('window.__arrows');
  await key('Escape');
  const shut = await js(`(() => ({ hidden: document.getElementById('langMenu').hidden, view: window.__xo.state.view, focus: document.activeElement?.id, expanded: document.getElementById('langBtn').getAttribute('aria-expanded') }))()`);
  ok(f0 === 'en' && f1 === 'zh' && f2 === 'en' && leaked === 0, `by keyboard it starts on English and the arrows go round its items, none reaching the app (${f0} -> ${f1} -> ${f2}; ${leaked} arrow(s) leaked)`);
  ok(shut.hidden && shut.view === 'build' && shut.focus === 'langBtn' && shut.expanded === 'false', `Esc closes the menu (and only the menu), back on the button (${JSON.stringify(shut)})`);
  await js(`document.getElementById('langBtn').click()`);
  await js(`document.getElementById('buildPanel').click()`);
  ok(await js(`document.getElementById('langMenu').hidden`), 'a click elsewhere closes it');
  const foldName = await js(`(() => { const h = ${FOLD}; if (!h) return ''; h.click(); return h.parentElement.classList.contains('folded') ? h.firstChild.nodeValue.trim() : ''; })()`);

  // ---- 简体中文 ----
  await js(`window.__xo.build.status('No limits: any number of parts, cabins and engines, parts inside each other')`); // (a line that stays)
  await pick('zh');
  await sleep(400);
  const kept = await js(`document.getElementById('statusText').textContent`);
  ok(kept === '无限制：任意数量的部件、驾驶室和引擎，部件可以相互重叠', `the status line on screen is written again in Chinese, not wiped ("${kept}")`);
  const zh = await js(`(() => { const q = (s) => document.querySelector(s)?.textContent.trim(); return { lang: document.documentElement.lang, name: q('#langName'), tab: q('#mainMode [data-view="part"]'), stickers: q('#bStickerCard h3'), done: q('#bStickerDone'), lim: q('#bLimitsSeg [data-l="off"]'), side: q('#bMirrorSide'), keys: document.getElementById('buildHint').textContent, search: document.getElementById('search').placeholder }; })()`);
  ok(zh.lang === 'zh-CN' && zh.name === '简体中文' && zh.tab === '3D 查看器', `简体中文: the chrome turns Chinese (${zh.tab}; the button says ${zh.name})`);
  ok(zh.stickers === '贴纸' && zh.done === '完成' && zh.lim === '无限制' && zh.side === '镜像到另一侧' && /镜像到另一侧/.test(zh.keys), `the 1.0.4 texts too (${zh.stickers}, ${zh.lim}, ${zh.side})`);
  const zhLod = await js(`[...document.querySelectorAll('#lodSel option')].map((o) => o.textContent).join(',')`);
  const zhPack = await js(`document.querySelector('#bStickerPack option[value="14feb"]')?.textContent || ''`);
  ok(zh.search === '搜索部件（Ctrl+F）' && /^0（最佳）/.test(zhLod) && (!enPack || /^2月14日/.test(zhPack)),
    `what the code wrote before the switch is redrawn: the search box, the 3D Viewer's LOD menu, the sticker packs ("${zh.search}", "${zhLod}", "${zhPack}")`);
  const notes = await js(`(async () => { const g = await import('./garage.js'); const v = { parts: 3, energy: { used: 0, supply: 10, free: 10, weapons: 0, modules: 0, cabin: 10, generators: 0, nGenerators: 0 }, mass: 900, massLimit: 5000, tonnage: 9000, cabin: true, cabins: ['a', 'b'], engines: 1, unknown: 2, unknownArmour: 0 };
    const d = document.createElement('div'); d.innerHTML = g.vehicleStatsHtml(v, { limits: false }); return d.querySelector('.vs-note')?.textContent || ''; })()`);
  ok(/2 个驾驶室：只算第一个。/.test(notes) && /还有 2 个部件没有数据/.test(notes), `the vehicle's notes in Chinese ("${notes}")`);
  const host = ['No Crossout game data (data\\*.index) in D:\\Games\\x', 'That is inside the Crossout game folder (D:\\Games\\Crossout), which is only ever read. Please choose another folder.', 'buggy_start now uses wood (512×512)'];
  const pats = await js(`(async () => { const m = await import('./i18n.js'); return ${JSON.stringify(host)}.map((s) => m.t(s)); })()`);
  ok(pats[0] === 'D:\\Games\\x 里没有 Crossout 游戏数据（data\\*.index）' && pats[1].startsWith('这个位置在 Crossout 游戏文件夹里（D:\\Games\\Crossout）') && pats[2] === 'buggy_start 现在使用 wood（512×512）',
    `the host's messages and the texture line match their patterns (${pats.join(' | ')})`);
  await js(`document.querySelector('#bLimitsSeg [data-l="off"]').click()`);
  await sleep(200);
  const st = await js(`document.getElementById('statusText').textContent`);
  ok(/^无限制/.test(st), `a status line the code writes comes out in Chinese ("${st}")`);
  await js(`document.querySelector('#bLimitsSeg [data-l="on"]').click()`);
  const restart = async () => {
    await sleep(300);
    await js('location.reload()').catch(() => {});
    await sleep(1500);
    await waitFor('window.__xoReady === true', 60000);
  };
  await restart();
  ok(await js(`document.documentElement.lang === 'zh-CN' && document.querySelector('#mainMode [data-view="part"]').textContent.trim() === '3D 查看器'`), 'the language is remembered after a restart');
  // (the card folded in English: still folded after a restart in Chinese; opened there, it stays open
  // after the next: its fold is kept under its English header)
  const stillFolded = await js(`(() => { const h = document.querySelector('#buildPanel .card.folded > h3:first-child'); if (!h) return false; h.click(); return !h.parentElement.classList.contains('folded'); })()`);
  await restart();
  ok(foldName && stillFolded && await js(`document.querySelectorAll('#buildPanel .card.folded').length === 0`), `a card folded in English ("${foldName}") is still folded after a restart in Chinese, and opened there stays open`);

  // ---- English, exactly as before ----
  await js(`window.__xo.setView('part')`);
  await js(`window.__xo.openModel(${JSON.stringify(GUN)})`);
  await waitFor(`window.__xo.state.info?.path === ${JSON.stringify(GUN)} && !window.__xo.state.loading`, 30000);
  await js(`window.__xo.setView('build')`);
  await settle();
  await sleep(300);
  await pick('en');
  await sleep(400);
  const back = await texts(), backAttrs = await attrs();
  ok(back === en && await js(`document.documentElement.lang === 'en'`), `English comes back exactly as it was: every text of the page (${en.length} characters${back === en ? '' : `; differs at ${firstDiff(en, back)}`})`);
  ok(backAttrs === enAttrs, `and every tooltip and placeholder: none left Chinese, none put back stale${backAttrs === enAttrs ? '' : ` (differs at ${firstDiff(enAttrs, backAttrs)})`}`);
  const backLod = await js(`[...document.querySelectorAll('#lodSel option')].map((o) => o.textContent).join(',')`);
  const backPack = await js(`document.querySelector('#bStickerPack option[value="14feb"]')?.textContent || ''`);
  const m3 = await js(`(async () => { const m = await import('./i18n.js'); return m.t(', ') + '|' + m.t(' ({list})', { list: 'x' }); })()`);
  ok(/^0 \(best\),1(,|$)/.test(enLod) && backLod === enLod && backPack === enPack && (!enPack || /^14 Feb/.test(enPack)) && m3 === ', | (x)',
    `the English of the LOD menu, the sticker packs and the joins is the old one ("${backLod}", "${backPack}")`);

  // ---- the mirror copy's reasons (build.js), and the part card through a switch ----
  await pick('zh');
  await sleep(300);
  const gun = await js(`(async () => { const b = window.__xo.build; const i = await b.createInstance({ path: ${JSON.stringify(GUN)}, position: [1.5, 0, 0.9] }); b.commit(); return i.id; })()`);
  await settle();
  await js(`window.__xo.build.setSelection([${gun}])`);
  await js(`document.getElementById('bMirrorSide').click()`);
  await settle();
  const m1 = await js(`document.getElementById('statusText').textContent`);
  await js(`window.__xo.build.setSelection([${gun}])`);
  await js(`document.getElementById('bMirrorSide').click()`);
  await settle();
  const m2 = await js(`document.getElementById('statusText').textContent`);
  ok(m1 === '已将 1 个部件镜像到另一侧' && m2 === '没有镜像任何部件（1 个在另一侧已有副本）', `To the other side says why in Chinese too ("${m1}", "${m2}")`);
  // (the selected part's card follows a switch, and stays a card: a switch hydrates the whole page's
  // icons, and the card's own key once read as a key cap's)
  await sleep(300);
  const card = () => js(`(() => { const c = document.getElementById('partCard'); return c.hidden ? '(hidden)' : c.textContent.replace(/\\s+/g, ' ').trim(); })()`);
  const cardZh = await card();
  await pick('en');
  await sleep(600);
  const cardEn = await card();
  ok(/耐久度/.test(cardZh) && /Durability/.test(cardEn) && !/\|/.test(cardEn) && !/耐久度/.test(cardEn), `the part card follows the switch and stays a card ("${cardZh}" -> "${cardEn}")`);

  // ---- what the code wrote in Chinese and nothing draws again comes back English too ----
  // (the paint picker's search box after a tab picked in Chinese; and, as the safety net, a tooltip
  // and a text written with t() while Chinese was on)
  await pick('zh');
  await sleep(300);
  await js(`(async () => { const m = await import('./i18n.js'); window.__xo.paints.pickers().build.showTab('chameleon');
    const b = document.getElementById('bSave'); b.dataset.t0 = b.title; b.title = m.t('Search parts (Ctrl+F)');
    const s = document.createElement('span'); s.id = 'langProbe'; s.hidden = true; s.textContent = m.t('Pick a part on the left'); document.body.append(s); })()`);
  await pick('en');
  await sleep(400);
  const net = await js(`(() => { const r = { pp: window.__xo.paints.pickers().build.el.querySelector('.pp-search').placeholder, title: document.getElementById('bSave').title, text: document.getElementById('langProbe').textContent, menu: document.querySelector('#langMenu [data-lang="zh"]').textContent };
    const b = document.getElementById('bSave'); b.title = b.dataset.t0; delete b.dataset.t0; document.getElementById('langProbe').remove(); window.__xo.paints.pickers().build.showTab('color'); return r; })()`);
  ok(net.pp === 'Search chameleon paints' && net.title === 'Search parts (Ctrl+F)' && net.text === 'Pick a part on the left' && net.menu === '简体中文',
    `a placeholder, tooltip or text written in Chinese and not drawn again turns English too; the menu's 简体中文 stays (${JSON.stringify(net)})`);
  const left = app.errors.filter(Boolean);
  ok(left.length === 0, `no page errors (${left.slice(0, 2).join(' | ')})`);
} catch (e) {
  console.log('FAIL', e.stack || e.message);
  failures++;
} finally {
  await app.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
