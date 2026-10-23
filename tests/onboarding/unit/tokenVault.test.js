'use strict';
const crypto = require('crypto');
const vault = require('../../../shared/onboarding/tokenVault');

const KEY_A = crypto.randomBytes(32).toString('hex');
const KEY_B = crypto.randomBytes(32).toString('base64');
const WS1 = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';
const AR = String.fromCodePoint(0x627);
const TOKEN = 'EAAG-test-token-' + 'x'.repeat(50);

const ENV = ['WA_TOKEN_ENCRYPTION_KEY', 'WA_TOKEN_ENCRYPTION_KEY_PREV', 'SOCIAL_TOKEN_ENCRYPTION_KEY', 'ONBOARDING_ALLOW_SHARED_KEY'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('round trip and envelope', () => {
  test('encrypt -> decrypt returns the plaintext; envelope is v1 and does not contain it', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    expect(env.startsWith('v1:')).toBe(true);
    expect(env).not.toContain(TOKEN);
    expect(env.slice(3).split('.')).toHaveLength(3);
    expect(vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
  });
  test('every encryption uses a fresh IV', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    const a = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    const b = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    expect(a).not.toBe(b);
  });
  test('base64 keys work too, and unicode plaintext survives', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_B;
    const env = vault.encrypt(`pin-123456-${AR}`, { workspaceId: WS1, purpose: 'pin' });
    expect(vault.decrypt(env, { workspaceId: WS1, purpose: 'pin' })).toBe(`pin-123456-${AR}`);
  });
});

describe('AAD binding', () => {
  beforeEach(() => { process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A; });
  test('another workspace cannot decrypt', () => {
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    expect(() => vault.decrypt(env, { workspaceId: WS2, purpose: 'token' })).toThrow(vault.DecryptionFailed);
  });
  test('another purpose cannot decrypt (a PIN is not a token)', () => {
    const env = vault.encrypt('123456', { workspaceId: WS1, purpose: 'pin' });
    expect(() => vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.DecryptionFailed);
  });
  test('ObjectId-like workspace ids are stringified', () => {
    const env = vault.encrypt(TOKEN, { workspaceId: { toString: () => WS1 }, purpose: 'token' });
    expect(vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
  });
  test('tampered ciphertext / tag / iv fails with DecryptionFailed and no data in the message', () => {
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    const [iv, ct, tag] = env.slice(3).split('.');
    const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 0xff; return b.toString('base64'); };
    for (const parts of [[iv, flip(ct), tag], [iv, ct, flip(tag)], [flip(iv), ct, tag]]) {
      let err;
      try { vault.decrypt(`v1:${parts.join('.')}`, { workspaceId: WS1, purpose: 'token' }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(vault.DecryptionFailed);
      expect(err.message).not.toContain(TOKEN);
    }
  });
  test('malformed envelopes fail cleanly', () => {
    for (const bad of ['', 'plain', 'v2:a.b.c', 'v1:a.b', 'v1:..', null, undefined, 42]) {
      expect(() => vault.decrypt(bad, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.DecryptionFailed);
    }
  });
  test('workspaceId and purpose are required', () => {
    expect(() => vault.encrypt(TOKEN, { purpose: 'token' })).toThrow(TypeError);
    expect(() => vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'other' })).toThrow(TypeError);
    expect(() => vault.encrypt('', { workspaceId: WS1, purpose: 'token' })).toThrow(TypeError);
  });
});

describe('key handling', () => {
  test('missing key: typed EncryptionNotConfigured, never plaintext', () => {
    expect(vault.isConfigured()).toBe(false);
    expect(vault.keyVersion()).toBeNull();
    expect(() => vault.assertConfigured()).toThrow(vault.EncryptionNotConfigured);
    let err;
    try { vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(vault.EncryptionNotConfigured);
    expect(err.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect(err.status).toBe(503);
    expect(err.message).not.toContain(TOKEN);
  });
  test('an invalid key (wrong length) is not accepted and is not silently replaced', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = 'tooshort';
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = KEY_A;
    process.env.ONBOARDING_ALLOW_SHARED_KEY = '1';
    expect(vault.isConfigured()).toBe(false);
    expect(() => vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.EncryptionNotConfigured);
  });
  test('NO fallback to SOCIAL_TOKEN_ENCRYPTION_KEY by default', () => {
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(vault.isConfigured()).toBe(false);
    expect(() => vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.EncryptionNotConfigured);
  });
  test('shared key only with ONBOARDING_ALLOW_SHARED_KEY=1', () => {
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = KEY_A;
    process.env.ONBOARDING_ALLOW_SHARED_KEY = '1';
    expect(vault.isConfigured()).toBe(true);
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    expect(vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
  });
  test('the WA key wins over the shared key', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.ONBOARDING_ALLOW_SHARED_KEY = '1';
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    expect(vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
  });
  test('missing key on decrypt: EncryptionNotConfigured', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    expect(() => vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.EncryptionNotConfigured);
  });
  test('wrong key: DecryptionFailed', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    const env = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_B;
    expect(() => vault.decrypt(env, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.DecryptionFailed);
  });
});

describe('rotation', () => {
  test('_PREV decrypts values written with the old key; new writes use the new key', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    const oldEnv = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    const v1 = vault.keyVersion();

    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_B;
    process.env.WA_TOKEN_ENCRYPTION_KEY_PREV = KEY_A;
    expect(vault.decrypt(oldEnv, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
    const newEnv = vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' });
    expect(vault.keyVersion()).not.toBe(v1);

    delete process.env.WA_TOKEN_ENCRYPTION_KEY_PREV;
    expect(vault.decrypt(newEnv, { workspaceId: WS1, purpose: 'token' })).toBe(TOKEN);
    expect(() => vault.decrypt(oldEnv, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.DecryptionFailed);
  });
  test('_PREV is never used to encrypt', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY_PREV = KEY_A;
    expect(vault.isConfigured()).toBe(false);
    expect(() => vault.encrypt(TOKEN, { workspaceId: WS1, purpose: 'token' })).toThrow(vault.EncryptionNotConfigured);
  });
  test('keyVersion is an 8-hex fingerprint that does not reveal the key', () => {
    process.env.WA_TOKEN_ENCRYPTION_KEY = KEY_A;
    expect(vault.keyVersion()).toMatch(/^[0-9a-f]{8}$/);
    expect(KEY_A).not.toContain(vault.keyVersion());
  });
});
