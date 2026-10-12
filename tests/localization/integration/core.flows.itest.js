const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
const h = require('./helpers/_harness');
const Flow = require('../../../models/Flow');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const flowMessages = require('../../../shared/localization/flowMessages');

const button = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });

describe('B8 flows overlay on real MongoDB', () => {
  let ctx; let a; let b; let c;
  const A = {}; const B = {};
  beforeAll(async () => {
    ctx = await h.setup();
    a = ctx.api(ctx.A); b = ctx.api(ctx.B); c = ctx.api(ctx.C);
    const w = ctx.A.wsId;
    // flow-owned entry node
    A.flow = await Flow.create({ workspaceId: w, name: 'Win-back', triggerType: 'inactive_customer', status: 'active' });
    A.node = await MessageNode.create({ workspaceId: w, ownerType: 'flow', ownerId: A.flow._id, isEntryNode: true, bodyText: 'Hi {{1}}, we miss you!', buttons: [button(0, 'Shop now'), button(1, 'Not now')], templateStatus: 'approved', templateName: 'wf_existing_en' });
    await Flow.updateOne({ _id: A.flow._id }, { $set: { entryNodeId: A.node._id } });
    // follow-up (non entry) node of the same flow
    A.followUp = await MessageNode.create({ workspaceId: w, ownerType: 'flow', ownerId: A.flow._id, isEntryNode: false, bodyText: 'Thanks!', depth: 1 });
    // promotion-driven flow
    A.promo = await Promotion.create({ workspaceId: w, name: 'Eid sale' });
    A.pnode = await MessageNode.create({ workspaceId: w, ownerType: 'promotion', ownerId: A.promo._id, isEntryNode: true, bodyText: 'Hello {{1}}: {{2}} for {{3}}', buttons: [button(0, 'Buy')] });
    await Promotion.updateOne({ _id: A.promo._id }, { $set: { entryNodeId: A.pnode._id } });
    A.pflow = await Flow.create({ workspaceId: w, name: 'Promo flow', triggerType: 'points_balance_reminder', promotionId: A.promo._id });
    // node using a placeholder the flow does not fill
    A.badSlotFlow = await Flow.create({ workspaceId: w, name: 'Bad slot', triggerType: 'inactive_customer' });
    A.badNode = await MessageNode.create({ workspaceId: w, ownerType: 'flow', ownerId: A.badSlotFlow._id, isEntryNode: true, bodyText: 'Hi {{1}} {{5}}', buttons: [] });
    await Flow.updateOne({ _id: A.badSlotFlow._id }, { $set: { entryNodeId: A.badNode._id } });
    // a flow of A pointing at a node of B (foreign): listed, but with no nodes
    B.flow = await Flow.create({ workspaceId: ctx.B.wsId, name: 'B flow', triggerType: 'inactive_customer' });
    B.node = await MessageNode.create({ workspaceId: ctx.B.wsId, ownerType: 'flow', ownerId: B.flow._id, isEntryNode: true, bodyText: 'B body {{1}}', buttons: [] });
    await Flow.updateOne({ _id: B.flow._id }, { $set: { entryNodeId: B.node._id } });
    A.foreignFlow = await Flow.create({ workspaceId: w, name: 'Points to foreign', triggerType: 'inactive_customer', entryNodeId: B.node._id });
    // legacy node with no workspaceId whose owner flow is A's
    A.legacyFlow = await Flow.create({ workspaceId: w, name: 'Legacy', triggerType: 'inactive_customer' });
    A.legacyNode = await MessageNode.create({ ownerType: 'flow', ownerId: A.legacyFlow._id, isEntryNode: true, bodyText: 'Legacy hi {{1}}', buttons: [] });
    await Flow.updateOne({ _id: A.legacyFlow._id }, { $set: { entryNodeId: A.legacyNode._id } });
  });

  test('list: workspace-scoped joins of Flow, Promotion and MessageNode', async () => {
    const r = await a.get('/flows/messages');
    expect(r.status).toBe(200);
    const byName = new Map(r.body.items.map((i) => [i.flowName, i]));
    expect(byName.has('B flow')).toBe(false);
    expect(byName.get('Win-back').nodes[0]).toMatchObject({ messageNodeId: String(A.node._id), templateStatus: 'approved', localizedTemplateId: null });
    expect(byName.get('Win-back').nodes[0].variantStatus[0]).toMatchObject({ language: 'en', metaStatus: 'APPROVED' });
    expect(byName.get('Win-back').nodes[0].buttons).toHaveLength(2);
    expect(byName.get('Promo flow').nodes[0].messageNodeId).toBe(String(A.pnode._id)); // via Promotion.entryNodeId
    expect(byName.get('Points to foreign').nodes).toEqual([]); // foreign node never leaks
    expect(JSON.stringify(r.body)).not.toContain('B body');
    expect(byName.get('Legacy').nodes).toHaveLength(1);
    const rb = await b.get('/flows/messages');
    expect(rb.body.items.map((i) => i.flowName)).toEqual(['B flow']);
  });

  test('a promotion in another workspace cannot be used to reach its entry node', async () => {
    const bp = await Promotion.create({ workspaceId: ctx.B.wsId, name: 'B promo' });
    const bpn = await MessageNode.create({ workspaceId: ctx.B.wsId, ownerType: 'promotion', ownerId: bp._id, isEntryNode: true, bodyText: 'B promo secret {{1}}', buttons: [] });
    await Promotion.updateOne({ _id: bp._id }, { $set: { entryNodeId: bpn._id } });
    await Flow.create({ workspaceId: ctx.A.wsId, name: 'Uses B promo', triggerType: 'inactive_customer', promotionId: bp._id });
    const r = await a.get('/flows/messages');
    const row = r.body.items.find((i) => i.flowName === 'Uses B promo');
    expect(row.nodes).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain('B promo secret');
  });

  test('localize: creates once (201), is idempotent (200 same id), seeds the English variant, mirrors approved status', async () => {
    const first = await a.post(`/flows/messages/${A.node._id}/localize`).send({});
    expect(first.status).toBe(201);
    const again = await a.post(`/flows/messages/${A.node._id}/localize`).send({});
    expect(again.status).toBe(200); expect(again.body.id).toBe(first.body.id);
    const docs = await LocalizedTemplate.find({ workspaceId: ctx.A.wsId, linkedMessageNodeId: A.node._id }).lean();
    expect(docs).toHaveLength(1);
    expect(docs[0].key).toBe(`flow_message_${A.node._id}`);
    const en = docs[0].variants.find((v) => v.language === 'en');
    expect(en.body).toBe('Hi {name}, we miss you!');
    expect(en.buttons.map((x) => x.role)).toEqual(['flow_button', 'flow_button', 'opt_out']); // node buttons first, then the added opt-out
    expect(en).toMatchObject({ metaStatus: 'APPROVED', metaTemplateName: 'wf_existing_en', submissionCount: 1 });
    const list = await a.get('/flows/messages');
    expect(list.body.items.find((i) => i.flowName === 'Win-back').nodes[0].localizedTemplateId).toBe(first.body.id);
  });

  test('localize after the linked template was archived restores it instead of forking', async () => {
    const doc = await LocalizedTemplate.findOne({ workspaceId: ctx.A.wsId, linkedMessageNodeId: A.node._id });
    await LocalizedTemplate.updateOne({ _id: doc._id }, { $set: { archived: true } });
    const r = await a.post(`/flows/messages/${A.node._id}/localize`).send({});
    expect(r.status).toBe(200); expect(r.body.id).toBe(String(doc._id)); expect(r.body.archived).toBe(false);
    expect(await LocalizedTemplate.countDocuments({ workspaceId: ctx.A.wsId, linkedMessageNodeId: A.node._id })).toBe(1);
  });

  test('concurrent localize (same process): one template, one 201 at most', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => a.post(`/flows/messages/${A.pnode._id}/localize`).send({})));
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(rs.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await LocalizedTemplate.countDocuments({ workspaceId: ctx.A.wsId, linkedMessageNodeId: A.pnode._id })).toBe(1);
    const t = await LocalizedTemplate.findOne({ workspaceId: ctx.A.wsId, linkedMessageNodeId: A.pnode._id }).lean();
    expect(t.variants[0].body).toBe('Hello {name}: {item} for {price}');
  });

  test('concurrent localize across "processes" (in-flight map bypassed): the unique key makes the loser adopt the winner', async () => {
    const ws = String(ctx.A.wsId);
    const upper = ws.toUpperCase(); // a different in-flight key, same workspace: stands in for a second server instance
    const f = await Flow.create({ workspaceId: ctx.A.wsId, name: 'Race flow', triggerType: 'inactive_customer' });
    const n = await MessageNode.create({ workspaceId: ctx.A.wsId, ownerType: 'flow', ownerId: f._id, isEntryNode: true, bodyText: 'Race {{1}}', buttons: [] });
    const rs = await Promise.allSettled([
      flowMessages.localizeMessage({ workspaceId: ws, userId: String(ctx.A.userId), messageNodeId: String(n._id) }),
      flowMessages.localizeMessage({ workspaceId: upper, userId: String(ctx.A.userId), messageNodeId: String(n._id) }),
    ]);
    expect(rs.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(rs[0].value.template.id).toBe(rs[1].value.template.id);
    expect(rs.filter((r) => r.value.created).length).toBe(1);
    expect(await LocalizedTemplate.countDocuments({ workspaceId: ctx.A.wsId, linkedMessageNodeId: n._id })).toBe(1);
  });

  test('non-localizable nodes: follow-up node and unknown placeholders are 422 NODE_NOT_LOCALIZABLE and write nothing', async () => {
    const f = await a.post(`/flows/messages/${A.followUp._id}/localize`).send({});
    expect(f.status).toBe(422); expect(f.body.code).toBe('NODE_NOT_LOCALIZABLE');
    const bad = await a.post(`/flows/messages/${A.badNode._id}/localize`).send({});
    expect(bad.status).toBe(422); expect(bad.body.code).toBe('NODE_NOT_LOCALIZABLE');
    expect(await LocalizedTemplate.countDocuments({ linkedMessageNodeId: { $in: [A.followUp._id, A.badNode._id] } })).toBe(0);
  });

  test('legacy node without workspaceId but owned by A\'s flow is localizable by A and invisible to B', async () => {
    const forB = await b.post(`/flows/messages/${A.legacyNode._id}/localize`).send({});
    expect(forB.status).toBe(404); expect(forB.body.code).toBe('NODE_NOT_FOUND');
    const forA = await a.post(`/flows/messages/${A.legacyNode._id}/localize`).send({});
    expect([200, 201]).toContain(forA.status);
  });

  test('tenant isolation: B cannot localize A\'s node (404), A cannot localize B\'s; unknown and operator ids are rejected', async () => {
    const before = await LocalizedTemplate.countDocuments({ linkedMessageNodeId: B.node._id });
    const cross = await a.post(`/flows/messages/${B.node._id}/localize`).send({});
    expect(cross.status).toBe(404); expect(cross.body.code).toBe('NODE_NOT_FOUND');
    expect(await LocalizedTemplate.countDocuments({ linkedMessageNodeId: B.node._id })).toBe(before);
    expect((await a.post('/flows/messages/not-an-id/localize').send({})).status).toBe(400);
    expect((await a.post('/flows/messages/%7B%22%24ne%22%3Anull%7D/localize').send({})).status).toBe(400);
    const missing = await a.post('/flows/messages/000000000000000000000000/localize').send({});
    expect(missing.status).toBe(404);
  });

  test('gate: 401 without token, 402 for the unflagged workspace on both endpoints', async () => {
    expect((await ctx.anon.get('/flows/messages')).status).toBe(401);
    expect((await ctx.anon.post(`/flows/messages/${A.node._id}/localize`)).status).toBe(401);
    const r = await c.get('/flows/messages');
    expect(r.status).toBe(402); expect(r.body.code).toBe('ARABIC_NOT_ENABLED');
    expect((await c.post(`/flows/messages/${A.node._id}/localize`).send({})).status).toBe(402);
  });
});
