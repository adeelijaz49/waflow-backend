'use strict';
// Templates service — per-language variants, submission to Meta and approval
// tracking (spec §3.2 "a template has language variants ... each with its own
// Meta approval status", §4, §8 "build the submit-for-approval path early").
// One LocalizedTemplate document per template, one VARIANT per language; Meta
// approves each separately, so each carries its own body, buttons, Meta name,
// status and native-review state. Nothing here touches the existing
// MessageNode/Promotion template code.
//
// Rules this module enforces (they are the compliance-critical plumbing):
//  * Variant writes are positional (`variants.$.x`) and guarded by the variant's
//    `contentVersion`: a save, a submit, a review and a status refresh can never
//    overwrite each other (even across variants), and an approval or review can
//    never be attached to text that changed in the meantime.
//  * Changing a variant's header/body/footer/buttons resets it to Meta
//    NOT_CREATED + review `draft` (reviewer cleared). `submissionCount` and the
//    old Meta name stay as history; the re-submission gets a NEW name
//    (wf_<ws6>_<key>_<en|ar|bi>_v<revision>) — a name is never reused, because the
//    existing code looks templates up and deletes them by name only (audit R2 §5).
//  * Submission claims its revision BEFORE calling Meta (atomic count bump), so a
//    double click or two tabs never send the same revision twice, and a failure
//    whose outcome is unknown (timeout) can never make a retry reuse the name.
//    Nothing is ever deleted at Meta (no delete method exists in metaTemplates.js).
//  * Machine/AI text is saved as draft; only reviewVariant can mark `reviewed`.
//  * Changing a template's category invalidates what Meta approved (the old
//    category) — submitted variants drop back to NOT_CREATED — and a category
//    Meta reports as MARKETING escalates a UTILITY template (consent rules must
//    follow the stricter category); it is never downgraded automatically.
//  * The UTILITY floor (category.js): only the transactional use cases may be UTILITY.
//    Create, update and library copy store MARKETING for every other use case
//    (corrected, never rejected - the returned template carries the stored value), and
//    a legacy row that still says UTILITY is validated, shown and submitted as MARKETING.
//  * Live-Meta findings (META-REALITY): the create response (id, status, category) is stored as
//    reported, never forced to PENDING; names are matched on exact name+language/id; text Meta
//    rejected is remembered (hash) and never resubmitted unchanged; polling is GET /{id} per
//    variant plus a delta sweep; new submissions stop at LOCALIZATION_TEMPLATE_CEILING
//    (default 90) of Meta's 250 template slots (error META_TEMPLATE_LIMIT).
//  * LOCALIZATION_SEND_MODE=dry_run: submit builds and returns what WOULD be
//    sent, changes no state and calls nothing; refresh does nothing.
// Collaborators (store, Meta client, transport, settings, ...) are injectable —
// see createTemplatesService — so tests need no database, network or WhatsApp.
const crypto = require('crypto');
const { assertObjectId, isObjectIdLike } = require('./scope');
const { BUTTON_ROLES, validateVariant } = require('./metaConstraints');
const { checkSendable } = require('./variantSelection');
const { KNOWN_FIELDS, extractFields, sampleValue } = require('./mergeFields');
const { normalizeForMatch, stripInvisibles, toWesternDigits } = require('./arabicText');
const { normalizePhoneForDedup } = require('../../utils/phoneNormalize');
const catalog = require('./catalog');
const meta = require('./metaTemplates');
const { isTransactionalUseCase, floorCategory } = require('./category');

const LANGUAGES = ['en', 'ar', 'bilingual'];
const LANGUAGE_ORDER = { en: 0, ar: 1, bilingual: 2 };
const SOURCES = ['merchant', 'library', 'ai', 'import'];
const ORDERS = ['ar_first', 'en_first'];
const CATEGORIES = ['MARKETING', 'UTILITY'];
const USE_CASES = ['comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'payment_reminder', 'booking_confirmation',
  'booking_reminder', 'order_confirmation', 'referral_invite', 'referral_reward', 'welcome_optin', 'promotion', 'greeting', 'custom'];
// welcome_optin is NOT a transactional use case: Meta classifies the consent request as MARKETING (it re-classified both UTILITY templates this app ever submitted).
// The UTILITY floor (category.js): UTILITY only ever survives for TRANSACTIONAL_USE_CASES.
const REVIEW_STATUSES = ['draft', 'reviewed'];
// A new submission would duplicate a template that is live or under review.
const BLOCKING_STATUSES = ['PENDING', 'IN_APPEAL', 'APPROVED'];
// What the background sweep re-checks (PAUSED: to notice recovery; ERROR: a status we did not know yet).
const SWEEP_STATUSES = ['PENDING', 'IN_APPEAL', 'PAUSED', 'ERROR'];

// Storage caps for what a client may send (validation still flags Meta's own,
// lower limits so a merchant sees exactly what to fix; these only stop abuse).
const CAPS = { NAME: 120, BODY: 4096, HEADER: 300, FOOTER: 300, BUTTON_TEXT: 100, URL: 2100, BUTTONS: 20, VALUE: 500, VALUES: 30, KEY: 60, VARIANTS: 3 };
const LIST_CAP = 1000;
const CANDIDATE_CAP = 500;
const MAX_ATTEMPTS = 3;
const MAX_KEY_TRIES = 50;
const MAX_SWEEP_ERRORS = 3;
const SUBMIT_LOCK_MS = 2 * 60 * 1000; // an in-flight submission blocks a second one this long (Graph times out after 20 s)
const MANUAL_REFRESH_LIMIT = 50;
const TEST_SEND_LIMIT = 10; // per workspace per hour
const DEFAULT_TEMPLATE_CEILING = 90; // of Meta's 250 slots per WABA: every revision of every language uses one for good (deleting is forbidden)
const MAX_REMEMBERED_REJECTIONS = 5;
const SWEEP_NAME_BATCH = 100;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const ZERO_ID = '000000000000000000000000'; // a valid ObjectId that matches no customer/node: inert button payloads in test sends
const TEST_OPT_OUT_PAYLOAD = 'l10ntest_optout'; // the test-send opt-out button: a prefix no webhook branch dispatches on (see testButtonPayloads)

