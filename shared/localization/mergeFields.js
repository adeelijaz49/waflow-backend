'use strict';
// Merge fields ({name}, {points}, {discount}, {date} ...) — parsing, rendering
// (including right-to-left protection for Latin/number values inside Arabic
// text), conversion to Meta's positional {{n}} syntax, and comparison of the
// "protected" parts of two texts (used to verify AI translations).
const { needsLtrProtection, wrapLtr, normalizeArabic } = require('./arabicText');

const FIELD_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

// Fields the product knows how to fill. Anything matching the {identifier}
// pattern is accepted — these provide labels and Meta example values.
const KNOWN_FIELDS = Object.freeze({
  name: { en: 'Sara', ar: 'سارة' },
  full_name: { en: 'Sara Ahmed', ar: 'سارة أحمد' },
  points: { en: '120', ar: '120' },
  discount: { en: '15', ar: '15' },
  date: { en: '30 Nov', ar: '30 نوفمبر' },
  time: { en: '4:30 PM', ar: '4:30 م' },
  service: { en: 'Facial', ar: 'جلسة عناية' },
  link: { en: 'https://waflowtech.com/p/example', ar: 'https://waflowtech.com/p/example' },
  order_id: { en: '1042', ar: '1042' },
  amount: { en: 'SAR 150', ar: '150 SAR' },
  business: { en: 'Your Store', ar: 'متجرك' },
  code: { en: 'AB12CD34', ar: 'AB12CD34' },
});

class MissingMergeFieldError extends Error {
  constructor(fields) {
    super(`Missing merge field value(s): ${fields.join(', ')}`);
    this.name = 'MissingMergeFieldError';
    this.fields = fields;
  }
}

function str(v) { return v === undefined || v === null ? '' : String(v); }

// Ordered, de-duplicated list of field names used in `text`.
function extractFields(text) {
  const seen = [];
  for (const m of str(text).matchAll(FIELD_RE)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

// Every occurrence in order (a field used twice appears twice).
function extractOccurrences(text) {
  return Array.from(str(text).matchAll(FIELD_RE), (m) => m[1]);
}

// Stray braces that are not part of a valid {field}: "{name", "name}", "{{1}}".
function findInvalidPlaceholders(text) {
  const problems = [];
  const stripped = str(text).replace(FIELD_RE, '');
  if (/\{\{\s*\d+\s*\}\}/.test(stripped)) problems.push('meta_positional_syntax');
  const withoutPositional = stripped.replace(/\{\{\s*\d+\s*\}\}/g, '');
  if (/[{}]/.test(withoutPositional)) problems.push('unbalanced_braces');
  return problems;
}

// WhatsApp template parameters cannot contain newlines/tabs or runs of 4+
// spaces; collapse all whitespace to single spaces.
function sanitizeValue(raw) {
  return str(raw).replace(/[\r\n\t\u{2028}\u{2029}]+/gu, ' ').replace(/ {2,}/g, ' ').trim();
}

function isUrl(value) { return /^https?:\/\//i.test(str(value).trim()); }

// Replace {fields} with values. For Arabic text, Latin/number values are
// wrapped in LRM so surrounding punctuation cannot reorder them (URLs are left
// alone: a mark glued to a URL can break WhatsApp's link detection).
// -> { text, missing: [fieldNames] }
function renderMessageSafe(text, values = {}, { language = 'en', protect = true } = {}) {
  const missing = [];
  const out = str(text).replace(FIELD_RE, (match, name) => {
    const raw = values ? values[name] : undefined;
    if (raw === undefined || raw === null || sanitizeValue(raw) === '') {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    const value = sanitizeValue(raw);
    if (language === 'ar' && protect && !isUrl(value) && needsLtrProtection(value)) return wrapLtr(value);
    return value;
  });
  return { text: out, missing };
}

// Strict variant: never returns a message with a raw {placeholder} in it.
function renderMessage(text, values, opts) {
  const { text: out, missing } = renderMessageSafe(text, values, opts);
  if (missing.length) throw new MissingMergeFieldError(missing);
  return out;
}

// Meta positional form. One index per OCCURRENCE so a field used twice is
// still valid; `params[i]` is the field name that fills {{i+1}}.
function toPositional(text) {
  const params = [];
  const positional = str(text).replace(FIELD_RE, (m, name) => {
    params.push(name);
    return `{{${params.length}}}`;
  });
  return { text: positional, params };
}

function sampleValue(field, language = 'en') {
  const known = KNOWN_FIELDS[field];
  if (known) return known[language === 'ar' ? 'ar' : 'en'];
  return language === 'ar' ? 'مثال' : 'Example';
}

// Meta requires example values for every body variable at creation time.
function sampleValues(params, language = 'en') {
  return params.map((p) => sampleValue(p, language));
}

// ── Protected tokens (AI translation safety) ─────────────────────────────
// Fields, URLs and numbers that an AI rewrite must keep unchanged.
function extractProtectedTokens(text) {
  const t = normalizeArabic(str(text));
  const fields = extractFields(t);
  const urls = Array.from(t.matchAll(/https?:\/\/[^\s)»\]]+/gi), (m) => m[0].replace(/[.,;:!?،؛]+$/, ''));
  const scrubbed = t.replace(FIELD_RE, ' ').replace(/https?:\/\/[^\s)»\]]+/gi, ' ');
  const numbers = Array.from(scrubbed.matchAll(/\d+(?:[.,]\d+)*/g), (m) => m[0]).map((n) => n.replace(/[.,]+$/, ''));
  return { fields, urls, numbers };
}

