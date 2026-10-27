// Unit tests for utils/waTenant.js (which WhatsApp number a customer sends from). No database and no network: the Workspace
// model, the token vault, the platform token manager and axios are all mocked.
jest.mock('../models/Workspace', () => ({ findById: jest.fn() }));
jest.mock('../shared/onboarding/tokenVault', () => ({ decrypt: jest.fn() }));
jest.mock('../utils/tokenManager', () => ({ getToken: jest.fn(() => 'PLATFORM_TOKEN') }));
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const axios = require('axios');
const Workspace = require('../models/Workspace');
const tokenVault = require('../shared/onboarding/tokenVault');
const tokenManager = require('../utils/tokenManager');
const senderContext = require('../utils/senderContext');
const waTenant = require('../utils/waTenant');

const WS_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const WS_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const PLATFORM_WABA = '222222222222222';
const PLATFORM_PHONE = '111111111111111';

let docs; // workspaceId -> lean workspace document (or an Error to throw)
const savedEnv = {};

function stubWorkspaceLookup() {
  Workspace.findById.mockImplementation((id) => ({
    select: () => ({
      lean: async () => {
        const d = docs[String(id)];
        if (d instanceof Error) throw d;
        if (typeof d === 'function') return d(); // a read the test controls (see `gate`): resolves or fails when the test says so
        return d === undefined ? null : d;
      },
    }),
  }));
}

beforeEach(() => {
  for (const k of ['WA_PHONE_ID', 'WA_WABA_ID']) savedEnv[k] = process.env[k];
  process.env.WA_PHONE_ID = PLATFORM_PHONE;
  process.env.WA_WABA_ID = PLATFORM_WABA;
  docs = {};
  Workspace.findById.mockReset(); stubWorkspaceLookup();
  tokenVault.decrypt.mockReset();
  tokenManager.getToken.mockReset(); tokenManager.getToken.mockReturnValue('PLATFORM_TOKEN');
  axios.get.mockReset(); axios.post.mockReset();
  waTenant._resetForTests();
});
afterEach(() => {
  for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  jest.restoreAllMocks();
});

describe('platformSender', () => {
  test('is the platform number, token and WABA (synchronously)', () => {
    expect(waTenant.platformSender()).toMatchObject({
      source: 'platform', workspaceId: null, phoneId: PLATFORM_PHONE, wabaId: PLATFORM_WABA, token: 'PLATFORM_TOKEN', displayNumber: null,
    });
  });
  test('the phone id falls back to the production default when WA_PHONE_ID is unset', () => {
    delete process.env.WA_PHONE_ID;
    expect(waTenant.platformSender().phoneId).toBe('1032683093271618');
  });
  test('the token is read fresh each time (the platform token is refreshed in place)', () => {
    tokenManager.getToken.mockReturnValueOnce('T1').mockReturnValueOnce('T2');
    expect(waTenant.platformSender().token).toBe('T1');
    expect(waTenant.platformSender().token).toBe('T2');
  });
});

describe('resolveSender: falls back to the platform number only when the workspace has no number of its own', () => {
  test.each([
    ['no workspace id', undefined],
    ['an empty workspace id', ''],
    ['an id that is not an ObjectId', 'not-an-object-id'],
  ])('%s -> platform, without touching the database', async (_label, id) => {
    const s = await waTenant.resolveSender(id);
    expect(s).toMatchObject({ source: 'platform', phoneId: PLATFORM_PHONE, token: 'PLATFORM_TOKEN' });
    expect(Workspace.findById).not.toHaveBeenCalled();
  });

  test('a workspace document that does not exist -> platform', async () => {
    expect(await waTenant.resolveSender(WS_A)).toMatchObject({ source: 'platform', workspaceId: WS_A, phoneId: PLATFORM_PHONE });
  });

  test('a workspace with no whatsapp settings, an empty phone id or only the legacy plaintext token -> platform', async () => {
    docs[WS_A] = { _id: WS_A, name: 'x' };
    docs[WS_B] = { _id: WS_B, whatsapp: { phoneId: '   ', token: 'LEGACY_PLAINTEXT', wabaId: 'w' } };
    expect((await waTenant.resolveSender(WS_A)).source).toBe('platform');
    const b = await waTenant.resolveSender(WS_B);
    expect(b.source).toBe('platform');
    expect(b.token).toBe('PLATFORM_TOKEN'); // the legacy plaintext field is never read
  });

  test('enabled:false switches an own number off -> platform (and a number with enabled unset is on)', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '555', enabled: false, tokenEncrypted: 'v1:x', wabaId: 'W9' } };
    docs[WS_B] = { whatsapp: { phoneId: '666', wabaId: PLATFORM_WABA } };
    expect((await waTenant.resolveSender(WS_A)).source).toBe('platform');
    expect(tokenVault.decrypt).not.toHaveBeenCalled();
    expect((await waTenant.resolveSender(WS_B)).source).toBe('tenant');
  });
});

