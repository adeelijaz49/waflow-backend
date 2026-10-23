'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_connectreview`;
assertThrowawayDb();

// Review fixes R2-01 / R2-04 / R7-03 / R7-08 on REAL models (throwaway mongod) with Meta replaced by fakeGraph:
//  - the platform's own WhatsApp account can never be connected, disconnected from, subscribed or written to by a merchant,
//  - a phone id the browser reports is only a hint: nobody can squat on another account's number,
//  - the claims a failed run took go back, a resume takes them again, somebody else's claim is never touched,
//  - connecting a DIFFERENT WhatsApp Business account (or number) resets what belonged to the old one.
const request = require('supertest');
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const state = require('../../../shared/onboarding/state');
const starter = require('../../../shared/onboarding/starterTemplates');
const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
const { createFakeGraph } = require('../_fixtures');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');

const { WhatsAppConnection, WhatsAppClaim } = H.models;
jest.setTimeout(90000);

let restoreEnv;
let seq = 0;
const nextCode = () => `AQDreviewSECRET${String(++seq).padStart(4, '0')}valueXYZ`;
const flat = (s) => Object.assign({ event: s.event }, s.data);
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted +pinEncrypted').lean();
const claimOf = (id) => WhatsAppClaim.findById(id).lean();
const names = (g) => g.calls.map((c) => c.name);
const WRITES = ['subscribe', 'unsubscribe', 'register', 'createTemplate', 'sendMessage', 'setDisplayName'];

const api = (w) => ({
  config: (t, who = 'owner') => request(w.app).get('/api/onboarding/connect/config').set(w.asUser(t, who)),
  complete: (t, attemptId, body = {}, who = 'owner') => request(w.app).post('/api/onboarding/connect/complete').set(w.asUser(t, who)).send({
    attemptId, code: body.code || nextCode(), session: body.session === undefined ? flat(w.graph.session('FINISH')) : body.session,
  }),
  resume: (t, who = 'owner') => request(w.app).post('/api/onboarding/connect/resume').set(w.asUser(t, who)).send({}),
  disconnectRequest: (t, who = 'owner') => request(w.app).post('/api/onboarding/connection/disconnect/request').set(w.asUser(t, who)).send({}),
  disconnect: (t, body, who = 'owner') => request(w.app).post('/api/onboarding/connection/disconnect').set(w.asUser(t, who)).send(body),
});

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([
    H.models.OnboardingState.init(), WhatsAppConnection.init(), WhatsAppClaim.init(), H.models.Membership.init(), OnboardingTemplate.init(),
  ]);
});
afterAll(async () => { restoreEnv(); await mongoose.disconnect(); });
beforeEach(() => state.clearCache());

/** The default world: the REAL starter-template module (seed, requeue) with a recorded submit, so the exact Graph calls of the connection stay visible. */
function world(opts = {}) {
  const w = H.createWorld(opts);
  w.api = api(w);
  return w;
}
async function begin(w, t) {
  const res = await w.api.config(t);
  expect(res.status).toBe(200);
  return res.body.attemptId;
}
const metaOf = (g) => createMetaGraphClient({ http: g.http, appId: g.ids.appId, appSecret: g.ids.appSecret });
async function disconnectNow(w, t) {
  const req = await w.api.disconnectRequest(t);
  expect(req.status).toBe(200);
  const res = await w.api.disconnect(t, { confirmationToken: req.body.confirmationToken, confirmText: 'DISCONNECT' });
  expect(res.status).toBe(200);
  return res;
}

