'use strict';
// Arabic delivery from the EXISTING template senders (D1, backlog A1 / A3): shared/operations.js
// sendPromotion, sendLoyaltyReminders and sendConsentRequests, plus the referral link text
// (shared/referrals.js sendReferralLinksToCustomers). Those functions keep their loops, their 300 ms
// pacing, the demo simulation, the consent gate, their CampaignMessage bookkeeping and their return shape; this
// module only answers, right before the existing per-customer send, "does an Arabic send apply to THIS customer,
// and if so send it".
//
//   begin({ sender, workspaceId, customers, promotion?, items?, allowRealDemoSend? }) -> null | Run     NEVER throws
//   Run.trySend(customer)  -> null | { skip: true, reason } | { sent, result, messageType, templateName, failReason?, usedLanguage }
//   Run.excludes(customer) -> boolean   (referral: an Arabic customer whose number is opted out on ANOTHER record)
//   Run.referralBody(customer, referralPromotion, code) -> Promise<string | null>
//   Run.record(customer, { sent, result, failReason }) -> Promise<void>   (sidecar language row; never throws)
//   Run.summary() -> { languageCounts: { ar, en }, localization: { ... } }
//   Run.decide(customer, opts) / Run.workspaceContext(ws)  (shared with legacyPlan.js: no network, no writes)
//
// `begin` returns null - and the existing code runs byte for byte - unless ALL hold: the kill switch is off; at
// least one workspace of the batch has arabic_enabled; and at least one customer of the batch resolves to Arabic
// (CustomerLanguage -> merchant default -> English). So a flagged merchant's all-English send gets no new response
// keys and no new writes (only cached read-only settings lookups).
//
// DECISION RULE for one customer (`decide`, the same code the plan endpoint runs):
//   not applicable (the existing English code runs unchanged; the reason is recorded for Arabic customers only):
//     the customer is not Arabic; demo data (customer or promotion); an erased customer; an invalid phone; no
//     Arabic version / not Meta-APPROVED / not natively reviewed / no opt-out button / buttons that do not fit the
//     sender / a merge field the sender cannot fill (senderVariants.js); anything that throws before a send.
//   excluded (NOTHING is sent, not even English): an Arabic customer whose normalised number is opted out on
//     ANOTHER customer record of the workspace (rule 7; English customers keep today's behaviour, H1 fixes new
//     opt-outs globally, separately).
//   applies: components from metaTemplates.buildSendComponents (sanitised values, a dead button is refused) sent
//     through transport.js (LOCALIZATION_SEND_MODE=dry_run honoured) inside a 30 s timeout.
// After a send ATTEMPT nothing falls back to English (G3): a failure is returned as { sent: false, failReason } and
// recorded by the caller like the English failure branch. TEMPLATE_ERROR_STREAK consecutive template-level Meta
// errors (132000, 132001, 132012, 132015, 132016, 132018) mean the template is unusable for everybody: the remaining
// Arabic customers are skipped (not sent, not retried in English) and summary().localization.stopped says why.
// Rate-limit codes add the same 5 s back-off as the campaign sender.
//
// Workspace handling: the batch may span workspaces (MCP / GPT calls may pass no workspaceId): everything is
// derived per customer.workspaceId (fallback: the workspaceId argument, then the promotion's). Variants, business
// name, promotion values and the opted-out phone set are resolved ONCE per run per workspace.
//
// Recording: LocalizedLegacySend rows (models/LocalizedLegacySend.js) exist ONLY for Arabic-resolved customers;
// CampaignMessage rows stay the existing code's business (consent requests: written here, same as the English path).
const crypto = require('crypto');
const { isObjectIdLike } = require('./scope');
const { resolveLanguage } = require('./languageDetect');
const { buildSendComponents, MissingMergeFieldError, SendComponentsError } = require('./metaTemplates');
const planner = require('./campaignPlanner');
const audience = require('./audience');
const sender = require('./campaignSender');
const catalog = require('./catalog');
const senderValues = require('./senderValues');
const senderVariants = require('./senderVariants');

