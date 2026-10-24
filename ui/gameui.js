// The game's look for what the browser would draw itself: tooltips (in place of the title
// attributes' system tips), drop-down lists (the <select>s stay the real thing: their value, their
// options and their change events; only the list that opens is ours) and the yes / no question (in
// place of window.confirm). Styles in skin.css (.xo-tip, .xo-drop, .xo-ask).

// ---- tooltips: the game's (black, a pale frame, a white tab in its corner), after a short wait ----
let tipEl = null, tipFor = null, tipTimer = 0, tipX = 0, tipY = 0;
function tipBox() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'xo-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    document.body.append(tipEl);
  }
  return tipEl;
}
function placeTip() {
  const t = tipBox(), w = t.offsetWidth, h = t.offsetHeight;
  let x = tipX + 14, y = tipY + 20;
  if (x + w > innerWidth - 6) x = Math.max(6, innerWidth - 6 - w);
  if (y + h > innerHeight - 6) y = Math.max(6, tipY - h - 10);
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}
function showTip(el) {
  const text = el.dataset.xoTip;
  if (!text) return;
  const t = tipBox(), lines = text.split('\n').filter((l) => l.trim());
  t.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); d.textContent = l; if (i === 0 && lines.length > 1) d.className = 'xo-tip-head'; return d; }));
  t.hidden = false;
  placeTip();
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.hidden = true;
  if (tipFor) { // (the title goes back: the page reads it, and it changes with the state)
    if (tipFor.dataset.xoTip != null && !tipFor.hasAttribute('title')) tipFor.setAttribute('title', tipFor.dataset.xoTip);
    delete tipFor.dataset.xoTip;
    tipFor = null;
  }
}
export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('[title]');
    if (!el || el === tipFor) return;
    if (el.closest('#view')) return; // (the 3D view names what is under the mouse itself)
    hideTip();
    const text = el.getAttribute('title');
    if (!text) return;
    el.dataset.xoTip = text;
    el.removeAttribute('title'); // (no system tip beside ours)
    tipFor = el;
    tipX = e.clientX; tipY = e.clientY;
    tipTimer = setTimeout(() => { if (tipFor === el && el.isConnected) showTip(el); }, 450);
  }, true);
  document.addEventListener('pointermove', (e) => { tipX = e.clientX; tipY = e.clientY; if (tipEl && !tipEl.hidden) placeTip(); }, true);
  document.addEventListener('pointerout', (e) => { if (tipFor && !(e.relatedTarget && tipFor.contains(e.relatedTarget))) hideTip(); }, true);
  for (const ev of ['pointerdown', 'wheel', 'keydown', 'blur']) window.addEventListener(ev, hideTip, true);
}

