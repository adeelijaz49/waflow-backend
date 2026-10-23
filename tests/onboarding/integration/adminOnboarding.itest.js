'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database (suffix) so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_admin`;
assertThrowawayDb();

// The staff page and the staff CLI against a REAL (throwaway) mongod, the real state.js and the real models.
// Stripe/Meta/Resend are never reached (billing is a fake, nothing here sends). The flag is OFF throughout:
// the tooling must work before the feature is switched on. No delete operations anywhere.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const state = require('../../../shared/onboarding/state');
const config = require('../../../shared/onboarding/config');
const Workspace = require('../../../models/Workspace');
const User = require('../../../models/User');
const Membership = require('../../../models/Membership');
const OnboardingState = require('../../../models/OnboardingState');
const OnboardingAdminLog = require('../../../models/OnboardingAdminLog');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');
const adminRouter = require('../../../routes/adminOnboarding');
const cli = require('../../../scripts/onboarding-admin');

const BASE = '/internal-admin-onboarding';
const KEY = 'integration-admin-password';
const AUTH = `Basic ${Buffer.from('staff:whatever').toString('base64')}`;
const NOW = new Date('2026-10-15T10:00:00Z');
const FULL_NUMBER = '966501234567';

let oldest; let ws1; let wsData; let wsMember; let wsPhoneOnly; let wsCli;
const ids = {};
const billing = { refreshBilling: jest.fn(async () => ({ changed: false })) };
let app;

async function makeWorkspace(name, createdAt) {
  const res = await Workspace.collection.insertOne({ name, createdAt, updatedAt: createdAt, onboarding: { completed: false, currentStep: 1 } });
  return String(res.insertedId);
}
const csrf = (workspaceId) => crypto.createHmac('sha256', KEY).update(`staff:${workspaceId}:2026-10-15`).digest('hex');
const get = (p) => request(app).get(`${BASE}${p}`).set('Authorization', AUTH);
const post = (workspaceId, action, body = {}, token) => request(app).post(`${BASE}/${workspaceId}/${action}`).set('Authorization', AUTH).type('form')
  .send({ csrf: token === undefined ? csrf(workspaceId) : token, ...body });
const row = (id) => OnboardingState.findOne({ workspaceId: id }).lean();
const logs = (id, filter = {}) => OnboardingAdminLog.find({ workspaceId: id, ...filter }).sort({ createdAt: 1 }).lean();

let consoleSpies = [];
beforeAll(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), OnboardingAdminLog.init(), OnboardingEvent.init(), WhatsAppConnection.init(), User.init(), Membership.init()]);
  consoleSpies = [jest.spyOn(console, 'warn').mockImplementation(() => {}), jest.spyOn(console, 'error').mockImplementation(() => {})];
  oldest = await makeWorkspace('Owner Workspace', new Date('2026-01-01T00:00:00Z'));
  ws1 = await makeWorkspace('Salon (Riyadh) [pilot]', new Date('2026-10-01T00:00:00Z'));
  wsData = await makeWorkspace('Shop with data', new Date('2026-10-02T00:00:00Z'));
  wsMember = await makeWorkspace('Member Workspace', new Date('2026-10-03T00:00:00Z'));
  wsPhoneOnly = await makeWorkspace('Phone only', new Date('2026-10-04T00:00:00Z'));
  wsCli = await makeWorkspace('CLI Workspace', new Date('2026-10-05T00:00:00Z'));
  await mongoose.connection.collection('customers').insertOne({ workspaceId: new mongoose.Types.ObjectId(wsData), name: 'Existing customer', phone: '966500000001' });
  const owner = await User.create({ email: 'owner-member@example.test', name: 'Unique Member Name' });
  await Membership.create({ userId: owner._id, workspaceId: wsMember, role: 'owner' });
  const phoneUser = await User.create({ phone: '966511122233' });
  await Membership.create({ userId: phoneUser._id, workspaceId: wsPhoneOnly, role: 'owner' });
  Object.assign(ids, { oldest, ws1, wsData, wsMember, wsPhoneOnly, wsCli });

  app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.adminIp = '203.0.113.9'; next(); });
  app.use(BASE, adminRouter.createRouter({ getCsrfKey: () => KEY, now: () => NOW, billing }));
});
afterAll(async () => { consoleSpies.forEach((s) => s.mockRestore()); await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); delete process.env.ONBOARDING_FLOW; });

