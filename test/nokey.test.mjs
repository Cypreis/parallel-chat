// With no API key there is no model: the app says so instead of answering.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startServer } from "../server/http.mjs";
import { createRegistry, NO_KEY_MESSAGE } from "../server/providers/registry.mjs";

const quiet = { log() {}, warn() {}, error() {} };

test("without a key: no active provider, and a question fails with the add-a-key message", async () => {
  const registry = createRegistry({ env: {}, keysFile: null, logger: quiet });
  await registry.init();
  const app = await startServer({ port: 0, registry, logger: quiet });
  try {
    const cfg = await fetch(`${app.url}/api/config`).then((r) => r.json());
    assert.equal(cfg.provider, null);
    assert.equal(cfg.model, null);
    const listed = await fetch(`${app.url}/api/providers`).then((r) => r.json());
    assert.deepEqual(listed.providers.map((p) => p.id), ["anthropic", "deepseek", "qwen", "opencode", "chatgpt"]);

    const res = await fetch(`${app.url}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello?" }),
    });
    assert.equal(res.status, 202);
    await app.engine.idle();
    const nodes = Object.values(app.log.state.nodes);
    const q = nodes.find((n) => n.kind === "question");
    assert.equal(q.status, "error");
    assert.equal(q.error, NO_KEY_MESSAGE);
    assert.equal(nodes.filter((n) => n.kind === "card").length, 0, "nothing was made up");
  } finally {
    await app.close();
  }
});
