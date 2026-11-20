// Deterministic mock provider: no network, no randomness beyond a seeded PRNG.
//
// It speaks the same event stream as the Anthropic provider (text deltas,
// tool_start / tool_delta / tool_end, then stop with the assistant content),
// and delivers tool inputs as awkwardly chunked partial JSON: escapes split
// anywhere, non-ASCII sometimes as \uXXXX (surrogate pairs included), varying
// key order and spacing. So the whole tool path runs with no key.
//
// Behaviour by meta.purpose:
//   turn   (single mode)  create_card x N, link_cards, then a short closing text
//   plan   (fan-out)      create_card { key, title, intent } x N, link_cards, closing text
//   card / refresh / synthesis   one write_card call
//   reply                 plain text describing the context it was given; first a
//                         link_cards call when the follow-up names a card in another chat
// A new question that shares a significant word with the title of a card in
// an earlier chat gets one link from a new card to that card. The mock does
// not respect the card limit, so the server's cap is exercised.
//
// MOCK_SPEED (or { speed }) divides every delay; tests use a large value.

const VALID_RELS = ["depends_on", "feeds", "contradicts", "alternative_to", "elaborates"];

// ---------- deterministic helpers ----------

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clear();
      reject(abortError());
    };
    let handle;
    let clear;
    if (ms < 1) {
      handle = setImmediate(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
      clear = () => clearImmediate(handle);
    } else {
      handle = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      clear = () => clearTimeout(handle);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------- planning: titles from the question ----------

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function titleFrom(part) {
  let t = String(part).replace(/\s+/g, " ").trim();
  t = t.replace(/[?.!:;,]+$/, "").trim();
  t = t.replace(/^(and|also|then|plus|or|but|so|finally)\s+/i, "");
  t = t.replace(/^(what about|how about)\s+/i, "");
  t = t.replace(
    /^(how|what|why|when|where|which|who)\s+(do|does|did|should|can|could|would|will|shall|must)\s+(we|i|you|they|it|one)\s+/i,
    (m, w) => (/^why$/i.test(w) ? "why " : ""),
  );
  t = t.replace(/^(what|which|who)\s+(is|are|was|were)\s+/i, "");
  t = t.replace(/^(how)\s+(is|are)\s+/i, "");
  t = t.replace(/^(the|a|an)\s+/i, "");
  const words = t.split(" ").filter(Boolean).slice(0, 7);
  t = words.join(" ");
  if (t.length > 48) t = t.slice(0, 47).trimEnd() + "...";
  return capitalize(t);
}

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

// Split, then fold fragments of fewer than two words back into the previous part.
function splitParts(text, pattern) {
  const raw = text
    .split(pattern)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = [];
  for (const p of raw) {
    if (parts.length && wordCount(p) < 2) parts[parts.length - 1] += " and " + p;
    else parts.push(p);
  }
  return parts;
}

export function derivePlan(question, limit = 4) {
  const q = String(question ?? "").replace(/\s+/g, " ").trim();
  let parts = [];
  let shape = /^(compare|comparing)\b/i.test(q) ? "comparison" : "parallel";

  const numbered = [...q.matchAll(/(?:^|\s)\(?(\d{1,2})[.)]\s+/g)];
  // "Topic: a, b, and c" lists the parts after the colon.
  const colon = /^[^:]{3,}:\s+(.+)$/.exec(q);
  const listed = colon
    ? colon[1]
        .replace(/[.?!]+$/, "")
        .split(/,|;|\s+and\s+/i)
        .map((s) => s.trim().replace(/^(and|or)\s+/i, ""))
        .filter(Boolean)
    : [];
  if (numbered.length >= 2) {
    for (let i = 0; i < numbered.length; i++) {
      const start = numbered[i].index + numbered[i][0].length;
      const end = i + 1 < numbered.length ? numbered[i + 1].index : q.length;
      parts.push(q.slice(start, end));
    }
    shape = "steps";
  } else if (/\s(vs\.?|versus)\s/i.test(q)) {
    parts = splitParts(q.replace(/^(compare|comparing)\s+/i, ""), /\s(?:vs\.?|versus)\s/i);
    shape = "comparison";
  } else if (listed.length >= 2) {
    parts = listed;
  } else {
    const questions = q
      .split("?")
      .map((s) => s.trim())
      .filter(Boolean);
    parts = questions.length >= 2 ? questions : splitParts(q, /,|;|\s+and\s+|\s+also\s+/i);
  }

  let titles = [];
  const intents = [];
  for (const p of parts) {
    const t = titleFrom(p);
    if (t.length < 3 || titles.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
    titles.push(t);
    intents.push(`Answer this part of the question: "${p.replace(/[?,;]+$/, "").trim()}".`);
  }
  // Never plans fewer than 4, so a low limit still exercises the engine's cap.
  titles = titles.slice(0, Math.max(4, limit));

  if (titles.length < 2) {
    if (wordCount(q) <= 14) {
      const title = titleFrom(q) || "Answer";
      return {
        shape: "single",
        cards: [{ key: "c1", title, intent: "Answer the whole question directly." }],
        links: [],
      };
    }
    const facets = [
      ["Overview", "Say what the answer is in plain terms before any detail."],
      ["How it works", "Walk through the mechanism, with a small example."],
      ["Trade-offs", "Cover the costs, risks and alternatives."],
    ];
    return {
      shape: "parallel",
      cards: facets.map(([title, intent], i) => ({ key: `c${i + 1}`, title, intent })),
      links: [
        { from: "c3", to: "c2", rel: "elaborates" },
      ],
    };
  }

  const cards = titles.map((title, i) => ({ key: `c${i + 1}`, title, intent: intents[i] }));
  const links = [];
  for (let i = 0; i + 1 < cards.length; i++) {
    // Only sub-card links exist now: the later card goes deeper into the earlier one.
    links.push({ from: cards[i + 1].key, to: cards[i].key, rel: "elaborates" });
  }
  return { shape, cards, links };
}

// ---------- cross-chat links ----------

const STOPWORDS = new Set(
  (
    "about above after again against because before being below between could doing during every from having " +
    "here into itself just more most other over same should since some such than that their them then there " +
    "these they this those through under until very what when where which while whom with would your also does " +
    "each like make many much need only want well were will answer please think thing things using"
  ).split(" "),
);

// Lowercased words of five letters or more, a trailing "s" dropped.
export function significantWords(text) {
  return (String(text).toLowerCase().match(/[a-z][a-z0-9-]*/g) ?? [])
    .filter((w) => w.length >= 5 && !STOPWORDS.has(w))
    .map((w) => w.replace(/s$/, ""));
}

// The first existing card whose title shares a significant word with the text.
export function relatedCard(text, cards) {
  const words = new Set(significantWords(text));
  for (const card of cards) {
    const shared = significantWords(card.title).find((w) => words.has(w));
    if (shared) return { card, word: shared };
  }
  return null;
}

// ---------- writing ----------

const OPENERS = [
  "The short version: keep {t} boring and explicit, and let the rest of the design lean on it.",
  "{T} is where most of the risk in this question sits, so it is worth being precise.",
  "For {t}, the right default is the simplest thing that keeps working when two things happen at once.",
  "Start {t} from the data, not from the screen: decide what has to be true, then show it.",
];
const POINTS = [
  ["One owner", "a single place decides the order of events; everything else reads from it."],
  ["Append, do not edit", "new facts arrive as new entries, so replay and undo come for free."],
  ["Small units", "work in pieces small enough that cancelling one never strands the others."],
  ["Visible state", "every piece carries a status the reader can see: streaming, settled, stale."],
  ["Cheap retries", "a failed piece is retried on its own, without regenerating its neighbours."],
  ["Bounded fan-out", "cap concurrent work, so a big question does not starve a small one."],
  ["Stable prefixes", "anything shared by many requests is written once, in a fixed order."],
];
const CLOSERS = [
  "If this card turns out wrong, pin the correction as a decision and the linked cards will be flagged for a refresh.",
  "The next step is to try it on one real question and watch where it feels slow.",
  "None of this needs a framework; a log, a reducer and a few small functions carry it.",
];

function fill(template, title) {
  const t = title.toLowerCase();
  return template.replaceAll("{t}", t).replaceAll("{T}", title);
}

function slug(title) {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 24) || "item"
  );
}

function list(items) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

export function cardSummary(title, question) {
  const r = rng(hash("summary:" + title + question));
  return pick(r, [
    `What to do about ${title.toLowerCase()}, and the one trap to avoid.`,
    `${title}: a concrete default, why it holds up, and when to change it.`,
    `How ${title.toLowerCase()} fits the rest of the answer, with a small example.`,
  ]);
}

// Cards vary in length, deterministically, so content-sized cards can be
// seen without a real model: a short card is three sentences, a medium one a
// few bullets, a long one adds a code sample.
export function cardLength(title, question) {
  return ["short", "medium", "long"][hash("length:" + title + "|" + question) % 3];
}

const SPECIAL_LINE =
  'On disk each event is one line such as `{"seq":42,"type":"node.close"}`, kept under `C:\\data\\events` and rotated daily \u2192 caf\u00e9-grade boring \u2705 \ud83d\ude80';

// Markdown with characters that need JSON escaping: quotes, backslashes,
// newlines, non-ASCII and an astral character (a surrogate pair).
export function cardBody(title, question, intent = "", { length = cardLength(title, question) } = {}) {
  const r = rng(hash("body:" + title + question + intent));
  const points = [...POINTS];
  for (let i = points.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [points[i], points[j]] = [points[j], points[i]];
  }
  points.length = 3;
  const name = slug(title);
  const opener = fill(pick(r, OPENERS), title);
  if (length === "short") {
    return `${opener} ${points[0][0]} matters most here: ${points[0][1]} In practice "${points[1][0].toLowerCase()}" \u2192 fewer surprises.`;
  }
  // a question that mentions a table gets one, wide enough to test how tables fit a card
  const table = /\btables?\b/i.test(question)
    ? ["", "| Principle | What it means | Where it helps | Cost |", "| --- | --- | --- | ---: |",
        ...points.map(([k, v], i) => `| ${k} | ${v} | ${title} under load, retries and cancellation | ${["low", "medium", "high"][i % 3]} |`)]
    : [];
  if (length === "medium") {
    return [opener, "", ...points.map(([k, v]) => `- **${k}:** ${v}`), ...table, "", SPECIAL_LINE, "", pick(r, CLOSERS)].join("\n");
  }
  return [
    opener,
    "",
    ...points.map(([k, v]) => `- **${k}:** ${v}`),
    ...table,
    "",
    "```js",
    `// ${title}: keep at most \`limit\` in flight`,
    `function admit_${name}(queue, item, limit) {`,
    "  if (queue.length < limit && item.size > 0) {",
    "    queue.push(item);",
    "    return true;",
    "  }",
    "  return false; // caller retries when queue.length <= limit - 1",
    "}",
    "```",
    "",
    `In the UI this is one \`<section>\` per card, so a slow ${title.toLowerCase()} never blocks the others.`,
    SPECIAL_LINE,
    "",
    pick(r, CLOSERS),
  ].join("\n");
}

// A follow-up answered as its own card. The body tracks the follow-up: under
// 60 characters it is two sentences with no code block, otherwise a long card.
export function branchInput(meta = {}) {
  const followup = String(meta.text ?? "").replace(/\s+/g, " ").trim();
  const title = titleFrom(followup) || "Follow-up";
  const source = meta.title || "the card";
  const decisions = meta.decisions ?? [];
  const r = rng(hash("branch:" + followup + "|" + source + "|" + decisions.join("|")));
  const summary = `${title}: the direct answer to a follow-up on ${source}.`;
  if (followup.length < 60) {
    const first = pick(r, [
      `Yes, for ${source.toLowerCase()} that holds as long as one place owns the order of events.`,
      `Short answer: keep it simple and let ${source.toLowerCase()} lean on the log it already has.`,
      `It comes down to one thing, whether ${source.toLowerCase()} has to survive a restart.`,
    ]);
    const second = decisions.length
      ? `That stays within the ${decisions.length} pinned decision${decisions.length === 1 ? "" : "s"}.`
      : pick(r, ["Anything beyond that is detail you can add later.", "The rest of the source card still stands as written."]);
    return { title, summary, body: `${first} ${second}` };
  }
  const lines = [];
  if (meta.quote) lines.push(...String(meta.quote).split("\n").map((l) => `> ${l}`), "");
  lines.push(`This follows up on *${source}*: "${followup}"`, "");
  if (decisions.length) lines.push(`_Written with ${decisions.length} pinned decision${decisions.length === 1 ? "" : "s"} in mind._`, "");
  lines.push(cardBody(title, followup, "branch", { length: "long" }));
  return { title, summary, body: lines.join("\n") };
}

function sectionsLine(sections = []) {
  return sections.map((s) => `${s.name} (${s.chars} chars${s.cached ? ", cached" : ""})`).join(", ");
}

export function replyText(meta = {}, { linkedTo = null } = {}) {
  const decisions = meta.decisions ?? [];
  const linked = meta.linked ?? [];
  const existing = meta.existing ?? [];
  const chats = new Set(existing.map((c) => c.chat)).size;
  const cachedChars = (meta.sections ?? []).filter((s) => s.cached).reduce((n, s) => n + s.chars, 0);
  const label = (c) => (c.chat && c.chat !== meta.chat ? `*${c.title}* (chat ${c.chat})` : `*${c.title}*`);
  const lines = [];
  if (linkedTo) lines.push(`Linked this card to ${label(linkedTo)}.`, "");
  lines.push(`**Context I was given** for this reply in *${meta.title ?? "this card"}*: ${sectionsLine(meta.sections)}.`);
  lines.push("");
  lines.push(
    `- Outline: titles and summaries of all ${meta.cards ?? "?"} cards in this chat, not their bodies.`,
    `- Existing cards listed with ids: ${existing.length} across ${chats} chat${chats === 1 ? "" : "s"}.`,
    `- Pinned decisions: ${decisions.length}${decisions.length ? ` (${decisions.map((d) => `"${d}"`).join("; ")})` : ""}.`,
    `- Linked cards in full: ${linked.length ? list(linked.map(label)) : "none"}.`,
    `- Earlier messages in this thread: ${meta.thread ?? 0}.`,
    `- Left out: other cards' bodies (unless linked) and every other card's thread.`,
    `- Cached prefix: ${cachedChars} chars, shared with every thread in this chat.`,
  );
  lines.push("");
  if (meta.quote) {
    lines.push(
      "You selected:",
      "",
      ...String(meta.quote)
        .split("\n")
        .map((l) => `> ${l}`),
      "",
    );
  }
  const r = rng(hash("reply:" + (meta.text ?? "") + (meta.title ?? "")));
  lines.push(
    `**On "${String(meta.text ?? "").trim()}":** ${pick(r, [
      `within *${meta.title}*, the answer is to keep the existing default and change one thing at a time.`,
      `for *${meta.title}* this mostly comes down to ordering: decide what must happen first and make the rest wait on it.`,
      `the card already points the right way; the missing piece is a clear status for each step so failures are visible.`,
    ])}`,
  );
  if (decisions.length) lines.push("", `That stays consistent with the pinned decision${decisions.length > 1 ? "s" : ""} above.`);
  if (linked.length) lines.push("", `It also fits ${label(linked[0])}, which this card is linked to.`);
  return lines.join("\n");
}

function refreshInput(meta) {
  const decisions = meta.decisions ?? [];
  const n = decisions.length;
  return {
    summary: `Revised for ${n} pinned decision${n === 1 ? "" : "s"}: ${n ? decisions.map((d) => `"${d}"`).join("; ") : "none"}.`,
    body: [
      `_Rewritten in light of ${n} pinned decision${n === 1 ? "" : "s"}; the previous version was ${meta.oldChars ?? 0} chars._`,
      "",
      ...decisions.map((d, i) => `${i + 1}. ${d}`),
      "",
      cardBody(meta.title ?? "Card", meta.question ?? "", "refresh:" + decisions.join("|")),
    ].join("\n"),
  };
}

function synthesisInput(meta) {
  const sources = meta.sources ?? [];
  const titles = sources.map((s) => s.title);
  return {
    summary: `Combines ${list(titles)} into one recommendation.`,
    body: [
      `This card pulls together ${list(titles.map((t) => `**${t}**`))}.`,
      "",
      ...sources.map((s) => `- **${s.title}:** ${s.summary || "(no summary)"}`),
      "",
      "**Where they agree:** each part works best with one owner of state and small, independently cancellable pieces of work.",
      "",
      "**Where they pull apart:** the more pieces run at once, the more an order of operations matters; decide it up front.",
      "",
      `**What to do:** start with ${titles[0] ?? "the first card"}, then let the others build on it.`,
    ].join("\n"),
  };
}

// ---------- scripts: what the mock "model" says on each call ----------

const thinking = (seed) => ({ type: "thinking", thinking: "", signature: `mock-signature-${hash(seed).toString(16)}` });
const tool = (name, input) => ({ type: "tool_use", name, input });

function afterTools(messages) {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !Array.isArray(last.content)) return null;
  const results = last.content.filter((b) => b.type === "tool_result");
  return results.length ? results : null;
}

