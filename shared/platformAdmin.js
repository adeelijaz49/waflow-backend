'use strict';
// Who is a WaFlow super admin (platform staff). Identity is an env allowlist of VERIFIED LOGIN CONTACTS:
//
//   SUPER_ADMIN_CONTACTS="someone@example.com, +61 400 000 000"
//
// A contact is only ever trusted after it passed an OTP / magic-link login (nothing in the app can edit User.phone /
// User.email), so it cannot be self-granted. Empty or unset = nobody is a super admin (every /api/platform route answers
// 403). A person who logs in by phone AND by email is two Users: list both contacts. Nothing personal lives in code.
//
// The allowlist is re-read from process.env on every call and memoised on the raw string, so an App Setting change takes
// effect on restart and a test can change the env between calls.
const { toWesternDigits } = require('./localization/arabicText');

function normalizePhone(phone) {
  return toWesternDigits(String(phone || '')).replace(/\D/g, ''); // Arabic-Indic digits accepted; same as routes/auth.js always did
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Same simple shape check the login screen implies: one @, something on both sides, a dot in the domain, no spaces.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MIN_PHONE_DIGITS = 8;
const MAX_PHONE_DIGITS = 15; // E.164

/**
 * Validate + normalise a login contact typed by staff. A typo would create an account nobody can sign in to, so this is strict.
 * @param {'phone'|'email'} type
 * @param {*} raw
 * @returns {{type:'phone'|'email', contact:string}|null} null when it is not a plausible contact
 */
function normalizeContact(type, raw) {
  if (type === 'email') {
    const email = normalizeEmail(raw);
    if (email.length > 254 || !EMAIL_RE.test(email)) return null;
    return { type: 'email', contact: email };
  }
  if (type === 'phone') {
    const text = String(raw == null ? '' : raw);
    if (/[a-z@]/i.test(text)) return null; // letters in a phone number are a typo, not something to silently drop
    const phone = normalizePhone(text);
    if (phone.length < MIN_PHONE_DIGITS || phone.length > MAX_PHONE_DIGITS) return null;
    return { type: 'phone', contact: phone };
  }
  return null;
}

let memoRaw = null;
let memoParsed = { phones: new Set(), emails: new Set() };

// A value pasted into a hosting dashboard (or a shell) often keeps its quotes: "a@b.co", 'a@b.co', typographic quotes. They are not
// part of the contact - left in, nobody would ever match the allowlist and the Platform area would stay closed without a word.
const QUOTES = /^[\s"'`\u{201C}\u{201D}\u{2018}\u{2019}]+|[\s"'`\u{201C}\u{201D}\u{2018}\u{2019}]+$/gu;
// Characters nobody can see that pasting from a web page, a chat or a PDF often brings along (zero-width spaces, left-to-right and
// right-to-left marks and embeddings, the word joiner, the byte-order mark). An email that looks right but carries one matches nobody.
const INVISIBLE = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}\u{FEFF}]/gu;

/**
 * @param {string} [env] raw SUPER_ADMIN_CONTACTS (defaults to the process env)
 * @returns {{phones:Set<string>, emails:Set<string>}} normalised contacts (memoised on the raw string)
 */
function parseSuperAdminContacts(env = process.env.SUPER_ADMIN_CONTACTS) {
  const raw = env === undefined || env === null ? '' : String(env);
  if (raw === memoRaw) return memoParsed;
  const phones = new Set();
  const emails = new Set();
  const doubtful = [];
  // Comma / semicolon / newline separated. NOT whitespace: phone numbers are often typed with spaces.
  for (const part of raw.split(/[,;\r\n]+/)) {
    const item = part.replace(INVISIBLE, '').replace(QUOTES, '');
    if (!item) continue;
    if (item.includes('@')) {
      const email = normalizeEmail(item);
      if (email) emails.add(email);
      if (!normalizeContact('email', email)) doubtful.push(item);
    } else {
      const phone = normalizePhone(item);
      if (phone) phones.add(phone);
      if (!normalizeContact('phone', item)) doubtful.push(item);
    }
  }
  memoRaw = raw;
  memoParsed = { phones, emails };
  if (doubtful.length) { // said once per value (masked: a log line must not hold a contact)
    console.warn(`[platform] SUPER_ADMIN_CONTACTS: ${doubtful.length} of its entries do not look like an email address or a phone number (${doubtful.map(maskContact).join(', ')}) - check the setting.`);
  }
  return memoParsed;
}

/** True when at least one super admin contact is configured. */
function isConfigured() {
  const { phones, emails } = parseSuperAdminContacts();
  return phones.size + emails.size > 0;
}

/** @param {{phone?:string, email?:string}} contact */
function isSuperAdminContact({ phone, email } = {}) {
  const { phones, emails } = parseSuperAdminContacts();
  if (phones.size + emails.size === 0) return false;
  const p = normalizePhone(phone);
  if (p && phones.has(p)) return true;
  const e = normalizeEmail(email);
  if (e && emails.has(e)) return true;
  return false;
}

/** @param {{phone?:string, email?:string}|null} user a User document (or lean object) */
function isSuperAdminUser(user) {
  if (!user) return false;
  return isSuperAdminContact({ phone: user.phone, email: user.email });
}

/** a***@d***.com for an email, ******1234 for a phone number, '' for nothing. Never returns the full contact. */
function maskContact(contact) {
  const text = String(contact == null ? '' : contact).trim();
  if (!text) return '';
  if (text.includes('@')) {
    const at = text.lastIndexOf('@');
    const local = text.slice(0, at);
    const domain = text.slice(at + 1);
    const dot = domain.lastIndexOf('.');
    const host = dot > 0 ? domain.slice(0, dot) : domain;
    const tld = dot > 0 ? domain.slice(dot) : '';
    return `${Array.from(local)[0] || ''}***@${Array.from(host)[0] || ''}***${tld}`;
  }
  const digits = normalizePhone(text);
  if (digits.length <= 4) return '****';
  return `******${digits.slice(-4)}`;
}

/** Masked label for a User (their phone, else their email). */
function maskUser(user) {
  if (!user) return '';
  return maskContact(user.phone || user.email || '');
}

/**
 * ALLOW_SELF_SERVE_SIGNUP: unset or on/true/1/yes keeps login = signup (the default); off/false/0/no closes it. A value that is not
 * understood ("flase", "disabled") counts as OFF and is reported at start-up (utils/envFlag.js): the switch exists to close sign-up, so a
 * typo in it must not leave sign-up open.
 */
function selfServeSignupAllowed() {
  return require('../utils/envFlag').isOn('ALLOW_SELF_SERVE_SIGNUP', true, process.env, false);
}

module.exports = {
  normalizePhone, normalizeEmail, normalizeContact,
  parseSuperAdminContacts, isConfigured, isSuperAdminContact, isSuperAdminUser,
  maskContact, maskUser, selfServeSignupAllowed,
};
