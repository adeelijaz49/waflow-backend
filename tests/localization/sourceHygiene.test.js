// Guards the localisation sources against INVISIBLE characters (zero-width,
// bidi controls, line/paragraph separators, BOM). Source files must write them
// as \u{...} escapes so they stay reviewable. Visible Arabic text (including
// its own combining marks such as the tanween in "مرحبًا") is allowed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['shared/localization', 'routes/localization', 'models', 'tests/localization', 'scripts'];
// Only localisation-owned files in shared directories.
const OWNED_PREFIXES = ['Locale', 'Localiz', 'CustomerLanguage', 'ProductTranslation', 'UserLocale', 'Arabic'];

function listFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listFiles(rel)); continue; }
    if (!/\.(js|json|md)$/.test(entry.name)) continue;
    const shared = dir === 'models' || dir === 'scripts';
    if (shared && !OWNED_PREFIXES.some((p) => entry.name.startsWith(p)) && !/i18n|locali[sz]/i.test(entry.name)) continue;
    out.push(rel);
  }
  return out;
}

const INVISIBLE = /[\p{Cf}\u{2028}\u{2029}\u{00A0}\u{FEFF}]/u;
const files = DIRS.flatMap(listFiles);

test('there are localisation source files to check', () => {
  expect(files.length).toBeGreaterThan(5);
});

describe.each(files)('%s', (rel) => {
  test('contains no invisible/format characters', () => {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const hits = [];
    text.split('\n').forEach((line, i) => {
      for (const ch of line) {
        if (INVISIBLE.test(ch)) hits.push(`line ${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
      }
    });
    expect(hits).toEqual([]);
  });
});
