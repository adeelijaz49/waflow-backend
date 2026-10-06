// AES-256-GCM encrypt/decrypt for Instagram access/refresh tokens at rest
// (models/SocialAccount.js's accessTokenEncrypted/refreshTokenEncrypted).
// Needs SOCIAL_TOKEN_ENCRYPTION_KEY — a 32-byte key, base64 or hex encoded —
// set in the environment. Degrades loudly (throws with a clear message
// before ever writing a token) rather than silently storing plaintext,
// matching this app's existing convention of warning on a missing optional
// secret (AUTH_JWT_SECRET, INTERNAL_ADMIN_USER) but never faking security.
const crypto = require('crypto');

function loadKey() {
  const raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY is not set — cannot store Instagram tokens securely.');
  // Accept either a 64-char hex string or a base64 string that decodes to 32 bytes.
  let key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SOCIAL_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (hex or base64).');
  return key;
}

function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return undefined;
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv.ciphertext.authTag, each base64 — self-contained, no separate IV storage needed.
  return [iv.toString('base64'), ciphertext.toString('base64'), authTag.toString('base64')].join('.');
}

function decrypt(encoded) {
  if (!encoded) return undefined;
  const [ivB64, ciphertextB64, authTagB64] = encoded.split('.');
  if (!ivB64 || !ciphertextB64 || !authTagB64) throw new Error('Malformed encrypted token value');
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
