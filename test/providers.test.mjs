// DeepSeek / Qwen (OpenAI-compatible) provider, the provider registry and the
// /api/providers routes, all against a local fake server that speaks the
// OpenAI-compatible SSE format. Nothing here reaches a real API.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cardsOf, threadOf } from "../shared/project.mjs";
import { createEngine } from "../server/engine.mjs";
import { startServer } from "../server/http.mjs";
import { createLog } from "../server/log.mjs";
import { createMockProvider, derivePlan } from "./support/mock.mjs";
import { createOpenAICompatProvider, toOpenAIMessages } from "../server/providers/openai-compat.mjs";
import { createRegistry } from "../server/providers/registry.mjs";
import { CREATE_CARD, LINK_CARDS } from "../server/tools.mjs";

const DS_KEY = "sk-fake-deepseek-0123456789abcdef9f2c";
const QW_KEY = "sk-fake-dashscope-abcdef0123456789zz71";
const ENV_KEY = "sk-fake-env-key-000011112222333344445555";
const ALL_KEYS = [DS_KEY, QW_KEY, ENV_KEY];

// ---------- the fake OpenAI-compatible server ----------

let toolSeq = 0;
const chunk = (delta, finish = null) => ({ id: "cmpl", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] });
function toolDelta(index, { id, name, args }) {
  const fn = {};
  if (name !== undefined) fn.name = name;
  if (args !== undefined) fn.arguments = args;
  const tc = { index, function: fn };
  if (id !== undefined) tc.id = id;
  if (name !== undefined) tc.type = "function";
  return chunk({ tool_calls: [tc] });
}
function toolCallsSSE(calls, { reasoning } = {}) {
  const out = [];
  if (reasoning) out.push(chunk({ role: "assistant", content: null, reasoning_content: reasoning }));
  calls.forEach((c, index) => {
    const args = JSON.stringify(c.input);
    out.push(toolDelta(index, { id: `call_${++toolSeq}`, name: c.name, args: "" }));
    for (let i = 0; i < args.length; i += 7) out.push(toolDelta(index, { id: "", args: args.slice(i, i + 7) }));
  });
  out.push(chunk({}, "tool_calls"));
  return { sse: out };
}

// Answers like a model would, from the request: cards, a writer's card, or text.
function brain(entry) {
  const b = entry.body;
  const tools = (b.tools ?? []).map((t) => t.function.name);
  if (b.messages.at(-1).role === "tool") return { sse: [chunk({ content: "Done." }), chunk({}, "stop")] };
  if (tools.includes("write_card")) {
    return toolCallsSSE([{ name: "write_card", input: { summary: "Writer summary.", body: 'Writer body: "q" → ok' } }]);
  }
  if (tools.includes("create_card")) {
    const fanout = "intent" in b.tools.find((t) => t.function.name === "create_card").function.parameters.properties;
    const cards = ["Alpha", "Beta"].map((title, i) =>
      fanout
        ? { key: `c${i + 1}`, title, intent: `Cover ${title}.` }
        : { key: `c${i + 1}`, title, summary: `${title} summary.`, body: `${title} body: a < b, "q", back\\slash 🚀` },
    );
    return toolCallsSSE(
      [...cards.map((input) => ({ name: "create_card", input })), { name: "link_cards", input: { from: "c1", to: "c2", rel: "feeds" } }],
      { reasoning: "planning the board" },
    );
  }
  return { sse: [chunk({ content: "A plain " }), chunk({ content: "reply." }), chunk({}, "stop")] };
}

async function startFake() {
  const requests = [];
  const fake = {
    requests,
    chat: [], // queue of response specs for streamed chat; falls back to brain
    deepseekModels: () => ({ status: 200, json: { object: "list", data: [] } }),
    qwenNative: () => ({ status: 404, json: { message: "not found" } }),
    qwenOpenAI: () => ({ status: 404, json: { error: { message: "not found" } } }),
    validate: () => ({ status: 200, json: { choices: [] } }),
    url: "",
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let raw = "";
    for await (const c of req) raw += c;
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: raw ? JSON.parse(raw) : null };
    requests.push(entry);
    let spec;
    if (req.method === "GET" && url.pathname === "/models") spec = fake.deepseekModels(entry);
    else if (req.method === "GET" && url.pathname === "/api/v1/models") spec = fake.qwenNative(entry);
    else if (req.method === "GET" && url.pathname.endsWith("/compatible-mode/v1/models")) spec = fake.qwenOpenAI(entry);
    else if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      spec = entry.body.stream !== true ? fake.validate(entry) : fake.chat.length ? fake.chat.shift() : brain(entry);
      if (typeof spec === "function") spec = spec(entry);
    } else spec = { status: 404, text: "no route" };
    await send(req, res, spec);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  });
  fake.chatRequests = () => requests.filter((r) => r.path.endsWith("/chat/completions"));
  return fake;
}

