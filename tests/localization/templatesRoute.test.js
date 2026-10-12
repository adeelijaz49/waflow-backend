// HTTP tests for /api/localization/templates: the real router and the real service, with a
// stub auth middleware (workspace and user come from request headers so one app can play
// several tenants) and in-memory collaborators — no database, no network, no WhatsApp, no Meta.
// They prove tenant scoping, the allow-listed bodies, operator-injection safety, the error
// contract ({error, code} + issues / metaError), static-paths-before-:id routing, library
// delegation and that nothing can delete a template.
jest.mock('../../utils/whatsapp', () => { throw new Error('utils/whatsapp.js must not be loaded by these tests'); });
jest.mock('../../utils/tokenManager', () => { throw new Error('utils/tokenManager.js must not be loaded by these tests'); });

const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/localization/templates');
const { createTemplatesService, createRateLimiter } = require('../../shared/localization/templates');
const mt = require('../../shared/localization/metaTemplates');
const { makeMemoryStore, makeMeta, makeTransport } = require('./helpers/templatesFakes');

const WS_A = '65a1b2c3d4e5f60718293a4b';
const WS_B = '75a1b2c3d4e5f607182940ff';
const USER_A = '85a1b2c3d4e5f60718293a4b';
const BASE = '/api/localization/templates';
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);

const OPT_OUT_EN = { role: 'opt_out', text: 'Opt Out' };
const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const EN = { body: 'Hi {name}, you have {points} points to use this week.', buttons: [OPT_OUT_EN] };
const AR = { body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}. استبدلها هذا الأسبوع.', buttons: [OPT_OUT_AR] };

function world(over = {}) {
  const clock = { t: T0 };
  const now = () => new Date(clock.t);
  const store = makeMemoryStore(now);
  const meta = makeMeta();
  const transport = makeTransport();
  const library = {
    listLibrary: jest.fn(() => [{ key: 'comeback', useCase: 'comeback', category: 'MARKETING', name: { en: 'Comeback offer', ar: 'عرض العودة' }, fields: ['name'], variants: { en: EN, ar: AR } }]),
    getLibraryEntry: jest.fn((key) => (key === 'comeback'
      ? { key, useCase: 'comeback', category: 'MARKETING', name: { en: 'Comeback offer', ar: 'عرض العودة' }, fields: ['name'], variants: { en: EN, ar: AR } }
      : null)),
  };
  const service = createTemplatesService({
    store,
    metaClient: meta,
    transport,
    now,
    log: () => {},
    isArabicEnabled: async () => true,
    getBilingualOrder: async () => 'ar_first',
    getReviewerName: async (id) => (id === USER_A ? 'Noura Al-Harbi' : null),
    getDefaultCountryCode: async () => '966',
    getBusinessName: async () => 'متجر الورد',
    findCustomer: async () => null,
    getLibrary: () => library,
    getCeiling: () => 90,
    testSendLimiter: createRateLimiter({ limit: 2, windowMs: 3600000, now: () => clock.t }),
    refreshLimiter: createRateLimiter({ limit: 100, windowMs: 60000, now: () => clock.t }),
    ...over,
  });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const workspaceId = req.get('x-ws');
    if (workspaceId !== undefined) req.user = { id: req.get('x-user'), workspaceId, role: 'owner' };
    next();
  });
  app.use(BASE, createRouter(service));
  return { app, store, meta, transport, library, service, clock };
}

const as = (req, workspaceId = WS_A, userId = USER_A) => req.set('x-ws', String(workspaceId)).set('x-user', String(userId));
const call = (w, verb, url, workspaceId, userId) => as(request(w.app)[verb](`${BASE}${url}`), workspaceId, userId);
const expectError = (res, status, code) => {
  expect(res.status).toBe(status);
  expect(res.body).toMatchObject({ error: expect.any(String), code });
};
const variantOf = (template, language) => template.variants.find((v) => v.language === language);

async function create(w, over = {}, workspaceId = WS_A) {
  const res = await call(w, 'post', '', workspaceId).send({ name: 'Loyalty reminder', useCase: 'loyalty_reminder', variants: [{ language: 'en', ...EN }, { language: 'ar', ...AR }], ...over });
  expect(res.status).toBe(201);
  return res.body;
}

