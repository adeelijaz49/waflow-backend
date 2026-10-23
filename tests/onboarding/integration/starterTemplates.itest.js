'use strict';
const { useDatabase, connectDb, makeOwnerWorkspace, makeMerchant, graphClient, clock } = require('./_b1eEnv');
useDatabase('starter');

// Starter templates on the merchant's own WABA, end to end on REAL models (throwaway mongod),
// the REAL metaClient (B1-c) and the fakeGraph fixture (no network): nothing here can reach Meta.
const express = require('express');
const request = require('supertest');
const { createFakeGraph } = require('../_fixtures');
const OnboardingTemplate = require('../../../models/OnboardingTemplate');
const OnboardingNotification = require('../../../models/OnboardingNotification');
const OnboardingEvent = require('../../../models/OnboardingEvent');
const WhatsAppConnection = require('../../../models/WhatsAppConnection');
const Membership = require('../../../models/Membership');
const starter = require('../../../shared/onboarding/starterTemplates');
const metaConstraints = require('../../../shared/localization/metaConstraints');
const mongoose = require('mongoose');

let g;
let deps;
let clk;
const ws = {};

async function reset(languages) {
  g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1' });
  clk = clock();
  deps = { metaClient: graphClient(g), now: clk.now };
  return makeMerchant(g, { name: `M${Math.random().toString(36).slice(2, 8)}`, languages });
}
const rows = (workspaceId) => OnboardingTemplate.find({ workspaceId }).lean();
const rowOf = async (workspaceId, key, language) => OnboardingTemplate.findOne({ workspaceId, key, language }).lean();
const creates = () => g.callsTo('createTemplate');

beforeAll(async () => { await connectDb(); await makeOwnerWorkspace(); });
afterAll(async () => { await mongoose.disconnect(); });
beforeEach(() => { delete process.env.ONBOARDING_TEMPLATE_CEILING; });

describe('seed + submit on the merchant WABA', () => {
  test('seeding is idempotent under concurrency (unique index) and makes no Meta call', async () => {
    const m = await reset();
    const results = await Promise.all(Array.from({ length: 5 }, () => starter.seedStarterTemplates(m.workspaceId, deps)));
    expect(await OnboardingTemplate.countDocuments({ workspaceId: m.workspaceId })).toBe(16);
    expect(results.reduce((n, r) => n + r.created, 0)).toBe(16);
    expect(g.calls).toHaveLength(0);
    const again = await starter.seedStarterTemplates(m.workspaceId, deps);
    expect(again).toMatchObject({ created: 0, existing: 16 });
    ws.seeded = m;
  });

  test('English submitted in 5-per-call ticks with the MERCHANT token only; payloads are valid and carry allow_category_change', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    const ticks = [];
    for (let i = 0; i < 3; i += 1) ticks.push(await starter.submitQueued({ workspaceId: m.workspaceId }, deps));
    expect(ticks.map((t) => t.submitted)).toEqual([5, 3, 0]);
    const created = creates();
    expect(created).toHaveLength(8);
    for (const c of created) {
      expect(c.token).toBe(g.ids.merchantToken);
      expect(c.tokenKind).toBe('merchant');
      expect(c.id).toBe('W1');
      expect(c.data.allow_category_change).toBe(true);
      expect(c.data.language).toBe('en');
      expect(c.data.name).toMatch(new RegExp(`^wf_${m.workspaceId.slice(-6)}_[a-z_]+_en_v1$`));
      expect(['MARKETING', 'UTILITY']).toContain(c.data.category);
    }
    g.assertMerchantTokenOnly(g.ids.merchantToken);
    g.assertNeverUsedToken(g.ids.platformToken);
    g.assertNoForeignCalls();
    const fakeTemplates = g.templates();
    expect(fakeTemplates).toHaveLength(8);
    expect(fakeTemplates.every((t) => t.allow_category_change === true && t.language === 'en')).toBe(true);
    const stored = await rows(m.workspaceId);
    const en = stored.filter((r) => r.language === 'en');
    expect(en.every((r) => r.metaTemplateId && r.metaStatus === 'PENDING' && r.attempts === 1 && !r.submitClaimedAt && r.submittedAt)).toBe(true);
    expect(stored.filter((r) => r.language === 'ar').every((r) => !r.metaTemplateId && r.blockedReason)).toBe(true);
    g.assertNoLeak([g.ids.merchantToken], []);
  });

  test('every library payload validates with validateVariant; welcome_optin is never submitted in Arabic', async () => {
    const m = await reset(['en', 'ar']);
    await starter.seedStarterTemplates(m.workspaceId, deps);
    for (let i = 0; i < 4; i += 1) await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
    const sent = creates();
    expect(sent).toHaveLength(15);
    expect(sent.filter((c) => c.data.language === 'ar')).toHaveLength(7);
    expect(sent.some((c) => c.data.language === 'ar_SA')).toBe(false);
    expect(sent.some((c) => /welcome_optin_ar/.test(c.data.name))).toBe(false);
    for (const key of ['welcome_optin', 'promotion_weekend', 'comeback', 'order_confirmation', 'setup_test']) {
      const spec = starter.getSpec(key);
      for (const lang of ['en', 'ar']) {
        if (key === 'welcome_optin' && lang === 'ar') continue;
        expect(metaConstraints.validateVariant(spec.variantFor(lang), { category: spec.category }).ok).toBe(true);
      }
    }
    const legal = await rowOf(m.workspaceId, 'welcome_optin', 'ar');
    expect(legal).toMatchObject({ blockedReason: 'legal' });
    expect(legal.metaTemplateId).toBeUndefined();
  });

  test('two simultaneous submit runs never create a template twice (atomic claim on the real index)', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    await Promise.all([starter.submitQueued({ workspaceId: m.workspaceId }, deps), starter.submitQueued({ workspaceId: m.workspaceId }, deps), starter.submitQueued({ workspaceId: m.workspaceId }, deps)]);
    const names = creates().map((c) => c.data.name);
    expect(new Set(names).size).toBe(names.length);
    expect(creates().every((c) => c.status === 200)).toBe(true); // no duplicate-name error was ever provoked
    const submitted = (await rows(m.workspaceId)).filter((r) => r.metaTemplateId);
    expect(submitted).toHaveLength(names.length);
  });

  test('the category stored follows what Meta returned', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    await starter.submitQueued({ workspaceId: m.workspaceId, max: 1 }, deps);
    const first = (await rows(m.workspaceId)).find((r) => r.metaTemplateId);
    expect(first.category).toBe(g.templates()[0].category);
  });
});

