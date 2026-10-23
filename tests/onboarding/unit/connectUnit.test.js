'use strict';
// connect.js without a database: in-memory models, fakeGraph, the real tokenVault with a dummy key.
const crypto = require('crypto');
const { createFakeGraph, fixedClock, fakeRandom } = require('../_fixtures');
const { createMetaGraphClient } = require('../../../shared/onboarding/metaClient');
const connect = require('../../../shared/onboarding/connect');
const vault = require('../../../shared/onboarding/tokenVault');

const WS = '64b000000000000000000001';
const KEY = 'b2'.repeat(32);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v), (k, x) => (typeof x === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(x) ? new Date(x) : x)));

// ---- tiny in-memory mongoose stand-in: equality, $or, $exists, $ne, $in, $lt/$lte/$gt/$gte, $set/$unset/$inc/$setOnInsert, upsert, unique _id
const getPath = (o, p) => p.split('.').reduce((a, k) => (a === null || a === undefined ? undefined : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let c = o; ks.slice(0, -1).forEach((k) => { if (c[k] === null || typeof c[k] !== 'object') c[k] = {}; c = c[k]; }); c[ks[ks.length - 1]] = v; }
function delPath(o, p) { const ks = p.split('.'); let c = o; for (const k of ks.slice(0, -1)) { if (c[k] === null || typeof c[k] !== 'object') return; c = c[k]; } delete c[ks[ks.length - 1]]; }
const isNil = (v) => v === null || v === undefined;
const same = (a, b) => (isNil(a) || isNil(b) ? isNil(a) && isNil(b) : (a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : String(a) === String(b)));
function condOk(val, c) {
  if (c !== null && typeof c === 'object' && !(c instanceof Date) && Object.keys(c).some((k) => k.startsWith('$'))) {
    return Object.entries(c).every(([op, arg]) => {
      if (op === '$exists') return (val !== undefined) === !!arg;
      if (op === '$ne') return !same(val, arg);
      if (op === '$in') return arg.some((x) => same(val, x));
      if (isNil(val)) return false;
      const a = val instanceof Date ? val.getTime() : val;
      const b = arg instanceof Date ? arg.getTime() : arg;
      if (op === '$lt') return a < b;
      if (op === '$lte') return a <= b;
      if (op === '$gt') return a > b;
      if (op === '$gte') return a >= b;
      throw new Error(`fake store: unsupported operator ${op}`);
    });
  }
  return same(val, c);
}
const matches = (doc, f) => Object.entries(f).every(([k, c]) => (k === '$or' ? c.some((x) => matches(doc, x)) : condOk(getPath(doc, k), c)));
function applyUpdate(doc, u, inserting) {
  Object.entries(u.$set || {}).forEach(([k, v]) => setPath(doc, k, v instanceof Date ? v : clone(v)));
  Object.keys(u.$unset || {}).forEach((k) => delPath(doc, k));
  Object.entries(u.$inc || {}).forEach(([k, v]) => setPath(doc, k, (getPath(doc, k) || 0) + v));
  if (inserting) Object.entries(u.$setOnInsert || {}).forEach(([k, v]) => setPath(doc, k, clone(v)));
}
function chain(fn) {
  const p = { select: () => p, lean: () => p, then: (res, rej) => Promise.resolve().then(fn).then(res, rej) };
  return p;
}
function store(initial = [], { uniqueId = false } = {}) {
  const docs = initial.map((d) => clone(d));
  const model = {
    docs,
    findOne: (f) => chain(() => { const d = docs.find((x) => matches(x, f)); return d ? clone(d) : null; }),
    updateOne: async (f, u) => {
      const d = docs.find((x) => matches(x, f));
      if (!d) return { matchedCount: 0, modifiedCount: 0 };
      applyUpdate(d, u, false);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    findOneAndUpdate: (f, u, o = {}) => chain(() => {
      let d = docs.find((x) => matches(x, f));
      if (!d && o.upsert) {
        const seed = {};
        Object.entries(f).forEach(([k, v]) => { if (!k.startsWith('$') && (v === null || typeof v !== 'object' || v instanceof Date)) setPath(seed, k, v); });
        if (uniqueId && docs.some((x) => String(x._id) === String(seed._id))) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        d = seed; applyUpdate(d, u, true); docs.push(d);
        return o.returnDocument === 'before' ? null : clone(d); // 'before' = the document as it was (none: this call created it)
      }
      if (!d) return null;
      const pre = clone(d);
      applyUpdate(d, u, false);
      return o.returnDocument === 'before' ? pre : clone(d);
    }),
  };
  return model;
}

function setup(opts = {}) {
  process.env.WA_TOKEN_ENCRYPTION_KEY = KEY;
  const graph = opts.graph || createFakeGraph({ wabaId: '2100000000000001', phoneId: '2100000000000002', businessId: '2100000000000003', ...(opts.graphOptions || {}) });
  const meta = createMetaGraphClient({ http: graph.http, appId: graph.ids.appId, appSecret: graph.ids.appSecret });
  const clock = fixedClock('2026-10-15T09:00:00Z');
  const random = fakeRandom({ sequence: [482913] });
  const stateDoc = opts.stateDoc || { workspaceId: WS, enrolled: true, steps: { business: { status: 'done' }, number: { status: 'done' }, connect: { status: 'todo' } }, progress: { currentStep: 3 }, business: { uiLanguage: 'en' } };
  const Connection = store(opts.conns || []);
  const Claim = store(opts.claims || [], { uniqueId: true });
  const State = store([stateDoc]);
  const stateMod = {
    ensureState: jest.fn(async (ws) => { if (opts.notEnrolled || String(ws) !== WS) { const e = new Error('nope'); e.code = 'ONBOARDING_NOT_AVAILABLE'; e.name = 'OnbError'; throw e; } return clone(stateDoc); }),
    ensureConnection: jest.fn(async (ws) => {
      let d = Connection.docs.find((x) => String(x.workspaceId) === String(ws));
      if (!d) { d = { workspaceId: ws, status: 'not_connected', connectSteps: {} }; Connection.docs.push(d); }
      return clone(d);
    }),
    invalidate: jest.fn(),
  };
  const events = [];
  const notes = [];
  const steps = { markStep: jest.fn(async () => ({})) };
  const starter = { seedStarterTemplates: jest.fn(async () => ({})) };
  const deps = {
    Connection, Claim, State, state: stateMod, meta, vault, steps, starterTemplates: starter,
    now: () => clock.now(), randomInt: random.randomInt, randomBytes: random.randomBytes, hmacSecret: 'unit-test-secret',
    track: async (ws, e) => { events.push(e); },
    notify: async (a) => { notes.push(a); return { created: true }; },
    ...(opts.deps || {}),
  };
  return { graph, meta, clock, random, stateDoc, Connection, Claim, State, stateMod, deps, events, notes, steps, starter };
}
const row = (t) => t.Connection.docs.find((d) => String(d.workspaceId) === WS);
const names = (t) => t.graph.calls.map((c) => c.name);
const flat = (s) => Object.assign({ event: s.event }, s.data);
let n = 0;
const nextCode = () => `AQDunitSECRETcode${String(++n).padStart(4, '0')}zz`;
async function rejection(p) { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); }
async function begin(t, extra = {}) { return (await connect.getConnectConfig({ workspaceId: WS, userId: 'u1', ...extra }, t.deps)).attemptId; }
const complete = (t, attemptId, over = {}) => connect.completeConnect({ workspaceId: WS, userId: 'u1', attemptId, code: nextCode(), session: flat(t.graph.session('FINISH')), ...over }, t.deps);

let env;
beforeAll(() => {
  env = { id: process.env.META_ES_APP_ID, cfg: process.env.META_ES_CONFIG_ID, key: process.env.WA_TOKEN_ENCRYPTION_KEY, sec: process.env.WA_APP_SECRET, shared: process.env.ONBOARDING_ALLOW_SHARED_KEY };
  process.env.META_ES_APP_ID = 'APP_ID_FIXTURE';
  process.env.META_ES_CONFIG_ID = 'CONFIG_ID_FIXTURE';
  process.env.WA_TOKEN_ENCRYPTION_KEY = KEY;
  delete process.env.ONBOARDING_ALLOW_SHARED_KEY;
});
afterAll(() => {
  const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  put('META_ES_APP_ID', env.id); put('META_ES_CONFIG_ID', env.cfg); put('WA_TOKEN_ENCRYPTION_KEY', env.key); put('WA_APP_SECRET', env.sec); put('ONBOARDING_ALLOW_SHARED_KEY', env.shared);
});
beforeEach(() => { process.env.WA_TOKEN_ENCRYPTION_KEY = KEY; });

describe('getConnectConfig', () => {
  test('returns the popup payload and stores an open attempt', async () => {
    const t = setup();
    const out = await connect.getConnectConfig({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(out).toEqual({ enabled: true, appId: 'APP_ID_FIXTURE', configId: 'CONFIG_ID_FIXTURE', graphVersion: 'v25.0', extras: {}, sdkLocale: 'en_US', attemptId: out.attemptId, expiresInSec: 900, reconnect: null });
    expect(out.attemptId).toMatch(/^[0-9a-f]{32}$/);
    expect(row(t).connectAttempt).toEqual({ id: out.attemptId, createdAt: t.clock.now(), expectWabaId: null });
    expect(t.graph.calls).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });
  test('the Arabic merchant gets the Arabic SDK locale; ES_EXTRAS is passed through', async () => {
    const old = process.env.ES_EXTRAS;
    process.env.ES_EXTRAS = '{"version":"v4-public-preview"}';
    try {
      const t = setup({ stateDoc: { workspaceId: WS, enrolled: true, steps: { business: { status: 'done' }, number: { status: 'skipped' } }, business: { uiLanguage: 'ar' } } });
      const out = await connect.getConnectConfig({ workspaceId: WS }, t.deps);
      expect(out.sdkLocale).toBe('ar_AR');
      expect(out.extras).toEqual({ version: 'v4-public-preview' });
    } finally { if (old === undefined) delete process.env.ES_EXTRAS; else process.env.ES_EXTRAS = old; }
  });
  test('prerequisites first (409), then the Meta configuration (503), then the server capability', async () => {
    const t = setup({ stateDoc: { workspaceId: WS, enrolled: true, steps: { business: { status: 'done' }, number: { status: 'todo' } } } });
    expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, t.deps))).code).toBe('STEP_PREREQUISITE');
    const ok = setup();
    delete process.env.META_ES_CONFIG_ID;
    try { expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, ok.deps))).code).toBe('CONNECT_NOT_CONFIGURED'); } finally { process.env.META_ES_CONFIG_ID = 'CONFIG_ID_FIXTURE'; }
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, ok.deps))).code).toBe('ENCRYPTION_NOT_CONFIGURED');
  });
  test('not enrolled / bad id -> not available', async () => {
    const t = setup({ notEnrolled: true });
    expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, t.deps))).code).toBe('ONBOARDING_NOT_AVAILABLE');
    expect((await rejection(connect.getConnectConfig({ workspaceId: 'x' }, setup().deps))).code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('an already connected workspace needs reconnect mode; reconnect pins the WABA; waba_only pins it silently; a disconnected one is free', async () => {
    const conn = { workspaceId: WS, status: 'connected', ids: { wabaId: '555000111' }, connectSteps: {} };
    let t = setup({ conns: [conn] });
    expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, t.deps))).code).toBe('NUMBER_ALREADY_CONNECTED');
    let out = await connect.getConnectConfig({ workspaceId: WS, reconnect: true }, t.deps);
    expect(out.reconnect).toEqual({ expectedWabaId: '555000111' });
    expect(row(t).connectAttempt.expectWabaId).toBe('555000111');
    t = setup({ conns: [{ ...conn, status: 'waba_only' }] });
    out = await connect.getConnectConfig({ workspaceId: WS }, t.deps);
    expect(out.reconnect).toBeNull();
    expect(row(t).connectAttempt.expectWabaId).toBe('555000111');
    t = setup({ conns: [{ ...conn, status: 'disconnected' }] });
    out = await connect.getConnectConfig({ workspaceId: WS, reconnect: true }, t.deps);
    expect(out.reconnect).toBeNull();
    expect(row(t).connectAttempt.expectWabaId).toBeNull();
    // needsReconnect lifts the "already connected" refusal
    t = setup({ conns: [{ ...conn, needsReconnect: true }] });
    expect((await connect.getConnectConfig({ workspaceId: WS }, t.deps)).enabled).toBe(true);
  });
  test('a running connection (lock) refuses a new attempt and keeps the old one', async () => {
    const t = setup({ conns: [{ workspaceId: WS, status: 'connecting', connectSteps: {}, connectLockUntil: new Date('2026-10-15T09:00:30Z'), connectAttempt: { id: 'old', createdAt: new Date('2026-10-15T08:59:00Z') } }] });
    expect((await rejection(connect.getConnectConfig({ workspaceId: WS }, t.deps))).code).toBe('CONNECT_IN_PROGRESS');
    expect(row(t).connectAttempt.id).toBe('old');
    t.clock.advance(31000); // the lock expired
    expect((await connect.getConnectConfig({ workspaceId: WS }, t.deps)).attemptId).not.toBe('old');
  });
});

