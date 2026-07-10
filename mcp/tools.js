const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const Stripe = require('stripe');

const Product  = require('../models/Product');
const Service   = require('../models/Service');
const Customer  = require('../models/Customer');
const Order     = require('../models/Order');
const Promotion = require('../models/Promotion');
const Settings  = require('../models/Settings');
const TimeSlot  = require('../models/TimeSlot');
const Booking   = require('../models/Booking');
const {
  sendPromoAnnouncement, sendPointsPromoMessage, sendPromoTemplate,
  sendLoyaltyTemplate, sendLoyaltyReminder, sendRebookMessage, waPost,
} = require('../utils/whatsapp');
const { carts } = require('../utils/state');
const { APP_URL } = require('../utils/config');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const SHIPPING_COST_AUD = 0.5; // matches server.js's checkout flow

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}
function wrap(handler) {
  return async (args) => {
    try { return ok(await handler(args)); }
    catch (err) { return fail(err); }
  };
}

function createMcpServer() {
  const server = new McpServer({ name: 'waflow', version: '1.0.0' });

  // ─── Products ────────────────────────────────────────────────────────────
  server.registerTool('list_products', {
    title: 'List products',
    description: 'Search/list active products with pagination.',
    inputSchema: {
      search: z.string().optional(),
      category: z.string().optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
  }, wrap(async ({ search, category, page = 1, limit = 50 }) => {
    const filter = { active: true };
    if (search) filter.name = { $regex: search, $options: 'i' };
    if (category) filter.category = category;
    const skip = (page - 1) * limit;
    const [products, total] = await Promise.all([
      Product.find(filter).sort({ name: 1 }).skip(skip).limit(limit),
      Product.countDocuments(filter),
    ]);
    return { products, total, page, pages: Math.ceil(total / limit) };
  }));

  server.registerTool('get_product', {
    title: 'Get product',
    description: 'Fetch a single product by id.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    const product = await Product.findById(id);
    if (!product) throw new Error('Product not found');
    return product;
  }));

  server.registerTool('create_product', {
    title: 'Create product',
    description: 'Create a new product.',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      category: z.string(),
      basePrice: z.number(),
      images: z.array(z.string()).optional(),
      variants: z.array(z.object({ size: z.string(), color: z.string(), stock: z.number().optional(), sku: z.string().optional() })).optional(),
    },
  }, wrap(async (data) => Product.create(data)));

  server.registerTool('update_product', {
    title: 'Update product',
    description: 'Update fields on an existing product.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      basePrice: z.number().optional(),
      images: z.array(z.string()).optional(),
      variants: z.array(z.object({ size: z.string(), color: z.string(), stock: z.number().optional(), sku: z.string().optional() })).optional(),
    },
  }, wrap(async ({ id, ...data }) => {
    const product = await Product.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!product) throw new Error('Product not found');
    return product;
  }));

  server.registerTool('deactivate_product', {
    title: 'Deactivate product',
    description: 'Soft-delete a product (sets active: false).',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    await Product.findByIdAndUpdate(id, { active: false });
    return { success: true };
  }));

  // ─── Services ────────────────────────────────────────────────────────────
  server.registerTool('list_services', {
    title: 'List services',
    description: 'List all active services.',
    inputSchema: {},
  }, wrap(async () => Service.find({ active: true }).sort({ name: 1 })));

  server.registerTool('get_service', {
    title: 'Get service',
    description: 'Fetch a service with its upcoming time slots and bookings.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    const service = await Service.findById(id);
    if (!service) throw new Error('Service not found');
    const slots = await TimeSlot.find({ serviceId: id }).sort({ date: 1, startTime: 1 });
    const bookings = await Booking.find({ serviceId: id }).sort({ createdAt: -1 }).populate('customerId', 'firstname lastname phone');
    return { service, slots, bookings };
  }));

  server.registerTool('create_service', {
    title: 'Create service',
    description: 'Create a new bookable service.',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      duration: z.number().int().optional(),
      basePrice: z.number().optional(),
      pointsPrice: z.number().optional(),
      images: z.array(z.string()).optional(),
    },
  }, wrap(async (data) => Service.create(data)));

  server.registerTool('update_service', {
    title: 'Update service',
    description: 'Update fields on an existing service.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      duration: z.number().int().optional(),
      basePrice: z.number().optional(),
      pointsPrice: z.number().optional(),
      images: z.array(z.string()).optional(),
    },
  }, wrap(async ({ id, ...data }) => {
    const service = await Service.findByIdAndUpdate(id, data, { new: true });
    if (!service) throw new Error('Service not found');
    return service;
  }));

  server.registerTool('deactivate_service', {
    title: 'Deactivate service',
    description: 'Soft-delete a service (sets active: false).',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    await Service.findByIdAndUpdate(id, { active: false });
    return { success: true };
  }));

  server.registerTool('create_time_slot', {
    title: 'Create time slot',
    description: 'Add a bookable time slot to a service.',
    inputSchema: {
      serviceId: z.string(),
      date: z.string().describe('YYYY-MM-DD'),
      startTime: z.string().describe('HH:MM'),
      endTime: z.string().describe('HH:MM'),
      capacity: z.number().int().optional(),
    },
  }, wrap(async ({ serviceId, ...data }) => TimeSlot.create({ ...data, serviceId })));

  server.registerTool('list_bookings', {
    title: 'List bookings',
    description: 'List bookings, optionally filtered to one service. Omit serviceId for all recent bookings.',
    inputSchema: { serviceId: z.string().optional() },
  }, wrap(async ({ serviceId }) => {
    const filter = serviceId ? { serviceId } : {};
    return Booking.find(filter).sort({ createdAt: -1 }).limit(200)
      .populate('serviceId', 'name category')
      .populate('customerId', 'firstname lastname phone');
  }));

  server.registerTool('cancel_booking', {
    title: 'Cancel booking',
    description: 'Cancel a booking, free its slot, and message the customer a rebook link.',
    inputSchema: { bookingId: z.string() },
  }, wrap(async ({ bookingId }) => {
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
  }));

  server.registerTool('reschedule_booking', {
    title: 'Reschedule booking',
    description: 'Move a booking to a different time slot and notify the customer.',
    inputSchema: { bookingId: z.string(), newSlotId: z.string() },
  }, wrap(async ({ bookingId, newSlotId }) => {
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
    const { waPost } = require('../utils/whatsapp');
    await waPost({
      messaging_product: 'whatsapp', to: booking.phone, type: 'text',
      text: { body: `📅 Your booking for *${booking.serviceId?.name}* has been rescheduled to *${newSlot.date} at ${newSlot.startTime}*. See you then! 🎉` },
    }).catch(() => {});
    return { success: true };
  }));

  server.registerTool('complete_booking', {
    title: 'Complete booking',
    description: 'Mark a booking as completed.',
    inputSchema: { bookingId: z.string() },
  }, wrap(async ({ bookingId }) => {
    await Booking.findByIdAndUpdate(bookingId, { status: 'completed' });
    return { success: true };
  }));

  // ─── Customers ───────────────────────────────────────────────────────────
  server.registerTool('list_customers', {
    title: 'List customers',
    description: 'Search/list customers with pagination and order stats.',
    inputSchema: { search: z.string().optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, wrap(async ({ search, page = 1, limit = 50 }) => {
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
  }));

  server.registerTool('get_customer', {
    title: 'Get customer',
    description: 'Fetch a customer with their order history.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    const customer = await Customer.findById(id);
    if (!customer) throw new Error('Customer not found');
    const orders = await Order.find({ customer: id }).sort({ createdAt: -1 });
    return { ...customer.toObject(), orders };
  }));

  server.registerTool('create_customer', {
    title: 'Create customer',
    description: 'Create a new customer record.',
    inputSchema: {
      firstname: z.string(), lastname: z.string(), phone: z.string(),
      email: z.string().optional(), address: z.string().optional(),
    },
  }, wrap(async (data) => Customer.create(data)));

  server.registerTool('update_customer', {
    title: 'Update customer',
    description: 'Update fields on an existing customer.',
    inputSchema: {
      id: z.string(), firstname: z.string().optional(), lastname: z.string().optional(),
      phone: z.string().optional(), email: z.string().optional(), address: z.string().optional(),
      loyaltyPoints: z.number().optional(),
    },
  }, wrap(async ({ id, ...data }) => {
    const customer = await Customer.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!customer) throw new Error('Customer not found');
    return customer;
  }));

  // ─── Orders ──────────────────────────────────────────────────────────────
  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List orders, optionally filtered by status.',
    inputSchema: { status: z.string().optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, wrap(async ({ status, page = 1, limit = 50 }) => {
    const filter = status ? { status } : {};
    const skip = (page - 1) * limit;
    const [orders, total] = await Promise.all([
      Order.find(filter).populate('customer', 'firstname lastname phone').sort({ createdAt: -1 }).skip(skip).limit(limit),
      Order.countDocuments(filter),
    ]);
    return { orders, total, page, pages: Math.ceil(total / limit) };
  }));

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Fetch a single order by id.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    const order = await Order.findById(id).populate('customer', 'firstname lastname phone loyaltyPoints');
    if (!order) throw new Error('Order not found');
    return order;
  }));

  server.registerTool('update_order_status', {
    title: 'Update order status',
    description: 'Change an order\'s status (e.g. confirmed, shipped, cancelled).',
    inputSchema: { id: z.string(), status: z.string() },
  }, wrap(async ({ id, status }) => {
    const order = await Order.findByIdAndUpdate(id, { status }, { new: true });
    if (!order) throw new Error('Order not found');
    return order;
  }));

  server.registerTool('get_order_stats', {
    title: 'Get order stats',
    description: 'Dashboard-style summary: totals, 30-day revenue, status breakdown, recent orders.',
    inputSchema: {},
  }, wrap(async () => {
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
  }));

  server.registerTool('create_order', {
    title: 'Place an order & send a Stripe payment link (real WhatsApp send)',
    description: 'Creates an order for a customer and messages them a secure Stripe payment link on WhatsApp to pay themselves. Does NOT charge any card directly — the customer must complete payment on the hosted page. The order and loyalty points are recorded automatically once they pay. Requires a shipping address on file, or pass one in.',
    inputSchema: {
      customerId: z.string(),
      items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).optional() })).min(1),
      shippingAddress: z.string().optional(),
    },
  }, wrap(async ({ customerId, items, shippingAddress }) => {
    const customer = await Customer.findById(customerId);
    if (!customer) throw new Error('Customer not found');

    const address = shippingAddress || customer.address;
    if (!address) throw new Error('No shipping address on file for this customer — pass shippingAddress or call update_customer first.');
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
  }));

  server.registerTool('get_payment_status', {
    title: 'Check Stripe payment status',
    description: 'Checks whether a payment intent created by create_order has been paid yet.',
    inputSchema: { paymentIntentId: z.string() },
  }, wrap(async ({ paymentIntentId }) => {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    return { id: pi.id, status: pi.status, amount: pi.amount / 100, currency: pi.currency, buyerPhone: pi.metadata?.buyerPhone || null };
  }));

  // ─── Promotions ──────────────────────────────────────────────────────────
  server.registerTool('list_promotions', {
    title: 'List promotions',
    description: 'List all promotions (product and service).',
    inputSchema: {},
  }, wrap(async () => Promotion.find().populate('products', 'name basePrice images').populate('services', 'name basePrice duration').sort({ createdAt: -1 })));

  server.registerTool('get_promotion', {
    title: 'Get promotion',
    description: 'Fetch a single promotion by id.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    const promo = await Promotion.findById(id).populate('products', 'name basePrice images category description').populate('services');
    if (!promo) throw new Error('Promotion not found');
    return promo;
  }));

  server.registerTool('create_promotion', {
    title: 'Create promotion',
    description: 'Create a new promotion (draft). Use scope "products" or "services".',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      customerType: z.enum(['cash', 'points']).optional(),
      scope: z.enum(['products', 'services']).optional(),
      type: z.enum(['specific_products', 'store_wide', 'specific_services']).optional(),
      productIds: z.array(z.string()).optional(),
      serviceIds: z.array(z.string()).optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      pointsPrice: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
  }, wrap(async ({ productIds, serviceIds, ...data }) => Promotion.create({
    ...data,
    products: productIds || [],
    services: serviceIds || [],
  })));

  server.registerTool('update_promotion', {
    title: 'Update promotion',
    description: 'Update fields on an existing promotion.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      pointsPrice: z.number().optional(),
      status: z.enum(['draft', 'active', 'expired']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      productIds: z.array(z.string()).optional(),
      serviceIds: z.array(z.string()).optional(),
    },
  }, wrap(async ({ id, productIds, serviceIds, ...data }) => {
    if (productIds) data.products = productIds;
    if (serviceIds) data.services = serviceIds;
    const promo = await Promotion.findByIdAndUpdate(id, data, { new: true, runValidators: true });
    if (!promo) throw new Error('Promotion not found');
    return promo;
  }));

  server.registerTool('delete_promotion', {
    title: 'Delete promotion',
    description: 'Permanently delete a promotion.',
    inputSchema: { id: z.string() },
  }, wrap(async ({ id }) => {
    await Promotion.findByIdAndDelete(id);
    return { success: true };
  }));

  server.registerTool('get_recommended_customers', {
    title: 'Get recommended customers for a promotion',
    description: 'RFM-scored customer recommendations for targeting a promotion send.',
    inputSchema: { promotionId: z.string(), limit: z.number().int().min(1).max(500).optional() },
  }, wrap(async ({ promotionId, limit = 100 }) => {
    const promotion = await Promotion.findById(promotionId).populate('products', 'category');
    if (!promotion) throw new Error('Promotion not found');
    if (promotion.customerType === 'points') {
      const all = await Customer.find().sort({ loyaltyPoints: -1 }).limit(limit).lean();
      return all.map(c => ({ ...c, hasEnoughPoints: c.loyaltyPoints >= (promotion.pointsPrice || 0) }));
    }
    const all = await Customer.find().limit(limit).lean();
    return all;
  }));

  server.registerTool('send_promotion', {
    title: 'Send promotion (real WhatsApp send)',
    description: 'Sends a real WhatsApp message to the given customers for this promotion. This messages real customers — confirm scope with the user before calling.',
    inputSchema: { promotionId: z.string(), customerIds: z.array(z.string()).min(1) },
  }, wrap(async ({ promotionId, customerIds }) => {
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
  }));

  server.registerTool('send_loyalty_reminders', {
    title: 'Send loyalty point reminders (real WhatsApp send)',
    description: 'Messages real customers reminding them of their loyalty points balance. Omit customerIds to target everyone with points > 0.',
    inputSchema: { customerIds: z.array(z.string()).optional() },
  }, wrap(async ({ customerIds }) => {
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
  }));

  // ─── Settings ────────────────────────────────────────────────────────────
  server.registerTool('get_loyalty_settings', {
    title: 'Get loyalty settings',
    description: 'Fetch the loyalty program configuration.',
    inputSchema: {},
  }, wrap(async () => (await Settings.findOne()) || (await Settings.create({}))));

  server.registerTool('update_loyalty_settings', {
    title: 'Update loyalty settings',
    description: 'Update the loyalty program configuration.',
    inputSchema: {
      loyaltyPointsPerUnit: z.number().optional(),
      minPointsPerPurchase: z.number().optional(),
      currency: z.string().optional(),
    },
  }, wrap(async (data) => {
    let s = (await Settings.findOne()) || new Settings();
    if (data.loyaltyPointsPerUnit != null) s.loyaltyPointsPerUnit = data.loyaltyPointsPerUnit;
    if (data.minPointsPerPurchase != null) s.minPointsPerPurchase = data.minPointsPerPurchase;
    if (data.currency) s.currency = data.currency;
    await s.save();
    return s;
  }));

  return server;
}

module.exports = { createMcpServer };
