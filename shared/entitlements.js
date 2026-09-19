// Core of the WhatsApp Inbox's sibling feature — merchant entitlements,
// billing cycles and usage. A workspace's *effective* limit for any
// dimension is: Plan.entitlements[key], overridden by
// Subscription.overrides[key] when set, plus the summed quantity of every
// currently-active AddOn of that type. "Used" is either a live count
// (locations/whatsappAccounts/users/customerProfiles) or a sum over the
// current BillingPeriod's UsageEvent rows (aiPromptsPerCycle,
// whatsappCreditPerCycle) — see getUsageSummary.
//
// New, standalone module — nothing here is wired into any existing route or
// send/create flow yet. middleware/requireEntitlement.js is ready to apply
// to an endpoint; shared/usageLedger.js, shared/creditReservation.js and
// shared/aiPromptMetering.js are ready to be called from the real
// campaign-send / AI Mode code paths. That wiring is a deliberately separate
// follow-up (see the PR description) so this pass touches no existing files
// beyond two route-mount lines in server.js.

const mongoose = require('mongoose');

const Plan          = require('../models/Plan');
const Subscription  = require('../models/Subscription');
const BillingPeriod = require('../models/BillingPeriod');
const UsageEvent    = require('../models/UsageEvent');
const AddOn         = require('../models/AddOn');
const Customer      = require('../models/Customer');
const Membership    = require('../models/Membership');
const { getCurrency } = require('../utils/settingsCache');

const ENTITLEMENT_KEYS = ['locations', 'whatsappAccounts', 'users', 'customerProfiles', 'aiPromptsPerCycle', 'whatsappCreditPerCycle'];

const LABELS = {
  locations: 'Locations',
  whatsappAccounts: 'WhatsApp Business Accounts',
  users: 'Platform Users',
  customerProfiles: 'Customer Profiles',
  aiPromptsPerCycle: 'AI Mode Prompts',
  whatsappCreditPerCycle: 'WhatsApp Messaging Credit',
};

// Maps an entitlement dimension to the UsageEvent.usageType it's metered
// against, for the two "per cycle" dimensions — the four "durable" ones are
// live counts, not ledger sums (see getUsageSummary).
const USAGE_TYPE_FOR = { aiPromptsPerCycle: 'ai_prompt', whatsappCreditPerCycle: 'whatsapp_message' };

// The two dimensions overageBillingEnabled is allowed to bypass — a per-cycle
// consumable running over is a billing event (charge more / true up next
// invoice), not a structural breach. The four durable counts (locations,
// whatsappAccounts, users, customerProfiles) must never be bypassable this
// way — see checkEntitlement.
const OVERAGE_ELIGIBLE_KEYS = ['aiPromptsPerCycle', 'whatsappCreditPerCycle'];

const DEFAULT_PLAN_CODE = 'starter';
const DEFAULT_PLANS = [
  { code: 'starter', name: 'Starter', description: 'For a single merchant getting started with WhatsApp commerce.',
    entitlements: { locations: 1, whatsappAccounts: 1, users: 2, customerProfiles: 500, aiPromptsPerCycle: 100, whatsappCreditPerCycle: 10 }, priceMonthly: 0 },
  { code: 'growth', name: 'Growth', description: 'For a growing merchant running regular campaigns.',
    entitlements: { locations: 3, whatsappAccounts: 1, users: 5, customerProfiles: 5000, aiPromptsPerCycle: 500, whatsappCreditPerCycle: 50 }, priceMonthly: 99 },
  { code: 'pro', name: 'Pro', description: 'For a multi-location merchant with a bigger team.',
    entitlements: { locations: 10, whatsappAccounts: 3, users: 15, customerProfiles: 25000, aiPromptsPerCycle: 2000, whatsappCreditPerCycle: 200 }, priceMonthly: 299 },
];

function toId(id) {
  return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;
}

// True if every failure in a (possibly bulk) write error is a duplicate-key
// (E11000) — i.e. "a concurrent call already inserted this exact row", which
// is fine to swallow, versus a real failure that must propagate. Same helper
// as shared/whatsappRateCard.js's — small enough not to warrant a shared
// util module for two call sites.
function isPureDuplicateKeyError(err) {
  if (err.code === 11000) return true;
  if (Array.isArray(err.writeErrors) && err.writeErrors.length) {
    return err.writeErrors.every(e => (e.code ?? e.err?.code) === 11000);
  }
  return false;
}

