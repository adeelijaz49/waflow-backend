// In-memory collaborators for the templates service (used by the HTTP tests): a store with the
// same single-document atomicity as MongoDB, a fake Meta client and a fake transport. Nothing here
// can reach a database, the network or WhatsApp.
const mt = require('../../../shared/localization/metaTemplates');

function makeMemoryStore(now) {
  const docs = [];
  let seq = 0;
  const find = (ws, id) => docs.find((d) => d._id === id && d.workspaceId === ws);
  const guardMatches = (v, guard) => Object.entries(guard || {}).every(([k, want]) => (v[k] === undefined ? null : v[k]) === want);
  return {
    docs,
    async create(doc) {
      if (docs.some((d) => d.workspaceId === doc.workspaceId && d.key === doc.key)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      seq += 1;
      const stored = structuredClone({ ...doc, _id: seq.toString(16).padStart(24, '0'), createdAt: now(), updatedAt: now() });
      docs.push(stored);
      return structuredClone(stored);
    },
    async findOne(ws, id) {
      const d = find(ws, id);
      return d ? structuredClone(d) : null;
    },
    async list(ws, { useCase, archived } = {}) {
      return docs
        .filter((d) => d.workspaceId === ws && (!useCase || d.useCase === useCase)
          && (archived === 'only' ? d.archived === true : archived === 'include' ? true : d.archived !== true))
        .map((d) => structuredClone(d));
    },
    async setFields(ws, id, set) {
      const d = find(ws, id);
      if (!d) return false;
      Object.assign(d, structuredClone(set));
      d.updatedAt = now();
      return true;
    },
    async insertVariant(ws, id, language, variantDoc) {
      const d = find(ws, id);
      if (!d || d.variants.some((v) => v.language === language)) return false;
      d.variants.push(structuredClone(variantDoc));
      return true;
    },
    async updateVariant(ws, id, language, { guard, set, unset, inc } = {}) {
      const d = find(ws, id);
      const v = d && d.variants.find((x) => x.language === language && guardMatches(x, guard));
      if (!v) return false;
      Object.assign(v, structuredClone(set || {}));
      for (const key of unset || []) delete v[key];
      for (const [key, by] of Object.entries(inc || {})) v[key] = (v[key] || 0) + by;
      d.updatedAt = now();
      return true;
    },
    async findByMetaNames(names, limit) {
      return docs.filter((d) => d.variants.some((v) => names.includes(v.metaTemplateName))).slice(0, limit).map((d) => structuredClone(d));
    },
    async findRefreshCandidates({ statuses, limit }) {
      return docs.filter((d) => d.archived !== true && d.variants.some((v) => statuses.includes(v.metaStatus) && v.metaTemplateName)).slice(0, limit).map((d) => structuredClone(d));
    },
  };
}

function makeMeta() {
  const m = {
    configured: true,
    submitCalls: [],
    listCalls: [],
    byIdCalls: [],
    rows: new Map(),
    usage: { used: 15, limit: 250 },
    submitImpl: null,
    async assertConfigured() {
      if (!m.configured) throw new mt.MetaNotConfiguredError('no token');
      return true;
    },
    async submitTemplate(payload) {
      m.submitCalls.push(payload);
      if (m.submitImpl) return m.submitImpl(payload);
      return { id: `tpl-${m.submitCalls.length}`, status: 'PENDING', category: payload.category };
    },
    async listTemplatesByName(name) {
      m.listCalls.push(name);
      return m.rows.get(name) || [];
    },
    async getTemplateById(id) {
      m.byIdCalls.push(id);
      for (const rows of m.rows.values()) {
        const row = rows.find((r) => String(r.id) === String(id));
        if (row) return { ...row };
      }
      return null;
    },
    async listTemplatesSince() { return []; },
    async getUsage() {
      if (m.usage instanceof Error) throw m.usage;
      return m.usage;
    },
  };
  return m;
}

function makeTransport() {
  const t = {
    dry: false,
    sent: [],
    isDryRun: () => t.dry,
    sendTemplate: async (to, args) => {
      t.sent.push({ to, args });
      return { messages: [{ id: 'wamid.TEST' }] };
    },
  };
  return t;
}

module.exports = { makeMemoryStore, makeMeta, makeTransport };
