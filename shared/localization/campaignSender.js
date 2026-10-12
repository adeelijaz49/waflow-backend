'use strict';
// The localised campaign sender (spec §3.2, §3.4) — real WhatsApp messages to
// real customers, so every rule below exists for a compliance or reliability reason.
//
// FLOW
//   startSend()   re-plans (never trusts the stored plan), checks the
//                 acknowledgements, atomically claims draft -> sending
//                 (findOneAndUpdate on status:'draft' — a double click gets
//                 409 CAMPAIGN_NOT_DRAFT), schedules the background run and
//                 returns at once;
//   runCampaign() writes one LocalizedSend row per resolved customer (skipped
//                 ones included, so the report accounts for everyone), then sends
//                 the queued rows SEQUENTIALLY with a 300 ms pause after every real
//                 send (the same pacing as the existing senders), and finishes with
//                 stats + status sent | partial | failed;
//   resumeStuckCampaigns()  (scheduler) takes over `sending` campaigns whose heartbeat
//                 went stale and continues them; sendSingle() is the synchronous
//                 one-customer variant used by the Inbox "send loyalty reminder".
//
// GUARANTEES
//   * Never twice: unique (campaignId, customerId) rows; each row is claimed
//     queued -> sending atomically BEFORE the Meta call; a failed send is never
//     retried in-process; a row found in `sending` after a crash is marked failed
//     (errorCode `interrupted`: delivery unknown) and NEVER re-sent. Bookkeeping
//     after a successful send (row update, CampaignMessage, consent-ask stamp)
//     is best-effort and can never turn into a retry of the send.
//   * Consent is re-checked on a FRESH customer read immediately before every send
//     (shared/consent.js#canSendMarketing for MARKETING; opt-out for UTILITY): a
//     customer who opted out mid-campaign is skipped. The campaign category used
//     is the stricter of the one snapshotted at start and the template's current one
//     (re-evaluated for every recipient on the freshly read template), and "current"
//     includes the UTILITY floor (category.js): only transactional use cases can be
//     UTILITY, every other use case is gated as MARKETING whatever was requested.
//     A customer is also skipped when ANOTHER record of the workspace with the same
//     phone is opted out (audience.js, opted_out_phone) - that set is re-read at most
//     once a minute, not once per recipient.
//   * A template-level Meta failure stops the run: TEMPLATE_ERROR_STREAK (3) consecutive
//     Meta errors 132000/132001/132012/132015/132016/132018 mean the template or its
//     parameters are unusable for EVERYONE, so no further Meta call is made, the rest
//     stays `queued`, and the campaign ends failed/partial with lastError
//     `template_unusable:<code>` (stopForUnusableTemplate). Rate-limit codes keep their
//     back-off; any other outcome resets the streak.
//   * Never silently the wrong language: the template is re-read and the variant
//     re-picked with the same rules as the plan before every send; a recipient whose pick would now be an UNACKNOWLEDGED
//     fallback (the approved versions changed while sending) is skipped_blocked.
//   * Demo customers (isDemo) are never sent to Meta; a MARKETING variant without
//     the opt-out button is never sent; phones are validated again at send time.
//   * Everything goes through transport.js (LOCALIZATION_SEND_MODE=dry_run sends
//     nothing; in dry-run the CampaignMessage rows and the consent-ask stamp are
//     NOT written either, so a rehearsal cannot alter real customer state).
//
// Delivery tracking: a successful send also writes a CampaignMessage row
// (workspaceId, customer, phone, wamid, messageType 'template', templateName,
// status 'sent') so the existing webhook status callbacks (delivered/read/failed)
// update it by wamid and the Inbox thread — which merges CampaignMessage rows —
// shows it. No WhatsAppMessage row (the Inbox would list it twice). `kind` follows
// the use case onto the existing enum (loyalty_reminder, booking_notification,
// consent_request for opt-in templates, otherwise promotion). A consent-request
// template (an opt_in button) also stamps Customer.marketingConsentAskedAt, exactly
// like shared/operations.js#sendConsentRequests, so a typed "نعم" reply is
// recognised as a pending answer (inboundHook.js).
//
// NO CREDIT RESERVATION: the existing senders (sendPromotion, sendLoyaltyReminders,
// carousel, flows) are unmetered and the entitlements engine is not wired into any
// of them (shared/entitlements.js header). Reserving here would make Arabic sends
// behave differently from English ones; wire reserveCredit/reconcileReservation in
// ONE place when the owner decides to meter. LocalizedSend already has the
// skipped_no_credit status for that day.
//
// All collaborators are injectable (realDeps) so tests need no database, no
// network and no real sleeping.
const crypto = require('crypto');
const mongoose = require('mongoose');
const { pickVariant, findVariant } = require('./variantSelection');
const { META_LANGUAGE } = require('./metaConstraints');
const planner = require('./campaignPlanner');
const {
  SKIP_STATUS, CUSTOMER_PROJECTION, httpError, asObjectId, chunk, isPlainObject, normalizeRecipientPhone, classifyCustomer, loadOptedOutPhones,
} = require('./audience');

