// Unit tests for shared/localization/legacySenders.js: the per-customer Arabic seam the existing senders call.
// Fakes for the models, a jest.fn transport; the decision code, the variant rules and the Meta component builder
// are the REAL ones, so the asserted payloads are what would go to Meta.
const legacy = require('../../shared/localization/legacySenders');
const {
  id, WS, OTHER_WS, PROMOTION_ID, template, arabicVariant, promotionDoc, productDoc, customerDoc, world, OPT_OUT, SHOP_NOW,
} = require('./legacyTestKit');

const NODE = id(100);
const linked = (over = {}) => template({ linkedPromotionId: PROMOTION_ID, ...over });
const promotionArgs = (w, over = {}) => ({ sender: 'promotion', workspaceId: WS, promotion: promotionDoc(), items: [productDoc()], ...over });

// A world with `n` Arabic customers (default language ar via CustomerLanguage) and one linked, approved+reviewed Arabic version.
function arabicWorld({ customers, extra = {} } = {}) {
  const docs = customers || [customerDoc({ firstname: 'سارة' })];
  const languages = Object.fromEntries(docs.map((c) => [String(c._id), 'ar']));
  return { docs, ...world({ customers: docs, languages, templates: [linked()], ...extra }) };
}

describe('begin: null (the existing code runs untouched) unless the merchant has Arabic on AND an Arabic customer is in the batch', () => {
  test('kill switch, flag off, no Arabic customer, nobody at all, a database error', async () => {
    const w = arabicWorld();
    w.deps.settings.killSwitchOn.mockReturnValue(true);
    expect(await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps)).toBeNull();
    expect(w.deps.settings.isArabicEnabled).not.toHaveBeenCalled();

    const off = arabicWorld({ extra: { flagged: [] } });
    expect(await legacy.begin(promotionArgs(off, { customers: off.docs }), off.deps)).toBeNull();

    const english = world({ customers: [customerDoc(), customerDoc()], templates: [linked()] });
    const englishDocs = english.deps.Customer.docs;
    expect(await legacy.begin(promotionArgs(english, { customers: englishDocs }), english.deps)).toBeNull();
    expect(english.deps.LocalizedLegacySend.create).not.toHaveBeenCalled();

    expect(await legacy.begin(promotionArgs(w, { customers: [] }), w.deps)).toBeNull();
    expect(await legacy.begin(promotionArgs(w, { customers: undefined }), w.deps)).toBeNull();

    const broken = arabicWorld();
    broken.deps.settings.isArabicEnabled.mockRejectedValue(new Error('db down'));
    expect(await legacy.begin(promotionArgs(broken, { customers: broken.docs }), broken.deps)).toBeNull();
    expect(broken.deps.log).toHaveBeenCalled();
    expect(await legacy.begin({ sender: 'nope', customers: broken.docs }, broken.deps)).toBeNull();
  });

  test('a merchant default of Arabic makes customers without a stored language Arabic; an English choice stays English', async () => {
    const own = customerDoc({ firstname: 'Ali' });
    const stored = customerDoc({ firstname: 'Bob' });
    const w = world({ customers: [own, stored], languages: { [stored._id]: 'en' }, templates: [linked()], settingsByWs: { [WS]: { defaultCustomerLanguage: 'ar' } } });
    const run = await legacy.begin(promotionArgs(w, { customers: w.deps.Customer.docs }), w.deps);
    expect(run).not.toBeNull();
    expect(run.isArabic(own)).toBe(true);
    expect(run.isArabic(stored)).toBe(false);
    expect(run.arabicCount).toBe(1);
  });

  test('a batch spanning workspaces: only the flagged workspace\'s Arabic customers count', async () => {
    const mine = customerDoc({ firstname: 'سارة' });
    const theirs = customerDoc({ firstname: 'خالد', workspaceId: OTHER_WS });
    const w = world({ customers: [mine, theirs], languages: { [mine._id]: 'ar', [theirs._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { workspaceId: undefined, customers: [mine, theirs] }), w.deps);
    expect(run.isArabic(mine)).toBe(true);
    expect(run.isArabic(theirs)).toBe(false);
    expect(await run.trySend(theirs)).toBeNull();
    expect(w.sent).toHaveLength(0);
  });
});

describe('promotion: the Arabic send', () => {
  test('an Arabic customer gets the approved+reviewed Arabic template: language code, body params in the variant order, buttons', async () => {
    const w = arabicWorld({ customers: [customerDoc({ firstname: 'سارة', phone: '+966 50 000 1000' })] });
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    const out = await run.trySend(w.docs[0]);
    expect(out).toEqual({ sent: true, result: expect.any(Object), messageType: 'template', templateName: 'wf_0000a1_promo_ar_v1', usedLanguage: 'ar' });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toEqual({
      to: '966500001000', // normalised international digits
      name: 'wf_0000a1_promo_ar_v1',
      languageCode: 'ar',
      components: [
        { type: 'body', parameters: [{ type: 'text', text: 'سارة' }, { type: 'text', text: 'Coffee beans' }, { type: 'text', text: '40.00 ر.س' }, { type: 'text', text: 'Summer Sale' }] },
        { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: `promo_${PROMOTION_ID}` }] },
        { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: `optout_${PROMOTION_ID}` }] },
      ],
    });
    // the sidecar row records the language and the wamid; nothing is written to CampaignMessage here (the caller does that)
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ sender: 'promotion', refId: PROMOTION_ID, usedLanguage: 'ar', status: 'sent', wamid: 'wamid.1', via: 'template', metaTemplateName: 'wf_0000a1_promo_ar_v1' });
    expect(w.campaignMessages).toHaveLength(0);
  });

  test('an English customer in the same run gets null (the unchanged English path) and no sidecar row', async () => {
    const arabic = customerDoc({ firstname: 'سارة' });
    const english = customerDoc({ firstname: 'Bob' });
    const w = world({ customers: [arabic, english], languages: { [arabic._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [arabic, english] }), w.deps);
    expect(await run.trySend(english)).toBeNull();
    await run.record(english, { sent: true, result: { messages: [{ id: 'w.en' }] } });
    expect(await run.trySend(arabic)).toMatchObject({ sent: true });
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0].customerId).toBe(arabic._id);
    expect(run.summary().languageCounts).toEqual({ ar: 1, en: 1 });
  });

  test('mixed Arabic/English text: a Latin first name inside the Arabic body is passed through unchanged', async () => {
    const w = arabicWorld({ customers: [customerDoc({ firstname: 'Sara' })] });
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    await run.trySend(w.docs[0]);
    expect(w.sent[0].components[0].parameters[0].text).toBe('Sara');
  });

  test('a phone-number name, a 70-character name and an emoji name are all safe parameter values', async () => {
    const docs = [customerDoc({ firstname: '966501234567' }), customerDoc({ firstname: 'م'.repeat(70) }), customerDoc({ firstname: '😀 Omar' })];
    const w = arabicWorld({ customers: docs });
    const run = await legacy.begin(promotionArgs(w, { customers: docs }), w.deps);
    for (const c of docs) await run.trySend(c);
    const names = w.sent.map((s) => s.components[0].parameters[0].text);
    expect(names[0]).toBe('عميلنا العزيز');
    expect(Array.from(names[1])).toHaveLength(60);
    expect(names[2]).toBe('😀 Omar');
  });

  test('the points promotion fills the Arabic points phrase', async () => {
    const promotion = promotionDoc({ customerType: 'points', pointsPrice: 5, discountPercent: 0 });
    const w = arabicWorld();
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs, promotion }), w.deps);
    await run.trySend(w.docs[0]);
    expect(w.sent[0].components[0].parameters[2].text).toBe('5 نقاط');
  });

  test('items are resolved by the seam when the caller did not pass them (the plan / test send path)', async () => {
    const w = arabicWorld({ extra: { items: [productDoc({ workspaceId: WS, active: true })] } });
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs, items: null }), w.deps);
    expect(await run.trySend(w.docs[0])).toMatchObject({ sent: true });
    expect(w.sent[0].components[0].parameters[1].text).toBe('Coffee beans');
  });

  test('a node-linked version (approved entry node) sends the node\'s flow-button payloads and the opt-out of the promotion', async () => {
    const entry = { _id: NODE, workspaceId: WS, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop' }, { position: 1, label: 'Later' }] };
    const nodeTemplate = template({
      linkedMessageNodeId: NODE,
      variants: [arabicVariant({ body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name}', buttons: [{ role: 'flow_button', text: 'تسوق' }, { role: 'flow_button', text: 'لاحقاً' }, { ...OPT_OUT }] })],
    });
    const c = customerDoc({ firstname: 'سارة' });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [nodeTemplate, linked()], nodes: [entry] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c], promotion: promotionDoc({ entryNodeId: NODE }) }), w.deps);
    await run.trySend(c);
    expect(w.sent[0].name).toBe(nodeTemplate.variants[0].metaTemplateName);
    expect(w.sent[0].components.filter((x) => x.type === 'button').map((x) => x.parameters[0].payload)).toEqual([`msgnode_${NODE}_0`, `msgnode_${NODE}_1`, `optout_${PROMOTION_ID}`]);
    expect(run.summary().localization.template).toMatchObject({ id: String(nodeTemplate._id) });
  });

  test('the entry node is not approved: the promotion-linked version is used instead', async () => {
    const entry = { _id: NODE, workspaceId: WS, templateStatus: 'pending', buttons: [{ position: 0 }] };
    const nodeTemplate = template({ linkedMessageNodeId: NODE, variants: [arabicVariant({ buttons: [{ role: 'flow_button', text: 'تسوق' }, { ...OPT_OUT }] })] });
    const c = customerDoc();
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [nodeTemplate, linked()], nodes: [entry] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c], promotion: promotionDoc({ entryNodeId: NODE }) }), w.deps);
    await run.trySend(c);
    expect(w.sent[0].components.filter((x) => x.type === 'button')[0].parameters[0].payload).toBe(`promo_${PROMOTION_ID}`);
  });
});

