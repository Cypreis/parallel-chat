// Chat management (titles, pins, groups, delete), notes, documents and
// scoped decisions: the reducer, the context the model is sent, and the API.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { applyEvent, cardsOf, chats, createState, decisionsFor, docsOf } from "../shared/project.mjs";
import { buildContext, buildAskContext } from "../server/context.mjs";
import { startServer } from "../server/http.mjs";
import { createMockProvider } from "./support/mock.mjs";

// ---------- reducer ----------

function fold() {
  const s = createState();
  let seq = 0;
  const ev = (type, payload = {}) => applyEvent(s, { seq: ++seq, ts: 1000 + seq, type, ...payload });
  return { s, ev };
}

function twoChats() {
  const t = fold();
  const { ev } = t;
  ev("node.open", { node: { id: "q1", kind: "question", parentId: null, turnId: "q1", role: "user", title: "", summary: "", body: "First", status: "settled" } });
  ev("node.open", { node: { id: "c1", kind: "card", parentId: "q1", turnId: "q1", role: "assistant", title: "A", summary: "", body: "a", status: "settled" } });
  ev("node.open", { node: { id: "m1", kind: "message", parentId: "c1", turnId: "q1", role: "user", title: "", summary: "", body: "hi", status: "settled" } });
  ev("node.open", { node: { id: "q2", kind: "question", parentId: null, turnId: "q2", role: "user", title: "", summary: "", body: "Second", status: "settled" } });
  ev("node.open", { node: { id: "c2", kind: "card", parentId: "q2", turnId: "q2", role: "assistant", title: "B", summary: "", body: "b", status: "settled" } });
  ev("edge.add", { edge: { id: "e1", from: "c2", to: "c1", rel: "feeds" } });
  return t;
}

describe("reducer", () => {
  test("chat.meta sets and clears title, pinned and group", () => {
    const { s, ev } = twoChats();
    ev("chat.meta", { chatId: "q1", patch: { title: "Renamed", pinned: true } });
    assert.deepEqual(s.chatMeta.q1, { title: "Renamed", pinned: true });
    ev("chat.meta", { chatId: "q1", patch: { title: null, pinned: false } });
    assert.equal(s.chatMeta.q1, undefined, "an empty meta is dropped");
  });

  test("removing a group ungroups its chats", () => {
    const { s, ev } = twoChats();
    ev("group.add", { group: { id: "g1", name: "Work" } });
    ev("chat.meta", { chatId: "q1", patch: { groupId: "g1" } });
    ev("group.patch", { id: "g1", patch: { name: "Job" } });
    assert.equal(s.groups[0].name, "Job");
    ev("group.remove", { id: "g1" });
    assert.deepEqual(s.groups, []);
    assert.equal(s.chatMeta.q1, undefined);
  });

  test("notes are set and cleared by empty text", () => {
    const { s, ev } = twoChats();
    ev("note.set", { targetId: "c1", text: "check this" });
    assert.equal(s.notes.c1.text, "check this");
    ev("note.set", { targetId: "c1", text: "   " });
    assert.equal(s.notes.c1, undefined);
  });

  test("decisions are scoped; patching the text marks cards out of date again", () => {
    const { s, ev } = twoChats();
    ev("decision.pin", { decision: { id: "d1", text: "Everywhere", sourceNodeId: null, affects: [] } });
    ev("decision.pin", { decision: { id: "d2", text: "Only chat 1", sourceNodeId: null, affects: ["c1"], scope: "q1" } });
    assert.equal(s.decisions[0].scope, null, "an old decision without scope applies everywhere");
    assert.deepEqual(decisionsFor(s, "q1").map((d) => d.id), ["d1", "d2"]);
    assert.deepEqual(decisionsFor(s, "q2").map((d) => d.id), ["d1"]);
    assert.equal(s.nodes.c1.status, "stale");
    s.nodes.c1.status = "settled"; // as after a refresh
    delete s.nodes.c1.staleBecause;
    ev("decision.patch", { id: "d2", patch: { text: "Only chat 1, edited" } });
    assert.equal(s.decisions[1].text, "Only chat 1, edited");
    assert.equal(s.nodes.c1.status, "stale");
    assert.equal(s.nodes.c1.staleBecause, "d2");
  });

  test("chat.delete removes the chat and everything only it owned", () => {
    const { s, ev } = twoChats();
    ev("decision.pin", { decision: { id: "d1", text: "global", sourceNodeId: "c1", affects: ["c1", "c2"] } });
    ev("decision.pin", { decision: { id: "d2", text: "scoped", sourceNodeId: null, affects: ["c2"], scope: "q1" } });
    ev("note.set", { targetId: "c1", text: "n" });
    ev("doc.add", { doc: { id: "f1", chatId: "q1", name: "a.txt", text: "x" } });
    ev("doc.add", { doc: { id: "f2", chatId: "q2", name: "b.txt", text: "y" } });
    ev("chat.meta", { chatId: "q1", patch: { title: "T" } });
    ev("chat.delete", { chatId: "q1" });
    assert.deepEqual(chats(s).map((c) => c.id), ["q2"]);
    assert.deepEqual(Object.keys(s.nodes).sort(), ["c2", "q2"]);
    assert.deepEqual(s.edges, []);
    assert.deepEqual(s.decisions.map((d) => d.id), ["d1"]);
    assert.deepEqual(s.decisions[0].affects, ["c2"]);
    assert.equal(s.decisions[0].sourceNodeId, null);
    assert.equal(s.nodes.c2.staleBecause, "d1", "c2 was stale because of d1 (pinned first), which stays");
    assert.deepEqual(s.notes, {});
    assert.deepEqual(docsOf(s, "q2").map((d) => d.id), ["f2"]);
    assert.equal(s.docs.length, 1);
    assert.equal(s.chatMeta.q1, undefined);
  });
});

