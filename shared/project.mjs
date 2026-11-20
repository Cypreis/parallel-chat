// Shared reducer for parallel chat.
// Runs unchanged in the browser and in Node: no DOM APIs, no Node APIs.
// See protocol.md for the event table this implements.

export function createState() {
  return { seq: 0, nodes: {}, order: [], edges: [], decisions: [], chatMeta: {}, groups: [], notes: {}, docs: [], saved: {}, folders: [] };
}

const validSize = (n) => Number.isFinite(n) && n >= 120 && n <= 4000;

// Fields a chat.meta patch may set.
export const CHAT_META_FIELDS = ["title", "groupId", "pinned"];

// Mutates and returns state. Events with seq <= state.seq are ignored, so
// replaying a stream that overlaps what the client already has is safe.
export function applyEvent(state, event) {
  if (!event || typeof event.seq !== "number" || event.seq <= state.seq) return state;
  state.seq = event.seq;

  switch (event.type) {
    case "session.reset": {
      state.nodes = {};
      state.order = [];
      state.edges = [];
      state.decisions = [];
      state.chatMeta = {};
      state.groups = [];
      state.notes = {};
      state.docs = [];
      state.saved = {};
      state.folders = [];
      break;
    }
    case "node.open": {
      if (!event.node || !event.node.id) break;
      // Copy so later deltas never mutate the logged event.
      const node = { ...event.node, seq: event.seq };
      if (!(node.id in state.nodes)) state.order.push(node.id);
      state.nodes[node.id] = node;
      break;
    }
    case "node.delta": {
      const node = state.nodes[event.id];
      if (!node || (event.field !== "summary" && event.field !== "body")) break;
      node[event.field] = (node[event.field] || "") + (event.text || "");
      break;
    }
    case "node.patch": {
      const node = state.nodes[event.id];
      if (!node || !event.patch) break;
      Object.assign(node, event.patch);
      break;
    }
    case "node.reset": {
      const node = state.nodes[event.id];
      if (!node) break;
      node.summary = "";
      node.body = "";
      node.status = "streaming";
      delete node.error;
      delete node.staleBecause;
      break;
    }
    case "node.close": {
      const node = state.nodes[event.id];
      if (!node) break;
      node.status = event.status;
      if (event.error !== undefined) node.error = event.error;
      break;
    }
    case "edge.add": {
      if (!event.edge || !event.edge.id) break;
      if (state.edges.some((e) => e.id === event.edge.id)) break;
      state.edges.push({ ...event.edge });
      break;
    }
    case "decision.pin": {
      const d = event.decision;
      if (!d || !d.id) break;
      const decision = { ...d, affects: Array.isArray(d.affects) ? [...d.affects] : [] };
      state.decisions = state.decisions.filter((x) => x.id !== decision.id);
      if (!("scope" in decision)) decision.scope = null;
      state.decisions.push(decision);
      markStale(state, decision);
      break;
    }
    case "decision.patch": {
      const d = state.decisions.find((x) => x.id === event.id);
      if (!d || !event.patch) break;
      const changed = typeof event.patch.text === "string" && event.patch.text !== d.text;
      if (typeof event.patch.text === "string") d.text = event.patch.text;
      if (Array.isArray(event.patch.affects)) d.affects = [...event.patch.affects];
      // An edited (or re-aimed) decision marks the cards it affects out of date again.
      if (changed || Array.isArray(event.patch.affects)) markStale(state, d);
      break;
    }
    case "chat.meta": {
      if (!event.chatId || !event.patch) break;
      const meta = { ...(state.chatMeta[event.chatId] ?? {}) };
      for (const k of CHAT_META_FIELDS) {
        if (!(k in event.patch)) continue;
        const v = event.patch[k];
        if (v === null || v === undefined || v === "" || v === false) delete meta[k];
        else meta[k] = v;
      }
      if (Object.keys(meta).length) state.chatMeta[event.chatId] = meta;
      else delete state.chatMeta[event.chatId];
      break;
    }
    case "chat.delete": {
      deleteChat(state, event.chatId);
      break;
    }
    case "group.add": {
      const g = event.group;
      if (!g || !g.id || state.groups.some((x) => x.id === g.id)) break;
      state.groups.push({ id: g.id, name: String(g.name ?? "") });
      break;
    }
    case "group.patch": {
      const g = state.groups.find((x) => x.id === event.id);
      if (!g || !event.patch) break;
      if (typeof event.patch.name === "string") g.name = event.patch.name;
      break;
    }
    case "group.remove": {
      state.groups = state.groups.filter((g) => g.id !== event.id);
      for (const [chatId, meta] of Object.entries(state.chatMeta)) {
        if (meta.groupId !== event.id) continue;
        delete meta.groupId;
        if (!Object.keys(meta).length) delete state.chatMeta[chatId];
      }
      break;
    }
    // Saved cards: a card the person kept, with where it sits on the saved board
    // (x, y; absent until it is moved) and whether its follow-ups show there.
    case "card.save": {
      if (!event.id) break;
      if (event.saved === false) delete state.saved[event.id];
      else if (state.nodes[event.id]?.kind === "card" && !state.saved[event.id]) {
        // w and h: the card's size on the board when it was saved, the size it first shows on the saved board
        const s = { ts: event.ts, follow: true };
        if (typeof event.folderId === "string" && state.folders.some((f) => f.id === event.folderId)) s.folderId = event.folderId;
        if (validSize(event.w)) s.w = Math.round(event.w);
        if (validSize(event.h)) s.h = Math.round(event.h);
        state.saved[event.id] = s;
      }
      break;
    }
    case "card.place": {
      const s = state.saved[event.id];
      if (!s || !event.patch) break;
      const p = event.patch;
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) { s.x = Math.round(p.x); s.y = Math.round(p.y); }
      if (typeof p.follow === "boolean") s.follow = p.follow;
      if (p.folderId === null) delete s.folderId; // out of its folder
      else if (typeof p.folderId === "string" && state.folders.some((f) => f.id === p.folderId)) s.folderId = p.folderId;
      if (validSize(p.w)) s.w = Math.round(p.w);
      if (p.h === null) delete s.h; // back to as tall as its text
      else if (validSize(p.h)) s.h = Math.round(p.h);
      break;
    }
    // Folders the person makes to sort saved cards. Deleting one keeps its cards, unfiled.
    case "folder.add": {
      const f = event.folder;
      if (!f || !f.id || state.folders.some((x) => x.id === f.id)) break;
      state.folders.push({ id: f.id, name: String(f.name ?? "") });
      break;
    }
    case "folder.patch": {
      const f = state.folders.find((x) => x.id === event.id);
      if (f && typeof event.patch?.name === "string") f.name = event.patch.name;
      break;
    }
    case "folder.remove": {
      state.folders = state.folders.filter((f) => f.id !== event.id);
      for (const s of Object.values(state.saved)) if (s.folderId === event.id) delete s.folderId;
      break;
    }
    case "note.set": {
      if (!event.targetId) break;
      const text = String(event.text ?? "");
      if (text.trim()) state.notes[event.targetId] = { text, ts: event.ts };
      else delete state.notes[event.targetId];
      break;
    }
    case "doc.add": {
      const d = event.doc;
      if (!d || !d.id || state.docs.some((x) => x.id === d.id)) break;
      state.docs.push({ ...d });
      break;
    }
    case "doc.remove": {
      state.docs = state.docs.filter((d) => d.id !== event.id);
      break;
    }
    case "decision.unpin": {
      state.decisions = state.decisions.filter((d) => d.id !== event.id);
      for (const id of state.order) {
        const node = state.nodes[id];
        if (node.status === "stale" && node.staleBecause === event.id) {
          node.status = "settled";
          delete node.staleBecause;
        }
      }
      break;
    }
    default:
      break;
  }
  return state;
}

