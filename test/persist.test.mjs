// Persistence in a temp directory: .data/log.jsonl and .data/config.json.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cardsOf } from "../shared/project.mjs";
import { startServer } from "../server/http.mjs";
import { createMockProvider } from "./support/mock.mjs";
import { createRegistry } from "../server/providers/registry.mjs";

const FAKE_KEY = "sk-fake-deepseek-persist-0123456789abcd";
const dirs = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "pc-data-"));
  dirs.push(dir);
  return path.join(dir, ".data");
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function captureLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(" "));
  return { lines, log: push, warn: push, error: push };
}

const noFetch = () => {
  throw new Error("no upstream call is allowed in these tests");
};

async function start(dataDir, opts = {}) {
  const logger = opts.logger ?? captureLogger();
  const provider = opts.provider ?? createMockProvider({ speed: 1000 });
  const registry = opts.registry ?? createRegistry({ fallback: provider, env: {}, keysFile: null, fetch: noFetch, logger });
  return startServer({ port: 0, provider, registry, logger, dataDir, ...opts.server });
}

async function post(app, p, body) {
  const init = { method: "POST", headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(app.url + p, init);
  return { status: res.status, body: await res.json() };
}

const snapshot = (s) => JSON.parse(JSON.stringify({ nodes: s.nodes, order: s.order, edges: s.edges, decisions: s.decisions }));
const lines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean);

