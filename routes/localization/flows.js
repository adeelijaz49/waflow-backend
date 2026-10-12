// /api/localization/flows — the Automated Flows overlay (spec §4): each flow's entry
// message with its per-language text and approval status, and "add a language version"
// for a message. Read-only on Flow / Promotion / MessageNode; language data lives in
// LocalizedTemplate (see shared/localization/flowMessages.js). Mounted behind the
// arabic_enabled gate in routes/localization/index.js, so req.user = { id, workspaceId, role }:
//   GET  /messages                          -> { items: FlowMessageRow[] }
//   POST /messages/:messageNodeId/localize  -> LocalizedTemplate (201 created / 200 already there)
// workspaceId comes ONLY from req.user; the node id is validated by the service
// (400 INVALID_ID) and checked against the workspace (404 NODE_NOT_FOUND).
const router = require('express').Router();
const flowMessages = require('../../shared/localization/flowMessages');
const { handler } = require('../../shared/localization/scope');

router.get('/messages', handler(async (req, res) => {
  res.json(await flowMessages.listFlowMessages({ workspaceId: req.user && req.user.workspaceId }));
}));

router.post('/messages/:messageNodeId/localize', handler(async (req, res) => {
  const { template, created } = await flowMessages.localizeMessage({
    workspaceId: req.user && req.user.workspaceId,
    userId: req.user && req.user.id,
    messageNodeId: req.params.messageNodeId,
  });
  res.status(created ? 201 : 200).json(template);
}));

module.exports = router;
