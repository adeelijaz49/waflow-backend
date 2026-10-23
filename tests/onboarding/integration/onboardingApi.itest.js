'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_api`;
assertThrowawayDb();

// B1-a: /state, PUT /business, the number routes, the prompts, help-context and preferences against a REAL
// (throwaway) mongod: the real sub-routers behind the real default gates of routes/onboarding/index.js on a mini
// app (req.user injected), plus a pass through the real server.js mount with signed tokens.
process.env.ONBOARDING_FLOW = 'on';
delete process.env.ONBOARDING_ENROL_FROM;
delete process.env.ONBOARDING_LEGACY_SEND_POLICY;
delete process.env.ONBOARDING_UNLOCK_AT;
process.env.ONBOARDING_SUPPORT_EMAIL = 'support@waflow.test';

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../../../server');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
const onboardingRouter = require('../../../routes/onboarding');
const state = require('../../../shared/onboarding/state');
const steps = require('../../../shared/onboarding/steps');
const Workspace = require('../../../models/Workspace');
const OnboardingState = require('../../../models/OnboardingState');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');
const OnboardingSupportRequest = require('../../../models/OnboardingSupportRequest');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const Membership = require('../../../models/Membership');
const Customer = require('../../../models/Customer');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');

const noTrack = { track: async () => {} };
const newId = () => String(new mongoose.Types.ObjectId());
const oid = (s) => new mongoose.Types.ObjectId(s);
const sign = (payload) => jwt.sign(payload, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE, expiresIn: '1h' });
const bearer = (u) => ({ Authorization: `Bearer ${sign({ sub: u.id, workspaceId: u.ws, role: u.role })}` });
const asUser = (u) => ({ 'x-test-user': JSON.stringify({ id: u.id, workspaceId: u.ws, role: u.role }) });

const mail = { sendSupportEmail: jest.fn(async () => ({ sent: true })) };
let mini;
let oldest;
let counter = 0;

async function makeWorkspace(name) {
  counter += 1;
  const createdAt = new Date(Date.UTC(2026, 9, 10, 0, counter));
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed: false, currentStep: 1 } });
  return String(res.insertedId);
}
/** A fresh enrolled workspace with an owner and a member (no data yet, so enrolment needs no confirmation). */
async function newTenant({ activate = true, name = 'Tenant' } = {}) {
  const ws = await makeWorkspace(`${name} ${counter + 1}`);
  const owner = { id: newId(), ws, role: 'owner' };
  const member = { id: newId(), ws, role: 'member' };
  await Membership.create([{ userId: owner.id, workspaceId: ws, role: 'owner' }, { userId: member.id, workspaceId: ws, role: 'member' }]);
  await state.enrol({ workspaceId: ws, by: 'cli:test' }, noTrack);
  if (activate) await state.adminActivate({ workspaceId: ws, by: 'cli:test', notes: 'itest' }, noTrack);
  return { ws, owner, member };
}
async function setStripe(ws, rawStatus) {
  await OnboardingState.updateOne({ workspaceId: ws }, { $set: { 'subscription.stripe.status': rawStatus } });
  await state.recomputeSubscription(ws, {}, noTrack);
  state.clearCache();
}
const rowOf = (ws) => OnboardingState.findOne({ workspaceId: ws }).lean();
const api = (who, method, path, body) => {
  let r = request(mini)[method](`/api/onboarding${path}`).set(asUser(who));
  if (method !== 'get') r = r.send(body === undefined ? {} : body);
  return r;
};
const real = (who, method, path, body) => {
  let r = request(app)[method](`/api/onboarding${path}`).set(bearer(who));
  if (method !== 'get') r = r.send(body === undefined ? {} : body);
  return r;
};
const FULL = { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty' };

beforeAll(async () => {
  await mongoose.connection.asPromise();
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), OnboardingSupportRequest.init(), OnboardingNotification.init(), Membership.init(), OnboardingEvent.init()]);
  const created = new Date('2026-01-01T00:00:00Z');
  oldest = String((await Workspace.collection.insertOne({ name: 'Owner workspace', createdAt: created, updatedAt: created, onboarding: { completed: true, currentStep: 1 } })).insertedId);
  mini = express();
  mini.use(express.json());
  mini.use((req, res, next) => { req.user = JSON.parse(req.get('x-test-user') || '{}'); next(); });
  mini.use('/api/onboarding', onboardingRouter.createRouter({ routers: { number: { email: mail }, state: { email: mail } } }));
});
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); mail.sendSupportEmail.mockClear(); });

