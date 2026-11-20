// Saved cards: the events, the routes, and what deleting a chat does to them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { startServer } from "../server/http.mjs";
import { cardsOf } from "../shared/project.mjs";
import { createMockProvider } from "./support/mock.mjs";

const quiet = { log() {}, warn() {}, error() {} };

describe("saved cards", () => {
  test("save, move, hide follow-ups, unsave; validation; persisted through the log; chat delete cleans up", async () => {
    const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet });
    const call = async (method, p, body) => {
      const res = await fetch(app.url + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    try {
      const { body: ask } = await call("POST", "/api/ask", { text: "Storage options: alpha, beta, and gamma." });
      await app.engine.idle();
      const cards = cardsOf(app.log.state, ask.turnId);
      assert.ok(cards.length >= 2);
      const [a, b] = cards;

      assert.equal((await call("POST", `/api/cards/${a.id}/save`, {})).status, 400, "saved must be a boolean");
      assert.equal((await call("POST", `/api/cards/${ask.turnId}/save`, { saved: true })).status, 400, "a question is not a card");
      assert.equal((await call("POST", "/api/cards/nope/save", { saved: true })).status, 404);
      assert.equal((await call("PATCH", `/api/saved/${a.id}`, { x: 1, y: 2 })).status, 404, "not saved yet");

      const r = await call("POST", `/api/cards/${a.id}/save`, { saved: true, w: 410.4, h: 233 });
      assert.deepEqual([r.body.saved.w, r.body.saved.h], [410, 233], "the size it had on the board");
      assert.equal(r.status, 200);
      assert.equal(r.body.saved.follow, true, "follow-ups show by default");
      assert.equal(r.body.saved.x, undefined, "no place until moved");
      const seq = app.log.seq;
      await call("POST", `/api/cards/${a.id}/save`, { saved: true });
      assert.equal(app.log.seq, seq, "saving twice writes nothing");
      await call("POST", `/api/cards/${b.id}/save`, { saved: true });
      assert.deepEqual(Object.keys(app.log.state.saved).sort(), [a.id, b.id].sort());

      assert.equal((await call("PATCH", `/api/saved/${a.id}`, { x: "a", y: 2 })).status, 400);
      assert.equal((await call("PATCH", `/api/saved/${a.id}`, {})).status, 400);
      const moved = await call("PATCH", `/api/saved/${a.id}`, { x: 120.4, y: 300 });
      assert.deepEqual([moved.body.saved.x, moved.body.saved.y], [120, 300]);
      const f = await call("PATCH", `/api/saved/${a.id}`, { follow: false });
      assert.equal(f.body.saved.follow, false);
      assert.equal(app.log.state.saved[a.id].x, 120, "the place survives a follow-up toggle");
      const rs = await call("PATCH", `/api/saved/${a.id}`, { w: 500, h: 300 });
      assert.deepEqual([rs.body.saved.w, rs.body.saved.h, rs.body.saved.x], [500, 300, 120], "resized, still placed");
      assert.equal((await call("PATCH", `/api/saved/${a.id}`, { w: 50 })).status, 400, "too small");
      assert.equal((await call("PATCH", `/api/saved/${a.id}`, { h: null })).body.saved.h, undefined, "null: as tall as its text");

      // the log is the persistence: replaying it gives the same saved set
      const { createState, applyEvent } = await import("../shared/project.mjs");
      const replay = createState();
      for (const ev of app.log.since(0)) applyEvent(replay, ev);
      assert.deepEqual(replay.saved, app.log.state.saved);

      assert.equal((await call("POST", `/api/cards/${b.id}/save`, { saved: false })).body.saved, null);
      assert.deepEqual(Object.keys(app.log.state.saved), [a.id]);

      await call("DELETE", `/api/chats/${ask.turnId}`);
      assert.deepEqual(app.log.state.saved, {}, "deleting the chat removes its saved cards");
    } finally {
      await app.close();
    }
  });

  test("folders: make, rename, save into one, move between, remove one (its cards stay, unfiled)", async () => {
    const app = await startServer({ port: 0, provider: createMockProvider({ speed: 1000 }), logger: quiet });
    const call = async (method, p, body) => {
      const res = await fetch(app.url + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    try {
      const { body: ask } = await call("POST", "/api/ask", { text: "Storage options: alpha, beta, and gamma." });
      await app.engine.idle();
      const [a, b, c] = cardsOf(app.log.state, ask.turnId);

      assert.equal((await call("POST", "/api/folders", { name: "   " })).status, 400);
      const f1 = (await call("POST", "/api/folders", { name: "Databases" })).body.folder;
      const f2 = (await call("POST", "/api/folders", { name: "Later" })).body.folder;
      assert.notEqual(f1.id, f2.id);
      assert.equal((await call("PATCH", `/api/folders/${f2.id}`, { name: "Read later" })).body.folder.name, "Read later");
      assert.equal((await call("PATCH", "/api/folders/o_999", { name: "x" })).status, 404);

      assert.equal((await call("POST", `/api/cards/${a.id}/save`, { saved: true, folderId: "o_999" })).status, 404, "unknown folder");
      assert.equal((await call("POST", `/api/cards/${a.id}/save`, { saved: true, folderId: f1.id })).body.saved.folderId, f1.id);
      assert.equal((await call("POST", `/api/cards/${b.id}/save`, { saved: true })).body.saved.folderId, undefined, "no folder: unfiled");
      assert.equal((await call("PATCH", `/api/saved/${b.id}`, { folderId: f2.id })).body.saved.folderId, f2.id, "moved into a folder");
      assert.equal((await call("PATCH", `/api/saved/${b.id}`, { folderId: "o_999" })).status, 404);
      await call("POST", `/api/cards/${c.id}/save`, { saved: true, folderId: f1.id });

      // the log replays to the same folders
      const { createState, applyEvent } = await import("../shared/project.mjs");
      const replay = createState();
      for (const ev of app.log.since(0)) applyEvent(replay, ev);
      assert.deepEqual(replay.folders, app.log.state.folders);
      assert.deepEqual(replay.saved, app.log.state.saved);

      assert.equal((await call("PATCH", `/api/saved/${a.id}`, { folderId: null })).body.saved.folderId, undefined, "taken out of its folder");
      await call("DELETE", `/api/folders/${f1.id}`);
      assert.deepEqual(app.log.state.folders.map((f) => f.id), [f2.id]);
      assert.ok(app.log.state.saved[c.id], "the card is still saved");
      assert.equal(app.log.state.saved[c.id].folderId, undefined, "but unfiled");
      assert.equal(app.log.state.saved[b.id].folderId, f2.id, "other folders untouched");
      assert.equal((await call("DELETE", `/api/folders/${f1.id}`)).status, 404);

      // ids continue after a restart's replay: a new folder never reuses one
      const again = (await call("POST", "/api/folders", { name: "Again" })).body.folder;
      assert.notEqual(again.id, f1.id);
      assert.notEqual(again.id, f2.id);
    } finally {
      await app.close();
    }
  });
});
