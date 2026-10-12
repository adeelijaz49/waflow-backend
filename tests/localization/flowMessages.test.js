// Unit tests for the Automated Flows overlay service (shared/localization/flowMessages.js).
// Every collaborator is an in-memory fake that honours the query filters it is given, so
// tenant isolation is actually exercised (a query without the right workspaceId finds
// nothing) and no database, Meta or WhatsApp call is ever made.
const fs = require('fs');
const path = require('path');
const {
  PROMOTION_SLOT_FIELDS, slotFieldsFor, slotsToFields, buildSeedVariant, validateFlowButtons, loadOwnedNode,
  listFlowMessages, localizeMessage,
} = require('../../shared/localization/flowMessages');
const { validateVariant, LIMITS, charLength } = require('../../shared/localization/metaConstraints');
const catalog = require('../../shared/localization/catalog');

const id = (n) => String(n).padStart(24, '0');
const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const USER = id(900);

// ── fakes ────────────────────────────────────────────────────────────────
function matches(doc, filter) {
  return Object.entries(filter).every(([key, cond]) => {
    const actual = doc[key];
    if (cond && typeof cond === 'object' && '$in' in cond) return cond.$in.map(String).includes(String(actual));
    if (cond && typeof cond === 'object' && '$ne' in cond) return String(actual) !== String(cond.$ne);
    return actual !== undefined && String(actual) === String(cond);
  });
}

function chain(read) {
  let limit = Infinity;
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: (n) => { limit = n; return q; },
    lean: async () => read(limit),
  };
  return q;
}

function fakeModel(docs) {
  return {
    docs,
    find: jest.fn((filter) => chain((limit) => structuredClone(docs.filter((d) => matches(d, filter)).slice(0, limit)))),
    findOne: jest.fn((filter) => chain(() => { const hit = docs.find((d) => matches(d, filter)); return hit ? structuredClone(hit) : null; })),
  };
}

// The template collection also supports the writes flowMessages performs.
function fakeTemplateModel(docs) {
  const model = fakeModel(docs);
  model.findOneAndUpdate = jest.fn((filter, update) => chain(() => {
    const hit = docs.find((d) => matches(d, filter));
    if (!hit) return null;
    Object.assign(hit, update.$set);
    return structuredClone(hit);
  }));
  model.updateOne = jest.fn(async (filter, update) => {
    const hit = docs.find((d) => String(d._id) === String(filter._id) && String(d.workspaceId) === String(filter.workspaceId));
    const variant = hit && hit.variants.find((v) => v.language === filter['variants.language']);
    if (!variant) return { matchedCount: 0 };
    for (const [path_, value] of Object.entries(update.$set)) variant[path_.replace('variants.$.', '')] = value;
    return { matchedCount: 1 };
  });
  return model;
}

function templatesService(store, newId = id(500)) {
  return {
    createTemplate: jest.fn(async (args) => {
      const doc = {
        _id: newId, workspaceId: args.workspaceId, key: args.key, name: args.name, linkedMessageNodeId: args.linkedMessageNodeId,
        archived: false, createdAt: new Date(),
        variants: args.variants.map((v) => ({ ...v, metaStatus: 'NOT_CREATED', reviewStatus: 'draft' })),
      };
      store.templates.push(doc);
      return { id: newId, name: args.name, variants: doc.variants.map((v) => ({ language: v.language, metaStatus: v.metaStatus })) };
    }),
    toTemplateView: jest.fn(async (doc) => ({
      id: String(doc._id), name: doc.name, archived: !!doc.archived,
      variants: doc.variants.map((v) => ({ language: v.language, metaStatus: v.metaStatus, metaTemplateName: v.metaTemplateName || null })),
    })),
  };
}

const button = (position, label, type = 'end_flow') => ({ position, label, nextAction: { type } });
const promotionNode = (over = {}) => ({
  _id: id(100), workspaceId: WS, ownerType: 'promotion', ownerId: id(10), isEntryNode: true,
  bodyText: 'Hi {{1}}! Try {{2}} for {{3}} - {{4}}', templateName: 'waflow_flow_abc', templateStatus: 'approved',
  buttons: [button(0, 'Shop Now'), button(1, 'Not now')], ...over,
});
const flowNode = (over = {}) => ({
  _id: id(101), workspaceId: WS, ownerType: 'flow', ownerId: id(1), isEntryNode: true,
  bodyText: 'Hi {{1}}, you have {{2}} points', templateStatus: 'not_created', buttons: [button(0, 'Redeem')], ...over,
});
const flowDoc = (over = {}) => ({
  _id: id(1), workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: id(10),
  createdAt: new Date('2026-10-01T00:00:00Z'), ...over,
});
const promotionDoc = (over = {}) => ({ _id: id(10), workspaceId: WS, name: 'Summer Sale', entryNodeId: id(100), ...over });
const templateDoc = (over = {}) => ({
  _id: id(500), workspaceId: WS, key: 'k', name: 'Summer Sale', linkedMessageNodeId: id(100), archived: false, createdAt: new Date('2026-10-02T00:00:00Z'),
  variants: [{ language: 'en', metaStatus: 'NOT_CREATED', reviewStatus: 'draft' }], ...over,
});

function makeWorld(data = {}) {
  const store = {
    flows: data.flows || [], promotions: data.promotions || [], nodes: data.nodes || [], templates: data.templates || [],
  };
  const deps = {
    Flow: fakeModel(store.flows),
    Promotion: fakeModel(store.promotions),
    MessageNode: fakeModel(store.nodes),
    LocalizedTemplate: fakeTemplateModel(store.templates),
    templates: templatesService(store),
    log: jest.fn(),
  };
  return { store, deps };
}

const rejection = (promise) => promise.then(() => { throw new Error('expected a rejection'); }, (err) => err);

