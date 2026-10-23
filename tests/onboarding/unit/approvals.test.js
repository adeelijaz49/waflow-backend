'use strict';
const express = require('express');
const request = require('supertest');
const approvals = require('../../../shared/onboarding/approvals');
const metaConfig = require('../../../shared/onboarding/metaConfig');
const { OnbError } = require('../../../shared/onboarding/errors');
const { makeEnv, WS, PIN } = require('./_b1dHelpers');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const BIDI = String.fromCharCode(0x202e);

const rowOf = (res, key) => res.rows.find((r) => r.key === key);

async function codeOf(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected a rejection');
}

describe('buildApprovals: five rows, all blocking:false', () => {
  test('connected, everything done: five rows in the documented order, links on every row, overall done', async () => {
    const env = makeEnv();
    env.seedConn({ payment: { status: 'merchant_confirmed', confirmedAt: new Date(env.clock.ms()) }, lastStatusCheckAt: new Date(env.clock.ms() - MIN) });
    for (const key of ['welcome_optin', 'comeback']) env.Template.seed({ workspaceId: WS, key, language: 'en', source: 'library', metaStatus: 'APPROVED' });
    const res = await approvals.buildApprovals(WS, env.deps);
    expect(res.rows.map((r) => r.key)).toEqual(['verification', 'displayName', 'payment', 'messagingLimit', 'templates']);
    expect(res.rows.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(res.overall).toBe('done');
    expect(res.level).toBe('connected');
    expect(res.checkedAt).toBe(new Date(env.clock.ms() - MIN).toISOString());
    for (const r of res.rows) {
      expect(r.blocking).toBe(false);
      expect(r.links).toEqual({
        securityCenter: metaConfig.META_SECURITY_CENTER_URL(), paymentHelp: metaConfig.META_PAYMENT_HELP_URL(),
        paymentSettings: metaConfig.META_PAYMENT_SETTINGS_URL(), whatsappManager: metaConfig.META_WHATSAPP_MANAGER_URL(),
      });
      for (const u of Object.values(r.links)) expect(u).toMatch(/^https:\/\//);
      expect(r.checkedAt).toBe(res.checkedAt);
    }
  });

  test('the mixed seeded case of the design: verification waiting, name declined, payment unknown, limit TIER_250, templates 5 approved / 2 pending / 1 rejected', async () => {
    const env = makeEnv();
    env.seedConn({
      verification: { businessRaw: 'pending', mapped: 'waiting' },
      displayName: { nameStatusRaw: 'DECLINED', mapped: 'needs_you', decision: 'REJECTED', rejectionReason: 'NAME_NOT_CONSISTENT', newName: 'Sara Cafe' },
      messagingLimit: { raw: 'TIER_250', tierNumber: 250 },
    });
    const statuses = ['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'APPROVED', 'PENDING', 'PENDING', 'REJECTED'];
    statuses.forEach((s, i) => env.Template.seed({ workspaceId: WS, key: `k${i}`, language: 'en', source: 'library', metaStatus: s, rejectedReason: s === 'REJECTED' ? 'INVALID_FORMAT' : undefined }));
    const res = await approvals.buildApprovals(WS, env.deps);
    expect(res.rows.map((r) => [r.key, r.status])).toEqual([
      ['verification', 'waiting'], ['displayName', 'needs_you'], ['payment', 'needs_you'], ['messagingLimit', 'done'], ['templates', 'needs_you'],
    ]);
    expect(rowOf(res, 'displayName')).toMatchObject({ value: 'Sara Cafe', rejectionKey: 'NAME_NOT_CONSISTENT', reasonKey: 'onboarding.approvals.name.reason.NAME_NOT_CONSISTENT', canEdit: true });
    expect(rowOf(res, 'messagingLimit')).toMatchObject({ tierNumber: 250, raw: 'TIER_250', value: 250, valueKey: 'onboarding.approvals.limit.value' });
    expect(rowOf(res, 'templates')).toMatchObject({ value: '5/8', counts: { approved: 5, total: 8, waiting: 2, problem: 1 }, rejectedReason: 'INVALID_FORMAT' });
    expect(res.overall).toBe('needs_you');
  });

  test('verification: every raw value yields one of the three statuses; unknown is shown as waiting ("we are checking")', async () => {
    for (const [raw, mapped] of [...Object.entries(metaConfig.VERIFICATION_MAP), ['zzz', 'unknown']]) {
      const env = makeEnv();
      env.seedConn({ verification: { businessRaw: raw, mapped: metaConfig.mapVerification(raw) } });
      const row = rowOf(await approvals.buildApprovals(WS, env.deps), 'verification');
      expect(row.status).toBe(mapped === 'unknown' ? 'waiting' : mapped);
      if (mapped === 'needs_you') expect(row.reasonKey).toBe('onboarding.approvals.verification.needs');
      if (mapped === 'unknown') expect(row.valueKey).toBe('onboarding.approvals.verification.unknown');
    }
  });

  test('display name: waiting shows the pending name and cannot be edited; the rejection key falls back to UNKNOWN', async () => {
    const env = makeEnv();
    env.seedConn({ displayName: { mapped: 'waiting', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', nameStatusRaw: 'APPROVED' } });
    let row = rowOf(await approvals.buildApprovals(WS, env.deps), 'displayName');
    expect(row).toMatchObject({ status: 'waiting', value: 'Acme Cafe', canEdit: false, rejectionKey: null, reasonKey: null, editsRemaining: 10 });
    const env2 = makeEnv();
    env2.seedConn({ displayName: { mapped: 'needs_you', decision: 'REJECTED', rejectionReason: 'SOMETHING_ELSE', newName: 'X Y Z' } });
    row = rowOf(await approvals.buildApprovals(WS, env2.deps), 'displayName');
    expect(row).toMatchObject({ rejectionKey: 'UNKNOWN', reasonKey: 'onboarding.approvals.name.needs', canEdit: true });
  });

  test('editsRemaining counts only the edits of the last 30 days; at 10 the row cannot be edited', async () => {
    const env = makeEnv();
    const recent = Array.from({ length: 10 }, (_, i) => new Date(env.clock.ms() - (i + 1) * DAY));
    env.seedConn({ displayName: { mapped: 'needs_you', decision: 'REJECTED', editsLast30d: recent } });
    let row = rowOf(await approvals.buildApprovals(WS, env.deps), 'displayName');
    expect(row).toMatchObject({ editsRemaining: 0, canEdit: false });
    const env2 = makeEnv();
    const mixed = [new Date(env2.clock.ms() - 40 * DAY), new Date(env2.clock.ms() - 31 * DAY), new Date(env2.clock.ms() - 2 * DAY)];
    env2.seedConn({ displayName: { mapped: 'needs_you', decision: 'REJECTED', editsLast30d: mixed } });
    row = rowOf(await approvals.buildApprovals(WS, env2.deps), 'displayName');
    expect(row.editsRemaining).toBe(9);
  });

  test('payment: unknown -> needs_you with the "cannot see" copy keys; merchant_confirmed and probe_positive -> done; never "verified"', async () => {
    for (const [status, expected] of [['unknown', 'needs_you'], ['merchant_confirmed', 'done'], ['probe_positive', 'done']]) {
      const env = makeEnv();
      env.seedConn({ payment: { status } });
      const row = rowOf(await approvals.buildApprovals(WS, env.deps), 'payment');
      expect(row.status).toBe(expected);
      expect(row.value).toBe(status);
      expect(JSON.stringify(row)).not.toMatch(/verified/i);
      expect(row.valueKey).toBe(expected === 'done' ? 'onboarding.approvals.payment.confirmed' : 'onboarding.approvals.payment.cantSee');
    }
  });

  test('messaging limit: unknown tier shows what Meta reported without a number; nothing read yet -> waiting', async () => {
    const env = makeEnv();
    env.seedConn({ messagingLimit: { raw: 'TIER_UNLIMITED', tierNumber: null } });
    let row = rowOf(await approvals.buildApprovals(WS, env.deps), 'messagingLimit');
    expect(row).toMatchObject({ status: 'done', tierNumber: null, raw: 'TIER_UNLIMITED', value: 'TIER_UNLIMITED', valueKey: 'onboarding.approvals.limit.unknown' });
    const env2 = makeEnv();
    env2.seedConn({ messagingLimit: undefined });
    row = rowOf(await approvals.buildApprovals(WS, env2.deps), 'messagingLimit');
    expect(row).toMatchObject({ status: 'waiting', tierNumber: null, raw: null });
  });

  test('templates: none yet -> waiting "queued"; pending -> waiting; the template rows are only read', async () => {
    const env = makeEnv();
    env.seedConn();
    let row = rowOf(await approvals.buildApprovals(WS, env.deps), 'templates');
    expect(row).toMatchObject({ status: 'waiting', reasonKey: 'onboarding.approvals.templates.queued', value: '0/0' });
    env.Template.seed({ workspaceId: WS, key: 'welcome_optin', language: 'en', source: 'library', metaStatus: 'PENDING', lastCheckedAt: new Date(env.clock.ms() - 5 * MIN) });
    row = rowOf(await approvals.buildApprovals(WS, env.deps), 'templates');
    expect(row).toMatchObject({ status: 'waiting', reasonKey: null, checkedAt: new Date(env.clock.ms() - 5 * MIN).toISOString() });
    expect(env.Template.calls.every((c) => c[0] === 'find')).toBe(true);
  });

  test('another workspace\'s rows never show up (workspace-scoped reads)', async () => {
    const env = makeEnv();
    env.seedConn();
    env.Template.seed({ workspaceId: '507f1f77bcf86cd799439055', key: 'welcome_optin', language: 'en', source: 'library', metaStatus: 'APPROVED' });
    const row = rowOf(await approvals.buildApprovals(WS, env.deps), 'templates');
    expect(row.counts.total).toBe(0);
  });

  test('no connection yet: five waiting/needs rows, level not_connected, no throw, no editing', async () => {
    const env = makeEnv();
    const res = await approvals.buildApprovals(WS, env.deps);
    expect(res.rows).toHaveLength(5);
    expect(res.level).toBe('not_connected');
    expect(res.checkedAt).toBeNull();
    expect(rowOf(res, 'displayName')).toMatchObject({ canEdit: false, editsRemaining: null });
  });

  test('the view never contains a token, a PIN or a full phone number', async () => {
    const env = makeEnv();
    env.seedConn();
    const text = JSON.stringify(await approvals.buildApprovals(WS, env.deps));
    expect(text).not.toContain(env.g.ids.merchantToken);
    expect(text).not.toMatch(/v1:/);
    expect(text).not.toContain('966 55 123');
  });
});

describe('confirmPayment (self-attestation, D11)', () => {
  test('sets merchant_confirmed once, idempotently, and tracks one event', async () => {
    const env = makeEnv();
    env.seedConn();
    const first = await approvals.confirmPayment(WS, env.deps);
    expect(first).toMatchObject({ ok: true, alreadyConfirmed: false, payment: { status: 'merchant_confirmed' } });
    expect(env.row().payment.status).toBe('merchant_confirmed');
    expect(new Date(env.row().payment.confirmedAt).getTime()).toBe(env.clock.ms());
    env.clock.advance(DAY);
    const second = await approvals.confirmPayment(WS, env.deps);
    expect(second).toMatchObject({ alreadyConfirmed: true, payment: { status: 'merchant_confirmed' } });
    expect(new Date(env.row().payment.confirmedAt).getTime()).toBe(env.clock.ms() - DAY);
    expect(env.events().filter((e) => e.code === 'PAYMENT_CONFIRMED')).toHaveLength(1);
    expect(JSON.stringify(first)).not.toMatch(/verified/i);
  });
  test('never downgrades or overwrites probe_positive', async () => {
    const env = makeEnv();
    env.seedConn({ payment: { status: 'probe_positive' } });
    const res = await approvals.confirmPayment(WS, env.deps);
    expect(res.alreadyConfirmed).toBe(true);
    expect(env.row().payment.status).toBe('probe_positive');
  });
  test('makes no Graph call and needs a connection row', async () => {
    const env = makeEnv();
    const err = await codeOf(approvals.confirmPayment(WS, env.deps));
    expect(err).toBeInstanceOf(OnbError);
    expect(err.code).toBe('WHATSAPP_NOT_CONNECTED');
    env.seedConn({ status: 'disconnected' });
    expect((await codeOf(approvals.confirmPayment(WS, env.deps))).code).toBe('WHATSAPP_NOT_CONNECTED');
    expect(env.g.calls).toHaveLength(0);
  });
  test('another workspace\'s connection is untouched', async () => {
    const env = makeEnv();
    env.seedConn();
    env.seedConn({ workspaceId: '507f1f77bcf86cd799439012' });
    await approvals.confirmPayment(WS, env.deps);
    expect(env.Connection.rows[1].payment.status).toBe('unknown');
  });
});

describe('changeDisplayName', () => {
  const args = (newName, over = {}) => ({ workspaceId: WS, userId: 'u1', newName, ...over });

  test('calls Meta with the merchant token on the merchant phone, stores the pending request and the edit', async () => {
    const env = makeEnv();
    env.seedConn();
    const res = await approvals.changeDisplayName(args('  Acme   Cafe '), env.deps);
    expect(res).toEqual({ ok: true, displayName: { value: 'Acme Cafe', status: 'waiting', editsRemaining: 9 } });
    const call = env.g.callsTo('setDisplayName')[0];
    expect(call.id).toBe(env.g.ids.phoneId);
    expect(call.data).toEqual({ new_display_name: 'Acme Cafe' });
    env.g.assertMerchantTokenOnly(env.g.ids.merchantToken);
    env.g.assertNeverUsedToken(env.g.ids.platformToken);
    expect(env.row().displayName).toMatchObject({ requested: 'Acme Cafe', newName: 'Acme Cafe', newNameStatusRaw: 'PENDING_REVIEW', mapped: 'waiting' });
    expect(env.row().displayName.editsLast30d).toHaveLength(1);
    expect(env.row().displayName.decision).toBeUndefined();
    expect(new Date(env.row().nextCheckAt).getTime()).toBe(env.clock.ms());
    expect(env.events().some((e) => e.code === 'DISPLAY_NAME_REQUESTED')).toBe(true);
    env.g.assertNoLeak([env.g.ids.merchantToken], [JSON.stringify(res)]);
  });

  test('a resubmission after a rejection clears the rejection', async () => {
    const env = makeEnv();
    env.seedConn({ displayName: { mapped: 'needs_you', decision: 'REJECTED', rejectionReason: 'NAME_NOT_CONSISTENT', newName: 'Bad', nameStatusRaw: 'APPROVED' } });
    await approvals.changeDisplayName(args('Better Name'), env.deps);
    expect(env.row().displayName.decision).toBeUndefined();
    expect(env.row().displayName.rejectionReason).toBeUndefined();
    expect(env.row().displayName.mapped).toBe('waiting');
  });

  test('refuses at 10 changes in 30 days with no Graph call; old edits do not count', async () => {
    const env = makeEnv();
    const recent = Array.from({ length: 10 }, (_, i) => new Date(env.clock.ms() - (i + 1) * DAY));
    env.seedConn({ displayName: { editsLast30d: recent } });
    const err = await codeOf(approvals.changeDisplayName(args('Another Name'), env.deps));
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, details: { reason: 'DISPLAY_NAME_LIMIT', editsRemaining: 0 } });
    expect(env.g.calls).toHaveLength(0);
    const env2 = makeEnv();
    const old = Array.from({ length: 10 }, (_, i) => new Date(env2.clock.ms() - (31 + i) * DAY));
    env2.seedConn({ displayName: { editsLast30d: old } });
    const res = await approvals.changeDisplayName(args('Another Name'), env2.deps);
    expect(res.displayName.editsRemaining).toBe(9);
    expect(env2.row().displayName.editsLast30d).toHaveLength(1);
  });

  test('the tenth edit is accepted, the eleventh refused', async () => {
    const env = makeEnv();
    env.seedConn();
    for (let i = 0; i < 10; i += 1) {
      env.clock.advance(MIN);
      const res = await approvals.changeDisplayName(args(`Name number ${i}`), env.deps);
      expect(res.displayName.editsRemaining).toBe(9 - i);
    }
    expect((await codeOf(approvals.changeDisplayName(args('One too many'), env.deps))).details.reason).toBe('DISPLAY_NAME_LIMIT');
    expect(env.g.callsTo('setDisplayName')).toHaveLength(10);
  });

  test.each([[''], ['  '], ['ab'], ['x'.repeat(metaConfig.DISPLAY_NAME_MAX + 1)], [undefined], [null], [{}]])('invalid name %p -> 422 VALIDATION_FAILED, no Graph call', async (bad) => {
    const env = makeEnv();
    env.seedConn();
    const err = await codeOf(approvals.changeDisplayName(args(bad), env.deps));
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
    expect(env.g.calls).toHaveLength(0);
  });

  test('control characters and bidi marks are stripped before the call', async () => {
    const env = makeEnv();
    env.seedConn();
    await approvals.changeDisplayName(args('Acme' + BIDI + String.fromCharCode(7) + ' Cafe'), env.deps);
    expect(env.g.callsTo('setDisplayName')[0].data.new_display_name).toBe('Acme Cafe');
  });

  test('the same name as the approved one is refused without spending an edit', async () => {
    const env = makeEnv();
    env.seedConn();
    const err = await codeOf(approvals.changeDisplayName(args('acme coffee'), env.deps));
    expect(err).toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'SAME_NAME' } });
    expect(env.g.calls).toHaveLength(0);
  });

  test('not connected / needs reconnect / no phone / no token -> access codes, no Graph call', async () => {
    const env = makeEnv();
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps))).code).toBe('WHATSAPP_NOT_CONNECTED');
    env.seedConn({ needsReconnect: true });
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps))).code).toBe('WHATSAPP_RECONNECT_REQUIRED');
    const env2 = makeEnv();
    env2.seedConn({ status: 'reconnect_required' });
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env2.deps))).code).toBe('WHATSAPP_RECONNECT_REQUIRED');
    const env3 = makeEnv();
    env3.seedConn({ ids: { wabaId: 'W' } });
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env3.deps))).code).toBe('WHATSAPP_NOT_CONNECTED');
    expect(env.g.calls.length + env2.g.calls.length + env3.g.calls.length).toBe(0);
  });

  test('a revoked token (190) flags the connection for reconnect and answers META_TOKEN_REVOKED', async () => {
    const env = makeEnv();
    env.g.scenarios.token190();
    env.seedConn();
    const err = await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps));
    expect(err.code).toBe('META_TOKEN_REVOKED');
    expect(env.row()).toMatchObject({ needsReconnect: true });
    expect(env.row().displayName.newName).toBeUndefined();
  });

  test('other Graph failures map to catalogue codes and store nothing', async () => {
    const env = makeEnv();
    env.g.failNext('setDisplayName', { code: 100, message: 'Too many display name changes in the last 30 days.' });
    env.seedConn();
    const err = await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps));
    expect(err.code).toBe('META_ERROR');
    expect(err.message).not.toMatch(/Too many/);
    expect(env.row().displayName.editsLast30d).toBeUndefined();
    env.g.failNext('setDisplayName', { networkError: 'ETIMEDOUT' });
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps))).code).toBe('META_UNREACHABLE');
  });

  test('an unreadable token surfaces as ENCRYPTION_NOT_CONFIGURED / META_ERROR, never plaintext', async () => {
    const env = makeEnv();
    env.seedConn();
    env.deps.vault = { decrypt: () => { throw Object.assign(new Error('missing key'), { code: 'ENCRYPTION_NOT_CONFIGURED' }); } };
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps))).code).toBe('ENCRYPTION_NOT_CONFIGURED');
    env.deps.vault = { decrypt: () => { throw Object.assign(new Error('bad'), { code: 'DECRYPTION_FAILED' }); } };
    expect((await codeOf(approvals.changeDisplayName(args('Valid Name'), env.deps))).code).toBe('META_ERROR');
  });
});