// Lazily seeds the default plan catalog exactly once — safe to call on
// every cold path that needs a Plan to exist (getOrCreateSubscription),
// since it no-ops once any Plan document exists. unordered + swallowing a
// pure duplicate-key error means two concurrent first-ever callers (e.g. two
// requests racing on a freshly-deployed empty database) both succeed instead
// of one 500ing on Plan.code's unique index.
async function ensureDefaultPlans() {
  const existing = await Plan.countDocuments();
  if (existing > 0) return;
  try {
    await Plan.insertMany(DEFAULT_PLANS, { ordered: false });
  } catch (err) {
    if (!isPureDuplicateKeyError(err)) throw err;
  }
}

// Every workspace gets a Subscription the first time its entitlements are
// resolved — defaulting to the Starter plan, manual billing, anchored today.
// This means a brand-new workspace "just works" with no separate billing
// setup step, matching how Settings/loyalty defaults already lazily apply
// today (see models/Settings.js).
async function getOrCreateSubscription(workspaceId) {
  let sub = await Subscription.findOne({ workspaceId });
  if (sub) return sub;

  await ensureDefaultPlans();
  const plan = await Plan.findOne({ code: DEFAULT_PLAN_CODE });
  try {
    sub = await Subscription.create({ workspaceId, planId: plan._id, cycleAnchorDate: new Date() });
  } catch (err) {
    // Unique-index race — a concurrent request created it first.
    if (err.code === 11000) return Subscription.findOne({ workspaceId });
    throw err;
  }
  return sub;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

// Monthly cycle anchored to Subscription.cycleAnchorDate. Known limitation:
// an anchor on the 29th-31st can shift on shorter months (JS Date's own
// month-overflow rollover) — acceptable for a first version; a calendar
// library would be the real fix if this becomes a support complaint.
function computeManualPeriod(anchor, now) {
  let start = new Date(anchor);
  while (addMonths(start, 1) <= now) start = addMonths(start, 1);
  while (start > now) start = addMonths(start, -1);
  return { periodStart: start, periodEnd: addMonths(start, 1) };
}

// Resolves (and lazily creates) the BillingPeriod containing `now` for this
// workspace. Pass `subscription` when the caller already has it loaded, to
// avoid a redundant lookup.
async function resolveCurrentBillingPeriod(workspaceId, { subscription } = {}) {
  const sub = subscription || await getOrCreateSubscription(workspaceId);
  const now = new Date();

  if (sub.billingProvider === 'stripe' && sub.currentPeriodStart && sub.currentPeriodEnd) {
    let period = await BillingPeriod.findOne({ workspaceId, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd });
    if (!period) period = await BillingPeriod.create({ workspaceId, subscriptionId: sub._id, periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, source: 'stripe' });
    return period;
  }

  const { periodStart, periodEnd } = computeManualPeriod(sub.cycleAnchorDate, now);
  let period = await BillingPeriod.findOne({ workspaceId, periodStart });
  if (!period) {
    try {
      period = await BillingPeriod.create({ workspaceId, subscriptionId: sub._id, periodStart, periodEnd, source: 'manual' });
    } catch (err) {
      if (err.code !== 11000) throw err;
      period = await BillingPeriod.findOne({ workspaceId, periodStart });
    }
  }
  return period;
}

// Effective limits for every dimension: Plan default, overridden by
// Subscription.overrides when set, plus active AddOn quantities of that type.
async function resolveEntitlements(workspaceId) {
  const subscription = await getOrCreateSubscription(workspaceId);
  const plan = await Plan.findById(subscription.planId);
  // Defensive, not just theoretical — routes/adminEntitlements.js's plan-change
  // form sets Subscription.planId from a raw request field with no existence
  // check of its own; a dangling id must fail clearly here rather than crash
  // every subsequent entitlements call with a bare null-dereference.
  if (!plan) throw new Error(`Subscription references a Plan that no longer exists (planId: ${subscription.planId})`);
  const now = new Date();
  const activeAddOns = await AddOn.find({
    workspaceId,
    status: 'active',
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }],
  });

  const limits = {};
  for (const key of ENTITLEMENT_KEYS) {
    const base = subscription.overrides?.[key] ?? plan.entitlements[key];
    const addOnTotal = activeAddOns.filter(a => a.type === key).reduce((sum, a) => sum + a.quantity, 0);
    limits[key] = base + addOnTotal;
  }

  return { plan, subscription, limits, activeAddOns };
}

function computeWarningLevel(used, limit) {
  if (limit <= 0) return used > 0 ? 'exceeded' : null;
  const ratio = used / limit;
  if (ratio >= 1) return 'exceeded';
  if (ratio >= 0.9) return 'warn90';
  if (ratio >= 0.75) return 'warn75';
  return null;
}

