// Unit tests for the consent core (shared/consent.js additions) and the additive schema changes behind it.
// No database: ConsentEvent and Customer are mocked for the behaviour tests; the schema tests use the real models without
// a connection (validation and index declarations need none), so nothing here can touch real data.
jest.mock('../models/ConsentEvent', () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Customer', () => ({ updateOne: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../utils/whatsapp', () => ({ waPost: jest.fn() }));

const ConsentEvent = require('../models/ConsentEvent');
const Customer = require('../models/Customer');
const consent = require('../shared/consent');

const WS = '64b000000000000000000001';
const CUSTOMER_ID = '64b0000000000000000000c1';

function makeCustomer(over = {}) {
  const c = {
    _id: CUSTOMER_ID, workspaceId: WS, phone: '966501234567', firstname: 'Sara',
    marketingConsent: false, optedOut: false, ...over,
  };
  c.save = jest.fn(async () => c);
  return c;
}
const eventArg = () => ConsentEvent.create.mock.calls[0][0];
function latestEventIs(inboundWamid) {
  ConsentEvent.findOne.mockReturnValue({ sort: () => ({ lean: async () => (inboundWamid === null ? null : { inboundWamid }) }) });
}
const dupError = () => Object.assign(new Error('E11000 duplicate key error collection: consentevents index: inboundWamid_1'), { code: 11000 });

beforeEach(() => {
  ConsentEvent.create.mockReset();
  ConsentEvent.findOne.mockReset();
  Customer.updateOne.mockReset();
  ConsentEvent.create.mockImplementation(async (doc) => ({ ...doc }));
});

describe('deriveConsentStatus', () => {
  test.each([
    [{ marketingConsent: true, optedOut: false }, 'opted_in'],
    [{ marketingConsent: true }, 'opted_in'],
    [{ marketingConsent: true, optedOut: true }, 'opted_out'],
    [{ marketingConsent: false, optedOut: true }, 'opted_out'],
    [{ optedOut: true }, 'opted_out'],
    [{ marketingConsent: false, optedOut: false }, 'not_responded'],
    [{}, 'not_responded'],
    [{ marketingConsent: 'true' }, 'not_responded'], // only a real boolean counts, same as canSendMarketing
    [null, 'not_responded'],
    [undefined, 'not_responded'],
  ])('%j -> %s', (customer, expected) => {
    expect(consent.deriveConsentStatus(customer)).toBe(expected);
  });

  test('a legacy "No thanks" decline (event only, customer untouched) is not_responded', () => {
    expect(consent.deriveConsentStatus(makeCustomer())).toBe('not_responded');
  });

  test('agrees with canSendMarketing: only opted_in customers can be sent marketing', () => {
    for (const c of [{ marketingConsent: true }, { marketingConsent: true, optedOut: true }, { optedOut: true }, {}]) {
      expect(consent.canSendMarketing(c)).toBe(consent.deriveConsentStatus(c) === 'opted_in');
    }
  });
});

