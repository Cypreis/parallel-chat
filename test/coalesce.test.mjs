// Streamed text is merged into fewer events without changing what the log says.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createLog } from "../server/log.mjs";

const open = (log, id) => log.append("node.open", { node: { id, kind: "card", parentId: null, turnId: id, role: "assistant", title: "", summary: "", body: "", status: "streaming" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("delta coalescing", () => {
  test("off by default: one event per piece", () => {
    const log = createLog();
    open(log, "a");
    for (const t of ["x", "y", "z"]) log.append("node.delta", { id: "a", field: "body", text: t });
    assert.equal(log.length, 4);
  });

  test("pieces for one node and field become one event; the state is whole when read", () => {
    const log = createLog({ coalesceMs: 1000 });
    const seen = [];
    log.subscribe((e) => seen.push(e));
    open(log, "a");
    for (const t of ["He", "llo", " world"]) log.append("node.delta", { id: "a", field: "body", text: t });
    assert.equal(seen.length, 1, "nothing delivered yet: only the open");
    assert.equal(log.state.nodes.a.body, "Hello world", "reading the state flushes");
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1].text, "Hello world");
    assert.deepEqual(log.since(0).map((e) => e.seq), [1, 2], "seqs stay contiguous");
  });

  test("a timer delivers it without any read", async () => {
    const log = createLog({ coalesceMs: 10 });
    const seen = [];
    log.subscribe((e) => seen.push(e.type));
    open(log, "a");
    log.append("node.delta", { id: "a", field: "body", text: "x" });
    await sleep(40);
    assert.deepEqual(seen, ["node.open", "node.delta"]);
  });

  test("the node's own events come after its text; another node's text can wait", () => {
    const log = createLog({ coalesceMs: 1000 });
    const types = [];
    log.subscribe((e) => types.push(e.type + ":" + (e.id ?? e.node?.id)));
    open(log, "a");
    open(log, "b");
    log.append("node.delta", { id: "a", field: "body", text: "A" });
    log.append("node.delta", { id: "b", field: "body", text: "B" });
    log.append("node.close", { id: "a", status: "settled" });
    assert.deepEqual(types, ["node.open:a", "node.open:b", "node.delta:a", "node.close:a"], "b's text is still held");
    log.append("session.reset");
    assert.equal(types.at(-2), "node.delta:b", "a global event flushes everything first");
    assert.equal(types.at(-1), "session.reset:undefined");
  });

  test("a replay of the delivered events gives the same state as the live one", async () => {
    const { createState, applyEvent } = await import("../shared/project.mjs");
    const log = createLog({ coalesceMs: 5 });
    open(log, "a");
    open(log, "b");
    for (let i = 0; i < 50; i++) {
      log.append("node.delta", { id: i % 2 ? "a" : "b", field: "body", text: String(i) });
      if (i % 7 === 0) await sleep(8);
    }
    log.append("node.close", { id: "a", status: "settled" });
    const replay = createState();
    for (const e of log.since(0)) applyEvent(replay, e);
    assert.deepEqual(replay.nodes, log.state.nodes);
  });
});
