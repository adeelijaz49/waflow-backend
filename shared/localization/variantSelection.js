'use strict';
// Chooses which language variant of a template a customer receives, and
// summarises an audience for the campaign preview. Pure functions.
//
// Rules (spec §3.2):
//  * a variant is only usable when Meta has APPROVED it — and an Arabic
//    (or bilingual) variant must additionally have been marked `reviewed` by a
//    native reader (spec §8) before it can go to real customers;
//  * "per customer" mode: customer's language -> merchant default -> English;
//  * an explicit single-language choice (en / ar) never falls back silently —
//    if that variant isn't usable, the customer is BLOCKED (not sent) so the
//    merchant sees it in the preview;
//  * never send a blank, placeholder or wrong-language message silently.
const { resolveLanguage } = require('./languageDetect');

const LANGUAGE_MODES = ['per_customer', 'en', 'ar', 'bilingual'];

function findVariant(template, language) {
  return ((template && template.variants) || []).find((v) => v && v.language === language) || null;
}

// -> { ok: boolean, reason?: string }
function checkSendable(variant, { requireNativeReview = true } = {}) {
  if (!variant) return { ok: false, reason: 'missing' };
  const status = variant.metaStatus || 'NOT_CREATED';
  if (status !== 'APPROVED') {
    const map = { NOT_CREATED: 'not_submitted', PENDING: 'pending', IN_APPEAL: 'pending', REJECTED: 'rejected', PAUSED: 'paused', DISABLED: 'disabled', FLAGGED: 'flagged' };
    return { ok: false, reason: map[status] || 'not_approved' };
  }
  if (variant.language !== 'en' && requireNativeReview && variant.reviewStatus !== 'reviewed') {
    return { ok: false, reason: 'not_reviewed' };
  }
  return { ok: true };
}

function uniq(list) { return list.filter((x, i) => x && list.indexOf(x) === i); }

// -> {
//   variant, requestedLanguage, usedLanguage, fallback, blocked, reason, attempts: [{language, ok, reason}]
// }
function pickVariant(template, { customerLanguage, merchantDefault, languageMode = 'per_customer', requireNativeReview = true } = {}) {
  const attempts = [];
  const tryLanguage = (language) => {
    const variant = findVariant(template, language);
    const res = checkSendable(variant, { requireNativeReview });
    attempts.push({ language, ok: res.ok, reason: res.reason || null });
    return res.ok ? variant : null;
  };

  const perCustomerRequested = resolveLanguage(customerLanguage, merchantDefault);

  if (languageMode === 'en' || languageMode === 'ar') {
    const variant = tryLanguage(languageMode);
    return {
      variant, requestedLanguage: languageMode, usedLanguage: variant ? languageMode : null,
      fallback: false, blocked: !variant, reason: variant ? 'ok' : `${languageMode}_${attempts[0].reason}`, attempts,
    };
  }

  if (languageMode === 'bilingual') {
    const variant = tryLanguage('bilingual');
    if (variant) {
      return { variant, requestedLanguage: 'bilingual', usedLanguage: 'bilingual', fallback: false, blocked: false, reason: 'ok', attempts };
    }
    // Bilingual version not usable: fall back to the per-customer rule below,
    // and say so (the preview surfaces this).
    const inner = pickVariant(template, { customerLanguage, merchantDefault, languageMode: 'per_customer', requireNativeReview });
    return {
      ...inner,
      requestedLanguage: 'bilingual',
      fallback: true,
      reason: inner.variant ? `bilingual_${attempts[0].reason}` : inner.reason,
      attempts: attempts.concat(inner.attempts),
    };
  }

  // per_customer
  const candidates = uniq([perCustomerRequested, merchantDefault === 'ar' || merchantDefault === 'en' ? merchantDefault : null, 'en']);
  for (const language of candidates) {
    const variant = tryLanguage(language);
    if (variant) {
      const fellBack = language !== perCustomerRequested;
      return {
        variant, requestedLanguage: perCustomerRequested, usedLanguage: language, fallback: fellBack, blocked: false,
        reason: fellBack ? `${perCustomerRequested}_${attempts[0].reason}` : 'ok', attempts,
      };
    }
  }
  return {
    variant: null, requestedLanguage: perCustomerRequested, usedLanguage: null, fallback: false, blocked: true,
    reason: 'no_usable_variant', attempts,
  };
}

// customers: [{ customerId, language }] (language may be 'unknown'/undefined)
// -> {
//   total, usable, blocked,
//   byLanguage: { en, ar, bilingual },
//   fallbacks: [{ from, to, reason, count }],
//   blockedReasons: { reason: count },
//   perCustomer: [{ customerId, usedLanguage, requestedLanguage, fallback, blocked, reason }]
// }
function planAudience(template, customers, { merchantDefault, languageMode = 'per_customer', requireNativeReview = true } = {}) {
  const byLanguage = { en: 0, ar: 0, bilingual: 0 };
  const fallbackMap = new Map();
  const blockedReasons = {};
  const perCustomer = [];
  let blocked = 0;

  for (const c of customers || []) {
    const pick = pickVariant(template, { customerLanguage: c.language, merchantDefault, languageMode, requireNativeReview });
    perCustomer.push({
      customerId: c.customerId, usedLanguage: pick.usedLanguage, requestedLanguage: pick.requestedLanguage,
      fallback: pick.fallback, blocked: pick.blocked, reason: pick.reason,
    });
    if (pick.blocked) {
      blocked += 1;
      blockedReasons[pick.reason] = (blockedReasons[pick.reason] || 0) + 1;
      continue;
    }
    byLanguage[pick.usedLanguage] = (byLanguage[pick.usedLanguage] || 0) + 1;
    if (pick.fallback) {
      const key = `${pick.requestedLanguage}->${pick.usedLanguage}|${pick.reason}`;
      const cur = fallbackMap.get(key) || { from: pick.requestedLanguage, to: pick.usedLanguage, reason: pick.reason, count: 0 };
      cur.count += 1;
      fallbackMap.set(key, cur);
    }
  }
  const total = (customers || []).length;
  return { total, usable: total - blocked, blocked, byLanguage, fallbacks: Array.from(fallbackMap.values()), blockedReasons, perCustomer };
}

module.exports = { LANGUAGE_MODES, findVariant, checkSendable, pickVariant, planAudience };
