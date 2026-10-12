// Tests for shared/localization/overview.js (hub counters + review summary) and the two routes that
// serve it. Models are in-memory fakes that apply the exact filters the service builds, so tenant
// scoping, the demo/erased exclusions and the status buckets are really exercised. No DB, no network.
const express = require('express');
const request = require('supertest');
const { createOverviewService } = require('../../shared/localization/overview');

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';

function matches(doc, filter) {
  return Object.entries(filter).every(([k, c]) => {
    if (k === '$or') return c.some((f) => matches(doc, f));
    const v = doc[k];
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      const [op] = Object.keys(c);
      if (op === '$ne') return v !== c.$ne && !(c.$ne === null && v == null);
      if (op === '$exists') return c.$exists === (v !== undefined);
      if (op === '$in') return c.$in.map(String).includes(String(v));
      throw new Error(`fake: unsupported ${k}: ${JSON.stringify(c)}`);
    }
    return v === c;
  });
}

function fakeModel(rows) {
  const rowsOf = (f) => rows.filter((r) => matches(r, f));
  return {
    countDocuments: async (f) => rowsOf(f).length,
    find: (f) => { const q = { select: () => q, limit: () => q, lean: () => q, then: (a, b) => Promise.resolve(rowsOf(f)).then(a, b) }; return q; },
    findOne: (f) => {
      let list = rowsOf(f);
      const q = { sort: (s) => { const [[k, d]] = Object.entries(s); list = [...list].sort((x, y) => d * (x[k] - y[k])); return q; }, select: () => q, lean: () => q, then: (a, b) => Promise.resolve(list[0] || null).then(a, b) };
      return q;
    },
  };
}

const variant = (language, metaStatus, reviewStatus = 'draft', body = 'نص') => ({ language, metaStatus, reviewStatus, body });

function service(data = {}) {
  return createOverviewService({
    Customer: fakeModel(data.customers || []),
    CustomerLanguage: fakeModel(data.languages || []),
    LocalizedTemplate: fakeModel(data.templates || []),
    LocalizedCampaign: fakeModel(data.campaigns || []),
    ProductTranslation: fakeModel(data.translations || []),
    Product: fakeModel(data.products || []),
    Service: fakeModel(data.services || []),
    catalog: { counts: () => ({ total: 10, arabicTotal: 8, arabicDraft: 6, arabicReviewed: 2, arabicMissing: 2, needsLegalApproval: 1 }) },
  });
}

describe('overview', () => {
  test('an empty workspace is all zeros (backend string draft count still reported)', async () => {
    const out = await service().overview(A);
    expect(out).toEqual({
      customers: { total: 0, en: 0, ar: 0, unknown: 0 },
      templates: { total: 0, withArabic: 0, arabicApproved: 0, arabicPending: 0, arabicRejected: 0, arabicNotSubmitted: 0, arabicOther: 0 },
      campaigns: { total: 0, lastSentAt: null },
      review: { templatesDraft: 0, catalogDraft: 0, backendStringsDraft: 6 },
    });
  });

  test('mixed data: customers exclude erased and demo (and their language rows), unknown = total - en - ar, other tenants excluded', async () => {
    const out = await service({
      customers: [
        { _id: 'c1', workspaceId: A }, { _id: 'c2', workspaceId: A }, { _id: 'c3', workspaceId: A }, { _id: 'c4', workspaceId: A },
        { _id: 'c5', workspaceId: A, isDemo: true }, { _id: 'c6', workspaceId: A, deletedAt: new Date() }, { _id: 'c7', workspaceId: B },
      ],
      languages: [
        { workspaceId: A, customerId: 'c1', language: 'en' }, { workspaceId: A, customerId: 'c2', language: 'ar' }, { workspaceId: A, customerId: 'c3', language: 'unknown' },
        // sidecar rows of a demo and an erased customer must not inflate the hub (the Customers page already ignores them)
        { workspaceId: A, customerId: 'c5', language: 'en' }, { workspaceId: A, customerId: 'c6', language: 'ar' },
        { workspaceId: B, customerId: 'c7', language: 'ar' },
      ],
    }).overview(A);
    expect(out.customers).toEqual({ total: 4, en: 1, ar: 1, unknown: 2 });
  });

  test('unknown never goes negative when language rows outnumber live customers', async () => {
    const out = await service({ customers: [{ workspaceId: A }], languages: [{ workspaceId: A, language: 'ar' }, { workspaceId: A, language: 'ar' }] }).overview(A);
    expect(out.customers.unknown).toBe(0);
  });

  test('Arabic variant statuses fall into the documented buckets; English, empty and archived are not counted', async () => {
    const statuses = {
      APPROVED: 'arabicApproved', PENDING: 'arabicPending', IN_APPEAL: 'arabicPending', REJECTED: 'arabicRejected', DISABLED: 'arabicRejected',
      ERROR: 'arabicRejected', NOT_CREATED: 'arabicNotSubmitted', PAUSED: 'arabicOther', ARCHIVED: 'arabicOther', DELETED: 'arabicOther',
      PENDING_DELETION: 'arabicOther', LIMIT_EXCEEDED: 'arabicOther', SOMETHING_NEW: 'arabicOther',
    };
    const templates = Object.keys(statuses).map((s) => ({ workspaceId: A, variants: [variant('en', 'APPROVED', 'reviewed'), variant('ar', s)] }));
    templates.push({ workspaceId: A, variants: [variant('en', 'APPROVED')] });
    templates.push({ workspaceId: A, variants: [variant('ar', 'APPROVED', 'draft', '   ')] });
    templates.push({ workspaceId: A, archived: true, variants: [variant('ar', 'APPROVED')] });
    templates.push({ workspaceId: B, variants: [variant('ar', 'APPROVED')] });
    const { templates: t } = await service({ templates }).overview(A);
    expect(t.total).toBe(Object.keys(statuses).length + 2);
    expect(t.withArabic).toBe(Object.keys(statuses).length);
    expect(t).toMatchObject({ arabicApproved: 1, arabicPending: 2, arabicRejected: 3, arabicNotSubmitted: 1, arabicOther: 6 });
  });

  test('a variant with no metaStatus counts as not submitted; bilingual counts as Arabic-bearing', async () => {
    const { templates: t } = await service({ templates: [{ workspaceId: A, variants: [{ language: 'bilingual', body: 'x' }] }] }).overview(A);
    expect(t).toMatchObject({ withArabic: 1, arabicNotSubmitted: 1 });
  });

  test('review drafts: non-English non-empty draft variants, product translations, backend strings', async () => {
    const out = await service({
      templates: [{ workspaceId: A, variants: [variant('en', 'APPROVED', 'draft'), variant('ar', 'APPROVED', 'draft'), variant('bilingual', 'PENDING', 'reviewed')] }],
      translations: [
        { workspaceId: A, language: 'ar', kind: 'product', status: 'draft' }, { workspaceId: A, language: 'ar', kind: 'service', status: 'reviewed' },
        { workspaceId: B, language: 'ar', kind: 'product', status: 'draft' },
      ],
    }).overview(A);
    expect(out.review).toEqual({ templatesDraft: 1, catalogDraft: 1, backendStringsDraft: 6 });
  });

  test('campaigns: count for this workspace, last sent = newest finishedAt as ISO', async () => {
    const out = await service({
      campaigns: [
        { workspaceId: A, finishedAt: new Date('2026-10-01T10:00:00Z') }, { workspaceId: A, finishedAt: new Date('2026-10-05T10:00:00Z') },
        { workspaceId: A }, { workspaceId: B, finishedAt: new Date('2026-12-01T00:00:00Z') },
      ],
    }).overview(A);
    expect(out.campaigns).toEqual({ total: 3, lastSentAt: '2026-10-05T10:00:00.000Z' });
  });
});

