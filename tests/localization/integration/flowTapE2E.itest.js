const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// End to end through the REAL server.js webhook (button tap on a flow / promotion entry message -> branching
// follow-up) on the throwaway mongod, no network: the English follow-up goes through utils/whatsapp#waPost into an axios
// adapter stub that records the call and answers with a fake wamid; the Arabic one through
// shared/localization/transport.js in LOCALIZATION_SEND_MODE=dry_run.
//   * Arabic customer + reviewed Arabic follow-up of a flagged workspace -> ONE interactive Arabic message with the
//     positional ids, a CampaignMessage row (workspaceId, wamid), and NOTHING sent in English;
//   * English customer / draft row / stale row / no row / kill switch -> the English follow-up exactly;
//   * a failing Arabic send -> a failed row and no English message; double tap -> one message.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'itest-secret-not-real';
const mongoose = require('mongoose');
const request = require('supertest');
const crypto = require('crypto');
const app = require('../../../server');
const fx = require('./_fixtures');
const axios = require('axios');
const transport = require('../../../shared/localization/transport');
const settings = require('../../../shared/localization/settings');
const hook = require('../../../shared/localization/inboundHook');
const followUps = require('../../../shared/localization/flowFollowUps');
const Workspace = require('../../../models/Workspace');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedFlowNode = require('../../../models/LocalizedFlowNode');
const scheduler = require('../../../shared/localization/scheduler');

jest.setTimeout(90000);

const LRM = String.fromCodePoint(0x200E); // the Latin first name is wrapped in direction marks inside Arabic text
const calls = [];
let wamidSeq = 0; // unique per send: CampaignMessage.wamid is unique
const english = () => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST');
function installAdapter() {
  axios.defaults.adapter = async (config) => {
    let body = config.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
    calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body });
    return { data: { messaging_product: 'whatsapp', messages: [{ id: `wamid.recorded-english-${++wamidSeq}` }] }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}

let home;
beforeAll(async () => {
  await mongoose.connection.asPromise();
  await fx.connect();
  await LocalizedFlowNode.createIndexes();
  installAdapter();
  home = await Workspace.findOne().sort({ createdAt: 1 }).lean();
  if (!home) { const w = await fx.makeWorkspace(); home = w.workspace.toObject(); }
  await settings.setArabicEnabled({ workspaceId: home._id, enabled: true, grantedBy: 'itest' });
});
afterAll(async () => { scheduler.stopLocalizationScheduler(); await fx.disconnect(); });
beforeEach(() => { transport.clearDryRuns(); hook.resetHandled(); calls.length = 0; settings.clearCache(); delete process.env.LOCALIZATION_DISABLED; });
afterEach(() => { delete process.env.LOCALIZATION_DISABLED; });

const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
function tap(from, payload, contextId) {
  return request(app).post('/webhook').send({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'C' } }], messages: [{ from, id: wid(), type: 'button', button: { payload, text: 'x' }, context: { from: '1', id: contextId } }] } }] }],
  });
}
async function waitFor(fn, ms = 40000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const settle = () => new Promise((r) => setTimeout(r, 2000));

async function world({ language, arabic = 'reviewed', editEnglishAfter = false } = {}) {
  const promotion = await Promotion.create({ workspaceId: home._id, name: 'Eid', customerType: 'cash', scope: 'products', discountPercent: 10 });
  const follow = await MessageNode.create({
    workspaceId: home._id, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Great choice {{1}}!',
    buttons: [{ position: 0, label: 'Track it', nextAction: { type: 'end_flow' } }, { position: 1, label: 'Done', nextAction: { type: 'end_flow' } }],
  });
  const entry = await MessageNode.create({
    workspaceId: home._id, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}', templateName: `e2e_${fx.uniq ? fx.uniq() : Date.now()}`, templateStatus: 'approved',
    buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: follow._id } }],
  });
  await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
  const customer = await fx.makeCustomer(home._id, { language });
  const entryWamid = wid();
  await CampaignMessage.create({ workspaceId: home._id, kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: customer.phone, wamid: entryWamid, messageType: 'template', messageNode: entry._id, status: 'sent', sentAt: new Date() });
  if (arabic) {
    await followUps.saveVariant({ workspaceId: String(home._id), userId: undefined, nodeId: String(follow._id), input: { body: 'اختيار رائع يا {name}!', buttons: [{ position: 0, text: 'تتبع' }, { position: 1, text: 'تم' }] } });
    if (arabic === 'reviewed') {
      const view = await followUps.getFollowUp({ workspaceId: String(home._id), nodeId: String(follow._id) });
      await followUps.reviewVariant({ workspaceId: String(home._id), nodeId: String(follow._id), status: 'reviewed', contentVersion: view.variant.contentVersion });
    }
  }
  if (editEnglishAfter) await MessageNode.updateOne({ _id: follow._id }, { $set: { bodyText: 'Great choice {{1}}, enjoy!' } });
  return { promotion, follow, entry, customer, entryWamid };
}
const followRows = (w) => CampaignMessage.find({ customer: w.customer._id, messageNode: w.follow._id }).lean();
const arabicSends = () => transport.lastDryRuns().filter((d) => d.label === 'buttons' || d.label === 'text');

