const router = require('express').Router();
const ops = require('../shared/operations');

router.get('/', async (req, res) => {
  try {
    const { search, isDemo, ids, page = 1, limit = 50, consent } = req.query;
    res.json(await ops.listCustomers({
      search, isDemo, ids: ids ? ids.split(',').filter(Boolean) : undefined,
      page: +page, limit: +limit, workspaceId: req.user.workspaceId,
      consent: typeof consent === 'string' ? consent : undefined, // opted_in | opted_out | not_responded
    }));
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
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

// The consent log: who opted in / out / was reinstated, through which button of which promotion, what text they were shown
// and when (see shared/operations.js#getConsentLog). Always this workspace's events only. Both stay above /:id.
//   GET /consent-log      ?status=opted_in|opted_out|not_responded &promotionId= &page= &limit=   JSON, paged
//   GET /consent-log.csv  same filters, no paging: a spreadsheet file (UTF-8 with BOM, formulas neutralised)
const consentLogQuery = (req) => ({
  workspaceId: req.user.workspaceId,
  status: typeof req.query.status === 'string' ? req.query.status : undefined,
  promotionId: typeof req.query.promotionId === 'string' ? req.query.promotionId : undefined,
});
const consentLogError = (err, res) => {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: err.message });
};

router.get('/consent-log', async (req, res) => {
  try {
    res.json(await ops.getConsentLog({ ...consentLogQuery(req), page: req.query.page, limit: req.query.limit }));
  } catch (err) {
    consentLogError(err, res);
  }
});

router.get('/consent-log.csv', async (req, res) => {
  try {
    const out = await ops.getConsentLogCsv(consentLogQuery(req));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="consent-log-${new Date().toISOString().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
      ...(out.truncated ? { 'X-Consent-Log-Truncated': 'true' } : {}),
    });
    res.send(out.csv);
  } catch (err) {
    consentLogError(err, res);
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

// One customer's consent history (newest first): every opt-in, opt-out and reinstatement with its evidence.
router.get('/:id/consent-events', async (req, res) => {
  try {
    res.json(await ops.getCustomerConsentEvents({ customerId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Customer not found' || err.name === 'CastError') return res.status(404).json({ error: 'Not found' });
    consentLogError(err, res);
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
