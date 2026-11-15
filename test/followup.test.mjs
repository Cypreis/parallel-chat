// POST /api/nodes/:cardId/followup: the model answers in the card's thread or
// as a new card beside it, decided by its first content.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cardsOf, threadOf } from "../shared/project.mjs";
import { buildContext, buildFollowupContext } from "../server/context.mjs";
import { createEngine } from "../server/engine.mjs";
import { startServer } from "../server/http.mjs";
import { createLog } from "../server/log.mjs";
import { branchInput, createMockProvider, FOLLOWUP_PREAMBLE, followupHasPreamble, followupPath } from "../server/providers/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const SHORT = "Is it fast?";
const LONG = "Walk me through a worked example of replaying the log after a crash";
const LONG_Q = "Could you compare this with keeping snapshots and replaying only the tail?";

// The mock answers the question; `followup` decides what a follow-up gets.
function providerWith(followup) {
  const mock = createMockProvider({ speed: 1000 });
  const calls = [];
  return {
    name: "mock",
    model: "mock",
    calls,
    async *stream(args) {
      calls.push(args.meta);
      if (args.meta.purpose === "followup" && followup) yield* followup(args);
      else yield* mock.stream(args);
    },
  };
}

// One scripted message per call: blocks are text or tool_use; `error` throws.
function script(rounds) {
  let n = 0;
  return async function* ({ messages }) {
    const step = rounds[Math.min(n++, rounds.length - 1)];
    const { blocks = [], stop = "end_turn", error } = typeof step === "function" ? step(messages) : step;
    if (error && !blocks.length) throw error;
    const content = [];
    for (const b of blocks) {
      await new Promise((r) => setImmediate(r));
      if (b.type === "text") {
        for (let i = 0; i < b.text.length; i += 9) yield { type: "text", text: b.text.slice(i, i + 9) };
        content.push(b);
      } else {
        yield { type: "tool_start", id: b.id, name: b.name };
        yield { type: "tool_delta", id: b.id, json: JSON.stringify(b.input) };
        yield { type: "tool_end", id: b.id };
        content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
      }
    }
    if (error) throw error;
    yield { type: "stop", reason: stop, content };
  };
}

async function setup(provider = providerWith(null)) {
  const log = createLog();
  const engine = createEngine({ log, provider, mode: "single", logger: quiet });
  const q = engine.ask({ text: "How should we store events, and how do we stream them?" }).turnId;
  await engine.idle();
  const [card, other] = cardsOf(log.state, q);
  return { log, s: log.state, engine, q, card, other, provider };
}

// Events about the given nodes (or edges from them), after seq `after`.
function eventsAbout(log, after, ids) {
  const set = new Set(ids);
  return log
    .since(after)
    .filter((e) => set.has(e.id) || set.has(e.node?.id) || set.has(e.edge?.from))
    .map((e) => {
      if (e.type === "node.open") return ["open", e.node.id, e.node.kind, e.node.role, e.node.status, e.node.title, e.node.pending, e.node.origin];
      if (e.type === "node.patch") return ["patch", e.id, e.patch];
      if (e.type === "node.delta") return ["delta", e.id, e.field];
      if (e.type === "node.close") return ["close", e.id, e.status, e.error];
      if (e.type === "edge.add") return ["edge", e.edge.from, e.edge.to, e.edge.rel];
      return [e.type, e.id];
    });
}

const squash = (list) => list.filter((e, i) => !(e[0] === "delta" && list[i - 1]?.[0] === "delta" && list[i - 1][2] === e[2]));