describe('GET /state for every subscription state', () => {
  test('legacy workspace (no sidecar): 200 { enrolled:false } and nothing is created', async () => {
    const ws = await makeWorkspace('Legacy');
    const who = { id: newId(), ws, role: 'owner' };
    const before = await OnboardingState.countDocuments({});
    const res = await api(who, 'get', '/state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: false });
    expect(await OnboardingState.countDocuments({})).toBe(before);
    expect(await WhatsAppConnection.countDocuments({ workspaceId: ws })).toBe(0);
    const viaServer = await real(who, 'get', '/state');
    expect(viaServer.body).toEqual({ enrolled: false });
  });

  test('none and pending: the billing subset only (no steps, business or connection)', async () => {
    const t = await newTenant({ activate: false });
    let res = await api(t.owner, 'get', '/state');
    expect(res.status).toBe(200);
    expect(res.body.view).toBe('billing');
    expect(res.body.subscription).toEqual({ state: 'none', source: null, retry: { checkout: true, billingPortal: false, reconnect: false } });
    expect(Object.keys(res.body).sort()).toEqual(['checkedAt', 'checkout', 'enrolled', 'locked', 'notifications', 'subscription', 'view']);
    expect(res.body.locked).toBe(true);
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { prefill: { businessName: 'Acme', email: 'a@acme.test', planCode: 'basic' } } });
    await setStripe(t.ws, 'incomplete');
    res = await api(t.owner, 'get', '/state');
    expect(res.body.view).toBe('billing');
    expect(res.body.subscription.state).toBe('pending');
    expect(res.body.prefill).toEqual({ businessName: 'Acme', email: 'a@acme.test', planCode: 'basic' });
    expect(res.body.steps).toBeUndefined();
    expect(res.body.connection).toBeUndefined();
  });

  test('active: the full state, locked until step 3 is done', async () => {
    const t = await newTenant();
    const res = await api(t.owner, 'get', '/state');
    expect(res.body).toMatchObject({
      enrolled: true, view: 'setup', locked: true, unlockAt: 'connected', nextStep: 'business', currentStep: 'business',
      subscription: { state: 'active', source: 'admin' },
      progress: { completedAt: null, status: 'in_progress' },
      prompts: { customers: { state: 'pending' }, products: { state: 'pending' }, counts: { customers: 0, products: 0, services: 0 } },
      sendingPaused: { code: 'WHATSAPP_NOT_CONNECTED' }, notifications: { unread: 0 }, lastError: null, prefill: null,
      connection: { level: null, status: 'not_connected', numberMasked: null, numberFull: null },
    });
    expect(res.body.business.industryOptions).toEqual(steps.INDUSTRY_KEYS);
    expect(res.body.business.country).toBe('SA');
    expect(Object.keys(res.body.steps)).toEqual(['business', 'number', 'connect', 'approvals', 'promotion']);
    expect(typeof res.body.checkedAt).toBe('string');
  });

  test('past_due and cancelled: the FULL state (progress readable), writes refused with 402', async () => {
    for (const [raw, expected, code] of [['past_due', 'past_due', 'PAYMENT_PAST_DUE'], ['canceled', 'cancelled', 'SUBSCRIPTION_CANCELLED']]) {
      const t = await newTenant({ activate: false });
      await setStripe(t.ws, 'active'); // pay first (Stripe-sourced), do step 1, then the payment fails
      await api(t.owner, 'put', '/business', FULL);
      await setStripe(t.ws, raw);
      const res = await api(t.owner, 'get', '/state');
      expect(res.status).toBe(200);
      expect(res.body.subscription.state).toBe(expected);
      expect(res.body.view).toBe('setup');
      expect(res.body.steps.business.status).toBe('done');
      expect(res.body.business.name).toBe('Rose Salon');
      expect(res.body.nextStep).toBe('number');
      expect(res.body.sendingPaused).toEqual({ code });
      const refused = await api(t.owner, 'put', '/business', { name: 'Changed Name' });
      expect(refused.status).toBe(402);
      expect(refused.body.code).toBe(code);
      expect((await rowOf(t.ws)).business.name).toBe('Rose Salon');
      for (const [m, p, b] of [['post', '/number/path', { hasNumber: false }], ['post', '/number/ready', {}], ['post', '/prompts/customers', { state: 'skipped' }], ['post', '/preferences', { uiLanguage: 'ar' }], ['post', '/number/support-request', {}]]) {
        const r = await api(t.owner, m, p, b);
        expect(r.status).toBe(402);
        expect(r.body.code).toBe(code);
      }
      // help-context is billing-exempt: still answers
      expect((await api(t.owner, 'get', '/help-context')).status).toBe(200);
      // BF1: so are the bell and the analytics beacons (gate E): the payment problem stays visible, the progress stays readable
      const bell = await api(t.owner, 'get', '/notifications');
      expect(bell.status).toBe(200);
      expect(Array.isArray(bell.body.notifications)).toBe(true);
      expect((await api(t.owner, 'post', '/notifications/read', { all: true })).status).toBe(200);
      expect((await api(t.owner, 'post', '/events', { type: 'help_opened', step: 'billing' })).status).toBe(204);
    }
  });

  test('reactivation resumes exactly where the merchant was (the state document is never reset)', async () => {
    const t = await newTenant({ activate: false });
    await setStripe(t.ws, 'active');
    await api(t.owner, 'put', '/business', FULL);
    await setStripe(t.ws, 'past_due');
    await setStripe(t.ws, 'active');
    const res = await api(t.owner, 'get', '/state');
    expect(res.body.subscription.state).toBe('active');
    expect(res.body.steps.business.status).toBe('done');
    expect(res.body.nextStep).toBe('number');
  });

  test('every request reads fresh: a change made behind the cache shows at once', async () => {
    const t = await newTenant();
    await api(t.owner, 'get', '/state'); // warms the 30 s gate cache
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'subscription.admin.active': false } });
    await state.recomputeSubscription(t.ws, {}, noTrack); // invalidates; now 'none'
    const res = await api(t.owner, 'get', '/state');
    expect(res.body.view).toBe('billing');
  });
});

