'use strict';
const support = require('../../../shared/onboarding/support');
const stateModule = require('../../../shared/onboarding/state');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd7994390a1';
const OTHER = '507f1f77bcf86cd7994390a2';
const USER = '507f1f77bcf86cd7994390b1';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const ENV = ['ONBOARDING_SUPPORT_EMAIL', 'ONBOARDING_SUPPORT_WHATSAPP', 'SUPPORT_DESK_EMAIL'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } stateModule.clearCache(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function makeKit(stateDoc, extra = {}) {
  const clock = { offset: 0 };
  const deps = {
    OnboardingState: createFakeModel({ unique: [['workspaceId']] }),
    OnboardingSupportRequest: createFakeModel(),
    WhatsAppConnection: createFakeModel(),
    // a Workspace model that must never be read: Workspace.name is never echoed
    Workspace: { findOne: () => { throw new Error('Workspace must not be read'); }, findById: () => { throw new Error('Workspace must not be read'); } },
    email: { sendSupportEmail: jest.fn(async () => ({ sent: true, id: 'em_1' })) },
    notifications: { notify: jest.fn(async () => ({ created: true })) },
    track: jest.fn(async () => {}),
    now: () => new Date(Date.now() + clock.offset),
    ...extra,
  };
  // rows carry the injected clock (the fake model would stamp the real time)
  const origCreate = deps.OnboardingSupportRequest.create;
  deps.OnboardingSupportRequest.create = (doc) => origCreate({ ...doc, createdAt: deps.now() });
  if (stateDoc) deps.OnboardingState.seed({ workspaceId: WS, enrolled: true, subscription: { state: 'active' }, ...stateDoc });
  return { deps, clock };
}
const reqs = (deps) => deps.OnboardingSupportRequest.rows;

describe('buildPrefilledText', () => {
  test('plain English, one line per fact', () => {
    expect(support.buildPrefilledText({ businessName: 'Rose Salon', stepKey: 'connect', lastErrorCode: 'META_ERROR', language: 'ar' })).toBe([
      'Hi WaFlow, I need help with my setup.', 'Business: Rose Salon', 'Step: 3 of 5 (connect)', 'Last problem: META_ERROR', 'Language: ar',
    ].join('\n'));
  });
  test('defaults: no business, unknown step, no error, English', () => {
    expect(support.buildPrefilledText()).toBe(['Hi WaFlow, I need help with my setup.', 'Business: -', 'Step: unknown', 'Last problem: none', 'Language: en'].join('\n'));
  });
  test('step vocabulary maps like the client (customers / products are part of step 3)', () => {
    const line = (k) => support.buildPrefilledText({ stepKey: k }).split('\n')[2];
    expect(line('business')).toBe('Step: 1 of 5 (business)');
    expect(line('number')).toBe('Step: 2 of 5 (number)');
    expect(line('customers')).toBe('Step: 3 of 5 (customers)');
    expect(line('products')).toBe('Step: 3 of 5 (products)');
    expect(line('approvals')).toBe('Step: 4 of 5 (approvals)');
    expect(line('promotion')).toBe('Step: 5 of 5 (promotion)');
    expect(line('billing')).toBe('Step: payment (billing)');
    expect(line('done')).toBe('Step: setup finished (done)');
    expect(line('Bad Key!')).toBe('Step: unknown');
  });
  test('no phone number, e-mail address, token or control character can get through', () => {
    for (const name of ['+966 50 123 4567', '0501234567', 'owner@example.com', 'Shop 0501234567', 'call 966501234567 now']) {
      expect(support.buildPrefilledText({ businessName: name })).toContain('Business: -');
    }
    const text = support.buildPrefilledText({ businessName: `Rose${String.fromCharCode(10)}Salon${String.fromCodePoint(0x202e)}`, stepKey: 'connect', lastErrorCode: 'not a code' });
    expect(text).toContain('Business: Rose Salon');
    expect(text.split('\n').length).toBe(5);
    expect(text).toContain('Last problem: none');
    expect(text).not.toMatch(/\d{7,}/);
    expect(text).not.toContain('@');
  });
  test('a long name is cut to 80 characters', () => {
    expect(support.buildPrefilledText({ businessName: 'x'.repeat(200) })).toContain(`Business: ${'x'.repeat(80)}\n`);
  });
});

describe('getHelpContext', () => {
  test('enrolled active workspace: the contract shape; Workspace.name is never read', async () => {
    process.env.ONBOARDING_SUPPORT_EMAIL = 'help@waflow.test';
    process.env.ONBOARDING_SUPPORT_WHATSAPP = '+966 50 000 1111';
    process.env.SUPPORT_DESK_EMAIL = 'desk@internal.test';
    const { deps } = makeKit({
      business: { name: 'Rose Salon', uiLanguage: 'ar' }, steps: { business: { status: 'done' }, number: { status: 'done' } },
      lastError: { code: 'CONNECT_CANCELLED', step: 'connect', at: new Date('2026-10-15T09:00:00Z') },
    });
    const ctx = await support.getHelpContext({ workspaceId: WS, userId: USER, deps });
    expect(ctx).toEqual({
      businessName: 'Rose Salon', step: 3, stepKey: 'connect',
      lastError: { code: 'CONNECT_CANCELLED', at: '2026-10-15T09:00:00.000Z' },
      supportEmail: 'help@waflow.test', supportWhatsapp: '966500001111',
      prefilledText: support.buildPrefilledText({ businessName: 'Rose Salon', stepKey: 'connect', lastErrorCode: 'CONNECT_CANCELLED', language: 'ar' }),
    });
    expect(JSON.stringify(ctx)).not.toContain('desk@internal.test');
  });
  test('nothing configured -> nulls; before payment the step is billing; prefill name is the fallback', async () => {
    const { deps } = makeKit({ subscription: { state: 'pending' }, prefill: { businessName: 'From Stripe', email: 'x@y.co' } });
    const ctx = await support.getHelpContext({ workspaceId: WS, deps });
    expect(ctx).toMatchObject({ businessName: 'From Stripe', step: null, stepKey: 'billing', lastError: null, supportEmail: null, supportWhatsapp: null });
    expect(ctx.prefilledText).toContain('Step: payment (billing)');
    expect(JSON.stringify(ctx)).not.toContain('x@y.co');
  });
  test('no business name anywhere -> null; a business name that is a phone number is dropped', async () => {
    const a = await support.getHelpContext({ workspaceId: WS, deps: makeKit({}).deps });
    expect(a.businessName).toBeNull();
    const b = await support.getHelpContext({ workspaceId: WS, deps: makeKit({ business: { name: '0501234567' } }).deps });
    expect(b.businessName).toBeNull();
    expect(JSON.stringify(b)).not.toContain('0501234567');
  });
  test('finished setup -> stepKey done; a broken connection sends the merchant back to connect', async () => {
    const done = { status: 'done' };
    const full = { steps: { business: done, number: done, connect: done, approvals: done, promotion: done }, prompts: { customers: { state: 'done' }, products: { state: 'done' } } };
    const { deps } = makeKit(full);
    expect(await support.getHelpContext({ workspaceId: WS, deps })).toMatchObject({ stepKey: 'done', step: 5 });
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'reconnect_required' });
    expect(await support.getHelpContext({ workspaceId: WS, deps })).toMatchObject({ stepKey: 'connect', step: 3 });
  });
  test('not enrolled -> 404 ONBOARDING_NOT_AVAILABLE', async () => {
    await expect(support.getHelpContext({ workspaceId: WS, deps: makeKit(null).deps })).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
  });
});

