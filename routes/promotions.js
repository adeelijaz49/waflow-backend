const router = require('express').Router();
const ops = require('../shared/operations');
const Promotion = require('../models/Promotion');
// Carousel is a fully separate, additive send format — see
// shared/promotionCarousel.js's header comment. Every route below still runs
// its existing ops.* call exactly as before; carousel promotions are
// dispatched to this module instead, before any existing logic runs.
const carouselOps = require('../shared/promotionCarousel');
// What WhatsApp did with a send (accepted vs delivered vs refused, and why) — see shared/promoDelivery.js.
const promoDelivery = require('../shared/promoDelivery');

// The typed refusals of ops.sendPromotion / ops.sendTestMessage (see shared/operations.js#resolveEntryNodeForSend). Answers
// the request and returns true when err is one of them.
//   409 template_not_approved   the custom message is not approved by Meta yet (it has been submitted when it never was)
//   400 consent_request_invalid a consent request with no message of its own / no "Opt in" button
//   409 whatsapp_number_unavailable  the customer's own WhatsApp number cannot be used right now
//   429 test_send_limit / 409 test_send_refused  a test message: too many in the last hour / the number is an opted-out customer's
function sendRefusal(err, res) {
  if (!err) return false;
  if (err.code === 'TEMPLATE_NOT_APPROVED') {
    res.status(409).json({
      error: 'template_not_approved', message: err.message, templateStatus: err.templateStatus, submittedNow: !!err.submittedNow,
      ...(err.reason ? { reason: err.reason } : {}),
    });
    return true;
  }
  if (err.code === 'CONSENT_REQUEST_INVALID') {
    res.status(400).json({ error: 'consent_request_invalid', message: err.message });
    return true;
  }
  if (err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') {
    res.status(409).json({ error: 'whatsapp_number_unavailable', message: err.message });
    return true;
  }
  if (err.code === 'TEST_SEND_LIMIT') { // too many test messages in the last hour (ops.sendTestMessage)
    res.status(429).json({ error: 'test_send_limit', message: err.message });
    return true;
  }
  if (err.code === 'TEST_SEND_REFUSED') { // the number belongs to a customer who opted out
    res.status(409).json({ error: 'test_send_refused', message: err.message });
    return true;
  }
  return false;
}

// A consent request is only ever sent as separate messages (the carousel has no opt-in buttons).
const isCarousel = (promotion) => promotion.sendFormat === 'carousel' && promotion.purpose !== 'consent_request';

// ─── CRUD ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    res.json(await ops.listPromotions({ isDemo: req.query.isDemo, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Registered before /:id so "message-variables" isn't swallowed as a promotion id.
router.get('/message-variables', (req, res) => {
  res.json(ops.getPromotionMessageVariables());
});

