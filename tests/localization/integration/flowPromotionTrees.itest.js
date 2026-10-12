const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// A promotion sent from the Promotions screen (custom entry message + two levels of branching follow-ups) and
// attached to NO flow, against the throwaway mongod, no network (axios adapter stub, LOCALIZATION_SEND_MODE=dry_run):
//   * GET /api/localization/flows/promotion-trees lists it (any template status) with its whole node tree; a promotion
//     that a flow sends is not repeated there (it stays under GET /flows/tree); flag off = 402, another tenant sees nothing;
//   * the Arabic follow-ups of BOTH levels are created / reviewed through the existing PUT / POST routes, the tree
//     reflects every step (draft -> reviewed -> sendable, stale after an English edit);
//   * real webhook taps: entry button -> Arabic level-1 follow-up, level-1 button -> Arabic level-2 follow-up
//     (rows with workspaceId + wamid, nothing in English); an English customer gets the English follow-ups.
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
const Workspace = require('../../../models/Workspace');
const User = require('../../../models/User');
const Membership = require('../../../models/Membership');
const Promotion = require('../../../models/Promotion');
const Flow = require('../../../models/Flow');
const MessageNode = require('../../../models/MessageNode');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedFlowNode = require('../../../models/LocalizedFlowNode');
const scheduler = require('../../../shared/localization/scheduler');

jest.setTimeout(120000);

