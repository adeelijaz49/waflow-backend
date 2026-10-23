'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2elegacy`;
assertThrowawayDb();

// END TO END (task I1b): with ONBOARDING_FLOW=on, LEGACY workspaces (every workspace that exists today, enrolled or not
// in the owner's mind) are untouched: every onboarding route answers "not available", the HTTP guard passes every
// request through byte-identically, nothing is written, the platform webhook payload reaches the legacy handler, and
// only an explicit cutover (ONBOARDING_ENROL_FROM) can enrol a NEW signup.
const { createWorld, spyConsole, allRoutes } = require('./_e2eWorld');

jest.setTimeout(90000);

let w;
let con;
let w0;
let w0b;
const COLLECTIONS = ['OnboardingState', 'WhatsAppConnection', 'WhatsAppClaim', 'OnboardingEvent', 'OnboardingSupportRequest', 'OnboardingNotification', 'OnboardingTemplate', 'OnboardingInbound', 'OnboardingAdminLog'];
const counters = async () => { const out = {}; for (const n of COLLECTIONS) out[n] = await w.M(n).countDocuments({}); return out; };

const BODY = { '/business': { name: 'Legacy Shop' }, '/number/path': { hasNumber: false }, '/checkout': { planCode: 'basic' }, '/connect/event': { attemptId: 'a'.repeat(32), event: 'CANCEL' }, '/prompts/customers': { state: 'skipped' } };

const LEGACY_REQUESTS = [
  ['get', '/api/promotions'], ['get', '/api/customers'], ['get', '/api/settings'],
  ['post', '/api/promotions/000000000000000000000001/send'], ['post', '/api/promotions/000000000000000000000001/test-send'],
  ['post', '/api/promotions/loyalty/remind'], ['post', '/api/customers/consent-requests'],
  ['post', '/api/flows/000000000000000000000001/activate'], ['post', '/api/inbox/conversations/000000000000000000000001/messages'],
  ['get', '/api/social-accounts/instagram/connect-url'], ['post', '/api/social-accounts/instagram/disconnect'],
  ['post', '/api/instagram-posts/posts/000000000000000000000001/publish-now'],
  ['post', '/api/referrals/promotions/000000000000000000000001/send'], ['get', '/api/orders'], ['get', '/api/auth/me'],
];

