const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for the SAME-PHONE OPT-OUT rule (compliance).
//
// Customer.phone is not unique, and the existing opt-out paths (server.js STOP / optout_ and the
// Arabic hook) resolve the customer with findOne({ phone: from }) - so they opt out only the FIRST
// record whose stored phone EXACTLY equals the sender's number. A second record of the same person
// ("+966…" next to "966…", e.g. one added by the merchant and one auto-created by the Inbox) stays
// consented and would keep receiving campaigns. The audience resolution therefore excludes every
// recipient whose normalised phone matches ANY opted-out record of the same workspace, counts it as
// skipped.optedOut, and the sender honours it on every real send.
// UPDATE (H1, approved global change, design D3): the STOP paths now ALSO opt out every other record of the same normalised
// number in the workspace (shared/localization/samePhone.js), so the first test below asserts that instead of the old gap.
// The exclusion stays as the second line of defence for states that exist without a STOP (CSV imports of an already opted-out
// number, records added later); all other tests of this file build such states directly.
//
// Driven with the REAL models, the real inbound hook (to create the duplicate state the honest way)
// and the real planner/sender behind a FAKE live transport: nothing can reach WhatsApp.
const fx = require('./_fixtures');
const crypto = require('crypto');
const mongoose = require('mongoose');
const campaigns = require('../../../shared/localization/campaigns');
const sender = require('../../../shared/localization/campaignSender');
const planner = require('../../../shared/localization/campaignPlanner');
const audience = require('../../../shared/localization/audience');
const hook = require('../../../shared/localization/inboundHook');
const transport = require('../../../shared/localization/transport');
const Customer = require('../../../models/Customer');
const ConsentEvent = require('../../../models/ConsentEvent');
const LocalizedCampaign = require('../../../models/LocalizedCampaign');
const LocalizedSend = require('../../../models/LocalizedSend');

jest.setTimeout(120000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { transport.clearDryRuns(); hook.resetHandled(); });

const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
const textMsg = (body) => ({ id: wid(), type: 'text', text: { body } });
const hookDeps = () => ({ ...hook.realDeps(), log: () => {}, sleep: async () => {} });

