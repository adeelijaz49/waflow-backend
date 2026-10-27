'use strict';
// Security hardening, end to end through the REAL server.js on the throwaway mongod (an axios stub answers every outbound call:
// nothing leaves the machine).
//   * request bodies: workspaceId / _id / isDemo are dropped, "$operator" keys are refused, another customer's records cannot be attached
//   * GET /payment-cancelled acts only for a number that has a cart waiting
//   * a webhook message whose customer cannot be determined (the lookup keeps failing) writes nothing, but a typed STOP is still honoured
//   * every change a super admin makes while "inside" a customer is written to the platform audit trail first
//   * an event that reached the SHARED number for a customer who now has a number of its own is answered from the shared number
// Always a FRESH database per run; nothing is ever deleted.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

process.env.WA_TOKEN_ENCRYPTION_KEY = process.env.WA_TOKEN_ENCRYPTION_KEY || 'cd'.repeat(32); // a throwaway key, used for nothing real
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const axios = require('axios');

const mockStripe = { created: [], seq: 0 };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (args) => { const id = `pi_sec_${++mockStripe.seq}`; mockStripe.created.push({ id, ...args }); return { id, ...args }; },
    retrieve: async (id) => mockStripe.created.find((p) => p.id === id) || {},
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) },
}));
jest.mock('../../../shared/templateApproval', () => ({
  handleTemplateStatusEvent: jest.fn(async () => ({ handled: true })),
  startTemplateApprovalSweeper: jest.fn(),
}));

jest.setTimeout(120000);

