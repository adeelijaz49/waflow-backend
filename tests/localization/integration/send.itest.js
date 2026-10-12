const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for the sending side of the Arabic localisation
// feature (slice B3): audience queries, the localised sender (dry-run), crash
// recovery, cancel / consent changes mid-run, and tenant isolation.
// Transport is the real transport.js in LOCALIZATION_SEND_MODE=dry_run: nothing
// ever reaches WhatsApp. Every test uses its own workspace; nothing is deleted.
const fx = require('./_fixtures');
const mongoose = require('mongoose');
const campaigns = require('../../../shared/localization/campaigns');
const sender = require('../../../shared/localization/campaignSender');
const audience = require('../../../shared/localization/audience');
const transport = require('../../../shared/localization/transport');
const Customer = require('../../../models/Customer');
const Order = require('../../../models/Order');
const LocalizedCampaign = require('../../../models/LocalizedCampaign');
const LocalizedSend = require('../../../models/LocalizedSend');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');

jest.setTimeout(60000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => transport.clearDryRuns());

// Sender deps for in-process runs: real models, real dry-run transport, no real sleeping,
// and the background job captured so the test decides when it runs.
function makeDeps({ onSleep } = {}) {
  const jobs = [];
  const deps = {
    ...campaigns.realDeps(),
    sleep: async () => { if (onSleep) await onSleep(); },
    schedule: (fn) => { jobs.push(fn); },
    log: () => {},
  };
  return { deps, jobs, runJobs: async () => { while (jobs.length) await jobs.shift()(); } };
}

async function newCampaign(ws, template, { audience: spec = { kind: 'all_eligible' }, languageMode = 'per_customer', fieldValues = {}, deps } = {}) {
  return campaigns.create({
    workspaceId: ws.workspaceId, userId: ws.user._id,
    body: { name: 'Eid offer', templateId: String(template._id), languageMode, audience: spec, fieldValues },
  }, deps);
}

async function rowsByStatus(campaignId) {
  const rows = await LocalizedSend.find({ campaignId }).lean();
  const out = {};
  for (const r of rows) (out[r.status] = out[r.status] || []).push(r);
  return { rows, out };
}

