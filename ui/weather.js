// The Maps view's Weather menu: readable names for a map's environments (the envsettings.mxml
// Items, named after the game's environment presets, "_midland/day_clear_al120_az330": a region
// folder, the time of day and weather, the sun's height and direction, sometimes the map).

const TYPOS = { mountan: 'mountain', sanset: 'sunset', armaggedon: 'armageddon', weather: '', bm: '' }; // ("snow_weather"; bm: bentmetal)
const WORDS = {
  dull: 'overcast', norain: 'no rain', darkfog: 'dark fog', highsand: 'high sand', lowsand: 'low sand', farsand: 'far sand',
  cityruin: 'city ruin', newyear: 'New Year', halloween: 'Halloween', '4horsemen': 'four horsemen', hangarold: 'old hangar',
  aprilfools: 'April Fools', godzilla: 'Godzilla', fuji: 'Fuji', asia: 'Asia',
};
// (a comma after these when more follows: "Day, clear", "Overcast, no rain")
const LEADS = new Set(['day', 'morning', 'sunrise', 'sunset', 'dawn', 'night', 'overcast', 'cloudy', 'New Year', 'Halloween']);
const FESTIVALS = { NewYear: 'New Year', ChinaNY2024: 'China New Year 2024', ChinaMonPromo: 'China promo' };

export const festivalLabel = (f) => FESTIVALS[f] || f.replace(/([a-z])([A-Z])/g, '$1 $2');

// env: { name, festivals, modeOk }; map: the map's name (words of it in the preset's name say
// nothing in its own menu). level: how much to keep, to tell two apart: 1 the sky-picture number,
// 2 the map's words too, 3 the region folder too.
export function weatherLabel(env, map = '', level = 0) {
  const parts = String(env.name || env.id || '').split('/');
  const folder = parts.length > 1 ? parts[0].replace(/^_+/, '').replace(/\u0441/g, 'c') : ''; // ("_special" is spelt with a Cyrillic c)
  const mapWords = String(map).toLowerCase().split(/[_\s]+/).filter((w) => w.length > 2);
  const isMapWord = (w) => mapWords.includes(w) || (w.length > 4 && mapWords.some((m) => m.includes(w)));
  let t = parts.at(-1).toLowerCase().split('_').map((w) => (w in TYPOS ? TYPOS[w] : w)).filter(Boolean);
  // the sun's height and direction (al120, az330, az 5), "fix" (a fixed copy)
  t = t.filter((w, i) => !/^a[lz]\d+$/.test(w) && w !== 'fix' && !(w === 'az' && /^\d+$/.test(t[i + 1] || '')) && !(/^\d+$/.test(w) && t[i - 1] === 'az'));
  t = level >= 1 ? t.map((w) => w.replace(/^sky(\d+)$/, 'sky $1')) : t.filter((w) => !/^sky\d*$/.test(w));
  if (level < 2) {
    const kept = t.filter((w) => !isMapWord(w));
    if (kept.some((w) => !/^\d+$/.test(w))) t = kept; // (only the map's words, or a number: keep them)
  }
  if (t[0] === 'new' && t[1] === 'year') t.splice(0, 2, 'newyear');
  t = t.map((w) => WORDS[w] || w.replace(/^([a-z]+)(\d+)$/, '$1 $2').replace(/^0+(\d)/, '$1'));
  if (folder === 'aprilfools') t.unshift('April Fools');
  if (!t.length) t = [folder || String(env.id || '?')];
  let s = (t.length > 1 && LEADS.has(t[0]) && !/^\d/.test(t[1]) ? `${t[0]}, ${t.slice(1).join(' ')}` : t.join(' ')).replace('clear dust', 'clear, dusty');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (level >= 3 && folder && folder !== 'aprilfools') s += ` (${folder.replace(/_/g, ' ')})`;
  const fest = env.festivals || [], only = fest.filter((f) => f !== 'Empty');
  if (only.length && !fest.includes('Empty') && !only.some((f) => s.toLowerCase().includes(festivalLabel(f).toLowerCase()))) s += ` (${only.length > 2 ? 'festivals' : only.map(festivalLabel).join(', ')})`;
  if (env.modeOk === false) s += ' (other modes)';
  return s;
}

// The menu's entries: every environment of the map once (a map can list one twice), each with a
// name no other one has.
export function weatherChoices(envs, map = '') {
  const byId = new Map();
  for (const e of envs || []) {
    const o = byId.get(e.id);
    if (!o) { byId.set(e.id, { ...e, festivals: [...(e.festivals || [])] }); continue; }
    o.modeOk = o.modeOk !== false || e.modeOk !== false;
    for (const f of e.festivals || []) if (!o.festivals.includes(f)) o.festivals.push(f);
    if (!(e.festivals || []).length) o.festivals = []; // (listed without festivals: any)
  }
  const list = [...byId.values()];
  const out = list.map((e) => ({ id: e.id, name: e.name, label: weatherLabel(e, map) }));
  for (let level = 1; level <= 4; level++) {
    const count = new Map(), nth = new Map();
    for (const o of out) count.set(o.label, (count.get(o.label) || 0) + 1);
    out.forEach((o, i) => {
      if (count.get(o.label) < 2) return;
      nth.set(o.label, (nth.get(o.label) || 0) + 1);
      o.label = level <= 3 ? weatherLabel(list[i], map, level) : `${o.label} #${nth.get(o.label)}`; // (the same words, another sun: numbered)
    });
  }
  return out;
}
