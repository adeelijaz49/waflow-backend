// Unit tests for the flow bridge (shared/localization/flowBridge.js): the function a future
// one-line hook in the flow engine would call. Every collaborator is an in-memory fake that
// honours the query filters it is given, the transport is a jest.fn (no WhatsApp call, ever) and
// the Meta component builder is the REAL pure one, so what is asserted is what would go to Meta.
const fs = require('fs');
const path = require('path');
const { resolveFlowMessage, sendLocalizedFlowMessage, arabicPointsPhrase, REASON_NO_OPT_OUT } = require('../../shared/localization/flowBridge');
const catalogModule = require('../../shared/localization/catalog');
const { extractWamid } = require('../../shared/localization/transport');
const { buildSendComponents } = require('../../shared/localization/metaTemplates');

const LRM = '\u{200E}';
const id = (n) => String(n).padStart(24, '0');
const WS = id(0xa1);
const OTHER_WS = id(0xb2);
const NODE = id(100);
const CUSTOMER = id(7);
const FLOW = id(1);
const PROMOTION = id(10);
const ENROLLMENT = id(50);
const SERVICE_FALLBACK = catalogModule.t('ar', 'flows.fallbackService'); // the catalogue owns this wording
const wrap = (text) => `${LRM}${text}${LRM}`;

// Direction marks around Latin/number parameter values are an opt-in experiment (META-REALITY §4): the shared
// builder only adds them when LOCALIZATION_WRAP_PARAM_LRM=1. Every test starts from the DEFAULT (variable unset,
// whatever the shell has exported). A test that expects marks calls marksOn() first: the experiment is on for that
// one test, and the hooks below put the shell's own value back right after it.
const WRAP_ENV = 'LOCALIZATION_WRAP_PARAM_LRM';
const wrapEnvAtStart = process.env[WRAP_ENV];
function setWrapEnv(value) {
  if (value === undefined) delete process.env[WRAP_ENV];
  else process.env[WRAP_ENV] = value;
}
const marksOn = () => setWrapEnv('1');
beforeEach(() => setWrapEnv(undefined));
afterEach(() => setWrapEnv(wrapEnvAtStart));

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
  const q = { select: () => q, populate: () => q, sort: () => q, limit: () => q, lean: async () => read() };
  return q;
}

function fakeModel(docs) {
  return {
    docs,
    find: jest.fn((filter) => chain(() => structuredClone(docs.filter((d) => matches(d, filter))))),
    findOne: jest.fn((filter) => chain(() => { const hit = docs.find((d) => matches(d, filter)); return hit ? structuredClone(hit) : null; })),
  };
}

const button = (position, label) => ({ position, label, nextAction: { type: 'end_flow' } });
const promotionNode = (over = {}) => ({
  _id: NODE, workspaceId: WS, ownerType: 'promotion', ownerId: PROMOTION, isEntryNode: true,
  bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}', templateStatus: 'approved', buttons: [button(0, 'Shop Now'), button(1, 'Not now')], ...over,
});
const promotionDoc = (over = {}) => ({
  _id: PROMOTION, workspaceId: WS, name: 'Summer Sale', customerType: 'cash', scope: 'products', discountPercent: 20, pointsPrice: 0, entryNodeId: NODE, ...over,
});
const customerDoc = (over = {}) => ({
  _id: CUSTOMER, workspaceId: WS, firstname: 'Sara', lastname: 'Ahmed', phone: '966500000001', loyaltyPoints: 120,
  marketingConsent: true, optedOut: false, isDemo: false, ...over,
});
const FLOW_BUTTONS = [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقاً' }];
const OPT_OUT = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const arabicVariant = (over = {}) => ({
  language: 'ar',
  body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name}',
  footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك',
  buttons: [...FLOW_BUTTONS, OPT_OUT],
  metaStatus: 'APPROVED', reviewStatus: 'reviewed', metaTemplateName: 'wf_0000a1_summer_ar_v1', metaLanguage: 'ar', ...over,
});
const englishMirror = (over = {}) => ({
  language: 'en', body: 'Hi {name}! {item} for {price} - {promo_name}', buttons: [{ role: 'flow_button', text: 'Shop Now' }, { role: 'flow_button', text: 'Not now' }],
  metaStatus: 'APPROVED', reviewStatus: 'draft', metaTemplateName: 'waflow_flow_abc', metaLanguage: 'en', ...over,
});
const templateDoc = (over = {}) => ({
  _id: id(500), workspaceId: WS, key: 'flow_message', name: 'Summer Sale', linkedMessageNodeId: NODE, archived: false,
  variants: [englishMirror(), arabicVariant()], ...over,
});

function makeWorld(data = {}) {
  const has = (key, fallback) => (key in data ? data[key] : fallback);
  const deps = {
    settings: {
      killSwitchOn: jest.fn(() => !!data.kill),
      isArabicEnabled: jest.fn(async () => data.enabled !== false),
      getSettings: jest.fn(async () => ({ defaultCustomerLanguage: data.merchantDefault || 'en' })),
    },
    transport: { sendTemplate: jest.fn(async () => ({ messages: [{ id: 'wamid.ABC' }] })), extractWamid },
    consent: { canSendMarketing: jest.fn((c) => !!c && c.marketingConsent === true && c.optedOut !== true) },
    Flow: fakeModel(has('flows', [])),
    Promotion: fakeModel(has('promotions', [promotionDoc()])),
    MessageNode: fakeModel(has('nodes', [promotionNode()])),
    LocalizedTemplate: fakeModel(has('templates', [templateDoc()])),
    CustomerLanguage: fakeModel(has('languages', [{ workspaceId: WS, customerId: CUSTOMER, language: 'ar' }])),
    Customer: fakeModel(has('customers', [customerDoc()])),
    Settings: fakeModel(has('settings', [])),
    ProductTranslation: fakeModel(has('translations', [])),
    ops: {
      resolvePromoItems: jest.fn(async () => has('items', [{ _id: id(30), name: 'Blue T-Shirt', basePrice: 56.25 }])),
      // The ENGLISH price formatter ("45.00 SAR"): the Arabic path must never use it (R5-6).
      buildPromoEntryNodeParams: jest.fn(async (c, p, items) => [c.firstname || 'Valued Customer', (items[0] && items[0].name) || 'our latest offer', '45.00 SAR', p.name]),
    },
    getCurrency: jest.fn(async () => data.currency || 'SAR'),
    log: jest.fn(),
  };
  return deps;
}

const run = (deps, over = {}) => resolveFlowMessage({ workspaceId: WS, messageNodeId: NODE, customerId: CUSTOMER, ...over }, deps);
const bodyOf = (recipe) => recipe.components.find((c) => c.type === 'body');

