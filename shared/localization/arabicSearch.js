'use strict';
// Arabic-aware customer search: user term -> MongoDB filter. Spec §5 (search must
// normalise diacritics, alef variants and Arabic-Indic digits, phone numbers
// included), CONTRACT §2 "Customers".
//
// Why a new builder: the existing search (shared/operations.js listCustomers,
// shared/inbox.js listConversations) hands the user's text to $regex UNESCAPED —
// a "(" or a "+966..." is an invalid pattern there (HTTP 500) and ".*" matches
// everything — and compares Arabic letters literally, so "احمد" never finds
// "أحمد" and Arabic-Indic digits never find a stored Western-digit phone.
//
// How it works:
//  * The term is normalised (NFKC, invisible/bidi marks, tashkeel, tatweel, alef
//    variants, Arabic-Indic/Persian digits -> Western), capped (100 characters,
//    6 tokens) and split on whitespace. EVERY token must match firstname OR
//    lastname OR (phone-like tokens only) phone, so "سارة أحمد" finds a customer
//    whose first name is سارة and last name أحمد (any order), and "Sara Ahmed"
//    works across both name fields. An entirely numeric term such as
//    "+966 50 123 4567" is one phone number, not four tokens.
//  * Nothing the user typed is ever pattern syntax: each character becomes an
//    escaped literal or a character class built here (alef/yeh/teh-marbuta/waw/
//    kaf families, Western + Arabic-Indic + Persian digit classes). Arabic
//    letters may be followed by tashkeel/tatweel in the STORED text. A pattern
//    is a flat sequence of classes and "[marks]*" — no alternation, no groups —
//    so it cannot backtrack catastrophically.
//  * Phone-like tokens drop spaces/dashes/parentheses/"+", a leading "00" or one
//    leading "0", and the workspace's country code, then match as a digit
//    substring that tolerates separators in the stored value ("0501234567",
//    "+966 50 123 4567" and "966501234567" are all found by any of them).
//  * Patterns contain the Arabic characters themselves (PCRE in MongoDB does not
//    understand \uXXXX). They are built from code points at load time so this
//    file stays free of raw combining/invisible characters (see
//    tests/localization/sourceHygiene.test.js).
const { normalizeArabic, isArabicLetter } = require('./arabicText');

const MAX_TERM_LENGTH = 100;
const MAX_TOKENS = 6;
const MAX_RAW_LENGTH = 1000; // bounds the NFKC work for callers that skip their own validation

