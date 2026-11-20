// ChatGPT sign-in (OAuth + PKCE) and the Codex-backend provider, plus the
// OpenCode key provider, all against local fakes. Nothing here reaches OpenAI
// or opencode.ai.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { cardsOf } from "../shared/project.mjs";
import { startServer } from "../server/http.mjs";
import {
  createChatGPTProvider,
  describeTokens,
  parseCallbackInput,
  toResponsesInput,
} from "../server/providers/chatgpt.mjs";
import { createRegistry } from "../server/providers/registry.mjs";
import { CREATE_CARD } from "../server/tools.mjs";

const ACCOUNT = "acct-fake-0001";
const OC_KEY = "oc-fake-opencode-key-0123456789abcd";
const secrets = new Set([OC_KEY]); // every token the fake hands out

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload) => `${b64({ alg: "none" })}.${b64(payload)}.c2ln`;
let tokenSeq = 0;
function issueTokens({ expiresIn = 3600 } = {}) {
  const n = ++tokenSeq;
  const t = {
    access_token: jwt({ n, exp: Math.floor(Date.now() / 1000) + expiresIn, "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: "plus" } }),
    id_token: jwt({ n, email: "me@example.com" }),
    refresh_token: `rt-fake-secret-${n}-abcdefgh`,
    expires_in: expiresIn,
  };
  for (const v of [t.access_token, t.id_token, t.refresh_token]) secrets.add(v);
  return t;
}

const noSecrets = (text, where) => {
  for (const s of secrets) assert.ok(!String(text).includes(s), `a token leaked into ${where}`);
};

// ---------- Responses API stream helpers ----------

const ev = (type, o = {}) => ({ type, ...o });
const completed = (output = []) => ev("response.completed", { response: { status: "completed", output } });
function textSSE(text, step = 4) {
  const out = [ev("response.created", { response: { id: "resp_1" } }), ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg_1" } })];
  for (let i = 0; i < text.length; i += step) out.push(ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, delta: text.slice(i, i + step) }));
  out.push(completed());
  return out;
}
let callSeq = 0;
function callsSSE(calls) {
  const out = [ev("response.created", { response: { id: "resp_2" } })];
  calls.forEach((c, i) => {
    const n = ++callSeq;
    const item = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: c.name, arguments: "" };
    const args = JSON.stringify(c.input);
    out.push(ev("response.output_item.added", { output_index: i, item }));
    for (let j = 0; j < args.length; j += 9) out.push(ev("response.function_call_arguments.delta", { item_id: item.id, output_index: i, delta: args.slice(j, j + 9) }));
    out.push(ev("response.function_call_arguments.done", { item_id: item.id, output_index: i, arguments: args }));
    out.push(ev("response.output_item.done", { output_index: i, item: { ...item, arguments: args, status: "completed" } }));
  });
  out.push(completed());
  return out;
}

// Answers like a model would, from a Responses request.
function brain(body) {
  const tools = (body.tools ?? []).map((t) => t.name);
  if (body.input.at(-1)?.type === "function_call_output") return { sse: textSSE("Done.") };
  if (tools.includes("write_card")) return { sse: callsSSE([{ name: "write_card", input: { summary: "Writer summary.", body: "Writer body." } }]) };
  if (tools.includes("create_card")) {
    const fanout = "intent" in body.tools.find((t) => t.name === "create_card").parameters.properties;
    return {
      sse: callsSSE(
        ["Alpha", "Beta"].map((title, i) => ({
          name: "create_card",
          input: fanout ? { key: `c${i + 1}`, title, intent: `Cover ${title}.` } : { key: `c${i + 1}`, title, summary: `${title} summary.`, body: `${title} body.` },
        })),
      ),
    };
  }
  return { sse: textSSE("A plain reply.") };
}

// ---------- the fake auth server + backend ----------

