// The campaign planner: the preview the merchant sees before sending and the
// decision the sender re-takes at send time. Matrix over send modes x customer
// languages x variant states, skip counters, merge-field values, the marketing
// opt-out guard, previews with Arabic/Latin text, determinism and validation.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const planner = require('../../shared/localization/campaignPlanner');
const { wrapLtr } = require('../../shared/localization/arabicText');
const { makeKit, oid, variant } = require('./campaignTestKit');

const WS = oid();
const OTHER_WS = oid();
const DEFAULT_FIELDS = { discount: '15', date: '30 Nov' };
let seq = 0;

function setup({ variants, category = 'MARKETING', useCase = 'promotion', archived = false, merchantDefault = 'en', merchantName = '', workspaceName } = {}) {
  const kit = makeKit();
  kit.localeSettings.defaultCustomerLanguage = merchantDefault;
  const [template] = kit.templates.seed([{
    _id: oid(), workspaceId: WS, key: 'promo', name: 'Weekend offer', useCase, category, archived,
    variants: variants || [variant('en'), variant('ar')],
  }]);
  if (merchantName) kit.settingsDocs.seed([{ workspaceId: WS, merchantName }]);
  if (workspaceName) kit.workspaces.seed([{ _id: WS, name: workspaceName }]);
  return { kit, template };
}

function addCustomer(kit, extra = {}, ws = WS) {
  seq += 1;
  const { language, ...rest } = extra;
  const [doc] = kit.customers.seed([{
    _id: oid(), workspaceId: ws, firstname: `First${seq}`, lastname: `Last${seq}`, phone: `9665${String(seq).padStart(8, '0')}`,
    marketingConsent: true, loyaltyPoints: 120, ...rest,
  }]);
  if (language) kit.languages.seed([{ workspaceId: ws, customerId: doc._id, language }]);
  return doc;
}

const addMany = (kit, n, extra) => Array.from({ length: n }, () => addCustomer(kit, extra));

function plan(kit, template, { languageMode = 'per_customer', audience = { kind: 'all_eligible' }, fieldValues = DEFAULT_FIELDS, ws = WS } = {}) {
  return planner.planCampaign({ workspaceId: ws, request: { templateId: String(template._id), languageMode, audience, fieldValues } }, kit.deps);
}

describe('per-customer mode (the default)', () => {
  test('every customer gets their own language; unknown uses the merchant default (English)', async () => {
    const { kit, template } = setup();
    addMany(kit, 2, { language: 'ar' });
    addMany(kit, 3, { language: 'en' });
    addCustomer(kit); // no language row
    addCustomer(kit, { language: 'unknown' });
    const p = await plan(kit, template);
    expect(p.byLanguage).toEqual({ en: 5, ar: 2, bilingual: 0 });
    expect(p.fallbacks).toEqual([]);
    expect(p.blocked).toEqual([]);
    expect(p.needsAcknowledgement).toBe(false);
    expect(p.canSend).toBe(true);
    expect(p.audience).toEqual({ selected: 7, eligible: 7 });
  });

  test('a merchant default of Arabic gives unknown-language customers Arabic', async () => {
    const { kit, template } = setup({ merchantDefault: 'ar' });
    addCustomer(kit);
    addCustomer(kit, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.byLanguage).toEqual({ en: 1, ar: 1, bilingual: 0 });
  });

  test('the headline case: "N customers will receive English because no approved Arabic version exists"', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    addMany(kit, 42, { language: 'ar' });
    addMany(kit, 8, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.byLanguage).toEqual({ en: 50, ar: 0, bilingual: 0 });
    expect(p.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'ar_pending', count: 42 }]);
    expect(p.needsAcknowledgement).toBe(true);
    expect(p.canSend).toBe(true);
    expect(p.blocked).toEqual([]);
  });

  test.each([
    ['pending', { metaStatus: 'PENDING' }, 'ar_pending'],
    ['rejected', { metaStatus: 'REJECTED' }, 'ar_rejected'],
    ['not submitted', { metaStatus: 'NOT_CREATED' }, 'ar_not_submitted'],
    ['paused', { metaStatus: 'PAUSED' }, 'ar_paused'],
    ['disabled', { metaStatus: 'DISABLED' }, 'ar_disabled'],
    ['approved but not yet reviewed by a native reader', { metaStatus: 'APPROVED', reviewStatus: 'draft' }, 'ar_not_reviewed'],
  ])('Arabic variant %s -> fallback to English with reason %s', async (_label, state, reason) => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', state)] });
    addMany(kit, 3, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.fallbacks).toEqual([{ from: 'ar', to: 'en', reason, count: 3 }]);
    expect(p.byLanguage.en).toBe(3);
    expect(p.needsAcknowledgement).toBe(true);
    const row = p.variants.find((v) => v.language === 'ar');
    expect(row).toMatchObject({ present: true, sendable: false, recipients: 0 });
  });

  test('a missing Arabic variant is a fallback with reason ar_missing', async () => {
    const { kit, template } = setup({ variants: [variant('en')] });
    addCustomer(kit, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'ar_missing', count: 1 }]);
    expect(p.variants.find((v) => v.language === 'ar')).toMatchObject({ present: false, metaStatus: 'NOT_CREATED', reviewStatus: 'draft', sendable: false, notSendableReason: 'missing' });
  });

  test('an English customer is not affected by an unusable Arabic variant', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'REJECTED' })] });
    addMany(kit, 2, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.fallbacks).toEqual([]);
    expect(p.needsAcknowledgement).toBe(false);
  });

  test('with no English at all, an English customer falls back to the merchant default Arabic', async () => {
    const { kit, template } = setup({ variants: [variant('ar')], merchantDefault: 'ar' });
    addMany(kit, 2, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.byLanguage.ar).toBe(2);
    expect(p.fallbacks).toEqual([{ from: 'en', to: 'ar', reason: 'en_missing', count: 2 }]);
  });

  test('nothing usable: everyone is blocked (never a blank or wrong-language send) and the plan cannot be sent', async () => {
    const { kit, template } = setup({ variants: [variant('en', { metaStatus: 'PENDING' }), variant('ar', { metaStatus: 'PENDING' })] });
    addMany(kit, 2, { language: 'ar' });
    addCustomer(kit, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.byLanguage).toEqual({ en: 0, ar: 0, bilingual: 0 });
    expect(p.blocked).toEqual([{ reason: 'no_usable_variant', count: 3 }]);
    expect(p.canSend).toBe(false);
    expect(p.needsAcknowledgement).toBe(true);
  });

  test('a template with no variants blocks every recipient', async () => {
    const { kit, template } = setup({ variants: [] });
    addCustomer(kit);
    const p = await plan(kit, template);
    expect(p.blocked).toEqual([{ reason: 'no_usable_variant', count: 1 }]);
    expect(p.canSend).toBe(false);
  });

  test('fallbacks from different reasons are listed separately', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    addMany(kit, 2, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.fallbacks).toHaveLength(1);
    const q = await plan(kit, template, { languageMode: 'bilingual' }); // bilingual missing too
    expect(q.fallbacks.map((f) => f.reason)).toEqual(['bilingual_missing']);
  });
});