describe('the flag is OFF: the tooling still works and nothing is enrolled yet', () => {
  test('flag is off, home lists nothing enrolled, marks the oldest workspace, shows a zero funnel', async () => {
    expect(config.enabled()).toBe(false);
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No workspace is enrolled.');
    expect(res.text).toContain('[webhook workspace / owner]');
    expect(res.text).toContain(`${BASE}/${oldest}`);
    expect(res.text).toContain('Enrolled workspaces: <strong>0</strong>');
  });
  test('search by name (regex metacharacters are literal), by id, and through a member', async () => {
    const byName = await get('/search?q=' + encodeURIComponent('Salon (Riyadh) [pilot]'));
    expect(byName.text).toContain(`${BASE}/${ws1}`);
    expect((await get('/search?q=' + encodeURIComponent('.*'))).text).toContain('No matches.');
    expect((await get('/search?q=' + encodeURIComponent('(unclosed'))).status).toBe(200);
    expect((await get(`/search?q=${wsData}`)).text).toContain('Shop with data');
    const byMember = await get('/search?q=' + encodeURIComponent('Unique Member Name'));
    expect(byMember.text).toContain(`${BASE}/${wsMember}`);
    const byEmail = await get('/search?q=owner-member@example');
    expect(byEmail.text).toContain(`${BASE}/${wsMember}`);
    const byPhone = await get('/search?q=966511122233');
    expect(byPhone.text).toContain(`${BASE}/${wsPhoneOnly}`);
  });
  test('a legacy workspace page shows "Not enrolled" and the enrol form', async () => {
    const t = (await get(`/${ws1}`)).text;
    expect(t).toContain('Legacy workspace: nothing is gated');
    expect(t).toContain(`action="${BASE}/${ws1}/enrol"`);
  });
});

describe('CSRF fails closed against the real database', () => {
  test('bad tokens write nothing', async () => {
    const wrongDay = crypto.createHmac('sha256', KEY).update(`staff:${ws1}:2026-10-14`).digest('hex');
    for (const tok of ['', 'x'.repeat(64), wrongDay, csrf(wsData)]) {
      for (const action of ['enrol', 'unenrol', 'activate', 'deactivate', 'refresh', 'reconcile']) {
        const res = await post(ws1, action, { notes: 'n' }, tok);
        expect(res.status).toBe(403);
      }
    }
    const noToken = await request(app).post(`${BASE}/${ws1}/enrol`).set('Authorization', AUTH).type('form').send({});
    expect(noToken.status).toBe(403);
    expect(await OnboardingState.countDocuments({})).toBe(0);
    expect(await OnboardingAdminLog.countDocuments({})).toBe(0);
  });
  test('a server without INTERNAL_ADMIN_PASSWORD answers 403 to every action', async () => {
    const bare = express();
    bare.use(express.urlencoded({ extended: true }));
    bare.use(BASE, adminRouter.createRouter({ getCsrfKey: () => undefined, now: () => NOW, billing }));
    const res = await request(bare).post(`${BASE}/${ws1}/enrol`).type('form').send({ csrf: crypto.createHmac('sha256', '').update(`staff:${ws1}:2026-10-15`).digest('hex') });
    expect(res.status).toBe(403);
    expect(await OnboardingState.countDocuments({})).toBe(0);
  });
});

