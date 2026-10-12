// /api/localization/ai/* — AI drafting helpers: Translate to Arabic / English, "Make
// this Saudi-friendly", staff "Reply in Arabic", inbound "Translate" and product
// name/description suggestions (spec §3.6, §4, §5). Mounted under requireAuth and
// the arabic_enabled gate by routes/localization/index.js.
//
// Every endpoint only returns a DRAFT: nothing is saved and nothing is sent here —
// the page that asked saves it as a draft (or the staff member sends it) only after
// the merchant's explicit click. All the work, the limits and the verification of
// protected tokens live in shared/localization/aiAssist.js.
//   * workspaceId comes ONLY from req.user (it keys the per-workspace rate limit);
//     the body is never trusted for it
//   * explicit field reads (assertString / assertEnum) — the body is never spread
//   * handler() turns thrown { status, code } errors into JSON and never leaks
//     stack traces or provider text; every error carries a code from CONTRACT §1
const express = require('express');
const { handler, assertString, assertEnum } = require('../../shared/localization/scope');
const aiAssist = require('../../shared/localization/aiAssist');
const { CONTEXTS } = require('../../shared/localization/aiPrompts');

// assertString's own cap (5000, no code) is not ours: the service enforces the
// 4000-character limit with the AI_TEXT_TOO_LONG code.
const NO_CAP = Number.MAX_SAFE_INTEGER;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Gives every failure a code from the closed set (scope.js helpers throw plain 400s)
// and tells a rate-limited client how long to wait.
function aiHandler(fn) {
  return handler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err && typeof err === 'object') {
        if (!err.code && err.status === 400) err.code = 'INVALID_INPUT';
        if (!err.code && !(Number.isInteger(err.status) && err.status < 500)) err.code = 'INTERNAL';
        if (err.retryAfterSeconds) res.set('Retry-After', String(err.retryAfterSeconds));
      }
      throw err;
    }
  });
}

function bodyOf(req) {
  const body = req.body ?? {};
  if (typeof body !== 'object' || Array.isArray(body)) throw badRequest('The request body must be a JSON object');
  return body;
}

function workspaceOf(req) {
  const workspaceId = req.user && req.user.workspaceId;
  if (!workspaceId) {
    const err = new Error('A workspace is required');
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
  }
  return String(workspaceId);
}

const textField = (body, key, { required = false } = {}) => assertString(body[key], key, { max: NO_CAP, required });

function enumField(body, key, allowed, { required = false } = {}) {
  if (body[key] === undefined || body[key] === null) {
    if (required) throw badRequest(`${key} is required`);
    return undefined;
  }
  return assertEnum(body[key], allowed, key);
}

function maxLengthField(body) {
  const value = body.maxLength;
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value)) throw badRequest('maxLength must be a whole number');
  return value;
}

function buttonsField(body) {
  const value = body.buttons;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((label) => typeof label !== 'string')) throw badRequest('buttons must be an array of strings');
  return value;
}

// `assist` is injectable so tests can run the real service against a fake model.
function createRouter(assist = aiAssist) {
  const router = express.Router();

  router.post('/translate', aiHandler(async (req, res) => {
    const body = bodyOf(req);
    res.json(await assist.translate({
      workspaceId: workspaceOf(req),
      text: textField(body, 'text', { required: true }),
      from: enumField(body, 'from', ['en', 'ar', 'auto']),
      to: enumField(body, 'to', ['en', 'ar'], { required: true }),
      context: enumField(body, 'context', CONTEXTS),
      maxLength: maxLengthField(body),
    }));
  }));

  router.post('/saudi-friendly', aiHandler(async (req, res) => {
    const body = bodyOf(req);
    res.json(await assist.saudiFriendly({
      workspaceId: workspaceOf(req),
      text: textField(body, 'text', { required: true }),
      buttons: buttonsField(body),
      context: enumField(body, 'context', CONTEXTS),
      maxLength: maxLengthField(body),
    }));
  }));

  router.post('/reply-in-arabic', aiHandler(async (req, res) => {
    const body = bodyOf(req);
    res.json(await assist.replyInArabic({
      workspaceId: workspaceOf(req),
      englishText: textField(body, 'englishText', { required: true }),
      customerMessage: textField(body, 'customerMessage'),
      customerName: textField(body, 'customerName'),
    }));
  }));

  router.post('/translate-inbound', aiHandler(async (req, res) => {
    const body = bodyOf(req);
    res.json(await assist.translateInbound({
      workspaceId: workspaceOf(req),
      text: textField(body, 'text', { required: true }),
    }));
  }));

  router.post('/suggest-product-translation', aiHandler(async (req, res) => {
    const body = bodyOf(req);
    res.json(await assist.suggestProduct({
      workspaceId: workspaceOf(req),
      name: textField(body, 'name', { required: true }),
      description: textField(body, 'description'),
    }));
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
