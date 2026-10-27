const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// DB-backed integration tests for the super-admin identity and the /api/platform console API (routes/platform.js,
// middleware/requireSuperAdmin.js, middleware/requireAuth.js, routes/auth.js, routes/legal.js, routes/internalAdmin.js).
// The app is built here the way server.js mounts it. Every Graph check goes through an injected stub (deps.metaCheck) and axios
// is wired to throw, so nothing can leave the machine. Every test makes its own customers; nothing is ever deleted.
const fx = require('./_fixtures');
process.env.AUTH_TEST_MODE = 'true'; // routes/auth.js returns the OTP / magic-link secret instead of sending it (read when that module loads)

const axios = require('axios');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let networkCalls = 0;
axios.defaults.adapter = async () => { networkCalls += 1; throw new Error('the network is not allowed in this test'); };

const { requireAuth, JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
const requireSuperAdmin = require('../../../middleware/requireSuperAdmin');
const { createRouter } = require('../../../routes/platform');
const tokenVault = require('../../../shared/onboarding/tokenVault');
const Workspace = require('../../../models/Workspace');
const User = require('../../../models/User');
const Membership = require('../../../models/Membership');
const Invite = require('../../../models/Invite');
const Settings = require('../../../models/Settings');
const Subscription = require('../../../models/Subscription');
const PlatformAuditLog = require('../../../models/PlatformAuditLog');
const LegalAcceptance = require('../../../models/LegalAcceptance');
const Product = require('../../../models/Product');
const Customer = require('../../../models/Customer');

jest.setTimeout(180000);

// ── the app, mounted like server.js ──────────────────────────────────────────

const metaStub = jest.fn();
const invalidateSpy = jest.fn();
const platformRouter = createRouter({ metaCheck: metaStub, invalidateSender: invalidateSpy });

function buildApp(router) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../../../routes/auth'));
  app.use('/api/platform', requireAuth, requireSuperAdmin, router);
  app.use('/api/legal', requireAuth, require('../../../routes/legal'));
  app.use('/api/products', requireAuth, require('../../../routes/products'));
  app.use('/internal-admin', (req, res, next) => { req.adminIp = '127.0.0.1'; next(); }, require('../../../routes/internalAdmin')); // the Basic-Auth gate is not under test here
  return app;
}
const app = buildApp(platformRouter);

// ── fixtures ─────────────────────────────────────────────────────────────────

const TAG = fx.uniq();
const STAFF_EMAIL = `staff-${TAG}@example.test`;
const STAFF2_EMAIL = `staff2-${TAG}@example.test`;
const STAFF_PHONE = fx.nextPhone();
const STAFF_PHONE_TYPED = `+${STAFF_PHONE.slice(0, 3)} ${STAFF_PHONE.slice(3, 5)} ${STAFF_PHONE.slice(5, 8)} ${STAFF_PHONE.slice(8)}`; // typed with spaces in the env
const ADMINS = `${STAFF_EMAIL.toUpperCase()}, ${STAFF_PHONE_TYPED}; ${STAFF2_EMAIL}`;
const ENC_KEY = crypto.randomBytes(32).toString('hex');
const PLATFORM_WABA = '555000111222';
const PLATFORM_PHONE_ID = '4440001112223'; // set as WA_PHONE_ID for the run
const SECRET_TOKEN = `EAAB${TAG}${'x'.repeat(70)}`;

const saved = {};
const ENV_KEYS = ['SUPER_ADMIN_CONTACTS', 'ALLOW_SELF_SERVE_SIGNUP', 'WA_TOKEN_ENCRYPTION_KEY', 'WA_TOKEN_ENCRYPTION_KEY_PREV', 'SOCIAL_TOKEN_ENCRYPTION_KEY', 'WA_WABA_ID', 'WA_PHONE_ID'];
let staff; // { token, userId, workspaceId } - an allow-listed super admin signed in by magic link
let defaultWorkspace; // the OLDEST workspace in this database

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  applyDefaultEnv();
  await fx.connect();
  for (const m of [Workspace, PlatformAuditLog, Subscription, Invite, LegalAcceptance, Product, Customer, require('../../../models/Plan'), require('../../../models/LoginChallenge')]) {
    try { await m.init(); } catch (e) { /* index build is best effort here */ }
  }
  defaultWorkspace = (await fx.makeWorkspace({ arabic: false })).workspace; // created first: the platform default (oldest)
  await sleep(15);
  const login = await loginByEmail(STAFF_EMAIL);
  expect(login.status).toBe(200);
  staff = { token: login.body.token, workspaceId: login.body.workspace.id, userId: jwt.decode(login.body.token).sub };
});
afterAll(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await fx.disconnect();
});
function applyDefaultEnv() {
  process.env.SUPER_ADMIN_CONTACTS = ADMINS;
  delete process.env.ALLOW_SELF_SERVE_SIGNUP;
  process.env.WA_TOKEN_ENCRYPTION_KEY = ENC_KEY;
  delete process.env.WA_TOKEN_ENCRYPTION_KEY_PREV;
  delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
  process.env.WA_WABA_ID = PLATFORM_WABA;
  process.env.WA_PHONE_ID = PLATFORM_PHONE_ID;
}
beforeEach(() => {
  applyDefaultEnv();
  metaStub.mockReset();
  metaStub.mockImplementation(async ({ wabaId, token }) => ({
    phoneOk: true, tokenIsValid: true, displayPhoneNumber: '+966 50 123 4567', verifiedName: 'MegaSun Test',
    wabaId: wabaId || (token ? '987654321000' : PLATFORM_WABA),
  }));
  invalidateSpy.mockClear();
});
afterEach(() => { jest.restoreAllMocks(); });
beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}); }); // the routes log refused audit writes / unreachable Meta on purpose

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const api = (method, path, token, body) => {
  const r = request(app)[method](path);
  if (token) r.set(auth(token));
  return body === undefined ? r : r.send(body);
};
async function loginByEmail(email) {
  const first = await request(app).post('/api/auth/magic-link/request').send({ email });
  return request(app).post('/api/auth/magic-link/verify').send({ token: first.body.testToken });
}
async function loginByPhone(phone) {
  const first = await request(app).post('/api/auth/otp/request').send({ phone });
  return request(app).post('/api/auth/otp/verify').send({ phone, code: first.body.testCode });
}
let seq = 0;
const nextEmail = (prefix = 'owner') => { seq += 1; return `${prefix}-${TAG}-${seq}@example.test`; };
let phoneIdSeq = Number(String(Date.now()).slice(-9)) * 1000;
const nextPhoneId = () => { phoneIdSeq += 1; return String(phoneIdSeq); };

async function makeTenant(over = {}) {
  seq += 1;
  const body = { name: `Customer ${TAG} ${seq}`, ownerContactType: 'email', ownerContact: nextEmail(), currency: 'SAR', defaultCountryCode: '966', ...over };
  const res = await api('post', '/api/platform/tenants', staff.token, body);
  expect(res.status).toBe(201);
  return { body, res: res.body, id: res.body.tenant.id, name: body.name };
}
const rawWorkspace = (id) => mongoose.connection.collection('workspaces').findOne({ _id: new mongoose.Types.ObjectId(id) });
const auditRows = (workspaceId, action) => PlatformAuditLog.find({ workspaceId, ...(action ? { action } : {}) }).sort({ createdAt: 1, _id: 1 }).lean();
const put = (id, body, token = staff.token) => api('put', `/api/platform/tenants/${id}/whatsapp`, token, body);

// ── 1. who may use the platform API ─────────────────────────────────────────