describe('audience resolution on real MongoDB', () => {
  let ws; let other;
  const day = 24 * 60 * 60 * 1000;
  const c = {};

  beforeAll(async () => {
    ws = await fx.makeWorkspace();
    other = await fx.makeWorkspace();
    c.ok = await fx.makeCustomer(ws.workspaceId, { firstname: 'Ok', loyaltyPoints: 120, language: 'ar' });
    c.noConsent = await fx.makeCustomer(ws.workspaceId, { firstname: 'NoConsent', marketingConsent: false, loyaltyPoints: 500 });
    c.optedOut = await fx.makeCustomer(ws.workspaceId, { firstname: 'Out', optedOut: true });
    c.demo = await fx.makeCustomer(ws.workspaceId, { firstname: 'Demo', isDemo: true });
    c.badPhone = await fx.makeCustomer(ws.workspaceId, { firstname: 'Bad', phone: '0551234567' });
    c.dupA = await fx.makeCustomer(ws.workspaceId, { firstname: 'DupA', phone: '966500111222' });
    c.dupB = await fx.makeCustomer(ws.workspaceId, { firstname: 'DupB', phone: '966500111222' });
    c.erased = await fx.makeCustomer(ws.workspaceId, { firstname: 'Erased', deletedAt: new Date() });
    c.foreign = await fx.makeCustomer(other.workspaceId, { firstname: 'Foreign' });
    // orders: Ok ordered 60 days ago (inactive 30d), NoConsent ordered 2 days ago, a cancelled recent order must not count
    await Order.create({ workspaceId: ws.workspaceId, customer: c.ok._id, status: 'delivered', createdAt: new Date(Date.now() - 60 * day) });
    await Order.create({ workspaceId: ws.workspaceId, customer: c.noConsent._id, status: 'delivered', createdAt: new Date(Date.now() - 2 * day) });
    await Order.create({ workspaceId: ws.workspaceId, customer: c.optedOut._id, status: 'delivered', createdAt: new Date(Date.now() - 90 * day) });
    await Order.create({ workspaceId: ws.workspaceId, customer: c.ok._id, status: 'cancelled', createdAt: new Date(Date.now() - 1 * day) });
    // a foreign workspace order for an otherwise-stale customer must not leak
    await Order.create({ workspaceId: other.workspaceId, customer: c.foreign._id, status: 'delivered', createdAt: new Date(Date.now() - 400 * day) });
  });

  const ids = (res) => res.customers.map((x) => x.id);
  const resolve = (spec, category = 'MARKETING') => audience.resolveAudience({ workspaceId: ws.workspaceId, audience: spec, category });

  test('all_eligible MARKETING: only consented, not opted-out, non-demo, valid, de-duplicated customers; the rest are counted', async () => {
    const res = await resolve({ kind: 'all_eligible' });
    const sendable = res.customers.filter((x) => !x.skip).map((x) => x.id).sort();
    expect(sendable).toEqual([String(c.ok._id), String(c.dupA._id)].sort());
    expect(res.skipped.demo).toBe(1);
    expect(res.skipped.optedOut).toBe(1);
    expect(res.skipped.noConsent).toBe(1);
    expect(res.skipped.invalidPhone).toBe(1);
    expect(res.skipped.duplicatePhone).toBe(1);
    expect(ids(res)).not.toContain(String(c.foreign._id));
    expect(ids(res)).not.toContain(String(c.erased._id));
  });

  test('all_eligible UTILITY does not need marketing consent but still skips opted-out and demo', async () => {
    const res = await resolve({ kind: 'all_eligible' }, 'UTILITY');
    const sendable = new Set(res.customers.filter((x) => !x.skip).map((x) => x.id));
    expect(sendable.has(String(c.noConsent._id))).toBe(true);
    expect(sendable.has(String(c.optedOut._id))).toBe(false);
    expect(sendable.has(String(c.demo._id))).toBe(false);
  });

  test('segment has_points', async () => {
    const res = await resolve({ kind: 'segment', segmentKey: 'has_points', segmentParams: { minPoints: 100 } });
    expect(new Set(ids(res))).toEqual(new Set([String(c.ok._id), String(c.noConsent._id)]));
    expect(res.customers.find((x) => x.id === String(c.ok._id)).skip).toBeNull();
    expect(res.customers.find((x) => x.id === String(c.noConsent._id)).skip).toBe('no_consent');
  });

  test('segment inactive_days: latest NON-cancelled order older than N days, this workspace only', async () => {
    const res = await resolve({ kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 30 } });
    const got = new Set(ids(res));
    // ok: the recent order is cancelled, its latest real order is 60 days old => inactive
    expect(got.has(String(c.ok._id))).toBe(true);
    expect(got.has(String(c.noConsent._id))).toBe(false); // ordered 2 days ago
    expect(got.has(String(c.foreign._id))).toBe(false);   // other workspace's order
    expect(got.has(String(c.demo._id))).toBe(false);      // never ordered => not inactive
    expect(res.customers.find((x) => x.id === String(c.optedOut._id)).skip).toBe('opted_out');
  });

  test('segment awaiting_consent: not consented and not opted out', async () => {
    const res = await resolve({ kind: 'segment', segmentKey: 'awaiting_consent', segmentParams: {} }, 'UTILITY');
    const got = new Set(ids(res));
    expect(got.has(String(c.noConsent._id))).toBe(true);
    expect(got.has(String(c.ok._id))).toBe(false);
    expect(got.has(String(c.optedOut._id))).toBe(false);
  });

  test('segment language ar / unknown', async () => {
    const ar = await resolve({ kind: 'segment', segmentKey: 'language', segmentParams: { language: 'ar' } });
    expect(ids(ar)).toEqual([String(c.ok._id)]);
    const unknown = await resolve({ kind: 'segment', segmentKey: 'language', segmentParams: { language: 'unknown' } });
    expect(ids(unknown)).not.toContain(String(c.ok._id));
    expect(ids(unknown)).toContain(String(c.noConsent._id));
  });

  test('customer_ids ignores other tenants and counts them as notFound; operator injection is rejected', async () => {
    const res = await resolve({ kind: 'customer_ids', customerIds: [String(c.ok._id), String(c.foreign._id)] });
    expect(ids(res)).toEqual([String(c.ok._id)]);
    expect(res.notFound).toBe(1);
    await expect(resolve({ kind: 'customer_ids', customerIds: [{ $ne: null }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe('end to end: plan -> create -> send (dry run)', () => {
  let ws; let tpl; let sara; let layla; let unknownLang; let noConsent; let optedOut; let demo;

  beforeAll(async () => {
    ws = await fx.makeWorkspace({ merchantName: 'Aroma Cafe' });
    tpl = await fx.makeTemplate(ws.workspaceId, { languages: ['en', 'ar'] });
    sara = await fx.makeCustomer(ws.workspaceId, { firstname: 'Sara', loyaltyPoints: 7, language: 'en' });
    layla = await fx.makeCustomer(ws.workspaceId, { firstname: 'ليلى', loyaltyPoints: 42, language: 'ar' });
    unknownLang = await fx.makeCustomer(ws.workspaceId, { firstname: 'Omar', loyaltyPoints: 1 });
    noConsent = await fx.makeCustomer(ws.workspaceId, { firstname: 'Nora', marketingConsent: false });
    optedOut = await fx.makeCustomer(ws.workspaceId, { firstname: 'Out', optedOut: true });
    demo = await fx.makeCustomer(ws.workspaceId, { firstname: 'Dee', isDemo: true });
  });

  test('plan shows recipients per language and the skip counters', async () => {
    const plan = await campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' } } });
    expect(plan.canSend).toBe(true);
    expect(plan.audience.eligible).toBe(3);
    expect(plan.byLanguage.ar).toBe(1);
    expect(plan.byLanguage.en).toBe(2);
    expect(plan.skipped.demo).toBe(1);
    expect(plan.skipped.optedOut).toBe(1);
    expect(plan.skipped.noConsent).toBe(1);
  });

  test('sends each customer their own language, records rows and stats, writes no CampaignMessage in dry run', async () => {
    const { deps, runJobs } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    expect(created.status).toBe('draft');

    const started = await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    expect(started.campaign.status).toBe('sending');
    await runJobs();

    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.status).toBe('sent');
    // all_eligible: customers outside the eligibility query (no consent / opted out) are only COUNTED in the plan, not snapshotted
    expect(campaign.stats).toMatchObject({ total: 4, sent: 3, failed: 0, skipped: 1 });
    expect(campaign.stats.byLanguage).toMatchObject({ en: 2, ar: 1, bilingual: 0 });
    expect(campaign.finishedAt).toBeTruthy();

    const { rows, out } = await rowsByStatus(campaign._id);
    expect(out.sent).toHaveLength(3);
    expect(out.skipped_demo).toHaveLength(1);
    expect(rows).toHaveLength(4);
    const arRow = out.sent.find((r) => String(r.customerId) === String(layla._id));
    expect(arRow).toMatchObject({ usedLanguage: 'ar', fallback: false });
    const arVariant = tpl.variants.find((v) => v.language === 'ar');
    expect(arRow.metaTemplateName).toBe(arVariant.metaTemplateName);
    expect(arRow.wamid).toMatch(/^dryrun\./);
    // the unknown-language customer falls back to the merchant default (en) - "per_customer" is not a fallback to flag
    const unknownRow = out.sent.find((r) => String(r.customerId) === String(unknownLang._id));
    expect(unknownRow.usedLanguage).toBe('en');

    // what would have gone to Meta
    const dry = transport.lastDryRuns();
    expect(dry).toHaveLength(3);
    const toLayla = dry.find((d) => d.payload.to === arRow.phone);
    expect(toLayla.payload.template.name).toBe(arVariant.metaTemplateName);
    expect(toLayla.payload.template.language.code).toBe('ar');
    const bodyParams = toLayla.payload.template.components.find((x) => x.type === 'body').parameters.map((p) => p.text);
    expect(bodyParams.join('|')).toContain('ليلى');
    expect(bodyParams.join('|')).toContain('42');
    expect(bodyParams.join('|')).toContain('Aroma Cafe');
    const optout = toLayla.payload.template.components.find((x) => x.type === 'button');
    expect(optout.parameters[0].payload).toBe(`optout_${campaign._id}`);
    // never to demo / opted-out / no-consent numbers
    const sentTo = new Set(dry.map((d) => d.payload.to));
    for (const blocked of [noConsent, optedOut, demo]) expect(sentTo.has(blocked.phone)).toBe(false);

    // dry run must not alter customer/delivery state
    expect(await CampaignMessage.countDocuments({ workspaceId: ws.workspaceId })).toBe(0);

    // report + recipients aggregations on real Mongo
    const report = await campaigns.report({ workspaceId: ws.workspaceId, id: created.id });
    expect(report.stats).toMatchObject({ total: 4, sent: 3, skipped: 1 });
    expect(report.byStatus).toMatchObject({ sent: 3, skipped_demo: 1 });
    expect(report.byLanguage.ar.sent).toBe(1);
    expect(report.byLanguage.en.sent).toBe(2);
    expect(report.fallbackCount).toBe(0);

    const page = await campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: { status: 'sent', language: 'ar' } });
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({ name: 'ليلى Test', usedLanguage: 'ar', status: 'sent', deliveryStatus: 'sent' });
    const paged = await campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: { page: 2, limit: 3 } });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(4);
  });

  test('double send: exactly one claim wins, the other is 409 CAMPAIGN_NOT_DRAFT, and nobody is messaged twice', async () => {
    const ws2 = await fx.makeWorkspace();
    const tpl2 = await fx.makeTemplate(ws2.workspaceId);
    await fx.makeCustomer(ws2.workspaceId, { language: 'ar' });
    await fx.makeCustomer(ws2.workspaceId, { language: 'en' });
    const { deps, jobs, runJobs } = makeDeps();
    const created = await newCampaign(ws2, tpl2, { deps });
    const results = await Promise.allSettled([
      sender.startSend({ workspaceId: ws2.workspaceId, campaignId: created.id }, deps),
      sender.startSend({ workspaceId: ws2.workspaceId, campaignId: created.id }, deps),
      sender.startSend({ workspaceId: ws2.workspaceId, campaignId: created.id }, deps),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason).toMatchObject({ status: 409, code: 'CAMPAIGN_NOT_DRAFT' });
    expect(jobs).toHaveLength(1);
    await runJobs();
    expect(await LocalizedSend.countDocuments({ campaignId: created.id })).toBe(2);
    expect(transport.lastDryRuns()).toHaveLength(2);
    // a late retry after completion is also refused
    await expect(sender.startSend({ workspaceId: ws2.workspaceId, campaignId: created.id }, deps)).rejects.toMatchObject({ status: 409 });
  });

  test('the unique (campaignId, customerId) index makes a repeated snapshot insert ordered:false idempotent', async () => {
    const campaignId = new mongoose.Types.ObjectId();
    const rows = [1, 2, 3].map((n) => ({ workspaceId: ws.workspaceId, campaignId, customerId: new mongoose.Types.ObjectId(), phone: `96650000000${n}`, status: 'queued' }));
    await LocalizedSend.insertMany(rows, { ordered: false });
    const again = [...rows, { ...rows[0], customerId: new mongoose.Types.ObjectId(), phone: '966500000009' }];
    let error;
    try { await LocalizedSend.insertMany(again, { ordered: false }); } catch (err) { error = err; }
    expect(error).toBeTruthy();
    expect(sender.isDuplicateOnly(error)).toBe(true);
    // the genuinely new row still got written (ordered:false), the repeats did not duplicate
    expect(await LocalizedSend.countDocuments({ campaignId })).toBe(4);
  });
});

describe('fallbacks and acknowledgement', () => {
  test('an unapproved Arabic variant needs acknowledgement, then falls back to English and says so in the report', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, {
      variants: [fx.variant('en'), fx.variant('ar', { metaStatus: 'PENDING' })],
    });
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const { deps, runJobs } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps)).rejects.toMatchObject({ status: 422, code: 'PLAN_NEEDS_ACK' });
    expect((await LocalizedCampaign.findById(created.id).lean()).status).toBe('draft');

    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id, acknowledge: { fallbacks: true } }, deps);
    await runJobs();
    const report = await campaigns.report({ workspaceId: ws.workspaceId, id: created.id });
    expect(report.fallbackCount).toBe(1);
    expect(report.byLanguage.en.sent).toBe(2);
    expect(report.byLanguage.ar.sent).toBe(0);
    const rec = await campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: {} });
    const fb = rec.items.find((i) => i.fallback);
    expect(fb).toMatchObject({ requestedLanguage: 'ar', usedLanguage: 'en', status: 'sent' });
    expect(fb.fallbackReason).toBeTruthy();
  });

  test('explicit Arabic mode blocks customers without an approved Arabic variant (never silently English)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { variants: [fx.variant('en'), fx.variant('ar', { reviewStatus: 'draft' })] });
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const { deps } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps, languageMode: 'ar' });
    // nothing is usable in this campaign
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id, acknowledge: { blocked: true } }, deps))
      .rejects.toMatchObject({ status: 422, code: 'TEMPLATE_UNUSABLE' });
    expect(transport.lastDryRuns()).toHaveLength(0);
  });
});