describe('fallback to English: spec 3.2 (never blocked, always recorded)', () => {
  const fallbackFor = async (variantOver, { templateOver = {}, promotionOver = {} } = {}) => {
    const c = customerDoc({ firstname: 'سارة' });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [linked({ variants: [arabicVariant(variantOver)], ...templateOver })] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c], promotion: promotionDoc(promotionOver) }), w.deps);
    const out = await run.trySend(c);
    await run.record(c, { sent: true, result: { messages: [{ id: 'wamid.en1' }] } });
    return { out, w, run, c };
  };

  test.each([
    [{ metaStatus: 'PENDING' }, 'pending'],
    [{ metaStatus: 'REJECTED' }, 'rejected'],
    [{ reviewStatus: 'draft' }, 'not_reviewed'],
    [{ buttons: [{ ...SHOP_NOW }] }, 'no_opt_out_button'],
    [{ buttons: [{ role: 'flow_button', text: 'x' }, { ...OPT_OUT }] }, 'buttons_mismatch'],
    [{ body: 'أهلاً {name}، ينتهي العرض في {order_id} ولا تفوّته' }, 'field_values_missing:order_id'],
  ])('%j -> English with reason %s', async (variantOver, reason) => {
    const { out, w, run } = await fallbackFor(variantOver);
    expect(out).toBeNull();
    expect(w.sent).toHaveLength(0); // nothing went out through the Arabic transport
    expect(w.rows).toHaveLength(1);
    expect(w.rows[0]).toMatchObject({ usedLanguage: 'en', fallback: true, fallbackReason: reason, status: 'sent', wamid: 'wamid.en1', via: 'existing' });
    expect(run.summary().localization.fallbackToEnglish).toEqual([{ reason, count: 1 }]);
    expect(run.summary().languageCounts).toEqual({ ar: 0, en: 1 });
  });

  test('no Arabic version at all, no linked template, and a workspace mismatch all fall back with a reason', async () => {
    const c = customerDoc();
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c] }), w.deps);
    expect(await run.trySend(c)).toBeNull();
    expect(run.summary().localization.fallbackToEnglish).toEqual([{ reason: 'no_arabic_version', count: 1 }]);
    const other = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [linked()] });
    const run2 = await legacy.begin(promotionArgs(other, { customers: [c], promotion: promotionDoc({ workspaceId: OTHER_WS }) }), other.deps);
    expect(await run2.trySend(c)).toBeNull();
    expect(run2.summary().localization.fallbackToEnglish).toEqual([{ reason: 'workspace_mismatch', count: 1 }]);
  });

  test('an invalid phone, an erased customer and a demo customer are never sent in Arabic (English path decides)', async () => {
    const docs = [customerDoc({ phone: '0551234567' }), customerDoc({ deletedAt: new Date() }), customerDoc({ isDemo: true })];
    const w = arabicWorld({ customers: docs });
    const run = await legacy.begin(promotionArgs(w, { customers: docs }), w.deps);
    for (const c of docs) expect(await run.trySend(c)).toBeNull();
    expect(w.sent).toHaveLength(0);
    expect(run.summary().localization.fallbackToEnglish.map((f) => f.reason).sort()).toEqual(['deleted', 'demo', 'invalid_phone']);
  });

  test('a demo promotion keeps every customer on the English (simulated) path, unless the demo page explicitly allows a real send', async () => {
    const w = arabicWorld();
    // simulated demo data never makes the run "Arabic": no run at all, so no new response keys and no sidecar rows
    expect(await legacy.begin(promotionArgs(w, { customers: w.docs, promotion: promotionDoc({ isDemo: true }) }), w.deps)).toBeNull();
    const demoCustomer = arabicWorld({ customers: [customerDoc({ isDemo: true })] });
    expect(await legacy.begin(promotionArgs(demoCustomer, { customers: demoCustomer.docs }), demoCustomer.deps)).toBeNull();
    expect(await legacy.begin({ sender: 'loyalty_reminder', workspaceId: WS, customers: demoCustomer.docs }, demoCustomer.deps)).toBeNull();
    // ...but a demo customer next to a real Arabic one is still never sent in Arabic
    const mixed = arabicWorld({ customers: [customerDoc({ isDemo: true }), customerDoc({ firstname: 'سارة' })] });
    const mixedRun = await legacy.begin(promotionArgs(mixed, { customers: mixed.docs }), mixed.deps);
    expect(await mixedRun.trySend(mixed.docs[0])).toBeNull();
    expect(mixed.sent).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
    const real = arabicWorld();
    const run2 = await legacy.begin(promotionArgs(real, { customers: real.docs, promotion: promotionDoc({ isDemo: true }), allowRealDemoSend: true }), real.deps);
    expect(await run2.trySend(real.docs[0])).toMatchObject({ sent: true });
  });

  test('a decision that throws before any send falls back to English (fail-open) and is recorded as internal_error', async () => {
    const w = arabicWorld();
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    w.deps.LocalizedTemplate.find.mockImplementation(() => { throw new Error('db down'); });
    expect(await run.trySend(w.docs[0])).toBeNull();
    expect(run.summary().localization.fallbackToEnglish).toEqual([{ reason: 'internal_error', count: 1 }]);
  });
});

