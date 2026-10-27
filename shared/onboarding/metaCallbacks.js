'use strict';
// Public Meta callbacks of the app, mounted by mount.js at /onboarding-meta (DB design 6.9):
//   POST /deauthorize      form-encoded signed_request; connections whose ids.metaUserId matches the payload
//                          user_id are flagged reconnect_required (reason DEAUTHORIZED) and the owner is notified
//   POST /data-deletion    verified request -> an OnboardingInbound row (_id 'metacb:<code>') and the answer
//                          { url, confirmation_code }. NO automatic deletion (standing no-delete rule): staff
//                          process it with the existing /internal-admin PII tooling. The row is listed on the onboarding admin page and in the
//                          CLI (shared/onboarding/dataDeletion.js, review R7-11) and support is e-mailed ONCE per request (the request id only).
//   GET  /deletion-status  the page the url points to (HTML, or JSON for Accept: application/json)
// signed_request = base64url(HMAC-SHA256(payload_b64, APP_SECRET)) + '.' + payload_b64; verified with
// timingSafeEqual, algorithm HMAC-SHA256 and the `expires` claim; a signature or payload that is not the CANONICAL base64url spelling of its
// bytes is refused (one request, one spelling: review R2-07). The confirmation code is deterministic
// (HMAC of the payload) so a retry of the same request returns the same code; the deauthorize idempotency key is the hash of the PAYLOAD part
// too (not of the whole string). Only FAILED attempts count against the per-IP limiter (review R2-06 / R1-F4): a validly signed callback is never
// limited, however many junk requests share the address (behind a proxy every client has one). These callbacks identify a
// Facebook user, not a WABA (AU4 8): the reliable signals stay the PARTNER_* events, error 190 and debug_token.
// Nothing here logs the signed_request, the user id or a token.
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const statusRefresh = require('./statusRefresh');
const rateLimit = require('./rateLimit');
const failOpen = require('./failOpen');

const MAX_SIGNED_REQUEST = 8192;
const CODE_RE = /^[a-f0-9]{16,64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const sha256hex = (v) => crypto.createHash('sha256').update(v).digest('hex');

/**
 * Verify a Meta signed_request.
 * @param {string} signedRequest
 * @param {string} appSecret
 * @param {number|Date} [now] defaults to Date.now()
 * @returns {object|null} the payload, or null when anything is wrong (signature, algorithm, expiry, shape)
 */
function verifySignedRequest(signedRequest, appSecret, now) {
  if (typeof signedRequest !== 'string' || !appSecret || signedRequest.length > MAX_SIGNED_REQUEST) return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2) return null;
  const [sigPart, payloadPart] = parts;
  if (!B64URL_RE.test(sigPart) || !B64URL_RE.test(payloadPart)) return null;
  const sig = Buffer.from(sigPart, 'base64url');
  if (sig.toString('base64url') !== sigPart) return null; // not the canonical spelling of these bytes
  const expected = crypto.createHmac('sha256', String(appSecret)).update(payloadPart).digest();
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  const payloadBytes = Buffer.from(payloadPart, 'base64url');
  if (payloadBytes.toString('base64url') !== payloadPart) return null;
  let payload;
  try { payload = JSON.parse(payloadBytes.toString('utf8')); } catch (_) { return null; }
  if (!isObj(payload)) return null;
  if (String(payload.algorithm || '').toUpperCase() !== 'HMAC-SHA256') return null;
  if (payload.expires !== undefined && payload.expires !== null) {
    const exp = Number(payload.expires);
    const t = now === undefined ? Date.now() : (now instanceof Date ? now.getTime() : Number(now));
    if (!Number.isFinite(exp) || exp * 1000 <= t) return null;
  }
  return payload;
}

const PAGE_TEXT = {
  received: 'Your data deletion request has been received. A member of the WaFlow team will review and process it.',
  completed: 'Your data deletion request has been processed.',
  unknown: 'This data deletion request was not found.',
};

/** Static page: only the three fixed texts above are ever rendered (nothing from the request is echoed). */
function statusPage(status) {
  const key = Object.prototype.hasOwnProperty.call(PAGE_TEXT, status) ? status : 'unknown';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Data deletion request</title>'
    + '<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;line-height:1.5}</style></head>'
    + `<body><h1>Data deletion request</h1><p>${PAGE_TEXT[key]}</p><p>Status: ${key}</p></body></html>`;
}

