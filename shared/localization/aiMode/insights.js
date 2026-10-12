'use strict';
// Arabic overlay for Smart Insights (spec §6: "localise ... proactive Dashboard
// suggestions, Smart Insights text"). shared/insights.js builds every card in
// English from live data; this file replaces ONLY the text of a card and leaves
// everything that carries meaning alone: insightKey, rawMetric, category slug,
// priority tier/score, status, and each CTA's `action` (navigation target +
// query params), so dismiss/actioned state (keyed by insightKey + rawMetric)
// behaves exactly as for the English card (audit R6 §3.4).
//
// The English engine is not modified and does not export its numbers, so each
// card is recognised by its insightKey prefix and its English text is parsed
// back into values, with every parsed value CROSS-CHECKED against the card's
// structured fields (rawMetric, metricValue, key suffix, CTA query params). A
// card is localised only when the whole pattern matches and all the checks
// agree; otherwise the English card is returned unchanged with
// `localized: false`, so a changed English template degrades to English instead
// of showing a wrong Arabic sentence. tests/localization/aiModeInsights.test.js
// also reads shared/insights.js and fails when one of those English templates
// changes, so the overlay gets updated deliberately.
//
// Wording follows GLOSSARY.md. Counts are phrased count-neutrally ("عدد
// العملاء الذين ...: 15") wherever a verb or noun would have to agree with the
// number (D10); the one counted noun that is unavoidable (days) uses the CLDR
// plural forms. Titles start with an Arabic word on purpose: a Latin campaign or
// product name at the start of an Arabic line would make dir="auto" lay the
// whole line out left-to-right.
const catalog = require('../catalog');
const { toWesternDigits } = require('../arabicText');
const { countPhrase, formatInt } = require('./summaries');

const NS = 'aimode.';
const ar = (key, params) => catalog.t('ar', `${NS}${key}`, params);
const en = (key) => catalog.t('en', `${NS}${key}`);
const isObject = (v) => v !== null && typeof v === 'object';
const str = (v) => (typeof v === 'string' ? v : null);

// Digits only, whatever grouping the server's locale used ("1,250", "1.250", "١٬٢٥٠").
function intFrom(text) {
  const digits = toWesternDigits(text).replace(/\D/g, '');
  return digits ? Number(digits) : NaN;
}

const CURRENCY_AR = Object.freeze({ SAR: 'ر.س', AED: 'د.إ' });

// "1,250.00 SAR" -> "1,250.00 ر.س". Other currencies and non-money values are left as they are.
function localizeMoney(value) {
  const s = String(value === undefined || value === null ? '' : value);
  const m = /^(.*\d) ([A-Z]{3})$/.exec(s);
  return m && CURRENCY_AR[m[2]] ? `${m[1]} ${CURRENCY_AR[m[2]]}` : s;
}