function answerScript(meta, messages, fanout) {
  const results = afterTools(messages);
  if (results) {
    const failed = results.filter((r) => r.is_error).length;
    return {
      blocks: [
        {
          type: "text",
          text: failed
            ? `${failed} call${failed === 1 ? "" : "s"} failed; the cards that were created stand.`
            : "The board is ready.",
        },
      ],
      stop: "end_turn",
    };
  }
  const question = meta.question ?? "";
  const plan = derivePlan(question, meta.maxCards ?? 4);
  const blocks = [thinking("answer:" + question), { type: "text", text: `I'll answer this as ${plan.cards.length} card${plan.cards.length === 1 ? "" : "s"}.` }];
  for (const c of plan.cards) {
    blocks.push(
      tool(
        "create_card",
        fanout
          ? { key: c.key, title: c.title, intent: c.intent }
          : { key: c.key, title: c.title, summary: cardSummary(c.title, question), body: cardBody(c.title, question, c.intent) },
      ),
    );
  }
  for (const l of plan.links) blocks.push(tool("link_cards", { from: l.from, to: l.to, rel: l.rel }));
  const earlier = (meta.existing ?? []).filter((c) => c.turnId !== meta.turnId);
  const related = relatedCard(question, earlier);
  if (related) {
    const own = plan.cards.find((c) => significantWords(c.title).includes(related.word)) ?? plan.cards[0];
    blocks.push(tool("link_cards", { from: own.key, to: related.card.id, rel: "elaborates" }));
  }
  return { blocks, stop: "tool_use" };
}

