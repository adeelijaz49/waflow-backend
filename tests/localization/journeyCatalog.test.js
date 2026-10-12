// The journey.* catalogue (shared/localization/catalog/journey.json): structure, Arabic copy rules and WhatsApp limits per key group.
const fs = require('fs');
const path = require('path');
const catalog = require('../../shared/localization/catalog');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'localization', 'catalog', 'journey.json'), 'utf8'));
const keys = Object.keys(raw);
const cp = (s) => Array.from(s).length;
const fill = (s, v = '99') => s.replace(/\{[A-Za-z0-9]+\}/g, v);
const names = (s) => [...s.matchAll(/\{([A-Za-z0-9]+)\}/g)].map((m) => m[1]).filter((n) => n !== 's').sort();

test('the catalogue loader exposes every journey.* key', () => {
  expect(keys.length).toBeGreaterThanOrEqual(80);
  for (const k of keys) expect(catalog.has(`journey.${k}`)).toBe(true);
});

describe.each(keys)('journey.%s', (k) => {
  const e = raw[k];
  test('has English and Arabic text, draft status, and the same placeholders in both', () => {
    expect(typeof e.en).toBe('string');
    expect(typeof e.ar).toBe('string');
    expect(e.en.length).toBeGreaterThan(0);
    expect(e.ar.length).toBeGreaterThan(0);
    expect(e.status).toBe('draft');
    expect(names(e.ar)).toEqual(names(e.en));
  });
  test('Arabic copy rules: no Latin WhatsApp, no Arabic-Indic digits, no Latin SAR, no hidden characters', () => {
    expect(/whatsapp/i.test(e.ar)).toBe(false);
    expect(/[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u.test(e.ar)).toBe(false);
    expect(/\bSAR\b/.test(e.ar)).toBe(false);
    expect(/[\p{Cf}\u{00A0}\u{FEFF}]/u.test(e.ar)).toBe(false);
  });
});

describe('WhatsApp limits per key group (placeholders filled with a 2-digit value)', () => {
  const group = (re) => keys.filter((k) => re.test(k));
  test('button labels <= 20 code points (Arabic)', () => { for (const k of group(/^btn\./)) expect([k, cp(fill(raw[k].ar)) <= 20]).toEqual([k, true]); });
  test('list section titles <= 24, headers/footers <= 60', () => {
    for (const k of group(/^(catalog\.section|variant\.section|slots\.section)/)) expect([k, cp(fill(raw[k].ar)) <= 24]).toEqual([k, true]);
    for (const k of group(/(^|\.)(header|footer)/i)) expect([k, cp(fill(raw[k].ar, 'Summer Sale')) <= 60]).toEqual([k, true]);
  });
  test('variant "no preference" row <= 24 / 72', () => {
    expect(cp(raw['variant.noPreference'].ar)).toBeLessThanOrEqual(24);
    expect(cp(raw['variant.noPreferenceDesc'].ar)).toBeLessThanOrEqual(72);
  });
  test('row descriptions <= 72', () => { for (const k of group(/^(catalog\.row|variant\.row|slots\.rowLeft)/)) expect([k, cp(fill(raw[k].ar, '150.00 ر.س')) <= 72]).toEqual([k, true]); });
  test('the button-body texts <= 1024 even with long values', () => { for (const k of group(/^(added|goodChoice|payLater|more|card)\./)) expect([k, cp(fill(raw[k].ar, 'x'.repeat(40))) <= 1024]).toEqual([k, true]); });
});

test('the existing consent keys the journey reuses are English-identical to the server literals', () => {
  expect(catalog.t('en', 'consent.optOutAck')).toBe("You've been unsubscribed from promotional messages. Reply START to opt back in anytime.");
  expect(catalog.t('en', 'consent.startAck')).toBe("You're subscribed to promotional messages again. Welcome back! 🎉");
  expect(catalog.t('en', 'consent.askSuffix')).toBe('Would you like occasional offers & updates from us on WhatsApp?');
});