describe('the whole journey, and resuming it from a second token', () => {
  test('business -> number -> connect -> approvals -> prompts -> promotion -> done', async () => {
    const t = await newTenant();
    let res = await api(t.owner, 'put', '/business', { ...FULL, website: 'https://rose.example.com', instagram: '@rose', contactEmail: 'o@rose.test' });
    expect(res.status).toBe(200);
    expect(res.body.nextStep).toBe('number');
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    expect(res.body.nextStep).toBe('connect');
    // step 3 is owned by B1-c: simulate its result with the contract call + a connection row
    await WhatsAppConnection.create({ workspaceId: t.ws, status: 'connected', display: { displayPhoneNumber: '+966501234567', last4: '4567', verifiedName: 'Rose Salon' } });
    await steps.markStep(t.ws, 'connect', 'done');
    res = await api(t.owner, 'get', '/state');
    expect(res.body).toMatchObject({ locked: false, nextStep: 'approvals', currentStep: 'approvals', view: 'setup' });
    expect(res.body.connection).toMatchObject({ level: expect.any(String), numberMasked: '********4567', numberFull: '+966501234567', verifiedName: 'Rose Salon' });
    await Customer.collection.insertOne({ workspaceId: oid(t.ws), firstname: 'A', lastname: 'B', phone: '966500000001' });
    res = await api(t.owner, 'post', '/prompts/customers', { state: 'done' });
    expect(res.body).toMatchObject({ kind: 'customers', state: 'done', nextStep: 'products' });
    expect((await rowOf(t.ws)).steps.approvals.status).toBe('in_progress');
    res = await api(t.owner, 'post', '/prompts/products', { state: 'skipped' });
    expect(res.body.nextStep).toBe('promotion');
    await steps.markStep(t.ws, 'promotion', 'skipped');

    // resume from another device / token: the other member of the same workspace sees the same progress
    const second = await real(t.member, 'get', '/state');
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ view: 'done', nextStep: null, locked: false, subscription: { state: 'active' }, steps: { business: { status: 'done' }, number: { status: 'done' }, connect: { status: 'done' }, promotion: { status: 'skipped' } } });
    expect(second.body.progress.completedAt).toEqual(expect.any(String));
    expect(second.body.prompts.customers.state).toBe('done');
    expect(second.body.prompts.products.state).toBe('skipped'); // the reminder stays visible
    expect(second.body.prompts.counts.customers).toBe(1);
    expect('numberFull' in second.body.connection).toBe(false);
    const first = await real(t.owner, 'get', '/state');
    const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.connection.numberFull; delete c.checkedAt; return c; };
    expect(strip(first.body)).toEqual(strip(second.body));
    expect((await state.getGateState(t.ws, { fresh: true })).completed).toBe(true);
  });

  test('re-entering after a connection breaks: nextStep goes back to connect, the progress stays', async () => {
    const t = await newTenant();
    await api(t.owner, 'put', '/business', FULL);
    await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    await WhatsAppConnection.create({ workspaceId: t.ws, status: 'connected' });
    await steps.markStep(t.ws, 'connect', 'done');
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { status: 'reconnect_required', needsReconnect: true } });
    state.clearCache();
    const res = await api(t.owner, 'get', '/state');
    expect(res.body.nextStep).toBe('connect');
    expect(res.body.connection.level).toBe('reconnect_needed');
    expect(res.body.steps.connect.status).toBe('done');
    expect(res.body.sendingPaused).toEqual({ code: 'WHATSAPP_RECONNECT_REQUIRED' });
  });
});

