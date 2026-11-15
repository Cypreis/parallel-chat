import * as R from '/shared/project.mjs';
import { installCanvas, refreshEdges, scrollHome } from '/canvas.mjs';
import { MODES, glyph, createPreviewHost, mountInline } from '/preview.mjs';
import { installTooltips, hideTip } from '/tooltip.mjs';
import { keyName, prettyKeys, fuzzy, createSequencer, lineEdit, onFirstLine, onLastLine, createHistory } from '/commands.mjs';

// Tooltips are one styled component: `title` is routed to data-tip so the browser's own never shows.
Object.defineProperty(HTMLElement.prototype, 'title', {
  configurable: true,
  get() { return this.dataset.tip ?? ''; },
  set(v) { if (v) this.dataset.tip = v; else delete this.dataset.tip; },
});
for (const el of document.querySelectorAll('[title]')) { el.dataset.tip = el.getAttribute('title'); el.removeAttribute('title'); }
installTooltips();
import { plainQuote, renderMarkdown, firstSentence, truncate, edgePhrase, formatChars, STATUS_LABEL, EDGE_VERB } from '/lib.mjs';

/* ------------------------------------------------------------------ state */

const { createState, applyEvent, turns, cardsOf, threadOf, edgesOf, cardOf } = R;
// Flow needs the reducer's chat helpers; on an older server fall back to one question per chat and hide Flow.
const HAS_FLOW = typeof R.chats === 'function' && typeof R.cardsInOrder === 'function';
const chatsOf = HAS_FLOW ? R.chats : (st) => turns(st).map((q) => ({ id: q.id, questions: [q] }));
const cardsOrdered = HAS_FLOW ? R.cardsInOrder : cardsOf;
const chatIdOf = HAS_FLOW && typeof R.chatOf === 'function' ? R.chatOf : (st, id) => st.nodes[id]?.turnId ?? null;

let state = createState();
const nodeChat = (id) => chatIdOf(state, id);

function loadView() {
  try { const v = localStorage.getItem('pc.view'); return v === 'strip' ? 'strip' : v === 'flow' && HAS_FLOW ? 'flow' : 'fit'; } catch { return 'fit'; }
}
function loadWidth() {
  try { const raw = localStorage.getItem('pc.width'); const n = raw == null ? NaN : Number(raw); return n >= 0 && n <= 4 && Number.isInteger(n) ? n : 1; } catch { return 1; }
}
function saveWidth(n) {
  try { localStorage.setItem('pc.width', String(n)); } catch { /* storage unavailable */ }
}
function loadSide() {
  try { const v = localStorage.getItem('pc.side'); return v === 'closed' ? false : v === 'open' ? true : null; } catch { return null; }
}
function saveSide(open) {
  try { localStorage.setItem('pc.side', open ? 'open' : 'closed'); } catch { /* storage unavailable */ }
}
function loadSquare() {
  try { return localStorage.getItem('pc.square') !== 'off'; } catch { return true; }
}
function saveSquare(on) {
  try { localStorage.setItem('pc.square', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}
function loadShell() {
  try { return localStorage.getItem('pc.shell') !== 'off'; } catch { return true; }
}
function saveShell(on) {
  try { localStorage.setItem('pc.shell', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}
function saveView(v) {
  try { localStorage.setItem('pc.view', v); } catch { /* storage unavailable */ }
}

const ui = {
  view: loadView(),
  activeId: null,        // chat (question id) on screen
  pendingActivate: null, // chat to open once its question node arrives
  selected: new Set(),
  shell: loadShell(),    // shell-style editing keys in text boxes
  palette: false,
  prevWidth: null,
  square: loadSquare(),  // Flow: short cards become 260px squares
  width: loadWidth(),    // default Strip card width: a SIZES id, or 2 for Focus
  cardW: new Map(),      // card id -> own SIZES id (session only)
  current: new Map(),    // chat id -> current card id (the one keys act on)
  order: new Map(),      // chat id -> card ids in strip order (client side only)
  insertAfter: new Map(),// new card id -> card it should open beside
  scrollX: new Map(),    // chat id -> last strip scrollLeft
  scrollTo: null,        // card id to bring into view after the next render (user action only)
  unreadChats: new Set(),
  quotes: new Map(),     // card id -> quoted text waiting in its composer
  ctxOpen: new Set(),
  linkedId: null,
  drawer: null,          // null | { kind: 'decisions' } | { kind: 'peek', edgeId, cardId }
  pop: null,             // null | 'settings' (dialog) | 'help' (popover)
  live: false,           // true once the replayed history has arrived
  start: false,          // start screen shown on request (New chat)
  sideOpen: loadSide(),  // docked sidebar open (true), collapsed (false), or default (null)
  overlay: false,        // sidebar shown as an overlay
  boardW: 0,
  qOpen: false,          // question bubble expanded
  prov: { status: 'idle', active: null, list: [], sel: null, filter: '', ui: {} }, // providers (Model section)
  connected: true,
  config: { provider: '', model: '', mode: 'single', maxCards: null },
  confirmReset: false,
  chatNo: new Map(),
  chats: [], chatById: new Map(), shownChat: null, qIndex: new Map(),
};

const cardViews = new Map();
const msgViews = new Map();
const chatViews = new Map();
const tabViews = new Map();
const qViews = new Map();
const decViews = new Map();
const peekMsgs = new Map();
const ovViews = new Map();

const $ = (id) => document.getElementById(id);
const els = {
  shell: $('shell'), side: $('side'), scrim: $('scrim'), main: $('app-main'), board: $('board'), chats: $('chats'), empty: $('empty'), examples: $('examples'), notices: $('notices'),
  sideToggle: $('side-toggle'), newChat: $('new-chat'), menuBtn: $('menu-btn'), chatList: $('chat-list'),
  qStep: $('q-step'), qStepText: $('q-step-text'), qPrev: $('q-prev'), qNext: $('q-next'), branchPrompt: $('branch-prompt'), branchInput: $('branch-input'), branchSend: $('branch-send'), topNo: $('top-no'), topMeta: $('top-meta'), qRow: $('qrow'), qBubble: $('q-bubble'), viewSeg: $('view-seg'),
  decBtn: $('dec-btn'), decCount: $('dec-count'), settingsBtn: $('settings-btn'), helpBtn: $('help-btn'),
  drawer: $('drawer'), drawerTitle: $('drawer-title'), drawerClose: $('drawer-close'), paneDec: $('pane-dec'), panePeek: $('pane-peek'),
  decisions: $('decisions'), decForm: $('dec-form'), decInput: $('dec-input'), decErr: $('dec-err'),
  selbar: $('selbar'), selCount: $('sel-count'), selInput: $('sel-input'), selSend: $('sel-send'), selSynth: $('sel-synth'), selClear: $('sel-clear'),
  overview: $('overview'), widthSeg: $('width-seg'),
  askForm: $('ask-form'), askInput: $('ask-input'), askSend: $('ask-send'), askErr: $('ask-err'), conn: $('conn'), hint: $('ask-hint'),
  settings: $('settings'), settingsDialog: $('settings-dialog'), settingsScrim: $('settings-scrim'), settingsClose: $('settings-close'),
  help: $('help'), maxSeg: $('max-seg'), provider: $('provider'), providerLine: $('provider-line'), modelUi: $('model-ui'),
  sqSwitch: $('sq-switch'),
  resetBtn: $('reset-btn'), resetYes: $('reset-yes'), resetNo: $('reset-no'),
  palette: $('palette'), paletteInput: $('palette-input'), paletteList: $('palette-list'), paletteScrim: $('palette-scrim'),
  keys: $('keys'), keysDialog: $('keys-dialog'), keysBody: $('keys-body'), keysFilter: $('keys-filter'), keysClose: $('keys-close'), keysScrim: $('keys-scrim'),
  keyhint: $('keyhint'), slashMenu: $('slash-menu'), rsearch: $('rsearch'), shellSwitch: $('shell-switch'),
  askPop: $('ask-pop'), dock: $('dock'), modePick: $('mode-pick'), modeTiles: $('mode-tiles'), modeInline: $('mode-inline'),
};

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Narrow is a property of the board, not the window: the sidebar takes width too.
const isNarrow = () => ui.boardW > 0 && ui.boardW < 720;
const effView = () => (isNarrow() && ui.view === 'fit' ? 'strip' : ui.view);
const cssVar = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
const SPRING = cssVar('--spring', 'cubic-bezier(.2, .8, .2, 1)');
const SPRING_SOFT = cssVar('--spring-soft', 'cubic-bezier(.2, .8, .2, 1)');
const MOVE_MS = 320;
// Strip card widths, narrowest first: `n` cards fill the board. The ids are
// what is saved, so the older ones (0 = 1/3, 1 = 1/2, 2 = Focus) keep meaning.
const SIZES = [{ id: 3, label: '1/4', n: 4 }, { id: 0, label: '1/3', n: 3 }, { id: 1, label: '1/2', n: 2 }, { id: 4, label: 'Full', n: 1 }];
const sizeIndex = (id) => Math.max(0, SIZES.findIndex((s) => s.id === id));
// a card's own size, else the board default (Focus counts as 1/2 for the per-card button)
const sizeOf = (cardId) => ui.cardW.get(cardId) ?? (ui.width === 2 ? 1 : ui.width);
const TABLE_RE = /^\s*\|.*\|\s*\n\s*\|?\s*:?-+:?\s*\|/m;
// the size a card shows: fit to content makes a table card at least 1/2 unless the person sized it
function sizeIdxOf(cardId) {
  const i = sizeIndex(sizeOf(cardId));
  return !ui.cardW.has(cardId) && TABLE_RE.test(state.nodes[cardId]?.body || '') ? Math.max(i, sizeIndex(1)) : i;
}
// Focus: the current card is centred and about half the board wide; each
// neighbour is narrowed to fit whole in the space beside it, so its text reads.
const isFocusOn = () => ui.width === 2 && effView() === 'strip' && !isNarrow();
const FOCUS_GAP = 12; // the strip's card gap (--s-3)
function focusLayout() {
  const b = els.board.clientWidth, g = FOCUS_GAP;
  let cur = Math.min(Math.round(b / 2), 820);
  let side = Math.floor((b - cur) / 2 - 2 * g);
  if (side < 220) { cur = Math.max(320, b - 2 * (220 + 2 * g)); side = Math.max(160, Math.floor((b - cur) / 2 - 2 * g)); }
  return { cur, side, pad: Math.round((b - cur) / 2) };
}

/* ---------------------------------------------------------------- helpers */

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'title') el.dataset.tip = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
}

const ICONS = {
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  arrowUp: '<path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5M12 16h.01"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 7v10M18 11c0 4-6 3-12 6"/>',
};
function icon(name, cls = '') {
  const s = document.createElement('span');
  s.className = 'ic' + (cls ? ' ' + cls : '');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return s;
}

// A changing counter rolls: the old text lifts away, the new one rises in.
function rollText(el, text) {
  if (el._t === text) return;
  const old = el._t;
  el._t = text;
  if (old == null || reducedMotion.matches || !el.isConnected) { el.textContent = text; return; }
  el.classList.add('roll');
  const prev = h('span', { class: 'roll-out', text: old });
  const next = h('span', { class: 'roll-in', text });
  el.replaceChildren(prev, next);
  prev.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-60%)', opacity: 0 }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
  next.animate([{ transform: 'translateY(60%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 220, easing: SPRING, fill: 'backwards' });
  clearTimeout(el._rt);
  el._rt = setTimeout(() => { if (el._t === text) { el.textContent = text; } }, 260);
}

function setText(el, text) {
  if (el._t !== text) { el._t = text; el.textContent = text; }
}
function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}
function setClass(el, name, on) {
  if (el.classList.contains(name) !== !!on) el.classList.toggle(name, !!on);
}
function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// Keep `parent`'s children equal to `list`, moving only what is out of place.
function reconcile(parent, list) {
  let cur = parent.firstElementChild;
  for (const el of list) {
    if (el === cur) cur = cur.nextElementSibling;
    else parent.insertBefore(el, cur);
  }
  while (cur) {
    const next = cur.nextElementSibling;
    cur.remove();
    cur = next;
  }
}

function selectionIn(el) {
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) return false;
  return el.contains(s.anchorNode) || el.contains(s.focusNode);
}

let deferredBySelection = false;

// Re-render only when the text changed, and never under a live selection.
function setMarkdown(el, text, fade) {
  if (el._src === text) return;
  if (selectionIn(el)) { deferredBySelection = true; return; }
  const prevN = el._n || 0;
  el._src = text;
  el.innerHTML = renderMarkdown(text);
  const n = el.children.length;
  if (fade && n > prevN && !reducedMotion.matches) {
    for (let i = prevN; i < n; i++) el.children[i].animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'ease-out' });
  }
  el._n = n;
}
function setPlain(el, text) {
  if (el._src === text) return;
  if (selectionIn(el)) { deferredBySelection = true; return; }
  el._src = text;
  el.textContent = text;
}

function autosize(ta, max = 140) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px';
}
function syncSend(ta, btn) {
  setClass(btn, 'has-text', ta.value.trim().length > 0);
}

function titleOf(id) {
  const n = state.nodes[id];
  return n ? (n.title || 'Untitled card') : 'a card';
}
const chatNo = (chatId) => ui.chatNo.get(chatId) ?? '?';

/* -------------------------------------------------------------------- api */

async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data ?? {};
  } catch (e) {
    notify(e instanceof TypeError ? 'Could not reach the server.' : e.message);
    return null;
  }
}

function notify(message) {
  const box = h('div', { class: 'notice', role: 'alert' },
    h('span', { class: 'notice-text', text: message }),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => box.remove() }, icon('x')));
  els.notices.append(box);
  while (els.notices.children.length > 3) els.notices.firstElementChild.remove();
}

/* ----------------------------------------------------------------- stream */

let es = null;
let reconnectTimer = 0;

// Entrance animation is only for what is created while the page is open: replayed history stays still.
let liveT = 0;
function armLive() { clearTimeout(liveT); liveT = setTimeout(() => { ui.live = true; }, 400); }
function markReady() { document.documentElement.classList.add('ready'); }
setTimeout(markReady, 900);

function connect() {
  clearTimeout(reconnectTimer);
  if (es) es.close();
  es = new EventSource(state.seq ? `/api/events?since=${state.seq}` : '/api/events');
  es.onopen = () => { ui.connected = true; renderConn(); loadConfig(); setTimeout(markReady, 60); if (!ui.live) armLive(); };
  es.onerror = () => {
    ui.connected = false;
    renderConn();
    if (es.readyState === EventSource.CLOSED) reconnectTimer = setTimeout(connect, 2000);
  };
  es.onmessage = (m) => {
    try { onEvent(JSON.parse(m.data)); } catch (e) { console.error('bad event', e); }
  };
}

function resetUi() {
  ui.selected.clear(); ui.unreadChats.clear(); ui.quotes.clear(); ui.ctxOpen.clear();
  for (const m of [ui.cardW, ui.current, ui.order, ui.insertAfter, ui.scrollX]) m.clear();
  ui.scrollTo = null; ui.activeId = null; ui.pendingActivate = null; ui.drawer = null; ui.linkedId = null;
  for (const m of [cardViews, msgViews, chatViews, tabViews, decViews, peekMsgs, ovViews, qViews, ui.qIndex]) m.clear();
  ui.shownChat = null;
  ui.start = false;
  for (const c of [els.chats, els.chatList, els.decisions, els.overview]) c.replaceChildren();
  peek.thread.replaceChildren();
}

function onEvent(ev) {
  if (!ui.live) armLive();
  // A log that starts over (server restart or reset) numbers from 1 again.
  if (ev.seq === 1 && state.seq > 1) { state = createState(); resetUi(); }
  const before = state.seq;
  applyEvent(state, ev);
  if (state.seq === before) return; // duplicate from a replay
  if (ev.type === 'session.reset') resetUi();
  else if (ev.type === 'node.close' && ev.status !== 'cancelled') markUnread(ev.id);
  schedule();
}

function markUnread(id) {
  const cid = nodeChat(id);
  if (cid && cid !== ui.activeId && state.nodes[cid]) ui.unreadChats.add(cid);
}

/* ----------------------------------------------------------------- render */

let raf = 0;
function schedule() {
  if (!raf) raf = requestAnimationFrame(render);
}

function render() {
  raf = 0;
  deferredBySelection = false;
  try {
    if (els.board.clientWidth > 0) ui.boardW = els.board.clientWidth;
    const ts = prepare();
    renderChats(ts);
    renderOverview(ui.activeId ? orderedCards(ui.activeId) : []);
    renderTop(ts);
    renderSide();
    renderSideList(ts);
    renderDrawer();
    renderBar();
    renderSettings();
    updatePills();
    runFlight();
    if (ui.flight && !ui.flight.q === false) schedule();
  } catch (e) {
    console.error('render failed', e);
  }
}

function prepare() {
  const ts = chatsOf(state);
  ui.chats = ts;
  ui.chatById = new Map(ts.map((c) => [c.id, c]));
  ui.chatNo = new Map(ts.map((c, i) => [c.id, i + 1]));
  if (ui.pendingActivate && state.nodes[ui.pendingActivate]) {
    ui.activeId = nodeChat(ui.pendingActivate) || ui.pendingActivate;
    ui.pendingActivate = null;
    ui.start = false;
  }
  if (!ui.chatNo.has(ui.activeId)) ui.activeId = ts.length ? ts[ts.length - 1].id : null;
  ui.unreadChats.delete(ui.activeId);
  for (const id of [...ui.unreadChats]) if (!ui.chatNo.has(id)) ui.unreadChats.delete(id);
  return ts;
}

/* ---- chats and cards */

const chatQuestions = (chatId) => ui.chatById?.get(chatId)?.questions || (state.nodes[chatId] ? [state.nodes[chatId]] : []);
// every card of a chat in display order (a follow-up card sits right after its source)
const chatCards = (chatId) => chatQuestions(chatId).flatMap((q) => cardsOrdered(state, q.id));

// Strip order is client side only: display order, except that a synthesized card opens beside its source.
function orderedCards(chatId) {
  const cards = chatCards(chatId);
  const byId = new Map(cards.map((c) => [c.id, c]));
  let ord = ui.order.get(chatId);
  if (!ord) { ord = []; ui.order.set(chatId, ord); }
  if (ord.some((id) => !byId.has(id))) { ord = ord.filter((id) => byId.has(id)); ui.order.set(chatId, ord); }
  const known = new Set(ord);
  for (const c of cards) {
    if (known.has(c.id)) continue;
    let i = ui.insertAfter.has(c.id) ? ord.indexOf(ui.insertAfter.get(c.id)) : -1;
    if (i < 0 && c.origin?.cardId) {
      i = ord.indexOf(c.origin.cardId);
      while (i >= 0 && i + 1 < ord.length && byId.get(ord[i + 1])?.origin?.cardId === c.origin.cardId) i++;
    }
    if (i >= 0) ord.splice(i + 1, 0, c.id); else ord.push(c.id);
    known.add(c.id);
    ui.insertAfter.delete(c.id);
  }
  return ord.map((id) => byId.get(id));
}

function moveInOrder(chatId, id, afterId) {
  const ord = ui.order.get(chatId);
  if (!ord) return;
  const i = ord.indexOf(id);
  if (i < 0) return;
  ord.splice(i, 1);
  const j = ord.indexOf(afterId);
  if (j >= 0) ord.splice(j + 1, 0, id); else ord.push(id);
}

const currentOf = (chatId) => ui.current.get(chatId) || null;

