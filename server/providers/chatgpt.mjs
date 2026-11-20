// ChatGPT provider: "Sign in with ChatGPT" (OAuth 2.0 + PKCE), then the
// models of the user's ChatGPT plan (Plus, Pro, Business…) through the Codex
// backend, with no API key and no per-token billing.
//
// This is the sign-in the official Codex CLI uses, and the one OpenCode's
// ChatGPT plugins use: the same public client id, the same redirect address
// (http://localhost:1455/auth/callback, the only one registered for that
// client) and the same backend (chatgpt.com/backend-api/codex/responses,
// the Responses API with store: false). Details from the Codex CLI sources as
// mirrored by numman-ali/opencode-openai-codex-auth, fetched 2026-11-20.
//
// UNTESTED AGAINST THE REAL SERVICE: no ChatGPT account was signed in where
// this was written. It is exercised against a local fake of the auth server
// and of the backend (test/chatgpt.test.mjs). Known risks:
//   - the backend has rejected `instructions` that are not Codex's own prompt
//     in the past; a 400 about instructions is retried once with Codex's prompt
//     (fetched from github.com/openai/codex) and our system prompt sent as a
//     developer message instead;
//   - chatgpt.com sits behind bot protection, which can answer 403 with an
//     HTML page; that is reported as such, not as a bad sign-in;
//   - OpenAI meant this for personal use with your own subscription.
//
// The provider emits the engine's provider event stream (see anthropic.mjs):
//   { type: "text" } / { type: "tool_start" | "tool_delta" | "tool_end" } / { type: "stop" }

import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { ToolInputParseError } from "./errors.mjs";
import { scrub, sseData, upstreamMessage } from "./openai-compat.mjs";

export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_API_BASE = "https://chatgpt.com/backend-api/codex";
export const CHATGPT_CALLBACK_PORT = 1455;
const CALLBACK_PATH = "/auth/callback";
const SCOPE = "openid profile email offline_access";
const AUTH_CLAIM = "https://api.openai.com/auth";
const PROFILE_CLAIM = "https://api.openai.com/profile";
const ORIGINATOR = "codex_cli_rs";
const CLIENT_VERSION = "1.0.0";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

// When the plan's model list cannot be fetched. Any other id can be typed.
export const CHATGPT_FALLBACK_MODELS = [
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
];

function abortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

// ---------- tokens ----------

export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function decodeJwt(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" ? payload : null;
  } catch {
    return null;
  }
}

// What the tokens say about the account: { accountId, email, plan, exp }.
export function describeTokens({ accessToken, idToken }) {
  const a = decodeJwt(accessToken) ?? {};
  const i = decodeJwt(idToken) ?? {};
  const auth = a[AUTH_CLAIM] ?? i[AUTH_CLAIM] ?? {};
  return {
    accountId: typeof auth.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null,
    plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : null,
    email: typeof i.email === "string" ? i.email : typeof a[PROFILE_CLAIM]?.email === "string" ? a[PROFILE_CLAIM].email : null,
    exp: Number.isFinite(a.exp) ? a.exp * 1000 : null,
  };
}

// The stored form of a sign-in. `previous` fills what a refresh leaves out.
export function toCredential(body, previous = null) {
  const accessToken = body.access_token;
  const refreshToken = body.refresh_token || previous?.refreshToken || null;
  const idToken = body.id_token || previous?.idToken || null;
  const d = describeTokens({ accessToken, idToken });
  const expiresAt = Number.isFinite(body.expires_in) ? Date.now() + body.expires_in * 1000 : (d.exp ?? Date.now() + 3600 * 1000);
  return {
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    accountId: d.accountId ?? previous?.accountId ?? null,
    email: d.email ?? previous?.email ?? null,
    plan: d.plan ?? previous?.plan ?? null,
  };
}