describe('recordConnectEvent', () => {
  test('maps the popup report, records analytics (code and event only) and never throws on bad optional input', async () => {
    const t = setup();
    const out = await connect.recordConnectEvent({ workspaceId: WS, attemptId: 'a1b2', event: 'error', errorCode: '3441030', errorMessage: `Number +966551234567 is registered ${'x'.repeat(300)}`, currentStep: 'phone number setup!' }, t.deps);
    expect(out).toEqual({ outcome: 'error', code: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', nextStep: 'number', copyKey: 'onboarding.errors.CONNECT_NUMBER_REGISTERED_ELSEWHERE' });
    expect(t.events).toEqual([{ type: 'connect_event', step: 'connect', code: 'CONNECT_NUMBER_REGISTERED_ELSEWHERE', reason: 'error' }]);
    expect(row(t)).toBeUndefined(); // nothing to annotate yet: no connection row is created by an event
  });
  test('an error outcome is remembered as lastError, a plain cancel is not', async () => {
    const t = setup({ conns: [{ workspaceId: WS, status: 'not_connected' }] });
    await connect.recordConnectEvent({ workspaceId: WS, attemptId: 'abc', event: 'CANCEL' }, t.deps);
    expect(row(t).lastError).toBeUndefined();
    await connect.recordConnectEvent({ workspaceId: WS, attemptId: 'abc', event: 'ERROR', errorCode: 2388091 }, t.deps);
    expect(row(t).lastError).toMatchObject({ code: 'CONNECT_VERIFICATION_FAILED', kind: 'popup' });
  });
  test('validation', async () => {
    const t = setup();
    for (const bad of [{ event: 'FINISH', attemptId: 'a' }, { event: 'CANCEL' }, { event: 'CANCEL', attemptId: '' }, { event: 'CANCEL', attemptId: 'x'.repeat(81) }, { attemptId: 'a' }]) {
      expect((await rejection(connect.recordConnectEvent({ workspaceId: WS, ...bad }, t.deps))).code).toBe('VALIDATION_FAILED');
    }
  });
  test('the logged line carries no full phone number and no long token', async () => {
    const spy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const t = setup();
      await connect.recordConnectEvent({ workspaceId: WS, attemptId: 'abc', event: 'ERROR', errorCode: 123, errorMessage: `token EAAFXTmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz number 966551234567` }, t.deps);
      const text = spy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(text).toContain('popup');
      expect(text).not.toMatch(/\d{9,}/);
      expect(text).not.toContain('EAAFXT');
    } finally { spy.mockRestore(); }
  });
});

describe('completeConnect: preconditions in the documented order', () => {
  test('ENCRYPTION_NOT_CONFIGURED before any Graph call', async () => {
    const t = setup();
    const attemptId = await begin(t);
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    const err = await rejection(complete(t, attemptId));
    expect(err.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect(t.graph.calls).toHaveLength(0);
  });
  test('input validation, prerequisites, attempt id', async () => {
    const t = setup();
    expect((await rejection(complete(t, '', {}))).code).toBe('VALIDATION_FAILED');
    expect((await rejection(complete(t, 'abc', { code: '  ' }))).details.fields).toEqual(['code']);
    expect((await rejection(complete(t, 'x'.repeat(81)))).details.fields).toEqual(['attemptId']);
    expect((await rejection(complete(t, 'f'.repeat(32)))).code).toBe('CONNECT_ATTEMPT_INVALID');
    const blocked = setup({ stateDoc: { workspaceId: WS, enrolled: true, steps: { business: { status: 'todo' }, number: { status: 'done' } } } });
    expect((await rejection(complete(blocked, 'f'.repeat(32)))).code).toBe('STEP_PREREQUISITE');
    expect(t.graph.calls).toHaveLength(0);
  });
  test('an attempt expires after 15 minutes', async () => {
    const t = setup();
    const attemptId = await begin(t);
    t.clock.advance(15 * 60 * 1000 + 1);
    expect((await rejection(complete(t, attemptId))).code).toBe('CONNECT_ATTEMPT_INVALID');
    expect(t.graph.calls).toHaveLength(0);
  });
  test('a held lock -> CONNECT_IN_PROGRESS with zero exchanges; an expired lock is taken over', async () => {
    const t = setup();
    const attemptId = await begin(t);
    row(t).connectLockUntil = new Date(t.clock.ms() + 30000);
    expect((await rejection(complete(t, attemptId))).code).toBe('CONNECT_IN_PROGRESS');
    expect(t.graph.calls).toHaveLength(0);
    t.clock.advance(31000);
    expect((await complete(t, attemptId)).status).toBe('connected');
    expect(row(t).connectLockUntil).toBeNull();
  });
  test('the app credentials must exist (CONNECT_NOT_CONFIGURED) when no client is injected', async () => {
    process.env.WA_APP_SECRET = 'secret-for-the-config-call';
    const t = setup({ deps: { meta: undefined } });
    const attemptId = await begin(t); // the popup payload needs only the app id and config id
    const keep = { a: process.env.WA_APP_SECRET, b: process.env.META_ES_APP_SECRET };
    delete process.env.WA_APP_SECRET; delete process.env.META_ES_APP_SECRET;
    try { expect((await rejection(complete(t, attemptId))).code).toBe('CONNECT_NOT_CONFIGURED'); } finally { if (keep.a) process.env.WA_APP_SECRET = keep.a; if (keep.b) process.env.META_ES_APP_SECRET = keep.b; }
  });
});

describe('completeConnect: the seven steps', () => {
  test('happy path: call list, persisted ids, encrypted token and PIN, bookkeeping hooks', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    const attemptId = await begin(t);
    const res = await complete(t, attemptId);
    expect(res).toMatchObject({ status: 'connected', nextStep: 'approvals', steps: { exchange: 'done', debugToken: 'done', phone: 'done', register: 'done', subscribe: 'done', details: 'done' } });
    expect(names(t)).toEqual(['exchange', 'debugToken', 'listPhones', 'getPhone', 'register', 'subscribe', 'listSubscribed', 'getWaba']); // listPhones: the browser's phone id is verified against the account's numbers before it is claimed (R7-08)
    t.graph.assertMerchantTokenOnly(t.graph.ids.merchantToken);
    expect(t.random.calls.filter((x) => x.min !== undefined)).toEqual([{ min: 100000, max: 1000000 }]);
    const r = row(t);
    expect(r.tokenEncrypted).toMatch(/^v1:/);
    expect(vault.decrypt(r.tokenEncrypted, { workspaceId: WS, purpose: 'token' })).toBe(t.graph.ids.merchantToken);
    expect(vault.decrypt(r.pinEncrypted, { workspaceId: WS, purpose: 'pin' })).toBe('482913');
    expect(r.tokenKeyVersion).toBe(vault.keyVersion());
    expect(r.status).toBe('connected');
    expect(r.ids).toMatchObject({ wabaId: t.graph.ids.wabaId, phoneNumberId: t.graph.ids.phoneId, wabaSource: 'event', onboardingEvent: 'FINISH' });
    expect(r.registration).toMatchObject({ attempts: 1 });
    expect(r.nextCheckAt.getTime()).toBe(t.clock.ms() + 120000);
    expect(r.connectedAt.getTime()).toBe(t.clock.ms());
    expect(r.connectedByUserId).toBe('u1');
    expect(r.connectAttempt.result).toEqual(res);
    expect(t.Claim.docs.map((c) => c._id).sort()).toEqual([`phone:${t.graph.ids.phoneId}`, `waba:${t.graph.ids.wabaId}`]);
    expect(t.steps.markStep).toHaveBeenCalledWith(WS, 'connect', 'done', undefined);
    expect(t.starter.seedStarterTemplates).toHaveBeenCalledWith(WS);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ workspaceId: WS, kind: 'connected', severity: 'success', actionPath: '/setup/approvals', email: true });
    expect(t.events.map((e) => [e.type, e.reason])).toEqual([['connect_result', 'connected']]);
    expect(t.stateMod.invalidate).toHaveBeenCalledWith(WS);
    // guaranteed bookkeeping: current step 4 and prompts.promptedAt even when markStep does nothing
    const st = t.State.docs[0];
    expect(st.progress.currentStep).toBe(4);
    expect(st.prompts.promptedAt).toBeDefined();
  });

  test('markStep NOT_IMPLEMENTED falls back to a direct guarded update; a throwing notify/track/seed never breaks the connection', async () => {
    const stepsStub = { markStep: () => { const e = new Error('stub'); e.code = 'NOT_IMPLEMENTED'; throw e; } };
    const t = setup({ deps: {
      steps: stepsStub,
      notify: async () => { throw new Error('mail down'); },
      track: async () => { throw new Error('db down'); },
      starterTemplates: { seedStarterTemplates: () => { throw new Error('nope'); } },
    } });
    const res = await complete(t, await begin(t));
    expect(res.status).toBe('connected');
    const st = t.State.docs[0];
    expect(st.steps.connect.status).toBe('done');
    expect(st.steps.connect.completedAt).toBeDefined();
    expect(st.progress.currentStep).toBe(4);
  });

  test('FINISH_ONLY_WABA: waba_only, no phone lookup, no register, no connected notification, step 3 untouched', async () => {
    const t = setup();
    t.graph.scenarios.finishOnlyWaba();
    const res = await complete(t, await begin(t), { session: flat(t.graph.session('FINISH_ONLY_WABA')) });
    expect(res).toMatchObject({ status: 'waba_only', nextStep: 'connect' });
    expect(res.steps).toMatchObject({ phone: 'skipped', register: 'skipped', details: 'done' });
    expect(names(t)).toEqual(['exchange', 'debugToken', 'subscribe', 'listSubscribed', 'getWaba']);
    expect(t.steps.markStep).not.toHaveBeenCalled();
    expect(t.notes).toHaveLength(0);
    expect(row(t).connectedAt).toBeUndefined();
    expect(t.events[0]).toMatchObject({ type: 'connect_result', reason: 'waba_only' });
  });

  test('a phone id missing from the session is found with listPhones (newest first)', async () => {
    const t = setup({ graphOptions: { phones: [{}, { display_phone_number: '+966 55 000 0001' }] } });
    const res = await complete(t, await begin(t), { session: { event: 'FINISH', waba_id: t.graph.ids.wabaId } });
    expect(res.status).toBe('connected');
    expect(names(t)).toContain('listPhones');
    expect(row(t).ids.phoneNumberId).toBeTruthy();
  });

  test('coexistence event and an already registered phone skip register; is_on_biz_app also skips', async () => {
    let t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    await complete(t, await begin(t), { session: flat(t.graph.session('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')) });
    expect(t.graph.callsTo('register')).toHaveLength(0);
    expect(row(t).pinEncrypted).toBeUndefined();
    t = setup({ graphOptions: { phoneStatus: 'PENDING', isOnBizApp: true } });
    await complete(t, await begin(t));
    expect(t.graph.callsTo('register')).toHaveLength(0);
    t = setup();
    await complete(t, await begin(t));
    expect(t.graph.callsTo('register')).toHaveLength(0);
  });

  test('health LIMITED -> needs_attention; messaging tier and verification are seeded', async () => {
    const t = setup();
    t.graph.setHealth('LIMITED');
    t.graph.setVerification('pending');
    const res = await complete(t, await begin(t));
    expect(res.status).toBe('needs_attention');
    expect(row(t)).toMatchObject({ health: { canSend: 'LIMITED' }, verification: { businessRaw: 'pending', mapped: 'waiting' }, messagingLimit: { raw: 'TIER_250', tierNumber: 250 } });
    expect(row(t).displayName).toMatchObject({ nameStatusRaw: 'APPROVED', mapped: 'done' });
  });

  test('subscription must be confirmed: our app missing from the list is a failed step', async () => {
    const t = setup();
    t.graph.on({ name: 'listSubscribed' }, () => ({ data: [] }), { times: 1 });
    const err = await rejection(complete(t, await begin(t)));
    expect(err.code).toBe('CONNECT_PARTIAL');
    expect(err.details).toMatchObject({ step: 'subscribe', cause: 'META_ERROR', resumable: true });
    expect(row(t).connectSteps.subscribe.status).toBe('failed');
  });

  test('replay of the attempt returns the stored result without a single Graph call', async () => {
    const t = setup();
    const attemptId = await begin(t);
    const first = await complete(t, attemptId);
    const calls = t.graph.calls.length;
    expect(await complete(t, attemptId)).toEqual(first);
    expect(await complete(t, attemptId, { code: nextCode() })).toEqual(first);
    expect(t.graph.calls).toHaveLength(calls);
    expect(t.graph.state.exchanges).toBe(1);
  });
});

