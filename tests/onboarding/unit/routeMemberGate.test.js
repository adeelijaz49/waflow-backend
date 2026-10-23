'use strict';
// Review R2-05: the gate-A routes that SPEND the merchant's Meta credentials or send (test-message, templates/submit + resubmit,
// connection/refresh, approvals payment-confirmed) check the LIVE Membership: a removed member's 30-day JWT gets 403 NOT_A_MEMBER and
// nothing reaches Meta. The check runs before the in-memory limiter (a removed member cannot use up the workspace's budget). Read-only
// routes and the owner-only routes are unchanged.
const express = require('express');
const request = require('supertest');
const rateLimit = require('../../../shared/onboarding/rateLimit');

const WS = '507f1f77bcf86cd799439011';
const MEMBER = '507f1f77bcf86cd799439021';
const REMOVED = '507f1f77bcf86cd799439022';

let savedFlag;
beforeEach(() => { savedFlag = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; });
afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

const gateDeps = (rows) => ({
  getGateState: async () => ({ enrolled: true, sub: { state: 'active', source: 'admin' }, conn: { status: 'connected', needsReconnect: false } }),
  Membership: { findOne: jest.fn((f) => ({ select: () => ({ lean: async () => rows.find((r) => String(r.userId) === String(f.userId) && String(r.workspaceId) === String(f.workspaceId)) || null }) })) },
});
function app(router, userId) {
  const a = express();
  a.use(express.json());
  a.use((req, res, next) => { req.user = { id: userId, workspaceId: WS, role: 'owner' }; next(); }); // a stale JWT that still says owner
  a.use(router);
  return a;
}
const members = [{ userId: MEMBER, workspaceId: WS, role: 'member' }];
const limiter = () => ({ limiter: rateLimit.createLimiter() });

describe('POST /templates/submit and /templates/:key/:language/resubmit', () => {
  const { createRouter } = require('../../../routes/onboarding/templates');
  function make() {
    const starterTemplates = {
      seedStarterTemplates: jest.fn(async () => ({})),
      submitQueued: jest.fn(async () => ({ submitted: 1, adopted: 0, failed: 0 })),
      resubmit: jest.fn(async () => ({ template: { key: 'comeback', language: 'en', status: 'pending' } })),
      listStatuses: jest.fn(async () => []),
      getCapacity: jest.fn(async () => ({})),
    };
    const gd = gateDeps(members);
    return { starterTemplates, gd, router: createRouter({ starterTemplates, gateDeps: gd, rateLimitDeps: limiter() }) };
  }
  test('a removed member: 403 NOT_A_MEMBER on both, nothing is queued or sent to Meta', async () => {
    const t = make();
    const a = app(t.router, REMOVED);
    const submit = await request(a).post('/templates/submit').send({});
    const resubmit = await request(a).post('/templates/comeback/en/resubmit').send({});
    expect([submit.status, resubmit.status]).toEqual([403, 403]);
    expect([submit.body.code, resubmit.body.code]).toEqual(['NOT_A_MEMBER', 'NOT_A_MEMBER']);
    expect(t.starterTemplates.seedStarterTemplates).not.toHaveBeenCalled();
    expect(t.starterTemplates.submitQueued).not.toHaveBeenCalled();
    expect(t.starterTemplates.resubmit).not.toHaveBeenCalled();
  });
  test('a current member goes through; the reads (GET /templates) are not gated by it', async () => {
    const t = make();
    const ok = await request(app(t.router, MEMBER)).post('/templates/submit').send({});
    expect(ok.status).toBe(200);
    const done = await request(app(t.router, MEMBER)).post('/templates/comeback/en/resubmit').send({});
    expect(done.status).toBe(200);
    const read = await request(app(t.router, REMOVED)).get('/templates');
    expect(read.status).toBe(200); // read-only: gate A (enrolled + paid) as before
    expect(t.gd.Membership.findOne).toHaveBeenCalledTimes(2);
  });
  test('the membership check comes BEFORE the limiter: a removed member cannot burn the workspace\'s 3 submits per hour', async () => {
    const t = make();
    for (let i = 0; i < 6; i += 1) await request(app(t.router, REMOVED)).post('/templates/submit').send({});
    for (let i = 0; i < 3; i += 1) expect((await request(app(t.router, MEMBER)).post('/templates/submit').send({})).status).toBe(200);
    expect((await request(app(t.router, MEMBER)).post('/templates/submit').send({})).status).toBe(429);
  });
});

describe('POST /connection/refresh', () => {
  const { createRouter } = require('../../../routes/onboarding/connection');
  function make() {
    const refresh = jest.fn(async () => ({ level: 'connected' }));
    const Connection = { findOne: () => ({ lean: async () => ({ status: 'connected', workspaceId: WS }) }) };
    const gd = gateDeps(members);
    return { refresh, router: createRouter({ Connection, statusRefresh: { refreshConnection: refresh, snapshot: () => ({ level: 'connected' }) }, gateDeps: gd, limiter: rateLimit.createLimiter() }) };
  }
  test('a removed member: 403 NOT_A_MEMBER and no refresh (no Graph call); a member refreshes; the limiter is not used up by the removed one', async () => {
    const t = make();
    for (let i = 0; i < 3; i += 1) {
      const res = await request(app(t.router, REMOVED)).post('/connection/refresh').send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
    }
    expect(t.refresh).not.toHaveBeenCalled();
    const ok = await request(app(t.router, MEMBER)).post('/connection/refresh').send({});
    expect(ok.status).toBe(200);
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect((await request(app(t.router, MEMBER)).post('/connection/refresh').send({})).status).toBe(429); // 1 per minute still holds
  });
  test('GET /connection stays a plain gate-A read', async () => {
    const t = make();
    expect((await request(app(t.router, REMOVED)).get('/connection')).status).toBe(200);
  });
});

describe('POST /approvals/payment-confirmed', () => {
  const { createRouter } = require('../../../routes/onboarding/approvals');
  function make() {
    const approvals = { confirmPayment: jest.fn(async () => ({ ok: true, payment: { status: 'merchant_confirmed' }, alreadyConfirmed: false })), buildApprovals: jest.fn(async () => ({ rows: [], overall: 'waiting', level: 'connected' })) };
    return { approvals, router: createRouter({ approvals, gateDeps: gateDeps(members), ownerGate: (req, res, next) => next(), rateLimitDeps: limiter() }) };
  }
  test('a removed member: 403 NOT_A_MEMBER, nothing attested; a member attests', async () => {
    const t = make();
    const bad = await request(app(t.router, REMOVED)).post('/approvals/payment-confirmed').send({ confirmed: true });
    expect(bad.status).toBe(403);
    expect(bad.body.code).toBe('NOT_A_MEMBER');
    expect(t.approvals.confirmPayment).not.toHaveBeenCalled();
    const ok = await request(app(t.router, MEMBER)).post('/approvals/payment-confirmed').send({ confirmed: true });
    expect(ok.status).toBe(200);
    expect(t.approvals.confirmPayment).toHaveBeenCalledTimes(1);
  });
  test('the approvals read stays open to any member of an enrolled workspace', async () => {
    const t = make();
    expect((await request(app(t.router, REMOVED)).get('/approvals')).status).toBe(200);
  });
});