// ── slot maps ────────────────────────────────────────────────────────────
describe('slot maps', () => {
  test('promotion nodes: 1 name, 2 item, 3 price, 4 promo name', () => {
    expect(slotFieldsFor({ ownerType: 'promotion' })).toEqual(['name', 'item', 'price', 'promo_name']);
    // the trigger of a promotion-owned node is irrelevant
    expect(slotFieldsFor({ ownerType: 'promotion', triggerType: 'booking_no_show' })).toEqual(PROMOTION_SLOT_FIELDS);
  });

  test('flow nodes follow their trigger', () => {
    expect(slotFieldsFor({ ownerType: 'flow', triggerType: 'inactive_customer' })).toEqual(['name']);
    expect(slotFieldsFor({ ownerType: 'flow', triggerType: 'post_purchase_points' })).toEqual(['name', 'points']);
    expect(slotFieldsFor({ ownerType: 'flow', triggerType: 'points_balance_reminder' })).toEqual(['name', 'points']);
    expect(slotFieldsFor({ ownerType: 'flow', triggerType: 'booking_no_show' })).toEqual(['name', 'service']);
  });

  test.each([['points_threshold'], ['purchase_frequency'], ['nope'], [undefined], ['__proto__'], ['constructor'], ['toString']])(
    'trigger %s has no slots', (triggerType) => {
      expect(slotFieldsFor({ ownerType: 'flow', triggerType })).toEqual([]);
    },
  );

  test('the maps are frozen (nobody can mutate the shared constants)', () => {
    expect(() => { slotFieldsFor({ ownerType: 'promotion' }).push('x'); }).toThrow(TypeError);
    expect(() => { slotFieldsFor({ ownerType: 'flow', triggerType: 'inactive_customer' }).push('x'); }).toThrow(TypeError);
  });

  // The maps mirror shared/operations.js. Reading its source (never loading it) means a change to
  // the existing slot lists fails here instead of silently mis-mapping Arabic messages.
  describe('stay in sync with the existing flow engine', () => {
    const FIELD_OF = { customerName: 'name', pointsBalance: 'points', serviceName: 'service', itemName: 'item', priceOrPoints: 'price', promoName: 'promo_name' };
    const ops = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'operations.js'), 'utf8');
    const flowModel = fs.readFileSync(path.join(__dirname, '..', '..', 'models', 'Flow.js'), 'utf8');
    const orderedFields = (block) => [...block.matchAll(/key:\s*'(\w+)'[^}]*?slot:\s*(\d+)/g)]
      .map((m) => ({ key: m[1], slot: Number(m[2]) }))
      .sort((a, b) => a.slot - b.slot)
      .map((entry, index) => { expect(entry.slot).toBe(index + 1); return FIELD_OF[entry.key]; });

    test('PROMOTION_MESSAGE_VARIABLES', () => {
      const block = ops.match(/const PROMOTION_MESSAGE_VARIABLES = \[([\s\S]*?)\n\];/)[1];
      expect(orderedFields(block)).toEqual(PROMOTION_SLOT_FIELDS);
    });

    test('FLOW_MESSAGE_VARIABLES, for every trigger type the Flow model allows', () => {
      const block = ops.match(/const FLOW_MESSAGE_VARIABLES = \{([\s\S]*?)\n\};/)[1];
      const existing = {};
      for (const m of block.matchAll(/^\s*(\w+):\s*\[(.*)\],?\s*$/gm)) existing[m[1]] = orderedFields(m[2]);
      const triggers = [...flowModel.match(/triggerType:\s*\{[\s\S]*?enum:\s*\[([\s\S]*?)\]/)[1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
      expect(triggers.length).toBeGreaterThanOrEqual(6);
      for (const triggerType of triggers) {
        expect(slotFieldsFor({ ownerType: 'flow', triggerType })).toEqual(existing[triggerType] || []);
      }
    });
  });
});

describe('slotsToFields', () => {
  const FIELDS = ['name', 'item', 'price', 'promo_name'];

  test('converts every placeholder, keeping the rest of the text (formatting, emoji, Arabic) byte for byte', () => {
    expect(slotsToFields('Hi {{1}}! 🏷️ *{{2}}* is {{3}}\n\n{{4}}', FIELDS)).toEqual({ ok: true, text: 'Hi {name}! 🏷️ *{item}* is {price}\n\n{promo_name}' });
    expect(slotsToFields('مرحباً {{1}}، عرض {{4}}', FIELDS)).toEqual({ ok: true, text: 'مرحباً {name}، عرض {promo_name}' });
  });

  test('a slot used twice stays a field used twice', () => {
    expect(slotsToFields('{{1}} / {{1}}', FIELDS)).toEqual({ ok: true, text: '{name} / {name}' });
  });

  test('text without placeholders (or without any text) is fine', () => {
    expect(slotsToFields('Just text', FIELDS)).toEqual({ ok: true, text: 'Just text' });
    expect(slotsToFields('', FIELDS)).toEqual({ ok: true, text: '' });
    expect(slotsToFields(undefined, FIELDS)).toEqual({ ok: true, text: '' });
    expect(slotsToFields(42, FIELDS)).toEqual({ ok: true, text: '' });
  });

  test('a slot the flow does not fill is reported, not guessed', () => {
    expect(slotsToFields('Hi {{1}} {{5}}', FIELDS)).toEqual({ ok: false, reason: 'unknown_slot', slot: 5 });
    expect(slotsToFields('Hi {{2}}', ['name'])).toEqual({ ok: false, reason: 'unknown_slot', slot: 2 });
    expect(slotsToFields('Hi {{1}}', [])).toEqual({ ok: false, reason: 'unknown_slot', slot: 1 });
    expect(slotsToFields('{{99999999999999999999}}', FIELDS)).toEqual({ ok: false, reason: 'unknown_slot', slot: 1e20 });
  });

  test.each([['{{0}}'], ['{{01}}'], ['{{ 1 }}'], ['{{1}'], ['{1}'], ['{name}'], ['Hi {{1}} {name}'], ['}{'], ['{{a}}']])(
    'text with other braces (%j) cannot be represented and is reported', (text) => {
      expect(slotsToFields(text, FIELDS)).toEqual({ ok: false, reason: 'stray_braces' });
    },
  );
});