// ---- drop-down lists: the game's list (dark, rows lit from the left, the picked one orange) ----
let drop = null;
function closeDrop() {
  if (!drop) return;
  drop.el.remove();
  window.removeEventListener('pointerdown', drop.outside, true);
  window.removeEventListener('keydown', drop.keys, true);
  window.removeEventListener('resize', closeDrop);
  document.removeEventListener('scroll', drop.scroll, true);
  drop = null;
}
function openDrop(sel) {
  closeDrop();
  const el = document.createElement('div');
  el.className = 'xo-drop';
  el.setAttribute('role', 'listbox');
  const items = [];
  const add = (opt, inGroup) => {
    if (opt.hidden) return;
    const it = document.createElement('div');
    it.className = 'xo-drop-item' + (inGroup ? ' in-group' : '') + (opt.disabled ? ' off' : '') + (opt.index === sel.selectedIndex ? ' on' : '');
    it.textContent = opt.textContent;
    if (opt.title) it.title = opt.title;
    it.setAttribute('role', 'option');
    it.dataset.i = opt.index;
    items.push(it);
    el.append(it);
  };
  for (const c of sel.children) {
    if (c.tagName === 'OPTGROUP') {
      const g = document.createElement('div');
      g.className = 'xo-drop-group';
      g.textContent = c.label;
      el.append(g);
      for (const o of c.children) add(o, true);
    } else if (c.tagName === 'OPTION') add(c, false);
  }
  document.body.append(el);
  const r = sel.getBoundingClientRect();
  el.style.minWidth = Math.ceil(r.width) + 'px';
  const h = el.offsetHeight, below = innerHeight - r.bottom - 8, above = r.top - 8;
  const up = h > below && above > below;
  el.style.maxHeight = Math.max(120, Math.min(360, up ? above : below)) + 'px';
  el.style.left = Math.max(6, Math.min(r.left, innerWidth - el.offsetWidth - 6)) + 'px';
  el.style.top = (up ? r.top - Math.min(el.offsetHeight, above) - 2 : r.bottom + 2) + 'px';
  let hi = items.findIndex((i) => i.classList.contains('on'));
  const light = (k) => {
    items[hi]?.classList.remove('hi');
    hi = k;
    const it = items[hi];
    if (it) { it.classList.add('hi'); it.scrollIntoView({ block: 'nearest' }); }
  };
  light(hi);
  const pick = (it) => {
    if (!it || it.classList.contains('off')) return;
    const i = +it.dataset.i;
    closeDrop();
    sel.focus();
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  el.addEventListener('pointermove', (e) => { const it = e.target.closest('.xo-drop-item'); if (it && !it.classList.contains('off')) light(items.indexOf(it)); });
  el.addEventListener('click', (e) => pick(e.target.closest('.xo-drop-item')));
  const step = (d) => { for (let k = hi + d; k >= 0 && k < items.length; k += d) if (!items[k].classList.contains('off')) { light(k); return; } };
  drop = {
    el, sel,
    outside: (e) => { if (!el.contains(e.target) && e.target !== sel) closeDrop(); },
    keys: (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeDrop(); sel.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pick(items[hi]); }
      else if (e.key === 'Tab') closeDrop();
    },
    scroll: (e) => { if (!el.contains(e.target)) closeDrop(); },
  };
  window.addEventListener('pointerdown', drop.outside, true);
  window.addEventListener('keydown', drop.keys, true);
  window.addEventListener('resize', closeDrop);
  document.addEventListener('scroll', drop.scroll, true);
}
export function initSelects() {
  document.addEventListener('mousedown', (e) => {
    const sel = e.target.closest?.('select');
    if (!sel || e.button !== 0 || sel.disabled || sel.multiple || sel.size > 1) return;
    e.preventDefault(); // (no system list)
    if (drop?.sel === sel) { closeDrop(); return; }
    sel.focus();
    openDrop(sel);
  }, true);
  // the keyboard on a focused list: Alt+Down / F4 open ours (arrows keep changing it in place)
  document.addEventListener('keydown', (e) => {
    const sel = document.activeElement;
    if (drop || sel?.tagName !== 'SELECT' || sel.disabled) return;
    if ((e.key === 'ArrowDown' && e.altKey) || e.key === 'F4') { e.preventDefault(); openDrop(sel); }
  }, true);
}

// ---- the yes / no question: the game's dialog window (its orange header), two buttons ----
const nativeConfirm = window.confirm;
export function ask(message, { title = 'Are you sure?', yes = 'OK', no = 'Cancel' } = {}) {
  // (a test answers it itself, as it answered window.confirm: no window to click in a hidden app)
  if (window.confirm !== nativeConfirm) return Promise.resolve(!!window.confirm(message));
  return new Promise((done) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal xo-ask';
    wrap.innerHTML = '<div class="modal-card" role="alertdialog" aria-modal="true"><h2></h2><p></p><div class="row right"><button class="btn" data-a="no"></button><button class="btn primary" data-a="yes"></button></div></div>';
    wrap.querySelector('h2').textContent = title;
    wrap.querySelector('p').textContent = message;
    wrap.querySelector('[data-a=no]').textContent = no;
    wrap.querySelector('[data-a=yes]').textContent = yes;
    const end = (v) => { wrap.remove(); window.removeEventListener('keydown', keys, true); done(v); };
    const keys = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); end(true); }
    };
    wrap.addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) end(a === 'yes'); else if (e.target === wrap) end(false); });
    window.addEventListener('keydown', keys, true);
    document.body.append(wrap);
    wrap.querySelector('[data-a=yes]').focus();
  });
}
