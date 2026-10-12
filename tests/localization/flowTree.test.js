// Unit tests for the flow message trees (shared/localization/flowTree.js): tenant isolation, cycles, depth,
// orphans, legacy nodes, default templates, per-language versions of entry and follow-up messages.
// In-memory models only (tests/localization/helpers/flowFakes.js).
const fs = require('fs');
const path = require('path');
const { id, fakeModel } = require('./helpers/flowFakes');
const { buildFlowTrees, buildOwnerTree, buildPromotionTrees, MAX_PROMOTION_ROWS, MAX_PROMOTIONS_SCANNED } = require('../../shared/localization/flowTree');
const { hashSource } = require('../../shared/localization/flowFollowUps');

const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const PROMOTION = id(10);
const FLOW_P = id(1); // flow that sends the promotion
const FLOW_L = id(2); // legacy flow with its own entry node
const FLOW_D = id(3); // fixed default template
const E = id(100);
const F1 = id(101);
const F2 = id(102);
const F3 = id(103);
const F4 = id(104);
const LEGACY_E = id(200);
const LEGACY_F = id(201);

const send = (position, label, target) => ({ position, label, nextAction: { type: 'send_message', targetNodeId: target } });
const end = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });
const node = (_id, over = {}) => ({ _id, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: false, bodyText: `Body ${_id.slice(-3)} {{1}}`, buttons: [], ...over });

