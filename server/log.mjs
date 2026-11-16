// Append-only event log with a projected state folded by the shared reducer.
import { applyEvent, createState } from "../shared/project.mjs";

export function createLog({ now = () => Date.now() } = {}) {
  let events = [];
  let seq = 0;
  const state = createState();
  const subscribers = new Set();

  function append(type, payload = {}) {
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
    get state() {
      return state;
    },
    get seq() {
      return seq;
    },
    get length() {
      return events.length;
    },
  };
}
