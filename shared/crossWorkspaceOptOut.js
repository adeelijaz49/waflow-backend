'use strict';
// Typed STOP / START on the SHARED platform WhatsApp number.
//
// On the shared number a customer sees ONE sender and cannot tell which business (workspace) a message came from, and a
// typed STOP carries no context to say which one. So:
//   STOP / UNSUBSCRIBE  opts the phone out in EVERY workspace that has a Customer with that phone (one ConsentEvent per
//                       customer record, written by shared/consent.js before the record changes) and sends ONE reply.
//   START / SUBSCRIBE   records a fresh opt-in ONLY for the workspace the event was attributed to (never for another business, and
//                       never for a workspace with a number of its own); where there is none, the existing "Got it - you won't
//                       receive promotional messages unless you opt in." reply.
// With a customer's OWN number (rule R1) STOP/START apply to that workspace only: server.js keeps its existing code path.
//
// The workspace the event was attributed to (opts.workspaceId) is ALWAYS processed exactly like the single-workspace code
// did (exact-phone lookup, then localization.optOutSamePhone for same-number duplicates), so a deployment with one workspace
// behaves byte-for-byte as before. Other workspaces are found by the exact stored spellings of the number.
//
// A workspace that sends from a WhatsApp number of its OWN is not reached by a STOP / START typed on the shared number: that
// message was addressed to the shared number, and that customer's people see its own number as a different sender. (The
// attributed workspace is always processed.)
//
// Collaborators are injectable (deps) so unit tests need no database. Never throws: a failure in one workspace is logged
// and the others still run; the reply still goes out.
const { phoneVariants } = require('./whatsappInbound');

const MAX_WORKSPACES = 50;

const STOP_REPLY = "You've been unsubscribed from promotional messages. Reply START to opt back in anytime.";
const START_REPLY_REINSTATED = "You're subscribed to promotional messages again. Welcome back! \u{1F389}";
const START_REPLY_NOT_REINSTATED = "Got it — you won't receive promotional messages unless you opt in.";

function realDeps() {
  return {
    Customer: require('../models/Customer'),
    Workspace: require('../models/Workspace'),
    consent: require('./consent'),
    optOutSamePhone: (args) => require('./localization').optOutSamePhone(args),
    send: (to, text) => require('../utils/whatsapp').waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
    log: (...a) => console.error(...a),
  };
}

const key = (v) => (v === undefined || v === null ? '' : String(v));

// The ids (strings) among `workspaceIds` that send from a WhatsApp number of their own (same rule as utils/waTenant.js: a phone
// id that is not switched off). Without a Workspace model (unit-test fakes) nothing is excluded.
async function usingOwnNumber(deps, workspaceIds) {
  if (!deps.Workspace || !workspaceIds.length) return new Set();
  const rows = await deps.Workspace.find({ _id: { $in: workspaceIds }, 'whatsapp.phoneId': { $exists: true, $nin: [null, ''] }, 'whatsapp.enabled': { $ne: false } }).select('_id').lean();
  return new Set((rows || []).map((r) => key(r && r._id)));
}

/**
 * Workspaces that have a (not erased) Customer with this phone and send from the shared number, the attributed workspace
 * first (with includeOwnNumber the ones that send from a number of their own are included too: used when it is not known which number
 * the message arrived on). Never throws.
 * @returns {Promise<string[]>} workspace ids (strings), at most MAX_WORKSPACES
 */
