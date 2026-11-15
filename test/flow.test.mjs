// One continuing chat (questions with chatId) and follow-ups answered as new
// cards (branches): engine, context, mock and HTTP.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cardsInOrder, cardsOf, chatOf, chats } from "../shared/project.mjs";
import { buildAskContext, buildBranchContext, buildContext, existingCards, outlineBlock } from "../server/context.mjs";
import { createEngine, titleFromText } from "../server/engine.mjs";
import { startServer } from "../server/http.mjs";
import { createLog } from "../server/log.mjs";
import { branchInput, cardBody, cardLength, createMockProvider, derivePlan } from "./support/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const Q1 = "How should we store events, and how do we stream them?";
const Q2 = "And what about caching?";

function setup({ provider = createMockProvider({ speed: 1000 }), mode = "single", maxCards = 4 } = {}) {
  const log = createLog();
  const engine = createEngine({ log, provider, mode, maxCards, logger: quiet });
  return { log, s: log.state, engine };
}

function recording(inner) {
  const calls = [];
  return {
    name: inner.name,
    model: inner.model,
    calls,
    async *stream(args) {
      calls.push({ messages: structuredClone(args.messages), tools: args.tools.map((t) => t.name), meta: args.meta });
      yield* inner.stream(args);
    },
  };
}

const textOf = (ctx) => ctx.messages.map((m) => m.content.map((b) => b.text).join("\n")).join("\n");

// A chat of two questions, then a separate chat.
async function twoQuestionChat(opts) {
  const w = setup(opts);
  const q1 = w.engine.ask({ text: Q1 }).turnId;
  await w.engine.idle();
  const q2 = w.engine.ask({ text: Q2, chatId: q1 }).turnId;
  await w.engine.idle();
  const q3 = w.engine.ask({ text: "What is SSE?" }).turnId;
  await w.engine.idle();
  return { ...w, q1, q2, q3 };
}

describe("a chat with several questions", () => {
  test("ask with chatId joins the chat; a bad chatId is a 400", async () => {
    const { s, engine, q1, q2, q3 } = await twoQuestionChat();
    assert.equal(s.nodes[q2].chatId, q1);
    assert.ok(!("chatId" in s.nodes[q1]) && !("chatId" in s.nodes[q3]));
    assert.deepEqual(
      chats(s).map((c) => [c.id, c.questions.map((q) => q.id)]),
      [
        [q1, [q1, q2]],
        [q3, [q3]],
      ],
    );
    for (const chatId of ["n_999", q2, 42, cardsOf(s, q1)[0].id]) {
      assert.throws(
        () => engine.ask({ text: "x", chatId }),
        (err) => err.status === 400 && /chatId must be the id of a chat's first question/.test(err.message),
        String(chatId),
      );
    }
  });

  test("chat numbers count chats, not questions", async () => {
    const provider = recording(createMockProvider({ speed: 1000 }));
    const { s, q1, q2, q3 } = await twoQuestionChat({ provider });
    const asks = provider.calls.filter((c) => c.meta.purpose === "turn" && c.meta.round === 1);
    assert.deepEqual(
      asks.map((c) => c.meta.chat),
      [1, 1, 2],
    );
    assert.match(asks[1].messages[0].content[0].text, /This question continues chat 1\./);
    assert.match(asks[2].messages[0].content[0].text, /This question opens chat 2\./);
    const chatOfCard = new Map(existingCards(s).map((c) => [c.id, c.chat]));
    for (const c of [...cardsOf(s, q1), ...cardsOf(s, q2)]) assert.equal(chatOfCard.get(c.id), 1);
    for (const c of cardsOf(s, q3)) assert.equal(chatOfCard.get(c.id), 2);
    const reply = buildContext(s, cardsOf(s, q2)[0].id, { text: "x" });
    assert.match(reply.messages[0].content[2].text, /You are working in chat 1 of 2\./);
  });

  test("a continuing question sees the conversation so far, without card bodies", async () => {
    const provider = recording(createMockProvider({ speed: 1000 }));
    const { s, q1 } = await twoQuestionChat({ provider });
    const ask = provider.calls.find((c) => c.meta.question === Q2 && c.meta.round === 1);
    const [board, conversation, question, task] = ask.messages[0].content.map((b) => b.text);
    assert.match(board, /^<board>/);
    assert.match(conversation, /^<conversation>/);
    assert.match(conversation, new RegExp(`Question 1: ${Q1.replace(/[?]/g, "\\?")}`));
    for (const c of cardsOf(s, q1)) {
      assert.ok(conversation.includes(`- ${c.title}: ${c.summary}`), c.title);
      assert.ok(!conversation.includes(c.body.slice(0, 50)), "no bodies");
    }
    assert.equal(question, `<question>\n${Q2}\n</question>`);
    assert.match(task, /continues the conversation above/);
    // The first question of a chat has no conversation block.
    const first = buildAskContext(s, q1, { maxCards: 4 });
    assert.ok(!first.sections.some((x) => x.name === "conversation"));
  });

  test("a card's outline covers the whole chat, grouped by question, with one shared prefix", async () => {
    const { s, q1, q2 } = await twoQuestionChat();
    const outline = outlineBlock(s, q2);
    assert.match(outline, /^<outline questions="2" cards="3">/);
    assert.match(outline, /Question 1: How should we store events/);
    assert.match(outline, /Question 2: And what about caching\?\nCard 3: Caching/);
    const prefix = (ctx) => JSON.stringify([ctx.system, ctx.messages[0].content.slice(0, 2)]);
    const a = buildContext(s, cardsOf(s, q1)[0].id, { text: "a" });
    const b = buildContext(s, cardsOf(s, q2)[0].id, { text: "b" });
    assert.equal(prefix(a), prefix(b), "every card of the chat shares the cached prefix");
    assert.match(b.messages[0].content[4].text, /It answers question 2 of this chat: And what about caching\?/);
  });
});

