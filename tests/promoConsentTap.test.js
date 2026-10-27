// Unit tests for shared/promoConsentTap.js (the handler for `promo:<promotionId>:<action>:<position>` taps).
// No database, no network: every model, the consent helpers and the WhatsApp sender are injected fakes.
jest.mock('../models/Settings', () => ({ findOne: jest.fn() }));
jest.mock('../models/ConsentEvent', () => ({ findOne: jest.fn() })); // only the handler's default "already recorded?" lookup uses it

const Settings = require('../models/Settings');
const ConsentEvent = require('../models/ConsentEvent');
const tap = require('../shared/promoConsentTap');
const { handlePromoConsentTap, parsePromoPayload, defaultReplyText } = tap;

const WS_A = '64b00000000000000000000a';
const WS_B = '64b00000000000000000000b';
const PROMO = '64b0000000000000000000f1';
const OTHER_PROMO = '64b0000000000000000000f2';
const NODE = '64b0000000000000000000e1';
const TS = '1792000000'; // unix seconds

// A query that can be awaited directly or chained (.sort/.lean/.select) like a mongoose Query.
function q(value) {
  const p = Promise.resolve(value);
  const chain = { sort: () => chain, lean: () => chain, select: () => chain, then: (a, b) => p.then(a, b), catch: (f) => p.catch(f) };
  return chain;
}

function templateTap(payload, over = {}) {
  return {
    id: 'wamid.IN1', from: '966501234567', timestamp: TS, type: 'button',
    context: { id: 'wamid.OUT', from: '966000000000' },
    button: { payload, text: 'Yes, send me offers' },
    ...over,
  };
}
const OPT_IN = `promo:${PROMO}:opt_in:0`;
const OPT_OUT = `promo:${PROMO}:opt_out:1`;
const INTERESTED = `promo:${PROMO}:interested:2`;
const NONE = `promo:${PROMO}:end_flow:2`;
const noneWorld = () => world({ cm: { consentSnapshot: { promotionName: 'Spring opt-in', buttons: [{ position: 2, label: 'Maybe later', action: 'end_flow' }] } } });