const SEND_THROTTLE_MS = 300;
const SEND_TIMEOUT_MS = 30 * 1000;
const STALE_MS = 5 * 60 * 1000;
const HEARTBEAT_EVERY = 10;
const HEARTBEAT_MS = 15 * 1000;
const MAX_RUN_ATTEMPTS = 5;
const BATCH = 50;
const INSERT_CHUNK = 200;
const RATE_LIMIT_BACKOFF_MS = 5000;
const RATE_LIMIT_CODES = new Set(['4', '17', '32', '613', '80007', '130429', '131056']);
// Meta errors that say the TEMPLATE (or its parameters) is unusable for everybody, not that one
// recipient is: 132000 parameter count, 132001 template missing / not approved, 132012 parameter
// format, 132015 paused, 132016 disabled, 132018 parameter issue. TEMPLATE_ERROR_STREAK of them in
// a row stop the campaign (stopForUnusableTemplate) instead of failing every remaining recipient.
const TEMPLATE_ERROR_CODES = new Set(['132000', '132001', '132012', '132015', '132016', '132018']);
const TEMPLATE_ERROR_STREAK = 3;
const TEMPLATE_UNUSABLE = 'template_unusable'; // lastError is `template_unusable:<Meta code>`
const OPTED_OUT_REFRESH_MS = 60 * 1000;
const MAX_ERROR_LENGTH = 300;
const POLICY_SKIP_CODES = ['duplicate_phone', 'already_consented', 'asked_recently'];
const BLOCKED_TEXT = 'No approved version of this message exists for this customer';
const LOYALTY_USE_CASES = ['loyalty_reminder', 'points_balance', 'points_expiring'];
const BOOKING_USE_CASES = ['booking_confirmation', 'booking_reminder'];

// Campaigns running in THIS process (a second runner for the same id is refused).
const activeRuns = new Set();

function realDeps() {
  return {
    ...planner.realDeps(),
    LocalizedCampaign: require('../../models/LocalizedCampaign'),
    LocalizedSend: require('../../models/LocalizedSend'),
    CampaignMessage: require('../../models/CampaignMessage'),
    transport: require('./transport'),
    // B2b's templates service owns the Meta `components` shape (body parameters,
    // quick-reply payloads); loaded lazily so requiring this module costs nothing.
    buildSendComponents: (args) => require('./templates').buildSendComponents(args),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule: (fn) => setImmediate(fn),
    newRunnerId: () => crypto.randomBytes(8).toString('hex'),
    log: (...args) => console.error('[localization]', ...args),
    sendTimeoutMs: SEND_TIMEOUT_MS,
  };
}

// ── small utilities ─────────────────────────────────────────────────────────

function nowDate(deps) { return new Date(deps.now()); }

function objectId(value) { return new mongoose.Types.ObjectId(String(value)); }

// An update must never carry `undefined` (its handling differs between Mongoose versions).
function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function cleanError(text) {
  const cleaned = String(text === undefined || text === null ? '' : text)
    .replace(/[\u{0}-\u{1F}\u{7F}]+/gu, ' ')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]') // never echo anything token-shaped
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, MAX_ERROR_LENGTH).join('');
}

function isTransient(err) {
  if (!err) return false;
  const text = `${err.name || ''} ${err.message || ''}`;
  return err.code === 16500 || err.code === 429
    || /MongoNetwork|MongoServerSelection|MongoNotConnected|TooManyRequests|request rate is large|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text);
}

// Retries a DATABASE write on transient errors only (never used around the Meta call).
async function withRetry(deps, fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isTransient(err) || i === attempts - 1) break;
      await deps.sleep(200 * (2 ** i));
    }
  }
  throw last;
}

// Bookkeeping that must never abort the loop or re-trigger a send.
async function bestEffort(deps, label, fn) {
  try {
    await withRetry(deps, fn);
    return true;
  } catch (err) {
    if (err && err.code === 11000) return true; // already recorded
    deps.log(`${label} failed (ignored):`, err && err.message);
    return false;
  }
}

function isDuplicateOnly(err) {
  if (!err) return false;
  const writeErrors = Array.isArray(err.writeErrors) ? err.writeErrors : [];
  if (writeErrors.length) return writeErrors.every((e) => (e.code !== undefined ? e.code : e.err && e.err.code) === 11000);
  return err.code === 11000;
}

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

// -> { code, message } from a failed transport call: Meta's own error object when
// there is one, otherwise the network/runtime error. Always sanitised, never a stack.
function describeSendError(err) {
  const meta = err && err.response && err.response.data && err.response.data.error;
  if (meta) {
    return {
      code: meta.code !== undefined && meta.code !== null ? String(meta.code) : 'meta_error',
      message: cleanError((meta.error_data && meta.error_data.details) || meta.message || 'WhatsApp rejected the message'),
    };
  }
  if (err && err.timeout) return { code: 'timeout', message: cleanError(err.message) };
  return { code: cleanError(err && err.code ? String(err.code) : 'send_failed') || 'send_failed', message: cleanError((err && err.message) || 'The message could not be sent') };
}

function languageCodeFor(variant) {
  if (variant.metaLanguage) return variant.metaLanguage;
  if (variant.language === 'bilingual') return META_LANGUAGE[variant.bilingualOrder === 'en_first' ? 'bilingual_en_first' : 'bilingual_ar_first'];
  return META_LANGUAGE[variant.language];
}

function campaignMessageKind(template, variant) {
  if ((variant.buttons || []).some((b) => b && b.role === 'opt_in')) return 'consent_request';
  if (LOYALTY_USE_CASES.includes(template.useCase)) return 'loyalty_reminder';
  if (BOOKING_USE_CASES.includes(template.useCase)) return 'booking_notification';
  return 'promotion';
}

// Payload per button, in button order (null = nothing to carry, e.g. a URL button).
// The prefixes are the ones the existing webhook already dispatches (server.js):
// optout_<id>, consent_yes_<customerId>, consent_no_<customerId>, msgnode_<nodeId>_<position>.
function buttonPayloadsFor({ variant, template, campaign, customer }) {
  let flowPosition = 0;
  return (variant.buttons || []).map((button) => {
    switch (button && button.role) {
      case 'opt_out': return `optout_${campaign._id}`;
      case 'opt_in': return `consent_yes_${customer._id}`;
      case 'decline': return `consent_no_${customer._id}`;
      case 'flow_button': {
        const position = flowPosition;
        flowPosition += 1;
        return `msgnode_${template.linkedMessageNodeId}_${position}`;
      }
      default: return null;
    }
  });
}

