'use strict';
const steps = require('../../../shared/onboarding/steps');
const stateModule = require('../../../shared/onboarding/state');
const { OnbError } = require('../../../shared/onboarding/errors');
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd7994390a1';
const OWNER = '507f1f77bcf86cd7994390b1';
const MEMBER = '507f1f77bcf86cd7994390b2';
const NOW = new Date('2026-10-15T10:00:00Z');

const ENV = ['ONBOARDING_FLOW', 'ONBOARDING_UNLOCK_AT', 'ONBOARDING_LEGACY_SEND_POLICY', 'ONBOARDING_STRIPE_PRICES', 'ONBOARDING_PLAN_LABELS', 'ONBOARDING_CHECKOUT'];
const saved = {};
beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } stateModule.clearCache(); });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } jest.restoreAllMocks(); });

function makeKit(stateDoc, extra = {}) {
  const deps = {
    OnboardingState: createFakeModel({ unique: [['workspaceId']] }),
    WhatsAppConnection: createFakeModel({ unique: [['workspaceId']] }),
    Membership: createFakeModel(),
    Customer: createFakeModel(),
    Product: createFakeModel(),
    Service: createFakeModel(),
    notifications: { unreadCount: jest.fn(async () => 3) },
    statusRefresh: { snapshot: jest.fn(() => { throw Object.assign(new Error('stub'), { code: 'NOT_IMPLEMENTED' }); }) },
    track: jest.fn(async () => {}),
    now: () => NOW,
    ...extra,
  };
  if (stateDoc) deps.OnboardingState.seed({ workspaceId: WS, enrolled: true, ...stateDoc });
  deps.Membership.seed({ userId: OWNER, workspaceId: WS, role: 'owner' });
  deps.Membership.seed({ userId: MEMBER, workspaceId: WS, role: 'member' });
  return deps;
}
const row = (deps) => deps.OnboardingState.rows.find((r) => String(r.workspaceId) === WS);
const active = (over = {}) => ({ subscription: { state: 'active', source: 'admin' }, ...over });
const done = (completedAt) => ({ status: 'done', completedAt: completedAt || NOW });

describe('exports (INTERFACES 2.16)', () => {
  test('every contract name exists and is a function / constant', () => {
    for (const k of ['validateBusinessInput', 'nextStep', 'markStep', 'buildState', 'buildBillingState']) expect(typeof steps[k]).toBe('function');
    expect(steps.STEP_KEYS).toEqual(['business', 'number', 'connect', 'approvals', 'promotion']);
    expect(steps.STEP_INDEX.promotion).toBe(5);
    expect(steps.INDUSTRY_KEYS).toContain('salon_beauty');
    expect(steps.COUNTRY_CODES).toContain('SA');
  });
});

