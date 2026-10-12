// /api/localization/inbox — the Arabic-ready inbox's extra endpoints (spec §5):
// Arabic-aware conversation search, the customer-language context, and the two
// quick actions that send in the customer's language. The thread, snapshot and
// manual-send endpoints are the existing /api/inbox ones, reused unchanged.
// Mounted behind requireAuth + the arabic_enabled gate (routes/localization/index.js).
//   * req.user is { id, workspaceId, role } from the verified token — the only
//     source of the tenant; ids come from the path, bodies are never spread
//   * handler() turns thrown { status, code } errors into JSON; toApiError()
//     first turns anything unexpected into a generic INTERNAL answer, so no
//     upstream text, error code or stack ever reaches the client
const router = require('express').Router();
const inboxTools = require('../../shared/localization/inboxTools');
const { handler } = require('../../shared/localization/scope');

function route(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      throw inboxTools.toApiError(err);
    }
  });
}

router.get('/conversations', route(async (req, res) => {
  const { workspaceId } = req.user || {};
  const { filter, search } = req.query;
  res.json(await inboxTools.searchConversations({ workspaceId, filter, search }));
}));

router.get('/conversations/:customerId/context', route(async (req, res) => {
  const { workspaceId } = req.user || {};
  res.json(await inboxTools.getContext({ workspaceId, customerId: req.params.customerId }));
}));

router.post('/conversations/:customerId/payment-link', route(async (req, res) => {
  const { workspaceId, id } = req.user || {};
  const body = req.body ?? {};
  res.status(201).json(await inboxTools.sendPaymentLink({
    workspaceId, customerId: req.params.customerId, amount: body.amount, performedBy: id,
  }));
}));

router.post('/conversations/:customerId/loyalty-reminder', route(async (req, res) => {
  const { workspaceId, id } = req.user || {};
  const body = req.body ?? {};
  res.json(await inboxTools.sendLoyaltyReminder({
    workspaceId, customerId: req.params.customerId, performedBy: id, fieldValues: body.fieldValues,
  }));
}));

module.exports = router;