function replyScript(meta, messages) {
  const results = afterTools(messages);
  if (!results) {
    const others = (meta.existing ?? []).filter((c) => c.chat !== meta.chat && c.id !== meta.focusId);
    const related = relatedCard(meta.text ?? "", others);
    if (related) {
      return {
        blocks: [
          thinking("reply:" + meta.text),
          { type: "text", text: `That touches *${related.card.title}* in chat ${related.card.chat}, so I'll link them.` },
          tool("link_cards", { from: meta.focusId, to: related.card.id, rel: "elaborates" }),
        ],
        stop: "tool_use",
        related,
      };
    }
    return { blocks: [thinking("reply:" + meta.text), { type: "text", text: replyText(meta) }], stop: "end_turn" };
  }
  const others = (meta.existing ?? []).filter((c) => c.chat !== meta.chat && c.id !== meta.focusId);
  const related = relatedCard(meta.text ?? "", others);
  const ok = results.every((r) => !r.is_error);
  return { blocks: [{ type: "text", text: replyText(meta, { linkedTo: ok ? related?.card : null }) }], stop: "end_turn" };
}

function writeScript(meta) {
  let input;
  if (meta.purpose === "refresh") input = refreshInput(meta);
  else if (meta.purpose === "synthesis") input = synthesisInput(meta);
  else
    input = {
      summary: cardSummary(meta.title ?? "Card", meta.question ?? ""),
      body: cardBody(meta.title ?? "Card", meta.question ?? "", meta.intent ?? ""),
    };
  return { blocks: [tool("write_card", input)], stop: "tool_use" };
}

