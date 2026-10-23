'use strict';
const crypto = require('crypto');
const wh = require('../../../shared/onboarding/webhookEvents');
const sr = require('../../../shared/onboarding/statusRefresh');
const metaConfig = require('../../../shared/onboarding/metaConfig');
const { makeEnv, flush, WS } = require('./_b1dHelpers');

const PLATFORM_WABA = '5550001111';
const PLATFORM_PHONE = '5550002222';
const MIN = 60 * 1000;
const T = 1739321024;

let saved;
beforeEach(() => {
  saved = { f: process.env.ONBOARDING_FLOW, w: process.env.WA_WABA_ID, p: process.env.WA_PHONE_ID };
  process.env.ONBOARDING_FLOW = 'on';
  process.env.WA_WABA_ID = PLATFORM_WABA;
  process.env.WA_PHONE_ID = PLATFORM_PHONE;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const [k, v] of [['ONBOARDING_FLOW', saved.f], ['WA_WABA_ID', saved.w], ['WA_PHONE_ID', saved.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const entry = (id, field, value, time = T) => ({ id, time, changes: [{ field, value }] });
const accountUpdate = (id, event, extra = {}, time = T) => entry(id, 'account_update', { event, ...extra }, time);
const mkReq = (entries, metaSignature, extra = {}) => ({ body: { object: 'whatsapp_business_account', entry: entries, ...extra }, metaSignature });

function setup({ graph, conn = {}, platform = true, ...opts } = {}) {
  const wabaId = '1100000000000001';
  const phoneId = '1100000000000002';
  const env = makeEnv({ graph: { wabaId, phoneId, ...(graph || {}) } });
  if (conn !== null) env.seedConn({ ids: { wabaId, phoneNumberId: phoneId, businessId: 'B1' }, ...conn });
  const starterTemplates = { applyTemplateStatusUpdate: jest.fn(async () => ({ updated: true })) };
  const deps = { ...env.deps, sync: true, starterTemplates, ...(platform ? {} : { platformWabaId: null, platformPhoneId: null }), ...opts };
  const ev = wh.createWebhookEvents(deps);
  return { env, ev, wabaId, phoneId, starterTemplates, deps };
}
const sha = (e) => `meta:${crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex')}`;
const dbCalls = (env) => env.Connection.calls.length + env.Inbound.calls.length;

describe('flag off and non-applicable payloads: nothing runs', () => {
  test('flag off: resolves false, req.body untouched, zero DB calls, no model is even touched', async () => {
    delete process.env.ONBOARDING_FLOW;
    const trap = new Proxy({}, { get() { throw new Error('model touched with the flag off'); } });
    const req = mkReq([accountUpdate('1100000000000001', 'PARTNER_REMOVED')], 'valid');
    const before = JSON.parse(JSON.stringify(req.body));
    const p = wh.intercept(req, { Connection: trap, Inbound: trap, analytics: trap, notifications: trap });
    expect(p).toBeInstanceOf(Promise);
    expect(await p).toBe(false);
    expect(req.body).toEqual(before);
    expect(wh.enabled()).toBe(false);
  });
  test('enabled() is the synchronous flag test', () => {
    process.env.ONBOARDING_FLOW = 'on';
    expect(wh.enabled()).toBe(true);
    process.env.ONBOARDING_FLOW = 'ON';
    expect(wh.enabled()).toBe(false);
  });
  test.each([[undefined], [null], [{}], [{ entry: [] }], [{ entry: 'x' }], [{ entry: {} }], ['text'], [[]]])('body %p -> false, no DB call', async (body) => {
    const { env, ev } = setup();
    expect(await ev.intercept({ body, metaSignature: 'valid' })).toBe(false);
    expect(dbCalls(env)).toBe(0);
  });
  test('a request without a body object is tolerated', async () => {
    const { ev } = setup();
    expect(await ev.intercept(undefined)).toBe(false);
    expect(await ev.intercept({})).toBe(false);
  });
});

describe('classification: platform payloads are left byte-identical with no DB work', () => {
  test('the platform WABA entry: deep-equal untouched, zero lookups', async () => {
    const { env, ev } = setup();
    const e = entry(PLATFORM_WABA, 'messages', { metadata: { phone_number_id: PLATFORM_PHONE }, messages: [{ from: '966500000000', text: { body: 'hi' } }] });
    const req = mkReq([e], undefined);
    const before = JSON.stringify(req.body);
    expect(await ev.intercept(req)).toBe(false);
    expect(JSON.stringify(req.body)).toBe(before);
    expect(req.body.entry[0]).toBe(e);
    expect(dbCalls(env)).toBe(0);
  });
  test('entries without any id (every legacy test payload) and entries of the platform phone number: untouched, no lookups', async () => {
    const { env, ev } = setup();
    const noId = { changes: [{ field: 'messages', value: { statuses: [] } }] };
    const platformPhone = { changes: [{ field: 'messages', value: { metadata: { phone_number_id: PLATFORM_PHONE }, statuses: [] } }] };
    const req = mkReq([noId, platformPhone, { id: '' }, null, 'junk', 5]);
    const before = JSON.stringify(req.body);
    expect(await ev.intercept(req)).toBe(false);
    expect(JSON.stringify(req.body)).toBe(before);
    expect(dbCalls(env)).toBe(0);
  });
  test('an unknown WABA (neither platform nor merchant) stays with the legacy flow by default, with a 60 s negative memo', async () => {
    const { env, ev } = setup();
    const req = () => mkReq([entry('99999999', 'messages', { metadata: { phone_number_id: '88888' }, statuses: [] })]);
    const r1 = req();
    const before = JSON.stringify(r1.body);
    expect(await ev.intercept(r1)).toBe(false);
    expect(JSON.stringify(r1.body)).toBe(before);
    const lookups = env.Connection.calls.length;
    expect(lookups).toBe(2); // waba id + phone id
    expect(await ev.intercept(req())).toBe(false);
    expect(env.Connection.calls.length).toBe(lookups); // memoised (negatives too)
    env.clock.advance(61 * 1000);
    await ev.intercept(req());
    expect(env.Connection.calls.length).toBe(lookups + 2);
  });
  test('the positive memo also lasts 60 s: a row connected a moment ago is found after the memo expires', async () => {
    const { env, ev } = setup({ conn: null });
    const req = () => mkReq([accountUpdate('1100000000000021', 'PARTNER_REMOVED')], 'valid');
    expect(await ev.intercept(req())).toBe(false);
    env.seedConn({ ids: { wabaId: '1100000000000021' } });
    expect(await ev.intercept(req())).toBe(false); // negative memo still fresh
    env.clock.advance(61 * 1000);
    expect(await ev.intercept(req())).toBe(true);
  });
  test('a failing lookup never turns an entry into a merchant entry (it stays with the legacy flow) and is not memoised', async () => {
    const { env, ev } = setup();
    env.Connection.failWith = new Error('db down');
    const req = mkReq([accountUpdate('1100000000000001', 'PARTNER_REMOVED')], 'valid');
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(1);
    env.Connection.failWith = null;
    expect(await ev.intercept(mkReq([accountUpdate('1100000000000001', 'PARTNER_REMOVED')], 'valid'))).toBe(true);
  });
  test('at most 10 phone ids per entry are looked up', async () => {
    const { env, ev } = setup();
    const changes = Array.from({ length: 30 }, (_, i) => ({ field: 'messages', value: { metadata: { phone_number_id: `99100${String(i).padStart(3, '0')}` } } }));
    await ev.intercept(mkReq([{ id: '9900000000000001', changes }]));
    expect(env.Connection.calls.length).toBe(11);
  });
});

describe('merchant entries are processed and REMOVED from req.body.entry', () => {
  test('a merchant-only payload: true, entries emptied, processed, ledger row done', async () => {
    const { env, ev, wabaId } = setup();
    const e = accountUpdate(wabaId, 'PARTNER_REMOVED');
    const req = mkReq([e], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(req.body.entry).toEqual([]);
    expect(env.row()).toMatchObject({ needsReconnect: true, reconnectReason: 'PARTNER_REMOVED', status: 'reconnect_required' });
    const ledger = env.Inbound.rows[0];
    expect(ledger).toMatchObject({ _id: sha(e), source: 'meta', status: 'done', attempts: 1, workspaceId: WS });
    expect(ledger.outcome).toBe('account_update:reconnect');
    expect(ledger.finishedAt).toBeInstanceOf(Date);
    await flush();
    expect(env.notes().filter((n) => n.kind === 'reconnect_needed')).toHaveLength(1);
  });
  test('a mixed payload leaves exactly the platform entries (same objects), merchant entries are processed', async () => {
    const { env, ev, wabaId } = setup();
    const platform = entry(PLATFORM_WABA, 'messages', { metadata: { phone_number_id: PLATFORM_PHONE }, statuses: [] });
    const noId = { changes: [{ field: 'messages', value: { statuses: [] } }] };
    const req = mkReq([platform, accountUpdate(wabaId, 'PARTNER_REMOVED'), noId], 'valid', { extra: 1 });
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(2);
    expect(req.body.entry[0]).toBe(platform);
    expect(req.body.entry[1]).toBe(noId);
    expect(req.body.extra).toBe(1);
    expect(env.row().needsReconnect).toBe(true);
  });
  test('a merchant is also recognised by the phone_number_id of a change (entry id unknown)', async () => {
    const { env, ev, phoneId } = setup();
    const e = entry('1100000000000031', 'phone_number_quality_update', { current_limit: 'TIER_2K', metadata: { phone_number_id: phoneId } });
    expect(await ev.intercept(mkReq([e], 'valid'))).toBe(true);
    expect(env.row().messagingLimit.raw).toBe('TIER_2K');
  });
  test('the merchant of ANOTHER workspace is processed under its own workspace only', async () => {
    const { env, ev, wabaId } = setup();
    env.seedConn({ workspaceId: '507f1f77bcf86cd799439012', ids: { wabaId: '1100000000000011', phoneNumberId: '1100000000000012' } });
    await ev.intercept(mkReq([accountUpdate('1100000000000011', 'PARTNER_REMOVED')], 'valid'));
    expect(env.Connection.rows[0].needsReconnect).toBe(false);
    expect(env.Connection.rows[1].needsReconnect).toBe(true);
    expect(wabaId).toBe('1100000000000001');
  });
  test('default (no sync): intercept resolves first, processing finishes later and is observable on req.onboardingProcessing', async () => {
    const { env, deps, wabaId } = setup();
    const ev = wh.createWebhookEvents({ ...deps, sync: false });
    const req = mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED')], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(req.onboardingProcessing).toBeInstanceOf(Promise);
    expect(Object.keys(req)).not.toContain('onboardingProcessing');
    await req.onboardingProcessing;
    expect(env.row().needsReconnect).toBe(true);
  });
  test('a processing failure never escapes intercept', async () => {
    const { env, ev, wabaId } = setup();
    env.Inbound.failWith = new Error('ledger down');
    const req = mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED')], 'valid');
    await expect(ev.intercept(req)).resolves.toBe(true);
    expect(env.row().needsReconnect).toBe(false);
  });
});

describe('trust model: only req.metaSignature === "valid" changes stored state; everything else is a hint', () => {
  const events = [
    ['account_update', { event: 'PARTNER_REMOVED' }],
    ['account_update', { event: 'ACCOUNT_VIOLATION' }],
    ['account_update', { event: 'ACCOUNT_RECONNECTED' }],
    ['phone_number_name_update', { decision: 'REJECTED', requested_verified_name: 'Forged', rejection_reason: 'NAME_NOT_CONSISTENT' }],
    ['phone_number_quality_update', { current_limit: 'TIER_100K' }],
    ['business_capability_update', { max_daily_conversations_per_business: 'TIER_100K' }],
    ['account_alerts', { entity_type: 'BUSINESS', alert_info: { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED' } }],
  ];
  test.each(['absent', 'invalid', 'unconfigured', undefined, 'VALID', true])('signature %p: every event only schedules a check', async (signature) => {
    for (const [field, value] of events) {
      const { env, ev, wabaId, starterTemplates } = setup({ conn: { nextCheckAt: new Date('2027-01-01T00:00:00Z') } });
      const before = JSON.stringify({ ...env.row(), nextCheckAt: null, updatedAt: null });
      expect(await ev.intercept(mkReq([entry(wabaId, field, value)], signature))).toBe(true);
      expect(new Date(env.row().nextCheckAt).getTime()).toBe(env.clock.ms());
      expect(JSON.stringify({ ...env.row(), nextCheckAt: null, updatedAt: null })).toBe(before);
      expect(env.notes()).toHaveLength(0);
      expect(env.analytics.track).not.toHaveBeenCalled();
      expect(env.g.calls).toHaveLength(0); // an unsigned ACCOUNT_RECONNECTED does not even cause a Graph call
      expect(starterTemplates.applyTemplateStatusUpdate).not.toHaveBeenCalled();
    }
  });
  test('template status updates are not applied unsigned either', async () => {
    const { ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: 1, message_template_name: 'wf_x' })], 'invalid'));
    expect(starterTemplates.applyTemplateStatusUpdate).not.toHaveBeenCalled();
  });
  test('an unsigned event only asks for a poll: it never writes a ledger row (an anonymous caller cannot grow the never-deleted ledger)', async () => {
    const { env, ev, wabaId } = setup();
    expect(await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED')], 'absent'))).toBe(true);
    expect(env.Inbound.rows).toHaveLength(0);
    expect(env.Inbound.calls).toHaveLength(0);
    expect(new Date(env.row().nextCheckAt).getTime()).toBe(env.clock.ms()); // the hint itself
    // distinct unsigned entries never add a row either
    for (let i = 1; i <= 5; i += 1) await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED', {}, T + i)], 'invalid'));
    expect(env.Inbound.rows).toHaveLength(0);
  });
  test('unsigned hints are coalesced: one tiny write per workspace per 30 s, however many events arrive', async () => {
    const { env, ev, wabaId } = setup({ conn: { nextCheckAt: new Date('2027-01-01T00:00:00Z') } });
    for (let i = 0; i < 6; i += 1) await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED', {}, T + i)], 'absent'));
    const writes = () => env.Connection.calls.filter((c) => c[0] === 'updateOne').length;
    expect(writes()).toBe(1);
    env.clock.advance(31 * 1000);
    await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED', {}, T + 10)], 'absent'));
    expect(writes()).toBe(2);
    expect(new Date(env.row().nextCheckAt).getTime()).toBe(env.clock.ms());
  });
});

describe('field handler: account_update', () => {
  test.each([
    ['PARTNER_REMOVED', 'PARTNER_REMOVED'], ['PARTNER_APP_UNINSTALLED', 'APP_UNINSTALLED'], ['ACCOUNT_DELETED', 'WABA_DELETED'],
    ['DISABLED_UPDATE', 'PARTNER_REMOVED'], ['ACCOUNT_OFFBOARDED', 'PARTNER_REMOVED'],
  ])('%s -> needsReconnect with reason %s, one notification + e-mail, redelivery adds nothing', async (event, reason) => {
    const { env, ev, wabaId } = setup();
    const e = accountUpdate(wabaId, event);
    await ev.intercept(mkReq([e], 'valid'));
    await ev.intercept(mkReq([JSON.parse(JSON.stringify(e))], 'valid')); // Meta retry: identical entry
    await ev.intercept(mkReq([accountUpdate(wabaId, event, {}, T + 5)], 'valid')); // a later event
    await flush();
    expect(env.row()).toMatchObject({ needsReconnect: true, reconnectReason: reason, status: 'reconnect_required' });
    expect(env.notes().filter((n) => n.kind === 'reconnect_needed')).toHaveLength(1);
    expect(env.emailSend).toHaveBeenCalledTimes(1);
    expect(env.state.invalidate).toHaveBeenCalledWith(WS);
    expect(env.Inbound.rows).toHaveLength(2);
  });
  test.each(['ACCOUNT_VIOLATION', 'ACCOUNT_RESTRICTION'])('%s -> needs_attention with the issue stored, one account_alert, level needs_attention', async (event) => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([accountUpdate(wabaId, event)], 'valid'));
    expect(env.row().status).toBe('needs_attention');
    expect(env.row().health.issues).toEqual([{ entityType: 'WABA', code: event }]);
    expect(env.notes()).toHaveLength(1);
    expect(env.notes()[0]).toMatchObject({ kind: 'account_alert', severity: 'warning', actionPath: '/setup/approvals' });
    expect(sr.snapshot(env.row()).cause).toEqual({ code: event, path: '/setup/approvals' });
    await flush();
    expect(env.emailSend).toHaveBeenCalledTimes(1); // needs action: e-mail too (markNeedsAttention), once
    expect(env.emailSend.mock.calls[0][0]).toMatchObject({ workspaceId: WS, kind: 'account_alert', params: { code: event } });
  });
  test('violation on a waba_only connection changes nothing (not connected-like)', async () => {
    const { env, ev, wabaId } = setup({ conn: { status: 'waba_only' } });
    await ev.intercept(mkReq([accountUpdate(wabaId, 'ACCOUNT_VIOLATION')], 'valid'));
    expect(env.row().status).toBe('waba_only');
    expect(env.notes()).toHaveLength(0);
  });
  test.each(['ACCOUNT_RECONNECTED', 'PARTNER_ADDED', 'PARTNER_APP_INSTALLED'])('%s -> a refresh from Graph (the truth is read, the payload is not trusted for content)', async (event) => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([accountUpdate(wabaId, event)], 'valid'));
    expect(env.g.callsTo('getWaba')).toHaveLength(1);
    expect(env.Inbound.rows[0].outcome).toBe('account_update:refresh');
  });
  test('a recovered violation clears on the next refresh from Graph', async () => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([accountUpdate(wabaId, 'ACCOUNT_RESTRICTION')], 'valid'));
    expect(env.row().status).toBe('needs_attention');
    await ev.intercept(mkReq([accountUpdate(wabaId, 'ACCOUNT_RECONNECTED', {}, T + 9)], 'valid'));
    expect(env.row().status).toBe('connected');
    expect(env.row().health.issues).toEqual([]);
  });
  test('unknown / empty events are ignored; the ledger says ignored; PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE too', async () => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_CLIENT_CERTIFICATION_STATUS_UPDATE')], 'valid'));
    await ev.intercept(mkReq([entry(wabaId, 'account_update', {}, T + 1)], 'valid'));
    await ev.intercept(mkReq([entry(wabaId, 'account_update', { event: 'SOMETHING_NEW' }, T + 2)], 'valid'));
    expect(env.Inbound.rows.map((r) => r.status)).toEqual(['ignored', 'ignored', 'ignored']);
    expect(env.row().needsReconnect).toBe(false);
  });
  test('a revoke event on a disconnected or already-flagged connection is a no-op', async () => {
    const { env, ev, wabaId } = setup({ conn: { needsReconnect: true, reconnectReason: 'TOKEN_REVOKED', status: 'reconnect_required' } });
    await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED')], 'valid'));
    expect(env.row().reconnectReason).toBe('TOKEN_REVOKED');
    expect(env.notes()).toHaveLength(0);
  });
});

