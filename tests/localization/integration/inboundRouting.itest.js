'use strict';
// One app, many customers: where does a WhatsApp webhook event go? End to end through the REAL server.js webhook on the
// throwaway mongod, with TWO tenants next to the oldest ("home") workspace and an axios adapter stub for every outbound call.
//   * statuses update the right tenant's CampaignMessage (also several in ONE payload)
//   * button taps resolve through context.id / the payload id to the right tenant
//   * a tenant with its OWN phone number routes by metadata.phone_number_id; an unknown phone id falls back to the oldest
//   * typed STOP on the shared number opts the phone out at EVERY business that sends from it (one reply); on a tenant's own number only
//     there; START re-opts the person in only at the business the conversation is attributed to
//   * a multi-entry / multi-change / multi-message payload is fully processed; one failing event does not stop the others
//   * X-Hub-Signature-256: off / log / enforce, valid and invalid; enforce answers 401 before anything is processed
//   * no Customer is created in a tenant workspace by an event that only reached it through a payload id
//   * a template-status event reaches shared/templateApproval.handleTemplateStatusEvent; a promo: tap reaches the tap handler
//   * Stripe: workspaceId in the PaymentIntent metadata at both creation sites; the webhook resolves the tenant from it
// Always a FRESH database per run; nothing is ever deleted.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const axios = require('axios');

// Stripe: offline and deterministic. constructEvent just parses the body (the real signature check is Stripe's).
const mockStripe = { created: [], seq: 0 };
jest.mock('stripe', () => () => ({
  paymentIntents: {
    create: async (args) => { const id = `pi_inb_${++mockStripe.seq}`; mockStripe.created.push({ id, ...args }); return { id, ...args }; },
    retrieve: async (id) => mockStripe.created.find((p) => p.id === id),
  },
  webhooks: { constructEvent: (body) => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body)) },
}));
// The two collaborators written by another part of the build are replaced by recorders: this file tests the ROUTING into them.
jest.mock('../../../shared/templateApproval', () => ({
  handleTemplateStatusEvent: jest.fn(async () => ({ handled: true })),
  startTemplateApprovalSweeper: jest.fn(),
}));
jest.mock('../../../shared/promoConsentTap', () => ({ handlePromoConsentTap: jest.fn(async () => ({ handled: true })) }));

jest.setTimeout(120000);

const fx = require('./_fixtures');
const app = require('../../../server');
const senderContext = require('../../../utils/senderContext');
const whatsappInbound = require('../../../shared/whatsappInbound');
const templateApproval = require('../../../shared/templateApproval');
const promoConsentTap = require('../../../shared/promoConsentTap');
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
    return { data: { messaging_product: 'whatsapp', messages: [{ id: `wamid.INB_OUT_${++wamidSeq}` }], id: `stub${wamidSeq}` }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}
const messagesTo = (phone) => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST' && c.body && c.body.to === phone);
const textsTo = (phone) => messagesTo(phone).map((c) => c.body.text && c.body.text.body).filter(Boolean);

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(60); }
}
const settle = (ms = 900) => sleep(ms);

// ---- fixtures: HOME (the oldest workspace), TENANT_A (has its OWN phone number), TENANT_B (shares the platform number) ----
let HOME; let A; let B; let A_PHONE_ID;
async function mkWorkspace(name, over) {
  const w = await Q('Workspace').create({ name, ...(over || {}) });
  await Q('Settings').create({ workspaceId: w._id, merchantName: name });
  await sleep(8); // createdAt has millisecond resolution: keep "oldest" unambiguous
  return w;
}
let phoneSeq = 0;
const RUN_OFFSET = Math.floor(Math.random() * 4000) * 10000; // keeps this run's phones apart even in a reused database
const newPhone = () => `9665${String(10000000 + RUN_OFFSET + (++phoneSeq)).slice(-8)}`;
const mkCustomer = (workspaceId, over = {}) => fx.makeCustomer(workspaceId, { phone: newPhone(), ...over });
const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
async function mkCm(workspaceId, customer, over = {}) {
  return Q('CampaignMessage').create({ workspaceId, kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: wid(), messageType: 'template', status: 'sent', sentAt: new Date(), ...over });
}
const customerRow = (id) => Q('Customer').findById(id).lean();