function createChat(id) {
  const v = { id, shown: false, view: null, lastHand: 0, ids: '', bw: 0 };
  v.row = h('div', { class: 'row' });
  v.sizer = h('div', { class: 'flow-sizer', 'aria-hidden': 'true' });
  v.row.addEventListener('scroll', () => {
    if (v.row.offsetParent) ui.scrollX.set(id, v.row.scrollLeft);
    if (id === ui.activeId) scheduleOverview();
  }, { passive: true });
  const hand = () => {
    v.lastHand = Date.now();
    const g = v.row._glide; // a wheel or drag takes over from a running Focus glide
    if (g && g.raf) { cancelAnimationFrame(g.raf); g.raf = 0; }
  };
  installCanvas(v.row, { onManual: hand });
  v.row._settle = () => {
    // after a wheel or drag in Focus, land on the nearest card
    if (!isFocusOn() || id !== ui.activeId) return;
    const mid = v.row.scrollLeft + v.row.clientWidth / 2;
    let best = null, bd = 1e9;
    for (const c of orderedCards(id)) {
      const el = cardViews.get(c.id)?.el;
      if (!el) continue;
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (d < bd) { bd = d; best = c.id; }
    }
    if (best) setCurrent(best);
  };
  v.row.addEventListener('wheel', hand, { passive: true });
  v.row.addEventListener('touchmove', hand, { passive: true });
  v.row.addEventListener('pointerdown', (e) => { if (e.target === v.row) hand(); });
  v.ghostStatus = h('div', { class: 'ghost-status' });
  v.ghost = h('div', { class: 'ghosts', hidden: true, 'aria-hidden': 'true' }, h('div', { class: 'ghost-card' }), h('div', { class: 'ghost-card short' }), v.ghostStatus);
  v.errMsg = h('span', { class: 'qe-msg' });
  v.errSettings = h('button', { class: 'btn small bordered', type: 'button', text: 'Open settings', onclick: () => openModel() });
  v.errRetry = h('button', { class: 'btn small bordered', type: 'button', text: 'Try again' });
  v.err = h('div', { class: 'q-error', hidden: true, role: 'alert' }, icon('alert'), v.errMsg, h('span', { class: 'qe-actions' }, v.errSettings, v.errRetry));
  v.el = h('section', { class: 'chat', 'data-id': id, hidden: true }, v.row, v.ghost, v.err);
  return v;
}

function updateGhosts(cv, planning) {
  const g = cv.ghost;
  if (planning) {
    if (!cv.planStart) cv.planStart = performance.now();
    clearTimeout(g._t);
    g.classList.remove('leaving');
    setHidden(g, false);
    tickGhost(cv);
  } else if (!g.hidden && !g.classList.contains('leaving')) {
    cv.planStart = 0;
    const gb = g.firstElementChild?.getBoundingClientRect();
    if (gb && gb.width > 0) { cv.morphFrom = gb; clearTimeout(cv._mt); cv._mt = setTimeout(() => { cv.morphFrom = null; }, 900); }
    if (reducedMotion.matches) { g.hidden = true; return; }
    g.classList.add('leaving');
    g._t = setTimeout(() => { g.hidden = true; g.classList.remove('leaving'); }, 200);
  }
}
function tickGhost(cv) {
  const sec = Math.floor((performance.now() - cv.planStart) / 1000);
  setText(cv.ghostStatus, sec >= 3 ? 'Planning the answer \u00b7 ' + sec + 's' : 'Planning the answer');
}
setInterval(() => { for (const cv of chatViews.values()) if (cv.planStart && !cv.ghost.hidden) tickGhost(cv); }, 1000);

function cardWidthPx(cardId, boardInner, curId) {
  if (isNarrow()) return Math.max(200, boardInner);
  if (isFocusOn()) { const f = focusLayout(); return cardId === curId ? f.cur : f.side; }
  const gap = 12;
  const { n } = SIZES[sizeIdxOf(cardId)];
  return Math.round(Math.max(260, (boardInner - (n - 1) * gap) / n));
}

// Clear every inline layout property a view set, so another view starts clean.
function resetBox(v) {
  if (v.sq) { v.sq = false; v.el.classList.remove('sq', 'reply-open'); v.linksSig = ''; }
  v.el.style.cssText = '';
  v.w = undefined; v.fl = null;
  v.flAnim?.cancel(); v.flAnim = null;
}

function createQCard(id) {
  const v = { id, q: true, mode: null };
  v.text = h('p', { class: 'q-text' });
  v.inner = h('div', { class: 'q-inner' }, v.text);
  v.el = h('article', { class: 'card qcard', 'data-id': id, 'aria-label': 'Question' }, v.inner);
  return v;
}

let staggerN = 0;

function renderChats(ts) {
  const seenChats = new Set(), seenCards = new Set(), seenQ = new Set(), chatEls = [];
  const view = effView();
  const flow = view === 'flow';
  const strip = view === 'strip';
  const inner = Math.max(200, els.board.clientWidth - 24);
  staggerN = 0;
  for (const chat of ts) {
    seenChats.add(chat.id);
    let cv = chatViews.get(chat.id);
    if (!cv) { cv = createChat(chat.id); chatViews.set(chat.id, cv); }
    chatEls.push(cv.el);
    const active = chat.id === ui.activeId && !ui.start;
    setHidden(cv.el, !active && !cv.el.classList.contains('leaving'));
    const wasShown = cv.shown;

    const cards = flow ? chatCards(chat.id) : orderedCards(chat.id);
    const lq = chat.questions[chat.questions.length - 1];
    const planning = !!lq && lq.status === 'streaming' && cardsOrdered(state, lq.id).length === 0;
    updateGhosts(cv, planning && active);
    const errText = lq && lq.status === 'error' ? (lq.error || 'The answer could not be written.')
      : lq && lq.status === 'cancelled' && cardsOrdered(state, lq.id).length === 0 ? 'Stopped before the first card was written.' : '';
    setHidden(cv.err, !errText);
    if (errText) {
      setText(cv.errMsg, errText);
      setHidden(cv.errSettings, !/key|auth|credential|unauthori|401|403|permission/i.test(errText));
      cv.errRetry.onclick = () => askQuestion(lq.body);
    }
    let cur = currentOf(chat.id);
    if (cards.length && (!cur || !(cards.some((c) => c.id === cur) || ui.insertAfter.has(cur)))) {
      cur = cards[0].id;
      ui.current.set(chat.id, cur);
    }

    const cardEls = [];
    for (const c of cards) {
      seenCards.add(c.id);
      let v = cardViews.get(c.id);
      if (!v) { v = createCard(c.id); cardViews.set(c.id, v); v.fresh = active && ui.live; }
      if (v.mode !== view) { resetBox(v); v.mode = view; }
      cardEls.push(v.el);
      if (strip) {
        if (isFocusOn()) cv.row.style.setProperty('--focus-pad', focusLayout().pad + 'px');
        const w = cardWidthPx(c.id, inner, cur);
        if (v.w !== w) { v.w = w; v.el.style.width = w + 'px'; }
      }
      updateCard(v, c, cur, flow);
    }

    if (flow) {
      const items = [];
      for (const q of chat.questions) {
        seenQ.add(q.id);
        let qv = qViews.get(q.id);
        if (!qv) { qv = createQCard(q.id); qViews.set(q.id, qv); qv.fresh = active && ui.live; }
        if (qv.mode !== view) { resetBox(qv); qv.mode = view; }
        setText(qv.text, q.body || '');
        items.push({ kind: 'q', id: q.id, v: qv });
        for (const c of cardsOrdered(state, q.id)) items.push({ kind: 'card', id: c.id, v: cardViews.get(c.id), node: c, source: c.origin?.cardId || null });
      }
      reconcile(cv.row, [cv.sizer, ...items.map((it) => it.v.el)]);
      if (active) layoutFlow(cv, items, wasShown);
    } else {
      reconcile(cv.row, cardEls);
      if (view === 'fit') {
        // never narrower than 280px; one row, else two equal rows, else scroll sideways
        const n = Math.max(1, cards.length);
        const cap = Math.max(1, Math.floor((inner + 12) / 292));
        const rows = n <= cap ? 1 : n <= 2 * cap ? 2 : 1;
        const cols = rows === 2 ? Math.ceil(n / 2) : n;
        cv.row.style.setProperty('--cols', cols);
        cv.row.style.setProperty('--rows', rows);
      }
      if (active) flipRow(cv, cards, view, wasShown);
      let morph = cv.morphFrom;
      for (const c of cards) { const v = cardViews.get(c.id); if (v.fresh && active) { playFresh(v, null, false, morph); if (morph) { morph = null; cv.morphFrom = null; } } }
    }

    // opening a chat (or entering a scrolling view) restores its last scroll position
    if (active && view !== 'fit' && (!cv.shown || cv.view !== view)) cv.row.scrollLeft = ui.scrollX.get(chat.id) || 0;
    cv.shown = active;
    cv.view = view;
    cv.bw = ui.boardW;
    if (active) refreshEdges(cv.row);
  }
  reconcile(els.chats, chatEls);
  for (const id of cardViews.keys()) if (!seenCards.has(id)) { cardViews.delete(id); ui.selected.delete(id); }
  for (const id of qViews.keys()) if (!seenQ.has(id) && flow) qViews.delete(id);
  for (const id of chatViews.keys()) if (!seenChats.has(id)) chatViews.delete(id);

  // chat switch: outgoing fades, incoming rises
  const shownNow = ui.start ? null : ui.activeId;
  if (ui.shownChat !== shownNow) {
    const prev = chatViews.get(ui.shownChat), next = chatViews.get(shownNow);
    if (!reducedMotion.matches) {
      if (prev && prev.el.hidden) {
        prev.el.hidden = false; prev.el.classList.add('leaving');
        const a = prev.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'ease-out' });
        a.onfinish = a.oncancel = () => { prev.el.classList.remove('leaving'); if (prev.id !== ui.activeId || ui.start) prev.el.hidden = true; };
      }
      if (prev && next) next.el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 160, delay: 70, easing: EASE, fill: 'backwards' });
    }
    ui.shownChat = shownNow;
  }

  if (ui.scrollTo && cardViews.has(ui.scrollTo)) {
    const id = ui.scrollTo;
    ui.scrollTo = null;
    const chat = nodeChat(id);
    if (chat === ui.activeId) scrollCardIntoView(chat, id);
    cardViews.get(id).el.focus({ preventScroll: true });
    if (ui.pulseId === id) { ui.pulseId = null; anim(cardViews.get(id).el, [{ boxShadow: '0 0 0 0 var(--ring)' }, { boxShadow: '0 0 0 8px transparent' }], { duration: 700 }); }
  }
}

/* ---- animation helpers (Web Animations; all disabled under reduced motion) */

const EASE = 'cubic-bezier(.2,.8,.2,1)';
function anim(el, frames, opts) {
  if (reducedMotion.matches || !el.animate) return null;
  return el.animate(frames, { easing: EASE, ...opts });
}