describe('explicit single-language modes never fall back silently', () => {
  test('Arabic mode sends Arabic to everyone, including English-speaking customers', async () => {
    const { kit, template } = setup();
    addMany(kit, 2, { language: 'en' });
    addCustomer(kit, { language: 'ar' });
    addCustomer(kit);
    const p = await plan(kit, template, { languageMode: 'ar' });
    expect(p.byLanguage).toEqual({ en: 0, ar: 4, bilingual: 0 });
    expect(p.fallbacks).toEqual([]);
    expect(p.needsAcknowledgement).toBe(false);
  });

  test('English mode sends English to Arabic-speaking customers too (the merchant asked for it)', async () => {
    const { kit, template } = setup();
    addMany(kit, 2, { language: 'ar' });
    const p = await plan(kit, template, { languageMode: 'en' });
    expect(p.byLanguage).toEqual({ en: 2, ar: 0, bilingual: 0 });
  });

  test.each([
    ['pending', { metaStatus: 'PENDING' }, 'ar_pending'],
    ['rejected', { metaStatus: 'REJECTED' }, 'ar_rejected'],
    ['not reviewed', { reviewStatus: 'draft' }, 'ar_not_reviewed'],
  ])('Arabic mode with an %s Arabic variant BLOCKS every recipient with reason %s', async (_l, state, reason) => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', state)] });
    addMany(kit, 3, { language: 'en' });
    addMany(kit, 2, { language: 'ar' });
    const p = await plan(kit, template, { languageMode: 'ar' });
    expect(p.byLanguage).toEqual({ en: 0, ar: 0, bilingual: 0 });
    expect(p.blocked).toEqual([{ reason, count: 5 }]);
    expect(p.fallbacks).toEqual([]); // never a silent English fallback
    expect(p.canSend).toBe(false);
    expect(p.needsAcknowledgement).toBe(true);
  });

  test('English mode with a missing English variant blocks (en_missing)', async () => {
    const { kit, template } = setup({ variants: [variant('ar')] });
    addCustomer(kit);
    const p = await plan(kit, template, { languageMode: 'en' });
    expect(p.blocked).toEqual([{ reason: 'en_missing', count: 1 }]);
  });
});

describe('bilingual mode', () => {
  test('uses the bilingual variant for everyone when it is approved and reviewed', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar'), variant('bilingual')] });
    addMany(kit, 2, { language: 'ar' });
    addCustomer(kit, { language: 'en' });
    const p = await plan(kit, template, { languageMode: 'bilingual' });
    expect(p.byLanguage).toEqual({ en: 0, ar: 0, bilingual: 3 });
    expect(p.fallbacks).toEqual([]);
    expect(p.variants.find((v) => v.language === 'bilingual')).toMatchObject({ present: true, sendable: true, recipients: 3 });
  });

  test('an unusable bilingual variant falls back to the per-customer rule — and says so', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar'), variant('bilingual', { metaStatus: 'PENDING' })] });
    addMany(kit, 2, { language: 'ar' });
    addCustomer(kit, { language: 'en' });
    const p = await plan(kit, template, { languageMode: 'bilingual' });
    expect(p.byLanguage).toEqual({ en: 1, ar: 2, bilingual: 0 });
    expect(p.fallbacks).toEqual(expect.arrayContaining([
      { from: 'bilingual', to: 'ar', reason: 'bilingual_pending', count: 2 },
      { from: 'bilingual', to: 'en', reason: 'bilingual_pending', count: 1 },
    ]));
    expect(p.needsAcknowledgement).toBe(true);
  });
});