let wamidSeq = 0;
function liveFake() {
  const sent = [];
  return {
    sent,
    isDryRun: () => false,
    extractWamid: transport.extractWamid,
    sendTemplate: async (to, args) => {
      sent.push({ to, ...args });
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

async function run(ws, tpl, { deps: over, body = {} } = {}) {
  const { deps, runJobs } = makeDeps(over);
  const created = await campaigns.create({
    workspaceId: ws.workspaceId, userId: ws.user._id,
    body: { name: 'Campaign', templateId: String(tpl._id), audience: { kind: 'all_eligible' }, ...body },
  }, deps);
  await sender.startSend({ workspaceId: ws.workspaceId, campaignId: created.id }, deps);
  await runJobs();
  return { created, campaign: await LocalizedCampaign.findById(created.id).lean() };
}

const plan = (ws, tpl, audienceSpec = { kind: 'all_eligible' }) => planner.planCampaign({
  workspaceId: ws.workspaceId, request: { templateId: String(tpl._id), languageMode: 'per_customer', audience: audienceSpec, fieldValues: {} },
});

// "966 50 123 4567" style, to prove the stored format does not matter
const spaced = (digits) => `+${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
const rowOf = (campaign, customer) => LocalizedSend.findOne({ campaignId: campaign._id, customerId: customer._id }).lean();

describe('the real STOP path leaves the other record of the same number consented - the campaign must not reach it', () => {
  test('STOP typed in Arabic from 966… opts out the record stored as 966… AND (H1) the +966… record of the same number; neither is planned or sent to', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const digits = fx.nextPhone();
    const merchantRecord = await fx.makeCustomer(ws.workspaceId, { phone: `+${digits}`, language: 'en', firstname: 'Layla' }); // added by the merchant
    const inboxRecord = await fx.makeCustomer(ws.workspaceId, { phone: digits, language: 'en', firstname: digits }); // auto-created by the Inbox from WhatsApp's `from`
    const bystander = await fx.makeCustomer(ws.workspaceId, { language: 'en' });

    // the honest way to create the state: the person texts STOP from her WhatsApp number
    expect(await hook.handleInbound({ workspaceId: ws.workspaceId, from: digits, message: textMsg('توقف'), contactName: 'Layla' }, hookDeps())).toBe(true);
    const afterInbox = await Customer.findById(inboxRecord._id).lean();
    const afterMerchant = await Customer.findById(merchantRecord._id).lean();
    expect(afterInbox.optedOut).toBe(true); // the exact match was opted out...
    // H1 (approved global change, design D3): ...and so is the OTHER record of the same person, with its own consent event. This
    // test used to assert the old gap (afterMerchant.optedOut === false and no event); the same-phone exclusion in the planner
    // (the other tests of this file) is now the second line of defence for states that exist without a STOP.
    expect(afterMerchant.optedOut).toBe(true);
    expect(afterMerchant.optedOutAt).toBeInstanceOf(Date);
    expect(afterMerchant.marketingConsent).toBe(true); // only the opt-out flag changes, never the consent history
    const merchantEvents = await ConsentEvent.find({ customerId: merchantRecord._id }).lean();
    expect(merchantEvents).toHaveLength(1);
    expect(merchantEvents[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command' });
    expect(merchantEvents[0].source).toContain('(same number, other customer record)');
    expect(await ConsentEvent.countDocuments({ customerId: inboxRecord._id })).toBe(1); // the primary keeps exactly the one event it always got

    const p = await plan(ws, tpl);
    expect(p.audience.eligible).toBe(1); // only the bystander
    expect(p.skipped.optedOut).toBe(2); // both records of her number are opted out and counted, not loaded
    expect(p.canSend).toBe(true);

    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(fake.sent.map((s) => s.to)).toEqual([bystander.phone]); // Meta was never called for either record of Layla's number
    expect(campaign.status).toBe('sent'); // policy skips do not make a campaign partial
    expect(campaign.plan.skipped.optedOut).toBe(2);
    expect(await LocalizedSend.countDocuments({ campaignId: campaign._id, customerId: merchantRecord._id })).toBe(0); // opted-out records are counted, not loaded
    expect(await LocalizedSend.countDocuments({ campaignId: campaign._id, customerId: inboxRecord._id })).toBe(0);
    expect(await rowOf(campaign, bystander)).toMatchObject({ status: 'sent' });
  });

  test('the stored format of either record does not matter (spaced, +, 00, plain)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const cases = [
      (d) => [spaced(d), d], // consented: "+966 50 123 4567"   opted out: "966501234567"
      (d) => [d, `+${d}`],
      (d) => [`00${d}`, d],
      (d) => [`+${d}`, spaced(d)],
    ];
    const alive = [];
    for (const make of cases) {
      const [aliveFormat, outFormat] = make(fx.nextPhone());
      alive.push(await fx.makeCustomer(ws.workspaceId, { phone: aliveFormat, language: 'en' }));
      await fx.makeCustomer(ws.workspaceId, { phone: outFormat, optedOut: true, marketingConsent: false });
    }
    const free = await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(fake.sent.map((s) => s.to)).toEqual([free.phone]);
    for (const customer of alive) expect(await rowOf(campaign, customer)).toMatchObject({ status: 'skipped_opted_out', errorCode: 'opted_out_same_phone' });
  });
});

describe('scope of the rule', () => {
  test('only an OPTED-OUT record counts: a sibling that merely lacks consent excludes nobody', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const digits = fx.nextPhone();
    const consented = await fx.makeCustomer(ws.workspaceId, { phone: digits, language: 'en' });
    await fx.makeCustomer(ws.workspaceId, { phone: `+${digits}`, marketingConsent: false, optedOut: false });
    const p = await plan(ws, tpl);
    expect(p.audience.eligible).toBe(1);
    expect(p.skipped.optedOut).toBe(0);
    const fake = liveFake();
    await run(ws, tpl, { deps: { transport: fake } });
    expect(fake.sent.map((s) => s.to)).toEqual([consented.phone]);
  });

  test('tenant isolation: an opted-out record of ANOTHER workspace with the same phone excludes nobody here', async () => {
    const mine = await fx.makeWorkspace();
    const theirs = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(mine.workspaceId);
    const digits = fx.nextPhone();
    const customer = await fx.makeCustomer(mine.workspaceId, { phone: digits, language: 'en' });
    await fx.makeCustomer(theirs.workspaceId, { phone: digits, optedOut: true, marketingConsent: false });
    const fake = liveFake();
    const { campaign } = await run(mine, tpl, { deps: { transport: fake } });
    expect(fake.sent.map((s) => s.to)).toEqual([customer.phone]);
    expect(campaign.plan.skipped.optedOut).toBe(0);
    expect(await audience.loadOptedOutPhones(campaigns.realDeps(), mine.workspaceId)).toEqual(new Set());
    expect([...(await audience.loadOptedOutPhones(campaigns.realDeps(), theirs.workspaceId))]).toEqual([digits]);
  });

  test('a transactional UTILITY campaign honours it too (no consent needed, but never to a number that opted out)', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId, {
      category: 'UTILITY', useCase: 'payment_reminder', variants: [fx.variant('en', { buttons: [], metaCategory: 'UTILITY' })],
    });
    const digits = fx.nextPhone();
    const twin = await fx.makeCustomer(ws.workspaceId, { phone: `+${digits}`, marketingConsent: false, language: 'en' });
    await fx.makeCustomer(ws.workspaceId, { phone: digits, optedOut: true, marketingConsent: false });
    const noConsent = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'en' });
    const fake = liveFake();
    const { campaign } = await run(ws, tpl, { deps: { transport: fake } });
    expect(campaign.category).toBe('UTILITY');
    expect(fake.sent.map((s) => s.to)).toEqual([noConsent.phone]);
    expect(await rowOf(campaign, twin)).toMatchObject({ status: 'skipped_opted_out', errorCode: 'opted_out_same_phone' });
  });

  test('customer_ids and sendSingle: the chosen record is refused with a reason, and the opted-out record itself stays opted_out', async () => {
    const ws = await fx.makeWorkspace();
    const tpl = await fx.makeTemplate(ws.workspaceId);
    const digits = fx.nextPhone();
    const twin = await fx.makeCustomer(ws.workspaceId, { phone: `+${digits}`, language: 'en' });
    const out = await fx.makeCustomer(ws.workspaceId, { phone: digits, optedOut: true, marketingConsent: false, language: 'en' });
    const resolved = await audience.resolveAudience({ workspaceId: ws.workspaceId, audience: { kind: 'customer_ids', customerIds: [String(twin._id), String(out._id)] } });
    expect(resolved.customers.map((c) => [c.id, c.skip]).sort()).toEqual([[String(twin._id), 'opted_out_phone'], [String(out._id), 'opted_out']].sort());
    expect(resolved.skipped.optedOut).toBe(2);

    const fake = liveFake();
    const { deps } = makeDeps({ transport: fake });
    const single = await sender.sendSingle({ workspaceId: ws.workspaceId, templateId: tpl._id, customerId: twin._id }, deps);
    expect(single).toMatchObject({ sent: false, status: 'skipped_opted_out', reason: 'opted_out_phone' });
    expect(fake.sent).toHaveLength(0);
  });
});

describe('cost: one bulk read per audience, never one per recipient', () => {
  test('resolving a 30-recipient audience runs exactly one opted-out lookup, scoped to the workspace', async () => {
    const ws = await fx.makeWorkspace();
    for (let i = 0; i < 30; i += 1) await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    await fx.makeCustomer(ws.workspaceId, { optedOut: true, marketingConsent: false });
    const seen = [];
    mongoose.set('debug', (collection, method, filter) => {
      if (collection === 'customers' && method === 'find' && filter && filter.optedOut === true) seen.push(filter);
    });
    try {
      const resolved = await audience.resolveAudience({ workspaceId: ws.workspaceId, audience: { kind: 'all_eligible' } });
      expect(resolved.eligible).toBe(30);
    } finally {
      mongoose.set('debug', false);
    }
    expect(seen).toHaveLength(1);
    expect(String(seen[0].workspaceId)).toBe(String(ws.workspaceId));
  });
});
