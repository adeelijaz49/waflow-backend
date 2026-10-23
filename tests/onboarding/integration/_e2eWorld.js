'use strict';
// Shared world of the end-to-end suites (task I1b). Not a test file. The REAL server.js app (every hook, the real HTTP
// guard, the real JWT middleware, the real routers with their runtime deps) on the throwaway mongod; the only fakes are
// the three external systems (Graph via the axios bridge, Stripe via the injected client, Resend via the module stub),
// installed by tests/onboarding/e2e/boot.js. Tenants are created through the REAL enrolment / admin activation, the
// REAL OTP login (AUTH_TEST_MODE) and the REAL legal acceptance.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { boot } = require('../e2e/boot');

const flat = (s) => Object.assign({ event: s.event }, s.data);
let codeSeq = 0;
/** A fresh single-use authorization code (looks like a real one so the redaction heuristics are exercised). */
const usedCodes = [];
const nextCode = () => { const c = `AQDe2eCODESECRET${String(++codeSeq).padStart(4, '0')}valueXYZabc`; usedCodes.push(c); return c; };
let tenantSeq = 0;

/** Every route of routes/onboarding/*.js (found in the source, so a route added later cannot be forgotten), with ':key' / ':language' filled. */
function allRoutes() {
  const dir = path.join(__dirname, '..', '..', '..', 'routes', 'onboarding');
  const found = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'index.js')) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /router[.](get|post|put|delete)[(]\s*['`]([^'`]+)['`]/g;
    let m;
    while ((m = re.exec(src))) {
      const kinds = m[2].includes('${kind}') ? ['customers', 'products'] : [null]; // prompts.js declares both routes in a loop
      for (const kind of kinds) found.push({ method: m[1], path: (kind ? m[2].replace('${kind}', kind) : m[2]).replace(':key', 'welcome_optin').replace(':language', 'en'), file: f });
    }
  }
  return found;
}

/** Collect console output of the whole process (for the leak assertions). */
function spyConsole() {
  const lines = [];
  const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation((...a) => {
    lines.push(a.map((x) => (typeof x === 'string' ? x : (x instanceof Error ? `${x.message} ${x.stack || ''}` : JSON.stringify(x)))).join(' '));
  }));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) };
}

/**
 * @param {{policy?:'block'|'platform_number', env?:object}} [opts]
 */