describe('same-phone opt-out exclusion (rule 7)', () => {
  const optedOutSibling = (phone) => customerDoc({ firstname: 'Old record', phone, optedOut: true, marketingConsent: false });

  test.each([
    ['966501110000', '+966 50 111 0000'],
    ['+966501110000', '00966501110000'],
    ['966 50 111 0000', '٩٦٦٥٠١١١٠٠٠٠'],
    ['(966) 501-110-000', '966501110000'],
  ])('an Arabic customer whose number is opted out on another record (%s / %s) is excluded: nothing is sent, not even English', async (stored, typed) => {
    const c = customerDoc({ firstname: 'سارة', phone: typed });
    const sibling = optedOutSibling(stored);
    const w = world({ customers: [c, sibling], languages: { [c._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c] }), w.deps);
    expect(await run.trySend(c)).toEqual({ skip: true, reason: 'opted_out_same_phone' });
    expect(w.sent).toHaveLength(0);
    expect(w.rows[0]).toMatchObject({ status: 'skipped', errorCode: 'opted_out_same_phone', usedLanguage: 'ar' });
    expect(run.summary().localization.excludedOptedOutPhone).toBe(1);
  });

  test('an English customer with the same situation keeps today\'s behaviour (null)', async () => {
    const arabic = customerDoc({ firstname: 'سارة' });
    const english = customerDoc({ firstname: 'Bob', phone: '966501110000' });
    const w = world({ customers: [arabic, english, optedOutSibling('966501110000')], languages: { [arabic._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [arabic, english] }), w.deps);
    expect(await run.trySend(english)).toBeNull();
  });

  test('the opted-out set is another workspace\'s: not an exclusion', async () => {
    const c = customerDoc({ firstname: 'سارة', phone: '966501110000' });
    const foreign = customerDoc({ phone: '966501110000', optedOut: true, workspaceId: OTHER_WS });
    const w = world({ customers: [c, foreign], languages: { [c._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c] }), w.deps);
    expect(await run.trySend(c)).toMatchObject({ sent: true });
  });
});

describe('same-phone exclusion uses the H1 spelling rules (review R2-03)', () => {
  const optedOutSibling = (phone) => customerDoc({ firstname: 'Old record', phone, optedOut: true, marketingConsent: false });

  test.each(['0501110000', '501110000', '05 0111 0000', '00966501110000'])('a sibling stored as %s excludes the Arabic customer 966501110000', async (stored) => {
    const c = customerDoc({ firstname: 'سارة', phone: '966501110000' });
    const w = world({ customers: [c, optedOutSibling(stored)], languages: { [c._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c] }), w.deps);
    expect(await run.trySend(c)).toEqual({ skip: true, reason: 'opted_out_same_phone' });
    expect(w.sent).toHaveLength(0);
    expect(run.excludes(c)).toBe(true);
  });

  test('referral excludes() applies the same rule, with one bulk read of the opted-out records per run', async () => {
    const c = customerDoc({ firstname: 'سارة', phone: '966501110000' });
    const w = world({ customers: [c, optedOutSibling('0501110000')], languages: { [c._id]: 'ar' }, templates: [linked()] });
    const run = await legacy.begin(promotionArgs(w, { customers: [c], sender: 'referral_link' }), w.deps);
    const optedOutReads = () => w.deps.Customer.find.mock.calls.filter(([filter]) => filter && filter.optedOut === true).length;
    expect(run.excludes(c)).toBe(true);
    expect(run.excludes(c)).toBe(true);
    expect(optedOutReads()).toBe(1);
  });

  test('the workspace default country code decides what a local number means (61: 0501110000 is 61501110000, not the Saudi customer)', async () => {
    const c = customerDoc({ firstname: 'سارة', phone: '966501110000' });
    const w = world({ customers: [c, optedOutSibling('0501110000')], languages: { [c._id]: 'ar' }, templates: [linked()] });
    w.deps.Settings.docs[0].defaultCountryCode = '61';
    const run = await legacy.begin(promotionArgs(w, { customers: [c] }), w.deps);
    expect(await run.trySend(c)).toMatchObject({ sent: true });
  });
});

describe('no phone number is stored on the sidecar rows (review R4-3)', () => {
  const metaError = (code, message) => Object.assign(new Error(message), { response: { data: { error: { code, message } } } });

  test('sent, failed and skipped rows carry customerId only; the stored error text is scrubbed of phone numbers', async () => {
    const sent = customerDoc({ firstname: 'سارة', phone: '966501110001' });
    const failed = customerDoc({ firstname: 'ليلى', phone: '966501110002' });
    const skipped = customerDoc({ firstname: 'منى', phone: '966501110003' });
    const sibling = customerDoc({ firstname: 'Old', phone: '0501110003', optedOut: true, marketingConsent: false });
    const w = world({ customers: [sent, failed, skipped, sibling], languages: { [sent._id]: 'ar', [failed._id]: 'ar', [skipped._id]: 'ar' }, templates: [linked()] });
    w.transport.sendTemplate.mockResolvedValueOnce({ messages: [{ id: 'wamid.1' }] });
    w.transport.sendTemplate.mockRejectedValueOnce(metaError(131026, 'Recipient +966 50 111 0002 (966501110002) is undeliverable'));
    const run = await legacy.begin(promotionArgs(w, { customers: [sent, failed, skipped] }), w.deps);
    await run.trySend(sent); const out = await run.trySend(failed); await run.trySend(skipped);
    expect(w.rows.map((r) => r.status)).toEqual(['sent', 'failed', 'skipped']);
    for (const row of w.rows) { expect(Object.keys(row)).not.toContain('phone'); expect(String(row.customerId)).toBeTruthy(); }
    expect(JSON.stringify(w.rows)).not.toMatch(/9665011100|0501110003/);
    expect(w.rows[1].error).toBe('Recipient [number] ([number]) is undeliverable');
    expect(out.failReason).not.toMatch(/\d{7}/);
  });

  test('the model has no phone field', () => {
    expect(require('../../models/LocalizedLegacySend').schema.path('phone')).toBeUndefined();
  });
});

describe('failures: nothing falls back to English after an Arabic send was attempted (G3)', () => {
  const metaError = (code, message = 'Meta says no') => Object.assign(new Error(message), { response: { data: { error: { code, message } } } });

  test('a failed Arabic send is reported as { sent: false, failReason } and recorded; trySend never throws', async () => {
    const w = arabicWorld();
    w.transport.sendTemplate.mockRejectedValueOnce(metaError(131026, 'Message undeliverable'));
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    const out = await run.trySend(w.docs[0]);
    expect(out).toMatchObject({ sent: false, result: null, messageType: 'template', failReason: 'Message undeliverable', usedLanguage: 'ar' });
    expect(w.transport.sendTemplate).toHaveBeenCalledTimes(1);
    expect(w.rows[0]).toMatchObject({ status: 'failed', errorCode: '131026', usedLanguage: 'ar' });
    expect(run.summary().localization).toMatchObject({ arabicSent: 0, arabicFailed: 1 });
    // record() after the caller's own bookkeeping must not create a second row for an Arabic attempt
    await run.record(w.docs[0], { sent: false, result: null, failReason: 'Message undeliverable' });
    expect(w.rows).toHaveLength(1);
  });

  test('a timeout is a failure too (the message may or may not have been delivered)', async () => {
    const w = arabicWorld();
    w.deps.sendTimeoutMs = 20;
    w.transport.sendTemplate.mockImplementationOnce(() => new Promise(() => {}));
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    const out = await run.trySend(w.docs[0]);
    expect(out.sent).toBe(false);
    expect(out.failReason).toMatch(/did not answer in time/);
    expect(w.rows[0]).toMatchObject({ status: 'failed', errorCode: 'timeout' });
  });

  test('template-level stop: three consecutive 1320xx errors stop the remaining Arabic customers (skipped, not sent, not English)', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => customerDoc({ firstname: `عميل${i}` }));
    const w = arabicWorld({ customers: docs });
    w.transport.sendTemplate.mockRejectedValue(metaError(132001, 'Template does not exist'));
    const run = await legacy.begin(promotionArgs(w, { customers: docs }), w.deps);
    const outs = [];
    for (const c of docs) outs.push(await run.trySend(c));
    expect(outs.slice(0, 3).every((o) => o.sent === false)).toBe(true);
    expect(outs.slice(3).every((o) => o.skip === true && o.reason === 'template_unusable:132001')).toBe(true);
    expect(w.transport.sendTemplate).toHaveBeenCalledTimes(3);
    expect(run.summary().localization.stopped).toBe('template_unusable:132001');
    expect(w.rows.filter((r) => r.status === 'skipped')).toHaveLength(3);
  });

  test('a success or another kind of error resets the streak', async () => {
    const docs = Array.from({ length: 6 }, (_, i) => customerDoc({ firstname: `عميل${i}` }));
    const w = arabicWorld({ customers: docs });
    w.transport.sendTemplate
      .mockRejectedValueOnce(metaError(132001)).mockRejectedValueOnce(metaError(132012))
      .mockResolvedValueOnce({ messages: [{ id: 'ok1' }] })
      .mockRejectedValueOnce(metaError(132015)).mockRejectedValueOnce(metaError(131026)).mockRejectedValueOnce(metaError(132016));
    const run = await legacy.begin(promotionArgs(w, { customers: docs }), w.deps);
    for (const c of docs) expect(await run.trySend(c)).not.toHaveProperty('skip');
    expect(run.summary().localization.stopped).toBeUndefined();
  });

  test('a rate-limit code adds the campaign sender\'s 5 second back-off', async () => {
    const w = arabicWorld();
    w.transport.sendTemplate.mockRejectedValueOnce(metaError(130429, 'rate limit hit'));
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    await run.trySend(w.docs[0]);
    expect(w.deps.sleep).toHaveBeenCalledWith(5000);
  });

  test('LOCALIZATION_SEND_MODE=dry_run goes through the same transport (nothing is sent to Meta)', async () => {
    const w = arabicWorld();
    w.transport.isDryRun.mockReturnValue(true);
    w.transport.sendTemplate.mockResolvedValueOnce({ dryRun: true, messages: [{ id: 'dryrun.1.x' }] });
    const run = await legacy.begin(promotionArgs(w, { customers: w.docs }), w.deps);
    expect(await run.trySend(w.docs[0])).toMatchObject({ sent: true });
    expect(w.rows[0].wamid).toBe('dryrun.1.x');
  });
});