describe('PUT /business against the real database', () => {
  test('stores the answers, is idempotent, and records a skipped CR', async () => {
    const t = await newTenant();
    const body = { ...FULL, crSkipped: true, languages: ['en', 'ar'], uiLanguage: 'ar' };
    const first = await api(t.owner, 'put', '/business', body);
    expect(first.status).toBe(200);
    const doc = await rowOf(t.ws);
    expect(doc.business).toMatchObject({ name: 'Rose Salon', country: 'SA', industry: 'salon_beauty', crSkipped: true, verificationNeedsCr: true, uiLanguage: 'ar', languages: ['en', 'ar'] });
    expect(doc.business.crSkippedAt).toBeInstanceOf(Date);
    expect(doc.steps.business.status).toBe('done');
    expect(doc.progress.currentStep).toBe(2);
    const second = await api(t.owner, 'put', '/business', body);
    expect(second.status).toBe(200);
    const doc2 = await rowOf(t.ws);
    expect(doc2.updatedAt).toEqual(doc.updatedAt); // nothing was written
    expect(JSON.stringify(doc2)).toBe(JSON.stringify(doc));
    expect(await OnboardingEvent.countDocuments({ workspaceId: t.ws, type: 'step_skip', reason: 'cr_skipped' })).toBe(1);
    expect(await OnboardingEvent.countDocuments({ workspaceId: t.ws, type: 'step_complete', step: 'business' })).toBe(1);
  });
  test('validation: 422 with the field list; a member may also fill steps 1-2', async () => {
    const t = await newTenant();
    const bad = await api(t.owner, 'put', '/business', { name: 'x', country: 'ZZ' });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', details: { fields: { name: 'LENGTH', country: 'INVALID' } } });
    expect((await api(t.member, 'put', '/business', FULL)).status).toBe(200);
    expect((await api(t.member, 'post', '/number/path', { hasNumber: false })).status).toBe(200);
  });
  test('Workspace.name is never used or changed', async () => {
    const t = await newTenant({ name: 'Secret Workspace Name' });
    const before = (await Workspace.findById(t.ws).lean()).name;
    const res = await api(t.owner, 'put', '/business', FULL);
    const help = await api(t.owner, 'get', '/help-context');
    expect(JSON.stringify([res.body, help.body])).not.toContain('Secret Workspace Name');
    expect((await Workspace.findById(t.ws).lean()).name).toBe(before);
    const fresh = await newTenant({ name: 'Another Hidden Name' });
    const h2 = await api(fresh.owner, 'get', '/help-context');
    expect(h2.body.businessName).toBeNull();
    expect(JSON.stringify(h2.body)).not.toContain('Another Hidden Name');
  });
});

describe('Step 2: Path A (four branches) and Path B (pause / resume)', () => {
  test('Path A: not on WhatsApp / personal (needs acknowledgement) / WhatsApp Business app / landline', async () => {
    const t = await newTenant();
    // not used on WhatsApp
    let res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('A');
    // personal: acknowledgement required
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'personal' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NUMBER_PERSONAL_WARNING_REQUIRED');
    expect((await rowOf(t.ws)).number.usage).toBe('unused'); // refused: unchanged
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'personal', acknowledgeRemoval: true });
    expect(res.status).toBe(200);
    expect((await rowOf(t.ws)).number).toMatchObject({ path: 'A', usage: 'personal', personalWarningAcknowledged: true });
    // business app: a choice is needed; coexistence is never promised
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'business_app' });
    expect(res.status).toBe(422);
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'coexistence' });
    expect(res.body.guidance.coexistence).toBe('maybe_available');
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'migrate' });
    expect(res.body.guidance.coexistence).toBe('unknown');
    // landline
    res = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'landline' });
    expect(res.body.guidance.callRequired).toBe(true);
    const doc = await rowOf(t.ws);
    expect(doc.number).toMatchObject({ path: 'A', usage: 'landline', personalWarningAcknowledged: false, businessAppChoice: null });
    expect(doc.steps.number.status).toBe('done');
  });
  test('Path B: pause, reminders fields, then "I\'ve got my number" resumes; a business-app "different number" also pauses', async () => {
    const t = await newTenant();
    await api(t.owner, 'put', '/business', FULL);
    let res = await api(t.owner, 'post', '/number/path', { hasNumber: false });
    expect(res.body).toMatchObject({ path: 'B', nextStep: 'number' });
    let doc = await rowOf(t.ws);
    expect(doc.progress.status).toBe('paused_number');
    expect(doc.number.pausedAt).toBeInstanceOf(Date);
    expect(doc.number.reminderCount).toBe(0);
    let st = await api(t.owner, 'get', '/state');
    expect(st.body.number).toMatchObject({ path: 'B', paused: true, numberReady: false });
    expect(st.body.nextStep).toBe('number');
    expect(st.body.progress.status).toBe('paused_number');
    res = await api(t.owner, 'post', '/number/ready');
    expect(res.body).toEqual({ path: 'B', numberReady: true, nextStep: 'connect' });
    doc = await rowOf(t.ws);
    expect(doc.progress.status).toBe('in_progress');
    expect(doc.steps.number.status).toBe('done');
    st = await api(t.owner, 'get', '/state');
    expect(st.body.number).toMatchObject({ paused: false, numberReady: true });

    const t2 = await newTenant();
    res = await api(t2.owner, 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'different_number' });
    expect(res.body.path).toBe('B');
    expect((await rowOf(t2.ws)).progress.status).toBe('paused_number');
  });
  test('idempotent repeats leave the document untouched (Path A and Path B, and /number/ready)', async () => {
    const t = await newTenant();
    for (const body of [{ hasNumber: true, usage: 'landline' }, { hasNumber: false }]) {
      await api(t.owner, 'post', '/number/path', body);
      const a = await rowOf(t.ws);
      const evs = await OnboardingEvent.countDocuments({ workspaceId: t.ws });
      const res = await api(t.owner, 'post', '/number/path', body);
      expect(res.status).toBe(200);
      const b = await rowOf(t.ws);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(await OnboardingEvent.countDocuments({ workspaceId: t.ws })).toBe(evs);
    }
    await api(t.owner, 'post', '/number/ready');
    const a = await rowOf(t.ws);
    await api(t.owner, 'post', '/number/ready');
    expect(JSON.stringify(await rowOf(t.ws))).toBe(JSON.stringify(a));
  });
  test('after the connection exists: 409 NUMBER_ALREADY_CONNECTED for a change, a no-op for the same answer', async () => {
    const t = await newTenant();
    await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    await WhatsAppConnection.create({ workspaceId: t.ws, status: 'connected' });
    state.clearCache();
    const before = await rowOf(t.ws);
    const changed = await api(t.owner, 'post', '/number/path', { hasNumber: false });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'NUMBER_ALREADY_CONNECTED', nextStep: 'connect' });
    const same = await api(t.owner, 'post', '/number/path', { hasNumber: true, usage: 'unused' });
    expect(same.status).toBe(200);
    expect(JSON.stringify(await rowOf(t.ws))).toBe(JSON.stringify(before));
    // when the connection is gone again (step 3 back to todo, disconnected) the answers can change
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { status: 'disconnected' } });
    expect((await api(t.owner, 'post', '/number/path', { hasNumber: false })).status).toBe(200);
  });
});

