'use strict';
// Staff page routes/adminOnboarding.js: the real router with injected fakes (no database, no network).
// Auth is the mount's job (requireInternalAdmin), so a stub sets req.adminIp; the Basic Authorization
// header carries the admin user name that the CSRF token is bound to.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const realState = require('../../../shared/onboarding/state');
const { OnbError } = require('../../../shared/onboarding/errors');
const { createFakeModel } = require('./_b0Store');

const BASE = '/internal-admin-onboarding';
const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OLDEST = 'cccccccccccccccccccccccc';
const OTHER_WS = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY = 'test-admin-password';
const AUTH = `Basic ${Buffer.from('staff:whatever').toString('base64')}`;
const NOW = new Date('2026-10-15T10:00:00Z');

function chain(value, calls, name, filter) {
  const rec = { name, filter, ops: [] };
  calls.push(rec);
  const q = {};
  for (const m of ['select', 'limit', 'sort', 'lean']) q[m] = (...a) => { rec.ops.push([m, ...a]); return q; };
  q.then = (resolve, reject) => Promise.resolve(typeof value === 'function' ? value(filter) : value).then(resolve, reject);
  return q;
}

const enrolledState = (over = {}) => ({
  workspaceId: WS, enrolled: true, enrolledAt: new Date('2026-10-10T00:00:00Z'), enrolledVia: 'admin', enrolledBy: '<i>bob</i>', r1Applied: true,
  subscription: { state: 'active', source: 'admin', stripe: { status: 'trialing', planCode: 'growth', currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: true },
    admin: { active: true, by: 'staff', at: new Date('2026-10-11T00:00:00Z'), notes: '<script>n</script>' } },
  progress: { status: 'in_progress', currentStep: 3, lastActivityAt: new Date('2026-10-14T00:00:00Z') },
  steps: { business: { status: 'done', enteredAt: new Date('2026-10-10T01:00:00Z'), completedAt: new Date('2026-10-10T01:05:00Z'), attempts: 1 }, number: { status: 'done' } },
  number: { path: 'A', usage: 'unused', numberReady: false, reminderCount: 0 },
  ...over,
});
const connDoc = () => ({
  status: 'connected', ids: { wabaId: 'W1', phoneNumberId: 'P1' },
  display: { displayPhoneNumber: '966501234567', last4: '4567', verifiedName: '<b>Acme</b>' },
  tokenEncrypted: 'v1:SECRET_TOKEN_CIPHERTEXT', pinEncrypted: 'v1:SECRET_PIN_CIPHERTEXT', tokenIsValid: true, tokenExpiresAt: new Date('2026-12-01T00:00:00Z'),
  tokenKeyVersion: 'abcd1234', needsReconnect: false, webhook: { subscribed: true }, lastStatusCheckAt: new Date('2026-10-15T09:00:00Z'), nextCheckAt: new Date('2026-10-15T10:00:00Z'),
  verification: { mapped: 'waiting' }, displayName: { mapped: 'done' }, payment: { status: 'unknown' }, messagingLimit: { raw: 'TIER_250' }, health: { canSend: 'AVAILABLE' },
});