// ── errors ────────────────────────────────────────────────────────────────
// Carries everything the route needs to answer: { error, code, + issues | metaError }.
class TemplateError extends Error {
  constructor(status, code, message, { issues, metaError, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'TemplateError';
    this.status = status;
    this.code = code;
    this.expose = true;
    this.retryAfterSeconds = retryAfterSeconds;
    this.body = { error: message, code, ...(issues ? { issues } : {}), ...(metaError ? { metaError } : {}) };
  }
}

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

const invalid = (message) => new TemplateError(400, 'INVALID_INPUT', message);

function assertId(value, label = 'id') {
  try {
    return assertObjectId(value, label);
  } catch (err) {
    throw new TemplateError(400, 'INVALID_ID', err.message);
  }
}

// An id that only annotates a record (who created/reviewed it): stored when it is an ObjectId, never a reason to fail.
function optionalId(value) {
  return value && isObjectIdLike(value) ? String(value) : undefined;
}

function assertOneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw invalid(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function assertLanguage(language) {
  return assertOneOf(language, LANGUAGES, 'language');
}

function mapMetaFailure(err) {
  if (err instanceof meta.MetaNotConfiguredError) {
    return new TemplateError(503, 'META_NOT_CONFIGURED', 'WhatsApp is not connected for this platform yet');
  }
  const metaError = (err && err.metaError) || { message: 'WhatsApp (Meta) request failed' };
  return new TemplateError(502, 'META_ERROR', 'WhatsApp (Meta) could not process the request', { metaError });
}

// ── small helpers ─────────────────────────────────────────────────────────
function iso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function plain(doc) {
  return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
}

const codePoints = (s) => Array.from(String(s)).length;

function cleanString(value, label, max) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(`${label} must be a string`);
  const s = value.replace(/\u{0000}/gu, '').replace(/\r\n?/g, '\n').trim();
  if (codePoints(s) > max) throw invalid(`${label} is too long (max ${max} characters)`);
  return s;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function defaultCategoryFor(useCase) {
  return isTransactionalUseCase(useCase) ? 'UTILITY' : 'MARKETING';
}

// The category a STORED template is validated, shown and submitted under: the requested one
// with the UTILITY floor applied (a legacy row may still say UTILITY for a promotion).
function categoryOf(doc) {
  return floorCategory(doc.useCase || 'custom', doc.category);
}

// Unicode-aware slug: letters/digits of any script, words joined by "_".
function deriveKey(name) {
  const folded = String(name).normalize('NFD').replace(/[\u{0300}-\u{036F}]/gu, ''); // Café -> Cafe (Arabic marks are removed by normalizeForMatch)
  const slug = Array.from(normalizeForMatch(folded).replace(/\s+/g, '_')).slice(0, CAPS.KEY).join('').replace(/_+$/g, '');
  return slug || 'template';
}

function isDuplicateKeyError(err) {
  return !!err && (err.code === 11000 || err.code === 11001);
}

// ── input normalisation ───────────────────────────────────────────────────
function normalizeButtons(raw, { strictRoles }) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid('buttons must be an array');
  if (raw.length > CAPS.BUTTONS) throw invalid(`buttons may contain at most ${CAPS.BUTTONS} entries`);
  const issues = [];
  const buttons = raw.map((b, i) => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw invalid(`buttons[${i}] must be an object`);
    const role = typeof b.role === 'string' ? b.role : '';
    if (!BUTTON_ROLES.includes(role)) issues.push({ code: 'invalid_button_role', field: `buttons.${i}` });
    const out = { role, text: cleanString(b.text, `buttons[${i}].text`, CAPS.BUTTON_TEXT) };
    if (role === 'url') {
      const url = cleanString(b.url, `buttons[${i}].url`, CAPS.URL);
      if (url) out.url = url;
    }
    return out;
  });
  // Storing a button without a known role would create a dead button; the
  // validate endpoint (lenient) reports it instead of refusing.
  if (strictRoles && issues.length) throw new TemplateError(400, 'VARIANT_INVALID', 'Some buttons have an unknown role', { issues });
  return buttons;
}

// Allow-list copy of a VariantInput: { header, body, footer, buttons, source, bilingualOrder? }
function normalizeVariantInput(input, language, { strictRoles = true } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('variant must be an object');
  const out = {
    header: cleanString(input.header, 'header', CAPS.HEADER),
    body: cleanString(input.body, 'body', CAPS.BODY),
    footer: cleanString(input.footer, 'footer', CAPS.FOOTER),
    buttons: normalizeButtons(input.buttons, { strictRoles }),
    source: 'merchant',
  };
  if (input.source !== undefined && input.source !== null) out.source = assertOneOf(input.source, SOURCES, 'source');
  if (input.bilingualOrder !== undefined && input.bilingualOrder !== null) {
    assertOneOf(input.bilingualOrder, ORDERS, 'bilingualOrder');
    if (language === 'bilingual') out.bilingualOrder = input.bilingualOrder;
  }
  return out;
}

function isDraftInput(input) {
  return !!input && typeof input === 'object' && ['header', 'body', 'footer', 'buttons', 'bilingualOrder'].some((k) => input[k] !== undefined);
}

// The part of a variant that Meta approves and a reviewer reads.
function contentKey(v, language) {
  return JSON.stringify({
    h: v.header || '',
    b: v.body || '',
    f: v.footer || '',
    k: (v.buttons || []).map((b) => [b.role, b.text || '', b.url || '']),
    o: language === 'bilingual' ? (v.bilingualOrder || 'ar_first') : '',
  });
}

// field -> value map from the request; null-prototype so a field named like an
// Object.prototype member ("constructor") can never resolve to an inherited value.
function normalizeFieldValues(raw) {
  const out = Object.create(null);
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('fieldValues must be an object');
  const keys = Object.keys(raw);
  if (keys.length > CAPS.VALUES) throw invalid(`fieldValues may contain at most ${CAPS.VALUES} fields`);
  for (const key of keys) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) throw invalid('fieldValues keys must be merge-field names');
    const value = raw[key];
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) throw invalid(`fieldValues.${key} must be a string or a number`);
    const text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim(); // WhatsApp refuses newlines, tabs and long space runs in a parameter
    if (codePoints(text) > CAPS.VALUE) throw invalid(`fieldValues.${key} is too long (max ${CAPS.VALUE} characters)`);
    out[key] = text;
  }
  return out;
}

// The footer a variant really goes out with: its own, or — when it carries an
// opt-out button and left the footer empty — the catalogue default in its first
// language, so the typed opt-out keyword is always advertised. The preview and
// the submission use the same rule, so what is previewed is what is sent.
function effectiveFooter(variant) {
  if (variant.footer && String(variant.footer).trim()) return variant.footer;
  if (!(variant.buttons || []).some((b) => b && b.role === 'opt_out')) return '';
  const key = 'templates.defaultMarketingFooter';
  return catalog.has(key) ? catalog.t(meta.firstLanguageOf(variant), key) : '';
}

function withEffectiveFooter(variant) {
  return { ...variant, footer: effectiveFooter(variant) };
}

// ── validation and views ──────────────────────────────────────────────────
function flowButtonIndexes(buttons) {
  return (buttons || []).map((b, i) => (b && b.role === 'flow_button' ? i : -1)).filter((i) => i >= 0);
}

// On a template linked to a flow message the English variant mirrors the flow's
// buttons, and a button's payload is positional (msgnode_<nodeId>_<position>) —
// so other variants must keep the same flow buttons in the same slots.
function linkedLayoutIssues(doc, variant) {
  if (!doc.linkedMessageNodeId || variant.language === 'en') return [];
  const reference = (doc.variants || []).find((v) => v && v.language === 'en');
  if (!reference) return [];
  const want = flowButtonIndexes(reference.buttons);
  const have = flowButtonIndexes(variant.buttons);
  if (want.length === have.length && want.every((n, i) => n === have[i])) return [];
  return [{ code: 'flow_button_mismatch', field: 'buttons', detail: { expected: want.length, found: have.length } }];
}

// -> VariantValidation { ok, errors, warnings, positionalText, params }
function validateInContext(doc, variant) {
  const res = validateVariant(variant, {
    category: categoryOf(doc),
    linkedMessageNodeId: doc.linkedMessageNodeId,
    linkedPromotionId: doc.linkedPromotionId,
  });
  const errors = res.errors.concat(linkedLayoutIssues(doc, variant));
  return { ok: errors.length === 0, errors, warnings: res.warnings, positionalText: res.positional.text, params: res.positional.params };
}

const asCategory = (value) => (value === 'UTILITY' || value === 'MARKETING' ? value : null);

function toVariantView(doc, v) {
  const validation = validateInContext(doc, v);
  const send = checkSendable(v);
  return {
    language: v.language,
    bilingualOrder: v.language === 'bilingual' ? (v.bilingualOrder || 'ar_first') : null,
    header: v.header || '',
    body: v.body || '',
    footer: v.footer || '',
    buttons: (v.buttons || []).map((b) => ({ role: b.role, text: b.text || '', ...(b.url ? { url: b.url } : {}) })),
    metaTemplateName: v.metaTemplateName || null,
    metaStatus: v.metaStatus || 'NOT_CREATED',
    metaRejectedReason: v.metaRejectedReason || null,
    metaCategory: asCategory(v.metaCategory),
    metaPreviousCategory: asCategory(v.metaPreviousCategory),
    metaFlagged: !!v.metaFlagged,
    metaStatusRaw: v.metaStatusRaw || null,
    metaLastCheckedAt: iso(v.metaLastCheckedAt),
    submittedAt: iso(v.submittedAt),
    submissionCount: v.submissionCount || 0,
    lastError: v.lastError || null,
    reviewStatus: v.reviewStatus === 'reviewed' ? 'reviewed' : 'draft',
    reviewedBy: v.reviewedBy || null,
    reviewedAt: iso(v.reviewedAt),
    source: v.source || 'merchant',
    validation,
    sendable: send.ok,
    notSendableReason: send.ok ? null : send.reason,
    updatedAt: iso(v.updatedAt) || iso(doc.updatedAt),
  };
}