describe('createSupportRequest', () => {
  test('creates the row, e-mails support, notifies, tracks, and records the request on the number step', async () => {
    const { deps } = makeKit({ business: { name: 'Rose Salon', contactEmail: 'owner@rose.test' }, lastError: { code: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', step: 'connect' } });
    const out = await support.createSupportRequest({ workspaceId: WS, userId: USER, kind: 'number_help', step: 'number', message: ' I   need\na SIM ' }, deps);
    expect(out.duplicate).toBe(false);
    expect(out.request).toMatchObject({ kind: 'number_help', step: 'number', status: 'open' });
    expect(out.request.emailSentAt).toBeTruthy();
    expect(out.request.emailError).toBeNull();
    const r = reqs(deps)[0];
    expect(r).toMatchObject({ workspaceId: WS, userId: USER, kind: 'number_help', step: 'number', message: 'I need a SIM', businessName: 'Rose Salon', contactEmail: 'owner@rose.test', lastErrorCode: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', status: 'open' });
    expect(r.emailSentAt).toBeTruthy();
    expect(deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
    const sent = deps.email.sendSupportEmail.mock.calls[0][0];
    expect(sent).toMatchObject({ id: String(r._id), kind: 'number_help', message: 'I need a SIM', businessName: 'Rose Salon' });
    expect(deps.notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, kind: 'help_received', dedupeKey: `help_received:${r._id}`, actionPath: '/setup' }));
    expect(deps.notifications.notify.mock.calls[0][0].email).toBeUndefined(); // help_received is in-app only (staff get the support e-mail above)
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'help_opened', step: 'number', reason: 'support_request' });
    const st = deps.OnboardingState.rows[0];
    expect(st.number.helpRequestId).toBe(String(r._id));
    expect(st.number.helpRequestedAt).toBeTruthy();
  });
  test('the support e-mail never receives a phone number, token or code; only what the merchant typed', async () => {
    const { deps } = makeKit({ business: { name: 'Rose Salon' } });
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', display: { displayPhoneNumber: '+966501234567' }, tokenEncrypted: 'v1:SECRET' });
    await support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps);
    const blob = JSON.stringify(deps.email.sendSupportEmail.mock.calls[0][0]);
    expect(blob).not.toContain('966501234567');
    expect(blob).not.toContain('SECRET');
  });
  test('"never buys a number": the module has no purchase path and only touches support / state / notification collaborators', async () => {
    const { deps } = makeKit({});
    await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps);
    expect(Object.keys(support).some((k) => /buy|purchase|order/i.test(k))).toBe(false);
  });
  test.each([
    ['rejects', { sendSupportEmail: jest.fn(async () => { throw Object.assign(new Error('boom: secret body'), { statusCode: 503 }); }) }, 'HTTP_503'],
    ['throws synchronously', { sendSupportEmail: jest.fn(() => { throw new Error('sync boom'); }) }, 'EMAIL_FAILED'],
    ['stub NOT_IMPLEMENTED', { sendSupportEmail: jest.fn(() => { throw Object.assign(new Error('x'), { code: 'NOT_IMPLEMENTED', status: 503 }); }) }, 'NOT_IMPLEMENTED'],
    ['not configured', { sendSupportEmail: jest.fn(async () => ({ sent: false, skipped: 'not_configured' })) }, 'NOT_CONFIGURED'],
    ['no recipient', { sendSupportEmail: jest.fn(async () => ({ sent: false, skipped: 'no_recipient' })) }, 'NO_RECIPIENT'],
    ['sent:false without reason', { sendSupportEmail: jest.fn(async () => ({ sent: false })) }, 'EMAIL_NOT_SENT'],
    ['throws a non-error', { sendSupportEmail: jest.fn(() => { throw 'a string'; }) }, 'EMAIL_FAILED'], // eslint-disable-line no-throw-literal
  ])('e-mail %s: the request still succeeds and only a short code is stored', async (_n, email, code) => {
    const { deps } = makeKit({}, { email });
    const out = await support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps);
    expect(out.duplicate).toBe(false);
    expect(out.request.emailError).toBe(code);
    expect(out.request.emailSentAt).toBeNull();
    expect(reqs(deps)[0].emailError).toBe(code);
    expect(reqs(deps)[0].emailSentAt).toBeUndefined();
    expect(JSON.stringify(reqs(deps)[0])).not.toContain('secret body');
    expect(deps.notifications.notify).toHaveBeenCalled(); // the in-app note is independent of the e-mail
  });
  test('e-mail module missing / not implemented (the real stub) never fails the request', async () => {
    const { deps } = makeKit({}, { email: undefined });
    delete deps.email;
    const out = await support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps);
    expect(out.request.emailError).toBeTruthy();
    expect(out.request.emailError).toMatch(/^[A-Z0-9_]+$/);
  });
  test('a hanging e-mail provider times out instead of hanging the request', async () => {
    const { deps } = makeKit({}, { email: { sendSupportEmail: () => new Promise(() => {}) }, emailTimeoutMs: 25 });
    const out = await support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps);
    expect(out.request.emailError).toBe('EMAIL_TIMEOUT');
  });
  test('a failing notification or analytics write never fails the request', async () => {
    const { deps } = makeKit({}, { notifications: { notify: async () => { throw new Error('x'); } }, track: async () => { throw new Error('y'); } });
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps)).resolves.toMatchObject({ duplicate: false });
  });

  test('a second request within 10 minutes returns the existing one: no new row, no new e-mail', async () => {
    const { deps, clock } = makeKit({});
    const first = await support.createSupportRequest({ workspaceId: WS, kind: 'number_help', message: 'one' }, deps);
    clock.offset = 9 * MIN;
    const second = await support.createSupportRequest({ workspaceId: WS, kind: 'number_help', message: 'two' }, deps);
    expect(second.duplicate).toBe(true);
    expect(second.request.id).toBe(first.request.id);
    expect(reqs(deps)).toHaveLength(1);
    expect(deps.email.sendSupportEmail).toHaveBeenCalledTimes(1);
    expect(deps.notifications.notify).toHaveBeenCalledTimes(1);
    clock.offset = 11 * MIN;
    const third = await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps);
    expect(third.duplicate).toBe(false);
    expect(reqs(deps)).toHaveLength(2);
  });
  test('3 per day: the 4th is 429 RATE_LIMITED with a Retry-After that ends when the oldest leaves the window', async () => {
    const { deps, clock } = makeKit({});
    for (let i = 0; i < 3; i += 1) {
      clock.offset = i * 11 * MIN;
      expect((await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps)).duplicate).toBe(false);
    }
    clock.offset = 3 * 11 * MIN;
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps)).rejects.toMatchObject({ code: 'RATE_LIMITED', status: 429 });
    const err = await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps).catch((e) => e);
    expect(err.retryAfterSec).toBeGreaterThan(23 * 3600 - 60);
    expect(err.retryAfterSec).toBeLessThanOrEqual(24 * 3600);
    expect(reqs(deps)).toHaveLength(3);
    clock.offset = 24 * HOUR + 2 * MIN; // the first one is now older than a day
    expect((await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps)).duplicate).toBe(false);
  });
  test('the limit is per kind and per workspace; the count comes from the database (a fresh instance sees it)', async () => {
    const { deps, clock } = makeKit({});
    deps.OnboardingState.seed({ workspaceId: OTHER, enrolled: true, subscription: { state: 'active' } });
    for (let i = 0; i < 3; i += 1) { clock.offset = i * 11 * MIN; await support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps); }
    clock.offset = 40 * MIN;
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'number_help' }, deps)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps)).resolves.toMatchObject({ duplicate: false });
    await expect(support.createSupportRequest({ workspaceId: OTHER, kind: 'number_help' }, deps)).resolves.toMatchObject({ duplicate: false });
    // other workspace's duplicate window is its own
    const o2 = await support.createSupportRequest({ workspaceId: OTHER, kind: 'number_help' }, deps);
    expect(o2.duplicate).toBe(true);
    expect(reqs(deps).filter((r) => String(r.workspaceId) === OTHER)).toHaveLength(1);
  });
  test('validation: kind, message length and type; hidden characters are stripped', async () => {
    const { deps } = makeKit({});
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'bogus' }, deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'help', message: 'x'.repeat(301) }, deps)).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { fields: { message: 'LENGTH' } } });
    const ok = await support.createSupportRequest({ workspaceId: WS, kind: 'help', message: 'x'.repeat(300) }, deps);
    expect(ok.duplicate).toBe(false);
    const { deps: d2 } = makeKit({});
    await support.createSupportRequest({ workspaceId: WS, kind: 'help', message: `a${String.fromCharCode(7)}b${String.fromCodePoint(0x202e)}c` }, d2);
    expect(reqs(d2)[0].message).toBe('a b c');
    const { deps: d3 } = makeKit({});
    await support.createSupportRequest({ workspaceId: WS, kind: 'help' }, d3);
    expect(reqs(d3)[0].message).toBeUndefined();
  });
  test('not enrolled -> 404 and nothing is written', async () => {
    const { deps } = makeKit(null);
    await expect(support.createSupportRequest({ workspaceId: WS, kind: 'help' }, deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
    expect(reqs(deps)).toHaveLength(0);
    expect(deps.email.sendSupportEmail).not.toHaveBeenCalled();
  });
  test('the step defaults to where the merchant is; an unknown step name is ignored', async () => {
    const { deps } = makeKit({ steps: { business: { status: 'done' } } });
    await support.createSupportRequest({ workspaceId: WS, kind: 'help', step: 'hack' }, deps);
    expect(reqs(deps)[0].step).toBe('number');
  });
  test('a malformed userId is simply not stored', async () => {
    const { deps } = makeKit({});
    await support.createSupportRequest({ workspaceId: WS, userId: 'not-an-id', kind: 'help' }, deps);
    expect(reqs(deps)[0].userId).toBeUndefined();
  });
  test('emailErrorCode never returns message text', () => {
    expect(support.emailErrorCode(new Error('with secret text'))).toBe('EMAIL_FAILED');
    expect(support.emailErrorCode({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(support.emailErrorCode({ code: 'has spaces and secrets' })).toBe('EMAIL_FAILED');
    expect(support.emailErrorCode({ statusCode: 429 })).toBe('HTTP_429');
    expect(support.emailErrorCode(null)).toBe('EMAIL_FAILED');
  });
});
