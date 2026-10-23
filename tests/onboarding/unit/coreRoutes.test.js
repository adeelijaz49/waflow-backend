'use strict';
const fs = require('fs');
const express = require('express');
const request = require('supertest');
const businessRouter = require('../../../routes/onboarding/business');
const numberRouter = require('../../../routes/onboarding/number');
const promptsRouter = require('../../../routes/onboarding/prompts');
const stateModule = require('../../../shared/onboarding/state');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390a2';
const OWNER = '507f1f77bcf86cd7994390b1';
const MIN = 60 * 1000;
const CATALOGUE = require('path').resolve(__dirname, '..', '..', '..', '..', 'waflow-frontend', 'src', 'app', 'i18n', 'catalogs', 'en', 'onboarding.json'); // sibling repo: the check that reads it is skipped when it is not next to this repo
const done = { status: 'done', completedAt: new Date('2026-10-15T09:00:00Z') };

beforeEach(() => stateModule.clearCache());

function makeKit(docs, extra = {}) {
  const clock = { offset: 0 };
  const deps = {
    OnboardingState: createFakeModel({ unique: [['workspaceId']] }),
    OnboardingSupportRequest: createFakeModel(),
    WhatsAppConnection: createFakeModel({ unique: [['workspaceId']] }),
    Membership: createFakeModel(),
    Customer: createFakeModel(),
    Product: createFakeModel(),
    Service: createFakeModel(),
    // the Workspace model must never be touched by these routes
    Workspace: { findOne: () => { throw new Error('Workspace must not be read'); }, findById: () => { throw new Error('Workspace must not be read'); } },
    email: { sendSupportEmail: jest.fn(async () => ({ sent: true })) },
    notifications: { unreadCount: async () => 0, notify: jest.fn(async () => ({ created: true })) },
    statusRefresh: { snapshot: () => { throw Object.assign(new Error('stub'), { code: 'NOT_IMPLEMENTED' }); } },
    track: jest.fn(async () => {}),
    now: () => new Date(Date.now() + clock.offset),
    ...extra,
  };
  const origCreate = deps.OnboardingSupportRequest.create;
  deps.OnboardingSupportRequest.create = (doc) => origCreate({ ...doc, createdAt: deps.now() });
  const base = docs === undefined ? { [WS]: { subscription: { state: 'active', source: 'admin' } } } : docs;
  for (const [id, doc] of Object.entries(base)) deps.OnboardingState.seed({ workspaceId: id, enrolled: true, ...doc });
  deps.Membership.seed({ userId: OWNER, workspaceId: WS, role: 'owner' });
  return { deps, clock };
}
function makeApp(deps, wsId = WS) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: OWNER, workspaceId: wsId, role: 'owner' }; next(); });
  deps.rateLimitDeps = { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() }; // a fresh in-memory limiter per app
  app.use(businessRouter.createRouter(deps));
  app.use(numberRouter.createRouter(deps));
  app.use(promptsRouter.createRouter(deps));
  return app;
}
const row = (deps, id = WS) => deps.OnboardingState.rows.find((r) => String(r.workspaceId) === id);
const writes = (model) => model.calls.filter((c) => c[0] !== 'findOne' && c[0] !== 'find' && c[0] !== 'countDocuments').length;
const put = (app, path, body) => request(app).put(path).send(body);
const post = (app, path, body) => request(app).post(path).send(body);