describe('resolveSender: a number inside the platform WABA needs no token of its own', () => {
  test('phone id only (no WABA, no token) -> the tenant phone id with the platform token and WABA', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '555000', displayPhoneNumber: '+966 50 111 2222' } };
    const s = await waTenant.resolveSender(WS_A);
    expect(s).toMatchObject({
      source: 'tenant', workspaceId: WS_A, phoneId: '555000', wabaId: PLATFORM_WABA, token: 'PLATFORM_TOKEN',
      displayNumber: '+966 50 111 2222', sharesPlatformWaba: true, ownToken: false,
    });
    expect(tokenVault.decrypt).not.toHaveBeenCalled();
  });

  test('wabaId equal to the platform WABA and no token -> allowed', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '555000', wabaId: PLATFORM_WABA } };
    expect(await waTenant.resolveSender(WS_A)).toMatchObject({ source: 'tenant', wabaId: PLATFORM_WABA, token: 'PLATFORM_TOKEN' });
  });

  test('the platform token inside the memo is never frozen: a refreshed platform token is used immediately', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '555000' } };
    expect((await waTenant.resolveSender(WS_A)).token).toBe('PLATFORM_TOKEN');
    tokenManager.getToken.mockReturnValue('PLATFORM_TOKEN_REFRESHED');
    expect((await waTenant.resolveSender(WS_A)).token).toBe('PLATFORM_TOKEN_REFRESHED');
    expect(Workspace.findById).toHaveBeenCalledTimes(1); // second answer came from the memo
  });

  test('a DIFFERENT WABA and no token of its own -> throws (the platform token is not valid for it); never the platform number', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '555000', wabaId: 'OTHER_WABA' } };
    const err = await waTenant.resolveSender(WS_A).catch((e) => e);
    expect(err).toBeInstanceOf(waTenant.WhatsAppNumberUnavailable);
    expect(err).toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', status: 409, reason: 'no_token', workspaceId: WS_A });
  });

  test('a WABA that cannot be compared (platform WABA unknown and undiscoverable) -> throws, fail closed', async () => {
    delete process.env.WA_WABA_ID;
    axios.get.mockRejectedValue(new Error('network down'));
    docs[WS_A] = { whatsapp: { phoneId: '555000', wabaId: 'SOME_WABA' } };
    await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', reason: 'no_token' });
  });
});

