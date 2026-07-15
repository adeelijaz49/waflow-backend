// Core business operations shared by both integration surfaces:
//   - mcp/tools.js   (MCP protocol, used by Claude)
//   - gpt/routes.js  (plain REST + OpenAPI, used by ChatGPT Custom GPT Actions)
// Keeping the logic here once means a fix/change applies to both surfaces automatically.

const Stripe = require('stripe');

const Product   = require('../models/Product');
const Service    = require('../models/Service');
const Customer   = require('../models/Customer');
const Order      = require('../models/Order');
const Promotion  = require('../models/Promotion');
const Settings   = require('../models/Settings');
const TimeSlot   = require('../models/TimeSlot');
const Booking    = require('../models/Booking');
const CampaignMessage = require('../models/CampaignMessage');
const {
  sendPromoAnnouncement, sendPointsPromoMessage, sendPromoTemplate,
  sendLoyaltyTemplate, sendLoyaltyReminder, sendRebookMessage, waPost,
  PROMO_TEMPLATE, LOYALTY_TEMPLATE,
  buildPromoAnnouncementPayload, buildPointsPromoPayload,
} = require('../utils/whatsapp');
const { carts } = require('../utils/state');
const { APP_URL } = require('../utils/config');
const { money } = require('../utils/currency');
const settingsCache = require('../utils/settingsCache');
const { getCurrency } = settingsCache;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SHIPPING_COST = 0.5; // flat rate, matches server.js's WhatsApp checkout flow

function wamidOf(sendResult) {
  return sendResult?.messages?.[0]?.id;
}

// ─── Products ────────────────────────────────────────────────────────────────

async function listProducts({ search, category, page = 1, limit = 50 } = {}) {
  const filter = { active: true };
  if (search) filter.name = { $regex: search, $options: 'i' };
  if (category) filter.category = category;
  const skip = (page - 1) * limit;
  const [products, total] = await Promise.all([
    Product.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);
  return { products, total, page, pages: Math.ceil(total / limit) };
}

async function getProduct({ id }) {
  const product = await Product.findById(id);
  if (!product) throw new Error('Product not found');
  return product;
}

async function createProduct(data) {
  return Product.create(data);
}

async function updateProduct({ id, ...data }) {
  const product = await Product.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!product) throw new Error('Product not found');
  return product;
}

async function deactivateProduct({ id }) {
  await Product.findByIdAndUpdate(id, { active: false });
  return { success: true };
}

// ─── Services ────────────────────────────────────────────────────────────────

async function listServices() {
  return Service.find({ active: true }).sort({ name: 1 });
}

async function getService({ id }) {
  const service = await Service.findById(id);
  if (!service) throw new Error('Service not found');
  const slots = await TimeSlot.find({ serviceId: id }).sort({ date: 1, startTime: 1 });
  const bookings = await Booking.find({ serviceId: id }).sort({ createdAt: -1 }).populate('customerId', 'firstname lastname phone');
  return { service, slots, bookings };
}

async function createService(data) {
  return Service.create(data);
}

async function updateService({ id, ...data }) {
  const service = await Service.findByIdAndUpdate(id, data, { new: true });
  if (!service) throw new Error('Service not found');
  return service;
}

async function deactivateService({ id }) {
  await Service.findByIdAndUpdate(id, { active: false });
  return { success: true };
}

async function createTimeSlot({ serviceId, ...data }) {
  return TimeSlot.create({ ...data, serviceId });
}

async function listBookings({ serviceId } = {}) {
  const filter = serviceId ? { serviceId } : {};
  return Booking.find(filter).sort({ createdAt: -1 }).limit(200)
    .populate('serviceId', 'name category')
    .populate('customerId', 'firstname lastname phone');
}

async function cancelBooking({ bookingId }) {
  const booking = await Booking.findById(bookingId).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  if (booking.status === 'cancelled') throw new Error('Already cancelled');
  booking.status = 'cancelled';
  await booking.save();
  await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
  try {
    const result = await sendRebookMessage(
      booking.phone, booking.customerName || 'Valued Customer',
      booking.serviceId?.name || 'your service', booking.slotId,
      booking.serviceId?._id?.toString(), booking._id.toString(),
    );
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'interactive', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — booking is already cancelled either way */ }
  return { success: true };
}