describe('loyalty reminder', () => {
  const balance = (over = {}) => template({
    useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount} هذا الشهر', buttons: [{ ...OPT_OUT }], metaTemplateName: 'wf_balance_ar_v1' })], ...over,
  });

  test('name, points and amount (points / 10 in SAR); the opt-out payload is optout_loyalty_reminder', async () => {
    const c = customerDoc({ firstname: 'سارة', loyaltyPoints: 125 });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [balance()] });
    const run = await legacy.begin({ sender: 'loyalty_reminder', workspaceId: WS, customers: [c] }, w.deps);
    const out = await run.trySend(c);
    expect(out).toMatchObject({ sent: true, templateName: 'wf_balance_ar_v1', messageType: 'template' });
    expect(w.sent[0].components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'سارة' }, { type: 'text', text: '125' }, { type: 'text', text: '12.50 ر.س' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'optout_loyalty_reminder' }] },
    ]);
  });

  test('the library loyalty_reminder ({date}) cannot be filled: English, with the reason', async () => {
    const dated = template({ useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'رصيدك {points} استبدله قبل {date} واستمتع بمكافأتك', buttons: [{ ...OPT_OUT }] })] });
    const c = customerDoc();
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [dated] });
    const run = await legacy.begin({ sender: 'loyalty_reminder', workspaceId: WS, customers: [c] }, w.deps);
    expect(await run.trySend(c)).toBeNull();
    expect(run.summary().localization.fallbackToEnglish).toEqual([{ reason: 'field_values_missing:date', count: 1 }]);
  });
});