describe('support request for a number', () => {
  test('creates the request, e-mails support, notifies in the app; de-duplicates within 10 minutes; never buys a number', async () => {
    const t = await newTenant();
    await api(t.owner, 'put', '/business', FULL);
    const first = await api(t.owner, 'post', '/number/support-request', { message: 'I need help choosing a SIM' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, duplicate: false });
    const rows = await OnboardingSupportRequest.find({ workspaceId: t.ws }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'number_help', step: 'number', businessName: 'Rose Salon', status: 'open', message: 'I need help choosing a SIM' });
    expect(String(rows[0].userId)).toBe(t.owner.id);
    expect(rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(mail.sendSupportEmail).toHaveBeenCalledTimes(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'help_received' })).toBe(1);
    expect((await rowOf(t.ws)).number.helpRequestId).toBe(String(rows[0]._id));
    const second = await api(t.owner, 'post', '/number/support-request', { message: 'again' });
    expect(second.body).toEqual({ ok: true, duplicate: true, requestId: first.body.requestId });
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: t.ws })).toBe(1);
    expect(mail.sendSupportEmail).toHaveBeenCalledTimes(1);
    // no phone number in the mail (the object ids are hex and may contain long digit runs by chance: take them out first)
    expect(JSON.stringify(mail.sendSupportEmail.mock.calls[0][0]).replace(/[0-9a-f]{24}/gi, 'ID')).not.toMatch(/\d{9,}/);
  });
  test('a failing e-mail does not fail the request (a short code is stored)', async () => {
    const t = await newTenant();
    mail.sendSupportEmail.mockRejectedValueOnce(Object.assign(new Error('provider body with secrets'), { statusCode: 503 }));
    const res = await api(t.owner, 'post', '/number/support-request', {});
    expect(res.status).toBe(200);
    const row = await OnboardingSupportRequest.findOne({ workspaceId: t.ws }).lean();
    expect(row.emailError).toBe('HTTP_503');
    expect(row.emailSentAt).toBeUndefined();
  });
  test('50 simultaneous requests of one workspace create ONE row, send ONE e-mail and make ONE notification (unique window index, review R7-05)', async () => {
    const t = await newTenant();
    await api(t.owner, 'put', '/business', FULL);
    const support = require('../../../shared/onboarding/support');
    const results = await Promise.all(Array.from({ length: 50 }, () => support.createSupportRequest({ workspaceId: t.ws, userId: t.owner.id, kind: 'number_help', step: 'number', message: 'help' }, { email: mail })));
    expect(results.filter((r) => r.duplicate === false)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate === true)).toHaveLength(49);
    expect(new Set(results.map((r) => r.request.id)).size).toBe(1); // everybody is answered with the winner's row
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: t.ws })).toBe(1);
    expect(mail.sendSupportEmail).toHaveBeenCalledTimes(1);
    expect(await OnboardingNotification.countDocuments({ workspaceId: t.ws, kind: 'help_received' })).toBe(1);
    const row = await OnboardingSupportRequest.findOne({ workspaceId: t.ws }).lean();
    expect(row.windowKey).toMatch(/^\d+$/);
    // the unique index is what makes it atomic: a second row for the same workspace, kind and window is refused by the database
    await expect(OnboardingSupportRequest.collection.insertOne({ workspaceId: oid(t.ws), kind: 'number_help', status: 'open', windowKey: row.windowKey, createdAt: new Date(), updatedAt: new Date() }))
      .rejects.toMatchObject({ code: 11000 });
    // another kind in the same window is another row; another workspace is unaffected
    const other = await support.createSupportRequest({ workspaceId: t.ws, userId: t.owner.id, kind: 'help', message: 'other' }, { email: mail });
    expect(other.duplicate).toBe(false);
    const stranger = await newTenant();
    expect((await support.createSupportRequest({ workspaceId: stranger.ws, userId: stranger.owner.id, kind: 'number_help' }, { email: mail })).duplicate).toBe(false);
    expect(mail.sendSupportEmail).toHaveBeenCalledTimes(3);
  });
  test('the route: a burst of 12 requests is cut at 10 per 10 minutes (in memory, per user) and the 10 that get through make ONE row', async () => {
    const t = await newTenant();
    const res = await Promise.all(Array.from({ length: 12 }, () => api(t.owner, 'post', '/number/support-request', { message: 'burst' })));
    const ok = res.filter((r) => r.status === 200);
    const limited = res.filter((r) => r.status === 429);
    expect(ok).toHaveLength(10);
    expect(limited).toHaveLength(2);
    limited.forEach((r) => { expect(r.body.code).toBe('RATE_LIMITED'); expect(Number(r.headers['retry-after'])).toBeGreaterThan(0); });
    expect(ok.filter((r) => r.body.duplicate === false)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.body.requestId)).size).toBe(1);
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: t.ws })).toBe(1);
    expect(mail.sendSupportEmail).toHaveBeenCalledTimes(1);
  });
  test('3 per day (counted in the database), old requests leave the window', async () => {
    const t = await newTenant();
    const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);
    await OnboardingSupportRequest.collection.insertMany([2, 5, 9].map((h) => ({ workspaceId: oid(t.ws), kind: 'number_help', status: 'open', windowKey: 'seed-' + h, createdAt: hoursAgo(h), updatedAt: hoursAgo(h) })));
    const res = await api(t.owner, 'post', '/number/support-request', {});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(14 * 3600 - 120);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(15 * 3600);
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: t.ws })).toBe(3);
    // the same history, but the oldest is more than a day old: allowed again
    const t2 = await newTenant();
    await OnboardingSupportRequest.collection.insertMany([2, 5, 25].map((h) => ({ workspaceId: oid(t2.ws), kind: 'number_help', status: 'open', windowKey: 'seed-' + h, createdAt: hoursAgo(h), updatedAt: hoursAgo(h) })));
    expect((await api(t2.owner, 'post', '/number/support-request', {})).status).toBe(200);
    // another workspace's requests never count
    expect((await api((await newTenant()).owner, 'post', '/number/support-request', {})).status).toBe(200);
  });
});