function markStale(state, decision) {
  for (const cardId of decision.affects) {
    const node = state.nodes[cardId];
    if (node && node.kind === "card" && node.status === "settled") {
      node.status = "stale";
      node.staleBecause = decision.id;
    }
  }
}

// Every node id of a chat: its questions and everything they hold.
export function chatNodeIds(state, chatId) {
  const chat = chats(state).find((c) => c.id === chatId);
  if (!chat) return new Set();
  const qids = new Set(chat.questions.map((q) => q.id));
  const ids = new Set();
  for (const id of state.order) {
    const n = state.nodes[id];
    if (n && (qids.has(n.id) || qids.has(n.turnId))) ids.add(id);
  }
  return ids;
}

// Remove a chat and everything only it owned: its nodes, the links touching
// them, decisions scoped to it, its notes, documents and settings.
function deleteChat(state, chatId) {
  const ids = chatNodeIds(state, chatId);
  if (!ids.size) return;
  for (const id of ids) {
    delete state.nodes[id];
    delete state.notes[id];
    delete state.saved[id];
  }
  state.order = state.order.filter((id) => !ids.has(id));
  state.edges = state.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  const gone = new Set(state.decisions.filter((d) => d.scope === chatId).map((d) => d.id));
  state.decisions = state.decisions.filter((d) => !gone.has(d.id));
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node.status === "stale" && gone.has(node.staleBecause)) {
      node.status = "settled";
      delete node.staleBecause;
    }
  }
  for (const d of state.decisions) {
    d.affects = d.affects.filter((id) => !ids.has(id));
    if (d.sourceNodeId && ids.has(d.sourceNodeId)) d.sourceNodeId = null;
  }
  state.docs = state.docs.filter((d) => d.chatId !== chatId);
  delete state.chatMeta[chatId];
}

