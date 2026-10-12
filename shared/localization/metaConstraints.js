'use strict';
// Local validation of a template language variant against WhatsApp/Meta
// template rules, BEFORE anything is submitted. Limits verified against Meta's
// template-components documentation (body 1024, header 60, footer 60, quick
// reply label 25, URL 2000, 2 URL buttons) — the product spec is stricter on
// button labels (20).
//
// Button roles decide what the button does when tapped (and therefore which
// payload a send carries — see templates.js#buildSendComponents):
//   opt_in / decline  consent request answers  (payload consent_yes_/consent_no_<customerId>)
//   opt_out           marketing opt-out        (payload optout_<campaignId>)
//   flow_button       a button of a linked Automated-Flows message (msgnode_<nodeId>_<position>)
//   shop_now          the "shop / book" button of a template linked to a Promotion (payload promo_<promotionId>:
//                     opens the existing shopping journey, exactly like the English announcement's button)
//   url               a static https link (a URL button; needs no payload)
// Rules verified live against Meta: a body may not start or end with a variable (error 2388299),
// submitted text carries no direction marks, and an `ar` variant needs Arabic — all errors. A
// MARKETING template needs an opt-out button; the consent request (opt_in + decline, which Meta
// classifies as MARKETING) counts as its own opt-out.
// There is deliberately no generic "custom" quick reply: the existing webhook
// dispatches taps by payload prefix, so a reply without a known role would be a
// dead button.
const { countLetters } = require('./arabicText');
const { toPositional, extractOccurrences, findInvalidPlaceholders, FIELD_RE } = require('./mergeFields');

const LIMITS = Object.freeze({
  BODY: 1024,
  HEADER: 60,
  FOOTER: 60,
  BUTTON_LABEL: 20, // spec §3.2 / §3.4 (Meta's own limit is 25)
  BUTTON_LABEL_META: 25,
  MAX_QUICK_REPLIES: 10,
  VISIBLE_BUTTONS: 3,
  URL: 2000,
  MAX_URL_BUTTONS: 2,
});

const BUTTON_ROLES = ['opt_in', 'decline', 'opt_out', 'url', 'flow_button', 'shop_now'];
const QUICK_REPLY_ROLES = Object.freeze(BUTTON_ROLES.filter((r) => r !== 'url'));
const CONSENT_ROLES = Object.freeze(['opt_in', 'decline', 'opt_out']);
const META_LANGUAGE = Object.freeze({ en: 'en', ar: 'ar', bilingual_ar_first: 'ar', bilingual_en_first: 'en' });

const DIRECTION_MARKS_RE = /[\u{200E}\u{200F}\u{061C}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

function charLength(value) {
  return Array.from(value === undefined || value === null ? '' : String(value)).length;
}

// Quick-reply wording that lets a recipient stop marketing: an opt-out button or, on the
// consent request itself (opt-in + decline, which Meta classifies as MARKETING), the decline button.
function hasOptOutEquivalent(buttons) {
  const roles = buttons.map((b) => b && b.role);
  return roles.includes('opt_out') || (roles.includes('opt_in') && roles.includes('decline'));
}

// Meta: lowercase letters, digits and underscores; max 512 chars.
function validateTemplateName(name) {
  if (!name || typeof name !== 'string') return { ok: false, message: 'Template name is required' };
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, message: 'Template names may only contain lowercase letters, numbers and underscores' };
  return { ok: true };
}

function validateButtonLabel(text) {
  const len = charLength(text);
  if (!len || !String(text).trim()) return { ok: false, code: 'button_label_empty', length: len };
  if (len > LIMITS.BUTTON_LABEL) return { ok: false, code: 'button_label_too_long', length: len, max: LIMITS.BUTTON_LABEL };
  return { ok: true, length: len };
}

