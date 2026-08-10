const router = require('express').Router();
const multer = require('multer');
const engine = require('../shared/importEngine');
const ops = require('../shared/operations');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function countryCodeFor(workspaceId) {
  const settings = await ops.getLoyaltySettings({ workspaceId });
  return settings.defaultCountryCode;
}

// POST /api/imports — multipart: file + entityType. Parses, row-cap checks,
// auto-detects mapping, creates the job at status:'mapping'.
router.post('/', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const result = await engine.createImportJob({
        file: req.file, entityType: req.body.entityType,
        workspaceId: req.user.workspaceId, userId: req.user.id,
      });
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
});

// GET /api/imports/sample-template?entityType=customer — no job needed.
router.get('/sample-template', (req, res) => {
  try {
    const csv = engine.buildSampleCsv(req.query.entityType);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${req.query.entityType}-import-template.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await engine.getImportJob({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Import job not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/imports/:id/mapping — confirm/edit column mapping, runs validation.
router.patch('/:id/mapping', async (req, res) => {
  try {
    const defaultCountryCode = await countryCodeFor(req.user.workspaceId);
    const result = await engine.setMappingAndValidate({
      id: req.params.id, columnMapping: req.body.columnMapping,
      workspaceId: req.user.workspaceId, defaultCountryCode,
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'Import job not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// POST /api/imports/:id/run — executes the import.
router.post('/:id/run', async (req, res) => {
  try {
    const defaultCountryCode = await countryCodeFor(req.user.workspaceId);
    const result = await engine.runImport({
      id: req.params.id, workspaceId: req.user.workspaceId, defaultCountryCode,
      discrepancyResolutions: req.body.discrepancyResolutions,
    });
    res.json(result);
  } catch (err) {
    if (err.message === 'Import job not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

// GET /api/imports/:id/error-report — CSV of failed rows + reason.
router.get('/:id/error-report', async (req, res) => {
  try {
    const csv = await engine.buildErrorReportCsv({ id: req.params.id, workspaceId: req.user.workspaceId });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="import-errors.csv"');
    res.send(csv);
  } catch (err) {
    if (err.message === 'Import job not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