// Plain LocalizedTemplate view (the TS type) — every variant with its computed
// validation and sendable state.
function toTemplateView(rawDoc) {
  const doc = plain(rawDoc) || {};
  const variants = (doc.variants || []).filter(Boolean).slice().sort((a, b) => (LANGUAGE_ORDER[a.language] ?? 9) - (LANGUAGE_ORDER[b.language] ?? 9));
  return {
    id: String(doc._id),
    key: doc.key,
    name: doc.name,
    useCase: doc.useCase || 'custom',
    category: categoryOf(doc),
    archived: !!doc.archived,
    linkedMessageNodeId: doc.linkedMessageNodeId ? String(doc.linkedMessageNodeId) : null,
    linkedPromotionId: doc.linkedPromotionId ? String(doc.linkedPromotionId) : null,
    variants: variants.map((v) => toVariantView(doc, v)),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

// ── persistence (the only code that touches Mongoose) ─────────────────────
// Every filter carries workspaceId (the one deliberate exception, the
// scheduler's findRefreshCandidates, is cross-workspace by design and every
// write it leads to is scoped by the document's own workspaceId).
// Variant updates use the positional operator with an $elemMatch filter:
//   guard = { contentVersion: n, ... } must still match, else nothing is written
//   and the caller re-reads. All of it is plain single-document MongoDB (and
//   Cosmos DB for MongoDB) functionality; no aggregation, no $function.
function createMongoStore(getModel) {
  const positional = (fields) => Object.fromEntries(Object.entries(fields).map(([k, v]) => [`variants.$.${k}`, v]));
  return {
    async create(doc) {
      const created = await getModel().create(doc);
      return created.toObject();
    },
    findOne(workspaceId, id) {
      return getModel().findOne({ _id: id, workspaceId }).lean();
    },
    async list(workspaceId, { useCase, archived } = {}) {
      const filter = { workspaceId };
      if (useCase) filter.useCase = useCase;
      if (archived === 'only') filter.archived = true;
      else if (archived !== 'include') filter.archived = { $ne: true };
      return getModel().find(filter).limit(LIST_CAP).lean();
    },
    async setFields(workspaceId, id, set) {
      const res = await getModel().updateOne({ _id: id, workspaceId }, { $set: set });
      return res.matchedCount > 0;
    },
    // Adds the variant only while that language is absent (two concurrent adds: one wins).
    async insertVariant(workspaceId, id, language, variantDoc) {
      const res = await getModel().updateOne(
        { _id: id, workspaceId, 'variants.language': { $ne: language } },
        { $push: { variants: variantDoc } },
      );
      return res.matchedCount > 0;
    },
    async updateVariant(workspaceId, id, language, { guard = {}, set, unset, inc } = {}) {
      const update = {};
      if (set && Object.keys(set).length) update.$set = positional(set);
      if (unset && unset.length) update.$unset = positional(Object.fromEntries(unset.map((k) => [k, ''])));
      if (inc && Object.keys(inc).length) update.$inc = positional(inc);
      const res = await getModel().updateOne(
        { _id: id, workspaceId, variants: { $elemMatch: { language, ...guard } } },
        update,
      );
      return res.matchedCount > 0;
    },
    // Cross-workspace (delta sweep): templates holding any of these exact Meta names.
    findByMetaNames(names, limit) {
      return getModel().find({ variants: { $elemMatch: { metaTemplateName: { $in: names } } } }).limit(limit).lean();
    },
    // Cross-workspace (scheduler): non-archived templates with a variant to re-check.
    findRefreshCandidates({ statuses, limit }) {
      return getModel().find({
        archived: { $ne: true },
        variants: { $elemMatch: { metaStatus: { $in: statuses }, metaTemplateName: { $exists: true, $ne: null } } },
      }).limit(limit).lean();
    },
  };
}

// In-memory sliding-window limiter (per process; fine for a safety valve).
function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return {
    take(key) {
      const t = now();
      const recent = (hits.get(key) || []).filter((at) => t - at < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000)) };
      }
      recent.push(t);
      hits.set(key, recent);
      return { ok: true };
    },
  };
}

function defaultDeps() {
  let model;
  const getModel = () => { if (!model) model = require('../../models/LocalizedTemplate'); return model; };
  return {
    store: createMongoStore(getModel),
    metaClient: meta.createMetaClient(),
    transport: require('./transport'),
    isArabicEnabled: (workspaceId) => require('./settings').isArabicEnabled(workspaceId),
    getBilingualOrder: async (workspaceId) => {
      try { return (await require('./settings').getSettings(workspaceId)).bilingualOrder || 'ar_first'; } catch (err) { return 'ar_first'; }
    },
    getReviewerName: async (userId) => {
      if (!userId) return null;
      const user = await require('../../models/User').findById(userId).select('name phone').lean();
      return user ? (user.name || user.phone || null) : null;
    },
    getDefaultCountryCode: async (workspaceId) => {
      try {
        const settings = await require('../../models/Settings').findOne({ workspaceId }).select('defaultCountryCode').lean();
        return (settings && settings.defaultCountryCode) || '966';
      } catch (err) { return '966'; }
    },
    getBusinessName: async (workspaceId) => {
      try {
        const settings = await require('../../models/Settings').findOne({ workspaceId }).select('merchantName').lean();
        return (settings && settings.merchantName) || '';
      } catch (err) { return ''; }
    },
    findCustomer: (workspaceId, customerId) => require('../../models/Customer')
      .findOne({ _id: customerId, workspaceId, deletedAt: { $exists: false } }).select('firstname lastname loyaltyPoints').lean(),
    findPromotion: (workspaceId, promotionId) => require('../../models/Promotion').findOne({ _id: promotionId, workspaceId }).select('_id').lean(),
    getLibrary: () => require('./templateLibrary'),
    getCeiling: () => {
      const n = Number.parseInt(process.env.LOCALIZATION_TEMPLATE_CEILING, 10);
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_TEMPLATE_CEILING;
    },
    now: () => new Date(),
    log: (...args) => console.error('[localization]', ...args),
    testSendLimiter: createRateLimiter({ limit: TEST_SEND_LIMIT, windowMs: HOUR }),
    refreshLimiter: createRateLimiter({ limit: 10, windowMs: MINUTE }),
  };
}

// Hash of the text a reviewer/Meta sees: how a rejection is remembered and recognised later.
function contentHash(variant) {
  return sha1(contentKey(variant, variant.language));
}

// The list of rejected-text hashes after Meta rejected the variant's CURRENT text (newest last, capped).
function rememberRejection(variant) {
  const hash = contentHash(variant);
  const known = (variant.rejectedContent || []).filter((h) => h !== hash);
  return known.concat(hash).slice(-MAX_REMEMBERED_REJECTIONS);
}

function isRejectedText(variant) {
  return (variant.rejectedContent || []).includes(contentHash(variant));
}

const upperText = (value) => (typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null);

// Fields of a Graph template row (create response, GET /{id}, list/sweep row) that change what we store.
// Unknown statuses keep their raw text and become the non-sendable ERROR (never a throw).
function applyMetaRow(variant, row) {
  const set = {};
  const unset = [];
  let changed = false;
  if (row.id && String(row.id) !== variant.metaTemplateId) set.metaTemplateId = String(row.id);

  const category = upperText(row.category);
  if (category && category !== variant.metaCategory) { set.metaCategory = category; changed = true; }
  // Meta says what it re-classified FROM; otherwise a category that differs from the one seen before.
  const previous = upperText(row.previous_category) || (category && variant.metaCategory && variant.metaCategory !== category ? variant.metaCategory : null);
  if (previous && previous !== variant.metaPreviousCategory) set.metaPreviousCategory = previous;
  const quality = meta.cleanQualityScore(row.quality_score);
  if (quality && quality !== variant.metaQualityScore) set.metaQualityScore = quality;

  const mapped = meta.mapMetaStatus(row.status);
  if (!mapped) return { set, unset, changed, mapped: null };
  const raw = String(row.status).trim().slice(0, 40);
  if (raw !== variant.metaStatusRaw) set.metaStatusRaw = raw;
  if (mapped !== (variant.metaStatus || 'NOT_CREATED')) { set.metaStatus = mapped; changed = true; }
  const reason = mapped === 'REJECTED' ? meta.cleanRejectedReason(row.rejected_reason) : null;
  if ((reason || null) !== (variant.metaRejectedReason || null)) {
    changed = true;
    if (reason) set.metaRejectedReason = reason; else unset.push('metaRejectedReason');
  }
  if (mapped === 'REJECTED' && !isRejectedText(variant)) set.rejectedContent = rememberRejection(variant);
  return { set, unset, changed, mapped, unknownStatus: meta.isKnownMetaStatus(row.status) ? undefined : raw };
}

