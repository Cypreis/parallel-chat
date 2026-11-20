// The saved-cards board: every card the person saved, on a free whiteboard.
//
// - Cards can be dragged anywhere; where they sit is saved (PATCH /api/saved/:id).
//   A card never moved is placed automatically, in a block per chat group.
// - Cards saved from the same question are joined by a thin dashed line; a card
//   and one of its sub-cards (an elaborates link, or a follow-up card made from
//   it) are joined by a thick solid one.
// - Each card has a small button that shows or hides its follow-ups (shown by default).
// - Chips filter by the chat groups of the sidebar; "All" shows every saved card.
//
// The page gives this module what it needs through `ctx`, so it holds no
// state of its own besides the filter and a drag in progress.

const W = 320; // card width
const GAP = 22;
const LANES = 3; // columns per group block
const PAD = 28;
const HEAD = 44; // height of a group's title

export function createSavedView(ctx) {
  const { root, h, icon, getState, nodeChat, chatNo, renderMarkdown, hydrateEmbeds, api, openCard, onClose, threadOf } = ctx;

  const views = new Map(); // card id -> { el, body, thread, ... }
  const labels = new Map(); // group key -> element
  let filter = 'all';
  let open = false;
  let drag = null; // { id, dx, dy, x, y }
  const local = new Map(); // id -> { x, y } being saved: shown until the server's copy agrees
  const localSize = new Map(); // id -> { w, h } the same, for a resize

  // ---------- skeleton ----------
  const title = h('h2', { class: 'sv-title', text: 'Saved cards' });
  const chips = h('div', { class: 'sv-chips', role: 'radiogroup', 'aria-label': 'Group' });
  const legend = h('span', { class: 'sv-legend muted' },
    h('i', { class: 'sv-key weak' }), ' same question ', h('i', { class: 'sv-key strong' }), ' sub-card');
  const closeBtn = h('button', { class: 'btn small', type: 'button', text: 'Close', onclick: () => onClose() });
  const newFolderBtn = h('button', { class: 'btn small', type: 'button', text: '+ Folder', title: 'Make a folder for saved cards', onclick: () => ctx.newFolder(newFolderBtn) });
  const folderMore = h('button', { class: 'btn small', type: 'button', text: 'Folder\u2026', hidden: true, title: 'Rename or delete this folder', onclick: () => ctx.folderMenu(folderMore, filter) });
  const bar = h('div', { class: 'sv-bar' }, title, chips, newFolderBtn, folderMore, legend, closeBtn);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'sv-links');
  svg.setAttribute('aria-hidden', 'true');
  const canvas = h('div', { class: 'sv-canvas' }, svg);
  const scroller = h('div', { class: 'sv-scroll' }, canvas);
  const empty = h('div', { class: 'sv-empty', hidden: true },
    h('p', { text: 'Nothing saved here yet.' }),
    h('p', { class: 'muted', text: 'Click the bookmark on a card to keep it. Saved cards appear on this board, where you can move them freely.' }));
  root.replaceChildren(bar, scroller, empty);

  // ---------- data ----------
  const savedIds = (state) => Object.keys(state.saved || {}).filter((id) => state.nodes[id]?.kind === 'card');
  // the folder the person put a card in (null: not in one)
  const groupOf = (state, id) => {
    const f = state.saved[id]?.folderId;
    return f && (state.folders || []).some((x) => x.id === f) ? f : null;
  };
  const posOf = (state, id) => local.get(id) || (state.saved[id]?.x !== undefined ? { x: state.saved[id].x, y: state.saved[id].y } : null);

  function sections(state, ids) {
    const secs = [];
    for (const g of state.folders || []) secs.push({ key: g.id, name: g.name || 'Untitled folder', ids: ids.filter((id) => groupOf(state, id) === g.id) });
    secs.push({ key: 'none', name: (state.folders || []).length ? 'No folder' : 'Saved', ids: ids.filter((id) => !groupOf(state, id)) });
    return secs.filter((s) => s.ids.length);
  }

  // A card's sub-card relation: child -> parent.
  function parentsOf(state, id) {
    const ps = new Set();
    for (const e of state.edges) if (e.rel === 'elaborates' && e.from === id) ps.add(e.to);
    const o = state.nodes[id]?.origin?.cardId;
    if (o && state.nodes[o]?.kind === 'card') ps.add(o);
    return ps;
  }

  // ---------- card views ----------
  function makeView(id) {
    const v = { id, _src: null, _tsrc: null };
    v.chat = h('button', { class: 'sv-chat', type: 'button', title: 'Open this card in its chat', onclick: () => openCard(id) });
    v.follow = h('button', { class: 'qbtn keep sv-follow', type: 'button', 'aria-pressed': 'true', onclick: () => {
      const on = !(getState().saved[id]?.follow !== false);
      api('PATCH', `/api/saved/${encodeURIComponent(id)}`, { follow: on });
    } }, icon('chat'));
    v.move = h('button', { class: 'qbtn keep', type: 'button', title: 'Move to a folder', 'aria-label': 'Move to a folder', onclick: () => ctx.pickFolder(v.move, id) }, icon('folder'));
    v.go = h('button', { class: 'qbtn keep', type: 'button', title: 'Open in its chat', 'aria-label': 'Open in its chat', onclick: () => openCard(id) }, icon('branch'));
    v.unsave = h('button', { class: 'qbtn keep on', type: 'button', title: 'Remove from saved', 'aria-label': 'Remove from saved', onclick: () => api('POST', `/api/cards/${encodeURIComponent(id)}/save`, { saved: false }) }, icon('bookmark'));
    v.head = h('div', { class: 'sv-head' }, icon('grip', 'sv-grip'), v.chat, h('span', { class: 'sv-actions' }, v.follow, v.move, v.go, v.unsave));
    v.ask = h('div', { class: 'sv-ask', hidden: true });
    v.body = h('div', { class: 'md body sv-body' });
    v.thread = h('div', { class: 'sv-thread' });
    v.scroll = h('div', { class: 'sv-card-scroll' }, v.ask, v.body, v.thread);
    v.resize = h('div', { class: 'sv-resize', title: 'Drag to resize · double-click: fit the text', role: 'separator', 'aria-label': 'Resize this card' });
    v.el = h('article', { class: 'sv-card', 'data-id': id }, v.head, v.scroll, v.resize);
    v.head.addEventListener('pointerdown', (e) => startDrag(e, v));
    v.resize.addEventListener('pointerdown', (e) => startResize(e, v));
    v.resize.addEventListener('dblclick', () => api('PATCH', `/api/saved/${encodeURIComponent(id)}`, { h: null }));
    return v;
  }

  function fill(el, key, src, render) {
    if (el[key] === src) return;
    el[key] = src;
    el.innerHTML = render(src);
    if (el.querySelector('.embed[data-src]')) hydrateEmbeds(el);
  }

  function update(v, state) {
    const c = state.nodes[v.id];
    const sv = state.saved[v.id];
    const label = `Chat ${chatNo(nodeChat(v.id))}`;
    if (v.chat.textContent !== label) v.chat.textContent = label;
    applySize(v, sv);
    const follow = sv.follow !== false;
    // A follow-up question shows under its card, unless it was answered in a sub-card that is saved too: that card is on the board itself.
    const msgs = threadOf(state, v.id).filter((m) => ((m.body || '').trim() || m.status === 'streaming') && !(m.answeredBy && state.saved[m.answeredBy]));
    v.follow.hidden = !msgs.length && follow; // nothing to hide yet
    v.follow.setAttribute('aria-pressed', String(follow));
    const tip = follow ? 'Hide the follow-ups on this card' : 'Show the follow-ups on this card';
    if (v.follow.dataset.tip !== tip) { v.follow.dataset.tip = tip; v.follow.setAttribute('aria-label', tip); }
    v.follow.classList.toggle('off', !follow);
    // a card made from a follow-up shows the question that made it
    const q = c.origin?.text || '';
    v.ask.hidden = !q;
    if (v.ask.textContent !== q) v.ask.textContent = q;
    fill(v.body, '_src', c.body || '', renderMarkdown);
    v.thread.hidden = !follow || !msgs.length;
    if (follow && msgs.length) {
      const sig = msgs.map((m) => m.id + ':' + m.role + ':' + (m.body || '').length + ':' + (m.answeredBy || '')).join('|');
      if (v.thread._sig !== sig) {
        v.thread._sig = sig;
        v.thread.replaceChildren(...msgs.map((m) => {
          const d = h('div', { class: 'sv-msg ' + (m.role === 'user' ? 'user' : 'assistant') });
          if (m.role === 'user') {
            d.textContent = m.body || '';
            if (m.answeredBy && state.nodes[m.answeredBy]) d.append(h('span', { class: 'sv-ans', text: 'answered in ' + (state.nodes[m.answeredBy].title || 'a sub-card') }));
          }
          else { d.classList.add('md'); d.innerHTML = renderMarkdown(m.body || ''); if (d.querySelector('.embed[data-src]')) hydrateEmbeds(d); }
          return d;
        }));
      }
    }
  }

  // A card shows at the size it had when saved (its size on the board), or the
  // size the person gave it; without a height it is as tall as its text.
  function sizeOf(id, sv) {
    const l = localSize.get(id);
    return { w: l?.w ?? sv.w ?? W, h: l ? l.h : sv.h };
  }
  function applySize(v, sv) {
    const { w, h: hh } = sizeOf(v.id, sv);
    const ws = w + 'px';
    if (v.el.style.width !== ws) v.el.style.width = ws;
    const hs = hh ? hh + 'px' : '';
    if (v.el.style.height !== hs) v.el.style.height = hs;
    v.el.style.maxHeight = hh ? 'none' : '';
  }

  // ---------- layout ----------
  function layout(state, shown) {
    // placed cards keep their place; the others are packed in lanes per group block
    const secs = filter === 'all' ? sections(state, shown) : [{ key: filter, name: '', ids: shown }];
    let y = PAD;
    const used = new Set();
    const rects = new Map();
    for (const sec of secs) {
      const labelEl = labels.get(sec.key);
      const showLabel = filter === 'all' && secs.length > 1;
      if (labelEl) { labelEl.hidden = !showLabel; if (showLabel) { labelEl.style.transform = `translate(${PAD}px, ${y}px)`; labelEl.textContent = sec.name; } }
      if (showLabel) y += HEAD;
      const lanes = Array.from({ length: LANES }, () => y);
      const step = Math.max(W, ...sec.ids.map((id) => views.get(id).el.offsetWidth || W)) + GAP;
      for (const id of sec.ids) {
        const v = views.get(id);
        const p = posOf(state, id);
        const w = v.el.offsetWidth || W, hh = v.el.offsetHeight || 200;
        if (p) { rects.set(id, { x: p.x, y: p.y, w, h: hh }); continue; }
        let k = 0;
        for (let i = 1; i < LANES; i++) if (lanes[i] < lanes[k]) k = i;
        const r = { x: PAD + k * step, y: lanes[k], w, h: hh };
        lanes[k] += hh + GAP;
        rects.set(id, r);
        used.add(id);
      }
      y = Math.max(...lanes, y) + GAP;
    }
    return rects;
  }

  function place(rects) {
    let maxX = 0, maxY = 0;
    for (const [id, r] of rects) {
      const v = views.get(id);
      if (!(drag && drag.id === id)) v.el.style.transform = `translate(${r.x}px, ${r.y}px)`;
      maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
    }
    canvas.style.width = Math.max(maxX + PAD * 3, scroller.clientWidth) + 'px';
    canvas.style.height = Math.max(maxY + PAD * 3, scroller.clientHeight) + 'px';
    svg.setAttribute('width', canvas.style.width.replace('px', ''));
    svg.setAttribute('height', canvas.style.height.replace('px', ''));
  }

  // ---------- links ----------
  function links(state, shown, rects) {
    const out = [];
    const set = new Set(shown);
    const strong = new Set();
    for (const id of shown) for (const p of parentsOf(state, id)) if (set.has(p)) { out.push({ a: id, b: p, strong: true }); strong.add(id + '>' + p); strong.add(p + '>' + id); }
    // same question: each saved card to the next one saved from it
    const byQ = new Map();
    for (const id of state.order) {
      if (!set.has(id)) continue;
      const q = state.nodes[id].turnId;
      if (!q) continue;
      if (!byQ.has(q)) byQ.set(q, []);
      byQ.get(q).push(id);
    }
    for (const list of byQ.values()) for (let i = 0; i + 1 < list.length; i++) if (!strong.has(list[i] + '>' + list[i + 1])) out.push({ a: list[i], b: list[i + 1], strong: false });
    const NS = 'http://www.w3.org/2000/svg';
    const paths = [];
    for (const l of out) {
      const A = rects.get(l.a), B = rects.get(l.b);
      if (!A || !B) continue;
      const ax = A.x + A.w / 2, ay = A.y + A.h / 2, bx = B.x + B.w / 2, by = B.y + B.h / 2;
      // leave from the sides that face each other
      const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
      const p1 = horizontal ? [bx > ax ? A.x + A.w : A.x, ay] : [ax, by > ay ? A.y + A.h : A.y];
      const p2 = horizontal ? [bx > ax ? B.x : B.x + B.w, by] : [bx, by > ay ? B.y : B.y + B.h];
      const mid = horizontal ? [(p1[0] + p2[0]) / 2, p1[1], (p1[0] + p2[0]) / 2, p2[1]] : [p1[0], (p1[1] + p2[1]) / 2, p2[0], (p1[1] + p2[1]) / 2];
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M${p1[0]},${p1[1]} C${mid[0]},${mid[1]} ${mid[2]},${mid[3]} ${p2[0]},${p2[1]}`);
      path.setAttribute('class', 'sv-link ' + (l.strong ? 'strong' : 'weak'));
      paths.push(path);
    }
    svg.replaceChildren(...paths);
  }

  // ---------- resize ----------
  function startResize(e, v) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const state = getState();
    const w0 = v.el.offsetWidth, h0 = v.el.offsetHeight, x0 = e.clientX, y0 = e.clientY;
    let size = { w: w0, h: h0 };
    v.resize.setPointerCapture(e.pointerId);
    v.el.classList.add('resizing');
    const move = (ev) => {
      size = { w: Math.max(220, Math.min(1600, Math.round(w0 + ev.clientX - x0))), h: Math.max(140, Math.min(2000, Math.round(h0 + ev.clientY - y0))) };
      localSize.set(v.id, size);
      applySize(v, state.saved[v.id]);
      redraw(state, null);
    };
    const up = () => {
      v.resize.removeEventListener('pointermove', move);
      v.resize.removeEventListener('pointerup', up);
      v.resize.removeEventListener('pointercancel', up);
      v.el.classList.remove('resizing');
      if (localSize.has(v.id)) api('PATCH', `/api/saved/${encodeURIComponent(v.id)}`, { w: size.w, h: size.h });
    };
    v.resize.addEventListener('pointermove', move);
    v.resize.addEventListener('pointerup', up);
    v.resize.addEventListener('pointercancel', up);
  }

  // ---------- drag ----------
  function startDrag(e, v) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const state = getState();
    const r = v.el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    drag = { id: v.id, dx: e.clientX - r.left, dy: e.clientY - r.top, ox: s.left - scroller.scrollLeft, oy: s.top - scroller.scrollTop, moved: false, x: 0, y: 0 };
    v.head.setPointerCapture(e.pointerId);
    v.el.classList.add('dragging');
    for (const o of views.values()) o.el.style.zIndex = '';
    v.el.style.zIndex = '20';
    const move = (ev) => {
      if (!drag) return;
      drag.moved = true;
      drag.x = Math.max(0, Math.round(ev.clientX - drag.ox - drag.dx));
      drag.y = Math.max(0, Math.round(ev.clientY - drag.oy - drag.dy));
      v.el.style.transform = `translate(${drag.x}px, ${drag.y}px)`;
      redraw(state, { id: v.id, x: drag.x, y: drag.y });
    };
    const up = () => {
      v.head.removeEventListener('pointermove', move);
      v.head.removeEventListener('pointerup', up);
      v.head.removeEventListener('pointercancel', up);
      v.el.classList.remove('dragging');
      const d = drag; drag = null;
      if (d?.moved) {
        local.set(d.id, { x: d.x, y: d.y });
        api('PATCH', `/api/saved/${encodeURIComponent(d.id)}`, { x: d.x, y: d.y });
      }
    };
    v.head.addEventListener('pointermove', move);
    v.head.addEventListener('pointerup', up);
    v.head.addEventListener('pointercancel', up);
  }

  function redraw(state, moving) {
    const shown = visible(state);
    const rects = new Map();
    for (const id of shown) {
      const v = views.get(id);
      if (!v) continue;
      const r = moving && moving.id === id ? { x: moving.x, y: moving.y } : (posOf(state, id) || v._auto || { x: 0, y: 0 });
      rects.set(id, { x: r.x, y: r.y, w: v.el.offsetWidth || W, h: v.el.offsetHeight || 200 });
    }
    links(state, shown, rects);
  }

  // ---------- render ----------
  function visible(state) {
    const ids = savedIds(state);
    if (filter === 'all') return ids;
    return ids.filter((id) => (filter === 'none' ? !groupOf(state, id) : groupOf(state, id) === filter));
  }

  function renderChips(state, ids) {
    const items = [{ key: 'all', name: 'All', n: ids.length }];
    for (const g of state.folders || []) items.push({ key: g.id, name: g.name || 'Untitled folder', n: ids.filter((id) => groupOf(state, id) === g.id).length });
    const loose = ids.filter((id) => !groupOf(state, id)).length;
    if ((state.folders || []).length) items.push({ key: 'none', name: 'No folder', n: loose });
    if (!items.some((i) => i.key === filter)) filter = 'all';
    folderMore.hidden = !(state.folders || []).some((f) => f.id === filter);
    chips.replaceChildren(...items.map((i) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(i.key === filter), class: 'sv-chip' + (i.key === filter ? ' on' : ''),
      onclick: () => { filter = i.key; render(); } }, h('span', { text: i.name }), h('span', { class: 'count', text: String(i.n) }))));
  }

  function render() {
    if (!open) return;
    const state = getState();
    const ids = savedIds(state);
    renderChips(state, ids);
    const shown = visible(state);
    const shownSet = new Set(shown);
    for (const id of ids) if (!views.has(id)) { const v = makeView(id); views.set(id, v); }
    for (const [id, v] of views) {
      if (!ids.includes(id)) { v.el.remove(); views.delete(id); local.delete(id); continue; }
      v.el.hidden = !shownSet.has(id);
      if (v.el.parentNode !== canvas) canvas.append(v.el);
    }
    for (const id of shown) update(views.get(id), state);
    for (const g of [...(state.folders || []).map((x) => x.id), 'none', filter]) {
      if (!labels.has(g)) { const l = h('div', { class: 'sv-group', hidden: true }); labels.set(g, l); canvas.append(l); }
    }
    for (const [id, l] of labels) if (filter !== 'all' || !(id === 'none' || (state.folders || []).some((x) => x.id === id))) l.hidden = true;
    for (const [id, p] of local) { const s = state.saved[id]; if (!s || (s.x === p.x && s.y === p.y)) local.delete(id); }
    for (const [id, p] of localSize) { const s = state.saved[id]; if (!s || (s.w === p.w && s.h === p.h)) localSize.delete(id); }
    empty.hidden = shown.length > 0;
    scroller.hidden = shown.length === 0;
    legend.hidden = shown.length < 2;
    title.textContent = `Saved cards · ${ids.length}`;
    empty.firstElementChild.textContent = filter === 'all' ? 'Nothing saved yet.' : 'Nothing in this folder.';
    const rects = layout(state, shown);
    for (const [id, r] of rects) views.get(id)._auto = r;
    place(rects);
    links(state, shown, rects);
  }

  return {
    render,
    get isOpen() { return open; },
    open(f) {
      open = true;
      if (f !== undefined) filter = f;
      root.hidden = false;
      render();
      requestAnimationFrame(render); // heights are known one frame later
    },
    close() { open = false; root.hidden = true; },
    count: () => savedIds(getState()).length,
  };
}
