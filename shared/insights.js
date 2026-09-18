// Smart Insights — a rules-based recommendation engine, not a stored report.
// Every card in CARD SPEC below is computed fresh from live data on each
// request (see generateInsights); only the merchant's dismiss/actioned
// response to one persists, in models/InsightState.js. Closest existing
// analog is shared/operations.js's FLOW_PRESET_CATALOG (a static
// {id, category, rule, action, why} list) — this is that same card shape,
// computed instead of hardcoded.
//
// CARD SPEC (what every computeXxx() below returns, or null if the
// underlying condition isn't currently true):
//   insightKey    — deterministic per rule (see each function) so
//                   InsightState dismissals/actions attach to the right card
//                   across requests, and a meaningfully different value
//                   (new week, changed count) naturally gets a new key.
//   category, categoryLabel, icon
//   title, message — plain-language, no technical terms (RFM, cohort, etc.)
//   metricLabel, metricValue
//   priorityTier ('high'|'medium'|'low'), priorityScore (for sorting within a tier)
//   primaryCta / secondaryCta — { label, action: { type:'navigate', path, queryParams } }
//     or null. Every action here is a NAVIGATION to a pre-filled screen —
//     nothing in this file ever sends a WhatsApp message or mutates data.
//     "No campaign is ever sent without merchant review" holds by construction.
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const InsightState = require('../models/InsightState');
const { listInactiveCustomers } = require('./operations');
const { getCurrency } = require('../utils/settingsCache');
const { money } = require('../utils/currency');

const DAY_MS = 24 * 60 * 60 * 1000;

// Mirrors shared/operations.js's identically-named helpers — duplicated
// rather than imported since operations.js doesn't export them and they're
// three lines each (same tradeoff shared/consent.js already makes).
function withWorkspace(filter, workspaceId) {
  if (workspaceId) filter.workspaceId = workspaceId;
  return filter;
}
function workspaceMatch(workspaceId) {
  return workspaceId ? { workspaceId: new mongoose.Types.ObjectId(workspaceId) } : {};
}

function isoWeekKey(date) {
  // Same-week values must be dismiss-stable, different-week values must not
  // be — a plain ISO year+week number (not the exact date) is all this needs.
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / DAY_MS) + 1) / 7);
  return `${d.getUTCFullYear()}W${String(week).padStart(2, '0')}`;
}

const CATEGORIES = {
  campaign_performance: { label: 'Campaign Performance', icon: '📢' },
  customer_retention:   { label: 'Customer Recovery',    icon: '🔄' },
  loyalty:              { label: 'Loyalty',               icon: '💎' },
  revenue:              { label: 'Revenue',               icon: '💰' },
  payment:              { label: 'Payment',               icon: '💳' },
};

// rawMetric is a plain number computed straight from the underlying
// count/value, kept separate from the display-formatted metricValue (e.g.
// "$2,450.00") specifically so the "un-suppress on meaningful change" check
// in generateInsights never has to re-parse a formatted string back into a
// number — that round-trip is exactly the kind of thing that silently
// breaks (currency symbols, thousands separators, a card whose metricValue
// isn't even numeric) and would make a dismissed card flicker back for
// purely cosmetic reasons.
function card({ key, category, title, message, metricLabel, metricValue, rawMetric, tier, score, primaryCta, secondaryCta }) {
  const meta = CATEGORIES[category];
  return {
    insightKey: key, category, categoryLabel: meta.label, icon: meta.icon,
    title, message, metricLabel, metricValue, rawMetric,
    priorityTier: tier, priorityScore: score,
    primaryCta, secondaryCta: secondaryCta || null,
    updatedAt: new Date(),
  };
}

function nav(path, queryParams) {
  return { type: 'navigate', path, queryParams: queryParams || {} };
}

