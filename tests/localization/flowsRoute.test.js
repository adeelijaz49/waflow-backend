// Route tests for /api/localization/flows (routes/localization/flows.js). The REAL router and the
// REAL service run over in-memory models (jest.mock of the Mongoose models) and a stubbed template
// service, behind a stub auth middleware, so what is verified is the whole HTTP path: tenant
// scoping from req.user only, id validation, error shapes, idempotent status codes. No database,
// no Meta, no WhatsApp.
const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');

const id = (n) => String(n).padStart(24, '0');
const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const USER = id(900);

// ── in-memory models (names start with "mock" so jest.mock factories may use them) ──
const mockStore = { flows: [], promotions: [], nodes: [], templates: [] };

function mockMatches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const actual = doc[key];
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.map(String).includes(String(actual));
    if (cond && typeof cond === 'object' && '$ne' in cond) return String(actual) !== String(cond.$ne);
    return actual !== undefined && String(actual) === String(cond);
  });
}

function mockChain(read) {
  let limit = Infinity;
  const q = { select: () => q, populate: () => q, sort: () => q, limit: (n) => { limit = n; return q; }, lean: async () => read(limit) };
  return q;
}

function mockCollection(name) {
  return {
    find: jest.fn((filter) => mockChain((limit) => structuredClone(mockStore[name].filter((d) => mockMatches(d, filter)).slice(0, limit)))),
    findOne: jest.fn((filter) => mockChain(() => { const hit = mockStore[name].find((d) => mockMatches(d, filter)); return hit ? structuredClone(hit) : null; })),
    findOneAndUpdate: jest.fn((filter, update) => mockChain(() => {
      const hit = mockStore[name].find((d) => mockMatches(d, filter));
      if (!hit) return null;
      Object.assign(hit, update.$set);
      return structuredClone(hit);
    })),
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
  };
}

function mockView(doc) {
  return { id: String(doc._id), key: doc.key, name: doc.name, linkedMessageNodeId: String(doc.linkedMessageNodeId), archived: !!doc.archived, variants: (doc.variants || []).map((v) => ({ language: v.language, body: v.body })) };
}

async function mockCreateTemplate(args) {
  const doc = {
    _id: id(500 + mockStore.templates.length), workspaceId: args.workspaceId, key: args.key, name: args.name,
    linkedMessageNodeId: args.linkedMessageNodeId, archived: false, createdAt: new Date(), variants: args.variants.map((v) => ({ ...v, metaStatus: 'NOT_CREATED' })),
  };
  mockStore.templates.push(doc);
  return mockView(doc);
}

jest.mock('../../models/Flow', () => mockCollection('flows'));
jest.mock('../../models/Promotion', () => mockCollection('promotions'));
jest.mock('../../models/MessageNode', () => mockCollection('nodes'));
jest.mock('../../models/LocalizedTemplate', () => mockCollection('templates'));
// virtual: the real template service belongs to another slice; it is never loaded here
jest.mock('../../shared/localization/templates', () => ({
  createTemplate: jest.fn((args) => mockCreateTemplate(args)),
  toTemplateView: jest.fn((doc) => mockView(doc)),
}), { virtual: true });

const Flow = require('../../models/Flow');
const Promotion = require('../../models/Promotion');
const MessageNode = require('../../models/MessageNode');
const LocalizedTemplate = require('../../models/LocalizedTemplate');
const templatesService = require('../../shared/localization/templates');
const router = require('../../routes/localization/flows');
// measured right after the router was required, before any test (or beforeEach) can reset the mocks
const modelCallsAtLoad = [Flow, Promotion, MessageNode, LocalizedTemplate].reduce((n, m) => n + m.find.mock.calls.length + m.findOne.mock.calls.length, 0);

const button = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });
const NODE = id(100);

