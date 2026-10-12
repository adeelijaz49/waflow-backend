// /api/localization/campaigns — plan, create, send, cancel and report localised
// campaigns (mounted under requireAuth AND the arabic_enabled flag by
// routes/localization/index.js; req.user = { id, workspaceId, role }).
//   * workspaceId comes ONLY from req.user, never from the body or the URL;
//   * the facade (shared/localization/campaigns.js) reads explicit fields from the
//     body — nothing is spread into a write;
//   * every error is { error, code } with a code from the closed contract set;
//   * POST /:id/send answers 202 at once — the sending runs in the background.
// Static paths (segments, plan) are declared before /:id.
const router = require('express').Router();
const campaigns = require('../../shared/localization/campaigns');
const { handler } = require('../../shared/localization/scope');
const { httpError } = require('../../shared/localization/audience');

// scope.js#handler plus the codes the contract promises: a thrown 400 without a
// code is INVALID_INPUT, and anything unexpected becomes INTERNAL (logged, never leaked).
function route(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && Number.isInteger(err.status)) {
        if (!err.code && err.status === 400) err.code = 'INVALID_INPUT';
        throw err;
      }
      console.error('[localization] campaigns route:', err && err.message);
      throw httpError(500, 'INTERNAL', 'Something went wrong');
    }
  });
}

router.get('/segments', route(async (req, res) => {
  res.json(campaigns.segments());
}));

router.post('/plan', route(async (req, res) => {
  res.json(await campaigns.plan({ workspaceId: req.user.workspaceId, body: req.body ?? {} }));
}));

router.post('/', route(async (req, res) => {
  res.status(201).json(await campaigns.create({ workspaceId: req.user.workspaceId, userId: req.user.id, body: req.body ?? {} }));
}));

router.get('/', route(async (req, res) => {
  res.json(await campaigns.list({ workspaceId: req.user.workspaceId, query: req.query }));
}));

router.get('/:id', route(async (req, res) => {
  res.json(await campaigns.get({ workspaceId: req.user.workspaceId, id: req.params.id }));
}));

router.post('/:id/send', route(async (req, res) => {
  const { acknowledge } = req.body ?? {};
  res.status(202).json(await campaigns.send({ workspaceId: req.user.workspaceId, id: req.params.id, acknowledge }));
}));

router.post('/:id/cancel', route(async (req, res) => {
  res.json(await campaigns.cancel({ workspaceId: req.user.workspaceId, id: req.params.id }));
}));

router.get('/:id/recipients', route(async (req, res) => {
  res.json(await campaigns.recipients({ workspaceId: req.user.workspaceId, id: req.params.id, query: req.query }));
}));

router.get('/:id/report', route(async (req, res) => {
  res.json(await campaigns.report({ workspaceId: req.user.workspaceId, id: req.params.id }));
}));

module.exports = router;