describe('router shapes', () => {
  test('absolute paths of INTERFACES 2.17', () => {
    const paths = (r) => r.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`);
    expect(paths(businessRouter)).toEqual(['put /business']);
    expect(paths(numberRouter)).toEqual(['post /number/path', 'post /number/ready', 'post /number/support-request']);
    expect(paths(promptsRouter)).toEqual(['post /prompts/customers', 'post /prompts/products']);
    for (const r of [businessRouter, numberRouter, promptsRouter]) expect(typeof r.createRouter).toBe('function');
  });
});

describe('PUT /business', () => {
  const FULL = { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty' };

  test('name + country + industry -> step done, progress moves on, the new /state is returned', async () => {
    const { deps } = makeKit();
    const res = await put(makeApp(deps), '/business', { ...FULL, website: 'https://rose.example.com', instagram: '@rose', contactEmail: 'o@rose.test', uiLanguage: 'ar', languages: ['ar'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enrolled: true, view: 'setup', nextStep: 'number', currentStep: 'number',
      steps: { business: { status: 'done' } },
      business: { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty', website: 'https://rose.example.com', instagram: 'rose', contactEmail: 'o@rose.test', uiLanguage: 'ar', languages: ['ar'] },
    });
    expect(row(deps).steps.business.status).toBe('done');
    expect(row(deps).progress.currentStep).toBe(2);
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_complete', step: 'business' });
  });
  test('partial updates: the step stays in progress until all three required fields exist', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    let res = await put(app, '/business', { name: 'Rose Salon' });
    expect(res.body.steps.business.status).toBe('in_progress');
    expect(res.body.nextStep).toBe('business');
    res = await put(app, '/business', { industry: 'fashion' });
    expect(res.body.steps.business.status).toBe('in_progress'); // country defaults to SA in the model, but the fake has no default
    res = await put(app, '/business', { country: 'ae' });
    expect(res.body.steps.business.status).toBe('done');
    expect(res.body.business).toMatchObject({ name: 'Rose Salon', country: 'AE', industry: 'fashion' });
  });
  test('contactEmail is OWNER-ONLY (review R2-09): the owner\'s address is saved and marked; anyone else\'s is silently dropped and the rest of the request is saved', async () => {
    const { deps } = makeKit();
    const MEMBER = '507f1f77bcf86cd7994390b2';
    const STRANGER = '507f1f77bcf86cd7994390b3';
    deps.Membership.seed({ userId: MEMBER, workspaceId: WS, role: 'member' });
    const appFor = (userId, role = 'owner') => {
      const a = express();
      a.use(express.json());
      a.use((req, res, next) => { req.user = { id: userId, workspaceId: WS, role }; next(); }); // the token may CLAIM role owner (30 days stale or forged): the Membership decides
      deps.rateLimitDeps = { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() };
      a.use(businessRouter.createRouter(deps));
      return a;
    };
    // the owner: saved (normalised) and marked as the owner's own address
    let res = await put(appFor(OWNER), '/business', { ...FULL, contactEmail: 'Owner@Rose.test' });
    expect(res.status).toBe(200);
    expect(res.body.business.contactEmail).toBe('owner@rose.test');
    expect(row(deps).business.contactEmailByOwner).toBe(true);
    // a member (whose token says owner), and a user with no membership at all: the address is dropped, the website is saved, no error
    for (const who of [MEMBER, STRANGER]) {
      res = await put(appFor(who), '/business', { contactEmail: 'attacker@evil.test', website: `https://${who.slice(-2)}.example.com` });
      expect(res.status).toBe(200);
      expect(row(deps).business.contactEmail).toBe('owner@rose.test');
      expect(row(deps).business.contactEmailByOwner).toBe(true);
      expect(row(deps).business.website).toBe(`https://${who.slice(-2)}.example.com`);
    }
    // a request that carries nothing but the dropped address changes nothing and writes nothing
    const before = writes(deps.OnboardingState);
    res = await put(appFor(MEMBER), '/business', { contactEmail: 'attacker2@evil.test' });
    expect(res.status).toBe(200);
    expect(res.body.business.contactEmail).toBe('owner@rose.test');
    expect(writes(deps.OnboardingState)).toBe(before);
    // an invalid address is a validation error for everybody (no hint about who may set it)
    expect((await put(appFor(MEMBER), '/business', { contactEmail: 'bad' })).status).toBe(422);
    // the owner clearing the address removes the marker too
    res = await put(appFor(OWNER), '/business', { contactEmail: '' });
    expect(res.status).toBe(200);
    expect(row(deps).business.contactEmail).toBeNull();
    expect(row(deps).business.contactEmailByOwner).toBe(false);
  });
  test('an address that was stored before the marker existed counts for notification mail only once the owner confirms it', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active', source: 'admin' }, business: { name: 'Rose Salon', contactEmail: 'old@rose.test' } } });
    expect(row(deps).business.contactEmailByOwner).toBeUndefined();
    const res = await put(makeApp(deps), '/business', { contactEmail: 'old@rose.test' }); // the same address, typed again by the owner
    expect(res.status).toBe(200);
    expect(row(deps).business.contactEmailByOwner).toBe(true);
  });
  test('validation: 422 VALIDATION_FAILED with the field list, nothing written', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    const res = await put(app, '/business', { name: 'x', country: 'ZZ', industry: 'nope', website: 'http://nope', instagram: 'a b', crNumber: '12', contactEmail: 'bad' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.details.fields).sort()).toEqual(['contactEmail', 'country', 'crNumber', 'industry', 'instagram', 'name', 'website']);
    expect(writes(deps.OnboardingState)).toBe(0);
    for (const bad of [{}, { foo: 1 }, { name: 5 }]) expect((await put(app, '/business', bad)).status).toBe(422);
  });
  test('crSkipped:true records verificationNeedsCr (and a skip event); a CR number answers the question', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    let res = await put(app, '/business', { ...FULL, crSkipped: true });
    expect(res.body.business.crSkipped).toBe(true);
    expect(row(deps).business).toMatchObject({ crSkipped: true, verificationNeedsCr: true });
    expect(row(deps).business.crSkippedAt).toBeTruthy();
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_skip', step: 'business', reason: 'cr_skipped' });
    res = await put(app, '/business', { crNumber: '1010123456' });
    expect(res.body.business).toMatchObject({ crSkipped: false, crNumber: '1010123456' });
    expect(row(deps).business).toMatchObject({ crSkipped: false, verificationNeedsCr: false, crNumber: '1010123456' });
    expect(row(deps).business.crSkippedAt).toBeUndefined();
    // both at once: the number wins
    const { deps: d2 } = makeKit();
    await put(makeApp(d2), '/business', { ...FULL, crSkipped: true, crNumber: 'AB12345' });
    expect(row(d2).business).toMatchObject({ crSkipped: false, verificationNeedsCr: false, crNumber: 'AB12345' });
    expect(d2.track).not.toHaveBeenCalledWith(WS, expect.objectContaining({ reason: 'cr_skipped' }));
  });
  test('no CR document upload exists: the body field "crDocument" is ignored', async () => {
    const { deps } = makeKit();
    await put(makeApp(deps), '/business', { ...FULL, crDocument: 'data:application/pdf;base64,AAAA', crFile: 'x' });
    expect(JSON.stringify(row(deps))).not.toContain('crDocument');
    expect(JSON.stringify(row(deps))).not.toContain('AAAA');
  });
  test('optional fields can be cleared with an empty string', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    await put(app, '/business', { ...FULL, website: 'https://rose.example.com', instagram: 'rose' });
    const res = await put(app, '/business', { website: '', instagram: null });
    expect(res.body.business.website).toBeNull();
    expect(res.body.business.instagram).toBeNull();
  });
  test('idempotent: the same body again writes nothing', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    const body = { ...FULL, website: 'https://rose.example.com', crSkipped: true, languages: ['en', 'ar'] };
    const first = await put(app, '/business', body);
    const before = JSON.stringify(row(deps));
    const w = writes(deps.OnboardingState);
    const tracked = deps.track.mock.calls.length;
    const second = await put(app, '/business', body);
    expect(second.status).toBe(200);
    expect(writes(deps.OnboardingState)).toBe(w);
    expect(JSON.stringify(row(deps))).toBe(before);
    expect(deps.track.mock.calls.length).toBe(tracked);
    expect(second.body.business).toEqual(first.body.business);
  });
  test('lastError is untouched; unknown body fields (subscription, steps) cannot write anything', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active', source: 'admin' }, lastError: { code: 'META_ERROR', step: 'connect' } } });
    await put(makeApp(deps), '/business', { ...FULL, subscription: { state: 'cancelled' }, steps: { connect: { status: 'done' } }, enrolled: false, 'steps.connect.status': 'done' });
    expect(row(deps).lastError).toEqual({ code: 'META_ERROR', step: 'connect' });
    expect(row(deps).subscription.state).toBe('active');
    expect(row(deps).steps.connect).toBeUndefined();
    expect(row(deps).enrolled).toBe(true);
  });
  test('tenant isolation: a workspaceId in the body or query is ignored', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' }, business: { name: 'Theirs' } } });
    await put(makeApp(deps), `/business?workspaceId=${OTHER}`, { ...FULL, workspaceId: OTHER });
    expect(row(deps, OTHER).business).toEqual({ name: 'Theirs' });
    expect(row(deps, WS).business.name).toBe('Rose Salon');
  });
  test('legacy workspace -> 404 ONBOARDING_NOT_AVAILABLE, nothing written', async () => {
    const { deps } = makeKit({});
    const res = await put(makeApp(deps), '/business', FULL);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
    expect(writes(deps.OnboardingState)).toBe(0);
  });
});

