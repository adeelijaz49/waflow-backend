const { pickVariant, planAudience, checkSendable, findVariant } = require('../../shared/localization/variantSelection');

const v = (language, metaStatus, reviewStatus) => ({ language, body: `body-${language}`, metaStatus, reviewStatus });
const tpl = (...variants) => ({ variants });

const EN_OK = v('en', 'APPROVED', 'reviewed');
const AR_OK = v('ar', 'APPROVED', 'reviewed');
const AR_PENDING = v('ar', 'PENDING', 'reviewed');
const AR_APPROVED_DRAFT = v('ar', 'APPROVED', 'draft');
const BI_OK = v('bilingual', 'APPROVED', 'reviewed');

describe('checkSendable', () => {
  test('requires Meta APPROVED', () => {
    expect(checkSendable(EN_OK).ok).toBe(true);
    expect(checkSendable(v('en', 'PENDING'))).toEqual({ ok: false, reason: 'pending' });
    expect(checkSendable(v('en', 'REJECTED'))).toEqual({ ok: false, reason: 'rejected' });
    expect(checkSendable(v('en', 'NOT_CREATED'))).toEqual({ ok: false, reason: 'not_submitted' });
    expect(checkSendable(v('en', 'PAUSED'))).toEqual({ ok: false, reason: 'paused' });
    expect(checkSendable(null)).toEqual({ ok: false, reason: 'missing' });
  });
  test('Arabic must also be natively reviewed (spec §8); English must not', () => {
    expect(checkSendable(AR_APPROVED_DRAFT)).toEqual({ ok: false, reason: 'not_reviewed' });
    expect(checkSendable(v('en', 'APPROVED', 'draft')).ok).toBe(true);
    expect(checkSendable(AR_APPROVED_DRAFT, { requireNativeReview: false }).ok).toBe(true);
  });
});

describe('pickVariant — per customer (default)', () => {
  test('Arabic customer gets Arabic, English customer gets English', () => {
    const t = tpl(EN_OK, AR_OK);
    expect(pickVariant(t, { customerLanguage: 'ar', merchantDefault: 'en' })).toMatchObject({ usedLanguage: 'ar', fallback: false, blocked: false, reason: 'ok' });
    expect(pickVariant(t, { customerLanguage: 'en', merchantDefault: 'ar' })).toMatchObject({ usedLanguage: 'en', fallback: false, blocked: false });
  });

  test('unknown customer language uses the merchant default', () => {
    const t = tpl(EN_OK, AR_OK);
    expect(pickVariant(t, { customerLanguage: 'unknown', merchantDefault: 'ar' }).usedLanguage).toBe('ar');
    expect(pickVariant(t, { customerLanguage: undefined, merchantDefault: 'en' }).usedLanguage).toBe('en');
  });

  test('Arabic not approved -> falls back to English, and says so (never silent)', () => {
    const r = pickVariant(tpl(EN_OK, AR_PENDING), { customerLanguage: 'ar', merchantDefault: 'en' });
    expect(r).toMatchObject({ usedLanguage: 'en', requestedLanguage: 'ar', fallback: true, blocked: false, reason: 'ar_pending' });
    expect(r.attempts[0]).toEqual({ language: 'ar', ok: false, reason: 'pending' });
  });

  test('Arabic approved but still draft (not natively reviewed) falls back with that reason', () => {
    const r = pickVariant(tpl(EN_OK, AR_APPROVED_DRAFT), { customerLanguage: 'ar', merchantDefault: 'en' });
    expect(r).toMatchObject({ usedLanguage: 'en', fallback: true, reason: 'ar_not_reviewed' });
  });

  test('fallback order is customer -> merchant default -> English', () => {
    const t = tpl(AR_OK); // no English at all
    expect(pickVariant(t, { customerLanguage: 'en', merchantDefault: 'ar' })).toMatchObject({ usedLanguage: 'ar', fallback: true });
  });

  test('nothing usable -> blocked, no variant (never a blank or wrong-language send)', () => {
    const r = pickVariant(tpl(v('en', 'PENDING'), AR_PENDING), { customerLanguage: 'ar', merchantDefault: 'en' });
    expect(r).toMatchObject({ variant: null, blocked: true, usedLanguage: null, reason: 'no_usable_variant' });
    expect(pickVariant(tpl(), { customerLanguage: 'ar' }).blocked).toBe(true);
    expect(pickVariant(null, { customerLanguage: 'en' }).blocked).toBe(true);
  });
});