// ── the happy path ───────────────────────────────────────────────────────
describe('resolveFlowMessage: an Arabic customer, an approved + reviewed Arabic variant', () => {
  test('returns the exact Meta send: name, language, params in the ARABIC order, payloads (direction marks on)', async () => {
    marksOn();
    const deps = makeWorld();
    const recipe = await run(deps);
    expect(recipe).toEqual({
      templateName: 'wf_0000a1_summer_ar_v1',
      languageCode: 'ar',
      usedLanguage: 'ar',
      bodyParams: [wrap('Sara'), wrap('Blue T-Shirt'), '45.00 ر.س', wrap('Summer Sale')],
      buttonPayloads: [`msgnode_${NODE}_0`, `msgnode_${NODE}_1`, `optout_${NODE}`],
      templateId: id(500),
      components: [
        { type: 'body', parameters: [wrap('Sara'), wrap('Blue T-Shirt'), '45.00 ر.س', wrap('Summer Sale')].map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `msgnode_${NODE}_0` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `msgnode_${NODE}_1` }] },
        { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: `optout_${NODE}` }] },
      ],
    });
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled(); // resolving never sends
  });

  test('params follow the Arabic body\'s own order, which may differ from the English slot order', async () => {
    marksOn();
    const body = 'عرض {promo_name} لك يا {name} على {item}';
    const recipe = await run(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body })] })] }));
    expect(recipe.bodyParams).toEqual([wrap('Summer Sale'), wrap('Sara'), wrap('Blue T-Shirt')]);
  });

  test('a field used twice is filled twice; a field the body does not use is never looked up', async () => {
    marksOn();
    const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body: 'يا {name} أهلاً بك يا {name} في متجرنا' })] })] });
    const recipe = await run(deps);
    expect(recipe.bodyParams).toEqual([wrap('Sara'), wrap('Sara')]);
    expect(deps.ops.resolvePromoItems).not.toHaveBeenCalled();
    expect(deps.ops.buildPromoEntryNodeParams).not.toHaveBeenCalled();
    expect(deps.Promotion.findOne).toHaveBeenCalledTimes(1); // only the ownership lookup, not the populated promotion read
    expect(deps.Settings.findOne).not.toHaveBeenCalled();
  });

  test('with marks on, Arabic values are not wrapped; Latin/number values are (direction marks)', async () => {
    marksOn();
    const deps = makeWorld({
      customers: [customerDoc({ firstname: 'سارة' })],
      translations: [{ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'reviewed', name: 'قميص أزرق' }],
      promotions: [promotionDoc({ name: 'تخفيضات الصيف' })],
    });
    const recipe = await run(deps);
    expect(recipe.bodyParams).toEqual(['سارة', 'قميص أزرق', '45.00 ر.س', 'تخفيضات الصيف']);
  });

  test('the Arabic product translation is used only when REVIEWED, and is looked up inside the workspace', async () => {
    marksOn();
    const draft = makeWorld({ translations: [{ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'draft', name: 'مسودة' }] });
    expect((await run(draft)).bodyParams[1]).toBe(wrap('Blue T-Shirt'));
    const foreign = makeWorld({ translations: [{ workspaceId: OTHER_WS, kind: 'product', refId: id(30), language: 'ar', status: 'reviewed', name: 'أجنبي' }] });
    expect((await run(foreign)).bodyParams[1]).toBe(wrap('Blue T-Shirt'));
    const empty = makeWorld({ translations: [{ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'reviewed', name: '   ' }] });
    expect((await run(empty)).bodyParams[1]).toBe(wrap('Blue T-Shirt'));
    expect(draft.ProductTranslation.findOne).toHaveBeenCalledWith({ workspaceId: WS, kind: 'product', refId: id(30), language: 'ar', status: 'reviewed' });
  });

  test('a services promotion looks up service translations', async () => {
    const deps = makeWorld({ promotions: [promotionDoc({ scope: 'services' })], translations: [{ workspaceId: WS, kind: 'service', refId: id(30), language: 'ar', status: 'reviewed', name: 'جلسة عناية' }] });
    expect((await run(deps)).bodyParams[1]).toBe('جلسة عناية');
  });

  test('English path values: ops are asked for the same items; the cash price is the English amount and currency in Arabic formatting', async () => {
    const deps = makeWorld();
    await run(deps);
    expect(deps.ops.resolvePromoItems).toHaveBeenCalledWith(expect.objectContaining({ _id: PROMOTION, name: 'Summer Sale' }));
    expect(deps.ops.buildPromoEntryNodeParams).not.toHaveBeenCalled(); // the English formatter is never used for the price
    expect(deps.getCurrency).toHaveBeenCalledTimes(1); // the same merchant currency the English price uses
    expect(deps.Promotion.findOne).toHaveBeenCalledWith({ _id: PROMOTION, workspaceId: WS });
  });
});

// ── direction marks are opt-in ───────────────────────────────────────────
// Meta's own Arabic templates carry no direction marks, so LRM around Latin/number parameter values is an unproven
// experiment (META-REALITY §4): off unless LOCALIZATION_WRAP_PARAM_LRM=1. The bridge has no gate of its own: it calls
// the shared builder (metaTemplates.buildSendComponents, which templates.js re-exports and the template test-send and
// the campaign sender use), and the points phrase it composes asks that same builder.
describe('direction marks are off by default and on only with LOCALIZATION_WRAP_PARAM_LRM=1', () => {
  const MARKS = /[\u{200E}\u{200F}\u{061C}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u; // LRM, RLM, ALM, embeddings/overrides, isolates
  const pointsWorld = () => makeWorld({ promotions: [promotionDoc({ customerType: 'points', pointsPrice: 5 })] });
  const headerWorld = () => makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ header: 'عرض {promo_name}' })] })] });

  test('by default (variable unset) the exact send carries plain values: no mark in a parameter, a header or a points phrase', async () => {
    expect(process.env[WRAP_ENV]).toBeUndefined();
    const plain = ['Sara', 'Blue T-Shirt', '45.00 ر.س', 'Summer Sale'];
    const cash = await run(makeWorld());
    expect(cash).toEqual({
      templateName: 'wf_0000a1_summer_ar_v1',
      languageCode: 'ar',
      usedLanguage: 'ar',
      bodyParams: plain,
      buttonPayloads: [`msgnode_${NODE}_0`, `msgnode_${NODE}_1`, `optout_${NODE}`],
      templateId: id(500),
      components: [
        { type: 'body', parameters: plain.map((text) => ({ type: 'text', text })) },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `msgnode_${NODE}_0` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `msgnode_${NODE}_1` }] },
        { type: 'button', sub_type: 'quick_reply', index: '2', parameters: [{ type: 'payload', payload: `optout_${NODE}` }] },
      ],
    });
    const points = await run(pointsWorld());
    expect(points.bodyParams).toEqual(['Sara', 'Blue T-Shirt', '5 نقاط', 'Summer Sale']);
    const header = await run(headerWorld());
    expect(header.components[0].parameters).toEqual([{ type: 'text', text: 'Summer Sale' }]);
    for (const recipe of [cash, points, header]) expect(JSON.stringify(recipe)).not.toMatch(MARKS);
  });

  test.each([[0, '0 نقطة'], [1, 'نقطة واحدة'], [2, 'نقطتان'], [3, '3 نقاط'], [10, '10 نقاط'], [11, '11 نقطة'], [100, '100 نقطة'], [103, '103 نقاط']])(
    'by default the points phrase for %j is plain text: %s', (value, expected) => {
      expect(arabicPointsPhrase(value)).toBe(expected);
    },
  );

  test('one gate, not two: whatever the variable says, the recipe is exactly what the shared builder produces', async () => {
    const values = { name: 'Sara', item: 'Blue T-Shirt', price: '45.00 ر.س', promo_name: 'Summer Sale' };
    const buttonPayloads = [`msgnode_${NODE}_0`, `msgnode_${NODE}_1`, `optout_${NODE}`];
    const countParameter = (n) => buildSendComponents({ variant: { language: 'ar', body: '{n}' }, values: { n: String(n) } })[0].parameters[0].text;
    for (const value of [undefined, '', '0', 'true', '1']) {
      setWrapEnv(value);
      expect((await run(makeWorld())).components).toEqual(buildSendComponents({ variant: arabicVariant(), values, buttonPayloads }));
      expect(arabicPointsPhrase(5)).toBe(`${countParameter(5)} نقاط`);
    }
    // The two ends of the gate really differ, otherwise the loop above proves nothing.
    setWrapEnv('1');
    expect(JSON.stringify(await run(makeWorld()))).toMatch(MARKS);
    expect(arabicPointsPhrase(5)).toBe(`${wrap('5')} نقاط`);
    setWrapEnv(undefined);
    expect(JSON.stringify(await run(makeWorld()))).not.toMatch(MARKS);
    expect(arabicPointsPhrase(5)).toBe('5 نقاط');
  });

  test('the bridge never reads the variable itself (that would be a second gate): it only calls the shared builder', () => {
    const file = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowBridge.js'), 'utf8');
    const code = file.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/process\.env|LOCALIZATION_WRAP_PARAM_LRM|wrapLtr|isolateLtr|renderMessageSafe/);
    expect(code).toMatch(/require\('\.\/metaTemplates'\)/);
    expect(code).toMatch(/buildSendComponents\(/);
  });
});