// A rule returns { title, message, metricLabel, metricValue, ctas } in Arabic, or
// null when anything about the card is not what the engine currently produces.
// `ctas` = [primary, secondary] catalog keys (null = no CTA expected there).
const RULES = [
  {
    prefix: 'best_campaign_',
    category: 'campaign_performance',
    metricLabel: 'insight.metric.revenueGenerated',
    ctas: ['insight.cta.runAgain', 'insight.cta.viewCampaign'],
    localize(card) {
      const title = /^(.+) was your top campaign this week$/s.exec(card.title);
      const message = /^It generated (.+) from (\d+) orders?\. Run it again\?$/.exec(card.message);
      if (!title || !message || message[1] !== String(card.metricValue)) return null;
      return {
        title: ar('insight.bestCampaign.title', { name: title[1] }),
        message: ar('insight.bestCampaign.message', { money: localizeMoney(message[1]), orders: formatInt(message[2]) }),
        metricValue: localizeMoney(card.metricValue),
      };
    },
  },
  {
    prefix: 'worst_campaign_',
    category: 'campaign_performance',
    metricLabel: 'insight.metric.conversionRate',
    ctas: ['insight.cta.createSimilarCampaign', 'insight.cta.viewCampaign'],
    localize(card) {
      const title = /^(.+) had a low conversion rate$/s.exec(card.title);
      const message = /^Only (\d+(?:\.\d+)?)% of customers who got it ordered\. Try a different offer\?$/.exec(card.message);
      if (!title || !message || Number(message[1]) !== card.rawMetric || card.metricValue !== `${message[1]}%`) return null;
      return {
        title: ar('insight.worstCampaign.title', { name: title[1] }),
        message: ar('insight.worstCampaign.message', { rate: message[1] }),
        metricValue: `${message[1]}%`,
      };
    },
  },
  {
    prefix: 'inactive_customers_',
    category: 'customer_retention',
    metricLabel: 'insight.metric.estimatedOpportunity',
    ctas: ['insight.cta.createComebackCampaign', 'insight.cta.viewCustomers'],
    localize(card) {
      const title = /^(\d+) customers haven't returned$/.exec(card.title);
      const message = /^(\d+) customers have not ordered in (\d+) days\.$/.exec(card.message);
      if (!title || !message) return null;
      const n = Number(title[1]);
      const days = Number(message[2]);
      if (n !== Number(message[1]) || n !== card.rawMetric || card.insightKey !== `inactive_customers_${days}`) return null;
      // The engine shows a money estimate when it has one, otherwise "N customers".
      const metricValue = card.metricValue === `${n} customers` ? countPhrase('ar', 'customer', n) : localizeMoney(card.metricValue);
      return {
        title: ar('insight.inactive.title', { n: formatInt(n) }),
        message: ar('insight.inactive.message', { n: formatInt(n), days: countPhrase('ar', 'day', days, { oblique: true }) }),
        metricValue,
      };
    },
  },
  {
    prefix: 'unused_points_',
    category: 'loyalty',
    metricLabel: 'insight.metric.unredeemedPoints',
    ctas: ['insight.cta.sendPointsReminder', null],
    localize(card) {
      const message = /^You issued (\S+) loyalty points this month, but only (\S+) have been redeemed\.$/.exec(card.message);
      if (card.title !== en('insight.unusedPoints.title') || !message) return null;
      const issued = intFrom(message[1]);
      const redeemed = intFrom(message[2]);
      if (!Number.isFinite(issued) || !Number.isFinite(redeemed) || issued - redeemed !== card.rawMetric) return null;
      return {
        title: ar('insight.unusedPoints.title'),
        message: ar('insight.unusedPoints.message', { issued: formatInt(issued), redeemed: formatInt(redeemed) }),
        metricValue: formatInt(card.rawMetric),
      };
    },
  },
  {
    prefix: 'abandoned_payments_',
    category: 'payment',
    metricLabel: 'insight.metric.unpaidOrders',
    ctas: ['insight.cta.viewUnpaidOrders', null],
    localize(card) {
      const title = /^(\d+) customers didn't complete payment$/.exec(card.title);
      const message = /^(\d+) customers? opened a payment link but did not complete payment\.$/.exec(card.message);
      if (!title || !message || title[1] !== message[1] || !Number.isInteger(card.rawMetric)) return null;
      return {
        title: ar('insight.abandoned.title', { n: formatInt(title[1]) }),
        message: ar('insight.abandoned.message', { n: formatInt(message[1]) }),
        metricValue: String(card.rawMetric),
      };
    },
  },
  {
    prefix: 'best_product_',
    category: 'revenue',
    metricLabel: 'insight.metric.unitsSold',
    ctas: ['insight.cta.createProductCampaign', 'insight.cta.viewProductSales'],
    localize(card) {
      const title = /^(.+) was your best-selling product this week$/s.exec(card.title);
      const message = /^(.+) was your best-selling product this week\. Create a promotion to drive repeat orders\?$/s.exec(card.message);
      if (!title || !message || title[1] !== message[1] || !Number.isInteger(card.rawMetric)) return null;
      const cta = card.primaryCta && card.primaryCta.action && card.primaryCta.action.queryParams;
      if (isObject(cta) && cta.productName !== undefined && cta.productName !== title[1]) return null;
      return {
        title: ar('insight.bestProduct.title', { product: title[1] }),
        message: ar('insight.bestProduct.message', { product: title[1] }),
        metricValue: String(card.rawMetric),
      };
    },
  },
  {
    prefix: 'loyal_customers_',
    category: 'loyalty',
    metricLabel: 'insight.metric.repeatCustomers',
    ctas: ['insight.cta.sendLoyaltyReward', 'insight.cta.viewCustomers'],
    localize(card) {
      const title = /^(\d+) loyal customers this week$/.exec(card.title);
      const message = /^(\d+) customers ordered more than once this week\. Send them a loyalty reward\?$/.exec(card.message);
      if (!title || !message || title[1] !== message[1] || Number(title[1]) !== card.rawMetric) return null;
      return {
        title: ar('insight.loyal.title', { n: formatInt(title[1]) }),
        message: ar('insight.loyal.message', { n: formatInt(message[1]) }),
        metricValue: String(card.rawMetric),
      };
    },
  },
];