describe('super admin gating', () => {
  test('login by magic link marks an allow-listed contact as super admin (the env entry is case-insensitive) and /auth/me re-checks it', async () => {
    const decoded = jwt.decode(staff.token);
    expect(decoded.sa).toBe(true);
    const me = await api('get', '/api/auth/me', staff.token);
    expect(me.status).toBe(200);
    expect(me.body.superAdmin).toBe(true);
    expect(me.body.canManageWhatsApp).toBe(true); // may manage the platform's WhatsApp token and templates (the Settings cards)
    expect(me.body.actingAs).toBeUndefined();
    expect(me.body.role).toBe('owner');
  });

  test('login responses carry superAdmin: true for an allow-listed phone typed with spaces in the env, false for everyone else', async () => {
    const phoneLogin = await loginByPhone(STAFF_PHONE);
    expect(phoneLogin.status).toBe(200);
    expect(phoneLogin.body.superAdmin).toBe(true);
    expect(jwt.decode(phoneLogin.body.token).sa).toBe(true);
    const ordinary = await loginByEmail(nextEmail('ordinary'));
    expect(ordinary.status).toBe(200);
    expect(ordinary.body.superAdmin).toBe(false);
    expect(jwt.decode(ordinary.body.token).sa).toBeUndefined();
    const ordinaryMe = (await api('get', '/api/auth/me', ordinary.body.token)).body;
    expect(ordinaryMe.superAdmin).toBe(false);
    expect(ordinaryMe.canManageWhatsApp).toBe(false); // a customer's owner on the shared number has no platform rights while super admins are configured
  });

  test('/auth/me canManageWhatsApp is the very rule the WhatsApp routes enforce: platform staff for the platform account (nobody configured -> the people of the OLDEST workspace; configured -> a super admin outside any customer), the owner of a customer for its own account', async () => {
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
    const customer = await fx.makeWorkspace({ arabic: false });
    expect(String(oldest._id)).not.toBe(String(customer.workspaceId));
    const inOldest = fx.tokenFor({ userId: customer.user._id, workspaceId: oldest._id, role: 'owner' }); // (a token only needs a real user and workspace)
    const saved = process.env.SUPER_ADMIN_CONTACTS;
    try {
      delete process.env.SUPER_ADMIN_CONTACTS;
      expect((await api('get', '/api/auth/me', inOldest)).body.canManageWhatsApp).toBe(true);
      expect((await api('get', '/api/auth/me', customer.token)).body.canManageWhatsApp).toBe(false);
      process.env.SUPER_ADMIN_CONTACTS = saved;
      expect((await api('get', '/api/auth/me', inOldest)).body.canManageWhatsApp).toBe(false); // configured: being in the oldest workspace no longer matters
      expect((await api('get', '/api/auth/me', staff.token)).body.canManageWhatsApp).toBe(true);

      // a customer with a number of its OWN in its OWN WhatsApp account: its owner manages that account (a plain member does not)
      const own = await makeTenant();
      expect((await put(own.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(200);
      const ownToken = (role) => fx.tokenFor({ userId: customer.user._id, workspaceId: own.id, role });
      expect((await api('get', '/api/auth/me', ownToken('owner'))).body.canManageWhatsApp).toBe(true);
      expect((await api('get', '/api/auth/me', ownToken('member'))).body.canManageWhatsApp).toBe(false);
      // a number added INSIDE the platform's account is still the platform's: its owner has no rights there
      const inside = await makeTenant();
      expect((await put(inside.id, { phoneId: nextPhoneId() })).status).toBe(200);
      expect((await api('get', '/api/auth/me', fx.tokenFor({ userId: customer.user._id, workspaceId: inside.id, role: 'owner' }))).body.canManageWhatsApp).toBe(false);
      // staff working inside the own-account customer work as its owner: they do manage that account
      const entered = await api('post', `/api/platform/tenants/${own.id}/enter`, staff.token);
      expect((await api('get', '/api/auth/me', entered.body.token)).body.canManageWhatsApp).toBe(true);
    } finally { if (saved === undefined) delete process.env.SUPER_ADMIN_CONTACTS; else process.env.SUPER_ADMIN_CONTACTS = saved; }
  });

  test('a super admin gets 200; a missing token gets 401; an ordinary customer owner gets 403 on every platform route', async () => {
    expect((await api('get', '/api/platform/tenants', staff.token)).status).toBe(200);
    expect((await api('get', '/api/platform/tenants')).status).toBe(401);
    const ordinary = await fx.makeWorkspace({ arabic: false });
    const t = await makeTenant();
    const probes = [
      ['get', '/api/platform/tenants'], ['post', '/api/platform/tenants'], ['get', `/api/platform/tenants/${t.id}`],
      ['patch', `/api/platform/tenants/${t.id}`], ['post', `/api/platform/tenants/${t.id}/members`], ['put', `/api/platform/tenants/${t.id}/whatsapp`],
      ['post', `/api/platform/tenants/${t.id}/whatsapp/verify`], ['delete', `/api/platform/tenants/${t.id}/whatsapp`],
      ['post', `/api/platform/tenants/${t.id}/enter`], ['post', '/api/platform/exit'], ['get', '/api/platform/audit'],
    ];
    for (const [method, path] of probes) {
      const res = await api(method, path, ordinary.token, {});
      expect([path, res.status, res.body.error]).toEqual([path, 403, 'Super admin only']);
    }
    // an ordinary token that CLAIMS sa is still refused: the decision comes from the database + env, not the token
    const forged = jwt.sign({ sub: String(ordinary.user._id), workspaceId: String(ordinary.workspaceId), role: 'owner', sa: true }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE });
    expect((await api('get', '/api/platform/tenants', forged)).status).toBe(403);
  });

  test('env empty (or unset): even the former super admin is refused (403), and /auth/me says superAdmin false', async () => {
    for (const v of ['', undefined]) {
      if (v === undefined) delete process.env.SUPER_ADMIN_CONTACTS; else process.env.SUPER_ADMIN_CONTACTS = v;
      const res = await api('get', '/api/platform/tenants', staff.token);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Super admin only' });
      const me = (await api('get', '/api/auth/me', staff.token)).body;
      expect(me.superAdmin).toBe(false);
      // nobody configured: the platform's WhatsApp cards belong to the OLDEST workspace's people only (staff's own workspace is not it)
      const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
      expect(me.canManageWhatsApp).toBe(String(oldest._id) === String(staff.workspaceId));
    }
    process.env.SUPER_ADMIN_CONTACTS = ' , ;; ';
    expect((await api('get', '/api/platform/tenants', staff.token)).status).toBe(403);
  });

  test('removing the contact from the env takes effect on the very next request (the token still says sa)', async () => {
    expect((await api('get', '/api/platform/tenants', staff.token)).status).toBe(200);
    process.env.SUPER_ADMIN_CONTACTS = 'someone-else@example.test';
    expect((await api('get', '/api/platform/tenants', staff.token)).status).toBe(403);
    process.env.SUPER_ADMIN_CONTACTS = ADMINS;
    expect((await api('get', '/api/platform/tenants', staff.token)).status).toBe(200);
  });

  test('the router checks by itself: mounted with NO middleware it still refuses anonymous and ordinary callers', async () => {
    const bare = express();
    bare.use(express.json());
    bare.use('/api/platform', createRouter({ metaCheck: metaStub, invalidateSender: invalidateSpy }));
    expect((await request(bare).get('/api/platform/tenants')).status).toBe(401);
    const ordinary = await fx.makeWorkspace({ arabic: false });
    expect((await request(bare).get('/api/platform/tenants').set(auth(ordinary.token))).status).toBe(403);
    expect((await request(bare).get('/api/platform/tenants').set(auth(staff.token))).status).toBe(200);
  });

  test('an enter-customer (act-as) token is refused on every platform route except POST /exit', async () => {
    const t = await makeTenant();
    const entered = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    const act = entered.body.token;
    for (const [method, path] of [['get', '/api/platform/tenants'], ['post', '/api/platform/tenants'], ['post', `/api/platform/tenants/${t.id}/enter`], ['put', `/api/platform/tenants/${t.id}/whatsapp`], ['get', '/api/platform/audit']]) {
      const res = await api(method, path, act, {});
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error).toBe('Super admin only');
    }
    expect((await api('post', '/api/platform/exit', act)).status).toBe(200);
  });

  test('POST /exit with a normal (not act-as) token is a 400, and writes no audit row', async () => {
    const before = await PlatformAuditLog.countDocuments({ action: 'exit' });
    const res = await api('post', '/api/platform/exit', staff.token);
    expect(res.status).toBe(400);
    expect(await PlatformAuditLog.countDocuments({ action: 'exit' })).toBe(before);
  });
});

// ── 2. creating a customer ──────────────────────────────────────────────────

describe('POST /tenants', () => {
  test('creates the workspace, the owner User + owner Membership, the settings, the subscription and one audit row', async () => {
    const ownerPhone = fx.nextPhone();
    const name = `MegaSun ${TAG}`;
    const res = await api('post', '/api/platform/tenants', staff.token, {
      name: `  ${name}  `, ownerContactType: 'phone', ownerContact: `+${ownerPhone}`, ownerName: 'Maha Owner', currency: 'sar', defaultCountryCode: '+966',
    });
    expect(res.status).toBe(201);
    const { tenant, owner, signInHint } = res.body;
    expect(tenant).toMatchObject({
      name, isPlatformDefault: false, memberCount: 1, customerCount: 0, arabicEnabled: false,
      whatsapp: { mode: 'platform', phoneIdLast4: null, tokenConfigured: false, tokenIsValid: null, enabled: true },
    });
    expect(tenant.owners).toEqual([{ userId: owner.userId, name: 'Maha Owner', contactMasked: `******${ownerPhone.slice(-4)}` }]);
    expect(tenant.plan).toEqual({ code: 'starter', status: 'active' });
    expect(owner.created).toBe(true);
    expect(signInHint).toContain('No message has been sent');
    expect(signInHint).not.toContain(ownerPhone);

    const ws = await Workspace.findById(tenant.id).lean();
    expect(ws.name).toBe(name);
    expect(ws.onboarding).toMatchObject({ completed: true, currentStep: 5 });
    const user = await User.findById(owner.userId).lean();
    expect(user).toMatchObject({ phone: ownerPhone, name: 'Maha Owner' });
    const memberships = await Membership.find({ workspaceId: tenant.id }).lean();
    expect(memberships).toHaveLength(1);
    expect(String(memberships[0].userId)).toBe(owner.userId);
    expect(memberships[0].role).toBe('owner');
    const settings = await Settings.find({ workspaceId: tenant.id }).lean();
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ merchantName: name, currency: 'SAR', defaultCountryCode: '966' });
    expect(await Subscription.countDocuments({ workspaceId: tenant.id })).toBe(1);

    const rows = await auditRows(tenant.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'create_tenant' });
    expect(String(rows[0].actorUserId)).toBe(staff.userId);
    expect(rows[0].actorLabel).toBe(`s***@e***.test`);
    expect(rows[0].detail).toMatchObject({ name, ownerContactType: 'phone', ownerContactMasked: `******${ownerPhone.slice(-4)}`, ownerExisted: false });
    expect(JSON.stringify(rows[0])).not.toContain(ownerPhone);
  });

  test('the owner\'s first login lands directly in the new customer: one membership, no picker, no stray workspace', async () => {
    const ownerEmail = nextEmail('lands');
    const t = await makeTenant({ ownerContact: ownerEmail.toUpperCase() });
    const before = await Workspace.countDocuments();
    const login = await loginByEmail(ownerEmail);
    expect(login.status).toBe(200);
    expect(login.body.chooseWorkspace).toBeUndefined();
    expect(login.body.workspace.id).toBe(t.id);
    expect(login.body.workspace.onboarding.completed).toBe(true); // the setup wizard is skipped
    expect(login.body.role).toBe('owner');
    expect(login.body.superAdmin).toBe(false);
    expect(await Workspace.countDocuments()).toBe(before); // login created nothing new
    const user = await User.findOne({ email: ownerEmail }).lean();
    expect(await Membership.countDocuments({ userId: user._id })).toBe(1);
    expect(jwt.decode(login.body.token).sa).toBeUndefined();
    expect((await api('get', '/api/products', login.body.token)).status).toBe(200);
    expect((await api('get', '/api/platform/tenants', login.body.token)).status).toBe(403);
  });

  test('the same contact twice reuses the one User (second customer for the same owner); same name + same owner is refused', async () => {
    const ownerEmail = nextEmail('twice');
    const a = await makeTenant({ ownerContact: ownerEmail });
    const b = await makeTenant({ ownerContact: ` ${ownerEmail.toUpperCase()} `, ownerName: 'Ignored Name' });
    expect(b.res.owner.created).toBe(false);
    expect(b.res.owner.userId).toBe(a.res.owner.userId);
    expect(await User.countDocuments({ email: ownerEmail })).toBe(1);
    expect(await Membership.countDocuments({ userId: a.res.owner.userId })).toBe(2);
    expect(b.id).not.toBe(a.id);
    const dup = await api('post', '/api/platform/tenants', staff.token, { name: a.name.toUpperCase(), ownerContactType: 'email', ownerContact: ownerEmail });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('TENANT_EXISTS');
    expect(await Workspace.countDocuments({ name: new RegExp(`^${a.name}$`, 'i') })).toBe(1);
    // logging in now offers the picker (two memberships), which is what the sign-in hint warns about
    expect(b.res.signInHint).toContain('choose between their workspaces');
    const login = await loginByEmail(ownerEmail);
    expect(login.body.chooseWorkspace).toBe(true);
    expect(login.body.workspaces.map((w) => w.id).sort()).toEqual([a.id, b.id].sort());
  });

  test('an existing User without a name gets the name; one that has a name keeps it', async () => {
    const email = nextEmail('named');
    await User.create({ email });
    const t = await makeTenant({ ownerContact: email, ownerName: 'Given Later' });
    expect(t.res.owner.created).toBe(false);
    expect((await User.findOne({ email }).lean()).name).toBe('Given Later');
    await makeTenant({ ownerContact: email, ownerName: 'Someone Else' });
    expect((await User.findOne({ email }).lean()).name).toBe('Given Later');
  });

  test('validation errors answer 400, with a plain message, and create nothing (no workspace, no user, no audit row)', async () => {
    const goodEmail = nextEmail('bad');
    const base = { name: `Valid ${TAG}`, ownerContactType: 'email', ownerContact: goodEmail };
    const cases = [
      ['no body at all', undefined],
      ['missing name', { ...base, name: undefined }],
      ['blank name', { ...base, name: '   ' }],
      ['name not a string', { ...base, name: 12345 }],
      ['name too long', { ...base, name: 'x'.repeat(101) }],
      ['invisible-only name', { ...base, name: '\u{200B}\u{200B}' }],
      ['missing contact type', { ...base, ownerContactType: undefined }],
      ['unknown contact type', { ...base, ownerContactType: 'fax' }],
      ['email without a domain', { ...base, ownerContact: 'owner@' }],
      ['email typed as phone', { ...base, ownerContactType: 'phone', ownerContact: goodEmail }],
      ['phone too short', { ...base, ownerContactType: 'phone', ownerContact: '12345' }],
      ['phone with letters', { ...base, ownerContactType: 'phone', ownerContact: '9665012abc67' }],
      ['phone too long', { ...base, ownerContactType: 'phone', ownerContact: '1'.repeat(16) }],
      ['missing contact', { ...base, ownerContact: undefined }],
      ['contact as an object (operator injection)', { ...base, ownerContact: { $ne: '' } }],
      ['bad currency', { ...base, currency: 'SARR' }],
      ['numeric currency', { ...base, currency: 123 }],
      ['bad country code', { ...base, defaultCountryCode: '96a' }],
      ['country code too long', { ...base, defaultCountryCode: '96612' }],
      ['owner name too long', { ...base, ownerName: 'n'.repeat(101) }],
    ];
    const wsBefore = await Workspace.countDocuments();
    const usersBefore = await User.countDocuments();
    const auditBefore = await PlatformAuditLog.countDocuments();
    for (const [label, body] of cases) {
      const res = await api('post', '/api/platform/tenants', staff.token, body);
      expect([label, res.status]).toEqual([label, 400]);
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(5);
    }
    expect(await Workspace.countDocuments()).toBe(wsBefore);
    expect(await User.countDocuments()).toBe(usersBefore);
    expect(await PlatformAuditLog.countDocuments()).toBe(auditBefore);
  });

  test('log-before-mutate: when the audit row cannot be written nothing is created', async () => {
    const name = `NoAudit ${TAG}`;
    const email = nextEmail('noaudit');
    jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('audit store down'));
    const res = await api('post', '/api/platform/tenants', staff.token, { name, ownerContactType: 'email', ownerContact: email });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/audit log, so nothing was changed/);
    expect(await Workspace.countDocuments({ name })).toBe(0);
    expect(await User.countDocuments({ email })).toBe(0);
  });

  test('defaults: no currency / country code leaves the settings defaults; the merchant name is still set', async () => {
    const res = await api('post', '/api/platform/tenants', staff.token, { name: `Plain ${TAG}`, ownerContactType: 'email', ownerContact: nextEmail('plain') });
    expect(res.status).toBe(201);
    const s = await Settings.findOne({ workspaceId: res.body.tenant.id }).lean();
    expect(s.merchantName).toBe(`Plain ${TAG}`);
    expect(s.currency).toBe('AUD'); // the Settings model default, as for any workspace
  });
});

