'use strict';
// X-Hub-Signature-256 verification for POST /webhook (DB design 6.9, decision D8).
// Registered by earlyMounts BEFORE express.json(), so it can read the raw bytes.
//
//   mode (config.webhookSignatureMode): 'off' | 'log' | 'enforce'
//     off      next() as the FIRST statement: the stream is not read, behaviour is identical to today
//     log/enforce  a CONFORMING request (JSON, no Content-Encoding, UTF-8) is read once as raw bytes, HMAC-SHA256 with WA_APP_SECRET,
//              timingSafeEqual, req.metaSignature = 'valid' | 'invalid' | 'absent' | 'unconfigured', req.body = the parsed JSON.
//              The stream is finished afterwards, so body-parser 2.x (read.js: onFinished.isFinished(req) -> next()) skips it:
//              no hang, no double parse. EVERY OTHER request (urlencoded, text/plain, octet-stream, gzip / deflate / any encoded body,
//              another charset, no body) is handed to the legacy parser UNTOUCHED (next() before the stream is read), so it is answered
//              exactly as it is today (review R1-F2). A conforming body that is not valid JSON is passed on as the SyntaxError body-parser
//              itself would raise (status 400, type entity.parse.failed): the legacy error path answers.
//   body size (review R1-F1): Meta ALWAYS signs. A request WITHOUT an x-hub-signature-256 header keeps the legacy 100 kB limit (a larger
//     declared length is left to express.json(), which answers 413 exactly as before; an undeclared one is cut at 100 kB with a 413),
//     the 3 MB (Meta's maximum) is only read when the header is present. So an anonymous caller can never make this process buffer 3 MB.
//   enforcement scope (orchestrator ruling 1, WEBHOOK SIGNATURE SAFETY): in 'enforce' mode ONLY a payload that
//     POSITIVELY matches a merchant WhatsAppConnection (an entry id or metadata.phone_number_id found through the
//     same memoised lookup webhookEvents uses, over the FIRST 20 entries only) AND carries an invalid or absent signature is rejected
//     with 403. EVERY other payload (the platform's own, no entry id, an unknown WABA, a failing lookup) passes through
//     unchanged in EVERY mode, so a mis-set WA_WABA_ID or WA_APP_SECRET can never break the owner's live webhook.
//     'log' mode only logs (never rejects). WA_APP_SECRET unset -> 'unconfigured': merchant payloads are unsigned
//     hints (webhookEvents trusts content only when 'valid'). The merchant lookup is bounded (1.5 s) and a
//     timeout or a DB error is "not a merchant payload" (logged, throttled).
const crypto = require('crypto');
const config = require('./config');
const failOpen = require('./failOpen');

const MAX_BYTES = 3 * 1024 * 1024;
const MAX_UNSIGNED_BYTES = 100 * 1024; // express.json()'s default limit ('100kb')
const LOG_EVERY_MS = 60 * 1000;
const LOOKUP_TIMEOUT_MS = 1500;

/** @returns {string} 'sha256=<hex>' */
function computeSignature(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/**
 * Constant-time check of an X-Hub-Signature-256 header value.
 * @param {Buffer|string} rawBody
 * @param {string} header
 * @param {string} secret
 * @returns {boolean}
 */
function verify(rawBody, header, secret) {
  if (typeof header !== 'string' || !header || !secret) return false;
  const expected = Buffer.from(computeSignature(rawBody, secret));
  const got = Buffer.from(header.trim().toLowerCase());
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

/**
 * Read the whole request stream (bounded). Rejects with code TOO_LARGE or ABORTED.
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<Buffer>}
 */
function readRawBody(req, maxBytes = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' }));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.removeListener('data', onData); // eslint-disable-line no-use-before-define
      req.removeListener('end', onEnd); // eslint-disable-line no-use-before-define
      req.removeListener('error', onError); // eslint-disable-line no-use-before-define
      req.removeListener('close', onClose); // eslint-disable-line no-use-before-define
    };
    const settle = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    function onData(chunk) {
      size += chunk.length;
      if (size > maxBytes) { settle(reject, Object.assign(new Error('payload too large'), { code: 'TOO_LARGE' })); return; }
      chunks.push(chunk);
    }
    function onEnd() { settle(resolve, Buffer.concat(chunks, size)); }
    function onError(err) { settle(reject, err); }
    function onClose() { settle(reject, Object.assign(new Error('request aborted'), { code: 'ABORTED' })); }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('close', onClose);
  });
}

