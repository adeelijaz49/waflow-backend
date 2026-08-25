require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { authedAgent, getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const CampaignMessage = require('../models/CampaignMessage');
const ConsentEvent = require('../models/ConsentEvent');
const ops = require('../shared/operations');

const TEST_PHONE_A = '15559994001';
const TEST_PHONE_B = '15559994002';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitUntil(checkFn, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await checkFn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

describe('Bulk consent-request campaign', () => {
  let req, workspaceId;

  beforeAll(async () => {
    await connectOnce();
    req = await authedAgent(app);
    workspaceId = await getTestWorkspaceId(app);
  }, 30000);

  afterEach(async () => {
    const customers = await Customer.find({ workspaceId, phone: { $in: [TEST_PHONE_A, TEST_PHONE_B] } }).select('_id').lean();
    const ids = customers.map(c => c._id);
    await CampaignMessage.deleteMany({ customer: { $in: ids } });
    await ConsentEvent.deleteMany({ customerId: { $in: ids } });
    await Customer.deleteMany({ _id: { $in: ids } });
  });

  test('sendConsentRequests only targets not-yet-asked, non-opted-out, non-demo customers', async () => {
    const eligible = await Customer.create({ firstname: 'Eligible', lastname: 'Test', phone: TEST_PHONE_A, workspaceId });
    const alreadyAsked = await Customer.create({ firstname: 'Asked', lastname: 'Test', phone: TEST_PHONE_B, workspaceId, marketingConsentAskedAt: new Date() });

    const res = await ops.sendConsentRequests({ workspaceId, customerIds: [eligible._id, alreadyAsked._id] });
    expect(res.totalEligible).toBe(1); // only the not-yet-asked one
    expect(res.sentCount + res.errors.length).toBe(1); // attempted a real send, whichever way it landed

    // marketingConsentAskedAt/CampaignMessage are only written on a genuinely
    // successful send (same fail-open-for-retry design as
    // sendUtilityMessageWithConsentAsk) — a real send to this synthetic test
    // phone number may well fail, so only assert these on the success branch.
    const updated = await Customer.findById(eligible._id);
    const cm = await CampaignMessage.findOne({ customer: eligible._id, kind: 'consent_request' });
    if (res.sentCount === 1) {
      expect(updated.marketingConsentAskedAt).toBeTruthy();
      expect(cm).toBeTruthy();
    } else {
      expect(updated.marketingConsentAskedAt).toBeFalsy();
      expect(cm).toBeFalsy();
    }
  }, 30000);

  test('a customer who already consented or opted out is excluded even when explicitly targeted', async () => {
    const consented = await Customer.create({ firstname: 'Consented', lastname: 'Test', phone: TEST_PHONE_A, workspaceId, marketingConsent: true });
    const optedOut = await Customer.create({ firstname: 'OptedOut', lastname: 'Test', phone: TEST_PHONE_B, workspaceId, optedOut: true });

    const res = await ops.sendConsentRequests({ workspaceId, customerIds: [consented._id, optedOut._id] });
    expect(res.totalEligible).toBe(0);
    expect(res.sentCount).toBe(0);
  }, 15000);

  test('GET /api/customers/consent-stats reports eligibleForConsentRequest matching the send filter', async () => {
    const eligible = await Customer.create({ firstname: 'StatsEligible', lastname: 'Test', phone: TEST_PHONE_A, workspaceId });
    const before = await req.get('/api/customers/consent-stats');
    expect(before.body.eligibleForConsentRequest).toBeGreaterThanOrEqual(1);

    await Customer.findByIdAndUpdate(eligible._id, { marketingConsentAskedAt: new Date() });
    const after = await req.get('/api/customers/consent-stats');
    expect(after.body.eligibleForConsentRequest).toBe(before.body.eligibleForConsentRequest - 1);
  }, 15000);

  test('webhook: tapping "Yes, sign me up" on the template grants consent (type:"button" path)', async () => {
    const customer = await Customer.create({ firstname: 'Test', lastname: 'ConsentReq', phone: TEST_PHONE_A, workspaceId });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: TEST_PHONE_A, type: 'button',
          button: { payload: `consent_yes_${customer._id}` },
        }],
      } }] }],
    });

    const updated = await waitUntil(async () => {
      const doc = await Customer.findById(customer._id);
      return doc.marketingConsent ? doc : null;
    });
    expect(updated.marketingConsent).toBe(true);
    expect(updated.marketingConsentMethod).toBe('whatsapp_button');

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].source).toMatch(/bulk consent-request campaign/);
  }, 15000);

  test('webhook: tapping "No thanks" on the template declines without granting consent', async () => {
    const customer = await Customer.create({ firstname: 'Test', lastname: 'ConsentReqDecline', phone: TEST_PHONE_A, workspaceId });

    await request(app).post('/webhook').send({
      entry: [{ changes: [{ value: {
        messages: [{
          from: TEST_PHONE_A, type: 'button',
          button: { payload: `consent_no_${customer._id}` },
        }],
      } }] }],
    });

    const events = await waitUntil(async () => {
      const evs = await ConsentEvent.find({ customerId: customer._id });
      return evs.length ? evs : null;
    });
    expect(events[0].type).toBe('consent_declined');

    const doc = await Customer.findById(customer._id);
    expect(doc.marketingConsent).toBe(false);
  }, 15000);
});

describe('Manual "mark as consented" (customer detail panel)', () => {
  let req, workspaceId, customer;

  beforeAll(async () => {
    await connectOnce();
    req = await authedAgent(app);
    workspaceId = await getTestWorkspaceId(app);
  }, 30000);

  afterEach(async () => {
    if (customer) {
      await ConsentEvent.deleteMany({ customerId: customer._id });
      await Customer.findByIdAndDelete(customer._id);
      customer = null;
    }
  });

  test('POST /api/customers/:id/consent grants consent and logs a manual_staff_entry event', async () => {
    customer = await Customer.create({ firstname: 'Manual', lastname: 'ConsentTest', phone: TEST_PHONE_A, workspaceId });

    const res = await req.post(`/api/customers/${customer._id}/consent`);
    expect(res.status).toBe(200);
    expect(res.body.marketingConsent).toBe(true);
    expect(res.body.marketingConsentMethod).toBe('manual_staff_entry');

    const events = await ConsentEvent.find({ customerId: customer._id });
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('consent_given');
    expect(events[0].method).toBe('manual_staff_entry');
    expect(events[0].performedBy).toBeTruthy(); // attributed to the logged-in user, not anonymous
  }, 15000);

  test('a customer subsequently passes the marketing-send gate', async () => {
    customer = await Customer.create({ firstname: 'Manual', lastname: 'GateTest', phone: TEST_PHONE_A, workspaceId });
    await req.post(`/api/customers/${customer._id}/consent`);

    const { canSendMarketing } = require('../shared/consent');
    const updated = await Customer.findById(customer._id);
    expect(canSendMarketing(updated)).toBe(true);
  }, 15000);
});
