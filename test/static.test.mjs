// Static files: compressed when the client takes it, revalidated with ETag.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import zlib from "node:zlib";
import { startServer } from "../server/http.mjs";
import { createMockProvider } from "./support/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };

test("app.js: brotli, gzip or plain by Accept-Encoding; a matching ETag gets 304; a big state is gzipped", async () => {
  const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet });
  try {
    // raw bytes as sent: fetch would decompress for us
    const get = (p, h = {}) => new Promise((resolve, reject) => {
      http.get(app.url + p, { headers: { "accept-encoding": "identity", ...h } }, (res) => {
        const parts = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => {
          const body = Buffer.concat(parts);
          resolve({ status: res.statusCode, headers: { get: (k) => res.headers[k] ?? null }, arrayBuffer: async () => body, text: async () => body.toString("utf8") });
        });
      }).on("error", reject);
    });
    const plain = await get("/app.js");
    const raw = await plain.arrayBuffer();
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.ok(raw.length > 50_000);
    const etag = plain.headers.get("etag");
    assert.match(etag, /^W\/"/);
    assert.equal(plain.headers.get("cache-control"), "no-cache");

    const br = await get("/app.js", { "accept-encoding": "br" });
    assert.equal(br.headers.get("content-encoding"), "br");
    const brBody = await br.arrayBuffer();
    assert.ok(brBody.length < raw.length / 3, "much smaller");
    assert.deepEqual(zlib.brotliDecompressSync(brBody), raw);

    const gz = await get("/app.js", { "accept-encoding": "gzip" });
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    assert.deepEqual(zlib.gunzipSync(await gz.arrayBuffer()), raw);
    assert.equal(gz.headers.get("vary"), "accept-encoding");

    const again = await get("/app.js", { "if-none-match": etag });
    assert.equal(again.status, 304);
    assert.equal((await again.arrayBuffer()).length, 0);
    assert.equal((await get("/app.js", { "if-none-match": 'W/"other"' })).status, 200);
    assert.equal((await get("/nope.js")).status, 404);
    assert.equal((await get("/../server/http.mjs")).status, 404, "no way out of public/");

    // a state large enough to be gzipped, and plain for a client that does not take gzip
    for (let i = 0; i < 12; i++) await app.engine.ask({ text: "Storage options: alpha, beta, and gamma. #" + i });
    await app.engine.idle();
    const z = await get("/api/state", { "accept-encoding": "gzip" });
    assert.equal(z.headers.get("content-encoding"), "gzip");
    const state = JSON.parse(zlib.gunzipSync(await z.arrayBuffer()));
    assert.equal(state.seq, app.log.seq);
    const p = await get("/api/state");
    assert.equal(p.headers.get("content-encoding"), null);
    assert.equal(JSON.parse(await p.text()).seq, state.seq);
  } finally {
    await app.close();
  }
});
