// Merchant-facing entitlements/usage API — powers the Usage & Limits
// settings page and (once wired into the real send flow) the campaign
// cost-estimate step. Mounted at /api/entitlements under the existing
// requireAuth JWT middleware, same as every other dashboard route.
const router = require('express').Router();
const entitlements = require('../shared/entitlements');
const usageLedger  = require('../shared/usageLedger');
const creditReservation = require('../shared/creditReservation');

router.get('/summary', async (req, res) => {
  try {
    res.json(await entitlements.getUsageSummary(req.user.workspaceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/usage-events', async (req, res) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    res.json(await usageLedger.listUsageEvents({ workspaceId: req.user.workspaceId, usageType: type, page: +page, limit: +limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cost estimate for a bulk send — must be shown and confirmed before any
// campaign actually sends (see shared/creditReservation.js).
router.post('/campaigns/estimate', async (req, res) => {
  try {
    const { recipientCount, countryCode, category } = req.body;
    res.json(await creditReservation.estimateCampaignCost({ workspaceId: req.user.workspaceId, recipientCount, countryCode, category }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Reserves the estimated credit for a bulk send once the merchant confirms.
// 402 (not 500) on insufficient credit — a normal, expected outcome the
// frontend should handle inline, not an error state.
router.post('/campaigns/reserve', async (req, res) => {
  try {
    const { recipientCount, countryCode, category, campaignId } = req.body;
    const reservation = await creditReservation.reserveCredit({ workspaceId: req.user.workspaceId, recipientCount, countryCode, category, campaignId });
    res.status(201).json(reservation);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDIT') return res.status(402).json({ error: err.message, code: err.code, ...err.details });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
