// Grimcold's translations: English is the source (the HTML and the code stay English, so updates from
// upstream merge cleanly), and a dictionary per language turns it into something else at run time.
//
// Two halves, because the interface is built two ways:
//   * the static chrome in index.html: whole texts and whole title / placeholder attributes, found
//     and replaced here (applyStatic), with the English kept aside so switching back is exact;
//   * what the modules build in code: they call t('English sentence', { var }) at the point they
//     build it (the dictionary holds those sentences too, with {name} slots for the numbers).
// A sentence the dictionary does not have is left in English: a missing line is never an error, so
// the translation can grow a piece at a time (see ui/lang/<lang>.js).
import { ZH_CN, ZH_BLOCKS } from './lang/zh-CN.js';

const LANGS = { en: null, zh: ZH_CN };
export const LANG_NAMES = { en: 'English', zh: '中文' };

// Lines the code builds with a number or a file name in them (status('Build saved: ' + path)) cannot
// be looked up by their whole text. These patterns take them: the English sentence's shape, with the
// part that varies kept as it is.
const PATTERNS = {
  zh: [
    [/^Build saved: (.+)$/, '载具已保存：$1'],
    [/^Look saved: (.+)$/, '外观已保存：$1'],
    [/^Screenshot saved: (.+)$/, '截图已保存：$1'],
    [/^Recording saved: (.+)$/, '录像已保存：$1'],
    [/^Exported (.+)$/, '已导出：$1'],
    [/^Build loaded(.*)$/, '载具已加载$1'],
    [/^Restored your last build \((.+)\)$/, '已恢复上次的载具（$1）'],
    [/^Named (.+)$/, '已命名为 $1'],
    [/^Autosave: (.+)$/, '自动保存：$1'],
    [/^Took (.+) from (.+)$/, '已从 $2 取下 $1'],
    [/^No paint on (.+)$/, '$1 上没有涂装'],
    [/^(.+) \((.+)\) now uses (.+)$/, '$1（$2）现在使用 $3'],
    [/^(.+): (.+) triangles, (.+) mesh\(es?\)(.*)$/, '$1：$2 个三角形，$3 个网格$4'],
    [/^(.+) is open$/, '已打开 $1'],
    [/^Loading (.+)$/, '正在加载 $1'], // (地图/部件名跟着走：Loading 决斗之桥)
    [/^(.+) files, (.+)$/, '$1 个文件，$2'],
    [/^Could not restore the last build \((.+)\)\. (.+)$/, '无法恢复上次的载具（$1）。$2'],
    // the host (C++) reports these; the paths in them stay as they are
    [/^No Crossout game data \(data\\\\\*\.index\) in (.+)$/, '$1 里没有 Crossout 游戏数据（data\\*.index）'],
    [/^That is inside the Crossout game folder \((.+)\)$/, '这个位置在 Crossout 游戏文件夹里（$1）'],
    [/^(.+) is still running\b(.*)$/, '$1 还在运行$2'],
  ],
};

let lang = 'en';
export const getLang = () => lang;

// t('Save the build (Ctrl+S)') -> the dictionary's line; vars fill {name} slots; a line with no
// translation comes back as it went in.
export function t(text, vars) {
  const d = LANGS[lang];
  let s = (d && d[text]) || null;
  if (!s && lang !== 'en') { // (a sentence with a number or a path in it: matched by its shape)
    for (const [re, rep] of PATTERNS[lang] || []) {
      if (re.test(text)) { s = text.replace(re, rep); break; }
    }
  }
  if (s == null) s = text;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return s;
}
// For markup built in code: same lookup, but the caller says the line is HTML.
export const th = (text, vars) => t(text, vars);

// A part's type, as stats.json names it ("Medium cabin", "Recharge booster"): its own namespace in the
// dictionary ('type:...'), because some of those words mean something else elsewhere — Frame is also
// the button that frames the model, Size is also the map's size.
export function typeLabel(type) {
  if (!type) return '';
  const d = LANGS[lang];
  if (!d) return type;
  return d['type:' + type] || d[type] || type;
}

