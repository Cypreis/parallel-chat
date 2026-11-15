// Shared reducer for parallel chat.
// Runs unchanged in the browser and in Node: no DOM APIs, no Node APIs.
// See protocol.md for the event table this implements.

export function createState() {
  return { seq: 0, nodes: {}, order: [], edges: [], decisions: [] };
}

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
      state.decisions.push(decision);
      for (const cardId of decision.affects) {
        const node = state.nodes[cardId];
        if (node && node.kind === "card" && node.status === "settled") {
          node.status = "stale";
          node.staleBecause = decision.id;
        }
      }
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