describe('consent request', () => {
  const ask = () => template({
    useCase: 'welcome_optin',
    variants: [arabicVariant({ body: 'مرحباً {name}، هل تود أن تصلك عروضنا وتحديثاتنا عبر واتساب؟ يسعدنا ذلك', footer: undefined, metaTemplateName: 'wf_ask_ar_v1', buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }] })],
  });

  test('sends the Arabic ask with consent_yes_/consent_no_ payloads, stamps the ask and writes the consent_request CampaignMessage', async () => {
    const c = customerDoc({ firstname: 'سارة', marketingConsent: false });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [ask()] });
    const run = await legacy.begin({ sender: 'consent_request', workspaceId: WS, customers: [c] }, w.deps);
    const out = await run.trySend(c);
    expect(out).toMatchObject({ sent: true, templateName: 'wf_ask_ar_v1' });
    expect(w.sent[0].components.filter((x) => x.type === 'button').map((x) => x.parameters[0].payload)).toEqual([`consent_yes_${c._id}`, `consent_no_${c._id}`]);
    expect(w.deps.Customer.updateOne).toHaveBeenCalledWith({ _id: c._id, marketingConsent: { $ne: true }, workspaceId: WS }, { $set: { marketingConsentAskedAt: expect.any(Date) } });
    expect(w.campaignMessages).toHaveLength(1);
    expect(w.campaignMessages[0]).toMatchObject({ kind: 'consent_request', customer: c._id, wamid: 'wamid.1', messageType: 'template', templateName: 'wf_ask_ar_v1', status: 'sent' });
  });

  test('a rehearsal (dry run) changes no customer state', async () => {
    const c = customerDoc({ marketingConsent: false });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [ask()] });
    w.transport.isDryRun.mockReturnValue(true);
    const run = await legacy.begin({ sender: 'consent_request', workspaceId: WS, customers: [c] }, w.deps);
    expect(await run.trySend(c)).toMatchObject({ sent: true });
    expect(w.deps.Customer.updateOne).not.toHaveBeenCalled();
    expect(w.campaignMessages).toHaveLength(0);
  });

  test('without an Arabic ask template the English template stays (null)', async () => {
    const c = customerDoc({ marketingConsent: false });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' }, templates: [] });
    const run = await legacy.begin({ sender: 'consent_request', workspaceId: WS, customers: [c] }, w.deps);
    expect(await run.trySend(c)).toBeNull();
    await run.record(c, { sent: true, result: { messages: [{ id: 'w1' }] } });
    expect(w.rows[0]).toMatchObject({ usedLanguage: 'en', fallback: true, fallbackReason: 'no_arabic_version', sender: 'consent_request' });
  });
});

