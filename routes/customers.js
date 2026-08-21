const router = require('express').Router();
const ops = require('../shared/operations');

router.get('/', async (req, res) => {
  try {
    const { search, isDemo, page = 1, limit = 50 } = req.query;
    res.json(await ops.listCustomers({ search, isDemo, page: +page, limit: +limit, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Must stay above /:id — otherwise Express would match "consent-stats" as an id.
router.get('/consent-stats', async (req, res) => {
  try {
    res.json(await ops.getConsentStats({ workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getCustomer({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/whatsapp-history', async (req, res) => {
  try {
    res.json(await ops.getCustomerWhatsAppHistory({ customerId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/bookings', async (req, res) => {
  try {
    res.json(await ops.listBookings({ customerId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createCustomer({ ...req.body, workspaceId: req.user.workspaceId, performedBy: req.user.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updateCustomer({ id: req.params.id, ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// Manual "mark as consented" — the only dashboard path to grant an EXISTING
// customer's marketing consent directly. See shared/operations.js#markCustomerConsented.
router.post('/:id/consent', async (req, res) => {
  try {
    res.json(await ops.markCustomerConsented({ id: req.params.id, workspaceId: req.user.workspaceId, performedBy: req.user.id }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// Bulk "ask for consent" campaign — see shared/operations.js#sendConsentRequests.
// Optional customerIds narrows to a specific selection; omitted sends to every
// not-yet-asked customer in the workspace.
router.post('/consent-requests', async (req, res) => {
  try {
    res.json(await ops.sendConsentRequests({ workspaceId: req.user.workspaceId, customerIds: req.body.customerIds }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
