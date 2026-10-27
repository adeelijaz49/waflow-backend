'use strict';
// A customer tapped a quick-reply button of a promotion whose button carries a consent action. The payload is
// self-describing - `promo:<promotionId>:<action>:<position>` (see shared/operations.js#buildEntryButtonPayloads) - so a
// merchant editing the message afterwards can never change what an old tap meant.
//
//   opt_in      records a customer-initiated opt-in WITH EVIDENCE (what they were shown, which button they pressed, when),
//               clears a previous opt-out, and answers with the button's confirmation text.
//   opt_out     records the withdrawal (always honoured, whatever the signature) and answers with ONE short message.
//   interested  records the tap, flags the conversation open and, when the promotion has something to show, continues
//               into the normal shop/book flow (deps.handlePromoInterest, which lives in server.js).
//   end_flow    ("None") records the tap only.
//
// Rules worth knowing before changing anything here:
//  * Tenant and customer come from the CampaignMessage found by `context.id` - the wamid we got when we sent it, globally
//    unique - with NO workspace filter. The webhook may not know which customer (workspace) this event belongs to when
//    several share one WhatsApp number. Fallback: the latest CampaignMessage for that promotion and phone.
//  * The tapper's phone must be the customer's phone, and the promotion in the payload must be the promotion that message
//    belonged to. Anything else is refused (logged, nothing written).
//  * Idempotency is ConsentEvent.inboundWamid (unique, sparse), NOT CampaignMessage.respondedAt: a customer may legitimately
//    tap "Yes" and, later, "No thanks" on the same message, and latest action wins (the full history stays in the log).
//    A Meta redelivery is recognised by shared/consent.js and answered with no second reply.
//  * CONSENT_REQUIRE_SIGNATURE=on: an opt-IN is only applied when the webhook request's signature was valid. An opt-out is
//    always honoured. The signature verdict is stored in the evidence either way.
//  * Never throws: the webhook has already answered 200, so a failure is logged and swallowed.
const senderContext = require('../utils/senderContext');

const PAYLOAD_RE = /^promo:([0-9a-fA-F]{24}):([a-z_]{1,20}):(\d{1,2})$/;
const ACTIONS = ['opt_in', 'opt_out', 'interested', 'end_flow'];
const SIGNATURES = ['valid', 'invalid', 'missing', 'unconfigured'];

// Dependencies are resolved lazily and can each be replaced (tests inject fakes; nothing real is touched).
const LAZY = {
  CampaignMessage: () => require('../models/CampaignMessage'),
  Customer: () => require('../models/Customer'),
  Promotion: () => require('../models/Promotion'),
  MessageNode: () => require('../models/MessageNode'),
  Settings: () => require('../models/Settings'),
  Workspace: () => require('../models/Workspace'),
  consent: () => require('./consent'),
  sendText: () => defaultSendText,
  optOutSamePhone: () => (args) => require('./localization').optOutSamePhone(args),
  handlePromoInterest: () => null,
  businessName: () => defaultBusinessName,
  phonesMatch: () => defaultPhonesMatch,
  eventSeen: () => defaultEventSeen,
  now: () => () => new Date(),
  log: () => (...a) => console.error('[promoConsentTap]', ...a),
};
function dep(deps, name) {
  return deps && deps[name] !== undefined ? deps[name] : LAZY[name]();
}

const digitsOf = (x) => String(x == null ? '' : x).replace(/\D/g, '').replace(/^00/, '');

function parsePromoPayload(payload) {
  const m = PAYLOAD_RE.exec(String(payload || ''));
  if (!m) return null;
  return { promotionId: m[1], action: m[2], position: Number(m[3]) };
}

function requireSignature() {
  return require('../utils/envFlag').isOn('CONSENT_REQUIRE_SIGNATURE', false);
}

// Free-form text inside the 24 h window the tap just opened. The caller (send() below) runs it inside the sender context of
// the tapper's own workspace, so an injected sender (the webhook passes one) reaches that tenant's WhatsApp number too.
async function defaultSendText(to, body) {
  const { waPost } = require('../utils/whatsapp');
  return waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
}