describe('referral link text', () => {
  const referralPromotion = { _id: id(77), workspaceId: WS, friendRewardType: 'percent_discount', friendRewardValue: 10, referrerRewardType: 'loyalty_points', referrerRewardValue: 50 };
  const code = { shortUrl: 'https://app.test/r/ABC123' };

  test('an Arabic customer gets the Arabic text with the opt-out hint line and ?lang=ar; an English customer gets null', async () => {
    const arabic = customerDoc({ firstname: 'سارة' });
    const english = customerDoc({ firstname: 'Bob' });
    const w = world({ customers: [arabic, english], languages: { [arabic._id]: 'ar' }, templates: [] });
    const run = await legacy.begin({ sender: 'referral_link', workspaceId: WS, customers: [arabic, english], promotion: referralPromotion }, w.deps);
    const body = await run.referralBody(arabic, referralPromotion, code);
    expect(body).toContain('مرحباً سارة');
    expect(body).toContain('خصم 10% على أول طلب');
    expect(body).toContain('50 من نقاط الولاء');
    expect(body).toContain('https://app.test/r/ABC123?lang=ar');
    expect(body.endsWith('لإيقاف الرسائل الترويجية أرسل «إلغاء الاشتراك» أو STOP')).toBe(true);
    expect(await run.referralBody(english, referralPromotion, code)).toBeNull();
    await run.record(arabic, { sent: true });
    expect(w.rows[0]).toMatchObject({ sender: 'referral_link', usedLanguage: 'ar', via: 'session', status: 'sent' });
    expect(run.summary().localization.arabicSent).toBe(1);
  });

  test('merchant-typed reward labels are used as written; an unknown reward type gets the neutral phrase', async () => {
    const c = customerDoc({ firstname: 'Omar' });
    const w = world({ customers: [c], languages: { [c._id]: 'ar' } });
    const run = await legacy.begin({ sender: 'referral_link', workspaceId: WS, customers: [c], promotion: referralPromotion }, w.deps);
    const body = await run.referralBody(c, { ...referralPromotion, friendRewardLabel: 'قهوة مجانية', referrerRewardType: 'mystery' }, code);
    expect(body).toContain('سيحصل صديقك على قهوة مجانية');
    expect(body).toContain('ستحصل أنت على مكافأة');
  });

  test('LOCALIZATION_ALLOW_DRAFT_SESSION=0 refuses draft copy: English text (null) and a recorded reason', async () => {
    const c = customerDoc();
    const w = world({ customers: [c], languages: { [c._id]: 'ar' } });
    const run = await legacy.begin({ sender: 'referral_link', workspaceId: WS, customers: [c], promotion: referralPromotion }, w.deps);
    process.env.LOCALIZATION_ALLOW_DRAFT_SESSION = '0';
    try {
      expect(await run.referralBody(c, referralPromotion, code)).toBeNull();
    } finally { delete process.env.LOCALIZATION_ALLOW_DRAFT_SESSION; }
    expect(run.summary().localization.fallbackToEnglish).toEqual([{ reason: 'catalog_missing', count: 1 }]);
  });

  test('excludes(): an Arabic customer whose number is opted out on another record is not sent a link', async () => {
    const c = customerDoc({ phone: '966502220000' });
    const sibling = customerDoc({ phone: '+966 50 222 0000', optedOut: true });
    const w = world({ customers: [c, sibling], languages: { [c._id]: 'ar' } });
    const run = await legacy.begin({ sender: 'referral_link', workspaceId: WS, customers: [c], promotion: referralPromotion }, w.deps);
    expect(run.excludes(c)).toBe(true);
    expect(run.excludes(customerDoc())).toBe(false);
    expect(run.summary().localization.excludedOptedOutPhone).toBe(1);
  });
});