beforeAll(async () => {
  await fx.connect();
  installAdapter();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await Promise.all(['CampaignMessage', 'WhatsAppMessage', 'ConsentEvent', 'Customer', 'Workspace', 'Order'].map((m) => Q(m).init().catch(() => {})));
  const existing = await Q('Workspace').findOne().sort({ createdAt: 1 }).lean();
  HOME = existing || await mkWorkspace('Home (oldest)');
  A_PHONE_ID = `ITEST_${Date.now()}_A`;
  A = await mkWorkspace('Tenant A (own number)', { whatsapp: { phoneId: A_PHONE_ID } });
  B = await mkWorkspace('Tenant B (shared number)');
});
afterAll(async () => { jest.restoreAllMocks(); await fx.disconnect(); });
beforeEach(() => {
  calls.length = 0;
  whatsappInbound._resetForTests();
  promoConsentTap.handlePromoConsentTap.mockClear();
  templateApproval.handleTemplateStatusEvent.mockClear();
  carts.clear();
  delete process.env.WA_APP_SECRET; delete process.env.WEBHOOK_SIGNATURE_MODE; // the platform's own settings never leak into a test
});
const savedEnv = { secret: process.env.WA_APP_SECRET, mode: process.env.WEBHOOK_SIGNATURE_MODE };
afterAll(() => { for (const [k, v] of [['WA_APP_SECRET', savedEnv.secret], ['WEBHOOK_SIGNATURE_MODE', savedEnv.mode]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

// ---- webhook payload builders ----
const messagesValue = (messages, { phoneId } = {}) => ({
  messaging_product: 'whatsapp',
  ...(phoneId ? { metadata: { display_phone_number: '15550000000', phone_number_id: phoneId } } : {}),
  contacts: messages.map((m) => ({ profile: { name: 'Test Contact' }, wa_id: m.from })),
  messages,
});
const statusesValue = (statuses, { phoneId } = {}) => ({
  messaging_product: 'whatsapp',
  ...(phoneId ? { metadata: { display_phone_number: '15550000000', phone_number_id: phoneId } } : {}),
  statuses,
});
const change = (value, field = 'messages') => ({ field, value });
const payloadOf = (...entries) => ({ object: 'whatsapp_business_account', entry: entries.map((changes, i) => ({ id: `22222222222222${i}`, changes })) });
const post = (body) => request(app).post('/webhook').send(body);
const text = (from, body) => ({ from, id: wid(), timestamp: '1760000000', type: 'text', text: { body } });
const tplTap = (from, payload, ctxId) => ({ from, id: wid(), timestamp: '1760000000', type: 'button', button: { payload, text: 'Tap' }, ...(ctxId ? { context: { from: '1', id: ctxId } } : {}) });
const btnReply = (from, id, ctxId) => ({ from, id: wid(), timestamp: '1760000000', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'Btn' } }, ...(ctxId ? { context: { from: '1', id: ctxId } } : {}) });
const listReply = (from, id) => ({ from, id: wid(), timestamp: '1760000000', type: 'interactive', interactive: { type: 'list_reply', list_reply: { id, title: 'Row' } } });

// =============================================================================================================================
describe('delivery statuses', () => {
  test('statuses of two customers in ONE payload each update their own workspace\'s CampaignMessage', async () => {
    const cB = await mkCustomer(B._id); const cH = await mkCustomer(HOME._id);
    const cmB = await mkCm(B._id, cB); const cmH = await mkCm(HOME._id, cH);
    await post(payloadOf([change(statusesValue([
      { id: cmB.wamid, status: 'delivered', timestamp: '1760000000', recipient_id: cB.phone },
      { id: cmH.wamid, status: 'read', timestamp: '1760000001', recipient_id: cH.phone },
    ]))]));
    const okB = await waitFor(async () => { const r = await Q('CampaignMessage').findById(cmB._id).lean(); return r.status === 'delivered' ? r : null; });
    const okH = await waitFor(async () => { const r = await Q('CampaignMessage').findById(cmH._id).lean(); return r.status === 'read' ? r : null; });
    expect(okB).toBeTruthy(); expect(okH).toBeTruthy();
    expect(String(okB.workspaceId)).toBe(String(B._id));
    expect(okB.deliveredAt).toBeTruthy(); expect(okH.readAt).toBeTruthy();
  });

  test('a failed status keeps its Meta error code, in the tenant that sent it; a monotonic guard still applies', async () => {
    const c = await mkCustomer(B._id);
    const cm = await mkCm(B._id, c);
    await post(payloadOf([change(statusesValue([{ id: cm.wamid, status: 'read', timestamp: '1760000010' }]))]));
    await waitFor(async () => (await Q('CampaignMessage').findById(cm._id).lean()).status === 'read');
    await post(payloadOf([change(statusesValue([{ id: cm.wamid, status: 'delivered', timestamp: '1760000020' }]))]));
    await settle();
    expect((await Q('CampaignMessage').findById(cm._id).lean()).status).toBe('read'); // not downgraded
    const c2 = await mkCustomer(B._id);
    const cm2 = await mkCm(B._id, c2);
    await post(payloadOf([change(statusesValue([{ id: cm2.wamid, status: 'failed', timestamp: '1760000030', errors: [{ code: 131049, title: 'limit' }] }]))]));
    const row = await waitFor(async () => { const r = await Q('CampaignMessage').findById(cm2._id).lean(); return r.status === 'failed' ? r : null; });
    expect(row).toMatchObject({ errorCode: '131049', statusReason: 'limit' });
  });

  test('a status on a tenant\'s OWN phone number id updates that tenant\'s message', async () => {
    const c = await mkCustomer(A._id);
    const cm = await mkCm(A._id, c);
    await post(payloadOf([change(statusesValue([{ id: cm.wamid, status: 'delivered', timestamp: '1760000000' }], { phoneId: A_PHONE_ID }))]));
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cm._id).lean()).status === 'delivered')).toBeTruthy();
  });

  test('an unknown wamid changes nothing and does not break the rest of the payload', async () => {
    const c = await mkCustomer(B._id);
    const cm = await mkCm(B._id, c);
    await post(payloadOf([change(statusesValue([{ id: 'wamid.nobody', status: 'failed', timestamp: '1760000000', errors: [{ code: 1, title: 'x' }] }, { id: cm.wamid, status: 'sent', timestamp: '1760000000' }]))]));
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cm._id).lean()).status === 'sent')).toBeTruthy();
    expect(calls.filter((x) => /\/messages$/.test(x.url))).toHaveLength(0); // a status never sends anything
  });
});

