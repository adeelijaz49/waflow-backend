// H1 + the outbound language hint inside the localisation inbound hook (shared/localization/inboundHook.js):
//   * every opt-out path (typed Arabic keyword, Arabic button tap, already-opted-out customer, unknown customer) also calls
//     deps.samePhoneOptOut, in the right order and without ever blocking the reply;
//   * a freshly inferred language is announced to the outbound localiser through deps.noteLanguage.
// Pure fakes: no database, no WhatsApp call.
const { handleInbound, resetHandled } = require('../../shared/localization/inboundHook');
const catalog = require('../../shared/localization/catalog');

const WS = 'ws1';
const FROM = '966500000001';
const CID = '64b7f0f0f0f0f0f0f0f0f0f0';

function makeDeps({ customer, kill = false, withdrawFails = false, sweepFails = false } = {}) {
  const cust = customer === undefined ? { _id: CID, phone: FROM, marketingConsent: true, optedOut: false } : customer;
  const order = [];
  const deps = {
    order,
    Customer: { findOne: jest.fn(async () => cust) },
    ConsentEvent: { exists: jest.fn(async () => null) },
    CustomerLanguage: { findOne: jest.fn(() => ({ lean: async () => null })), updateOne: jest.fn(), create: jest.fn(async () => {}) },
    CampaignMessage: { findOneAndUpdate: jest.fn(async () => null) },
    consent: {
      withdrawMarketingConsent: jest.fn(async () => { order.push('withdraw'); if (withdrawFails) throw new Error('db'); }),
      grantMarketingConsent: jest.fn(), reinstateMarketingConsent: jest.fn(async () => true), declineMarketingConsent: jest.fn(),
    },
    settings: { killSwitchOn: () => kill, isArabicEnabled: jest.fn(async () => true) },
    transport: { sendText: jest.fn(async (to, body) => { order.push(`reply:${body === catalog.t('ar', 'consent.optOutAck') ? 'ack' : body === catalog.t('ar', 'consent.alreadyOptedOut') ? 'already' : 'other'}`); }) },
    catalog,
    state: { pendingServiceCheckouts: new Map(), pendingPointsCheckouts: new Map(), pendingAddressReqs: new Map(), pendingCatalogs: new Map() },
    now: () => Date.UTC(2026, 9, 11, 12, 0, 0),
    sleep: async () => {},
    log: jest.fn(),
    debug: jest.fn(),
    samePhoneOptOut: jest.fn(async () => { order.push('sweep'); if (sweepFails) throw new Error('sweep boom'); return { matched: 1, optedOut: 1, failed: 0 }; }),
    noteLanguage: jest.fn(),
  };
  return deps;
}
const text = (body) => ({ type: 'text', text: { body } });
const run = (deps, body) => handleInbound({ workspaceId: WS, from: FROM, message: text(body) }, deps);
beforeEach(() => resetHandled());

describe('H1 in the Arabic opt-out paths', () => {
  test('typed Arabic opt-out: withdraw, THEN sweep the same number, THEN the Arabic reply', async () => {
    const deps = makeDeps();
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.order).toEqual(['withdraw', 'sweep', 'reply:ack']);
    expect(deps.samePhoneOptOut).toHaveBeenCalledWith({ workspaceId: WS, from: FROM, exceptCustomerId: CID, method: 'whatsapp_stop_command', source: expect.stringContaining('Arabic') });
  });
  test('an already opted-out customer: still swept (a sibling may not be opted out), reply says so', async () => {
    const deps = makeDeps({ customer: { _id: CID, phone: FROM, optedOut: true } });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.order).toEqual(['sweep', 'reply:already']);
    expect(deps.consent.withdrawMarketingConsent).not.toHaveBeenCalled();
  });
  test('no record for the exact phone: the number is still swept (closes the told-unsubscribed-but-nothing-recorded gap)', async () => {
    const deps = makeDeps({ customer: null });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.samePhoneOptOut).toHaveBeenCalledWith(expect.objectContaining({ exceptCustomerId: null }));
    expect(deps.order).toEqual(['sweep', 'reply:ack']);
  });
  test('the kill switch does not switch the opt-out sweep off (compliance)', async () => {
    const deps = makeDeps({ kill: true });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.samePhoneOptOut).toHaveBeenCalledTimes(1);
  });
  test('a sweep failure never blocks the reply', async () => {
    const deps = makeDeps({ sweepFails: true });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.order).toEqual(['withdraw', 'sweep', 'reply:ack']);
    expect(deps.log.mock.calls.some((c) => /same-number opt-out failed/.test(String(c[0])))).toBe(true);
  });
  test('when the primary opt-out itself FAILED nothing else runs (the customer is told to retry)', async () => {
    const deps = makeDeps({ withdrawFails: true });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.samePhoneOptOut).not.toHaveBeenCalled();
  });
  test('Arabic opt-out button tap sweeps with the button method', async () => {
    const deps = makeDeps();
    const message = { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'optout_promo1', title: 'إلغاء الاشتراك' } } };
    await expect(handleInbound({ workspaceId: WS, from: FROM, message }, deps)).resolves.toBe(true);
    expect(deps.samePhoneOptOut).toHaveBeenCalledWith(expect.objectContaining({ method: 'whatsapp_optout_button', exceptCustomerId: CID }));
  });
  test('without the dependency (unit-test fakes of other suites) nothing changes', async () => {
    const deps = makeDeps(); delete deps.samePhoneOptOut; delete deps.noteLanguage;
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.order).toEqual(['withdraw', 'reply:ack']);
  });
});

describe('language hint for the outbound localiser', () => {
  test('a newly inferred Arabic language is announced with the customer phone', async () => {
    const deps = makeDeps();
    await run(deps, 'مرحبا، أبغى أطلب');
    expect(deps.noteLanguage).toHaveBeenCalledWith(WS, FROM, 'ar');
  });
  test('an update of an unknown record is announced too; a protected record is not', async () => {
    const deps = makeDeps();
    deps.CustomerLanguage.findOne = jest.fn(() => ({ lean: async () => ({ _id: 'l1', language: 'unknown', languageSource: 'inferred' }) }));
    await run(deps, 'مرحبا، أبغى أطلب');
    expect(deps.noteLanguage).toHaveBeenCalledWith(WS, FROM, 'ar');
    const protectedDeps = makeDeps();
    protectedDeps.CustomerLanguage.findOne = jest.fn(() => ({ lean: async () => ({ _id: 'l1', language: 'unknown', languageSource: 'merchant_set' }) }));
    await run(protectedDeps, 'مرحبا، أبغى أطلب');
    expect(protectedDeps.noteLanguage).not.toHaveBeenCalled();
  });
  test('weak evidence (emoji only) announces nothing; a throwing hint never breaks the message', async () => {
    const deps = makeDeps();
    await run(deps, '👍');
    expect(deps.noteLanguage).not.toHaveBeenCalled();
    const boom = makeDeps(); boom.noteLanguage = jest.fn(() => { throw new Error('x'); });
    await expect(run(boom, 'مرحبا، أبغى أطلب')).resolves.toBe(false);
  });
});
