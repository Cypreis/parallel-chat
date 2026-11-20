// OpenAI-compatible chat provider, used for DeepSeek and Qwen (Alibaba Cloud
// Model Studio). Node's fetch, SSE parsed here, no dependency.
//
// ONLY TESTED AGAINST A LOCAL FAKE SERVER (test/providers.test.mjs). There is
// no DeepSeek or Qwen key on the machine this was written on, so no request
// has reached either real API. The wire details (endpoints, delta shapes,
// reasoning_content, the thinking switches, the model-list shapes) follow the
// providers' docs as summarised in the round-4 brief, fetched 2026-11-14.
//
// It emits the same provider event stream as the Anthropic provider:
//   { type: "text", text }
//   { type: "tool_start", id, name } / { type: "tool_delta", id, json } / { type: "tool_end", id }
//   { type: "stop", reason, content, message? }
// The engine keeps Anthropic-shaped messages; they are translated here, and
// stop.content is Anthropic-shaped so the engine can append it unchanged.

import { ToolInputParseError } from "./errors.mjs";
import { withRetry } from "./flow.mjs";

export const DEEPSEEK_BASE = "https://api.deepseek.com";
export const QWEN_REGIONS = [
  { id: "intl", label: "Singapore (international)", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  { id: "us", label: "US (Virginia)", baseURL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1" },
  { id: "cn", label: "China (Beijing)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "hk", label: "China (Hong Kong)", baseURL: "https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "custom", label: "Custom base URL", baseURL: null },
];

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// Remove a key from any text that could reach the page or a log.
export function scrub(text, ...keys) {
  let out = String(text ?? "");
  for (const key of keys) if (key && key.length >= 4) out = out.split(key).join("[redacted]");
  return out;
}

// An HTTP failure from the provider. `status` lets callers tell a rejected key
// from other failures; the message never contains the key.
export class ProviderHTTPError extends Error {
  constructor(label, status, upstream, apiKey) {
    const detail = scrub(upstream, apiKey);
    let message;
    if (status === 401 || status === 403) message = `${label} API: authentication failed (check the API key)`;
    else if (status === 429) message = `${label} API: rate limited, try again shortly`;
    else if (status === 402) message = `${label} API: insufficient balance`;
    else message = `${label} API error ${status}${detail ? `: ${detail}` : ""}`;
    super(message);
    this.name = "ProviderHTTPError";
    this.status = status;
    this.upstream = detail;
  }
}

// The upstream error text: error.message from a JSON body, else the start of the body.
export async function upstreamMessage(res) {
  const raw = await res.text().catch(() => "");
  try {
    const body = JSON.parse(raw);
    const msg = body?.error?.message ?? body?.message ?? body?.error ?? body?.msg;
    if (typeof msg === "string") return msg;
  } catch {
    // not JSON
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

// ---------- request translation: Anthropic-shaped -> OpenAI-shaped ----------

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(blocks) {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textOf(content);
  return JSON.stringify(content ?? "");
}

export function toOpenAIMessages(system, messages) {
  const out = [];
  const sys = typeof system === "string" ? system : textOf(blocksOf(system));
  if (sys) out.push({ role: "system", content: sys });
  for (const m of messages ?? []) {
    const blocks = blocksOf(m.content);
    if (m.role === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + resultText(b.content) });
      }
      const text = textOf(blocks);
      if (text) out.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: textOf(blocks) };
      const calls = blocks.filter((b) => b.type === "tool_use");
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      const reasoning = blocks
        .filter((b) => b.type === "thinking" && b.thinking)
        .map((b) => b.thinking)
        .join("\n\n");
      if (reasoning) msg.reasoning_content = reasoning;
      out.push(msg);
    } else if (m.role === "system") {
      const text = textOf(blocks);
      if (text) out.push({ role: "system", content: text });
    }
  }
  return out;
}