describe('mid-run changes', () => {
  async function scenario(count = 4) {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const customers = [];
    for (let i = 0; i < count; i += 1) customers.push(await fx.makeCustomer(ws.workspaceId, { firstname: `C${i}`, language: i % 2 ? 'ar' : 'en' }));
    // snapshot rows are processed in _id order = customers are inserted in id order
    return { ws, tpl, customers };
  }

  test('consent revoked mid-run: that customer is skipped_opted_out and never messaged', async () => {
    const { ws, tpl, customers } = await scenario(4);
    let sleeps = 0;
    const { deps, runJobs } = makeDeps({
      onSleep: async () => {
        sleeps += 1;
        if (sleeps === 1) await Customer.updateOne({ _id: customers[2]._id }, { $set: { optedOut: true } });
      },
    });
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    const { rows } = await rowsByStatus(created.id);
    const status = (cust) => rows.find((r) => String(r.customerId) === String(cust._id)).status;
    const order = [...customers].sort((a, b) => String(a._id).localeCompare(String(b._id)));
    expect(status(customers[2])).toBe('skipped_opted_out');
    expect(transport.lastDryRuns().map((d) => d.payload.to)).not.toContain(customers[2].phone);
    expect(order.filter((x) => status(x) === 'sent')).toHaveLength(3);
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    // a policy skip (opted out) does not make the campaign "partial"
    expect(['sent', 'partial']).toContain(campaign.status);
    expect(campaign.stats).toMatchObject({ sent: 3, skipped: 1 });
  });

  test('cancel mid-run: sending stops, unsent recipients are closed (not deleted), campaign stays cancelled', async () => {
    const { ws, tpl } = await scenario(5);
    let sleeps = 0;
    let cancelPromise;
    const { deps, runJobs } = makeDeps({
      onSleep: async () => {
        sleeps += 1;
        if (sleeps === 2) cancelPromise = campaigns.cancel({ workspaceId: ws.workspaceId, id: String(created.id) }, deps);
        if (cancelPromise) await cancelPromise;
      },
    });
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.status).toBe('cancelled');
    const { rows, out } = await rowsByStatus(created.id);
    expect(rows).toHaveLength(5); // nothing deleted
    expect(out.sent).toHaveLength(2);
    expect(out.skipped_error).toHaveLength(3);
    expect(out.skipped_error.every((r) => r.errorCode === 'cancelled')).toBe(true);
    expect(out.queued).toBeUndefined();
    expect(transport.lastDryRuns()).toHaveLength(2);
    expect(campaign.stats.sent).toBe(2);
    // cancelling again is a harmless no-op
    const again = await campaigns.cancel({ workspaceId: ws.workspaceId, id: String(created.id) }, deps);
    expect(again.status).toBe('cancelled');
  });

  test('a failing transport keeps the campaign going: failed rows carry the Meta error code, status partial', async () => {
    const { ws, tpl, customers } = await scenario(3);
    const { deps, runJobs } = makeDeps();
    const real = deps.transport;
    let calls = 0;
    deps.transport = {
      ...real,
      sendTemplate: async (to, args) => {
        calls += 1;
        if (calls === 2) {
          const err = new Error('Request failed');
          err.response = { data: { error: { code: 131026, message: 'Message undeliverable' } } };
          throw err;
        }
        return real.sendTemplate(to, args);
      },
    };
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.status).toBe('partial');
    expect(campaign.stats).toMatchObject({ sent: 2, failed: 1 });
    const failed = await LocalizedSend.findOne({ campaignId: created.id, status: 'failed' }).lean();
    expect(failed.errorCode).toBe('131026');
    expect(campaign.lastError).toContain('131026');
    expect(customers).toHaveLength(3);
  });
});

