const {
  extractFields, extractOccurrences, findInvalidPlaceholders, renderMessage, renderMessageSafe, toPositional,
  sampleValues, extractProtectedTokens, compareProtectedTokens, fieldSetsMatch, sanitizeValue, MissingMergeFieldError,
} = require('../../shared/localization/mergeFields');
const { LRM } = require('../../shared/localization/arabicText');

const LOYALTY_AR = 'أهلًا {name}، رصيدك الحالي {points} نقطة. استبدلها قبل {date} واستمتع بمكافأتك.';

describe('extractFields', () => {
  test('ordered and de-duplicated; occurrences keep repeats', () => {
    expect(extractFields('hi {name}, {points} pts, bye {name}')).toEqual(['name', 'points']);
    expect(extractOccurrences('hi {name}, {points} pts, bye {name}')).toEqual(['name', 'points', 'name']);
  });
  test('works inside Arabic text', () => {
    expect(extractFields(LOYALTY_AR)).toEqual(['name', 'points', 'date']);
  });
  test('ignores non-matching braces', () => {
    expect(extractFields('{ } {1} {a b} {name')).toEqual([]);
  });
});

describe('findInvalidPlaceholders', () => {
  test('flags Meta positional syntax and unbalanced braces', () => {
    expect(findInvalidPlaceholders('hi {{1}}')).toContain('meta_positional_syntax');
    expect(findInvalidPlaceholders('hi {name')).toContain('unbalanced_braces');
    expect(findInvalidPlaceholders('hi name}')).toContain('unbalanced_braces');
    expect(findInvalidPlaceholders('hi {name} and {points}')).toEqual([]);
  });
});

describe('renderMessage', () => {
  test('English: plain substitution', () => {
    expect(renderMessage('Hi {name}, you have {points} points', { name: 'Sara', points: 120 }, { language: 'en' }))
      .toBe('Hi Sara, you have 120 points');
  });

  test('Arabic: Latin names and numbers are wrapped in LRM, Arabic values are not', () => {
    const out = renderMessage(LOYALTY_AR, { name: 'Sara', points: 120, date: '30 Nov' }, { language: 'ar' });
    expect(out).toContain(`${LRM}Sara${LRM}`);
    expect(out).toContain(`${LRM}120${LRM}`);
    expect(out).toContain(`${LRM}30 Nov${LRM}`);
    const arName = renderMessage(LOYALTY_AR, { name: 'سارة', points: 120, date: '30 نوفمبر' }, { language: 'ar' });
    expect(arName).toContain('أهلًا سارة،');
    expect(arName).toContain('30 نوفمبر');
    expect(arName).not.toContain(`${LRM}سارة`);
  });

  test('Arabic: URLs are never wrapped (marks can break link detection)', () => {
    const out = renderMessage('رابط الدفع: {link}', { link: 'https://pay.example.com/abc' }, { language: 'ar' });
    expect(out).toBe('رابط الدفع: https://pay.example.com/abc');
  });

  test('protect:false disables direction marks', () => {
    expect(renderMessage('x {name}', { name: 'Sara' }, { language: 'ar', protect: false })).toBe('x Sara');
  });

  test('strict mode refuses to produce a message with raw {placeholders}', () => {
    expect(() => renderMessage('Hi {name} {points}', { name: 'Sara' })).toThrow(MissingMergeFieldError);
    try { renderMessage('Hi {name} {points}', { name: 'Sara' }); } catch (e) { expect(e.fields).toEqual(['points']); }
  });

  test('empty / whitespace values count as missing', () => {
    expect(renderMessageSafe('Hi {name}', { name: '   ' }).missing).toEqual(['name']);
    expect(renderMessageSafe('Hi {name}', { name: null }).missing).toEqual(['name']);
    expect(renderMessageSafe('Hi {name}', {}).missing).toEqual(['name']);
  });

  test('0 is a valid value', () => {
    expect(renderMessage('{points} pts', { points: 0 })).toBe('0 pts');
  });

  test('values are sanitised for WhatsApp (no newlines/tabs/runs of spaces)', () => {
    expect(sanitizeValue('a\n\nb\t c    d')).toBe('a b c d');
    expect(renderMessage('x {name}', { name: 'Sara\nAli' })).toBe('x Sara Ali');
  });

  test('values containing braces or $ patterns do not break substitution', () => {
    expect(renderMessage('x {name} y', { name: '$& {points}' })).toBe('x $& {points} y');
  });
});

describe('toPositional (Meta {{n}} syntax)', () => {
  test('one index per occurrence', () => {
    expect(toPositional('hi {name}, {points} pts, bye {name}')).toEqual({
      text: 'hi {{1}}, {{2}} pts, bye {{3}}', params: ['name', 'points', 'name'],
    });
  });
  test('no fields', () => {
    expect(toPositional('plain')).toEqual({ text: 'plain', params: [] });
  });
  test('sample values follow the language', () => {
    expect(sampleValues(['name', 'points'], 'en')).toEqual(['Sara', '120']);
    expect(sampleValues(['name', 'unknown_field'], 'ar')).toEqual(['سارة', 'مثال']);
  });
});

describe('protected tokens (AI translation safety)', () => {
  const source = 'Hi {name}, enjoy 20% off until 30 Nov. Pay: https://pay.example.com/x';

  test('extracts fields, urls and numbers (digits normalised)', () => {
    expect(extractProtectedTokens(source)).toEqual({
      fields: ['name'], urls: ['https://pay.example.com/x'], numbers: ['20', '30'],
    });
    expect(extractProtectedTokens('خصم ٢٠٪ حتى ٣٠ نوفمبر').numbers).toEqual(['20', '30']);
  });

  test('a faithful translation passes (even with Arabic-Indic digits)', () => {
    const ar = 'مرحبًا {name}، استمتع بخصم ٢٠٪ حتى ٣٠ نوفمبر. رابط الدفع: https://pay.example.com/x';
    expect(compareProtectedTokens(source, ar).ok).toBe(true);
  });

  test('detects a changed discount', () => {
    const r = compareProtectedTokens(source, 'مرحبًا {name}، خصم 25% حتى 30 نوفمبر https://pay.example.com/x');
    expect(r.ok).toBe(false);
    expect(r.missingNumbers).toEqual(['20']);
    expect(r.extraNumbers).toEqual(['25']);
  });

  test('detects a translated/renamed merge field', () => {
    const r = compareProtectedTokens(source, 'مرحبًا {الاسم}، خصم 20% حتى 30 نوفمبر https://pay.example.com/x');
    expect(r.ok).toBe(false);
    expect(r.missingFields).toEqual(['name']);
  });

  test('detects a dropped or altered URL', () => {
    expect(compareProtectedTokens(source, 'مرحبًا {name}، خصم 20% حتى 30 نوفمبر').missingUrls).toEqual(['https://pay.example.com/x']);
    expect(compareProtectedTokens(source, 'مرحبًا {name}، خصم 20% حتى 30 نوفمبر https://evil.example.com').ok).toBe(false);
  });

  test('detects an invented number', () => {
    const r = compareProtectedTokens('Hi {name}', 'مرحبًا {name}، لدينا 3 عروض');
    expect(r.ok).toBe(false);
    expect(r.extraNumbers).toEqual(['3']);
  });
});

describe('fieldSetsMatch', () => {
  test('same fields in different order still match', () => {
    expect(fieldSetsMatch('{name} {points}', '{points} {name}').same).toBe(true);
  });
  test('reports what differs', () => {
    expect(fieldSetsMatch('{name} {points}', '{name} {date}')).toEqual({ same: false, missingInB: ['points'], extraInB: ['date'] });
  });
});
