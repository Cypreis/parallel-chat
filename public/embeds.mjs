// Draws the diagrams, charts and SVG that card Markdown leaves as placeholders
// (<div class="embed" data-kind data-src>, see lib.mjs).
//
// - mermaid: Mermaid, strict security level (no scripts, no clicks, labels sanitized)
// - chart:   a Vega-Lite JSON spec through vega-embed; external data loading is
//            refused, so a chart can only show the values written into it
// - svg:     DOMPurify's SVG profile, so no script or event handler survives
//
// The libraries are large (Mermaid alone is ~5 MB), so each is loaded the first
// time a card needs it. Card bodies are re-rendered on every streamed token:
// a drawing is made once per source and the same element is moved into the new
// placeholder, so nothing flickers or redraws.

const done = new Map(); // kind \0 source -> Promise<Element>
const scripts = new Map();
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); reject(new Error('the drawing library could not be loaded (run npm install in the app folder)')); };
      document.head.append(s);
    }));
  }
  return scripts.get(src);
}

let mermaidReady = null;
function getMermaid() {
  mermaidReady ||= loadScript('/vendor/mermaid/mermaid.min.js').then(() => {
    globalThis.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark() ? 'dark' : 'neutral',
      fontFamily: getComputedStyle(document.body).fontFamily,
    });
    return globalThis.mermaid;
  });
  return mermaidReady;
}

let vegaReady = null;
function getVegaEmbed() {
  vegaReady ||= loadScript('/vendor/vega/vega.min.js')
    .then(() => loadScript('/vendor/vega-lite/vega-lite.min.js'))
    .then(() => loadScript('/vendor/vega-embed/vega-embed.min.js'))
    .then(() => globalThis.vegaEmbed);
  return vegaReady;
}

const getPurify = () => loadScript('/vendor/dompurify/purify.min.js').then(() => globalThis.DOMPurify);

// Mermaid keeps global state while it renders: one at a time.
let mermaidQueue = Promise.resolve();
let seq = 0;

async function drawMermaid(src) {
  const mermaid = await getMermaid();
  const run = mermaidQueue.then(async () => {
    const id = 'mmd-' + ++seq;
    try {
      const { svg } = await mermaid.render(id, src);
      const box = document.createElement('div');
      box.className = 'embed-mermaid';
      box.innerHTML = svg; // produced by Mermaid in strict mode
      return box;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById('d' + id)?.remove(); // the error box Mermaid leaves behind
    }
  });
  mermaidQueue = run.catch(() => {});
  return run;
}

async function drawChart(src, width) {
  let spec;
  try {
    spec = JSON.parse(src);
  } catch (e) {
    throw new Error('the chart spec is not valid JSON (' + e.message + ')');
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('the chart spec must be a JSON object');
  const vegaEmbed = await getVegaEmbed();
  const loader = globalThis.vega.loader();
  const refuse = async () => { throw new Error('charts cannot load external data; put the values in the spec'); };
  loader.load = refuse;
  loader.sanitize = refuse;
  if (spec.width === undefined || spec.width === 'container') spec.width = Math.max(200, Math.round(width - 40));
  const box = document.createElement('div');
  box.className = 'embed-chart';
  await vegaEmbed(box, spec, {
    actions: false,
    renderer: 'svg',
    loader,
    theme: dark() ? 'dark' : undefined,
    config: { background: null, font: getComputedStyle(document.body).fontFamily },
  });
  return box;
}

async function drawSvg(src) {
  const purify = await getPurify();
  const frag = purify.sanitize(src, { USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM_FRAGMENT: true });
  if (!frag.querySelector('svg')) throw new Error('there is no <svg> element to show');
  const box = document.createElement('div');
  box.className = 'embed-svg';
  box.append(frag);
  return box;
}

function failure(kind, src, err) {
  const box = document.createElement('div');
  box.className = 'embed-fail';
  const note = document.createElement('p');
  note.className = 'embed-err';
  note.textContent = 'Could not draw this ' + ({ mermaid: 'diagram', chart: 'chart', svg: 'drawing' }[kind] || 'item') + ': ' + String(err?.message || err).split('\n')[0];
  const pre = document.createElement('pre');
  pre.className = 'code';
  const code = document.createElement('code');
  code.textContent = src;
  pre.append(code);
  box.append(note, pre);
  return box;
}

function draw(kind, src, width) {
  const key = kind + '\u0000' + src;
  if (!done.has(key)) {
    const p = kind === 'mermaid' ? drawMermaid(src) : kind === 'chart' ? drawChart(src, width) : kind === 'svg' ? drawSvg(src) : Promise.reject(new Error('unknown kind'));
    done.set(key, p.catch((err) => failure(kind, src, err)));
    if (done.size > 300) done.delete(done.keys().next().value);
  }
  return done.get(key);
}

function place(ph, node) {
  // One drawing, one place: a second copy of the same source gets a clone.
  const el = node.isConnected && !ph.contains(node) ? node.cloneNode(true) : node;
  ph.replaceChildren(el);
  ph.classList.add('ready');
}

// Fill every placeholder under root. Cheap to call after each render.
export function hydrateEmbeds(root) {
  const phs = root.querySelectorAll('.embed[data-src]:not([data-on])');
  for (const ph of phs) {
    ph.dataset.on = '1';
    const kind = ph.dataset.kind;
    const src = ph.dataset.src;
    draw(kind, src, ph.clientWidth || root.clientWidth || 400).then((node) => {
      if (ph.isConnected) place(ph, node);
    });
  }
}
