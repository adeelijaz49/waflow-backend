'use strict';
const sr = require('../../../shared/onboarding/statusRefresh');
const metaConfig = require('../../../shared/onboarding/metaConfig');
const { makeEnv, flush, WS } = require('./_b1dHelpers');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

afterEach(() => { delete process.env.META_PAYMENT_PROBE; });

describe('mappings (DB 6.1): business verification', () => {
  const cases = Object.entries(metaConfig.VERIFICATION_MAP);
  test.each(cases)('business_verification_status %s -> %s', async (raw, mapped) => {
    const env = makeEnv();
    env.g.setVerification(raw);
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().verification.mapped).toBe(mapped);
    expect(env.row().verification.businessRaw).toBe(raw);
  });
  test('an unknown value maps to unknown, uppercase variants are tolerated', async () => {
    const env = makeEnv();
    env.seedConn({ verification: undefined });
    env.g.setVerification('some_future_status');
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().verification.mapped).toBe('unknown');
    env.g.setVerification('VERIFIED');
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().verification.mapped).toBe('done');
  });
});

describe('mappings: display name (name_status / new_name_status)', () => {
  const cases = Object.entries(metaConfig.NAME_STATUS_MAP);
  test.each(cases)('name_status %s -> %s', async (raw, mapped) => {
    const env = makeEnv();
    env.g.setNameStatus(raw);
    env.seedConn({ displayName: undefined });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName.mapped).toBe(mapped);
    expect(env.row().displayName.nameStatusRaw).toBe(raw);
  });
  test('an unknown name_status maps to unknown', async () => {
    const env = makeEnv();
    env.g.setNameStatus('SOMETHING_NEW');
    env.seedConn({ displayName: undefined });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName.mapped).toBe('unknown');
  });
  test('DECLINED puts the connection in needs_attention (NAME_DECLINED, one-click path to the approvals)', async () => {
    const env = makeEnv();
    env.g.setNameStatus('DECLINED');
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName.decision).toBe('REJECTED');
    expect(env.row().status).toBe('needs_attention');
    expect(snap.level).toBe('needs_attention');
    expect(snap.cause).toEqual({ code: 'NAME_DECLINED', path: '/setup/approvals' });
  });
  test('a pending change: new_display_name + PENDING_REVIEW -> waiting; the approval keeps the marker and decision APPROVED', async () => {
    const env = makeEnv();
    env.seedConn();
    env.g.setPhone({ new_display_name: 'Acme Cafe', new_name_status: 'PENDING_REVIEW' });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName).toMatchObject({ mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW' });
    env.g.approveDisplayName();
    env.clock.advance(20 * MIN);
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName).toMatchObject({ mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe' });
    expect(env.row().displayName.newNameStatusRaw).toBeUndefined();
    expect(new Date(env.row().displayName.checkedAt).getTime()).toBe(env.clock.ms());
    const kinds = env.notes().map((n) => n.kind);
    expect(kinds).toEqual(['display_name_decided']);
  });
  test('a declined change (new_name_status DECLINED) -> needs_you, decision REJECTED', async () => {
    const env = makeEnv();
    env.seedConn();
    env.g.setPhone({ new_display_name: 'Bad Name', new_name_status: 'DECLINED' });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName).toMatchObject({ mapped: 'needs_you', decision: 'REJECTED', newName: 'Bad Name' });
  });
  test('displayName.checkedAt only advances when the decision changes', async () => {
    const env = makeEnv();
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    const first = env.row().displayName.checkedAt;
    env.clock.advance(HOUR);
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().displayName.checkedAt).toEqual(first);
  });
});

describe('mappings: messaging limit tiers', () => {
  const tiers = [...Object.keys(metaConfig.TIER_MAP).map((k) => [k, metaConfig.TIER_MAP[k]]), [2000, 2000], ['5000', 5000], ['TIER_FUTURE', null]];
  test.each(tiers)('tier %s -> tierNumber %s', async (raw, tierNumber) => {
    const env = makeEnv();
    env.g.setTier(raw);
    env.seedConn({ messagingLimit: undefined });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().messagingLimit.raw).toBe(String(raw));
    expect(env.row().messagingLimit.tierNumber).toBe(tierNumber);
  });
  test('a change notifies once with the new value in the key, the first read does not', async () => {
    const env = makeEnv();
    env.seedConn();
    env.g.setTier('TIER_2K');
    await sr.refreshConnection(WS, env.deps);
    await sr.refreshConnection(WS, env.deps);
    const limit = env.notes().filter((n) => n.kind === 'messaging_limit_changed');
    expect(limit).toHaveLength(1);
    expect(limit[0].dedupeKey).toMatch(/^limit:TIER_2K:\d+$/); // value + epoch (R7-04)
    const env2 = makeEnv();
    env2.seedConn({ messagingLimit: undefined });
    await sr.refreshConnection(WS, env2.deps);
    expect(env2.notes()).toHaveLength(0);
  });
});