function world(over = {}) {
  const nodes = over.nodes || [
    node(E, { isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}', templateStatus: 'approved', templateName: 'waflow_x', buttons: [end(0, 'Not now'), send(1, 'Tell me more', F1)] }),
    node(F1, { buttons: [send(0, 'Next', F2), end(1, 'Stop')] }),
    node(F2, { buttons: [send(0, 'Deeper', F3)] }),
    node(F3, { buttons: [send(0, 'Deepest', F4), send(1, 'Back to start', E)] }),
    node(F4, { buttons: [] }),
    node(id(150), { workspaceId: OTHER_WS, bodyText: 'foreign orphan' }),
  ];
  return {
    Flow: fakeModel(over.flows || [
      { _id: FLOW_P, workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: PROMOTION, createdAt: new Date('2026-10-03') },
      { _id: FLOW_L, workspaceId: WS, name: 'Legacy', triggerType: 'booking_no_show', status: 'paused', entryNodeId: LEGACY_E, createdAt: new Date('2026-10-02') },
      { _id: FLOW_D, workspaceId: WS, name: 'Default', triggerType: 'post_purchase_points', status: 'active', createdAt: new Date('2026-10-01') },
      { _id: id(4), workspaceId: OTHER_WS, name: 'Theirs', triggerType: 'inactive_customer', status: 'active', promotionId: id(11), createdAt: new Date('2026-10-04') },
    ]),
    Promotion: fakeModel(over.promotions || [
      { _id: PROMOTION, workspaceId: WS, name: 'Summer Sale', entryNodeId: E },
      { _id: id(11), workspaceId: OTHER_WS, name: 'Their Sale', entryNodeId: id(150) },
    ]),
    MessageNode: fakeModel([
      ...nodes,
      node(LEGACY_E, { workspaceId: undefined, ownerType: 'flow', ownerId: FLOW_L, isEntryNode: true, bodyText: 'We missed you {{1}} - {{2}}', templateStatus: 'pending', buttons: [send(0, 'Rebook', LEGACY_F)] }),
      node(LEGACY_F, { workspaceId: undefined, ownerType: 'flow', ownerId: FLOW_L, bodyText: 'Great {{1}}' }),
      ...(over.extraNodes || []),
    ]),
    LocalizedTemplate: fakeModel(over.templates || []),
    LocalizedFlowNode: fakeModel(over.rows || []),
    log: jest.fn(),
  };
}

const rowFor = (messageNodeId, nodeDoc, over = {}) => ({
  _id: id(900), workspaceId: WS, messageNodeId, language: 'ar', body: 'مرحبًا يا {name}', buttons: nodeDoc.buttons.map((b) => ({ position: b.position, text: `زر ${b.position}` })),
  reviewStatus: 'reviewed', sourceHash: hashSource(nodeDoc), contentVersion: 3, ...over,
});
const treeFor = async (deps, flowId) => (await buildFlowTrees({ workspaceId: WS }, deps)).items.find((i) => i.flowId === flowId);

describe('buildFlowTrees: the rows', () => {
  test('lists this workspace\'s flows newest first with source, promotion name and status; never another workspace\'s', async () => {
    const out = await buildFlowTrees({ workspaceId: WS }, world());
    expect(out.items.map((i) => i.flowId)).toEqual([FLOW_P, FLOW_L, FLOW_D]);
    expect(out.items.map((i) => i.messageSource)).toEqual(['promotion', 'custom_entry', 'default_template']);
    expect(out.items[0]).toMatchObject({ flowName: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: PROMOTION, promotionName: 'Summer Sale' });
    expect(out.items[1]).toMatchObject({ status: 'paused', promotionId: null, promotionName: null });
  });
  test('a fixed default template flow has no nodes (English only)', async () => {
    expect((await treeFor(world(), FLOW_D)).nodes).toEqual([]);
  });
  test('no flows -> empty list and no further query', async () => {
    const deps = world({ flows: [] });
    expect(await buildFlowTrees({ workspaceId: WS }, deps)).toEqual({ items: [] });
    expect(deps.MessageNode.find).not.toHaveBeenCalled();
  });
  test('garbage / foreign workspace ids', async () => {
    await expect(buildFlowTrees({ workspaceId: undefined }, world())).rejects.toMatchObject({ status: 403 });
    await expect(buildFlowTrees({ workspaceId: { $ne: null } }, world())).rejects.toMatchObject({ status: 403 });
    expect((await buildFlowTrees({ workspaceId: id(0xcc) }, world())).items).toEqual([]);
  });
});

describe('buildFlowTrees: the node tree', () => {
  test('depth-first, parent before child, children in button-position order, depth <= 3, cycle back to the entry ignored', async () => {
    const row = await treeFor(world(), FLOW_P);
    expect(row.nodes.map((n) => [n.messageNodeId, n.parentNodeId, n.parentButtonPosition, n.depth])).toEqual([
      [E, null, null, 0],
      [F1, E, 1, 1],
      [F2, F1, 0, 2],
      [F3, F2, 0, 3],
    ]); // F4 would be depth 4; "Back to start" -> E is a cycle
  });
  test('each node appears once even when two buttons point at it', async () => {
    const nodes = [
      node(E, { isEntryNode: true, templateStatus: 'approved', buttons: [send(0, 'A', F1), send(1, 'B', F1)] }),
      node(F1, { buttons: [] }),
    ];
    const row = await treeFor(world({ nodes }), FLOW_P);
    expect(row.nodes.map((n) => n.messageNodeId)).toEqual([E, F1]);
    expect(row.nodes[1].parentButtonPosition).toBe(0);
  });
  test('a self-loop or two-node cycle terminates', async () => {
    const nodes = [node(E, { isEntryNode: true, buttons: [send(0, 'A', F1)] }), node(F1, { buttons: [send(0, 'Loop', F1), send(1, 'Up', E)] })];
    const row = await treeFor(world({ nodes }), FLOW_P);
    expect(row.nodes.map((n) => n.messageNodeId)).toEqual([E, F1]);
  });
  test('node fields: English text, {field} form, slot list, buttons with their actions, entry template status', async () => {
    const [entry, first] = (await treeFor(world(), FLOW_P)).nodes;
    expect(entry).toMatchObject({
      isEntry: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}', bodyFields: 'Hi {name}! {item} for {price} - {promo_name}',
      slotFields: ['name', 'item', 'price', 'promo_name'], templateStatus: 'approved',
    });
    expect(entry.buttons).toEqual([
      { position: 0, label: 'Not now', action: 'end_flow', targetNodeId: null },
      { position: 1, label: 'Tell me more', action: 'send_message', targetNodeId: F1 },
    ]);
    expect(first).toMatchObject({ isEntry: false, templateStatus: null, bodyFields: 'Body 101 {name}' });
  });
  test('a node whose English text cannot be expressed in fields: bodyFields null with the problem, no Arabic can be added to an entry', async () => {
    const nodes = [node(E, { isEntryNode: true, bodyText: 'Hi {{9}}', templateStatus: 'approved', buttons: [] })];
    const [entry] = (await treeFor(world({ nodes }), FLOW_P)).nodes;
    expect(entry.bodyFields).toBeNull();
    expect(entry.slotProblem).toEqual({ reason: 'unknown_slot', slot: 9 });
    expect(entry.canAddArabic).toBe(false);
    expect(entry.addArabicUrl).toBeNull();
  });
  test('the legacy flow walks its own entry node and follow-up (workspace-less nodes proven through the owning flow)', async () => {
    const row = await treeFor(world(), FLOW_L);
    expect(row.nodes.map((n) => n.messageNodeId)).toEqual([LEGACY_E, LEGACY_F]);
    expect(row.nodes[0]).toMatchObject({ slotFields: ['name', 'service'], bodyFields: 'We missed you {name} - {service}', templateStatus: 'pending' });
  });
  test('a legacy node whose owner is not in this workspace is dropped, and so is everything behind it', async () => {
    const deps = world({ flows: [
      { _id: FLOW_L, workspaceId: WS, name: 'Legacy', triggerType: 'booking_no_show', status: 'paused', entryNodeId: LEGACY_E, createdAt: new Date() },
    ] });
    deps.MessageNode.docs.find((n) => n._id === LEGACY_E).ownerId = id(777); // some other flow
    expect((await treeFor(deps, FLOW_L)).nodes).toEqual([]);
  });
  test('foreign-workspace nodes (a promotion entry pointing at another tenant\'s node) never appear', async () => {
    const nodes = [node(E, { isEntryNode: true, buttons: [send(0, 'A', id(150))] }), node(id(150), { workspaceId: OTHER_WS, bodyText: 'secret' })];
    const row = await treeFor(world({ nodes }), FLOW_P);
    expect(row.nodes.map((n) => n.messageNodeId)).toEqual([E]);
    expect(JSON.stringify(row)).not.toContain('secret');
  });
  test('a promotion of another workspace referenced by this flow gives no tree', async () => {
    const flows = [{ _id: FLOW_P, workspaceId: WS, name: 'X', triggerType: 'inactive_customer', status: 'active', promotionId: id(11), createdAt: new Date() }];
    const row = await treeFor(world({ flows }), FLOW_P);
    expect(row.nodes).toEqual([]);
    expect(row.promotionName).toBeNull();
  });
  test('a promotion without a custom entry message gives no nodes; an entry id that is not an entry node gives none either', async () => {
    const noEntry = world({ promotions: [{ _id: PROMOTION, workspaceId: WS, name: 'P' }] });
    expect((await treeFor(noEntry, FLOW_P)).nodes).toEqual([]);
    const notEntry = world({ nodes: [node(E, { isEntryNode: false })] });
    expect((await treeFor(notEntry, FLOW_P)).nodes).toEqual([]);
  });
  test('bulk queries only: never one query per flow or per node, and the cost does not grow with the number of flows', async () => {
    const small = world();
    await buildFlowTrees({ workspaceId: WS }, small);
    const flows = Array.from({ length: 40 }, (_, i) => ({ _id: id(5000 + i), workspaceId: WS, name: `F${i}`, triggerType: 'inactive_customer', status: 'active', promotionId: PROMOTION, createdAt: new Date(2026, 0, i + 1) }));
    const big = world({ flows });
    await buildFlowTrees({ workspaceId: WS }, big);
    const total = (d) => ['Flow', 'Promotion', 'MessageNode', 'LocalizedTemplate', 'LocalizedFlowNode'].reduce((n, m) => n + d[m].find.mock.calls.length + d[m].findOne.mock.calls.length, 0);
    expect(total(big)).toBe(total(small));
    expect(total(big)).toBeLessThanOrEqual(10);
  });
  test('every workspace-owned query carries the workspace', async () => {
    const deps = world();
    await buildFlowTrees({ workspaceId: WS }, deps);
    for (const model of ['Flow', 'Promotion', 'LocalizedTemplate', 'LocalizedFlowNode']) {
      for (const [filter] of deps[model].find.mock.calls) expect(filter.workspaceId).toBe(WS);
    }
  });
  test('at most 500 flows are read', async () => {
    const deps = world();
    const spy = jest.spyOn(deps.Flow, 'find');
    await buildFlowTrees({ workspaceId: WS }, deps);
    expect(spy).toHaveBeenCalledTimes(1);
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowTree.js'), 'utf8');
    expect(source).toMatch(/MAX_FLOWS = 500/);
  });
});