describe('recordCustomerOptIn', () => {
  const evidence = {
    promotionId: 'p1', promotionName: 'Spring', messageText: 'Hi Sara, want offers?', buttonLabel: 'Yes, send me offers',
    buttonPosition: 0, buttonAction: 'opt_in', templateName: 'waflow_flow_abc', templateVersion: 2,
    sourceWamid: 'wamid.OUT', inboundWamid: 'wamid.IN1', tappedAt: new Date('2026-10-26T08:00:00Z'), signature: 'valid',
  };

  test('logs a consent_given event with the evidence, THEN sets consent and clears an earlier opt-out', async () => {
    const c = makeCustomer({ optedOut: true, optedOutAt: new Date('2026-01-01') });
    c.save.mockImplementation(async () => {
      expect(ConsentEvent.create).toHaveBeenCalledTimes(1); // the event is written before the customer is touched
      return c;
    });
    const out = await consent.recordCustomerOptIn({ customer: c, method: 'whatsapp_button', source: 'tap', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(false);
    expect(out.customer).toBe(c);
    const doc = eventArg();
    expect(doc).toMatchObject({
      workspaceId: WS, customerId: CUSTOMER_ID, phone: '966501234567', type: 'consent_given', method: 'whatsapp_button', source: 'tap',
      ...evidence,
    });
    expect(doc.receivedAt).toBeInstanceOf(Date);
    expect(c.marketingConsent).toBe(true);
    expect(c.marketingConsentMethod).toBe('whatsapp_button');
    expect(c.marketingConsentAt).toBeInstanceOf(Date);
    expect(c.optedOut).toBe(false);
    expect(c.optedOutAt).toBeNull();
    expect(c.save).toHaveBeenCalledTimes(1);
  });

  test('works without evidence (no evidence keys are written) and defaults the method to whatsapp_button', async () => {
    const c = makeCustomer();
    await consent.recordCustomerOptIn({ customer: c, source: 's', workspaceId: WS });
    const doc = eventArg();
    expect(doc.method).toBe('whatsapp_button');
    for (const k of ['inboundWamid', 'messageText', 'promotionId', 'receivedAt', 'signature']) expect(Object.keys(doc)).not.toContain(k);
  });

  test('falls back to the customer workspace when none is passed', async () => {
    await consent.recordCustomerOptIn({ customer: makeCustomer(), source: 's' });
    expect(eventArg().workspaceId).toBe(WS);
  });

  test('evidence is cleaned: empty values dropped (never a null inboundWamid), unknown keys ignored, dates parsed, text clamped', async () => {
    await consent.recordCustomerOptIn({
      customer: makeCustomer(), source: 's', workspaceId: WS,
      evidence: {
        inboundWamid: null, sourceWamid: '', buttonLabel: undefined, signature: null,
        type: 'consent_withdrawn', method: 'manual_staff_entry', customerId: 'someone-else', phone: '1', extra: 'x',
        tappedAt: '2026-10-26T08:00:00Z', receivedAt: 'not a date', messageText: 'x'.repeat(5000), buttonLabel2: 'y',
        templateName: 'n'.repeat(900),
      },
    });
    const doc = eventArg();
    expect(Object.keys(doc)).not.toContain('inboundWamid');
    expect(Object.keys(doc)).not.toContain('sourceWamid');
    expect(Object.keys(doc)).not.toContain('signature');
    expect(Object.keys(doc)).not.toContain('extra');
    expect(doc.type).toBe('consent_given'); // evidence can never override what the helper decides
    expect(doc.method).toBe('whatsapp_button');
    expect(doc.customerId).toBe(CUSTOMER_ID);
    expect(doc.phone).toBe('966501234567');
    expect(doc.tappedAt).toEqual(new Date('2026-10-26T08:00:00Z'));
    expect(doc.receivedAt).toBeInstanceOf(Date); // the bad date was dropped, then defaulted to now
    expect(doc.messageText).toHaveLength(4096);
    expect(doc.templateName).toHaveLength(500);
  });

  test('if the event cannot be written the customer is NOT changed', async () => {
    const c = makeCustomer({ optedOut: true });
    ConsentEvent.create.mockRejectedValue(new Error('db down'));
    await expect(consent.recordCustomerOptIn({ customer: c, source: 's', workspaceId: WS, evidence })).rejects.toThrow('db down');
    expect(c.save).not.toHaveBeenCalled();
    expect(c.optedOut).toBe(true);
    expect(c.marketingConsent).toBe(false);
  });

  test('opting in when already opted in is fine (history keeps growing, consent stays true)', async () => {
    const c = makeCustomer({ marketingConsent: true });
    const out = await consent.recordCustomerOptIn({ customer: c, source: 's', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(false);
    expect(c.marketingConsent).toBe(true);
  });
});

describe('staff / import grants keep today\'s behaviour', () => {
  test('grantMarketingConsent does NOT clear an opt-out', async () => {
    const c = makeCustomer({ optedOut: true, optedOutAt: new Date('2026-01-01') });
    await consent.grantMarketingConsent({ customer: c, method: 'manual_staff_entry', source: 'Add Customer form', workspaceId: WS });
    expect(c.marketingConsent).toBe(true);
    expect(c.optedOut).toBe(true); // a staff tick-box must not override the customer's own STOP
    expect(c.optedOutAt).toEqual(new Date('2026-01-01'));
    expect(consent.canSendMarketing(c)).toBe(false);
    expect(eventArg()).toMatchObject({ type: 'consent_given', method: 'manual_staff_entry' });
  });

  test('legacy calls write no evidence fields at all', async () => {
    const c = makeCustomer();
    await consent.grantMarketingConsent({ customer: c, method: 'manual_staff_entry', source: 's', workspaceId: WS });
    await consent.withdrawMarketingConsent({ customer: c, method: 'whatsapp_stop_command', source: 's', workspaceId: WS });
    await consent.declineMarketingConsent({ customer: c, method: 'whatsapp_button', source: 's', workspaceId: WS });
    for (const [doc] of ConsentEvent.create.mock.calls) {
      expect(Object.keys(doc).sort()).toEqual(
        ['campaignMessageId', 'customerId', 'importJobId', 'method', 'performedBy', 'phone', 'source', 'type', 'workspaceId'].sort(),
      );
    }
  });
});

describe('withdrawMarketingConsent', () => {
  test('returns the customer, sets optedOut, logs after nothing else, and writes evidence', async () => {
    const c = makeCustomer({ marketingConsent: true });
    const out = await consent.withdrawMarketingConsent({
      customer: c, method: 'whatsapp_optout_button', source: 'btn', workspaceId: WS,
      evidence: { promotionId: 'p1', buttonAction: 'opt_out', inboundWamid: 'wamid.IN2', signature: 'invalid' },
    });
    expect(out).toBe(c);
    expect(c.optedOut).toBe(true);
    expect(c.optedOutAt).toBeInstanceOf(Date);
    expect(c.marketingConsent).toBe(true); // consent history is not rewritten, the opt-out blocks sending
    expect(eventArg()).toMatchObject({ type: 'consent_withdrawn', buttonAction: 'opt_out', inboundWamid: 'wamid.IN2', signature: 'invalid' });
  });

  test('an event write failure leaves the customer untouched', async () => {
    const c = makeCustomer();
    ConsentEvent.create.mockRejectedValue(new Error('db down'));
    await expect(consent.withdrawMarketingConsent({ customer: c, method: 'whatsapp_stop_command', source: 's', workspaceId: WS })).rejects.toThrow('db down');
    expect(c.save).not.toHaveBeenCalled();
    expect(c.optedOut).toBe(false);
  });
});

describe('declineMarketingConsent', () => {
  test('logs consent_declined with evidence and leaves the customer alone', async () => {
    const c = makeCustomer();
    const out = await consent.declineMarketingConsent({ customer: c, method: 'whatsapp_button', source: 's', workspaceId: WS, evidence: { buttonLabel: 'No thanks' } });
    expect(out.type).toBe('consent_declined');
    expect(eventArg().buttonLabel).toBe('No thanks');
    expect(c.save).not.toHaveBeenCalled();
    expect(c.marketingConsent).toBe(false);
  });
});

describe('reinstateMarketingConsent (START)', () => {
  test('START after an opt-out is a FRESH opt-in: consent_given, whatsapp_start_command, "START after opt-out", clears the opt-out', async () => {
    const c = makeCustomer({ marketingConsent: true, optedOut: true, optedOutAt: new Date('2026-01-01') });
    const out = await consent.reinstateMarketingConsent({ customer: c, method: 'whatsapp_start_command', source: 'WhatsApp START reply', workspaceId: WS });
    expect(out).toBe(true);
    expect(eventArg()).toMatchObject({ type: 'consent_given', method: 'whatsapp_start_command', source: 'START after opt-out' });
    expect(c.optedOut).toBe(false);
    expect(c.optedOutAt).toBeNull();
    expect(c.marketingConsent).toBe(true);
    expect(c.marketingConsentMethod).toBe('whatsapp_button'); // the customer record only knows the previous release's two values
    expect(consent.canSendMarketing(c)).toBe(true);
  });

  test('START after an opt-out also works for someone who never opted in (e.g. they opted out through a promotion button)', async () => {
    const c = makeCustomer({ marketingConsent: false, optedOut: true });
    const out = await consent.reinstateMarketingConsent({ customer: c, method: 'whatsapp_start_command', source: 'x', workspaceId: WS });
    expect(out).toBe(true);
    expect(eventArg().type).toBe('consent_given');
    expect(c.marketingConsent).toBe(true);
    expect(c.optedOut).toBe(false);
  });

  test('START from a customer who never opted in and never opted out changes nothing and returns false', async () => {
    const c = makeCustomer();
    const out = await consent.reinstateMarketingConsent({ customer: c, method: 'whatsapp_start_command', source: 'x', workspaceId: WS });
    expect(out).toBe(false);
    expect(ConsentEvent.create).not.toHaveBeenCalled();
    expect(c.save).not.toHaveBeenCalled();
    expect(c.marketingConsent).toBe(false);
  });

  test('START from a customer who is already opted in and not opted out keeps the legacy consent_reinstated event', async () => {
    const c = makeCustomer({ marketingConsent: true, optedOut: false });
    const out = await consent.reinstateMarketingConsent({ customer: c, method: 'whatsapp_start_command', source: 'WhatsApp START reply', workspaceId: WS });
    expect(out).toBe(true);
    expect(eventArg()).toMatchObject({ type: 'consent_reinstated', method: 'whatsapp_start_command', source: 'WhatsApp START reply' });
  });

  test('the evidence of a START (e.g. its inbound message id) lands on the fresh opt-in', async () => {
    const c = makeCustomer({ optedOut: true });
    await consent.reinstateMarketingConsent({ customer: c, method: 'whatsapp_start_command', source: 'x', workspaceId: WS, evidence: { inboundWamid: 'wamid.START1', messageText: 'START' } });
    expect(eventArg()).toMatchObject({ inboundWamid: 'wamid.START1', messageText: 'START' });
  });
});

describe('idempotency on a duplicate inbound message id (Meta redelivery)', () => {
  const evidence = { inboundWamid: 'wamid.IN1', buttonAction: 'opt_in' };

  test('opt-in redelivery: reports duplicate and re-applies the update when that event is still the latest', async () => {
    const c = makeCustomer({ marketingConsent: false, optedOut: true });
    ConsentEvent.create.mockRejectedValue(dupError());
    latestEventIs('wamid.IN1'); // the first delivery wrote the event, then died before updating the customer
    const out = await consent.recordCustomerOptIn({ customer: c, method: 'whatsapp_button', source: 's', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(true);
    expect(Customer.updateOne).toHaveBeenCalledTimes(1);
    expect(Customer.updateOne.mock.calls[0][0]).toEqual({ _id: CUSTOMER_ID });
    expect(Customer.updateOne.mock.calls[0][1].$set).toMatchObject({ marketingConsent: true, optedOut: false, optedOutAt: null });
    expect(c.save).not.toHaveBeenCalled();
  });

  test('a LATE redelivery of an old opt-in never undoes a later opt-out', async () => {
    const c = makeCustomer({ marketingConsent: true, optedOut: true });
    ConsentEvent.create.mockRejectedValue(dupError());
    latestEventIs('wamid.LATER-OPTOUT');
    const out = await consent.recordCustomerOptIn({ customer: c, method: 'whatsapp_button', source: 's', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(true);
    expect(Customer.updateOne).not.toHaveBeenCalled();
    expect(c.optedOut).toBe(true);
  });

  test('a redelivery whose event cannot be found any more does not touch the customer either', async () => {
    const c = makeCustomer();
    ConsentEvent.create.mockRejectedValue(dupError());
    latestEventIs(null);
    const out = await consent.recordCustomerOptIn({ customer: c, source: 's', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(true);
    expect(Customer.updateOne).not.toHaveBeenCalled();
  });

  test('opt-out redelivery: duplicate, re-applies only while still the latest event', async () => {
    const c = makeCustomer();
    ConsentEvent.create.mockRejectedValue(dupError());
    latestEventIs('wamid.IN1');
    const out = await consent.withdrawMarketingConsent({ customer: c, method: 'whatsapp_optout_button', source: 's', workspaceId: WS, evidence });
    expect(out.duplicate).toBe(true);
    expect(Customer.updateOne.mock.calls[0][1].$set).toMatchObject({ optedOut: true });

    Customer.updateOne.mockReset();
    latestEventIs('wamid.NEWER-OPTIN');
    const out2 = await consent.withdrawMarketingConsent({ customer: makeCustomer(), method: 'whatsapp_optout_button', source: 's', workspaceId: WS, evidence });
    expect(out2.duplicate).toBe(true);
    expect(Customer.updateOne).not.toHaveBeenCalled();
  });

  test('decline and START redeliveries report duplicate too', async () => {
    ConsentEvent.create.mockRejectedValue(dupError());
    expect(await consent.declineMarketingConsent({ customer: makeCustomer(), method: 'whatsapp_button', source: 's', workspaceId: WS, evidence })).toEqual({ duplicate: true });
    latestEventIs('wamid.IN1');
    const start = await consent.reinstateMarketingConsent({ customer: makeCustomer({ optedOut: true }), method: 'whatsapp_start_command', source: 's', workspaceId: WS, evidence });
    expect(start.duplicate).toBe(true); // truthy: callers that only test the result still treat the customer as reachable
    const legacy = await consent.reinstateMarketingConsent({ customer: makeCustomer({ marketingConsent: true }), method: 'whatsapp_start_command', source: 's', workspaceId: WS, evidence });
    expect(legacy.duplicate).toBe(true);
  });

  test('a duplicate-key error WITHOUT an inbound message id is a real error and is rethrown', async () => {
    const c = makeCustomer();
    ConsentEvent.create.mockRejectedValue(dupError());
    await expect(consent.recordCustomerOptIn({ customer: c, source: 's', workspaceId: WS, evidence: { buttonAction: 'opt_in' } })).rejects.toThrow(/E11000/);
    await expect(consent.withdrawMarketingConsent({ customer: c, method: 'whatsapp_stop_command', source: 's', workspaceId: WS })).rejects.toThrow(/E11000/);
    expect(c.save).not.toHaveBeenCalled();
  });

  test('any other write error is rethrown even with an inbound message id', async () => {
    ConsentEvent.create.mockRejectedValue(new Error('network blip'));
    await expect(consent.recordCustomerOptIn({ customer: makeCustomer(), source: 's', workspaceId: WS, evidence })).rejects.toThrow('network blip');
    await expect(consent.declineMarketingConsent({ customer: makeCustomer(), method: 'whatsapp_button', source: 's', workspaceId: WS, evidence })).rejects.toThrow('network blip');
  });
});

describe('exports the interface other modules code against', () => {
  test('every name is a function / the query constant', () => {
    for (const name of ['deriveConsentStatus', 'recordCustomerOptIn', 'withdrawMarketingConsent', 'declineMarketingConsent', 'reinstateMarketingConsent', 'canSendMarketing', 'grantMarketingConsent', 'sendUtilityMessageWithConsentAsk']) {
      expect(typeof consent[name]).toBe('function');
    }
    expect(consent.MARKETING_ELIGIBLE_QUERY).toEqual({ marketingConsent: true, optedOut: { $ne: true } });
  });
});

// ── Schemas (real models, no connection) ──────────────────────────────────────────────────────────────────────────────
describe('additive schema changes', () => {
  const Promotion = require('../models/Promotion');
  const MessageNode = require('../models/MessageNode');
  const CampaignMessage = require('../models/CampaignMessage');
  const RealConsentEvent = jest.requireActual('../models/ConsentEvent');
  const RealCustomer = jest.requireActual('../models/Customer');
  const oid = '64b0000000000000000000aa';

  test('Promotion: a plain promotion reads as purpose standard and carries no consent fields', () => {
    const p = new Promotion({ name: 'Old promo' });
    const o = p.toObject();
    expect(o.purpose).toBe('standard');
    expect(o.sendRequest).toBeUndefined(); // not an empty customerIds array on every promotion
    expect(o.consentWordingAck).toBeUndefined();
    expect(p.validateSync()).toBeUndefined();
  });

  test('Promotion: consent_request purpose and campaign type, wording ack and send request validate', () => {
    const p = new Promotion({
      name: 'Opt in', purpose: 'consent_request', campaignType: 'consent_request',
      consentWordingAck: { at: new Date(), by: oid, textHash: 'abc' },
      sendRequest: { customerIds: [oid, oid], requestedAt: new Date(), requestedBy: oid },
    });
    expect(p.validateSync()).toBeUndefined();
    expect(p.sendRequest.customerIds).toHaveLength(2);
    expect(p.sendRequest.dismissedAt).toBeUndefined();
    expect(new Promotion({ name: 'x', purpose: 'bogus' }).validateSync().errors.purpose).toBeDefined();
  });

  test('Promotion: a send request holds at most 2000 customers', () => {
    const ids = Array.from({ length: 2001 }, () => oid);
    expect(new Promotion({ name: 'x', sendRequest: { customerIds: ids } }).validateSync()).toBeDefined();
    expect(new Promotion({ name: 'x', sendRequest: { customerIds: ids.slice(0, 2000) } }).validateSync()).toBeUndefined();
  });

  test('MessageNode: entry labels up to 25, consent actions with a reply text, template lifecycle fields', () => {
    const ok = new MessageNode({
      ownerType: 'promotion', ownerId: oid, isEntryNode: true, bodyText: 'Hi {{1}}, want offers?',
      buttons: [
        { position: 0, label: 'x'.repeat(25), nextAction: { type: 'opt_in', replyText: 'Welcome!' } },
        { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
        { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } },
      ],
      templateVersion: 2, templateSubmittedAt: new Date(), templateWabaId: '123',
      templateSnapshot: { bodyText: 'b', footer: 'f', language: 'en', buttons: [{ position: 0, label: 'Yes', action: 'opt_in', replyText: 'r' }] },
    });
    expect(ok.validateSync()).toBeUndefined();
    expect(ok.templateSnapshot.buttons[0].action).toBe('opt_in');

    const tooLong = new MessageNode({ ownerType: 'promotion', ownerId: oid, bodyText: 'b', buttons: [{ position: 0, label: 'x'.repeat(26), nextAction: { type: 'end_flow' } }] });
    expect(tooLong.validateSync()).toBeDefined();
    const longReply = new MessageNode({ ownerType: 'promotion', ownerId: oid, bodyText: 'b', buttons: [{ position: 0, label: 'Yes', nextAction: { type: 'opt_in', replyText: 'x'.repeat(1001) } }] });
    expect(longReply.validateSync()).toBeDefined();
    const bogus = new MessageNode({ ownerType: 'promotion', ownerId: oid, bodyText: 'b', buttons: [{ position: 0, label: 'Yes', nextAction: { type: 'subscribe' } }] });
    expect(bogus.validateSync()).toBeDefined();
  });

  test('MessageNode: existing shapes are untouched (legacy action types, no snapshot by default)', () => {
    const n = new MessageNode({ ownerType: 'flow', ownerId: oid, bodyText: 'b', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'send_message', targetNodeId: oid } }] });
    expect(n.validateSync()).toBeUndefined();
    const o = n.toObject();
    expect(o.templateStatus).toBe('not_created');
    expect(o.templateSnapshot).toBeUndefined();
    expect(o.buttons[0].nextAction.replyText).toBeUndefined();
  });

  test('CampaignMessage: no consentSnapshot unless set; snapshot, clicked action and the phone index exist', () => {
    const base = { customer: oid, phone: '966501234567' };
    const plain = new CampaignMessage(base).toObject();
    expect(plain.consentSnapshot).toBeUndefined();
    expect(plain.clickedButtonAction).toBeUndefined();
    const withSnap = new CampaignMessage({
      ...base, clickedButtonAction: 'opt_in',
      consentSnapshot: { promotionName: 'P', purpose: 'consent_request', templateName: 't', templateVersion: 1, language: 'en', bodyTemplate: 'Hi {{1}}', renderedBody: 'Hi Sara', footer: 'f', buttons: [{ position: 0, label: 'Yes', action: 'opt_in', payload: 'promo:x:opt_in:0' }] },
    });
    expect(withSnap.validateSync()).toBeUndefined();
    expect(withSnap.consentSnapshot.buttons[0].payload).toBe('promo:x:opt_in:0');
    expect(CampaignMessage.schema.indexes().some(([k]) => k.phone === 1 && k.createdAt === -1)).toBe(true);
    expect(CampaignMessage.schema.indexes().some(([k, o]) => k.wamid === 1 && o.unique && o.sparse)).toBe(true); // the existing one is still there
  });

  test('ConsentEvent: evidence fields validate, inboundWamid is unique + sparse, the promotion index exists', () => {
    const e = new RealConsentEvent({
      workspaceId: oid, customerId: oid, phone: '1', type: 'consent_given', method: 'whatsapp_button',
      promotionId: oid, promotionName: 'P', messageText: 'm', buttonLabel: 'Yes', buttonPosition: 0, buttonAction: 'opt_in',
      templateName: 't', templateVersion: 1, sourceWamid: 'a', inboundWamid: 'b', tappedAt: new Date(), receivedAt: new Date(), signature: 'valid',
    });
    expect(e.validateSync()).toBeUndefined();
    const idx = RealConsentEvent.schema.indexes();
    expect(idx.some(([k, o]) => k.inboundWamid === 1 && o.unique === true && o.sparse === true)).toBe(true);
    expect(idx.some(([k]) => k.workspaceId === 1 && k.promotionId === 1 && k.type === 1 && k.createdAt === -1)).toBe(true);
    expect(idx.some(([k]) => k.customerId === 1 && k.createdAt === -1)).toBe(true); // existing index kept
  });

  test('ConsentEvent: signature accepts the four verdicts and null, nothing else; an event without evidence has no new keys', () => {
    const base = { workspaceId: oid, customerId: oid, phone: '1', type: 'consent_given', method: 'whatsapp_button' };
    for (const s of ['valid', 'invalid', 'missing', 'unconfigured', null]) expect(new RealConsentEvent({ ...base, signature: s }).validateSync()).toBeUndefined();
    expect(new RealConsentEvent({ ...base, signature: 'maybe' }).validateSync()).toBeDefined();
    const plain = new RealConsentEvent(base).toObject();
    for (const k of ['inboundWamid', 'promotionId', 'messageText', 'signature', 'tappedAt']) expect(Object.keys(plain)).not.toContain(k);
  });

  // After a rollback the previous release must still be able to save every customer (a STOP included): the customer record only
  // ever carries the two values its schema knows. The precise method lives on the ConsentEvent.
  test('Customer: marketingConsentMethod stays exactly the previous release\'s two values', () => {
    const base = { firstname: 'a', lastname: 'b', phone: '1' };
    for (const m of ['whatsapp_button', 'manual_staff_entry']) {
      expect(new RealCustomer({ ...base, marketingConsentMethod: m }).validateSync()).toBeUndefined();
    }
    for (const m of ['whatsapp_start_command', 'carrier_pigeon']) {
      expect(new RealCustomer({ ...base, marketingConsentMethod: m }).validateSync()).toBeDefined();
    }
  });

  test('Customer.phone has a single-field index (the sender lookup of every inbound message and every STOP / START)', () => {
    const keys = RealCustomer.schema.indexes().map(([k]) => Object.keys(k).join(','));
    expect(keys).toContain('phone');
  });
});