async function workspacesOf(deps, from, firstWorkspaceId, { includeOwnNumber = false } = {}) {
  const ids = [];
  const seen = new Set();
  let lookupFailed = false;
  const push = (v) => { const k = key(v); if (k && !seen.has(k)) { seen.add(k); ids.push(v); } };
  push(firstWorkspaceId);
  try {
    const variants = await phoneVariants(deps.phoneDeps, from);
    if (variants.length) {
      const rows = await deps.Customer.find({ phone: { $in: variants }, deletedAt: { $exists: false } }).select('workspaceId').limit(200).lean();
      const others = [];
      for (const r of rows || []) if (r && r.workspaceId) others.push(r.workspaceId);
      others.sort((a, b) => key(a).localeCompare(key(b)));
      const own = includeOwnNumber ? new Set() : await usingOwnNumber(deps, others.filter((v) => key(v) !== key(firstWorkspaceId)));
      others.filter((v) => !own.has(key(v))).forEach(push);
    }
  } catch (err) {
    deps.log('[inbound] cross-workspace phone lookup failed (only the attributed workspace is processed):', err && err.message);
    lookupFailed = true;
  }
  const out = ids.slice(0, MAX_WORKSPACES);
  if (lookupFailed) out.lookupFailed = true; // the callers do not confirm a command that may have missed other businesses
  return out;
}

// The per-customer evidence of a typed command. inboundWamid is unique per ConsentEvent, and one command touches several
// workspaces, so it is made unique per workspace (still stable across a Meta redelivery of the same message).
function evidenceFor({ messageText, wamid, signature }, workspaceId) {
  const evidence = {};
  if (messageText) evidence.messageText = String(messageText).slice(0, 200);
  if (wamid) evidence.inboundWamid = `${wamid}@${key(workspaceId)}`;
  if (signature) evidence.signature = signature;
  return evidence;
}

/**
 * Typed STOP / UNSUBSCRIBE on the shared number.
 * @param {{ from: string, method?: string, source?: string, messageText?: string, wamid?: string, workspaceId?: any, signature?: string,
 *           unattributed?: boolean, silent?: boolean }} args
 *   unattributed: the message could not be tied to a customer (the lookup kept failing): every customer that has the phone is opted out,
 *     those with a number of their own included, and the confirmation is sent only if somebody really was opted out;
 *   silent: opt out, but send no confirmation (the message arrived on a number the reply cannot leave from)
 * @param {object} [rawDeps] test seam: { Customer, consent, optOutSamePhone, send, log, phoneDeps }
 * @returns {Promise<{ workspaces: number, optedOut: number, failed: number, replied: boolean }>}
 */
async function optOutEverywhere(args, rawDeps) {
  const a = args || {};
  const deps = { ...realDeps(), ...(rawDeps || {}) };
  const result = { workspaces: 0, optedOut: 0, duplicates: 0, failed: 0, replied: false };
  const method = a.method || 'whatsapp_stop_command';
  const source = a.source || 'WhatsApp STOP reply';
  try {
    const workspaceIds = await workspacesOf(deps, a.from, a.workspaceId, { includeOwnNumber: a.unattributed === true });
    if (workspaceIds.lookupFailed) result.failed += 1;
    // Evidence (message text, inbound id) is added only when the command spans several businesses: with ONE workspace the
    // records are written exactly as the single-workspace code always wrote them.
    const multi = workspaceIds.length > 1;
    for (const workspaceId of workspaceIds) {
      result.workspaces += 1;
      try {
        const customer = await deps.Customer.findOne({ phone: a.from, workspaceId });
        if (customer) {
          const out = await deps.consent.withdrawMarketingConsent({ customer, method, source: multi ? `${source} (shared WhatsApp number)` : source, workspaceId, ...(multi ? { evidence: evidenceFor(a, workspaceId) } : {}) });
          if (out && out.duplicate) result.duplicates += 1; // a Meta redelivery of this very STOP: already recorded
          else result.optedOut += 1;
        }
        await deps.optOutSamePhone({ workspaceId, from: a.from, exceptCustomerId: customer && customer._id, method, source });
      } catch (err) {
        if (err && err.code === 11000) { result.duplicates += 1; continue; } // Meta redelivered this STOP: that workspace already has the event
        result.failed += 1;
        deps.log(`[inbound] STOP could not be applied in workspace ${key(workspaceId)} - the number may still receive marketing there:`, err && err.message);
      }
    }
  } catch (err) {
    deps.log('[inbound] STOP handling failed:', err && err.message);
  }
  // Never confirm an opt-out that did not happen: like the single-workspace branch (where a failed write ends the handler
  // before the reply), a failure means no confirmation, and the customer can simply send STOP again.
  if (result.failed > 0) return result;
  if (result.duplicates > 0 && result.optedOut === 0) return result; // a redelivery: the first delivery already answered
  if (a.silent) return result; // opted out, but the reply cannot leave from here
  if (a.unattributed === true && result.optedOut === 0) return result; // nobody was opted out: nothing to confirm
  try {
    await deps.send(a.from, STOP_REPLY);
    result.replied = true;
  } catch (_) { /* like the single-workspace branch: a failed reply is ignored */ }
  return result;
}