// ---------- context ----------

describe("context", () => {
  test("documents of the chat are sent, cut when long; decisions of other chats are not", () => {
    const { s, ev } = twoChats();
    ev("doc.add", { doc: { id: "f1", chatId: "q1", name: "spec.md", text: "THE-SPEC-TEXT" } });
    ev("doc.add", { doc: { id: "f2", chatId: "q2", name: "other.md", text: "OTHER-TEXT" } });
    ev("decision.pin", { decision: { id: "d1", text: "ONLY-CHAT-2", sourceNodeId: null, affects: [], scope: "q2" } });
    ev("decision.pin", { decision: { id: "d2", text: "ALL-CHATS", sourceNodeId: null, affects: [] } });
    const ctx = buildContext(s, "c1", { text: "?" });
    const all = JSON.stringify(ctx.messages);
    assert.match(all, /<document name=\\"spec.md\\">\\nTHE-SPEC-TEXT/);
    assert.doesNotMatch(all, /OTHER-TEXT/);
    assert.doesNotMatch(all, /ONLY-CHAT-2/);
    assert.match(all, /1\. ALL-CHATS/);
    assert.ok(ctx.sections.some((x) => x.name === "documents" && x.cached));

    ev("doc.add", { doc: { id: "f3", chatId: "q1", name: "big.txt", text: "z".repeat(300_000) } });
    const big = JSON.stringify(buildContext(s, "c1", { text: "?" }).messages);
    assert.match(big, /cut here: the document is 300000 characters long/);
  });

  test("a new question sees its chat's documents first, cached", () => {
    const { s, ev } = twoChats();
    ev("doc.add", { doc: { id: "f1", chatId: "q2", name: "notes.txt", text: "DOC" } });
    const ctx = buildAskContext(s, "q2", { maxCards: 3 });
    const first = ctx.messages[0].content[0];
    assert.match(first.text, /^<documents>/);
    assert.deepEqual(first.cache_control, { type: "ephemeral" });
  });
});

// ---------- API ----------

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function start(dataDir = null) {
  const quiet = { log() {}, warn() {}, error() {} };
  return startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet, dataDir });
}

async function call(app, method, p, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(app.url + p, init);
  return { status: res.status, body: await res.json() };
}