// ── gates: anything else is null (the English path) ──────────────────────
describe('resolveFlowMessage returns null (the English path) unless everything lines up', () => {
  const expectNull = async (deps, over) => {
    await expect(run(deps, over)).resolves.toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  };

  test('flag off: nothing but the cached flag is consulted', async () => {
    const deps = makeWorld({ enabled: false });
    await expectNull(deps);
    for (const model of ['LocalizedTemplate', 'Customer', 'CustomerLanguage', 'MessageNode', 'Promotion']) expect(deps[model].find).not.toHaveBeenCalled();
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(WS);
  });

  test('the operational kill switch turns it off', async () => {
    const deps = makeWorld({ kill: true });
    await expectNull(deps);
    expect(deps.LocalizedTemplate.find).not.toHaveBeenCalled();
  });

  test.each([
    ['workspace', { workspaceId: undefined }], ['workspace object', { workspaceId: { $ne: null } }], ['node', { messageNodeId: 'nope' }], ['node object', { messageNodeId: { $ne: null } }],
    ['node array', { messageNodeId: [NODE] }], ['customer', { customerId: undefined }], ['customer object', { customerId: { $ne: null } }], ['customer number', { customerId: 7 }],
  ])('a bad %s id never reaches a query', async (_label, over) => {
    const deps = makeWorld();
    await expectNull(deps, over);
    expect(deps.LocalizedTemplate.find).not.toHaveBeenCalled();
    expect(deps.settings.isArabicEnabled).not.toHaveBeenCalled();
  });

  test('no linked template, an archived one, or one that belongs to another workspace / node', async () => {
    await expectNull(makeWorld({ templates: [] }));
    await expectNull(makeWorld({ templates: [templateDoc({ archived: true })] }));
    await expectNull(makeWorld({ templates: [templateDoc({ workspaceId: OTHER_WS })] }));
    await expectNull(makeWorld({ templates: [templateDoc({ linkedMessageNodeId: id(101) })] }));
  });

  test('customers that are not messageable: unknown, other workspace, erased, demo, no consent, opted out', async () => {
    await expectNull(makeWorld({ customers: [] }));
    await expectNull(makeWorld({ customers: [customerDoc({ workspaceId: OTHER_WS })] }));
    await expectNull(makeWorld({ customers: [customerDoc({ deletedAt: new Date() })] }));
    await expectNull(makeWorld({ customers: [customerDoc({ isDemo: true })] }));
    await expectNull(makeWorld({ customers: [customerDoc({ marketingConsent: false })] }));
    await expectNull(makeWorld({ customers: [customerDoc({ optedOut: true })] }));
  });

  test('an English customer is never routed to Arabic, even when the English mirror is stale and the merchant default is Arabic', async () => {
    const staleMirror = templateDoc({ variants: [englishMirror({ metaStatus: 'PENDING' }), arabicVariant()] });
    const deps = makeWorld({ languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'en' }], merchantDefault: 'ar', templates: [staleMirror] });
    await expectNull(deps);
  });

  test('language resolution: customer -> merchant default -> English', async () => {
    const noLanguage = { languages: [] };
    expect(await run(makeWorld({ ...noLanguage, merchantDefault: 'en' }))).toBeNull();
    expect(await run(makeWorld({ ...noLanguage, merchantDefault: 'ar' }))).toMatchObject({ usedLanguage: 'ar' });
    expect(await run(makeWorld({ languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'unknown' }], merchantDefault: 'ar' }))).toMatchObject({ usedLanguage: 'ar' });
    expect(await run(makeWorld({ languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'unknown' }], merchantDefault: 'en' }))).toBeNull();
    // another workspace's language record is not this customer's language
    expect(await run(makeWorld({ languages: [{ workspaceId: OTHER_WS, customerId: CUSTOMER, language: 'ar' }], merchantDefault: 'en' }))).toBeNull();
  });

  test.each([
    ['not submitted', { metaStatus: 'NOT_CREATED' }], ['pending', { metaStatus: 'PENDING' }], ['in appeal', { metaStatus: 'IN_APPEAL' }], ['rejected', { metaStatus: 'REJECTED' }],
    ['paused', { metaStatus: 'PAUSED' }], ['disabled', { metaStatus: 'DISABLED' }], ['flagged', { metaStatus: 'FLAGGED' }], ['errored', { metaStatus: 'ERROR' }],
    ['approved but not reviewed by a native reader', { reviewStatus: 'draft' }],
  ])('an Arabic variant that is %s is never sent (the customer gets the English path)', async (_label, over) => {
    await expectNull(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant(over)] })] }));
  });

  test('no Arabic variant at all', async () => {
    await expectNull(makeWorld({ templates: [templateDoc({ variants: [englishMirror()] })] }));
  });

  test('a bilingual variant alone is not auto-selected (per-customer language is the default)', async () => {
    const bilingual = arabicVariant({ language: 'bilingual', bilingualOrder: 'ar_first' });
    await expectNull(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), bilingual] })] }));
  });

  test('an approved variant without its Meta name cannot be sent', async () => {
    await expectNull(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ metaTemplateName: undefined })] })] }));
    await expectNull(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ metaTemplateName: '' })] })] }));
  });

  test('the language code is the stored one, else the documented mapping', async () => {
    const stored = await run(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ metaLanguage: 'ar_SA' })] })] }));
    expect(stored.languageCode).toBe('ar_SA');
    const derived = await run(makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ metaLanguage: undefined })] })] }));
    expect(derived.languageCode).toBe('ar');
  });

  test('the node must be an entry node of this workspace with a real owner', async () => {
    await expectNull(makeWorld({ nodes: [] }));
    await expectNull(makeWorld({ nodes: [promotionNode({ isEntryNode: false })] }));
    await expectNull(makeWorld({ nodes: [promotionNode({ workspaceId: OTHER_WS })] }));
    await expectNull(makeWorld({ promotions: [] })); // owner gone
    await expectNull(makeWorld({ promotions: [promotionDoc({ workspaceId: OTHER_WS })] })); // owner is another workspace's
  });

  test('a legacy node without a workspace id is accepted only through an owner in this workspace', async () => {
    const legacy = (flowWorkspace) => makeWorld({
      nodes: [promotionNode({ workspaceId: undefined })], promotions: [promotionDoc({ workspaceId: flowWorkspace })],
    });
    expect(await run(legacy(WS))).toMatchObject({ usedLanguage: 'ar' });
    await expectNull(legacy(OTHER_WS));
  });

  test('the Arabic variant must still match the node\'s buttons: count, order, roles', async () => {
    const withButtons = (buttons) => makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ buttons })] })] });
    await expectNull(withButtons([FLOW_BUTTONS[0], OPT_OUT])); // one flow button too few
    await expectNull(withButtons([...FLOW_BUTTONS, FLOW_BUTTONS[0], OPT_OUT])); // one too many
    await expectNull(withButtons([OPT_OUT, ...FLOW_BUTTONS])); // order
    await expectNull(withButtons([...FLOW_BUTTONS, { role: 'opt_in', text: 'نعم، أوافق' }])); // a consent button has no place here
    await expectNull(makeWorld({ nodes: [promotionNode({ buttons: [button(0, 'A'), button(1, 'B'), button(2, 'C')] })] })); // node got a third button after approval
    await expectNull(withButtons([...FLOW_BUTTONS])); // ... and the opt-out is NOT optional (below)
  });

  describe('every flow message is marketing: the Arabic variant must carry the opt-out button (R2-02)', () => {
    const withButtons = (buttons, template = {}) => makeWorld({ templates: [templateDoc({ ...template, variants: [englishMirror(), arabicVariant({ buttons })] })] });
    const why = async (deps) => { const explain = {}; const out = await run(deps, { explain }); return { out, reason: explain.reason }; };

    test('with the opt_out button the variant resolves; no reason is reported', async () => {
      const { out, reason } = await why(withButtons([...FLOW_BUTTONS, OPT_OUT]));
      expect(out).toMatchObject({ usedLanguage: 'ar', buttonPayloads: [`msgnode_${NODE}_0`, `msgnode_${NODE}_1`, `optout_${NODE}`] });
      expect(reason).toBeUndefined();
    });

    test('without it the result is null (the English path runs) and the reason code says why', async () => {
      const deps = withButtons([...FLOW_BUTTONS]);
      const { out, reason } = await why(deps);
      expect(out).toBeNull();
      expect(reason).toBe(REASON_NO_OPT_OUT);
      expect(REASON_NO_OPT_OUT).toBe('marketing_requires_opt_out_button');
      expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    });

    test('a url button is not an opt-out; neither is a button with a label that merely says so', async () => {
      const url = { role: 'url', text: 'زيارة المتجر', url: 'https://example.com' };
      expect((await why(withButtons([...FLOW_BUTTONS, url]))).reason).toBe(REASON_NO_OPT_OUT);
      expect((await why(withButtons([...FLOW_BUTTONS, { role: 'url', text: 'إلغاء الاشتراك' }]))).reason).toBe(REASON_NO_OPT_OUT);
    });

    test('a UTILITY-floor use case linked to a flow node does not lift the rule', async () => {
      for (const useCase of ['order_confirmation', 'payment_reminder', 'booking_confirmation', 'booking_reminder']) {
        const without = await why(withButtons([...FLOW_BUTTONS], { useCase, category: 'UTILITY' }));
        expect(without.out).toBeNull();
        expect(without.reason).toBe(REASON_NO_OPT_OUT);
        const withIt = await why(withButtons([...FLOW_BUTTONS, OPT_OUT], { useCase, category: 'UTILITY' }));
        expect(withIt.out).toMatchObject({ usedLanguage: 'ar' });
      }
    });

    test('sendLocalizedFlowMessage sends nothing for a variant without the opt-out (the engine falls through to English)', async () => {
      const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ buttons: [...FLOW_BUTTONS] })] })], flows: [] });
      const flow = { _id: FLOW, workspaceId: WS, promotionId: PROMOTION, triggerType: 'inactive_customer' };
      const result = await sendLocalizedFlowMessage({ flow, enrollment: { _id: ENROLLMENT }, customer: { _id: CUSTOMER, phone: '966500000001' } }, deps);
      expect(result).toBeNull();
      expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    });
  });

  test('a customer-controlled field that nobody can fill makes the whole message null, never a blank', async () => {
    marksOn();
    const body = 'أهلاً {name}، خصم {discount}%';
    const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body })] })] });
    await expectNull(deps);
    expect(await run(deps, { fieldValues: { discount: 15 } })).toMatchObject({ bodyParams: [wrap('Sara'), wrap('15')] });
  });
});

