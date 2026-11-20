import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent, createState } from "../shared/project.mjs";
import {
  buildAskContext,
  buildCardContext,
  buildContext,
  buildRefreshContext,
  buildSynthesisContext,
  SYSTEM_PROMPT,
} from "../server/context.mjs";

function world() {
  const s = createState();
  let seq = 0;
  const ev = (type, payload) => applyEvent(s, { seq: ++seq, ts: 1700000000000 + seq, type, ...payload });
  const node = (id, kind, extra) =>
    ev("node.open", {
      node: { id, kind, parentId: null, turnId: "q1", role: "assistant", title: "", summary: "", body: "", status: "settled", ...extra },
    });
  node("q1", "question", {
    role: "user",
    body: "How do we store events, and how do we stream them, and what about caching?",
    shape: "parallel",
    mode: "fanout",
  });
  node("c1", "card", { parentId: "q1", title: "Storage", summary: "Use an append-only log.", body: "STORAGE-BODY: keep a log." });
  node("c2", "card", { parentId: "q1", title: "Streaming", summary: "Use SSE.", body: "STREAMING-BODY: server-sent events." });
  node("c3", "card", { parentId: "q1", title: "Caching", summary: "Cache the prefix.", body: "CACHING-BODY: stable prefix." });
  ev("edge.add", { edge: { id: "e1", from: "c1", to: "c2", rel: "feeds" } });
  // Threads in c1 (sibling of c2), c2 and c3.
  node("m1", "message", { parentId: "c1", role: "user", body: "SIBLING-THREAD-Q: why a log?" });
  node("m2", "message", { parentId: "c1", role: "assistant", body: "SIBLING-THREAD-A: replay." });
  node("m3", "message", { parentId: "c2", role: "user", body: "OWN-THREAD-Q: why not websockets?", quote: "Use SSE" });
  node("m4", "message", { parentId: "c2", role: "assistant", body: "OWN-THREAD-A: one direction is enough." });
  node("m5", "message", { parentId: "c3", role: "user", body: "OTHER-SIBLING-Q: how long?" });
  return { s, ev, node };
}

// A second chat whose card links back to c2 in chat 1.
function addSecondChat({ ev, node }) {
  node("q2", "question", { role: "user", turnId: "q2", body: "How do reconnects work?", shape: "single", mode: "single" });
  node("k1", "card", {
    parentId: "q2",
    turnId: "q2",
    title: "Reconnects",
    summary: "Resume from Last-Event-ID.",
    body: "RECONNECT-BODY: replay after the last seq.",
  });
  ev("edge.add", { edge: { id: "e2", from: "k1", to: "c2", rel: "elaborates" } });
}

const allText = (ctx) =>
  JSON.stringify(ctx.system) + ctx.messages.map((m) => m.content.map((b) => b.text).join("\n")).join("\n");

// system + every block up to and including the one carrying cache_control.
function cachedPrefix(ctx) {
  const blocks = [];
  for (const m of ctx.messages) {
    for (const b of m.content) {
      blocks.push({ role: m.role, block: b });
      if (b.cache_control) return JSON.stringify({ system: ctx.system, blocks });
    }
  }
  throw new Error("no cache breakpoint");
}

const countBreakpoints = (ctx) => ctx.messages.reduce((n, m) => n + m.content.filter((b) => b.cache_control).length, 0);

