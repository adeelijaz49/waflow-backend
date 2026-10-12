// HTTP-level tests for /api/localization/campaigns: a bare Express app with a stub
// auth middleware (sets req.user like requireAuth does) and the in-memory store of
// campaignTestKit substituted for the models and the transport — no database, no
// network, no real WhatsApp. What matters here: tenant scoping, input hardening,
// the confirm gate and the 202 semantics of POST /:id/send.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const express = require('express');
const request = require('supertest');
const sender = require('../../shared/localization/campaignSender');
const { makeKit, oid, variant } = require('./campaignTestKit');

const W1 = oid();
const W2 = oid();
const USER = oid();
const BASE = '/api/localization/campaigns';
const FIELDS = { discount: '15', date: '30 Nov' };
let seq = 0;
let kit;
let template;

function makeApp({ queryParser } = {}) {
  const app = express();
  if (queryParser) app.set('query parser', queryParser);
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: String(USER), workspaceId: req.get('x-test-workspace') || String(W1), role: 'owner' };
    next();
  });
  app.use(BASE, require('../../routes/localization/campaigns'));
  return app;
}

function customer(extra = {}, ws = W1) {
  seq += 1;
  const { language, ...rest } = extra;
  const [doc] = kit.customers.seed([{
    _id: oid(), workspaceId: ws, firstname: `First${seq}`, lastname: `Last${seq}`, phone: `9665${String(seq).padStart(8, '0')}`,
    marketingConsent: true, loyaltyPoints: 50, ...rest,
  }]);
  if (language) kit.languages.seed([{ workspaceId: ws, customerId: doc._id, language }]);
  return doc;
}

const body = (extra = {}) => ({
  name: 'Spring offer', templateId: String(template._id), languageMode: 'per_customer', audience: { kind: 'all_eligible' }, fieldValues: FIELDS, ...extra,
});

let app;

beforeEach(() => {
  kit = makeKit();
  [template] = kit.templates.seed([{ _id: oid(), workspaceId: W1, key: 'promo', name: 'Weekend offer', useCase: 'promotion', category: 'MARKETING', variants: [variant('en'), variant('ar')] }]);
  jest.spyOn(sender, 'realDeps').mockImplementation(() => kit.deps);
  app = makeApp();
});

afterEach(() => { jest.restoreAllMocks(); });

const post = (path, payload, workspace) => {
  const req = request(app).post(`${BASE}${path}`);
  if (workspace) req.set('x-test-workspace', String(workspace));
  return req.send(payload);
};
const get = (path, workspace) => {
  const req = request(app).get(`${BASE}${path}`);
  if (workspace) req.set('x-test-workspace', String(workspace));
  return req;
};

async function createDraft(extra) {
  const res = await post('/', body(extra));
  expect(res.status).toBe(201);
  return res.body;
}

describe('GET /segments', () => {
  test('lists the segment options with their parameters', async () => {
    const res = await get('/segments');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      { key: 'language', params: ['language'] },
      { key: 'inactive_days', params: ['days'] },
      { key: 'has_points', params: ['minPoints'] },
      { key: 'awaiting_consent', params: [] },
    ]);
  });
});

