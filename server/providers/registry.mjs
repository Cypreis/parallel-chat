// Provider registry: the three providers, their keys, cached model lists, the
// model last chosen for each, and which one is active.
//
// Keys, highest priority first: posted from the page (memory); .keys.json in
// the app folder (written only when the page asks to remember);
// environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, DEEPSEEK_API_KEY,
// DASHSCOPE_API_KEY with DASHSCOPE_REGION). A key is never logged, never
// returned (only its last four characters), and scrubbed from upstream errors.
//
// Startup calls no upstream API: a key from the file or the environment gives
// hasKey true with models null until the page asks for the list.
//
// With no key there is no active provider: acquire() then returns one whose
// every call fails with "add an API key", so the page can point to Settings.
//
// acquire() returns a provider bound to the active provider, model and key at
// that moment. The engine calls it once per generation, so switching provider
// only affects work started afterwards.
//
// DeepSeek and Qwen are only tested against a local fake server (see
// openai-compat.mjs).

import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../engine.mjs";
import { createAnthropicProvider, listAnthropicModels } from "./anthropic.mjs";
import {
  createOpenAICompatProvider,
  DEEPSEEK_BASE,
  isAuthError,
  listDeepSeekModels,
  listQwenModels,
  QWEN_REGIONS,
  scrub,
} from "./openai-compat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_KEYS_FILE = path.join(ROOT, ".keys.json");
export const PROVIDER_IDS = ["anthropic", "deepseek", "qwen"];
const LABELS = {
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  qwen: "Qwen (Alibaba Cloud Model Studio)",
};
const SHORT = { anthropic: "Anthropic", deepseek: "DeepSeek", qwen: "Qwen" };
const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

// Last four characters only; nothing for a key too short to hide the rest.
export function keyHint(key) {
  return typeof key === "string" && key.length >= 12 ? "…" + key.slice(-4) : null;
}

// https:, or http: on localhost / 127.0.0.1. Returns the URL without a trailing slash.
export function validateBaseURL(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new HttpError(400, "baseURL is not a valid URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local))) {
    throw new HttpError(400, "baseURL must use https: (http: only for localhost or 127.0.0.1)");
  }
  if (u.username || u.password) throw new HttpError(400, "baseURL must not contain credentials");
  if (u.search || u.hash) throw new HttpError(400, "baseURL must not have a query or fragment");
  return (u.origin + u.pathname).replace(/\/+$/, "");
}

const qwenRegion = (id) => QWEN_REGIONS.find((r) => r.id === id);

export const NO_KEY_MESSAGE = "No model is connected yet. Open Settings and add an API key for Anthropic, DeepSeek or Qwen.";

// What answers while no provider has a key: every call fails with NO_KEY_MESSAGE.
export function createUnconfiguredProvider() {
  return {
    name: "none",
    model: null,
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error(NO_KEY_MESSAGE);
    },
  };
}