beforeAll(async () => {
  w = await createWorld({ policy: 'block' });
  con = spyConsole();
  w0 = await w.legacyWorkspace('Legacy', { completed: true });
  w0b = await w.legacyWorkspace('LegacySelfServe', { completed: false });
});
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('legacy workspaces with the flag ON', () => {
  test('every onboarding route answers 404 ONBOARDING_NOT_AVAILABLE (state: { enrolled:false }); nothing is written anywhere', async () => {
    const routes = allRoutes();
    expect(routes).toHaveLength(33);
    const before = await counters();
    const wsBefore = await w.M('Workspace').find({ _id: { $in: [w0.ws, w0b.ws] } }).lean();
    for (const who of [w0.owner, w0.member, w0b.owner]) {
      for (const r of routes) {
        const res = await w.call(who, r.method, r.path, r.method === 'get' ? undefined : (BODY[r.path] || {}));
        if (r.method === 'get' && r.path === '/state') {
          expect([r.path, res.status, res.body]).toEqual([r.path, 200, { enrolled: false }]);
        } else {
          expect([r.method, r.path, res.status, res.body.code]).toEqual([r.method, r.path, 404, 'ONBOARDING_NOT_AVAILABLE']);
        }
      }
    }
    expect(await counters()).toEqual(before);
    expect(await w.M('OnboardingState').countDocuments({ workspaceId: { $in: [w0.ws, w0b.ws] } })).toBe(0);
    const wsAfter = await w.M('Workspace').find({ _id: { $in: [w0.ws, w0b.ws] } }).lean();
    expect(wsAfter).toEqual(wsBefore); // the old wizard flag (completed true / false) is exactly as it was
  });

  test('the HTTP guard is a pass-through: the same requests answer byte-identically with the flag ON and OFF', async () => {
    const run = async (token) => {
      const out = [];
      for (const [m, p] of LEGACY_REQUESTS) {
        const res = await w.agent[m](p).set('Authorization', `Bearer ${token}`).send(m === 'get' ? undefined : {});
        out.push([m, p, res.status, JSON.stringify(res.body), res.text && res.text.length < 400 ? res.text : '']);
      }
      return out;
    };
    for (const who of [w0.owner, w0b.owner]) {
      process.env.ONBOARDING_FLOW = 'on';
      const on = await run(who.token);
      process.env.ONBOARDING_FLOW = 'off';
      const off = await run(who.token);
      process.env.ONBOARDING_FLOW = 'on';
      expect(on).toEqual(off);
      expect(on.every((r) => r[2] !== 402)).toBe(true);
      expect(on.some((r) => /ONBOARDING|SENDING_NOT_AVAILABLE|SUBSCRIPTION_REQUIRED/.test(r[3]))).toBe(false);
    }
    expect(await w.M('OnboardingState').countDocuments({})).toBe(0);
  });

  test('flag OFF at runtime: the new URLs are unknown routes again (404), /stripe-billing-webhook included', async () => {
    process.env.ONBOARDING_FLOW = 'off';
    try {
      const s = await w.agent.get('/api/onboarding/state').set('Authorization', `Bearer ${w0.owner.token}`);
      expect(s.status).toBe(404);
      expect(s.body.code).toBeUndefined();
      const hook = await w.agent.post('/stripe-billing-webhook').set('content-type', 'application/json').send('{"id":"evt_1"}');
      const unknown = await w.agent.post('/zzz-not-a-route').set('content-type', 'application/json').send('{"id":"evt_1"}');
      expect([hook.status, hook.text.replace('/stripe-billing-webhook', '/X')]).toEqual([unknown.status, unknown.text.replace('/zzz-not-a-route', '/X')]); // the 404 page only echoes the path
    } finally { process.env.ONBOARDING_FLOW = 'on'; }
  });

  test('the platform webhook payload reaches the legacy handler untouched, in every signature mode, unsigned', async () => {
    const wsOldest = w.oldest;
    const cust = await w.M('Customer').create({ workspaceId: wsOldest, firstname: 'Hook', lastname: 'Target', phone: '966555123400' });
    const mk = async (wamid) => w.M('CampaignMessage').create({ workspaceId: wsOldest, kind: 'promotion', customer: cust._id, phone: cust.phone, wamid, status: 'sent' });
    const statusPayload = (wamid, entryId) => ({ object: 'whatsapp_business_account', entry: [{ ...(entryId === undefined ? {} : { id: entryId }), changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id: wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: cust.phone }] } }] }] });
    const before = await counters();
    for (const mode of ['enforce', 'log', 'off']) {
      process.env.ONBOARDING_WEBHOOK_SIGNATURE = mode;
      for (const [label, entryId] of [['platform WABA', process.env.WA_WABA_ID], ['no entry id', undefined], ['unknown WABA', '1234567890123456789']]) {
        const wamid = `wamid.LEGACY_${mode}_${label.replace(/\s/g, '_')}`;
        await mk(wamid);
        const res = await w.deliverMeta(statusPayload(wamid, entryId), 'absent');
        expect([mode, label, res.status]).toEqual([mode, label, 200]);
        const row = await w.M('CampaignMessage').findOne({ wamid }).lean();
        expect([mode, label, row.status]).toEqual([mode, label, 'delivered']); // the legacy handler ran, body intact
      }
    }
    delete process.env.ONBOARDING_WEBHOOK_SIGNATURE;
    expect(await counters()).toEqual(before);
  });

  test('a MERCHANT webhook needs a valid signature in enforce mode: absent / invalid = 403, valid = 200 and handled by the new code only', async () => {
    const t = await w.tenant('HookMerchant');
    const ctx = await w.connectTenant(t);
    const payload = ctx.graph.webhook.envelope('phone_number_quality_update', { display_phone_number: '966558000001', event: 'ONBOARDING', current_limit: 'TIER_1K' }, ctx.graph.ids.wabaId);
    expect((await w.deliverMeta(payload, 'absent')).status).toBe(403);
    expect((await w.deliverMeta(payload, 'invalid')).status).toBe(403);
    expect((await w.deliverMeta(payload, 'valid')).status).toBe(200);
    // ruling 1: a wrong platform secret can never break the owner's live webhook: platform payloads pass unsigned in enforce mode
    const plat = { object: 'whatsapp_business_account', entry: [{ id: process.env.WA_WABA_ID, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [] } }] }] };
    expect((await w.deliverMeta(plat, 'invalid')).status).toBe(200);
  });
});