async function rescheduleBooking({ bookingId, newSlotId }) {
  const booking = await Booking.findById(bookingId).populate('serviceId').populate('slotId');
  if (!booking) throw new Error('Booking not found');
  const newSlot = await TimeSlot.findById(newSlotId);
  if (!newSlot) throw new Error('New slot not found');
  if (newSlot.bookedCount >= newSlot.capacity) throw new Error('Slot is full');
  await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
  await TimeSlot.findByIdAndUpdate(newSlotId, { $inc: { bookedCount: 1 } });
  booking.slotId = newSlotId;
  booking.status = 'confirmed';
  await booking.save();
  try {
    const result = await waPost({
      messaging_product: 'whatsapp', to: booking.phone, type: 'text',
      text: { body: `📅 Your booking for *${booking.serviceId?.name}* has been rescheduled to *${newSlot.date} at ${newSlot.startTime}*. See you then! 🎉` },
    });
    if (booking.customerId) {
      await CampaignMessage.create({
        kind: 'booking_notification', booking: booking._id, customer: booking.customerId, phone: booking.phone,
        wamid: wamidOf(result), messageType: 'text', status: 'sent', sentAt: new Date(),
      }).catch(() => {});
    }
  } catch (_) { /* best-effort notification — reschedule already applied either way */ }
  return { success: true };
}

async function completeBooking({ bookingId }) {
  await Booking.findByIdAndUpdate(bookingId, { status: 'completed' });
  return { success: true };
}

// ─── Customers ───────────────────────────────────────────────────────────────

async function listCustomers({ search, page = 1, limit = 50 } = {}) {
  const filter = {};
  if (search) filter.$or = [
    { firstname: { $regex: search, $options: 'i' } },
    { lastname: { $regex: search, $options: 'i' } },
    { phone: { $regex: search, $options: 'i' } },
  ];
  const skip = (page - 1) * limit;
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ firstname: 1 }).skip(skip).limit(limit),
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

  return { customers: enriched, total, page, pages: Math.ceil(total / limit) };
}

async function getCustomer({ id }) {
  const customer = await Customer.findById(id);
  if (!customer) throw new Error('Customer not found');
  const orders = await Order.find({ customer: id }).sort({ createdAt: -1 });
  const totalSpent = orders.reduce((s, o) => s + (o.total || 0), 0);
  return { ...customer.toObject(), orders, totalSpent };
}

async function createCustomer(data) {
  return Customer.create(data);
}

async function updateCustomer({ id, ...data }) {
  const customer = await Customer.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!customer) throw new Error('Customer not found');
  return customer;
}

// ─── Orders ──────────────────────────────────────────────────────────────────

async function listOrders({ status, page = 1, limit = 50 } = {}) {
  const filter = status ? { status } : {};
  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter).populate('customer', 'firstname lastname phone').sort({ createdAt: -1 }).skip(skip).limit(limit),
    Order.countDocuments(filter),
  ]);
  return { orders, total, page, pages: Math.ceil(total / limit) };
}

async function getOrder({ id }) {
  const order = await Order.findById(id).populate('customer', 'firstname lastname phone loyaltyPoints');
  if (!order) throw new Error('Order not found');
  return order;
}

async function updateOrderStatus({ id, status }) {
  const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
  if (!order) throw new Error('Order not found');
  return order;
}

// Counts customers whose orders show a >60-day gap immediately before an order
// with source:'campaign' — i.e. they'd gone quiet and a campaign brought them back.
// Done in JS rather than a single aggregation pipeline: order volumes here are
// small (a real small business, not an enterprise catalog), and the "gap between
// consecutive orders per customer" shape is much easier to get right as a loop
// than as a $map/$range aggregation expression.
async function countInactiveRecovered() {
  const orders = await Order.find({ status: { $ne: 'cancelled' } }, 'customer createdAt source')
    .sort({ customer: 1, createdAt: 1 }).lean();
  const byCustomer = new Map();
  for (const o of orders) {
    const key = o.customer.toString();
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(o);
  }
  const INACTIVE_MS = 60 * 24 * 60 * 60 * 1000;
  let recovered = 0;
  for (const list of byCustomer.values()) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].source === 'campaign' && (new Date(list[i].createdAt) - new Date(list[i - 1].createdAt)) > INACTIVE_MS) {
        recovered++;
        break; // count each customer at most once
      }
    }
  }
  return recovered;
}