describe('the platform account can never be connected by a merchant (review R2-01)', () => {
  const keep = { waba: process.env.WA_WABA_ID, phone: process.env.WA_PHONE_ID };
  afterEach(() => {
    for (const [k, v] of [['WA_WABA_ID', keep.waba], ['WA_PHONE_ID', keep.phone]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('the popup names the platform WABA: refused before the single-use code is spent; no claim, no token stored, no Graph call', async () => {
    const w = world();
    const t = await H.makeTenant('PlatformPopup');
    process.env.WA_WABA_ID = w.graph.ids.wabaId;
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(res.body.nextStep).toBe('number');
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(`platform|${w.graph.ids.wabaId}`, 'i'));
    expect(w.graph.calls).toHaveLength(0);
    expect(await WhatsAppClaim.countDocuments({ _id: { $in: [`waba:${w.graph.ids.wabaId}`, `phone:${w.graph.ids.phoneId}`] } })).toBe(0);
    const row = await connRow(t.ws);
    expect(row.tokenEncrypted).toBeUndefined();
    expect((row.ids || {}).wabaId).toBeUndefined();
  });

  test('the token owns the platform WABA (nothing named by the popup): refused at the debug-token step; no claim, the token is not kept, no write call, nothing to resume', async () => {
    const w = world();
    const t = await H.makeTenant('PlatformToken');
    process.env.WA_WABA_ID = w.graph.ids.wabaId;
    const res = await w.api.complete(t, await begin(w, t), { session: { event: 'FINISH' } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(res.body.details).toMatchObject({ step: 'debugToken', resumable: false });
    expect(names(w.graph)).toEqual(['exchange', 'debugToken']);
    expect(await WhatsAppClaim.countDocuments({ _id: `waba:${w.graph.ids.wabaId}` })).toBe(0);
    const row = await connRow(t.ws);
    expect(row.tokenEncrypted).toBeUndefined();
    expect(row.status).toBe('not_connected');
    expect(row.lastError).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT' });
    for (const n of WRITES) expect(w.graph.callsTo(n)).toHaveLength(0);
    const again = await w.api.resume(t);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('CONNECT_ATTEMPT_INVALID');
  });

  test('the platform PHONE id: listed by the merchant\'s WABA -> refused at the phone step, the WABA claim goes back, no register / subscribe', async () => {
    const w = world();
    const t = await H.makeTenant('PlatformPhone');
    process.env.WA_PHONE_ID = w.graph.ids.phoneId;
    const res = await w.api.complete(t, await begin(w, t), { session: { event: 'FINISH', waba_id: w.graph.ids.wabaId } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(names(w.graph)).toEqual(['exchange', 'debugToken', 'listPhones']);
    expect(await claimOf(`phone:${w.graph.ids.phoneId}`)).toBeNull();
    const waba = await claimOf(`waba:${w.graph.ids.wabaId}`);
    expect(waba.releasedAt).toBeTruthy(); // taken by this run, given back; the row is kept (nothing is ever deleted)
    const row = await connRow(t.ws);
    expect(row.tokenEncrypted).toBeUndefined();
    expect((row.ids || {}).phoneNumberId).toBeFalsy();
    for (const n of WRITES) expect(w.graph.callsTo(n)).toHaveLength(0);
  });

  test('ids stored before the platform account was configured: a re-run is refused before any call and a disconnect makes no unsubscribe call', async () => {
    const w = world();
    const t = await H.makeTenant('PlatformLater');
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    w.graph.calls.length = 0;
    process.env.WA_WABA_ID = w.graph.ids.wabaId; // the platform account turns out to be this very WABA
    const cfg = await request(w.app).post('/api/onboarding/connection/reconnect').set(w.asUser(t)).send({});
    expect(cfg.status).toBe(200);
    const refused = await w.api.complete(t, cfg.body.attemptId);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(w.graph.calls).toHaveLength(0);
    await disconnectNow(w, t);
    expect(w.graph.callsTo('unsubscribe')).toHaveLength(0); // that would remove the production webhook subscription
    expect((await connRow(t.ws)).status).toBe('disconnected');
  });

  test('a merchant account is still connected normally while platform ids of OTHER accounts are configured', async () => {
    const w = world();
    const t = await H.makeTenant('PlatformOther');
    process.env.WA_WABA_ID = '999000999000999';
    process.env.WA_PHONE_ID = '999000999000998';
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
  });
});

describe('claims (reviews R7-08 / R2-04)', () => {
  test('the phone id the browser reports is a HINT: nobody can squat on another account\'s number, and its owner connects normally afterwards', async () => {
    const victimGraph = createFakeGraph(H.uniqueIds());
    const w = world();
    const attacker = await H.makeTenant('Squatter');
    const victim = await H.makeTenant('Victim');
    // the attacker's own token owns ITS WABA only, but the popup report names the victim's phone id
    const forged = { event: 'FINISH', waba_id: w.graph.ids.wabaId, phone_number_id: victimGraph.ids.phoneId };
    const res = await w.api.complete(attacker, await begin(w, attacker), { session: forged });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_WABA_MISMATCH');
    expect(names(w.graph)).toEqual(['exchange', 'debugToken', 'listPhones']);
    expect(await claimOf(`phone:${victimGraph.ids.phoneId}`)).toBeNull(); // never claimed
    expect(((await connRow(attacker.ws)).ids || {}).phoneNumberId).toBeFalsy();
    // the real owner of that number connects without any trouble
    w.connectDeps.meta = metaOf(victimGraph);
    const ok = await w.api.complete(victim, await begin(w, victim), { session: flat(victimGraph.session('FINISH')) });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('connected');
    expect((await claimOf(`phone:${victimGraph.ids.phoneId}`)).workspaceId.toString()).toBe(victim.ws);
    expect((await connRow(victim.ws)).ids.phoneNumberId).toBe(victimGraph.ids.phoneId);
  });

  test('a failure after the claims were taken gives them back (rows stay); the resume takes them again from the stored ids and finishes', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('ReleaseResume');
    w.graph.scenarios.register133016();
    const res = await w.api.complete(t, await begin(w, t));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('CONNECT_REGISTER_RATE_LIMITED');
    for (const id of [`waba:${w.graph.ids.wabaId}`, `phone:${w.graph.ids.phoneId}`]) {
      const c = await claimOf(id);
      expect(c).toBeTruthy();
      expect(c.workspaceId.toString()).toBe(t.ws);
      expect(c.releasedAt).toBeTruthy();
    }
    expect((await connRow(t.ws)).ids.phoneNumberId).toBe(w.graph.ids.phoneId); // verified before the failing step: kept for the resume
    const ok = await w.api.resume(t);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('connected');
    for (const id of [`waba:${w.graph.ids.wabaId}`, `phone:${w.graph.ids.phoneId}`]) {
      const c = await claimOf(id);
      expect(c.workspaceId.toString()).toBe(t.ws);
      expect(c.releasedAt).toBeNull();
    }
    expect(await WhatsAppClaim.countDocuments({ _id: { $in: [`waba:${w.graph.ids.wabaId}`, `phone:${w.graph.ids.phoneId}`] } })).toBe(2);
  });

  test('another account taking the released number before the resume wins: the resume stops with the definitive code and never touches that claim', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('LostToOther');
    const other = await H.makeTenant('TookIt');
    w.graph.scenarios.register133016();
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(429);
    const phoneKey = `phone:${w.graph.ids.phoneId}`;
    await WhatsAppClaim.updateOne({ _id: phoneKey }, { $set: { workspaceId: other.ws, releasedAt: null, claimedAt: new Date() } }); // the other account's successful claim
    const res = await w.api.resume(t);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    const phone = await claimOf(phoneKey);
    expect(phone.workspaceId.toString()).toBe(other.ws);
    expect(phone.releasedAt).toBeNull();
    expect((await claimOf(`waba:${w.graph.ids.wabaId}`)).releasedAt).toBeTruthy(); // the claim this resume took went back again
    expect(w.graph.callsTo('register')).toHaveLength(1); // no second register for a number that is no longer ours
  });

  test('two accounts racing for one WABA: exactly one wins; the loser releases nothing of the winner\'s and can resume once it is free', async () => {
    const w = world();
    const a = await H.makeTenant('RaceA');
    const b = await H.makeTenant('RaceB');
    const [ca, cb] = await Promise.all([begin(w, a), begin(w, b)]);
    const [ra, rb] = await Promise.all([w.api.complete(a, ca), w.api.complete(b, cb)]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const loser = ra.status === 200 ? b : a;
    const waba = await claimOf(`waba:${w.graph.ids.wabaId}`);
    expect(waba.workspaceId.toString()).toBe(winner.ws);
    expect(waba.releasedAt).toBeNull();
    expect((await claimOf(`phone:${w.graph.ids.phoneId}`)).workspaceId.toString()).toBe(winner.ws);
    const lost = await connRow(loser.ws);
    expect(lost.status).toBe('connecting');
    expect((lost.ids || {}).phoneNumberId).toBeFalsy();
    await disconnectNow(w, winner);
    const ok = await w.api.resume(loser);
    expect(ok.status).toBe(200);
    expect((await claimOf(`waba:${w.graph.ids.wabaId}`)).workspaceId.toString()).toBe(loser.ws);
  });
});

describe('another Meta account or number must not inherit the old one\'s state (review R7-03)', () => {
  test('a different WhatsApp Business account: payment confirmation, verification, health, name, registration and PIN reset; templates queued again for the new account; register runs', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('SwitchAccount');
    const gA = w.graph;
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    expect(gA.callsTo('register')).toHaveLength(1);
    // account A's templates were submitted (and one approved); the owner confirmed payment; Meta verified the business
    const clientA = metaOf(gA);
    for (let i = 0; i < 3; i += 1) await starter.submitQueued({ workspaceId: t.ws }, { metaClient: clientA });
    const submittedA = await OnboardingTemplate.find({ workspaceId: t.ws, metaTemplateName: { $exists: true } }).lean();
    expect(submittedA.length).toBeGreaterThan(0);
    submittedA.forEach((r) => expect(r.wabaId).toBe(gA.ids.wabaId));
    await OnboardingTemplate.updateOne({ _id: submittedA[0]._id }, { $set: { metaStatus: 'APPROVED' } });
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, {
      $set: {
        'payment.status': 'confirmed', 'payment.confirmedAt': new Date(), 'verification.mapped': 'done', 'verification.businessRaw': 'verified',
        'displayName.mapped': 'done', 'displayName.name': 'Shop A', 'health.canSend': 'AVAILABLE',
      },
    });
    const pinBefore = (await connRow(t.ws)).pinEncrypted;
    await disconnectNow(w, t);

    // account B answers the next popup
    const gB = createFakeGraph({ ...H.uniqueIds(), phoneStatus: 'PENDING' });
    w.connectDeps.meta = metaOf(gB);
    const res = await w.api.complete(t, await begin(w, t), { session: flat(gB.session('FINISH')) });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('connected');
    const row = await connRow(t.ws);
    expect(row.ids).toMatchObject({ wabaId: gB.ids.wabaId, phoneNumberId: gB.ids.phoneId });
    expect(row.payment.status).toBe('unknown'); // A's confirmation says nothing about B
    expect(row.payment.confirmedAt).toBeUndefined();
    expect(row.displayName.name).toBeUndefined();
    expect(gB.callsTo('register')).toHaveLength(1); // B's number is registered although A's registration was on record
    expect(row.registration.attempts).toBe(1);
    expect(row.pinEncrypted).toBeTruthy();
    expect(row.pinEncrypted).not.toBe(pinBefore); // a PIN of its own
    // the templates of A do not exist on B: every row of the workspace is queued again and carries B's id
    const rows = await OnboardingTemplate.find({ workspaceId: t.ws }).lean();
    expect(rows.length).toBe(16);
    for (const r of rows) {
      expect(r.wabaId).toBe(gB.ids.wabaId);
      expect(r.revision).toBe(1);
      expect(r.attempts).toBe(0);
      expect(r.metaTemplateName).toBeUndefined();
      expect(r.metaTemplateId).toBeUndefined();
      expect(r.metaStatus).toBeUndefined();
    }
    // ... and they are submitted to B with B's token, never to A
    const callsA = gA.calls.length;
    for (let i = 0; i < 3; i += 1) await starter.submitQueued({ workspaceId: t.ws }, { metaClient: metaOf(gB) });
    expect(gA.calls.length).toBe(callsA);
    expect(gB.callsTo('createTemplate').length).toBeGreaterThanOrEqual(8);
    // A's claims were given back by the disconnect, B's are held
    expect((await claimOf(`waba:${gA.ids.wabaId}`)).releasedAt).toBeTruthy();
    expect((await claimOf(`waba:${gB.ids.wabaId}`)).releasedAt).toBeNull();
    expect((await claimOf(`phone:${gB.ids.phoneId}`)).workspaceId.toString()).toBe(t.ws);
  });

  test('another number of the SAME account: the registration and name of the old number are reset, the account\'s own state stays, the templates are not re-queued', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('SwitchNumber');
    const gA = w.graph;
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    await starter.submitQueued({ workspaceId: t.ws }, { metaClient: metaOf(gA) });
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { 'payment.status': 'confirmed', 'payment.confirmedAt': new Date(), 'displayName.name': 'Shop A' } });
    await disconnectNow(w, t);
    const gB = createFakeGraph({ wabaId: gA.ids.wabaId, phoneId: `${gA.ids.phoneId}9`, businessId: gA.ids.businessId, phoneStatus: 'PENDING' });
    w.connectDeps.meta = metaOf(gB);
    const res = await w.api.complete(t, await begin(w, t), { session: flat(gB.session('FINISH')) });
    expect(res.status).toBe(200);
    const row = await connRow(t.ws);
    expect(row.ids.phoneNumberId).toBe(gB.ids.phoneId);
    expect(gB.callsTo('register')).toHaveLength(1);
    expect(row.payment.status).toBe('confirmed'); // same WABA: the billing confirmation still describes this account
    expect(row.displayName.name).toBeUndefined(); // the name belonged to the old number
    const submitted = await OnboardingTemplate.countDocuments({ workspaceId: t.ws, metaTemplateName: { $exists: true } });
    expect(submitted).toBeGreaterThan(0); // the templates live on the account, not on the number
  });

  test('reconnecting the same account and number resets nothing', async () => {
    const w = world({ graphOptions: { phoneStatus: 'PENDING' } });
    const t = await H.makeTenant('SwitchNone');
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    await starter.submitQueued({ workspaceId: t.ws }, { metaClient: metaOf(w.graph) });
    await WhatsAppConnection.updateOne({ workspaceId: t.ws }, { $set: { 'payment.status': 'confirmed', 'payment.confirmedAt': new Date() } });
    await disconnectNow(w, t);
    expect((await w.api.complete(t, await begin(w, t))).status).toBe(200);
    expect((await connRow(t.ws)).payment.status).toBe('confirmed');
    expect(await OnboardingTemplate.countDocuments({ workspaceId: t.ws, metaTemplateName: { $exists: true } })).toBeGreaterThan(0);
  });
});