// ── 3. listing, reading, renaming, members ──────────────────────────────────

describe('tenant list, detail, rename, members', () => {
  test('GET /tenants: shape, newest first, exactly one isPlatformDefault and it is the OLDEST workspace', async () => {
    const a = await makeTenant();
    await sleep(15);
    const b = await makeTenant();
    const res = await api('get', '/api/platform/tenants', staff.token);
    expect(res.status).toBe(200);
    const list = res.body.tenants;
    expect(list.length).toBeLessThanOrEqual(200);
    const ia = list.findIndex((t) => t.id === a.id);
    const ib = list.findIndex((t) => t.id === b.id);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ib).toBeLessThan(ia);
    const row = list[ib];
    expect(Object.keys(row).sort()).toEqual(['arabicEnabled', 'createdAt', 'customerCount', 'id', 'isPlatformDefault', 'memberCount', 'name', 'owners', 'plan', 'whatsapp'].sort());
    expect(Object.keys(row.whatsapp).sort()).toEqual(['checkedAt', 'displayPhoneNumber', 'enabled', 'mode', 'phoneIdLast4', 'tokenConfigured', 'tokenIsValid', 'verifiedName', 'wabaId'].sort());
    const defaults = list.filter((t) => t.isPlatformDefault);
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).lean();
    // (the list shows the newest 200, so in a busy shared database the oldest may not be on it: check every row, then the detail view)
    for (const t of list) expect([t.id, t.isPlatformDefault]).toEqual([t.id, t.id === String(oldest._id)]);
    expect(defaults.length).toBeLessThanOrEqual(1);
    const detail = await api('get', `/api/platform/tenants/${oldest._id}`, staff.token);
    expect(detail.body.tenant.isPlatformDefault).toBe(true);
    expect(detail.body.tenant.id).toBe(String(oldest._id));
    expect(list.find((t) => t.id === a.id).isPlatformDefault).toBe(false);
    expect(row.owners[0].contactMasked).toMatch(/^o\*\*\*@e\*\*\*\.test$/);
    expect(JSON.stringify(row)).not.toContain(b.body.ownerContact); // no full contact
  });

  test('search is by name, case-insensitive, and regex characters are treated as plain text', async () => {
    const t = await makeTenant({ name: `Zeta (Pilot) ${TAG}` });
    const hit = await api('get', `/api/platform/tenants?search=${encodeURIComponent(`zeta (pilot) ${TAG}`.toUpperCase())}`, staff.token);
    expect(hit.body.tenants.map((x) => x.id)).toEqual([t.id]);
    for (const q of ['.*', '[', '\\', '^$', `${TAG}(`]) {
      const res = await api('get', `/api/platform/tenants?search=${encodeURIComponent(q)}`, staff.token);
      expect([q, res.status]).toEqual([q, 200]);
      for (const x of res.body.tenants) expect(x.name.toLowerCase()).toContain(q.toLowerCase()); // literal text, not a pattern: '.*' must not match everything
      if (q === `${TAG}(`) expect(res.body.tenants).toHaveLength(0);
    }
    const paren = await api('get', `/api/platform/tenants?search=${encodeURIComponent('(')}`, staff.token);
    expect(paren.status).toBe(200);
    expect(paren.body.tenants.length).toBeGreaterThan(0);
    for (const x of paren.body.tenants) expect(x.name).toContain('(');
    expect((await api('get', '/api/platform/tenants?search[$ne]=x', staff.token)).status).toBe(200);
  });

  test('customerCount ignores erased customers; GET /tenants/:id adds members and counts', async () => {
    const t = await makeTenant();
    await fx.makeCustomer(t.id);
    await fx.makeCustomer(t.id);
    await fx.makeCustomer(t.id, { deletedAt: new Date() });
    await Product.create({ workspaceId: t.id, name: 'Beans', category: 'Coffee', basePrice: 5 });
    const list = await api('get', `/api/platform/tenants?search=${encodeURIComponent(t.name)}`, staff.token);
    expect(list.body.tenants[0].customerCount).toBe(2);
    const res = await api('get', `/api/platform/tenants/${t.id}`, staff.token);
    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ customers: 2, products: 1, services: 0, promotions: 0 });
    expect(res.body.tenant.id).toBe(t.id);
    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0]).toMatchObject({ role: 'owner', userId: t.res.owner.userId });
    expect(res.body.members[0].contactMasked).toMatch(/\*\*\*/);
    expect(Object.keys(res.body.members[0]).sort()).toEqual(['contactMasked', 'createdAt', 'name', 'role', 'userId']);
  });

  test('unknown or malformed ids are 404 everywhere and write nothing', async () => {
    const ghost = String(new mongoose.Types.ObjectId());
    const before = await PlatformAuditLog.countDocuments();
    for (const id of [ghost, 'nope', '123', '{"$ne":null}']) {
      for (const [method, path, body] of [
        ['get', `/api/platform/tenants/${encodeURIComponent(id)}`], ['patch', `/api/platform/tenants/${encodeURIComponent(id)}`, { name: 'x' }],
        ['post', `/api/platform/tenants/${encodeURIComponent(id)}/members`, { contactType: 'email', contact: 'a@b.co' }],
        ['put', `/api/platform/tenants/${encodeURIComponent(id)}/whatsapp`, { phoneId: '1234567' }], ['post', `/api/platform/tenants/${encodeURIComponent(id)}/whatsapp/verify`],
        ['delete', `/api/platform/tenants/${encodeURIComponent(id)}/whatsapp`], ['post', `/api/platform/tenants/${encodeURIComponent(id)}/enter`],
      ]) {
        const res = await api(method, path, staff.token, body);
        expect([id, method, path, res.status]).toEqual([id, method, path, 404]);
      }
    }
    expect(await PlatformAuditLog.countDocuments()).toBe(before);
  });

  test('PATCH renames, audits {from,to}, rejects bad names, and is refused (unchanged) when the audit cannot be written', async () => {
    const t = await makeTenant();
    const res = await api('patch', `/api/platform/tenants/${t.id}`, staff.token, { name: `  Renamed ${TAG}  ` });
    expect(res.status).toBe(200);
    expect(res.body.tenant.name).toBe(`Renamed ${TAG}`);
    expect((await Workspace.findById(t.id).lean()).name).toBe(`Renamed ${TAG}`);
    const [row] = await auditRows(t.id, 'rename');
    expect(row.detail).toEqual({ from: t.name, to: `Renamed ${TAG}` });
    for (const name of ['', '   ', 'x'.repeat(101), 7, null, undefined]) {
      expect((await api('patch', `/api/platform/tenants/${t.id}`, staff.token, { name })).status).toBe(400);
    }
    jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('down'));
    expect((await api('patch', `/api/platform/tenants/${t.id}`, staff.token, { name: 'Should not apply' })).status).toBe(500);
    expect((await Workspace.findById(t.id).lean()).name).toBe(`Renamed ${TAG}`);
  });

  test('every audited action keeps the address it came from (X-Forwarded-For as received, capped), and the audit list shows it', async () => {
    const t = await makeTenant();
    const forwarded = '203.0.113.7, 198.51.100.23';
    const res = await request(app).patch(`/api/platform/tenants/${t.id}`).set(auth(staff.token)).set('X-Forwarded-For', forwarded).send({ name: `Seen from afar ${TAG}` });
    expect(res.status).toBe(200);
    const [row] = await auditRows(t.id, 'rename');
    expect(row.forwardedFor).toBe(forwarded);
    const listed = await api('get', `/api/platform/audit?tenantId=${t.id}`, staff.token);
    expect(listed.status).toBe(200);
    const entry = listed.body.entries.find((e) => e.action === 'rename');
    expect(entry.forwardedFor).toBe(forwarded);
    // a header that is not there is stored as nothing, and a very long one is cut
    const plain = await api('patch', `/api/platform/tenants/${t.id}`, staff.token, { name: `Seen from here ${TAG}` });
    expect(plain.status).toBe(200);
    const rows = await auditRows(t.id, 'rename');
    expect(rows[rows.length - 1].forwardedFor || '').toBe('');
    await request(app).patch(`/api/platform/tenants/${t.id}`).set(auth(staff.token)).set('X-Forwarded-For', '10.0.0.1, '.repeat(60)).send({ name: `Seen from far ${TAG}` });
    const all = await auditRows(t.id, 'rename');
    expect(all[all.length - 1].forwardedFor.length).toBeLessThanOrEqual(200);
  });

  test('POST /members: adds a member (201), is idempotent (200), can promote a member to owner, never demotes an owner, validates input', async () => {
    const t = await makeTenant();
    const email = nextEmail('member');
    const add = await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: email, name: 'Mo Member', role: 'member' });
    expect(add.status).toBe(201);
    expect(add.body.created).toBe(true);
    expect(add.body.member).toMatchObject({ role: 'member', name: 'Mo Member' });
    expect(add.body.member.contactMasked).toMatch(/\*\*\*/);
    const again = await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: email.toUpperCase(), role: 'member' });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(await Membership.countDocuments({ workspaceId: t.id })).toBe(2);
    expect(await User.countDocuments({ email })).toBe(1);
    const promote = await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: email, role: 'owner' });
    expect(promote.status).toBe(200);
    expect(promote.body.member.role).toBe('owner');
    expect((await Membership.findOne({ workspaceId: t.id, userId: add.body.member.userId }).lean()).role).toBe('owner');
    const demote = await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: email, role: 'member' });
    expect(demote.status).toBe(409);
    expect((await Membership.findOne({ workspaceId: t.id, userId: add.body.member.userId }).lean()).role).toBe('owner');
    const rows = await auditRows(t.id, 'add_member');
    expect(rows).toHaveLength(2); // the add and the promotion (the idempotent repeat and the refused demotion wrote none)
    expect(JSON.stringify(rows)).not.toContain(email);
    // default role is member; validation
    const dflt = await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'phone', contact: fx.nextPhone() });
    expect(dflt.status).toBe(201);
    expect(dflt.body.member.role).toBe('member');
    for (const body of [{}, { contactType: 'email', contact: 'bad' }, { contactType: 'phone', contact: '12' }, { contactType: 'email', contact: nextEmail(), role: 'admin' }, { contactType: 'email', contact: nextEmail(), name: 'n'.repeat(101) }]) {
      expect((await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, body)).status).toBe(400);
    }
  });
});

