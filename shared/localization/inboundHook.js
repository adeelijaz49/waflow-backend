'use strict';
// Inbound WhatsApp hook for the Arabic localisation feature. Called from the
// existing webhook (server.js) right AFTER the Inbox hook:
//     if (await localization.handleInbound({ workspaceId, from, message, contactName })) return;
// so the Customer already exists and the message is already logged.
//
// It does four independent things (all fail OPEN: false => the existing flow runs):
//  1. TYPED ARABIC CONSENT KEYWORDS (spec §3.4, compliance-critical). A typed Arabic
//     opt-out ("إلغاء الاشتراك", "توقف", "ستوب"...) is honoured immediately, through the
//     SAME consent functions the English STOP path uses (logged to ConsentEvent
//     first), answered in Arabic, and the webhook stops there — like the existing
//     English STOP branch, so no pending address/booking flow can swallow it.
//     Always on (not flag-gated, works for every merchant and every customer
//     language). Typed opt-IN / decline words (نعم / لا / موافق / اشترك) only count
//     while a consent ask is genuinely pending AND no text-consuming flow
//     (checkout confirmation / address) is waiting on that phone. Pure-English text
//     is never touched (the existing code owns STOP/START); the one extension is an
//     English STOP/UNSUBSCRIBE carrying invisible direction marks (an RTL keyboard
//     appends U+200F), which the exact-match English branch silently misses.
//  2. ARABIC BUTTON TAPS (consent_yes_/consent_no_/optout_ payloads) from customers
//     whose language is Arabic: the same consent write + side effects as the English
//     branches (server.js template-button and button_reply branches), answered in
//     Arabic. English customers' taps always fall through untouched.
//  3. USABILITY REWRITES inside existing English flows (flag-gated): when the
//     existing state machine is waiting for YES/NO or for catalogue numbers, an
//     Arabic yes/no word or Arabic-Indic digits are rewritten IN PLACE to exactly
//     the tokens that machine accepts. Never for free text (the address flow stores
//     the text verbatim).
//  4. LANGUAGE INFERENCE (spec §3.1), only for merchants with arabic_enabled: when a
//     customer has no language yet, detect it from the message text.
//
// Decisions worth knowing:
//  * OPT-OUT PRECEDENCE: an opt-out keyword wins over every pending flow, like
//    English STOP (server.js "checked first, ahead of any pending flow"), even the
//    ambiguous bare "إلغاء" typed mid-checkout: a missed opt-out is the worse error,
//    and the pending checkout is left untouched so the customer can still answer it.
//  * NEGATION: matching is whole-message (see keywords.js); "لا تلغي اشتراكي" is never
//    an opt-out. A short sentence with an explicit unsubscribe phrase is one.
//  * FAILED WITHDRAWAL: never acknowledged as success. The withdrawal is retried once
//    (Cosmos throttling is transient), then logged with console.error and the
//    customer gets the neutral consent.tryAgain message; the hook still returns true
//    so the typed text is not misread as an address.
//  * METHODS: ConsentEvent/Customer enums have no "typed reply" value and the
//    models are not ours: whatsapp_stop_command / whatsapp_start_command /
//    whatsapp_optout_button / whatsapp_button are reused and the free-text `source`
//    records exactly how it happened.
//
// It must never throw and returns true ONLY when it fully handled the message.
// All collaborators are injectable (see realDeps) so tests need no database.
const { classifyInboundText, stripFillers } = require('./keywords');
const { containsArabic, stripInvisibles, normalizeArabic, normalizeForMatch } = require('./arabicText');
const { detectLanguage } = require('./languageDetect');
const { YES_PREFIX, NO_PREFIX } = require('./consentAsk');

const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000; // a consent ask is "pending" for 24h (the WhatsApp service window)
const OPT_OUT_PREFIX = 'optout_';
const PROTECTED_LANGUAGE_SOURCES = ['merchant_set', 'csv_import', 'customer_chose'];
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const ARABIC_DIGITS_RE = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u;
// The two prefilled referral/tracking texts carry an English "Code: <CODE>" token
// (shared/referrals.js, shared/instagram.js) — they say nothing about the language.
const PREFILL_CODE_RE = /code:\s*(?:IG-[A-Z0-9]{8}|[A-F0-9]{10})/i;
const WITHDRAW_RETRY_DELAY_MS = 250;

