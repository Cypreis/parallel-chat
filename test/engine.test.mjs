import assert from "node:assert/strict";
import { test } from "node:test";
import { cardsOf, threadOf, turns } from "../shared/project.mjs";
import { buildContext } from "../server/context.mjs";
import { computeAffects, createEngine, inferShape } from "../server/engine.mjs";
import { createLog } from "../server/log.mjs";
import { cardBody, cardSummary, createMockProvider, derivePlan, mockScript } from "../server/providers/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const Q3 = "How should we store events, and how do we stream them to the browser, and what about caching?";

function setup({ provider = createMockProvider({ speed: 1000 }), mode = "single", maxCards = 4 } = {}) {
  const log = createLog();
  const engine = createEngine({ log, provider, mode, maxCards, logger: quiet });
  return { log, s: log.state, engine, provider };
}

// Wraps a provider and records what each call was sent and what it returned.
function recording(inner) {
  const calls = [];
  return {
    name: inner.name,
    model: inner.model,
    calls,
    async *stream(args) {
      const entry = { messages: structuredClone(args.messages), tools: args.tools.map((t) => t.name), meta: args.meta, events: [] };
      calls.push(entry);
      for await (const ev of inner.stream(args)) {
        entry.events.push(ev);
        yield ev;
      }
    },
  };
}

// A provider that plays back fixed rounds. Tool input is sent 3 characters
// at a time; `raw` overrides the JSON text (to send malformed input).
function scripted(rounds) {
  let n = 0;
  return {
    name: "mock",
    model: "scripted",
    async *stream({ messages, meta }) {
      const step = rounds[Math.min(n++, rounds.length - 1)];
      const { blocks = [], stop = "end_turn", message, error } = typeof step === "function" ? step(messages, meta) : step;
      const content = [];
      for (const b of blocks) {
        if (b.type === "text") {
          yield { type: "text", text: b.text };
          content.push(b);
        } else if (b.type === "thinking") content.push(b);
        else {
          yield { type: "tool_start", id: b.id, name: b.name };
          const json = b.raw ?? JSON.stringify(b.input);
          for (let i = 0; i < json.length; i += 3) {
            await new Promise((r) => setImmediate(r));
            yield { type: "tool_delta", id: b.id, json: json.slice(i, i + 3) };
          }
          yield { type: "tool_end", id: b.id };
          content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
        }
      }
      if (error) throw error;
      yield { type: "stop", reason: stop, content, message };
    },
  };
}

const results = (call) => call.messages.at(-1).content.filter((b) => b.type === "tool_result");

test("mock planner derives titles and shapes from the question", () => {
  const two = derivePlan("How should we store events, and how do we stream them to the browser?");
  assert.deepEqual(
    two.cards.map((c) => c.title),
    ["Store events", "Stream them to the browser"],
  );
  assert.deepEqual(two.links, [{ from: "c1", to: "c2", rel: "feeds" }]);
  const single = derivePlan("What is SSE?");
  assert.equal(single.shape, "single");
  assert.equal(single.cards[0].title, "SSE");
  assert.equal(derivePlan("Set it up: 1. install node 2. configure the server 3. deploy it").shape, "steps");
  assert.equal(derivePlan("Postgres for the log vs SQLite for the log").shape, "comparison");
  assert.equal(derivePlan("Why use a log? How big can it get? Who reads it? When is it trimmed? Where does it live?").cards.length, 4);
  assert.deepEqual(
    derivePlan(
      "Plan a three-week rollout of a new onboarding flow: what to build first, how to measure whether it works, and what could go wrong.",
    ).cards.map((c) => c.title),
    ["What to build first", "How to measure whether it works", "What could go wrong"],
  );
});