describe('duplicate name (100 / 2388024) is adopted', () => {
  test('a template that already exists on Meta (crashed earlier run) is listed by name and adopted', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    const name = `wf_${m.workspaceId.slice(-6)}_setup_test_en_v1`;
    // exists on Meta, unknown to us
    const pre = await g.http.post(`https://graph.facebook.com/v25.0/W1/message_templates`, { name, language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }, { headers: { Authorization: `Bearer ${g.ids.merchantToken}` } });
    expect(pre.status).toBe(200);
    g.setTemplateStatus(name, 'en', 'APPROVED');
    const r = await starter.submitQueued({ workspaceId: m.workspaceId, max: 1 }, deps);
    expect(r).toMatchObject({ submitted: 0, adopted: 1, failed: 0 });
    const row = await rowOf(m.workspaceId, 'setup_test', 'en');
    expect(row).toMatchObject({ metaTemplateId: pre.data.id, metaStatus: 'APPROVED', metaTemplateName: name });
    expect(g.callsTo('createTemplate').filter((c) => c.status === 400)).toHaveLength(1);
    expect(g.callsTo('listTemplates')).toHaveLength(1);
    expect(g.callsTo('listTemplates')[0].params.name).toBe(name);
  });

  test('the injected duplicate scenario (failNext) is handled as well', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    const name = `wf_${m.workspaceId.slice(-6)}_setup_test_en_v1`;
    await g.http.post(`https://graph.facebook.com/v25.0/W1/message_templates`, { name, language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] }, { headers: { Authorization: `Bearer ${g.ids.merchantToken}` } });
    g.failNext('createTemplate', { code: 100, subcode: 2388024, message: 'dup' }, { times: 1 });
    const r = await starter.submitQueued({ workspaceId: m.workspaceId, max: 1 }, deps);
    expect(r.adopted).toBe(1);
  });
});