// Submit the Arabic variant and let "Meta" approve it (directly in the fake), then refresh through the API.
async function approved(w, id, language = 'ar') {
  const res = await call(w, 'post', `/${id}/variants/${language}/submit`).send({});
  expect(res.status).toBe(200);
  const name = res.body.submission.metaTemplateName;
  w.meta.rows.set(name, [{ id: `meta-${name}`, name, language, status: 'APPROVED', category: 'MARKETING' }]);
  await call(w, 'post', '/refresh-status').send({ templateId: id });
  return name;
}

describe('routing: static paths come before /:id', () => {
  test('library, meta-usage, from-library, preview and refresh-status are never taken for a template id', async () => {
    const w = world();
    const lib = await call(w, 'get', '/library');
    expect(lib.status).toBe(200);
    expect(lib.body.items.map((i) => i.key)).toEqual(['comeback']);
    const usage = await call(w, 'get', '/meta-usage');
    expect(usage.status).toBe(200);
    expect(usage.body).toEqual({ used: 15, limit: 250, ceiling: 90, atCeiling: false });
    const refresh = await call(w, 'post', '/refresh-status').send({});
    expect(refresh.body).toEqual({ checked: 0, changed: 0 });
    const preview = await call(w, 'post', '/preview').send({ variant: { language: 'en', ...EN } });
    expect(preview.status).toBe(200);
    expect(preview.body.body).toBe('Hi Sara, you have 120 points to use this week.');
    const fromLibrary = await call(w, 'post', '/from-library').send({ libraryKey: 'comeback' });
    expect(fromLibrary.status).toBe(201);
    // while a real id still resolves to the template
    expect((await call(w, 'get', `/${fromLibrary.body.id}`)).body.name).toBe('Comeback offer');
  });

  test('an id that is not an ObjectId is a 400 INVALID_ID (not a 500, not another route)', async () => {
    const w = world();
    expectError(await call(w, 'get', '/not-an-id'), 400, 'INVALID_ID');
    expectError(await call(w, 'put', '/not-an-id/variants/en').send(EN), 400, 'INVALID_ID');
    expect((await call(w, 'post', '/library/submit').send({})).status).toBe(404);
  });

  test('there is no way to delete a template over HTTP', async () => {
    const w = world();
    const t = await create(w);
    for (const url of [`/${t.id}`, `/${t.id}/variants/en`, '']) expect((await call(w, 'delete', url)).status).toBe(404);
    expect(w.store.docs).toHaveLength(1);
  });
});