describe('prompts (customers / products)', () => {
  test('skipped always; done only with real, workspace-scoped data', async () => {
    const t = await newTenant();
    const other = await newTenant();
    await Customer.collection.insertOne({ workspaceId: oid(other.ws), firstname: 'X', lastname: 'Y', phone: '966500000009' });
    await Product.collection.insertOne({ workspaceId: oid(other.ws), name: 'Theirs', category: 'c', basePrice: 1 });
    let res = await api(t.owner, 'post', '/prompts/customers', { state: 'done' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    res = await api(t.owner, 'post', '/prompts/products', { state: 'done' });
    expect(res.status).toBe(422);
    expect((await rowOf(t.ws)).prompts.customers.state).toBe('pending');
    res = await api(t.owner, 'post', '/prompts/customers', { state: 'skipped' });
    expect(res.status).toBe(200);
    expect(res.body.prompts.customers.state).toBe('skipped');
    await Customer.collection.insertOne({ workspaceId: oid(t.ws), firstname: 'A', lastname: 'B', phone: '966500000001' });
    expect((await api(t.owner, 'post', '/prompts/customers', { state: 'done' })).status).toBe(200);
    await Service.collection.insertOne({ workspaceId: oid(t.ws), name: 'Haircut' });
    expect((await api(t.owner, 'post', '/prompts/products', { state: 'done' })).status).toBe(200);
    const doc = await rowOf(t.ws);
    expect(doc.prompts).toMatchObject({ customers: { state: 'done' }, products: { state: 'done' } });
    expect(doc.prompts.promptedAt).toBeInstanceOf(Date);
    const st = await api(t.owner, 'get', '/state');
    expect(st.body.prompts.counts).toEqual({ customers: 1, products: 0, services: 1 });
    expect((await api(t.owner, 'post', '/prompts/customers', { state: 'pending' })).status).toBe(422);
  });
});

describe('tenant isolation', () => {
  test('B cannot read or change A; workspaceId / userId in the body or query are ignored', async () => {
    const a = await newTenant();
    const b = await newTenant();
    await api(a.owner, 'put', '/business', { ...FULL, name: 'Tenant A Shop' });
    await api(a.owner, 'post', '/number/path', { hasNumber: false });
    const aBefore = JSON.stringify(await rowOf(a.ws));

    const view = await api(b.owner, 'get', `/state?workspaceId=${a.ws}`);
    expect(view.body.business.name).toBeNull();
    expect(JSON.stringify(view.body)).not.toContain('Tenant A Shop');
    const help = await api(b.owner, 'get', `/help-context?workspaceId=${a.ws}`);
    expect(help.body.businessName).toBeNull();

    for (const [m, p, body] of [
      ['put', `/business?workspaceId=${a.ws}`, { ...FULL, name: 'Hijacked', workspaceId: a.ws }],
      ['post', '/number/path', { hasNumber: true, usage: 'unused', workspaceId: a.ws, userId: a.owner.id }],
      ['post', '/number/ready', { workspaceId: a.ws }],
      ['post', '/number/support-request', { workspaceId: a.ws }],
      ['post', '/prompts/customers', { state: 'skipped', workspaceId: a.ws }],
      ['post', '/preferences', { uiLanguage: 'ar', workspaceId: a.ws }],
    ]) {
      const r = await api(b.owner, m, p, body);
      expect([200, 422]).toContain(r.status);
    }
    expect(JSON.stringify(await rowOf(a.ws))).toBe(aBefore);
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: a.ws })).toBe(0);
    expect((await rowOf(b.ws)).business.name).toBe('Hijacked'); // the write landed on the token's own workspace
    // a token whose workspace has no sidecar at all cannot reach a tenant's data either
    const stranger = { id: newId(), ws: await makeWorkspace('Stranger'), role: 'owner' };
    expect((await api(stranger, 'put', '/business', { ...FULL, workspaceId: a.ws })).status).toBe(404);
    expect(JSON.stringify(await rowOf(a.ws))).toBe(aBefore);
  });
});