/**
 * @param {{appSecret?:()=>string|null, Connection?:object, Inbound?:object, statusRefresh?:object, analytics?:object, notifications?:object, state?:object, email?:object, now?:()=>number, rateLimitDeps?:object, failedLimit?:{limit:number,windowMs:number}}} [deps]
 */
function createRouter(deps = {}) {
  const router = express.Router();
  const secret = () => (deps.appSecret ? deps.appSecret() : (process.env.WA_APP_SECRET ? String(process.env.WA_APP_SECRET).trim() || null : null));
  const Conn = () => deps.Connection || require('../../models/WhatsAppConnection');
  const Inbound = () => deps.Inbound || require('../../models/OnboardingInbound');
  const refresh = () => deps.statusRefresh || statusRefresh;
  const nowMs = () => { const v = deps.now ? deps.now() : Date.now(); return v instanceof Date ? v.getTime() : Number(v); };
  const fail = (res, status, error) => { if (!res.headersSent) res.status(status).json({ error }); };

  router.use((req, res, next) => (config.enabled() ? next() : next('router')));
  const failedLimit = deps.failedLimit || { limit: 60, windowMs: 60 * 1000 };
  const form = express.urlencoded({ extended: false, limit: '10kb' });

  /**
   * A FAILED attempt (bad signature, unknown status code): counted per address; beyond the limit it is answered 429 instead of the plain error.
   * Anything that verified never passes through here, so Meta's real callbacks cannot be starved by junk from a shared address.
   */
  function failedAttempt(req, res, status, error) {
    const r = rateLimit.consume('metacb_failed', req.ip || 'unknown', failedLimit, deps.rateLimitDeps);
    if (!r.allowed) { res.set('Retry-After', String(r.retryAfterSec)); fail(res, 429, 'rate_limited'); return; }
    fail(res, status, error);
  }

  /** Read + verify the signed_request of a callback; sends the error itself and returns null. */
  function verified(req, res) {
    const s = secret();
    if (!s) { fail(res, 503, 'not_configured'); return null; }
    const sr = req.body && typeof req.body.signed_request === 'string' ? req.body.signed_request : '';
    const payload = verifySignedRequest(sr, s, nowMs());
    if (!payload) { failedAttempt(req, res, 400, 'invalid_signed_request'); return null; }
    return { payload, sr };
  }
  const userIdOf = (payload) => {
    const v = payload.user_id;
    return (typeof v === 'string' || typeof v === 'number') && String(v).length > 0 && String(v).length <= 80 ? String(v) : null;
  };

  /** E-mail support about a new data-deletion request: best effort, bounded, the request id only. Never fails the callback. */
  async function tellStaff(code) {
    try {
      const mod = deps.email || require('./email');
      const out = await failOpen.withTimeout(() => mod.sendDataDeletionNotice({ requestId: code }), deps.mailTimeoutMs || 3000, 'staff mail');
      if (out && out.sent === false) config.safeLog('info', '[onboarding] data-deletion staff mail skipped:', out.skipped || 'not_sent');
    } catch (err) {
      config.safeLog('warn', '[onboarding] data-deletion staff mail failed:', err && err.code ? err.code : 'ERROR');
    }
  }

  /** true = this request owns the row (new, or a previous attempt of it FAILED); false = already handled / in progress. */
  async function claim(key, doc) {
    try {
      await Inbound().create({ _id: key, ...doc });
      return true;
    } catch (err) {
      if (!(err && err.code === 11000)) throw err;
      const again = await Inbound().findOneAndUpdate({ _id: key, status: 'failed' }, { $set: { status: 'processing', startedAt: new Date(nowMs()) }, $inc: { attempts: 1 } });
      return !!again;
    }
  }

  router.post('/deauthorize', form, async (req, res) => {
    try {
      const v = verified(req, res);
      if (!v) return;
      const userId = userIdOf(v.payload);
      if (!userId) { res.json({ ok: true }); return; }
      const key = `metacb:deauth:${sha256hex(v.sr.split('.')[1]).slice(0, 32)}`; // the PAYLOAD part, as the data-deletion code does
      const started = new Date(nowMs());
      if (!(await claim(key, { source: 'metacb', type: 'deauthorize', status: 'processing', attempts: 1, startedAt: started }))) { res.json({ ok: true }); return; }
      let rows;
      try {
        rows = await Conn().find({ 'ids.metaUserId': userId }).select('workspaceId status').limit(50).lean();
      } catch (err) {
        await Inbound().updateOne({ _id: key }, { $set: { status: 'failed', errorCode: 'LOOKUP_FAILED', finishedAt: new Date(nowMs()) } }).catch(() => {});
        throw err; // 500: the ledger row is marked failed so Meta's retry is processed
      }
      let flagged = 0;
      let failed = 0;
      for (const row of rows || []) {
        try {
          const r = await refresh().markNeedsReconnect(String(row.workspaceId), 'DEAUTHORIZED', deps);
          if (r && r.changed) flagged += 1;
        } catch (_) { failed += 1; /* one failing row never blocks the others */ }
      }
      await Inbound().updateOne({ _id: key }, {
        $set: { status: failed ? 'failed' : 'done', outcome: `connections:${(rows || []).length} flagged:${flagged}`, finishedAt: new Date(nowMs()), ...(failed ? { errorCode: 'FLAG_FAILED' } : {}) },
      });
      if (failed) { fail(res, 500, 'internal'); return; }
      res.json({ ok: true });
    } catch (err) {
      config.safeLog('error', '[onboarding] deauthorize callback failed:', err && err.code, err && err.message);
      fail(res, 500, 'internal');
    }
  });

  router.post('/data-deletion', form, async (req, res) => {
    try {
      const v = verified(req, res);
      if (!v) return;
      const userId = userIdOf(v.payload);
      const payloadPart = v.sr.split('.')[1];
      const code = crypto.createHmac('sha256', secret()).update(`data-deletion:${payloadPart}`).digest('hex').slice(0, 24);
      let workspaceId;
      if (userId) {
        try {
          const rows = await Conn().find({ 'ids.metaUserId': userId }).select('workspaceId').limit(5).lean();
          const distinct = [...new Set((rows || []).map((r) => String(r.workspaceId)))];
          if (distinct.length === 1) [workspaceId] = distinct;
        } catch (_) { /* the request is recorded either way */ }
      }
      const fresh = await claim(`metacb:${code}`, {
        source: 'metacb', type: 'data_deletion', ...(workspaceId ? { workspaceId } : {}),
        status: 'processing', attempts: 1, startedAt: new Date(nowMs()),
        outcome: `awaiting_staff${userId ? ` user:${userId}` : ''}`.slice(0, 120),
      });
      if (fresh) await tellStaff(code); // once per request (a retry of the same request finds the row and sends nothing)
      res.json({ url: `${config.appUrl()}/onboarding-meta/deletion-status?code=${code}`, confirmation_code: code });
    } catch (err) {
      config.safeLog('error', '[onboarding] data-deletion callback failed:', err && err.code, err && err.message);
      fail(res, 500, 'internal');
    }
  });

  router.get('/deletion-status', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const row = CODE_RE.test(code) ? await Inbound().findOne({ _id: `metacb:${code}` }).select('status type').lean() : null;
      const wantsJson = req.accepts(['html', 'json']) === 'json';
      if (!row || row.type !== 'data_deletion') {
        // an unknown code is a failed attempt (guessing); a known one is never limited
        const r = rateLimit.consume('metacb_failed', req.ip || 'unknown', failedLimit, deps.rateLimitDeps);
        if (!r.allowed) { res.set('Retry-After', String(r.retryAfterSec)); fail(res, 429, 'rate_limited'); return; }
        if (wantsJson) { res.status(404).json({ error: 'not_found' }); return; }
        res.status(404).type('html').send(statusPage('unknown'));
        return;
      }
      const status = row.status === 'done' ? 'completed' : 'received';
      if (wantsJson) { res.json({ status }); return; }
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.type('html').send(statusPage(status));
    } catch (err) {
      config.safeLog('error', '[onboarding] deletion-status failed:', err && err.code, err && err.message);
      fail(res, 500, 'internal');
    }
  });

  return router;
}

const router = createRouter();

module.exports = { router, createRouter, verifySignedRequest };
