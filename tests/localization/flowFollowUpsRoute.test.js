// HTTP-level tests for the follow-up / tree routes of /api/localization/flows
// (routes/localization/flows.js). The REAL router and the REAL services run over in-memory models behind a
// stub auth middleware: what is verified is the whole path - tenant scoping from req.user only, body
// allow-lists, status codes, the { error, code, issues } shapes, the contract the hub codes against.
const express = require('express');
const request = require('supertest');
const { id, fakeModel } = require('./helpers/flowFakes');
const followUps = require('../../shared/localization/flowFollowUps');
const tree = require('../../shared/localization/flowTree');
const { createRouter } = require('../../routes/localization/flows');

const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const USER = id(900);
const PROMOTION = id(10);
const FLOW = id(1);
const E = id(100);
const F1 = id(101);

const send = (position, label, target) => ({ position, label, nextAction: { type: 'send_message', targetNodeId: target } });
const end = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });

function makeApp(user = { id: USER, workspaceId: WS, role: 'owner' }) {
  const deps = {
    Flow: fakeModel([{ _id: FLOW, workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: PROMOTION, createdAt: new Date() }]),
    Promotion: fakeModel([{ _id: PROMOTION, workspaceId: WS, name: 'Summer', entryNodeId: E }, { _id: id(11), workspaceId: OTHER_WS, name: 'Theirs' }]),
    MessageNode: fakeModel([
      { _id: E, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: true, bodyText: 'Hi {{1}}', templateStatus: 'approved', buttons: [send(0, 'More', F1)] },
      { _id: F1, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: false, bodyText: 'Great {{1}}', buttons: [end(0, 'Done')] },
      { _id: id(102), workspaceId: OTHER_WS, ownerType: 'promotion', ownerId: id(11), isEntryNode: false, bodyText: 'secret', buttons: [] },
    ]),
    LocalizedTemplate: fakeModel([]),
    LocalizedFlowNode: fakeModel([], { uniqueKeys: ['workspaceId', 'messageNodeId', 'language'] }),
    getReviewerName: jest.fn(async () => 'Layla'),
    now: () => new Date('2026-10-12T10:00:00Z'),
    log: jest.fn(),
  };
  const bound = (service) => Object.fromEntries(Object.entries(service).filter(([, v]) => typeof v === 'function').map(([k, fn]) => [k, (args) => fn(args, deps)]));
  const router = createRouter({ flowMessages: {}, followUps: bound(followUps), tree: bound(tree) });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use('/api/localization/flows', router);
  return { app, deps };
}
const BASE = '/api/localization/flows';
const body = { body: 'اختيار رائع يا {name}!', buttons: [{ position: 0, text: 'تم' }] };

