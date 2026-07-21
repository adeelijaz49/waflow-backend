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
    const promoName   = wa.PROMO_TEMPLATE;
    const loyaltyName = wa.LOYALTY_TEMPLATE;
    const winbackName = wa.WINBACK_TEMPLATE;
    const annotated   = templates.map(t => ({
      ...t,
      waflowRole: t.name === promoName ? 'promo' : t.name === loyaltyName ? 'loyalty' : t.name === winbackName ? 'winback' : null,
    }));
    res.json({ templates: annotated, promoTemplate: promoName, loyaltyTemplate: loyaltyName, winbackTemplate: winbackName });
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