function setup(o = {}) {
  const calls = [];
  const order = [];
  const wsRows = o.workspaces || [{ _id: WS, name: 'Salon <img src=x onerror=alert(1)>', createdAt: new Date('2026-10-01T00:00:00Z') }, { _id: OLDEST, name: 'Owner WS', createdAt: new Date('2026-01-01T00:00:00Z') }];
  const stateDoc = o.state === undefined ? enrolledState() : o.state;
  // the REAL dataDeletion module over fake models (the page never reaches the real OnboardingInbound model in these tests)
  const realDeletion = require('../../../shared/onboarding/dataDeletion');
  const Inbound = createFakeModel();
  for (const r of (o.deletions || [])) Inbound.seed(r);
  const dataDeletion = {
    CODE_RE: realDeletion.CODE_RE,
    listRequests: () => realDeletion.listRequests({ OnboardingInbound: Inbound }),
    markProcessed: (a) => realDeletion.markProcessed(a, { OnboardingInbound: Inbound, OnboardingAdminLog: deps.OnboardingAdminLog, now: () => NOW }),
  };
  const deps = {
    dataDeletion,
    Workspace: {
      find: (f) => chain(wsRows, calls, 'ws.find', f),
      findById: (id) => chain(wsRows.find((w) => String(w._id) === String(id)) || null, calls, 'ws.findById', id),
      findOne: () => chain(wsRows[1], calls, 'ws.findOne'),
    },
    User: { find: (f) => chain(o.users || [], calls, 'user.find', f) },
    Membership: { find: (f) => chain(o.memberships || [], calls, 'membership.find', f) },
    OnboardingState: {
      findOne: (f) => chain(stateDoc, calls, 'state.findOne', f),
      find: (f) => chain(o.enrolledRows || [{ workspaceId: WS, enrolledAt: new Date('2026-10-10T00:00:00Z'), subscription: { state: 'active' }, progress: { status: 'in_progress' } }], calls, 'state.find', f),
    },
    WhatsAppConnection: {
      findOne: (f) => chain(o.conn === undefined ? connDoc() : o.conn, calls, 'conn.findOne', f),
      updateOne: jest.fn(async (...a) => { order.push('conn.updateOne'); return { modifiedCount: 1, a }; }),
    },
    OnboardingTemplate: { find: (f) => chain(o.templates || [{ key: 'welcome_optin', language: 'en', metaStatus: 'approved', metaStatusRaw: 'APPROVED', blockedReason: null, lastErrorCode: '<x>' }], calls, 'tpl.find', f) },
    OnboardingEvent: { find: (f) => chain(o.events || [{ at: new Date('2026-10-14T00:00:00Z'), type: 'step_fail', step: 'connect', code: 'ONB_NETWORK', reason: '<b>r</b>' }], calls, 'event.find', f) },
    OnboardingSupportRequest: { find: (f) => chain(o.requests || [{ createdAt: new Date('2026-10-14T00:00:00Z'), kind: 'help', step: 'connect', lastErrorCode: 'CONNECT_PARTIAL', message: '<script>m</script>' }], calls, 'support.find', f) },
    OnboardingInbound: { find: (f) => chain(o.unmatched || [{ _id: 'stripe:evt_<1>', source: 'stripe', type: 'invoice.paid', startedAt: new Date('2026-10-14T00:00:00Z'), outcome: 'no workspace' }, { _id: 'meta:abc', source: 'meta', type: 'x' }], calls, 'inbound.find', f) },
    OnboardingAdminLog: {
      find: (f) => chain(o.log || [{ createdAt: new Date('2026-10-12T00:00:00Z'), action: 'activate', adminUser: '<u>x</u>', notes: '"><script>1</script>' }], calls, 'log.find', f),
      create: jest.fn(async (row) => { order.push(`log.create:${row.action}`); if (o.logFails) throw new Error('log down'); return row; }),
    },
    state: o.stateMod || {
      enrol: jest.fn(async () => { order.push('state.enrol'); return { ok: true }; }),
      unenrol: jest.fn(async () => { order.push('state.unenrol'); return { ok: true }; }),
      adminActivate: jest.fn(async () => { order.push('state.adminActivate'); return { ok: true }; }),
      adminDeactivate: jest.fn(async () => { order.push('state.adminDeactivate'); return { ok: true }; }),
    },
    analytics: { funnel: o.funnel || (async () => ({ generatedAt: NOW.toISOString(), enrolled: 2, completed: 1, truncated: false, steps: { business: { entered: 2, completed: 2, skipped: 0, medianMinutes: 12.5, dropOff: 0 } }, failureCodes: [{ code: 'ONB_<X>', count: 3 }], subscription: { none: 0, active: 2 }, connection: { connected: 1 }, warnings: [] })) },
    email: { resolveRecipient: jest.fn(async () => (o.recipient === undefined ? { to: 'x@example.test', language: 'en' } : o.recipient)) },
    billing: { refreshBilling: jest.fn(async () => { order.push('billing.refreshBilling'); if (o.billingFails) throw Object.assign(new Error('stripe down'), { code: 'STRIPE_ERROR' }); return { changed: true }; }) },
    findWebhookWorkspace: async () => (o.webhook === undefined ? { workspaceId: OLDEST, name: 'Owner WS', createdAt: new Date('2026-01-01T00:00:00Z') } : o.webhook),
    getCsrfKey: () => (o.key === undefined ? KEY : o.key),
    now: () => o.now || NOW,
  };
  const { createRouter } = require('../../../routes/adminOnboarding');
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.adminIp = '203.0.113.9'; next(); });
  app.use(BASE, createRouter(deps));
  return { app, deps, calls, order, Inbound };
}

const token = (user, ws, day, key = KEY) => crypto.createHmac('sha256', key).update(`${user}:${ws}:${day}`).digest('hex');
const goodToken = (ws = WS) => token('staff', ws, '2026-10-15');
const get = (app, p) => request(app).get(`${BASE}${p}`).set('Authorization', AUTH);
const post = (app, p, body, tok) => request(app).post(`${BASE}${p}`).set('Authorization', AUTH).type('form').send({ ...(tok === null ? {} : { csrf: tok === undefined ? goodToken() : tok }), ...body });

describe('module hygiene', () => {
  test('requiring the router loads no model and exports createRouter / esc', () => {
    jest.isolateModules(() => {
      const before = mongoose.modelNames().filter((n) => /Onboarding|WhatsApp/.test(n));
      const mod = require('../../../routes/adminOnboarding');
      const after = mongoose.modelNames().filter((n) => /Onboarding|WhatsApp/.test(n));
      expect(after).toEqual(before);
      expect(typeof mod.createRouter).toBe('function');
      expect(typeof mod.esc).toBe('function');
      expect(typeof mod).toBe('function'); // an express router
      expect(mod.esc('<&>"\'')).toBe('&lt;&amp;&gt;&quot;&#39;');
    });
  });
  test('no production file of this task can delete anything', () => {
    const root = path.join(__dirname, '../../..');
    const files = ['routes/adminOnboarding.js', 'scripts/onboarding-admin.js', 'routes/onboarding/events.js', 'routes/onboarding/notifications.js',
      'shared/onboarding/email.js', 'shared/onboarding/emailCopy.js', 'shared/onboarding/reminders.js', 'shared/onboarding/analytics.js'];
    for (const f of files) {
      const src = fs.readFileSync(path.join(root, f), 'utf8');
      expect(src).not.toMatch(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|dropDatabase|dropCollection|bulkWrite/);
    }
  });
});

describe('home page', () => {
  test('search form, webhook workspace marker, enrolled list and funnel panel (escaped)', async () => {
    const { app } = setup();
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('[webhook workspace / owner]');
    expect(res.text).toContain(`action="${BASE}/search"`);
    expect(res.text).toContain('Enrolled workspaces');
    expect(res.text).toContain('Funnel');
    expect(res.text).toContain('12.5');
    expect(res.text).toContain('ONB_&lt;X&gt;');
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('<meta charset="utf-8">');
  });
  test('a funnel failure degrades that panel, the page still renders', async () => {
    const { app } = setup({ funnel: async () => { throw new Error('boom'); } });
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('The funnel could not be loaded');
  });
});