describe('crash recovery (resumeStuckCampaigns)', () => {
  async function stuckCampaign({ attempts = 1 } = {}) {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const customers = [];
    for (let i = 0; i < 4; i += 1) customers.push(await fx.makeCustomer(ws.workspaceId, { firstname: `R${i}`, language: i % 2 ? 'ar' : 'en' }));
    const { deps, runJobs } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    // Simulate the crash: the runner never ran. Rows exist for 2 customers: one already
    // SENT, one stuck in `sending` (outcome unknown); the other two were never written.
    const [a, b] = customers;
    await LocalizedSend.create({ workspaceId: ws.workspaceId, campaignId: created.id, customerId: a._id, phone: a.phone, status: 'sent', usedLanguage: 'en', wamid: 'wamid.before-crash' });
    await LocalizedSend.create({ workspaceId: ws.workspaceId, campaignId: created.id, customerId: b._id, phone: b.phone, status: 'sending', usedLanguage: 'ar' });
    // drop the captured (never run) first job: the process "died"
    deps.schedule = () => {};
    transport.clearDryRuns();
    await LocalizedCampaign.updateOne({ _id: created.id }, { $set: { lastHeartbeatAt: new Date(Date.now() - 20 * 60 * 1000), runAttempts: attempts, claimedBy: 'dead-runner' } });
    return { ws, tpl, customers, created, deps };
  }

  test('a stale heartbeat is taken over by exactly one of two concurrent resumers; sent rows are never re-sent, an interrupted row is failed not retried', async () => {
    const { ws, customers, created } = await stuckCampaign();
    const a = makeDeps(); const b = makeDeps();
    const [ra, rb] = await Promise.all([
      sender.resumeStuckCampaigns({ idleMs: 5 * 60 * 1000 }, a.deps),
      sender.resumeStuckCampaigns({ idleMs: 5 * 60 * 1000 }, b.deps),
    ]);
    expect(ra.resumed + rb.resumed).toBe(1);
    await Promise.all([a.runJobs(), b.runJobs()]);

    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.runAttempts).toBe(2);
    expect(['sent', 'partial']).toContain(campaign.status);
    const { rows } = await rowsByStatus(created.id);
    expect(rows).toHaveLength(4); // idempotent snapshot: no duplicates
    const byCust = (c) => rows.find((r) => String(r.customerId) === String(c._id));
    expect(byCust(customers[0])).toMatchObject({ status: 'sent', wamid: 'wamid.before-crash' });
    expect(byCust(customers[1])).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(byCust(customers[2]).status).toBe('sent');
    expect(byCust(customers[3]).status).toBe('sent');
    const reached = transport.lastDryRuns().map((d) => d.payload.to);
    expect(reached.sort()).toEqual([customers[2].phone, customers[3].phone].sort());
    expect(reached).not.toContain(customers[0].phone);
    expect(reached).not.toContain(customers[1].phone);
    expect(ws).toBeTruthy();
  });

  test('a fresh heartbeat is left alone; a campaign that keeps dying is failed instead of resumed forever', async () => {
    const fresh = await stuckCampaign();
    await LocalizedCampaign.updateOne({ _id: fresh.created.id }, { $set: { lastHeartbeatAt: new Date() } });
    const d1 = makeDeps();
    const res1 = await sender.resumeStuckCampaigns({ idleMs: 5 * 60 * 1000 }, d1.deps);
    expect(res1.resumed).toBe(0);
    expect((await LocalizedCampaign.findById(fresh.created.id).lean()).status).toBe('sending');

    const dying = await stuckCampaign({ attempts: sender.MAX_RUN_ATTEMPTS });
    const d2 = makeDeps();
    const res2 = await sender.resumeStuckCampaigns({ idleMs: 5 * 60 * 1000 }, d2.deps);
    expect(res2.failed).toBeGreaterThanOrEqual(1);
    expect((await LocalizedCampaign.findById(dying.created.id).lean()).status).toBe('failed');
  });

  test('a workspace whose Arabic flag is off is not resumed', async () => {
    const { ws, created } = await stuckCampaign();
    const settings = require('../../../shared/localization/settings');
    await settings.setArabicEnabled({ workspaceId: ws.workspaceId, enabled: false });
    const d = makeDeps();
    const res = await sender.resumeStuckCampaigns({ idleMs: 5 * 60 * 1000 }, d.deps);
    expect(res.resumed).toBe(0);
    expect((await LocalizedCampaign.findById(created.id).lean()).claimedBy).toBe('dead-runner');
  });
});