// A card or question card appears: fade + rise, staggered; a follow-up card emerges from its source.
const lightTheme = matchMedia('(prefers-color-scheme: light)');
function playFresh(v, base, branch, morphFrom) {
  v.fresh = false;
  const delay = Math.min(staggerN++, 8) * 45;
  const b = base ? base + ' ' : '';
  const el = v.el;
  el.style.willChange = 'transform, opacity, filter';
  const done = () => { el.style.willChange = ''; el.style.transformOrigin = ''; };
  const bloom = lightTheme.matches ? [{ boxShadow: '0 14px 36px rgba(20, 20, 15, .16)' }, { boxShadow: '0 1px 2px rgba(20, 20, 15, .05)' }] : [{}, {}];
  let a;
  if (morphFrom && !branch && !reducedMotion.matches) {
    // the first real card grows out of the first ghost card's box
    const own = el.getBoundingClientRect();
    if (own.width > 0 && own.height > 0) {
      const dx = morphFrom.left - own.left, dy = morphFrom.top - own.top, sx = morphFrom.width / own.width, sy = morphFrom.height / own.height;
      el.style.transformOrigin = 'left top';
      a = anim(el, [
        { opacity: 0.4, transform: b + `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { opacity: 1, transform: b + 'translate(0px, 0px) scale(1, 1)' },
      ], { duration: 460, easing: SPRING_SOFT, fill: 'backwards' });
    }
  }
  if (a) { /* morphing */ } else if (branch) {
    el.style.transformOrigin = 'left center';
    a = anim(el, [
      { opacity: 0, transform: b + 'translateX(-28px) scale(.96)', filter: 'blur(5px)', ...bloom[0] },
      { opacity: 1, transform: b + 'translateX(0px) scale(1)', filter: 'blur(0px)', ...bloom[1] },
    ], { duration: 420, delay, easing: SPRING, fill: 'backwards' });
  } else {
    a = anim(el, [
      { opacity: 0, transform: b + 'translateY(12px) scale(.98)', filter: 'blur(6px)', ...bloom[0] },
      { opacity: 1, transform: b + 'translateY(0px) scale(1)', filter: 'blur(0px)', ...bloom[1] },
    ], { duration: 420, delay, easing: SPRING, fill: 'backwards' });
  }
  if (a) a.onfinish = a.oncancel = done; else done();
}

// FLIP for the flex rows (Fit, Strip): cards that moved or resized glide to their new place.
function flipRow(cv, cards, view, wasShown) {
  const ids = cards.map((c) => c.id).join('|');
  const wsig = cards.map((c) => cardViews.get(c.id)?.w || 0).join(',');
  const changed = ids !== cv.ids || wsig !== cv.wsig;
  const boardSame = cv.bw === ui.boardW && cv.view === view && wasShown;
  if (!changed && boardSame && cv.rects) return;
  const row = cv.row;
  const rects = new Map();
  const rr = row.getBoundingClientRect();
  for (const c of cards) {
    const r = cardViews.get(c.id).el.getBoundingClientRect();
    rects.set(c.id, { x: r.left - rr.left + row.scrollLeft, y: r.top - rr.top, w: r.width, h: r.height });
  }
  if (changed && boardSame && cv.rects && !reducedMotion.matches) {
    for (const c of cards) {
      const o = cv.rects.get(c.id), n = rects.get(c.id), v = cardViews.get(c.id);
      if (!o || !n || v.fresh) continue;
      const dx = o.x - n.x, dy = o.y - n.y;
      const grow = n.w > o.w + 1 || n.h > o.h + 1;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !grow) continue;
      const clip = (a) => `inset(0 ${a ? Math.max(0, n.w - o.w) : 0}px ${a ? Math.max(0, n.h - o.h) : 0}px 0 round 12px)`;
      anim(v.el, [
        { transform: `translate(${dx}px, ${dy}px)`, clipPath: grow ? clip(true) : 'inset(0 0 0 0 round 12px)' },
        { transform: 'translate(0px, 0px)', clipPath: clip(false) },
      ], { duration: MOVE_MS, easing: SPRING_SOFT });
    }
  }
  cv.rects = rects; cv.ids = ids; cv.wsig = wsig;
}

/* ---- Flow layout: cards sized by how much they say, packed into columns */

const FLOW = { gap: 12, padX: 16, padY: 12, widths: [260, 340, 440, 560], charMax: [200, 600, 1300], indent: 24, famMin: 120 };

function textSize(v, c) {
  let len = (c.body || '').length;
  let thread = false;
  for (const m of threadOf(state, c.id)) {
    if (m.answeredBy) continue; // shown as a one-line chip
    thread = true;
    len += (m.body || '').length;
  }
  const table = TABLE_RE.test(c.body || '');
  const code = /```/.test(c.body || '');
  return { len, table, code, thread };
}

function tierFor(sz) {
  if (sz.table) return 3;
  let t = sz.len <= FLOW.charMax[0] && !sz.code ? 0 : sz.len <= FLOW.charMax[1] ? 1 : sz.len <= FLOW.charMax[2] ? 2 : 3;
  if ((sz.code || sz.thread) && t < 1) t = 1; // a thread reply ends the square
  return t;
}

function naturalHeight(v) {
  const vis = (el) => (el.hidden ? 0 : el.offsetHeight);
  return v.head.offsetHeight + vis(v.stale) + (v.stale.hidden ? 0 : 8) + vis(v.origin) + vis(v.ask) + (v.ask.hidden ? 0 : 8) + v.content.offsetHeight + 22 + v.composer.offsetHeight + 2;
}

function tierBounds(t, H) {
  if (t === 0) return [Math.min(260, H), Math.min(260, H)];
  if (t === 1) return [Math.min(260, H), Math.max(Math.min(260, H), Math.round(H * 0.7))];
  if (t === 2) return [Math.min(320, H), H];
  return [H, H];
}

function layoutFlow(cv, items, wasShown) {
  const row = cv.row;
  const narrow = isNarrow();
  const { gap, padX, padY } = FLOW;
  const H = Math.max(200, row.clientHeight - 2 * padY);
  const inner = Math.max(200, els.board.clientWidth - 2 * padX);
  const boardKey = ui.boardW + 'x' + row.clientHeight;
  const sameBoard = cv.flowBoard === boardKey && wasShown && cv.view === 'flow';
  cv.flowBoard = boardKey;

  let relayout = false;
  const cards = items.filter((it) => it.kind === 'card');
  // 0. families: a follow-up card nests under the card it was asked from, so a
  // card and everything asked from it read as one group (a sub-card tree)
  const depthOf = new Map(), rootOf = new Map(), kids = new Set();
  for (const it of cards) {
    const src = it.source && depthOf.has(it.source) ? it.source : null;
    const d = src ? depthOf.get(src) + 1 : 0;
    depthOf.set(it.id, d);
    it.root = src ? rootOf.get(src) : it.id;
    rootOf.set(it.id, it.root);
    it.depth = narrow ? 0 : Math.min(3, d);
    if (src) kids.add(it.root);
  }
  const curId = currentOf(cv.id);
  const fams = new Map(), famOpen = new Map();
  for (const it of cards) {
    it.family = !narrow && kids.has(it.root);
    if (!it.family) { setClass(it.v.el, 'fam-compact', false); continue; }
    if (!fams.has(it.root)) fams.set(it.root, []);
    fams.get(it.root).push(it);
    if (it.id === curId || !famOpen.has(it.root)) famOpen.set(it.root, it.id);
  }
  for (const it of cards) if (it.family) setClass(it.v.el, 'fam-compact', famOpen.get(it.root) !== it.id);

  // 1. tiers from text, then widths (writes)
  for (const it of cards) {
    if (it.v.sqMode !== ui.square) { it.v.sqMode = ui.square; it.v.needTier = 0; it.v.tier = undefined; }
    const sz = textSize(it.v, it.node);
    const t = tierFor(sz);
    it.v.tier = it.node.status === 'streaming' ? Math.max(it.v.tier ?? 0, t) : Math.max(t, it.v.needTier ?? 0);
    // a short card is exactly a 260 square and is never promoted for height
    it.short = ui.square && !narrow && it.v.tier === 0 && !it.family;
    if (it.v.sq !== it.short) { it.v.sq = it.short; it.v.linksSig = ''; relayout = true; }
    setClass(it.v.el, 'sq', it.short);
    it.v.sizeSig = '';
  }
  const widthOf = (t) => (narrow ? Math.min(inner, 560) : FLOW.widths[t]);
  // a family shares one column width: wide enough for its widest member at its indent
  const famW = new Map();
  const sizeFamilies = () => {
    famW.clear();
    for (const it of cards) if (it.family) famW.set(it.root, Math.max(famW.get(it.root) || 0, FLOW.widths[it.v.tier] + FLOW.indent * it.depth));
  };
  const wOf = (it) => (it.family ? Math.min(famW.get(it.root), FLOW.widths[3] + FLOW.indent) - FLOW.indent * it.depth : widthOf(it.v.tier));
  sizeFamilies();
  for (const it of cards) it.v.el.style.width = wOf(it) + 'px';
  for (const it of items) if (it.kind === 'q') it.v.el.style.width = (narrow ? Math.min(inner, 560) : 260) + 'px';

  // 2. natural heights (reads); promote a tier when the content would still scroll
  for (let pass = 0; pass < 3; pass++) {
    let promoted = false;
    for (const it of cards) {
      if (it.short) { it.nat = 0; continue; }
      it.nat = naturalHeight(it.v);
      const [, hi] = tierBounds(it.v.tier, H);
      const compact = it.family && famOpen.get(it.root) !== it.id; // clipped on purpose, never widened for height
      if (it.v.tier < 3 && it.nat > hi + 1 && !narrow && !compact) {
        it.v.tier++; it.v.needTier = it.v.tier; promoted = true;
        it.v.el.style.width = widthOf(it.v.tier) + 'px';
      }
    }
    if (!promoted) break;
    sizeFamilies();
    for (const it of cards) if (it.family) it.v.el.style.width = wOf(it) + 'px';
  }
  for (const it of items) {
    if (it.kind === 'q') {
      it.w = narrow ? Math.min(inner, 560) : 260;
      it.h = Math.round(Math.min(Math.max(it.v.inner.offsetHeight + 2, 64), Math.round(H * 0.5)));
    } else {
      it.w = wOf(it);
      const [lo, hi] = tierBounds(it.v.tier, H);
      // in a family every card is as tall as its content, so the tree stays compact
      it.h = it.v.tier === 0 ? lo : Math.round(Math.min(Math.max(it.nat, lo), hi));
    }
  }
  // family heights: the open card (current, else the root) takes up to 60% of
  // the board; the others are compact sub-cards sharing what is left
  for (const list of fams.values()) {
    const open = list.find((it) => it.id === famOpen.get(list[0].root));
    const rest = list.filter((it) => it !== open);
    // leave room for the compact ones when that still keeps the open card readable
    const cap = Math.max(H * 0.35, Math.min(H * 0.6, H - rest.length * (FLOW.famMin + gap)));
    open.h = Math.round(Math.min(Math.max(open.nat, Math.min(FLOW.famMin, H)), cap));
    const per = Math.max(Math.min(FLOW.famMin, H), Math.floor((H - open.h - gap * rest.length) / Math.max(1, rest.length)));
    for (const it of rest) it.h = Math.round(Math.min(Math.max(it.nat, 72), per));
  }

  // 3. assign columns
  const cols = [];
  let cur = null;
  for (const it of items) {
    // a family starts its own column and keeps it (spilling into the next one
    // when it is taller than the board); loose cards still pack together
    const famStart = it.kind === 'card' && it.depth === 0 && (it.family || !!cur?.family);
    const startNew = narrow || it.kind === 'q' || !cur || famStart
      || (!it.family && it.source && cur.items.some((x) => x.id === it.source))
      || cur.used + gap + it.h > H;
    if (startNew) { cur = { items: [], used: 0, w: 0, x: 0, family: it.family ? it.root : null }; cols.push(cur); }
    it.off = it.family ? FLOW.indent * it.depth : 0;
    it.y = cur.items.length ? cur.used + gap : 0;
    cur.used = it.y + it.h;
    cur.items.push(it);
    cur.w = Math.max(cur.w, it.w + it.off);
    it.col = cols.length - 1;
  }
  let x = padX;
  for (const col of cols) { col.x = x; x += col.w + gap; }
  const totalW = Math.max(x - gap + padX, 0);
  cv.sizer.style.width = totalW + 'px';

  // 4. apply, with FLIP for anything that moved or changed tier
  const placed = new Map();
  let lastFresh = null;
  const freshIds = new Set(items.filter((it) => it.v.fresh).map((it) => it.id));
  for (const it of items) {
    const v = it.v;
    const px = cols[it.col].x + (it.off || 0), py = it.y + padY;
    const n = { x: px, y: py, w: it.w, h: it.h, col: it.col, tier: v.tier ?? -1 };
    placed.set(it.id, n);
    const o = v.fl;
    const T = `translate(${px}px, ${py}px)`;
    v.el.style.height = n.h + 'px';
    v.el.style.width = n.w + 'px';
    v.el.style.transform = T;
    setClass(v.el, 'tier-s', v.tier === 0);
    v.fl = n;
    if (v.fresh) {
      lastFresh = it;
      const src = it.source ? placed.get(it.source) : null;
      const srcV = it.source ? cardViews.get(it.source) : null;
      if (!reducedMotion.matches && src && srcV && wasShown !== false) {
        playFresh(v, T, true);
        anim(srcV.el, [{ boxShadow: '0 0 0 0 var(--ring)' }, { boxShadow: '0 0 0 7px transparent' }], { duration: 700, delay: 120 });
      } else { playFresh(v, T, false, cv.morphFrom); cv.morphFrom = null; }
      continue;
    }
    if (!o || !sameBoard || reducedMotion.matches) continue;
    const moved = Math.abs(o.x - n.x) > 1 || Math.abs(o.y - n.y) > 1;
    const bigMove = o.col !== n.col || o.tier !== n.tier || Math.abs(o.x - n.x) > 1 || Math.abs(o.y - n.y) > 60;
    const sized = o.tier !== n.tier && (Math.abs(o.w - n.w) > 1 || Math.abs(o.h - n.h) > 1);
    if (!(bigMove && (moved || sized))) continue;
    v.flAnim?.cancel();
    const gw = Math.max(0, n.w - o.w), gh = Math.max(0, n.h - o.h);
    const clip0 = sized ? `inset(0 ${gw}px ${gh}px 0 round 12px)` : 'inset(0 0 0 0 round 12px)';
    v.flAnim = anim(v.el, [
      { transform: `translate(${o.x}px, ${o.y}px)`, clipPath: clip0 },
      { transform: T, clipPath: 'inset(0 0 0 0 round 12px)' },
    ], { duration: MOVE_MS, easing: SPRING_SOFT });
  }

  // new items scroll into view, unless the person scrolled by hand a moment ago
  if (lastFresh && wasShown !== false && Date.now() - cv.lastHand > 2000) {
    const n = placed.get(lastFresh.id);
    const L = row.scrollLeft, R = L + row.clientWidth;
    if (n.x < L || n.x + n.w > R) {
      const t = n.w + 2 * padX > row.clientWidth ? n.x - padX : n.x + n.w + padX - row.clientWidth;
      row._autoScrolling = true;
      row.scrollTo({ left: Math.max(0, t), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    }
  }
  if (!wasShown) for (const it of items) it.v.fl = placed.get(it.id);
  // one soft panel behind each family, per column it spans
  const groups = new Map();
  for (const it of cards) {
    if (!it.family) continue;
    const n = placed.get(it.id), col = cols[it.col], k = it.root + '|' + it.col;
    const g = groups.get(k) || { x: col.x, w: col.w, y: n.y, b: n.y + n.h };
    g.y = Math.min(g.y, n.y); g.b = Math.max(g.b, n.y + n.h);
    groups.set(k, g);
  }
  updateFlowLinks(cv, items, placed, totalW, H + 2 * padY, freshIds, sameBoard && !reducedMotion.matches, groups);
  if (relayout) schedule();
}

/* ---- thin connector lines under the cards: every follow-up card to its source, and model-made links on hover */

const SVGNS = 'http://www.w3.org/2000/svg';

function quoteY(srcId, quote) {
  // where the quoted passage sits in the source card (px from the card's top), if it is on screen
  const sv = cardViews.get(srcId);
  if (!quote || !sv) return null;
  const needle = quote.replace(/\s+/g, ' ').slice(0, 28);
  const cardTop = sv.el.getBoundingClientRect().top;
  const box = sv.scroller.getBoundingClientRect();
  const walker = document.createTreeWalker(sv.scroller, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.nodeValue.replace(/\s+/g, ' ').indexOf(needle);
    if (i < 0) continue;
    const r = document.createRange();
    try { r.setStart(n, Math.min(i, n.nodeValue.length)); r.setEnd(n, Math.min(n.nodeValue.length, i + needle.length)); } catch { return null; }
    const rc = r.getBoundingClientRect();
    if (rc.bottom < box.top || rc.top > box.bottom) return null;
    return rc.top + rc.height / 2 - cardTop;
  }
  return null;
}

function linkGeom(a, b, ya) {
  const x1 = a.x + a.w, y1 = a.y + Math.max(14, Math.min(a.h - 14, ya ?? a.h / 2));
  const x2 = b.x, y2 = b.y + Math.min(b.h / 2, 30);
  const k = Math.max(24, Math.abs(x2 - x1) * 0.5);
  return { d: `M ${x1} ${y1} C ${x1 + k} ${y1}, ${x2 - k} ${y2}, ${x2} ${y2}`, x2, y2 };
}

// a follow-up nested under its source: a tree line down the source's left edge, then across
function elbowGeom(a, b) {
  const x0 = a.x + 12, y0 = a.y + a.h, y2 = b.y + 20, x2 = b.x, r = 8;
  return { d: `M ${x0} ${y0} L ${x0} ${y2 - r} Q ${x0} ${y2}, ${x0 + r} ${y2} L ${x2} ${y2}`, x2, y2 };
}

function updateFlowLinks(cv, items, placed, totalW, H, freshIds, animateMoves, groups = new Map()) {
  let svg = cv.linkSvg;
  if (!svg) {
    svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'flow-links');
    svg.setAttribute('aria-hidden', 'true');
    cv.sizer.prepend(svg);
    cv.linkSvg = svg;
    cv.linkMap = new Map();
    cv.row.addEventListener('pointerover', (e) => {
      const id = e.target instanceof Element ? e.target.closest('.card')?.dataset.id || null : null;
      if (cv.hoverId !== id) { cv.hoverId = id; refreshHot(cv); }
    });
    cv.row.addEventListener('pointerleave', () => { cv.hoverId = null; refreshHot(cv); });
  }
  svg.setAttribute('width', Math.max(1, totalW));
  svg.setAttribute('height', Math.max(1, H));

  if (!cv.famMap) cv.famMap = new Map();
  for (const [k, g] of groups) {
    let r = cv.famMap.get(k);
    if (!r) {
      r = document.createElementNS(SVGNS, 'rect');
      r.setAttribute('class', 'flow-family');
      r.setAttribute('rx', '16');
      svg.prepend(r);
      cv.famMap.set(k, r);
    }
    const p = 5;
    r.style.x = (g.x - p) + 'px'; r.style.y = (g.y - p) + 'px';
    r.style.width = (g.w + 2 * p) + 'px'; r.style.height = (g.b - g.y + 2 * p) + 'px';
  }
  for (const [k, r] of [...cv.famMap]) if (!groups.has(k)) { r.remove(); cv.famMap.delete(k); }

  const wanted = new Map();
  for (const it of items) {
    if (it.kind !== 'card') continue;
    const o = it.node.origin;
    if (o?.cardId && placed.has(o.cardId)) wanted.set('o:' + it.id, { from: o.cardId, to: it.id, kind: 'origin', quote: o.quote });
  }
  for (const e of state.edges) {
    if (!placed.has(e.from) || !placed.has(e.to)) continue;
    const a = state.nodes[e.from], b = state.nodes[e.to];
    if (a?.origin?.cardId === e.to || b?.origin?.cardId === e.from) continue; // already drawn as an origin link
    wanted.set('e:' + e.id, { from: e.from, to: e.to, kind: 'edge' });
  }

  for (const [key, w] of wanted) {
    let a = placed.get(w.from), b = placed.get(w.to), from = w.from, to = w.to;
    if (w.kind === 'edge' && a.x > b.x) { [a, b] = [b, a]; [from, to] = [to, from]; }
    let rec = cv.linkMap.get(key);
    if (!rec) {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'flow-link ' + w.kind);
      const dot = document.createElementNS(SVGNS, 'circle');
      dot.setAttribute('class', 'flow-dot ' + w.kind);
      dot.setAttribute('r', '1.5');
      svg.append(path, dot);
      rec = { path, dot, from, to, kind: w.kind, d: '', qy: w.kind === 'origin' ? quoteY(w.from, w.quote) : null, fresh: freshIds.has(w.to) };
      cv.linkMap.set(key, rec);
    }
    rec.from = from; rec.to = to;
    const g = w.kind === 'origin' && a.col === b.col && b.y > a.y && b.x > a.x ? elbowGeom(a, b) : linkGeom(a, b, rec.qy);
    if (g.d !== rec.d) {
      const old = rec.d, oldCx = rec.cx, oldCy = rec.cy;
      rec.d = g.d; rec.cx = g.x2; rec.cy = g.y2;
      rec.path.setAttribute('d', g.d);
      rec.dot.setAttribute('cx', g.x2);
      rec.dot.setAttribute('cy', g.y2);
      if (old && animateMoves) {
        // the line travels with the cards instead of snapping
        rec.path.animate([{ d: `path("${old}")` }, { d: `path("${g.d}")` }], { duration: MOVE_MS, easing: SPRING_SOFT });
        rec.dot.animate([{ cx: oldCx + 'px', cy: oldCy + 'px' }, { cx: g.x2 + 'px', cy: g.y2 + 'px' }], { duration: MOVE_MS, easing: SPRING_SOFT });
      } else if (!old && rec.fresh && w.kind === 'origin' && !reducedMotion.matches) {
        rec.fresh = false;
        rec.path.setAttribute('pathLength', '1');
        rec.path.animate([{ strokeDasharray: '1', strokeDashoffset: '1' }, { strokeDasharray: '1', strokeDashoffset: '0' }], { duration: 420, delay: 160, easing: 'ease-out', fill: 'backwards' });
        rec.dot.animate([{ opacity: 0 }, { opacity: 0, offset: .85 }, { opacity: 1 }], { duration: 580, delay: 160, fill: 'backwards' });
        const trav = h('div', { class: 'flow-trav', 'aria-hidden': 'true' });
        trav.style.offsetPath = `path('${g.d}')`;
        cv.sizer.append(trav);
        const t = trav.animate([{ offsetDistance: '0%', opacity: 1 }, { offsetDistance: '100%', opacity: 1, offset: .95 }, { offsetDistance: '100%', opacity: 0 }], { duration: 480, delay: 160, easing: 'ease-in-out', fill: 'backwards' });
        t.onfinish = t.oncancel = () => trav.remove();
      }
    }
  }
  for (const [key, rec] of [...cv.linkMap]) {
    if (!wanted.has(key)) { rec.path.remove(); rec.dot.remove(); cv.linkMap.delete(key); }
  }
  refreshHot(cv);
}

// a line brightens while either of its cards is hovered or current
function refreshHot(cv) {
  if (!cv.linkMap) return;
  const cur = currentOf(cv.id);
  for (const rec of cv.linkMap.values()) {
    const hot = [cv.hoverId, cur].some((id) => id && (id === rec.from || id === rec.to));
    rec.path.classList.toggle('hot', hot);
    rec.dot.classList.toggle('hot', hot);
  }
}

// Focus: glide the strip to `left` ourselves. A native smooth scroll inside a
// mandatory snap container starts late and restarts on every key press, so
// held or repeated arrow keys seemed to do nothing. Snapping is suspended for
// the glide and resumes on the exact snap position. A new call retargets the
// glide that is running.
function glideTo(row, left, exact = false) {
  const g = row._glide || (row._glide = { raf: 0, to: 0, from: 0, t0: 0 });
  const max = exact ? Infinity : Math.max(0, row.scrollWidth - row.clientWidth);
  g.to = Math.max(0, Math.min(max, left));
  if (reducedMotion.matches) { cancelAnimationFrame(g.raf); g.raf = 0; row.classList.remove('scrolling-free'); row.scrollLeft = g.to; return; }
  if (!g.raf && Math.abs(g.to - row.scrollLeft) < 1) return;
  g.from = row.scrollLeft;
  g.t0 = performance.now();
  row.classList.add('scrolling-free');
  if (g.raf) return;
  const DUR = 240;
  const step = (now) => {
    const k = Math.min(1, (now - g.t0) / DUR);
    const e = 1 - Math.pow(1 - k, 3);
    row.scrollLeft = g.from + (g.to - g.from) * e;
    if (k < 1) { g.raf = requestAnimationFrame(step); return; }
    g.raf = 0;
    row.scrollLeft = g.to;
    row.classList.remove('scrolling-free');
  };
  g.raf = requestAnimationFrame(step);
}

// Bring a whole card into view with the least movement; leave the strip alone if it already is.
function scrollCardIntoView(chatId, cardId) {
  const view = effView();
  if (view === 'fit') return;
  const cv = chatViews.get(chatId), v = cardViews.get(cardId);
  if (!cv || !v || !v.el.offsetParent) return;
  const row = cv.row, pad = 12;
  const flow = view === 'flow' && v.fl;
  const l = flow ? v.fl.x : v.el.offsetLeft;
  const wd = flow ? v.fl.w : v.el.offsetWidth;
  const r = l + wd;
  const L = row.scrollLeft, R = L + row.clientWidth;
  if (view === 'strip' && isFocusOn()) {
    // Widths follow the current card, and they may not have been applied (or
    // may still be easing), so place it from the layout rather than offsets:
    // every card before it is a side card.
    const f = focusLayout();
    let n = 0;
    for (let e = v.el.previousElementSibling; e; e = e.previousElementSibling) if (e.classList.contains('card')) n++;
    glideTo(row, n * (f.side + FOCUS_GAP), true);
    return;
  }
  if (l >= L - 0.5 && r <= R + 0.5) return;
  let t;
  if (wd + 2 * pad > row.clientWidth || l < L) t = l - pad;
  else t = r + pad - row.clientWidth;
  row._autoScrolling = true;
  row.scrollTo({ left: Math.max(0, t), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// The current card: the one keys act on. Changing it is always the person's action.
function setCurrent(id, { scroll = true } = {}) {
  const chat = nodeChat(id);
  if (!chat) return;
  if (ui.current.get(chat) !== id) { ui.current.set(chat, id); schedule(); }
  // A clicked card keeps DOM focus. Move that focus with the current card: a
  // snap container prefers the focused card as its snap target, which would
  // otherwise pin the strip to the card that was clicked.
  const a = document.activeElement;
  if (scroll && a instanceof HTMLElement && a.classList.contains('card') && a.dataset.id !== id) {
    const el = cardViews.get(id)?.el;
    if (el && el.offsetParent) el.focus({ preventScroll: true }); else a.blur();
  }
  if (scroll && chat === ui.activeId) { scrollCardIntoView(chat, id); scheduleOverview(); }
}

function cycleWidth(id) {
  ui.cardW.set(id, SIZES[(sizeIdxOf(id) + 1) % SIZES.length].id);
  schedule();
  requestAnimationFrame(() => setCurrent(id));
}

/* ---- overview bar (Strip view): one tab per card in strip order */

let ovRaf = 0;
function scheduleOverview() {
  if (!ovRaf) ovRaf = requestAnimationFrame(() => { ovRaf = 0; updateOverview(); });
}

function renderOverview(cards) {
  const strip = effView() === 'strip';
  setHidden(els.overview, !strip || cards.length === 0);
  if (!strip) return;
  const list = [];
  const seen = new Set();
  for (const c of cards) {
    seen.add(c.id);
    let v = ovViews.get(c.id);
    if (!v) {
      v = { dot: h('span', { class: 'dot' }), t: h('span', { class: 'ov-title' }) };
      v.el = h('button', { class: 'ov-tab', type: 'button', onclick: () => setCurrent(c.id) }, v.dot, v.t);
      ovViews.set(c.id, v);
    }
    setText(v.t, c.title || 'Untitled card');
    const tip = c.summary || c.title || '';
    if (v.el.title !== tip) v.el.title = tip;
    if (v.dot._st !== c.status) { v.dot._st = c.status; v.dot.className = 'dot st-' + c.status; }
    list.push(v.el);
  }
  reconcile(els.overview, list);
  for (const id of ovViews.keys()) if (!cardViews.has(id) && !seen.has(id)) ovViews.delete(id);
  updateOverview();
}

// Cheap: only toggles classes, so it can follow a hand scroll frame by frame.
function updateOverview() {
  if (effView() !== 'strip') return;
  const cv = chatViews.get(ui.activeId);
  if (!cv) return;
  const L = cv.row.scrollLeft, R = L + cv.row.clientWidth;
  const cur = currentOf(ui.activeId);
  for (const [id, ov] of ovViews) {
    const c = cardViews.get(id);
    if (!c || !c.el.offsetParent) continue;
    const l = c.el.offsetLeft, r = l + c.el.offsetWidth;
    setClass(ov.el, 'vis', r > L + 1 && l < R - 1);
    setClass(ov.el, 'cur', id === cur);
  }
  const t = ovViews.get(cur)?.el;
  if (t && els.overview._cur !== cur) {
    els.overview._cur = cur;
    const s = els.overview;
    if (t.offsetLeft < s.scrollLeft) s.scrollLeft = t.offsetLeft - 8;
    else if (t.offsetLeft + t.offsetWidth > s.scrollLeft + s.clientWidth) s.scrollLeft = t.offsetLeft + t.offsetWidth - s.clientWidth + 8;
  }
}

function createCard(id) {
  const v = { id, sending: false, scrollToMsg: null };

  v.check = h('input', { type: 'checkbox', class: 'sel', 'aria-label': 'Select this card', onchange: () => toggleSelect(id, v.check.checked) });
  v.checkWrap = h('label', { class: 'qbtn chk', title: 'Select card (x)' }, v.check);
  v.title = h('h3', { class: 'title' });
  v.status = h('span', { class: 'status', hidden: true });
  v.stop = h('button', { class: 'qbtn keep', type: 'button', title: 'Stop writing', 'aria-label': 'Stop writing', onclick: () => cancelNode(id) }, icon('stop'));
  v.ctxBtn = h('button', { class: 'qbtn', type: 'button', title: 'What this thread sees', 'aria-label': 'Context', 'aria-expanded': 'false', onclick: () => toggleContext(v) }, icon('info'));
  v.copyBtn = h('button', { class: 'qbtn', type: 'button', title: 'Copy as Markdown (y y)', 'aria-label': 'Copy card as Markdown', onclick: async () => { if (await copyText(cardMarkdown(id))) { v.copyBtn.classList.add('done'); setTimeout(() => v.copyBtn.classList.remove('done'), 1200); } } }, icon('copy'), icon('check', 'ok'));
  v.wBtn = h('button', { class: 'qbtn w-btn', type: 'button', title: 'Card width: click to cycle (r)', onclick: () => cycleWidth(id) });
  v.head = h('header', { class: 'card-head' }, v.title, v.status, h('span', { class: 'head-actions' }, v.stop, v.copyBtn, v.wBtn, v.ctxBtn, v.checkWrap));

  v.staleText = h('button', { class: 'stale-link', type: 'button', title: 'Show decisions', onclick: () => { ui.drawer = { kind: 'decisions' }; schedule(); } });
  v.refresh = h('button', { class: 'btn small bordered', type: 'button', text: 'Refresh', onclick: () => refreshCard(id) });
  v.stale = h('div', { class: 'stale-line', hidden: true }, v.staleText, v.refresh);

  v.originT = h('span', { class: 'origin-t' });
  v.originBtn = h('button', { class: 'origin', type: 'button', title: 'Show the card this came from', onclick: () => { if (v.originId) revealCard(v.originId, { pulse: true }); } }, icon('branch'), v.originT);
  v.origin = h('div', { class: 'origin-row', hidden: true }, v.originBtn);
  v.askQuote = h('blockquote', { class: 'ask-quote', hidden: true });
  v.askText = h('span', { class: 'ask-text' });
  v.ask = h('div', { class: 'ask-bubble', hidden: true }, v.askQuote, v.askText);

  v.ctxBody = h('div', { class: 'ctx-body' });
  v.ctx = h('section', { class: 'ctx', hidden: true, 'aria-label': 'Context sent to this thread' }, v.ctxBody);

  v.errMsg = h('span', { class: 'ce-msg' });
  v.error = h('div', { class: 'card-error', hidden: true, role: 'alert' }, icon('alert'), v.errMsg, h('button', { class: 'btn small bordered', type: 'button', text: 'Try again', onclick: () => refreshCard(id) }));
  v.skel = h('div', { class: 'skeleton', hidden: true, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  v.body = h('div', { class: 'md body', 'data-askable': '' });
  v.links = h('div', { class: 'links' });
  v.thread = h('div', { class: 'thread' });
  v.content = h('div', { class: 'card-content' }, v.ctx, v.error, v.skel, v.body, v.links, v.thread);
  v.scroller = h('div', { class: 'card-scroll' }, v.content);

  v.quoteText = h('span', { class: 'quote-text' });
  v.quote = h('div', { class: 'quote-chip', hidden: true }, v.quoteText,
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove quote', onclick: () => { ui.quotes.delete(id); updateQuote(v); v.input.focus(); } }, icon('x')));
  v.input = h('textarea', { rows: '1', placeholder: 'Reply to this card', 'aria-label': 'Reply to this card' });
  v.send = h('button', { class: 'send-btn small', type: 'submit', 'aria-label': 'Send reply' }, icon('arrowUp'));
  v.err = h('div', { class: 'field-err', hidden: true });
  v.newChip = h('span', { class: 'mode-chip', hidden: true, text: 'New card' });
  v.composer = h('form', { class: 'composer', autocomplete: 'off' }, v.quote, v.newChip, h('div', { class: 'reply-row' }, v.input, v.send), v.err);

  v.input.addEventListener('input', () => { autosize(v.input); syncSend(v.input, v.send); setClass(v.composer, 'keep', v.input.value.length > 0); setHidden(v.err, true); });
  v.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Flow: Enter lets the model choose; Ctrl/Cmd+Enter forces a new card; Alt+Enter forces this card's thread
      sendReply(v, e.ctrlKey || e.metaKey ? 'branch' : e.altKey ? 'reply' : null);
    }
  });
  v.composer.addEventListener('submit', (e) => { e.preventDefault(); sendReply(v); });

  v.replyBtn = h('button', { class: 'sq-reply', type: 'button', title: 'Reply', 'aria-label': 'Reply in a new card', onclick: () => { const on = v.el.classList.toggle('reply-open'); if (on) v.input.focus({ preventScroll: true }); } }, icon('arrowUp'));
  v.el = h('article', { class: 'card', tabindex: '-1', 'data-id': id, 'aria-label': 'Card' },
    v.origin, v.head, v.ask, v.stale, v.scroller, v.composer, v.replyBtn);

  // Any press inside a card makes it the current one (and brings it fully into view in Strip).
  v.el.addEventListener('pointerdown', () => setCurrent(id));
  v.el.addEventListener('focusin', () => setCurrent(id, { scroll: false }));
  return v;
}

function updateCard(v, c, curId, flow) {
  const st = c.status;
  const o = c.origin;
  if (!c.title && o) { setText(v.title, ''); setClass(v.title, 'skeleton-title', true); }
  else { setClass(v.title, 'skeleton-title', false); setText(v.title, c.title || 'Untitled card'); }
  setHidden(v.origin, !o);
  setHidden(v.ask, !o);
  if (o) {
    v.originId = o.cardId;
    setText(v.originT, titleOf(o.cardId));
    setText(v.askText, o.text || '');
    setText(v.askQuote, plainQuote(o.quote || ''));
    setHidden(v.askQuote, !o.quote);
    const askTip = o.quote ? o.text + '\n\u201c' + o.quote + '\u201d' : (o.text || '');
    if (v.ask.title !== askTip) v.ask.title = askTip;
  }
  const ph = flow ? 'Follow up in this card or a new one' : 'Reply to this card';
  const sendTip = flow ? 'Enter: the model decides · Ctrl+Enter: new card · Alt+Enter: this card' : 'Send';
  if (v.send._tip !== sendTip) { v.send._tip = sendTip; v.send.title = sendTip; }
  if (v.input._ph !== ph) { v.input._ph = ph; v.input.placeholder = ph; v.input.setAttribute('aria-label', ph); }
  const label = { streaming: 'Writing', stale: 'Stale', error: 'Error', cancelled: 'Stopped' }[st];
  setHidden(v.status, !label);
  if (label) setText(v.status, label);
  if (v.status._st !== st) { v.status._st = st; v.status.className = 'status st-' + st; }
  setHidden(v.skel, !(st === 'streaming' && !c.body));
  setClass(v.el, 'streaming', st === 'streaming');
  setClass(v.el, 'is-stale', st === 'stale');
  setClass(v.el, 'hl', (ui.kbd && curId === c.id) || ui.flashId === c.id);
  setClass(v.el, 'linked', ui.linkedId === c.id);
  setText(v.wBtn, isFocusOn() ? 'Focus' : SIZES[sizeIdxOf(c.id)].label);
  setClass(v.el, 'cur', curId === c.id);

  setHidden(v.stop, st !== 'streaming');
  const open = ui.ctxOpen.has(c.id);
  if (v.ctxBtn._on !== open) { v.ctxBtn._on = open; v.ctxBtn.setAttribute('aria-expanded', String(open)); setClass(v.ctxBtn, 'keep', open); setHidden(v.ctx, !open); }
  const sel = ui.selected.has(c.id);
  if (v.check.checked !== sel) v.check.checked = sel;
  setClass(v.checkWrap, 'keep', sel);

  if (st === 'stale') {
    const d = state.decisions.find((x) => x.id === c.staleBecause);
    setText(v.staleText, d ? `Stale because of the decision: “${truncate(d.text, 90)}”` : 'Stale because a pinned decision changed.');
    setHidden(v.stale, false);
  } else setHidden(v.stale, true);

  if (st === 'error') { setText(v.errMsg, c.error || 'Something went wrong while writing this card.'); setHidden(v.error, false); }
  else setHidden(v.error, true);

  setMarkdown(v.body, c.body || '', st === 'streaming');

  updateLinks(v, c);

  const msgs = threadOf(state, c.id);
  const mEls = [];
  for (const m of msgs) {
    let mv = msgViews.get(m.id);
    if (!mv) { mv = createMsg(m.id); msgViews.set(m.id, mv); }
    mEls.push(mv.el);
    updateMsg(mv, m);
  }
  reconcile(v.thread, mEls);
  setHidden(v.thread, msgs.length === 0);
  if (v.scrollToMsg && msgViews.has(v.scrollToMsg)) {
    const target = msgViews.get(v.scrollToMsg).el;
    if (target.offsetParent) {
      v.scroller.scrollTop += target.getBoundingClientRect().top - v.scroller.getBoundingClientRect().top - 8;
      v.scrollToMsg = null;
    }
  }
  updateQuote(v);
}

function updateLinks(v, c) {
  const edges = edgesOf(state, c.id);
  const items = edges.map((e) => {
    const p = edgePhrase(e, c.id);
    const other = state.nodes[p.otherId];
    const cross = !!other && nodeChat(other.id) !== nodeChat(c.id);
    const label = cross
      ? `${p.verb} Chat ${chatNo(nodeChat(other.id))} · ${other.title || 'Untitled card'}`
      : `${p.verb} ${titleOf(p.otherId)}`;
    return { key: e.id, edgeId: e.id, otherId: p.otherId, cross, label };
  });
  const collapse = !!v.sq && items.length > 1;
  const sig = (collapse ? 'c|' : '') + items.map((i) => i.key + ':' + i.label).join('|');
  if (v.linksSig === sig) return;
  v.linksSig = sig;
  const mk = (i) => {
    const b = h('button', { class: 'link-chip' + (i.cross ? ' cross' : ''), type: 'button', title: i.cross ? 'Peek at the linked card in the other chat' : 'Go to that card' }, icon('link'), h('span', { class: 'lc-t', text: i.label }));
    if (!i.cross) {
      b.addEventListener('mouseenter', () => setLinked(i.otherId));
      b.addEventListener('mouseleave', () => setLinked(null));
      b.addEventListener('focus', () => setLinked(i.otherId));
      b.addEventListener('blur', () => setLinked(null));
      b.addEventListener('click', () => revealCard(i.otherId));
    } else {
      b.addEventListener('click', () => openDrawer({ kind: 'peek', edgeId: i.edgeId, cardId: i.otherId }));
    }
    return b;
  };
  if (collapse) {
    const more = h('button', { class: 'link-chip', type: 'button', title: 'Show the links', 'aria-haspopup': 'true' }, icon('link'), h('span', { class: 'lc-t', text: items.length + ' links' }));
    more.addEventListener('click', () => openLinksPop(more, items.map(mk)));
    v.links.replaceChildren(more);
  } else v.links.replaceChildren(...items.map(mk));
  setHidden(v.links, items.length === 0);
}

// Short (square) cards: the links open in a small popover anchored to the chip.
let linksPop = null;
function closeLinksPop() {
  if (!linksPop) return;
  linksPop.remove();
  linksPop = null;
}
function openLinksPop(anchor, chips) {
  const was = linksPop && linksPop._anchor === anchor;
  closeLinksPop();
  if (was) return;
  const pop = h('div', { class: 'popover links-pop', role: 'dialog', 'aria-label': 'Links' }, chips);
  pop._anchor = anchor;
  pop.addEventListener('click', (e) => { if (e.target.closest('.link-chip')) closeLinksPop(); });
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
  const below = r.bottom + 6 + pop.offsetHeight <= window.innerHeight;
  pop.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - pop.offsetHeight - 6)) + 'px';
  linksPop = pop;
}
document.addEventListener('mousedown', (e) => { if (linksPop && !e.target.closest('.links-pop') && !linksPop._anchor.contains(e.target)) closeLinksPop(); });
window.addEventListener('scroll', closeLinksPop, true);

function setLinked(id) {
  if (ui.linkedId === id) return;
  cardViews.get(ui.linkedId)?.el.classList.remove('linked');
  ui.linkedId = id;
  cardViews.get(id)?.el.classList.add('linked');
}

function updateQuote(v) {
  const q = ui.quotes.get(v.id);
  setHidden(v.quote, !q);
  if (q) setText(v.quoteText, '“' + truncate(plainQuote(q), 140) + '”');
}

/* ---- messages */

function createMsg(id) {
  const v = { id, pin: null };
  v.quote = h('blockquote', { class: 'msg-quote', hidden: true });
  v.text = h('div', { class: 'msg-text' });
  v.stop = h('button', { class: 'btn small', type: 'button', text: 'Stop', hidden: true, onclick: () => cancelNode(id) });
  v.pinBtn = h('button', { class: 'btn small', type: 'button', text: 'Pin as decision', hidden: true, onclick: () => openPin(v) });
  v.note = h('span', { class: 'msg-note muted', hidden: true });
  v.actions = h('div', { class: 'msg-actions' }, v.stop, v.pinBtn, v.note);
  v.dots = h('span', { class: 'typing', hidden: true, 'aria-label': 'Thinking' }, h('i'), h('i'), h('i'));
  v.answered = h('button', { class: 'answered-chip', type: 'button', hidden: true, onclick: () => { if (v.answeredBy) revealCard(v.answeredBy, { pulse: true }); } }, icon('branch'), h('span', { class: 'ac-t' }));
  v.el = h('div', { class: 'msg', 'data-id': id }, v.quote, v.text, v.dots, v.answered, v.actions);
  return v;
}

function updateMsg(v, m) {
  const user = m.role === 'user';
  if (v.role !== m.role) {
    v.role = m.role;
    v.el.classList.remove('user', 'assistant');
    v.el.classList.add(user ? 'user' : 'assistant');
    if (user) v.text.removeAttribute('data-askable'); else v.text.setAttribute('data-askable', '');
    v.text.className = user ? 'msg-text plain' : 'msg-text md';
    v.text._src = undefined;
  }
  const ans = user && !!m.answeredBy;
  v.answeredBy = m.answeredBy || null;
  setClass(v.el, 'answered', ans);
  setHidden(v.answered, !ans);
  if (ans) setText(v.answered.lastChild, 'answered in ' + titleOf(m.answeredBy));
  setHidden(v.dots, !(user && m.pending));
  setHidden(v.text, ans);
  if (m.quote && !ans) { setText(v.quote, plainQuote(m.quote)); setHidden(v.quote, false); } else setHidden(v.quote, true);
  if (user) setPlain(v.text, m.body || ''); else setMarkdown(v.text, m.body || (m.status === 'streaming' ? '…' : ''), m.status === 'streaming');

  setClass(v.el, 'streaming', m.status === 'streaming');
  setClass(v.el, 'errored', m.status === 'error');
  setHidden(v.stop, !(m.status === 'streaming' && !user));
  setClass(v.actions, 'keep', m.status === 'streaming' || m.status === 'error');
  setHidden(v.pinBtn, user || m.status === 'streaming' || !m.body);
  if (m.status === 'error') { setText(v.note, m.error || 'Reply failed.'); setHidden(v.note, false); }
  else if (m.status === 'cancelled') { setText(v.note, 'Stopped'); setHidden(v.note, false); }
  else setHidden(v.note, true);
}

function openPin(v) {
  if (v.pin) { v.pin.input.focus(); return; }
  const m = state.nodes[v.id];
  if (!m) return;
  const input = h('input', { type: 'text', value: firstSentence(m.body), 'aria-label': 'Decision text' });
  const err = h('div', { class: 'field-err', hidden: true });
  const close = () => { v.pin.form.remove(); v.pin = null; };
  const form = h('form', { class: 'pin-editor', autocomplete: 'off' },
    h('div', { class: 'pin-row' }, input,
      h('button', { class: 'btn primary small', type: 'submit', text: 'Pin' }),
      h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: close })),
    err);
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); v.pinBtn.focus(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) { err.textContent = 'Write the decision first.'; err.hidden = false; return; }
    err.hidden = true;
    const r = await api('POST', '/api/decisions', { text, sourceNodeId: v.id });
    if (r && v.pin) close();
  });
  input.addEventListener('input', () => { err.hidden = true; });
  v.pin = { form, input };
  v.el.append(form);
  input.focus();
  input.select();
}

/* ---- card actions */

function toggleSelect(id, on) {
  if (on) ui.selected.add(id); else ui.selected.delete(id);
  schedule();
}

function cancelNode(id) { return api('POST', `/api/nodes/${encodeURIComponent(id)}/cancel`); }
function refreshCard(id) { return api('POST', `/api/nodes/${encodeURIComponent(id)}/refresh`); }

// Follow-ups in Flow: the model decides (/followup); Ctrl+Enter forces a new card (/branch); Alt+Enter the thread (/reply).
// An older server without /followup falls back to /branch.
async function sendFollowup(cardId, text, quote, mode) {
  const base = '/api/nodes/' + encodeURIComponent(cardId);
  const body = quote ? { text, quote } : { text };
  let r;
  if (mode === 'branch') r = await pApi('POST', base + '/branch', body);
  else if (mode === 'reply') r = await pApi('POST', base + '/reply', body);
  else {
    if (ui.followupOk !== false) {
      r = await pApi('POST', base + '/followup', body);
      if (!r.ok && r.status === 404 && /no route/i.test(r.error || '')) { ui.followupOk = false; r = null; } else if (r.ok) ui.followupOk = true;
    }
    if (!r) r = await pApi('POST', base + '/branch', body);
  }
  if (!r.ok) notify(r.error || 'Request failed');
  return r;
}

async function sendReply(v, forced) {
  const text = v.input.value.trim();
  if (!text) { v.err.textContent = 'Write a message first.'; setHidden(v.err, false); return; }
  if (v.sending) return;
  v.sending = true; v.send.disabled = true;
  const quote = ui.quotes.get(v.id);
  const body = quote ? { text, quote } : { text };
  const flow = effView() === 'flow';
  let r;
  if (flow) {
    const r0 = await sendFollowup(v.id, text, quote, forced || (v.forceNew ? 'branch' : null));
    r = r0.ok ? r0.data : null;
  } else {
    r = await api('POST', `/api/nodes/${encodeURIComponent(v.id)}/reply`, body);
  }
  v.sending = false; v.send.disabled = false;
  if (r) {
    if (v.input.value.trim() === text) { v.input.value = ''; autosize(v.input); syncSend(v.input, v.send); setClass(v.composer, 'keep', false); }
    ui.quotes.delete(v.id);
    v.forceNew = false;
    setHidden(v.newChip, true);
    v.scrollToMsg = r.userNodeId || null;
    setHidden(v.err, true);
    schedule();
  }
}

function setActive(chatId) {
  if (!chatId || !state.nodes[chatId]) return;
  const wasStart = ui.start;
  ui.start = false;
  ui.overlay = false;
  if (ui.activeId === chatId) { if (wasStart) schedule(); return; }
  ui.activeId = chatId;
  ui.unreadChats.delete(chatId);
  schedule();
}

// Show a card: switch to its chat, make it current and scroll to it (Strip).
function revealCard(id, { pulse = false } = {}) {
  const c = state.nodes[id];
  if (!c) return;
  const chat = nodeChat(id);
  setActive(chat);
  ui.current.set(chat, id);
  ui.scrollTo = id;
  if (pulse) ui.pulseId = id;
  ui.flashId = id;
  clearTimeout(ui._flashT);
  ui._flashT = setTimeout(() => { ui.flashId = null; schedule(); }, 1500);
  schedule();
}

/* ---- context panel */

function toggleContext(v) {
  if (ui.ctxOpen.has(v.id)) ui.ctxOpen.delete(v.id); else ui.ctxOpen.add(v.id);
  schedule();
  if (ui.ctxOpen.has(v.id)) loadContext(v);
}

async function loadContext(v) {
  v.ctxBody.textContent = 'Loading context…';
  const d = await api('GET', `/api/context/${encodeURIComponent(v.id)}`);
  if (!ui.ctxOpen.has(v.id)) return;
  if (!d) { v.ctxBody.textContent = 'Could not load the context.'; return; }
  const sections = Array.isArray(d.sections) ? d.sections : [];
  const total = sections.reduce((a, s) => a + (Number(s.chars) || 0), 0);
  const msgs = Array.isArray(d.messages) ? d.messages : [];
  const msgText = msgs.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 1)}`).join('\n\n——\n\n');
  v.ctxBody.replaceChildren(
    h('div', { class: 'ctx-head' },
      h('strong', { text: 'What this thread sees' }),
      h('span', { class: 'muted', text: `${sections.length} sections, ${formatChars(total)}` }),
      h('button', { class: 'btn small', type: 'button', text: 'Reload', onclick: () => loadContext(v) })),
    h('ul', { class: 'ctx-sections' }, sections.map((s) =>
      h('li', null,
        h('span', { class: 'ctx-name', text: s.name }),
        h('span', { class: 'muted', text: formatChars(s.chars) }),
        s.cached ? h('span', { class: 'chip st-cached', text: 'cached' }) : null))),
    h('details', null, h('summary', { text: 'System text' }), h('pre', { class: 'raw', text: d.system || '' })),
    h('details', null, h('summary', { text: `Messages (${msgs.length})` }), h('pre', { class: 'raw', text: msgText })),
  );
}

/* ---- top bar and chat strip */

const isStart = (ts) => ui.start || ts.length === 0;

function startTransitionBegin(start) {
  // only a change the person caused (New chat, sending from the start screen) plays; loading and replays do not
  if (els.main._wasStart === undefined || !ui.userStart) { els.main._wasStart = start; return null; }
  if (els.main._wasStart === start || reducedMotion.matches) { els.main._wasStart = start; return null; }
  const t = { start, d0: els.dock.getBoundingClientRect(), ghosts: [] };
  if (!start) {
    // leaving the start screen: the heading, tiles and examples fade up and out as copies
    for (const el of [els.empty, els.modePick, els.examples]) {
      if (el.hidden) continue;
      const r = el.getBoundingClientRect();
      const c = el.cloneNode(true);
      c.removeAttribute('id');
      for (const n of c.querySelectorAll('[id]')) n.removeAttribute('id');
      Object.assign(c.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', margin: 0, pointerEvents: 'none', zIndex: 5 });
      t.ghosts.push(c);
    }
  }
  els.main._wasStart = start;
  ui.userStart = false;
  return t;
}
function startTransitionEnd(t) {
  if (!t) return;
  const d1 = els.dock.getBoundingClientRect();
  const dy = t.d0.top - d1.top, dx = t.d0.left - d1.left;
  const sx = d1.width ? t.d0.width / d1.width : 1;
  if (Math.abs(dy) > 1 || Math.abs(dx) > 1 || Math.abs(sx - 1) > 0.01) {
    els.dock.style.transformOrigin = 'top center';
    const a = anim(els.dock, [{ transform: `translate(${dx}px, ${dy}px) scaleX(${sx})` }, { transform: 'none' }], { duration: 480, easing: SPRING_SOFT });
    if (a) a.onfinish = a.oncancel = () => { els.dock.style.transformOrigin = ''; };
  }
  if (t.start) {
    [els.empty, els.modePick, els.examples].forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 120 + i * 60, easing: SPRING, fill: 'backwards' }));
  }
  for (const g of t.ghosts) {
    document.body.append(g);
    const a = g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-14px)' }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
    a.onfinish = a.oncancel = () => g.remove();
  }
}

function renderTop(ts) {
  const start = isStart(ts);
  const trans = startTransitionBegin(start);
  const chat = ui.chatById.get(ui.activeId);
  const view = effView();
  const flow = view === 'flow';
  setClass(els.main, 'start', start);
  setHidden(els.empty, !start);
  setHidden(els.examples, !start);
  setHidden(els.modePick, !start);
  updateModeTiles();
  const docTitle = chat && !start ? truncate(chat.questions[0]?.body || '', 60) + ' · Parallel chat' : 'Parallel chat';
  if (document.title !== docTitle) document.title = docTitle;
  setHidden(els.qRow, start || !chat || flow);
  if (chat && !start) {
    setText(els.topNo, 'Chat ' + chatNo(chat.id));
    const n = chatCards(chat.id).length;
    const lq0 = chat.questions[chat.questions.length - 1];
    rollText(els.topMeta, n === 0 && lq0?.status === 'streaming' ? '\u00b7 planning' : '\u00b7 ' + n + ' card' + (n === 1 ? '' : 's'));
    if (els.qRow._chat !== chat.id) { els.qRow._chat = chat.id; ui.qOpen = false; }
    const qs = chat.questions;
    const qi = Math.max(0, Math.min(qs.length - 1, ui.qIndex.has(chat.id) ? ui.qIndex.get(chat.id) : qs.length - 1));
    const q = qs[qi];
    setText(els.qBubble, q?.body || '');
    if (els.qBubble.title !== (q?.body || '')) els.qBubble.title = q?.body || '';
    setClass(els.qBubble, 'open', ui.qOpen);
    setAttr(els.qBubble, 'aria-expanded', String(ui.qOpen));
    setHidden(els.qStep, qs.length < 2);
    setText(els.qStepText, (qi + 1) + ' of ' + qs.length);
    els.qPrev.disabled = qi <= 0; els.qNext.disabled = qi >= qs.length - 1;
  }
  // the composer continues this chat in Flow, and opens a new one elsewhere
  const cont = flow && !start && !!chat;
  const ph = cont ? 'Ask a follow-up' : 'Ask a new question';
  if (els.askInput.placeholder !== ph) els.askInput.placeholder = ph;
  const hint = cont ? 'Continues this chat \u00b7 New chat starts another \u00b7 Enter to send' : 'Each question opens a new chat \u00b7 Enter to send \u00b7 Shift+Enter for a new line';
  setText(els.hint, hint);
  setClass(els.shell, 'view-fit', view === 'fit');
  setClass(els.shell, 'view-strip', view === 'strip');
  setClass(els.shell, 'view-flow', flow);
  setClass(els.shell, 'narrow', isNarrow());
  setClass(els.shell, 'focus-on', isFocusOn());
  setHidden(els.widthSeg, view !== 'strip' || isNarrow());
  for (const b of els.widthSeg.querySelectorAll('[data-w]')) {
    const on = Number(b.dataset.w) === ui.width;
    setClass(b, 'on', on);
    setAttr(b, 'aria-checked', String(on));
  }
  for (const b of els.viewSeg.querySelectorAll('[data-view]')) {
    const on = b.dataset.view === view;
    setClass(b, 'on', on);
    setAttr(b, 'aria-checked', String(on));
    b.disabled = isNarrow() && b.dataset.view === 'fit';
    if (b.dataset.view === 'flow') setHidden(b, !HAS_FLOW);
  }
  const n = state.decisions.length;
  setHidden(els.decCount, n === 0);
  setText(els.decCount, String(n));
  setClass(els.decBtn, 'on', ui.drawer?.kind === 'decisions');
  setAttr(els.decBtn, 'aria-expanded', String(ui.drawer?.kind === 'decisions'));
  startTransitionEnd(trans);
}

/* ---- sidebar */

// Narrowest window at which the sidebar stays docked beside the board.
const DOCK_MIN = 900;

function sideMode() {
  const w = window.innerWidth;
  if (w < 640) return 'hidden';
  if (w < DOCK_MIN) return 'rail';
  return ui.sideOpen === false ? 'rail' : 'open';
}

function renderSide() {
  const mode = sideMode();
  const overlay = ui.overlay && mode !== 'open';
  if (ui.overlay && !overlay) ui.overlay = false;
  setClass(els.shell, 'side-open', mode === 'open');
  setClass(els.shell, 'side-rail', mode === 'rail');
  setClass(els.shell, 'side-hidden', mode === 'hidden');
  setClass(els.shell, 'side-overlay', overlay);
  setClass(els.side, 'is-rail', mode === 'rail' && !overlay);
  setHidden(els.scrim, !overlay);
  const expanded = mode === 'open' || overlay;
  setAttr(els.sideToggle, 'aria-expanded', String(expanded));
  const t = expanded ? 'Collapse sidebar (b)' : 'Expand sidebar (b)';
  if (els.sideToggle.title !== t) els.sideToggle.title = t;
  setAttr(els.menuBtn, 'aria-expanded', String(overlay));
}

function toggleSide() {
  if (window.innerWidth >= DOCK_MIN) {
    ui.sideOpen = sideMode() !== 'open';
    saveSide(ui.sideOpen);
    ui.overlay = false;
  } else ui.overlay = !ui.overlay;
  schedule();
}

function newChat() {
  ui.userStart = true;
  ui.start = true; ui.overlay = false;
  schedule();
  requestAnimationFrame(() => requestAnimationFrame(() => els.askInput.focus()));
}

function renderSideList(ts) {
  // one pass over the log: which chats have streaming or failed nodes
  const flags = new Map();
  for (const id of state.order) {
    const n = state.nodes[id];
    if (!n || (n.status !== 'streaming' && n.status !== 'error')) continue;
    const cid = nodeChat(n.id);
    const f = flags.get(cid) || {};
    if (n.status === 'streaming') f.streaming = true; else f.error = true;
    flags.set(cid, f);
  }
  // chats linked to a card of the chat on screen
  const linked = new Set();
  if (ui.activeId && !ui.start) {
    for (const c of chatCards(ui.activeId)) {
      for (const e of edgesOf(state, c.id)) {
        const other = state.nodes[e.from === c.id ? e.to : e.from];
        if (other && nodeChat(other.id) !== ui.activeId) linked.add(nodeChat(other.id));
      }
    }
  }
  const selByChat = new Set();
  for (const id of ui.selected) { const t = nodeChat(id); if (t) selByChat.add(t); }

  const rows = [];
  const seen = new Set();
  for (const q of [...ts].reverse()) { // newest first
    seen.add(q.id);
    let v = tabViews.get(q.id);
    if (!v) {
      v = { n: h('span', { class: 'cr-n' }), q: h('span', { class: 'cr-q' }), dot: h('span', { class: 'dot', hidden: true }), udot: h('span', { class: 'udot', title: 'Finished while you were elsewhere', hidden: true }),
        link: icon('link'), sel: icon('check', 'smark') };
      v.link.title = 'Linked to a card in the open chat'; v.sel.title = 'Has selected cards';
      v.link.hidden = true; v.sel.hidden = true;
      v.el = h('button', { class: 'chat-row', type: 'button', onclick: () => setActive(q.id) }, v.n, v.q, h('span', { class: 'cr-marks' }, v.dot, v.udot, v.link, v.sel));
      tabViews.set(q.id, v);
      // a chat that appears while the page is open grows in at the top of the list
      if (ui.live && !reducedMotion.matches) v.el.animate([{ height: '0px', opacity: 0, marginBottom: '0px' }, { height: '34px', opacity: 1 }], { duration: 320, easing: SPRING_SOFT });
    }
    setText(v.n, String(chatNo(q.id)));
    const first = q.questions[0]?.body || 'Question';
    setText(v.q, first);
    if (v.el.title !== first) v.el.title = first;
    const f = flags.get(q.id);
    const st = f?.streaming ? 'streaming' : f?.error ? 'error' : null;
    setHidden(v.dot, !st);
    if (st && v.dot._st !== st) { v.dot._st = st; v.dot.className = 'dot st-' + st; v.dot.title = STATUS_LABEL[st]; }
    setHidden(v.link, !linked.has(q.id));
    setHidden(v.sel, !selByChat.has(q.id));
    const wantU = ui.unreadChats.has(q.id);
    if (wantU && v.udot.hidden && ui.live && !reducedMotion.matches) requestAnimationFrame(() => v.udot.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 420, easing: SPRING }));
    setHidden(v.udot, !wantU);
    const active = q.id === ui.activeId && !ui.start;
    setClass(v.el, 'active', active);
    setAttr(v.el, 'aria-current', active ? 'true' : 'false');
    rows.push(v.el);
  }
  const hl = ui.sideHl || (ui.sideHl = h('span', { class: 'cl-hl', 'aria-hidden': 'true' }));
  reconcile(els.chatList, [hl, ...rows]);
  for (const id of tabViews.keys()) if (!seen.has(id)) tabViews.delete(id);
  const actRow = ui.start ? null : tabViews.get(ui.activeId)?.el;
  if (actRow && actRow.offsetParent) {
    if (!hl._placed) hl.style.transition = 'none';
    hl.style.height = actRow.offsetHeight + 'px';
    hl.style.transform = 'translateY(' + actRow.offsetTop + 'px)';
    hl.style.opacity = '1';
    if (!hl._placed) { hl.offsetWidth; hl.style.transition = ''; hl._placed = true; }
  } else hl.style.opacity = '0';

  // keep the active row in view inside the list (the page never scrolls)
  const act = tabViews.get(ui.activeId);
  if (act && els.chatList._shown !== ui.activeId && act.el.offsetParent) {
    els.chatList._shown = ui.activeId;
    const s = els.chatList, t = act.el;
    if (t.offsetTop < s.scrollTop) s.scrollTop = t.offsetTop - 4;
    else if (t.offsetTop + t.offsetHeight > s.scrollTop + s.clientHeight) s.scrollTop = t.offsetTop + t.offsetHeight - s.clientHeight + 4;
  }
}

/* ---- drawer: decisions and peek */

// Layers remember what had focus when they opened and give it back when they close.
const openers = new Map();
function rememberOpener(k) { const a = document.activeElement; openers.set(k, a && a !== document.body ? a : null); }
function restoreOpener(k, fallback) {
  const a = openers.get(k);
  openers.delete(k);
  const t = a && a.isConnected && a.offsetParent !== null ? a : fallback;
  t?.focus?.({ preventScroll: true });
}

function openDrawer(d) {
  if (ui.drawer && ui.drawer.kind === d.kind && d.kind === 'decisions') { closeDrawer(); return; }
  if (!ui.drawer) rememberOpener('drawer');
  ui.drawer = d;
  schedule();
  requestAnimationFrame(() => requestAnimationFrame(() => { if (ui.drawer && !els.drawer.contains(document.activeElement)) els.drawerClose.focus({ preventScroll: true }); }));
}
function closeDrawer() {
  if (!ui.drawer) return;
  ui.drawer = null;
  schedule();
  restoreOpener('drawer', els.decBtn);
}

const peek = {};
(function buildPeek() {
  peek.relation = h('p', { class: 'peek-rel' });
  peek.title = h('h3', { class: 'peek-title' });
  peek.chip = h('span', { class: 'chip' });
  peek.body = h('div', { class: 'md body' });
  peek.thread = h('div', { class: 'thread' });
  peek.open = h('button', { class: 'btn primary', type: 'button', onclick: () => {
    const d = ui.drawer;
    if (d && d.kind === 'peek') { const id = d.cardId; ui.drawer = null; revealCard(id); }
  } });
  els.panePeek.append(peek.relation, h('div', { class: 'peek-head' }, peek.title, peek.chip), peek.body, peek.thread,
    h('div', { class: 'peek-foot' }, peek.open));
})();

function renderDrawer() {
  const d = ui.drawer;
  if (d && d.kind === 'peek' && (!state.nodes[d.cardId] || !state.edges.some((e) => e.id === d.edgeId))) ui.drawer = null;
  const dr = ui.drawer;
  setHidden(els.drawer, !dr);
  if (!dr) return;
  setHidden(els.paneDec, dr.kind !== 'decisions');
  setHidden(els.panePeek, dr.kind !== 'peek');
  setText(els.drawerTitle, dr.kind === 'decisions' ? 'Decisions' : 'Linked card');
  if (dr.kind === 'decisions') renderLedger(); else renderPeek(dr);
}

function renderPeek(d) {
  const e = state.edges.find((x) => x.id === d.edgeId);
  const other = state.nodes[d.cardId];
  const a = state.nodes[e.from], b = state.nodes[e.to];
  if (!a || !b) { ui.drawer = null; setHidden(els.drawer, true); return; }
  setText(peek.relation, `${a.title || 'Untitled card'} in chat ${chatNo(nodeChat(a.id))} ${EDGE_VERB[e.rel] || e.rel} ${b.title || 'Untitled card'} in chat ${chatNo(nodeChat(b.id))}`);
  setText(peek.title, other.title || 'Untitled card');
  setText(peek.chip, STATUS_LABEL[other.status] || other.status);
  if (peek.chip._st !== other.status) { peek.chip._st = other.status; peek.chip.className = 'chip st-' + other.status; }
  setMarkdown(peek.body, other.body || '');
  setText(peek.open, `Open chat ${chatNo(nodeChat(other.id))}`);

  const msgs = threadOf(state, other.id);
  const list = [];
  for (const m of msgs) {
    let v = peekMsgs.get(m.id);
    if (!v) {
      v = { quote: h('blockquote', { class: 'msg-quote', hidden: true }), text: h('div', { class: 'msg-text' }) };
      v.el = h('div', { class: 'msg' }, v.quote, v.text);
      peekMsgs.set(m.id, v);
    }
    const user = m.role === 'user';
    if (v.role !== m.role) {
      v.role = m.role;
      v.el.className = 'msg ' + (user ? 'user' : 'assistant');
      v.text.className = user ? 'msg-text plain' : 'msg-text md';
      v.text._src = undefined;
    }
    if (m.quote) { setText(v.quote, m.quote); setHidden(v.quote, false); } else setHidden(v.quote, true);
    if (user) setPlain(v.text, m.body || ''); else setMarkdown(v.text, m.body || '');
    list.push(v.el);
  }
  reconcile(peek.thread, list);
  setHidden(peek.thread, list.length === 0);
}

function renderLedger() {
  const list = [];
  const seen = new Set();
  for (const d of state.decisions) {
    seen.add(d.id);
    let v = decViews.get(d.id);
    if (!v) {
      v = { text: h('p', { class: 'dec-text' }), meta: h('div', { class: 'dec-meta muted' }) };
      v.unpin = h('button', { class: 'btn small', type: 'button', text: 'Unpin', 'aria-label': 'Unpin decision', onclick: () => api('DELETE', `/api/decisions/${encodeURIComponent(d.id)}`) });
      v.el = h('li', { class: 'decision' }, v.text, v.meta, v.unpin);
      decViews.set(d.id, v);
    }
    setText(v.text, d.text);
    const src = d.sourceNodeId ? cardOf(state, d.sourceNodeId) : null;
    const affects = (d.affects || []).map((id) => titleOf(id));
    const meta = [src ? `from ${src.title || 'a card'}` : 'pinned by hand', affects.length ? `affects ${affects.join(', ')}` : 'affects nothing'].join(' · ');
    setText(v.meta, meta);
    list.push(v.el);
  }
  reconcile(els.decisions, list);
  for (const id of decViews.keys()) if (!seen.has(id)) decViews.delete(id);
  setClass(els.decisions, 'is-empty', state.decisions.length === 0);
}

/* ---- selection bar, settings, connection */

function renderBar() {
  updateStopBtn();
  for (const id of [...ui.selected]) if (!state.nodes[id]) ui.selected.delete(id);
  const n = ui.selected.size;
  setHidden(els.selbar, n === 0);
  setText(els.selCount, `${n} selected`);
  els.selSynth.disabled = n < 2;
  renderConn();
}

/* ---- Model section (providers, keys, models) */

const PROV_ORDER = ['mock', 'anthropic', 'deepseek', 'qwen'];
const provLabel = (p) => (p.id === 'mock' ? 'Mock' : p.label || p.id);

// Provider calls always send JSON and never notify: errors show inline in the dialog.
async function pApi(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { ok: res.ok, status: res.status, data: data || {}, error: !res.ok ? ((data && data.error) || `Request failed (${res.status})`) : null };
  } catch {
    return { ok: false, status: 0, data: {}, error: 'Could not reach the server.' };
  }
}

const provUi = (id) => (ui.prov.ui[id] ||= { error: '', busy: false, confirmRemove: false, model: null, other: '', region: null, baseURL: '', remember: false, autoTried: false });
const provById = (id) => ui.prov.list.find((p) => p.id === id) || null;

async function loadProviders() {
  const r = await pApi('GET', '/api/providers');
  if (r.status === 404 || r.status === 405) ui.prov.status = 'unsupported';
  else if (!r.ok || !Array.isArray(r.data.providers)) ui.prov.status = 'unsupported';
  else {
    ui.prov.status = 'ready';
    ui.prov.active = r.data.active || null;
    ui.prov.list = [...r.data.providers].sort((a, b) => {
      const ia = PROV_ORDER.indexOf(a.id), ib = PROV_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    if (!ui.prov.sel || !provById(ui.prov.sel)) ui.prov.sel = ui.prov.active?.provider || ui.prov.list[0]?.id || null;
  }
  renderSettings();
  renderModelUi();
}

function ctxLabel(n) {
  n = Number(n);
  if (!n) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M context`;
  return `${Math.round(n / 1000)}K context`;
}

