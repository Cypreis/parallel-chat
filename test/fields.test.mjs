import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesce, createFieldStreamer } from "../server/fields.mjs";

const FIELDS = { fields: ["key", "title", "summary", "body"], stream: ["summary", "body"] };

function feed(chunks, opts = FIELDS) {
  const s = createFieldStreamer(opts);
  const out = [];
  for (const c of chunks) out.push(...s.push(c));
  return coalesce(out);
}

function seeded(seed) {
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

function randomSplit(text, seed) {
  const r = seeded(seed);
  const chunks = [];
  for (let i = 0; i < text.length; ) {
    const n = 1 + Math.floor(r() * 9);
    chunks.push(text.slice(i, i + n));
    i += n;
  }
  return chunks;
}

const BODY = 'Line one\nquote: "x" and back\\slash, tab\there, slash → café 🚀 {braces} [and] , commas';
const SUMMARY = 'Short "summary" 😀.';

// Unknown keys with nested values (strings containing braces, quotes and
// escapes), body before title, mixed raw and escaped non-ASCII.
const DOC =
  '{ "note": {"a": [1, "}{\\"", {"b": null}], "c": "x\\\\"}, "body": ' +
  JSON.stringify(BODY).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) +
  ', "count": 3, "flag": true, "title": "Storage \\u0026 \\"logs\\"", "summary": ' +
  JSON.stringify(SUMMARY) +
  ', "key": "c1", "tail": [] }';

test("the fixture is valid JSON with the expected values", () => {
  const parsed = JSON.parse(DOC);
  assert.equal(parsed.body, BODY);
  assert.equal(parsed.summary, SUMMARY);
  assert.equal(parsed.title, 'Storage & "logs"');
});

test("extracts deltas and values, ignoring unknown keys and non-string values", () => {
  assert.deepEqual(feed([DOC]), [
    { type: "delta", field: "body", text: BODY },
    { type: "value", field: "body", value: BODY },
    { type: "value", field: "title", value: 'Storage & "logs"' },
    { type: "delta", field: "summary", text: SUMMARY },
    { type: "value", field: "summary", value: SUMMARY },
    { type: "value", field: "key", value: "c1" },
  ]);
});

test("whole, one character at a time, and random splits give the same result", () => {
  const whole = feed([DOC]);
  assert.deepEqual(feed([...DOC]), whole);
  for (let seed = 1; seed <= 60; seed++) assert.deepEqual(feed(randomSplit(DOC, seed)), whole, `seed ${seed}`);
});

test("a trailing backslash is held until the escape completes", () => {
  const s = createFieldStreamer(FIELDS);
  assert.deepEqual(s.push('{"body":"a\\'), [{ type: "delta", field: "body", text: "a" }]);
  assert.deepEqual(s.push('n'), [{ type: "delta", field: "body", text: "\n" }]);
  assert.deepEqual(s.push('\\'), []);
  assert.deepEqual(s.push('"b"'), [
    { type: "delta", field: "body", text: '"b' },
    { type: "value", field: "body", value: 'a\n"b' },
  ]);
});

test("\\uXXXX split at every position decodes the same", () => {
  const json = '{"body":"x\\u00e9y"}';
  const start = json.indexOf("\\u");
  for (let cut = start; cut <= start + 6; cut++) {
    const events = feed([json.slice(0, cut), json.slice(cut)]);
    assert.deepEqual(events, [
      { type: "delta", field: "body", text: "xéy" },
      { type: "value", field: "body", value: "xéy" },
    ]);
  }
});

test("surrogate pairs split anywhere are never emitted as a lone half", () => {
  const escaped = '{"body":"a\\ud83d\\ude80b"}';
  const raw = '{"body":"a🚀b"}';
  for (const json of [escaped, raw]) {
    for (let cut = 1; cut < json.length; cut++) {
      const s = createFieldStreamer(FIELDS);
      const first = s.push(json.slice(0, cut));
      const second = s.push(json.slice(cut));
      for (const e of [...first, ...second]) {
        if (e.type !== "delta") continue;
        const last = e.text.charCodeAt(e.text.length - 1);
        assert.ok(!(last >= 0xd800 && last <= 0xdbff), `lone high surrogate at cut ${cut}`);
        assert.ok(!(e.text.charCodeAt(0) >= 0xdc00 && e.text.charCodeAt(0) <= 0xdfff), `lone low surrogate at cut ${cut}`);
      }
      assert.deepEqual(coalesce([...first, ...second])[0], { type: "delta", field: "body", text: "a🚀b" });
    }
  }
  // A high surrogate escape not followed by a low one is kept, as JSON.parse keeps it.
  const lone = '{"body":"\\ud83dz"}';
  assert.equal(feed([...lone])[0].text, JSON.parse(lone).body);
});

test("the title is only reported once complete", () => {
  const s = createFieldStreamer(FIELDS);
  assert.deepEqual(s.push('{"key":"c1","title":"Sto'), [{ type: "value", field: "key", value: "c1" }]);
  assert.deepEqual(s.push('rage"'), [{ type: "value", field: "title", value: "Storage" }]);
  assert.equal(s.done, false);
  s.push("}");
  assert.equal(s.done, true);
});

test("a duplicated stream field is streamed only the first time", () => {
  const events = feed(['{"body":"one","body":"two"}']);
  assert.deepEqual(events, [
    { type: "delta", field: "body", text: "one" },
    { type: "value", field: "body", value: "one" },
    { type: "value", field: "body", value: "two" },
  ]);
});

test("text after the object closes is ignored", () => {
  assert.deepEqual(feed(['{"title":"A"} {"title":"B"}']), [{ type: "value", field: "title", value: "A" }]);
});
