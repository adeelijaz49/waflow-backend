// Button taps on the consent buttons (consent_yes_<id> / consent_no_<id> /
// optout_<id>) — spec §3.4. Arabic customers' taps are handled here with the SAME
// consent functions and side effects as the existing English branches in server.js
// (template quick-reply and interactive button_reply); English customers' taps
// always fall through. Fully faked: no DB, no network.
const { handleInbound, resetHandled } = require('../../shared/localization/inboundHook');
const catalog = require('../../shared/localization/catalog');

const WS = 'ws1';
const FROM = '966500000001';
const CID = '64b7f0f0f0f0f0f0f0f0f0f0'; // a valid ObjectId string
const OTHER_CID = '64b7f0f0f0f0f0f0f0f0f0f1';

function makeDeps({ customer, language = null } = {}) {
  const cust = customer === undefined ? { _id: CID, phone: FROM, marketingConsent: false } : customer;
  const calls = { withdraw: [], grant: [], decline: [], sent: [], clicks: [] };
  return {
    calls,
    Customer: {
      findOne: jest.fn(async (filter) => {
        if (!cust) return null;
        if (filter.workspaceId !== WS) return null; // tenant isolation: every lookup must carry the workspace
        if (filter._id !== undefined && String(filter._id) !== String(cust._id)) return null;
        if (filter.phone !== undefined && filter.phone !== cust.phone) return null;
        return cust;
      }),
    },
    ConsentEvent: { exists: jest.fn(async () => null) },
    CustomerLanguage: { findOne: jest.fn(() => ({ lean: async () => (language ? { language } : null) })), updateOne: jest.fn(), create: jest.fn() },
    CampaignMessage: { findOneAndUpdate: jest.fn(async (filter, update, opts) => { calls.clicks.push({ filter, update, opts }); return filter.wamid === 'wamid.KNOWN' ? { _id: 'cm1' } : null; }) },
    consent: {
      withdrawMarketingConsent: jest.fn(async (a) => { calls.withdraw.push(a); }),
      grantMarketingConsent: jest.fn(async (a) => { calls.grant.push(a); }),
      reinstateMarketingConsent: jest.fn(async () => true),
      declineMarketingConsent: jest.fn(async (a) => { calls.decline.push(a); }),
    },
    settings: { killSwitchOn: () => false, isArabicEnabled: jest.fn(async () => true) },
    transport: { sendText: jest.fn(async (to, body) => { calls.sent.push({ to, body }); }) },
    catalog,
    state: { pendingServiceCheckouts: new Map(), pendingPointsCheckouts: new Map(), pendingAddressReqs: new Map(), pendingCatalogs: new Map() },
    now: () => Date.UTC(2026, 9, 11, 12, 0, 0),
    sleep: async () => {},
    log: jest.fn(),
    debug: jest.fn(),
  };
}

const interactive = (id, title, extra = {}) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } }, ...extra });
const template = (payload, text, extra = {}) => ({ type: 'button', button: { payload, text }, ...extra });
const tap = (deps, message) => handleInbound({ workspaceId: WS, from: FROM, message }, deps);

beforeEach(() => resetHandled());

const AR = { yes: 'نعم، أوافق', no: 'لا، شكراً', out: 'إلغاء الاشتراك' };
const EN = { yes: 'Yes, sign me up', no: 'No thanks', out: 'Opt Out' };