const SENDERS = Object.freeze(['promotion', 'loyalty_reminder', 'consent_request', 'referral_link']);
const MAX_REASON = 300;

function realDeps() {
  return {
    ...planner.realDeps(),
    ...senderValues.realDeps(),
    transport: require('./transport'),
    LocalizedLegacySend: require('../../models/LocalizedLegacySend'),
    MessageNode: require('../../models/MessageNode'),
    CampaignMessage: require('../../models/CampaignMessage'),
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    getCurrency: () => require('../../utils/settingsCache').getCurrency(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    newRunId: () => crypto.randomBytes(8).toString('hex'),
    log: (...args) => console.error('[localization]', ...args),
    sendTimeoutMs: sender.SEND_TIMEOUT_MS,
  };
}

function wsKey(value) { return value ? String(value) : ''; }

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('WhatsApp did not answer in time; the message may or may not have been delivered');
      err.timeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function languageCodeOf(variant) {
  return (typeof variant.metaLanguage === 'string' && variant.metaLanguage) || 'ar';
}

// Stored error text never carries a phone number (review R4-3: PII residue): any run of 7+ digits (with the usual separators) is masked.
const PHONE_LIKE = /\+?\d(?:[ ().-]?\d){6,}/g;
function plainReason(text) {
  return String(text === undefined || text === null ? '' : text).replace(PHONE_LIKE, '[number]').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
}

function messageFailure(err) {
  const { code, message } = sender.describeSendError(err);
  return { code, message: plainReason(message) || 'Send failed' };
}

// ── the run ─────────────────────────────────────────────────────────────────

// Builds a Run (never null). Throws on infrastructure errors; `begin` and the plan decide what that means.
// opts.assumeFlagged: workspace ids treated as flagged without asking (the route already enforced the flag).
// opts.assumeArabic: customers are Arabic whatever their stored language (the Arabic test send).
async function buildRun(args, deps, opts = {}) {
  const { sender: kind, customers: rawCustomers, promotion = null, items = null, allowRealDemoSend = false } = args;
  if (!SENDERS.includes(kind)) throw new Error(`unknown sender ${kind}`);
  const customers = Array.isArray(rawCustomers) ? rawCustomers : [];
  const defaultWorkspace = wsKey(args.workspaceId) || wsKey(promotion && promotion.workspaceId);

  const workspaceOf = (customer) => wsKey(customer && customer.workspaceId) || defaultWorkspace;
  const byWorkspace = new Map();
  for (const customer of customers) {
    const ws = workspaceOf(customer);
    if (!isObjectIdLike(ws)) continue;
    if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
    byWorkspace.get(ws).push(customer);
  }

  const flagged = new Set();
  const assumed = new Set((opts.assumeFlagged || []).map(wsKey));
  const workspaces = new Set([...byWorkspace.keys(), ...assumed]);
  for (const ws of workspaces) {
    if (assumed.has(ws) || await deps.settings.isArabicEnabled(ws)) flagged.add(ws);
  }

  const languages = new Map(); // customerId -> 'ar' | 'en' (flagged workspaces only)
  let arabicCount = 0;
  const arabicWorkspaces = new Set();
  for (const ws of flagged) {
    const list = byWorkspace.get(ws) || [];
    if (!list.length) continue;
    const stored = await audience.languageMap(deps, ws, list);
    const merchantDefault = (await deps.settings.getSettings(ws)).defaultCustomerLanguage;
    for (const customer of list) {
      const language = opts.assumeArabic ? 'ar' : resolveLanguage(stored.get(String(customer._id)), merchantDefault);
      languages.set(String(customer._id), language);
      // Demo data that the existing code only simulates is never sent in Arabic, so it does not make the run "Arabic" either
      // (a flagged merchant's demo-only send gets no new response keys).
      const simulated = !allowRealDemoSend && (kind === 'promotion' || kind === 'loyalty_reminder')
        && !!(customer.isDemo || (kind === 'promotion' && promotion && promotion.isDemo));
      if (language === 'ar' && !simulated) { arabicCount += 1; arabicWorkspaces.add(ws); }
    }
  }

  // The same-phone rule needs the opted-out numbers of every workspace that has an Arabic customer (ONE bulk read
  // each); loaded now so `excludes` can stay synchronous.
  const optedOut = new Map();
  for (const ws of arabicWorkspaces) optedOut.set(ws, await audience.loadOptedOutPhones(deps, ws));

  const run = {
    sender: kind, deps, promotion, items, allowRealDemoSend,
    runId: deps.newRunId(),
    flagged, arabicCount, languages, optedOut,
    contexts: new Map(),        // ws -> Promise<WorkspaceContext>
    stopped: new Map(),         // ws -> 'template_unusable:<code>'
    pending: new Map(),         // customerId -> partial LocalizedLegacySend row waiting for record()
    handled: new Set(),         // customerIds whose outcome the run already accounted for
    stats: { arabicSent: 0, arabicFailed: 0, englishSent: 0, excluded: 0, fallbacks: new Map() },
    templateInfo: null,
  };

  run.workspaceOf = workspaceOf;
  run.isArabic = (customer) => !!customer && languages.get(String(customer._id)) === 'ar';
  run.workspaceContext = (ws) => workspaceContext(run, ws);
  run.decide = (customer, o) => decide(run, customer, o);
  run.trySend = (customer) => trySend(run, customer);
  run.excludes = (customer) => excludes(run, customer);
  run.referralBody = (customer, referralPromotion, code) => referralBody(run, customer, referralPromotion, code);
  run.record = (customer, outcome) => record(run, customer, outcome);
  run.summary = () => summary(run);
  return run;
}

async function begin(args, deps = realDeps()) {
  try {
    if (deps.settings.killSwitchOn()) return null;
    const run = await buildRun(args || {}, deps);
    return run.arabicCount > 0 ? run : null;
  } catch (err) {
    try { (deps.log || console.error)('legacy sender localisation skipped (the English path continues):', err && err.message); } catch (e) { /* ignore */ }
    return null;
  }
}

// ── workspace context (resolved once per run per workspace) ─────────────────

function workspaceContext(run, ws) {
  if (!run.contexts.has(ws)) run.contexts.set(ws, buildWorkspaceContext(run, ws));
  return run.contexts.get(ws);
}

async function buildWorkspaceContext(run, ws) {
  const { deps, sender: kind, promotion } = run;
  const [business, currency] = await Promise.all([planner.resolveBusinessName(deps, ws), deps.getCurrency()]);
  const ctx = { ws, business, currency, promotion: null, node: null, choice: null, streak: 0 };
  if (kind === 'referral_link') { ctx.choice = { source: 'none', usable: false, reason: 'not_applicable', variant: null }; return ctx; }

  let node = null;
  if (kind === 'promotion') {
    if (!promotion || wsKey(promotion.workspaceId) !== ws) {
      ctx.choice = { source: 'none', usable: false, reason: 'workspace_mismatch', variant: null, missingFields: [] };
      return ctx;
    }
    // The English path only uses an APPROVED custom entry message (resolveApprovedEntryNode): the Arabic
    // version of that message is only used under the same condition, else the promotion-linked version is.
    if (promotion.entryNodeId) {
      const found = await deps.MessageNode.findById(promotion.entryNodeId);
      node = found && found.templateStatus === 'approved' ? found : null;
    }
    const items = run.items || await senderValues.loadPromotionItems(deps, promotion);
    ctx.promotion = await senderValues.promotionValues(deps, { promotion, items, currency, workspaceId: ws, now: deps.now() });
    ctx.node = node;
  }
  ctx.choice = await senderVariants.resolveVariant(deps, {
    workspaceId: ws, sender: kind, promotion, node, available: { business, promotion: ctx.promotion },
  });
  if (run.templateInfo === null && ctx.choice.templateId) {
    run.templateInfo = { id: ctx.choice.templateId, name: ctx.choice.templateName, metaStatus: ctx.choice.metaStatus, reviewStatus: ctx.choice.reviewStatus };
  }
  return ctx;
}

// ── decision ────────────────────────────────────────────────────────────────

const english = (reason, arabic = true) => ({ action: 'english', reason, arabic });

// -> { action: 'english', reason, arabic } | { action: 'exclude' | 'skip', reason } | { action: 'arabic', ... }
// opts.synthetic: the Arabic test send (a typed number: no consent / language / demo / duplicate rules);
// opts.testMode: inert opt-out payload.
async function decide(run, customer, opts = {}) {
  const { synthetic = false, testMode = false } = opts;
  const ws = run.workspaceOf(customer);
  if (!synthetic && !run.isArabic(customer)) return english(null, false);

  if (!synthetic) {
    if (customer.deletedAt) return english('deleted');
    if (customer.isDemo || (run.promotion && run.promotion.isDemo && run.sender === 'promotion')) {
      if (!run.allowRealDemoSend) return english('demo');
    }
  }
  const phone = audience.normalizeRecipientPhone(customer.phone);
  if (!phone) return english('invalid_phone');
  if (!synthetic) {
    const blocked = run.optedOut.get(ws);
    if (blocked && blocked.has(phone)) return { action: 'exclude', reason: 'opted_out_same_phone' };
    if (run.stopped.has(ws)) return { action: 'skip', reason: run.stopped.get(ws) };
  }

  const ctx = await run.workspaceContext(ws);
  const choice = ctx.choice;
  if (!choice.usable) return english(choice.reason || 'no_arabic_version');

  const variant = choice.variant;
  const fields = planner.variantFieldNames(variant);
  const { values, missing } = senderValues.valuesFor(fields, customer, { business: ctx.business, currency: ctx.currency, promotion: ctx.promotion });
  if (missing.length) return english(`field_values_missing:${missing[0]}`);

  const payloads = senderVariants.buttonPayloads({ choice, sender: run.sender, promotion: run.promotion, node: ctx.node, customer, testMode });
  if (!payloads) return english('buttons_mismatch');
  let components;
  try {
    components = buildSendComponents({ variant, values, buttonPayloads: payloads });
  } catch (err) {
    if (err instanceof MissingMergeFieldError) return english(`field_values_missing:${err.fields[0]}`);
    if (err instanceof SendComponentsError) return english('buttons_mismatch');
    throw err;
  }
  return { action: 'arabic', ws, ctx, choice, variant, phone, components, templateName: variant.metaTemplateName, languageCode: languageCodeOf(variant) };
}

// ── sending ─────────────────────────────────────────────────────────────────

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

async function writeRow(run, row) {
  try {
    await run.deps.LocalizedLegacySend.create({ runId: run.runId, requestedLanguage: 'ar', ...row });
  } catch (err) {
    run.deps.log('could not write the legacy send language row (ignored):', err && err.message);
  }
}

function baseRow(run, customer, ws) {
  return {
    workspaceId: ws,
    sender: run.sender,
    refId: run.promotion && run.promotion._id ? String(run.promotion._id) : undefined,
    customerId: customer._id, // no phone number is stored on the sidecar row (review R4-3)
  };
}

function noteFallback(run, customer, reason) {
  const id = String(customer._id);
  run.stats.fallbacks.set(id, reason);
  run.pending.set(id, { ...baseRow(run, customer, run.workspaceOf(customer)), usedLanguage: 'en', fallback: true, fallbackReason: reason, via: 'existing' });
}

async function trySend(run, customer) {
  let d;
  try {
    d = await decide(run, customer);
  } catch (err) {
    run.deps.log('Arabic send decision failed (the English path continues):', err && err.message);
    if (run.isArabic(customer)) noteFallback(run, customer, 'internal_error');
    return null;
  }
  if (d.action === 'english') {
    if (d.arabic) noteFallback(run, customer, d.reason);
    return null;
  }
  const ws = run.workspaceOf(customer);
  const id = String(customer._id);
  run.handled.add(id);
  if (d.action === 'exclude' || d.action === 'skip') {
    if (d.action === 'exclude') run.stats.excluded += 1;
    await writeRow(run, { ...baseRow(run, customer, ws), usedLanguage: 'ar', status: 'skipped', errorCode: d.reason, via: 'template' });
    return { skip: true, reason: d.reason };
  }
  return performSend(run, customer, d);
}

async function performSend(run, customer, d) {
  const { deps } = run;
  const { ctx, choice, variant } = d;
  const row = {
    ...baseRow(run, customer, d.ws), usedLanguage: 'ar', via: 'template',
    templateId: choice.templateId, metaTemplateName: variant.metaTemplateName,
  };
  let result;
  try {
    result = await withTimeout(
      Promise.resolve().then(() => deps.transport.sendTemplate(d.phone, { name: d.templateName, languageCode: d.languageCode, components: d.components })),
      deps.sendTimeoutMs,
    );
  } catch (err) {
    const failure = messageFailure(err);
    run.stats.arabicFailed += 1;
    if (sender.TEMPLATE_ERROR_CODES.has(failure.code)) {
      ctx.streak += 1;
      if (ctx.streak >= sender.TEMPLATE_ERROR_STREAK) run.stopped.set(d.ws, `template_unusable:${failure.code}`);
    } else {
      ctx.streak = 0;
    }
    await writeRow(run, { ...row, status: 'failed', errorCode: failure.code, error: failure.message });
    if (sender.RATE_LIMIT_CODES.has(failure.code)) await deps.sleep(sender.RATE_LIMIT_BACKOFF_MS);
    return { sent: false, result: null, messageType: 'template', templateName: d.templateName, failReason: failure.message, usedLanguage: 'ar' };
  }
  ctx.streak = 0;
  run.stats.arabicSent += 1;
  const wamid = safeWamid(deps, result);
  await writeRow(run, { ...row, status: 'sent', wamid });
  if (run.sender === 'consent_request') await recordConsentRequest(run, customer, d, wamid);
  return { sent: true, result, messageType: 'template', templateName: d.templateName, usedLanguage: 'ar' };
}

function safeWamid(deps, result) {
  try { return deps.transport.extractWamid(result) || undefined; } catch (err) { return undefined; }
}

// The Arabic consent request does the same bookkeeping as shared/operations.js#sendConsentRequests does for the
// English template: stamp marketingConsentAskedAt (so a typed "نعم" is read as the answer and nobody is asked twice)
// and write the consent_request CampaignMessage. A rehearsal (dry run) changes no customer state (campaignSender rule).
async function recordConsentRequest(run, customer, d, wamid) {
  const { deps } = run;
  if (deps.transport.isDryRun()) return;
  const sentAt = new Date(deps.now());
  try {
    const filter = { _id: customer._id, marketingConsent: { $ne: true } };
    if (customer.workspaceId) filter.workspaceId = customer.workspaceId;
    await deps.Customer.updateOne(filter, { $set: { marketingConsentAskedAt: sentAt } });
  } catch (err) { deps.log('consent-ask stamp failed (ignored):', err && err.message); }
  try {
    await deps.CampaignMessage.create({
      workspaceId: customer.workspaceId || d.ws, kind: 'consent_request', customer: customer._id, phone: customer.phone,
      wamid, messageType: 'template', templateName: d.templateName, status: 'sent', sentAt,
    });
  } catch (err) { deps.log('consent_request message row failed (ignored):', err && err.message); }
}

// ── same-phone exclusion (referral) and the referral text ───────────────────

function excludes(run, customer) {
  try {
    if (!run.isArabic(customer)) return false;
    const phone = audience.normalizeRecipientPhone(customer.phone);
    const blocked = run.optedOut.get(run.workspaceOf(customer));
    if (!phone || !blocked || !blocked.has(phone)) return false;
    run.stats.excluded += 1;
    run.handled.add(String(customer._id));
    // Fire and forget: `excludes` is synchronous by contract (writeRow never throws).
    writeRow(run, { ...baseRow(run, customer, run.workspaceOf(customer)), usedLanguage: 'ar', status: 'skipped', errorCode: 'opted_out_same_phone', via: 'session' });
    return true;
  } catch (err) {
    return false;
  }
}

function sessionEntry(key) {
  const entry = catalog.load().get(key);
  return entry && entry.ar ? entry : null;
}

function draftSessionAllowed(entries) {
  if (process.env.LOCALIZATION_ALLOW_DRAFT_SESSION !== '0') return true;
  return entries.every((entry) => entry.status === 'reviewed');
}

// Number for a discount / bonus: integers plain, decimals trimmed. Western digits.
function plainNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(+n.toFixed(2)) : '';
}