// =============================================================================================================================
describe('button taps resolve to the right tenant', () => {
  test('a branching tap on a tenant\'s message (context.id) runs the follow-up in THAT tenant, from its own records', async () => {
    const customer = await mkCustomer(B._id);
    const promotion = await Q('Promotion').create({ workspaceId: B._id, name: 'B promo', customerType: 'cash', scope: 'products', discountPercent: 10 });
    const follow = await Q('MessageNode').create({ workspaceId: B._id, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Great choice {{1}}!', buttons: [{ position: 0, label: 'Done', nextAction: { type: 'end_flow' } }] });
    const entry = await Q('MessageNode').create({ workspaceId: B._id, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}', templateName: `inb_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: follow._id } }] });
    const cm = await mkCm(B._id, customer, { promotion: promotion._id, messageNode: entry._id });
    await post(payloadOf([change(messagesValue([tplTap(customer.phone, `msgnode_${entry._id}_0`, cm.wamid)]))]));
    const rows = await waitFor(async () => { const r = await Q('CampaignMessage').find({ customer: customer._id, messageNode: follow._id }).lean(); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(String(rows[0].workspaceId)).toBe(String(B._id));
    const claimed = await Q('CampaignMessage').findById(cm._id).lean();
    expect(claimed.respondedAt).toBeTruthy();
    expect(messagesTo(customer.phone).length).toBeGreaterThanOrEqual(1);
  });

  test('promo_ tap with context.id: the tenant\'s promotion is found, the click recorded, the catalogue sent', async () => {
    const customer = await mkCustomer(B._id);
    const product = await Q('Product').create({ workspaceId: B._id, name: 'B Hat', category: 'Hats', basePrice: 20, active: true });
    const promotion = await Q('Promotion').create({ workspaceId: B._id, name: 'B hats', customerType: 'cash', scope: 'products', discountPercent: 10, products: [product._id] });
    const cm = await mkCm(B._id, customer, { promotion: promotion._id });
    await post(payloadOf([change(messagesValue([tplTap(customer.phone, `promo_${promotion._id}`, cm.wamid)]))]));
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cm._id).lean()).clickedAt)).toBeTruthy();
    expect(await waitFor(() => messagesTo(customer.phone).length >= 1)).toBeTruthy();
  });

  test('a consent_yes_ tap carries its customer id: consent is recorded in the tenant, nowhere else', async () => {
    const customer = await mkCustomer(B._id, { marketingConsent: false });
    const bystander = await mkCustomer(HOME._id, { phone: customer.phone, marketingConsent: false }); // same phone, other business
    await post(payloadOf([change(messagesValue([btnReply(customer.phone, `consent_yes_${customer._id}`)]))]));
    const row = await waitFor(async () => { const r = await customerRow(customer._id); return r.marketingConsent ? r : null; });
    expect(row).toBeTruthy();
    expect(await Q('ConsentEvent').countDocuments({ customerId: customer._id, type: 'consent_given' })).toBe(1);
    expect(String((await Q('ConsentEvent').findOne({ customerId: customer._id }).lean()).workspaceId)).toBe(String(B._id));
    expect((await customerRow(bystander._id)).marketingConsent).toBe(false);
    expect(await Q('ConsentEvent').countDocuments({ customerId: bystander._id })).toBe(0);
  });

  test('a service-slot pick (list reply) resolves through the slot\'s workspace', async () => {
    const stranger = newPhone(); // not a customer of anybody: only the slot id says whose it is
    const service = await Q('Service').create({ workspaceId: B._id, name: 'B Massage', basePrice: 50 });
    const slot = await Q('TimeSlot').create({ workspaceId: B._id, serviceId: service._id, date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 2 });
    require('../../../utils/state').pendingSlotSelections.set(stranger, { service, promotion: null, slots: [slot], isFree: false, campaignMessageId: null, workspaceId: B._id });
    mockStripe.created.length = 0;
    await post(payloadOf([change(messagesValue([listReply(stranger, `slot_${slot._id}`)]))]));
    const pi = await waitFor(() => mockStripe.created.find((p) => p.metadata && p.metadata.slotId === String(slot._id)));
    expect(pi).toBeTruthy();
    expect(pi.metadata.workspaceId).toBe(String(B._id)); // Stripe creation site 2
  });
});

// =============================================================================================================================
describe('a tenant with its own phone number', () => {
  test('a message to that number belongs to that tenant: the customer is created there (and only there)', async () => {
    const stranger = newPhone();
    const homeBefore = await Q('Customer').countDocuments({ workspaceId: HOME._id });
    await post(payloadOf([change(messagesValue([text(stranger, 'hello from a new customer')], { phoneId: A_PHONE_ID }))]));
    const created = await waitFor(async () => Q('Customer').findOne({ workspaceId: A._id, phone: stranger }).lean());
    expect(created).toBeTruthy();
    expect(await Q('WhatsAppMessage').countDocuments({ workspaceId: A._id, phone: stranger, direction: 'inbound' })).toBe(1);
    expect(await Q('Customer').countDocuments({ phone: stranger, workspaceId: { $ne: A._id } })).toBe(0);
    expect(await Q('Customer').countDocuments({ workspaceId: HOME._id })).toBe(homeBefore);
  });

  test('the phone id wins over a customer of the same phone in another business', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone });
    const unreadBefore = (await customerRow(inB._id)).unreadCount || 0;
    await post(payloadOf([change(messagesValue([text(phone, 'writing to tenant A')], { phoneId: A_PHONE_ID }))]));
    expect(await waitFor(async () => Q('Customer').findOne({ workspaceId: A._id, phone }).lean())).toBeTruthy();
    await settle(300);
    expect((await customerRow(inB._id)).unreadCount || 0).toBe(unreadBefore);
  });

  test('the sender context of the event is the tenant: an automatic reply leaves from the tenant\'s own number', async () => {
    const phone = newPhone();
    await mkCustomer(A._id, { phone });
    await post(payloadOf([change(messagesValue([text(phone, 'STOP')], { phoneId: A_PHONE_ID }))]));
    expect(await waitFor(() => messagesTo(phone).length === 1)).toBeTruthy();
    const sent = calls.find((c) => /\/messages$/.test(c.url) && c.body && c.body.to === phone);
    expect(sent.url).toContain(A_PHONE_ID);
  });

  test('an unknown phone id and no other information: the oldest workspace, exactly as before (and a warning is logged)', async () => {
    const stranger = newPhone();
    console.warn.mockClear();
    await post(payloadOf([change(messagesValue([text(stranger, 'hi')], { phoneId: `UNKNOWN_${Date.now()}` }))]));
    expect(await waitFor(async () => Q('Customer').findOne({ workspaceId: HOME._id, phone: stranger }).lean())).toBeTruthy();
    expect(await Q('Customer').countDocuments({ phone: stranger, workspaceId: { $ne: HOME._id } })).toBe(0);
    expect(console.warn.mock.calls.some((c) => /matches no workspace/.test(String(c[0])))).toBe(true);
  });

  test('a stranger on the shared number (no phone id in the payload at all) still lands in the oldest workspace', async () => {
    const stranger = newPhone();
    await post(payloadOf([change(messagesValue([text(stranger, 'hi there')]))]));
    expect(await waitFor(async () => Q('Customer').findOne({ workspaceId: HOME._id, phone: stranger }).lean())).toBeTruthy();
  });

  test('typed text from a known customer of tenant B on the shared number is B\'s conversation', async () => {
    const c = await mkCustomer(B._id);
    await post(payloadOf([change(messagesValue([text(c.phone, 'do you have this in blue?')]))]));
    expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: B._id, customer: c._id, direction: 'inbound' }).lean())).toBeTruthy();
    expect(await Q('Customer').countDocuments({ phone: c.phone })).toBe(1);
  });

  test('a customer of two businesses: the one that messaged them most recently gets the reply', async () => {
    const phone = newPhone();
    const inHome = await mkCustomer(HOME._id, { phone }); const inB = await mkCustomer(B._id, { phone });
    await mkCm(HOME._id, inHome, { createdAt: new Date(Date.now() - 50 * 3600 * 1000) });
    await mkCm(B._id, inB, { createdAt: new Date(Date.now() - 1 * 3600 * 1000) });
    await post(payloadOf([change(messagesValue([text(phone, 'thanks!')]))]));
    expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: B._id, customer: inB._id, direction: 'inbound' }).lean())).toBeTruthy();
    await settle(300);
    expect(await Q('WhatsAppMessage').countDocuments({ workspaceId: HOME._id, customer: inHome._id, direction: 'inbound' })).toBe(0);
  });
});

