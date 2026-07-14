const router = require('express').Router();
const ops = require('../shared/operations');

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    res.json(await ops.listPromotions());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getPromotion({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createPromotion(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updatePromotion({ id: req.params.id, ...req.body }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deletePromotion({ id: req.params.id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RFM: recommended customers ──────────────────────────────────────────────

router.get('/:id/recommended-customers', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(await ops.getRecommendedCustomers({ promotionId: req.params.id, limit }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send WhatsApp promotion ─────────────────────────────────────────────────

router.post('/:id/send', async (req, res) => {
  try {
    const { customerIds } = req.body;
    res.json(await ops.sendPromotion({ promotionId: req.params.id, customerIds }));
  } catch (err) {
    if (err.message === 'customerIds required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send loyalty reminders ──────────────────────────────────────────────────

router.post('/loyalty/remind', async (req, res) => {
  try {
    res.json(await ops.sendLoyaltyReminders(req.body));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
