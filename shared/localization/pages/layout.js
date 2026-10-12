'use strict';
// HTML building blocks shared by the Arabic customer pages (payment, referral,
// Instagram link). WHY a shell of its own instead of reusing the English one:
// each of the three English page files carries a private English-only shell
// (`<html lang="en">`, no `dir`) and is out of bounds for this feature, so the
// Arabic pages get a matching but separate shell. Decisions (spec §2 / §3.5):
//   * `<html lang="ar" dir="rtl">` on every page. The whole page is right-to-left,
//     which also satisfies Stripe's rule that the Payment Element is mounted under
//     an ancestor with dir="rtl".
//   * Logical CSS only (no left/right), system fonts only (a web-font request would
//     hand the customer's IP address to a third party) and letter-spacing 0
//     (tracking breaks Arabic letter joining).
//   * Everything dynamic is escaped. Text a person wrote (names, addresses, offer
//     names) goes inside <bdi> so a Latin name inside an Arabic sentence keeps its
//     own direction; amounts are direction isolates so "150.00 ر.س" never reorders.
//   * Customer-visible wording lives in catalog/pages.json (Arabic drafts until a
//     native reader marks them reviewed, spec §8) and is looked up through text()/fill().
const catalog = require('../catalog');
const { FIELD_RE } = require('../mergeFields');

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Control characters, line/paragraph separators and bidi controls: the invisible
// characters that can reorder or break the text around them. Person-written text
// is stripped of them before it is shown or put in a WhatsApp message.
const UNSAFE_CHARS_RE = /[\u{0000}-\u{001F}\u{007F}-\u{009F}\u{061C}\u{200E}\u{200F}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;

// Single-line, trimmed, at most `max` characters (counted in code points, so an
// emoji is never cut in half).
function cleanText(value, max = 200) {
  const text = String(value === undefined || value === null ? '' : value).replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('').trimEnd() : text;
}

// ── Strings ──────────────────────────────────────────────────────────────────
function raw(key) { return catalog.t('ar', `pages.${key}`); }
function text(key) { return escapeHtml(raw(key)); }

// Catalogue text with {placeholders} replaced by ready-made HTML (htmlParams values
// MUST already be escaped, e.g. built with bdi()/ltr()/amountHtml()). The template
// itself is escaped first, so catalogue text can never inject markup.
function fill(key, htmlParams = {}) {
  return escapeHtml(raw(key)).replace(FIELD_RE, (match, name) => (
    Object.prototype.hasOwnProperty.call(htmlParams, name) ? htmlParams[name] : match
  ));
}

// ── Inline pieces ────────────────────────────────────────────────────────────
// Person-written text: own direction, never bleeds into the Arabic around it.
function bdi(value, max = 200) { return `<bdi>${escapeHtml(cleanText(value, max))}</bdi>`; }
// Latin/number text that must read left-to-right (dates, times, currency codes).
function ltr(value) { return `<bdi dir="ltr">${escapeHtml(value)}</bdi>`; }

// "1,234.50": Western digits, comma thousands separator, two decimals (glossary).
// Anything that is not a sane finite number prints as 0.00 rather than "NaN".
function formatNumber(value) {
  const n = Number(value);
  const safe = Number.isFinite(n) && Math.abs(n) < 1e12 ? n : 0;
  const fixed = Math.abs(safe).toFixed(2);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${safe < 0 && Number(fixed) > 0 ? '-' : ''}${grouped}.${fraction}`;
}

// SAR reads "150.00 ر.س" (number, space, symbol - the website's form); any other
// currency keeps its code and is an LTR isolate ("150.00 AED") so it cannot reorder
// inside the right-to-left sentence around it.
function amountHtml(value, currencyCode) {
  const code = cleanText(currencyCode, 8).toUpperCase();
  const number = formatNumber(value);
  if (code === 'SAR') return `<span class="amt" dir="rtl">${number} ${text('common.currencySAR')}</span>`;
  return `<span class="amt" dir="ltr">${number}${code ? ` ${escapeHtml(code)}` : ''}</span>`;
}

// "?k=v&k2=v2" with encoded values; empty values are skipped.
function queryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// ── Page shell ───────────────────────────────────────────────────────────────
const CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f5f7;color:#111;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,"Noto Sans Arabic",sans-serif;letter-spacing:0;line-height:1.6}
.card{width:100%;max-width:440px;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:28px;box-shadow:0 2px 12px rgba(0,0,0,.06)}
.lang{margin-block-end:12px;text-align:end;font-size:13px}
.lang a{display:inline-block;padding-block:3px;padding-inline:10px;border:1px solid #d4d4d8;border-radius:999px;color:#555;text-decoration:none}
h1{margin-block:0 4px;font-size:20px;line-height:1.4}
p{margin-block:8px 0}
.muted{color:#666;font-size:14px}
.summary{margin-block:18px}
.row{display:flex;justify-content:space-between;gap:12px;padding-block:4px;font-size:14px}
.row.total{margin-block-start:8px;padding-block-start:10px;border-block-start:1px solid #e4e4e7;font-size:16px;font-weight:700}
.addr{margin-block-start:14px}
.amt{white-space:nowrap}
.pay{width:100%;margin-block-start:18px;padding:13px;border:0;border-radius:10px;background:#15803d;color:#fff;font:inherit;font-size:16px;font-weight:600;cursor:pointer}
.pay:disabled{opacity:.6;cursor:default}
.btn{display:block;margin-block-start:20px;padding:14px;border-radius:10px;background:#15803d;color:#fff;font-size:17px;font-weight:600;text-align:center;text-decoration:none}
.exit{display:block;margin-block-start:14px;text-align:center;font-size:13px;color:#666;text-decoration:none}
.exit.first{margin-block-start:20px}
#payment-message{margin-block-start:12px;font-size:14px;color:#dc2626}
#payment-message.success{color:#15803d}
.icon{margin-block-end:8px;text-align:center;font-size:42px}
@media (prefers-color-scheme:dark){
body{background:#0d0d10;color:#eee}
.card{background:#1a1a1f;border-color:#2a2a30}
.lang a{border-color:#3a3a42;color:#bbb}
.muted,.exit{color:#a1a1aa}
.row.total{border-color:#2a2a30}
#payment-message{color:#f87171}
#payment-message.success{color:#4ade80}
input,#payment-element{color-scheme:dark}
}
`;

// body: page-specific HTML (already escaped). switchHref: where the visible
// "English" link goes - always a ?lang=en URL, which falls through to the
// untouched English page. scripts: raw <script> markup (static, no user data).
function renderPage({ title, body, switchHref, scripts = '' }) {
  return `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="card">
<nav class="lang" aria-label="${text('common.languageLabel')}"><a href="${escapeHtml(switchHref)}" hreflang="en" lang="en" dir="ltr" title="${text('common.switchToEnglishTitle')}">${text('common.switchToEnglish')}</a></nav>
${body}
</main>
${scripts}
</body>
</html>`;
}

// A heading + one muted paragraph (+ optional icon and extra markup): the shape of
// every "not found / paid / cancelled / error" page. Keys are catalogue keys
// without the "pages." prefix; the title defaults the heading's key.
function messagePage({ titleKey, headingKey, bodyKey, icon, extraHtml = '', switchHref }) {
  const body = [
    icon ? `<div class="icon" aria-hidden="true">${icon}</div>` : '',
    `<h1>${text(headingKey || titleKey)}</h1>`,
    bodyKey ? `<p class="muted">${text(bodyKey)}</p>` : '',
    extraHtml,
  ].join('');
  return renderPage({ title: raw(titleKey), body, switchHref });
}

// The referral / Instagram landing page: icon, heading, a few lines, one big button.
// introHtml / offerHtml are ready-made HTML (offerHtml may be empty).
function landingPage({ titleKey, introHtml, offerHtml = '', explainKey, continueHref, switchHref }) {
  const body = [
    '<div class="icon" aria-hidden="true">🎁</div>',
    `<h1>${text(titleKey)}</h1>`,
    introHtml ? `<p>${introHtml}</p>` : '',
    offerHtml ? `<p class="muted">${offerHtml}</p>` : '',
    `<p class="muted">${text(explainKey)}</p>`,
    `<a class="btn" href="${escapeHtml(continueHref)}" rel="nofollow">${text('common.continueToWhatsApp')}</a>`,
  ].join('');
  return renderPage({ title: raw(titleKey), body, switchHref });
}

module.exports = {
  escapeHtml, cleanText, raw, text, fill, bdi, ltr, formatNumber, amountHtml, queryString,
  CSS, renderPage, messagePage, landingPage,
};
