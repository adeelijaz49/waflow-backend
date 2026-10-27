'use strict';
// Keeps a merchant's custom promotion message honest about Meta's approval, and tells them when it is safe to send.
//
// A promotion's custom entry message is a WhatsApp template that Meta must approve (minutes to a day). When the merchant
// tries to send before that, shared/operations.js#sendPromotion submits it, blocks the send and records
// Promotion.sendRequest. This module is what notices the approval afterwards:
//
//   sweep()                      every 5 minutes (SchedulerLock, TEMPLATE_APPROVAL_SWEEP=off disables the timer): re-reads
//                                the status of every entry node still 'pending'.
//   handleTemplateStatusEvent    Meta's message_template_status_update webhook: finds the node by template name and RE-READS
//                                its status from Graph through that workspace's own sender. The payload is never trusted
//                                (the webhook is an unauthenticated POST unless the signature is enforced).
//   markApprovedNotice(node)     raises "approved, you can now send the messages you intended" on every promotion of that
//                                workspace that uses the node and still has an undismissed send request.
//
// Everything here fails open: a Graph error, a missing model or a bad payload costs one logged line, never the sweep, the
// webhook or the process. shared/operations.js is required LAZILY (operations.js requires this module lazily too).
const senderContext = require('../utils/senderContext');

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_ID = 'templateApprovalSweep';
const LOCK_MARGIN_MS = 30 * 1000;
const MAX_NODES_PER_SWEEP = 200;

let timerHandle = null;

const LAZY = {
  MessageNode: () => require('../models/MessageNode'),
  Promotion: () => require('../models/Promotion'),
  SchedulerLock: () => require('../models/SchedulerLock'),
  // Re-reads the status through the sender of the node's workspace (the caller wraps it in senderContext.run).
  refreshNode: () => (node) => require('./operations').refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: node.workspaceId }),
  now: () => () => Date.now(),
  log: () => (...a) => console.error('[templateApproval]', ...a),
};
function dep(deps, name) {
  return deps && deps[name] !== undefined ? deps[name] : LAZY[name]();
}

function sweepEnabled() {
  return require('../utils/envFlag').isOn('TEMPLATE_APPROVAL_SWEEP', true);
}