// Shared aggregation for the two "this week's campaign" rules — both need
// the exact same per-promotion sent/ordered/revenue/conversionRate shape as
// shared/operations.js#getBestPerformingPromotion, just scoped to the last 7
// days, so this runs it once and both rules read from the same result.
async function campaignStatsThisWeek(workspaceId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
  const agg = await CampaignMessage.aggregate([
    { $match: { ...workspaceMatch(workspaceId), kind: 'promotion', promotion: { $ne: null }, sentAt: { $gte: sevenDaysAgo } } },
    { $group: {
      _id: '$promotion',
      sent:    { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } },
      ordered: { $sum: { $cond: [{ $gt: ['$order', null] }, 1, 0] } },
      revenue: { $sum: '$revenue' },
    } },
    // A campaign with only a handful of sends is too noisy to call "best" or
    // "worst" — mirrors the spec's own example volumes (38 orders, 42 clicks).
    { $match: { sent: { $gte: 5 } } },
  ]);
  if (!agg.length) return [];

  const promotions = await Promotion.find({ _id: { $in: agg.map(a => a._id) } });
  const nameById = Object.fromEntries(promotions.map(p => [p._id.toString(), p.name]));

  return agg.map(a => ({
    promotionId: a._id, name: nameById[a._id.toString()] || 'Unknown',
    sent: a.sent, ordered: a.ordered, revenue: +a.revenue.toFixed(2),
    conversionRate: a.sent > 0 ? +((a.ordered / a.sent) * 100).toFixed(1) : 0,
  }));
}

async function computeBestCampaignThisWeek(workspaceId, stats) {
  if (!stats.length) return null;
  const best = [...stats].sort((a, b) => b.revenue - a.revenue)[0];
  if (best.revenue <= 0) return null;
  const currency = await getCurrency();
  return card({
    key: `best_campaign_${isoWeekKey(new Date())}`,
    category: 'campaign_performance',
    title: `${best.name} was your top campaign this week`,
    message: `It generated ${money(best.revenue, currency)} from ${best.ordered} order${best.ordered === 1 ? '' : 's'}. Run it again?`,
    metricLabel: 'Revenue generated', metricValue: money(best.revenue, currency), rawMetric: best.revenue,
    tier: 'high', score: 100 + best.revenue,
    primaryCta: { label: 'Run Again', action: nav('/promotions', { runAgainPromotionId: best.promotionId }) },
    secondaryCta: { label: 'View Campaign', action: nav('/promotions', { viewPromotionId: best.promotionId }) },
  });
}

async function computeWorstCampaignThisWeek(workspaceId, stats) {
  if (!stats.length) return null;
  const LOW_CONVERSION_THRESHOLD = 5; // percent
  const worst = [...stats].sort((a, b) => a.conversionRate - b.conversionRate)[0];
  if (worst.conversionRate >= LOW_CONVERSION_THRESHOLD) return null;
  return card({
    key: `worst_campaign_${isoWeekKey(new Date())}`,
    category: 'campaign_performance',
    title: `${worst.name} had a low conversion rate`,
    message: `Only ${worst.conversionRate}% of customers who got it ordered. Try a different offer?`,
    metricLabel: 'Conversion rate', metricValue: `${worst.conversionRate}%`, rawMetric: worst.conversionRate,
    tier: 'low', score: 10 + (LOW_CONVERSION_THRESHOLD - worst.conversionRate),
    primaryCta: { label: 'Create Similar Campaign', action: nav('/promotions', { openCreate: true, campaignType: 'product_promotion' }) },
    secondaryCta: { label: 'View Campaign', action: nav('/promotions', { viewPromotionId: worst.promotionId }) },
  });
}

async function computeInactiveCustomers(workspaceId) {
  const DAYS = 30;
  const { customers } = await listInactiveCustomers({ days: DAYS, workspaceId });
  if (!customers.length) return null;

  const ninetyDaysAgo = new Date(Date.now() - 90 * DAY_MS);
  const aovAgg = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), paymentStatus: 'paid', createdAt: { $gte: ninetyDaysAgo } } },
    { $group: { _id: null, avg: { $avg: '$total' } } },
  ]);
  const avgOrderValue = aovAgg[0]?.avg || 0;
  const opportunity = +(customers.length * avgOrderValue).toFixed(2);
  const currency = await getCurrency();
  const ids = customers.slice(0, 50).map(c => c.id.toString());

  return card({
    key: `inactive_customers_${DAYS}`,
    category: 'customer_retention',
    title: `${customers.length} customers haven't returned`,
    message: `${customers.length} customers have not ordered in ${DAYS} days.`,
    metricLabel: 'Estimated opportunity', metricValue: opportunity > 0 ? money(opportunity, currency) : `${customers.length} customers`,
    rawMetric: customers.length, // compare by count, not the derived $ estimate — see card()'s rawMetric doc comment
    tier: 'high', score: 100 + customers.length,
    primaryCta: { label: 'Create Comeback Campaign', action: nav('/promotions', { openCreate: true, campaignType: 'inactive_customer_comeback', customerIds: ids.join(',') }) },
    secondaryCta: { label: 'View Customers', action: nav('/customers', { ids: ids.join(',') }) },
  });
}

