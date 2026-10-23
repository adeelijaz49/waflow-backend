'use strict';
// Shared fakes for the B1-e unit suites (starter templates, test message, first promotion).
// In-memory models (tests/onboarding/unit/_b0Store.js), a fake metaClient with the DB 6.2 signatures
// (token, wabaId|phoneId, ...), a fake token vault. No DB, no network.
const { createFakeModel } = require('./_b0Store');

const WS = '507f1f77bcf86cd799439011';
const WS2 = '507f1f77bcf86cd799439022';
const USER = '507f1f77bcf86cd799439099';
const MERCHANT_TOKEN = 'EAAFXTmerchantTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz';
const PLATFORM_TOKEN = 'EAAFXTplatformTOKEN_0123456789_abcdefghijklmnopqrstuvwxyz';
const ENCRYPTED = 'v1:ZmFrZQ==.ZmFrZQ==.ZmFrZQ==';
const NOW = new Date('2026-10-15T09:00:00.000Z');

function clock(start = NOW) {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms) => { t += ms; }, set: (v) => { t = new Date(v).getTime(); } };
}

/** A fake Graph client (DB 6.2 signatures) with an in-memory template list per WABA. */
function makeClient(opts = {}) {
  const calls = [];
  const remote = []; // templates "on Meta"
  let nextId = 1000;
  const failNext = []; // { name:'submit'|'list'|'send', err, times? }
  function maybeFail(name) {
    const i = failNext.findIndex((f) => f.name === name);
    if (i < 0) return;
    const f = failNext[i];
    f.times = (f.times || 1) - 1;
    if (f.times <= 0) failNext.splice(i, 1);
    throw f.err;
  }
  const client = {
    calls,
    remote,
    failNext,
    submitTemplate: jest.fn(async (token, wabaId, payload) => {
      calls.push({ name: 'submit', token, wabaId, payload });
      maybeFail('submit');
      const dup = remote.find((t) => t.wabaId === wabaId && t.name === payload.name && t.language === payload.language); // names are unique per WhatsApp Business account
      if (dup) { const e = new Error('(#100) Invalid parameter'); e.code = 100; e.subcode = 2388024; e.httpStatus = 400; throw e; }
      const t = { id: String(nextId++), name: payload.name, language: payload.language, status: opts.initialStatus || 'PENDING', category: payload.category, wabaId };
      remote.push(t);
      return { id: t.id, status: t.status, category: t.category };
    }),
    listTemplates: jest.fn(async (token, wabaId, q) => {
      calls.push({ name: 'list', token, wabaId, query: q });
      maybeFail('list');
      const rows = remote.filter((t) => t.wabaId === wabaId && (!q || !q.name || t.name.includes(q.name)));
      return { data: rows.map((t) => ({ id: t.id, name: t.name, language: t.language, status: t.status, category: t.category, rejected_reason: t.rejected_reason, rejection_info: t.rejection_info })) };
    }),
    sendTemplateMessage: jest.fn(async (token, phoneId, args) => {
      calls.push({ name: 'send', token, phoneId, args });
      maybeFail('send');
      return { messageId: 'wamid.X1' };
    }),
    setStatus(name, status, extra = {}) {
      const t = remote.find((x) => x.name === name);
      if (!t) throw new Error(`no remote template ${name}`);
      Object.assign(t, { status }, extra);
    },
  };
  return client;
}

/**
 * @param {{languages?:string[], connStatus?:string|null, needsReconnect?:boolean, userPhone?:string|null, defaultCountryCode?:string,
 *          uiLanguage?:string, displayPhoneNumber?:string, vaultFails?:boolean, role?:string|null, hmacSecret?:string|null}} [o]
 *   role: the requesting user's live Membership role ('owner' by default, null = no membership, e.g. a removed member); hmacSecret: the
 *   server secret that keys the number hash (a test value by default, null = none)
 */
function makeWorld(o = {}) {
  const Template = createFakeModel({ unique: [['workspaceId', 'key', 'language']], defaults: { attempts: 0, blockedReason: null } });
  const State = createFakeModel({ unique: [['workspaceId']] });
  const Conn = createFakeModel({ unique: [['workspaceId']] });
  const Event = createFakeModel();
  const Customer = createFakeModel();
  const User = createFakeModel();
  const Settings = createFakeModel();
  const Product = createFakeModel();
  const Service = createFakeModel();
  const Campaign = createFakeModel();
  const Membership = createFakeModel();

  State.seed({
    workspaceId: WS,
    business: { languages: o.languages, uiLanguage: o.uiLanguage || 'en' },
    firstPromotion: { state: 'locked', testMessageCount: 0 },
  });
  if (o.connStatus !== null) {
    Conn.seed({
      workspaceId: WS,
      status: o.connStatus || 'connected',
      needsReconnect: !!o.needsReconnect,
      tokenEncrypted: ENCRYPTED,
      ids: { wabaId: 'W1', phoneNumberId: 'P1' },
      display: { displayPhoneNumber: o.displayPhoneNumber || '+966 55 000 1111' },
      connectedAt: new Date('2026-10-14T09:00:00Z'),
    });
  }
  if (o.userPhone !== null) User.seed({ _id: USER, phone: o.userPhone === undefined ? '966501234567' : o.userPhone });
  else User.seed({ _id: USER, email: 'a@b.test' });
  Settings.seed({ workspaceId: WS, defaultCountryCode: o.defaultCountryCode || '966' });
  if (o.role !== null) Membership.seed({ userId: USER, workspaceId: WS, role: o.role || 'owner' });

  const vault = { decrypt: jest.fn((env, ctx) => { if (o.vaultFails) { const e = new Error('x'); e.code = 'DECRYPTION_FAILED'; throw e; } return MERCHANT_TOKEN; }) };
  const client = makeClient(o.client);
  const c = clock();
  const notify = jest.fn(async () => ({ created: true }));
  const track = jest.fn(async () => {});
  const connect = { reportGraphError: jest.fn(async () => {}) };
  const getGateState = jest.fn(async (ws) => ({ enrolled: true, sub: { state: 'active', source: 'admin' }, conn: { status: 'connected', needsReconnect: false } }));
  const deps = {
    model: Template, stateModel: State, connModel: Conn, eventModel: Event, customerModel: Customer, userModel: User,
    settingsModel: Settings, productModel: Product, serviceModel: Service, campaignModel: Campaign, membershipModel: Membership,
    hmacSecret: o.hmacSecret === undefined ? 'unit-test-server-secret-0123456789' : o.hmacSecret,
    vault, metaClient: client, now: c.now, notify, track, connect, getGateState,
  };
  return { Template, State, Conn, Event, Customer, User, Settings, Product, Service, Campaign, Membership, vault, client, clock: c, notify, track, connect, getGateState, deps };
}

/** Seed one submitted/decided template row. */
function seedTemplate(world, row) {
  return world.Template.seed({ workspaceId: WS, revision: 1, attempts: 1, blockedReason: null, source: 'library', ...row });
}

const flat = (v) => JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString() : x));

/** Capture console output of a block (every level) and return the lines. */
async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const l of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[l] = console[l];
    console[l] = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : flat(x))).join(' '));
  }
  try { await fn(); } finally { for (const l of Object.keys(orig)) console[l] = orig[l]; }
  return lines;
}

module.exports = { WS, WS2, USER, MERCHANT_TOKEN, PLATFORM_TOKEN, NOW, clock, makeClient, makeWorld, seedTemplate, flat, captureLogs };
