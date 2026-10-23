'use strict';
// "Send me a test message" (DB design 6.8, spec step 5): one approved UTILITY template of the merchant's
// OWN WhatsApp Business account, sent from the merchant's number to the REQUESTING USER'S OWN phone.
//
// Safety rules (all enforced here, counted in the DB so a restart or a second instance cannot
// reset them):
//   - connected, valid token, not needsReconnect, and never the platform's own account;
//   - the recipient is the requesting user's own verified LOGIN phone (User.phone) and nothing else (review R2-03). A user who logs in
//     with an e-mail address (no phone) can only be served if they are the OWNER (live Membership read): they type ONE number, which
//     becomes the workspace's test number (stored masked + a keyed hash, never the digits); every later request must be the same number.
//     A member can never type a number, and nobody can message a stranger;
//   - ONLY a UTILITY template is ever sent: the setup test template first, then any other APPROVED UTILITY template. A MARKETING
//     template is never used (no new way to message a non-consented person), so a workspace whose UTILITY templates are not approved
//     yet gets 409 TEST_NO_APPROVED_TEMPLATE;
//   - 5 sends per hour per workspace (TEST_RATE_LIMITED) and 2 DISTINCT numbers per workspace
//     lifetime (TEST_NUMBER_LIMIT; firstPromotion.testMessageCount + OnboardingEvent rows);
//   - a number that belongs to a Customer of this workspace with optedOut:true is refused in ANY stored format
//     (TEST_RECIPIENT_OPTED_OUT): an opted-out contact is never messaged, not even as a test;
//   - template buttons carry inert payloads (onbtest_<role>) that no webhook branch handles;
//   - the MERCHANT token and phone number id are used, never the platform credentials;
//   - nothing returned, stored or logged contains the token or the full number: the result keeps only the masked number + a timestamp;
//     the distinct-number counter and the workspace test number store an HMAC keyed with a SERVER secret (AUTH_JWT_SECRET), never a
//     hash anyone could brute-force from the database; without that secret only the last 4 digits are kept (review R2-08).
//
// Injectable deps: models (model=OnboardingTemplate, stateModel, connModel, eventModel,
// customerModel, userModel, settingsModel, membershipModel), metaClient / http, vault, now, track, connect, metaErrors, library,
// normalizePhone, hmacSecret. Nothing is executed at require time.
const crypto = require('crypto');
const config = require('./config');
const { OnbError } = require('./errors');
const starter = require('./starterTemplates');
const { TEST_TEMPLATE_KEY } = require('./testTemplate');

const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_DISTINCT_NUMBERS = 2;
const EVENT_CODE = 'TEST_MESSAGE_SENT'; // OnboardingEvent{type:'notification'}; VOID/FAILED when the send did not happen
const MAX_RAW_PHONE = 40;
const OPTED_OUT_SCAN_LIMIT = 20000;

const models = {
  template: (deps) => (deps && deps.model) || require('../../models/OnboardingTemplate'),
  state: (deps) => (deps && deps.stateModel) || require('../../models/OnboardingState'),
  event: (deps) => (deps && deps.eventModel) || require('../../models/OnboardingEvent'),
  customer: (deps) => (deps && deps.customerModel) || require('../../models/Customer'),
  user: (deps) => (deps && deps.userModel) || require('../../models/User'),
  settings: (deps) => (deps && deps.settingsModel) || require('../../models/Settings'),
  membership: (deps) => (deps && deps.membershipModel) || require('../../models/Membership'),
};
const toDate = (v) => (v instanceof Date ? v : new Date(v));
function nowOf(deps) { return deps && typeof deps.now === 'function' ? toDate(deps.now()) : new Date(); }
function normalizePhone(deps) { return (deps && deps.normalizePhone) || require('../../utils/phoneNormalize').normalizePhoneForDedup; }
const bad = (code, details) => new OnbError(code, details ? { details } : {});
/** The server secret that keys the number hash (AUTH_JWT_SECRET); null = none, and then no hash is ever stored. */
function secretOf(deps) { return (deps && deps.hmacSecret !== undefined ? deps.hmacSecret : process.env.AUTH_JWT_SECRET) || null; }

/**
 * Keyed hash of a number (workspace-scoped): lets us count DISTINCT numbers and recognise the workspace test number without storing the
 * number. HMAC-SHA256 under a SERVER secret, so it cannot be brute-forced from a copy of the database. null without a secret.
 * @returns {string|null}
 */
function numberHash(workspaceId, digits, secret) {
  if (!secret) return null;
  return crypto.createHmac('sha256', String(secret)).update(`onb-test:${String(workspaceId)}:${String(digits)}`).digest('hex').slice(0, 24);
}