describe('workspace page', () => {
  test('escapes hostile names, notes, events, requests, templates, log and stripe ids', async () => {
    const { app } = setup();
    const res = await get(app, `/${WS}`);
    expect(res.status).toBe(200);
    for (const raw of ['<img src=x', '<script>', '<b>Acme', '<i>bob', '<u>x</u>', '<b>r</b>']) expect(res.text).not.toContain(raw);
    for (const esc of ['&lt;img src=x onerror=alert(1)&gt;', '&lt;script&gt;n&lt;/script&gt;', '&lt;b&gt;Acme&lt;/b&gt;', '&lt;i&gt;bob&lt;/i&gt;', 'stripe:evt_&lt;1&gt;', '&lt;script&gt;m&lt;/script&gt;']) expect(res.text).toContain(esc);
  });
  test('shows subscription state/source/raw Stripe status/period end, progress, step timestamps, number path, templates, events, requests, unmatched events, changes', async () => {
    const { app } = setup();
    const t = (await get(app, `/${WS}`)).text;
    for (const s of ['active', 'source: admin', 'trialing', '2026-11-01T00:00:00.000Z', 'Cancels at period end', 'yes', 'Progress', 'current step 3', '2026-10-10T01:05:00.000Z', 'Number path: A',
      'welcome_optin', 'approved', 'ONB_NETWORK', 'CONNECT_PARTIAL', 'Unmatched Stripe events', 'invoice.paid', 'Last changes', 'activate']) expect(t).toContain(s);
    expect(t).not.toContain('meta:abc'); // only Stripe rows in the Stripe panel
  });
  test('queries: last 20 events newest first, open support requests only, single-field sorts', async () => {
    const { app, calls } = setup();
    await get(app, `/${WS}`);
    const ev = calls.find((c) => c.name === 'event.find');
    expect(ev.filter).toEqual({ workspaceId: expect.anything() });
    expect(ev.ops).toEqual(expect.arrayContaining([['sort', { at: -1 }], ['limit', 20]]));
    expect(calls.find((c) => c.name === 'support.find').filter).toMatchObject({ status: 'open' });
    for (const c of calls) for (const op of c.ops) if (op[0] === 'sort') expect(Object.keys(op[1])).toHaveLength(1);
  });
  test('the connection panel shows a MASKED number and token-health flags, never the token, PIN or full number', async () => {
    const { app, calls } = setup();
    const t = (await get(app, `/${WS}`)).text;
    expect(t).toContain('*******4567');
    expect(t).not.toContain('966501234567');
    expect(t).not.toMatch(/SECRET_TOKEN|SECRET_PIN|v1:/);
    expect(t).toContain('Token health');
    expect(t).toContain('valid: yes');
    const select = calls.find((c) => c.name === 'conn.findOne').ops.find((o) => o[0] === 'select')[1];
    expect(select).not.toMatch(/tokenEncrypted|pinEncrypted/);
    expect(select).not.toMatch(/\+/); // no "+field" re-selecting a select:false column
  });
  test('a workspace without a connection row says so', async () => {
    const { app } = setup({ conn: null });
    expect((await get(app, `/${WS}`)).text).toContain('No connection record yet');
  });
  test('"no e-mail" warning for a phone-only account, absent when there is an address or the workspace is not enrolled', async () => {
    expect((await get(setup({ recipient: null }).app, `/${WS}`)).text).toContain('No e-mail on file');
    expect((await get(setup().app, `/${WS}`)).text).not.toContain('No e-mail on file');
    const n = setup({ state: null, recipient: null });
    expect((await get(n.app, `/${WS}`)).text).not.toContain('No e-mail on file');
    expect(n.deps.email.resolveRecipient).not.toHaveBeenCalled();
    expect((await get(setup({ recipient: undefined }).app, `/${WS}`)).status).toBe(200);
  });
  test('?done= shows only whitelisted messages', async () => {
    const { app } = setup();
    expect((await get(app, `/${WS}?done=enrol`)).text).toContain('Workspace enrolled.');
    const bad = await get(app, `/${WS}?done=%3Cscript%3E`);
    expect(bad.text).not.toContain('<script>');
    expect(bad.text).not.toContain('class="ok"');
  });
  test('unknown workspace and malformed ids are 404 with an escaped body', async () => {
    const { app } = setup();
    expect((await get(app, `/${'d'.repeat(24)}`)).status).toBe(404);
    const bad = await get(app, '/%3Cscript%3E');
    expect(bad.status).toBe(404);
    expect(bad.text).not.toContain('<script>');
  });
  test('a failing optional panel does not take the page down', async () => {
    const { app, deps } = setup();
    deps.OnboardingEvent.find = () => { throw new Error('boom'); };
    deps.OnboardingTemplate.find = () => { throw new Error('boom'); };
    const res = await get(app, `/${WS}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No events yet.');
  });
});

describe('forms, CSRF token and the oldest-workspace safeguards', () => {
  test('every action form carries a token bound to admin user, workspace and UTC day', async () => {
    const { app } = setup();
    const t = (await get(app, `/${WS}`)).text;
    const tokens = t.match(/name="csrf" value="([0-9a-f]{64})"/g) || [];
    expect(tokens.length).toBe(5); // activate, deactivate (admin active), refresh, reconcile, unenrol
    for (const m of tokens) expect(m).toContain(token('staff', WS, '2026-10-15'));
    for (const action of ['activate', 'deactivate', 'refresh', 'reconcile', 'unenrol']) expect(t).toContain(`action="${BASE}/${WS}/${action}"`);
  });
  test('not enrolled: the enrol form with the existing-data checkbox, no oldest banner for an ordinary workspace', async () => {
    const { app } = setup({ state: null });
    const t = (await get(app, `/${WS}`)).text;
    expect(t).toContain(`action="${BASE}/${WS}/enrol"`);
    expect(t).toContain('name="confirmExistingData"');
    expect(t).toContain('name="activate"');
    expect(t).not.toContain('name="forceOldest"');
    expect(t).not.toContain('[webhook workspace / owner] This is the OLDEST');
    expect(t).not.toContain('class="banner"');
    expect(t).not.toContain(`action="${BASE}/${WS}/unenrol"`);
  });
  test('the OLDEST workspace: red banner with the marker and a second confirmation checkbox on Enrol', async () => {
    const { app } = setup({ state: null });
    const t = (await get(app, `/${OLDEST}`)).text;
    expect(t).toContain('class="banner"');
    expect(t).toContain('[webhook workspace / owner]');
    expect(t).toContain('OLDEST workspace');
    expect(t).toContain('name="forceOldest"');
    expect(t).toContain('name="confirmExistingData"');
    expect(t).toContain('.banner{background:#5a1f1f');
  });
  test('an enrolled oldest workspace still shows the marker', async () => {
    const { app } = setup({ state: enrolledState({ workspaceId: OLDEST }) });
    expect((await get(app, `/${OLDEST}`)).text).toContain('[webhook workspace / owner]');
  });
  test('without INTERNAL_ADMIN_PASSWORD no form is rendered', async () => {
    const t = (await get(setup({ key: '' }).app, `/${WS}`)).text;
    expect(t).not.toContain('name="csrf"');
    expect(t).not.toContain('<form method="POST"');
    expect(t).toContain('scripts/onboarding-admin.js');
  });
  test('the oldest workspace is found with a single-field sort when no override is injected', async () => {
    const { deps, calls } = setup();
    delete deps.findWebhookWorkspace;
    const { createRouter } = require('../../../routes/adminOnboarding');
    const app = express();
    app.use(BASE, createRouter(deps));
    await request(app).get(`${BASE}/`).set('Authorization', AUTH);
    const rec = calls.find((c) => c.name === 'ws.findOne');
    expect(rec.ops).toEqual(expect.arrayContaining([['sort', { createdAt: 1 }]]));
  });
});

describe('search', () => {
  test('escapes regex metacharacters, caps the length, ignores a non-string q', async () => {
    const { app, calls } = setup();
    await get(app, '/search?q=' + encodeURIComponent('.*(a+)+$'));
    expect(calls.find((c) => c.name === 'ws.find').filter.name.source).toBe('\\.\\*\\(a\\+\\)\\+\\$');
    await get(app, `/search?q=${'x'.repeat(500)}`);
    expect(calls.filter((c) => c.name === 'ws.find').pop().filter.name.source.length).toBe(100);
    const before = calls.length;
    const res = await get(app, '/search?q[$ne]=1');
    expect(res.status).toBe(302);
    expect(calls.length).toBe(before);
  });
  test('a 24-hex id looks that workspace up exactly; results escape names; no results is friendly', async () => {
    const { app, calls } = setup();
    const res = await get(app, `/search?q=${WS}`);
    expect(calls.find((c) => c.name === 'ws.find').filter).toEqual({ _id: WS });
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).not.toContain('<img src=x');
    const none = setup({ workspaces: [] });
    expect((await get(none.app, '/search?q=zzz')).text).toContain('No matches.');
  });
  test('finds a workspace through a member (phone typed in Arabic-Indic digits)', async () => {
    const arabicDigits = '\u{661}\u{662}\u{663}\u{664}\u{665}';
    const { app, calls } = setup({ workspaces: [{ _id: OTHER_WS, name: 'Member WS' }], users: [{ _id: 'u1' }], memberships: [{ workspaceId: OTHER_WS }] });
    const res = await get(app, `/search?q=${encodeURIComponent(arabicDigits)}`);
    expect(res.status).toBe(200);
    const userFilter = calls.find((c) => c.name === 'user.find').filter.$or;
    expect(userFilter.some((f) => f.phone && f.phone.source === '12345')).toBe(true);
    expect(res.text).toContain('Member WS');
  });
});

describe('POST CSRF (fails closed)', () => {
  test.each([
    ['missing token', null],
    ['empty token', ''],
    ['garbage token', 'x'.repeat(64)],
    ['short token', 'abc'],
    ['another day', token('staff', WS, '2026-10-14')],
    ['another workspace', token('staff', OTHER_WS, '2026-10-15')],
    ['another admin user', token('mallory', WS, '2026-10-15')],
    ['another key', token('staff', WS, '2026-10-15', 'wrong-key')],
  ])('%s -> 403 and nothing is called', async (label, tok) => {
    const t = setup();
    for (const action of ['enrol', 'unenrol', 'activate', 'deactivate', 'refresh', 'reconcile']) {
      const res = await post(t.app, `/${WS}/${action}`, { notes: 'n' }, tok);
      expect(res.status).toBe(403);
      expect(res.text).toContain('expired or is invalid');
    }
    expect(t.order).toEqual([]);
    for (const fn of Object.values(t.deps.state)) expect(fn).not.toHaveBeenCalled();
    expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled();
  });
  test('INTERNAL_ADMIN_PASSWORD missing -> 403 even with a token computed from an empty key', async () => {
    const t = setup({ key: '' });
    for (const tok of [token('staff', WS, '2026-10-15', ''), undefined, '']) {
      expect((await post(t.app, `/${WS}/enrol`, {}, tok)).status).toBe(403);
    }
    expect(t.deps.state.enrol).not.toHaveBeenCalled();
  });
  test('the token of one UTC day is rejected the next day', async () => {
    const t = setup({ now: new Date('2026-10-16T00:00:01Z') });
    expect((await post(t.app, `/${WS}/refresh`, {}, goodToken())).status).toBe(403);
    expect((await post(t.app, `/${WS}/refresh`, {}, token('staff', WS, '2026-10-16'))).status).toBe(303);
  });
  test('a malformed workspace id is 404 before anything else', async () => {
    const t = setup();
    expect((await post(t.app, '/%3Cscript%3E/enrol', {})).status).toBe(404);
  });
});

describe('POST actions call the state functions (which log before mutating) and add no log of their own', () => {
  test('enrol: arguments, checkboxes, redirect', async () => {
    const t = setup({ state: null });
    const res = await post(t.app, `/${WS}/enrol`, { notes: 'KSA pilot', activate: 'on', forceOldest: 'on', confirmExistingData: 'on' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${BASE}/${WS}?done=enrol`);
    expect(t.deps.state.enrol).toHaveBeenCalledWith({
      workspaceId: WS, via: 'admin', by: 'staff', notes: 'KSA pilot', ip: '203.0.113.9', activate: true, forceOldest: true, confirmExistingData: true,
    });
    expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled(); // state.enrol logs itself
  });
  test('enrol without checkboxes sends false flags (the safeguards stay on)', async () => {
    const t = setup({ state: null });
    await post(t.app, `/${WS}/enrol`, {});
    expect(t.deps.state.enrol.mock.calls[0][0]).toMatchObject({ activate: false, forceOldest: false, confirmExistingData: false });
  });
  test('unenrol, deactivate pass the admin user, notes and ip', async () => {
    const t = setup();
    expect((await post(t.app, `/${WS}/unenrol`, { notes: 'pilot over' })).headers.location).toBe(`${BASE}/${WS}?done=unenrol`);
    expect(t.deps.state.unenrol).toHaveBeenCalledWith({ workspaceId: WS, by: 'staff', notes: 'pilot over', ip: '203.0.113.9' });
    expect((await post(t.app, `/${WS}/deactivate`, {})).headers.location).toBe(`${BASE}/${WS}?done=deactivate`);
    expect(t.deps.state.adminDeactivate).toHaveBeenCalledWith({ workspaceId: WS, by: 'staff', notes: '', ip: '203.0.113.9' });
    expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled();
  });
  test('activate: notes are required (422, state untouched); with notes it is called', async () => {
    const t = setup();
    for (const body of [{}, { notes: '' }, { notes: '   ' }]) {
      const res = await post(t.app, `/${WS}/activate`, body);
      expect(res.status).toBe(422);
      expect(res.text).toContain('Notes are required');
    }
    expect(t.deps.state.adminActivate).not.toHaveBeenCalled();
    const ok = await post(t.app, `/${WS}/activate`, { notes: 'Riyadh partner' });
    expect(ok.status).toBe(303);
    expect(t.deps.state.adminActivate).toHaveBeenCalledWith({ workspaceId: WS, by: 'staff', notes: 'Riyadh partner', ip: '203.0.113.9' });
  });
  test('notes are capped at 500 characters', async () => {
    const t = setup();
    await post(t.app, `/${WS}/activate`, { notes: 'n'.repeat(900) });
    expect(t.deps.state.adminActivate.mock.calls[0][0].notes).toHaveLength(500);
  });
  test('safeguard refusals from state.js become friendly 422 pages, escaped; nothing else is hidden', async () => {
    const refuse = (reason, extra) => async () => { throw new OnbError('VALIDATION_FAILED', { details: { reason, ...extra } }); };
    const t = setup({ state: null });
    t.deps.state.enrol.mockImplementation(refuse('OLDEST_WORKSPACE'));
    let res = await post(t.app, `/${OLDEST}/enrol`, {}, goodToken(OLDEST));
    expect(res.status).toBe(422);
    expect(res.text).toContain('OLDEST workspace');
    expect(res.text).toContain('Nothing was changed');
    t.deps.state.enrol.mockImplementation(refuse('EXISTING_DATA', { reasons: ['customers', '<b>orders</b>'] }));
    res = await post(t.app, `/${WS}/enrol`, {});
    expect(res.status).toBe(422);
    expect(res.text).toContain('customers, &lt;b&gt;orders&lt;/b&gt;');
    t.deps.state.enrol.mockImplementation(refuse('WORKSPACE_NOT_FOUND'));
    expect((await post(t.app, `/${WS}/enrol`, {})).status).toBe(404);
    t.deps.state.adminDeactivate.mockImplementation(refuse('NOT_ENROLLED'));
    expect((await post(t.app, `/${WS}/deactivate`, {})).status).toBe(422);
  });
  test('an unexpected failure is a generic 500 without the error text', async () => {
    const t = setup();
    t.deps.state.unenrol.mockImplementation(async () => { throw new Error('mongodb://user:pw@host/db exploded'); });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(t.app, `/${WS}/unenrol`, {});
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('mongodb://');
    expect(res.text).toContain('Something went wrong');
  });
});