function multisetDiff(source, candidate) {
  const counts = new Map();
  for (const s of source) counts.set(s, (counts.get(s) || 0) + 1);
  const extra = [];
  for (const c of candidate) {
    const n = counts.get(c) || 0;
    if (n > 0) counts.set(c, n - 1); else extra.push(c);
  }
  const missing = [];
  for (const [k, n] of counts) for (let i = 0; i < n; i += 1) missing.push(k);
  return { missing, extra };
}

// Compare what must survive a rewrite. ok === true only when every field,
// URL and number from `source` is present in `candidate` and nothing numeric
// or field-like was invented.
function compareProtectedTokens(source, candidate) {
  const a = extractProtectedTokens(source);
  const b = extractProtectedTokens(candidate);
  const fields = multisetDiff(extractOccurrences(normalizeArabic(source)), extractOccurrences(normalizeArabic(candidate)));
  const urls = multisetDiff(a.urls, b.urls);
  const numbers = multisetDiff(a.numbers, b.numbers);
  const ok = !fields.missing.length && !fields.extra.length && !urls.missing.length && !urls.extra.length
    && !numbers.missing.length && !numbers.extra.length;
  return {
    ok,
    missingFields: fields.missing, extraFields: fields.extra,
    missingUrls: urls.missing, extraUrls: urls.extra,
    missingNumbers: numbers.missing, extraNumbers: numbers.extra,
  };
}

// Do two language variants use the same set of merge fields?
function fieldSetsMatch(textA, textB) {
  const a = extractFields(textA);
  const b = extractFields(textB);
  return {
    same: a.length === b.length && a.every((f) => b.includes(f)),
    missingInB: a.filter((f) => !b.includes(f)),
    extraInB: b.filter((f) => !a.includes(f)),
  };
}

module.exports = {
  FIELD_RE,
  KNOWN_FIELDS,
  MissingMergeFieldError,
  extractFields,
  extractOccurrences,
  findInvalidPlaceholders,
  sanitizeValue,
  renderMessage,
  renderMessageSafe,
  toPositional,
  sampleValue,
  sampleValues,
  extractProtectedTokens,
  compareProtectedTokens,
  fieldSetsMatch,
};
