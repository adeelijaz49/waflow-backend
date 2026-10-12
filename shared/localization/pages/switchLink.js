'use strict';
// The "Arabic" switch link on the EXISTING English payment pages (routes/pay.js), backlog D1,
// FLAGGED workspaces only.
//
// routes/localization/pages.js runs in front of routes/pay.js; when it decides the visitor
// gets the English page it remembers WHY in res.locals.arabicPageReason (the reasons are
// the ones shared/localization/pages/index.js decidePageLanguage returns). routes/pay.js then
// appends arabicSwitchHtml(...) to the card. For anybody who is not in a flagged workspace the
// result is '' and the English HTML is byte-identical to before.
//
//   no reason (the Arabic router did not run / failed) ............ ''
//   customer | browser | default  (English chosen AFTER the flag
//       check passed, i.e. the workspace IS flagged) ................ link
//   explicit_en  (?lang=en, decided BEFORE the flag is known: the
//       visitor came from the Arabic page's own English link) ....... one cheap lookup under a
//                                                                      1.5 s budget: link only when
//                                                                      the workspace is flagged and
//                                                                      the Arabic page would be served
//   kill_switch, not_rolled_out, flag_off, no_workspace, db_unavailable,
//   draft_copy_blocked, checkout_unavailable, anything else, any error,
//   a timeout ....................................................... ''
//
// The label is the language's own name written in Arabic (a constant, deliberately not a
// catalogue key so the review counts do not move). a.exit is already styled by pageShell.
// Heavy modules are required lazily so loading routes/pay.js stays as light as before.

const SHOW_WITHOUT_LOOKUP = new Set(['customer', 'browser', 'default']);
const LOOKUP_BUDGET_MS = 1500;
const PAY_GROUPS = ['common', 'pay']; // same groups as shared/localization/pages/pay.js GROUPS
const LABEL = 'العربية';

function escapeAttr(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function linkHtml(href) {
  return `<a class="exit" href="${escapeAttr(href)}" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">${LABEL}</a>`;
}

function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('switch link lookup timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let cachedDeps = null;
function realDeps() {
  if (!cachedDeps) cachedDeps = require('./index').realDeps();
  return cachedDeps;
}

// Is the workspace behind this PaymentIntent flagged AND would the Arabic page be served?
async function arabicPageAvailable(pi, deps) {
  const pages = require('./index');
  const pay = require('./pay');
  if (!deps.dbReady()) return false;
  if (!pages.draftPagesAllowed(deps.env) && !pages.arabicCopyReviewed(deps.catalog, PAY_GROUPS)) return false;
  if (!(await deps.anyArabicEnabled())) return false;
  const base = await pay.resolvePaymentWorkspace(deps, pi);
  if (!base || !base.workspaceId) return false;
  return !!(await deps.settings.isArabicEnabled(base.workspaceId));
}

// -> '' or the <a> element. Never throws. `deps` is for tests.
async function arabicSwitchHtml(res, options, deps) {
  try {
    const { href, pi } = options || {};
    const reason = res && res.locals && res.locals.arabicPageReason;
    if (!reason || !href) return '';
    if (SHOW_WITHOUT_LOOKUP.has(reason)) return linkHtml(href);
    if (reason === 'explicit_en') {
      const available = await withBudget(arabicPageAvailable(pi, deps || realDeps()), LOOKUP_BUDGET_MS);
      return available ? linkHtml(href) : '';
    }
    return '';
  } catch (err) {
    return '';
  }
}

module.exports = { arabicSwitchHtml, linkHtml, SHOW_WITHOUT_LOOKUP, LOOKUP_BUDGET_MS };
