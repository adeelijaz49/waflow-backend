// shared/consent.js: the consent state transitions, end to end through the write helpers.
//
// This file used to create real customers in the configured database and delete them afterwards. It now runs against an
// in-memory stand-in for the two models (an append-only event list and plain customer objects with a save()), so it can
// run anywhere - including an environment whose MONGODB_URI is a live database - without writing or deleting a single
// row. Behaviour that needs the real unique index (duplicate inbound message ids) is covered against the throwaway
// database in tests/localization/integration/consentCore.itest.js.
jest.mock('../utils/whatsapp', () => ({ waPost: jest.fn() }));
jest.mock('../models/Customer', () => ({ updateOne: jest.fn(async () => ({})), findByIdAndUpdate: jest.fn(async () => ({})) }));
jest.mock('../models/ConsentEvent', () => {
  const store = [];
  let seq = 0;
  const api = {
    __store: store,
    create: jest.fn(async (doc) => {
      if (doc.inboundWamid && store.some((e) => e.inboundWamid === doc.inboundWamid)) {
        throw Object.assign(new Error('E11000 duplicate key error (inboundWamid)'), { code: 11000 });
      }
      seq += 1;
      const e = { ...doc, _id: `ev${seq}`, createdAt: new Date(Date.UTC(2026, 9, 26, 9, 0, seq)) };
      store.push(e);
      return e;
    }),
    find: jest.fn((filter) => ({ sort: async () => store.filter((e) => String(e.customerId) === String(filter.customerId)) })),
    findOne: jest.fn((filter) => ({
      sort: () => ({ lean: async () => [...store].reverse().find((e) => String(e.customerId) === String(filter.customerId)) || null }),
    })),
  };
  return api;
});

const ConsentEvent = require('../models/ConsentEvent');
const {
  canSendMarketing, grantMarketingConsent, withdrawMarketingConsent,
  reinstateMarketingConsent, declineMarketingConsent, recordCustomerOptIn, deriveConsentStatus, requireSignature, signatureSetupProblem,
} = require('../shared/consent');

let seq = 0;
function makeCustomer(over = {}) {
  seq += 1;
  const c = { _id: `c${seq}`, workspaceId: 'w1', firstname: '__test_consent__', lastname: 'Test', phone: `1555999100${seq}`, marketingConsent: false, optedOut: false, ...over };
  c.save = jest.fn(async () => c);
  return c;
}
const eventsOf = async (c) => ConsentEvent.find({ customerId: c._id }).sort({ createdAt: 1 });