describe('POST /plan', () => {
  test('returns the CampaignPlan and writes nothing', async () => {
    customer({ language: 'ar' });
    customer({ language: 'en' });
    customer({ marketingConsent: false });
    const res = await post('/plan', body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      templateId: String(template._id), category: 'MARKETING', audience: { selected: 3, eligible: 2 }, byLanguage: { en: 1, ar: 1, bilingual: 0 },
      skipped: { noConsent: 1, optedOut: 0, demo: 0, invalidPhone: 0 }, canSend: true, needsAcknowledgement: false,
    });
    expect(res.body.sampleRecipients.length).toBeGreaterThan(0);
    expect(kit.campaigns.docs).toHaveLength(0);
    expect(kit.sends.docs).toHaveLength(0);
    expect(kit.sent).toHaveLength(0);
  });

  test('another tenant\'s template is TEMPLATE_NOT_FOUND', async () => {
    const res = await post('/plan', body(), W2);
    expect([res.status, res.body.code]).toEqual([404, 'TEMPLATE_NOT_FOUND']);
  });

  test('another tenant\'s customers are ignored, not leaked', async () => {
    const mine = customer();
    const theirs = customer({}, W2);
    const res = await post('/plan', body({ audience: { kind: 'customer_ids', customerIds: [String(mine._id), String(theirs._id)] } }));
    expect(res.status).toBe(200);
    expect(res.body.audience).toEqual({ selected: 1, eligible: 1 });
    expect(res.body.warnings).toContainEqual({ code: 'audience_ids_not_found', detail: { count: 1 } });
  });

  test.each([
    ['no body', undefined],
    ['bad template id', { templateId: 'nope', audience: { kind: 'all_eligible' } }],
    ['operator in template id', { templateId: { $ne: null }, audience: { kind: 'all_eligible' } }],
    ['unknown audience kind', { audience: { kind: 'everyone' } }],
    ['operator in customerIds', { audience: { kind: 'customer_ids', customerIds: { $in: [] } } }],
    ['operator inside customerIds', { audience: { kind: 'customer_ids', customerIds: [{ $ne: null }] } }],
    ['unknown language mode', { languageMode: 'klingon' }],
    ['non-object fieldValues', { fieldValues: 'x' }],
    ['bad field name', { fieldValues: { 'a b': 'x' } }],
    ['newline in a field value', { fieldValues: { discount: '15\n20' } }],
    ['oversized field value', { fieldValues: { discount: 'x'.repeat(501) } }],
    ['too many fields', { fieldValues: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x'])) }],
    ['segment without params', { audience: { kind: 'segment', segmentKey: 'inactive_days' } }],
    ['unknown segment', { audience: { kind: 'segment', segmentKey: 'rich' } }],
  ])('rejects %s with 400 and a code', async (_label, payload) => {
    const res = await post('/plan', payload === undefined ? undefined : { ...body(), ...payload });
    expect(res.status).toBe(400);
    expect(['INVALID_INPUT', 'INVALID_ID']).toContain(res.body.code);
    expect(typeof res.body.error).toBe('string');
  });

  test('more than 2000 hand-picked customers is refused (the 100 kB body limit)', async () => {
    const res = await post('/plan', body({ audience: { kind: 'customer_ids', customerIds: Array.from({ length: 2001 }, () => String(oid())) } }));
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_INPUT']);
  });

  test('a body-supplied workspaceId is ignored (the tenant comes from the token)', async () => {
    customer();
    customer({}, W2);
    const res = await post('/plan', { ...body(), workspaceId: String(W2) });
    expect(res.body.audience.selected).toBe(1);
  });
});

describe('POST / (create) and reads', () => {
  test('creates a draft with a plan snapshot, scoped to the caller\'s workspace', async () => {
    customer();
    const view = await createDraft();
    expect(view).toMatchObject({ name: 'Spring offer', status: 'draft', languageMode: 'per_customer', audience: { kind: 'all_eligible' }, fieldValues: FIELDS });
    expect(view.plan.audience.eligible).toBe(1);
    expect(view.plan.sampleRecipients).toEqual([]); // no customer data persisted in the plan
    expect(view.stats).toMatchObject({ total: 0, sent: 0 });
    const stored = kit.campaigns.docs[0];
    expect(String(stored.workspaceId)).toBe(String(W1));
    expect(String(stored.createdBy)).toBe(String(USER));
    expect(kit.sent).toHaveLength(0);
  });

  test('stores only allow-listed fields: a smuggled status/stats/workspaceId in the body changes nothing', async () => {
    const view = await createDraft({ status: 'sent', stats: { sent: 999 }, workspaceId: String(W2), claimedBy: 'me', plan: { canSend: true } });
    const stored = kit.campaigns.docs[0];
    expect(view.status).toBe('draft');
    expect(stored.stats.sent).toBe(0);
    expect(String(stored.workspaceId)).toBe(String(W1));
    expect(stored.claimedBy).toBeUndefined();
  });

  test.each([
    ['missing name', { name: undefined }],
    ['blank name', { name: '   ' }],
    ['name not a string', { name: { $ne: 1 } }],
    ['name too long', { name: 'x'.repeat(121) }],
  ])('%s -> 400 INVALID_INPUT', async (_label, extra) => {
    const res = await post('/', { ...body(), ...extra });
    expect([res.status, res.body.code]).toEqual([400, 'INVALID_INPUT']);
    expect(kit.campaigns.docs).toHaveLength(0);
  });

  test('an archived template cannot start a campaign (422 TEMPLATE_UNUSABLE); another tenant\'s template is 404', async () => {
    kit.templates.docs[0].archived = true;
    expect((await post('/', body())).body.code).toBe('TEMPLATE_UNUSABLE');
    expect((await post('/', body(), W2)).status).toBe(404);
  });

  test('GET /:id returns the view; another tenant and unknown ids are 404; a malformed id is 400', async () => {
    const view = await createDraft();
    expect((await get(`/${view.id}`)).body).toMatchObject({ id: view.id, status: 'draft' });
    const other = await get(`/${view.id}`, W2);
    expect([other.status, other.body.code]).toEqual([404, 'CAMPAIGN_NOT_FOUND']);
    expect((await get(`/${oid()}`)).status).toBe(404);
    const bad = await get('/not-an-id');
    expect([bad.status, bad.body.code]).toEqual([400, 'INVALID_ID']);
  });

  test('GET / lists newest first with paging and a status filter, only this tenant\'s campaigns', async () => {
    const a = await createDraft({ name: 'A' });
    const b = await createDraft({ name: 'B' });
    kit.campaigns.seed([{ workspaceId: W2, name: 'Theirs', templateId: template._id, status: 'draft' }]);
    kit.campaigns.docs.find((d) => String(d._id) === a.id).status = 'sent';
    const all = await get('/');
    expect(all.body.total).toBe(2);
    expect(all.body.items.map((i) => i.name)).toEqual(['B', 'A']);
    expect(all.body.items[0].audience.customerIds).toBeUndefined();
    const sent = await get('/?status=sent');
    expect(sent.body.items.map((i) => i.id)).toEqual([a.id]);
    const page = await get('/?limit=1&page=2');
    expect(page.body).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(page.body.items.map((i) => i.id)).toEqual([a.id]);
    expect(b.id).toBeTruthy();
  });

  test('list rejects a status outside the enum and clamps absurd paging; operator-style query strings are harmless', async () => {
    expect((await get('/?status=hacked')).body.code).toBe('INVALID_INPUT');
    expect((await get('/?limit=100000&page=-4')).body).toMatchObject({ limit: 200, page: 1 });
    const extended = makeApp({ queryParser: 'extended' });
    const res = await request(extended).get(`${BASE}?status[$ne]=sent`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('POST /:id/send', () => {
  test('answers 202 at once with the claimed campaign; the sending happens in the background', async () => {
    const a = customer({ language: 'ar' });
    const b = customer({ language: 'en' });
    const view = await createDraft();
    const res = await post(`/${view.id}/send`, {});
    expect(res.status).toBe(202);
    expect(res.body.campaign).toMatchObject({ id: view.id, status: 'sending' });
    expect(kit.sent).toHaveLength(0); // nothing happened inside the request
    expect(kit.scheduled).toHaveLength(1);
    await kit.drain();
    expect(kit.sent.map((s) => s.name).sort()).toEqual(['wf_test_ar_v1', 'wf_test_en_v1']);
    expect(kit.sent.map((s) => s.to).sort()).toEqual([a.phone, b.phone].sort());
    const done = await get(`/${view.id}`);
    expect(done.body).toMatchObject({ status: 'sent', stats: { total: 2, sent: 2, byLanguage: { en: 1, ar: 1, bilingual: 0 } } });
  });

  test('a second send is 409 CAMPAIGN_NOT_DRAFT (double click) and nothing extra is scheduled', async () => {
    customer();
    const view = await createDraft();
    expect((await post(`/${view.id}/send`, {})).status).toBe(202);
    const again = await post(`/${view.id}/send`, {});
    expect([again.status, again.body.code]).toEqual([409, 'CAMPAIGN_NOT_DRAFT']);
    expect(kit.scheduled).toHaveLength(1);
  });

  test('422 PLAN_NEEDS_ACK until the fallbacks are acknowledged (a truthy non-boolean is not an acknowledgement)', async () => {
    kit.templates.docs[0].variants[1].metaStatus = 'PENDING';
    customer({ language: 'ar' });
    const view = await createDraft();
    for (const acknowledge of [undefined, {}, { fallbacks: 'true' }, { fallbacks: 1 }, { blocked: true }, 'yes']) {
      const res = await post(`/${view.id}/send`, acknowledge === undefined ? {} : { acknowledge });
      expect([res.status, res.body.code]).toEqual([422, 'PLAN_NEEDS_ACK']);
    }
    expect(kit.campaigns.docs[0].status).toBe('draft');
    expect(kit.scheduled).toHaveLength(0);
    const ok = await post(`/${view.id}/send`, { acknowledge: { fallbacks: true } });
    expect(ok.status).toBe(202);
    await kit.drain();
    expect(kit.sent[0].name).toBe('wf_test_en_v1'); // the acknowledged English fallback
  });

  test.each([
    ['NOTHING_TO_SEND', () => { customer({ marketingConsent: false }); }, {}],
    ['FIELD_VALUES_MISSING', () => { customer(); }, { fieldValues: { discount: '1' } }],
  ])('422 %s', async (code, seed, extra) => {
    seed();
    const created = await post('/', body(extra));
    expect(created.status).toBe(201);
    const res = await post(`/${created.body.id}/send`, { acknowledge: { fallbacks: true, blocked: true } });
    expect([res.status, res.body.code]).toEqual([422, code]);
    expect(kit.sent).toHaveLength(0);
  });

  test('the plan stored at creation is never trusted: customers who withdrew consent since are not messaged', async () => {
    const stay = customer();
    const gone = customer();
    const view = await createDraft();
    expect(view.plan.audience.eligible).toBe(2);
    kit.customers.docs.find((d) => String(d._id) === String(gone._id)).marketingConsent = false;
    const res = await post(`/${view.id}/send`, {});
    expect(res.status).toBe(202);
    await kit.drain();
    expect(kit.sent.map((s) => s.to)).toEqual([stay.phone]);
  });

  test('another tenant cannot send my campaign; unknown/malformed ids are 404/400', async () => {
    customer();
    const view = await createDraft();
    const other = await post(`/${view.id}/send`, {}, W2);
    expect([other.status, other.body.code]).toEqual([404, 'CAMPAIGN_NOT_FOUND']);
    expect((await post(`/${oid()}/send`, {})).status).toBe(404);
    expect((await post('/zzz/send', {})).body.code).toBe('INVALID_ID');
    expect(kit.campaigns.docs[0].status).toBe('draft');
    expect(kit.sent).toHaveLength(0);
  });

  test('a send failing inside Meta never leaks upstream text through the API response', async () => {
    customer();
    kit.transport.impl = async () => { throw Object.assign(new Error('boom'), { response: { data: { error: { code: 100, message: 'secret upstream detail' } } } }); };
    const view = await createDraft();
    const res = await post(`/${view.id}/send`, {});
    expect(res.status).toBe(202);
    expect(JSON.stringify(res.body)).not.toContain('secret upstream detail');
    await kit.drain();
    expect(kit.campaigns.docs[0].status).toBe('failed');
  });
});

describe('POST /:id/cancel', () => {
  test('cancels a draft (a status change; nothing is deleted)', async () => {
    const view = await createDraft();
    const res = await post(`/${view.id}/cancel`, {});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(kit.campaigns.docs).toHaveLength(1);
    expect(kit.ops.filter((o) => /delete|remove|drop/i.test(o.op))).toEqual([]);
  });

  test('cancels a running campaign: the queued recipients are closed and the loop sends nothing more; cancelling again is a no-op', async () => {
    customer();
    customer();
    const view = await createDraft();
    await post(`/${view.id}/send`, {});
    const res = await post(`/${view.id}/cancel`, {});
    expect(res.body.status).toBe('cancelled');
    await kit.drain();
    expect(kit.sent).toHaveLength(0);
    expect((await post(`/${view.id}/cancel`, {})).body.status).toBe('cancelled');
    expect(kit.campaigns.docs[0].status).toBe('cancelled');
  });

  test('a finished campaign cannot be cancelled (409); another tenant gets 404', async () => {
    customer();
    const view = await createDraft();
    await post(`/${view.id}/send`, {});
    await kit.drain();
    const res = await post(`/${view.id}/cancel`, {});
    expect([res.status, res.body.code]).toEqual([409, 'CAMPAIGN_NOT_DRAFT']);
    expect((await post(`/${view.id}/cancel`, {}, W2)).status).toBe(404);
  });
});

describe('recipients and report', () => {
  async function sentCampaign() {
    const sara = customer({ language: 'ar', firstname: 'سارة', lastname: 'أحمد' });
    const sam = customer({ language: 'en', firstname: 'Sam', lastname: 'Lee' });
    const demo = customer({ isDemo: true });
    const noConsent = customer({ marketingConsent: false });
    const view = await createDraft({ audience: { kind: 'customer_ids', customerIds: [sara, sam, demo, noConsent].map((c) => String(c._id)) } });
    await post(`/${view.id}/send`, {});
    await kit.drain();
    return { view, sara, sam, demo, noConsent };
  }

  test('GET /:id/recipients joins the customer name/phone and the delivery status by wamid', async () => {
    const { view, sara, sam } = await sentCampaign();
    const saraRow = kit.sends.docs.find((d) => String(d.customerId) === String(sara._id));
    kit.messages.docs.find((m) => m.wamid === saraRow.wamid).status = 'read';
    const res = await get(`/${view.id}/recipients`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 4, page: 1 });
    const byId = Object.fromEntries(res.body.items.map((i) => [i.customerId, i]));
    expect(byId[String(sara._id)]).toMatchObject({ name: 'سارة أحمد', phone: sara.phone, usedLanguage: 'ar', status: 'sent', deliveryStatus: 'read', fallback: false, errorCode: null });
    expect(byId[String(sam._id)]).toMatchObject({ status: 'sent', deliveryStatus: 'sent', usedLanguage: 'en' });
    expect(Object.values(byId).filter((r) => r.status.startsWith('skipped_')).map((r) => r.status).sort()).toEqual(['skipped_demo', 'skipped_no_consent']);
  });

  test('recipient filters (status, language), paging and validation', async () => {
    const { view } = await sentCampaign();
    expect((await get(`/${view.id}/recipients?status=sent`)).body.total).toBe(2);
    expect((await get(`/${view.id}/recipients?status=sent&language=ar`)).body.items).toHaveLength(1);
    expect((await get(`/${view.id}/recipients?limit=1&page=2`)).body.items).toHaveLength(1);
    expect((await get(`/${view.id}/recipients?status=bogus`)).body.code).toBe('INVALID_INPUT');
    expect((await get(`/${view.id}/recipients?language=fr`)).body.code).toBe('INVALID_INPUT');
  });

  test('failed sends expose Meta\'s error code and a readable reason', async () => {
    customer();
    kit.transport.impl = async () => { throw Object.assign(new Error('x'), { response: { data: { error: { code: 132015, message: 'Template is paused' } } } }); };
    const view = await createDraft();
    await post(`/${view.id}/send`, {});
    await kit.drain();
    const res = await get(`/${view.id}/recipients?status=failed`);
    expect(res.body.items[0]).toMatchObject({ status: 'failed', errorCode: '132015', error: 'Template is paused', deliveryStatus: null });
  });

  test('another tenant sees neither the recipients nor the report', async () => {
    const { view } = await sentCampaign();
    expect((await get(`/${view.id}/recipients`, W2)).status).toBe(404);
    expect((await get(`/${view.id}/report`, W2)).status).toBe(404);
  });

  test('GET /:id/report: per-language funnel, status counts and the fallback count', async () => {
    const { view, sara, sam } = await sentCampaign();
    const wamidOf = (c) => kit.sends.docs.find((d) => String(d.customerId) === String(c._id)).wamid;
    kit.messages.docs.find((m) => m.wamid === wamidOf(sara)).status = 'read';
    kit.messages.docs.find((m) => m.wamid === wamidOf(sam)).status = 'failed';
    const res = await get(`/${view.id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.campaignId).toBe(view.id);
    expect(res.body.byLanguage.ar).toEqual({ sent: 1, delivered: 1, read: 1, failed: 0 });
    expect(res.body.byLanguage.en).toEqual({ sent: 0, delivered: 0, read: 0, failed: 1 });
    expect(res.body.byStatus).toMatchObject({ sent: 2, skipped_demo: 1, skipped_no_consent: 1 });
    expect(res.body.stats).toMatchObject({ total: 4, sent: 2, skipped: 2 });
    expect(res.body.fallbackCount).toBe(0);
  });

  test('the report counts the language fallbacks that were actually sent', async () => {
    kit.templates.docs[0].variants[1].metaStatus = 'PENDING';
    customer({ language: 'ar' });
    customer({ language: 'ar' });
    const view = await createDraft();
    await post(`/${view.id}/send`, { acknowledge: { fallbacks: true } });
    await kit.drain();
    const res = await get(`/${view.id}/report`);
    expect(res.body.fallbackCount).toBe(2);
    expect(res.body.byLanguage.en.sent).toBe(2);
  });
});

describe('route hygiene', () => {
  test('unexpected errors become a generic { error, code: INTERNAL } with no stack or internal text', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    kit.fail('localizedcampaigns', 'findOne', new Error('mongo exploded at /srv/secret/path'));
    const res = await get(`/${oid()}`);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  test('a malformed JSON body is a 400, not a crash', async () => {
    const res = await request(app).post(`${BASE}/plan`).set('Content-Type', 'application/json').send('{"templateId": ');
    expect(res.status).toBe(400);
  });
});