function requestFromCampaign(campaign) {
  const a = campaign.audience || {};
  const audience = { kind: a.kind || 'all_eligible' };
  if (a.kind === 'customer_ids') audience.customerIds = (a.customerIds || []).map(String);
  if (a.kind === 'segment') { audience.segmentKey = a.segmentKey; audience.segmentParams = a.segmentParams || {}; }
  return { templateId: String(campaign.templateId), languageMode: campaign.languageMode, audience, fieldValues: campaign.fieldValues || {} };
}

// ── statistics ──────────────────────────────────────────────────────────────

async function aggregateRows(deps, { campaignId, workspaceId }) {
  return deps.LocalizedSend.aggregate([
    { $match: { campaignId: objectId(campaignId), workspaceId: objectId(workspaceId) } },
    { $group: { _id: { status: '$status', usedLanguage: '$usedLanguage' }, count: { $sum: 1 } } },
  ]);
}

// groups: [{ _id: { status, usedLanguage }, count }] -> { stats, byStatus }
// stats.byLanguage counts the messages that were actually SENT, per language used.
function statsFromGroups(groups) {
  const stats = { total: 0, sent: 0, failed: 0, skipped: 0, byLanguage: { en: 0, ar: 0, bilingual: 0 } };
  const byStatus = {};
  for (const group of groups) {
    const status = group._id.status;
    const count = group.count;
    stats.total += count;
    byStatus[status] = (byStatus[status] || 0) + count;
    if (status === 'sent') {
      stats.sent += count;
      if (stats.byLanguage[group._id.usedLanguage] !== undefined) stats.byLanguage[group._id.usedLanguage] += count;
    } else if (status === 'failed') {
      stats.failed += count;
    } else if (String(status).startsWith('skipped_')) {
      stats.skipped += count;
    }
  }
  return { stats, byStatus };
}

// ── claim / snapshot ────────────────────────────────────────────────────────

function assertSendable(plan, acknowledge) {
  const ack = isPlainObject(acknowledge)
    ? { fallbacks: acknowledge.fallbacks === true, blocked: acknowledge.blocked === true }
    : { fallbacks: false, blocked: false };
  if (plan.warnings.some((w) => w.code === 'template_archived' || w.code === 'marketing_variant_missing_opt_out')) {
    throw httpError(422, 'TEMPLATE_UNUSABLE', 'This template cannot be sent (archived, or a marketing version has no opt-out button)');
  }
  if (plan.audience.eligible === 0) throw httpError(422, 'NOTHING_TO_SEND', 'There is nobody to send this campaign to');
  const usable = plan.byLanguage.en + plan.byLanguage.ar + plan.byLanguage.bilingual;
  if (usable === 0) throw httpError(422, 'TEMPLATE_UNUSABLE', 'No customer has a version of this template that can be sent');
  if (plan.missingFieldValues.length) throw httpError(422, 'FIELD_VALUES_MISSING', `Missing values for: ${plan.missingFieldValues.join(', ')}`);
  if ((plan.fallbacks.length && !ack.fallbacks) || (plan.blocked.length && !ack.blocked)) {
    throw httpError(422, 'PLAN_NEEDS_ACK', 'Acknowledge the language fallbacks and blocked recipients before sending');
  }
}

function snapshotRow({ campaign, recipient, template }) {
  const { customer, skip, pick } = recipient;
  const base = {
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    customerId: customer.id,
    phone: customer.phoneDigits || String(customer.phone || '').slice(0, 40) || 'unknown',
  };
  if (skip) return { ...base, ...SKIP_STATUS[skip] };
  if (pick.blocked) {
    return { ...base, status: 'skipped_blocked', requestedLanguage: pick.requestedLanguage, fallbackReason: pick.reason, errorCode: pick.reason, error: BLOCKED_TEXT };
  }
  const variant = findVariant(template, pick.usedLanguage);
  return {
    ...base,
    status: 'queued',
    requestedLanguage: pick.requestedLanguage,
    usedLanguage: pick.usedLanguage,
    fallback: pick.fallback,
    ...(pick.fallback ? { fallbackReason: pick.reason } : {}),
    ...(variant && variant.metaTemplateName ? { metaTemplateName: variant.metaTemplateName } : {}),
  };
}

// Idempotent on resume: the unique (campaignId, customerId) index turns a repeat
// insert into a duplicate-key error that is deliberately ignored.
async function insertSnapshot(deps, rows) {
  for (const slice of chunk(rows, INSERT_CHUNK)) {
    await withRetry(deps, async () => {
      try {
        await deps.LocalizedSend.insertMany(slice, { ordered: false });
      } catch (err) {
        if (!isDuplicateOnly(err)) throw err;
      }
    });
  }
}

// POST /campaigns/:id/send. Returns the claimed campaign (status 'sending'); the
// actual sending runs in the background.
async function startSend({ workspaceId, campaignId, acknowledge }, deps = realDeps()) {
  const id = asObjectId(campaignId, 'campaign id');
  const campaign = await deps.LocalizedCampaign.findOne({ _id: id, workspaceId }).lean();
  if (!campaign) throw httpError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  if (campaign.status !== 'draft') throw httpError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign has already been started');

  const built = await planner.buildPlan({ workspaceId, request: requestFromCampaign(campaign) }, deps);
  assertSendable(built.plan, acknowledge);

  const runnerId = deps.newRunnerId();
  const now = nowDate(deps);
  const claimed = await deps.LocalizedCampaign.findOneAndUpdate(
    { _id: id, workspaceId, status: 'draft' },
    {
      $set: {
        status: 'sending',
        startedAt: now,
        claimedAt: now,
        claimedBy: runnerId,
        lastHeartbeatAt: now,
        category: built.plan.category,
        templateName: built.plan.templateName,
        plan: planner.stripSamples(built.plan),
        'stats.total': built.recipients.length,
      },
      $inc: { runAttempts: 1 },
    },
    { returnDocument: 'after' },
  ).lean();
  if (!claimed) throw httpError(409, 'CAMPAIGN_NOT_DRAFT', 'This campaign has already been started');

  const holder = { built };
  // The scheduled function returns the run's promise (setImmediate ignores it; the
  // tests await it). It is always .catch-ed: an unhandled rejection kills Node 22.
  deps.schedule(() => runCampaign({ workspaceId, campaignId: id, runnerId, holder }, deps)
    .catch((err) => deps.log('campaign run failed:', err && err.message)));
  return { campaign: claimed };
}

