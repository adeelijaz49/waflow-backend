const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// End-to-end tests (REAL MongoDB on the throwaway mongod, REAL operations, routes and tap handler; only the HTTP adapter of
// axios is a recorder, so no real WhatsApp / Meta call is possible) of the opt-in / consent-request feature of the Promotions
// screen, with TWO customers (tenants) side by side:
//   - an unapproved custom message is submitted to Meta, the send is refused with 409 and remembered; once Meta approves the
//     notice is raised, the send goes through and the request is cleared; an edit after approval needs a new version
//   - the audience rules of a consent request (never opted-out, nobody already in, nobody asked this week) vs a standard promotion
//   - the tap payloads (promo: / msgnode_ / promotest:) and the consent snapshot stored from the SUBMITTED text
//   - opt-in / opt-out / interested taps through the real tap handler: redelivery idempotency, latest action wins, re-tap after
//     opt-out, START after opt-out, the same phone being a customer of both tenants
//   - the campaign report numbers, the consent log (JSON and CSV) and cross-tenant isolation of all of it through the routes
// Every test makes its own workspaces; nothing is ever deleted.
process.env.WA_WABA_ID = 'WABA_ITEST'; // the platform WhatsApp account: no Graph lookup is ever needed
const fx = require('./_fixtures');
process.env.LOCALIZATION_SEND_MODE = ''; // real (stubbed) HTTP, one recorder sees every call
delete process.env.PROMO_ENTRY_FALLBACK;
const crypto = require('crypto');
const axios = require('axios');
const request = require('supertest');
const express = require('express');

const calls = [];
const templates = new Map(); // name -> what Meta would answer for that template
let wamidSeq = 0;
let failTemplate = null; // { message, user }: the next template submission is refused by Meta (one shot)
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body, params: config.params };
  calls.push(rec);
  const isMessage = /\/messages$/.test(rec.url);
  const isTemplates = /\/message_templates$/.test(rec.url);
  let data;
  if (isTemplates && rec.method === 'POST' && failTemplate) {
    const f = failTemplate;
    failTemplate = null;
    const response = { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: f.message, error_user_msg: f.user, code: 100 } } };
    throw new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, {}, response);
  }
  if (isTemplates && rec.method === 'POST') {
    templates.set(body.name, { name: body.name, status: 'PENDING', category: body.category, language: body.language });
    data = { id: `tpl${++wamidSeq}`, status: 'PENDING', category: body.category };
  } else if (isTemplates && rec.method === 'GET') {
    const wanted = rec.params && rec.params.name;
    data = { data: [...templates.values()].filter((t) => !wanted || t.name === wanted) };
  } else if (rec.method === 'GET') data = { data: [] };
  else if (isMessage) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.CP${++wamidSeq}_${Date.now()}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const isMessage = (rec) => /\/messages$/.test(rec.url) && rec.method === 'POST';
const sent = () => calls.filter(isMessage).map((c) => c.body);
const sentTo = (customer) => sent().filter((m) => m.to === customer.phone);
const templatePosts = () => calls.filter((c) => c.method === 'POST' && /\/message_templates$/.test(c.url));
const metaSays = (name, status, extra = {}) => templates.set(name, { name, status, category: 'MARKETING', language: 'en', ...extra });
const buttonPayloads = (message) => (message.template.components || []).filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);
const bodyValues = (message) => (((message.template.components || []).find((c) => c.type === 'body') || { parameters: [] }).parameters).map((p) => p.text);

const ops = require('../../../shared/operations');
const settingsCache = require('../../../utils/settingsCache');
const { requireAuth } = require('../../../middleware/requireAuth');
const consent = require('../../../shared/consent');
const { handlePromoConsentTap } = require('../../../shared/promoConsentTap');
const Customer = require('../../../models/Customer');
const CampaignMessage = require('../../../models/CampaignMessage');
const ConsentEvent = require('../../../models/ConsentEvent');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const Product = require('../../../models/Product');

jest.setTimeout(180000);

const app = express();
app.use(express.json());
app.use('/api/promotions', requireAuth, require('../../../routes/promotions'));
app.use('/api/customers', requireAuth, require('../../../routes/customers'));
app.use('/api/message-nodes', requireAuth, require('../../../routes/messageNodes'));

beforeAll(async () => {
  await fx.connect();
  for (const M of [Promotion, MessageNode, CampaignMessage, ConsentEvent, Customer, Product]) { try { await M.init(); } catch (e) { /* best effort */ } }
  await fx.makeWorkspace({ arabic: false, merchantName: 'Aroma Cafe' }); // the first Settings in this database feeds settingsCache
});
afterAll(async () => { await fx.disconnect(); });

const SAVED = {};
const ENV = ['PROMO_ENTRY_FALLBACK', 'PROMO_DELIVERY_FIX', 'CONSENT_ASK_COOLDOWN_DAYS', 'CONSENT_REQUIRE_SIGNATURE', 'TEST_SEND_LIMIT_PER_HOUR'];
beforeEach(() => {
  calls.length = 0; settingsCache.invalidate(); replies.length = 0;
  for (const k of ENV) { SAVED[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV) { if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k]; }
});

// ── world builders ──────────────────────────────────────────────────────────────