describe('GET /promotion-trees', () => {
  const P2 = id(20);
  const P2_E = id(300);
  const P2_F = id(301);
  function withPromotion(user) {
    const made = makeApp(user);
    made.deps.Promotion.docs.push({ _id: P2, workspaceId: WS, name: 'Ramadan offer', status: 'active', entryNodeId: P2_E, createdAt: new Date('2026-10-05') });
    made.deps.MessageNode.docs.push(
      { _id: P2_E, workspaceId: WS, ownerType: 'promotion', ownerId: P2, isEntryNode: true, bodyText: 'Hi {{1}}', templateStatus: 'pending', buttons: [send(0, 'More', P2_F)] },
      { _id: P2_F, workspaceId: WS, ownerType: 'promotion', ownerId: P2, isEntryNode: false, bodyText: 'Great {{1}}', buttons: [end(0, 'Done')] },
    );
    return made;
  }
  test('returns the promotions of the caller\'s workspace that have their own message and no flow; the flow\'s promotion is not repeated', async () => {
    const { app } = withPromotion();
    const res = await request(app).get(`${BASE}/promotion-trees`);
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(false);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ ownerType: 'promotion', promotionId: P2, promotionName: 'Ramadan offer', messageSource: 'promotion', entryTemplateStatus: 'pending' });
    expect(res.body.items[0].nodes.map((n) => n.messageNodeId)).toEqual([P2_E, P2_F]);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|Theirs|Summer/);
    expect((await request(app).get(`${BASE}/tree`)).body.items.map((i) => i.promotionId)).toEqual([PROMOTION]); // /tree is unchanged
  });
  test('the follow-up message of such a promotion resolves through the existing follow-up route (deep link target)', async () => {
    const { app } = withPromotion();
    const res = await request(app).get(`${BASE}/followups/${P2_F}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ messageNodeId: P2_F, ownerType: 'promotion', ownerId: P2 });
  });
  test('the other workspace sees nothing; no user = 403; other verbs are not routed', async () => {
    expect((await request(withPromotion({ id: USER, workspaceId: OTHER_WS, role: 'owner' }).app).get(`${BASE}/promotion-trees`)).body).toEqual({ items: [], truncated: false });
    expect((await request(makeApp(null).app).get(`${BASE}/promotion-trees`)).status).toBe(403);
    expect((await request(withPromotion().app).post(`${BASE}/promotion-trees`).send({})).status).toBe(404);
  });
  test('an unexpected failure is a generic 500 with no details', async () => {
    const router = createRouter({ flowMessages: {}, followUps: {}, tree: { buildPromotionTrees: async () => { throw new Error('secret db detail'); } } });
    const app = express();
    app.use((req, res, next) => { req.user = { id: USER, workspaceId: WS }; next(); });
    app.use('/', router);
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/promotion-trees');
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('GET /tree and GET /owners/:ownerType/:ownerId/tree', () => {
  test('returns the tree rows of the caller\'s workspace only', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`${BASE}/tree`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ flowId: FLOW, messageSource: 'promotion', promotionName: 'Summer' });
    expect(res.body.items[0].nodes.map((n) => n.messageNodeId)).toEqual([E, F1]);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
  test('the other workspace sees nothing of it', async () => {
    const { app } = makeApp({ id: USER, workspaceId: OTHER_WS, role: 'owner' });
    expect((await request(app).get(`${BASE}/tree`)).body.items).toEqual([]);
  });
  test('owner tree: promotion and flow, 404 for a foreign owner, 400 for bad input', async () => {
    const { app } = makeApp();
    const promotion = await request(app).get(`${BASE}/owners/promotion/${PROMOTION}/tree`);
    expect(promotion.status).toBe(200);
    expect(promotion.body).toMatchObject({ ownerType: 'promotion', ownerId: PROMOTION, messageSource: 'promotion' });
    expect(promotion.body.nodes).toHaveLength(2);
    expect((await request(app).get(`${BASE}/owners/flow/${FLOW}/tree`)).body.nodes).toHaveLength(2);
    const foreign = await request(app).get(`${BASE}/owners/promotion/${id(11)}/tree`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'Flow or promotion not found', code: 'NODE_NOT_FOUND' });
    expect((await request(app).get(`${BASE}/owners/promotion/nope/tree`)).status).toBe(400);
    expect((await request(app).get(`${BASE}/owners/campaign/${PROMOTION}/tree`)).status).toBe(400);
  });
  test('no user on the request: 403, nothing leaks', async () => {
    const { app } = makeApp(null);
    expect((await request(app).get(`${BASE}/tree`)).status).toBe(403);
  });
});

describe('GET /followups/:nodeId', () => {
  test('no Arabic yet: variant null with the English side for the editor', async () => {
    const { app } = makeApp();
    const res = await request(app).get(`${BASE}/followups/${F1}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      messageNodeId: F1, ownerType: 'promotion', ownerId: PROMOTION, variant: null, issues: [], warnings: [], stale: false, sendable: false,
      english: { bodyText: 'Great {{1}}', bodyFields: 'Great {name}', slotFields: ['name', 'item', 'price', 'promo_name'], buttons: [{ position: 0, label: 'Done' }] },
    });
  });
  test('404 for a foreign node, 422 for an entry node, 400 for a bad id', async () => {
    const { app } = makeApp();
    expect((await request(app).get(`${BASE}/followups/${id(102)}`)).status).toBe(404);
    const entry = await request(app).get(`${BASE}/followups/${E}`);
    expect(entry.status).toBe(422);
    expect(entry.body.code).toBe('NODE_NOT_LOCALIZABLE');
    const bad = await request(app).get(`${BASE}/followups/not-an-id`);
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_ID');
  });
});

describe('PUT /followups/:nodeId/variants/ar', () => {
  test('saves a draft, answers the view, scopes by the token\'s workspace and user', async () => {
    const { app, deps } = makeApp();
    const res = await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send({ ...body, workspaceId: OTHER_WS, createdBy: id(5), reviewStatus: 'reviewed', contentVersion: 99 });
    expect(res.status).toBe(200);
    expect(res.body.variant).toMatchObject({ language: 'ar', body: body.body, buttons: body.buttons, contentVersion: 1, reviewStatus: 'draft', source: 'merchant', sendable: false, stale: false });
    expect(res.body.issues).toEqual([]);
    expect(deps.LocalizedFlowNode.docs).toHaveLength(1);
    expect(deps.LocalizedFlowNode.docs[0]).toMatchObject({ workspaceId: WS, createdBy: USER, reviewStatus: 'draft', contentVersion: 1 });
  });
  test('an incomplete draft is accepted (200) and its problems come back as issues', async () => {
    const { app } = makeApp();
    const res = await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send({ body: '', buttons: [{ position: 0, text: '' }] });
    expect(res.status).toBe(200);
    expect(res.body.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['body_required', 'button_label_empty']));
  });
  test('structurally broken input is a 400 INVALID_INPUT; a foreign node 404; an entry node 422', async () => {
    const { app, deps } = makeApp();
    const broken = await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send({ body: 42 });
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ error: 'body must be a string', code: 'INVALID_INPUT' });
    expect((await request(app).put(`${BASE}/followups/${id(102)}/variants/ar`).send(body)).status).toBe(404);
    expect((await request(app).put(`${BASE}/followups/${E}/variants/ar`).send(body)).status).toBe(422);
    expect(deps.LocalizedFlowNode.docs).toHaveLength(0);
  });
  test('only the ar variant exists as a route', async () => {
    const { app } = makeApp();
    expect((await request(app).put(`${BASE}/followups/${F1}/variants/en`).send(body)).status).toBe(404);
    expect((await request(app).put(`${BASE}/followups/${F1}/variants/bilingual`).send(body)).status).toBe(404);
  });
  test('the other workspace cannot write to this node', async () => {
    const { app, deps } = makeApp({ id: USER, workspaceId: OTHER_WS, role: 'owner' });
    expect((await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send(body)).status).toBe(404);
    expect(deps.LocalizedFlowNode.docs).toHaveLength(0);
  });
});