// ── seed variant ─────────────────────────────────────────────────────────
describe('buildSeedVariant', () => {
  const FIELDS = slotFieldsFor({ ownerType: 'promotion' });
  // Meta rejects a body that starts or ends with a variable (error 2388299). The shared promotionNode() body ends
  // with {{4}}, which is exactly what the tests of that rule (further down) need. The tests that validate the seed
  // for some OTHER reason (buttons, opt-out, linkage) use a node whose body ends with static text instead.
  const validNode = (over = {}) => promotionNode({ bodyText: 'Hi {{1}}! Try {{2}} for {{3}} - {{4}}. Tap a button below.', ...over });

  test('English variant: converted body, one flow_button per node button in order, opt-out while it fits', () => {
    const { ok, variant } = buildSeedVariant(promotionNode(), FIELDS);
    expect(ok).toBe(true);
    expect(variant).toEqual({
      language: 'en',
      body: 'Hi {name}! Try {item} for {price} - {promo_name}',
      footer: 'Reply STOP to unsubscribe',
      buttons: [
        { role: 'flow_button', text: 'Shop Now' },
        { role: 'flow_button', text: 'Not now' },
        { role: 'opt_out', text: 'Opt Out' },
      ],
      source: 'import',
    });
  });

  test.each([[0, 1], [1, 2], [2, 3]])('a node with %i buttons gets a seed with %i buttons (opt-out added)', (count, total) => {
    const buttons = Array.from({ length: count }, (_, i) => button(i, `B${i}`));
    const { variant } = buildSeedVariant(promotionNode({ buttons }), FIELDS);
    expect(variant.buttons).toHaveLength(total);
    expect(variant.buttons.at(-1)).toEqual({ role: 'opt_out', text: 'Opt Out' });
    expect(variant.buttons.slice(0, count).every((b) => b.role === 'flow_button')).toBe(true);
  });

  test('a node with 3 buttons gets NO auto opt-out (4th button would be collapsed by WhatsApp)', () => {
    const buttons = [button(0, 'A'), button(1, 'B'), button(2, 'C')];
    const { variant } = buildSeedVariant(promotionNode({ buttons }), FIELDS);
    expect(variant.buttons.map((b) => b.role)).toEqual(['flow_button', 'flow_button', 'flow_button']);
  });

  test('button order and labels are the node\'s array order, whatever the positions say', () => {
    const buttons = [button(2, 'Last'), button(0, 'First')];
    const { variant } = buildSeedVariant(promotionNode({ buttons }), FIELDS);
    expect(variant.buttons.slice(0, 2).map((b) => b.text)).toEqual(['Last', 'First']);
  });

  test('a body that cannot be converted is passed through as the failure', () => {
    expect(buildSeedVariant(promotionNode({ bodyText: 'x {{7}}' }), FIELDS)).toEqual({ ok: false, reason: 'unknown_slot', slot: 7 });
  });

  test('the seed is a valid message for a template linked to the node: no errors, labels within limits', () => {
    const { variant } = buildSeedVariant(validNode(), FIELDS);
    const result = validateVariant(variant, { category: 'MARKETING', linkedMessageNodeId: id(100) });
    expect(result.errors).toEqual([]);
    expect(result.positional.params).toEqual(['name', 'item', 'price', 'promo_name']);
    for (const b of variant.buttons) expect(charLength(b.text)).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
  });

  test('flow buttons are only valid on a template that is linked to a flow message', () => {
    const { variant } = buildSeedVariant(validNode(), FIELDS);
    const codes = validateVariant(variant, { category: 'MARKETING' }).errors.map((e) => e.code);
    expect(codes).toEqual(['flow_button_without_message_node', 'flow_button_without_message_node']);
  });

  test('a 3-button seed fails ONLY the marketing opt-out rule (the merchant adds the 4th button)', () => {
    const buttons = [button(0, 'A'), button(1, 'B'), button(2, 'C')];
    const { variant } = buildSeedVariant(validNode({ buttons }), FIELDS);
    const errors = validateVariant(variant, { category: 'MARKETING', linkedMessageNodeId: id(100) }).errors.map((e) => e.code);
    expect(errors).toEqual(['marketing_requires_opt_out_button']);
  });

  test('adding that 4th (opt-out) button to the 3-button seed makes it valid, with the collapsed-buttons warning', () => {
    const buttons = [button(0, 'A'), button(1, 'B'), button(2, 'C')];
    const { variant } = buildSeedVariant(validNode({ buttons }), FIELDS);
    const withOptOut = { ...variant, buttons: [...variant.buttons, { role: 'opt_out', text: 'Opt Out' }] };
    const result = validateVariant(withOptOut, { category: 'MARKETING', linkedMessageNodeId: id(100) });
    expect(result.errors).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toContain('buttons_collapsed');
  });

  // The seed is a faithful copy of the node's text (only {{n}} -> {field}). Meta rejects a body that starts or ends
  // with a variable (error 2388299), so a node written that way yields a seed that FAILS validation: the merchant has
  // to add words. Nothing here pads, trims or rewrites the node's text to make the error go away.
  describe('a node body that starts or ends with a variable', () => {
    const context = { category: 'MARKETING', linkedMessageNodeId: id(100) };
    const errorCodes = (variant) => validateVariant(variant, context).errors.map((e) => e.code);

    test('ends with a variable: the seed keeps the text and fails body_ends_with_variable until the merchant adds words', () => {
      const { ok, variant } = buildSeedVariant(promotionNode(), FIELDS); // 'Hi {{1}}! Try {{2}} for {{3}} - {{4}}'
      expect(ok).toBe(true);
      expect(variant.body).toBe('Hi {name}! Try {item} for {price} - {promo_name}'); // converted only: not padded, not rewritten
      expect(errorCodes(variant)).toEqual(['body_ends_with_variable']);
      expect(errorCodes({ ...variant, body: `${variant.body}. Tap a button below.` })).toEqual([]);
    });

    test('starts with a variable: the seed keeps the text and fails body_starts_with_variable until the merchant adds words', () => {
      const node = promotionNode({ bodyText: '{{1}}, try {{2}} for {{3}} - {{4}}. Tap a button below.' });
      const { ok, variant } = buildSeedVariant(node, FIELDS);
      expect(ok).toBe(true);
      expect(variant.body).toBe('{name}, try {item} for {price} - {promo_name}. Tap a button below.');
      expect(errorCodes(variant)).toEqual(['body_starts_with_variable']);
      expect(errorCodes({ ...variant, body: `Hello ${variant.body}` })).toEqual([]);
    });

    test('a body that is nothing but a variable fails both rules; trailing whitespace does not hide a trailing variable', () => {
      const only = buildSeedVariant(promotionNode({ bodyText: '{{1}}' }), FIELDS).variant;
      expect(only.body).toBe('{name}');
      expect(errorCodes(only)).toEqual(['body_starts_with_variable', 'body_ends_with_variable']);
      const padded = buildSeedVariant(promotionNode({ bodyText: 'Hi {{1}}, your offer: {{4}}\n' }), FIELDS).variant;
      expect(padded.body).toBe('Hi {name}, your offer: {promo_name}\n'); // the seed does not trim the node's text either
      expect(errorCodes(padded)).toEqual(['body_ends_with_variable']);
    });
  });

  test('the opt-out label is the shared catalogue label (and fits 20 characters)', () => {
    expect(catalog.t('en', 'consent.buttonOptOut')).toBe('Opt Out');
    expect(charLength(catalog.t('en', 'consent.buttonOptOut'))).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
  });

  test('what the seed produces satisfies the button lock it will later be held to', () => {
    const node = promotionNode({ buttons: [button(0, 'A'), button(1, 'B')] });
    const { variant } = buildSeedVariant(node, FIELDS);
    expect(validateFlowButtons({ linkedMessageNodeId: node._id }, { ...variant, language: 'ar' }, { nodeButtons: node.buttons })).toEqual([]);
  });
});