function seed(over = {}) {
  mockStore.flows = over.flows || [
    { _id: id(1), workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: id(10), createdAt: new Date('2026-10-01') },
    { _id: id(2), workspaceId: OTHER_WS, name: 'Theirs', triggerType: 'inactive_customer', status: 'active', promotionId: id(11), createdAt: new Date('2026-10-02') },
  ];
  mockStore.promotions = over.promotions || [
    { _id: id(10), workspaceId: WS, name: 'Summer Sale', entryNodeId: NODE },
    { _id: id(11), workspaceId: OTHER_WS, name: 'Their Sale', entryNodeId: id(110) },
  ];
  mockStore.nodes = over.nodes || [
    { _id: NODE, workspaceId: WS, ownerType: 'promotion', ownerId: id(10), isEntryNode: true, bodyText: 'Hi {{1}}! Try {{2}}', templateStatus: 'approved', templateName: 'waflow_flow_abc', buttons: [button(0, 'Shop Now')] },
    { _id: id(110), workspaceId: OTHER_WS, ownerType: 'promotion', ownerId: id(11), isEntryNode: true, bodyText: 'Their secret {{1}}', templateStatus: 'approved', buttons: [button(0, 'Go')] },
    { _id: id(101), workspaceId: WS, ownerType: 'promotion', ownerId: id(10), isEntryNode: false, bodyText: 'Follow-up', buttons: [] },
    { _id: id(102), workspaceId: WS, ownerType: 'promotion', ownerId: id(10), isEntryNode: true, bodyText: 'Broken {{9}}', templateStatus: 'not_created', buttons: [] },
  ];
  mockStore.templates = over.templates || [];
}

function appFor(user) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use('/api/localization/flows', router);
  return app;
}
const USER_CTX = { id: USER, workspaceId: WS, role: 'owner' };
const app = appFor(USER_CTX);
const BASE = '/api/localization/flows';

beforeEach(() => {
  seed();
  jest.clearAllMocks();
  for (const model of [Flow, Promotion, MessageNode, LocalizedTemplate]) {
    model.find.mockClear();
    model.findOne.mockClear();
  }
});

