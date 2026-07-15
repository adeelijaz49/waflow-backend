const router = require('express').Router();
const ops = require('../shared/operations');
const { requireApiKey } = require('./auth');
const { buildOpenApiSpec } = require('./openapi');

// Public — ChatGPT's "Import from URL" fetches this once when you build the Action.
// No secrets in it, so it doesn't need the API key.
router.get('/openapi.json', (req, res) => res.json(buildOpenApiSpec()));

router.use(requireApiKey);

function h(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req);
      res.json(result);
    } catch (err) {
      res.status(err.message?.includes('not found') ? 404 : 400).json({ error: err.message });
    }
  };
}

// ─── Products ────────────────────────────────────────────────────────────────
router.get('/products', h(req => ops.listProducts(req.query)));
router.get('/products/:id', h(req => ops.getProduct({ id: req.params.id })));
router.post('/products', h(req => ops.createProduct(req.body)));
router.patch('/products/:id', h(req => ops.updateProduct({ id: req.params.id, ...req.body })));
router.post('/products/:id/deactivate', h(req => ops.deactivateProduct({ id: req.params.id })));

// ─── Services ────────────────────────────────────────────────────────────────
router.get('/services', h(() => ops.listServices()));
router.get('/services/:id', h(req => ops.getService({ id: req.params.id })));
router.post('/services', h(req => ops.createService(req.body)));
router.patch('/services/:id', h(req => ops.updateService({ id: req.params.id, ...req.body })));
router.post('/services/:id/deactivate', h(req => ops.deactivateService({ id: req.params.id })));
router.post('/services/:id/slots', h(req => ops.createTimeSlot({ serviceId: req.params.id, ...req.body })));

router.get('/bookings', h(req => ops.listBookings(req.query)));
router.post('/bookings/:id/cancel', h(req => ops.cancelBooking({ bookingId: req.params.id })));
router.post('/bookings/:id/reschedule', h(req => ops.rescheduleBooking({ bookingId: req.params.id, newSlotId: req.body.newSlotId })));
router.post('/bookings/:id/complete', h(req => ops.completeBooking({ bookingId: req.params.id })));
router.post('/bookings/:id/confirm', h(req => ops.confirmBooking({ bookingId: req.params.id })));
router.post('/bookings/:id/decline', h(req => ops.declineBooking({ bookingId: req.params.id })));
router.post('/bookings/:id/no-show', h(req => ops.markNoShow({ bookingId: req.params.id })));

// ─── Customers ───────────────────────────────────────────────────────────────
router.get('/customers', h(req => ops.listCustomers(req.query)));
router.get('/customers/:id', h(req => ops.getCustomer({ id: req.params.id })));
router.get('/customers/:id/whatsapp-history', h(req => ops.getCustomerWhatsAppHistory({ customerId: req.params.id })));
router.get('/customers/:id/bookings', h(req => ops.listBookings({ customerId: req.params.id })));
router.post('/customers', h(req => ops.createCustomer(req.body)));
router.patch('/customers/:id', h(req => ops.updateCustomer({ id: req.params.id, ...req.body })));

// ─── Orders ──────────────────────────────────────────────────────────────────
router.get('/orders', h(req => ops.listOrders(req.query)));
router.get('/orders/stats', h(() => ops.getOrderStats()));
router.get('/orders/:id', h(req => ops.getOrder({ id: req.params.id })));
router.patch('/orders/:id/status', h(req => ops.updateOrderStatus({ id: req.params.id, status: req.body.status })));
router.post('/orders/:id/refund', h(req => ops.refundOrder({ id: req.params.id })));
router.post('/orders', h(req => ops.createOrder(req.body)));

router.get('/payments/:paymentIntentId', h(req => ops.getPaymentStatus({ paymentIntentId: req.params.paymentIntentId })));

// ─── Promotions ──────────────────────────────────────────────────────────────
router.get('/promotions', h(() => ops.listPromotions()));
router.get('/promotions/:id', h(req => ops.getPromotion({ id: req.params.id })));
router.post('/promotions', h(req => ops.createPromotion(req.body)));
router.patch('/promotions/:id', h(req => ops.updatePromotion({ id: req.params.id, ...req.body })));
router.delete('/promotions/:id', h(req => ops.deletePromotion({ id: req.params.id })));
router.get('/promotions/:id/recommended-customers', h(req => ops.getRecommendedCustomers({ promotionId: req.params.id, limit: req.query.limit ? +req.query.limit : undefined })));
router.post('/promotions/:id/send', h(req => ops.sendPromotion({ promotionId: req.params.id, customerIds: req.body.customerIds })));
router.get('/promotions/:id/report', h(req => ops.getCampaignReport({ promotionId: req.params.id })));
router.get('/promotions/:id/preview', h(req => ops.previewPromotionMessage({ promotionId: req.params.id })));
router.post('/promotions/:id/test-send', h(req => ops.sendTestMessage({ promotionId: req.params.id, phone: req.body.phone })));

router.post('/loyalty/remind', h(req => ops.sendLoyaltyReminders(req.body)));

// ─── Settings ────────────────────────────────────────────────────────────────
router.get('/settings/loyalty', h(() => ops.getLoyaltySettings()));
router.patch('/settings/loyalty', h(req => ops.updateLoyaltySettings(req.body)));

module.exports = router;
