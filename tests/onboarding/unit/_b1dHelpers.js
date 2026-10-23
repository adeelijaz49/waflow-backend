'use strict';
// Shared helpers of the B1-d suites (status refresh, approvals, webhook events, scheduler).
// Pure test support: an in-memory store (B0's createFakeModel), a thin "raw" Graph client over fakeGraph that
// follows the metaClient contract (INTERFACES 2.16: snake_case Graph JSON, errors with code/subcode) WITHOUT
// importing B1-c's real client, and a seeded connection. No network, no DB.
const { createFakeGraph, fixedClock } = require('../_fixtures');
const { createFakeModel } = require('./_b0Store');
const vault = require('../../../shared/onboarding/tokenVault');
const { createNotifications } = require('../../../shared/onboarding/notifications');
const metaConfig = require('../../../shared/onboarding/metaConfig');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439012';
const BASE = 'https://graph.facebook.com/v25.0';
const PIN = '482913';

function useVaultKey() { process.env.WA_TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32); }

/** Error shaped like the metaClient's MetaGraphError, but WITHOUT `kind` (so the local classification is exercised). */
function graphErr(res) {
  const e = (res.data && res.data.error) || {};
  return Object.assign(new Error(String(e.message || 'graph error').slice(0, 200)), { code: e.code, subcode: e.error_subcode, httpStatus: res.status });
}

/** The metaClient contract over fakeGraph's http port. Returns the raw Graph JSON. */
function rawGraphClient(g) {
  async function call(method, path, { token, params, data } = {}) {
    const res = await g.http.request({
      method, url: `${BASE}/${path}`, params, data, headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 20000, validateStatus: () => true,
    });
    if (res.status >= 400 || (res.data && res.data.error)) throw graphErr(res);
    return res.data;
  }
  return {
    debugToken: (token) => call('GET', 'debug_token', { params: { input_token: token, access_token: g.ids.appToken } }),
    getWaba: (token, id, fields) => call('GET', id, { token, params: { fields: fields || metaConfig.WABA_FIELDS() } }),
    getPhone: (token, id, fields) => call('GET', id, { token, params: { fields: fields || metaConfig.PHONE_FIELDS_FULL } }),
    listSubscribedApps: (token, waba) => call('GET', `${waba}/subscribed_apps`, { token }),
    subscribeApp: (token, waba) => call('POST', `${waba}/subscribed_apps`, { token }),
    setDisplayName: (token, id, name) => call('POST', id, { token, data: { new_display_name: name } }),
    registerPhone: (token, id, pin) => call('POST', `${id}/register`, { token, data: { messaging_product: 'whatsapp', pin } }),
  };
}

const flush = async (n = 4) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

/**
 * A complete fake environment for statusRefresh / approvals / webhookEvents.
 * @param {{graph?:object}} [opts] options of createFakeGraph
 */
function makeEnv(opts = {}) {
  useVaultKey();
  const clock = fixedClock('2026-10-15T09:00:00Z');
  const g = createFakeGraph({ clock, ...(opts.graph || {}) });
  const Connection = createFakeModel({ unique: [['workspaceId']] });
  const Template = createFakeModel();
  const Inbound = createFakeModel({ unique: [['_id']] });
  const notifModel = createFakeModel({ unique: [['workspaceId', 'dedupeKey']] });
  const emailSend = jest.fn(async () => ({ sent: true, id: 'mail_1' }));
  const notifications = createNotifications({ model: notifModel, email: { sendNotificationEmail: emailSend }, now: () => new Date(clock.ms()) });
  const analytics = { track: jest.fn(async () => undefined) };
  const state = { invalidate: jest.fn() };
  const connect = { reportGraphError: jest.fn(async () => undefined) };
  const log = jest.fn();
  const deps = {
    Connection, Template, Inbound, meta: rawGraphClient(g), vault, notifications, analytics, state, connect,
    appId: g.ids.appId, now: () => clock.ms(), log, paymentProbe: () => false, throwOnFailure: false,
  };
  function seedConn(over = {}) {
    return Connection.seed({
      workspaceId: WS,
      status: 'connected',
      ids: { wabaId: g.ids.wabaId, phoneNumberId: g.ids.phoneId, businessId: g.ids.businessId },
      display: { displayPhoneNumber: '+966 55 123 4567', last4: '4567', verifiedName: 'Acme Coffee' },
      tokenEncrypted: vault.encrypt(g.ids.merchantToken, { workspaceId: WS, purpose: 'token' }),
      pinEncrypted: vault.encrypt(PIN, { workspaceId: WS, purpose: 'pin' }),
      needsReconnect: false,
      webhook: { subscribed: true },
      verification: { businessRaw: 'verified', mapped: 'done' },
      displayName: { nameStatusRaw: 'APPROVED', mapped: 'done' },
      payment: { status: 'unknown' },
      messagingLimit: { raw: 'TIER_250', tierNumber: 250 },
      health: { canSend: 'AVAILABLE', issues: [] },
      tokenExpiresAt: null,
      nextCheckAt: new Date(clock.ms() - 1000),
      checkFailures: 0,
      connectedAt: new Date('2026-10-01T00:00:00Z'),
      ...over,
    });
  }
  const row = () => Connection.rows[0];
  const notes = () => notifModel.rows;
  const events = () => analytics.track.mock.calls.map((c) => c[1]);
  return { clock, g, Connection, Template, Inbound, notifModel, notifications, emailSend, analytics, state, connect, log, deps, seedConn, row, notes, events };
}

module.exports = { makeEnv, rawGraphClient, flush, useVaultKey, WS, WS2, PIN, BASE };
