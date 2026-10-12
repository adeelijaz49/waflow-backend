'use strict';
// ONE direction-mark rule for every Arabic SESSION message (the shopping-journey localiser journeyMatcher.js, the booking /
// order / referral notices utilitySend.js and the branching follow-ups followUpSender.js).
//
// A filled merge-field value that has Latin letters or digits and no Arabic letters is isolated with LRM so the punctuation
// and the Arabic words around it cannot reorder it. Exception (the rule, review R3-04): NO mark is inserted when the
// character immediately BEFORE or AFTER the filled value is `*` or `_` (WhatsApp's bold / italic delimiters): a mark between
// the delimiter and the text could stop WhatsApp from formatting it. The journey matcher additionally renders a NESTED
// placeholder (a slot, a label) without any mark of its own when that placeholder sits next to such a delimiter, so the
// output of a nested placeholder is never wrapped inside bold.
//
// LOCALIZATION_WRAP_SESSION_LRM=0 switches session direction marks off entirely (a kill switch for the unprobed risk).
const { needsLtrProtection, wrapLtr } = require('./arabicText');

const FIELD_RE = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const FORMAT_DELIMITER_RE = /[*_]/;

function marksEnabled() { return process.env.LOCALIZATION_WRAP_SESSION_LRM !== '0'; }

// Is a mark allowed around the `length` characters at `offset` of `whole`?
function markAllowed(whole, offset, length) {
  if (!marksEnabled()) return false;
  const text = String(whole);
  return !(FORMAT_DELIMITER_RE.test(text[offset - 1] || '') || FORMAT_DELIMITER_RE.test(text[offset + length] || ''));
}

// Both neighbours of the placeholder (the same test, used to decide how a nested placeholder is rendered).
function insideFormatting(whole, offset, length) {
  const text = String(whole);
  return FORMAT_DELIMITER_RE.test(text[offset - 1] || '') || FORMAT_DELIMITER_RE.test(text[offset + length] || '');
}

// The value, isolated with LRM when the rule says so (`isolate` = the caller's own "is this value the kind that needs it").
function protectValue(value, whole, offset, length, isolate = needsLtrProtection) {
  return isolate(value) && markAllowed(whole, offset, length) ? wrapLtr(value) : value;
}

// {field} -> value for a session text. resolve(name) -> { value: string, isolate?: boolean } | null (null = missing).
// `isolate` (default true) says whether the value is a candidate for a mark at all (URLs and multi-line values are not).
// -> { text, missing: [names] }
function fillFields(raw, resolve) {
  const missing = [];
  const text = String(raw).replace(FIELD_RE, (match, name, offset, whole) => {
    const given = resolve(name);
    if (!given) { if (!missing.includes(name)) missing.push(name); return match; }
    return given.isolate === false ? given.value : protectValue(given.value, whole, offset, match.length);
  });
  return { text, missing };
}

module.exports = { markAllowed, insideFormatting, protectValue, fillFields, marksEnabled };
