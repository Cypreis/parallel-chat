// Pure helpers for the command registry, key handling, shell-style line editing and history.
// No app state in here; app.js owns the registry entries and what they run.

const NAMED = { ' ': 'space', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Escape: 'esc', Enter: 'enter', Backspace: 'backspace', Tab: 'tab', Delete: 'delete', Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown' };

// A key event as a short name: "h", "G", "ctrl+d", "shift+space", "alt+1", "ctrl+shift+p".
export function keyName(e) {
  let key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return '';
  if ((e.altKey) && /^Digit\d$/.test(e.code || '')) key = e.code.slice(5); // Alt+digit types other characters on some layouts
  const named = NAMED[key];
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  if (named) {
    if (e.shiftKey) mods.push('shift');
    return [...mods, named].join('+');
  }
  if (mods.length) {
    if (e.shiftKey) mods.push('shift');
    return [...mods, key.toLowerCase()].join('+');
  }
  return key; // printable: shift is already in the character (G, ?, :, +)
}

export function prettyKeys(spec) {
  return spec.split(' ').map((k) => k.split('+').map((p) => ({ ctrl: 'Ctrl', alt: 'Alt', meta: 'Cmd', shift: 'Shift', space: 'Space', esc: 'Esc', enter: 'Enter', left: '←', right: '→', up: '↑', down: '↓', backspace: 'Backspace', home: 'Home', end: 'End', tab: 'Tab' }[p] || p)).join('+')).join(' ');
}

// Fuzzy match: every query character appears in order. Higher is better; -1 for no match.
export function fuzzy(query, text) {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at * 2 - (t.length - q.length) * 0.1 + (at === 0 ? 200 : 0);
  let ti = 0, score = 0, last = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    score += i === last + 1 ? 8 : 1;
    last = i;
    ti = i + 1;
  }
  return score;
}

// Two-key sequences ("g g"): feed keys in, get 'pending', 'done' or 'none'.
export function createSequencer(table, { timeout = 800, onPending } = {}) {
  const prefixes = new Set();
  for (const seq of table.keys()) {
    const parts = seq.split(' ');
    if (parts.length > 1) prefixes.add(parts[0]);
  }
  let pending = '';
  let timer = 0;
  const clear = () => { clearTimeout(timer); pending = ''; onPending?.(''); };
  return {
    feed(name) {
      if (pending) {
        const seq = pending + ' ' + name;
        clear();
        if (table.has(seq)) return { kind: 'done', value: table.get(seq) };
        // fall through: this key may be a command of its own
      }
      if (prefixes.has(name)) {
        pending = name;
        onPending?.(name);
        timer = setTimeout(clear, timeout);
        return { kind: 'pending' };
      }
      return { kind: 'none' };
    },
    clear,
    get pending() { return pending; },
  };
}

/* ---- shell-style line editing for text boxes; edits go through execCommand so native undo keeps working */

function lineBounds(ta) {
  const v = ta.value, pos = ta.selectionStart;
  const start = v.lastIndexOf('\n', pos - 1) + 1;
  let end = v.indexOf('\n', pos);
  if (end < 0) end = v.length;
  return { start, end, pos };
}

function wordStartBefore(v, pos) {
  let i = pos;
  while (i > 0 && /\s/.test(v[i - 1])) i--;
  while (i > 0 && !/\s/.test(v[i - 1])) i--;
  return i;
}
function wordEndAfter(v, pos) {
  let i = pos;
  while (i < v.length && /\s/.test(v[i])) i++;
  while (i < v.length && !/\s/.test(v[i])) i++;
  return i;
}

function deleteRange(ta, a, b) {
  if (a >= b) return;
  ta.setSelectionRange(a, b);
  if (!document.execCommand('delete')) {
    ta.setRangeText('', a, b, 'start');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Returns true when the key was handled.
export function lineEdit(ta, name) {
  const v = ta.value;
  const { start, end, pos } = lineBounds(ta);
  switch (name) {
    case 'ctrl+a': ta.setSelectionRange(start, start); return true;
    case 'ctrl+e': ta.setSelectionRange(end, end); return true;
    case 'ctrl+u': deleteRange(ta, start, ta.selectionStart); return true;
    case 'ctrl+k': deleteRange(ta, ta.selectionStart, end); return true;
    case 'alt+b': { const i = wordStartBefore(v, pos); ta.setSelectionRange(i, i); return true; }
    case 'alt+f': { const i = wordEndAfter(v, pos); ta.setSelectionRange(i, i); return true; }
    case 'alt+backspace': case 'ctrl+backspace':
      if (ta.selectionStart !== ta.selectionEnd) return false;
      deleteRange(ta, wordStartBefore(v, pos), pos);
      return true;
    case 'alt+d': deleteRange(ta, pos, wordEndAfter(v, pos)); return true;
    case 'ctrl+j': if (!document.execCommand('insertText', false, '\n')) { ta.setRangeText('\n', pos, pos, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); } return true;
    case 'ctrl+d':
      if (!v) { ta.blur(); return true; } // EOF: leave the box
      if (!document.execCommand('forwardDelete')) { ta.setRangeText('', pos, Math.min(v.length, pos + 1), 'start'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      return true;
    default: return false;
  }
}

export const onFirstLine = (ta) => ta.value.lastIndexOf('\n', ta.selectionStart - 1) < 0;
export const onLastLine = (ta) => ta.value.indexOf('\n', ta.selectionEnd) < 0;

/* ---- question history, newest last, kept in localStorage */

export function createHistory(key = 'pc.history', max = 100) {
  let items = [];
  try { const raw = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(raw)) items = raw.filter((x) => typeof x === 'string').slice(-max); } catch { /* storage unavailable */ }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(items)); } catch { /* storage unavailable */ } };
  let idx = -1; // -1 = the draft
  let draft = '';
  return {
    get items() { return items; },
    push(text) {
      text = String(text).trim();
      if (!text) return;
      if (items[items.length - 1] !== text) items.push(text);
      if (items.length > max) items = items.slice(-max);
      idx = -1; draft = '';
      save();
    },
    prev(current) {
      if (!items.length) return null;
      if (idx === -1) draft = current;
      if (idx >= items.length - 1) return items[0];
      idx++;
      return items[items.length - 1 - idx];
    },
    next() {
      if (idx === -1) return null;
      idx--;
      return idx === -1 ? draft : items[items.length - 1 - idx];
    },
    reset() { idx = -1; draft = ''; },
    // reverse search: the nth most recent entry containing `term` (n starts at 0)
    search(term, n = 0) {
      if (!term) return null;
      const t = term.toLowerCase();
      let seen = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].toLowerCase().includes(t)) { if (seen === n) return { text: items[i], n }; seen++; }
      }
      return null;
    },
  };
}
