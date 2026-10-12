const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// The parts of the sender that dry-run deliberately skips - the CampaignMessage delivery
// rows and the consent-ask stamp - plus the bookkeeping guarantees and limits, on real
// MongoDB. The transport here is a FAKE that behaves like a live one (isDryRun false,
// returns a Graph-shaped response): nothing can reach WhatsApp.
const fx = require('./_fixtures');
const mongoose = require('mongoose');
const campaigns = require('../../../shared/localization/campaigns');
const sender = require('../../../shared/localization/campaignSender');
const transport = require('../../../shared/localization/transport');
const hook = require('../../../shared/localization/inboundHook');
const inbox = require('../../../shared/inbox');
const Customer = require('../../../models/Customer');
const ConsentEvent = require('../../../models/ConsentEvent');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedCampaign = require('../../../models/LocalizedCampaign');
const LocalizedSend = require('../../../models/LocalizedSend');

jest.setTimeout(120000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { transport.clearDryRuns(); hook.resetHandled(); });

let wamidSeq = 0;
function liveFake({ failOn = () => false } = {}) {
  const sent = [];
  return {
    sent,
    isDryRun: () => false,
    extractWamid: transport.extractWamid,
    sendTemplate: async (to, args) => {
      sent.push({ to, ...args });
      if (failOn(to, sent.length)) {
        const err = new Error('boom');
        err.response = { data: { error: { code: 131048, message: 'Spam rate limit hit' } } };
        throw err;
      }
      wamidSeq += 1;
      return { messages: [{ id: `wamid.live-${fx.uniq()}-${wamidSeq}` }] };
    },
  };
}

function makeDeps(over = {}) {
  const jobs = [];
  const deps = { ...campaigns.realDeps(), sleep: async () => {}, schedule: (fn) => { jobs.push(fn); }, log: () => {}, ...over };
  return { deps, runJobs: async () => { while (jobs.length) await jobs.shift()(); } };
}

async function create(ws, tpl, { deps, body = {} } = {}) {
  return campaigns.create({
    workspaceId: ws.workspaceId, userId: ws.user._id,
    body: { name: 'Campaign', templateId: String(tpl._id), audience: { kind: 'all_eligible' }, ...body },
  }, deps);
}

async function run(ws, tpl, { deps: over, runner, body, acknowledge } = {}) {
  const { deps, runJobs } = makeDeps(over);
  const created = await create(ws, tpl, { deps, body });
  await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id, acknowledge }, deps);
  await runJobs();
  return { created, deps, campaign: await LocalizedCampaign.findById(created.id).lean() };
}

describe('delivery rows (CampaignMessage) written by a live send', () => {
  test('one validated CampaignMessage per sent message, joined to the LocalizedSend row by wamid; the Inbox thread lists it', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const ar = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const en = await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(campaign.status).toBe('sent');

    const rows = await CampaignMessage.find({ workspaceId: ws.workspaceId }).lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ kind: 'promotion', messageType: 'template', status: 'sent' });
      expect(row.promotion).toBeUndefined();
      expect(row.wamid).toMatch(/^wamid\.live-/);
      expect(row.sentAt).toBeTruthy();
    }
    for (const customer of [ar, en]) {
      const send = await LocalizedSend.findOne({ campaignId: campaign._id, customerId: customer._id }).lean();
      const msg = rows.find((r) => String(r.customer) === String(customer._id));
      expect(msg.wamid).toBe(send.wamid);
      expect(msg.templateName).toBe(send.metaTemplateName);
      expect(msg.phone).toBe(customer.phone);
    }
    // existing code that reads CampaignMessage rows copes with a row that has no promotion
    const thread = await inbox.getThread({ customerId: ar._id, workspaceId: ws.workspaceId });
    const items = thread.timeline || thread.messages || thread;
    expect(JSON.stringify(items)).toContain('Promotion');
  });

  test('a failed Meta call is a failed row with the Meta error code and NO CampaignMessage; the next recipient is still sent', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const fake = liveFake({ failOn: (to, n) => n === 1 });
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(campaign.status).toBe('partial');
    expect(await CampaignMessage.countDocuments({ workspaceId: ws.workspaceId })).toBe(1);
    const failed = await LocalizedSend.findOne({ campaignId: campaign._id, status: 'failed' }).lean();
    expect(failed).toMatchObject({ errorCode: '131048' });
    expect(failed.error).toContain('Spam rate limit');
  });

  test('a bookkeeping failure after a successful send can NEVER cause a second send', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    for (let i = 0; i < 3; i += 1) await fx.makeCustomer(ws.workspaceId, { language: i ? 'ar' : 'en' });
    const fake = liveFake();
    const brokenMessages = { ...CampaignMessage, create: async () => { throw new Error('cosmos 16500 throttled'); } };
    const { campaign } = await run(ws, tpl, { deps: { transport: fake, CampaignMessage: brokenMessages } });
    expect(fake.sent).toHaveLength(3);
    expect(new Set(fake.sent.map((s) => s.to)).size).toBe(3);
    expect(campaign.status).toBe('sent');
    expect(await LocalizedSend.countDocuments({ campaignId: campaign._id, status: 'sent' })).toBe(3);
  });

  test('a crash between the Meta call and the row update leaves the row `sending`; the resumer fails it as interrupted and never re-sends it', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const c = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const fake = liveFake();
    const { deps, runJobs } = makeDeps({ transport: fake });
    const created = await create(ws, tpl, { deps });
    await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
    // the process died right after the Meta call: the row is `sending`, the heartbeat goes stale
    await LocalizedSend.create({ workspaceId: ws.workspaceId, campaignId: created.id, customerId: c._id, phone: c.phone, status: 'sending', usedLanguage: 'ar' });
    await LocalizedCampaign.updateOne({ _id: created.id }, { $set: { lastHeartbeatAt: new Date(Date.now() - 3600 * 1000), claimedBy: 'dead' } });
    const second = makeDeps({ transport: fake });
    const res = await sender.resumeStuckCampaigns({}, second.deps);
    expect(res.resumed).toBe(1);
    await second.runJobs();
    expect(fake.sent).toHaveLength(0);
    expect(await LocalizedSend.findOne({ campaignId: created.id, customerId: c._id }).lean()).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(runJobs).toBeDefined();
  });
});

