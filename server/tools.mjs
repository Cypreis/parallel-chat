// Tool definitions the model uses to build the board, and a small validator
// for their inputs. Inputs stream with eager_input_streaming, so the API does
// not validate them: every parsed input is checked here before it is acted on.

export const RELS = ["depends_on", "feeds", "contradicts", "alternative_to", "elaborates"];

const str = (description) => ({ type: "string", description });

const SUMMARY =
  "An index line, not shown to the reader: one sentence stating what the card concludes, so other parts of the conversation can recall the card without its full text.";
const BODY =
  "The card itself, in Markdown (math in LaTeX between $ or $$). The title is not printed on the card, so open with the substance, not a heading. Its length fits this card's own content: cards in one answer can differ a lot in length.";
const TITLE = "Two to five words naming the topic. Not printed on the card; it labels the card in lists and links.";

// Property order puts the title first so a card can open early. Nothing
// relies on the model keeping that order.
export const CREATE_CARD = {
  name: "create_card",
  description:
    "Create one card on the board for the question you are answering now. Call it once for each card the answer needs, up to the card limit in <board>, in the order a reader should read them (they are shown left to right), and before any link_cards call that refers to the card. The card appears as soon as its title is written and fills in while you write. Text outside tool calls is not shown, so start with this call.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      key: str("Your short name for this card within this answer, such as c1. link_cards uses it to refer to the card."),
      title: str(TITLE),
      summary: str(SUMMARY),
      body: str(BODY),
    },
    required: ["key", "title", "summary", "body"],
    additionalProperties: false,
  },
};

// Fan-out mode: the planner names each card and says what it must cover; a
// separate writer call per card writes the summary and body.
export const PLAN_CARD = {
  name: "create_card",
  description:
    "Plan one card on the board for the question you are answering now. Call it once for each card the answer needs, up to the card limit in <board>, in the order a reader should read them. A separate writer will write each card from the intent you give, at the same time as the others, so the intent must say exactly what this card covers, what it leaves to the other cards, and how long it should be.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      key: str("Your short name for this card within this answer, such as c1. link_cards uses it to refer to the card."),
      title: str(TITLE),
      intent: str("One or two sentences telling the writer what this card must cover, what form suits it (a couple of sentences, a list, a table, a formula, code) and roughly how long it should be. Cards may differ in length."),
    },
    required: ["key", "title", "intent"],
    additionalProperties: false,
  },
};

export const LINK_CARDS = {
  name: "link_cards",
  description:
    "Link two cards so the reader can move from one to the other. Each end is either a key you gave a card in this answer or the id of an existing card from <board>, which may be in any chat. Call it only for links that would help the reader; the system prompt says what each rel means.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      from: str("Key from this answer, or id of an existing card."),
      to: str("Key from this answer, or id of an existing card."),
      rel: { type: "string", enum: RELS, description: "How the first card relates to the second." },
    },
    required: ["from", "to", "rel"],
    additionalProperties: false,
  },
};

// One card whose title is already set: a fan-out writer, refresh, synthesis.
export const WRITE_CARD = {
  name: "write_card",
  description: "Write the one card the task asks for. Call it exactly once, with the summary first and then the body.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      summary: str(SUMMARY),
      body: str(BODY),
    },
    required: ["summary", "body"],
    additionalProperties: false,
  },
};

// A follow-up answered as a new card beside the card it was asked from.
export const WRITE_BRANCH_CARD = {
  name: "write_card",
  description:
    "Write the new card that answers the follow-up in <task>. Call it exactly once, title first. The title names the follow-up's topic; the body answers only the follow-up and does not restate the card it was asked from.",
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      title: str(TITLE),
      summary: str(SUMMARY),
      body: str(BODY),
    },
    required: ["title", "summary", "body"],
    additionalProperties: false,
  },
};

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// Validates against the subset of JSON Schema these tools use. Returns null
// when valid, otherwise a short message the model can act on.
export function validateInput(tool, input) {
  const schema = tool.input_schema;
  if (typeOf(input) !== "object") return `input must be a JSON object, got ${typeOf(input)}`;
  for (const name of schema.required ?? []) {
    if (!(name in input)) return `missing required field "${name}"`;
  }
  for (const [name, value] of Object.entries(input)) {
    const prop = schema.properties[name];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown field "${name}"`;
      continue;
    }
    if (prop.type && typeOf(value) !== prop.type) return `field "${name}" must be a ${prop.type}`;
    if (prop.enum && !prop.enum.includes(value)) return `field "${name}" must be one of: ${prop.enum.join(", ")}`;
  }
  return null;
}
