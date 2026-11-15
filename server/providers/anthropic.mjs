// Anthropic provider: one streamed Messages API call per stream() call,
// translated into the provider event stream the engine consumes:
//
//   { type: "text", text }
//   { type: "tool_start", id, name }
//   { type: "tool_delta", id, json }      raw partial_json fragments
//   { type: "tool_end", id }
//   { type: "stop", reason, content, message? }
//
// `content` is finalMessage().content, untouched, so the engine can append it
// to the conversation exactly as returned (thinking blocks included).
//
// Request shape, from the bundled claude-api skill: client.messages.stream()
// then finalMessage(); model claude-opus-5-5 (PC_MODEL overrides); max_tokens
// 64000; output_config.effort "medium"; no thinking parameter (always on for
// this model); tool_choice left at its default, auto (forcing a tool is a 400
// on this model); eager_input_streaming on every tool, so the client validates
// inputs (the engine does). Refusals are surfaced, not retried on a fallback
// model: see the round-2 report for why.
//
// Not exercised against the real API here (no key). It is exercised against a
// local server that speaks the documented SSE format (test/anthropic.test.mjs).

import { ToolInputParseError } from "./errors.mjs";
import { scrub } from "./openai-compat.mjs";

export { ToolInputParseError };

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

async function loadSDK() {
  const mod = await import("@anthropic-ai/sdk");
  return mod.default ?? mod.Anthropic;
}

// Model list through the SDK's models.list(), which auto-paginates when
// iterated (shared/models.md in the bundled claude-api skill: id,
// display_name, max_input_tokens, max_tokens). A rejected key throws an error
// whose status is 401 or 403; other failures throw with their status.
export async function listAnthropicModels({ apiKey, baseURL } = {}) {
  const Anthropic = await loadSDK();
  const options = { maxRetries: 1 };
  if (apiKey) options.apiKey = apiKey;
  if (baseURL) options.baseURL = baseURL;
  const client = new Anthropic(options);
  const models = [];
  try {
    for await (const m of client.models.list()) {
      const entry = { id: m.id, label: m.display_name || m.id };
      if (Number.isFinite(m.max_input_tokens)) entry.contextWindow = m.max_input_tokens;
      if (Number.isFinite(m.max_tokens)) entry.maxOutput = m.max_tokens;
      models.push(entry);
    }
  } catch (err) {
    const status = err?.status ?? 0;
    const e = new Error(
      status === 401 || status === 403
        ? "Anthropic API: authentication failed (check the API key)"
        : `Anthropic API error ${status || ""}: ${scrub(err?.message ?? err, apiKey)}`,
    );
    e.status = status;
    throw e;
  }
  return models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function untilAborted(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export async function createAnthropicProvider({ model = process.env.PC_MODEL || "claude-opus-5-5", apiKey, baseURL } = {}) {
  const Anthropic = await loadSDK();
  const options = {};
  if (apiKey) options.apiKey = apiKey;
  if (baseURL) options.baseURL = baseURL;
  // With no options this resolves ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.
  const client = new Anthropic(options);

  const is = (err, cls) => typeof cls === "function" && err instanceof cls;

  function describe(err) {
    const text = scrub(err?.message ?? err, apiKey);
    if (is(err, Anthropic.AuthenticationError)) return "Anthropic API: authentication failed (check the API key)";
    if (is(err, Anthropic.RateLimitError)) return "Anthropic API: rate limited, try again shortly";
    if (is(err, Anthropic.BadRequestError)) return `Anthropic API: bad request: ${text}`;
    if (is(err, Anthropic.APIError)) return `Anthropic API error ${err.status ?? ""}: ${text}`;
    return text;
  }

  function refusalMessage(message) {
    const d = message.stop_details;
    const category = d?.category ? ` (${d.category})` : "";
    return `The model declined this request${category}${d?.explanation ? `: ${d.explanation}` : "."}`;
  }

  return {
    name: "anthropic",
    model,

    async *stream({ system, cacheSystem = false, messages, tools = [], signal } = {}) {
      const params = {
        model,
        max_tokens: 64000,
        system: cacheSystem ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] : system,
        messages,
        output_config: { effort: "medium" },
      };
      if (tools.length) params.tools = tools.map((t) => ({ ...t, eager_input_streaming: true }));
      const stream = client.messages.stream(params, { signal });
      const it = stream[Symbol.asyncIterator]();
      const toolByIndex = new Map();
      let finished = false;
      try {
        while (true) {
          const { value: event, done } = await untilAborted(it.next(), signal);
          if (done) break;
          if (event.type === "content_block_start") {
            if (event.content_block?.type === "tool_use") {
              toolByIndex.set(event.index, event.content_block.id);
              yield { type: "tool_start", id: event.content_block.id, name: event.content_block.name };
            }
          } else if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
            else if (event.delta.type === "input_json_delta" && toolByIndex.has(event.index)) {
              yield { type: "tool_delta", id: toolByIndex.get(event.index), json: event.delta.partial_json };
            }
          } else if (event.type === "content_block_stop" && toolByIndex.has(event.index)) {
            yield { type: "tool_end", id: toolByIndex.get(event.index) };
          }
        }
        finished = true;
        const final = await untilAborted(stream.finalMessage(), signal);
        yield {
          type: "stop",
          reason: final.stop_reason,
          content: final.content,
          message: final.stop_reason === "refusal" ? refusalMessage(final) : undefined,
        };
      } catch (err) {
        if (signal?.aborted) throw abortError();
        if (is(err, Anthropic.APIError)) throw new Error(describe(err));
        // The SDK materializes each tool input at content_block_stop with a
        // tolerant partial-JSON parser, which throws SyntaxError only for input
        // it cannot parse at all; the stream re-raises it as an AnthropicError
        // whose cause is that SyntaxError. Only that case is retried.
        const parseError = err instanceof SyntaxError ? err : err?.cause instanceof SyntaxError ? err.cause : null;
        if (parseError) throw new ToolInputParseError(`The model's tool input could not be parsed: ${parseError.message}`);
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        if (!finished) Promise.resolve(it.return?.()).catch(() => {});
      }
    },
  };
}