describe('log-before-mutate with the REAL state.js (fake models)', () => {
  function realWorld({ logFails } = {}) {
    const order = [];
    const OnboardingState = createFakeModel({ defaults: { 'subscription.state': 'none' } }); // the schema default
    const Workspace = createFakeModel();
    Workspace.seed({ _id: WS, createdAt: new Date('2026-10-01T00:00:00Z'), onboarding: { completed: false } });
    Workspace.seed({ _id: OLDEST, createdAt: new Date('2026-01-01T00:00:00Z'), onboarding: { completed: true } });
    const origCreate = OnboardingState.create.bind(OnboardingState);
    OnboardingState.create = async (d) => { order.push('state.create'); return origCreate(d); };
    const origUpdate = OnboardingState.updateOne.bind(OnboardingState);
    OnboardingState.updateOne = async (f, u, o) => { order.push('state.updateOne'); return origUpdate(f, u, o); };
    const OnboardingAdminLog = { rows: [], create: async (row) => { order.push(`log:${row.action}`); if (logFails) throw new Error('log down'); OnboardingAdminLog.rows.push(row); return row; } };
    const stateDeps = { OnboardingState, Workspace, OnboardingAdminLog, Customer: createFakeModel(), Order: createFakeModel(), Promotion: createFakeModel(), WhatsAppConnection: createFakeModel(), now: () => NOW, track: async () => {} };
    const stateMod = {
      enrol: (a) => realState.enrol(a, stateDeps), unenrol: (a) => realState.unenrol(a, stateDeps),
      adminActivate: (a) => realState.adminActivate(a, stateDeps), adminDeactivate: (a) => realState.adminDeactivate(a, stateDeps),
    };
    return { order, OnboardingState, Workspace, OnboardingAdminLog, stateMod };
  }
  beforeEach(() => realState.clearCache());

  test('enrol: the audit row is written BEFORE the sidecar document; the page adds no second row', async () => {
    const w = realWorld();
    const t = setup({ state: null, stateMod: w.stateMod });
    const res = await post(t.app, `/${WS}/enrol`, { notes: 'pilot' });
    expect(res.status).toBe(303);
    expect(w.order.slice(0, 2)).toEqual(['log:enrol', 'state.create']);
    expect(w.OnboardingAdminLog.rows).toHaveLength(1);
    expect(w.OnboardingAdminLog.rows[0]).toMatchObject({ action: 'enrol', adminUser: 'staff', notes: 'pilot', ip: '203.0.113.9' });
    expect(w.OnboardingState.rows).toHaveLength(1);
    expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled();
  });
  test('a failing audit row means NOTHING was changed (no state row), and the operator gets an error page', async () => {
    const w = realWorld({ logFails: true });
    const t = setup({ state: null, stateMod: w.stateMod });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(t.app, `/${WS}/enrol`, {});
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(w.OnboardingState.rows).toHaveLength(0);
    expect(w.order).toEqual(['log:enrol']);
  });
  test('the real safeguards surface as friendly pages: oldest workspace and existing data', async () => {
    const w = realWorld();
    const t = setup({ state: null, stateMod: w.stateMod });
    const oldest = await post(t.app, `/${OLDEST}/enrol`, {}, goodToken(OLDEST));
    expect(oldest.status).toBe(422);
    expect(oldest.text).toContain('OLDEST');
    expect(w.OnboardingState.rows).toHaveLength(0);
    expect(w.OnboardingAdminLog.rows).toHaveLength(0);
    const forced = await post(t.app, `/${OLDEST}/enrol`, { forceOldest: 'on' }, goodToken(OLDEST));
    expect(forced.status).toBe(303);
    expect(w.OnboardingAdminLog.rows).toHaveLength(1);
  });
  test('activate -> deactivate -> unenrol each log before they mutate', async () => {
    const w = realWorld();
    const t = setup({ state: null, stateMod: w.stateMod });
    await post(t.app, `/${WS}/enrol`, {});
    w.order.length = 0;
    expect((await post(t.app, `/${WS}/activate`, { notes: 'partner' })).status).toBe(303);
    expect(w.order[0]).toBe('log:activate');
    w.order.length = 0;
    expect((await post(t.app, `/${WS}/deactivate`, {})).status).toBe(303);
    expect(w.order[0]).toBe('log:deactivate');
    w.order.length = 0;
    expect((await post(t.app, `/${WS}/unenrol`, {})).status).toBe(303);
    expect(w.order[0]).toBe('log:unenrol');
    expect(w.OnboardingAdminLog.rows.map((r) => r.action)).toEqual(['enrol', 'activate', 'deactivate', 'unenrol']);
    expect(w.OnboardingState.rows[0].enrolled).toBe(false);
  });
});