describe('resolveSender: a number with its own token', () => {
  const ENVELOPE = 'v1:aXY=.Y3Q=.dGFn';

  test('decrypts with the workspace-bound context and uses ITS phone id, WABA and token', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', wabaId: 'OWN_WABA', tokenEncrypted: ENVELOPE, tokenIsValid: true, displayPhoneNumber: '+1 555 0100' } };
    tokenVault.decrypt.mockReturnValue('TENANT_TOKEN_A');
    const s = await waTenant.resolveSender(WS_A);
    expect(tokenVault.decrypt).toHaveBeenCalledWith(ENVELOPE, { workspaceId: WS_A, purpose: 'token' });
    expect(s).toMatchObject({
      source: 'tenant', workspaceId: WS_A, phoneId: '777000', wabaId: 'OWN_WABA', token: 'TENANT_TOKEN_A',
      displayNumber: '+1 555 0100', ownToken: true, sharesPlatformWaba: false,
    });
  });

  test('tokenIsValid undefined (never checked) is allowed; the lookup asks for the encrypted field explicitly', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', wabaId: 'OWN_WABA', tokenEncrypted: ENVELOPE } };
    tokenVault.decrypt.mockReturnValue('T');
    expect((await waTenant.resolveSender(WS_A)).token).toBe('T');
    const selectArg = Workspace.findById.mock.results[0].value.select;
    expect(typeof selectArg).toBe('function'); // chain used .select(...)
  });

  test('a decrypt failure THROWS - it never falls back to the platform number', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', wabaId: 'OWN_WABA', tokenEncrypted: ENVELOPE } };
    const decryptError = Object.assign(new Error('Could not decrypt the stored value'), { code: 'DECRYPTION_FAILED' });
    tokenVault.decrypt.mockImplementation(() => { throw decryptError; });
    const err = await waTenant.resolveSender(WS_A).catch((e) => e);
    expect(err).toBeInstanceOf(waTenant.WhatsAppNumberUnavailable);
    expect(err).toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', status: 409, reason: 'token_unreadable' });
  });

  test('encryption key not configured at all -> throws too', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', tokenEncrypted: ENVELOPE } };
    tokenVault.decrypt.mockImplementation(() => { throw Object.assign(new Error('not configured'), { code: 'ENCRYPTION_NOT_CONFIGURED', status: 503 }); });
    await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
  });

  test('an empty decrypted value -> throws', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', tokenEncrypted: ENVELOPE } };
    tokenVault.decrypt.mockReturnValue('');
    await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
  });

  test('tokenIsValid === false -> throws before decrypting anything', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', wabaId: 'OWN_WABA', tokenEncrypted: ENVELOPE, tokenIsValid: false } };
    const err = await waTenant.resolveSender(WS_A).catch((e) => e);
    expect(err).toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', status: 409, reason: 'token_invalid' });
    expect(tokenVault.decrypt).not.toHaveBeenCalled();
  });

  test('an unreadable lookup (database error) throws instead of guessing the platform number', async () => {
    docs[WS_A] = new Error('connection reset');
    await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', reason: 'lookup_failed' });
  });

  test('the error never carries the token or the ciphertext', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', tokenEncrypted: ENVELOPE, tokenIsValid: false } };
    const err = await waTenant.resolveSender(WS_A).catch((e) => e);
    const dump = JSON.stringify({ message: err.message, ...err }) + String(err.stack);
    expect(dump).not.toContain(ENVELOPE);
    expect(dump).not.toContain('TENANT_TOKEN');
  });
});