/** The x-hub-signature-256 header value (first one when repeated), or null when absent or blank. */
function signatureHeaderOf(req) {
  const v = req && req.headers && req.headers['x-hub-signature-256'];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === 'string' && s.trim() ? s : null;
}

/** charset parameter of a Content-Type header, lower-case; null when there is none. */
function charsetOf(contentType) {
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(String(contentType || ''));
  if (!m) return null;
  return String(m[1] !== undefined ? m[1] : m[2]).trim().toLowerCase();
}

/**
 * Is this a request that body-parser's express.json() would read as plain JSON, so that this middleware may take it over without
 * changing the answer? application/json with a body, NO Content-Encoding header (even `identity`), and no charset other than UTF-8.
 * Everything else must reach the legacy parser untouched (review R1-F2).
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function conformingJson(req) {
  if (!req) return false;
  const h = req.headers || {};
  const enc = h['content-encoding'];
  if (enc !== undefined && String(enc).trim() !== '') return false;
  if (typeof req.is === 'function') {
    if (!req.is('application/json')) return false; // express: type-is, the same test express.json() applies (null without a body)
  } else {
    const hasBody = h['transfer-encoding'] !== undefined || (h['content-length'] !== undefined && !Number.isNaN(Number(h['content-length'])));
    const type = String(h['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!hasBody || type !== 'application/json') return false;
  }
  const charset = charsetOf(h['content-type']);
  return charset === null || charset === 'utf-8';
}

const FIRST_CHAR = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d])/; // eslint-disable-line no-control-regex

/**
 * Parse a JSON body the way express.json() (body-parser 2.x, strict mode) does: a UTF-8 BOM is dropped, an empty body is {}, the first
 * non-blank character must be { or [, anything else is a SyntaxError with status 400, type entity.parse.failed and body-parser's own
 * message. Throws that error (to be passed to next()).
 * @param {Buffer} raw
 * @returns {object|Array}
 */
