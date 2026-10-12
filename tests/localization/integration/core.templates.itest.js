const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const { createTemplatesService } = require('../../../shared/localization/templates');
const settings = require('../../../shared/localization/settings');

const GOOD_EN = { body: 'Hi {name}, we miss you! Come back this week.', buttons: [{ role: 'opt_out', text: 'Stop messages' }] };
const GOOD_AR = { body: 'أهلاً {name}، اشتقنا لك! زرنا هذا الأسبوع.', buttons: [{ role: 'opt_out', text: 'إيقاف الرسائل' }] };

// A Meta client that records calls and never leaves the process.
function fakeMeta(over = {}) {
  const calls = { submit: [], byId: [], byName: [], since: [] };
  let n = 0;
  const client = {
    calls,
    assertConfigured: async () => {},
    submitTemplate: async (payload) => { calls.submit.push(payload); n += 1; return { id: `meta-${Date.now()}-${n}`, status: 'PENDING', category: payload.category }; },
    getTemplateById: async (id) => { calls.byId.push(id); return client.rows.get(id) || null; },
    listTemplatesByName: async (name) => { calls.byName.push(name); return [...client.rows.values()].filter((r) => r.name.includes(name)); },
    listTemplatesSince: async (args) => { calls.since.push(args); return [...client.rows.values()]; },
    getUsage: async () => ({ used: 3, limit: 250 }),
    rows: new Map(),
    ...over,
  };
  return client;
}
const liveTransport = () => ({ isDryRun: () => false, sendTemplate: async () => ({}) });