function rewardPhrase(side, promotion) {
  const label = side === 'friend' ? promotion.friendRewardLabel : promotion.referrerRewardLabel;
  const cleanLabel = senderValues.plainText(label, 120);
  if (cleanLabel) return cleanLabel;
  const type = side === 'friend' ? promotion.friendRewardType : promotion.referrerRewardType;
  const value = plainNumber(side === 'friend' ? promotion.friendRewardValue : promotion.referrerRewardValue);
  const prefix = side === 'friend' ? 'senders.referralFriend' : 'senders.referralReferrer';
  const key = { percent_discount: 'Percent', fixed_discount: 'Fixed', loyalty_points: 'Points' }[type];
  if (!key || !value) return catalog.t('ar', `${prefix}Offer`);
  // No params to catalog.t: it would wrap the number in direction marks, which a number inside an Arabic phrase does not need.
  return catalog.t('ar', `${prefix}${key}`).replace('{value}', () => value);
}

// The Arabic referral link text, or null (the English text is used). Needs the catalogue entries; the opt-out hint
// line is appended because a marketing message must tell the customer how to stop it (the English text has none).
async function referralBody(run, customer, referralPromotion, code) {
  try {
    if (run.sender !== 'referral_link' || !run.isArabic(customer) || customer.deletedAt) return null;
    const share = sessionEntry('senders.referralShare');
    const hint = sessionEntry('senders.optOutHint');
    if (!share || !hint || !draftSessionAllowed([share, hint])) { noteFallback(run, customer, 'catalog_missing'); return null; }
    const first = senderValues.usableName(customer.firstname);
    const link = code && code.shortUrl ? String(code.shortUrl) : '';
    if (!link) { noteFallback(run, customer, 'no_link'); return null; }
    // Latin / number values (a Latin first name) are isolated with direction marks inside the Arabic text; the link is not.
    const rendered = require('./utilitySend').renderSession(share.ar, {
      name: first || catalog.t('ar', 'flows.fallbackName'),
      friend_reward: rewardPhrase('friend', referralPromotion || {}),
      referrer_reward: rewardPhrase('referrer', referralPromotion || {}),
      link: `${link}${link.includes('?') ? '&' : '?'}lang=ar`,
    });
    if (rendered.missing) { noteFallback(run, customer, 'catalog_missing'); return null; }
    const body = `${rendered.text}\n\n${hint.ar}`;
    run.handled.add(String(customer._id));
    run.pending.set(String(customer._id), { ...baseRow(run, customer, run.workspaceOf(customer)), usedLanguage: 'ar', via: 'session', refId: referralPromotion && referralPromotion._id ? String(referralPromotion._id) : undefined });
    return body;
  } catch (err) {
    run.deps.log('Arabic referral text skipped (the English text is used):', err && err.message);
    return null;
  }
}

