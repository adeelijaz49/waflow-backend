// Pure unit tests (no database): approved global change B2a / B2c / O4 - Arabic-Indic digits in
// phone numbers, price cells and typed codes. The proof obligation is "only widens inputs that
// FAIL (or silently give a wrong answer) today": a before/after table for the Arabic inputs, and a
// seeded fuzz comparing the patched functions with verbatim copies of the PRISTINE implementations
// (pre-Arabic commit 20082c8) for inputs without Arabic-script characters - zero differences.
const { normalizePhoneForDedup } = require('../../utils/phoneNormalize');
const { parsePrice } = require('../../utils/currency');
const { toWesternDigits, toWesternNumerals } = require('../../shared/localization/arabicText');

// ── pristine reference implementations (verbatim bodies from the pre-Arabic backend) ──
function pristinePhone(rawPhone, defaultCountryCode) {
  if (!rawPhone) return null;
  const hasPlus = String(rawPhone).trim().startsWith('+');
  const digits = String(rawPhone).replace(/\D/g, '');
  if (!digits) return null;
  const cc = String(defaultCountryCode || '').replace(/\D/g, '');
  if (hasPlus) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0')) return cc + digits.replace(/^0+/, '');
  if (cc && digits.startsWith(cc)) return digits;
  return cc + digits;
}
function pristinePrice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}
// routes/auth.js + routes/workspaces.js normalizePhone, before and after.
const pristineLoginPhone = (phone) => String(phone || '').replace(/\D/g, '');
const patchedLoginPhone = (phone) => toWesternDigits(String(phone || '')).replace(/\D/g, '');

// ── a small deterministic PRNG so a failure is reproducible ──
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// No Arabic-script letters, no Arabic-Indic / Persian digits, no U+066B / U+066C. Arabic comma and
// semicolon, tatweel, bidi marks, Latin accents, currency signs, emoji are all allowed (they must
// pass through unchanged).
const ALPHABET = Array.from('0123456789 +-().,/_abcXYZ$\u{00A3}\u{20AC}SAR\té\u{060C}\u{061B}\u{200E}\u{200F}\u{0640}\u{1F600}');

function randomString(rng, maxLen) {
  const len = 1 + Math.floor(rng() * maxLen);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

const SPECIAL = [undefined, null, '', 0, 12.5, NaN, Infinity, -3, '0501234567', '+966501234567', '00966501234567',
  '966501234567', '501234567', 'SAR 1,234.50', '$99', '1200', '-5', '1e3', ' ', '  +61 4 12 345 678 ', '(02) 9999 1234'];
const COUNTRY_CODES = ['966', '61', '', undefined, '+966', 'x'];

describe('B2a/B2c identity: inputs without Arabic script or numerals behave exactly as before', () => {
  test('fuzz: 120,000 strings x phone/price/login-phone - zero differences', () => {
    const rng = makeRng(20261012);
    const inputs = [...SPECIAL, ...Array.from({ length: 120000 }, () => randomString(rng, 16))];
    let comparisons = 0;
    const diffs = [];
    for (const value of inputs) {
      for (const cc of COUNTRY_CODES) {
        comparisons += 1;
        if (normalizePhoneForDedup(value, cc) !== pristinePhone(value, cc)) diffs.push(['phone', value, cc]);
      }
      comparisons += 1;
      const a = parsePrice(value);
      const b = pristinePrice(value);
      if (!(a === b || (Number.isNaN(a) && Number.isNaN(b)))) diffs.push(['price', value]);
      comparisons += 1;
      if (patchedLoginPhone(value) !== pristineLoginPhone(value)) diffs.push(['login', value]);
    }
    expect(diffs.slice(0, 5)).toEqual([]);
    expect(comparisons).toBeGreaterThan(700000);
  });

  test('toWesternNumerals returns the SAME string for anything without Arabic script / numerals', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20000; i += 1) {
      const s = randomString(rng, 20);
      expect(toWesternNumerals(s)).toBe(s);
    }
    expect(toWesternNumerals(undefined)).toBe('');
    expect(toWesternNumerals(null)).toBe('');
  });

  test('Arabic-script SYMBOLS (percent sign U+066A, comma/semicolon, tatweel) are not Arabic letters: identical to before', () => {
    for (const cell of ['8\u{066A}.9', '8\u{066A}', '1\u{060C}5', '12\u{061B}3', '4\u{0640}5', '\u{066A}.5']) {
      expect(parsePrice(cell)).toBe(pristinePrice(cell));
      expect(toWesternNumerals(cell)).toBe(cell);
    }
  });

  test('plain Latin names / accents / emoji in a price cell stay unparseable exactly as before', () => {
    for (const cell of ['free', 'N/A', 'Jos\u{00E9}', '\u{1F600}', 'SAR', '--', '.', '-']) {
      expect(parsePrice(cell)).toBe(pristinePrice(cell));
    }
  });
});

