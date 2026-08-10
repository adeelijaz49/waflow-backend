const { normalizePhoneForDedup } = require('../utils/phoneNormalize');
const { parsePrice } = require('../utils/currency');

describe('normalizePhoneForDedup', () => {
  const cc = '966';

  test('resolves a bare local number and its full international form to the same key', () => {
    const local = normalizePhoneForDedup('0501234567', cc);
    const intl = normalizePhoneForDedup('+966501234567', cc);
    expect(local).toBe(intl);
    expect(local).toBe('966501234567');
  });

  test('handles the 00 international dialing prefix as equivalent to +', () => {
    expect(normalizePhoneForDedup('00966501234567', cc)).toBe('966501234567');
  });

  test('strips spaces, dashes, and parentheses as cosmetic noise', () => {
    expect(normalizePhoneForDedup('+966 50-123 (4567)', cc)).toBe('966501234567');
  });

  test('a bare national number already matching the country code is left alone', () => {
    expect(normalizePhoneForDedup('966501234567', cc)).toBe('966501234567');
  });

  test('a bare national number missing both the trunk 0 and the country code gets the code prepended', () => {
    expect(normalizePhoneForDedup('501234567', cc)).toBe('966501234567');
  });

  test('returns null for empty/missing input', () => {
    expect(normalizePhoneForDedup('', cc)).toBeNull();
    expect(normalizePhoneForDedup(null, cc)).toBeNull();
    expect(normalizePhoneForDedup(undefined, cc)).toBeNull();
  });

  test('a different default country code changes the resolved key', () => {
    expect(normalizePhoneForDedup('0501234567', '971')).toBe('971501234567');
  });
});

describe('parsePrice', () => {
  test('strips a currency code prefix and thousands separators', () => {
    expect(parsePrice('SAR 1,234.50')).toBe(1234.5);
  });

  test('strips a currency symbol', () => {
    expect(parsePrice('$99')).toBe(99);
  });

  test('accepts a plain number string', () => {
    expect(parsePrice('1200')).toBe(1200);
  });

  test('accepts an actual JS number unchanged', () => {
    expect(parsePrice(45.5)).toBe(45.5);
  });

  test('returns null for empty/missing input', () => {
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
  });

  test('returns null for text with no parseable number', () => {
    expect(parsePrice('N/A')).toBeNull();
  });
});