async function getOrderStats() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    totalOrders, totalCustomers, recentRevenue, statusBreakdown, recentOrders,
    repeatAgg, campaignRevenueAgg, campaignOrdersAgg, messagesSent, pointsAgg, inactiveRecovered,
  ] = await Promise.all([
    Order.countDocuments(),
    Customer.countDocuments(),
    Order.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.find().populate('customer', 'firstname lastname').sort({ createdAt: -1 }).limit(10),
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: '$customer', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $count: 'repeatCustomers' },
    ]),
    Order.aggregate([
      { $match: { source: 'campaign', status: { $ne: 'cancelled' } } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
    Order.aggregate([
      { $match: { source: 'campaign', status: { $ne: 'cancelled' } } },
      { $count: 'count' },
    ]),
    CampaignMessage.countDocuments({ kind: 'promotion', status: { $in: ['sent', 'delivered', 'read'] } }),
    Order.aggregate([
      { $match: { status: { $ne: 'cancelled' } } },
      { $group: { _id: null, points: { $sum: '$loyaltyPointsEarned' } } },
    ]),
    countInactiveRecovered(),
  ]);

  const campaignOrders = campaignOrdersAgg[0]?.count ?? 0;
  const conversionRate = messagesSent > 0 ? +((campaignOrders / messagesSent) * 100).toFixed(1) : 0;

  return {
    totalOrders, totalCustomers, recentRevenue: recentRevenue[0]?.revenue ?? 0, statusBreakdown, recentOrders,
    repeatCustomers: repeatAgg[0]?.repeatCustomers ?? 0,
    campaignRevenue: campaignRevenueAgg[0]?.revenue ?? 0,
    inactiveCustomersRecovered: inactiveRecovered,
    messagesSent,
    loyaltyPointsIssued: pointsAgg[0]?.points ?? 0,
    conversionRate,
  };
}

// Per-campaign funnel: sent → delivered → read → clicked → ordered → revenue/points.
async function getCampaignReport({ promotionId }) {
  const promotion = await Promotion.findById(promotionId);
  if (!promotion) throw new Error('Promotion not found');

  const agg = await CampaignMessage.aggregate([
    { $match: { promotion: promotion._id, kind: 'promotion' } },
    { $group: {
      _id: null,
      sent:         { $sum: { $cond: [{ $in: ['$status', ['sent', 'delivered', 'read']] }, 1, 0] } },
      delivered:    { $sum: { $cond: [{ $in: ['$status', ['delivered', 'read']] }, 1, 0] } },
      read:         { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
      failed:       { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
      // $gt (not $ne) against null — in aggregation expressions a genuinely
      // missing field is its own BSON type, distinct from and NOT equal to
      // null, so $ne incorrectly counts every message that's never been
      // clicked/ordered. $gt follows BSON comparison order, where missing
      // and null both sort lowest, so it correctly excludes both.
      clicked:      { $sum: { $cond: [{ $gt: ['$clickedAt', null] }, 1, 0] } },
      ordered:      { $sum: { $cond: [{ $gt: ['$order', null] }, 1, 0] } },
      revenue:      { $sum: '$revenue' },
      pointsIssued: { $sum: '$pointsIssued' },
    } },
  ]);

  const c = agg[0] || { sent: 0, delivered: 0, read: 0, failed: 0, clicked: 0, ordered: 0, revenue: 0, pointsIssued: 0 };
  const conversionRate = c.sent > 0 ? +((c.ordered / c.sent) * 100).toFixed(1) : 0;

  return {
    promotionId: promotion._id,
    name: promotion.name,
    messagesSent: c.sent,
    messagesDelivered: c.delivered,
    messagesRead: c.read,
    messagesFailed: c.failed,
    clicked: c.clicked,
    ordersCreated: c.ordered,
    revenue: +c.revenue.toFixed(2),
    pointsIssued: c.pointsIssued,
    conversionRate,
  };
}

async function createOrder({ customerId, items, shippingAddress }) {
  const customer = await Customer.findById(customerId);
  if (!customer) throw new Error('Customer not found');

  const address = shippingAddress || customer.address;
  if (!address) throw new Error('No shipping address on file for this customer — pass shippingAddress or update the customer first.');
  if (shippingAddress && shippingAddress !== customer.address) {
    customer.address = shippingAddress;
    await customer.save();
  }

  const cartItems = [];
  for (const { productId, quantity = 1 } of items) {
    const product = await Product.findById(productId);
    if (!product) throw new Error(`Product ${productId} not found`);
    for (let i = 0; i < quantity; i++) {
      cartItems.push({ name: product.name, priceAud: product.basePrice, pointsCost: 0, description: product.description || product.category || '' });
    }
  }

  const currency = await getCurrency();
  const subtotal = +cartItems.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
  const total = +(subtotal + SHIPPING_COST).toFixed(2);

  const pi = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    metadata: { buyerPhone: customer.phone, subtotal: String(subtotal), shippingCost: String(SHIPPING_COST), address },
  });

  // Visible in the dashboard immediately as pending — the Stripe webhook updates
  // this same document (matched by stripePaymentIntentId) to paid/failed rather
  // than creating a second one.
  await Order.create({
    customer: customer._id,
    items: cartItems.map(it => ({ productName: it.name, category: it.description || 'General', quantity: 1, unitPrice: it.priceAud })),
    subtotal, shippingCost: SHIPPING_COST, shippingAddress: address, total,
    status: 'pending', paymentStatus: 'pending', source: 'manual',
    stripePaymentIntentId: pi.id,
  });

  // Shared with routes/pay.js and the Stripe webhook in server.js — this is what lets
  // payment_intent.succeeded update the Order above with the final payment state.
  carts.set(customer.phone, cartItems);

  const summary = cartItems.map((it, i) => `${i + 1}. ${it.name} — ${money(it.priceAud, currency)}`).join('\n');
  await waPost({
    messaging_product: 'whatsapp', to: customer.phone, type: 'text',
    text: {
      body: `🛒 *Your Order Summary*\n\n${summary}\n\nSubtotal: ${money(subtotal, currency)}\nShipping: ${money(SHIPPING_COST, currency)}\n*Total: ${money(total, currency)}*\n\n📍 Delivering to:\n${address}\n\nPay securely:\n${APP_URL}/pay/${pi.id}`,
    },
  });

  return { success: true, paymentIntentId: pi.id, paymentLink: `${APP_URL}/pay/${pi.id}`, subtotal, shippingCost: SHIPPING_COST, total, itemCount: cartItems.length };
}