function applyProvider(p) {
  if (!p) return;
  const i = ui.prov.list.findIndex((x) => x.id === p.id);
  if (i >= 0) ui.prov.list[i] = p; else ui.prov.list.push(p);
}

function selectProvider(id) {
  ui.prov.sel = id;
  ui.prov.filter = '';
  renderModelUi();
}

async function connectKey(p, fields) {
  const st = provUi(p.id);
  const body = { apiKey: fields.key };
  if (p.regions) { body.region = fields.region; if (fields.region === 'custom') body.baseURL = fields.baseURL; }
  if (fields.remember) body.remember = true;
  st.busy = true; st.error = '';
  fields.clear(); // the key leaves the field as soon as the request is built
  fields.key = '';
  renderModelUi({ keepFocus: false });
  const r = await pApi('POST', `/api/providers/${encodeURIComponent(p.id)}/key`, body);
  body.apiKey = '';
  st.busy = false;
  if (r.ok && r.data.provider) { applyProvider(r.data.provider); st.error = ''; st.autoTried = true; }
  else st.error = r.error;
  renderModelUi();
}

async function removeKey(p) {
  const st = provUi(p.id);
  st.confirmRemove = false; st.busy = true; st.error = '';
  renderModelUi();
  const r = await pApi('DELETE', `/api/providers/${encodeURIComponent(p.id)}/key`);
  st.busy = false;
  if (r.ok && r.data.provider) { applyProvider(r.data.provider); st.model = null; st.autoTried = false; await loadConfig(); await loadProviders(); return; }
  st.error = r.error;
  renderModelUi();
}