describe('versions', () => {
  const entryTemplate = (over = {}) => ({
    _id: id(500), workspaceId: WS, linkedMessageNodeId: E, archived: false, createdAt: new Date('2026-10-05'),
    variants: [
      { language: 'en', body: 'Hi {name}! {item} for {price} - {promo_name}', buttons: [{ role: 'flow_button', text: 'Not now' }, { role: 'flow_button', text: 'Tell me more' }], metaStatus: 'APPROVED' },
      { language: 'ar', body: 'أهلاً {name}! {item} بسعر {price} ضمن {promo_name}', buttons: [{ role: 'flow_button', text: 'لاحقًا' }, { role: 'flow_button', text: 'أخبرني' }, { role: 'opt_out', text: 'إلغاء الاشتراك' }], metaStatus: 'APPROVED', reviewStatus: 'reviewed', metaTemplateName: 'wf_ar_1', contentVersion: 4 },
    ],
    ...over,
  });

  test('an entry message with no template: English only, canAddArabic with a deep link to the flows tab', async () => {
    const [entry] = (await treeFor(world(), FLOW_P)).nodes;
    expect(entry.versions).toHaveLength(1);
    expect(entry.versions[0]).toEqual({
      language: 'en', body: 'Hi {name}! {item} for {price} - {promo_name}',
      buttons: [{ position: 0, role: 'flow_button', text: 'Not now' }, { position: 1, role: 'flow_button', text: 'Tell me more' }],
      metaStatus: 'APPROVED', reviewStatus: null, stale: false, sendable: null, contentVersion: null, editUrl: null,
    });
    expect(entry.canAddArabic).toBe(true);
    expect(entry.addArabicUrl).toBe(`/arabic/flows?node=${E}`);
  });
  test('an approved + reviewed Arabic entry version: buttons matched to the node\'s positions, opt-out has none, sendable, edit link', async () => {
    const [entry] = (await treeFor(world({ templates: [entryTemplate()] }), FLOW_P)).nodes;
    const ar = entry.versions.find((v) => v.language === 'ar');
    expect(ar).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'reviewed', sendable: true, stale: false, contentVersion: 4, editUrl: `/arabic/templates/${id(500)}` });
    expect(ar.buttons).toEqual([
      { position: 0, role: 'flow_button', text: 'لاحقًا' },
      { position: 1, role: 'flow_button', text: 'أخبرني' },
      { position: null, role: 'opt_out', text: 'إلغاء الاشتراك' },
    ]);
    expect(entry.canAddArabic).toBe(false);
    expect(entry.addArabicUrl).toBeNull();
  });
  test.each([
    ['pending at Meta', { metaStatus: 'PENDING' }],
    ['not reviewed', { reviewStatus: 'draft' }],
    ['no Meta name', { metaTemplateName: undefined }],
    ['wrong number of flow buttons', { buttons: [{ role: 'flow_button', text: 'x' }, { role: 'opt_out', text: 'y' }] }],
  ])('an Arabic entry version that is %s is not sendable', async (_, patch) => {
    const template = entryTemplate();
    Object.assign(template.variants[1], patch);
    const [entry] = (await treeFor(world({ templates: [template] }), FLOW_P)).nodes;
    expect(entry.versions.find((v) => v.language === 'ar').sendable).toBe(false);
  });
  test('a template with only an English mirror: canAddArabic links to the template editor; archived and foreign templates are ignored', async () => {
    const mirrorOnly = entryTemplate();
    mirrorOnly.variants.pop();
    const [entry] = (await treeFor(world({ templates: [mirrorOnly] }), FLOW_P)).nodes;
    expect(entry.canAddArabic).toBe(true);
    expect(entry.addArabicUrl).toBe(`/arabic/templates/${id(500)}`);
    const ignored = world({ templates: [entryTemplate({ archived: true }), entryTemplate({ _id: id(501), workspaceId: OTHER_WS })] });
    expect((await treeFor(ignored, FLOW_P)).nodes[0].versions).toHaveLength(1);
  });
  test('the oldest live template wins when two are linked to the same node; a bilingual version is listed but never "sendable"', async () => {
    const newer = entryTemplate({ _id: id(900) });
    newer.variants[1].body = 'newer';
    const bilingual = entryTemplate({ _id: id(500) });
    bilingual.variants.push({ language: 'bilingual', body: 'مرحبا hello {name}', buttons: [{ role: 'flow_button', text: 'a' }, { role: 'flow_button', text: 'b' }], metaStatus: 'APPROVED', reviewStatus: 'reviewed', metaTemplateName: 'wf_bi' });
    const [entry] = (await treeFor(world({ templates: [newer, bilingual] }), FLOW_P)).nodes;
    expect(entry.versions.map((v) => v.language)).toEqual(['en', 'ar', 'bilingual']);
    expect(entry.versions[1].body).not.toBe('newer');
    expect(entry.versions[2].sendable).toBe(false);
  });
  test('follow-up without a row: no versions, can add, deep link', async () => {
    const [, first] = (await treeFor(world(), FLOW_P)).nodes;
    expect(first.versions).toEqual([]);
    expect(first.canAddArabic).toBe(true);
    expect(first.addArabicUrl).toBe(`/arabic/flows?node=${F1}`);
  });
  test('follow-up with a reviewed, in-step row: sendable; metaStatus NOT_REQUIRED; buttons are flow buttons at their positions', async () => {
    const f1 = world().MessageNode.docs.find((n) => n._id === F1);
    const [, first] = (await treeFor(world({ rows: [rowFor(F1, f1)] }), FLOW_P)).nodes;
    expect(first.versions).toEqual([{
      language: 'ar', body: 'مرحبًا يا {name}', buttons: [{ position: 0, role: 'flow_button', text: 'زر 0' }, { position: 1, role: 'flow_button', text: 'زر 1' }],
      metaStatus: 'NOT_REQUIRED', reviewStatus: 'reviewed', stale: false, sendable: true, contentVersion: 3, editUrl: `/arabic/flows?node=${F1}`,
    }]);
    expect(first.canAddArabic).toBe(false);
    expect(first.addArabicUrl).toBeNull();
  });
  test('a follow-up row written against older English text is stale and not sendable', async () => {
    const f1 = world().MessageNode.docs.find((n) => n._id === F1);
    const [, first] = (await treeFor(world({ rows: [rowFor(F1, f1, { sourceHash: 'old' })] }), FLOW_P)).nodes;
    expect(first.versions[0]).toMatchObject({ stale: true, sendable: false, reviewStatus: 'reviewed' });
  });
  test('a draft or an invalid follow-up row is not sendable', async () => {
    const f1 = world().MessageNode.docs.find((n) => n._id === F1);
    const draft = (await treeFor(world({ rows: [rowFor(F1, f1, { reviewStatus: 'draft' })] }), FLOW_P)).nodes[1];
    expect(draft.versions[0].sendable).toBe(false);
    const invalid = (await treeFor(world({ rows: [rowFor(F1, f1, { body: '' })] }), FLOW_P)).nodes[1];
    expect(invalid.versions[0].sendable).toBe(false);
  });
  test('a row of another workspace for the same node is not shown', async () => {
    const f1 = world().MessageNode.docs.find((n) => n._id === F1);
    const [, first] = (await treeFor(world({ rows: [rowFor(F1, f1, { workspaceId: OTHER_WS })] }), FLOW_P)).nodes;
    expect(first.versions).toEqual([]);
  });
});

