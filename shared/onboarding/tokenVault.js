'use strict';
// Encryption at rest for the merchant's WhatsApp access token and registration
// PIN (DB design section 9). AES-256-GCM, envelope `v1:<b64 iv>.<b64 ct>.<b64 tag>`,
// AAD = `<workspaceId>:whatsapp:<purpose>` so a ciphertext moved to another
// workspace (or used as a PIN instead of a token) fails to decrypt.
//
// Key: WA_TOKEN_ENCRYPTION_KEY (64 hex chars or base64 of 32 bytes). Rotation:
// WA_TOKEN_ENCRYPTION_KEY_PREV is tried for decryption only. There is NO
// fallback to SOCIAL_TOKEN_ENCRYPTION_KEY unless ONBOARDING_ALLOW_SHARED_KEY=1.
// Never stores plaintext: a missing/invalid key throws EncryptionNotConfigured.
// Nothing is read from the environment at require time.
const crypto = require('crypto');
const { allowSharedKey } = require('./config');

const PREFIX = 'v1:';
const PURPOSES = Object.freeze(['token', 'pin']);

class EncryptionNotConfigured extends Error {
  constructor(message) {
    super(message || 'WhatsApp token encryption is not configured');
    this.name = 'EncryptionNotConfigured';
    this.code = 'ENCRYPTION_NOT_CONFIGURED';
    this.status = 503;
  }
}

class DecryptionFailed extends Error {
  constructor() {
    super('Could not decrypt the stored value');
    this.name = 'DecryptionFailed';
    this.code = 'DECRYPTION_FAILED';
  }
}

function parseKey(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  return key.length === 32 ? key : null;
}

/** Current encryption key (Buffer) or null; throws EncryptionNotConfigured when the env holds an INVALID key. */
function currentKey() {
  const raw = process.env.WA_TOKEN_ENCRYPTION_KEY;
  if (raw && String(raw).trim()) {
    const key = parseKey(raw);
    if (!key) throw new EncryptionNotConfigured('WA_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
    return key;
  }
  if (allowSharedKey()) {
    const shared = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    if (shared && String(shared).trim()) {
      const key = parseKey(shared);
      if (!key) throw new EncryptionNotConfigured('SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64)');
      return key;
    }
  }
  return null;
}

function previousKey() {
  const raw = process.env.WA_TOKEN_ENCRYPTION_KEY_PREV;
  return parseKey(raw);
}

function fingerprint(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
}

/** True when a valid current key is available. */
function isConfigured() {
  try { return currentKey() !== null; } catch (_) { return false; }
}

/** Throws EncryptionNotConfigured unless a valid current key is available. */
function assertConfigured() {
  if (currentKey() === null) throw new EncryptionNotConfigured();
}

/** 8-hex fingerprint of the CURRENT key (stored as tokenKeyVersion), or null. */
function keyVersion() {
  try {
    const k = currentKey();
    return k ? fingerprint(k) : null;
  } catch (_) { return null; }
}

function aad(workspaceId, purpose) {
  if (!PURPOSES.includes(purpose)) throw new TypeError(`tokenVault: purpose must be one of ${PURPOSES.join(', ')}`);
  const ws = workspaceId === undefined || workspaceId === null ? '' : String(workspaceId);
  if (!ws) throw new TypeError('tokenVault: workspaceId is required');
  return Buffer.from(`${ws}:whatsapp:${purpose}`, 'utf8');
}

/**
 * @param {string} plaintext non-empty
 * @param {{workspaceId:*, purpose:'token'|'pin'}} ctx
 * @returns {string} v1 envelope
 */
function encrypt(plaintext, ctx = {}) {
  if (plaintext === undefined || plaintext === null || String(plaintext) === '') throw new TypeError('tokenVault: nothing to encrypt');
  const key = currentKey();
  if (!key) throw new EncryptionNotConfigured();
  const aadBuf = aad(ctx.workspaceId, ctx.purpose);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadBuf);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), ct.toString('base64'), tag.toString('base64')].join('.');
}

function tryDecrypt(key, iv, ct, tag, aadBuf) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadBuf);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * @param {string} envelope v1 envelope
 * @param {{workspaceId:*, purpose:'token'|'pin'}} ctx
 * @returns {string} plaintext
 * @throws {EncryptionNotConfigured} no key available; {DecryptionFailed} wrong key/AAD/tampered/malformed
 */
function decrypt(envelope, ctx = {}) {
  if (typeof envelope !== 'string' || !envelope.startsWith(PREFIX)) throw new DecryptionFailed();
  const aadBuf = aad(ctx.workspaceId, ctx.purpose);
  const parts = envelope.slice(PREFIX.length).split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new DecryptionFailed();
  let iv; let ct; let tag;
  try {
    iv = Buffer.from(parts[0], 'base64'); ct = Buffer.from(parts[1], 'base64'); tag = Buffer.from(parts[2], 'base64');
  } catch (_) { throw new DecryptionFailed(); }
  if (iv.length !== 12 || tag.length !== 16) throw new DecryptionFailed();

  const cur = currentKey();
  const prev = previousKey();
  if (!cur && !prev) throw new EncryptionNotConfigured();
  for (const key of [cur, prev]) {
    if (!key) continue;
    try { return tryDecrypt(key, iv, ct, tag, aadBuf); } catch (_) { /* try the next key */ }
  }
  throw new DecryptionFailed();
}

module.exports = {
  encrypt, decrypt, isConfigured, assertConfigured, keyVersion,
  EncryptionNotConfigured, DecryptionFailed, PREFIX,
};