async function defaultBusinessName(workspaceId, deps) {
  try {
    const s = await dep(deps, 'Settings').findOne({ workspaceId }).select('merchantName').lean();
    if (s && String(s.merchantName || '').trim()) return String(s.merchantName).trim();
  } catch (_) { /* fall through */ }
  try {
    const w = await dep(deps, 'Workspace').findById(workspaceId).select('name').lean();
    if (w && String(w.name || '').trim()) return String(w.name).trim();
  } catch (_) { /* fall through */ }
  return '';
}

// The stored phone is "as typed" (+61 4.., 0061.., 04..), the inbound one is international digits. Equal digits always
// match; otherwise the same normaliser the STOP handling uses (workspace country code) decides, so a till-captured local
// number still belongs to its owner.
async function defaultPhonesMatch(customerPhone, from, workspaceId) {
  const a = digitsOf(customerPhone);
  const b = digitsOf(from);
  if (a && a === b) return true;
  try {
    const samePhone = require('./localization/samePhone');
    const cc = await samePhone.countryCodeOf({ Settings: require('../models/Settings') }, workspaceId);
    return !!samePhone.sameNumber(customerPhone, from, cc);
  } catch (_) {
    return false;
  }
}

// Was this very inbound message already recorded? The unique index on ConsentEvent.inboundWamid is the real guard, but a database
// engine may refuse to build a unique index on a collection that already holds rows (Cosmos DB for MongoDB does), and a
// redelivered tap must never be recorded - or answered - twice. Never throws: when the lookup fails the tap is treated as new.
async function defaultEventSeen(inboundId) {
  try {
    return !!(await require('../models/ConsentEvent').findOne({ inboundWamid: inboundId }).select('_id').lean());
  } catch (_) {
    return false;
  }
}

// An opt-in tapped BEFORE the customer opted out (delivered late, or delivered again) is not a change of mind. Meta's tap time and
// our opt-out time come from two clocks, so only a clear margin counts.
const STALE_TAP_MARGIN_MS = 10 * 1000;

function tapTime(message) {
  const n = Number(message && message.timestamp);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const cleanText = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 1000) : '');

function defaultReplyText({ action, name, business, promotion }) {
  const who = name || 'there';
  if (action === 'opt_out') {
    return `No problem, ${who}. We won't send you any more offers. Reply START if you change your mind.`;
  }
  let text = `You're in! Thanks, ${who}. You'll now get offers from ${business || 'us'} here on WhatsApp. Reply STOP any time to opt out.`;
  const pct = Number(promotion && promotion.discountPercent);
  const code = promotion && (promotion.code || promotion.promoCode);
  if ((Number.isFinite(pct) && pct > 0) || code) {
    const parts = [];
    if (promotion && promotion.name) parts.push(promotion.name);
    if (Number.isFinite(pct) && pct > 0) parts.push(`${pct}% off`);
    let line = `Your offer: ${parts.join(' - ')}`;
    if (code) line += `. Code: ${code}`;
    text += `\n\n${line}`;
  }
  return text;
}

// Statistics only (never the idempotency key): the first tap sets clickedAt/respondedAt/clickedButtonPosition, the latest
// tap sets clickedButtonAction. Each write is independent and a failure never blocks the consent write.
async function recordTapStats({ CampaignMessage, cm, action, position, inboundId, now, log }) {
  const at = now();
  const set = { clickedButtonAction: action };
  if (inboundId) set.lastTapWamid = inboundId;
  const steps = [
    () => CampaignMessage.updateOne({ _id: cm._id }, { $set: set }),
    () => CampaignMessage.updateOne({ _id: cm._id, clickedAt: null }, { $set: { clickedAt: at } }),
    () => CampaignMessage.updateOne({ _id: cm._id, respondedAt: null }, { $set: { respondedAt: at, clickedButtonPosition: position } }),
  ];
  for (const step of steps) {
    try { await step(); } catch (err) { log('tap statistics write failed (ignored):', err && err.message); }
  }
}