async function getPaymentStatus({ paymentIntentId }) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
  return { id: pi.id, status: pi.status, amount: pi.amount / 100, currency: pi.currency, buyerPhone: pi.metadata?.buyerPhone || null };
}

// ─── Promotions ──────────────────────────────────────────────────────────────

async function listPromotions() {
  return Promotion.find().populate('products', 'name basePrice images').populate('services', 'name basePrice duration').sort({ createdAt: -1 });
}

async function getPromotion({ id }) {
  const promo = await Promotion.findById(id).populate('products', 'name basePrice images category description').populate('services');
  if (!promo) throw new Error('Promotion not found');
  return promo;
}

// Accepts either the raw Mongoose field names (products/services — what the dashboard
// sends) or productIds/serviceIds (the MCP/GPT tool convention) so both callers work.
async function createPromotion({ productIds, serviceIds, products, services, ...data }) {
  return Promotion.create({
    ...data,
    products: products ?? productIds ?? [],
    services: services ?? serviceIds ?? [],
  });
}

async function updatePromotion({ id, productIds, serviceIds, products, services, ...data }) {
  const finalProducts = products ?? productIds;
  const finalServices = services ?? serviceIds;
  if (finalProducts) data.products = finalProducts;
  if (finalServices) data.services = finalServices;
  const promo = await Promotion.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!promo) throw new Error('Promotion not found');
  return promo;
}

async function deletePromotion({ id }) {
  await Promotion.findByIdAndDelete(id);
  return { success: true };
}