describe('mappings: health, phone status and the persistent level', () => {
  test.each([['AVAILABLE', 'connected'], ['LIMITED', 'needs_attention'], ['BLOCKED', 'needs_attention']])('health %s -> status %s', async (health, status) => {
    const env = makeEnv();
    env.g.setHealth(health);
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().status).toBe(status);
    expect(env.row().health.canSend).toBe(health);
    expect(snap.level).toBe(status);
    if (health === 'BLOCKED') {
      expect(snap.cause).toEqual({ code: 'HEALTH_BLOCKED', path: '/setup/approvals' });
      expect(env.row().health.issues[0]).toMatchObject({ entityType: 'WABA', code: '141002' });
    }
  });
  test('health recovering brings the connection back to connected, with a status_change event and no spurious notification', async () => {
    const env = makeEnv();
    env.g.setHealth('BLOCKED');
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().status).toBe('needs_attention');
    env.g.setHealth('AVAILABLE');
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().status).toBe('connected');
    const codes = env.events().map((e) => e.code);
    expect(codes).toEqual(expect.arrayContaining(['LEVEL_NEEDS_ATTENTION', 'LEVEL_CONNECTED']));
    expect(env.notes().filter((n) => n.kind === 'account_alert')).toHaveLength(1);
    expect(env.state.invalidate).toHaveBeenCalledWith(WS);
  });
  test('a phone that is not CONNECTED shows as an attention cause; PENDING does not', async () => {
    const env = makeEnv();
    env.seedConn();
    env.g.setPhone({ status: 'PENDING' });
    expect((await sr.refreshConnection(WS, env.deps)).level).toBe('connected');
    env.g.setPhone({ status: 'FLAGGED' });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.level).toBe('needs_attention');
    expect(snap.cause.code).toBe('PHONE_FLAGGED');
  });
  test('quality rating and the verified name are stored; the full number never appears in the snapshot', async () => {
    const env = makeEnv({ graph: { qualityRating: 'YELLOW', verifiedName: 'Acme Coffee Co' } });
    env.seedConn({ display: undefined });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().quality.ratingRaw).toBe('YELLOW');
    expect(env.row().display).toMatchObject({ verifiedName: 'Acme Coffee Co', last4: '4567' });
    expect(snap.numberMasked).toMatch(/4567$/);
    expect(JSON.stringify(snap)).not.toContain('966 55 123');
    expect(JSON.stringify(snap)).not.toContain('tokenEncrypted');
  });
});

describe('missing optional fields and field negotiation', () => {
  test('name_status silently absent: nothing breaks, a stored value is kept, the row stays unknown when nothing was stored', async () => {
    const env = makeEnv();
    env.g.scenarios.nameStatusMissing();
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.checks.failed).toBe(0);
    expect(env.row().displayName.mapped).toBe('done'); // previously stored value is not overwritten
    const env2 = makeEnv();
    env2.g.scenarios.nameStatusMissing();
    env2.seedConn({ displayName: undefined });
    await sr.refreshConnection(WS, env2.deps);
    expect(env2.row().displayName === undefined || env2.row().displayName.mapped === undefined).toBe(true);
  });
  test('a rejected optional field retries ONCE with the core list and reports fieldsDegraded', async () => {
    const env = makeEnv();
    env.g.scenarios.fieldRejected('name_status');
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.fieldsDegraded).toBe(true);
    const phoneCalls = env.g.callsTo('getPhone');
    expect(phoneCalls).toHaveLength(2);
    expect(phoneCalls[0].params.fields).toBe(metaConfig.PHONE_FIELDS_FULL);
    expect(phoneCalls[1].params.fields).toBe(metaConfig.PHONE_FIELDS_CORE);
    expect(phoneCalls[1].status).toBe(200);
    expect(env.row().quality.ratingRaw).toBe('GREEN');
    expect(env.row().checkFailures).toBe(0);
    expect(env.row().lastError).toBeUndefined();
  });
  test('a code-100 error that names no requested field is a failure, not a retry', async () => {
    const env = makeEnv();
    env.g.failNext('getPhone', { code: 100, message: '(#100) Something unrelated' });
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('getPhone')).toHaveLength(1);
    expect(snap.fieldsDegraded).toBe(false);
    expect(snap.checks.failed).toBe(1);
  });
  test('a WABA optional field rejected (payment probe on) retries once with the core fields', async () => {
    process.env.META_PAYMENT_PROBE = 'on';
    const env = makeEnv();
    env.g.scenarios.fieldRejected('primary_funding_id');
    env.seedConn();
    const snap = await sr.refreshConnection(WS, { ...env.deps, paymentProbe: undefined });
    expect(snap.fieldsDegraded).toBe(true);
    expect(env.g.callsTo('getWaba')).toHaveLength(2);
    expect(env.row().verification.mapped).toBe('done');
  });
  test('responses with only a subset of fields leave the rest untouched', async () => {
    const env = makeEnv();
    env.g.on({ name: 'getWaba' }, (call) => ({ id: call.id }), { times: 1 });
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().verification).toMatchObject({ businessRaw: 'pending', mapped: 'waiting' });
    expect(env.row().health.canSend).toBe('AVAILABLE');
  });
});

describe('payment probe (META_PAYMENT_PROBE) and self-attestation', () => {
  test('probe off: primary_funding_id is not requested and the payment status stays untouched', async () => {
    const env = makeEnv();
    env.g.setPrimaryFundingId('999');
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('getWaba')[0].params.fields).not.toContain('primary_funding_id');
    expect(env.row().payment.status).toBe('unknown');
  });
  test('probe on: a funding id makes it probe_positive; a missing one never downgrades merchant_confirmed', async () => {
    const env = makeEnv();
    const deps = { ...env.deps, paymentProbe: () => true };
    process.env.META_PAYMENT_PROBE = 'on';
    env.g.setPrimaryFundingId('999');
    env.seedConn();
    await sr.refreshConnection(WS, deps);
    expect(env.row().payment).toMatchObject({ status: 'probe_positive', probeFundingIdPresent: true });
    const env2 = makeEnv();
    env2.seedConn({ payment: { status: 'merchant_confirmed' } });
    await sr.refreshConnection(WS, { ...env2.deps, paymentProbe: () => true });
    expect(env2.row().payment.status).toBe('merchant_confirmed');
    expect(env2.row().payment.probeFundingIdPresent).toBe(false);
  });
});