const BODY = 'Hi {{1}}, Aroma Cafe here. Want offers like this on WhatsApp? Tap below. You can stop any time.';
const OPT_BUTTONS = [
  { position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in', replyText: 'Welcome aboard!' } },
  { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
];
const makeTenant = (merchantName = 'Aroma Cafe') => fx.makeWorkspace({ arabic: false, merchantName });
// POST /api/message-nodes/:id/refresh-status returns a check made in the last 20 s as it is (Meta rate-limits template reads per
// account). A test that changes Meta's answer and then polls straight away first makes the stored check look old.
const forgetLastCheck = (node) => MessageNode.updateOne({ _id: node._id }, { $unset: { templateLastCheckedAt: '' } });
const cust = (t, over = {}) => fx.makeCustomer(t.workspaceId, { firstname: 'Sara', lastname: 'Test', marketingConsent: false, ...over });
const digits = (c) => String(c.phone).replace(/\D/g, '');

async function consentPromotion(t, { body = BODY, buttons = OPT_BUTTONS, purpose = 'consent_request', promoOver = {} } = {}) {
  const promotion = await ops.createPromotion({
    workspaceId: t.workspaceId, name: `Opt in ${fx.uniq()}`, scope: 'products', customerType: 'cash', type: 'store_wide', purpose,
    ...(purpose === 'consent_request' ? { campaignType: 'consent_request' } : {}), ...promoOver,
  });
  const node = await ops.createMessageNode({ ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: body, buttons, workspaceId: t.workspaceId });
  await ops.updatePromotion({ id: promotion._id, workspaceId: t.workspaceId, entryNodeId: node._id });
  return { promotion, node };
}
// A promotion whose message went through the real submit and was approved by (stubbed) Meta.
async function approvedPromotion(t, opts) {
  const made = await consentPromotion(t, opts);
  await ops.submitMessageNodeTemplate({ nodeId: made.node._id, workspaceId: t.workspaceId });
  const submitted = await MessageNode.findById(made.node._id);
  metaSays(submitted.templateName, 'APPROVED');
  await ops.refreshMessageNodeTemplateStatus({ nodeId: made.node._id, workspaceId: t.workspaceId });
  return { promotion: made.promotion, node: await MessageNode.findById(made.node._id) };
}
const http = {
  send: (t, promotion, customers, path = 'send') => request(app).post(`/api/promotions/${promotion._id}/${path}`).set(t.auth).send({ customerIds: customers.map((c) => String(c._id)) }),
  get: (t, url) => request(app).get(url).set(t.auth),
};

// ── taps (the REAL tap handler; only the outgoing text is captured) ───────────────

const replies = [];
const tapDeps = { log: () => {}, sendText: async (to, body, o) => { replies.push({ to, body, workspaceId: o && o.workspaceId }); return {}; } }; // log: the refusals tested below are expected
const wid = () => `wamid.IN_${crypto.randomBytes(6).toString('hex')}`;
const TAP_TS = String(Math.floor(Date.UTC(2026, 9, 26, 9, 30, 0) / 1000));
async function tap(customer, cm, action, position, { inbound = wid(), text, from, signature = 'valid', promotionId, timestamp = TAP_TS } = {}) {
  return handlePromoConsentTap({
    from: from || digits(customer), signature, deps: tapDeps,
    message: { id: inbound, type: 'button', timestamp, context: { id: cm.wamid }, button: { payload: `promo:${promotionId || cm.promotion}:${action}:${position}`, text } },
  });
}
const nowTs = () => String(Math.floor(Date.now() / 1000)); // a tap made just now (after anything the test recorded a moment ago)
const cmOf = (promotion, customer) => CampaignMessage.findOne({ promotion: promotion._id, customer: customer._id }).sort({ createdAt: -1 }).lean();
const eventsOf = (customer) => ConsentEvent.find({ customerId: customer._id }).sort({ createdAt: 1, _id: 1 }).lean();

// ═══════════════════════════════════════════════════════════════════════════════

describe('block and notify, then approve, then send', () => {
  test('an unapproved message is submitted and the send refused (409) and remembered; approval raises the notice; the send then goes out and clears the request', async () => {
    const t = await makeTenant();
    const { promotion, node } = await consentPromotion(t);
    const customers = [await cust(t, { firstname: 'Aya' }), await cust(t, { firstname: 'Bader' }), await cust(t, { firstname: 'Dina' })];

    // 1. refused before any customer is touched, and the message goes to Meta by itself
    let res = await http.send(t, promotion, customers);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'pending', submittedNow: true });
    expect(res.body.message).toMatch(/sent to Facebook \(Meta\) for approval/);
    expect(templatePosts()).toHaveLength(1);
    const posted = templatePosts()[0].body;
    expect(posted).toMatchObject({ name: `waflow_flow_${String(node._id).slice(-10)}`, language: 'en', category: 'MARKETING' });
    expect(posted.components.find((c) => c.type === 'BODY').text).toBe(BODY);
    expect(posted.components.find((c) => c.type === 'FOOTER').text).toBe('Reply STOP to unsubscribe');
    expect(posted.components.find((c) => c.type === 'BUTTONS').buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Yes, send me offers' }, { type: 'QUICK_REPLY', text: 'No thanks' }]);
    expect(sent()).toHaveLength(0);
    expect(await CampaignMessage.countDocuments({ promotion: promotion._id })).toBe(0);
    expect(await Customer.countDocuments({ _id: { $in: customers.map((c) => c._id) }, marketingConsentAskedAt: { $ne: null } })).toBe(0);

    let n = await MessageNode.findById(node._id).lean();
    expect(n).toMatchObject({ templateStatus: 'pending', templateVersion: 1, templateWabaId: 'WABA_ITEST', templateCategory: 'MARKETING', templateName: posted.name });
    expect(n.templateSubmittedAt).toBeInstanceOf(Date);
    expect(n.templateSnapshot).toMatchObject({ bodyText: BODY, footer: 'Reply STOP to unsubscribe', language: 'en' });
    expect(n.templateSnapshot.buttons.map((b) => [b.position, b.label, b.action])).toEqual([[0, 'Yes, send me offers', 'opt_in'], [1, 'No thanks', 'opt_out']]);
    let p = await Promotion.findById(promotion._id).lean();
    expect(p.sendRequest.customerIds.map(String).sort()).toEqual(customers.map((c) => String(c._id)).sort());
    expect(String(p.sendRequest.requestedBy)).toBe(String(t.user._id));
    expect(p.sendRequest.requestedAt).toBeInstanceOf(Date);
    expect(p.sendRequest.approvedNoticeAt).toBeUndefined();

    // 2. pressed again while Meta is still looking: still refused, NOT submitted a second time
    res = await http.send(t, promotion, customers);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'pending', submittedNow: false });
    expect(res.body.message).toMatch(/still being reviewed/);
    expect(templatePosts()).toHaveLength(1);

    // 3. Meta approves; the manual refresh (what the screen's polling calls) raises the "you can now send" notice
    metaSays(n.templateName, 'APPROVED');
    await forgetLastCheck(node); // the send in step 2 read Meta a moment ago, and the route answers a check made in the last 20 s from memory
    res = await request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ templateStatus: 'approved', templateCategory: 'MARKETING' });
    expect(res.body.templateApprovedAt).toBeTruthy();
    p = await Promotion.findById(promotion._id).lean();
    expect(p.sendRequest.approvedNoticeAt).toBeInstanceOf(Date);
    expect(p.sendRequest.dismissedAt).toBeUndefined();
    res = await http.get(t, `/api/promotions/${promotion._id}`);
    expect(res.body.entryNodeId).toMatchObject({ templateStatus: 'approved', templateVersion: 1 });
    expect(res.body.entryNodeId.templateApprovedAt).toBeTruthy();
    expect(res.body.sendRequest.approvedNoticeAt).toBeTruthy();
    expect(res.body.sendRequest.customerIds).toHaveLength(3);
    res = await http.get(t, '/api/promotions');
    expect(res.body.find((x) => x._id === String(promotion._id)).entryNodeId).toMatchObject({ templateStatus: 'approved', templateVersion: 1 });

    // 4. now the send the merchant intended goes through
    calls.length = 0;
    res = await http.send(t, promotion, customers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sentCount: 3, skippedOptedOut: 0, skippedNoConsent: 0, skippedAlreadyOptedIn: 0, skippedAskedRecently: 0, errors: [] });
    expect(templatePosts()).toHaveLength(0);
    expect(sent()).toHaveLength(3);
    for (const c of customers) {
      const [m] = sentTo(c);
      expect(m).toMatchObject({ type: 'template', template: { name: n.templateName, language: { code: 'en' } } });
      expect(bodyValues(m)).toEqual([c.firstname]); // exactly the one value the submitted text has
      expect(buttonPayloads(m)).toEqual([`promo:${promotion._id}:opt_in:0`, `promo:${promotion._id}:opt_out:1`]);
      const row = await cmOf(promotion, c);
      expect(row).toMatchObject({ kind: 'promotion', messageType: 'template', status: 'sent', templateName: n.templateName });
      expect(String(row.messageNode)).toBe(String(node._id));
      expect(row.consentSnapshot).toMatchObject({
        promotionName: promotion.name, purpose: 'consent_request', templateName: n.templateName, templateVersion: 1, language: 'en',
        bodyTemplate: BODY, renderedBody: BODY.replace('{{1}}', c.firstname), footer: 'Reply STOP to unsubscribe',
      });
      expect(row.consentSnapshot.buttons.map((b) => [b.position, b.label, b.action, b.payload])).toEqual([
        [0, 'Yes, send me offers', 'opt_in', `promo:${promotion._id}:opt_in:0`], [1, 'No thanks', 'opt_out', `promo:${promotion._id}:opt_out:1`],
      ]);
      expect((await Customer.findById(c._id).lean()).marketingConsentAskedAt).toBeInstanceOf(Date);
    }
    p = await Promotion.findById(promotion._id).lean();
    expect(p.sendRequest).toBeUndefined(); // the intended send has been made
    expect(p).toMatchObject({ sentCount: 3, status: 'active' });

    // 5. the same customers again straight away: asked this week, so skipped (nothing sent twice)
    calls.length = 0;
    res = await http.send(t, promotion, customers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sentCount: 0, skippedAskedRecently: 3, skippedAlreadyOptedIn: 0, skippedOptedOut: 0 });
    expect(sent()).toHaveLength(0);
  });

  test('the screen\'s refresh answers a check made in the last 20 s from memory (Meta rate-limits template reads); operations that need the truth (sweeper, gate, Meta\'s news) always read fresh', async () => {
    const t = await makeTenant();
    const reads = () => calls.filter((c) => c.method === 'GET' && /\/message_templates$/.test(c.url)).length;
    const poll = (node) => request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(t.auth);

    const { node } = await consentPromotion(t);
    await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: t.workspaceId });
    const submitted = await MessageNode.findById(node._id).lean();
    expect(submitted.templateLastCheckedAt).toBeUndefined(); // a submit clears it: the first poll always reads Meta
    calls.length = 0;
    let res = await poll(node);
    expect(res.body.templateStatus).toBe('pending');
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    metaSays(submitted.templateName, 'APPROVED');
    res = await poll(node); // a second tab, a quick re-poll: no new read of Meta, the stored answer
    expect(res.body.templateStatus).toBe('pending');
    expect(reads()).toBe(afterFirst);

    await MessageNode.updateOne({ _id: node._id }, { $set: { templateLastCheckedAt: new Date(Date.now() - 25 * 1000) } });
    res = await poll(node); // older than 20 s: asks Meta again and learns the answer
    expect(res.body.templateStatus).toBe('approved');
    expect(reads()).toBeGreaterThan(afterFirst);

    // the operation itself (sweeper, send gate, Meta's status news) has no minimum age
    const other = await consentPromotion(t);
    await ops.submitMessageNodeTemplate({ nodeId: other.node._id, workspaceId: t.workspaceId });
    await poll(other.node);
    const otherName = (await MessageNode.findById(other.node._id).lean()).templateName;
    metaSays(otherName, 'APPROVED');
    const fresh = await ops.refreshMessageNodeTemplateStatus({ nodeId: other.node._id, workspaceId: t.workspaceId });
    expect(fresh.templateStatus).toBe('approved');
  });

  test('"dismiss" on the approval notice records dismissedAt (this customer only); a later approval does not raise it again', async () => {
    const A = await makeTenant('A cafe');
    const B = await makeTenant('B cafe');
    const { promotion, node } = await consentPromotion(A);
    const c = await cust(A);
    await http.send(A, promotion, [c]); // refused + remembered
    const submitted = await MessageNode.findById(node._id).lean();
    metaSays(submitted.templateName, 'APPROVED');
    await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: A.workspaceId });
    expect((await Promotion.findById(promotion._id).lean()).sendRequest.approvedNoticeAt).toBeInstanceOf(Date);

    // another customer cannot dismiss it
    let res = await request(app).post(`/api/promotions/${promotion._id}/dismiss-send-request`).set(B.auth);
    expect(res.status).toBe(404);
    expect((await Promotion.findById(promotion._id).lean()).sendRequest.dismissedAt).toBeUndefined();

    res = await request(app).post(`/api/promotions/${promotion._id}/dismiss-send-request`).set(A.auth);
    expect(res.status).toBe(200);
    expect(res.body._id).toBe(String(promotion._id));
    expect(res.body.sendRequest.dismissedAt).toBeTruthy();
    expect(res.body.sendRequest.approvedNoticeAt).toBeTruthy();
    expect((await Promotion.findById(promotion._id).lean()).sendRequest.dismissedAt).toBeInstanceOf(Date);

    // a promotion that never had a request: unchanged answer, nothing invented
    const other = await consentPromotion(A);
    res = await request(app).post(`/api/promotions/${other.promotion._id}/dismiss-send-request`).set(A.auth);
    expect(res.status).toBe(200);
    expect(res.body.sendRequest).toBeUndefined();
    // unknown / malformed id
    expect((await request(app).post(`/api/promotions/${new (require('mongoose').Types.ObjectId)()}/dismiss-send-request`).set(A.auth)).status).toBe(404);
    expect((await request(app).post('/api/promotions/not-an-id/dismiss-send-request').set(A.auth)).status).toBe(404);
  });

  test('Meta refuses the submission: the route answers with its reason, nothing is stored, no version is burned; a send says why (409) and still remembers the request', async () => {
    const t = await makeTenant();
    const { promotion, node } = await consentPromotion(t);
    const c = await cust(t);
    failTemplate = { message: 'Invalid parameter', user: 'The text is not allowed.' };
    let res = await request(app).post(`/api/message-nodes/${node._id}/submit-template`).set(t.auth);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ error: { message: 'Invalid parameter', error_user_msg: 'The text is not allowed.', code: 100 } }); // Meta's answer, as before
    expect(res.body.message).toBe('The text is not allowed.');
    expect(await MessageNode.findById(node._id).lean()).toMatchObject({ templateStatus: 'not_created' });
    expect((await MessageNode.findById(node._id).lean()).templateVersion).toBeUndefined();

    failTemplate = { message: 'Invalid parameter', user: 'The text is not allowed.' };
    res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'not_created', submittedNow: false, reason: 'The text is not allowed.' });
    expect(res.body.message).toMatch(/could not be sent to Facebook \(Meta\) for approval: The text is not allowed\./);
    expect(sent()).toHaveLength(0);
    expect((await Promotion.findById(promotion._id).lean()).sendRequest.customerIds.map(String)).toEqual([String(c._id)]);

    // Meta works again: the next try submits version 1 under the base name (nothing was burned by the refusals)
    res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ templateStatus: 'pending', submittedNow: true });
    expect(await MessageNode.findById(node._id).lean()).toMatchObject({ templateVersion: 1, templateName: `waflow_flow_${String(node._id).slice(-10)}` });
  });

  test('two sends pressed at the same moment submit the message once', async () => {
    const t = await makeTenant();
    const { promotion } = await consentPromotion(t);
    const customers = [await cust(t), await cust(t)];
    const [r1, r2] = await Promise.all([http.send(t, promotion, customers), http.send(t, promotion, customers)]);
    expect([r1.status, r2.status]).toEqual([409, 409]);
    expect(templatePosts()).toHaveLength(1);
  });

  test('a rejected message: refused with Meta\'s reason, never resubmitted by itself; editing it allows the next version', async () => {
    const t = await makeTenant();
    const { promotion, node } = await consentPromotion(t);
    const c = await cust(t);
    await http.send(t, promotion, [c]);
    const first = await MessageNode.findById(node._id).lean();
    metaSays(first.templateName, 'REJECTED', { rejected_reason: 'INVALID_FORMAT' });
    await forgetLastCheck(node); // the send above read Meta a moment ago (see "forgetLastCheck")
    let res = await request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(t.auth);
    expect(res.body).toMatchObject({ templateStatus: 'rejected' });
    expect(res.body.templateRejectedReason).toMatch(/INVALID_FORMAT/);

    calls.length = 0;
    res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'rejected', submittedNow: false });
    expect(res.body.message).toMatch(/INVALID_FORMAT/);
    expect(templatePosts()).toHaveLength(0);

    // the merchant edits it: needs submitting again, as version 2
    res = await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ bodyText: 'Hi {{1}}, a clearer message about offers on WhatsApp. Stop any time.' });
    expect(res.status).toBe(200);
    expect(res.body.templateStatus).toBe('not_created');
    expect(res.body.templateRejectedReason).toBeUndefined();
    res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ templateStatus: 'pending', submittedNow: true });
    expect(templatePosts()).toHaveLength(1);
    expect(templatePosts()[0].body.name).toBe(`${first.templateName}_v2`);
  });
});