// A credential read back from .keys.json, or null when it is unusable.
export function readCredential(saved) {
  if (!saved || typeof saved !== "object") return null;
  const { accessToken, refreshToken } = saved;
  if (typeof refreshToken !== "string" || !refreshToken) return null;
  const str = (v) => (typeof v === "string" && v ? v : null);
  return {
    accessToken: str(accessToken),
    refreshToken,
    idToken: str(saved.idToken),
    expiresAt: Number.isFinite(saved.expiresAt) ? saved.expiresAt : 0,
    accountId: str(saved.accountId),
    email: str(saved.email),
    plan: str(saved.plan),
  };
}

export const credentialSecrets = (c) => (c ? [c.accessToken, c.refreshToken, c.idToken].filter(Boolean) : []);

export class ChatGPTAuthError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ChatGPTAuthError";
    this.status = status;
  }
}

async function tokenRequest(doFetch, issuer, params, secrets = []) {
  let res;
  try {
    res = await doFetch(new URL("/oauth/token", issuer), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
  } catch (err) {
    throw new ChatGPTAuthError(`ChatGPT sign-in: could not reach ${new URL(issuer).host}: ${scrub(err?.cause?.message ?? err?.message ?? err, ...secrets)}`);
  }
  const raw = await res.text().catch(() => "");
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const detail = body?.error_description ?? body?.error?.message ?? (typeof body?.error === "string" ? body.error : raw.replace(/\s+/g, " ").slice(0, 200));
    throw new ChatGPTAuthError(`ChatGPT sign-in failed (${res.status})${detail ? `: ${scrub(detail, ...secrets)}` : ""}`, res.status);
  }
  if (typeof body?.access_token !== "string" || !body.access_token) throw new ChatGPTAuthError("ChatGPT sign-in: the token response had no access token");
  return body;
}

export async function exchangeCode({ code, verifier, redirectURI, issuer = CHATGPT_ISSUER, fetch: doFetch = globalThis.fetch }) {
  const body = await tokenRequest(doFetch, issuer, {
    grant_type: "authorization_code",
    client_id: CHATGPT_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: redirectURI,
  }, [code, verifier]);
  return toCredential(body);
}

export async function refreshCredential(cred, { issuer = CHATGPT_ISSUER, fetch: doFetch = globalThis.fetch } = {}) {
  if (!cred?.refreshToken) throw new ChatGPTAuthError("ChatGPT: signed out. Sign in again in Settings.", 401);
  const body = await tokenRequest(doFetch, issuer, {
    grant_type: "refresh_token",
    refresh_token: cred.refreshToken,
    client_id: CHATGPT_CLIENT_ID,
  }, credentialSecrets(cred));
  return toCredential(body, cred);
}

