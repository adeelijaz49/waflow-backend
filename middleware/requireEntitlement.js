// Express middleware factory enforcing one entitlement dimension before a
// route handler runs. Not yet applied to any existing route (see
// shared/entitlements.js's header comment) — ready to drop onto a
// create/send endpoint as `requireEntitlement('users')` or
// `requireEntitlement('customerProfiles', { getQuantity: req => req.body.rows?.length || 1 })`.
const { checkEntitlement, LABELS } = require('../shared/entitlements');

function requireEntitlement(entitlementKey, opts = {}) {
  const { quantity = 1, getQuantity } = opts;

  return async function (req, res, next) {
    try {
      const qty = getQuantity ? getQuantity(req) : quantity;
      const check = await checkEntitlement(req.user.workspaceId, entitlementKey, qty);

      if (!check.allowed) {
        return res.status(402).json({
          error: `${LABELS[entitlementKey] || entitlementKey} limit reached (${check.used}/${check.limit}).`,
          code: 'ENTITLEMENT_EXCEEDED',
          usageType: entitlementKey,
          used: check.used, limit: check.limit, remaining: check.remaining,
        });
      }

      req.entitlementCheck = check;
      next();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

module.exports = { requireEntitlement };