// ── button lock ──────────────────────────────────────────────────────────
describe('validateFlowButtons', () => {
  const linked = (buttons) => ({ linkedMessageNodeId: id(100), variants: [{ language: 'en', buttons }] });
  const flow = (text) => ({ role: 'flow_button', text });
  const optOut = { role: 'opt_out', text: 'إلغاء الاشتراك' };
  const NODE = [button(0, 'A'), button(1, 'B')];
  const codes = (issues) => issues.map((i) => i.code);

  test('templates that are not linked to a flow message are never constrained', () => {
    expect(validateFlowButtons({ variants: [] }, { language: 'ar', buttons: [] })).toEqual([]);
    expect(validateFlowButtons({ linkedMessageNodeId: null }, { language: 'ar', buttons: [{ role: 'url', text: 'x' }] })).toEqual([]);
    expect(validateFlowButtons(null, { language: 'ar' })).toEqual([]);
    expect(validateFlowButtons({ linkedMessageNodeId: id(1) }, null)).toEqual([]);
  });

  test('English variants mirror the node and are not constrained', () => {
    expect(validateFlowButtons(linked([flow('A')]), { language: 'en', buttons: [] }, { nodeButtons: NODE })).toEqual([]);
  });

  test('an exact match passes: same count, same order, trailing opt-out / url allowed', () => {
    const template = { linkedMessageNodeId: id(100) };
    for (const buttons of [
      [flow('أ'), flow('ب')],
      [flow('أ'), flow('ب'), optOut],
      [flow('أ'), flow('ب'), { role: 'url', text: 'الموقع', url: 'https://example.com' }],
      [flow('أ'), flow('ب'), optOut, { role: 'url', text: 'الموقع' }],
    ]) {
      expect(validateFlowButtons(template, { language: 'ar', buttons }, { nodeButtons: NODE })).toEqual([]);
      expect(validateFlowButtons(template, { language: 'bilingual', buttons }, { nodeButtons: NODE })).toEqual([]);
    }
  });

  test('without nodeButtons the template\'s English mirror is the reference', () => {
    const template = linked([flow('A'), flow('B'), { role: 'opt_out', text: 'Opt Out' }]);
    expect(validateFlowButtons(template, { language: 'ar', buttons: [flow('أ'), flow('ب'), optOut] })).toEqual([]);
    expect(codes(validateFlowButtons(template, { language: 'ar', buttons: [flow('أ'), optOut] }))).toEqual(['flow_button_mismatch', 'flow_button_mismatch']);
  });

  test('nodeButtons win over a stale English mirror', () => {
    const template = linked([flow('A')]); // mirror says 1 button, the node now has 2
    expect(validateFlowButtons(template, { language: 'ar', buttons: [flow('أ'), flow('ب')] }, { nodeButtons: NODE })).toEqual([]);
    expect(validateFlowButtons(template, { language: 'ar', buttons: [flow('أ')] }, { nodeButtons: NODE })).toHaveLength(1);
  });

  test('no reference at all (no node buttons, no English variant) means nothing to compare', () => {
    expect(validateFlowButtons({ linkedMessageNodeId: id(100), variants: [] }, { language: 'ar', buttons: [flow('x')] })).toEqual([]);
  });

  test('too few flow buttons: one count issue with expected/found', () => {
    const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [flow('أ')] }, { nodeButtons: NODE });
    expect(issues).toEqual([{ code: 'flow_button_mismatch', field: 'buttons', detail: { expected: 2, found: 1 } }]);
  });

  test('missing buttons entirely', () => {
    const template = { linkedMessageNodeId: id(100) };
    expect(validateFlowButtons(template, { language: 'ar' }, { nodeButtons: NODE })).toEqual([{ code: 'flow_button_mismatch', field: 'buttons', detail: { expected: 2, found: 0 } }]);
    expect(validateFlowButtons(template, { language: 'ar', buttons: 'nope' }, { nodeButtons: NODE })).toHaveLength(1);
  });

  test('too many flow buttons: count issue plus the offending position', () => {
    const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [flow('أ'), flow('ب'), flow('ج')] }, { nodeButtons: NODE });
    expect(issues).toEqual([
      { code: 'flow_button_mismatch', field: 'buttons', detail: { expected: 2, found: 3 } },
      { code: 'flow_button_mismatch', field: 'buttons.2', detail: { expected: 2, found: 3, position: 2 } },
    ]);
  });

  test('the first N buttons must be the flow buttons (order is locked: the payload is positional)', () => {
    // opt-out sits where flow button 0 must be, and a third flow button follows the allowed ones
    const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [optOut, flow('أ'), flow('ب')] }, { nodeButtons: NODE });
    expect(issues.map((i) => i.field)).toEqual(['buttons.0', 'buttons.2']);
    // a swapped pair of roles is caught even though the COUNT is right
    const swapped = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [flow('أ'), optOut, flow('ب')] }, { nodeButtons: NODE });
    expect(swapped.map((i) => i.field)).toEqual(['buttons.1', 'buttons.2']);
  });

  test('roles that make no sense on a flow message are rejected after the flow buttons', () => {
    for (const role of ['opt_in', 'decline', 'custom', 'nonsense', undefined]) {
      const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [flow('أ'), flow('ب'), { role, text: 'x' }] }, { nodeButtons: NODE });
      expect(issues).toEqual([{ code: 'flow_button_mismatch', field: 'buttons.2', detail: { expected: 2, found: 2, position: 2 } }]);
    }
  });

  test('a node with no buttons: only opt-out / url allowed', () => {
    const template = { linkedMessageNodeId: id(100) };
    expect(validateFlowButtons(template, { language: 'ar', buttons: [optOut] }, { nodeButtons: [] })).toEqual([]);
    expect(validateFlowButtons(template, { language: 'ar', buttons: [] }, { nodeButtons: [] })).toEqual([]);
    expect(codes(validateFlowButtons(template, { language: 'ar', buttons: [flow('x')] }, { nodeButtons: [] }))).toEqual(['flow_button_mismatch', 'flow_button_mismatch']);
  });

  test('null entries inside the list do not crash the check', () => {
    const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [null, flow('أ')] }, { nodeButtons: NODE });
    expect(issues.length).toBeGreaterThan(0);
  });

  test('issue details are string/number only (the ValidationIssue contract)', () => {
    const issues = validateFlowButtons({ linkedMessageNodeId: id(100) }, { language: 'ar', buttons: [optOut] }, { nodeButtons: NODE });
    for (const issue of issues) {
      expect(issue.code).toBe('flow_button_mismatch');
      for (const value of Object.values(issue.detail)) expect(typeof value).toBe('number');
    }
  });
});

// ── ownership ────────────────────────────────────────────────────────────
describe('loadOwnedNode', () => {
  test('a node with our workspace id is ours; its owner is looked up inside the workspace only', async () => {
    const { deps } = makeWorld({ nodes: [promotionNode()], promotions: [promotionDoc()] });
    const owned = await loadOwnedNode(deps, WS, id(100));
    expect(owned.owner).toMatchObject({ kind: 'promotion', name: 'Summer Sale' });
    expect(deps.Promotion.findOne).toHaveBeenCalledWith({ _id: id(10), workspaceId: WS });
  });

  test('a node carrying another workspace id is not ours, whatever its owner says', async () => {
    const { deps } = makeWorld({ nodes: [promotionNode({ workspaceId: OTHER_WS })], promotions: [promotionDoc()] });
    expect(await loadOwnedNode(deps, WS, id(100))).toBeNull();
    expect(deps.Promotion.findOne).not.toHaveBeenCalled();
  });

  test('a legacy node (no workspace id) is ours only when its owner is in our workspace', async () => {
    const ours = makeWorld({ nodes: [flowNode({ workspaceId: undefined })], flows: [flowDoc()] });
    expect((await loadOwnedNode(ours.deps, WS, id(101))).owner).toMatchObject({ kind: 'flow' });
    const theirs = makeWorld({ nodes: [flowNode({ workspaceId: undefined })], flows: [flowDoc({ workspaceId: OTHER_WS })] });
    expect(await loadOwnedNode(theirs.deps, WS, id(101))).toBeNull();
    const orphan = makeWorld({ nodes: [flowNode({ workspaceId: undefined })] });
    expect(await loadOwnedNode(orphan.deps, WS, id(101))).toBeNull();
  });

  test('our node whose declared owner is missing or foreign is still ours, with no owner', async () => {
    const foreignOwner = makeWorld({ nodes: [promotionNode()], promotions: [promotionDoc({ workspaceId: OTHER_WS })] });
    expect(await loadOwnedNode(foreignOwner.deps, WS, id(100))).toMatchObject({ owner: null });
    const none = makeWorld({ nodes: [promotionNode({ ownerId: undefined })] });
    expect(await loadOwnedNode(none.deps, WS, id(100))).toMatchObject({ owner: null });
  });

  test('unknown node', async () => {
    const { deps } = makeWorld();
    expect(await loadOwnedNode(deps, WS, id(404))).toBeNull();
  });
});

