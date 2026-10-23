'use strict';
// Reusable "is this workspace allowed to send?" check (DB design 4.6 / 4.8):
// backs the flow scheduler hook (E5) and is available to service-level callers.
// FAIL-OPEN: any error means "allowed" - a failure here must never stop the
// existing app. With the flag off nothing is read at all.
const config = require('./config');
const gate = require('./gate');
const stateModule = require('./state');
const failOpen = require('./failOpen');

const CONNECT_CODES = ['WHATSAPP_NOT_CONNECTED', 'WHATSAPP_RECONNECT_REQUIRED'];

/**
 * The gate lookup is bounded by a 1.5 s timeout (R1-F3): a lookup that never settles means "allowed" (fail open, never cached) and one
 * throttled log line per minute.
 * @param {string} workspaceId
 * @param {{getGateState?:Function, lookupTimeoutMs?:number}} [deps]
 * @returns {Promise<{allowed:true}|{allowed:false, code:string, status:402, nextStep:string|null}>}
 */
async function checkSending(workspaceId, deps) {
  try {
    if (!config.enabled()) return { allowed: true };
    const getGateState = (deps && deps.getGateState) || stateModule.getGateState;
    const gs = await failOpen.withTimeout(() => getGateState(workspaceId), deps && deps.lookupTimeoutMs, 'gate lookup');
    if (!gs || !gs.enrolled) return { allowed: true };
    const r = gate.evaluate(gs, { kind: 'send' });
    if (r.allowed) return { allowed: true };
    return { allowed: false, code: r.code, status: 402, nextStep: r.nextStep };
  } catch (err) {
    failOpen.logFailOpen('sendGate', err);
    return { allowed: true };
  }
}

/** Throws Error{status:402, code, message} when sending is not allowed. */
async function assertSendingAllowed(workspaceId, deps) {
  const r = await checkSending(workspaceId, deps);
  if (r.allowed) return;
  const err = new Error(require('./errors').CODES[r.code].message);
  err.status = 402;
  err.code = r.code;
  err.nextStep = r.nextStep;
  throw err;
}

function utcDay(d) { return d.toISOString().slice(0, 10); }

/** Visible trail (DB 4.8): ONE notification + ONE event per (workspace, code, UTC day). Never throws. */
async function writeTrail(workspaceId, blocked, deps) {
  try {
    const notify = (deps && deps.notify) || require('./notifications').notify;
    const track = (deps && deps.track) || require('./analytics').track;
    const now = deps && deps.now ? deps.now() : new Date();
    const r = await notify({
      workspaceId: String(workspaceId),
      kind: 'sending_paused',
      dedupeKey: `send_blocked:${blocked.code}:${utcDay(now)}`,
      severity: 'warning',
      params: { code: blocked.code },
      actionPath: CONNECT_CODES.includes(blocked.code) ? '/setup/connect' : '/setup',
    });
    if (r && r.created) {
      await track(String(workspaceId), { type: 'send_blocked', code: blocked.code, step: blocked.nextStep || undefined });
    }
  } catch (_) { /* the trail never blocks */ }
}

/**
 * Used by utils/flowScheduler.js (hunk E5). false when the flag is off (no DB),
 * for legacy workspaces, when sending is allowed, and on ANY error.
 * @param {{workspaceId?:*}} flow
 * @returns {Promise<boolean>}
 */
async function flowBlocked(flow, deps) {
  try {
    if (!config.enabled()) return false;
    const workspaceId = flow && flow.workspaceId;
    if (!workspaceId) return false;
    const r = await checkSending(String(workspaceId), deps);
    if (r.allowed) return false;
    // the trail is best effort and bounded too: a write that never settles must not stall the flow sweep (the flow stays blocked)
    try { await failOpen.withTimeout(() => writeTrail(workspaceId, r, deps), deps && deps.lookupTimeoutMs, 'trail write'); } catch (err) { failOpen.logFailOpen('sendGate', err); }
    return true;
  } catch (err) {
    failOpen.logFailOpen('sendGate', err);
    return false;
  }
}

module.exports = { checkSending, assertSendingAllowed, flowBlocked };