async function fetchModels(p) {
  const st = provUi(p.id);
  st.autoTried = true; st.listBusy = true; st.error = '';
  renderModelUi();
  const r = await pApi('POST', `/api/providers/${encodeURIComponent(p.id)}/models`);
  st.listBusy = false;
  if (r.ok && r.data.provider) applyProvider(r.data.provider); else st.error = r.error;
  renderModelUi();
}

async function useModel(p, model) {
  const st = provUi(p.id);
  st.busy = true; st.error = '';
  renderModelUi();
  const body = p.needsKey ? { provider: p.id, model } : { provider: p.id };
  const r = await pApi('POST', '/api/config', body);
  st.busy = false;
  if (r.ok) {
    ui.config = { ...ui.config, ...r.data };
    ui.prov.active = { provider: r.data.provider || p.id, model: r.data.model ?? model ?? null };
    schedule();
  } else st.error = r.error;
  renderModelUi();
}

function modelRows(p, st, listEl) {
  const models = Array.isArray(p.models) ? p.models : [];
  const f = ui.prov.filter.trim().toLowerCase();
  const chosen = st.model ?? p.model ?? (ui.prov.active?.provider === p.id ? ui.prov.active.model : null);
  const rows = models.filter((m) => !f || m.id.toLowerCase().includes(f) || (m.label || '').toLowerCase().includes(f));
  listEl.replaceChildren(...(rows.length ? rows.map((m) => {
    const on = m.id === chosen && !st.other;
    const ctx = ctxLabel(m.contextWindow);
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(on), class: 'model-row' + (on ? ' on' : ''),
      onclick: () => { st.model = m.id; st.other = ''; modelRows(p, st, listEl); const other = ui.prov.otherEl; if (other) other.value = ''; syncUse(p, st); },
    },
      h('span', { class: 'mr-main' }, m.label ? [h('span', { text: m.label }), h('span', { class: 'mr-id', text: m.id })] : h('span', { class: 'mr-id plain', text: m.id })),
      ctx ? h('span', { class: 'mr-ctx', text: ctx }) : null);
  }) : [h('p', { class: 'muted model-empty', text: models.length ? 'No model matches that filter.' : 'No models listed.' })]));
}

