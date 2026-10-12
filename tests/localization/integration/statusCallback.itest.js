'use strict';
// C3 (approved global change #3) against a REAL MongoDB: a FAILED delivery callback now stores Meta's error code on the
// CampaignMessage (errorCode, a String) next to the existing statusReason. Drives the real webhook (axios stubbed) and the
// readers: shared/localization/statusErrors.js and the Arabic campaign recipients view. Always a FRESH database name per run.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const request = require('supertest');
const axios = require('axios');
const mongoose = require('mongoose');

jest.mock('stripe', () => () => ({ paymentIntents: { create: async () => ({ id: 'pi_stub_1' }) }, webhooks: { constructEvent: () => { throw new Error('stub'); } } }));
jest.setTimeout(300000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const Q = (m) => require(`../../../models/${m}`);

let calls = [];
axios.defaults.adapter = async (config) => {
  calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || '') });
  return { data: { messages: [{ id: 'wamid.STUB' }] }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

let app; let W; let seq = 0;
const statusPayload = (statuses) => ({ object: 'whatsapp_business_account', entry: [{ id: '2', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '1' }, statuses } }] }] });
async function postStatus(statuses) {
  await request(app).post('/webhook').send(statusPayload(statuses));
  await sleep(700);
}
let customer;
const mkCm = async (extra) => {
  seq += 1;
  return Q('CampaignMessage').create({ kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: `wamid.SC${seq}`, messageType: 'interactive', status: 'sent', sentAt: new Date(), workspaceId: W, ...(extra || {}) });
};
const raw = (id) => Q('CampaignMessage').collection.findOne({ _id: id });

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  app = require('../../../server');
  await new Promise((resolve, reject) => { const t0 = Date.now(); const poll = () => (mongoose.connection.readyState === 1 ? resolve() : (Date.now() - t0 > 20000 ? reject(new Error('mongo not connected')) : setTimeout(poll, 100))); poll(); });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => {})));
  const db = mongoose.connection.db;
  if ((await db.collection('customers').countDocuments()) || (await db.collection('workspaces').countDocuments())) throw new Error('database is not fresh: use a new --db name for every run of statusCallback.itest.js');
  W = (await Q('Workspace').create({ name: 'Status Fixture (oldest = webhook workspace)' }))._id;
  customer = await Q('Customer').create({ firstname: 'Sara', lastname: 'S', phone: '966500099001', workspaceId: W, marketingConsent: true });
});
afterAll(async () => { jest.restoreAllMocks(); });

describe('handleStatusCallbacks stores the Meta error code (C3)', () => {
  test('failed with a numeric code: errorCode is the String, statusReason is unchanged', async () => {
    const cm = await mkCm();
    await postStatus([{ id: cm.wamid, status: 'failed', timestamp: '1760000100', recipient_id: customer.phone, errors: [{ code: 131049, title: 'Message not delivered to maintain ecosystem engagement' }] }]);
    const row = await raw(cm._id);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('131049');
    expect(typeof row.errorCode).toBe('string');
    expect(row.statusReason).toBe('Message not delivered to maintain ecosystem engagement');
  });
  test('the title falls back to message; a string code is kept; the code is capped at 20 characters', async () => {
    const a = await mkCm(); const b = await mkCm();
    await postStatus([
      { id: a.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: '132001', message: 'Template does not exist' }] },
      { id: b.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: '1'.repeat(40), title: 'weird' }] },
    ]);
    expect(await raw(a._id)).toMatchObject({ status: 'failed', errorCode: '132001', statusReason: 'Template does not exist' });
    expect((await raw(b._id)).errorCode).toBe('1'.repeat(20));
  });
  test('failed WITHOUT an error code (or without errors): no errorCode key at all, exactly as before', async () => {
    const a = await mkCm(); const b = await mkCm();
    await postStatus([{ id: a.wamid, status: 'failed', timestamp: '1760000100', errors: [{ title: 'No code here' }] }, { id: b.wamid, status: 'failed', timestamp: '1760000100' }]);
    const ra = await raw(a._id); const rb = await raw(b._id);
    expect(ra.status).toBe('failed'); expect(rb.status).toBe('failed');
    expect('errorCode' in ra).toBe(false);
    expect('errorCode' in rb).toBe(false);
    expect(ra.statusReason).toBe('No code here');
  });
  test('sent / delivered / read never write an error code, even when Meta attaches errors', async () => {
    const cm = await mkCm();
    await postStatus([{ id: cm.wamid, status: 'delivered', timestamp: '1760000100', errors: [{ code: 131049, title: 'x' }] }]);
    await postStatus([{ id: cm.wamid, status: 'read', timestamp: '1760000200' }]);
    const row = await raw(cm._id);
    expect(row.status).toBe('read');
    expect('errorCode' in row).toBe(false);
  });
  test('an unknown wamid changes nothing and does not throw', async () => {
    const before = await Q('CampaignMessage').countDocuments();
    await postStatus([{ id: 'wamid.NOPE', status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'x' }] }]);
    expect(await Q('CampaignMessage').countDocuments()).toBe(before);
  });
  test('the callback sends nothing to WhatsApp', async () => {
    calls = [];
    const cm = await mkCm();
    await postStatus([{ id: cm.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'x' }] }]);
    expect(calls.filter((c) => /\/messages$/.test(c.url))).toHaveLength(0);
  });
});