describe('token expiry and 190 (needsReconnect exactly once)', () => {
  test('a token expiring in less than 7 days -> needs_attention TOKEN_EXPIRING; 8 days or never expires -> connected', async () => {
    const env = makeEnv();
    env.g.setTokenExpiry(env.clock.sec() + 3 * 86400);
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.level).toBe('needs_attention');
    expect(snap.cause).toEqual({ code: 'TOKEN_EXPIRING', path: '/setup/connect' });
    expect(snap.token.nearExpiry).toBe(true);
    env.g.setTokenExpiry(env.clock.sec() + 8 * 86400);
    expect((await sr.refreshConnection(WS, env.deps)).level).toBe('connected');
    env.g.setTokenExpiry(0);
    const snap0 = await sr.refreshConnection(WS, env.deps);
    expect(snap0.level).toBe('connected');
    expect(env.row().tokenExpiresAt).toBeNull();
  });
  test('is_valid:false / 190 -> needsReconnect + reason + exactly ONE notification and ONE e-mail, even after repeated refreshes', async () => {
    const env = makeEnv();
    env.g.scenarios.token190();
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    await flush();
    expect(snap.level).toBe('reconnect_needed');
    expect(env.row()).toMatchObject({ needsReconnect: true, reconnectReason: 'TOKEN_EXPIRED', status: 'reconnect_required' });
    expect(snap.cause).toEqual({ code: 'TOKEN_EXPIRED', path: '/setup/connect' });
    for (let i = 0; i < 3; i += 1) { env.clock.advance(7 * HOUR); await sr.refreshConnection(WS, env.deps); }
    await flush();
    const reconnect = env.notes().filter((n) => n.kind === 'reconnect_needed');
    expect(reconnect).toHaveLength(1);
    expect(reconnect[0].dedupeKey).toMatch(/^reconnect:TOKEN_EXPIRED:\d+$/);
    expect(env.emailSend.mock.calls.length).toBe(1);
    expect(env.connect.reportGraphError).toHaveBeenCalledTimes(1);
    expect(env.connect.reportGraphError.mock.calls[0][0]).toBe(WS);
    expect(env.state.invalidate).toHaveBeenCalledWith(WS);
    expect(env.events().filter((e) => e.type === 'status_change' && /^RECONNECT_/.test(e.code))).toHaveLength(1);
  });
  test('a 190 on a non-debug call (revoked, subcode 458) flags TOKEN_REVOKED and stops calling Graph', async () => {
    const env = makeEnv();
    env.g.failNext('getWaba', { code: 190, subcode: 458, message: 'The user has not authorized application' });
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.row()).toMatchObject({ needsReconnect: true, reconnectReason: 'TOKEN_REVOKED' });
    expect(env.g.callsTo('getPhone')).toHaveLength(0);
    expect(env.g.callsTo('listSubscribed')).toHaveLength(0);
  });
  test('connect.reportGraphError being a NOT_IMPLEMENTED stub does not stop the flip', async () => {
    const env = makeEnv();
    env.deps.connect = { reportGraphError: () => { throw Object.assign(new Error('not implemented'), { code: 'NOT_IMPLEMENTED' }); } };
    env.g.scenarios.token190();
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().needsReconnect).toBe(true);
  });
  test('markNeedsReconnect is idempotent, keeps the first reason and skips a disconnected row', async () => {
    const env = makeEnv();
    env.seedConn();
    expect(await sr.markNeedsReconnect(WS, 'PARTNER_REMOVED', env.deps)).toEqual({ changed: true });
    expect(await sr.markNeedsReconnect(WS, 'DEAUTHORIZED', env.deps)).toMatchObject({ changed: false, skipped: 'already_flagged' });
    expect(env.row().reconnectReason).toBe('PARTNER_REMOVED');
    const env2 = makeEnv();
    env2.seedConn({ status: 'disconnected' });
    expect(await sr.markNeedsReconnect(WS, 'DEAUTHORIZED', env2.deps)).toMatchObject({ changed: false, skipped: 'not_connected' });
    expect(env2.row().needsReconnect).toBe(false);
    expect(await sr.markNeedsReconnect('507f1f77bcf86cd799439099', 'DEAUTHORIZED', env2.deps)).toMatchObject({ changed: false, skipped: 'no_connection' });
  });
  test('a connected row without a stored token is flagged for reconnect', async () => {
    const env = makeEnv();
    env.seedConn({ tokenEncrypted: undefined });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('no_token');
    expect(env.row().needsReconnect).toBe(true);
    expect(env.g.calls).toHaveLength(0);
  });
});

describe('webhook subscription lost', () => {
  test('our app missing -> re-subscribe once, confirm, subscribed again, no needs_attention', async () => {
    const env = makeEnv();
    env.g.setSubscribed(false);
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('subscribe')).toHaveLength(1);
    expect(env.g.callsTo('listSubscribed')).toHaveLength(2);
    expect(env.row().webhook.subscribed).toBe(true);
    expect(snap.level).toBe('connected');
  });
  test('re-subscribe fails -> webhook.subscribed=false, needs_attention WEBHOOK_NOT_SUBSCRIBED, ONE account_alert', async () => {
    const env = makeEnv();
    env.g.setSubscribed(false);
    env.g.failNext({ name: 'subscribe' }, { code: 200, message: '(#200) Requires whatsapp_business_management permission' }, { times: Infinity });
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().webhook.subscribed).toBe(false);
    expect(snap.cause).toEqual({ code: 'WEBHOOK_NOT_SUBSCRIBED', path: '/setup/connect' });
    expect(env.row().status).toBe('needs_attention');
    await sr.refreshConnection(WS, env.deps);
    expect(env.notes().filter((n) => n.kind === 'account_alert')).toHaveLength(1);
    expect(env.g.callsTo('subscribe').length).toBeGreaterThanOrEqual(2); // one attempt per refresh, never a loop inside one
  });
  test('a different app listed is not ours', async () => {
    const env = makeEnv();
    env.g.on({ name: 'listSubscribed' }, () => ({ data: [{ whatsapp_business_api_data: { id: 'OTHER_APP', name: 'Other' } }] }), { times: 1 });
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('subscribe')).toHaveLength(1);
  });
});