const cp = (...codes) => codes.map((c) => String.fromCodePoint(c)).join('');
const span = (from, to) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`;

// Letters Arabic spelling and keyboards use interchangeably. Each family is
// searched as a class, so a query typed with one member finds stored text
// written with any other (mirrors arabicText.normalizeForMatch).
const LETTER_FAMILIES = [
  cp(0x0627, 0x0622, 0x0623, 0x0625, 0x0671, 0x0672, 0x0673, 0x0675), // alef, madda, hamza above/below, wasla, ...
  cp(0x064A, 0x0649, 0x06CC, 0x0626), // yeh, alef maksura, Farsi yeh, hamza-on-yeh
  cp(0x0647, 0x0629, 0x06C1, 0x06BE), // heh, teh marbuta, Urdu heh forms
  cp(0x0648, 0x0624), // waw, hamza-on-waw
  cp(0x0643, 0x06A9), // kaf, Farsi kaf
];
const FAMILY_CLASS = new Map();
for (const members of LETTER_FAMILIES) {
  const cls = `[${members}]`;
  for (const ch of members) FAMILY_CLASS.set(ch, cls);
}

// Tashkeel + Quranic marks + superscript alef (same ranges as arabicText) and
// tatweel: allowed after any Arabic letter of the stored text.
const MARKS = `[${span(0x0610, 0x061A)}${span(0x064B, 0x065F)}${cp(0x0670)}${span(0x06D6, 0x06DC)}${span(0x06DF, 0x06E4)}${cp(0x06E7, 0x06E8)}${span(0x06EA, 0x06ED)}${cp(0x0640)}]*`;

// Separators a stored phone may contain: space, NBSP, narrow NBSP, LRM, RLM,
// parentheses, dot, hyphen.
const PHONE_SEPARATORS = `[ ${cp(0x00A0, 0x202F, 0x200E, 0x200F)}().\\-]*`;

const CONTROL_RE = /[\u{0000}-\u{001F}\u{007F}-\u{009F}]/gu;
const PHONE_TOKEN_RE = /^\+?[0-9().-]*[0-9][0-9().-]*$/;
const PHONE_TERM_RE = /^\+?[0-9\s().-]*[0-9][0-9\s().-]*$/;
const NO_LETTER_OR_DIGIT_START_RE = /^[^\p{L}\p{N}]+/u;
const NO_LETTER_OR_DIGIT_END_RE = /[^\p{L}\p{N}]+$/u;

function invalidInput(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'INVALID_INPUT';
  return err;
}

// Western digit -> class that also matches the Arabic-Indic and Persian digit.
function digitClass(digit) {
  const n = Number(digit);
  return `[${digit}${String.fromCodePoint(0x0660 + n)}${String.fromCodePoint(0x06F0 + n)}]`;
}

// Escape ASCII regex syntax only; every other character is literal in a pattern.
function escapeRegex(ch) {
  return /[\\^$.*+?()[\]{}|]/.test(ch) ? `\\${ch}` : ch;
}

// Pattern for one name token (letters, digits, anything else literal).
function namePattern(token) {
  let out = '';
  for (const ch of token) {
    if (ch >= '0' && ch <= '9') out += digitClass(ch);
    else if (FAMILY_CLASS.has(ch)) out += FAMILY_CLASS.get(ch) + MARKS;
    else if (isArabicLetter(ch)) out += escapeRegex(ch) + MARKS;
    else out += escapeRegex(ch);
  }
  return out;
}

// Digits only, tolerating separators between them in the stored value.
function phonePattern(digits) {
  return Array.from(digits, digitClass).join(PHONE_SEPARATORS);
}

// "+966 50 123 4567" / "00966501234567" / "0501234567" -> "501234567": the
// number as it appears in every stored format (the country code and trunk zero
// are what differ). `raw` is already Western-digit normalised.
function nationalDigits(raw, countryCode) {
  const hasPlus = raw.startsWith('+');
  let digits = raw.replace(/\D/g, '');
  if (!hasPlus) {
    if (digits.startsWith('00') && digits.length > 2) digits = digits.slice(2);
    else if (digits.startsWith('0') && digits.length > 1) digits = digits.slice(1);
  }
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (cc && digits.startsWith(cc) && digits.length - cc.length >= 6) {
    digits = digits.slice(cc.length);
    if (digits.startsWith('0') && digits.length > 1) digits = digits.slice(1); // "+966 0501..." (trunk zero typed after the code)
  }
  return digits;
}

function sanitize(term) {
  if (term === undefined || term === null) return '';
  if (typeof term !== 'string') throw invalidInput('search must be a string');
  let s = term.slice(0, MAX_RAW_LENGTH);
  if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
  s = normalizeArabic(s).replace(CONTROL_RE, ' ');
  return s.slice(0, MAX_TERM_LENGTH);
}

// -> [{ text, phone }] where `phone` is the digit string to match on the phone
// field (null for tokens that are not phone-like).
function tokenize(term, { countryCode } = {}) {
  const cleaned = sanitize(term).trim();
  if (!cleaned) return [];
  const phoneOnly = (raw) => ({ text: raw.replace(/\s+/g, ''), phone: nationalDigits(raw.replace(/\s+/g, ''), countryCode) });
  if (PHONE_TERM_RE.test(cleaned)) {
    const whole = phoneOnly(cleaned);
    return whole.phone ? [whole] : [];
  }
  const seen = new Set();
  const tokens = [];
  const punctuation = []; // pieces with no letter or digit at all (" - ", "(", ".*")
  for (const raw of cleaned.split(/\s+/u)) {
    if (tokens.length >= MAX_TOKENS) break;
    const text = raw.replace(NO_LETTER_OR_DIGIT_START_RE, '').replace(NO_LETTER_OR_DIGIT_END_RE, '');
    if (!text) {
      if (punctuation.length < MAX_TOKENS) punctuation.push({ text: raw, phone: null });
      continue;
    }
    const phone = PHONE_TOKEN_RE.test(raw) ? nationalDigits(raw, countryCode) : null;
    const key = `${text.toLowerCase()}|${phone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ text, phone: phone || null });
  }
  // A separator between words ("Sara - Ahmed") must not make the search fail,
  // but a term made ONLY of punctuation is searched literally, never as syntax.
  return tokens.length ? tokens : punctuation;
}

function regexClause(field, pattern) {
  return { [field]: { $regex: pattern, $options: 'i' } };
}

// -> { filter, normalizedTokens }. `filter` is {} for an empty term (no
// restriction) or { $and: [...] } — merge it into a query next to the tenant
// filter; it never touches workspaceId. Throws 400 INVALID_INPUT for non-strings.
// options.countryCode: the workspace's default calling code ("966") so a number
// typed with it also finds customers stored in local format.
function buildSearchFilter(term, options = {}) {
  const tokens = tokenize(term, options);
  if (!tokens.length) return { filter: {}, normalizedTokens: [] };
  const clauses = tokens.map((token) => {
    const namePat = namePattern(token.text);
    const or = [regexClause('firstname', namePat), regexClause('lastname', namePat)];
    if (token.phone) or.push({ phone: { $regex: phonePattern(token.phone) } });
    return { $or: or };
  });
  return {
    filter: { $and: clauses },
    normalizedTokens: tokens.map((t) => (t.phone || t.text.toLowerCase())),
  };
}

module.exports = {
  MAX_TERM_LENGTH,
  MAX_TOKENS,
  buildSearchFilter,
  tokenize,
  namePattern,
  phonePattern,
  nationalDigits,
  escapeRegex,
};