describe('the Arabic test send', () => {
  test('sends the SAME version a real send would pick, with the inert opt-out payload, to the typed number', async () => {
    const w = world({ templates: [linked()] });
    const out = await legacy.sendPromotionTest({ workspaceId: WS, promotion: promotionDoc(), items: [productDoc()], phone: '966500009999' }, w.deps);
    expect(out).toEqual({ sent: true, dryRun: false, usedLanguage: 'ar', templateName: 'wf_0000a1_promo_ar_v1' });
    expect(w.sent[0].to).toBe('966500009999');
    expect(w.sent[0].components.filter((x) => x.type === 'button').map((x) => x.parameters[0].payload)).toEqual([`promo_${PROMOTION_ID}`, 'l10ntest_optout']);
    expect(w.sent[0].components[0].parameters[0].text).toBe('Test'); // the synthetic customer of the English test send is called Test too
  });

  test('no Arabic version: 409 NO_ARABIC_VERSION with the reason - never English silently', async () => {
    const w = world({ templates: [linked({ variants: [arabicVariant({ metaStatus: 'PENDING' })] })] });
    await expect(legacy.sendPromotionTest({ workspaceId: WS, promotion: promotionDoc(), items: [], phone: '966500009999' }, w.deps))
      .rejects.toMatchObject({ status: 409, code: 'NO_ARABIC_VERSION', details: { reason: 'pending' } });
    expect(w.sent).toHaveLength(0);
  });

  test('a Meta failure is a 502 META_ERROR (no details leak)', async () => {
    const w = world({ templates: [linked()] });
    w.transport.sendTemplate.mockRejectedValueOnce(Object.assign(new Error('secret detail'), { response: { data: { error: { code: 131026, message: 'secret detail' } } } }));
    await expect(legacy.sendPromotionTest({ workspaceId: WS, promotion: promotionDoc(), items: [productDoc()], phone: '966500009999' }, w.deps))
      .rejects.toMatchObject({ status: 502, code: 'META_ERROR', message: 'WhatsApp could not send the message' });
  });
});
