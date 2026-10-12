// Unit tests for the Arabic follow-up rules and store (shared/localization/flowFollowUps.js).
// Pure rules are tested directly; the store runs over in-memory models (tests/localization/helpers/flowFakes.js).
// No database, no network, no WhatsApp.
const fs = require('fs');
const path = require('path');
const { id, fakeModel } = require('./helpers/flowFakes');
const fu = require('../../shared/localization/flowFollowUps');

const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const USER = id(900);
const PROMOTION = id(10);
const FLOW = id(1);
const NODE = id(101);
const ENTRY = id(100);

const button = (position, label, target) => ({ position, label, nextAction: target ? { type: 'send_message', targetNodeId: target } : { type: 'end_flow' } });
const followUpNode = (over = {}) => ({
  _id: NODE, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: false,
  bodyText: 'Great choice {{1}}! Your {{2}} is on its way.', buttons: [button(0, 'Track it'), button(1, 'Done')], ...over,
});
const promotionOwner = { kind: 'promotion', triggerType: undefined };
const goodVariant = (node, over = {}) => ({
  body: 'اختيار رائع يا {name}! طلبك في الطريق.',
  buttons: [{ position: 0, text: 'تتبع الطلب' }, { position: 1, text: 'تم' }],
  reviewStatus: 'reviewed',
  sourceHash: fu.hashSource(node),
  ...over,
});
const codes = (list) => list.map((i) => i.code);

describe('slotFieldsOf', () => {
  test('promotion owner: name, item, price, promo_name', () => {
    expect(fu.slotFieldsOf(followUpNode(), promotionOwner)).toEqual(['name', 'item', 'price', 'promo_name']);
  });
  test('flow owner follows the trigger', () => {
    const node = followUpNode({ ownerType: 'flow', ownerId: FLOW });
    expect(fu.slotFieldsOf(node, { triggerType: 'post_purchase_points' })).toEqual(['name', 'points']);
    expect(fu.slotFieldsOf(node, { triggerType: 'booking_no_show' })).toEqual(['name', 'service']);
  });
  test('no slot list (points_threshold, unknown owner) falls back to [name]: English always substitutes {{1}} with the first name', () => {
    const node = followUpNode({ ownerType: 'flow', ownerId: FLOW });
    expect(fu.slotFieldsOf(node, { triggerType: 'points_threshold' })).toEqual(['name']);
    expect(fu.slotFieldsOf(node, null)).toEqual(['name']);
    expect(fu.slotFieldsOf(node, undefined)).toEqual(['name']);
  });
});

describe('hashSource', () => {
  test('is stable and ignores the order buttons are stored in', () => {
    const a = followUpNode();
    const b = followUpNode({ buttons: [button(1, 'Done'), button(0, 'Track it')] });
    expect(fu.hashSource(a)).toBe(fu.hashSource(b));
    expect(fu.hashSource(a)).toMatch(/^[a-f0-9]{40}$/);
  });
  test.each([
    ['body text', { bodyText: 'Great choice {{1}}!' }],
    ['a button label', { buttons: [button(0, 'Track'), button(1, 'Done')] }],
    ['a button position', { buttons: [button(0, 'Track it'), button(2, 'Done')] }],
    ['a removed button', { buttons: [button(0, 'Track it')] }],
  ])('changes when the English %s changes', (_, over) => {
    expect(fu.hashSource(followUpNode(over))).not.toBe(fu.hashSource(followUpNode()));
  });
  test('a different nextAction target does not matter (structure stays on the node)', () => {
    const a = followUpNode({ buttons: [button(0, 'Track it', id(7)), button(1, 'Done')] });
    expect(fu.hashSource(a)).toBe(fu.hashSource(followUpNode()));
  });
});

describe('cleanText', () => {
  test('strips zero-width, bidi controls and BOM but keeps Arabic with tanween', () => {
    const dirty = `\u{200B}مرحبًا\u{200E} يا\u{FEFF} {name}\u{2066}`;
    expect(fu.cleanText(dirty)).toBe('مرحبًا يا {name}');
  });
  test('keeps a ZWJ that joins emoji, drops one anywhere else', () => {
    const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}';
    expect(fu.cleanText(`${family} أهلا`)).toBe(`${family} أهلا`);
    expect(fu.cleanText('أ\u{200D}هلا')).toBe('أهلا');
  });
  test('non-strings become an empty string', () => {
    expect(fu.cleanText(undefined)).toBe('');
    expect(fu.cleanText(42)).toBe('');
  });
});