async function computeUnusedLoyaltyPoints(workspaceId) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const agg = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), status: { $ne: 'cancelled' }, createdAt: { $gte: startOfMonth } } },
    { $group: { _id: null, issued: { $sum: '$loyaltyPointsEarned' }, redeemed: { $sum: '$loyaltyPointsUsed' } } },
  ]);
  const issued = agg[0]?.issued || 0;
  const redeemed = agg[0]?.redeemed || 0;
  if (issued <= 0) return null;

  return card({
    key: `unused_points_${isoWeekKey(new Date()).slice(0, 4)}${String(new Date().getMonth() + 1).padStart(2, '0')}`,
    category: 'loyalty',
    title: 'Most loyalty points issued this month are unused',
    message: `You issued ${issued.toLocaleString()} loyalty points this month, but only ${redeemed.toLocaleString()} have been redeemed.`,
    metricLabel: 'Unredeemed points', metricValue: (issued - redeemed).toLocaleString(), rawMetric: issued - redeemed,
    tier: 'high', score: 90 + (issued - redeemed) / 100,
    primaryCta: { label: 'Send Points Reminder', action: nav('/promotions', { openLoyalty: true }) },
    secondaryCta: null,
  });
}

async function computeAbandonedPayments(workspaceId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const pending = await Order.find(withWorkspace({
    paymentStatus: 'pending', createdAt: { $gte: thirtyDaysAgo, $lte: oneHourAgo },
  }, workspaceId)).select('customer').lean();
  if (!pending.length) return null;

  const ids = [...new Set(pending.map(o => o.customer.toString()))];
  return card({
    key: `abandoned_payments_${isoWeekKey(new Date())}`,
    category: 'payment',
    title: `${ids.length} customers didn't complete payment`,
    message: `${ids.length} customer${ids.length === 1 ? '' : 's'} opened a payment link but did not complete payment.`,
    metricLabel: 'Unpaid orders', metricValue: pending.length, rawMetric: pending.length,
    tier: 'high', score: 95 + pending.length,
    primaryCta: { label: 'View Unpaid Orders', action: nav('/orders', { paymentStatus: 'pending' }) },
    secondaryCta: null,
  });
}

async function computeBestSellingProduct(workspaceId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
  const agg = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), status: { $ne: 'cancelled' }, createdAt: { $gte: sevenDaysAgo } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productName', qty: { $sum: '$items.quantity' } } },
    { $match: { _id: { $ne: null } } },
    { $sort: { qty: -1 } },
    { $limit: 1 },
  ]);
  if (!agg.length) return null;
  const top = agg[0];

  return card({
    key: `best_product_${isoWeekKey(new Date())}`,
    category: 'revenue',
    title: `${top._id} was your best-selling product this week`,
    message: `${top._id} was your best-selling product this week. Create a promotion to drive repeat orders?`,
    metricLabel: 'Units sold', metricValue: top.qty, rawMetric: top.qty,
    tier: 'medium', score: 50 + top.qty,
    primaryCta: { label: 'Create Product Campaign', action: nav('/promotions', { openCreate: true, campaignType: 'product_promotion', productName: top._id }) },
    secondaryCta: { label: 'View Product Sales', action: nav('/products', { search: top._id }) },
  });
}

async function computeLoyalCustomersThisWeek(workspaceId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);
  const agg = await Order.aggregate([
    { $match: { ...workspaceMatch(workspaceId), status: { $ne: 'cancelled' }, createdAt: { $gte: sevenDaysAgo } } },
    { $group: { _id: '$customer', count: { $sum: 1 } } },
    { $match: { count: { $gte: 2 } } },
  ]);
  if (!agg.length) return null;
  const ids = agg.map(a => a._id.toString());

  return card({
    key: `loyal_customers_${isoWeekKey(new Date())}`,
    category: 'loyalty',
    title: `${ids.length} loyal customers this week`,
    message: `${ids.length} customers ordered more than once this week. Send them a loyalty reward?`,
    metricLabel: 'Repeat customers', metricValue: ids.length, rawMetric: ids.length,
    tier: 'medium', score: 50 + ids.length,
    primaryCta: { label: 'Send Loyalty Reward', action: nav('/promotions', { openCreate: true, campaignType: 'loyalty_reminder', customerIds: ids.slice(0, 50).join(',') }) },
    secondaryCta: { label: 'View Customers', action: nav('/customers', { ids: ids.slice(0, 50).join(',') }) },
  });
}

