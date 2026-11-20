# Parallel chat

A local chat app that answers a question as a set of side-by-side **cards**,
one per part of the answer, instead of one long reply. Every card has its own
follow-up thread, so you can dig into one part without losing the others.

- **Cards, not a wall of text.** A question is split into the parts that
  matter (options to compare, steps, angles), each written in its own card.
- **A thread per card.** Ask a follow-up on any card. The model either
  answers in that card's thread or opens a new card beside it.
- **Three ways to look at it.** *Fit* shows every card at once. *Strip* is a
  row of full-height columns (1/4, 1/3, 1/2, Full, or *Focus*, with the
  current card centred between readable neighbours). *Flow* is one growing
  chat where follow-up cards nest under the card they came from.
- **Links and decisions.** Cards link to related cards, even across chats.
  A decision is a rule the model must follow, in one chat or in all of
  them. Pin one from a reply, a card or selected text, pick the cards it
  changes, and those are marked *Out of date* until you refresh them.
- **Answer length and thinking level.** Auto, Brief, Medium or Detailed;
  and how long the model reasons (Anthropic and ChatGPT), from the pickers
  in the message box or in Settings.
- **Diagrams, charts and math.** Cards can hold Mermaid diagrams, Vega-Lite
  charts, small SVG drawings and LaTeX formulas, drawn in the page (the
  libraries come with `npm install` and load only when a card needs them).
- **Optional planning model.** In fan-out generation, a small fast model
  can decide which cards to make while the answer model writes them
  (Settings → Answers → Planning model). Off until you set it.
- **Saved cards.** The bookmark on a card saves it. **Saved** (top bar or
  sidebar, key `S`) opens a whiteboard of every saved card: drag them
  anywhere, sort them into folders you make (the bookmark asks which folder as you save), hide a card's follow-ups with its small
  button. Cards saved from the same question are joined by a dashed line, a
  card and its sub-card by a thick one.
- **Files.** Attach text, code, CSV, JSON, Markdown, PDF or Word files with
  the paperclip, by dropping them on the page or by pasting them. The model
  reads a chat's files with every answer and reply in that chat.
- **Notes.** Private notes on a chat or on any card. The model never sees
  them.
- **Your chats, organised.** Search every chat (titles, questions, cards,
  notes, file names), rename, pin to the top, sort into groups (drag a chat
  onto a group), export as Markdown, or delete for good.
- **Your keys stay with you.** It runs on your machine and talks to the model
  provider you choose with your own API key.

Providers: **Anthropic** (Claude), **ChatGPT** (sign in with your ChatGPT
plan, no API key), **OpenAI**, **Google Gemini**, **xAI**, **Mistral**,
**Groq**, **OpenRouter**, **Together AI**, **Hugging Face**, **OpenCode**
(Zen and Go), **DeepSeek**, **Qwen** (Alibaba Cloud Model Studio), and **a
local model** (any OpenAI-compatible server: Ollama, LM Studio, llama.cpp;
give its address, no key needed). Only the ChatGPT sign-in is OAuth: the
other services offer API keys, not a sign-in for apps like this one. Apart
from Anthropic, these were only tested against a local fake, not the real
services.

### Sign in with ChatGPT

Settings → ChatGPT → **Sign in with ChatGPT** opens OpenAI's sign-in page.
When you finish, it sends you back to `http://localhost:1455/auth/callback`,
and the app picks up the sign-in by itself. If that port is busy (Codex CLI
signing in at the same time) or the page does not load, paste the address
from the browser bar into the box Settings shows.

This is the same sign-in and backend that Codex CLI uses
(`chatgpt.com/backend-api/codex`). Requests count toward your plan's limits,
and the sign-in is meant for your own personal use. Tokens are kept like
keys, in `.keys.json`, refreshed before they expire and never sent to the
page.

### OpenCode

**OpenCode (Zen)** and **OpenCode Go** (the subscription) are two providers:
paste your OpenCode Console API key into either, from
<https://opencode.ai/zen> or <https://opencode.ai/go>. Every chat model is
called through OpenCode's OpenAI-compatible endpoint, and its model list is
read from the gateway. Free models are left out, since OpenCode serves them
only to its own app. Note: OpenCode's model list is public, so a wrong key is
only noticed on the first question.

## Run it

Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
git clone <this repository>
cd parallel-chat
npm install
npm start
```

Open <http://127.0.0.1:4317>, then click the badge at the bottom of the
sidebar (or **Settings**), choose a provider and paste your API key.

`npm install` is only needed for Anthropic: it fetches the official SDK.
DeepSeek and Qwen work without any dependency.

## API keys

Pick one of these:

- **In the app** (Settings → provider → API key, or Sign in with ChatGPT).
  It is saved at once to `.keys.json` in this folder (readable only by you
  on macOS and Linux), so it survives restarts until you remove it.
- **In `.env`.** Copy `.env.example` to `.env` and fill in
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`,
  `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `TOGETHER_API_KEY`,
  `HF_TOKEN`, `OPENCODE_API_KEY` (and `OPENCODE_GO_API_KEY` if it differs),
  `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY`, or `LOCAL_LLM_URL` for a local
  server. (ChatGPT has no key: sign in from Settings.)

What happens to a key:

- It goes from the page to this local server only, which sends it to the
  provider you chose. It is never sent back to the page (the app shows only
  its last four characters), never written to the logs, and removed from
  error messages.
- `.env`, `.keys.json` and `.data/` (your chats) are in `.gitignore`, so they
  are never committed.

With no key the app starts anyway and tells you to add one; it never makes
up answers.

## Settings

All optional, in the environment or in `.env`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `4317` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `PC_MODEL` | `claude-opus-5-5` | Anthropic model used at start |
| `PC_MODE` | `fanout` | `fanout` writes the cards in parallel; `single` in one call |
| `PC_MAX_CARDS` | `6` | Cards one answer may create (1 to 10) |
| `PC_DATA_DIR` | `.data` | Where chats and settings are kept; `off` keeps everything in memory |
| `PC_CONCURRENCY` | `8` | Streams at once per provider; the rest wait their turn (0: no limit) |
| `PC_RETRIES` | `2` | Retries of a request that failed with the service's trouble (5xx, overload, 429 with Retry-After) |
| `PC_COALESCE_MS` | `40` | Streamed text is merged into one event per this many ms (0: one event per piece) |
| `DASHSCOPE_REGION` | `intl` | Qwen region: `intl`, `us`, `cn` or `hk` |

The server has no login. Keep it on `127.0.0.1` (the default); do not expose
it on a network you do not trust.

## Keyboard

Press `?` in the app for every shortcut. A few: `/` to write, `v` to switch
view, `z` for Focus, arrow keys to move between cards, `+` / `-` to resize the
current card.

## Develop

```bash
npm test
```

The tests use a scripted stand-in model (`test/support/mock.mjs`), so they
need no key and no network. `protocol.md` describes the HTTP API, the event
stream and the data model. There is no build step: the server is plain
Node.js modules and the page is plain HTML, CSS and JavaScript in `public/`.

## Licence

[MIT](LICENSE)