function syncUse(p, st) {
  const b = ui.prov.useBtn;
  if (!b) return;
  const model = (st.other || '').trim() || st.model || p.model || (ui.prov.active?.provider === p.id ? ui.prov.active.model : null);
  b.disabled = st.busy || (p.needsKey && !model);
  b._model = model;
}

function renderModelUi({ keepFocus = true } = {}) {
  const box = els.modelUi;
  const ready = ui.prov.status === 'ready';
  setHidden(box, !ready);
  if (!ready) return;
  const focusKey = keepFocus && box.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  const sel = provById(ui.prov.sel);
  ui.prov.useBtn = null; ui.prov.otherEl = null;

  // provider picker
  const group = h('div', { class: 'prov-list', role: 'radiogroup', 'aria-label': 'Provider' }, ui.prov.list.map((p) => {
    const isSel = p.id === ui.prov.sel;
    const isActive = ui.prov.active?.provider === p.id;
    return h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(isSel), 'data-fk': 'prov-' + p.id, class: 'prov-row' + (isSel ? ' on' : ''),
      onclick: () => selectProvider(p.id),
    },
      h('span', { class: 'pr-main' },
        h('span', { class: 'pr-name', text: provLabel(p) }),
        h('span', { class: 'pr-sub muted', text: p.id === 'mock' ? 'no key needed' : p.hasKey && p.keyHint ? `key ${p.keyHint}` : '' })),
      isActive ? h('span', { class: 'active-mark', text: 'active' }) : null);
  }));

  const kids = [group];
  if (sel) kids.push(providerPanel(sel));
  box.replaceChildren(...kids);

  if (focusKey) box.querySelector(`[data-fk="${focusKey}"]`)?.focus();
}

function providerPanel(p) {
  const st = provUi(p.id);
  const panel = h('div', { class: 'prov-panel' });
  const err = h('p', { class: 'field-err', role: 'alert', text: st.error || '', hidden: !st.error });
  const isActive = ui.prov.active?.provider === p.id;

  if (!p.needsKey) {
    panel.append(h('p', { class: 'muted set-note', text: 'Mock, no key needed. It writes plausible answers locally so the layout can be tried without a provider.' }));
    const use = h('button', { class: 'btn primary', type: 'button', 'data-fk': 'use', text: isActive ? 'In use' : 'Use Mock', disabled: isActive || st.busy, onclick: () => useModel(p) });
    panel.append(h('div', { class: 'set-actions' }, use), err);
    return panel;
  }

  if (!p.hasKey) {
    // key entry: the value lives only in this input until Connect is pressed
    const keyId = 'key-' + p.id;
    const keyInput = h('input', { type: 'password', id: keyId, 'data-fk': 'key', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'Paste your API key', disabled: st.busy });
    panel.append(h('label', { class: 'field-label', for: keyId, text: 'API key' }), keyInput);

    let regionSel = null, baseInput = null;
    if (p.regions) {
      st.region ||= p.region && p.region !== 'custom' ? p.region : (p.regions[0]?.id || 'intl');
      regionSel = h('select', { id: 'region-' + p.id, 'data-fk': 'region', disabled: st.busy, onchange: () => { st.region = regionSel.value; renderModelUi(); } },
        [...p.regions.map((r) => h('option', { value: r.id, text: r.label, selected: st.region === r.id })), h('option', { value: 'custom', text: 'Custom endpoint', selected: st.region === 'custom' })]);
      panel.append(h('label', { class: 'field-label', for: 'region-' + p.id, text: 'Region' }), regionSel);
      if (st.region === 'custom') {
        baseInput = h('input', { type: 'text', id: 'base-' + p.id, 'data-fk': 'base', value: st.baseURL, placeholder: 'https://…/compatible-mode/v1', autocomplete: 'off', spellcheck: 'false', disabled: st.busy });
        baseInput.addEventListener('input', () => { st.baseURL = baseInput.value; });
        panel.append(h('label', { class: 'field-label', for: 'base-' + p.id, text: 'Base URL' }), baseInput);
      }
    }
    const remember = h('input', { type: 'checkbox', id: 'rem-' + p.id, 'data-fk': 'remember', checked: st.remember, disabled: st.busy });
    remember.addEventListener('change', () => { st.remember = remember.checked; });
    panel.append(h('label', { class: 'check-row', for: 'rem-' + p.id }, remember, h('span', { text: 'Remember on this computer' })),
      h('p', { class: 'muted set-note small', text: 'Saved in .keys.json in the prototype folder. Otherwise the key is forgotten when the server stops.' }));

    const go = () => {
      const key = keyInput.value.trim();
      if (!key) { st.error = 'Paste your API key first.'; renderModelUi(); return; }
      const fields = { key, region: regionSel ? regionSel.value : null, baseURL: baseInput ? baseInput.value.trim() : '', remember: remember.checked, clear: () => { keyInput.value = ''; } };
      connectKey(p, fields);
    };
    const connect = h('button', { class: 'btn primary', type: 'button', 'data-fk': 'connect', text: st.busy ? 'Checking' : 'Connect', disabled: st.busy, onclick: go });
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    panel.append(h('div', { class: 'set-actions' }, connect), err);
    return panel;
  }

  // a key is stored: show the hint and the model picker
  const src = { env: 'from an environment variable', file: 'remembered', page: 'this session' }[p.keySource] || '';
  const hint = ['Key ending ' + String(p.keyHint || '').replace(/^…/, ''), src].filter(Boolean).join(' · ');
  const remove = st.confirmRemove
    ? h('span', { class: 'reset-wrap' },
      h('button', { class: 'btn danger', type: 'button', 'data-fk': 'rm-yes', text: 'Confirm remove', onclick: () => removeKey(p) }),
      h('button', { class: 'btn', type: 'button', 'data-fk': 'rm-no', text: 'Cancel', onclick: () => { st.confirmRemove = false; renderModelUi(); } }))
    : h('button', { class: 'btn', type: 'button', 'data-fk': 'rm', text: 'Remove key', disabled: st.busy, onclick: () => { st.confirmRemove = true; renderModelUi(); } });
  panel.append(h('div', { class: 'set-row key-row' }, h('span', { class: 'muted', text: hint }), remove));

  if (p.models == null && !p.modelsError && !st.autoTried && !st.listBusy) { queueMicrotask(() => fetchModels(p)); }

  const head = h('div', { class: 'set-row' }, h('span', { class: 'field-label tight', text: 'Model' }),
    h('button', { class: 'btn small', type: 'button', 'data-fk': 'refresh', text: st.listBusy ? 'Loading' : 'Refresh list', disabled: st.listBusy || st.busy, onclick: () => fetchModels(p) }));
  panel.append(head);

  const otherInput = h('input', { type: 'text', id: 'other-' + p.id, 'data-fk': 'other', value: st.other, placeholder: 'Model id', autocomplete: 'off', spellcheck: 'false' });
  ui.prov.otherEl = otherInput;
  if (Array.isArray(p.models)) {
    const filter = h('input', { type: 'text', 'data-fk': 'filter', value: ui.prov.filter, placeholder: 'Filter models', 'aria-label': 'Filter models', autocomplete: 'off', spellcheck: 'false' });
    const list = h('div', { class: 'model-list', role: 'radiogroup', 'aria-label': 'Models' });
    filter.addEventListener('input', () => { ui.prov.filter = filter.value; modelRows(p, st, list); });
    modelRows(p, st, list);
    panel.append(filter, list, h('label', { class: 'field-label', for: 'other-' + p.id, text: 'Use another model id' }));
  } else if (p.modelsError) {
    panel.append(h('p', { class: 'field-err plain', text: p.modelsError }), h('label', { class: 'field-label', for: 'other-' + p.id, text: 'Model id' }));
  } else {
    panel.append(h('p', { class: 'muted set-note', text: st.listBusy ? 'Looking up models…' : 'No model list yet.' }), h('label', { class: 'field-label', for: 'other-' + p.id, text: 'Model id' }));
  }
  otherInput.addEventListener('input', () => { st.other = otherInput.value; if (st.other.trim()) panel.querySelectorAll('.model-row.on').forEach((r) => { r.classList.remove('on'); r.setAttribute('aria-checked', 'false'); }); syncUse(p, st); });
  otherInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ui.prov.useBtn?.click(); } });
  panel.append(otherInput);

  const isActive2 = ui.prov.active?.provider === p.id;
  const use = h('button', { class: 'btn primary', type: 'button', 'data-fk': 'use', text: 'Use this model', onclick: () => { if (use._model) useModel(p, use._model); } });
  ui.prov.useBtn = use;
  syncUse(p, st);
  panel.append(h('div', { class: 'set-actions' }, use, isActive2 ? h('span', { class: 'active-mark', text: `active · ${ui.prov.active.model || ''}` }) : null), err);
  return panel;
}

function renderSettings() {
  const { provider, model, mode, maxCards } = ui.config;
  const modeLabel = mode === 'fanout' ? 'fan-out' : 'single';
  setText(els.provider, provider ? [provider, model && model !== provider ? model : '', modeLabel].filter(Boolean).join(' \u00b7 ') : '');
  setText(els.providerLine, provider ? (model && model !== provider ? provider + ' \u00b7 ' + model : provider) : 'Provider unknown');
  setHidden(els.providerLine, ui.prov.status === 'ready');
  for (const b of els.settings.querySelectorAll('[data-mode]')) {
    const on = b.dataset.mode === mode;
    setClass(b, 'on', on);
    setAttr(b, 'aria-checked', String(on));
  }
  for (const b of els.maxSeg.children) {
    const on = Number(b.dataset.max) === Number(maxCards);
    setClass(b, 'on', on);
    setAttr(b, 'aria-checked', String(on));
  }
  setAttr(els.sqSwitch, 'aria-checked', String(ui.square));
  setHidden(els.resetBtn, ui.confirmReset);
  setHidden(els.resetYes, !ui.confirmReset);
  setHidden(els.resetNo, !ui.confirmReset);
  const open = ui.pop === 'settings';
  if (els.settings._open !== open) {
    els.settings._open = open;
    setShown(els.settings, open);
    if (open) { loadProviders(); requestAnimationFrame(() => els.settingsDialog.focus()); }
  }
  const keysOpen = ui.pop === 'help';
  if (els.keys._open !== keysOpen) {
    const wasKeys = els.keys._open;
    els.keys._open = keysOpen;
    setShown(els.keys, keysOpen);
    if (keysOpen) { rememberOpener('keys'); els.keysFilter.value = ''; buildKeys(); requestAnimationFrame(() => els.keysFilter.focus()); }
    else if (wasKeys === true && !ui.palette) restoreOpener('keys', els.helpBtn);
  }
  setAttr(els.shellSwitch, 'aria-checked', String(ui.shell));
  setAttr(els.settingsBtn, 'aria-expanded', String(open));
  setAttr(els.helpBtn, 'aria-expanded', String(ui.pop === 'help'));
}

function renderConn() {
  setHidden(els.conn, ui.connected);
}

async function loadConfig() {
  const c = await api('GET', '/api/config');
  if (c) { ui.config = { ...ui.config, ...c }; schedule(); }
}

function setPop(name) {
  ui.pop = ui.pop === name ? null : name;
  schedule();
}

function openSettings() {
  if (ui.pop !== 'settings') rememberOpener('settings');
  ui.pop = 'settings';
  schedule();
}
function closeSettings() {
  if (ui.pop !== 'settings') return;
  ui.pop = null;
  schedule();
  restoreOpener('settings', els.settingsBtn);
}

/* ----------------------------------------------------------------- inputs */

function fieldError(el, msg) {
  if (msg) { el.textContent = msg; el.hidden = false; } else el.hidden = true;
}

// The typed text flies from the composer to the new question (bubble or question card).
function startFlight(text) {
  if (reducedMotion.matches) return null;
  const r = els.askInput.getBoundingClientRect();
  const cs = getComputedStyle(els.askInput);
  return { text, left: r.left + parseFloat(cs.paddingLeft || 0), top: r.top + parseFloat(cs.paddingTop || 0), width: r.width - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0), q: null, t: performance.now() };
}
function runFlight() {
  const f = ui.flight;
  if (!f || !f.q) return;
  if (performance.now() - f.t > 2500 || !state.nodes[f.q]) { if (performance.now() - f.t > 2500) ui.flight = null; return; }
  const chat = ui.chatById.get(nodeChat(f.q));
  if (!chat || ui.start || chat.id !== ui.activeId) return;
  let tx, ty, tw, target;
  if (effView() === 'flow') {
    const qv = qViews.get(f.q), cv = chatViews.get(chat.id);
    if (!qv?.fl || !cv) return;
    const rr = cv.row.getBoundingClientRect();
    tx = rr.left - cv.row.scrollLeft + qv.fl.x + 14; ty = rr.top + qv.fl.y + 12; tw = qv.fl.w - 28; target = qv.text;
  } else {
    if (els.qRow.hidden || chat.questions[chat.questions.length - 1].id !== f.q) return;
    const b = els.qBubble.getBoundingClientRect();
    if (!b.width) return;
    tx = b.left + 14; ty = b.top + 8; tw = b.width - 28; target = els.qBubble;
  }
  ui.flight = null;
  const ghost = h('div', { class: 'flight', 'aria-hidden': 'true', text: f.text });
  Object.assign(ghost.style, { left: f.left + 'px', top: f.top + 'px', width: f.width + 'px' });
  document.body.append(ghost);
  const prevOp = target.style.opacity;
  target.style.opacity = '0';
  const a = ghost.animate([{ transform: 'translate(0, 0)', opacity: 1 }, { transform: `translate(${tx - f.left}px, ${ty - f.top}px)`, opacity: 1 }], { duration: 380, easing: SPRING_SOFT, fill: 'forwards' });
  const land = () => {
    target.style.transition = 'opacity 120ms ease-out';
    target.style.opacity = prevOp;
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).onfinish = () => { ghost.remove(); target.style.transition = ''; };
  };
  a.onfinish = land;
  a.oncancel = () => { ghost.remove(); target.style.opacity = prevOp; };
}

async function askQuestion(text) {
  text = String(text).trim();
  if (!text) { fieldError(els.askErr, 'Write a question first.'); return; }
  fieldError(els.askErr, '');
  if (ui.start || !ui.chats.length) ui.userStart = true;
  const cont = effView() === 'flow' && !ui.start && ui.activeId && ui.chatById.has(ui.activeId);
  const flight = startFlight(text);
  const r = await api('POST', '/api/ask', cont ? { text, chatId: ui.activeId } : { text });
  if (r) {
    if (flight && r.turnId) { flight.q = r.turnId; ui.flight = flight; }
    if (els.askInput.value.trim() === text) { els.askInput.value = ''; autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); }
    hist.push(text);
    if (r.turnId) { ui.pendingActivate = r.turnId; schedule(); }
  }
}

els.askForm.addEventListener('submit', (e) => { e.preventDefault(); submitMain(); });
els.askInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitMain(); }
});
els.askInput.addEventListener('input', () => { autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); fieldError(els.askErr, ''); });

for (const ex of [
  { label: 'Compare SQLite, Postgres and DuckDB', text: 'Compare SQLite, Postgres and DuckDB for a local-first analytics app: when to pick each, what moving between them costs, and how each handles backups.' },
  { label: 'Plan a three-week onboarding rollout', text: 'Plan a three-week rollout of a new onboarding flow: what to build first, how to measure whether it works, and what could go wrong.' },
  { label: 'How a browser turns a URL into pixels', text: 'Explain how a browser turns a URL into pixels: networking, parsing and layout, and where it is usually slow.' },
]) {
  els.examples.append(h('button', { class: 'example', type: 'button', text: ex.label, title: ex.text, onclick: () => askQuestion(ex.text) }));
}

// view switch
for (const b of els.viewSeg.querySelectorAll('[data-view]')) {
  b.addEventListener('click', () => setView(b.dataset.view));
}
function setView(v) {
  ui.view = v === 'strip' ? 'strip' : v === 'flow' && HAS_FLOW ? 'flow' : 'fit';
  saveView(ui.view);
  schedule();
}
window.addEventListener('resize', schedule);
for (const b of els.widthSeg.querySelectorAll('[data-w]')) {
  b.addEventListener('click', () => {
    ui.width = Number(b.dataset.w);
    ui.cardW.clear();
    saveWidth(ui.width);
    schedule();
    requestAnimationFrame(() => { const id = currentOf(ui.activeId); if (id) setCurrent(id); });
  });
}
new ResizeObserver(() => schedule()).observe(els.board);

// a vertical wheel over the overview bar scrolls the strip
els.overview.addEventListener('wheel', (e) => {
  const row = chatViews.get(ui.activeId)?.row;
  if (!row) return;
  e.preventDefault();
  row.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
}, { passive: false });

// top bar buttons
els.decBtn.addEventListener('click', () => openDrawer({ kind: 'decisions' }));
els.drawerClose.addEventListener('click', closeDrawer);
els.settingsBtn.addEventListener('click', () => (ui.pop === 'settings' ? closeSettings() : openSettings()));
els.helpBtn.addEventListener('click', () => setPop('help'));
document.addEventListener('mousedown', (e) => {
  if (ui.pop === 'help' && !e.target.closest('.dialog, .pop-trigger')) { ui.pop = null; schedule(); }
});

// settings dialog: scrim and close button close it; Tab stays inside
els.settingsScrim.addEventListener('click', closeSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsDialog.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const f = [...els.settingsDialog.querySelectorAll('button, input, select, textarea, [tabindex]')]
    .filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === els.settingsDialog)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// sidebar, bubble, new chat