describe('failures: error mapping and resumability', () => {
  test('exchange failures: 400 -> invalid/expired, network -> unreachable, 5xx -> META_ERROR, rate limit; nothing stored', async () => {
    const cases = [
      [(g) => g.scenarios.codeExpired(), 'CONNECT_CODE_INVALID_OR_EXPIRED'],
      [(g) => g.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'exchange' }), 'META_UNREACHABLE'],
      [(g) => g.on({ name: 'exchange' }, () => ({ status: 502, data: 'bad gateway' }), { times: 1 }), 'META_ERROR'],
      [(g) => g.scenarios.rateLimited(4, { match: 'exchange', status: 400 }), 'META_RATE_LIMITED'],
    ];
    for (const [arrange, code] of cases) {
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const t = setup();
        arrange(t.graph);
        const attemptId = await begin(t);
        const err = await rejection(complete(t, attemptId));
        expect(err.code).toBe(code);
        expect(row(t).tokenEncrypted).toBeUndefined();
        expect(row(t).connectAttempt.usedAt).toBeUndefined();
        expect(row(t).status).toBe('not_connected');
      } finally { spy.mockRestore(); }
    }
  });

  test('definitive failures keep their own code, transient ones are CONNECT_PARTIAL; both carry step, cause and resumable', async () => {
    let t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.graph.scenarios.register133016();
    let err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'CONNECT_REGISTER_RATE_LIMITED', status: 429, details: { step: 'register', cause: 'CONNECT_REGISTER_RATE_LIMITED', resumable: true } });
    expect(row(t)).toMatchObject({ status: 'connecting', registration: { attempts: 1, lastErrorCode: 'CONNECT_REGISTER_RATE_LIMITED' } });
    expect(row(t).connectSteps.register).toMatchObject({ status: 'failed', errorCode: 'CONNECT_REGISTER_RATE_LIMITED' });
    expect(t.graph.callsTo('register')).toHaveLength(1);
    t = setup();
    t.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'getPhone' });
    err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'CONNECT_PARTIAL', status: 503, details: { step: 'phone', cause: 'META_UNREACHABLE', resumable: true } });
    t = setup();
    t.graph.scenarios.permissionMissing(200, { match: 'getWaba' });
    err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'META_PERMISSION_MISSING', details: { step: 'details' } });
    expect(row(t).connectSteps.details.status).toBe('failed');
  });

  test('resume re-runs from the first non-done step with the stored token and the stored PIN', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.graph.scenarios.register133016();
    await rejection(complete(t, await begin(t)));
    const exchanges = t.graph.callsTo('exchange').length;
    const phoneCalls = t.graph.callsTo('getPhone').length;
    const res = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(res.status).toBe('connected');
    expect(t.graph.callsTo('exchange')).toHaveLength(exchanges);
    expect(t.graph.callsTo('register')).toHaveLength(2);
    expect(t.graph.callsTo('register')[1].data.pin).toBe('482913');
    expect(t.graph.callsTo('getPhone').length).toBe(phoneCalls + 1); // the status is re-read before registering again
    expect(t.random.calls.filter((x) => x.min !== undefined)).toHaveLength(1); // the PIN is generated once
    expect(row(t).connectLockUntil).toBeNull();
    // the step list shows everything done
    expect(Object.values(res.steps).every((s) => ['done', 'skipped'].includes(s))).toBe(true);
  });

  test('resume needs something to resume, takes the lock, and a connected workspace just returns the stored result', async () => {
    const t = setup();
    expect((await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps))).code).toBe('CONNECT_ATTEMPT_INVALID');
    const done = await complete(t, await begin(t));
    expect(await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps)).toEqual(done);
    const locked = setup({ conns: [{ workspaceId: WS, status: 'connecting', tokenEncrypted: 'v1:x.y.z', connectLockUntil: new Date('2026-10-15T09:00:30Z'), connectSteps: {} }] });
    expect((await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, locked.deps))).code).toBe('CONNECT_IN_PROGRESS');
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    expect((await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, locked.deps))).code).toBe('ENCRYPTION_NOT_CONFIGURED');
  });

  test('a stored token that cannot be decrypted (wrong workspace AAD) cannot be resumed', async () => {
    const foreign = vault.encrypt('some-token-value-123456', { workspaceId: '64b0000000000000000000ff', purpose: 'token' });
    const t = setup({ conns: [{ workspaceId: WS, status: 'connecting', tokenEncrypted: foreign, connectSteps: { exchange: { status: 'done' } }, ids: {} }] });
    expect((await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps))).code).toBe('CONNECT_ATTEMPT_INVALID');
    expect(t.graph.calls).toHaveLength(0);
  });
});