// Meta redelivers webhooks; remember what we fully handled for a few minutes so a
// redelivery does not write a second consent event or send a second reply.
const HANDLED_TTL_MS = 10 * 60 * 1000;
const HANDLED_MAX = 500;
const handledIds = new Map();

const ALL_WORDS = new Set(['الكل', 'كل', 'كلها', 'الجميع', 'جميعها', 'كل المنتجات'].map(normalizeForMatch));

function realDeps() {
  return {
    Customer: require('../../models/Customer'),
    ConsentEvent: require('../../models/ConsentEvent'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    CampaignMessage: require('../../models/CampaignMessage'),
    consent: require('../consent'),
    settings: require('./settings'),
    transport: require('./transport'),
    catalog: require('./catalog'),
    state: require('../../utils/state'),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (...a) => console.error('[localization]', ...a),
    debug: (...a) => { if (process.env.LOCALIZATION_DEBUG === '1') console.debug('[localization]', ...a); },
    // H1 (same-number opt-out) and the outbound localiser's language hint. Optional: absent in unit-test fakes.
    samePhoneOptOut: (args) => require('./samePhone').optOutSamePhone(args),
    noteLanguage: (workspaceId, phone, language) => require('./outbound').noteLanguage(workspaceId, phone, language),
  };
}

// ── small helpers ──────────────────────────────────────────────────────────

function seenBefore(deps, message) {
  const id = message && message.id;
  if (typeof id !== 'string') return false;
  const at = handledIds.get(id);
  return at !== undefined && deps.now() - at < HANDLED_TTL_MS;
}

function markHandled(deps, message) {
  const id = message && message.id;
  if (typeof id !== 'string') return;
  const now = deps.now();
  handledIds.set(id, now);
  if (handledIds.size > HANDLED_MAX) {
    for (const [k, at] of handledIds) { if (now - at >= HANDLED_TTL_MS || handledIds.size > HANDLED_MAX) handledIds.delete(k); }
  }
}

function resetHandled() { handledIds.clear(); }

// One customer lookup per message, shared by every step.
function makeContext(deps, workspaceId, from) {
  let customer;
  return {
    async customer() {
      if (customer === undefined) customer = (await deps.Customer.findOne({ phone: from, workspaceId })) || null;
      return customer;
    },
  };
}

async function reply(deps, to, lang, key) {
  try {
    await deps.transport.sendText(to, deps.catalog.t(lang, key));
  } catch (err) {
    deps.log('reply failed (ignored):', err && err.message);
  }
}

async function customerIsArabic(deps, workspaceId, customer) {
  if (!customer) return false;
  const rec = await deps.CustomerLanguage.findOne({ workspaceId, customerId: customer._id }).lean();
  return !!rec && rec.language === 'ar';
}

// Reply-language lookup for a Latin-script keyword; a failure just means English.
async function customerIsArabicSafe(deps, workspaceId, ctx) {
  try { return await customerIsArabic(deps, workspaceId, await ctx.customer()); } catch (err) { return false; }
}

function onlyDigits(value) { return String(value === undefined || value === null ? '' : value).replace(/\D/g, ''); }

// Pending maps that CONSUME the next text message (server.js: service checkout YES/NO,
// points checkout YES/NO, delivery address). While one is set, a bare نعم/لا belongs to
// that flow, not to the consent ask. (pendingCatalogs ignores everything but "all" /
// numbers, so it never competes for نعم/لا.)
function hasTextConsumingFlow(deps, from) {
  const s = deps.state || {};
  return [s.pendingServiceCheckouts, s.pendingPointsCheckouts, s.pendingAddressReqs].some((m) => m && typeof m.has === 'function' && m.has(from));
}

// A consent ask is pending when the customer was offered the opt-in buttons,
// has not consented or opted out, and nothing has answered it since.
async function hasPendingConsentAsk(deps, customer) {
  if (!customer || customer.marketingConsent || customer.optedOut || !customer.marketingConsentAskedAt) return false;
  const askedAt = new Date(customer.marketingConsentAskedAt);
  if (deps.now() - askedAt.getTime() > PENDING_WINDOW_MS) return false;
  const answered = await deps.ConsentEvent.exists({
    customerId: customer._id,
    createdAt: { $gte: askedAt },
    type: { $in: ['consent_given', 'consent_declined', 'consent_withdrawn'] },
  });
  return !answered;
}

// Run one consent write. On failure: log loudly (compliance trail), tell the customer
// to retry in neutral words (never claim success) and report false.
async function applyConsentChange(deps, { from, lang, label }, action) {
  try {
    return { ok: true, value: await action() };
  } catch (err) {
    deps.log(`CONSENT WRITE FAILED (${label}) — customer was asked to retry:`, err && err.message);
    await reply(deps, from, lang, 'consent.tryAgain');
    return { ok: false };
  }
}

// The consent function logs the event BEFORE mutating the customer, so a retry is
// safe (worst case: two consent_withdrawn events; the log is append-only).
async function withdrawWithRetry(deps, args) {
  try {
    return await deps.consent.withdrawMarketingConsent(args);
  } catch (err) {
    deps.log('opt-out write failed, retrying once:', err && err.message);
    await deps.sleep(WITHDRAW_RETRY_DELAY_MS);
    return deps.consent.withdrawMarketingConsent(args);
  }
}

// Handlers below return false (not ours), true (applied and answered) or FAILED
// (ours, answered with the retry message, NOT applied: the webhook stops, but a
// redelivery of the same message must be allowed to try again).
const FAILED = 'failed';

// H1 (approved global change): a STOP also opts out every OTHER record of this workspace with the same normalised number.
// Never throws; a no-op when the dependency is absent (unit-test fakes).
async function sweepSamePhone(deps, { workspaceId, from, customer, source, method }) {
  if (typeof deps.samePhoneOptOut !== 'function') return;
  try { await deps.samePhoneOptOut({ workspaceId, from, exceptCustomerId: customer && customer._id, method, source }); }
  catch (err) { deps.log('same-number opt-out failed (ignored):', err && err.message); }
}

async function optOut(deps, { workspaceId, from, lang, customer, source, method }) {
  if (customer && customer.optedOut === true) {
    await sweepSamePhone(deps, { workspaceId, from, customer, source, method });
    await reply(deps, from, lang, 'consent.alreadyOptedOut');
    return true;
  }
  if (customer) {
    const done = await applyConsentChange(deps, { from, lang, label: 'opt-out' },
      () => withdrawWithRetry(deps, { customer, method, source, workspaceId }));
    if (!done.ok) return FAILED;
  }
  await sweepSamePhone(deps, { workspaceId, from, customer, source, method });
  await reply(deps, from, lang, 'consent.optOutAck');
  return true;
}

// ── typed keywords ─────────────────────────────────────────────────────────

async function handleKeyword(deps, ctx, { workspaceId, from, cls, lang }) {
  // If the customer cannot even be looked up, an opt-out must not vanish silently.
  const looked = cls.kind === 'opt_out'
    ? await applyConsentChange(deps, { from, lang, label: 'opt-out customer lookup' }, () => ctx.customer())
    : { ok: true, value: await ctx.customer() };
  if (!looked.ok) return FAILED;
  const customer = looked.value;
  const sourceTag = cls.isArabic ? `Arabic reply "${cls.keyword}"` : `reply "${cls.keyword}" (with direction marks)`;

  if (cls.kind === 'opt_out') {
    return optOut(deps, { workspaceId, from, lang, customer, source: sourceTag, method: 'whatsapp_stop_command' });
  }
  if (!cls.isArabic) return false; // English START/YES/NO stay with the existing code

  const pending = await hasPendingConsentAsk(deps, customer);

  if (cls.kind === 'subscribe') {
    if (pending) return grantTyped(deps, { workspaceId, from, lang, customer, sourceTag });
    // Same semantics as the English START branch: only reinstates someone who had
    // genuinely consented before; never fabricates consent.
    if (customer && customer.marketingConsent === true && customer.optedOut !== true) {
      await reply(deps, from, lang, 'consent.alreadySubscribed');
      return true;
    }
    let reinstated = false;
    if (customer) {
      const done = await applyConsentChange(deps, { from, lang, label: 'reinstate' },
        () => deps.consent.reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: `${sourceTag} (start)`, workspaceId }));
      if (!done.ok) return FAILED;
      reinstated = !!done.value;
    }
    await reply(deps, from, lang, reinstated ? 'consent.startAck' : 'consent.startNoConsent');
    return true;
  }

  if (!pending || hasTextConsumingFlow(deps, from)) return false; // a bare yes/no is just conversation, or belongs to another flow

  if (cls.kind === 'affirm') return grantTyped(deps, { workspaceId, from, lang, customer, sourceTag });
  if (cls.kind === 'decline') {
    const done = await applyConsentChange(deps, { from, lang, label: 'decline' },
      () => deps.consent.declineMarketingConsent({ customer, method: 'whatsapp_button', source: `${sourceTag} to pending consent ask (typed)`, workspaceId }));
    if (!done.ok) return FAILED;
    await reply(deps, from, lang, 'consent.declineAck');
    return true;
  }
  return false;
}

