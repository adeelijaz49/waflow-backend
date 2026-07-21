const router = require('express').Router();
const ops = require('../shared/operations');

router.get('/', async (req, res) => {
  try {
    res.json(await ops.listFlows({ status: req.query.status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getFlow({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Flow not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createFlow(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updateFlow({ id: req.params.id, ...req.body }));
  } catch (err) {
    if (err.message === 'Flow not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deleteFlow({ id: req.params.id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/activate', async (req, res) => {
  try {
    res.json(await ops.activateFlow({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Flow not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/pause', async (req, res) => {
  try {
    res.json(await ops.pauseFlow({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Flow not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/enrollments', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    res.json(await ops.listFlowEnrollments({ flowId: req.params.id, page: +page, limit: +limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/report', async (req, res) => {
  try {
    res.json(await ops.getFlowReport({ flowId: req.params.id }));
  } catch (err) {
    if (err.message === 'Flow not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