describe('auto-enrolment exists only behind an explicit cutover', () => {
  afterAll(() => { delete process.env.ONBOARDING_ENROL_FROM; w.state.clearCache(); });

  test('without ONBOARDING_ENROL_FROM a brand-new self-serve signup is a legacy workspace (no sidecar, old wizard)', async () => {
    const login = async (phone) => {
      const a = await w.agent.post('/api/auth/otp/request').send({ phone });
      const v = await w.agent.post('/api/auth/otp/verify').send({ phone, code: a.body.testCode });
      return v.body;
    };
    const s = await login('966500123401');
    expect(s.workspace.onboarding.completed).toBe(false);
    const st = await w.agent.get('/api/onboarding/state').set('Authorization', `Bearer ${s.token}`);
    expect(st.body).toEqual({ enrolled: false });
    // the HTTP guard (every /api request) does not enrol either
    await w.agent.get('/api/promotions').set('Authorization', `Bearer ${s.token}`);
    expect(await w.M('OnboardingState').countDocuments({ workspaceId: s.workspace.id })).toBe(0);
  });

  test('with a cutover, ONLY signups created after it are enrolled (and R1 keeps them away from the old wizard); older workspaces never are', async () => {
    process.env.ONBOARDING_ENROL_FROM = new Date(Date.now() - 60 * 1000).toISOString();
    w.state.clearCache();
    const a = await w.agent.post('/api/auth/otp/request').send({ phone: '966500123402' });
    const v = await w.agent.post('/api/auth/otp/verify').send({ phone: '966500123402', code: a.body.testCode });
    const st = await w.agent.get('/api/onboarding/state').set('Authorization', `Bearer ${v.body.token}`);
    expect(st.body).toMatchObject({ enrolled: true, view: 'billing', subscription: { state: 'none' } });
    const ws = await w.M('Workspace').findById(v.body.workspace.id).lean();
    expect(ws.onboarding.completed).toBe(true);
    // the older legacy workspaces (created before the cutover) and the owner's oldest one are untouched
    for (const old of [w0, w0b]) {
      const r = await w.get(old.owner, '/state');
      expect(r.body).toEqual({ enrolled: false });
    }
    expect(await w.M('OnboardingState').countDocuments({ workspaceId: w.oldest })).toBe(0);
  });
});

describe('merchant-WABA messages never reach the legacy inbox flow', () => {
  test('a signed merchant "messages" event is acknowledged and dropped with a counter: no customer, no conversation, no reply', async () => {
    const t = await w.tenant('MerchantInbox');
    const ctx = await w.connectTenant(t);
    const customers = await w.M('Customer').countDocuments({});
    const payload = ctx.graph.webhook.envelope('messages', {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '966558000002', phone_number_id: ctx.graph.ids.phoneId },
      contacts: [{ profile: { name: 'Stranger' }, wa_id: '966555777001' }],
      messages: [{ from: '966555777001', id: 'wamid.MERCHANTMSG1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello merchant' } }],
    }, ctx.graph.ids.wabaId);
    const res = await w.deliverMeta(payload, 'valid');
    expect(res.status).toBe(200);
    expect(await w.M('Customer').countDocuments({})).toBe(customers);
    expect(await w.M('Customer').countDocuments({ phone: '966555777001' })).toBe(0);
    expect(w.graph.platformCalls).toHaveLength(0);
    expect(JSON.stringify(con.lines)).not.toContain('hello merchant');
    const same = await w.deliverMeta(payload, 'valid'); // Meta retries: de-duplicated, still fine
    expect(same.status).toBe(200);
  });
});