describe('POST /followups/:nodeId/variants/ar/review', () => {
  const save = (app) => request(app).put(`${BASE}/followups/${F1}/variants/ar`).send(body);
  const review = (app, payload) => request(app).post(`${BASE}/followups/${F1}/variants/ar/review`).send(payload);

  test('mark reviewed (tied to the contentVersion read) and back to draft', async () => {
    const { app } = makeApp();
    const saved = await save(app);
    const done = await review(app, { status: 'reviewed', contentVersion: saved.body.variant.contentVersion });
    expect(done.status).toBe(200);
    expect(done.body.variant).toMatchObject({ reviewStatus: 'reviewed', reviewedBy: 'Layla', sendable: true });
    expect(done.body.variant.reviewedAt).toBe('2026-10-12T10:00:00.000Z');
    const back = await review(app, { status: 'draft', contentVersion: 1 });
    expect(back.body.variant).toMatchObject({ reviewStatus: 'draft', reviewedBy: null, sendable: false });
  });
  test('a text change after the read is a 409; issues block the review with VARIANT_INVALID + issues', async () => {
    const { app } = makeApp();
    await save(app);
    await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send({ ...body, body: 'نص جديد {name}' });
    const stale = await review(app, { status: 'reviewed', contentVersion: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONFLICT');
    await request(app).put(`${BASE}/followups/${F1}/variants/ar`).send({ body: 'يا {points}', buttons: [{ position: 0, text: 'تم' }] });
    const invalid = await review(app, { status: 'reviewed', contentVersion: 3 });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ code: 'VARIANT_INVALID', issues: [{ code: 'followup_unknown_field', field: 'body', detail: { field: 'points' } }] });
  });
  test('English text edited after saving: reviewing is a 409 STALE_SOURCE until saved again', async () => {
    const { app, deps } = makeApp();
    await save(app);
    deps.MessageNode.docs.find((n) => n._id === F1).bodyText = 'Changed offer {{1}}';
    const res = await review(app, { status: 'reviewed', contentVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STALE_SOURCE');
    const view = await request(app).get(`${BASE}/followups/${F1}`);
    expect(view.body).toMatchObject({ stale: true, sendable: false });
  });
  test('bad payloads: 400; no Arabic row: 404; body fields outside the allow-list are ignored', async () => {
    const { app } = makeApp();
    expect((await review(app, { status: 'reviewed', contentVersion: 1 })).status).toBe(404);
    await save(app);
    expect((await review(app, { status: 'approved', contentVersion: 1 })).status).toBe(400);
    expect((await review(app, { status: 'reviewed' })).status).toBe(400);
    expect((await review(app, { status: 'reviewed', contentVersion: '1' })).status).toBe(400);
    const sneaky = await review(app, { status: 'reviewed', contentVersion: 1, workspaceId: OTHER_WS, reviewedBy: 'Mallory' });
    expect(sneaky.status).toBe(200);
    expect(sneaky.body.variant.reviewedBy).toBe('Layla');
  });
});

describe('the router surface', () => {
  test('no delete route, and unknown verbs are 404', async () => {
    const { app } = makeApp();
    expect((await request(app).delete(`${BASE}/followups/${F1}/variants/ar`)).status).toBe(404);
    expect((await request(app).delete(`${BASE}/followups/${F1}`)).status).toBe(404);
    expect((await request(app).post(`${BASE}/tree`).send({})).status).toBe(404);
    expect((await request(app).put(`${BASE}/followups/${F1}`).send(body)).status).toBe(404);
  });
  test('a failing service answers a 500 without details', async () => {
    const router = createRouter({ flowMessages: {}, followUps: {}, tree: { buildFlowTrees: async () => { throw new Error('secret db detail'); } } });
    const app = express();
    app.use((req, res, next) => { req.user = { id: USER, workspaceId: WS }; next(); });
    app.use(router);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get('/tree');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong' });
  });
});
