// Generation engine: turns HTTP intents into log events and model calls.
//
// The model builds the board with tools (server/tools.mjs). The engine owns
// the loop: it reads one provider event stream per model call, turns
// create_card input into card events while it streams, executes the calls
// once the stop reason is known, sends every result for one assistant message
// back in a single user message, and calls again until the model stops (with
// a cap on rounds). The assistant content is appended exactly as the provider
// returned it, thinking blocks included: edited history is rejected.
//
// Every streaming node is owned by a job with its own AbortController. A
// question's job owns the cards it is generating, so cancelling a question
// cancels them. Only the current owner of a node may write to it, which keeps
// cancel, refresh-while-streaming and reset race-free.

import { cardOf, cardsOf, chatNodeIds, chatOf, edgesOf } from "../shared/project.mjs";
import {
  decisionsIn,
  buildAskContext,
  buildBranchContext,
  buildFollowupContext,
  buildCardContext,
  buildContext,
  buildRefreshContext,
  buildSynthesisContext,
  chatNumber,
  describeContext,
  existingCards,
  LENGTHS,
  withLength,
} from "./context.mjs";
import { createFieldStreamer } from "./fields.mjs";
import { CREATE_CARD, LINK_CARDS, PLAN_CARD, RELS, WRITE_BRANCH_CARD, WRITE_CARD, validateInput } from "./tools.mjs";

export { RELS, LENGTHS };
// How hard the model thinks, where the provider lets us say so (Anthropic:
// output_config.effort; ChatGPT: reasoning.effort). "auto" keeps the
// provider's own default. Other providers ignore it.
export const THINKING = ["auto", "low", "medium", "high", "max"];
export const SHAPES = ["single", "parallel", "comparison", "steps"];
export const MODES = ["single", "fanout"];
export const MAX_CARDS = 10; // highest allowed maxCards
export const DEFAULT_MAX_CARDS = 6;
const MAX_ROUNDS = { answer: 8, reply: 4, write: 3 };
export const MAX_DOCS = 10; // files per request
export const MAX_DOC_CHARS = 2_000_000; // text of one file (the model is sent at most DOC_CHARS of it)

// A short card title from what the user typed (text-only branch answers).
export function titleFromText(text) {
  let t = oneLineText(text).replace(/[?.!:;,]+$/, "");
  t = t.replace(/^(and|also|so|but|then|ok|okay|hmm)[,\s]+/i, "");
  t = t.split(" ").filter(Boolean).slice(0, 6).join(" ");
  if (t.length > 48) t = t.slice(0, 47).trimEnd() + "…";
  return t ? t[0].toUpperCase() + t.slice(1) : "Follow-up";
}

function oneLineText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

const PARSE_RETRIES = 2;
const SYMMETRIC = new Set(["contradicts", "alternative_to"]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const messageOf = (err) => (err && err.message) || String(err || "unknown error");
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Every other card joined by an edge to the source node's card.
export function computeAffects(state, sourceNodeId) {
  const card = sourceNodeId ? cardOf(state, sourceNodeId) : null;
  if (!card) return [];
  const ids = new Set();
  for (const e of edgesOf(state, card.id)) {
    const other = e.from === card.id ? e.to : e.from;
    if (other !== card.id && state.nodes[other]?.kind === "card") ids.add(other);
  }
  return state.order.filter((id) => ids.has(id));
}

// Tools carry no shape, so it is read off the finished chat: one card is
// single, an alternative_to link makes it a comparison, a chain of
// depends_on links makes it steps.
export function inferShape(state, questionId) {
  const cards = cardsOf(state, questionId).filter((c) => c.status !== "error");
  if (cards.length <= 1) return "single";
  const ids = new Set(cards.map((c) => c.id));
  const rels = state.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => e.rel);
  if (rels.includes("alternative_to")) return "comparison";
  if (rels.length && rels.every((r) => r === "depends_on")) return "steps";
  return "parallel";
}

function requireText(value, name = "text") {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${name} is required`);
  return value.trim();
}

function optionalText(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${name} must be a string`);
  return value.trim() || undefined;
}

function idList(value, name) {
  if (!Array.isArray(value) || !value.length || !value.every((v) => typeof v === "string")) {
    throw new HttpError(400, `${name} must be a non-empty array of ids`);
  }
  return [...new Set(value)];
}

const ok = (call, value) => ({ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(value) });
const fail = (call, message) => ({ type: "tool_result", tool_use_id: call.id, content: message, is_error: true });

// Strict parse of the accumulated input, then schema validation. On failure
// sets call.error to what the model is told.
function parseInput(call, tool) {
  let input;
  try {
    input = JSON.parse(call.json.trim() || "{}");
  } catch {
    call.error = JSON.stringify({ INVALID_JSON: call.json });
    return null;
  }
  const problem = validateInput(tool, input);
  if (problem) {
    call.error = `Invalid ${call.name} input: ${problem}. Nothing was done; call it again with valid input.`;
    return null;
  }
  call.input = input;
  return input;
}