describe("branch: a follow-up answered as a new card", () => {
  test("event order is exactly open, edge, title, deltas, close", async () => {
    const { s, log, engine } = setup();
    const q = engine.ask({ text: Q1 }).turnId;
    await engine.idle();
    const source = cardsOf(s, q)[0];
    const before = log.seq;
    const { cardId } = engine.branch(source.id, { text: "Why not just use a database table?" });
    await engine.idle();
    const events = log.since(before).filter((e) => e.id === cardId || e.node?.id === cardId || e.edge?.from === cardId);
    assert.equal(events[0].type, "node.open");
    assert.deepEqual(
      [events[0].node.title, events[0].node.status, events[0].node.parentId, events[0].node.turnId, events[0].node.kind],
      ["", "streaming", source.parentId, source.turnId, "card"],
    );
    assert.deepEqual(events[0].node.origin, { cardId: source.id, text: "Why not just use a database table?" });
    assert.equal(events[1].type, "edge.add");
    assert.deepEqual([events[1].edge.from, events[1].edge.to, events[1].edge.rel], [cardId, source.id, "elaborates"]);
    assert.equal(events[2].type, "node.patch");
    assert.deepEqual(events[2].patch, { title: "Why not just use a database table" });
    const rest = events.slice(3);
    assert.ok(rest.slice(0, -1).length > 5 && rest.slice(0, -1).every((e) => e.type === "node.delta"));
    assert.deepEqual(rest.at(-1), { ...rest.at(-1), type: "node.close", status: "settled" });
    const card = s.nodes[cardId];
    assert.equal(card.body, branchInput({ text: "Why not just use a database table?", title: source.title }).body);
    assert.deepEqual(
      cardsInOrder(s, q).map((c) => c.id),
      [source.id, cardId, ...cardsOf(s, q).slice(1, -1).map((c) => c.id)],
      "the branch sits right after its source",
    );
    assert.equal(chatOf(s, cardId), q);
  });

  test("a quoted branch, its context, and the mock's length tracking the follow-up", async () => {
    const provider = recording(createMockProvider({ speed: 1000 }));
    const { s, engine } = setup({ provider });
    const q = engine.ask({ text: Q1 }).turnId;
    await engine.idle();
    const [source, sibling] = cardsOf(s, q);
    const long = "Could the same log also serve as the audit trail that compliance keeps asking about?";
    const { cardId } = engine.branch(source.id, { text: long, quote: "a single place decides" });
    const short = engine.branch(source.id, { text: "Is it fast?" }).cardId;
    await engine.idle();

    assert.deepEqual(s.nodes[cardId].origin, { cardId: source.id, text: long, quote: "a single place decides" });
    const call = provider.calls.find((c) => c.meta.purpose === "branch" && c.meta.text === long);
    assert.deepEqual(call.tools, ["write_card", "link_cards"]);
    const task = call.messages.at(-1).content.at(-1).text;
    assert.match(task, /^<task>\nThe user asked this follow-up from the focus card, Card 1 \(Store events\):/);
    assert.match(task, /<selection>\na single place decides\n<\/selection>/);
    assert.match(task, new RegExp(`<follow_up>\n${long.replace(/\?/g, "\\?")}\n</follow_up>`));
    assert.match(task, /do not|without restating the focus card/);
    assert.match(task, new RegExp(`The new card's id will be ${cardId}`));

    const longBody = s.nodes[cardId].body;
    assert.ok(longBody.startsWith("> a single place decides"));
    assert.ok(longBody.includes("```js"), "a long follow-up gets the long body");
    const shortBody = s.nodes[short].body;
    assert.ok(!shortBody.includes("```"));
    assert.equal(shortBody.match(/[.!?](\s|$)/g).length, 2, "two sentences");
    assert.equal(s.nodes[short].title, "Is it fast");
    assert.ok(sibling, "the source has a sibling (its body is checked in the next test)");
  });

  test("branch context: reply sections plus the task; unlinked sibling bodies absent", async () => {
    const { s, engine } = setup();
    const q = engine.ask({ text: "How should we store events, and how do we stream them to the browser, and what about caching?" }).turnId;
    await engine.idle();
    const [store, stream, caching] = cardsOf(s, q);
    const ctx = buildBranchContext(s, caching.id, { text: "How big does it get?", cardId: "n_100" });
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
        ["task", false],
      ],
    );
    const all = textOf(ctx);
    assert.ok(all.includes(caching.body.trim()), "the focus card in full");
    assert.ok(all.includes(stream.body.trim()), "stream feeds caching, so it is linked and in full");
    assert.ok(!all.includes(store.body.trim().slice(0, 80)), "store is not linked to caching: no body");
    assert.ok(all.includes(store.summary), "but its summary is in the outline");
    const reply = buildContext(s, caching.id, { text: "x" });
    const prefix = (c) => JSON.stringify([c.system, c.messages[0].content.slice(0, 2)]);
    assert.equal(prefix(ctx), prefix(reply), "a branch shares the thread's cached prefix");
  });

  test("a branch does not count against maxCards; refresh re-answers its origin; stale through its edge", async () => {
    const { s, engine } = setup({ maxCards: 1 });
    const q = engine.ask({ text: "What is SSE?" }).turnId;
    await engine.idle();
    const [source] = cardsOf(s, q);
    const a = engine.branch(source.id, { text: "Does it reconnect?" }).cardId;
    const b = engine.branch(source.id, { text: "Is it one-way?" }).cardId;
    await engine.idle();
    assert.deepEqual(
      cardsOf(s, q).map((c) => c.status),
      ["settled", "settled", "settled"],
    );

    const { decision } = engine.pin({ text: "Use SSE everywhere", sourceNodeId: source.id });
    assert.ok(decision.affects.includes(a) && decision.affects.includes(b), "branches are joined to the source by elaborates");
    assert.equal(s.nodes[a].status, "stale");
    const oldBody = s.nodes[a].body;
    assert.deepEqual(engine.refresh(a), { cardId: a });
    await engine.idle();
    assert.equal(s.nodes[a].status, "settled");
    assert.equal(s.nodes[a].staleBecause, undefined);
    assert.equal(s.nodes[a].title, "Does it reconnect");
    assert.match(s.nodes[a].body, /pinned decision/);
    assert.notEqual(s.nodes[a].body, oldBody);
    assert.deepEqual(s.nodes[a].origin, { cardId: source.id, text: "Does it reconnect?" });
  });

  test("cancel a branch mid-stream", async () => {
    const fast = createMockProvider({ speed: 1000 });
    const slow = createMockProvider({ speed: 1 });
    const provider = { name: "mock", model: "mock", stream: (args) => (args.meta.purpose === "branch" ? slow : fast).stream(args) };
    const { s, engine } = setup({ provider });
    const q = engine.ask({ text: "What is SSE?" }).turnId;
    await engine.idle();
    const { cardId } = engine.branch(cardsOf(s, q)[0].id, { text: "Could the same log also serve as the audit trail compliance keeps asking about?" });
    await new Promise((resolve) => {
      const t = setInterval(() => {
        if (s.nodes[cardId].body.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });
    assert.deepEqual(engine.cancel(cardId), { id: cardId });
    assert.equal(s.nodes[cardId].status, "cancelled");
    const len = s.nodes[cardId].body.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.nodes[cardId].body.length, len, "no writes after cancel");
    engine.shutdown();
    await engine.idle();
  });

  test("a plain-text branch answer becomes the body, with a title from the follow-up", async () => {
    const inner = createMockProvider({ speed: 1000 });
    const provider = {
      name: "mock",
      model: "mock",
      async *stream(args) {
        if (args.meta.purpose !== "branch") {
          yield* inner.stream(args);
          return;
        }
        yield { type: "text", text: "Yes: it retries " };
        yield { type: "text", text: "with Last-Event-ID." };
        yield { type: "stop", reason: "end_turn", content: [{ type: "text", text: "Yes: it retries with Last-Event-ID." }] };
      },
    };
    const { s, log, engine } = setup({ provider });
    const q = engine.ask({ text: "What is SSE?" }).turnId;
    await engine.idle();
    const before = log.seq;
    const { cardId } = engine.branch(cardsOf(s, q)[0].id, { text: "so does the browser reconnect by itself?" });
    await engine.idle();
    assert.equal(s.nodes[cardId].title, titleFromText("so does the browser reconnect by itself?"));
    assert.equal(s.nodes[cardId].title, "Does the browser reconnect by itself");
    assert.equal(s.nodes[cardId].body, "Yes: it retries with Last-Event-ID.");
    assert.equal(s.nodes[cardId].status, "settled");
    const types = log.since(before).filter((e) => e.id === cardId || e.node?.id === cardId).map((e) => e.type);
    assert.deepEqual(types, ["node.open", "node.patch", "node.delta", "node.close"]);
  });

  test("validation: unknown card, empty text, a message id resolves to its card", async () => {
    const { s, engine } = setup();
    const q = engine.ask({ text: "What is SSE?" }).turnId;
    await engine.idle();
    const card = cardsOf(s, q)[0];
    assert.throws(() => engine.branch("n_999", { text: "x" }), (e) => e.status === 404);
    assert.throws(() => engine.branch(card.id, { text: "  " }), (e) => e.status === 400);
    assert.throws(() => engine.branch(q, { text: "x" }), (e) => e.status === 400, "a question is not a card");
    const r = engine.reply(card.id, { text: "hi" });
    await engine.idle();
    const { cardId } = engine.branch(r.userNodeId, { text: "short one" });
    await engine.idle();
    assert.equal(s.nodes[cardId].origin.cardId, card.id);
  });
});

