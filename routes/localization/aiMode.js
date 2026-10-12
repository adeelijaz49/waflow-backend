// /api/localization/ai-mode/* — AI Mode in Arabic (spec §6). Mounted by
// routes/localization/index.js behind requireAuth AND requireArabicEnabled, so
// req.user = { id, workspaceId, role } and the merchant has Arabic switched on.
//
//   POST /message              {sessionId, message, language?}        -> AiModeTurn
//   POST /confirm              {sessionId, actionId, confirm}         -> AiModeConfirmResult
//   GET  /session/:sessionId                                          -> AiModeSession
//   GET  /insights?language=ar|en                                     -> { items: AiModeInsight[] }
//
// The English AI Mode (/api/ai-chat) is untouched. The human-approval gate lives
// in shared/localization/aiMode/agent.js: this file only validates input, rate-
// limits per workspace and hands over. Rules followed (same as settings.js):
//   * workspaceId and userId come ONLY from req.user, never from the body;
//   * the client names an action (actionId) and a decision; what runs is the
//     server-stored action, so extra body fields (args, toolName, ...) are ignored;
//   * handler() turns thrown {status, code} errors into { error, code } JSON and
//     never leaks stack traces.
// The service is injected (createRouter) so tests need no database or model.
const express = require('express');
const { handler } = require('../../shared/localization/scope');
const { createRateLimiter } = require('../../shared/localization/aiMode/rateLimit');
const {
  bodyOf, parseSessionId, parseMessage, parseLanguage, parseConfirmBody,
} = require('../../shared/localization/aiMode/validate');

// Per workspace, per minute. A turn is several model calls, so it is the tightest.
const LIMITS = Object.freeze({ message: 20, confirm: 30, insights: 30 });

function createRouter({ service, limiters } = {}) {
  const router = express.Router();
  const limits = limiters || {
    message: createRateLimiter({ limit: LIMITS.message }),
    confirm: createRateLimiter({ limit: LIMITS.confirm }),
    insights: createRateLimiter({ limit: LIMITS.insights }),
  };
  // Loaded on first use so that requiring this router never builds clients or models.
  const svc = () => service || require('../../shared/localization/aiMode').getDefaultService();

  function identity(req) {
    const user = req.user || {};
    if (!user.workspaceId) {
      const err = new Error('Forbidden');
      err.status = 403;
      err.code = 'FORBIDDEN';
      throw err;
    }
    return { workspaceId: user.workspaceId, userId: user.id };
  }

  function throttle(limiter, workspaceId, res) {
    const verdict = limiter.check(String(workspaceId));
    if (verdict.ok) return;
    res.set('Retry-After', String(verdict.retryAfterSec));
    const err = new Error('Too many requests. Please wait a moment and try again.');
    err.status = 429;
    err.code = 'RATE_LIMITED';
    throw err;
  }

  // Chat content is private to the merchant: never cacheable.
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/message', handler(async (req, res) => {
    const { workspaceId, userId } = identity(req);
    const body = bodyOf(req);
    const sessionId = parseSessionId(body.sessionId);
    const message = parseMessage(body.message);
    const language = parseLanguage(body.language, ['auto', 'en', 'ar']);
    throttle(limits.message, workspaceId, res);
    res.json(await svc().message({ workspaceId, userId, sessionId, message, language }));
  }));

  router.post('/confirm', handler(async (req, res) => {
    const { workspaceId, userId } = identity(req);
    const body = bodyOf(req);
    const sessionId = parseSessionId(body.sessionId);
    const { actionId, confirm } = parseConfirmBody(body);
    const language = parseLanguage(body.language, ['auto', 'en', 'ar']);
    throttle(limits.confirm, workspaceId, res);
    res.json(await svc().confirm({ workspaceId, userId, sessionId, actionId, confirm, language }));
  }));

  router.get('/session/:sessionId', handler(async (req, res) => {
    const { workspaceId } = identity(req);
    const sessionId = parseSessionId(req.params.sessionId);
    res.json(await svc().getSession({ workspaceId, sessionId }));
  }));

  router.get('/insights', handler(async (req, res) => {
    const { workspaceId, userId } = identity(req);
    const language = parseLanguage(req.query.language, ['en', 'ar']);
    throttle(limits.insights, workspaceId, res);
    res.json(await svc().insights({ workspaceId, userId, language }));
  }));

  return router;
}

// Same contract as the other localisation routers: this module IS the router
// (index.js mounts it directly); createRouter is attached for tests.
module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.LIMITS = LIMITS;