// ── the loop ────────────────────────────────────────────────────────────────

// The consent rules that apply to the template AS IT IS NOW. Only ever tightens: the category
// snapshotted when the campaign started can turn UTILITY -> MARKETING (a re-classification, or a
// use case edited to a non-transactional one - the UTILITY floor lives in planner.effectiveCategory)
// but never back, and a template that was not a consent request when the campaign started can
// never earn that exemption mid-run (a consent request that stopped being one loses it).
function consentPolicy(campaign, template, startedAsConsentRequest) {
  const stricter = campaign.category === 'MARKETING' || planner.effectiveCategory(template) === 'MARKETING';
  return { category: stricter ? 'MARKETING' : 'UTILITY', consentRequest: startedAsConsentRequest && planner.isConsentRequest(template) };
}

function makeContext({ deps, campaign, template, runnerId, merchantDefault, business }) {
  const startedAsConsentRequest = planner.isConsentRequest(template);
  return {
    deps,
    workspaceId: campaign.workspaceId,
    campaignId: campaign._id,
    campaign,
    template,
    runnerId,
    startedAsConsentRequest,
    ...consentPolicy(campaign, template, startedAsConsentRequest),
    merchantDefault,
    business,
    fieldValues: isPlainObject(campaign.fieldValues) ? campaign.fieldValues : {},
    sinceBeat: 0,
    lastBeat: deps.now(),
    optedOutPhones: null, // { at, phones }: see currentOptedOutPhones
  };
}

// The phones of the workspace's opted-out customer records (audience.loadOptedOutPhones), read
// once and refreshed at most every OPTED_OUT_REFRESH_MS: one scan a minute instead of one per
// recipient. A customer's OWN record is always re-read fresh; this only covers "another record of
// the same number opted out while the campaign was running".
async function currentOptedOutPhones(ctx) {
  const nowMs = ctx.deps.now();
  if (!ctx.optedOutPhones || nowMs - ctx.optedOutPhones.at >= OPTED_OUT_REFRESH_MS) {
    ctx.optedOutPhones = { at: nowMs, phones: await loadOptedOutPhones(ctx.deps, ctx.workspaceId) };
  }
  return ctx.optedOutPhones.phones;
}

function markRow(ctx, rowId, set) {
  return withRetry(ctx.deps, () => ctx.deps.LocalizedSend.updateOne({ _id: rowId, workspaceId: ctx.workspaceId }, { $set: set }));
}

async function updateStats(ctx, stats, status = 'sending') {
  const filter = { _id: ctx.campaignId, workspaceId: ctx.workspaceId, status };
  if (status === 'sending') filter.claimedBy = ctx.runnerId;
  const set = { stats };
  if (status === 'sending') set.lastHeartbeatAt = nowDate(ctx.deps);
  await ctx.deps.LocalizedCampaign.updateOne(filter, { $set: set });
}

async function refreshStats(ctx, status) {
  const { stats } = statsFromGroups(await aggregateRows(ctx.deps, ctx));
  await updateStats(ctx, stats, status);
}

// Per iteration: is this runner still the owner of a campaign that is still
// `sending`? -> 'ok' | 'cancelled' | 'lost' (taken over by a resumer, or finished
// elsewhere) | 'disabled' (Waflow staff switched Arabic off for this merchant, or the kill
// switch is on, while the run was in flight: it stops before the NEXT message and the campaign
// stays `sending` for the resumer, which only continues it once the flag is back on).
// Also the heartbeat + live progress.
async function checkpoint(ctx) {
  const { deps } = ctx;
  const current = await deps.LocalizedCampaign.findOne({ _id: ctx.campaignId, workspaceId: ctx.workspaceId }).select('status claimedBy').lean();
  if (!current) return 'lost';
  if (current.status === 'cancelled') return 'cancelled';
  if (current.status !== 'sending' || current.claimedBy !== ctx.runnerId) return 'lost';
  if (deps.settings.killSwitchOn() || !(await deps.settings.isArabicEnabled(ctx.workspaceId))) return 'disabled';
  ctx.sinceBeat += 1;
  const nowMs = deps.now();
  if (ctx.sinceBeat >= HEARTBEAT_EVERY || nowMs - ctx.lastBeat >= HEARTBEAT_MS) {
    ctx.sinceBeat = 0;
    ctx.lastBeat = nowMs;
    await bestEffort(deps, 'heartbeat', () => refreshStats(ctx, 'sending'));
  }
  return 'ok';
}

// Recipients of a cancelled campaign that were never reached stop being "queued"
// (a status change, never a delete).
function cancelQueuedRows(deps, { campaignId, workspaceId }) {
  return deps.LocalizedSend.updateMany(
    { campaignId, workspaceId, status: 'queued' },
    { $set: { status: 'skipped_error', errorCode: 'cancelled', error: 'The campaign was cancelled before this message was sent' } },
  );
}

function skipRow(skip) { return { skip }; }

