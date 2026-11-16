import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, cardOf, cardsInOrder, cardsOf, chatOf, chats, createState, edgesOf, threadOf, turns } from "../shared/project.mjs";

function node(id, kind, extra = {}) {
  return {
    id,
    kind,
    parentId: null,
    turnId: "q1",
    role: kind === "card" ? "assistant" : "user",
    title: "",
    summary: "",
    body: "",
    status: "settled",
    ...extra,
  };
}

// A fresh state with one turn: q1 -> cards c1, c2, c3; c1 has a two-message thread.
function fixture() {
  const s = createState();
  let seq = 0;
  const ev = (type, payload) => applyEvent(s, { seq: ++seq, ts: 0, type, ...payload });
  ev("node.open", { node: node("q1", "question", { body: "Q?", status: "streaming", shape: "parallel", mode: "fanout" }) });
  ev("node.open", { node: node("c1", "card", { parentId: "q1", title: "One" }) });
  ev("node.open", { node: node("c2", "card", { parentId: "q1", title: "Two" }) });
  ev("node.open", { node: node("c3", "card", { parentId: "q1", title: "Three", status: "streaming" }) });
  ev("node.open", { node: node("m1", "message", { parentId: "c1", body: "why?" }) });
  ev("node.open", { node: node("m2", "message", { parentId: "c1", role: "assistant", body: "because" }) });
  ev("edge.add", { edge: { id: "e1", from: "c1", to: "c2", rel: "feeds" } });
  ev("edge.add", { edge: { id: "e2", from: "c3", to: "c1", rel: "elaborates" } });
  return { s, ev, next: () => seq + 1 };
}

test("createState returns the documented empty shape", () => {
  assert.deepEqual(createState(), { seq: 0, nodes: {}, order: [], edges: [], decisions: [], chatMeta: {}, groups: [], notes: {}, docs: [] });
});

test("node.open inserts a copy, records seq and open order", () => {
  const s = createState();
  const n = node("q1", "question");
  const event = { seq: 1, ts: 5, type: "node.open", node: n };
  applyEvent(s, event);
  assert.equal(s.seq, 1);
  assert.deepEqual(s.order, ["q1"]);
  assert.equal(s.nodes.q1.seq, 1);
  assert.equal(s.nodes.q1.body, "");
  s.nodes.q1.body = "changed";
  assert.equal(event.node.body, "", "state must not alias the event payload");
});

test("node.delta appends to summary and body", () => {
  const { s, ev } = fixture();
  ev("node.delta", { id: "c3", field: "summary", text: "Sum" });
  ev("node.delta", { id: "c3", field: "summary", text: "mary" });
  ev("node.delta", { id: "c3", field: "body", text: "Hel" });
  ev("node.delta", { id: "c3", field: "body", text: "lo" });
  assert.equal(s.nodes.c3.summary, "Summary");
  assert.equal(s.nodes.c3.body, "Hello");
  ev("node.delta", { id: "c3", field: "title", text: "x" });
  assert.equal(s.nodes.c3.title, "Three", "only summary and body take deltas");
});

test("node.patch shallow-merges", () => {
  const { s, ev } = fixture();
  ev("node.patch", { id: "q1", patch: { shape: "steps" } });
  assert.equal(s.nodes.q1.shape, "steps");
  assert.equal(s.nodes.q1.body, "Q?");
});

test("node.close sets status and error", () => {
  const { s, ev } = fixture();
  ev("node.close", { id: "c3", status: "error", error: "boom" });
  assert.equal(s.nodes.c3.status, "error");
  assert.equal(s.nodes.c3.error, "boom");
  ev("node.close", { id: "q1", status: "cancelled" });
  assert.equal(s.nodes.q1.status, "cancelled");
  assert.equal(s.nodes.q1.error, undefined);
});

test("node.reset clears text, streams again, drops error and staleBecause", () => {
  const { s, ev } = fixture();
  ev("node.delta", { id: "c2", field: "body", text: "old" });
  ev("decision.pin", { decision: { id: "d1", text: "x", sourceNodeId: "c1", affects: ["c2"] } });
  assert.equal(s.nodes.c2.status, "stale");
  ev("node.reset", { id: "c2" });
  assert.equal(s.nodes.c2.status, "streaming");
  assert.equal(s.nodes.c2.body, "");
  assert.equal(s.nodes.c2.summary, "");
  assert.ok(!("staleBecause" in s.nodes.c2));
  ev("node.close", { id: "c3", status: "error", error: "boom" });
  ev("node.reset", { id: "c3" });
  assert.ok(!("error" in s.nodes.c3));
});

test("edge.add inserts once", () => {
  const { s, ev } = fixture();
  assert.equal(s.edges.length, 2);
  ev("edge.add", { edge: { id: "e1", from: "c1", to: "c2", rel: "feeds" } });
  assert.equal(s.edges.length, 2);
});

test("decision.pin marks settled affected cards stale; others untouched", () => {
  const { s, ev } = fixture();
  ev("decision.pin", { decision: { id: "d1", text: "Use SQLite", sourceNodeId: "m1", affects: ["c2", "c3"] } });
  assert.equal(s.decisions.length, 1);
  assert.equal(s.nodes.c2.status, "stale");
  assert.equal(s.nodes.c2.staleBecause, "d1");
  assert.equal(s.nodes.c3.status, "streaming", "a streaming card is not marked stale");
  assert.equal(s.nodes.c1.status, "settled");
});