// ---- the static chrome (index.html) --------------------------------------------------------------
// The English of every text node and attribute touched, so that switching back restores it exactly.
const origText = new WeakMap();
const origAttr = new WeakMap();
let origBlock = null; // selector -> its original innerHTML (only filled once a block was translated)

const SKIP_TAGS = /^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT|CODE|PRE)$/;
const ATTRS = ['title', 'placeholder', 'aria-label'];

function norm(s) { return s.replace(/\s+/g, ' ').trim(); }

function translateText(root) {
  const doc = root.ownerDocument || document;
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentNode;
      if (!p || p.nodeType !== 1 || SKIP_TAGS.test(p.nodeName)) return NodeFilter.FILTER_REJECT;
      if (p.closest('[data-no-i18n]')) return NodeFilter.FILTER_REJECT;
      const v = n.nodeValue;
      if (!v || !/\S/.test(v)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (w.nextNode()) nodes.push(w.currentNode);
  for (const n of nodes) {
    if (!origText.has(n)) origText.set(n, n.nodeValue);
    const en = origText.get(n);
    const key = norm(en);
    const zh = LANGS[lang]?.[key];
    if (!zh) { if (n.nodeValue !== en) n.nodeValue = en; continue; } // (no line: English, as written)
    const lead = en.match(/^\s*/)[0], tail = en.match(/\s*$/)[0];
    n.nodeValue = lead + zh + tail;
  }
}

function restoreText(root) {
  const doc = root.ownerDocument || document;
  const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  while (w.nextNode()) {
    const n = w.currentNode;
    const en = origText.get(n);
    if (en != null && n.nodeValue !== en) n.nodeValue = en;
  }
}

function translateAttrs(root) {
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (el.nodeType !== 1) continue;
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      let saved = origAttr.get(el);
      const cur = el.getAttribute(a);
      if (!saved) { saved = {}; origAttr.set(el, saved); }
      if (saved[a] == null) saved[a] = cur;
      const en = saved[a];
      const zh = LANGS[lang]?.[norm(en)];
      const want = zh ? zh : en;
      if (cur !== want) el.setAttribute(a, want);
    }
  }
}

// Blocks whose English is broken up by <b>, <i> or <a> inside the sentence: a text node at a time
// would scramble the word order, so the whole element is swapped instead.
function translateBlocks() {
  origBlock ||= new Map();
  for (const b of ZH_BLOCKS) {
    const el = document.querySelector(b.sel);
    if (!el) continue;
    if (!origBlock.has(b.sel)) origBlock.set(b.sel, el.innerHTML);
    const en = origBlock.get(b.sel);
    const want = lang === 'zh' ? b.zh : en;
    if (el.innerHTML !== want) el.innerHTML = want;
  }
}

// Applies the current language to the page. Called once at start and again after each switch.
// hydrate: a callback to run afterwards (the game's icons inside a re-drawn block need it).
export function applyStatic(root = document.body, hydrate) {
  if (lang === 'en') {
    restoreText(root);
    translateAttrs(root);
    translateBlocks();
  } else {
    translateText(root);
    translateAttrs(root);
    translateBlocks();
  }
  if (hydrate) hydrate(root);
}

// Switches the language: returns the new one. The caller saves it and re-renders what it built in
// code (the parts list, the inspector, the build panel).
export function setLang(l) {
  lang = LANGS[l] || l === 'en' ? l : 'en';
  if (!LANGS[lang]) lang = 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  return lang;
}

// The language to start in: what was chosen before, else the system's (Chinese Windows -> 中文).
export function pickLang(saved) {
  if (saved === 'en' || saved === 'zh') return saved;
  const sys = (navigator.languages?.[0] || navigator.language || '').toLowerCase();
  return sys.startsWith('zh') ? 'zh' : 'en';
}

// A title attribute that changes with the state is built in code; it goes through t() like the rest,
// but its lines are separate entries (the game's tooltip draws each line).
export const tLines = (lines) => lines.map((l) => t(l)).join('\n');