describe('touchProgress: step 4 follows what the merchant has seen', () => {
  const mk = (status) => ({
    stateModule: { getState: jest.fn(async () => (status === null ? null : { steps: { approvals: { status } } })) },
    steps: { markStep: jest.fn(async () => ({})) },
    stateDeps: { s: 1 }, stepsDeps: { d: 1 },
  });
  test.each([
    ['todo', 'waiting', 'in_progress'], ['todo', 'needs_you', 'in_progress'], ['todo', 'done', 'done'],
    ['in_progress', 'done', 'done'], ['in_progress', 'waiting', null], ['in_progress', 'needs_you', null],
    ['done', 'done', null], ['done', 'waiting', null], ['skipped', 'done', null], ['skipped', 'waiting', null],
  ])('current %s, overall %s -> %s', async (current, overall, expected) => {
    const deps = mk(current);
    expect(await approvals.touchProgress(WS, overall, deps)).toBe(expected);
    if (expected) expect(deps.steps.markStep).toHaveBeenCalledWith(WS, 'approvals', expected, { d: 1 });
    else expect(deps.steps.markStep).not.toHaveBeenCalled();
    expect(deps.stateModule.getState).toHaveBeenCalledWith(WS, { s: 1 });
  });
  test('not enrolled -> nothing; any failure is swallowed (a read never fails because of it)', async () => {
    const none = mk(null);
    expect(await approvals.touchProgress(WS, 'done', none)).toBeNull();
    expect(none.steps.markStep).not.toHaveBeenCalled();
    const boom = mk('todo');
    boom.steps.markStep.mockRejectedValue(new Error('db'));
    await expect(approvals.touchProgress(WS, 'done', boom)).resolves.toBeNull();
    const stateBoom = { stateModule: { getState: async () => { throw new Error('db'); } }, steps: { markStep: jest.fn() } };
    await expect(approvals.touchProgress(WS, 'done', stateBoom)).resolves.toBeNull();
  });
});