describe('skip counters (consent, opt-out, demo, phone) are explicit and never mixed into the languages', () => {
  test('MARKETING', async () => {
    const { kit, template } = setup();
    addMany(kit, 2, { language: 'ar' });
    addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { optedOut: true });
    addCustomer(kit, { isDemo: true });
    addCustomer(kit, { phone: '0501234567' });
    const p = await plan(kit, template);
    expect(p.skipped).toEqual({ noConsent: 2, optedOut: 1, demo: 1, invalidPhone: 1 });
    expect(p.byLanguage).toEqual({ en: 0, ar: 2, bilingual: 0 });
    expect(p.audience).toEqual({ selected: 7, eligible: 2 });
  });

  test('transactional UTILITY templates need no marketing consent', async () => {
    const { kit, template } = setup({ useCase: 'payment_reminder', category: 'UTILITY', variants: [variant('en', { buttons: [] }), variant('ar', { buttons: [] })] });
    addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { optedOut: true, marketingConsent: false });
    const p = await plan(kit, template);
    expect(p.category).toBe('UTILITY');
    expect(p.skipped).toEqual({ noConsent: 0, optedOut: 1, demo: 0, invalidPhone: 0 });
    expect(p.audience.eligible).toBe(1);
    expect(p.canSend).toBe(true);
  });

  test('nobody eligible: canSend false', async () => {
    const { kit, template } = setup();
    addCustomer(kit, { marketingConsent: false });
    const p = await plan(kit, template, { audience: { kind: 'customer_ids', customerIds: [] } }).catch((e) => e);
    expect(p.code).toBe('INVALID_INPUT'); // empty customer_ids is rejected up front
    const q = await plan(kit, template, { audience: { kind: 'segment', segmentKey: 'awaiting_consent', segmentParams: {} } });
    expect(q.audience.eligible).toBe(0);
    expect(q.canSend).toBe(false);
    expect(q.skipped.noConsent).toBe(1);
  });

  test('chosen customers from another tenant are ignored and reported', async () => {
    const { kit, template } = setup();
    const mine = addCustomer(kit);
    const foreign = addCustomer(kit, {}, OTHER_WS);
    const p = await plan(kit, template, { audience: { kind: 'customer_ids', customerIds: [String(mine._id), String(foreign._id)] } });
    expect(p.audience).toEqual({ selected: 1, eligible: 1 });
    expect(p.warnings).toEqual([{ code: 'audience_ids_not_found', detail: { count: 1 } }]);
    expect(p.sampleRecipients.map((s) => s.customerId)).toEqual([String(mine._id)]);
  });

  test('two customers with the same number: one send, one explicit warning', async () => {
    const { kit, template } = setup();
    addCustomer(kit, { phone: '966500000555' });
    addCustomer(kit, { phone: '+966 500 000 555' });
    const p = await plan(kit, template);
    expect(p.audience.eligible).toBe(1);
    expect(p.warnings).toEqual([{ code: 'duplicate_phones_skipped', detail: { count: 1 } }]);
  });
});

describe('merge-field values the merchant must supply', () => {
  const body = (text) => ({ body: text });

  test('only fields of the variants that will actually be sent, and never the auto-filled ones', async () => {
    const { kit, template } = setup({
      variants: [
        variant('en', body('Hi {name} {full_name}, {points} points, {discount}% off. {business}')),
        variant('ar', body('مرحباً {name}، ينتهي {date} {code}')),
      ],
      merchantName: 'Al Noor',
    });
    addCustomer(kit, { language: 'en' });
    const english = await plan(kit, template, { fieldValues: {} });
    expect(english.missingFieldValues).toEqual(['discount']); // {date}/{code} belong to the Arabic variant nobody receives
    expect(english.canSend).toBe(false);
    addCustomer(kit, { language: 'ar' });
    const both = await plan(kit, template, { fieldValues: {} });
    expect(both.missingFieldValues).toEqual(['discount', 'date', 'code']);
    const filled = await plan(kit, template, { fieldValues: { discount: '10', date: 'Friday', code: 'AB12' } });
    expect(filled.missingFieldValues).toEqual([]);
    expect(filled.canSend).toBe(true);
  });

  test('blank or whitespace-only values count as missing; unrelated extras are harmless', async () => {
    const { kit, template } = setup({ variants: [variant('en', body('{discount} {date}'))] });
    addCustomer(kit);
    const p = await plan(kit, template, { fieldValues: { discount: '   ', date: '', extra: 'x' } });
    expect(p.missingFieldValues).toEqual(['discount', 'date']);
  });

  test('a user-supplied value for an auto-filled field is ignored (per-customer fields cannot be overridden)', async () => {
    const { kit, template } = setup({ variants: [variant('en', body('Hi {name}'))] });
    addCustomer(kit, { firstname: 'Mona' });
    const p = await plan(kit, template, { fieldValues: { name: 'EVERYONE' } });
    expect(p.sampleRecipients[0].preview).toBe('Hi Mona');
  });

  test('{business}: explicit value > Settings.merchantName > a real workspace name; the auto-generated one is not a business name', async () => {
    const tpl = { variants: [variant('en', body('From {business}'))] };
    const noName = setup(tpl);
    addCustomer(noName.kit);
    expect((await plan(noName.kit, noName.template, { fieldValues: {} })).missingFieldValues).toEqual(['business']);

    const generated = setup({ ...tpl, workspaceName: "Sara's Workspace" });
    addCustomer(generated.kit);
    expect((await plan(generated.kit, generated.template, { fieldValues: {} })).missingFieldValues).toEqual(['business']);

    const workspace = setup({ ...tpl, workspaceName: 'Glow Salon' });
    addCustomer(workspace.kit);
    const p1 = await plan(workspace.kit, workspace.template, { fieldValues: {} });
    expect(p1.missingFieldValues).toEqual([]);
    expect(p1.sampleRecipients[0].preview).toBe('From Glow Salon');

    const settings = setup({ ...tpl, merchantName: 'Al Noor', workspaceName: 'Glow Salon' });
    addCustomer(settings.kit);
    expect((await plan(settings.kit, settings.template, { fieldValues: {} })).sampleRecipients[0].preview).toBe('From Al Noor');

    const explicit = setup({ ...tpl, merchantName: 'Al Noor' });
    addCustomer(explicit.kit);
    expect((await plan(explicit.kit, explicit.template, { fieldValues: { business: 'Noor Bakery' } })).sampleRecipients[0].preview).toBe('From Noor Bakery');
  });

  test('a field called like an Object.prototype member is not satisfied by the prototype', async () => {
    const { kit, template } = setup({ variants: [variant('en', body('Code {constructor} {toString}'))] });
    addCustomer(kit);
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.missingFieldValues).toEqual(['constructor', 'toString']);
    expect(p.sampleRecipients[0].preview).not.toMatch(/native code/);
  });

  test('header variables are fields too', async () => {
    const { kit, template } = setup({ variants: [variant('en', { header: 'Offer {date}', body: 'Hi {name}' })] });
    addCustomer(kit);
    expect((await plan(kit, template, { fieldValues: {} })).missingFieldValues).toEqual(['date']);
  });
});