describe('WABA derivation', () => {
  const info = (ids) => ({ wabaTargetIds: ids });
  const run = (token, session, expectWabaId) => ({ token, session, expectWabaId });
  test('the browser claim counts only when the token owns the WABA', async () => {
    const t = setup();
    const d = connect._internal.deriveWaba;
    const c = { meta: () => t.meta };
    expect(await d(c, run('t', { waba_id: '111111' }), info(['111111', '222222']))).toEqual({ wabaId: '111111', source: 'event' });
    expect(await d(c, run('t', { waba_id: '999999' }), info(['111111']))).toEqual({ error: 'CONNECT_WABA_MISMATCH' });
  });
  test('no session at all: the first target; no target: ambiguous', async () => {
    const t = setup();
    const d = connect._internal.deriveWaba;
    const c = { meta: () => t.meta };
    expect(await d(c, run('t', {}), info(['111111', '222222']))).toEqual({ wabaId: '111111', source: 'debug_token' });
    expect(await d(c, run('t', {}), info([]))).toEqual({ error: 'CONNECT_AMBIGUOUS_WABA' });
    expect(await d(c, run('t', { event: 'FINISH' }), info([]))).toEqual({ error: 'CONNECT_AMBIGUOUS_WABA' });
  });
  test('a session without waba_id: one target is used, several are disambiguated by the phone, else ambiguous', async () => {
    const t = setup({ graphOptions: { extraWabaIds: ['2100000000009999'] } });
    const d = connect._internal.deriveWaba;
    // the fake serves one phone list for every WABA: a stub models "this phone belongs to the first WABA only"
    const c = { meta: () => ({ listPhones: async (tok, waba) => (waba === t.graph.ids.wabaId ? [{ id: t.graph.ids.phoneId }] : []) }) };
    const token = t.graph.ids.merchantToken;
    expect(await d(c, run(token, { event: 'FINISH' }), info(['111111']))).toEqual({ wabaId: '111111', source: 'debug_token' });
    expect(await d(c, run(token, { event: 'FINISH' }), info([t.graph.ids.wabaId, '2100000000009999']))).toEqual({ error: 'CONNECT_AMBIGUOUS_WABA' });
    const owner = await d(c, run(token, { event: 'FINISH', phone_number_id: t.graph.ids.phoneId }), info(['2100000000009999', t.graph.ids.wabaId]));
    expect(owner).toEqual({ wabaId: t.graph.ids.wabaId, source: 'debug_token' });
    expect(await d(c, run(token, { event: 'FINISH', phone_number_id: '5555555555' }), info([t.graph.ids.wabaId, '2100000000009999']))).toEqual({ error: 'CONNECT_AMBIGUOUS_WABA' });
  });
  test('reconnect: an expected WABA must match', async () => {
    const t = setup();
    const d = connect._internal.deriveWaba;
    const c = { meta: () => t.meta };
    expect(await d(c, run('t', {}, '222222'), info(['111111', '222222']))).toEqual({ wabaId: '222222', source: 'debug_token' });
    expect(await d(c, run('t', { waba_id: '111111' }, '222222'), info(['111111', '222222']))).toEqual({ error: 'CONNECT_WABA_MISMATCH' });
    expect(await d(c, run('t', {}, '333333'), info(['111111']))).toEqual({ error: 'CONNECT_WABA_MISMATCH' });
  });
  test('claim: a live claim of another workspace blocks, a released one is taken over, own claims are idempotent', async () => {
    const other = '64b000000000000000000002';
    const t = setup({ claims: [{ _id: 'waba:2100000000000001', workspaceId: other, releasedAt: null }] });
    const attemptId = await begin(t);
    const err = await rejection(complete(t, attemptId));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'debugToken', resumable: true } });
    expect(row(t).connectSteps.debugToken.status).toBe('failed');
    t.Claim.docs[0].releasedAt = new Date('2026-10-15T08:00:00Z');
    const ok = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(ok.status).toBe('connected');
    expect(String(t.Claim.docs[0].workspaceId)).toBe(WS);
    expect(t.Claim.docs[0].releasedAt).toBeNull();
    expect(t.Claim.docs).toHaveLength(2); // waba + phone, nothing deleted
  });
});

describe('judgeAttempt', () => {
  const c = { now: () => new Date('2026-10-15T09:10:00Z') };
  const j = connect._internal.judgeAttempt;
  test('every verdict', () => {
    const fresh = { connectAttempt: { id: 'a', createdAt: new Date('2026-10-15T09:00:00Z') } };
    expect(j(c, fresh, 'a')).toEqual({ kind: 'fresh' });
    expect(j(c, fresh, 'b')).toEqual({ kind: 'invalid' });
    expect(j(c, {}, 'a')).toEqual({ kind: 'invalid' });
    expect(j(c, null, 'a')).toEqual({ kind: 'invalid' });
    expect(j(c, { connectAttempt: { id: 'a', createdAt: new Date('2026-10-15T08:50:00Z') } }, 'a')).toEqual({ kind: 'invalid' });
    expect(j(c, { connectAttempt: { id: 'a', usedAt: new Date(), result: { status: 'connected' } } }, 'a')).toEqual({ kind: 'replay', result: { status: 'connected' } });
    expect(j(c, { tokenEncrypted: 'v1:x', connectSteps: { exchange: { status: 'done' } }, connectAttempt: { id: 'a', usedAt: new Date() } }, 'a')).toEqual({ kind: 'continue' });
    expect(j(c, { connectAttempt: { id: 'a', usedAt: new Date() } }, 'a')).toEqual({ kind: 'invalid' });
  });
  test('cleanSession keeps only well-formed values', () => {
    const cs = connect._internal.cleanSession;
    expect(cs({ event: 'finish', phone_number_id: '1234567890', waba_id: ' 99999 ', business_id: 'abc', extra: 'x' })).toEqual({ event: 'FINISH', phone_number_id: '1234567890', waba_id: '99999' });
    expect(cs({ waba_id: '12', event: 'FINISH<script>' })).toEqual({});
    expect(cs(null)).toEqual({});
    expect(cs([1])).toEqual({});
  });
});

