'use strict';
// The routes behind the EXISTING sender screens (D1, shared/localization/legacySenders.js). Mounted twice in
// routes/localization/index.js, both behind requireAuth + the per-merchant arabic_enabled flag (402 ARABIC_NOT_ENABLED):
//
//   router.use('/senders', ...)      POST /senders/:sender/plan            sender = loyalty_reminder | consent_request
//                                    body { customerIds?: string[], includeIds?: boolean }
//   router.use('/promotions', ...)   POST /promotions/:id/send-plan        body { customerIds: string[], includeIds?: boolean }
//                                    POST /promotions/:id/test-send        body { phone, language: 'ar' }
//                                    GET  /promotions/:id/send-report
//
// The plans are READ-ONLY and advisory (the existing /send routes are never gated by them). workspaceId comes ONLY
// from req.user; ids are validated (24-hex) before they reach a query; at most 5000 customer ids.
//
// test-send sends the SAME Arabic version a real send would pick to a typed number (ops.sendTestMessage stays English):
// 200 { sent, dryRun, usedLanguage, templateName } | 409 NO_ARABIC_VERSION { reason } | 429 RATE_LIMITED (10 per hour
// and workspace) | 400 INVALID_PHONE / INVALID_INPUT | 404 PROMOTION_NOT_FOUND | 502 META_ERROR.
const express = require('express');
const { handler, assertObjectId } = require('../../shared/localization/scope');

const TEST_SEND_LIMIT = 10;
const HOUR_MS = 60 * 60 * 1000;

function defaultDeps() {
  const templates = require('../../shared/localization/templates');
  return {
    plan: require('../../shared/localization/legacyPlan'),
    legacy: require('../../shared/localization/legacySenders'),
    limiter: templates.createRateLimiter({ limit: TEST_SEND_LIMIT, windowMs: HOUR_MS }),
    get Promotion() { return require('../../models/Promotion'); },
    get Settings() { return require('../../models/Settings'); },
    senderValues: require('../../shared/localization/senderValues'),
  };
}

// Anything the services reject with a bare { status: 400 } (scope.js validators) still answers { error, code }.
function route(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && err.status === 400 && !err.code) err.code = 'INVALID_INPUT';
      if (err && err.status === 429 && err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      if (err && err.status === 409 && err.details && !res.headersSent) {
        res.status(409).json({ error: err.message, code: err.code, ...err.details });
        return;
      }
      if (err && err.status === 502 && !res.headersSent) {
        res.status(502).json({ error: err.message, code: err.code });
        return;
      }
      throw err;
    }
  });
}

function httpError(status, code, message, extra) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function bodyOf(req) { return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}; }

// The phone a person typed: Arabic-Indic digits, spaces, dashes, + or 00 are fine (same rules as the template test send).
async function parseTestPhone(deps, workspaceId, raw) {
  const { toWesternDigits, stripInvisibles } = require('../../shared/localization/arabicText');
  const { normalizePhoneForDedup } = require('../../utils/phoneNormalize');
  const bad = () => httpError(400, 'INVALID_PHONE', 'Enter a valid phone number with its country code');
  if (typeof raw !== 'string' && typeof raw !== 'number') throw bad();
  const cleaned = stripInvisibles(toWesternDigits(String(raw))).trim();
  if (!cleaned || cleaned.length > 40 || !/^[+\d\s().-]+$/.test(cleaned)) throw bad();
  const rawDigits = cleaned.replace(/\D/g, '');
  if (rawDigits.length < 8 || rawDigits.length > 15) throw bad();
  let country = '966';
  try {
    const settings = await deps.Settings.findOne({ workspaceId }).select('defaultCountryCode').lean();
    country = (settings && settings.defaultCountryCode) || '966';
  } catch (err) { country = '966'; }
  const normalized = normalizePhoneForDedup(cleaned, country);
  if (!normalized || !/^\d{8,15}$/.test(normalized)) throw bad();
  return normalized;
}

function createRouters(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const senders = express.Router();
  const promotions = express.Router();

  senders.post('/:sender/plan', route(async (req, res) => {
    const body = bodyOf(req);
    res.json(await deps.plan.planSender({
      workspaceId: req.user.workspaceId, sender: req.params.sender, customerIds: body.customerIds, includeIds: body.includeIds === true,
    }));
  }));

  promotions.post('/:id/send-plan', route(async (req, res) => {
    const body = bodyOf(req);
    res.json(await deps.plan.planPromotionSend({
      workspaceId: req.user.workspaceId, promotionId: req.params.id, customerIds: body.customerIds, includeIds: body.includeIds === true,
    }));
  }));

  promotions.get('/:id/send-report', route(async (req, res) => {
    res.json(await deps.plan.reportPromotionSends({ workspaceId: req.user.workspaceId, promotionId: req.params.id }));
  }));

  promotions.post('/:id/test-send', route(async (req, res) => {
    const body = bodyOf(req);
    if (body.language !== undefined && body.language !== 'ar') throw httpError(400, 'INVALID_INPUT', 'language must be ar');
    const ws = String(req.user.workspaceId);
    const promotionId = assertObjectId(req.params.id, 'id');
    const phone = await parseTestPhone(deps, ws, body.phone);
    const promotion = await deps.Promotion.findOne({ _id: promotionId, workspaceId: ws }).populate('products').populate('services');
    if (!promotion) throw httpError(404, 'PROMOTION_NOT_FOUND', 'Promotion not found');
    const taken = deps.limiter.take(ws);
    if (!taken.ok) throw httpError(429, 'RATE_LIMITED', `Test messages are limited to ${TEST_SEND_LIMIT} per hour`, { retryAfterSeconds: taken.retryAfterSeconds });
    const items = await deps.senderValues.loadPromotionItems(deps.senderValues.realDeps(), promotion);
    res.json(await deps.legacy.sendPromotionTest({ workspaceId: ws, promotion, items, phone }));
  }));

  return { senders, promotions };
}

module.exports = { createRouters, ...createRouters() };