describe('the MARKETING opt-out guard (spec §3.4)', () => {
  test('a used MARKETING variant without the opt-out button makes the campaign unsendable', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { buttons: [] })] });
    addCustomer(kit, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.warnings).toEqual([{ code: 'marketing_variant_missing_opt_out', detail: { language: 'ar' } }]);
    expect(p.canSend).toBe(false);
    expect(p.variants.find((v) => v.language === 'ar')).toMatchObject({ sendable: false, notSendableReason: 'no_opt_out_button' });
  });

  test('a variant nobody receives does not trigger it; UTILITY templates do not need it', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { buttons: [] })] });
    addCustomer(kit, { language: 'en' });
    expect((await plan(kit, template)).warnings).toEqual([]);

    const utility = setup({ useCase: 'booking_reminder', category: 'UTILITY', variants: [variant('en', { buttons: [] })] });
    addCustomer(utility.kit);
    const p = await plan(utility.kit, utility.template);
    expect(p.warnings).toEqual([]);
    expect(p.canSend).toBe(true);
  });

  test('an archived template can be planned but never sent', async () => {
    const { kit, template } = setup({ archived: true });
    addCustomer(kit);
    const p = await plan(kit, template);
    expect(p.warnings).toEqual([{ code: 'template_archived' }]);
    expect(p.canSend).toBe(false);
  });
});

describe('variants table', () => {
  test('always lists en, ar, bilingual with presence, approval, review, sendability and recipient counts', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'REJECTED', reviewStatus: 'draft' })] });
    addCustomer(kit, { language: 'en' });
    const p = await plan(kit, template);
    expect(p.variants).toEqual([
      { language: 'en', present: true, metaStatus: 'APPROVED', reviewStatus: 'reviewed', sendable: true, notSendableReason: null, recipients: 1 },
      { language: 'ar', present: true, metaStatus: 'REJECTED', reviewStatus: 'draft', sendable: false, notSendableReason: 'rejected', recipients: 0 },
      { language: 'bilingual', present: false, metaStatus: 'NOT_CREATED', reviewStatus: 'draft', sendable: false, notSendableReason: 'missing', recipients: 0 },
    ]);
  });

  test('English does not need a native review; Arabic does', async () => {
    const { kit, template } = setup({ variants: [variant('en', { reviewStatus: 'draft' }), variant('ar', { reviewStatus: 'draft' })] });
    addCustomer(kit);
    const p = await plan(kit, template);
    expect(p.variants.map((v) => [v.language, v.sendable])).toEqual([['en', true], ['ar', false], ['bilingual', false]]);
  });
});