export function authorizeURL({ issuer = CHATGPT_ISSUER, redirectURI, state, challenge }) {
  const u = new URL("/oauth/authorize", issuer);
  const params = {
    response_type: "code",
    client_id: CHATGPT_CLIENT_ID,
    redirect_uri: redirectURI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: ORIGINATOR,
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

// ---------- the sign-in flow ----------

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, text, appURL) {
  const back = appURL ? `<p><a href="${escapeHTML(appURL)}">Back to Parallel chat</a></p>` : "";
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHTML(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fafafa}@media(prefers-color-scheme:dark){body{color:#eee;background:#181818}a{color:#8ab4ff}}</style>
<h1>${escapeHTML(title)}</h1><p>${escapeHTML(text)}</p>${back}`;
}

// The code and state from what the user pasted: the whole address the browser
// ended on, its query string, or the bare code.
export function parseCallbackInput(input) {
  const text = String(input ?? "").trim();
  if (!text) return null;
  let params = null;
  if (/^https?:\/\//i.test(text)) {
    try {
      params = new URL(text).searchParams;
    } catch {
      return null;
    }
  } else if (text.includes("code=")) {
    params = new URLSearchParams(text.replace(/^[?#]/, ""));
  } else if (/^[\w.~-]+$/.test(text)) {
    return { code: text, state: null, error: null };
  } else return null;
  const error = params.get("error");
  if (error) return { code: null, state: params.get("state"), error: params.get("error_description") || error };
  const code = params.get("code");
  return code ? { code, state: params.get("state"), error: null } : null;
}

/**
 * One sign-in at a time. start() opens a listener on localhost:1455 for the
 * redirect and returns the address to open; the user can also paste the
 * address the browser ended on (complete()), for when that port is taken
 * (Codex CLI signing in at the same moment) or the browser is elsewhere.
 *
 * @param {object} o
 * @param {(cred, { remember }) => void | Promise<void>} o.onSuccess
 */
export function createChatGPTLogin({
  issuer = CHATGPT_ISSUER,
  port = CHATGPT_CALLBACK_PORT, // tests pass 0
  fetch: doFetch = globalThis.fetch,
  logger = console,
  onSuccess,
  timeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  let pending = null;
  let lastError = null;

  function status() {
    return {
      pending: !!pending,
      url: pending?.url ?? null,
      callback: pending ? pending.listening : false,
      error: lastError,
    };
  }

  function stop() {
    if (!pending) return;
    clearTimeout(pending.timer);
    for (const s of pending.servers) {
      // Let a page being sent (the "Signed in" one) finish, then drop the rest.
      s.close();
      s.closeIdleConnections?.();
      setTimeout(() => s.closeAllConnections?.(), 1000).unref?.();
    }
    pending = null;
  }

  function cancel() {
    stop();
    lastError = null;
  }

  async function finish(flow, { code, state, error }) {
    if (flow !== pending) throw new ChatGPTAuthError("This sign-in has ended. Start it again from Settings.", 400);
    if (error) {
      stop();
      lastError = `ChatGPT sign-in was not completed: ${error}`;
      throw new ChatGPTAuthError(lastError, 400);
    }
    if (state !== null && state !== flow.state) throw new ChatGPTAuthError("That address belongs to a different sign-in. Start again and paste the newest one.", 400);
    if (flow.completing) return flow.completing;
    flow.completing = (async () => {
      try {
        const cred = await exchangeCode({ code, verifier: flow.verifier, redirectURI: flow.redirectURI, issuer, fetch: doFetch });
        if (!cred.accountId) logger.warn?.("[chatgpt] the sign-in tokens carry no ChatGPT account id; requests may be refused");
        await onSuccess?.(cred, { remember: flow.remember });
        if (pending === flow) stop();
        lastError = null;
        return cred;
      } catch (err) {
        flow.completing = null;
        if (pending === flow) stop();
        lastError = err.message;
        throw err;
      }
    })();
    return flow.completing;
  }

  function handler(flow, appURL) {
    return async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      const send = (status, title, text) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
        res.end(page(title, text, appURL));
      };
      if (url.pathname !== CALLBACK_PATH) return send(404, "Not found", "This address only receives the ChatGPT sign-in.");
      const parsed = parseCallbackInput(url.toString());
      if (!parsed) return send(400, "Sign-in failed", "The address had no sign-in code. Start again from Settings.");
      if (parsed.state !== flow.state) return send(400, "Sign-in failed", "This sign-in does not match the one Parallel chat started. Start again from Settings.");
      try {
        const cred = await finish(flow, parsed);
        send(200, "Signed in to ChatGPT", `${cred.email ? `Signed in as ${cred.email}. ` : ""}You can close this tab and go back to Parallel chat.`);
      } catch (err) {
        send(400, "Sign-in failed", err.message);
      }
    };
  }

  function listen(server, host) {
    return new Promise((resolve) => {
      const onError = (err) => resolve({ ok: false, err });
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve({ ok: true });
      });
    });
  }

  async function start({ remember = false, appURL = null } = {}) {
    stop();
    lastError = null;
    const { verifier, challenge } = createPkce();
    const state = randomBytes(24).toString("base64url");
    const flow = { state, verifier, remember: !!remember, servers: [], listening: false, completing: null, redirectURI: "", url: "", timer: null };

    // IPv4 first; also IPv6 loopback, since "localhost" may resolve to ::1.
    const v4 = http.createServer(handler(flow, appURL));
    const r4 = await listen(v4, "127.0.0.1");
    let actualPort = port;
    if (r4.ok) {
      flow.servers.push(v4);
      flow.listening = true;
      actualPort = v4.address().port;
      if (port !== 0) {
        const v6 = http.createServer(handler(flow, appURL));
        if ((await listen(v6, "::1")).ok) flow.servers.push(v6);
      }
    } else {
      logger.log?.(`[chatgpt] port ${port} is busy (${r4.err?.code ?? r4.err?.message}); waiting for a pasted address instead`);
    }
    flow.redirectURI = `http://localhost:${actualPort}${CALLBACK_PATH}`;
    flow.url = authorizeURL({ issuer, redirectURI: flow.redirectURI, state, challenge });
    flow.timer = setTimeout(() => {
      if (pending !== flow) return;
      stop();
      lastError = "The ChatGPT sign-in timed out. Start it again from Settings.";
    }, timeoutMs);
    flow.timer.unref?.();
    pending = flow;
    logger.log?.("[chatgpt] sign-in started");
    return status();
  }

  async function complete(input) {
    if (!pending) throw new ChatGPTAuthError("No ChatGPT sign-in is in progress. Start one from Settings.", 400);
    const parsed = parseCallbackInput(input);
    if (!parsed) throw new ChatGPTAuthError("Paste the whole address from the browser bar (it starts with http://localhost:1455/auth/callback?code=…).", 400);
    return finish(pending, parsed);
  }

  return { start, complete, cancel, status, close: stop };
}

// ---------- request translation: Anthropic-shaped -> Responses input ----------

function blocksOf(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

const textOf = (blocks) =>
  blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n");

function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return textOf(content);
  return JSON.stringify(content ?? "");
}

export const systemText = (system) => (typeof system === "string" ? system : textOf(blocksOf(system)));

// Thinking blocks are left out: with store: false nothing refers back to them.
export function toResponsesInput(messages) {
  const out = [];
  for (const m of messages ?? []) {
    const blocks = blocksOf(m.content);
    if (m.role === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        out.push({ type: "function_call_output", call_id: b.tool_use_id, output: (b.is_error ? "Error: " : "") + resultText(b.content) });
      }
      const text = textOf(blocks);
      if (text) out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
    } else if (m.role === "assistant") {
      const text = textOf(blocks);
      if (text) out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const c of blocks.filter((b) => b.type === "tool_use")) {
        out.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) });
      }
    } else if (m.role === "system") {
      const text = textOf(blocks);
      if (text) out.push({ type: "message", role: "developer", content: [{ type: "input_text", text }] });
    }
  }
  return out;
}