describe('ceiling and failures', () => {
  test('TEMPLATE_LIMIT_REACHED at the configured ceiling; nothing more reaches Meta', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    process.env.ONBOARDING_TEMPLATE_CEILING = '3';
    const a = await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
    expect(a).toMatchObject({ submitted: 3, limitReached: true });
    await expect(starter.submitQueued({ workspaceId: m.workspaceId }, deps)).rejects.toMatchObject({ code: 'TEMPLATE_LIMIT_REACHED', status: 409 });
    expect(creates()).toHaveLength(3);
  });

  test('a revoked token (190/463) flags the connection through connect.reportGraphError and stops the run', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    g.scenarios.token190();
    const r = await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
    expect(r).toMatchObject({ aborted: 'reconnect', submitted: 0 });
    expect(creates()).toHaveLength(1);
    const conn = await WhatsAppConnection.findOne({ workspaceId: m.workspaceId }).lean();
    expect(conn.needsReconnect).toBe(true);
    const row = await rowOf(m.workspaceId, 'setup_test', 'en');
    expect(row).toMatchObject({ attempts: 1, lastErrorCode: 'META_190_463' });
    expect(row.submitClaimedAt).toBeNull();
    // a flagged connection is refused up front the next time (no Graph call)
    await expect(starter.submitQueued({ workspaceId: m.workspaceId }, deps)).rejects.toMatchObject({ code: 'WHATSAPP_RECONNECT_REQUIRED' });
    expect(creates()).toHaveLength(1);
  });

  test('a network drop releases the claim and the next tick succeeds', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    g.scenarios.networkDrop({ code: 'ETIMEDOUT' });
    const a = await starter.submitQueued({ workspaceId: m.workspaceId, max: 1 }, deps);
    expect(a.failed).toBe(1);
    expect(await rowOf(m.workspaceId, 'setup_test', 'en')).toMatchObject({ lastErrorCode: 'META_UNREACHABLE', attempts: 1 });
    const b = await starter.submitQueued({ workspaceId: m.workspaceId, max: 1 }, deps);
    expect(b.submitted).toBe(1);
  });

  test('not connected: queued rows stay queued, no Graph call, a clear error', async () => {
    g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1' });
    deps = { metaClient: graphClient(g), now: clock().now };
    const m = await makeMerchant(g, { name: 'NoConn', connStatus: null });
    await starter.seedStarterTemplates(m.workspaceId, deps);
    await expect(starter.submitQueued({ workspaceId: m.workspaceId }, deps)).rejects.toMatchObject({ code: 'WHATSAPP_NOT_CONNECTED' });
    expect(g.calls).toHaveLength(0);
    expect((await rows(m.workspaceId)).every((r) => !r.metaTemplateId)).toBe(true);
  });
});