describe('reRegisterDueNames (scheduler job 7)', () => {
  const approved = (env, over = {}) => env.seedConn({
    displayName: { mapped: 'done', decision: 'APPROVED', newName: 'Acme Cafe', nameStatusRaw: 'APPROVED', checkedAt: new Date(env.clock.ms() - 2 * DAY) },
    ...over,
  });

  test('registers with the STORED pin within 14 days and clears the marker', async () => {
    const env = makeEnv();
    approved(env);
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res).toMatchObject({ checked: 1, registered: 1, failed: 0, expired: 0 });
    const call = env.g.callsTo('register')[0];
    expect(call.id).toBe(env.g.ids.phoneId);
    expect(call.data).toEqual({ messaging_product: 'whatsapp', pin: PIN });
    env.g.assertMerchantTokenOnly(env.g.ids.merchantToken);
    expect(env.row().displayName.newName).toBeUndefined();
    expect(new Date(env.row().registration.registeredAt).getTime()).toBe(env.clock.ms());
    expect(env.events().some((e) => e.code === 'DISPLAY_NAME_REREGISTERED')).toBe(true);
    env.g.assertNoLeak([env.g.ids.merchantToken], [JSON.stringify(res), JSON.stringify(env.events())]);
    expect((await approvals.reRegisterDueNames({}, env.deps)).checked).toBe(0); // done: not scanned again
  });

  test('after 14 days the marker is dropped without a Graph call', async () => {
    const env = makeEnv();
    approved(env, { displayName: { decision: 'APPROVED', newName: 'Old', mapped: 'done', checkedAt: new Date(env.clock.ms() - 15 * DAY) } });
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res).toMatchObject({ checked: 1, expired: 1, registered: 0 });
    expect(env.g.calls).toHaveLength(0);
    expect(env.row().displayName.newName).toBeUndefined();
  });

  test('a failure counts an attempt, 133016 gives up at once, and the attempt cap stops retrying', async () => {
    const env = makeEnv();
    approved(env);
    env.g.failNext('register', { code: 100, message: 'bad' });
    expect(await approvals.reRegisterDueNames({}, env.deps)).toMatchObject({ failed: 1, registered: 0 });
    expect(env.row().registration.attempts).toBe(1);
    expect(env.row().displayName.newName).toBe('Acme Cafe'); // retried next tick
    env.g.scenarios.register133016();
    await approvals.reRegisterDueNames({}, env.deps);
    expect(env.row().registration.attempts).toBe(approvals.REREGISTER_MAX_ATTEMPTS);
    const calls = env.g.callsTo('register').length;
    const res = await approvals.reRegisterDueNames({}, env.deps);
    expect(res.expired).toBe(1);
    expect(env.g.callsTo('register')).toHaveLength(calls);
  });

  test('rows without a PIN, needing reconnect or not approved are left alone / dropped safely', async () => {
    const env = makeEnv();
    approved(env, { pinEncrypted: undefined });
    expect(await approvals.reRegisterDueNames({}, env.deps)).toMatchObject({ expired: 1 });
    const env2 = makeEnv();
    approved(env2, { needsReconnect: true });
    expect((await approvals.reRegisterDueNames({}, env2.deps)).checked).toBe(0);
    const env3 = makeEnv();
    env3.seedConn({ displayName: { decision: 'REJECTED', newName: 'X', mapped: 'needs_you' } });
    expect((await approvals.reRegisterDueNames({}, env3.deps)).checked).toBe(0);
    expect(env.g.calls.length + env2.g.calls.length + env3.g.calls.length).toBe(0);
  });

  test('a 190 while registering flags the connection', async () => {
    const env = makeEnv();
    approved(env);
    env.g.failNext('register', { code: 190, subcode: 458, message: 'revoked' });
    await approvals.reRegisterDueNames({}, env.deps);
    expect(env.row().needsReconnect).toBe(true);
  });
});

