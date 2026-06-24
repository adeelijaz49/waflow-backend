const router = require('express').Router();
const Customer = require('../models/Customer');
const Order = require('../models/Order');

router.get('/', async (req, res) => {
  try {
    const { search, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { firstname: { $regex: search, $options: 'i' } },
        { lastname:  { $regex: search, $options: 'i' } },
        { phone:     { $regex: search, $options: 'i' } },
      ];
    }
    const skip = (page - 1) * limit;
    const [customers, total] = await Promise.all([
      Customer.find(filter).sort({ firstname: 1 }).skip(skip).limit(+limit),
      Customer.countDocuments(filter),
    ]);

    const ids = customers.map(c => c._id);
    const stats = await Order.aggregate([
      { $match: { customer: { $in: ids } } },
      { $group: {
        _id: '$customer',
        orderCount: { $sum: 1 },
        totalSpent: { $sum: '$total' },
        lastOrder:  { $max: '$createdAt' },
      }},
    ]);
    const statsMap = Object.fromEntries(stats.map(s => [s._id.toString(), s]));

    const enriched = customers.map(c => ({
      ...c.toObject(),
      orderCount: statsMap[c._id.toString()]?.orderCount ?? 0,
      totalSpent: statsMap[c._id.toString()]?.totalSpent ?? 0,
      lastOrder:  statsMap[c._id.toString()]?.lastOrder  ?? null,
    }));

    res.json({ customers: enriched, total, page: +page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const orders = await Order.find({ customer: req.params.id }).sort({ createdAt: -1 });
    const totalSpent = orders.reduce((s, o) => s + (o.total || 0), 0);
    res.json({ ...customer.toObject(), orders, totalSpent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const customer = await Customer.create(req.body);
    res.status(201).json(customer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const customer = await Customer.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!customer) return res.status(404).json({ error: 'Not found' });
    res.json(customer);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