// A follow-up where the model chooses: under 60 characters it answers in the
// thread (two sentences); otherwise it writes a new card (the branch output).
// A long follow-up ending in "?" gets a short preamble before write_card, so
// the engine's preamble buffering is exercised.
export function followupPath(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().length < 60 ? "thread" : "card";
}

export function followupHasPreamble(text) {
  return followupPath(text) === "card" && /\?\s*$/.test(String(text ?? ""));
}

export const FOLLOWUP_PREAMBLE = "That deserves a card of its own.";

function followupScript(meta, messages) {
  if (afterTools(messages)) return { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" };
  const blocks = [thinking("followup:" + meta.text)];
  if (followupPath(meta.text) === "thread") {
    blocks.push({ type: "text", text: branchInput(meta).body });
    return { blocks, stop: "end_turn" };
  }
  if (followupHasPreamble(meta.text)) blocks.push({ type: "text", text: FOLLOWUP_PREAMBLE });
  blocks.push(tool("write_card", branchInput(meta)));
  return { blocks, stop: "tool_use" };
}

export function mockScript(meta = {}, messages = []) {
  switch (meta.purpose) {
    case "turn":
      return answerScript(meta, messages, false);
    case "plan":
      return answerScript(meta, messages, true);
    case "reply":
      return replyScript(meta, messages);
    case "card":
    case "refresh":
    case "synthesis":
      return writeScript(meta);
    case "branch":
      if (afterTools(messages)) return { blocks: [{ type: "text", text: "Done." }], stop: "end_turn" };
      return { blocks: [thinking("branch:" + meta.text), tool("write_card", branchInput(meta))], stop: "tool_use" };
    case "followup":
      return followupScript(meta, messages);
    default:
      return { blocks: [{ type: "text", text: "Mock provider: unknown purpose." }], stop: "end_turn" };
  }
}

// ---------- wire format ----------

const KEY_ORDERS = [
  null, // as written
  (keys) => [...keys.filter((k) => k !== "key"), ...keys.filter((k) => k === "key")], // key last
  (keys) => {
    // summary (or intent) before title: the card opens a little after its first text
    const second = keys.includes("summary") ? "summary" : keys.includes("intent") ? "intent" : null;
    if (!second || !keys.includes("title")) return keys;
    const rest = keys.filter((k) => k !== second && k !== "title");
    return [second, "title", ...rest];
  },
];

// Tool input as the API might stream it: varying key order and spacing,
// sometimes with every non-ASCII character as a \uXXXX escape.
export function serializeInput(input, r) {
  const keys = Object.keys(input);
  const reorder = pick(r, KEY_ORDERS);
  const order = reorder ? reorder(keys) : keys;
  const spaced = r() < 0.5;
  const parts = order.map((k) => JSON.stringify(k) + (spaced ? ": " : ":") + JSON.stringify(input[k]));
  let json = "{" + (spaced ? " " : "") + parts.join(spaced ? ", " : ",") + (spaced ? " " : "") + "}";
  if (r() < 0.5) json = json.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return json;
}

function chunk(text, r, min, max) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const size = min + Math.floor(r() * (max - min + 1));
    out.push(text.slice(i, i + size));
    i += size;
  }
  return out;
}

