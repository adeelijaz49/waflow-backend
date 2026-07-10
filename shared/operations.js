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
const {
  sendPromoAnnouncement, sendPointsPromoMessage, sendPromoTemplate,
  sendLoyaltyTemplate, sendLoyaltyReminder, sendRebookMessage, waPost,
} = require('../utils/whatsapp');
const { carts } = require('../utils/state');
const { APP_URL } = require('../utils/config');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SHIPPING_COST_AUD = 0.5; // matches server.js's WhatsApp checkout flow

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
  await sendRebookMessage(
    booking.phone, booking.customerName || 'Valued Customer',
    booking.serviceId?.name || 'your service', booking.slotId,
    booking.serviceId?._id?.toString(), booking._id.toString(),
  ).catch(() => {});
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
  await waPost({
    messaging_product: 'whatsapp', to: booking.phone, type: 'text',
    text: { body: `📅 Your booking for *${booking.serviceId?.name}* has been rescheduled to *${newSlot.date} at ${newSlot.startTime}*. See you then! 🎉` },
  }).catch(() => {});
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
  return { customers, total, page, pages: Math.ceil(total / limit) };
}

async function getCustomer({ id }) {
  const customer = await Customer.findById(id);
  if (!customer) throw new Error('Customer not found');
  const orders = await Order.find({ customer: id }).sort({ createdAt: -1 });
  return { ...customer.toObject(), orders };
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

async function getOrderStats() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [totalOrders, totalCustomers, recentRevenue, statusBreakdown, recentOrders] = await Promise.all([
    Order.countDocuments(),
    Customer.countDocuments(),
    Order.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $ne: 'cancelled' } } },
      { $group: { _id: null, revenue: { $sum: '$total' } } },
    ]),
    Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Order.find().populate('customer', 'firstname lastname').sort({ createdAt: -1 }).limit(10),
  ]);
  return { totalOrders, totalCustomers, recentRevenue: recentRevenue[0]?.revenue ?? 0, statusBreakdown, recentOrders };
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

  const subtotal = +cartItems.reduce((s, i) => s + i.priceAud, 0).toFixed(2);
  const total = +(subtotal + SHIPPING_COST_AUD).toFixed(2);

  const pi = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: 'aud',
    automatic_payment_methods: { enabled: true },
    metadata: { buyerPhone: customer.phone, subtotal: String(subtotal), shippingCost: String(SHIPPING_COST_AUD), address },
  });

  // Shared with routes/pay.js and the Stripe webhook in server.js — this is what lets
  // payment_intent.succeeded build the real Order with line items once the customer pays.
  carts.set(customer.phone, cartItems);

  const summary = cartItems.map((it, i) => `${i + 1}. ${it.name} — $${it.priceAud.toFixed(2)} AUD`).join('\n');
  await waPost({
    messaging_product: 'whatsapp', to: customer.phone, type: 'text',
    text: {
      body: `🛒 *Your Order Summary*\n\n${summary}\n\nSubtotal: $${subtotal.toFixed(2)} AUD\nShipping: $${SHIPPING_COST_AUD.toFixed(2)} AUD\n*Total: $${total.toFixed(2)} AUD*\n\n📍 Delivering to:\n${address}\n\nPay securely:\n${APP_URL}/pay/${pi.id}`,
    },
  });

  return { success: true, paymentIntentId: pi.id, paymentLink: `${APP_URL}/pay/${pi.id}`, subtotal, shippingCost: SHIPPING_COST_AUD, total, itemCount: cartItems.length };
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

async function createPromotion({ productIds, serviceIds, ...data }) {
  return Promotion.create({ ...data, products: productIds || [], services: serviceIds || [] });
}

async function updatePromotion({ id, productIds, serviceIds, ...data }) {
  if (productIds) data.products = productIds;
  if (serviceIds) data.services = serviceIds;
  const promo = await Promotion.findByIdAndUpdate(id, data, { new: true, runValidators: true });
  if (!promo) throw new Error('Promotion not found');
  return promo;
}

async function deletePromotion({ id }) {
  await Promotion.findByIdAndDelete(id);
  return { success: true };
}

async function getRecommendedCustomers({ promotionId, limit = 100 }) {
  const promotion = await Promotion.findById(promotionId).populate('products', 'category');
  if (!promotion) throw new Error('Promotion not found');
  if (promotion.customerType === 'points') {
    const all = await Customer.find().sort({ loyaltyPoints: -1 }).limit(limit).lean();
    return all.map(c => ({ ...c, hasEnoughPoints: c.loyaltyPoints >= (promotion.pointsPrice || 0) }));
  }
  return Customer.find().limit(limit).lean();
}

async function sendPromotion({ promotionId, customerIds }) {
  const promotion = await Promotion.findById(promotionId).populate('products').populate('services');
  if (!promotion) throw new Error('Promotion not found');
  const customers = await Customer.find({ _id: { $in: customerIds } });

  let items = [];
  if (promotion.scope === 'services') {
    items = promotion.services?.length ? promotion.services : await Service.find({ active: true }).limit(10);
  } else {
    items = promotion.products?.length ? promotion.products : await Product.find({ active: true }).limit(10);
  }

  let sentCount = 0;
  const errors = [];
  for (const customer of customers) {
    let sent = false;
    try {
      if (promotion.customerType === 'points') await sendPointsPromoMessage(customer.phone, customer, promotion, items);
      else await sendPromoAnnouncement(customer.phone, customer, promotion, items);
      sent = true; sentCount++;
    } catch (_) { /* fall through to template fallback */ }

    if (!sent && promotion.customerType !== 'points' && items.length && promotion.scope !== 'services') {
      try { await sendPromoTemplate(customer.phone, customer, items[0], promotion); sentCount++; }
      catch (err) { errors.push({ customer: customer._id, error: err.message }); }
    } else if (!sent) {
      errors.push({ customer: customer._id, error: 'Send failed' });
    }
    await new Promise(r => setTimeout(r, 300));
  }

  await Promotion.findByIdAndUpdate(promotionId, { sentAt: new Date(), sentCount, status: 'active' });
  return { success: true, sentCount, errors };
}

async function sendLoyaltyReminders({ customerIds } = {}) {
  const filter = customerIds?.length ? { _id: { $in: customerIds } } : { loyaltyPoints: { $gt: 0 } };
  const customers = await Customer.find(filter);
  let sentCount = 0;
  for (const c of customers) {
    if (!c.loyaltyPoints) continue;
    try { await sendLoyaltyTemplate(c.phone, c.firstname, c.loyaltyPoints); sentCount++; }
    catch { try { await sendLoyaltyReminder(c.phone, c.firstname, c.loyaltyPoints); sentCount++; } catch (_) {} }
    await new Promise(r => setTimeout(r, 300));
  }
  return { success: true, sentCount };
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
  return s;
}

module.exports = {
  listProducts, getProduct, createProduct, updateProduct, deactivateProduct,
  listServices, getService, createService, updateService, deactivateService,
  createTimeSlot, listBookings, cancelBooking, rescheduleBooking, completeBooking,
  listCustomers, getCustomer, createCustomer, updateCustomer,
  listOrders, getOrder, updateOrderStatus, getOrderStats, createOrder, getPaymentStatus,
  listPromotions, getPromotion, createPromotion, updatePromotion, deletePromotion,
  getRecommendedCustomers, sendPromotion, sendLoyaltyReminders,
  getLoyaltySettings, updateLoyaltySettings,
};