// ── values ───────────────────────────────────────────────────────────────
describe('resolveFlowMessage: merge-field values', () => {
  const withBody = (body, extra = {}) => makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body })] })], ...extra });

  test('a caller value beats the derived one; unusable caller values are ignored', async () => {
    marksOn();
    const deps = withBody('يا {name} لدينا {points}');
    expect((await run(deps, { fieldValues: { name: 'ليلى' } })).bodyParams).toEqual(['ليلى', wrap('120')]);
    for (const junk of [{ name: { x: 1 } }, { name: ['a'] }, { name: '   ' }, { name: NaN }, { name: Infinity }, { name: null }, { name: true }, 'text', 42, ['x'], null]) {
      expect((await run(withBody('يا {name} لدينا {points}'), { fieldValues: junk })).bodyParams).toEqual([wrap('Sara'), wrap('120')]);
    }
  });

  test('prototype-looking keys in fieldValues are inert', async () => {
    const fieldValues = JSON.parse('{"__proto__": {"name": "x"}, "constructor": "y", "name": "ليلى"}');
    expect((await run(withBody('يا {name}'), { fieldValues })).bodyParams).toEqual(['ليلى']);
    expect(({}).name).toBeUndefined();
  });

  test('caller values are sanitised for WhatsApp (no newlines, tabs or runs of spaces)', async () => {
    marksOn();
    const recipe = await run(withBody('يا {name} {date}'), { fieldValues: { date: '30\nNov\t\t2026     late' } });
    expect(recipe.bodyParams[1]).toBe(wrap('30 Nov 2026 late'));
  });

  test('a number-like first name (the Inbox names unknown customers by phone) counts as no name', async () => {
    marksOn();
    for (const firstname of ['966500000001', '+966 50 000 0001', '0500000001', '(050) 000-0001', '٩٦٦٥٠٠٠٠٠٠٠١']) {
      const recipe = await run(withBody('يا {name}', { customers: [customerDoc({ firstname })] }));
      expect(recipe.bodyParams).toEqual(['عميلنا العزيز']);
    }
    // a name with digits in it is still a name
    expect((await run(withBody('يا {name}', { customers: [customerDoc({ firstname: 'Sara2' })] }))).bodyParams).toEqual([wrap('Sara2')]);
  });

  test.each([[undefined], [''], ['   '], [null]])('missing first name %j gets the Arabic fallback, not the English one', async (firstname) => {
    const recipe = await run(withBody('يا {name} / {full_name}', { customers: [customerDoc({ firstname, lastname: 'Ahmed' })] }));
    expect(recipe.bodyParams).toEqual(['عميلنا العزيز', 'عميلنا العزيز']);
    expect(JSON.stringify(recipe)).not.toContain('Valued Customer');
  });

  test('full_name is first + last (last name optional)', async () => {
    marksOn();
    expect((await run(withBody('يا {full_name}'))).bodyParams).toEqual([wrap('Sara Ahmed')]);
    expect((await run(withBody('يا {full_name}', { customers: [customerDoc({ lastname: undefined })] }))).bodyParams).toEqual([wrap('Sara')]);
    expect((await run(withBody('يا {full_name}', { customers: [customerDoc({ firstname: 'سارة', lastname: 'أحمد' })] }))).bodyParams).toEqual(['سارة أحمد']);
  });

  test.each([[120, '120'], [0, '0'], [undefined, '0'], [null, '0'], ['12', '12'], [NaN, '0'], [12.5, '12.5']])('points %j -> %s', async (loyaltyPoints, text) => {
    marksOn();
    const recipe = await run(withBody('رصيدك {points} الآن', { customers: [customerDoc({ loyaltyPoints })] }));
    expect(recipe.bodyParams).toEqual([wrap(text)]);
  });

  test('business comes from the workspace settings; blank or missing means unresolved (null)', async () => {
    marksOn();
    const body = 'من {business} يا {name}';
    const ok = withBody(body, { settings: [{ workspaceId: WS, merchantName: 'متجر الورد' }] });
    expect((await run(ok)).bodyParams).toEqual(['متجر الورد', wrap('Sara')]);
    expect(ok.Settings.findOne).toHaveBeenCalledWith({ workspaceId: WS });
    expect(await run(withBody(body, { settings: [{ workspaceId: WS, merchantName: '  ' }] }))).toBeNull();
    expect(await run(withBody(body, { settings: [{ workspaceId: OTHER_WS, merchantName: 'غيره' }] }))).toBeNull();
    expect(await run(withBody(body))).toBeNull();
  });

  test('a header with a field gets its own parameter component, before the body', async () => {
    marksOn();
    const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ header: 'عرض {promo_name}', body: 'يا {name}' })] })] });
    const recipe = await run(deps);
    expect(recipe.components.map((c) => c.type)).toEqual(['header', 'body', 'button', 'button', 'button']);
    expect(recipe.components[0].parameters).toEqual([{ type: 'text', text: wrap('Summer Sale') }]);
    expect(recipe.bodyParams).toEqual([wrap('Sara')]);
  });

  test('a body without fields sends no body component at all', async () => {
    const recipe = await run(withBody('أهلاً بك في متجرنا'));
    expect(recipe.bodyParams).toEqual([]);
    expect(recipe.components.map((c) => c.type)).toEqual(['button', 'button', 'button']);
  });

  describe('promotion-owned slots', () => {
    const body = 'خذ {item} بـ {price}';

    test('a points promotion prices in Arabic points with correct number agreement (direction marks on)', async () => {
      marksOn();
      for (const [pointsPrice, phrase] of [[1, 'نقطة واحدة'], [2, 'نقطتان'], [5, `${wrap('5')} نقاط`], [10, `${wrap('10')} نقاط`], [11, `${wrap('11')} نقطة`], [150, `${wrap('150')} نقطة`], [0, `${wrap('0')} نقطة`]]) {
        const deps = withBody(body, { promotions: [promotionDoc({ customerType: 'points', pointsPrice })] });
        const recipe = await run(deps);
        expect(recipe.bodyParams[1]).toBe(phrase);
        expect(deps.ops.buildPromoEntryNodeParams).not.toHaveBeenCalled(); // the English "N pts" is never used
      }
    });

    test('a cash promotion prices in the Arabic currency format: the English amount (base less discount) and currency, never "45.00 SAR" (R5-6)', async () => {
      const { formatMoney } = require('../../shared/localization/senderValues');
      const sar = await run(withBody(body));
      expect(sar.bodyParams[1]).toBe('45.00 ر.س');
      expect(sar.bodyParams[1]).toBe(formatMoney(45, 'SAR', 'ar'));
      const aed = await run(withBody(body, { currency: 'AED', promotions: [promotionDoc({ discountPercent: 50 })] }));
      expect(aed.bodyParams[1]).toBe(formatMoney(28.13, 'AED', 'ar'));
      expect(aed.bodyParams[1]).not.toMatch(/AED|SAR/);
      const unknown = await run(withBody(body, { currency: 'AUD', promotions: [promotionDoc({ discountPercent: 0 })] }));
      expect(unknown.bodyParams[1]).toBe(formatMoney(56.25, 'AUD', 'ar')); // an unknown code is written as the code
    });

    test('a cash promotion with no items has no price: unresolved (null); the item falls back to the Arabic phrase', async () => {
      expect(await run(withBody(body, { items: [] }))).toBeNull();
      const itemOnly = await run(withBody('خذ {item} الآن', { items: [] }));
      expect(itemOnly.bodyParams).toEqual(['عرضنا الجديد']);
    });

    test('an item without a name falls back too', async () => {
      const recipe = await run(withBody('خذ {item}', { items: [{ _id: id(30), name: '', basePrice: 10 }] }));
      expect(recipe.bodyParams).toEqual(['عرضنا الجديد']);
    });

    test('the promotion is read inside the workspace only', async () => {
      const deps = withBody(body, { promotions: [promotionDoc({ workspaceId: OTHER_WS })] });
      expect(await run(deps)).toBeNull();
    });
  });

  describe('flow-owned (legacy) nodes', () => {
    const legacy = (body, extra = {}) => makeWorld({
      nodes: [promotionNode({ ownerType: 'flow', ownerId: FLOW })],
      flows: [{ _id: FLOW, workspaceId: WS, triggerType: 'post_purchase_points', name: 'After purchase' }],
      templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body })] })],
      ...extra,
    });

    test('name and points come from the customer', async () => {
      marksOn();
      const recipe = await run(legacy('أهلاً {name}، رصيدك {points}'));
      expect(recipe.bodyParams).toEqual([wrap('Sara'), wrap('120')]);
    });

    test('{service} (booking no-show) is only available from the caller', async () => {
      marksOn();
      const deps = legacy('فاتتك {service} يا {name}');
      expect(await run(deps)).toBeNull();
      expect((await run(deps, { fieldValues: { service: 'جلسة عناية' } })).bodyParams).toEqual(['جلسة عناية', wrap('Sara')]);
    });

    test('promotion fields are not offered to a flow-owned node', async () => {
      const deps = legacy('خذ {item}');
      expect(await run(deps)).toBeNull();
      expect(deps.Promotion.findOne).not.toHaveBeenCalled();
    });
  });
});