test("follow-up context has the documented order and sections", () => {
  const { s } = world();
  const ctx = buildContext(s, "c2", { text: "And reconnects?", quote: "server-sent events" });
  assert.deepEqual(
    ctx.sections.map((x) => [x.name, x.cached]),
    [
      ["system prompt", true],
      ["question", true],
      ["outline", true],
      ["existing cards", false],
      ["decisions", false],
      ["focus card", false],
      ["linked cards", false],
      ["thread", false],
      ["new question", false],
    ],
  );
  const first = ctx.messages[0];
  assert.equal(first.role, "user");
  assert.match(first.content[0].text, /^<question>/);
  assert.match(first.content[1].text, /^<outline/);
  assert.deepEqual(first.content[1].cache_control, { type: "ephemeral" });
  assert.match(first.content[2].text, /^<board>/);
  assert.match(first.content[3].text, /^<decisions>/);
  assert.match(first.content[4].text, /^<focus_card>/);
  assert.match(first.content[5].text, /^<linked_cards>/);
  assert.match(first.content[6].text, /OWN-THREAD-Q/);
  assert.match(first.content[6].text, /<selection>\nUse SSE\n<\/selection>/);
  assert.deepEqual(
    ctx.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.match(ctx.messages[1].content[0].text, /OWN-THREAD-A/);
  const last = ctx.messages[2].content.at(-1).text;
  assert.match(last, /And reconnects\?/);
  assert.match(last, /<selection>\nserver-sent events\n<\/selection>/);
  assert.equal(typeof ctx.system, "string");
  assert.equal(countBreakpoints(ctx), 1);
  assert.equal(ctx.sections[1].chars, first.content[0].text.length);
  assert.equal(ctx.sections[2].chars, first.content[1].text.length);
  assert.equal(ctx.sections[3].chars, first.content[2].text.length);
  assert.equal(ctx.sections[8].chars, last.length);
});

test("the system prompt explains how to build the board", () => {
  for (const phrase of ["create_card", "link_cards", "card limit", "key", "elaborates", "sub-card", "Sub-cards"]) {
    assert.ok(SYSTEM_PROMPT.includes(phrase), phrase);
  }
  assert.ok(!/\b(MUST|NEVER|ALWAYS|IMPORTANT)\b/.test(SYSTEM_PROMPT), "explanation, not capitalised orders");
});

test("sibling threads and unlinked sibling bodies are absent", () => {
  const { s } = world();
  const text = allText(buildContext(s, "c2", { text: "q" }));
  assert.ok(!text.includes("SIBLING-THREAD"), "c1's thread must not leak into c2");
  assert.ok(!text.includes("OTHER-SIBLING"), "c3's thread must not leak into c2");
  assert.ok(!text.includes("CACHING-BODY"), "c3 is not linked to c2, so its body is absent");
  assert.ok(text.includes("Cache the prefix."), "but its summary is in the outline");
  assert.ok(text.includes("STREAMING-BODY"), "focus card in full");
  assert.ok(text.includes("STORAGE-BODY"), "linked card (c1 feeds c2) in full");
  assert.ok(text.includes("OWN-THREAD-Q") && text.includes("OWN-THREAD-A"));

  const c3 = allText(buildContext(s, "c3", { text: "q" }));
  assert.ok(c3.includes("OTHER-SIBLING-Q"));
  assert.ok(!c3.includes("OWN-THREAD") && !c3.includes("SIBLING-THREAD"));
  assert.ok(!c3.includes("STORAGE-BODY") && !c3.includes("STREAMING-BODY"));
});

test("cached prefix is byte-identical across cards and unchanged by decisions, replies and a new chat", () => {
  const w = world();
  const { s, ev, node } = w;
  const p1 = cachedPrefix(buildContext(s, "c1", { text: "a" }));
  const p2 = cachedPrefix(buildContext(s, "c2", { text: "b", quote: "x" }));
  const p3 = cachedPrefix(buildContext(s, "c3", { text: "" }));
  assert.equal(p1, p2);
  assert.equal(p2, p3);
  const stateBlocks = p1.replace(JSON.stringify(SYSTEM_PROMPT), ""); // the prompt uses c1, c2 as example keys
  assert.ok(!/\b[ned]_\d|\bm\d\b|\bc\d\b|\bq1\b/.test(stateBlocks), "no node, edge or decision ids in the prefix");
  assert.ok(!p1.includes("1700000000"), "no timestamps in the prefix");

  ev("decision.pin", { decision: { id: "d1", text: "PINNED: use SQLite", sourceNodeId: "c1", affects: ["c2"] } });
  assert.equal(s.nodes.c2.status, "stale");
  node("m6", "message", { parentId: "c2", role: "user", body: "another" });
  node("m7", "message", { parentId: "c2", role: "assistant", body: "reply" });
  addSecondChat(w);
  const after = buildContext(s, "c2", { text: "b" });
  assert.equal(cachedPrefix(after), p1);
  assert.equal(cachedPrefix(buildContext(s, "c1", { text: "z" })), p1);

  // What changed is after the breakpoint: the board, the decision, the new link.
  const blocks = after.messages[0].content;
  assert.match(blocks[2].text, /- k1 \(chat 2\) Reconnects: Resume from Last-Event-ID\./);
  assert.match(blocks[3].text, /1\. PINNED: use SQLite/);
  assert.match(blocks[4].text, /written before decision 1 was pinned/);
  assert.match(blocks[5].text, /Chat 2, card 1: Reconnects/);
});

test("the board lists every card in every chat with id and chat number", () => {
  const w = world();
  addSecondChat(w);
  const board = buildContext(w.s, "k1", { text: "q" }).messages[0].content[2].text;
  assert.match(board, /You are working in chat 2 of 2\./);
  for (const line of [
    "- c1 (chat 1) Storage: Use an append-only log.",
    "- c2 (chat 1) Streaming: Use SSE.",
    "- c3 (chat 1) Caching: Cache the prefix.",
    "- k1 (chat 2, this card) Reconnects: Resume from Last-Event-ID.",
  ]) {
    assert.ok(board.includes(line), line);
  }
});

test("linked cards from other chats are included in full and labelled with their chat", () => {
  const w = world();
  addSecondChat(w);
  const k1 = allText(buildContext(w.s, "k1", { text: "q" }));
  assert.ok(k1.includes("STREAMING-BODY"), "c2 (chat 1) is linked to k1, so its body is present");
  assert.match(k1, /Chat 1, card 2: Streaming \(this card elaborates it\)/);
  assert.ok(!k1.includes("STORAGE-BODY") && !k1.includes("OWN-THREAD"), "unlinked bodies and other threads stay out");
  const c2 = allText(buildContext(w.s, "c2", { text: "q" }));
  assert.match(c2, /Chat 2, card 1: Reconnects \(it elaborates this card\)/);
  assert.ok(c2.includes("RECONNECT-BODY"));
});

test("a new question's context: static system cached, board with the card limit after it", () => {
  const w = world();
  addSecondChat(w);
  w.node("q3", "question", { role: "user", turnId: "q3", body: "NEW-QUESTION about caching", status: "streaming" });
  const ctx = buildAskContext(w.s, "q3", { maxCards: 3, mode: "single" });
  assert.equal(ctx.system, SYSTEM_PROMPT);
  assert.equal(ctx.cacheSystem, true);
  assert.equal(countBreakpoints(ctx), 0);
  const [board, question, task] = ctx.messages[0].content.map((b) => b.text);
  assert.match(board, /This question opens chat 3\./);
  assert.match(board, /Card limit for this answer: 3 cards\./);
  assert.match(board, /- k1 \(chat 2\) Reconnects/);
  assert.match(question, /NEW-QUESTION about caching/);
  assert.match(task, /create_card/);
  const fan = buildAskContext(w.s, "q3", { maxCards: 3, mode: "fanout" });
  assert.match(fan.messages[0].content.at(-1).text, /intent/);
  assert.equal(fan.system, ctx.system, "the same system prompt in both modes");
});

test("fan-out writer contexts share a prefix and ask for only one card", () => {
  const { s } = world();
  const intents = { c1: "storage part", c2: "streaming part", c3: "caching part" };
  const a = buildCardContext(s, "c1", { intents });
  const b = buildCardContext(s, "c3", { intents });
  assert.equal(cachedPrefix(a), cachedPrefix(b));
  const t = allText(b);
  assert.match(t, /Write only Card 3: Caching/);
  assert.match(t, /Intent: storage part/, "the outline lists every card's intent");
  assert.match(t, /write_card/);
  assert.ok(!t.includes("CACHING-BODY") && !t.includes("STORAGE-BODY"));
});

test("refresh, synthesis and empty-question builders", () => {
  const { s, ev } = world();
  ev("decision.pin", { decision: { id: "d1", text: "PINNED-DECISION", sourceNodeId: "c1", affects: ["c2"] } });
  const r = allText(buildRefreshContext(s, "c2"));
  assert.ok(r.includes("PINNED-DECISION"));
  assert.ok(r.includes("STREAMING-BODY"), "the old body");
  assert.match(r, /Rewrite Card 2 \(Streaming\) in light of the pinned decisions, especially decision 1/);
  assert.match(r, /write_card/);

  const syn = allText(buildSynthesisContext(s, ["c1", "c3"]));
  assert.ok(syn.includes("STORAGE-BODY") && syn.includes("CACHING-BODY"));
  assert.ok(!syn.includes("STREAMING-BODY"));
  assert.ok(syn.includes("PINNED-DECISION"));

  const empty = buildContext(s, "c1", { text: "" });
  assert.equal(empty.sections.at(-1).chars, 0);
  assert.equal(empty.messages.at(-1).role, "assistant", "thread so far ends with the last reply");
  for (const m of empty.messages) for (const b of m.content) assert.ok(b.text.length > 0);
});
