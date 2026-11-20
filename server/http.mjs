// HTTP API, SSE stream and static files. See protocol.md.
import http from "node:http";
import { networkInterfaces } from "node:os";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createEngine, HttpError, LENGTHS, MAX_CARDS, MODES, THINKING } from "./engine.mjs";
import { createStore } from "./store.mjs";
import { createLog } from "./log.mjs";
import { createRegistry } from "./providers/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KATEX_DIR = path.join(ROOT, "node_modules", "katex", "dist");
const MAX_BODY = 32 * 1024 * 1024; // attached documents travel as text in the body

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const PLACEHOLDER =
  "Parallel chat server is running, but the UI is not here yet (public/index.html does not exist).\n" +
  "API: GET /api/state, GET /api/config, GET /api/events (SSE), POST /api/ask { text, chatId? },\n" +
  "  POST /api/nodes/:cardId/reply | branch | followup { text, quote? }.\n" +
  "Providers: GET /api/providers, POST /api/providers/:id/key { apiKey, region?, baseURL?, remember? },\n" +
  "  POST /api/providers/:id/models, DELETE /api/providers/:id/key, POST /api/config { provider, model }.\n" +
  "  ChatGPT signs in instead: POST /api/providers/chatgpt/login { remember? }, POST .../login/complete { url },\n" +
  "  DELETE .../login. Provider ids: anthropic, deepseek, qwen, opencode, chatgpt. These calls must come from this origin.\n";

const isJSON = (req) => /^application\/json\b/i.test(String(req.headers["content-type"] ?? ""));
const hasBody = (req) => Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;

// The Host values a same-origin request can carry for this listen address.
function hostsFor(host, port) {
  const names = new Set();
  const loopback = ["127.0.0.1", "localhost", "::1"];
  if (host === "0.0.0.0" || host === "::" || host === "") {
    for (const name of loopback) names.add(name);
    for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) names.add(a.address);
  } else {
    names.add(host);
    if (loopback.includes(host)) for (const name of loopback) names.add(name);
  }
  return new Set([...names].map((n) => (n.includes(":") ? `[${n}]:${port}` : `${n}:${port}`).toLowerCase()));
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