describe('owner vs member: numberFull', () => {
  test('only the live owner gets the full number; the JWT role is never trusted (real server, signed tokens)', async () => {
    const t = await newTenant();
    await WhatsAppConnection.create({ workspaceId: t.ws, status: 'connected', display: { displayPhoneNumber: '+966501234567', verifiedName: 'Rose' }, tokenEncrypted: 'v1:SECRET-ENVELOPE', pinEncrypted: 'v1:SECRET-PIN' });
    const owner = await real(t.owner, 'get', '/state');
    expect(owner.status).toBe(200);
    expect(owner.body.connection.numberFull).toBe('+966501234567');
    expect(owner.body.connection.numberMasked).toBe('********4567');
    const member = await real(t.member, 'get', '/state');
    expect('numberFull' in member.body.connection).toBe(false);
    const forged = await real({ ...t.member, role: 'owner' }, 'get', '/state'); // stale / forged JWT role
    expect('numberFull' in forged.body.connection).toBe(false);
    const demoted = await real({ ...t.owner, role: 'member' }, 'get', '/state'); // JWT says member, Membership says owner
    expect(demoted.body.connection.numberFull).toBe('+966501234567');
    for (const body of [owner.body, member.body]) {
      const text = JSON.stringify(body);
      for (const bad of ['SECRET', 'tokenEncrypted', 'pinEncrypted']) expect(text).not.toContain(bad);
    }
    expect(JSON.stringify(member.body)).not.toContain('966501234567');
  });
});

