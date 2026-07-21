const router       = require('express').Router();
const tokenManager = require('../utils/tokenManager');
const wa           = require('../utils/whatsapp');

// ── Token ─────────────────────────────────────────────────────────────────────

router.get('/token-status', (req, res) => {
  res.json(tokenManager.getStatus());
});

router.post('/refresh-token', async (req, res) => {
  try {
    const status = await tokenManager.refresh();
    res.json({ success: true, status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const templates = await wa.listTemplates();
    // Annotate which ones Waflow uses
    const roleByName = {
      [wa.PROMO_TEMPLATE]: 'promo',
      [wa.LOYALTY_TEMPLATE]: 'loyalty',
      [wa.WINBACK_TEMPLATE]: 'winback',
      [wa.POST_PURCHASE_TEMPLATE]: 'post_purchase',
      [wa.POINTS_NUDGE_TEMPLATE]: 'points_nudge',
      [wa.NO_SHOW_TEMPLATE]: 'no_show',
    };
    const annotated = templates.map(t => ({ ...t, waflowRole: roleByName[t.name] || null }));
    res.json({
      templates: annotated,
      promoTemplate: wa.PROMO_TEMPLATE,
      loyaltyTemplate: wa.LOYALTY_TEMPLATE,
      winbackTemplate: wa.WINBACK_TEMPLATE,
      postPurchaseTemplate: wa.POST_PURCHASE_TEMPLATE,
      pointsNudgeTemplate: wa.POINTS_NUDGE_TEMPLATE,
      noShowTemplate: wa.NO_SHOW_TEMPLATE,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-promo-template', async (req, res) => {
  try {
    const result = await wa.createPromoTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-loyalty-template', async (req, res) => {
  try {
    const result = await wa.createLoyaltyTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-winback-template', async (req, res) => {
  try {
    const result = await wa.createWinbackTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-post-purchase-template', async (req, res) => {
  try {
    const result = await wa.createPostPurchaseTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-points-nudge-template', async (req, res) => {
  try {
    const result = await wa.createPointsNudgeTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/create-no-show-template', async (req, res) => {
  try {
    const result = await wa.createNoShowTemplate();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

// Delete a template by name (needed to recreate with updated structure)
router.delete('/templates/:name', async (req, res) => {
  try {
    const result = await wa.deleteTemplate(req.params.name);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.response?.data ?? err.message });
  }
});

module.exports = router;
