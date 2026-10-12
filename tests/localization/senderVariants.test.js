// Unit tests for shared/localization/senderVariants.js: which Arabic version an existing sender uses, and why not.
const variants = require('../../shared/localization/senderVariants');
const {
  id, WS, OTHER_WS, PROMOTION_ID, fakeModel, template, arabicVariant, englishVariant, promotionDoc, OPT_OUT, SHOP_NOW,
} = require('./legacyTestKit');

const NODE = id(100);
const flowButtons = [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقاً' }];
const node = (over = {}) => ({ _id: NODE, workspaceId: WS, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop' }, { position: 1, label: 'Later' }], ...over });
const available = { business: 'Aroma', promotion: { promo_name: 'x', item: 'y', price: 'z', discount: '1', date: 'd' } };

const resolve = (templates, over = {}) => variants.resolveVariant(
  { LocalizedTemplate: fakeModel(templates) },
  { workspaceId: WS, sender: 'promotion', promotion: promotionDoc(), node: null, available, ...over },
);
const promoTemplate = (over = {}) => template({ linkedPromotionId: PROMOTION_ID, ...over });
const nodeTemplate = (over = {}) => template({
  linkedMessageNodeId: NODE, variants: [arabicVariant({ buttons: [...flowButtons, { ...OPT_OUT }] })], ...over,
});

describe('promotion: which template is a candidate', () => {
  test('the promotion-linked version is used; a generic workspace-wide promotion template is NEVER used', async () => {
    const generic = template({ useCase: 'promotion' }); // not linked
    const linked = promoTemplate();
    const choice = await resolve([generic, linked]);
    expect(choice.usable).toBe(true);
    expect(choice.source).toBe('promotion');
    expect(choice.templateId).toBe(String(linked._id));
    const onlyGeneric = await resolve([generic]);
    expect(onlyGeneric.usable).toBe(false);
    expect(onlyGeneric.reason).toBe('no_arabic_version');
    expect(onlyGeneric.source).toBe('none');
  });

  test('archived templates, other workspaces and other promotions are ignored', async () => {
    const choice = await resolve([
      promoTemplate({ archived: true }),
      promoTemplate({ workspaceId: OTHER_WS }),
      promoTemplate({ linkedPromotionId: id(99) }),
    ]);
    expect(choice.reason).toBe('no_arabic_version');
  });

  test('a template with no Arabic version is not a candidate for the Arabic one', async () => {
    const choice = await resolve([promoTemplate({ variants: [englishVariant()] })]);
    expect(choice.reason).toBe('no_arabic_version');
  });

  test('the node-linked version (approved entry node) wins over the promotion-linked one when both are usable', async () => {
    const byNode = nodeTemplate();
    const byPromotion = promoTemplate();
    const choice = await resolve([byPromotion, byNode], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() });
    expect(choice.source).toBe('entry_node');
    expect(choice.templateId).toBe(String(byNode._id));
  });

  test('a node that is not approved is not a candidate at all (the English path would not use it either)', async () => {
    const choice = await resolve([nodeTemplate(), promoTemplate()], { promotion: promotionDoc({ entryNodeId: NODE }), node: null });
    expect(choice.source).toBe('promotion');
  });

  test('a usable version beats a better-ranked unusable one', async () => {
    const pending = nodeTemplate({ variants: [arabicVariant({ buttons: [...flowButtons, { ...OPT_OUT }], metaStatus: 'PENDING' })] });
    const ok = promoTemplate();
    const choice = await resolve([pending, ok], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() });
    expect(choice.source).toBe('promotion');
    expect(choice.usable).toBe(true);
  });

  test('within a rank the newest updatedAt wins, then the _id (sorted in memory, deterministic)', async () => {
    const older = promoTemplate({ updatedAt: new Date('2026-01-01') });
    const newer = promoTemplate({ updatedAt: new Date('2026-06-01') });
    expect((await resolve([older, newer])).templateId).toBe(String(newer._id));
    expect((await resolve([newer, older])).templateId).toBe(String(newer._id));
    const a = promoTemplate({ updatedAt: new Date('2026-06-01') });
    const b = promoTemplate({ updatedAt: new Date('2026-06-01') });
    const big = String(a._id) > String(b._id) ? a : b;
    expect((await resolve([a, b])).templateId).toBe(String(big._id) === String(a._id) ? String(a._id) : String(b._id));
    expect((await resolve([b, a])).templateId).toBe((await resolve([a, b])).templateId);
  });
});

describe('why an Arabic version cannot be used', () => {
  const reasonFor = async (variantOver, templateOver = {}, ctx = {}) => (await resolve([promoTemplate({ variants: [arabicVariant(variantOver)], ...templateOver })], ctx)).reason;

  test.each([
    [{ metaStatus: 'NOT_CREATED' }, 'not_submitted'],
    [{ metaStatus: 'PENDING' }, 'pending'],
    [{ metaStatus: 'REJECTED' }, 'rejected'],
    [{ metaStatus: 'PAUSED' }, 'paused'],
    [{ metaStatus: 'DISABLED' }, 'disabled'],
    [{ reviewStatus: 'draft' }, 'not_reviewed'],
    [{ metaTemplateName: undefined }, 'not_submitted'],
  ])('%j -> %s', async (variantOver, reason) => {
    expect(await reasonFor(variantOver)).toBe(reason);
  });

  test('a MARKETING version without an opt-out button is refused', async () => {
    expect(await reasonFor({ buttons: [{ ...SHOP_NOW }] })).toBe('no_opt_out_button');
    expect(await reasonFor({ buttons: [] })).toBe('no_opt_out_button');
  });

  test('R2-02: a promotion send needs the recipient-visible opt-out button whatever the stored use case / category says (both sources)', async () => {
    for (const useCase of ['order_confirmation', 'booking_reminder', 'payment_reminder']) {
      const noButtons = { buttons: [{ ...SHOP_NOW }] };
      expect(await reasonFor(noButtons, { useCase, category: 'UTILITY' })).toBe('no_opt_out_button');
      expect(await reasonFor({ buttons: [{ ...SHOP_NOW }, { ...OPT_OUT }] }, { useCase, category: 'UTILITY' })).toBeNull();
      const byNode = nodeTemplate({ useCase, category: 'UTILITY', variants: [arabicVariant({ buttons: [...flowButtons] })] });
      expect((await resolve([byNode], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() })).reason).toBe('no_opt_out_button');
      const byNodeOk = nodeTemplate({ useCase, category: 'UTILITY' });
      expect((await resolve([byNodeOk], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() })).reason).toBeNull();
    }
  });

  test('buttons that do not fit the sender are refused: a flow button on a promotion-linked version, a shop_now on a node-linked one', async () => {
    expect(await reasonFor({ buttons: [{ role: 'flow_button', text: 'x' }, { ...OPT_OUT }] })).toBe('buttons_mismatch');
    expect(await reasonFor({ buttons: [{ role: 'opt_in', text: 'x' }, { ...OPT_OUT }] })).toBe('buttons_mismatch');
    const wrongNode = nodeTemplate({ variants: [arabicVariant({ buttons: [{ ...SHOP_NOW }, { ...OPT_OUT }] })] });
    expect((await resolve([wrongNode], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() })).reason).toBe('buttons_mismatch');
  });

  test('a node-linked version must keep the node\'s flow buttons (count and order)', async () => {
    const oneButton = nodeTemplate({ variants: [arabicVariant({ buttons: [flowButtons[0], { ...OPT_OUT }] })] });
    expect((await resolve([oneButton], { promotion: promotionDoc({ entryNodeId: NODE }), node: node() })).reason).toBe('buttons_mismatch');
  });

  test('a merge field the sender cannot fill names the first missing one', async () => {
    expect(await reasonFor({ body: 'أهلاً {name}، ينتهي العرض {order_id} نهاية الشهر' })).toBe('field_values_missing:order_id');
    const noDate = { business: 'Aroma', promotion: { promo_name: 'x', item: 'y' } };
    expect(await reasonFor({ body: 'أهلاً {name}، ينتهي العرض في {date} وهو عرضنا الجميل' }, {}, { available: noDate })).toBe('field_values_missing:date');
    const noBusiness = { business: '', promotion: available.promotion };
    expect(await reasonFor({ body: 'مرحباً {name} من {business} وهذا عرضنا' }, {}, { available: noBusiness })).toBe('field_values_missing:business');
  });

  test('the choice carries what the plan shows', async () => {
    const choice = await resolve([promoTemplate({ name: 'Eid promo', variants: [arabicVariant({ metaStatus: 'PENDING' })] })]);
    expect(variants.describeChoice(choice)).toEqual({
      source: 'promotion', templateId: expect.any(String), templateName: 'Eid promo', language: 'ar', metaStatus: 'PENDING', reviewStatus: 'reviewed',
      sendable: false, notSendableReason: 'pending', hasOptOut: true, hasShopButton: true, missingFields: [],
    });
    const none = variants.describeChoice(await resolve([]));
    expect(none.source).toBe('none');
    expect(none.sendable).toBe(false);
    expect(none.notSendableReason).toBe('no_arabic_version');
  });
});

