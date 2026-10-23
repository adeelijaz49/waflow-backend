'use strict';
// Reviews R7-07 (a refresh must not resurrect a disconnect), R7-04 (epoch of recurring conditions) and R7-01 (never a write to the platform
// account) on shared/onboarding/statusRefresh.js and approvals.js.
const sr = require('../../../shared/onboarding/statusRefresh');
const approvals = require('../../../shared/onboarding/approvals');
const { makeEnv, flush, WS } = require('./_b1dHelpers');

const MIN = 60 * 1000;

/** Run `fn` while Graph is answering (during the first call named `name`): the interceptor falls through to the default answer. */
function duringGraph(env, name, fn) {
  env.g.on(name, () => { fn(); return undefined; }, { times: 1 });
}
const disconnectNow = (env) => {
  const r = env.row();
  r.status = 'disconnected';
  r.disconnectedAt = new Date(env.clock.ms());
  r.tokenIsValid = false;
  r.needsReconnect = false;
  r.webhook = { subscribed: false };
  r.nextCheckAt = null;
  delete r.tokenEncrypted;
};

describe('R7-07: the refresh write is conditional on what was read', () => {
  test('a disconnect while Graph answers is NOT overwritten: status, token flags, webhook flag and nextCheckAt stay as the disconnect left them', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    duringGraph(env, 'getWaba', () => disconnectNow(env));
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('changed_meanwhile');
    const r = env.row();
    expect(r.status).toBe('disconnected');
    expect(r.tokenIsValid).toBe(false);
    expect(r.webhook.subscribed).toBe(false);
    expect(r.nextCheckAt).toBeNull();
    expect(r.tokenEncrypted).toBeUndefined();
    expect(r.verification.mapped).toBe('waiting'); // none of the derived values was written
    expect(r.lastStatusCheckAt).toBeUndefined();
    await flush();
    expect(env.notes()).toHaveLength(0); // no "verification changed" notice for a connection that is gone
    expect(env.events()).toHaveLength(0);
    expect(snap.level).toBe('not_connected');
  });
  test('the same when the owner disconnected and RECONNECTED meanwhile (status connected again, but disconnectedAt and the token stamp differ)', async () => {
    const env = makeEnv();
    env.seedConn();
    duringGraph(env, 'getWaba', () => {
      const r = env.row();
      r.disconnectedAt = new Date(env.clock.ms() - 1000);
      r.tokenCheckedAt = new Date(env.clock.ms() - 500);
      r.messagingLimit = { raw: 'TIER_10K', tierNumber: 10000 };
    });
    env.g.setTier('TIER_2K');
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBe('changed_meanwhile');
    expect(env.row().messagingLimit.raw).toBe('TIER_10K'); // the newer connection's value survives
  });
  test('two overlapping refreshes: only the first writes (and notifies); the second is dropped instead of writing a second, stale result', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    const [a, b] = await Promise.all([sr.refreshConnection(WS, env.deps), sr.refreshConnection(WS, env.deps)]);
    const skipped = [a, b].filter((x) => x.skipped === 'changed_meanwhile');
    expect(skipped).toHaveLength(1);
    await flush();
    expect(env.notes().filter((n) => n.kind === 'verification_changed')).toHaveLength(1);
    expect(env.emailSend).toHaveBeenCalledTimes(1);
    expect(env.row().verification.mapped).toBe('done');
  });
  test('a token revoked while the owner disconnected does not turn the row into "reconnect needed"', async () => {
    const env = makeEnv();
    env.seedConn();
    // the disconnect lands while the (failing) Graph calls are in flight: the hook is registered BEFORE the scenario so it runs first
    duringGraph(env, 'debugToken', () => disconnectNow(env));
    env.g.scenarios.token190();
    await sr.refreshConnection(WS, env.deps);
    expect(env.row().status).toBe('disconnected');
    expect(env.row().needsReconnect).toBe(false);
    await flush();
    expect(env.notes().filter((n) => n.kind === 'reconnect_needed')).toHaveLength(0);
  });
  test('markNeedsReconnect and markNeedsAttention never resurrect a disconnected row, even with a stale snapshot', async () => {
    const env = makeEnv();
    env.seedConn();
    const stale = JSON.parse(JSON.stringify(env.row()));
    disconnectNow(env);
    expect(await sr.markNeedsReconnect(WS, 'TOKEN_REVOKED', env.deps, { conn: { ...stale, _id: env.row()._id } })).toMatchObject({ changed: false });
    expect(await sr.markNeedsAttention(WS, { code: 'ACCOUNT_VIOLATION' }, env.deps, { conn: { ...stale, _id: env.row()._id } })).toEqual({ changed: false });
    expect(env.row().status).toBe('disconnected');
    expect(env.row().needsReconnect).toBe(false);
    expect(env.row().health.issues).toEqual([]);
    await flush();
    expect(env.notes()).toHaveLength(0);
  });
  test('the normal path is unchanged: the write goes through, the snapshot has no skipped marker', async () => {
    const env = makeEnv();
    env.seedConn({ verification: { businessRaw: 'pending', mapped: 'waiting' } });
    env.g.setVerification('verified');
    const snap = await sr.refreshConnection(WS, env.deps);
    expect(snap.skipped).toBeUndefined();
    expect(env.row().verification.mapped).toBe('done');
    expect(env.row().lastStatusCheckAt).toBeInstanceOf(Date);
  });
  test('the guard is exactly status + disconnectedAt + tokenCheckedAt of what was read', async () => {
    const env = makeEnv();
    env.seedConn({ tokenCheckedAt: new Date('2026-10-14T00:00:00Z') });
    await sr.refreshConnection(WS, env.deps);
    const call = env.Connection.calls.filter((c) => c[0] === 'updateOne').find((c) => c[2] && c[2].$set && c[2].$set.lastStatusCheckAt);
    expect(call[1]).toMatchObject({ status: 'connected', disconnectedAt: null, tokenCheckedAt: new Date('2026-10-14T00:00:00Z') });
    expect(Object.keys(call[1]).sort()).toEqual(['_id', 'disconnectedAt', 'status', 'tokenCheckedAt']);
  });
});