describe('failures: back-off and cadence', () => {
  test('a network failure stops after the first call; back-off 15 min, 30, 60 ... capped at 6 h; success resets', async () => {
    const env = makeEnv();
    env.seedConn();
    const expected = [15, 30, 60, 120, 240, 360, 360];
    for (let i = 0; i < expected.length; i += 1) {
      env.g.reset();
      env.g.scenarios.networkDrop({ code: 'ETIMEDOUT', times: Infinity });
      const before = env.g.calls.length;
      const snap = await sr.refreshConnection(WS, env.deps);
      expect(env.g.calls.length - before).toBe(1); // debug_token only: the dead network is not hammered
      expect(snap.checkFailures).toBe(i + 1);
      expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(expected[i] * MIN);
      expect(env.row().lastError).toMatchObject({ code: 'META_UNREACHABLE', kind: 'network' });
      env.clock.advance(7 * HOUR);
    }
    env.g.reset();
    const ok = await sr.refreshConnection(WS, env.deps);
    expect(ok.checkFailures).toBe(0);
    expect(env.row().lastError).toBeUndefined();
  });
  test('when NOTHING could be read the state is stored and then the ORIGINAL Graph error is re-thrown (the route maps it); throwOnFailure:false returns the snapshot', async () => {
    const env = makeEnv();
    env.g.scenarios.networkDrop({ code: 'ETIMEDOUT', times: Infinity });
    env.seedConn();
    const deps = { ...env.deps, throwOnFailure: undefined };
    await expect(sr.refreshConnection(WS, deps)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(env.row().checkFailures).toBe(1); // stored before the throw
    expect(env.row().lastError.code).toBe('META_UNREACHABLE');
    const snap = await sr.refreshConnection(WS, { ...env.deps, throwOnFailure: false });
    expect(snap.checkFailures).toBe(2);
    env.g.reset();
    env.g.scenarios.rateLimited(4, { times: Infinity });
    await expect(sr.refreshConnection(WS, deps)).rejects.toMatchObject({ code: 4 });
  });
  test('a partial failure (something could be read) and a reconnect flip are NOT thrown', async () => {
    const env = makeEnv();
    env.g.scenarios.permissionMissing(200, { match: (c) => c.name === 'getWaba' });
    env.seedConn();
    const deps = { ...env.deps, throwOnFailure: undefined };
    await expect(sr.refreshConnection(WS, deps)).resolves.toMatchObject({ checks: { ok: expect.any(Number), failed: 1 } });
    const env2 = makeEnv();
    env2.g.scenarios.token190();
    env2.seedConn();
    await expect(sr.refreshConnection(WS, { ...env2.deps, throwOnFailure: undefined })).resolves.toMatchObject({ level: 'reconnect_needed' });
  });
  test('a rate-limit error is recorded as META_RATE_LIMITED (kind retry) without flipping anything', async () => {
    const env = makeEnv();
    env.g.scenarios.rateLimited(4, { times: Infinity });
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().needsReconnect).toBe(false);
    expect(env.row().lastError).toMatchObject({ code: 'META_RATE_LIMITED', kind: 'retry' });
    expect(snap.checkFailures).toBe(1);
  });
  test('a permission error (200) -> needs_attention PERMISSION_MISSING', async () => {
    const env = makeEnv();
    env.g.scenarios.permissionMissing(200, { match: (c) => c.name === 'getWaba' });
    env.seedConn();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().lastError).toMatchObject({ code: 'META_PERMISSION_MISSING', kind: 'permission' });
    expect(snap.cause).toEqual({ code: 'PERMISSION_MISSING', path: '/setup/connect' });
    expect(env.row().checkFailures).toBe(0); // other calls still worked
  });
  test('nextCheckDelayMs: 15 min while waiting, 6 h settled, templates and probe, back-off table', () => {
    const settled = { status: 'connected', verification: { mapped: 'done' }, displayName: { mapped: 'done' }, payment: { status: 'unknown' }, checkFailures: 0 };
    expect(sr.nextCheckDelayMs(settled)).toBe(6 * HOUR);
    expect(sr.nextCheckDelayMs({ ...settled, verification: { mapped: 'waiting' } })).toBe(15 * MIN);
    expect(sr.nextCheckDelayMs({ ...settled, displayName: { mapped: 'waiting' } })).toBe(15 * MIN);
    expect(sr.nextCheckDelayMs({ ...settled, status: 'waba_only' })).toBe(15 * MIN);
    expect(sr.nextCheckDelayMs(settled, { templatesWaiting: 2 })).toBe(15 * MIN);
    expect(sr.nextCheckDelayMs(settled, { templatesWaiting: 0 })).toBe(6 * HOUR);
    process.env.META_PAYMENT_PROBE = 'on';
    expect(sr.nextCheckDelayMs(settled)).toBe(15 * MIN);
    expect(sr.nextCheckDelayMs({ ...settled, payment: { status: 'merchant_confirmed' } })).toBe(6 * HOUR);
    delete process.env.META_PAYMENT_PROBE;
    expect([1, 2, 3, 4, 5, 6, 9, 40].map((n) => sr.nextCheckDelayMs({ ...settled, checkFailures: n }) / MIN)).toEqual([15, 30, 60, 120, 240, 360, 360, 360]);
    expect(sr.nextCheckDelayMs(null)).toBe(6 * HOUR);
  });
  test('the stored nextCheckAt follows the cadence (waiting templates -> 15 min, settled -> 6 h)', async () => {
    const env = makeEnv();
    env.seedConn();
    env.deps.templatesWaiting = async () => 3;
    await sr.refreshConnection(WS, env.deps);
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
    env.deps.templatesWaiting = async () => 0;
    await sr.refreshConnection(WS, env.deps);
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(6 * HOUR);
  });
  test('the template rows are read through the model when no templatesWaiting dep is given', async () => {
    const env = makeEnv();
    env.seedConn();
    env.Template.seed({ workspaceId: WS, key: 'welcome_optin', language: 'en', metaStatus: 'PENDING' });
    env.Template.seed({ workspaceId: WS, key: 'comeback', language: 'en', metaStatus: 'APPROVED' });
    await sr.refreshConnection(WS, env.deps);
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
  });
});

