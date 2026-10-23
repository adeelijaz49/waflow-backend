'use strict';
const testTemplate = require('../../../shared/onboarding/testTemplate');
const metaConstraints = require('../../../shared/localization/metaConstraints');
const metaTemplates = require('../../../shared/localization/metaTemplates');
const mergeFields = require('../../../shared/localization/mergeFields');
const { makeWorld, WS } = require('./_b1eKit');

describe('constants and variants', () => {
  test('key and category', () => {
    expect(testTemplate.TEST_TEMPLATE_KEY).toBe('setup_test');
    expect(testTemplate.TEST_TEMPLATE_CATEGORY).toBe('UTILITY');
    expect(testTemplate.TEST_TEMPLATE_TITLE.en).toBeTruthy();
    expect(testTemplate.TEST_TEMPLATE_TITLE.ar).toBeTruthy();
  });

  test.each(['en', 'ar'])('%s variant: no variables, no header/footer/buttons, passes validateVariant as UTILITY', (lang) => {
    const v = testTemplate.buildTestTemplate(lang);
    expect(v.language).toBe(lang);
    expect(v.source).toBe('setup_test');
    expect(mergeFields.extractFields(v.body)).toEqual([]);
    expect(v.buttons).toEqual([]);
    expect(v.header).toBeUndefined();
    expect(v.footer).toBeUndefined();
    const check = metaConstraints.validateVariant(v, { category: 'UTILITY' });
    expect(check.errors).toEqual([]);
    expect(check.ok).toBe(true);
  });

  test('the Arabic copy is Arabic, keeps the brand Latin and writes WhatsApp in Arabic', () => {
    const v = testTemplate.buildTestTemplate('ar');
    expect(v.body).toMatch(/[\u{0600}-\u{06FF}]/u);
    expect(v.body).toContain('WaFlow');
    expect(v.body).toContain('واتساب');
    expect(v.body).not.toMatch(/WhatsApp/);
  });

  test('non-promotional wording (UTILITY)', () => {
    for (const lang of ['en', 'ar']) {
      expect(testTemplate.buildTestTemplate(lang).body).not.toMatch(/%|discount|offer|sale|خصم|عرض/i);
    }
  });

  test('submission payload: UTILITY, language en / ar (never ar_SA), BODY only, no example needed', () => {
    for (const lang of ['en', 'ar']) {
      const name = metaTemplates.buildTemplateName({ workspaceId: WS, key: testTemplate.TEST_TEMPLATE_KEY, language: lang, revision: 1 });
      expect(name).toBe(`wf_439011_setup_test_${lang}_v1`);
      const payload = metaTemplates.buildSubmissionPayload({ name, variant: testTemplate.buildTestTemplate(lang), category: 'UTILITY' });
      expect(payload.language).toBe(lang);
      expect(payload.category).toBe('UTILITY');
      expect(payload.components).toEqual([{ type: 'BODY', text: testTemplate.buildTestTemplate(lang).body }]);
    }
  });

  test('unsupported language throws', () => {
    expect(() => testTemplate.buildTestTemplate('fr')).toThrow(RangeError);
    expect(() => testTemplate.buildTestTemplate('ar_SA')).toThrow(RangeError);
    expect(() => testTemplate.buildTestTemplate(undefined)).toThrow(RangeError);
  });
});

describe('ensureTestTemplate (queues, never calls Meta)', () => {
  test('English-only merchant: en queued, ar blocked arabic_not_reviewed; idempotent', async () => {
    const w = makeWorld();
    const a = await testTemplate.ensureTestTemplate(WS, w.deps);
    expect(a).toEqual({ created: 2, existing: 0, total: 2 });
    const rows = w.Template.rows;
    const en = rows.find((r) => r.language === 'en');
    const ar = rows.find((r) => r.language === 'ar');
    expect(en).toMatchObject({ key: 'setup_test', source: 'setup_test', category: 'UTILITY', revision: 1, blockedReason: null });
    expect(ar).toMatchObject({ key: 'setup_test', source: 'setup_test', blockedReason: 'arabic_not_reviewed' });
    const b = await testTemplate.ensureTestTemplate(WS, w.deps);
    expect(b).toEqual({ created: 0, existing: 2, total: 2 });
    expect(rows).toHaveLength(2);
    expect(w.client.calls).toHaveLength(0);
  });

  test('Arabic merchant: the Arabic test template is queued too (not legal-sensitive)', async () => {
    const w = makeWorld({ languages: ['en', 'ar'] });
    await testTemplate.ensureTestTemplate(WS, w.deps);
    expect(w.Template.rows.find((r) => r.language === 'ar').blockedReason).toBeNull();
  });
});