async function send(req, res, spec) {
  if (spec.sse) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let text = spec.sse.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`)).join("");
    if (spec.done !== false) text += "data: [DONE]\n\n";
    const step = spec.split ?? 11; // awkward byte boundaries
    const limit = spec.hangAfter ?? Infinity;
    for (let i = 0; i < text.length && i < limit; i += step) {
      res.write(text.slice(i, Math.min(i + step, limit)));
      await new Promise((r) => setImmediate(r));
    }
    if (spec.hangAfter !== undefined) {
      await new Promise((r) => req.on("close", r)); // keep the stream open until the client goes
      return;
    }
    res.end();
    return;
  }
  if (spec.json !== undefined) {
    res.writeHead(spec.status, { "content-type": "application/json" });
    res.end(JSON.stringify(spec.json));
    return;
  }
  res.writeHead(spec.status, { "content-type": spec.type ?? "text/plain" });
  res.end(spec.text ?? "");
}

async function collect(stream) {
  const events = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

function captureLogger() {
  const lines = [];
  const push = (...a) => lines.push(a.map(String).join(" "));
  return { lines, log: push, warn: push, error: push };
}

const noKeys = (text, where) => {
  for (const key of ALL_KEYS) assert.ok(!String(text).includes(key), `a key leaked into ${where}`);
};

// ---------- the provider ----------

describe("OpenAI-compatible provider against a fake server", () => {
  let fake;
  before(async () => {
    fake = await startFake();
  });
  after(() => fake.close());

  const ds = (extra = {}) =>
    createOpenAICompatProvider({ id: "deepseek", label: "DeepSeek", baseURL: fake.url, apiKey: DS_KEY, model: "deepseek-flash", ...extra });

  test("streams text, and the request is shaped as documented", async () => {
    fake.requests.length = 0;
    fake.chat.push({ sse: [chunk({ role: "assistant", content: "" }), chunk({ content: "Hel" }), chunk({ content: "lo" }), chunk({}, "stop")], split: 3 });
    const events = await collect(ds({ maxOutput: 8000 }).stream({ system: "SYS", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [CREATE_CARD] }));
    assert.deepEqual(events, [
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "stop", reason: "end_turn", content: [{ type: "text", text: "Hello" }], message: undefined },
    ]);
    const req = fake.requests[0];
    assert.equal(req.path, "/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${DS_KEY}`);
    assert.equal(req.body.model, "deepseek-flash");
    assert.equal(req.body.stream, true);
    assert.equal(req.body.max_tokens, 8000);
    assert.deepEqual(req.body.thinking, { type: "disabled" });
    assert.ok(!("tool_choice" in req.body) && !("enable_thinking" in req.body));
    assert.deepEqual(req.body.tools, [{ type: "function", function: { name: "create_card", description: CREATE_CARD.description, parameters: CREATE_CARD.input_schema } }]);
    assert.ok(!JSON.stringify(req.body.tools).includes("eager_input_streaming"));

    fake.chat.push({ sse: [chunk({ content: "x" }), chunk({}, "stop")] });
    await collect(ds({ maxOutput: 64000 }).stream({ system: "S", messages: [{ role: "user", content: "x" }] }));
    assert.equal(fake.requests.at(-1).body.max_tokens, 16000);
    fake.chat.push({ sse: [chunk({ content: "x" }), chunk({}, "stop")] });
    await collect(ds().stream({ system: "S", messages: [{ role: "user", content: "x" }] }));
    assert.ok(!("max_tokens" in fake.requests.at(-1).body), "omitted without a known maxOutput");
    assert.ok(!("tools" in fake.requests.at(-1).body));
  });

  test("a tool call split across chunks, with name and arguments in separate chunks", async () => {
    fake.chat.push({
      sse: [
        chunk({ role: "assistant", content: null }),
        toolDelta(0, { id: "call_x" }), // id only
        toolDelta(0, { id: "", name: "create_card" }), // name alone
        toolDelta(0, { id: "", args: '{"key":"c1",' }),
        toolDelta(0, { id: "", args: '"title":"T\\u00e9"}' }),
        chunk({}, "tool_calls"),
      ],
      split: 5,
    });
    const events = await collect(ds().stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [CREATE_CARD] }));
    assert.deepEqual(events.slice(0, 4), [
      { type: "tool_start", id: "call_x", name: "create_card" },
      { type: "tool_delta", id: "call_x", json: '{"key":"c1",' },
      { type: "tool_delta", id: "call_x", json: '"title":"T\\u00e9"}' },
      { type: "tool_end", id: "call_x" },
    ]);
    assert.deepEqual(events[4], {
      type: "stop",
      reason: "tool_use",
      content: [{ type: "tool_use", id: "call_x", name: "create_card", input: { key: "c1", title: "Té" } }],
      message: undefined,
    });
  });

  test("two parallel tool calls, and a generated id when none is sent", async () => {
    fake.chat.push({
      sse: [
        toolDelta(0, { id: "call_a", name: "create_card", args: '{"key":"c1"' }),
        toolDelta(0, { id: "", args: "}" }),
        toolDelta(1, { name: "link_cards", args: '{"from":"c1",' }),
        toolDelta(1, { args: '"to":"n_9","rel":"feeds"}' }),
        chunk({}, "tool_calls"),
      ],
    });
    const events = await collect(ds().stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [CREATE_CARD, LINK_CARDS] }));
    const kinds = events.map((e) => (e.type === "tool_delta" ? `delta:${e.id}` : e.type === "stop" ? "stop" : `${e.type}:${e.id}`));
    const second = events.find((e) => e.type === "tool_start" && e.name === "link_cards").id;
    assert.match(second, /^call_gen_/);
    assert.deepEqual(kinds, [
      "tool_start:call_a",
      "delta:call_a",
      "delta:call_a",
      `tool_start:${second}`,
      `delta:${second}`,
      `delta:${second}`,
      "tool_end:call_a",
      `tool_end:${second}`,
      "stop",
    ]);
    assert.deepEqual(
      events.at(-1).content.map((b) => [b.name, b.input]),
      [
        ["create_card", { key: "c1" }],
        ["link_cards", { from: "c1", to: "n_9", rel: "feeds" }],
      ],
    );
  });

  test("a second round translates tool calls, results and reasoning", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Q" }, { type: "text", text: "board", cache_control: { type: "ephemeral" } }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "r1" },
          { type: "text", text: "I will." },
          { type: "tool_use", id: "call_a", name: "create_card", input: { key: "c1", title: "A" } },
          { type: "tool_use", id: "call_b", name: "link_cards", input: { from: "c1", to: "x", rel: "feeds" } },
          { type: "server_tool_use", id: "s", name: "unknown" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a", content: '{"id":"n_2"}' },
          { type: "tool_result", tool_use_id: "call_b", content: "Unknown card", is_error: true },
          { type: "image", source: {} },
        ],
      },
    ];
    assert.deepEqual(toOpenAIMessages([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }], messages), [
      { role: "system", content: "SYS" },
      { role: "user", content: "Q\n\nboard" },
      {
        role: "assistant",
        content: "I will.",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "create_card", arguments: '{"key":"c1","title":"A"}' } },
          { id: "call_b", type: "function", function: { name: "link_cards", arguments: '{"from":"c1","to":"x","rel":"feeds"}' } },
        ],
        reasoning_content: "r1",
      },
      { role: "tool", tool_call_id: "call_a", content: '{"id":"n_2"}' },
      { role: "tool", tool_call_id: "call_b", content: "Error: Unknown card" },
    ]);

    // Reasoning that comes back is kept as a thinking block and sent back as reasoning_content.
    fake.chat.push({ sse: [chunk({ reasoning_content: "let me " }), chunk({ reasoning_content: "see" }), chunk({ content: "ok" }), chunk({}, "stop")] });
    const events = await collect(ds().stream({ system: "S", messages: [{ role: "user", content: "x" }] }));
    const content = events.at(-1).content;
    assert.deepEqual(content, [
      { type: "thinking", thinking: "let me see" },
      { type: "text", text: "ok" },
    ]);
    assert.ok(!events.some((e) => e.type === "text" && e.text.includes("let me")), "reasoning is not emitted as text");
    fake.chat.push({ sse: [chunk({ content: "again" }), chunk({}, "stop")] });
    await collect(ds().stream({ system: "S", messages: [{ role: "user", content: "x" }, { role: "assistant", content }, { role: "user", content: "y" }] }));
    assert.equal(fake.requests.at(-1).body.messages[2].reasoning_content, "let me see");
  });

  test("finish reasons: length, content_filter, an unknown reason, and a stream cut short", async () => {
    fake.chat.push({ sse: [chunk({ content: "trunc" }), chunk({}, "length")] });
    assert.equal((await collect(ds().stream({ system: "S", messages: [] }))).at(-1).reason, "max_tokens");
    fake.chat.push({ sse: [chunk({ content: "no" }), chunk({}, "content_filter")] });
    const stop = (await collect(ds().stream({ system: "S", messages: [] }))).at(-1);
    assert.equal(stop.reason, "refusal");
    assert.match(stop.message, /DeepSeek stopped this response with its content filter/);
    fake.chat.push({ sse: [chunk({ content: "x" }), chunk({}, "insufficient_system_resource")] });
    await assert.rejects(collect(ds().stream({ system: "S", messages: [] })), /stopped early \(insufficient_system_resource\)/);
    fake.chat.push({ sse: [chunk({ content: "cut" })], done: false });
    await assert.rejects(collect(ds().stream({ system: "S", messages: [] })), /ended before the response finished/);
  });

  test("abort through the signal", async () => {
    const first = chunk({ content: "first" });
    const firstLength = `data: ${JSON.stringify(first)}\n\n`.length;
    fake.chat.push({ sse: [first, chunk({ content: "never" }), chunk({}, "stop")], hangAfter: firstLength });
    const ctl = new AbortController();
    const seen = [];
    await assert.rejects(
      (async () => {
        for await (const ev of ds().stream({ system: "S", messages: [], signal: ctl.signal })) {
          seen.push(ev);
          ctl.abort();
        }
      })(),
      { name: "AbortError" },
    );
    assert.deepEqual(seen, [{ type: "text", text: "first" }]);
  });

  test("HTTP errors: 401, 402, 429 and a non-JSON body, with the key scrubbed", async () => {
    const cases = [
      [{ status: 401, json: { error: { message: `bad key ${DS_KEY}` } } }, /^DeepSeek API: authentication failed \(check the API key\)$/],
      [{ status: 402, json: { error: { message: "Insufficient Balance" } } }, /insufficient balance/],
      [{ status: 429, json: { error: { message: "slow down" } } }, /rate limited/],
      [{ status: 500, text: `<html>upstream broke for ${DS_KEY}</html>`, type: "text/html" }, /^DeepSeek API error 500: <html>upstream broke for \[redacted\]<\/html>$/],
    ];
    for (const [spec, pattern] of cases) {
      fake.chat.push(spec);
      const err = await collect(ds().stream({ system: "S", messages: [] })).then(() => null, (e) => e);
      assert.ok(err, "rejected");
      assert.match(err.message, pattern);
      noKeys(err.message, "an error message");
    }
  });

  test("Qwen: enable_thinking off, retried once without it when the model refuses, then remembered", async () => {
    const before = fake.chatRequests().length;
    const noThinkingField = new Set();
    const qwen = () =>
      createOpenAICompatProvider({ id: "qwen", label: "Qwen", baseURL: `${fake.url}/compatible-mode/v1`, apiKey: QW_KEY, model: "qwq-plus", noThinkingField });
    fake.chat.push({ status: 400, json: { error: { message: "The value of the enable_thinking parameter is restricted to True." } } });
    fake.chat.push({ sse: [chunk({ content: "ok" }), chunk({}, "stop")] });
    const events = await collect(qwen().stream({ system: "S", messages: [{ role: "user", content: "x" }] }));
    assert.equal(events.at(-1).reason, "end_turn");
    const sent = fake.chatRequests().slice(before);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].path, "/compatible-mode/v1/chat/completions");
    assert.equal(sent[0].body.enable_thinking, false);
    assert.ok(!("enable_thinking" in sent[1].body));
    assert.ok(!("thinking" in sent[0].body), "the DeepSeek switch is not sent to Qwen");
    fake.chat.push({ sse: [chunk({ content: "ok" }), chunk({}, "stop")] });
    await collect(qwen().stream({ system: "S", messages: [{ role: "user", content: "x" }] }));
    assert.equal(fake.chatRequests().length, before + 3, "no retry the second time");
    assert.ok(!("enable_thinking" in fake.chatRequests().at(-1).body));
    // A 400 about something else is not retried.
    fake.chat.push({ status: 400, json: { error: { message: "messages is required" } } });
    const other = createOpenAICompatProvider({ id: "qwen", label: "Qwen", baseURL: `${fake.url}/compatible-mode/v1`, apiKey: QW_KEY, model: "qwen-plus" });
    await assert.rejects(collect(other.stream({ system: "S", messages: [] })), /Qwen API error 400: messages is required/);
  });

  test("tool arguments that do not parse take the re-issue path", async () => {
    fake.chat.push({ sse: [toolDelta(0, { id: "call_z", name: "create_card", args: '{"key":"c1",,}' }), chunk({}, "tool_calls")] });
    await assert.rejects(collect(ds().stream({ system: "S", messages: [], tools: [CREATE_CARD] })), (err) => err.retryRound === true && err.name === "ToolInputParseError");
  });
});