describe('POST /number/path', () => {
  const path = (app, body) => post(app, '/number/path', body);

  test('Path A, number not on WhatsApp: step done, nextStep connect once step 1 is done', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' }, steps: { business: done } } });
    const res = await path(makeApp(deps), { hasNumber: true, usage: 'unused' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'A', nextStep: 'connect', guidance: { keys: [], coexistence: 'unknown', callRequired: false, waitMinutes: 0 } });
    expect(row(deps).number).toMatchObject({ path: 'A', hasNumber: true, usage: 'unused', businessAppChoice: null, personalWarningAcknowledged: false });
    expect(row(deps).number.usageAnsweredAt).toBeTruthy();
    expect(row(deps).steps.number.status).toBe('done');
    expect(row(deps).progress.status).toBe('in_progress');
  });
  test('Path A, personal WhatsApp: needs acknowledgeRemoval (422 NUMBER_PERSONAL_WARNING_REQUIRED, nothing written), then ok', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{ hasNumber: true, usage: 'personal' }, { hasNumber: true, usage: 'personal', acknowledgeRemoval: false }, { hasNumber: true, usage: 'personal', acknowledgeRemoval: 'yes' }]) {
      const res = await path(app, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NUMBER_PERSONAL_WARNING_REQUIRED');
      expect(res.body.nextStep).toBe('number');
    }
    expect(writes(deps.OnboardingState)).toBe(0);
    const ok = await path(app, { hasNumber: true, usage: 'personal', acknowledgeRemoval: true });
    expect(ok.status).toBe(200);
    expect(ok.body.path).toBe('A');
    expect(ok.body.guidance.keys).toEqual(['number.personal.title', 'number.personal.warning', 'number.personal.how']);
    expect(ok.body.guidance.waitMinutes).toBe(3);
    expect(row(deps).number.personalWarningAcknowledged).toBe(true);
  });
  test('Path A, WhatsApp Business app: a choice is required; coexistence / migrate stay on A; different_number flips to B', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{ hasNumber: true, usage: 'business_app' }, { hasNumber: true, usage: 'business_app', businessAppChoice: 'maybe' }]) {
      const res = await path(app, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(writes(deps.OnboardingState)).toBe(0);
    let res = await path(app, { hasNumber: true, usage: 'business_app', businessAppChoice: 'coexistence' });
    expect(res.body.path).toBe('A');
    expect(res.body.guidance.coexistence).toBe('maybe_available');
    expect(res.body.guidance.keys).toContain('number.bizapp.body');
    expect(row(deps).number.businessAppChoice).toBe('coexistence');
    res = await path(app, { hasNumber: true, usage: 'business_app', businessAppChoice: 'migrate' });
    expect(res.body).toMatchObject({ path: 'A', guidance: { coexistence: 'unknown', waitMinutes: 3 } });
    expect(res.body.guidance.keys).toContain('number.migrate.body');
    res = await path(app, { hasNumber: true, usage: 'business_app', businessAppChoice: 'different_number' });
    expect(res.body).toMatchObject({ path: 'B', nextStep: 'business', guidance: { coexistence: 'unknown' } });
    expect(res.body.guidance.keys).toContain('number.getone.body');
    expect(row(deps).progress.status).toBe('paused_number');
    expect(row(deps).steps.number.status).toBe('in_progress');
  });
  test('Path A, landline: callRequired true', async () => {
    const { deps } = makeKit();
    const res = await path(makeApp(deps), { hasNumber: true, usage: 'landline' });
    expect(res.body).toMatchObject({ path: 'A', guidance: { callRequired: true, coexistence: 'unknown' } });
    expect(res.body.guidance.keys).toEqual(['number.landline.title', 'number.landline.body']);
    expect(row(deps).steps.number.status).toBe('done');
  });
  test('Path B: no number -> paused_number with pausedAt, the number step stays open, one skip event', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' }, steps: { business: done } } });
    const res = await path(makeApp(deps), { hasNumber: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: 'B', nextStep: 'number', guidance: { coexistence: 'unknown', callRequired: false, waitMinutes: 0 } });
    expect(res.body.guidance.keys).toContain('number.getone.t1');
    expect(row(deps).number).toMatchObject({ path: 'B', hasNumber: false, usage: null, numberReady: false });
    expect(row(deps).number.pausedAt).toBeTruthy();
    expect(row(deps).progress.status).toBe('paused_number');
    expect(row(deps).steps.number.status).toBe('in_progress');
    expect(deps.track).toHaveBeenCalledWith(WS, expect.objectContaining({ type: 'step_skip', step: 'number', reason: 'number_paused' }));
  });
  test('validation: hasNumber must be a boolean; usage must be known when hasNumber is true', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{}, { hasNumber: 'yes' }, { hasNumber: 1 }, { hasNumber: true }, { hasNumber: true, usage: 'office' }, null]) {
      const res = await path(app, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(writes(deps.OnboardingState)).toBe(0);
  });
  test('idempotent: the same answer again writes nothing and tracks nothing more', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{ hasNumber: true, usage: 'landline' }, { hasNumber: false }]) {
      const first = await path(app, body);
      const w = writes(deps.OnboardingState);
      const before = JSON.stringify(row(deps));
      const tracked = deps.track.mock.calls.length;
      const second = await path(app, body);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(writes(deps.OnboardingState)).toBe(w);
      expect(JSON.stringify(row(deps))).toBe(before);
      expect(deps.track.mock.calls.length).toBe(tracked);
    }
  });
  test('the answer can be changed before a connection exists (A -> B pauses, B -> A resumes)', async () => {
    const { deps, clock } = makeKit();
    const app = makeApp(deps);
    await path(app, { hasNumber: true, usage: 'unused' });
    expect(row(deps).steps.number.status).toBe('done');
    clock.offset = 5 * MIN;
    await path(app, { hasNumber: false });
    expect(row(deps).progress.status).toBe('paused_number');
    expect(row(deps).steps.number.status).toBe('in_progress');
    clock.offset = 6 * MIN;
    const res = await path(app, { hasNumber: true, usage: 'landline' });
    expect(res.body.path).toBe('A');
    expect(row(deps).progress.status).toBe('in_progress');
    expect(row(deps).steps.number.status).toBe('done');
  });
  test('after a connection exists: changes -> 409 NUMBER_ALREADY_CONNECTED, an identical re-send is a no-op', async () => {
    for (const mode of ['stepDone', 'connectionRow']) {
      stateModule.clearCache();
      const { deps } = makeKit();
      const app = makeApp(deps);
      await path(app, { hasNumber: true, usage: 'landline' });
      if (mode === 'stepDone') await deps.OnboardingState.updateOne({ workspaceId: WS }, { $set: { 'steps.connect.status': 'done' } });
      else deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected' });
      const w = writes(deps.OnboardingState);
      const changed = await path(app, { hasNumber: false });
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('NUMBER_ALREADY_CONNECTED');
      expect(changed.body.nextStep).toBe('connect');
      const personal = await path(app, { hasNumber: true, usage: 'personal', acknowledgeRemoval: true });
      expect(personal.status).toBe(409);
      expect(writes(deps.OnboardingState)).toBe(w + (mode === 'stepDone' ? 0 : 0));
      const same = await path(app, { hasNumber: true, usage: 'landline' });
      expect(same.status).toBe(200);
      expect(same.body.path).toBe('A');
      expect(row(deps).number.usage).toBe('landline');
    }
  });
  test('a half-made (not_connected / connecting) row does not freeze the answers', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connecting' });
    await path(app, { hasNumber: true, usage: 'unused' });
    expect((await path(app, { hasNumber: false })).status).toBe(200);
  });
  test('guidance keys exist in the English onboarding catalogue and promise nothing about coexistence in KSA', async () => {
    const answers = [
      { hasNumber: false }, { hasNumber: true, usage: 'unused' }, { hasNumber: true, usage: 'personal', acknowledgeRemoval: true },
      { hasNumber: true, usage: 'business_app', businessAppChoice: 'coexistence' }, { hasNumber: true, usage: 'business_app', businessAppChoice: 'migrate' },
      { hasNumber: true, usage: 'business_app', businessAppChoice: 'different_number' }, { hasNumber: true, usage: 'landline' },
    ];
    const keys = new Set();
    for (const body of answers) {
      const { deps } = makeKit();
      const res = await path(makeApp(deps), body);
      expect(['unknown', 'maybe_available']).toContain(res.body.guidance.coexistence);
      if (!(body.usage === 'business_app' && body.businessAppChoice === 'coexistence')) expect(res.body.guidance.coexistence).toBe('unknown');
      for (const k of res.body.guidance.keys) keys.add(k);
    }
    expect(keys.size).toBeGreaterThan(10);
    if (!fs.existsSync(CATALOGUE)) return; // the frontend repo is not next to the backend
    const cat = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
    for (const k of keys) expect(Object.prototype.hasOwnProperty.call(cat, k)).toBe(true);
    // the only text that mentions keeping the app is hedged ("may", "can't promise")
    expect(cat['number.bizapp.body']).toMatch(/may be able/i);
    expect(cat['number.bizapp.body']).toMatch(/can't promise/i);
    for (const k of keys) expect(cat[k]).not.toMatch(/guarantee|will definitely|always works/i);
  });
  test('tenant isolation and legacy', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' } } });
    await post(makeApp(deps), `/number/path?workspaceId=${OTHER}`, { hasNumber: false, workspaceId: OTHER });
    expect(row(deps, OTHER).number).toBeUndefined();
    expect(row(deps, WS).number.path).toBe('B');
    const legacy = makeKit({});
    const res = await path(makeApp(legacy.deps), { hasNumber: false });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
});

