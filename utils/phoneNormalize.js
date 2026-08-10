// CSV-import dedup phone matching ONLY. Deliberately separate from the
// login-flow normalizePhone() in routes/auth.js / routes/workspaces.js —
// those are invite/OTP-lookup critical, already working, and must not
// change behavior. This one additionally resolves country-code equivalence
// (0501234567 vs +966501234567), which the login flow never needed since a
// merchant always types their own number the same way when logging in.
//
// Known limitation, accepted for v1: a bare number with no '+', no '00'
// prefix, and no leading '0' is ambiguous (could already be a full
// international number, or a local number just missing its trunk zero).
// Resolved heuristically by checking whether it already starts with the
// workspace's own country code; otherwise the country code is prepended.
function normalizePhoneForDedup(rawPhone, defaultCountryCode) {
  if (!rawPhone) return null;
  const hasPlus = String(rawPhone).trim().startsWith('+');
  const digits = String(rawPhone).replace(/\D/g, ''); // strips '+', spaces, dashes, parens
  if (!digits) return null;

  const cc = String(defaultCountryCode || '').replace(/\D/g, '');

  if (hasPlus) return digits;                              // already E.164 — cc + national number, as typed
  if (digits.startsWith('00')) return digits.slice(2);      // '00' intl prefix ≡ '+' — same remainder
  if (digits.startsWith('0')) return cc + digits.replace(/^0+/, ''); // bare local: drop trunk 0, prepend cc
  if (cc && digits.startsWith(cc)) return digits;           // already has cc, no leading 0/+/00
  return cc + digits;                                       // bare national number missing its trunk 0
}

module.exports = { normalizePhoneForDedup };
