'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
// each suite gets its OWN database so suites in one jest run never see each other's workspaces
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_csub`;
assertThrowawayDb();

// IMMEDIATE TEMPLATE SUBMISSION AFTER CONNECT (I5 G6). A completed connection seeds the starter templates AND hands the first 5
// to Meta at once (connect.js -> starterTemplates.submitQueued({ workspaceId, max: 5 }), best effort, never awaited) instead of
// waiting for the next scheduler tick. REAL connect + starterTemplates + models on the throwaway mongod; Meta Graph = fakeGraph.
// Nothing here talks to a real service.
const request = require('supertest');
const mongoose = require('mongoose');
const H = require('./_connectHarness');
const { fullWorld, connectedTenant, nextCode, flat } = require('./_crossHarness');
const state = require('../../../shared/onboarding/state');
const connectMod = require('../../../shared/onboarding/connect');
const starterTemplates = require('../../../shared/onboarding/starterTemplates');
const webhookEvents = require('../../../shared/onboarding/webhookEvents');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');

const { WhatsAppConnection, WhatsAppClaim, OnboardingState, Membership } = H.models;
jest.setTimeout(90000);

let restoreEnv;
const connRow = (ws) => WhatsAppConnection.findOne({ workspaceId: ws }).select('+tokenEncrypted').lean();
const templates = (ws) => OnboardingTemplate.find({ workspaceId: ws }).lean();
const notes = (ws) => OnboardingNotification.find({ workspaceId: ws }).lean();
const posts = (w) => w.graph.callsTo('createTemplate');

beforeAll(async () => {
  restoreEnv = H.setEnv();
  await mongoose.connect(process.env.MONGODB_URI);
  await Promise.all([OnboardingState.init(), WhatsAppConnection.init(), WhatsAppClaim.init(), Membership.init(), OnboardingNotification.init(), OnboardingTemplate.init(), OnboardingEvent.init()]);
});
afterAll(async () => { restoreEnv(); await mongoose.disconnect(); });
beforeEach(() => { state.clearCache(); webhookEvents.clearMemo(); });

describe('a completed connect: the template POSTs happen', () => {
  test('5 English starter templates reach the merchant WABA right after the answer (merchant token only, the setup test first); the rest stays queued', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit happy');
    const done = await t.complete();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', level: 'connected', nextStep: 'approvals' });

    const sent = posts(w);
    expect(sent).toHaveLength(5);
    for (const c of sent) {
      expect(c.tokenKind).toBe('merchant');
      expect(c.token).toBe(w.graph.ids.merchantToken);
      expect(c.status).toBe(200);
      expect(c.data.name).toMatch(/^wf_[0-9a-f]{6}_[a-z_]+_en_v1$/);
      expect(c.data.language).toBe('en');
    }
    expect(new Set(sent.map((c) => c.data.name)).size).toBe(5);
    w.graph.assertMerchantTokenOnly(w.graph.ids.merchantToken); // throws on any other token

    const rows = await templates(t.ws);
    const withMeta = rows.filter((r) => r.metaTemplateId);
    expect(withMeta).toHaveLength(5);
    expect(withMeta.every((r) => r.language === 'en' && r.metaStatus === 'PENDING' && r.submittedAt && !r.submitClaimedAt)).toBe(true);
    const queued = rows.filter((r) => !r.metaTemplateId && !r.blockedReason);
    expect(queued).toHaveLength(3); // 8 English rows (7 starter keys + the setup test) minus the 5 sent
    expect(queued.every((r) => r.language === 'en')).toBe(true);
    expect(rows.filter((r) => r.language === 'ar').every((r) => r.blockedReason)).toBe(true); // English-only merchant: Arabic stays blocked

    // the merchant sees it through the API at once: 5 waiting on Meta, 3 queued
    const list = await w.get(t, '/templates');
    expect(list.status).toBe(200);
    expect(list.body.templates.filter((r) => r.language === 'en' && r.status === 'pending')).toHaveLength(5);
    expect(list.body.templates.filter((r) => r.language === 'en' && r.status === 'queued')).toHaveLength(3);
  });

  test('the scheduler tick that follows submits the rest and NEVER a row twice (claim-protected), even when ticks overlap', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit then tick');
    await t.complete();
    expect(posts(w)).toHaveLength(5);
    await Promise.all([1, 2, 3].map(() => starterTemplates.submitPending({ workspaceId: t.ws }, { metaClient: w.meta })));
    const names = posts(w).map((c) => c.data.name);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8); // every template exactly once
    expect((await templates(t.ws)).filter((r) => r.metaTemplateId)).toHaveLength(8);
    // nothing is left to hand over: a later call costs no Graph request
    await starterTemplates.submitQueued({ workspaceId: t.ws, max: 5 }, { metaClient: w.meta });
    expect(posts(w)).toHaveLength(8);
  });

  test('a replay of the finished attempt and a resume of the connected workspace submit nothing again', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit replay');
    const first = await t.complete();
    expect(posts(w)).toHaveLength(5);
    const replay = await w.post(t, '/connect/complete', { attemptId: t.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    const resume = await w.post(t, '/connect/resume', {});
    await connectMod._internal.idle();
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(resume.status).toBe(200);
    expect(posts(w)).toHaveLength(5);
  });
});

describe('a failing submission leaves the connect result untouched', () => {
  test('a network drop on every template POST: the answer, the stored result, the replay, step 3 and the notification are exactly as without it; the rows stay queued and the next tick submits them', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit network drop');
    w.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'createTemplate', times: 5 });
    const done = await t.complete();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', level: 'connected', nextStep: 'approvals', connection: { needsReconnect: false } });
    expect(posts(w)).toHaveLength(5); // the five POSTs were tried, all dropped
    expect(posts(w).every((c) => c.networkError)).toBe(true);

    const conn = await connRow(t.ws);
    expect(conn.status).toBe('connected');
    expect(conn.needsReconnect).toBe(false);
    expect(conn.connectAttempt.result).toEqual(done.body); // the stored result is the answer
    expect(conn.connectLockUntil).toBeNull();
    const replay = await w.post(t, '/connect/complete', { attemptId: t.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(done.body);
    const st = (await w.get(t, '/state')).body;
    expect(st).toMatchObject({ nextStep: 'approvals', steps: { connect: { status: 'done' } }, connection: { level: 'connected', status: 'connected' } });
    expect((await notes(t.ws)).filter((n) => n.kind === 'connected')).toHaveLength(1);

    const rows = await templates(t.ws);
    expect(rows.filter((r) => r.metaTemplateId)).toHaveLength(0);
    const tried = rows.filter((r) => r.attempts === 1);
    expect(tried).toHaveLength(5);
    expect(tried.every((r) => r.lastErrorCode === 'META_UNREACHABLE' && !r.submitClaimedAt)).toBe(true); // a code only, the claim is released

    // the fault is over: the regular tick submits everything, no template twice
    await starterTemplates.submitPending({ workspaceId: t.ws }, { metaClient: w.meta });
    await starterTemplates.submitPending({ workspaceId: t.ws }, { metaClient: w.meta });
    const final = await templates(t.ws);
    expect(final.filter((r) => r.metaTemplateId)).toHaveLength(8);
    const okNames = posts(w).filter((c) => c.status === 200).map((c) => c.data.name);
    expect(new Set(okNames).size).toBe(okNames.length);
  });

  test('Meta rate-limits one of the template POSTs: the rest of the batch goes through, the connection is untouched', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit rate limited');
    w.graph.scenarios.rateLimited(4, { match: 'createTemplate', times: 1 });
    const done = await t.complete();
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('connected');
    const conn = await connRow(t.ws);
    expect(conn).toMatchObject({ status: 'connected', needsReconnect: false });
    const rows = await templates(t.ws);
    expect(rows.filter((r) => r.metaTemplateId)).toHaveLength(4); // one POST was refused, the other four of the batch went through
    const refused = rows.filter((r) => !r.metaTemplateId && r.attempts === 1);
    expect(refused).toHaveLength(1);
    expect(refused[0].lastErrorCode).toMatch(/^META_/);
    expect(refused[0].submitClaimedAt).toBeFalsy();
  });

  test('a token Meta calls revoked during the immediate submission flips the connection through the EXISTING path (one reconnect notification); the connect answer itself was already "connected"', async () => {
    const w = fullWorld();
    const t = await connectedTenant(w, 'Submit revoked');
    w.graph.failNext('createTemplate', { code: 190, subcode: 463, message: 'Error validating access token: Session has expired' }, { times: 1 });
    const done = await t.complete();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'connected', nextStep: 'approvals' });
    expect(posts(w)).toHaveLength(1); // the run stopped at the first dead-token answer
    const conn = await connRow(t.ws);
    expect(conn).toMatchObject({ needsReconnect: true, status: 'reconnect_required', reconnectReason: 'TOKEN_EXPIRED' });
    const kinds = (await notes(t.ws)).map((n) => n.kind).sort();
    expect(kinds).toEqual(['connected', 'reconnect_needed']);
    // a replay answers with the CURRENT status (the existing behaviour), never a second submission
    const replay = await w.post(t, '/connect/complete', { attemptId: t.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ status: 'reconnect_required', level: 'reconnect_needed' });
    await connectMod._internal.idle();
    expect(posts(w)).toHaveLength(1);
  });
});

describe('when nothing is submitted', () => {
  test('a connection without a number yet (waba_only) submits nothing; the number that arrives later completes it and submits then', async () => {
    const w = fullWorld();
    w.graph.scenarios.finishOnlyWaba();
    const t = await connectedTenant(w, 'Submit waba only', 'FINISH_ONLY_WABA');
    const done = await t.complete();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'waba_only', nextStep: 'connect' });
    expect(posts(w)).toHaveLength(0);
    expect((await templates(t.ws)).filter((r) => r.language === 'en' && !r.blockedReason)).toHaveLength(8); // seeded, waiting in the queue
    // the merchant adds the number at Meta, the owner resumes: the connection completes and the templates go out
    w.graph.addPhone();
    const resumed = await w.post(t, '/connect/resume', {});
    await connectMod._internal.idle();
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe('connected');
    expect(posts(w)).toHaveLength(5);
  });

  test('an unpaid (past_due) workspace is not touched: the resume completes the connection but no template is sent for it', async () => {
    const w = fullWorld();
    w.graph.scenarios.finishOnlyWaba();
    const t = await connectedTenant(w, 'Submit past due', 'FINISH_ONLY_WABA');
    await t.complete();
    expect(posts(w)).toHaveLength(0);
    await OnboardingState.updateOne({ workspaceId: t.ws }, { $set: { 'subscription.state': 'past_due', 'subscription.source': 'stripe' } });
    state.invalidate(t.ws);
    w.graph.addPhone();
    // a system resume (what the scheduler does for a stuck run) is not gated by the HTTP layer
    const resumed = await connectMod.resumeConnect({ workspaceId: t.ws, userId: t.owner, system: true }, w.connectDeps);
    await connectMod._internal.idle();
    expect(resumed.status).toBe('connected');
    expect(posts(w)).toHaveLength(0);
  });
});

describe('the connect module has no new way to be slow or to leak', () => {
  test('the answer does not wait for the Graph calls of the submission (a slow Meta only delays the background job)', async () => {
    const w = fullWorld({ graphOptions: {} });
    const t = await connectedTenant(w, 'Submit slow');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const real = w.connectDeps.starterTemplates.submitQueued;
    let started = false;
    w.connectDeps.starterTemplates = { ...w.connectDeps.starterTemplates, submitQueued: async (a) => { started = true; await gate; return real(a); } };
    const done = await request(w.app).post('/api/onboarding/connect/complete').set(w.asUser(t)).send({ attemptId: t.attemptId, code: nextCode(), session: flat(w.graph.session('FINISH')) });
    expect(done.status).toBe(200); // returned while the job is still parked
    expect(done.body.status).toBe('connected');
    await new Promise((r) => setImmediate(r));
    expect(started).toBe(true);
    expect(posts(w)).toHaveLength(0);
    release();
    await connectMod._internal.idle();
    expect(posts(w)).toHaveLength(5);
  });
});
