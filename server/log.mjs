// Append-only event log with a projected state folded by the shared reducer.
import { applyEvent, createState } from "../shared/project.mjs";

// An event's JSON, made once however many clients, replays and file writes
// need it (the event is not changed after it is logged).
const json = new WeakMap();
export function jsonOf(ev) {
  let s = json.get(ev);
  if (s === undefined) {
    s = JSON.stringify(ev);
    json.set(ev, s);
  }
  return s;
}

// coalesceMs: streamed text (node.delta) is merged per node and field for this
// long before it becomes one event. A model streams a few characters per
// token, many tokens a second, for every card at once: one event per token is
// most of the log, of every client's traffic and of the file. Everything that
// reads the log (state, since, seq, length, restore, redact) flushes the held
// text first, and any other event for the log flushes it before itself, so
// order and contiguous seqs are exactly as if nothing had been held. An event
// about one node (node.* with an id) flushes only that node's held text; any
// other kind of event flushes everything. 0 turns it off.
export function createLog({ now = () => Date.now(), coalesceMs = 0 } = {}) {
  let events = [];
  let seq = 0;
  const state = createState();
  const subscribers = new Set();
  const held = new Map(); // "id|field" -> { id, field, text }: deltas waiting for more text
  let heldTimer = null;

  function flushHeld() {
    if (!held.size) return;
    clearTimeout(heldTimer);
    heldTimer = null;
    const list = [...held.values()];
    held.clear();
    for (const h of list) commit("node.delta", h);
  }

  function append(type, payload = {}) {
    if (type === "node.delta" && coalesceMs > 0 && typeof payload.text === "string") {
      const key = payload.id + "|" + payload.field;
      const h = held.get(key);
      if (h) h.text += payload.text;
      else held.set(key, { id: payload.id, field: payload.field, text: payload.text });
      if (!heldTimer) {
        heldTimer = setTimeout(flushHeld, coalesceMs);
        heldTimer.unref?.();
      }
      return null; // not an event yet
    }
    // Text of other cards, still streaming, can wait: their order against this event is not observable.
    if (held.size && (type === "node.open" || type === "node.patch" || type === "node.close" || type === "edge.add")) {
      const id = payload.id ?? payload.node?.id;
      for (const [key, h] of [...held]) {
        if (type === "edge.add" ? false : h.id !== id) continue;
        held.delete(key);
        commit("node.delta", h);
      }
      if (!held.size) {
        clearTimeout(heldTimer);
        heldTimer = null;
      }
    } else flushHeld();
    return commit(type, payload);
  }

  function commit(type, payload = {}) {
    seq += 1;
    const { seq: _s, ts: _t, type: _ty, ...rest } = payload;
    const event = { seq, ts: now(), type, ...rest };
    if (type === "node.open" && rest.node) event.node = { ...rest.node, seq };
    applyEvent(state, event);
    events.push(event);
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch (err) {
        console.error("[log] subscriber failed:", err);
      }
    }
    return event;
  }

  // Events with seq > after, in order.
  function since(after = 0) {
    flushHeld();
    const n = Number(after) || 0;
    if (events.length === 0 || n < events[0].seq) return events.slice();
    // seqs are contiguous inside the log, so the offset is direct.
    const start = n - events[0].seq + 1;
    return start >= events.length ? [] : events.slice(start);
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // Load stored events (a restart). Subscribers are not told: they already
  // have them. seq continues from the last one.
  function restore(list) {
    flushHeld();
    if (events.length || seq) throw new Error("restore() needs an empty log");
    for (const ev of list) {
      applyEvent(state, ev);
      events.push(ev);
      seq = ev.seq;
    }
  }

  // Drop history and start the log again with session.reset. seq keeps
  // counting so clients that already hold higher seqs still apply the reset.
  function reset() {
    flushHeld();
    events = [];
    return append("session.reset");
  }

  // Erase the content of past events (a deleted chat). refOf(event) returns
  // the id an event carries when it must go, else null; the event keeps its
  // seq and ts and becomes { type: "redacted", ref }, so seqs stay contiguous
  // and ids are never reused. The state is not touched: the caller has
  // already logged the event that removes the content from it. Rewrite
  // listeners get the whole new list (the store rewrites its file).
  const rewriters = new Set();
  function redact(refOf) {
    flushHeld();
    let n = 0;
    events = events.map((ev) => {
      const ref = ev.type === "redacted" ? null : refOf(ev);
      if (ref === null || ref === undefined) return ev;
      n += 1;
      return { seq: ev.seq, ts: ev.ts, type: "redacted", ref };
    });
    if (n) for (const fn of rewriters) fn(events.slice());
    return n;
  }

  function onRewrite(fn) {
    rewriters.add(fn);
    return () => rewriters.delete(fn);
  }

  return {
    append,
    since,
    subscribe,
    reset,
    restore,
    redact,
    onRewrite,
    flush: flushHeld,
    get state() {
      flushHeld();
      return state;
    },
    get seq() {
      flushHeld();
      return seq;
    },
    get length() {
      flushHeld();
      return events.length;
    },
  };
}
