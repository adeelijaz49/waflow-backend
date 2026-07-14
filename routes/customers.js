const router = require('express').Router();
const ops = require('../shared/operations');

router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    res.json(await ops.listCustomers({ search, page: +page, limit: +limit }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getCustomer({ id: req.params.id }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createCustomer(req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updateCustomer({ id: req.params.id, ...req.body }));
  } catch (err) {
    if (err.message === 'Customer not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