async function grantTyped(deps, { workspaceId, from, lang, customer, sourceTag }) {
  const done = await applyConsentChange(deps, { from, lang, label: 'opt-in' },
    () => deps.consent.grantMarketingConsent({ customer, method: 'whatsapp_button', source: `${sourceTag} to pending consent ask (typed)`, workspaceId }));
  if (!done.ok) return FAILED;
  await reply(deps, from, lang, 'consent.optInAck');
  return true;
}

// ── usability rewrites inside the existing English flows ───────────────────

function yesNoWord(text) {
  const cls = classifyInboundText(text);
  if (!cls || cls.match !== 'exact') return null;
  if (cls.kind === 'affirm') return 'YES';
  if (cls.kind === 'decline') return 'NO';
  return null;
}

// Arabic-Indic digits / Arabic comma -> exactly what `text.split(/[\s,]+/)` + parseInt
// understand, and the Arabic "all" -> "all". null when it is not a selection.
function catalogSelection(text) {
  if (ALL_WORDS.has(stripFillers(normalizeForMatch(text)))) return 'all';
  const converted = normalizeArabic(text).trim();
  if (converted !== text.trim() && /^\d+(?:\s*[,\s]\s*\d+)*$/.test(converted)) return converted;
  return null;
}

// Proven from server.js (text branch): service checkout is checked first and accepts
// exactly YES/NO (upper-cased), then points checkout (same), then the address flow
// (ANY text, stored verbatim -> never rewritten), then the catalogue ("all" or
// numbers). Mirror that precedence and rewrite only closed-set replies.
function rewriteForPendingFlow(deps, from, message, text) {
  const s = deps.state || {};
  const has = (m) => !!m && typeof m.has === 'function' && m.has(from);
  let replacement = null;
  if (has(s.pendingServiceCheckouts) || has(s.pendingPointsCheckouts)) replacement = yesNoWord(text);
  else if (has(s.pendingAddressReqs)) replacement = null;
  else if (has(s.pendingCatalogs)) replacement = catalogSelection(text);
  if (replacement && replacement !== text) {
    message.text.body = replacement;
    deps.debug(`rewrote an Arabic reply for a pending flow (${from.slice(-4)}): ${replacement}`);
  }
}