// The full picture behind the merchant Usage & Limits page and the admin
// billing tool: plan, subscription state, current billing period, and a
// used/limit/remaining/warningLevel row for each of the 6 dimensions.
async function getUsageSummary(workspaceId) {
  const { plan, subscription, limits } = await resolveEntitlements(workspaceId);
  const period = await resolveCurrentBillingPeriod(workspaceId, { subscription });
  const currency = await getCurrency();
  const wid = toId(workspaceId);

  const [userCount, customerCount, aiPromptAgg, waMessageAgg, addOns] = await Promise.all([
    Membership.countDocuments({ workspaceId }),
    Customer.countDocuments({ workspaceId, deletedAt: { $exists: false } }),
    UsageEvent.aggregate([
      { $match: { workspaceId: wid, billingPeriodId: period._id, usageType: 'ai_prompt' } },
      { $group: { _id: null, qty: { $sum: '$quantity' } } },
    ]),
    UsageEvent.aggregate([
      { $match: { workspaceId: wid, billingPeriodId: period._id, usageType: 'whatsapp_message' } },
      { $group: { _id: null, charge: { $sum: '$customerCharge' } } },
    ]),
    AddOn.find({ workspaceId }).sort({ createdAt: -1 }).lean(),
  ]);

  // locations/whatsappAccounts: no multi-location or multi-WABA data model
  // exists in this app yet (Workspace.whatsapp is a single embedded config)
  // — every workspace is exactly one of each today, so usage is a static 1
  // until a real feature exists to count against. Tracked as a real
  // entitlement dimension now so the limit/warning machinery is already in
  // place for when that feature ships.
  const usedByType = {
    locations: 1,
    whatsappAccounts: 1,
    users: userCount,
    customerProfiles: customerCount,
    aiPromptsPerCycle: aiPromptAgg[0]?.qty || 0,
    whatsappCreditPerCycle: waMessageAgg[0]?.charge || 0,
  };

  const usage = ENTITLEMENT_KEYS.map((type) => {
    const used = usedByType[type];
    const limit = limits[type];
    const percentUsed = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : (used > 0 ? 100 : 0);
    return {
      type,
      label: LABELS[type],
      kind: type === 'whatsappCreditPerCycle' ? 'cycle_currency' : (type === 'aiPromptsPerCycle' ? 'cycle' : 'durable'),
      used, limit,
      remaining: Math.max(0, limit - used),
      percentUsed,
      warningLevel: computeWarningLevel(used, limit),
      // Explicit null (not undefined) for non-currency rows — undefined keys
      // are dropped by JSON.stringify, which would silently disagree with
      // the frontend's non-optional `currency: string | null` field.
      currency: type === 'whatsappCreditPerCycle' ? currency : null,
    };
  });

  return {
    plan: { code: plan.code, name: plan.name, isCustom: plan.isCustom },
    subscription: {
      status: subscription.status, billingProvider: subscription.billingProvider,
      overageBillingEnabled: subscription.overageBillingEnabled, cycleAnchorDate: subscription.cycleAnchorDate,
    },
    billingPeriod: {
      start: period.periodStart, end: period.periodEnd,
      daysRemaining: Math.max(0, Math.ceil((period.periodEnd.getTime() - Date.now()) / 86400000)),
    },
    currency,
    usage,
    addOns,
  };
}

// Enforcement check for one dimension — used by middleware/requireEntitlement.js
// and directly by shared/creditReservation.js / shared/aiPromptMetering.js.
// `entitlementKey` is one of ENTITLEMENT_KEYS (a limit dimension), not a raw
// UsageEvent.usageType.
async function checkEntitlement(workspaceId, entitlementKey, quantity = 1) {
  if (!ENTITLEMENT_KEYS.includes(entitlementKey)) throw new Error(`Unknown entitlement key: ${entitlementKey}`);
  const summary = await getUsageSummary(workspaceId);
  const row = summary.usage.find(u => u.type === entitlementKey);
  const wouldBeUsed = row.used + quantity;
  const overageApplies = summary.subscription.overageBillingEnabled && OVERAGE_ELIGIBLE_KEYS.includes(entitlementKey);
  const allowed = wouldBeUsed <= row.limit || overageApplies;
  return {
    allowed, used: row.used, limit: row.limit, remaining: row.remaining,
    warningLevel: row.warningLevel, overageBillingEnabled: summary.subscription.overageBillingEnabled,
  };
}

module.exports = {
  ENTITLEMENT_KEYS, LABELS, USAGE_TYPE_FOR, DEFAULT_PLAN_CODE, OVERAGE_ELIGIBLE_KEYS,
  ensureDefaultPlans, getOrCreateSubscription, resolveCurrentBillingPeriod,
  resolveEntitlements, getUsageSummary, checkEntitlement, computeWarningLevel,
  toId,
};