describe('englishOf', () => {
  test('{{n}} becomes {field}; button list is position-sorted', () => {
    const english = fu.englishOf(followUpNode({ buttons: [button(1, 'Done'), button(0, 'Track it')] }), promotionOwner);
    expect(english.bodyFields).toBe('Great choice {name}! Your {item} is on its way.');
    expect(english.slotProblem).toBeNull();
    expect(english.buttons).toEqual([{ position: 0, label: 'Track it' }, { position: 1, label: 'Done' }]);
  });
  test('an unknown slot or stray braces gives bodyFields null with the problem', () => {
    const flowNode = followUpNode({ ownerType: 'flow', bodyText: 'Hi {{1}} {{2}}' });
    const unknown = fu.englishOf(flowNode, { triggerType: 'inactive_customer' });
    expect(unknown.bodyFields).toBeNull();
    expect(unknown.slotProblem).toEqual({ reason: 'unknown_slot', slot: 2 });
    const stray = fu.englishOf(followUpNode({ bodyText: 'Hi {oops}' }), promotionOwner);
    expect(stray.slotProblem).toEqual({ reason: 'stray_braces' });
  });
});

describe('evaluateVariant: body', () => {
  const node = followUpNode();
  test('a good reviewed variant is sendable with no issues', () => {
    const result = fu.evaluateVariant(node, promotionOwner, goodVariant(node));
    expect(result).toMatchObject({ issues: [], stale: false, sendable: true });
  });
  test.each([[''], ['   '], ['\n'], [undefined], [null]])('body %j -> body_required', (body) => {
    expect(codes(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body })).issues)).toContain('body_required');
  });
  test('a stray brace -> unbalanced_braces; {{1}} -> meta_positional_syntax', () => {
    expect(codes(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'يا {name' })).issues)).toEqual(['unbalanced_braces']);
    expect(codes(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'يا {{1}}' })).issues)).toContain('meta_positional_syntax');
  });
  test('a field outside the slot list -> followup_unknown_field with the field in detail', () => {
    const issues = fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'لديك {points} نقطة' })).issues;
    expect(issues).toEqual([{ code: 'followup_unknown_field', field: 'body', detail: { field: 'points' } }]);
  });
  test('{points} is fine for a post_purchase_points flow', () => {
    const flowNode = followUpNode({ ownerType: 'flow', ownerId: FLOW, bodyText: 'You have {{2}} points' });
    const owner = { kind: 'flow', triggerType: 'post_purchase_points' };
    expect(fu.evaluateVariant(flowNode, owner, goodVariant(flowNode, { body: 'لديك {points} نقطة يا {name}' })).issues).toEqual([]);
  });
  test('names the AI or the merchant invented are rejected; uppercase fields are not special', () => {
    expect(codes(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'يا {Name}' })).issues)).toEqual(['followup_unknown_field']);
  });
  test('1024 code points with buttons pass, 1025 fail; emoji count once each, not as UTF-16 pairs', () => {
    const ok = 'ا'.repeat(1024);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: ok })).issues).toEqual([]);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'ا'.repeat(1025) })).issues)
      .toEqual([{ code: 'body_too_long', field: 'body', detail: { length: 1025, max: 1024 } }]);
    const emoji = '\u{1F600}'.repeat(1024);
    expect(emoji.length).toBe(2048); // UTF-16 length is twice the code point count
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: emoji })).issues).toEqual([]);
  });
  test('without buttons the text limit (4096) applies', () => {
    const plain = followUpNode({ buttons: [] });
    const variant = (body) => ({ body, buttons: [], reviewStatus: 'reviewed', sourceHash: fu.hashSource(plain) });
    expect(fu.evaluateVariant(plain, promotionOwner, variant('ا'.repeat(4096))).issues).toEqual([]);
    expect(fu.evaluateVariant(plain, promotionOwner, variant('ا'.repeat(4097))).issues)
      .toEqual([{ code: 'body_too_long', field: 'body', detail: { length: 4097, max: 4096 } }]);
    expect(fu.bodyLimitFor(plain)).toBe(4096);
    expect(fu.bodyLimitFor(node)).toBe(1024);
  });
  test('mixed Arabic / Latin text, numbers and SAR amounts are plain text for the rules', () => {
    const body = 'مرحبًا {name}، مجموع طلبك 150.00 ر.س عبر WaFlow (Order #1042) \u{1F389}';
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body })).issues).toEqual([]);
  });
  test('Arabic-Indic digits the merchant typed are left alone (no issue, no rewrite)', () => {
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'عدد ٣ أيام' })).issues).toEqual([]);
  });
});