async function startFake() {
  const fake = {
    requests: [],
    responses: [], // queued specs for POST /responses; falls back to brain
    token: null, // (form) => spec; default below
    models: () => ({ status: 200, json: { models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 400000 }, { slug: "secret-internal", visibility: "hide" }] } }),
    url: "",
  };
  const defaultToken = (form) => {
    if (form.grant_type === "authorization_code" && form.code === "good-code") {
      const verifierOK = fake.challenge && createHash("sha256").update(form.code_verifier).digest("base64url") === fake.challenge;
      if (!verifierOK) return { status: 400, json: { error: "invalid_grant", error_description: "PKCE verification failed" } };
      return { status: 200, json: issueTokens() };
    }
    if (form.grant_type === "refresh_token" && /^rt-fake-secret-/.test(form.refresh_token)) return { status: 200, json: issueTokens() };
    return { status: 400, json: { error: "invalid_grant", error_description: "bad code" } };
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    let raw = "";
    for await (const c of req) raw += c;
    const isForm = /x-www-form-urlencoded/.test(req.headers["content-type"] ?? "");
    const body = raw ? (isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : null;
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
    fake.requests.push(entry);
    let spec;
    if (req.method === "POST" && url.pathname === "/oauth/token") spec = (fake.token ?? defaultToken)(body);
    else if (req.method === "GET" && url.pathname === "/models") spec = fake.models(entry);
    else if (req.method === "GET" && url.pathname === "/v1/models") spec = { status: 200, json: { object: "list", data: [{ id: "kimi-k3", type: "chat", name: "Kimi K3", limit: { context: 1048576, output: 65536 } }, { id: "big-pickle-free", type: "chat" }, { id: "gpt-image-2.5-sunburst", type: "image" }, { id: "text-embedding-9", type: "embedding" }, { id: "glm-5.3", type: "chat" }] } };
    else if (req.method === "POST" && url.pathname === "/responses") spec = fake.responses.length ? fake.responses.shift() : brain(body);
    else if (req.method === "POST" && url.pathname === "/chat/completions") {
      const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
      spec = { sse: [chunk({ content: "From OpenCode." }), chunk({}, "stop")], done: true };
    } else spec = { status: 404, json: { error: { message: "no route" } } };
    if (typeof spec === "function") spec = spec(entry);
    if (spec.sse) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let text = spec.sse.map((e) => `event: ${e.type ?? "message"}\ndata: ${JSON.stringify(e)}\n\n`).join("");
      if (spec.done) text += "data: [DONE]\n\n";
      for (let i = 0; i < text.length; i += 13) {
        res.write(text.slice(i, i + 13));
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    } else if (spec.json !== undefined) {
      res.writeHead(spec.status, { "content-type": "application/json" });
      res.end(JSON.stringify(spec.json));
    } else {
      res.writeHead(spec.status, { "content-type": spec.type ?? "text/plain" });
      res.end(spec.text ?? "");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(r);
  });
  fake.of = (p) => fake.requests.filter((r) => r.path === p);
  return fake;
}

const collect = async (stream) => {
  const out = [];
  for await (const e of stream) out.push(e);
  return out;
};

// ---------- small pieces ----------