export const toResponsesTools = (tools) =>
  (tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));

// ---------- HTTP ----------

const looksLikeHTML = (text) => /^\s*<(!doctype|html)/i.test(text) || /cloudflare|cf-ray|challenge-platform/i.test(text);

export class ChatGPTHTTPError extends Error {
  constructor(status, upstream, secrets = []) {
    const detail = scrub(upstream, ...secrets);
    const html = looksLikeHTML(detail);
    let message;
    if (status === 401) message = "ChatGPT: the sign-in was refused. Sign out and sign in again in Settings.";
    else if (status === 403 && html) message = "ChatGPT refused the request (403 from its bot protection, not your sign-in). Try again later.";
    else if (status === 403) message = `ChatGPT: access denied${detail ? `: ${detail}` : ""}. Your plan may not include this model.`;
    else if (status === 429) message = `ChatGPT: usage limit reached for your plan${detail ? ` (${detail})` : ""}. Try again later.`;
    else if (status === 404) message = `ChatGPT: not found${detail && !html ? `: ${detail}` : ""}. Check the model id.`;
    else message = `ChatGPT error ${status}${detail && !html ? `: ${detail}` : ""}`;
    super(message);
    this.name = "ChatGPTHTTPError";
    this.status = status === 403 && html ? 503 : status; // bot protection is not an auth failure
    this.upstream = detail;
  }
}