describe('buildOwnerTree', () => {
  test('promotion owner: its entry message tree', async () => {
    const out = await buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION }, world());
    expect(out).toMatchObject({ ownerType: 'promotion', ownerId: PROMOTION, messageSource: 'promotion' });
    expect(out.nodes.map((n) => n.messageNodeId)).toEqual([E, F1, F2, F3]);
  });
  test('promotion without a custom entry message: default_template, no nodes', async () => {
    const out = await buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION }, world({ promotions: [{ _id: PROMOTION, workspaceId: WS, name: 'P' }] }));
    expect(out).toMatchObject({ messageSource: 'default_template', nodes: [] });
  });
  test('flow owner: promotion flow, legacy flow, default flow', async () => {
    const deps = world();
    expect((await buildOwnerTree({ workspaceId: WS, ownerType: 'flow', ownerId: FLOW_P }, deps)).nodes).toHaveLength(4);
    const legacy = await buildOwnerTree({ workspaceId: WS, ownerType: 'flow', ownerId: FLOW_L }, deps);
    expect(legacy).toMatchObject({ messageSource: 'custom_entry' });
    expect(legacy.nodes.map((n) => n.messageNodeId)).toEqual([LEGACY_E, LEGACY_F]);
    expect(await buildOwnerTree({ workspaceId: WS, ownerType: 'flow', ownerId: FLOW_D }, deps)).toMatchObject({ messageSource: 'default_template', nodes: [] });
  });
  test('an owner of another workspace is a 404, bad ids 400, bad owner type 400, no workspace 403', async () => {
    const deps = world();
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'flow', ownerId: id(4) }, deps)).rejects.toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: id(11) }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: id(999) }, deps)).rejects.toMatchObject({ status: 404 });
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: 'x' }, deps)).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'promotion', ownerId: { $ne: null } }, deps)).rejects.toMatchObject({ status: 400 });
    await expect(buildOwnerTree({ workspaceId: WS, ownerType: 'campaign', ownerId: PROMOTION }, deps)).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(buildOwnerTree({ workspaceId: undefined, ownerType: 'flow', ownerId: FLOW_P }, deps)).rejects.toMatchObject({ status: 403 });
  });
});