// ── GET /flows/messages ──────────────────────────────────────────────────
describe('listFlowMessages', () => {
  const world = () => makeWorld({
    flows: [flowDoc()],
    promotions: [promotionDoc()],
    nodes: [promotionNode()],
    templates: [templateDoc({
      variants: [
        { language: 'en', metaStatus: 'NOT_CREATED', reviewStatus: 'draft' },
        { language: 'ar', metaStatus: 'PENDING', reviewStatus: 'reviewed' },
      ],
    })],
  });

  test('joins flow -> promotion -> entry node -> linked template into one row', async () => {
    const { deps } = world();
    expect(await listFlowMessages({ workspaceId: WS }, deps)).toEqual({
      items: [{
        flowId: id(1), flowName: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: id(10),
        nodes: [{
          messageNodeId: id(100),
          bodyText: 'Hi {{1}}! Try {{2}} for {{3}} - {{4}}',
          buttons: [{ position: 0, label: 'Shop Now' }, { position: 1, label: 'Not now' }],
          templateStatus: 'approved',
          localizedTemplateId: id(500),
          variantStatus: [
            { language: 'en', metaStatus: 'APPROVED', reviewStatus: 'draft' }, // English is the node's own status, not the mirror's
            { language: 'ar', metaStatus: 'PENDING', reviewStatus: 'reviewed' },
          ],
        }],
      }],
    });
  });

  test('never leaks anything beyond the contract fields (no nextAction, ids of other records, workspace ids)', async () => {
    const { deps } = world();
    const json = JSON.stringify(await listFlowMessages({ workspaceId: WS }, deps));
    expect(json).not.toContain('nextAction');
    expect(json).not.toContain(WS);
    expect(json).not.toContain('waflow_flow_abc');
  });

  test('four bulk queries however many flows there are: no N+1', async () => {
    const flows = Array.from({ length: 12 }, (_, i) => flowDoc({ _id: id(200 + i), promotionId: id(300 + i), name: `Flow ${i}` }));
    const promotions = flows.map((f, i) => promotionDoc({ _id: id(300 + i), entryNodeId: id(400 + i) }));
    const nodes = flows.map((f, i) => promotionNode({ _id: id(400 + i), ownerId: id(300 + i) }));
    const templates = flows.map((f, i) => templateDoc({ _id: id(600 + i), linkedMessageNodeId: id(400 + i) }));
    const { deps } = makeWorld({ flows, promotions, nodes, templates });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items).toHaveLength(12);
    expect(items.every((row) => row.nodes.length === 1 && row.nodes[0].localizedTemplateId)).toBe(true);
    expect(deps.Flow.find).toHaveBeenCalledTimes(1);
    expect(deps.Promotion.find).toHaveBeenCalledTimes(1);
    expect(deps.MessageNode.find).toHaveBeenCalledTimes(1);
    expect(deps.LocalizedTemplate.find).toHaveBeenCalledTimes(1);
    for (const model of [deps.Flow, deps.Promotion, deps.MessageNode, deps.LocalizedTemplate]) expect(model.findOne).not.toHaveBeenCalled();
  });

  test('every workspace-owned collection is queried with the workspace id', async () => {
    const { deps } = world();
    await listFlowMessages({ workspaceId: WS }, deps);
    expect(deps.Flow.find).toHaveBeenCalledWith({ workspaceId: WS });
    expect(deps.Promotion.find).toHaveBeenCalledWith({ _id: { $in: [id(10)] }, workspaceId: WS });
    expect(deps.LocalizedTemplate.find).toHaveBeenCalledWith({ workspaceId: WS, linkedMessageNodeId: { $in: [id(100)] }, archived: { $ne: true } });
  });

  test('other workspaces\' flows, promotions, nodes and templates never show up', async () => {
    const { deps } = makeWorld({
      flows: [
        flowDoc(),
        flowDoc({ _id: id(2), workspaceId: OTHER_WS, name: 'Theirs', promotionId: id(11) }),
        flowDoc({ _id: id(3), name: 'No workspace', workspaceId: undefined }),
      ],
      promotions: [promotionDoc(), promotionDoc({ _id: id(11), workspaceId: OTHER_WS, entryNodeId: id(110) })],
      nodes: [promotionNode(), promotionNode({ _id: id(110), workspaceId: OTHER_WS })],
      templates: [templateDoc(), templateDoc({ _id: id(501), workspaceId: OTHER_WS, linkedMessageNodeId: id(110) })],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items.map((r) => r.flowName)).toEqual(['Win-back']);
  });

  test('a flow pointing at ANOTHER workspace\'s promotion or node gets no nodes', async () => {
    const { deps } = makeWorld({
      flows: [
        flowDoc({ _id: id(1), promotionId: id(11) }),
        flowDoc({ _id: id(2), promotionId: undefined, entryNodeId: id(110), name: 'Legacy' }),
      ],
      promotions: [promotionDoc({ _id: id(11), workspaceId: OTHER_WS, entryNodeId: id(110) })],
      nodes: [promotionNode({ _id: id(110), workspaceId: OTHER_WS })],
      templates: [templateDoc({ workspaceId: OTHER_WS, linkedMessageNodeId: id(110) })],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items).toHaveLength(2);
    expect(items.map((r) => r.nodes)).toEqual([[], []]);
  });

  test('another workspace\'s template linked to our node is ignored (templates are filtered by workspace)', async () => {
    const { deps } = makeWorld({
      flows: [flowDoc()], promotions: [promotionDoc()], nodes: [promotionNode()],
      templates: [templateDoc({ _id: id(501), workspaceId: OTHER_WS })],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].nodes[0].localizedTemplateId).toBeNull();
  });

  test('flows without an entry message are still listed, with no nodes', async () => {
    const { deps } = makeWorld({
      flows: [
        flowDoc({ _id: id(1), name: 'Built-in', promotionId: undefined }), // fixed default template
        flowDoc({ _id: id(2), name: 'Promo without message', promotionId: id(12) }),
        flowDoc({ _id: id(3), name: 'Missing node', promotionId: undefined, entryNodeId: id(404) }),
        flowDoc({ _id: id(4), name: 'Not an entry node', promotionId: undefined, entryNodeId: id(103) }),
      ],
      promotions: [promotionDoc({ _id: id(12), entryNodeId: undefined })],
      nodes: [flowNode({ _id: id(103), isEntryNode: false })],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items).toHaveLength(4);
    expect(items.every((row) => row.nodes.length === 0)).toBe(true);
  });

  test('legacy flow.entryNodeId is resolved when the flow has no promotion', async () => {
    const { deps } = makeWorld({
      flows: [flowDoc({ promotionId: undefined, entryNodeId: id(101), triggerType: 'post_purchase_points' })],
      nodes: [flowNode()],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].promotionId).toBeNull();
    expect(items[0].nodes.map((n) => n.messageNodeId)).toEqual([id(101)]);
    expect(deps.Promotion.find).not.toHaveBeenCalled();
  });

  test('like the engine, a flow with a promotion uses ONLY the promotion\'s message (no fallback to its own entryNodeId)', async () => {
    const { deps } = makeWorld({
      flows: [flowDoc({ entryNodeId: id(101) })],
      promotions: [promotionDoc({ entryNodeId: undefined })],
      nodes: [flowNode()],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].nodes).toEqual([]);
  });

  test('a node without a linked template: no template id, English status taken from the node', async () => {
    const { deps } = makeWorld({ flows: [flowDoc()], promotions: [promotionDoc()], nodes: [promotionNode({ templateStatus: 'pending' })] });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].nodes[0]).toMatchObject({
      localizedTemplateId: null, templateStatus: 'pending', variantStatus: [{ language: 'en', metaStatus: 'PENDING', reviewStatus: 'draft' }],
    });
  });

  test.each([['not_created', 'NOT_CREATED'], ['pending', 'PENDING'], ['approved', 'APPROVED'], ['rejected', 'REJECTED'], ['weird', 'NOT_CREATED'], [undefined, 'NOT_CREATED']])(
    'node status %s is English %s', async (templateStatus, metaStatus) => {
      const { deps } = makeWorld({ flows: [flowDoc()], promotions: [promotionDoc()], nodes: [promotionNode({ templateStatus })] });
      const { items } = await listFlowMessages({ workspaceId: WS }, deps);
      expect(items[0].nodes[0].variantStatus[0]).toMatchObject({ language: 'en', metaStatus });
      expect(['not_created', 'pending', 'approved', 'rejected']).toContain(items[0].nodes[0].templateStatus);
    },
  );

  test('variant statuses come out in the fixed order en, ar, bilingual; unknown languages are ignored', async () => {
    const { deps } = makeWorld({
      flows: [flowDoc()], promotions: [promotionDoc()], nodes: [promotionNode()],
      templates: [templateDoc({
        variants: [
          { language: 'bilingual', metaStatus: 'REJECTED', reviewStatus: 'reviewed' },
          { language: 'fr', metaStatus: 'APPROVED', reviewStatus: 'reviewed' },
          { language: 'ar', metaStatus: 'APPROVED', reviewStatus: 'weird' },
          { language: 'en', metaStatus: 'NOT_CREATED', reviewStatus: 'reviewed' },
        ],
      })],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].nodes[0].variantStatus).toEqual([
      { language: 'en', metaStatus: 'APPROVED', reviewStatus: 'reviewed' },
      { language: 'ar', metaStatus: 'APPROVED', reviewStatus: 'draft' },
      { language: 'bilingual', metaStatus: 'REJECTED', reviewStatus: 'reviewed' },
    ]);
  });

  test('archived templates are ignored; with several live ones the oldest wins', async () => {
    const { deps } = makeWorld({
      flows: [flowDoc()], promotions: [promotionDoc()], nodes: [promotionNode()],
      templates: [
        templateDoc({ _id: id(503), variants: [{ language: 'ar', metaStatus: 'APPROVED', reviewStatus: 'reviewed' }] }),
        templateDoc({ _id: id(501), archived: true }),
        templateDoc({ _id: id(502), variants: [{ language: 'ar', metaStatus: 'REJECTED', reviewStatus: 'draft' }] }),
      ],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0].nodes[0].localizedTemplateId).toBe(id(502));
    expect(items[0].nodes[0].variantStatus[1]).toMatchObject({ language: 'ar', metaStatus: 'REJECTED' });
  });

  test('newest flow first, like the existing Flows page', async () => {
    const { deps } = makeWorld({
      flows: [
        flowDoc({ _id: id(1), name: 'old', createdAt: new Date('2026-01-01'), promotionId: undefined }),
        flowDoc({ _id: id(2), name: 'new', createdAt: new Date('2026-06-01'), promotionId: undefined }),
        flowDoc({ _id: id(3), name: 'mid', createdAt: new Date('2026-03-01'), promotionId: undefined }),
      ],
    });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items.map((r) => r.flowName)).toEqual(['new', 'mid', 'old']);
  });

  test('status other than active is reported as paused; promotionId is null when absent', async () => {
    const { deps } = makeWorld({ flows: [flowDoc({ status: undefined, promotionId: undefined })] });
    const { items } = await listFlowMessages({ workspaceId: WS }, deps);
    expect(items[0]).toMatchObject({ status: 'paused', promotionId: null });
  });

  test('a workspace with no flows gets an empty list and nothing else is queried', async () => {
    const { deps } = makeWorld();
    expect(await listFlowMessages({ workspaceId: WS }, deps)).toEqual({ items: [] });
    expect(deps.Promotion.find).not.toHaveBeenCalled();
    expect(deps.MessageNode.find).not.toHaveBeenCalled();
    expect(deps.LocalizedTemplate.find).not.toHaveBeenCalled();
  });

  test('the flow list is capped (a runaway workspace cannot make one response unbounded)', async () => {
    const flows = Array.from({ length: 650 }, (_, i) => flowDoc({ _id: id(1000 + i), promotionId: undefined }));
    const { deps } = makeWorld({ flows });
    expect((await listFlowMessages({ workspaceId: WS }, deps)).items).toHaveLength(500);
  });

  test.each([[undefined], [null], [''], ['nope'], [{ $ne: null }], [['x']], [42]])('workspace %j is refused before any query', async (workspaceId) => {
    const { deps } = world();
    const err = await rejection(listFlowMessages({ workspaceId }, deps));
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(deps.Flow.find).not.toHaveBeenCalled();
  });
});

