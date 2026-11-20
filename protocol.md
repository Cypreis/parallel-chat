# Parallel chat: wire contract

The server owns an append-only event log. The UI is a projection of that log.
Both sides fold events with the same reducer, `shared/project.mjs`, which the
server serves at `/shared/project.mjs`.

Layout of this folder:

| Path | Owner | Purpose |
| --- | --- | --- |
| `server.mjs`, `server/**`, `shared/**`, `test/**`, `package.json` | server | HTTP, log, providers, context builder |
| `public/**` | UI | `index.html`, `app.js`, `styles.css` and anything else the page loads |

Server listens on `PORT` (default `4317`). `/` serves `public/`, `/shared/*` serves `shared/`.

## Data model

```js
// Node
{
  id: "n_12",
  kind: "question" | "card" | "message",
  parentId: string | null,   // question: null; card: question id; message: card id
  turnId: string,            // id of the question that roots this turn
  role: "user" | "assistant",
  title: string,             // cards only, "" otherwise
  summary: string,           // cards only, one or two lines
  body: string,              // markdown; for user nodes, the text they typed
  status: "streaming" | "settled" | "stale" | "error" | "cancelled",
  shape?: "single" | "parallel" | "comparison" | "steps",  // questions only
  mode?: "single" | "fanout",                              // questions only
  quote?: string,            // messages only: selected text the user asked about
  staleBecause?: string,     // decision id, while status is "stale"
  error?: string,
  seq: number                // seq of the node.open event
}

// Edge between two cards
{ id: "e_3", from: cardId, to: cardId,
  rel: "depends_on" | "feeds" | "contradicts" | "alternative_to" | "elaborates" }

// Decision (shared memory every thread sees)
{ id: "d_2", text: string, sourceNodeId: string | null, affects: cardId[] }
```

A turn is one question node plus its cards. The UI calls a turn a **chat**:
every new question opens a new chat, and one chat is on screen at a time.
A card's thread is its message children in `seq` order.