describe('status: poll, webhook, resubmit', () => {
  async function submittedMerchant() {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
    await starter.submitQueued({ workspaceId: m.workspaceId }, deps);
    return m;
  }
  const nameOf = (m, key, lang = 'en', v = 1) => `wf_${m.workspaceId.slice(-6)}_${key}_${lang}_v${v}`;
  const notes = (m) => OnboardingNotification.find({ workspaceId: m.workspaceId }).lean();

  test('poll: APPROVED is stored and notified once (real notification store); re-reads are at most hourly', async () => {
    const m = await submittedMerchant();
    g.setTemplateStatus(nameOf(m, 'promotion_weekend'), 'en', 'APPROVED');
    g.setTemplateStatus(nameOf(m, 'setup_test'), 'en', 'APPROVED');
    expect(await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps)).toMatchObject({ checked: 0 }); // just submitted
    clk.advance(61 * 60 * 1000);
    const r = await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
    expect(r).toMatchObject({ workspaces: 1, checked: 8, changed: 2, errors: 0 });
    expect(g.callsTo('listTemplates')).toHaveLength(1);
    expect(g.callsTo('listTemplates')[0].token).toBe(g.ids.merchantToken);
    expect((await rowOf(m.workspaceId, 'promotion_weekend', 'en')).metaStatus).toBe('APPROVED');
    const n = await notes(m);
    const own = n.filter((x) => /^template:/.test(x.dedupeKey));
    expect(own).toHaveLength(1); // the setup test template does not notify
    expect(own[0]).toMatchObject({ kind: 'template_approved', titleKey: 'onboarding.notify.template_approved.title', emailAttempts: 0 }); // an approval is in the app only
    expect(own[0].dedupeKey).toBe(`template:${(await rowOf(m.workspaceId, 'promotion_weekend', 'en')).metaTemplateId}:APPROVED`);
    // ... and the first approved starter template is the (e-mailed) milestone: counts only, the setup test never counts
    const milestone = n.filter((x) => /^templates:/.test(x.dedupeKey));
    expect(milestone).toHaveLength(1);
    expect(milestone[0]).toMatchObject({ kind: 'template_approved', dedupeKey: 'templates:first_approved', params: { count: 1, total: 7 }, actionPath: '/setup/approvals' });
    expect(n).toHaveLength(2);
    // not due again straight away; decided rows are never polled again
    expect((await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps)).checked).toBe(0);
    clk.advance(61 * 60 * 1000);
    expect((await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps)).checked).toBe(6); // the two approved rows are done
    const events = await OnboardingEvent.find({ workspaceId: m.workspaceId, type: 'template_status', code: 'TEMPLATE_APPROVED' }).lean();
    expect(events).toHaveLength(2);
  });

  test('poll sees REJECTED (no reason on the list call), the webhook then delivers reason + recommendation', async () => {
    const m = await submittedMerchant();
    const name = nameOf(m, 'comeback');
    g.setTemplateStatus(name, 'en', 'REJECTED', 'INVALID_FORMAT');
    clk.advance(61 * 60 * 1000);
    await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps);
    const afterPoll = await rowOf(m.workspaceId, 'comeback', 'en');
    expect(afterPoll).toMatchObject({ metaStatus: 'REJECTED', metaStatusRaw: 'REJECTED' });
    const env = g.webhook.templateStatus(name, 'en', 'REJECTED', 'INVALID_FORMAT');
    const v = env.entry[0].changes[0].value;
    const r = await starter.applyTemplateStatusUpdate({ workspaceId: m.workspaceId, templateId: v.message_template_id, name: v.message_template_name, language: 'en-US', statusRaw: v.event, reason: v.reason, recommendation: 'Remove the emoji.' }, deps);
    expect(r.updated).toBe(true);
    const row = await rowOf(m.workspaceId, 'comeback', 'en');
    expect(row).toMatchObject({ rejectedReason: 'INVALID_FORMAT', rejectionRecommendation: 'Remove the emoji.' });
    const n = await notes(m);
    expect(n.filter((x) => x.kind === 'template_rejected')).toHaveLength(1);
    const list = await starter.listStatuses(m.workspaceId, deps);
    expect(list.find((x) => x.key === 'comeback' && x.language === 'en')).toMatchObject({ status: 'rejected', rejectedReason: 'INVALID_FORMAT', canResubmit: true });
  });

  test('webhook APPROVED is idempotent (id + status): one row update, one notification', async () => {
    const m = await submittedMerchant();
    const name = nameOf(m, 'welcome_optin');
    g.setTemplateStatus(name, 'en', 'APPROVED');
    const v = g.webhook.templateStatus(name, 'en', 'APPROVED').entry[0].changes[0].value;
    const args = { workspaceId: m.workspaceId, templateId: v.message_template_id, name: v.message_template_name, language: v.message_template_language, statusRaw: v.event, reason: v.reason, category: v.message_template_category };
    const a = await starter.applyTemplateStatusUpdate(args, deps);
    const b = await starter.applyTemplateStatusUpdate(args, deps);
    expect(a).toMatchObject({ updated: true, changed: true });
    expect(b).toMatchObject({ updated: true, changed: false });
    const n = await notes(m);
    expect(n.filter((x) => /^template:/.test(x.dedupeKey))).toHaveLength(1);
    expect(n.filter((x) => x.dedupeKey === 'templates:first_approved')).toHaveLength(1);
    expect(n.filter((x) => x.kind === 'template_approved')).toHaveLength(2); // the template + the first milestone, however often it is delivered
  });

  test('a notification that already exists (dedupe key) is never duplicated, even after a status round trip', async () => {
    const m = await submittedMerchant();
    const row = await rowOf(m.workspaceId, 'comeback', 'en');
    for (const s of ['APPROVED', 'PAUSED', 'APPROVED']) await starter.applyTemplateStatusUpdate({ workspaceId: m.workspaceId, templateId: row.metaTemplateId, statusRaw: s }, deps);
    const n = await notes(m);
    expect(n.filter((x) => /^template:/.test(x.dedupeKey))).toHaveLength(1);
    expect(n.filter((x) => x.dedupeKey === 'templates:first_approved')).toHaveLength(1); // the round trip attempted it twice: the unique key kept ONE row (one e-mail)
    expect((await rowOf(m.workspaceId, 'comeback', 'en')).metaStatus).toBe('APPROVED');
  });

  test('rejected -> resubmit: a new revision and name on Meta, the old one stays; the row is PENDING again', async () => {
    const m = await submittedMerchant();
    const name = nameOf(m, 'comeback');
    g.setTemplateStatus(name, 'en', 'REJECTED', 'INVALID_FORMAT');
    const row = await rowOf(m.workspaceId, 'comeback', 'en');
    await starter.applyTemplateStatusUpdate({ workspaceId: m.workspaceId, templateId: row.metaTemplateId, statusRaw: 'REJECTED', reason: 'INVALID_FORMAT' }, deps);
    const edited = 'Hi {name}, we have missed you! Enjoy {discount}% off your next order until {date}. See you soon.';
    const out = await starter.resubmit({ workspaceId: m.workspaceId, key: 'comeback', language: 'en', edits: { body: edited } }, deps);
    expect(out.template).toMatchObject({ status: 'pending', revision: 2, canResubmit: false });
    const onMeta = g.templates().filter((t) => /comeback_en/.test(t.name));
    expect(onMeta.map((t) => [t.name, t.status]).sort()).toEqual([[nameOf(m, 'comeback', 'en', 1), 'REJECTED'], [nameOf(m, 'comeback', 'en', 2), 'PENDING']]);
    const v2 = onMeta.find((t) => t.name === nameOf(m, 'comeback', 'en', 2));
    expect(v2.components.find((c) => c.type === 'BODY').text).toContain('we have missed you!');
    expect(v2.allow_category_change).toBe(true);
    const lastCreate = creates()[creates().length - 1];
    expect(lastCreate.token).toBe(g.ids.merchantToken);
    expect(await rowOf(m.workspaceId, 'comeback', 'en')).toMatchObject({ revision: 2, metaTemplateName: nameOf(m, 'comeback', 'en', 2), metaStatus: 'PENDING', rejectedReason: null });
    // a rejected-looking edit never reaches Meta
    await expect(starter.resubmit({ workspaceId: m.workspaceId, key: 'comeback', language: 'en' }, deps)).rejects.toMatchObject({ details: { reason: 'NOT_REJECTED' } });
  });

  test('inactive subscription: the poll skips the workspace', async () => {
    const m = await submittedMerchant();
    await require('../../../models/OnboardingState').updateOne({ workspaceId: m.workspaceId }, { $set: { 'subscription.state': 'cancelled', 'subscription.source': 'admin' } });
    require('../../../shared/onboarding/state').clearCache();
    clk.advance(2 * 3600 * 1000);
    expect(await starter.pollStatuses({ workspaceId: m.workspaceId, submit: false }, deps)).toMatchObject({ workspaces: 0, skipped: 1, checked: 0 });
    expect(g.callsTo('listTemplates')).toHaveLength(0);
  });

  test('pollStatuses submits queued rows afterwards (<= 5 per workspace per tick) for an active subscription', async () => {
    const m = await reset();
    await starter.seedStarterTemplates(m.workspaceId, deps);
    const r = await starter.pollStatuses({ workspaceId: m.workspaceId }, deps);
    expect(r.submit).toMatchObject({ workspaces: 1, submitted: 5 });
    expect(creates()).toHaveLength(5);
  });
});