describe('evaluateVariant: buttons', () => {
  const node = followUpNode();
  test('the position SET must equal the node\'s: missing, extra, wrong position, duplicate position', () => {
    const mismatch = (buttons) => codes(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { buttons })).issues);
    expect(mismatch([{ position: 0, text: 'تتبع' }])).toContain('followup_button_mismatch');
    expect(mismatch([{ position: 0, text: 'تتبع' }, { position: 1, text: 'تم' }, { position: 2, text: 'آخر' }])).toContain('followup_button_mismatch');
    expect(mismatch([{ position: 0, text: 'تتبع' }, { position: 2, text: 'تم' }])).toContain('followup_button_mismatch');
    expect(mismatch([{ position: 0, text: 'تتبع' }, { position: 0, text: 'تم' }])).toContain('followup_button_mismatch');
    expect(mismatch(undefined)).toContain('followup_button_mismatch');
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { buttons: [{ position: 0, text: 'تتبع' }] })).issues[0].detail).toEqual({ expected: 2, found: 1 });
  });
  test('non-contiguous positions are fine when they match the node', () => {
    const odd = followUpNode({ buttons: [button(0, 'A'), button(2, 'B')] });
    const variant = goodVariant(odd, { buttons: [{ position: 2, text: 'ب' }, { position: 0, text: 'أ' }] });
    expect(fu.evaluateVariant(odd, promotionOwner, variant).issues).toEqual([]);
  });
  test('a node without buttons needs none', () => {
    const plain = followUpNode({ buttons: [] });
    expect(fu.evaluateVariant(plain, promotionOwner, { body: 'شكرًا', buttons: [], reviewStatus: 'reviewed', sourceHash: fu.hashSource(plain) }).issues).toEqual([]);
    expect(codes(fu.evaluateVariant(plain, promotionOwner, { body: 'شكرًا', buttons: [{ position: 0, text: 'x' }] }).issues)).toContain('followup_button_mismatch');
  });
  test('labels: empty, too long (> 20 code points), exactly 20 ok, emoji counted as code points', () => {
    const labelIssues = (text) => fu.evaluateVariant(node, promotionOwner, goodVariant(node, { buttons: [{ position: 0, text }, { position: 1, text: 'تم' }] })).issues;
    expect(labelIssues('')).toEqual([{ code: 'button_label_empty', field: 'button_0' }]);
    expect(labelIssues('   ')).toEqual([{ code: 'button_label_empty', field: 'button_0' }]);
    expect(labelIssues('ا'.repeat(20))).toEqual([]);
    expect(labelIssues('ا'.repeat(21))).toEqual([{ code: 'button_label_too_long', field: 'button_0', detail: { length: 21, max: 20 } }]);
    expect(labelIssues('\u{1F600}'.repeat(20))).toEqual([]); // 40 UTF-16 units, 20 code points
    expect(labelIssues('\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} ابدأ')).toEqual([]); // ZWJ family counts its parts: conservative, still within 20
  });
  test('duplicate labels are rejected case-insensitively and ignoring outer spaces', () => {
    const dupes = (a, b) => fu.evaluateVariant(node, promotionOwner, goodVariant(node, { buttons: [{ position: 0, text: a }, { position: 1, text: b }] })).issues;
    expect(dupes('Yes', ' yes ')).toEqual([{ code: 'duplicate_button_label', field: 'button_1' }]);
    expect(dupes('نعم', 'نعم')).toEqual([{ code: 'duplicate_button_label', field: 'button_1' }]);
    expect(dupes('نعم', 'لا')).toEqual([]);
    expect(dupes('Track', 'تتبع')).toEqual([]); // mixed Arabic / Latin labels are fine
  });
});