// RFM (recency/frequency/monetary + category-affinity) scoring — weighted
// 0.30/0.25/0.30/0.15, matching the algorithm merchants see on the dashboard.
async function getRecommendedCustomers({ promotionId, limit = 100 }) {
  const promotion = await Promotion.findById(promotionId).populate('products', 'category');
  if (!promotion) throw new Error('Promotion not found');

  const topN = limit;
  const targetCategories = promotion.type === 'specific_products'
    ? [...new Set(promotion.products.map(p => p.category))]
    : [];

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

  if (promotion.customerType === 'points') {
    const all = await Customer.find({ optedOut: { $ne: true } }).sort({ loyaltyPoints: -1 }).limit(topN).lean();
    return all.map(c => ({
      ...c, rfmScore: 0, segment: 'Best customers to target', orderCount: 0, totalSpent: 0,
      hasEnoughPoints: c.loyaltyPoints >= (promotion.pointsPrice || 0),
    }));
  }

  if (!stats.length) {
    const all = await Customer.find({ optedOut: { $ne: true } }).limit(topN).lean();
    return all.map(c => ({ ...c, rfmScore: 0, segment: 'Best customers to target', orderCount: 0, totalSpent: 0 }));
  }

  const now = Date.now();
  const maxDays   = Math.max(...stats.map(s => (now - new Date(s.lastOrderAt)) / 86400000));
  const maxOrders = Math.max(...stats.map(s => s.orderCount));
  const maxSpent  = Math.max(...stats.map(s => s.totalSpent));

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
    return { customerId: s._id, rfmScore, recency, frequency, monetary, orderCount: s.orderCount, totalSpent: s.totalSpent };
  });

  scored.sort((a, b) => b.rfmScore - a.rfmScore);
  const topIds = scored.slice(0, topN).map(s => s.customerId);
  const scoreMap = Object.fromEntries(scored.map(s => [s.customerId.toString(), s]));

  const customers = await Customer.find({ _id: { $in: topIds }, optedOut: { $ne: true } }).lean();
  const enriched = customers.map(c => {
    const s = scoreMap[c._id.toString()];
    return {
      ...c,
      rfmScore:   +(s?.rfmScore * 100).toFixed(1),
      segment:    segmentFor(s),
      orderCount: s?.orderCount ?? 0,
      totalSpent: +(s?.totalSpent ?? 0).toFixed(2),
    };
  });
  enriched.sort((a, b) => b.rfmScore - a.rfmScore);

  return enriched;
}

// Turns the raw recency/frequency/monetary sub-scores (0-1, relative to this
// customer pool) into one merchant-friendly label instead of a raw RFM number.
// Order matters — most specific match wins:
//   1. Gone quiet, but used to be a good customer  -> win-back candidate
//   2. Gone quiet, never really engaged            -> just inactive
//   3. Still active, spends often and a lot         -> high-value
//   4. Everyone else worth targeting                -> general recommendation
const RFM_HIGH = 0.6;
const RFM_LOW  = 0.35;
function segmentFor(s) {
  if (!s) return 'Best customers to target';
  const { recency, frequency, monetary } = s;
  if (recency < RFM_LOW) {
    return (frequency >= RFM_HIGH || monetary >= RFM_HIGH) ? 'Customers likely to return' : 'Inactive customers';
  }
  if (monetary >= RFM_HIGH && frequency >= RFM_HIGH) return 'High-value customers';
  return 'Best customers to target';
}

// Same "what items does this promotion cover" resolution used by sending,
// previewing, and test-sending — store-wide/no-explicit-picks promotions fall
// back to the first 10 active products/services.
async function resolvePromoItems(promotion) {
  if (promotion.scope === 'services') {
    return promotion.services?.length ? promotion.services : Service.find({ active: true }).limit(10);
  }
  return promotion.products?.length ? promotion.products : Product.find({ active: true }).limit(10);
}

async function previewPromotionMessage({ promotionId }) {
  const promotion = await Promotion.findById(promotionId).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const items = await resolvePromoItems(promotion);
  const sampleCustomer = {}; // generic — matches what a customer with no name on file would see

  if (promotion.customerType === 'points') {
    const { interactive, textFallback } = buildPointsPromoPayload(sampleCustomer, promotion, items);
    return {
      messageType: 'interactive',
      body: interactive.body.text,
      buttonLabel: interactive.action.buttons[0].reply.title,
      fallbackText: textFallback,
    };
  }

  const interactive = buildPromoAnnouncementPayload(sampleCustomer, promotion, items);
  return {
    messageType: 'interactive',
    body: interactive.body.text,
    header: interactive.header?.image?.link || null,
    buttonLabel: interactive.action.buttons[0].reply.title,
  };
}

async function sendTestMessage({ promotionId, phone }) {
  if (!phone) throw new Error('phone required');
  const promotion = await Promotion.findById(promotionId).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const items = await resolvePromoItems(promotion);
  const testCustomer = { firstname: 'Test', phone, loyaltyPoints: promotion.pointsPrice || 100 };

  if (promotion.customerType === 'points') {
    await sendPointsPromoMessage(phone, testCustomer, promotion, items);
  } else {
    await sendPromoAnnouncement(phone, testCustomer, promotion, items);
  }
  return { success: true };
}