// Decisions that apply in a chat: those scoped to it plus those for every
// chat (scope null), in pin order.
export function decisionsFor(state, chatId) {
  return state.decisions.filter((d) => !d.scope || d.scope === chatId);
}

// Documents attached to a chat, in the order they were added.
export function docsOf(state, chatId) {
  return state.docs.filter((d) => d.chatId === chatId);
}

function inOrder(state, predicate) {
  const out = [];
  for (const id of state.order) {
    const node = state.nodes[id];
    if (node && predicate(node)) out.push(node);
  }
  return out;
}

export function turns(state) {
  return inOrder(state, (n) => n.kind === "question");
}

export function cardsOf(state, questionId) {
  return inOrder(state, (n) => n.kind === "card" && n.parentId === questionId);
}

export function threadOf(state, cardId) {
  return inOrder(state, (n) => n.kind === "message" && n.parentId === cardId);
}

export function edgesOf(state, cardId) {
  return state.edges.filter((e) => e.from === cardId || e.to === cardId);
}

// A chat is a first question (no chatId) plus every question whose chatId is
// its id, in seq order. A chatId that names no earlier first question starts
// a chat of its own.
export function chats(state) {
  const out = [];
  const byId = new Map();
  for (const q of turns(state)) {
    const chat = q.chatId ? byId.get(q.chatId) : null;
    if (chat) chat.questions.push(q);
    else {
      const fresh = { id: q.id, questions: [q] };
      byId.set(q.id, fresh);
      out.push(fresh);
    }
  }
  return out;
}

// Id of the chat (its first question) that holds this node; null if unknown.
export function chatOf(state, nodeId) {
  const node = state.nodes[nodeId];
  if (!node) return null;
  const q = node.kind === "question" ? node : state.nodes[node.turnId];
  if (!q || q.kind !== "question") return null;
  return chatRoot(state, q, 0);
}

// Same rule as chats(): join the chat only when chatId names an earlier
// question that itself started a chat.
function chatRoot(state, q, depth) {
  const first = q.chatId ? state.nodes[q.chatId] : null;
  if (!first || first.kind !== "question" || !(first.seq < q.seq) || depth > 100) return q.id;
  return chatRoot(state, first, depth + 1) === first.id ? first.id : q.id;
}

// The question's cards in display order: a card with `origin` comes right
// after its source card and after that source's earlier branches (and theirs).
export function cardsInOrder(state, questionId) {
  const cards = cardsOf(state, questionId);
  const ids = new Set(cards.map((c) => c.id));
  const branches = new Map();
  const roots = [];
  for (const c of cards) {
    const source = c.origin?.cardId;
    if (source && ids.has(source) && source !== c.id) {
      if (!branches.has(source)) branches.set(source, []);
      branches.get(source).push(c);
    } else roots.push(c);
  }
  const out = [];
  const seen = new Set();
  const visit = (card) => {
    if (seen.has(card.id)) return;
    seen.add(card.id);
    out.push(card);
    for (const b of branches.get(card.id) ?? []) visit(b);
  };
  roots.forEach(visit);
  for (const c of cards) visit(c); // anything left by a malformed origin cycle
  return out;
}

export function cardOf(state, nodeId) {
  const node = state.nodes[nodeId];
  if (!node) return null;
  if (node.kind === "card") return node;
  if (node.kind === "message") {
    const parent = state.nodes[node.parentId];
    return parent && parent.kind === "card" ? parent : null;
  }
  return null;
}
