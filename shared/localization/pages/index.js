'use strict';
// Entry of the Arabic customer pages (payment, referral, Instagram link): decides
// whether a request is answered by this feature AT ALL and, if so, in which
// language. The existing English handlers (routes/pay.js, referralRedirect.js,
// instagramRedirect.js) are never edited; this runs in front of them and steps
// aside (the router calls next()) unless every condition below holds.
//
// Order of the checks - cheapest and side-effect-free first, so English traffic
// pays for as little as possible (spec §3.5, CONTRACT "Customer pages"):
//   1. LOCALIZATION_DISABLED kill switch                       -> English
//   2. ?lang=en (explicit)                                      -> English
//   3. database not connected                                   -> English (fail open, no waiting)
//   4. LOCALIZATION_ALLOW_DRAFT_PAGES=0 and the copy is draft   -> English
//   5. no merchant anywhere has Arabic enabled (cached 30 s)    -> English
//   6. find the page's workspace (a read-only lookup, see the page module)
//   7. that workspace's arabic_enabled flag                     -> English when off
//   8. ?lang=ar | stored customer language | Arabic content language (an Instagram
//      post's caption) | Accept-Language | English
// "Stored customer language" is the visitor's own CustomerLanguage record; for a
// referral link the visitor is not a customer yet, so the REFERRER's language is
// only a last-resort hint, used when the browser says nothing (an explicit browser
// preference is a stronger signal about the visitor than somebody else's language).
//
// Everything here is read-only. A planner built on top of this returns a PLAN
// (fall through / a page / a click-recording commit) and never touches the
// response, so a plan that times out or throws can simply be abandoned.

const PRECHECK_TIMEOUT_MS = 3500;
const MAX_ACCEPT_LANGUAGE_CHARS = 512;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 24;
const ANY_ENABLED_TTL_MS = 30 * 1000;
const OLDEST_WORKSPACE_TTL_MS = 60 * 1000;

// ── Plans ────────────────────────────────────────────────────────────────────
function fallThrough(reason) { return { next: true, reason }; }
function page(status, html) { return { status, html }; }

// ── Request parsing ──────────────────────────────────────────────────────────
function firstString(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const hit = value.find((v) => typeof v === 'string');
    return hit === undefined ? '' : hit;
  }
  return '';
}

// ?lang=ar|en (also AR, ar-SA, ar_SA). Anything else is ignored (null). When the
// parameter is repeated, any "en" wins: English is the safe default and an
// explicit English request must always reach the untouched English page.
function parseLangParam(value) {
  const list = Array.isArray(value) ? value.slice(0, 5) : [value];
  let sawArabic = false;
  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const match = /^(ar|en)(?:[-_][a-z0-9]{2,8})?$/.exec(entry.trim().toLowerCase());
    if (!match) continue;
    if (match[1] === 'en') return 'en';
    sawArabic = true;
  }
  return sawArabic ? 'ar' : null;
}

// Accept-Language -> 'ar' | 'en' | null: the supported language with the highest
// q-value (ties go to the one listed first; q=0 means "not acceptable"). Bounded
// input: a hostile header cannot make this slow.
function parseAcceptLanguage(header) {
  if (typeof header !== 'string' || !header) return null;
  let best = null;
  const entries = header.slice(0, MAX_ACCEPT_LANGUAGE_CHARS).split(',').slice(0, MAX_ACCEPT_LANGUAGE_ENTRIES);
  for (const entry of entries) {
    const [tag, ...params] = entry.split(';');
    const match = /^\s*(ar|en)(?:-[A-Za-z0-9]{1,8})*\s*$/i.exec(tag);
    if (!match) continue;
    let q = 1;
    for (const param of params) {
      const qMatch = /^\s*q\s*=\s*(\d(?:\.\d{0,3})?)\s*$/i.exec(param);
      if (qMatch) q = Math.min(Number(qMatch[1]), 1);
    }
    if (q <= 0) continue;
    if (!best || q > best.q) best = { language: match[1].toLowerCase(), q };
  }
  return best ? best.language : null;
}

// Referral / tracking codes are random alphanumerics (10 chars today); anything
// else cannot be one of ours, so the English handler can answer it.
function isPlausibleCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

function isPlausiblePaymentIntentId(id) {
  return typeof id === 'string' && /^pi_[A-Za-z0-9_]{1,100}$/.test(id);
}