describe('disconnect (two steps)', () => {
  async function connected(t) {
    await complete(t, await begin(t));
    t.notes.length = 0;
  }
  test('impact keys follow the state; the token is bound to user, workspace, secret and time', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    await connected(t);
    const req = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(req.expiresInSec).toBe(300);
    expect(req.impactKeys.sort()).toEqual(['number', 'sending', 'templates']);
    const [nonce, exp, sig] = req.confirmationToken.split('.');
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(Number(exp)).toBe(Math.floor(t.clock.ms() / 1000) + 300);
    expect(sig).toBe(crypto.createHmac('sha256', 'unit-test-secret').update(`u1:${WS}:disconnect:${nonce}:${exp}`).digest('hex'));
    // wrong user / wrong text / garbage / other secret -> refused, nothing changes
    for (const args of [
      { userId: 'u2', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' },
      { userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'disconnect' },
      { userId: 'u1', confirmationToken: 'nope', confirmText: 'DISCONNECT' },
      { userId: 'u1', confirmationToken: undefined, confirmText: 'DISCONNECT' },
    ]) expect((await rejection(connect.disconnect({ workspaceId: WS, ...args }, t.deps))).code).toBe('VALIDATION_FAILED');
    expect((await rejection(connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, { ...t.deps, hmacSecret: 'other-secret' }))).details.reason).toBe('CONFIRMATION_INVALID');
    expect(row(t).status).toBe('connected');
    expect(row(t).tokenEncrypted).toBeDefined();
    // expiry
    t.clock.advance(301000);
    expect((await rejection(connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps))).details.reason).toBe('CONFIRMATION_EXPIRED');
  });
  test('refused when AUTH_JWT_SECRET is unset', async () => {
    const t = setup();
    await connected(t);
    const bare = { ...t.deps, hmacSecret: null };
    const keep = process.env.AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    try {
      expect((await rejection(connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, bare))).code).toBe('CONNECT_NOT_CONFIGURED');
      expect((await rejection(connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: `${'a'.repeat(32)}.1760000000.${'b'.repeat(64)}`, confirmText: 'DISCONNECT' }, bare))).code).toBe('CONNECT_NOT_CONFIGURED');
    } finally { if (keep !== undefined) process.env.AUTH_JWT_SECRET = keep; }
  });
  test('disconnect: unsubscribe first (merchant token), then token unset, claims released, PIN and ids kept, step 3 todo, owner mail', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    await connected(t);
    const req = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    const res = await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
    expect(res).toEqual({ status: 'disconnected', unsubscribed: true });
    expect(t.graph.callsTo('unsubscribe')[0].authorization).toBe(`Bearer ${t.graph.ids.merchantToken}`);
    const r = row(t);
    expect(r.status).toBe('disconnected');
    expect(r.tokenEncrypted).toBeUndefined();
    expect(r.pinEncrypted).toMatch(/^v1:/);
    expect(r.ids.wabaId).toBe(t.graph.ids.wabaId);
    expect(r.connectAttempt).toBeUndefined();
    expect(r.webhook.subscribed).toBe(false);
    expect(t.Claim.docs).toHaveLength(2);
    t.Claim.docs.forEach((cl) => expect(cl.releasedAt).toEqual(t.clock.now()));
    expect(t.steps.markStep).toHaveBeenLastCalledWith(WS, 'connect', 'todo', undefined);
    expect(t.notes).toEqual([expect.objectContaining({ kind: 'reconnect_needed', email: true, severity: 'warning' })]);
    expect(t.events.map((e) => e.type)).toContain('status_change');
    expect(t.Connection.docs).toHaveLength(1); // never deleted
    // a second call is a no-op
    const again = await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
    expect(again).toEqual({ status: 'disconnected', unsubscribed: false });
    expect(t.graph.callsTo('unsubscribe')).toHaveLength(1);
  });
  test('nothing to disconnect -> 422; a failing unsubscribe does not block', async () => {
    const t = setup();
    expect((await rejection(connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps))).details.reason).toBe('NOT_CONNECTED');
    await connected(t);
    t.graph.scenarios.networkDrop({ code: 'ETIMEDOUT', match: 'unsubscribe' });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const req = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
      const res = await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
      expect(res).toEqual({ status: 'disconnected', unsubscribed: false });
    } finally { spy.mockRestore(); }
  });
});

describe('reportGraphError', () => {
  const live = () => ({ workspaceId: WS, status: 'connected', connectedAt: new Date('2026-10-14T09:00:00Z'), needsReconnect: false });
  test('reconnect kinds flip needsReconnect with a reason, store lastError, invalidate and notify once', async () => {
    const t = setup({ conns: [live()] });
    await connect.reportGraphError(WS, { code: 190, subcode: 463, httpStatus: 400 }, t.deps);
    expect(row(t)).toMatchObject({ needsReconnect: true, status: 'reconnect_required', reconnectReason: 'TOKEN_EXPIRED', lastError: { code: 'META_TOKEN_REVOKED', kind: 'reconnect', subcode: '463' } });
    expect(t.stateMod.invalidate).toHaveBeenCalledWith(WS);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ kind: 'reconnect_needed', dedupeKey: `reconnect:TOKEN_EXPIRED:${new Date('2026-10-14T09:00:00Z').getTime()}`, email: true });
    await connect.reportGraphError(WS, { code: 190 }, t.deps);
    expect(t.notes).toHaveLength(1);
    expect(row(t).reconnectReason).toBe('TOKEN_EXPIRED');
  });
  test.each([[458, 'APP_UNINSTALLED'], [463, 'TOKEN_EXPIRED'], [460, 'TOKEN_REVOKED'], [undefined, 'TOKEN_REVOKED']])('subcode %s -> %s', async (subcode, reason) => {
    const t = setup({ conns: [live()] });
    await connect.reportGraphError(WS, { code: 190, subcode }, t.deps);
    expect(row(t).reconnectReason).toBe(reason);
  });
  test('102 also flips; other kinds only record lastError; connecting/disconnected rows are not flipped', async () => {
    let t = setup({ conns: [live()] });
    await connect.reportGraphError(WS, { code: 102 }, t.deps);
    expect(row(t).needsReconnect).toBe(true);
    t = setup({ conns: [live()] });
    await connect.reportGraphError(WS, { code: 200 }, t.deps);
    expect(row(t)).toMatchObject({ needsReconnect: false, lastError: { code: 'META_PERMISSION_MISSING', kind: 'permission' } });
    for (const status of ['connecting', 'disconnected', 'not_connected']) {
      t = setup({ conns: [{ ...live(), status }] });
      await connect.reportGraphError(WS, { code: 190 }, t.deps);
      expect(row(t).needsReconnect).toBe(false);
    }
  });
  test('never throws: failing models, garbage ids and garbage errors', async () => {
    const bad = setup().deps;
    bad.Connection = { updateOne: async () => { throw new Error('db down'); }, findOneAndUpdate: () => { throw new Error('db down'); } };
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(connect.reportGraphError(WS, { code: 190 }, bad)).resolves.toBeUndefined();
      await expect(connect.reportGraphError('nope', { code: 190 }, setup().deps)).resolves.toBeUndefined();
      await expect(connect.reportGraphError(undefined, undefined, setup().deps)).resolves.toBeUndefined();
      await expect(connect.reportGraphError(WS, 'text', setup({ conns: [live()] }).deps)).resolves.toBeUndefined();
      const t = setup({ conns: [live()] });
      t.deps.notify = async () => { throw new Error('mail'); };
      await expect(connect.reportGraphError(WS, { code: 190 }, t.deps)).resolves.toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});

