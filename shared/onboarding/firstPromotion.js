'use strict';
// First-Promotion hand-off (spec step 5, DB design section 5 + DECISIONS C7). This module only
// READS counts and WRITES the small firstPromotion state of the sidecar document: the Promotion
// itself is built in the existing Promotions screen (nothing here creates or sends one).
//
// getFirstPromotion  -> { ready, missing:{audience,products,template}, suggestion:{...}, builderHint,
//                         sendPolicy, testRecipient:{masked,needsPhone}, state }
// setFirstPromotionState -> started | skipped | done; under the default legacy send policy 'block'
//                         ONLY started / skipped are accepted (the platform number is never used for a
//                         merchant's own send in this build) and the refusal says why.
//
// Injectable deps: model (OnboardingTemplate), stateModel, connModel, customerModel, productModel,
// serviceModel, campaignModel, userModel, library, steps, now. Nothing runs at require time.
const config = require('./config');
const { OnbError } = require('./errors');
const starter = require('./starterTemplates');

const STATES = Object.freeze(['started', 'skipped', 'done']);
// suggestion preference (first approved wins); with products on file the product promotion goes first
const PREFERRED = Object.freeze(['promotion_weekend', 'promotion_new_arrival', 'comeback', 'points_balance']);

const models = {
  template: (deps) => (deps && deps.model) || require('../../models/OnboardingTemplate'),
  state: (deps) => (deps && deps.stateModel) || require('../../models/OnboardingState'),
  conn: (deps) => (deps && deps.connModel) || require('../../models/WhatsAppConnection'),
  customer: (deps) => (deps && deps.customerModel) || require('../../models/Customer'),
  product: (deps) => (deps && deps.productModel) || require('../../models/Product'),
  service: (deps) => (deps && deps.serviceModel) || require('../../models/Service'),
  campaign: (deps) => (deps && deps.campaignModel) || require('../../models/CampaignMessage'),
  user: (deps) => (deps && deps.userModel) || require('../../models/User'),
  membership: (deps) => (deps && deps.membershipModel) || require('../../models/Membership'),
};
const toDate = (v) => (v instanceof Date ? v : new Date(v));
function nowOf(deps) { return deps && typeof deps.now === 'function' ? toDate(deps.now()) : new Date(); }
const lib = (deps) => (deps && deps.library) || require('../localization/templateLibrary');

/** Run a read; a failure yields `fallback` (the screen must still render). */
async function soft(fn, fallback) {
  try { return await fn(); } catch (err) {
    config.safeLog('warn', '[onboarding] firstPromotion read failed:', err && err.code ? err.code : (err && err.message));
    return fallback;
  }
}

function previewOf(entry, language) {
  const mf = require('../localization/mergeFields');
  const variant = entry.variants && entry.variants[language];
  if (!variant) return '';
  const values = {};
  for (const f of mf.extractFields(variant.body)) values[f] = mf.sampleValue(f, language);
  return mf.renderMessageSafe(variant.body, values, { language, protect: false }).text;
}

/**
 * Data for Step 5's hand-off screen. Read-only.
 * @param {{workspaceId:string, userId?:string}} args
 * @param {object} [deps]
 */
async function getFirstPromotion({ workspaceId, userId } = {}, deps = {}) {
  const { MARKETING_ELIGIBLE_QUERY } = require('../consent');
  const [stateDoc, conn, rows, optedIn, total, products, services, user] = await Promise.all([
    soft(() => models.state(deps).findOne({ workspaceId }).select('firstPromotion business.uiLanguage').lean(), null),
    soft(() => models.conn(deps).findOne({ workspaceId }).select('status needsReconnect tokenIsValid').lean(), null),
    soft(() => models.template(deps).find({ workspaceId, metaStatus: 'APPROVED' }).lean(), []),
    // ruling 5: an erased customer (Customer.deletedAt set) is never part of an audience count
    soft(() => models.customer(deps).countDocuments({ workspaceId, ...MARKETING_ELIGIBLE_QUERY, deletedAt: { $exists: false } }), null),
    soft(() => models.customer(deps).countDocuments({ workspaceId, deletedAt: { $exists: false } }), null),
    soft(() => models.product(deps).countDocuments({ workspaceId, active: { $ne: false } }), null),
    soft(() => models.service(deps).countDocuments({ workspaceId, active: { $ne: false } }), null),
    soft(() => (userId ? models.user(deps).findById(userId).select('phone').lean() : null), null),
  ]);
  // a live Membership read: only an owner without a login phone may be asked for a number (review R2-03)
  const owner = userId && !(user && user.phone) ? await soft(async () => {
    const m = await models.membership(deps).findOne({ userId, workspaceId }).select('role').lean();
    return !!m && m.role === 'owner';
  }, false) : false;

  const approvedLibrary = rows.filter((r) => r.source !== 'setup_test' && r.metaTemplateName);
  const approvedKeys = new Set(approvedLibrary.map((r) => r.key));
  const productCount = (products || 0) + (services || 0);
  const order = productCount > 0 ? ['promotion_new_arrival', 'promotion_weekend', 'comeback', 'points_balance'] : PREFERRED.slice();
  let templateKey = order.find((k) => approvedKeys.has(k));
  if (!templateKey && approvedLibrary.length) templateKey = approvedLibrary[0].key; // approved, but not one of the promotion starters
  const approvedAny = !!templateKey;
  if (!templateKey) templateKey = order[0];

  const missing = {
    audience: optedIn === 0,
    products: products !== null && services !== null ? productCount === 0 : false,
    template: !approvedAny,
  };
  const connected = !!conn && config.CONNECTED_LIKE.includes(conn.status) && !conn.needsReconnect && conn.tokenIsValid !== false;

  let entry = null;
  try { entry = lib(deps).getLibraryEntry(templateKey); } catch (_) { entry = null; }
  const suggestion = {
    templateKey,
    titleKey: 'onboarding.promotion.first.suggest',
    title: entry ? { en: entry.name.en, ar: entry.name.ar } : { en: templateKey, ar: templateKey },
    bodyPreview: entry ? { en: previewOf(entry, 'en'), ar: previewOf(entry, 'ar') } : { en: '', ar: '' },
    audience: { optedIn: optedIn || 0, total: total || 0 },
    campaignType: starter.CAMPAIGN_TYPE[templateKey] || 'store_wide_offer',
  };

  // The test message goes to the requester's OWN login phone. Only an OWNER who logs in without a phone is asked to type ONE number for the
  // workspace (shown masked afterwards); a member without a phone has no recipient (needsPhone false: the server would refuse a typed number).
  const loginPhone = user && user.phone ? String(user.phone) : '';
  const fp = (stateDoc && stateDoc.firstPromotion) || {};
  let testRecipient;
  if (loginPhone) testRecipient = { masked: config.maskPhone(loginPhone), needsPhone: false };
  else if (owner) testRecipient = { masked: fp.testNumberMasked || fp.testPhoneMasked || null, needsPhone: true };
  else testRecipient = { masked: null, needsPhone: false };

  return {
    ready: connected && !missing.template,
    missing,
    suggestion,
    builderHint: { path: '/promotions' },
    sendPolicy: config.legacySendPolicy(),
    testRecipient,
    state: (stateDoc && stateDoc.firstPromotion && stateDoc.firstPromotion.state) || 'locked',
  };
}

