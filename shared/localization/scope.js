'use strict';
// Tenant-scoping and input-validation helpers shared by every localisation
// module. Same pattern as the other recent features: define the helpers next
// to the feature (not imported from shared/operations.js) so the feature stays
// standalone, and ALWAYS take workspaceId from the verified token (req.user),
// never from a request body.
const mongoose = require('mongoose');

function withWorkspace(filter, workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required');
  return { ...filter, workspaceId };
}

function scopedFilter(id, workspaceId) {
  assertObjectId(id, 'id');
  return withWorkspace({ _id: id }, workspaceId);
}

// Request BODY fields can arrive as objects ({"$ne": null}); Mongoose does not
// strip query operators from filters, so every client-supplied id used in a
// query filter must be a plain 24-hex string / ObjectId first.
function isObjectIdLike(value) {
  if (value instanceof mongoose.Types.ObjectId) return true;
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function assertObjectId(value, label = 'id') {
  if (!isObjectIdLike(value)) {
    const err = new Error(`Invalid ${label}`);
    err.status = 400;
    throw err;
  }
  return String(value);
}

function assertObjectIdArray(values, label = 'ids', { max = 5000 } = {}) {
  if (!Array.isArray(values)) {
    const err = new Error(`${label} must be an array`);
    err.status = 400;
    throw err;
  }
  if (values.length > max) {
    const err = new Error(`${label} may contain at most ${max} entries`);
    err.status = 400;
    throw err;
  }
  return values.map((v, i) => assertObjectId(v, `${label}[${i}]`));
}

// Explicit allow-list copy — the only way request bodies reach a write.
function pick(source, keys) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) {
    const err = new Error(`${label} must be one of: ${allowed.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return value;
}

function assertString(value, label, { max = 5000, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) { const err = new Error(`${label} is required`); err.status = 400; throw err; }
    return undefined;
  }
  if (typeof value !== 'string') { const err = new Error(`${label} must be a string`); err.status = 400; throw err; }
  if (value.length > max) { const err = new Error(`${label} is too long (max ${max})`); err.status = 400; throw err; }
  if (required && !value.trim()) { const err = new Error(`${label} is required`); err.status = 400; throw err; }
  return value;
}

// Express handler wrapper: forwards thrown { status } errors as JSON, keeps
// everything else a 500. Never leaks stack traces.
function handler(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err && Number.isInteger(err.status) ? err.status : 500;
      if (status >= 500) console.error('[localization]', err && err.message);
      if (!res.headersSent) res.status(status).json({ error: status >= 500 ? 'Something went wrong' : err.message, code: err.code });
    }
  };
}

module.exports = { withWorkspace, scopedFilter, isObjectIdLike, assertObjectId, assertObjectIdArray, pick, assertEnum, assertString, handler };
