const router = require('express').Router();
const ops = require('../shared/operations');
const Workspace = require('../models/Workspace');
const { requireApiKey } = require('./auth');
const { buildOpenApiSpec } = require('./openapi');

// Public — ChatGPT's "Import from URL" fetches this once when you build the Action.
// No secrets in it, so it doesn't need the API key.
router.get('/openapi.json', (req, res) => res.json(buildOpenApiSpec()));

router.use(requireApiKey);

// GPT Actions serve a single deployment-wide admin identity, not a per-user
// authenticated session — there's no req.user to read a workspaceId from.
// Resolve the oldest workspace (today's only real one) once per request.
router.use(async (req, res, next) => {
  const workspace = await Workspace.findOne().sort({ createdAt: 1 });
  req.workspaceId = workspace?._id;
  next();
});

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
router.get('/products', h(req => ops.listProducts({ ...req.query, workspaceId: req.workspaceId })));
router.get('/products/:id', h(req => ops.getProduct({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/products', h(req => ops.createProduct({ ...req.body, workspaceId: req.workspaceId })));
router.patch('/products/:id', h(req => ops.updateProduct({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));
router.post('/products/:id/deactivate', h(req => ops.deactivateProduct({ id: req.params.id, workspaceId: req.workspaceId })));

// ─── Services ────────────────────────────────────────────────────────────────
router.get('/services', h(req => ops.listServices({ workspaceId: req.workspaceId })));
router.get('/services/:id', h(req => ops.getService({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/services', h(req => ops.createService({ ...req.body, workspaceId: req.workspaceId })));
router.patch('/services/:id', h(req => ops.updateService({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));
router.post('/services/:id/deactivate', h(req => ops.deactivateService({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/services/:id/slots', h(req => ops.createTimeSlot({ serviceId: req.params.id, ...req.body, workspaceId: req.workspaceId })));

router.get('/bookings', h(req => ops.listBookings({ ...req.query, workspaceId: req.workspaceId })));
router.post('/bookings/:id/cancel', h(req => ops.cancelBooking({ bookingId: req.params.id, workspaceId: req.workspaceId })));
router.post('/bookings/:id/reschedule', h(req => ops.rescheduleBooking({ bookingId: req.params.id, newSlotId: req.body.newSlotId, workspaceId: req.workspaceId })));
router.post('/bookings/:id/complete', h(req => ops.completeBooking({ bookingId: req.params.id, workspaceId: req.workspaceId })));
router.post('/bookings/:id/confirm', h(req => ops.confirmBooking({ bookingId: req.params.id, workspaceId: req.workspaceId })));
router.post('/bookings/:id/decline', h(req => ops.declineBooking({ bookingId: req.params.id, workspaceId: req.workspaceId })));
router.post('/bookings/:id/no-show', h(req => ops.markNoShow({ bookingId: req.params.id, workspaceId: req.workspaceId })));

// ─── Customers ───────────────────────────────────────────────────────────────
router.get('/customers', h(req => ops.listCustomers({ ...req.query, workspaceId: req.workspaceId })));
router.get('/customers/:id', h(req => ops.getCustomer({ id: req.params.id, workspaceId: req.workspaceId })));
router.get('/customers/:id/whatsapp-history', h(req => ops.getCustomerWhatsAppHistory({ customerId: req.params.id, workspaceId: req.workspaceId })));
router.get('/customers/:id/bookings', h(req => ops.listBookings({ customerId: req.params.id, workspaceId: req.workspaceId })));
router.post('/customers', h(req => ops.createCustomer({ ...req.body, workspaceId: req.workspaceId })));
router.patch('/customers/:id', h(req => ops.updateCustomer({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));

// ─── Orders ──────────────────────────────────────────────────────────────────
router.get('/orders', h(req => ops.listOrders({ ...req.query, workspaceId: req.workspaceId })));
router.get('/orders/stats', h(req => ops.getOrderStats({ workspaceId: req.workspaceId })));
router.get('/orders/:id', h(req => ops.getOrder({ id: req.params.id, workspaceId: req.workspaceId })));
router.patch('/orders/:id/status', h(req => ops.updateOrderStatus({ id: req.params.id, status: req.body.status, workspaceId: req.workspaceId })));
router.post('/orders/:id/refund', h(req => ops.refundOrder({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/orders', h(req => ops.createOrder({ ...req.body, workspaceId: req.workspaceId })));

router.get('/payments/:paymentIntentId', h(req => ops.getPaymentStatus({ paymentIntentId: req.params.paymentIntentId })));

// ─── Promotions ──────────────────────────────────────────────────────────────
router.get('/promotions', h(req => ops.listPromotions({ ...req.query, workspaceId: req.workspaceId })));
router.get('/promotions/:id', h(req => ops.getPromotion({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/promotions', h(req => ops.createPromotion({ ...req.body, workspaceId: req.workspaceId })));
router.patch('/promotions/:id', h(req => ops.updatePromotion({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));
router.delete('/promotions/:id', h(req => ops.deletePromotion({ id: req.params.id, workspaceId: req.workspaceId })));
router.get('/promotions/:id/recommended-customers', h(req => ops.getRecommendedCustomers({ promotionId: req.params.id, limit: req.query.limit ? +req.query.limit : undefined, workspaceId: req.workspaceId })));
router.post('/promotions/:id/send', h(req => ops.sendPromotion({ promotionId: req.params.id, customerIds: req.body.customerIds, workspaceId: req.workspaceId })));
router.get('/promotions/:id/report', h(req => ops.getCampaignReport({ promotionId: req.params.id, workspaceId: req.workspaceId })));
router.get('/promotions/:id/preview', h(req => ops.previewPromotionMessage({ promotionId: req.params.id, workspaceId: req.workspaceId })));
router.post('/promotions/:id/test-send', h(req => ops.sendTestMessage({ promotionId: req.params.id, phone: req.body.phone, workspaceId: req.workspaceId })));

router.post('/loyalty/remind', h(req => ops.sendLoyaltyReminders({ ...req.body, workspaceId: req.workspaceId })));

// ─── Flows (automated lifecycle messaging) ───────────────────────────────────
router.get('/flows', h(req => ops.listFlows({ ...req.query, workspaceId: req.workspaceId })));
// Registered before /flows/:id so "preview"/"message-variables" aren't swallowed as a flow id.
router.get('/flows/preview', h(req => ops.previewFlowMessage({ triggerType: req.query.triggerType })));
router.get('/flows/message-variables', h(req => ops.getFlowMessageVariables({ triggerType: req.query.triggerType })));
router.get('/flows/:id', h(req => ops.getFlow({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/flows', h(req => ops.createFlow({ ...req.body, workspaceId: req.workspaceId })));
router.patch('/flows/:id', h(req => ops.updateFlow({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));
router.delete('/flows/:id', h(req => ops.deleteFlow({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/flows/:id/activate', h(req => ops.activateFlow({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/flows/:id/pause', h(req => ops.pauseFlow({ id: req.params.id, workspaceId: req.workspaceId })));
router.get('/flows/:id/enrollments', h(req => ops.listFlowEnrollments({ flowId: req.params.id, ...req.query, workspaceId: req.workspaceId })));
router.get('/flows/:id/report', h(req => ops.getFlowReport({ flowId: req.params.id, workspaceId: req.workspaceId })));

// ─── Message Nodes (branching — see models/MessageNode.js) ──────────────────
router.post('/message-nodes', h(req => ops.createMessageNode({ ...req.body, workspaceId: req.workspaceId })));
router.get('/message-nodes/:id', h(req => ops.getMessageNode({ id: req.params.id, workspaceId: req.workspaceId })));
router.patch('/message-nodes/:id', h(req => ops.updateMessageNode({ id: req.params.id, ...req.body, workspaceId: req.workspaceId })));
router.delete('/message-nodes/:id', h(req => ops.deleteMessageNode({ id: req.params.id, workspaceId: req.workspaceId })));
router.post('/message-nodes/:id/submit-template', h(req => ops.submitMessageNodeTemplate({ nodeId: req.params.id, workspaceId: req.workspaceId })));
router.post('/message-nodes/:id/refresh-status', h(req => ops.refreshMessageNodeTemplateStatus({ nodeId: req.params.id, workspaceId: req.workspaceId })));

// ─── Settings ────────────────────────────────────────────────────────────────
router.get('/settings/loyalty', h(req => ops.getLoyaltySettings({ workspaceId: req.workspaceId })));
router.patch('/settings/loyalty', h(req => ops.updateLoyaltySettings(req.body, { workspaceId: req.workspaceId })));

module.exports = router;