describe('immediate starter-template submission after a completed connection (best effort, never awaited)', () => {
  /** a world whose starter module has BOTH exports; t.starter is the one the connect module uses */
  const withSubmit = (submitQueued, extra = {}) => {
    const starter = { seedStarterTemplates: jest.fn(async () => ({})), submitQueued };
    const t = setup({ ...extra, deps: { ...(extra.deps || {}), starterTemplates: starter } });
    t.starter = starter;
    return t;
  };
  const idle = () => connect._internal.idle();

  test('a completed connect submits the queued templates once, after the seeding, with { workspaceId, max: 5 }', async () => {
    const order = [];
    const submitQueued = jest.fn(async () => { order.push('submit'); return { submitted: 5 }; });
    const t = withSubmit(submitQueued);
    t.starter.seedStarterTemplates.mockImplementation(async () => { order.push('seed'); return {}; });
    const res = await complete(t, await begin(t));
    await idle();
    expect(res.status).toBe('connected');
    expect(submitQueued).toHaveBeenCalledTimes(1);
    expect(submitQueued).toHaveBeenCalledWith({ workspaceId: WS, max: 5 });
    expect(order).toEqual(['seed', 'submit']);
  });

  test('NON-BLOCKING: the connect answer is returned while the submission is still running (even one that never finishes)', async () => {
    let release;
    const submitQueued = jest.fn(() => new Promise((resolve) => { release = resolve; }));
    const t = withSubmit(submitQueued);
    const res = await complete(t, await begin(t)); // would hang forever if the connect awaited the job
    expect(res.status).toBe('connected');
    await new Promise((r) => setImmediate(r));
    expect(submitQueued).toHaveBeenCalledTimes(1);
    let idleDone = false;
    const waiting = idle().then(() => { idleDone = true; });
    await new Promise((r) => setImmediate(r));
    expect(idleDone).toBe(false); // the job is still pending
    release({ submitted: 0 });
    await waiting;
    expect(idleDone).toBe(true);
  });

  test('a failing submission (rejection, synchronous throw, no function at all) never changes the connect answer or the stored result; only the code is logged', async () => {
    const lines = [];
    const spy = jest.spyOn(console, 'warn').mockImplementation((...a) => { lines.push(a.map(String).join(' ')); });
    try {
      const baseline = setup();
      const expected = await complete(baseline, await begin(baseline));
      const failures = [
        jest.fn(async () => { throw Object.assign(new Error('Graph said no for token EAAFXTmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz'), { code: 'META_UNREACHABLE' }); }),
        jest.fn(() => { throw Object.assign(new Error('sync boom'), { code: 'TEMPLATE_LIMIT_REACHED' }); }),
        jest.fn(() => Promise.reject('plain string rejection')),
      ];
      for (const submitQueued of failures) {
        const t = withSubmit(submitQueued);
        const res = await complete(t, await begin(t));
        await idle();
        expect(submitQueued).toHaveBeenCalledTimes(1);
        expect(res).toEqual(expected);
        expect(row(t).status).toBe('connected');
        expect(row(t).connectAttempt.result).toEqual(expected);
        expect(await complete(t, row(t).connectAttempt.id)).toEqual(expected); // the replay is the stored result, whatever the job did
        expect(row(t).connectLockUntil).toBeNull();
      }
      const noFn = setup({ deps: { starterTemplates: { seedStarterTemplates: jest.fn(async () => ({})) } } });
      expect(await complete(noFn, await begin(noFn))).toEqual(expected);
      await idle();
      const logged = lines.join('\n');
      expect(logged).toContain('template submit after connect skipped');
      expect(logged).toContain('META_UNREACHABLE');
      expect(logged).toContain('TEMPLATE_LIMIT_REACHED');
      expect(logged).not.toContain('EAAFXT'); // never the message, only the code
      expect(logged).not.toContain('Graph said no');
    } finally { spy.mockRestore(); }
  });

  test('a replay of the finished attempt submits nothing again; a waba_only completion (no number yet) submits nothing', async () => {
    const submitQueued = jest.fn(async () => ({}));
    const t = withSubmit(submitQueued);
    const attemptId = await begin(t);
    await complete(t, attemptId);
    await idle();
    await complete(t, attemptId);
    await complete(t, attemptId, { code: nextCode() });
    await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps); // a connected workspace just returns the stored result
    await idle();
    expect(submitQueued).toHaveBeenCalledTimes(1);

    const q = jest.fn(async () => ({}));
    const w = withSubmit(q);
    w.graph.scenarios.finishOnlyWaba();
    const res = await complete(w, await begin(w), { session: flat(w.graph.session('FINISH_ONLY_WABA')) });
    await idle();
    expect(res.status).toBe('waba_only');
    expect(q).not.toHaveBeenCalled();
  });

  test('a resume that completes a partial run submits too; so does a reconnect (the rows still queued are handed over, an empty queue costs nothing)', async () => {
    const submitQueued = jest.fn(async () => ({}));
    const t = withSubmit(submitQueued, { graphOptions: { phoneStatus: 'PENDING' } });
    t.graph.scenarios.register133016();
    await rejection(complete(t, await begin(t)));
    await idle();
    expect(submitQueued).not.toHaveBeenCalled(); // the run did not complete
    const res = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    await idle();
    expect(res.status).toBe('connected');
    expect(submitQueued).toHaveBeenCalledTimes(1);
    expect(submitQueued).toHaveBeenCalledWith({ workspaceId: WS, max: 5 });

    // reconnect of the same WABA after a revoked token
    row(t).needsReconnect = true;
    row(t).status = 'reconnect_required';
    const attemptId = await begin(t, { reconnect: true });
    const again = await complete(t, attemptId);
    await idle();
    expect(again.status).toBe('connected');
    expect(submitQueued).toHaveBeenCalledTimes(2);
    expect(t.starter.seedStarterTemplates).toHaveBeenCalledTimes(1); // seeded by the first completion only: a reconnect keeps the same WABA
  });

  test('only an enrolled workspace whose subscription is positively NOT active is skipped; no gate state, a failing gate read and an active one all submit', async () => {
    const cases = [
      [undefined, true], // the fake state module has no getGateState
      [async () => ({ enrolled: true, sub: { state: 'active', source: 'stripe' } }), true],
      [async () => { throw new Error('db down'); }, true],
      [async () => ({ enrolled: false }), true],
      [async () => ({ enrolled: true, sub: { state: 'past_due', source: 'stripe' } }), false],
      [async () => ({ enrolled: true, sub: { state: 'cancelled', source: 'stripe' } }), false],
      [async () => ({ enrolled: true, sub: { state: 'pending', source: null } }), false],
    ];
    for (const [getGateState, shouldSubmit] of cases) {
      const submitQueued = jest.fn(async () => ({}));
      const t = withSubmit(submitQueued);
      if (getGateState) t.stateMod.getGateState = jest.fn(getGateState);
      const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const res = await complete(t, await begin(t));
        await idle();
        expect(res.status).toBe('connected');
      } finally { spy.mockRestore(); }
      expect([String(getGateState), submitQueued.mock.calls.length]).toEqual([String(getGateState), shouldSubmit ? 1 : 0]);
      if (getGateState) expect(t.stateMod.getGateState).toHaveBeenCalledWith(WS);
    }
  });

  test('the connect answer is identical with and without the submission hook (same shape, same stored result)', async () => {
    const a = setup();
    const b = withSubmit(jest.fn(async () => ({ submitted: 5 })));
    const ra = await complete(a, await begin(a));
    const rb = await complete(b, await begin(b));
    await idle();
    expect(rb).toEqual(ra);
    expect(Object.keys(rb).sort()).toEqual(['connection', 'level', 'nextStep', 'status', 'steps']);
  });
});