function headers(cred, sessionId, accept) {
  const h = {
    authorization: `Bearer ${cred.accessToken}`,
    "OpenAI-Beta": "responses=experimental",
    originator: ORIGINATOR,
    accept,
  };
  if (cred.accountId) h["chatgpt-account-id"] = cred.accountId;
  if (sessionId) h.session_id = sessionId;
  return h;
}

// The plan's models: GET {base}/models. Falls back to a short list (with a
// note) for anything but a refused sign-in. Returns { models, modelsError }.
export async function listChatGPTModels({ baseURL = CHATGPT_API_BASE, cred, fetch: doFetch = globalThis.fetch }) {
  const secrets = credentialSecrets(cred);
  let problem;
  try {
    const res = await doFetch(`${baseURL.replace(/\/+$/, "")}/models?client_version=${CLIENT_VERSION}`, { headers: headers(cred, null, "application/json") });
    if (!res.ok) {
      const err = new ChatGPTHTTPError(res.status, await upstreamMessage(res), secrets);
      if (err.status === 401) throw err;
      problem = err.message;
    } else {
      const body = await res.json();
      const list = Array.isArray(body?.models) ? body.models : Array.isArray(body?.data) ? body.data : null;
      if (!list) problem = "unexpected shape";
      else {
        const models = list
          .filter((m) => m && typeof (m.slug ?? m.id) === "string" && m.visibility !== "hide" && m.visibility !== "hidden")
          .map((m) => {
            const out = { id: m.slug ?? m.id, label: m.display_name || m.title || m.name || m.slug || m.id };
            if (Number.isFinite(m.context_window)) out.contextWindow = m.context_window;
            return out;
          });
        if (models.length) return { models, modelsError: null };
        problem = "the list was empty";
      }
    }
  } catch (err) {
    if (err?.status === 401) throw err;
    problem = scrub(err?.cause?.message ?? err?.message ?? err, ...secrets);
  }
  return {
    models: CHATGPT_FALLBACK_MODELS.map((m) => ({ ...m })),
    modelsError: `Your plan's model list could not be fetched (${problem}). These are common ChatGPT models; type another id if yours is missing.`,
  };
}