describe('routes/onboarding/approvals.js', () => {
  const routerMod = require('../../../routes/onboarding/approvals');
  let prevFlag;
  beforeEach(() => { prevFlag = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; });
  afterEach(() => { if (prevFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = prevFlag; });

  function makeApp(fake, extra = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = extra.user === undefined ? { id: 'u1', workspaceId: WS, role: 'owner' } : extra.user; next(); });
    const ownerGate = extra.ownerGate || ((req, res, next) => next());
    const memberGate = extra.memberGate || ((req, res, next) => next()); // the live membership gate has its own tests (requireOnboardingAccess)
    app.use(routerMod.createRouter({ approvals: fake, approvalsDeps: { marker: 1 }, ownerGate, memberGate }));
    return app;
  }
  const fakeMod = () => ({
    buildApprovals: jest.fn(async () => ({ rows: [], overall: 'waiting', checkedAt: null, level: 'connected' })),
    confirmPayment: jest.fn(async () => ({ ok: true, payment: { status: 'merchant_confirmed' }, alreadyConfirmed: false })),
    changeDisplayName: jest.fn(async () => ({ ok: true, displayName: { value: 'N', status: 'waiting', editsRemaining: 9 } })),
  });

  test('exports a router and createRouter', () => {
    expect(typeof routerMod).toBe('function');
    expect(typeof routerMod.createRouter).toBe('function');
  });
  test('GET /approvals uses the workspace of the token only', async () => {
    const fake = fakeMod();
    const res = await request(makeApp(fake)).get('/approvals?workspaceId=507f1f77bcf86cd799439099');
    expect(res.status).toBe(200);
    expect(res.body.overall).toBe('waiting');
    expect(fake.buildApprovals).toHaveBeenCalledWith(WS, { marker: 1 });
  });
  test('GET /approvals also moves step 4 along (touchProgress with the overall status); its failure never fails the read', async () => {
    const fake = fakeMod();
    fake.touchProgress = jest.fn(async () => 'in_progress');
    const res = await request(makeApp(fake)).get('/approvals');
    expect(res.status).toBe(200);
    expect(fake.touchProgress).toHaveBeenCalledWith(WS, 'waiting', undefined);
    fake.touchProgress.mockRejectedValueOnce(new Error('x'));
    expect((await request(makeApp(fake)).get('/approvals')).status).toBe(200);
  });
  test('POST /approvals/payment-confirmed needs {confirmed:true}; a body workspaceId is ignored', async () => {
    const fake = fakeMod();
    const app = makeApp(fake);
    for (const body of [{}, { confirmed: 'true' }, { confirmed: false }, undefined]) {
      const bad = await request(app).post('/approvals/payment-confirmed').send(body);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
    }
    expect(fake.confirmPayment).not.toHaveBeenCalled();
    const ok = await request(app).post('/approvals/payment-confirmed').send({ confirmed: true, workspaceId: '507f1f77bcf86cd799439099' });
    expect(ok.status).toBe(200);
    expect(fake.confirmPayment).toHaveBeenCalledWith(WS, { marker: 1 });
  });
  test('POST /display-name passes the trimmed owner request; empty -> 422; the owner gate runs first (403 for a member)', async () => {
    const fake = fakeMod();
    const res = await request(makeApp(fake)).post('/display-name').send({ newName: ' Acme Cafe ', workspaceId: 'x', userId: 'y' });
    expect(res.status).toBe(200);
    expect(fake.changeDisplayName).toHaveBeenCalledWith({ workspaceId: WS, userId: 'u1', newName: ' Acme Cafe ' }, { marker: 1 });
    expect((await request(makeApp(fake)).post('/display-name').send({ newName: '   ' })).status).toBe(422);
    expect((await request(makeApp(fake)).post('/display-name').send({})).status).toBe(422);
    expect((await request(makeApp(fake)).post('/display-name').send({ newName: 42 })).status).toBe(422);
    const denied = makeApp(fake, { ownerGate: (req, res) => res.status(403).json({ code: 'OWNER_ONLY' }) });
    const before = fake.changeDisplayName.mock.calls.length;
    const r2 = await request(denied).post('/display-name').send({ newName: 'Valid Name' });
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe('OWNER_ONLY');
    expect(fake.changeDisplayName.mock.calls.length).toBe(before);
    expect((await request(denied).get('/approvals')).status).toBe(200); // reading is not owner-only
  });
  test('OnbErrors from the module become JSON error bodies, never 401; unexpected errors become 500 INTERNAL_ERROR', async () => {
    const fake = fakeMod();
    fake.changeDisplayName.mockRejectedValueOnce(new OnbError('WHATSAPP_RECONNECT_REQUIRED'));
    const res = await request(makeApp(fake)).post('/display-name').send({ newName: 'Valid Name' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED', nextStep: 'connect' });
    fake.buildApprovals.mockRejectedValueOnce(new Error('boom with secret EAAFtoken'));
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r2 = await request(makeApp(fake)).get('/approvals');
    err.mockRestore();
    expect(r2.status).toBe(500);
    expect(r2.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(r2.body)).not.toContain('EAAF');
  });
  test('without a workspace in the token the answer is 404 ONBOARDING_NOT_AVAILABLE', async () => {
    const res = await request(makeApp(fakeMod(), { user: {} })).get('/approvals');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
  });
  test('flag off at request time: the router falls through (next("router"))', async () => {
    process.env.ONBOARDING_FLOW = 'off';
    const fake = fakeMod();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: 'u', workspaceId: WS }; next(); });
    app.use((req, res, next) => routerMod.createRouter({ approvals: fake })(req, res, next));
    const res = await request(app).get('/approvals');
    expect(res.status).toBe(404);
    expect(fake.buildApprovals).not.toHaveBeenCalled();
  });
  test('the display-name route is rate limited (5 per hour per workspace)', async () => {
    const fake = fakeMod();
    const rl = require('../../../shared/onboarding/rateLimit');
    rl.clear();
    const app = makeApp(fake);
    const codes = [];
    for (let i = 0; i < 6; i += 1) codes.push((await request(app).post('/display-name').send({ newName: 'Valid Name' })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    rl.clear();
  });
});