describe('tenant isolation', () => {
  test('rows, statuses, capacity and resubmits are per workspace; a foreign template id changes nothing', async () => {
    const a = await reset();
    await starter.seedStarterTemplates(a.workspaceId, deps);
    await starter.submitQueued({ workspaceId: a.workspaceId }, deps);
    const b = await makeMerchant(g, { name: 'Other merchant', connStatus: null });
    expect(await starter.listStatuses(b.workspaceId, deps)).toEqual([]);
    const aRow = (await rows(a.workspaceId)).find((r) => r.metaTemplateId);
    const r = await starter.applyTemplateStatusUpdate({ workspaceId: b.workspaceId, templateId: aRow.metaTemplateId, statusRaw: 'APPROVED' }, deps);
    expect(r.updated).toBe(false);
    expect((await OnboardingTemplate.findById(aRow._id).lean()).metaStatus).toBe('PENDING');
    await expect(starter.resubmit({ workspaceId: b.workspaceId, key: aRow.key, language: aRow.language }, deps)).rejects.toMatchObject({ details: { reason: 'UNKNOWN_TEMPLATE' } });
    expect(await starter.getCapacity(b.workspaceId, deps)).toMatchObject({ total: 0, used: 0 });
  });
});

describe('routes (mini app, real modules)', () => {
  const { createRouter } = require('../../../routes/onboarding/templates');
  function mkApp(m, moduleDeps) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.user = { id: m.userId, workspaceId: m.workspaceId, role: 'owner' }; next(); });
    app.use(createRouter({ moduleDeps, rateLimitDeps: { limiter: require('../../../shared/onboarding/rateLimit').createLimiter() } }));
    return app;
  }

  // submit / resubmit spend the merchant's Meta credentials: the requester must be a LIVE member (real Membership rows here)
  const asOwner = async (m) => { await Membership.create({ userId: m.userId, workspaceId: m.workspaceId, role: 'owner' }); return m; };

  test('POST /templates/submit then GET /templates: queued rows, 3 submitted now, titles for the UI, no Meta names or tokens', async () => {
    const m = await asOwner(await reset());
    const app = mkApp(m, deps);
    const sub = await request(app).post('/templates/submit').send({});
    expect(sub.status).toBe(200);
    expect(sub.body.submitted).toBe(3);
    expect(sub.body.templates).toHaveLength(16);
    expect(sub.body.capacity).toMatchObject({ ceiling: 90, total: 16, used: 3 });
    const res = await request(app).get('/templates');
    expect(res.status).toBe(200);
    expect(res.body.templates.filter((t) => t.status === 'pending')).toHaveLength(3);
    expect(res.body.templates.filter((t) => t.status === 'queued')).toHaveLength(5);
    expect(res.body.templates.filter((t) => t.status === 'blocked')).toHaveLength(8);
    expect(res.body.templates.every((t) => t.title && t.title.en && t.title.ar)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/wf_[0-9a-f]{6}_|EAAFXT/);
    expect(creates()).toHaveLength(3);
  });

  test('POST /templates/submit for a workspace with no connection queues and says why it did not submit', async () => {
    g = createFakeGraph({ wabaId: 'W1', phoneId: 'P1' });
    const m = await asOwner(await makeMerchant(g, { name: 'Route no conn', connStatus: null }));
    const res = await request(mkApp(m, { metaClient: graphClient(g), now: clock().now })).post('/templates/submit').send({});
    expect(res.status).toBe(200);
    expect(res.body.blocked).toEqual({ code: 'WHATSAPP_NOT_CONNECTED', nextStep: 'connect' });
    expect(res.body.templates).toHaveLength(16);
    expect(g.calls).toHaveLength(0);
  });

  test('a user who is no longer a member (stale login) is refused with 403 NOT_A_MEMBER: nothing is queued, nothing reaches Meta (review R2-05)', async () => {
    const m = await reset(); // the user exists but has NO Membership row for this workspace
    const app = mkApp(m, deps);
    const res = await request(app).post('/templates/submit').send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_A_MEMBER');
    const again = await request(app).post('/templates/promotion_weekend/en/resubmit').send({});
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('NOT_A_MEMBER');
    expect(await OnboardingTemplate.countDocuments({ workspaceId: m.workspaceId })).toBe(0);
    expect(g.calls).toHaveLength(0);
    // reading the list stays open to a signed-in workspace user (no Meta credential is used)
    expect((await request(app).get('/templates')).status).toBe(200);
    // ... and becomes possible to submit once the membership exists
    await asOwner(m);
    expect((await request(app).post('/templates/submit').send({})).status).toBe(200);
    // an owner of workspace A has no say in workspace B: the membership is looked up for the pair (user, workspace)
    const other = await reset();
    const app2 = mkApp({ userId: m.userId, workspaceId: other.workspaceId }, deps);
    const foreign = await request(app2).post('/templates/submit').send({});
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('NOT_A_MEMBER');
    expect(await OnboardingTemplate.countDocuments({ workspaceId: other.workspaceId })).toBe(0);
  });
});
