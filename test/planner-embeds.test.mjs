// The optional planning model (a cheaper model plans fan-out answers, the
// answer model writes the cards), and the placeholders card Markdown leaves
// for diagrams, charts and SVG.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEngine } from "../server/engine.mjs";
import { createLog } from "../server/log.mjs";
import { renderMarkdown } from "../public/lib.mjs";
import { cardsOf } from "../shared/project.mjs";
import { createMockProvider } from "./support/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };

// A mock provider that records which purposes and thinking levels it served.
function recording(name, model) {
  const mock = createMockProvider({ speed: 1000 });
  const calls = [];
  return {
    calls,
    provider: {
      name,
      model,
      async *stream(args) {
        calls.push({ purpose: args.meta?.purpose, thinking: args.thinking });
        yield* mock.stream(args);
      },
    },
  };
}

// Just enough of the registry for the engine: two providers with keys.
function fakeRegistry(providers) {
  let active = { id: "big", model: "big-1" };
  return {
    fallback: providers.big.provider,
    acquire: () => providers[active.id].provider,
    acquireWith: (id, model) => (providers[id] ? { ...providers[id].provider, model } : null),
    check(id, model) {
      if (!providers[id]) throw Object.assign(new Error(`${id} has no API key; add one first`), { status: 400 });
      return { id, model: model ?? "x" };
    },
    activate(next) {
      active = next;
    },
    activeConfig: () => ({ provider: active.id, model: active.model }),
  };
}

describe("planning model", () => {
  test("off by default: the answer model plans and writes", async () => {
    const big = recording("big", "big-1");
    const small = recording("small", "small-1");
    const log = createLog();
    const engine = createEngine({ log, provider: big.provider, registry: fakeRegistry({ big, small }), mode: "fanout", logger: quiet });
    assert.equal(engine.getConfig().planner, null);
    const { turnId } = engine.ask({ text: "Compare A and B." });
    await engine.idle();
    assert.ok(cardsOf(log.state, turnId).length >= 1);
    assert.equal(small.calls.length, 0);
    assert.ok(big.calls.some((c) => c.purpose === "plan"));
  });

  test("when set, the small model plans (at its own thinking level) and the answer model writes", async () => {
    const big = recording("big", "big-1");
    const small = recording("small", "small-1");
    const log = createLog();
    const engine = createEngine({ log, provider: big.provider, registry: fakeRegistry({ big, small }), mode: "fanout", thinking: "high", logger: quiet });
    const cfg = engine.setConfig({ planner: { provider: "small", model: "small-1" } });
    assert.deepEqual(cfg.planner, { provider: "small", model: "small-1", thinking: "low" }, "thinking defaults to low");
    const { turnId } = engine.ask({ text: "Compare A and B." });
    await engine.idle();
    const cards = cardsOf(log.state, turnId);
    assert.ok(cards.length >= 1);
    assert.ok(cards.every((c) => c.status === "settled"));
    assert.deepEqual([...new Set(small.calls.map((c) => c.purpose))], ["plan"], "the small model only plans");
    assert.ok(small.calls.every((c) => c.thinking === "low"));
    assert.ok(big.calls.length >= cards.length && big.calls.every((c) => c.purpose === "card"), "the answer model writes every card");
    assert.ok(big.calls.every((c) => c.thinking === "high"));
  });

  test("single mode ignores it; bad values are refused; null turns it off", async () => {
    const big = recording("big", "big-1");
    const small = recording("small", "small-1");
    const log = createLog();
    const engine = createEngine({ log, provider: big.provider, registry: fakeRegistry({ big, small }), mode: "single", logger: quiet });
    engine.setConfig({ planner: { provider: "small", model: "small-1", thinking: "medium" } });
    engine.ask({ text: "Explain C." });
    await engine.idle();
    assert.equal(small.calls.length, 0);

    assert.throws(() => engine.setConfig({ planner: { provider: "small" } }), /planner.model is required/);
    assert.throws(() => engine.setConfig({ planner: { provider: "small", model: "m", thinking: "huge" } }), /planner.thinking/);
    assert.throws(() => engine.setConfig({ planner: { provider: "nokey", model: "m" } }), /no API key/);
    assert.throws(() => engine.setConfig({ planner: "small" }), /planner must be null/);
    assert.equal(engine.setConfig({ planner: null }).planner, null);
  });

  test("a planner whose provider lost its key falls back to the answer model", async () => {
    const big = recording("big", "big-1");
    const small = recording("small", "small-1");
    const providers = { big, small };
    const log = createLog();
    const engine = createEngine({ log, provider: big.provider, registry: fakeRegistry(providers), mode: "fanout", logger: quiet });
    engine.setConfig({ planner: { provider: "small", model: "small-1" } });
    delete providers.small; // key removed
    const { turnId } = engine.ask({ text: "Compare A and B." });
    await engine.idle();
    assert.ok(cardsOf(log.state, turnId).length >= 1);
    assert.equal(small.calls.length, 0);
  });
});

describe("writers think little by default", () => {
  async function run(thinking) {
    const rec = recording("big", "big-1");
    const log = createLog();
    const engine = createEngine({ log, provider: rec.provider, mode: "fanout", thinking, logger: quiet });
    engine.ask({ text: "Storage options: alpha, beta, and gamma." });
    await engine.idle();
    return rec.calls;
  }
  test("auto: cards are written at low, the plan keeps the default; a chosen level applies to every call", async () => {
    const auto = await run("auto");
    assert.ok(auto.filter((c) => c.purpose === "card").length >= 2);
    assert.ok(auto.filter((c) => c.purpose === "card").every((c) => c.thinking === "low"));
    assert.ok(auto.filter((c) => c.purpose === "plan").every((c) => c.thinking === "auto"));
    const high = await run("high");
    assert.ok(high.every((c) => c.thinking === "high"));
  });
});

describe("diagram, chart and SVG placeholders", () => {
  test("a closed fence becomes a placeholder carrying its source, escaped", () => {
    const html = renderMarkdown('Flow:\n\n```mermaid\ngraph TD; A["a<b"] --> B\n```\n\nDone.');
    assert.match(html, /<div class="embed" data-kind="mermaid" data-src="graph TD; A\[&quot;a&lt;b&quot;\] --&gt; B">/);
    assert.ok(!/<pre/.test(html), "not shown as code");
  });

  test("chart, vega-lite and svg fences map to their kinds", () => {
    assert.match(renderMarkdown('```chart\n{"mark":"bar"}\n```'), /data-kind="chart"/);
    assert.match(renderMarkdown('```vega-lite\n{"mark":"bar"}\n```'), /data-kind="chart"/);
    assert.match(renderMarkdown('```svg\n<svg viewBox="0 0 1 1"></svg>\n```'), /data-kind="svg"/);
    assert.match(renderMarkdown("```js\nconst x = 1;\n```"), /<pre class="code"/, "other languages stay code");
  });

  test("a fence still streaming is a quiet placeholder with no source", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A --> ");
    assert.match(html, /class="embed pending"/);
    assert.ok(!html.includes("data-src"));
    assert.match(html, /Drawing the diagram/);
  });
});
