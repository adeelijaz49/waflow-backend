'use strict';
const express = require('express');
const request = require('supertest');
const realNotifications = require('../../../shared/onboarding/notifications');
const { createRouter } = require('../../../routes/onboarding/notifications');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';
const ID1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const ID2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function build(notifications, user = { id: 'u1', workspaceId: WS, role: 'member' }) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = typeof user === 'function' ? user(req) : user; next(); });
  app.use('/api/onboarding', createRouter({ notifications }));
  return app;
}
function mocks() {
  return {
    list: jest.fn(async () => [{ id: ID1, kind: 'connected', severity: 'success', titleKey: 'onboarding.notify.connected.title', bodyKey: 'onboarding.notify.connected.body', params: {}, actionPath: '/setup', createdAt: '2026-10-15T10:00:00.000Z', readAt: null }]),
    unreadCount: jest.fn(async () => 3),
    markRead: jest.fn(async () => ({ modified: 2 })),
  };
}

describe('GET /notifications', () => {
  test('returns the rows and the unread count; workspace comes from the token only', async () => {
    const m = mocks();
    const res = await request(build(m)).get('/api/onboarding/notifications').query({ workspaceId: WS2 });
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(3);
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0]).toMatchObject({ id: ID1, kind: 'connected', severity: 'success', titleKey: 'onboarding.notify.connected.title', readAt: null });
    expect(m.list).toHaveBeenCalledWith(WS, { unread: false, limit: 30 });
    expect(m.unreadCount).toHaveBeenCalledWith(WS);
  });
  test.each([
    [{ unread: '1' }, { unread: true, limit: 30 }],
    [{ unread: 'true' }, { unread: true, limit: 30 }],
    [{ unread: '0' }, { unread: false, limit: 30 }],
    [{ unread: 'yes' }, { unread: false, limit: 30 }],
    [{ limit: '5' }, { unread: false, limit: 5 }],
    [{ limit: '100' }, { unread: false, limit: 30 }],
    [{ limit: '0' }, { unread: false, limit: 1 }],
    [{ limit: '-4' }, { unread: false, limit: 1 }],
    [{ limit: 'abc' }, { unread: false, limit: 30 }],
    [{ unread: '1', limit: '10' }, { unread: true, limit: 10 }],
  ])('query %j -> %j', async (query, expected) => {
    const m = mocks();
    await request(build(m)).get('/api/onboarding/notifications').query(query);
    expect(m.list).toHaveBeenCalledWith(WS, expected);
  });
  test('array / object query values do not break it', async () => {
    const m = mocks();
    const res = await request(build(m)).get('/api/onboarding/notifications?limit[]=3&unread[$ne]=1');
    expect(res.status).toBe(200);
    expect(m.list).toHaveBeenCalledWith(WS, { unread: false, limit: 30 });
  });
  test('no verified workspace -> 404 ONBOARDING_NOT_AVAILABLE (never 401)', async () => {
    const res = await request(build(mocks(), null)).get('/api/onboarding/notifications');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('an unexpected failure is a generic 500 INTERNAL_ERROR without details', async () => {
    const m = mocks();
    m.list = jest.fn(async () => { throw new Error('secret db detail'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(build(m)).get('/api/onboarding/notifications');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('secret db detail');
  });
});

describe('POST /notifications/read', () => {
  test('ids: valid ids only, at most 100', async () => {
    const m = mocks();
    const many = Array.from({ length: 150 }, (_, i) => String(i).padStart(24, 'c'));
    const res = await request(build(m)).post('/api/onboarding/notifications/read').send({ ids: [ID1, 'nope', 5, null, ID2, ...many] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ modified: 2, unread: 3 });
    const ids = m.markRead.mock.calls[0][1].ids;
    expect(m.markRead.mock.calls[0][0]).toBe(WS);
    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 2)).toEqual([ID1, ID2]);
  });
  test('all:true marks everything of this workspace', async () => {
    const m = mocks();
    const res = await request(build(m)).post('/api/onboarding/notifications/read').send({ all: true, workspaceId: WS2 });
    expect(res.status).toBe(200);
    expect(m.markRead).toHaveBeenCalledWith(WS, { all: true });
  });
  test('only the literal true counts as all', async () => {
    const m = mocks();
    for (const all of ['true', 1, 'yes']) {
      expect((await request(build(m)).post('/api/onboarding/notifications/read').send({ all })).status).toBe(422);
    }
    expect(m.markRead).not.toHaveBeenCalled();
  });
  test('neither ids nor all -> 422 VALIDATION_FAILED; a body array too', async () => {
    const m = mocks();
    const a = await request(build(m)).post('/api/onboarding/notifications/read').send({});
    expect(a.status).toBe(422);
    expect(a.body.code).toBe('VALIDATION_FAILED');
    const b = await request(build(m)).post('/api/onboarding/notifications/read').send([ID1]);
    expect(b.status).toBe(422);
    expect(m.markRead).not.toHaveBeenCalled();
  });
  test('ids that are all invalid: nothing to mark, no write', async () => {
    const m = mocks();
    const res = await request(build(m)).post('/api/onboarding/notifications/read').send({ ids: ['x', 'y'] });
    expect(res.status).toBe(200);
    expect(res.body.modified).toBe(0);
    expect(m.markRead).not.toHaveBeenCalled();
  });
  test('no verified workspace -> 404', async () => {
    const res = await request(build(mocks(), null)).post('/api/onboarding/notifications/read').send({ all: true });
    expect(res.status).toBe(404);
  });
});

describe('with the real notifications module (fake model): tenant isolation', () => {
  function world() {
    const model = createFakeModel({ unique: [['workspaceId', 'dedupeKey']], defaults: { readAt: null, emailAttempts: 0 } });
    const n = realNotifications.createNotifications({ model, now: () => new Date('2026-10-15T11:00:00Z') });
    const wrapped = {
      list: (ws, o) => n.list(ws, o), unreadCount: (ws) => n.unreadCount(ws), markRead: (ws, o) => n.markRead(ws, o),
    };
    return { model, n, wrapped };
  }
  test('a workspace sees and clears only its own notifications', async () => {
    const { n, wrapped } = world();
    await n.notify({ workspaceId: WS, kind: 'connected', dedupeKey: 'a1' });
    await n.notify({ workspaceId: WS, kind: 'template_approved', dedupeKey: 'a2' });
    await n.notify({ workspaceId: WS2, kind: 'connected', dedupeKey: 'b1' });
    const appA = build(wrapped, { id: 'ua', workspaceId: WS });
    const appB = build(wrapped, { id: 'ub', workspaceId: WS2 });
    const listA = await request(appA).get('/api/onboarding/notifications');
    expect(listA.body.notifications).toHaveLength(2);
    expect(listA.body.unread).toBe(2);
    const listB = await request(appB).get('/api/onboarding/notifications');
    expect(listB.body.notifications).toHaveLength(1);
    // B tries to mark A's rows read by id, then everything: A's rows stay unread
    const aIds = listA.body.notifications.map((r) => r.id);
    const forged = await request(appB).post('/api/onboarding/notifications/read').send({ ids: aIds });
    expect(forged.body.modified).toBe(0);
    await request(appB).post('/api/onboarding/notifications/read').send({ all: true });
    expect((await request(appA).get('/api/onboarding/notifications?unread=1')).body.notifications).toHaveLength(2);
    expect((await request(appB).get('/api/onboarding/notifications?unread=1')).body.notifications).toHaveLength(0);
    // A marks one, then the rest
    const one = await request(appA).post('/api/onboarding/notifications/read').send({ ids: [aIds[0]] });
    expect(one.body).toEqual({ modified: 1, unread: 1 });
    const rest = await request(appA).post('/api/onboarding/notifications/read').send({ all: true });
    expect(rest.body).toEqual({ modified: 1, unread: 0 });
  });
  test('rows carry the C14 shape and newest first', async () => {
    const { n, wrapped, model } = world();
    await n.notify({ workspaceId: WS, kind: 'connected', dedupeKey: 'k1', severity: 'success', actionPath: '/setup/approvals', params: { a: 1 } });
    model.rows[0].createdAt = new Date('2026-10-15T09:00:00Z');
    await n.notify({ workspaceId: WS, kind: 'sending_paused', dedupeKey: 'k2', severity: 'warning' });
    model.rows[1].createdAt = new Date('2026-10-15T10:00:00Z');
    const res = await request(build(wrapped)).get('/api/onboarding/notifications');
    expect(res.body.notifications.map((r) => r.kind)).toEqual(['sending_paused', 'connected']);
    expect(Object.keys(res.body.notifications[1]).sort()).toEqual(['actionPath', 'bodyKey', 'createdAt', 'id', 'kind', 'params', 'readAt', 'severity', 'titleKey']);
    expect(res.body.notifications[1]).toMatchObject({ titleKey: 'onboarding.notify.connected.title', bodyKey: 'onboarding.notify.connected.body', actionPath: '/setup/approvals', params: { a: 1 }, severity: 'success' });
  });
});
