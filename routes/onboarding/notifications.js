'use strict';
// GET /api/onboarding/notifications and POST /api/onboarding/notifications/read (DB design 5,
// DECISIONS C14). Gate E (enrolled, any subscription state: billing-exempt) is applied by routes/onboarding/index.js
// (ABSOLUTE paths here), so the bell keeps working while a payment is overdue or after a cancellation. The
// workspace comes only from req.user.workspaceId, so one workspace can never read or mark another's
// rows. Rows: { id, kind, severity, titleKey, bodyKey, params, actionPath, createdAt, readAt }.
const express = require('express');
const errors = require('../../shared/onboarding/errors');

const ID_RE = /^[0-9a-f]{24}$/i;
const MAX_LIMIT = 30;
const MAX_IDS = 100;

function realDeps() {
  return { notifications: require('../../shared/onboarding/notifications') };
}

/** @param {{notifications?:object}} [overrides] */
function createRouter(overrides = {}) {
  const router = express.Router();
  let cached = null;
  const deps = () => {
    if (!cached) cached = { ...realDeps(), ...overrides };
    return cached;
  };
  const workspaceOf = (req) => {
    const id = req.user && req.user.workspaceId;
    if (!id) throw new errors.OnbError('ONBOARDING_NOT_AVAILABLE');
    return String(id);
  };

  router.get('/notifications', async (req, res) => {
    try {
      const workspaceId = workspaceOf(req);
      const q = req.query || {};
      const unread = q.unread === '1' || q.unread === 'true';
      const parsed = parseInt(typeof q.limit === 'string' ? q.limit : '', 10);
      const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_LIMIT, parsed)) : MAX_LIMIT;
      const { notifications } = deps();
      const rows = await notifications.list(workspaceId, { unread, limit });
      const count = await notifications.unreadCount(workspaceId);
      return res.json({ notifications: rows, unread: count });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  router.post('/notifications/read', async (req, res) => {
    try {
      const workspaceId = workspaceOf(req);
      const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const { notifications } = deps();
      let result;
      if (body.all === true) {
        result = await notifications.markRead(workspaceId, { all: true });
      } else if (Array.isArray(body.ids)) {
        const ids = body.ids.filter((i) => typeof i === 'string' && ID_RE.test(i)).slice(0, MAX_IDS);
        result = ids.length ? await notifications.markRead(workspaceId, { ids }) : { modified: 0 };
      } else {
        throw new errors.OnbError('VALIDATION_FAILED', { details: { reason: 'IDS_OR_ALL_REQUIRED' } });
      }
      const count = await notifications.unreadCount(workspaceId);
      return res.json({ modified: (result && result.modified) || 0, unread: count });
    } catch (err) {
      return errors.respond(res, err);
    }
  });

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