export function toOpenAITools(tools) {
  return (tools ?? []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// ---------- SSE ----------

// Yields the data payload of each server-sent event; bytes may split anywhere.
export async function* sseData(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let data = [];
  try {
    while (true) {
      if (signal?.aborted) throw abortError();
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    buf += decoder.decode();
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
    if (data.length) yield data.join("\n");
  } finally {
    reader.releaseLock?.();
  }
}

// ---------- the provider ----------

/**
 * @param {object} o
 * @param {"deepseek"|"qwen"} o.id
 * @param {string} o.label      display name used in error messages
 * @param {string} o.baseURL    e.g. https://api.deepseek.com
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {number} [o.maxOutput]  from the model list; max_tokens is min(16000, maxOutput)
 * @param {Set<string>} [o.noThinkingField]  qwen models that reject enable_thinking (shared, remembered)
 */
export function createOpenAICompatProvider({ id, label, baseURL, apiKey, model, maxOutput, noThinkingField = new Set(), headers = {}, retries = 0, fetch: doFetch = globalThis.fetch }) {
  const url = baseURL.replace(/\/+$/, "") + "/chat/completions";
  let generated = 0;

  function requestBody(system, messages, tools, { thinkingField }) {
    const body = { model, messages: toOpenAIMessages(system, messages), stream: true };
    if (tools?.length) body.tools = toOpenAITools(tools);
    if (Number.isFinite(maxOutput) && maxOutput > 0) body.max_tokens = Math.min(16000, maxOutput);
    // Thinking off: history is rebuilt without earlier reasoning, and a tools
    // request missing it is rejected (DeepSeek answers 400).
    if (id === "deepseek") body.thinking = { type: "disabled" };
    if (id === "qwen" && thinkingField) body.enable_thinking = false;
    return body;
  }

  async function post(body, signal) {
    try {
      const payload = JSON.stringify(body);
      return await withRetry(
        () => doFetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${apiKey}`, ...headers }, body: payload, signal }),
        { retries, signal },
      );
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw new Error(`${label} API: could not connect: ${scrub(err?.cause?.message ?? err?.message ?? err, apiKey)}`);
    }
  }

  return {
    name: id,
    model,

    async *stream({ system, messages, tools = [], signal } = {}) {
      let thinkingField = id === "qwen" && !noThinkingField.has(model);
      let res = await post(requestBody(system, messages, tools, { thinkingField }), signal);
      if (res.status === 400 && thinkingField) {
        const msg = await upstreamMessage(res);
        if (/enable_thinking|thinking/i.test(msg)) {
          // Some Qwen models only run with thinking on: retry once without the field, and remember.
          noThinkingField.add(model);
          thinkingField = false;
          res = await post(requestBody(system, messages, tools, { thinkingField }), signal);
        } else throw new ProviderHTTPError(label, 400, msg, apiKey);
      }
      if (!res.ok) throw new ProviderHTTPError(label, res.status, await upstreamMessage(res), apiKey);

      let text = "";
      let reasoning = "";
      const calls = new Map(); // index -> call
      const order = [];
      let finish = null;
      let sawDone = false;

      const start = (call) => {
        if (call.started) return [];
        call.started = true;
        if (!call.id) call.id = `call_gen_${++generated}`;
        const out = [{ type: "tool_start", id: call.id, name: call.name }];
        if (call.pending) out.push({ type: "tool_delta", id: call.id, json: call.pending });
        call.pending = "";
        return out;
      };
      const endAll = () => {
        const out = [];
        for (const call of order) {
          if (call.ended) continue;
          out.push(...start(call));
          call.ended = true;
          out.push({ type: "tool_end", id: call.id });
        }
        return out;
      };

      try {
        for await (const data of sseData(res.body, signal)) {
          if (data.trim() === "[DONE]") {
            sawDone = true;
            break;
          }
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue; // keep-alive or junk line
          }
          if (chunk?.error) throw new Error(`${label} API error: ${scrub(chunk.error.message ?? JSON.stringify(chunk.error), apiKey)}`);
          const choice = chunk?.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
          if (typeof delta.content === "string" && delta.content) {
            text += delta.content;
            yield { type: "text", text: delta.content };
          }
          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            let call = calls.get(index);
            if (!call) {
              // A new index: earlier calls are complete enough to announce.
              for (const prev of order) if (!prev.started && prev.name) yield* start(prev);
              call = { id: "", name: "", args: "", pending: "", started: false, ended: false };
              calls.set(index, call);
              order.push(call);
            }
            if (tc.id && !call.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            const frag = tc.function?.arguments;
            if (typeof frag === "string" && frag) {
              call.args += frag;
              // The name is known once arguments begin.
              if (!call.started && call.name) {
                call.pending += frag;
                yield* start(call);
              } else if (call.started) yield { type: "tool_delta", id: call.id, json: frag };
              else call.pending += frag;
            }
          }
          if (choice.finish_reason) {
            finish = choice.finish_reason;
            yield* endAll();
          }
        }
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") throw abortError();
        throw err;
      }
      if (signal?.aborted) throw abortError();
      if (!finish && !sawDone) throw new Error(`${label} API: the stream ended before the response finished.`);
      yield* endAll();

      let reason;
      let message;
      if (finish === "length") reason = "max_tokens";
      else if (finish === "content_filter") {
        reason = "refusal";
        message = `${label} stopped this response with its content filter.`;
      } else if (finish === "tool_calls" || finish === "stop" || finish === null) reason = order.length ? "tool_use" : "end_turn";
      else throw new Error(`${label} API: the response stopped early (${finish}).`);

      const content = [];
      if (reasoning) content.push({ type: "thinking", thinking: reasoning });
      if (text) content.push({ type: "text", text });
      for (const call of order) {
        let input = {};
        if (call.args.trim()) {
          try {
            input = JSON.parse(call.args);
          } catch (err) {
            if (reason === "tool_use") throw new ToolInputParseError(`The model's tool input could not be parsed: ${err.message}`);
          }
        }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      yield { type: "stop", reason, content, message };
    },
  };
}

// ---------- model lists ----------

const sortById = (models) => models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function cleanModel({ id, label, contextWindow, maxOutput }) {
  const m = { id: String(id), label: typeof label === "string" && label.trim() ? label.trim() : String(id) };
  if (Number.isFinite(contextWindow)) m.contextWindow = contextWindow;
  if (Number.isFinite(maxOutput)) m.maxOutput = maxOutput;
  return m;
}

async function getJSON(doFetch, url, apiKey, label) {
  let res;
  try {
    res = await doFetch(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
  } catch (err) {
    const e = new Error(`${label} API: could not connect: ${scrub(err?.cause?.message ?? err?.message ?? err, apiKey)}`);
    e.status = 0;
    throw e;
  }
  if (!res.ok) throw new ProviderHTTPError(label, res.status, await upstreamMessage(res), apiKey);
  try {
    return await res.json();
  } catch {
    const e = new Error(`${label} API: the model list was not JSON`);
    e.status = 200;
    e.shape = true;
    throw e;
  }
}

function openAIList(body) {
  if (!Array.isArray(body?.data)) return null;
  return body.data
    .filter((m) => m && typeof m.id === "string")
    .map((m) =>
      cleanModel({
        id: m.id,
        label: m.name ?? m.display_name,
        contextWindow: m.context_window ?? m.context_length,
        maxOutput: m.max_output_tokens,
      }),
    );
}

export const isAuthError = (err) => err?.status === 401 || err?.status === 403;

// DeepSeek: GET {base}/models.
export async function listDeepSeekModels({ baseURL = DEEPSEEK_BASE, apiKey, fetch: doFetch = globalThis.fetch }) {
  const body = await getJSON(doFetch, baseURL.replace(/\/+$/, "") + "/models", apiKey, "DeepSeek");
  const models = openAIList(body);
  if (!models) throw new Error("DeepSeek API: unexpected model list shape");
  return sortById(models);
}

// Other OpenAI-compatible services: the same chat/completions streaming as
// DeepSeek, so one table is all each needs (base URL, where its key lives).
// UNTESTED against the real services (no keys here); only against the local fake.
// `strip` removes a prefix from listed model ids (Gemini lists "models/…").
// `custom`: the person gives the base URL (a local model server), and a key is optional.
export const COMPAT_PROVIDERS = {
  openai: { label: "OpenAI", base: "https://api.openai.com/v1", env: ["OPENAI_API_KEY"], keys: "platform.openai.com/api-keys" },
  gemini: { label: "Google Gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", env: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], strip: "models/", keys: "aistudio.google.com/apikey" },
  xai: { label: "xAI (Grok)", base: "https://api.x.ai/v1", env: ["XAI_API_KEY"], keys: "console.x.ai" },
  mistral: { label: "Mistral", base: "https://api.mistral.ai/v1", env: ["MISTRAL_API_KEY"], keys: "console.mistral.ai/api-keys" },
  groq: { label: "Groq", base: "https://api.groq.com/openai/v1", env: ["GROQ_API_KEY"], keys: "console.groq.com/keys" },
  openrouter: { label: "OpenRouter", base: "https://openrouter.ai/api/v1", env: ["OPENROUTER_API_KEY"], keys: "openrouter.ai/keys" },
  together: { label: "Together AI", base: "https://api.together.xyz/v1", env: ["TOGETHER_API_KEY"], keys: "api.together.ai/settings/api-keys" },
  huggingface: { label: "Hugging Face", base: "https://router.huggingface.co/v1", env: ["HF_TOKEN", "HUGGINGFACE_API_KEY"], keys: "huggingface.co/settings/tokens" },
  local: { label: "Local model (Ollama, LM Studio, llama.cpp…)", short: "Local", base: null, defaultBase: "http://localhost:11434/v1", env: [], envBase: "LOCAL_LLM_URL", custom: true },
};

// Not for chat: embeddings, speech, images, moderation.
const NOT_CHAT = /embed|whisper|tts|transcri|dall-e|moderation|image|audio|realtime|rerank|guard|^sora|-vision-preview$/i;

// GET {base}/models: an OpenAI-style { data: [...] }, or a bare array (Together).
export async function listCompatModels({ baseURL, apiKey, label, strip = "", fetch: doFetch = globalThis.fetch }) {
  const body = await getJSON(doFetch, baseURL.replace(/\/+$/, "") + "/models", apiKey, label);
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!rows) throw new Error(`${label} API: unexpected model list shape`);
  const seen = new Set();
  const models = [];
  for (const m of rows) {
    let id = typeof m === "string" ? m : m?.id ?? m?.name ?? m?.model;
    if (typeof id !== "string" || !id) continue;
    if (strip && id.startsWith(strip)) id = id.slice(strip.length);
    if (seen.has(id) || NOT_CHAT.test(id)) continue;
    if (m && typeof m === "object" && m.type && !/^(chat|language|text)$/i.test(String(m.type))) continue; // Together: type "image", "embedding"…
    seen.add(id);
    const nice = m && typeof m === "object" ? m.display_name ?? m.name : undefined;
    models.push(cleanModel({ id, label: nice && nice !== id && nice !== m.id ? nice : undefined, contextWindow: m?.context_window ?? m?.context_length, maxOutput: m?.max_output_tokens }));
  }
  return sortById(models);
}

// OpenCode (opencode.ai, the Console / Zen gateway): one API key for many
// models. Every text model is reachable through the OpenAI-compatible
// chat/completions endpoint (the gateway translates), so this provider uses
// it for all of them. From opencode.ai/docs/zen, fetched 2026-11-20.
// UNTESTED against the real gateway (no key here); only against the local fake.
export const OPENCODE_BASE = "https://opencode.ai/inference/openai/v1";
export const OPENCODE_MODELS_URL = "https://opencode.ai/inference/v1/models";
// OpenCode Go (the subscription): the same gateway under /go.
export const OPENCODE_GO_BASE = "https://opencode.ai/inference/go/openai/v1";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/inference/go/v1/models";

// Free models are served only to the OpenCode app itself.
const OPENCODE_FREE = /(^|-)free$/i;

// OpenCode (Zen) and OpenCode Go: GET {models url}, an OpenAI-style list whose
// entries also carry `type` (chat, image, embedding…) and `limit` { context,
// output }. Only chat models are listed. Every chat model answers on the
// OpenAI-compatible chat/completions endpoint (the gateway translates), so
// that is what the provider calls whatever a model's own API is.
export async function listOpenCodeModels({ modelsURL = OPENCODE_MODELS_URL, apiKey, label = "OpenCode", fetch: doFetch = globalThis.fetch }) {
  const body = await getJSON(doFetch, modelsURL, apiKey, label);
  if (!Array.isArray(body?.data)) throw new Error(`${label} API: unexpected model list shape`);
  const models = body.data
    .filter((m) => m && typeof m.id === "string" && (m.type === undefined || m.type === "chat") && !OPENCODE_FREE.test(m.id))
    .map((m) => cleanModel({ id: m.id, label: m.name, contextWindow: m.limit?.context, maxOutput: m.limit?.output }));
  return sortById(models);
}

// Qwen: GET {origin}/api/v1/models (paged); then GET {base}/models (OpenAI
// shape); then, if both fail for a reason other than a rejected key, validate
// the key with a one-token chat request. Returns { models, modelsError }.
// Throws a ProviderHTTPError with status 401/403 when the key is rejected.
export async function listQwenModels({ baseURL, apiKey, fetch: doFetch = globalThis.fetch }) {
  const base = baseURL.replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const problems = [];

  try {
    const all = [];
    for (let page = 1; page <= 10; page++) {
      const body = await getJSON(doFetch, `${origin}/api/v1/models?page_no=${page}&page_size=100`, apiKey, "Qwen");
      const out = body?.output;
      if (!out || !Array.isArray(out.models)) {
        const e = new Error("unexpected shape from /api/v1/models");
        e.shape = true;
        throw e;
      }
      all.push(...out.models);
      const total = Number(out.total);
      if (!out.models.length || !Number.isFinite(total) || all.length >= total) break;
    }
    const usable = all.filter((m) => m && typeof m.model === "string");
    const withTools = usable.filter((m) => !Array.isArray(m.features) || m.features.includes("function-calling"));
    const chosen = withTools.length ? withTools : usable;
    return {
      models: sortById(
        chosen.map((m) =>
          cleanModel({
            id: m.model,
            label: m.name,
            contextWindow: m.model_info?.context_window,
            maxOutput: m.model_info?.max_output_tokens,
          }),
        ),
      ),
      modelsError: null,
    };
  } catch (err) {
    if (isAuthError(err)) throw err;
    problems.push(`/api/v1/models: ${err.message}`);
  }

  try {
    const models = openAIList(await getJSON(doFetch, `${base}/models`, apiKey, "Qwen"));
    if (!models) throw new Error("unexpected shape from /models");
    return { models: sortById(models), modelsError: null };
  } catch (err) {
    if (isAuthError(err)) throw err;
    problems.push(`/models: ${err.message}`);
  }

  // Neither list answered: check the key with a one-token request instead.
  let res;
  try {
    res = await doFetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "qwen-plus", messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
    });
  } catch {
    res = null; // unreachable: accepted, the list error says why
  }
  if (res && (res.status === 401 || res.status === 403)) {
    throw new ProviderHTTPError("Qwen", res.status, await upstreamMessage(res), apiKey);
  }
  await res?.body?.cancel?.().catch(() => {});
  return {
    models: null,
    modelsError: scrub(`The model list could not be fetched (${problems.join("; ")}). Type a model id instead.`, apiKey),
  };
}
