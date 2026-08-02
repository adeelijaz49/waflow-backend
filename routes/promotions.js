const router = require('express').Router();
const ops = require('../shared/operations');

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    res.json(await ops.listPromotions({ isDemo: req.query.isDemo, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registered before /:id so "message-variables" isn't swallowed as a promotion id.
router.get('/message-variables', (req, res) => {
  res.json(ops.getPromotionMessageVariables());
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getPromotion({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createPromotion({ ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updatePromotion({ id: req.params.id, ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deletePromotion({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RFM: recommended customers ──────────────────────────────────────────────

router.get('/:id/recommended-customers', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(await ops.getRecommendedCustomers({ promotionId: req.params.id, limit, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign report (sent/delivered/read/clicked/orders/revenue/points) ─────

router.get('/:id/report', async (req, res) => {
  try {
    res.json(await ops.getCampaignReport({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Message preview + test send ─────────────────────────────────────────────

router.get('/:id/preview', async (req, res) => {
  try {
    res.json(await ops.previewPromotionMessage({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/test-send', async (req, res) => {
  try {
    res.json(await ops.sendTestMessage({ promotionId: req.params.id, phone: req.body.phone, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'phone required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send WhatsApp promotion ─────────────────────────────────────────────────

router.post('/:id/send', async (req, res) => {
  try {
    const { customerIds } = req.body;
    // allowRealDemoSend is intentionally NOT read from req.body here — it must
    // never be client-controlled on this route. isDemo promotions/customers
    // always simulate through this endpoint; see /:id/send-live-demo below.
    res.json(await ops.sendPromotion({ promotionId: req.params.id, customerIds, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'customerIds required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Distinct, deliberately-named route for the dedicated /demo sales-presentation
// page only — a real send to a real (isDemo:true) phone the presenter controls,
// gated by that page's own explicit "this is not a simulation" confirmation.
// Never referenced by the regular Promotions screen, MCP, or GPT Actions.
router.post('/:id/send-live-demo', async (req, res) => {
  try {
    const { customerIds } = req.body;
    res.json(await ops.sendPromotion({ promotionId: req.params.id, customerIds, allowRealDemoSend: true, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'customerIds required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send loyalty reminders ──────────────────────────────────────────────────

router.post('/loyalty/remind', async (req, res) => {
  try {
    res.json(await ops.sendLoyaltyReminders({ ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
