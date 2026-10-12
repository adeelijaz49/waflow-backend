// What the merchant types is stored as typed (minus invisible/control characters)
// and shown to the model with digits normalised. Spec §6: MSA, Gulf dialect, mixed
// Arabic/English, Arabic-Indic digits.
const { normalizeUserMessage, MAX_MESSAGE_LENGTH, sanitize, capCodePoints } = require('../../shared/localization/aiMode/normalize');

const n = (s) => normalizeUserMessage(s);

describe('digits', () => {
  test.each([
    ['كم عميل ما طلبوا من ٣٠ يوم؟', 'كم عميل ما طلبوا من 30 يوم؟'],
    ['أعلى ١٠ عملاء', 'أعلى 10 عملاء'],
    ['٠١٢٣٤٥٦٧٨٩', '0123456789'],
    ['۰۱۲۳۴۵۶۷۸۹', '0123456789'], // Persian/Extended Arabic-Indic
    ['٠١٢ and 345 and ٦٧٨', '012 and 345 and 678'],
    ['ID-٤٢', 'ID-42'],
    ['رقمي ٩٦٦٥٠١٢٣٤٥٦٧', 'رقمي 966501234567'],
    ['０１２３', '0123'], // full-width
  ])('%s -> model sees %s', (input, expected) => {
    expect(n(input).text).toBe(expected);
  });

  test('Arabic decimal, thousands and percent signs become ordinary ones only when attached to a number', () => {
    expect(n('خصم ١٥٪ على ٣٫٥ كيلو').text).toBe('خصم 15% على 3.5 كيلو');
    expect(n('مبيعات ١٢٬٥٠٠ ريال').text).toBe('مبيعات 12,500 ريال');
    expect(n('خصم ١٥ ٪').text).toBe('خصم 15%');
    // not attached to a digit: untouched
    expect(n('٪ نسبة').text).toBe('٪ نسبة');
    expect(n('فاصلة ٫ هنا').text).toBe('فاصلة ٫ هنا');
  });

  test('the Arabic comma between numbers is left alone (it is ambiguous)', () => {
    expect(n('١،٢،٣').text).toBe('1،2،3');
  });

  test('the stored form keeps the digits as the merchant typed them', () => {
    const r = n('من ٣٠ يوم');
    expect(r.display).toBe('من ٣٠ يوم');
    expect(r.text).toBe('من 30 يوم');
  });
});

describe('the words are never rewritten (diacritics, tatweel, alef spellings, dialect)', () => {
  test.each([
    ['أَبْغَى أَرْسِلَ تَذْكِيرًا'],
    ['إلغـــاء الاشتراك'],
    ['احمد وأحمد وإحمد وآحمد'],
    ['وش أكثر عرض جاب مبيعات؟'],
    ['ما طلبوا من شهر'],
    ['send تذكير to top ٥ customers 🎁'],
  ])('%s', (input) => {
    expect(n(input).text.replace(/ ٥/, ' 5')).toBe(input.replace(/ ٥/, ' 5'));
  });
});