const BASE = '/api/localization/flows';
const calls = [];
let wamidSeq = 0;
const RUN = `${process.pid}-${Date.now().toString(36)}`; // CampaignMessage.wamid is unique: never reuse one across runs of the same database
const english = () => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST');
function installAdapter() {
  axios.defaults.adapter = async (config) => {
    let body = config.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
    calls.push({ method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body });
    return { data: { messaging_product: 'whatsapp', messages: [{ id: `wamid.recorded-english-${RUN}-${++wamidSeq}` }] }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}

let home; // the OLDEST workspace: the one the single-workspace webhook resolves; Arabic switched on
let homeAuth;
let unflagged; // a second workspace WITHOUT the flag
let foreign; // a second FLAGGED workspace
beforeAll(async () => {
  await mongoose.connection.asPromise();
  await fx.connect();
  await LocalizedFlowNode.createIndexes();
  installAdapter();
  home = await Workspace.findOne().sort({ createdAt: 1 }).lean();
  if (!home) { const w = await fx.makeWorkspace({ arabic: false }); home = w.workspace.toObject(); }
  let membership = await Membership.findOne({ workspaceId: home._id }).lean();
  if (!membership) {
    const user = await User.create({ email: `fix1-${fx.uniq()}@example.test`, name: 'Owner' });
    membership = await Membership.create({ userId: user._id, workspaceId: home._id, role: 'owner' });
  }
  homeAuth = { Authorization: `Bearer ${fx.tokenFor({ userId: membership.userId, workspaceId: home._id })}` };
  await settings.setArabicEnabled({ workspaceId: home._id, enabled: true, grantedBy: 'itest' });
  unflagged = await fx.makeWorkspace({ arabic: false });
  foreign = await fx.makeWorkspace({ arabic: true });
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
const settle = () => new Promise((r) => setTimeout(r, 1500));
const get = (path, auth = homeAuth) => request(app).get(`${BASE}${path}`).set(auth);
const put = (path, body, auth = homeAuth) => request(app).put(`${BASE}${path}`).set(auth).send(body);
const post = (path, body, auth = homeAuth) => request(app).post(`${BASE}${path}`).set(auth).send(body);
const arabicSends = () => transport.lastDryRuns().filter((d) => d.label === 'buttons' || d.label === 'text');
const lines = (items, id) => items.find((i) => i.promotionId === String(id));

// A promotion with its own entry message (any template status) and a two-level follow-up chain.
async function promotionWithMessages(workspaceId, { name = 'Spring offer', templateStatus = 'approved' } = {}) {
  const promotion = await Promotion.create({ workspaceId, name, customerType: 'cash', scope: 'products', discountPercent: 10 });
  const level2 = await MessageNode.create({
    workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 2, bodyText: 'Last step {{1}}!',
    buttons: [{ position: 0, label: 'Done', nextAction: { type: 'end_flow' } }],
  });
  const level1 = await MessageNode.create({
    workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Great choice {{1}}!',
    buttons: [{ position: 0, label: 'More', nextAction: { type: 'send_message', targetNodeId: level2._id } }, { position: 1, label: 'Stop here', nextAction: { type: 'end_flow' } }],
  });
  const entry = await MessageNode.create({
    workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}', templateName: `fix1_${fx.uniq()}`, templateStatus,
    buttons: [{ position: 0, label: 'Go', nextAction: { type: 'send_message', targetNodeId: level1._id } }],
  });
  await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
  return { promotion, entry, level1, level2 };
}

async function saveAndReview(nodeId, body, buttons) {
  const saved = await put(`/followups/${nodeId}/variants/ar`, { body, buttons });
  expect(saved.status).toBe(200);
  const reviewed = await post(`/followups/${nodeId}/variants/ar/review`, { status: 'reviewed', contentVersion: saved.body.variant.contentVersion });
  expect(reviewed.status).toBe(200);
  return reviewed.body;
}

describe('GET /flows/promotion-trees', () => {
  test('lists a promotion with its own message and no flow, whatever its template status; every query is workspace-scoped', async () => {
    const mine = await promotionWithMessages(home._id, { name: 'Pending message promo', templateStatus: 'pending' });
    const res = await get('/promotion-trees');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    const row = lines(res.body.items, mine.promotion._id);
    expect(row).toMatchObject({
      ownerType: 'promotion', promotionName: 'Pending message promo', messageSource: 'promotion', entryTemplateStatus: 'pending',
    });
    expect(row.nodes.map((n) => [n.messageNodeId, n.parentNodeId, n.depth, n.isEntry])).toEqual([
      [String(mine.entry._id), null, 0, true], [String(mine.level1._id), String(mine.entry._id), 1, false], [String(mine.level2._id), String(mine.level1._id), 2, false],
    ]);
    expect(row.nodes[0]).toMatchObject({ canAddArabic: true, addArabicUrl: `/arabic/flows?node=${mine.entry._id}`, templateStatus: 'pending' });
    expect(row.nodes[1]).toMatchObject({ canAddArabic: true, addArabicUrl: `/arabic/flows?node=${mine.level1._id}`, versions: [] });
  });

  test('a promotion that a flow sends is listed under the flow only (never twice)', async () => {
    const used = await promotionWithMessages(home._id, { name: 'Sent by a flow' });
    const flow = await Flow.create({ workspaceId: home._id, name: 'Win-back flow', triggerType: 'inactive_customer', status: 'paused', promotionId: used.promotion._id });
    const free = await promotionWithMessages(home._id, { name: 'Free promo' });
    const promos = (await get('/promotion-trees')).body;
    expect(lines(promos.items, used.promotion._id)).toBeUndefined();
    expect(lines(promos.items, free.promotion._id)).toBeDefined();
    const trees = (await get('/tree')).body;
    const flowRow = trees.items.find((i) => i.flowId === String(flow._id));
    expect(flowRow).toMatchObject({ promotionId: String(used.promotion._id), messageSource: 'promotion' });
    expect(flowRow.nodes).toHaveLength(3);
    expect(trees.items.some((i) => i.promotionId === String(free.promotion._id))).toBe(false); // /tree is flows only (unchanged)
    expect(Object.keys(trees)).toEqual(['items']);
  });

  test('flag off = 402, no token = 401, another tenant never sees the rows (and cannot reach the nodes)', async () => {
    const mine = await promotionWithMessages(home._id, { name: 'Tenant isolation promo' });
    expect((await get('/promotion-trees', unflagged.auth)).status).toBe(402);
    expect((await request(app).get(`${BASE}/promotion-trees`)).status).toBe(401);
    const theirs = await get('/promotion-trees', foreign.auth);
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain(String(mine.promotion._id));
    expect(JSON.stringify(theirs.body)).not.toContain('Great choice');
    expect((await get(`/followups/${mine.level1._id}`, foreign.auth)).status).toBe(404);
    expect((await get(`/owners/promotion/${mine.promotion._id}/tree`, foreign.auth)).status).toBe(404);
    const theirOwn = await promotionWithMessages(foreign.workspaceId, { name: 'Their promo' });
    const ours = (await get('/promotion-trees')).body;
    expect(lines(ours.items, theirOwn.promotion._id)).toBeUndefined();
    expect(lines((await get('/promotion-trees', foreign.auth)).body.items, theirOwn.promotion._id)).toBeDefined();
  });

  test('the deep-link targets resolve: owner tree and follow-up of a promotion that has no flow; a bogus id is a 404', async () => {
    const mine = await promotionWithMessages(home._id, { name: 'Deep link promo' });
    const owner = await get(`/owners/promotion/${mine.promotion._id}/tree`);
    expect(owner.status).toBe(200);
    expect(owner.body.nodes.map((n) => n.messageNodeId)).toEqual([String(mine.entry._id), String(mine.level1._id), String(mine.level2._id)]);
    const follow = await get(`/followups/${mine.level2._id}`);
    expect(follow.status).toBe(200);
    expect(follow.body).toMatchObject({ messageNodeId: String(mine.level2._id), ownerType: 'promotion', ownerId: String(mine.promotion._id), variant: null });
    expect((await get(`/followups/${'0'.repeat(23)}9`)).status).toBe(404);
  });
});

describe('Arabic follow-ups of a promotion with no flow: author, review, tap', () => {
  test('both levels: save + review through the existing routes, the tree reflects every step, taps send the Arabic follow-ups', async () => {
    const w = await promotionWithMessages(home._id, { name: 'Two level promo' });
    const customer = await fx.makeCustomer(home._id, { language: 'ar' });
    const entryWamid = wid();
    await CampaignMessage.create({ workspaceId: home._id, kind: 'promotion', promotion: w.promotion._id, customer: customer._id, phone: customer.phone, wamid: entryWamid, messageType: 'template', messageNode: w.entry._id, status: 'sent', sentAt: new Date() });
    const rowOf = async () => lines((await get('/promotion-trees')).body.items, w.promotion._id);

    // level 1: a draft is saved but is not sendable and the English follow-up would still go out
    const draft = await put(`/followups/${w.level1._id}/variants/ar`, { body: 'اختيار رائع يا {name}!', buttons: [{ position: 0, text: 'المزيد' }, { position: 1, text: 'يكفي' }] });
    expect(draft.status).toBe(200);
    let row = await rowOf();
    expect(row.nodes[1]).toMatchObject({ canAddArabic: false, addArabicUrl: null });
    expect(row.nodes[1].versions[0]).toMatchObject({ language: 'ar', reviewStatus: 'draft', sendable: false, stale: false, metaStatus: 'NOT_REQUIRED' });

    // review level 1 and level 2
    const reviewed1 = await post(`/followups/${w.level1._id}/variants/ar/review`, { status: 'reviewed', contentVersion: draft.body.variant.contentVersion });
    expect(reviewed1.status).toBe(200);
    await saveAndReview(w.level2._id, 'الخطوة الأخيرة يا {name}!', [{ position: 0, text: 'تم' }]);
    row = await rowOf();
    expect(row.nodes[1].versions[0]).toMatchObject({ reviewStatus: 'reviewed', sendable: true });
    expect(row.nodes[2].versions[0]).toMatchObject({ reviewStatus: 'reviewed', sendable: true, editUrl: `/arabic/flows?node=${w.level2._id}` });

    // tap 1: entry button -> Arabic level-1 follow-up (a real webhook, nothing in English)
    await tap(customer.phone, `msgnode_${w.entry._id}_0`, entryWamid);
    const level1Row = await waitFor(async () => CampaignMessage.findOne({ customer: customer._id, messageNode: w.level1._id }).lean());
    expect(level1Row).toMatchObject({ status: 'sent', messageType: 'interactive' });
    expect(String(level1Row.workspaceId)).toBe(String(home._id));
    expect(arabicSends()).toHaveLength(1);
    expect(arabicSends()[0].payload.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title])).toEqual([[`msgnode_${w.level1._id}_0`, 'المزيد'], [`msgnode_${w.level1._id}_1`, 'يكفي']]);
    expect(english()).toHaveLength(0);

    // tap 2: the level-1 button answers the follow-up we just sent -> Arabic level-2 follow-up
    await tap(customer.phone, `msgnode_${w.level1._id}_0`, level1Row.wamid);
    const level2Row = await waitFor(async () => CampaignMessage.findOne({ customer: customer._id, messageNode: w.level2._id }).lean());
    expect(level2Row).toMatchObject({ status: 'sent' });
    expect(String(level2Row.workspaceId)).toBe(String(home._id));
    expect(arabicSends()).toHaveLength(2);
    expect(arabicSends()[1].payload.interactive.body.text).toContain('الخطوة الأخيرة');
    expect(arabicSends()[1].payload.interactive.action.buttons.map((b) => b.reply.title)).toEqual(['تم']);
    expect(english()).toHaveLength(0);
    await settle();
    expect(arabicSends()).toHaveLength(2);
  });

  test('an English customer of the same promotion gets the English follow-ups', async () => {
    const w = await promotionWithMessages(home._id, { name: 'English control promo' });
    await saveAndReview(w.level1._id, 'اختيار رائع يا {name}!', [{ position: 0, text: 'المزيد' }, { position: 1, text: 'يكفي' }]);
    const customer = await fx.makeCustomer(home._id, { language: 'en' });
    const entryWamid = wid();
    await CampaignMessage.create({ workspaceId: home._id, kind: 'promotion', promotion: w.promotion._id, customer: customer._id, phone: customer.phone, wamid: entryWamid, messageType: 'template', messageNode: w.entry._id, status: 'sent', sentAt: new Date() });
    await tap(customer.phone, `msgnode_${w.entry._id}_0`, entryWamid);
    const row = await waitFor(async () => CampaignMessage.findOne({ customer: customer._id, messageNode: w.level1._id }).lean());
    expect(row).toBeTruthy();
    expect(arabicSends()).toHaveLength(0);
    expect(english()).toHaveLength(1);
    expect(english()[0].body.interactive.body.text).toMatch(/^Great choice Sara/);
  });

  test('editing the English text after review makes the Arabic follow-up out of date in the promotion tree, and it stops sending', async () => {
    const w = await promotionWithMessages(home._id, { name: 'Stale promo' });
    await saveAndReview(w.level1._id, 'اختيار رائع يا {name}!', [{ position: 0, text: 'المزيد' }, { position: 1, text: 'يكفي' }]);
    await MessageNode.updateOne({ _id: w.level1._id }, { $set: { bodyText: 'Great choice {{1}}, enjoy!' } });
    const row = lines((await get('/promotion-trees')).body.items, w.promotion._id);
    expect(row.nodes[1].versions[0]).toMatchObject({ stale: true, sendable: false });
    const customer = await fx.makeCustomer(home._id, { language: 'ar' });
    const entryWamid = wid();
    await CampaignMessage.create({ workspaceId: home._id, kind: 'promotion', promotion: w.promotion._id, customer: customer._id, phone: customer.phone, wamid: entryWamid, messageType: 'template', messageNode: w.entry._id, status: 'sent', sentAt: new Date() });
    await tap(customer.phone, `msgnode_${w.entry._id}_0`, entryWamid);
    await waitFor(async () => CampaignMessage.findOne({ customer: customer._id, messageNode: w.level1._id }).lean());
    expect(arabicSends()).toHaveLength(0);
    expect(english()).toHaveLength(1);
  });

  test('"Add Arabic" for the entry message of such a promotion: the existing localize call creates the linked template and the tree links to it', async () => {
    const w = await promotionWithMessages(home._id, { name: 'Entry template promo' });
    const created = await post(`/messages/${w.entry._id}/localize`, {});
    expect([200, 201]).toContain(created.status);
    const row = lines((await get('/promotion-trees')).body.items, w.promotion._id);
    expect(row.nodes[0]).toMatchObject({ canAddArabic: true, addArabicUrl: `/arabic/templates/${created.body.id}` });
    expect(row.nodes[0].versions[0].language).toBe('en');
  });
});