async function defaultCountryCode(workspaceId, deps) {
  try {
    const s = await models.settings(deps).findOne({ workspaceId }).select('defaultCountryCode').lean();
    return (s && s.defaultCountryCode) || '966';
  } catch (_) { return '966'; }
}

async function loginPhoneOf(userId, deps) {
  if (!userId) return '';
  try {
    const u = await models.user(deps).findById(userId).select('phone').lean();
    return (u && u.phone) || '';
  } catch (_) { return ''; }
}

/** Live Membership read (the JWT role can be 30 days stale): is this user an owner of this workspace right now? */
async function isOwnerNow(workspaceId, userId, deps) {
  if (!userId) return false;
  try {
    const m = await models.membership(deps).findOne({ userId, workspaceId }).select('role').lean();
    return !!m && m.role === 'owner';
  } catch (_) { return false; }
}

const digitsOk = (d) => !!d && /^\d{8,15}$/.test(d);

/**
 * Who may be messaged: the requesting user's own login phone; an owner without a login phone may use ONE typed number per workspace.
 * Returns { digits, cc, source:'login'|'workspace', store:boolean } (store = this number has to become the workspace test number).
 * @throws {OnbError} TEST_PHONE_INVALID (PHONE_INVALID, PHONE_REQUIRED, NOT_YOUR_NUMBER, TEST_NUMBER_FIXED), OWNER_ONLY
 */
async function resolveRecipient({ workspaceId, userId, to, stateDoc }, deps) {
  const cc = await defaultCountryCode(workspaceId, deps);
  const norm = normalizePhone(deps);
  const typedRaw = typeof to === 'string' || typeof to === 'number' ? String(to).trim() : '';
  if (typedRaw.length > MAX_RAW_PHONE) throw bad('TEST_PHONE_INVALID', { reason: 'PHONE_INVALID' });
  const typed = typedRaw ? norm(typedRaw, cc) : null;
  if (typedRaw && !digitsOk(typed)) throw bad('TEST_PHONE_INVALID', { reason: 'PHONE_INVALID' });

  const loginRaw = String(await loginPhoneOf(userId, deps)).trim();
  const login = loginRaw ? norm(loginRaw, cc) : null;
  if (digitsOk(login)) {
    // the requester's own verified phone is the only recipient: a typed number is accepted only when it IS that number
    if (typed && typed !== login) throw bad('TEST_PHONE_INVALID', { reason: 'NOT_YOUR_NUMBER' });
    return { digits: login, cc, source: 'login', store: false };
  }

  // no login phone (e-mail login): only the owner may name ONE number for the workspace
  if (!(await isOwnerNow(workspaceId, userId, deps))) throw new OnbError('OWNER_ONLY');
  if (!typed) throw bad('TEST_PHONE_INVALID', { reason: 'PHONE_REQUIRED' });
  const fp = (stateDoc && stateDoc.firstPromotion) || {};
  if (fp.testNumberMasked || fp.testNumberHash || fp.testNumberLast4) {
    const secret = secretOf(deps);
    const sameNumber = fp.testNumberHash && secret
      ? fp.testNumberHash === numberHash(workspaceId, typed, secret)
      : (fp.testNumberLast4 ? fp.testNumberLast4 === typed.slice(-4) : false);
    if (!sameNumber) throw bad('TEST_PHONE_INVALID', { reason: 'TEST_NUMBER_FIXED' });
    return { digits: typed, cc, source: 'workspace', store: false };
  }
  return { digits: typed, cc, source: 'workspace', store: true };
}

/**
 * Is this number an opted-out Customer of this workspace, in ANY stored notation (0501234567, +966 50 123 4567, 00966..., Arabic-Indic digits
 * ...)? The opted-out customers of the workspace are read (bounded) and every stored phone is normalised the way the number was.
 */
async function isOptedOut(workspaceId, digits, cc, deps) {
  const rows = await models.customer(deps).find({ workspaceId, optedOut: true }).select('phone').limit(OPTED_OUT_SCAN_LIMIT).lean();
  const norm = normalizePhone(deps);
  return (rows || []).some((r) => {
    if (!r || r.phone === undefined || r.phone === null) return false;
    const stored = String(r.phone);
    return stored.replace(/\D/g, '') === digits || norm(stored, cc) === digits;
  });
}