describe('transitions write events and notify only on change', () => {
  test('verification waiting -> done: one status_change event and one notification keyed by the new value; a second refresh adds none', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    await sr.refreshConnection(WS, env.deps);
    await sr.refreshConnection(WS, env.deps);
    expect(env.notes().map((n) => [n.kind, n.dedupeKey, n.severity])).toEqual([['verification_changed', expect.stringMatching(/^verification:done:\d+$/), 'success']]);
    expect(env.events().filter((e) => e.code === 'VERIFICATION_DONE')).toHaveLength(1);
    for (const e of env.events()) expect(Object.keys(e).sort()).toEqual(expect.arrayContaining(['type']));
    await flush();
    expect(env.emailSend).toHaveBeenCalledTimes(1); // spec Step 4: e-mail too, once (the second refresh changed nothing)
    expect(env.emailSend.mock.calls[0][0]).toMatchObject({ workspaceId: WS, kind: 'verification_changed', params: { status: 'done' } });
  });
  describe('e-mail for every change (spec Step 4: "an email and an in-app notification when anything changes")', () => {
    const mails = (env) => env.emailSend.mock.calls.map((c) => c[0]);
    test('verification: one e-mail per real change, none for a repeat refresh, a new one for the next change', async () => {
      const env = makeEnv();
      env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
      env.g.setVerification('rejected');
      await sr.refreshConnection(WS, env.deps);
      await sr.refreshConnection(WS, env.deps);
      env.g.setVerification('verified');
      await sr.refreshConnection(WS, env.deps);
      await sr.refreshConnection(WS, env.deps);
      await flush();
      expect(mails(env).map((m) => [m.kind, m.params.status])).toEqual([['verification_changed', 'needs_you'], ['verification_changed', 'done']]);
    });
    test('display name decided: approved and declined each send one e-mail; a decline is ONE e-mail even though it also raises an in-app account alert', async () => {
      const approved = makeEnv();
      approved.seedConn({ displayName: { nameStatusRaw: 'PENDING_REVIEW', mapped: 'waiting', newName: 'Acme Cafe' } });
      approved.g.setNameStatus('APPROVED');
      await sr.refreshConnection(WS, approved.deps);
      await flush();
      expect(mails(approved).map((m) => [m.kind, m.params.status])).toEqual([['display_name_decided', 'done']]);

      const declined = makeEnv();
      declined.seedConn();
      declined.g.setNameStatus('DECLINED');
      await sr.refreshConnection(WS, declined.deps);
      await sr.refreshConnection(WS, declined.deps);
      await flush();
      expect(declined.notes().map((n) => n.kind).sort()).toEqual(['account_alert', 'display_name_decided']); // both in the app
      expect(mails(declined).map((m) => [m.kind, m.params.status])).toEqual([['display_name_decided', 'needs_you']]); // one e-mail for one change
    });
    test('messaging limit: an e-mail only when the value really changes (never for the first read)', async () => {
      const env = makeEnv();
      env.seedConn();
      env.g.setTier('TIER_2K');
      await sr.refreshConnection(WS, env.deps);
      await sr.refreshConnection(WS, env.deps);
      await flush();
      expect(mails(env).map((m) => [m.kind, m.params.limit])).toEqual([['messaging_limit_changed', 'TIER_2K']]);
      const first = makeEnv();
      first.seedConn({ messagingLimit: undefined });
      await sr.refreshConnection(WS, first.deps);
      await flush();
      expect(first.emailSend).not.toHaveBeenCalled();
    });
    test('level -> needs_attention (a cause that needs the merchant) is an account_alert e-mail; a repeat refresh adds nothing, the same cause AGAIN after a recovery is announced again (R7-04)', async () => {
      const env = makeEnv();
      env.seedConn();
      env.g.setTokenExpiry(env.clock.sec() + 3 * 86400);
      await sr.refreshConnection(WS, env.deps);
      env.clock.advance(MIN);
      await sr.refreshConnection(WS, env.deps); // still the same condition: nothing new
      env.clock.advance(MIN);
      env.g.setTokenExpiry(env.clock.sec() + 30 * 86400); // recovered
      await sr.refreshConnection(WS, env.deps);
      expect(env.row().status).toBe('connected');
      env.clock.advance(MIN);
      env.g.setTokenExpiry(env.clock.sec() + 3 * 86400); // the same cause again
      await sr.refreshConnection(WS, env.deps);
      await flush();
      expect(mails(env).map((m) => [m.kind, m.params.code])).toEqual([['account_alert', 'TOKEN_EXPIRING'], ['account_alert', 'TOKEN_EXPIRING']]);
      const keys = env.notes().filter((n) => n.kind === 'account_alert').map((n) => n.dedupeKey);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
      for (const k of keys) expect(k).toMatch(/^level:needs_attention:TOKEN_EXPIRING:\d+$/);
    });
    test('markNeedsAttention: one e-mail per event key', async () => {
      const env = makeEnv();
      env.seedConn();
      await sr.markNeedsAttention(WS, { code: 'ACCOUNT_VIOLATION' }, env.deps, { eventKey: 'e1' });
      await sr.markNeedsAttention(WS, { code: 'ACCOUNT_VIOLATION' }, env.deps, { eventKey: 'e1' });
      await flush();
      expect(mails(env)).toHaveLength(1);
      await sr.markNeedsAttention(WS, { code: 'ACCOUNT_VIOLATION' }, env.deps, { eventKey: 'e2' });
      await flush();
      expect(mails(env).map((m) => [m.kind, m.params.code])).toEqual([['account_alert', 'ACCOUNT_VIOLATION'], ['account_alert', 'ACCOUNT_VIOLATION']]);
    });
    test('a failing e-mail never blocks the state change and is retried at most 3 times in all', async () => {
      const env = makeEnv();
      env.emailSend.mockRejectedValue(Object.assign(new Error('provider down'), { code: 'RESEND_DOWN' }));
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
      env.g.setVerification('verified');
      const snap = await sr.refreshConnection(WS, env.deps);
      await flush();
      expect(snap.verification.mapped).toBe('done'); // the state change happened
      expect(env.row().verification.mapped).toBe('done');
      expect(env.notes()).toHaveLength(1); // the in-app notification exists
      expect(env.notes()[0]).toMatchObject({ emailError: 'RESEND_DOWN', emailAttempts: 1 });
      expect((await env.notifications.retryEmails({})).attempted).toBe(1);
      expect((await env.notifications.retryEmails({})).attempted).toBe(1);
      expect(await env.notifications.retryEmails({})).toEqual({ attempted: 0, sent: 0 }); // capped at 3 attempts
      expect(env.emailSend).toHaveBeenCalledTimes(3);
      jest.restoreAllMocks();
    });
  });
  test('verification going to needs_you is a warning that links to the approvals', async () => {
    const env = makeEnv();
    env.g.setVerification('rejected');
    env.seedConn();
    await sr.refreshConnection(WS, env.deps);
    expect(env.notes()[0]).toMatchObject({ kind: 'verification_changed', severity: 'warning', actionPath: '/setup/approvals' });
  });
  test('the same transition detected twice on the SAME version of the document (two racers, a re-delivery) is one notification', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' }, lastStatusCheckAt: new Date(env.clock.ms() - 5 * MIN) });
    const stale = JSON.parse(JSON.stringify(env.row()), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v)); // what both racers read
    const set = { 'verification.mapped': 'done', 'verification.businessRaw': 'verified' };
    await sr.commitPatch(stale, set, {}, env.deps);
    await sr.commitPatch(stale, set, {}, env.deps);
    expect(env.notes().filter((n) => n.kind === 'verification_changed')).toHaveLength(1);
  });
  test('a recurring condition is a NEW notification: verification needs_you -> done twice, with a write in between, notifies twice (R7-04)', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    const steps = [['rejected', 'needs_you'], ['verified', 'done'], ['rejected', 'needs_you'], ['verified', 'done']];
    for (const [raw] of steps) { env.clock.advance(MIN); env.g.setVerification(raw); await sr.refreshConnection(WS, env.deps); }
    const v = env.notes().filter((n) => n.kind === 'verification_changed');
    expect(v.map((n) => n.params.status)).toEqual(['needs_you', 'done', 'needs_you', 'done']);
    expect(new Set(v.map((n) => n.dedupeKey)).size).toBe(4);
  });
  test('one-time facts keep their plain keys: reconnect keys carry the connectedAt stamp, templates and milestones are not touched', async () => {
    const env = makeEnv();
    env.seedConn();
    await sr.markNeedsReconnect(WS, 'TOKEN_REVOKED', env.deps);
    expect(env.notes().map((n) => n.dedupeKey)).toEqual([expect.stringMatching(/^reconnect:TOKEN_REVOKED:\d+$/)]);
  });
});

