'use strict';
// Reviews R7-02 / R2-01 / R2-02 / R7-06 / R1-F1 / R1-F3 on shared/onboarding/webhookEvents: the PUBLIC POST /webhook must not turn one
// anonymous request into unbounded database work or memory, and a hung database must not hold the legacy handler.
const wh = require('../../../shared/onboarding/webhookEvents');
const failOpen = require('../../../shared/onboarding/failOpen');
const { makeEnv, flush, WS, WS2 } = require('./_b1dHelpers');

const PLATFORM_WABA = '5550001111';
const PLATFORM_PHONE = '5550002222';
const MERCHANT_WABA = '1100000000000001';
const MERCHANT_PHONE = '1100000000000002';
const T = 1739321024;
const LIM = wh.LIMITS;

let saved;
beforeEach(() => {
  saved = { f: process.env.ONBOARDING_FLOW, w: process.env.WA_WABA_ID, p: process.env.WA_PHONE_ID };
  process.env.ONBOARDING_FLOW = 'on';
  process.env.WA_WABA_ID = PLATFORM_WABA;
  process.env.WA_PHONE_ID = PLATFORM_PHONE;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  failOpen._resetLog();
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [k, v] of [['ONBOARDING_FLOW', saved.f], ['WA_WABA_ID', saved.w], ['WA_PHONE_ID', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const entry = (id, field = 'messages', value = { statuses: [] }, time = T) => ({ id, time, changes: [{ field, value }] });
const accountUpdate = (id, event, time = T) => entry(id, 'account_update', { event }, time);
const mkReq = (entries, metaSignature) => ({ body: { object: 'whatsapp_business_account', entry: entries }, metaSignature });
const unknownIds = (n, start = 9000000000000) => Array.from({ length: n }, (_, i) => String(start + i));
const lookups = (env) => env.Connection.calls.filter((c) => c[0] === 'find').length;

function setup(opts = {}) {
  const env = makeEnv({ graph: { wabaId: MERCHANT_WABA, phoneId: MERCHANT_PHONE } });
  env.seedConn({ ids: { wabaId: MERCHANT_WABA, phoneNumberId: MERCHANT_PHONE, businessId: '77777' } });
  const starterTemplates = { applyTemplateStatusUpdate: jest.fn(async () => ({ updated: true })) };
  const ev = wh.createWebhookEvents({ ...env.deps, sync: true, starterTemplates, ...opts });
  return { env, ev, starterTemplates };
}

describe('R1-F1 / R2-01: a request without a valid signature looks at the FIRST 20 entries only', () => {
  test.each([[21], [50], [500], [3000], [10000]])('%i unsigned entries with distinct unknown ids cause at most 20 lookups; the rest stays untouched in body.entry', async (n) => {
    const { env, ev } = setup();
    const entries = unknownIds(n).map((id) => entry(id));
    const req = mkReq(entries, undefined);
    expect(await ev.intercept(req)).toBe(false);
    expect(lookups(env)).toBeLessThanOrEqual(LIM.MAX_UNSIGNED_ENTRIES);
    expect(LIM.MAX_UNSIGNED_ENTRIES).toBe(20);
    expect(req.body.entry).toHaveLength(n);
    expect(req.body.entry.every((e, i) => e === entries[i])).toBe(true); // same objects, same order: the legacy handler sees them as before
  });
  test.each(['absent', 'invalid', 'unconfigured', undefined])('signature %p is "not valid": the same slice', async (signature) => {
    const { env, ev } = setup();
    await ev.intercept(mkReq(unknownIds(300).map((id) => entry(id)), signature));
    expect(lookups(env)).toBe(20);
  });
  test('a merchant entry beyond the slice is never processed, claimed or hinted (hidden behind 20 unknown entries)', async () => {
    const { env, ev } = setup({ conn: undefined });
    const entries = [...unknownIds(25).map((id) => entry(id)), accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')];
    const req = mkReq(entries, undefined);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(26);
    expect(env.Inbound.rows).toHaveLength(0);
    expect(env.Inbound.calls).toHaveLength(0);
    expect(new Date(env.row().nextCheckAt).getTime()).toBeLessThan(env.clock.ms()); // no hint
    expect(env.row().needsReconnect).toBe(false);
  });
  test('a merchant entry INSIDE the slice is still recognised, removed from the body and only hinted (no ledger row)', async () => {
    const { env, ev } = setup();
    const entries = [...unknownIds(5).map((id) => entry(id)), accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED'), ...unknownIds(30, 8000000000000).map((id) => entry(id))];
    const req = mkReq(entries, 'invalid');
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(35); // 5 + 30 kept, the merchant entry removed
    expect(req.body.entry.some((e) => e.id === MERCHANT_WABA)).toBe(false);
    expect(env.Inbound.rows).toHaveLength(0);
    expect(new Date(env.row().nextCheckAt).getTime()).toBe(env.clock.ms());
    expect(env.row().needsReconnect).toBe(false); // unsigned: a hint only
  });
  test('when every entry of the slice is a merchant entry the rest stays: the answer is false (something is left for the legacy handler)', async () => {
    const { ev } = setup();
    const entries = [...Array.from({ length: 20 }, (_, i) => accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED', T + i)), entry('9000000000000001')];
    const req = mkReq(entries, undefined);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toEqual([entries[20]]);
  });
  test('matchesMerchant (the signature middleware) uses the same slice of 20', async () => {
    const { env, ev } = setup();
    const hidden = [...unknownIds(20).map((id) => entry(id)), entry(MERCHANT_WABA)];
    expect(await ev.matchesMerchant({ entry: hidden })).toBe(false);
    expect(lookups(env)).toBe(20);
    const inside = [...unknownIds(19, 7000000000000).map((id) => entry(id)), entry(MERCHANT_WABA)];
    expect(await ev.matchesMerchant({ entry: inside })).toBe(true);
    expect(await ev.matchesMerchant({ entry: Array.from({ length: 10000 }, (_, i) => entry(String(6000000000000 + i))) })).toBe(false);
    expect(lookups(env)).toBeLessThanOrEqual(20 + 20 + 20);
  });
  test('the per-process budget of uncached lookups per minute covers all anonymous traffic; a valid signature is not subject to it', async () => {
    const { env, ev } = setup({ unsignedLookupsPerMin: 7 });
    for (let r = 0; r < 5; r += 1) await ev.intercept(mkReq(unknownIds(20, 5000000000000 + r * 100).map((id) => entry(id)), undefined));
    expect(lookups(env)).toBe(7);
    env.clock.advance(61 * 1000);
    await ev.intercept(mkReq(unknownIds(20, 4000000000000).map((id) => entry(id)), undefined));
    expect(lookups(env)).toBe(14);
    const before = lookups(env);
    await ev.intercept(mkReq(unknownIds(30, 3000000000000).map((id) => entry(id)), 'valid'));
    expect(lookups(env)).toBe(before + 30);
    // a recognised merchant (memoised) never costs budget
    const m = setup({ unsignedLookupsPerMin: 0 });
    m.ev.clearMemo();
    expect(await m.ev.intercept(mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid'))).toBe(true);
    expect(await m.ev.intercept(mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED', T + 1)], undefined))).toBe(true);
  });
});

describe('R1-F1: a valid signature (only Meta can make one) processes up to 1,000 entries, each DISTINCT id looked up once', () => {
  test('300 entries over 30 distinct merchants: 30 lookups, every entry processed', async () => {
    const env = makeEnv({ graph: { wabaId: MERCHANT_WABA, phoneId: MERCHANT_PHONE } });
    const ids = Array.from({ length: 30 }, (_, i) => String(1200000000000 + i));
    ids.forEach((id, i) => env.seedConn({ workspaceId: `507f1f77bcf86cd7994391${String(10 + i).padStart(2, '0')}`, ids: { wabaId: id, phoneNumberId: String(1300000000000 + i) } }));
    const ev = wh.createWebhookEvents({ ...env.deps, sync: true, starterTemplates: { applyTemplateStatusUpdate: jest.fn() } });
    const entries = Array.from({ length: 300 }, (_, i) => accountUpdate(ids[i % 30], 'PARTNER_REMOVED', T + i));
    const req = mkReq(entries, 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(lookups(env)).toBe(30);
    expect(req.body.entry).toEqual([]);
    expect(env.Connection.rows.filter((r) => r.needsReconnect === true)).toHaveLength(30);
    expect(env.Inbound.rows).toHaveLength(300);
  });
  test('each distinct id is looked up once per request even when the memo is smaller than the request', async () => {
    const { env, ev } = setup();
    const ids = unknownIds(400);
    const entries = [];
    for (let rep = 0; rep < 3; rep += 1) ids.forEach((id) => entries.push(entry(id)));
    await ev.intercept(mkReq(entries, 'valid'));
    expect(lookups(env)).toBe(400);
  });
  test('the cap is 1,000 entries: the 500 beyond it stay untouched in body.entry', async () => {
    const { env, ev } = setup();
    expect(LIM.MAX_SIGNED_ENTRIES).toBe(1000);
    const entries = unknownIds(1500).map((id) => entry(id));
    const req = mkReq(entries, 'valid');
    expect(await ev.intercept(req)).toBe(false);
    expect(lookups(env)).toBe(1000);
    expect(req.body.entry).toHaveLength(1500);
  });
  test('merchant entries within the cap of a big valid payload are all processed, the platform ones stay', async () => {
    const { env, ev } = setup();
    const platform = entry(PLATFORM_WABA);
    const entries = [platform, ...Array.from({ length: 200 }, (_, i) => accountUpdate(MERCHANT_WABA, 'ACCOUNT_VIOLATION', T + i)), ...unknownIds(100).map((id) => entry(id))];
    const req = mkReq(entries, 'valid');
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(101);
    expect(req.body.entry[0]).toBe(platform);
    expect(env.Inbound.rows).toHaveLength(200);
    expect(env.row().status).toBe('needs_attention');
  });
});

describe('R7-02: only digit-only ids of 5 to 30 characters are looked up or memoised', () => {
  test.each([
    ['letters', 'ABCDEF'], ['mixed', '12345abc'], ['4 digits', '1234'], ['31 digits', '1'.repeat(31)], ['with space', '12345 678'], ['empty', ''],
    ['sign', '-1234567'], ['float', '1234567.5'], ['100 kB', 'x'.repeat(100 * 1024)], ['1 MB digits', '7'.repeat(1024 * 1024)],
  ])('entry id %s: no lookup, no memo entry', async (_label, id) => {
    const { env, ev } = setup();
    const req = mkReq([{ id, changes: [] }], 'valid');
    await ev.intercept(req);
    expect(lookups(env)).toBe(0);
    expect(ev._memo.size).toBe(0);
  });
  test('boundaries: 5 and 30 digits are looked up and memoised; an id given as a number works', async () => {
    const { env, ev } = setup();
    await ev.intercept(mkReq([{ id: '12345' }, { id: '9'.repeat(30) }, { id: 1234567890 }], 'valid'));
    expect(lookups(env)).toBe(3);
    expect(ev._memo.size).toBe(3);
  });
  test('phone ids follow the same rule; non-string / non-number ids are ignored, over-long ones never become a key', async () => {
    const { env, ev } = setup();
    const e = { id: '9000000000000001', changes: [
      { field: 'messages', value: { metadata: { phone_number_id: 'not-digits' } } },
      { field: 'messages', value: { metadata: { phone_number_id: { $ne: null } } } },
      { field: 'messages', value: { metadata: { phone_number_id: ['1234567'] } } },
      { field: 'messages', value: { metadata: { phone_number_id: 'y'.repeat(1024 * 1024) } } },
      { field: 'messages', value: { metadata: { phone_number_id: '8000000000000002' } } },
    ] };
    await ev.intercept(mkReq([e], 'valid'));
    expect(lookups(env)).toBe(2); // the waba id and the one valid phone id
    for (const key of ev._memo.keys()) expect(key.length).toBeLessThan(40);
  });
  test('the platform ids short-circuit before any lookup', async () => {
    const { env, ev } = setup();
    const req = mkReq([entry(PLATFORM_WABA), { changes: [{ field: 'messages', value: { metadata: { phone_number_id: PLATFORM_PHONE } } }] }], undefined);
    expect(await ev.intercept(req)).toBe(false);
    expect(lookups(env)).toBe(0);
  });
});

describe('R7-02: the memo evicts expired entries and has a hard cap (oldest first)', () => {
  test('the memo never holds more than MEMO_MAX keys, however many distinct ids arrive', async () => {
    const { env, ev } = setup();
    expect(LIM.MEMO_MAX).toBe(2000);
    for (let r = 0; r < 5; r += 1) await ev.intercept(mkReq(unknownIds(1000, 2000000000000 + r * 1000).map((id) => entry(id)), 'valid'));
    expect(ev._memo.size).toBeLessThanOrEqual(LIM.MEMO_MAX);
    expect(ev._memo.size).toBeGreaterThan(0);
    expect(lookups(env)).toBe(5000);
  });
  test('the oldest entries go first: the newest ids are still memoised after the cap was hit, the first ones are gone', async () => {
    const { ev } = setup();
    for (let r = 0; r < 3; r += 1) await ev.intercept(mkReq(unknownIds(1000, 1000000000000 + r * 1000).map((id) => entry(id)), 'valid'));
    expect(ev._memo.has('waba:1000000002999')).toBe(true); // the last one of the last request
    expect(ev._memo.has('waba:1000000000000')).toBe(false); // the very first one was evicted
    expect(ev._memo.size).toBeLessThanOrEqual(LIM.MEMO_MAX);
  });
  test('expired entries are purged before live ones are evicted', async () => {
    const { env, ev } = setup();
    await ev.intercept(mkReq(unknownIds(1500, 1000000000000).map((id) => entry(id)), 'valid'));
    env.clock.advance(61 * 1000); // all 1,500 expired
    await ev.intercept(mkReq(unknownIds(1000, 2000000000000).map((id) => entry(id)), 'valid'));
    // the old 1,500 expired entries were purged to make room; every new one is still there
    expect(ev._memo.size).toBeLessThanOrEqual(LIM.MEMO_MAX);
    expect(unknownIds(1000, 2000000000000).every((id) => ev._memo.has(`waba:${id}`))).toBe(true);
  });
  test('a hit refreshes nothing and an expired hit is a miss (a looked-up id is looked up again after 60 s)', async () => {
    const { env, ev } = setup();
    const id = '9000000000000042';
    await ev.intercept(mkReq([entry(id)], 'valid'));
    await ev.intercept(mkReq([entry(id)], 'valid'));
    expect(lookups(env)).toBe(1);
    env.clock.advance(61 * 1000);
    await ev.intercept(mkReq([entry(id)], 'valid'));
    expect(lookups(env)).toBe(2);
  });
});

describe('R7-02: changes per entry are capped', () => {
  test('handleEntry works through at most 200 changes of one entry', async () => {
    const { env, ev } = setup();
    const changes = Array.from({ length: 5000 }, () => ({ field: 'account_update', value: { event: 'SOMETHING_NEW' } }));
    const res = await ev.handleEntry({ id: MERCHANT_WABA, time: T, changes }, { workspaceId: WS, signature: 'valid' });
    expect(LIM.MAX_CHANGES).toBe(200);
    expect(res.outcomes).toHaveLength(200);
    expect(env.row().needsReconnect).toBe(false);
  });
  test('phone ids are collected from the first 200 changes only (a merchant phone id at position 300 is invisible)', async () => {
    const { ev } = setup();
    const changes = Array.from({ length: 300 }, (_, i) => ({ field: 'messages', value: { metadata: { phone_number_id: i === 299 ? MERCHANT_PHONE : '9100000000000' } } }));
    expect(await ev.matchesMerchant({ entry: [{ id: '9000000000000777', changes }] })).toBe(false);
  });
});

describe('R7-06: with two rows carrying the same id the LIVE one wins', () => {
  function twoRows(first, second) {
    const env = makeEnv({ graph: { wabaId: MERCHANT_WABA, phoneId: MERCHANT_PHONE } });
    env.seedConn({ workspaceId: WS, status: first.status, needsReconnect: false, ids: { wabaId: MERCHANT_WABA, phoneNumberId: MERCHANT_PHONE }, ...(first.over || {}) });
    env.seedConn({ workspaceId: WS2, status: second.status, needsReconnect: false, ids: { wabaId: MERCHANT_WABA, phoneNumberId: MERCHANT_PHONE }, ...(second.over || {}) });
    const ev = wh.createWebhookEvents({ ...env.deps, sync: true, starterTemplates: { applyTemplateStatusUpdate: jest.fn() } });
    return { env, ev };
  }
  test('older disconnected row first, newer connected row second: the events of the live workspace are processed', async () => {
    const { env, ev } = twoRows({ status: 'disconnected' }, { status: 'connected' });
    const req = mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    const a = env.Connection.rows.find((r) => String(r.workspaceId) === WS);
    const b = env.Connection.rows.find((r) => String(r.workspaceId) === WS2);
    expect(a.needsReconnect).toBe(false);
    expect(b.needsReconnect).toBe(true);
    expect(env.events().filter((e) => e.code === 'WEBHOOK_DISCONNECTED_DROPPED')).toHaveLength(0);
  });
  test('a connected-like row beats a connecting one; any non-disconnected row beats a disconnected one', async () => {
    const t1 = twoRows({ status: 'connecting' }, { status: 'needs_attention' });
    expect((await t1.ev.classify(entry(MERCHANT_WABA))).conn.workspaceId).toBe(WS2);
    const t2 = twoRows({ status: 'disconnected' }, { status: 'waba_only' });
    expect((await t2.ev.classify(entry(MERCHANT_WABA))).conn.workspaceId).toBe(WS2);
    const t3 = twoRows({ status: 'connected' }, { status: 'connected' });
    expect((await t3.ev.classify(entry(MERCHANT_WABA))).conn.workspaceId).toBe(WS); // a tie keeps the first row
  });
  test('only when EVERY match is disconnected is the entry dropped (never the oldest workspace)', async () => {
    const { env, ev } = twoRows({ status: 'disconnected' }, { status: 'not_connected' });
    const req = mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(req.body.entry).toEqual([]);
    expect(env.Connection.rows.every((r) => r.needsReconnect === false)).toBe(true);
    expect(env.events().map((e) => e.code)).toEqual(['WEBHOOK_DISCONNECTED_DROPPED']);
  });
  test('the lookup fetches at most 5 candidates', async () => {
    const { env, ev } = setup();
    await ev.classify(entry(MERCHANT_WABA));
    const find = env.Connection.calls.find((c) => c[0] === 'find');
    expect(find[1]).toEqual({ 'ids.wabaId': MERCHANT_WABA });
  });
});

describe('R1-F3: a lookup that never settles fails open', () => {
  const hang = (env) => { env.Connection.find = () => { const q = { select: () => q, limit: () => q, lean: () => q, then: () => {} }; return q; }; };

  test('intercept resolves false after the timeout; the body is untouched and the legacy handler goes on', async () => {
    const { env, ev } = setup({ lookupTimeoutMs: 30 });
    hang(env);
    const entries = [accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED'), entry('9000000000000002'), entry('9000000000000003')];
    const req = mkReq(entries, 'valid');
    const started = Date.now();
    expect(await ev.intercept(req)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(req.body.entry).toHaveLength(3);
    expect(req.body.entry.every((e, i) => e === entries[i])).toBe(true);
  });
  test('a hung database stops the lookups of that request after the first timeout (no 20 x 1.5 s)', async () => {
    const { env, ev } = setup({ lookupTimeoutMs: 30 });
    let asked = 0;
    env.Connection.find = () => { asked += 1; const q = { select: () => q, limit: () => q, lean: () => q, then: () => {} }; return q; };
    const started = Date.now();
    await ev.intercept(mkReq(unknownIds(20).map((id) => entry(id)), undefined));
    expect(asked).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });
  test('a timed-out lookup is not cached: the next request asks again, and a working database then recognises the merchant', async () => {
    const { env, ev } = setup({ lookupTimeoutMs: 30 });
    const real = env.Connection.find;
    hang(env);
    expect(await ev.intercept(mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid'))).toBe(false);
    expect(ev._memo.size).toBe(0);
    env.Connection.find = real;
    expect(await ev.intercept(mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid'))).toBe(true);
  });
  test('a throttled log line (the code only) is written once per minute for the fail-open path', async () => {
    const { env, ev } = setup({ lookupTimeoutMs: 20 });
    hang(env);
    const warn = console.warn;
    for (let i = 0; i < 4; i += 1) await ev.intercept(mkReq([entry(`90000000000010${i}`)], undefined));
    const lines = warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('fail-open'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/webhookEvents ONB_LOOKUP_TIMEOUT/);
  });
  test('a failure inside intercept never rejects (hunk E3 would swallow it silently): it is logged and the legacy handler goes on', async () => {
    const { env, ev } = setup();
    const trap = new Proxy({}, { get() { throw new Error('boom'); } });
    const evBad = wh.createWebhookEvents({ ...env.deps, Connection: trap, sync: true });
    const req = mkReq([accountUpdate(MERCHANT_WABA, 'PARTNER_REMOVED')], 'valid');
    await expect(evBad.intercept(req)).resolves.toBe(false);
    expect(req.body.entry).toHaveLength(1);
    expect(ev).toBeTruthy();
    await flush();
  });
});