describe('readers', () => {
  const statusErrors = require('../../../shared/localization/statusErrors');
  test('getMessageErrors is workspace scoped and returns code + reason', async () => {
    const W2 = (await Q('Workspace').create({ name: 'Other tenant' }))._id;
    const mine = await mkCm();
    await postStatus([{ id: mine.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'limit' }] }]);
    const theirs = await Q('CampaignMessage').create({ kind: 'promotion', customer: customer._id, phone: customer.phone, wamid: 'wamid.THEIRS', workspaceId: W2, status: 'failed', statusReason: 'secret' });
    const map = await statusErrors.getMessageErrors(W, [mine.wamid, theirs.wamid, 'wamid.none']);
    expect([...map.keys()]).toEqual([mine.wamid]);
    expect(map.get(mine.wamid)).toEqual({ status: 'failed', errorCode: '131049', statusReason: 'limit' });
    expect(statusErrors.describeMetaError(map.get(mine.wamid).errorCode)).toEqual({ group: 'marketing_limit', retryable: true });
  });

  test('the Arabic campaign recipients view shows the Meta code and reason of a delivery that came back failed', async () => {
    const campaigns = require('../../../shared/localization/campaigns');
    const campaign = await Q('LocalizedCampaign').create({ workspaceId: W, name: 'C3 campaign', templateId: new mongoose.Types.ObjectId(), status: 'sent', category: 'MARKETING' });
    const ok = await mkCm(); const bad = await mkCm();
    await postStatus([
      { id: ok.wamid, status: 'delivered', timestamp: '1760000100' },
      { id: bad.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'Per-user marketing limit' }] },
    ]);
    const c2 = await Q('Customer').create({ firstname: 'Noor', lastname: 'N', phone: '966500099002', workspaceId: W, marketingConsent: true });
    await Q('LocalizedSend').create({ workspaceId: W, campaignId: campaign._id, customerId: customer._id, phone: customer.phone, status: 'sent', usedLanguage: 'ar', wamid: bad.wamid });
    await Q('LocalizedSend').create({ workspaceId: W, campaignId: campaign._id, customerId: c2._id, phone: c2.phone, status: 'sent', usedLanguage: 'ar', wamid: ok.wamid });
    const out = await campaigns.recipients({ workspaceId: W, id: String(campaign._id), query: {} });
    const byPhone = Object.fromEntries(out.items.map((i) => [i.phone, i]));
    expect(byPhone[customer.phone]).toMatchObject({ deliveryStatus: 'failed', errorCode: '131049', error: 'Per-user marketing limit' });
    expect(byPhone[c2.phone]).toMatchObject({ deliveryStatus: 'delivered', errorCode: null, error: null });
  });

  test('a stale code on a row that later became read is not shown as an error', async () => {
    const campaigns = require('../../../shared/localization/campaigns');
    const campaign = await Q('LocalizedCampaign').create({ workspaceId: W, name: 'C3 stale', templateId: new mongoose.Types.ObjectId(), status: 'sent', category: 'MARKETING' });
    const cm = await mkCm();
    await postStatus([{ id: cm.wamid, status: 'failed', timestamp: '1760000100', errors: [{ code: 131049, title: 'limit' }] }]);
    await postStatus([{ id: cm.wamid, status: 'read', timestamp: '1760000200' }]);
    const row = await raw(cm._id);
    expect(row.status).toBe('read');
    expect(row.errorCode).toBe('131049'); // same as the pre-existing stale statusReason
    await Q('LocalizedSend').create({ workspaceId: W, campaignId: campaign._id, customerId: customer._id, phone: customer.phone, status: 'sent', usedLanguage: 'ar', wamid: cm.wamid });
    const out = await campaigns.recipients({ workspaceId: W, id: String(campaign._id), query: {} });
    expect(out.items[0]).toMatchObject({ deliveryStatus: 'read', errorCode: null, error: null });
  });
});
