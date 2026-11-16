// Reading attached files into text, in the browser. Text and code files are
// read as UTF-8; PDFs through pdf.js (loaded from a CDN the first time one is
// attached); Word .docx files by unzipping word/document.xml. Nothing is
// uploaded anywhere but this app's own server.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DOC_CHARS = 2_000_000; // the server's limit for one file

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'log',
  'xml', 'html', 'htm', 'css', 'scss', 'less', 'svg', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift', 'm', 'php', 'pl', 'lua', 'r', 'jl', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'sql', 'graphql', 'gql', 'proto', 'tex', 'bib', 'srt', 'vtt', 'diff', 'patch', 'gitignore', 'dockerfile', 'makefile', 'mk',
]);

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/';

export const extOf = (name) => {
  const base = String(name || '').toLowerCase().split(/[\\/]/).pop();
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1) : base; // "Dockerfile" -> "dockerfile"
};

export function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// -> { name, mime, size, text, truncated }. Throws an Error with a message for the reader.
export async function readFileAsDoc(file) {
  const name = file.name || 'pasted file';
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name} is ${formatBytes(file.size)}; files up to ${formatBytes(MAX_FILE_BYTES)} can be attached.`);
  const ext = extOf(name);
  const mime = file.type || '';
  let text;
  if (ext === 'pdf' || mime === 'application/pdf') text = await pdfText(file);
  else if (ext === 'docx') text = await docxText(file);
  else if (/^image\//.test(mime) && ext !== 'svg') throw new Error(`${name} is an image. Only text can be attached for now: text, code, Markdown, CSV, JSON, PDF and Word files.`);
  else if (['doc', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'rar', '7z', 'exe', 'dmg', 'mp3', 'mp4', 'mov', 'wav'].includes(ext)) {
    throw new Error(`${name} cannot be read as text. Attach text, code, Markdown, CSV, JSON, PDF or Word (.docx) files.`);
  } else {
    const buf = await file.arrayBuffer();
    text = decodeText(buf, name, TEXT_EXT.has(ext) || /^text\/|json|xml|javascript|yaml|csv/.test(mime));
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  if (!text.trim()) throw new Error(`${name} has no text in it.`);
  const truncated = text.length > MAX_DOC_CHARS;
  if (truncated) text = text.slice(0, MAX_DOC_CHARS);
  return { name, mime, size: file.size, text, truncated };
}

function decodeText(buf, name, known) {
  const bytes = new Uint8Array(buf);
  // A NUL in the first few KB means a binary file, whatever its name.
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) throw new Error(`${name} looks like a binary file, not text.`);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!known) {
    const bad = (text.slice(0, 20000).match(/�/g) || []).length;
    if (bad > 20) throw new Error(`${name} does not look like a text file.`);
  }
  return text;
}

// ---------- PDF ----------

let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  try {
    const lib = await import(/* @vite-ignore */ PDFJS + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    pdfjs = lib;
    return lib;
  } catch {
    throw new Error('The PDF reader could not be loaded (it comes from cdn.jsdelivr.net). Check your connection, or attach the text instead.');
  }
}

async function pdfText(file) {
  const lib = await loadPdfjs();
  let doc;
  try {
    doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  } catch (e) {
    throw new Error(`${file.name} could not be opened as a PDF${/password/i.test(e?.message || '') ? ': it is password protected' : ''}.`);
  }
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let line = '';
    const out = [];
    for (const item of content.items) {
      line += item.str;
      if (item.hasEOL) { out.push(line); line = ''; }
    }
    if (line) out.push(line);
    pages.push(`[page ${i}]\n` + out.join('\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  doc.destroy?.();
  const text = pages.join('\n\n');
  if (!text.replace(/\[page \d+\]/g, '').trim()) throw new Error(`${file.name} has no text layer (it may be a scan), so there is nothing to read.`);
  return text;
}

// ---------- Word (.docx): a zip with word/document.xml ----------

async function docxText(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const xml = await unzipEntry(buf, 'word/document.xml').catch(() => null);
  if (!xml) throw new Error(`${file.name} could not be read as a Word document.`);
  return xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function unzipEntry(bytes, wanted) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) return dec.decode(data);
    if (method !== 8) throw new Error('unsupported compression');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  throw new Error('entry not found');
}

// ---------- download ----------

export function downloadText(filename, text, type = 'text/markdown') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function safeFilename(s, fallback = 'chat') {
  const t = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return t || fallback;
}
