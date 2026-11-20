// The concurrency cap and the retries.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import { createLimiter, limitProvider, retryDelay, withRetry } from "../server/providers/flow.mjs";
import { createOpenAICompatProvider } from "../server/providers/openai-compat.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = async (s) => { const out = []; for await (const e of s) out.push(e); return out; };

describe("limiter", () => {
  test("never more than max at once, the rest in order, peak recorded", async () => {
    const lim = createLimiter(3);
    let live = 0, peak = 0;
    const order = [];
    const task = async (i) => {
      const release = await lim.acquire();
      order.push(i);
      live++; peak = Math.max(peak, live);
      await sleep(10);
      live--; release();
    };
    await Promise.all(Array.from({ length: 10 }, (_, i) => task(i)));
    assert.equal(peak, 3);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "first come, first served");
    assert.equal(lim.active, 0);
    assert.equal(lim.stats.peak, 3);
  });

  test("a waiter that is aborted leaves the queue; release is idempotent; 0 means no limit", async () => {
    const lim = createLimiter(1);
    const r1 = await lim.acquire();
    const ctl = new AbortController();
    const waiting = lim.acquire(ctl.signal);
    assert.equal(lim.queued, 1);
    ctl.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    assert.equal(lim.queued, 0);
    await assert.rejects(lim.acquire(ctl.signal), { name: "AbortError" }, "already aborted");
    r1(); r1();
    assert.equal(lim.active, 0, "releasing twice frees one slot");
    const open = createLimiter(0);
    await Promise.all(Array.from({ length: 50 }, () => open.acquire()));
    assert.equal(open.active, 50);
  });

  test("limitProvider holds a slot for the whole stream and frees it when the stream ends or is abandoned", async () => {
    const lim = createLimiter(1);
    const inner = { name: "x", model: "m", async *stream() { yield { type: "text", text: "a" }; await sleep(5); yield { type: "stop" }; } };
    const p = limitProvider(inner, lim);
    assert.equal(p.name, "x");
    await Promise.all([collect(p.stream()), collect(p.stream()), collect(p.stream())]);
    assert.equal(lim.active, 0);
    const it = p.stream()[Symbol.asyncIterator]();
    await it.next();
    assert.equal(lim.active, 1);
    await it.return();
    assert.equal(lim.active, 0, "abandoned early: released");
  });
});

describe("retry", () => {
  const res = (status, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k] ?? null }, body: { cancel: async () => {} } });

  test("which failures are worth another try", () => {
    assert.ok(retryDelay(res(503), 0) > 0);
    assert.equal(retryDelay(res(429), 0), null, "a plain 429 is a usage limit");
    assert.equal(retryDelay(res(429, { "retry-after": "2" }), 0), 2000);
    assert.equal(retryDelay(res(429, { "retry-after": "600" }), 0), null, "too long to wait here");
    assert.equal(retryDelay(res(400), 0), null);
    assert.equal(retryDelay(res(401), 0), null);
    assert.ok(retryDelay(res(500), 2) > retryDelay(res(500), 0) - 200, "backs off");
  });

  test("retries up to the limit, returns the last response, waits between, stops on abort", async () => {
    let calls = 0;
    const waits = [];
    const out = await withRetry(async () => (++calls < 3 ? res(502) : res(200)), { retries: 2, wait: async (ms) => waits.push(ms) });
    assert.equal(out.status, 200);
    assert.equal(calls, 3);
    assert.equal(waits.length, 2);
    calls = 0;
    assert.equal((await withRetry(async () => (calls++, res(503)), { retries: 1, wait: async () => {} })).status, 503);
    assert.equal(calls, 2);
    calls = 0;
    assert.equal((await withRetry(async () => (calls++, res(400)), { retries: 5 })).status, 400);
    assert.equal(calls, 1, "not retried");
    calls = 0;
    assert.equal((await withRetry(async () => (calls++, res(503)), { retries: 0 })).status, 503);
    assert.equal(calls, 1, "off by default");
    const ctl = new AbortController();
    const p = withRetry(async () => res(503, { "retry-after": "5" }), { retries: 3, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 20);
    await assert.rejects(p, { name: "AbortError" });
  });

  describe("through the provider", () => {
    let server, url, hits;
    before(async () => {
      hits = 0;
      server = http.createServer((req, res) => {
        hits++;
        if (hits <= 2) { res.writeHead(503, { "retry-after": "0" }); return res.end("busy"); }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

    test("an overloaded service is retried and the answer comes through; without retries it fails", async () => {
      const mk = (retries) => createOpenAICompatProvider({ id: "deepseek", label: "DeepSeek", baseURL: url, apiKey: "sk-test-0123456789ab", model: "m", retries });
      await assert.rejects(collect(mk(0).stream({ system: "S", messages: [{ role: "user", content: "hi" }] })), /DeepSeek API error 503/);
      assert.equal(hits, 1);
      hits = 0;
      const events = await collect(mk(2).stream({ system: "S", messages: [{ role: "user", content: "hi" }] }));
      assert.equal(events.at(-1).content[0].text, "ok");
      assert.equal(hits, 3);
    });
  });
});