// Pre-send checks on a fresh read. -> { skip: {status, errorCode?, error?, fallbackReason?} } | { send }.
// Nothing here talks to Meta, so a throw is always safe to treat as "not sent".
async function prepareRecipient(ctx, row) {
  const { deps, campaign } = ctx;
  // Fresh template read per recipient (one cheap indexed read per ~300 ms send): a
  // campaign can run for tens of minutes and Meta may pause or disable a version meanwhile.
  const template = (await deps.LocalizedTemplate.findOne({ _id: campaign.templateId, workspaceId: ctx.workspaceId }).lean()) || ctx.template;
  ctx.template = template;
  Object.assign(ctx, consentPolicy(campaign, template, ctx.startedAsConsentRequest)); // the category follows the fresh template
  const customer = await deps.Customer.findOne({ _id: row.customerId, workspaceId: ctx.workspaceId }).select(`${CUSTOMER_PROJECTION} deletedAt`).lean();
  if (!customer) return skipRow({ status: 'skipped_error', errorCode: 'customer_missing', error: 'The customer no longer exists' });
  if (customer.deletedAt) return skipRow({ status: 'skipped_error', errorCode: 'customer_deleted', error: 'The customer was erased' });

  const skipKey = classifyCustomer(customer, ctx.category, deps.consent, {
    consentRequest: ctx.consentRequest, nowMs: deps.now(), optedOutPhones: await currentOptedOutPhones(ctx),
  });
  if (skipKey) return skipRow(SKIP_STATUS[skipKey]);

  const languageDoc = await deps.CustomerLanguage.findOne({ workspaceId: ctx.workspaceId, customerId: customer._id }).select('language').lean();
  const pick = pickVariant(template, {
    customerLanguage: languageDoc && languageDoc.language,
    merchantDefault: ctx.merchantDefault,
    languageMode: campaign.languageMode,
    requireNativeReview: true,
  });
  if (pick.blocked) return skipRow({ status: 'skipped_blocked', errorCode: pick.reason, error: BLOCKED_TEXT, fallbackReason: pick.reason });
  if (pick.fallback && pick.usedLanguage !== row.usedLanguage) {
    return skipRow({ status: 'skipped_blocked', errorCode: 'variant_changed', error: 'The approved versions of this message changed while the campaign was sending', fallbackReason: pick.reason });
  }

  const { variant } = pick;
  if (!variant.metaTemplateName) return skipRow({ status: 'skipped_blocked', errorCode: 'variant_not_submitted', error: BLOCKED_TEXT });
  if (planner.lacksRequiredButtons(ctx.category, template, variant)) {
    return skipRow({ status: 'skipped_blocked', errorCode: 'no_opt_out_button', error: 'A marketing message must carry the opt-out button' });
  }
  if ((variant.buttons || []).some((b) => b && b.role === 'flow_button') && !template.linkedMessageNodeId) {
    return skipRow({ status: 'skipped_blocked', errorCode: 'flow_button_without_node', error: BLOCKED_TEXT });
  }

  const { values, missing } = planner.valuesForVariant({ customer, variant, fieldValues: ctx.fieldValues, business: ctx.business, catalog: deps.catalog });
  if (missing.length) return skipRow({ status: 'skipped_error', errorCode: 'field_values_missing', error: `Missing value for: ${missing.join(', ')}` });

  let components;
  try {
    components = await deps.buildSendComponents({ variant, values, buttonPayloads: buttonPayloadsFor({ variant, template, campaign, customer }) });
  } catch (err) {
    return skipRow({ status: 'skipped_error', errorCode: 'components_failed', error: cleanError(err && err.message) });
  }
  return {
    send: {
      customer,
      pick,
      variant,
      components,
      phone: normalizeRecipientPhone(customer.phone),
      languageCode: languageCodeFor(variant),
      kind: campaignMessageKind(template, variant),
      hasOptIn: (variant.buttons || []).some((b) => b && b.role === 'opt_in'),
    },
  };
}

// After a successful Meta call. Best-effort throughout: the message HAS been sent,
// so nothing here may throw, retry the send, or change the outcome.
async function recordSent(ctx, row, send, result) {
  const { deps } = ctx;
  const wamid = deps.transport.extractWamid(result);
  const sentAt = nowDate(deps);
  await bestEffort(deps, 'recording a sent message', () => markRow(ctx, row._id, defined({
    status: 'sent',
    sentAt,
    wamid: wamid || undefined,
    phone: send.phone,
    requestedLanguage: send.pick.requestedLanguage,
    usedLanguage: send.pick.usedLanguage,
    fallback: send.pick.fallback,
    fallbackReason: send.pick.fallback ? send.pick.reason : null,
    metaTemplateName: send.variant.metaTemplateName,
  })));
  if (deps.transport.isDryRun()) return;
  await bestEffort(deps, 'campaign message row', () => deps.CampaignMessage.create(defined({
    workspaceId: ctx.workspaceId,
    kind: send.kind,
    customer: send.customer._id,
    phone: send.phone,
    wamid: wamid || undefined,
    messageType: 'template',
    templateName: send.variant.metaTemplateName,
    status: 'sent',
    sentAt,
    messageNode: ctx.template.linkedMessageNodeId || undefined,
  })));
  if (send.hasOptIn) {
    await bestEffort(deps, 'consent-ask stamp', () => deps.Customer.updateOne(
      { _id: send.customer._id, workspaceId: ctx.workspaceId, marketingConsent: { $ne: true } },
      { $set: { marketingConsentAskedAt: sentAt } },
    ));
  }
}