describe('Enrol, with the safeguards of DB 3.2', () => {
  test('an ordinary workspace: enrolled, logged once BEFORE/with the change, R1 applied, gate state live', async () => {
    const res = await post(ws1, 'enrol', { notes: 'KSA pilot' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${BASE}/${ws1}?done=enrol`);
    const st = await row(ws1);
    expect(st).toMatchObject({ enrolled: true, enrolledVia: 'admin', enrolledBy: 'staff', r1Applied: true });
    expect(st.subscription.state).toBe('none');
    const entries = await logs(ws1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'enrol', adminUser: 'staff', notes: 'KSA pilot', ip: '203.0.113.9' });
    expect(entries[0].createdAt.getTime()).toBeLessThanOrEqual(new Date(st.createdAt).getTime()); // the audit row was written before the sidecar document existed
    expect((await Workspace.findById(ws1).lean()).onboarding.completed).toBe(true);
    expect((await state.getGateState(ws1, { fresh: true })).enrolled).toBe(true);
    // enrolling again is a no-op: no second audit row
    expect((await post(ws1, 'enrol')).status).toBe(303);
    expect(await logs(ws1)).toHaveLength(1);
    // only this workspace changed
    expect(await OnboardingState.countDocuments({})).toBe(1);
    expect((await Workspace.findById(wsData).lean()).onboarding.completed).toBe(false);
  });
  test('the OLDEST workspace is refused (friendly page, nothing written) until the second checkbox is ticked', async () => {
    const refused = await post(oldest, 'enrol');
    expect(refused.status).toBe(422);
    expect(refused.text).toContain('OLDEST');
    expect(await row(oldest)).toBeNull();
    expect(await logs(oldest)).toHaveLength(0);
    expect((await Workspace.findById(oldest).lean()).onboarding.completed).toBe(false);
    const page = (await get(`/${oldest}`)).text;
    expect(page).toContain('class="banner"');
    expect(page).toContain('[webhook workspace / owner]');
    expect(page).toContain('name="forceOldest"');
    const ok = await post(oldest, 'enrol', { forceOldest: 'on', notes: 'owner test' });
    expect(ok.status).toBe(303);
    expect(await row(oldest)).toMatchObject({ enrolled: true });
    expect((await logs(oldest))[0]).toMatchObject({ action: 'enrol', notes: 'owner test' });
    // put the owner's workspace back to legacy straight away
    expect((await post(oldest, 'unenrol', { notes: 'test over' })).status).toBe(303);
    expect((await row(oldest)).enrolled).toBe(false);
  });
  test('a workspace with existing data needs the existing-data confirmation', async () => {
    const refused = await post(wsData, 'enrol');
    expect(refused.status).toBe(422);
    expect(refused.text).toContain('already has data');
    expect(refused.text).toContain('customers');
    expect(await row(wsData)).toBeNull();
    expect(await logs(wsData)).toHaveLength(0);
    expect((await post(wsData, 'enrol', { confirmExistingData: 'on' })).status).toBe(303);
    expect(await row(wsData)).toMatchObject({ enrolled: true });
    expect(await logs(wsData)).toHaveLength(1);
  });
  test('enrol + admin-activate in one step (partner account)', async () => {
    const res = await post(wsMember, 'enrol', { activate: 'on', notes: 'Riyadh partner' });
    expect(res.status).toBe(303);
    const st = await row(wsMember);
    expect(st.subscription).toMatchObject({ state: 'active', source: 'admin' });
    expect(st.subscription.admin).toMatchObject({ active: true, by: 'staff', notes: 'Riyadh partner' });
    expect((await logs(wsMember))[0].action).toBe('enrol_activate');
  });
  test('an unknown workspace id is a 404 page and writes nothing', async () => {
    const ghost = 'e'.repeat(24);
    const res = await post(ghost, 'enrol');
    expect(res.status).toBe(404);
    expect(await row(ghost)).toBeNull();
    expect(await logs(ghost)).toHaveLength(0);
  });
});

describe('Admin-activate / deactivate / un-enrol / refresh / reconcile', () => {
  test('activate needs notes; it changes the effective subscription; deactivate puts it back; each is logged', async () => {
    expect((await post(ws1, 'activate')).status).toBe(422);
    expect((await row(ws1)).subscription.state).toBe('none');
    expect((await post(ws1, 'activate', { notes: 'Riyadh partner' })).status).toBe(303);
    expect((await row(ws1)).subscription).toMatchObject({ state: 'active', source: 'admin' });
    expect((await state.getGateState(ws1, { fresh: true })).sub.state).toBe('active');
    const page = (await get(`/${ws1}`)).text;
    expect(page).toContain('Admin activation');
    expect(page).toContain('Riyadh partner');
    expect((await post(ws1, 'deactivate')).status).toBe(303);
    expect((await row(ws1)).subscription.state).toBe('none');
    expect((await logs(ws1)).map((l) => l.action)).toEqual(['enrol', 'activate', 'deactivate']);
  });
  test('activating a workspace that is not enrolled is refused', async () => {
    const res = await post(wsPhoneOnly, 'activate', { notes: 'x' });
    expect(res.status).toBe(422);
    expect(await row(wsPhoneOnly)).toBeNull();
  });
  test('the connection panel: masked number and token-health flags only, never the token, PIN or full number; funnel numbers from real data', async () => {
    await state.ensureConnection(ws1);
    await WhatsAppConnection.updateOne({ workspaceId: ws1 }, {
      $set: {
        status: 'connected', 'ids.wabaId': 'W1', 'ids.phoneNumberId': 'P1', 'display.displayPhoneNumber': FULL_NUMBER, 'display.last4': '4567', 'display.verifiedName': 'Salon <b>X</b>',
        tokenEncrypted: 'v1:SECRET_TOKEN_CIPHERTEXT', pinEncrypted: 'v1:SECRET_PIN_CIPHERTEXT', tokenIsValid: true, tokenExpiresAt: new Date('2026-12-01T00:00:00Z'), tokenKeyVersion: 'abcd1234',
        nextCheckAt: new Date('2026-10-20T00:00:00Z'),
      },
    });
    const t = (await get(`/${ws1}`)).text;
    expect(t).toContain('*******4567');
    expect(t).not.toContain(FULL_NUMBER);
    expect(t).not.toMatch(/SECRET_TOKEN|SECRET_PIN|v1:/);
    expect(t).toContain('valid: yes');
    expect(t).toContain('Salon &lt;b&gt;X&lt;/b&gt;');
    expect(t).not.toContain('Salon <b>X</b>');
  });
  test('Refresh connection now: logged first, then nextCheckAt = now', async () => {
    const res = await post(ws1, 'refresh');
    expect(res.status).toBe(303);
    const conn = await WhatsAppConnection.findOne({ workspaceId: ws1 }).lean();
    expect(new Date(conn.nextCheckAt).getTime()).toBe(NOW.getTime());
    const entries = await logs(ws1, { action: 'refresh' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ adminUser: 'staff', notes: 'refresh connection now', ip: '203.0.113.9' });
    expect(entries[0].before.nextCheckAt).toBeTruthy();
    // no connection row -> refused, nothing logged
    const none = await post(wsMember, 'refresh');
    expect(none.status).toBe(422);
    expect(await logs(wsMember, { action: 'refresh' })).toHaveLength(0);
  });
  test('Reconcile billing now: logged first, then billing.refreshBilling for this workspace only', async () => {
    billing.refreshBilling.mockClear();
    const res = await post(ws1, 'reconcile');
    expect(res.status).toBe(303);
    expect(billing.refreshBilling).toHaveBeenCalledTimes(1);
    expect(billing.refreshBilling).toHaveBeenCalledWith({ workspaceId: ws1 });
    expect((await logs(ws1, { action: 'refresh' })).map((l) => l.notes)).toEqual(['refresh connection now', 'reconcile billing now']);
    billing.refreshBilling.mockRejectedValueOnce(Object.assign(new Error('stripe down'), { code: 'STRIPE_ERROR' }));
    const failed = await post(ws1, 'reconcile');
    expect(failed.status).toBe(502);
    expect(failed.text).toContain('STRIPE_ERROR');
    expect(await logs(ws1, { action: 'refresh' })).toHaveLength(3); // the attempt was recorded
  });
  test('the "no e-mail" warning for a phone-only owner, none for a workspace with an owner e-mail', async () => {
    expect((await post(wsPhoneOnly, 'enrol', { confirmExistingData: 'on' })).status).toBe(303);
    expect((await get(`/${wsPhoneOnly}`)).text).toContain('No e-mail on file');
    expect((await get(`/${wsMember}`)).text).not.toContain('No e-mail on file');
  });
  test('the funnel panel on the home page: real aggregation over events, subscription and connection counts', async () => {
    const ev = (type, code) => ({ workspaceId: ws1, type, code, step: 'connect' });
    await OnboardingEvent.create([ev('step_fail', 'ONB_NETWORK'), ev('step_fail', 'ONB_NETWORK'), ev('step_fail', 'ONB_NETWORK'), ev('connect_result', 'CONNECT_PARTIAL'), ev('step_enter')]);
    const t = (await get('/')).text;
    expect(t).toContain('Enrolled workspaces: <strong>4</strong>'); // ws1, wsData, wsMember, wsPhoneOnly (the owner workspace is un-enrolled again)
    expect(t).toMatch(/ONB_NETWORK<\/code><\/td><td>3</);
    expect(t).toMatch(/CONNECT_PARTIAL<\/code><\/td><td>1</);
    expect(t).not.toContain('ONB_NETWORK</code></td><td>4<');
    expect(t).toContain('connected');
  });
  test('Un-enrol: the row is kept (never deleted), it is inert at once, and it is logged; re-enrolling works', async () => {
    expect((await post(wsData, 'unenrol', { notes: 'pilot over' })).status).toBe(303);
    const st = await row(wsData);
    expect(st).toMatchObject({ enrolled: false, unenrolledBy: 'staff' });
    expect((await state.getGateState(wsData)).enrolled).toBe(false);
    expect((await logs(wsData)).map((l) => l.action)).toEqual(['enrol', 'unenrol']);
    expect((await get(`/${wsData}`)).text).toContain('Not enrolled');
    expect((await post(wsData, 'enrol', { confirmExistingData: 'on' })).status).toBe(303);
    expect((await row(wsData)).enrolled).toBe(true);
    expect(await OnboardingState.countDocuments({ workspaceId: wsData })).toBe(1);
  });
});

describe('the CLI against the same real database (flag OFF)', () => {
  const run = (argv) => cli.run(cli.parseArgs(argv), cli.buildDeps());

  test('list / status / funnel are read-only and show the oldest-workspace marker, masked number, no secrets', async () => {
    expect(config.enabled()).toBe(false);
    const list = await run(['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain(ws1);
    expect(list.out).toContain('[webhook workspace / owner]');
    expect(list.out).toContain(`${oldest}  Owner Workspace  un-enrolled`);
    const status = await run(['status', ws1]);
    expect(status.code).toBe(0);
    expect(status.out).toContain('*******4567');
    expect(status.out).not.toContain(FULL_NUMBER);
    expect(status.out).not.toMatch(/SECRET|v1:/);
    expect(status.out).toMatch(/e-mail on file/i); // ws1 has no members: the phone-only warning
    const funnel = await run(['funnel']);
    expect(funnel.code).toBe(0);
    expect(funnel.out).toContain('ONB_NETWORK=3');
    const missing = await run(['status', 'f'.repeat(24)]);
    expect(missing.code).toBe(1);
  });
  test('enrol --dry-run writes nothing at all', async () => {
    const before = [await OnboardingState.countDocuments({}), await OnboardingAdminLog.countDocuments({}), (await Workspace.findById(wsCli).lean()).onboarding.completed];
    const r = await run(['enrol', wsCli, '--dry-run', '--activate']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Nothing was written');
    expect([await OnboardingState.countDocuments({}), await OnboardingAdminLog.countDocuments({}), (await Workspace.findById(wsCli).lean()).onboarding.completed]).toEqual(before);
    const dryAll = await run(['unenrol', '--all', '--dry-run']);
    expect(dryAll.code).toBe(0);
    expect(await OnboardingState.countDocuments({ enrolled: true })).toBeGreaterThan(0);
  });
  test('the safeguards hold: oldest workspace exit 1 until --force-oldest; real enrol, activate, deactivate as cli:<user>', async () => {
    const refused = await run(['enrol', oldest]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain('--force-oldest');
    expect(await logs(oldest, { adminUser: /^cli:/ })).toHaveLength(0);
    const enrol = await run(['enrol', wsCli, '--notes', 'cli pilot']);
    expect(enrol.code).toBe(0);
    const st = await row(wsCli);
    expect(st.enrolled).toBe(true);
    expect(st.enrolledBy).toMatch(/^cli:/);
    expect((await logs(wsCli))[0]).toMatchObject({ action: 'enrol', ip: 'cli', notes: 'cli pilot' });
    expect((await logs(wsCli))[0].adminUser).toMatch(/^cli:/);
    expect((await run(['activate', wsCli, '--notes', 'Riyadh partner'])).code).toBe(0);
    expect((await row(wsCli)).subscription).toMatchObject({ state: 'active', source: 'admin' });
    expect((await run(['deactivate', wsCli])).code).toBe(0);
    expect((await row(wsCli)).subscription.state).toBe('none');
    expect((await logs(wsCli)).map((l) => l.action)).toEqual(['enrol', 'activate', 'deactivate']);
  });
  test('unenrol --all: every enrolled workspace is un-enrolled, rows are kept, each is logged, the gate is inert', async () => {
    const enrolledBefore = await OnboardingState.countDocuments({ enrolled: true });
    expect(enrolledBefore).toBeGreaterThanOrEqual(4);
    const totalBefore = await OnboardingState.countDocuments({});
    const logBefore = await OnboardingAdminLog.countDocuments({ action: 'unenrol' });
    const r = await run(['unenrol', '--all', '--notes', 'rollback drill']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Un-enrolled ${enrolledBefore} workspace(s)`);
    expect(await OnboardingState.countDocuments({ enrolled: true })).toBe(0);
    expect(await OnboardingState.countDocuments({})).toBe(totalBefore); // nothing deleted
    expect(await OnboardingAdminLog.countDocuments({ action: 'unenrol' })).toBe(logBefore + enrolledBefore);
    state.clearCache();
    for (const id of [ws1, wsData, wsMember, wsPhoneOnly, wsCli]) expect((await state.getGateState(id, { fresh: true })).enrolled).toBe(false);
    const again = await run(['unenrol', '--all']);
    expect(again.out).toContain('Un-enrolled 0 workspace(s)');
    const page = (await get('/')).text;
    expect(page).toContain('No workspace is enrolled.');
  });
});

describe('Meta data-deletion requests on the real database (review R7-11)', () => {
  const metaCallbacks = require('../../../shared/onboarding/metaCallbacks');
  const OnboardingInbound = require('../../../models/OnboardingInbound');
  const SECRET = 'itest-app-secret-0123456789abcdef';
  const signed = (payload) => {
    const part = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), ...payload })).toString('base64url');
    return `${crypto.createHmac('sha256', SECRET).update(part).digest('base64url')}.${part}`;
  };
  const delToken = (code) => crypto.createHmac('sha256', KEY).update(`staff:data-deletion:${code}:2026-10-15`).digest('hex');
  const mail = { sendDataDeletionNotice: jest.fn(async () => ({ sent: true })) };
  const run = (argv) => cli.run(cli.parseArgs(argv), cli.buildDeps());
  let callbacks;
  let linkedWs;

  const counts = async () => ({
    workspaces: await Workspace.countDocuments({}),
    states: await OnboardingState.countDocuments({}),
    conns: await WhatsAppConnection.countDocuments({}),
    customers: await mongoose.connection.collection('customers').countDocuments({}),
    inbound: await OnboardingInbound.countDocuments({}),
  });
  const callback = (sr) => request(callbacks).post('/onboarding-meta/data-deletion').type('form').send({ signed_request: sr });
  const markViaPage = (code, body = {}, token) => request(app).post(`${BASE}/data-deletion/${code}/done`).set('Authorization', AUTH).type('form')
    .send({ csrf: token === undefined ? delToken(code) : token, ...body });

  beforeAll(async () => {
    await Promise.all([OnboardingInbound.init(), OnboardingAdminLog.init()]);
    process.env.WA_APP_SECRET = SECRET;
    callbacks = express();
    callbacks.use('/onboarding-meta', metaCallbacks.createRouter({ appSecret: () => SECRET, email: mail }));
    linkedWs = await makeWorkspace('Linked to a Meta user', new Date('2026-10-06T00:00:00Z'));
    await WhatsAppConnection.create({ workspaceId: linkedWs, status: 'connected', ids: { wabaId: '7701700000001', phoneNumberId: '7701700000002', metaUserId: 'META_USER_LINKED' } });
  });
  beforeEach(() => { process.env.ONBOARDING_FLOW = 'on'; mail.sendDataDeletionNotice.mockClear(); });

  test('a verified request is listed for staff on the page and in the CLI; support is mailed ONCE per request; nothing is deleted', async () => {
    const before = await counts();
    const srA = signed({ user_id: 'META_USER_UNLINKED_A' });
    const a = await callback(srA);
    expect(a.status).toBe(200);
    const codeA = a.body.confirmation_code;
    expect(codeA).toMatch(/^[a-f0-9]{24}$/);
    expect((await callback(srA)).body.confirmation_code).toBe(codeA); // Meta retries the same request: the same code
    const codeB = (await callback(signed({ user_id: 'META_USER_LINKED' }))).body.confirmation_code;
    expect(codeB).not.toBe(codeA);
    expect(mail.sendDataDeletionNotice).toHaveBeenCalledTimes(2); // one mail per request, not per delivery
    expect(mail.sendDataDeletionNotice.mock.calls.map((c) => c[0])).toEqual([{ requestId: codeA }, { requestId: codeB }]);
    expect(JSON.stringify(mail.sendDataDeletionNotice.mock.calls)).not.toMatch(/META_USER|966/);
    expect(await OnboardingInbound.findById(`metacb:${codeB}`).lean()).toMatchObject({ type: 'data_deletion', status: 'processing', workspaceId: expect.anything() });

    const home = await get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('Meta data-deletion requests');
    expect(home.text).toContain(codeA);
    expect(home.text).toContain(codeB);
    expect(home.text).toContain(`action="${BASE}/data-deletion/${codeA}/done"`);
    expect(home.text).toContain(linkedWs); // the request that named a workspace's Meta user shows that workspace

    const list = await run(['list']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('OPEN Meta data-deletion requests: 2');
    expect(list.out).toContain(codeA);
    expect(list.out).toContain(codeB);
    const after = await counts();
    expect({ ...after, inbound: after.inbound - 2 }).toEqual(before); // the two ledger rows are the only change
  });

  test('"mark processed" on the page: a wrong or missing CSRF token changes nothing; a valid one logs FIRST, then marks the row done (nothing is deleted)', async () => {
    const code = (await callback(signed({ user_id: 'META_USER_PAGE' }))).body.confirmation_code;
    const logsBefore = await OnboardingAdminLog.countDocuments({});
    for (const bad of ['', 'x'.repeat(64), delToken('f'.repeat(24))]) {
      const r = await markViaPage(code, {}, bad);
      expect(r.status).toBe(403);
    }
    expect((await request(app).post(`${BASE}/data-deletion/${code}/done`).set('Authorization', AUTH).type('form').send({})).status).toBe(403);
    expect((await OnboardingInbound.findById(`metacb:${code}`).lean()).status).toBe('processing');
    expect(await OnboardingAdminLog.countDocuments({})).toBe(logsBefore);

    const before = await counts();
    const ok = await markViaPage(code, { notes: 'removed the customer rows by hand' });
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe(`${BASE}?done=deletion_done`);
    const row = await OnboardingInbound.findById(`metacb:${code}`).lean();
    expect(row.status).toBe('done');
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(row.outcome).toMatch(/^processed_by_staff/);
    const log = await OnboardingAdminLog.findOne({ action: 'data_deletion_done', target: `metacb:${code}` }).lean();
    expect(log).toMatchObject({ adminUser: 'staff', notes: 'removed the customer rows by hand', ip: '203.0.113.9', before: { status: 'processing' }, after: { status: 'done' } });
    expect(log.workspaceId).toBeUndefined(); // a request with no known workspace is logged without one (the schema allows it for this action only)
    expect(await OnboardingAdminLog.countDocuments({})).toBe(logsBefore + 1);
    expect(await counts()).toEqual(before); // nothing deleted, nothing created
    // idempotent: marking it again writes no second log row
    expect((await markViaPage(code)).status).toBe(303);
    expect(await OnboardingAdminLog.countDocuments({})).toBe(logsBefore + 1);
    // unknown code -> 404, a malformed one too
    expect((await markViaPage('a'.repeat(24))).status).toBe(404);
    expect((await request(app).post(`${BASE}/data-deletion/not-hex/done`).set('Authorization', AUTH).type('form').send({ csrf: 'x' })).status).toBe(404);
    // the page shows it as processed now (no form any more), the status URL says processed
    const home = await get('/?done=deletion_done');
    expect(home.text).toContain('The data-deletion request was marked processed.');
    expect(home.text).not.toContain(`/data-deletion/${code}/done`);
    const status = await request(callbacks).get(`/onboarding-meta/deletion-status?code=${code}`).set('Accept', 'text/html');
    expect(status.status).toBe(200);
    expect(status.text).toContain('has been processed');
  });

  test('"deletion-done" in the CLI: logged as the CLI user with the workspace the request named, idempotent, a bad id is a usage error', async () => {
    const code = (await callback(signed({ user_id: 'META_USER_LINKED', note: 'second request of the same user' }))).body.confirmation_code;
    const before = await counts();
    const r = await run(['deletion-done', code, '--notes', 'processed in the console']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Marked processed');
    expect(r.out).toContain('nothing was deleted');
    expect((await OnboardingInbound.findById(`metacb:${code}`).lean()).status).toBe('done');
    const log = await OnboardingAdminLog.findOne({ action: 'data_deletion_done', target: `metacb:${code}` }).lean();
    expect(log.adminUser).toMatch(/^cli:/);
    expect(log).toMatchObject({ ip: 'cli', notes: 'processed in the console' });
    expect(String(log.workspaceId)).toBe(linkedWs); // the request named a workspace: its id is on the audit row
    const again = await run(['deletion-done', code]);
    expect(again.code).toBe(0);
    expect(again.out).toContain('already marked processed');
    expect(await OnboardingAdminLog.countDocuments({ action: 'data_deletion_done', target: `metacb:${code}` })).toBe(1);
    expect(await counts()).toEqual(before);
    expect(() => cli.parseArgs(['deletion-done', 'nope'])).toThrow(cli.UsageError);
    const missing = await run(['deletion-done', 'b'.repeat(24)]);
    expect(missing.code).toBe(1);
    const list = await run(['list']);
    expect(list.out).not.toContain(`  ${code}  received`); // no longer open
  });

  test('a callback that fails verification records nothing and mails nobody', async () => {
    const before = await counts();
    const bad = await callback(signed({ user_id: 'META_USER_BAD' }).replace(/^./, 'A'));
    expect(bad.status).toBe(400);
    expect((await callback('garbage')).status).toBe(400);
    expect(mail.sendDataDeletionNotice).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });
});