describe('Refresh connection now / Reconcile billing now (the page logs these itself, BEFORE acting)', () => {
  test('refresh: logs first, then sets nextCheckAt to now', async () => {
    const t = setup();
    const res = await post(t.app, `/${WS}/refresh`, {});
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${BASE}/${WS}?done=refresh`);
    expect(t.order).toEqual(['log.create:refresh', 'conn.updateOne']);
    expect(t.deps.OnboardingAdminLog.create.mock.calls[0][0]).toMatchObject({ workspaceId: WS, action: 'refresh', adminUser: 'staff', notes: 'refresh connection now', ip: '203.0.113.9' });
    expect(t.deps.WhatsAppConnection.updateOne).toHaveBeenCalledWith({ workspaceId: WS }, { $set: { nextCheckAt: NOW } });
  });
  test('refresh: a failing audit row leaves the connection untouched', async () => {
    const t = setup({ logFails: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(t.app, `/${WS}/refresh`, {});
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.text).toContain('left as it was');
    expect(t.deps.WhatsAppConnection.updateOne).not.toHaveBeenCalled();
  });
  test('refresh: not enrolled or no connection row -> 422, no log, no write', async () => {
    const a = setup({ state: null });
    expect((await post(a.app, `/${WS}/refresh`, {})).status).toBe(422);
    const b = setup({ conn: null });
    expect((await post(b.app, `/${WS}/refresh`, {})).status).toBe(422);
    for (const t of [a, b]) {
      expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled();
      expect(t.deps.WhatsAppConnection.updateOne).not.toHaveBeenCalled();
    }
  });
  test('reconcile: logs first, then calls billing.refreshBilling for this workspace only', async () => {
    const t = setup();
    const res = await post(t.app, `/${WS}/reconcile`, { workspaceId: OTHER_WS });
    expect(res.status).toBe(303);
    expect(t.order).toEqual(['log.create:refresh', 'billing.refreshBilling']);
    expect(t.deps.billing.refreshBilling).toHaveBeenCalledWith({ workspaceId: WS });
    expect(t.deps.OnboardingAdminLog.create.mock.calls[0][0]).toMatchObject({ action: 'refresh', notes: 'reconcile billing now' });
  });
  test('reconcile: a failing audit row means billing is not touched; a Stripe failure is a 502 page after the attempt was recorded', async () => {
    const a = setup({ logFails: true });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post(a.app, `/${WS}/reconcile`, {})).status).toBe(500);
    spy.mockRestore();
    expect(a.deps.billing.refreshBilling).not.toHaveBeenCalled();
    const b = setup({ billingFails: true });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await post(b.app, `/${WS}/reconcile`, {});
    warn.mockRestore();
    expect(res.status).toBe(502);
    expect(res.text).toContain('STRIPE_ERROR');
    expect(res.text).not.toContain('stripe down');
    expect(b.order).toEqual(['log.create:refresh', 'billing.refreshBilling']);
  });
  test('reconcile: not enrolled -> 422 and nothing logged', async () => {
    const t = setup({ state: null });
    expect((await post(t.app, `/${WS}/reconcile`, {})).status).toBe(422);
    expect(t.deps.OnboardingAdminLog.create).not.toHaveBeenCalled();
    expect(t.deps.billing.refreshBilling).not.toHaveBeenCalled();
  });
});

describe('Meta data-deletion requests (review R7-11): listed for staff, marked processed with a CSRF-protected action', () => {
  const CODE_A = 'a1b2c3d4e5f60718293a4b5c';
  const CODE_B = 'b1b2c3d4e5f60718293a4b5d';
  const CODE_DONE = 'c1b2c3d4e5f60718293a4b5e';
  const rows = () => [
    { _id: `metacb:${CODE_A}`, source: 'metacb', type: 'data_deletion', status: 'processing', startedAt: new Date('2026-10-14T00:00:00Z'), workspaceId: OTHER_WS, outcome: 'awaiting_staff user:<b>FB1</b>' },
    { _id: `metacb:${CODE_B}`, source: 'metacb', type: 'data_deletion', status: 'processing', startedAt: new Date('2026-10-15T08:00:00Z'), outcome: 'awaiting_staff' },
    { _id: `metacb:${CODE_DONE}`, source: 'metacb', type: 'data_deletion', status: 'done', startedAt: new Date('2026-10-01T00:00:00Z'), outcome: 'processed_by_staff user:9' },
    { _id: 'metacb:deauth:zzz', source: 'metacb', type: 'deauthorize', status: 'processing', startedAt: new Date('2026-10-15T08:00:00Z') },
  ];
  const delToken = (code, user = 'staff', day = '2026-10-15', key = KEY) => token(user, `data-deletion:${code}`, day, key);
  const postDel = (app, code, body = {}, tok) => request(app).post(`${BASE}/data-deletion/${code}/done`).set('Authorization', AUTH).type('form').send({ csrf: tok === undefined ? delToken(code) : tok, ...body });

  test('the home page lists open requests first (newest first), then the processed ones; escaped, with the workspace link and a form with its own token', async () => {
    const { app } = setup({ deletions: rows() });
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Meta data-deletion requests');
    expect(res.text).toContain('2 open request(s)');
    const iB = res.text.indexOf(CODE_B);
    const iA = res.text.indexOf(CODE_A);
    const iDone = res.text.indexOf(CODE_DONE);
    expect(iB).toBeGreaterThan(-1);
    expect(iB).toBeLessThan(iA); // newest open request first
    expect(iA).toBeLessThan(iDone); // open before processed
    expect(res.text).toContain(`<a href="${BASE}/${OTHER_WS}">${OTHER_WS}</a>`);
    expect(res.text).toContain('awaiting_staff user:&lt;b&gt;FB1&lt;/b&gt;'); // escaped
    expect(res.text).not.toContain('<b>FB1</b>');
    expect(res.text).not.toContain('deauth'); // only type data_deletion rows
    expect(res.text).toContain(`action="${BASE}/data-deletion/${CODE_A}/done"`);
    expect(res.text).toContain(delToken(CODE_A));
    expect(res.text).not.toContain(`/data-deletion/${CODE_DONE}/done`); // a processed one has no form
  });
  test('the two reads go through the status index (type + status), bounded; the ledger is never scanned whole', async () => {
    const { Inbound, app } = setup({ deletions: rows() });
    await get(app, '/');
    const finds = Inbound.calls.filter((c) => c[0] === 'find').map((c) => c[1]);
    expect(finds).toEqual([{ type: 'data_deletion', status: 'processing' }, { type: 'data_deletion', status: 'done' }]);
  });
  test('no request: a friendly empty state and no warning', async () => {
    const { app } = setup();
    const res = await get(app, '/');
    expect(res.text).toContain('No data-deletion request has been received.');
    expect(res.text).not.toContain('open request(s)');
  });
  test('without INTERNAL_ADMIN_PASSWORD no form is rendered, the CLI is named instead', async () => {
    const { app } = setup({ deletions: rows(), key: null });
    const res = await get(app, '/');
    expect(res.text).not.toContain('/done"');
    expect(res.text).toContain('use scripts/onboarding-admin.js');
  });
  test('a failing deletion read degrades that panel only', async () => {
    const { deps } = setup();
    deps.dataDeletion.listRequests = async () => { throw new Error('db down'); };
    const { createRouter } = require('../../../routes/adminOnboarding');
    const a = express();
    a.use((req, res, next) => { req.adminIp = '203.0.113.9'; next(); });
    a.use(BASE, createRouter(deps));
    const res = await get(a, '/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Enrolled workspaces');
  });

  test('"mark processed": the admin log row is written FIRST, then the ledger row becomes done (outcome kept, nothing deleted), redirect with a message', async () => {
    const { app, order, Inbound, deps } = setup({ deletions: rows() });
    const res = await postDel(app, CODE_A, { notes: 'removed the customer rows' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${BASE}?done=deletion_done`);
    expect(order).toEqual(['log.create:data_deletion_done']);
    expect(deps.OnboardingAdminLog.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: OTHER_WS, action: 'data_deletion_done', target: `metacb:${CODE_A}`, adminUser: 'staff', notes: 'removed the customer rows', ip: '203.0.113.9',
      before: { status: 'processing' }, after: { status: 'done' },
    }));
    const row = Inbound.rows.find((r) => r._id === `metacb:${CODE_A}`);
    expect(row).toMatchObject({ status: 'done', finishedAt: NOW });
    expect(row.outcome).toBe('processed_by_staff user:<b>FB1</b>');
    expect(Inbound.rows).toHaveLength(4); // nothing was deleted
    const home = await get(app, '/?done=deletion_done');
    expect(home.text).toContain('The data-deletion request was marked processed.');
  });
  test('a request without a workspace is logged without one (the admin log row names the request)', async () => {
    const { app, deps } = setup({ deletions: rows() });
    expect((await postDel(app, CODE_B)).status).toBe(303);
    const arg = deps.OnboardingAdminLog.create.mock.calls[0][0];
    expect(arg.workspaceId).toBeUndefined();
    expect(arg).toMatchObject({ action: 'data_deletion_done', target: `metacb:${CODE_B}` });
  });
  test('CSRF fails closed: no token, a token of another request, another admin, another day, a wrong key, a workspace-scoped token', async () => {
    for (const tok of [null, 'x'.repeat(64), delToken(CODE_B), delToken(CODE_A, 'someone-else'), delToken(CODE_A, 'staff', '2026-10-14'), delToken(CODE_A, 'staff', '2026-10-15', 'wrong-key'), token('staff', CODE_A, '2026-10-15')]) {
      const { app, order, Inbound } = setup({ deletions: rows() });
      const res = tok === null ? await request(app).post(`${BASE}/data-deletion/${CODE_A}/done`).set('Authorization', AUTH).type('form').send({}) : await postDel(app, CODE_A, {}, tok);
      expect(res.status).toBe(403);
      expect(order).toEqual([]);
      expect(Inbound.rows.find((r) => r._id === `metacb:${CODE_A}`).status).toBe('processing');
    }
    const { app, order } = setup({ deletions: rows(), key: null });
    expect((await postDel(app, CODE_A, {}, delToken(CODE_A, 'staff', '2026-10-15', ''))).status).toBe(403);
    expect(order).toEqual([]);
  });
  test('a malformed or unknown code is a 404 and writes nothing', async () => {
    const { app, order } = setup({ deletions: rows() });
    expect((await request(app).post(`${BASE}/data-deletion/not-hex/done`).set('Authorization', AUTH).type('form').send({ csrf: 'x' })).status).toBe(404);
    expect((await postDel(app, 'f'.repeat(24))).status).toBe(404);
    expect(order).toEqual([]);
  });
  test('a failing audit row means the request stays OPEN (log first, nothing changed) and the operator gets an error page', async () => {
    const { app, order, Inbound } = setup({ deletions: rows(), logFails: true });
    const res = await postDel(app, CODE_A);
    expect(res.status).toBe(500);
    expect(res.text).toContain('Nothing was changed');
    expect(order).toEqual(['log.create:data_deletion_done']);
    expect(Inbound.rows.find((r) => r._id === `metacb:${CODE_A}`).status).toBe('processing');
  });
  test('marking an already processed request again is a harmless no-op (no second log row)', async () => {
    const { app, order } = setup({ deletions: rows() });
    expect((await postDel(app, CODE_DONE)).status).toBe(303);
    expect(order).toEqual([]);
  });
  test('only a data_deletion row can be marked: a deauthorize ledger row is not a request', async () => {
    const { app, order } = setup({ deletions: [...rows(), { _id: `metacb:${'d'.repeat(24)}`, source: 'metacb', type: 'deauthorize', status: 'processing' }] });
    expect((await postDel(app, 'd'.repeat(24))).status).toBe(404);
    expect(order).toEqual([]);
  });
});