// ── payloads ─────────────────────────────────────────────────────────────
describe('resolveFlowMessage: button payloads', () => {
  test('flow buttons carry the node\'s OWN positions, even when they are not 0..n-1', async () => {
    const deps = makeWorld({ nodes: [promotionNode({ buttons: [button(2, 'A'), button(0, 'B')] })] });
    const recipe = await run(deps);
    expect(recipe.buttonPayloads).toEqual([`msgnode_${NODE}_2`, `msgnode_${NODE}_0`, `optout_${NODE}`]);
  });

  test('a url button gets no component; quick replies keep their template index', async () => {
    const url = { role: 'url', text: 'الموقع', url: 'https://example.com/shop' };
    const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ buttons: [...FLOW_BUTTONS, OPT_OUT, url] })] })] });
    const recipe = await run(deps);
    expect(recipe.components.filter((c) => c.type === 'button').map((c) => c.index)).toEqual(['0', '1', '2']);
    expect(recipe.buttonPayloads).toHaveLength(3);
  });

  test('every payload fits Meta\'s limit and the opt-out payload is a valid ObjectId suffix (the webhook casts it)', async () => {
    const recipe = await run(makeWorld());
    for (const payload of recipe.buttonPayloads) expect(Array.from(payload).length).toBeLessThanOrEqual(256);
    expect(recipe.buttonPayloads.at(-1)).toMatch(/^optout_[a-f0-9]{24}$/);
  });
});