describe('POST /number/ready', () => {
  test('Path B "I\'ve got my number": numberReady, step 2 done, the flow resumes', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' }, steps: { business: done } } });
    const app = makeApp(deps);
    await post(app, '/number/path', { hasNumber: false });
    expect(row(deps).progress.status).toBe('paused_number');
    const res = await post(app, '/number/ready', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ path: 'B', numberReady: true, nextStep: 'connect' });
    expect(row(deps).number.numberReady).toBe(true);
    expect(row(deps).steps.number.status).toBe('done');
    expect(row(deps).progress.status).toBe('in_progress');
  });
  test('idempotent: the second call writes nothing', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    await post(app, '/number/path', { hasNumber: false });
    const first = await post(app, '/number/ready', {});
    const w = writes(deps.OnboardingState);
    const before = JSON.stringify(row(deps));
    const second = await post(app, '/number/ready', {});
    expect(second.body).toEqual(first.body);
    expect(writes(deps.OnboardingState)).toBe(w);
    expect(JSON.stringify(row(deps))).toBe(before);
  });
  test('without an earlier answer it records path B; on a finished Path A it changes nothing', async () => {
    const { deps } = makeKit();
    const res = await post(makeApp(deps), '/number/ready', {});
    expect(res.status).toBe(200);
    expect(row(deps).number).toMatchObject({ path: 'B', numberReady: true });
    const { deps: d2 } = makeKit();
    const app2 = makeApp(d2);
    await post(app2, '/number/path', { hasNumber: true, usage: 'unused' });
    const w = writes(d2.OnboardingState);
    const r2 = await post(app2, '/number/ready', {});
    expect(r2.body.path).toBe('A');
    expect(writes(d2.OnboardingState)).toBe(w);
  });
  test('legacy -> 404; another workspace is untouched', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' } } });
    await post(makeApp(deps), '/number/ready', { workspaceId: OTHER });
    expect(row(deps, OTHER).number).toBeUndefined();
    const res = await post(makeApp(makeKit({}).deps), '/number/ready', {});
    expect(res.status).toBe(404);
  });
});