An edge may join two cards in the same chat or in different chats ("this
topic of chat 1 is linked to that topic of chat 3"). Nothing in the events
changes for a cross-chat edge; compare the two cards' `turnId` to tell.

## Model tools

The model does not write a text format. It builds the board by calling tools,
and the server turns each call into the events below.

| Tool | Input | Effect |
| --- | --- | --- |
| `create_card` | `{ key, title, summary, body }` (fan-out mode: `{ key, title, intent }`, and a writer call per card streams the body) | `node.open` as soon as the title is known, `node.delta` as the input streams, `node.close` when the call ends. Result: `{ id }` |
| `link_cards` | `{ from, to, rel }` where each end is a `key` from this response or the `id` of any existing card in any chat | `edge.add`. Result: `{ id }`, or an error for an unknown card, a self link or a duplicate |

The system prompt (the "pre-context") tells the model how and when to use
them, the card limit, and lists every existing card in every chat with its
id, chat number, title and summary so it can link new cards to old ones.
Thread replies are plain text, with `link_cards` available.

`maxCards` (config, 1 to 10, default 6) caps the cards one chat's answer may
create; a `create_card` call past the cap returns an error result.

## Events

Every event is `{ seq, ts, type, ...payload }`. `seq` starts at 1 and increases by 1.

| type | payload | reducer effect |
| --- | --- | --- |
| `session.reset` | none | clear everything |
| `node.open` | `node` | insert node |
| `node.delta` | `id`, `field: "summary" \| "body"`, `text` | append text to the field |
| `node.patch` | `id`, `patch` | shallow-merge `patch` into the node |
| `node.reset` | `id` | `summary = ""`, `body = ""`, `status = "streaming"`, drop `error` and `staleBecause` |
| `node.close` | `id`, `status: "settled" \| "error" \| "cancelled"`, `error?` | set status (and error) |
| `edge.add` | `edge` | insert edge |
| `decision.pin` | `decision` | insert decision; every card in `affects` whose status is `settled` becomes `stale` with `staleBecause = decision.id` |
| `decision.unpin` | `id` | remove decision; cards with `staleBecause === id` go back to `settled` |

## Reducer API (`shared/project.mjs`)

```js
export function createState()
// -> { seq: 0, nodes: {}, order: [], edges: [], decisions: [] }
//    nodes: id -> Node; order: node ids in open order

export function applyEvent(state, event)   // mutates and returns state; ignores seq <= state.seq
export function turns(state)               // -> question nodes in order
export function cardsOf(state, questionId) // -> card nodes in order
export function threadOf(state, cardId)    // -> message nodes in order
export function edgesOf(state, cardId)     // -> edges touching the card
export function cardOf(state, nodeId)      // -> the card that is, or owns, this node; null for questions
```

No DOM and no Node APIs in this file: it runs in both places.

## HTTP API

JSON in, JSON out. Errors are `{ "error": "message" }` with 400 or 404.
Every write returns as soon as the first events are logged; content arrives on the stream.

| Method and path | Body | Response | Effect |
| --- | --- | --- | --- |
| `GET /api/events` | `Last-Event-ID` header or `?since=<seq>` | SSE | replay events after `since`, then live |
| `GET /api/state` | | projected state | debugging and tests |
| `GET /api/config` | | `{ provider: "anthropic" \| "deepseek" \| "qwen" \| null, model, mode, maxCards, length }` | `provider` and `model` are null until a key is added |
| `POST /api/config` | `{ mode?: "single" \| "fanout", maxCards?: 1..6, length?: "auto" \| "brief" \| "medium" \| "detailed" }` | config | settings for new work; any field may be sent alone |
| `POST /api/ask` | `{ text }` | 202 `{ turnId }` | new turn: question node, then cards stream in |
| `POST /api/nodes/:cardId/reply` | `{ text, quote? }` | 202 `{ userNodeId, assistantNodeId }` | follow-up in that card's thread |
| `POST /api/broadcast` | `{ cardIds, text }` | 202 `{ replies: [{ cardId, userNodeId, assistantNodeId }] }` | same follow-up in several threads, answered concurrently |
| `POST /api/synthesize` | `{ cardIds }` | 202 `{ cardId }` | new card in the first card's turn, with an `elaborates` edge to each source |
| `POST /api/nodes/:cardId/refresh` | | 202 `{ cardId }` | `node.reset`, then regenerate the card with current decisions |
| `POST /api/nodes/:id/cancel` | | 200 `{ id }` | abort a streaming node; it closes as `cancelled` |
| `POST /api/decisions` | `{ text, sourceNodeId?, affects? }` | 201 `{ decision }` | pin; if `affects` is absent it is every other card joined by an edge to the source's card |
| `DELETE /api/decisions/:id` | | 200 `{ id }` | unpin |
| `GET /api/context/:cardId` | | `{ system, messages, sections: [{ name, chars, cached }] }` | the exact scoped context a reply in that card would be sent |
| `POST /api/reset` | | 200 `{}` | abort everything, clear the log, emit `session.reset` |

## One continuing chat, and follow-ups as cards (Flow)

Two additions let the UI offer a mode with one chat that keeps growing to the
right. Nothing changes for the existing behaviour.

**A chat may hold several questions.** A question node may carry
`chatId`: the id of the first question of the chat it continues. The first
question of a chat has no `chatId`. A chat is a first question plus every
question whose `chatId` is its id, in `seq` order, each with its own cards
(`turnId` is still the id of the card's own question). Chat numbers count
chats, not questions.

**A follow-up may become a card.** A card node may carry
`origin: { cardId, text, quote? }`: the card it was asked from, what the user
asked, and the passage they had selected. Such a card belongs to the same
question as its source (`parentId` and `turnId` copied from it).

| Method and path | Body | Response | Effect |
| --- | --- | --- | --- |
| `POST /api/ask` | `{ text, chatId? }` | 202 `{ turnId }` | with `chatId`, the new question joins that chat (400 if it is not the id of a chat's first question) |
| `POST /api/nodes/:cardId/branch` | `{ text, quote? }` | 202 `{ cardId }` | a new card answering the follow-up |

Events for a branch, in order: `node.open` at once with `title: ""`,
`status: "streaming"` and `origin` set, so the card can appear before the
model has said anything; `edge.add` from the new card to its source with
`rel: "elaborates"`; `node.patch { title }` as soon as the model has given the
title; `node.delta` for the body; `node.close`. The model may add further
links with `link_cards`. A branch card does not count against `maxCards`.
Cancel and refresh work on it like on any card; refresh answers the same
`origin` again.

**The model may choose between the two.** `POST /api/nodes/:cardId/followup
{ text, quote? }` -> 202 `{ userNodeId }` lets the model decide whether the
answer belongs in the card's own thread or in a new card beside it. `reply`
(always the thread) and `branch` (always a new card) stay as they are.

Events for a follow-up:

1. `node.open` at once for the user's message in the card's thread, with
   `pending: true` (and `quote` when given).
2. When the model's first content arrives, exactly one of:
   - text: `node.patch { pending: false }` on the user message, then the
     assistant message opens in the thread and streams, as for `reply`;
   - a card: `node.patch { pending: false, answeredBy: <new card id> }` on the
     user message, then the branch events above, with
     `origin: { cardId, text, quote?, messageId }` where `messageId` is the
     user message.
3. If the call fails before any content: `node.patch { pending: false }`, then
   an assistant message that opens and closes with `status: "error"`.

Message nodes may therefore carry `pending?: boolean` and `answeredBy?: cardId`.

## Chats, groups, notes, files and scoped decisions

State gains four fields: `chatMeta: { [chatId]: { title?, pinned?, groupId? } }`,
`groups: [{ id: "g_1", name }]`, `notes: { [targetId]: { text, ts } }` and
`docs: [{ id: "f_1", chatId, name, mime, size, chars, text }]`. A chat id is
the id of its first question. A decision gains `scope`: a chat id (it applies
in that chat only) or `null` (every chat). A decision logged without `scope`
applies everywhere.

| type | payload | reducer effect |
| --- | --- | --- |
| `chat.meta` | `chatId`, `patch: { title?, pinned?, groupId? }` | merge; `null`, `""` or `false` removes a field; an empty entry is dropped |
| `chat.delete` | `chatId` | remove the chat's nodes, the edges touching them, decisions scoped to it (cards elsewhere they made stale go back to settled), its notes, docs and meta; other decisions lose the removed ids from `affects` and `sourceNodeId` |
| `group.add` | `group: { id, name }` | insert |
| `group.patch` | `id`, `patch: { name }` | rename |
| `group.remove` | `id` | remove; its chats lose `groupId` |
| `note.set` | `targetId`, `text` | set; blank text removes the note |
| `doc.add` | `doc` | insert |
| `doc.remove` | `id` | remove |
| `decision.patch` | `id`, `patch: { text?, affects? }` | update; when the text or `affects` changes, settled cards in `affects` become stale again |
| `redacted` | `ref` | nothing (see deleting a chat) |

Reducer helpers: `decisionsFor(state, chatId)` (scoped to it, or to every
chat, in pin order), `docsOf(state, chatId)`, `chatNodeIds(state, chatId)`.

**What the model sees.** `<decisions>` holds only the decisions that apply in
the chat being worked on. `<documents>` holds the chat's files in full, each
cut to its first 120,000 characters and all of them to 240,000; it sits right
after `<question>` (inside the cached prefix) for cards, and first, with its
own cache breakpoint, for a new question. Notes are never sent.

| Method and path | Body | Response | Effect |
| --- | --- | --- | --- |
| `POST /api/ask` | adds `docs?: [{ name, text, mime?, size? }]` | 202 `{ turnId }` | the files join the chat before the answer starts |
| `PATCH /api/chats/:chatId` | `{ title?, pinned?, groupId? }` | 200 `{ chatId, meta }` | `title: null` clears the name; `groupId: null` ungroups |
| `DELETE /api/chats/:chatId` | | 200 `{ chatId }` | same-origin only. Stops its work, logs `chat.delete`, then redacts the chat's past events |
| `POST /api/chats/:chatId/docs` | `{ docs }` | 201 `{ docs }` (without text) | attach files to an existing chat |
| `DELETE /api/docs/:id` | | 200 `{ id }` | detach a file |
| `POST /api/groups` | `{ name, chatIds? }` | 201 `{ group }` | |
| `PATCH /api/groups/:id` | `{ name }` | 200 `{ group }` | |
| `DELETE /api/groups/:id` | | 200 `{ id }` | its chats stay, ungrouped |
| `PUT /api/notes/:targetId` | `{ text }` | 200 `{ targetId, note }` | target: a card or a chat; at most 20,000 characters |
| `POST /api/decisions` | adds `scope?: chatId \| null` | 201 `{ decision }` | 400 if `scope` is not a chat |
| `PATCH /api/decisions/:id` | `{ text?, affects? }` | 200 `{ decision }` | |

A request may carry at most 10 files of at most 2,000,000 characters each;
the request body limit is 32 MB. The page reads files to text itself (text
and code as UTF-8, `.docx` by unzipping it, PDFs with pdf.js fetched from
cdn.jsdelivr.net the first time one is attached).

**Deleting a chat erases it.** After `chat.delete` is logged, every earlier
event that carried the chat's content (its nodes and their deltas, patches
and closes, edges touching it, decisions scoped to it, its meta, notes and
files) is replaced in the log by `{ seq, ts, type: "redacted", ref }`, and
the stored `log.jsonl` is rewritten. Seqs stay contiguous, so a page that
reconnects keeps its place, and `ref` keeps the id so ids are never reused
after a restart.

**Answer length.** `length` (default `auto`) is the length the user wants.
For any other value, every model call (new answer, fan-out writer, reply,
branch, follow-up, synthesis, refresh) ends with a `<length setting="…">`
block placed after the cache breakpoint, so the cached prefix does not
change: `brief` is about 80 words a card and replies of one to three
sentences, `medium` 150 to 300 words a card, `detailed` 400 to 800 words
with examples. A question that asks for another length still wins. `auto`
adds nothing. It is saved in `config.json` with the other settings.

## Persistence

The event log and the settings survive a restart. The server appends every
event to `.data/log.jsonl` and replays it at start; a node that was still
streaming when the server stopped is closed as `cancelled` during replay.
`seq` continues from the last stored event, so a page that reconnects keeps
its place. The active provider, model, mode and `maxCards` are stored in
`.data/config.json` and restored when that provider still has a key (else
no provider is active until one is added). `POST /api/reset` empties the log file. `.data/` is git-ignored and
never holds a key. `PC_DATA_DIR` moves it; `PC_DATA_DIR=off` keeps everything
in memory (tests use this).

Reducer additions (`shared/project.mjs`):

```js
export function chats(state)              // -> [{ id, questions: [question nodes in order] }] in order
export function chatOf(state, nodeId)     // -> id of the chat (first question) that holds this node
export function cardsInOrder(state, questionId)
// -> the question's cards in display order: a card with `origin` comes right
//    after its source card and after that source's earlier branches
```

`cardsOf` keeps returning cards in open order.

## Providers, keys and models

The user picks the model provider in the web app, pastes an API key there, and
chooses a model from the list the server fetched with that key. A key goes
from the page to this server only, is never sent back to the page, never
logged, and never put in the event log.

Provider ids: `anthropic`, `deepseek`, `qwen`, `opencode`, `chatgpt`.
`chatgpt` has no key: the user signs in (OAuth with PKCE, Codex CLI's client)
and the resulting tokens are handled like a key. With no key, no provider is
active (`provider: null`) and every generation fails at once with "No model is
connected yet. Open Settings and add an API key…", so the page can send the
user to Settings. Nothing is ever made up locally.

```js
// ProviderInfo
{
  id: "deepseek",
  label: "DeepSeek",
  auth: "key" | "oauth",       // "oauth": signed in (chatgpt), never given a key
  needsKey: true,
  hasKey: true,                // for chatgpt: signed in
  keyHint: "…9f2c" | null,     // last 4 characters only; null for chatgpt
  account: { email, plan } | null,                  // chatgpt only, when signed in
  login: { pending, url, callback, error } | null,  // chatgpt only: the sign-in in progress
                               // (callback false: port 1455 was busy, paste the address instead)
  keySource: "page" | "file" | "env" | null,   // where the key in use came from
  remembered: false,           // true when it is saved in .keys.json
  regions: [{ id: "intl", label: "Singapore (international)" }, ...] | null,  // qwen only
  region: "intl" | null,       // qwen only; "custom" when baseURL was given
  baseURL: string | null,      // shown only for region "custom"
  models: [{ id: "deepseek-flash", label: "DeepSeek-V4.1-Flash", contextWindow?: number, maxOutput?: number }] | null,
  modelsError: string | null,  // key accepted but the list could not be fetched; the user may type a model id
  model: string | null         // model last chosen for this provider
}
```

| Method and path | Body | Response | Effect |
| --- | --- | --- | --- |
| `GET /api/providers` | | `{ active: { provider, model }, providers: ProviderInfo[] }` | never fetches upstream; `models` is the cached list |
| `POST /api/providers/:id/key` | `{ apiKey, region?, baseURL?, remember? }` | 200 `{ provider: ProviderInfo }` | checks the key by fetching the model list; stores the key in memory, and in `.keys.json` when `remember` is true. 400 `{ error }` when the provider rejects the key (nothing is stored) |
| `POST /api/providers/:id/models` | | 200 `{ provider: ProviderInfo }` | fetch the model list again with the stored key |
| `DELETE /api/providers/:id/key` | | 200 `{ provider: ProviderInfo }` | forget the key (memory and file). If that provider was active, no provider is active until another is chosen |
| `POST /api/providers/chatgpt/login` | `{ remember? }` | 200 `{ provider }` | start a sign-in: listens on `localhost:1455/auth/callback` and returns `login.url` for the page to open. Starting again replaces the earlier one. Times out after 10 minutes |
| `POST /api/providers/chatgpt/login/complete` | `{ url }` | 200 `{ provider }` | finish a sign-in from the address the browser ended on (or its query string, or the bare code). 400 when the code or state is wrong |
| `DELETE /api/providers/chatgpt/login` | | 200 `{ provider }` | cancel a sign-in in progress. Sign out with `DELETE /api/providers/chatgpt/key` |
| `POST /api/config` | adds `{ provider?, model? }` | config | switch provider and model for new work. 400 when the provider has no key, or `model` is missing for a provider that needs one. `model` may be any non-empty string, so a model missing from the list can be typed |

Rules:

- Work already streaming finishes on the provider it started with; every
  round of one generation uses the same provider.
- `GET /api/config` keeps its shape: `provider` and `model` are the active ones.
- Every `/api/providers*` request and every `POST /api/config` must be
  same-origin: the server rejects (403) a request whose `Origin` header is
  present and differs from its own origin, or whose `Host` is not the address
  it listens on, and (415) a body that is not `application/json`. This stops
  another web page from pointing the app at its own endpoint.
- `baseURL` must be `https:`, or `http:` on `localhost` / `127.0.0.1` (tests).

## Stream format

`text/event-stream`. One message per event:

```
id: 42
data: {"seq":42,"ts":1731580000000,"type":"node.delta","id":"n_7","field":"body","text":"Hel"}

```

A `: ping` comment is sent every 15 seconds. Deltas for different nodes
interleave freely; that interleaving is the point.

## Saved cards

`state.folders` is the list of folders `{ id, name }` the person made for saved cards. `state.saved` maps a card id to `{ ts, follow, folderId?, x?, y?, w?, h? }`: a card the person
kept, whether its follow-ups show on the saved board (default true), and where
it was dragged (absent until moved; the page places such cards itself).

| Method and path | Body | Effect |
| --- | --- | --- |
| `POST /api/cards/:id/save` | `{ saved: boolean, folderId?, w?, h? }` | save or unsave a card (`card.save` event); saving twice writes nothing |
| `POST /api/folders` · `PATCH /api/folders/:id` · `DELETE /api/folders/:id` | `{ name }` | make, rename or delete a folder (its cards stay saved, with no folder) |
| `PATCH /api/saved/:id` | `{ x, y }`, `{ w, h }`, `{ follow }` and/or `{ folderId }` (null: no folder) | move a saved card, or show or hide its follow-ups (`card.place` event); 404 when the card is not saved |

Deleting a chat removes its saved cards.