// =============================================================================================================================
describe('STOP and START', () => {
  test('typed STOP on the shared number opts the phone out in EVERY workspace that sends from it, with ONE reply; a workspace with its OWN number is not touched', async () => {
    const phone = newPhone();
    const inHome = await mkCustomer(HOME._id, { phone }); const inA = await mkCustomer(A._id, { phone }); const inB = await mkCustomer(B._id, { phone });
    const other = await mkCustomer(B._id); // a different person: untouched
    await post(payloadOf([change(messagesValue([text(phone, 'STOP')]))]));
    // HOME and B send from the shared number: opted out, each with an event of its own. A has its own number (A_PHONE_ID): the
    // STOP was typed to the shared number, so A's customer - who sees A's own number as a different sender - is left alone.
    for (const c of [inHome, inB]) {
      const row = await waitFor(async () => { const r = await customerRow(c._id); return r.optedOut ? r : null; });
      expect(row).toBeTruthy();
      expect(row.optedOutAt).toBeTruthy();
      const ev = await Q('ConsentEvent').find({ customerId: c._id }).lean();
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command', phone });
      expect(String(ev[0].workspaceId)).toBe(String(c.workspaceId));
    }
    expect((await customerRow(other._id)).optedOut).toBeFalsy();
    await settle(500);
    expect((await customerRow(inA._id)).optedOut).toBeFalsy();
    expect(await Q('ConsentEvent').countDocuments({ customerId: inA._id })).toBe(0);
    expect(textsTo(phone)).toEqual(["You've been unsubscribed from promotional messages. Reply START to opt back in anytime."]);
  });

  test('UNSUBSCRIBE (any case, spaces) works the same way', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone }); const inHome = await mkCustomer(HOME._id, { phone });
    await post(payloadOf([change(messagesValue([text(phone, '  unsubscribe ')]))]));
    expect(await waitFor(async () => (await customerRow(inB._id)).optedOut && (await customerRow(inHome._id)).optedOut)).toBeTruthy();
  });

  test('typed STOP on a tenant\'s OWN number applies to that tenant only', async () => {
    const phone = newPhone();
    const inHome = await mkCustomer(HOME._id, { phone }); const inA = await mkCustomer(A._id, { phone }); const inB = await mkCustomer(B._id, { phone });
    await post(payloadOf([change(messagesValue([text(phone, 'STOP')], { phoneId: A_PHONE_ID }))]));
    expect(await waitFor(async () => (await customerRow(inA._id)).optedOut)).toBeTruthy();
    await settle(500);
    expect((await customerRow(inHome._id)).optedOut).toBeFalsy();
    expect((await customerRow(inB._id)).optedOut).toBeFalsy();
    expect(await Q('ConsentEvent').countDocuments({ customerId: { $in: [inHome._id, inB._id] } })).toBe(0);
    expect(messagesTo(phone)).toHaveLength(1);
  });

  test('STOP from a phone nobody has: as before, the inbox creates the customer in the OLDEST workspace and it is opted out there only; one reply', async () => {
    const phone = newPhone();
    await post(payloadOf([change(messagesValue([text(phone, 'STOP')]))]));
    expect(await waitFor(() => messagesTo(phone).length === 1)).toBeTruthy();
    await settle(300);
    expect(messagesTo(phone)).toHaveLength(1);
    const rows = await Q('Customer').find({ phone }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].workspaceId)).toBe(String(HOME._id));
    expect(rows[0].optedOut).toBe(true);
    expect(await Q('ConsentEvent').countDocuments({ phone, type: 'consent_withdrawn' })).toBe(1);
  });

  // STOP goes to every business on the shared number (nobody can say which one they mean); START is the opposite kind of statement
  // (it asks a business to message you), so it re-opts the person in ONLY at the business the conversation is attributed to (here the
  // oldest of the two that hold the number: no message of either was sent to it in the last 72 hours).
  test('START puts the customer back only at the business the conversation belongs to; the other business stays opted out; one reply', async () => {
    const phone = newPhone();
    const optedOut = { marketingConsent: true, optedOut: true, optedOutAt: new Date() };
    const inHome = await mkCustomer(HOME._id, { phone, ...optedOut });
    const inB = await mkCustomer(B._id, { phone, ...optedOut });
    const neverConsented = await mkCustomer(B._id, { phone: newPhone(), marketingConsent: false });
    await post(payloadOf([change(messagesValue([text(phone, 'START')]))]));
    const row = await waitFor(async () => { const r = await customerRow(inHome._id); return r.optedOut === false ? r : null; });
    expect(row).toBeTruthy();
    expect(row.marketingConsent).toBe(true);
    await settle(500);
    expect((await customerRow(inB._id)).optedOut).toBe(true); // never re-opted-in at a business they did not address
    expect(await Q('ConsentEvent').countDocuments({ customerId: inB._id })).toBe(0);
    expect(textsTo(phone)).toEqual(["You're subscribed to promotional messages again. Welcome back! \u{1F389}"]);
    expect((await customerRow(neverConsented._id)).marketingConsent).toBe(false); // START never fabricates consent for somebody else
  });

  test('START from an opted-out customer who had never opted in is a fresh opt-in at the attributed business, with the typed words and message id as evidence', async () => {
    const phone = newPhone();
    const c = await mkCustomer(B._id, { phone, marketingConsent: false, optedOut: true, optedOutAt: new Date() });
    await post(payloadOf([change(messagesValue([text(phone, 'start')]))]));
    const row = await waitFor(async () => { const r = await customerRow(c._id); return r.optedOut === false ? r : null; });
    expect(row).toBeTruthy();
    expect(row).toMatchObject({ marketingConsent: true, marketingConsentMethod: 'whatsapp_button' }); // the customer record keeps the two values the previous release knows
    const events = await Q('ConsentEvent').find({ customerId: c._id }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'consent_given', method: 'whatsapp_start_command', source: 'START after opt-out', messageText: 'start' });
    expect(events[0].inboundWamid).toMatch(/^wamid\./);
  });
  test('START from a customer who never opted in or out: the existing "Got it" reply and no consent', async () => {
    const phone = newPhone();
    const c = await mkCustomer(B._id, { phone, marketingConsent: false });
    await post(payloadOf([change(messagesValue([text(phone, 'START')]))]));
    expect(await waitFor(() => messagesTo(phone).length === 1)).toBeTruthy();
    expect(textsTo(phone)).toEqual(['Got it — you won\'t receive promotional messages unless you opt in.']);
    expect((await customerRow(c._id)).marketingConsent).toBe(false);
    expect(await Q('ConsentEvent').countDocuments({ customerId: c._id })).toBe(0);
  });

  test('a Meta redelivery of the same STOP records nothing twice and answers once', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone }); const inHome = await mkCustomer(HOME._id, { phone });
    const message = text(phone, 'STOP');
    await post(payloadOf([change(messagesValue([message]))]));
    expect(await waitFor(async () => (await customerRow(inB._id)).optedOut && (await customerRow(inHome._id)).optedOut)).toBeTruthy();
    await settle(500);
    await post(payloadOf([change(messagesValue([message]))]));
    await settle(800);
    expect(await Q('ConsentEvent').countDocuments({ customerId: { $in: [inB._id, inHome._id] }, type: 'consent_withdrawn' })).toBe(2);
    expect(textsTo(phone)).toHaveLength(1);
  });
});