describe('B2a phone numbers typed in Arabic-Indic / Persian digits', () => {
  const D = '\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}';
  const P = '\u{06F0}\u{06F1}\u{06F2}\u{06F3}\u{06F4}\u{06F5}\u{06F6}\u{06F7}\u{06F8}\u{06F9}';
  const ar = (digits) => Array.from(digits, (d) => D[Number(d)]).join('');
  const fa = (digits) => Array.from(digits, (d) => P[Number(d)]).join('');

  test.each([
    ['local number', ar('0501234567'), '966', '966501234567'],
    ['plus international with spaces', `+${ar('966')} ${ar('50')} ${ar('123')} ${ar('4567')}`, '966', '966501234567'],
    ['plus international', `+${ar('966501234567')}`, '966', '966501234567'],
    ['00 prefix', ar('00966501234567'), '966', '966501234567'],
    ['bare international', ar('966501234567'), '966', '966501234567'],
    ['bare national (no trunk zero)', ar('501234567'), '966', '966501234567'],
    ['Persian digits', fa('0501234567'), '966', '966501234567'],
    ['dashes', `${ar('050')}-${ar('123')}-${ar('4567')}`, '966', '966501234567'],
    ['mixed Arabic and Western digits', `+966 ${ar('50')} 123 4567`, '966', '966501234567'],
    ['other country code', ar('0412345678'), '61', '61412345678'],
    ['no default country code, plus form', `+${ar('61412345678')}`, '', '61412345678'],
  ])('%s', (name, input, cc, expected) => {
    expect(normalizePhoneForDedup(input, cc)).toBe(expected);
  });

  test('before/after: Arabic digits were rejected (null) or silently WRONG, now correct', () => {
    expect(pristinePhone(ar('0501234567'), '966')).toBeNull(); // before: row error
    expect(normalizePhoneForDedup(ar('0501234567'), '966')).toBe('966501234567');
    // before: the Arabic part vanished and a truncated WRONG number was accepted
    expect(pristinePhone(`+966 ${ar('50')} 123 4567`, '966')).toBe('9661234567');
    expect(normalizePhoneForDedup(`+966 ${ar('50')} 123 4567`, '966')).toBe('966501234567');
  });

  test('hidden bidi marks around the digits do not matter', () => {
    const marked = `\u{200F}${ar('0501234567')}\u{200E}`;
    expect(normalizePhoneForDedup(marked, '966')).toBe('966501234567');
    expect(normalizePhoneForDedup(`\u{200E}+966501234567\u{200E}`, '966')).toBe(pristinePhone(`\u{200E}+966501234567\u{200E}`, '966'));
  });

  test('arabic letters in a phone cell are still dropped (no digits => still invalid)', () => {
    expect(normalizePhoneForDedup('\u{0647}\u{0627}\u{062A}\u{0641}', '966')).toBeNull();
  });

  test('login-phone normalisation (routes/auth.js, routes/workspaces.js) accepts Arabic digits', () => {
    expect(pristineLoginPhone(`+${ar('966501234567')}`)).toBe('');
    expect(patchedLoginPhone(`+${ar('966501234567')}`)).toBe('966501234567');
    expect(patchedLoginPhone('+966 50 123 4567')).toBe('966501234567');
    expect(patchedLoginPhone(undefined)).toBe('');
    expect(patchedLoginPhone(null)).toBe('');
  });

  test('typed one-time code in Arabic-Indic digits (O4) equals the Western code', () => {
    expect(toWesternDigits(ar('123456'))).toBe('123456');
    expect(toWesternDigits(fa('048192'))).toBe('048192');
    expect(toWesternDigits('123456')).toBe('123456');
    expect(toWesternDigits(' 12 34 ')).toBe(' 12 34 ');
  });
});

