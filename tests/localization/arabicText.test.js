// Pure unit tests (no database) — spec §3.4 normalisation cases.
const {
  normalizeArabic, normalizeForMatch, toWesternDigits, stripDiacritics, stripTatweel, unifyAlef,
  stripInvisibles, countLetters, containsArabic, wrapLtr, isolateLtr, needsLtrProtection, LRM, LRI, PDI,
} = require('../../shared/localization/arabicText');

describe('normalizeArabic — spec §3.4 cases', () => {
  test('removes diacritics (tashkeel)', () => {
    expect(normalizeArabic('إِلْغَاءُ الاشْتِرَاكِ')).toBe('الغاء الاشتراك');
    expect(stripDiacritics('مَرْحَبًا')).toBe('مرحبا');
    expect(stripDiacritics('ًٌٍَُِّْٰ')).toBe('');
  });

  test('removes tatweel (kashida)', () => {
    expect(normalizeArabic('إلغـــاء')).toBe('الغاء');
    expect(stripTatweel('تـــوقـف')).toBe('توقف');
  });

  test.each([
    ['آ', 'alef with madda above'],
    ['أ', 'alef with hamza above'],
    ['إ', 'alef with hamza below'],
    ['ٱ', 'alef wasla'],
  ])('unifies alef variant %s (%s) to plain alef', (variant) => {
    expect(unifyAlef(variant)).toBe('ا');
    expect(normalizeArabic(`${variant}لغاء`)).toBe('الغاء');
  });

  test('إلغاء / ألغاء / آلغاء all normalise to the same string', () => {
    const forms = ['إلغاء', 'ألغاء', 'آلغاء', 'الغاء'];
    expect(new Set(forms.map(normalizeArabic)).size).toBe(1);
  });

  test('converts Arabic-Indic digits to Western digits', () => {
    expect(toWesternDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeArabic('طلب رقم ١٢٣')).toBe('طلب رقم 123');
  });

  test('converts Extended Arabic-Indic (Persian) digits too', () => {
    expect(toWesternDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
  });

  test('keeps Western digits untouched and handles mixed digits', () => {
    expect(normalizeArabic('٥٠ و 60 و ۷۰')).toBe('50 و 60 و 70');
  });

  test('maps Arabic punctuation and numeric separators', () => {
    expect(normalizeArabic('نعم،')).toBe('نعم,');
    expect(normalizeArabic('كم؟')).toBe('كم?');
    expect(normalizeArabic('٣٫٥')).toBe('3.5');
    expect(normalizeArabic('١٬٢٠٠')).toBe('1,200');
    expect(normalizeArabic('١٥٪')).toBe('15%');
  });

  test('drops zero-width and bidi control characters', () => {
    expect(normalizeArabic('\u{200F}توقف\u{200E}')).toBe('توقف');
    expect(normalizeArabic('\u{2067}توقف\u{2069}')).toBe('توقف');
    expect(stripInvisibles('a\u{200B}b\u{FEFF}c')).toBe('abc');
  });

  test('NFKC folds presentation forms (lam-alef ligature, Allah ligature)', () => {
    expect(normalizeArabic('ﻻ')).toBe('لا');
    expect(normalizeArabic('ﷲ')).toBe('الله');
  });

  test('is safe on empty / nullish / non-string input', () => {
    expect(normalizeArabic('')).toBe('');
    expect(normalizeArabic(null)).toBe('');
    expect(normalizeArabic(undefined)).toBe('');
    expect(normalizeArabic(12345)).toBe('12345');
  });

  test('never alters Latin text', () => {
    expect(normalizeArabic('Hello World 123')).toBe('Hello World 123');
  });
});

describe('normalizeForMatch', () => {
  test('strips punctuation, emoji and extra whitespace', () => {
    expect(normalizeForMatch('  توقف!!!  ')).toBe('توقف');
    expect(normalizeForMatch('إيقاف.')).toBe('ايقاف');
    expect(normalizeForMatch('«إلغاء الاشتراك»')).toBe('الغاء الاشتراك');
    expect(normalizeForMatch('توقف 🛑')).toBe('توقف');
    expect(normalizeForMatch('الغاء     الاشتراك')).toBe('الغاء الاشتراك');
  });

  test('lower-cases Latin', () => {
    expect(normalizeForMatch('STOP.')).toBe('stop');
  });

  test('unifies teh marbuta / heh and yeh / alef maksura spellings', () => {
    expect(normalizeForMatch('موافقة')).toBe(normalizeForMatch('موافقه'));
    expect(normalizeForMatch('على')).toBe(normalizeForMatch('علي'));
    expect(normalizeForMatch('مستشفى')).toBe(normalizeForMatch('مستشفي'));
  });

  test('digits are Western after matching normalisation', () => {
    expect(normalizeForMatch('٠٥٠١٢٣٤٥٦٧')).toBe('0501234567');
  });

  test('combines every rule on a hostile input', () => {
    expect(normalizeForMatch('\u{200F}إِلْغَـــاءُ\u{200E}  الإِشْتِرَاكِ؟!')).toBe('الغاء الاشتراك');
  });
});

describe('letters and direction helpers', () => {
  test('countLetters separates scripts and ignores digits/punctuation/emoji', () => {
    expect(countLetters('مرحبا Sara 123 !!! 😀')).toEqual({ arabic: 5, latin: 4, other: 0 });
    expect(countLetters('12345')).toEqual({ arabic: 0, latin: 0, other: 0 });
  });

  test('containsArabic', () => {
    expect(containsArabic('hello مرحبا')).toBe(true);
    expect(containsArabic('hello')).toBe(false);
    expect(containsArabic('١٢٣')).toBe(false); // digits alone are not letters
  });

  test('wrapLtr / isolateLtr add the right marks', () => {
    expect(wrapLtr('50 SAR')).toBe(`${LRM}50 SAR${LRM}`);
    expect(isolateLtr('Sara')).toBe(`${LRI}Sara${PDI}`);
  });

  test('needsLtrProtection: Latin/number values only', () => {
    expect(needsLtrProtection('50 SAR')).toBe(true);
    expect(needsLtrProtection('Sara')).toBe(true);
    expect(needsLtrProtection('سارة')).toBe(false);
    expect(needsLtrProtection('سارة Smith')).toBe(false);
    expect(needsLtrProtection('')).toBe(false);
    expect(needsLtrProtection('...')).toBe(false);
  });
});
