// The Anthropic provider and the real SDK against a local server that speaks
// the Messages API streaming format (event names and shapes as in the bundled
// claude-api skill's streaming.md). No network, no key. Skipped when the SDK
// is not installed.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { cardsOf } from "../shared/project.mjs";
import { SYSTEM_PROMPT } from "../server/context.mjs";
import { createEngine } from "../server/engine.mjs";
import { createLog } from "../server/log.mjs";

let sdkMissing = false;
try {
  await import("@anthropic-ai/sdk");
} catch {
  sdkMissing = true;
}
const { createAnthropicProvider } = await import("../server/providers/anthropic.mjs");

const quiet = { log() {}, warn() {}, error() {} };

function sseMessage(blocks, stopReason, stopDetails = null) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (let i = 0; i < b.text.length; i += 4) {
        events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text.slice(i, i + 4) } });
      }
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      for (let i = 0; i < b.json.length; i += 5) {
        events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: b.json.slice(i, i + 5) } });
      }
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null, ...(stopDetails ? { stop_details: stopDetails } : {}) },
    usage: { output_tokens: 42 },
  });
  events.push({ type: "message_stop" });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

const BODY = 'Use an append-only log.\nQuote "this", path C:\\logs, arrow \u2192 and \ud83d\ude80.';
const CARD_JSON = JSON.stringify({ key: "c1", title: "Storage", summary: "Keep a log.", body: BODY }).replace(
  /[\u007f-\uffff]/g,
  (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
);

describe("Anthropic provider against a local fake API", { skip: sdkMissing && "@anthropic-ai/sdk not installed" }, () => {
  let server;
  let baseURL;
  const requests = [];
  let responses = [];

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        requests.push({ path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
        if (req.method === "GET" && req.url.startsWith("/v1/models")) {
          const auth = req.headers["x-api-key"] ?? req.headers.authorization ?? "";
          if (auth.includes("rejected")) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: [
                { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", max_input_tokens: 1000000, max_tokens: 128000 },
                { type: "model", id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000, max_tokens: 128000 },
              ],
              has_more: false,
              first_id: "claude-sonnet-5-5",
              last_id: "claude-opus-5-5",
            }),
          );
          return;
        }
        const next = responses.shift();
        res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
        res.end(next);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    baseURL = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((r) => server.close(r)));

  async function run(script, mode = "single") {
    requests.length = 0;
    responses = script;
    const provider = await createAnthropicProvider({ apiKey: "test-key-not-real", baseURL });
    const log = createLog();
    const engine = createEngine({ log, provider, mode, logger: quiet });
    const { turnId } = engine.ask({ text: "How should we store events?" });
    await engine.idle();
    return { s: log.state, turnId };
  }

  test("request shape, streamed card, and exact replay of the assistant content", async () => {
    const { s, turnId } = await run([
      sseMessage(
        [
          { type: "thinking", signature: "sig-abc" },
          { type: "text", text: "One card." },
          { type: "tool_use", id: "toolu_1", name: "create_card", json: CARD_JSON },
          { type: "tool_use", id: "toolu_2", name: "link_cards", json: '{"from":"c1","to":"nope","rel":"elaborates"}' },
        ],
        "tool_use",
      ),
      sseMessage([{ type: "text", text: "Done." }], "end_turn"),
    ]);
    assert.equal(s.nodes[turnId].status, "settled");
    const [card] = cardsOf(s, turnId);
    assert.equal(card.title, "Storage");
    assert.equal(card.summary, "Keep a log.");
    assert.equal(card.body, BODY);
    assert.equal(card.status, "settled");

    assert.equal(requests.length, 2);
    const first = requests[0];
    assert.equal(first.path, "/v1/messages");
    const auth = first.headers["x-api-key"] ?? first.headers.authorization;
    assert.match(auth, /test-key-not-real$/, "the key is sent (SDK 1.8.0 sends it as a bearer token)");
    assert.equal(first.body.model, "claude-opus-5-5");
    assert.equal(first.body.max_tokens, 64000);
    assert.equal(first.body.stream, true);
    assert.deepEqual(first.body.output_config, { effort: "medium" });
    assert.ok(!("thinking" in first.body) && !("tool_choice" in first.body));
    assert.deepEqual(first.body.system, [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    assert.deepEqual(
      first.body.tools.map((t) => [t.name, t.eager_input_streaming]),
      [
        ["create_card", true],
        ["link_cards", true],
      ],
    );

    const replay = requests[1].body.messages;
    assert.equal(replay.length, 3);
    assert.deepEqual(replay[1].content[0], { type: "thinking", thinking: "", signature: "sig-abc" });
    assert.equal(replay[1].content[1].text, "One card.");
    assert.deepEqual(replay[1].content[2], {
      type: "tool_use",
      id: "toolu_1",
      name: "create_card",
      input: JSON.parse(CARD_JSON),
    });
    const results = replay[2].content;
    assert.equal(replay[2].role, "user");
    assert.deepEqual(
      results.map((r) => [r.tool_use_id, !!r.is_error]),
      [
        ["toolu_1", false],
        ["toolu_2", true],
      ],
    );
    assert.match(results[1].content, /Unknown card "nope"/);
  });

  test("a refusal is surfaced as an error with its category", async () => {
    const { s, turnId } = await run([
      sseMessage(
        [{ type: "tool_use", id: "toolu_1", name: "create_card", json: '{"key":"c1","title":"Half","summary":"s","body":"cu' }],
        "refusal",
        { category: "cyber", explanation: "Not this one." },
      ),
    ]);
    assert.equal(s.nodes[turnId].status, "error");
    assert.equal(s.nodes[turnId].error, "The model declined this request (cyber): Not this one.");
    assert.equal(cardsOf(s, turnId)[0].status, "error");
    assert.equal(requests.length, 1, "no tools ran, nothing was sent back");
  });

  test("a key from the page: models.list() for the model list, a rejected key stores nothing", async () => {
    const { createRegistry } = await import("../server/providers/registry.mjs");
    const reg = createRegistry({ env: {}, keysFile: null, endpoints: { anthropic: baseURL }, logger: quiet });
    await assert.rejects(reg.setKey("anthropic", { apiKey: "sk-ant-rejected-0000000000" }), /authentication failed/);
    assert.equal(reg.info("anthropic").hasKey, false);
    const p = await reg.setKey("anthropic", { apiKey: "sk-ant-accepted-0000001234" });
    assert.deepEqual(p.models, [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", contextWindow: 1000000, maxOutput: 128000 },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", contextWindow: 1000000, maxOutput: 128000 },
    ]);
    assert.equal(p.keyHint, "…1234");
    // Switching to it sends the next generation through the SDK with that key.
    reg.activate(reg.check("anthropic", "claude-sonnet-5-5"));
    requests.length = 0;
    responses = [sseMessage([{ type: "text", text: "Plain answer." }], "end_turn")];
    const log = createLog();
    const engine = createEngine({ log, registry: reg, mode: "single", logger: quiet });
    const { turnId } = engine.ask({ text: "hi" });
    await engine.idle();
    assert.equal(cardsOf(log.state, turnId)[0].body, "Plain answer.");
    assert.equal(requests[0].body.model, "claude-sonnet-5-5");
    assert.match(requests[0].headers.authorization ?? requests[0].headers["x-api-key"], /sk-ant-accepted-0000001234/);
  });

  test("a tool input the SDK cannot parse re-issues the round", async () => {
    const { s, turnId } = await run([
      sseMessage([{ type: "tool_use", id: "toolu_1", name: "create_card", json: CARD_JSON + "}" }], "tool_use"),
      sseMessage([{ type: "tool_use", id: "toolu_2", name: "create_card", json: CARD_JSON }], "tool_use"),
      sseMessage([{ type: "text", text: "Done." }], "end_turn"),
    ]);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[1].body.messages, requests[0].body.messages, "the same request again");
    assert.equal(s.nodes[turnId].status, "settled");
    assert.deepEqual(
      cardsOf(s, turnId).map((c) => c.status),
      ["error", "settled"],
    );
  });
});