// ── bookkeeping after the existing code's own send ──────────────────────────

function demoOf(run, customer) {
  return !run.allowRealDemoSend && !!(customer.isDemo || (run.sender === 'promotion' && run.promotion && run.promotion.isDemo));
}

async function record(run, customer, outcome = {}) {
  try {
    const id = String(customer._id);
    const pending = run.pending.get(id);
    if (pending) {
      run.pending.delete(id);
      const sent = !!outcome.sent;
      const demo = demoOf(run, customer);
      if (pending.usedLanguage === 'en' && sent && !demo) run.stats.englishSent += 1;
      if (pending.usedLanguage === 'ar' && sent) run.stats.arabicSent += 1;
      if (pending.usedLanguage === 'ar' && !sent) run.stats.arabicFailed += 1;
      const wamid = safeWamid(run.deps, outcome.result);
      await writeRow(run, {
        ...pending, status: sent ? 'sent' : 'failed', wamid,
        ...(sent ? {} : { error: plainReason(outcome.failReason), errorCode: 'send_failed' }),
      });
      return;
    }
    if (!run.handled.has(id) && outcome.sent && !demoOf(run, customer)) run.stats.englishSent += 1;
  } catch (err) {
    run.deps.log('recording the legacy send outcome failed (ignored):', err && err.message);
  }
}