describe.each([
  ['interactive button_reply', interactive, 'order/booking confirmation consent button'],
  ['template quick-reply', template, 'bulk consent-request campaign'],
])('%s', (name, build, expectedSource) => {
  test('consent_yes_: Arabic title -> grantMarketingConsent (whatsapp_button) + Arabic ack, webhook stops', async () => {
    const deps = makeDeps();
    await expect(tap(deps, build(`consent_yes_${CID}`, AR.yes))).resolves.toBe(true);
    expect(deps.calls.grant).toEqual([{ customer: expect.objectContaining({ _id: CID }), method: 'whatsapp_button', source: `${expectedSource} (Arabic)`, workspaceId: WS }]);
    expect(deps.calls.sent).toEqual([{ to: FROM, body: catalog.t('ar', 'consent.optInAck') }]);
  });

  test('consent_no_: Arabic title -> declineMarketingConsent + Arabic ack', async () => {
    const deps = makeDeps();
    await expect(tap(deps, build(`consent_no_${CID}`, AR.no))).resolves.toBe(true);
    expect(deps.calls.decline).toEqual([{ customer: expect.objectContaining({ _id: CID }), method: 'whatsapp_button', source: `${expectedSource} (Arabic)`, workspaceId: WS }]);
    expect(deps.calls.grant).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.declineAck'));
  });

  test('optout_: Arabic title -> withdrawMarketingConsent (whatsapp_optout_button) + Arabic ack', async () => {
    const deps = makeDeps();
    await expect(tap(deps, build('optout_64b7f0f0f0f0f0f0f0f0f0aa', AR.out))).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
    expect(deps.calls.withdraw[0]).toMatchObject({ method: 'whatsapp_optout_button', workspaceId: WS });
    expect(deps.calls.withdraw[0].source).toContain('Opt Out button on promotion 64b7f0f0f0f0f0f0f0f0f0aa');
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.optOutAck'));
  });

  test.each([['consent_yes_', 'yes'], ['consent_no_', 'no'], ['optout_', 'out']])('%s with an ENGLISH title and no Arabic language record falls through untouched', async (prefix, key) => {
    const deps = makeDeps();
    const id = prefix === 'optout_' ? `${prefix}promo1` : `${prefix}${CID}`;
    await expect(tap(deps, build(id, EN[key]))).resolves.toBe(false);
    expect(deps.calls.grant).toHaveLength(0);
    expect(deps.calls.decline).toHaveLength(0);
    expect(deps.calls.withdraw).toHaveLength(0);
    expect(deps.calls.sent).toHaveLength(0);
    expect(deps.CampaignMessage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each([['consent_yes_', 'yes'], ['consent_no_', 'no'], ['optout_', 'out']])('%s with an English title but a customer whose language is Arabic IS handled here', async (prefix, key) => {
    const deps = makeDeps({ language: 'ar' });
    const id = prefix === 'optout_' ? `${prefix}promo1` : `${prefix}${CID}`;
    await expect(tap(deps, build(id, EN[key]))).resolves.toBe(true);
    expect(deps.calls.sent).toHaveLength(1);
    expect(/\p{Script=Arabic}/u.test(deps.calls.sent[0].body)).toBe(true);
  });

  test('a customer whose language is English stays with the existing code even when others are Arabic', async () => {
    const deps = makeDeps({ language: 'en' });
    await expect(tap(deps, build(`consent_yes_${CID}`, EN.yes))).resolves.toBe(false);
  });

  test('a repeat opt-out tap is acknowledged without a duplicate consent event', async () => {
    const deps = makeDeps({ customer: { _id: CID, phone: FROM, optedOut: true } });
    await expect(tap(deps, build('optout_promo1', AR.out))).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.alreadyOptedOut'));
  });

  test('a failed consent write is never acknowledged as success (retry message, loud log, handled)', async () => {
    for (const [id, title, fn] of [[`consent_yes_${CID}`, AR.yes, 'grantMarketingConsent'], [`consent_no_${CID}`, AR.no, 'declineMarketingConsent'], ['optout_p1', AR.out, 'withdrawMarketingConsent']]) {
      const deps = makeDeps();
      deps.consent[fn] = jest.fn(async () => { throw new Error('db down'); });
      await expect(tap(deps, build(id, title))).resolves.toBe(true);
      expect(deps.calls.sent).toEqual([{ to: FROM, body: catalog.t('ar', 'consent.tryAgain') }]);
      expect(deps.log.mock.calls.some((c) => String(c[0]).includes('CONSENT WRITE FAILED'))).toBe(true);
    }
  });

  test('a failed acknowledgement never undoes the consent change', async () => {
    const deps = makeDeps();
    deps.transport.sendText = jest.fn(async () => { throw new Error('send failed'); });
    await expect(tap(deps, build(`consent_yes_${CID}`, AR.yes))).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(1);
  });

  test('a redelivered tap does not write a second consent event', async () => {
    const deps = makeDeps();
    const message = build(`consent_yes_${CID}`, AR.yes, { id: 'wamid.TAP1' });
    await tap(deps, message);
    await expect(tap(deps, message)).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(1);
    expect(deps.calls.sent).toHaveLength(1);
  });

  test('an opt-out tap whose customer lookup fails is answered honestly, not dropped', async () => {
    const deps = makeDeps();
    deps.Customer.findOne = jest.fn(async () => { throw new Error('db down'); });
    await expect(tap(deps, build('optout_p1', AR.out))).resolves.toBe(true);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.tryAgain'));
  });
});

describe('safety: which taps this hook must NOT take over', () => {
  test.each([
    ['cart_abc'], ['promo_123'], ['msgnode_1_0'], ['flowbrowse_x'], ['checkout'], ['more_1'], ['rebook_1'], [''], ['consent'], ['optout'],
  ])('payload %j is not a consent button: no DB access at all', async (id) => {
    const deps = makeDeps();
    await expect(tap(deps, interactive(id, 'نعم، أوافق'))).resolves.toBe(false);
    await expect(tap(deps, template(id, 'نعم، أوافق'))).resolves.toBe(false);
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
  });

  test.each([['consent_yes_'], ['consent_yes_not-an-id'], ['consent_no_{"$ne":null}'], ['consent_yes_64b7f0f0f0f0f0f0f0f0f0f']])(
    'a malformed / operator-injection customer id %j is refused before any query (existing code handles it as before)',
    async (id) => {
      const deps = makeDeps();
      await expect(tap(deps, interactive(id, AR.yes))).resolves.toBe(false);
      expect(deps.Customer.findOne).not.toHaveBeenCalled();
    },
  );

  test('an object payload instead of a string is ignored', async () => {
    const deps = makeDeps();
    await expect(tap(deps, { type: 'button', button: { payload: { $ne: 1 }, text: AR.yes } })).resolves.toBe(false);
    await expect(tap(deps, { type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: `consent_yes_${CID}` } } })).resolves.toBe(false);
    await expect(tap(deps, { type: 'interactive', interactive: { type: 'button_reply' } })).resolves.toBe(false);
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
  });

  test("another tenant's customer id is never touched (lookup is scoped to the webhook's workspace)", async () => {
    const deps = makeDeps();
    deps.Customer.findOne = jest.fn(async (filter) => (filter.workspaceId === 'other-ws' ? { _id: CID, phone: FROM } : null));
    await expect(tap(deps, interactive(`consent_yes_${CID}`, AR.yes))).resolves.toBe(false);
    expect(deps.Customer.findOne.mock.calls[0][0]).toMatchObject({ _id: CID, workspaceId: WS });
    expect(deps.calls.grant).toHaveLength(0);
  });

  test('a payload that names a different customer (other phone) is left to the existing code', async () => {
    const deps = makeDeps({ customer: { _id: OTHER_CID, phone: '966511111111', marketingConsent: false } });
    await expect(tap(deps, interactive(`consent_yes_${OTHER_CID}`, AR.yes))).resolves.toBe(false);
    expect(deps.calls.grant).toHaveLength(0);
  });

  test('phone formatting differences (+, spaces) do not defeat the ownership check', async () => {
    const deps = makeDeps({ customer: { _id: CID, phone: '+966 50 000 0001', marketingConsent: false } });
    await expect(tap(deps, interactive(`consent_yes_${CID}`, AR.yes))).resolves.toBe(true);
  });

  test('unknown customer: falls through (the existing code does nothing either)', async () => {
    const deps = makeDeps({ customer: null });
    await expect(tap(deps, interactive(`consent_yes_${CID}`, AR.yes))).resolves.toBe(false);
    await expect(tap(deps, interactive('optout_p1', AR.out))).resolves.toBe(false);
  });

  test('kill switch: nothing is handled', async () => {
    const deps = makeDeps();
    deps.settings.killSwitchOn = () => true;
    await expect(tap(deps, interactive(`consent_yes_${CID}`, AR.yes))).resolves.toBe(false);
  });

  test('a customer-lookup failure on a non-opt-out tap fails open', async () => {
    const deps = makeDeps();
    deps.Customer.findOne = jest.fn(async () => { throw new Error('db down'); });
    await expect(tap(deps, interactive(`consent_yes_${CID}`, AR.yes))).resolves.toBe(false);
  });

  test('the Arabic-language lookup failing falls through for an English-titled tap', async () => {
    const deps = makeDeps();
    deps.CustomerLanguage.findOne = jest.fn(() => { throw new Error('db down'); });
    await expect(tap(deps, interactive(`consent_yes_${CID}`, EN.yes))).resolves.toBe(false);
    expect(deps.calls.grant).toHaveLength(0);
  });
});

describe('click correlation — replicated for template quick-replies only (as in server.js)', () => {
  test('a template tap records the click on the CampaignMessage matched by context.id', async () => {
    const deps = makeDeps();
    await tap(deps, template(`consent_yes_${CID}`, AR.yes, { context: { id: 'wamid.KNOWN' } }));
    expect(deps.calls.clicks).toHaveLength(1);
    expect(deps.calls.clicks[0].filter).toEqual({ wamid: 'wamid.KNOWN', workspaceId: WS });
    expect(deps.calls.clicks[0].update).toHaveProperty('clickedAt');
    expect(deps.calls.clicks[0].opts).toEqual({ returnDocument: 'after' });
  });

  test('an opt-out template tap without a matching wamid falls back to the latest send of that promotion, workspace-scoped', async () => {
    const deps = makeDeps();
    const promo = '64b7f0f0f0f0f0f0f0f0f0aa';
    await tap(deps, template(`optout_${promo}`, AR.out, { context: { id: 'wamid.UNKNOWN' } }));
    expect(deps.calls.clicks).toHaveLength(2);
    expect(deps.calls.clicks[1].filter).toMatchObject({ promotion: promo, customer: CID, workspaceId: WS, status: { $in: ['sent', 'delivered', 'read'] } });
    expect(deps.calls.clicks[1].opts).toMatchObject({ sort: { createdAt: -1 } });
  });

  test('an interactive (session) tap records no click, exactly like the existing branch', async () => {
    const deps = makeDeps();
    await tap(deps, interactive(`consent_yes_${CID}`, AR.yes, { context: { id: 'wamid.KNOWN' } }));
    expect(deps.CampaignMessage.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a click-recording failure never blocks the consent change', async () => {
    const deps = makeDeps();
    deps.CampaignMessage.findOneAndUpdate = jest.fn(async () => { throw new Error('db down'); });
    await expect(tap(deps, template(`consent_yes_${CID}`, AR.yes, { context: { id: 'wamid.KNOWN' } }))).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(1);
  });

  test('a non-string wamid or a non-ObjectId promotion id never reaches a query', async () => {
    const deps = makeDeps();
    await tap(deps, template('optout_not-an-object-id', AR.out, { context: { id: { $ne: null } } }));
    expect(deps.CampaignMessage.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

// The TEMPLATE TEST-SEND (templates.js testButtonPayloads) puts an opt-out payload on a real button of a
// message that goes to a tester's phone. Any `optout_...` payload is a real opt-out of whoever taps it.
describe('the test-send opt-out payload is inert', () => {
  test('the old `optout_test` payload WAS a real opt-out for the tapper (the reason it must never be used again)', async () => {
    const deps = makeDeps();
    await expect(tap(deps, template('optout_test', AR.out))).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
  });

  test.each([[AR.out], [EN.out], ['']])('`l10ntest_optout` (title %j) is not handled by the Arabic hook: nothing is withdrawn, granted or sent', async (title) => {
    for (const language of [null, 'ar', 'en']) {
      const deps = makeDeps({ language });
      await expect(tap(deps, template('l10ntest_optout', title))).resolves.toBe(false);
      expect(deps.calls.withdraw).toHaveLength(0);
      expect(deps.calls.grant).toHaveLength(0);
      expect(deps.calls.decline).toHaveLength(0);
      expect(deps.calls.sent).toHaveLength(0);
      expect(deps.CampaignMessage.findOneAndUpdate).not.toHaveBeenCalled();
    }
  });
});