/**
 * Typed START / SUBSCRIBE on the shared number: a fresh opt-in for the business whose conversation this is.
 *
 * STOP goes to every business that sends from the shared number (nobody can say which one they mean), but START is the opposite
 * kind of statement: it asks a business to message you, and nobody can ask a business they never spoke to. So START applies ONLY to
 * the workspace the event was attributed to (their customer record, the exact phone); another business that a STOP opted out stays
 * opted out until its own customer asks it to message them again (its own consent request). A workspace with a number of its OWN is
 * not addressed by a START typed to the shared number at all. With CONSENT_REQUIRE_SIGNATURE=on the request must be Meta-signed.
 * @returns {Promise<{ workspaces: number, reinstated: number, failed: number, replied: boolean }>}
 */
async function startEverywhere(args, rawDeps) {
  const a = args || {};
  const deps = { ...realDeps(), ...(rawDeps || {}) };
  const result = { workspaces: 0, reinstated: 0, duplicates: 0, failed: 0, replied: false };
  const method = a.method || 'whatsapp_start_command';
  const source = a.source || 'WhatsApp START reply';
  try {
    const workspaceId = a.workspaceId;
    if (workspaceId) {
      result.workspaces = 1;
      const ownNumber = await usingOwnNumber(deps, [workspaceId]);
      if (!ownNumber.has(key(workspaceId))) {
        try {
          const customer = await deps.Customer.findOne({ phone: a.from, workspaceId });
          if (customer) {
            // A START from an opted-out customer is a FRESH opt-in (consent_given): it keeps its evidence - the words they typed, the
            // WhatsApp message id and the webhook signature. Anything else (a consented customer, one who never opted in) is written
            // as it always was.
            const freshOptIn = customer.optedOut === true;
            const done = await deps.consent.reinstateMarketingConsent({
              customer, method, source, workspaceId, signature: a.signature,
              ...(freshOptIn ? { evidence: evidenceFor(a, workspaceId) } : {}),
            });
            if (done && done.duplicate) result.duplicates += 1; // a Meta redelivery of this very START: already recorded
            else if (done) result.reinstated += 1;
          }
        } catch (err) {
          if (err && err.code === 11000) result.duplicates += 1;
          else {
            result.failed += 1;
            deps.log(`[inbound] START could not be applied in workspace ${key(workspaceId)}:`, err && err.message);
          }
        }
      }
    }
  } catch (err) {
    result.failed += 1;
    deps.log('[inbound] START handling failed:', err && err.message);
  }
  if (result.failed > 0) return result; // a failed write is never answered with a success message
  if (result.duplicates > 0 && result.reinstated === 0) return result; // a redelivery: the first delivery already answered
  try {
    await deps.send(a.from, result.reinstated > 0 ? START_REPLY_REINSTATED : START_REPLY_NOT_REINSTATED);
    result.replied = true;
  } catch (_) { /* ignored, as before */ }
  return result;
}

module.exports = { optOutEverywhere, startEverywhere, workspacesOf, STOP_REPLY, START_REPLY_REINSTATED, START_REPLY_NOT_REINSTATED };