describe("mock lengths", () => {
  test("normal cards vary in length deterministically; branches track the follow-up", () => {
    const titles = derivePlan("How should we store events, and how do we stream them to the browser, and what about caching?").cards.map((c) => c.title);
    const q = "How should we store events, and how do we stream them to the browser, and what about caching?";
    const lengths = titles.map((t) => cardLength(t, q));
    assert.ok(new Set(lengths).size > 1, `lengths vary: ${lengths}`);
    assert.equal(cardLength(titles[0], q), cardLength(titles[0], q));
    assert.ok(cardBody("A", "q", "", { length: "short" }).length < cardBody("A", "q", "", { length: "long" }).length / 3);
    assert.ok(!cardBody("A", "q", "", { length: "short" }).includes("```"));
    const s = branchInput({ text: "Is it fast?", title: "Store events" });
    assert.equal(s.body.match(/[.!?](\s|$)/g).length, 2);
    assert.ok(branchInput({ text: "x".repeat(60), title: "Store events" }).body.includes("```js"));
  });
});

describe("HTTP", () => {
  test("POST /api/nodes/:id/branch and /api/ask with chatId", async () => {
    const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet });
    try {
      const post = async (p, body) => {
        const res = await fetch(app.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      };
      const { turnId } = (await post("/api/ask", { text: "What is SSE?" })).body;
      await app.engine.idle();
      const card = cardsOf(app.log.state, turnId)[0];
      const r = await post(`/api/nodes/${card.id}/branch`, { text: "Is it fast?", quote: "SSE" });
      assert.equal(r.status, 202);
      assert.match(r.body.cardId, /^n_\d+$/);
      await app.engine.idle();
      assert.equal(app.log.state.nodes[r.body.cardId].status, "settled");
      assert.equal((await post("/api/nodes/n_999/branch", { text: "x" })).status, 404);
      assert.equal((await post(`/api/nodes/${card.id}/branch`, {})).status, 400);
      const more = await post("/api/ask", { text: "And caching?", chatId: turnId });
      assert.equal(more.status, 202);
      assert.equal((await post("/api/ask", { text: "x", chatId: more.body.turnId })).status, 400);
      assert.equal((await post("/api/ask", { text: "x", chatId: "n_999" })).status, 400);
      await app.engine.idle();
      const ctx = await (await fetch(`${app.url}/api/context/${r.body.cardId}`)).json();
      assert.match(ctx.messages[0].content[4].text, /It answers a follow-up asked from card 1 \(SSE\): Is it fast\?/);
    } finally {
      await app.close();
    }
  });
});
