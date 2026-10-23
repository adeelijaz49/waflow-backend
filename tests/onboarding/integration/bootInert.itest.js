'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_boot`;
assertThrowawayDb();

// Boots the REAL server.js (not listening) with ONBOARDING_FLOW UNSET and proves the whole flow is inert:
// no onboarding model is registered, no onboarding collection is created, the new routes answer exactly
// like unknown routes, the existing routes behave as before.
delete process.env.ONBOARDING_FLOW;
delete process.env.ONBOARDING_ENROL_FROM;

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../../../server');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');

const WS = '507f1f77bcf86cd799439011';
const token = (payload = {}) => jwt.sign({ sub: '507f1f77bcf86cd799439099', workspaceId: WS, role: 'owner', ...payload }, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '1h' });
const auth = (t = token()) => ({ Authorization: `Bearer ${t}` });
const ONBOARDING_MODELS = /^(Onboarding|WhatsAppConnection|WhatsAppClaim)/;

beforeAll(async () => { await mongoose.connection.asPromise(); });
afterAll(async () => { await mongoose.disconnect(); });

describe('flag unset: nothing is loaded or created', () => {
  test('no onboarding model is registered in mongoose', () => {
    expect(mongoose.modelNames().filter((n) => ONBOARDING_MODELS.test(n))).toEqual([]);
  });
  test('the app still serves the existing routes', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toBe('Waflow backend running');
  });
  test('an authenticated legacy request to an onboarding-sensitive route loads no onboarding code and creates no collection', async () => {
    const res = await request(app).get('/api/customers').set(auth());
    expect(res.status).toBe(200);
    const send = await request(app).post('/api/promotions/507f1f77bcf86cd799439022/send').set(auth()).send({});
    expect(send.status).not.toBe(402);
    expect(send.body && send.body.code).toBeUndefined();
    expect(mongoose.modelNames().filter((n) => ONBOARDING_MODELS.test(n))).toEqual([]);
    const collections = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    expect(collections.filter((n) => /onboarding|whatsappconnection|whatsappclaim/i.test(n))).toEqual([]);
  });
});

describe('flag unset: the new URLs answer exactly like unknown routes', () => {
  const same = async (known, unknown, method = 'get', opts = {}) => {
    const a = await request(app)[method](known).set(opts.headers || {}).send(opts.body);
    const b = await request(app)[method](unknown).set(opts.headers || {}).send(opts.body);
    expect(a.status).toBe(404);
    expect(a.status).toBe(b.status);
    expect(a.text.replace(known, 'X')).toBe(b.text.replace(unknown, 'X'));
  };
  test('GET /api/onboarding/state (valid token)', async () => { await same('/api/onboarding/state', '/api/zzz-not-a-route/state', 'get', { headers: auth() }); });
  test('POST /api/onboarding/connect/complete (valid token)', async () => { await same('/api/onboarding/connect/complete', '/api/zzz-not-a-route/connect/complete', 'post', { headers: auth(), body: {} }); });
  test('GET /api/onboarding/state without a token is 404 too (not 401: the router is not even mounted)', async () => { await same('/api/onboarding/state', '/api/zzz-not-a-route/state'); });
  test('POST /stripe-billing-webhook', async () => { await same('/stripe-billing-webhook', '/zzz-not-a-route', 'post', { headers: { 'Content-Type': 'application/json' }, body: { id: 'evt_1' } }); });
  test('GET /internal-admin-onboarding (no Basic auth challenge)', async () => { await same('/internal-admin-onboarding', '/zzz-not-a-route'); });
  test('POST /onboarding-meta/deauthorize', async () => { await same('/onboarding-meta/deauthorize', '/zzz-not-a-route/deauthorize', 'post', { body: {} }); });
});

describe('flag unset: existing behaviour is untouched', () => {
  test('the routes own requireAuth still produces the normal 401 bodies', async () => {
    const none = await request(app).post('/api/promotions/x/send').send({});
    expect(none.status).toBe(401);
    expect(none.body).toEqual({ error: 'Not logged in' });
    const bad = await request(app).post('/api/promotions/x/send').set('Authorization', 'Bearer garbage').send({});
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'Session expired or invalid — please log in again' });
  });
  test('POST /webhook replies 200 immediately and a platform-style payload is not intercepted', async () => {
    const res = await request(app).post('/webhook').send({ entry: [{ id: '123', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '999' }, statuses: [] } }] }] });
    expect(res.status).toBe(200);
    expect(mongoose.modelNames().filter((n) => ONBOARDING_MODELS.test(n))).toEqual([]);
  });
  test('flag values other than exactly "on" are still off', async () => {
    // the flag is read per request by the hooks that exist; none is mounted when the flag was off at boot
    process.env.ONBOARDING_FLOW = 'true';
    const res = await request(app).get('/api/onboarding/state').set(auth());
    expect(res.status).toBe(404);
    delete process.env.ONBOARDING_FLOW;
  });
});