describe('R7-04: the epoch of a recurring condition', () => {
  test('epochOf: the document version stamp (updatedAt), else the last check, else connectedAt, else 0', () => {
    expect(sr.epochOf({ updatedAt: new Date(5000), lastStatusCheckAt: new Date(4000), connectedAt: new Date(3000) })).toBe(5000);
    expect(sr.epochOf({ lastStatusCheckAt: new Date(4000), connectedAt: new Date(3000) })).toBe(4000);
    expect(sr.epochOf({ connectedAt: new Date(3000) })).toBe(3000);
    expect(sr.epochOf({})).toBe(0);
    expect(sr.epochOf(null)).toBe(0);
    expect(sr.epochOf({ updatedAt: 'not a date' })).toBe(0);
  });
  test('displayNameKey: the plain key without an epoch (as before), the epoch appended with one', () => {
    expect(sr.displayNameKey('done', 'Acme')).toMatch(/^displayname:done:[0-9a-f]{8}$/);
    expect(sr.displayNameKey('done', 'Acme', 77)).toMatch(/^displayname:done:[0-9a-f]{8}:77$/);
  });
  test('transitions carry the epoch of the BEFORE document on every recurring key (verification, display name, limit)', () => {
    const prev = { updatedAt: new Date(4242), verification: { mapped: 'waiting' }, displayName: { mapped: 'waiting', newName: 'Acme' }, messagingLimit: { raw: 'TIER_250' } };
    const next = { verification: { mapped: 'done' }, displayName: { mapped: 'done', newName: 'Acme' }, messagingLimit: { raw: 'TIER_2K' } };
    const keys = sr.transitions(prev, next).filter((t) => t.notify).map((t) => t.notify.dedupeKey);
    expect(keys).toEqual(['verification:done:4242', expect.stringMatching(/^displayname:done:[0-9a-f]{8}:4242$/), 'limit:TIER_2K:4242']);
  });
  test('the same limit change twice (down and up again) notifies twice; one detection replayed on the same version notifies once', async () => {
    const env = makeEnv();
    env.seedConn({ messagingLimit: { raw: 'TIER_250', tierNumber: 250 } });
    for (const tier of ['TIER_2K', 'TIER_250', 'TIER_2K']) {
      env.clock.advance(MIN);
      env.g.setTier(tier);
      await sr.refreshConnection(WS, env.deps);
    }
    const limits = env.notes().filter((n) => n.kind === 'messaging_limit_changed');
    expect(limits.map((n) => n.params.limit)).toEqual(['TIER_2K', 'TIER_250', 'TIER_2K']);
    expect(new Set(limits.map((n) => n.dedupeKey)).size).toBe(3);
  });
  test('webhook-driven transitions also separate recurrences (commitPatch writes bump the version between them)', async () => {
    const env = makeEnv();
    env.seedConn({ health: { canSend: 'AVAILABLE', issues: [] }, updatedAt: new Date(env.clock.ms() - 10 * MIN) });
    const flip = async (canSend, stamp) => {
      const conn = env.row();
      conn.updatedAt = new Date(stamp);
      await sr.commitPatch({ ...JSON.parse(JSON.stringify(conn), (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) ? new Date(v) : v)), _id: conn._id }, { 'health.canSend': canSend }, {}, env.deps);
    };
    await flip('LIMITED', env.clock.ms() - 5 * MIN);
    await flip('AVAILABLE', env.clock.ms() - 4 * MIN);
    await flip('LIMITED', env.clock.ms() - 3 * MIN);
    const alerts = env.notes().filter((n) => n.kind === 'account_alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.every((n) => /^level:needs_attention:HEALTH_LIMITED:\d+$/.test(n.dedupeKey))).toBe(true);
    expect(new Set(alerts.map((n) => n.dedupeKey)).size).toBe(2);
  });
});