// Codex's own prompt, for a backend that accepts no other instructions.
// From the latest openai/codex release, cached per prompt file.
const PROMPT_FILES = (model) => (/codex/i.test(model) ? ["gpt_5_codex_prompt.md", "prompt.md"] : ["prompt.md"]);
export function createCodexPromptLoader({ fetch: doFetch = globalThis.fetch, api = "https://api.github.com", raw = "https://raw.githubusercontent.com" } = {}) {
  const cache = new Map();
  let tag = null;
  return async function load(model) {
    if (tag === null) {
      try {
        const res = await doFetch(`${api}/repos/openai/codex/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
        tag = res.ok ? ((await res.json())?.tag_name ?? "main") : "main";
      } catch {
        tag = "main";
      }
    }
    for (const file of PROMPT_FILES(model)) {
      if (cache.has(file)) return cache.get(file);
      try {
        const res = await doFetch(`${raw}/openai/codex/${encodeURIComponent(tag)}/codex-rs/core/${file}`);
        if (!res.ok) continue;
        const text = (await res.text()).trim();
        if (text) {
          cache.set(file, text);
          return text;
        }
      } catch {
        // try the next file
      }
    }
    return null;
  };
}

// ---------- the provider ----------

/**
 * @param {object} o
 * @param {string} o.model
 * @param {() => Promise<object>} o.getCredential   a credential fresh enough to use
 * @param {() => Promise<object>} o.refresh         force a refresh (after a 401)
 * @param {(model: string) => Promise<string|null>} [o.loadCodexPrompt]
 * @param {{ needsCodexPrompt: boolean }} [o.quirks]  shared across generations
 */
export function createChatGPTProvider({
  model,
  baseURL = CHATGPT_API_BASE,
  getCredential,
  refresh,
  loadCodexPrompt = async () => null,
  quirks = { needsCodexPrompt: false },
  effort = "medium",
  fetch: doFetch = globalThis.fetch,
}) {
  const url = baseURL.replace(/\/+$/, "") + "/responses";
  const sessionId = randomUUID();
  let generated = 0;

  // The user's thinking level. The Codex backend takes low, medium and high
  // everywhere; "max" asks for high, "auto" keeps the provider default.
  const effortFor = (thinking) => (thinking === "max" ? "high" : ["low", "medium", "high"].includes(thinking) ? thinking : effort);

  function requestBody(system, messages, tools, codexPrompt, thinking) {
    const sys = systemText(system);
    const input = toResponsesInput(messages);
    const body = {
      model,
      instructions: codexPrompt ?? (sys || "You are a helpful assistant."),
      input: codexPrompt && sys ? [{ type: "message", role: "developer", content: [{ type: "input_text", text: sys }] }, ...input] : input,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: effortFor(thinking) },
      prompt_cache_key: sessionId,
    };
    if (tools?.length) {
      body.tools = toResponsesTools(tools);
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
    return body;
  }

  async function post(body, cred, signal) {
    try {
      return await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers(cred, sessionId, "text/event-stream") },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw abortError();
      throw new Error(`ChatGPT: could not connect: ${scrub(err?.cause?.message ?? err?.message ?? err, ...credentialSecrets(cred))}`);
    }
  }

  return {
    name: "chatgpt",
    model,

    async *stream({ system, messages, tools = [], thinking = "auto", signal } = {}) {
      let cred = await getCredential();
      let codexPrompt = quirks.needsCodexPrompt ? await loadCodexPrompt(model) : null;
      let res = await post(requestBody(system, messages, tools, codexPrompt, thinking), cred, signal);
      if (res.status === 401) {
        await res.body?.cancel?.().catch(() => {});
        cred = await refresh();
        res = await post(requestBody(system, messages, tools, codexPrompt, thinking), cred, signal);
      }
      if (res.status === 400 && !codexPrompt) {
        const msg = await upstreamMessage(res);
        if (!/instruction/i.test(msg)) throw new ChatGPTHTTPError(400, msg, credentialSecrets(cred));
        codexPrompt = await loadCodexPrompt(model);
        if (!codexPrompt) throw new ChatGPTHTTPError(400, `${msg} (and Codex's prompt could not be fetched from GitHub to retry)`, credentialSecrets(cred));
        quirks.needsCodexPrompt = true; // remembered for later generations
        res = await post(requestBody(system, messages, tools, codexPrompt, thinking), cred, signal);
      }
      if (!res.ok) throw new ChatGPTHTTPError(res.status, await upstreamMessage(res), credentialSecrets(cred));

      let text = "";
      let refusal = "";
      let finished = null; // "completed" | "incomplete"
      let incompleteReason = null;
      let finalOutput = null;
      const calls = []; // { key, index, id, name, args, started, ended }
      const find = (ev) => calls.find((c) => (ev.item_id && c.key === ev.item_id) || (ev.output_index !== undefined && c.index === ev.output_index));

      function* begin(item, index) {
        const call = { key: item.id ?? null, index, id: item.call_id || item.id || `call_gen_${++generated}`, name: item.name ?? "", args: "", started: true, ended: false };
        calls.push(call);
        yield { type: "tool_start", id: call.id, name: call.name };
        if (typeof item.arguments === "string" && item.arguments) {
          call.args = item.arguments;
          yield { type: "tool_delta", id: call.id, json: item.arguments };
        }
        return call;
      }
      function* end(call, finalArgs) {
        if (call.ended) return;
        if (typeof finalArgs === "string" && finalArgs && !call.args) {
          call.args = finalArgs;
          yield { type: "tool_delta", id: call.id, json: finalArgs };
        }
        call.ended = true;
        yield { type: "tool_end", id: call.id };
      }

      try {
        for await (const data of sseData(res.body, signal)) {
          if (data.trim() === "[DONE]") break;
          let ev;
          try {
            ev = JSON.parse(data);
          } catch {
            continue;
          }
          switch (ev?.type) {
            case "response.output_text.delta":
              if (typeof ev.delta === "string" && ev.delta) {
                text += ev.delta;
                yield { type: "text", text: ev.delta };
              }
              break;
            case "response.refusal.delta":
              if (typeof ev.delta === "string") refusal += ev.delta;
              break;
            case "response.output_item.added":
              if (ev.item?.type === "function_call") yield* begin(ev.item, ev.output_index);
              break;
            case "response.function_call_arguments.delta": {
              const call = find(ev);
              if (call && !call.ended && typeof ev.delta === "string" && ev.delta) {
                call.args += ev.delta;
                yield { type: "tool_delta", id: call.id, json: ev.delta };
              }
              break;
            }
            case "response.function_call_arguments.done": {
              const call = find(ev);
              if (call) yield* end(call, ev.arguments);
              break;
            }
            case "response.output_item.done":
              if (ev.item?.type === "function_call") {
                const call = find({ item_id: ev.item.id, output_index: ev.output_index }) ?? (yield* begin({ ...ev.item, arguments: "" }, ev.output_index));
                yield* end(call, ev.item.arguments);
              }
              break;
            case "response.completed":
              finished = "completed";
              finalOutput = ev.response?.output ?? null;
              break;
            case "response.incomplete":
              finished = "incomplete";
              incompleteReason = ev.response?.incomplete_details?.reason ?? null;
              finalOutput = ev.response?.output ?? null;
              break;
            case "response.failed": {
              const e = ev.response?.error;
              throw new Error(`ChatGPT: ${scrub(e?.message ?? e?.code ?? "the response failed", ...credentialSecrets(cred))}`);
            }
            case "error":
              throw new Error(`ChatGPT: ${scrub(ev.message ?? ev.error?.message ?? ev.code ?? "stream error", ...credentialSecrets(cred))}`);
            default:
              break;
          }
          if (finished) break;
        }
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") throw abortError();
        throw err;
      }
      if (signal?.aborted) throw abortError();
      if (!finished) throw new Error("ChatGPT: the stream ended before the response finished.");

      // Text that only arrived in the final response object.
      if (!text && Array.isArray(finalOutput)) {
        for (const item of finalOutput) {
          if (item?.type !== "message") continue;
          for (const part of item.content ?? []) {
            if (part?.type === "output_text" && part.text) text += part.text;
            if (part?.type === "refusal" && part.refusal) refusal += part.refusal;
          }
        }
        if (text) yield { type: "text", text };
      }
      for (const call of calls) yield* end(call);

      let reason;
      let message;
      if (finished === "incomplete" && incompleteReason === "max_output_tokens") reason = "max_tokens";
      else if ((finished === "incomplete" && incompleteReason === "content_filter") || (refusal && !text && !calls.length)) {
        reason = "refusal";
        message = refusal || "ChatGPT stopped this response with its content filter.";
      } else if (finished === "incomplete") throw new Error(`ChatGPT: the response stopped early (${incompleteReason ?? "incomplete"}).`);
      else reason = calls.length ? "tool_use" : "end_turn";

      const content = [];
      if (text) content.push({ type: "text", text });
      for (const call of calls) {
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