describe('validateBusinessInput', () => {
  const ok = (body) => steps.validateBusinessInput(body);
  test('a full valid body is normalised', () => {
    const r = ok({ name: '  Rose   Salon ', country: 'sa', industry: 'Salon_Beauty', website: 'https://rose.example.com/shop', instagram: '@rose.salon', crNumber: ' 1010123456 ', crSkipped: false, contactEmail: ' Owner@Rose.Example ', uiLanguage: 'AR', languages: ['en', 'ar', 'en'], extra: 'ignored' });
    expect(r).toEqual({
      ok: true,
      value: { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty', website: 'https://rose.example.com/shop', instagram: 'rose.salon', crNumber: '1010123456', crSkipped: false, contactEmail: 'owner@rose.example', uiLanguage: 'ar', languages: ['en', 'ar'] },
    });
  });
  test('body shape: non-object, array, empty, only unknown keys', () => {
    for (const b of [null, undefined, 'x', 5, []]) expect(ok(b)).toEqual({ ok: false, fields: { body: 'INVALID' } });
    expect(ok({})).toEqual({ ok: false, fields: { body: 'EMPTY' } });
    expect(ok({ workspaceId: 'abc', foo: 1 })).toEqual({ ok: false, fields: { body: 'EMPTY' } });
  });
  test('name: 2-80 after cleaning, hidden characters removed, strings only', () => {
    expect(ok({ name: 'A' }).fields).toEqual({ name: 'LENGTH' });
    expect(ok({ name: ' ab ' }).value.name).toBe('ab');
    expect(ok({ name: 'x'.repeat(80) }).ok).toBe(true);
    expect(ok({ name: 'x'.repeat(81) }).fields).toEqual({ name: 'LENGTH' });
    expect(ok({ name: 5 }).fields).toEqual({ name: 'INVALID' });
    expect(ok({ name: null }).fields).toEqual({ name: 'INVALID' });
    const hidden = `Ro${String.fromCodePoint(0x200e)}se${String.fromCharCode(7)} Shop`;
    expect(ok({ name: hidden }).value.name).toBe('Ro se Shop');
    expect(ok({ name: String.fromCharCode(7, 7, 7) }).fields).toEqual({ name: 'LENGTH' });
  });
  test('country and industry: catalogue only (case-insensitive), cannot be cleared', () => {
    for (const c of ['SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'OTHER']) expect(ok({ country: c }).value.country).toBe(c);
    expect(ok({ country: 'us' }).fields).toEqual({ country: 'INVALID' });
    expect(ok({ country: null }).fields).toEqual({ country: 'INVALID' });
    expect(ok({ country: 5 }).fields).toEqual({ country: 'INVALID' });
    for (const i of steps.INDUSTRY_KEYS) expect(ok({ industry: i }).value.industry).toBe(i);
    expect(ok({ industry: 'campaigns' }).fields).toEqual({ industry: 'INVALID' });
    expect(ok({ industry: '' }).fields).toEqual({ industry: 'INVALID' });
  });
  test('website: https URL <= 200, no credentials, a dotted host; blank clears', () => {
    expect(ok({ website: 'https://example.com' }).value.website).toBe('https://example.com');
    expect(ok({ website: '' }).value.website).toBeNull();
    expect(ok({ website: null }).value.website).toBeNull();
    for (const bad of ['http://example.com', 'example.com', 'https://localhost', 'https://user:pw@example.com', 'ftp://example.com', 'https://exa mple.com', 'javascript:alert(1)', 'https://', 5]) {
      expect(ok({ website: bad }).fields).toEqual({ website: 'INVALID' });
    }
    expect(ok({ website: `https://example.com/${'a'.repeat(200)}` }).fields).toEqual({ website: 'INVALID' });
    expect(ok({ website: `https://example.com/${'a'.repeat(170)}` }).ok).toBe(true);
  });
  test('instagram: handle of [A-Za-z0-9._]{1,30}, a leading @ is stripped, blank clears', () => {
    expect(ok({ instagram: '@a' }).value.instagram).toBe('a');
    expect(ok({ instagram: 'x'.repeat(30) }).ok).toBe(true);
    expect(ok({ instagram: 'x'.repeat(31) }).fields).toEqual({ instagram: 'INVALID' });
    for (const bad of ['has space', 'bad-dash', '@@x', 'a/b', '@']) expect(ok({ instagram: bad }).fields).toEqual({ instagram: 'INVALID' });
    expect(ok({ instagram: '' }).value.instagram).toBeNull();
  });
  test('CR number: 5-20 alphanumerics, no country format claimed', () => {
    expect(ok({ crNumber: 'AB123' }).value.crNumber).toBe('AB123');
    expect(ok({ crNumber: 'x'.repeat(20) }).ok).toBe(true);
    for (const bad of ['1234', 'x'.repeat(21), '12 345', '123-456', '12345!']) expect(ok({ crNumber: bad }).fields).toEqual({ crNumber: 'INVALID' });
    expect(ok({ crNumber: '' }).value.crNumber).toBeNull();
    expect(ok({ crNumber: 123456 }).fields).toEqual({ crNumber: 'INVALID' });
  });
  test('crSkipped must be a boolean', () => {
    expect(ok({ crSkipped: true }).value.crSkipped).toBe(true);
    expect(ok({ crSkipped: 'true' }).fields).toEqual({ crSkipped: 'INVALID' });
  });
  test('contactEmail: format, lower-cased, <= 120', () => {
    expect(ok({ contactEmail: 'A@b.co' }).value.contactEmail).toBe('a@b.co');
    for (const bad of ['a@b', 'a b@c.de', '@b.co', 'a@b.', 'a@@b.co', 'a@b.co,c@d.co']) expect(ok({ contactEmail: bad }).fields).toEqual({ contactEmail: 'INVALID' });
    expect(ok({ contactEmail: `${'a'.repeat(116)}@b.co` }).fields).toEqual({ contactEmail: 'INVALID' });
    expect(ok({ contactEmail: '' }).value.contactEmail).toBeNull();
  });
  test('uiLanguage / languages: en|ar only, languages non-empty and de-duplicated', () => {
    expect(ok({ uiLanguage: 'fr' }).fields).toEqual({ uiLanguage: 'INVALID' });
    expect(ok({ uiLanguage: null }).fields).toEqual({ uiLanguage: 'INVALID' });
    expect(ok({ languages: [] }).fields).toEqual({ languages: 'INVALID' });
    expect(ok({ languages: ['en', 'fr'] }).fields).toEqual({ languages: 'INVALID' });
    expect(ok({ languages: 'en' }).fields).toEqual({ languages: 'INVALID' });
    expect(ok({ languages: ['en', 'ar', 'en'] }).value.languages).toEqual(['en', 'ar']);
    expect(ok({ languages: ['en', 'ar', 'en', 'ar'] }).value.languages).toEqual(['en', 'ar']);
    expect(ok({ languages: ['en', 'en', 'en', 'en', 'en', 'en', 'en'] }).fields).toEqual({ languages: 'INVALID' });
  });
  test('all errors are reported together', () => {
    const r = ok({ name: 'x', country: 'ZZ', industry: 'nope' });
    expect(r.ok).toBe(false);
    expect(Object.keys(r.fields).sort()).toEqual(['country', 'industry', 'name']);
  });
  test('businessComplete needs name + country + industry', () => {
    expect(steps.businessComplete({ name: 'A1', country: 'SA', industry: 'other' })).toBe(true);
    expect(steps.businessComplete({ name: 'A1', country: 'SA' })).toBe(false);
    expect(steps.businessComplete(null)).toBe(false);
  });
});

describe('nextStep matrix (steps x connection x prompts)', () => {
  const S = (over = {}) => ({
    steps: { business: done(), number: done(), connect: done(), approvals: { status: 'todo' }, promotion: { status: 'todo' }, ...(over.steps || {}) },
    prompts: { customers: { state: 'pending' }, products: { state: 'pending' }, ...(over.prompts || {}) },
  });
  test('walks the vocabulary in order', () => {
    expect(steps.nextStep({})).toBe('business');
    expect(steps.nextStep(null)).toBe('business');
    expect(steps.nextStep(S({ steps: { business: { status: 'in_progress' } } }))).toBe('business');
    expect(steps.nextStep(S({ steps: { number: { status: 'todo' } } }))).toBe('number');
    expect(steps.nextStep(S({ steps: { number: { status: 'in_progress' } } }))).toBe('number');
    expect(steps.nextStep(S({ steps: { connect: { status: 'todo' } } }))).toBe('connect');
    expect(steps.nextStep(S())).toBe('approvals');
    expect(steps.nextStep(S({ steps: { approvals: { status: 'in_progress' } } }))).toBe('customers');
    expect(steps.nextStep(S({ steps: { approvals: done() }, prompts: { customers: { state: 'done' } } }))).toBe('products');
    expect(steps.nextStep(S({ steps: { approvals: done() }, prompts: { customers: { state: 'done' }, products: { state: 'skipped' } } }))).toBe('promotion');
    expect(steps.nextStep(S({ steps: { approvals: done(), promotion: done() }, prompts: { customers: { state: 'skipped' }, products: { state: 'done' } } }))).toBe(null);
  });
  test('skipped counts as passed (number, promotion); a skipped prompt does not keep the flow open', () => {
    expect(steps.nextStep(S({ steps: { number: { status: 'skipped' } } }))).toBe('approvals');
    expect(steps.nextStep(S({ steps: { approvals: done(), promotion: { status: 'skipped' } }, prompts: { customers: { state: 'skipped' }, products: { state: 'skipped' } } }))).toBe(null);
  });
  test('a missing prompts block means pending', () => {
    expect(steps.nextStep({ steps: { business: done(), number: done(), connect: done(), approvals: done() } })).toBe('customers');
  });
  const finished = S({ steps: { approvals: done(), promotion: done() }, prompts: { customers: { state: 'done' }, products: { state: 'done' } } });
  test.each([
    ['connected', { status: 'connected', needsReconnect: false }, null],
    ['needs_attention', { status: 'needs_attention', needsReconnect: false }, null],
    ['needsReconnect flag', { status: 'connected', needsReconnect: true }, 'connect'],
    ['reconnect_required', { status: 'reconnect_required' }, 'connect'],
    ['disconnected', { status: 'disconnected' }, 'connect'],
    ['error', { status: 'error' }, 'connect'],
    ['waba_only (partial)', { status: 'waba_only' }, 'connect'],
    ['connecting', { status: 'connecting' }, 'connect'],
    ['no row given', undefined, null],
    ['null row', null, null],
  ])('connect step done + connection %s -> %s', (_name, conn, expected) => {
    expect(steps.nextStep(finished, conn)).toBe(expected);
  });
  test('connect step not done stays connect whatever the row says', () => {
    expect(steps.nextStep(S({ steps: { connect: { status: 'todo' } } }), { status: 'connected' })).toBe('connect');
  });
  test('the answer is always inside the contract vocabulary', () => {
    const vocab = ['business', 'number', 'connect', 'approvals', 'customers', 'products', 'promotion', null];
    const st = ['todo', 'in_progress', 'done', 'skipped'];
    const ps = ['pending', 'done', 'skipped'];
    let n = 0;
    for (const b of st) for (const nu of st) for (const c of st) for (const a of st) for (const p of st) for (const cu of ps) {
      const r = steps.nextStep({ steps: { business: { status: b }, number: { status: nu }, connect: { status: c }, approvals: { status: a }, promotion: { status: p } }, prompts: { customers: { state: cu }, products: { state: 'pending' } } });
      expect(vocab).toContain(r);
      n += 1;
    }
    expect(n).toBe(4 ** 5 * 3);
  });
});

describe('markStep', () => {
  test('done: writes status + timestamps, advances progress, tracks step_complete, invalidates the gate cache', async () => {
    const deps = makeKit(active());
    const inval = jest.spyOn(stateModule, 'invalidate');
    const doc = await steps.markStep(WS, 'business', 'done', deps);
    const r = row(deps);
    expect(r.steps.business.status).toBe('done');
    expect(r.steps.business.completedAt).toEqual(NOW);
    expect(r.steps.business.enteredAt).toEqual(NOW);
    expect(r.progress.currentStep).toBe(2);
    expect(r.progress.furthestStep).toBe(2);
    expect(r.progress.startedAt).toEqual(NOW);
    expect(r.progress.lastActivityAt).toEqual(NOW);
    expect(r.progress.status).toBe('in_progress');
    expect(doc.steps.business.status).toBe('done');
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_complete', step: 'business' });
    expect(inval).toHaveBeenCalledWith(WS);
  });
  test('idempotent: the same call again writes nothing and tracks nothing', async () => {
    const deps = makeKit(active());
    await steps.markStep(WS, 'business', 'done', deps);
    const writes = deps.OnboardingState.calls.filter((c) => c[0] === 'updateOne').length;
    const tracked = deps.track.mock.calls.length;
    await steps.markStep(WS, 'business', 'done', deps);
    expect(deps.OnboardingState.calls.filter((c) => c[0] === 'updateOne').length).toBe(writes);
    expect(deps.track.mock.calls.length).toBe(tracked);
  });
  test('in_progress counts attempts only when entering, keeps enteredAt, tracks step_enter', async () => {
    const deps = makeKit(active());
    await steps.markStep(WS, 'connect', 'in_progress', deps);
    await steps.markStep(WS, 'connect', 'in_progress', deps);
    expect(row(deps).steps.connect.attempts).toBe(1);
    await steps.markStep(WS, 'connect', 'todo', deps);
    await steps.markStep(WS, 'connect', 'in_progress', deps);
    expect(row(deps).steps.connect.attempts).toBe(2);
    expect(deps.track.mock.calls.filter((c) => c[1].type === 'step_enter').length).toBe(2);
  });
  test('skipped tracks step_skip and counts as passed; going back to todo clears completedAt', async () => {
    const deps = makeKit(active());
    await steps.markStep(WS, 'promotion', 'skipped', deps);
    expect(deps.track).toHaveBeenCalledWith(WS, { type: 'step_skip', step: 'promotion' });
    expect(row(deps).steps.promotion.completedAt).toEqual(NOW);
    await steps.markStep(WS, 'promotion', 'todo', deps);
    expect(row(deps).steps.promotion.completedAt).toBeUndefined();
  });
  test('all five done -> completed with completedAt; reopening a step reverts it', async () => {
    const deps = makeKit(active());
    for (const k of steps.STEP_KEYS) await steps.markStep(WS, k, 'done', deps);
    let r = row(deps);
    expect(r.progress.status).toBe('completed');
    expect(r.progress.completedAt).toEqual(NOW);
    expect(r.progress.currentStep).toBe(5);
    await steps.markStep(WS, 'connect', 'todo', deps);
    r = row(deps);
    expect(r.progress.status).toBe('in_progress');
    expect(r.progress.completedAt).toBeUndefined();
    expect(r.progress.currentStep).toBe(3);
    expect(r.progress.furthestStep).toBe(5);
  });
  test('approvals in_progress (opened, Meta still deciding) does not hold the flow open', async () => {
    const deps = makeKit(active());
    for (const k of ['business', 'number', 'connect', 'promotion']) await steps.markStep(WS, k, 'done', deps);
    expect(row(deps).progress.status).not.toBe('completed');
    await steps.markStep(WS, 'approvals', 'in_progress', deps);
    expect(row(deps).progress.status).toBe('completed');
  });
  test('Path B: the number step in progress means paused_number until the number is ready', async () => {
    const deps = makeKit(active({ number: { path: 'B', numberReady: false } }));
    await steps.markStep(WS, 'number', 'in_progress', deps);
    expect(row(deps).progress.status).toBe('paused_number');
    await deps.OnboardingState.updateOne({ workspaceId: WS }, { $set: { 'number.numberReady': true } });
    await steps.markStep(WS, 'number', 'done', deps);
    expect(row(deps).progress.status).toBe('in_progress');
  });
  test('waiting_meta is preserved while unfinished', async () => {
    const deps = makeKit(active({ progress: { status: 'waiting_meta' } }));
    await steps.markStep(WS, 'business', 'done', deps);
    expect(row(deps).progress.status).toBe('waiting_meta');
  });
  test('errors: not enrolled, unknown step, unknown status, bad id', async () => {
    const deps = makeKit(null);
    await expect(steps.markStep(WS, 'business', 'done', deps)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE', status: 404 });
    const deps2 = makeKit({ enrolled: false });
    deps2.OnboardingState.rows[0].enrolled = false;
    await expect(steps.markStep(WS, 'business', 'done', deps2)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
    const deps3 = makeKit(active());
    await expect(steps.markStep(WS, 'customers', 'done', deps3)).rejects.toBeInstanceOf(OnbError);
    await expect(steps.markStep(WS, 'business', 'finished', deps3)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(steps.markStep('nope', 'business', 'done', deps3)).rejects.toMatchObject({ code: 'ONBOARDING_NOT_AVAILABLE' });
  });
  test('a failing analytics write never fails the transition', async () => {
    const deps = makeKit(active(), { track: jest.fn(async () => { throw new Error('analytics down'); }) });
    await expect(steps.markStep(WS, 'business', 'done', deps)).resolves.toBeTruthy();
    expect(row(deps).steps.business.status).toBe('done');
  });
  test('only the workspace document of the given id is touched', async () => {
    const deps = makeKit(active());
    const other = '507f1f77bcf86cd7994390ff';
    deps.OnboardingState.seed({ workspaceId: other, enrolled: true, subscription: { state: 'active' } });
    await steps.markStep(WS, 'business', 'done', deps);
    const o = deps.OnboardingState.rows.find((r) => String(r.workspaceId) === other);
    expect(o.steps).toBeUndefined();
  });
});

describe('buildBillingState / buildState: shapes per subscription state', () => {
  const KEYS_BILLING = ['checkedAt', 'checkout', 'enrolled', 'locked', 'notifications', 'subscription', 'view'];

  test('not enrolled (no row, un-enrolled row, bad id) -> { enrolled:false }', async () => {
    expect(await steps.buildState({ workspaceId: WS, userId: OWNER, deps: makeKit(null) })).toEqual({ enrolled: false });
    const d2 = makeKit({ subscription: { state: 'active' } });
    d2.OnboardingState.rows[0].enrolled = false;
    expect(await steps.buildState({ workspaceId: WS, deps: d2 })).toEqual({ enrolled: false });
    expect(await steps.buildState({ workspaceId: 'zzz', deps: makeKit(null) })).toEqual({ enrolled: false });
    expect(await steps.buildBillingState({ workspaceId: WS, deps: makeKit(null) })).toEqual({ enrolled: false });
  });

  test('none -> the billing subset only, no setup data', async () => {
    const deps = makeKit({ subscription: { state: 'none' }, business: { name: 'Hidden Shop', industry: 'other' }, steps: { business: done() } });
    const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(Object.keys(s).sort()).toEqual(KEYS_BILLING);
    expect(s.view).toBe('billing');
    expect(s.subscription).toEqual({ state: 'none', source: null, retry: { checkout: true, billingPortal: false, reconnect: false } });
    expect(s.locked).toBe(true);
    expect(s.checkout).toEqual({ available: false, plans: [] });
    expect(s.notifications).toEqual({ unread: 3 });
    expect(s.checkedAt).toBe(NOW.toISOString());
    expect(JSON.stringify(s)).not.toContain('Hidden Shop');
  });
  test('pending -> billing subset, nobody can retry checkout; prefill included when present', async () => {
    const deps = makeKit({ subscription: { state: 'pending' }, prefill: { businessName: 'Acme', email: 'a@b.co', planCode: 'basic', source: 'stripe_checkout', capturedAt: NOW } });
    const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(Object.keys(s).sort()).toEqual([...KEYS_BILLING, 'prefill'].sort());
    expect(s.subscription.retry).toEqual({ checkout: false, billingPortal: false, reconnect: false });
    expect(s.prefill).toEqual({ businessName: 'Acme', email: 'a@b.co', planCode: 'basic' });
  });
  test('checkout.plans come from the price keys; names by the stored UI language, null without a label', async () => {
    process.env.ONBOARDING_CHECKOUT = 'on';
    process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ basic: 'price_1', pro: 'price_2' });
    process.env.ONBOARDING_PLAN_LABELS = JSON.stringify({ basic: { en: 'Basic', ar: 'Basic-AR' } });
    const en = await steps.buildBillingState({ workspaceId: WS, deps: makeKit({ subscription: { state: 'none' } }) });
    expect(en.checkout).toEqual({ available: true, plans: [{ code: 'basic', name: 'Basic' }, { code: 'pro', name: null }] });
    stateModule.clearCache();
    const ar = await steps.buildBillingState({ workspaceId: WS, deps: makeKit({ subscription: { state: 'none' }, business: { uiLanguage: 'ar' } }) });
    expect(ar.checkout.plans[0]).toEqual({ code: 'basic', name: 'Basic-AR' });
    expect(JSON.stringify(ar)).not.toContain('price_1');
  });
  test('checkout.available needs the flag AND at least one price', async () => {
    const mk = () => makeKit({ subscription: { state: 'none' } });
    process.env.ONBOARDING_STRIPE_PRICES = JSON.stringify({ basic: 'price_1' });
    expect((await steps.buildBillingState({ workspaceId: WS, deps: mk() })).checkout.available).toBe(false); // flag off
    process.env.ONBOARDING_CHECKOUT = 'on';
    delete process.env.ONBOARDING_STRIPE_PRICES;
    stateModule.clearCache();
    expect((await steps.buildBillingState({ workspaceId: WS, deps: mk() })).checkout.available).toBe(false); // no price
    process.env.ONBOARDING_STRIPE_PRICES = '{not json';
    stateModule.clearCache();
    expect((await steps.buildBillingState({ workspaceId: WS, deps: mk() })).checkout).toEqual({ available: false, plans: [] });
  });

  test('active -> the FULL state with every contract key', async () => {
    const deps = makeKit(active({
      business: { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty', uiLanguage: 'en', crSkipped: true, languages: ['en'] },
      steps: { business: done(), number: done() },
      number: { path: 'A', usage: 'unused', hasNumber: true },
      progress: { currentStep: 3, status: 'in_progress' },
      lastError: { code: 'META_ERROR', step: 'connect', at: NOW },
      prefill: { businessName: 'Acme' },
    }));
    deps.Customer.seed({ workspaceId: WS });
    deps.Customer.seed({ workspaceId: WS });
    deps.Product.seed({ workspaceId: WS });
    const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(Object.keys(s).sort()).toEqual([
      'business', 'checkedAt', 'connection', 'currentStep', 'enrolled', 'firstPromotion', 'lastError', 'locked', 'nextStep', 'notifications',
      'number', 'prefill', 'progress', 'prompts', 'sendingPaused', 'steps', 'subscription', 'unlockAt', 'view',
    ]);
    expect(s).toMatchObject({
      enrolled: true, view: 'setup', locked: true, unlockAt: 'connected', nextStep: 'connect', currentStep: 'connect',
      subscription: { state: 'active', source: 'admin', retry: { checkout: false, billingPortal: false, reconnect: false } },
      business: { name: 'Rose Salon', country: 'SA', industry: 'salon_beauty', uiLanguage: 'en', crSkipped: true, languages: ['en'], website: null },
      number: { path: 'A', usage: 'unused', hasNumber: true, paused: false },
      prompts: { customers: { state: 'pending' }, products: { state: 'pending' }, counts: { customers: 2, products: 1, services: 0 } },
      firstPromotion: { state: 'locked' },
      progress: { completedAt: null, status: 'in_progress' },
      notifications: { unread: 3 },
      prefill: { businessName: 'Acme', email: null, planCode: null },
      lastError: { code: 'META_ERROR', step: 'connect', at: NOW.toISOString() },
    });
    expect(s.business.industryOptions).toEqual(steps.INDUSTRY_KEYS);
    expect(Object.keys(s.steps)).toEqual(['business', 'number', 'connect', 'approvals', 'promotion']);
    expect(s.steps.business).toEqual({ status: 'done', enteredAt: null, completedAt: NOW.toISOString(), attempts: 0 });
    expect(s.steps.connect.status).toBe('todo');
    expect(s.connection).toEqual({ level: null, status: 'not_connected', numberMasked: null, verifiedName: null, causeCode: null, causePath: null, checkedAt: null, numberFull: null });
    expect(s.sendingPaused).toEqual({ code: 'WHATSAPP_NOT_CONNECTED' });
  });

  test('past_due and cancelled keep the full state (progress stays readable); view follows completion', async () => {
    const mk = (state, extra) => makeKit({ subscription: { state, source: 'stripe' }, steps: { business: done(), number: done(), connect: done() }, ...extra });
    const pd = await steps.buildState({ workspaceId: WS, userId: OWNER, deps: mk('past_due') });
    expect(pd.view).toBe('setup');
    expect(pd.subscription).toEqual({ state: 'past_due', source: 'stripe', retry: { checkout: false, billingPortal: true, reconnect: false } });
    expect(pd.steps.connect.status).toBe('done');
    expect(pd.nextStep).toBe('approvals');
    expect(pd.sendingPaused).toEqual({ code: 'PAYMENT_PAST_DUE' });
    expect(pd.locked).toBe(true);
    stateModule.clearCache();
    const cn = await steps.buildState({ workspaceId: WS, userId: OWNER, deps: mk('cancelled', { progress: { completedAt: NOW, status: 'completed' } }) });
    expect(cn.view).toBe('done');
    expect(cn.subscription.retry).toEqual({ checkout: true, billingPortal: true, reconnect: false });
    expect(cn.sendingPaused).toEqual({ code: 'SUBSCRIPTION_CANCELLED' });
    expect(cn.progress.completedAt).toBe(NOW.toISOString());
  });

  test('sendingPaused follows the send policy (block by default, platform_number opt-in)', async () => {
    const mk = () => makeKit(active({ steps: { connect: done() } }));
    const withConn = (deps) => { deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', needsReconnect: false, display: { displayPhoneNumber: '+966501234567' } }); return deps; };
    let s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps: withConn(mk()) });
    expect(s.sendingPaused).toEqual({ code: 'SENDING_NOT_AVAILABLE_YET' });
    expect(s.locked).toBe(false);
    process.env.ONBOARDING_LEGACY_SEND_POLICY = 'platform_number';
    stateModule.clearCache();
    s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps: withConn(mk()) });
    expect(s.sendingPaused).toBeNull();
    const d = withConn(mk());
    d.WhatsAppConnection.rows[0].needsReconnect = true;
    stateModule.clearCache();
    s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps: d });
    expect(s.sendingPaused).toEqual({ code: 'WHATSAPP_RECONNECT_REQUIRED' });
  });

  test('numberFull only for the live owner (the JWT role is ignored); the masked number for everyone', async () => {
    const deps = makeKit(active({ steps: { connect: done() } }));
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', display: { displayPhoneNumber: '+966501234567', verifiedName: 'Rose' } });
    const owner = await steps.buildState({ workspaceId: WS, userId: OWNER, role: 'member', deps });
    expect(owner.connection.numberFull).toBe('+966501234567');
    expect(owner.connection.numberMasked).toBe('********4567');
    expect(owner.connection.verifiedName).toBe('Rose');
    const member = await steps.buildState({ workspaceId: WS, userId: MEMBER, role: 'owner', deps });
    expect('numberFull' in member.connection).toBe(false);
    expect(member.connection.numberMasked).toBe('********4567');
    expect(JSON.stringify(member)).not.toContain('966501234567');
    const stranger = await steps.buildState({ workspaceId: WS, userId: '507f1f77bcf86cd7994390ee', deps });
    expect('numberFull' in stranger.connection).toBe(false);
    const anon = await steps.buildState({ workspaceId: WS, deps });
    expect('numberFull' in anon.connection).toBe(false);
  });

  test('connection summary: TEMP fallback derives the level; the snapshot wins when it works', async () => {
    const levels = [['connected', false, 'connected'], ['needs_attention', false, 'needs_attention'], ['connected', true, 'reconnect_needed'], ['reconnect_required', false, 'reconnect_needed'], ['waba_only', false, 'needs_attention'], ['disconnected', false, null], ['not_connected', false, null]];
    for (const [status, needsReconnect, expected] of levels) {
      stateModule.clearCache();
      const deps = makeKit(active({ steps: { connect: done() } }));
      deps.WhatsAppConnection.seed({ workspaceId: WS, status, needsReconnect });
      const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
      expect(s.connection.level).toBe(expected);
    }
    const deps = makeKit(active({ steps: { connect: done() } }), {
      statusRefresh: { snapshot: jest.fn(async () => ({ level: 'needs_attention', cause: { code: 'NAME_DECLINED', path: '/setup/approvals' }, verifiedName: 'From Snapshot', checkedAt: NOW })) },
    });
    deps.WhatsAppConnection.seed({ workspaceId: WS, status: 'connected', display: { verifiedName: 'Stored' } });
    const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(s.connection).toMatchObject({ level: 'needs_attention', causeCode: 'NAME_DECLINED', causePath: '/setup/approvals', verifiedName: 'From Snapshot', checkedAt: NOW.toISOString() });
    // an unknown level from the snapshot is not passed through
    const deps2 = makeKit(active(), { statusRefresh: { snapshot: async () => ({ level: 'not_connected', causeCode: 'X_Y' }) } });
    deps2.WhatsAppConnection.seed({ workspaceId: WS, status: 'disconnected' });
    stateModule.clearCache();
    expect((await steps.buildState({ workspaceId: WS, userId: OWNER, deps: deps2 })).connection.level).toBeNull();
  });

  test('connection.status is the raw WhatsAppConnection.status (the word GET /connection uses): the Step 3 screen needs no extra request (I3a request 3)', async () => {
    const statuses = ['connected', 'needs_attention', 'waba_only', 'connecting', 'reconnect_required', 'disconnected', 'not_connected', 'error'];
    for (const status of statuses) {
      stateModule.clearCache();
      const deps = makeKit(active({ steps: { connect: done() } }));
      deps.WhatsAppConnection.seed({ workspaceId: WS, status, needsReconnect: false });
      const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
      expect([status, s.connection.status]).toEqual([status, status]);
    }
    // no row, or a row without a status: 'not_connected' (never null: the answer is a word the client can switch on)
    stateModule.clearCache();
    expect((await steps.buildState({ workspaceId: WS, userId: OWNER, deps: makeKit(active()) })).connection.status).toBe('not_connected');
    stateModule.clearCache();
    const bare = makeKit(active());
    bare.WhatsAppConnection.seed({ workspaceId: WS });
    expect((await steps.buildState({ workspaceId: WS, userId: OWNER, deps: bare })).connection.status).toBe('not_connected');
    // members see it too (it is a word, not a secret), and it carries no number
    stateModule.clearCache();
    const kit = makeKit(active({ steps: { connect: done() } }));
    kit.WhatsAppConnection.seed({ workspaceId: WS, status: 'waba_only', display: { displayPhoneNumber: '+966501234567' } });
    const member = await steps.buildState({ workspaceId: WS, userId: MEMBER, deps: kit });
    expect(member.connection.status).toBe('waba_only');
    expect(JSON.stringify(member)).not.toContain('966501234567');
    // the stored step status stays untouched; only steps.connect.status is a view
    expect(member.steps.connect.status).toBe('done');
  });

  test('counts are read-only, workspace-scoped, and null on failure; unread is 0 on failure', async () => {
    const deps = makeKit(active(), { notifications: { unreadCount: async () => { throw new Error('boom'); } } });
    deps.Customer.seed({ workspaceId: '507f1f77bcf86cd7994390ff' }); // another workspace
    deps.Product.failWith = new Error('db down');
    const s = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(s.prompts.counts).toEqual({ customers: 0, products: null, services: 0 });
    expect(s.notifications).toEqual({ unread: 0 });
    for (const [name, filter] of deps.Customer.calls.filter((c) => c[0] === 'countDocuments').map((c) => [c[0], c[1]])) {
      expect(name).toBe('countDocuments');
      expect(filter).toEqual({ workspaceId: WS, deletedAt: { $exists: false } }); // ruling 5: erased customers never count
    }
    const writes = ['create', 'updateOne', 'updateMany'];
    expect(deps.Customer.calls.some((c) => writes.includes(c[0]))).toBe(false);
  });

  test('ruling 5: an erased customer (deletedAt set) is not counted in /state and cannot make the customers prompt "done"', async () => {
    const deps = makeKit(active());
    deps.Customer.seed({ workspaceId: WS, phone: '1', deletedAt: new Date('2026-10-01T00:00:00Z') });
    const s1 = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(s1.prompts.counts.customers).toBe(0);
    deps.Customer.seed({ workspaceId: WS, phone: '2' });
    const s2 = await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(s2.prompts.counts.customers).toBe(1);
    expect(await steps.readCounts(WS, deps)).toMatchObject({ customers: 1 });
  });

  test('reads the gate with fresh:true (never the cache)', async () => {
    const getGateState = jest.fn(async () => ({ enrolled: true, sub: { state: 'active', source: 'admin' }, conn: null, locked: true, unlockAt: 'connected', legacyPolicy: 'block' }));
    const deps = makeKit(active(), { getGateState });
    await steps.buildState({ workspaceId: WS, userId: OWNER, deps });
    expect(getGateState).toHaveBeenCalledWith(WS, { fresh: true });
  });

  test('no secret, hash, PIN or Workspace.name can appear in the body', async () => {
    const deps = makeKit(active({ steps: { connect: done() } }));
    deps.WhatsAppConnection.seed({
      workspaceId: WS, status: 'connected', display: { displayPhoneNumber: '+966501234567' },
      tokenEncrypted: 'v1:SECRET-TOKEN-ENVELOPE', pinEncrypted: 'v1:SECRET-PIN', connectAttempt: { codeHash: 'deadbeefhash' }, ids: { wabaId: 'W123', phoneNumberId: 'P123' },
    });
    const text = JSON.stringify(await steps.buildState({ workspaceId: WS, userId: OWNER, deps }));
    for (const bad of ['SECRET', 'deadbeef', 'tokenEncrypted', 'pinEncrypted', 'codeHash', 'W123', 'P123', 'subscription.stripe', 'customerId']) expect(text).not.toContain(bad);
  });

  test('currentStep is the key of progress.currentStep', async () => {
    const deps = makeKit(active({ progress: { currentStep: 4 } }));
    expect((await steps.buildState({ workspaceId: WS, userId: OWNER, deps })).currentStep).toBe('approvals');
  });
});