// =============================================================================================================================
describe('batched payloads', () => {
  test('several entries, several changes and several messages in ONE POST are all processed, each in its own workspace', async () => {
    const cB = await mkCustomer(B._id); const cH = await mkCustomer(HOME._id); const cA = await mkCustomer(A._id);
    const cmB = await mkCm(B._id, cB); const cmH = await mkCm(HOME._id, cH); const cmA = await mkCm(A._id, cA);
    const stranger = newPhone();
    await post(payloadOf(
      [
        change(statusesValue([{ id: cmB.wamid, status: 'delivered', timestamp: '1760000000' }])),
        change(messagesValue([text(cH.phone, 'first message'), text(cB.phone, 'second message')])),
        change({ event: 'APPROVED', message_template_name: 'waflow_flow_abc', message_template_id: '1' }, 'message_template_status_update'),
      ],
      [
        change(statusesValue([{ id: cmH.wamid, status: 'read', timestamp: '1760000001' }])),
        change(statusesValue([{ id: cmA.wamid, status: 'delivered', timestamp: '1760000002' }], { phoneId: A_PHONE_ID })),
        change(messagesValue([text(stranger, 'hello from nowhere')], { phoneId: A_PHONE_ID })),
      ],
    ));
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cmB._id).lean()).status === 'delivered')).toBeTruthy();
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cmH._id).lean()).status === 'read')).toBeTruthy();
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cmA._id).lean()).status === 'delivered')).toBeTruthy();
    expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: HOME._id, customer: cH._id, direction: 'inbound' }).lean())).toBeTruthy();
    expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: B._id, customer: cB._id, direction: 'inbound' }).lean())).toBeTruthy();
    expect(await waitFor(async () => Q('Customer').findOne({ workspaceId: A._id, phone: stranger }).lean())).toBeTruthy();
    expect(await waitFor(() => templateApproval.handleTemplateStatusEvent.mock.calls.length === 1)).toBeTruthy();
  });

  test('every event is processed with ITS workspace as the sender context (no leaking from the previous event)', async () => {
    const seen = [];
    promoConsentTap.handlePromoConsentTap.mockImplementation(async ({ from }) => { seen.push([from, senderContext.currentWorkspaceId()]); await sleep(40); seen.push([from, senderContext.currentWorkspaceId()]); });
    try {
      const cB = await mkCustomer(B._id); const cH = await mkCustomer(HOME._id); const cA = await mkCustomer(A._id);
      const promoB = await Q('Promotion').create({ workspaceId: B._id, name: 'ctx B', customerType: 'cash', scope: 'products' });
      const promoH = await Q('Promotion').create({ workspaceId: HOME._id, name: 'ctx H', customerType: 'cash', scope: 'products' });
      await post(payloadOf([
        change(messagesValue([tplTap(cB.phone, `promo:${promoB._id}:opt_in:0`), tplTap(cH.phone, `promo:${promoH._id}:opt_in:0`)])),
        change(messagesValue([tplTap(cA.phone, `promo:${promoB._id}:opt_in:0`)], { phoneId: A_PHONE_ID })),
      ]));
      expect(await waitFor(() => seen.length === 6)).toBeTruthy();
      const byPhone = {};
      for (const [phone, ws] of seen) (byPhone[phone] = byPhone[phone] || []).push(ws);
      expect(byPhone[cB.phone]).toEqual([String(B._id), String(B._id)]);
      expect(byPhone[cH.phone]).toEqual([String(HOME._id), String(HOME._id)]);
      expect(byPhone[cA.phone]).toEqual([String(A._id), String(A._id)]); // R1: its own number, whatever the payload says
    } finally {
      promoConsentTap.handlePromoConsentTap.mockImplementation(async () => ({ handled: true }));
    }
  });

  test('one event that fails does not stop the next event of the same POST', async () => {
    const c1 = await mkCustomer(B._id); const c2 = await mkCustomer(B._id);
    const real = whatsappInbound.resolveEventWorkspace;
    const spy = jest.spyOn(whatsappInbound, 'resolveEventWorkspace').mockImplementationOnce(async () => { throw new Error('resolution blew up'); });
    try {
      await post(payloadOf([change(messagesValue([text(c1.phone, 'one'), text(c2.phone, 'two')]))]));
      expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: B._id, customer: c2._id, direction: 'inbound' }).lean())).toBeTruthy();
      expect(await Q('WhatsAppMessage').countDocuments({ customer: c1._id })).toBe(0);
      expect(console.error.mock.calls.some((c) => /message not processed/.test(String(c[0])))).toBe(true);
    } finally { spy.mockRestore(); expect(whatsappInbound.resolveEventWorkspace).toBe(real); }
  });

  test('a payload with no entries, an empty change, an unknown field or a missing value is ignored without a crash', async () => {
    for (const body of [{}, { entry: [] }, { entry: [{}] }, { entry: [{ changes: [{}] }] }, { entry: [{ changes: [{ field: 'account_update', value: { event: 'x' } }] }] }, { entry: 'nope' }]) {
      const res = await post(body);
      expect(res.status).toBe(200);
    }
    await settle(300);
  });
});

// =============================================================================================================================
describe('template approval news', () => {
  test('a message_template_status_update change reaches handleTemplateStatusEvent with the value and the change', async () => {
    const value = { event: 'APPROVED', message_template_id: '99', message_template_name: 'waflow_flow_0123456789', message_template_language: 'en' };
    await post(payloadOf([change(value, 'message_template_status_update')]));
    expect(await waitFor(() => templateApproval.handleTemplateStatusEvent.mock.calls.length === 1)).toBeTruthy();
    const arg = templateApproval.handleTemplateStatusEvent.mock.calls[0][0];
    expect(arg.value).toEqual(value);
    expect(arg.change).toMatchObject({ field: 'message_template_status_update' });
  });
  test('a handler that throws is logged and the rest of the POST still runs', async () => {
    templateApproval.handleTemplateStatusEvent.mockRejectedValueOnce(new Error('graph down'));
    const c = await mkCustomer(B._id); const cm = await mkCm(B._id, c);
    await post(payloadOf([
      change({ event: 'REJECTED', message_template_name: 'x' }, 'message_template_status_update'),
      change(statusesValue([{ id: cm.wamid, status: 'delivered', timestamp: '1760000000' }])),
    ]));
    expect(await waitFor(async () => (await Q('CampaignMessage').findById(cm._id).lean()).status === 'delivered')).toBeTruthy();
  });
  test('the template-approval sweeper is started in the listen callback, in a try/catch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'server.js'), 'utf8');
    const listen = src.slice(src.indexOf('app.listen(PORT'));
    expect(listen).toMatch(/try \{ require\("\.\/shared\/templateApproval"\)\.startTemplateApprovalSweeper\(\); \}/);
  });
});