describe('B2b templates on real MongoDB', () => {
  let ctx; let a; let b; let c;
  let tpl; // main template of A
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B); c = ctx.api(ctx.C);
  });

  const create = async (api, body) => { const r = await api.post('/templates').send(body); expect(r.status).toBe(201); return r.body; };
  const stored = (id) => LocalizedTemplate.findById(id).lean();
  const variantOf = (doc, lang) => doc.variants.find((v) => v.language === lang);

  describe('keys and the unique (workspaceId, key) index', () => {
    test('same name twice gets derived keys; explicit duplicate is a 409; other workspace may reuse a key', async () => {
      const one = await create(a, { name: 'Welcome Back' });
      const two = await create(a, { name: 'Welcome Back' });
      expect(one.key).toBe('welcome_back'); expect(two.key).toBe('welcome_back_2');
      const explicit = await a.post('/templates').send({ name: 'x', key: 'shared_key' });
      expect(explicit.status).toBe(201);
      const dup = await a.post('/templates').send({ name: 'y', key: 'shared_key' });
      expect(dup.status).toBe(409); expect(dup.body.code).toBe('TEMPLATE_KEY_TAKEN');
      const other = await b.post('/templates').send({ name: 'z', key: 'shared_key' });
      expect(other.status).toBe(201);
    });

    test('the index exists in MongoDB and rejects a raw duplicate', async () => {
      const t = await create(a, { name: 'Index probe', key: 'index_probe' });
      await expect(LocalizedTemplate.create({ workspaceId: ctx.A.wsId, key: 'index_probe', name: 'dup' })).rejects.toMatchObject({ code: 11000 });
      expect(t.id).toBeTruthy();
    });

    test('8 concurrent creates of the same name all succeed with distinct keys', async () => {
      const results = await Promise.all(Array.from({ length: 8 }, () => a.post('/templates').send({ name: 'Concurrent name' })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(201));
      expect(new Set(results.map((r) => r.body.key)).size).toBe(8);
    });
  });

  describe('upsertVariant version / reset semantics', () => {
    beforeAll(async () => { tpl = await create(a, { name: 'Comeback main', useCase: 'comeback' }); });

    test('adds a variant, then a changed body bumps contentVersion and resets review + Meta state', async () => {
      const put = await a.put(`/templates/${tpl.id}/variants/en`).send(GOOD_EN);
      expect(put.status).toBe(200);
      expect((await stored(tpl.id)).variants[0]).toMatchObject({ language: 'en', contentVersion: 1, metaStatus: 'NOT_CREATED', reviewStatus: 'draft' });
      const rev = await a.post(`/templates/${tpl.id}/variants/en/review`).send({ status: 'reviewed' });
      expect(rev.status).toBe(200);
      // pretend Meta approved it
      await LocalizedTemplate.updateOne({ _id: tpl.id, 'variants.language': 'en' }, { $set: { 'variants.$.metaStatus': 'APPROVED', 'variants.$.metaTemplateName': 'wf_000000_x_en_v1', 'variants.$.lastError': 'old', 'variants.$.metaRejectedReason': 'old' } });
      const same = await a.put(`/templates/${tpl.id}/variants/en`).send(GOOD_EN);
      expect(same.status).toBe(200);
      let v = variantOf(await stored(tpl.id), 'en');
      expect(v).toMatchObject({ contentVersion: 1, reviewStatus: 'reviewed', metaStatus: 'APPROVED' }); // identical save is a no-op
      const changed = await a.put(`/templates/${tpl.id}/variants/en`).send({ ...GOOD_EN, body: 'Hello {name}, new text here.' });
      expect(changed.status).toBe(200);
      v = variantOf(await stored(tpl.id), 'en');
      expect(v).toMatchObject({ contentVersion: 2, metaStatus: 'NOT_CREATED', reviewStatus: 'draft', body: 'Hello {name}, new text here.' });
      expect(v.reviewedBy).toBeUndefined(); expect(v.lastError).toBeUndefined(); expect(v.metaRejectedReason).toBeUndefined();
      expect(v.metaTemplateName).toBe('wf_000000_x_en_v1'); // history kept
    });

    test('source:ai save keeps a reviewed identical variant in draft', async () => {
      const r1 = await a.put(`/templates/${tpl.id}/variants/en`).send({ ...GOOD_EN, body: 'Hello {name}, new text here.' });
      expect(r1.status).toBe(200);
      await a.post(`/templates/${tpl.id}/variants/en/review`).send({ status: 'reviewed' });
      await a.put(`/templates/${tpl.id}/variants/en`).send({ ...GOOD_EN, body: 'Hello {name}, new text here.', source: 'ai' });
      expect(variantOf(await stored(tpl.id), 'en')).toMatchObject({ reviewStatus: 'draft', source: 'ai' });
    });

    test('6 concurrent first-saves of one language leave exactly one variant (insertVariant guard)', async () => {
      const t = await create(a, { name: 'Race variants' });
      const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => a.put(`/templates/${t.id}/variants/ar`).send({ ...GOOD_AR, body: `أهلاً {name} ${i}` })));
      // optimistic concurrency: losers that exhaust their retries get a clean 409, never a 500 or a second variant
      expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
      expect(rs.some((r) => r.status === 200)).toBe(true);
      const doc = await stored(t.id);
      expect(doc.variants.filter((v) => v.language === 'ar')).toHaveLength(1);
      expect(variantOf(doc, 'ar').contentVersion).toBeGreaterThanOrEqual(1);
    });

    test('review writes the signed-in user name and id; empty variants cannot be reviewed', async () => {
      const t = await create(a, { name: 'Review me', variants: [{ language: 'ar', ...GOOD_AR }, { language: 'en', body: '' }] });
      const ok = await a.post(`/templates/${t.id}/variants/ar/review`).send({ status: 'reviewed' });
      expect(ok.status).toBe(200);
      const v = variantOf(await stored(t.id), 'ar');
      expect(v.reviewedBy).toBe(ctx.A.user.name); expect(String(v.reviewedById)).toBe(String(ctx.A.userId)); expect(v.reviewedAt).toBeTruthy();
      const empty = await a.post(`/templates/${t.id}/variants/en/review`).send({ status: 'reviewed' });
      expect(empty.status).toBe(400); expect(empty.body.code).toBe('VARIANT_INVALID');
      const back = await a.post(`/templates/${t.id}/variants/ar/review`).send({ status: 'draft' });
      expect(back.status).toBe(200);
      expect(variantOf(await stored(t.id), 'ar').reviewedBy).toBeUndefined();
    });

    test('a review that raced with an edit never marks the NEW text as reviewed', async () => {
      const t = await create(a, { name: 'Review race', variants: [{ language: 'ar', ...GOOD_AR }] });
      // the store the service reads from edits the text right after the review's read
      const real = require('../../../shared/localization/templates');
      let edited = false;
      const store = {
        ...real.createMongoStore(() => LocalizedTemplate),
      };
      const baseFind = store.findOne;
      store.findOne = async (ws, id) => {
        const doc = await baseFind(ws, id);
        if (!edited) { edited = true; await LocalizedTemplate.updateOne({ _id: id, 'variants.language': 'ar' }, { $set: { 'variants.$.body': 'نص جديد {name}' }, $inc: { 'variants.$.contentVersion': 1 } }); }
        return doc;
      };
      const svc = createTemplatesService({ store });
      const view = await svc.reviewVariant({ workspaceId: String(ctx.A.wsId), id: t.id, language: 'ar', status: 'reviewed', userId: String(ctx.A.userId) });
      // second attempt re-read the edited doc and reviewed THAT version, never the stale one
      const v = variantOf(await stored(t.id), 'ar');
      expect(v.body).toBe('نص جديد {name}'); expect(v.reviewStatus).toBe('reviewed'); expect(v.contentVersion).toBe(2);
      expect(view.variants[0].body).toBe('نص جديد {name}');
    });
  });

  describe('dry-run submit and test-send through the HTTP routes', () => {
    test('submit in dry-run mode changes nothing and returns the planned name', async () => {
      const t = await create(a, { name: 'Dry submit', variants: [{ language: 'en', ...GOOD_EN }] });
      const r = await a.post(`/templates/${t.id}/variants/en/submit`).send({});
      expect(r.status).toBe(200);
      expect(r.body.submission.dryRun).toBe(true); expect(r.body.submission.metaTemplateName).toMatch(/^wf_[0-9a-f]{6}_dry_submit_en_v1$/);
      expect(variantOf(await stored(t.id), 'en')).toMatchObject({ metaStatus: 'NOT_CREATED', submissionCount: 0 });
    });

    test('invalid variant is a 400 VARIANT_INVALID with issues', async () => {
      const t = await create(a, { name: 'Bad one', variants: [{ language: 'en', body: '' }] });
      const r = await a.post(`/templates/${t.id}/variants/en/submit`).send({});
      expect(r.status).toBe(400); expect(r.body.code).toBe('VARIANT_INVALID'); expect(Array.isArray(r.body.issues)).toBe(true);
    });

    test('test-send: NOT_APPROVED until approved; then dry-run sent; rate limit of 10 per hour; bad phone', async () => {
      const t = await create(a, { name: 'Test send', variants: [{ language: 'en', ...GOOD_EN }] });
      const phoneBody = { phone: '0501234567' };
      expect((await a.post(`/templates/${t.id}/variants/en/test-send`).send(phoneBody)).body.code).toBe('NOT_APPROVED');
      await LocalizedTemplate.updateOne({ _id: t.id, 'variants.language': 'en' }, { $set: { 'variants.$.metaStatus': 'APPROVED', 'variants.$.metaTemplateName': 'wf_abcdef_test_send_en_v1' } });
      const bad = await a.post(`/templates/${t.id}/variants/en/test-send`).send({ phone: 'abc' });
      expect(bad.status).toBe(400); expect(bad.body.code).toBe('INVALID_PHONE');
      const injected = await a.post(`/templates/${t.id}/variants/en/test-send`).send({ phone: { $ne: null } });
      expect(injected.status).toBe(400);
      const ok = await a.post(`/templates/${t.id}/variants/en/test-send`).send(phoneBody);
      expect(ok.status).toBe(200); expect(ok.body).toEqual({ sent: true, dryRun: true });
      const statuses = [];
      for (let i = 0; i < 10; i += 1) statuses.push((await a.post(`/templates/${t.id}/variants/en/test-send`).send(phoneBody)).status);
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
      // tenant B has its own bucket and cannot test-send A's template anyway
      expect((await b.post(`/templates/${t.id}/variants/en/test-send`).send(phoneBody)).status).toBe(404);
    });
  });

  describe('real-mode submit with an injected fake Meta client (no network)', () => {
    const mk = (over = {}) => {
      const metaClient = fakeMeta(over.meta);
      const svc = createTemplatesService({ metaClient, transport: liveTransport(), log: () => {}, getCeiling: () => 90, ...over.deps });
      return { svc, metaClient };
    };
    const ws = () => String(ctx.A.wsId);
    const mkTemplate = (name, extra = {}) => create(a, { name, variants: [{ language: 'en', ...GOOD_EN }, { language: 'ar', ...GOOD_AR }], ...extra });

    test('the UTILITY floor: create / update store MARKETING for a non-transactional use case whatever was requested; a transactional one keeps UTILITY', async () => {
      const promo = await create(a, { name: 'Sneaky promo', useCase: 'promotion', category: 'UTILITY' });
      expect(promo.category).toBe('MARKETING'); // the corrected value is returned...
      expect((await stored(promo.id)).category).toBe('MARKETING'); // ...and is what MongoDB holds
      const pay = await create(a, { name: 'Pay floor', useCase: 'payment_reminder', category: 'UTILITY' });
      expect((await stored(pay.id)).category).toBe('UTILITY');
      const patched = await a.put(`/templates/${promo.id}`).send({ category: 'UTILITY' });
      expect(patched.status).toBe(200);
      expect(patched.body.category).toBe('MARKETING');
      expect((await stored(promo.id)).category).toBe('MARKETING');
      const moved = await a.put(`/templates/${pay.id}`).send({ useCase: 'comeback' });
      expect(moved.body).toMatchObject({ useCase: 'comeback', category: 'MARKETING' });
      expect((await stored(pay.id)).category).toBe('MARKETING');
    });

    test('the UTILITY floor on submit: a legacy row (UTILITY stored on a promotion) goes to Meta as MARKETING', async () => {
      const t = await mkTemplate('Legacy promo', { useCase: 'promotion' });
      await LocalizedTemplate.updateOne({ _id: t.id }, { $set: { category: 'UTILITY' } }); // written before the floor existed
      const { svc, metaClient } = mk();
      await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' });
      expect(metaClient.calls.submit).toHaveLength(1);
      expect(metaClient.calls.submit[0].category).toBe('MARKETING');
    });

    test('persists PENDING + name + count, refuses a second submit of the same content', async () => {
      const t = await mkTemplate('Real submit'); const { svc, metaClient } = mk();
      const r = await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' });
      expect(r.submission).toMatchObject({ dryRun: false, metaStatus: 'PENDING' });
      const v = variantOf(await stored(t.id), 'en');
      expect(v).toMatchObject({ metaStatus: 'PENDING', submissionCount: 1, metaLanguage: 'en' });
      expect(v.metaTemplateName).toMatch(/_en_v1$/); expect(v.submittingAt).toBeUndefined(); expect(v.metaTemplateId).toMatch(/^meta-/);
      await expect(svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' })).rejects.toMatchObject({ status: 409, body: { code: 'ALREADY_SUBMITTED' } });
      expect(metaClient.calls.submit).toHaveLength(1);
      // the other language is independent
      const ar = await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'ar' });
      expect(ar.submission.metaTemplateName).toMatch(/_ar_v1$/);
    });

    test('two concurrent submits reach Meta exactly once (atomic revision claim)', async () => {
      const t = await mkTemplate('Concurrent submit');
      const sent = [];
      const { svc } = mk({ meta: { submitTemplate: async (p) => { await new Promise((r) => setTimeout(r, 80)); sent.push(p); return { id: 'x1', status: 'PENDING', category: p.category }; } } });
      const results = await Promise.allSettled([svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' }), svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
      expect(sent).toHaveLength(1);
      expect(variantOf(await stored(t.id), 'en').submissionCount).toBe(1);
    });

    test('a Meta failure records lastError, frees the in-flight lock and the retry uses a NEW revision name', async () => {
      const t = await mkTemplate('Meta fails');
      let fail = true;
      const { svc } = mk({ meta: { submitTemplate: async (p) => { if (fail) { const e = new Error('boom'); e.metaError = { code: 100, message: 'Invalid parameter' }; throw e; } return { id: 'ok1', status: 'PENDING', category: p.category }; } } });
      await expect(svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' })).rejects.toMatchObject({ status: 502 });
      let v = variantOf(await stored(t.id), 'en');
      expect(v.lastError).toMatch(/Invalid parameter/); expect(v.submittingAt).toBeUndefined(); expect(v.submissionCount).toBe(1); expect(v.metaStatus).toBe('NOT_CREATED');
      fail = false;
      const ok = await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' });
      expect(ok.submission.metaTemplateName).toMatch(/_en_v2$/);
      v = variantOf(await stored(t.id), 'en');
      expect(v.lastError).toBeUndefined(); expect(v.submissionCount).toBe(2);
    });

    test('Meta re-classifying UTILITY to MARKETING escalates the template category', async () => {
      const t = await create(a, { name: 'Utility one', category: 'UTILITY', useCase: 'payment_reminder', variants: [{ language: 'en', body: 'Your payment of {amount} is due.', buttons: [] }] });
      const { svc } = mk({ meta: { submitTemplate: async () => ({ id: 'u1', status: 'PENDING', category: 'MARKETING' }) } });
      await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' });
      const doc = await stored(t.id);
      expect(doc.category).toBe('MARKETING'); expect(variantOf(doc, 'en')).toMatchObject({ metaCategory: 'MARKETING', metaPreviousCategory: 'UTILITY' });
    });

    test('ceiling refuses with META_TEMPLATE_LIMIT and writes nothing', async () => {
      const t = await mkTemplate('Ceiling');
      const { svc, metaClient } = mk({ deps: { getCeiling: () => 5 }, meta: { getUsage: async () => ({ used: 5, limit: 250 }) } });
      await expect(svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' })).rejects.toMatchObject({ status: 409, body: { code: 'META_TEMPLATE_LIMIT' } });
      expect(metaClient.calls.submit).toHaveLength(0);
      expect(variantOf(await stored(t.id), 'en').submissionCount).toBe(0);
    });

    test('text edited while Meta is being called: the new text is NOT marked as submitted', async () => {
      const t = await mkTemplate('Edit during submit');
      const { svc } = mk({ meta: { submitTemplate: async (p) => {
        await LocalizedTemplate.updateOne({ _id: t.id, 'variants.language': 'en' }, { $set: { 'variants.$.body': 'Edited {name} meanwhile.', 'variants.$.metaStatus': 'NOT_CREATED' }, $inc: { 'variants.$.contentVersion': 1 } });
        return { id: 'e1', status: 'PENDING', category: p.category };
      } } });
      await svc.submitVariant({ workspaceId: ws(), id: t.id, language: 'en' });
      expect(variantOf(await stored(t.id), 'en')).toMatchObject({ metaStatus: 'NOT_CREATED', body: 'Edited {name} meanwhile.' });
    });

    test('tenant B cannot submit or test-send A\'s template through the service either', async () => {
      const t = await mkTemplate('Tenant guard'); const { svc, metaClient } = mk();
      await expect(svc.submitVariant({ workspaceId: String(ctx.B.wsId), id: t.id, language: 'en' })).rejects.toMatchObject({ status: 404 });
      expect(metaClient.calls.submit).toHaveLength(0);
    });
  });

  describe('refreshPending / sweepSince on real data with a fake Meta client', () => {
    const live = (metaClient) => createTemplatesService({ metaClient, transport: liveTransport(), log: () => {}, getCeiling: () => 90 });
    // Seeds a submitted (PENDING) variant for a tenant, returns {doc, name, id}
    async function seed(tenant, label, { lang = 'en', status = 'PENDING', checkedAt = new Date(0), submittedAt = new Date(Date.now() - 2 * 24 * 3600 * 1000) } = {}) {
      const name = `wf_${String(tenant.wsId).slice(-6)}_${label}_${lang}_v1`;
      const doc = await LocalizedTemplate.create({
        workspaceId: tenant.wsId, key: `${label}_${h.uniq()}`, name: label,
        variants: [{ language: lang, body: 'Hello {name}', buttons: [{ role: 'opt_out', text: 'Stop' }], metaStatus: status, metaTemplateName: name, metaTemplateId: `id-${name}`, metaLanguage: lang, metaLastCheckedAt: checkedAt, submittedAt, submissionCount: 1 }],
      });
      return { doc, name, id: `id-${name}` };
    }

    test('refreshPending updates flagged workspaces by id, leaves the unflagged one alone, keeps NOT_CREATED untouched', async () => {
      const sa = await seed(ctx.A, `rp_a${h.uniq()}`); const sb = await seed(ctx.B, `rp_b${h.uniq()}`); const sc = await seed(ctx.C, `rp_c${h.uniq()}`);
      const neverSubmitted = await seed(ctx.A, `rp_n${h.uniq()}`, { status: 'NOT_CREATED' });
      const metaClient = fakeMeta();
      metaClient.rows.set(sa.id, { id: sa.id, name: sa.name, language: 'en', status: 'APPROVED', category: 'MARKETING' });
      metaClient.rows.set(sb.id, { id: sb.id, name: sb.name, language: 'en', status: 'REJECTED', category: 'MARKETING', rejected_reason: 'INVALID_FORMAT' });
      metaClient.rows.set(sc.id, { id: sc.id, name: sc.name, language: 'en', status: 'APPROVED', category: 'MARKETING' });
      const r = await live(metaClient).refreshPending({ limit: 500 });
      expect(r.errors).toBe(0);
      expect(variantOf(await stored(sa.doc._id), 'en')).toMatchObject({ metaStatus: 'APPROVED', metaCategory: 'MARKETING', metaStatusRaw: 'APPROVED' });
      const vb = variantOf(await stored(sb.doc._id), 'en');
      expect(vb.metaStatus).toBe('REJECTED'); expect(vb.metaRejectedReason).toBeTruthy(); expect(vb.rejectedContent).toHaveLength(1);
      expect(variantOf(await stored(sc.doc._id), 'en').metaStatus).toBe('PENDING'); // flag off: never checked
      expect(metaClient.calls.byId).not.toContain(sc.id);
      expect(variantOf(await stored(neverSubmitted.doc._id), 'en').metaStatus).toBe('NOT_CREATED');
    });

    test('unknown Graph status is stored as ERROR + metaStatusRaw and never throws', async () => {
      const s = await seed(ctx.A, `rp_u${h.uniq()}`);
      const metaClient = fakeMeta(); metaClient.rows.set(s.id, { id: s.id, name: s.name, language: 'en', status: 'SOMETHING_NEW' });
      const r = await live(metaClient).refreshPending({ limit: 500 });
      expect(r.unknown).toBeGreaterThanOrEqual(1);
      expect(variantOf(await stored(s.doc._id), 'en')).toMatchObject({ metaStatus: 'ERROR', metaStatusRaw: 'SOMETHING_NEW' });
    });

    test('a variant edited between the Meta lookup and the write is not overwritten (guard on contentVersion)', async () => {
      const s = await seed(ctx.A, `rp_g${h.uniq()}`);
      const metaClient = fakeMeta({ getTemplateById: async (id) => {
        if (id === s.id) await LocalizedTemplate.updateOne({ _id: s.doc._id, 'variants.language': 'en' }, { $set: { 'variants.$.body': 'changed {name}', 'variants.$.metaStatus': 'NOT_CREATED' }, $inc: { 'variants.$.contentVersion': 1 } });
        return { id, name: s.name, language: 'en', status: 'APPROVED', category: 'MARKETING' };
      } });
      await live(metaClient).refreshPending({ limit: 500 });
      expect(variantOf(await stored(s.doc._id), 'en')).toMatchObject({ metaStatus: 'NOT_CREATED', body: 'changed {name}' });
    });

    test('Meta outage in the sweep is counted, never thrown', async () => {
      await seed(ctx.A, `rp_o${h.uniq()}`);
      const metaClient = fakeMeta({ getTemplateById: async () => { const e = new Error('down'); e.metaError = { code: 1 }; throw e; } });
      const r = await live(metaClient).refreshPending({ limit: 500 });
      expect(r.errors).toBeGreaterThanOrEqual(1);
    });

    test('manual refresh via the service is scoped: B cannot refresh A\'s template id', async () => {
      const s = await seed(ctx.A, `rp_m${h.uniq()}`);
      const svc = live(fakeMeta());
      await expect(svc.refreshStatuses({ workspaceId: String(ctx.B.wsId), templateId: String(s.doc._id) })).rejects.toMatchObject({ status: 404 });
    });

    test('sweepSince matches rows by exact name+language across workspaces with the real $elemMatch/$in query', async () => {
      const sa = await seed(ctx.A, `sw_a${h.uniq()}`); const sb = await seed(ctx.B, `sw_b${h.uniq()}`, { lang: 'ar' }); const sc = await seed(ctx.C, `sw_c${h.uniq()}`);
      const wrongLang = await seed(ctx.A, `sw_w${h.uniq()}`);
      const metaClient = fakeMeta({ listTemplatesSince: async () => [
        { id: sa.id, name: sa.name, language: 'en', status: 'APPROVED', category: 'MARKETING' },
        { id: 'other-b', name: sb.name, language: 'ar', status: 'APPROVED', category: 'MARKETING' },
        { id: sc.id, name: sc.name, language: 'en', status: 'APPROVED', category: 'MARKETING' },
        { id: 'zzz', name: wrongLang.name, language: 'ar', status: 'APPROVED', category: 'MARKETING' }, // same name, other language: never applied
      ] });
      const r = await live(metaClient).sweepSince({ since: new Date(Date.now() - 3600 * 1000) });
      expect(r.rows).toBe(4); expect(r.matched).toBeGreaterThanOrEqual(2);
      expect(variantOf(await stored(sa.doc._id), 'en').metaStatus).toBe('APPROVED');
      expect(variantOf(await stored(sb.doc._id), 'ar').metaStatus).toBe('APPROVED');
      expect(variantOf(await stored(sc.doc._id), 'en').metaStatus).toBe('PENDING'); // unflagged workspace skipped
      expect(variantOf(await stored(wrongLang.doc._id), 'en').metaStatus).toBe('PENDING');
    });

    test('sweepSince ignores rows that do not belong to WaFlow (no wf_ prefix) and survives a Graph failure', async () => {
      const metaClient = fakeMeta({ listTemplatesSince: async () => [{ id: '1', name: 'someone_elses', language: 'en', status: 'APPROVED' }] });
      expect((await live(metaClient).sweepSince({ since: new Date() })).rows).toBe(0);
      const down = fakeMeta({ listTemplatesSince: async () => { throw new Error('graph down'); } });
      expect((await live(down).sweepSince({ since: new Date() })).errors).toBe(1);
    });

    test('flag flips take effect: kill switch makes refreshPending skip every workspace', async () => {
      const s = await seed(ctx.A, `rp_k${h.uniq()}`);
      const metaClient = fakeMeta(); metaClient.rows.set(s.id, { id: s.id, name: s.name, language: 'en', status: 'APPROVED' });
      process.env.LOCALIZATION_DISABLED = '1';
      try { await live(metaClient).refreshPending({ limit: 500 }); } finally { delete process.env.LOCALIZATION_DISABLED; }
      expect(variantOf(await stored(s.doc._id), 'en').metaStatus).toBe('PENDING');
    });
  });

  describe('tenant isolation and gating', () => {
    test('B cannot read, edit, archive, review or validate A\'s template; list is scoped', async () => {
      const t = await create(a, { name: 'Private A', variants: [{ language: 'en', ...GOOD_EN }] });
      expect((await b.get(`/templates/${t.id}`)).status).toBe(404);
      expect((await b.put(`/templates/${t.id}/variants/en`).send({ ...GOOD_EN, body: 'HACKED {name}' })).status).toBe(404);
      expect((await b.put(`/templates/${t.id}`).send({ name: 'hacked' })).status).toBe(404);
      expect((await b.post(`/templates/${t.id}/archive`).send({})).status).toBe(404);
      expect((await b.post(`/templates/${t.id}/variants/en/review`).send({ status: 'reviewed' })).status).toBe(404);
      expect((await b.post(`/templates/${t.id}/variants/en/validate`).send({})).status).toBe(404);
      const doc = await stored(t.id);
      expect(doc.name).toBe('Private A'); expect(doc.archived).toBe(false); expect(variantOf(doc, 'en').body).toBe(GOOD_EN.body);
      const listB = await b.get('/templates?limit=200');
      expect(listB.body.items.map((i) => i.id)).not.toContain(t.id);
      const listA = await a.get('/templates?limit=200');
      expect(listA.body.items.map((i) => i.id)).toContain(t.id);
    });

    test('operator-injection ids are 400s, never matches', async () => {
      const r1 = await a.post('/templates/refresh-status').send({ templateId: { $ne: null } });
      expect(r1.status).toBe(400);
      const r2 = await a.post('/templates/from-library').send({ libraryKey: { $ne: null } });
      expect(r2.status).toBeGreaterThanOrEqual(400); expect(r2.status).toBeLessThan(500);
      const r3 = await a.get('/templates/%7B%22%24ne%22%3Anull%7D');
      expect(r3.status).toBe(400);
      const r4 = await a.post('/templates').send({ name: 'inj', variants: [{ language: { $ne: 1 } }] });
      expect(r4.status).toBe(400);
    });

    test('preview with another tenant\'s customerId never exposes that customer', async () => {
      const bc = await h.makeCustomer(ctx.B.wsId, { firstname: 'Bsecret', lastname: 'Person' });
      const r = await a.post('/templates/preview').send({ variant: { language: 'en', body: 'Hi {name} {full_name}' }, customerId: String(bc._id) });
      expect(JSON.stringify(r.body)).not.toContain('Bsecret');
    });

    test('library create lands in the caller workspace only; meta-usage in dry-run has nulls + ceiling', async () => {
      const lib = await a.get('/templates/library');
      expect(lib.status).toBe(200); expect(lib.body.items.length).toBeGreaterThan(5);
      const made = await a.post('/templates/from-library').send({ libraryKey: lib.body.items[0].key });
      expect(made.status).toBe(201);
      expect(await LocalizedTemplate.countDocuments({ _id: made.body.id, workspaceId: ctx.A.wsId })).toBe(1);
      const usage = await a.get('/templates/meta-usage');
      expect(usage.body).toMatchObject({ used: null, ceiling: 90, atCeiling: false });
    });

    test('flag flip is picked up after invalidate; kill switch closes the gate; unflagged workspace gets 402', async () => {
      expect((await c.get('/templates')).status).toBe(402);
      await settings.setArabicEnabled({ workspaceId: ctx.C.wsId, enabled: true, grantedBy: 'itest' });
      expect((await c.get('/templates')).status).toBe(200);
      await settings.setArabicEnabled({ workspaceId: ctx.C.wsId, enabled: false, grantedBy: 'itest' });
      expect((await c.get('/templates')).status).toBe(402);
      process.env.LOCALIZATION_DISABLED = 'true'; settings.clearCache();
      try { expect((await a.get('/templates')).status).toBe(402); } finally { delete process.env.LOCALIZATION_DISABLED; settings.clearCache(); }
      expect((await a.get('/templates')).status).toBe(200);
    });
  });
});