test("decision.unpin reverts only cards stale because of it", () => {
  const { s, ev } = fixture();
  ev("decision.pin", { decision: { id: "d1", text: "A", sourceNodeId: null, affects: ["c2"] } });
  ev("decision.pin", { decision: { id: "d2", text: "B", sourceNodeId: null, affects: ["c1"] } });
  assert.equal(s.nodes.c1.status, "stale");
  assert.equal(s.nodes.c2.status, "stale");
  ev("decision.unpin", { id: "d1" });
  assert.deepEqual(
    s.decisions.map((d) => d.id),
    ["d2"],
  );
  assert.equal(s.nodes.c2.status, "settled");
  assert.ok(!("staleBecause" in s.nodes.c2));
  assert.equal(s.nodes.c1.status, "stale");
  assert.equal(s.nodes.c1.staleBecause, "d2");
});

test("session.reset clears everything and seq keeps counting", () => {
  const { s, ev } = fixture();
  ev("decision.pin", { decision: { id: "d1", text: "A", sourceNodeId: null, affects: [] } });
  const before = s.seq;
  ev("session.reset", {});
  assert.equal(s.seq, before + 1);
  assert.deepEqual(s.nodes, {});
  assert.deepEqual(s.order, []);
  assert.deepEqual(s.edges, []);
  assert.deepEqual(s.decisions, []);
});

test("events with seq <= state.seq are ignored", () => {
  const { s, next } = fixture();
  const delta = { seq: next(), ts: 0, type: "node.delta", id: "c3", field: "body", text: "once" };
  applyEvent(s, delta);
  applyEvent(s, delta);
  applyEvent(s, { ...delta, seq: 1 });
  assert.equal(s.nodes.c3.body, "once");
  assert.equal(s.seq, delta.seq);
});

test("selectors", () => {
  const { s, ev } = fixture();
  ev("node.open", { node: node("q2", "question", { turnId: "q2" }) });
  ev("node.open", { node: node("c4", "card", { parentId: "q2", turnId: "q2" }) });
  assert.deepEqual(
    turns(s).map((n) => n.id),
    ["q1", "q2"],
  );
  assert.deepEqual(
    cardsOf(s, "q1").map((n) => n.id),
    ["c1", "c2", "c3"],
  );
  assert.deepEqual(
    threadOf(s, "c1").map((n) => n.id),
    ["m1", "m2"],
  );
  assert.deepEqual(threadOf(s, "c2"), []);
  assert.deepEqual(
    edgesOf(s, "c1").map((e) => e.id),
    ["e1", "e2"],
  );
  assert.equal(cardOf(s, "c2").id, "c2");
  assert.equal(cardOf(s, "m2").id, "c1");
  assert.equal(cardOf(s, "q1"), null);
  assert.equal(cardOf(s, "nope"), null);
});

// Chat q1 holds questions q1 and q2; q3, q4 and q5 are chats of their own.
function flowFixture() {
  const s = createState();
  let seq = 0;
  const ev = (type, payload) => applyEvent(s, { seq: ++seq, ts: 0, type, ...payload });
  const q = (id, extra = {}) => ev("node.open", { node: node(id, "question", { turnId: id, ...extra }) });
  const card = (id, turnId, extra = {}) => ev("node.open", { node: node(id, "card", { parentId: turnId, turnId, ...extra }) });
  q("q1");
  card("a", "q1");
  card("b", "q1");
  card("b1", "q1", { origin: { cardId: "a", text: "why?" } }); // branch of a
  card("bb", "q1", { origin: { cardId: "b1", text: "and then?" } }); // branch of a branch
  card("b2", "q1", { origin: { cardId: "a", text: "how?", quote: "x" } }); // second branch of a
  q("q2", { chatId: "q1" });
  card("c", "q2");
  card("c1", "q2", { origin: { cardId: "c", text: "more" } });
  ev("node.open", { node: node("m", "message", { parentId: "c1", turnId: "q2" }) });
  q("q3");
  q("q4", { chatId: "q2" }); // not a first question: starts its own chat
  q("q5", { chatId: "missing" });
  return s;
}

test("chats groups questions by chatId", () => {
  const s = flowFixture();
  assert.deepEqual(
    chats(s).map((c) => [c.id, c.questions.map((q) => q.id)]),
    [
      ["q1", ["q1", "q2"]],
      ["q3", ["q3"]],
      ["q4", ["q4"]],
      ["q5", ["q5"]],
    ],
  );
  assert.deepEqual(
    turns(s).map((q) => q.id),
    ["q1", "q2", "q3", "q4", "q5"],
    "turns is unchanged",
  );
});

test("chatOf resolves questions, cards, branches and messages", () => {
  const s = flowFixture();
  assert.equal(chatOf(s, "q1"), "q1");
  assert.equal(chatOf(s, "q2"), "q1");
  assert.equal(chatOf(s, "a"), "q1");
  assert.equal(chatOf(s, "c1"), "q1", "a branch in the chat's second question");
  assert.equal(chatOf(s, "m"), "q1", "a message under that branch");
  assert.equal(chatOf(s, "q4"), "q4");
  assert.equal(chatOf(s, "q5"), "q5");
  assert.equal(chatOf(s, "nope"), null);
});

test("cardsInOrder puts branches right after their source and its earlier branches", () => {
  const s = flowFixture();
  assert.deepEqual(
    cardsInOrder(s, "q1").map((c) => c.id),
    ["a", "b1", "bb", "b2", "b"],
  );
  assert.deepEqual(
    cardsInOrder(s, "q2").map((c) => c.id),
    ["c", "c1"],
    "branches stay with the question of their source",
  );
  assert.deepEqual(
    cardsOf(s, "q1").map((c) => c.id),
    ["a", "b", "b1", "bb", "b2"],
    "cardsOf keeps open order",
  );
  assert.deepEqual(cardsInOrder(s, "q3"), []);
});