// ── safety ───────────────────────────────────────────────────────────────
describe('resolveFlowMessage never throws and is workspace-scoped', () => {
  test.each([[undefined], [null], [42], ['text'], [[]], [{}]])('garbage args %j -> null', async (args) => {
    await expect(resolveFlowMessage(args, makeWorld())).resolves.toBeNull();
  });

  test.each(['Customer', 'CustomerLanguage', 'LocalizedTemplate', 'MessageNode', 'Promotion', 'ProductTranslation', 'Settings'])('a failing %s query returns null and is logged', async (model) => {
    const deps = makeWorld({ templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body: 'يا {name} {business} {item}' })] })], settings: [{ workspaceId: WS, merchantName: 'X' }] });
    deps[model].find.mockImplementation(() => { throw new Error('db down'); });
    deps[model].findOne.mockImplementation(() => { throw new Error('db down'); });
    await expect(run(deps)).resolves.toBeNull();
    expect(deps.log).toHaveBeenCalled();
  });

  test.each([
    ['the flag check', (d) => { d.settings.isArabicEnabled.mockRejectedValue(new Error('x')); }],
    ['the settings read', (d) => { d.settings.getSettings.mockRejectedValue(new Error('x')); }],
    ['the consent check', (d) => { d.consent.canSendMarketing.mockImplementation(() => { throw new Error('x'); }); }],
    ['the currency read', (d) => { d.getCurrency.mockRejectedValue(new Error('x')); }],
    ['the items helper', (d) => { d.ops.resolvePromoItems.mockRejectedValue(new Error('x')); }],
  ])('a failure in %s returns null', async (_label, sabotage) => {
    const deps = makeWorld();
    sabotage(deps);
    await expect(run(deps)).resolves.toBeNull();
    expect(deps.log).toHaveBeenCalled();
  });

  test('a missing logger cannot make a failure throw', async () => {
    const deps = makeWorld();
    deps.log = undefined;
    deps.Customer.findOne.mockImplementation(() => { throw new Error('x'); });
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run(deps)).resolves.toBeNull();
    quiet.mockRestore();
  });

  test('every query on a workspace-owned collection carries this workspace id', async () => {
    const deps = makeWorld({ settings: [{ workspaceId: WS, merchantName: 'X' }], templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body: 'يا {name} {business} {item} {price} {promo_name}' })] })] });
    await run(deps);
    for (const model of ['Customer', 'CustomerLanguage', 'LocalizedTemplate', 'Promotion', 'Settings', 'ProductTranslation']) {
      const calls = [...deps[model].find.mock.calls, ...deps[model].findOne.mock.calls];
      expect(calls.length).toBeGreaterThan(0);
      for (const [filter] of calls) expect(filter.workspaceId).toBe(WS);
    }
    // the node is looked up by id and then PROVEN to be this workspace's (see flowMessages.loadOwnedNode)
    expect(deps.MessageNode.findOne).toHaveBeenCalledWith({ _id: NODE });
  });

  test('a customer id from another workspace finds nothing', async () => {
    const deps = makeWorld({ customers: [customerDoc({ workspaceId: OTHER_WS })] });
    expect(await run(deps)).toBeNull();
    expect(deps.Customer.findOne).toHaveBeenCalledWith({ _id: CUSTOMER, workspaceId: WS });
  });

  test('the bridge code never writes, never deletes and never talks to WhatsApp directly', () => {
    const file = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'flowBridge.js'), 'utf8');
    const code = file.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code.match(/deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|\.remove\(|\.drop\(|bulkWrite|updateOne|updateMany|findOneAndUpdate|(?<!Object)\.create\(|insertMany|\.save\(/)).toBeNull();
    expect(code.match(/utils\/whatsapp|waPost|axios/)).toBeNull();
  });
});

// ── arabicPointsPhrase ───────────────────────────────────────────────────
describe('arabicPointsPhrase (Arabic number agreement)', () => {
  test.each([
    [0, `${wrap('0')} نقطة`], [1, 'نقطة واحدة'], [2, 'نقطتان'], [3, `${wrap('3')} نقاط`], [10, `${wrap('10')} نقاط`], [11, `${wrap('11')} نقطة`],
    [12, `${wrap('12')} نقطة`], [99, `${wrap('99')} نقطة`], [100, `${wrap('100')} نقطة`], [101, `${wrap('101')} نقطة`], [102, `${wrap('102')} نقطة`],
    [103, `${wrap('103')} نقاط`], [110, `${wrap('110')} نقاط`], [111, `${wrap('111')} نقطة`], [1000, `${wrap('1000')} نقطة`], [1003, `${wrap('1003')} نقاط`],
    [2.9, 'نقطتان'], ['5', `${wrap('5')} نقاط`], [-3, `${wrap('0')} نقطة`], [NaN, `${wrap('0')} نقطة`], [undefined, `${wrap('0')} نقطة`], ['x', `${wrap('0')} نقطة`],
  ])('with marks on, %j -> %s', (value, expected) => {
    marksOn();
    expect(arabicPointsPhrase(value)).toBe(expected);
  });
});