async function sendPromotion({ promotionId, customerIds }) {
  if (!customerIds?.length) throw new Error('customerIds required');
  const promotion = await Promotion.findById(promotionId).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const requested = await Customer.find({ _id: { $in: customerIds } });
  const customers = requested.filter(c => !c.optedOut);
  const skippedOptedOut = requested.length - customers.length;

  const items = await resolvePromoItems(promotion);

  let sentCount = 0;
  const errors = [];
  for (const customer of customers) {
    let sent = false;
    let result = null;
    let messageType = 'interactive';
    let templateName;
    let failReason;

    try {
      if (promotion.customerType === 'points') result = await sendPointsPromoMessage(customer.phone, customer, promotion, items);
      else result = await sendPromoAnnouncement(customer.phone, customer, promotion, items);
      sent = true; sentCount++;
    } catch (_) { /* fall through to template fallback */ }

    if (!sent && promotion.customerType !== 'points' && items.length && promotion.scope !== 'services') {
      try {
        result = await sendPromoTemplate(customer.phone, customer, items[0], promotion);
        sentCount++; sent = true; messageType = 'template'; templateName = PROMO_TEMPLATE;
      } catch (err) {
        failReason = err.message;
        errors.push({ customer: customer._id, error: err.message });
      }
    } else if (!sent) {
      failReason = 'Send failed';
      errors.push({ customer: customer._id, error: failReason });
    }

    await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: customer.phone,
      wamid: wamidOf(result), messageType, templateName,
      status: sent ? 'sent' : 'failed', sentAt: sent ? new Date() : undefined, statusReason: sent ? undefined : failReason,
    }).catch(() => {}); // best-effort — a tracking-write failure shouldn't break the send loop

    await new Promise(r => setTimeout(r, 300));
  }

  await Promotion.findByIdAndUpdate(promotionId, { sentAt: new Date(), sentCount, status: 'active' });
  return { success: true, sentCount, skippedOptedOut, errors };
}

async function sendLoyaltyReminders({ customerIds } = {}) {
  const filter = customerIds?.length ? { _id: { $in: customerIds } } : { loyaltyPoints: { $gt: 0 } };
  const requested = await Customer.find(filter);
  const customers = requested.filter(c => !c.optedOut);
  const skippedOptedOut = requested.filter(c => c.optedOut).length;
  let sentCount = 0;
  for (const c of customers) {
    if (!c.loyaltyPoints) continue;
    let result = null;
    let sent = false;
    let messageType = 'template';
    let templateName = LOYALTY_TEMPLATE;
    try {
      result = await sendLoyaltyTemplate(c.phone, c.firstname, c.loyaltyPoints);
      sent = true; sentCount++;
    } catch {
      try {
        result = await sendLoyaltyReminder(c.phone, c.firstname, c.loyaltyPoints);
        sent = true; sentCount++; messageType = 'interactive'; templateName = undefined;
      } catch (_) {}
    }
    await CampaignMessage.create({
      kind: 'loyalty_reminder', customer: c._id, phone: c.phone,
      wamid: wamidOf(result), messageType, templateName,
      status: sent ? 'sent' : 'failed', sentAt: sent ? new Date() : undefined,
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
  return { success: true, sentCount, skippedOptedOut };
}

// ─── Settings ────────────────────────────────────────────────────────────────

async function getLoyaltySettings() {
  return (await Settings.findOne()) || (await Settings.create({}));
}

async function updateLoyaltySettings(data) {
  let s = (await Settings.findOne()) || new Settings();
  if (data.loyaltyPointsPerUnit != null) s.loyaltyPointsPerUnit = data.loyaltyPointsPerUnit;
  if (data.minPointsPerPurchase != null) s.minPointsPerPurchase = data.minPointsPerPurchase;
  if (data.currency) s.currency = data.currency;
  await s.save();
  settingsCache.invalidate();
  return s;
}

module.exports = {
  listProducts, getProduct, createProduct, updateProduct, deactivateProduct,
  listServices, getService, createService, updateService, deactivateService,
  createTimeSlot, listBookings, cancelBooking, rescheduleBooking, completeBooking,
  listCustomers, getCustomer, createCustomer, updateCustomer,
  listOrders, getOrder, updateOrderStatus, getOrderStats, createOrder, getPaymentStatus,
  listPromotions, getPromotion, createPromotion, updatePromotion, deletePromotion,
  getRecommendedCustomers, sendPromotion, sendLoyaltyReminders, getCampaignReport,
  previewPromotionMessage, sendTestMessage,
  getLoyaltySettings, updateLoyaltySettings,
};