describe('GET /messages', () => {
  test('returns the workspace\'s flows with their entry message and language matrix', async () => {
    const res = await request(app).get(`${BASE}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{
        flowId: id(1), flowName: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: id(10),
        nodes: [{
          messageNodeId: NODE, bodyText: 'Hi {{1}}! Try {{2}}', buttons: [{ position: 0, label: 'Shop Now' }],
          templateStatus: 'approved', localizedTemplateId: null, variantStatus: [{ language: 'en', metaStatus: 'APPROVED', reviewStatus: 'draft' }],
        }],
      }],
    });
  });

  test('another workspace\'s data never appears, and nothing identifying it is in the response', async () => {
    const res = await request(app).get(`${BASE}/messages`);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('Theirs');
    expect(text).not.toContain('Their secret');
    expect(text).not.toContain(OTHER_WS);
  });

  test('the workspace comes ONLY from the token: query, header and body attempts change nothing', async () => {
    const res = await request(app).get(`${BASE}/messages`).query({ workspaceId: OTHER_WS, workspace: OTHER_WS }).set('x-workspace-id', OTHER_WS).send({ workspaceId: OTHER_WS });
    expect(res.status).toBe(200);
    expect(res.body.items.map((r) => r.flowName)).toEqual(['Win-back']);
    for (const [filter] of Flow.find.mock.calls) expect(filter).toEqual({ workspaceId: WS });
    for (const [filter] of Promotion.find.mock.calls) expect(filter.workspaceId).toBe(WS);
    for (const [filter] of LocalizedTemplate.find.mock.calls) expect(filter.workspaceId).toBe(WS);
  });

  test('a different signed-in workspace sees only its own flows', async () => {
    const res = await request(appFor({ id: USER, workspaceId: OTHER_WS, role: 'owner' })).get(`${BASE}/messages`);
    expect(res.body.items.map((r) => r.flowName)).toEqual(['Theirs']);
  });

  test('a workspace with no flows gets an empty list', async () => {
    seed({ flows: [] });
    const res = await request(app).get(`${BASE}/messages`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  test('without a signed-in user: 403 FORBIDDEN, and no query ran', async () => {
    const res = await request(appFor(null)).get(`${BASE}/messages`);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: expect.any(String), code: 'FORBIDDEN' });
    expect(Flow.find).not.toHaveBeenCalled();
  });

  test('an unexpected failure is a generic 500: no internal message, no stack', async () => {
    Flow.find.mockImplementationOnce(() => { throw new Error('connect ECONNREFUSED 10.0.0.5:27017 secret-host'); });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).get(`${BASE}/messages`);
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong' });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|secret-host|at .*\.js/);
  });
});

describe('POST /messages/:messageNodeId/localize', () => {
  const post = (nodeId, body = {}, a = app) => request(a).post(`${BASE}/messages/${nodeId}/localize`).send(body);

  test('creates the linked template (201) from the node, for the signed-in user and workspace', async () => {
    const res = await post(NODE);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Summer Sale', linkedMessageNodeId: NODE, key: `flow_message_${NODE}`, archived: false });
    expect(res.body.variants).toEqual([{ language: 'en', body: 'Hi {name}! Try {item}' }]);
    expect(templatesService.createTemplate).toHaveBeenCalledTimes(1);
    const args = templatesService.createTemplate.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: WS, userId: USER, useCase: 'custom', category: 'MARKETING', linkedMessageNodeId: NODE });
    expect(args.variants[0].buttons).toEqual([{ role: 'flow_button', text: 'Shop Now' }, { role: 'opt_out', text: 'Opt Out' }]);
  });

  test('is idempotent over HTTP: the second call is 200 with the same template and creates nothing', async () => {
    const first = await post(NODE);
    const second = await post(NODE);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(templatesService.createTemplate).toHaveBeenCalledTimes(1);
    expect(mockStore.templates).toHaveLength(1);
  });

  test('two simultaneous requests create ONE template', async () => {
    const [a, b] = await Promise.all([post(NODE), post(NODE)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(mockStore.templates).toHaveLength(1);
  });

  test('upper-case hex ids are accepted and canonicalised (the template key only allows [a-z0-9_])', async () => {
    mockStore.nodes.push({ _id: 'abcdefabcdefabcdefabcdef', workspaceId: WS, ownerType: 'promotion', ownerId: id(10), isEntryNode: true, bodyText: 'Hi {{1}}', buttons: [] });
    const res = await post('ABCDEFABCDEFABCDEFABCDEF');
    expect(res.status).toBe(201);
    expect(templatesService.createTemplate.mock.calls[0][0].key).toBe('flow_message_abcdefabcdefabcdefabcdef');
  });

  test('request bodies cannot steer the creation: only the path id and the token are used', async () => {
    const res = await post(NODE, {
      workspaceId: OTHER_WS, userId: 'evil', name: 'Injected', key: 'evil_key', useCase: 'comeback', category: 'UTILITY',
      linkedMessageNodeId: id(110), variants: [{ language: 'ar', body: 'x' }], messageNodeId: id(110), $set: { archived: true },
    });
    expect(res.status).toBe(201);
    const args = templatesService.createTemplate.mock.calls[0][0];
    expect(args).toMatchObject({ workspaceId: WS, userId: USER, name: 'Summer Sale', key: `flow_message_${NODE}`, useCase: 'custom', category: 'MARKETING', linkedMessageNodeId: NODE });
    expect(args.variants.map((v) => v.language)).toEqual(['en']);
  });

  test.each([
    ['not-an-id'], ['123'], [id(5).slice(1)], [`${id(5)}0`], ['z'.repeat(24)], ['%7B%22%24ne%22%3Anull%7D'], ['%24ne'], ['..%2F..%2Fetc'], ['%00'], [encodeURIComponent('{"$gt":""}')],
  ])('node id %s is rejected before any lookup: 400 INVALID_ID', async (nodeId) => {
    const res = await post(nodeId);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: 'INVALID_ID' });
    expect(MessageNode.findOne).not.toHaveBeenCalled();
    expect(templatesService.createTemplate).not.toHaveBeenCalled();
  });

  test('a well-formed id that does not exist: 404 NODE_NOT_FOUND', async () => {
    const res = await post(id(999));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: expect.any(String), code: 'NODE_NOT_FOUND' });
  });

  test('another workspace\'s node looks exactly like a missing one (404), and nothing is created', async () => {
    const foreign = await post(id(110));
    const missing = await post(id(999));
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(templatesService.createTemplate).not.toHaveBeenCalled();
  });

  test('a follow-up message: 422 NODE_NOT_LOCALIZABLE', async () => {
    const res = await post(id(101));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: expect.any(String), code: 'NODE_NOT_LOCALIZABLE' });
  });

  test('a message with a placeholder the flow cannot fill: 422 NODE_NOT_LOCALIZABLE', async () => {
    const res = await post(id(102));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('NODE_NOT_LOCALIZABLE');
    expect(templatesService.createTemplate).not.toHaveBeenCalled();
  });

  test('without a signed-in user: 403 FORBIDDEN, and nothing is read', async () => {
    const res = await post(NODE, {}, appFor(null));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(MessageNode.findOne).not.toHaveBeenCalled();
  });

  test('errors from the template service keep their status and code (e.g. a validation failure)', async () => {
    templatesService.createTemplate.mockRejectedValueOnce(Object.assign(new Error('Some buttons have an unknown role'), { status: 400, code: 'VARIANT_INVALID' }));
    const res = await post(NODE);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Some buttons have an unknown role', code: 'VARIANT_INVALID' });
  });

  test('an unexpected failure is a generic 500', async () => {
    templatesService.createTemplate.mockRejectedValueOnce(new Error('E11000 duplicate key index: workspaceId_1_key_1 dup key'));
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post(NODE);
    quiet.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong' });
  });

  test('the template is created for the right user even when the token has no user id', async () => {
    const res = await post(NODE, {}, appFor({ workspaceId: WS }));
    expect(res.status).toBe(201);
    expect(templatesService.createTemplate.mock.calls[0][0].userId).toBeUndefined();
  });
});

describe('the router surface', () => {
  test.each([
    ['put', '/messages'], ['post', '/messages'], ['delete', '/messages'], ['get', `/messages/${NODE}/localize`], ['put', `/messages/${NODE}/localize`],
    ['delete', `/messages/${NODE}/localize`], ['get', '/anything-else'], ['post', `/messages/${NODE}`],
  ])('%s %s is not routed (404)', async (method, url) => {
    const res = await request(app)[method](`${BASE}${url}`).send({});
    expect(res.status).toBe(404);
  });

  test('only the two documented routes exist', () => {
    const routes = router.stack.filter((layer) => layer.route).map((layer) => `${Object.keys(layer.route.methods).join(',')} ${layer.route.path}`);
    expect(routes.sort()).toEqual(['get /messages', 'post /messages/:messageNodeId/localize']);
  });

  test('loading the router touches no model', () => {
    expect(modelCallsAtLoad).toBe(0);
  });

  test('the flows router stays behind the per-merchant Arabic flag in the hub router', () => {
    const index = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'localization', 'index.js'), 'utf8');
    expect(index).toMatch(/router\.use\('\/flows',\s*requireArabicEnabled,\s*require\('\.\/flows'\)\)/);
  });

  test('the route file never deletes anything', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'routes', 'localization', 'flows.js'), 'utf8');
    expect(source.match(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|router\.delete/)).toBeNull();
  });
});