describe('memo (60 seconds) and invalidate', () => {
  test('a second resolve is served from the memo; invalidate(ws) forces a re-read of that workspace only', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '111' } };
    docs[WS_B] = { whatsapp: { phoneId: '222' } };
    await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_B);
    expect(Workspace.findById).toHaveBeenCalledTimes(2);
    docs[WS_A] = { whatsapp: { phoneId: '333' } };
    expect((await waTenant.resolveSender(WS_A)).phoneId).toBe('111'); // still the memo
    waTenant.invalidate(WS_A);
    expect((await waTenant.resolveSender(WS_A)).phoneId).toBe('333');
    await waTenant.resolveSender(WS_B);
    expect(Workspace.findById).toHaveBeenCalledTimes(3); // B untouched
  });

  test('invalidate() with no argument clears everything', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '111' } };
    docs[WS_B] = { whatsapp: { phoneId: '222' } };
    await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_B);
    waTenant.invalidate();
    await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_B);
    expect(Workspace.findById).toHaveBeenCalledTimes(4);
  });

  test('the memo expires after 60 seconds', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '111' } };
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await waTenant.resolveSender(WS_A);
    spy.mockReturnValue(now + 59 * 1000);
    await waTenant.resolveSender(WS_A);
    expect(Workspace.findById).toHaveBeenCalledTimes(1);
    docs[WS_A] = { whatsapp: { phoneId: '999' } };
    spy.mockReturnValue(now + 61 * 1000);
    expect((await waTenant.resolveSender(WS_A)).phoneId).toBe('999');
    expect(Workspace.findById).toHaveBeenCalledTimes(2);
  });

  test('a failure is not memoised: once the number is repaired the next resolve works', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '111', tokenEncrypted: 'v1:x', tokenIsValid: false } };
    await expect(waTenant.resolveSender(WS_A)).rejects.toBeTruthy();
    docs[WS_A] = { whatsapp: { phoneId: '111', tokenEncrypted: 'v1:x', tokenIsValid: true } };
    tokenVault.decrypt.mockReturnValue('FIXED');
    expect((await waTenant.resolveSender(WS_A)).token).toBe('FIXED');
  });

  describe('when the database fails to re-read a number that was known a moment ago', () => {
    const OWN = { whatsapp: { phoneId: '777000', wabaId: 'OWN_WABA', tokenEncrypted: 'v1:x', tokenIsValid: true } };
    let now; let spy; let warn;
    beforeEach(() => {
      now = Date.now();
      spy = jest.spyOn(Date, 'now').mockImplementation(() => now);
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      tokenVault.decrypt.mockReturnValue('TENANT_TOKEN');
      docs[WS_A] = OWN;
    });
    const at = (seconds) => { now += seconds * 1000; };

    test('the entry that expired a moment ago keeps being used (and the database is tried again after a few seconds)', async () => {
      expect((await waTenant.resolveSender(WS_A)).token).toBe('TENANT_TOKEN');
      docs[WS_A] = new Error('429 throttled');
      at(61); // expired
      let s = await waTenant.resolveSender(WS_A);
      expect(s).toMatchObject({ source: 'tenant', phoneId: '777000', token: 'TENANT_TOKEN' }); // not a failure, not the platform number
      expect(warn).toHaveBeenCalledTimes(1);
      expect(Workspace.findById).toHaveBeenCalledTimes(2);
      at(3);
      await waTenant.resolveSender(WS_A); // inside the retry pause: no new read, no new warning
      expect(Workspace.findById).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      docs[WS_A] = { whatsapp: { ...OWN.whatsapp, phoneId: '888000' } }; // the database is back
      at(3);
      s = await waTenant.resolveSender(WS_A);
      expect(s.phoneId).toBe('888000');
      expect(Workspace.findById).toHaveBeenCalledTimes(3);
    });

    test('an own number is not used for ever: after ten minutes without a successful read it fails closed again', async () => {
      await waTenant.resolveSender(WS_A);
      docs[WS_A] = new Error('connection reset');
      at(60 + 9 * 60); // 9 minutes past the memo: still the stale entry
      await expect(waTenant.resolveSender(WS_A)).resolves.toMatchObject({ phoneId: '777000' });
      at(2 * 60); // 11 minutes past it (the stale answer never counts as a fresh read)
      await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', reason: 'lookup_failed' });
    });

    test('a number that was never read, or was just changed (invalidate), still fails closed', async () => {
      docs[WS_B] = new Error('connection reset');
      await expect(waTenant.resolveSender(WS_B)).rejects.toMatchObject({ reason: 'lookup_failed' }); // never known
      await waTenant.resolveSender(WS_A);
      waTenant.invalidate(WS_A); // the number or the token was just changed: what was known is no longer true
      docs[WS_A] = new Error('connection reset');
      at(61);
      await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ reason: 'lookup_failed' });
    });

    test('only a failed LOOKUP is bridged: a number the database now says is unusable fails at once', async () => {
      await waTenant.resolveSender(WS_A);
      docs[WS_A] = { whatsapp: { ...OWN.whatsapp, tokenIsValid: false } };
      at(61);
      await expect(waTenant.resolveSender(WS_A)).rejects.toMatchObject({ reason: 'token_invalid' });
      expect(warn).not.toHaveBeenCalled();
    });

    // A database read the test releases by hand: its answer (or failure) arrives when the test says so.
    const gate = () => {
      let resolve; let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      return { promise, resolve, reject };
    };
    // Resolves WS_A once with the original number, lets the memo run out, then hands out the next reads from `reads` in order.
    async function expiredWithReads(reads) {
      await waTenant.resolveSender(WS_A);
      at(61);
      let n = 0;
      docs[WS_A] = () => reads[n++]();
    }
    const flush = () => new Promise((r) => setImmediate(r));

    test('a read that fails AFTER another request has read the number successfully uses that answer and does not write the old entry over it', async () => {
      const slow = gate();
      await expiredWithReads([() => slow.promise, async () => ({ whatsapp: { ...OWN.whatsapp, phoneId: '888000' } })]);
      const failing = waTenant.resolveSender(WS_A); // read 1: still waiting
      await flush();
      const fresh = await waTenant.resolveSender(WS_A); // read 2: succeeds and is stored
      expect(fresh.phoneId).toBe('888000');
      slow.reject(Object.assign(new Error('429'), {}));
      expect((await failing).phoneId).toBe('888000'); // not the number from before the change, and not an error
      expect(Workspace.findById).toHaveBeenCalledTimes(3);
      expect((await waTenant.resolveSender(WS_A)).phoneId).toBe('888000'); // the memo still holds the fresh entry (no new read)
      expect(Workspace.findById).toHaveBeenCalledTimes(3);
    });

    test('invalidate() while a read is under way: if that read then fails, the entry that was dropped is NOT brought back - the send fails closed', async () => {
      const slow = gate();
      await expiredWithReads([() => slow.promise]);
      const failing = waTenant.resolveSender(WS_A);
      await flush();
      waTenant.invalidate(WS_A); // the owner just changed the number or the token
      slow.reject(new Error('connection reset'));
      await expect(failing).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE', reason: 'lookup_failed' });
    });

    test('invalidate() while a read is under way: if that read succeeds with data from before the change, it serves that call only and is NOT stored', async () => {
      const slow = gate();
      await expiredWithReads([() => slow.promise, async () => ({ whatsapp: { ...OWN.whatsapp, phoneId: '999000' } })]);
      const inFlight = waTenant.resolveSender(WS_A);
      await flush();
      waTenant.invalidate(WS_A);
      slow.resolve({ whatsapp: { ...OWN.whatsapp, phoneId: 'BEFORE_THE_CHANGE' } });
      expect((await inFlight).phoneId).toBe('BEFORE_THE_CHANGE'); // that request began before the change
      expect((await waTenant.resolveSender(WS_A)).phoneId).toBe('999000'); // the next one reads again and sees the change
    });

    test('invalidate() with no argument does the same for every workspace', async () => {
      const slow = gate();
      await expiredWithReads([() => slow.promise]);
      const failing = waTenant.resolveSender(WS_A);
      await flush();
      waTenant.invalidate();
      slow.reject(new Error('connection reset'));
      await expect(failing).rejects.toMatchObject({ reason: 'lookup_failed' });
    });

    test('a customer on the platform number (no number of its own) is bridged the same way', async () => {
      docs[WS_A] = { whatsapp: {} };
      expect(await waTenant.resolveSender(WS_A)).toMatchObject({ source: 'platform', workspaceId: WS_A });
      docs[WS_A] = new Error('429 throttled');
      at(61);
      expect(await waTenant.resolveSender(WS_A)).toMatchObject({ source: 'platform', workspaceId: WS_A });
    });
  });

  test('a decrypted token is memoised (decrypted once per minute, not once per message)', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '111', wabaId: 'W1', tokenEncrypted: 'v1:x' } };
    tokenVault.decrypt.mockReturnValue('TT');
    await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_A); await waTenant.resolveSender(WS_A);
    expect(tokenVault.decrypt).toHaveBeenCalledTimes(1);
  });
});