// ---------- the registry and /api/providers ----------

describe("provider registry and /api/providers", () => {
  let fake;
  let app;
  let base;
  let dir;
  let keysFile;
  const logger = captureLogger();
  const bodies = []; // every response text, checked for keys at the end

  async function api(method, p, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["content-type"] ??= "application/json";
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  function raw(p, headers, method = "GET") {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: app.port, path: p, method, headers }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  const info = async (id) => (await api("GET", "/api/providers")).body.providers.find((p) => p.id === id);

  before(async () => {
    fake = await startFake();
    dir = mkdtempSync(path.join(tmpdir(), "pc-keys-"));
    keysFile = path.join(dir, ".keys.json");
    const mock = createMockProvider({ speed: 200 });
    const registry = createRegistry({ fallback: mock, env: {}, keysFile, endpoints: { deepseek: fake.url }, logger });
    app = await startServer({ port: 0, provider: mock, registry, logger });
    base = app.url;
  });

  after(async () => {
    await app?.close();
    await fake?.close();
    rmSync(dir, { recursive: true, force: true });
    for (const line of logger.lines) noKeys(line, "a log line");
    for (const text of bodies) noKeys(text, "a response");
    noKeys(JSON.stringify(app.log.since(0)), "the event log");
  });

  test("the initial listing: three providers, no keys, none active", async () => {
    const r = await api("GET", "/api/providers");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.active, { provider: null, model: null });
    assert.deepEqual(
      r.body.providers.map((p) => [p.id, p.needsKey, p.hasKey]),
      [
        ["anthropic", true, false],
        ["deepseek", true, false],
        ["qwen", true, false],
      ],
    );
    const qwen = r.body.providers[2];
    assert.deepEqual(
      qwen.regions.map((x) => x.id),
      ["intl", "us", "cn", "hk", "custom"],
    );
    assert.equal((await api("POST", "/api/providers/openai/key", { apiKey: "x" })).status, 404);
  });

  test("a rejected key stores nothing", async () => {
    fake.deepseekModels = () => ({ status: 401, json: { error: { message: `invalid key ${DS_KEY}` } } });
    const r = await api("POST", "/api/providers/deepseek/key", { apiKey: DS_KEY, remember: true });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /DeepSeek API: authentication failed/);
    assert.equal((await info("deepseek")).hasKey, false);
    assert.ok(!existsSync(keysFile));
    assert.equal((await api("POST", "/api/config", { provider: "deepseek", model: "deepseek-flash" })).status, 400);
  });

  test("a good key returns sorted models and a four-character hint, never the key", async () => {
    fake.deepseekModels = () => ({
      status: 200,
      json: {
        object: "list",
        data: [
          { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek", name: "DeepSeek-V4-Pro", context_window: 1000000, max_output_tokens: 64000 },
          { id: "deepseek-flash", object: "model", owned_by: "deepseek", name: "DeepSeek-V4.1-Flash", max_output_tokens: 8000 },
        ],
      },
    });
    const r = await api("POST", "/api/providers/deepseek/key", { apiKey: DS_KEY });
    assert.equal(r.status, 200);
    const p = r.body.provider;
    assert.deepEqual(p.models, [
      { id: "deepseek-flash", label: "DeepSeek-V4.1-Flash", maxOutput: 8000 },
      { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", contextWindow: 1000000, maxOutput: 64000 },
    ]);
    assert.equal(p.keyHint, "…" + DS_KEY.slice(-4));
    assert.equal(p.keyHint.length, 5);
    assert.equal(p.keySource, "page");
    assert.equal(p.remembered, false);
    assert.equal(p.model, null);
    assert.equal(fake.requests.at(-1).headers.authorization, `Bearer ${DS_KEY}`);
    assert.ok(!existsSync(keysFile), "not remembered unless asked");
  });

  test("POST /api/config switches provider and model; the model can be typed", async () => {
    assert.equal((await api("POST", "/api/config", { provider: "deepseek" })).status, 400, "no model yet");
    assert.equal((await api("POST", "/api/config", { provider: "qwen", model: "qwen-plus" })).status, 400, "no key");
    assert.equal((await api("POST", "/api/config", { provider: "nope", model: "x" })).status, 400);
    const r = await api("POST", "/api/config", { provider: "deepseek", model: "deepseek-flash" });
    assert.deepEqual(r.body, { provider: "deepseek", model: "deepseek-flash", mode: "fanout", maxCards: 4, length: "auto" });
    assert.deepEqual((await api("GET", "/api/config")).body, r.body);
    assert.equal((await api("POST", "/api/config", { model: "my-typed-model" })).body.model, "my-typed-model");
    assert.equal((await api("POST", "/api/config", { model: "deepseek-flash", mode: "single" })).body.mode, "single");
    assert.equal((await info("deepseek")).model, "deepseek-flash");
  });

  test("an ask through the engine against the fake, single mode", async () => {
    const before = fake.chatRequests().length;
    const { turnId } = (await api("POST", "/api/ask", { text: "Explain alpha and beta." })).body;
    await app.engine.idle();
    const s = app.log.state;
    assert.equal(s.nodes[turnId].status, "settled");
    const cards = cardsOf(s, turnId);
    assert.deepEqual(
      cards.map((c) => [c.title, c.status, c.summary]),
      [
        ["Alpha", "settled", "Alpha summary."],
        ["Beta", "settled", "Beta summary."],
      ],
    );
    assert.equal(cards[0].body, 'Alpha body: a < b, "q", back\\slash 🚀');
    assert.ok(s.edges.some((e) => e.from === cards[0].id && e.to === cards[1].id && e.rel === "feeds"));
    const sent = fake.chatRequests().slice(before);
    assert.equal(sent.length, 2, "two rounds");
    assert.equal(sent[0].body.max_tokens, 8000, "min(16000, maxOutput) from the model list");
    const second = sent[1].body.messages;
    const assistant = second.find((m) => m.role === "assistant");
    assert.equal(assistant.reasoning_content, "planning the board", "reasoning round-trips within the generation");
    assert.equal(assistant.tool_calls.length, 3);
    const tools = second.filter((m) => m.role === "tool");
    assert.deepEqual(
      tools.map((t) => t.tool_call_id),
      assistant.tool_calls.map((c) => c.id),
    );
    assert.deepEqual(JSON.parse(tools[0].content), { id: cards[0].id });
  });

  test("an ask through the engine against the fake, fan-out mode, and a reply", async () => {
    await api("POST", "/api/config", { mode: "fanout" });
    const before = fake.chatRequests().length;
    const { turnId } = (await api("POST", "/api/ask", { text: "Plan alpha and beta." })).body;
    await app.engine.idle();
    const s = app.log.state;
    const cards = cardsOf(s, turnId);
    assert.deepEqual(
      cards.map((c) => [c.title, c.status, c.summary, c.body]),
      [
        ["Alpha", "settled", "Writer summary.", 'Writer body: "q" → ok'],
        ["Beta", "settled", "Writer summary.", 'Writer body: "q" → ok'],
      ],
    );
    const sent = fake.chatRequests().slice(before);
    assert.equal(sent.filter((r) => r.body.tools.some((t) => t.function.name === "write_card")).length, 2, "one writer per card");
    const r = (await api("POST", `/api/nodes/${cards[0].id}/reply`, { text: "more?" })).body;
    await app.engine.idle();
    assert.equal(s.nodes[r.assistantNodeId].body, "A plain reply.");
    assert.equal(threadOf(s, cards[0].id).length, 2);
  });

  test("DELETE while active leaves no provider", async () => {
    const r = await api("DELETE", "/api/providers/deepseek/key");
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.hasKey, false);
    assert.equal(r.body.provider.models, null);
    assert.equal((await api("GET", "/api/config")).body.provider, null);
    assert.deepEqual((await api("GET", "/api/providers")).body.active, { provider: null, model: null });
  });

  test("remember writes .keys.json (0600) and DELETE removes it; startup reads it without calling upstream", async () => {
    const r = await api("POST", "/api/providers/deepseek/key", { apiKey: DS_KEY, remember: true });
    assert.equal(r.body.provider.remembered, true);
    assert.ok(existsSync(keysFile));
    assert.deepEqual(JSON.parse(readFileSync(keysFile, "utf8")), { deepseek: { apiKey: DS_KEY } });
    if (process.platform !== "win32") assert.equal(statSync(keysFile).mode & 0o777, 0o600);

    const calls = fake.requests.length;
    const fresh = createRegistry({ env: {}, keysFile, endpoints: { deepseek: fake.url }, logger });
    await fresh.init();
    const d = fresh.info("deepseek");
    assert.deepEqual([d.hasKey, d.keySource, d.remembered, d.models], [true, "file", true, null]);
    assert.equal(fake.requests.length, calls, "no upstream call at startup");

    await api("DELETE", "/api/providers/deepseek/key");
    assert.ok(!existsSync(keysFile), "the last entry removed the file");
  });

  test("environment keys at startup: hasKey, models null, no upstream call, nothing logged", async () => {
    const lines = captureLogger();
    const calls = fake.requests.length;
    const reg = createRegistry({
      env: { DEEPSEEK_API_KEY: ENV_KEY, DASHSCOPE_API_KEY: QW_KEY, DASHSCOPE_REGION: "us" },
      keysFile: path.join(dir, "absent.json"),
      logger: lines,
    });
    await reg.init();
    const { active, providers } = reg.list();
    assert.deepEqual(active, { provider: null, model: null });
    const [ds, qw] = [providers[1], providers[2]];
    assert.deepEqual([ds.hasKey, ds.keySource, ds.models], [true, "env", null]);
    assert.deepEqual([qw.hasKey, qw.keySource, qw.region, qw.baseURL], [true, "env", "us", null]);
    assert.equal(fake.requests.length, calls);
    assert.ok(lines.lines.some((l) => /keys available: deepseek \(env\), qwen \(env\)/.test(l)));
    for (const l of lines.lines) noKeys(l, "a startup log line");
    noKeys(JSON.stringify(reg.list()), "the listing");
  });

  test("Qwen: paged native model list filtered to function calling", async () => {
    const models = Array.from({ length: 150 }, (_, i) => ({
      model: `qwen-m${String(i).padStart(3, "0")}`,
      name: `Qwen M${i}`,
      ...(i % 3 === 0 ? {} : { features: i % 3 === 1 ? ["function-calling", "streaming"] : ["streaming"] }),
      model_info: { context_window: 131072, max_output_tokens: 8192 },
    }));
    const pages = [];
    fake.qwenNative = (entry) => {
      pages.push([entry.query.page_no, entry.query.page_size, entry.headers.authorization]);
      const n = Number(entry.query.page_no);
      return { status: 200, json: { success: true, output: { total: 150, page_no: n, page_size: 100, models: models.slice((n - 1) * 100, n * 100) } } };
    };
    const r = await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, baseURL: `${fake.url}/compatible-mode/v1/` });
    assert.equal(r.status, 200);
    assert.deepEqual(pages, [
      ["1", "100", `Bearer ${QW_KEY}`],
      ["2", "100", `Bearer ${QW_KEY}`],
    ]);
    const p = r.body.provider;
    assert.equal(p.region, "custom");
    assert.equal(p.baseURL, `${fake.url}/compatible-mode/v1`);
    assert.equal(p.models.length, 100, "models without a features field, plus those with function-calling");
    assert.ok(p.models.every((m, i, all) => i === 0 || all[i - 1].id < m.id), "sorted by id");
    assert.deepEqual(p.models[0], { id: "qwen-m000", label: "Qwen M0", contextWindow: 131072, maxOutput: 8192 });
    assert.ok(!p.models.some((m) => m.id === "qwen-m002"), "a model without function-calling is dropped");
  });

  test("Qwen: OpenAI-style list when the native one is missing, then the chat check", async () => {
    fake.qwenNative = () => ({ status: 404, json: { message: "Not Found" } });
    fake.qwenOpenAI = () => ({ status: 200, json: { object: "list", data: [{ id: "qwen-plus" }, { id: "qwen-flash" }] } });
    let r = await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, baseURL: `${fake.url}/compatible-mode/v1` });
    assert.deepEqual(
      r.body.provider.models.map((m) => [m.id, m.label]),
      [
        ["qwen-flash", "qwen-flash"],
        ["qwen-plus", "qwen-plus"],
      ],
    );

    fake.qwenNative = () => ({ status: 500, text: "oops" });
    fake.qwenOpenAI = () => ({ status: 500, text: "oops" });
    let checked = null;
    fake.validate = (entry) => {
      checked = entry.body;
      return { status: 200, json: { choices: [{ message: { content: "p" } }] } };
    };
    r = await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, baseURL: `${fake.url}/compatible-mode/v1` });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.hasKey, true);
    assert.equal(r.body.provider.models, null);
    assert.match(r.body.provider.modelsError, /could not be fetched/);
    assert.deepEqual([checked.model, checked.max_tokens, checked.stream], ["qwen-plus", 1, undefined]);

    await api("DELETE", "/api/providers/qwen/key");
    fake.validate = () => ({ status: 401, json: { error: { message: "Incorrect API key provided." } } });
    r = await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, baseURL: `${fake.url}/compatible-mode/v1` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Qwen API: authentication failed/);
    assert.equal((await info("qwen")).hasKey, false);
  });

  test("baseURL and region validation", async () => {
    for (const bad of ["http://example.com/v1", "ftp://127.0.0.1/v1", "not a url", "https://user:pw@example.com/v1"]) {
      const r = await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, baseURL: bad });
      assert.equal(r.status, 400, bad);
    }
    assert.equal((await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, region: "mars" })).status, 400);
    assert.equal((await api("POST", "/api/providers/qwen/key", { apiKey: QW_KEY, region: "custom" })).status, 400);
    assert.equal((await api("POST", "/api/providers/deepseek/key", { apiKey: DS_KEY, baseURL: "https://x.example" })).status, 400);
    assert.equal((await api("POST", "/api/providers/deepseek/key", { apiKey: "" })).status, 400);
  });

  test("cross-origin Origin, a wrong Host and non-JSON bodies are rejected", async () => {
    assert.equal((await api("GET", "/api/providers", undefined, { origin: "http://evil.example" })).status, 403);
    assert.equal((await api("GET", "/api/providers", undefined, { origin: base })).status, 200);
    assert.equal((await api("GET", "/api/providers", undefined, { origin: base.replace("127.0.0.1", "localhost") })).status, 403, "Origin must match the Host used");
    const local = await raw("/api/providers", { host: `localhost:${app.port}`, origin: `http://localhost:${app.port}` });
    assert.equal(local.status, 200);
    assert.equal((await raw("/api/providers", { host: `evil.example:${app.port}` })).status, 403, "DNS rebinding");
    assert.equal((await raw("/api/providers", { host: "127.0.0.1:1" })).status, 403, "wrong port");
    assert.equal((await api("POST", "/api/providers/deepseek/key", `{"apiKey":"${DS_KEY}"}`, { "content-type": "text/plain" })).status, 415);
    assert.equal((await api("POST", "/api/config", '{"mode":"single"}', { "content-type": "text/plain" })).status, 415);
    assert.equal((await api("POST", "/api/config", { mode: "single" }, { origin: "http://evil.example" })).status, 403);
    assert.equal((await api("POST", "/api/providers/deepseek/models", "x=1", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await api("POST", "/api/providers/deepseek/models")).status, 400, "no key to list with");
    assert.equal((await api("GET", "/api/state", undefined, { origin: "http://evil.example" })).status, 200, "other routes are unchanged");
  });
});