export function createRegistry({
  env = process.env,
  keysFile = DEFAULT_KEYS_FILE,
  fallback = null, // the provider used while none has a key (tests pass a scripted one)
  endpoints = {}, // test hooks: { deepseek: baseURL, anthropic: baseURL }
  fetch: doFetch = globalThis.fetch,
  logger = console,
} = {}) {
  const fallbackProvider = fallback ?? createUnconfiguredProvider();
  const entries = {};
  for (const id of PROVIDER_IDS) {
    entries[id] = {
      page: null, // { apiKey, region, baseURL }
      file: null,
      env: null,
      forgotten: false, // DELETE also hides an environment key until restart
      models: null,
      modelsError: null,
      model: null,
      noThinkingField: new Set(), // qwen models that reject enable_thinking
    };
  }
  let active = { id: null, model: null };
  let sdkAvailable = null;
  const anthropicCache = new Map();

  // ---------- sources ----------

  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) {
    // The SDK resolves the environment itself, so the key is not passed on.
    entries.anthropic.env = { apiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN, fromEnv: true };
  }
  if (env.DEEPSEEK_API_KEY) entries.deepseek.env = { apiKey: env.DEEPSEEK_API_KEY };
  if (env.DASHSCOPE_API_KEY) {
    const region = qwenRegion(env.DASHSCOPE_REGION)?.baseURL ? env.DASHSCOPE_REGION : "intl";
    entries.qwen.env = { apiKey: env.DASHSCOPE_API_KEY, region, baseURL: null };
  }

  function readKeysFile() {
    if (!keysFile || !existsSync(keysFile)) return {};
    try {
      const data = JSON.parse(readFileSync(keysFile, "utf8"));
      return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
      logger.warn?.("[providers] .keys.json could not be read; ignoring it");
      return {};
    }
  }

  function writeKeysFile(data) {
    if (!keysFile) return;
    if (!Object.keys(data).length) {
      if (existsSync(keysFile)) unlinkSync(keysFile);
      return;
    }
    writeFileSync(keysFile, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(keysFile, 0o600);
    } catch {
      // best effort (Windows keeps only the read-only bit)
    }
  }

  for (const [id, saved] of Object.entries(readKeysFile())) {
    if (!entries[id] || typeof saved?.apiKey !== "string" || !saved.apiKey) continue;
    try {
      const baseURL = id === "qwen" && saved.baseURL ? validateBaseURL(saved.baseURL) : null;
      const region = id === "qwen" ? (baseURL ? "custom" : qwenRegion(saved.region)?.baseURL ? saved.region : "intl") : null;
      entries[id].file = { apiKey: saved.apiKey, region, baseURL };
    } catch {
      logger.warn?.(`[providers] ignoring the saved ${id} entry in .keys.json (bad baseURL)`);
    }
  }

  // The key in use for a provider: { apiKey, source, region, baseURL, fromEnv } or null.
  function current(id) {
    const e = entries[id];
    if (e.page) return { ...e.page, source: "page" };
    if (e.file) return { ...e.file, source: "file" };
    if (e.env && !e.forgotten) return { ...e.env, source: "env" };
    return null;
  }

  function allKeys() {
    const keys = [];
    for (const id of PROVIDER_IDS) for (const s of ["page", "file", "env"]) if (entries[id][s]?.apiKey) keys.push(entries[id][s].apiKey);
    return keys;
  }

  function qwenBase(cred) {
    return cred.region === "custom" ? cred.baseURL : qwenRegion(cred.region ?? "intl").baseURL;
  }

  function requireProvider(id) {
    if (!PROVIDER_IDS.includes(id)) throw new HttpError(404, `unknown provider ${id}`);
    return id;
  }

  async function sdkOK() {
    if (sdkAvailable === null) sdkAvailable = await import("@anthropic-ai/sdk").then(() => true, () => false);
    return sdkAvailable;
  }

  // ---------- views ----------

  function info(id) {
    const e = entries[id];
    const cred = current(id);
    return {
      id,
      label: LABELS[id],
      needsKey: true,
      hasKey: !!cred,
      keyHint: cred ? keyHint(cred.apiKey) : null,
      keySource: cred ? cred.source : null,
      remembered: !!e.file,
      regions: id === "qwen" ? QWEN_REGIONS.map(({ id: rid, label }) => ({ id: rid, label })) : null,
      region: id === "qwen" ? (cred?.region ?? null) : null,
      baseURL: id === "qwen" && cred?.region === "custom" ? cred.baseURL : null,
      models: e.models ? e.models.map((m) => ({ ...m })) : null,
      modelsError: e.modelsError,
      model: e.model,
    };
  }

  function list() {
    return { active: { provider: active.id, model: active.model }, providers: PROVIDER_IDS.map(info) };
  }

  // ---------- keys and models ----------

  async function fetchModels(id, cred) {
    const keyForCall = cred.fromEnv ? undefined : cred.apiKey;
    try {
      if (id === "deepseek") {
        try {
          const models = await listDeepSeekModels({ baseURL: endpoints.deepseek ?? DEEPSEEK_BASE, apiKey: cred.apiKey, fetch: doFetch });
          return { models, modelsError: null };
        } catch (err) {
          if (isAuthError(err)) throw err;
          return { models: null, modelsError: `${err.message}. Type a model id instead.` };
        }
      }
      if (id === "qwen") return await listQwenModels({ baseURL: qwenBase(cred), apiKey: cred.apiKey, fetch: doFetch });
      if (!(await sdkOK())) throw new HttpError(400, "The Anthropic SDK is not installed: run npm install in the app folder.");
      try {
        return { models: await listAnthropicModels({ apiKey: keyForCall, baseURL: endpoints.anthropic }), modelsError: null };
      } catch (err) {
        if (isAuthError(err)) throw err;
        return { models: null, modelsError: `${err.message}. Type a model id instead.` };
      }
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, scrub(err?.message ?? err, cred.apiKey, ...allKeys()));
    }
  }

  async function setKey(id, body) {
    requireProvider(id);
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) throw new HttpError(400, "apiKey is required");
    if (/\s/.test(apiKey)) throw new HttpError(400, "apiKey must not contain spaces");
    if (body.remember !== undefined && typeof body.remember !== "boolean") throw new HttpError(400, "remember must be true or false");
    let region = null;
    let baseURL = null;
    if (id === "qwen") {
      if (body.baseURL) {
        baseURL = validateBaseURL(body.baseURL);
        region = "custom";
      } else {
        region = body.region ?? entries.qwen.env?.region ?? "intl";
        if (region === "custom") throw new HttpError(400, "region custom needs a baseURL");
        if (!qwenRegion(region)?.baseURL) {
          throw new HttpError(400, `region must be one of: ${QWEN_REGIONS.map((r) => r.id).join(", ")}`);
        }
      }
    } else if (body.baseURL) {
      throw new HttpError(400, "baseURL is only used for qwen");
    } else if (body.region) {
      throw new HttpError(400, "region is only used for qwen");
    }

    const cred = { apiKey, region, baseURL };
    const { models, modelsError } = await fetchModels(id, cred); // throws 400 when the key is rejected; nothing stored

    const e = entries[id];
    e.page = cred;
    e.forgotten = false;
    e.models = models;
    e.modelsError = modelsError;
    const saved = readKeysFile();
    if (body.remember === true) {
      saved[id] = id === "qwen" ? { apiKey, region, ...(baseURL ? { baseURL } : {}) } : { apiKey };
      writeKeysFile(saved);
      e.file = { ...cred };
    } else if (saved[id] || e.file) {
      // Not remembered: an older saved key for this provider would surprise.
      delete saved[id];
      writeKeysFile(saved);
      e.file = null;
    }
    logger.log?.(`[providers] ${id}: key added from the page${body.remember ? " and saved to .keys.json" : ""}`);
    return info(id);
  }

  async function refreshModels(id) {
    requireProvider(id);
    const cred = current(id);
    if (!cred) throw new HttpError(400, `${SHORT[id]} has no API key`);
    const { models, modelsError } = await fetchModels(id, cred);
    entries[id].models = models;
    entries[id].modelsError = modelsError;
    return info(id);
  }

  function deleteKey(id) {
    requireProvider(id);
    const e = entries[id];
    e.page = null;
    if (e.file) {
      const saved = readKeysFile();
      delete saved[id];
      writeKeysFile(saved);
      e.file = null;
    }
    e.forgotten = true;
    e.models = null;
    e.modelsError = null;
    if (active.id === id) active = { id: null, model: null };
    logger.log?.(`[providers] ${id}: key removed`);
    return info(id);
  }

  // ---------- the active provider ----------

  // Validate a switch without applying it. Returns { id, model }.
  function check(id, model) {
    if (typeof id !== "string" || !PROVIDER_IDS.includes(id)) {
      throw new HttpError(400, `provider must be one of: ${PROVIDER_IDS.join(", ")}`);
    }
    if (!current(id)) throw new HttpError(400, `${SHORT[id]} has no API key; add one first`);
    if (id === "anthropic" && sdkAvailable === false) throw new HttpError(400, "The Anthropic SDK is not installed");
    if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new HttpError(400, "model must be a non-empty string");
    const chosen = model?.trim() || entries[id].model;
    if (!chosen) throw new HttpError(400, `model is required for ${SHORT[id]}`);
    return { id, model: chosen };
  }

  function activate({ id, model }) {
    active = { id, model };
    entries[id].model = model;
    logger.log?.(`[providers] active: ${id} (${model})`);
  }

  function activeConfig() {
    return { provider: active.id, model: active.model };
  }

  function anthropicFor(cred, model) {
    const cacheKey = `${cred.source}\u0000${cred.apiKey}\u0000${model}`;
    if (!anthropicCache.has(cacheKey)) {
      const p = createAnthropicProvider({ model, apiKey: cred.fromEnv ? undefined : cred.apiKey, baseURL: endpoints.anthropic });
      p.catch(() => anthropicCache.delete(cacheKey));
      anthropicCache.set(cacheKey, p);
    }
    return anthropicCache.get(cacheKey);
  }

  // A provider for one generation, bound to what is active right now.
  function acquire() {
    const { id, model } = active;
    const cred = id ? current(id) : null;
    if (!cred) return fallbackProvider;
    if (id === "anthropic") {
      return {
        name: "anthropic",
        model,
        async *stream(args) {
          const provider = await anthropicFor(cred, model);
          yield* provider.stream(args);
        },
      };
    }
    const e = entries[id];
    return createOpenAICompatProvider({
      id,
      label: SHORT[id],
      baseURL: id === "qwen" ? qwenBase(cred) : (endpoints.deepseek ?? DEEPSEEK_BASE),
      apiKey: cred.apiKey,
      model,
      maxOutput: e.models?.find((m) => m.id === model)?.maxOutput,
      noThinkingField: e.noThinkingField,
      fetch: doFetch,
    });
  }

  // Startup: Anthropic if its key is set and the SDK loads, else no provider yet. No upstream calls.
  async function init() {
    const present = PROVIDER_IDS.filter((id) => current(id)).map((id) => `${id} (${current(id).source})`);
    if (present.length) logger.log?.(`[providers] keys available: ${present.join(", ")}`);
    if (!current("anthropic")) {
      logger.log?.("[provider] none yet: add an API key in the app (Settings) or in .env");
      return;
    }
    if (!(await sdkOK())) {
      logger.log?.("[provider] none yet: an Anthropic key is set but @anthropic-ai/sdk could not be loaded (run npm install)");
      return;
    }
    activate({ id: "anthropic", model: env.PC_MODEL || ANTHROPIC_DEFAULT_MODEL });
    logger.log?.(`[provider] anthropic (${active.model})`);
  }

  return { init, list, info, setKey, refreshModels, deleteKey, check, activate, activeConfig, acquire, fallback: fallbackProvider };
}
