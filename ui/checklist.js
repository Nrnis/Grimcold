// Parts checklist (Vehicle Builder): the parts a vehicle needs, typed or pasted as a list, ticked off
// while they are placed. Rebuilding a vehicle from the game goes quicker with it: the Exhibition
// shows a design's parts, the list here says what is still missing, and a line puts its part on the
// cursor.
//
// A line is a part's in-game name with a count before or after it:
//   4 Bigfoot ST · 4x Bigfoot ST · x4 Bigfoot ST · Bigfoot ST x4 · Bigfoot ST ×4 · Bigfoot ST (4)
//   Bigfoot ST: 4 · Bigfoot ST - 4 · Werewolf (one) · - Werewolf / 1. Werewolf (list bullets)
// Commas and semicolons also separate lines. A number at the end without x, ×, brackets or a colon
// belongs to the name ("Beacon 11"), and so does a size ("Lightweight frame 6×4"). "ST" at the end
// is the steering version of a wheel (the same model).

// Comparable form of a name: lower case, no accents, × as x, words only.
export const normName = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/×/g, 'x').replace(/[^a-z0-9]+/g, ' ').trim();
// "Ghost", not "Ghost (before 2021)" or "Ghost · kit"
export const plainName = (n) => n.replace(/ (·|\().*$/, '');

export function parseList(text) {
  const items = [];
  for (const raw of String(text).split(/[\n\r;,]+/)) {
    let s = raw.replace(/^\s*(?:[-*•·▪►–]|\d+[.)])\s+/, '').trim(); // bullets, "1." / "1)" numbering
    if (!s) continue;
    let count = 1, m;
    if ((m = s.match(/^(\d{1,3})\s*(?:x|×|\*|pcs?\.?)?\s+(.+)$/i))) { count = +m[1]; s = m[2]; } // 4 Bigfoot, 4x Bigfoot, 4 x Bigfoot
    else if ((m = s.match(/^[x×]\s*(\d{1,3})\s+(.+)$/i))) { count = +m[1]; s = m[2]; } // x4 Bigfoot
    else if ((m = s.match(/^(.+?)\s+[x×]\s*(\d{1,3})\s*(?:pcs?\.?)?$/i)) // Bigfoot x4, Bigfoot ×4
      || (m = s.match(/^(.+?)\s*\((\d{1,3})\)$/)) // Bigfoot (4)
      || (m = s.match(/^(.+?)\s*[:=]\s*(\d{1,3})$/)) // Bigfoot: 4
      || (m = s.match(/^(.+?)\s+[-–]\s*(\d{1,3})$/))) { count = +m[2]; s = m[1]; } // Bigfoot - 4
    s = s.trim();
    let st = false;
    if (/\sST$/i.test(s)) { st = true; s = s.replace(/\s+ST$/i, '').trim(); }
    if (!s || count < 1) continue;
    // the same part twice in a list adds up
    const twin = items.find((it) => normName(it.name) === normName(s) && it.st === st);
    if (twin) twin.count += count;
    else items.push({ name: s, count, st, done: false });
  }
  return items;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length];
}

// The in-game names of the models (path -> name), looked up by name.
export class NameIndex {
  constructor(names) { // iterable of [path, name]
    this.full = new Map(); // normName(name) -> paths
    this.fullShown = new Map(); // normName(name) -> the name as written
    this.plain = new Map(); // normName(plainName(name)) -> paths of every variant (skins, kits, old models)
    this.shown = new Map(); // normName(plainName) -> the plain name as written
    const add = (m, k, p) => { if (!k) return; const a = m.get(k); if (a) a.push(p); else m.set(k, [p]); };
    for (const [path, name] of names) {
      if (!name) continue;
      const fk = normName(name), pk = normName(plainName(name));
      add(this.full, fk, path);
      add(this.plain, pk, path);
      if (!this.fullShown.has(fk)) this.fullShown.set(fk, name);
      if (!this.shown.has(pk)) this.shown.set(pk, plainName(name));
    }
  }

  // { paths, name, guessed } for a typed name, or { paths: [], suggest: [names] } when it is unknown
  // or could mean several parts. A part's name takes in all its variants ("Bigfoot" also counts a
  // "Bigfoot · kit"); a variant's own full name only that one ("Ghost (before 2021)"); then a part
  // whose name holds every typed word ("tusk" for Tusk); then a near spelling ("Werwolf").
  resolve(typed) {
    const k = normName(typed);
    if (!k) return { paths: [], suggest: [] };
    if (this.plain.has(k)) return { paths: this.plain.get(k), name: this.shown.get(k), guessed: false };
    if (this.full.has(k)) return { paths: this.full.get(k), name: this.fullShown.get(k), guessed: false };
    const words = k.split(' ');
    const hits = [...this.plain.keys()].filter((n) => { const nw = n.split(' '); return words.every((w) => nw.some((x) => x.startsWith(w))); });
    if (hits.length === 1) return { paths: this.plain.get(hits[0]), name: this.shown.get(hits[0]), guessed: true };
    if (hits.length > 1) {
      hits.sort((a, b) => a.length - b.length);
      return { paths: [], suggest: hits.slice(0, 4).map((h) => this.shown.get(h)) };
    }
    if (k.length >= 4) {
      const near = [...this.plain.keys()].map((n) => [n, editDistance(k, n)]).filter(([, d]) => d <= (k.length >= 8 ? 2 : 1)).sort((a, b) => a[1] - b[1]);
      if (near.length === 1 || (near.length > 1 && near[0][1] < near[1][1])) return { paths: this.plain.get(near[0][0]), name: this.shown.get(near[0][0]), guessed: true };
      if (near.length) return { paths: [], suggest: near.slice(0, 4).map(([n]) => this.shown.get(n)) };
    }
    return { paths: [], suggest: [] };
  }
}