describe('create / list / get / update / archive', () => {
  test('POST creates (201) with the LocalizedTemplate shape; the workspace comes from the token, not the body', async () => {
    const w = world();
    const t = await create(w, { workspaceId: WS_B, createdBy: 'x', archived: true, linkedMessageNodeId: '95a1b2c3d4e5f60718293a4b', id: 'forged' });
    expect(Object.keys(t).sort()).toEqual(['archived', 'category', 'createdAt', 'id', 'key', 'linkedMessageNodeId', 'linkedPromotionId', 'name', 'updatedAt', 'useCase', 'variants']);
    expect(t).toMatchObject({ key: 'loyalty_reminder', category: 'MARKETING', archived: false, linkedMessageNodeId: null });
    expect(w.store.docs).toHaveLength(1);
    expect(w.store.docs[0]).toMatchObject({ workspaceId: WS_A, createdBy: USER_A, archived: false });
    expect(w.store.docs[0].linkedMessageNodeId).toBeUndefined();
    expect(t.variants.map((v) => [v.language, v.metaStatus, v.reviewStatus, v.sendable])).toEqual([['en', 'NOT_CREATED', 'draft', false], ['ar', 'NOT_CREATED', 'draft', false]]);
  });

  test('bad bodies are 400 INVALID_INPUT: missing/odd name, unknown use case, operator objects, bad variants', async () => {
    const w = world();
    for (const body of [{}, { name: '' }, { name: { $ne: null } }, { name: 'x', useCase: 'nope' }, { name: 'x', category: { $gt: '' } }, { name: 'x', variants: 'en' }, { name: 'x', variants: [{ language: 'fr', body: 'a' }] }, { name: 'x', key: 'Bad Key' }]) {
      expectError(await call(w, 'post', '').send(body), 400, 'INVALID_INPUT');
    }
    expect(w.store.docs).toHaveLength(0);
  });

  test('an explicit key that is taken is 409 TEMPLATE_KEY_TAKEN; a derived one gets a suffix', async () => {
    const w = world();
    await create(w, { key: 'mine' });
    expectError(await call(w, 'post', '').send({ name: 'Other', key: 'mine' }), 409, 'TEMPLATE_KEY_TAKEN');
    expect((await create(w)).key).toBe('loyalty_reminder');
    expect((await create(w)).key).toBe('loyalty_reminder_2');
  });

  test('GET lists only the caller workspace; search, use case and archived filters work; operator injection is refused', async () => {
    const w = world();
    const mine = await create(w);
    await create(w, { name: 'Payment reminder', useCase: 'payment_reminder', variants: [] });
    await create(w, { name: 'Theirs' }, WS_B);
    const all = await call(w, 'get', '');
    expect(all.body).toMatchObject({ total: 2, page: 1 });
    expect(all.body.items.map((t) => t.name).sort()).toEqual(['Loyalty reminder', 'Payment reminder']);
    expect((await call(w, 'get', '').query({ search: 'loyalty' })).body.items.map((t) => t.id)).toEqual([mine.id]);
    expect((await call(w, 'get', '').query({ useCase: 'payment_reminder' })).body.total).toBe(1);
    expect((await call(w, 'get', '').query({ search: '.*' })).body.total).toBe(0); // never a pattern
    // Express 5 does not parse nested query objects: an operator-style key is just an unknown parameter and is ignored
    for (const key of ['search[$ne]', 'useCase[$ne]', 'archived[$ne]']) {
      const res = await call(w, 'get', '').query({ [key]: 'x' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
    }
    await call(w, 'post', `/${mine.id}/archive`).send({});
    expect((await call(w, 'get', '')).body.total).toBe(1);
    expect((await call(w, 'get', '').query({ archived: 'true' })).body.total).toBe(2);
    expect((await call(w, 'get', '').query({ archived: 'only' })).body.items.map((t) => t.id)).toEqual([mine.id]);
  });

  test('tenant isolation: another workspace gets 404 TEMPLATE_NOT_FOUND on every id route and nothing changes', async () => {
    const w = world();
    const t = await create(w);
    const before = JSON.stringify(w.store.docs);
    const requests = [
      call(w, 'get', `/${t.id}`, WS_B),
      call(w, 'put', `/${t.id}`, WS_B).send({ name: 'Hijack' }),
      call(w, 'post', `/${t.id}/archive`, WS_B).send({}),
      call(w, 'post', `/${t.id}/unarchive`, WS_B).send({}),
      call(w, 'put', `/${t.id}/variants/en`, WS_B).send({ body: 'hijack' }),
      call(w, 'post', `/${t.id}/variants/en/validate`, WS_B).send({}),
      call(w, 'post', `/${t.id}/variants/en/submit`, WS_B).send({}),
      call(w, 'post', `/${t.id}/variants/en/review`, WS_B).send({ status: 'reviewed' }),
      call(w, 'post', `/${t.id}/variants/en/test-send`, WS_B).send({ phone: '0551234567' }),
      call(w, 'post', '/refresh-status', WS_B).send({ templateId: t.id }),
    ];
    for (const res of await Promise.all(requests)) expectError(res, 404, 'TEMPLATE_NOT_FOUND');
    expect(JSON.stringify(w.store.docs)).toBe(before);
    expect(w.meta.submitCalls).toHaveLength(0);
    expect(w.transport.sent).toHaveLength(0);
    // the workspace in the query or a header is ignored
    const spoof = await call(w, 'get', `/${t.id}`, WS_B).query({ workspaceId: WS_A }).set('x-workspace-id', WS_A);
    expectError(spoof, 404, 'TEMPLATE_NOT_FOUND');
  });

  test('PUT updates name/use case/category only (allow-list); archive and unarchive flip the flag', async () => {
    const w = world();
    const t = await create(w);
    const res = await call(w, 'put', `/${t.id}`).send({ name: 'Renamed', useCase: 'promotion', workspaceId: WS_B, archived: true, key: 'forged', variants: [] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Renamed', useCase: 'promotion', archived: false, key: 'loyalty_reminder' });
    expect(res.body.variants).toHaveLength(2);
    expect(w.store.docs[0].workspaceId).toBe(WS_A);
    expectError(await call(w, 'put', `/${t.id}`).send({ useCase: 'nope' }), 400, 'INVALID_INPUT');
    expect((await call(w, 'post', `/${t.id}/archive`).send({})).body.archived).toBe(true);
    expect((await call(w, 'post', `/${t.id}/unarchive`).send({})).body.archived).toBe(false);
  });

  describe('the UTILITY floor over HTTP: a marketing use case cannot be labelled UTILITY (corrected, never rejected)', () => {
    test.each(['promotion', 'comeback', 'loyalty_reminder', 'welcome_optin', 'custom'])('POST %s with category UTILITY is created (201) as MARKETING', async (useCase) => {
      const w = world();
      const res = await call(w, 'post', '').send({ name: `T ${useCase}`, useCase, category: 'UTILITY', variants: [{ language: 'en', ...EN }] });
      expect(res.status).toBe(201);
      expect(res.body.category).toBe('MARKETING'); // the corrected value comes back
      expect(w.store.docs[0].category).toBe('MARKETING'); // and is what was stored
    });

    test('POST payment_reminder with category UTILITY stays UTILITY; PUT category UTILITY on a promotion answers 200 with MARKETING', async () => {
      const w = world();
      const pay = await call(w, 'post', '').send({ name: 'Pay', useCase: 'payment_reminder', category: 'UTILITY', variants: [{ language: 'en', body: 'Hi {name}, please complete payment for order {order_id} today.', buttons: [] }] });
      expect(pay.status).toBe(201);
      expect(pay.body.category).toBe('UTILITY');
      const t = await create(w, { useCase: 'promotion' });
      const res = await call(w, 'put', `/${t.id}`).send({ category: 'UTILITY' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ useCase: 'promotion', category: 'MARKETING' });
      expect(w.store.docs[1].category).toBe('MARKETING');
    });

    test('an unknown category is still a 400; only a known one is corrected', async () => {
      const w = world();
      const t = await create(w, { useCase: 'promotion' });
      expectError(await call(w, 'put', `/${t.id}`).send({ category: 'AUTHENTICATION' }), 400, 'INVALID_INPUT');
      expectError(await call(w, 'post', '').send({ name: 'x', useCase: 'promotion', category: 'nope' }), 400, 'INVALID_INPUT');
    });
  });
});

describe('variants: save, validate, review', () => {
  test('PUT saves a draft and resets approval; the body is allow-listed (status fields cannot be forged)', async () => {
    const w = world();
    const t = await create(w);
    const res = await call(w, 'put', `/${t.id}/variants/en`).send({ body: 'New body for {name} this week, welcome back.', buttons: [OPT_OUT_EN], metaStatus: 'APPROVED', reviewStatus: 'reviewed', submissionCount: 9, contentVersion: 99, reviewedBy: 'me', workspaceId: WS_B });
    expect(res.status).toBe(200);
    expect(variantOf(res.body, 'en')).toMatchObject({ body: 'New body for {name} this week, welcome back.', metaStatus: 'NOT_CREATED', reviewStatus: 'draft', submissionCount: 0, sendable: false });
    expect(w.store.docs[0].variants.find((v) => v.language === 'en')).toMatchObject({ contentVersion: 2 });
    expectError(await call(w, 'put', `/${t.id}/variants/fr`).send(EN), 400, 'INVALID_INPUT');
    expectError(await call(w, 'put', `/${t.id}/variants/en`).send({ body: { $ne: 1 } }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'put', `/${t.id}/variants/en`).send({ body: 'ok', buttons: [{ role: 'custom', text: 'x' }] }), 400, 'VARIANT_INVALID');
  });

  test('validate reports a draft without saving it', async () => {
    const w = world();
    const t = await create(w);
    const res = await call(w, 'post', `/${t.id}/variants/ar/validate`).send({ body: '{name}، أهلاً بك في متجرنا اليوم', buttons: [] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['errors', 'ok', 'params', 'positionalText', 'warnings']);
    expect(res.body.ok).toBe(false);
    expect(res.body.errors.map((e) => e.code)).toEqual(expect.arrayContaining(['marketing_requires_opt_out_button', 'body_starts_with_variable']));
    expect(w.store.docs[0].variants.find((v) => v.language === 'ar').body).toBe(AR.body);
    const stored = await call(w, 'post', `/${t.id}/variants/ar/validate`).send({});
    expect(stored.body.ok).toBe(true);
  });

  test('review marks reviewed with the signed-in user name, and draft clears it; an unknown status is 400', async () => {
    const w = world();
    const t = await create(w);
    const reviewed = await call(w, 'post', `/${t.id}/variants/ar/review`).send({ status: 'reviewed', reviewedBy: 'Forged Name' });
    expect(reviewed.status).toBe(200);
    expect(variantOf(reviewed.body, 'ar')).toMatchObject({ reviewStatus: 'reviewed', reviewedBy: 'Noura Al-Harbi', reviewedAt: new Date(T0).toISOString() });
    const draft = await call(w, 'post', `/${t.id}/variants/ar/review`).send({ status: 'draft' });
    expect(variantOf(draft.body, 'ar')).toMatchObject({ reviewStatus: 'draft', reviewedBy: null, reviewedAt: null });
    expectError(await call(w, 'post', `/${t.id}/variants/ar/review`).send({ status: 'approved' }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', `/${t.id}/variants/ar/review`).send({}), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', `/${t.id}/variants/bilingual/review`).send({ status: 'reviewed' }), 404, 'VARIANT_NOT_FOUND');
  });
});

describe('submit', () => {
  test('success: 200 with the PENDING variant and the submission; the Meta payload is the real Arabic text', async () => {
    const w = world();
    const t = await create(w);
    const res = await call(w, 'post', `/${t.id}/variants/ar/submit`).send({ language: 'en', name: 'forged', category: 'UTILITY' });
    expect(res.status).toBe(200);
    expect(res.body.submission).toMatchObject({ metaStatus: 'PENDING', dryRun: false, metaTemplateName: expect.stringMatching(/^wf_293a4b_loyalty_reminder_ar_v1$/) });
    expect(variantOf(res.body.template, 'ar')).toMatchObject({ metaStatus: 'PENDING', submissionCount: 1, sendable: false, notSendableReason: 'pending' });
    expect(w.meta.submitCalls).toHaveLength(1);
    expect(w.meta.submitCalls[0]).toMatchObject({ language: 'ar', category: 'MARKETING' });
    expect(w.meta.submitCalls[0].components.find((c) => c.type === 'BODY').text).toBe('أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها هذا الأسبوع.');
  });

  test('errors: 400 VARIANT_INVALID + issues, 409 ALREADY_SUBMITTED, 409 META_TEMPLATE_LIMIT, 503 META_NOT_CONFIGURED, 502 META_ERROR (sanitised) + lastError', async () => {
    const w = world();
    const t = await create(w);
    const bad = await create(w, { name: 'Bad', variants: [{ language: 'ar', body: '{name}، مرحباً بك', buttons: [] }] });
    const invalid = await call(w, 'post', `/${bad.id}/variants/ar/submit`).send({});
    expectError(invalid, 400, 'VARIANT_INVALID');
    expect(invalid.body.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['marketing_requires_opt_out_button', 'body_starts_with_variable']));

    w.meta.usage = { used: 90, limit: 250 };
    expectError(await call(w, 'post', `/${t.id}/variants/ar/submit`).send({}), 409, 'META_TEMPLATE_LIMIT');
    w.meta.usage = { used: 15, limit: 250 };

    w.meta.configured = false;
    expectError(await call(w, 'post', `/${t.id}/variants/ar/submit`).send({}), 503, 'META_NOT_CONFIGURED');
    w.meta.configured = true;

    w.meta.submitImpl = async () => { throw new mt.MetaApiError({ code: 100, subcode: 2388024, message: 'Content in this language already exists, Bearer EAAB123456789012345678901234' }); };
    const failed = await call(w, 'post', `/${t.id}/variants/ar/submit`).send({});
    expectError(failed, 502, 'META_ERROR');
    expect(failed.body.metaError.code).toBe(100);
    expect(JSON.stringify(failed.body)).not.toMatch(/stack|axios|Authorization/i);
    const stored = (await call(w, 'get', `/${t.id}`)).body;
    expect(variantOf(stored, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', lastError: expect.stringContaining('(100)') });

    w.meta.submitImpl = null;
    expect((await call(w, 'post', `/${t.id}/variants/ar/submit`).send({})).status).toBe(200);
    expectError(await call(w, 'post', `/${t.id}/variants/ar/submit`).send({}), 409, 'ALREADY_SUBMITTED');
  });

  test('dry-run: nothing is sent, nothing changes, submission.dryRun is true', async () => {
    const w = world();
    const t = await create(w);
    w.transport.dry = true;
    const res = await call(w, 'post', `/${t.id}/variants/ar/submit`).send({});
    expect(res.status).toBe(200);
    expect(res.body.submission).toMatchObject({ dryRun: true, metaStatus: 'NOT_CREATED' });
    expect(w.meta.submitCalls).toHaveLength(0);
    expect(variantOf((await call(w, 'get', `/${t.id}`)).body, 'ar')).toMatchObject({ metaStatus: 'NOT_CREATED', submissionCount: 0 });
  });
});

describe('refresh-status', () => {
  test('refreshes one template or the whole workspace and returns { checked, changed }', async () => {
    const w = world();
    const t = await create(w);
    const name = (await call(w, 'post', `/${t.id}/variants/ar/submit`).send({})).body.submission.metaTemplateName;
    w.meta.rows.set(name, [{ id: 'm1', name, language: 'ar', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'INVALID_FORMAT' }]);
    expect((await call(w, 'post', '/refresh-status').send({ templateId: t.id })).body).toEqual({ checked: 1, changed: 1 });
    expect(variantOf((await call(w, 'get', `/${t.id}`)).body, 'ar')).toMatchObject({ metaStatus: 'REJECTED', metaRejectedReason: 'INVALID_FORMAT', notSendableReason: 'rejected' });
    expect((await call(w, 'post', '/refresh-status').send({})).body).toEqual({ checked: 1, changed: 0 });
    expectError(await call(w, 'post', '/refresh-status').send({ templateId: 'nope' }), 400, 'INVALID_ID');
    expectError(await call(w, 'post', '/refresh-status', WS_B).send({ templateId: t.id }), 404, 'TEMPLATE_NOT_FOUND');
  });

  test('a Meta failure is 502 META_ERROR (not a 500) and the template is untouched', async () => {
    const w = world();
    const t = await create(w);
    await call(w, 'post', `/${t.id}/variants/ar/submit`).send({});
    w.meta.getTemplateById = async () => { throw new mt.MetaApiError({ code: 190, message: 'Token expired' }); };
    const res = await call(w, 'post', '/refresh-status').send({ templateId: t.id });
    expectError(res, 502, 'META_ERROR');
    expect(res.body.metaError).toEqual({ code: 190, message: 'Token expired' });
  });
});

describe('test-send', () => {
  test('requires an APPROVED variant (409 NOT_APPROVED), a valid phone (400 INVALID_PHONE) and sends through the transport', async () => {
    const w = world();
    const t = await create(w);
    expectError(await call(w, 'post', `/${t.id}/variants/ar/test-send`).send({ phone: '0551234567' }), 409, 'NOT_APPROVED');
    const name = await approved(w, t.id);
    for (const phone of [undefined, '', '123', 'abc', { $ne: 1 }, '1'.repeat(30), '+966 55 12']) {
      expectError(await call(w, 'post', `/${t.id}/variants/ar/test-send`).send({ phone }), 400, 'INVALID_PHONE');
    }
    expect(w.transport.sent).toHaveLength(0);
    const ok = await call(w, 'post', `/${t.id}/variants/ar/test-send`).send({ phone: '٠٥٥١٢٣٤٥٦٧', to: 'forged' }); // Arabic-Indic digits
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ sent: true, dryRun: false });
    expect(w.transport.sent).toHaveLength(1);
    expect(w.transport.sent[0].to).toBe('966551234567');
    expect(w.transport.sent[0].args).toMatchObject({ name, languageCode: 'ar' });
    expect(JSON.stringify(w.transport.sent[0].args.components)).toContain('l10ntest_optout');
    expect(JSON.stringify(w.transport.sent[0].args.components)).not.toContain('optout_test'); // the old payload was a REAL opt-out for whoever tapped it
  });

  test('rate limited per workspace: 429 RATE_LIMITED with Retry-After', async () => {
    const w = world();
    const t = await create(w);
    await approved(w, t.id);
    for (let i = 0; i < 2; i += 1) expect((await call(w, 'post', `/${t.id}/variants/ar/test-send`).send({ phone: '0551234567' })).status).toBe(200);
    const limited = await call(w, 'post', `/${t.id}/variants/ar/test-send`).send({ phone: '0551234567' });
    expectError(limited, 429, 'RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(w.transport.sent).toHaveLength(2);
  });
});

describe('library, preview', () => {
  test('from-library delegates to the library, creates en + ar drafts (source library) and suffixes a taken name', async () => {
    const w = world();
    const first = await call(w, 'post', '/from-library').send({ libraryKey: 'comeback', workspaceId: WS_B });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ name: 'Comeback offer', useCase: 'comeback', category: 'MARKETING' });
    expect(first.body.variants.map((v) => [v.language, v.source, v.reviewStatus, v.metaStatus])).toEqual([['en', 'library', 'draft', 'NOT_CREATED'], ['ar', 'library', 'draft', 'NOT_CREATED']]);
    expect(w.library.getLibraryEntry).toHaveBeenCalledWith('comeback');
    expect(w.store.docs[0].workspaceId).toBe(WS_A);
    const second = await call(w, 'post', '/from-library').send({ libraryKey: 'comeback' });
    expect(second.body.name).toBe('Comeback offer 2');
    expectError(await call(w, 'post', '/from-library').send({ libraryKey: 'nope' }), 404, 'NOT_FOUND');
    expectError(await call(w, 'post', '/from-library').send({}), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', '/from-library').send({ libraryKey: { $ne: 1 } }), 400, 'INVALID_INPUT');
  });

  test('preview renders on the server: samples, given values, missing fields, bilingual paragraphs; bad input is 400', async () => {
    const w = world();
    const res = await call(w, 'post', '/preview').send({ variant: { language: 'en', body: 'Hi {name}, your code is {unknown_field}, {points} points.', buttons: [OPT_OUT_EN] }, fieldValues: { points: 7 } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ language: 'en', body: 'Hi Sara, your code is {unknown_field}, 7 points.', footer: 'Reply STOP to unsubscribe', missingFields: ['unknown_field'] });
    const bi = await call(w, 'post', '/preview').send({ variant: { language: 'bilingual', bilingualOrder: 'en_first', body: 'Hello {name}, welcome today.\n\nمرحباً {name}، أهلاً بك اليوم.', buttons: [] } });
    expect(bi.body.body.split('\n\n')).toHaveLength(2);
    expectError(await call(w, 'post', '/preview').send({}), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', '/preview').send({ variant: { language: 'xx', body: 'a' } }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', '/preview').send({ variant: { language: 'en', body: 'a' }, fieldValues: { 'a b': 'x' } }), 400, 'INVALID_INPUT');
    expectError(await call(w, 'post', '/preview').send({ variant: { language: 'en', body: 'a' }, customerId: 'zzz' }), 400, 'INVALID_ID');
    expectError(await call(w, 'post', '/preview').send({ variant: { language: 'en', body: 'a' }, customerId: 'a5a1b2c3d4e5f60718293a4b' }), 404, 'CUSTOMER_NOT_FOUND');
  });
});

describe('error contract', () => {
  test('an unexpected failure is a generic 500 that leaks nothing', async () => {
    const boom = { listTemplates: async () => { throw new Error('secret connection string mongodb://user:pw@host'); } };
    const app = express();
    app.use((req, res, next) => { req.user = { id: USER_A, workspaceId: WS_A }; next(); });
    app.use(BASE, createRouter(boom));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(BASE);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|mongodb/);
    expect(res.body.error).toBe('Something went wrong');
  });

  test('requiring the real router performs no I/O and exposes a factory', () => {
    const router = require('../../routes/localization/templates');
    expect(typeof router).toBe('function');
    expect(typeof router.createRouter).toBe('function');
  });
});