async function markPromotionStep(workspaceId, status, deps) {
  try {
    const steps = (deps && deps.steps) || require('./steps');
    await steps.markStep(workspaceId, 'promotion', status);
  } catch (err) {
    config.safeLog('warn', '[onboarding] firstPromotion: step not marked:', err && err.code);
  }
}

/**
 * Record the merchant's first-Promotion choice.
 * - 'skipped'  always accepted ("Finish setup without sending").
 * - 'started'  accepted (opened the Promotions builder); never moves a finished state backwards.
 * - 'done'     only under legacy send policy 'platform_number', and only when a read-only count shows a
 *              Promotion message created since the connection (best effort: a failed count does not block).
 *              Under 'block' it is refused with a 422 that says why (details.reason SENDING_NOT_AVAILABLE_YET).
 * @param {{workspaceId:string, state:string}} args
 * @param {object} [deps]
 * @returns {Promise<{state:string, sendPolicy:string, firstPromotion:{state:string, startedAt:Date|null, doneAt:Date|null}}>}
 */
async function setFirstPromotionState({ workspaceId, state } = {}, deps = {}) {
  if (!STATES.includes(state)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'INVALID_STATE', allowed: STATES.slice() } });
  const S = models.state(deps);
  const now = nowOf(deps);
  const policy = config.legacySendPolicy();
  const doc = await S.findOne({ workspaceId }).select('firstPromotion').lean();
  if (!doc) throw new OnbError('ONBOARDING_NOT_AVAILABLE');
  const current = (doc.firstPromotion && doc.firstPromotion.state) || 'locked';

  if (state === 'done') {
    if (policy === 'block') throw new OnbError('VALIDATION_FAILED', { details: { reason: 'SENDING_NOT_AVAILABLE_YET', sendPolicy: policy } });
    const conn = await models.conn(deps).findOne({ workspaceId }).select('connectedAt').lean();
    if (!conn || !conn.connectedAt) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'NOT_CONNECTED' } });
    const sent = await soft(() => models.campaign(deps).countDocuments({
      workspaceId, kind: 'promotion', status: { $ne: 'failed' }, createdAt: { $gte: conn.connectedAt },
    }), null);
    if (sent === 0) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'NO_PROMOTION_SENT' } });
  }

  let set;
  if (state === 'started') {
    if (current === 'done' || current === 'skipped') return result(current, policy, doc.firstPromotion); // never move backwards
    set = { 'firstPromotion.state': 'started' };
    if (!(doc.firstPromotion && doc.firstPromotion.startedAt)) set['firstPromotion.startedAt'] = now;
  } else if (state === 'skipped') {
    if (current === 'done') return result(current, policy, doc.firstPromotion);
    set = { 'firstPromotion.state': 'skipped' };
  } else {
    set = { 'firstPromotion.state': 'done', 'firstPromotion.doneAt': now };
  }
  await S.updateOne({ workspaceId }, { $set: set });
  await markPromotionStep(workspaceId, state === 'started' ? 'in_progress' : (state === 'done' ? 'done' : 'skipped'), deps);
  const fresh = { ...(doc.firstPromotion || {}), state: set['firstPromotion.state'], ...(set['firstPromotion.startedAt'] ? { startedAt: now } : {}), ...(set['firstPromotion.doneAt'] ? { doneAt: now } : {}) };
  return result(set['firstPromotion.state'], policy, fresh);
}

function result(state, sendPolicy, fp) {
  return { state, sendPolicy, firstPromotion: { state, startedAt: (fp && fp.startedAt) || null, doneAt: (fp && fp.doneAt) || null } };
}

module.exports = { getFirstPromotion, setFirstPromotionState, STATES };
