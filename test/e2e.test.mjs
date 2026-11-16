// End-to-end: real HTTP server on an ephemeral port, real SSE stream, mock provider.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { applyEvent, cardsOf, createState, threadOf } from "../shared/project.mjs";
import { startServer } from "../server/http.mjs";
import { createMockProvider } from "./support/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const t = {}; // shared between the ordered tests in each suite

// Minimal SSE client that folds events with the shared reducer.
function sse(base, { since, lastEventId } = {}) {
  const controller = new AbortController();
  const events = [];
  const ids = [];
  const state = createState();
  let waiters = [];

  function check() {
    waiters = waiters.filter((w) => {
      try {
        if (w.pred(state, events)) {
          w.resolve();
          return false;
        }
      } catch (err) {
        w.reject(err);
        return false;
      }
      return true;
    });
  }

  async function pump(body) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id = null;
          const data = [];
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) id = Number(line.slice(4));
            else if (line.startsWith("data: ")) data.push(line.slice(6));
          }
          if (!data.length) continue;
          const ev = JSON.parse(data.join("\n"));
          events.push(ev);
          ids.push(id);
          applyEvent(state, ev);
        }
        check();
      }
    } catch {
      // aborted by close()
    }
  }

  const ready = (async () => {
    const url = since === undefined ? `${base}/api/events` : `${base}/api/events?since=${since}`;
    const headers = lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) };
    const res = await fetch(url, { headers, signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    pump(res.body);
  })();

  return {
    events,
    ids,
    state,
    ready,
    waitFor(pred, label = "condition", ms = 15000) {
      return new Promise((resolve, reject) => {
        const waiter = {
          pred,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== waiter);
          reject(new Error(`timed out waiting for ${label}`));
        }, ms);
        waiters.push(waiter);
        check();
      });
    },
    close() {
      controller.abort();
    },
  };
}

async function api(base, method, path, body, { raw } = {}) {
  const init = { method, headers: {} };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  if (init.body !== undefined) init.headers["content-type"] = "application/json";
  const res = await fetch(base + path, init);
  return { status: res.status, body: await res.json() };
}

function rawGet(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data, type: res.headers["content-type"] }));
      })
      .on("error", reject);
  });
}

const turnDone = (turnId) => (s) => {
  const q = s.nodes[turnId];
  if (!q || q.status === "streaming") return false;
  return cardsOf(s, turnId).every((c) => c.status !== "streaming");
};
const settled = (id) => (s) => s.nodes[id]?.status === "settled";

