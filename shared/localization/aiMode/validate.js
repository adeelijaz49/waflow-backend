'use strict';
// Request validation for /api/localization/ai-mode/*. Every failure is a 400 with
// a stable `code` from the closed set in CONTRACT §1; the page maps the code to
// localised text. Strict types matter here: a JSON body can carry an object where
// a string belongs ({"$ne": null}), and these values end up in database filters.
const { MAX_MESSAGE_LENGTH, normalizeUserMessage } = require('./normalize');

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{8,100}$/;
const MAX_ACTION_ID_LENGTH = 100;

function badRequest(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

// The browser generates the id (crypto.randomUUID()); it is only ever compared as a string.
function parseSessionId(value) {
  if (typeof value !== 'string' || !SESSION_ID_RE.test(value)) {
    throw badRequest('INVALID_INPUT', 'sessionId must be a string of 8 to 100 letters, digits, "-", "_", "." or ":"');
  }
  return value;
}

// Returns the message as received (the agent stores a cleaned copy and gives the
// model a digit-normalised one). Length is measured on what the merchant typed.
function parseMessage(value) {
  if (value === undefined || value === null) throw badRequest('MESSAGE_REQUIRED', 'message is required');
  if (typeof value !== 'string') throw badRequest('INVALID_INPUT', 'message must be a string');
  if (value.length > MAX_MESSAGE_LENGTH) throw badRequest('MESSAGE_TOO_LONG', `message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  if (!normalizeUserMessage(value).text) throw badRequest('MESSAGE_REQUIRED', 'message is required');
  return value;
}

// An optional language override: absent -> undefined (the caller falls back to
// the saved preference); anything outside `allowed` is INVALID_LANGUAGE.
function parseLanguage(value, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest('INVALID_LANGUAGE', `language must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

// The client says WHICH action and whether to run it; it never supplies what runs.
function parseConfirmBody(body) {
  const { actionId, confirm } = body;
  if (typeof actionId !== 'string' || !actionId || actionId.length > MAX_ACTION_ID_LENGTH) {
    throw badRequest('INVALID_INPUT', 'actionId must be a non-empty string');
  }
  if (typeof confirm !== 'boolean') throw badRequest('INVALID_INPUT', 'confirm must be true or false');
  return { actionId, confirm };
}

// Express 5 leaves req.body undefined when nothing was sent, and a JSON array or
// primitive is a valid body: only a plain object is accepted.
function bodyOf(req) {
  const body = req.body ?? {};
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

module.exports = { SESSION_ID_RE, badRequest, parseSessionId, parseMessage, parseLanguage, parseConfirmBody, bodyOf };