els.sideToggle.addEventListener('click', toggleSide);
els.menuBtn.addEventListener('click', toggleSide);
els.scrim.addEventListener('click', () => { ui.overlay = false; schedule(); });
els.newChat.addEventListener('click', newChat);
els.qBubble.addEventListener('click', () => { ui.qOpen = !ui.qOpen; schedule(); });
for (const [b, d] of [[els.qPrev, -1], [els.qNext, 1]]) {
  b.addEventListener('click', () => {
    const qs = ui.chatById.get(ui.activeId)?.questions || [];
    const cur = ui.qIndex.has(ui.activeId) ? ui.qIndex.get(ui.activeId) : qs.length - 1;
    ui.qIndex.set(ui.activeId, Math.max(0, Math.min(qs.length - 1, cur + d)));
    schedule();
  });
}

// settings
for (let i = 1; i <= 6; i++) {
  els.maxSeg.append(h('button', { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-max': String(i), text: String(i), onclick: async () => {
    const c = await api('POST', '/api/config', { maxCards: i });
    if (c) { ui.config = { ...ui.config, ...c }; schedule(); }
  } }));
}
for (const b of els.settings.querySelectorAll('[data-mode]')) {
  b.addEventListener('click', async () => {
    const c = await api('POST', '/api/config', { mode: b.dataset.mode });
    if (c) { ui.config = { ...ui.config, ...c }; schedule(); }
  });
}
els.shellSwitch.addEventListener('click', () => { ui.shell = !ui.shell; saveShell(ui.shell); schedule(); });
els.sqSwitch.addEventListener('click', () => {
  ui.square = !ui.square;
  saveSquare(ui.square);
  schedule();
});
els.resetBtn.addEventListener('click', () => {
  ui.confirmReset = true; schedule();
  clearTimeout(els.resetBtn._t);
  els.resetBtn._t = setTimeout(() => { ui.confirmReset = false; schedule(); }, 6000);
});
els.resetNo.addEventListener('click', () => { ui.confirmReset = false; schedule(); });
els.resetYes.addEventListener('click', async () => {
  ui.confirmReset = false; schedule();
  await api('POST', '/api/reset');
});

// multi-select bar
async function broadcast() {
  const text = els.selInput.value.trim();
  if (!text) { els.selInput.focus(); notify('Write the question for the selected cards first.'); return; }
  const r = await api('POST', '/api/broadcast', { cardIds: [...ui.selected], text });
  if (r) {
    if (els.selInput.value.trim() === text) els.selInput.value = '';
    for (const rep of r.replies || []) { const v = cardViews.get(rep.cardId); if (v) v.scrollToMsg = rep.userNodeId; }
    schedule();
  }
}
els.selSend.addEventListener('click', broadcast);
els.selInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); broadcast(); }
});
els.selSynth.addEventListener('click', async () => {
  if (ui.selected.size < 2) return;
  const ids = [...ui.selected];
  const chat = nodeChat(ids[0]);
  const after = chat ? currentOf(chat) : null;
  const r = await api('POST', '/api/synthesize', { cardIds: ids });
  if (r) {
    ui.selected.clear();
    if (r.cardId && chat) {
      // opens beside the card that was current, becomes current and is scrolled to (the person's own action)
      if (after) { ui.insertAfter.set(r.cardId, after); moveInOrder(chat, r.cardId, after); }
      ui.current.set(chat, r.cardId);
      ui.scrollTo = r.cardId;
      setActive(chat);
    }
    schedule();
  }
});
els.selClear.addEventListener('click', () => { ui.selected.clear(); schedule(); });

// decisions form
els.decForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.decInput.value.trim();
  if (!text) { fieldError(els.decErr, 'Write the decision first.'); return; }
  fieldError(els.decErr, '');
  const r = await api('POST', '/api/decisions', { text });
  if (r && els.decInput.value.trim() === text) els.decInput.value = '';
});
els.decInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.decForm.requestSubmit(); }
});
els.decInput.addEventListener('input', () => fieldError(els.decErr, ''));

/* ---------------------------------------------------------- select to ask */

let popTarget = null;
let popRaf = 0;

function hidePop() {
  popTarget = null;
  if (!els.askPop.hidden) els.askPop.hidden = true;
}

function updatePop() {
  popRaf = 0;
  const s = window.getSelection();
  if (!s || s.isCollapsed || !s.rangeCount) { hidePop(); return; }
  let range = s.getRangeAt(0);
  // Judge by where the selection starts: a triple-click ends at the start of
  // the next block, which puts the common ancestor outside the askable text.
  let n = range.startContainer;
  if (n.nodeType !== 1) n = n.parentElement;
  const src = n && n.closest('[data-askable]');
  const cardEl = src && src.closest('.card');
  if (src && !src.contains(range.endContainer)) {
    range = range.cloneRange();
    range.setEnd(src, src.childNodes.length);
  }
  const text = range.toString().replace(/\s+/g, ' ').trim();
  if (!src || !cardEl || !text) { hidePop(); return; }
  const rect = range.getBoundingClientRect();
  // follow the selection while a canvas scrolls; hide only once it has left the window
  if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) { hidePop(); return; }
  popTarget = { cardId: cardEl.dataset.id, text, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } };
  els.askPop.hidden = false;
  const w = els.askPop.offsetWidth || 110;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8));
  let top = rect.top - 34;
  if (top < 8) top = rect.bottom + 8;
  els.askPop.style.left = left + 'px';
  els.askPop.style.top = top + 'px';
}

document.addEventListener('selectionchange', () => {
  if (!popRaf) popRaf = requestAnimationFrame(updatePop);
  if (deferredBySelection) {
    const s = window.getSelection();
    if (!s || s.isCollapsed) schedule();
  }
});
window.addEventListener('scroll', () => { if (!popRaf) popRaf = requestAnimationFrame(updatePop); }, true);
window.addEventListener('resize', () => { hidePop(); closeBranchPrompt(); });

els.askPop.addEventListener('mousedown', (e) => e.preventDefault());
els.askPop.addEventListener('click', () => {
  if (!popTarget) return;
  const { cardId, text, rect } = popTarget;
  const v = cardViews.get(cardId);
  hidePop();
  window.getSelection().removeAllRanges();
  if (!v) return;
  if (effView() === 'flow') { openBranchPrompt(cardId, text, rect); return; }
  ui.quotes.set(cardId, truncate(text, 600));
  updateQuote(v);
  v.input.focus();
  schedule();
});

/* ------------------------------------------- Flow: follow-up prompt on a selection */

let branchTarget = null;

function closeBranchPrompt() {
  branchTarget = null;
  if (!els.branchPrompt.hidden) els.branchPrompt.hidden = true;
}

function openBranchPrompt(cardId, text, rect) {
  branchTarget = { cardId, quote: truncate(text, 600) };
  els.branchInput.value = '';
  syncSend(els.branchInput, els.branchSend);
  const p = els.branchPrompt;
  p.hidden = false;
  const w = p.offsetWidth || 340, hh = p.offsetHeight || 46;
  p.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - w - 8)) + 'px';
  p.style.top = (rect.bottom + 10 + hh > window.innerHeight ? Math.max(8, rect.top - hh - 10) : rect.bottom + 10) + 'px';
  requestAnimationFrame(() => els.branchInput.focus({ preventScroll: true }));
}

async function submitBranch(forced) {
  const text = els.branchInput.value.trim();
  if (!text || !branchTarget) return;
  const { cardId, quote } = branchTarget;
  closeBranchPrompt();
  await sendFollowup(cardId, text, quote, forced || null);
}

els.branchPrompt.addEventListener('submit', (e) => { e.preventDefault(); submitBranch(); });
els.branchInput.addEventListener('input', () => syncSend(els.branchInput, els.branchSend));
els.branchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.stopPropagation(); closeBranchPrompt(); }
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitBranch(e.ctrlKey || e.metaKey ? 'branch' : e.altKey ? 'reply' : null); }
});
document.addEventListener('mousedown', (e) => { if (branchTarget && !e.target.closest('#branch-prompt')) closeBranchPrompt(); });

/* ---------------------------------------------------- shared motion bits */

// Show or hide with a short exit animation (the entrance is CSS on :not([hidden])).
function setShown(el, show) {
  if (show) {
    clearTimeout(el._closeT);
    el.classList.remove('closing');
    if (el.hidden) el.hidden = false;
    return;
  }
  if (el.hidden || el.classList.contains('closing')) return;
  if (reducedMotion.matches) { el.hidden = true; return; }
  el.classList.add('closing');
  el._closeT = setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 110);
}

// Segmented controls: one pill slides to the active option.
function updatePills() {
  for (const seg of document.querySelectorAll('.seg')) {
    const pill = seg._pill || (seg._pill = seg.insertBefore(h('span', { class: 'seg-pill', 'aria-hidden': 'true' }), seg.firstChild));
    const on = seg.querySelector('button.on');
    if (!on || !seg.offsetParent) { pill.style.opacity = '0'; seg._placed = false; continue; }
    const x = on.offsetLeft, w = on.offsetWidth;
    if (seg._x === x && seg._w === w && seg._placed) continue;
    if (!seg._placed) pill.style.transition = 'none';
    pill.style.opacity = '1';
    pill.style.width = w + 'px';
    pill.style.transform = 'translateX(' + x + 'px)';
    if (!seg._placed) { pill.offsetWidth; pill.style.transition = ''; seg._placed = true; }
    seg._x = x; seg._w = w;
  }
}

/* --------------------------------------------------------------- keyboard */

function activeCards() {
  if (!ui.activeId) return [];
  return effView() === 'flow' ? chatCards(ui.activeId) : orderedCards(ui.activeId);
}

function moveCurrent(delta) {
  const cards = activeCards();
  if (!cards.length) return;
  const i = cards.findIndex((c) => c.id === currentOf(ui.activeId));
  const next = cards[Math.max(0, Math.min(cards.length - 1, (i < 0 ? 0 : i) + delta))];
  setCurrent(next.id);
}

// Shift+arrow: move the current card one place along the strip.
function shiftCurrent(delta) {
  const ord = ui.order.get(ui.activeId);
  const id = currentOf(ui.activeId);
  if (!ord || !id) return;
  const i = ord.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= ord.length) return;
  [ord[i], ord[j]] = [ord[j], ord[i]];
  schedule();
  requestAnimationFrame(() => setCurrent(id));
}

function moveChat(delta) {
  const ts = ui.chats;
  if (!ts.length) return;
  const i = ts.findIndex((q) => q.id === ui.activeId);
  const next = ts[Math.max(0, Math.min(ts.length - 1, (i < 0 ? ts.length - 1 : i) + delta))];
  setActive(next.id);
}

function focusComposer(id) {
  setCurrent(id);
  requestAnimationFrame(() => cardViews.get(id)?.input.focus({ preventScroll: true }));
}

document.addEventListener('click', async (e) => {
  const b = e.target instanceof Element ? e.target.closest('.copy-code') : null;
  if (!b) return;
  const code = b.parentElement?.querySelector('code')?.textContent || '';
  if (await copyText(code)) { b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 1200); }
});

/* ===================================================== commands, keys, palette, shell editing */

const hist = createHistory();
const seqHint = els.keyhint;

function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status', text: msg });
  document.body.append(t);
  const a = anim(t, [{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 160 });
  setTimeout(() => { t.remove(); }, 1500);
  return a;
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = h('textarea', { style: 'position:fixed;opacity:0;left:-999px' });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}
const cardMarkdown = (id) => {
  const c = state.nodes[id];
  return c ? `# ${c.title || 'Untitled card'}\n\n${c.body || ''}`.trim() + '\n' : '';
};

function streamingIn(chatId) {
  return state.order.filter((id) => { const n = state.nodes[id]; return n && n.status === 'streaming' && nodeChat(id) === chatId; });
}
function stopChat() {
  const ids = ui.activeId ? streamingIn(ui.activeId) : [];
  if (!ids.length) return false;
  for (const id of ids) cancelNode(id);
  toast('Stopping');
  return true;
}

const inChatNow = () => !ui.start && !!ui.activeId;
const curCard = () => (inChatNow() ? currentOf(ui.activeId) : null);
const hasSelection = () => (window.getSelection()?.toString() || '') !== '';

function scrollCurrent(fn) {
  const v = cardViews.get(curCard());
  if (!v) return;
  const by = fn(v.scroller);
  v.scroller.scrollBy({ top: by, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

function cycleView() {
  const vs = HAS_FLOW ? ['fit', 'strip', 'flow'] : ['fit', 'strip'];
  setView(vs[(vs.indexOf(ui.view) + 1) % vs.length]);
}
function toggleFocus() {
  if (ui.view !== 'strip') { ui.prevWidth = ui.width; ui.width = 2; saveWidth(2); setView('strip'); return; }
  if (ui.width === 2) ui.width = ui.prevWidth != null && ui.prevWidth !== 2 ? ui.prevWidth : 1;
  else { ui.prevWidth = ui.width; ui.width = 2; }
  saveWidth(ui.width);
  schedule();
  requestAnimationFrame(() => { const id = curCard(); if (id) setCurrent(id); });
}
function widen(delta) {
  const id = curCard();
  if (!id || effView() !== 'strip' || isFocusOn()) return;
  const now = sizeIdxOf(id);
  ui.cardW.set(id, SIZES[Math.max(0, Math.min(SIZES.length - 1, now + delta))].id);
  schedule();
  requestAnimationFrame(() => setCurrent(id));
}
function writeIn(forceNew) {
  const id = curCard();
  if (!id) return;
  const v = cardViews.get(id);
  if (forceNew && effView() === 'flow' && v) { v.forceNew = true; setHidden(v.newChip, false); }
  focusComposer(id);
}
function closeTopLayer() {
  if (ui.palette) { closePalette(); return true; }
  if (ui.pop === 'help') { ui.pop = null; schedule(); return true; }
  if (ui.pop === 'settings') { closeSettings(); return true; }
  if (linksPop) { closeLinksPop(); return true; }
  if (branchTarget) { closeBranchPrompt(); return true; }
  if (previewHost.isOpen) { previewHost.hide(); return true; }
  if (ui.overlay) { ui.overlay = false; schedule(); return true; }
  if (ui.drawer) { closeDrawer(); return true; }
  return false;
}
function openModel() {
  openSettings();
  requestAnimationFrame(() => requestAnimationFrame(() => $('model-sec')?.scrollIntoView({ block: 'start' })));
}

// The one registry: key handler, palette, slash menu and the shortcuts dialog all read this list.
const COMMANDS = [];
const cmd = (c) => { COMMANDS.push({ keys: [], names: [], ...c }); };

cmd({ id: 'card.prev', title: 'Previous card', group: 'Move', keys: ['h', 'left'], when: inChatNow, run: () => moveCurrent(-1) });
cmd({ id: 'card.next', title: 'Next card', group: 'Move', keys: ['l', 'right'], when: inChatNow, run: () => moveCurrent(1) });
cmd({ id: 'card.down', title: 'Scroll the card down 3 lines', group: 'Move', keys: ['j', 'down'], when: inChatNow, run: () => scrollCurrent(() => 66) });
cmd({ id: 'card.up', title: 'Scroll the card up 3 lines', group: 'Move', keys: ['k', 'up'], when: inChatNow, run: () => scrollCurrent(() => -66) });
cmd({ id: 'card.halfdown', title: 'Half a page down', group: 'Move', keys: ['ctrl+d'], when: inChatNow, run: () => scrollCurrent((s) => s.clientHeight / 2) });
cmd({ id: 'card.halfup', title: 'Half a page up', group: 'Move', keys: ['ctrl+u'], when: inChatNow, run: () => scrollCurrent((s) => -s.clientHeight / 2) });
cmd({ id: 'card.pagedown', title: 'A page down', group: 'Move', keys: ['space'], when: inChatNow, run: () => scrollCurrent((s) => s.clientHeight - 24) });
cmd({ id: 'card.pageup', title: 'A page up', group: 'Move', keys: ['shift+space'], when: inChatNow, run: () => scrollCurrent((s) => -(s.clientHeight - 24)) });
cmd({ id: 'card.first', title: 'First card', group: 'Move', keys: ['g g', 'home'], when: inChatNow, run: () => { const c = activeCards()[0]; if (c) setCurrent(c.id); } });
cmd({ id: 'card.last', title: 'Last card', group: 'Move', keys: ['G', 'end'], when: inChatNow, run: () => { const c = activeCards().at(-1); if (c) setCurrent(c.id); } });
for (let n = 1; n <= 9; n++) cmd({ id: 'card.n' + n, title: 'Card ' + n, group: 'Move', keys: [String(n)], names: ['card ' + n], hidden: n > 1, when: () => inChatNow() && !!activeCards()[n - 1], run: () => { const c = activeCards()[n - 1]; if (c) setCurrent(c.id); } });
cmd({ id: 'card.move.left', title: 'Move the card one place left', group: 'Move', keys: ['shift+left'], when: inChatNow, run: () => shiftCurrent(-1) });
cmd({ id: 'card.move.right', title: 'Move the card one place right', group: 'Move', keys: ['shift+right'], when: inChatNow, run: () => shiftCurrent(1) });

cmd({ id: 'chat.next', title: 'Next chat', group: 'Chats', keys: ['g t', ']'], run: () => moveChat(1) });
cmd({ id: 'chat.prev', title: 'Previous chat', group: 'Chats', keys: ['g T', '['], run: () => moveChat(-1) });
for (let n = 1; n <= 9; n++) cmd({ id: 'chat.n' + n, title: 'Chat ' + n, group: 'Chats', keys: ['alt+' + n], names: ['chat ' + n], hidden: n > 1, when: () => !!ui.chats[n - 1], run: () => { const c = ui.chats[n - 1]; if (c) setActive(c.id); } });
cmd({ id: 'chat.new', title: 'New chat', group: 'Chats', keys: ['n', 'ctrl+l'], names: ['new'], slash: 'new', run: newChat });

cmd({ id: 'write', title: 'Write in the current card', group: 'Write', keys: ['i', 'enter'], when: inChatNow, run: () => writeIn(false) });
cmd({ id: 'write.new', title: 'Write a follow-up that becomes a new card', group: 'Write', keys: ['o'], when: inChatNow, run: () => writeIn(true) });
cmd({ id: 'composer', title: 'Write a new question', group: 'Write', keys: ['/'], run: () => els.askInput.focus() });
cmd({ id: 'esc', title: 'Back to normal mode', group: 'Write', keys: ['esc'], hidden: true, run: () => {} });

cmd({ id: 'card.yank', title: 'Copy the card as Markdown (yank)', group: 'Cards', keys: ['y y'], names: ['copy'], when: () => !!curCard(), run: async () => { const id = curCard(); if (id && await copyText(cardMarkdown(id))) toast('Copied'); } });
cmd({ id: 'card.select', title: 'Select or deselect the card', group: 'Cards', keys: ['x'], when: () => !!curCard(), run: () => { const id = curCard(); if (id) toggleSelect(id, !ui.selected.has(id)); } });
cmd({ id: 'card.regen', title: 'Regenerate the card', group: 'Cards', keys: ['R'], names: ['regen'], when: () => !!curCard(), run: () => { const id = curCard(); if (id) refreshCard(id); } });
cmd({ id: 'card.widen', title: 'Widen the card (Strip)', group: 'Cards', keys: ['+', '='], run: () => widen(1) });
cmd({ id: 'card.narrow', title: 'Narrow the card (Strip)', group: 'Cards', keys: ['-'], run: () => widen(-1) });
cmd({ id: 'stop', title: 'Stop generating in this chat', group: 'Cards', keys: ['ctrl+c', 's'], names: ['stop'], slash: 'stop', when: () => !hasSelection() && !!ui.activeId && streamingIn(ui.activeId).length > 0, run: stopChat });

cmd({ id: 'view.cycle', title: 'Cycle Fit, Strip and Flow', group: 'View', keys: ['v'], run: cycleView });
cmd({ id: 'view.fit', title: 'Fit view', group: 'View', keys: [], names: ['fit'], slash: 'fit', run: () => setView('fit') });
cmd({ id: 'view.strip', title: 'Strip view', group: 'View', keys: [], names: ['strip'], slash: 'strip', run: () => setView('strip') });
cmd({ id: 'view.flow', title: 'Flow view', group: 'View', keys: [], names: ['flow'], slash: 'flow', when: () => HAS_FLOW, run: () => setView('flow') });
cmd({ id: 'view.focus', title: 'Focus: the current card centred (Strip)', group: 'View', keys: ['z'], names: ['focus'], slash: 'focus', run: toggleFocus });
cmd({ id: 'sidebar', title: 'Show or hide the sidebar', group: 'View', keys: ['b'], run: toggleSide });
cmd({ id: 'decisions', title: 'Decisions', group: 'View', keys: ['d'], names: ['decisions'], slash: 'decisions', run: () => openDrawer({ kind: 'decisions' }) });

cmd({ id: 'palette', title: 'Command palette', group: 'Commands', keys: [':', 'ctrl+shift+p'], hidden: true, run: () => openPalette() });
cmd({ id: 'help', title: 'Shortcuts', group: 'Commands', keys: ['?'], names: ['help'], slash: 'help', run: () => { ui.pop = 'help'; schedule(); } });
cmd({ id: 'close', title: 'Close the top-most panel', group: 'Commands', keys: ['q'], names: ['q'], run: closeTopLayer });
cmd({ id: 'settings', title: 'Settings', group: 'Commands', keys: [], names: ['settings'], slash: 'settings', run: openSettings });
cmd({ id: 'model', title: 'Model settings', group: 'Commands', keys: [], names: ['model'], slash: 'model', run: openModel });
cmd({ id: 'reset', title: 'Reset the session (asks first)', group: 'Commands', keys: [], names: ['reset'], slash: 'reset', run: () => { ui.confirmReset = true; openSettings(); } });

// documented only: keys that live inside text boxes
const DOCS = [
  { group: 'Line editing', title: 'Start / end of line', keys: ['ctrl+a', 'ctrl+e'] },
  { group: 'Line editing', title: 'Delete to the start / end of the line', keys: ['ctrl+u', 'ctrl+k'] },
  { group: 'Line editing', title: 'Back / forward a word', keys: ['alt+b', 'alt+f'] },
  { group: 'Line editing', title: 'Delete the previous word', keys: ['alt+backspace', 'ctrl+backspace'], note: 'Ctrl+W is reserved by the browser and cannot be used.' },
  { group: 'Line editing', title: 'Leave an empty box (EOF)', keys: ['ctrl+d'] },
  { group: 'Line editing', title: 'New line', keys: ['ctrl+j', 'shift+enter'] },
  { group: 'Write', title: 'Flow reply: the model decides / new card / this card', keys: ['enter', 'ctrl+enter', 'alt+enter'] },
  { group: 'History', title: 'Previous / next question', keys: ['up', 'down', 'ctrl+p', 'ctrl+n'] },
  { group: 'History', title: 'Reverse search; Ctrl+R again for older', keys: ['ctrl+r'], note: 'Enter accepts, Esc restores your draft.' },
  { group: 'Commands', title: 'Slash commands in the main box', keys: ['/ then a name'], note: 'Tab completes, Enter runs.' },
];

const singleMap = new Map(), seqMap = new Map();
for (const c of COMMANDS) for (const k of c.keys) (k.includes(' ') ? seqMap : singleMap).set(k, c);
const SLASH = new Map(COMMANDS.filter((c) => c.slash).map((c) => [c.slash, c]));
const sequencer = createSequencer(seqMap, { onPending: (p) => { seqHint.hidden = !p; seqHint.textContent = p ? p + ' \u2026' : ''; } });

function runCommand(c) {
  if (c.group === 'Move' || c.id === 'write' || c.id === 'write.new') { ui.kbd = true; schedule(); }
  try { const r = c.run(); if (r && r.catch) r.catch(() => {}); } catch (e) { console.error(e); }
}

/* ---- key handler (normal mode) */

const SHELL_KEYS = new Set(['ctrl+a', 'ctrl+e', 'ctrl+u', 'ctrl+k', 'alt+b', 'alt+f', 'alt+backspace', 'ctrl+backspace', 'alt+d', 'ctrl+j', 'ctrl+d']);

document.addEventListener('pointerdown', () => { if (ui.kbd) { ui.kbd = false; schedule(); } }, true);

document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  const name = keyName(e);
  if (!name) return;
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.matches('input, textarea, select') || t.isContentEditable);

  if (name === 'ctrl+shift+p') { e.preventDefault(); openPalette(); return; }
  if (name === 'esc') { handleEscape(e, typing, t); return; }
  if (ui.palette) return; // the palette reads its own keys
  if (ui.pop === 'settings' || ui.pop === 'help') return;
  if (typing) { handleTyping(e, name, t); return; }

  const onControl = t instanceof HTMLElement && t.matches('button, a, summary');
  const s = sequencer.feed(name);
  if (s.kind === 'pending') { e.preventDefault(); return; }
  if (s.kind === 'done') { e.preventDefault(); if (!s.value.when || s.value.when()) runCommand(s.value); return; }
  const c = singleMap.get(name);
  if (!c || c.id === 'esc') return;
  if (onControl && (name === 'enter' || name === 'space')) return; // let a focused button act
  if (c.when && !c.when()) return;
  e.preventDefault();
  runCommand(c);
});