describe("persistence", () => {
  test("the first start has no file and starts empty", async () => {
    const dir = tempDir();
    const app = await start(dir);
    try {
      assert.equal(app.log.seq, 0);
      assert.deepEqual(app.log.state.order, []);
      assert.ok(existsSync(dir), "the directory is created");
    } finally {
      await app.close();
    }
  });

  test("a restart keeps chats, branches, follow-ups, decisions and edges, and seq continues", async () => {
    const dir = tempDir();
    const a = await start(dir);
    const q1 = (await post(a, "/api/ask", { text: "How should we store events, and how do we stream them?" })).body.turnId;
    await a.engine.idle();
    const q2 = (await post(a, "/api/ask", { text: "And what about caching?", chatId: q1 })).body.turnId;
    await a.engine.idle();
    const [first] = cardsOf(a.log.state, q1);
    const branch = (await post(a, `/api/nodes/${first.id}/branch`, { text: "Is it fast?" })).body.cardId;
    await post(a, `/api/nodes/${first.id}/followup`, { text: "Walk me through a worked example of replaying the log after a crash" });
    await post(a, `/api/nodes/${first.id}/reply`, { text: "And the cost?" });
    await a.engine.idle();
    await post(a, "/api/decisions", { text: "Use SQLite", sourceNodeId: first.id });
    const before = snapshot(a.log.state);
    const seq = a.log.seq;
    await a.close();
    assert.equal(lines(path.join(dir, "log.jsonl")).length, seq, "one line per event");

    const b = await start(dir);
    try {
      assert.deepEqual(snapshot(b.log.state), before);
      assert.equal(b.log.seq, seq);
      assert.equal(b.log.state.nodes[q2].chatId, q1);
      assert.equal(b.log.state.nodes[branch].origin.cardId, first.id);
      const ids = new Set(Object.keys(b.log.state.nodes));
      const next = (await post(b, "/api/ask", { text: "One more?" })).body.turnId;
      assert.ok(!ids.has(next), "new ids continue after the stored ones");
      assert.equal(b.log.since(seq)[0].seq, seq + 1, "seq continues");
      await b.engine.idle();
    } finally {
      await b.close();
    }
    const c = await start(dir);
    try {
      assert.ok(c.log.seq > seq, "the second run's events were stored too");
    } finally {
      await c.close();
    }
  });

  test("a node streaming at shutdown is cancelled after the restart", async () => {
    const dir = tempDir();
    const a = await start(dir, { provider: createMockProvider({ speed: 1 }) });
    const q = (await post(a, "/api/ask", { text: "How should we store events, and how do we stream them?" })).body.turnId;
    await new Promise((resolve) => {
      const off = a.log.subscribe((ev) => {
        if (ev.type === "node.delta") {
          off();
          resolve();
        }
      });
    });
    const streaming = a.log.state.order.filter((id) => a.log.state.nodes[id].status === "streaming");
    assert.ok(streaming.includes(q) && streaming.length >= 2);
    const seq = a.log.seq;
    await a.close();

    const b = await start(dir);
    try {
      for (const id of streaming) assert.equal(b.log.state.nodes[id].status, "cancelled", id);
      const closes = b.log.since(seq).filter((e) => e.type === "node.close");
      assert.deepEqual(closes.map((e) => [e.id, e.status]).sort(), streaming.map((id) => [id, "cancelled"]).sort());
      await b.store.flush();
      const stored = lines(path.join(dir, "log.jsonl")).map((l) => JSON.parse(l));
      assert.ok(streaming.every((id) => stored.some((e) => e.type === "node.close" && e.id === id && e.status === "cancelled")), "the closes are stored");
    } finally {
      await b.close();
    }
  });

  test("a pending follow-up at shutdown gets a cancelled answer after the restart", async () => {
    const dir = tempDir();
    const slow = createMockProvider({ speed: 1 });
    const fast = createMockProvider({ speed: 1000 });
    const provider = { name: "mock", model: "mock", stream: (args) => (args.meta.purpose === "followup" ? slow : fast).stream(args) };
    const a = await start(dir, { provider });
    const q = (await post(a, "/api/ask", { text: "What is SSE?" })).body.turnId;
    await a.engine.idle();
    const card = cardsOf(a.log.state, q)[0];
    const { userNodeId } = (await post(a, `/api/nodes/${card.id}/followup`, { text: "Is it fast?" })).body;
    assert.equal(a.log.state.nodes[userNodeId].pending, true);
    await a.close();
    const b = await start(dir);
    try {
      const m = b.log.state.nodes[userNodeId];
      assert.equal(m.pending, false);
      const answer = Object.values(b.log.state.nodes).find((n) => n.kind === "message" && n.role === "assistant" && n.parentId === card.id);
      assert.equal(answer.status, "cancelled");
    } finally {
      await b.close();
    }
  });

  test("a truncated last line is skipped; a corrupt middle line stops the replay", async () => {
    const dir = tempDir();
    const a = await start(dir);
    await post(a, "/api/ask", { text: "What is SSE?" });
    await a.engine.idle();
    const seq = a.log.seq;
    await a.close();
    const file = path.join(dir, "log.jsonl");
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good + '{"seq":' + (seq + 1) + ',"ts":1,"type":"node.de');

    const logger = captureLogger();
    const b = await start(dir, { logger });
    try {
      assert.equal(b.log.seq, seq);
      assert.equal(logger.lines.filter((l) => l.includes("incomplete last line")).length, 1);
      assert.equal(readFileSync(file, "utf8"), good, "the partial line is gone, so new appends start clean");
      await post(b, "/api/ask", { text: "Another?" });
      await b.engine.idle();
    } finally {
      await b.close();
    }
    const c = await start(dir);
    try {
      assert.ok(c.log.seq > seq + 1);
    } finally {
      await c.close();
    }

    const all = lines(file);
    writeFileSync(file, [all[0], all[1], "not json", ...all.slice(2)].join("\n") + "\n");
    const warn = captureLogger();
    const d = await start(dir, { logger: warn });
    try {
      const replayed = d.log.since(0);
      assert.deepEqual(
        replayed.slice(0, 2).map((e) => e.seq),
        [1, 2],
      );
      assert.ok(replayed.slice(2).every((e) => e.type === "node.close" && e.status === "cancelled"), "only the recovery closes follow");
      assert.ok(warn.lines.some((l) => /line 3 is corrupt: replay stops there/.test(l)));
      await d.store.flush();
      const now = lines(file);
      assert.deepEqual(now.slice(0, 2), [all[0], all[1]], "the file keeps what was replayed");
      assert.ok(!now.includes("not json"));
    } finally {
      await d.close();
    }
  });

  test("POST /api/reset empties the log file; seq still continues", async () => {
    const dir = tempDir();
    const a = await start(dir);
    await post(a, "/api/ask", { text: "What is SSE?" });
    await a.engine.idle();
    const seq = a.log.seq;
    assert.deepEqual(await post(a, "/api/reset"), { status: 200, body: {} });
    await a.store.flush();
    const stored = lines(path.join(dir, "log.jsonl")).map((l) => JSON.parse(l));
    assert.deepEqual(stored.map((e) => [e.seq, e.type]), [[seq + 1, "session.reset"]]);
    await a.close();
    const b = await start(dir);
    try {
      assert.equal(b.log.seq, seq + 1);
      assert.deepEqual(b.log.state.order, []);
    } finally {
      await b.close();
    }
  });

  test("config is restored, has no provider without the key, and no file holds a key", async () => {
    const dir = tempDir();
    const withKey = () => createRegistry({ fallback: createMockProvider({ speed: 1000 }), env: { DEEPSEEK_API_KEY: FAKE_KEY }, keysFile: null, fetch: noFetch, logger: captureLogger() });
    const a = await start(dir, { registry: withKey() });
    await post(a, "/api/ask", { text: "What is SSE?" }); // on the scripted fallback
    await a.engine.idle();
    const r = await post(a, "/api/config", { mode: "single", maxCards: 3, provider: "deepseek", model: "deepseek-flash" });
    assert.equal(r.status, 200);
    const configFile = path.join(dir, "config.json");
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { provider: "deepseek", model: "deepseek-flash", mode: "single", maxCards: 3 });
    await a.close();

    const b = await start(dir, { registry: withKey() });
    try {
      assert.deepEqual(b.engine.getConfig(), { provider: "deepseek", model: "deepseek-flash", mode: "single", maxCards: 3 });
    } finally {
      await b.close();
    }

    const logger = captureLogger();
    const c = await start(dir, { logger }); // no key now
    try {
      assert.deepEqual(c.engine.getConfig(), { provider: null, model: null, mode: "single", maxCards: 3 });
      assert.ok(logger.lines.some((l) => /saved provider deepseek has no key now; add one in Settings/.test(l)));
      assert.equal(JSON.parse(readFileSync(configFile, "utf8")).provider, null, "no provider is written back");
    } finally {
      await c.close();
    }

    // Deleting the active provider's key also rewrites the config.
    const d = await start(dir, { registry: withKey() });
    try {
      await post(d, "/api/config", { provider: "deepseek", model: "deepseek-flash" });
      assert.equal(JSON.parse(readFileSync(configFile, "utf8")).provider, "deepseek");
      const res = await fetch(`${d.url}/api/providers/deepseek/key`, { method: "DELETE" });
      assert.equal(res.status, 200);
      assert.equal(JSON.parse(readFileSync(configFile, "utf8")).provider, null);
    } finally {
      await d.close();
    }

    for (const file of [configFile, path.join(dir, "log.jsonl")]) {
      assert.ok(!readFileSync(file, "utf8").includes(FAKE_KEY), `no key in ${path.basename(file)}`);
    }
  });

  test("off keeps everything in memory", async () => {
    const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: captureLogger() });
    try {
      assert.equal(app.store, null);
    } finally {
      await app.close();
    }
  });
});