function envInterval() {
  const n = Number(process.env.TEMPLATE_APPROVAL_SWEEP_INTERVAL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_INTERVAL_MS;
}

// The promotions waiting for this node: same workspace, entryNodeId is the node, a send request exists and has not been
// dismissed, and no notice was raised yet (so a second pass changes nothing).
async function markApprovedNotice(node, deps) {
  const log = dep(deps, 'log');
  try {
    if (!node || !node._id) return { matched: 0, modified: 0 };
    const filter = {
      entryNodeId: node._id,
      sendRequest: { $exists: true, $ne: null },
      'sendRequest.dismissedAt': null,
      'sendRequest.approvedNoticeAt': null,
    };
    if (node.workspaceId) filter.workspaceId = node.workspaceId;
    const res = await dep(deps, 'Promotion').updateMany(filter, { $set: { 'sendRequest.approvedNoticeAt': new Date(dep(deps, 'now')()) } });
    return { matched: (res && (res.matchedCount ?? res.n)) || 0, modified: (res && (res.modifiedCount ?? res.nModified)) || 0 };
  } catch (err) {
    log('could not raise the approved notice (ignored):', err && err.message);
    return { matched: 0, modified: 0, error: err && err.message };
  }
}

// One node: re-read its status inside its workspace's sender context; on a transition to approved stamp
// templateApprovedAt and raise the notice. Returns { nodeId, from, to }.
async function refreshOne(node, deps) {
  const log = dep(deps, 'log');
  const from = node.templateStatus;
  const MessageNode = dep(deps, 'MessageNode');
  const refreshNode = dep(deps, 'refreshNode');
  const workspaceId = node.workspaceId ? String(node.workspaceId) : null;
  const result = await senderContext.run(workspaceId, () => refreshNode(node));
  let to = result && result.templateStatus;
  if (!to) {
    const fresh = await MessageNode.findById(node._id).lean();
    to = fresh && fresh.templateStatus;
  }
  if (to === 'approved' && from !== 'approved') {
    try {
      await MessageNode.updateOne({ _id: node._id, templateApprovedAt: null }, { $set: { templateApprovedAt: new Date(dep(deps, 'now')()) } });
    } catch (err) { log('could not stamp templateApprovedAt (ignored):', err && err.message); }
    await markApprovedNotice({ _id: node._id, workspaceId: node.workspaceId }, deps);
  }
  return { nodeId: String(node._id), from, to: to || from };
}

// One pass over the pending templates. Lock-free on purpose: every step is idempotent, and the timer wraps it in the lock.
// Never throws; returns { checked, approved, rejected, failed }.
async function sweep(deps) {
  const log = dep(deps, 'log');
  const out = { checked: 0, approved: 0, rejected: 0, failed: 0 };
  try {
    // Sorted by _id only (always indexed): Cosmos DB for MongoDB rejects a multi-field sort no compound index serves, which would make
    // every sweep fail. The least recently checked come first, ordered in memory.
    const pending = await dep(deps, 'MessageNode')
      .find({ templateStatus: 'pending', templateName: { $exists: true, $ne: null } })
      .sort({ _id: 1 })
      .limit(MAX_NODES_PER_SWEEP * 2)
      .lean();
    const checkedAt = (n) => (n && n.templateLastCheckedAt ? new Date(n.templateLastCheckedAt).getTime() : 0);
    const nodes = (pending || []).slice().sort((a, b) => checkedAt(a) - checkedAt(b)).slice(0, MAX_NODES_PER_SWEEP);
    for (const node of nodes) {
      try {
        const r = await refreshOne(node, deps);
        out.checked += 1;
        if (r.to === 'approved' && r.from !== 'approved') out.approved += 1;
        if (r.to === 'rejected' && r.from !== 'rejected') out.rejected += 1;
      } catch (err) {
        out.failed += 1;
        log(`status check failed for node ${node && node._id} (continuing):`, err && err.message);
      }
    }
  } catch (err) {
    log('sweep failed (ignored):', err && err.message);
  }
  return out;
}

// Meta's message_template_status_update. `value` = { event, message_template_id, message_template_name, ... }.
// The payload only says WHICH template changed; the status itself is read from Graph.
async function handleTemplateStatusEvent({ value } = {}, deps) {
  const log = dep(deps, 'log');
  try {
    const name = value && typeof value.message_template_name === 'string' ? value.message_template_name.trim() : '';
    if (!name) return { handled: false, reason: 'no_template_name' };
    const nodes = await dep(deps, 'MessageNode').find({ templateName: name }).limit(5).lean();
    if (!nodes || !nodes.length) return { handled: false, reason: 'no_node' }; // a fixed WaFlow template, or another app's
    const results = [];
    for (const node of nodes) {
      try {
        results.push(await refreshOne(node, deps));
      } catch (err) {
        log(`status re-read failed for template ${name} (ignored):`, err && err.message);
        results.push({ nodeId: String(node._id), error: err && err.message });
      }
    }
    return { handled: true, results };
  } catch (err) {
    log('template status event failed (ignored):', err && err.message);
    return { handled: false, reason: 'error', error: err && err.message };
  }
}

// Classic Mongo TTL lock (same recipe as shared/localization/scheduler.js). True when this process may sweep.
async function acquireLock(deps, intervalMs) {
  const SchedulerLock = dep(deps, 'SchedulerLock');
  const now = new Date(dep(deps, 'now')());
  const lockedUntil = new Date(now.getTime() + Math.max(intervalMs - LOCK_MARGIN_MS, 1000));
  const renewed = await SchedulerLock.findOneAndUpdate(
    { _id: LOCK_ID, lockedUntil: { $lt: now } },
    { $set: { lockedAt: now, lockedUntil } },
    { returnDocument: 'after' },
  );
  if (renewed) return true;
  try {
    await SchedulerLock.create({ _id: LOCK_ID, lockedAt: now, lockedUntil });
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false; // another instance holds a live lock
    throw err;
  }
}

function tick(deps, intervalMs) {
  const log = dep(deps, 'log');
  return acquireLock(deps, intervalMs)
    .then((ok) => (ok ? sweep(deps) : null))
    .catch((err) => { log('tick error:', err && err.message); return null; });
}

// Idempotent. Nothing runs at require time; the timer is unref()'d so it never keeps Jest or a CLI alive.
function startTemplateApprovalSweeper({ intervalMs, deps, setIntervalFn = setInterval } = {}) {
  if (!sweepEnabled()) return null;
  if (timerHandle) return timerHandle;
  const every = Number.isFinite(intervalMs) && intervalMs >= 1000 ? intervalMs : envInterval();
  tick(deps, every);
  timerHandle = setIntervalFn(() => { tick(deps, every); }, every);
  if (timerHandle && typeof timerHandle.unref === 'function') timerHandle.unref();
  return timerHandle;
}

function stopTemplateApprovalSweeper(clearIntervalFn = clearInterval) {
  if (timerHandle) clearIntervalFn(timerHandle);
  timerHandle = null;
}

module.exports = {
  sweep, startTemplateApprovalSweeper, stopTemplateApprovalSweeper, handleTemplateStatusEvent, markApprovedNotice,
  acquireLock, tick, LOCK_ID, DEFAULT_INTERVAL_MS,
};