describe('resolveCurrent / runPlatform (follows utils/senderContext.js)', () => {
  beforeEach(() => {
    docs[WS_A] = { whatsapp: { phoneId: '111', wabaId: 'WABA_A', tokenEncrypted: 'v1:a' } };
    docs[WS_B] = { whatsapp: { phoneId: '222', wabaId: 'WABA_B', tokenEncrypted: 'v1:b' } };
    tokenVault.decrypt.mockImplementation((env) => (env === 'v1:a' ? 'TOKEN_A' : 'TOKEN_B'));
  });

  test('no context -> platform', async () => {
    expect(await waTenant.resolveCurrent()).toMatchObject({ source: 'platform', phoneId: PLATFORM_PHONE });
  });

  test('inside a workspace context -> that workspace\'s number', async () => {
    const s = await senderContext.run(WS_A, () => waTenant.resolveCurrent());
    expect(s).toMatchObject({ source: 'tenant', phoneId: '111', token: 'TOKEN_A', wabaId: 'WABA_A' });
  });

  test('runPlatform forces the platform number even inside a workspace context (OTP / invite)', async () => {
    const s = await senderContext.run(WS_A, () => waTenant.runPlatform(() => waTenant.resolveCurrent()));
    expect(s).toMatchObject({ source: 'platform', phoneId: PLATFORM_PHONE, token: 'PLATFORM_TOKEN' });
    // ... and the context is back to the workspace afterwards
    const after = await senderContext.run(WS_A, async () => { await waTenant.runPlatform(async () => {}); return waTenant.resolveCurrent(); });
    expect(after.phoneId).toBe('111');
  });

  // A customer that has its own number NOW, answering someone who wrote to the SHARED number (an old chat): the customer's 24-hour
  // window is with the shared number, so the answer leaves from it - and a broken own number does not stop that answer either.
  test('work that arrived on the SHARED number is answered from the shared number even when the workspace has a number of its own', async () => {
    const s = await senderContext.run(WS_A, () => waTenant.resolveCurrent(), { viaPlatformNumber: true });
    expect(s).toMatchObject({ source: 'platform', workspaceId: WS_A, phoneId: PLATFORM_PHONE, token: 'PLATFORM_TOKEN', wabaId: PLATFORM_WABA });
    const own = await senderContext.run(WS_A, () => waTenant.resolveCurrent()); // the same workspace, an event on its own number
    expect(own).toMatchObject({ source: 'tenant', phoneId: '111' });
    docs[WS_A].whatsapp.tokenIsValid = false;
    waTenant.invalidate(WS_A);
    await expect(senderContext.run(WS_A, () => waTenant.resolveCurrent())).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
    await expect(senderContext.run(WS_A, () => waTenant.resolveCurrent({ waba: false }), { viaPlatformNumber: true })).resolves.toMatchObject({ source: 'platform', phoneId: PLATFORM_PHONE });
  });

  test('two workspaces in the same process at the same time never mix', async () => {
    const pick = async (ws, delay) => senderContext.run(ws, async () => {
      await new Promise((r) => setTimeout(r, delay));
      const s = await waTenant.resolveCurrent();
      await new Promise((r) => setTimeout(r, delay));
      return [s.phoneId, s.token, (await waTenant.resolveCurrent()).phoneId];
    });
    const out = await Promise.all([pick(WS_A, 12), pick(WS_B, 2), pick(WS_A, 1), pick(WS_B, 8)]);
    expect(out).toEqual([['111', 'TOKEN_A', '111'], ['222', 'TOKEN_B', '222'], ['111', 'TOKEN_A', '111'], ['222', 'TOKEN_B', '222']]);
  });

  test('a broken number in context throws (does not use the platform number)', async () => {
    docs[WS_A].whatsapp.tokenIsValid = false;
    await expect(senderContext.run(WS_A, () => waTenant.resolveCurrent())).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
  });
});