// ── Promotions with their own message that no flow sends ──────────────────
describe('buildPromotionTrees', () => {
  const P2 = id(20); // promotion sent from the Promotions screen: custom entry message + follow-ups, no flow
  const P2_E = id(300);
  const P2_F1 = id(301);
  const P2_F2 = id(302);
  const p2Nodes = (over = {}) => [
    node(P2_E, { ownerId: P2, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}}', templateStatus: 'approved', templateName: 'waflow_p2', buttons: [send(0, 'Tell me more', P2_F1), end(1, 'No thanks')], ...over }),
    node(P2_F1, { ownerId: P2, bodyText: 'Great {{1}}', buttons: [send(0, 'And more', P2_F2)] }),
    node(P2_F2, { ownerId: P2, bodyText: 'Last {{1}}', buttons: [] }),
  ];
  const withP2 = (over = {}) => world({
    promotions: [
      { _id: PROMOTION, workspaceId: WS, name: 'Summer Sale', entryNodeId: E, createdAt: new Date('2026-09-01') },
      { _id: P2, workspaceId: WS, name: 'Ramadan offer', status: 'active', entryNodeId: P2_E, createdAt: new Date('2026-10-01') },
      { _id: id(11), workspaceId: OTHER_WS, name: 'Their Sale', entryNodeId: id(150) },
      ...(over.promotions || []),
    ],
    extraNodes: [...p2Nodes(over.entry), ...(over.extraNodes || [])],
    ...(over.rest || {}),
  });
  const list = async (deps) => buildPromotionTrees({ workspaceId: WS }, deps);
  const flowOf = (_id, promotionId, over = {}) => ({ _id, workspaceId: WS, name: 'F', triggerType: 'inactive_customer', status: 'active', promotionId, createdAt: new Date(), ...over });

  test('lists a promotion that has its own entry message and no flow, with its whole node tree', async () => {
    const out = await list(withP2());
    expect(out.truncated).toBe(false);
    expect(out.items).toHaveLength(1); // PROMOTION is sent by the Win-back flow of the fixture
    expect(out.items[0]).toMatchObject({
      ownerType: 'promotion', promotionId: P2, promotionName: 'Ramadan offer', promotionStatus: 'active',
      messageSource: 'promotion', entryTemplateStatus: 'approved',
    });
    expect(out.items[0].nodes.map((n) => [n.messageNodeId, n.parentNodeId, n.parentButtonPosition, n.depth, n.isEntry])).toEqual([
      [P2_E, null, null, 0, true], [P2_F1, P2_E, 0, 1, false], [P2_F2, P2_F1, 0, 2, false],
    ]);
    expect(out.items[0].nodes[0]).toMatchObject({ bodyFields: 'Hi {name}! {item} for {price}', slotFields: ['name', 'item', 'price', 'promo_name'] });
  });

  test('a promotion that a flow of the workspace sends appears under the flow only (no duplicate), even when the flow is paused', async () => {
    const deps = withP2();
    expect((await list(deps)).items.map((i) => i.promotionId)).not.toContain(PROMOTION);
    expect((await buildFlowTrees({ workspaceId: WS }, deps)).items.find((i) => i.flowId === FLOW_P).promotionId).toBe(PROMOTION);
    const paused = withP2({ rest: { flows: [flowOf(id(7), P2, { status: 'paused' })] } });
    // in this world only P2 is sent by a flow (paused): the other promotion is now free
    expect((await list(paused)).items.map((i) => i.promotionId)).toEqual([PROMOTION]);
  });

  test('a flow of ANOTHER workspace that points at this promotion does not hide it', async () => {
    const deps = withP2({ rest: { flows: [flowOf(id(8), P2, { workspaceId: OTHER_WS })] } });
    expect((await list(deps)).items.map((i) => i.promotionId).sort()).toEqual([PROMOTION, P2].sort());
  });

  test('the nodes are identical to the ones the same promotion has under a flow row (same versions, canAddArabic, urls)', async () => {
    const rows = [rowFor(P2_F1, p2Nodes()[1], { _id: id(901) })];
    const templates = [{
      _id: id(500), workspaceId: WS, linkedMessageNodeId: P2_E, archived: false, createdAt: new Date(),
      variants: [{ language: 'en', body: 'x', buttons: [], metaStatus: 'APPROVED' }],
    }];
    const free = withP2({ rest: { rows, templates, flows: [] } });
    const used = withP2({ rest: { rows, templates, flows: [flowOf(id(9), P2)] } });
    const fromPromotionList = (await list(free)).items.find((i) => i.promotionId === P2).nodes;
    const fromFlowRow = (await buildFlowTrees({ workspaceId: WS }, used)).items[0].nodes;
    expect(fromPromotionList).toEqual(fromFlowRow);
    expect(fromPromotionList[0]).toMatchObject({ canAddArabic: true, addArabicUrl: `/arabic/templates/${id(500)}` });
    expect(fromPromotionList[1].versions[0]).toMatchObject({ language: 'ar', reviewStatus: 'reviewed', sendable: true, editUrl: `/arabic/flows?node=${P2_F1}` });
    expect(fromPromotionList[1]).toMatchObject({ canAddArabic: false, addArabicUrl: null });
    expect(fromPromotionList[2]).toMatchObject({ canAddArabic: true, addArabicUrl: `/arabic/flows?node=${P2_F2}`, versions: [] });
  });

  test('the entry message is listed whatever its English template status (approved, pending, rejected, not created)', async () => {
    for (const status of ['approved', 'pending', 'rejected', 'not_created', undefined]) {
      const deps = withP2({ entry: { templateStatus: status } });
      const row = (await list(deps)).items.find((i) => i.promotionId === P2);
      expect(row.entryTemplateStatus).toBe(status || 'not_created');
      expect(row.nodes[0].templateStatus).toBe(status || 'not_created');
    }
  });

  test('promotions without an entry message, with a dangling or foreign entry node, or whose entry id is not an entry node are left out', async () => {
    const deps = withP2({
      promotions: [
        { _id: id(21), workspaceId: WS, name: 'Plain', createdAt: new Date() },
        { _id: id(22), workspaceId: WS, name: 'Dangling', entryNodeId: id(999), createdAt: new Date() },
        { _id: id(23), workspaceId: WS, name: 'Foreign node', entryNodeId: id(150), createdAt: new Date() },
        { _id: id(24), workspaceId: WS, name: 'Not an entry', entryNodeId: id(310), createdAt: new Date() },
        { _id: id(25), workspaceId: WS, name: 'Bad id', entryNodeId: 'nope', createdAt: new Date() },
      ],
      extraNodes: [node(id(310), { ownerId: id(24), isEntryNode: false, bodyText: 'x' })],
    });
    expect((await list(deps)).items.map((i) => i.promotionId)).toEqual([P2]);
  });

  test('another workspace\'s promotions and nodes never appear (a foreign node behind a button is dropped, its text never leaks)', async () => {
    const deps = withP2({ extraNodes: [node(id(320), { workspaceId: OTHER_WS, ownerId: id(11), bodyText: 'secret text' })] });
    deps.MessageNode.docs.find((n) => n._id === P2_E).buttons.push(send(2, 'Peek', id(320)));
    const out = await list(deps);
    expect(JSON.stringify(out)).not.toMatch(/secret|Their Sale/);
    expect(out.items[0].nodes.map((n) => n.messageNodeId)).toEqual([P2_E, P2_F1, P2_F2]);
    // the other workspace owns a promotion, but its entry node is foreign-owned here: still nothing of ours
    const theirs = await buildPromotionTrees({ workspaceId: OTHER_WS }, withP2());
    expect(JSON.stringify(theirs)).not.toMatch(/Ramadan|Great|Hi \{/);
  });

  test('newest promotion first; an unknown status falls back to draft', async () => {
    const deps = withP2({
      promotions: [{ _id: id(26), workspaceId: WS, name: 'Newest', status: 'weird', entryNodeId: id(330), createdAt: new Date('2026-10-10') }],
      extraNodes: [node(id(330), { ownerId: id(26), isEntryNode: true, bodyText: 'Hello {{1}}', templateStatus: 'approved', buttons: [] })],
    });
    const out = await list(deps);
    expect(out.items.map((i) => i.promotionId)).toEqual([id(26), P2]);
    expect(out.items[0].promotionStatus).toBe('draft');
  });

  test('nothing eligible: empty list and no node query', async () => {
    const none = world({ promotions: [], flows: [] });
    expect(await list(none)).toEqual({ items: [], truncated: false });
    expect(none.MessageNode.find).not.toHaveBeenCalled();
    const onlyUsed = world(); // the single promotion with a message is sent by a flow
    expect(await list(onlyUsed)).toEqual({ items: [], truncated: false });
    expect(onlyUsed.MessageNode.find).not.toHaveBeenCalled();
  });

  test('bad or foreign workspace: 403 / empty', async () => {
    await expect(buildPromotionTrees({ workspaceId: undefined }, withP2())).rejects.toMatchObject({ status: 403 });
    await expect(buildPromotionTrees({ workspaceId: { $ne: null } }, withP2())).rejects.toMatchObject({ status: 403 });
    expect(await buildPromotionTrees({ workspaceId: id(0xcc) }, withP2())).toEqual({ items: [], truncated: false });
  });

  test('every workspace-owned query carries the workspace, equality / $in only, and the cost does not grow with the number of promotions', async () => {
    const small = withP2();
    await list(small);
    const many = [];
    const manyNodes = [];
    for (let i = 0; i < 30; i += 1) {
      many.push({ _id: id(4000 + i), workspaceId: WS, name: `P${i}`, entryNodeId: id(5000 + i), createdAt: new Date(2026, 0, i + 1) });
      manyNodes.push(node(id(5000 + i), { ownerId: id(4000 + i), isEntryNode: true, bodyText: 'Hi {{1}}', templateStatus: 'approved', buttons: [] }));
    }
    const big = withP2({ promotions: many, extraNodes: manyNodes });
    const out = await list(big);
    expect(out.items).toHaveLength(31);
    const total = (d) => ['Flow', 'Promotion', 'MessageNode', 'LocalizedTemplate', 'LocalizedFlowNode'].reduce((n, m) => n + d[m].find.mock.calls.length + d[m].findOne.mock.calls.length, 0);
    expect(total(big)).toBe(total(small));
    for (const model of ['Flow', 'Promotion', 'LocalizedTemplate', 'LocalizedFlowNode']) {
      for (const [filter] of big[model].find.mock.calls) {
        expect(filter.workspaceId).toBe(WS);
        for (const [field, value] of Object.entries(filter)) {
          if (!value || typeof value !== 'object') continue;
          // $in everywhere; the linked-template lookup also skips archived templates (same query as /tree)
          expect(Object.keys(value)).toEqual(field === 'archived' ? ['$ne'] : ['$in']);
        }
      }
    }
  });

  test('a long list is capped at MAX_PROMOTION_ROWS (newest kept), reported as truncated and logged', async () => {
    const many = [];
    const manyNodes = [];
    const total = MAX_PROMOTION_ROWS + 25;
    for (let i = 0; i < total; i += 1) {
      many.push({ _id: id(6000 + i), workspaceId: WS, name: `P${i}`, entryNodeId: id(8000 + i), createdAt: new Date(Date.UTC(2026, 0, 1) + i * 1000) });
      manyNodes.push(node(id(8000 + i), { ownerId: id(6000 + i), isEntryNode: true, bodyText: 'Hi {{1}}', templateStatus: 'approved', buttons: [] }));
    }
    const deps = withP2({ promotions: many, extraNodes: manyNodes });
    const out = await list(deps);
    expect(out.items).toHaveLength(MAX_PROMOTION_ROWS);
    expect(out.truncated).toBe(true);
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining(String(MAX_PROMOTION_ROWS)));
    const ids = out.items.map((i) => i.promotionId);
    expect(ids).toContain(id(6000 + total - 1)); // the newest generated one
    expect(ids).not.toContain(id(6000)); // the oldest are cut
  });

  test('at most MAX_PROMOTIONS_SCANNED promotions are read; hitting that limit is reported and logged', async () => {
    const deps = withP2();
    const spy = jest.spyOn(deps.Promotion, 'find');
    await list(deps);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(MAX_PROMOTIONS_SCANNED).toBe(1000);
    const filler = Array.from({ length: MAX_PROMOTIONS_SCANNED }, (_, i) => ({ _id: id(20000 + i), workspaceId: WS, name: `N${i}`, createdAt: new Date() }));
    const crowded = world({ promotions: filler, flows: [] });
    expect(await list(crowded)).toEqual({ items: [], truncated: true });
    expect(crowded.log).toHaveBeenCalledWith(expect.stringContaining('1000'));
  });

  test('the promotion list never writes and uses no sort or exotic operator', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowTree.js'), 'utf8');
    const fn = source.slice(source.indexOf('async function buildPromotionTrees'), source.indexOf('// GET /flows/owners'));
    expect(fn.length).toBeGreaterThan(200);
    expect(fn.match(/\$exists|\$ne|\$or|\$regex|\.sort\(\{|aggregate|\.create\(|updateOne|deleteOne/)).toBeNull();
  });
});

describe('source hygiene', () => {
  test('flowTree.js never writes or deletes and uses no multi-field sort', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowTree.js'), 'utf8');
    expect(source.match(/\.create\(|\.save\(|updateOne|updateMany|findOneAndUpdate|deleteOne|deleteMany|\.remove\(|\.sort\(\{|\.aggregate\(|\$text/)).toBeNull();
  });
});