describe('sample recipients', () => {
  test('at most three, deterministic, one per language/fallback combination first', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar')] });
    const en1 = addCustomer(kit, { language: 'en' });
    const en2 = addCustomer(kit, { language: 'en' });
    const ar1 = addCustomer(kit, { language: 'ar' });
    const ar2 = addCustomer(kit, { language: 'ar' });
    addCustomer(kit, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.sampleRecipients.map((s) => s.customerId)).toEqual([en1, ar1, en2].map((c) => String(c._id)));
    expect(p.sampleRecipients).toHaveLength(3);
    expect(JSON.stringify(await plan(kit, template))).toBe(JSON.stringify(p));
    expect(p.sampleRecipients.map((s) => s.language)).toEqual(['en', 'ar', 'en']);
    expect(ar2).toBeTruthy();
  });

  test('a fallback recipient is flagged, and never samples a blocked or skipped customer', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    addCustomer(kit, { marketingConsent: false, language: 'ar' });
    addCustomer(kit, { isDemo: true });
    const eligible = addCustomer(kit, { language: 'ar' });
    const p = await plan(kit, template);
    expect(p.sampleRecipients).toEqual([expect.objectContaining({ customerId: String(eligible._id), language: 'en', fallback: true })]);
  });

  test('an Arabic preview protects Latin names/numbers with LRM and leaves Arabic names alone', async () => {
    const { kit, template } = setup();
    addCustomer(kit, { firstname: 'سارة', lastname: 'أحمد', language: 'ar', loyaltyPoints: 120 });
    addCustomer(kit, { firstname: 'Sam', lastname: 'Lee', language: 'ar', loyaltyPoints: 5 });
    const p = await plan(kit, template);
    expect(p.sampleRecipients[0].preview).toBe(
      `مرحباً سارة، خصم ${wrapLtr('15')}% حتى ${wrapLtr('30 Nov')}. رصيدك الحالي من النقاط: ${wrapLtr('120')}`,
    );
    expect(p.sampleRecipients[1].preview).toContain(`مرحباً ${wrapLtr('Sam')}،`);
    expect(p.sampleRecipients[1].name).toBe('Sam Lee');
  });

  test('an English preview has no direction marks', async () => {
    const { kit, template } = setup();
    addCustomer(kit, { firstname: 'Sam', lastname: 'Lee', language: 'en' });
    const p = await plan(kit, template);
    expect(p.sampleRecipients[0].preview).toBe('Hi Sam, enjoy 15% off until 30 Nov. You have 120 points.');
  });

  test('header, body and footer are joined for the preview', async () => {
    const { kit, template } = setup({ variants: [variant('en', { header: 'Offer', footer: 'Reply STOP to opt out' })] });
    addCustomer(kit, { firstname: 'Sam' });
    const p = await plan(kit, template);
    expect(p.sampleRecipients[0].preview).toBe('Offer\n\nHi Sam, enjoy 15% off until 30 Nov. You have 120 points.\n\nReply STOP to opt out');
  });

  test.each([
    ['a phone number', '966501234567'], ['symbols only', '+++'], ['an emoji', '🌟'], ['blank', '   '],
  ])('a first name that is %s is replaced by the neutral fallback (English and Arabic)', async (_l, firstname) => {
    const { kit, template } = setup({ variants: [variant('en', { body: 'Hi {name}!' }), variant('ar', { body: 'مرحباً {name}!' })] });
    addCustomer(kit, { firstname, lastname: 'X', language: 'en' });
    addCustomer(kit, { firstname, lastname: 'X', language: 'ar' });
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.sampleRecipients.map((s) => s.preview)).toEqual(['Hi Valued Customer!', 'مرحباً عميلنا العزيز!']);
  });

  test('name edge cases: emoji kept, direction overrides removed, absurdly long names capped', async () => {
    const { kit, template } = setup({ variants: [variant('en', { body: '{name}|{full_name}' })] });
    const RLO = String.fromCodePoint(0x202E);
    const LRI = String.fromCodePoint(0x2066);
    addCustomer(kit, { firstname: 'Sara 🌟', lastname: 'Ali' });
    addCustomer(kit, { firstname: `Ev${RLO}il${LRI}`, lastname: 'X' });
    addCustomer(kit, { firstname: 'A'.repeat(300), lastname: 'B'.repeat(300) });
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.sampleRecipients[0].preview).toBe('Sara 🌟|Sara 🌟 Ali');
    expect(p.sampleRecipients[1].preview).toBe('Evil|Evil X');
    const [name, full] = p.sampleRecipients[2].preview.split('|');
    expect(Array.from(name)).toHaveLength(60);
    expect(Array.from(full).length).toBeLessThanOrEqual(90);
    expect(p.sampleRecipients.map((s) => s.preview).join('')).not.toMatch(new RegExp(`[${RLO}${LRI}]`, 'u'));
  });

  test('{points} is a whole non-negative number', async () => {
    const { kit, template } = setup({ variants: [variant('en', { body: 'P{points}' })] });
    addCustomer(kit, { loyaltyPoints: 1250.6 });
    addCustomer(kit, { loyaltyPoints: -5 });
    addCustomer(kit, { loyaltyPoints: undefined });
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.sampleRecipients.map((s) => s.preview)).toEqual(['P1251', 'P0', 'P0']);
  });
});

describe('plan shape and determinism', () => {
  test('has exactly the CampaignPlan fields of localization.types.ts', async () => {
    const { kit, template } = setup();
    addCustomer(kit);
    const p = await plan(kit, template);
    expect(Object.keys(p).sort()).toEqual([
      'audience', 'blocked', 'byLanguage', 'canSend', 'category', 'fallbacks', 'languageMode', 'missingFieldValues', 'needsAcknowledgement',
      'sampleRecipients', 'skipped', 'templateId', 'templateName', 'variants', 'warnings',
    ]);
    expect(Object.keys(p.skipped).sort()).toEqual(['demo', 'invalidPhone', 'noConsent', 'optedOut']);
    expect(p.templateId).toBe(String(template._id));
    expect(p.templateName).toBe('Weekend offer');
    expect(p.languageMode).toBe('per_customer');
  });

  test('identical inputs give identical plans; the inputs are never mutated', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    addMany(kit, 5, { language: 'ar' });
    addMany(kit, 4, { language: 'en' });
    const request = { templateId: String(template._id), languageMode: 'per_customer', audience: { kind: 'all_eligible' }, fieldValues: { ...DEFAULT_FIELDS } };
    const before = JSON.stringify(request);
    const a = await planner.planCampaign({ workspaceId: WS, request }, kit.deps);
    const b = await planner.planCampaign({ workspaceId: WS, request }, kit.deps);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(request)).toBe(before);
  });

  test('buildPlan returns every resolved customer with its pick (the sender snapshots exactly this)', async () => {
    const { kit, template } = setup({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    const ar = addCustomer(kit, { language: 'ar' });
    const demo = addCustomer(kit, { isDemo: true });
    const built = await planner.buildPlan({ workspaceId: WS, request: { templateId: String(template._id), audience: { kind: 'all_eligible' }, fieldValues: DEFAULT_FIELDS } }, kit.deps);
    expect(built.recipients.map((r) => [r.customer.id, r.skip, r.pick && r.pick.usedLanguage, r.pick && r.pick.fallback])).toEqual([
      [String(ar._id), null, 'en', true], [String(demo._id), 'demo', null, null],
    ]);
    expect(built.context).toMatchObject({ category: 'MARKETING', merchantDefault: 'en', templateError: null });
  });

  test('stripSamples removes recipient names and previews, keeping the numbers', async () => {
    const { kit, template } = setup();
    addCustomer(kit);
    const p = await plan(kit, template);
    const stripped = planner.stripSamples(p);
    expect(stripped.sampleRecipients).toEqual([]);
    expect({ ...stripped, sampleRecipients: p.sampleRecipients }).toEqual(p);
    expect(JSON.stringify(stripped)).not.toContain('First');
  });
});