async function createWorld(opts = {}) {
  const handle = await boot({ policy: opts.policy || 'block', env: opts.env });
  const agent = request(handle.app);
  const M = (n) => handle.model(n);
  const state = require('../../../shared/onboarding/state');
  const legal = require('../../../shared/legalAcceptance');
  const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');

  // the owner's own workspace: the oldest one, never enrolled (the enrolment safeguard refuses it)
  const oldestAt = new Date('2026-01-01T00:00:00Z');
  const oldest = String((await M('Workspace').collection.insertOne({ name: 'World owner workspace (oldest)', createdAt: oldestAt, updatedAt: oldestAt, onboarding: { completed: true, currentStep: 1 } })).insertedId);

  async function login(phone) {
    const a = await agent.post('/api/auth/otp/request').send({ phone });
    const v = await agent.post('/api/auth/otp/verify').send({ phone, code: a.body.testCode });
    if (v.status !== 200 || !v.body.token) throw new Error(`login failed ${v.status} ${JSON.stringify(v.body).slice(0, 120)}`);
    return v.body.token;
  }
  const sign = (u, role, extra) => jwt.sign({ sub: String(u.id), workspaceId: String(u.ws), role: role || u.role || 'owner' }, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE, ...(extra || {}) });

  async function person(label, ws, who, role, { legalAccepted = true } = {}) {
    tenantSeq += 1;
    const phone = `96651${String(8000000 + tenantSeq * 7).slice(0, 7)}`;
    const u = await M('User').create({ phone, email: `${String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${who}-${tenantSeq}@example.test`, name: `${label} ${who}` });
    await M('Membership').create({ userId: u._id, workspaceId: ws, role });
    if (role === 'owner' && legalAccepted) {
      await legal.recordCombinedAcceptance({ userId: String(u._id), workspaceId: ws, role: 'owner' });
      await legal.recordDpaAcceptance({ userId: String(u._id), workspaceId: ws, role: 'owner' });
    }
    const token = await login(phone);
    return { id: String(u._id), ws, role, phone, email: u.email, token };
  }

  /** A workspace created like a self-serve signup (completed:false), with an owner and a member. */
  async function legacyWorkspace(name, { completed = false, members = true, legalAccepted = true } = {}) {
    tenantSeq += 1;
    const at = new Date(Date.UTC(2026, 9, 5, 0, tenantSeq));
    const ws = String((await M('Workspace').collection.insertOne({ name: `${name} ${tenantSeq}`, createdAt: at, updatedAt: at, onboarding: { completed, currentStep: 1 } })).insertedId);
    const t = { ws, name, owner: await person(name, ws, 'owner', 'owner', { legalAccepted }) };
    if (members) t.member = await person(name, ws, 'member', 'member');
    return t;
  }
  /** An ENROLLED tenant. activate:true = admin activation; false = subscription none. */
  async function tenant(name, { activate = true, members = true, legalAccepted = true } = {}) {
    const t = await legacyWorkspace(name, { members, legalAccepted });
    await state.enrol({ workspaceId: t.ws, by: 'cli:e2e-test' });
    if (activate) await state.adminActivate({ workspaceId: t.ws, by: 'cli:e2e-test', notes: 'e2e test activation' });
    state.invalidate(t.ws);
    return t;
  }

  const responses = []; // every answer of call(): { method, path, status, text } (for the leak scans)
  // A completed connection (POST /connect/complete, /connect/resume) also hands the queued starter templates to Meta IN THE BACKGROUND
  // (connect.js; the answer never waits for it). The helper waits for that job after the answer, so every later assertion of a suite
  // (Graph call counts, template states) sees a settled world and never races the job.
  const SETTLE_AFTER = new RegExp('^/connect/(complete|resume)$');
  const call = async (user, method, path, body) => {
    let r = agent[method](`/api/onboarding${path}`);
    if (user && user.token) r = r.set('Authorization', `Bearer ${user.token}`);
    if (body !== undefined && method !== 'get') r = r.send(body);
    const res = await r;
    responses.push({ method, path, status: res.status, text: res.text || '', who: user && user.id });
    if (SETTLE_AFTER.test(path)) await require('../../../shared/onboarding/connect')._internal.idle();
    return res;
  };
  const get = (u, p) => call(u, 'get', p);
  const post = (u, p, b = {}) => call(u, 'post', p, b);
  const put = (u, p, b = {}) => call(u, 'put', p, b);
  const withToken = (user, token) => ({ ...user, token });

  async function deliverStripe(type, object, extra) {
    const d = handle.stripe.signedEvent({ type, object, ...(extra || {}) });
    return agent.post('/stripe-billing-webhook').set('stripe-signature', d.header).set('content-type', 'application/json').send(d.payload);
  }
  async function deliverMeta(payload, mode = 'valid') {
    const raw = JSON.stringify(payload);
    let r = agent.post('/webhook').set('content-type', 'application/json');
    if (mode === 'valid') r = r.set('x-hub-signature-256', `sha256=${require('crypto').createHmac('sha256', handle.env.appSecret).update(raw).digest('hex')}`);
    else if (mode === 'invalid') r = r.set('x-hub-signature-256', `sha256=${'0'.repeat(64)}`);
    const res = await r.send(raw);
    await new Promise((resolve) => setTimeout(resolve, 120)); // the handler answers 200 first, processing follows
    return res;
  }

  /** Pay through the real checkout + the real signed webhook. Returns { sessionId, subscription }. */
  async function payViaStripe(t, planCode = 'basic') {
    const co = await post(t.owner, '/checkout', { planCode });
    if (co.status !== 200) throw new Error(`checkout answered ${co.status} ${JSON.stringify(co.body)}`);
    const sessionId = String(co.body.url).split('/').pop();
    const done = handle.stripe.completeCheckout(sessionId, { businessName: `${t.name} Shop`, email: t.owner.email });
    const hook = await deliverStripe('checkout.session.completed', done.session);
    if (hook.status !== 200) throw new Error(`webhook answered ${hook.status} ${JSON.stringify(hook.body)}`);
    return { sessionId, subscription: done.subscription, session: done.session };
  }

  const BUSINESS = (t, extra) => ({ name: `${t.name} Shop`, country: 'SA', industry: 'fashion', ...(extra || {}) });
  /** business + number (Path A) + connect config; returns { graph, attemptId }. Creates the tenant's OWN fake WhatsApp Business account. */
  async function prepareConnect(t, graphOptions = {}) {
    const g = handle.graph.newTarget(`T${t.ws}`, { displayNumber: `+966 55 8${String(tenantSeq).padStart(2, '0')} 1234`, verifiedName: `${t.name} Shop`, ...graphOptions });
    const b = await put(t.owner, '/business', BUSINESS(t));
    if (b.status !== 200) throw new Error(`business ${b.status} ${JSON.stringify(b.body)}`);
    const n = await post(t.owner, '/number/path', { hasNumber: true, usage: 'unused' });
    if (n.status !== 200) throw new Error(`number ${n.status} ${JSON.stringify(n.body)}`);
    const cfg = await get(t.owner, '/connect/config');
    if (cfg.status !== 200) throw new Error(`connect config ${cfg.status} ${JSON.stringify(cfg.body)}`);
    return { graph: g, attemptId: cfg.body.attemptId, config: cfg.body };
  }
  const complete = (t, ctx, extra = {}) => post(t.owner, '/connect/complete', { attemptId: ctx.attemptId, code: nextCode(), session: flat(ctx.graph.session('FINISH')), ...extra });
  /** Full connect through the API. */
  async function connectTenant(t, graphOptions) {
    const ctx = await prepareConnect(t, graphOptions);
    const done = await complete(t, ctx);
    if (done.status !== 200) throw new Error(`connect complete ${done.status} ${JSON.stringify(done.body)}`);
    ctx.result = done.body;
    return ctx;
  }
  const rowOf = (ws) => M('OnboardingState').findOne({ workspaceId: ws }).lean();
  const connOf = (ws) => M('WhatsAppConnection').findOne({ workspaceId: ws }).lean();

  return {
    handle, agent, M, state, legal, oldest, login, sign, person, legacyWorkspace, tenant,
    responses, call, get, post, put, withToken, deliverStripe, deliverMeta, payViaStripe, prepareConnect, complete, connectTenant, rowOf, connOf,
    graph: handle.graph, stripe: handle.stripe, mail: handle.mail, BUSINESS, flat, nextCode, usedCodes,
  };
}

module.exports = { createWorld, spyConsole, flat, nextCode, allRoutes };
