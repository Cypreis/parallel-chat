// Incremental field streamer for one JSON object arriving in arbitrary chunks
// (a tool input streamed with eager_input_streaming).
//
//   const s = createFieldStreamer({ fields: ["key", "title", "summary", "body"], stream: ["summary", "body"] });
//   s.push('{"title":"Sto')   -> []
//   s.push('rage","body":"a\\') -> [{ type: "value", field: "title", value: "Storage" }, { type: "delta", field: "body", text: "a" }]
//
// Events:
//   { type: "delta", field, text }  decoded text of a `stream` field, as it arrives
//   { type: "value", field, value } a top-level string field in `fields`, once complete
//
// Only top-level string values are reported; unknown keys and non-string
// values (numbers, nested objects and arrays, including strings inside them)
// are skipped. Key order does not matter. JSON escapes are decoded across
// chunk boundaries: a trailing backslash, a \uXXXX split anywhere, and a
// surrogate pair split between or inside its two escapes. Text is only ever
// emitted once it is certain: an incomplete escape or a high surrogate waiting
// for its low half is held back, nothing else is. A stream field that occurs
// twice is streamed only the first time (its value event still fires).
//
// This is for live display. It is tolerant, not a validator: the caller still
// parses the complete input strictly and validates it before acting on it.

const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const isWs = (ch) => ch === " " || ch === "\n" || ch === "\r" || ch === "\t";
const isHigh = (code) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff;

export function createFieldStreamer({ fields = [], stream = [] } = {}) {
  const wanted = new Set([...fields, ...stream]);
  const streamed = new Set(stream);
  const seen = new Set();

  // start | key_or_end | key | colon | value | string | skip | after_value | done
  let state = "start";
  let key = "";
  let value = "";
  let target = "key"; // which string is being decoded: "key" or "value"
  let escape = false;
  let hex = null; // collected hex digits of a \u escape, or null
  let pendingHigh = ""; // a high surrogate waiting for its low half
  let field = null; // field whose value is being decoded (null: skip it)
  let streaming = false; // stream deltas for the current value
  let depth = 0; // nesting depth while skipping a non-string value
  let skipString = false;
  let skipEscape = false;
  let out = [];
  let deltaText = "";

  function flushDelta() {
    if (deltaText) {
      out.push({ type: "delta", field, text: deltaText });
      deltaText = "";
    }
  }

  function put(text) {
    if (target === "key") {
      key += text;
      return;
    }
    if (field === null) return;
    value += text;
    if (streaming) deltaText += text;
  }

  function decoded(ch) {
    const code = ch.charCodeAt(0);
    if (pendingHigh) {
      const high = pendingHigh;
      pendingHigh = "";
      if (isLow(code)) {
        put(high + ch);
        return;
      }
      put(high); // a lone high surrogate, as JSON.parse would keep it
    }
    if (isHigh(code)) pendingHigh = ch;
    else put(ch);
  }

  function endString() {
    if (pendingHigh) {
      put(pendingHigh);
      pendingHigh = "";
    }
    if (target === "key") {
      state = "colon";
      return;
    }
    if (field !== null) {
      flushDelta();
      out.push({ type: "value", field, value });
      seen.add(field);
    }
    state = "after_value";
  }

  // One character inside a string (key or value).
  function stringChar(ch) {
    if (hex !== null) {
      hex += ch;
      if (hex.length < 4) return;
      const digits = hex;
      hex = null;
      decoded(/^[0-9a-fA-F]{4}$/.test(digits) ? String.fromCharCode(parseInt(digits, 16)) : "�");
      return;
    }
    if (escape) {
      escape = false;
      if (ch === "u") hex = "";
      else decoded(ESCAPES[ch] ?? ch);
      return;
    }
    if (ch === "\\") escape = true;
    else if (ch === '"') endString();
    else decoded(ch);
  }

  function beginString(which) {
    target = which;
    escape = false;
    hex = null;
    pendingHigh = "";
    if (which === "key") key = "";
    else value = "";
    state = "string";
  }

  function step(ch) {
    switch (state) {
      case "start":
        if (ch === "{") state = "key_or_end";
        return;
      case "key_or_end":
        if (ch === '"') beginString("key");
        else if (ch === "}") state = "done";
        return; // whitespace and commas
      case "colon":
        if (ch === ":") state = "value";
        return;
      case "value":
        if (isWs(ch)) return;
        if (ch === '"') {
          field = wanted.has(key) ? key : null;
          streaming = field !== null && streamed.has(field) && !seen.has(field);
          beginString("value");
          return;
        }
        field = null;
        depth = 0;
        skipString = false;
        skipEscape = false;
        state = "skip";
        skip(ch);
        return;
      case "string":
        stringChar(ch);
        return;
      case "skip":
        skip(ch);
        return;
      case "after_value":
        if (ch === ",") state = "key_or_end";
        else if (ch === "}") state = "done";
        return;
      default:
        return; // done
    }
  }

  // Skip a non-string value, tracking nesting and strings inside it.
  function skip(ch) {
    if (skipString) {
      if (skipEscape) skipEscape = false;
      else if (ch === "\\") skipEscape = true;
      else if (ch === '"') skipString = false;
      return;
    }
    if (ch === '"') skipString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      if (depth === 0) state = "done"; // a primitive value closed by the object's "}"
      else if (--depth === 0) state = "after_value";
    } else if (ch === "," && depth === 0) state = "key_or_end";
  }

  function push(chunk) {
    out = [];
    const text = String(chunk ?? "");
    for (let i = 0; i < text.length; i++) {
      if (state === "done") break;
      step(text[i]);
    }
    if (state === "string" && target === "value") flushDelta();
    return out;
  }

  return {
    push,
    get done() {
      return state === "done";
    },
  };
}

// Merge adjacent deltas for the same field. Chunking changes how text splits
// across deltas but never the merged sequence.
export function coalesce(events) {
  const merged = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (e.type === "delta" && last?.type === "delta" && last.field === e.field) last.text += e.text;
    else merged.push({ ...e });
  }
  return merged;
}