// ── language inference ─────────────────────────────────────────────────────

function wordCount(text) {
  return String(text).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

function isNameEcho(text, names) {
  const t = normalizeForMatch(text);
  return !!t && names.some((n) => n && normalizeForMatch(n) === t);
}

// Tells the outbound localiser (outbound.js) the language just stored, so this customer's very next reply uses it. Never throws.
function noteLanguageHint(deps, workspaceId, customer, language) {
  try { if (typeof deps.noteLanguage === 'function') deps.noteLanguage(workspaceId, customer.phone, language); } catch (_) { /* never throws */ }
}

// Detect and store the customer's language the first time we can tell.
// Weak evidence is skipped (and retried on a later message) rather than locked in:
//  * the English prefilled referral/Instagram text (Latin "Code: ..." token);
//  * a single English word ("Hi") — Arabic speakers often open in English;
//  * the customer simply echoing their own name.
async function inferLanguage(deps, ctx, { workspaceId, text, contactName }) {
  const detected = detectLanguage(text);
  if (detected.language === 'unknown') return false;
  if (PREFILL_CODE_RE.test(text) && detected.language !== 'ar') return false;
  if (detected.language === 'en' && wordCount(text) < 2) return false;
  const customer = await ctx.customer();
  if (!customer) return false;
  if (isNameEcho(text, [contactName, customer.firstname, `${customer.firstname || ''} ${customer.lastname || ''}`])) return false;

  const existing = await deps.CustomerLanguage.findOne({ workspaceId, customerId: customer._id }).lean();
  if (existing) {
    // Never override a determined language, nor anything a human set.
    if (existing.language !== 'unknown' || PROTECTED_LANGUAGE_SOURCES.includes(existing.languageSource)) return false;
    await deps.CustomerLanguage.updateOne(
      { _id: existing._id, language: 'unknown', languageSource: { $nin: PROTECTED_LANGUAGE_SOURCES } },
      { $set: { language: detected.language, languageSource: 'inferred', inferredConfidence: detected.confidence }, $inc: { inferenceAttempts: 1 } },
    );
    noteLanguageHint(deps, workspaceId, customer, detected.language);
    return true;
  }
  try {
    await deps.CustomerLanguage.create({
      workspaceId, customerId: customer._id, language: detected.language, languageSource: 'inferred', inferredConfidence: detected.confidence, inferenceAttempts: 1,
    });
  } catch (err) {
    if (!err || err.code !== 11000) throw err; // a concurrent message created it first — fine
  }
  noteLanguageHint(deps, workspaceId, customer, detected.language);
  return true;
}

// ── text messages ──────────────────────────────────────────────────────────

async function handleText(deps, { workspaceId, from, message, contactName, killed = false }) {
  const text = message.text && message.text.body;
  if (typeof text !== 'string' || !text.trim()) return false;
  if (seenBefore(deps, message)) return true;
  const ctx = makeContext(deps, workspaceId, from);
  // A flag-lookup failure must not cost a customer their opt-out: treat as "off".
  let enabled = false;
  try { enabled = !killed && await deps.settings.isArabicEnabled(workspaceId); } catch (err) { deps.log('arabic flag lookup failed (ignored):', err && err.message); }

  // 4) language inference (flag-gated, never blocks or fails the message)
  if (enabled) {
    try { await inferLanguage(deps, ctx, { workspaceId, text, contactName }); } catch (err) { deps.log('language inference failed (ignored):', err && err.message); }
  }

  // 1) consent keywords: Arabic-script text, or English STOP carrying invisible direction marks
  const arabic = containsArabic(text);
  const markedLatin = !arabic && stripInvisibles(text) !== text;
  if (arabic || markedLatin) {
    const cls = classifyInboundText(text);
    // Kill switch (LOCALIZATION_DISABLED): everything is off EXCEPT the exact opt-out
    // keywords — consent withdrawal is compliance-critical and must not hinge on an ops switch.
    const allowedNow = !killed || (cls && cls.kind === 'opt_out' && cls.match === 'exact');
    if (cls && allowedNow && (arabic || cls.kind === 'opt_out')) {
      const lang = (arabic || await customerIsArabicSafe(deps, workspaceId, ctx)) ? 'ar' : 'en';
      const handled = await handleKeyword(deps, ctx, { workspaceId, from, cls, lang });
      if (handled) {
        if (handled === true) markHandled(deps, message);
        return true;
      }
    }
  }

  // 3) usability rewrites for the existing flows (never handles the message itself)
  if (enabled && (arabic || ARABIC_DIGITS_RE.test(text))) rewriteForPendingFlow(deps, from, message, text);
  return false;
}

// ── button taps ────────────────────────────────────────────────────────────

// -> { via: 'template'|'interactive', id, title } | null (not a button we care about)
function parseTap(message) {
  let tap = null;
  if (message.type === 'button' && message.button) tap = { via: 'template', id: message.button.payload, title: message.button.text };
  else if (message.type === 'interactive' && message.interactive && message.interactive.type === 'button_reply' && message.interactive.button_reply) {
    tap = { via: 'interactive', id: message.interactive.button_reply.id, title: message.interactive.button_reply.title };
  }
  if (!tap || typeof tap.id !== 'string') return null;
  return { ...tap, title: typeof tap.title === 'string' ? tap.title : '' };
}

function tapKind(id) {
  if (id.startsWith(YES_PREFIX)) return { name: 'yes', arg: id.slice(YES_PREFIX.length) };
  if (id.startsWith(NO_PREFIX)) return { name: 'no', arg: id.slice(NO_PREFIX.length) };
  if (id.startsWith(OPT_OUT_PREFIX)) return { name: 'optout', arg: id.slice(OPT_OUT_PREFIX.length) };
  return null;
}

// Mirrors server.js correlateClick (not exported there): the click is recorded on
// the CampaignMessage that carried the button — precisely by the wamid of the message
// being replied to, else (opt-out only) the customer's latest send of that promotion.
// Only the template-button branch of the English code does this. Never throws.
async function correlateClick(deps, { from, wamid, promotionId, workspaceId }) {
  try {
    let cm = null;
    if (typeof wamid === 'string' && wamid) {
      cm = await deps.CampaignMessage.findOneAndUpdate({ wamid, workspaceId }, { clickedAt: new Date() }, { returnDocument: 'after' });
    }
    if (!cm && OBJECT_ID_RE.test(promotionId || '')) {
      const customer = await deps.Customer.findOne({ phone: from, workspaceId });
      if (customer) {
        await deps.CampaignMessage.findOneAndUpdate(
          { promotion: promotionId, customer: customer._id, status: { $in: ['sent', 'delivered', 'read'] }, workspaceId },
          { clickedAt: new Date() },
          { sort: { createdAt: -1 }, returnDocument: 'after' },
        );
      }
    }
  } catch (err) {
    deps.log('correlateClick failed (ignored):', err && err.message);
  }
}

async function handleButtonTap(deps, { workspaceId, from, message }) {
  const tap = parseTap(message);
  const kind = tap && tapKind(tap.id);
  if (!kind) return false;
  if (seenBefore(deps, message)) return true;

  if (kind.name !== 'optout' && !OBJECT_ID_RE.test(kind.arg)) return false;
  let customer;
  try {
    customer = kind.name === 'optout'
      ? await deps.Customer.findOne({ phone: from, workspaceId })
      : await deps.Customer.findOne({ _id: kind.arg, workspaceId });
  } catch (err) {
    if (kind.name !== 'optout' || !containsArabic(tap.title)) throw err; // fail open
    // An Arabic opt-out tap that cannot be applied must be answered honestly, not dropped.
    deps.log('CONSENT WRITE FAILED (opt-out button customer lookup) — customer was asked to retry:', err && err.message);
    await reply(deps, from, 'ar', 'consent.tryAgain');
    return true;
  }
  if (!customer) return false;
  if (kind.name !== 'optout' && onlyDigits(customer.phone) !== onlyDigits(from)) return false; // the payload names someone else: leave it to the existing code
  // A STORED Arabic language only counts while the workspace is switched on (ACC-BE): after a merchant is switched off, a tap on an English-titled
  // button is the existing English code's business. An Arabic-titled tap is always honoured (the Arabic message was sent while it was on).
  if (!containsArabic(tap.title) && !((await customerIsArabic(deps, workspaceId, customer)) && (await deps.settings.isArabicEnabled(workspaceId)))) return false;

  if (tap.via === 'template') {
    await correlateClick(deps, { from, wamid: message.context && message.context.id, promotionId: kind.name === 'optout' ? kind.arg : undefined, workspaceId });
  }
  const template = tap.via === 'template';
  let handled;
  if (kind.name === 'optout') {
    handled = await optOut(deps, { workspaceId, from, lang: 'ar', customer, source: `Opt Out button on promotion ${kind.arg} (Arabic)`, method: 'whatsapp_optout_button' });
  } else {
    const source = `${template ? 'bulk consent-request campaign' : 'order/booking confirmation consent button'} (Arabic)`;
    const yes = kind.name === 'yes';
    const done = await applyConsentChange(deps, { from, lang: 'ar', label: yes ? 'opt-in button' : 'decline button' }, () => (yes
      ? deps.consent.grantMarketingConsent({ customer, method: 'whatsapp_button', source, workspaceId })
      : deps.consent.declineMarketingConsent({ customer, method: 'whatsapp_button', source, workspaceId })));
    if (done.ok) await reply(deps, from, 'ar', yes ? 'consent.optInAck' : 'consent.declineAck');
    handled = done.ok ? true : FAILED;
  }
  if (handled === true) markHandled(deps, message);
  return !!handled;
}

// ── entry point ────────────────────────────────────────────────────────────

async function handleInbound(args, rawDeps = realDeps()) {
  // A broken logger must never cost a customer their opt-out.
  const deps = { ...rawDeps, log: (...a) => { try { rawDeps.log(...a); } catch (e) { /* ignore */ } } };
  try {
    const { workspaceId, from, message, contactName } = args || {};
    if (!workspaceId || !from || !message) return false;
    const killed = !!deps.settings.killSwitchOn();
    if (message.type === 'text') return await handleText(deps, { workspaceId, from, message, contactName, killed });
    if (killed) return false;
    if (message.type === 'button' || message.type === 'interactive') return await handleButtonTap(deps, { workspaceId, from, message });
    return false;
  } catch (err) {
    // A failure here must never break the customer's conversation: fall through
    // to the existing flow. (A failed consent write is handled — and logged loudly —
    // inside applyConsentChange before it can get here.)
    deps.log('handleInbound failed:', err && err.message);
    return false;
  }
}

module.exports = { PENDING_WINDOW_MS, handleInbound, hasPendingConsentAsk, inferLanguage, realDeps, resetHandled };