describe('edit after approval', () => {
  test('changing the text or a label sends the message back to "needs submitting" and the next send uses a NEW version; old rows keep the old text', async () => {
    const t = await makeTenant();
    const { promotion, node } = await approvedPromotion(t);
    const v1 = node.templateName;
    const a = await cust(t, { firstname: 'Aya' });
    const b = await cust(t, { firstname: 'Bader' });

    // version 1 goes out
    calls.length = 0;
    let res = await http.send(t, promotion, [a]);
    expect(res.status).toBe(200);
    expect(sentTo(a)[0].template.name).toBe(v1);
    const rowV1 = await cmOf(promotion, a);
    expect(rowV1.consentSnapshot).toMatchObject({ templateName: v1, templateVersion: 1, renderedBody: BODY.replace('{{1}}', 'Aya') });

    // the merchant edits the text
    const NEW_BODY = 'Hi {{1}}, Aroma Cafe here. We would love to send you offers on WhatsApp. Tap below. Stop any time.';
    res = await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ bodyText: NEW_BODY });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ templateStatus: 'not_created', templateName: v1, bodyText: NEW_BODY });
    expect(res.body.templateApprovedAt).toBeUndefined();

    // the old approval must never be used for the new words
    calls.length = 0;
    res = await http.send(t, promotion, [b]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ templateStatus: 'pending', submittedNow: true });
    expect(sent()).toHaveLength(0);
    const v2 = `waflow_flow_${String(node._id).slice(-10)}_v2`;
    expect(templatePosts().map((c) => c.body.name)).toEqual([v2]);
    expect(templatePosts()[0].body.components.find((c) => c.type === 'BODY').text).toBe(NEW_BODY);
    let n = await MessageNode.findById(node._id).lean();
    expect(n).toMatchObject({ templateName: v2, templateVersion: 2, templateStatus: 'pending', bodyText: NEW_BODY });
    expect(n.templateSnapshot.bodyText).toBe(NEW_BODY);
    // while v1 is still APPROVED at Meta (never deleted) a refresh must not be fooled into approving v2 early
    expect(templates.get(v1).status).toBe('APPROVED');
    res = await request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(t.auth);
    expect(res.body.templateStatus).toBe('pending');

    // v2 approved: the send uses v2 and the row quotes the NEW text
    metaSays(v2, 'APPROVED');
    await forgetLastCheck(node); // the route answers a check made in the last 20 s from memory: let this one through
    await request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(t.auth);
    calls.length = 0;
    res = await http.send(t, promotion, [b]);
    expect(res.status).toBe(200);
    expect(sentTo(b)[0].template.name).toBe(v2);
    expect(bodyValues(sentTo(b)[0])).toEqual(['Bader']);
    const rowV2 = await cmOf(promotion, b);
    expect(rowV2.consentSnapshot).toMatchObject({ templateName: v2, templateVersion: 2, bodyTemplate: NEW_BODY, renderedBody: NEW_BODY.replace('{{1}}', 'Bader') });
    // the earlier row still says what was shown THEN
    expect((await cmOf(promotion, a)).consentSnapshot).toMatchObject({ templateName: v1, templateVersion: 1, renderedBody: BODY.replace('{{1}}', 'Aya') });

    // a changed label also resets
    res = await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ buttons: [
      { position: 0, label: 'Yes please', nextAction: { type: 'opt_in' } }, { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
    ] });
    expect(res.status).toBe(200);
    expect(res.body.templateStatus).toBe('not_created');
    n = await MessageNode.findById(node._id).lean();
    expect(n.templateName).toBe(v2);
  });

  test('changing only what a button DOES (its action or its reply) keeps the approval: no new version, the same template is used', async () => {
    const t = await makeTenant();
    const three = [...OPT_BUTTONS, { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } }];
    const { promotion, node } = await approvedPromotion(t, { buttons: three });
    const name = node.templateName;
    calls.length = 0;
    // new reply text, and the third button now does nothing
    const res = await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ buttons: [
      { position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in', replyText: 'A brand new welcome!' } },
      { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
      { position: 2, label: 'Tell me more', nextAction: { type: 'end_flow' } },
    ] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ templateStatus: 'approved', templateName: name });
    expect(res.body.templateApprovedAt).toBeTruthy();
    expect(templatePosts()).toHaveLength(0);
    const c = await cust(t);
    const out = await http.send(t, promotion, [c]);
    expect(out.status).toBe(200);
    const [m] = sentTo(c);
    expect(m.template.name).toBe(name);
    // the tap payload follows what the button does NOW: the third button is no longer a consent action
    expect(buttonPayloads(m)).toEqual([`promo:${promotion._id}:opt_in:0`, `promo:${promotion._id}:opt_out:1`, `msgnode_${node._id}_2`]);
    // saving the identical text again is not an edit either
    const same = await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ bodyText: BODY });
    expect(same.body.templateStatus).toBe('approved');
  });

  test('the consent snapshot comes from the SUBMITTED text even if the live text was changed behind the screen\'s back', async () => {
    const t = await makeTenant();
    const { promotion, node } = await approvedPromotion(t);
    await MessageNode.updateOne({ _id: node._id }, { $set: { bodyText: 'TAMPERED live text {{1}} not submitted' } }); // not through the operations
    const c = await cust(t, { firstname: 'Aya' });
    const out = await http.send(t, promotion, [c]);
    expect(out.status).toBe(200);
    expect(bodyValues(sentTo(c)[0])).toEqual(['Aya']);
    const row = await cmOf(promotion, c);
    expect(row.consentSnapshot.bodyTemplate).toBe(BODY);
    expect(row.consentSnapshot.renderedBody).toBe(BODY.replace('{{1}}', 'Aya'));
    expect(JSON.stringify(row.consentSnapshot)).not.toMatch(/TAMPERED/);
  });

  test('a message approved under ANOTHER WhatsApp account is submitted again under the sending account', async () => {
    const t = await makeTenant();
    const { promotion, node } = await approvedPromotion(t);
    await MessageNode.updateOne({ _id: node._id }, { $set: { templateWabaId: 'WABA_OTHER' } });
    calls.length = 0;
    const res = await http.send(t, promotion, [await cust(t)]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ templateStatus: 'pending', submittedNow: true });
    expect(templatePosts()[0].body.name).toMatch(/_v2$/);
    expect((await MessageNode.findById(node._id).lean()).templateWabaId).toBe('WABA_ITEST');
    expect(sent()).toHaveLength(0);
  });
});