// ── POST /flows/messages/:id/localize ────────────────────────────────────
describe('localizeMessage', () => {
  const args = (over = {}) => ({ workspaceId: WS, userId: USER, messageNodeId: id(100), ...over });
  const promoWorld = (over = {}) => makeWorld({ nodes: [promotionNode()], promotions: [promotionDoc()], ...over });

  test('creates a linked template seeded from a promotion message', async () => {
    const { deps } = promoWorld();
    const res = await localizeMessage(args(), deps);
    expect(res.created).toBe(true);
    expect(deps.templates.createTemplate).toHaveBeenCalledTimes(1);
    expect(deps.templates.createTemplate).toHaveBeenCalledWith({
      workspaceId: WS,
      userId: USER,
      name: 'Summer Sale',
      key: `flow_message_${id(100)}`,
      useCase: 'custom',
      category: 'MARKETING',
      linkedMessageNodeId: id(100),
      variants: [{
        language: 'en',
        body: 'Hi {name}! Try {item} for {price} - {promo_name}',
        footer: 'Reply STOP to unsubscribe',
        buttons: [{ role: 'flow_button', text: 'Shop Now' }, { role: 'flow_button', text: 'Not now' }, { role: 'opt_out', text: 'Opt Out' }],
        source: 'import',
      }],
    });
    expect(res.template).toMatchObject({ id: id(500), name: 'Summer Sale' });
  });

  test('no Arabic variant is pre-created (the merchant adds it in the editor)', async () => {
    const { deps } = promoWorld();
    await localizeMessage(args(), deps);
    const [{ variants }] = deps.templates.createTemplate.mock.calls[0];
    expect(variants.map((v) => v.language)).toEqual(['en']);
  });

  test.each([
    ['post_purchase_points', 'Hi {{1}}, you have {{2}} points', 'Hi {name}, you have {points} points'],
    ['points_balance_reminder', '{{2}} points, {{1}}!', '{points} points, {name}!'],
    ['booking_no_show', 'We missed you {{1}} at {{2}}', 'We missed you {name} at {service}'],
    ['inactive_customer', 'We miss you {{1}}', 'We miss you {name}'],
  ])('a legacy flow message under %s maps its slots (%s)', async (triggerType, bodyText, expected) => {
    const { deps } = makeWorld({ nodes: [flowNode({ bodyText })], flows: [flowDoc({ triggerType })] });
    await localizeMessage(args({ messageNodeId: id(101) }), deps);
    expect(deps.templates.createTemplate.mock.calls[0][0].variants[0].body).toBe(expected);
    expect(deps.templates.createTemplate.mock.calls[0][0].name).toBe('Win-back');
  });

  test('a slot this flow type cannot fill makes the message not localizable', async () => {
    const { deps } = makeWorld({ nodes: [flowNode({ bodyText: 'Hi {{1}}, {{2}}' })], flows: [flowDoc({ triggerType: 'inactive_customer' })] });
    const err = await rejection(localizeMessage(args({ messageNodeId: id(101) }), deps));
    expect(err).toMatchObject({ status: 422, code: 'NODE_NOT_LOCALIZABLE' });
    expect(err.message).toContain('{{2}}');
    expect(deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('braces that are not placeholders make it not localizable', async () => {
    const { deps } = promoWorld({ nodes: [promotionNode({ bodyText: 'Hi {name}, {{2}}' })] });
    const err = await rejection(localizeMessage(args(), deps));
    expect(err).toMatchObject({ status: 422, code: 'NODE_NOT_LOCALIZABLE' });
    expect(deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('is idempotent: the second call returns the existing template and creates nothing', async () => {
    const world = promoWorld();
    const first = await localizeMessage(args(), world.deps);
    const second = await localizeMessage(args(), world.deps);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.template).toMatchObject({ id: id(500) });
    expect(world.deps.templates.createTemplate).toHaveBeenCalledTimes(1);
    expect(world.store.templates).toHaveLength(1);
  });

  test('an existing template is returned even when its node later became unusable for seeding', async () => {
    const { deps } = promoWorld({ nodes: [promotionNode({ bodyText: 'now {{9}} is broken' })], templates: [templateDoc()] });
    const res = await localizeMessage(args(), deps);
    expect(res).toMatchObject({ created: false, template: { id: id(500) } });
    expect(deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('a template that was archived is restored instead of forking a second one', async () => {
    const world = promoWorld({ templates: [templateDoc({ archived: true })] });
    const res = await localizeMessage(args(), world.deps);
    expect(res).toMatchObject({ created: false, template: { id: id(500), archived: false } });
    expect(world.deps.LocalizedTemplate.findOneAndUpdate).toHaveBeenCalledWith({ _id: id(500), workspaceId: WS }, { $set: { archived: false } }, { returnDocument: 'after' });
    expect(world.deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('a live template is preferred over archived ones and nothing is restored', async () => {
    const world = promoWorld({ templates: [templateDoc({ _id: id(501), archived: true }), templateDoc({ _id: id(502) })] });
    const res = await localizeMessage(args(), world.deps);
    expect(res.template.id).toBe(id(502));
    expect(world.deps.LocalizedTemplate.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('another workspace\'s template for the same node does not count as existing', async () => {
    const world = promoWorld({ templates: [templateDoc({ workspaceId: OTHER_WS })] });
    expect((await localizeMessage(args(), world.deps)).created).toBe(true);
  });

  test('follow-up (non-entry) messages cannot be localized', async () => {
    const { deps } = promoWorld({ nodes: [promotionNode({ isEntryNode: false })] });
    const err = await rejection(localizeMessage(args(), deps));
    expect(err).toMatchObject({ status: 422, code: 'NODE_NOT_LOCALIZABLE' });
    expect(deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('another workspace\'s node is indistinguishable from a missing one (404)', async () => {
    const foreign = promoWorld({ nodes: [promotionNode({ workspaceId: OTHER_WS })] });
    expect(await rejection(localizeMessage(args(), foreign.deps))).toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
    const missing = makeWorld();
    expect(await rejection(localizeMessage(args(), missing.deps))).toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
    expect(foreign.deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test('a legacy node (no workspace id) is localizable only through an owner in this workspace', async () => {
    const ok = makeWorld({ nodes: [flowNode({ workspaceId: undefined, bodyText: 'Hi {{1}}' })], flows: [flowDoc({ triggerType: 'inactive_customer' })] });
    expect((await localizeMessage(args({ messageNodeId: id(101) }), ok.deps)).created).toBe(true);
    const foreign = makeWorld({ nodes: [flowNode({ workspaceId: undefined })], flows: [flowDoc({ workspaceId: OTHER_WS })] });
    expect(await rejection(localizeMessage(args({ messageNodeId: id(101) }), foreign.deps))).toMatchObject({ status: 404, code: 'NODE_NOT_FOUND' });
  });

  test('our node attached to no flow/promotion of ours is not localizable (a client-supplied ownerId is never trusted)', async () => {
    const { deps } = promoWorld({ promotions: [promotionDoc({ workspaceId: OTHER_WS })] });
    expect(await rejection(localizeMessage(args(), deps))).toMatchObject({ status: 422, code: 'NODE_NOT_LOCALIZABLE' });
    expect(deps.templates.createTemplate).not.toHaveBeenCalled();
  });

  test.each([['not-an-id'], [''], [undefined], [null], [{ $ne: null }], [['a']], [123], ['0'.repeat(23)], ['g'.repeat(24)]])('node id %j is rejected as INVALID_ID before any query', async (messageNodeId) => {
    const { deps } = promoWorld();
    expect(await rejection(localizeMessage(args({ messageNodeId }), deps))).toMatchObject({ status: 400, code: 'INVALID_ID' });
    expect(deps.MessageNode.findOne).not.toHaveBeenCalled();
  });

  test('a missing workspace is refused (403) before any query', async () => {
    const { deps } = promoWorld();
    expect(await rejection(localizeMessage(args({ workspaceId: undefined }), deps))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await rejection(localizeMessage(args({ workspaceId: { $ne: null } }), deps))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(deps.MessageNode.findOne).not.toHaveBeenCalled();
  });

  test('two simultaneous requests share one creation (double click)', async () => {
    const world = promoWorld();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const originalCreate = world.deps.templates.createTemplate.getMockImplementation();
    world.deps.templates.createTemplate.mockImplementation(async (a) => { await gate; return originalCreate(a); });
    const a = localizeMessage(args(), world.deps);
    const b = localizeMessage(args(), world.deps);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(world.deps.templates.createTemplate).toHaveBeenCalledTimes(1);
    expect(ra.template).toEqual(rb.template);
    expect([ra.created, rb.created].sort()).toEqual([false, true]);
    // and the lock is released afterwards
    expect((await localizeMessage(args(), world.deps)).created).toBe(false);
  });

  test('requests for different nodes (or workspaces) do not share a run', async () => {
    const world = makeWorld({
      nodes: [promotionNode(), promotionNode({ _id: id(102), ownerId: id(11) })],
      promotions: [promotionDoc(), promotionDoc({ _id: id(11), entryNodeId: id(102), name: 'Eid' })],
    });
    const [a, b] = await Promise.all([localizeMessage(args(), world.deps), localizeMessage(args({ messageNodeId: id(102) }), world.deps)]);
    expect(world.deps.templates.createTemplate).toHaveBeenCalledTimes(2);
    expect([a.created, b.created]).toEqual([true, true]);
  });

  test('losing a creation race on the node\'s unique key returns the winner\'s template', async () => {
    const world = promoWorld();
    world.deps.templates.createTemplate.mockImplementation(async () => {
      world.store.templates.push(templateDoc({ _id: id(777) })); // the other request got there first
      const err = new Error('key taken');
      err.status = 409;
      err.code = 'TEMPLATE_KEY_TAKEN';
      throw err;
    });
    const res = await localizeMessage(args(), world.deps);
    expect(res).toMatchObject({ created: false, template: { id: id(777) } });
  });

  test('a Mongo duplicate-key error is treated the same way; without a winner the error surfaces', async () => {
    const dup = Object.assign(new Error('E11000'), { code: 11000 });
    const noWinner = promoWorld();
    noWinner.deps.templates.createTemplate.mockRejectedValue(dup);
    expect(await rejection(localizeMessage(args(), noWinner.deps))).toBe(dup);
  });

  test('other creation errors propagate unchanged, and the next call can try again', async () => {
    const world = promoWorld();
    const boom = Object.assign(new Error('invalid'), { status: 400, code: 'VARIANT_INVALID' });
    world.deps.templates.createTemplate.mockRejectedValueOnce(boom);
    expect(await rejection(localizeMessage(args(), world.deps))).toBe(boom);
    expect((await localizeMessage(args(), world.deps)).created).toBe(true);
  });

  describe('the English variant mirrors the existing English template', () => {
    test.each([['approved', 'APPROVED'], ['pending', 'PENDING'], ['rejected', 'REJECTED']])('node %s -> variant %s with the node\'s Meta name', async (templateStatus, metaStatus) => {
      const world = promoWorld({ nodes: [promotionNode({ templateStatus, templateName: 'waflow_flow_abc_x1' })] });
      const res = await localizeMessage(args(), world.deps);
      expect(world.deps.LocalizedTemplate.updateOne).toHaveBeenCalledWith(
        { _id: id(500), workspaceId: WS, 'variants.language': 'en' },
        { $set: { 'variants.$.metaStatus': metaStatus, 'variants.$.metaLanguage': 'en', 'variants.$.submissionCount': 1, 'variants.$.metaTemplateName': 'waflow_flow_abc_x1' } },
      );
      // the response shows the mirrored state, not the pre-mirror one
      expect(res.template.variants).toEqual([{ language: 'en', metaStatus, metaTemplateName: 'waflow_flow_abc_x1' }]);
    });

    test('a node that was never submitted has nothing to mirror', async () => {
      const world = promoWorld({ nodes: [promotionNode({ templateStatus: 'not_created', templateName: undefined })] });
      const res = await localizeMessage(args(), world.deps);
      expect(world.deps.LocalizedTemplate.updateOne).not.toHaveBeenCalled();
      expect(res.template.variants[0].metaStatus).toBe('NOT_CREATED');
    });

    test('a failing mirror write never fails the request', async () => {
      const world = promoWorld();
      world.deps.LocalizedTemplate.updateOne.mockRejectedValue(new Error('cosmos down'));
      const res = await localizeMessage(args(), world.deps);
      expect(res.created).toBe(true);
      expect(world.deps.log).toHaveBeenCalled();
    });
  });

  describe('template name', () => {
    test('is the owner\'s name, trimmed and capped at 100 characters (by code point)', async () => {
      const long = `  ${'ع'.repeat(150)}  `;
      const world = promoWorld({ promotions: [promotionDoc({ name: long })] });
      await localizeMessage(args(), world.deps);
      const { name } = world.deps.templates.createTemplate.mock.calls[0][0];
      expect(Array.from(name)).toHaveLength(100);
      expect(name).toBe('ع'.repeat(100));
    });

    test('falls back to the catalogue name when the owner has none', async () => {
      const world = promoWorld({ promotions: [promotionDoc({ name: '   ' })] });
      await localizeMessage(args(), world.deps);
      expect(world.deps.templates.createTemplate.mock.calls[0][0].name).toBe('Automated flow message');
    });
  });

  test('every query that touches a workspace-owned collection carries the workspace id', async () => {
    const world = promoWorld();
    await localizeMessage(args(), world.deps);
    for (const [filter] of world.deps.Promotion.findOne.mock.calls) expect(filter.workspaceId).toBe(WS);
    for (const [filter] of world.deps.LocalizedTemplate.find.mock.calls) expect(filter.workspaceId).toBe(WS);
    for (const [filter] of world.deps.LocalizedTemplate.updateOne.mock.calls) expect(filter.workspaceId).toBe(WS);
    for (const [filter] of world.deps.LocalizedTemplate.findOne.mock.calls) expect(filter.workspaceId).toBe(WS);
  });

  test('nothing in the service can delete: the fakes expose no delete/remove/drop, so any such call would throw', async () => {
    const world = promoWorld();
    for (const model of [world.deps.Flow, world.deps.Promotion, world.deps.MessageNode, world.deps.LocalizedTemplate]) {
      expect(Object.keys(model).filter((k) => /delete|remove|drop/i.test(k))).toEqual([]);
    }
    await expect(localizeMessage(args(), world.deps)).resolves.toBeTruthy();
    await expect(listFlowMessages({ workspaceId: WS }, world.deps)).resolves.toBeTruthy();
  });

  test('the service source never deletes anything', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowMessages.js'), 'utf8');
    expect(source).not.toMatch(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|bulkWrite/);
  });
});
