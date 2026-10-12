'use strict';
// Read-only, workspace-scoped lookups used to build the confirmation card
// (summaries.js: the NAME behind a promotion / flow id, who the customers are,
// what an order is worth) and the per-user / per-workspace settings the agent
// needs (reply-language preference, merchant name). Nothing here writes.
//
// Shape contract used by summaries.resolveReferences: a lookup resolves to an
// object when the record exists IN THIS WORKSPACE, to null when it does not, and
// may reject when the database is unavailable (the card then falls back to the
// raw id instead of failing the turn). Ids reaching these functions were already
// validated as 24-hex ids by the tool bridge; workspaceId comes from the token.
//
// Models are injectable so the tests need no database; the default requires them
// lazily.
function fullName(doc) {
  return `${(doc && doc.firstname) || ''} ${(doc && doc.lastname) || ''}`.trim();
}

function createModelLookups({ models, getCurrency } = {}) {
  let loaded = models || null;
  const M = () => loaded || (loaded = {
    Promotion: require('../../../models/Promotion'),
    Flow: require('../../../models/Flow'),
    Order: require('../../../models/Order'),
    Customer: require('../../../models/Customer'),
  });
  const currency = async () => {
    try {
      return await (getCurrency || require('../../../utils/settingsCache').getCurrency)();
    } catch {
      return undefined;
    }
  };

  return {
    async promotion(workspaceId, id) {
      const p = await M().Promotion.findOne({ _id: id, workspaceId }).select('name isDemo').lean();
      return p ? { name: p.name, isDemo: !!p.isDemo } : null;
    },

    async flow(workspaceId, id) {
      const f = await M().Flow.findOne({ _id: id, workspaceId }).select('name status').lean();
      return f ? { name: f.name, status: f.status } : null;
    },

    async order(workspaceId, id) {
      const o = await M().Order.findOne({ _id: id, workspaceId })
        .select('total paymentStatus stripePaymentIntentId customer')
        .populate('customer', 'firstname lastname')
        .lean();
      if (!o) return null;
      return {
        total: o.total,
        currency: await currency(),
        paymentStatus: o.paymentStatus,
        hasStripePayment: !!o.stripePaymentIntentId,
        customerName: fullName(o.customer),
      };
    },

    // How many of these ids are customers of this workspace, plus up to three
    // names to show on the card.
    async customers(workspaceId, ids) {
      const filter = { _id: { $in: ids }, workspaceId };
      const [found, sample] = await Promise.all([
        M().Customer.countDocuments(filter),
        M().Customer.find(filter).select('firstname lastname').limit(3).lean(),
      ]);
      return { found, names: sample.map(fullName).filter(Boolean) };
    },

    // Upper bound for "remind everyone with points": the same filter the existing
    // sender uses (shared/operations.js sendLoyaltyReminders), before its consent gate.
    async loyaltyAudience(workspaceId) {
      return M().Customer.countDocuments({ workspaceId, loyaltyPoints: { $gt: 0 } });
    },
  };
}

// Per-user language preference (UserLocalePreference) and the merchant name
// (Settings.merchantName, which the English AI Mode greets the merchant with).
function createSettingsProvider({ models } = {}) {
  let loaded = models || null;
  const M = () => loaded || (loaded = {
    UserLocalePreference: require('../../../models/UserLocalePreference'),
    Settings: require('../../../models/Settings'),
  });

  return {
    async getUserPrefs(workspaceId, userId) {
      const defaults = { aiLanguage: 'auto', uiLanguage: 'en' };
      if (!workspaceId || !userId) return defaults;
      const doc = await M().UserLocalePreference.findOne({ workspaceId, userId }).select('aiLanguage uiLanguage').lean();
      return { aiLanguage: (doc && doc.aiLanguage) || defaults.aiLanguage, uiLanguage: (doc && doc.uiLanguage) || defaults.uiLanguage };
    },

    async getMerchantName(workspaceId) {
      if (!workspaceId) return '';
      const doc = await M().Settings.findOne({ workspaceId }).select('merchantName').lean();
      return (doc && doc.merchantName) || '';
    },
  };
}

module.exports = { createModelLookups, createSettingsProvider };