// =============================================================================================================================
describe('consent-request taps (promo:)', () => {
  test('a promo: template tap is handed to the tap handler FIRST, with the signature and the deps it needs', async () => {
    const c = await mkCustomer(B._id);
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'consent', customerType: 'cash', scope: 'products' });
    const message = tplTap(c.phone, `promo:${promo._id}:opt_in:0`, 'wamid.something');
    await post(payloadOf([change(messagesValue([message]))]));
    expect(await waitFor(() => promoConsentTap.handlePromoConsentTap.mock.calls.length === 1)).toBeTruthy();
    const arg = promoConsentTap.handlePromoConsentTap.mock.calls[0][0];
    expect(arg.from).toBe(c.phone);
    expect(arg.message.button.payload).toBe(`promo:${promo._id}:opt_in:0`);
    expect(arg.signature).toBe('unconfigured'); // WA_APP_SECRET is not set in tests
    expect(typeof arg.deps.handlePromoInterest).toBe('function');
    expect(typeof arg.deps.sendText).toBe('function');
    // none of the old promo_ handling ran for it
    expect(await Q('CampaignMessage').countDocuments({ customer: c._id })).toBe(0);
    expect(messagesTo(c.phone)).toHaveLength(0);
  });

  test('deps.sendText sends a plain WhatsApp text and deps.handlePromoInterest opens the tenant\'s shop flow', async () => {
    const c = await mkCustomer(B._id);
    const product = await Q('Product').create({ workspaceId: B._id, name: 'Consent Hat', category: 'Hats', basePrice: 9, active: true });
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'consent shop', customerType: 'cash', scope: 'products', products: [product._id] });
    const cm = await mkCm(B._id, c, { promotion: promo._id });
    promoConsentTap.handlePromoConsentTap.mockImplementationOnce(async ({ from, deps }) => {
      await deps.sendText(from, 'You are in!');
      await deps.handlePromoInterest(from, String(promo._id), cm._id, B._id);
    });
    await post(payloadOf([change(messagesValue([tplTap(c.phone, `promo:${promo._id}:interested:0`, cm.wamid)]))]));
    expect(await waitFor(() => textsTo(c.phone).includes('You are in!'))).toBeTruthy();
    expect(await waitFor(() => messagesTo(c.phone).length >= 2)).toBeTruthy(); // the catalogue followed
  });

  test('a throwing tap handler never breaks the webhook', async () => {
    const c = await mkCustomer(B._id);
    promoConsentTap.handlePromoConsentTap.mockRejectedValueOnce(new Error('tap exploded'));
    const res = await post(payloadOf([change(messagesValue([tplTap(c.phone, `promo:${'a'.repeat(24)}:opt_in:0`)]))]));
    expect(res.status).toBe(200);
    expect(await waitFor(() => console.error.mock.calls.some((x) => /promo consent tap error/.test(String(x[0]))))).toBeTruthy();
  });

  test('a promo: tap from a stranger is attributed by the promotion and creates NO customer in that tenant', async () => {
    const stranger = newPhone();
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'consent stranger', customerType: 'cash', scope: 'products' });
    const before = await Q('Customer').countDocuments({ workspaceId: B._id });
    await post(payloadOf([change(messagesValue([tplTap(stranger, `promo:${promo._id}:opt_in:0`)]))]));
    expect(await waitFor(() => promoConsentTap.handlePromoConsentTap.mock.calls.length === 1)).toBeTruthy();
    await settle(400);
    expect(await Q('Customer').countDocuments({ workspaceId: B._id })).toBe(before);
    expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
    expect(await Q('WhatsAppMessage').countDocuments({ phone: stranger })).toBe(0);
  });
});

// =============================================================================================================================
describe('no customer is created in a tenant workspace by accident', () => {
  test('a payload id that points into a tenant, from a phone that is not that tenant\'s customer: nothing is created there', async () => {
    const stranger = newPhone();
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'B accident', customerType: 'cash', scope: 'products' });
    const before = await Q('Customer').countDocuments({ workspaceId: B._id });
    await post(payloadOf([change(messagesValue([tplTap(stranger, `promo_${promo._id}`)]))]));
    await settle();
    expect(await Q('Customer').countDocuments({ workspaceId: B._id })).toBe(before);
    expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
  });

  test('a reply to a tenant\'s message from another phone: nothing is created in the tenant', async () => {
    const owner = await mkCustomer(B._id);
    const cm = await mkCm(B._id, owner);
    const stranger = newPhone();
    const before = await Q('Customer').countDocuments({ workspaceId: B._id });
    await post(payloadOf([change(messagesValue([{ ...text(stranger, 'forwarded this'), context: { id: cm.wamid } }]))]));
    await settle();
    expect(await Q('Customer').countDocuments({ workspaceId: B._id })).toBe(before);
    expect(await Q('Customer').countDocuments({ phone: stranger })).toBe(0);
  });

  test('...while a known customer of the tenant IS logged in the tenant, as before', async () => {
    const known = await mkCustomer(B._id);
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'B known', customerType: 'cash', scope: 'products' });
    await post(payloadOf([change(messagesValue([tplTap(known.phone, `promo_${promo._id}`)]))]));
    expect(await waitFor(async () => Q('WhatsAppMessage').findOne({ workspaceId: B._id, customer: known._id, direction: 'inbound' }).lean())).toBeTruthy();
  });

  test('the oldest workspace keeps today\'s behaviour: a stranger tapping its promotion becomes its customer', async () => {
    const stranger = newPhone();
    const promo = await Q('Promotion').create({ workspaceId: HOME._id, name: 'home promo', customerType: 'cash', scope: 'products' });
    await post(payloadOf([change(messagesValue([tplTap(stranger, `promo_${promo._id}`)]))]));
    expect(await waitFor(async () => Q('Customer').findOne({ workspaceId: HOME._id, phone: stranger }).lean())).toBeTruthy();
  });
});