describe('helpers', () => {
  test('cleanText / toIso / requestContext', () => {
    expect(steps.cleanText('  a\n\tb  ')).toBe('a b');
    expect(steps.cleanText(5)).toBe('');
    expect(steps.toIso('nope')).toBeNull();
    expect(steps.toIso(null)).toBeNull();
    expect(steps.toIso(NOW)).toBe(NOW.toISOString());
    expect(steps.requestContext({ user: { id: OWNER, workspaceId: WS, role: 'owner' }, body: { workspaceId: 'x' } })).toEqual({ workspaceId: WS, userId: OWNER, role: 'owner' });
    expect(() => steps.requestContext({ user: {} })).toThrow(OnbError);
    expect(() => steps.requestContext({})).toThrow(OnbError);
    expect(() => steps.requestContext({ user: { workspaceId: 'bad' } })).toThrow(OnbError);
  });
});

describe('connectStepView (the status of step 3 as the UI reads it)', () => {
  test('stored done / skipped win; waba_only and connecting rows show through while step 3 is open; failed steps read partial', () => {
    expect(steps.connectStepView('done', { status: 'waba_only' })).toBe('done');
    expect(steps.connectStepView('skipped', { status: 'connecting' })).toBe('skipped');
    expect(steps.connectStepView('todo', null)).toBe('todo');
    expect(steps.connectStepView('todo', { status: 'not_connected' })).toBe('todo');
    expect(steps.connectStepView('todo', { status: 'disconnected' })).toBe('todo');
    expect(steps.connectStepView('in_progress', { status: 'waba_only' })).toBe('waba_only');
    expect(steps.connectStepView('todo', { status: 'connecting', connectSteps: { exchange: { status: 'done' }, subscribe: { status: 'pending' } } })).toBe('connecting');
    expect(steps.connectStepView('todo', { status: 'connecting' })).toBe('connecting');
    expect(steps.connectStepView('todo', { status: 'connecting', connectSteps: { exchange: { status: 'done' }, register: { status: 'failed' } } })).toBe('partial');
    expect(steps.connectStepView('todo', { status: 'reconnect_required' })).toBe('todo');
  });
});

