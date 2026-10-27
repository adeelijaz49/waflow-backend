const router = require('express').Router();
const legalDocuments = require('../shared/legalDocuments');
const legalAcceptance = require('../shared/legalAcceptance');

router.get('/documents', (req, res) => {
  res.json(legalDocuments.listDocuments());
});

router.get('/documents/:slug', (req, res) => {
  const doc = legalDocuments.getDocument(req.params.slug, req.query.version);
  if (!doc) return res.status(404).json({ error: 'Not found' });
  res.json(doc);
});

// A super admin 'entering' a customer (req.user.actAs) is WaFlow staff, not that customer: nothing is required of the
// session, and it must never be able to accept the customer's Data Processing Agreement or terms on their behalf.
const refuseActAs = (req, res, next) => (req.user && req.user.actAs
  ? res.status(403).json({ error: 'WaFlow staff cannot accept legal documents on behalf of a customer' })
  : next());

router.get('/acceptance-status', async (req, res) => {
  try {
    res.json(await legalAcceptance.getAcceptanceStatus({
      userId: req.user.id, workspaceId: req.user.workspaceId, role: req.user.role, actAs: !!req.user.actAs,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accept/combined', refuseActAs, async (req, res) => {
  try {
    res.json(await legalAcceptance.recordCombinedAcceptance({
      userId: req.user.id, workspaceId: req.user.workspaceId, role: req.user.role,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/accept/dpa', refuseActAs, async (req, res) => {
  try {
    res.json(await legalAcceptance.recordDpaAcceptance({
      userId: req.user.id, workspaceId: req.user.workspaceId, role: req.user.role,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    }));
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

module.exports = router;