describe('R7-01: the platform account is never written to', () => {
  let saved;
  beforeEach(() => { saved = { w: process.env.WA_WABA_ID, p: process.env.WA_PHONE_ID }; });
  afterEach(() => {
    if (saved.w === undefined) delete process.env.WA_WABA_ID; else process.env.WA_WABA_ID = saved.w;
    if (saved.p === undefined) delete process.env.WA_PHONE_ID; else process.env.WA_PHONE_ID = saved.p;
  });

  test('refresh: a lost webhook subscription is NOT re-subscribed when the WABA is the platform\'s (no subscribe call) and the flag stays false', async () => {
    const env = makeEnv();
    env.seedConn({ webhook: { subscribed: true } });
    process.env.WA_WABA_ID = env.g.ids.wabaId;
    env.g.setSubscribed(false);
    await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('subscribe')).toHaveLength(0);
    expect(env.g.callsTo('listSubscribed').length).toBeGreaterThan(0); // reading is fine
    expect(env.row().webhook.subscribed).toBe(false);
  });
  test('the same lost subscription of an ordinary merchant IS healed (unchanged behaviour)', async () => {
    const env = makeEnv();
    env.seedConn({ webhook: { subscribed: true } });
    process.env.WA_WABA_ID = '990000000000002';
    env.g.setSubscribed(false);
    await sr.refreshConnection(WS, env.deps);
    expect(env.g.callsTo('subscribe')).toHaveLength(1);
    expect(env.row().webhook.subscribed).toBe(true);
  });
  test('changeDisplayName: refused with WHATSAPP_NOT_CONNECTED for a platform WABA or phone id, no Graph call, nothing stored', async () => {
    for (const which of ['w', 'p']) {
      const env = makeEnv();
      env.seedConn();
      if (which === 'w') process.env.WA_WABA_ID = env.g.ids.wabaId; else process.env.WA_PHONE_ID = env.g.ids.phoneId;
      await expect(approvals.changeDisplayName({ workspaceId: WS, userId: 'u1', newName: 'Acme Cafe' }, env.deps)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
      expect(env.g.callsTo('setDisplayName')).toHaveLength(0);
      expect(env.row().displayName.newName).toBeUndefined();
      delete process.env.WA_WABA_ID;
      delete process.env.WA_PHONE_ID;
    }
  });
  test('reRegisterDueNames: a platform row is dropped from the sweep without a register call', async () => {
    const env = makeEnv();
    env.seedConn({ displayName: { mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe', nameStatusRaw: 'APPROVED', checkedAt: new Date(env.clock.ms() - 60 * MIN) } });
    process.env.WA_PHONE_ID = env.g.ids.phoneId;
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res).toMatchObject({ checked: 1, registered: 0, expired: 1 });
    expect(env.g.callsTo('register')).toHaveLength(0);
    expect(env.row().displayName.newName).toBeUndefined();
  });
});