describe('reviewSummary', () => {
  test('counts template variants, translations (with missing) and backend strings for this workspace only', async () => {
    const out = await service({
      templates: [
        { workspaceId: A, variants: [variant('ar', 'APPROVED', 'reviewed'), variant('ar', 'PENDING', 'draft'), variant('en', 'APPROVED', 'draft')] },
        { workspaceId: B, variants: [variant('ar', 'APPROVED', 'draft')] },
      ],
      translations: [
        { workspaceId: A, language: 'ar', kind: 'product', status: 'draft' }, { workspaceId: A, language: 'ar', kind: 'product', status: 'reviewed' },
        { workspaceId: B, language: 'ar', kind: 'service', status: 'draft' },
      ],
      products: [{ workspaceId: A }, { workspaceId: A }, { workspaceId: A }, { workspaceId: A, active: false }, { workspaceId: B }],
      services: [{ workspaceId: A }, { workspaceId: A }],
    }).reviewSummary(A);
    expect(out).toEqual({
      templates: { draft: 1, reviewed: 1 },
      catalog: { draft: 1, reviewed: 1, missing: 1 + 2 },
      backendStrings: { total: 10, draft: 6, reviewed: 2, needsLegalApproval: 1 },
    });
  });

  test('missing never goes negative (more translations than live items)', async () => {
    const out = await service({ translations: [{ workspaceId: A, language: 'ar', kind: 'product', status: 'draft' }], products: [] }).reviewSummary(A);
    expect(out.catalog.missing).toBe(0);
  });
});

describe('routes', () => {
  function app(mod, mountPath, user = { workspaceId: A }) {
    const a = express();
    a.use((req, res, next) => { req.user = user; next(); });
    a.use(mountPath, mod);
    return a;
  }

  test('GET /settings/overview and /review/summary use only the token workspace', async () => {
    jest.resetModules();
    const overviewMock = { overview: jest.fn(async () => ({ ok: 'overview' })), reviewSummary: jest.fn(async () => ({ ok: 'review' })) };
    jest.doMock('../../shared/localization/overview', () => overviewMock);
    const settingsRouter = require('../../routes/localization/settings');
    const reviewRouter = require('../../routes/localization/review');
    const o = await request(app(settingsRouter, '/settings')).get('/settings/overview?workspaceId=' + B);
    expect(o.status).toBe(200);
    expect(o.body).toEqual({ ok: 'overview' });
    expect(overviewMock.overview).toHaveBeenCalledWith(A);
    const r = await request(app(reviewRouter, '/review')).get('/review/summary');
    expect(r.body).toEqual({ ok: 'review' });
    expect(overviewMock.reviewSummary).toHaveBeenCalledWith(A);
    jest.dontMock('../../shared/localization/overview');
  });

  test('a service failure is a generic 500 with no internals', async () => {
    jest.resetModules();
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../../shared/localization/overview', () => ({ reviewSummary: async () => { throw new Error('cosmos key abc123'); } }));
    const reviewRouter = require('../../routes/localization/review');
    const res = await request(app(reviewRouter, '/review')).get('/review/summary');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('abc123');
    jest.dontMock('../../shared/localization/overview');
  });

  test('the review mount sits behind the Arabic flag', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../routes/localization/index.js'), 'utf8');
    expect(src).toMatch(/router\.use\('\/review', requireArabicEnabled, require\('\.\/review'\)\)/);
  });
});