test("mock tool input arrives as awkward partial JSON that reassembles exactly", async () => {
  const p = createMockProvider({ speed: 1000 });
  const events = [];
  for await (const ev of p.stream({ messages: [], meta: { purpose: "turn", question: Q3, existing: [] } })) events.push(ev);
  const stop = events.at(-1);
  assert.equal(stop.type, "stop");
  assert.equal(stop.reason, "tool_use");
  assert.equal(stop.content[0].type, "thinking", "a thinking block comes back in the content");
  const uses = stop.content.filter((b) => b.type === "tool_use");
  assert.equal(uses.filter((u) => u.name === "create_card").length, 3);
  let splitEscapes = 0;
  let unicodeEscapes = 0;
  for (const use of uses) {
    const deltas = events.filter((e) => e.type === "tool_delta" && e.id === use.id).map((e) => e.json);
    assert.deepEqual(JSON.parse(deltas.join("")), use.input);
    splitEscapes += deltas.filter((d) => d.endsWith("\\")).length;
    unicodeEscapes += (deltas.join("").match(/\\u[0-9a-f]{4}/g) ?? []).length;
  }
  assert.ok(splitEscapes > 5, `chunks end mid-escape (${splitEscapes})`);
  assert.ok(unicodeEscapes > 0, "some non-ASCII arrives as \\u escapes");
  assert.equal(events.filter((e) => e.type === "tool_start").length, events.filter((e) => e.type === "tool_end").length);

  const ctl = new AbortController();
  const slow = createMockProvider({ speed: 1 });
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(
    (async () => {
      for await (const _ of slow.stream({ messages: [], signal: ctl.signal, meta: { purpose: "turn", question: Q3 } }));
    })(),
    { name: "AbortError" },
  );
});

test("engine loop, single mode: cards stream from create_card and the content is replayed exactly", async () => {
  const provider = recording(createMockProvider({ speed: 1000 }));
  const { s, log, engine } = setup({ provider, mode: "single" });
  const { turnId } = engine.ask({ text: Q3 });
  await engine.idle();
  assert.equal(s.nodes[turnId].status, "settled");
  assert.equal(s.nodes[turnId].shape, "parallel");
  const cards = cardsOf(s, turnId);
  assert.deepEqual(
    cards.map((c) => c.title),
    ["Store events", "Stream them to the browser", "Caching"],
  );
  const plan = derivePlan(Q3);
  cards.forEach((c, i) => {
    assert.equal(c.status, "settled");
    assert.equal(c.summary, cardSummary(c.title, Q3));
    assert.equal(c.body, cardBody(c.title, Q3, plan.cards[i].intent), "streamed text decodes exactly");
  });
  const events = log.since(0);
  assert.ok(!events.some((e) => e.type === "node.patch" && e.patch.body !== undefined), "no correction was needed");
  for (const c of cards) {
    assert.ok(events.filter((e) => e.type === "node.delta" && e.id === c.id && e.field === "body").length > 20, "body streamed in pieces");
  }
  assert.equal(s.edges.length, 2);

  // Two calls: the second carries the first's content unchanged, then all results in one user message.
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[0].tools, ["create_card", "link_cards"]);
  const first = provider.calls[0].events.at(-1);
  const second = provider.calls[1].messages;
  assert.deepEqual(second.at(-2), { role: "assistant", content: first.content });
  assert.equal(second.at(-2).content[0].type, "thinking");
  const uses = first.content.filter((b) => b.type === "tool_use");
  assert.deepEqual(
    results(provider.calls[1]).map((r) => r.tool_use_id),
    uses.map((u) => u.id),
  );
  assert.ok(results(provider.calls[1]).every((r) => !r.is_error));
  assert.deepEqual(JSON.parse(results(provider.calls[1])[0].content), { id: cards[0].id });
});

