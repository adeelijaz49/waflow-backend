// /api/localization/flows — the Automated Flows overlay (spec §4): each flow's messages with their
// per-language text and approval status, "add a language version" for an entry message, and the Arabic
// versions of branching follow-up messages. Read-only on Flow / Promotion / MessageNode; language data lives in
// LocalizedTemplate (entry messages, shared/localization/flowMessages.js) and LocalizedFlowNode (follow-ups,
// shared/localization/flowFollowUps.js). Mounted behind the arabic_enabled gate in routes/localization/index.js,
// so req.user = { id, workspaceId, role }:
//   GET  /messages                                    -> { items: FlowMessageRow[] }            (entry messages only)
//   POST /messages/:messageNodeId/localize            -> LocalizedTemplate (201 created / 200 already there)
//   GET  /tree                                        -> { items: FlowTreeRow[] }               (full node trees)
//   GET  /promotion-trees                             -> { items: PromotionTreeRow[], truncated }   (promotions with their own message, not sent by any flow)
//   GET  /owners/:ownerType/:ownerId/tree             -> { ownerType, ownerId, messageSource, nodes }   (flow | promotion)
//   GET  /followups/:nodeId                           -> FollowUpView
//   PUT  /followups/:nodeId/variants/ar               body { body, buttons: [{ position, text }], source? } -> FollowUpView
//   POST /followups/:nodeId/variants/ar/review        body { status: 'reviewed' | 'draft', contentVersion } -> FollowUpView
// workspaceId and userId come ONLY from req.user; ids are validated by the services (400 INVALID_ID) and checked
// against the workspace (404 NODE_NOT_FOUND). Errors the services expect (FollowUpError: VARIANT_INVALID + issues,
// CONFLICT, ...) are answered with their full JSON body, anything else falls through to the shared handler
// (status + { error, code }, a 500 never leaks details). Nothing here deletes: "turn off" = review back to draft.
const express = require('express');
const defaultFlowMessages = require('../../shared/localization/flowMessages');
const defaultFollowUps = require('../../shared/localization/flowFollowUps');
const defaultTree = require('../../shared/localization/flowTree');
const { handler, pick } = require('../../shared/localization/scope');

function route(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.expose === true && err.body && Number.isInteger(err.status)) {
        res.status(err.status).json(err.body);
        return;
      }
      throw err;
    }
  });
}

const scope = (req) => ({ workspaceId: req.user && req.user.workspaceId, userId: req.user && req.user.id });

// The services are injectable so the HTTP tests can run the real router against in-memory ones.
function createRouter({ flowMessages = defaultFlowMessages, followUps = defaultFollowUps, tree = defaultTree } = {}) {
  const router = express.Router();

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

  router.get('/tree', route(async (req, res) => {
    res.json(await tree.buildFlowTrees({ workspaceId: req.user && req.user.workspaceId }));
  }));

  router.get('/promotion-trees', route(async (req, res) => {
    res.json(await tree.buildPromotionTrees({ workspaceId: req.user && req.user.workspaceId }));
  }));

  router.get('/owners/:ownerType/:ownerId/tree', route(async (req, res) => {
    res.json(await tree.buildOwnerTree({ workspaceId: req.user && req.user.workspaceId, ownerType: req.params.ownerType, ownerId: req.params.ownerId }));
  }));

  router.get('/followups/:nodeId', route(async (req, res) => {
    res.json(await followUps.getFollowUp({ workspaceId: req.user && req.user.workspaceId, nodeId: req.params.nodeId }));
  }));

  router.put('/followups/:nodeId/variants/ar', route(async (req, res) => {
    res.json(await followUps.saveVariant({ ...scope(req), nodeId: req.params.nodeId, input: pick(req.body ?? {}, ['body', 'buttons', 'source']) }));
  }));

  router.post('/followups/:nodeId/variants/ar/review', route(async (req, res) => {
    res.json(await followUps.reviewVariant({ ...scope(req), nodeId: req.params.nodeId, ...pick(req.body ?? {}, ['status', 'contentVersion']) }));
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
