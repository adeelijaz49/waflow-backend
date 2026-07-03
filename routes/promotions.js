const router = require('express').Router();
const Promotion = require('../models/Promotion');
const Product   = require('../models/Product');
const Customer  = require('../models/Customer');
const Order     = require('../models/Order');
const Service   = require('../models/Service');
const { sendPromoTemplate, sendPromoAnnouncement, sendPointsPromoMessage, sendLoyaltyTemplate, sendLoyaltyReminder } = require('../utils/whatsapp');

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const promotions = await Promotion.find().populate('products', 'name basePrice images').populate('services', 'name basePrice duration').sort({ createdAt: -1 });
    res.json(promotions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const promo = await Promotion.findById(req.params.id).populate('products', 'name basePrice images category description');
    if (!promo) return res.status(404).json({ error: 'Not found' });
    res.json(promo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const promo = await Promotion.create(req.body);
    res.status(201).json(promo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const promo = await Promotion.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!promo) return res.status(404).json({ error: 'Not found' });
    res.json(promo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await Promotion.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RFM: recommended customers ──────────────────────────────────────────────

router.get('/:id/recommended-customers', async (req, res) => {
  try {
    const promotion = await Promotion.findById(req.params.id).populate('products', 'category');
    if (!promotion) return res.status(404).json({ error: 'Not found' });

    const topN = parseInt(req.query.limit) || 100;
    const targetCategories = promotion.type === 'specific_products'
      ? [...new Set(promotion.products.map(p => p.category))]
      : [];

    // Aggregate per-customer order stats
    const stats = await Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
      { $group: {
        _id: '$customer',
        orderCount:   { $sum: 1 },
        totalSpent:   { $sum: '$total' },
        lastOrderAt:  { $max: '$createdAt' },
        categories:   { $addToSet: '$items.category' },
      }},
    ]);

    // For points promotions: return all customers sorted by loyalty points
    if (promotion.customerType === 'points') {
      const all = await Customer.find().sort({ loyaltyPoints: -1 }).limit(topN).lean();
      return res.json(all.map(c => ({
        ...c,
        rfmScore: 0,
        orderCount: 0,
        totalSpent: 0,
        hasEnoughPoints: c.loyaltyPoints >= (promotion.pointsPrice || 0),
      })));
    }

    if (!stats.length) {
      const all = await Customer.find().limit(topN).lean();
      return res.json(all.map(c => ({ ...c, rfmScore: 0, orderCount: 0, totalSpent: 0 })));
    }

    const now = Date.now();
    const maxDays    = Math.max(...stats.map(s => (now - new Date(s.lastOrderAt)) / 86400000));
    const maxOrders  = Math.max(...stats.map(s => s.orderCount));
    const maxSpent   = Math.max(...stats.map(s => s.totalSpent));

    const scored = stats.map(s => {
      const daysSince = (now - new Date(s.lastOrderAt)) / 86400000;
      const recency   = 1 - daysSince / (maxDays || 1);
      const frequency = s.orderCount / (maxOrders || 1);
      const monetary  = s.totalSpent / (maxSpent || 1);

      let affinity = 0;
      if (targetCategories.length > 0 && s.categories?.length) {
        const hits = targetCategories.filter(c => s.categories.includes(c)).length;
        affinity = hits / targetCategories.length;
      }

      const rfmScore = 0.30 * recency + 0.25 * frequency + 0.30 * monetary + 0.15 * affinity;
      return { customerId: s._id, rfmScore, orderCount: s.orderCount, totalSpent: s.totalSpent };
    });

    scored.sort((a, b) => b.rfmScore - a.rfmScore);
    const topIds = scored.slice(0, topN).map(s => s.customerId);
    const scoreMap = Object.fromEntries(scored.map(s => [s.customerId.toString(), s]));

    const customers = await Customer.find({ _id: { $in: topIds } }).lean();
    const enriched = customers.map(c => ({
      ...c,
      rfmScore:   +(scoreMap[c._id.toString()]?.rfmScore  * 100).toFixed(1),
      orderCount: scoreMap[c._id.toString()]?.orderCount ?? 0,
      totalSpent: +(scoreMap[c._id.toString()]?.totalSpent ?? 0).toFixed(2),
    }));
    enriched.sort((a, b) => b.rfmScore - a.rfmScore);

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Send WhatsApp promotion ─────────────────────────────────────────────────

router.post('/:id/send', async (req, res) => {
  try {
    const { customerIds } = req.body;
    if (!customerIds?.length) return res.status(400).json({ error: 'customerIds required' });

    const promotion = await Promotion.findById(req.params.id).populate('products').populate('services');
    if (!promotion) return res.status(404).json({ error: 'Not found' });

    const customers = await Customer.find({ _id: { $in: customerIds } });
    let sentCount = 0;
    const errors = [];

    // Resolve items list for the announcement preview
    let items = [];
    if (promotion.scope === 'services') {
      items = promotion.services?.length ? promotion.services : await Service.find({ active: true }).limit(10);
    } else {
      items = promotion.products?.length ? promotion.products : await Product.find({ active: true }).limit(10);
    }

    for (const customer of customers) {
      let sent = false;
      try {
        if (promotion.customerType === 'points') {
          await sendPointsPromoMessage(customer.phone, customer, promotion, items);
        } else {
          await sendPromoAnnouncement(customer.phone, customer, promotion, items);
        }
        sent = true;
        sentCount++;
      } catch (interactiveErr) {
        console.warn(`Send failed for ${customer.phone}:`, interactiveErr.response?.data || interactiveErr.message);
      }

      // Template fallback for cash promos outside the 24h session window
      if (!sent && promotion.customerType !== 'points' && items.length && promotion.scope !== 'services') {
        try {
          await sendPromoTemplate(customer.phone, customer, items[0], promotion);
          sentCount++;
        } catch (err) {
          errors.push({ customer: customer._id, error: err.message });
          console.error(`All send methods failed ${customer.phone}:`, err.response?.data ?? err.message);
        }
      } else if (!sent) {
        errors.push({ customer: customer._id, error: 'Send failed' });
      }

      await new Promise(r => setTimeout(r, 300));
    }

    await Promotion.findByIdAndUpdate(req.params.id, {
      sentAt: new Date(),
      sentCount,
      status: 'active',
    });

    res.json({ success: true, sentCount, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Send loyalty reminders ──────────────────────────────────────────────────

router.post('/loyalty/remind', async (req, res) => {
  try {
    const { customerIds } = req.body;
    const filter = customerIds?.length ? { _id: { $in: customerIds } } : { loyaltyPoints: { $gt: 0 } };
    const customers = await Customer.find(filter);

    let sentCount = 0;
    for (const c of customers) {
      if (!c.loyaltyPoints) continue;
      try {
        await sendLoyaltyTemplate(c.phone, c.firstname, c.loyaltyPoints);
        sentCount++;
      } catch {
        try {
          await sendLoyaltyReminder(c.phone, c.firstname, c.loyaltyPoints);
          sentCount++;
        } catch (err) {
          console.error(`Loyalty remind failed ${c.phone}:`, err.message);
        }
      }
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ success: true, sentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