// One queued row, end to end. NEVER throws. -> { realSend, backoffMs, templateError? }
// (templateError = the Meta code when the send failed with a TEMPLATE-level error)
async function processRow(ctx, row) {
  const { deps } = ctx;
  let claimed;
  try {
    claimed = await deps.LocalizedSend.findOneAndUpdate(
      { _id: row._id, workspaceId: ctx.workspaceId, status: 'queued' },
      { $set: { status: 'sending' } },
      { returnDocument: 'after' },
    ).lean();
  } catch (err) {
    deps.log('could not claim a recipient row (left queued):', err && err.message);
    return { realSend: false };
  }
  if (!claimed) return { realSend: false }; // someone else owns it / it is no longer queued

  let prepared;
  try {
    prepared = await prepareRecipient(ctx, claimed);
  } catch (err) {
    deps.log('preparing a recipient failed:', err && err.message);
    await bestEffort(deps, 'marking a recipient failed', () => markRow(ctx, row._id, { status: 'failed', errorCode: 'internal', error: 'The message could not be prepared' }));
    return { realSend: false };
  }
  if (prepared.skip) {
    const { status, errorCode, error, fallbackReason } = prepared.skip;
    await bestEffort(deps, 'marking a recipient skipped', () => markRow(ctx, row._id, {
      status, ...(errorCode ? { errorCode } : {}), ...(error ? { error } : {}), ...(fallbackReason ? { fallbackReason } : {}),
    }));
    return { realSend: false };
  }

  const { send } = prepared;
  let result;
  try {
    result = await withTimeout(
      Promise.resolve().then(() => deps.transport.sendTemplate(send.phone, { name: send.variant.metaTemplateName, languageCode: send.languageCode, components: send.components })),
      deps.sendTimeoutMs,
    );
  } catch (err) {
    const { code, message } = describeSendError(err);
    await bestEffort(deps, 'recording a failed send', () => markRow(ctx, row._id, { status: 'failed', errorCode: code, error: message }));
    return {
      realSend: true,
      backoffMs: RATE_LIMIT_CODES.has(code) ? RATE_LIMIT_BACKOFF_MS : 0,
      ...(TEMPLATE_ERROR_CODES.has(code) ? { templateError: code } : {}),
    };
  }
  await recordSent(ctx, claimed, send, result);
  return { realSend: true, backoffMs: 0 };
}

async function failInterruptedRows(ctx) {
  await bestEffort(ctx.deps, 'marking interrupted sends', () => ctx.deps.LocalizedSend.updateMany(
    { campaignId: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'sending' },
    { $set: { status: 'failed', errorCode: 'interrupted', error: 'Sending was interrupted before the result was recorded; the message may or may not have been delivered' } },
  ));
}

async function ensureSnapshot(ctx, holder) {
  const { deps } = ctx;
  if (ctx.campaign.snapshotAt) return;
  let built = holder && holder.built;
  if (holder) holder.built = null;
  if (!built) built = await planner.buildPlan({ workspaceId: ctx.workspaceId, request: requestFromCampaign(ctx.campaign) }, deps);
  const rows = built.recipients.map((recipient) => snapshotRow({ campaign: ctx.campaign, recipient, template: ctx.template }));
  built = null;
  await insertSnapshot(deps, rows);
  await withRetry(deps, () => deps.LocalizedCampaign.updateOne(
    { _id: ctx.campaignId, workspaceId: ctx.workspaceId, claimedBy: ctx.runnerId },
    { $set: { snapshotAt: nowDate(deps) } },
  ));
}

// Only fills the cosmetic `lastError`, so it must NEVER be able to stop finalize(): a database
// that refuses the unindexed updatedAt sort (Cosmos DB can) would otherwise leave a fully sent
// campaign `sending` until the resumer gives up and marks it failed. Falls back to any failed row.
async function lastFailureText(ctx) {
  const filter = { campaignId: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'failed' };
  let row = null;
  try {
    row = await ctx.deps.LocalizedSend.findOne(filter).sort({ updatedAt: -1 }).select('error errorCode').lean();
  } catch (err) {
    ctx.deps.log('last failure lookup (sorted) failed, using any failed row:', err && err.message);
    try {
      row = await ctx.deps.LocalizedSend.findOne(filter).select('error errorCode').lean();
    } catch (err2) {
      ctx.deps.log('last failure lookup failed (ignored):', err2 && err2.message);
      return null;
    }
  }
  if (!row) return null;
  return row.errorCode && row.error ? `(${row.errorCode}) ${row.error}` : (row.error || row.errorCode || null);
}

// Ends the run: status sent | partial | failed + final stats + lastError. Leaves the
// campaign `sending` (for the resumer) when rows are still queued/sending.
//   failed   nothing was sent;
//   partial  something was sent AND some recipient was left out for a technical or
//            language reason (failed send, blocked variant, error skip) — policy
//            skips (no consent, opted out, demo, duplicate phone, already
//            consented / asked recently for a consent request) do not count;
//   sent     every addressable recipient was sent.
async function finalize(ctx) {
  const { deps } = ctx;
  const { stats, byStatus } = statsFromGroups(await aggregateRows(deps, ctx));
  if ((byStatus.queued || 0) > 0 || (byStatus.sending || 0) > 0) {
    await bestEffort(deps, 'progress update', () => updateStats(ctx, stats, 'sending'));
    return { complete: false };
  }
  const policySkips = await deps.LocalizedSend.countDocuments({
    campaignId: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'skipped_error', errorCode: { $in: POLICY_SKIP_CODES },
  });
  const technicalSkips = (byStatus.skipped_blocked || 0) + (byStatus.skipped_no_credit || 0) + (byStatus.skipped_error || 0) - policySkips;
  const incomplete = (byStatus.failed || 0) + technicalSkips > 0;
  const status = stats.sent === 0 ? 'failed' : (incomplete ? 'partial' : 'sent');
  let lastError = stats.failed > 0 ? await lastFailureText(ctx) : null;
  if (status === 'failed' && !lastError) lastError = 'No messages were sent: every recipient was skipped';
  const done = await withRetry(deps, () => deps.LocalizedCampaign.findOneAndUpdate(
    { _id: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'sending', claimedBy: ctx.runnerId },
    { $set: { status, stats, finishedAt: nowDate(deps), lastError } },
    { returnDocument: 'after' },
  ).lean());
  return { complete: !!done, status };
}

