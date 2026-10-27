// In-memory cache of the Settings doc so every WhatsApp send doesn't hit
// Mongo just to read the currency code. Invalidated explicitly on save
// (shared/operations.js#updateLoyaltySettings) rather than on a TTL, since
// Settings changes are rare and admin-driven.
//
// Per-workspace (one app, many customers): getSettings / getCurrency / invalidate take an OPTIONAL workspaceId.
//   - an id given            -> that workspace's own Settings document
//   - no id, inside a request / scheduler sweep (utils/senderContext.js) -> the workspace of that context
//   - no id and no context   -> today's behaviour: the FIRST Settings document in the database
// Every existing call site passes no argument, so each keeps working unchanged: a request or a flow sweep now reads
// its own customer's currency, anything with no context still reads the first document.
//
// Per-workspace entries also expire after WORKSPACE_TTL_MS as a safety net: ops.updateLoyaltySettings() invalidates
// through the CALLER's context, and a super admin saving another customer's settings runs in a different one.
// The legacy first-document entry keeps the old never-expires behaviour.
const mongoose = require('mongoose');
const Settings = require('../models/Settings');
const Workspace = require('../models/Workspace');
const senderContext = require('./senderContext');

const WORKSPACE_TTL_MS = 5 * 60 * 1000;

let cached = null;   // legacy: the first Settings document (no workspace known)
let inflight = null;
const byWorkspace = new Map(); // workspaceId string -> { doc, at }
const inflightByWorkspace = new Map(); // workspaceId string -> Promise

// -> a 24-hex workspace id string, or null (= legacy first-document behaviour)
function resolveKey(workspaceId) {
  const raw = workspaceId || senderContext.currentWorkspaceId();
  if (!raw) return null;
  const id = String(raw);
  return /^[0-9a-fA-F]{24}$/.test(id) && mongoose.isValidObjectId(id) ? id : null;
}

async function loadLegacy() {
  return (await Settings.findOne()) || (await Settings.create({}));
}

// The workspace's own document. A pre-multi-tenant document with no workspaceId belongs to the OLDEST workspace (the
// live demo), so that workspace keeps reading it instead of silently getting fresh defaults. Any other workspace
// without a document gets one created, stamped with its id (a read never creates an unscoped document).
async function loadForWorkspace(id) {
  const own = await Settings.findOne({ workspaceId: id });
  if (own) return own;
  const orphan = await Settings.findOne({ workspaceId: null });
  if (orphan) {
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id');
    if (oldest && String(oldest._id) === id) return orphan;
  }
  return Settings.create({ workspaceId: id });
}

async function getSettings(workspaceId) {
  const key = resolveKey(workspaceId);
  if (!key) {
    if (cached) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const doc = await loadLegacy();
        cached = doc;
        return doc;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  const hit = byWorkspace.get(key);
  if (hit && Date.now() - hit.at < WORKSPACE_TTL_MS) return hit.doc;
  const pending = inflightByWorkspace.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const doc = await loadForWorkspace(key);
      // An invalidate() that landed while this read was in flight removed this promise: do not store a stale document.
      if (inflightByWorkspace.get(key) === p) byWorkspace.set(key, { doc, at: Date.now() });
      return doc;
    } finally {
      if (inflightByWorkspace.get(key) === p) inflightByWorkspace.delete(key);
    }
  })();
  inflightByWorkspace.set(key, p);
  return p;
}

async function getCurrency(workspaceId) {
  const settings = await getSettings(workspaceId);
  return settings.currency || 'AUD';
}

// invalidate(id)  -> that workspace's entry (and the legacy first-document entry, which may be the same document)
// invalidate()    -> the current context's workspace; with no context at all, EVERYTHING (today's behaviour, a superset)
function invalidate(workspaceId) {
  const key = resolveKey(workspaceId);
  cached = null;
  if (key) {
    byWorkspace.delete(key);
    inflightByWorkspace.delete(key);
  } else if (!workspaceId && !senderContext.currentWorkspaceId()) {
    byWorkspace.clear();
    inflightByWorkspace.clear();
  }
}

module.exports = { getSettings, getCurrency, invalidate };