describe("ChatGPT helpers", () => {
  test("parseCallbackInput takes the full address, a query string or a bare code", () => {
    assert.deepEqual(parseCallbackInput("http://localhost:1455/auth/callback?code=abc&state=xyz"), { code: "abc", state: "xyz", error: null });
    assert.deepEqual(parseCallbackInput("?code=abc&state=xyz"), { code: "abc", state: "xyz", error: null });
    assert.deepEqual(parseCallbackInput("  abc-123  "), { code: "abc-123", state: null, error: null });
    assert.deepEqual(parseCallbackInput("http://localhost:1455/auth/callback?error=access_denied&state=s"), { code: null, state: "s", error: "access_denied" });
    assert.equal(parseCallbackInput(""), null);
    assert.equal(parseCallbackInput("http://localhost:1455/auth/callback"), null);
    assert.equal(parseCallbackInput("not a code!"), null);
  });

  test("describeTokens reads the account id, plan and email", () => {
    const t = issueTokens();
    const d = describeTokens({ accessToken: t.access_token, idToken: t.id_token });
    assert.equal(d.accountId, ACCOUNT);
    assert.equal(d.plan, "plus");
    assert.equal(d.email, "me@example.com");
    assert.ok(d.exp > Date.now());
    assert.deepEqual(describeTokens({ accessToken: "nope", idToken: null }), { accountId: null, plan: null, email: null, exp: null });
  });

  test("toResponsesInput translates the engine's Anthropic-shaped history", () => {
    const input = toResponsesInput([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "ok" }, { type: "tool_use", id: "toolu_1", name: "create_card", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "{\"id\":\"n1\"}" }] }, { type: "text", text: "next" }] },
    ]);
    assert.deepEqual(input, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
      { type: "function_call", call_id: "toolu_1", name: "create_card", arguments: "{\"a\":1}" },
      { type: "function_call_output", call_id: "toolu_1", output: "{\"id\":\"n1\"}" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
    ]);
  });
});

// ---------- the provider ----------

