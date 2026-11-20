// Pure helpers: no DOM, no Node APIs. Runs in the browser and under Node for checks.

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Emphasis on text that is already HTML-escaped. Unclosed markers stay literal.
function emphasis(s) {
  s = s.replace(/\*\*([^\s*](?:[^\n]*?[^\s])?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__([^\s_](?:[^\n]*?[^\s])?)__(?![\w])/g, '$1<strong>$2</strong>');
  s = s.replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^\s_](?:[^_\n]*?[^\s_])?)_(?![\w_])/g, '$1<em>$2</em>');
  return s;
}

// ---------- math ----------
// LaTeX through KaTeX when the page has loaded it (globalThis.katex), else the
// source in a styled span. Rendered HTML is cached: a streaming card re-renders
// the same formulas many times.

const texCache = new Map();
export function renderTex(src, display) {
  const tex = String(src).trim();
  if (!tex) return '';
  const key = (display ? 'D' : 'I') + tex;
  const hit = texCache.get(key);
  if (hit) return hit;
  const k = globalThis.katex;
  let html = null;
  if (k && typeof k.renderToString === 'function') {
    try {
      html = k.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false });
    } catch {
      html = null;
    }
  }
  if (html === null) html = '<code class="math-src">' + escapeHtml(tex) + '</code>';
  html = display ? '<span class="math-display">' + html + '</span>' : '<span class="math-inline">' + html + '</span>';
  if (k) {
    if (texCache.size > 600) texCache.delete(texCache.keys().next().value);
    texCache.set(key, html);
  }
  return html;
}

// Math spans in raw (unescaped) text, replaced by placeholders from put().
// $$…$$ and \[…\] are display; \(…\) and $…$ inline. A single $ counts only
// when it hugs its content ($x$, not "$5 and $10") and the closing one is not
// followed by a digit, so prices stay text. \$ is a literal dollar sign.
function mathSpans(s, put) {
  s = s.replace(/\\\$/g, () => put('$'));
  s = s.replace(/\$\$([^$]+?)\$\$/g, (_, t) => put(renderTex(t, true)));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => put(renderTex(t, true)));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => put(renderTex(t, false)));
  s = s.replace(/\$(?![\s$])([^$\n]*?[^\s\\$])\$(?!\d)|\$([^\s$\\])\$(?!\d)/g, (_, a, b) => put(renderTex(a ?? b, false)));
  // A display formula still being written: its source, quietly, not as stray text.
  s = s.replace(/(\$\$|\\\[)([^$]*)$/, (_, d, t) => put('<code class="math-src pending">' + escapeHtml(d + t) + '</code>'));
  return s;
}

