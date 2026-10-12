'use strict';
// Arabic referral link page: /r/:code (a customer's own link) and /c/:code (the
// generic link on a flyer, QR code or social post). The shared interstitial / click /
// redirect flow lives in landing.js; this file supplies what is specific to referrals:
//   * the read-only lookup that ties a code to its workspace (for the rollout flag) and,
//     for the page only, to its promotion (the same validity rules shared/referrals.js
//     applies) and to the merchant's business name;
//   * the referrer's language as a last-resort hint (see pages/index.js);
//   * the Arabic prefilled WhatsApp text.
//
// PRIVACY: this page is public - anyone holding the link sees it, and a /r/ link travels
// from the referrer to people the referrer chose. It therefore shows NOTHING about the
// referrer: no name, no phone, no "X invited you". The customer record of the referrer is
// never read for the page at all. Only the business context is shown: the merchant's
// business name, the promotion name and the friend's reward text (all merchant-written).
// The referrer's stored LANGUAGE still picks the page language when the browser says
// nothing (getHintLanguage); it is a hint that is never displayed.
const catalog = require('../catalog');
const layout = require('./layout');
const { planLanding, codeToken } = require('./landing');

const GROUPS = ['common', 'referral'];

// The business name the visitor sees: Settings.merchantName, else the workspace name unless
// it is the auto-generated "<x>'s Workspace" - the same precedence the campaign planner uses
// for the {business} merge field (campaignPlanner.resolveBusinessName). '' = none. It is
// cosmetic: a failing lookup must never cost the visitor the page, so it degrades to the
// generic invitation.
async function loadMerchantName(models, workspaceId) {
  try {
    const settings = await models.Settings.findOne({ workspaceId }).select('merchantName').lean();
    const fromSettings = layout.cleanText(settings && settings.merchantName, 80);
    if (fromSettings) return fromSettings;
    const workspace = await models.Workspace.findById(workspaceId).select('name').lean();
    const name = layout.cleanText(workspace && workspace.name, 80);
    return name && !/'s workspace$/i.test(name) ? name : '';
  } catch (err) {
    return '';
  }
}

// Read-only. Unknown codes use the oldest workspace for the flag check, like every other
// request that carries no workspace of its own.
async function loadReferralContext(deps, code) {
  const { ReferralCode, ReferralPromotion, CustomerLanguage } = deps.models;
  const referralCode = await ReferralCode.findOne({ code }).select('workspaceId referralPromotionId referrerCustomerId status').lean();
  if (!referralCode) return { workspaceId: await deps.oldestWorkspaceId(), getLanding: async () => ({ valid: false }) };

  const workspaceId = String(referralCode.workspaceId);
  const referrerId = referralCode.referrerCustomerId;
  return {
    workspaceId,
    getHintLanguage: referrerId
      ? async () => {
        const doc = await CustomerLanguage.findOne({ workspaceId, customerId: referrerId }).select('language').lean();
        return doc ? doc.language : null;
      }
      : undefined,
    // Mirrors the checks recordClickAndGetRedirect makes (active code, promotion not ended,
    // not past endsAt) so the page can say "not found" instead of offering a button that
    // leads nowhere.
    getLanding: async () => {
      const promotion = referralCode.referralPromotionId
        ? await ReferralPromotion.findOne({ _id: referralCode.referralPromotionId, workspaceId }).select('name status endsAt friendRewardLabel').lean()
        : null;
      const endsAt = promotion && promotion.endsAt ? new Date(promotion.endsAt).getTime() : null;
      const valid = referralCode.status === 'active' && !!promotion && promotion.status !== 'ended' && !(endsAt !== null && endsAt < deps.now());
      if (!valid) return { valid: false };
      return { valid: true, promotion, merchantName: await loadMerchantName(deps.models, workspaceId) };
    },
  };
}

// Arabic sentence, then the Latin "Code: <TOKEN>" on its own line. The inbound detection
// (shared/referrals.js CODE_PATTERN = /code:\s*([A-F0-9]{10})/i) needs the English word,
// the colon and the token as plain ASCII with NO direction mark in between (U+200E / U+200F
// are not whitespace to `\s`), so the token is appended by code and never goes through the
// catalogue's RTL-protecting placeholder rendering.
function referralPrefill(result, code) {
  const token = codeToken((result.referralCode && result.referralCode.code) || code);
  return `${catalog.t('ar', 'pages.referral.prefill')}\nCode: ${token}`;
}

// "Offer: <promotion name>" and, when the merchant wrote one, "Your reward: <reward text>".
function offerLines(landing) {
  const promotion = landing.promotion || {};
  const name = layout.cleanText(promotion.name, 120);
  const reward = layout.cleanText(promotion.friendRewardLabel, 120);
  return [
    name ? layout.fill('common.offer', { offer: layout.bdi(name, 120) }) : '',
    reward ? layout.fill('referral.reward', { reward: layout.bdi(reward, 120) }) : '',
  ].filter(Boolean).join('<br>');
}

function planReferral(req, deps, { generic }) {
  return planLanding(req, deps, {
    groups: GROUPS,
    basePath: (code) => `/${generic ? 'c' : 'r'}/${encodeURIComponent(code)}`,
    loadContext: loadReferralContext,
    record: (d, args) => d.recordReferralClick(args),
    defaultMedium: generic ? 'generic_link' : 'customer_link',
    prefill: referralPrefill,
    titleKey: 'referral.title',
    explainKey: 'referral.explain',
    notFoundBodyKey: 'referral.notFound.body',
    introHtml: async (landing) => (landing.merchantName
      ? layout.fill('referral.invitedBusiness', { business: layout.bdi(landing.merchantName, 80) })
      : layout.text('referral.invitedGeneric')),
    offerHtml: offerLines,
  });
}

module.exports = { planReferral, loadReferralContext, loadMerchantName, referralPrefill };