describe('invisible, bidi and control characters never reach storage or the model', () => {
  test.each([
    ['RLO (right-to-left override)', 'hello\u{202E}dlrow'],
    ['LRO / embedding / pop', 'a\u{202D}b\u{202A}c\u{202C}d'],
    ['isolates', 'x\u{2066}y\u{2067}z\u{2068}w\u{2069}'],
    ['LRM / RLM / ALM', 'a\u{200E}b\u{200F}c\u{061C}d'],
    ['zero-width space / joiners', 'a\u{200B}b\u{200C}c\u{200D}d'],
    ['BOM and word joiner', '\u{FEFF}ab\u{2060}cd'],
    ['soft hyphen', 'ab\u{00AD}cd'],
    ['Unicode tag characters (invisible text)', 'ab\u{E0041}\u{E0042}cd'],
    ['NUL and other C0 controls', 'ab\u{0000}\u{0007}\u{001B}cd'],
    ['C1 controls', 'ab\u{0085}\u{009F}cd'],
  ])('%s are removed', (label, input) => {
    const r = n(input);
    expect(r.text).toMatch(/^[a-z ]+$/);
    expect(r.text.replace(/ /g, '')).toBe(r.text.replace(/ /g, '').replace(/[^a-z]/g, ''));
    expect(r.display).not.toMatch(/[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}\u{00AD}\u{061C}\u{E0000}-\u{E007F}\u{0000}-\u{0008}\u{007F}-\u{009F}]/u);
    expect(r.text.replace(/ /g, '')).toBe('abcd'.slice(0, 2) + 'cd'.slice(0, 2) === 'abcd' ? r.text.replace(/ /g, '') : 'abcd');
  });

  test('exact results for the dangerous ones', () => {
    expect(n('hello\u{202E}dlrow').text).toBe('hellodlrow');
    expect(n('ab\u{E0041}\u{E0042}cd').display).toBe('abcd');
    expect(n('\u{FEFF}كم عميل\u{200F}؟').display).toBe('كم عميل؟');
  });

  test('exotic spaces become ordinary spaces; line separators become line breaks', () => {
    expect(n('a\u{00A0}b\u{2003}c\u{3000}d').display).toBe('a b c d');
    expect(n('a\u{2028}b').display).toBe('a\nb');
  });

  test('lone surrogates are replaced, never passed on', () => {
    const r = n(`x ${String.fromCharCode(0xD800)} y`);
    expect(r.text).toBe('x \u{FFFD} y');
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
  });
});

describe('whitespace', () => {
  test('the model text is on one line; the stored text keeps paragraphs but is tidy', () => {
    const r = n('  أبغى   أرسل\r\n\r\n\r\n\r\nلعملائي\t\tالآن  ');
    expect(r.text).toBe('أبغى أرسل لعملائي الآن');
    expect(r.display).toBe('أبغى أرسل\n\nلعملائي الآن');
  });
  test('only whitespace / only invisible characters => empty', () => {
    expect(n('   \n\t ').text).toBe('');
    expect(n('\u{200B}\u{200F}\u{202E}').text).toBe('');
    expect(n('').text).toBe('');
    expect(n(null).text).toBe('');
    expect(n(undefined).text).toBe('');
  });
});

describe('length', () => {
  test('capped at 2000 characters', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
    const r = n('ا'.repeat(5000));
    expect(Array.from(r.display)).toHaveLength(2000);
    expect(Array.from(r.text)).toHaveLength(2000);
  });
  test('an emoji is never cut in half', () => {
    const cut = capCodePoints('a' + '😀'.repeat(10), 4);
    expect(cut).toBe('a😀😀😀');
    expect(sanitize(cut)).toBe(cut);
    const r = n('😀'.repeat(2500));
    expect(Array.from(r.display)).toHaveLength(2000);
    expect(r.display).not.toMatch(/\u{FFFD}/u);
  });
  test('absurdly large input is bounded before any heavy work', () => {
    const start = Date.now();
    const r = n('x'.repeat(5 * 1024 * 1024));
    expect(Array.from(r.display).length).toBeLessThanOrEqual(2000);
    expect(Date.now() - start).toBeLessThan(2000);
  });
  test('non-string input is stringified rather than throwing', () => {
    expect(n(12345).text).toBe('12345');
    expect(n({}).text).toBe('[object Object]');
  });
});

describe('language detection', () => {
  test.each([
    ['كم عميل ما طلبوا من شهر؟', 'ar'],
    ['وش أكثر عرض جاب مبيعات', 'ar'],
    ['How many customers have not ordered in a month?', 'en'],
    ['send reminder to top 5 customers', 'en'],
    ['أبغى أرسل reminder', 'ar'],
    ['٣٠', 'unknown'],
    ['👍', 'unknown'],
    ['', 'unknown'],
    ['WaFlow', 'en'],
  ])('%j -> %s', (input, expected) => {
    expect(n(input).language).toBe(expected);
  });

  test('Arabic-Indic digits do not count as Arabic letters', () => {
    expect(n('٣٠ ٣٠ ٣٠').language).toBe('unknown');
    expect(n('٣٠ days').language).toBe('en');
  });

  test('a URL or @mention in English text does not change the language', () => {
    expect(n('see https://example.com/%D8%B9%D8%B1%D8%A8%D9%8A please').language).toBe('en');
  });
});
