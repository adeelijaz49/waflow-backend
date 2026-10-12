'use strict';
// Arabic text utilities for the localisation feature — pure functions, no I/O.
// Used by consent keyword matching, language inference, Arabic search and
// message rendering. Spec reference: Arabic_Localisation_Requirements §3.4.
//
// Source hygiene: every invisible / combining / Arabic-script special
// character in this file is written as a \u{...} code-point escape (never as
// the raw character) so it stays reviewable. Regexes using them carry the `u`
// flag. tests/localization/sourceHygiene.test.js enforces this.

const LRM = '\u{200E}';
const RLM = '\u{200F}';
const LRI = '\u{2066}';
const RLI = '\u{2067}';
const FSI = '\u{2068}';
const PDI = '\u{2069}';

// Harakat/tashkeel (fathatan .. sukun, wavy hamza, superscript alef) and
// Quranic annotation signs. Letters are never touched.
const DIACRITICS_RE = /[\u{0610}-\u{061A}\u{064B}-\u{065F}\u{0670}\u{06D6}-\u{06DC}\u{06DF}-\u{06E4}\u{06E7}\u{06E8}\u{06EA}-\u{06ED}]/gu;
// Tatweel / kashida.
const TATWEEL_RE = /\u{0640}/gu;
// Soft hyphen, Arabic letter mark, zero-width + bidi controls/isolates, BOM.
const INVISIBLES_RE = /[\u{00AD}\u{061C}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/gu;
// Alef with madda / hamza above / hamza below / wasla (+ rare wavy-hamza forms) -> plain alef.
const ALEF_VARIANTS_RE = /[\u{0622}\u{0623}\u{0625}\u{0671}\u{0672}\u{0673}\u{0675}]/gu;
const PLAIN_ALEF = '\u{0627}';

// Digits: Arabic-Indic (U+0660..0669) and Extended/Persian (U+06F0..06F9).
const DIGITS_RE = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/gu;
const ARABIC_INDIC_ZERO = 0x0660;
const EXT_ARABIC_INDIC_ZERO = 0x06F0;

// Arabic comma, semicolon, question mark, percent, decimal and thousands separators.
const ARABIC_PUNCT_RE = /[\u{060C}\u{061B}\u{061F}\u{066A}-\u{066C}]/gu;
const ARABIC_PUNCT_MAP = {
  '\u{060C}': ',',
  '\u{061B}': ';',
  '\u{061F}': '?',
  '\u{066A}': '%',
  '\u{066B}': '.',
  '\u{066C}': ',',
};

function str(input) {
  return input === undefined || input === null ? '' : String(input);
}

function toWesternDigits(input) {
  return str(input).replace(DIGITS_RE, (ch) => {
    const code = ch.codePointAt(0);
    return String(code >= EXT_ARABIC_INDIC_ZERO ? code - EXT_ARABIC_INDIC_ZERO : code - ARABIC_INDIC_ZERO);
  });
}

function stripDiacritics(input) { return str(input).replace(DIACRITICS_RE, ''); }
function stripTatweel(input) { return str(input).replace(TATWEEL_RE, ''); }
function stripInvisibles(input) { return str(input).replace(INVISIBLES_RE, ''); }
function unifyAlef(input) { return str(input).replace(ALEF_VARIANTS_RE, PLAIN_ALEF); }

// The normalisation required by spec §3.4: strip tashkeel + tatweel, unify
// alef variants, convert Arabic-Indic digits to Western digits. NFKC first so
// presentation forms (lam-alef ligatures, the Allah ligature) become plain
// letters; invisible bidi/zero-width characters are dropped.
function normalizeArabic(input) {
  let s = str(input);
  if (typeof s.normalize === 'function') s = s.normalize('NFKC');
  s = stripInvisibles(s);
  s = stripDiacritics(s);
  s = stripTatweel(s);
  s = unifyAlef(s);
  s = toWesternDigits(s);
  s = s.replace(ARABIC_PUNCT_RE, (ch) => ARABIC_PUNCT_MAP[ch] || ch);
  return s;
}

// Aggressive, symmetric normalisation for comparing and searching: apply it
// to BOTH sides (the stored keyword and the inbound text) so spelling variants
// collapse together. Adds yeh/alef-maksura, teh-marbuta, hamza-on-waw/yeh and
// Farsi kaf/yeh unification, lower-cases Latin, turns punctuation/emoji/symbols
// into spaces and collapses whitespace.
function normalizeForMatch(input) {
  let s = normalizeArabic(input);
  s = s
    .replace(/[\u{0649}\u{06CC}\u{0626}]/gu, '\u{064A}') // alef maksura, Farsi yeh, hamza-on-yeh -> yeh
    .replace(/\u{0629}/gu, '\u{0647}') // teh marbuta -> heh
    .replace(/\u{0624}/gu, '\u{0648}') // hamza-on-waw -> waw
    .replace(/\u{06A9}/gu, '\u{0643}'); // Farsi kaf -> kaf
  s = s.toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function isArabicLetter(ch) {
  return /\p{L}/u.test(ch) && /\p{Script=Arabic}/u.test(ch);
}
function isLatinLetter(ch) {
  return /\p{L}/u.test(ch) && /\p{Script=Latin}/u.test(ch);
}

// { arabic, latin, other } letter counts (digits, punctuation, emoji ignored).
function countLetters(input) {
  const counts = { arabic: 0, latin: 0, other: 0 };
  for (const ch of str(input)) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Arabic}/u.test(ch)) counts.arabic += 1;
    else if (/\p{Script=Latin}/u.test(ch)) counts.latin += 1;
    else counts.other += 1;
  }
  return counts;
}

function containsArabic(input) { return countLetters(input).arabic > 0; }

// ── Direction marks ───────────────────────────────────────────────────────
// WhatsApp message text: wrap Latin/number runs that sit inside Arabic copy
// in LRM so punctuation and neighbouring Arabic text can't reorder them.
function wrapLtr(value) { return `${LRM}${str(value)}${LRM}`; }
// Web DOM text: a directional isolate is the modern, spec-recommended form.
function isolateLtr(value) { return `${LRI}${str(value)}${PDI}`; }
function isolateRtl(value) { return `${RLI}${str(value)}${PDI}`; }
function isolateAuto(value) { return `${FSI}${str(value)}${PDI}`; }

// True when a merge-field VALUE needs LTR protection inside Arabic text:
// it has Latin letters or digits and no Arabic letters of its own.
function needsLtrProtection(value) {
  const s = str(value);
  if (!s) return false;
  if (containsArabic(s)) return false;
  return /[A-Za-z0-9]/.test(s);
}

module.exports = {
  LRM, RLM, LRI, RLI, FSI, PDI,
  toWesternDigits,
  stripDiacritics,
  stripTatweel,
  stripInvisibles,
  unifyAlef,
  normalizeArabic,
  normalizeForMatch,
  isArabicLetter,
  isLatinLetter,
  countLetters,
  containsArabic,
  wrapLtr,
  isolateLtr,
  isolateRtl,
  isolateAuto,
  needsLtrProtection,
};
