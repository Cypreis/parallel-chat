// Persistence: the event log as JSON lines and the settings as one JSON file.
//
//   <dir>/log.jsonl     one event per line, appended as events are logged
//   <dir>/config.json   { provider, model, mode, maxCards, length }
//
// Appends go through a short write queue: events logged within one flush
// window are written together, one write at a time, so order is kept and a
// stream of deltas does not cost one write per token. Neither file ever holds
// a key: events never contain one, and the config holds only ids.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { appendFile, truncate } from "node:fs/promises";
import path from "node:path";
import { jsonOf } from "./log.mjs";

const FLUSH_MS = 30;

export function createStore({ dir, logger = console }) {
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "log.jsonl");
  const configFile = path.join(dir, "config.json");
  const ops = []; // { kind: "append", text } | { kind: "truncate" }, in order
  let timer = null;
  let running = null; // promise of the drain in progress

  function atomicWrite(file, text) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  }

  // Read the log. A corrupt last line (a crash mid-write) is skipped; a
  // corrupt line in the middle stops the replay there. When anything was
  // dropped the file is rewritten with what was kept, so later appends follow
  // a clean last line.
  function loadEvents() {
    if (!existsSync(logFile)) return [];
    const raw = readFileSync(logFile, "utf8");
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const events = [];
    let dropped = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let ev = null;
      try {
        ev = JSON.parse(line);
      } catch {
        ev = null;
      }
      const prev = events.at(-1);
      const valid = ev && typeof ev.seq === "number" && typeof ev.type === "string" && (!prev || ev.seq === prev.seq + 1);
      if (valid) {
        events.push(ev);
        continue;
      }
      dropped = true;
      const rest = lines.slice(i + 1).filter((l) => l.trim()).length;
      if (rest === 0) logger.log?.(`[store] skipped an incomplete last line in ${logFile}`);
      else logger.warn?.(`[store] ${logFile} line ${i + 1} is corrupt: replay stops there and the ${rest} line(s) after it are ignored`);
      break;
    }
    if (dropped || (raw && !raw.endsWith("\n"))) atomicWrite(logFile, events.map((e) => JSON.stringify(e) + "\n").join(""));
    return events;
  }

  function loadConfig() {
    if (!existsSync(configFile)) return null;
    try {
      const data = JSON.parse(readFileSync(configFile, "utf8"));
      return data && typeof data === "object" ? data : null;
    } catch {
      logger.warn?.(`[store] ${configFile} could not be read; using defaults`);
      return null;
    }
  }

  function schedule() {
    if (!timer && !running) timer = setTimeout(drain, FLUSH_MS);
  }

  function drain() {
    timer = null;
    if (running) return running;
    running = (async () => {
      while (ops.length) {
        const op = ops.shift();
        try {
          if (op.kind === "truncate") await truncate(logFile, 0).catch((e) => (e.code === "ENOENT" ? null : Promise.reject(e)));
          else if (op.kind === "rewrite") atomicWrite(logFile, op.text);
          else {
            // Coalesce every append queued behind this one into one write.
            let text = op.text;
            while (ops[0]?.kind === "append") text += ops.shift().text;
            await appendFile(logFile, text);
          }
        } catch (err) {
          logger.error?.(`[store] could not write ${logFile}: ${err.message}`);
        }
      }
    })().finally(() => {
      running = null;
      if (ops.length) schedule();
    });
    return running;
  }

  return {
    dir,
    logFile,
    configFile,
    loadEvents,
    loadConfig,
    append(event) {
      ops.push({ kind: "append", text: jsonOf(event) + "\n" });
      schedule();
    },
    // Empty the log file (POST /api/reset). Ordered with the appends around it.
    truncate() {
      ops.push({ kind: "truncate" });
      schedule();
    },
    // Replace the whole file with these events (a deleted chat was redacted).
    // The list already holds every event queued so far, so queued writes go.
    rewrite(events) {
      ops.length = 0;
      ops.push({ kind: "rewrite", text: events.map((e) => JSON.stringify(e) + "\n").join("") });
      schedule();
    },
    saveConfig(config) {
      const { provider, model, mode, maxCards, length, thinking, planner } = config;
      atomicWrite(configFile, JSON.stringify({ provider, model, mode, maxCards, length, thinking, planner: planner ?? null }, null, 2) + "\n");
    },
    // Write everything queued so far.
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      while (ops.length || running) await (running ?? drain());
    },
  };
}
