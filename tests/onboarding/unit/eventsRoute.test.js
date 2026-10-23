'use strict';
const express = require('express');
const request = require('supertest');
const realAnalytics = require('../../../shared/onboarding/analytics');
const realRateLimit = require('../../../shared/onboarding/rateLimit');
const { createRouter, buildEvent } = require('../../../routes/onboarding/events');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';

function setup({ user = { id: 'u1', workspaceId: WS, role: 'owner' }, track, limiterNow } = {}) {
  const model = createFakeModel();
  const calls = [];
  const analytics = {
    UI_EVENT_TYPES: realAnalytics.UI_EVENT_TYPES,
    UI_FAIL_CODES: realAnalytics.UI_FAIL_CODES,
    track: track || (async (ws, evt) => { calls.push([ws, evt]); return realAnalytics.track(ws, evt, { model, now: () => Date.parse('2026-10-15T10:00:00Z') }); }),
  };
  const limiter = realRateLimit.createLimiter({ now: limiterNow || (() => 1000) });
  const rateLimit = { middleware: (bucket, cfg) => realRateLimit.middleware(bucket, cfg, { limiter }) };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = typeof user === 'function' ? user(req) : user; next(); });
  app.use('/api/onboarding', createRouter({ analytics, rateLimit }));
  return { app, model, calls };
}
const post = (app, body) => request(app).post('/api/onboarding/events').send(body);

describe('POST /events whitelist', () => {
  test.each(['step_enter', 'step_complete', 'step_skip', 'help_opened'])('%s is stored (204), workspace from the token', async (type) => {
    const { app, model, calls } = setup();
    const res = await post(app, { type, step: 'connect', durationMs: 1500 });
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expect(calls).toEqual([[WS, { type, step: 'connect', durationMs: 1500 }]]);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({ type, step: 'connect', durationMs: 1500 });
  });
  test('step_fail needs one of the C4 client codes', async () => {
    const { app, model } = setup();
    for (const code of realAnalytics.UI_FAIL_CODES) expect((await post(app, { type: 'step_fail', step: 'connect', code })).status).toBe(204);
    expect(model.rows).toHaveLength(realAnalytics.UI_FAIL_CODES.length);
    expect(model.rows.map((r) => r.code).sort()).toEqual(realAnalytics.UI_FAIL_CODES.slice().sort());
    model.rows.length = 0;
    for (const body of [{ type: 'step_fail', step: 'connect' }, { type: 'step_fail', code: 'CONNECT_PARTIAL' }, { type: 'step_fail', code: 'onb_network' }, { type: 'step_fail', code: ['ONB_NETWORK'] }]) {
      expect((await post(app, body)).status).toBe(204);
    }
    expect(model.rows).toHaveLength(0);
  });
  test('unknown values are dropped silently with 204 (never an error)', async () => {
    const { app, model, calls } = setup();
    const bodies = [
      { type: 'connect_event' }, { type: 'admin' }, { type: 'payment_state' }, { type: 'nope' }, { type: 5 }, { type: ['step_enter'] }, {}, [], { type: { $ne: 1 } }, { type: null },
    ];
    for (const b of bodies) {
      const res = await request(app).post('/api/onboarding/events').set('Content-Type', 'application/json').send(JSON.stringify(b));
      expect(res.status).toBe(204);
    }
    expect(calls).toHaveLength(0);
    expect(model.rows).toHaveLength(0);
  });
  test('an unknown step on a known type keeps the event but drops the step', async () => {
    const { app, model } = setup();
    expect((await post(app, { type: 'step_enter', step: '<script>' })).status).toBe(204);
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0].step).toBeUndefined();
  });
  test('malformed JSON is the body parser\'s 400, never a stored event', async () => {
    const { app, model } = setup();
    const res = await request(app).post('/api/onboarding/events').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(model.rows).toHaveLength(0);
  });
});

describe('no PII reaches the store', () => {
  test('only type, step and durationMs are read; free text, reason, meta, ids and workspaceId are ignored', async () => {
    const { app, model } = setup();
    const res = await post(app, {
      type: 'step_complete', step: 'business', durationMs: 1200, code: 'SOME_CODE', reason: 'owner@example.test', workspaceId: WS2, userId: 'x',
      meta: { phone: '966501234567', path: 'A' }, name: 'Acme', phone: '966501234567', email: 'owner@example.test', message: 'hello',
    });
    expect(res.status).toBe(204);
    expect(model.rows).toHaveLength(1);
    const stored = model.rows[0];
    expect(String(stored.workspaceId)).toBe(WS);
    expect(Object.keys(stored).filter((k) => !['_id', 'createdAt'].includes(k)).sort()).toEqual(['at', 'durationMs', 'step', 'type', 'workspaceId']);
    expect(JSON.stringify(stored)).not.toMatch(/966501234567|owner@example|Acme|hello/);
  });
  test('buildEvent is pure and strict', () => {
    const a = { UI_EVENT_TYPES: realAnalytics.UI_EVENT_TYPES, UI_FAIL_CODES: realAnalytics.UI_FAIL_CODES };
    expect(buildEvent({ type: 'help_opened', step: 'number', durationMs: '5' }, a)).toEqual({ type: 'help_opened', step: 'number' });
    expect(buildEvent({ type: 'step_fail', code: 'ONB_NETWORK' }, a)).toEqual({ type: 'step_fail', code: 'ONB_NETWORK' });
    expect(buildEvent({ type: 'step_fail', code: 'ONB_NETWORK', reason: 'x' }, a)).toEqual({ type: 'step_fail', code: 'ONB_NETWORK' });
    expect(buildEvent({ type: 'step_enter', code: 'ONB_NETWORK' }, a)).toEqual({ type: 'step_enter' });
    expect(buildEvent(undefined, a)).toBeNull();
  });
});

describe('robustness and limits', () => {
  test('a failing analytics write still answers 204', async () => {
    const { app } = setup({ track: async () => { throw new Error('db down'); } });
    expect((await post(app, { type: 'step_enter', step: 'business' })).status).toBe(204);
  });
  test('no verified workspace on the request: 204, nothing written', async () => {
    const { app, model } = setup({ user: null });
    expect((await post(app, { type: 'step_enter', step: 'business' })).status).toBe(204);
    expect(model.rows).toHaveLength(0);
  });
  test('120 per minute per workspace, then 429 RATE_LIMITED with Retry-After; another workspace is unaffected; the window resets', async () => {
    let t = 1000;
    const { app } = setup({ user: (req) => ({ id: 'u', workspaceId: req.get('x-ws') || WS, role: 'owner' }), limiterNow: () => t, track: async () => {} });
    for (let i = 0; i < 120; i += 1) expect((await request(app).post('/api/onboarding/events').send({ type: 'step_enter' })).status).toBe(204);
    const blocked = await request(app).post('/api/onboarding/events').send({ type: 'step_enter' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(app).post('/api/onboarding/events').set('x-ws', WS2).send({ type: 'step_enter' })).status).toBe(204);
    t += 61 * 1000;
    expect((await request(app).post('/api/onboarding/events').send({ type: 'step_enter' })).status).toBe(204);
  });
  test('GET /events does not exist', () => {
    const { app } = setup();
    return request(app).get('/api/onboarding/events').then((res) => expect(res.status).toBe(404));
  });
});
