const router = require('express').Router();
const ops = require('../shared/operations');

router.get('/', async (req, res) => {
  try {
    const { status, source, page = 1, limit = 50 } = req.query;
    res.json(await ops.listOrders({ status, source, page: +page, limit: +limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    res.json(await ops.getOrderStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getOrder({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', async (req, res) => {
  try {
    res.json(await ops.updateOrderStatus({ id: req.params.id, status: req.body.status }));
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/refund', async (req, res) => {
  try {
    res.json(await ops.refundOrder({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Order not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