function sampleComponents(spec, row, deps) {
  const mf = require('../localization/mergeFields');
  const mt = require('../localization/metaTemplates');
  const variant = spec.variantFor(row.language);
  const fields = [...new Set([...mf.extractFields(variant.header || ''), ...mf.extractFields(variant.body || '')])];
  const values = {};
  for (const f of fields) values[f] = mf.sampleValue(f, row.language);
  const buttonPayloads = {};
  for (const role of require('../localization/metaConstraints').QUICK_REPLY_ROLES) buttonPayloads[role] = `onbtest_${role}`; // inert: no webhook branch starts with onbtest_
  return mt.buildSendComponents({ variant, values, buttonPayloads });
}

/**
 * Pick the approved UTILITY template to send and build its components (null when none can be built). The setup test template first, then
 * any other approved UTILITY template (the category is what META reports: a template Meta re-categorised as MARKETING never qualifies).
 * A MARKETING (or any other) template is never a fallback.
 */
async function pickTemplate(workspaceId, preferredLanguage, deps) {
  const rows = (await models.template(deps).find({ workspaceId, metaStatus: 'APPROVED' }).lean())
    .filter((r) => r.metaTemplateName && String(r.category).toUpperCase() === 'UTILITY');
  const langRank = (r) => (r.language === preferredLanguage ? 0 : 1);
  const tier = (r) => (r.key === TEST_TEMPLATE_KEY ? 0 : 1);
  rows.sort((a, b) => tier(a) - tier(b) || langRank(a) - langRank(b));
  for (const row of rows) {
    const spec = starter.getSpec(row.key, deps);
    if (!spec) continue;
    try {
      return { row, components: sampleComponents(spec, row, deps) };
    } catch (_) { /* cannot be built with sample values: try the next one */ }
  }
  return null;
}

async function windowEvents(workspaceId, since, deps) {
  return models.event(deps).find({ workspaceId, type: 'notification', code: EVENT_CODE, at: { $gte: since } }).select('at').lean();
}

async function markClaim(claim, code, deps) {
  try { await models.event(deps).updateOne({ _id: claim._id, workspaceId: claim.workspaceId }, { $set: { code } }); } catch (_) { /* best effort */ }
}

/**
 * Send the setup test message.
 * @param {{workspaceId:string, userId?:string, to?:string}} args `to` = a typed number (an OWNER without a login phone, ONE number per workspace)
 * @param {object} [deps]
 * @returns {Promise<{sent:true, to:string, templateKey:string}>} `to` is the MASKED number
 * @throws {OnbError} WHATSAPP_NOT_CONNECTED, WHATSAPP_RECONNECT_REQUIRED, OWNER_ONLY, TEST_PHONE_INVALID,
 *   TEST_RECIPIENT_OPTED_OUT, TEST_NO_APPROVED_TEMPLATE, TEST_RATE_LIMITED, TEST_NUMBER_LIMIT, META_*
 */