test("engine loop, fan-out mode: planned cards open first, writers fill them concurrently", async () => {
  const provider = recording(createMockProvider({ speed: 1000 }));
  const { s, log, engine } = setup({ provider, mode: "fanout" });
  const { turnId } = engine.ask({ text: Q3 });
  await engine.idle();
  assert.equal(s.nodes[turnId].status, "settled");
  const cards = cardsOf(s, turnId);
  assert.equal(cards.length, 3);
  for (const c of cards) {
    assert.equal(c.status, "settled");
    assert.ok(c.summary && c.body.length > 100);
  }
  const planner = provider.calls.filter((c) => c.meta.purpose === "plan");
  const writers = provider.calls.filter((c) => c.meta.purpose === "card");
  assert.equal(planner.length, 2);
  assert.equal(writers.length, 3);
  assert.deepEqual(writers[0].tools, ["write_card"]);
  const prefix = (call) => JSON.stringify(call.messages[0].content.slice(0, 2));
  assert.equal(prefix(writers[0]), prefix(writers[2]), "writers of one round share their cached prefix");
  const events = log.since(0);
  const lastOpen = Math.max(...events.filter((e) => e.type === "node.open" && e.node.kind === "card").map((e) => e.seq));
  const deltas = events.filter((e) => e.type === "node.delta");
  assert.ok(lastOpen < deltas[0].seq, "all cards open before any body streams");
  let switches = 0;
  for (let i = 1; i < deltas.length; i++) if (deltas[i].id !== deltas[i - 1].id) switches++;
  assert.ok(switches > 20, "writers stream concurrently");
});

test("the card cap: a create_card past maxCards gets an error result and creates nothing", async () => {
  const provider = recording(createMockProvider({ speed: 1000 }));
  const { s, engine } = setup({ provider, mode: "single", maxCards: 2 });
  assert.equal(engine.getConfig().maxCards, 2);
  const { turnId } = engine.ask({ text: Q3 });
  await engine.idle();
  assert.equal(cardsOf(s, turnId).length, 2);
  assert.equal(s.nodes[turnId].status, "settled");
  const rs = results(provider.calls[1]);
  const errors = rs.filter((r) => r.is_error);
  assert.equal(errors.length, 2, "the third card and the link to it");
  assert.match(errors[0].content, /Card limit reached: this answer may create at most 2 cards/);
  assert.match(errors[1].content, /Unknown card "c3"/);
  assert.match(provider.calls[0].messages[0].content[0].text, /Card limit for this answer: 2 cards\./);
  assert.throws(() => engine.setConfig({ maxCards: 7 }), /maxCards must be an integer from 1 to 6/);
  assert.equal(engine.setConfig({ maxCards: 6 }).maxCards, 6);
  assert.equal(engine.setConfig({ mode: "fanout" }).maxCards, 6, "either field alone");
});