describe('loyalty reminder and consent request', () => {
  const loyalty = (templates, ctx = {}) => variants.resolveVariant({ LocalizedTemplate: fakeModel(templates) }, {
    workspaceId: WS, sender: 'loyalty_reminder', available: { business: 'Aroma', promotion: null }, ...ctx,
  });
  const consent = (templates, ctx = {}) => variants.resolveVariant({ LocalizedTemplate: fakeModel(templates) }, {
    workspaceId: WS, sender: 'consent_request', available: { business: 'Aroma', promotion: null }, ...ctx,
  });
  const balance = (over = {}) => template({
    useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount} هذا الشهر', buttons: [{ ...OPT_OUT }] })], ...over,
  });

  test('the library loyalty_reminder uses {date} nobody can supply: not usable; loyalty_reminder_balance is', async () => {
    const dated = template({ useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'رصيدك {points} استبدله قبل {date} واستمتع بمكافأتك', buttons: [{ ...OPT_OUT }] })] });
    const choice = await loyalty([dated]);
    expect(choice.usable).toBe(false);
    expect(choice.reason).toBe('field_values_missing:date');
    expect(choice.missingFields).toEqual(['date']);
    const both = await loyalty([dated, balance()]);
    expect(both.usable).toBe(true);
    expect(both.templateId).not.toBe(String(dated._id));
  });

  test('loyalty_reminder is preferred over points_balance; linked templates are never standalone reminders', async () => {
    const reminder = balance();
    const points = balance({ useCase: 'points_balance' });
    expect((await loyalty([points, reminder])).templateId).toBe(String(reminder._id));
    expect((await loyalty([points])).templateId).toBe(String(points._id));
    expect((await loyalty([balance({ linkedMessageNodeId: NODE }), balance({ linkedPromotionId: PROMOTION_ID })])).reason).toBe('no_arabic_version');
  });

  test('a loyalty button other than opt_out is refused', async () => {
    const bad = balance({ variants: [arabicVariant({ body: 'أهلاً {name}، رصيدك {points} وقيمته {amount} اليوم', buttons: [{ ...SHOP_NOW }, { ...OPT_OUT }] })] });
    expect((await loyalty([bad])).reason).toBe('buttons_mismatch');
  });

  test('consent request: an unlinked welcome_optin template with BOTH the opt-in and the decline button', async () => {
    const ask = template({
      useCase: 'welcome_optin', variants: [arabicVariant({ body: 'مرحباً {name}، هل تود أن تصلك عروضنا؟ نسعد بخدمتك دائماً', footer: undefined, buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }] })],
    });
    expect((await consent([ask])).usable).toBe(true);
    const onlyYes = template({ useCase: 'welcome_optin', variants: [arabicVariant({ body: 'مرحباً {name}، هل تود أن تصلك عروضنا؟ نسعد بخدمتك', buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }] })] });
    expect((await consent([onlyYes])).reason).toBe('no_consent_buttons');
    const promo = template({ useCase: 'welcome_optin', variants: [arabicVariant({ body: 'مرحباً {name}، عرض خاص لك اليوم فقط عندنا', buttons: [{ ...OPT_OUT }] })] });
    expect((await consent([promo])).reason).toBe('no_consent_buttons'); // the consent exemption is only earned by the ask itself
  });
});