function sendText(res, status, text, head = false) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(head ? undefined : text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(400, "request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const value = JSON.parse(raw);
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(new HttpError(400, "invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseSeq(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, "malformed id");
  }
}

export async function startServer({
  port = 4317,
  host = "127.0.0.1",
  // What answers while no provider has a key (tests pass a scripted one).
  provider = undefined,
  logger = console,
  // Without one: a registry with no keys, falling back to `provider`.
  registry = createRegistry({ fallback: provider, env: {}, keysFile: null, logger }),
  mode = "fanout",
  maxCards = 4,
  publicDir = path.join(ROOT, "public"),
  sharedDir = path.join(ROOT, "shared"),
  pingMs = 15000,
  // Persistence directory (log.jsonl, config.json); null keeps everything in memory.
  dataDir = null,
} = {}) {
  const log = createLog();
  const store = dataDir ? createStore({ dir: dataDir, logger }) : null;
  if (store) {
    const events = store.loadEvents();
    log.restore(events);
    if (events.length) logger.log?.(`[store] replayed ${events.length} events (last seq ${log.seq})`);
  }
  const engine = createEngine({ log, provider: registry.fallback, registry, mode, maxCards, logger });
  let savedConfig = null;
  function persistConfig() {
    if (!store) return;
    const config = engine.getConfig();
    const text = JSON.stringify(config);
    if (text === savedConfig) return;
    store.saveConfig(config);
    savedConfig = text;
  }
  if (store) {
    log.subscribe((ev) => store.append(ev));
    log.onRewrite((events) => store.rewrite(events));
    engine.recover();
    restoreConfig(store.loadConfig());
    persistConfig();
  }

  // Settings from config.json; the provider only when it still has a key.
  function restoreConfig(saved) {
    if (!saved) return;
    const base = {};
    if (MODES.includes(saved.mode)) base.mode = saved.mode;
    if (Number.isInteger(saved.maxCards) && saved.maxCards >= 1 && saved.maxCards <= MAX_CARDS) base.maxCards = saved.maxCards;
    if (LENGTHS.includes(saved.length)) base.length = saved.length;
    if (THINKING.includes(saved.thinking)) base.thinking = saved.thinking;
    if (Object.keys(base).length) engine.setConfig(base);
    if (typeof saved.provider !== "string") return;
    try {
      engine.setConfig({ provider: saved.provider, model: typeof saved.model === "string" && saved.model ? saved.model : undefined });
      logger.log?.(`[store] restored provider ${saved.provider} (${engine.getConfig().model})`);
    } catch {
      logger.log?.(`[store] the saved provider ${saved.provider} has no key now; add one in Settings`);
    }
  }
  let allowedHosts = new Set();
  const streams = new Set();

  // ---------- SSE ----------

  function openStream(req, res, url) {
    let since = parseSeq(req.headers["last-event-id"]);
    if (since === null) since = parseSeq(url.searchParams.get("since"));
    if (since === null || since > log.seq) since = 0; // ahead of this log: the server restarted
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    req.socket.setNoDelay?.(true);
    res.write(": connected\n\n");
    const write = (ev) => {
      if (!res.writableEnded && !res.destroyed) res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    // Replay and subscribe in the same tick, so nothing falls between them.
    for (const ev of log.since(since)) write(ev);
    const unsubscribe = log.subscribe(write);
    const ping = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, pingMs);
    const entry = { res, cleanup };
    function cleanup() {
      clearInterval(ping);
      unsubscribe();
      streams.delete(entry);
    }
    streams.add(entry);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  // ---------- API ----------

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let match;
    try {
      if (m === "GET" && p === "/api/events") return openStream(req, res, url);
      if (m === "GET" && p === "/api/state") return sendJson(res, 200, log.state);
      if (m === "GET" && p === "/api/config") return sendJson(res, 200, engine.getConfig());
      if (m === "POST" && p === "/api/config") {
        guard(req, { json: true });
        const config = engine.setConfig(await readJson(req));
        persistConfig();
        return sendJson(res, 200, config);
      }
      if (p === "/api/providers" || p.startsWith("/api/providers/")) return await handleProviders(req, res, m, p);
      if (m === "POST" && p === "/api/ask") return sendJson(res, 202, engine.ask(await readJson(req)));
      if (m === "POST" && (match = /^\/api\/nodes\/([^/]+)\/(reply|branch|followup|refresh|cancel)$/.exec(p))) {
        const id = decodeId(match[1]);
        if (match[2] === "reply") return sendJson(res, 202, engine.reply(id, await readJson(req)));
        if (match[2] === "branch") return sendJson(res, 202, engine.branch(id, await readJson(req)));
        if (match[2] === "followup") return sendJson(res, 202, engine.followup(id, await readJson(req)));
        req.resume();
        if (match[2] === "refresh") return sendJson(res, 202, engine.refresh(id));
        return sendJson(res, 200, engine.cancel(id));
      }
      if (m === "POST" && p === "/api/broadcast") return sendJson(res, 202, engine.broadcast(await readJson(req)));
      if (m === "POST" && p === "/api/synthesize") return sendJson(res, 202, engine.synthesize(await readJson(req)));
      if (m === "POST" && p === "/api/decisions") return sendJson(res, 201, engine.pin(await readJson(req)));
      if (m === "DELETE" && (match = /^\/api\/decisions\/([^/]+)$/.exec(p))) {
        req.resume();
        return sendJson(res, 200, engine.unpin(decodeId(match[1])));
      }
      if (m === "PATCH" && (match = /^\/api\/decisions\/([^/]+)$/.exec(p))) {
        return sendJson(res, 200, engine.editDecision(decodeId(match[1]), await readJson(req)));
      }
      if ((match = /^\/api\/chats\/([^/]+)$/.exec(p))) {
        const id = decodeId(match[1]);
        if (m === "PATCH") return sendJson(res, 200, engine.patchChat(id, await readJson(req)));
        if (m === "DELETE") {
          guard(req, { json: false }); // destructive: same-origin only
          req.resume();
          const out = engine.deleteChat(id);
          return sendJson(res, 200, out);
        }
      }
      if (m === "POST" && (match = /^\/api\/chats\/([^/]+)\/docs$/.exec(p))) {
        return sendJson(res, 201, engine.addDocs(decodeId(match[1]), await readJson(req)));
      }
      if (m === "DELETE" && (match = /^\/api\/docs\/([^/]+)$/.exec(p))) {
        req.resume();
        return sendJson(res, 200, engine.removeDoc(decodeId(match[1])));
      }
      if (m === "POST" && p === "/api/groups") return sendJson(res, 201, engine.addGroup(await readJson(req)));
      if ((match = /^\/api\/groups\/([^/]+)$/.exec(p))) {
        const id = decodeId(match[1]);
        if (m === "PATCH") return sendJson(res, 200, engine.patchGroup(id, await readJson(req)));
        if (m === "DELETE") {
          req.resume();
          return sendJson(res, 200, engine.removeGroup(id));
        }
      }
      if (m === "PUT" && (match = /^\/api\/notes\/([^/]+)$/.exec(p))) {
        return sendJson(res, 200, engine.setNote(decodeId(match[1]), await readJson(req)));
      }
      if (m === "GET" && (match = /^\/api\/context\/([^/]+)$/.exec(p))) {
        return sendJson(res, 200, engine.context(decodeId(match[1])));
      }
      if (m === "POST" && p === "/api/reset") {
        req.resume();
        store?.truncate(); // ordered before the session.reset append
        return sendJson(res, 200, engine.reset());
      }
      req.resume();
      return sendJson(res, 404, { error: `no route for ${m} ${p}` });
    } catch (err) {
      if (err instanceof HttpError) {
        req.resume();
        return sendJson(res, err.status, { error: err.message });
      }
      logger.error?.("[http] request failed:", err?.message ?? err);
      return sendJson(res, 500, { error: "internal error" });
    }
  }

  // ---------- providers ----------

  // Same-origin only: Host must be an address this server listens on, an
  // Origin (when sent) must match it, and a body must be JSON.
  function guard(req, { json }) {
    const host = String(req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host)) throw new HttpError(403, "request refused: unexpected Host");
    const origin = req.headers.origin;
    if (origin !== undefined && String(origin).toLowerCase() !== `http://${host}`) {
      throw new HttpError(403, "request refused: cross-origin");
    }
    if (json ? !isJSON(req) : hasBody(req) && !isJSON(req)) throw new HttpError(415, "the body must be application/json");
  }

  async function handleProviders(req, res, m, p) {
    if (m === "GET" && p === "/api/providers") {
      guard(req, { json: false });
      return sendJson(res, 200, registry.list());
    }
    const signIn = /^\/api\/providers\/([^/]+)\/login(\/complete)?$/.exec(p);
    if (signIn) {
      const id = decodeId(signIn[1]);
      if (m === "POST" && !signIn[2]) {
        guard(req, { json: true });
        const body = await readJson(req);
        const appURL = `http://${String(req.headers.host ?? "").toLowerCase()}/`; // guard checked the Host
        return sendJson(res, 200, { provider: await registry.startLogin(id, body, { appURL }) });
      }
      if (m === "POST" && signIn[2]) {
        guard(req, { json: true });
        const provider = await registry.completeLogin(id, await readJson(req));
        return sendJson(res, 200, { provider });
      }
      if (m === "DELETE" && !signIn[2]) {
        guard(req, { json: false });
        req.resume();
        return sendJson(res, 200, { provider: registry.cancelLogin(id) });
      }
    }
    const match = /^\/api\/providers\/([^/]+)\/(key|models)$/.exec(p);
    if (match) {
      const id = decodeId(match[1]);
      if (m === "POST" && match[2] === "key") {
        guard(req, { json: true });
        return sendJson(res, 200, { provider: await registry.setKey(id, await readJson(req)) });
      }
      if (m === "POST" && match[2] === "models") {
        guard(req, { json: false });
        req.resume();
        return sendJson(res, 200, { provider: await registry.refreshModels(id) });
      }
      if (m === "DELETE" && match[2] === "key") {
        guard(req, { json: false });
        req.resume();
        const provider = registry.deleteKey(id);
        persistConfig(); // the active provider may have gone (no key)
        return sendJson(res, 200, { provider });
      }
    }
    req.resume();
    return sendJson(res, 404, { error: `no route for ${m} ${p}` });
  }

  // ---------- static ----------

  async function serveStatic(req, res, root, urlPath, { placeholder = false } = {}) {
    const head = req.method === "HEAD";
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return sendText(res, 400, "Bad path\n", head);
    }
    if (rel.includes("\0")) return sendText(res, 400, "Bad path\n", head);
    const base = path.resolve(root);
    let file = path.resolve(base, rel.replace(/^[/\\]+/, ""));
    if (file !== base && !file.startsWith(base + path.sep)) return sendText(res, 404, "Not found\n", head);
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = path.join(file, "index.html");
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "content-length": data.length,
        "cache-control": "no-cache",
      });
      res.end(head ? undefined : data);
    } catch {
      if (placeholder) return sendText(res, 200, PLACEHOLDER, head);
      return sendText(res, 404, "Not found\n", head);
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (p === "/api" || p.startsWith("/api/")) return handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      req.resume();
      return sendText(res, 405, "Method not allowed\n");
    }
    if (p === "/shared" || p.startsWith("/shared/")) return serveStatic(req, res, sharedDir, p.slice("/shared".length));
    // KaTeX (math in cards), from npm install; without it math shows as source.
    if (p.startsWith("/vendor/katex/")) return serveStatic(req, res, KATEX_DIR, p.slice("/vendor/katex".length));
    return serveStatic(req, res, publicDir, p, { placeholder: p === "/" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      logger.error?.("[http] unhandled:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = server.address().port;
  allowedHosts = hostsFor(host, actualPort);

  async function close() {
    engine.shutdown();
    registry.close?.(); // a ChatGPT sign-in still waiting on its callback port
    await store?.flush();
    for (const s of [...streams]) {
      s.cleanup();
      s.res.end();
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    engine,
    log,
    provider,
    registry,
    store,
    close,
    get clients() {
      return streams.size; // open SSE connections
    },
  };
}