function world(over = {}) {
  const w = {};
  w.customer = { _id: 'cust1', workspaceId: WS_A, phone: '+966 50 123 4567', firstname: 'Sara', optedOut: false, marketingConsent: false, ...over.customer };
  w.cm = {
    _id: 'cm1', workspaceId: WS_A, promotion: PROMO, customer: 'cust1', wamid: 'wamid.OUT', phone: '+966 50 123 4567',
    templateName: 'waflow_flow_abc', messageNode: NODE,
    consentSnapshot: {
      promotionName: 'Spring opt-in', purpose: 'consent_request', templateName: 'waflow_flow_abc', templateVersion: 2, language: 'en',
      bodyTemplate: 'Hi {{1}}, want offers on WhatsApp?', renderedBody: 'Hi Sara, want offers on WhatsApp? Reply STOP any time.', footer: 'Reply STOP to unsubscribe',
      buttons: [
        { position: 0, label: 'Yes, send me offers', action: 'opt_in', payload: OPT_IN },
        { position: 1, label: 'No thanks', action: 'opt_out', payload: OPT_OUT },
        { position: 2, label: 'Tell me more', action: 'interested', payload: INTERESTED },
      ],
    },
    ...over.cm,
  };
  w.promotion = { _id: PROMO, workspaceId: WS_A, name: 'Spring opt-in', entryNodeId: NODE, products: [], services: [], type: 'specific_products', discountPercent: 0, ...over.promotion };
  w.node = {
    _id: NODE, workspaceId: WS_A, templateName: 'waflow_flow_abc', templateVersion: 2,
    buttons: [
      { position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in' } },
      { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
      { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } },
    ],
    templateSnapshot: { bodyText: 'Hi {{1}}, want offers on WhatsApp?', buttons: [] },
    ...over.node,
  };
  w.log = jest.fn();
  w.sent = [];
  const cmFindOne = jest.fn((filter) => {
    if (filter.wamid) return q(filter.wamid === w.cm.wamid ? w.cm : null);
    return q(over.fallbackCm === undefined ? null : over.fallbackCm);
  });
  w.deps = {
    CampaignMessage: {
      findOne: cmFindOne,
      updateOne: jest.fn(async () => ({})),
      findOneAndUpdate: jest.fn(async () => (over.claimFails ? null : w.cm)),
    },
    Customer: { findById: jest.fn(() => q(over.noCustomer ? null : w.customer)), updateOne: jest.fn(async () => ({})) },
    Promotion: { findById: jest.fn(() => q(over.noPromotion ? null : w.promotion)) },
    MessageNode: { findById: jest.fn(() => q(over.noNode ? null : w.node)) },
    consent: {
      recordCustomerOptIn: jest.fn(async ({ customer }) => ({ customer, duplicate: !!over.duplicate })),
      withdrawMarketingConsent: jest.fn(async ({ customer }) => (over.duplicate ? { customer, duplicate: true } : customer)),
    },
    sendText: jest.fn(async (to, body, opts) => { w.sent.push({ to, body, opts }); }),
    optOutSamePhone: jest.fn(async () => ({})),
    handlePromoInterest: jest.fn(async () => {}),
    businessName: jest.fn(async () => 'Aroma Cafe'),
    phonesMatch: jest.fn(async () => true),
    eventSeen: jest.fn(async () => !!over.seen), // "was this inbound message already recorded?" (a redelivery the unique index did not catch)
    now: () => new Date('2026-10-26T09:00:00Z'),
    log: w.log,
    ...over.deps,
  };
  w.run = (message, extra = {}) => handlePromoConsentTap({ from: '966501234567', message, signature: 'valid', deps: w.deps, ...extra });
  return w;
}

let savedSig;
beforeEach(() => { savedSig = process.env.CONSENT_REQUIRE_SIGNATURE; delete process.env.CONSENT_REQUIRE_SIGNATURE; });
afterEach(() => { if (savedSig === undefined) delete process.env.CONSENT_REQUIRE_SIGNATURE; else process.env.CONSENT_REQUIRE_SIGNATURE = savedSig; });

describe('parsePromoPayload', () => {
  test('accepts promo:<24 hex>:<action>:<position>', () => {
    expect(parsePromoPayload(OPT_IN)).toEqual({ promotionId: PROMO, action: 'opt_in', position: 0 });
    expect(parsePromoPayload(OPT_OUT)).toEqual({ promotionId: PROMO, action: 'opt_out', position: 1 });
    expect(parsePromoPayload(`promo:${PROMO.toUpperCase()}:interested:2`)).toMatchObject({ action: 'interested', position: 2 });
  });
  test.each([
    ['promo_' + PROMO], ['msgnode_x_0'], ['promo:abc:opt_in:0'], [`promo:${PROMO}:opt_in`], [`promo:${PROMO}:OPT_IN:0`],
    [`promo:${PROMO}:opt_in:x`], [`promo:${PROMO}:opt_in:0:extra`], [''], [null], [undefined], [`xpromo:${PROMO}:opt_in:0`],
  ])('rejects %j', (p) => { expect(parsePromoPayload(p)).toBeNull(); });
});

describe('opt_in', () => {
  test('records a customer opt-in with full evidence, tenant from the message, then confirms', async () => {
    const w = world();
    const out = await w.run(templateTap(OPT_IN));
    expect(out).toMatchObject({ handled: true, outcome: 'opted_in', workspaceId: WS_A, customerId: 'cust1', action: 'opt_in', replied: true });

    expect(w.deps.consent.recordCustomerOptIn).toHaveBeenCalledTimes(1);
    const arg = w.deps.consent.recordCustomerOptIn.mock.calls[0][0];
    expect(arg.customer).toBe(w.customer);
    expect(arg.method).toBe('whatsapp_button');
    expect(String(arg.workspaceId)).toBe(WS_A);
    expect(arg.source).toBe('Promotion "Spring opt-in" button "Yes, send me offers" (opt_in)');
    expect(arg.evidence).toEqual({
      promotionId: PROMO, promotionName: 'Spring opt-in',
      messageText: 'Hi Sara, want offers on WhatsApp? Reply STOP any time.', // the text as sent (snapshot), not the live node
      buttonLabel: 'Yes, send me offers', buttonPosition: 0, buttonAction: 'opt_in',
      templateName: 'waflow_flow_abc', templateVersion: 2,
      sourceWamid: 'wamid.OUT', inboundWamid: 'wamid.IN1', tappedAt: new Date(Number(TS) * 1000), signature: 'valid',
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].to).toBe('966501234567');
    expect(w.sent[0].opts).toEqual({ workspaceId: WS_A });
    expect(w.sent[0].body).toBe("You're in! Thanks, Sara. You'll now get offers from Aroma Cafe here on WhatsApp. Reply STOP any time to opt out.");
  });

  test('the evidence quotes the label the customer actually saw (message.button.text), whatever the snapshot says now', async () => {
    const w = world();
    await w.run(templateTap(OPT_IN, { button: { payload: OPT_IN, text: 'Count me in' } }));
    expect(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.buttonLabel).toBe('Count me in');
  });

  test('falls back to the snapshot label when WhatsApp did not report one, and to the node snapshot text when the message has none', async () => {
    const w = world({ cm: { consentSnapshot: undefined } , node: { templateSnapshot: { bodyText: 'Node snapshot text', buttons: [] } } });
    await w.run(templateTap(OPT_IN, { button: { payload: OPT_IN } }));
    const ev = w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence;
    expect(ev.messageText).toBe('Node snapshot text');
    expect(ev.buttonLabel).toBeUndefined();
    expect(ev.templateName).toBe('waflow_flow_abc');
    expect(w.log).not.toHaveBeenCalled(); // the node supplied a text, so nothing to complain about

    const bare = world({ cm: { consentSnapshot: undefined }, noNode: true });
    await bare.run(templateTap(OPT_IN));
    expect(bare.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.messageText).toBeUndefined(); // still recorded, without text
    expect(bare.log).toHaveBeenCalled(); // ...and the gap is logged
  });

  test('a tap from an interactive button_reply carrying the same payload is understood too', async () => {
    const w = world();
    const m = { id: 'wamid.IN9', from: '966501234567', timestamp: TS, type: 'interactive', context: { id: 'wamid.OUT' }, interactive: { type: 'button_reply', button_reply: { id: OPT_IN, title: 'Yes, send me offers' } } };
    const out = await w.run(m);
    expect(out.outcome).toBe('opted_in');
    expect(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.buttonLabel).toBe('Yes, send me offers');
  });

  test('the confirmation is the one of the button that was tapped (position AND action), not of whatever sits at that position now', async () => {
    const w = world({ node: { buttons: [
      { position: 0, label: 'No thanks', nextAction: { type: 'opt_out', replyText: 'Sorry to see you go' } }, // reordered since: position 0 is an opt-out now
      { position: 1, label: 'Yes', nextAction: { type: 'opt_in', replyText: 'Welcome back!' } },
    ] } });
    await w.run(templateTap(OPT_IN)); // an old "Yes" (it was position 0 when the message went out)
    expect(w.sent[0].body).toMatch(/^You're in!/);
    expect(w.sent[0].body).not.toContain('Sorry to see you go');
  });

  test('the merchant\'s own confirmation text (live node) is sent verbatim instead of the default', async () => {
    const w = world();
    w.node.buttons[0].nextAction.replyText = '  Welcome to the club! Code CLUB10.  ';
    await w.run(templateTap(OPT_IN));
    expect(w.sent[0].body).toBe('Welcome to the club! Code CLUB10.');
  });

  test('when the live button is gone, the submitted snapshot\'s reply text is used; a cleared live reply text means the default', async () => {
    const w = world({ node: { buttons: [], templateSnapshot: { bodyText: 'b', buttons: [{ position: 0, label: 'Yes', action: 'opt_in', replyText: 'From the snapshot' }] } } });
    await w.run(templateTap(OPT_IN));
    expect(w.sent[0].body).toBe('From the snapshot');

    const w2 = world({ node: { templateSnapshot: { bodyText: 'b', buttons: [{ position: 0, label: 'Yes', action: 'opt_in', replyText: 'Old text' }] } } });
    w2.node.buttons[0].nextAction.replyText = ''; // the merchant cleared it after sending
    await w2.run(templateTap(OPT_IN));
    expect(w2.sent[0].body).toMatch(/^You're in! Thanks, Sara\./);
  });

  test('the default confirmation adds the promotion\'s discount line when it has one', async () => {
    const w = world({ promotion: { discountPercent: 15 } });
    await w.run(templateTap(OPT_IN));
    expect(w.sent[0].body).toBe("You're in! Thanks, Sara. You'll now get offers from Aroma Cafe here on WhatsApp. Reply STOP any time to opt out.\n\nYour offer: Spring opt-in - 15% off");
    expect(defaultReplyText({ action: 'opt_in', name: 'Sara', business: 'X', promotion: { name: 'P', discountPercent: 10, code: 'HELLO' } })).toMatch(/Your offer: P - 10% off\. Code: HELLO$/);
    expect(defaultReplyText({ action: 'opt_in', name: '', business: '', promotion: {} })).toBe("You're in! Thanks, there. You'll now get offers from us here on WhatsApp. Reply STOP any time to opt out.");
  });

  test('first tap sets the statistics (action, clickedAt, respondedAt, position); they never gate the consent write', async () => {
    const w = world();
    await w.run(templateTap(OPT_IN));
    const calls = w.deps.CampaignMessage.updateOne.mock.calls;
    expect(calls[0]).toEqual([{ _id: 'cm1' }, { $set: { clickedButtonAction: 'opt_in', lastTapWamid: 'wamid.IN1' } }]);
    expect(calls[1]).toEqual([{ _id: 'cm1', clickedAt: null }, { $set: { clickedAt: new Date('2026-10-26T09:00:00Z') } }]);
    expect(calls[2]).toEqual([{ _id: 'cm1', respondedAt: null }, { $set: { respondedAt: new Date('2026-10-26T09:00:00Z'), clickedButtonPosition: 0 } }]);

    const w2 = world();
    w2.deps.CampaignMessage.updateOne.mockRejectedValue(new Error('stats down'));
    const out = await w2.run(templateTap(OPT_IN));
    expect(out.outcome).toBe('opted_in'); // statistics failed, consent was recorded and the customer was answered
    expect(w2.sent).toHaveLength(1);
  });

  test('a customer who opted out earlier and taps "Yes" again is opted in again (latest action wins; clearing the opt-out is the consent helper\'s job)', async () => {
    const w = world({ customer: { optedOut: true, marketingConsent: true } });
    const out = await w.run(templateTap(OPT_IN, { id: 'wamid.IN-LATER' }));
    expect(out.outcome).toBe('opted_in');
    expect(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.inboundWamid).toBe('wamid.IN-LATER');
    expect(w.sent).toHaveLength(1);
  });

  test('a failing reply never undoes or hides the recorded consent', async () => {
    const w = world();
    w.deps.sendText.mockRejectedValue(new Error('131047 outside window'));
    const out = await w.run(templateTap(OPT_IN));
    expect(out).toMatchObject({ handled: true, outcome: 'opted_in', replied: false });
    expect(w.deps.consent.recordCustomerOptIn).toHaveBeenCalledTimes(1);
  });
});

describe('CONSENT_REQUIRE_SIGNATURE', () => {
  test('off (default): the opt-in is applied whatever the signature, and the verdict is stored in the evidence', async () => {
    for (const sig of ['valid', 'invalid', 'missing', 'unconfigured']) {
      const w = world();
      const out = await w.run(templateTap(OPT_IN), { signature: sig });
      expect(out.outcome).toBe('opted_in');
      expect(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.signature).toBe(sig);
    }
    const w = world();
    await w.run(templateTap(OPT_IN), { signature: undefined });
    expect(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].evidence.signature).toBeUndefined();
  });

  test('on: only a valid signature applies an opt-in; nothing is written or sent otherwise', async () => {
    process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
    for (const sig of ['invalid', 'missing', 'unconfigured', undefined, 'forged']) {
      const w = world();
      const out = await w.run(templateTap(OPT_IN), { signature: sig });
      expect(out).toMatchObject({ handled: true, outcome: 'signature_required' });
      expect(w.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
      expect(w.sent).toHaveLength(0);
    }
    const ok = world();
    expect((await ok.run(templateTap(OPT_IN), { signature: 'valid' })).outcome).toBe('opted_in');
  });

  test('on: an opt-out is ALWAYS honoured, even with an invalid or missing signature', async () => {
    process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
    for (const sig of ['invalid', 'missing', undefined]) {
      const w = world();
      const out = await w.run(templateTap(OPT_OUT, { button: { payload: OPT_OUT, text: 'No thanks' } }), { signature: sig });
      expect(out.outcome).toBe('opted_out');
      expect(w.deps.consent.withdrawMarketingConsent).toHaveBeenCalledTimes(1);
    }
  });

  test('on: "interested" and "None" taps are not consent and are not blocked', async () => {
    process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
    const w = noneWorld();
    expect((await w.run(templateTap(NONE), { signature: 'missing' })).outcome).toBe('recorded');
  });
});

describe('opt_out', () => {
  const noThanks = (over) => templateTap(OPT_OUT, { id: 'wamid.IN-OUT', button: { payload: OPT_OUT, text: 'No thanks' }, ...over });

  test('withdraws with evidence, sweeps the same phone, and sends ONE short message', async () => {
    const w = world();
    const out = await w.run(noThanks());
    expect(out).toMatchObject({ handled: true, outcome: 'opted_out', action: 'opt_out', replied: true });
    const arg = w.deps.consent.withdrawMarketingConsent.mock.calls[0][0];
    expect(arg.method).toBe('whatsapp_optout_button');
    expect(String(arg.workspaceId)).toBe(WS_A);
    expect(arg.customer).toBe(w.customer);
    expect(arg.evidence).toMatchObject({ promotionId: PROMO, buttonLabel: 'No thanks', buttonPosition: 1, buttonAction: 'opt_out', inboundWamid: 'wamid.IN-OUT', sourceWamid: 'wamid.OUT', signature: 'valid' });
    expect(w.deps.optOutSamePhone).toHaveBeenCalledWith({
      workspaceId: WS_A, from: '966501234567', exceptCustomerId: 'cust1', method: 'whatsapp_optout_button', source: arg.source,
    });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].body).toBe("No problem, Sara. We won't send you any more offers. Reply START if you change your mind.");
    expect(w.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
  });

  test('uses the merchant\'s own reply text for the opt-out button when there is one', async () => {
    const w = world();
    w.node.buttons[1].nextAction.replyText = 'Sorry to see you go.';
    await w.run(noThanks());
    expect(w.sent[0].body).toBe('Sorry to see you go.');
  });

  test('a customer who is already opted out and taps again is still processed (always safe to honour)', async () => {
    const w = world({ customer: { optedOut: true } });
    expect((await w.run(noThanks())).outcome).toBe('opted_out');
  });

  test('a failure in the same-phone sweep or in the reply never prevents or hides the withdrawal', async () => {
    const w = world();
    w.deps.optOutSamePhone.mockRejectedValue(new Error('sweep failed'));
    w.deps.sendText.mockRejectedValue(new Error('send failed'));
    const out = await w.run(noThanks());
    expect(out).toMatchObject({ outcome: 'opted_out', replied: false });
    expect(w.deps.consent.withdrawMarketingConsent).toHaveBeenCalledTimes(1);
  });

  test('if the withdrawal itself cannot be written the tap is swallowed (logged), never thrown', async () => {
    const w = world();
    w.deps.consent.withdrawMarketingConsent.mockRejectedValue(new Error('db down'));
    const out = await w.run(noThanks());
    expect(out).toMatchObject({ handled: false, outcome: 'error' });
    expect(w.sent).toHaveLength(0);
  });
});

describe('redelivery (same inbound message id)', () => {
  test('a duplicate opt-in or opt-out gets no second reply, no statistics and no second sweep', async () => {
    const a = world({ duplicate: true });
    expect(await a.run(templateTap(OPT_IN))).toMatchObject({ handled: true, outcome: 'duplicate', duplicate: true });
    expect(a.sent).toHaveLength(0);
    expect(a.deps.CampaignMessage.updateOne).not.toHaveBeenCalled();

    const b = world({ duplicate: true });
    expect(await b.run(templateTap(OPT_OUT, { button: { payload: OPT_OUT, text: 'No thanks' } }))).toMatchObject({ outcome: 'duplicate' });
    expect(b.sent).toHaveLength(0);
    expect(b.deps.optOutSamePhone).not.toHaveBeenCalled();
  });

  // The unique index on ConsentEvent.inboundWamid may not exist on every database engine (Cosmos DB for MongoDB refuses to build a unique
  // index on a collection that already holds rows): a message that is already in the log is never recorded or answered again.
  test('a message id that is already in the consent log is recorded and answered once, with or without the unique index', async () => {
    const a = world({ seen: true });
    expect(await a.run(templateTap(OPT_IN))).toMatchObject({ handled: true, outcome: 'duplicate', duplicate: true });
    expect(a.deps.eventSeen).toHaveBeenCalledWith('wamid.IN1');
    expect(a.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
    expect(a.sent).toHaveLength(0);

    const b = world({ seen: true });
    expect(await b.run(templateTap(OPT_OUT, { button: { payload: OPT_OUT, text: 'No thanks' } }))).toMatchObject({ outcome: 'duplicate' });
    expect(b.deps.consent.withdrawMarketingConsent).not.toHaveBeenCalled();
    expect(b.sent).toHaveLength(0);
  });

  test('the default lookup asks the consent log by the inbound id; a failing lookup never blocks a tap (it is treated as new)', async () => {
    const lookup = (result) => { const w = world(); delete w.deps.eventSeen; ConsentEvent.findOne.mockReset(); ConsentEvent.findOne.mockImplementation(result); return w; };
    const seen = lookup(() => q({ _id: 'ev1' }));
    expect(await seen.run(templateTap(OPT_IN))).toMatchObject({ outcome: 'duplicate' });
    expect(ConsentEvent.findOne).toHaveBeenCalledWith({ inboundWamid: 'wamid.IN1' });

    const fresh = lookup(() => q(null));
    expect(await fresh.run(templateTap(OPT_IN))).toMatchObject({ outcome: 'opted_in' });

    const broken = lookup(() => { throw new Error('db down'); });
    expect(await broken.run(templateTap(OPT_IN))).toMatchObject({ outcome: 'opted_in' });
  });

  test('an opt-in tapped BEFORE the opt-out on record (late or repeated delivery) is ignored; one tapped after it counts', async () => {
    const early = world({ customer: { optedOut: true, optedOutAt: new Date('2026-10-20T00:00:00Z'), marketingConsent: true } }); // TS = 14 Oct
    expect(await early.run(templateTap(OPT_IN))).toMatchObject({ handled: true, outcome: 'stale_tap' });
    expect(early.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
    expect(early.sent).toHaveLength(0);

    const later = world({ customer: { optedOut: true, optedOutAt: new Date('2026-10-20T00:00:00Z'), marketingConsent: true } });
    const after = String(Math.floor(new Date('2026-10-25T00:00:00Z').getTime() / 1000));
    expect(await later.run(templateTap(OPT_IN, { timestamp: after }))).toMatchObject({ outcome: 'opted_in' });
    expect(later.deps.consent.recordCustomerOptIn).toHaveBeenCalledTimes(1);

    // within the clock-skew margin of the opt-out: counts (two clocks)
    const close = world({ customer: { optedOut: true, optedOutAt: new Date('2026-10-14T17:46:45Z') } }); // TS = 17:46:40
    expect(await close.run(templateTap(OPT_IN))).toMatchObject({ outcome: 'opted_in' });

    // a customer who is not opted out is never "stale"
    const normal = world();
    expect(await normal.run(templateTap(OPT_IN))).toMatchObject({ outcome: 'opted_in' });
  });

  test('a duplicate "interested" tap is caught by the claim on the message (no second catalog)', async () => {
    const w = world({ claimFails: true, promotion: { products: ['p1'] } });
    const out = await w.run(templateTap(INTERESTED, { button: { payload: INTERESTED, text: 'Tell me more' } }));
    expect(out).toMatchObject({ outcome: 'duplicate', duplicate: true });
    expect(w.deps.handlePromoInterest).not.toHaveBeenCalled();
    expect(w.deps.CampaignMessage.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: 'cm1', lastTapWamid: { $ne: 'wamid.IN1' } });
  });
});

describe('interested and None', () => {
  const tell = (over) => templateTap(INTERESTED, { button: { payload: INTERESTED, text: 'Tell me more' }, ...over });

  test('records the tap, flags the conversation open and continues into the shop flow when the promotion has products', async () => {
    const w = world({ promotion: { products: ['p1', 'p2'] } });
    const out = await w.run(tell());
    expect(out).toMatchObject({ handled: true, outcome: 'interested', continued: true });
    expect(w.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled(); // interest is not consent
    expect(w.deps.consent.withdrawMarketingConsent).not.toHaveBeenCalled();
    expect(w.deps.Customer.updateOne).toHaveBeenCalledWith({ _id: 'cust1' }, { $set: { conversationStatus: 'open' } });
    expect(w.deps.handlePromoInterest).toHaveBeenCalledWith('966501234567', PROMO, 'cm1', WS_A);
    expect(w.deps.CampaignMessage.updateOne.mock.calls[0][1].$set.clickedButtonAction).toBe('interested');
  });

  test('also continues for services and for a store-wide promotion', async () => {
    const s = world({ promotion: { services: ['s1'] } });
    await s.run(tell());
    expect(s.deps.handlePromoInterest).toHaveBeenCalledTimes(1);
    const sw = world({ promotion: { type: 'store_wide' } });
    await sw.run(tell());
    expect(sw.deps.handlePromoInterest).toHaveBeenCalledTimes(1);
  });

  test('with nothing to show it sends only the optional reply text and does not call the shop flow', async () => {
    const w = world();
    w.node.buttons[2].nextAction.replyText = 'We will message you the details shortly.';
    const out = await w.run(tell());
    expect(out).toMatchObject({ outcome: 'interested', continued: false, replied: true });
    expect(w.deps.handlePromoInterest).not.toHaveBeenCalled();
    expect(w.sent.map((s) => s.body)).toEqual(['We will message you the details shortly.']);

    const quiet = world();
    await quiet.run(tell());
    expect(quiet.sent).toHaveLength(0); // no reply text configured: nothing is sent
  });

  test('works when the injected shop handler is missing, and a failing shop handler is swallowed', async () => {
    const none = world({ promotion: { products: ['p1'] }, deps: { handlePromoInterest: null } });
    expect((await none.run(tell())).continued).toBe(false);
    const bad = world({ promotion: { products: ['p1'] } });
    bad.deps.handlePromoInterest.mockRejectedValue(new Error('catalog failed'));
    expect((await bad.run(tell())).continued).toBe(false);
  });

  test('end_flow ("None") records the tap only', async () => {
    const w = noneWorld();
    const out = await w.run(templateTap(NONE, { button: { payload: NONE, text: 'Maybe later' } }));
    expect(out).toMatchObject({ handled: true, outcome: 'recorded', action: 'end_flow' });
    expect(w.sent).toHaveLength(0);
    expect(w.deps.handlePromoInterest).not.toHaveBeenCalled();
    expect(w.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
    expect(w.deps.Customer.updateOne).not.toHaveBeenCalled();
    expect(w.deps.CampaignMessage.updateOne.mock.calls[0][1].$set.clickedButtonAction).toBe('end_flow');
  });
});

describe('who and what is refused (nothing written, nothing sent)', () => {
  async function refused(w, message, outcome) {
    const out = await w.run(message);
    expect(out).toMatchObject({ handled: false, outcome });
    expect(w.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
    expect(w.deps.consent.withdrawMarketingConsent).not.toHaveBeenCalled();
    expect(w.sent).toHaveLength(0);
    expect(w.deps.CampaignMessage.updateOne).not.toHaveBeenCalled();
    return out;
  }

  test('wrong phone: the sender is not the customer the message was sent to', async () => {
    const w = world();
    w.deps.phonesMatch.mockResolvedValue(false);
    await refused(w, templateTap(OPT_IN), 'phone_mismatch');
    expect(w.deps.phonesMatch).toHaveBeenCalledWith('+966 50 123 4567', '966501234567', WS_A);
    const optOut = world();
    optOut.deps.phonesMatch.mockResolvedValue(false);
    await refused(optOut, templateTap(OPT_OUT), 'phone_mismatch'); // somebody else cannot opt a customer out either
  });

  test('unknown wamid and no fallback message', async () => {
    const w = world();
    await refused(w, templateTap(OPT_IN, { context: { id: 'wamid.NOPE' } }), 'unknown_message');
  });

  test('no context id at all: falls back to the latest message for that promotion and phone', async () => {
    const w = world({ fallbackCm: undefined });
    const fallback = { ...world().cm, wamid: 'wamid.OLDER' };
    const w2 = world({ fallbackCm: fallback });
    const out = await w2.run(templateTap(OPT_IN, { context: undefined }));
    expect(out.outcome).toBe('opted_in');
    const filter = w2.deps.CampaignMessage.findOne.mock.calls[0][0];
    expect(filter.promotion).toBe(PROMO);
    expect(filter.phone.$in).toEqual(expect.arrayContaining(['966501234567', '+966501234567']));
    await refused(w, templateTap(OPT_IN, { context: undefined }), 'unknown_message');
  });

  test('wrong promotion: the payload names another promotion than the tapped message belongs to', async () => {
    const w = world();
    await refused(w, templateTap(`promo:${OTHER_PROMO}:opt_in:0`), 'promotion_mismatch');
  });

  test('promotion, customer or workspace cannot be resolved / do not agree', async () => {
    await refused(world({ noPromotion: true }), templateTap(OPT_IN), 'promotion_not_found');
    await refused(world({ noCustomer: true }), templateTap(OPT_IN), 'customer_not_found');
    await refused(world({ cm: { customer: undefined } }), templateTap(OPT_IN), 'customer_not_found');
    await refused(world({ customer: { workspaceId: WS_B } }), templateTap(OPT_IN), 'workspace_mismatch');
    await refused(world({ promotion: { workspaceId: WS_B } }), templateTap(OPT_IN), 'workspace_mismatch');
    await refused(world({ customer: { deletedAt: new Date() } }), templateTap(OPT_IN), 'customer_erased');
  });

  test('the promotion was deleted after the message went out: an opt-out is STILL honoured (from what the message carries), an opt-in is not', async () => {
    const w = world({ noPromotion: true });
    const out = await w.run(templateTap(OPT_OUT, { button: { payload: OPT_OUT, text: 'No thanks' } }));
    expect(out).toMatchObject({ handled: true, outcome: 'opted_out', workspaceId: WS_A, customerId: 'cust1' });
    expect(w.deps.consent.withdrawMarketingConsent).toHaveBeenCalledTimes(1);
    expect(w.deps.consent.withdrawMarketingConsent.mock.calls[0][0].evidence).toMatchObject({ promotionName: 'Spring opt-in', buttonAction: 'opt_out' });
    expect(w.sent[0].body).toMatch(/^No problem, Sara/);
    await refused(world({ noPromotion: true }), templateTap(OPT_IN), 'promotion_not_found');
  });

  test('payloads that are not ours, malformed, or carry an unknown action are ignored', async () => {
    const w = world();
    await refused(w, templateTap('promo_' + PROMO), 'not_a_promo_tap');
    await refused(w, templateTap('promo:zzz:opt_in:0'), 'not_a_promo_tap');
    await refused(w, templateTap(`promo:${PROMO}:subscribe:0`), 'unknown_action');
    await refused(w, { id: 'x', type: 'text', text: { body: 'hello' } }, 'not_a_promo_tap');
    expect((await handlePromoConsentTap({ from: '', message: templateTap(OPT_IN), deps: w.deps })).outcome).toBe('no_sender');
  });

  test('payload and sent button disagree: an opt-out still wins, anything else is ignored', async () => {
    // payload says opt_in, the button that was sent at that position was opt_out
    const a = world({ cm: { consentSnapshot: { promotionName: 'P', buttons: [{ position: 0, label: 'No', action: 'opt_out' }] } } });
    const out = await a.run(templateTap(OPT_IN));
    expect(out.outcome).toBe('opted_out');
    expect(a.deps.consent.recordCustomerOptIn).not.toHaveBeenCalled();
    // payload says opt_out, the sent button was opt_in
    const b = world({ cm: { consentSnapshot: { promotionName: 'P', buttons: [{ position: 1, label: 'Yes', action: 'opt_in' }] } } });
    expect((await b.run(templateTap(OPT_OUT))).outcome).toBe('opted_out');
    // interested vs opt_in: refused
    const c = world({ cm: { consentSnapshot: { promotionName: 'P', buttons: [{ position: 2, label: 'Yes', action: 'opt_in' }] } } });
    await refused(c, templateTap(INTERESTED), 'action_mismatch');
  });
});

describe('tenant resolution', () => {
  test('workspace and customer come from the message found by context.id WITHOUT a workspace filter', async () => {
    const w = world({
      customer: { workspaceId: WS_B }, cm: { workspaceId: WS_B }, promotion: { workspaceId: WS_B, products: ['p1'] }, node: { workspaceId: WS_B },
    });
    const out = await w.run(templateTap(OPT_IN));
    expect(out).toMatchObject({ outcome: 'opted_in', workspaceId: WS_B });
    expect(w.deps.CampaignMessage.findOne.mock.calls[0][0]).toEqual({ wamid: 'wamid.OUT' }); // no workspaceId in the filter
    expect(String(w.deps.consent.recordCustomerOptIn.mock.calls[0][0].workspaceId)).toBe(WS_B);
    expect(w.sent[0].opts).toEqual({ workspaceId: WS_B }); // the reply goes through that tenant's sender
    await w.run(templateTap(INTERESTED, { button: { payload: INTERESTED, text: 'x' }, id: 'wamid.IN2' }));
    expect(w.deps.handlePromoInterest).toHaveBeenCalledWith('966501234567', PROMO, 'cm1', WS_B);
  });

  test('the reply and the shop flow run inside the sender context of the tapped tenant (its own WhatsApp number)', async () => {
    const seen = [];
    const senderContext = require('../utils/senderContext');
    const w = world({
      customer: { workspaceId: WS_B }, cm: { workspaceId: WS_B }, promotion: { workspaceId: WS_B, products: ['p1'] },
      deps: {
        sendText: async () => { seen.push(['reply', senderContext.currentWorkspaceId()]); },
        handlePromoInterest: async () => { seen.push(['shop', senderContext.currentWorkspaceId()]); },
      },
    });
    await w.run(templateTap(OPT_IN));
    await w.run(templateTap(INTERESTED, { id: 'wamid.IN2', button: { payload: INTERESTED, text: 'x' } }));
    expect(seen).toEqual([['reply', WS_B], ['shop', WS_B]]);
    expect(senderContext.currentWorkspaceId()).toBeNull();
  });

  test('an event that arrived on the SHARED number is answered from it (the tapped tenant\'s context keeps "via the shared number"); one on the customer\'s own number is not', async () => {
    const senderContext = require('../utils/senderContext');
    const seen = [];
    const mk = () => world({
      customer: { workspaceId: WS_B }, cm: { workspaceId: WS_B }, promotion: { workspaceId: WS_B },
      deps: { sendText: async () => { seen.push([senderContext.currentWorkspaceId(), senderContext.isViaPlatformNumber()]); } },
    });
    const shared = mk();
    await senderContext.run(WS_A, () => shared.run(templateTap(OPT_IN)), { viaPlatformNumber: true }); // what the webhook enters for a shared-number event
    const own = mk();
    await senderContext.run(WS_A, () => own.run(templateTap(OPT_IN)));
    expect(seen).toEqual([[WS_B, true], [WS_B, false]]);
  });

  test('a message row without a workspace (older flow rows) takes the promotion\'s workspace', async () => {
    const w = world({ cm: { workspaceId: undefined }, promotion: { workspaceId: WS_B }, customer: { workspaceId: WS_B } });
    const out = await w.run(templateTap(OPT_IN));
    expect(out).toMatchObject({ outcome: 'opted_in', workspaceId: WS_B });
  });

  test('two tenants with the same customer phone: the tap lands on the customer of the tapped message', async () => {
    const a = world({ customer: { _id: 'custA', workspaceId: WS_A }, cm: { customer: 'custA', workspaceId: WS_A } });
    const b = world({ customer: { _id: 'custB', workspaceId: WS_B }, cm: { customer: 'custB', workspaceId: WS_B, wamid: 'wamid.OUT-B' }, promotion: { workspaceId: WS_B } });
    await a.run(templateTap(OPT_IN));
    await b.run(templateTap(OPT_IN, { context: { id: 'wamid.OUT-B' } }));
    expect(a.deps.consent.recordCustomerOptIn.mock.calls[0][0].customer._id).toBe('custA');
    expect(b.deps.consent.recordCustomerOptIn.mock.calls[0][0].customer._id).toBe('custB');
    expect(String(b.deps.consent.recordCustomerOptIn.mock.calls[0][0].workspaceId)).toBe(WS_B);
  });
});

describe('never throws', () => {
  test('missing arguments, hostile messages and failing dependencies all come back as a result object', async () => {
    const w = world();
    await expect(handlePromoConsentTap()).resolves.toMatchObject({ handled: false });
    await expect(handlePromoConsentTap({})).resolves.toMatchObject({ handled: false });
    await expect(handlePromoConsentTap({ from: '1', message: null })).resolves.toMatchObject({ handled: false });
    await expect(handlePromoConsentTap({ from: '1', message: { button: 5 } })).resolves.toMatchObject({ handled: false });
    await expect(handlePromoConsentTap({ from: {}, message: templateTap(OPT_IN), deps: w.deps })).resolves.toBeDefined();

    for (const failing of ['CampaignMessage', 'Customer', 'Promotion']) {
      const bad = world();
      bad.deps[failing] = { findOne: () => { throw new Error('boom'); }, findById: () => { throw new Error('boom'); }, updateOne: () => { throw new Error('boom'); } };
      await expect(bad.run(templateTap(OPT_IN))).resolves.toMatchObject({ handled: false, outcome: 'error' });
      expect(bad.log).toHaveBeenCalled();
    }
    const noLogger = world({ deps: { log: () => { throw new Error('logger down'); } } });
    noLogger.deps.consent.recordCustomerOptIn.mockRejectedValue(new Error('x'));
    await expect(noLogger.run(templateTap(OPT_IN))).resolves.toMatchObject({ outcome: 'error' });
  });

  test('a node lookup failure only costs the optional text, not the consent record', async () => {
    const w = world();
    w.deps.MessageNode.findById = jest.fn(() => { throw new Error('node lookup down'); });
    const out = await w.run(templateTap(OPT_IN));
    expect(out.outcome).toBe('opted_in');
    expect(w.sent[0].body).toMatch(/^You're in!/); // default text
  });
});

describe('default helpers', () => {
  test('default phone match: equal digits match; a national-format stored number matches via the workspace country code; others do not', async () => {
    Settings.findOne.mockReturnValue(q({ defaultCountryCode: '966' }));
    const noDeps = {}; // use the real defaultPhonesMatch through the handler's lazy default
    const run = (storedPhone) => {
      const w = world({ customer: { phone: storedPhone } });
      delete w.deps.phonesMatch;
      return w.run(templateTap(OPT_IN)).then((o) => o.outcome);
    };
    expect(await run('+966 50 123 4567')).toBe('opted_in');
    expect(await run('00966501234567')).toBe('opted_in');
    expect(await run('0501234567')).toBe('opted_in'); // till-captured local number
    expect(await run('+966 50 765 4321')).toBe('phone_mismatch');
    expect(await run('0507654321')).toBe('phone_mismatch');
    expect(noDeps).toEqual({});
  });

  test('default business name: Settings.merchantName, else the workspace name, else "us"', async () => {
    const mk = (settings, workspace) => {
      const w = world();
      delete w.deps.businessName;
      w.deps.Settings = { findOne: jest.fn(() => q(settings)) };
      w.deps.Workspace = { findById: jest.fn(() => q(workspace)) };
      return w;
    };
    const a = mk({ merchantName: ' Aroma Cafe ' }, { name: 'ws' });
    await a.run(templateTap(OPT_IN));
    expect(a.sent[0].body).toContain('offers from Aroma Cafe here');
    const b = mk({ merchantName: '' }, { name: 'Workspace Name' });
    await b.run(templateTap(OPT_IN));
    expect(b.sent[0].body).toContain('offers from Workspace Name here');
    const c = mk(null, null);
    await c.run(templateTap(OPT_IN));
    expect(c.sent[0].body).toContain('offers from us here');
  });
});