// provider: a fixed provider (tests); registry: the runtime-switchable one
// (server/providers/registry.mjs). With a registry, each generation takes the
// provider active when it starts and keeps it for every round.
export function createEngine({ log, provider, registry = null, mode = "fanout", maxCards = DEFAULT_MAX_CARDS, length = "auto", thinking = "auto", logger = console }) {
  const acquire = registry ? () => registry.acquire() : () => provider;
  // The planning model, when one is set and its provider still has a key.
  const acquirePlanner = () => {
    const p = config.planner;
    const bound = p && registry ? registry.acquireWith(p.provider, p.model) : null;
    return bound ? { provider: bound, thinking: p.thinking } : null;
  };
  const config = {
    mode: MODES.includes(mode) ? mode : "fanout",
    maxCards: Number.isInteger(maxCards) && maxCards >= 1 && maxCards <= MAX_CARDS ? maxCards : DEFAULT_MAX_CARDS,
    length: LENGTHS.includes(length) ? length : "auto",
    thinking: THINKING.includes(thinking) ? thinking : "auto",
    planner: null, // { provider, model, thinking }: a cheaper model that plans fan-out answers
  };
  const counters = { n: 0, e: 0, d: 0, g: 0, f: 0, o: 0 }; // o: saved-card folders
  // A restored log: new ids continue after every id it holds (redacted events keep theirs in ref).
  for (const ev of log.since(0)) {
    for (const id of [ev.node?.id, ev.edge?.id, ev.decision?.id, ev.group?.id, ev.doc?.id, ev.folder?.id, ev.ref]) {
      const m = /^([nedgfo])_(\d+)$/.exec(id ?? "");
      if (m) counters[m[1]] = Math.max(counters[m[1]], Number(m[2]));
    }
  }
  const newId = (prefix) => `${prefix}_${++counters[prefix]}`;
  const jobs = new Map(); // nodeId -> job
  const running = new Set(); // promises, for idle()

  // ---------- jobs ----------

  function startJob(nodeId, parent = null) {
    const prev = jobs.get(nodeId);
    if (prev) {
      detach(prev);
      prev.controller.abort();
    }
    const controller = new AbortController();
    const job = { nodeId, controller, signal: controller.signal, parent, children: new Set() };
    if (parent) {
      parent.children.add(job);
      if (parent.signal.aborted) controller.abort();
      else parent.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    jobs.set(nodeId, job);
    return job;
  }

  function detach(job) {
    if (jobs.get(job.nodeId) === job) jobs.delete(job.nodeId);
    job.parent?.children.delete(job);
  }

  const live = (job) => !!job && jobs.get(job.nodeId) === job && !job.signal.aborted;

  function finish(job, status, error) {
    if (!job || jobs.get(job.nodeId) !== job) return false;
    detach(job);
    const node = log.state.nodes[job.nodeId];
    if (node && node.status === "streaming") {
      log.append("node.close", error ? { id: job.nodeId, status, error } : { id: job.nodeId, status });
    }
    return true;
  }

  function cancelJob(job) {
    for (const child of [...job.children]) cancelJob(child);
    finish(job, "cancelled");
    job.controller.abort();
  }

  function failTree(job, message) {
    for (const child of [...job.children]) failTree(child, message);
    finish(job, "error", message);
    job.controller.abort();
  }

  function delta(job, field, text) {
    if (text && live(job)) log.append("node.delta", { id: job.nodeId, field, text });
  }

  // Bring a card in line with its validated input (normally a no-op: the
  // streamed text already equals it).
  function reconcile(job, id, fields) {
    if (!live(job)) return;
    const node = log.state.nodes[id];
    const patch = {};
    for (const [k, v] of Object.entries(fields)) if (node[k] !== v) patch[k] = v;
    if (Object.keys(patch).length) log.append("node.patch", { id, patch });
  }

  function track(promise) {
    const p = promise
      .catch((err) => logger.error?.("[engine] unexpected failure:", err))
      .finally(() => running.delete(p));
    running.add(p);
    return p;
  }

  // ---------- nodes and edges ----------

  function openNode(fields) {
    const node = {
      id: fields.id ?? newId("n"),
      kind: fields.kind,
      parentId: fields.parentId ?? null,
      turnId: fields.turnId,
      role: fields.role,
      title: fields.title ?? "",
      summary: "",
      body: fields.body ?? "",
      status: fields.status,
    };
    if (fields.kind === "question") node.turnId = node.id;
    for (const k of ["shape", "mode", "quote", "chatId", "origin", "pending"]) if (fields[k] !== undefined) node[k] = fields[k];
    log.append("node.open", { node });
    return node.id;
  }

  function openCard(questionId, title) {
    return openNode({ kind: "card", parentId: questionId, turnId: questionId, role: "assistant", title, status: "streaming" });
  }

  function duplicateEdge(from, to, rel) {
    return log.state.edges.some(
      (e) => e.rel === rel && ((e.from === from && e.to === to) || (SYMMETRIC.has(rel) && e.from === to && e.to === from)),
    );
  }

  function addEdge(from, to, rel) {
    const edge = { id: newId("e"), from, to, rel };
    log.append("edge.add", { edge });
    return edge;
  }

  function resolveCard(id) {
    if (!log.state.nodes[id]) throw new HttpError(404, `unknown node ${id}`);
    const card = cardOf(log.state, id);
    if (!card) throw new HttpError(400, `${id} is not a card`);
    return card;
  }

  function strictCard(id) {
    const node = log.state.nodes[id];
    if (!node) throw new HttpError(404, `unknown node ${id}`);
    if (node.kind !== "card") throw new HttpError(400, `${id} is not a card`);
    return node;
  }

  // A link_cards end: a key from this answer, or the id of any existing card.
  function resolveRef(ref, keys) {
    const r = String(ref).trim();
    if (keys.has(r)) return keys.get(r);
    return log.state.nodes[r]?.kind === "card" ? r : null;
  }

  function linkCall(call, keys) {
    const input = parseInput(call, LINK_CARDS);
    if (!input) return fail(call, call.error);
    const from = resolveRef(input.from, keys);
    const to = resolveRef(input.to, keys);
    const unknown = !from ? input.from : !to ? input.to : null;
    if (unknown !== null) {
      return fail(call, `Unknown card "${unknown}". Use a key from this answer or the id of an existing card from <board>.`);
    }
    if (from === to) return fail(call, "A card cannot be linked to itself.");
    if (duplicateEdge(from, to, input.rel)) return fail(call, `Those cards are already linked with ${input.rel}.`);
    return ok(call, { id: addEdge(from, to, input.rel).id });
  }

  // ---------- the model loop ----------

  // hooks: text(text, round), toolStart(call), toolDelta(call, json),
  // toolEnd(call), execute(call) -> tool_result, afterRound(calls),
  // finished() -> stop after this round, abandon(calls, message, { retry }).
  async function converse(provider, job, ctx, tools, meta, hooks, maxRounds, { thinking = config.thinking } = {}) {
    const messages = [...ctx.messages];
    let retries = 0;
    for (let round = 1; round <= maxRounds; round++) {
      const calls = [];
      const byId = new Map();
      let stop = null;
      try {
        const stream = provider.stream({
          system: ctx.system,
          cacheSystem: !!ctx.cacheSystem,
          messages: [...messages],
          tools,
          thinking,
          signal: job.signal,
          meta: { ...meta, round },
        });
        for await (const ev of stream) {
          if (!live(job)) return null;
          if (ev.type === "text") hooks.text?.(ev.text, round);
          else if (ev.type === "tool_start") {
            const call = { id: ev.id, name: ev.name, json: "", ended: false };
            calls.push(call);
            byId.set(ev.id, call);
            hooks.toolStart?.(call);
          } else if (ev.type === "tool_delta") {
            const call = byId.get(ev.id);
            if (call && !call.ended) {
              call.json += ev.json;
              hooks.toolDelta?.(call, ev.json);
            }
          } else if (ev.type === "tool_end") {
            const call = byId.get(ev.id);
            if (call && !call.ended) {
              call.ended = true;
              hooks.toolEnd?.(call);
            }
          } else if (ev.type === "stop") stop = ev;
        }
      } catch (err) {
        if (!live(job)) return null;
        if (err?.retryRound && retries < PARSE_RETRIES) {
          retries += 1;
          logger.warn?.(`[engine] ${meta.purpose}: ${messageOf(err)}; re-issuing the round`);
          hooks.abandon?.(calls, messageOf(err), { retry: true });
          round -= 1;
          continue;
        }
        hooks.abandon?.(calls, messageOf(err), { retry: false });
        throw err;
      }
      if (!live(job)) return null;
      if (!stop) throw new Error("The model stream ended without a stop reason.");
      // Checked before any tool runs: a refusal or max_tokens can cut a call off.
      if (stop.reason === "refusal" || stop.reason === "max_tokens") {
        const message =
          stop.reason === "refusal"
            ? stop.message || "The model declined this request."
            : "The model reached max_tokens before it finished.";
        hooks.abandon?.(calls, message, { retry: false });
        throw new Error(message);
      }
      hooks.messageEnd?.(stop, round);
      for (const call of calls) {
        if (!call.ended) {
          call.ended = true;
          hooks.toolEnd?.(call);
        }
      }
      if (!calls.length) return { reason: stop.reason, rounds: round };
      const results = calls.map((call) => hooks.execute(call));
      hooks.afterRound?.(calls);
      if (!live(job)) return null;
      if (hooks.finished?.()) return { reason: "finished", rounds: round };
      messages.push({ role: "assistant", content: stop.content });
      messages.push({ role: "user", content: results });
    }
    logger.warn?.(`[engine] ${meta.purpose}: stopped after ${maxRounds} rounds`);
    return { reason: "max_rounds", rounds: maxRounds };
  }

  // ---------- a new question ----------

  function answerHooks(qjob, { fanout, maxCards, question, provider, length }) {
    const qid = qjob.nodeId;
    const tool = fanout ? PLAN_CARD : CREATE_CARD;
    const keys = new Map(); // key -> card id, for this answer
    const intents = {};
    const writers = [];
    const pendingWriters = [];
    let created = 0;
    let text = "";
    let textRound = 0;

    function open(call, title) {
      const t = oneLine(title);
      if (!t || call.cardId) return;
      call.cardId = openCard(qid, t);
      call.job = startJob(call.cardId, qjob);
      for (const f of ["summary", "body"]) {
        if (call.pending?.[f]) {
          delta(call.job, f, call.pending[f]);
          call.pending[f] = "";
        }
      }
    }

    return {
      writers,
      get created() {
        return created;
      },
      get answerText() {
        return text;
      },

      text(t, round) {
        if (round !== textRound && text) text += "\n\n";
        textRound = round;
        text += t;
      },

      toolStart(call) {
        if (call.name !== "create_card") return;
        if (created >= maxCards) {
          call.rejected = true;
          return;
        }
        created += 1;
        call.counted = true;
        call.pending = { summary: "", body: "" };
        call.streamer = createFieldStreamer({ fields: ["key", "title"], stream: fanout ? [] : ["summary", "body"] });
      },

      toolDelta(call, json) {
        if (!call.streamer) return;
        for (const ev of call.streamer.push(json)) {
          if (ev.type === "value" && ev.field === "title") open(call, ev.value);
          else if (ev.type === "delta") {
            if (call.job) delta(call.job, ev.field, ev.text);
            else call.pending[ev.field] += ev.text;
          }
        }
      },

      toolEnd(call) {
        if (call.name !== "create_card" || call.rejected) return;
        const input = parseInput(call, tool);
        if (input) {
          const key = input.key.trim();
          if (!key) call.error = "Invalid create_card input: key must not be empty.";
          else if (keys.has(key)) call.error = `The key "${key}" is already used in this answer; choose another.`;
          else if (!oneLine(input.title)) call.error = "Invalid create_card input: title must not be empty.";
        }
        if (call.error) {
          created -= 1;
          call.counted = false;
          if (call.job) finish(call.job, "error", call.error);
          return;
        }
        open(call, input.title);
        keys.set(input.key.trim(), call.cardId);
        if (fanout) {
          intents[call.cardId] = input.intent;
          return; // its writer fills it
        }
        reconcile(call.job, call.cardId, { title: oneLine(input.title), summary: input.summary, body: input.body });
        finish(call.job, "settled");
      },

      execute(call) {
        if (call.name === "create_card") {
          if (call.rejected) {
            return fail(
              call,
              `Card limit reached: this answer may create at most ${maxCards} card${maxCards === 1 ? "" : "s"}, so this card was not created.`,
            );
          }
          if (call.error) return fail(call, call.error);
          if (fanout) pendingWriters.push(call);
          return ok(call, { id: call.cardId });
        }
        if (call.name === "link_cards") return linkCall(call, keys);
        return fail(call, `Unknown tool "${call.name}".`);
      },

      // Writers planned in one round start together, after its links, so
      // they share one outline and one cached prefix.
      afterRound() {
        const batch = pendingWriters.splice(0).filter((call) => live(call.job));
        const prepared = batch.map((call) => {
          const ctx = withLength(buildCardContext(log.state, call.cardId, { intents }), length);
          const meta = {
            purpose: "card",
            question,
            title: log.state.nodes[call.cardId].title,
            intent: intents[call.cardId],
            sections: ctx.sections,
          };
          return { job: call.job, ctx, meta };
        });
        for (const { job, ctx, meta } of prepared) writers.push(runWriter(provider, job, ctx, meta));
      },

      abandon(calls, message, { retry }) {
        for (const call of calls) {
          if (call.job) finish(call.job, "error", message);
          if (!retry) continue;
          // The round is re-issued: forget what it created so the retry can
          // reuse its keys and stay within the card limit.
          if (call.counted) created -= 1;
          call.counted = false;
          for (const [k, id] of keys) if (id === call.cardId) keys.delete(k);
          const node = call.cardId && log.state.nodes[call.cardId];
          if (node && node.status === "settled") log.append("node.close", { id: node.id, status: "error", error: message });
        }
      },
    };
  }

  // planner: the provider that plans a fan-out answer (the planning model
  // setting), else the writer's. In single mode one call writes every card,
  // so the writer's provider does it all.
  async function runAnswer(qjob, question, { mode, maxCards, provider, planner = null, length }) {
    const qid = qjob.nodeId;
    const fanout = mode === "fanout";
    const ctx = withLength(buildAskContext(log.state, qid, { maxCards, mode }), length);
    const hooks = answerHooks(qjob, { fanout, maxCards, question, provider, length });
    const meta = {
      purpose: fanout ? "plan" : "turn",
      question,
      turnId: qid,
      chat: chatNumber(log.state, qid),
      maxCards,
      existing: existingCards(log.state),
      sections: ctx.sections,
    };
    try {
      const planning = fanout && planner;
      if (planning) meta.planner = { provider: planner.provider.name, model: planner.provider.model };
      await converse(planning ? planner.provider : provider, qjob, ctx, fanout ? [PLAN_CARD, LINK_CARDS] : [CREATE_CARD, LINK_CARDS], meta, hooks, MAX_ROUNDS.answer, planning ? { thinking: planner.thinking } : {});
      if (!live(qjob)) return;
      if (!hooks.created) {
        // The model answered without cards: its text becomes one card.
        const answer = hooks.answerText.trim();
        if (!answer) {
          finish(qjob, "error", "The model returned no cards and no text.");
          return;
        }
        const id = openCard(qid, "Answer");
        log.append("node.delta", { id, field: "body", text: answer });
        log.append("node.close", { id, status: "settled" });
      }
      log.append("node.patch", { id: qid, patch: { shape: inferShape(log.state, qid) } });
      await Promise.all(hooks.writers);
      if (!live(qjob)) return;
      for (const child of [...qjob.children]) finish(child, "error", "The card was never finished.");
      finish(qjob, "settled");
    } catch (err) {
      if (!live(qjob)) return;
      logger.warn?.(`[engine] answer failed: ${messageOf(err)}`);
      failTree(qjob, messageOf(err));
    }
  }

  // ---------- one card: fan-out writer, refresh, synthesis ----------

  async function runWriter(provider, job, ctx, meta) {
    let wrote = false;
    let text = "";
    let active = null;
    const hooks = {
      text(t) {
        text += t;
      },
      toolStart(call) {
        if (call.name !== "write_card" || wrote || active) return;
        active = call;
        call.streamer = createFieldStreamer({ stream: ["summary", "body"] });
      },
      toolDelta(call, json) {
        if (call !== active) return;
        for (const ev of call.streamer.push(json)) if (ev.type === "delta") delta(job, ev.field, ev.text);
      },
      toolEnd(call) {
        if (call !== active) return;
        active = null;
        const input = parseInput(call, WRITE_CARD);
        if (!input) {
          if (live(job)) log.append("node.reset", { id: job.nodeId }); // clear the rejected attempt
          return;
        }
        reconcile(job, job.nodeId, { summary: input.summary, body: input.body });
        call.accepted = true;
        wrote = true;
      },
      execute(call) {
        if (call.name !== "write_card") return fail(call, `Unknown tool "${call.name}".`);
        if (call.accepted) return ok(call, { id: job.nodeId });
        return fail(call, call.error ?? "Only the first write_card call is used.");
      },
      finished: () => wrote,
    };
    try {
      // A card is a short, planned piece of text: unless the person chose a thinking level, a writer thinks little
      // (the planner and the replies keep the provider's default). Fewer reasoning tokens on every card of every answer.
      await converse(provider, job, ctx, [WRITE_CARD], meta, hooks, MAX_ROUNDS.write, { thinking: config.thinking === "auto" ? "low" : config.thinking });
      if (!live(job)) return;
      if (!wrote) {
        const body = text.trim();
        if (!body) {
          finish(job, "error", "The writer returned nothing.");
          return;
        }
        delta(job, "body", body);
      }
      finish(job, "settled");
    } catch (err) {
      if (live(job)) {
        logger.warn?.(`[engine] ${meta.purpose} failed: ${messageOf(err)}`);
        finish(job, "error", messageOf(err));
      }
    }
  }

  // ---------- writers shared by replies, branches and follow-ups ----------

  // Plain text into a thread message. Text after a tool round continues in the
  // same message node, after a blank line.
  function threadWriter(job) {
    let round = 0;
    let begun = false;
    let wrote = false;
    return {
      text(t, r) {
        if (r !== round) {
          round = r;
          begun = false;
        }
        if (!begun) {
          t = t.replace(/^\s+/, "");
          if (!t) return;
          begun = true;
          if (wrote) t = "\n\n" + t;
        }
        wrote = true;
        delta(job, "body", t);
      },
    };
  }

  // One titled card from write_card, into a card node that is already open
  // (title ""). The title is patched in as soon as it streams; deltas that
  // stream before it are held so the title patch comes first.
  function branchWriter(job, meta) {
    const id = job.nodeId;
    let wrote = false;
    let text = "";
    let active = null;
    let titled = !!log.state.nodes[id].title; // a refresh keeps its title until a new one streams
    let held = [];
    const setTitle = (title) => {
      const t = oneLineText(title);
      if (!t || !live(job)) return;
      if (log.state.nodes[id].title !== t) log.append("node.patch", { id, patch: { title: t } });
      titled = true;
      for (const [field, chunk] of held.splice(0)) delta(job, field, chunk);
    };
    const streamDelta = (field, chunk) => {
      if (titled) delta(job, field, chunk);
      else held.push([field, chunk]);
    };
    return {
      text(t) {
        text += t;
      },
      toolStart(call) {
        if (call.name !== "write_card" || wrote || active) return;
        active = call;
        call.streamer = createFieldStreamer({ fields: ["title"], stream: ["summary", "body"] });
      },
      toolDelta(call, json) {
        if (call !== active) return;
        for (const ev of call.streamer.push(json)) {
          if (ev.type === "value" && ev.field === "title") setTitle(ev.value);
          else if (ev.type === "delta") streamDelta(ev.field, ev.text);
        }
      },
      toolEnd(call) {
        if (call !== active) return;
        active = null;
        const input = parseInput(call, WRITE_BRANCH_CARD);
        if (input && !oneLineText(input.title)) call.error = "Invalid write_card input: title must not be empty.";
        if (call.error) {
          held = [];
          if (live(job)) log.append("node.reset", { id }); // clear the rejected attempt
          return;
        }
        setTitle(input.title);
        reconcile(job, id, { summary: input.summary, body: input.body });
        call.accepted = true;
        wrote = true;
      },
      execute(call) {
        if (call.name !== "write_card") return fail(call, `Unknown tool "${call.name}".`);
        if (call.accepted) return ok(call, { id });
        return fail(call, call.error ?? "Only the first write_card call is used.");
      },
      finished: () => wrote,
      // After the loop: a plain-text answer becomes the body, titled from the follow-up.
      finalize() {
        if (!live(job)) return;
        if (!wrote) {
          const body = text.trim();
          if (!body) {
            finish(job, "error", "The model returned nothing for this follow-up.");
            return;
          }
          if (!log.state.nodes[id].title) setTitle(titleFromText(meta.text));
          delta(job, "body", body);
        }
        finish(job, "settled");
      },
    };
  }

  // ---------- a follow-up in one card's thread ----------

  async function runReply(provider, job, ctx, meta) {
    const writer = threadWriter(job);
    const hooks = {
      text: writer.text,
      execute(call) {
        if (call.name === "link_cards") return linkCall(call, new Map());
        return fail(call, `Unknown tool "${call.name}".`);
      },
    };
    try {
      await converse(provider, job, ctx, [LINK_CARDS], meta, hooks, MAX_ROUNDS.reply);
      if (live(job)) finish(job, "settled");
    } catch (err) {
      if (live(job)) {
        logger.warn?.(`[engine] reply failed: ${messageOf(err)}`);
        finish(job, "error", messageOf(err));
      }
    }
  }

  // ---------- a follow-up answered as a new card ----------

  async function runBranch(provider, job, ctx, meta) {
    const writer = branchWriter(job, meta);
    const hooks = {
      ...writer,
      execute: (call) => (call.name === "link_cards" ? linkCall(call, new Map()) : writer.execute(call)),
    };
    try {
      await converse(provider, job, ctx, [WRITE_BRANCH_CARD, LINK_CARDS], meta, hooks, MAX_ROUNDS.write);
      writer.finalize();
    } catch (err) {
      if (live(job)) {
        logger.warn?.(`[engine] branch failed: ${messageOf(err)}`);
        finish(job, "error", messageOf(err));
      }
    }
  }

  function branchMeta(source, origin, ctx, cardId, refresh) {
    return {
      purpose: "branch",
      ...describeContext(log.state, source.id),
      text: origin.text,
      quote: origin.quote,
      cardId,
      refresh,
      sections: ctx.sections,
    };
  }

  // ---------- a follow-up where the model picks the thread or a new card ----------

  const PREAMBLE_LIMIT = 80;

  // Move a job to another node (the assistant message or the new card).
  function rekey(job, nodeId) {
    if (jobs.get(job.nodeId) === job) jobs.delete(job.nodeId);
    job.nodeId = nodeId;
    jobs.set(nodeId, job);
  }

  // Close a follow-up that never got content: the user message stops being
  // pending and an assistant message opens and closes with `status`.
  function settlePending(job, status, error) {
    const f = job.followup;
    if (!f || f.path !== null || jobs.get(job.nodeId) !== job) return;
    f.path = "none";
    detach(job);
    log.append("node.patch", { id: f.userNodeId, patch: { pending: false } });
    const id = openNode({ kind: "message", parentId: f.card.id, turnId: f.card.turnId, role: "assistant", status: "streaming" });
    log.append("node.close", error ? { id, status, error } : { id, status });
  }

  // The path is decided by the first content: text means the thread, a
  // write_card call means a new card. Leading text is buffered until a
  // write_card call starts (then dropped), it passes PREAMBLE_LIMIT
  // characters, or the message ends (then it is the thread's first text).
  // link_cards alone decides nothing.
  async function runFollowup(provider, job, ctx, meta) {
    const f = job.followup;
    let buffer = [];
    let bufferedChars = 0;
    let thread = null;
    let card = null;

    function toThread() {
      f.path = "thread";
      log.append("node.patch", { id: f.userNodeId, patch: { pending: false } });
      const id = openNode({ kind: "message", parentId: f.card.id, turnId: f.card.turnId, role: "assistant", status: "streaming" });
      rekey(job, id);
      thread = threadWriter(job);
      for (const [t, r] of buffer.splice(0)) thread.text(t, r);
    }

    function toCard() {
      f.path = "card";
      buffer = []; // a preamble is not shown
      log.append("node.patch", { id: f.userNodeId, patch: { pending: false, answeredBy: f.cardId } });
      const origin = { cardId: f.card.id, text: f.text, ...(f.quote ? { quote: f.quote } : {}), messageId: f.userNodeId };
      openNode({
        id: f.cardId,
        kind: "card",
        parentId: f.card.parentId,
        turnId: f.card.turnId,
        role: "assistant",
        title: "",
        status: "streaming",
        origin,
      });
      addEdge(f.cardId, f.card.id, "elaborates");
      rekey(job, f.cardId);
      card = branchWriter(job, meta);
    }

    const hooks = {
      text(t, round) {
        if (f.path === "thread") return thread.text(t, round);
        if (f.path === "card") return card.text(t);
        buffer.push([t, round]);
        bufferedChars += t.length;
        if (bufferedChars > PREAMBLE_LIMIT) toThread();
      },
      toolStart(call) {
        if (f.path === null && call.name === "write_card") toCard();
        if (f.path === "card") card.toolStart(call);
      },
      toolDelta(call, json) {
        if (f.path === "card") card.toolDelta(call, json);
      },
      toolEnd(call) {
        if (f.path === "card") card.toolEnd(call);
      },
      messageEnd() {
        if (f.path === null && bufferedChars > 0) toThread();
      },
      execute(call) {
        if (call.name === "link_cards") return linkCall(call, new Map());
        if (call.name === "write_card") {
          if (f.path === "card") return card.execute(call);
          return fail(call, "This follow-up is already being answered in the card's thread; write_card was not used.");
        }
        return fail(call, `Unknown tool "${call.name}".`);
      },
      finished: () => f.path === "card" && card.finished(),
    };

    try {
      await converse(provider, job, ctx, [WRITE_BRANCH_CARD, LINK_CARDS], meta, hooks, MAX_ROUNDS.reply);
      if (!live(job)) return;
      if (f.path === null) settlePending(job, "error", "The model returned no answer to this follow-up.");
      else if (f.path === "card") card.finalize();
      else finish(job, "settled");
    } catch (err) {
      if (!live(job)) return;
      logger.warn?.(`[engine] follow-up failed: ${messageOf(err)}`);
      if (f.path === null) settlePending(job, "error", messageOf(err));
      else finish(job, "error", messageOf(err));
    }
  }

  // ---------- intents ----------

  function ask(body) {
    const text = requireText(body?.text);
    let chatId;
    if (body?.chatId !== undefined && body?.chatId !== null) {
      const first = typeof body.chatId === "string" ? log.state.nodes[body.chatId] : null;
      if (!first || first.kind !== "question" || chatOf(log.state, first.id) !== first.id) {
        throw new HttpError(400, "chatId must be the id of a chat's first question");
      }
      chatId = first.id;
    }
    const docs = docList(body?.docs);
    const { mode, maxCards, length } = config;
    const qid = openNode({ kind: "question", role: "user", body: text, status: "streaming", mode, chatId });
    // Attached files join the chat before its context is built.
    for (const d of docs) addDoc(chatId ?? qid, d);
    const job = startJob(qid);
    track(runAnswer(job, text, { mode, maxCards, length, provider: acquire(), planner: acquirePlanner() }));
    return { turnId: qid };
  }

  function startReply(card, text, quote) {
    const ctx = withLength(buildContext(log.state, card.id, { text, quote }), config.length);
    const info = describeContext(log.state, card.id);
    const userNodeId = openNode({
      kind: "message",
      parentId: card.id,
      turnId: card.turnId,
      role: "user",
      body: text,
      status: "settled",
      quote,
    });
    const assistantNodeId = openNode({
      kind: "message",
      parentId: card.id,
      turnId: card.turnId,
      role: "assistant",
      status: "streaming",
    });
    const job = startJob(assistantNodeId);
    track(runReply(acquire(), job, ctx, { purpose: "reply", ...info, text, quote, sections: ctx.sections }));
    return { userNodeId, assistantNodeId };
  }

  function reply(id, body) {
    const card = resolveCard(id);
    const text = requireText(body?.text);
    const quote = optionalText(body?.quote, "quote");
    return startReply(card, text, quote);
  }

  // A follow-up answered as a new card beside its source. Event order:
  // node.open (title "", streaming, origin), edge.add (elaborates, to the
  // source), node.patch { title }, node.delta..., node.close.
  function branch(id, body) {
    const source = resolveCard(id);
    const text = requireText(body?.text);
    const quote = optionalText(body?.quote, "quote");
    const origin = quote ? { cardId: source.id, text, quote } : { cardId: source.id, text };
    const cardId = newId("n");
    const ctx = withLength(buildBranchContext(log.state, source.id, { text, quote, cardId }), config.length); // before the card exists
    openNode({
      id: cardId,
      kind: "card",
      parentId: source.parentId,
      turnId: source.turnId,
      role: "assistant",
      title: "",
      status: "streaming",
      origin,
    });
    addEdge(cardId, source.id, "elaborates");
    const job = startJob(cardId);
    track(runBranch(acquire(), job, ctx, branchMeta(source, origin, ctx, cardId, false)));
    return { cardId };
  }

  // A follow-up the model answers in the thread or as a new card. The user's
  // message opens at once with pending: true; see runFollowup for the rest.
  function followup(id, body) {
    const card = resolveCard(id);
    const text = requireText(body?.text);
    const quote = optionalText(body?.quote, "quote");
    const userNodeId = openNode({
      kind: "message",
      parentId: card.id,
      turnId: card.turnId,
      role: "user",
      body: text,
      status: "settled",
      quote,
      pending: true,
    });
    const cardId = newId("n"); // used only if the model answers with a card
    // A pending message is left out of thread context, so it appears once, as the new question.
    const ctx = withLength(buildFollowupContext(log.state, card.id, { text, quote, cardId }), config.length);
    const job = startJob(userNodeId);
    job.followup = { path: null, card, text, quote, userNodeId, cardId };
    const meta = { purpose: "followup", ...describeContext(log.state, card.id), text, quote, cardId, sections: ctx.sections };
    track(runFollowup(acquire(), job, ctx, meta));
    return { userNodeId };
  }

  function broadcast(body) {
    const ids = idList(body?.cardIds, "cardIds");
    const text = requireText(body?.text);
    const cards = [];
    for (const id of ids) {
      const card = resolveCard(id);
      if (!cards.includes(card)) cards.push(card);
    }
    return { replies: cards.map((card) => ({ cardId: card.id, ...startReply(card, text, undefined) })) };
  }

  function synthesize(body) {
    const ids = idList(body?.cardIds, "cardIds");
    const cards = [];
    for (const id of ids) {
      const card = strictCard(id);
      if (!cards.includes(card)) cards.push(card);
    }
    const first = cards[0];
    const ctx = withLength(
      buildSynthesisContext(
        log.state,
        cards.map((c) => c.id),
      ),
      config.length,
    );
    let title = `Synthesis: ${cards.map((c) => c.title).join(" + ")}`;
    if (title.length > 80) title = title.slice(0, 77).trimEnd() + "...";
    const cardId = openCard(first.parentId, title);
    for (const c of cards) if (!duplicateEdge(cardId, c.id, "elaborates")) addEdge(cardId, c.id, "elaborates");
    const job = startJob(cardId);
    const meta = {
      purpose: "synthesis",
      question: String(log.state.nodes[first.turnId]?.body ?? ""),
      title,
      sources: cards.map((c) => ({ title: c.title, summary: c.summary })),
      decisions: decisionsIn(log.state, first.id).map((d) => d.text),
      sections: ctx.sections,
    };
    track(runWriter(acquire(), job, ctx, meta));
    return { cardId };
  }

  function refresh(id) {
    const card = strictCard(id);
    const source = card.origin ? log.state.nodes[card.origin.cardId] : null;
    if (source?.kind === "card") {
      // A branch card answers its follow-up again, with the current decisions.
      const ctx = withLength(buildBranchContext(log.state, source.id, { ...card.origin, cardId: card.id, refresh: true }), config.length);
      const prev = jobs.get(card.id);
      if (prev) {
        detach(prev);
        prev.controller.abort();
      }
      log.append("node.reset", { id: card.id });
      const job = startJob(card.id);
      track(runBranch(acquire(), job, ctx, branchMeta(source, card.origin, ctx, card.id, true)));
      return { cardId: card.id };
    }
    const ctx = withLength(buildRefreshContext(log.state, card.id), config.length); // before node.reset clears the body
    const meta = {
      purpose: "refresh",
      question: String(log.state.nodes[card.turnId]?.body ?? ""),
      title: card.title,
      oldChars: card.body.length,
      decisions: decisionsIn(log.state, card.id).map((d) => d.text),
      sections: ctx.sections,
    };
    const prev = jobs.get(card.id);
    if (prev) {
      detach(prev);
      prev.controller.abort();
    }
    log.append("node.reset", { id: card.id });
    const job = startJob(card.id);
    track(runWriter(acquire(), job, ctx, meta));
    return { cardId: card.id };
  }

  function cancel(id) {
    const node = log.state.nodes[id];
    if (!node) throw new HttpError(404, `unknown node ${id}`);
    const job = jobs.get(id);
    if (job?.followup?.path === null) {
      // Still pending: no answer node yet.
      settlePending(job, "cancelled");
      job.controller.abort();
    } else if (job) cancelJob(job);
    else if (node.status === "streaming") log.append("node.close", { id, status: "cancelled" });
    return { id };
  }

  function pin(body) {
    const text = requireText(body?.text);
    const sourceNodeId = optionalText(body?.sourceNodeId, "sourceNodeId") ?? null;
    if (sourceNodeId && !log.state.nodes[sourceNodeId]) throw new HttpError(404, `unknown node ${sourceNodeId}`);
    let affects;
    if (body?.affects === undefined || body?.affects === null) {
      affects = computeAffects(log.state, sourceNodeId);
    } else {
      if (!Array.isArray(body.affects) || !body.affects.every((v) => typeof v === "string")) {
        throw new HttpError(400, "affects must be an array of card ids");
      }
      affects = [...new Set(body.affects)].filter((cid) => log.state.nodes[cid]?.kind === "card");
    }
    // scope: the chat it applies to; absent or null means every chat.
    const scope = body?.scope === undefined || body?.scope === null ? null : requireChat(body.scope, "scope");
    const decision = { id: newId("d"), text, sourceNodeId, affects, scope };
    log.append("decision.pin", { decision });
    return { decision };
  }

  // Edit a decision's text and/or the cards it marks out of date.
  function editDecision(id, body) {
    const d = log.state.decisions.find((x) => x.id === id);
    if (!d) throw new HttpError(404, `unknown decision ${id}`);
    const patch = {};
    if (body?.text !== undefined) patch.text = requireText(body.text);
    if (body?.affects !== undefined) {
      if (!Array.isArray(body.affects) || !body.affects.every((v) => typeof v === "string")) {
        throw new HttpError(400, "affects must be an array of card ids");
      }
      patch.affects = [...new Set(body.affects)].filter((cid) => log.state.nodes[cid]?.kind === "card");
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "send text and/or affects");
    log.append("decision.patch", { id, patch });
    return { decision: log.state.decisions.find((x) => x.id === id) };
  }

  function unpin(id) {
    if (!log.state.decisions.some((d) => d.id === id)) throw new HttpError(404, `unknown decision ${id}`);
    log.append("decision.unpin", { id });
    return { id };
  }

  // ---------- chats, groups, notes and documents ----------

  function requireChat(id, name = "chatId") {
    const first = typeof id === "string" ? log.state.nodes[id] : null;
    if (!first || first.kind !== "question" || chatOf(log.state, first.id) !== first.id) {
      throw new HttpError(400, `${name} must be the id of a chat's first question`);
    }
    return first.id;
  }

  function requireGroup(id) {
    if (!log.state.groups.some((g) => g.id === id)) throw new HttpError(404, `unknown group ${id}`);
    return id;
  }

  const shortName = (value, name, max = 120) => {
    const t = oneLine(requireText(value, name));
    return t.length > max ? t.slice(0, max) : t;
  };

  // Rename a chat, pin it to the top of the list, or move it into a group.
  function patchChat(id, body) {
    const chatId = requireChat(id);
    const patch = {};
    if (body?.title !== undefined) patch.title = body.title === null || body.title === "" ? null : shortName(body.title, "title");
    if (body?.pinned !== undefined) patch.pinned = !!body.pinned;
    if (body?.groupId !== undefined) patch.groupId = body.groupId === null ? null : requireGroup(body.groupId);
    if (!Object.keys(patch).length) throw new HttpError(400, "send title, pinned and/or groupId");
    log.append("chat.meta", { chatId, patch });
    return { chatId, meta: log.state.chatMeta[chatId] ?? {} };
  }

  // Delete a chat for good: stop its work, remove it from the state, then
  // erase its content from the stored history.
  function deleteChat(id) {
    const chatId = requireChat(id);
    const s = log.state;
    const ids = chatNodeIds(s, chatId);
    for (const nodeId of ids) {
      const job = jobs.get(nodeId);
      if (job) {
        detach(job);
        job.controller.abort();
      }
    }
    const decisions = new Set(s.decisions.filter((d) => d.scope === chatId).map((d) => d.id));
    const docs = new Set(s.docs.filter((d) => d.chatId === chatId).map((d) => d.id));
    log.append("chat.delete", { chatId });
    log.redact((ev) => {
      switch (ev.type) {
        case "node.open":
          return ids.has(ev.node?.id) ? ev.node.id : null;
        case "node.delta":
        case "node.patch":
        case "node.reset":
        case "node.close":
          return ids.has(ev.id) ? ev.id : null;
        case "edge.add":
          return ids.has(ev.edge?.from) || ids.has(ev.edge?.to) ? ev.edge.id : null;
        case "decision.pin":
          return decisions.has(ev.decision?.id) ? ev.decision.id : null;
        case "decision.patch":
        case "decision.unpin":
          return decisions.has(ev.id) ? ev.id : null;
        case "chat.meta":
          return ev.chatId === chatId ? chatId : null;
        case "note.set":
          return ids.has(ev.targetId) ? ev.targetId : null;
        case "doc.add":
          return docs.has(ev.doc?.id) ? ev.doc.id : null;
        case "doc.remove":
          return docs.has(ev.id) ? ev.id : null;
        default:
          return null;
      }
    });
    return { chatId };
  }

  function addGroup(body) {
    const group = { id: newId("g"), name: shortName(body?.name, "name", 60) };
    log.append("group.add", { group });
    if (Array.isArray(body?.chatIds)) for (const cid of body.chatIds) patchChat(cid, { groupId: group.id });
    return { group };
  }

  function patchGroup(id, body) {
    requireGroup(id);
    log.append("group.patch", { id, patch: { name: shortName(body?.name, "name", 60) } });
    return { group: log.state.groups.find((g) => g.id === id) };
  }

  // The group goes; its chats stay, ungrouped.
  function removeGroup(id) {
    requireGroup(id);
    log.append("group.remove", { id });
    return { id };
  }

  // A private note on a card or on a chat (its first question). The model never sees notes.
  const NOTE_MAX = 20_000;
  function setNote(targetId, body) {
    const node = log.state.nodes[targetId];
    if (!node) throw new HttpError(404, `unknown node ${targetId}`);
    const isChat = node.kind === "question" && chatOf(log.state, node.id) === node.id;
    if (node.kind !== "card" && !isChat) throw new HttpError(400, "notes go on a card or a chat");
    if (body?.text !== undefined && body?.text !== null && typeof body.text !== "string") throw new HttpError(400, "text must be a string");
    const text = String(body?.text ?? "");
    if (text.length > NOTE_MAX) throw new HttpError(400, `a note may hold at most ${NOTE_MAX} characters`);
    log.append("note.set", { targetId, text });
    return { targetId, note: log.state.notes[targetId] ?? null };
  }

  // Saved cards: kept by the person, shown on the saved board.
  function saveCard(id, body) {
    strictCard(id);
    if (typeof body?.saved !== "boolean") throw new HttpError(400, "saved must be true or false");
    if (body.saved !== !!log.state.saved[id]) {
      const ev = { id, saved: body.saved };
      if (body.saved) for (const k of ["w", "h"]) if (Number.isFinite(body[k])) ev[k] = body[k];
      if (body.saved && body.folderId !== undefined && body.folderId !== null) {
        if (!log.state.folders.some((f) => f.id === body.folderId)) throw new HttpError(404, `unknown folder ${body.folderId}`);
        ev.folderId = body.folderId;
      }
      log.append("card.save", ev);
    }
    return { id, saved: log.state.saved[id] ?? null };
  }

  // Folders for saved cards.
  function addFolder(body) {
    const name = shortName(body?.name, "name", 60);
    if (log.state.folders.length >= 200) throw new HttpError(400, "too many folders");
    const folder = { id: newId("o"), name };
    log.append("folder.add", { folder });
    return { folder };
  }
  function patchFolder(id, body) {
    if (!log.state.folders.some((f) => f.id === id)) throw new HttpError(404, `unknown folder ${id}`);
    log.append("folder.patch", { id, patch: { name: shortName(body?.name, "name", 60) } });
    return { folder: log.state.folders.find((f) => f.id === id) };
  }
  function removeFolder(id) {
    if (!log.state.folders.some((f) => f.id === id)) throw new HttpError(404, `unknown folder ${id}`);
    log.append("folder.remove", { id });
    return { id };
  }

  function placeSaved(id, body) {
    if (!log.state.saved[id]) throw new HttpError(404, `${id} is not a saved card`);
    const patch = {};
    if (body?.x !== undefined || body?.y !== undefined) {
      if (!Number.isFinite(body.x) || !Number.isFinite(body.y) || Math.abs(body.x) > 1e6 || Math.abs(body.y) > 1e6) throw new HttpError(400, "x and y must be numbers");
      patch.x = body.x;
      patch.y = body.y;
    }
    if (body?.follow !== undefined) {
      if (typeof body.follow !== "boolean") throw new HttpError(400, "follow must be true or false");
      patch.follow = body.follow;
    }
    if (body?.folderId !== undefined) {
      if (body.folderId !== null && !log.state.folders.some((f) => f.id === body.folderId)) throw new HttpError(404, `unknown folder ${body.folderId}`);
      patch.folderId = body.folderId;
    }
    for (const k of ["w", "h"]) {
      if (body?.[k] === undefined) continue;
      if (k === "h" && body.h === null) patch.h = null;
      else if (Number.isFinite(body[k]) && body[k] >= 120 && body[k] <= 4000) patch[k] = body[k];
      else throw new HttpError(400, `${k} must be a number from 120 to 4000`);
    }
    if (!Object.keys(patch).length) throw new HttpError(400, "send x and y, w and/or h, and/or follow");
    log.append("card.place", { id, patch });
    return { id, saved: log.state.saved[id] };
  }

  function docList(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new HttpError(400, "docs must be an array");
    if (value.length > MAX_DOCS) throw new HttpError(400, `attach at most ${MAX_DOCS} files at once`);
    return value.map((d, i) => {
      if (!d || typeof d !== "object") throw new HttpError(400, `docs[${i}] must be an object`);
      const name = shortName(d.name, `docs[${i}].name`, 160);
      if (typeof d.text !== "string") throw new HttpError(400, `docs[${i}].text must be a string`);
      if (d.text.length > MAX_DOC_CHARS) throw new HttpError(400, `${name} is too long (at most ${MAX_DOC_CHARS} characters)`);
      const mime = typeof d.mime === "string" ? d.mime.slice(0, 100) : "";
      const size = Number.isFinite(d.size) && d.size >= 0 ? Math.floor(d.size) : d.text.length;
      return { name, text: d.text, mime, size };
    });
  }

  function addDoc(chatId, d) {
    const doc = { id: newId("f"), chatId, name: d.name, mime: d.mime, size: d.size, chars: d.text.length, text: d.text };
    log.append("doc.add", { doc });
    return doc;
  }

  function addDocs(chatIdRaw, body) {
    const chatId = requireChat(chatIdRaw);
    const docs = docList(body?.docs);
    if (!docs.length) throw new HttpError(400, "docs must hold at least one file");
    const added = docs.map((d) => addDoc(chatId, d));
    return { docs: added.map(({ text: _t, ...rest }) => rest) };
  }

  function removeDoc(id) {
    if (!log.state.docs.some((d) => d.id === id)) throw new HttpError(404, `unknown document ${id}`);
    log.append("doc.remove", { id });
    return { id };
  }

  function context(id) {
    const card = resolveCard(id);
    const { system, messages, sections } = buildContext(log.state, card.id, { text: "" });
    return { system, messages, sections };
  }

  function getConfig() {
    const active = registry ? registry.activeConfig() : { provider: provider.name, model: provider.model };
    return { provider: active.provider, model: active.model, mode: config.mode, maxCards: config.maxCards, length: config.length, thinking: config.thinking, planner: config.planner ? { ...config.planner } : null };
  }

  // null clears it; else { provider, model, thinking? } with a provider that has a key.
  function checkPlanner(p) {
    if (p === null) return null;
    if (typeof p !== "object" || Array.isArray(p)) throw new HttpError(400, "planner must be null or { provider, model, thinking? }");
    if (!registry) throw new HttpError(400, "this server runs a fixed provider");
    if (typeof p.model !== "string" || !p.model.trim()) throw new HttpError(400, "planner.model is required");
    const thinking = p.thinking ?? "low";
    if (!THINKING.includes(thinking)) throw new HttpError(400, `planner.thinking must be one of: ${THINKING.join(", ")}`);
    const { id, model } = registry.check(p.provider, p.model);
    return { provider: id, model, thinking };
  }

  // Everything is validated before anything is applied.
  function setConfig(body) {
    const hasMode = body?.mode !== undefined;
    const hasMax = body?.maxCards !== undefined;
    const hasProvider = body?.provider !== undefined;
    const hasModel = body?.model !== undefined;
    const hasLength = body?.length !== undefined;
    const hasThinking = body?.thinking !== undefined;
    const hasPlanner = body?.planner !== undefined;
    if (!hasMode && !hasMax && !hasProvider && !hasModel && !hasLength && !hasThinking && !hasPlanner) throw new HttpError(400, "send mode, maxCards, length, thinking, planner, provider and/or model");
    let planner;
    if (hasPlanner) planner = checkPlanner(body.planner);
    if (hasLength && !LENGTHS.includes(body.length)) throw new HttpError(400, `length must be one of: ${LENGTHS.join(", ")}`);
    if (hasThinking && !THINKING.includes(body.thinking)) throw new HttpError(400, `thinking must be one of: ${THINKING.join(", ")}`);
    if (hasMode && !MODES.includes(body.mode)) throw new HttpError(400, `mode must be one of: ${MODES.join(", ")}`);
    if (hasMax && !(Number.isInteger(body.maxCards) && body.maxCards >= 1 && body.maxCards <= MAX_CARDS)) {
      throw new HttpError(400, `maxCards must be an integer from 1 to ${MAX_CARDS}`);
    }
    let next = null;
    if (hasProvider || hasModel) {
      if (!registry) throw new HttpError(400, "this server runs a fixed provider");
      next = registry.check(hasProvider ? body.provider : registry.activeConfig().provider, hasModel ? body.model : undefined);
    }
    if (hasMode) config.mode = body.mode;
    if (hasMax) config.maxCards = body.maxCards;
    if (hasLength) config.length = body.length;
    if (hasThinking) config.thinking = body.thinking;
    if (hasPlanner) config.planner = planner;
    if (next) registry.activate(next);
    return getConfig();
  }

  // After a restart: work that was streaming when the server stopped is
  // closed as cancelled, and a follow-up still pending gets its cancelled
  // assistant message (as if it had been cancelled while pending).
  function recover() {
    const s = log.state;
    for (const id of [...s.order]) {
      if (s.nodes[id].status === "streaming") log.append("node.close", { id, status: "cancelled" });
    }
    for (const id of [...s.order]) {
      const m = s.nodes[id];
      if (m.kind !== "message" || !m.pending) continue;
      log.append("node.patch", { id, patch: { pending: false } });
      const aid = openNode({ kind: "message", parentId: m.parentId, turnId: m.turnId, role: "assistant", status: "streaming" });
      log.append("node.close", { id: aid, status: "cancelled" });
    }
  }

  function abortAll() {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
  }

  function reset() {
    abortAll();
    log.reset();
    return {};
  }

  async function idle() {
    while (running.size) await Promise.allSettled([...running]);
  }

  return {
    ask,
    branch,
    followup,
    reply,
    broadcast,
    synthesize,
    refresh,
    cancel,
    pin,
    unpin,
    editDecision,
    patchChat,
    deleteChat,
    addGroup,
    patchGroup,
    removeGroup,
    setNote,
    saveCard,
    placeSaved,
    addFolder,
    patchFolder,
    removeFolder,
    addDocs,
    removeDoc,
    context,
    getConfig,
    setConfig,
    reset,
    recover,
    shutdown: abortAll,
    idle,
    get log() {
      return log;
    },
  };
}