describe("ChatGPT provider against a fake backend", () => {
  let fake;
  before(async () => {
    fake = await startFake();
  });
  after(() => fake.close());

  const cred = () => {
    const t = issueTokens();
    return { accessToken: t.access_token, refreshToken: t.refresh_token, idToken: t.id_token, accountId: ACCOUNT, expiresAt: Date.now() + 3600e3 };
  };
  const provider = (extra = {}) => {
    const c = cred();
    return createChatGPTProvider({ model: "gpt-5.5", baseURL: fake.url, getCredential: async () => c, refresh: async () => c, fetch: globalThis.fetch, ...extra });
  };

  test("streams text; the request is shaped like Codex's", async () => {
    fake.requests.length = 0;
    fake.responses.push({ sse: textSSE("Hello there") });
    const events = await collect(provider().stream({ system: [{ type: "text", text: "SYS" }], messages: [{ role: "user", content: "hi" }], tools: [CREATE_CARD] }));
    assert.equal(events.filter((e) => e.type === "text").map((e) => e.text).join(""), "Hello there");
    assert.deepEqual(events.at(-1), { type: "stop", reason: "end_turn", content: [{ type: "text", text: "Hello there" }], message: undefined });
    const req = fake.of("/responses")[0];
    assert.match(req.headers.authorization, /^Bearer /);
    assert.equal(req.headers["chatgpt-account-id"], ACCOUNT);
    assert.equal(req.headers.originator, "codex_cli_rs");
    assert.equal(req.headers["openai-beta"], "responses=experimental");
    assert.ok(req.headers.session_id);
    assert.equal(req.body.model, "gpt-5.5");
    assert.equal(req.body.instructions, "SYS");
    assert.equal(req.body.store, false);
    assert.equal(req.body.stream, true);
    assert.equal(req.body.max_output_tokens, undefined);
    assert.deepEqual(req.body.input, [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    assert.deepEqual(req.body.tools[0], { type: "function", name: "create_card", description: CREATE_CARD.description, parameters: CREATE_CARD.input_schema, strict: false });
    assert.equal(req.body.tool_choice, "auto");
  });

  test("function calls stream as tool events and end in tool_use", async () => {
    fake.responses.push({ sse: callsSSE([{ name: "create_card", input: { key: "c1", title: "A" } }, { name: "link_cards", input: { from: "c1", to: "c2" } }]) });
    const events = await collect(provider().stream({ system: "S", messages: [{ role: "user", content: "go" }], tools: [CREATE_CARD] }));
    const starts = events.filter((e) => e.type === "tool_start");
    assert.deepEqual(starts.map((e) => e.name), ["create_card", "link_cards"]);
    for (const s of starts) {
      const json = events.filter((e) => e.type === "tool_delta" && e.id === s.id).map((e) => e.json).join("");
      assert.ok(JSON.parse(json));
      assert.equal(events.filter((e) => e.type === "tool_end" && e.id === s.id).length, 1, "ended once");
    }
    const stop = events.at(-1);
    assert.equal(stop.reason, "tool_use");
    assert.deepEqual(stop.content.map((b) => [b.type, b.name, b.input]), [
      ["tool_use", "create_card", { key: "c1", title: "A" }],
      ["tool_use", "link_cards", { from: "c1", to: "c2" }],
    ]);
    assert.match(stop.content[0].id, /^call_/);
  });

  test("instructions refused: retried once with Codex's prompt, and remembered", async () => {
    fake.requests.length = 0;
    fake.responses.push({ status: 400, json: { detail: "Instructions are not valid" } });
    fake.responses.push({ sse: textSSE("ok") });
    fake.responses.push({ sse: textSSE("ok again") });
    const quirks = { needsCodexPrompt: false };
    let loads = 0;
    const p = provider({ quirks, loadCodexPrompt: async () => (loads++, "CODEX PROMPT") });
    await collect(p.stream({ system: "OUR SYSTEM", messages: [{ role: "user", content: "hi" }] }));
    const [first, second] = fake.of("/responses");
    assert.equal(first.body.instructions, "OUR SYSTEM");
    assert.equal(second.body.instructions, "CODEX PROMPT");
    assert.deepEqual(second.body.input[0], { type: "message", role: "developer", content: [{ type: "input_text", text: "OUR SYSTEM" }] });
    assert.equal(quirks.needsCodexPrompt, true);
    await collect(p.stream({ system: "OUR SYSTEM", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(fake.of("/responses")[2].body.instructions, "CODEX PROMPT", "no wasted request the next time");
    assert.equal(loads, 2);
  });

  test("401 refreshes once and retries; 403 from bot protection and 429 read plainly", async () => {
    fake.requests.length = 0;
    const a = cred();
    const b = cred();
    let refreshed = 0;
    fake.responses.push({ status: 401, json: { error: { message: "token expired" } } });
    fake.responses.push({ sse: textSSE("after refresh") });
    const p = createChatGPTProvider({ model: "gpt-5.5", baseURL: fake.url, getCredential: async () => a, refresh: async () => (refreshed++, b) });
    const events = await collect(p.stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.at(-1).content[0].text, "after refresh");
    assert.equal(refreshed, 1);
    const [r1, r2] = fake.of("/responses");
    assert.equal(r1.headers.authorization, `Bearer ${a.accessToken}`);
    assert.equal(r2.headers.authorization, `Bearer ${b.accessToken}`);

    fake.responses.push({ status: 403, type: "text/html", text: "<!DOCTYPE html><html>Just a moment… cf-ray</html>" });
    await assert.rejects(collect(provider().stream({ system: "S", messages: [{ role: "user", content: "hi" }] })), /bot protection/);
    fake.responses.push({ status: 429, json: { error: { message: "The usage limit has been reached", type: "usage_limit_reached" } } });
    await assert.rejects(collect(provider().stream({ system: "S", messages: [{ role: "user", content: "hi" }] })), /usage limit reached/);
  });

  test("a failed or truncated stream is an error; max_output_tokens maps to max_tokens", async () => {
    fake.responses.push({ sse: [ev("response.created"), ev("response.failed", { response: { error: { message: "model overloaded" } } })] });
    await assert.rejects(collect(provider().stream({ system: "S", messages: [] })), /ChatGPT: model overloaded/);
    fake.responses.push({ sse: [ev("response.created"), ev("response.output_text.delta", { delta: "half" })] });
    await assert.rejects(collect(provider().stream({ system: "S", messages: [] })), /ended before the response finished/);
    fake.responses.push({ sse: [ev("response.output_text.delta", { delta: "cut" }), ev("response.incomplete", { response: { incomplete_details: { reason: "max_output_tokens" } } })] });
    const events = await collect(provider().stream({ system: "S", messages: [] }));
    assert.equal(events.at(-1).reason, "max_tokens");
  });
});

// ---------- sign-in, registry and routes ----------

describe("ChatGPT sign-in through /api/providers", () => {
  let fake;
  let app;
  let dir;
  let keysFile;
  const lines = [];
  const logger = { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
  const bodies = [];

  async function api(method, p, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
    const res = await fetch(app.url + p, init);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const chatgpt = async () => (await api("GET", "/api/providers")).body.providers.find((p) => p.id === "chatgpt");

  // What the browser does when OpenAI redirects back.
  async function land(authorizeURL, { code = "good-code", state } = {}) {
    const u = new URL(authorizeURL);
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.hostname = "127.0.0.1";
    back.searchParams.set("code", code);
    back.searchParams.set("state", state ?? u.searchParams.get("state"));
    const res = await fetch(back);
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, text };
  }

  before(async () => {
    fake = await startFake();
    dir = mkdtempSync(path.join(tmpdir(), "pc-chatgpt-"));
    keysFile = path.join(dir, ".keys.json");
    const registry = createRegistry({
      env: {},
      keysFile,
      logger,
      endpoints: { chatgptAuth: fake.url, chatgpt: fake.url, chatgptCallbackPort: 0, codexPrompt: async () => "CODEX PROMPT", opencode: fake.url, opencodeModels: `${fake.url}/v1/models` },
    });
    app = await startServer({ port: 0, registry, logger });
  });

  after(async () => {
    await app?.close();
    await fake?.close();
    rmSync(dir, { recursive: true, force: true });
    for (const b of bodies) noSecrets(b, "a response");
    for (const l of lines) noSecrets(l, "a log line");
    noSecrets(JSON.stringify(app.log.since(0)), "the event log");
  });

  test("start: a PKCE authorize address for Codex's client, nothing signed in yet", async () => {
    const r = await api("POST", "/api/providers/chatgpt/login", {}); // saved by default
    assert.equal(r.status, 200);
    const p = r.body.provider;
    assert.equal(p.hasKey, false);
    assert.equal(p.login.pending, true);
    assert.equal(p.login.callback, true);
    const u = new URL(p.login.url);
    assert.equal(u.origin + u.pathname, `${fake.url}/oauth/authorize`);
    assert.equal(u.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.equal(u.searchParams.get("code_challenge_method"), "S256");
    assert.equal(u.searchParams.get("scope"), "openid profile email offline_access");
    assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/localhost:\d+\/auth\/callback$/);
    fake.challenge = u.searchParams.get("code_challenge");
    assert.equal((await api("POST", "/api/config", { provider: "chatgpt", model: "gpt-5.5" })).status, 400, "not signed in");
  });

  test("a redirect with the wrong state is refused and the sign-in keeps waiting", async () => {
    const { login } = await chatgpt();
    const r = await land(login.url, { state: "forged" });
    assert.equal(r.status, 400);
    assert.match(r.text, /does not match/);
    assert.equal((await chatgpt()).login.pending, true);
  });

  test("the redirect lands: signed in, account shown, tokens saved 0600, never returned", async () => {
    const { login } = await chatgpt();
    const r = await land(login.url);
    assert.equal(r.status, 200);
    assert.match(r.text, /Signed in as me@example\.com/);
    const p = await chatgpt();
    assert.equal(p.hasKey, true);
    assert.equal(p.login.pending, false);
    assert.deepEqual(p.account, { email: "me@example.com", plan: "plus" });
    assert.equal(p.keySource, "page");
    assert.equal(p.remembered, true);
    assert.deepEqual(p.models, [{ id: "gpt-5.5", label: "GPT-5.5", contextWindow: 400000 }]);
    assert.ok(existsSync(keysFile));
    if (process.platform !== "win32") assert.equal(statSync(keysFile).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(keysFile, "utf8")).chatgpt.oauth;
    assert.match(saved.refreshToken, /^rt-fake-secret-/);
    assert.equal(saved.accountId, ACCOUNT);
    const exchange = fake.of("/oauth/token").at(-1).body;
    assert.equal(exchange.grant_type, "authorization_code");
    assert.equal(exchange.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
    assert.match(exchange.redirect_uri, /^http:\/\/localhost:\d+\/auth\/callback$/);
  });

  test("an ask through the engine on ChatGPT, single mode", async () => {
    const cfg = await api("POST", "/api/config", { provider: "chatgpt", model: "gpt-5.5", mode: "single" });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.provider, "chatgpt");
    const before = fake.of("/responses").length;
    const { turnId } = (await api("POST", "/api/ask", { text: "Explain alpha and beta." })).body;
    await app.engine.idle();
    const s = app.log.state;
    assert.equal(s.nodes[turnId].status, "settled");
    assert.deepEqual(cardsOf(s, turnId).map((c) => [c.title, c.summary]), [["Alpha", "Alpha summary."], ["Beta", "Beta summary."]]);
    const sent = fake.of("/responses").slice(before);
    assert.equal(sent.length, 2, "two rounds");
    const second = sent[1].body.input;
    const calls = second.filter((i) => i.type === "function_call");
    const outputs = second.filter((i) => i.type === "function_call_output");
    assert.equal(calls.length, 2);
    assert.deepEqual(outputs.map((o) => o.call_id), calls.map((c) => c.call_id), "every call answered by its id");
  });

  test("an expired access token is refreshed before use, and the file follows", async () => {
    const before = fake.of("/oauth/token").length;
    const savedBefore = JSON.parse(readFileSync(keysFile, "utf8")).chatgpt.oauth.refreshToken;
    // Make the stored token look nearly expired.
    const file = JSON.parse(readFileSync(keysFile, "utf8"));
    assert.ok(file.chatgpt.oauth.expiresAt > Date.now());
    const r = await api("POST", "/api/providers/chatgpt/models");
    assert.equal(r.status, 200);
    assert.equal(fake.of("/oauth/token").length, before, "a fresh token is not refreshed");
    // Rebuild a registry on the same file with an expired entry: it refreshes on first use.
    file.chatgpt.oauth.expiresAt = Date.now() - 1000;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(keysFile, JSON.stringify(file), { mode: 0o600 });
    const reg2 = createRegistry({ env: {}, keysFile, logger, endpoints: { chatgptAuth: fake.url, chatgpt: fake.url, chatgptCallbackPort: 0, codexPrompt: async () => "X" } });
    assert.equal(reg2.info("chatgpt").hasKey, true, "read back from .keys.json");
    assert.equal(reg2.info("chatgpt").keySource, "file");
    await reg2.refreshModels("chatgpt");
    const refresh = fake.of("/oauth/token").at(-1).body;
    assert.equal(refresh.grant_type, "refresh_token");
    assert.equal(refresh.refresh_token, savedBefore);
    assert.notEqual(JSON.parse(readFileSync(keysFile, "utf8")).chatgpt.oauth.refreshToken, savedBefore, "the rotated token was saved");
    reg2.close();
  });

  test("pasting the address finishes a sign-in; a bad code reports and ends it", async () => {
    let r = await api("POST", "/api/providers/chatgpt/login", {});
    const u = new URL(r.body.provider.login.url);
    fake.challenge = u.searchParams.get("code_challenge");
    r = await api("POST", "/api/providers/chatgpt/login/complete", { url: `http://localhost:1455/auth/callback?code=bad&state=${u.searchParams.get("state")}` });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /ChatGPT sign-in failed \(400\): bad code/);
    assert.equal((await chatgpt()).login.pending, false);
    assert.match((await chatgpt()).login.error, /bad code/);

    r = await api("POST", "/api/providers/chatgpt/login", { remember: false });
    const u2 = new URL(r.body.provider.login.url);
    fake.challenge = u2.searchParams.get("code_challenge");
    assert.equal((await api("POST", "/api/providers/chatgpt/login/complete", { url: "garbage!!" })).status, 400);
    r = await api("POST", "/api/providers/chatgpt/login/complete", { url: `http://localhost:1455/auth/callback?code=good-code&state=${u2.searchParams.get("state")}` });
    assert.equal(r.status, 200);
    assert.equal(r.body.provider.hasKey, true);
    assert.equal(r.body.provider.remembered, false, "remember: false: the old file entry is gone");
    assert.equal(existsSync(keysFile) ? JSON.parse(readFileSync(keysFile, "utf8")).chatgpt : undefined, undefined);
  });

  test("cancel and sign out", async () => {
    let r = await api("POST", "/api/providers/chatgpt/login", {});
    assert.equal(r.body.provider.login.pending, true);
    r = await api("DELETE", "/api/providers/chatgpt/login");
    assert.equal(r.body.provider.login.pending, false);
    r = await api("DELETE", "/api/providers/chatgpt/key");
    assert.equal(r.body.provider.hasKey, false);
    assert.equal(r.body.provider.account, null);
    assert.deepEqual((await api("GET", "/api/config")).body.provider, null);
  });

  test("OpenCode: key, filtered model list, and a chat through its OpenAI-compatible endpoint", async () => {
    let r = await api("POST", "/api/providers/opencode/key", { apiKey: OC_KEY });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.provider.models.map((m) => m.id), ["glm-5.3", "kimi-k3"], "only chat models, and no free ones");
    assert.deepEqual(r.body.provider.models[1], { id: "kimi-k3", label: "Kimi K3", contextWindow: 1048576, maxOutput: 65536 });
    assert.equal(fake.of("/v1/models").at(-1).headers.authorization, `Bearer ${OC_KEY}`);
    r = await api("POST", "/api/config", { provider: "opencode", model: "kimi-k3", mode: "single" });
    assert.equal(r.status, 200);
    const reg = createRegistry({ env: { OPENCODE_API_KEY: OC_KEY }, keysFile: null, logger, endpoints: { opencode: fake.url } });
    assert.equal(reg.info("opencode").keySource, "env");
    reg.activate({ id: "opencode", model: "kimi-k3" });
    const events = await collect(reg.acquire().stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.at(-1).content[0].text, "From OpenCode.");
    const req = fake.of("/chat/completions").at(-1);
    assert.equal(req.body.model, "kimi-k3");
    assert.equal(req.body.thinking, undefined);
    assert.equal(req.headers["user-agent"], "parallel-chat", "OpenCode asks clients to name themselves");
    assert.match(req.headers["x-opencode-session"], /^[0-9a-f-]{36}$/);
    reg.close();
  });

  test("OpenCode Go: its own provider, key and model list, same Console key from the environment", async () => {
    const reg = createRegistry({
      env: { OPENCODE_API_KEY: OC_KEY },
      keysFile: null,
      logger,
      endpoints: { opencodego: fake.url, opencodegoModels: `${fake.url}/v1/models` },
    });
    assert.equal(reg.info("opencodego").keySource, "env");
    assert.equal(reg.info("opencodego").label, "OpenCode Go (subscription)");
    const info = await reg.refreshModels("opencodego");
    assert.deepEqual(info.models.map((m) => m.id), ["glm-5.3", "kimi-k3"]);
    reg.activate({ id: "opencodego", model: "glm-5.3" });
    const events = await collect(reg.acquire().stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.at(-1).content[0].text, "From OpenCode.");
    const first = reg.acquire().stream({ system: "S", messages: [{ role: "user", content: "again" }] });
    await collect(first);
    const sessions = fake.of("/chat/completions").slice(-2).map((r) => r.headers["x-opencode-session"]);
    assert.equal(sessions[0], sessions[1], "one stable session id");
    reg.close();
  });
});
