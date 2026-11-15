// Entry point: node server.mjs
//
// Settings come from the environment, or from a .env file in this folder
// (see .env.example). Variables already set in the environment win. Keys can
// also be added in the web app (memory, or .keys.json when remembered).
//   ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN   start on Anthropic
//   DEEPSEEK_API_KEY                            DeepSeek key, selectable in the app
//   DASHSCOPE_API_KEY, DASHSCOPE_REGION         Qwen key and region (intl, us, cn, hk)
//   PORT          listen port (default 4317)
//   HOST          listen address (default 127.0.0.1)
//   PC_MODE       generation mode for new chats: fanout (default) or single
//   PC_MAX_CARDS  cards one chat's answer may create, 1 to 6 (default 4)
//   PC_MODEL      model for the Anthropic provider (default claude-opus-5-5)
//   PC_DATA_DIR   where chats and settings are kept across restarts (default
//                 .data in this folder: log.jsonl and config.json, never a key);
//                 a relative path is taken from this folder; "off" keeps
//                 everything in memory
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
  console.log("[parallel-chat] loaded settings from .env");
}

const { startServer } = await import("./server/http.mjs");
const { createRegistry } = await import("./server/providers/registry.mjs");

process.on("unhandledRejection", (err) => console.error("[parallel-chat] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[parallel-chat] uncaught exception:", err));

const port = Number(process.env.PORT) || 4317;
const host = process.env.HOST || "127.0.0.1";
const mode = process.env.PC_MODE === "single" ? "single" : "fanout";
const maxCards = Number(process.env.PC_MAX_CARDS) || 4;
const here = path.dirname(fileURLToPath(import.meta.url));
const dataSetting = process.env.PC_DATA_DIR?.trim();
const dataDir = dataSetting === "off" ? null : path.resolve(here, dataSetting || ".data");

const registry = createRegistry();
await registry.init(); // no upstream calls
const app = await startServer({
  port,
  host,
  registry,
  mode,
  maxCards,
  dataDir,
});
const config = app.engine.getConfig();
console.log(
  `[parallel-chat] listening on http://${host}:${app.port} (provider ${config.provider ?? "none yet"}, model ${config.model ?? "-"}, mode ${config.mode}, maxCards ${config.maxCards}, data ${dataDir ?? "in memory"})`,
);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