// Booking/quiet-slot insights (spec category 5) are deferred — no existing
// aggregation infra for them yet and they're not in the spec's explicit
// "Must have" list, only its longer category list. Fast-follow, not v1.

const RULES = {
  campaign_performance: ['bestCampaign', 'worstCampaign'],
  customer_retention: ['inactiveCustomers'],
  loyalty: ['unusedPoints', 'loyalCustomers'],
  revenue: ['bestSellingProduct'],
  payment: ['abandonedPayments'],
};

const SURFACE_CATEGORIES = {
  dashboard: Object.keys(RULES),
  aimode: Object.keys(RULES),
  campaigns: ['campaign_performance'],
  customers: ['customer_retention', 'loyalty'],
};

const SURFACE_LIMITS = { dashboard: 5, aimode: 5, campaigns: 8, customers: 8 };

async function computeAllCards(workspaceId, categories) {
  const results = [];
  const needsCampaignStats = categories.includes('campaign_performance');
  const campaignStats = needsCampaignStats ? await campaignStatsThisWeek(workspaceId) : [];

  const jobs = [];
  if (categories.includes('campaign_performance')) {
    jobs.push(computeBestCampaignThisWeek(workspaceId, campaignStats));
    jobs.push(computeWorstCampaignThisWeek(workspaceId, campaignStats));
  }
  if (categories.includes('customer_retention')) jobs.push(computeInactiveCustomers(workspaceId));
  if (categories.includes('loyalty')) {
    jobs.push(computeUnusedLoyaltyPoints(workspaceId));
    jobs.push(computeLoyalCustomersThisWeek(workspaceId));
  }
  if (categories.includes('revenue')) jobs.push(computeBestSellingProduct(workspaceId));
  if (categories.includes('payment')) jobs.push(computeAbandonedPayments(workspaceId));

  const settled = await Promise.all(jobs);
  for (const c of settled) if (c) results.push(c);
  return results;
}

async function generateInsights({ workspaceId, surface = 'dashboard' }) {
  const categories = SURFACE_CATEGORIES[surface] || SURFACE_CATEGORIES.dashboard;
  const limit = SURFACE_LIMITS[surface] || SURFACE_LIMITS.dashboard;

  const [cards, states] = await Promise.all([
    computeAllCards(workspaceId, categories),
    InsightState.find(withWorkspace({}, workspaceId)).lean(),
  ]);
  const stateByKey = Object.fromEntries(states.map(s => [s.insightKey, s]));

  const visible = cards.filter(c => {
    const state = stateByKey[c.insightKey];
    if (!state) return true;
    if (state.status === 'actioned') return false; // actioned insights don't come back at all
    // Dismissed: stays hidden only while the metric hasn't meaningfully
    // changed since the merchant dismissed it (compares the raw numeric
    // rawMetric each card carries, never the display-formatted metricValue).
    return c.rawMetric !== undefined && state.metricValueAtAction !== null && c.rawMetric !== state.metricValueAtAction;
  }).map(c => ({ ...c, status: stateByKey[c.insightKey] ? 'dismissed' : 'active' }));

  visible.sort((a, b) => b.priorityScore - a.priorityScore);
  return visible.slice(0, limit);
}

// rawMetric here is the same plain number a card carried when the merchant
// saw it (the frontend echoes back the `rawMetric` field from the insight it
// just dismissed/actioned) — never re-derived from a display string.
async function updateInsightStatus({ workspaceId, insightKey, status, rawMetric }) {
  if (!['dismissed', 'actioned'].includes(status)) throw new Error('Invalid status');
  const metricValueAtAction = Number.isFinite(rawMetric) ? rawMetric : null;
  return InsightState.findOneAndUpdate(
    withWorkspace({ insightKey }, workspaceId),
    { status, metricValueAtAction, workspaceId },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

module.exports = { generateInsights, updateInsightStatus, CATEGORIES };
