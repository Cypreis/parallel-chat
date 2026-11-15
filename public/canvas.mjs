// Sideways scrolling for the Flow canvas and the Strip: wheel, trackpad, drag, edge fades.
// No app state in here; app.js hands it a scroller element.

const LINE = 16;

function overflowOf(el, axis) {
  const cs = getComputedStyle(el);
  return axis === 'x' ? cs.overflowX : cs.overflowY;
}

// Can `el` still scroll along `axis` in the direction of `delta`?
function canScroll(el, axis, delta) {
  const o = overflowOf(el, axis);
  if (o !== 'auto' && o !== 'scroll') return false;
  if (axis === 'x') {
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    return delta < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  return delta < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

function scrollableAncestor(target, root, axis, delta) {
  for (let el = target instanceof Element ? target : target?.parentElement; el && el !== root; el = el.parentElement) {
    if (canScroll(el, axis, delta)) return el;
  }
  return null;
}

export function installCanvas(row, { onManual } = {}) {
  if (row._canvas) return;
  row._canvas = true;

  let target = null; // eased target for notched wheels
  let raf = 0;
  let lastWheel = 0;
  let chainBlock = false; // a card was scrolling vertically: do not hand off to the board at once

  const maxLeft = () => Math.max(0, row.scrollWidth - row.clientWidth);
  const clamp = (x) => Math.max(0, Math.min(maxLeft(), x));

  const stopEase = () => { cancelAnimationFrame(raf); raf = 0; target = null; };
  const cancelAuto = () => {
    // a manual gesture wins over any running smooth auto-scroll
    if (row._autoScrolling) { row.scrollTo({ left: row.scrollLeft, behavior: 'instant' }); row._autoScrolling = false; }
    onManual?.();
  };

  function ease() {
    raf = 0;
    if (target == null) return;
    const d = target - row.scrollLeft;
    if (Math.abs(d) < 0.6) { row.scrollLeft = target; target = null; return; }
    row.scrollLeft += d * 0.22;
    raf = requestAnimationFrame(ease);
  }

  let freeT = 0;
  const markFree = () => {
    // scroll-snap would swallow small programmatic moves: suspend it while the person is scrolling
    row.classList.add('scrolling-free');
    clearTimeout(freeT);
    freeT = setTimeout(() => { row.classList.remove('scrolling-free'); row._settle?.(); }, 170);
  };
  function moveBoard(dx, notched) {
    cancelAuto();
    markFree();
    if (notched) {
      target = clamp((target ?? row.scrollLeft) + dx);
      if (!raf) raf = requestAnimationFrame(ease);
    } else {
      stopEase();
      row.scrollLeft = clamp(row.scrollLeft + dx);
    }
  }

  row.addEventListener('wheel', (e) => {
    if (e.ctrlKey || e.metaKey) return;
    if (maxLeft() <= 0) return; // nothing to scroll sideways (Fit)
    const k = e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? row.clientWidth : 1;
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (e.shiftKey && dx === 0) { dx = dy; dy = 0; } // Shift+wheel is horizontal
    if (dx === 0 && dy === 0) return;
    const now = performance.now();
    const notched = e.deltaMode === 1 || (Math.abs(e.deltaY || e.deltaX) >= 50 && Number.isInteger(e.deltaY || e.deltaX));

    if (Math.abs(dx) > Math.abs(dy)) {
      // horizontal intent: a code block or table that can still move wins
      if (scrollableAncestor(e.target, row, 'x', dx)) { lastWheel = now; return; }
      e.preventDefault();
      moveBoard(dx, notched);
      lastWheel = now;
      return;
    }

    // vertical intent: a card that can still scroll gets the event first
    if (scrollableAncestor(e.target, row, 'y', dy)) {
      chainBlock = true;
      lastWheel = now;
      return;
    }
    if (chainBlock && now - lastWheel < 250) { e.preventDefault(); lastWheel = now; return; }
    chainBlock = false;
    e.preventDefault();
    moveBoard(dy, notched);
    lastWheel = now;
  }, { passive: false });

  // drag on the empty background pans the board
  let drag = null;
  row.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if (e.target !== row && !e.target.classList?.contains('flow-sizer')) return;
    drag = { x: e.clientX, left: row.scrollLeft, moved: false, id: e.pointerId };
  });
  row.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 4) return;
      drag.moved = true;
      row.setPointerCapture(e.pointerId);
      row.classList.add('panning');
      cancelAuto();
      stopEase();
    }
    markFree();
    row.scrollLeft = clamp(drag.left - dx);
    e.preventDefault();
  });
  const end = (e) => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    if (drag.moved) { try { row.releasePointerCapture(drag.id); } catch { /* already released */ } }
    row.classList.remove('panning');
    drag = null;
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', end);
  row.addEventListener('selectstart', (e) => { if (drag?.moved) e.preventDefault(); });

  // edge fades: only where there is more to see
  const fades = () => {
    const l = row.scrollLeft > 2 ? '28px' : '0px';
    const r = row.scrollLeft < maxLeft() - 2 ? '28px' : '0px';
    if (row.style.getPropertyValue('--fl') !== l) row.style.setProperty('--fl', l);
    if (row.style.getPropertyValue('--fr') !== r) row.style.setProperty('--fr', r);
  };
  row.addEventListener('scroll', fades, { passive: true });
  row._edges = fades;
}

export function refreshEdges(row) {
  row?._edges?.();
}

export function scrollHome(row, end = false) {
  if (!row) return;
  row._autoScrolling = true;
  row.scrollTo({ left: end ? row.scrollWidth : 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}