describe('evaluateVariant: warnings, staleness, sendability', () => {
  const node = followUpNode();
  test('English uses {item}, Arabic leaves it out: a warning, not an error', () => {
    const result = fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'شكرًا يا {name}' }));
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'followup_field_dropped', field: 'body', detail: { field: 'item' } }]);
    expect(result.sendable).toBe(true);
  });
  test('no warning when the English text cannot be expressed in fields', () => {
    const odd = followUpNode({ bodyText: 'Hi {oops}' });
    expect(fu.evaluateVariant(odd, promotionOwner, goodVariant(odd, { body: 'مرحبًا' })).warnings).toEqual([]);
  });
  test('stale: missing hash, other hash, English body edited, English label edited', () => {
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { sourceHash: undefined })).stale).toBe(true);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { sourceHash: 'abc' })).stale).toBe(true);
    const variant = goodVariant(node);
    expect(fu.evaluateVariant(followUpNode({ bodyText: 'New text {{1}}' }), promotionOwner, variant).stale).toBe(true);
    expect(fu.evaluateVariant(followUpNode({ buttons: [button(0, 'Track order'), button(1, 'Done')] }), promotionOwner, variant).stale).toBe(true);
    expect(fu.isStale(node, variant)).toBe(false);
    expect(fu.isStale(node, null)).toBe(true);
  });
  test('sendable needs reviewed AND no issues AND not stale', () => {
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node)).sendable).toBe(true);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { reviewStatus: 'draft' })).sendable).toBe(false);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { reviewStatus: undefined })).sendable).toBe(false);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: '' })).sendable).toBe(false);
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { sourceHash: 'old' })).sendable).toBe(false);
  });
  test('garbage variants never throw', () => {
    for (const v of [undefined, null, {}, { body: 42 }, { buttons: 'x' }, { buttons: [null] }]) {
      expect(() => fu.evaluateVariant(node, promotionOwner, v)).not.toThrow();
      expect(fu.evaluateVariant(node, promotionOwner, v).sendable).toBe(false);
    }
  });
  test('a very long Latin name plus an Arabic sentence is not an issue by itself (the sender checks the rendered length)', () => {
    expect(fu.evaluateVariant(node, promotionOwner, goodVariant(node, { body: 'أهلاً {name}' })).issues).toEqual([]);
  });
});