router.get('/:id', async (req, res) => {
  try {
    res.json(await ops.getPromotion({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    res.status(201).json(await ops.createPromotion({ ...req.body, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json(await ops.updatePromotion({ id: req.params.id, ...req.body, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json(await ops.deletePromotion({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RFM: recommended customers ──────────────────────────────────────────────

router.get('/:id/recommended-customers', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    res.json(await ops.getRecommendedCustomers({ promotionId: req.params.id, limit, workspaceId: req.user.workspaceId, audience: req.query.audience }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Campaign report (sent/delivered/read/clicked/orders/revenue/points) ─────

router.get('/:id/report', async (req, res) => {
  try {
    res.json(await ops.getCampaignReport({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Delivery check (accepted vs delivered vs refused, with the reasons) ─────
// ?sinceSeconds=N limits it to the rows created in the last N seconds (the dashboard passes the time elapsed since the
// merchant pressed Send, so the browser's clock never matters); ?since=<ISO date> does the same with a date; neither = the
// whole promotion.

router.get('/:id/delivery', async (req, res) => {
  // A token without a workspace (the short-lived pre-login one) must never read across tenants.
  if (!req.user || !req.user.workspaceId) return res.status(403).json({ error: 'Workspace required' });
  try {
    let since = null;
    const secs = Number(req.query.sinceSeconds);
    if (Number.isFinite(secs) && secs > 0) since = new Date(Date.now() - Math.min(secs, 7 * 24 * 3600) * 1000);
    else if (req.query.since) { const d = new Date(String(req.query.since)); if (!isNaN(d)) since = d; }
    res.json(await promoDelivery.getPromotionDelivery({ promotionId: req.params.id, workspaceId: req.user.workspaceId, since }));
  } catch (err) {
    if (err.message === 'Promotion not found' || err.name === 'CastError') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Message preview + test send ─────────────────────────────────────────────

router.get('/:id/preview', async (req, res) => {
  try {
    const promotion = await Promotion.findOne(ops.scopedFilter(req.params.id, req.user.workspaceId));
    if (!promotion) return res.status(404).json({ error: 'Not found' });
    if (isCarousel(promotion)) {
      return res.json(await carouselOps.previewCarouselPromotion({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
    }
    res.json(await ops.previewPromotionMessage({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/test-send', async (req, res) => {
  try {
    const promotion = await Promotion.findOne(ops.scopedFilter(req.params.id, req.user.workspaceId));
    if (!promotion) return res.status(404).json({ error: 'Not found' });
    if (isCarousel(promotion)) {
      return res.json(await carouselOps.sendCarouselTestMessage({ promotionId: req.params.id, phone: req.body.phone, workspaceId: req.user.workspaceId }));
    }
    res.json(await ops.sendTestMessage({ promotionId: req.params.id, phone: req.body.phone, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    if (sendRefusal(err, res)) return;
    if (err.message === 'phone required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send WhatsApp promotion ─────────────────────────────────────────────────

router.post('/:id/send', async (req, res) => {
  try {
    const { customerIds } = req.body;
    const promotion = await Promotion.findOne(ops.scopedFilter(req.params.id, req.user.workspaceId));
    if (!promotion) return res.status(404).json({ error: 'Not found' });
    if (isCarousel(promotion)) {
      return res.json(await carouselOps.sendCarouselPromotion({ promotionId: req.params.id, customerIds, workspaceId: req.user.workspaceId }));
    }
    // allowRealDemoSend is intentionally NOT read from req.body here — it must
    // never be client-controlled on this route. isDemo promotions/customers
    // always simulate through this endpoint; see /:id/send-live-demo below.
    res.json(await ops.sendPromotion({ promotionId: req.params.id, customerIds, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    if (sendRefusal(err, res)) return;
    if (err.message === 'customerIds required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// Distinct, deliberately-named route for the dedicated /demo sales-presentation
// page only — a real send to a real (isDemo:true) phone the presenter controls,
// gated by that page's own explicit "this is not a simulation" confirmation.
// Never referenced by the regular Promotions screen, MCP, or GPT Actions.
router.post('/:id/send-live-demo', async (req, res) => {
  try {
    const { customerIds } = req.body;
    res.json(await ops.sendPromotion({ promotionId: req.params.id, customerIds, allowRealDemoSend: true, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    if (sendRefusal(err, res)) return;
    if (err.message === 'customerIds required') return res.status(400).json({ error: err.message });
    if (err.message === 'Promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// "Dismiss" on the "your message was approved, you can now send" notice (see Promotion.sendRequest). Answers with the
// promotion, so the screen can refresh it in one go.
router.post('/:id/dismiss-send-request', async (req, res) => {
  try {
    res.json(await ops.dismissSendRequest({ promotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Promotion not found' || err.name === 'CastError') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Send loyalty reminders ──────────────────────────────────────────────────

router.post('/loyalty/remind', async (req, res) => {
  try {
    res.json(await ops.sendLoyaltyReminders({ ...req.body, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