// utm-style attribution parameters passed through to the click recorder:
// single-line, at most 100 characters.
function clip(value, max = 100) {
  const chars = Array.from(String(value || '').replace(/[\u{0000}-\u{001F}\u{007F}]/gu, ' ').trim());
  return chars.length ? chars.slice(0, max).join('') : undefined;
}

function readAttribution(req) {
  const query = (req && req.query) || {};
  return { source: clip(firstString(query.src) || firstString(query.source)), medium: clip(firstString(query.medium)) };
}

// The click is recorded only when the visitor taps "continue" (?go=1). HEAD
// requests (crawlers, link checkers) are never a tap.
function isGoRequest(req) {
  return req.method === 'GET' && firstString(req.query && req.query.go) === '1';
}

// The wa.me link the existing click recorder returns, with its (English) prefilled
// text replaced. Rebuilt by hand because URLSearchParams would encode spaces as "+",
// which WhatsApp shows literally. Refuses anything that is not a plain https://wa.me
// link to a phone number (or a WhatsApp Business short link): this is a redirect
// target, so it must never become an open redirect.
function rebuildWaLink(waLink, message) {
  let url;
  try { url = new URL(String(waLink)); } catch (err) { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'wa.me' || !/^\/(\d{5,20}|(message|qr)\/[A-Za-z0-9]{3,64})$/.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}?text=${encodeURIComponent(message)}`;
}

// ── Draft-copy policy ────────────────────────────────────────────────────────
// Every Arabic string ships as `draft` until a native reader reviews it (spec §8).
// Merchants are enabled one by one by WaFlow staff who accept that, so draft copy is
// served by default; LOCALIZATION_ALLOW_DRAFT_PAGES=0 makes a page fall through to
// English unless all Arabic strings it uses are `reviewed`.
function draftPagesAllowed(env) {
  return !env || env.LOCALIZATION_ALLOW_DRAFT_PAGES !== '0';
}

function arabicCopyReviewed(catalog, groups) {
  const prefixes = groups.map((group) => `pages.${group}.`);
  const entries = catalog.listEntries().filter((entry) => entry.ar && prefixes.some((p) => entry.key.startsWith(p)));
  return entries.length > 0 && entries.every((entry) => entry.status === 'reviewed');
}

// ── Timing helpers ───────────────────────────────────────────────────────────
// Memoise an async lookup for ttlMs. Concurrent callers share one in-flight query;
// a failure is never cached.
function ttlMemo(load, { ttlMs, now = Date.now }) {
  let value;
  let expires = 0;
  let inflight = null;
  return function memoised() {
    if (expires > now()) return Promise.resolve(value);
    if (!inflight) {
      inflight = Promise.resolve().then(load).then((result) => {
        value = result;
        expires = now() + ttlMs;
        return result;
      }).finally(() => { inflight = null; });
    }
    return inflight;
  };
}

// Reject if `promise` takes longer than ms. Promise.race subscribes to both promises, so
// the one that loses can settle (or fail) later without ever becoming an unhandled
// rejection - which would kill the process on Node 22.
function withTimeout(promise, ms, label = 'operation') {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── Cheap, cached lookups shared by every page ───────────────────────────────
// anyArabicEnabled: has ANY workspace been switched on? While none has (the state
// after deploy) every page request falls through after one cached boolean, so the
// English pages pay nothing. oldestWorkspaceId: the workspace used when a request
// carries no workspace of its own (an inbox payment link, an unknown code) - the
// same "oldest workspace" fallback server.js uses for its public webhooks.
function createRolloutLookups({ LocaleSettings, Workspace, now = Date.now }) {
  return {
    anyArabicEnabled: ttlMemo(async () => !!(await LocaleSettings.exists({ arabicEnabled: true })), { ttlMs: ANY_ENABLED_TTL_MS, now }),
    oldestWorkspaceId: ttlMemo(async () => {
      const workspace = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
      return workspace ? String(workspace._id) : null;
    }, { ttlMs: OLDEST_WORKSPACE_TTL_MS, now }),
  };
}

// Lazy Stripe client: the SDK is only loaded when a request actually needs it, and
// no STRIPE_SECRET_KEY means "no Arabic payment page" (null), never a crash.
function createStripeGetter(env = process.env) {
  let client = null;
  let clientKey = null;
  return function getStripe() {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) return null;
    if (!client || clientKey !== key) {
      client = require('stripe')(key);
      clientKey = key;
    }
    return client;
  };
}

// ── The language decision ────────────────────────────────────────────────────
// loadContext() is the page-specific read-only lookup. It returns null / no
// workspaceId when the request cannot be tied to a workspace, otherwise
//   { workspaceId, getStoredLanguage?(), getHintLanguage?(), ...page data }
// Both getters are lazy and only called when the language is not already decided.
// -> { language: 'ar' | 'en', reason, ctx }. Rejects when a lookup fails: the caller
// treats that as "fall through to English".
async function decidePageLanguage({ req, deps, groups, loadContext }) {
  const english = (reason, ctx = null) => ({ language: 'en', reason, ctx });
  if (deps.settings.killSwitchOn()) return english('kill_switch');
  const explicit = parseLangParam(req.query && req.query.lang);
  if (explicit === 'en') return english('explicit_en');
  if (!deps.dbReady()) return english('db_unavailable');
  if (!draftPagesAllowed(deps.env) && !arabicCopyReviewed(deps.catalog, groups)) return english('draft_copy_blocked');
  if (!(await deps.anyArabicEnabled())) return english('not_rolled_out');

  const ctx = await loadContext();
  if (!ctx || !ctx.workspaceId) return english('no_workspace', ctx);
  if (!(await deps.settings.isArabicEnabled(ctx.workspaceId))) return english('flag_off', ctx);

  if (explicit === 'ar') return { language: 'ar', reason: 'explicit', ctx };
  const stored = ctx.getStoredLanguage ? await ctx.getStoredLanguage() : null;
  if (stored === 'ar' || stored === 'en') return { language: stored, reason: 'customer', ctx };
  // The language of the content the link points at (an Instagram post's caption) says more
  // about the visitor than their browser does: only Arabic is acted on, anything else
  // leaves the decision to Accept-Language (META-REALITY section 11).
  const content = ctx.getContentLanguage ? await ctx.getContentLanguage() : null;
  if (content === 'ar') return { language: 'ar', reason: 'content', ctx };
  const browser = parseAcceptLanguage(req.headers && req.headers['accept-language']);
  if (browser) return { language: browser, reason: 'browser', ctx };
  const hint = ctx.getHintLanguage ? await ctx.getHintLanguage() : null;
  if (hint === 'ar') return { language: 'ar', reason: 'hint', ctx };
  return english('default', ctx);
}

// ── Production wiring ────────────────────────────────────────────────────────
// Everything that touches the database, Stripe or the WhatsApp stack is created
// here, lazily (the router builds it on the first request), so requiring the
// router has no side effects and tests inject fakes instead.
function realDeps(env = process.env) {
  const models = {
    LocaleSettings: require('../../../models/LocaleSettings'),
    CustomerLanguage: require('../../../models/CustomerLanguage'),
    Customer: require('../../../models/Customer'),
    Order: require('../../../models/Order'),
    Service: require('../../../models/Service'),
    TimeSlot: require('../../../models/TimeSlot'),
    Workspace: require('../../../models/Workspace'),
    Settings: require('../../../models/Settings'),
    ReferralCode: require('../../../models/ReferralCode'),
    ReferralPromotion: require('../../../models/ReferralPromotion'),
    TrackingLink: require('../../../models/TrackingLink'),
    InstagramPost: require('../../../models/InstagramPost'),
  };
  return {
    env,
    now: () => Date.now(),
    precheckTimeoutMs: PRECHECK_TIMEOUT_MS,
    settings: require('../settings'),
    catalog: require('../catalog'),
    models,
    ...createRolloutLookups({ LocaleSettings: models.LocaleSettings, Workspace: models.Workspace }),
    dbReady: () => require('mongoose').connection.readyState === 1,
    getStripe: createStripeGetter(env),
    publishableKey: () => env.STRIPE_PUBLISHABLE_KEY || '',
    carts: require('../../../utils/state').carts,
    // The click recorders live in files that load the whole WhatsApp/Meta stack: they
    // are required at the moment of a click, never while the pages are merely mounted.
    recordReferralClick: (args) => require('../../referrals').recordClickAndGetRedirect(args),
    recordTrackingClick: (args) => require('../../instagram').recordClickAndGetRedirect(args),
  };
}

module.exports = {
  PRECHECK_TIMEOUT_MS,
  fallThrough, page,
  firstString, parseLangParam, parseAcceptLanguage, isPlausibleCode, isPlausiblePaymentIntentId,
  readAttribution, isGoRequest, rebuildWaLink,
  draftPagesAllowed, arabicCopyReviewed,
  ttlMemo, withTimeout, createRolloutLookups, createStripeGetter,
  decidePageLanguage, realDeps,
};