describe("follow-up: the model chooses the thread or a new card", () => {
  test("the mock's choice is deterministic", () => {
    assert.equal(followupPath(SHORT), "thread");
    assert.equal(followupPath(LONG), "card");
    assert.equal(followupHasPreamble(LONG), false);
    assert.equal(followupHasPreamble(LONG_Q), true);
  });

  test("thread path: pending, then pending false, then the assistant message streams", async () => {
    const { s, log, engine, card } = await setup();
    const before = log.seq;
    const { userNodeId } = engine.followup(card.id, { text: SHORT, quote: "one place" });
    assert.equal(s.nodes[userNodeId].pending, true);
    assert.equal(s.nodes[userNodeId].quote, "one place");
    await engine.idle();
    const [, assistant] = threadOf(s, card.id).map((m) => m.id);
    assert.deepEqual(squash(eventsAbout(log, before, [userNodeId, assistant])), [
      ["open", userNodeId, "message", "user", "settled", "", true, undefined],
      ["patch", userNodeId, { pending: false }],
      ["open", assistant, "message", "assistant", "streaming", "", undefined, undefined],
      ["delta", assistant, "body"],
      ["close", assistant, "settled", undefined],
    ]);
    assert.equal(s.nodes[assistant].body, branchInput({ text: SHORT, title: card.title }).body);
    assert.equal(s.nodes[userNodeId].answeredBy, undefined);
    assert.equal(cardsOf(s, card.turnId).length, 2, "no card was created");
  });

  test("card path: answeredBy, then the branch events with origin.messageId", async () => {
    const { s, log, engine, card } = await setup();
    const before = log.seq;
    const { userNodeId } = engine.followup(card.id, { text: LONG });
    await engine.idle();
    const answeredBy = s.nodes[userNodeId].answeredBy;
    assert.match(answeredBy, /^n_\d+$/);
    const title = s.nodes[answeredBy].title;
    assert.deepEqual(squash(eventsAbout(log, before, [userNodeId, answeredBy])), [
      ["open", userNodeId, "message", "user", "settled", "", true, undefined],
      ["patch", userNodeId, { pending: false, answeredBy }],
      ["open", answeredBy, "card", "assistant", "streaming", "", undefined, { cardId: card.id, text: LONG, messageId: userNodeId }],
      ["edge", answeredBy, card.id, "elaborates"],
      ["patch", answeredBy, { title }],
      ["delta", answeredBy, "summary"],
      ["delta", answeredBy, "body"],
      ["close", answeredBy, "settled", undefined],
    ]);
    assert.equal(s.nodes[answeredBy].body, branchInput({ text: LONG, title: card.title }).body);
    assert.equal(s.nodes[answeredBy].parentId, card.parentId);
    assert.deepEqual(threadOf(s, card.id).map((m) => m.id), [userNodeId], "no assistant message in the thread");
    // A later context for that card says the follow-up was answered elsewhere.
    const later = buildContext(s, card.id, { text: "next" });
    const said = later.messages.map((m) => m.content.map((b) => b.text).join("")).join("\n");
    assert.ok(said.includes(`[Answered in a new card beside this one: ${title}.]`));
  });

  test("a short preamble before write_card is dropped and the card path is taken", async () => {
    const provider = providerWith(null);
    const { s, log, engine, card } = await setup(provider);
    const before = log.seq;
    const { userNodeId } = engine.followup(card.id, { text: LONG_Q });
    await engine.idle();
    const answeredBy = s.nodes[userNodeId].answeredBy;
    assert.ok(answeredBy, "card path");
    assert.ok(!s.nodes[answeredBy].body.includes(FOLLOWUP_PREAMBLE));
    assert.deepEqual(threadOf(s, card.id).map((m) => m.id), [userNodeId], "the preamble stranded no assistant message");
    assert.ok(!log.since(before).some((e) => e.type === "node.delta" && e.text?.includes("deserves")));
  });

  test("long text before a write_card call goes to the thread; the late write_card is refused", async () => {
    const long = "This needs more than a line, so here is a fuller answer that keeps going past eighty characters.";
    const rounds = [
      { blocks: [{ type: "text", text: long }, { type: "tool_use", id: "w1", name: "write_card", input: { title: "T", summary: "S", body: "B" } }], stop: "tool_use" },
      (messages) => {
        const results = messages.at(-1).content.filter((b) => b.type === "tool_result");
        assert.equal(results[0].is_error, true);
        assert.match(results[0].content, /already being answered in the card's thread/);
        return { blocks: [{ type: "text", text: "And that is all." }], stop: "end_turn" };
      },
    ];
    const { s, engine, card } = await setup(providerWith(script(rounds)));
    const { userNodeId } = engine.followup(card.id, { text: "explain" });
    await engine.idle();
    const [, assistant] = threadOf(s, card.id);
    assert.equal(assistant.body, `${long}\n\nAnd that is all.`);
    assert.equal(assistant.status, "settled");
    assert.equal(s.nodes[userNodeId].answeredBy, undefined);
    assert.equal(cardsOf(s, card.turnId).length, 2);
  });

  test("link_cards alone decides nothing; the text after it goes to the thread", async () => {
    let play = null;
    const w = await setup(providerWith((args) => play(args)));
    const other = w.other;
    play = script([
      { blocks: [{ type: "tool_use", id: "l1", name: "link_cards", input: { from: w.card.id, to: other.id, rel: "contradicts" } }], stop: "tool_use" },
      { blocks: [{ type: "text", text: "Linked them." }], stop: "end_turn" },
    ]);
    const before = w.log.seq;
    const { userNodeId } = w.engine.followup(w.card.id, { text: "do these clash" });
    await w.engine.idle();
    const types = w.log.since(before).map((e) => (e.type === "node.patch" ? `patch:${Object.keys(e.patch)}` : e.type));
    assert.ok(types.indexOf("edge.add") < types.indexOf("patch:pending"), "the link ran before the path was decided");
    assert.ok(w.s.edges.some((e) => e.from === w.card.id && e.to === other.id && e.rel === "contradicts"));
    const [, assistant] = threadOf(w.s, w.card.id);
    assert.equal(assistant.body, "Linked them.");
    assert.equal(w.s.nodes[userNodeId].pending, false);
  });

  test("a failure before any content: pending false, then an assistant message closed as error", async () => {
    for (const [rounds, pattern] of [
      [[{ error: new Error("upstream down") }], /^upstream down$/],
      [[{ blocks: [], stop: "end_turn" }], /returned no answer/],
    ]) {
      const { s, log, engine, card } = await setup(providerWith(script(rounds)));
      const before = log.seq;
      const { userNodeId } = engine.followup(card.id, { text: "x" });
      await engine.idle();
      const [, assistant] = threadOf(s, card.id).map((m) => m.id);
      const got = eventsAbout(log, before, [userNodeId, assistant]);
      assert.deepEqual(got.slice(1, 3), [
        ["patch", userNodeId, { pending: false }],
        ["open", assistant, "message", "assistant", "streaming", "", undefined, undefined],
      ]);
      assert.equal(got[3][0], "close");
      assert.equal(got[3][2], "error");
      assert.match(got[3][3], pattern);
    }
  });

  test("cancel while pending, and cancel on each path", async () => {
    const slow = createMockProvider({ speed: 1 });
    const provider = providerWith((args) => slow.stream(args));
    const { s, log, engine, card } = await setup(provider);

    const before = log.seq;
    const pending = engine.followup(card.id, { text: SHORT }).userNodeId;
    assert.deepEqual(engine.cancel(pending), { id: pending });
    const [, assistant] = threadOf(s, card.id).map((m) => m.id);
    assert.deepEqual(eventsAbout(log, before, [pending, assistant]).slice(1), [
      ["patch", pending, { pending: false }],
      ["open", assistant, "message", "assistant", "streaming", "", undefined, undefined],
      ["close", assistant, "cancelled", undefined],
    ]);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(log.since(before).length, 4, "nothing more arrives for the cancelled follow-up");

    const waitFor = (pred) =>
      new Promise((resolve) => {
        const t = setInterval(() => {
          if (pred()) {
            clearInterval(t);
            resolve();
          }
        }, 5);
      });
    const t1 = engine.followup(card.id, { text: SHORT }).userNodeId;
    await waitFor(() => threadOf(s, card.id).at(-1)?.body.length > 0 && threadOf(s, card.id).at(-1).role === "assistant");
    const a1 = threadOf(s, card.id).at(-1);
    engine.cancel(a1.id);
    assert.equal(s.nodes[a1.id].status, "cancelled");
    assert.equal(s.nodes[t1].pending, false);

    const c1 = engine.followup(card.id, { text: LONG }).userNodeId;
    await waitFor(() => s.nodes[c1].answeredBy && s.nodes[s.nodes[c1].answeredBy].body.length > 0);
    const made = s.nodes[c1].answeredBy;
    engine.cancel(made);
    assert.equal(s.nodes[made].status, "cancelled");
    engine.shutdown();
    await engine.idle();
  });

  test("refresh of a card made by a follow-up re-answers its origin as a card", async () => {
    const { s, engine, card } = await setup();
    const { userNodeId } = engine.followup(card.id, { text: LONG });
    await engine.idle();
    const made = s.nodes[userNodeId].answeredBy;
    engine.pin({ text: "Keep a daily snapshot", sourceNodeId: card.id });
    assert.equal(s.nodes[made].status, "stale");
    assert.deepEqual(engine.refresh(made), { cardId: made });
    await engine.idle();
    const node = s.nodes[made];
    assert.equal(node.status, "settled");
    assert.equal(node.kind, "card");
    assert.deepEqual(node.origin, { cardId: card.id, text: LONG, messageId: userNodeId });
    assert.match(node.body, /1 pinned decision/);
    assert.deepEqual(threadOf(s, card.id).map((m) => m.id), [userNodeId], "no thread answer appeared");
  });

  test("its context: a reply's sections, the follow-up, then the choice", async () => {
    const { s, card } = await setup();
    const ctx = buildFollowupContext(s, card.id, { text: "why?", quote: "one place", cardId: "n_77" });
    assert.deepEqual(
      ctx.sections.map((x) => x.name),
      ["system prompt", "question", "outline", "existing cards", "decisions", "focus card", "linked cards", "thread", "new question", "task"],
    );
    const [ask, task] = ctx.messages.at(-1).content.slice(-2).map((b) => b.text);
    assert.match(ask, /<selection>\none place\n<\/selection>\n\nwhy\?/);
    assert.match(task, /^<task>\nChoose how to answer the follow-up above\./);
    assert.match(task, /clarification, a quick fact, a rewording, a correction or a small addition/);
    assert.match(task, /worked example, a comparison, an alternative approach, a deep dive/);
    assert.match(task, /When unsure, keep short answers in the thread and give long ones a card of their own/);
    assert.match(task, /its id will be n_77/);
  });

  test("HTTP route and validation", async () => {
    const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet });
    try {
      const post = async (p, body) => {
        const res = await fetch(app.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      };
      const { turnId } = (await post("/api/ask", { text: "What is SSE?" })).body;
      await app.engine.idle();
      const card = cardsOf(app.log.state, turnId)[0];
      const r = await post(`/api/nodes/${card.id}/followup`, { text: SHORT, quote: "SSE" });
      assert.equal(r.status, 202);
      assert.deepEqual(Object.keys(r.body), ["userNodeId"]);
      assert.equal(app.log.state.nodes[r.body.userNodeId].pending, true);
      await app.engine.idle();
      assert.equal(app.log.state.nodes[r.body.userNodeId].pending, false);
      assert.equal((await post("/api/nodes/n_999/followup", { text: "x" })).status, 404);
      assert.equal((await post(`/api/nodes/${card.id}/followup`, { text: "" })).status, 400);
      assert.equal((await post(`/api/nodes/${turnId}/followup`, { text: "x" })).status, 400);
    } finally {
      await app.close();
    }
  });
});
