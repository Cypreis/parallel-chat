// One small tooltip for every `data-tip` element. Mouse and keyboard only; never on touch.
// Elements that still carry a native `title` are converted the first time they are pointed at.

let tip = null;
let timer = 0;
let shownAt = 0;
let current = null;

function ensure() {
  if (tip) return tip;
  tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);
  return tip;
}

function textOf(el) {
  if (el.hasAttribute('title') && !el.dataset.tip) {
    el.dataset.tip = el.getAttribute('title');
    el.removeAttribute('title');
  }
  return el.dataset.tip || '';
}

function place(el) {
  const t = ensure();
  const r = el.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  let left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  t.style.left = left + 'px';
  t.style.top = top + 'px';
}

function show(el) {
  const text = textOf(el);
  if (!text) return;
  const t = ensure();
  current = el;
  t.textContent = text;
  t.hidden = false;
  t.classList.remove('on');
  place(el);
  requestAnimationFrame(() => t.classList.add('on'));
  shownAt = performance.now();
}

export function hideTip() {
  clearTimeout(timer);
  current = null;
  if (tip && !tip.hidden) {
    tip.hidden = true;
    tip.classList.remove('on');
    shownAt = performance.now();
  }
}

export function installTooltips() {
  const find = (n) => (n instanceof Element ? n.closest('[data-tip], [title]') : null);
  const skip = (el) => !el || el.matches('input, textarea, select') || el.closest('.preview-pop');
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType && e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    const el = find(e.target);
    if (!el || skip(el) || el === current) return;
    if (!textOf(el)) return;
    clearTimeout(timer);
    // after one tooltip has been showing, the next one follows quickly
    const quick = performance.now() - shownAt < 500 && tip && !tip.hidden || performance.now() - shownAt < 300;
    timer = setTimeout(() => show(el), quick ? 100 : 400);
  });
  document.addEventListener('pointerout', (e) => {
    const el = find(e.target);
    if (!el || el.contains(e.relatedTarget)) return;
    if (el === current || timer) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    const el = find(e.target);
    if (!el || skip(el) || !e.target.matches?.(':focus-visible')) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), 400);
  });
  document.addEventListener('focusout', hideTip);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); }, true);
  window.addEventListener('scroll', hideTip, true);
}