// A URL button here is STATIC: a fixed https link (no {fields}, no Meta {{1}}
// suffix variable). -> null when fine, else { code, detail? }.
function validateButtonUrl(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s) return { code: 'button_url_required' };
  const len = charLength(s);
  if (len > LIMITS.URL) return { code: 'button_url_too_long', detail: { length: len, max: LIMITS.URL } };
  if (!/^https:\/\//i.test(s)) return { code: 'button_url_not_https' };
  if (extractOccurrences(s).length || /\{\{/.test(s)) return { code: 'button_url_has_field' };
  if (/[\s{}]/.test(s)) return { code: 'button_url_invalid' };
  let parsed;
  try { parsed = new URL(s); } catch (err) { return { code: 'button_url_invalid' }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) return { code: 'button_url_invalid' };
  return null;
}

// Letters that belong to the visible wording (merge-field names and URLs are not wording).
function wordingOf(text) {
  return String(text || '').replace(FIELD_RE, ' ').replace(/https?:\/\/\S+/gi, ' ');
}

function scriptOf(text) {
  const counts = countLetters(wordingOf(text));
  if (!counts.arabic && !counts.latin) return null;
  return counts.arabic > counts.latin ? 'ar' : 'en';
}

// Bilingual bodies are two paragraphs separated by a blank line. Warn when one
// language is missing, or when the first paragraph is not the language the
// variant claims to start with (the Meta language code follows bilingualOrder).
function bilingualWarnings(body, order, warnings) {
  if (!body.trim()) return;
  const counts = countLetters(wordingOf(body));
  if (counts.arabic === 0 || counts.latin === 0) {
    warnings.push({ code: 'bilingual_needs_both_languages', field: 'body' });
    return;
  }
  const first = body.split(/\r?\n[ \t]*\r?\n/).map(scriptOf).find((s) => s);
  const expected = order === 'en_first' ? 'en' : 'ar';
  if (first && first !== expected) warnings.push({ code: 'bilingual_order_mismatch', field: 'body' });
}

// variant: { language, body, header?, footer?, bilingualOrder?, buttons?: [{ role, text, url? }] }
// opts: { category, linkedMessageNodeId, linkedPromotionId } (flow buttons only make sense on a template linked to a flow
// message, shop_now buttons only on one linked to a promotion)
// -> { ok, errors: [{ code, field, message?, detail? }], warnings: [...], positional: {text, params} }
function validateVariant(variant, { category = 'MARKETING', linkedMessageNodeId, linkedPromotionId } = {}) {
  const errors = [];
  const warnings = [];
  const v = variant || {};
  const body = typeof v.body === 'string' ? v.body : '';
  const positional = toPositional(body);

  if (!body.trim()) errors.push({ code: 'body_required', field: 'body' });

  for (const problem of findInvalidPlaceholders(body)) {
    errors.push({ code: problem === 'meta_positional_syntax' ? 'meta_positional_syntax' : 'unbalanced_braces', field: 'body' });
  }

  const bodyLen = charLength(positional.text);
  if (bodyLen > LIMITS.BODY) errors.push({ code: 'body_too_long', field: 'body', detail: { length: bodyLen, max: LIMITS.BODY } });

  if (v.header) {
    if (charLength(v.header) > LIMITS.HEADER) errors.push({ code: 'header_too_long', field: 'header', detail: { length: charLength(v.header), max: LIMITS.HEADER } });
    if (/[\r\n]/.test(v.header)) errors.push({ code: 'header_has_newline', field: 'header' });
    if (extractOccurrences(v.header).length > 1) errors.push({ code: 'header_too_many_variables', field: 'header' });
  }
  if (v.footer) {
    if (charLength(v.footer) > LIMITS.FOOTER) errors.push({ code: 'footer_too_long', field: 'footer', detail: { length: charLength(v.footer), max: LIMITS.FOOTER } });
    if (extractOccurrences(v.footer).length) errors.push({ code: 'footer_has_variable', field: 'footer' });
  }

  const buttons = Array.isArray(v.buttons) ? v.buttons : [];
  if (buttons.length > LIMITS.MAX_QUICK_REPLIES) errors.push({ code: 'too_many_buttons', field: 'buttons', detail: { count: buttons.length, max: LIMITS.MAX_QUICK_REPLIES } });
  if (buttons.length > LIMITS.VISIBLE_BUTTONS) warnings.push({ code: 'buttons_collapsed', field: 'buttons', detail: { count: buttons.length, visible: LIMITS.VISIBLE_BUTTONS } });
  const seen = new Set();
  let urlButtons = 0;
  let orderReported = false;
  buttons.forEach((b, i) => {
    const field = `buttons.${i}`;
    const label = b && b.text;
    const res = validateButtonLabel(label);
    if (!res.ok) errors.push({ code: res.code, field, detail: { length: res.length, max: res.max } });
    const key = String(label || '').trim().toLowerCase();
    if (key && seen.has(key)) errors.push({ code: 'duplicate_button_label', field });
    seen.add(key);
    const role = b && b.role;
    if (typeof role !== 'string' || !BUTTON_ROLES.includes(role)) {
      errors.push({ code: 'invalid_button_role', field });
      return;
    }
    if (role === 'url') {
      urlButtons += 1;
      const issue = validateButtonUrl(b.url);
      if (issue) errors.push({ code: issue.code, field, ...(issue.detail ? { detail: issue.detail } : {}) });
      return;
    }
    // Meta wants quick replies grouped before call-to-action (URL) buttons.
    if (urlButtons > 0 && !orderReported) {
      orderReported = true;
      errors.push({ code: 'buttons_wrong_order', field });
    }
    if (role === 'flow_button' && !linkedMessageNodeId) errors.push({ code: 'flow_button_without_message_node', field });
    if (role === 'shop_now' && !linkedPromotionId) errors.push({ code: 'shop_now_without_promotion', field });
    // Consent buttons must speak the message's language (spec §3.4).
    if (CONSENT_ROLES.includes(role) && (v.language === 'ar' || v.language === 'en')) {
      const counts = countLetters(label);
      const wrong = v.language === 'ar' ? counts.arabic === 0 && counts.latin > 0 : counts.arabic > 0 && counts.latin === 0;
      if (wrong) warnings.push({ code: 'button_wrong_language', field, detail: { role } });
    }
  });
  if (urlButtons > LIMITS.MAX_URL_BUTTONS) errors.push({ code: 'too_many_url_buttons', field: 'buttons', detail: { count: urlButtons, max: LIMITS.MAX_URL_BUTTONS } });
  if (category === 'MARKETING' && !hasOptOutEquivalent(buttons)) {
    errors.push({ code: 'marketing_requires_opt_out_button', field: 'buttons' });
  }
  // The app only ever adds direction marks to what it DISPLAYS; submitted text carries none.
  for (const [field, text] of [['header', v.header], ['body', body], ['footer', v.footer]]) {
    if (typeof text === 'string' && DIRECTION_MARKS_RE.test(text)) errors.push({ code: 'direction_marks_in_text', field });
  }
  buttons.forEach((b, i) => {
    if (b && typeof b.text === 'string' && DIRECTION_MARKS_RE.test(b.text)) errors.push({ code: 'direction_marks_in_text', field: `buttons.${i}` });
  });

  // Meta rejects a body that starts or ends with a variable (error 2388299, verified live).
  const trimmed = body.trim();
  if (/^\{[A-Za-z][A-Za-z0-9_]*\}/.test(trimmed)) errors.push({ code: 'body_starts_with_variable', field: 'body' });
  if (/\{[A-Za-z][A-Za-z0-9_]*\}$/.test(trimmed)) errors.push({ code: 'body_ends_with_variable', field: 'body' });
  // Heuristics for rules Meta enforces at review time (not in the public docs).
  if (/\}\s*\{/.test(trimmed)) warnings.push({ code: 'adjacent_variables', field: 'body' });
  const occurrences = positional.params.length;
  if (occurrences > 0 && bodyLen < occurrences * 12) warnings.push({ code: 'too_many_variables_for_length', field: 'body', detail: { variables: occurrences, length: bodyLen } });
  // A bilingual body says the same thing twice, so it legitimately repeats {name} once per language.
  const fieldLists = v.language === 'bilingual' ? body.split(/\r?\n[ \t]*\r?\n/).map(extractOccurrences) : [positional.params];
  if (fieldLists.some((list) => new Set(list).size !== list.length)) warnings.push({ code: 'repeated_field', field: 'body' });

  // Script sanity: an Arabic variant should contain Arabic, an English one shouldn't be Arabic.
  const counts = countLetters(body);
  if (v.language === 'ar' && body.trim() && counts.arabic === 0) errors.push({ code: 'arabic_variant_has_no_arabic', field: 'body' });
  if (v.language === 'en' && counts.arabic > counts.latin) warnings.push({ code: 'english_variant_is_mostly_arabic', field: 'body' });
  if (v.language === 'bilingual') bilingualWarnings(body, v.bilingualOrder, warnings);
  if (/[٠-٩۰-۹]/.test(body)) warnings.push({ code: 'arabic_indic_digits_in_body', field: 'body' });

  return { ok: errors.length === 0, errors, warnings, positional };
}

module.exports = {
  LIMITS, BUTTON_ROLES, QUICK_REPLY_ROLES, CONSENT_ROLES, META_LANGUAGE,
  charLength, validateTemplateName, validateButtonLabel, validateButtonUrl, validateVariant,
};