describe('tap -> follow-up through server.js', () => {
  test('Arabic customer + reviewed Arabic follow-up: one Arabic interactive message, the row, no English; a double tap sends nothing more', async () => {
    const w = await world({ language: 'ar' });
    await tap(w.customer.phone, `msgnode_${w.entry._id}_0`, w.entryWamid);
    const rows = await waitFor(async () => { const r = await followRows(w); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'sent', messageType: 'interactive', kind: 'promotion' });
    expect(String(rows[0].workspaceId)).toBe(String(home._id));
    expect(rows[0].wamid).toMatch(/^dryrun\./);
    const sends = arabicSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].payload.to).toBe(w.customer.phone);
    expect(sends[0].payload.interactive.body.text).toBe(`اختيار رائع يا ${LRM}Sara${LRM}!`);
    expect(sends[0].payload.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title])).toEqual([[`msgnode_${w.follow._id}_0`, 'تتبع'], [`msgnode_${w.follow._id}_1`, 'تم']]);
    expect(english()).toHaveLength(0);
    await tap(w.customer.phone, `msgnode_${w.entry._id}_0`, w.entryWamid);
    await settle();
    expect(arabicSends()).toHaveLength(1);
    expect(english()).toHaveLength(0);
    expect(await followRows(w)).toHaveLength(1);
  });

  test.each([
    ['English customer', { language: 'en' }],
    ['customer without a language record (English merchant default)', { language: undefined }],
    ['draft Arabic row', { language: 'ar', arabic: 'draft' }],
    ['stale Arabic row (English edited after review)', { language: 'ar', editEnglishAfter: true }],
    ['no Arabic row', { language: 'ar', arabic: null }],
  ])('%s -> the unchanged English follow-up', async (_name, opts) => {
    const w = await world(opts);
    await tap(w.customer.phone, `msgnode_${w.entry._id}_0`, w.entryWamid);
    const rows = await waitFor(async () => { const r = await followRows(w); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(arabicSends()).toHaveLength(0);
    expect(english()).toHaveLength(1);
    const payload = english()[0].body;
    expect(payload.type).toBe('interactive');
    expect(payload.interactive.body.text).toMatch(/^Great choice Sara/);
    expect(payload.interactive.action.buttons.map((b) => b.reply.title)).toEqual(['Track it', 'Done']);
    expect(rows[0].wamid).toMatch(/^wamid.recorded-english-/);
  });

  test('kill switch -> English even for an Arabic customer with a reviewed row', async () => {
    const w = await world({ language: 'ar' });
    process.env.LOCALIZATION_DISABLED = '1';
    await tap(w.customer.phone, `msgnode_${w.entry._id}_0`, w.entryWamid);
    const rows = await waitFor(async () => { const r = await followRows(w); return r.length ? r : null; });
    expect(rows).toHaveLength(1);
    expect(arabicSends()).toHaveLength(0);
    expect(english()).toHaveLength(1);
  });

  test('a failing Arabic send -> a failed row and NO English message', async () => {
    const w = await world({ language: 'ar' });
    const spy = jest.spyOn(transport, 'sendButtons').mockRejectedValueOnce(new Error('Meta says no'));
    try {
      await tap(w.customer.phone, `msgnode_${w.entry._id}_0`, w.entryWamid);
      const rows = await waitFor(async () => { const r = await followRows(w); return r.length ? r : null; });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', statusReason: 'Meta says no' });
    } finally { spy.mockRestore(); }
    expect(english()).toHaveLength(0);
  });
});