describe('lastErrorOf (sidecar error or the connection row error, newer wins)', () => {
  const T1 = new Date('2026-10-14T10:00:00Z');
  const T2 = new Date('2026-10-14T11:00:00Z');
  test('only one source -> that one; none or malformed codes -> null', () => {
    expect(steps.lastErrorOf({}, null)).toBeNull();
    expect(steps.lastErrorOf(null, null)).toBeNull();
    expect(steps.lastErrorOf({ lastError: { code: 'VALIDATION_FAILED', step: 'business', at: T1 } }, null)).toEqual({ code: 'VALIDATION_FAILED', step: 'business', at: T1.toISOString() });
    expect(steps.lastErrorOf({}, { lastError: { code: 'CONNECT_PARTIAL', kind: 'network', at: T1 } })).toEqual({ code: 'CONNECT_PARTIAL', step: 'connect', at: T1.toISOString() });
    expect(steps.lastErrorOf({ lastError: { code: 'not a code' } }, { lastError: { code: 'lower_case' } })).toBeNull();
  });
  test('both present: the newer wins, a tie keeps the sidecar, a missing timestamp is the oldest', () => {
    expect(steps.lastErrorOf({ lastError: { code: 'AAA_OLD', at: T1 } }, { lastError: { code: 'BBB_NEW', at: T2 } }).code).toBe('BBB_NEW');
    expect(steps.lastErrorOf({ lastError: { code: 'AAA_NEW', at: T2 } }, { lastError: { code: 'BBB_OLD', at: T1 } }).code).toBe('AAA_NEW');
    expect(steps.lastErrorOf({ lastError: { code: 'AAA_TIE', at: T1 } }, { lastError: { code: 'BBB_TIE', at: T1 } }).code).toBe('AAA_TIE');
    expect(steps.lastErrorOf({ lastError: { code: 'AAA_NOAT' } }, { lastError: { code: 'BBB_AT', at: T1 } }).code).toBe('BBB_AT');
  });
});