// How often the background sweep re-checks a variant: often while it is new
// (reviews usually finish within minutes), rarely once it has been waiting long
// (Graph's template-management calls are rate limited per WABA).
function sweepIntervalMs(variant, nowMs) {
  const waited = variant.submittedAt ? nowMs - new Date(variant.submittedAt).getTime() : Infinity;
  if (waited < HOUR) return 4 * MINUTE;
  return waited < 24 * HOUR ? 15 * MINUTE : HOUR;
}

// The values a guarded update must still find on the variant (null also matches a missing field).
function guardOf(v) {
  return {
    contentVersion: Number.isInteger(v.contentVersion) ? v.contentVersion : null,
    submissionCount: Number.isInteger(v.submissionCount) ? v.submissionCount : null,
  };
}

// The document as it stands after a successful guarded update. Used to answer
// without re-reading: read-after-write is not guaranteed on Cosmos DB for MongoDB,
// and the update itself already told us (matchedCount) that it applied.
function withVariantPatch(doc, language, now, { set = {}, unset = [], inc = {} } = {}) {
  const variants = (doc.variants || []).map((v) => {
    if (!v || v.language !== language) return v;
    const next = { ...v, ...set };
    for (const key of unset) delete next[key];
    for (const [key, by] of Object.entries(inc)) next[key] = (Number(v[key]) || 0) + by;
    return next;
  });
  return { ...doc, variants, updatedAt: now };
}

function lastErrorText(metaError) {
  const message = (metaError && metaError.message) || 'WhatsApp (Meta) request failed';
  return metaError && metaError.code ? `${message} (${metaError.code})` : message;
}