export function createMockProvider({ speed = Number(process.env.MOCK_SPEED) || 1 } = {}) {
  const factor = speed > 0 ? speed : 1;
  let toolSeq = 0;
  return {
    name: "mock",
    model: "mock",

    async *stream({ messages = [], signal, meta = {} } = {}) {
      const script = mockScript(meta, messages);
      const r = rng(hash("chunks:" + JSON.stringify(script.blocks) + (meta.round ?? 1)));
      await sleep((60 + r() * 80) / factor, signal); // time to first token
      const content = [];
      for (const block of script.blocks) {
        if (block.type === "thinking") {
          content.push({ ...block });
          continue;
        }
        if (block.type === "text") {
          for (const piece of chunk(block.text, r, 2, 6)) {
            await sleep((10 + r() * 20) / factor, signal);
            yield { type: "text", text: piece };
          }
          content.push({ type: "text", text: block.text });
          continue;
        }
        const id = `toolu_mock_${++toolSeq}`;
        yield { type: "tool_start", id, name: block.name };
        for (const piece of chunk(serializeInput(block.input, r), r, 1, 8)) {
          await sleep((10 + r() * 20) / factor, signal);
          yield { type: "tool_delta", id, json: piece };
        }
        yield { type: "tool_end", id };
        content.push({ type: "tool_use", id, name: block.name, input: block.input });
      }
      yield { type: "stop", reason: script.stop, content };
    },
  };
}

export { VALID_RELS };