describe('consent-request campaign (opt_in template)', () => {
  const consentTemplate = (workspaceId) => fx.makeTemplate(workspaceId, {
    category: 'UTILITY',
    useCase: 'welcome_optin',
    variants: [
      fx.variant('en', { body: 'Hi {name}, want offers from {business}?', buttons: [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }] }),
      fx.variant('ar', { body: 'مرحبا {name}، هل تريد عروض {business}؟', buttons: [{ role: 'opt_in', text: 'نعم' }, { role: 'decline', text: 'لا' }] }),
    ],
  });

  test('targets only customers who have not consented / opted out / been asked this week, stamps the ask, and a typed "نعم" then grants consent', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await consentTemplate(ws.workspaceId);
    const target = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'ar', firstname: 'منى' });
    const already = await fx.makeCustomer(ws.workspaceId, { marketingConsent: true, language: 'ar' });
    const out = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, optedOut: true });
    const asked = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, marketingConsentAskedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000) });

    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(fake.sent.map((s) => s.to)).toEqual([target.phone]);
    expect(campaign.status).toBe('sent');
    // the UTILITY floor: welcome_optin is not transactional, so even a template stored as UTILITY runs as MARKETING
    // (the consent-request exemption above is what lets it reach customers who have not consented)
    expect(campaign.category).toBe('MARKETING');
    // button payloads are the ones the existing webhook dispatches
    const buttons = fake.sent[0].components.filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);
    expect(buttons).toEqual([`consent_yes_${target._id}`, `consent_no_${target._id}`]);
    expect(fake.sent[0].languageCode).toBe('ar');

    const message = await CampaignMessage.findOne({ customer: target._id }).lean();
    expect(message.kind).toBe('consent_request');
    const stamped = await Customer.findById(target._id).lean();
    expect(stamped.marketingConsentAskedAt).toBeTruthy();
    for (const untouched of [already, out]) {
      expect(await CampaignMessage.countDocuments({ customer: untouched._id })).toBe(0);
    }
    expect((await Customer.findById(asked._id).lean()).marketingConsentAskedAt.getTime()).toBe(asked.marketingConsentAskedAt.getTime());

    // the customer answers in words instead of tapping: the stamp makes the ask pending
    const deps = { ...hook.realDeps(), log: () => {} };
    const handled = await hook.handleInbound({ workspaceId: ws.workspaceId, from: target.phone, message: { id: 'wamid.typed-yes', type: 'text', text: { body: 'نعم' } } }, deps);
    expect(handled).toBe(true);
    expect((await Customer.findById(target._id).lean()).marketingConsent).toBe(true);
    expect((await ConsentEvent.find({ customerId: target._id }).lean()).map((e) => e.type)).toEqual(['consent_given']);
  });

  test('a second consent request right away skips the people just asked and the ones who said yes', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await consentTemplate(ws.workspaceId);
    const a = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'en' });
    const fake = liveFake();
    await run(ws, tpl, { deps: { transport: fake } });
    expect(fake.sent).toHaveLength(1);
    const again = liveFake();
    const second = await create(ws, tpl, { deps: makeDeps().deps });
    expect(second.plan.canSend).toBe(false); // nobody left to ask
    const { deps } = makeDeps({ transport: again });
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: second.id }, deps)).rejects.toMatchObject({ status: 422, code: 'NOTHING_TO_SEND' });
    expect(again.sent).toHaveLength(0);
    expect(a._id).toBeTruthy();
  });
});

