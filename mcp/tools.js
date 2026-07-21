const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const ops = require('../shared/operations');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
function fail(err) {
  return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
}
function wrap(fn) {
  return async (args) => {
    try { return ok(await fn(args)); }
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
  }, wrap(ops.listProducts));

  server.registerTool('get_product', {
    title: 'Get product',
    description: 'Fetch a single product by id.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getProduct));

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
  }, wrap(ops.createProduct));

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
  }, wrap(ops.updateProduct));

  server.registerTool('deactivate_product', {
    title: 'Deactivate product',
    description: 'Soft-delete a product (sets active: false).',
    inputSchema: { id: z.string() },
  }, wrap(ops.deactivateProduct));

  // ─── Services ────────────────────────────────────────────────────────────
  server.registerTool('list_services', {
    title: 'List services',
    description: 'List all active services.',
    inputSchema: {},
  }, wrap(ops.listServices));

  server.registerTool('get_service', {
    title: 'Get service',
    description: 'Fetch a service with its upcoming time slots and bookings.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getService));

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
  }, wrap(ops.createService));

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
  }, wrap(ops.updateService));

  server.registerTool('deactivate_service', {
    title: 'Deactivate service',
    description: 'Soft-delete a service (sets active: false).',
    inputSchema: { id: z.string() },
  }, wrap(ops.deactivateService));

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
  }, wrap(ops.createTimeSlot));

  server.registerTool('list_bookings', {
    title: 'List bookings',
    description: 'List bookings, optionally filtered to one service. Omit serviceId for all recent bookings.',
    inputSchema: { serviceId: z.string().optional() },
  }, wrap(ops.listBookings));

  server.registerTool('cancel_booking', {
    title: 'Cancel booking',
    description: 'Cancel a booking, free its slot, and message the customer a rebook link.',
    inputSchema: { bookingId: z.string() },
  }, wrap(ops.cancelBooking));

  server.registerTool('reschedule_booking', {
    title: 'Reschedule booking',
    description: 'Move a booking to a different time slot and notify the customer.',
    inputSchema: { bookingId: z.string(), newSlotId: z.string() },
  }, wrap(ops.rescheduleBooking));

  server.registerTool('complete_booking', {
    title: 'Complete booking',
    description: 'Mark a booking as completed.',
    inputSchema: { bookingId: z.string() },
  }, wrap(ops.completeBooking));

  server.registerTool('confirm_booking', {
    title: 'Confirm a requested booking',
    description: 'Approve a "requested" (Reserve, Pay in Person) booking, moving it to confirmed, and notify the customer.',
    inputSchema: { bookingId: z.string() },
  }, wrap(ops.confirmBooking));

  server.registerTool('decline_booking', {
    title: 'Decline a requested booking',
    description: 'Decline a "requested" (Reserve, Pay in Person) booking, free its slot, and notify the customer.',
    inputSchema: { bookingId: z.string() },
  }, wrap(ops.declineBooking));

  server.registerTool('mark_no_show', {
    title: 'Mark booking as no-show',
    description: 'Mark a confirmed booking as a no-show. Manual, after the fact — no customer notification, no slot change.',
    inputSchema: { bookingId: z.string() },
  }, wrap(ops.markNoShow));

  // ─── Customers ───────────────────────────────────────────────────────────
  server.registerTool('list_customers', {
    title: 'List customers',
    description: 'Search/list customers with pagination and order stats. Set isDemo to filter to the tagged demo customers.',
    inputSchema: { search: z.string().optional(), isDemo: z.boolean().optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, wrap(ops.listCustomers));

  server.registerTool('get_customer', {
    title: 'Get customer',
    description: 'Fetch a customer with their order history.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getCustomer));

  server.registerTool('get_customer_whatsapp_history', {
    title: 'Get customer WhatsApp history',
    description: 'Timeline of promotional sends, loyalty reminders, and booking notifications sent to this customer.',
    inputSchema: { customerId: z.string() },
  }, wrap(ops.getCustomerWhatsAppHistory));

  server.registerTool('create_customer', {
    title: 'Create customer',
    description: 'Create a new customer record.',
    inputSchema: {
      firstname: z.string(), lastname: z.string(), phone: z.string(),
      email: z.string().optional(), address: z.string().optional(),
    },
  }, wrap(ops.createCustomer));

  server.registerTool('update_customer', {
    title: 'Update customer',
    description: 'Update fields on an existing customer.',
    inputSchema: {
      id: z.string(), firstname: z.string().optional(), lastname: z.string().optional(),
      phone: z.string().optional(), email: z.string().optional(), address: z.string().optional(),
      loyaltyPoints: z.number().optional(),
    },
  }, wrap(ops.updateCustomer));

  // ─── Orders ──────────────────────────────────────────────────────────────
  server.registerTool('list_orders', {
    title: 'List orders',
    description: 'List orders, optionally filtered by status and/or source (campaign, manual, booking, product).',
    inputSchema: { status: z.string().optional(), source: z.enum(['campaign', 'manual', 'booking', 'product']).optional(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, wrap(ops.listOrders));

  server.registerTool('get_order', {
    title: 'Get order',
    description: 'Fetch a single order by id.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getOrder));

  server.registerTool('update_order_status', {
    title: 'Update order status',
    description: 'Change an order\'s status (e.g. confirmed, shipped, cancelled).',
    inputSchema: { id: z.string(), status: z.string() },
  }, wrap(ops.updateOrderStatus));

  server.registerTool('refund_order', {
    title: 'Refund a paid order (real Stripe refund)',
    description: 'Issues a real Stripe refund for a paid order\'s payment and marks it refunded. Only works on orders with paymentStatus "paid". This is irreversible — confirm with the merchant before calling.',
    inputSchema: { id: z.string() },
  }, wrap(ops.refundOrder));

  server.registerTool('get_order_stats', {
    title: 'Get order stats',
    description: 'Dashboard-style summary: totals, 30-day revenue, status breakdown, recent orders.',
    inputSchema: {},
  }, wrap(ops.getOrderStats));

  server.registerTool('create_order', {
    title: 'Place an order & send a Stripe payment link (real WhatsApp send)',
    description: 'Creates an order for a customer and messages them a secure Stripe payment link on WhatsApp to pay themselves. Does NOT charge any card directly — the customer must complete payment on the hosted page. The order and loyalty points are recorded automatically once they pay. Requires a shipping address on file, or pass one in.',
    inputSchema: {
      customerId: z.string(),
      items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).optional() })).min(1),
      shippingAddress: z.string().optional(),
    },
  }, wrap(ops.createOrder));

  server.registerTool('get_payment_status', {
    title: 'Check Stripe payment status',
    description: 'Checks whether a payment intent created by create_order has been paid yet.',
    inputSchema: { paymentIntentId: z.string() },
  }, wrap(ops.getPaymentStatus));

  // ─── Promotions ──────────────────────────────────────────────────────────
  server.registerTool('list_promotions', {
    title: 'List promotions',
    description: 'List all promotions (product and service). Set isDemo to filter to the tagged demo promotions.',
    inputSchema: { isDemo: z.boolean().optional() },
  }, wrap(ops.listPromotions));

  server.registerTool('get_promotion', {
    title: 'Get promotion',
    description: 'Fetch a single promotion by id.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getPromotion));

  server.registerTool('create_promotion', {
    title: 'Create promotion',
    description: 'Create a new promotion (draft). Use scope "products" or "services".',
    inputSchema: {
      name: z.string(),
      description: z.string().optional(),
      customerType: z.enum(['cash', 'points']).optional(),
      scope: z.enum(['products', 'services']).optional(),
      type: z.enum(['specific_products', 'store_wide', 'specific_services']).optional(),
      campaignType: z.enum(['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer']).optional(),
      productIds: z.array(z.string()).optional(),
      serviceIds: z.array(z.string()).optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      pointsPrice: z.number().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    },
  }, wrap(ops.createPromotion));

  server.registerTool('update_promotion', {
    title: 'Update promotion',
    description: 'Update fields on an existing promotion.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      campaignType: z.enum(['product_promotion', 'service_booking_campaign', 'loyalty_reminder', 'inactive_customer_comeback', 'store_wide_offer']).optional(),
      discountPercent: z.number().min(0).max(100).optional(),
      pointsPrice: z.number().optional(),
      status: z.enum(['draft', 'active', 'expired']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      productIds: z.array(z.string()).optional(),
      serviceIds: z.array(z.string()).optional(),
    },
  }, wrap(ops.updatePromotion));

  server.registerTool('delete_promotion', {
    title: 'Delete promotion',
    description: 'Permanently delete a promotion.',
    inputSchema: { id: z.string() },
  }, wrap(ops.deletePromotion));

  server.registerTool('get_recommended_customers', {
    title: 'Get recommended customers for a promotion',
    description: 'RFM-scored customer recommendations for targeting a promotion send.',
    inputSchema: { promotionId: z.string(), limit: z.number().int().min(1).max(500).optional() },
  }, wrap(ops.getRecommendedCustomers));

  server.registerTool('preview_promotion_message', {
    title: 'Preview promotion message',
    description: 'Returns the exact WhatsApp message body/button text a customer would receive for this promotion, without sending anything. Use this before send_promotion to show the merchant what will go out.',
    inputSchema: { promotionId: z.string() },
  }, wrap(ops.previewPromotionMessage));

  server.registerTool('send_test_message', {
    title: 'Send a test promotion message (real WhatsApp send)',
    description: 'Sends the real promotion message to one phone number for testing — confirm the number with the user before calling, since this is a real send.',
    inputSchema: { promotionId: z.string(), phone: z.string() },
  }, wrap(ops.sendTestMessage));

  server.registerTool('send_promotion', {
    title: 'Send promotion (real WhatsApp send)',
    description: 'Sends a real WhatsApp message to the given customers for this promotion. This messages real customers — confirm scope with the user before calling.',
    inputSchema: { promotionId: z.string(), customerIds: z.array(z.string()).min(1) },
  }, wrap(ops.sendPromotion));

  server.registerTool('send_loyalty_reminders', {
    title: 'Send loyalty point reminders (real WhatsApp send)',
    description: 'Messages real customers reminding them of their loyalty points balance. Omit customerIds to target everyone with points > 0.',
    inputSchema: { customerIds: z.array(z.string()).optional() },
  }, wrap(ops.sendLoyaltyReminders));

  server.registerTool('get_campaign_report', {
    title: 'Get campaign report',
    description: 'Funnel report for a sent promotion: messages sent/delivered/read/failed, clicks, orders created, revenue, points issued, conversion rate.',
    inputSchema: { promotionId: z.string() },
  }, wrap(ops.getCampaignReport));

  // ─── Flows (automated lifecycle messaging) ──────────────────────────────
  const FLOW_TRIGGER_TYPES = ['inactive_customer', 'post_purchase_points', 'points_balance_reminder', 'booking_no_show'];

  server.registerTool('list_flows', {
    title: 'List flows',
    description: 'List automated lifecycle-messaging flows, optionally filtered by status.',
    inputSchema: { status: z.enum(['active', 'paused']).optional() },
  }, wrap(ops.listFlows));

  server.registerTool('get_flow', {
    title: 'Get flow',
    description: 'Fetch a single flow by id.',
    inputSchema: { id: z.string() },
  }, wrap(ops.getFlow));

  server.registerTool('create_flow', {
    title: 'Create flow',
    description: 'Create a new automated flow (starts paused — activate separately). Only inactive_customer and post_purchase_points are supported so far.',
    inputSchema: {
      name: z.string(),
      triggerType: z.enum(FLOW_TRIGGER_TYPES),
      inactivityDays: z.number().int().min(1).optional(),
      delayHours: z.number().min(0).optional(),
      cooldownDaysOverride: z.number().min(0).optional(),
    },
  }, wrap(ops.createFlow));

  server.registerTool('update_flow', {
    title: 'Update flow',
    description: 'Update a flow\'s name/config. triggerType cannot be changed after creation.',
    inputSchema: {
      id: z.string(),
      name: z.string().optional(),
      inactivityDays: z.number().int().min(1).optional(),
      delayHours: z.number().min(0).optional(),
      cooldownDaysOverride: z.number().min(0).optional(),
    },
  }, wrap(ops.updateFlow));

  server.registerTool('activate_flow', {
    title: 'Activate flow',
    description: 'Turns a flow on — it will begin enrolling and messaging eligible customers on the next scheduler tick. This results in real WhatsApp sends over time; confirm with the merchant before calling.',
    inputSchema: { id: z.string() },
  }, wrap(ops.activateFlow));

  server.registerTool('pause_flow', {
    title: 'Pause flow',
    description: 'Turns a flow off — stops new enrollments and sends, keeps all history.',
    inputSchema: { id: z.string() },
  }, wrap(ops.pauseFlow));

  server.registerTool('delete_flow', {
    title: 'Delete flow',
    description: 'Permanently delete a flow and its configuration.',
    inputSchema: { id: z.string() },
  }, wrap(ops.deleteFlow));

  server.registerTool('list_flow_enrollments', {
    title: 'List flow enrollments',
    description: 'List the customers a flow has enrolled, with their state (enrolled/messaged/exited/completed).',
    inputSchema: { flowId: z.string(), page: z.number().int().min(1).optional(), limit: z.number().int().min(1).max(200).optional() },
  }, wrap(ops.listFlowEnrollments));

  server.registerTool('get_flow_report', {
    title: 'Get flow report',
    description: 'Funnel report for a flow: enrolled/messaged/exited/completed counts, messages sent/delivered/read/failed, clicks, orders created, revenue, points issued, conversion rate.',
    inputSchema: { flowId: z.string() },
  }, wrap(ops.getFlowReport));

  // ─── Settings ────────────────────────────────────────────────────────────
  server.registerTool('get_loyalty_settings', {
    title: 'Get loyalty settings',
    description: 'Fetch the loyalty program configuration.',
    inputSchema: {},
  }, wrap(ops.getLoyaltySettings));

  server.registerTool('update_loyalty_settings', {
    title: 'Update loyalty settings',
    description: 'Update the loyalty program configuration.',
    inputSchema: {
      loyaltyPointsPerUnit: z.number().optional(),
      minPointsPerPurchase: z.number().optional(),
      currency: z.string().optional(),
    },
  }, wrap(ops.updateLoyaltySettings));

  return server;
}

module.exports = { createMcpServer };