// =============================================================================================================================
describe('X-Hub-Signature-256', () => {
  const SECRET = 'itest-app-secret-not-real';
  const saved = {};
  beforeEach(() => {
    saved.mode = process.env.WEBHOOK_SIGNATURE_MODE; saved.secret = process.env.WA_APP_SECRET;
    delete process.env.WEBHOOK_SIGNATURE_MODE; delete process.env.WA_APP_SECRET;
    jest.spyOn(Date, 'now'); // the "log at most once a minute" throttle is moved forward by the helpers below
  });
  afterEach(() => {
    if (saved.mode === undefined) delete process.env.WEBHOOK_SIGNATURE_MODE; else process.env.WEBHOOK_SIGNATURE_MODE = saved.mode;
    if (saved.secret === undefined) delete process.env.WA_APP_SECRET; else process.env.WA_APP_SECRET = saved.secret;
    Date.now.mockRestore();
  });
  const sign = (raw, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  let clockShift = 0;
  async function tapWith({ header, mode, secret }) {
    if (mode !== undefined) process.env.WEBHOOK_SIGNATURE_MODE = mode;
    if (secret !== undefined) process.env.WA_APP_SECRET = secret;
    const c = await mkCustomer(B._id);
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'sig', customerType: 'cash', scope: 'products' });
    const raw = JSON.stringify(payloadOf([change(messagesValue([tplTap(c.phone, `promo:${promo._id}:opt_in:0`)]))]));
    promoConsentTap.handlePromoConsentTap.mockClear();
    console.warn.mockClear();
    clockShift += 61 * 1000; // past the warn throttle, every time
    Date.now.mockImplementation(() => new Date().getTime() + clockShift);
    let r = request(app).post('/webhook').set('Content-Type', 'application/json');
    if (header === 'valid') r = r.set('X-Hub-Signature-256', sign(raw));
    else if (header === 'invalid') r = r.set('X-Hub-Signature-256', sign(raw, 'the-wrong-secret'));
    else if (header === 'garbage') r = r.set('X-Hub-Signature-256', 'not-a-signature');
    const res = await r.send(raw);
    return { res, raw, c, signature: async () => { const hit = await waitFor(() => promoConsentTap.handlePromoConsentTap.mock.calls[0]); return hit && hit[0].signature; } };
  }
  const warned = () => console.warn.mock.calls.some((c) => /X-Hub-Signature-256/.test(String(c[0])));

  test('default mode is log; no secret configured: \'unconfigured\', nothing logged, processed', async () => {
    const t = await tapWith({ header: 'none' });
    expect(t.res.status).toBe(200);
    expect(await t.signature()).toBe('unconfigured');
    expect(warned()).toBe(false);
  });
  test('log mode with a secret: valid -> \'valid\'; invalid / garbage -> \'invalid\'; none -> \'missing\' (all accepted, bad ones logged)', async () => {
    const valid = await tapWith({ header: 'valid', mode: 'log', secret: SECRET });
    expect(valid.res.status).toBe(200); expect(await valid.signature()).toBe('valid'); expect(warned()).toBe(false);
    const bad = await tapWith({ header: 'invalid', mode: 'log', secret: SECRET });
    expect(bad.res.status).toBe(200); expect(await bad.signature()).toBe('invalid'); expect(warned()).toBe(true);
    const garbage = await tapWith({ header: 'garbage', mode: 'log', secret: SECRET });
    expect(garbage.res.status).toBe(200); expect(await garbage.signature()).toBe('invalid');
    const none = await tapWith({ header: 'none', mode: 'log', secret: SECRET });
    expect(none.res.status).toBe(200); expect(await none.signature()).toBe('missing'); expect(warned()).toBe(true);
  });
  test('an unrecognised mode value behaves as log', async () => {
    const t = await tapWith({ header: 'invalid', mode: 'banana', secret: SECRET });
    expect(t.res.status).toBe(200);
    expect(await t.signature()).toBe('invalid');
  });
  test('off: not checked, nothing logged, \'unconfigured\', processed', async () => {
    const t = await tapWith({ header: 'invalid', mode: 'off', secret: SECRET });
    expect(t.res.status).toBe(200);
    expect(await t.signature()).toBe('unconfigured');
    expect(warned()).toBe(false);
  });
  test('enforce + secret: an invalid or missing signature is answered 401 BEFORE the 200 and NOTHING is processed', async () => {
    for (const header of ['invalid', 'garbage', 'none']) {
      const t = await tapWith({ header, mode: 'enforce', secret: SECRET });
      expect(t.res.status).toBe(401);
      expect(t.res.body).toEqual({ error: 'Invalid signature' });
      await settle(300);
      expect(promoConsentTap.handlePromoConsentTap).not.toHaveBeenCalled();
      expect(await Q('WhatsAppMessage').countDocuments({ customer: t.c._id })).toBe(0);
    }
  });
  test('enforce + secret: a valid signature is accepted and processed', async () => {
    const t = await tapWith({ header: 'valid', mode: 'enforce', secret: SECRET });
    expect(t.res.status).toBe(200);
    expect(await t.signature()).toBe('valid');
  });
  test('enforce WITHOUT a secret never rejects (a missing app secret must not take the live webhook down)', async () => {
    const t = await tapWith({ header: 'invalid', mode: 'enforce' });
    expect(t.res.status).toBe(200);
    expect(await t.signature()).toBe('unconfigured');
  });
  test('enforce + secret: another capitalisation of the path, a trailing slash, a form-encoded or a text body cannot get around the check', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce'; process.env.WA_APP_SECRET = SECRET;
    const c = await mkCustomer(B._id);
    const promo = await Q('Promotion').create({ workspaceId: B._id, name: 'sig-bypass', customerType: 'cash', scope: 'products' });
    const body = payloadOf([change(messagesValue([tplTap(c.phone, `promo:${promo._id}:opt_in:0`)]))]);
    const raw = JSON.stringify(body);
    promoConsentTap.handlePromoConsentTap.mockClear();
    for (const path of ['/WEBHOOK', '/Webhook', '/webhook/', '/WebHook//']) {
      const res = await request(app).post(path).set('Content-Type', 'application/json').send(raw);
      expect([path, res.status]).toEqual([path, 401]);
    }
    // a form body is parsed by express.urlencoded (extended) into the very same nested object; Meta only ever sends JSON
    const form = await request(app).post('/webhook').type('form').send(require('qs').stringify(body));
    expect(form.status).toBe(401);
    const text = await request(app).post('/webhook').set('Content-Type', 'text/plain').send(raw);
    expect(text.status).toBe(401);
    await settle(300);
    expect(promoConsentTap.handlePromoConsentTap).not.toHaveBeenCalled();
    expect(await Q('WhatsAppMessage').countDocuments({ customer: c._id })).toBe(0);
    // the same bytes, signed, are accepted on the other capitalisation too (the check is about the signature, not the spelling)
    const ok = await request(app).post('/WEBHOOK').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(raw)).send(raw);
    expect(ok.status).toBe(200);
  });
  test('the signature covers the exact bytes: a valid signature of a DIFFERENT body is invalid', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce'; process.env.WA_APP_SECRET = SECRET;
    const raw = JSON.stringify(payloadOf([change(messagesValue([text(newPhone(), 'hello')]))]));
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', sign(`${raw} `)).send(raw);
    expect(res.status).toBe(401);
  });
  test('other routes are not affected, whatever the mode', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce'; process.env.WA_APP_SECRET = SECRET;
    const res = await request(app).post('/api/auth/otp/request').send({});
    expect(res.status).toBeLessThan(500); // answered by the auth route itself, never by the signature gate
    expect(res.body).not.toEqual({ error: 'Invalid signature' });
    const get = await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': 'x' });
    expect(get.status).toBe(403); // the verification handshake is unchanged
  });
});