// The template (or its parameters) is unusable for everybody - Meta answered TEMPLATE_ERROR_STREAK
// template-level errors in a row - so the run ENDS here: no further Meta call is made, the rows
// not reached stay `queued` (nothing is deleted or rewritten), and the campaign is closed as
// failed (nothing was sent) or partial (something was) with lastError `template_unusable:<code>`,
// which tells the merchant what to fix. The compare-and-set on status/claimedBy means a campaign
// cancelled or taken over meanwhile is left alone. -> { complete, status, stopped, code }
async function stopForUnusableTemplate(ctx, code) {
  const { deps } = ctx;
  const { stats } = statsFromGroups(await aggregateRows(deps, ctx));
  const status = stats.sent === 0 ? 'failed' : 'partial';
  const done = await withRetry(deps, () => deps.LocalizedCampaign.findOneAndUpdate(
    { _id: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'sending', claimedBy: ctx.runnerId },
    { $set: { status, stats, finishedAt: nowDate(deps), lastError: `${TEMPLATE_UNUSABLE}:${code}` } },
    { returnDocument: 'after' },
  ).lean());
  deps.log(`campaign ${String(ctx.campaignId)} stopped: ${TEMPLATE_ERROR_STREAK} template-level errors in a row (${code}); the remaining recipients stay queued`);
  return { complete: !!done, status, stopped: TEMPLATE_UNUSABLE, code };
}

async function failCampaign(deps, { campaignId, workspaceId }, message, extraFilter = {}) {
  return deps.LocalizedCampaign.findOneAndUpdate(
    { _id: campaignId, workspaceId, status: 'sending', ...extraFilter },
    { $set: { status: 'failed', finishedAt: nowDate(deps), lastError: cleanError(message) } },
    { returnDocument: 'after' },
  ).lean();
}

// Background run for one claimed campaign. Never throws.
async function runCampaign({ workspaceId, campaignId, runnerId, holder }, deps = realDeps()) {
  const key = String(campaignId);
  if (activeRuns.has(key)) return { skipped: 'already_running' };
  activeRuns.add(key);
  try {
    return await execute({ workspaceId, campaignId, runnerId, holder }, deps);
  } catch (err) {
    deps.log(`campaign ${key} stopped unexpectedly (it will be resumed):`, err && err.message);
    await bestEffort(deps, 'recording the failure', () => deps.LocalizedCampaign.updateOne(
      { _id: campaignId, workspaceId, claimedBy: runnerId, status: 'sending' },
      { $set: { lastError: cleanError(err && err.message) } },
    ));
    return { error: true };
  } finally {
    activeRuns.delete(key);
  }
}

async function execute({ workspaceId, campaignId, runnerId, holder }, deps) {
  const campaign = await deps.LocalizedCampaign.findOne({ _id: campaignId, workspaceId }).lean();
  if (!campaign || campaign.status !== 'sending' || campaign.claimedBy !== runnerId) return { skipped: 'not_owner' };
  if (typeof deps.buildSendComponents !== 'function') {
    await failCampaign(deps, { campaignId, workspaceId }, 'The message builder is unavailable', { claimedBy: runnerId });
    return { error: true };
  }
  const template = await deps.LocalizedTemplate.findOne({ _id: campaign.templateId, workspaceId }).lean();
  if (!template) {
    await failCampaign(deps, { campaignId, workspaceId }, 'The template of this campaign no longer exists', { claimedBy: runnerId });
    return { error: true };
  }
  const [locale, business] = await Promise.all([deps.settings.getSettings(workspaceId), planner.resolveBusinessName(deps, workspaceId)]);
  const ctx = makeContext({ deps, campaign, template, runnerId, merchantDefault: locale.defaultCustomerLanguage, business });

  await ensureSnapshot(ctx, holder);
  await failInterruptedRows(ctx);

  let lastId = null;
  let templateStreak = 0; // consecutive Meta answers that were template-level errors (skips make no Meta call and do not count)
  for (;;) {
    const rows = await deps.LocalizedSend.find({
      campaignId: ctx.campaignId, workspaceId: ctx.workspaceId, status: 'queued', ...(lastId ? { _id: { $gt: lastId } } : {}),
    }).sort({ _id: 1 }).limit(BATCH).lean();
    if (!rows.length) break;
    for (const row of rows) {
      lastId = row._id;
      const state = await checkpoint(ctx);
      if (state !== 'ok') {
        if (state === 'cancelled') {
          await bestEffort(deps, 'closing the cancelled campaign', () => cancelQueuedRows(deps, ctx));
          await bestEffort(deps, 'final progress update', () => refreshStats(ctx, 'cancelled'));
        }
        return { stopped: state };
      }
      const outcome = await processRow(ctx, row);
      if (outcome.realSend) {
        templateStreak = outcome.templateError ? templateStreak + 1 : 0;
        if (templateStreak >= TEMPLATE_ERROR_STREAK) return stopForUnusableTemplate(ctx, outcome.templateError);
        await deps.sleep(SEND_THROTTLE_MS + (outcome.backoffMs || 0));
      }
    }
  }
  return finalize(ctx);
}

