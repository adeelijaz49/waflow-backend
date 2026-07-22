const router = require('express').Router();
const ops = require('../shared/operations');

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createMessageNode(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getMessageNode({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'MessageNode not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updateMessageNode({ id: req.params.id, ...req.body }));
  } catch (err) {
    if (err.message === 'MessageNode not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deleteMessageNode({ id: req.params.id }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/submit-template', async (req, res) => {
  try {
    res.json(await ops.submitMessageNodeTemplate({ nodeId: req.params.id }));
  } catch (err) {
    res.status(400).json({ error: err.response?.data ?? err.message });
  }
});

router.post('/:id/refresh-status', async (req, res) => {
  try {
    res.json(await ops.refreshMessageNodeTemplateStatus({ nodeId: req.params.id }));
  } catch (err) {
    res.status(400).json({ error: err.response?.data ?? err.message });
  }
});

module.exports = router;
