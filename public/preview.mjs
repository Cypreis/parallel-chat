// Looping miniatures of the three layouts, built from DOM and the Web Animations API.
// Each animation is one keyframe track that spans the whole loop, so everything stays in sync.

export const MODES = {
  fit: { name: 'Fit', line: 'Every card on screen at once', caption: 'Cards share the width; a new one makes room.' },
  strip: { name: 'Strip', line: 'Full-height cards on a scrolling strip', caption: 'Cards keep their width; the strip scrolls.' },
  flow: { name: 'Flow', line: 'One chat; follow-ups become cards', caption: 'Select text, ask, and a card grows to its right.' },
};

const SVG = (inner) => `<svg viewBox="0 0 28 28" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export function glyph(mode) {
  if (mode === 'fit') return SVG('<rect x="3" y="6" width="6.5" height="16" rx="1.6"/><rect x="10.8" y="6" width="6.5" height="16" rx="1.6"/><rect x="18.6" y="6" width="6.5" height="16" rx="1.6"/>');
  if (mode === 'strip') return SVG('<rect x="2.5" y="6" width="9" height="16" rx="1.6"/><rect x="13" y="6" width="9" height="16" rx="1.6"/><path d="M24 14h2.5M25 12.5l1.5 1.5-1.5 1.5"/>');
  return SVG('<rect x="3" y="5" width="6" height="4.5" rx="1.4"/><rect x="3" y="12" width="6" height="6" rx="1.4"/><rect x="11.5" y="5" width="7" height="18" rx="1.6"/><rect x="21" y="5" width="5" height="8" rx="1.4"/><rect x="21" y="15" width="5" height="8" rx="1.4"/>');
}

const T = 6400;
const HOLD = 5000;
const EASE = 'cubic-bezier(.2,.8,.2,1)';

function el(cls, css, tag = 'div') {
  const d = document.createElement(tag);
  d.className = 'pv-' + cls;
  if (css) Object.assign(d.style, css);
  return d;
}
const px = (n) => n + 'px';

// frames: [[ms, {props}, easing?], ...] -> one looping animation
function track(node, frames, extra = {}) {
  const kf = frames.map(([t, props, easing]) => ({ offset: Math.min(1, t / T), ...props, ...(easing ? { easing } : {}) }));
  if (kf[0].offset !== 0) kf.unshift({ ...kf[0], offset: 0 });
  if (kf[kf.length - 1].offset !== 1) kf.push({ ...kf[kf.length - 1], offset: 1 });
  return node.animate(kf, { duration: T, iterations: Infinity, fill: 'both', easing: EASE, ...extra });
}

const HIDE = { opacity: 0 };
function appear(node, t0, t1, from = {}, to = {}, endFade = true) {
  const hidden = { opacity: 0, ...from };
  const shown = { opacity: 1, transform: 'translate(0px, 0px) scale(1)', ...to };
  const f = [[0, hidden], [t0, hidden], [t1, shown], [T - 900, shown]];
  return track(node, f);
}

function card(x, y, w, h, { lines = 4, tone = '', title = true } = {}) {
  const c = el('card' + (tone ? ' ' + tone : ''), { left: px(x), top: px(y), width: px(w), height: px(h) });
  const ls = [];
  let ly = 9;
  if (title) { const t = el('line title', { top: px(ly) }); c.append(t); ls.push([t, 46]); ly += 13; }
  for (let i = 0; i < lines; i++) {
    if (ly + 6 > h - 4) break;
    const l = el('line', { top: px(ly) });
    c.append(l);
    ls.push([l, i === lines - 1 ? 52 : 86 - (i % 2) * 8]);
    ly += 11;
  }
  return { el: c, lines: ls, x, y, w, h };
}

function writeIn(card, t0, per = 130) {
  card.lines.forEach(([line, pct], i) => {
    const a = t0 + i * per;
    track(line, [[0, { width: '0%' }], [a, { width: '0%' }], [a + 520, { width: pct + '%' }], [T, { width: pct + '%' }]], { easing: 'ease-out' });
  });
}

function progress() {
  const p = el('progress');
  const bar = el('progress-bar');
  p.append(bar);
  bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: T, iterations: Infinity, easing: 'linear' });
  return p;
}

function bubble(x, y, w, h, t0) {
  const b = el('bubble', { left: px(x), top: px(y), width: px(w), height: px(h) });
  const l = el('line', { left: '10px', top: px((h - 5) / 2), width: '60%' });
  b.append(l);
  appear(b, t0, t0 + 380, { transform: 'translate(8px, -4px) scale(.7)' });
  return b;
}

function buildFit(world) {
  world.append(bubble(196, 12, 92, 20, 250));
  const base = 14, gap = 8;
  const w0 = 85;
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const c = card(base + i * (w0 + gap), 44, w0, 134, { lines: 6 });
    world.append(c.el);
    cards.push(c);
  }
  // a fourth card arrives and the four glide narrower together
  const w1 = 62, step = w1 + gap;
  cards.forEach((c, i) => {
    const dx = base + i * step - c.x;
    const f = (tr, w) => ({ transform: tr, width: px(w) });
    const kf = [[0, f('translate(0px, 12px) scale(.98)', w0)]];
    kf.push([900 + i * 160, { ...f('translate(0px, 12px) scale(.98)', w0), opacity: 0 }]);
    kf.push([900 + i * 160 + 420, { ...f('translate(0px, 0px) scale(1)', w0), opacity: 1 }]);
    kf.push([3000, { ...f('translate(0px, 0px) scale(1)', w0), opacity: 1 }]);
    kf.push([3700, { ...f(`translate(${dx}px, 0px) scale(1)`, w1), opacity: 1 }]);
    kf.push([T - 900, { ...f(`translate(${dx}px, 0px) scale(1)`, w1), opacity: 1 }]);
    track(c.el, kf, { easing: EASE });
  });
  const c4 = card(base + 3 * step, 44, w1, 134, { lines: 6 });
  world.append(c4.el);
  appear(c4.el, 3300, 3900, { transform: 'translate(10px, 0px) scale(.96)' });
  writeIn(c4, 3700, 90);
  cards.forEach((c, i) => writeIn(c, 1200 + i * 160));
}

function buildStrip(world) {
  const inner = el('strip-inner');
  world.append(inner);
  const cw = 112;
  const cards = [14, 134, 254].map((x, i) => {
    const c = card(x, 16, cw, 150, { lines: 8 });
    inner.append(c.el);
    return c;
  });
  appear(cards[0].el, 250, 650, { transform: 'translate(0px, 12px) scale(.98)' });
  appear(cards[1].el, 400, 800, { transform: 'translate(0px, 12px) scale(.98)' });
  writeIn(cards[0], 700, 110);
  writeIn(cards[1], 850, 110);
  appear(cards[2].el, 1500, 2000, { transform: 'translate(36px, 0px) scale(.98)' });
  writeIn(cards[2], 1900, 110);
  // the strip glides left, back, and left again; cards never change width
  const L = -126;
  track(inner, [[0, { transform: 'translateX(0px)' }], [2000, { transform: 'translateX(0px)' }], [2800, { transform: `translateX(${L}px)` }], [3500, { transform: `translateX(${L}px)` }],
    [4300, { transform: 'translateX(0px)' }], [4500, { transform: 'translateX(0px)' }], [5200, { transform: `translateX(${L}px)` }], [T, { transform: `translateX(${L}px)` }]], { easing: EASE });
  const bar = el('sbar');
  const thumb = el('sthumb');
  bar.append(thumb);
  world.append(bar);
  const TL = 96;
  track(thumb, [[0, { transform: 'translateX(0px)' }], [2000, { transform: 'translateX(0px)' }], [2800, { transform: `translateX(${TL}px)` }], [3500, { transform: `translateX(${TL}px)` }],
    [4300, { transform: 'translateX(0px)' }], [4500, { transform: 'translateX(0px)' }], [5200, { transform: `translateX(${TL}px)` }], [T, { transform: `translateX(${TL}px)` }]], { easing: EASE });
}

function buildFlow(world) {
  const q = card(14, 14, 60, 30, { lines: 2, tone: 'q', title: false });
  const s = card(14, 52, 60, 60, { lines: 3, title: true });
  const big = card(82, 14, 92, 160, { lines: 12 });
  const med = card(194, 14, 86, 76, { lines: 4 });
  const nu = card(194, 98, 86, 76, { lines: 4, tone: 'new' });
  [[q, 300, 'translate(-6px, 8px) scale(.96)'], [big, 900, 'translate(0px, 12px) scale(.98)'], [med, 1400, 'translate(0px, 12px) scale(.98)'], [s, 1900, 'translate(0px, 12px) scale(.98)']].forEach(([c, t0, from]) => {
    world.append(c.el);
    appear(c.el, t0, t0 + 420, { transform: from });
    writeIn(c, t0 + 280, 90);
  });
  // the selection: an accent highlight sweeps across one line
  const hl = el('hl', { left: '90px', top: px(14 + 9 + 13 + 11 * 2 - 2), width: '70px', height: '9px', transformOrigin: 'left center' });
  world.append(hl);
  track(hl, [[0, { transform: 'scaleX(0)', opacity: 0 }], [3300, { transform: 'scaleX(0)', opacity: 0 }], [3350, { transform: 'scaleX(0)', opacity: 1 }], [3950, { transform: 'scaleX(1)', opacity: 1 }], [5000, { transform: 'scaleX(1)', opacity: 1 }], [5300, { transform: 'scaleX(1)', opacity: 0.4 }], [T, { transform: 'scaleX(1)', opacity: 0.4 }]]);
  // the prompt pill pops in beside it
  const pill = el('pill', { left: '104px', top: '86px', width: '72px', height: '16px' });
  pill.append(el('line', { left: '8px', top: '5px', width: '34px' }));
  world.append(pill);
  track(pill, [[0, { opacity: 0, transform: 'scale(.6)' }], [4000, { opacity: 0, transform: 'scale(.6)' }], [4350, { opacity: 1, transform: 'scale(1)' }], [4900, { opacity: 1, transform: 'scale(1)' }], [5200, { opacity: 0, transform: 'scale(.9)' }], [T, { opacity: 0, transform: 'scale(.9)' }]]);
  // the new card slides out to the right of its source; a curved connector draws in
  world.append(nu.el);
  appear(nu.el, 4750, 5350, { transform: 'translate(-40px, 0px) scale(.94)' });
  writeIn(nu, 5200, 70);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pv-conn');
  svg.setAttribute('viewBox', '0 0 300 190');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M 162 64 C 186 64, 176 136, 194 136');
  path.setAttribute('pathLength', '1');
  path.setAttribute('fill', 'none');
  svg.append(path);
  world.append(svg);
  path.style.strokeDasharray = '1';
  track(path, [[0, { strokeDashoffset: 1, opacity: 0 }], [4500, { strokeDashoffset: 1, opacity: 0 }], [4520, { strokeDashoffset: 1, opacity: 1 }], [5200, { strokeDashoffset: 0, opacity: 1 }], [5700, { strokeDashoffset: 0, opacity: 0.35 }], [T, { strokeDashoffset: 0, opacity: 0.35 }]]);
  const dot = el('dot');
  dot.style.offsetPath = "path('M 162 64 C 186 64, 176 136, 194 136')";
  world.append(dot);
  track(dot, [[0, { offsetDistance: '0%', opacity: 0 }], [4500, { offsetDistance: '0%', opacity: 0 }], [4540, { offsetDistance: '0%', opacity: 1 }], [5200, { offsetDistance: '100%', opacity: 1 }], [5260, { offsetDistance: '100%', opacity: 0 }], [T, { offsetDistance: '100%', opacity: 0 }]]);
}

export function buildPreview(mode) {
  const stage = el('stage');
  const world = el('world');
  stage.append(world);
  if (mode === 'fit') buildFit(world);
  else if (mode === 'strip') buildStrip(world);
  else buildFlow(world);
  // the whole scene fades out at the end of the loop and restarts clean
  world.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: (T - 800) / T }, { opacity: 0, offset: (T - 300) / T }, { opacity: 0, offset: 1 }], { duration: T, iterations: Infinity, easing: 'ease-in' });
  stage.append(progress());
  return stage;
}

// One popover shared by the start-screen tiles and the header control.
export function createPreviewHost() {
  const pop = el('pop');
  pop.hidden = true;
  pop.setAttribute('role', 'tooltip');
  const stageSlot = el('stage-slot');
  const cap = el('cap');
  const name = el('cap-name');
  const text = el('cap-text');
  cap.append(name, text);
  pop.append(stageSlot, cap);
  document.body.append(pop);

  let timer = 0;
  let anchor = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  function settle(root) {
    // reduced motion: a static final frame instead of a loop
    for (const a of root.getAnimations({ subtree: true })) {
      a.pause();
      a.currentTime = HOLD;
    }
  }

  function open(a, mode, place) {
    clearTimeout(timer);
    anchor = a;
    stageSlot.replaceChildren(buildPreview(mode));
    name.textContent = MODES[mode].name;
    text.textContent = MODES[mode].caption;
    pop.hidden = false;
    pop.classList.remove('closing');
    const r = a.getBoundingClientRect();
    const w = pop.offsetWidth || 300, h = pop.offsetHeight || 240;
    let left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const above = place === 'above' || (place !== 'below' && r.top - h - 10 >= 8);
    let top = above ? r.top - h - 10 : r.bottom + 10;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.transformOrigin = `${Math.round(r.left + r.width / 2 - left)}px ${above ? '100%' : '0%'}`;
    pop.classList.toggle('below', !above);
    if (reduced()) settle(pop);
  }

  function close() {
    clearTimeout(timer);
    anchor = null;
    if (pop.hidden) return;
    for (const a of pop.getAnimations({ subtree: true })) a.cancel();
    stageSlot.replaceChildren();
    if (reduced()) { pop.hidden = true; return; }
    pop.classList.add('closing');
    timer = setTimeout(() => { pop.hidden = true; pop.classList.remove('closing'); }, 90);
  }

  document.addEventListener('visibilitychange', () => {
    for (const a of pop.getAnimations({ subtree: true })) { if (document.hidden) a.pause(); else if (!reduced()) a.play(); }
  });

  return {
    showSoon(a, mode, delay = 250, place = 'auto') {
      clearTimeout(timer);
      timer = setTimeout(() => open(a, mode, place), delay);
    },
    show: open,
    hide: close,
    get anchor() { return anchor; },
    get isOpen() { return !pop.hidden && !pop.classList.contains('closing'); },
  };
}

// Inline preview for devices without hover.
export function mountInline(slot, mode) {
  slot.replaceChildren(buildPreview(mode));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (const a of slot.getAnimations({ subtree: true })) { a.pause(); a.currentTime = HOLD; }
  }
}