function parseLikeLegacy(raw) {
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    if (text.length === 0) return {};
    const m = FIRST_CHAR.exec(text);
    const first = m ? m[1] : undefined;
    if (first !== '{' && first !== '[') {
      // the native message of JSON.parse for the same input (body-parser builds it exactly like this)
      const index = text.indexOf(first);
      const partial = index === -1 ? '' : `${text.substring(0, index)}${'#'.repeat(text.length - index)}`;
      try { JSON.parse(partial); } catch (e) {
        throw new SyntaxError(e.message.replace(/#+/g, (placeholder) => text.substring(index, index + placeholder.length)));
      }
      throw new SyntaxError('strict violation');
    }
    return JSON.parse(text);
  } catch (err) {
    const out = err instanceof SyntaxError ? err : new SyntaxError(String((err && err.message) || 'invalid JSON'));
    out.status = 400;
    out.statusCode = 400;
    out.expose = true;
    out.type = 'entity.parse.failed';
    throw out;
  }
}

/**
 * @param {{mode?:()=>string, secret?:()=>string|null, isMerchant?:(body:object)=>Promise<boolean>, log?:Function, now?:()=>number, maxBytes?:number, maxUnsignedBytes?:number, lookupTimeoutMs?:number}} [deps]
 *   isMerchant: positive merchant match of a parsed payload (default: webhookEvents.matchesMerchant, the memoised lookup)
 * @returns {import('express').RequestHandler}
 */
function createMiddleware(deps = {}) {
  const getMode = deps.mode || (() => config.webhookSignatureMode());
  const getSecret = deps.secret || (() => (process.env.WA_APP_SECRET ? String(process.env.WA_APP_SECRET).trim() || null : null));
  const isMerchant = deps.isMerchant || ((body) => require('./webhookEvents').matchesMerchant(body));
  const lookupTimeoutMs = deps.lookupTimeoutMs || LOOKUP_TIMEOUT_MS;
  const now = deps.now || (() => Date.now());
  const logFn = deps.log || ((...a) => config.safeLog('warn', '[onboarding webhook]', ...a));
  const maxBytes = deps.maxBytes || MAX_BYTES;
  const maxUnsignedBytes = Math.min(maxBytes, deps.maxUnsignedBytes || MAX_UNSIGNED_BYTES);
  const lastLogged = new Map();
  const logThrottled = (key, ...args) => {
    const t = now();
    const prev = lastLogged.get(key);
    if (prev !== undefined && t - prev < LOG_EVERY_MS) return;
    lastLogged.set(key, t);
    logFn(...args);
  };

  /** Positive merchant match, bounded in time; any error or timeout is "not a merchant payload" (and logged, throttled). */
  async function merchantPayload(body) {
    try {
      return (await failOpen.withTimeout(() => isMerchant(body), lookupTimeoutMs, 'merchant lookup')) === true;
    } catch (err) {
      failOpen.logFailOpen('webhookSignature', err, now());
      return false;
    }
  }

  return async function webhookSignatureMiddleware(req, res, next) {
    const mode = getMode();
    if (mode === 'off') return next();
    // review R1-F2: only a conforming JSON request is taken over; the legacy parser answers everything else exactly as before
    if (!conformingJson(req)) return next();

    const hasSignature = signatureHeaderOf(req) !== null;
    // review R1-F1: Meta always signs, so a request without the header keeps the legacy 100 kB limit (3 MB only with the header)
    const limit = hasSignature ? maxBytes : maxUnsignedBytes;
    if (!hasSignature) {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) return next(); // express.json() answers 413 exactly as it always did
    }

    let raw;
    try {
      raw = await readRawBody(req, limit);
    } catch (err) {
      if (err && err.code === 'TOO_LARGE') {
        if (!res.headersSent) { res.set('Connection', 'close'); res.status(413).json({ error: 'Payload too large' }); }
        return undefined;
      }
      if (err && err.code === 'ABORTED') return undefined;
      return next(err);
    }

    let parsed;
    try { parsed = parseLikeLegacy(raw); } catch (parseErr) { return next(parseErr); } // the legacy error path answers (400)

    const secret = getSecret();
    let signature;
    if (!secret) signature = 'unconfigured';
    else {
      const header = signatureHeaderOf(req);
      signature = !header ? 'absent' : (verify(raw, header, secret) ? 'valid' : 'invalid');
    }
    req.metaSignature = signature;
    req.body = parsed;

    // Only a bad (invalid / absent) signature needs the scope decision: a valid or unconfigured one never rejects.
    if (signature === 'invalid' || signature === 'absent') {
      const merchant = await merchantPayload(parsed);
      const scope = merchant ? 'merchant' : 'platform';
      logThrottled(`${scope}:${signature}:${mode}`, `signature ${signature} on a ${scope} payload (mode ${mode})`);
      if (mode === 'enforce' && merchant) {
        if (!res.headersSent) res.status(403).json({ error: 'Invalid signature' });
        return undefined;
      }
    }
    return next();
  };
}

const middleware = createMiddleware();

module.exports = {
  middleware, computeSignature, verify, createMiddleware, readRawBody, conformingJson, parseLikeLegacy,
  MAX_BYTES, MAX_UNSIGNED_BYTES, LOOKUP_TIMEOUT_MS,
};
