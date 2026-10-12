'use strict';
// Normalises what the merchant types into AI Mode (spec §6: Modern Standard
// Arabic, Saudi/Gulf dialect, mixed Arabic/English, Arabic-Indic digits).
//
// DECISION (brief B7a §3): the user's text is stored and the model's text is
// derived from it, and they are NOT the same string.
//   * `display` is what goes into the chat history (AiChatSession) and back to
//     the page: exactly what the merchant typed, minus characters that must
//     never be stored or replayed (invisible/bidi controls, tag characters,
//     C0/C1 controls, lone surrogates), with tidy whitespace. Digits stay as
//     typed, so the page shows the merchant their own words.
//   * `text` is what the model reads: the same words with Arabic-Indic/Persian/
//     fullwidth digits turned into 0-9 (plus the Arabic decimal, thousands and
//     percent signs when they are part of a number) and all whitespace
//     collapsed. Nothing else is touched: diacritics, tatweel, alef/yeh
//     spellings and dialect words are the model's input as written, because
//     rewriting them would only destroy information the model can use. (Search
//     matching is a different concern and normalises harder - see tools.js.)
//
// Invisible characters are dangerous here for two reasons: bidi controls can
// make a chat bubble render differently from what was sent, and Unicode "tag"
// characters can carry text a human cannot see (a known way to smuggle
// instructions to a model). Both are removed before anything else happens.
//
// All regexes use \u{...} code-point escapes with the u flag so this source
// file contains no invisible characters (tests/localization/sourceHygiene.test.js).
const { toWesternDigits, stripInvisibles } = require('../arabicText');
const { detectLanguage } = require('../languageDetect');

const MAX_MESSAGE_LENGTH = 2000;
// Bounds the regex work for callers that skipped their own length validation.
const RAW_SCAN_LIMIT = MAX_MESSAGE_LENGTH * 4;

// C0 controls except TAB/LF/VT/FF/CR (those are whitespace and handled below), DEL, C1 controls.
const CONTROL_RE = /[\u{0000}-\u{0008}\u{000E}-\u{001F}\u{007F}-\u{009F}]/gu;
// Unicode tag characters (E0000-E007F) and variation selectors supplement.
const TAG_RE = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const LINE_SEPARATOR_RE = /[\u{2028}\u{2029}]/gu;
// NBSP, Ogham space, en/em/thin/hair spaces, narrow NBSP, medium math space, ideographic space.
const EXOTIC_SPACE_RE = /[\u{00A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}]/gu;
const FULLWIDTH_DIGIT_RE = /[\u{FF10}-\u{FF19}]/gu;
const ARABIC_DECIMAL_RE = /(\d)\u{066B}(?=\d)/gu;
const ARABIC_THOUSANDS_RE = /(\d)\u{066C}(?=\d)/gu;
const ARABIC_PERCENT_RE = /(\d)[ ]?\u{066A}/gu;

function toStringSafe(input) {
  if (typeof input === 'string') return input;
  return input === undefined || input === null ? '' : String(input);
}

// Strip everything that must never reach storage or the model, and make
// whitespace characters ordinary. Newlines are kept (as LF).
function sanitize(input) {
  let s = toStringSafe(input);
  if (s.length > RAW_SCAN_LIMIT) s = s.slice(0, RAW_SCAN_LIMIT);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed(); // lone surrogates -> U+FFFD
  s = s.replace(/\r\n?/g, '\n');
  s = stripInvisibles(s);
  s = s.replace(TAG_RE, '').replace(CONTROL_RE, '');
  s = s.replace(LINE_SEPARATOR_RE, '\n').replace(EXOTIC_SPACE_RE, ' ');
  return s;
}

// Cap by code points so an emoji (two UTF-16 units) is never cut in half.
function capCodePoints(s, max) {
  if (s.length <= max) return s;
  const points = Array.from(s);
  return points.length <= max ? s : points.slice(0, max).join('');
}

// Chat-history form: collapse runs of spaces, trim each line, at most one blank line in a row.
function tidyDisplay(s) {
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t\v\f]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Model form: digits -> 0-9, number punctuation, all whitespace collapsed.
function forModel(display) {
  let s = toWesternDigits(display);
  s = s.replace(FULLWIDTH_DIGIT_RE, (ch) => String(ch.codePointAt(0) - 0xFF10));
  s = s.replace(ARABIC_DECIMAL_RE, '$1.').replace(ARABIC_THOUSANDS_RE, '$1,').replace(ARABIC_PERCENT_RE, '$1%');
  return s.replace(/\s+/g, ' ').trim();
}

const ARABIC_LETTER_RE = /[\u{0621}-\u{064A}\u{0671}-\u{06D3}]/u;
const LATIN_LETTER_RE = /[A-Za-z]/;

// Letter share alone calls "أبغى أرسل reminder" a tie (8 vs 8 letters) although
// the sentence is plainly Arabic with one English noun - the usual shape of a
// Saudi merchant's message. When the letter share is inconclusive the language
// of the majority of WORDS decides; an exact word tie stays 'unknown'.
function majorityByWords(text) {
  let arabic = 0;
  let latin = 0;
  for (const word of text.split(/\s+/)) {
    if (ARABIC_LETTER_RE.test(word)) arabic += 1;
    else if (LATIN_LETTER_RE.test(word)) latin += 1;
  }
  if (arabic === latin) return 'unknown';
  return arabic > latin ? 'ar' : 'en';
}

// -> { text, display, language: 'ar'|'en'|'unknown', confidence }
function normalizeUserMessage(input) {
  const display = tidyDisplay(capCodePoints(sanitize(input), MAX_MESSAGE_LENGTH));
  const text = forModel(display);
  const detected = detectLanguage(text);
  const mixed = detected.language === 'unknown' && detected.counts.arabic + detected.counts.latin >= 2;
  const language = mixed ? majorityByWords(text) : detected.language;
  return { text, display, language, confidence: detected.confidence };
}

module.exports = { MAX_MESSAGE_LENGTH, sanitize, capCodePoints, tidyDisplay, forModel, normalizeUserMessage };