// ── sendLocalizedFlowMessage (what the engine hook calls) ────────────────
describe('sendLocalizedFlowMessage', () => {
  const flow = (over = {}) => ({ _id: FLOW, workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', promotionId: PROMOTION, ...over });
  const enrollment = { _id: ENROLLMENT };
  const customer = () => customerDoc();
  const go = (deps, over = {}) => sendLocalizedFlowMessage({ flow: flow(), enrollment, customer: customer(), ...over }, deps);

  test('sends the Arabic template through the transport and returns the CampaignMessage row', async () => {
    const deps = makeWorld();
    const before = Date.now();
    const result = await go(deps);
    expect(deps.transport.sendTemplate).toHaveBeenCalledTimes(1);
    const [to, payload] = deps.transport.sendTemplate.mock.calls[0];
    expect(to).toBe('966500000001');
    expect(payload).toMatchObject({ name: 'wf_0000a1_summer_ar_v1', languageCode: 'ar' });
    expect(payload.components).toEqual((await run(makeWorld())).components);
    expect(result).toMatchObject({ sent: true, dryRun: false, templateName: 'wf_0000a1_summer_ar_v1', usedLanguage: 'ar' });
    expect(result.record).toEqual({
      workspaceId: WS, kind: 'flow', flow: FLOW, flowEnrollment: ENROLLMENT, promotion: PROMOTION, customer: CUSTOMER, phone: '966500000001',
      wamid: 'wamid.ABC', messageType: 'template', templateName: 'wf_0000a1_summer_ar_v1', messageNode: NODE, status: 'sent', statusReason: undefined,
      sentAt: expect.any(Date),
    });
    expect(result.record.sentAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('the row carries the workspace id (the engine\'s own rows lack it, so webhook callbacks could not find them)', async () => {
    const result = await go(makeWorld());
    expect(result.record.workspaceId).toBe(WS);
  });

  test('resolves the entry node like the engine: the promotion\'s node, never the flow\'s own, when a promotion is set', async () => {
    const deps = makeWorld({ promotions: [promotionDoc({ entryNodeId: undefined })] });
    expect(await go(deps, { flow: flow({ entryNodeId: NODE }) })).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    expect(deps.Promotion.findOne).toHaveBeenCalledWith({ _id: PROMOTION, workspaceId: WS });
  });

  test('a legacy flow uses its own entryNodeId; no promotion record is read', async () => {
    const deps = makeWorld({
      nodes: [promotionNode({ ownerType: 'flow', ownerId: FLOW })],
      flows: [{ _id: FLOW, workspaceId: WS, triggerType: 'inactive_customer' }],
      templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ body: 'يا {name}' })] })],
    });
    const result = await go(deps, { flow: flow({ promotionId: undefined, entryNodeId: NODE }) });
    expect(result.record).toMatchObject({ promotion: undefined, messageNode: NODE, status: 'sent' });
    expect(deps.Promotion.findOne).not.toHaveBeenCalledWith(expect.objectContaining({ _id: PROMOTION }), expect.anything());
  });

  test('built-in default flows (no promotion, no entry node) are left to the English code', async () => {
    const deps = makeWorld();
    expect(await go(deps, { flow: flow({ promotionId: undefined }) })).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('English customers, ineligible customers and a flag-off workspace get null and nothing is sent', async () => {
    for (const data of [
      { languages: [{ workspaceId: WS, customerId: CUSTOMER, language: 'en' }] },
      { enabled: false },
      { customers: [customerDoc({ optedOut: true })] },
      { templates: [templateDoc({ variants: [englishMirror(), arabicVariant({ reviewStatus: 'draft' })] })] },
    ]) {
      const deps = makeWorld(data);
      await expect(go(deps)).resolves.toBeNull();
      expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    }
  });

  test('a flow without a workspace never localizes (the flag cannot be read)', async () => {
    const deps = makeWorld();
    expect(await go(deps, { flow: flow({ workspaceId: undefined }) })).toBeNull();
    expect(await go(deps, { flow: flow({ workspaceId: { $ne: null } }) })).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('a failed send is recorded as failed, once, with a bounded reason, and never falls back', async () => {
    const deps = makeWorld();
    const metaError = Object.assign(new Error('Request failed with status code 400'), {
      response: { data: { error: { message: `(#132001) Template name does not exist ${'x'.repeat(500)}`, code: 132001 } } },
    });
    deps.transport.sendTemplate.mockRejectedValue(metaError);
    const result = await go(deps);
    expect(deps.transport.sendTemplate).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(false);
    expect(result.record).toMatchObject({ status: 'failed', wamid: undefined, workspaceId: WS, messageNode: NODE });
    expect(result.record.statusReason.startsWith('(#132001) Template name does not exist')).toBe(true);
    expect(result.record.statusReason.length).toBeLessThanOrEqual(300);
  });

  test('a plain error is recorded with its message; a message-less one gets a generic reason', async () => {
    const plain = makeWorld();
    plain.transport.sendTemplate.mockRejectedValue(new Error('socket hang up'));
    expect((await go(plain)).record.statusReason).toBe('socket hang up');
    const bare = makeWorld();
    bare.transport.sendTemplate.mockRejectedValue(undefined);
    expect((await go(bare)).record).toMatchObject({ status: 'failed', statusReason: 'Send failed' });
  });

  test('dry-run mode is reported and the fake wamid is kept', async () => {
    const deps = makeWorld();
    deps.transport.sendTemplate.mockResolvedValue({ dryRun: true, messages: [{ id: 'dryrun.1.abc' }] });
    const result = await go(deps);
    expect(result).toMatchObject({ sent: true, dryRun: true });
    expect(result.record.wamid).toBe('dryrun.1.abc');
  });

  test('an odd transport response never turns a real send into a null (which would trigger the English send)', async () => {
    for (const response of [undefined, null, {}, 'ok', { messages: [] }]) {
      const deps = makeWorld();
      deps.transport.sendTemplate.mockResolvedValue(response);
      const result = await go(deps);
      expect(result).toMatchObject({ sent: true });
      expect(result.record.status).toBe('sent');
    }
    const deps = makeWorld();
    deps.transport.extractWamid = () => { throw new Error('boom'); };
    expect(await go(deps)).toMatchObject({ sent: true, record: { wamid: undefined } });
  });

  test('anything unexpected BEFORE the send returns null (the English path), and nothing was sent', async () => {
    const deps = makeWorld();
    deps.Promotion.findOne.mockImplementation(() => { throw new Error('db down'); });
    await expect(go(deps)).resolves.toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  test.each([[undefined], [null], [{}], [{ flow: null }], [{ flow: {}, enrollment: {}, customer: {} }], [42]])('garbage input %j never throws', async (input) => {
    await expect(sendLocalizedFlowMessage(input, makeWorld())).resolves.toBeNull();
  });

  test('missing enrollment or customer: null', async () => {
    const deps = makeWorld();
    expect(await go(deps, { enrollment: undefined })).toBeNull();
    expect(await go(deps, { customer: undefined })).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });
});

// ── the applied hook: flag first, English parity, lazy {service} (D2 section 4.3) ─────────────────
describe('sendLocalizedFlowMessage: the flag comes first', () => {
  const flow = (over = {}) => ({ _id: FLOW, workspaceId: WS, name: 'Win-back', triggerType: 'inactive_customer', promotionId: PROMOTION, ...over });
  const go = (deps, over = {}) => sendLocalizedFlowMessage({ flow: flow(), enrollment: { _id: ENROLLMENT }, customer: customerDoc(), ...over }, deps);

  test('a flag-off workspace costs exactly one cached flag read: no Promotion, node, template, customer or language query', async () => {
    const deps = makeWorld({ enabled: false });
    expect(await go(deps)).toBeNull();
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(WS);
    for (const model of ['Promotion', 'MessageNode', 'LocalizedTemplate', 'Customer', 'CustomerLanguage', 'Settings', 'ProductTranslation']) {
      expect(deps[model].find).not.toHaveBeenCalled();
      expect(deps[model].findOne).not.toHaveBeenCalled();
    }
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('the kill switch is read before anything else, and a legacy flow is not queried either', async () => {
    const deps = makeWorld({ kill: true });
    expect(await go(deps)).toBeNull();
    expect(deps.settings.isArabicEnabled).not.toHaveBeenCalled();
    expect(deps.Promotion.findOne).not.toHaveBeenCalled();
    const legacy = makeWorld({ enabled: false });
    expect(await go(legacy, { flow: flow({ promotionId: undefined, entryNodeId: NODE }) })).toBeNull();
    expect(legacy.MessageNode.findOne).not.toHaveBeenCalled();
  });

  test('a throwing flag read is null (English), not an exception', async () => {
    const deps = makeWorld();
    deps.settings.isArabicEnabled = jest.fn(async () => { throw new Error('db'); });
    expect(await go(deps)).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('English parity: only an APPROVED English entry node is localised', () => {
  test.each(['pending', 'not_created', 'rejected', undefined])('English node templateStatus %s -> null (the English path would not send it either)', async (templateStatus) => {
    expect(await run(makeWorld({ nodes: [promotionNode({ templateStatus })] }))).toBeNull();
  });
  test('approved -> the Arabic recipe', async () => {
    expect(await run(makeWorld())).toMatchObject({ usedLanguage: 'ar' });
  });
  test('an edited English node (pending again) stops the Arabic send through the hook too', async () => {
    const deps = makeWorld({ nodes: [promotionNode({ templateStatus: 'pending' })] });
    const out = await sendLocalizedFlowMessage({ flow: { _id: FLOW, workspaceId: WS, triggerType: 'inactive_customer', promotionId: PROMOTION }, enrollment: { _id: ENROLLMENT }, customer: customerDoc() }, deps);
    expect(out).toBeNull();
    expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('{service} of a booking no-show flow (fieldValuesFor / serviceFieldValue)', () => {
  const { serviceFieldValue, collectValues, usableName } = require('../../shared/localization/flowBridge');
  const BOOKING = id(60);
  const SERVICE = id(70);
  const flow = (over = {}) => ({ _id: FLOW, workspaceId: WS, name: 'No-show', triggerType: 'booking_no_show', entryNodeId: NODE, ...over });
  const noShowEnrollment = (over = {}) => ({ _id: ENROLLMENT, sourceModel: 'Booking', sourceRef: BOOKING, ...over });
  const noShowWorld = (data = {}) => {
    const deps = makeWorld({
      nodes: [promotionNode({ ownerType: 'flow', ownerId: FLOW, bodyText: 'Hi {{1}}, we missed you for {{2}}', buttons: [button(0, 'Rebook')] })],
      flows: [{ _id: FLOW, workspaceId: WS, triggerType: 'booking_no_show' }],
      templates: [templateDoc({ variants: [englishMirror({ body: 'Hi {name}, we missed you for {service}', buttons: [{ role: 'flow_button', text: 'Rebook' }] }), arabicVariant({ body: 'أهلاً {name}، فاتنا موعدك لـ {service}', buttons: [{ role: 'flow_button', text: 'أعد الحجز' }, OPT_OUT] })] })],
      translations: data.translations || [],
    });
    deps.Booking = fakeModel(data.bookings || [{ _id: BOOKING, workspaceId: WS, serviceId: SERVICE }]);
    deps.Service = fakeModel(data.services || [{ _id: SERVICE, workspaceId: WS, name: 'Facial' }]);
    return deps;
  };
  const go = (deps, over = {}) => sendLocalizedFlowMessage({ flow: flow(), enrollment: noShowEnrollment(), customer: customerDoc(), ...over }, deps);
  const bodyTexts = (deps) => deps.transport.sendTemplate.mock.calls[0][1].components.find((c) => c.type === 'body').parameters.map((p) => p.text);

  test('the Arabic message is sent with the booking\'s service name (workspace-scoped booking and service reads)', async () => {
    const deps = noShowWorld();
    const out = await go(deps);
    expect(out.sent).toBe(true);
    expect(bodyTexts(deps)).toEqual(['Sara', 'Facial']);
    expect(deps.Booking.findOne).toHaveBeenCalledWith({ _id: BOOKING, workspaceId: WS });
    expect(deps.Service.findOne).toHaveBeenCalledWith({ _id: SERVICE, workspaceId: WS });
  });
  test('a REVIEWED Arabic service translation wins; a draft does not', async () => {
    const reviewed = noShowWorld({ translations: [{ workspaceId: WS, kind: 'service', refId: SERVICE, language: 'ar', status: 'reviewed', name: 'جلسة عناية' }] });
    await go(reviewed);
    expect(bodyTexts(reviewed)[1]).toBe('جلسة عناية');
    expect(reviewed.Service.findOne).not.toHaveBeenCalled();
    const draft = noShowWorld({ translations: [{ workspaceId: WS, kind: 'service', refId: SERVICE, language: 'ar', status: 'draft', name: 'مسودة' }] });
    await go(draft);
    expect(bodyTexts(draft)[1]).toBe('Facial');
  });
  test('a service without a name gets the Arabic fallback (the English path sends "your appointment")', async () => {
    const deps = noShowWorld({ services: [{ _id: SERVICE, workspaceId: WS, name: '  ' }] });
    await go(deps);
    expect(bodyTexts(deps)[1]).toBe(SERVICE_FALLBACK);
  });
  test('no booking in this workspace (or a booking of another one) -> the field stays open -> null -> English, nothing sent', async () => {
    for (const bookings of [[], [{ _id: BOOKING, workspaceId: OTHER_WS, serviceId: SERVICE }]]) {
      const deps = noShowWorld({ bookings });
      expect(await go(deps)).toBeNull();
      expect(deps.transport.sendTemplate).not.toHaveBeenCalled();
    }
  });
  test('the booking is looked up only for a booking_no_show legacy flow whose enrollment came from a Booking', async () => {
    for (const [f, e] of [[{ triggerType: 'inactive_customer' }, {}], [{ promotionId: PROMOTION }, {}], [{}, { sourceModel: 'Order' }], [{}, { sourceModel: undefined }]]) {
      const deps = noShowWorld();
      await go(deps, { flow: flow(f), enrollment: noShowEnrollment(e) });
      expect(deps.Booking.findOne).not.toHaveBeenCalled();
    }
  });
  test('the booking is not read when the Arabic text does not use {service}', async () => {
    const deps = noShowWorld();
    deps.LocalizedTemplate.docs[0].variants[1].body = 'أهلاً {name}';
    await go(deps);
    expect(deps.Booking.findOne).not.toHaveBeenCalled();
  });
  test('a caller-supplied fieldValues service beats the lazy one', async () => {
    const deps = noShowWorld();
    const lazy = jest.fn(async () => ({ service: 'Lazy' }));
    const recipe = await resolveFlowMessage({ workspaceId: WS, messageNodeId: NODE, customerId: CUSTOMER, fieldValues: { service: 'Given' }, fieldValuesFor: lazy }, deps);
    expect(recipe.bodyParams).toEqual(['Sara', 'Given']);
    expect(deps.Booking.findOne).not.toHaveBeenCalled();
  });
  test('serviceFieldValue direct: garbage ids and missing rows give {}, a good booking gives the service', async () => {
    const deps = noShowWorld();
    expect(await serviceFieldValue(deps, { workspaceId: WS, bookingId: 'x' })).toEqual({});
    expect(await serviceFieldValue(deps, { workspaceId: { $ne: null }, bookingId: BOOKING })).toEqual({});
    expect(await serviceFieldValue(deps, { workspaceId: WS, bookingId: { $ne: null } })).toEqual({});
    expect(await serviceFieldValue(deps, undefined)).toEqual({});
    expect(await serviceFieldValue(deps, { workspaceId: WS, bookingId: id(61) })).toEqual({});
    expect(await serviceFieldValue(deps, { workspaceId: WS, bookingId: BOOKING })).toEqual({ service: 'Facial' });
  });
  test('a booking without a service id still resolves to the fallback', async () => {
    const deps = noShowWorld({ bookings: [{ _id: BOOKING, workspaceId: WS }] });
    expect(await serviceFieldValue(deps, { workspaceId: WS, bookingId: BOOKING })).toEqual({ service: SERVICE_FALLBACK });
  });
  test('a throwing lazy provider makes the whole resolution null, never a partial message', async () => {
    const deps = noShowWorld();
    const recipe = await resolveFlowMessage({ workspaceId: WS, messageNodeId: NODE, customerId: CUSTOMER, fieldValuesFor: async () => { throw new Error('x'); } }, deps);
    expect(recipe).toBeNull();
  });
  test('collectValues and usableName are exported for the follow-up sender', () => {
    expect(typeof collectValues).toBe('function');
    expect(usableName('  Sara ')).toBe('Sara');
    expect(usableName('+966 50 000 0001')).toBe('');
    expect(usableName('٩٦٦٥٠٠٠٠٠٠٠١')).toBe('');
    expect(usableName(undefined)).toBe('');
  });
});

describe('the flow engine hook is in place (utils/flowScheduler.js)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'flowScheduler.js'), 'utf8');
  test('exactly one bridge call, between the atomic claim and the English code, inside try/catch, writing the returned row', () => {
    expect(source.split('flowBridge').length - 1).toBe(2); // the comment line and the require
    const claim = source.indexOf('if (!claimed) return;');
    const hook = source.indexOf("require('../shared/localization/flowBridge')");
    const english = source.indexOf("let status = 'sent';");
    expect(claim).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(claim);
    expect(english).toBeGreaterThan(hook);
    expect(source.slice(source.lastIndexOf('\n', hook), hook)).toMatch(/try \{ localized = await /);
    expect(source).toMatch(/\} catch \(_\) \{ localized = null; \}/);
    expect(source).toMatch(/if \(localized && localized\.record\) \{\s*await CampaignMessage\.create\(localized\.record\)\.catch\(\(\) => \{\}\);\s*return;\s*\}/);
  });
  // The English row used to be written without a workspaceId (IB-13). Several customers now share this engine, so every row the
  // scheduler writes is stamped with the flow's workspace (delivery callbacks, reports and msgnode_ taps look rows up by it);
  // that stamp is the ONLY change to the English write: every other field is exactly the old one.
  test('the English CampaignMessage write is stamped with the flow\'s workspace and otherwise unchanged', () => {
    const tail = source.slice(source.indexOf("let status = 'sent';"));
    const create = tail.slice(tail.indexOf('CampaignMessage.create('));
    const written = create.slice(0, create.indexOf('.catch'));
    expect(written).toMatch(/\.\.\.stampOf\(flow\)/);
    expect(written.replace(/\.\.\.stampOf\(flow\), \/\/[^\n]*\n\s*/, '').replace(/\s+/g, ' ')).toBe(
      "CampaignMessage.create({ kind: 'flow', flow: flow._id, flowEnrollment: claimed._id, promotion: promotionRef, customer: customer._id, phone: customer.phone, wamid, messageType: 'template', templateName, messageNode, status, statusReason, sentAt: new Date(), })",
    );
  });
});