describe('what is (not) refreshed', () => {
  test('connecting: no Graph call, the check is rescheduled 15 min out', async () => {
    const env = makeEnv();
    env.seedConn({ status: 'connecting' });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('connecting');
    expect(env.g.calls).toHaveLength(0);
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
  });
  test('needsReconnect: no Graph call and the due row is pushed 6 h out (never a hot loop)', async () => {
    const env = makeEnv();
    env.seedConn({ needsReconnect: true });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('needs_reconnect');
    expect(env.g.calls).toHaveLength(0);
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(6 * HOUR);
  });
  test.each(['disconnected', 'not_connected', 'reconnect_required', 'error'])('status %s is not polled', async (status) => {
    const env = makeEnv();
    env.seedConn({ status });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('not_pollable');
    expect(env.g.calls).toHaveLength(0);
  });
  test('waba_only: the WABA is read, there is no phone to read, the status stays waba_only and is polled fast', async () => {
    const env = makeEnv();
    env.g.scenarios.finishOnlyWaba();
    env.seedConn({ status: 'waba_only', ids: { wabaId: env.g.ids.wabaId } });
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.row().status).toBe('waba_only');
    expect(env.g.callsTo('getPhone')).toHaveLength(0);
    expect(env.g.callsTo('getWaba')).toHaveLength(1);
    expect(snap.level).toBe('needs_attention');
    expect(snap.cause.code).toBe('NUMBER_PENDING');
    expect(new Date(env.row().nextCheckAt).getTime() - env.clock.ms()).toBe(15 * MIN);
  });
  test('waba_only: after reading the WABA, connect.resumeConnect looks for the number added meanwhile; the snapshot is the re-read row', async () => {
    const env = makeEnv();
    env.g.scenarios.finishOnlyWaba();
    env.seedConn({ status: 'waba_only', ids: { wabaId: env.g.ids.wabaId }, connectedByUserId: 'u7' });
    env.deps.connect = {
      reportGraphError: jest.fn(),
      resumeConnect: jest.fn(async () => { env.row().status = 'connected'; env.row().ids.phoneNumberId = 'NEWPHONE'; return { status: 'connected' }; }),
    };
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(env.deps.connect.resumeConnect).toHaveBeenCalledWith({ workspaceId: WS, userId: 'u7', system: true });
    expect(snap.status).toBe('connected');
    expect(snap.level).toBe('connected');
  });
  test('waba_only: a resume that throws is logged and does not fail the refresh; nothing is resumed when Graph could not be read or when switched off', async () => {
    const env = makeEnv();
    env.g.scenarios.finishOnlyWaba();
    env.seedConn({ status: 'waba_only', ids: { wabaId: env.g.ids.wabaId } });
    env.deps.connect = { resumeConnect: jest.fn(async () => { throw Object.assign(new Error('partial'), { code: 'CONNECT_PARTIAL' }); }) };
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.status).toBe('waba_only');
    expect(env.log).toHaveBeenCalledWith('resume of a waba_only connection:', 'CONNECT_PARTIAL');
    const down = makeEnv();
    down.g.scenarios.networkDrop({ code: 'ETIMEDOUT', times: Infinity });
    down.seedConn({ status: 'waba_only', ids: { wabaId: down.g.ids.wabaId } });
    down.deps.connect = { resumeConnect: jest.fn() };
    await sr.refreshConnection(WS, down.deps);
    expect(down.deps.connect.resumeConnect).not.toHaveBeenCalled();
    const off = makeEnv();
    off.g.scenarios.finishOnlyWaba();
    off.seedConn({ status: 'waba_only', ids: { wabaId: off.g.ids.wabaId } });
    off.deps.connect = { resumeConnect: jest.fn() };
    await sr.refreshConnection(WS, { ...off.deps, resumeWabaOnly: false });
    expect(off.deps.connect.resumeConnect).not.toHaveBeenCalled();
  });
  test('only waba_only rows are resumed by a refresh (connected ones never are)', async () => {
    const env = makeEnv();
    env.seedConn();
    env.deps.connect = { resumeConnect: jest.fn() };
    await sr.refreshConnection(WS, env.deps);
    expect(env.deps.connect.resumeConnect).not.toHaveBeenCalled();
  });
  test('no connection row -> a not_connected snapshot, no throw', async () => {
    const env = makeEnv();
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap).toMatchObject({ level: 'not_connected', skipped: 'no_connection' });
  });
  test('accepts a connection document as well as a workspace id', async () => {
    const env = makeEnv();
    const doc = env.seedConn();
    const snap = await sr.refreshConnection(doc, env.deps);
    expect(snap.level).toBe('connected');
  });
  test('an unreadable token (wrong key) is OUR problem: no Graph call, back-off, never needsReconnect', async () => {
    const env = makeEnv();
    env.seedConn();
    env.deps.vault = { decrypt: () => { throw Object.assign(new Error('x'), { code: 'DECRYPTION_FAILED' }); } };
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('token_unreadable');
    expect(env.g.calls).toHaveLength(0);
    expect(env.row()).toMatchObject({ needsReconnect: false, checkFailures: 1 });
    expect(env.row().lastError.code).toBe('DECRYPTION_FAILED');
  });
});