describe('helpers and secrecy', () => {
  test('causeCode maps strings and Graph shapes to catalogue codes', () => {
    const cc = connect._internal.causeCode;
    expect(cc('CONNECT_WABA_MISMATCH')).toBe('CONNECT_WABA_MISMATCH');
    expect(cc('NOT_A_CODE')).toBe('META_ERROR');
    expect(cc({ code: 190 })).toBe('META_TOKEN_REVOKED');
    expect(cc({ code: 133016 })).toBe('CONNECT_REGISTER_RATE_LIMITED');
    expect(cc({ networkCode: 'ETIMEDOUT' })).toBe('META_UNREACHABLE');
  });
  test('impactKeysOf is a subset of sending/templates/number', () => {
    const f = connect._internal.impactKeysOf;
    expect(f({ status: 'connected', ids: { phoneNumberId: '1' } })).toEqual(['sending', 'templates', 'number']);
    expect(f({ status: 'waba_only', ids: {} })).toEqual(['sending', 'templates']);
    expect(f({ status: 'connecting', ids: { phoneNumberId: '1' } })).toEqual(['number']);
    expect(f({ status: 'connecting', ids: {} })).toEqual([]);
  });
  test('code, token and PIN never reach logs, thrown errors, analytics, notifications or the stored result', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => { lines.push(a.map(String).join(' ')); }));
    try {
      const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
      const attemptId = await begin(t);
      const code = nextCode();
      t.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'subscribe' });
      const err = await rejection(complete(t, attemptId, { code }));
      const res = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
      const out = [...lines, err.message, JSON.stringify(err.details), JSON.stringify(res), JSON.stringify(t.events), JSON.stringify(t.notes), JSON.stringify(row(t).connectAttempt), JSON.stringify(row(t).lastError || {})];
      t.graph.assertNoLeak([code, t.graph.ids.merchantToken, '482913'], out);
      const dis = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
      await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: dis.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
      t.graph.assertNoLeak([code, t.graph.ids.merchantToken, '482913'], [...lines, JSON.stringify(t.events), JSON.stringify(t.notes)]);
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
  test('nothing is executed at require time (no timers, no model load on require)', () => {
    jest.isolateModules(() => {
      const mongoose = require('mongoose');
      const before = mongoose.modelNames().filter((m) => /WhatsApp|Onboarding/.test(m));
      require('../../../shared/onboarding/connect');
      require('../../../shared/onboarding/metaClient');
      require('../../../shared/onboarding/metaErrors');
      expect(mongoose.modelNames().filter((m) => /WhatsApp|Onboarding/.test(m))).toEqual(before);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Review fixes R2-01 / R2-04 / R7-03 / R7-08: the platform account, claims taken only after verification and released on failure,
// per-account state that does not survive a switch of the WhatsApp Business account or number.
// ---------------------------------------------------------------------------------------------------------------------------------
describe('the platform account can never be connected by a merchant (review R2-01)', () => {
  const saved = { waba: process.env.WA_WABA_ID, phone: process.env.WA_PHONE_ID };
  const put = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => { put('WA_WABA_ID', saved.waba); put('WA_PHONE_ID', saved.phone); });
  const WRITES = ['subscribe', 'unsubscribe', 'register', 'createTemplate', 'sendMessage', 'setDisplayName'];

  test('the popup names the platform WABA: refused before the single-use code is spent; nothing stored, nothing claimed, no Graph call', async () => {
    const t = setup();
    process.env.WA_WABA_ID = t.graph.ids.wabaId;
    const err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'exchange', resumable: false } });
    expect(err.message).not.toMatch(/platform|waflow's own/i); // the neutral wording of the existing code: it does not say whose account it is
    expect(t.graph.calls).toHaveLength(0);
    expect(t.Claim.docs).toHaveLength(0);
    expect(row(t).tokenEncrypted).toBeUndefined();
    expect((row(t).ids || {}).wabaId).toBeUndefined();
    expect(t.events).toEqual([expect.objectContaining({ type: 'connect_result', code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT' })]);
  });

  test('the token owns the platform WABA (the popup named nothing): refused at the debug-token step; no claim, the token is not kept, no write call', async () => {
    const t = setup();
    process.env.WA_WABA_ID = t.graph.ids.wabaId;
    const err = await rejection(complete(t, await begin(t), { session: { event: 'FINISH' } }));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'debugToken', resumable: false } });
    expect(names(t)).toEqual(['exchange', 'debugToken']);
    expect(t.Claim.docs).toHaveLength(0);
    const r = row(t);
    expect(r.tokenEncrypted).toBeUndefined();
    expect(r.status).toBe('not_connected');
    expect(r.tokenIsValid).toBe(false);
    expect(r.lastError).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', kind: 'platform_account' });
    expect((r.ids || {}).wabaId).toBeUndefined();
    for (const w of WRITES) expect(t.graph.callsTo(w)).toHaveLength(0);
    // nothing is resumable: a resume has no token to work with
    expect((await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps))).code).toBe('CONNECT_ATTEMPT_INVALID');
  });

  test('the platform PHONE id: named by the popup -> refused early; listed by the WABA -> refused at the phone step and the WABA claim goes back', async () => {
    let t = setup();
    process.env.WA_PHONE_ID = t.graph.ids.phoneId;
    let err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'exchange', resumable: false } });
    expect(t.graph.calls).toHaveLength(0);

    t = setup();
    process.env.WA_PHONE_ID = t.graph.ids.phoneId;
    err = await rejection(complete(t, await begin(t), { session: { event: 'FINISH', waba_id: t.graph.ids.wabaId } }));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'phone', resumable: false } });
    expect(names(t)).toEqual(['exchange', 'debugToken', 'listPhones']);
    expect(t.Claim.docs.map((d) => d._id)).toEqual([`waba:${t.graph.ids.wabaId}`]); // never a claim on the platform's number
    expect(t.Claim.docs[0].releasedAt).toEqual(t.clock.now()); // the WABA claim this run took went back (the row stays: nothing is deleted)
    expect(row(t).tokenEncrypted).toBeUndefined();
    expect((row(t).ids || {}).phoneNumberId).toBeUndefined();
    for (const w of WRITES) expect(t.graph.callsTo(w)).toHaveLength(0);
  });

  test('ids stored before the platform was configured are never written to: a re-run is refused before any call, a disconnect makes no unsubscribe call', async () => {
    const t = setup();
    await complete(t, await begin(t));
    t.graph.calls.length = 0;
    process.env.WA_WABA_ID = t.graph.ids.wabaId; // the platform account turns out to be this very WABA
    const again = (await connect.getConnectConfig({ workspaceId: WS, userId: 'u1', reconnect: true }, t.deps)).attemptId;
    expect((await rejection(complete(t, again))).code).toBe('CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT');
    expect(t.graph.calls).toHaveLength(0);
    const req = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    const res = await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
    expect(res).toEqual({ status: 'disconnected', unsubscribed: false });
    expect(t.graph.callsTo('unsubscribe')).toHaveLength(0); // that would remove the production webhook subscription
    expect(row(t).status).toBe('disconnected');
    expect(row(t).tokenEncrypted).toBeUndefined();
  });

  test('with no platform ids configured nothing changes (a merchant account is connected as before)', async () => {
    delete process.env.WA_WABA_ID;
    delete process.env.WA_PHONE_ID;
    const t = setup();
    expect((await complete(t, await begin(t))).status).toBe('connected');
  });
});

describe('claims: only verified ids, released when a run fails, taken again by a resume (reviews R7-08 / R2-04)', () => {
  test('the phone id the browser reports is only a HINT: an account that does not own it gets CONNECT_WABA_MISMATCH, no claim, no stored id', async () => {
    const t = setup();
    const victim = '2999999999999999';
    const err = await rejection(complete(t, await begin(t), { session: { event: 'FINISH', waba_id: t.graph.ids.wabaId, phone_number_id: victim } }));
    expect(err).toMatchObject({ code: 'CONNECT_WABA_MISMATCH', details: { step: 'phone' } });
    expect(names(t)).toEqual(['exchange', 'debugToken', 'listPhones']); // the number list is read BEFORE anything is claimed or looked up
    expect(t.Claim.docs.map((d) => d._id)).toEqual([`waba:${t.graph.ids.wabaId}`]); // nobody can squat on someone else's number id
    expect(t.Claim.docs[0].releasedAt).not.toBeNull();
    expect((row(t).ids || {}).phoneNumberId).toBeUndefined();
    expect(row(t).connectAttempt.phoneHint).toBe(victim);
  });

  test('the stored phone id is the one GRAPH returned after the account listed it; the hint is kept for a resume', async () => {
    const t = setup();
    const res = await complete(t, await begin(t));
    expect(res.status).toBe('connected');
    expect(row(t).ids.phoneNumberId).toBe(t.graph.ids.phoneId);
    expect(row(t).connectAttempt.phoneHint).toBe(t.graph.ids.phoneId);
    expect(t.Claim.docs.map((d) => [d._id, d.releasedAt])).toEqual([[`waba:${t.graph.ids.wabaId}`, null], [`phone:${t.graph.ids.phoneId}`, null]]);
  });

  test('a transient failure at the phone step keeps the hint: the resume looks up the same number (the id is not stored before it is verified)', async () => {
    const t = setup();
    t.graph.scenarios.networkDrop({ code: 'ECONNRESET', match: 'getPhone' });
    const err = await rejection(complete(t, await begin(t)));
    expect(err).toMatchObject({ code: 'CONNECT_PARTIAL', details: { step: 'phone', resumable: true } });
    expect((row(t).ids || {}).phoneNumberId).toBeUndefined();
    expect(row(t).connectAttempt.phoneHint).toBe(t.graph.ids.phoneId);
    t.Claim.docs.forEach((d) => expect(d.releasedAt).not.toBeNull()); // the WABA claim went back with the failed run
    const res = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(res.status).toBe('connected');
    expect(t.graph.callsTo('getPhone').every((c) => c.id === t.graph.ids.phoneId)).toBe(true);
    expect(t.Claim.docs.map((d) => [d._id, d.releasedAt])).toEqual([[`waba:${t.graph.ids.wabaId}`, null], [`phone:${t.graph.ids.phoneId}`, null]]);
  });

  test('a failure after both claims were taken puts them back (rows stay); a resume takes them again from the stored ids', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.graph.scenarios.register133016();
    await rejection(complete(t, await begin(t)));
    expect(t.Claim.docs.map((d) => d._id).sort()).toEqual([`phone:${t.graph.ids.phoneId}`, `waba:${t.graph.ids.wabaId}`]);
    t.Claim.docs.forEach((d) => expect(d.releasedAt).toEqual(t.clock.now()));
    expect(row(t).ids.phoneNumberId).toBe(t.graph.ids.phoneId); // verified before the failing step: kept for the resume
    const res = await connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    expect(res.status).toBe('connected');
    t.Claim.docs.forEach((d) => { expect(String(d.workspaceId)).toBe(WS); expect(d.releasedAt).toBeNull(); });
    expect(t.Claim.docs).toHaveLength(2);
  });

  test('somebody else taking the released number before the resume wins: the resume stops with the same definitive code, its claims go back again', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.graph.scenarios.register133016();
    await rejection(complete(t, await begin(t)));
    const other = '64b000000000000000000002';
    const phoneClaim = t.Claim.docs.find((d) => d._id === `phone:${t.graph.ids.phoneId}`);
    Object.assign(phoneClaim, { workspaceId: other, releasedAt: null, claimedAt: t.clock.now() });
    const err = await rejection(connect.resumeConnect({ workspaceId: WS, userId: 'u1' }, t.deps));
    expect(err).toMatchObject({ code: 'CONNECT_NUMBER_IN_USE_BY_OTHER_ACCOUNT', details: { step: 'phone' } });
    expect(String(phoneClaim.workspaceId)).toBe(other); // untouched
    expect(phoneClaim.releasedAt).toBeNull();
    const wabaClaim = t.Claim.docs.find((d) => d._id === `waba:${t.graph.ids.wabaId}`);
    expect(wabaClaim.releasedAt).not.toBeNull(); // the claim this resume took went back
    expect(t.graph.callsTo('register')).toHaveLength(1); // no second register for a number that is no longer ours
  });

  test('a claim this run did not take (already held by this workspace) is not released when the run fails', async () => {
    const t = setup();
    await complete(t, await begin(t));
    const attemptId = (await connect.getConnectConfig({ workspaceId: WS, userId: 'u1', reconnect: true }, t.deps)).attemptId; // a reconnect of the same account
    t.graph.scenarios.permissionMissing(200, { match: 'subscribe' });
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try { await rejection(complete(t, attemptId)); } finally { spy.mockRestore(); }
    t.Claim.docs.forEach((d) => expect(d.releasedAt).toBeNull()); // they were this workspace's before this run
  });
});