async function handlePromoConsentTap({ from, message, signature, deps } = {}) {
  const log = dep(deps, 'log');
  try {
    return await processTap({ from, message, signature, deps: deps || {}, log });
  } catch (err) {
    try { log('tap failed (swallowed):', err && err.message); } catch (_) { /* nothing left to do */ }
    return { handled: false, outcome: 'error', error: err && err.message };
  }
}

async function processTap({ from, message, signature, deps, log }) {
  const msg = message || {};
  const btn = msg.button || {};
  const reply = (msg.interactive && msg.interactive.button_reply) || {};
  const parsed = parsePromoPayload(btn.payload || reply.id);
  if (!parsed) return { handled: false, outcome: 'not_a_promo_tap' };
  if (!ACTIONS.includes(parsed.action)) {
    log(`unknown action "${parsed.action}" in payload, ignored`);
    return { handled: false, outcome: 'unknown_action' };
  }
  const fromDigits = digitsOf(from);
  if (!fromDigits) return { handled: false, outcome: 'no_sender' };

  const CampaignMessage = dep(deps, 'CampaignMessage');
  const Customer = dep(deps, 'Customer');
  const Promotion = dep(deps, 'Promotion');
  const consent = dep(deps, 'consent');
  const now = dep(deps, 'now');
  const inboundId = typeof msg.id === 'string' && msg.id ? msg.id : undefined;
  const contextId = msg.context && msg.context.id;
  const label = cleanText(btn.text) || cleanText(reply.title);

  // 1. Which message was tapped? (no workspace filter: this is how the tenant is found)
  let cm = null;
  if (contextId) cm = await CampaignMessage.findOne({ wamid: contextId }).lean();
  if (!cm) {
    cm = await CampaignMessage.findOne({ promotion: parsed.promotionId, phone: { $in: [String(from), `+${fromDigits}`, fromDigits] } })
      .sort({ createdAt: -1 }).lean();
  }
  if (!cm) {
    log(`no campaign message for wamid ${contextId || '(none)'} / promotion ${parsed.promotionId}, ignored`);
    return { handled: false, outcome: 'unknown_message' };
  }
  if (!cm.promotion || String(cm.promotion) !== parsed.promotionId) {
    log('payload promotion differs from the tapped message promotion, ignored');
    return { handled: false, outcome: 'promotion_mismatch' };
  }

  let promotion = await Promotion.findById(parsed.promotionId).lean();
  if (!promotion) {
    // The promotion was deleted after the message went out. An opt-out is NEVER swallowed (the person asked to stop): it is handled
    // from what the message itself carries. Anything else needs the promotion.
    if (parsed.action !== 'opt_out') return { handled: false, outcome: 'promotion_not_found' };
    promotion = { _id: parsed.promotionId, name: (cm.consentSnapshot && cm.consentSnapshot.promotionName) || '', workspaceId: cm.workspaceId };
  }
  const workspaceId = cm.workspaceId || promotion.workspaceId;
  if (!workspaceId) return { handled: false, outcome: 'no_workspace' };
  if (cm.workspaceId && promotion.workspaceId && String(cm.workspaceId) !== String(promotion.workspaceId)) {
    log('campaign message and promotion belong to different workspaces, ignored');
    return { handled: false, outcome: 'workspace_mismatch' };
  }

  // 2. Whose tap is it? The customer comes from the message, never from a phone lookup.
  const customer = cm.customer ? await Customer.findById(cm.customer) : null;
  if (!customer) return { handled: false, outcome: 'customer_not_found' };
  if (customer.workspaceId && String(customer.workspaceId) !== String(workspaceId)) {
    log('customer belongs to another workspace than the message, ignored');
    return { handled: false, outcome: 'workspace_mismatch' };
  }
  if (customer.deletedAt) return { handled: false, outcome: 'customer_erased' };
  if (!(await dep(deps, 'phonesMatch')(customer.phone, from, workspaceId))) {
    log('sender phone is not the customer phone, ignored');
    return { handled: false, outcome: 'phone_mismatch' };
  }

  // 3. What does the button really do? The payload says; the snapshot taken at send time must agree. If they disagree an
  // opt-out still wins (never swallow a withdrawal), anything else is ignored.
  const snap = cm.consentSnapshot || {};
  const snapButton = Array.isArray(snap.buttons) ? snap.buttons.find((b) => b && b.position === parsed.position) : null;
  let action = parsed.action;
  if (snapButton && snapButton.action && snapButton.action !== parsed.action) {
    if (snapButton.action === 'opt_out' || parsed.action === 'opt_out') action = 'opt_out';
    else {
      log(`payload action ${parsed.action} differs from the sent button action ${snapButton.action}, ignored`);
      return { handled: false, outcome: 'action_mismatch' };
    }
  }

  const base = { workspaceId: String(workspaceId), customerId: String(customer._id), action };

  // The live node is only used for the confirmation text (not part of what Meta approved) and as the last resort for the
  // message text; the evidence quotes the SNAPSHOT of what was sent.
  let nodeCache;
  const loadNode = async () => {
    if (nodeCache !== undefined) return nodeCache;
    nodeCache = null;
    const nodeId = cm.messageNode || promotion.entryNodeId;
    if (nodeId) {
      try { nodeCache = (await dep(deps, 'MessageNode').findById(nodeId).lean()) || null; } catch (_) { nodeCache = null; }
    }
    return nodeCache;
  };

  const evidenceFor = async () => {
    const node = await loadNode();
    const nodeSnap = (node && node.templateSnapshot) || {};
    const sig = SIGNATURES.includes(signature) ? signature : undefined;
    const evidence = {
      promotionId: promotion._id,
      promotionName: snap.promotionName || promotion.name,
      messageText: snap.renderedBody || nodeSnap.bodyText || undefined,
      buttonLabel: label || (snapButton && snapButton.label) || undefined,
      buttonPosition: parsed.position,
      buttonAction: action,
      templateName: snap.templateName || cm.templateName || (node && node.templateName) || undefined,
      templateVersion: snap.templateVersion != null ? snap.templateVersion : (node && node.templateVersion),
      sourceWamid: cm.wamid || contextId || undefined,
      inboundWamid: inboundId,
      tappedAt: tapTime(msg),
      signature: sig,
    };
    if (!evidence.messageText) log(`no message text snapshot for message ${cm.wamid || cm._id}; recording the tap without it`);
    return evidence;
  };
  const sourceFor = (evidence) => `Promotion "${evidence.promotionName || ''}" button "${evidence.buttonLabel || ''}" (${action})`;

  const replyText = async (fallbackAction) => {
    const node = await loadNode();
    let custom = '';
    // The button of this position AND this action: after the merchant removed or reordered buttons, an old tap must not be answered
    // with the confirmation text of whatever button sits at that position now.
    const live = node && Array.isArray(node.buttons) ? node.buttons.find((b) => b && b.position === parsed.position && b.nextAction && b.nextAction.type === action) : null;
    if (live) custom = cleanText(live.nextAction.replyText);
    else if (node && node.templateSnapshot && Array.isArray(node.templateSnapshot.buttons)) {
      const sb = node.templateSnapshot.buttons.find((b) => b && b.position === parsed.position && (!b.action || b.action === action));
      custom = cleanText(sb && sb.replyText);
    }
    if (custom || !fallbackAction) return custom;
    const business = await dep(deps, 'businessName')(workspaceId, deps);
    return defaultReplyText({ action: fallbackAction, name: String(customer.firstname || '').trim(), business, promotion });
  };

  const send = async (text) => {
    if (!text) return false;
    try {
      const sendText = dep(deps, 'sendText');
      // the tapped message's workspace, answering the way the webhook event came in (from the shared number if that is where it arrived)
      await senderContext.runLike(String(workspaceId), () => sendText(fromDigits, text, { workspaceId: String(workspaceId) }));
      return true;
    } catch (err) {
      log('reply failed (ignored):', err && err.message);
      return false;
    }
  };

  const stats = () => recordTapStats({ CampaignMessage, cm, action, position: parsed.position, inboundId, now, log });

  // The very same inbound message already recorded (a Meta redelivery): nothing is written or answered a second time, whether or not the
  // database could enforce the unique index on ConsentEvent.inboundWamid.
  const alreadyRecorded = async () => !!inboundId && !!(await dep(deps, 'eventSeen')(inboundId));
  // A "Yes" the customer tapped BEFORE the opt-out they have on record cannot be a change of mind (late or repeated delivery).
  const staleOptIn = () => {
    const tapped = tapTime(msg);
    return customer.optedOut === true && !!customer.optedOutAt && !!tapped
      && tapped.getTime() < new Date(customer.optedOutAt).getTime() - STALE_TAP_MARGIN_MS;
  };

  if (action === 'opt_in') {
    if (requireSignature() && signature !== 'valid') {
      log(`opt-in refused: CONSENT_REQUIRE_SIGNATURE is on and the webhook signature was "${signature || 'missing'}"`);
      return { ...base, handled: true, outcome: 'signature_required' };
    }
    if (await alreadyRecorded()) return { ...base, handled: true, outcome: 'duplicate', duplicate: true };
    if (staleOptIn()) {
      log('opt-in tapped before the opt-out on record (late or repeated delivery), ignored');
      return { ...base, handled: true, outcome: 'stale_tap' };
    }
    const evidence = await evidenceFor();
    const out = await consent.recordCustomerOptIn({
      customer, method: 'whatsapp_button', source: sourceFor(evidence), workspaceId, evidence, campaignMessageId: cm._id,
    });
    if (out && out.duplicate) return { ...base, handled: true, outcome: 'duplicate', duplicate: true };
    await stats();
    const replied = await send(await replyText('opt_in'));
    return { ...base, handled: true, outcome: 'opted_in', replied };
  }

  if (action === 'opt_out') {
    if (await alreadyRecorded()) return { ...base, handled: true, outcome: 'duplicate', duplicate: true };
    const evidence = await evidenceFor();
    const source = sourceFor(evidence);
    const out = await consent.withdrawMarketingConsent({
      customer, method: 'whatsapp_optout_button', source, workspaceId, evidence,
    });
    if (out && out.duplicate) return { ...base, handled: true, outcome: 'duplicate', duplicate: true };
    await stats();
    const replied = await send(await replyText('opt_out'));
    try {
      await dep(deps, 'optOutSamePhone')({ workspaceId, from: fromDigits, exceptCustomerId: customer._id, method: 'whatsapp_optout_button', source });
    } catch (err) {
      log('same-phone opt-out failed (ignored):', err && err.message);
    }
    return { ...base, handled: true, outcome: 'opted_out', replied };
  }

  // interested / end_flow write no ConsentEvent, so a redelivery is caught on the message itself: the claim only succeeds
  // for an inbound id that is not the last one handled.
  if (inboundId) {
    const claimed = await CampaignMessage.findOneAndUpdate(
      { _id: cm._id, lastTapWamid: { $ne: inboundId } },
      { $set: { lastTapWamid: inboundId } },
    );
    if (!claimed) return { ...base, handled: true, outcome: 'duplicate', duplicate: true };
  }
  await stats();

  if (action === 'end_flow') return { ...base, handled: true, outcome: 'recorded' };

  // interested
  try {
    await Customer.updateOne({ _id: customer._id }, { $set: { conversationStatus: 'open' } });
  } catch (err) {
    log('could not flag the conversation open (ignored):', err && err.message);
  }
  const replied = await send(await replyText(null));
  const hasItems = (Array.isArray(promotion.products) && promotion.products.length)
    || (Array.isArray(promotion.services) && promotion.services.length)
    || promotion.type === 'store_wide';
  let continued = false;
  const handlePromoInterest = dep(deps, 'handlePromoInterest');
  if (hasItems && typeof handlePromoInterest === 'function') {
    try {
      await senderContext.runLike(String(workspaceId), () => handlePromoInterest(fromDigits, String(promotion._id), cm._id, workspaceId));
      continued = true;
    } catch (err) {
      log('shop/book flow failed (ignored):', err && err.message);
    }
  }
  return { ...base, handled: true, outcome: 'interested', replied, continued };
}

module.exports = { handlePromoConsentTap, parsePromoPayload, defaultReplyText, PAYLOAD_RE, ACTIONS };