describe('request validation (nothing reaches the database unchecked)', () => {
  const run = (kit, template, patch) => planner.planCampaign({ workspaceId: WS, request: { templateId: String(template._id), languageMode: 'per_customer', audience: { kind: 'all_eligible' }, fieldValues: {}, ...patch } }, kit.deps);

  test('unknown template -> 404 TEMPLATE_NOT_FOUND; another tenant\'s template looks the same', async () => {
    const { kit, template } = setup();
    await expect(run(kit, { _id: oid() }, {})).rejects.toMatchObject({ status: 404, code: 'TEMPLATE_NOT_FOUND' });
    await expect(planner.planCampaign({ workspaceId: OTHER_WS, request: { templateId: String(template._id), audience: { kind: 'all_eligible' } } }, kit.deps))
      .rejects.toMatchObject({ status: 404, code: 'TEMPLATE_NOT_FOUND' });
  });

  test.each([[{ $ne: null }], ['nope'], [undefined], [null], [123], [['x']]])('templateId %j -> 400 INVALID_ID, no query made', async (bad) => {
    const { kit } = setup();
    kit.ops.length = 0;
    await expect(planner.planCampaign({ workspaceId: WS, request: { templateId: bad, audience: { kind: 'all_eligible' } } }, kit.deps)).rejects.toMatchObject({ status: 400, code: 'INVALID_ID' });
    expect(kit.ops).toHaveLength(0);
  });

  test('languageMode: absent -> per_customer; anything else must be one of the four', async () => {
    const { kit, template } = setup();
    addCustomer(kit);
    expect((await planner.planCampaign({ workspaceId: WS, request: { templateId: String(template._id), audience: { kind: 'all_eligible' }, fieldValues: DEFAULT_FIELDS } }, kit.deps)).languageMode).toBe('per_customer');
    for (const bad of ['fr', '', 'AR', { $ne: 1 }, ['ar'], 5]) {
      await expect(run(kit, template, { languageMode: bad })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT' });
    }
  });

  test('a body that is not an object is treated as empty (and fails on the missing templateId)', async () => {
    const { kit } = setup();
    for (const body of [undefined, null, 'x', 5, []]) {
      await expect(planner.planCampaign({ workspaceId: WS, request: body }, kit.deps)).rejects.toMatchObject({ status: 400 });
    }
  });

  describe('fieldValues', () => {
    const fv = (raw) => planner.normalizeFieldValues(raw);

    test('accepts text and finite numbers, drops null/undefined, sanitises spacing', () => {
      expect(fv({ discount: 15, date: '  30   Nov ', skip: null, gone: undefined, Code: 'AB12' })).toEqual({ discount: '15', date: '30 Nov', Code: 'AB12' });
      expect(fv(undefined)).toEqual({});
      expect(fv(null)).toEqual({});
    });

    test('keeps Arabic values exactly', () => {
      expect(fv({ date: 'الجمعة ٥ مساءً' })).toEqual({ date: 'الجمعة ٥ مساءً' });
    });

    test.each([
      [[]], ['x'], [5], [{ a: { nested: 1 } }], [{ a: ['x'] }], [{ a: true }], [{ a: Infinity }], [{ a: NaN }], [{ '1bad': 'x' }], [{ 'bad-key': 'x' }],
      [{ 'a.b': 'x' }], [{ $set: 'x' }], [{ '': 'x' }], [{ ['x'.repeat(65)]: 'x' }], [{ a: 'x'.repeat(501) }], [{ a: 'line1\nline2' }], [{ a: 'tab\there' }],
      [{ a: 'cr\rhere' }], [{ a: `ls${String.fromCodePoint(0x2028)}x` }],
    ])('rejects %j', (raw) => {
      expect.assertions(2);
      try { fv(raw); } catch (err) { expect(err.status).toBe(400); expect(err.code).toBe('INVALID_INPUT'); }
    });

    test('__proto__ as a key is rejected (JSON.parse creates it as an own property)', () => {
      expect(() => fv(JSON.parse('{"__proto__": "x"}'))).toThrow(/Invalid field name/);
    });

    test('at most 30 fields; 500 characters is the maximum value length', () => {
      const thirty = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, 'v']));
      expect(Object.keys(fv(thirty))).toHaveLength(30);
      expect(() => fv({ ...thirty, extra: 'v' })).toThrow(/at most 30/);
      expect(fv({ a: 'x'.repeat(500) }).a).toHaveLength(500);
    });
  });

  test('archived/foreign data never leaks into a plan of another tenant', async () => {
    const { kit, template } = setup();
    addCustomer(kit, {}, OTHER_WS);
    const p = await plan(kit, template);
    expect(p.audience).toEqual({ selected: 0, eligible: 0 });
  });
});