describe('another Meta account or number must not inherit the old one\'s state (review R7-03)', () => {
  const otherAccount = (over = {}) => {
    const g = createFakeGraph({ wabaId: '2200000000000001', phoneId: '2200000000000002', businessId: '2200000000000003', phoneStatus: 'PENDING', ...over });
    return { g, meta: createMetaGraphClient({ http: g.http, appId: g.ids.appId, appSecret: g.ids.appSecret }) };
  };
  const disconnectNow = async (t) => {
    const req = await connect.requestDisconnect({ workspaceId: WS, userId: 'u1' }, t.deps);
    await connect.disconnect({ workspaceId: WS, userId: 'u1', confirmationToken: req.confirmationToken, confirmText: 'DISCONNECT' }, t.deps);
  };
  const finishOn = async (t, g, meta) => {
    t.deps.meta = meta;
    const attemptId = await begin(t);
    return connect.completeConnect({ workspaceId: WS, userId: 'u1', attemptId, code: nextCode(), session: flat(g.session('FINISH')) }, t.deps);
  };

  test('a different WhatsApp Business account: payment confirmation, verification, health, name, registration and PIN are reset; the templates are queued for the new account; register runs', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.starter.requeueForAccount = jest.fn(async () => ({ requeued: 3 }));
    await complete(t, await begin(t));
    expect(t.graph.callsTo('register')).toHaveLength(1);
    // what the owner and Meta said about account A
    Object.assign(row(t), {
      payment: { status: 'confirmed', confirmedAt: new Date('2026-10-15T08:30:00Z'), checkedAt: new Date('2026-10-15T08:31:00Z') },
      verification: { businessRaw: 'verified', mapped: 'done' },
      health: { canSend: 'AVAILABLE' },
      quality: { ratingRaw: 'GREEN' },
      messagingLimit: { raw: 'TIER_1K', tierNumber: 1000 },
      displayName: { nameStatusRaw: 'APPROVED', mapped: 'done', name: 'Shop A' },
    });
    const pinA = row(t).pinEncrypted;
    await disconnectNow(t);
    expect(row(t).ids.wabaId).toBe(t.graph.ids.wabaId); // the ids of A are kept on disconnect

    const b = otherAccount();
    const res = await finishOn(t, b.g, b.meta);
    expect(res.status).toBe('connected');
    const r = row(t);
    expect(r.ids).toMatchObject({ wabaId: b.g.ids.wabaId, phoneNumberId: b.g.ids.phoneId });
    expect(r.payment.status).toBe('unknown'); // A's confirmation says nothing about B
    expect(r.payment.confirmedAt).toBeUndefined();
    expect(r.payment.checkedAt).toBeUndefined();
    expect(b.g.callsTo('register')).toHaveLength(1); // B's number is registered although A's registration was on record
    expect(r.registration.attempts).toBe(1); // counted for B alone
    expect(r.pinEncrypted).toBeDefined();
    expect(r.pinEncrypted).not.toBe(pinA); // a PIN of its own (a fresh one is generated and encrypted)
    expect(t.random.calls.filter((x) => x.min !== undefined)).toHaveLength(2);
    expect(r.displayName.name).toBeUndefined();
    expect(t.starter.requeueForAccount).toHaveBeenCalledTimes(1);
    expect(t.starter.requeueForAccount).toHaveBeenCalledWith({ workspaceId: WS, wabaId: b.g.ids.wabaId });
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'connect_event', code: 'ACCOUNT_SWITCHED', reason: 'waba_changed' }));
    // A's claims were released by the disconnect, B's are held now
    const held = t.Claim.docs.filter((d) => d.releasedAt === null).map((d) => d._id).sort();
    expect(held).toEqual([`phone:${b.g.ids.phoneId}`, `waba:${b.g.ids.wabaId}`]);
  });

  test('the same account with ANOTHER number: that number\'s registration and name are reset, the account\'s own state (payment confirmation) stays, templates are not re-queued', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.starter.requeueForAccount = jest.fn(async () => ({ requeued: 0 }));
    await complete(t, await begin(t));
    Object.assign(row(t), { payment: { status: 'confirmed', confirmedAt: new Date('2026-10-15T08:30:00Z') }, displayName: { nameStatusRaw: 'APPROVED', mapped: 'done', name: 'Shop A' } });
    await disconnectNow(t);
    const sameWabaNewNumber = otherAccount({ wabaId: t.graph.ids.wabaId, phoneId: '2200000000000009', businessId: t.graph.ids.businessId });
    const res = await finishOn(t, sameWabaNewNumber.g, sameWabaNewNumber.meta);
    expect(res.status).toBe('connected');
    const r = row(t);
    expect(r.ids.phoneNumberId).toBe('2200000000000009');
    expect(sameWabaNewNumber.g.callsTo('register')).toHaveLength(1);
    expect(r.payment).toMatchObject({ status: 'confirmed' }); // same WABA: the billing confirmation is still about this account
    expect(t.starter.requeueForAccount).not.toHaveBeenCalled();
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'connect_event', code: 'ACCOUNT_SWITCHED', reason: 'number_changed' }));
  });

  test('reconnecting the SAME account and number resets nothing', async () => {
    const t = setup({ graphOptions: { phoneStatus: 'PENDING' } });
    t.starter.requeueForAccount = jest.fn(async () => ({ requeued: 0 }));
    await complete(t, await begin(t));
    Object.assign(row(t), { payment: { status: 'confirmed', confirmedAt: new Date('2026-10-15T08:30:00Z') } });
    await disconnectNow(t);
    const res = await complete(t, await begin(t));
    expect(res.status).toBe('connected');
    expect(row(t).payment.status).toBe('confirmed');
    expect(t.starter.requeueForAccount).not.toHaveBeenCalled();
    expect(t.events.filter((e) => e.code === 'ACCOUNT_SWITCHED')).toHaveLength(0);
  });

  test('register is decided on the LIVE status of this phone: a record of an earlier registration does not skip a number Meta reports as not connected', async () => {
    const wabaId = '2100000000000001';
    const phoneId = '2100000000000002';
    const conns = [{
      workspaceId: WS, status: 'disconnected', ids: { wabaId, phoneNumberId: phoneId }, registration: { attempts: 1, registeredAt: new Date('2026-10-14T08:00:00Z') },
      connectSteps: { exchange: { status: 'pending' }, debugToken: { status: 'pending' }, phone: { status: 'pending' }, register: { status: 'pending' }, subscribe: { status: 'pending' }, details: { status: 'pending' } },
    }];
    const t = setup({ conns, graphOptions: { phoneStatus: 'PENDING' } });
    const res = await complete(t, await begin(t));
    expect(res.status).toBe('connected');
    expect(t.graph.callsTo('register')).toHaveLength(1); // PENDING on Meta's side: registered again
    // and a number Meta reports as CONNECTED needs no register, whatever our records say
    const connected = setup({ conns: [{ ...clone(conns[0]), registration: {} }] });
    expect((await complete(connected, await begin(connected))).status).toBe('connected');
    expect(connected.graph.callsTo('register')).toHaveLength(0);
  });
});
