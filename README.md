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
- **Answer length.** Auto, Brief, Medium or Detailed, from the picker in
  the message box or in Settings.
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

Providers: **Anthropic** (Claude), **DeepSeek** and **Qwen** (Alibaba Cloud
Model Studio).

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

- **In the app** (Settings → provider → API key). The key is kept in memory
  and forgotten when the server stops, unless you tick *Remember on this
  computer*, which saves
  it to `.keys.json` in this folder (readable only by you on macOS and Linux).
- **In `.env`.** Copy `.env.example` to `.env` and fill in
  `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY` or `DASHSCOPE_API_KEY`.

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
| `PC_MAX_CARDS` | `4` | Cards one answer may create (1 to 6) |
| `PC_DATA_DIR` | `.data` | Where chats and settings are kept; `off` keeps everything in memory |
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