function inline(raw) {
  const stash = [];
  const put = (html) => {
    stash.push(html);
    return '\u0001' + (stash.length - 1) + '\u0002';
  };
  // Code and math come out before escaping (their content is escaped or
  // rendered on its own); after that, everything only adds tags we write ourselves.
  let s = String(raw).replace(/[\u0001\u0002]/g, '');
  s = s.replace(/`([^`\n]+)`/g, (_, c) => put('<code>' + escapeHtml(c) + '</code>'));
  s = mathSpans(s, put);
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) =>
    put('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + emphasis(label) + '</a>'));
  s = emphasis(s);
  for (let i = 0; i < 4 && s.includes('\u0001'); i++) {
    s = s.replace(/\u0001(\d+)\u0002/g, (_, n) => stash[+n] ?? '');
  }
  return s;
}

const COPY_BTN = '<button type="button" class="copy-code" aria-label="Copy code" data-tip="Copy code"><svg class="i-copy" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"/></svg><svg class="i-ok" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></button>';

export function renderMarkdown(src) {
  try {
    return renderBlocks(String(src ?? ''));
  } catch (e) {
    return '<p>' + escapeHtml(String(src ?? '')) + '</p>';
  }
}

// A display formula as its own block. While it is still streaming (no closing
// delimiter yet) the source shows quietly instead of half-rendered.
function mathBlock(tex, closed) {
  if (!closed) return '<div class="math-block pending"><code class="math-src">' + escapeHtml(String(tex).trim()) + '</code></div>';
  return '<div class="math-block">' + renderTex(tex, true) + '</div>';
}

const isTableSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && l.includes('-') && l.includes('|');

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (const ch of t) {
    if (ch === '|' && !cur.endsWith('\\')) { cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  cells.push(cur.trim());
  return cells.map((c) => c.replace(/\\\|/g, '|'));
}

function renderBlocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { type, start, items: [{ text: [], sub }], blank }
  let quote = [];

  const flushPara = () => {
    if (para.length) out.push('<p>' + inline(para.join(' ')) + '</p>');
    para = [];
  };
  const flushList = () => {
    if (list) {
      const attr = list.type === 'ol' && list.start > 1 ? ' start="' + list.start + '"' : '';
      out.push('<' + list.type + attr + '>' +
        list.items.map((it) => '<li' + (it.sub ? ' class="sub"' : '') + '>' + inline(it.text.join(' ')) + '</li>').join('') +
        '</' + list.type + '>');
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push('<blockquote><p>' + inline(quote.join(' ')) + '</p></blockquote>');
    quote = [];
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;

    if ((m = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line))) {
      flushAll();
      const fence = m[1];
      const closeRe = new RegExp('^\\s{0,3}' + fence[0] + '{' + fence.length + ',}\\s*$');
      const code = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (closeRe.test(lines[i])) { closed = true; break; }
        code.push(lines[i]);
      }
      if (/^(math|latex|tex|katex)$/i.test(m[2])) out.push(mathBlock(code.join('\n'), closed));
      else out.push('<div class="code-wrap"><pre class="code' + (closed ? '' : ' open') + '"><code>' + escapeHtml(code.join('\n')) + '</code></pre>' + COPY_BTN + '</div>');
      continue;
    }

    // Display math on lines of its own: $$ … $$ or \[ … \], on one line or several.
    if ((m = /^\s{0,3}(\$\$|\\\[)(.*)$/.exec(line))) {
      const close = m[1] === '$$' ? '$$' : '\\]';
      const rest = m[2];
      const at = rest.indexOf(close);
      if (at >= 0 && !rest.slice(at + close.length).trim()) {
        flushAll();
        out.push(mathBlock(rest.slice(0, at), true));
        continue;
      }
      if (at < 0) {
        flushAll();
        const tex = [rest];
        let closed = false;
        let after = '';
        for (i++; i < lines.length; i++) {
          const j = lines[i].indexOf(close);
          if (j >= 0) { tex.push(lines[i].slice(0, j)); after = lines[i].slice(j + close.length).trim(); closed = true; break; }
          tex.push(lines[i]);
        }
        out.push(mathBlock(tex.join('\n'), closed));
        if (after) para.push(after);
        continue;
      }
      // "$$x$$ and more text" on one line: the paragraph's inline pass handles it
    }

    if (/^\s*$/.test(line)) {
      flushPara();
      flushQuote();
      if (list) list.blank = true;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line);
      const seps = splitRow(lines[i + 1]);
      if (head.length === seps.length) {
        flushAll();
        const align = seps.map((c) => (/^:-+:$/.test(c) ? 'c' : /-:$/.test(c) ? 'r' : ''));
        const cell = (tag, c, k) => '<' + tag + (align[k] ? ' class="al-' + align[k] + '"' : '') + '>' + inline(c) + '</' + tag + '>';
        const rows = [];
        i += 2;
        for (; i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i]); i++) {
          const cells = splitRow(lines[i]);
          rows.push('<tr>' + head.map((_, k) => cell('td', cells[k] ?? '', k)).join('') + '</tr>');
        }
        i--;
        out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
        continue;
      }
    }

    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)) && m[2]) {
      flushAll();
      const lvl = Math.min(6, m[1].length + 2);
      out.push('<h' + lvl + '>' + inline(m[2]) + '</h' + lvl + '>');
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      out.push('<hr>');
      continue;
    }

    if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      flushPara(); flushList();
      quote.push(m[1]);
      continue;
    }

    let lm = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    let type = 'ul';
    let start = 1;
    if (!lm) {
      lm = /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line);
      if (lm) { type = 'ol'; start = parseInt(lm[2], 10); }
    }
    if (lm) {
      flushPara(); flushQuote();
      const sub = lm[1].replace(/\t/g, '  ').length >= 2;
      if (list && list.type !== type && !sub) flushList();
      if (!list) list = { type, start, items: [], blank: false };
      list.blank = false;
      list.items.push({ text: [lm[3]], sub });
      continue;
    }

    if (list && !list.blank && /^\s+\S/.test(line)) {
      list.items[list.items.length - 1].text.push(line.trim());
      continue;
    }

    flushList(); flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

// A quoted passage as plain text: Markdown and table syntax stripped.
export function plainQuote(s) {
  return String(s ?? '').replace(/[|`#*_>~]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, Math.max(0, n - 1)).trimEnd() + '…' : s;
}

// Short text for a pinned decision: the first sentence of a reply, without markdown noise.
export function firstSentence(text, max = 160) {
  let s = String(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*`]/g, '')
    .trim();
  s = (s.split(/\n\s*\n/)[0] || '').replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(?=\s|$)/.exec(s);
  if (m) s = m[1];
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    s = (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
  }
  return s;
}

export const EDGE_VERB = { depends_on: 'depends on', feeds: 'feeds', contradicts: 'contradicts', alternative_to: 'alternative to', elaborates: 'elaborates' };
const IN = { depends_on: 'needed by', feeds: 'fed by', contradicts: 'contradicts', alternative_to: 'alternative to', elaborates: 'elaborated by' };

// Phrase an edge from one card's side. Returns { otherId, verb }.
export function edgePhrase(edge, cardId) {
  const outgoing = edge.from === cardId;
  const table = outgoing ? EDGE_VERB : IN;
  return { otherId: outgoing ? edge.to : edge.from, verb: table[edge.rel] || String(edge.rel).replace(/_/g, ' ') };
}

export function formatChars(n) {
  n = Number(n) || 0;
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k chars' : n + ' chars';
}

export const STATUS_LABEL = {
  streaming: 'Streaming',
  settled: 'Settled',
  stale: 'Stale',
  error: 'Error',
  cancelled: 'Stopped',
};