describe('log-before-mutate on the writes that have no test of their own', () => {
  test('add person, save number, test connection and use platform number are each refused (500) with NOTHING changed when the audit row cannot be written', async () => {
    const t = await makeTenant();
    expect((await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(200);
    metaStub.mockResolvedValue({ phoneOk: true, tokenIsValid: true, wabaId: '777888999000' });
    const before = await rawWorkspace(t.id);
    const membersBefore = await Membership.countDocuments({ workspaceId: t.id });
    const email = nextEmail('late');
    invalidateSpy.mockClear();
    const attempts = [
      ['add person', () => api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: email, role: 'member' })],
      ['save number', () => put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN })],
      ['test connection', () => api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token)],
      ['use platform number', () => api('delete', `/api/platform/tenants/${t.id}/whatsapp`, staff.token)],
    ];
    for (const [name, run] of attempts) {
      jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('audit store down'));
      const res = await run();
      expect({ name, status: res.status }).toEqual({ name, status: 500 });
      expect(res.body.error).toMatch(/audit log/);
    }
    const after = await rawWorkspace(t.id);
    expect(after.whatsapp).toEqual(before.whatsapp); // number, account, token and recorded validity: exactly as before
    expect(await Membership.countDocuments({ workspaceId: t.id })).toBe(membersBefore);
    expect(await User.countDocuments({ email })).toBe(0);
    expect(invalidateSpy).not.toHaveBeenCalled(); // nothing changed, so no cache was told it had
    expect(await auditRows(t.id, 'add_member')).toHaveLength(0); // the refused attempt left no row (and, above, no person)
    expect(await auditRows(t.id, 'set_whatsapp')).toHaveLength(1); // only the first, successful save
    expect(await auditRows(t.id, 'verify_whatsapp')).toHaveLength(0);
    expect(await auditRows(t.id, 'clear_whatsapp')).toHaveLength(0);
  });
});

// ── 4. enter / exit a customer ──────────────────────────────────────────────

