const {
  detectLanguage, resolveLanguage, parseLanguageValue, isSupportedLanguage, isCustomerLanguage,
} = require('../../shared/localization/languageDetect');

describe('detectLanguage', () => {
  test.each([
    ['مرحبا', 'ar'],
    ['السلام عليكم ورحمة الله', 'ar'],
    ['أبغى أطلب قهوة', 'ar'],
    ['Hello', 'en'],
    ['Hi, I would like to order', 'en'],
    ['ok تمام', 'unknown'],
    ['👍', 'unknown'],
    ['12345', 'unknown'],
    ['', 'unknown'],
    ['a', 'unknown'],
  ])('"%s" -> %s', (text, expected) => {
    expect(detectLanguage(text).language).toBe(expected);
  });

  test('URLs, emails and @handles do not count as English evidence', () => {
    expect(detectLanguage('https://example.com/shop مرحبا').language).toBe('ar');
    expect(detectLanguage('test@example.com اشتقنا لك').language).toBe('ar');
  });

  test('digits and emoji around Arabic text do not matter', () => {
    expect(detectLanguage('طلب رقم ١٢٣ 🙏').language).toBe('ar');
  });

  test('exposes confidence and counts', () => {
    const r = detectLanguage('مرحبا');
    expect(r.confidence).toBe(1);
    expect(r.counts.arabic).toBe(5);
  });
});

describe('resolveLanguage fallback order: customer -> merchant default -> English', () => {
  test.each([
    ['ar', 'en', 'ar'],
    ['en', 'ar', 'en'],
    ['unknown', 'ar', 'ar'],
    [undefined, 'ar', 'ar'],
    ['unknown', 'en', 'en'],
    ['unknown', undefined, 'en'],
    [null, null, 'en'],
    ['fr', 'de', 'en'],
  ])('customer=%s merchant=%s -> %s', (c, m, expected) => {
    expect(resolveLanguage(c, m)).toBe(expected);
  });
});

describe('parseLanguageValue (CSV language column)', () => {
  test.each([
    ['ar', 'ar'], ['AR', 'ar'], [' Arabic ', 'ar'], ['arabic', 'ar'], ['ar-SA', 'ar'], ['عربي', 'ar'], ['العربية', 'ar'],
    ['en', 'en'], ['EN', 'en'], ['English', 'en'], [' english ', 'en'], ['en-US', 'en'], ['انجليزي', 'en'], ['إنجليزي', 'en'],
    ['', 'unknown'], [null, 'unknown'], [undefined, 'unknown'], ['unknown', 'unknown'],
  ])('%j -> %s', (input, expected) => {
    expect(parseLanguageValue(input)).toBe(expected);
  });
  test('unrecognised values return null so callers can report them', () => {
    expect(parseLanguageValue('klingon')).toBeNull();
    expect(parseLanguageValue('fr')).toBeNull();
  });
});

test('language guards', () => {
  expect(isSupportedLanguage('ar')).toBe(true);
  expect(isSupportedLanguage('unknown')).toBe(false);
  expect(isCustomerLanguage('unknown')).toBe(true);
  expect(isCustomerLanguage('fr')).toBe(false);
});
