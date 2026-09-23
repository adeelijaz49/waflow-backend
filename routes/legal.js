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

router.get('/acceptance-status', async (req, res) => {
  try {
    res.json(await legalAcceptance.getAcceptanceStatus({
      userId: req.user.id, workspaceId: req.user.workspaceId, role: req.user.role,
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/accept/combined', async (req, res) => {
  try {
    res.json(await legalAcceptance.recordCombinedAcceptance({
      userId: req.user.id, workspaceId: req.user.workspaceId, role: req.user.role,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/accept/dpa', async (req, res) => {
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