describe('B2c price / number cells in Arabic', () => {
  const D = '\u{0660}\u{0661}\u{0662}\u{0663}\u{0664}\u{0665}\u{0666}\u{0667}\u{0668}\u{0669}';
  const ar = (digits) => Array.from(digits, (d) => (/\d/.test(d) ? D[Number(d)] : d)).join('');
  const DEC = '\u{066B}';
  const THOU = '\u{066C}';
  const SAR_ABBR = '\u{0631}.\u{0633}'; // ر.س
  const RIYAL = '\u{0631}\u{064A}\u{0627}\u{0644}'; // ريال
  const FREE = '\u{0645}\u{062C}\u{0627}\u{0646}\u{064A}'; // مجاني

  test.each([
    ['digits only', ar('123'), 123],
    ['negative', `-${ar('5')}`, -5],
    ['Arabic decimal separator', `${ar('3')}${DEC}${ar('5')}`, 3.5],
    ['decimal with two places', `${ar('123')}${DEC}${ar('50')}`, 123.5],
    ['thousands + decimal separators', `${ar('1')}${THOU}${ar('234')}${DEC}${ar('50')}`, 1234.5],
    ['amount then SAR abbreviation', `${ar('45')} ${SAR_ABBR}`, 45],
    ['riyal word then amount', `${RIYAL} ${ar('45')}`, 45],
    ['decimal amount then abbreviation with trailing dot', `${ar('45')}${DEC}${ar('50')} ${SAR_ABBR}.`, 45.5],
    ['mixed Western digits with Arabic decimal separator', `12${DEC}5`, 12.5],
    ['abbreviation first (its dot used to survive)', `${SAR_ABBR} 45`, 45],
    ['abbreviation first, Arabic digits', `${SAR_ABBR} ${ar('45')}${DEC}${ar('00')}`, 45],
    ['garbage mix: Arabic digits then Western', `${ar('123')} 45`, 12345],
  ])('%s', (name, input, expected) => {
    expect(parsePrice(input)).toBe(expected);
  });

  test('before/after table: failures and silently-wrong answers', () => {
    expect(pristinePrice(ar('123'))).toBeNull();
    expect(parsePrice(ar('123'))).toBe(123);
    expect(pristinePrice(`12${DEC}5`)).toBe(125); // silently wrong
    expect(parsePrice(`12${DEC}5`)).toBe(12.5);
    expect(pristinePrice(`${SAR_ABBR} 45`)).toBe(0.45); // silently wrong
    expect(parsePrice(`${SAR_ABBR} 45`)).toBe(45);
  });

  test('a word without any number is still not a price', () => {
    expect(parsePrice(FREE)).toBeNull();
    expect(parsePrice(`${RIYAL}`)).toBeNull();
    expect(parsePrice(SAR_ABBR)).toBeNull();
  });

  test('English cells are untouched: SAR 45.00, $99, 1,234.50, numbers', () => {
    expect(parsePrice('SAR 45.00')).toBe(45);
    expect(parsePrice('$99')).toBe(99);
    expect(parsePrice('1,234.50')).toBe(1234.5);
    expect(parsePrice(1200)).toBe(1200);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(NaN)).toBeNull();
  });

  test('emoji and very long strings do not break the conversion', () => {
    expect(parsePrice(`\u{1F4B0} ${ar('99')}`)).toBe(99);
    expect(parsePrice(`${'\u{0627}'.repeat(5000)} ${ar('7')}`)).toBe(7);
    expect(toWesternNumerals(`${ar('1')}${'x'.repeat(100000)}`).length).toBe(100001);
  });
});