describe('button rules and template pre-checks through the routes', () => {
  test('entry message: 25 characters allowed, 26 refused; follow-up: 20 allowed, 21 refused; consent actions only on a promotion\'s first message', async () => {
    const t = await makeTenant();
    const promotion = await ops.createPromotion({ workspaceId: t.workspaceId, name: 'P', scope: 'products', customerType: 'cash', type: 'store_wide' });
    const create = (over) => request(app).post('/api/message-nodes').set(t.auth).send({ ownerType: 'promotion', ownerId: String(promotion._id), bodyText: 'Hello there, see you soon.', ...over });
    const b = (label, type = 'end_flow') => [{ position: 0, label, nextAction: { type } }];
    expect((await create({ isEntryNode: true, buttons: b('x'.repeat(25)) })).status).toBe(201);
    let res = await create({ isEntryNode: true, buttons: b('x'.repeat(26)) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds 25 characters/);
    expect((await create({ isEntryNode: false, depth: 1, buttons: b('y'.repeat(20)) })).status).toBe(201);
    res = await create({ isEntryNode: false, depth: 1, buttons: b('y'.repeat(21)) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/exceeds 20 characters/);
    res = await create({ isEntryNode: false, depth: 1, buttons: b('Yes', 'opt_in') });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/first message of a promotion/);
    for (const type of ['opt_in', 'opt_out', 'interested']) expect((await create({ isEntryNode: true, buttons: b('Go', type) })).status).toBe(201);
    // a flow's message is not a promotion's
    res = await request(app).post('/api/message-nodes').set(t.auth).send({ ownerType: 'flow', ownerId: String(promotion._id), isEntryNode: true, bodyText: 'Hello there', buttons: b('Go', 'opt_in') });
    expect(res.status).toBe(400);
    // an update obeys the same limits (the stored node says whether it is an entry message)
    const entry = (await create({ isEntryNode: true, buttons: b('Go') })).body;
    expect((await request(app).put(`/api/message-nodes/${entry._id}`).set(t.auth).send({ buttons: b('z'.repeat(25), 'opt_in') })).status).toBe(200);
    expect((await request(app).put(`/api/message-nodes/${entry._id}`).set(t.auth).send({ buttons: b('z'.repeat(26)) })).status).toBe(400);
    const follow = (await create({ isEntryNode: false, depth: 1, buttons: [] })).body;
    expect((await request(app).put(`/api/message-nodes/${follow._id}`).set(t.auth).send({ buttons: b('z'.repeat(21)) })).status).toBe(400);
    expect((await request(app).put(`/api/message-nodes/${follow._id}`).set(t.auth).send({ buttons: b('Yes', 'opt_in') })).status).toBe(400);
  });

  test('submit-template refuses what Meta would refuse with a structured 400 and sends nothing; a good message is submitted', async () => {
    const t = await makeTenant();
    const { node } = await consentPromotion(t, { body: 'Want offers on WhatsApp? Say yes {{1}}', buttons: [
      { position: 0, label: 'Yes', nextAction: { type: 'opt_in' } }, { position: 1, label: 'Yes', nextAction: { type: 'opt_out' } },
    ] });
    let res = await request(app).post(`/api/message-nodes/${node._id}/submit-template`).set(t.auth);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEMPLATE_INVALID');
    expect(res.body.reasons.join(' ')).toMatch(/cannot end with a variable/);
    expect(res.body.reasons.join(' ')).toMatch(/both called "Yes"/);
    expect(res.body.message).toBe(res.body.error);
    expect(templatePosts()).toHaveLength(0);
    expect((await MessageNode.findById(node._id).lean()).templateStatus).toBe('not_created');

    // a consent request needs an Opt in button
    const noOptIn = await consentPromotion(t, { buttons: [{ position: 0, label: 'No thanks', nextAction: { type: 'opt_out' } }] });
    res = await request(app).post(`/api/message-nodes/${noOptIn.node._id}/submit-template`).set(t.auth);
    expect(res.status).toBe(400);
    expect(res.body.reasons.join(' ')).toMatch(/needs an "Opt in" button/);

    // fixed, then it goes through
    await request(app).put(`/api/message-nodes/${node._id}`).set(t.auth).send({ bodyText: 'Hi {{1}}, want offers on WhatsApp? Say yes below. Stop any time.', buttons: OPT_BUTTONS });
    res = await request(app).post(`/api/message-nodes/${node._id}/submit-template`).set(t.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ templateStatus: 'pending', templateVersion: 1 });
    expect(templatePosts()).toHaveLength(1);
    // pressing submit again with the same words does not use a second slot
    res = await request(app).post(`/api/message-nodes/${node._id}/submit-template`).set(t.auth);
    expect(res.status).toBe(200);
    expect(templatePosts()).toHaveLength(1);
  });
});

describe('the audience of a consent request vs a standard promotion', () => {
  async function population(t) {
    const day = 24 * 60 * 60 * 1000;
    const c = {
      optedIn: await cust(t, { firstname: 'In', marketingConsent: true }),
      fresh: await cust(t, { firstname: 'Fresh' }),
      outAfterIn: await cust(t, { firstname: 'OutIn', marketingConsent: true, optedOut: true }),
      outNever: await cust(t, { firstname: 'OutNever', optedOut: true }),
      askedYesterday: await cust(t, { firstname: 'Yesterday', marketingConsentAskedAt: new Date(Date.now() - 1 * day) }),
      askedLongAgo: await cust(t, { firstname: 'LongAgo', marketingConsentAskedAt: new Date(Date.now() - 10 * day) }),
      erased: await cust(t, { firstname: 'Erased', optedOut: true, deletedAt: new Date() }),
    };
    return { c, all: Object.values(c) };
  }
  const recipients = () => new Set(sent().map((m) => m.to));

  test('a consent request reaches only people who have not opted in, are not opted out and were not asked this week', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const { c, all } = await population(t);
    const stranger = await cust(other, { firstname: 'OtherTenant' });
    const { promotion } = await approvedPromotion(t);
    calls.length = 0;
    const res = await request(app).post(`/api/promotions/${promotion._id}/send`).set(t.auth)
      .send({ customerIds: [...all, stranger].map((x) => String(x._id)) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true, sentCount: 2, skippedOptedOut: 3, skippedNoConsent: 0, skippedAlreadyOptedIn: 1, skippedAskedRecently: 1, errors: [], demoCount: 0,
    });
    expect(recipients()).toEqual(new Set([c.fresh.phone, c.askedLongAgo.phone]));
    for (const never of [c.optedIn, c.outAfterIn, c.outNever, c.askedYesterday, c.erased, stranger]) expect(recipients().has(never.phone)).toBe(false);
    // only the people asked are marked as asked
    expect((await Customer.findById(c.fresh._id).lean()).marketingConsentAskedAt.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect((await Customer.findById(c.askedLongAgo._id).lean()).marketingConsentAskedAt.getTime()).toBeGreaterThan(Date.now() - 60000);
    expect((await Customer.findById(c.outNever._id).lean()).marketingConsentAskedAt).toBeUndefined();
    // the opted-out customers' state is untouched
    expect(await Customer.findById(c.outAfterIn._id).lean()).toMatchObject({ optedOut: true, marketingConsent: true });
  });

  test('CONSENT_ASK_COOLDOWN_DAYS changes who counts as "asked recently"', async () => {
    const t = await makeTenant();
    const { c, all } = await population(t);
    const { promotion } = await approvedPromotion(t);
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '30'; // the one asked 10 days ago is now recent too
    let res = await http.send(t, promotion, all);
    expect(res.body).toMatchObject({ sentCount: 1, skippedAskedRecently: 2 });
    expect(recipients()).toEqual(new Set([c.fresh.phone]));
    calls.length = 0;
    // with no cooldown at all everyone not opted in/out is asked again - except the person asked a moment ago (fresh, in the send above):
    // a minute's guard stays even then, because it is what stops two requests at the same moment from asking one person twice
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '0';
    res = await http.send(t, promotion, all);
    expect(res.body).toMatchObject({ sentCount: 2, skippedAskedRecently: 1, skippedAlreadyOptedIn: 1, skippedOptedOut: 3 });
    expect(recipients()).toEqual(new Set([c.askedYesterday.phone, c.askedLongAgo.phone]));
    expect(recipients().has(c.outNever.phone)).toBe(false);
    expect(recipients().has(c.outAfterIn.phone)).toBe(false);
    expect(recipients().has(c.erased.phone)).toBe(false);
    // a couple of minutes later the same person can be asked again (the other two were asked just now, so they are held back this time)
    await Customer.updateOne({ _id: c.fresh._id }, { $set: { marketingConsentAskedAt: new Date(Date.now() - 2 * 60000) } });
    calls.length = 0;
    res = await http.send(t, promotion, all);
    expect(res.body).toMatchObject({ sentCount: 1, skippedAskedRecently: 2 });
    expect(recipients()).toEqual(new Set([c.fresh.phone]));
  });

  test('two requests at the same moment ask each person exactly once (the claim is atomic) - with the default cooldown and with none', async () => {
    for (const cooldown of [undefined, '0']) {
      const t = await makeTenant();
      const people = [await cust(t, { firstname: 'Ann' }), await cust(t, { firstname: 'Bea' }), await cust(t, { firstname: 'Cat' })];
      const { promotion } = await approvedPromotion(t);
      calls.length = 0;
      if (cooldown === undefined) delete process.env.CONSENT_ASK_COOLDOWN_DAYS; else process.env.CONSENT_ASK_COOLDOWN_DAYS = cooldown;
      const [first, second] = await Promise.all([http.send(t, promotion, people), http.send(t, promotion, people)]);
      expect([first.status, second.status]).toEqual([200, 200]);
      for (const person of people) expect(sentTo(person)).toHaveLength(1); // never twice, however the two requests interleaved
      expect(first.body.sentCount + second.body.sentCount).toBe(3);
      expect(first.body.skippedAskedRecently + second.body.skippedAskedRecently).toBe(3); // the other request's share of each person
      expect(await CampaignMessage.countDocuments({ promotion: promotion._id })).toBe(3);
      for (const person of people) expect((await Customer.findById(person._id).lean()).marketingConsentAskedAt).toBeInstanceOf(Date);
    }
  });

  test('a STANDARD promotion keeps its rules (opted-in customers only) and exactly its old response keys', async () => {
    const t = await makeTenant();
    const { c, all } = await population(t);
    const made = await consentPromotion(t, { purpose: 'standard', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }], body: 'Hi {{1}}, {{2}} for {{3}} - {{4}}. See you soon.' });
    await ops.submitMessageNodeTemplate({ nodeId: made.node._id, workspaceId: t.workspaceId });
    const submitted = await MessageNode.findById(made.node._id).lean();
    metaSays(submitted.templateName, 'APPROVED');
    await ops.refreshMessageNodeTemplateStatus({ nodeId: made.node._id, workspaceId: t.workspaceId });
    calls.length = 0;
    const res = await http.send(t, made.promotion, all);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'errors', 'demoCount']);
    expect(res.body).toMatchObject({ sentCount: 1, skippedOptedOut: 3, skippedNoConsent: 3 });
    expect(recipients()).toEqual(new Set([c.optedIn.phone]));
    const [m] = sentTo(c.optedIn);
    expect(bodyValues(m)).toHaveLength(4); // an ordinary promotion keeps sending all four values
    expect(buttonPayloads(m)).toEqual([`msgnode_${made.node._id}_0`]);
    const row = await cmOf(made.promotion, c.optedIn);
    expect(row.consentSnapshot).toBeUndefined();
    expect((await Customer.findById(c.optedIn._id).lean()).marketingConsentAskedAt).toBeUndefined(); // nobody is marked as asked
  });

  test('the targeting view and the customers list filter by consent, inside this customer only', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const { c, all } = await population(t);
    const strangerIn = await cust(other, { firstname: 'StrangerIn', marketingConsent: true });
    const strangerNo = await cust(other, { firstname: 'StrangerNo' });
    const consentPromo = (await consentPromotion(t)).promotion;
    const standard = (await consentPromotion(t, { purpose: 'standard' })).promotion;
    const names = (rows) => rows.map((r) => r.firstname).sort();

    // consent request: default and "not_responded" = people who have not answered; "opted_out" lists nobody (never reachable)
    let res = await http.get(t, `/api/promotions/${consentPromo._id}/recommended-customers`);
    expect(names(res.body)).toEqual(['Fresh', 'LongAgo', 'Yesterday']);
    res = await http.get(t, `/api/promotions/${consentPromo._id}/recommended-customers?audience=not_responded`);
    expect(names(res.body)).toEqual(['Fresh', 'LongAgo', 'Yesterday']);
    res = await http.get(t, `/api/promotions/${consentPromo._id}/recommended-customers?audience=opted_out`);
    expect(res.body).toEqual([]);
    // standard promotion: the legacy view (everyone not opted out) unless an audience is asked for
    res = await http.get(t, `/api/promotions/${standard._id}/recommended-customers`);
    expect(names(res.body)).toEqual(['Fresh', 'In', 'LongAgo', 'Yesterday']);
    res = await http.get(t, `/api/promotions/${standard._id}/recommended-customers?audience=opted_in`);
    expect(names(res.body)).toEqual(['In']);
    res = await http.get(t, `/api/promotions/${standard._id}/recommended-customers?audience=opted_out`);
    expect(names(res.body)).toEqual(['Erased', 'OutIn', 'OutNever']);
    expect((await http.get(t, `/api/promotions/${standard._id}/recommended-customers?audience=bogus`)).status).toBe(400);
    // the other customer sees none of this customer's people
    res = await http.get(other, `/api/promotions/${standard._id}/recommended-customers`);
    expect(res.status).toBe(404);

    // customers list: filter + per-row consent fields
    res = await http.get(t, '/api/customers?consent=opted_in&limit=100');
    expect(names(res.body.customers)).toEqual(['In']);
    expect(res.body.total).toBe(1);
    res = await http.get(t, '/api/customers?consent=opted_out&limit=100');
    expect(names(res.body.customers)).toEqual(['Erased', 'OutIn', 'OutNever']);
    res = await http.get(t, '/api/customers?consent=not_responded&limit=100');
    expect(names(res.body.customers)).toEqual(['Fresh', 'LongAgo', 'Yesterday']);
    expect(res.body.customers.every((r) => r.consentStatus === 'not_responded')).toBe(true);
    res = await http.get(t, '/api/customers?limit=100');
    expect(res.body.total).toBe(all.length);
    const byName = Object.fromEntries(res.body.customers.map((r) => [r.firstname, r]));
    expect(byName.In.consentStatus).toBe('opted_in');
    expect(byName.OutIn.consentStatus).toBe('opted_out');
    expect(byName.Fresh.consentStatus).toBe('not_responded');
    expect((await http.get(t, '/api/customers?consent=nope')).status).toBe(400);
    res = await http.get(other, '/api/customers?consent=opted_in&limit=100');
    expect(names(res.body.customers)).toEqual(['StrangerIn']);
    expect(names((await http.get(other, '/api/customers?consent=not_responded&limit=100')).body.customers)).toEqual(['StrangerNo']);
    void strangerIn; void strangerNo;
  });
});

