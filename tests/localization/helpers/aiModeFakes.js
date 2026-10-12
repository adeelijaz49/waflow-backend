// Shared fakes for the AI Mode tests (not a test file: Jest only runs *.test.js).
// Nothing here touches the Anthropic API, MongoDB, Stripe or the network:
//   scriptedClient         a fake Anthropic client that replays scripted responses
//   loadRealToolDefinitions the REAL ai/tools.js registry definitions, loaded with
//                          every dependency stubbed (so no Stripe client, no DB)
//   recorderRegistry       a registry over those definitions whose run() is a jest.fn
//   createMemorySessionStore  the session-store interface, in memory, with the same
//                          ownership and atomic-claim rules as the Mongo store
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');

const text = (t) => ({ type: 'text', text: t });
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
function response(content, extra = {}) {
  return {
    content,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20 },
    ...extra,
  };
}

// responses: an array replayed in order (the last one repeats), or a function
// (callNumber, body) => response | Error. `calls` holds deep copies of each request.
function scriptedClient(responses) {
  const calls = [];
  let next = 0;
  const create = jest.fn(async (body, options) => {
    calls.push({ body: JSON.parse(JSON.stringify(body)), options });
    const out = typeof responses === 'function' ? responses(calls.length, body) : responses[Math.min(next++, responses.length - 1)];
    if (out instanceof Error) throw out;
    return out;
  });
  return { messages: { create }, calls };
}

// Evaluates ai/tools.js with `require` stubbed: only the two modules it imports are
// allowed, and both are empty objects, so nothing real can be reached.
function loadRealToolDefinitions() {
  const src = fs.readFileSync(path.join(ROOT, 'ai', 'tools.js'), 'utf8');
  const mod = { exports: {} };
  const stubRequire = (id) => {
    if (id === '../shared/operations' || id === '../shared/insights') return {};
    throw new Error(`ai/tools.js required something unexpected: ${id}`);
  };
  new Function('module', 'exports', 'require', src)(mod, mod.exports, stubRequire);
  return mod.exports;
}

// A registry with the same names, descriptions, schemas and isAction flags as the
// real one, where every run() is a jest.fn returning `results[name]` (or {ok:true}).
function recorderRegistry(results = {}) {
  const real = loadRealToolDefinitions();
  const runs = {};
  const TOOLS = real.TOOLS.map((tool) => {
    runs[tool.name] = jest.fn(async () => (results[tool.name] !== undefined ? results[tool.name] : { ok: true }));
    return { ...tool, run: runs[tool.name] };
  });
  return {
    runs,
    registry: {
      TOOLS,
      getTool: (name) => TOOLS.find((t) => t.name === name),
      toolsForClaude: () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
    },
  };
}

// A small hand-made registry: defs = [{ name, isAction, input_schema, run }].
function makeRegistry(defs) {
  const TOOLS = defs.map((d) => ({
    description: `${d.name} (test)`,
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    isAction: false,
    run: jest.fn(async () => ({ ok: true })),
    ...d,
  }));
  return {
    TOOLS,
    getTool: (name) => TOOLS.find((t) => t.name === name),
    toolsForClaude: () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v), (k, val) => (typeof val === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(val) ? new Date(val) : val));

function codedError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Same contract as sessionStore.js. find/findOrCreate return COPIES, like a database read.
function createMemorySessionStore() {
  const docs = new Map(); // sessionId -> { workspaceId, messages, pendingAction }
  const view = (sessionId, doc) => ({ sessionId, workspaceId: doc.workspaceId, messages: clone(doc.messages), pendingAction: clone(doc.pendingAction) });
  return {
    docs,
    async find(sessionId, workspaceId) {
      const doc = docs.get(sessionId);
      return doc && doc.workspaceId === String(workspaceId) ? view(sessionId, doc) : null;
    },
    async findOrCreate(sessionId, workspaceId) {
      const doc = docs.get(sessionId);
      if (doc) {
        if (doc.workspaceId !== String(workspaceId)) throw codedError(404, 'SESSION_NOT_FOUND', 'Session not found');
        return view(sessionId, doc);
      }
      return { sessionId, workspaceId: String(workspaceId), messages: [], pendingAction: null };
    },
    async saveTurn({ sessionId, workspaceId, messages, pendingAction }) {
      let doc = docs.get(sessionId);
      if (doc && doc.workspaceId !== String(workspaceId)) throw codedError(404, 'SESSION_NOT_FOUND', 'Session not found');
      if (!doc) { doc = { workspaceId: String(workspaceId), messages: [], pendingAction: null }; docs.set(sessionId, doc); }
      doc.messages.push(...clone(messages));
      doc.pendingAction = clone(pendingAction || null);
    },
    // Check-and-clear in one synchronous block: atomic, like the conditional update.
    async claimPendingAction({ sessionId, workspaceId, actionId }) {
      await Promise.resolve(); // yield, so concurrent callers really interleave
      const doc = docs.get(sessionId);
      if (!doc || doc.workspaceId !== String(workspaceId) || !doc.pendingAction || doc.pendingAction.id !== actionId) return false;
      doc.pendingAction = null;
      return true;
    },
    async appendMessages({ sessionId, workspaceId, messages }) {
      const doc = docs.get(sessionId);
      if (!doc || doc.workspaceId !== String(workspaceId)) return;
      doc.messages.push(...clone(messages));
    },
  };
}

const IDS = Object.freeze({
  promo: '65f2a1b3c4d5e6f708192a3b',
  promo2: '65f2a1b3c4d5e6f708192a4b',
  c1: '65f2a1b3c4d5e6f708192a3c',
  c2: '65f2a1b3c4d5e6f708192a3d',
  c3: '65f2a1b3c4d5e6f708192a3e',
  flow: '65f2a1b3c4d5e6f708192a5b',
  order: '65f2a1b3c4d5e6f708192a6b',
});

// Lookups that find everything and name it; override per test.
function makeLookups(overrides = {}) {
  return {
    promotion: jest.fn(async (ws, id) => ({ name: id === IDS.promo2 ? 'Eid Offer' : 'Summer Sale', isDemo: false })),
    flow: jest.fn(async () => ({ name: 'Win-back flow', status: 'paused' })),
    order: jest.fn(async () => ({ total: 150, currency: 'SAR', paymentStatus: 'paid', hasStripePayment: true, customerName: 'Sara Ali' })),
    customers: jest.fn(async (ws, ids) => ({ found: ids.length, names: ['Sara Ali', 'أحمد القحطاني', 'Khalid'].slice(0, Math.min(3, ids.length)) })),
    loyaltyAudience: jest.fn(async () => 87),
    ...overrides,
  };
}

module.exports = {
  ROOT, IDS, text, toolUse, response, scriptedClient, loadRealToolDefinitions, recorderRegistry, makeRegistry,
  createMemorySessionStore, makeLookups, codedError,
};