// The CTA's label is swapped; its action object is passed through by reference.
function localizeCta(cta, expectedKey) {
  if (expectedKey === null) return cta === null || cta === undefined ? { ok: true, value: null } : { ok: false };
  if (!isObject(cta) || cta.label !== en(expectedKey)) return { ok: false };
  return { ok: true, value: { ...cta, label: ar(expectedKey) } };
}

// -> { card, localized }. `card` keeps every field of the engine's card.
function localizeCard(card) {
  const fallback = { card: { ...card, metricValue: String(card && card.metricValue !== undefined && card.metricValue !== null ? card.metricValue : '') }, localized: false };
  if (!isObject(card) || typeof card.insightKey !== 'string') return fallback;
  const rule = RULES.find((r) => card.insightKey.startsWith(r.prefix));
  if (!rule || card.category !== rule.category) return fallback;
  if (!str(card.title) || !str(card.message)) return fallback;
  if (card.categoryLabel !== en(`insight.category.${rule.category}`) || card.metricLabel !== en(rule.metricLabel)) return fallback;
  const primary = localizeCta(card.primaryCta, rule.ctas[0]);
  const secondary = localizeCta(card.secondaryCta, rule.ctas[1]);
  if (!primary.ok || !secondary.ok) return fallback;
  const text = rule.localize(card);
  if (!text) return fallback;
  return {
    localized: true,
    card: {
      ...card,
      categoryLabel: ar(`insight.category.${rule.category}`),
      title: text.title,
      message: text.message,
      metricLabel: ar(rule.metricLabel),
      metricValue: text.metricValue,
      primaryCta: primary.value,
      secondaryCta: secondary.value,
    },
  };
}

// The shape the page consumes (AiModeInsight in localization.types.ts).
function toAiModeInsight({ card, localized }) {
  const cta = (c) => (isObject(c) ? c : null);
  return {
    insightKey: card.insightKey,
    category: card.category,
    categoryLabel: card.categoryLabel,
    icon: card.icon,
    title: card.title,
    message: card.message,
    metricLabel: card.metricLabel,
    metricValue: String(card.metricValue === undefined || card.metricValue === null ? '' : card.metricValue),
    primaryCtaLabel: cta(card.primaryCta) ? card.primaryCta.label : null,
    primaryCta: cta(card.primaryCta),
    secondaryCtaLabel: cta(card.secondaryCta) ? card.secondaryCta.label : null,
    secondaryCta: cta(card.secondaryCta),
    localized,
  };
}

// cards: the array shared/insights.js#generateInsights returns.
// language 'en' returns the English cards as they are (localized: true = "in the
// language you asked for"); 'ar' applies the overlay with the English fallback.
function localizeInsights(cards, language) {
  const list = Array.isArray(cards) ? cards : [];
  if (language !== 'ar') return list.map((card) => toAiModeInsight({ card, localized: true }));
  return list.map((card) => toAiModeInsight(localizeCard(card)));
}

module.exports = { RULES, localizeMoney, localizeCard, toAiModeInsight, localizeInsights };