describe('field handler: phone_number_name_update', () => {
  const name = (wabaId, value, time = T) => entry(wabaId, 'phone_number_name_update', value, time);
  test('APPROVED: done, decision APPROVED, the verified name follows, one notification keyed by the new value', async () => {
    const { env, ev, wabaId } = setup({ conn: { displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED', checkedAt: new Date('2026-10-14T00:00:00Z') } } });
    const epoch = sr.epochOf(env.row()); // R7-04: the key carries the epoch of the document version the decision was detected on
    await ev.intercept(mkReq([name(wabaId, { decision: 'APPROVED', requested_verified_name: 'Acme Cafe', display_phone_number: '15550783881' })], 'valid'));
    expect(env.row().displayName).toMatchObject({ mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe', requested: 'Acme Cafe' });
    expect(env.row().displayName.newNameStatusRaw).toBeUndefined();
    expect(new Date(env.row().displayName.checkedAt).getTime()).toBe(env.clock.ms());
    expect(env.row().display.verifiedName).toBe('Acme Cafe');
    expect(env.notes().map((n) => [n.kind, n.dedupeKey])).toEqual([['display_name_decided', sr.displayNameKey('done', 'Acme Cafe', epoch)]]);
  });
  test('the webhook and the next poll notify the same decision only once (same key)', async () => {
    const { env, ev, wabaId } = setup({ conn: { displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } } });
    await ev.intercept(mkReq([name(wabaId, { decision: 'APPROVED', requested_verified_name: 'Acme Cafe' })], 'valid'));
    env.row().displayName.mapped = 'waiting'; // as if the poll had seen the pending state first
    env.g.setPhone({ verified_name: 'Acme Cafe', name_status: 'APPROVED' });
    await sr.refreshConnection(WS, env.deps);
    expect(env.notes().filter((n) => n.kind === 'display_name_decided')).toHaveLength(1);
  });
  test('REJECTED: needs_you, decision REJECTED, the reason is whitelisted (unknown -> UNKNOWN), NAME_DECLINED attention', async () => {
    for (const [reason, stored] of [['NAME_NOT_CONSISTENT', 'NAME_NOT_CONSISTENT'], ['name_format_unacceptable', 'NAME_FORMAT_UNACCEPTABLE'], ['SOMETHING_ELSE', 'UNKNOWN'], [null, 'UNKNOWN']]) {
      const { env, ev, wabaId } = setup({ conn: { displayName: { mapped: 'waiting', newName: 'Bad Name', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } } });
      await ev.intercept(mkReq([name(wabaId, { decision: 'REJECTED', requested_verified_name: 'Bad Name', rejection_reason: reason })], 'valid'));
      expect(env.row().displayName).toMatchObject({ mapped: 'needs_you', decision: 'REJECTED', rejectionReason: stored, newName: 'Bad Name' });
      expect(env.row().status).toBe('needs_attention');
      expect(env.notes().map((n) => n.kind)).toEqual(expect.arrayContaining(['display_name_decided']));
    }
  });
  test.each(['DEFERRED', 'PENDING'])('%s: waiting, no decision, no notification', async (decision) => {
    const { env, ev, wabaId } = setup({ conn: { displayName: { mapped: 'done', nameStatusRaw: 'APPROVED' } } });
    await ev.intercept(mkReq([name(wabaId, { decision, requested_verified_name: 'Newer Name' })], 'valid'));
    expect(env.row().displayName).toMatchObject({ mapped: 'waiting', newName: 'Newer Name', newNameStatusRaw: 'PENDING_REVIEW' });
    expect(env.row().displayName.decision).toBeUndefined();
    expect(env.notes()).toHaveLength(0);
  });
  test('an unknown decision is ignored', async () => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([name(wabaId, { decision: 'WHATEVER' })], 'valid'));
    expect(env.Inbound.rows[0].status).toBe('ignored');
    expect(env.row().displayName.mapped).toBe('done');
  });
  test('the scheduler marker for the re-register survives an approval and a later rejection clears the approval state', async () => {
    const { env, ev, wabaId } = setup({ conn: { displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW' } } });
    await ev.intercept(mkReq([name(wabaId, { decision: 'APPROVED', requested_verified_name: 'Acme Cafe' })], 'valid'));
    expect(env.row().displayName).toMatchObject({ decision: 'APPROVED', newName: 'Acme Cafe' }); // due for re-register
  });
});

describe('field handlers: tiers (phone_number_quality_update, business_capability_update)', () => {
  test.each([
    ['phone_number_quality_update', { current_limit: 'TIER_2K', event: 'THROUGHPUT_UPGRADE' }, 'TIER_2K', 2000],
    ['phone_number_quality_update', { max_daily_conversations_per_business: 'TIER_10K' }, 'TIER_10K', 10000],
    ['business_capability_update', { max_daily_conversations_per_business: 'TIER_100K', max_phone_numbers_per_business: 2 }, 'TIER_100K', 100000],
    ['business_capability_update', { max_daily_conversations_per_business: 2000 }, '2000', 2000],
    ['business_capability_update', { max_daily_conversations_per_business: 'TIER_UNLIMITED' }, 'TIER_UNLIMITED', null],
    ['business_capability_update', { max_daily_conversations_per_business: 'TIER_FUTURE' }, 'TIER_FUTURE', null],
  ])('%s %j -> raw %s, tierNumber %s', async (field, value, raw, tierNumber) => {
    const { env, ev, wabaId } = setup();
    const epoch = sr.epochOf(env.row()); // the key carries the epoch of the document version the change was detected on (R7-04)
    await ev.intercept(mkReq([entry(wabaId, field, value)], 'valid'));
    expect(env.row().messagingLimit).toMatchObject({ raw, tierNumber });
    expect(new Date(env.row().messagingLimit.lastEventAt).getTime()).toBe(env.clock.ms());
    expect(env.notes().map((n) => [n.kind, n.dedupeKey])).toEqual([['messaging_limit_changed', `limit:${raw}:${epoch}`]]);
  });
  test('the same tier again does not notify; a payload without a tier is ignored', async () => {
    const { env, ev, wabaId } = setup({ conn: { messagingLimit: { raw: 'TIER_250', tierNumber: 250 } } });
    await ev.intercept(mkReq([entry(wabaId, 'business_capability_update', { max_daily_conversations_per_business: 'TIER_250' })], 'valid'));
    expect(env.notes()).toHaveLength(0);
    await ev.intercept(mkReq([entry(wabaId, 'business_capability_update', { max_phone_numbers_per_waba: 25 }, T + 1)], 'valid'));
    expect(env.Inbound.rows[1].status).toBe('ignored');
  });
});

describe('field handler: account_alerts', () => {
  const alert = (wabaId, info, time = T) => entry(wabaId, 'account_alerts', { entity_type: 'BUSINESS', entity_id: 'B1', alert_info: info }, time);
  test.each([
    ['CRITICAL', 'OBA_REJECTED', 'action'], ['WARNING', 'PROFILE_PICTURE_LOST', 'warning'], ['INFORMATIONAL', 'OBA_APPROVED', 'info'],
    ['INFORMATIONAL', 'INCREASED_CAPABILITIES_ELIGIBILITY_DEFERRED', 'warning'], ['INFORMATIONAL', 'INCREASED_CAPABILITIES_ELIGIBILITY_FAILED', 'warning'],
    ['INFORMATIONAL', 'INCREASED_CAPABILITIES_ELIGIBILITY_NEED_MORE_INFO', 'warning'],
  ])('severity %s / %s -> notification severity %s', async (alert_severity, alert_type, severity) => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([alert(wabaId, { alert_severity, alert_status: 'ACTIVE', alert_type, alert_description: 'free text with +966500000000 must not be stored' })], 'valid'));
    expect(env.notes()).toHaveLength(1);
    expect(env.notes()[0]).toMatchObject({ kind: 'account_alert', severity, dedupeKey: `alert:${alert_type}:ACTIVE:${T}` });
    expect(env.row().health.issues).toEqual([{ entityType: 'BUSINESS', code: alert_type }]);
    expect(JSON.stringify(env.Connection.rows)).not.toContain('free text');
    expect(JSON.stringify(env.notes())).not.toContain('966500000000');
    // spec Step 4: "needs action" is e-mailed too (warning or action); an informational alert stays in the app
    await flush();
    expect(env.emailSend).toHaveBeenCalledTimes(severity === 'info' ? 0 : 1);
    if (severity !== 'info') expect(env.emailSend.mock.calls[0][0]).toMatchObject({ workspaceId: WS, kind: 'account_alert', params: { code: alert_type } });
  });
  test('the same alert delivered again (Meta retry) sends no second e-mail; a later alert of the same type is its own change', async () => {
    const { env, ev, wabaId } = setup();
    const a = alert(wabaId, { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED' });
    await ev.intercept(mkReq([a], 'valid'));
    await ev.intercept(mkReq([JSON.parse(JSON.stringify(a))], 'valid'));
    await flush();
    expect(env.emailSend).toHaveBeenCalledTimes(1);
    await ev.intercept(mkReq([alert(wabaId, { alert_severity: 'CRITICAL', alert_status: 'ACTIVE', alert_type: 'OBA_REJECTED' }, T + 500)], 'valid'));
    await flush();
    expect(env.emailSend).toHaveBeenCalledTimes(2);
  });
  test('a NONE status removes the issue and does not notify', async () => {
    const { env, ev, wabaId } = setup({ conn: { health: { canSend: 'AVAILABLE', issues: [{ entityType: 'BUSINESS', code: 'OBA_REJECTED' }, { entityType: 'WABA', code: '141002' }] } } });
    await ev.intercept(mkReq([alert(wabaId, { alert_severity: 'CRITICAL', alert_status: 'NONE', alert_type: 'OBA_REJECTED' })], 'valid'));
    expect(env.row().health.issues).toEqual([{ entityType: 'WABA', code: '141002' }]);
    expect(env.notes()).toHaveLength(0);
  });
  test('at most 10 alerts are stored (the newest win); a repeated type is replaced, not duplicated', async () => {
    const { env, ev, wabaId } = setup();
    for (let i = 0; i < 13; i += 1) await ev.intercept(mkReq([alert(wabaId, { alert_severity: 'WARNING', alert_status: 'ACTIVE', alert_type: `TYPE_${i}` }, T + i)], 'valid'));
    expect(env.row().health.issues).toHaveLength(10);
    expect(env.row().health.issues.map((i) => i.code)).toEqual(Array.from({ length: 10 }, (_, k) => `TYPE_${k + 3}`));
    await ev.intercept(mkReq([alert(wabaId, { alert_severity: 'WARNING', alert_status: 'ACTIVE', alert_type: 'TYPE_5' }, T + 99)], 'valid'));
    expect(env.row().health.issues.filter((i) => i.code === 'TYPE_5')).toHaveLength(1);
  });
  test('hostile alert type text is reduced to a safe code; no alert_info -> ignored', async () => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([alert(wabaId, { alert_severity: 'warning', alert_status: 'active', alert_type: '<script>alert(1)</script> x' })], 'valid'));
    expect(env.row().health.issues[0].code).toMatch(/^[A-Z0-9_]+$/);
    await ev.intercept(mkReq([entry(wabaId, 'account_alerts', { entity_type: 'X' }, T + 1)], 'valid'));
    expect(env.Inbound.rows[1].status).toBe('ignored');
  });
});

describe('field handlers: template updates (lazy starterTemplates)', () => {
  test('message_template_status_update -> applyTemplateStatusUpdate with ids as strings', async () => {
    const { ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'message_template_status_update', {
      event: 'rejected', message_template_id: 1689556908129832, message_template_name: 'wf_ab12cd_welcome_optin_en_v1', message_template_language: 'en', reason: 'INVALID_FORMAT',
      rejection_info: { reason: 'INVALID_FORMAT', recommendation: 'Fix it' },
    })], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate).toHaveBeenCalledWith({
      workspaceId: WS, templateId: '1689556908129832', name: 'wf_ab12cd_welcome_optin_en_v1', language: 'en', statusRaw: 'REJECTED', reason: 'INVALID_FORMAT', recommendation: 'Fix it',
    });
  });
  test('the template category of a status event is passed along', async () => {
    const { ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: 8, message_template_name: 'n', message_template_category: 'utility' })], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate.mock.calls[0][0]).toMatchObject({ statusRaw: 'APPROVED', category: 'UTILITY' });
  });
  test('reason NONE is dropped; the approved event carries no reason', async () => {
    const { ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: 7, message_template_name: 'n', reason: 'NONE' })], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate.mock.calls[0][0]).toMatchObject({ statusRaw: 'APPROVED', reason: undefined });
  });
  test('template_category_update -> the same hook with the new category and no status', async () => {
    const { ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'template_category_update', { message_template_id: 123, message_template_name: 'n', message_template_language: 'ar', previous_category: 'UTILITY', new_category: 'MARKETING' })], 'valid'));
    const sent = starterTemplates.applyTemplateStatusUpdate.mock.calls[0][0];
    expect(sent).toMatchObject({ templateId: '123', category: 'MARKETING', language: 'ar' });
    expect(Object.prototype.hasOwnProperty.call(sent, 'statusRaw')).toBe(false); // no status on a category update
  });
  test('no id and no name -> ignored; a missing export -> unavailable (logged, not failed)', async () => {
    const { env, ev, wabaId, starterTemplates } = setup();
    await ev.intercept(mkReq([entry(wabaId, 'message_template_status_update', { event: 'APPROVED' })], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate).not.toHaveBeenCalled();
    const { env: env2, deps } = setup();
    const ev2 = wh.createWebhookEvents({ ...deps, starterTemplates: {} });
    await ev2.intercept(mkReq([entry('1100000000000001', 'message_template_status_update', { event: 'APPROVED', message_template_id: 1 })], 'valid'));
    expect(env2.Inbound.rows[0]).toMatchObject({ status: 'done', outcome: 'message_template_status_update:unavailable' });
    expect(env.Inbound.rows[0].status).toBe('ignored');
  });
  test('the template module throwing marks the entry failed with a code, and Meta\'s retry re-processes it (max 3 attempts)', async () => {
    const { env, ev, wabaId, starterTemplates } = setup();
    starterTemplates.applyTemplateStatusUpdate.mockRejectedValue(Object.assign(new Error('NOT_IMPLEMENTED'), { code: 'NOT_IMPLEMENTED' }));
    const e = entry(wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: 9, message_template_name: 'n' });
    for (let i = 0; i < 5; i += 1) await ev.intercept(mkReq([JSON.parse(JSON.stringify(e))], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate).toHaveBeenCalledTimes(3);
    expect(env.Inbound.rows[0]).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'NOT_IMPLEMENTED' });
  });
});