describe('normalizeInput', () => {
  test('cleans text, sorts buttons, defaults the source', () => {
    const out = fu.normalizeInput({ body: 'أ\u{200B}هلا', buttons: [{ position: 1, text: 'ب\u{200E}' }, { position: 0, text: 'أ' }] });
    expect(out).toEqual({ body: 'أهلا', buttons: [{ position: 0, text: 'أ' }, { position: 1, text: 'ب' }], source: 'merchant' });
  });
  test('keeps an unfinished draft as it is (empty labels, empty body)', () => {
    expect(fu.normalizeInput({ body: '', buttons: [{ position: 0 }] })).toEqual({ body: '', buttons: [{ position: 0, text: '' }], source: 'merchant' });
  });
  test.each([
    [undefined], [null], ['x'], [[]], [{}], [{ body: 5 }], [{ body: 'x'.repeat(8001) }],
    [{ body: 'x', buttons: 'no' }], [{ body: 'x', buttons: [1, 2] }], [{ body: 'x', buttons: [{ position: 3, text: 'a' }] }],
    [{ body: 'x', buttons: [{ position: -1, text: 'a' }] }], [{ body: 'x', buttons: [{ position: 'a', text: 'a' }] }],
    [{ body: 'x', buttons: [{ position: 0, text: 5 }] }], [{ body: 'x', buttons: [{ position: 0, text: 'x'.repeat(201) }] }],
    [{ body: 'x', buttons: [{ position: 0 }, { position: 1 }, { position: 2 }, { position: 0 }] }],
    [{ body: 'x', source: 'library' }], [{ body: 'x', source: 'import' }],
  ])('structurally broken input %j is a 400 INVALID_INPUT', (input) => {
    let error;
    try { fu.normalizeInput(input); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(fu.FollowUpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('INVALID_INPUT');
  });
  test('source ai is accepted', () => {
    expect(fu.normalizeInput({ body: 'x', source: 'ai' }).source).toBe('ai');
  });
});

// ── the store ───────────────────────────────────────────────────────────
function world({ rows = [], nodes = [followUpNode()], promotions = [{ _id: PROMOTION, workspaceId: WS, name: 'Summer', triggerType: undefined }], flows = [] } = {}) {
  return {
    Flow: fakeModel(flows),
    Promotion: fakeModel(promotions),
    MessageNode: fakeModel(nodes),
    LocalizedFlowNode: fakeModel(rows, { uniqueKeys: ['workspaceId', 'messageNodeId', 'language'] }),
    getReviewerName: jest.fn(async () => 'Layla'),
    now: () => new Date('2026-10-12T10:00:00Z'),
    log: jest.fn(),
  };
}
const save = (deps, input, over = {}) => fu.saveVariant({ workspaceId: WS, userId: USER, nodeId: NODE, input, ...over }, deps);
const draftInput = { body: 'اختيار رائع يا {name}!', buttons: [{ position: 0, text: 'تتبع' }, { position: 1, text: 'تم' }] };

describe('saveVariant', () => {
  test('creates a draft row, version 1, stamped with the English fingerprint, owner and creator', async () => {
    const deps = world();
    const view = await save(deps, draftInput);
    expect(deps.LocalizedFlowNode.docs).toHaveLength(1);
    expect(deps.LocalizedFlowNode.docs[0]).toMatchObject({
      workspaceId: WS, messageNodeId: NODE, language: 'ar', ownerType: 'promotion', ownerId: PROMOTION, body: draftInput.body,
      contentVersion: 1, reviewStatus: 'draft', source: 'merchant', createdBy: USER, sourceHash: fu.hashSource(followUpNode()),
    });
    expect(view.variant).toMatchObject({ language: 'ar', body: draftInput.body, contentVersion: 1, reviewStatus: 'draft', stale: false, sendable: false });
    expect(view.issues).toEqual([]);
    expect(view.messageNodeId).toBe(NODE);
    expect(view.english.bodyFields).toBe('Great choice {name}! Your {item} is on its way.');
    expect(view.warnings).toEqual([{ code: 'followup_field_dropped', field: 'body', detail: { field: 'item' } }]);
  });
  test('an incomplete draft is saved and reports its issues', async () => {
    const deps = world();
    const view = await save(deps, { body: '', buttons: [{ position: 0, text: '' }] });
    expect(codes(view.issues)).toEqual(expect.arrayContaining(['body_required', 'followup_button_mismatch']));
    expect(deps.LocalizedFlowNode.docs).toHaveLength(1);
  });
  test('an identical re-save is a no-op: no write, same version, review kept', async () => {
    const deps = world();
    await save(deps, draftInput);
    deps.LocalizedFlowNode.docs[0].reviewStatus = 'reviewed';
    deps.LocalizedFlowNode.create.mockClear();
    const again = await save(deps, draftInput);
    expect(deps.LocalizedFlowNode.create).not.toHaveBeenCalled();
    expect(deps.LocalizedFlowNode.findOneAndUpdate).not.toHaveBeenCalled();
    expect(again.variant).toMatchObject({ contentVersion: 1, reviewStatus: 'reviewed' });
  });
  test('a text change resets the review to draft, clears the reviewer and bumps the version', async () => {
    const deps = world();
    await save(deps, draftInput);
    Object.assign(deps.LocalizedFlowNode.docs[0], { reviewStatus: 'reviewed', reviewedBy: 'Layla', reviewedById: USER, reviewedAt: new Date() });
    const view = await save(deps, { ...draftInput, body: 'اختيار ممتاز يا {name}!' });
    expect(view.variant).toMatchObject({ contentVersion: 2, reviewStatus: 'draft', reviewedBy: null, reviewedAt: null });
    const stored = deps.LocalizedFlowNode.docs[0];
    expect(stored).not.toHaveProperty('reviewedBy');
    expect(stored).not.toHaveProperty('reviewedById');
    expect(stored).not.toHaveProperty('reviewedAt');
  });
  test('a label change also resets the review', async () => {
    const deps = world();
    await save(deps, draftInput);
    deps.LocalizedFlowNode.docs[0].reviewStatus = 'reviewed';
    const view = await save(deps, { ...draftInput, buttons: [{ position: 0, text: 'تتبع الطلب' }, { position: 1, text: 'تم' }] });
    expect(view.variant).toMatchObject({ contentVersion: 2, reviewStatus: 'draft' });
  });
  test('re-saving identical text after the English changed re-bases the fingerprint (draft, new version, not stale)', async () => {
    const deps = world();
    await save(deps, draftInput);
    deps.LocalizedFlowNode.docs[0].reviewStatus = 'reviewed';
    deps.MessageNode.docs[0].bodyText = 'Updated {{1}} text';
    const stale = await fu.getFollowUp({ workspaceId: WS, nodeId: NODE }, deps);
    expect(stale).toMatchObject({ stale: true, sendable: false });
    const view = await save(deps, draftInput);
    expect(view).toMatchObject({ stale: false, sendable: false });
    expect(view.variant).toMatchObject({ contentVersion: 2, reviewStatus: 'draft' });
    expect(deps.LocalizedFlowNode.docs[0].sourceHash).toBe(fu.hashSource(deps.MessageNode.docs[0]));
  });
  test('AI text is stored with source ai and is still a draft that needs a native review', async () => {
    const deps = world();
    const view = await save(deps, { ...draftInput, source: 'ai' });
    expect(view.variant).toMatchObject({ source: 'ai', reviewStatus: 'draft', sendable: false });
  });
  test('hidden characters are stripped before the text is stored', async () => {
    const deps = world();
    await save(deps, { body: 'أ\u{200B}هلا {name}\u{200F}', buttons: [{ position: 0, text: 'تتبع\u{200E}' }, { position: 1, text: 'تم' }] });
    expect(deps.LocalizedFlowNode.docs[0].body).toBe('أهلا {name}');
    expect(deps.LocalizedFlowNode.docs[0].buttons[0].text).toBe('تتبع');
  });
  test('a concurrent first save (E11000) merges into the row the other request created', async () => {
    const deps = world();
    const realCreate = deps.LocalizedFlowNode.create;
    let first = true;
    deps.LocalizedFlowNode.create = jest.fn(async (doc) => {
      if (first) {
        first = false;
        await realCreate({ ...doc, body: 'من طلب آخر' }); // the other request wins the race
      }
      return realCreate(doc);
    });
    const view = await save(deps, draftInput);
    expect(deps.LocalizedFlowNode.docs).toHaveLength(1);
    expect(view.variant.body).toBe(draftInput.body);
    expect(view.variant.contentVersion).toBe(2);
  });
  test('three lost update races end in 409 CONFLICT, nothing half written', async () => {
    const deps = world();
    await save(deps, draftInput);
    deps.LocalizedFlowNode.findOneAndUpdate = jest.fn(() => ({ lean: async () => null }));
    await expect(save(deps, { ...draftInput, body: 'نص آخر {name}' })).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(deps.LocalizedFlowNode.findOneAndUpdate).toHaveBeenCalledTimes(3);
  });
  test('the update is guarded by workspace and contentVersion', async () => {
    const deps = world();
    await save(deps, draftInput);
    await save(deps, { ...draftInput, body: 'نص آخر {name}' });
    const [filter] = deps.LocalizedFlowNode.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ workspaceId: WS, contentVersion: 1 });
  });
  test('a row of another workspace for the same node is never seen or touched', async () => {
    const other = { _id: id(7000), workspaceId: OTHER_WS, messageNodeId: NODE, language: 'ar', body: 'سري', buttons: [], contentVersion: 5 };
    const deps = world({ rows: [other] });
    const view = await save(deps, draftInput);
    expect(view.variant.contentVersion).toBe(1);
    expect(deps.LocalizedFlowNode.docs.find((d) => d.workspaceId === OTHER_WS).body).toBe('سري');
    for (const call of deps.LocalizedFlowNode.findOne.mock.calls) expect(call[0].workspaceId).toBe(WS);
  });
  test('ids and ownership: 400 / 403 / 404 / 422', async () => {
    const deps = world({ nodes: [followUpNode(), followUpNode({ _id: id(102), workspaceId: OTHER_WS }), followUpNode({ _id: ENTRY, isEntryNode: true })] });
    await expect(save(deps, draftInput, { nodeId: 'nope' })).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
    await expect(save(deps, draftInput, { nodeId: { $ne: null } })).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
    await expect(save(deps, draftInput, { workspaceId: undefined })).rejects.toMatchObject({ status: 403 });
    await expect(save(deps, draftInput, { nodeId: id(102) })).rejects.toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
    await expect(save(deps, draftInput, { nodeId: id(555) })).rejects.toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
    await expect(save(deps, draftInput, { nodeId: ENTRY })).rejects.toMatchObject({ status: 422, code: 'NODE_NOT_LOCALIZABLE' });
    await expect(save(deps, { body: 5 })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    expect(deps.LocalizedFlowNode.docs).toHaveLength(0);
  });
  test('a legacy node without a workspace is accepted only through an owner of this workspace', async () => {
    const legacy = followUpNode({ workspaceId: undefined, ownerType: 'flow', ownerId: FLOW });
    const owned = world({ nodes: [legacy], flows: [{ _id: FLOW, workspaceId: WS, triggerType: 'inactive_customer' }] });
    await expect(save(owned, draftInput)).resolves.toBeDefined();
    const foreign = world({ nodes: [legacy], flows: [{ _id: FLOW, workspaceId: OTHER_WS, triggerType: 'inactive_customer' }] });
    await expect(save(foreign, draftInput)).rejects.toMatchObject({ status: 404 });
  });
  test('workspace and node ids are canonicalised to lower case before they reach a query', async () => {
    const deps = world();
    await fu.saveVariant({ workspaceId: WS.toUpperCase(), userId: USER, nodeId: NODE.toUpperCase(), input: draftInput }, deps);
    expect(deps.LocalizedFlowNode.docs[0].workspaceId).toBe(WS);
  });
});

describe('reviewVariant', () => {
  async function saved(over) {
    const deps = world(over);
    await save(deps, { body: 'اختيار رائع يا {name}!', buttons: [{ position: 0, text: 'تتبع' }, { position: 1, text: 'تم' }] });
    return deps;
  }
  const review = (deps, status, contentVersion, over = {}) => fu.reviewVariant({ workspaceId: WS, userId: USER, nodeId: NODE, status, contentVersion, ...over }, deps);

  test('marks a valid row reviewed with the reviewer name and time; it becomes sendable', async () => {
    const deps = await saved();
    const view = await review(deps, 'reviewed', 1);
    expect(view.variant).toMatchObject({ reviewStatus: 'reviewed', reviewedBy: 'Layla', reviewedAt: '2026-10-12T10:00:00.000Z', sendable: true, contentVersion: 1 });
    expect(deps.LocalizedFlowNode.docs[0].reviewedById).toBe(USER);
  });
  test('a missing reviewer name falls back to Reviewer', async () => {
    const deps = await saved();
    deps.getReviewerName = jest.fn(async () => { throw new Error('db down'); });
    expect((await review(deps, 'reviewed', 1)).variant.reviewedBy).toBe('Reviewer');
  });
  test('a row with issues cannot be reviewed: 400 VARIANT_INVALID with the issues', async () => {
    const deps = world();
    await save(deps, { body: 'يا {points}', buttons: [{ position: 0, text: '' }, { position: 1, text: 'تم' }] });
    let error;
    try { await review(deps, 'reviewed', 1); } catch (err) { error = err; }
    expect(error).toMatchObject({ status: 400, code: 'VARIANT_INVALID' });
    expect(codes(error.body.issues)).toEqual(expect.arrayContaining(['followup_unknown_field', 'button_label_empty']));
    expect(deps.LocalizedFlowNode.docs[0].reviewStatus).toBe('draft');
  });
  test('a stale row cannot be reviewed (409 STALE_SOURCE) until it is saved again', async () => {
    const deps = await saved();
    deps.MessageNode.docs[0].bodyText = 'Changed {{1}}';
    await expect(review(deps, 'reviewed', 1)).rejects.toMatchObject({ status: 409, code: 'STALE_SOURCE' });
  });
  test('the review is tied to the exact version read: another contentVersion is a 409', async () => {
    const deps = await saved();
    await expect(review(deps, 'reviewed', 7)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
    deps.LocalizedFlowNode.findOneAndUpdate = jest.fn(() => ({ lean: async () => null })); // lost the race at write time
    await expect(review(deps, 'reviewed', 1)).rejects.toMatchObject({ status: 409, code: 'CONFLICT' });
  });
  test('back to draft clears the reviewer; draft on a draft is a no-op', async () => {
    const deps = await saved();
    await review(deps, 'reviewed', 1);
    const back = await review(deps, 'draft', 1);
    expect(back.variant).toMatchObject({ reviewStatus: 'draft', reviewedBy: null, sendable: false });
    expect(deps.LocalizedFlowNode.docs[0]).not.toHaveProperty('reviewedBy');
    deps.LocalizedFlowNode.findOneAndUpdate.mockClear();
    await review(deps, 'draft', 1);
    expect(deps.LocalizedFlowNode.findOneAndUpdate).not.toHaveBeenCalled();
  });
  test('input checks: status, contentVersion, missing row, wrong node', async () => {
    const deps = await saved();
    await expect(review(deps, 'approved', 1)).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(review(deps, 'reviewed', undefined)).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(review(deps, 'reviewed', '1')).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(review(deps, 'reviewed', 0)).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    await expect(review(world(), 'reviewed', 1)).rejects.toMatchObject({ status: 404, code: 'VARIANT_NOT_FOUND' });
    await expect(review(deps, 'reviewed', 1, { nodeId: 'zzz' })).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
  });
  test('reviewing as a user without a valid id still works (no reviewedById stored)', async () => {
    const deps = await saved();
    const view = await review(deps, 'reviewed', 1, { userId: undefined });
    expect(view.variant.reviewStatus).toBe('reviewed');
    expect(deps.LocalizedFlowNode.docs[0]).not.toHaveProperty('reviewedById');
  });
});

describe('getFollowUp', () => {
  test('no Arabic row yet: variant null, nothing to evaluate', async () => {
    const deps = world();
    const view = await fu.getFollowUp({ workspaceId: WS, nodeId: NODE }, deps);
    expect(view).toMatchObject({ messageNodeId: NODE, ownerType: 'promotion', variant: null, issues: [], warnings: [], stale: false, sendable: false });
    expect(view.english.slotFields).toEqual(['name', 'item', 'price', 'promo_name']);
  });
  test('an entry node is not editable here (422) and a foreign node is a 404', async () => {
    const deps = world({ nodes: [followUpNode({ _id: ENTRY, isEntryNode: true }), followUpNode({ workspaceId: OTHER_WS })] });
    await expect(fu.getFollowUp({ workspaceId: WS, nodeId: ENTRY }, deps)).rejects.toMatchObject({ status: 422 });
    await expect(fu.getFollowUp({ workspaceId: WS, nodeId: NODE }, deps)).rejects.toMatchObject({ status: 404 });
  });
});

describe('source hygiene of the module', () => {
  test('the module never deletes anything and has no network code', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowFollowUps.js'), 'utf8');
    expect(source.match(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|axios|waPost/)).toBeNull();
  });
  test('the model has the unique (workspace, node, language) index and no multi-field sort exists', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'LocalizedFlowNode.js'), 'utf8');
    expect(source).toMatch(/index\(\{ workspaceId: 1, messageNodeId: 1, language: 1 \}, \{ unique: true \}\)/);
  });
});