// =============================================================================================================================
describe('Stripe: the customer (tenant) of a payment', () => {
  const stripePost = (event) => request(app).post('/stripe-webhook').set('Content-Type', 'application/json').send(JSON.stringify(event));
  const succeeded = (pi) => ({ id: 'evt_x', type: 'payment_intent.succeeded', data: { object: { amount: 1050, currency: 'aud', ...pi } } });
  async function pendingOrder(workspaceId, customer, piId) {
    return Q('Order').create({ workspaceId, customer: customer._id, items: [{ productName: 'Hat', category: 'General', quantity: 1, unitPrice: 10 }], subtotal: 10, shippingCost: 0.5, total: 10.5, status: 'pending', paymentStatus: 'pending', source: 'product', stripePaymentIntentId: piId });
  }

  test('checkout creates the PaymentIntent with the customer\'s workspaceId (creation site 1) and the pending order in that workspace', async () => {
    const phone = newPhone();
    const customer = await mkCustomer(B._id, { phone, address: '1 Test St' });
    carts.set(phone, [{ name: 'Hat', priceAud: 10, pointsCost: 0, description: '' }]);
    mockStripe.created.length = 0;
    await post(payloadOf([change(messagesValue([btnReply(phone, 'checkout')]))]));
    const pi = await waitFor(() => mockStripe.created.find((p) => p.metadata && p.metadata.buyerPhone === phone));
    expect(pi).toBeTruthy();
    expect(pi.metadata.workspaceId).toBe(String(B._id));
    const order = await waitFor(async () => Q('Order').findOne({ stripePaymentIntentId: pi.id }).lean());
    expect(String(order.workspaceId)).toBe(String(B._id));
    expect(String(order.customer)).toBe(String(customer._id));
  });

  test('payment_intent.succeeded with a tenant workspaceId pays the tenant\'s order and credits the tenant\'s customer, not the same phone in the oldest workspace', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone, loyaltyPoints: 0 });
    const inHome = await mkCustomer(HOME._id, { phone, loyaltyPoints: 0 });
    const piId = `pi_tenant_${fx.uniq()}`;
    const order = await pendingOrder(B._id, inB, piId);
    const res = await stripePost(succeeded({ id: piId, metadata: { buyerPhone: phone, subtotal: '10', shippingCost: '0.5', address: 'x', workspaceId: String(B._id) } }));
    expect(res.status).toBe(200);
    const paid = await waitFor(async () => { const o = await Q('Order').findById(order._id).lean(); return o.paymentStatus === 'paid' ? o : null; });
    expect(paid).toBeTruthy();
    expect((await customerRow(inB._id)).loyaltyPoints).toBeGreaterThan(0);
    expect((await customerRow(inHome._id)).loyaltyPoints).toBe(0);
  });

  test('payment_intent.payment_failed with a tenant workspaceId fails the tenant\'s order', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone });
    const piId = `pi_fail_${fx.uniq()}`;
    const order = await pendingOrder(B._id, inB, piId);
    await stripePost({ id: 'evt_f', type: 'payment_intent.payment_failed', data: { object: { id: piId, metadata: { buyerPhone: phone, workspaceId: String(B._id) } } } });
    expect(await waitFor(async () => (await Q('Order').findById(order._id).lean()).paymentStatus === 'failed')).toBeTruthy();
  });

  test('without a workspaceId (older payments), with an unknown one, or with a malformed one: the oldest workspace, as before', async () => {
    for (const meta of [{}, { workspaceId: 'a'.repeat(24) }, { workspaceId: 'not-an-id' }, { workspaceId: '' }]) {
      const phone = newPhone();
      const inHome = await mkCustomer(HOME._id, { phone, loyaltyPoints: 0 });
      const piId = `pi_home_${fx.uniq()}`;
      const order = await pendingOrder(HOME._id, inHome, piId);
      const res = await stripePost(succeeded({ id: piId, metadata: { buyerPhone: phone, subtotal: '10', shippingCost: '0.5', address: 'x', ...meta } }));
      expect(res.status).toBe(200);
      expect(await waitFor(async () => (await Q('Order').findById(order._id).lean()).paymentStatus === 'paid')).toBeTruthy();
      expect((await customerRow(inHome._id)).loyaltyPoints).toBeGreaterThan(0);
    }
  });

  test('the confirmation message of a tenant\'s payment goes through that tenant\'s sender context', async () => {
    const phone = newPhone();
    const inB = await mkCustomer(B._id, { phone });
    const piId = `pi_ctx_${fx.uniq()}`;
    await pendingOrder(B._id, inB, piId);
    const seen = [];
    // the confirmation is sent through shared/consent.js: read the sender context there
    const spy = jest.spyOn(require('../../../shared/consent'), 'sendUtilityMessageWithConsentAsk').mockImplementation(async () => { seen.push(senderContext.currentWorkspaceId()); });
    try {
      await stripePost(succeeded({ id: piId, metadata: { buyerPhone: phone, subtotal: '10', shippingCost: '0.5', address: 'x', workspaceId: String(B._id) } }));
      expect(await waitFor(() => seen.length === 1)).toBeTruthy();
      expect(seen[0]).toBe(String(B._id));
    } finally { spy.mockRestore(); }
  });
});

// =============================================================================================================================
describe('server surface', () => {
  test('POST /send-message (an unauthenticated relay from the platform number) is gone', async () => {
    const res = await request(app).post('/send-message').send({ to: '15550990030', message: 'hello' });
    expect(res.status).toBe(404);
    await settle(200);
    expect(calls.filter((c) => /\/messages$/.test(c.url))).toHaveLength(0);
  });
  test('server.js keeps ONE sender: waPost is a thin delegate to utils/whatsapp', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'server.js'), 'utf8');
    expect(src).toMatch(/function waPost\(body\) \{\s*return require\("\.\/utils\/whatsapp"\)\.waPost\(body\);\s*\}/);
    expect(src).not.toMatch(/graph\.facebook\.com/);
    expect(src).not.toMatch(/process\.env\.WA_TOKEN/);
  });
  test('/api/platform is mounted behind login and the super-admin check (401 without a token)', async () => {
    const present = fs.existsSync(path.join(__dirname, '..', '..', '..', 'routes', 'platform.js')) && fs.existsSync(path.join(__dirname, '..', '..', '..', 'middleware', 'requireSuperAdmin.js'));
    const res = await request(app).get('/api/platform/tenants');
    if (present) expect(res.status).toBe(401); else expect(res.status).toBe(404);
  });
});