describe('live-Meta corrections: effective category, consent request, warnings, LRM switch', () => {
  test('a UTILITY template that Meta re-classified to MARKETING is gated as MARKETING and warns category_changed', async () => {
    const { kit, template } = setup({ useCase: 'order_confirmation', category: 'UTILITY', variants: [variant('en', { metaCategory: 'MARKETING' }), variant('ar')] });
    const consented = addCustomer(kit);
    addCustomer(kit, { marketingConsent: false });
    const p = await plan(kit, template);
    expect(p.category).toBe('MARKETING');
    expect(p.audience.eligible).toBe(1);
    expect(p.skipped.noConsent).toBe(1);
    expect(p.warnings).toContainEqual({ code: 'category_changed', detail: { from: 'UTILITY', to: 'MARKETING', language: 'en' } });
    expect(p.warnings.map((w) => w.code)).not.toContain('category_floored'); // a transactional use case: Meta, not the floor, tightened it
    expect(consented).toBeTruthy();
  });

  test('a transactional UTILITY template that Meta kept as UTILITY needs no marketing consent and no opt-out button', async () => {
    const { kit, template } = setup({
      useCase: 'payment_reminder',
      category: 'UTILITY',
      variants: [variant('en', { metaCategory: 'UTILITY', buttons: [] }), variant('ar', { metaCategory: 'UTILITY', buttons: [] })],
    });
    addCustomer(kit, { marketingConsent: false });
    const p = await plan(kit, template);
    expect(p.category).toBe('UTILITY');
    expect(p.audience.eligible).toBe(1);
    expect(p.warnings).toEqual([]);
    expect(p.canSend).toBe(true);
  });

  test('effectiveCategory is the stricter of category and metaCategory (transactional use cases only)', () => {
    const useCase = 'payment_reminder';
    expect(planner.effectiveCategory({ useCase, category: 'MARKETING', variants: [{ metaCategory: 'UTILITY' }] })).toBe('MARKETING');
    expect(planner.effectiveCategory({ useCase, category: 'UTILITY', variants: [{ metaCategory: 'AUTHENTICATION' }] })).toBe('MARKETING');
    expect(planner.effectiveCategory({ useCase, category: 'UTILITY', variants: [{}, { metaCategory: 'utility' }] })).toBe('UTILITY');
    expect(planner.effectiveCategory({ useCase, category: 'UTILITY' })).toBe('UTILITY');
  });

  describe('the UTILITY floor: only transactional use cases can be UTILITY, whatever was requested or reported', () => {
    const TRANSACTIONAL = ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation'];
    const NON_TRANSACTIONAL = ['promotion', 'comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'referral_invite', 'referral_reward', 'greeting', 'welcome_optin', 'custom'];

    test.each(TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY', 'UTILITY'], [u, 'MARKETING', 'MARKETING']]))(
      'transactional %s requested as %s -> %s', (useCase, category, expected) => {
        expect(planner.effectiveCategory({ useCase, category, variants: [] })).toBe(expected);
        expect(planner.effectiveCategory({ useCase, category, variants: [{ metaCategory: category }] })).toBe(expected);
      },
    );

    test.each(NON_TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY'], [u, 'MARKETING']]))(
      'non-transactional %s requested as %s is MARKETING, even when Meta reports UTILITY', (useCase, category) => {
        expect(planner.effectiveCategory({ useCase, category, variants: [] })).toBe('MARKETING');
        expect(planner.effectiveCategory({ useCase, category, variants: [{ metaCategory: 'UTILITY' }, { metaCategory: 'utility' }] })).toBe('MARKETING');
      },
    );

    test.each([[undefined], [null], [''], ['no_such_use_case'], [42], [{}], [['payment_reminder']], ['PAYMENT_REMINDER'], [' payment_reminder']])(
      'an unknown or malformed use case (%j) is MARKETING', (useCase) => {
        expect(planner.effectiveCategory({ useCase, category: 'UTILITY', variants: [{ metaCategory: 'UTILITY' }] })).toBe('MARKETING');
      },
    );

    test('a UTILITY promotion is planned as MARKETING: consent gating, opt-out button required, category_floored warning', async () => {
      const { kit, template } = setup({ useCase: 'promotion', category: 'UTILITY', variants: [variant('en', { metaCategory: 'UTILITY' }), variant('ar', { metaCategory: 'UTILITY' })] });
      addCustomer(kit);
      addCustomer(kit, { marketingConsent: false });
      addCustomer(kit, { optedOut: true });
      const p = await plan(kit, template);
      expect(p.category).toBe('MARKETING');
      expect(p.audience.eligible).toBe(1);
      expect(p.skipped).toMatchObject({ noConsent: 1, optedOut: 1 });
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'promotion' } });
      expect(p.warnings.map((w) => w.code)).not.toContain('category_changed'); // Meta did not flip it: the floor did
      expect(p.canSend).toBe(true);
    });

    test('a UTILITY promotion without the opt-out button is unsendable (it is MARKETING)', async () => {
      const { kit, template } = setup({ useCase: 'promotion', category: 'UTILITY', variants: [variant('en', { buttons: [], metaCategory: 'UTILITY' })] });
      addCustomer(kit);
      const p = await plan(kit, template);
      expect(p.canSend).toBe(false);
      expect(p.warnings).toContainEqual({ code: 'marketing_variant_missing_opt_out', detail: { language: 'en' } });
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'promotion' } });
    });

    test('a promotion stored as MARKETING that Meta reports as UTILITY is still MARKETING; the plan says the floor acted', async () => {
      const { kit, template } = setup({ useCase: 'promotion', category: 'MARKETING', variants: [variant('en', { metaCategory: 'UTILITY' }), variant('ar', { metaCategory: 'MARKETING' })] });
      addCustomer(kit);
      addCustomer(kit, { marketingConsent: false });
      const p = await plan(kit, template);
      expect(p.category).toBe('MARKETING');
      expect(p.audience.eligible).toBe(1);
      expect(p.skipped.noConsent).toBe(1);
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'promotion' } });
      expect(p.warnings.filter((w) => w.code === 'category_floored')).toHaveLength(1);
    });

    test('a promotion that Meta reports as MARKETING needs no floor warning; a transactional template Meta reports as UTILITY neither', async () => {
      const marketing = setup({ useCase: 'promotion', category: 'MARKETING', variants: [variant('en', { metaCategory: 'MARKETING' })] });
      addCustomer(marketing.kit);
      expect((await plan(marketing.kit, marketing.template)).warnings.map((w) => w.code)).not.toContain('category_floored');
      const transactional = setup({ useCase: 'order_confirmation', category: 'UTILITY', variants: [variant('en', { buttons: [], metaCategory: 'UTILITY' })] });
      addCustomer(transactional.kit);
      expect((await plan(transactional.kit, transactional.template)).warnings).toEqual([]);
    });

    test.each(NON_TRANSACTIONAL)('%s stored as UTILITY warns category_floored with its use case; stored as MARKETING does not', async (useCase) => {
      const buttons = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }, { role: 'opt_out', text: 'Stop' }];
      const floored = setup({ useCase, category: 'UTILITY', variants: [variant('en', { buttons })] });
      addCustomer(floored.kit);
      const p = await plan(floored.kit, floored.template);
      expect(p.category).toBe('MARKETING');
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase } });

      const plain = setup({ useCase, category: 'MARKETING', variants: [variant('en', { buttons })] });
      addCustomer(plain.kit);
      expect((await plan(plain.kit, plain.template)).warnings.map((w) => w.code)).not.toContain('category_floored');
    });

    test.each(TRANSACTIONAL)('transactional %s stored as UTILITY: no floor warning, no consent needed', async (useCase) => {
      const { kit, template } = setup({ useCase, category: 'UTILITY', variants: [variant('en', { buttons: [], metaCategory: 'UTILITY' })] });
      addCustomer(kit, { marketingConsent: false });
      const p = await plan(kit, template);
      expect(p.category).toBe('UTILITY');
      expect(p.audience.eligible).toBe(1);
      expect(p.warnings).toEqual([]);
    });

    test('a template with no use case at all (legacy row) is MARKETING and warns with the model default "custom"', async () => {
      const { kit, template } = setup({ category: 'UTILITY', variants: [variant('en')] });
      delete kit.templates.docs[0].useCase;
      addCustomer(kit, { marketingConsent: false });
      const p = await plan(kit, template);
      expect(p.category).toBe('MARKETING');
      expect(p.audience.eligible).toBe(0);
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'custom' } });
    });

    test('the consent request keeps its exemption: welcome_optin requested as UTILITY is MARKETING, still reaches non-consented customers (opt-in + decline buttons), never opted-out ones', async () => {
      const buttons = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
      const { kit, template } = setup({ useCase: 'welcome_optin', category: 'UTILITY', variants: [variant('en', { body: 'Welcome to {business}. Offers?', buttons, metaCategory: 'UTILITY' })], merchantName: 'Cafe' });
      addCustomer(kit, { marketingConsent: false });
      addCustomer(kit, { marketingConsent: false, optedOut: true });
      const p = await plan(kit, template, { fieldValues: {} });
      expect(p.category).toBe('MARKETING');
      expect(p.audience.eligible).toBe(1);
      expect(p.skipped.optedOut).toBe(1);
      expect(p.canSend).toBe(true);
      expect(p.warnings).toContainEqual({ code: 'category_floored', detail: { useCase: 'welcome_optin' } });
      expect(p.warnings.map((w) => w.code)).not.toContain('marketing_variant_missing_opt_out');
    });
  });

  function consentRequestSetup() {
    const optIn = [{ role: 'opt_in', text: 'نعم' }, { role: 'decline', text: 'لا' }];
    const optInEn = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
    const { kit, template } = setup({
      category: 'MARKETING',
      variants: [variant('en', { body: 'Welcome to {business}. Would you like offers?', buttons: optInEn }), variant('ar', { body: 'أهلاً بك في {business}. هل تود استلام العروض؟', buttons: optIn })],
      merchantName: 'Cafe',
    });
    return { kit, template };
  }

  test('the consent request (welcome_optin) reaches customers who have NOT consented, without an opt-out button, and says who was left out', async () => {
    const { kit, template } = consentRequestSetup();
    kit.templates.docs[0].useCase = 'welcome_optin';
    addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { marketingConsent: true });
    addCustomer(kit, { marketingConsent: false, optedOut: true });
    addCustomer(kit, { marketingConsent: false, marketingConsentAskedAt: new Date(kit.clock.t - 24 * 60 * 60 * 1000) });
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.audience.eligible).toBe(2);
    expect(p.canSend).toBe(true);
    expect(p.warnings.map((w) => w.code)).not.toContain('marketing_variant_missing_opt_out');
    expect(p.warnings).toContainEqual({ code: 'consent_request_skipped', detail: { alreadyConsented: 1, askedRecently: 1 } });
    expect(p.skipped.optedOut).toBe(1);
    expect(p.variants.find((v) => v.language === 'en').sendable).toBe(true);
  });

  test('the consent-request exemption needs the opt-in AND decline buttons: a welcome_optin template without them is a plain marketing message to non-consented customers and is unsendable', async () => {
    for (const buttons of [[], [{ role: 'opt_out', text: 'Stop' }], [{ role: 'opt_in', text: 'Yes' }], [{ role: 'decline', text: 'No' }]]) {
      const { kit, template } = setup({ category: 'MARKETING', variants: [variant('en', { body: 'Everything is half price! Buy now', buttons })] });
      kit.templates.docs[0].useCase = 'welcome_optin';
      addCustomer(kit, { marketingConsent: false });
      const p = await plan(kit, template, { fieldValues: {} });
      expect(p.canSend).toBe(false);
      expect(p.warnings).toContainEqual({ code: 'marketing_variant_missing_opt_out', detail: { language: 'en' } });
      expect(p.variants.find((v) => v.language === 'en')).toMatchObject({ sendable: false, notSendableReason: 'no_opt_out_button' });
    }
  });

  test('any other MARKETING template without an opt-out button stays unsendable', async () => {
    const { kit, template } = consentRequestSetup(); // useCase promotion
    addCustomer(kit);
    const p = await plan(kit, template, { fieldValues: {} });
    expect(p.canSend).toBe(false);
    expect(p.warnings.map((w) => w.code)).toContain('marketing_variant_missing_opt_out');
  });

  test('large_audience warns above 250 recipients and not at 250', async () => {
    const { kit, template } = setup();
    addMany(kit, 250, {});
    expect((await plan(kit, template)).warnings.map((w) => w.code)).not.toContain('large_audience');
    addCustomer(kit);
    const p = await plan(kit, template);
    expect(p.warnings).toContainEqual({ code: 'large_audience', detail: { count: 251 } });
    expect(p.canSend).toBe(true); // informational only
  });

});