describe('WABA ids', () => {
  test('{waba:false} never makes a network call; the default adds the platform WABA when it is only discoverable', async () => {
    delete process.env.WA_WABA_ID;
    docs[WS_A] = { whatsapp: { phoneId: '555000' } }; // platform-WABA number without a stored WABA
    axios.get.mockResolvedValue({ data: { data: [{ id: 'DISCOVERED_WABA' }] } });
    const quick = await waTenant.resolveSender(WS_A, { waba: false });
    expect(quick.wabaId).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
    const full = await waTenant.resolveSender(WS_A);
    expect(full.wabaId).toBe('DISCOVERED_WABA');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toBe('https://graph.facebook.com/v25.0/me/whatsapp_business_accounts');
  });

  test('getPlatformWabaId throws the original descriptive error when nothing can be found', async () => {
    delete process.env.WA_WABA_ID;
    axios.get.mockResolvedValue({ data: {} });
    await expect(waTenant.getPlatformWabaId()).rejects.toThrow(/Cannot detect WABA ID automatically/);
    // resolveCurrent stays usable (the send path does not need the WABA): wabaId is simply null
    const s = await waTenant.resolveCurrent();
    expect(s).toMatchObject({ source: 'platform', wabaId: null });
  });

  test('a customer with its own token but no stored WABA gets it from ITS phone number with ITS token, cached per number', async () => {
    docs[WS_A] = { whatsapp: { phoneId: '777000', tokenEncrypted: 'v1:a' } };
    tokenVault.decrypt.mockReturnValue('TENANT_TOKEN');
    axios.get.mockResolvedValue({ data: { whatsapp_business_account: { id: 'WABA_FROM_PHONE' } } });
    const s = await waTenant.resolveSender(WS_A);
    expect(s.wabaId).toBe('WABA_FROM_PHONE');
    expect(axios.get).toHaveBeenCalledWith('https://graph.facebook.com/v25.0/777000', {
      params: { fields: 'whatsapp_business_account' }, headers: { Authorization: 'Bearer TENANT_TOKEN' },
    });
    await waTenant.wabaIdOf(await waTenant.resolveSender(WS_A, { waba: false }));
    expect(axios.get).toHaveBeenCalledTimes(1); // cached
    waTenant.invalidate(WS_A);
    await waTenant.resolveSender(WS_A);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});
