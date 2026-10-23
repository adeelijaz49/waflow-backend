'use strict';
// Connection routes of the onboarding flow (DB design 5):
//   GET  /connection                      (gate A) status snapshot from the DB (no Meta call)
//   POST /connection/refresh              (gate A) live refresh, 1 per 60 s per workspace
//   POST /connection/reconnect            (gate O) same payload as GET /connect/config, pinned to the current WABA
//   POST /connection/disconnect/request   (gate O) -> { confirmationToken, expiresInSec, impactKeys }
//   POST /connection/disconnect           (gate O) { confirmationToken, confirmText:'DISCONNECT' }
// Absolute paths (Express 5 sub-router, INTERFACES 0.3/0.4). workspaceId and userId come from the token only.
const express = require('express');
const config = require('../../shared/onboarding/config');
const { respond, OnbError } = require('../../shared/onboarding/errors');
const rateLimit = require('../../shared/onboarding/rateLimit');

function lazy(factory) {
  let fn = null;
  return function lazyMiddleware(req, res, next) {
    try {
      if (!fn) fn = factory();
    } catch (err) {
      return respond(res, err);
    }
    return fn(req, res, next);
  };
}

function wrap(handler) {
  return async function onboardingConnectionRoute(req, res) {
    try {
      await handler(req, res);
    } catch (err) {
      respond(res, err);
    }
  };
}

const who = (req) => ({
  workspaceId: req.user && req.user.workspaceId ? String(req.user.workspaceId) : '',
  userId: req.user && (req.user.id || req.user.userId) ? String(req.user.id || req.user.userId) : '',
});

const iso = (v) => (v ? new Date(v).toISOString() : null);

/** UI level from the stored row (used when statusRefresh.snapshot is not available). */
function levelOf(conn) {
  if (!conn) return 'not_connected';
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'reconnect_needed';
  if (conn.status === 'connected') return 'connected';
  if (conn.status === 'needs_attention') return 'needs_attention';
  return 'not_connected';
}

/** Safe fallback snapshot straight from the document: masked number only, no secrets, no Meta call. */
function fallbackSnapshot(conn) {
  const level = levelOf(conn);
  const display = (conn && conn.display) || {};
  return {
    level,
    status: conn ? conn.status : 'not_connected',
    numberMasked: display.displayPhoneNumber ? config.maskPhone(display.displayPhoneNumber) : null,
    verifiedName: display.verifiedName || null,
    needsReconnect: !!(conn && conn.needsReconnect),
    reconnectReason: (conn && conn.reconnectReason) || null,
    waitingForNumber: !!(conn && conn.status === 'waba_only'),
    webhookSubscribed: !!(conn && conn.webhook && conn.webhook.subscribed),
    causeCode: level === 'reconnect_needed' ? 'WHATSAPP_RECONNECT_REQUIRED' : (level === 'not_connected' ? 'WHATSAPP_NOT_CONNECTED' : null),
    causePath: level === 'connected' || level === 'needs_attention' ? null : '/setup/connect',
    lastStatusCheckAt: iso(conn && conn.lastStatusCheckAt),
    checkedAt: iso(conn && (conn.lastStatusCheckAt || conn.updatedAt)),
  };
}

/** Router factory. deps = { connect?, connectDeps?, statusRefresh?, refreshDeps?, Connection?, gateDeps?, limiter? }. */
function createRouter(deps = {}) {
  const d = deps || {};
  const router = express.Router();
  const connect = () => d.connect || require('../../shared/onboarding/connect');
  const Connection = () => d.Connection || require('../../models/WhatsAppConnection');
  const statusRefresh = () => {
    if (d.statusRefresh) return d.statusRefresh;
    try { return require('../../shared/onboarding/statusRefresh'); } catch (_) { return null; }
  };
  const ownerOnly = lazy(() => require('../../shared/onboarding/requireOnboardingAccess')({ ownerOnly: true }, d.gateDeps));
  // refresh SPENDS the merchant's Meta credentials: a member who was removed (30-day JWT) gets 403 NOT_A_MEMBER (review R2-05), before the limiter
  const memberOnly = d.memberGate || lazy(() => require('../../shared/onboarding/requireOnboardingAccess')({ liveMember: true }, d.gateDeps));
  const limit = (bucket, cfg) => rateLimit.middleware(bucket, cfg, d);

  async function readConnection(workspaceId) {
    return Connection().findOne({ workspaceId }).lean();
  }

  function snapshotOf(conn) {
    const mod = statusRefresh();
    if (mod && typeof mod.snapshot === 'function') {
      try {
        const snap = mod.snapshot(conn);
        if (snap && typeof snap === 'object') return Object.assign({ status: conn ? conn.status : 'not_connected' }, snap);
      } catch (_) { /* fall back below */ }
    }
    return fallbackSnapshot(conn);
  }

  router.get('/connection', wrap(async (req, res) => {
    const { workspaceId } = who(req);
    const conn = await readConnection(workspaceId);
    res.set('Cache-Control', 'no-store');
    res.json(snapshotOf(conn));
  }));

  router.post('/connection/refresh', memberOnly, limit('connection_refresh', { limit: 1, windowMs: 60 * 1000 }), wrap(async (req, res) => {
    const { workspaceId } = who(req);
    const conn = await readConnection(workspaceId);
    if (!conn || !['connected', 'needs_attention', 'waba_only'].includes(conn.status)) {
      res.json(snapshotOf(conn)); // nothing to ask Meta about
      return;
    }
    const mod = statusRefresh();
    if (!mod || typeof mod.refreshConnection !== 'function') throw new OnbError('NOT_IMPLEMENTED');
    let snap;
    try {
      snap = await mod.refreshConnection(workspaceId, d.refreshDeps);
    } catch (err) {
      if (err && err.name === 'MetaGraphError') {
        try { await connect().reportGraphError(workspaceId, err, d.connectDeps); } catch (_) { /* never throws */ }
        const code = require('../../shared/onboarding/metaErrors').classify(err).appCode;
        throw new OnbError(code, code === 'META_RATE_LIMITED' ? { retryAfterSec: 60 } : {});
      }
      throw err;
    }
    res.json(Object.assign({ status: conn.status }, snap && typeof snap === 'object' ? snap : {}));
  }));

  router.post('/connection/reconnect', ownerOnly, limit('connection_reconnect', { limit: 10, windowMs: 10 * 60 * 1000 }), wrap(async (req, res) => {
    const out = await connect().getConnectConfig({ ...who(req), reconnect: true }, d.connectDeps);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  router.post('/connection/disconnect/request', ownerOnly, limit('connection_disconnect_request', { limit: 10, windowMs: 10 * 60 * 1000 }), wrap(async (req, res) => {
    const out = await connect().requestDisconnect(who(req), d.connectDeps);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  router.post('/connection/disconnect', ownerOnly, limit('connection_disconnect', { limit: 10, windowMs: 10 * 60 * 1000 }), wrap(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const fields = [];
    if (typeof b.confirmationToken !== 'string' || !b.confirmationToken.trim() || b.confirmationToken.length > 200) fields.push('confirmationToken');
    if (typeof b.confirmText !== 'string' || b.confirmText.trim() !== 'DISCONNECT') fields.push('confirmText');
    if (fields.length) throw new OnbError('VALIDATION_FAILED', { details: { fields } });
    const out = await connect().disconnect({ ...who(req), confirmationToken: b.confirmationToken.trim(), confirmText: b.confirmText.trim() }, d.connectDeps);
    res.set('Cache-Control', 'no-store');
    res.json(out);
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.fallbackSnapshot = fallbackSnapshot;
module.exports.levelOf = levelOf;