describe('pure helpers', () => {
  const t = Date.parse('2026-10-15T09:00:00Z');
  test('connectionLevel matrix', () => {
    const lvl = (c) => sr.connectionLevel(c, t);
    expect(lvl(null)).toBe('not_connected');
    expect(lvl({ status: 'not_connected' })).toBe('not_connected');
    expect(lvl({ status: 'connecting' })).toBe('not_connected');
    expect(lvl({ status: 'disconnected' })).toBe('not_connected');
    expect(lvl({ status: 'connected' })).toBe('connected');
    expect(lvl({ status: 'connected', needsReconnect: true })).toBe('reconnect_needed');
    expect(lvl({ status: 'reconnect_required' })).toBe('reconnect_needed');
    expect(lvl({ status: 'needs_attention' })).toBe('needs_attention');
    expect(lvl({ status: 'waba_only' })).toBe('needs_attention');
    expect(lvl({ status: 'error' })).toBe('needs_attention');
    expect(lvl({ status: 'connected', registration: { lastErrorCode: 'CONNECT_REGISTER_RATE_LIMITED' } })).toBe('needs_attention');
    expect(lvl({ status: 'connected', registration: { lastErrorCode: 'X', registeredAt: new Date(t) } })).toBe('connected');
    expect(lvl({ status: 'connected', health: { issues: [{ code: 'ACCOUNT_VIOLATION' }] } })).toBe('needs_attention');
    expect(lvl({ status: 'connected', tokenExpiresAt: new Date(t + 6 * DAY) })).toBe('needs_attention');
    expect(lvl({ status: 'connected', tokenExpiresAt: new Date(t + 8 * DAY) })).toBe('connected');
  });
  test('snapshot has no secret field and a stable shape, also for a missing document', () => {
    const empty = sr.snapshot(null, t);
    const full = sr.snapshot({ status: 'connected', tokenEncrypted: 'v1:x', pinEncrypted: 'v1:y', display: { displayPhoneNumber: '+966551234567', last4: '4567' }, ids: { wabaId: 'W' } }, t);
    expect(Object.keys(full).sort()).toEqual(Object.keys(empty).sort());
    expect(JSON.stringify(full)).not.toMatch(/v1:|966551234567|tokenEncrypted|pinEncrypted/);
    expect(full.numberMasked).toBe('********4567');
  });
  test('templateAggregate: all starter English approved -> done; pending -> waiting; rejected -> needs_you; none -> queued', () => {
    const row = (over) => ({ language: 'en', source: 'library', metaStatus: 'APPROVED', ...over });
    expect(sr.templateAggregate([row(), row()])).toMatchObject({ status: 'done', approved: 2, total: 2, reasonKey: null });
    expect(sr.templateAggregate([row(), row({ metaStatus: 'PENDING' })])).toMatchObject({ status: 'waiting', approved: 1, waiting: 1 });
    expect(sr.templateAggregate([row(), row({ metaStatus: 'REJECTED', rejectedReason: 'INVALID_FORMAT' })])).toMatchObject({ status: 'needs_you', problem: 1, rejectedReason: 'INVALID_FORMAT', reasonKey: 'onboarding.approvals.templates.rejected' });
    expect(sr.templateAggregate([])).toMatchObject({ status: 'waiting', total: 0, reasonKey: 'onboarding.approvals.templates.queued' });
    expect(sr.templateAggregate([row({ metaStatus: null, metaStatusRaw: undefined })])).toMatchObject({ status: 'waiting', reasonKey: 'onboarding.approvals.templates.queued' });
    // Arabic, test template and blocked-Arabic rows do not decide the row
    expect(sr.templateAggregate([row(), row({ language: 'ar', metaStatus: 'PENDING' }), row({ source: 'setup_test', metaStatus: 'PENDING', key: 'setup_test' })])).toMatchObject({ status: 'done', total: 1 });
    expect(sr.templateAggregate([row({ metaStatus: null, blockedReason: 'invalid' })])).toMatchObject({ status: 'needs_you' });
    expect(sr.templateAggregate([row({ metaStatus: 'PAUSED' })]).status).toBe('needs_you');
    expect(sr.templateAggregate([row({ metaStatus: 'IN_APPEAL' })]).status).toBe('waiting');
  });
  test('templateAggregate: every reasonKey is an EXISTING catalogue key (the blocked reasons invalid / limit map to the nearest neutral one, never to a key built from the reason name)', () => {
    // onboarding.approvals.templates.* in the frontend catalogue (src/app/i18n/catalogs/en/onboarding.json): the catalogue is not ours to extend
    const CATALOGUE = ['onboarding.approvals.templates.summary', 'onboarding.approvals.templates.rejected', 'onboarding.approvals.templates.queued', 'onboarding.approvals.templates.arBlocked', 'onboarding.approvals.templates.submit', 'onboarding.approvals.templates.show', 'onboarding.approvals.templates.hide'];
    const row = (over) => ({ language: 'en', source: 'library', metaStatus: 'APPROVED', ...over });
    const inputs = [
      [], [row()], [row({ metaStatus: 'PENDING' })], [row({ metaStatus: null, metaStatusRaw: undefined })], [row({ metaStatus: 'REJECTED' })], [row({ metaStatus: 'PAUSED' })], [row({ metaStatus: 'DISABLED' })],
      [row({ metaStatus: null, blockedReason: 'invalid' })], [row({ metaStatus: null, blockedReason: 'limit' })], [row({ blockedReason: 'invalid' }), row({ metaStatus: 'REJECTED' })],
      [row({ metaStatus: null, blockedReason: 'arabic_not_reviewed', language: 'ar' })], [row({ metaStatus: null, blockedReason: 'legal' })], [row({ metaStatus: null, blockedReason: '__proto__' })], undefined, null,
    ];
    for (const rows of inputs) {
      const { reasonKey } = sr.templateAggregate(rows);
      expect([JSON.stringify(rows), reasonKey === null || CATALOGUE.includes(reasonKey)]).toEqual([JSON.stringify(rows), true]);
    }
    expect(sr.templateAggregate([row({ metaStatus: null, blockedReason: 'invalid' })])).toMatchObject({ status: 'needs_you', problem: 1, reasonKey: 'onboarding.approvals.templates.rejected' });
    expect(sr.templateAggregate([row({ metaStatus: null, blockedReason: 'limit' })])).toMatchObject({ status: 'needs_you', problem: 1, reasonKey: 'onboarding.approvals.templates.rejected' });
    expect(JSON.stringify(sr.templateAggregate([row({ metaStatus: null, blockedReason: 'invalid' })]))).not.toMatch(/templates\.(invalid|limit)/);
  });
  test('kindOf: the client kind wins, metaErrors is the second source, a local table is the fallback', () => {
    expect(sr.kindOf({ kind: 'permission', code: 190 })).toBe('permission');
    expect(sr.kindOf({ code: 190 })).toBe('reconnect');
    expect(sr.kindOf({ code: 102 })).toBe('reconnect');
    expect(sr.kindOf({ code: 200 })).toBe('permission');
    expect(sr.kindOf({ code: 613 })).toBe('retry');
    expect(sr.kindOf({ code: 'ETIMEDOUT' })).toBe('network');
    expect(sr.kindOf({ code: 1234 })).toBe('unknown');
    expect(sr.kindOf({ code: 190 }, { metaErrors: { classify: () => ({ kind: 'custom' }) } })).toBe('custom');
  });
  test('toOnbError maps kinds to catalogue codes and never leaks the Graph text', () => {
    const e = sr.toOnbError({ code: 190, message: 'EAAFtoken_should_never_appear_0123456789012345678901234567890' });
    expect(e.code).toBe('META_TOKEN_REVOKED');
    expect(e.message).not.toMatch(/EAAF/);
    expect(sr.toOnbError({ code: 'ETIMEDOUT' }).code).toBe('META_UNREACHABLE');
    expect(sr.toOnbError({ code: 4 }).code).toBe('META_RATE_LIMITED');
    expect(sr.toOnbError({ code: 200 }).code).toBe('META_PERMISSION_MISSING');
    expect(sr.toOnbError({ code: 77 }).code).toBe('META_ERROR');
  });
  test('computeDisplayName returns null when nothing is readable', () => {
    expect(sr.computeDisplayName({}, {}, new Date(t))).toBeNull();
  });
});

describe('secrets never leak', () => {
  test('a refresh with a revoked token neither logs nor stores the token, and only the merchant token reaches Graph', async () => {
    const env = makeEnv();
    env.g.scenarios.token190();
    env.seedConn();
    const spies = ['log', 'info', 'warn', 'error'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    try {
      await sr.refreshConnection(WS, env.deps);
      await flush();
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).concat(env.log.mock.calls.map((c) => c.map(String).join(' ')));
      env.g.assertNoLeak([env.g.ids.merchantToken], logged);
      env.g.assertNeverUsedToken(env.g.ids.platformToken);
      env.g.assertMerchantTokenOnly(env.g.ids.merchantToken);
      expect(JSON.stringify(env.notes())).not.toContain(env.g.ids.merchantToken);
      expect(JSON.stringify(env.events())).not.toContain(env.g.ids.merchantToken);
      expect(JSON.stringify(env.row()).includes(env.g.ids.merchantToken)).toBe(false);
    } finally { spies.forEach((s) => s.mockRestore()); }
  });
});