describe("API", () => {
  test("ask with documents, add and remove one, notes, rename, pin and group a chat", async () => {
    const app = await start();
    try {
      const ask = await call(app, "POST", "/api/ask", { text: "Summarise the plan", docs: [{ name: "plan.md", text: "# Plan\nShip it.", mime: "text/markdown", size: 15 }] });
      assert.equal(ask.status, 202);
      const chatId = ask.body.turnId;
      await app.engine.idle();
      const s = app.log.state;
      assert.deepEqual(docsOf(s, chatId).map((d) => [d.name, d.chars]), [["plan.md", 15]]);

      const add = await call(app, "POST", `/api/chats/${chatId}/docs`, { docs: [{ name: "extra.txt", text: "more" }] });
      assert.equal(add.status, 201);
      assert.equal(add.body.docs[0].text, undefined, "the reply does not echo the text");
      const card = cardsOf(s, chatId)[0];
      const ctx = await call(app, "GET", `/api/context/${card.id}`);
      assert.ok(ctx.body.sections.some((x) => x.name === "documents"));
      assert.equal((await call(app, "DELETE", `/api/docs/${add.body.docs[0].id}`)).status, 200);
      assert.equal(docsOf(s, chatId).length, 1);
      assert.equal((await call(app, "POST", "/api/ask", { text: "x", docs: [{ name: "n" }] })).status, 400);

      assert.equal((await call(app, "PUT", `/api/notes/${card.id}`, { text: "my note" })).status, 200);
      assert.equal(s.notes[card.id].text, "my note");
      assert.equal((await call(app, "PUT", `/api/notes/${chatId}`, { text: "chat note" })).status, 200);
      assert.equal((await call(app, "PUT", "/api/notes/n_999", { text: "x" })).status, 404);

      assert.equal((await call(app, "PATCH", `/api/chats/${chatId}`, { title: "  My   plan ", pinned: true })).status, 200);
      assert.deepEqual(s.chatMeta[chatId], { title: "My plan", pinned: true });
      const g = await call(app, "POST", "/api/groups", { name: "Work", chatIds: [chatId] });
      assert.equal(g.status, 201);
      assert.equal(s.chatMeta[chatId].groupId, g.body.group.id);
      assert.equal((await call(app, "PATCH", `/api/groups/${g.body.group.id}`, { name: "Job" })).body.group.name, "Job");
      assert.equal((await call(app, "PATCH", `/api/chats/${chatId}`, { groupId: "g_404" })).status, 404);
      assert.equal((await call(app, "DELETE", `/api/groups/${g.body.group.id}`)).status, 200);
      assert.equal(s.chatMeta[chatId].groupId, undefined);
      assert.equal((await call(app, "PATCH", `/api/chats/${card.id}`, { title: "x" })).status, 400, "only a chat's first question");
    } finally {
      await app.close();
    }
  });

  test("decisions: scope to a chat, edit the text, refuse an unknown scope", async () => {
    const app = await start();
    try {
      const a = (await call(app, "POST", "/api/ask", { text: "Pick a database" })).body.turnId;
      const b = (await call(app, "POST", "/api/ask", { text: "Plan a launch" })).body.turnId;
      await app.engine.idle();
      const s = app.log.state;
      const cardA = cardsOf(s, a)[0];
      const pin = await call(app, "POST", "/api/decisions", { text: "Use SQLite", scope: a, affects: [cardA.id] });
      assert.equal(pin.status, 201);
      assert.equal(pin.body.decision.scope, a);
      assert.equal(s.nodes[cardA.id].status, "stale");
      const ctxB = await call(app, "GET", `/api/context/${cardsOf(s, b)[0].id}`);
      assert.doesNotMatch(JSON.stringify(ctxB.body.messages), /Use SQLite/);
      const ctxA = await call(app, "GET", `/api/context/${cardA.id}`);
      assert.match(JSON.stringify(ctxA.body.messages), /Use SQLite/);
      const edit = await call(app, "PATCH", `/api/decisions/${pin.body.decision.id}`, { text: "Use Postgres" });
      assert.equal(edit.body.decision.text, "Use Postgres");
      assert.equal((await call(app, "POST", "/api/decisions", { text: "x", scope: cardA.id })).status, 400);
      assert.equal((await call(app, "PATCH", "/api/decisions/d_999", { text: "x" })).status, 404);
    } finally {
      await app.close();
    }
  });

  test("deleting a chat removes it, erases it from the stored log, and survives a restart", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "pc-lib-")), ".data");
    dirs.push(path.dirname(dir));
    let app = await start(dir);
    let keep, gone;
    try {
      gone = (await call(app, "POST", "/api/ask", { text: "SECRET-QUESTION about storage", docs: [{ name: "s.txt", text: "SECRET-DOC" }] })).body.turnId;
      keep = (await call(app, "POST", "/api/ask", { text: "Keep this one about storage" })).body.turnId;
      await app.engine.idle();
      await call(app, "PUT", `/api/notes/${gone}`, { text: "SECRET-NOTE" });
      await call(app, "POST", "/api/decisions", { text: "SECRET-DECISION", scope: gone });
      await call(app, "POST", "/api/decisions", { text: "Shared rule" });
      const before = app.log.seq;
      const del = await call(app, "DELETE", `/api/chats/${gone}`);
      assert.deepEqual(del, { status: 200, body: { chatId: gone } });
      assert.deepEqual(chats(app.log.state).map((c) => c.id), [keep]);
      assert.equal(app.log.seq, before + 1, "one chat.delete event");
      assert.equal((await call(app, "DELETE", `/api/chats/${gone}`)).status, 400);
      const replay = app.log.since(0);
      assert.doesNotMatch(JSON.stringify(replay), /SECRET/);
      assert.ok(replay.some((e) => e.type === "redacted"));
      await app.store.flush();
      assert.doesNotMatch(readFileSync(app.store.logFile, "utf8"), /SECRET/);
    } finally {
      await app.close();
    }
    app = await start(dir);
    try {
      assert.deepEqual(chats(app.log.state).map((c) => c.id), [keep]);
      assert.deepEqual(app.log.state.decisions.map((d) => d.text), ["Shared rule"]);
      const next = (await call(app, "POST", "/api/ask", { text: "New one" })).body.turnId;
      assert.ok(Number(next.slice(2)) > Number(gone.slice(2)), "ids are not reused after a restart");
      await app.engine.idle();
    } finally {
      await app.close();
    }
  });
});