describe('sendSingle', () => {
  test('sends one customer synchronously in their language and records a campaign; refuses a customer without consent with a reason', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { category: 'UTILITY', useCase: 'loyalty_reminder' });
    const ar = await fx.makeCustomer(ws.workspaceId, { language: 'ar', loyaltyPoints: 9 });
    const none = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, optedOut: true });
    const { deps } = makeDeps();
    const res = await sender.sendSingle({ workspaceId: ws.workspaceId, templateId: tpl._id, customerId: ar._id }, deps);
    expect(res).toMatchObject({ sent: true, status: 'sent', usedLanguage: 'ar', fallback: false });
    expect(await LocalizedCampaign.countDocuments({ workspaceId: ws.workspaceId, 'audience.kind': 'customer_ids' })).toBe(1);
    const refused = await sender.sendSingle({ workspaceId: ws.workspaceId, templateId: tpl._id, customerId: none._id }, deps);
    expect(refused).toMatchObject({ sent: false, status: 'skipped_opted_out' });
    expect(transport.lastDryRuns()).toHaveLength(1);
  });
});

describe('the UTILITY floor (a marketing message cannot dodge consent by calling itself UTILITY)', () => {
  const utilityVariants = () => [fx.variant('en', { buttons: [], metaCategory: 'UTILITY' }), fx.variant('ar', { buttons: [], metaCategory: 'UTILITY' })];

  test('a promotion stored as UTILITY (and reported UTILITY by Meta) is planned and sent as MARKETING: no consent, no message; the plan says the floor acted', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, {
      category: 'UTILITY', useCase: 'promotion', variants: [fx.variant('en', { metaCategory: 'UTILITY' }), fx.variant('ar', { metaCategory: 'UTILITY' })],
    });
    const consented = await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const noConsent = await fx.makeCustomer(ws.workspaceId, { language: 'en', marketingConsent: false });
    const { deps, runJobs } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    const plan = await campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' }, fieldValues: {} } }, deps);
    expect(plan.category).toBe('MARKETING');
    expect(plan.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'promotion' } });
    expect(plan.skipped.noConsent).toBe(1);
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.category).toBe('MARKETING');
    expect(transport.lastDryRuns().map((d) => d.payload.to)).toEqual([consented.phone]);
    expect(await LocalizedSend.countDocuments({ campaignId: campaign._id, customerId: noConsent._id })).toBe(0); // never even queued
  });

  test('a UTILITY promotion without an opt-out button cannot be started (it is MARKETING)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { category: 'UTILITY', useCase: 'promotion', variants: utilityVariants() });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const { deps } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps)).rejects.toMatchObject({ status: 422, code: 'TEMPLATE_UNUSABLE' });
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('a transactional UTILITY template still needs no marketing consent (but never reaches an opted-out customer)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { category: 'UTILITY', useCase: 'booking_reminder', variants: utilityVariants() });
    const noConsent = await fx.makeCustomer(ws.workspaceId, { language: 'en', marketingConsent: false });
    await fx.makeCustomer(ws.workspaceId, { language: 'en', marketingConsent: false, optedOut: true });
    const { deps, runJobs } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    expect((await LocalizedCampaign.findById(created.id).lean()).category).toBe('UTILITY');
    expect(transport.lastDryRuns().map((d) => d.payload.to)).toEqual([noConsent.phone]);
  });
});

