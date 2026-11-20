// The thinking level setting reaches the providers, and LaTeX in card bodies
// renders through KaTeX instead of leaking into the Markdown.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { startServer } from "../server/http.mjs";
import { createChatGPTProvider } from "../server/providers/chatgpt.mjs";
import { renderMarkdown } from "../public/lib.mjs";

const quiet = { log() {}, warn() {}, error() {} };

describe("thinking level", () => {
  test("POST /api/config validates it, and every generation gets it", async () => {
    const seen = [];
    const recorder = {
      name: "recorder",
      model: "rec-1",
      // eslint-disable-next-line require-yield
      async *stream(args) {
        seen.push(args.thinking);
        yield { type: "stop", reason: "end_turn", content: [{ type: "text", text: "ok" }] };
      },
    };
    const app = await startServer({ port: 0, provider: recorder, logger: quiet });
    const post = (p, body) => fetch(app.url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      assert.equal((await fetch(app.url + "/api/config").then((r) => r.json())).thinking, "auto");
      assert.equal((await post("/api/config", { thinking: "extreme" })).status, 400);
      const r = await post("/api/config", { thinking: "high" });
      assert.equal((await r.json()).thinking, "high");
      await post("/api/ask", { text: "Hello?" });
      await app.engine.idle();
      assert.ok(seen.length >= 1);
      assert.ok(seen.every((t) => t === "high"), `every call got high: ${seen}`);
    } finally {
      await app.close();
    }
  });

  describe("ChatGPT maps it to reasoning.effort", () => {
    let server;
    let url;
    const bodies = [];
    before(async () => {
      server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const c of req) raw += c;
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((r) => server.close(r)));

    for (const [level, effort] of [["auto", "medium"], ["low", "low"], ["high", "high"], ["max", "high"]]) {
      test(`${level} -> ${effort}`, async () => {
        const cred = { accessToken: "a.b.c", accountId: "acct" };
        const p = createChatGPTProvider({ model: "gpt-5.5", baseURL: url, getCredential: async () => cred, refresh: async () => cred });
        for await (const _ of p.stream({ system: "S", messages: [{ role: "user", content: "hi" }], thinking: level })) void _;
        assert.equal(bodies.at(-1).reasoning.effort, effort);
      });
    }
  });
});

describe("math in Markdown", () => {
  before(async () => {
    globalThis.katex = (await import("katex")).default;
  });
  after(() => {
    delete globalThis.katex;
  });

  const katexCount = (html) => (html.match(/class="katex"/g) || []).length;

  test("inline $…$ renders, and its _ and * stay out of the emphasis pass", () => {
    const html = renderMarkdown("Energy $E = mc^2$ and $x_1 * y_2$ with _italic_.");
    assert.equal(katexCount(html), 2);
    assert.equal((html.match(/<em>/g) || []).length, 1, "only the real italic");
  });

  test("prices stay text; \\$ is a dollar sign", () => {
    const html = renderMarkdown("Costs $5 and $10, or \\$20.");
    assert.equal(katexCount(html), 0);
    assert.match(html, /Costs \$5 and \$10, or \$20\./);
  });

  test("display math on its own lines, on one line, and in \\[ \\]", () => {
    assert.equal(katexCount(renderMarkdown("Area:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac13\n$$\n\nDone.")), 1);
    assert.equal(katexCount(renderMarkdown("$$a^2+b^2=c^2$$")), 1);
    assert.equal(katexCount(renderMarkdown("So \\(\\alpha\\) and \\[\\beta\\].")), 2);
    assert.equal(katexCount(renderMarkdown("```math\n\\frac{a}{b}\n```")), 1);
  });

  test("a formula still streaming shows as quiet source, not stray text", () => {
    const html = renderMarkdown("$$\n\\sum_{i=1}^n i");
    assert.match(html, /math-block pending/);
    assert.equal(katexCount(html), 0);
    assert.match(renderMarkdown("Total $$\\sum_i"), /math-src pending/);
  });

  test("math in code stays code; math in tables renders", () => {
    assert.equal(katexCount(renderMarkdown("`$x$` but $y$")), 1);
    assert.equal(katexCount(renderMarkdown("| a | b |\n|---|---|\n| $x^2$ | $\\sqrt{2}$ |")), 2);
  });

  test("without KaTeX loaded, the source shows escaped", () => {
    const k = globalThis.katex;
    delete globalThis.katex;
    try {
      const html = renderMarkdown("$a<b$");
      assert.match(html, /<code class="math-src">a&lt;b<\/code>/);
    } finally {
      globalThis.katex = k;
    }
  });
});