describe('every route for a legacy workspace', () => {
  test('/state answers { enrolled:false }; every other route is 404 ONBOARDING_NOT_AVAILABLE (mini app and real server)', async () => {
    const ws = await makeWorkspace('Legacy two');
    const who = { id: newId(), ws, role: 'owner' };
    const before = await OnboardingState.countDocuments({});
    for (const send of [api, real]) {
      expect((await send(who, 'get', '/state')).body).toEqual({ enrolled: false });
      for (const [m, p, body] of [
        ['get', '/help-context'], ['put', '/business', FULL], ['post', '/preferences', { uiLanguage: 'ar' }], ['post', '/number/path', { hasNumber: false }],
        ['post', '/number/ready'], ['post', '/number/support-request'], ['post', '/prompts/customers', { state: 'skipped' }], ['post', '/prompts/products', { state: 'skipped' }],
      ]) {
        const r = await send(who, m, p, body);
        expect(r.status).toBe(404);
        expect(r.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
      }
    }
    expect(await OnboardingState.countDocuments({})).toBe(before);
    expect(await OnboardingSupportRequest.countDocuments({ workspaceId: ws })).toBe(0);
    expect((await Workspace.findById(oldest).lean()).onboarding.completed).toBe(true); // the owner's workspace is untouched
  });
});

describe('real server.js mount', () => {
  test('signed tokens: state, business and number routes work end to end; no token is a 401 from requireAuth, never ours', async () => {
    const t = await newTenant();
    const none = await request(app).get('/api/onboarding/state');
    expect(none.status).toBe(401);
    expect((await real(t.owner, 'put', '/business', FULL)).status).toBe(200);
    expect((await real(t.owner, 'post', '/number/path', { hasNumber: false })).body.path).toBe('B');
    expect((await real(t.owner, 'post', '/number/ready')).body.numberReady).toBe(true);
    const st = await real(t.owner, 'get', '/state');
    expect(st.body).toMatchObject({ view: 'setup', nextStep: 'connect', steps: { business: { status: 'done' }, number: { status: 'done' } } });
    expect((await real(t.owner, 'get', '/help-context')).body).toMatchObject({ businessName: 'Rose Salon', supportEmail: 'support@waflow.test', stepKey: 'connect', step: 3 });
  });
  test('flag turned off after mount: the routes fall through to the existing 404', async () => {
    const t = await newTenant();
    process.env.ONBOARDING_FLOW = 'off';
    try {
      const res = await real(t.owner, 'get', '/state');
      expect(res.status).toBe(404);
      expect(res.body.code).toBeUndefined();
    } finally { process.env.ONBOARDING_FLOW = 'on'; }
  });
});

describe('help-context and preferences', () => {
  test('help-context: before payment, after, with a last error; no phone, token or Workspace.name', async () => {
    const t = await newTenant({ activate: false });
    let res = await api(t.owner, 'get', '/help-context');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ businessName: null, stepKey: 'billing', step: null, lastError: null, supportEmail: 'support@waflow.test', supportWhatsapp: null });
    await state.adminActivate({ workspaceId: t.ws, by: 'cli:test', notes: 'itest' }, noTrack);
    await api(t.owner, 'put', '/business', FULL);
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { lastError: { code: 'CONNECT_CANCELLED', step: 'connect', at: new Date('2026-10-15T09:00:00Z') } } });
    res = await api(t.owner, 'get', '/help-context');
    expect(res.body).toMatchObject({ businessName: 'Rose Salon', stepKey: 'number', step: 2, lastError: { code: 'CONNECT_CANCELLED', at: '2026-10-15T09:00:00.000Z' } });
    expect(res.body.prefilledText).toContain('Last problem: CONNECT_CANCELLED');
    expect(res.body.prefilledText).not.toMatch(/\d{7,}/);
  });
  test('preferences are stored (gate A) and idempotent', async () => {
    const t = await newTenant();
    const res = await api(t.owner, 'post', '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });
    expect(res.status).toBe(200);
    const doc = await rowOf(t.ws);
    expect(doc.business).toMatchObject({ uiLanguage: 'ar', languages: ['ar', 'en'] });
    const again = await api(t.owner, 'post', '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });
    expect(again.status).toBe(200);
    expect((await api(t.owner, 'post', '/preferences', { uiLanguage: 'zz' })).status).toBe(422);
    const st = await api(t.owner, 'get', '/state');
    expect(st.body.business).toMatchObject({ uiLanguage: 'ar', languages: ['ar', 'en'] });
  });
});

describe('analytics of the step transitions', () => {
  test('step_complete / step_skip / step_enter rows are written once per transition and carry no PII', async () => {
    const t = await newTenant();
    await api(t.owner, 'put', '/business', FULL);
    await api(t.owner, 'post', '/number/path', { hasNumber: false });
    await api(t.owner, 'post', '/number/path', { hasNumber: false });
    await api(t.owner, 'post', '/number/ready');
    const events = await OnboardingEvent.find({ workspaceId: t.ws }).lean();
    const kinds = events.map((e) => `${e.type}:${e.step || ''}${e.reason ? `:${e.reason}` : ''}`).sort();
    expect(kinds).toEqual(expect.arrayContaining(['step_complete:business', 'step_enter:number', 'step_skip:number:number_paused', 'step_complete:number']));
    expect(events.filter((e) => e.type === 'step_skip' && e.reason === 'number_paused')).toHaveLength(1);
    const text = JSON.stringify(events);
    expect(text).not.toContain('Rose Salon');
    // no phone-like number (the object ids are hex and may contain a long digit run by chance: take them out first)
    expect(text.replace(/[0-9a-f]{24}/gi, 'ID')).not.toMatch(/\d{9,}/);
  });
});