describe("end to end (mock provider)", () => {
  let app;
  let base;
  let stream;

  before(async () => {
    app = await startServer({ port: 0, provider: createMockProvider({ speed: 200 }), logger: quiet });
    base = app.url;
    stream = sse(base);
    await stream.ready;
  });

  after(async () => {
    stream?.close();
    await app?.close();
  });

  test("config, validation and static files", async () => {
    const cfg = await api(base, "GET", "/api/config");
    assert.deepEqual(cfg, { status: 200, body: { provider: null, model: null, mode: "fanout", maxCards: 4 } });
    assert.equal((await api(base, "POST", "/api/config", { mode: "nope" })).status, 400);
    assert.equal((await api(base, "POST", "/api/config", { maxCards: 0 })).status, 400);
    assert.equal((await api(base, "POST", "/api/config", {})).status, 400);
    assert.equal((await api(base, "POST", "/api/config", { maxCards: 5 })).body.maxCards, 5);
    assert.deepEqual((await api(base, "POST", "/api/config", { maxCards: 4 })).body, cfg.body);
    assert.equal((await api(base, "POST", "/api/ask", {})).status, 400);
    const bad = await api(base, "POST", "/api/ask", undefined, { raw: "{not json" });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.error);
    assert.equal((await api(base, "POST", "/api/nodes/n_999/reply", { text: "x" })).status, 404);
    assert.equal((await api(base, "POST", "/api/nodes/n_999/cancel")).status, 404);
    assert.equal((await api(base, "DELETE", "/api/decisions/d_999")).status, 404);
    assert.equal((await api(base, "GET", "/api/context/n_999")).status, 404);
    assert.equal((await api(base, "GET", "/api/nope")).status, 404);

    const root = await rawGet(app.port, "/");
    assert.equal(root.status, 200);
    assert.ok(/^text\/(html|plain)/.test(root.type));
    const shared = await rawGet(app.port, "/shared/project.mjs");
    assert.equal(shared.status, 200);
    assert.match(shared.type, /^text\/javascript/);
    assert.match(shared.body, /export function applyEvent/);
    // Each of these would reach a real file (package.json, server.mjs) without the guard.
    for (const p of [
      "/shared/..%2fpackage.json",
      "/shared/..%5cserver.mjs",
      "/..%2fpackage.json",
      "/..%5cserver.mjs",
      "/%2e%2e%2fpackage.json",
      "/shared/%2e%2e/package.json",
    ]) {
      const r = await rawGet(app.port, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('"scripts"') && !r.body.includes("startServer"), p);
    }
  });

  test("fan-out: cards open at once and stream interleaved", async () => {
    const q = "How should we store events, and how do we stream them to the browser, and what about caching?";
    const ask = await api(base, "POST", "/api/ask", { text: q });
    assert.equal(ask.status, 202);
    const { turnId } = ask.body;
    await stream.waitFor(turnDone(turnId), "fan-out turn");
    const s = stream.state;
    const question = s.nodes[turnId];
    assert.equal(question.status, "settled");
    assert.equal(question.mode, "fanout");
    assert.equal(question.shape, "parallel");
    const cards = cardsOf(s, turnId);
    assert.deepEqual(
      cards.map((c) => c.title),
      ["Store events", "Stream them to the browser", "Caching"],
    );
    for (const c of cards) {
      assert.equal(c.status, "settled");
      assert.ok(c.summary.length > 10 && c.body.length > 100);
    }
    // Mock cards vary in length; the long ones carry the code sample.
    assert.ok(cards.some((c) => c.body.includes("queue.length < limit")));
    assert.ok(cards.some((c) => !c.body.includes("```")), "and some are short");
    assert.equal(s.edges.length, 2);

    const ids = new Set(cards.map((c) => c.id));
    const opens = stream.events.filter((e) => e.type === "node.open" && ids.has(e.node.id)).map((e) => e.seq);
    const deltas = stream.events.filter((e) => e.type === "node.delta" && ids.has(e.id));
    assert.ok(Math.max(...opens) < deltas[0].seq, "every card opens before any content streams");
    let switches = 0;
    for (let i = 1; i < deltas.length; i++) if (deltas[i].id !== deltas[i - 1].id) switches++;
    assert.ok(switches > cards.length * 10, `deltas interleave (${switches} switches)`);
    const lastOfFirst = deltas.findLast((e) => e.id === cards[0].id).seq;
    const firstOfLast = deltas.find((e) => e.id === cards[2].id).seq;
    assert.ok(firstOfLast < lastOfFirst);

    assert.equal((await api(base, "POST", `/api/nodes/${turnId}/reply`, { text: "x" })).status, 400);
    Object.assign(t, { turnId, cards });
  });

  test("a reply lands under the right card with scoped context", async () => {
    const [c1, c2, c3] = t.cards;
    const r = await api(base, "POST", `/api/nodes/${c2.id}/reply`, {
      text: "What about reconnects?",
      quote: "one `<section>` per card",
    });
    assert.equal(r.status, 202);
    const { userNodeId, assistantNodeId } = r.body;
    await stream.waitFor(settled(assistantNodeId), "reply");
    const s = stream.state;
    assert.deepEqual(
      threadOf(s, c2.id).map((n) => n.id),
      [userNodeId, assistantNodeId],
    );
    assert.equal(s.nodes[userNodeId].role, "user");
    assert.equal(s.nodes[userNodeId].quote, "one `<section>` per card");
    assert.equal(s.nodes[assistantNodeId].parentId, c2.id);
    assert.equal(s.nodes[assistantNodeId].turnId, t.turnId);
    const body = s.nodes[assistantNodeId].body;
    assert.match(body, /in \*Stream them to the browser\*/);
    assert.match(body, /Pinned decisions: 0/);
    assert.match(body, /Linked cards in full: \*Store events\* and \*Caching\*/);
    assert.match(body, /Earlier messages in this thread: 0/);
    assert.match(body, /> one `<section>` per card/);
    assert.match(body, /What about reconnects\?/);
    assert.deepEqual(threadOf(s, c1.id), []);
    assert.deepEqual(threadOf(s, c3.id), []);
  });

  test("broadcast answers in every selected card", async () => {
    const [c1, c2, c3] = t.cards;
    const r = await api(base, "POST", "/api/broadcast", { cardIds: [c1.id, c3.id, c1.id], text: "One line, please." });
    assert.equal(r.status, 202);
    assert.deepEqual(
      r.body.replies.map((x) => x.cardId),
      [c1.id, c3.id],
    );
    await stream.waitFor((s) => r.body.replies.every((x) => settled(x.assistantNodeId)(s)), "broadcast");
    const s = stream.state;
    for (const { cardId, userNodeId, assistantNodeId } of r.body.replies) {
      assert.equal(s.nodes[userNodeId].parentId, cardId);
      assert.equal(s.nodes[assistantNodeId].parentId, cardId);
      assert.match(s.nodes[assistantNodeId].body, new RegExp(`in \\*${s.nodes[cardId].title}\\*`));
      assert.deepEqual(
        threadOf(s, cardId).map((n) => n.id),
        [userNodeId, assistantNodeId],
      );
    }
    assert.equal(threadOf(s, c2.id).length, 2, "c2's thread is untouched");
    // Overlapping in time: both assistant replies stream before either settles.
    const [a, b] = r.body.replies.map((x) => x.assistantNodeId);
    const firstB = stream.events.find((e) => e.type === "node.delta" && e.id === b).seq;
    const closeA = stream.events.find((e) => e.type === "node.close" && e.id === a).seq;
    assert.ok(firstB < closeA, "broadcast replies stream concurrently");
  });

  test("GET /api/context shows only the card's own thread", async () => {
    const [c1, c2] = t.cards;
    const r = await api(base, "GET", `/api/context/${c2.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.sections.map((x) => x.name),
      ["system prompt", "question", "outline", "existing cards", "decisions", "focus card", "linked cards", "thread", "new question"],
    );
    const text = JSON.stringify(r.body.messages);
    assert.ok(text.includes("What about reconnects?"));
    assert.ok(!text.includes("One line, please."), "sibling threads are absent");
    const r1 = await api(base, "GET", `/api/context/${c1.id}`);
    const text1 = JSON.stringify(r1.body.messages);
    assert.ok(text1.includes("One line, please.") && !text1.includes("What about reconnects?"));
    const prefix = (ctx) => JSON.stringify([ctx.system, ctx.messages[0].content.slice(0, 2)]);
    assert.equal(prefix(r.body), prefix(r1.body), "cached prefix shared across threads");
  });

  test("pin marks linked cards stale, refresh settles them, unpin reverts", async () => {
    const [c1, c2, c3] = t.cards;
    const before = await api(base, "GET", `/api/context/${c2.id}`);
    const pin = await api(base, "POST", "/api/decisions", { text: "Store events in SQLite", sourceNodeId: c1.id });
    assert.equal(pin.status, 201);
    const { decision } = pin.body;
    assert.deepEqual(decision.affects, [c2.id], "c1 is joined only to c2");
    assert.equal(decision.sourceNodeId, c1.id);
    await stream.waitFor((s) => s.nodes[c2.id].status === "stale", "stale");
    assert.equal(stream.state.nodes[c2.id].staleBecause, decision.id);
    assert.equal(stream.state.nodes[c1.id].status, "settled");
    assert.equal(stream.state.nodes[c3.id].status, "settled");

    const after = await api(base, "GET", `/api/context/${c2.id}`);
    const prefix = (ctx) => JSON.stringify([ctx.system, ctx.messages[0].content.slice(0, 2)]);
    assert.equal(prefix(after.body), prefix(before.body), "pinning does not touch the cached prefix");
    assert.match(after.body.messages[0].content[3].text, /Store events in SQLite/);

    const rf = await api(base, "POST", `/api/nodes/${c2.id}/refresh`);
    assert.deepEqual(rf, { status: 202, body: { cardId: c2.id } });
    await stream.waitFor((s) => settled(c2.id)(s) && s.nodes[c2.id].body.includes("SQLite"), "refresh");
    const card = stream.state.nodes[c2.id];
    assert.equal(card.staleBecause, undefined);
    assert.match(card.summary, /Revised for 1 pinned decision/);
    assert.ok(stream.events.some((e) => e.type === "node.reset" && e.id === c2.id));
    assert.equal(threadOf(stream.state, c2.id).length, 2, "refresh keeps the thread");

    const pin2 = await api(base, "POST", "/api/decisions", { text: "Cache nothing", affects: [c3.id] });
    assert.deepEqual(pin2.body.decision.affects, [c3.id]);
    await stream.waitFor((s) => s.nodes[c3.id].status === "stale", "stale c3");
    const del = await api(base, "DELETE", `/api/decisions/${pin2.body.decision.id}`);
    assert.deepEqual(del, { status: 200, body: { id: pin2.body.decision.id } });
    await stream.waitFor((s) => s.nodes[c3.id].status === "settled", "unpin reverts");
    assert.equal(stream.state.decisions.length, 1);
  });

  test("synthesize adds a card with elaborates edges", async () => {
    const [c1, , c3] = t.cards;
    const r = await api(base, "POST", "/api/synthesize", { cardIds: [c1.id, c3.id] });
    assert.equal(r.status, 202);
    const { cardId } = r.body;
    await stream.waitFor(settled(cardId), "synthesis");
    const s = stream.state;
    assert.equal(s.nodes[cardId].parentId, t.turnId);
    assert.match(s.nodes[cardId].body, /\*\*Store events\*\* and \*\*Caching\*\*/);
    const edges = s.edges.filter((e) => e.from === cardId).map((e) => [e.to, e.rel]);
    assert.deepEqual(edges, [
      [c1.id, "elaborates"],
      [c3.id, "elaborates"],
    ]);
  });

  test("single mode: one stream, cards fill one after another", async () => {
    assert.equal((await api(base, "POST", "/api/config", { mode: "single" })).body.mode, "single");
    const ask = await api(base, "POST", "/api/ask", { text: "Why use a log? How do we replay it?" });
    const { turnId } = ask.body;
    await stream.waitFor(turnDone(turnId), "single turn");
    const s = stream.state;
    assert.equal(s.nodes[turnId].mode, "single");
    assert.equal(s.nodes[turnId].shape, "parallel");
    const cards = cardsOf(s, turnId);
    assert.deepEqual(
      cards.map((c) => c.title),
      ["Why use a log", "Replay it"],
    );
    for (const c of cards) {
      assert.equal(c.status, "settled");
      assert.ok(c.summary.length > 10);
      assert.ok(c.body.includes("queue.length < limit") && c.body.includes("<section>"), "'<' in body survives");
      assert.ok(!c.body.includes("<summary>") && !c.body.includes("</card>"));
    }
    const seqOf = (pred) => stream.events.find(pred).seq;
    const open2 = seqOf((e) => e.type === "node.open" && e.node.id === cards[1].id);
    const close1 = seqOf((e) => e.type === "node.close" && e.id === cards[0].id);
    assert.ok(close1 < open2, "card 2 opens after card 1 closes");
    assert.ok(s.edges.some((e) => e.from === cards[0].id && e.to === cards[1].id && e.rel === "feeds"));
    await api(base, "POST", "/api/config", { mode: "fanout" });
  });

  test("a later chat links to a card in chat 1", async () => {
    const { turnId } = (await api(base, "POST", "/api/ask", { text: "How should caching interact with replay after a restart?" })).body;
    await stream.waitFor(turnDone(turnId), "third chat");
    const s = stream.state;
    const cross = s.edges.filter((e) => s.nodes[e.from].turnId === turnId && s.nodes[e.to].turnId !== turnId);
    assert.equal(cross.length, 1);
    assert.equal(s.nodes[cross[0].to].title, "Caching");
    assert.equal(s.nodes[cross[0].to].turnId, t.turnId);
    const ctx = await api(base, "GET", `/api/context/${cross[0].from}`);
    const blocks = ctx.body.messages[0].content.map((b) => b.text);
    assert.match(blocks[2], /You are working in chat 3 of 3\./);
    assert.match(blocks[5], /Chat 1, card 3: Caching \(this card elaborates it\)/);
  });

  test("replay with ?since= and Last-Event-ID returns only later events", async () => {
    const target = app.log.seq;
    const mid = Math.floor(target / 2);
    const r = sse(base, { since: mid });
    await r.ready;
    await r.waitFor((_, evs) => evs.length && evs.at(-1).seq >= target, "replay");
    assert.equal(r.events[0].seq, mid + 1);
    assert.equal(r.events.length, target - mid);
    assert.ok(r.events.every((e) => e.seq > mid));
    r.close();

    const h = sse(base, { since: 1, lastEventId: target - 3 });
    await h.ready;
    await h.waitFor((_, evs) => evs.length && evs.at(-1).seq >= target, "replay by header");
    assert.deepEqual(
      h.events.map((e) => e.seq),
      [target - 2, target - 1, target],
    );
    h.close();
  });

  test("seqs on the live stream are gapless and match SSE ids", () => {
    assert.ok(stream.events.length > 500);
    stream.events.forEach((e, i) => {
      assert.equal(e.seq, i + 1);
      assert.equal(stream.ids[i], e.seq);
      assert.equal(typeof e.ts, "number");
    });
    assert.deepEqual(stream.state.order, app.log.state.order, "client projection matches the server's");
  });

  test("reset aborts, clears the log and emits session.reset", async () => {
    const last = app.log.seq;
    const r = await api(base, "POST", "/api/reset");
    assert.deepEqual(r, { status: 200, body: {} });
    await stream.waitFor((_, evs) => evs.at(-1).type === "session.reset", "reset");
    assert.equal(stream.events.at(-1).seq, last + 1);
    assert.deepEqual(stream.state.nodes, {});
    const st = await api(base, "GET", "/api/state");
    assert.deepEqual(st.body, { seq: last + 1, nodes: {}, order: [], edges: [], decisions: [], chatMeta: {}, groups: [], notes: {}, docs: [] });
    const fresh = sse(base, { since: 0 });
    await fresh.ready;
    await fresh.waitFor((_, evs) => evs.length === 1, "fresh replay");
    assert.equal(fresh.events[0].type, "session.reset");
    fresh.close();
  });
});

test("SSE sends : ping comments and cleans up on disconnect", async () => {
  const app = await startServer({ port: 0, provider: createMockProvider({ speed: 200 }), pingMs: 40, logger: quiet });
  try {
    const controller = new AbortController();
    const res = await fetch(`${app.url}/api/events`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes(": ping\n\n")) text += decoder.decode((await reader.read()).value, { stream: true });
    assert.equal(app.clients, 1);
    controller.abort();
    for (let i = 0; i < 100 && app.clients > 0; i++) await delay(10);
    assert.equal(app.clients, 0, "subscriber and ping timer removed after disconnect");
    assert.equal(app.log.since(0).length, 0);
  } finally {
    await app.close();
  }
});

describe("cancellation (mock at real speed)", () => {
  let app;
  let base;
  let stream;
  const firstDelta = (pred) => (_, evs) => evs.some((e) => e.type === "node.delta" && pred(e));

  before(async () => {
    app = await startServer({ port: 0, provider: createMockProvider({ speed: 1 }), logger: quiet });
    base = app.url;
    stream = sse(base);
    await stream.ready;
  });

  after(async () => {
    stream?.close();
    await app?.close();
  });

  test("cancel a card mid-stream, then the whole turn", async () => {
    const { turnId } = (await api(base, "POST", "/api/ask", { text: "How do we store events, and how do we stream them?" }))
      .body;
    await stream.waitFor(
      firstDelta((e) => stream.state.nodes[e.id]?.parentId === turnId),
      "first card delta",
    );
    const [a, b] = cardsOf(stream.state, turnId);
    const res = await api(base, "POST", `/api/nodes/${a.id}/cancel`);
    assert.deepEqual(res, { status: 200, body: { id: a.id } });
    await stream.waitFor((s) => s.nodes[a.id].status === "cancelled", "card cancelled");
    const closeSeq = stream.events.find((e) => e.type === "node.close" && e.id === a.id).seq;
    await delay(150);
    assert.ok(!stream.events.some((e) => e.seq > closeSeq && e.id === a.id), "no writes after cancel");
    assert.equal(stream.state.nodes[b.id].status, "streaming", "the sibling keeps streaming");

    await api(base, "POST", `/api/nodes/${turnId}/cancel`);
    await stream.waitFor(
      (s) => s.nodes[turnId].status === "cancelled" && s.nodes[b.id].status === "cancelled",
      "turn cancelled",
    );
    // Cancelling something already finished is a harmless no-op.
    assert.deepEqual(await api(base, "POST", `/api/nodes/${a.id}/cancel`), { status: 200, body: { id: a.id } });
    assert.equal(stream.state.nodes[a.id].status, "cancelled");
    t.card = b;
  });

  test("cancel a reply mid-stream", async () => {
    const r = (await api(base, "POST", `/api/nodes/${t.card.id}/reply`, { text: "go on" })).body;
    await stream.waitFor(
      firstDelta((e) => e.id === r.assistantNodeId),
      "reply delta",
    );
    await api(base, "POST", `/api/nodes/${r.assistantNodeId}/cancel`);
    await stream.waitFor((s) => s.nodes[r.assistantNodeId].status === "cancelled", "reply cancelled");
    assert.ok(stream.state.nodes[r.assistantNodeId].body.length > 0);
  });

  test("cancel a single-mode turn", async () => {
    await api(base, "POST", "/api/config", { mode: "single" });
    const { turnId } = (await api(base, "POST", "/api/ask", { text: "Why use a log? How do we replay it?" })).body;
    await stream.waitFor((s) => cardsOf(s, turnId).length === 1, "first card open");
    await api(base, "POST", `/api/nodes/${turnId}/cancel`);
    await stream.waitFor((s) => s.nodes[turnId].status === "cancelled", "single turn cancelled");
    const [card] = cardsOf(stream.state, turnId);
    assert.equal(card.status, "cancelled");
    await delay(150);
    assert.equal(cardsOf(stream.state, turnId).length, 1, "no further cards after cancel");
  });
});
