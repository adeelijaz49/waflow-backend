'use strict';
// Review R7-05: the 10-minute de-duplication of support requests is ATOMIC (a unique {workspaceId, kind, windowKey} index on the NEW
// OnboardingSupportRequest collection, E11000 = duplicate) and the route has an in-memory limiter in front: 50 simultaneous requests are
// ONE row and ONE e-mail to support.
const express = require('express');
const request = require('supertest');
const support = require('../../../shared/onboarding/support');
const stateModule = require('../../../shared/onboarding/state');
const rateLimit = require('../../../shared/onboarding/rateLimit');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390a2';
const USER = '507f1f77bcf86cd7994390b1';
const MIN = 60 * 1000;

beforeEach(() => stateModule.clearCache());

function kit(over = {}) {
  const clock = { t: Date.parse('2026-10-15T09:00:00Z') };
  const Req = createFakeModel({ unique: [['workspaceId', 'kind', 'windowKey']] });
  const origCreate = Req.create;
  Req.create = (doc) => origCreate({ ...doc, createdAt: new Date(clock.t) });
  const State = createFakeModel({ unique: [['workspaceId']] });
  State.seed({ workspaceId: WS, enrolled: true, subscription: { state: 'active' } });
  State.seed({ workspaceId: OTHER, enrolled: true, subscription: { state: 'active' } });
  const deps = {
    OnboardingState: State, OnboardingSupportRequest: Req, WhatsAppConnection: createFakeModel(),
    email: { sendSupportEmail: jest.fn(async () => { await new Promise((r) => setImmediate(r)); return { sent: true, id: 'em_1' }; }) },
    notifications: { notify: jest.fn(async () => ({ created: true })) },
    track: jest.fn(async () => {}),
    now: () => new Date(clock.t),
    ...over,
  };
  return { deps, Req, clock };
}
const create = (k, args = {}) => support.createSupportRequest({ workspaceId: WS, userId: USER, kind: 'number_help', step: 'number', ...args }, k.deps);

describe('the window key', () => {
  test('every row carries floor(now / 10 min) as its windowKey and the mail payload does not', async () => {
    const k = kit();
    const out = await create(k);
    expect(out.duplicate).toBe(false);
    expect(k.Req.rows).toHaveLength(1);
    expect(k.Req.rows[0].windowKey).toBe(String(Math.floor(k.clock.t / (10 * MIN))));
    expect(JSON.stringify(k.deps.email.sendSupportEmail.mock.calls[0][0])).not.toContain('windowKey');
  });
  test('the model declares the UNIQUE {workspaceId, kind, windowKey} index and every other index is unchanged', () => {
    const idx = require('../../../models/OnboardingSupportRequest').schema.indexes().map(([f, o]) => ({ f, unique: !!(o && o.unique) }));
    expect(idx).toEqual(expect.arrayContaining([{ f: { workspaceId: 1, kind: 1, windowKey: 1 }, unique: true }]));
    expect(idx.filter((i) => i.unique)).toHaveLength(1);
    expect(idx).toEqual(expect.arrayContaining([{ f: { workspaceId: 1, createdAt: -1 }, unique: false }, { f: { status: 1, createdAt: -1 }, unique: false }]));
    expect(idx).toHaveLength(3);
  });
});

describe('simultaneous requests are ONE row and ONE e-mail', () => {
  test.each([[2], [10], [50]])('%i simultaneous requests: 1 row, 1 e-mail, 1 created and the rest duplicates of that row', async (n) => {
    const k = kit();
    const results = await Promise.all(Array.from({ length: n }, () => create(k)));
    expect(k.Req.rows).toHaveLength(1);
    expect(k.deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
    expect(k.deps.notifications.notify).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate)).toHaveLength(n - 1);
    const id = results.find((r) => !r.duplicate).request.id;
    for (const r of results) expect(r.request.id).toBe(id);
  });
  test('sequential behaviour is unchanged: a repeat within 10 minutes is the same request, after 10 minutes a new one, 3 per day then 429', async () => {
    const k = kit();
    const first = await create(k);
    k.clock.t += 5 * MIN;
    const again = await create(k);
    expect(again.duplicate).toBe(true);
    expect(again.request.id).toBe(first.request.id);
    k.clock.t += 6 * MIN;
    const second = await create(k);
    expect(second.duplicate).toBe(false);
    k.clock.t += 11 * MIN;
    expect((await create(k)).duplicate).toBe(false);
    k.clock.t += 11 * MIN;
    await expect(create(k)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    expect(k.Req.rows).toHaveLength(3);
    expect(k.deps.email.sendSupportEmail).toHaveBeenCalledTimes(3);
  });
  test('other workspaces and other kinds are independent windows', async () => {
    const k = kit();
    const a = await create(k);
    const b = await create(k, { kind: 'help' });
    const c = await support.createSupportRequest({ workspaceId: OTHER, userId: USER, kind: 'number_help', step: 'number' }, k.deps);
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, false, false]);
    expect(k.Req.rows).toHaveLength(3);
  });
  test('an E11000 whose winner cannot be read is not swallowed (the error surfaces, nothing is mailed)', async () => {
    const k = kit();
    k.Req.create = async () => { throw Object.assign(new Error('E11000'), { code: 11000 }); };
    await expect(create(k)).rejects.toMatchObject({ code: 11000 });
    expect(k.deps.email.sendSupportEmail).not.toHaveBeenCalled();
  });
  test('any other create error is not mistaken for a duplicate', async () => {
    const k = kit();
    k.Req.create = async () => { throw Object.assign(new Error('db down'), { code: 'EDB' }); };
    await expect(create(k)).rejects.toMatchObject({ code: 'EDB' });
  });
});

describe('POST /number/support-request: the in-memory limiter in front of the DB-counted rules', () => {
  const numberRouter = require('../../../routes/onboarding/number');
  function app(k, limiter) {
    const a = express();
    a.use(express.json());
    a.use((req, res, next) => { req.user = { id: USER, workspaceId: WS, role: 'owner' }; next(); });
    a.use(numberRouter.createRouter({ ...k.deps, support, rateLimitDeps: { limiter } }));
    return a;
  }
  test('at most 10 attempts per 10 minutes per workspace, then 429 RATE_LIMITED with Retry-After; other workspaces are not affected', async () => {
    const k = kit();
    const limiter = rateLimit.createLimiter();
    const a = app(k, limiter);
    const codes = [];
    for (let i = 0; i < 12; i += 1) codes.push((await request(a).post('/number/support-request').send({})).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    const limited = await request(a).post('/number/support-request').send({});
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const other = express();
    other.use(express.json());
    other.use((req, res, next) => { req.user = { id: USER, workspaceId: OTHER, role: 'owner' }; next(); });
    other.use(numberRouter.createRouter({ ...k.deps, support, rateLimitDeps: { limiter } }));
    expect((await request(other).post('/number/support-request').send({})).status).toBe(200);
  });
  test('50 simultaneous HTTP requests: at most 10 get past the limiter and they make ONE row and ONE e-mail', async () => {
    const k = kit();
    const a = app(k, rateLimit.createLimiter());
    const res = await Promise.all(Array.from({ length: 50 }, () => request(a).post('/number/support-request').send({})));
    expect(res.filter((r) => r.status === 200).length).toBeLessThanOrEqual(10);
    expect(res.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(40);
    expect(k.Req.rows).toHaveLength(1);
    expect(k.deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
    const ids = new Set(res.filter((r) => r.status === 200).map((r) => r.body.requestId));
    expect(ids.size).toBe(1);
  });
});