// ---------- switching while a generation runs ----------

test("switching provider mid-stream leaves the running generation on the old provider", async () => {
  const fake = await startFake();
  try {
    fake.deepseekModels = () => ({ status: 200, json: { object: "list", data: [{ id: "deepseek-flash" }] } });
    const inner = createMockProvider({ speed: 200 });
    const mockCalls = [];
    const mock = {
      name: "mock",
      model: "mock",
      async *stream(args) {
        mockCalls.push(args.meta.purpose);
        yield* inner.stream(args);
      },
    };
    const registry = createRegistry({ fallback: mock, env: {}, keysFile: null, endpoints: { deepseek: fake.url }, logger: captureLogger() });
    const log = createLog();
    const engine = createEngine({ log, registry, mode: "single", logger: captureLogger() });
    await registry.setKey("deepseek", { apiKey: DS_KEY });

    const question = "How should we store events, and how do we stream them?";
    const first = engine.ask({ text: question }).turnId;
    // Switch as soon as the first card opens, while that answer is still streaming.
    await new Promise((resolve) => {
      const off = log.subscribe((ev) => {
        if (ev.type === "node.open" && ev.node.kind === "card") {
          off();
          engine.setConfig({ provider: "deepseek", model: "deepseek-flash" });
          resolve();
        }
      });
    });
    assert.equal(engine.getConfig().provider, "deepseek");
    const second = engine.ask({ text: "Explain alpha and beta." }).turnId;
    await engine.idle();

    const s = log.state;
    assert.deepEqual(
      cardsOf(s, first).map((c) => c.title),
      derivePlan(question).cards.map((c) => c.title),
      "the first answer finished on the mock",
    );
    assert.deepEqual(mockCalls, ["turn", "turn"], "both rounds of the first answer went to the mock");
    assert.deepEqual(
      cardsOf(s, second).map((c) => c.title),
      ["Alpha", "Beta"],
      "work started after the switch used DeepSeek",
    );
    assert.equal(fake.chatRequests().length, 2);
    assert.ok(fake.chatRequests().every((r) => r.body.messages.some((m) => m.content?.includes?.("Explain alpha and beta."))));
  } finally {
    await fake.close();
  }
});