describe('two workspaces never see each other', () => {
  test('campaign get/send/cancel/recipients/report/list are tenant scoped', async () => {
    const a = await fx.makeWorkspace();
    const b = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(a.workspaceId);
    const custA = await fx.makeCustomer(a.workspaceId, { language: 'ar' });
    const custB = await fx.makeCustomer(b.workspaceId, { language: 'ar' });
    const { deps } = makeDeps();
    const created = await newCampaign(a, tpl, { deps });

    await expect(campaigns.get({ workspaceId: b.workspaceId, id: created.id })).rejects.toMatchObject({ status: 404, code: 'CAMPAIGN_NOT_FOUND' });
    await expect(sender.startSend({ workspaceId: b.workspaceId, campaignId: created.id }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(campaigns.cancel({ workspaceId: b.workspaceId, id: created.id }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(campaigns.report({ workspaceId: b.workspaceId, id: created.id })).rejects.toMatchObject({ status: 404 });
    await expect(campaigns.recipients({ workspaceId: b.workspaceId, id: created.id, query: {} })).rejects.toMatchObject({ status: 404 });
    expect((await campaigns.list({ workspaceId: b.workspaceId, query: {} })).total).toBe(0);
    // B cannot use A's template, nor address A's customer
    await expect(newCampaign(b, tpl, { deps })).rejects.toMatchObject({ status: 404, code: 'TEMPLATE_NOT_FOUND' });
    const tplB = await fx.makeTemplate(b.workspaceId);
    const plan = await campaigns.plan({ workspaceId: b.workspaceId, body: { templateId: String(tplB._id), audience: { kind: 'customer_ids', customerIds: [String(custA._id), String(custB._id)] } } });
    expect(plan.audience.eligible).toBe(1);
    // the campaign in A is untouched
    expect((await LocalizedCampaign.findById(created.id).lean()).status).toBe('draft');
  });

  test('two workspaces sending at the same time keep their rows and stats apart', async () => {
    const a = await fx.makeWorkspace(); const b = await fx.makeWorkspace();
    const tplA = await fx.makeTemplate(a.workspaceId); const tplB = await fx.makeTemplate(b.workspaceId);
    for (let i = 0; i < 3; i += 1) await fx.makeCustomer(a.workspaceId, { language: 'ar' });
    for (let i = 0; i < 2; i += 1) await fx.makeCustomer(b.workspaceId, { language: 'en' });
    const da = makeDeps(); const db = makeDeps();
    const ca = await newCampaign(a, tplA, { deps: da.deps });
    const cb = await newCampaign(b, tplB, { deps: db.deps });
    await Promise.all([
      sender.startSend({ workspaceId: a.workspaceId, campaignId: ca.id }, da.deps),
      sender.startSend({ workspaceId: b.workspaceId, campaignId: cb.id }, db.deps),
    ]);
    await Promise.all([da.runJobs(), db.runJobs()]);
    expect((await LocalizedCampaign.findById(ca.id).lean()).stats).toMatchObject({ total: 3, sent: 3 });
    expect((await LocalizedCampaign.findById(cb.id).lean()).stats).toMatchObject({ total: 2, sent: 2 });
    expect((await LocalizedCampaign.findById(ca.id).lean()).stats.byLanguage).toMatchObject({ ar: 3, en: 0 });
    expect(await LocalizedSend.countDocuments({ workspaceId: a.workspaceId })).toBe(3);
    expect(await LocalizedTemplate.countDocuments({ workspaceId: b.workspaceId })).toBe(1);
  });
});

describe('HTTP: /api/localization/campaigns behind the real requireAuth and the arabic_enabled flag', () => {
  const express = require('express');
  const request = require('supertest');
  const { requireAuth } = require('../../../middleware/requireAuth');
  const app = express();
  app.use(express.json());
  app.use('/api/localization', requireAuth, require('../../../routes/localization'));

  async function waitFor(fn, ms = 15000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  test('401 without a token, 402 ARABIC_NOT_ENABLED with the flag off', async () => {
    expect((await request(app).get('/api/localization/campaigns')).status).toBe(401);
    const off = await fx.makeWorkspace({ arabic: false });
    const res = await request(app).get('/api/localization/campaigns').set(off.auth);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('ARABIC_NOT_ENABLED');
  });

  test('create -> plan -> send answers 202 at once, the background run finishes, a second send is 409, the other tenant gets 404', async () => {
    const ws = await fx.makeWorkspace(); const intruder = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    await fx.makeCustomer(ws.workspaceId, { language: 'ar', firstname: 'منى' });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const body = { name: 'HTTP campaign', templateId: String(tpl._id), audience: { kind: 'all_eligible' }, fieldValues: {} };

    expect((await request(app).get('/api/localization/campaigns/segments').set(ws.auth)).body.items.map((s) => s.key))
      .toEqual(['language', 'inactive_days', 'has_points', 'awaiting_consent']);
    const plan = await request(app).post('/api/localization/campaigns/plan').set(ws.auth).send(body);
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ canSend: true, byLanguage: { ar: 1, en: 1 } });

    const created = await request(app).post('/api/localization/campaigns').set(ws.auth).send(body);
    expect(created.status).toBe(201);
    const id = created.body.id;
    // injection / foreign ids / validation
    expect((await request(app).post('/api/localization/campaigns').set(ws.auth).send({ ...body, name: { $ne: 1 } })).status).toBe(400);
    expect((await request(app).get(`/api/localization/campaigns/${id}`).set(intruder.auth)).status).toBe(404);
    expect((await request(app).post(`/api/localization/campaigns/${id}/send`).set(intruder.auth).send({})).status).toBe(404);
    expect((await request(app).get('/api/localization/campaigns/not-an-id').set(ws.auth)).body.code).toBe('INVALID_ID');

    const [first, second] = await Promise.all([
      request(app).post(`/api/localization/campaigns/${id}/send`).set(ws.auth).send({}),
      request(app).post(`/api/localization/campaigns/${id}/send`).set(ws.auth).send({}),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    expect([first, second].find((r) => r.status === 409).body.code).toBe('CAMPAIGN_NOT_DRAFT');
    expect([first, second].find((r) => r.status === 202).body.campaign.status).toBe('sending');

    const done = await waitFor(async () => {
      const r = await request(app).get(`/api/localization/campaigns/${id}`).set(ws.auth);
      return r.body.status !== 'sending' ? r.body : null;
    });
    expect(done.status).toBe('sent');
    expect(done.stats).toMatchObject({ total: 2, sent: 2, byLanguage: { ar: 1, en: 1 } });
    const report = await request(app).get(`/api/localization/campaigns/${id}/report`).set(ws.auth);
    expect(report.body.byLanguage.ar.sent).toBe(1);
    const list = await request(app).get('/api/localization/campaigns').set(ws.auth);
    expect(list.body.total).toBe(1);
    expect((await request(app).get('/api/localization/campaigns').set(intruder.auth)).body.total).toBe(0);
  });
});

describe('more mid-run and preview behaviour', () => {
  test('a runner that lost its campaign (taken over by a resumer) stops at its next checkpoint; the resumer finishes; every customer is sent exactly once', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const customers = [];
    for (let i = 0; i < 5; i += 1) customers.push(await fx.makeCustomer(ws.workspaceId, { language: i % 2 ? 'ar' : 'en' }));
    let sleeps = 0;
    let campaignId;
    const first = makeDeps({
      onSleep: async () => {
        sleeps += 1;
        // another process takes the campaign over after the second send (its heartbeat looked stale)
        if (sleeps === 2) await LocalizedCampaign.updateOne({ _id: campaignId }, { $set: { claimedBy: 'other-process', lastHeartbeatAt: new Date(Date.now() - 3600 * 1000) } });
      },
    });
    const created = await newCampaign(ws, tpl, { deps: first.deps });
    campaignId = created.id;
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, first.deps);
    await first.runJobs();
    expect(transport.lastDryRuns()).toHaveLength(2); // the old runner noticed and stopped
    expect((await LocalizedCampaign.findById(created.id).lean()).status).toBe('sending');

    const second = makeDeps();
    expect((await sender.resumeStuckCampaigns({}, second.deps)).resumed).toBe(1);
    await second.runJobs();
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.status).toBe('sent');
    const reached = transport.lastDryRuns().map((d) => d.payload.to);
    expect(reached.sort()).toEqual(customers.map((c) => c.phone).sort()); // 5 distinct, none twice
  });

  test('a customer erased between plan and send is skipped (never messaged) and shows as anonymised in the recipient list', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const keep = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const gone = await fx.makeCustomer(ws.workspaceId, { language: 'ar', firstname: 'Real', lastname: 'Person' });
    const { deps, runJobs } = makeDeps({
      onSleep: async () => {},
    });
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    // the internal admin erases the customer right after the claim (same field changes as routes/internalAdmin.js)
    await Customer.updateOne({ _id: gone._id }, { $set: { firstname: 'Deleted', lastname: 'Customer', phone: `deleted-${gone._id}`, optedOut: true, marketingConsent: false, deletedAt: new Date() } });
    await runJobs();
    const row = await LocalizedSend.findOne({ campaignId: created.id, customerId: gone._id }).lean();
    expect(row.status).toMatch(/^skipped_/);
    expect(transport.lastDryRuns().map((d) => d.payload.to)).toEqual([keep.phone]);
    const list = await campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: {} });
    const shown = list.items.find((i) => i.customerId === String(gone._id));
    expect(shown.name).toBe('Deleted Customer');
    expect(shown.phone).toBe(`deleted-${gone._id}`);
    expect(JSON.stringify(list)).not.toContain('Real Person');
  });

  test('the plan previews up to 3 rendered sample messages with the customer\'s own name; the STORED plan carries no names', async () => {
    const ws = await fx.makeWorkspace({ merchantName: 'مقهى الأصالة' });
    const tpl = await fx.makeTemplate(ws.workspaceId);
    await fx.makeCustomer(ws.workspaceId, { language: 'ar', firstname: 'منى', loyaltyPoints: 12 });
    await fx.makeCustomer(ws.workspaceId, { language: 'en', firstname: 'Sara', loyaltyPoints: 3 });
    const plan = await campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' } } });
    expect(plan.sampleRecipients.length).toBeGreaterThanOrEqual(2);
    expect(plan.sampleRecipients.length).toBeLessThanOrEqual(3);
    const joined = JSON.stringify(plan.sampleRecipients);
    expect(joined).toContain('منى');
    expect(joined).toContain('Sara');
    expect(joined).toContain('مقهى الأصالة');
    const { deps } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    const raw = await LocalizedCampaign.findById(created.id).lean();
    expect(JSON.stringify(raw.plan)).not.toContain('منى');
    expect(JSON.stringify(raw.plan)).not.toContain('Sara');
    expect(JSON.stringify(created)).not.toContain('Sara');
  });

  test('recipients / list filters reject unknown values with 400 instead of passing them to Mongo', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    await fx.makeCustomer(ws.workspaceId);
    const { deps } = makeDeps();
    const created = await newCampaign(ws, tpl, { deps });
    await expect(campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: { status: { $ne: 'sent' } } })).rejects.toMatchObject({ status: 400 });
    await expect(campaigns.recipients({ workspaceId: ws.workspaceId, id: created.id, query: { language: 'fr' } })).rejects.toMatchObject({ status: 400 });
    await expect(campaigns.list({ workspaceId: ws.workspaceId, query: { status: 'nope' } })).rejects.toMatchObject({ status: 400 });
    expect((await campaigns.list({ workspaceId: ws.workspaceId, query: { page: '-5', limit: '99999' } })).limit).toBe(200);
  });
});