const fx = require('./_fixtures');
const app = require('../../../server');
const ops = require('../../../shared/operations');
const whatsappInbound = require('../../../shared/whatsappInbound');
const waTenant = require('../../../utils/waTenant');
const tokenVault = require('../../../shared/onboarding/tokenVault');
const { STOP_REPLY } = require('../../../shared/crossWorkspaceOptOut');
const { carts } = require('../../../utils/state');
const Q = (m) => require(`../../../models/${m}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = [];
let wamidSeq = 0;
function installAdapter() {
  axios.defaults.adapter = async (config) => {
    let body = config.data;
    if (body && typeof body.getBoundary === 'function') body = '<formdata>';
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
    calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body });
    return { data: { messaging_product: 'whatsapp', messages: [{ id: `wamid.SEC_OUT_${++wamidSeq}` }], id: `stub${wamidSeq}` }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}
const outgoing = () => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST');
const messagesTo = (phone) => outgoing().filter((c) => c.body && c.body.to === phone);
const textsTo = (phone) => messagesTo(phone).map((c) => c.body.text && c.body.text.body).filter(Boolean);
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(60); }
}
const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
const PLATFORM_PHONE_ID = () => process.env.WA_PHONE_ID || '1032683093271618'; // what utils/waTenant.js falls back to

// A customer that sends from a WhatsApp number of its own (its own phone id, WABA and a saved token).
async function makeOwnNumberWorkspace() {
  const ws = await fx.makeWorkspace({ arabic: false });
  const id = String(ws.workspaceId);
  const phoneId = `OWN_${fx.uniq()}`;
  await Q('Workspace').updateOne({ _id: ws.workspaceId }, { $set: {
    'whatsapp.phoneId': phoneId, 'whatsapp.wabaId': `WABA_${fx.uniq()}`, 'whatsapp.tokenIsValid': true,
    'whatsapp.tokenEncrypted': tokenVault.encrypt('OWN_TOKEN_VALUE', { workspaceId: id, purpose: 'token' }),
  } });
  waTenant.invalidate(id);
  whatsappInbound.invalidatePhoneId();
  return { ...ws, id, phoneId };
}

let HOME; // the oldest workspace: the platform default
beforeAll(async () => {
  await fx.connect();
  installAdapter();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await Promise.all(['CampaignMessage', 'WhatsAppMessage', 'ConsentEvent', 'Customer', 'Workspace', 'PlatformAuditLog'].map((m) => Q(m).init().catch(() => {})));
  HOME = await Q('Workspace').findOne().sort({ createdAt: 1 }).lean();
  if (!HOME) { HOME = (await fx.makeWorkspace({ arabic: false })).workspace; await sleep(8); }
});
afterAll(async () => { jest.restoreAllMocks(); await fx.disconnect(); });
beforeEach(() => { calls.length = 0; whatsappInbound._resetForTests(); carts.clear(); });

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('a request body cannot reach across customers', () => {
  let A; let B; let bProduct; let bPromotion; let bNode; let bService; let bFlow;
  beforeAll(async () => {
    A = await fx.makeWorkspace({ arabic: false });
    B = await fx.makeWorkspace({ arabic: false });
    bProduct = await Q('Product').create({ workspaceId: B.workspaceId, name: 'B item', category: 'X', basePrice: 5 });
    bService = await Q('Service').create({ workspaceId: B.workspaceId, name: 'B service', basePrice: 9 });
    bFlow = await ops.createFlow({ workspaceId: B.workspaceId, name: `B flow ${fx.uniq()}`, triggerType: 'inactive_customer' });
    bPromotion = await ops.createPromotion({ workspaceId: B.workspaceId, name: `B promo ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    bNode = await ops.createMessageNode({
      ownerType: 'promotion', ownerId: bPromotion._id, isEntryNode: true, bodyText: 'Hi {{1}}',
      buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }], workspaceId: B.workspaceId,
    });
  });
  const promoBody = (over = {}) => ({ name: `A promo ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide', ...over });

  test('workspaceId, _id and isDemo in a body are ignored: the record is created in the session\'s own workspace, and is never a demo record', async () => {
    const wantedId = String(new mongoose.Types.ObjectId());
    const created = await request(app).post('/api/customers').set(A.auth).send({
      firstname: 'Eve', lastname: 'Mine', phone: fx.nextPhone(), workspaceId: String(B.workspaceId), isDemo: true, _id: wantedId,
    });
    expect(created.status).toBe(201);
    const row = await Q('Customer').findById(created.body._id).lean();
    expect(String(row.workspaceId)).toBe(String(A.workspaceId));
    expect(row.isDemo).toBeFalsy();
    expect(String(row._id)).not.toBe(wantedId);

    // products are handed to the database as the body arrives: the same guarantee has to hold there
    const product = await request(app).post('/api/products').set(A.auth).send({ name: 'Mine', category: 'C', basePrice: 9, workspaceId: String(B.workspaceId), _id: wantedId });
    expect(product.status).toBe(201);
    const prow = await Q('Product').findById(product.body._id).lean();
    expect(String(prow.workspaceId)).toBe(String(A.workspaceId));
    expect(String(prow._id)).not.toBe(wantedId);

    const promo = await request(app).post('/api/promotions').set(A.auth).send(promoBody({ isDemo: true, workspaceId: String(B.workspaceId) }));
    expect(promo.status).toBe(201);
    const promoRow = await Q('Promotion').findById(promo.body._id).lean();
    expect(String(promoRow.workspaceId)).toBe(String(A.workspaceId));
    expect(promoRow.isDemo).toBeFalsy();
  });

  test('an update cannot move a record to another customer or turn it into a demo record', async () => {
    const mine = await fx.makeCustomer(A.workspaceId);
    const upd = await request(app).put(`/api/customers/${mine._id}`).set(A.auth).send({ firstname: 'Renamed', workspaceId: String(B.workspaceId), isDemo: true });
    expect(upd.status).toBe(200);
    const row = await Q('Customer').findById(mine._id).lean();
    expect(row.firstname).toBe('Renamed');
    expect(String(row.workspaceId)).toBe(String(A.workspaceId));
    expect(row.isDemo).toBeFalsy();

    const product = await Q('Product').create({ workspaceId: A.workspaceId, name: 'Orig', category: 'C', basePrice: 1 });
    const moved = await request(app).put(`/api/products/${product._id}`).set(A.auth).send({ name: 'Orig2', workspaceId: String(B.workspaceId) });
    expect(moved.status).toBe(200);
    const prow = await Q('Product').findById(product._id).lean();
    expect(prow.name).toBe('Orig2');
    expect(String(prow.workspaceId)).toBe(String(A.workspaceId));
  });

  test('a body with a "$operator" key (an update that would bypass every field rule) is refused with 400 on every data route, and changes nothing', async () => {
    const mine = await fx.makeCustomer(A.workspaceId, { firstname: 'Stays' });
    const product = await Q('Product').create({ workspaceId: A.workspaceId, name: 'Stays', category: 'C', basePrice: 1 });
    const promo = await ops.createPromotion({ workspaceId: A.workspaceId, name: `Stays ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    const evil = { $set: { workspaceId: String(B.workspaceId), name: 'Hijacked' }, name: 'x' };
    for (const [method, url] of [
      ['post', '/api/customers'], ['put', `/api/customers/${mine._id}`], ['post', '/api/products'], ['put', `/api/products/${product._id}`],
      ['post', '/api/promotions'], ['put', `/api/promotions/${promo._id}`], ['post', '/api/flows'], ['post', '/api/message-nodes'], ['post', '/api/services'],
    ]) {
      const res = await request(app)[method](url).set(A.auth).send(evil);
      expect({ url, status: res.status, error: res.body && res.body.error }).toEqual({ url, status: 400, error: 'Invalid field name.' });
    }
    expect((await Q('Customer').findById(mine._id).lean()).firstname).toBe('Stays');
    expect((await Q('Product').findById(product._id).lean()).name).toBe('Stays');
    expect((await Q('Promotion').findById(promo._id).lean()).name).toMatch(/^Stays /);
    // reading is not affected, and neither is a write whose "$" is only inside a value
    expect((await request(app).get('/api/products').set(A.auth)).status).toBe(200);
    const fine = await request(app).post('/api/products').set(A.auth).send({ name: 'costs $5 {$x}', category: 'C', basePrice: 5 });
    expect(fine.status).toBe(201);
  });

  test('a promotion cannot use another customer\'s product or entry message; the refusal does not say whether the id exists elsewhere', async () => {
    let res = await request(app).post('/api/promotions').set(A.auth).send(promoBody({ products: [String(bProduct._id)] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
    expect(JSON.stringify(res.body)).not.toContain('B item');

    const own = await request(app).post('/api/promotions').set(A.auth).send(promoBody());
    expect(own.status).toBe(201);
    res = await request(app).put(`/api/promotions/${own.body._id}`).set(A.auth).send({ entryNodeId: String(bNode._id) });
    expect(res.status).toBe(400);
    expect((await Q('Promotion').findById(own.body._id).lean()).entryNodeId).toBeUndefined();
    res = await request(app).put(`/api/promotions/${own.body._id}`).set(A.auth).send({ products: ['not-an-id'] });
    expect(res.status).toBe(400);
  });

  test('a flow cannot point at another customer\'s promotion or earlier flow', async () => {
    const flowBody = (over) => ({ name: `F ${fx.uniq()}`, triggerType: 'points_threshold', pointsThreshold: 100, ...over });
    let res = await request(app).post('/api/flows').set(A.auth).send(flowBody({ promotionId: String(bPromotion._id) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
    const bFlow = await ops.createFlow({ workspaceId: B.workspaceId, name: `BF ${fx.uniq()}`, triggerType: 'inactive_customer' });
    const aPromo = await ops.createPromotion({ workspaceId: A.workspaceId, name: `AP ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    res = await request(app).post('/api/flows').set(A.auth).send(flowBody({ promotionId: String(aPromo._id), requiresPriorFlowId: String(bFlow._id) }));
    expect(res.status).toBe(400);
    expect(await Q('Flow').countDocuments({ workspaceId: A.workspaceId, requiresPriorFlowId: bFlow._id })).toBe(0);
    res = await request(app).post('/api/flows').set(A.auth).send(flowBody({ promotionId: String(aPromo._id) }));
    expect(res.status).toBe(201); // the same request with its own promotion is fine
  });

  test('the same holds later, when a promotion or a flow is UPDATED, and for the services of a promotion (nothing of another customer can be linked in)', async () => {
    // a promotion's services, on create and on update (its products on update: create is covered above)
    let res = await request(app).post('/api/promotions').set(A.auth).send(promoBody({ scope: 'services', services: [String(bService._id)] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
    expect(JSON.stringify(res.body)).not.toContain('B service');
    const own = await request(app).post('/api/promotions').set(A.auth).send(promoBody());
    expect(own.status).toBe(201);
    for (const body of [{ products: [String(bProduct._id)] }, { services: [String(bService._id)] }]) {
      res = await request(app).put(`/api/promotions/${own.body._id}`).set(A.auth).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
    }
    const storedPromo = await Q('Promotion').findById(own.body._id).lean();
    expect(storedPromo.products || []).toEqual([]);
    expect(storedPromo.services || []).toEqual([]);

    // a flow's promotion, earlier flow and message
    const aPromo = await ops.createPromotion({ workspaceId: A.workspaceId, name: `AP3 ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    const aFlow = await ops.createFlow({ workspaceId: A.workspaceId, name: `AF ${fx.uniq()}`, triggerType: 'inactive_customer' });
    for (const body of [{ promotionId: String(bPromotion._id) }, { requiresPriorFlowId: String(bFlow._id) }, { entryNodeId: String(bNode._id) }]) {
      res = await request(app).put(`/api/flows/${aFlow._id}`).set(A.auth).send(body);
      expect({ body, status: res.status }).toEqual({ body, status: 400 });
      expect(res.body.error).toMatch(/not found/i);
    }
    const storedFlow = await Q('Flow').findById(aFlow._id).lean();
    expect(storedFlow.promotionId).toBeUndefined();
    expect(storedFlow.requiresPriorFlowId).toBeUndefined();
    expect(storedFlow.entryNodeId).toBeUndefined();
    // the same updates with the customer's own records are fine
    res = await request(app).put(`/api/flows/${aFlow._id}`).set(A.auth).send({ promotionId: String(aPromo._id) });
    expect(res.status).toBe(200);
    expect(String((await Q('Flow').findById(aFlow._id).lean()).promotionId)).toBe(String(aPromo._id));
  });

  test('a message cannot be attached to another customer\'s promotion, and a follow-up button cannot point at another customer\'s message', async () => {
    let res = await request(app).post('/api/message-nodes').set(A.auth).send({ ownerType: 'promotion', ownerId: String(bPromotion._id), isEntryNode: true, bodyText: 'Hi' });
    expect(res.status).toBe(400);
    expect(await Q('MessageNode').countDocuments({ ownerId: bPromotion._id, workspaceId: A.workspaceId })).toBe(0);

    const aPromo = await ops.createPromotion({ workspaceId: A.workspaceId, name: `AP2 ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    res = await request(app).post('/api/message-nodes').set(A.auth).send({
      ownerType: 'promotion', ownerId: String(aPromo._id), isEntryNode: true, bodyText: 'Hi',
      buttons: [{ position: 0, label: 'More', nextAction: { type: 'send_message', targetNodeId: String(bNode._id) } }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
    const ok = await request(app).post('/api/message-nodes').set(A.auth).send({ ownerType: 'promotion', ownerId: String(aPromo._id), isEntryNode: true, bodyText: 'Hi', buttons: [] });
    expect(ok.status).toBe(201);
    res = await request(app).put(`/api/message-nodes/${ok.body._id}`).set(A.auth).send({ buttons: [{ position: 0, label: 'More', nextAction: { type: 'send_message', targetNodeId: String(bNode._id) } }] });
    expect(res.status).toBe(400);
    // deleting a message never reaches into another customer's tree either: A cannot delete B's message
    const del = await request(app).delete(`/api/message-nodes/${bNode._id}`).set(A.auth);
    expect(del.status).not.toBe(200); // (the route answers its usual 500 'not found': the point is that B's message is untouched)
    expect(await Q('MessageNode').countDocuments({ _id: bNode._id })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('GET /payment-cancelled (a public link: anyone can put any number in it)', () => {
  test('it acts only for a number that has a cart waiting; any other number gets the page and NO WhatsApp message', async () => {
    const phone = fx.nextPhone();
    carts.set(phone, [{ name: 'Hat', priceAud: 10, pointsCost: 0, description: '' }]);
    let res = await request(app).get('/payment-cancelled').query({ phone });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Payment cancelled/);
    expect(carts.has(phone)).toBe(false);
    const sent = await waitFor(() => textsTo(phone)[0]);
    expect(sent).toMatch(/^No worries! Your cart has been cleared/);

    // a second click on the same link, a stranger's number, a made-up one and no number at all: the page, and nothing is sent
    calls.length = 0;
    for (const query of [{ phone }, { phone: fx.nextPhone() }, { phone: '15550000000' }, {}]) {
      res = await request(app).get('/payment-cancelled').query(query);
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/Payment cancelled/);
    }
    await sleep(300);
    expect(outgoing()).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('a webhook message whose customer cannot be determined (the lookup keeps failing)', () => {
  let B; let spy;
  const messagesValue = (messages) => ({ messaging_product: 'whatsapp', contacts: messages.map((m) => ({ profile: { name: 'Contact' }, wa_id: m.from })), messages });
  const payload = (value) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222220', changes: [{ field: 'messages', value }] }] });
  const text = (from, body) => ({ from, id: wid(), timestamp: '1760000000', type: 'text', text: { body } });
  const post = (value) => request(app).post('/webhook').send(payload(value));

  beforeAll(async () => { B = await fx.makeWorkspace({ arabic: false }); });
  beforeEach(() => {
    // exactly what the resolver answers once its retries are used up
    spy = jest.spyOn(whatsappInbound, 'resolveEventWorkspace').mockImplementation(async () => ({ workspaceId: HOME._id, rule: 'R3_error' }));
    console.error.mockClear();
  });
  afterEach(() => { spy.mockRestore(); });

  test('nothing is filed under the oldest workspace: no customer, no inbox entry, no reply; it is logged loudly', async () => {
    const stranger = fx.nextPhone();
    const inboxBefore = await Q('WhatsAppMessage').countDocuments({});
    const customersBefore = await Q('Customer').countDocuments({ workspaceId: HOME._id });
    const res = await post(messagesValue([text(stranger, 'hello, I would like to order a hat')]));
    expect(res.status).toBe(200);
    await waitFor(() => console.error.mock.calls.some((c) => /NOT processed: its customer could not be determined/.test(String(c[0]))));
    await sleep(300);
    expect(console.error.mock.calls.some((c) => /NOT processed: its customer could not be determined/.test(String(c[0])))).toBe(true);
    expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
    expect(await Q('Customer').countDocuments({ workspaceId: HOME._id })).toBe(customersBefore);
    expect(await Q('WhatsAppMessage').countDocuments({})).toBe(inboxBefore);
    expect(outgoing()).toHaveLength(0);
    // the number is masked in the log
    expect(console.error.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(stranger);
  });

  test('a typed STOP is still honoured: the number is opted out wherever it is a customer, and answered once', async () => {
    const phone = fx.nextPhone();
    const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
    const res = await post(messagesValue([text(phone, 'STOP')]));
    expect(res.status).toBe(200);
    expect(await waitFor(async () => (await Q('Customer').findById(customer._id).lean()).optedOut === true)).toBeTruthy();
    expect(await waitFor(() => textsTo(phone).length === 1)).toBeTruthy();
    expect(textsTo(phone)).toEqual([STOP_REPLY]);
    // ... and ONLY that: the message was not processed as an ordinary one under the oldest workspace (no inbox entry, no customer made
    // there), and the record says it was applied without knowing whose message it was
    expect(await Q('WhatsAppMessage').countDocuments({ phone })).toBe(0);
    expect(await Q('Customer').countDocuments({ phone, workspaceId: HOME._id })).toBe(0);
    const event = await Q('ConsentEvent').findOne({ customerId: customer._id, type: 'consent_withdrawn' }).lean();
    expect(event).toMatchObject({ method: 'whatsapp_stop_command' });
    expect(event.source).toMatch(/could not be identified at the time/);
  });

  test('UNSUBSCRIBE (any capitals, spaces around it) and a tapped Opt Out button - the old optout_ payload and a consent request\'s - are honoured the same way', async () => {
    const triggers = [
      (phone) => text(phone, '  unsubscribe '),
      (phone) => ({ from: phone, id: wid(), timestamp: '1760000000', type: 'button', button: { payload: 'optout_65f000000000000000000001', text: 'Opt Out' } }),
      (phone) => ({ from: phone, id: wid(), timestamp: '1760000000', type: 'button', button: { payload: 'promo:65f000000000000000000002:opt_out:1', text: 'No thanks' } }),
      (phone) => ({ from: phone, id: wid(), timestamp: '1760000000', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'optout_65f000000000000000000003', title: 'Opt Out' } } }),
    ];
    for (const trigger of triggers) {
      const phone = fx.nextPhone();
      const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
      const res = await post(messagesValue([trigger(phone)]));
      expect(res.status).toBe(200);
      expect(await waitFor(async () => (await Q('Customer').findById(customer._id).lean()).optedOut === true)).toBeTruthy();
      expect(await waitFor(() => textsTo(phone).length === 1)).toBeTruthy();
      expect(textsTo(phone)).toEqual([STOP_REPLY]);
      expect(await Q('WhatsAppMessage').countDocuments({ phone })).toBe(0);
    }
  });

  test('what only LOOKS like a stop request (a sentence with the word in it, START, a tap on an ordinary button) is never treated as one', async () => {
    const phone = fx.nextPhone();
    const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
    for (const message of [
      text(phone, 'please stop sending me photos'), text(phone, 'STOP IT'), text(phone, 'stopp'),
      { from: phone, id: wid(), timestamp: '1760000000', type: 'button', button: { payload: 'promo_65f000000000000000000001', text: 'Shop' } },
      { from: phone, id: wid(), timestamp: '1760000000', type: 'button', button: { payload: 'promo:65f000000000000000000002:opt_in:0', text: 'Yes' } },
    ]) {
      expect((await post(messagesValue([message]))).status).toBe(200);
    }
    await sleep(700);
    expect((await Q('Customer').findById(customer._id).lean()).optedOut).not.toBe(true);
    expect(outgoing()).toHaveLength(0);
  });

  test('a stop that arrived on a number the reply cannot leave from is applied silently; one from a number nobody is a customer of is not confirmed at all', async () => {
    const phone = fx.nextPhone();
    const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
    const elsewhere = { ...messagesValue([text(phone, 'STOP')]), metadata: { display_phone_number: '15559999999', phone_number_id: 'SOME_OTHER_NUMBER_ID' } };
    expect((await post(elsewhere)).status).toBe(200);
    expect(await waitFor(async () => (await Q('Customer').findById(customer._id).lean()).optedOut === true)).toBeTruthy(); // opted out ...
    await sleep(500);
    expect(textsTo(phone)).toEqual([]); // ... without a reply: it would have left from the wrong number

    calls.length = 0;
    const stranger = fx.nextPhone(); // nobody's customer: nothing was opted out, so there is nothing to confirm
    expect((await post(messagesValue([text(stranger, 'STOP')]))).status).toBe(200);
    await sleep(700);
    expect(textsTo(stranger)).toEqual([]);
    expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
  });

  test('a customer that sends from a number of its OWN is reached too (nobody can tell which number the stop was meant for)', async () => {
    const own = await makeOwnNumberWorkspace();
    const phone = fx.nextPhone();
    const onShared = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
    const onOwn = await fx.makeCustomer(own.workspaceId, { phone, marketingConsent: true });
    expect((await post(messagesValue([text(phone, 'STOP')]))).status).toBe(200);
    expect(await waitFor(async () => (await Q('Customer').findById(onShared._id).lean()).optedOut === true && (await Q('Customer').findById(onOwn._id).lean()).optedOut === true)).toBeTruthy();
    expect(await waitFor(() => textsTo(phone).length === 1)).toBeTruthy();
    expect(textsTo(phone)).toEqual([STOP_REPLY]);
  });

  test('when the OLDEST workspace itself cannot be looked up, nothing in the request is attributed (nothing is written) but a typed STOP is still honoured', async () => {
    spy.mockRestore(); // the real resolver this time: the failure is in the lookup that starts every request
    const phone = fx.nextPhone();
    const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: true });
    const stranger = fx.nextPhone();
    const inboxBefore = await Q('WhatsAppMessage').countDocuments({});
    const original = Q('Workspace').findOne.bind(Q('Workspace'));
    const lookup = jest.spyOn(Q('Workspace'), 'findOne').mockImplementation((...args) => (args.length === 0
      ? { sort: () => Promise.reject(new Error('429 request rate is large')) } // exactly the oldest-workspace query
      : original(...args)));
    try {
      const res = await post(messagesValue([text(stranger, 'hello, are you open today?'), text(phone, 'STOP')]));
      expect(res.status).toBe(200);
      expect(await waitFor(async () => (await Q('Customer').findById(customer._id).lean()).optedOut === true)).toBeTruthy();
      expect(await waitFor(() => textsTo(phone).length === 1)).toBeTruthy();
      await sleep(300);
      const errors = console.error.mock.calls.map((c) => String(c[0])).join('\n');
      expect(errors).toMatch(/the oldest workspace could not be looked up/);
      expect(errors).toMatch(/NOT processed: its customer could not be determined/);
      expect(errors).not.toContain(stranger);
      expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
      expect(await Q('WhatsAppMessage').countDocuments({})).toBe(inboxBefore);
      expect(textsTo(stranger)).toEqual([]);
    } finally { lookup.mockRestore(); }
  });

  describe('delivery updates and template news', () => {
    const templateApproval = require('../../../shared/templateApproval'); // mocked at the top of this file
    const templateChange = (n) => ({ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_name: `tpl_${n}`, message_template_id: `${n}` } });
    const templatePayload = (n) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222220', changes: Array.from({ length: n }, (_, i) => templateChange(i)) }] });
    async function sentRows(n) {
      const customer = await fx.makeCustomer(HOME._id);
      return Promise.all(Array.from({ length: n }, () => Q('CampaignMessage').create({
        workspaceId: HOME._id, kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: wid(), messageType: 'template', status: 'sent', sentAt: new Date(),
      })));
    }
    const deliveredUpdate = (cm) => ({ id: cm.wamid, status: 'delivered', timestamp: '1760000000', recipient_id: cm.phone });
    const deliveredCount = (rows) => Q('CampaignMessage').countDocuments({ _id: { $in: rows.map((r) => r._id) }, status: 'delivered' });

    beforeEach(() => { templateApproval.handleTemplateStatusEvent.mockClear(); console.warn.mockClear(); });

    test('delivery updates of a request that is not signed are applied well beyond 25 (a promotion to a few hundred customers batches that many)', async () => {
      const rows = await sentRows(40);
      const res = await post({ messaging_product: 'whatsapp', statuses: rows.map(deliveredUpdate) }); // (post() wraps the value in the webhook envelope)
      expect(res.status).toBe(200);
      expect(await waitFor(async () => (await deliveredCount(rows)) === 40, 30000)).toBeTruthy();
      expect(console.warn.mock.calls.some((c) => /were NOT processed/.test(String(c[0])))).toBe(false);
    });

    test('a template change of a request that is not signed costs five events: only five of eight are looked into; a signed request has them all looked into', async () => {
      const savedSecret = process.env.WA_APP_SECRET;
      try {
        delete process.env.WA_APP_SECRET;
        expect((await request(app).post('/webhook').send(templatePayload(8))).status).toBe(200);
        expect(await waitFor(() => templateApproval.handleTemplateStatusEvent.mock.calls.length >= 5)).toBeTruthy();
        await sleep(400);
        expect(templateApproval.handleTemplateStatusEvent).toHaveBeenCalledTimes(5);
        expect(console.warn.mock.calls.some((c) => /3 event\(s\) of a request without a valid signature were NOT processed/.test(String(c[0])))).toBe(true);

        process.env.WA_APP_SECRET = 'itest-app-secret';
        templateApproval.handleTemplateStatusEvent.mockClear();
        const raw = JSON.stringify(templatePayload(8));
        const signature = `sha256=${crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex')}`;
        expect((await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(raw)).status).toBe(200);
        expect(await waitFor(() => templateApproval.handleTemplateStatusEvent.mock.calls.length >= 8)).toBeTruthy();
        expect(templateApproval.handleTemplateStatusEvent).toHaveBeenCalledTimes(8);
      } finally { if (savedSecret === undefined) delete process.env.WA_APP_SECRET; else process.env.WA_APP_SECRET = savedSecret; }
    });

    test('when the OLDEST workspace cannot be looked up, delivery updates that name their message and template news are still handled (they do not need it); an update nothing claims is simply ignored', async () => {
      spy.mockRestore(); // the real resolvers
      const rows = await sentRows(3);
      const original = Q('Workspace').findOne.bind(Q('Workspace'));
      const lookup = jest.spyOn(Q('Workspace'), 'findOne').mockImplementation((...args) => (args.length === 0
        ? { sort: () => Promise.reject(new Error('429 request rate is large')) } // exactly the oldest-workspace query
        : original(...args)));
      try {
        const unknown = { id: wid(), status: 'delivered', timestamp: '1760000000', recipient_id: fx.nextPhone() };
        const res = await request(app).post('/webhook').send({
          object: 'whatsapp_business_account',
          entry: [{ id: '222222222222220', changes: [
            { field: 'messages', value: { messaging_product: 'whatsapp', statuses: [...rows.map(deliveredUpdate), unknown] } },
            templateChange(1),
          ] }],
        });
        expect(res.status).toBe(200);
        expect(await waitFor(async () => (await deliveredCount(rows)) === 3)).toBeTruthy(); // attributed by the message id they name
        expect(await waitFor(() => templateApproval.handleTemplateStatusEvent.mock.calls.length >= 1)).toBeTruthy();
        expect(await waitFor(() => console.error.mock.calls.some((c) => /the oldest workspace could not be looked up/.test(String(c[0]))))).toBeTruthy();
        await sleep(300);
        // nobody claims the unknown id: it changes nothing and breaks nothing (no row was made for it; the three that name their message are applied)
        expect(await Q('CampaignMessage').countDocuments({ wamid: unknown.id })).toBe(0);
        expect(console.error.mock.calls.some((c) => /handleStatusCallbacks error/.test(String(c[0])))).toBe(false);
      } finally { lookup.mockRestore(); }
    });
  });

  test('a request Meta did not sign is handled up to 25 events and the rest is logged and left; a request that IS signed is handled whole', async () => {
    const savedSecret = process.env.WA_APP_SECRET;
    const many = (n) => Array.from({ length: n }, () => text(fx.nextPhone(), 'hello'));
    const notProcessed = () => console.error.mock.calls.filter((c) => /NOT processed: its customer could not be determined/.test(String(c[0]))).length;
    try {
      // not signed at all (no secret configured: the signature cannot be checked): capped
      delete process.env.WA_APP_SECRET;
      console.error.mockClear(); console.warn.mockClear();
      expect((await post(messagesValue(many(30)))).status).toBe(200);
      await waitFor(() => notProcessed() >= 25);
      await sleep(400);
      expect(notProcessed()).toBe(25);
      expect(console.warn.mock.calls.some((c) => /5 event\(s\) of a request without a valid signature were NOT processed \(at most 25 messages or template changes and 500 delivery updates per such request\)/.test(String(c[0])))).toBe(true);

      // signed by Meta: every event is handled, however many it batches
      process.env.WA_APP_SECRET = 'itest-app-secret';
      const raw = JSON.stringify(payload(messagesValue(many(30))));
      const signature = `sha256=${crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex')}`;
      console.error.mockClear(); console.warn.mockClear();
      const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(raw);
      expect(res.status).toBe(200);
      await waitFor(() => notProcessed() >= 30);
      await sleep(400);
      expect(notProcessed()).toBe(30);
      expect(console.warn.mock.calls.some((c) => /were NOT processed \(at most/.test(String(c[0])))).toBe(false);
    } finally { if (savedSecret === undefined) delete process.env.WA_APP_SECRET; else process.env.WA_APP_SECRET = savedSecret; }
  });

  test('a typed START is NOT applied (a fresh opt-in needs to know which business it is for), and nothing is answered', async () => {
    const phone = fx.nextPhone();
    const customer = await fx.makeCustomer(B.workspaceId, { phone, marketingConsent: false, optedOut: true });
    const res = await post(messagesValue([text(phone, 'START')]));
    expect(res.status).toBe(200);
    await sleep(900);
    expect((await Q('Customer').findById(customer._id).lean()).optedOut).toBe(true);
    expect(outgoing()).toHaveLength(0);
  });

  test('delivery updates of an unattributed change are applied to NO workspace (they are not guessed to be the oldest one\'s)', async () => {
    const customer = await fx.makeCustomer(HOME._id);
    const cm = await Q('CampaignMessage').create({ workspaceId: HOME._id, kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: wid(), messageType: 'template', status: 'sent', sentAt: new Date() });
    const statusSpy = jest.spyOn(whatsappInbound, 'resolveStatusGroups').mockImplementation(async ({ statuses }) => [{ workspaceId: HOME._id, rule: 'R3_error', statuses }]);
    try {
      const res = await request(app).post('/webhook').send(payload({ messaging_product: 'whatsapp', statuses: [{ id: cm.wamid, status: 'delivered', timestamp: '1760000000', recipient_id: customer.phone }] }));
      expect(res.status).toBe(200);
      await waitFor(() => console.error.mock.calls.some((c) => /delivery update\(s\) NOT applied/.test(String(c[0]))));
      expect((await Q('CampaignMessage').findById(cm._id).lean()).status).toBe('sent');
    } finally { statusSpy.mockRestore(); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('an opt-in button of the older kinds honours CONSENT_REQUIRE_SIGNATURE like the newer ones', () => {
  const saved = { secret: process.env.WA_APP_SECRET, required: process.env.CONSENT_REQUIRE_SIGNATURE };
  afterEach(() => {
    for (const [name, value] of [['WA_APP_SECRET', saved.secret], ['CONSENT_REQUIRE_SIGNATURE', saved.required]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });
  const body = (message) => ({ object: 'whatsapp_business_account', entry: [{ id: '222222222222223', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', contacts: [{ profile: { name: 'Contact' }, wa_id: message.from }], messages: [message],
  } }] }] });
  const stamp = () => String(Math.floor(Date.now() / 1000));
  const bulkTemplateTap = (customer) => ({ from: customer.phone, id: wid(), timestamp: stamp(), type: 'button', button: { payload: `consent_yes_${customer._id}`, text: 'Yes' } });
  const confirmationTap = (customer) => ({ from: customer.phone, id: wid(), timestamp: stamp(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: `consent_yes_${customer._id}`, title: 'Yes' } } });
  const signedPost = (payload) => {
    const raw = JSON.stringify(payload);
    const signature = `sha256=${crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex')}`;
    return request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', signature).send(raw);
  };
  const consentOf = async (customer) => (await Q('Customer').findById(customer._id).lean()).marketingConsent === true;

  for (const [label, tapOf] of [['the bulk consent-request button', bulkTemplateTap], ['the order / booking confirmation button', confirmationTap]]) {
    test(`${label}: with CONSENT_REQUIRE_SIGNATURE=on an unsigned request records nothing and answers nothing; a signed one, and the default setting, opt the customer in`, async () => {
      // the setting is on and the request carries no valid signature (no app secret configured): the tap is ignored
      const ignored = await fx.makeCustomer(HOME._id, { marketingConsent: false });
      process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
      delete process.env.WA_APP_SECRET;
      console.warn.mockClear();
      expect((await request(app).post('/webhook').send(body(tapOf(ignored)))).status).toBe(200);
      await waitFor(() => console.warn.mock.calls.some((c) => /an opt-in tap was ignored: CONSENT_REQUIRE_SIGNATURE is on/.test(String(c[0]))));
      await sleep(300);
      expect(await consentOf(ignored)).toBe(false);
      expect(await Q('ConsentEvent').countDocuments({ customerId: ignored._id })).toBe(0);
      expect(textsTo(ignored.phone)).toEqual([]);

      // the same setting with a request Meta signed: it counts
      const signed = await fx.makeCustomer(HOME._id, { marketingConsent: false });
      process.env.WA_APP_SECRET = 'itest-app-secret';
      expect((await signedPost(body(tapOf(signed)))).status).toBe(200);
      expect(await waitFor(() => consentOf(signed))).toBeTruthy();
      expect(await waitFor(() => textsTo(signed.phone).length === 1)).toBeTruthy();

      // the setting off (the default): as it always was, signed or not
      delete process.env.CONSENT_REQUIRE_SIGNATURE;
      delete process.env.WA_APP_SECRET;
      const plain = await fx.makeCustomer(HOME._id, { marketingConsent: false });
      expect((await request(app).post('/webhook').send(body(tapOf(plain)))).status).toBe(200);
      expect(await waitFor(() => consentOf(plain))).toBeTruthy();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('what WaFlow staff change inside a customer is written to the platform audit trail first', () => {
  let staff; let customer;
  const savedContacts = process.env.SUPER_ADMIN_CONTACTS;
  beforeAll(async () => {
    staff = await fx.makeWorkspace({ arabic: false });
    customer = await fx.makeWorkspace({ arabic: false });
  });
  beforeEach(() => { process.env.SUPER_ADMIN_CONTACTS = staff.user.email; });
  afterEach(() => { if (savedContacts === undefined) delete process.env.SUPER_ADMIN_CONTACTS; else process.env.SUPER_ADMIN_CONTACTS = savedContacts; });
  const rows = (action) => Q('PlatformAuditLog').find({ workspaceId: customer.workspaceId, action }).sort({ _id: 1 }).lean();
  const enter = async () => {
    const entered = await request(app).post(`/api/platform/tenants/${customer.workspaceId}/enter`).set(staff.auth);
    expect(entered.status).toBe(200);
    return { Authorization: `Bearer ${entered.body.token}` };
  };

  test('a change is recorded (method and path, never the body) and made; reading is not recorded; leaving the customer logs only its own "exit"', async () => {
    const act = await enter();
    const writesBefore = (await rows('act_as_write')).length;
    expect((await request(app).get('/api/products').set(act)).status).toBe(200);
    expect(await rows('act_as_write')).toHaveLength(writesBefore);

    const created = await request(app).post('/api/products').set(act).set('X-Forwarded-For', '203.0.113.9, 198.51.100.4').send({ name: 'Added by staff - secret wording', category: 'C', basePrice: 3 });
    expect(created.status).toBe(201);
    expect(String((await Q('Product').findById(created.body._id).lean()).workspaceId)).toBe(String(customer.workspaceId));
    const written = await rows('act_as_write');
    expect(written).toHaveLength(writesBefore + 1);
    const row = written[written.length - 1];
    expect(row.detail).toEqual({ method: 'POST', path: '/api/products' });
    expect(row.forwardedFor).toBe('203.0.113.9, 198.51.100.4'); // the address it really came from (the server itself only sees Azure's front end)
    expect(String(row.actorUserId)).toBe(String(staff.user._id));
    expect(row.actorLabel).toMatch(/\*\*\*/);
    expect(JSON.stringify(row)).not.toContain('secret wording');
    expect(JSON.stringify(row)).not.toContain(staff.user.email);

    const out = await request(app).post('/api/platform/exit').set(act);
    expect(out.status).toBe(200);
    expect(await rows('act_as_write')).toHaveLength(writesBefore + 1);
    expect((await rows('exit')).length).toBeGreaterThanOrEqual(1);
  });

  test('when the row cannot be written the change is refused (503) and NOT made', async () => {
    const act = await enter();
    const productsBefore = await Q('Product').countDocuments({ workspaceId: customer.workspaceId });
    const spy = jest.spyOn(Q('PlatformAuditLog'), 'create').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await request(app).post('/api/products').set(act).send({ name: 'Never made', category: 'C', basePrice: 3 });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/audit log/);
    } finally { spy.mockRestore(); }
    expect(await Q('Product').countDocuments({ workspaceId: customer.workspaceId })).toBe(productsBefore);
  });

  test('an ordinary session of the customer\'s own owner writes nothing to the platform trail', async () => {
    const before = await Q('PlatformAuditLog').countDocuments({});
    const res = await request(app).post('/api/products').set(customer.auth).send({ name: 'Own product', category: 'C', basePrice: 2 });
    expect(res.status).toBe(201);
    expect(await Q('PlatformAuditLog').countDocuments({})).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('an event that reached the SHARED number is answered from the shared number, one on the customer\'s own number from its own', () => {
  async function ownNumberWorkspace() {
    const ws = await fx.makeWorkspace({ arabic: false });
    const id = String(ws.workspaceId);
    const phoneId = `OWN_${fx.uniq()}`;
    await Q('Workspace').updateOne({ _id: ws.workspaceId }, { $set: {
      'whatsapp.phoneId': phoneId, 'whatsapp.wabaId': `WABA_${fx.uniq()}`, 'whatsapp.tokenIsValid': true,
      'whatsapp.tokenEncrypted': tokenVault.encrypt('OWN_TOKEN_VALUE', { workspaceId: id, purpose: 'token' }),
    } });
    waTenant.invalidate(id);
    whatsappInbound.invalidatePhoneId();
    return { ...ws, id, phoneId };
  }
  async function askedToOptIn(ws) {
    const customer = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    const promotion = await ops.createPromotion({
      workspaceId: ws.workspaceId, name: `Opt in ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide',
      purpose: 'consent_request', campaignType: 'consent_request',
    });
    const cm = await Q('CampaignMessage').create({
      workspaceId: ws.workspaceId, kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: wid(), messageType: 'template',
      status: 'sent', sentAt: new Date(), promotion: promotion._id,
    });
    return { customer, promotion, cm };
  }
  const tap = ({ customer, promotion, cm }, { phoneId } = {}) => request(app).post('/webhook').send({
    object: 'whatsapp_business_account',
    entry: [{ id: '222222222222221', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      ...(phoneId ? { metadata: { display_phone_number: '15550000000', phone_number_id: phoneId } } : {}),
      contacts: [{ profile: { name: 'Contact' }, wa_id: customer.phone }],
      messages: [{ from: customer.phone, id: wid(), timestamp: String(Math.floor(Date.now() / 1000)), type: 'button', context: { from: '1', id: cm.wamid }, button: { payload: `promo:${promotion._id}:opt_in:0`, text: 'Yes' } }],
    } }] }],
  });

  test('a tap on an OLD message (sent from the shared number) that arrives on the shared number is answered from the shared number, even though the customer has a number of its own now', async () => {
    const own = await ownNumberWorkspace();
    const asked = await askedToOptIn(own);
    const res = await tap(asked); // no phone_number_id of the customer's own: it came in on the shared number
    expect(res.status).toBe(200);
    expect(await waitFor(async () => (await Q('Customer').findById(asked.customer._id).lean()).marketingConsent === true)).toBeTruthy();
    const reply = await waitFor(() => messagesTo(asked.customer.phone)[0]);
    expect(reply).toBeTruthy();
    expect(reply.url).toContain(`/${PLATFORM_PHONE_ID()}/messages`);
    expect(reply.url).not.toContain(own.phoneId);
  });

  test('the same tap arriving on the customer\'s OWN number is answered from the own number', async () => {
    const own = await ownNumberWorkspace();
    const asked = await askedToOptIn(own);
    const res = await tap(asked, { phoneId: own.phoneId });
    expect(res.status).toBe(200);
    expect(await waitFor(async () => (await Q('Customer').findById(asked.customer._id).lean()).marketingConsent === true)).toBeTruthy();
    const reply = await waitFor(() => messagesTo(asked.customer.phone)[0]);
    expect(reply).toBeTruthy();
    expect(reply.url).toContain(`/${own.phoneId}/messages`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('a sweep of the data routes: one customer can neither read nor change another customer\'s records, and its lists never show them', () => {
  const MARK = 'ZZ-OTHER-TENANT-SECRET';
  let A; let B; let theirs;
  beforeAll(async () => {
    A = await fx.makeWorkspace({ arabic: false });
    B = await fx.makeWorkspace({ arabic: false });
    const product = await Q('Product').create({ workspaceId: B.workspaceId, name: `${MARK} product`, category: 'X', basePrice: 5 });
    const customer = await fx.makeCustomer(B.workspaceId, { firstname: MARK, lastname: 'Customer' });
    const service = await Q('Service').create({ workspaceId: B.workspaceId, name: `${MARK} service`, basePrice: 20 });
    const slot = await Q('TimeSlot').create({ workspaceId: B.workspaceId, serviceId: service._id, date: '2030-01-01', startTime: '09:00', endTime: '10:00' });
    const booking = await Q('Booking').create({ workspaceId: B.workspaceId, serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: customer.phone, status: 'confirmed' });
    const order = await Q('Order').create({ workspaceId: B.workspaceId, customer: customer._id, items: [{ productName: `${MARK} item`, category: 'X', quantity: 1, unitPrice: 5 }], subtotal: 5, total: 5, status: 'pending' });
    const promotion = await ops.createPromotion({ workspaceId: B.workspaceId, name: `${MARK} promotion`, scope: 'products', customerType: 'cash', type: 'store_wide' });
    const flow = await ops.createFlow({ workspaceId: B.workspaceId, name: `${MARK} flow`, triggerType: 'inactive_customer' });
    const node = await ops.createMessageNode({ ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: `${MARK} words`, buttons: [], workspaceId: B.workspaceId });
    theirs = { product, customer, service, slot, booking, order, promotion, flow, node };
  });

  test('GET of another customer\'s record by id is never a 200 and never carries its content', async () => {
    const t = theirs;
    const paths = [
      `/api/products/${t.product._id}`, `/api/customers/${t.customer._id}`, `/api/customers/${t.customer._id}/consent-events`, `/api/customers/${t.customer._id}/bookings`,
      `/api/customers/${t.customer._id}/whatsapp-history`, `/api/orders/${t.order._id}`, `/api/services/${t.service._id}`, `/api/services/${t.service._id}/slots`,
      `/api/services/${t.service._id}/bookings`, `/api/promotions/${t.promotion._id}`, `/api/promotions/${t.promotion._id}/report`, `/api/promotions/${t.promotion._id}/preview`,
      `/api/promotions/${t.promotion._id}/recommended-customers`, `/api/promotions/${t.promotion._id}/delivery`, `/api/flows/${t.flow._id}`,
      `/api/flows/${t.flow._id}/enrollments`, `/api/flows/${t.flow._id}/report`, `/api/message-nodes/${t.node._id}`,
    ];
    for (const path of paths) {
      const res = await request(app).get(path).set(A.auth);
      expect({ path, leaked: JSON.stringify(res.body || '').includes(MARK) }).toEqual({ path, leaked: false });
      if (res.status === 200) {
        // a 200 is only acceptable for a list-shaped answer that is EMPTY (the slots, bookings or enrolments of a thing A does not have)
        const lists = Array.isArray(res.body) ? [res.body] : Object.values(res.body || {}).filter(Array.isArray);
        const totals = Array.isArray(res.body) ? [] : ['total', 'count'].map((k) => (res.body || {})[k]).filter((v) => v !== undefined);
        expect({ path, empty: lists.length > 0 && lists.every((l) => l.length === 0) && totals.every((v) => v === 0) }).toEqual({ path, empty: true });
      }
    }
  });

  test('the lists of another customer never show these records, and a search term is text, never a pattern', async () => {
    for (const path of ['/api/products', '/api/customers', '/api/orders', '/api/services', '/api/promotions', '/api/flows', '/api/services/bookings/all', '/api/inbox/conversations']) {
      const res = await request(app).get(path).set(A.auth);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
      expect({ path, leaked: JSON.stringify(res.body).includes(MARK) }).toEqual({ path, leaked: false });
    }
    const search = await request(app).get('/api/customers').query({ search: '.*' }).set(B.auth);
    expect(search.status).toBe(200);
    expect(search.body.customers.map((c) => c.firstname)).not.toContain(MARK); // ".*" is text now: it matches nobody, not everybody
    expect((await request(app).get('/api/customers').query({ search: '(' }).set(B.auth)).status).toBe(200); // a "(" is text too: no more malformed-pattern 500
    expect((await request(app).get('/api/products').query({ search: '[' }).set(B.auth)).status).toBe(200);
    expect((await request(app).get('/api/inbox/conversations').query({ search: '+966(' }).set(B.auth)).status).toBe(200);
    // plain words still find things
    const found = await request(app).get('/api/customers').query({ search: MARK.slice(0, 8) }).set(B.auth);
    expect(found.body.customers.map((c) => c.firstname)).toContain(MARK);
  });

  test('the assistant\'s own searches (ops.listProducts, ops.listCustomers) treat what was typed as text too', async () => {
    await expect(ops.listProducts({ search: '(', workspaceId: B.workspaceId })).resolves.toMatchObject({ total: 0 }); // no malformed-pattern error
    await expect(ops.listProducts({ search: '[', workspaceId: B.workspaceId })).resolves.toMatchObject({ total: 0 });
    const everything = await ops.listProducts({ search: '.*', workspaceId: B.workspaceId });
    expect(everything.products.map((p) => p.name)).toEqual([]); // ".*" matches only a name that contains ".*"
    const found = await ops.listProducts({ search: MARK.slice(0, 8), workspaceId: B.workspaceId });
    expect(found.products.map((p) => p.name)).toEqual([`${MARK} product`]); // plain words still find things
    await expect(ops.listCustomers({ search: '(', workspaceId: B.workspaceId })).resolves.toMatchObject({ total: 0 });
    expect((await ops.listCustomers({ search: '.*', workspaceId: B.workspaceId })).customers.map((c) => c.firstname)).not.toContain(MARK);
    expect((await ops.listCustomers({ search: MARK.slice(0, 8), workspaceId: B.workspaceId })).customers.map((c) => c.firstname)).toContain(MARK);
  });

  test('changing another customer\'s record is refused and leaves it untouched', async () => {
    const t = theirs;
    const snapshot = async () => ({
      product: await Q('Product').findById(t.product._id).lean(), customer: await Q('Customer').findById(t.customer._id).lean(),
      promotion: await Q('Promotion').findById(t.promotion._id).lean(), flow: await Q('Flow').findById(t.flow._id).lean(),
      node: await Q('MessageNode').findById(t.node._id).lean(), order: await Q('Order').findById(t.order._id).lean(), booking: await Q('Booking').findById(t.booking._id).lean(),
      service: await Q('Service').findById(t.service._id).lean(), slot: await Q('TimeSlot').findById(t.slot._id).lean(),
    });
    const before = await snapshot();
    const attempts = [
      ['put', `/api/products/${t.product._id}`, { name: 'taken over' }], ['delete', `/api/products/${t.product._id}`],
      ['put', `/api/customers/${t.customer._id}`, { firstname: 'taken over' }], ['post', `/api/customers/${t.customer._id}/consent`, {}],
      ['put', `/api/promotions/${t.promotion._id}`, { name: 'taken over' }], ['delete', `/api/promotions/${t.promotion._id}`],
      ['post', `/api/promotions/${t.promotion._id}/dismiss-send-request`, {}], ['post', `/api/promotions/${t.promotion._id}/test-send`, { phone: '966500000042' }],
      ['put', `/api/flows/${t.flow._id}`, { name: 'taken over' }], ['delete', `/api/flows/${t.flow._id}`], ['post', `/api/flows/${t.flow._id}/activate`, {}], ['post', `/api/flows/${t.flow._id}/pause`, {}],
      ['put', `/api/message-nodes/${t.node._id}`, { bodyText: 'taken over' }], ['delete', `/api/message-nodes/${t.node._id}`],
      ['post', `/api/message-nodes/${t.node._id}/submit-template`, {}], ['post', `/api/message-nodes/${t.node._id}/refresh-status`, {}],
      ['put', `/api/orders/${t.order._id}/status`, { status: 'cancelled' }], ['post', `/api/orders/${t.order._id}/refund`, {}],
      ['put', `/api/services/${t.service._id}`, { name: 'taken over' }], ['delete', `/api/services/${t.service._id}`],
      ['post', `/api/services/${t.service._id}/slots`, { date: '2031-01-01', startTime: '09:00', endTime: '10:00' }],
      ['post', `/api/services/bookings/${t.booking._id}/cancel`, {}], ['post', `/api/services/bookings/${t.booking._id}/confirm`, {}], ['post', `/api/services/bookings/${t.booking._id}/decline`, {}],
      ['post', `/api/services/bookings/${t.booking._id}/complete`, {}], ['post', `/api/services/bookings/${t.booking._id}/no-show`, {}],
      ['post', `/api/services/bookings/${t.booking._id}/reschedule`, { newSlotId: String(t.slot._id) }],
    ];
    calls.length = 0;
    const answeredOk = [];
    for (const [method, path, body] of attempts) {
      const res = await request(app)[method](path).set(A.auth).send(body || {});
      if (res.status >= 200 && res.status < 300) answeredOk.push(`${method} ${path.replace(/[0-9a-f]{24}/g, ':id')}`);
    }
    // the only "ok" answers are updates / deletes / completions that found nothing in A's own workspace and so did nothing (they say success either way)
    expect(answeredOk.sort()).toEqual(['delete /api/products/:id', 'delete /api/services/:id', 'post /api/services/bookings/:id/complete', 'put /api/services/:id']);
    expect(await snapshot()).toEqual(before); // ... and whatever the answer, their data is exactly as it was
    expect(await Q('TimeSlot').countDocuments({ serviceId: t.service._id })).toBe(1); // no slot was added to their service
    expect(outgoing()).toHaveLength(0); // and nothing was sent to anybody on their behalf
  });

  test('a customer\'s own booking cannot be moved into another customer\'s time slot', async () => {
    const service = await Q('Service').create({ workspaceId: A.workspaceId, name: 'A service', basePrice: 10 });
    const mySlot = await Q('TimeSlot').create({ workspaceId: A.workspaceId, serviceId: service._id, date: '2030-02-01', startTime: '09:00', endTime: '10:00' });
    const me = await fx.makeCustomer(A.workspaceId);
    const booking = await Q('Booking').create({ workspaceId: A.workspaceId, serviceId: service._id, slotId: mySlot._id, customerId: me._id, phone: me.phone, status: 'confirmed' });
    const res = await request(app).post(`/api/services/bookings/${booking._id}/reschedule`).set(A.auth).send({ newSlotId: String(theirs.slot._id) });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('New slot not found');
    expect(String((await Q('Booking').findById(booking._id).lean()).slotId)).toBe(String(mySlot._id));
  });

  test('a customer\'s own slot cannot be re-pointed at another customer\'s service, and its service cannot be moved to another customer', async () => {
    const service = await Q('Service').create({ workspaceId: A.workspaceId, name: 'A service 2', basePrice: 10 });
    const slot = await Q('TimeSlot').create({ workspaceId: A.workspaceId, serviceId: service._id, date: '2030-03-01', startTime: '09:00', endTime: '10:00' });
    // the slot: the legitimate part of the update goes through, the service it belongs to does not change
    let res = await request(app).put(`/api/services/${service._id}/slots/${slot._id}`).set(A.auth)
      .send({ serviceId: String(theirs.service._id), workspaceId: String(B.workspaceId), startTime: '11:00', endTime: '12:00' });
    expect(res.status).toBe(200);
    let row = await Q('TimeSlot').findById(slot._id).lean();
    expect(String(row.serviceId)).toBe(String(service._id));
    expect(String(row.workspaceId)).toBe(String(A.workspaceId));
    expect(row.startTime).toBe('11:00');
    // a slot is found through the service named in the path: with another service's id in the path nothing is updated
    res = await request(app).put(`/api/services/${theirs.service._id}/slots/${slot._id}`).set(A.auth).send({ startTime: '15:00' });
    expect((await Q('TimeSlot').findById(slot._id).lean()).startTime).toBe('11:00');
    // the service: a workspaceId in the body does not move it
    res = await request(app).put(`/api/services/${service._id}`).set(A.auth).send({ name: 'A service renamed', workspaceId: String(B.workspaceId) });
    expect(res.status).toBe(200);
    row = await Q('Service').findById(service._id).lean();
    expect(row.name).toBe('A service renamed');
    expect(String(row.workspaceId)).toBe(String(A.workspaceId));
    // a slot cannot be created under another customer's service
    res = await request(app).post(`/api/services/${theirs.service._id}/slots`).set(A.auth).send({ date: '2031-05-01', startTime: '09:00', endTime: '10:00' });
    expect(res.status).toBe(404);
    expect(await Q('TimeSlot').countDocuments({ serviceId: theirs.service._id })).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('referrals: a code is made only for the customer\'s own people, and a customer\'s summary counts only rewards of its own workspace', () => {
  test('a referral code cannot be made for a customer of another workspace (the reward would later be paid to that customer record)', async () => {
    const referrals = require('../../../shared/referrals');
    const A = await fx.makeWorkspace({ arabic: false });
    const B = await fx.makeWorkspace({ arabic: false });
    const promo = await Q('ReferralPromotion').create({ workspaceId: A.workspaceId, name: 'Bring a friend', status: 'active' });
    const mine = await fx.makeCustomer(A.workspaceId);
    const theirs = await fx.makeCustomer(B.workspaceId);

    await expect(referrals.getOrCreateCustomerCode({ referralPromotionId: promo._id, customerId: theirs._id, workspaceId: A.workspaceId })).rejects.toThrow(/Customer not found/);
    expect(await Q('ReferralCode').countDocuments({ referrerCustomerId: theirs._id })).toBe(0);
    const code = await referrals.getOrCreateCustomerCode({ referralPromotionId: promo._id, customerId: mine._id, workspaceId: A.workspaceId });
    expect(String(code.workspaceId)).toBe(String(A.workspaceId));
    expect(String(code.referrerCustomerId)).toBe(String(mine._id));
    // asking again returns the same code (nothing new is made)
    const again = await referrals.getOrCreateCustomerCode({ referralPromotionId: promo._id, customerId: mine._id, workspaceId: A.workspaceId });
    expect(String(again._id)).toBe(String(code._id));
  });

  test('getCustomerReferralSummary counts the rewards of the customer\'s own workspace only', async () => {
    const referrals = require('../../../shared/referrals');
    const A = await fx.makeWorkspace({ arabic: false });
    const B = await fx.makeWorkspace({ arabic: false });
    const customer = await fx.makeCustomer(A.workspaceId);
    const mkReward = (workspaceId) => Q('ReferralReward').create({
      workspaceId, referralId: new mongoose.Types.ObjectId(), referrerCustomerId: customer._id, rewardType: 'points', status: 'issued',
    });
    await mkReward(A.workspaceId);
    await mkReward(B.workspaceId); // a stray row in ANOTHER workspace that happens to name this customer id
    expect((await referrals.getCustomerReferralSummary({ customerId: customer._id, workspaceId: A.workspaceId })).rewardsEarned).toBe(1);
    expect((await referrals.getCustomerReferralSummary({ customerId: customer._id, workspaceId: B.workspaceId })).rewardsEarned).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('a payment names the customer that took it (Stripe PaymentIntent metadata), so its webhook can find the right workspace', () => {
  test('ops.createOrder (dashboard / assistant order): the PaymentIntent carries the workspace, the pending order and the cart belong to that customer; another customer\'s product is refused before any payment exists', async () => {
    const t = await fx.makeWorkspace({ arabic: false });
    const other = await fx.makeWorkspace({ arabic: false });
    const customer = await fx.makeCustomer(t.workspaceId, { address: '1 Test Street' });
    const mine = await Q('Product').create({ workspaceId: t.workspaceId, name: 'Mine', category: 'X', basePrice: 12.5 });
    const theirs = await Q('Product').create({ workspaceId: other.workspaceId, name: 'Theirs', category: 'X', basePrice: 7 });

    mockStripe.created.length = 0;
    await expect(ops.createOrder({ customerId: String(customer._id), items: [{ productId: String(theirs._id) }], workspaceId: t.workspaceId })).rejects.toThrow(/not found/);
    expect(mockStripe.created).toHaveLength(0); // no payment was opened for it
    expect(await Q('Order').countDocuments({ customer: customer._id })).toBe(0);

    await ops.createOrder({ customerId: String(customer._id), items: [{ productId: String(mine._id), quantity: 2 }], workspaceId: t.workspaceId });
    expect(mockStripe.created).toHaveLength(1);
    const pi = mockStripe.created[0];
    expect(pi.metadata).toMatchObject({ workspaceId: String(t.workspaceId), buyerPhone: customer.phone });
    const order = await Q('Order').findOne({ stripePaymentIntentId: pi.id }).lean();
    expect(String(order.workspaceId)).toBe(String(t.workspaceId));
    expect(String(order.customer)).toBe(String(customer._id));
    expect(order).toMatchObject({ status: 'pending', paymentStatus: 'pending' });
    // another customer cannot take an order for this customer either
    await expect(ops.createOrder({ customerId: String(customer._id), items: [{ productId: String(mine._id) }], workspaceId: other.workspaceId })).rejects.toThrow(/Customer not found/);
  });

  test('inbox "send payment link": the PaymentIntent carries the workspace of the customer it was made for', async () => {
    const inbox = require('../../../shared/inbox');
    const t = await fx.makeWorkspace({ arabic: false });
    const customer = await fx.makeCustomer(t.workspaceId);
    mockStripe.created.length = 0;
    calls.length = 0;
    await inbox.sendPaymentLink({ customerId: String(customer._id), workspaceId: t.workspaceId, amount: 25, performedBy: t.user._id });
    expect(mockStripe.created).toHaveLength(1);
    expect(mockStripe.created[0].metadata).toMatchObject({ workspaceId: String(t.workspaceId), buyerPhone: customer.phone, source: 'inbox_manual_payment_link' });
    expect(mockStripe.created[0].amount).toBe(2500);
    const sent = messagesTo(customer.phone)[0];
    expect(sent.body.text.body).toContain('/pay/pi_sec_');
    // for a customer that is not theirs: nothing is created or sent
    const other = await fx.makeWorkspace({ arabic: false });
    mockStripe.created.length = 0;
    await expect(inbox.sendPaymentLink({ customerId: String(customer._id), workspaceId: other.workspaceId, amount: 25 })).rejects.toThrow(/Customer not found/);
    expect(mockStripe.created).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe('the WhatsApp login code: guesses are counted atomically, and across all the codes of a number', () => {
  const savedMode = process.env.AUTH_TEST_MODE;
  // the real (production) behaviour: no code is echoed back and the cumulative lockout is on
  beforeEach(() => { delete process.env.AUTH_TEST_MODE; });
  afterEach(() => { if (savedMode === undefined) delete process.env.AUTH_TEST_MODE; else process.env.AUTH_TEST_MODE = savedMode; });
  const hash = (code) => crypto.createHash('sha256').update(code).digest('hex');
  // a code as the app writes it: usable for 5 minutes (validUntil), the row kept for 25 hours (expiresAt: the TTL index)
  const challenge = (contact, over = {}) => Q('LoginChallenge').create({
    method: 'whatsapp_otp', contact, codeHash: hash('123456'),
    validUntil: new Date(Date.now() + 5 * 60 * 1000), expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000), ...over,
  });
  const verify = (phone, code) => request(app).post('/api/auth/otp/verify').send({ phone, code });

  test('the limit of 5 wrong guesses per code holds against guesses sent in parallel (each is counted before it is looked at)', async () => {
    const phone = fx.nextPhone();
    const c = await challenge(phone);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => verify(phone, String(100000 + i)))); // none of them is 123456
    expect(results.filter((r) => r.body.error === 'Incorrect code')).toHaveLength(5);
    expect(results.filter((r) => /Too many incorrect attempts/.test(r.body.error))).toHaveLength(35);
    expect((await Q('LoginChallenge').findById(c._id).lean()).attempts).toBe(5);
    expect((await verify(phone, '123456')).status).toBe(400); // even the right code is refused now: a new code has to be asked for
  });

  test('across codes: after 10 wrong guesses in an hour the number is locked (429 with Retry-After) and the right code does not open it; other numbers are not affected', async () => {
    const phone = fx.nextPhone();
    await challenge(phone, { attempts: 5 });
    await challenge(phone, { attempts: 5 }); // two used-up codes = 10 wrong guesses in the last hour
    const fresh = await challenge(phone); // a third code, unused, with the right value
    const res = await verify(phone, '123456');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Too many incorrect codes for this number - please wait \d+ minutes? and try again/);
    expect(res.body.error).not.toMatch(/Email tab/); // a phone-only user has no email way in: the message says how long to wait instead
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
    expect((await Q('LoginChallenge').findById(fresh._id).lean()).consumedAt).toBeFalsy(); // the right code was not used up
    expect((await verify(phone, '999999')).status).toBe(429); // and wrong ones are refused the same way

    const other = fx.nextPhone();
    await challenge(other);
    const ok = await verify(other, '123456');
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
  });

  test('signing in is not a wrong guess: twelve successful sign-ins in an hour never lock a number, and the code works once only', async () => {
    const phone = fx.nextPhone();
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await challenge(phone);
      const res = await verify(phone, '123456');
      expect({ i, status: res.status }).toEqual({ i, status: 200 });
    }
    expect((await Q('LoginChallenge').findById(last._id).lean()).consumedAt).toBeTruthy();
    expect((await verify(phone, '123456')).status).toBe(400); // used: nothing pending
    const wrong = await challenge(phone);
    expect((await verify(phone, '000000')).body.error).toBe('Incorrect code'); // a wrong guess is still a normal wrong guess
    expect((await Q('LoginChallenge').findById(wrong._id).lean()).attempts).toBe(1);
  });

  test('a right code sent twice at the same moment signs in once; the second answers "nothing pending" and its guess is not left counted as a wrong one', async () => {
    const phone = fx.nextPhone();
    const row = await challenge(phone);
    const [first, second] = await Promise.all([verify(phone, '123456'), verify(phone, '123456')]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const loser = first.status === 400 ? first : second;
    expect(loser.body.error).toMatch(/No pending code/);
    const after = await Q('LoginChallenge').findById(row._id).lean();
    expect(after.consumedAt).toBeTruthy();
    expect(after.attempts).toBe(0); // both guesses were right: neither counts toward the 10-an-hour lockout
  });

  test('a request writes the row with a 5-minute code life and a 25-hour row life (so the guess counting outlives the code and the TTL index)', async () => {
    process.env.AUTH_TEST_MODE = 'true'; // the code is returned instead of being sent
    const phone = fx.nextPhone();
    const before = Date.now();
    const asked = await request(app).post('/api/auth/otp/request').send({ phone });
    expect(asked.status).toBe(200);
    const row = await Q('LoginChallenge').findOne({ contact: phone, method: 'whatsapp_otp' }).lean();
    const lifeOfCode = row.validUntil.getTime() - before;
    const lifeOfRow = row.expiresAt.getTime() - before;
    expect(lifeOfCode).toBeGreaterThan(4.9 * 60 * 1000);
    expect(lifeOfCode).toBeLessThan(5.1 * 60 * 1000);
    expect(lifeOfRow).toBeGreaterThan(24.9 * 60 * 60 * 1000);
    expect(lifeOfRow).toBeLessThan(25.1 * 60 * 60 * 1000);
    const link = await request(app).post('/api/auth/magic-link/request').send({ email: `link-${fx.uniq()}@example.test` });
    expect(link.status).toBe(200);
    const linkRow = await Q('LoginChallenge').findOne({ method: 'email_link' }).sort({ _id: -1 }).lean();
    expect(linkRow.validUntil.getTime() - before).toBeGreaterThan(14.9 * 60 * 1000);
    expect(linkRow.validUntil.getTime() - before).toBeLessThan(15.1 * 60 * 1000);
  });

  test('a code whose 5 minutes are over is refused even though its row is still there; the row still counts for the lockout; a row from before validUntil existed ends at expiresAt as it always did', async () => {
    const phone = fx.nextPhone();
    const old = await challenge(phone, { validUntil: new Date(Date.now() - 1000), attempts: 5 }); // over, but the row (25 h) is still in the database
    expect((await verify(phone, '123456')).body.error).toMatch(/No pending code/);
    expect((await Q('LoginChallenge').findById(old._id).lean()).consumedAt).toBeFalsy();
    // the guesses made against it are still counted: five more wrong ones on a second code make ten in the hour
    await challenge(phone, { attempts: 5 });
    await challenge(phone);
    expect((await verify(phone, '123456')).status).toBe(429);

    const legacy = fx.nextPhone();
    await Q('LoginChallenge').collection.insertOne({ method: 'whatsapp_otp', contact: legacy, codeHash: hash('123456'), attempts: 0, expiresAt: new Date(Date.now() + 60 * 1000), createdAt: new Date(), updatedAt: new Date() });
    expect((await verify(legacy, '123456')).status).toBe(200); // written by the previous version of the app: still honoured until expiresAt
    const expired = fx.nextPhone();
    await Q('LoginChallenge').collection.insertOne({ method: 'whatsapp_otp', contact: expired, codeHash: hash('123456'), attempts: 0, expiresAt: new Date(Date.now() - 1000), createdAt: new Date(), updatedAt: new Date() });
    expect((await verify(expired, '123456')).status).toBe(400);
  });

  test('in test mode the login endpoints behave as they always did (the code is returned, no lockout), so the other suites are unaffected', async () => {
    process.env.AUTH_TEST_MODE = 'true';
    const phone = fx.nextPhone();
    await challenge(phone, { attempts: 5, createdAt: new Date(Date.now() - 2000) });
    await challenge(phone, { attempts: 5, createdAt: new Date(Date.now() - 1000) });
    await challenge(phone); // the newest: the one that is checked
    expect((await verify(phone, '123456')).status).toBe(200);
    const asked = await request(app).post('/api/auth/otp/request').send({ phone: fx.nextPhone() });
    expect(asked.status).toBe(200);
    expect(asked.body.testCode).toMatch(/^\d{6}$/);
  });
});
