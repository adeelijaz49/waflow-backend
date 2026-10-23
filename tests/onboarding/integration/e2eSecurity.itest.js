'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2esec`;
assertThrowawayDb();

// END TO END security spot checks (task I1b) over the WHOLE flow, against the real server.js:
//  1. no token / authorization code / PIN / full phone number in console output, e-mail, HTTP bodies, events, notifications
//  2. encryption at rest verified from the RAW documents (right AAD only, default queries never select them)
//  3. tenant isolation across the FULL route list (workspace B cannot read or change workspace A)
//  4. owner-only routes follow the LIVE membership, never the (possibly stale or forged) JWT role
const crypto = require('crypto');
const { createWorld, spyConsole, allRoutes } = require('./_e2eWorld');

jest.setTimeout(120000);

let w;
let con;
const stateOf = async (u) => (await w.get(u, '/state')).body;
const digits = (v) => String(v).replace(/\D/g, '');
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;

beforeAll(async () => { w = await createWorld({ policy: 'platform_number' }); con = spyConsole(); });
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('1+2) one tenant goes through everything: no secret ever leaves, the token is encrypted at rest', () => {
  let t;
  let ctx;
  let pin;
  let testPhone;
  let owned;

  beforeAll(async () => {
    t = await w.tenant('Secure', { activate: false });
    await w.payViaStripe(t);
    ctx = await w.prepareConnect(t, { phoneStatus: 'PENDING', displayNumber: '+966 55 844 7788' }); // PENDING: the register call (and its PIN) happens
    const done = await w.complete(t, ctx);
    expect(done.status).toBe(200);
    pin = String(ctx.graph.state.phones[0].pin);
    expect(pin).toMatch(/^\d{6}$/);
    await w.get(t.owner, '/approvals');
    for (let i = 0; i < 3; i += 1) await require('../../../shared/onboarding/starterTemplates').submitPending({ workspaceId: t.ws });
    ctx.graph.approveAllTemplates();
    for (const tpl of ctx.graph.templates().filter((x) => x.language === 'en')) await w.deliverMeta(ctx.graph.webhook.templateStatus(tpl.name, 'en', 'APPROVED'));
    testPhone = t.owner.phone; // the test message goes to the requester's OWN login phone (review R2-03): nobody else's number can be typed
    expect((await w.post(t.owner, '/test-message', {})).status).toBe(200);
    await w.post(t.owner, '/number/support-request', { message: 'please help' });
    await w.post(t.owner, '/connection/refresh', {});
    await w.get(t.owner, '/templates');
    await w.get(t.owner, '/first-promotion');
    await w.get(t.owner, '/notifications');
    await w.get(t.owner, '/help-context');
    await w.post(t.owner, '/billing-portal', {});
    await w.post(t.owner, '/display-name', { newName: 'Secure Shop Official' });
    await w.deliverMeta(ctx.graph.webhook.envelope('phone_number_name_update', { decision: 'APPROVED', requested_verified_name: 'Secure Shop Official' }, ctx.graph.ids.wabaId));
    // a Graph failure on the way (its error text must not echo the token either)
    ctx.graph.scenarios.permissionMissing(200, { times: 1 });
    await w.post(t.owner, '/templates/submit', {});
    await new Promise((r) => setTimeout(r, 300));
    owned = {
      token: ctx.graph.ids.merchantToken, appSecret: w.handle.env.appSecret, pin, codes: w.usedCodes.slice(),
      jwts: [t.owner.token, t.member.token], loginPhone: t.owner.phone, businessDigits: digits('+966 55 844 7788'), testPhone,
      vaultKey: process.env.WA_TOKEN_ENCRYPTION_KEY, jwtSecret: w.handle.env.jwtSecret, whsec: w.handle.env.stripeWebhookSecret,
    };
  });

  test('console output, e-mail and every HTTP body carry no token, code, PIN, app secret, JWT or key', async () => {
    const consoleText = con.lines.join('\n');
    const mailText = JSON.stringify(w.mail.sent);
    const bodies = w.responses.filter((r) => r.who === t.owner.id || r.who === t.member.id);
    const secrets = { token: owned.token, appSecret: owned.appSecret, vaultKey: owned.vaultKey, jwtSecret: owned.jwtSecret, whsec: owned.whsec, ...Object.fromEntries(owned.codes.map((c, i) => [`code${i}`, c])), ...Object.fromEntries(owned.jwts.map((c, i) => [`jwt${i}`, c])) };
    for (const [name, secret] of Object.entries(secrets)) {
      expect([name, consoleText.includes(secret)]).toEqual([name, false]);
      expect([name, mailText.includes(secret)]).toEqual([name, false]);
      for (const r of bodies) expect([name, r.method, r.path, r.text.includes(secret)]).toEqual([name, r.method, r.path, false]);
    }
    const pinRe = new RegExp(`(^|[^0-9])${owned.pin}([^0-9]|$)`);
    expect(pinRe.test(consoleText)).toBe(false);
    expect(pinRe.test(mailText)).toBe(false);
    for (const r of bodies) expect([r.method, r.path, pinRe.test(r.text)]).toEqual([r.method, r.path, false]);
    expect(consoleText).not.toMatch(/EAA[A-Za-z0-9_]{30,}/); // no Meta-token-shaped string anywhere
    expect(bodies.length).toBeGreaterThan(15);
    expect(w.mail.sent.length).toBeGreaterThan(0);
  });

  test('no full phone number outside the one owner-only field (/state connection.numberFull): not in logs, mails, other bodies', async () => {
    const consoleText = digits(con.lines.join('\n'));
    for (const p of [owned.loginPhone, owned.businessDigits, owned.testPhone]) expect([p, consoleText.includes(p)]).toEqual([p, false]);
    const mailDigits = digits(JSON.stringify(w.mail.sent));
    for (const p of [owned.loginPhone, owned.businessDigits, owned.testPhone]) expect([p, mailDigits.includes(p)]).toEqual([p, false]);
    for (const r of w.responses.filter((x) => x.who === t.owner.id)) {
      const d = digits(r.text.replace(/"numberFull":"[^"]*"/, ''));
      for (const p of [owned.loginPhone, owned.businessDigits, owned.testPhone]) expect([r.method, r.path, p, d.includes(p)]).toEqual([r.method, r.path, p, false]);
    }
    const m = await stateOf(t.member);
    expect(JSON.stringify(m)).not.toContain('numberFull');
    expect(digits(JSON.stringify(m)).includes(owned.businessDigits)).toBe(false);
    ctx.graph.assertNoLeak([owned.token, owned.pin, ...owned.codes.slice(0, 1)], [con.lines, w.mail.sent]);
    ctx.graph.assertMerchantTokenOnly(owned.token);
    ctx.graph.assertNeverUsedToken(w.graph.platformToken);
    ctx.graph.assertNoForeignCalls();
  });

  test('stored events, notifications, support requests, audit rows and every onboarding document hold no secret (RAW collections)', async () => {
    const names = ['OnboardingState', 'OnboardingEvent', 'OnboardingNotification', 'OnboardingSupportRequest', 'OnboardingTemplate', 'OnboardingInbound', 'OnboardingAdminLog', 'WhatsAppClaim'];
    for (const n of names) {
      const docs = await w.M(n).collection.find({}).toArray();
      const text = JSON.stringify(docs);
      for (const s of [owned.token, owned.pin, owned.appSecret, ...owned.codes, ...owned.jwts]) expect([n, text.includes(s)]).toEqual([n, false]);
      for (const p of [owned.loginPhone, owned.testPhone]) expect([n, digits(text).includes(p)]).toEqual([n, false]);
    }
    const conn = await w.M('WhatsAppConnection').collection.findOne({ workspaceId: (await w.connOf(t.ws)).workspaceId });
    const rest = { ...conn }; delete rest.tokenEncrypted; delete rest.pinEncrypted;
    expect(JSON.stringify(rest)).not.toContain(owned.token);
    expect(JSON.stringify(rest)).not.toContain(owned.pin);
    expect(JSON.stringify(rest)).not.toMatch(/AQDe2eCODESECRET/);
  });

  test('encryption at rest: raw token and PIN are v1 envelopes, decrypt only with the right workspace and purpose, never selected by default', async () => {
    const vault = require('../../../shared/onboarding/tokenVault');
    const wsId = (await w.connOf(t.ws)).workspaceId;
    const raw = await w.M('WhatsAppConnection').collection.findOne({ workspaceId: wsId });
    expect(raw.tokenEncrypted).toMatch(/^v1:/);
    expect(raw.pinEncrypted).toMatch(/^v1:/);
    expect(raw.tokenEncrypted).not.toContain(owned.token);
    expect(raw.pinEncrypted).not.toContain(owned.pin);
    expect(raw.tokenEncrypted).not.toBe(raw.pinEncrypted);
    expect(vault.decrypt(raw.tokenEncrypted, { workspaceId: t.ws, purpose: 'token' })).toBe(owned.token);
    expect(vault.decrypt(raw.pinEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toBe(owned.pin);
    expect(() => vault.decrypt(raw.tokenEncrypted, { workspaceId: String(w.oldest), purpose: 'token' })).toThrow();
    expect(() => vault.decrypt(raw.tokenEncrypted, { workspaceId: t.ws, purpose: 'pin' })).toThrow();
    const tampered = `${raw.tokenEncrypted.slice(0, -4)}AAAA`;
    expect(() => vault.decrypt(tampered, { workspaceId: t.ws, purpose: 'token' })).toThrow();
    const plain = await w.M('WhatsAppConnection').findOne({ workspaceId: t.ws }).lean();
    expect(plain.tokenEncrypted).toBeUndefined();
    expect(plain.pinEncrypted).toBeUndefined();
    const withSecrets = await w.M('WhatsAppConnection').findOne({ workspaceId: t.ws }).select('+tokenEncrypted').lean();
    expect(withSecrets.tokenEncrypted).toBe(raw.tokenEncrypted);
    // the same plaintext encrypted twice differs (random IV)
    expect(vault.encrypt(owned.token, { workspaceId: t.ws, purpose: 'token' })).not.toBe(vault.encrypt(owned.token, { workspaceId: t.ws, purpose: 'token' }));
  });

  test('the staff page (Basic auth) shows the workspace without the token, PIN, full number or any secret; unauthenticated = 401', async () => {
    const noAuth = await w.agent.get(`/internal-admin-onboarding/${t.ws}`);
    expect(noAuth.status).toBe(401);
    expect((await w.agent.get(`/internal-admin-onboarding/${t.ws}`).set('Authorization', basic('e2e-admin', 'wrong'))).status).toBe(401);
    const page = await w.agent.get(`/internal-admin-onboarding/${t.ws}`).set('Authorization', basic(w.handle.env.adminUser, w.handle.env.adminPass));
    expect(page.status).toBe(200);
    for (const s of [owned.token, owned.pin, owned.appSecret, owned.vaultKey, ...owned.codes, owned.loginPhone, owned.businessDigits, 'tokenEncrypted', 'pinEncrypted']) expect([s, page.text.includes(s)]).toEqual([s, false]);
    expect(page.text).toMatch(/\*{3,}7788/); // masked number
  });

  test('the Meta callbacks refuse an unsigned or wrongly signed request', async () => {
    for (const p of ['/onboarding-meta/deauthorize', '/onboarding-meta/data-deletion']) {
      const r = await w.agent.post(p).type('form').send({ signed_request: 'not.valid' });
      expect([p, r.status >= 400 && r.status < 500]).toEqual([p, true]);
    }
  });
});

describe('3) tenant isolation across the full route list', () => {
  let A;
  let B;
  let ctxA;
  let docs;
  const snapshotA = async () => {
    const out = {};
    for (const n of ['OnboardingState', 'WhatsAppConnection', 'OnboardingTemplate', 'OnboardingNotification', 'OnboardingSupportRequest']) {
      out[n] = JSON.stringify(await w.M(n).collection.find({ workspaceId: require('mongoose').Types.ObjectId.createFromHexString(A.ws) }).sort({ _id: 1 }).toArray());
    }
    return out;
  };

  beforeAll(async () => {
    A = await w.tenant('Alpha Isolation');
    ctxA = await w.connectTenant(A);
    await w.get(A.owner, '/approvals');
    await w.post(A.owner, '/number/support-request', { message: 'alpha help' });
    await w.post(A.owner, '/prompts/customers', { state: 'skipped' });
    B = await w.tenant('Beta Isolation');
    await w.put(B.owner, '/business', w.BUSINESS(B));
    docs = (await w.get(A.owner, '/notifications')).body.notifications;
  });

  test('the route list found in the source is complete (33 routes), and workspace B calls EVERY one with A\'s ids in body, query and path', async () => {
    const routes = allRoutes();
    expect(routes).toHaveLength(33);
    const before = await snapshotA();
    const aIds = { workspaceId: A.ws, userId: A.owner.id, ids: docs.map((d) => d.id), all: true, state: 'done', newName: 'Hijacked', phone: '966500000001', message: 'forged' };
    const results = [];
    for (const r of routes) {
      const joiner = r.path.includes('?') ? '&' : '?';
      const path = `${r.path}${joiner}workspaceId=${A.ws}&userId=${A.owner.id}`;
      const res = await w.call(B.owner, r.method, path, r.method === 'get' ? undefined : { ...aIds, planCode: 'basic', hasNumber: false, name: 'Hijacked Shop', attemptId: 'a'.repeat(32), event: 'CANCEL', type: 'step_enter', step: 'business', confirmed: true, uiLanguage: 'ar', languages: ['ar'] });
      results.push([r.method, r.path, res.status]);
      expect([r.method, r.path, res.status !== 500 && (res.body || {}).code !== 'INTERNAL_ERROR']).toEqual([r.method, r.path, true]); // 503 service codes (e.g. BILLING_PORTAL_UNAVAILABLE) are fine, a crash is not
      for (const secret of [A.ws, A.owner.id, 'Alpha Isolation', ctxA.graph.ids.wabaId, ctxA.graph.ids.phoneId, ctxA.graph.ids.merchantToken, A.owner.phone, ctxA.graph.state.phones[0].display_phone_number]) {
        expect([r.method, r.path, String(secret), res.text.includes(String(secret))]).toEqual([r.method, r.path, String(secret), false]);
      }
    }
    expect(await snapshotA()).toEqual(before); // nothing of A changed (including updatedAt)
    // B's own body changed B's OWN business (that is its data), never A's
    const sb = await stateOf(B.owner);
    expect(sb.business.name).toBe('Hijacked Shop');
    expect(JSON.stringify(sb)).not.toContain('Alpha Isolation');
    expect(results.some(([, , s]) => s === 200)).toBe(true);
  });

  test('A\'s notifications are untouched by B\'s forged read, A\'s state is A\'s', async () => {
    const mark = await w.post(B.owner, '/notifications/read', { ids: docs.map((d) => d.id) });
    expect(mark.status).toBe(200);
    expect((await w.get(A.owner, '/notifications')).body.notifications.every((n) => n.readAt === null)).toBe(true);
    const sa = await stateOf(A.owner);
    expect(sa.business.name).toBe('Alpha Isolation Shop');
    expect(sa.connection.level).toBe('connected');
  });

  test('a token of workspace B can never reach A through the legacy app routes either (workspace scoping of /api is untouched)', async () => {
    const mine = await w.agent.get('/api/customers').set('Authorization', `Bearer ${B.owner.token}`);
    expect(mine.status).toBe(200);
    await w.M('Customer').create({ workspaceId: A.ws, firstname: 'Only', lastname: 'Alpha', phone: '966555000321' });
    const again = await w.agent.get('/api/customers').set('Authorization', `Bearer ${B.owner.token}`);
    expect(JSON.stringify(again.body)).not.toContain('Only');
  });
});

describe('4) owner-only routes follow the LIVE membership, never the JWT role', () => {
  let t;
  let ctx;
  const OWNER_ROUTES = [
    ['post', '/checkout', { planCode: 'basic' }], ['post', '/billing-portal', {}], ['post', '/connect/complete', { attemptId: 'a'.repeat(32), code: 'x', session: {} }],
    ['post', '/connect/resume', {}], ['post', '/connection/reconnect', {}], ['post', '/connection/disconnect/request', {}],
    ['post', '/connection/disconnect', { confirmationToken: 'x', confirmText: 'DISCONNECT' }], ['post', '/display-name', { newName: 'Some Name' }],
  ];
  beforeAll(async () => { t = await w.tenant('Roles'); ctx = await w.connectTenant(t); });

  test('a MEMBER whose JWT says "owner" (stale or forged) is refused with 403 OWNER_ONLY on every owner-only route', async () => {
    const forged = { ...t.member, token: w.sign({ id: t.member.id, ws: t.ws }, 'owner') };
    for (const [m, p, b] of OWNER_ROUTES) {
      const r = await w.call(forged, m, p, { ...b, role: 'owner' });
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'OWNER_ONLY']);
    }
    // /state: the full number follows the live role as well
    expect(JSON.stringify(await stateOf(forged))).not.toContain('numberFull');
  });

  test('a DEMOTED owner (JWT still "owner") is refused; a PROMOTED member (JWT still "member") is allowed', async () => {
    const stale = { ...t.owner, token: w.sign({ id: t.owner.id, ws: t.ws }, 'owner') };
    expect((await w.post(stale, '/connection/disconnect/request', {})).status).toBe(200);
    await w.M('Membership').updateOne({ userId: t.owner.id, workspaceId: t.ws }, { $set: { role: 'member' } });
    await w.M('Membership').updateOne({ userId: t.member.id, workspaceId: t.ws }, { $set: { role: 'owner' } });
    try {
      for (const [m, p, b] of OWNER_ROUTES) {
        const r = await w.call(stale, m, p, b);
        expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'OWNER_ONLY']);
      }
      expect(JSON.stringify(await stateOf(stale))).not.toContain('numberFull');
      const promoted = { ...t.member, token: w.sign({ id: t.member.id, ws: t.ws }, 'member') };
      expect((await w.post(promoted, '/connection/disconnect/request', {})).status).toBe(200);
      expect(JSON.stringify(await stateOf(promoted))).toContain('numberFull');
    } finally {
      await w.M('Membership').updateOne({ userId: t.owner.id, workspaceId: t.ws }, { $set: { role: 'owner' } });
      await w.M('Membership').updateOne({ userId: t.member.id, workspaceId: t.ws }, { $set: { role: 'member' } });
    }
  });

  test('no token / a garbage token / a pre-auth token never reach the data; the onboarding handlers themselves never answer 401', async () => {
    expect((await w.agent.get('/api/onboarding/state')).status).toBe(401);
    expect((await w.agent.get('/api/onboarding/state').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
    const pre = jwt.sign({ sub: t.owner.id, preAuth: true }, JWT_SECRET, { expiresIn: '5m', issuer: ISSUER, audience: AUDIENCE });
    for (const r of allRoutes()) {
      const res = await w.agent[r.method](`/api/onboarding${r.path}`).set('Authorization', `Bearer ${pre}`).send(r.method === 'get' ? undefined : {});
      expect([r.method, r.path, [401].includes(res.status), res.status < 500]).toEqual([r.method, r.path, false, true]);
      expect(JSON.stringify(res.body)).not.toContain(t.ws);
    }
    expect(ctx.graph).toBeTruthy();
  });
});

describe('the encryption key is never silently replaced', () => {
  test('a workspace whose token cannot be decrypted (wrong key) is NOT treated as revoked: the owner is asked nothing, the poll backs off', async () => {
    const t = await w.tenant('KeyRotation');
    const ctx = await w.connectTenant(t);
    const key = process.env.WA_TOKEN_ENCRYPTION_KEY;
    process.env.WA_TOKEN_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    try {
      const calls = ctx.graph.calls.length;
      await w.post(t.owner, '/connection/refresh', {}); // may fail with a code; must not flag a reconnect
      const conn = await w.connOf(t.ws);
      expect(conn.needsReconnect).toBe(false);
      expect(conn.status).toBe('connected');
      expect(ctx.graph.calls.length).toBe(calls); // nothing was sent to Graph with an undecryptable token
    } finally { process.env.WA_TOKEN_ENCRYPTION_KEY = key; }
    expect((await w.post(t.owner, '/connection/refresh', {})).status).not.toBe(500);
  });
});