describe('template and value rules at send time', () => {
  test('a MARKETING variant without the opt-out button is never sendable', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { variants: [fx.variant('en', { buttons: [] }), fx.variant('ar')] });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const { deps } = makeDeps({ transport: liveFake() });
    const created = await create(ws, tpl, { deps });
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps)).rejects.toMatchObject({ status: 422, code: 'TEMPLATE_UNUSABLE' });
  });

  test('missing merge-field values are refused (422) and bad values are rejected at creation (400)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, { variants: [fx.variant('en', { body: 'Hi {name}, {discount} off at {business}' }), fx.variant('ar', { body: 'مرحبا {name}، خصم {discount}' })] });
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const { deps } = makeDeps({ transport: liveFake() });
    const plan = await campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' } } });
    expect(plan.missingFieldValues).toEqual(['discount']);
    expect(plan.canSend).toBe(false);
    const draft = await create(ws, tpl, { deps });
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: draft.id }, deps)).rejects.toMatchObject({ status: 422, code: 'FIELD_VALUES_MISSING' });
    await expect(create(ws, tpl, { deps, body: { fieldValues: { discount: 'line1\nline2' } } })).rejects.toMatchObject({ status: 400 });
    await expect(create(ws, tpl, { deps, body: { fieldValues: { 'Bad Key': 'x' } } })).rejects.toMatchObject({ status: 400 });

    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake }, body: { fieldValues: { discount: '٢٠٪' } } });
    expect(campaign.status).toBe('sent');
    const bodyText = fake.sent[0].components.find((c) => c.type === 'body').parameters.map((p) => p.text).join('|');
    expect(bodyText).toContain('٢٠٪');
  });

  test('bilingual mode sends the bilingual variant to everyone, whatever their language', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, {
      variants: [fx.variant('en'), fx.variant('ar'), fx.variant('bilingual', { body: 'مرحبا {name} | Hi {name}', bilingualOrder: 'ar_first', metaLanguage: 'ar', reviewStatus: 'reviewed' })],
    });
    await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake }, body: { languageMode: 'bilingual' } });
    expect(campaign.status).toBe('sent');
    expect(campaign.stats.byLanguage).toMatchObject({ bilingual: 2, en: 0, ar: 0 });
    expect(new Set(fake.sent.map((s) => s.name)).size).toBe(1);
  });
});

describe('limits and scale', () => {
  test('a 230-recipient campaign is sent exactly once each, in order, across the 200-row insert chunks and 50-row batches', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const Customer_ = Customer;
    const docs = Array.from({ length: 230 }, (_, i) => ({
      workspaceId: ws.workspaceId, firstname: `N${i}`, lastname: 'T', phone: `9665${String(30000000 + i).padStart(8, '0')}`, marketingConsent: true,
    }));
    await Customer_.insertMany(docs, { ordered: false });
    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(campaign.status).toBe('sent');
    expect(campaign.stats).toMatchObject({ total: 230, sent: 230, failed: 0, skipped: 0 });
    expect(new Set(fake.sent.map((s) => s.to)).size).toBe(230);
    expect(await LocalizedSend.countDocuments({ campaignId: campaign._id, status: 'sent' })).toBe(230);
    expect(await CampaignMessage.countDocuments({ workspaceId: ws.workspaceId })).toBe(230);
    expect(campaign.lastHeartbeatAt).toBeTruthy();
  });

  test('an audience above the 5000-recipient cap is refused with INVALID_INPUT, nothing is written', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const docs = Array.from({ length: 5001 }, (_, i) => ({
      workspaceId: ws.workspaceId, firstname: `B${i}`, lastname: 'T', phone: `9665${String(40000000 + i).padStart(8, '0')}`, marketingConsent: true,
    }));
    await Customer.insertMany(docs, { ordered: false });
    await expect(campaigns.plan({ workspaceId: ws.workspaceId, body: { templateId: String(tpl._id), audience: { kind: 'all_eligible' } } }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(await LocalizedCampaign.countDocuments({ workspaceId: ws.workspaceId })).toBe(0);
  });

  test('cancelling a draft never deletes it; a finished campaign cannot be cancelled (409)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    const { deps } = makeDeps({ transport: liveFake() });
    const draft = await create(ws, tpl, { deps });
    const cancelled = await campaigns.cancel({ workspaceId: ws.workspaceId, id: draft.id }, deps);
    expect(cancelled.status).toBe('cancelled');
    expect(await LocalizedCampaign.countDocuments({ _id: draft.id })).toBe(1);
    await expect(sender.startSend({ workspaceId: ws.workspaceId, campaignId: draft.id }, deps)).rejects.toMatchObject({ status: 409 });
    const { created } = await run(ws, tpl, { deps: { transport: liveFake() } });
    await expect(campaigns.cancel({ workspaceId: ws.workspaceId, id: created.id }, deps)).rejects.toMatchObject({ status: 409, code: 'CAMPAIGN_NOT_DRAFT' });
    expect(mongoose.connection.readyState).toBe(1);
  });
});