describe('field handler: messages are acknowledged and dropped with a counter', () => {
  const msg = (wabaId, time = T) => entry(wabaId, 'messages', { metadata: { phone_number_id: '1100000000000002' }, contacts: [{ profile: { name: 'Layla' } }], messages: [{ from: '966500000001', id: 'wamid.1', text: { body: 'secret customer text' } }] }, time);
  test('removed from the body, one webhook_dropped event, nothing stored (no ledger row, no content)', async () => {
    const { env, ev } = setup();
    const req = mkReq([msg('1100000000000001')], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(req.body.entry).toEqual([]);
    expect(env.events().filter((e) => e.type === 'webhook_dropped')).toEqual([{ type: 'webhook_dropped', code: 'WEBHOOK_MESSAGES_DROPPED', reason: 'merchant_inbox_not_enabled', meta: { attempt: 1 } }]);
    expect(env.Inbound.rows).toHaveLength(0);
    const stored = JSON.stringify([env.Connection.rows, env.notes(), env.events()]);
    for (const secret of ['secret customer text', '966500000001', 'Layla', 'wamid.1']) expect(stored).not.toContain(secret);
  });
  test('the counter is flushed once per UTC day per workspace and code (a busy number must not use up the event budget), carrying the count', async () => {
    const { env, ev } = setup();
    for (let i = 0; i < 4; i += 1) await ev.intercept(mkReq([msg('1100000000000001', T + i)], 'valid'));
    expect(env.events().filter((e) => e.type === 'webhook_dropped')).toHaveLength(1);
    env.clock.advance(5 * MIN + 1);
    await ev.intercept(mkReq([msg('1100000000000001', T + 10)], 'valid'));
    env.clock.advance(60 * MIN); // 10:06 UTC: still the same day
    await ev.intercept(mkReq([msg('1100000000000001', T + 11)], 'valid'));
    expect(env.events().filter((e) => e.type === 'webhook_dropped')).toHaveLength(1);
    env.clock.advance(24 * 60 * MIN); // the next UTC day
    await ev.intercept(mkReq([msg('1100000000000001', T + 12)], 'valid'));
    const dropped = env.events().filter((e) => e.type === 'webhook_dropped');
    expect(dropped).toHaveLength(2);
    expect(dropped[1].meta.attempt).toBe(6); // every drop since the previous row: 3 + 1 + 1 buffered on day one, plus the new one
  });
  test('messages work unsigned too (nothing is trusted, nothing is stored)', async () => {
    const { env, ev } = setup();
    expect(await ev.intercept(mkReq([msg('1100000000000001')], undefined))).toBe(true);
    expect(env.row().needsReconnect).toBe(false);
  });
  test('an entry mixing messages and an event: the event is processed, the messages dropped', async () => {
    const { env, ev, wabaId } = setup();
    const mixed = { id: wabaId, time: T, changes: [{ field: 'messages', value: { messages: [{ text: { body: 'x' } }] } }, { field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] };
    await ev.intercept(mkReq([mixed], 'valid'));
    expect(env.row().needsReconnect).toBe(true);
    expect(env.Inbound.rows[0].outcome).toBe('messages:dropped,account_update:reconnect');
  });
});

describe('a disconnected WABA stays matched and is dropped (never the oldest workspace)', () => {
  test.each(['disconnected', 'not_connected'])('status %s: entries removed, nothing processed or stored, counted', async (status) => {
    const { env, ev, wabaId } = setup({ conn: { status, needsReconnect: false } });
    const req = mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED'), entry(wabaId, 'messages', { messages: [{ text: { body: 'hello' } }] }, T + 1)], 'valid');
    expect(await ev.intercept(req)).toBe(true);
    expect(req.body.entry).toEqual([]);
    expect(env.row().needsReconnect).toBe(false);
    expect(env.Inbound.rows).toHaveLength(0);
    expect(env.events().map((e) => e.code)).toEqual(['WEBHOOK_DISCONNECTED_DROPPED']);
  });
});

describe('duplicates', () => {
  test('the same entry delivered twice (also in one payload) is processed once', async () => {
    const { env, ev, wabaId, starterTemplates } = setup();
    const e = entry(wabaId, 'message_template_status_update', { event: 'APPROVED', message_template_id: 5, message_template_name: 'n' });
    await ev.intercept(mkReq([e, JSON.parse(JSON.stringify(e))], 'valid'));
    await ev.intercept(mkReq([JSON.parse(JSON.stringify(e))], 'valid'));
    expect(starterTemplates.applyTemplateStatusUpdate).toHaveBeenCalledTimes(1);
    expect(env.Inbound.rows).toHaveLength(1);
  });
  test('the key is sha256 of the entry JSON; a different time or content is a different entry', async () => {
    const { env, ev, wabaId } = setup();
    const a = accountUpdate(wabaId, 'ACCOUNT_VIOLATION', {}, T);
    await ev.intercept(mkReq([a, accountUpdate(wabaId, 'ACCOUNT_VIOLATION', {}, T + 1), accountUpdate(wabaId, 'ACCOUNT_RESTRICTION', {}, T)], 'valid'));
    expect(env.Inbound.rows).toHaveLength(3);
    expect(env.Inbound.rows.map((r) => r._id)).toContain(sha(a));
    expect(env.Inbound.rows.every((r) => /^meta:[0-9a-f]{64}$/.test(r._id))).toBe(true);
  });
});

describe('ONBOARDING_DROP_UNKNOWN_WABA (opt-in)', () => {
  const unknownWith = (phone) => entry('9900000000000101', 'messages', { metadata: { phone_number_id: phone }, messages: [{ text: { body: 'x' } }] });
  test('off (default): an unknown entry stays with the legacy flow', async () => {
    const { ev } = setup();
    const req = mkReq([unknownWith('9900000000000201')]);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(1);
  });
  test('on: an entry of a phone id that is neither the platform\'s nor a merchant\'s is dropped; platform entries and entries without a phone id are kept', async () => {
    const { ev } = setup({ dropUnknown: true });
    const platform = entry(PLATFORM_WABA, 'messages', { metadata: { phone_number_id: PLATFORM_PHONE }, statuses: [] });
    const noPhone = entry('9900000000000102', 'account_update', { event: 'X' });
    const req = mkReq([platform, unknownWith('9900000000000201'), noPhone]);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toEqual([platform, noPhone]);
    const all = mkReq([unknownWith('9900000000000201')]);
    expect(await ev.intercept(all)).toBe(true);
    expect(all.body.entry).toEqual([]);
  });
  test('on without WA_PHONE_ID set: nothing is dropped (the platform number cannot be told apart)', async () => {
    const { ev } = setup({ dropUnknown: true, platformPhoneId: null });
    const req = mkReq([unknownWith('9900000000000201')]);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(1);
  });
  test('an entry that carries the platform phone id among foreign ones is kept', async () => {
    const { ev } = setup({ dropUnknown: true });
    const e = { id: '9900000000000103', changes: [{ field: 'messages', value: { metadata: { phone_number_id: '9900000000000202' } } }, { field: 'messages', value: { metadata: { phone_number_id: PLATFORM_PHONE } } }] };
    const req = mkReq([e]);
    expect(await ev.intercept(req)).toBe(false);
    expect(req.body.entry).toHaveLength(1);
  });
});

describe('handleEntry (direct)', () => {
  test('reports one outcome per change, never throws, sanitises field names and codes', async () => {
    const { env, ev, starterTemplates } = setup();
    starterTemplates.applyTemplateStatusUpdate.mockRejectedValue(Object.assign(new Error('x'), { code: 'weird code!' }));
    const res = await ev.handleEntry({
      id: '1100000000000001', time: T,
      changes: [
        { field: 'account_update', value: { event: 'ACCOUNT_VIOLATION' } },
        { field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 1 } },
        { field: 'Bad Field!', value: {} },
        { field: 'something_new', value: {} },
        null,
      ],
    }, { workspaceId: WS, signature: 'valid' });
    expect(res.outcomes).toEqual(['account_update:attention', 'message_template_status_update:failed', 'unknown:ignored', 'something_new:ignored', 'unknown:ignored']);
    expect(res).toMatchObject({ failed: true, errorCode: 'WEIRD_CODE_' });
    expect(env.row().status).toBe('needs_attention');
  });
  test('the module-level export builds an instance per call with deps', async () => {
    const { env, deps } = setup();
    const res = await wh.handleEntry({ id: '1100000000000001', changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }, { workspaceId: WS, signature: 'valid' }, deps);
    expect(res.outcomes).toEqual(['account_update:reconnect']);
    expect(env.row().needsReconnect).toBe(true);
  });
  test('no changes -> no outcomes', async () => {
    const { ev } = setup();
    expect(await ev.handleEntry({ id: 'x' }, { workspaceId: WS })).toEqual({ outcomes: [], failed: false, errorCode: undefined });
  });
});

describe('safety', () => {
  test('no secret, token, phone number or message text reaches the logs', async () => {
    const { env, wabaId } = setup();
    const ev = wh.createWebhookEvents({ ...env.deps, sync: true, log: undefined, platformWabaId: PLATFORM_WABA, platformPhoneId: PLATFORM_PHONE });
    const logs = [];
    for (const m of ['warn', 'error']) console[m].mockImplementation((...a) => logs.push(a.map(String).join(' ')));
    env.Inbound.failWith = Object.assign(new Error('failure mentioning 966500000001 and EAAFtoken0123456789012345678901234567890123'), { code: 'X' });
    await ev.intercept(mkReq([accountUpdate(wabaId, 'PARTNER_REMOVED')], 'valid'));
    await flush();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toMatch(/966500000001|EAAFtoken/);
  });
  test('the real model write set never includes message content, tokens or full numbers', async () => {
    const { env, ev, wabaId } = setup();
    await ev.intercept(mkReq([
      entry(wabaId, 'messages', { messages: [{ from: '966500000009', text: { body: 'private' } }] }),
      accountUpdate(wabaId, 'PARTNER_REMOVED', {}, T + 1),
    ], 'valid'));
    const writes = JSON.stringify([...env.Connection.calls, ...env.Inbound.calls]);
    expect(writes).not.toMatch(/private|966500000009/);
    expect(JSON.stringify(env.Connection.rows[0])).toContain(env.row().tokenEncrypted); // sanity: the encrypted envelope is untouched
    expect(env.row().tokenEncrypted).toMatch(/^v1:/);
  });
  test('the metaConfig webhook field list is the one the handlers cover', () => {
    const covered = ['account_update', 'phone_number_name_update', 'phone_number_quality_update', 'business_capability_update', 'account_alerts', 'message_template_status_update', 'template_category_update', 'messages'];
    expect([...metaConfig.MERCHANT_WEBHOOK_FIELDS].sort()).toEqual(covered.sort());
  });
});

describe('matchesMerchant (ruling 1: the positive merchant match webhookSignature relies on)', () => {
  test('true for a merchant entry id or phone id; false for the platform, no ids, unknown WABAs and bad bodies', async () => {
    const { ev, wabaId, phoneId } = setup();
    expect(await ev.matchesMerchant(mkReq([entry(wabaId, 'messages', {})]).body)).toBe(true);
    expect(await ev.matchesMerchant({ entry: [{ changes: [{ value: { metadata: { phone_number_id: phoneId } } }] }] })).toBe(true);
    expect(await ev.matchesMerchant(mkReq([entry(PLATFORM_WABA, 'messages', {})]).body)).toBe(false);
    expect(await ev.matchesMerchant({ entry: [{ changes: [] }] })).toBe(false);
    expect(await ev.matchesMerchant(mkReq([entry('9900000000000099', 'messages', {})]).body)).toBe(false);
    for (const bad of [undefined, null, 'x', 42, [], {}, { entry: 'x' }, { entry: [] }, { entry: [null, 7] }]) expect(await ev.matchesMerchant(bad)).toBe(false);
    // one merchant entry among platform entries is enough
    expect(await ev.matchesMerchant(mkReq([entry(PLATFORM_WABA, 'messages', {}), entry(wabaId, 'messages', {})]).body)).toBe(true);
  });
  test('a failing lookup is NOT a match and never throws; the memo (including negatives) is cleared by clearMemo', async () => {
    const { ev, env, wabaId } = setup();
    env.Connection.failWith = new Error('db down');
    expect(await ev.matchesMerchant(mkReq([entry(wabaId, 'messages', {})]).body)).toBe(false);
    env.Connection.failWith = null;
    expect(await ev.matchesMerchant(mkReq([entry(wabaId, 'messages', {})]).body)).toBe(true);
    // negative memo: a connection created after the first lookup is invisible for the memo window until clearMemo()
    const body = mkReq([entry('1100000000000021', 'messages', {})]).body;
    expect(await ev.matchesMerchant(body)).toBe(false);
    env.seedConn({ ids: { wabaId: '1100000000000021', phoneNumberId: '1100000000000022' } });
    expect(await ev.matchesMerchant(body)).toBe(false);
    ev.clearMemo();
    expect(await ev.matchesMerchant(body)).toBe(true);
  });
  test('the module-level matchesMerchant(body, deps) uses the same classification', async () => {
    const { deps, wabaId } = setup();
    expect(await wh.matchesMerchant(mkReq([entry(wabaId, 'messages', {})]).body, deps)).toBe(true);
    expect(await wh.matchesMerchant(mkReq([entry('9900000000000099', 'messages', {})]).body, deps)).toBe(false);
  });
});
