// The OpenAI-compatible providers (OpenAI, Gemini, xAI, Mistral, Groq,
// OpenRouter, Together, Hugging Face) and the local-model endpoint, against a
// local fake. Nothing here reaches a real service.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { COMPAT_PROVIDERS } from "../server/providers/openai-compat.mjs";
import { createRegistry } from "../server/providers/registry.mjs";

const quiet = { log() {}, warn() {}, error() {} };
const KEY = "sk-fake-compat-key-0123456789abcdef";

let fake;
let url;
const seen = [];
before(async () => {
  fake = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
    if (req.url === "/gemini/models") return json(res, { data: [{ id: "models/gemini-2.5-flash" }, { id: "models/text-embedding-004" }] });
    if (req.url === "/together/models") return json(res, [{ id: "meta/llama-4", type: "chat", display_name: "Llama 4" }, { id: "flux", type: "image" }]);
    if (req.url === "/groq/models") return json(res, { data: [{ id: "llama-3.3-70b" }, { id: "whisper-large-v3" }, { id: "llama-guard-4" }] });
    if (req.url === "/denied/models") { res.writeHead(401, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: `bad key ${KEY}` } })); }
    if (req.url.endsWith("/models")) return json(res, { data: [{ id: "qwen3:8b" }, { id: "nomic-embed-text" }] });
    if (req.url.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${fake.address().port}`;
});
after(() => new Promise((r) => { fake.closeAllConnections?.(); fake.close(r); }));
const json = (res, body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const collect = async (s) => { const out = []; for await (const e of s) out.push(e); return out; };

describe("OpenAI-compatible providers", () => {
  const reg = (env = {}, endpoints = {}) => createRegistry({ env, keysFile: null, logger: quiet, endpoints });

  test("every one is listed with its label, and takes a key from its own environment variable", () => {
    const r = reg({ OPENAI_API_KEY: "a", GOOGLE_API_KEY: "b", HF_TOKEN: "c", XAI_API_KEY: "d" });
    const list = r.list().providers;
    for (const id of Object.keys(COMPAT_PROVIDERS)) assert.ok(list.some((p) => p.id === id && p.auth === "key"), id);
    assert.equal(r.info("openai").keySource, "env");
    assert.equal(r.info("gemini").keySource, "env");
    assert.equal(r.info("huggingface").keySource, "env");
    assert.equal(r.info("groq").hasKey, false);
    assert.equal(r.info("local").needsBase, true);
  });

  test("model lists: Gemini ids lose models/, Together's bare array and types are read, non-chat models dropped", async () => {
    const r = reg({}, { gemini: url + "/gemini", together: url + "/together", groq: url + "/groq" });
    assert.deepEqual((await r.setKey("gemini", { apiKey: KEY })).models.map((m) => m.id), ["gemini-2.5-flash"]);
    assert.deepEqual((await r.setKey("together", { apiKey: KEY })).models, [{ id: "meta/llama-4", label: "Llama 4" }]);
    assert.deepEqual((await r.setKey("groq", { apiKey: KEY })).models.map((m) => m.id), ["llama-3.3-70b"]);
  });

  test("a rejected key stores nothing and the message never carries the key", async () => {
    const r = reg({}, { xai: url + "/denied" });
    await assert.rejects(r.setKey("xai", { apiKey: KEY }), (err) => /authentication failed/.test(err.message) && !err.message.includes(KEY));
    assert.equal(r.info("xai").hasKey, false);
  });

  test("a chat goes to {base}/chat/completions with the bearer key, and streams text", async () => {
    const r = reg({}, { mistral: url + "/mistral" });
    await r.setKey("mistral", { apiKey: KEY });
    r.activate(r.check("mistral", "mistral-large"));
    const events = await collect(r.acquire().stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.at(-1).content[0].text, "hello");
    const req = seen.filter((s) => s.path === "/mistral/chat/completions").at(-1);
    assert.equal(req.auth, `Bearer ${KEY}`);
    assert.equal(req.body.model, "mistral-large");
  });
});

describe("local model endpoint", () => {
  test("needs no key; the address is checked, its models listed, a chat reaches it", async () => {
    const r = createRegistry({ env: {}, keysFile: null, logger: quiet });
    const info = await r.setKey("local", { baseURL: url + "/v1" }); // no key
    assert.equal(info.hasKey, true);
    assert.equal(info.baseURL, url + "/v1");
    assert.equal(info.keyHint, null);
    assert.deepEqual(info.models.map((m) => m.id), ["qwen3:8b"], "embedding model left out");
    r.activate(r.check("local", "qwen3:8b"));
    const events = await collect(r.acquire().stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(events.at(-1).content[0].text, "hello");
    const req = seen.filter((s) => s.path === "/v1/chat/completions").at(-1);
    assert.equal(req.body.model, "qwen3:8b");
  });

  test("an unreachable address is refused with a pointer to the server; a bad one too; the environment can set it", async () => {
    const r = createRegistry({ env: {}, keysFile: null, logger: quiet });
    await assert.rejects(r.setKey("local", { baseURL: "http://127.0.0.1:9/v1" }), /Is the server running/);
    assert.equal(r.info("local").hasKey, false);
    await assert.rejects(r.setKey("local", { baseURL: "ftp://x.example" }), /baseURL must use https/);
    const e = createRegistry({ env: { LOCAL_LLM_URL: url + "/v1" }, keysFile: null, logger: quiet });
    assert.equal(e.info("local").hasKey, true);
    assert.equal(e.info("local").keySource, "env");
  });

  test("a remote provider refuses a baseURL", async () => {
    const r = createRegistry({ env: {}, keysFile: null, logger: quiet });
    await assert.rejects(r.setKey("openai", { apiKey: KEY, baseURL: "https://evil.example/v1" }), /baseURL is only used/);
  });
});
