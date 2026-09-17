const router = require('express').Router();
const inbox = require('../shared/inbox');
const ops   = require('../shared/operations'); // reuses the existing, consent-gated sendLoyaltyReminders

router.get('/conversations', async (req, res) => {
  try {
    const { filter, search } = req.query;
    res.json(await inbox.listConversations({ workspaceId: req.user.workspaceId, filter, search }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:customerId/thread', async (req, res) => {
  try {
    res.json(await inbox.getThread({ customerId: req.params.customerId, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:customerId/snapshot', async (req, res) => {
  try {
    res.json(await inbox.getSnapshot({ customerId: req.params.customerId, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/conversations/:customerId/messages', async (req, res) => {
  try {
    const saved = await inbox.sendManualMessage({
      customerId: req.params.customerId, workspaceId: req.user.workspaceId,
      body: req.body.body, performedBy: req.user.id,
    });
    res.status(201).json(saved);
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// "Send Payment Link" quick action — creates a real Stripe payment link for a
// merchant-entered amount and sends it as a manual message.
router.post('/conversations/:customerId/payment-link', async (req, res) => {
  try {
    const saved = await inbox.sendPaymentLink({
      customerId: req.params.customerId, workspaceId: req.user.workspaceId,
      amount: req.body.amount, performedBy: req.user.id,
    });
    res.status(201).json(saved);
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// "Send Loyalty Reminder" quick action — delegates to the existing, already
// consent-gated bulk operation, scoped to just this one customer.
router.post('/conversations/:customerId/loyalty-reminder', async (req, res) => {
  try {
    res.json(await ops.sendLoyaltyReminders({ customerIds: [req.params.customerId], workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