describe('POST /number/support-request', () => {
  const ask = (app, body) => post(app, '/number/support-request', body);

  test('creates a request, e-mails support (best effort), notifies, never buys a number', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' }, business: { name: 'Rose Salon' } } });
    const res = await ask(makeApp(deps), { message: 'Need a SIM please' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, duplicate: false, requestId: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(deps.OnboardingSupportRequest.rows).toHaveLength(1);
    expect(deps.OnboardingSupportRequest.rows[0]).toMatchObject({ kind: 'number_help', step: 'number', message: 'Need a SIM please', businessName: 'Rose Salon' });
    expect(deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
    expect(deps.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'help_received' }));
    expect(row(deps).number.helpRequestedAt).toBeTruthy();
  });
  test('a duplicate within 10 minutes returns the existing request', async () => {
    const { deps, clock } = makeKit();
    const app = makeApp(deps);
    const first = await ask(app, {});
    clock.offset = 5 * MIN;
    const second = await ask(app, { message: 'again' });
    expect(second.body).toEqual({ ok: true, duplicate: true, requestId: first.body.requestId });
    expect(deps.OnboardingSupportRequest.rows).toHaveLength(1);
    expect(deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
  });
  test('3 per day, then 429 RATE_LIMITED with a Retry-After header', async () => {
    const { deps, clock } = makeKit();
    const app = makeApp(deps);
    for (let i = 0; i < 3; i += 1) { clock.offset = i * 11 * MIN; expect((await ask(app, {})).status).toBe(200); }
    clock.offset = 40 * MIN;
    const res = await ask(app, {});
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(3600);
    expect(deps.OnboardingSupportRequest.rows).toHaveLength(3);
  });
  test('an e-mail failure never fails the request; the row keeps a short code only', async () => {
    const { deps } = makeKit(undefined, { email: { sendSupportEmail: async () => { throw Object.assign(new Error('provider said: secret body'), { statusCode: 500 }); } } });
    const res = await ask(makeApp(deps), { message: 'hi' });
    expect(res.status).toBe(200);
    expect(deps.OnboardingSupportRequest.rows[0].emailError).toBe('HTTP_500');
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
  test('the real (not yet implemented) e-mail module cannot break it either', async () => {
    const { deps } = makeKit();
    delete deps.email;
    const res = await ask(makeApp(deps), {});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
  test('validation: message must be a string of at most 300 characters', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{ message: 5 }, { message: ['x'] }, { message: 'x'.repeat(301) }]) {
      const res = await ask(app, body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect((await ask(app, { message: 'x'.repeat(300) })).status).toBe(200);
  });
  test('tenant isolation: the limit and duplicates are per workspace; body workspaceId ignored; legacy -> 404', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' } } });
    await ask(makeApp(deps), { workspaceId: OTHER });
    expect(deps.OnboardingSupportRequest.rows.map((r) => String(r.workspaceId))).toEqual([WS]);
    const o = await ask(makeApp(deps, OTHER), {});
    expect(o.body.duplicate).toBe(false);
    const legacy = await ask(makeApp(makeKit({}).deps), {});
    expect(legacy.status).toBe(404);
  });
});

describe('POST /prompts/customers | /prompts/products', () => {
  const answer = (app, kind, state) => post(app, `/prompts/${kind}`, { state });

  test('skipped is always accepted (no data needed), the reminder state is stored', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const kind of ['customers', 'products']) {
      const res = await answer(app, kind, 'skipped');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind, state: 'skipped' });
      expect(row(deps).prompts[kind].state).toBe('skipped');
      expect(row(deps).prompts[kind].updatedAt).toBeTruthy();
    }
    expect(row(deps).prompts.promptedAt).toBeTruthy();
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_skip', step: 'customers', reason: 'customers_skipped' });
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_skip', step: 'products', reason: 'products_skipped' });
  });
  test('done needs a real count: customers 0 -> 422 VALIDATION_FAILED and nothing is written; > 0 -> accepted', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    let res = await answer(app, 'customers', 'done');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(writes(deps.OnboardingState)).toBe(0);
    deps.Customer.seed({ workspaceId: WS });
    res = await answer(app, 'customers', 'done');
    expect(res.status).toBe(200);
    expect(res.body.prompts.customers.state).toBe('done');
    expect(row(deps).prompts.customers.state).toBe('done');
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_complete', step: 'customers' });
  });
  test('products: a product OR a service counts', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    expect((await answer(app, 'products', 'done')).status).toBe(422);
    deps.Service.seed({ workspaceId: WS });
    expect((await answer(app, 'products', 'done')).status).toBe(200);
    const { deps: d2 } = makeKit();
    d2.Product.seed({ workspaceId: WS });
    expect((await answer(makeApp(d2), 'products', 'done')).status).toBe(200);
  });
  test('only this workspace\'s data counts (another workspace\'s customers do not)', async () => {
    const { deps } = makeKit();
    deps.Customer.seed({ workspaceId: OTHER });
    deps.Product.seed({ workspaceId: OTHER });
    const app = makeApp(deps);
    expect((await answer(app, 'customers', 'done')).status).toBe(422);
    expect((await answer(app, 'products', 'done')).status).toBe(422);
    const counts = deps.Customer.calls.filter((c) => c[0] === 'countDocuments');
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) expect(c[1]).toEqual({ workspaceId: WS, deletedAt: { $exists: false } });
  });
  test('ruling 5: an erased customer (deletedAt set) never makes the customers prompt "done"', async () => {
    const { deps } = makeKit();
    deps.Customer.seed({ workspaceId: WS, phone: '1', deletedAt: new Date('2026-10-01T00:00:00Z') });
    const app = makeApp(deps);
    const res = await answer(app, 'customers', 'done');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    deps.Customer.seed({ workspaceId: WS, phone: '2' });
    expect((await answer(app, 'customers', 'done')).status).toBe(200);
  });
  test('the count cannot be read -> 500 INTERNAL_ERROR (never a blind "done")', async () => {
    const { deps } = makeKit();
    deps.Customer.failWith = new Error('db down');
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await answer(makeApp(deps), 'customers', 'done');
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(row(deps).prompts).toBeUndefined();
  });
  test('idempotent; done -> skipped is allowed; skipped -> done needs data again', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    deps.Customer.seed({ workspaceId: WS });
    await answer(app, 'customers', 'done');
    const w = writes(deps.OnboardingState);
    const tracked = deps.track.mock.calls.length;
    const again = await answer(app, 'customers', 'done');
    expect(again.status).toBe(200);
    expect(writes(deps.OnboardingState)).toBe(w);
    expect(deps.track.mock.calls.length).toBe(tracked);
    expect((await answer(app, 'customers', 'skipped')).body.prompts.customers.state).toBe('skipped');
    expect((await answer(app, 'customers', 'done')).status).toBe(200); // the customer still exists
  });
  test('invalid state -> 422, nothing written', async () => {
    const { deps } = makeKit();
    const app = makeApp(deps);
    for (const body of [{}, { state: 'pending' }, { state: 'DONE' }, { state: 1 }, null]) {
      const res = await post(app, '/prompts/customers', body);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(writes(deps.OnboardingState)).toBe(0);
  });
  test('answering a prompt moves a never-opened approvals step to in_progress so nextStep cannot dead-end; nextStep follows', async () => {
    const allDone = { business: done, number: done, connect: done };
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' }, steps: allDone } });
    const app = makeApp(deps);
    const res = await answer(app, 'customers', 'skipped');
    expect(row(deps).steps.approvals.status).toBe('in_progress');
    expect(res.body.nextStep).toBe('products');
    const res2 = await answer(app, 'products', 'skipped');
    expect(res2.body.nextStep).toBe('promotion');
  });
  test('tenant isolation: body workspaceId ignored; legacy -> 404', async () => {
    const { deps } = makeKit({ [WS]: { subscription: { state: 'active' } }, [OTHER]: { subscription: { state: 'active' } } });
    await post(makeApp(deps), '/prompts/customers', { state: 'skipped', workspaceId: OTHER });
    expect(row(deps, OTHER).prompts).toBeUndefined();
    expect(row(deps, WS).prompts.customers.state).toBe('skipped');
    const res = await answer(makeApp(makeKit({}).deps), 'customers', 'skipped');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
});