describe('shared/consent.js', () => {
  let customer;
  beforeEach(() => { ConsentEvent.__store.length = 0; customer = makeCustomer(); });

  test('canSendMarketing requires both consent and not-opted-out', () => {
    expect(canSendMarketing({ marketingConsent: false, optedOut: false })).toBe(false);
    expect(canSendMarketing({ marketingConsent: true, optedOut: true })).toBe(false);
    expect(canSendMarketing({ marketingConsent: true, optedOut: false })).toBe(true);
    expect(canSendMarketing(null)).toBe(false);
  });

  test('grantMarketingConsent sets fields and writes exactly one consent_given event', async () => {
    await grantMarketingConsent({ customer, method: 'manual_staff_entry', source: 'test' });
    expect(customer.marketingConsent).toBe(true);
    expect(customer.marketingConsentAt).toBeTruthy();
    expect(customer.marketingConsentMethod).toBe('manual_staff_entry');

    const events = await eventsOf(customer);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_given');
    expect(events[0].method).toBe('manual_staff_entry');
    expect(events[0].phone).toBe(customer.phone);
  });

  test('a staff grant does not clear a customer\'s own opt-out', async () => {
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
    await grantMarketingConsent({ customer, method: 'manual_staff_entry', source: 'test' });
    expect(customer.optedOut).toBe(true);
    expect(canSendMarketing(customer)).toBe(false);
  });

  test('withdrawMarketingConsent sets optedOut and writes a consent_withdrawn event', async () => {
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
    expect(customer.optedOut).toBe(true);
    expect(customer.optedOutAt).toBeTruthy();

    const events = await eventsOf(customer);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_withdrawn');
  });

  test('reinstateMarketingConsent (START) after an opt-out is a fresh opt-in, even if the customer never consented before', async () => {
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
    const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' });
    expect(reinstated).toBe(true);

    expect(customer.optedOut).toBe(false);
    expect(customer.optedOutAt).toBeNull();
    expect(customer.marketingConsent).toBe(true);
    // the customer record keeps one of the two values the previous release knows; the event keeps the precise method
    expect(customer.marketingConsentMethod).toBe('whatsapp_button');
    expect(deriveConsentStatus(customer)).toBe('opted_in');

    const events = await eventsOf(customer);
    expect(events.map((e) => e.type)).toEqual(['consent_withdrawn', 'consent_given']);
    expect(events[1]).toMatchObject({ method: 'whatsapp_start_command', source: 'START after opt-out' });
  });

  describe('CONSENT_REQUIRE_SIGNATURE=on: a typed START is a fresh opt-in only when Meta signed the request', () => {
    const was = process.env.CONSENT_REQUIRE_SIGNATURE;
    beforeEach(() => { process.env.CONSENT_REQUIRE_SIGNATURE = 'on'; });
    afterEach(() => { if (was === undefined) delete process.env.CONSENT_REQUIRE_SIGNATURE; else process.env.CONSENT_REQUIRE_SIGNATURE = was; });

    test.each(['invalid', 'missing', 'unconfigured', undefined])('signature %s: nothing is applied, nothing is logged, the answer is "not reinstated"', async (signature) => {
      await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
      const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test', signature });
      expect(reinstated).toBe(false);
      expect(customer.optedOut).toBe(true);
      expect((await eventsOf(customer)).map((e) => e.type)).toEqual(['consent_withdrawn']);
    });

    test('a valid signature (given directly or inside the evidence) applies it', async () => {
      await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
      expect(await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test', signature: 'valid' })).toBe(true);
      expect(customer.optedOut).toBe(false);
      const other = makeCustomer();
      await withdrawMarketingConsent({ customer: other, method: 'whatsapp_stop_command', source: 'test' });
      expect(await reinstateMarketingConsent({ customer: other, method: 'whatsapp_start_command', source: 'test', evidence: { signature: 'valid', inboundWamid: 'wamid.SIG1' } })).toBe(true);
    });

    test('an opt-OUT is always honoured, whatever the signature', async () => {
      await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test', evidence: { signature: 'invalid', inboundWamid: 'wamid.SIG2' } });
      expect(customer.optedOut).toBe(true);
    });

    test('with the flag off (the default) the signature is not consulted', async () => {
      delete process.env.CONSENT_REQUIRE_SIGNATURE;
      await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });
      expect(await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test', signature: 'invalid' })).toBe(true);
    });

    test('true / 1 / yes switch it on as well as "on" (one reader for every on/off setting), and a typo does not', () => {
      for (const v of ['on', 'ON', 'true', '1', 'yes']) { process.env.CONSENT_REQUIRE_SIGNATURE = v; expect(requireSignature()).toBe(true); }
      for (const v of ['off', 'false', '0', 'no', '', 'ture', 'enabled']) { process.env.CONSENT_REQUIRE_SIGNATURE = v; expect(requireSignature()).toBe(false); }
    });
  });

  describe('signatureSetupProblem (said once at start-up)', () => {
    const was = process.env.CONSENT_REQUIRE_SIGNATURE;
    afterEach(() => { if (was === undefined) delete process.env.CONSENT_REQUIRE_SIGNATURE; else process.env.CONSENT_REQUIRE_SIGNATURE = was; });

    test('nothing to say while the signature is not required, whatever the webhook setup', () => {
      delete process.env.CONSENT_REQUIRE_SIGNATURE;
      expect(signatureSetupProblem({ secretConfigured: false, mode: 'off' })).toBeNull();
      expect(signatureSetupProblem({ secretConfigured: true, mode: 'log' })).toBeNull();
      expect(signatureSetupProblem()).toBeNull();
    });

    test('required and verifiable (a secret is set and the mode is not off): nothing to say', () => {
      process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
      expect(signatureSetupProblem({ secretConfigured: true, mode: 'log' })).toBeNull();
      expect(signatureSetupProblem({ secretConfigured: true, mode: 'enforce' })).toBeNull();
    });

    test('required but no secret, or the signature check switched off: every opt-in would be refused, and it says so', () => {
      process.env.CONSENT_REQUIRE_SIGNATURE = 'true';
      for (const setup of [{ secretConfigured: false, mode: 'log' }, { secretConfigured: true, mode: 'off' }, { secretConfigured: false, mode: 'off' }, {}, undefined]) {
        const problem = signatureSetupProblem(setup);
        expect(problem).toMatch(/CONSENT_REQUIRE_SIGNATURE is on/);
        expect(problem).toMatch(/every opt-in tap and START will be refused/);
      }
    });
  });

  test('reinstateMarketingConsent is still a no-op and logs nothing for a customer who never opted in and never opted out', async () => {
    const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' });
    expect(reinstated).toBe(false);
    expect(customer.marketingConsent).toBe(false); // a bare START never fabricates consent
    expect(await eventsOf(customer)).toEqual([]);
  });

  test('reinstateMarketingConsent after grant + withdraw logs the fresh opt-in and clears optedOut', async () => {
    await grantMarketingConsent({ customer, method: 'manual_staff_entry', source: 'test' });
    await withdrawMarketingConsent({ customer, method: 'whatsapp_stop_command', source: 'test' });

    const reinstated = await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' });
    expect(reinstated).toBe(true);
    expect(customer.optedOut).toBe(false);
    expect(customer.optedOutAt).toBeNull();

    const events = await eventsOf(customer);
    expect(events.map((e) => e.type)).toEqual(['consent_given', 'consent_withdrawn', 'consent_given']);
  });

  test('reinstateMarketingConsent for a consented customer who is not opted out keeps the legacy consent_reinstated event', async () => {
    await grantMarketingConsent({ customer, method: 'manual_staff_entry', source: 'test' });
    expect(await reinstateMarketingConsent({ customer, method: 'whatsapp_start_command', source: 'test' })).toBe(true);
    expect((await eventsOf(customer)).map((e) => e.type)).toEqual(['consent_given', 'consent_reinstated']);
  });

  test('recordCustomerOptIn clears an opt-out and keeps the full history (opt in, opt out, opt in again)', async () => {
    await recordCustomerOptIn({ customer, method: 'whatsapp_button', source: 'tap 1', evidence: { inboundWamid: 'wamid.A', buttonAction: 'opt_in' } });
    await withdrawMarketingConsent({ customer, method: 'whatsapp_optout_button', source: 'tap 2', evidence: { inboundWamid: 'wamid.B', buttonAction: 'opt_out' } });
    expect(canSendMarketing(customer)).toBe(false);
    await recordCustomerOptIn({ customer, method: 'whatsapp_button', source: 'tap 3', evidence: { inboundWamid: 'wamid.C', buttonAction: 'opt_in' } });
    expect(canSendMarketing(customer)).toBe(true);
    const events = await eventsOf(customer);
    expect(events.map((e) => [e.type, e.inboundWamid])).toEqual([['consent_given', 'wamid.A'], ['consent_withdrawn', 'wamid.B'], ['consent_given', 'wamid.C']]);
  });

  test('a redelivered tap (same inbound message id) is reported as a duplicate and adds no event', async () => {
    const ev = { inboundWamid: 'wamid.SAME', buttonAction: 'opt_in' };
    const first = await recordCustomerOptIn({ customer, method: 'whatsapp_button', source: 's', evidence: ev });
    const again = await recordCustomerOptIn({ customer, method: 'whatsapp_button', source: 's', evidence: ev });
    expect(first.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(await eventsOf(customer)).toHaveLength(1);
  });

  test('declineMarketingConsent logs a consent_declined event without changing marketingConsent', async () => {
    await declineMarketingConsent({ customer, method: 'whatsapp_button', source: 'test' });
    expect(customer.marketingConsent).toBe(false);
    expect(deriveConsentStatus(customer)).toBe('not_responded');

    const events = await eventsOf(customer);
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_declined');
  });
});