// Scheduler entry: takes over `sending` campaigns whose heartbeat is older than
// idleMs. Compare-and-set on the stale heartbeat means exactly one resumer wins;
// each resumed run continues in the background. Respects the kill switch and the
// per-merchant flag; a campaign that has already been claimed MAX_RUN_ATTEMPTS
// times is failed instead of resumed forever.
async function resumeStuckCampaigns({ idleMs = STALE_MS, limit = 20 } = {}, deps = realDeps()) {
  const result = { resumed: 0, failed: 0 };
  if (deps.settings.killSwitchOn()) return result;
  const cutoff = new Date(deps.now() - idleMs);
  const stuck = await deps.LocalizedCampaign.find({
    status: 'sending',
    $or: [{ lastHeartbeatAt: { $lt: cutoff } }, { lastHeartbeatAt: { $exists: false }, startedAt: { $lt: cutoff } }],
  }).sort({ _id: 1 }).limit(limit).lean(); // oldest campaign first; _id is always indexed (Cosmos DB sorts need an index)

  for (const doc of stuck) {
    try {
      if (activeRuns.has(String(doc._id))) continue;
      if (!(await deps.settings.isArabicEnabled(doc.workspaceId))) continue;
      const stale = doc.lastHeartbeatAt ? { lastHeartbeatAt: doc.lastHeartbeatAt } : { lastHeartbeatAt: { $exists: false } };
      if ((doc.runAttempts || 0) >= MAX_RUN_ATTEMPTS) {
        const failed = await failCampaign(deps, { campaignId: doc._id, workspaceId: doc.workspaceId }, 'Stopped after repeated interruptions', stale);
        if (failed) result.failed += 1;
        continue;
      }
      const runnerId = deps.newRunnerId();
      const now = nowDate(deps);
      const claimed = await deps.LocalizedCampaign.findOneAndUpdate(
        { _id: doc._id, workspaceId: doc.workspaceId, status: 'sending', ...stale },
        { $set: { claimedBy: runnerId, claimedAt: now, lastHeartbeatAt: now }, $inc: { runAttempts: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!claimed) continue;
      result.resumed += 1;
      deps.schedule(() => runCampaign({ workspaceId: doc.workspaceId, campaignId: doc._id, runnerId }, deps)
        .catch((err) => deps.log('resumed campaign run failed:', err && err.message)));
    } catch (err) {
      deps.log('resuming a campaign failed:', err && err.message);
    }
  }
  return result;
}

// ── single-customer send (Inbox "send loyalty reminder") ────────────────────

function clip(text, max) { return Array.from(String(text || '')).slice(0, max).join(''); }

// One immediate, synchronous send to ONE customer through the same checks, rendering
// and records as the bulk sender (a one-recipient campaign is created so it shows up
// in reports). Never falls back silently: when the customer's own language variant is
// not usable the message is NOT sent unless allowFallback is set, and the result says
// why. -> { sent, status, usedLanguage, fallback, reason, ... }
async function sendSingle({ workspaceId, templateId, customerId, fieldValues, languageMode = 'per_customer', createdBy, allowFallback = false }, deps = realDeps()) {
  const cid = asObjectId(customerId, 'customerId');
  const built = await planner.buildPlan({
    workspaceId,
    request: { templateId, languageMode, audience: { kind: 'customer_ids', customerIds: [cid] }, fieldValues },
  }, deps);
  const { plan, template } = built;
  const recipient = built.recipients[0];
  if (!recipient) throw httpError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');

  const refused = (status, reason, extra) => ({ sent: false, status, usedLanguage: null, fallback: false, reason, ...extra });
  if (built.context.templateError) return refused('skipped_blocked', built.context.templateError);
  if (recipient.skip) return refused(SKIP_STATUS[recipient.skip].status, recipient.skip);
  if (recipient.pick.blocked) return refused('skipped_blocked', recipient.pick.reason);
  if (recipient.pick.fallback && !allowFallback) return refused('skipped_blocked', recipient.pick.reason, { fallback: true });
  if (plan.missingFieldValues.length) return refused('skipped_error', 'field_values_missing', { missingFieldValues: plan.missingFieldValues });

  const runnerId = deps.newRunnerId();
  const now = nowDate(deps);
  const created = await deps.LocalizedCampaign.create({
    workspaceId,
    name: clip(template.name, 120),
    templateId: template._id,
    templateName: template.name,
    languageMode: built.request.languageMode,
    audience: { kind: 'customer_ids', customerIds: [cid] },
    fieldValues: built.request.fieldValues,
    category: plan.category,
    status: 'sending',
    plan: planner.stripSamples(plan),
    stats: { total: 1 },
    startedAt: now,
    claimedAt: now,
    claimedBy: runnerId,
    lastHeartbeatAt: now,
    runAttempts: 1,
    ...(createdBy && mongoose.isValidObjectId(String(createdBy)) ? { createdBy } : {}),
  });
  const campaign = typeof created.toObject === 'function' ? created.toObject() : created;
  const ctx = makeContext({ deps, campaign, template, runnerId, merchantDefault: built.context.merchantDefault, business: built.context.business });

  await insertSnapshot(deps, [snapshotRow({ campaign, recipient, template })]);
  await withRetry(deps, () => deps.LocalizedCampaign.updateOne({ _id: campaign._id, workspaceId, claimedBy: runnerId }, { $set: { snapshotAt: nowDate(deps) } }));
  const row = await deps.LocalizedSend.findOne({ campaignId: campaign._id, workspaceId, customerId: cid }).lean();
  await processRow(ctx, row);
  await finalize(ctx);

  const result = await deps.LocalizedSend.findOne({ _id: row._id, workspaceId }).lean();
  return {
    sent: result.status === 'sent',
    status: result.status,
    usedLanguage: result.usedLanguage || null,
    fallback: !!result.fallback,
    reason: result.status === 'sent' ? (result.fallback ? result.fallbackReason : 'ok') : (result.errorCode || result.status),
    ...(result.error ? { error: result.error } : {}),
    campaignId: String(campaign._id),
    wamid: result.wamid || null,
  };
}

module.exports = {
  SEND_THROTTLE_MS, SEND_TIMEOUT_MS, STALE_MS, MAX_RUN_ATTEMPTS, HEARTBEAT_EVERY, RATE_LIMIT_BACKOFF_MS,
  TEMPLATE_ERROR_CODES, TEMPLATE_ERROR_STREAK, OPTED_OUT_REFRESH_MS,
  realDeps, startSend, runCampaign, resumeStuckCampaigns, sendSingle,
  aggregateRows, statsFromGroups, cancelQueuedRows, requestFromCampaign, describeSendError, cleanError, buttonPayloadsFor, campaignMessageKind,
  isDuplicateOnly, _activeRuns: activeRuns,
};