describe('enter and exit a customer', () => {
  test('enter: an 8-hour act-as token, NO Membership row, an audit row; /auth/me reports actingAs; the token works on the customer\'s data', async () => {
    const t = await makeTenant();
    await Product.create({ workspaceId: t.id, name: 'Customer-only product', category: 'Misc', basePrice: 3 });
    const membershipsBefore = await Membership.countDocuments({ workspaceId: t.id });
    const res = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    expect(res.status).toBe(200);
    expect(res.body.workspace).toEqual({ id: t.id, name: t.name });
    const claims = jwt.verify(res.body.token, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
    expect(claims).toMatchObject({ sub: staff.userId, workspaceId: t.id, role: 'owner', sa: true, actAs: true });
    expect(claims.exp - claims.iat).toBe(8 * 60 * 60);
    expect(new Date(res.body.expiresAt).getTime()).toBe(claims.exp * 1000);

    expect(await Membership.countDocuments({ workspaceId: t.id })).toBe(membershipsBefore);
    expect(await Membership.countDocuments({ userId: staff.userId, workspaceId: t.id })).toBe(0);
    const [row] = await auditRows(t.id, 'enter');
    expect(String(row.actorUserId)).toBe(staff.userId);
    expect(row.detail).toEqual({ workspaceName: t.name });

    const me = await api('get', '/api/auth/me', res.body.token);
    expect(me.status).toBe(200);
    expect(me.body.actingAs).toEqual({ workspaceId: t.id, customerName: t.name, homeWorkspaceId: null });
    expect(me.body.superAdmin).toBe(true);
    expect(me.body.canManageWhatsApp).toBe(false); // inside a customer staff work as its owner: no platform rights until they leave
    expect(me.body.workspace.id).toBe(t.id);
    expect(me.body.role).toBe('owner');
    expect((await api('get', '/api/auth/me', staff.token)).body.actingAs).toBeUndefined(); // the home session is not "acting"

    const products = await api('get', '/api/products', res.body.token);
    expect(products.status).toBe(200);
    expect(products.body.products.map((p) => p.name)).toEqual(['Customer-only product']);
    const home = await api('get', '/api/products', staff.token);
    expect(home.body.products.map((p) => p.name)).not.toContain('Customer-only product');
  });

  test('the act-as token stops working the moment the person leaves the allowlist (401), and while the allowlist is empty', async () => {
    const t = await makeTenant();
    const { body } = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    expect((await api('get', '/api/products', body.token)).status).toBe(200);
    process.env.SUPER_ADMIN_CONTACTS = 'someone-else@example.test';
    expect((await api('get', '/api/products', body.token)).status).toBe(401);
    expect((await api('get', '/api/auth/me', body.token)).status).toBe(401);
    delete process.env.SUPER_ADMIN_CONTACTS;
    expect((await api('get', '/api/products', body.token)).status).toBe(401);
  });

  test('exit writes an audit row for the customer that was being viewed', async () => {
    const t = await makeTenant();
    const { body } = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    const res = await api('post', '/api/platform/exit', body.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const rows = await auditRows(t.id);
    expect(rows.map((r) => r.action)).toEqual(['create_tenant', 'enter', 'exit']);
    expect(String(rows[2].actorUserId)).toBe(staff.userId);
  });

  test('a forged act-as token (right shape, signed for someone not on the allowlist) is useless', async () => {
    const t = await makeTenant();
    const ordinary = await fx.makeWorkspace({ arabic: false });
    const forged = jwt.sign({ sub: String(ordinary.user._id), workspaceId: t.id, role: 'owner', sa: true, actAs: true }, JWT_SECRET, { expiresIn: '8h', issuer: ISSUER, audience: AUDIENCE });
    expect((await api('get', '/api/products', forged)).status).toBe(401);
  });

  test('legal gate: an act-as session needs nothing and can accept nothing; the customer\'s own owner is still asked for the DPA', async () => {
    const ownerEmail = nextEmail('legal');
    const t = await makeTenant({ ownerContact: ownerEmail });
    const { body } = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    const status = await api('get', '/api/legal/acceptance-status', body.token);
    expect(status.status).toBe(200);
    expect(status.body.requiresCombinedAcceptance).toBe(false);
    expect(status.body.requiresDpaAcceptance).toBe(false);
    expect(status.body.dpa.accepted).toBe(false); // the shape is unchanged: the customer has still not accepted
    expect(status.body.combined.documents.length).toBeGreaterThan(0);
    for (const path of ['/api/legal/accept/dpa', '/api/legal/accept/combined']) {
      const res = await api('post', path, body.token);
      expect([path, res.status]).toEqual([path, 403]);
    }
    expect(await LegalAcceptance.countDocuments({ workspaceId: t.id })).toBe(0);
    expect(await LegalAcceptance.countDocuments({ userId: staff.userId, workspaceId: t.id })).toBe(0);

    const owner = await loginByEmail(ownerEmail);
    const ownerStatus = await api('get', '/api/legal/acceptance-status', owner.body.token);
    expect(ownerStatus.body.requiresDpaAcceptance).toBe(true);
    expect(ownerStatus.body.requiresCombinedAcceptance).toBe(true);
    const accept = await api('post', '/api/legal/accept/dpa', owner.body.token);
    expect(accept.status).toBe(200);
    expect(accept.body.requiresDpaAcceptance).toBe(false);
    // the staff view of the same workspace is still "nothing required", and the DPA row belongs to the customer's owner
    expect((await LegalAcceptance.find({ workspaceId: t.id }).lean()).map((r) => String(r.userId))).toEqual([jwt.decode(owner.body.token).sub]);
  });

  test('log-before-mutate: a failing audit write refuses the enter (no token is handed out)', async () => {
    const t = await makeTenant();
    jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('down'));
    const res = await api('post', `/api/platform/tenants/${t.id}/enter`, staff.token);
    expect(res.status).toBe(500);
    expect(res.body.token).toBeUndefined();
    expect(await auditRows(t.id, 'enter')).toHaveLength(0);
  });
});

// ── 5. a customer's own WhatsApp number ─────────────────────────────────────

describe('PUT /tenants/:id/whatsapp', () => {
  test('saves the number with its token: encrypted at rest, never returned, verified through the stub, audited, sender cache cleared', async () => {
    const t = await makeTenant();
    const phoneId = nextPhoneId();
    const res = await put(t.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.whatsapp).toMatchObject({
      mode: 'own', phoneIdLast4: phoneId.slice(-4), wabaId: '777888999000', displayPhoneNumber: '+966 50 123 4567', verifiedName: 'MegaSun Test',
      tokenConfigured: true, tokenIsValid: true, enabled: true,
    });
    expect(res.body.whatsapp.checkedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(phoneId); // only the last four digits are ever echoed

    expect(metaStub).toHaveBeenCalledTimes(1);
    expect(metaStub).toHaveBeenCalledWith({ phoneId, wabaId: '777888999000', token: SECRET_TOKEN });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(String(invalidateSpy.mock.calls[0][0])).toBe(t.id);

    const raw = await rawWorkspace(t.id);
    expect(raw.whatsapp.phoneId).toBe(phoneId);
    expect(raw.whatsapp.token).toBeUndefined(); // the legacy plaintext field is never written
    expect(raw.whatsapp.tokenEncrypted).toMatch(/^v1:/);
    expect(raw.whatsapp.tokenEncrypted).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(raw)).not.toContain(SECRET_TOKEN);
    expect(raw.whatsapp.tokenKeyVersion).toBe(tokenVault.keyVersion());
    expect(tokenVault.decrypt(raw.whatsapp.tokenEncrypted, { workspaceId: t.id, purpose: 'token' })).toBe(SECRET_TOKEN);
    // the ciphertext is bound to THIS customer: it cannot be read as another one's
    expect(() => tokenVault.decrypt(raw.whatsapp.tokenEncrypted, { workspaceId: String(new mongoose.Types.ObjectId()), purpose: 'token' })).toThrow();

    const [row] = await auditRows(t.id, 'set_whatsapp');
    expect(row.detail).toMatchObject({ phoneIdLast4: phoneId.slice(-4), wabaId: '777888999000', tokenProvided: true, verified: true, previousMode: 'platform' });
    expect(JSON.stringify(row)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(row)).not.toContain(phoneId);

    // no read endpoint ever shows the token or the full phone number id
    const texts = [
      (await api('get', `/api/platform/tenants/${t.id}`, staff.token)).text,
      (await api('get', '/api/platform/tenants', staff.token)).text,
      (await api('get', `/api/platform/audit?tenantId=${t.id}`, staff.token)).text,
    ];
    for (const text of texts) { expect(text).not.toContain(SECRET_TOKEN); expect(text).not.toContain(raw.whatsapp.tokenEncrypted); expect(text).not.toContain(phoneId); }
  });

  test('saving again without a token keeps the saved one (and tests with it); a new token replaces it', async () => {
    const t = await makeTenant();
    const phoneId = nextPhoneId();
    await put(t.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN });
    const before = (await rawWorkspace(t.id)).whatsapp.tokenEncrypted;
    metaStub.mockClear();
    const res = await put(t.id, { phoneId, wabaId: '777888999000' });
    expect(res.status).toBe(200);
    expect(res.body.whatsapp.tokenConfigured).toBe(true);
    expect(metaStub).toHaveBeenCalledWith({ phoneId, wabaId: '777888999000', token: SECRET_TOKEN }); // the decrypted saved token was tested
    expect((await rawWorkspace(t.id)).whatsapp.tokenEncrypted).toBe(before);
    const replacement = `${SECRET_TOKEN}-second`;
    await put(t.id, { phoneId, wabaId: '777888999000', accessToken: replacement });
    const after = (await rawWorkspace(t.id)).whatsapp.tokenEncrypted;
    expect(after).not.toBe(before);
    expect(tokenVault.decrypt(after, { workspaceId: t.id, purpose: 'token' })).toBe(replacement);
  });

  test('a phone number id can belong to one customer only (409, nothing changes), and the platform number cannot be claimed', async () => {
    const a = await makeTenant();
    const b = await makeTenant();
    const phoneId = nextPhoneId();
    expect((await put(a.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(200);
    metaStub.mockClear();
    const clash = await put(b.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('PHONE_ID_IN_USE');
    expect(metaStub).not.toHaveBeenCalled();
    expect((await rawWorkspace(b.id)).whatsapp?.phoneId).toBeUndefined();
    expect(await auditRows(b.id, 'set_whatsapp')).toHaveLength(0);
    // saving the SAME number on the SAME customer again is fine
    expect((await put(a.id, { phoneId, wabaId: '777888999000' })).status).toBe(200);
    const platform = await put(b.id, { phoneId: PLATFORM_PHONE_ID });
    expect(platform.status).toBe(409);
    expect(platform.body.code).toBe('PLATFORM_NUMBER');
    expect((await rawWorkspace(b.id)).whatsapp?.phoneId).toBeUndefined();
  });

  test('without the encryption key a token cannot be saved: 503 ENCRYPTION_NOT_CONFIGURED, nothing stored or audited', async () => {
    const t = await makeTenant();
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    const res = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    const raw = await rawWorkspace(t.id);
    expect(raw.whatsapp?.phoneId).toBeUndefined();
    expect(raw.whatsapp?.tokenEncrypted).toBeUndefined();
    expect(await auditRows(t.id, 'set_whatsapp')).toHaveLength(0);
    expect(metaStub).not.toHaveBeenCalled();
    // an invalid key is the same answer
    process.env.WA_TOKEN_ENCRYPTION_KEY = 'not-a-valid-key';
    expect((await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(503);
    // a number inside the platform account needs no token, so it still works without a key
    delete process.env.WA_TOKEN_ENCRYPTION_KEY;
    expect((await put(t.id, { phoneId: nextPhoneId() })).status).toBe(200);
  });

  test('a token Meta calls invalid is refused (422 TOKEN_INVALID): nothing saved, nothing audited, no sender cache change', async () => {
    const t = await makeTenant();
    metaStub.mockResolvedValue({ phoneOk: false, tokenIsValid: false, error: 'Error validating access token' });
    const res = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TOKEN_INVALID');
    expect(res.body.error).toMatch(/Nothing was saved/);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    expect((await rawWorkspace(t.id)).whatsapp?.phoneId).toBeUndefined();
    expect(await auditRows(t.id, 'set_whatsapp')).toHaveLength(0);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test('other refusals: unknown phone number id, account mismatch, a foreign account without a token, Meta unreachable', async () => {
    const t = await makeTenant();
    metaStub.mockResolvedValue({ phoneOk: false, tokenIsValid: true, error: 'Unsupported get request' });
    const notFound = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect([notFound.status, notFound.body.code]).toEqual([422, 'PHONE_NOT_FOUND']);
    expect(notFound.body.detail).toBe('Unsupported get request');

    metaStub.mockResolvedValue({ phoneOk: true, tokenIsValid: true, wabaId: '111222333444' });
    const mismatch = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect([mismatch.status, mismatch.body.code]).toEqual([422, 'WABA_MISMATCH']);

    metaStub.mockResolvedValue({ phoneOk: true, tokenIsValid: true, wabaId: '111222333444' }); // no token + platform token, but the number is in another account
    const needsToken = await put(t.id, { phoneId: nextPhoneId() });
    expect([needsToken.status, needsToken.body.code]).toEqual([422, 'NEEDS_TOKEN']);

    metaStub.mockClear();
    const required = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000' }); // a foreign WABA with no token at all
    expect([required.status, required.body.code]).toEqual([400, 'TOKEN_REQUIRED']);
    expect(metaStub).not.toHaveBeenCalled();

    metaStub.mockRejectedValue(new Error('getaddrinfo ENOTFOUND graph.facebook.com'));
    const down = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect([down.status, down.body.code]).toEqual([502, 'VERIFY_UNAVAILABLE']);
    expect(JSON.stringify(down.body)).not.toContain('ENOTFOUND');

    expect((await rawWorkspace(t.id)).whatsapp?.phoneId).toBeUndefined();
    expect(await auditRows(t.id, 'set_whatsapp')).toHaveLength(0);
  });

  test('a number added inside the platform WABA needs only the phone id: it shares the platform token', async () => {
    const t = await makeTenant();
    const phoneId = nextPhoneId();
    const res = await put(t.id, { phoneId });
    expect(res.status).toBe(200);
    expect(metaStub).toHaveBeenCalledWith({ phoneId, wabaId: null, token: undefined }); // undefined token = the platform token
    expect(res.body.whatsapp).toMatchObject({ mode: 'own', tokenConfigured: false, tokenIsValid: true, wabaId: PLATFORM_WABA });
    expect((await rawWorkspace(t.id)).whatsapp.tokenEncrypted).toBeUndefined();
    // naming the platform WABA explicitly (no token) is the same thing
    const t2 = await makeTenant();
    const res2 = await put(t2.id, { phoneId: nextPhoneId(), wabaId: PLATFORM_WABA });
    expect(res2.status).toBe(200);
    expect(res2.body.whatsapp.tokenConfigured).toBe(false);
  });

  test('verify:false saves without calling Meta and records nothing about validity', async () => {
    const t = await makeTenant();
    const res = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN, verify: false });
    expect(res.status).toBe(200);
    expect(metaStub).not.toHaveBeenCalled();
    expect(res.body.whatsapp).toMatchObject({ mode: 'own', tokenConfigured: true, tokenIsValid: null, checkedAt: null, displayPhoneNumber: null });
    const [row] = await auditRows(t.id, 'set_whatsapp');
    expect(row.detail.verified).toBe(false);
  });

  test('input validation: bad ids, bad tokens and non-object bodies are 400 and change nothing', async () => {
    const t = await makeTenant();
    const good = { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN };
    const bad = [
      undefined, {}, { ...good, phoneId: undefined }, { ...good, phoneId: 'abc' }, { ...good, phoneId: '123' }, { ...good, phoneId: '1'.repeat(26) },
      { ...good, phoneId: { $ne: '' } }, { ...good, phoneId: '123 456 789' }, { ...good, wabaId: 'waba' }, { ...good, accessToken: 'short' },
      { ...good, accessToken: `${SECRET_TOKEN} with spaces` }, { ...good, accessToken: `${SECRET_TOKEN}\nX-Injected: 1` }, { ...good, accessToken: 'x'.repeat(2001) },
      { ...good, accessToken: 12345678901234 }, { ...good, accessToken: ['a'.repeat(30)] },
    ];
    for (const [i, body] of bad.entries()) {
      const res = await put(t.id, body);
      expect([i, res.status]).toEqual([i, 400]);
    }
    expect((await rawWorkspace(t.id)).whatsapp?.phoneId).toBeUndefined();
    expect(await auditRows(t.id, 'set_whatsapp')).toHaveLength(0);
    expect(metaStub).not.toHaveBeenCalled();
  });

  test('log-before-mutate: a failing audit write leaves the customer untouched', async () => {
    const t = await makeTenant();
    jest.spyOn(PlatformAuditLog, 'create').mockRejectedValueOnce(new Error('down'));
    const res = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect(res.status).toBe(500);
    const raw = await rawWorkspace(t.id);
    expect(raw.whatsapp?.phoneId).toBeUndefined();
    expect(raw.whatsapp?.tokenEncrypted).toBeUndefined();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('POST /tenants/:id/whatsapp/verify and DELETE /tenants/:id/whatsapp', () => {
  async function tenantWithNumber() {
    const t = await makeTenant();
    const phoneId = nextPhoneId();
    expect((await put(t.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(200);
    metaStub.mockClear();
    invalidateSpy.mockClear();
    return { t, phoneId };
  }

  test('verify tests with the saved (decrypted) token, refreshes the record and audits', async () => {
    const { t, phoneId } = await tenantWithNumber();
    metaStub.mockResolvedValue({ phoneOk: true, tokenIsValid: true, displayPhoneNumber: '+966 55 999 0000', verifiedName: 'Renamed Biz', wabaId: '777888999000' });
    const res = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect(res.status).toBe(200);
    expect(metaStub).toHaveBeenCalledWith({ phoneId, wabaId: '777888999000', token: SECRET_TOKEN });
    expect(res.body.whatsapp).toMatchObject({ mode: 'own', tokenIsValid: true, displayPhoneNumber: '+966 55 999 0000', verifiedName: 'Renamed Biz', tokenConfigured: true });
    expect(res.body.message).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    const [row] = await auditRows(t.id, 'verify_whatsapp');
    expect(row.detail).toMatchObject({ tokenIsValid: true, reason: null });
  });

  test('a token that has gone bad is RECORDED as invalid (so the sender fails closed) and reported, not hidden', async () => {
    const { t } = await tenantWithNumber();
    metaStub.mockResolvedValue({ phoneOk: false, tokenIsValid: false, error: 'expired' });
    const res = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect(res.status).toBe(200);
    expect(res.body.whatsapp.tokenIsValid).toBe(false);
    expect(res.body.message).toMatch(/not valid or has expired/);
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(false);
    expect(res.body.whatsapp.tokenConfigured).toBe(true);
    const [row] = await auditRows(t.id, 'verify_whatsapp');
    expect(row.detail).toMatchObject({ tokenIsValid: false, reason: 'TOKEN_INVALID' });
  });

  test('a finding that is NOT about the token (number not found, other account) is reported but does not switch the customer\'s sending off', async () => {
    const { t } = await tenantWithNumber();
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(true);
    metaStub.mockResolvedValue({ phoneOk: false, tokenIsValid: null, error: 'Unsupported get request' });
    const notFound = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect(notFound.status).toBe(200);
    expect(notFound.body.message).toMatch(/could not find that phone number id/);
    expect(notFound.body.whatsapp.tokenIsValid).toBe(true); // what was recorded before stays
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(true);
    expect((await rawWorkspace(t.id)).whatsapp.tokenCheckedAt).toBeTruthy();
    metaStub.mockResolvedValue({ phoneOk: true, tokenIsValid: true, wabaId: '111222333444' }); // the number is in another account than the one on file
    const mismatch = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect(mismatch.body.message).toMatch(/different WhatsApp business account/);
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(true);
    const rows = await auditRows(t.id, 'verify_whatsapp');
    expect(rows.map((r) => r.detail.reason).sort()).toEqual(['PHONE_NOT_FOUND', 'WABA_MISMATCH']);
  });

  test('verify when Meta is unreachable: 502 and the recorded status is left as it was', async () => {
    const { t } = await tenantWithNumber();
    metaStub.mockRejectedValue(new Error('socket hang up'));
    const res = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect(res.status).toBe(502);
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(true);
    expect(await auditRows(t.id, 'verify_whatsapp')).toHaveLength(0);
  });

  test('Meta answering "busy, try later" is NOT a verdict: 502, the recorded status is left as it was (a transient error must never switch a customer\'s sending off), nothing audited', async () => {
    const { t } = await tenantWithNumber();
    expect((await rawWorkspace(t.id)).whatsapp.tokenIsValid).toBe(true);
    metaStub.mockResolvedValue({ phoneOk: false, tokenIsValid: null, transient: true, error: 'Service temporarily unavailable' });
    const res = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect([res.status, res.body.code]).toEqual([502, 'VERIFY_UNAVAILABLE']);
    expect(res.body.error).toMatch(/Nothing was changed/);
    const raw = await rawWorkspace(t.id);
    expect(raw.whatsapp.tokenIsValid).toBe(true);
    expect(await auditRows(t.id, 'verify_whatsapp')).toHaveLength(0);
    // the same answer while saving a new number: refused as "could not check", nothing saved, nothing audited
    const before = raw.whatsapp.phoneId;
    const saved = await put(t.id, { phoneId: nextPhoneId(), wabaId: '777888999000', accessToken: SECRET_TOKEN });
    expect([saved.status, saved.body.code]).toEqual([502, 'VERIFY_UNAVAILABLE']);
    expect((await rawWorkspace(t.id)).whatsapp.phoneId).toBe(before);
  });

  test('verify on a customer that uses the platform number is a 409; an unreadable saved token is a 409 TOKEN_UNREADABLE', async () => {
    const plain = await makeTenant();
    const res = await api('post', `/api/platform/tenants/${plain.id}/whatsapp/verify`, staff.token);
    expect([res.status, res.body.code]).toEqual([409, 'PLATFORM_MODE']);
    const { t } = await tenantWithNumber();
    await mongoose.connection.collection('workspaces').updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { 'whatsapp.tokenEncrypted': 'v1:AAAA.BBBB.CCCC' } });
    const broken = await api('post', `/api/platform/tenants/${t.id}/whatsapp/verify`, staff.token);
    expect([broken.status, broken.body.code]).toEqual([409, 'TOKEN_UNREADABLE']);
    expect(metaStub).not.toHaveBeenCalled();
  });

  test('DELETE returns the customer to the platform number, removes the stored token, audits, clears the cache, and is idempotent', async () => {
    const { t, phoneId } = await tenantWithNumber();
    await mongoose.connection.collection('workspaces').updateOne({ _id: new mongoose.Types.ObjectId(t.id) }, { $set: { 'whatsapp.token': 'legacy-plaintext-left-alone' } });
    const res = await api('delete', `/api/platform/tenants/${t.id}/whatsapp`, staff.token);
    expect(res.status).toBe(200);
    expect(res.body.whatsapp).toEqual({
      mode: 'platform', phoneIdLast4: null, wabaId: null, displayPhoneNumber: null, verifiedName: null,
      tokenConfigured: false, tokenIsValid: null, checkedAt: null, enabled: true,
    });
    const raw = await rawWorkspace(t.id);
    for (const k of ['phoneId', 'wabaId', 'tokenEncrypted', 'tokenKeyVersion', 'displayPhoneNumber', 'verifiedName', 'tokenIsValid', 'tokenCheckedAt', 'enabled']) expect(raw.whatsapp[k]).toBeUndefined();
    expect(raw.whatsapp.token).toBe('legacy-plaintext-left-alone'); // not this code's field
    expect(invalidateSpy).toHaveBeenCalled();
    const [row] = await auditRows(t.id, 'clear_whatsapp');
    expect(row.detail).toMatchObject({ hadOwnNumber: true, hadToken: true });
    const again = await api('delete', `/api/platform/tenants/${t.id}/whatsapp`, staff.token);
    expect(again.status).toBe(200);
    expect(again.body.whatsapp.mode).toBe('platform');
    expect((await auditRows(t.id, 'clear_whatsapp'))[1].detail.hadOwnNumber).toBe(false);
    // the number can now be used by another customer
    const other = await makeTenant();
    expect((await put(other.id, { phoneId, wabaId: '777888999000', accessToken: SECRET_TOKEN })).status).toBe(200);
  });
});

// ── 6. closed sign-up ───────────────────────────────────────────────────────

describe('ALLOW_SELF_SERVE_SIGNUP=false', () => {
  beforeEach(() => { process.env.ALLOW_SELF_SERVE_SIGNUP = 'false'; });

  test('a stranger (no membership, no invite) is refused with 403 and gets no workspace', async () => {
    const email = nextEmail('stranger');
    const first = await loginByEmail(email);
    expect(first.status).toBe(403);
    expect(first.body).toEqual({ error: 'Ask your administrator to invite you.' });
    expect(first.body.token).toBeUndefined();
    const user = await User.findOne({ email }).lean();
    expect(await Membership.countDocuments({ userId: user._id })).toBe(0);
    expect(await Workspace.countDocuments({ name: new RegExp(email.split('@')[0]) })).toBe(0);
    expect((await loginByEmail(email)).status).toBe(403); // and again
    const phone = await loginByPhone(fx.nextPhone());
    expect(phone.status).toBe(403);
  });

  test('a super admin with no membership still gets a workspace (and the sa claim)', async () => {
    const res = await loginByEmail(STAFF2_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.superAdmin).toBe(true);
    expect(res.body.workspace.id).toBeTruthy();
    expect(jwt.decode(res.body.token).sa).toBe(true);
  });

  test('an owner created by a super admin signs in fine, and so does someone with a pending invite', async () => {
    const ownerEmail = nextEmail('closed');
    const t = await makeTenant({ ownerContact: ownerEmail });
    const owner = await loginByEmail(ownerEmail);
    expect(owner.status).toBe(200);
    expect(owner.body.workspace.id).toBe(t.id);

    const inviteeEmail = nextEmail('invitee');
    await Invite.create({ workspaceId: t.id, invitedByUserId: t.res.owner.userId, contactType: 'email', contact: inviteeEmail, role: 'member', expiresAt: new Date(Date.now() + 3600 * 1000) });
    const invitee = await loginByEmail(inviteeEmail);
    expect(invitee.status).toBe(200);
    expect(invitee.body).toMatchObject({ role: 'member', superAdmin: false });
    expect(invitee.body.workspace.id).toBe(t.id);
  });

  test('turned back on (unset / true), a stranger gets their own workspace as before', async () => {
    for (const v of [undefined, 'true', '']) {
      if (v === undefined) delete process.env.ALLOW_SELF_SERVE_SIGNUP; else process.env.ALLOW_SELF_SERVE_SIGNUP = v;
      const res = await loginByEmail(nextEmail('open'));
      expect(res.status).toBe(200);
      expect(res.body.role).toBe('owner');
      expect(res.body.workspace.onboarding.completed).toBe(false);
    }
  });
});

// ── 7. cross-customer isolation and the token hole ──────────────────────────

describe('isolation', () => {
  test('a customer owner\'s ordinary token cannot reach the platform area, and one customer cannot read another\'s data', async () => {
    const a = await fx.makeWorkspace({ arabic: false });
    const b = await fx.makeWorkspace({ arabic: false });
    const product = await Product.create({ workspaceId: a.workspaceId, name: 'A-only', category: 'Misc', basePrice: 1 });
    expect((await api('get', '/api/platform/tenants', a.token)).status).toBe(403);
    expect((await api('post', `/api/platform/tenants/${b.workspaceId}/enter`, a.token)).status).toBe(403);
    expect((await api('get', '/api/products', a.token)).body.products.map((p) => p.name)).toEqual(['A-only']);
    expect((await api('get', '/api/products', b.token)).body.products).toEqual([]);
    expect((await api('get', `/api/products/${product._id}`, b.token)).status).toBe(404);
  });

  test('the 10-minute workspace-picker (pre-auth) token is refused by every /api route, but still works for select-workspace', async () => {
    const ownerEmail = nextEmail('picker');
    const a = await makeTenant({ ownerContact: ownerEmail });
    const b = await makeTenant({ ownerContact: ownerEmail });
    const login = await loginByEmail(ownerEmail);
    expect(login.body.chooseWorkspace).toBe(true);
    expect(login.body.superAdmin).toBe(false);
    const pre = login.body.preAuthToken;
    for (const path of ['/api/products', '/api/legal/acceptance-status', '/api/auth/me', '/api/platform/tenants', '/api/platform/audit']) {
      const res = await api('get', path, pre);
      expect([path, res.status]).toEqual([path, 401]);
    }
    expect((await api('post', '/api/platform/exit', pre)).status).toBe(401);
    const picked = await request(app).post('/api/auth/select-workspace').send({ preAuthToken: pre, workspaceId: b.id });
    expect(picked.status).toBe(200);
    expect(picked.body.workspace.id).toBe(b.id);
    expect(picked.body.superAdmin).toBe(false);
    expect((await api('get', '/api/products', picked.body.token)).status).toBe(200);
    expect(a.id).not.toBe(b.id);
  });

  test('a super admin who belongs to two customers gets superAdmin + the sa claim through the picker too', async () => {
    const home = await loginByEmail(STAFF2_EMAIL);
    expect(home.status).toBe(200);
    const t = await makeTenant();
    expect((await api('post', `/api/platform/tenants/${t.id}/members`, staff.token, { contactType: 'email', contact: STAFF2_EMAIL, role: 'member' })).status).toBe(201);
    const login = await loginByEmail(STAFF2_EMAIL);
    expect(login.body.chooseWorkspace).toBe(true);
    expect(login.body.superAdmin).toBe(true);
    const picked = await request(app).post('/api/auth/select-workspace').send({ preAuthToken: login.body.preAuthToken, workspaceId: t.id });
    expect(picked.status).toBe(200);
    expect(picked.body.superAdmin).toBe(true);
    expect(jwt.decode(picked.body.token).sa).toBe(true);
    expect((await api('get', '/api/platform/tenants', picked.body.token)).status).toBe(200);
  });

  test('tokens without a usable workspace id are rejected on every route', async () => {
    const sign = (claims) => jwt.sign(claims, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE });
    const user = String(new mongoose.Types.ObjectId());
    for (const claims of [{ sub: user, role: 'owner' }, { sub: user, workspaceId: 'nope', role: 'owner' }, { sub: user, workspaceId: null, role: 'owner' }, { sub: user, workspaceId: { $ne: null }, role: 'owner' }]) {
      for (const path of ['/api/products', '/api/legal/acceptance-status', '/api/auth/me']) {
        expect([path, (await api('get', path, sign(claims))).status]).toEqual([path, 401]);
      }
    }
  });

});

// ── 8. the staff admin pages escape what customers (and WhatsApp users) type ─

describe('routes/internalAdmin.js escapes every value', () => {
  const evil = '<script>alert(1)</script>';
  const quote = '"><img src=x onerror=alert(2)>';

  test('search results and the customer page show markup as text, never as markup', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    await Workspace.updateOne({ _id: ws.workspaceId }, { $set: { name: `<b>Bold ${TAG}</b>` } });
    const phone = fx.nextPhone();
    const customer = await Customer.create({
      workspaceId: ws.workspaceId, firstname: evil, lastname: "O'Brien & <i>Sons</i>", phone, email: `x${TAG}@example.test`, address: quote, marketingConsent: true,
    });
    const search = await request(app).get('/internal-admin/customers').query({ q: phone });
    expect(search.status).toBe(200);
    expect(search.text).not.toContain('<script>');
    expect(search.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(search.text).toContain('O&#39;Brien &amp; &lt;i&gt;Sons&lt;/i&gt;');
    expect(search.text).toContain(`&lt;b&gt;Bold ${TAG}&lt;/b&gt;`);
    expect(search.text).not.toContain('<b>Bold');

    const view = await request(app).get(`/internal-admin/customers/${customer._id}`);
    expect(view.status).toBe(200);
    expect(view.text).not.toContain('<script>');
    expect(view.text).not.toContain('<img src=x');
    expect(view.text).toContain('&lt;script&gt;');
    expect(view.text).toContain('&quot;&gt;&lt;img src=x onerror=alert(2)&gt;'); // the value="..." attribute cannot be broken out of
    expect(view.text).not.toMatch(/value="[^"]*"><img/);
    // the title and heading are escaped too
    expect(view.text).toMatch(/<title>&lt;script&gt;/);
    expect(view.text).toMatch(/<h1>&lt;script&gt;/);
  });

  test('the search term itself is echoed escaped', async () => {
    const res = await request(app).get('/internal-admin/customers').query({ q: `${evil}@x.com` });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>');
    expect(res.text).toContain('&lt;script&gt;');
  });

  test('ordinary names still read normally', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const phone = fx.nextPhone();
    await Customer.create({ workspaceId: ws.workspaceId, firstname: 'Search', lastname: 'Target', phone, marketingConsent: true });
    const res = await request(app).get('/internal-admin/customers').query({ q: phone });
    expect(res.text).toContain('Search Target');
  });
});

// ── 8b. the default Graph check (what runs in production), against a stubbed adapter ──────────────────────

describe('default metaCheck (read-only Graph GETs)', () => {
  const { defaultMetaCheck } = require('../../../routes/platform');
  const tokenManager = require('../../../utils/tokenManager');
  let calls;
  let script; // (call) => { status, data } | Error
  let previousAdapter;
  beforeEach(() => {
    calls = [];
    script = () => ({ status: 200, data: {} });
    previousAdapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => {
      const call = { method: String(config.method).toUpperCase(), url: String(config.url), params: config.params, headers: config.headers && config.headers.toJSON ? config.headers.toJSON() : config.headers };
      calls.push(call);
      const out = script(call, calls.length);
      if (out instanceof Error) throw out;
      return { data: out.data, status: out.status, statusText: '', headers: {}, config, request: {} };
    };
  });
  afterEach(() => { axios.defaults.adapter = previousAdapter; delete process.env.WA_APP_ID; delete process.env.WA_APP_SECRET; });

  test('with a token: GETs the phone number with the token in the Authorization header, then debug_token with the app credentials', async () => {
    process.env.WA_APP_ID = 'app-id-1'; process.env.WA_APP_SECRET = 'app-secret-1';
    script = (call) => (/debug_token/.test(call.url)
      ? { status: 200, data: { data: { is_valid: true, expires_at: 0 } } }
      : { status: 200, data: { display_phone_number: '+966 50 111 2222', verified_name: 'MegaSun', whatsapp_business_account: { id: '123456789012' } } });
    const out = await defaultMetaCheck({ phoneId: '999888777666', wabaId: null, token: SECRET_TOKEN });
    expect(out).toEqual({ phoneOk: true, tokenIsValid: true, displayPhoneNumber: '+966 50 111 2222', verifiedName: 'MegaSun', wabaId: '123456789012' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET']);
    expect(calls[0].url).toMatch(/^https:\/\/graph\.facebook\.com\/v[\d.]+\/999888777666$/);
    expect(calls[0].params).toEqual({ fields: 'display_phone_number,verified_name,whatsapp_business_account' });
    expect(calls[0].headers.Authorization).toBe('Bearer ' + SECRET_TOKEN);
    expect(JSON.stringify(calls[0].params) + calls[0].url).not.toContain(SECRET_TOKEN); // never in the URL of the phone-number call
    expect(calls[1].url).toBe('https://graph.facebook.com/debug_token');
    expect(calls[1].params).toEqual({ input_token: SECRET_TOKEN, access_token: 'app-id-1|app-secret-1' });
  });

  test('an expired token is reported as invalid with a message that carries no secret', async () => {
    process.env.WA_APP_ID = 'app-id-1'; process.env.WA_APP_SECRET = 'app-secret-1';
    script = (call) => (/debug_token/.test(call.url)
      ? { status: 200, data: { data: { is_valid: false } } }
      : { status: 400, data: { error: { message: 'Error validating access token: ' + SECRET_TOKEN + ' has expired', code: 190, type: 'OAuthException' } } });
    const out = await defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN });
    expect(out.phoneOk).toBe(false);
    expect(out.tokenIsValid).toBe(false);
    expect(out.error).toContain('has expired');
    expect(out.error).not.toContain(SECRET_TOKEN);
  });

  test('without app credentials only the phone-number call is made (validity stays unknown unless Meta says 190)', async () => {
    script = () => ({ status: 200, data: { display_phone_number: '+966 50 111 2222' } });
    const out = await defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN });
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({ phoneOk: true, tokenIsValid: null, wabaId: null, verifiedName: null });
    script = () => ({ status: 400, data: { error: { message: 'Unsupported get request', code: 100 } } });
    calls.length = 0;
    const missing = await defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN });
    expect(calls).toHaveLength(2); // code 100 on the first fields list: retried once with the core fields only
    expect(calls[1].params).toEqual({ fields: 'display_phone_number,verified_name' });
    expect(missing).toMatchObject({ phoneOk: false, tokenIsValid: null });
  });

  test('no token given means the platform token; none available at all is a plain refusal, not a crash', async () => {
    jest.spyOn(tokenManager, 'getToken').mockReturnValue('platform-token-value-0000');
    script = () => ({ status: 200, data: { display_phone_number: '+1 555 000 0000' } });
    const out = await defaultMetaCheck({ phoneId: '999888777666', token: undefined });
    expect(out.phoneOk).toBe(true);
    expect(calls[0].headers.Authorization).toBe('Bearer platform-token-value-0000');
    expect(calls).toHaveLength(1); // the platform token is not re-tested with debug_token here
    calls.length = 0;
    tokenManager.getToken.mockReturnValue('');
    const none = await defaultMetaCheck({ phoneId: '999888777666', token: undefined });
    expect(none.phoneOk).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('Graph saying "busy / try later" is flagged transient (and is not read as a bad token or a missing number); real verdicts are not', async () => {
    const answer = async (status, error) => {
      script = () => ({ status, data: { error } });
      return defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN });
    };
    for (const [status, error] of [
      [503, { message: 'Service Unavailable' }], [500, undefined], [502, { message: 'Bad gateway' }], [429, { message: 'Too many requests' }],
      [400, { message: 'An unknown error occurred', code: 1 }], [500, { message: 'Temporary', code: 2 }],
      [400, { message: 'Application request limit reached', code: 4 }], [400, { message: 'User request limit reached', code: 17 }],
      [400, { message: 'Calls to this api have exceeded the rate limit', code: 80007 }], [400, { message: 'Try later', code: 99999, is_transient: true }],
    ]) {
      const out = await answer(status, error);
      expect([status, error && error.code, out.transient, out.phoneOk, out.tokenIsValid]).toEqual([status, error && error.code, true, false, null]);
    }
    for (const [status, error] of [
      [400, { message: 'Unsupported get request', code: 100 }], [404, { message: 'Unknown path components', code: 803 }], [403, { message: 'Permissions error', code: 10 }],
    ]) {
      const out = await answer(status, error);
      expect([status, out.transient, out.phoneOk]).toEqual([status, undefined, false]);
    }
    const expired = await answer(400, { message: 'Error validating access token', code: 190 });
    expect([expired.transient, expired.tokenIsValid]).toEqual([undefined, false]);
  });

  test('a network failure on the phone-number call is thrown (the route turns it into 502); one on debug_token is ignored', async () => {
    script = () => new Error('connect ECONNREFUSED');
    await expect(defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN })).rejects.toThrow('ECONNREFUSED');
    process.env.WA_APP_ID = 'app-id-1'; process.env.WA_APP_SECRET = 'app-secret-1';
    script = (call) => (/debug_token/.test(call.url) ? new Error('timeout') : { status: 200, data: { display_phone_number: '+1 555 000 0000' } });
    const out = await defaultMetaCheck({ phoneId: '999888777666', token: SECRET_TOKEN });
    expect(out).toMatchObject({ phoneOk: true, tokenIsValid: null });
  });
});

// ── 9. last: nothing above used the network ─────────────────────────────────

test('the whole suite never touched the network', () => {
  expect(networkCalls).toBe(0);
});