function summary(run) {
  const fallbacks = new Map();
  for (const reason of run.stats.fallbacks.values()) bump(fallbacks, reason);
  const stopped = Array.from(run.stopped.values())[0];
  return {
    languageCounts: { ar: run.stats.arabicSent, en: run.stats.englishSent },
    localization: {
      arabicCustomers: run.arabicCount,
      arabicSent: run.stats.arabicSent,
      arabicFailed: run.stats.arabicFailed,
      fallbackToEnglish: Array.from(fallbacks, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
      excludedOptedOutPhone: run.stats.excluded,
      ...(stopped ? { stopped } : {}),
      template: run.templateInfo,
    },
  };
}

// ── the Arabic test send of a promotion ─────────────────────────────────────

function testError(status, code, message, details) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (details) err.details = details;
  return err;
}

// Sends the SAME Arabic version a real send would pick to a typed number (synthetic customer, no consent / language /
// duplicate rules; the opt-out button carries an inert payload). The caller (the route) already enforced the flag.
// -> { sent: true, dryRun, usedLanguage: 'ar', templateName } | throws 409 NO_ARABIC_VERSION { reason } / 502 META_ERROR
async function sendPromotionTest({ workspaceId, promotion, items, phone }, deps = realDeps()) {
  const ws = wsKey(workspaceId);
  const customer = { firstname: 'Test', lastname: '', phone, loyaltyPoints: (promotion && promotion.pointsPrice) || 100, workspaceId: ws };
  const run = await buildRun({ sender: 'promotion', workspaceId: ws, customers: [], promotion, items }, deps, { assumeFlagged: [ws], assumeArabic: true });
  const d = await decide(run, customer, { synthetic: true, testMode: true });
  if (d.action !== 'arabic') throw testError(409, 'NO_ARABIC_VERSION', 'There is no Arabic version of this promotion that can be sent', { reason: d.reason || 'no_arabic_version' });
  let result;
  try {
    result = await withTimeout(Promise.resolve().then(() => deps.transport.sendTemplate(d.phone, { name: d.templateName, languageCode: d.languageCode, components: d.components })), deps.sendTimeoutMs);
  } catch (err) {
    const failure = messageFailure(err);
    throw testError(502, 'META_ERROR', 'WhatsApp could not send the message', { metaCode: failure.code });
  }
  return { sent: true, dryRun: !!(result && result.dryRun), usedLanguage: 'ar', templateName: d.templateName };
}

module.exports = { SENDERS, realDeps, buildRun, begin, decide, sendPromotionTest };