// ── the service ───────────────────────────────────────────────────────────
function createTemplatesService(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const { store } = deps;

  async function requireDoc(workspaceId, id) {
    const doc = await store.findOne(workspaceId, id);
    if (!doc) throw new TemplateError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return doc;
  }

  function requireVariant(doc, language) {
    const variant = (doc.variants || []).find((v) => v && v.language === language);
    if (!variant) throw new TemplateError(404, 'VARIANT_NOT_FOUND', `This template has no ${language} version`);
    return variant;
  }

  async function viewOf(workspaceId, id) {
    return toTemplateView(await requireDoc(workspaceId, id));
  }

  async function getTemplateDoc(workspaceId, id) {
    return requireDoc(assertId(workspaceId, 'workspaceId'), assertId(id));
  }

  function newVariantDoc(language, input, now, order) {
    return {
      language,
      ...(language === 'bilingual' ? { bilingualOrder: input.bilingualOrder || order } : {}),
      header: input.header,
      body: input.body,
      footer: input.footer,
      buttons: input.buttons,
      contentVersion: 1,
      metaStatus: 'NOT_CREATED',
      submissionCount: 0,
      reviewStatus: 'draft',
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
  }

  function parseVariants(variants) {
    if (variants === undefined || variants === null) return [];
    if (!Array.isArray(variants)) throw invalid('variants must be an array');
    if (variants.length > CAPS.VARIANTS) throw invalid(`variants may contain at most ${CAPS.VARIANTS} entries`);
    const seen = new Set();
    return variants.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('each variant must be an object');
      const language = assertLanguage(entry.language);
      if (seen.has(language)) throw invalid(`variants contains ${language} twice`);
      seen.add(language);
      return { language, input: normalizeVariantInput(entry, language) };
    });
  }

  // Inserts with a unique key; a derived key gets _2, _3 ... on a clash, a name
  // (library templates) gets " 2", " 3" ..., an explicit key that clashes is a 409.
  async function insertTemplate(base, { name, explicitKey, suffixName }) {
    const stem = deriveKey(name);
    for (let n = 1; n <= MAX_KEY_TRIES + 1; n += 1) {
      const candidateName = suffixName && n > 1 ? `${name} ${n}` : name;
      let key;
      if (explicitKey) key = explicitKey;
      else if (suffixName) key = deriveKey(candidateName);
      else key = n === 1 ? stem : `${stem}_${n}`;
      if (n === MAX_KEY_TRIES + 1) key = `${stem}_${Date.now().toString(36)}`;
      try {
        return await store.create({ ...base, key, name: candidateName });
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
        if (explicitKey) throw new TemplateError(409, 'TEMPLATE_KEY_TAKEN', 'A template with this key already exists');
      }
    }
    throw new TemplateError(409, 'TEMPLATE_KEY_TAKEN', 'Could not find a free template key');
  }

  async function createTemplate({ workspaceId, userId, name, useCase, category, variants, linkedMessageNodeId, linkedPromotionId, key } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const cleanName = cleanString(name, 'name', CAPS.NAME);
    if (!cleanName) throw invalid('name is required');
    const useCaseValue = useCase === undefined || useCase === null ? 'custom' : assertOneOf(useCase, USE_CASES, 'useCase');
    // The UTILITY floor: a non-transactional use case is stored as MARKETING whatever was asked for (corrected, never rejected).
    const requestedCategory = category === undefined || category === null ? defaultCategoryFor(useCaseValue) : assertOneOf(category, CATEGORIES, 'category');
    const categoryValue = floorCategory(useCaseValue, requestedCategory);
    let explicitKey;
    if (key !== undefined && key !== null) {
      if (typeof key !== 'string' || !/^[a-z0-9_]{1,60}$/.test(key)) throw invalid('key may only contain lowercase letters, numbers and underscores (max 60)');
      explicitKey = key;
    }
    const parsed = parseVariants(variants);
    const now = deps.now();
    const needsOrder = parsed.some((p) => p.language === 'bilingual' && !p.input.bilingualOrder);
    const order = needsOrder ? await deps.getBilingualOrder(ws) : 'ar_first';
    const base = {
      workspaceId: ws,
      useCase: useCaseValue,
      category: categoryValue,
      variants: parsed.map((p) => newVariantDoc(p.language, p.input, now, order)),
      archived: false,
    };
    if (linkedMessageNodeId !== undefined && linkedMessageNodeId !== null) base.linkedMessageNodeId = assertId(linkedMessageNodeId, 'linkedMessageNodeId');
    if (linkedPromotionId !== undefined && linkedPromotionId !== null) {
      // A template is linked to a flow message OR to a promotion, never both; the promotion must be this workspace's.
      if (base.linkedMessageNodeId) throw invalid('linkedPromotionId and linkedMessageNodeId cannot be combined');
      // A promotion message is marketing: a transactional (UTILITY-floor) use case would let it dodge the opt-out button / consent rules (review R2-02).
      if (isTransactionalUseCase(useCaseValue)) {
        throw new TemplateError(400, 'PROMOTION_TEMPLATE_USE_CASE', 'A template linked to a promotion is a marketing message: use the use case "promotion" (or another marketing use case), not a transactional one');
      }
      const promotionId = assertId(linkedPromotionId, 'linkedPromotionId');
      if (!(await deps.findPromotion(ws, promotionId))) throw new TemplateError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
      base.linkedPromotionId = promotionId;
    }
    if (optionalId(userId)) base.createdBy = optionalId(userId);
    return toTemplateView(await insertTemplate(base, { name: cleanName, explicitKey, suffixName: false }));
  }

  async function listLibrary() {
    return deps.getLibrary().listLibrary();
  }

  async function createFromLibrary({ workspaceId, userId, libraryKey, name } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    if (typeof libraryKey !== 'string' || !libraryKey.trim()) throw invalid('libraryKey is required');
    const entry = await deps.getLibrary().getLibraryEntry(libraryKey.trim());
    if (!entry) throw new TemplateError(404, 'NOT_FOUND', 'Library template not found');
    const given = cleanString(name, 'name', CAPS.NAME);
    const baseName = given || cleanString(entry.name && entry.name.en, 'name', CAPS.NAME) || libraryKey;
    const now = deps.now();
    const entryUseCase = assertOneOf(entry.useCase, USE_CASES, 'useCase');
    const base = {
      workspaceId: ws,
      useCase: entryUseCase,
      category: floorCategory(entryUseCase, assertOneOf(entry.category, CATEGORIES, 'category')),
      // Library text is a starting point: always a draft from the library, never pre-reviewed.
      variants: ['en', 'ar']
        .filter((language) => entry.variants && entry.variants[language])
        .map((language) => newVariantDoc(language, normalizeVariantInput({ ...entry.variants[language], source: 'library' }, language), now, 'ar_first')),
      archived: false,
    };
    if (optionalId(userId)) base.createdBy = optionalId(userId);
    return toTemplateView(await insertTemplate(base, { name: baseName, suffixName: !given }));
  }

  async function listTemplates({ workspaceId, search, useCase, archived, page, limit, linkedPromotionId } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    if (search !== undefined && search !== null && typeof search !== 'string') throw invalid('search must be a string');
    const useCaseFilter = useCase === undefined || useCase === null || useCase === '' ? undefined : assertOneOf(useCase, USE_CASES, 'useCase');
    let mode = 'exclude';
    if (archived === true || ['true', '1', 'include', 'all'].includes(archived)) mode = 'include';
    else if (archived === 'only') mode = 'only';
    let docs = await store.list(ws, { useCase: useCaseFilter, archived: mode });
    if (linkedPromotionId !== undefined && linkedPromotionId !== null && linkedPromotionId !== '') {
      const wanted = assertId(linkedPromotionId, 'linkedPromotionId').toLowerCase();
      docs = docs.filter((d) => d.linkedPromotionId && String(d.linkedPromotionId).toLowerCase() === wanted);
    }
    const tokens = normalizeForMatch(search || '').split(' ').filter(Boolean).slice(0, 10);
    if (search && search.trim() && !tokens.length) docs = []; // punctuation only (".*", "%"): nothing to match, and never a pattern
    else if (tokens.length) {
      docs = docs.filter((d) => {
        const hay = normalizeForMatch([d.name, String(d.key || '').replace(/_/g, ' '), ...(d.variants || []).map((v) => `${v.header || ''} ${v.body || ''}`)].join(' '));
        return tokens.every((t) => hay.includes(t));
      });
    }
    docs.sort((a, b) => (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)) || String(a.name).localeCompare(String(b.name)));
    const p = clampInt(page, 1, 1, 100000);
    const l = clampInt(limit, 200, 1, 200);
    return { items: docs.slice((p - 1) * l, p * l).map(toTemplateView), total: docs.length, page: p, limit: l };
  }

  async function getTemplate({ workspaceId, id }) {
    return toTemplateView(await getTemplateDoc(workspaceId, id));
  }

  // Meta approved each submitted variant under the OLD category; drop them back
  // to NOT_CREATED. contentVersion is bumped on EVERY variant (also unsubmitted
  // ones) so an in-flight submission, review or refresh cannot re-attach the old
  // approval. Done BEFORE the category changes, so the window in between is never
  // "approved under the wrong rules". -> the document with the resets applied.
  async function resetVariantsForCategoryChange(ws, id, doc) {
    let current = doc;
    for (const v of doc.variants || []) {
      const patch = {
        set: { metaStatus: 'NOT_CREATED', updatedAt: deps.now() },
        unset: ['metaRejectedReason', 'metaLastCheckedAt', 'lastError', 'submittingAt'],
        inc: { contentVersion: 1 },
      };
      const ok = await store.updateVariant(ws, id, v.language, { guard: { contentVersion: guardOf(v).contentVersion }, ...patch });
      if (ok) current = withVariantPatch(current, v.language, deps.now(), patch);
      else deps.log('category change: a version changed concurrently, run it again to finish', id, v.language);
    }
    return current;
  }

  async function updateTemplate({ workspaceId, id, patch } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('Nothing to update');
    let doc = await requireDoc(ws, tid);
    const set = {};
    if (patch.name !== undefined) {
      const name = cleanString(patch.name, 'name', CAPS.NAME);
      if (!name) throw invalid('name is required');
      set.name = name;
    }
    if (patch.useCase !== undefined) set.useCase = assertOneOf(patch.useCase, USE_CASES, 'useCase');
    // The UTILITY floor: whenever the use case or the category is touched, the category that is stored is the
    // floored one (corrected, never rejected). Changing a transactional use case to a marketing one therefore
    // also moves the stored category to MARKETING (and, below, drops Meta's approval under the old category).
    if (patch.category !== undefined || set.useCase !== undefined) {
      const requested = patch.category !== undefined ? assertOneOf(patch.category, CATEGORIES, 'category') : (doc.category === 'UTILITY' ? 'UTILITY' : 'MARKETING');
      set.category = floorCategory(set.useCase !== undefined ? set.useCase : (doc.useCase || 'custom'), requested);
    }
    if (!Object.keys(set).length) return toTemplateView(doc);
    if (set.category && set.category !== (doc.category || 'MARKETING')) doc = await resetVariantsForCategoryChange(ws, tid, doc);
    if (!(await store.setFields(ws, tid, set))) throw new TemplateError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return toTemplateView({ ...doc, ...set, updatedAt: deps.now() });
  }

  async function setArchived({ workspaceId, id, archived }) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    const doc = await requireDoc(ws, tid);
    if (!(await store.setFields(ws, tid, { archived: !!archived }))) throw new TemplateError(404, 'TEMPLATE_NOT_FOUND', 'Template not found');
    return toTemplateView({ ...doc, archived: !!archived, updatedAt: deps.now() });
  }

  // Create-or-replace one language's variant. Content changes reset the Meta
  // status and the review (see the header); an unchanged save is a no-op.
  async function upsertVariant({ workspaceId, id, language, input } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    assertLanguage(language);
    const next = normalizeVariantInput(input, language);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = deps.now();
      const doc = await requireDoc(ws, tid);
      const existing = (doc.variants || []).find((v) => v && v.language === language);
      if (!existing) {
        const order = language === 'bilingual' && !next.bilingualOrder ? await deps.getBilingualOrder(ws) : 'ar_first';
        const variantDoc = newVariantDoc(language, next, now, order);
        if (await store.insertVariant(ws, tid, language, variantDoc)) return toTemplateView({ ...doc, variants: [...(doc.variants || []), variantDoc], updatedAt: now });
        continue; // somebody added it first: take the update path
      }
      if (language === 'bilingual' && !next.bilingualOrder) next.bilingualOrder = existing.bilingualOrder || 'ar_first';
      const changed = contentKey(existing, language) !== contentKey(next, language);
      const aiText = next.source === 'ai'; // machine text never stays "reviewed"
      if (!changed && !aiText) return toTemplateView(doc);
      const patch = { set: { updatedAt: now, reviewStatus: 'draft', source: next.source }, unset: ['reviewedBy', 'reviewedById', 'reviewedAt'] };
      if (changed) {
        Object.assign(patch.set, { header: next.header, body: next.body, footer: next.footer, buttons: next.buttons, metaStatus: 'NOT_CREATED' });
        if (language === 'bilingual') patch.set.bilingualOrder = next.bilingualOrder;
        patch.unset.push('metaRejectedReason', 'metaLastCheckedAt', 'lastError', 'submittingAt');
        patch.inc = { contentVersion: 1 };
      }
      if (await store.updateVariant(ws, tid, language, { guard: { contentVersion: guardOf(existing).contentVersion }, ...patch })) {
        return toTemplateView(withVariantPatch(doc, language, now, patch));
      }
    }
    throw new TemplateError(409, 'INTERNAL', 'This template was changed by someone else — reload it and try again');
  }

  // Validation of a stored variant, or of a draft the editor has not saved yet
  // (any of header/body/footer/buttons/bilingualOrder present in the body).
  async function validateVariantFor({ workspaceId, id, language, input } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    assertLanguage(language);
    const doc = await requireDoc(ws, tid);
    let variant;
    if (isDraftInput(input)) {
      const draft = normalizeVariantInput(input, language, { strictRoles: false });
      const stored = (doc.variants || []).find((v) => v && v.language === language);
      variant = { language, ...draft, bilingualOrder: draft.bilingualOrder || (stored && stored.bilingualOrder) };
    } else {
      variant = requireVariant(doc, language);
    }
    return validateInContext(doc, variant);
  }

  async function reviewerName(userId) {
    try {
      return (await deps.getReviewerName(userId)) || 'Reviewer';
    } catch (err) {
      deps.log('reviewer lookup failed:', err && err.message);
      return 'Reviewer';
    }
  }

  async function reviewVariant({ workspaceId, id, language, status, userId } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    assertLanguage(language);
    assertOneOf(status, REVIEW_STATUSES, 'status');
    const by = status === 'reviewed' ? await reviewerName(userId) : null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const now = deps.now();
      const doc = await requireDoc(ws, tid);
      const existing = requireVariant(doc, language);
      if (status === 'reviewed' && !String(existing.body || '').trim()) {
        throw new TemplateError(400, 'VARIANT_INVALID', 'An empty version cannot be marked as reviewed', { issues: [{ code: 'body_required', field: 'body' }] });
      }
      const patch = { set: { reviewStatus: status, updatedAt: now }, unset: [] };
      if (status === 'reviewed') {
        Object.assign(patch.set, { reviewedBy: by, reviewedAt: now });
        if (optionalId(userId)) patch.set.reviewedById = optionalId(userId); else patch.unset.push('reviewedById');
      } else {
        patch.unset.push('reviewedBy', 'reviewedById', 'reviewedAt');
      }
      // The guard ties the review to the exact text that was read: if it changed meanwhile, loop and review that.
      if (await store.updateVariant(ws, tid, language, { guard: { contentVersion: guardOf(existing).contentVersion }, ...patch })) {
        return toTemplateView(withVariantPatch(doc, language, now, patch));
      }
    }
    throw new TemplateError(409, 'INTERNAL', 'This template was changed by someone else — reload it and try again');
  }

  // Category Meta reports can only tighten ours (UTILITY -> MARKETING).
  async function escalateCategory(ws, doc, metaCategory) {
    if (metaCategory !== 'MARKETING' || doc.category === 'MARKETING') return;
    await store.setFields(ws, String(doc._id), { category: 'MARKETING' });
    doc.category = 'MARKETING';
    deps.log('template category escalated to MARKETING (reported by Meta):', String(doc._id));
  }

  // { used, limit } from Meta, or null when it cannot be read (best effort).
  async function readUsage() {
    try {
      const usage = await deps.metaClient.getUsage();
      return usage && Number.isFinite(usage.used) ? usage : null;
    } catch (err) {
      deps.log('template usage unavailable:', err && err.message);
      return null;
    }
  }

  // Every (workspace x use case x language x revision) takes one of the WABA's 250 slots for good:
  // refuse new submissions at the ceiling. An unreadable count does not block (Meta enforces its own limit).
  async function assertBelowCeiling() {
    const ceiling = deps.getCeiling();
    const usage = await readUsage();
    if (usage && usage.used >= ceiling) {
      throw new TemplateError(409, 'META_TEMPLATE_LIMIT', `WhatsApp template capacity reached (${usage.used} of ${usage.limit || 250} used, submissions stop at ${ceiling}). Contact support before submitting more`);
    }
  }

  // GET /templates/meta-usage -> { used, limit, ceiling, atCeiling }; nulls when Meta cannot be reached.
  async function getMetaUsage() {
    const ceiling = deps.getCeiling();
    const usage = deps.transport.isDryRun() ? null : await readUsage();
    const used = usage ? usage.used : null;
    return { used, limit: usage && Number.isFinite(usage.limit) ? usage.limit : null, ceiling, atCeiling: used !== null && used >= ceiling };
  }

  // Submit one variant to Meta for approval.
  async function submitVariant({ workspaceId, id, language } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    assertLanguage(language);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const doc = await requireDoc(ws, tid);
      const existing = requireVariant(doc, language);
      const status = existing.metaStatus || 'NOT_CREATED';
      if (BLOCKING_STATUSES.includes(status)) {
        throw new TemplateError(409, 'ALREADY_SUBMITTED', 'This version was already submitted to WhatsApp and has not changed');
      }
      // Meta can reject identical content again (and a rejection costs a slot): the same text never goes back.
      if (isRejectedText(existing)) {
        throw new TemplateError(409, 'REJECTED_UNCHANGED', 'WhatsApp already rejected this text. Change the wording (see the rejection reason) before submitting again');
      }
      if (existing.submittingAt && deps.now().getTime() - new Date(existing.submittingAt).getTime() < SUBMIT_LOCK_MS) {
        throw new TemplateError(409, 'ALREADY_SUBMITTED', 'This version is being submitted right now');
      }
      const effective = withEffectiveFooter(existing);
      const validation = validateInContext(doc, effective);
      if (!validation.ok) throw new TemplateError(400, 'VARIANT_INVALID', 'This version cannot be submitted until its errors are fixed', { issues: validation.errors });
      const guard = guardOf(existing);
      const claimedCount = (guard.submissionCount || 0) + 1;
      const name = meta.buildTemplateName({ workspaceId: ws, key: doc.key, language, revision: claimedCount, fallbackId: doc._id });
      const payload = meta.buildSubmissionPayload({ name, variant: effective, category: categoryOf(doc) });

      if (deps.transport.isDryRun()) {
        return { template: toTemplateView(doc), submission: { metaTemplateName: name, metaStatus: status, dryRun: true } };
      }
      try {
        await deps.metaClient.assertConfigured();
      } catch (err) {
        throw mapMetaFailure(err);
      }
      await assertBelowCeiling();

      // Claim the revision atomically BEFORE calling Meta: the in-flight marker
      // and the count bump land in one update, so a concurrent submit sees either
      // the old state (its own claim then fails) or the marker (409).
      const claim = { set: { submittingAt: deps.now() }, inc: { submissionCount: 1 } };
      if (!(await store.updateVariant(ws, tid, language, { guard, ...claim }))) continue; // changed or claimed by someone else: re-read and decide again
      const after = { contentVersion: guard.contentVersion, submissionCount: claimedCount };

      let result;
      try {
        result = await deps.metaClient.submitTemplate(payload);
      } catch (err) {
        const failure = mapMetaFailure(err);
        const text = failure.body.metaError ? lastErrorText(failure.body.metaError) : failure.message;
        await store.updateVariant(ws, tid, language, { guard: after, set: { lastError: text, updatedAt: deps.now() }, unset: ['submittingAt'] })
          .catch((e) => deps.log('could not record the submission error:', e && e.message));
        throw failure;
      }

      const now = deps.now();
      // What Meta answered is stored as it is (status, id, category); only a missing status counts as PENDING.
      const resultStatus = meta.mapMetaStatus(result.status) || 'PENDING';
      const done = {
        set: { metaStatus: resultStatus, metaStatusRaw: result.status || 'PENDING', metaFlagged: false, metaTemplateName: name, metaLanguage: payload.language, submittedAt: now, metaLastCheckedAt: now, updatedAt: now },
        unset: ['lastError', 'metaRejectedReason', 'submittingAt', 'metaQualityScore'],
      };
      if (result.id) done.set.metaTemplateId = result.id;
      if (result.category) {
        done.set.metaCategory = result.category;
        // Meta re-classifies at creation too (e.g. the consent request UTILITY -> MARKETING): remember what we asked for.
        if (result.category !== payload.category) done.set.metaPreviousCategory = payload.category; else done.unset.push('metaPreviousCategory');
      } else {
        done.unset.push('metaCategory', 'metaPreviousCategory');
      }
      const submission = { metaTemplateName: name, metaStatus: resultStatus, dryRun: false };
      if (await store.updateVariant(ws, tid, language, { guard: after, ...done })) {
        await escalateCategory(ws, doc, result.category);
        return { template: toTemplateView(withVariantPatch(withVariantPatch(doc, language, now, claim), language, now, done)), submission };
      }
      // The text changed while Meta was being called: the stored variant is already back to NOT_CREATED
      // for the NEW text, so nothing is attached to it; the submitted revision is simply never used.
      deps.log('template submitted to Meta but the variant changed meanwhile; unused name:', name);
      return { template: await viewOf(ws, tid), submission };
    }
    throw new TemplateError(409, 'ALREADY_SUBMITTED', 'This version is being submitted already');
  }

  // Phone typed by a person: Arabic-Indic digits, spaces, dashes, a leading + or 00 are fine.
  async function parseTestPhone(workspaceId, raw) {
    const bad = () => new TemplateError(400, 'INVALID_PHONE', 'Enter a valid phone number with its country code');
    if (typeof raw !== 'string' && typeof raw !== 'number') throw bad();
    const cleaned = stripInvisibles(toWesternDigits(String(raw))).trim();
    if (!cleaned || cleaned.length > 40 || !/^[+\d\s().-]+$/.test(cleaned)) throw bad();
    const rawDigits = cleaned.replace(/\D/g, '');
    if (rawDigits.length < 8 || rawDigits.length > 15) throw bad();
    const normalized = normalizePhoneForDedup(cleaned, await deps.getDefaultCountryCode(workspaceId));
    if (!normalized || !/^\d{8,15}$/.test(normalized)) throw bad();
    return normalized;
  }

  // Payloads that are real buttons on the test phone but inert in the webhook
  // (they match no customer/message): the tester can tap them safely. The opt-out button
  // must NOT start with `optout_`: both the existing handler (server.js, resolved by the
  // tapper's phone) and the Arabic hook (inboundHook.js tapKind) treat any `optout_...`
  // payload as a REAL opt-out of whoever taps it, so a tester tapping "Stop" on a test
  // message would silently opt their own customer record out. `l10ntest_optout` matches
  // no prefix either of them (nor any other branch) dispatches on.
  function testButtonPayloads(doc, variant) {
    const nodeId = doc.linkedMessageNodeId ? String(doc.linkedMessageNodeId) : ZERO_ID;
    return (variant.buttons || []).map((b, i) => {
      if (b.role === 'opt_out') return TEST_OPT_OUT_PAYLOAD;
      if (b.role === 'opt_in') return `consent_yes_${ZERO_ID}`;
      if (b.role === 'decline') return `consent_no_${ZERO_ID}`;
      if (b.role === 'flow_button') return `msgnode_${nodeId}_${i}`;
      if (b.role === 'shop_now') return `promo_${doc.linkedPromotionId ? String(doc.linkedPromotionId) : ZERO_ID}`;
      return undefined;
    });
  }

  // Send an APPROVED variant (even a still-draft one, so a reviewer can see it on
  // a real phone) to a typed number with sample values.
  async function testSendVariant({ workspaceId, id, language, phone } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const tid = assertId(id);
    assertLanguage(language);
    const to = await parseTestPhone(ws, phone);
    const doc = await requireDoc(ws, tid);
    const variant = requireVariant(doc, language);
    if ((variant.metaStatus || 'NOT_CREATED') !== 'APPROVED' || !variant.metaTemplateName) {
      throw new TemplateError(409, 'NOT_APPROVED', 'Only a version approved by WhatsApp can be test-sent');
    }
    const languageCode = variant.metaLanguage || meta.metaLanguageFor(variant);
    const fields = extractFields(`${variant.header || ''} ${variant.body || ''}`);
    const values = Object.create(null);
    for (const field of fields) values[field] = sampleValue(field, languageCode);
    const components = meta.buildSendComponents({ variant, values, buttonPayloads: testButtonPayloads(doc, variant) });
    const taken = deps.testSendLimiter.take(ws);
    if (!taken.ok) throw new TemplateError(429, 'RATE_LIMITED', `Test messages are limited to ${TEST_SEND_LIMIT} per hour`, { retryAfterSeconds: taken.retryAfterSeconds });
    try {
      await deps.transport.sendTemplate(to, { name: variant.metaTemplateName, languageCode, components });
    } catch (err) {
      throw mapMetaFailure(err instanceof meta.MetaApiError ? err : new meta.MetaApiError(meta.sanitizeMetaError(err)));
    }
    return { sent: true, dryRun: !!deps.transport.isDryRun() };
  }

  async function customerFieldValues(ws, customerId) {
    const customer = await deps.findCustomer(ws, customerId);
    if (!customer) throw new TemplateError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found');
    const values = Object.create(null);
    if (customer.firstname) values.name = String(customer.firstname);
    const full = `${customer.firstname || ''} ${customer.lastname || ''}`.trim();
    if (full) values.full_name = full;
    values.points = String(customer.loyaltyPoints || 0);
    const business = await deps.getBusinessName(ws);
    if (business) values.business = business;
    return values;
  }

  // What would be sent, rendered on the server: merge fields filled (given values >
  // the customer's > samples), Latin/number values protected inside Arabic, a
  // bilingual body per paragraph. Fields nobody can fill stay as {field} and are
  // listed in missingFields.
  async function renderPreview({ workspaceId, variant, fieldValues, customerId } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) throw invalid('variant is required');
    const language = assertLanguage(variant.language);
    const input = normalizeVariantInput(variant, language, { strictRoles: false });
    const given = normalizeFieldValues(fieldValues);
    const fromCustomer = customerId === undefined || customerId === null || customerId === ''
      ? Object.create(null)
      : await customerFieldValues(ws, assertId(customerId, 'customerId'));
    const effective = withEffectiveFooter({ language, ...input });
    const sampleLanguage = meta.firstLanguageOf(effective);
    const values = Object.create(null);
    for (const field of extractFields(`${effective.header}\n${effective.body}\n${effective.footer}`)) {
      if (given[field] !== undefined) values[field] = given[field];
      else if (fromCustomer[field] !== undefined) values[field] = fromCustomer[field];
      else if (Object.prototype.hasOwnProperty.call(KNOWN_FIELDS, field)) values[field] = sampleValue(field, sampleLanguage);
    }
    const render = (text, languages) => meta.renderWithLanguages(text, values, languages);
    const header = render(effective.header, meta.occurrenceLanguages(effective.header, sampleLanguage));
    const body = render(effective.body, meta.occurrenceLanguages(effective.body, language, effective.bilingualOrder));
    const footer = render(effective.footer, meta.occurrenceLanguages(effective.footer, sampleLanguage));
    const missing = [];
    for (const m of header.missing.concat(body.missing, footer.missing)) if (!missing.includes(m)) missing.push(m);
    return {
      language,
      header: header.text,
      body: body.text,
      footer: footer.text,
      buttons: effective.buttons.map((b) => ({ role: b.role, text: b.text, ...(b.url ? { url: b.url } : {}) })),
      usedValues: { ...values },
      missingFields: missing,
    };
  }

  // ── status refresh ──────────────────────────────────────────────────────
  function shouldRefresh(variant, mode, nowMs) {
    if (!variant || !variant.metaTemplateName) return false;
    const status = variant.metaStatus || 'NOT_CREATED';
    if (status === 'NOT_CREATED') return false; // never (re)submitted at this content
    if (mode === 'manual') return true;
    if (!SWEEP_STATUSES.includes(status)) return false;
    const last = variant.metaLastCheckedAt ? new Date(variant.metaLastCheckedAt).getTime() : 0;
    return nowMs - last >= sweepIntervalMs(variant, nowMs);
  }

  const rowMatches = (variant, row) => !!row && (
    (variant.metaTemplateId && String(row.id) === String(variant.metaTemplateId))
    || (row.name === variant.metaTemplateName && row.language === (variant.metaLanguage || meta.metaLanguageFor(variant)))
  );

  // The Graph row of one submitted variant: GET /{id} when the id is known (exact, cheap), else
  // (or when Graph does not know the id) the by-name list — whose `name` filter is a SUBSTRING
  // match, so rows are compared on exact name AND language (or id). null when nothing matches.
  async function lookupRow(variant) {
    if (variant.metaTemplateId && typeof deps.metaClient.getTemplateById === 'function') {
      try {
        const row = await deps.metaClient.getTemplateById(variant.metaTemplateId);
        if (row) return row;
      } catch (err) {
        const code = err && err.metaError && err.metaError.code;
        if (err instanceof meta.MetaNotConfiguredError || code !== 100) throw err;
      }
    }
    const rows = await deps.metaClient.listTemplatesByName(variant.metaTemplateName);
    return (Array.isArray(rows) ? rows : []).find((r) => rowMatches(variant, r)) || null;
  }

  // Stores one Graph row on its variant (guarded by content version and name). -> the patch it applied
  async function applyRow(doc, variant, row, result) {
    const ws = String(doc.workspaceId);
    const now = deps.now();
    const patch = row ? applyMetaRow(variant, row) : { set: {}, unset: [], changed: false };
    if (!row) result.notFound += 1;
    if (patch.unknownStatus) result.unknown += 1;
    if (patch.changed) { patch.set.updatedAt = now; result.changed += 1; }
    patch.set.metaLastCheckedAt = now;
    const guard = { contentVersion: guardOf(variant).contentVersion, metaTemplateName: variant.metaTemplateName };
    await store.updateVariant(ws, String(doc._id), variant.language, { guard, set: patch.set, unset: patch.unset });
    if (row && row.category) await escalateCategory(ws, doc, String(row.category).toUpperCase());
    return patch;
  }

  // Looks each submitted variant up at Meta (see lookupRow).
  async function refreshVariants(docs, { mode, failFast, limit }) {
    const nowMs = deps.now().getTime();
    const work = [];
    for (const doc of docs) for (const variant of doc.variants || []) if (shouldRefresh(variant, mode, nowMs)) work.push({ doc, variant });
    work.sort((a, b) => (new Date(a.variant.metaLastCheckedAt || 0)) - (new Date(b.variant.metaLastCheckedAt || 0)));
    const result = { checked: 0, changed: 0, notFound: 0, unknown: 0, errors: 0 };
    for (const { doc, variant } of work.slice(0, limit)) {
      const ws = String(doc.workspaceId);
      let row;
      try {
        row = await lookupRow(variant);
      } catch (err) {
        if (failFast) throw mapMetaFailure(err);
        result.errors += 1;
        deps.log('template status check failed:', err && err.message);
        if (err instanceof meta.MetaNotConfiguredError || result.errors >= MAX_SWEEP_ERRORS) break;
        continue;
      }
      result.checked += 1;
      await applyRow(doc, variant, row, result);
    }
    return result;
  }

  // Delta sweep (the scheduler's daily full pass and a safety net for the per-variant polls):
  // every Graph row changed since `since`, matched to OUR variants by id or exact name + language
  // across all flag-enabled workspaces. A variant that was edited after its submission
  // (NOT_CREATED) is never touched: the old Meta template is no longer its text.
  async function sweepSince({ since } = {}) {
    const result = { rows: 0, matched: 0, checked: 0, changed: 0, notFound: 0, unknown: 0, errors: 0 };
    if (deps.transport.isDryRun()) return { ...result, dryRun: true };
    let rows;
    try {
      rows = await deps.metaClient.listTemplatesSince({ since });
    } catch (err) {
      deps.log('template sweep failed:', err && err.message);
      return { ...result, errors: 1 };
    }
    // Newest first: the first row of a (name, language) wins.
    rows = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.name === 'string' && r.name.startsWith('wf_'));
    result.rows = rows.length;
    const names = Array.from(new Set(rows.map((r) => r.name)));
    const enabled = new Map();
    for (let i = 0; i < names.length; i += SWEEP_NAME_BATCH) {
      const docs = await store.findByMetaNames(names.slice(i, i + SWEEP_NAME_BATCH), CANDIDATE_CAP);
      for (const doc of docs) {
        const ws = String(doc.workspaceId);
        if (!enabled.has(ws)) {
          let on = false;
          try { on = !!(await deps.isArabicEnabled(ws)); } catch (err) { deps.log('flag check failed:', err && err.message); }
          enabled.set(ws, on);
        }
        if (!enabled.get(ws)) continue;
        for (const variant of doc.variants || []) {
          if (!variant || !variant.metaTemplateName || (variant.metaStatus || 'NOT_CREATED') === 'NOT_CREATED') continue;
          const row = rows.find((r) => rowMatches(variant, r));
          if (!row) continue;
          result.matched += 1;
          await applyRow(doc, variant, row, result);
        }
      }
    }
    return result;
  }

  async function refreshTemplate({ workspaceId, templateId } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const doc = await requireDoc(ws, assertId(templateId, 'templateId'));
    if (deps.transport.isDryRun()) return { checked: 0, changed: 0, notFound: 0, unknown: 0, errors: 0, dryRun: true };
    return refreshVariants([doc], { mode: 'manual', failFast: true, limit: MANUAL_REFRESH_LIMIT });
  }

  // POST /templates/refresh-status: one template, or every live one of the workspace.
  async function refreshStatuses({ workspaceId, templateId } = {}) {
    const ws = assertId(workspaceId, 'workspaceId');
    const taken = deps.refreshLimiter.take(ws);
    if (!taken.ok) throw new TemplateError(429, 'RATE_LIMITED', 'Status checks are limited — try again in a moment', { retryAfterSeconds: taken.retryAfterSeconds });
    let result;
    if (templateId !== undefined && templateId !== null && templateId !== '') {
      result = await refreshTemplate({ workspaceId: ws, templateId });
    } else if (deps.transport.isDryRun()) {
      result = { checked: 0, changed: 0 };
    } else {
      result = await refreshVariants(await store.list(ws, { archived: 'exclude' }), { mode: 'manual', failFast: true, limit: MANUAL_REFRESH_LIMIT });
    }
    return { checked: result.checked, changed: result.changed };
  }

  // The scheduler's entry point: every flag-enabled workspace, only what is
  // waiting (PENDING / IN_APPEAL, and PAUSED to notice recovery), at most `limit`
  // Graph calls, never throws on a Meta failure.
  async function refreshPending({ limit = 50 } = {}) {
    if (deps.transport.isDryRun()) return { checked: 0, changed: 0, notFound: 0, unknown: 0, errors: 0, dryRun: true };
    const candidates = await store.findRefreshCandidates({ statuses: SWEEP_STATUSES, limit: CANDIDATE_CAP });
    const enabled = new Map();
    const docs = [];
    for (const doc of candidates) {
      const ws = String(doc.workspaceId);
      if (!enabled.has(ws)) {
        let on = false;
        try { on = !!(await deps.isArabicEnabled(ws)); } catch (err) { deps.log('flag check failed:', err && err.message); }
        enabled.set(ws, on);
      }
      if (enabled.get(ws)) docs.push(doc);
    }
    return refreshVariants(docs, { mode: 'sweep', failFast: false, limit: clampInt(limit, 50, 1, 500) });
  }

  return {
    toTemplateView, createTemplate, getTemplateDoc, getTemplate, listTemplates, updateTemplate, setArchived,
    upsertVariant, validateVariantFor, reviewVariant, submitVariant, testSendVariant, renderPreview,
    listLibrary, createFromLibrary, refreshTemplate, refreshStatuses, refreshPending, sweepSince, getMetaUsage,
    buildSendComponents: meta.buildSendComponents,
  };
}

const service = createTemplatesService();

module.exports = {
  ...service,
  createTemplatesService,
  createMongoStore,
  createRateLimiter,
  TemplateError,
  internals: {
    LANGUAGES, SOURCES, ORDERS, CATEGORIES, USE_CASES, CAPS, ZERO_ID, TEST_OPT_OUT_PAYLOAD, BLOCKING_STATUSES, SWEEP_STATUSES,
    deriveKey, normalizeVariantInput, normalizeFieldValues, contentKey, contentHash, effectiveFooter, applyMetaRow, sweepIntervalMs, validateInContext,
  },
};