async function sendTestMessage({ workspaceId, userId, to } = {}, deps = {}) {
  const now = nowOf(deps);
  const S = models.state(deps);
  const E = models.event(deps);

  // 1. connection (merchant token) - needsReconnect / not connected / the platform account stop here
  const ctx = await starter.loadMerchantContext(workspaceId, deps, { needPhoneId: true });
  const stateDoc = await S.findOne({ workspaceId }).select('business.uiLanguage business.languages firstPromotion').lean();
  if (!stateDoc) throw new OnbError('ONBOARDING_NOT_AVAILABLE');

  // 2. recipient: the requester's own phone, or (owner without a phone) the workspace's single test number
  const { digits, cc, store } = await resolveRecipient({ workspaceId, userId, to, stateDoc }, deps);
  const own = ctx.conn && ctx.conn.display && ctx.conn.display.displayPhoneNumber;
  if (own && normalizePhone(deps)(own, cc) === digits) throw bad('TEST_PHONE_INVALID', { reason: 'SAME_AS_BUSINESS_NUMBER' });
  if (await isOptedOut(workspaceId, digits, cc, deps)) throw new OnbError('TEST_RECIPIENT_OPTED_OUT');

  // 3. an approved UTILITY template (never a marketing one)
  const lang = (stateDoc.business && stateDoc.business.uiLanguage) || 'en';
  const picked = await pickTemplate(workspaceId, lang, deps);
  if (!picked) throw new OnbError('TEST_NO_APPROVED_TEMPLATE');

  // 4. limits, counted in the DB: record the attempt FIRST, then re-count (two simultaneous requests cannot both slip through)
  const masked = config.maskPhone(digits);
  const secret = secretOf(deps);
  const hash = numberHash(workspaceId, digits, secret);
  const last4 = digits.slice(-4);
  const since = new Date(now.getTime() - RATE_WINDOW_MS);
  const claim = await E.create({ workspaceId, type: 'notification', code: EVENT_CODE, reason: 'test_message', at: now, meta: hash ? { h: hash, last4 } : { last4 } });
  const inWindow = await windowEvents(workspaceId, since, deps);
  if (inWindow.length > RATE_LIMIT) {
    await markClaim(claim, 'TEST_MESSAGE_VOID', deps);
    const oldest = Math.min(...inWindow.map((e) => new Date(e.at).getTime()));
    throw new OnbError('TEST_RATE_LIMITED', { retryAfterSec: Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now.getTime()) / 1000)) });
  }
  const sameNumber = hash ? { 'meta.h': hash } : { 'meta.last4': last4 }; // without the server secret only the last 4 digits tell numbers apart
  const known = await E.findOne({ workspaceId, type: 'notification', code: EVENT_CODE, ...sameNumber, _id: { $ne: claim._id } }).select('_id').lean();
  let consumedNumber = false;
  if (!known) {
    const res = await S.updateOne(
      { workspaceId, $or: [{ 'firstPromotion.testMessageCount': { $lt: MAX_DISTINCT_NUMBERS } }, { 'firstPromotion.testMessageCount': { $exists: false } }] },
      { $inc: { 'firstPromotion.testMessageCount': 1 } },
    );
    if (!res || !(res.modifiedCount || res.matchedCount)) {
      await markClaim(claim, 'TEST_MESSAGE_VOID', deps);
      throw new OnbError('TEST_NUMBER_LIMIT');
    }
    consumedNumber = true;
  }

  // 4b. the owner's typed number becomes THE workspace test number (one per workspace; atomic, the first one wins)
  let storedNow = false;
  const undo = async () => {
    await markClaim(claim, 'TEST_MESSAGE_FAILED', deps);
    if (consumedNumber) { try { await S.updateOne({ workspaceId }, { $inc: { 'firstPromotion.testMessageCount': -1 } }); } catch (_) { /* best effort */ } }
    if (storedNow) {
      try {
        await S.updateOne({ workspaceId, 'firstPromotion.testNumberSetAt': now }, { $unset: { 'firstPromotion.testNumberMasked': '', 'firstPromotion.testNumberLast4': '', 'firstPromotion.testNumberHash': '', 'firstPromotion.testNumberSetAt': '', 'firstPromotion.testNumberSetBy': '' } });
      } catch (_) { /* best effort */ }
    }
  };
  if (store) {
    const set = { 'firstPromotion.testNumberMasked': masked, 'firstPromotion.testNumberLast4': last4, 'firstPromotion.testNumberSetAt': now };
    if (hash) set['firstPromotion.testNumberHash'] = hash;
    if (userId) set['firstPromotion.testNumberSetBy'] = String(userId);
    const res = await S.updateOne({ workspaceId, 'firstPromotion.testNumberMasked': { $exists: false } }, { $set: set });
    if (res && (res.modifiedCount || res.matchedCount)) storedNow = true;
    else {
      // somebody named a number first: it is the workspace's number; ours must be the same one
      const cur = await S.findOne({ workspaceId }).select('firstPromotion').lean();
      const fp = (cur && cur.firstPromotion) || {};
      const same = fp.testNumberHash && hash ? fp.testNumberHash === hash : fp.testNumberLast4 === last4;
      if (!same) {
        await undo();
        throw bad('TEST_PHONE_INVALID', { reason: 'TEST_NUMBER_FIXED' });
      }
    }
  }

  // 5. send from the merchant's number with the merchant's token
  try {
    const graph = starter.merchantGraph(starter.clientFor(deps), ctx);
    await graph.send({ to: digits, name: picked.row.metaTemplateName, languageCode: picked.row.language, components: picked.components });
  } catch (err) {
    await undo();
    throw await starter.toOnbError(err, workspaceId, deps); // reconnect kinds flip needsReconnect through connect.reportGraphError
  }

  // 6. the result: masked number + timestamp only
  try {
    await S.updateOne({ workspaceId }, { $set: { 'firstPromotion.lastTestAt': now, 'firstPromotion.testPhoneMasked': masked } });
  } catch (err) { config.safeLog('warn', '[onboarding] testMessage: result not stored:', err && err.code); }
  return { sent: true, to: masked, templateKey: picked.row.key };
}

module.exports = { sendTestMessage, RATE_LIMIT, MAX_DISTINCT_NUMBERS, numberHash, resolveRecipient, isOptedOut, isOwnerNow };