describe('pickVariant — explicit single-language and bilingual modes', () => {
  test('explicit Arabic never falls back silently: unusable -> blocked', () => {
    const r = pickVariant(tpl(EN_OK, AR_PENDING), { customerLanguage: 'en', merchantDefault: 'en', languageMode: 'ar' });
    expect(r).toMatchObject({ blocked: true, variant: null, fallback: false, reason: 'ar_pending' });
  });
  test('explicit English / Arabic ignore the customer language', () => {
    const t = tpl(EN_OK, AR_OK);
    expect(pickVariant(t, { customerLanguage: 'ar', languageMode: 'en' }).usedLanguage).toBe('en');
    expect(pickVariant(t, { customerLanguage: 'en', languageMode: 'ar' }).usedLanguage).toBe('ar');
  });
  test('bilingual uses the bilingual variant when approved', () => {
    const r = pickVariant(tpl(EN_OK, AR_OK, BI_OK), { customerLanguage: 'ar', languageMode: 'bilingual' });
    expect(r).toMatchObject({ usedLanguage: 'bilingual', variant: BI_OK, fallback: false });
  });
  test('bilingual not approved -> per-customer rule with an explicit reason', () => {
    const r = pickVariant(tpl(EN_OK, AR_OK, v('bilingual', 'PENDING', 'reviewed')), { customerLanguage: 'ar', merchantDefault: 'en', languageMode: 'bilingual' });
    expect(r).toMatchObject({ usedLanguage: 'ar', requestedLanguage: 'bilingual', fallback: true, reason: 'bilingual_pending' });
  });
});

describe('planAudience — the campaign preview numbers', () => {
  const customers = [
    { customerId: 'a', language: 'ar' }, { customerId: 'b', language: 'ar' }, { customerId: 'c', language: 'en' },
    { customerId: 'd', language: 'unknown' }, { customerId: 'e' },
  ];

  test('counts per used language', () => {
    const plan = planAudience(tpl(EN_OK, AR_OK), customers, { merchantDefault: 'en' });
    expect(plan).toMatchObject({ total: 5, usable: 5, blocked: 0, byLanguage: { en: 3, ar: 2, bilingual: 0 }, fallbacks: [] });
  });

  test('"N customers will receive English because no approved Arabic version exists"', () => {
    const plan = planAudience(tpl(EN_OK, AR_PENDING), customers, { merchantDefault: 'en' });
    expect(plan.byLanguage).toEqual({ en: 5, ar: 0, bilingual: 0 });
    expect(plan.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'ar_pending', count: 2 }]);
  });

  test('blocked customers are counted with reasons', () => {
    const plan = planAudience(tpl(EN_OK, AR_PENDING), customers, { merchantDefault: 'en', languageMode: 'ar' });
    expect(plan).toMatchObject({ usable: 0, blocked: 5, blockedReasons: { ar_pending: 5 } });
  });

  test('empty audience', () => {
    expect(planAudience(tpl(EN_OK), [], {})).toMatchObject({ total: 0, usable: 0, blocked: 0 });
  });

  test('perCustomer rows are returned in order', () => {
    const plan = planAudience(tpl(EN_OK, AR_OK), customers, { merchantDefault: 'en' });
    expect(plan.perCustomer.map((p) => p.usedLanguage)).toEqual(['ar', 'ar', 'en', 'en', 'en']);
  });
});

test('findVariant', () => {
  expect(findVariant(tpl(EN_OK, AR_OK), 'ar')).toBe(AR_OK);
  expect(findVariant(tpl(EN_OK), 'ar')).toBeNull();
});