describe('button payloads', () => {
  const promotion = promotionDoc();
  const base = (variantOver) => ({ choice: { source: 'promotion', variant: arabicVariant(variantOver) }, sender: 'promotion', promotion });

  test('promotion-linked: shop_now -> promo_<id> (the English announcement payload), opt_out -> optout_<id>', () => {
    expect(variants.buttonPayloads(base({}))).toEqual([`promo_${PROMOTION_ID}`, `optout_${PROMOTION_ID}`]);
  });

  test('test mode swaps the opt-out for an inert payload that no webhook branch dispatches on', () => {
    const payloads = variants.buttonPayloads({ ...base({}), testMode: true });
    expect(payloads).toEqual([`promo_${PROMOTION_ID}`, 'l10ntest_optout']);
    expect(payloads[1]).not.toMatch(/^optout_/);
  });

  test('entry node: the node\'s own button positions; url buttons carry no payload', () => {
    const choice = { source: 'entry_node', variant: arabicVariant({ buttons: [...flowButtons, { ...OPT_OUT }, { role: 'url', text: 'x', url: 'https://x.test' }] }) };
    const nodeDoc = { _id: NODE, buttons: [{ position: 0 }, { position: 2 }] };
    expect(variants.buttonPayloads({ choice, sender: 'promotion', promotion, node: nodeDoc })).toEqual([`msgnode_${NODE}_0`, `msgnode_${NODE}_2`, `optout_${PROMOTION_ID}`, undefined]);
    expect(variants.buttonPayloads({ choice, sender: 'promotion', promotion, node: { _id: NODE, buttons: [{ position: 0 }] } })).toBeNull();
  });

  test('loyalty and consent payloads', () => {
    expect(variants.buttonPayloads({ choice: { source: 'unlinked', variant: arabicVariant({ buttons: [{ ...OPT_OUT }] }) }, sender: 'loyalty_reminder' })).toEqual(['optout_loyalty_reminder']);
    const customer = { _id: id(7) };
    const ask = { source: 'unlinked', variant: arabicVariant({ buttons: [{ role: 'opt_in', text: 'a' }, { role: 'decline', text: 'b' }] }) };
    expect(variants.buttonPayloads({ choice: ask, sender: 'consent_request', customer })).toEqual([`consent_yes_${id(7)}`, `consent_no_${id(7)}`]);
    expect(variants.buttonPayloads({ choice: ask, sender: 'consent_request' })).toBeNull(); // no customer: never a dead consent button
    expect(variants.buttonPayloads({ choice: { source: 'unlinked', variant: arabicVariant({ buttons: [{ ...SHOP_NOW }] }) }, sender: 'loyalty_reminder' })).toBeNull();
  });
});