describe('tap payloads, test sends and the other gates', () => {
  test('a mix of buttons: consent actions carry promo:<promotion>:<action>:<position>, the others keep msgnode_; a test send uses promotest:', async () => {
    const t = await makeTenant();
    const buttons = [
      { position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in' } },
      { position: 1, label: 'Shop now', nextAction: { type: 'end_flow' } },
      { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } },
    ];
    const { promotion, node } = await approvedPromotion(t, { buttons });
    const c = await cust(t);
    calls.length = 0;
    let res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(200);
    expect(buttonPayloads(sentTo(c)[0])).toEqual([`promo:${promotion._id}:opt_in:0`, `msgnode_${node._id}_1`, `promo:${promotion._id}:interested:2`]);

    calls.length = 0;
    res = await request(app).post(`/api/promotions/${promotion._id}/test-send`).set(t.auth).send({ phone: '966500000042' });
    expect(res.status).toBe(200);
    const [m] = sent();
    expect(m.to).toBe('966500000042');
    expect(buttonPayloads(m)).toEqual([`promotest:${promotion._id}:opt_in:0`, `msgnode_${node._id}_1`, `promotest:${promotion._id}:interested:2`]);
    expect(bodyValues(m)).toEqual(['Test']);
    // nothing about a test send is recorded as a campaign message or marks anybody as asked
    expect(await CampaignMessage.countDocuments({ promotion: promotion._id, phone: '966500000042' })).toBe(0);
  });

  test('the preview shows every button with what it does, the footer and the template state; a consent request without a message says so', async () => {
    const t = await makeTenant();
    const { promotion, node } = await consentPromotion(t, { buttons: [...OPT_BUTTONS, { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } }] });
    let res = await http.get(t, `/api/promotions/${promotion._id}/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      isCustomEntryNode: true, isConsentRequest: true, templateStatus: 'not_created', footer: 'Reply STOP to unsubscribe', buttonLabel: 'Yes, send me offers',
      buttons: [
        { position: 0, label: 'Yes, send me offers', action: 'opt_in', replyText: 'Welcome aboard!' },
        { position: 1, label: 'No thanks', action: 'opt_out', replyText: null },
        { position: 2, label: 'Tell me more', action: 'interested', replyText: null },
      ],
    });
    expect(res.body.body).toBe(BODY.replace('{{1}}', 'Valued Customer'));
    await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: t.workspaceId });
    res = await http.get(t, `/api/promotions/${promotion._id}/preview`);
    expect(res.body).toMatchObject({ templateStatus: 'pending', templateVersion: 1 });
    const bare = await ops.createPromotion({ workspaceId: t.workspaceId, name: 'Bare', scope: 'products', customerType: 'cash', type: 'store_wide', purpose: 'consent_request' });
    res = await http.get(t, `/api/promotions/${bare._id}/preview`);
    expect(res.body).toMatchObject({ isConsentRequest: true, needsMessage: true, buttons: [], body: '' });
    // the other customer cannot preview it
    const other = await makeTenant();
    expect((await http.get(other, `/api/promotions/${promotion._id}/preview`)).status).toBe(404);
  });

  test('test sends go out from the shared number: never to the number of a customer who opted out (409), and limited per customer per hour (429); a refused send uses no slot', async () => {
    const t = await makeTenant();
    const other = await makeTenant();
    const { promotion } = await approvedPromotion(t);
    const otherApproved = await approvedPromotion(other);
    await cust(t, { optedOut: true, marketingConsent: false, phone: '966500000555' });
    const erased = await cust(t, { phone: '966500000556' });
    await Customer.updateOne({ _id: erased._id }, { $set: { deletedAt: new Date() } });
    process.env.TEST_SEND_LIMIT_PER_HOUR = '2';
    const testSend = (tenant, promo, phone) => request(app).post(`/api/promotions/${promo._id}/test-send`).set(tenant.auth).send({ phone });
    calls.length = 0;
    for (const phone of ['966500000555', '+966 500 000 555', '00966500000555', '966500000556']) { // every spelling of an opted-out / erased customer's number
      const res = await testSend(t, promotion, phone);
      expect({ phone, status: res.status, error: res.body.error }).toEqual({ phone, status: 409, error: 'test_send_refused' });
    }
    expect(sent()).toHaveLength(0);
    // the refusals used no slot: both allowed sends still go out, the third is over the limit
    expect((await testSend(t, promotion, '966500000042')).status).toBe(200);
    expect((await testSend(t, promotion, '966500000043')).status).toBe(200);
    const over = await testSend(t, promotion, '966500000044');
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('test_send_limit');
    expect(sent()).toHaveLength(2);
    // another customer has an allowance of its own; the limit is per customer, not per platform
    expect((await testSend(other, otherApproved.promotion, '966500000042')).status).toBe(200);
    // 0 = no limit
    process.env.TEST_SEND_LIMIT_PER_HOUR = '0';
    expect((await testSend(t, promotion, '966500000045')).status).toBe(200);
  });

  test('a test send of an unapproved message is refused the same way (409), submits it, and records no send request', async () => {
    const t = await makeTenant();
    const { promotion, node } = await consentPromotion(t);
    const res = await request(app).post(`/api/promotions/${promotion._id}/test-send`).set(t.auth).send({ phone: '966500000042' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'pending', submittedNow: true });
    expect(sent()).toHaveLength(0);
    expect(templatePosts()).toHaveLength(1);
    expect((await Promotion.findById(promotion._id).lean()).sendRequest).toBeUndefined();
    expect((await MessageNode.findById(node._id).lean()).templateStatus).toBe('pending');
    // no phone number: the plain old 400
    expect((await request(app).post(`/api/promotions/${promotion._id}/test-send`).set(t.auth).send({})).status).toBe(400);
  });

  test('a consent request with no message of its own, or without an Opt in button: 400 consent_request_invalid, nothing submitted or sent', async () => {
    const t = await makeTenant();
    const bare = await ops.createPromotion({ workspaceId: t.workspaceId, name: 'Bare', scope: 'products', customerType: 'cash', type: 'store_wide', purpose: 'consent_request' });
    const c = await cust(t);
    let res = await http.send(t, bare, [c]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'consent_request_invalid' });
    expect(res.body.message).toMatch(/Opt in/);
    const noOptIn = await consentPromotion(t, { buttons: [{ position: 0, label: 'No thanks', nextAction: { type: 'opt_out' } }] });
    await MessageNode.updateOne({ _id: noOptIn.node._id }, { $set: { templateStatus: 'approved', templateName: 'x_approved' } });
    res = await http.send(t, noOptIn.promotion, [c]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('consent_request_invalid');
    res = await request(app).post(`/api/promotions/${bare._id}/test-send`).set(t.auth).send({ phone: '966500000042' });
    expect(res.status).toBe(400);
    expect(templatePosts()).toHaveLength(0);
    expect(sent()).toHaveLength(0);
  });

  test('KILL SWITCH PROMO_ENTRY_FALLBACK=on: an ordinary promotion falls back to the default message (as before), a consent request is still refused', async () => {
    const t = await makeTenant();
    await Product.create({ workspaceId: t.workspaceId, name: 'Coffee beans', category: 'Coffee', basePrice: 50 });
    process.env.PROMO_ENTRY_FALLBACK = 'on';
    process.env.PROMO_DELIVERY_FIX = 'off';
    const std = await consentPromotion(t, { purpose: 'standard', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }], promoOver: { discountPercent: 10 } });
    await MessageNode.updateOne({ _id: std.node._id }, { $set: { templateStatus: 'pending', templateName: 'pending_one' } });
    const c = await cust(t, { marketingConsent: true });
    calls.length = 0;
    let res = await http.send(t, std.promotion, [c]);
    expect(res.status).toBe(200);
    expect(res.body.sentCount).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0].type).toBe('interactive'); // the default announcement, not the custom template
    expect(templatePosts()).toHaveLength(0);
    expect((await Promotion.findById(std.promotion._id).lean()).sendRequest).toBeUndefined();

    const cr = await consentPromotion(t);
    calls.length = 0;
    res = await http.send(t, cr.promotion, [await cust(t)]);
    expect(res.status).toBe(409);
    expect(sent()).toHaveLength(0);
    // and without the switch the ordinary promotion is refused too
    delete process.env.PROMO_ENTRY_FALLBACK;
    res = await http.send(t, std.promotion, [c]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'template_not_approved', templateStatus: 'pending', submittedNow: false });
  });

  test('demo data is never blocked: a demo promotion simulates (no WhatsApp call at all) even with an unapproved message', async () => {
    const t = await makeTenant();
    const { promotion } = await consentPromotion(t, { promoOver: { isDemo: true } });
    const c = await cust(t, { isDemo: true });
    const res = await http.send(t, promotion, [c]);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sentCount: 1, demoCount: 1 });
    expect(calls.filter((x) => x.method === 'POST')).toHaveLength(0);
    expect((await Customer.findById(c._id).lean()).marketingConsentAskedAt).toBeUndefined();
  });

  test('a send for a promotion the customer does not own is a 404 and never reaches the gate or Meta', async () => {
    const A = await makeTenant('A');
    const B = await makeTenant('B');
    const { promotion } = await consentPromotion(A);
    const c = await cust(A);
    const res = await http.send(B, promotion, [c]);
    expect(res.status).toBe(404);
    expect(templatePosts()).toHaveLength(0);
    expect((await MessageNode.findOne({ ownerId: promotion._id }).lean()).templateStatus).toBe('not_created');
    expect(await Promotion.findById(promotion._id).lean().then((p) => p.sendRequest)).toBeUndefined();
  });
});

describe('promotion input rules through the routes', () => {
  test('the wording acknowledgement is stamped by the server; a client cannot write the send request; a consent request cannot be a carousel', async () => {
    const t = await makeTenant();
    let res = await request(app).post('/api/promotions').set(t.auth).send({
      name: 'Ask', scope: 'products', customerType: 'cash', type: 'store_wide', purpose: 'consent_request', campaignType: 'consent_request',
      consentWordingAck: { at: '2001-01-01T00:00:00Z', by: 'forged', textHash: 'hash-1' }, sendRequest: { approvedNoticeAt: new Date().toISOString(), customerIds: [] },
    });
    expect(res.status).toBe(201);
    expect(res.body.purpose).toBe('consent_request');
    expect(res.body.sendRequest).toBeUndefined();
    expect(res.body.consentWordingAck.textHash).toBe('hash-1');
    expect(res.body.consentWordingAck.by).toBe(String(t.user._id));
    expect(new Date(res.body.consentWordingAck.at).getFullYear()).toBeGreaterThan(2020);
    const id = res.body._id;
    const at = res.body.consentWordingAck.at;
    res = await request(app).put(`/api/promotions/${id}`).set(t.auth).send({ consentWordingAck: { textHash: 'hash-1' }, name: 'Ask 2', sendRequest: { dismissedAt: new Date().toISOString() } });
    expect(res.status).toBe(200);
    expect(res.body.consentWordingAck.at).toBe(at); // same wording acknowledged: the original stays
    expect(res.body.sendRequest).toBeUndefined();
    res = await request(app).put(`/api/promotions/${id}`).set(t.auth).send({ sendFormat: 'carousel' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not as a carousel/);
    res = await request(app).post('/api/promotions').set(t.auth).send({ name: 'Bad', purpose: 'consent_request', sendFormat: 'carousel' });
    expect(res.status).toBe(400);
    res = await request(app).post('/api/promotions').set(t.auth).send({ name: 'Bad enum', purpose: 'nonsense' });
    expect(res.status).toBe(400);
    // an ordinary promotion is unchanged: purpose defaults to standard, carousel allowed
    res = await request(app).post('/api/promotions').set(t.auth).send({ name: 'Plain', sendFormat: 'carousel' });
    expect(res.status).toBe(201);
    expect(res.body.purpose).toBe('standard');
  });

  test('another customer\'s message cannot be attached to my promotion', async () => {
    const A = await makeTenant('A');
    const B = await makeTenant('B');
    const theirs = await consentPromotion(A);
    const mine = await ops.createPromotion({ workspaceId: B.workspaceId, name: 'Mine', scope: 'products', customerType: 'cash', type: 'store_wide' });
    let res = await request(app).put(`/api/promotions/${mine._id}`).set(B.auth).send({ entryNodeId: String(theirs.node._id) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong to this workspace/);
    expect((await Promotion.findById(mine._id).lean()).entryNodeId).toBeUndefined();
    res = await request(app).post('/api/promotions').set(B.auth).send({ name: 'Mine 2', entryNodeId: String(theirs.node._id) });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// taps, report, consent log and isolation share one world: tenant A (the customer under test) and tenant B

describe('taps, report, consent log and cross-tenant isolation', () => {
  let A; let B; let promo; let node; let custs; let rows;
  const NAMES = ['Aya', 'Bader', 'Dina', 'Eman', 'Faris', 'Ghada'];

  beforeAll(async () => {
    A = await makeTenant('A cafe');
    B = await makeTenant('B cafe');
    ({ promotion: promo, node } = await approvedPromotion(A, { buttons: [...OPT_BUTTONS, { position: 2, label: 'Tell me more', nextAction: { type: 'interested', replyText: 'Great, here is more!' } }] }));
    custs = [];
    for (const name of NAMES) custs.push(await cust(A, { firstname: name }));
    custs[2].firstname = '=HYPERLINK("http://evil","x")'; // a hostile name: becomes data in the CSV
    await Customer.updateOne({ _id: custs[2]._id }, { $set: { firstname: custs[2].firstname } });
    calls.length = 0;
    const res = await http.send(A, promo, custs);
    expect(res.status).toBe(200);
    expect(res.body.sentCount).toBe(6);
    rows = {};
    for (const c of custs) rows[String(c._id)] = await cmOf(promo, c);
    await CampaignMessage.updateMany({ promotion: promo._id }, { $set: { status: 'delivered', deliveredAt: new Date() } });
  });

  test('opt-in: consent recorded WITH evidence (what they saw, which button, when), the optedOut flag cleared, one reply; redelivery changes nothing and sends no second reply', async () => {
    const [aya] = custs;
    const cm = rows[String(aya._id)];
    const inbound = wid();
    const out = await tap(aya, cm, 'opt_in', 0, { inbound, text: 'Yes, send me offers' });
    expect(out).toMatchObject({ handled: true, outcome: 'opted_in' });
    const fresh = await Customer.findById(aya._id).lean();
    expect(fresh).toMatchObject({ marketingConsent: true, marketingConsentMethod: 'whatsapp_button', optedOut: false });
    const events = await eventsOf(aya);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'consent_given', method: 'whatsapp_button', promotionName: promo.name, buttonLabel: 'Yes, send me offers', buttonPosition: 0, buttonAction: 'opt_in',
      templateName: node.templateName, templateVersion: 1, sourceWamid: cm.wamid, inboundWamid: inbound, signature: 'valid',
      messageText: BODY.replace('{{1}}', 'Aya'),
    });
    expect(String(events[0].promotionId)).toBe(String(promo._id));
    expect(String(events[0].workspaceId)).toBe(String(A.workspaceId));
    expect(events[0].tappedAt.toISOString()).toBe('2026-10-26T09:30:00.000Z');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ to: digits(aya), body: 'Welcome aboard!' });
    expect(await CampaignMessage.findById(cm._id).lean()).toMatchObject({ clickedButtonAction: 'opt_in', clickedButtonPosition: 0 });

    // Meta delivers the same tap again
    const again = await tap(aya, cm, 'opt_in', 0, { inbound, text: 'Yes, send me offers' });
    expect(again).toMatchObject({ handled: true, duplicate: true });
    expect(await eventsOf(aya)).toHaveLength(1);
    expect(replies).toHaveLength(1);
    // now a standard promotion reaches this customer
    const std = (await consentPromotion(A, { purpose: 'standard', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }] }));
    await MessageNode.updateOne({ _id: std.node._id }, { $set: { templateStatus: 'approved', templateName: 'std_approved' } });
    calls.length = 0;
    const sendStd = await http.send(A, std.promotion, [aya]);
    expect(sendStd.body.sentCount).toBe(1);
  });

  test('opt-out then re-tap after opt-out: latest action wins, the whole history is kept, opted-out people are never reached in between', async () => {
    const bader = custs[1];
    const cm = rows[String(bader._id)];
    await tap(bader, cm, 'opt_in', 0, { text: 'Yes, send me offers' });
    expect(await Customer.findById(bader._id).lean()).toMatchObject({ marketingConsent: true, optedOut: false });
    const out = await tap(bader, cm, 'opt_out', 1, { text: 'No thanks' });
    expect(out).toMatchObject({ handled: true, outcome: 'opted_out' });
    expect(await Customer.findById(bader._id).lean()).toMatchObject({ optedOut: true });
    expect(replies.at(-1).body).toMatch(/won't send you any more offers.*START/);
    // opted out: not reachable by a standard promotion or a consent request
    calls.length = 0;
    const probe = await http.send(A, promo, [bader]);
    expect(probe.body).toMatchObject({ sentCount: 0, skippedOptedOut: 1 });
    expect(sent()).toHaveLength(0);
    // a "Yes" that WhatsApp stamped BEFORE the opt-out on record (a late or repeated delivery of the old tap) is not a change of mind
    const eventsBefore = (await eventsOf(bader)).length;
    const late = await tap(bader, cm, 'opt_in', 0, { text: 'Yes, send me offers' }); // default timestamp: this morning, long before the opt-out above
    expect(late).toMatchObject({ handled: true, outcome: 'stale_tap' });
    expect(await Customer.findById(bader._id).lean()).toMatchObject({ optedOut: true });
    expect(await eventsOf(bader)).toHaveLength(eventsBefore); // nothing recorded, nothing answered
    // changes their mind by tapping Yes again on the same message, now
    await tap(bader, cm, 'opt_in', 0, { text: 'Yes, send me offers', timestamp: nowTs() });
    expect(await Customer.findById(bader._id).lean()).toMatchObject({ marketingConsent: true, optedOut: false });
    const history = await eventsOf(bader);
    expect(history.map((e) => e.type)).toEqual(['consent_given', 'consent_withdrawn', 'consent_given']);
    expect(history.map((e) => e.buttonAction)).toEqual(['opt_in', 'opt_out', 'opt_in']);
    expect(history[1].method).toBe('whatsapp_optout_button');
  });

  test('START after an opt-out records a FRESH opt-in (also for someone who never opted in before); a bare START from someone who never opted in or out stays as it was', async () => {
    const eman = custs[3];
    const cm = rows[String(eman._id)];
    await tap(eman, cm, 'opt_out', 1, { text: 'No thanks' }); // never opted in, opts out
    expect(await Customer.findById(eman._id).lean()).toMatchObject({ optedOut: true });
    const doc = await Customer.findById(eman._id);
    expect(await consent.reinstateMarketingConsent({ customer: doc, method: 'whatsapp_start_command', source: 'START', workspaceId: A.workspaceId })).toBe(true);
    const events = await eventsOf(eman);
    expect(events.map((e) => e.type)).toEqual(['consent_withdrawn', 'consent_given']);
    expect(events[1]).toMatchObject({ method: 'whatsapp_start_command', source: 'START after opt-out' });
    expect(await Customer.findById(eman._id).lean()).toMatchObject({ marketingConsent: true, optedOut: false, marketingConsentMethod: 'whatsapp_button' });

    const never = await cust(A, { firstname: 'Never' });
    expect(await consent.reinstateMarketingConsent({ customer: await Customer.findById(never._id), method: 'whatsapp_start_command', source: 'START', workspaceId: A.workspaceId })).toBe(false);
    expect(await eventsOf(never)).toHaveLength(0);
    expect(await Customer.findById(never._id).lean()).toMatchObject({ marketingConsent: false });
  });

  test('"interested" records the tap and the reply but writes no consent; a redelivery does nothing twice', async () => {
    const faris = custs[4];
    const cm = rows[String(faris._id)];
    const inbound = wid();
    const out = await tap(faris, cm, 'interested', 2, { inbound, text: 'Tell me more' });
    expect(out).toMatchObject({ handled: true, outcome: 'interested' });
    expect(await eventsOf(faris)).toHaveLength(0);
    expect(await Customer.findById(faris._id).lean()).toMatchObject({ marketingConsent: false, optedOut: false });
    expect(await CampaignMessage.findById(cm._id).lean()).toMatchObject({ clickedButtonAction: 'interested', clickedButtonPosition: 2 });
    expect(replies.at(-1)).toMatchObject({ to: digits(faris), body: 'Great, here is more!' });
    const before = replies.length;
    expect(await tap(faris, cm, 'interested', 2, { inbound, text: 'Tell me more' })).toMatchObject({ duplicate: true });
    expect(replies).toHaveLength(before);
  });

  test('a tap from someone else, or with another promotion\'s payload, changes nothing', async () => {
    const ghada = custs[5];
    const cm = rows[String(ghada._id)];
    // another phone number tapping this message
    let out = await tap(ghada, cm, 'opt_in', 0, { from: '966500009999', text: 'Yes, send me offers' });
    expect(out).toMatchObject({ handled: false, outcome: 'phone_mismatch' });
    // a payload that names another promotion
    const other = (await consentPromotion(A)).promotion;
    out = await tap(ghada, cm, 'opt_in', 0, { promotionId: String(other._id), text: 'Yes, send me offers' });
    expect(out).toMatchObject({ handled: false, outcome: 'promotion_mismatch' });
    // a message id we never sent
    out = await handlePromoConsentTap({ from: digits(ghada), signature: 'valid', deps: tapDeps, message: { id: wid(), type: 'button', timestamp: TAP_TS, context: { id: 'wamid.NEVER_SENT' }, button: { payload: `promo:${new (require('mongoose').Types.ObjectId)()}:opt_in:0`, text: 'Yes' } } });
    expect(out.handled).toBe(false);
    expect(await Customer.findById(ghada._id).lean()).toMatchObject({ marketingConsent: false, optedOut: false });
    expect(await eventsOf(ghada)).toHaveLength(0);
  });

  test('the SAME phone number as a customer of two tenants: the tap affects only the tenant whose message was tapped', async () => {
    const shared = fx.nextPhone();
    const inA = await cust(A, { firstname: 'SharedA', phone: shared });
    const inB = await cust(B, { firstname: 'SharedB', phone: shared });
    const sentA = await http.send(A, promo, [inA]);
    expect(sentA.body.sentCount).toBe(1);
    const cm = await cmOf(promo, inA);
    expect(String(cm.workspaceId)).toBe(String(A.workspaceId));
    const out = await tap(inA, cm, 'opt_in', 0, { text: 'Yes, send me offers' });
    expect(out).toMatchObject({ handled: true, outcome: 'opted_in', workspaceId: String(A.workspaceId), customerId: String(inA._id) });
    expect(await Customer.findById(inA._id).lean()).toMatchObject({ marketingConsent: true });
    expect(await Customer.findById(inB._id).lean()).toMatchObject({ marketingConsent: false });
    expect(await eventsOf(inB)).toHaveLength(0);
    expect(replies.at(-1).workspaceId).toBe(String(A.workspaceId));
  });

  test('the campaign report: opt-ins, opt-outs, interested and other taps from the consent log and the taps, rates over delivered messages', async () => {
    // fresh promotion + customers so the numbers are exact
    const { promotion } = await approvedPromotion(A);
    const six = [];
    for (const n of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) six.push(await cust(A, { firstname: n }));
    calls.length = 0;
    expect((await http.send(A, promotion, six)).body.sentCount).toBe(6);
    const mine = {};
    for (const c of six) mine[String(c._id)] = await cmOf(promotion, c);
    await CampaignMessage.updateMany({ promotion: promotion._id }, { $set: { status: 'delivered' } });
    // nothing tapped yet
    let res = await http.get(A, `/api/promotions/${promotion._id}/report`);
    expect(res.body.consent).toEqual({ optIns: 0, optOuts: 0, interested: 0, otherTaps: 0, optInRate: 0, optOutRate: 0 });
    expect(res.body).toMatchObject({ messagesSent: 6, messagesDelivered: 6 });

    const [r1, r2, r3, r4, r5, r6] = six;
    await tap(r1, mine[String(r1._id)], 'opt_in', 0, { text: 'Yes' });
    await tap(r2, mine[String(r2._id)], 'opt_in', 0, { text: 'Yes' });
    await tap(r2, mine[String(r2._id)], 'opt_in', 0, { text: 'Yes' }); // taps again later (a second event of the same person)
    await tap(r3, mine[String(r3._id)], 'opt_out', 1, { text: 'No thanks' });
    await tap(r1, mine[String(r1._id)], 'opt_out', 1, { text: 'No thanks' }); // opted in, then out: counts in both
    await handlePromoConsentTap({ from: digits(r4), signature: 'valid', deps: tapDeps, message: { id: wid(), type: 'button', timestamp: TAP_TS, context: { id: mine[String(r4._id)].wamid }, button: { payload: `promo:${promotion._id}:end_flow:2`, text: 'None' } } }); // a button that does nothing
    await CampaignMessage.updateOne({ _id: mine[String(r5._id)]._id }, { $set: { respondedAt: new Date(), clickedButtonPosition: 0 } }); // a legacy msgnode_ tap
    void r6;
    res = await http.get(A, `/api/promotions/${promotion._id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.consent).toEqual({ optIns: 2, optOuts: 2, interested: 0, otherTaps: 2, optInRate: 33.3, optOutRate: 33.3 });
    // the same report seen by another customer: not theirs
    const B404 = await http.get(B, `/api/promotions/${promotion._id}/report`);
    expect(B404.status).toBe(404);
    // a promotion that is not a consent request and has no consent buttons has no consent block at all
    const plain = await ops.createPromotion({ workspaceId: A.workspaceId, name: 'Plain', scope: 'products', customerType: 'cash', type: 'store_wide' });
    res = await http.get(A, `/api/promotions/${plain._id}/report`);
    expect(res.body.consent).toBeUndefined();
    expect(Object.keys(res.body)).toEqual(['promotionId', 'name', 'messagesSent', 'messagesDelivered', 'messagesRead', 'messagesFailed', 'clicked', 'ordersCreated', 'revenue', 'pointsIssued', 'conversionRate']);
  });

  test('the report of the main world counts the interested tap and uses delivered as the base', async () => {
    const res = await http.get(A, `/api/promotions/${promo._id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.consent.interested).toBe(1); // Faris
    expect(res.body.consent.optIns).toBeGreaterThanOrEqual(3); // Aya, Bader (twice), Eman (START), SharedA
    expect(res.body.consent.optOuts).toBeGreaterThanOrEqual(2); // Bader, Eman
    expect(res.body.consent.optInRate).toBe(+((res.body.consent.optIns / res.body.messagesDelivered) * 100).toFixed(1));
  });

  test('the consent log (JSON): newest first, every evidence field, paging and the status / promotion filters', async () => {
    let res = await http.get(A, '/api/customers/consent-log?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(8);
    const times = res.body.events.map((e) => e.recordedAtUtc);
    expect([...times].sort().reverse()).toEqual(times);
    const aya = res.body.events.find((e) => e.customerName === 'Aya Test' && e.type === 'consent_given');
    expect(aya).toMatchObject({
      phone: custs[0].phone, method: 'whatsapp_button', promotionName: promo.name, messageText: BODY.replace('{{1}}', 'Aya'),
      buttonLabel: 'Yes, send me offers', buttonAction: 'opt_in', inboundWamid: expect.stringMatching(/^wamid\.IN_/), signature: 'valid',
      eventTimeUtc: '2026-10-26T09:30:00.000Z',
    });
    expect(aya.sourceWamid).toBe(rows[String(custs[0]._id)].wamid);
    expect(aya.promotionId).toBe(String(promo._id));
    expect(aya.source).toMatch(/Promotion/);

    const withdrawn = await http.get(A, '/api/customers/consent-log?status=opted_out&limit=200');
    expect(withdrawn.body.events.length).toBeGreaterThanOrEqual(2);
    expect(withdrawn.body.events.every((e) => e.type === 'consent_withdrawn')).toBe(true);
    const given = await http.get(A, '/api/customers/consent-log?status=opted_in&limit=200');
    expect(given.body.events.every((e) => ['consent_given', 'consent_reinstated'].includes(e.type))).toBe(true);
    const byPromo = await http.get(A, `/api/customers/consent-log?promotionId=${promo._id}&limit=200`);
    expect(byPromo.body.events.length).toBeGreaterThan(0);
    expect(byPromo.body.events.every((e) => e.promotionId === String(promo._id))).toBe(true);
    // paging
    const page1 = await http.get(A, '/api/customers/consent-log?limit=3&page=1');
    const page2 = await http.get(A, '/api/customers/consent-log?limit=3&page=2');
    expect(page1.body).toMatchObject({ limit: 3, page: 1 });
    expect(page1.body.events).toHaveLength(3);
    expect(page2.body.events.map((e) => e.id)).not.toEqual(expect.arrayContaining([page1.body.events[0].id]));
    expect(page1.body.pages).toBe(Math.ceil(page1.body.total / 3));
    // bad filters are 400, not an unfiltered dump
    expect((await http.get(A, '/api/customers/consent-log?status=everything')).status).toBe(400);
    expect((await http.get(A, '/api/customers/consent-log?promotionId=zzz')).status).toBe(400);
    expect((await request(app).get('/api/customers/consent-log')).status).toBe(401);
  });

  test('the consent log (CSV): UTF-8 BOM, the columns, formula injection neutralised', async () => {
    const res = await request(app).get('/api/customers/consent-log.csv').set(A.auth).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', (d) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="consent-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    const raw = res.body;
    expect([raw[0], raw[1], raw[2]]).toEqual([0xEF, 0xBB, 0xBF]); // UTF-8 BOM
    const text = raw.toString('utf8').slice(1);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('eventTimeUtc,customerName,phone,type,method,source,promotionId,promotionName,messageText,buttonLabel,buttonAction,sourceWamid,inboundWamid,signature');
    expect(lines.length).toBeGreaterThan(8);
    expect(text).toContain(`${custs[0].phone},consent_given,whatsapp_button`);
    // the hostile name starts with "=": that customer has not tapped yet, so make them opt in and look again
    const dina = custs[2];
    await tap(dina, rows[String(dina._id)], 'opt_in', 0, { text: 'Yes, send me offers' });
    const res2 = await request(app).get('/api/customers/consent-log.csv?status=opted_in').set(A.auth);
    const row = res2.text.replace(/^\u{FEFF}/u, '').split('\r\n').find((l) => l.includes('HYPERLINK'));
    expect(row).toBeTruthy();
    expect(row.split(',')[0]).toMatch(/^2026-/);
    expect(res2.text).toContain(`"'=HYPERLINK(""http://evil"",""x"") Test"`);
    // the message text itself holds the hostile name too: also defused (the cell starts with "Hi", so only quoting applies)
    expect(res2.text).not.toMatch(/,=HYPERLINK/);
    expect((await request(app).get('/api/customers/consent-log.csv?status=bogus').set(A.auth)).status).toBe(400);
    expect((await request(app).get('/api/customers/consent-log.csv')).status).toBe(401);
  });

  test('one customer\'s consent history, newest first, with the evidence', async () => {
    const bader = custs[1];
    const res = await http.get(A, `/api/customers/${bader._id}/consent-events`);
    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.type)).toEqual(['consent_given', 'consent_withdrawn', 'consent_given']);
    expect(res.body[0]).toMatchObject({ buttonAction: 'opt_in', customerName: 'Bader Test', promotionName: promo.name });
    expect((await http.get(A, `/api/customers/${new (require('mongoose').Types.ObjectId)()}/consent-events`)).status).toBe(404);
    expect((await http.get(A, '/api/customers/not-an-id/consent-events')).status).toBe(404);
  });

  test('ISOLATION: the other customer can never read or change this customer\'s consent data through the routes', async () => {
    const [aya, bader] = custs;
    // B has its own people and its own consent events
    const bCust = await cust(B, { firstname: 'Bella', marketingConsent: true });
    const bp = await approvedPromotion(B);
    const bTarget = await cust(B, { firstname: 'Bilal' });
    calls.length = 0;
    expect((await http.send(B, bp.promotion, [bTarget])).body.sentCount).toBe(1);
    await tap(bTarget, await cmOf(bp.promotion, bTarget), 'opt_in', 0, { text: 'Yes, send me offers' });

    // the log: only B's events, in JSON and CSV
    let res = await http.get(B, '/api/customers/consent-log?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.events.map((e) => e.customerName)).toEqual(['Bilal Test']);
    const csv = await http.get(B, '/api/customers/consent-log.csv');
    expect(csv.text).toContain('Bilal Test');
    for (const secret of [aya.phone, bader.phone, 'Aya Test', 'Bader Test', String(promo._id)]) {
      expect(csv.text).not.toContain(secret);
      expect(JSON.stringify(res.body)).not.toContain(secret);
    }
    // asking for A's promotion's log gives nothing, not A's events
    res = await http.get(B, `/api/customers/consent-log?promotionId=${promo._id}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.events).toEqual([]);
    expect((await http.get(B, `/api/customers/consent-log.csv?promotionId=${promo._id}`)).text.replace(/^\u{FEFF}/u, '').trim().split('\r\n')).toHaveLength(1); // header only
    // A's customers' history and records
    expect((await http.get(B, `/api/customers/${aya._id}/consent-events`)).status).toBe(404);
    expect((await http.get(B, `/api/customers/${aya._id}`)).status).toBe(404);
    // changing A's consent through B's session is impossible
    const before = await Customer.findById(aya._id).lean();
    const eventsBefore = await ConsentEvent.countDocuments({ customerId: aya._id });
    expect((await request(app).post(`/api/customers/${aya._id}/consent`).set(B.auth)).status).toBe(404);
    expect((await request(app).put(`/api/customers/${aya._id}`).set(B.auth).send({ marketingConsent: false, optedOut: true, firstname: 'Hijacked' })).status).toBe(404);
    expect(await Customer.findById(aya._id).lean()).toEqual(before);
    expect(await ConsentEvent.countDocuments({ customerId: aya._id })).toBe(eventsBefore);
    // and the consent fields cannot be written by A's own customer edit either (they go through the consent helpers only)
    await request(app).put(`/api/customers/${aya._id}`).set(A.auth).send({ marketingConsent: false, optedOut: true, firstname: 'Aya' });
    expect(await Customer.findById(aya._id).lean()).toMatchObject({ marketingConsent: true, optedOut: false });
    // B cannot send, edit, submit or refresh A's promotion / message, or read its report
    expect((await http.send(B, promo, [bCust])).status).toBe(404);
    expect((await request(app).put(`/api/promotions/${promo._id}`).set(B.auth).send({ name: 'Hijacked' })).status).toBe(404);
    expect((await request(app).put(`/api/message-nodes/${node._id}`).set(B.auth).send({ bodyText: 'Hijacked text, stop any time.' })).status).toBe(404);
    expect((await request(app).post(`/api/message-nodes/${node._id}/submit-template`).set(B.auth)).status).toBe(400);
    expect((await request(app).post(`/api/message-nodes/${node._id}/refresh-status`).set(B.auth)).status).toBe(400);
    expect((await request(app).get(`/api/message-nodes/${node._id}`).set(B.auth)).status).toBe(404);
    expect((await request(app).post(`/api/promotions/${promo._id}/dismiss-send-request`).set(B.auth)).status).toBe(404);
    expect((await request(app).post(`/api/promotions/${promo._id}/test-send`).set(B.auth).send({ phone: '966500000042' })).status).toBe(404);
    expect(templatePosts().filter((c) => c.body.name === node.templateName)).toHaveLength(0);
    expect((await MessageNode.findById(node._id).lean()).bodyText).toBe(BODY);
    expect((await Promotion.findById(promo._id).lean()).name).toBe(promo.name);
    // B's customer list never contains A's people, with any consent filter
    for (const f of ['', '?consent=opted_in', '?consent=opted_out', '?consent=not_responded']) {
      const list = await http.get(B, `/api/customers${f}${f ? '&' : '?'}limit=200`);
      const names = list.body.customers.map((x) => x.firstname);
      for (const a of ['Aya', 'Bader', 'Eman', 'Faris', 'Ghada']) expect(names).not.toContain(a);
    }
  });
});
