const router = require('express').Router();
const Order = require('../models/Order');

router.get('/', async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate('customer', 'firstname lastname phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(+limit),
      Order.countDocuments(filter),
    ]);
    res.json({ orders, total, page: +page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [totalOrders, totalCustomers, recentRevenue, statusBreakdown, recentOrders] = await Promise.all([
      Order.countDocuments(),
      require('../models/Customer').countDocuments(),
      Order.aggregate([
        { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
        { $group: { _id: null, revenue: { $sum: '$total' } } },
      ]),
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.find().populate('customer', 'firstname lastname').sort({ createdAt: -1 }).limit(10),
    ]);
    res.json({
      totalOrders,
      totalCustomers,
      recentRevenue: recentRevenue[0]?.revenue ?? 0,
      statusBreakdown,
      recentOrders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customer', 'firstname lastname phone loyaltyPoints');
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/status', async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(order);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