function handleEscape(e, typing, t) {
  sequencer.clear();
  if (ui.palette) { closePalette(); return; }
  if (slashOpen) { hideSlash(); return; }
  if (rs.active) { cancelRsearch(); return; }
  if (ui.pop === 'help') { ui.pop = null; schedule(); return; }
  if (ui.pop === 'settings') { closeSettings(); return; }
  if (linksPop) { closeLinksPop(); return; }
  if (branchTarget) { closeBranchPrompt(); return; }
  if (typing) { t.blur(); return; }
  if (previewHost.isOpen) { previewHost.hide(); return; }
  if (ui.pop) { ui.pop = null; schedule(); return; }
  if (ui.overlay) { ui.overlay = false; schedule(); return; }
  if (ui.drawer) { closeDrawer(); return; }
}

/* ---- text boxes: shell-style line editing, history, reverse search, slash menu */

function handleTyping(e, name, t) {
  const isText = t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'search'));
  if (!isText) return;
  if (t === els.askInput && mainComposerKeys(e, name, t)) return;
  if (ui.shell && SHELL_KEYS.has(name) && lineEdit(t, name)) e.preventDefault();
}

let slashOpen = false, slashMatches = [], slashIdx = 0;
function updateSlash() {
  const v = els.askInput.value;
  const m = /^\/(\w*)$/.exec(v);
  slashMatches = m ? [...SLASH.entries()].filter(([n, c]) => n.startsWith(m[1].toLowerCase()) && (!c.when || c.when() !== false || c.id === 'stop')).map(([, c]) => c) : [];
  slashOpen = slashMatches.length > 0;
  slashIdx = Math.min(slashIdx, Math.max(0, slashMatches.length - 1));
  setHidden(els.slashMenu, !slashOpen);
  if (!slashOpen) return;
  els.slashMenu.replaceChildren(...slashMatches.map((c, i) => h('li', { role: 'option', 'aria-selected': String(i === slashIdx), class: 'slash-item' + (i === slashIdx ? ' on' : ''), onmousedown: (ev) => { ev.preventDefault(); clearAsk(); hideSlash(); runCommand(c); } },
    h('span', { class: 'si-name', text: '/' + c.slash }), h('span', { class: 'si-title muted', text: c.title }))));
}
function hideSlash() { slashOpen = false; setHidden(els.slashMenu, true); }
function clearAsk() { els.askInput.value = ''; autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); }

const rs = { active: false, term: '', n: 0, draft: '' };
function showRsearch() {
  setHidden(els.rsearch, !rs.active);
  if (rs.active) els.rsearch.textContent = 'reverse-i-search: \`' + rs.term + '\`';
}
function rsearchStep() {
  const hit = hist.search(rs.term, rs.n);
  if (hit) { els.askInput.value = hit.text; rs.n = hit.n; autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); }
  else if (rs.term) els.rsearch.textContent = 'failing reverse-i-search: \`' + rs.term + '\`';
}
function cancelRsearch() {
  els.askInput.value = rs.draft;
  rs.active = false; rs.term = ''; rs.n = 0;
  showRsearch();
  autosize(els.askInput, 190); syncSend(els.askInput, els.askSend);
}
function acceptRsearch() { rs.active = false; rs.term = ''; rs.n = 0; showRsearch(); }

function histPrev() { const v = hist.prev(els.askInput.value); if (v != null) { els.askInput.value = v; autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); els.askInput.setSelectionRange(v.length, v.length); } }
function histNext() { const v = hist.next(); if (v != null) { els.askInput.value = v; autosize(els.askInput, 190); syncSend(els.askInput, els.askSend); els.askInput.setSelectionRange(v.length, v.length); } }

// returns true when the key was used
function mainComposerKeys(e, name, ta) {
  if (slashOpen) {
    if (name === 'down') { e.preventDefault(); slashIdx = (slashIdx + 1) % slashMatches.length; updateSlash(); return true; }
    if (name === 'up') { e.preventDefault(); slashIdx = (slashIdx - 1 + slashMatches.length) % slashMatches.length; updateSlash(); return true; }
    if (name === 'tab') { e.preventDefault(); ta.value = '/' + slashMatches[slashIdx].slash; updateSlash(); autosize(ta, 190); return true; }
  }
  if (!ui.shell) return false;
  if (rs.active) {
    if (name === 'ctrl+r') { e.preventDefault(); rs.n++; rsearchStep(); return true; }
    if (name === 'backspace') { e.preventDefault(); rs.term = rs.term.slice(0, -1); rs.n = 0; showRsearch(); rsearchStep(); return true; }
    if (name === 'ctrl+g') { e.preventDefault(); cancelRsearch(); return true; }
    if (name === 'enter') return false; // submitMain accepts
    if (name.length === 1) { e.preventDefault(); rs.term += name; rs.n = 0; showRsearch(); rsearchStep(); return true; }
    if (name === 'ctrl+c') return false;
    acceptRsearch();
    return false;
  }
  if (name === 'ctrl+r') { e.preventDefault(); rs.active = true; rs.term = ''; rs.n = 0; rs.draft = ta.value; showRsearch(); return true; }
  if ((name === 'up' && onFirstLine(ta)) || name === 'ctrl+p') { e.preventDefault(); histPrev(); return true; }
  if ((name === 'down' && onLastLine(ta)) || name === 'ctrl+n') { e.preventDefault(); histNext(); return true; }
  return false;
}

function updateStopBtn() {
  const busy = !!ui.activeId && !ui.start && streamingIn(ui.activeId).length > 0;
  const stop = busy && !els.askInput.value.trim();
  setClass(els.askSend, 'is-stop', stop);
  setAttr(els.askSend, 'aria-label', stop ? 'Stop generating' : 'Send question');
  if (els.askSend.title !== (stop ? 'Stop generating (Ctrl+C)' : '')) els.askSend.title = stop ? 'Stop generating (Ctrl+C)' : '';
}

function submitMain() {
  if (els.askSend.classList.contains('is-stop') && !els.askInput.value.trim()) { stopChat(); return; }
  if (rs.active) { acceptRsearch(); return; }
  const v = els.askInput.value.trim();
  const m = /^\/(\w+)\s*$/.exec(v);
  const c = m ? SLASH.get(m[1].toLowerCase()) : null;
  if (c || (slashOpen && slashMatches[slashIdx] && /^\/\w*$/.test(v))) {
    const run = c || slashMatches[slashIdx];
    clearAsk(); hideSlash();
    runCommand(run);
    return;
  }
  askQuestion(els.askInput.value);
}
els.askInput.addEventListener('input', () => { if (!rs.active) updateSlash(); updateStopBtn(); });
els.askInput.addEventListener('blur', () => setTimeout(hideSlash, 120));

/* ---- command palette */

const pal = { items: [], idx: 0 };
function openPalette(prefill = '') {
  if (!ui.palette) rememberOpener('palette');
  ui.palette = true;
  setShown(els.palette, true);
  els.paletteInput.value = prefill;
  renderPalette();
  requestAnimationFrame(() => els.paletteInput.focus());
}
function closePalette() {
  if (!ui.palette) return;
  ui.palette = false;
  setShown(els.palette, false);
  restoreOpener('palette', null);
}
function paletteItems(q) {
  const t = q.trim();
  const out = [];
  let m;
  if ((m = /^chat\s*(\d+)$/i.exec(t)) && ui.chats[+m[1] - 1]) { const c = ui.chats[+m[1] - 1]; out.push({ title: 'Go to chat ' + m[1], sub: truncate(c.questions[0]?.body, 60), score: 9000, run: () => setActive(c.id) }); }
  if ((m = /^card\s*(\d+)$/i.exec(t)) && activeCards()[+m[1] - 1]) { const c = activeCards()[+m[1] - 1]; out.push({ title: 'Go to card ' + m[1], sub: c.title, score: 9000, run: () => setCurrent(c.id) }); }
  const lq = t.toLowerCase();
  for (const c of COMMANDS) {
    if (c.hidden && !c.names.length) continue;
    if (/^(card|chat)\./.test(c.id) && /\.n\d$/.test(c.id)) continue; // reached by name
    if (c.when && c.when() === false && !['stop'].includes(c.id)) { if (!lq) continue; }
    let score = -1;
    if (!lq) score = 0;
    else {
      for (const n of c.names) { if (n === lq) score = Math.max(score, 5000); else if (n.startsWith(lq)) score = Math.max(score, 4000 - n.length); }
      score = Math.max(score, fuzzy(lq, c.title));
    }
    if (score >= 0) out.push({ title: c.title, keys: c.keys.filter((k) => k !== 'esc')[0], run: () => runCommand(c), score: score + (c.names.includes(lq) ? 0 : 0) });
  }
  if (lq) {
    for (const ch of ui.chats) { const s = fuzzy(lq, ch.questions[0]?.body || ''); if (s >= 0) out.push({ title: 'Chat ' + chatNo(ch.id) + ': ' + truncate(ch.questions[0]?.body, 70), score: s * 0.3, run: () => setActive(ch.id) }); }
    for (const c of activeCards()) { const s = fuzzy(lq, c.title || ''); if (s >= 0) out.push({ title: 'Card: ' + (c.title || 'Untitled card'), score: s * 0.3, run: () => setCurrent(c.id) }); }
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 40);
}
function renderPalette() {
  pal.items = paletteItems(els.paletteInput.value);
  pal.idx = Math.min(pal.idx, Math.max(0, pal.items.length - 1));
  els.paletteList.replaceChildren(...(pal.items.length ? pal.items.map((it, i) => h('li', { role: 'option', id: 'pal-' + i, 'aria-selected': String(i === pal.idx), class: 'pal-item' + (i === pal.idx ? ' on' : ''), onmousedown: (ev) => { ev.preventDefault(); runPaletteItem(i); } },
    h('span', { class: 'pi-title', text: it.title }), it.sub ? h('span', { class: 'pi-sub muted', text: it.sub }) : null, it.keys ? h('kbd', { text: prettyKeys(it.keys) }) : null))
    : [h('li', { class: 'pal-empty muted', text: 'Nothing matches' })]));
  els.paletteInput.setAttribute('aria-activedescendant', pal.items.length ? 'pal-' + pal.idx : '');
  els.paletteList.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
function runPaletteItem(i) {
  const it = pal.items[i];
  closePalette();
  if (it) requestAnimationFrame(() => it.run());
}
els.paletteInput.addEventListener('input', () => { pal.idx = 0; renderPalette(); });
els.paletteInput.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  const name = keyName(e);
  if (name === 'down' || name === 'ctrl+n') { e.preventDefault(); pal.idx = Math.min(pal.items.length - 1, pal.idx + 1); renderPalette(); }
  else if (name === 'up' || name === 'ctrl+p') { e.preventDefault(); pal.idx = Math.max(0, pal.idx - 1); renderPalette(); }
  else if (name === 'enter') { e.preventDefault(); runPaletteItem(pal.idx); }
  else if (name === 'esc') { e.preventDefault(); closePalette(); }
});
els.paletteScrim.addEventListener('click', closePalette);

/* ---- shortcuts dialog, generated from the registry */

function buildKeys() {
  const q = els.keysFilter.value.trim().toLowerCase();
  const groups = new Map();
  const add = (g, title, keys, note) => {
    const text = (title + ' ' + keys.join(' ')).toLowerCase();
    if (q && !text.includes(q)) return;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ title, keys, note });
  };
  for (const c of COMMANDS) {
    if (c.hidden && c.id !== 'palette') continue;
    const keys = c.keys.filter((k) => k !== 'esc');
    if (!keys.length && !c.names.length && !c.slash) continue;
    add(c.group, c.title, keys.length ? keys : [c.slash ? '/' + c.slash : ':' + c.names[0]]);
  }
  for (const d of DOCS) add(d.group, d.title, d.keys, d.note);
  const order = ['Move', 'Chats', 'Write', 'Cards', 'View', 'Line editing', 'History', 'Commands'];
  els.keysBody.replaceChildren(...order.filter((g) => groups.has(g)).map((g) => h('section', { class: 'keys-group' },
    h('h3', { text: g }),
    ...groups.get(g).map((r) => h('div', { class: 'keys-row' },
      h('span', { class: 'kr-title' }, r.title, r.note ? h('span', { class: 'kr-note muted', text: ' ' + r.note }) : null),
      h('span', { class: 'kr-keys' }, r.keys.map((k) => h('kbd', { text: prettyKeys(k) }))))))));
  if (!groups.size) els.keysBody.replaceChildren(h('p', { class: 'muted', text: 'No shortcut matches.' }));
}
els.keysFilter.addEventListener('input', buildKeys);
els.keysScrim.addEventListener('click', () => { ui.pop = null; schedule(); });
els.keysClose.addEventListener('click', () => { ui.pop = null; schedule(); });
els.keysDialog.addEventListener('keydown', (e) => trapTab(e, els.keysDialog));

function trapTab(e, dialog) {
  if (e.key !== 'Tab') return;
  const f = [...dialog.querySelectorAll('button, input, select, textarea, [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.offsetParent !== null);
  if (!f.length) { e.preventDefault(); return; }
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}


/* ------------------------------------------ mode tiles and layout previews */

const previewHost = createPreviewHost();
const hoverNone = matchMedia('(hover: none)');
const modeList = () => (HAS_FLOW ? ['fit', 'strip', 'flow'] : ['fit', 'strip']);

function buildModeTiles() {
  els.modeTiles.replaceChildren(...modeList().map((m) => {
    const g = h('span', { class: 'mt-glyph' });
    g.innerHTML = glyph(m);
    const b = h('button', { class: 'mode-tile', type: 'button', role: 'radio', 'data-mode': m, 'aria-checked': 'false', tabindex: '-1' },
      g, h('span', { class: 'mt-text' }, h('span', { class: 'mt-name', text: MODES[m].name }), h('span', { class: 'mt-line', text: MODES[m].line })));
    b.addEventListener('click', () => setView(m));
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') previewHost.showSoon(b, m, 250, 'above'); });
    b.addEventListener('pointerleave', () => previewHost.hide());
    b.addEventListener('focus', () => { if (b.matches(':focus-visible')) previewHost.showSoon(b, m, 0, 'above'); });
    b.addEventListener('blur', () => previewHost.hide());
    b.addEventListener('keydown', (e) => {
      const i = modeList().indexOf(m);
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = modeList()[(i + d + modeList().length) % modeList().length];
      setView(next);
      requestAnimationFrame(() => els.modeTiles.querySelector(`[data-mode="${next}"]`)?.focus());
    });
    return b;
  }));
}

function updateModeTiles() {
  for (const b of els.modeTiles.children) {
    const on = b.dataset.mode === ui.view;
    setAttr(b, 'aria-checked', String(on));
    setAttr(b, 'tabindex', on ? '0' : '-1');
  }
  // no hover on touch screens: show the chosen layout's preview inline
  const inline = hoverNone.matches && !els.modePick.hidden;
  setHidden(els.modeInline, !inline);
  if (inline && els.modeInline._m !== ui.view) { els.modeInline._m = ui.view; mountInline(els.modeInline, ui.view); }
}

buildModeTiles();

// the header control shows the same previews (and has no native tooltips)
for (const b of els.viewSeg.querySelectorAll('[data-view]')) {
  const m = b.dataset.view;
  delete b.dataset.tip;
  const g = document.createElement('span');
  g.className = 'seg-ic';
  g.innerHTML = glyph(m);
  const label = document.createElement('span');
  label.className = 'seg-label';
  label.textContent = b.textContent;
  b.replaceChildren(g, label);
  b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') previewHost.showSoon(b, m, 500, 'below'); });
  b.addEventListener('pointerleave', () => previewHost.hide());
  b.addEventListener('pointerdown', () => previewHost.hide());
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && previewHost.isOpen) previewHost.hide(); }, true);

// the sidebar badge opens Settings at the Model section
els.provider.addEventListener('click', () => {
  openSettings();
  requestAnimationFrame(() => requestAnimationFrame(() => $('model-sec')?.scrollIntoView({ block: 'start' })));
});

/* ------------------------------------------------------------------- boot */

render();
connect();
