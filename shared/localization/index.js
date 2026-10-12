'use strict';
// Entry point of the Arabic localisation feature as seen by server.js.
// server.js touches this feature in exactly three places (all additive):
//   1. require('./shared/localization')            -> this file
//   2. app.use('/api/localization', requireAuth, require('./routes/localization')) (+ admin + customer-page mounts)
//   3. one call in the WhatsApp webhook, right after the Inbox hook:
//        if (await localization.handleInbound({ workspaceId, from, message, contactName })) return;
//
// handleInbound is the only function the existing webhook runs. It must NEVER
// throw and must return false (meaning: carry on with the existing flow) for
// anything it does not fully handle — see shared/localization/inboundHook.js.
let hook = null;

async function handleInbound(args) {
  try {
    if (!hook) hook = require('./inboundHook');
    return await hook.handleInbound(args);
  } catch (err) {
    console.error('[localization] handleInbound failed (ignored, existing flow continues):', err && err.message);
    return false;
  }
}

// ── Webhook journey (D3): three more never-throwing wrappers ─────────────────────────────────────────────
//   localizeOutbound(body) - called from BOTH waPost functions (server.js, utils/whatsapp.js). Returns the SAME body object
//     synchronously unless an Arabic version applies (then a Promise of the Arabic payload; it never rejects).
//   enterContext(workspaceId) - the webhook / Stripe handlers scope the outbound-language lookup to their workspace.
//   optOutSamePhone(args) - H1: opts out every same-workspace record of the sender's number (see samePhone.js).
let outbound = null;
let samePhone = null;

function localizeOutbound(body) {
  try {
    if (!outbound) outbound = require('./outbound');
    if (!outbound.mayApply(body)) return body;
    return outbound.apply(body);
  } catch (err) {
    return body;
  }
}

function enterContext(workspaceId) {
  try {
    if (!outbound) outbound = require('./outbound');
    outbound.enterContext(workspaceId);
  } catch (err) { /* never throws */ }
}

async function optOutSamePhone(args) {
  try {
    if (!samePhone) samePhone = require('./samePhone');
    return await samePhone.optOutSamePhone(args);
  } catch (err) {
    console.error('[localization] optOutSamePhone failed (ignored):', err && err.message);
    return { matched: 0, optedOut: 0, failed: 0 };
  }
}

module.exports = { handleInbound, localizeOutbound, enterContext, optOutSamePhone };