describe('finalisation never depends on the cosmetic lastError lookup', () => {
  // Cosmos DB can refuse a sort that has no index ("The order by query does not have a
  // corresponding composite index"). That lookup only fills `lastError`, so it must never
  // be able to leave a fully-sent campaign `sending` (and later `failed` by the resumer).
  function sendModelRejectingSortOnUpdatedAt() {
    return new Proxy(LocalizedSend, {
      get(target, prop) {
        if (prop === 'findOne') {
          return (...args) => {
            const query = target.findOne(...args);
            const realSort = query.sort.bind(query);
            query.sort = (spec) => {
              if (spec && spec.updatedAt) {
                return { select: () => ({ lean: () => Promise.reject(new Error('The order by query does not have a corresponding composite index')) }) };
              }
              return realSort(spec);
            };
            return query;
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  test('a failing lastError lookup still finalises the campaign (partial) with the real counts', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    for (let i = 0; i < 3; i += 1) await fx.makeCustomer(ws.workspaceId, { language: i % 2 ? 'ar' : 'en' });
    const { deps, runJobs } = makeDeps();
    deps.LocalizedSend = sendModelRejectingSortOnUpdatedAt();
    const real = deps.transport;
    let calls = 0;
    deps.transport = {
      ...real,
      sendTemplate: async (to, args) => {
        calls += 1;
        if (calls === 2) { const err = new Error('nope'); err.response = { data: { error: { code: 131026, message: 'Message undeliverable' } } }; throw err; }
        return real.sendTemplate(to, args);
      },
    };
    const created = await newCampaign(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    await runJobs();
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    expect(campaign.status).toBe('partial');
    expect(campaign.stats).toMatchObject({ total: 3, sent: 2, failed: 1 });
    expect(campaign.finishedAt).toBeTruthy();
  });
});

describe('{business} when the merchant has not set a business name', () => {
  test("a default \"X's Workspace\" name with no merchantName is reported at PLAN time, not discovered per recipient after the claim", async () => {
    const ws = await fx.makeWorkspace({ merchantName: '' });
    await require('../../../models/Workspace').updateOne({ _id: ws.workspaceId }, { $set: { name: "Omar's Workspace" } });
    const tpl = await fx.makeTemplate(ws.workspaceId); // bodies use {name} {points} {business}
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const { deps, runJobs } = makeDeps();
    const plan = await campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' } } });
    const created = await newCampaign(ws, tpl, { deps });
    let refused = null;
    try {
      await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
      await runJobs();
    } catch (err) { refused = err; }
    const campaign = await LocalizedCampaign.findById(created.id).lean();
    // either the plan blocks it up front (preferred), or - at worst - the campaign must not claim to have sent anything
    if (plan.canSend) {
      expect(plan.missingFieldValues).toEqual([]);
      expect(campaign.stats.sent).toBe(0);
      throw new Error(`plan.canSend is true but every recipient is skipped at send time: ${JSON.stringify({ status: campaign.status, stats: campaign.stats, lastError: campaign.lastError })}`);
    }
    expect(plan.missingFieldValues).toContain('business');
    expect(refused).toMatchObject({ status: 422, code: 'FIELD_VALUES_MISSING' });
  });
});