test("cross-chat links: by a later question and by a thread reply", async () => {
  const { s, engine } = setup({ mode: "single" });
  const chat1 = engine.ask({ text: Q3 }).turnId;
  await engine.idle();
  const [store, stream, caching] = cardsOf(s, chat1);

  // A later question that touches "caching" links one of its cards to chat 1's Caching card.
  const chat2 = engine.ask({ text: "How should caching interact with replay after a restart?" }).turnId;
  await engine.idle();
  assert.equal(turns(s).length, 2);
  const cross = s.edges.filter((e) => s.nodes[e.from].turnId !== s.nodes[e.to].turnId);
  assert.equal(cross.length, 1);
  assert.equal(s.nodes[cross[0].from].turnId, chat2);
  assert.equal(cross[0].to, caching.id);
  assert.equal(cross[0].rel, "elaborates");

  // A thread reply in chat 2 that names the browser links its card to chat 1's streaming card.
  const focus = cardsOf(s, chat2)[0];
  const r = engine.reply(focus.id, { text: "Does the browser need anything special here?" });
  await engine.idle();
  const link = s.edges.find((e) => e.from === focus.id && e.to === stream.id);
  assert.ok(link, "reply created a cross-chat link");
  const reply = s.nodes[r.assistantNodeId];
  assert.equal(reply.status, "settled");
  assert.match(reply.body, /^That touches \*Stream them to the browser\* in chat 1, so I'll link them\.\n\nLinked this card to/);
  assert.equal(threadOf(s, focus.id).length, 2, "text after the tool round stayed in the same message node");

  // The follow-up context now has the linked card in full, labelled with its chat.
  const ctx = buildContext(s, focus.id, { text: "next" });
  const linked = ctx.messages[0].content[5].text;
  assert.match(linked, /Chat 1, card 2: Stream them to the browser \(this card elaborates it\)/);
  assert.match(linked, /Chat 1, card 3: Caching \(this card elaborates it\)/, "the link made by the second question");
  assert.ok(linked.includes(stream.body.trim()), "the cross-chat card's body in full");
  assert.ok(!linked.includes(`: ${store.title} (`), "unlinked cards stay out");
});

test("an invalid tool input is answered with an error result, not a crash", async () => {
  const valid = { key: "c9", title: "Fixed", summary: "Works now.", body: "Body." };
  const provider = recording(
    scripted([
      {
        blocks: [
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "t1", name: "create_card", input: { key: "c1", title: "Broken" } },
          { type: "tool_use", id: "t2", name: "create_card", raw: '{"key":"c2","title":"Half","summary":"x","body":"cut', input: {} },
          { type: "tool_use", id: "t3", name: "link_cards", input: { from: "c1", to: "c2", rel: "likes" } },
          { type: "tool_use", id: "t4", name: "mystery", input: {} },
        ],
        stop: "tool_use",
      },
      { blocks: [{ type: "tool_use", id: "t5", name: "create_card", input: valid }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" },
    ]),
  );
  const { s, engine } = setup({ provider, mode: "single" });
  const { turnId } = engine.ask({ text: "anything" });
  await engine.idle();
  const rs = results(provider.calls[1]);
  assert.equal(rs.length, 4);
  assert.ok(rs.every((r) => r.is_error));
  assert.match(rs[0].content, /Invalid create_card input: missing required field "summary"/);
  assert.match(rs[1].content, /INVALID_JSON/);
  assert.match(rs[2].content, /field "rel" must be one of/);
  assert.match(rs[3].content, /Unknown tool "mystery"/);
  assert.equal(provider.calls[1].messages.at(-2).content[0].signature, "sig-1");
  const cards = cardsOf(s, turnId);
  assert.deepEqual(
    cards.map((c) => [c.title, c.status]),
    [
      ["Broken", "error"],
      ["Half", "error"],
      ["Fixed", "settled"],
    ],
  );
  assert.equal(s.nodes[turnId].status, "settled");
});

test("a refusal or max_tokens closes the question as error; a text-only answer becomes one card", async () => {
  for (const [stop, pattern] of [
    ["refusal", /declined this request \(cyber\)/],
    ["max_tokens", /max_tokens/],
  ]) {
    const provider = scripted([
      {
        blocks: [{ type: "tool_use", id: "t1", name: "create_card", raw: '{"key":"c1","title":"Partial","summary":"s","body":"half', input: {} }],
        stop,
        message: stop === "refusal" ? "The model declined this request (cyber)." : undefined,
      },
    ]);
    const { s, engine } = setup({ provider });
    const { turnId } = engine.ask({ text: "x" });
    await engine.idle();
    assert.equal(s.nodes[turnId].status, "error");
    assert.match(s.nodes[turnId].error, pattern);
    assert.equal(cardsOf(s, turnId)[0].status, "error", "the cut-off card is not settled");
  }
  const plain = scripted([{ blocks: [{ type: "text", text: "Just text, no cards." }], stop: "end_turn" }]);
  const { s, engine } = setup({ provider: plain });
  const { turnId } = engine.ask({ text: "x" });
  await engine.idle();
  const [card] = cardsOf(s, turnId);
  assert.equal(card.title, "Answer");
  assert.equal(card.body, "Just text, no cards.");
  assert.equal(s.nodes[turnId].shape, "single");
});

test("a tool input the SDK cannot parse re-issues the round", async () => {
  const err = Object.assign(new Error("bad json"), { retryRound: true });
  const valid = { key: "c1", title: "Second try", summary: "s", body: "b" };
  const provider = scripted([
    { blocks: [{ type: "tool_use", id: "t1", name: "create_card", input: valid }], error: err },
    { blocks: [{ type: "tool_use", id: "t2", name: "create_card", input: valid }], stop: "tool_use" },
    { blocks: [], stop: "end_turn" },
  ]);
  const { s, engine } = setup({ provider });
  const { turnId } = engine.ask({ text: "x" });
  await engine.idle();
  const cards = cardsOf(s, turnId);
  assert.deepEqual(
    cards.map((c) => c.status),
    ["error", "settled"],
    "the failed attempt's card is closed, the retry reuses its key",
  );
  assert.equal(s.nodes[turnId].status, "settled");
});

test("provider failures are contained: planner, one writer, a single-mode stream", async () => {
  const mock = createMockProvider({ speed: 1000 });
  const failing = (predicate, message) => ({
    name: "mock",
    model: "mock",
    async *stream(args) {
      let n = 0;
      for await (const ev of mock.stream(args)) {
        if (predicate(args.meta) && ++n > 8) throw new Error(message);
        yield ev;
      }
    },
  });

  const a = setup({ provider: failing((m) => m.purpose === "plan", "planner down"), mode: "fanout" });
  const qa = a.engine.ask({ text: Q3 }).turnId;
  await a.engine.idle();
  assert.equal(a.s.nodes[qa].status, "error");
  assert.equal(a.s.nodes[qa].error, "planner down");

  const b = setup({ provider: failing((m) => m.purpose === "card" && m.title === "Store events", "card exploded"), mode: "fanout" });
  const qb = b.engine.ask({ text: Q3 }).turnId;
  await b.engine.idle();
  const [first, ...rest] = cardsOf(b.s, qb);
  assert.equal(first.status, "error");
  assert.equal(first.error, "card exploded");
  assert.ok(rest.every((c) => c.status === "settled"));
  assert.equal(b.s.nodes[qb].status, "settled");

  const c = setup({ provider: failing((m) => m.purpose === "turn", "stream broke"), mode: "single" });
  const qc = c.engine.ask({ text: Q3 }).turnId;
  await c.engine.idle();
  assert.equal(c.s.nodes[qc].status, "error");
  assert.equal(c.s.nodes[qc].error, "stream broke");
  for (const card of cardsOf(c.s, qc)) assert.notEqual(card.status, "streaming");
});

test("computeAffects, inferShape and the mock reply script", () => {
  const log = createLog();
  const engine = createEngine({ log, provider: createMockProvider({ speed: 1000 }), logger: quiet });
  const s = log.state;
  const open = (node) => log.append("node.open", { node });
  const base = { title: "", summary: "", body: "", status: "settled" };
  open({ id: "q", kind: "question", parentId: null, turnId: "q", role: "user", ...base });
  for (const id of ["a", "b", "c", "d"]) open({ id, kind: "card", parentId: "q", turnId: "q", role: "assistant", ...base });
  open({ id: "m", kind: "message", parentId: "a", turnId: "q", role: "user", ...base });
  log.append("edge.add", { edge: { id: "e1", from: "a", to: "b", rel: "feeds" } });
  log.append("edge.add", { edge: { id: "e2", from: "c", to: "a", rel: "contradicts" } });
  log.append("edge.add", { edge: { id: "e3", from: "b", to: "d", rel: "alternative_to" } });
  assert.deepEqual(computeAffects(s, "a"), ["b", "c"]);
  assert.deepEqual(computeAffects(s, "m"), ["b", "c"], "a message resolves to its card");
  assert.deepEqual(computeAffects(s, "q"), []);
  assert.equal(inferShape(s, "q"), "comparison");
  const { decision } = engine.pin({ text: "x", sourceNodeId: "m" });
  assert.deepEqual(decision.affects, ["b", "c"]);
  assert.equal(s.nodes.b.status, "stale");

  const plain = mockScript({ purpose: "reply", text: "short", title: "T", chat: 1, existing: [] }, []);
  assert.equal(plain.stop, "end_turn");
  assert.match(plain.blocks.at(-1).text, /Context I was given/);
});
