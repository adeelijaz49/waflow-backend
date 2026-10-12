'use strict';
// The outbound localiser (backlog C1, A6, B3; design D3 sections 4-5): ONE choke point called from BOTH waPost functions
// (server.js and utils/whatsapp.js) that gives an Arabic-speaking customer of a flagged workspace the Arabic version of the
// English shopping-journey / bot-reply messages, WITHOUT editing the ~56 call sites.
//
// WHEN IT DOES ANYTHING (every other case = the caller's ORIGINAL payload object goes out untouched, no await):
//   1. LOCALIZATION_DISABLED (kill switch) is off, and
//   2. the payload is a `text` or `interactive` message (templates never), and
//   3. there is a workspace context: the webhook / Stripe handlers call enterContext(workspaceId) right after they resolve
//      the (single) webhook workspace. Dashboard/API sends have no context and are never touched (D1/D2 own those), and
//      transport.js sends run inside withoutLocalization (new code is explicit about its language), and
//   4. that workspace is flagged (arabic_enabled) - decided SYNCHRONOUSLY from a small snapshot, so an unflagged
//      installation pays one env read + one AsyncLocalStorage lookup + one Map.has and no DB access. The snapshot is
//      STALE-WHILE-REVALIDATE (review R4-2/R1-04/R2-07): once any snapshot has been loaded a stale one is used at once and
//      refreshed in the background by the first message after it is 30 s old (no await on the send path, no timer); only the
//      very first load is awaited, bounded to 1.5 s (on timeout the original payload goes out and the load continues), and
//   5. the recipient is KNOWN to the context workspace (a Customer row there) and its language is Arabic (customer sidecar ->
//      workspace default -> English). A recipient with no Customer row in the workspace (the buyer of another merchant in the
//      Stripe webhook, a random sender) always gets English, even when the workspace default is Arabic (review R2-01), and
//   6. the whole message matches a catalogued English shape (journeyMatcher.js), and
//   7. the Arabic result passes the WhatsApp limits, has no unresolved placeholder, and (LOCALIZATION_ALLOW_DRAFT_PAGES=0)
//      only uses reviewed catalogue copy.
// It never throws and never rejects: any problem sends the original payload (fail-open). The awaited part of apply() is raced
// against a 2 s budget that resolves to the ORIGINAL body, so a slow database can never hold a customer-facing reply.
const { AsyncLocalStorage } = require('async_hooks');
const crypto = require('crypto');
const settings = require('./settings');
const catalog = require('./catalog');
const { createMatcher, entriesFromCatalog, arMoney } = require('./journeyMatcher');
const { charLength } = require('./metaConstraints');
const { resolveLanguage } = require('./languageDetect');

const als = new AsyncLocalStorage();

const FLAG_REFRESH_MS = 30 * 1000;
const FLAG_FAIL_BACKOFF_MS = 10 * 1000;
const FLAG_MAX = 1000;
const LANG_TTL_MS = 20 * 1000;
const LANG_CACHE_MAX = 5000;
const NAMES_TTL_MS = 30 * 1000;
const NAMES_MAX_ROWS = 5000;
const ID_CHUNK = 1000;
const DESCRIPTION_MAX = 150;
const UNMATCHED_LOG_MAX = 500;
const FIRST_LOAD_BUDGET_MS = 1500; // the very first flag-snapshot load may delay a reply by at most this
const APPLY_BUDGET_MS = 2000;      // the whole awaited part of apply()
const BUDGET_LOG_MS = 60 * 1000;   // the "too slow" log is rate-limited to one line per minute
const TIMED_OUT = Symbol('timedOut');

// ---- state (module-level, process-local) ----
let flagged = null;          // Map(workspaceId string -> defaultCustomerLanguage) once loaded
let flagLoad = null;         // in-flight load promise
let loadedAt = 0;
let flagFailedAt = 0;
const langCache = new Map(); // `${ws}|${phone}` -> { value, expires }
const langInflight = new Map();
const namesCache = new Map(); // ws -> { value, expires }
const namesInflight = new Map();
const unmatchedSeen = new Set();
let budgetLoggedAt = 0;
let matcher = null;
let matcherEntries = null;

const models = {
  Customer: () => require('../../models/Customer'),
  CustomerLanguage: () => require('../../models/CustomerLanguage'),
  LocaleSettings: () => require('../../models/LocaleSettings'),
  ProductTranslation: () => require('../../models/ProductTranslation'),
  Product: () => require('../../models/Product'),
  Service: () => require('../../models/Service'),
};

function log(...a) { console.error('[localization] outbound:', ...a); }
function debugOn() { return process.env.LOCALIZATION_DEBUG === '1'; }
function draftAllowed() { return process.env.LOCALIZATION_ALLOW_DRAFT_PAGES !== '0'; } // same switch as the customer pages
function namePolicyHuman() { return process.env.LOCALIZATION_NAME_POLICY === 'human'; }

// ---- workspace context ----
function wsKey(workspaceId) { return workspaceId === undefined || workspaceId === null ? '' : String(workspaceId); }

// Called by the webhook / Stripe handlers AFTER their first await (see server.js hunks S2/S3). Never throws.
// AsyncLocalStorage.enterWith switches on async-hooks bookkeeping for the whole process (measurable on Node 22), so it is
// skipped when it cannot matter (review R1-01): kill switch on, or a snapshot is loaded and this workspace is not flagged
// (a snapshot up to 30 s old is good enough; it is refreshed in the background right here). A call before any snapshot
// exists still enters, as before: the first send loads the snapshot.
function enterContext(workspaceId) {
  try {
    if (settings.killSwitchOn()) return;
    const ws = wsKey(workspaceId);
    if (!ws) return;
    if (flagged) {
      refreshInBackground();
      if (!flagged.has(ws)) return;
    }
    als.enterWith({ workspaceId: ws });
  } catch (_) { /* never throws */ }
}

// For senders that have an explicit workspace (D1/D2 may reuse the shapes): fn runs with that workspace as context.
function runWithWorkspace(workspaceId, fn) {
  return als.run({ workspaceId: wsKey(workspaceId) }, fn);
}

// new-code sends (transport.js) are explicit about their language: they must never be re-handled.
function withoutLocalization(fn) {
  const store = als.getStore();
  return als.run({ workspaceId: store ? store.workspaceId : '', bypass: true }, fn);
}

// ---- flag snapshot ----
function loadFlags(force) {
  if (flagLoad) return flagLoad;
  if (flagged && !force) return Promise.resolve(flagged);
  const p = (async () => {
    try {
      const rows = await models.LocaleSettings().find({ arabicEnabled: true }).select('workspaceId defaultCustomerLanguage').limit(FLAG_MAX + 1).lean();
      if (rows.length > FLAG_MAX) log(`more than ${FLAG_MAX} flagged workspaces: only the first ${FLAG_MAX} are localised`);
      const next = new Map();
      for (const r of rows.slice(0, FLAG_MAX)) next.set(wsKey(r.workspaceId), r.defaultCustomerLanguage === 'ar' ? 'ar' : 'en');
      flagged = next; flagFailedAt = 0; loadedAt = Date.now();
      return flagged;
    } catch (err) {
      flagFailedAt = Date.now();
      log('flag snapshot load failed (English is sent):', err && err.message);
      throw err;
    }
  })();
  flagLoad = p;
  // cleared AFTER the assignment above (an error thrown before the first await would otherwise leave a settled promise in place)
  const clear = () => { if (flagLoad === p) flagLoad = null; };
  p.then(clear, clear);
  return p;
}

// Settings changed (setArabicEnabled): make this process see it at once; other instances lag <= 30 s.
// A process that never saw a webhook has nothing loaded yet: its first use loads fresh, so there is nothing to refresh.
function refreshFlags() { return flagged ? loadFlags(true).catch(() => null) : Promise.resolve(null); }

// No background timer (an idle process does no work): the snapshot is refreshed by the first message after it is older than 30 s.
// A failed refresh keeps the previous snapshot (a database hiccup never switches Arabic off) and backs off for 10 s.
const snapshotStale = () => !flagged || Date.now() - loadedAt > FLAG_REFRESH_MS;
const inBackoff = () => !!flagFailedAt && Date.now() - flagFailedAt < FLAG_FAIL_BACKOFF_MS;
// At most one "too slow" line per minute (it names no customer data).
function logSlow(what) {
  const now = Date.now();
  if (now - budgetLoggedAt < BUDGET_LOG_MS) return;
  budgetLoggedAt = now;
  log(`${what} (the message is sent in English)`);
}

// Races a promise against a timer. -> the promise's value, or TIMED_OUT. The timer never keeps the process alive.
function raceBudget(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); if (timer.unref) timer.unref(); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Stale-while-revalidate: refresh a stale snapshot WITHOUT awaiting it (loadFlags shares one in-flight promise and logs its own errors).
function refreshInBackground() {
  if (flagged && snapshotStale() && !inBackoff()) loadFlags(true).catch(() => null);
}

// -> the snapshot, or null when none is loaded. A loaded snapshot (stale or not) is returned at once; only the very first load is
// awaited, for at most FIRST_LOAD_BUDGET_MS (the load itself continues in the background after a timeout).
async function ensureFlags() {
  if (flagged) { refreshInBackground(); return flagged; }
  if (inBackoff()) return null;
  const outcome = await raceBudget(loadFlags(true).catch(() => null), FIRST_LOAD_BUDGET_MS);
  if (outcome === TIMED_OUT) {
    // Back off like a failed load (V-FIX-X): while the first load hangs, the next messages must not each wait the full budget again
    // (one wait per FLAG_FAIL_BACKOFF_MS). The load itself continues; its success clears the marker.
    if (!flagged) flagFailedAt = Date.now();
    logSlow('flag snapshot first load took more than ' + FIRST_LOAD_BUDGET_MS + ' ms'); return null;
  }
  return flagged;
}

// ---- the synchronous gate ----
// true = apply() should be consulted. false = send the original payload with no await and no I/O.
function mayApply(body) {
  try {
    if (settings.killSwitchOn()) return false;
    if (!body || (body.type !== 'text' && body.type !== 'interactive')) return false;
    const store = als.getStore();
    if (!store || store.bypass || !store.workspaceId) return false;
    if (flagged) { refreshInBackground(); return flagged.has(store.workspaceId); } // stale-while-revalidate: decided from the snapshot we have
    return !inBackoff(); // nothing loaded yet: apply() awaits the first load (bounded), unless the last attempt just failed
  } catch (_) { return false; }
}

// ---- language ----
function langKey(workspaceId, phone) { return `${wsKey(workspaceId)}|${String(phone)}`; }

function cacheLanguage(workspaceId, phone, value) {
  if (langCache.size >= LANG_CACHE_MAX) langCache.clear();
  langCache.set(langKey(workspaceId, phone), { value, expires: Date.now() + LANG_TTL_MS });
}

// inboundHook.inferLanguage calls this right after it stores a language, so the customer's very next reply is in it.
function noteLanguage(workspaceId, phone, language) {
  try {
    if (language !== 'ar' && language !== 'en') return;
    if (!wsKey(workspaceId) || !phone) return;
    cacheLanguage(workspaceId, phone, language);
  } catch (_) { /* never throws */ }
}

// The workspace default applies ONLY to a recipient that is a customer of THIS workspace (R2-01): the Stripe webhook runs in the
// context of the (oldest) webhook workspace but also confirms payments of other merchants' buyers, and any number may message
// the platform number. Same lookup as the existing STOP/START handlers (workspace-scoped, exact phone); the negative result is cached too.
async function lookupLanguage(workspaceId, phone, defaultLanguage) {
  const customer = await models.Customer().findOne({ workspaceId, phone }).select('_id').lean();
  if (!customer) return 'en';
  const rec = await models.CustomerLanguage().findOne({ workspaceId, customerId: customer._id }).select('language').lean();
  return resolveLanguage(rec ? rec.language : null, defaultLanguage);
}

// 'ar' | 'en'. Order: customer -> workspace default (known customers only) -> en (spec section 2). Cached 20 s per (workspace, phone), including the negative result; concurrent callers share one lookup.
async function languageOf({ workspaceId, phone, defaultLanguage }) {
  const key = langKey(workspaceId, phone);
  const hit = langCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  if (langInflight.has(key)) return langInflight.get(key);
  const p = (async () => {
    try {
      let def = defaultLanguage;
      if (def === undefined) def = flagged && flagged.get(wsKey(workspaceId));
      if (def === undefined) def = (await settings.getSettings(workspaceId)).defaultCustomerLanguage;
      const value = await lookupLanguage(workspaceId, phone, def);
      cacheLanguage(workspaceId, phone, value);
      return value;
    } finally { langInflight.delete(key); }
  })();
  langInflight.set(key, p);
  return p;
}

// ---- product / service names (B3) ----
const cutCodePoints = (s, n) => (charLength(s) <= n ? s : Array.from(s).slice(0, n).join(''));

const NO_NAMES = Object.freeze({
  name: (kind, raw) => raw,
  byId: () => null,
  description: (kind, name, englishDescription) => englishDescription,
});

function splitVariant(raw) {
  const m = /^(.*?) \(([^()]+)\)$/.exec(raw);
  return m ? { base: m[1], suffix: m[2] } : null;
}

function makeNames(byKindName, byId) {
  const find = (kind, name) => { const e = byKindName.get(`${kind}|${name}`); return e && !e.ambiguous ? e : null; };
  return {
    // Arabic name when exactly one reviewed translation exists for that English name; a variant suffix "(M · Blue)" is kept as-is.
    name(kind, raw) {
      const whole = find(kind, raw); if (whole && whole.ar) return whole.ar;
      const v = splitVariant(raw);
      if (v) { const base = find(kind, v.base); if (base && base.ar) return `${base.ar} (${v.suffix})`; }
      return raw;
    },
    byId(kind, id) { const e = byId.get(`${kind}|${id}`); return e || null; },
    description(kind, name, englishDescription) {
      const e = find(kind, name);
      return e && e.description ? cutCodePoints(e.description, DESCRIPTION_MAX) : englishDescription;
    },
  };
}

async function loadNames(workspaceId) {
  const human = namePolicyHuman();
  const rows = await models.ProductTranslation().find({ workspaceId, language: 'ar' }).select('kind refId name description status source').limit(NAMES_MAX_ROWS + 1).lean();
  if (rows.length > NAMES_MAX_ROWS) { log(`workspace ${wsKey(workspaceId)} has more than ${NAMES_MAX_ROWS} Arabic names: names stay English`); return NO_NAMES; }
  const usable = rows.filter((r) => r && typeof r.name === 'string' && r.name.trim()
    && (r.status === 'reviewed' || (human && (r.source === 'merchant' || r.source === 'csv'))));
  if (!usable.length) return NO_NAMES;
  const english = new Map(); // `${kind}|${id}` -> English name
  for (const [kind, getModel] of [['product', models.Product], ['service', models.Service]]) {
    const ids = usable.filter((r) => r.kind === kind).map((r) => r.refId);
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const items = await getModel().find({ workspaceId, _id: { $in: ids.slice(i, i + ID_CHUNK) } }).select('name').lean();
      for (const it of items) if (typeof it.name === 'string' && it.name) english.set(`${kind}|${String(it._id)}`, it.name);
    }
  }
  const byKindName = new Map(); const byId = new Map();
  for (const r of usable) {
    const en = english.get(`${r.kind}|${String(r.refId)}`); if (!en) continue;
    const ar = r.name.trim();
    byId.set(`${r.kind}|${String(r.refId)}`, ar);
    const k = `${r.kind}|${en}`; const prev = byKindName.get(k);
    // two items sharing one English name with different Arabic: the English name is ambiguous, so it is not translated by name
    if (prev && (prev.ar !== ar)) byKindName.set(k, { ambiguous: true });
    else if (!prev) byKindName.set(k, { ar, description: typeof r.description === 'string' ? r.description.trim() : '' });
  }
  return makeNames(byKindName, byId);
}

function namesFor(workspaceId) {
  const key = wsKey(workspaceId);
  const hit = namesCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (namesInflight.has(key)) return namesInflight.get(key);
  const p = (async () => {
    try {
      const value = await loadNames(workspaceId);
      namesCache.set(key, { value, expires: Date.now() + NAMES_TTL_MS });
      return value;
    } catch (err) {
      log('names load failed (names stay English):', err && err.message);
      return NO_NAMES;
    } finally { namesInflight.delete(key); }
  })();
  namesInflight.set(key, p);
  return p;
}

// ---- matcher + validation ----
function getMatcher() {
  if (!matcher) {
    matcherEntries = entriesFromCatalog(catalog);
    matcher = createMatcher(matcherEntries);
  }
  return matcher;
}

function payUrl(u) { return /\/pay\/pi_[A-Za-z0-9_]+$/.test(u) ? `${u}?lang=ar` : u; }

const BAD_OUTPUT_RE = /\{[A-Za-z][A-Za-z0-9]*\}|\bundefined\b|\bNaN\b/;
function outputIsSane(original, localized) {
  const o = JSON.stringify(original); const l = JSON.stringify(localized);
  return !BAD_OUTPUT_RE.test(l) || BAD_OUTPUT_RE.test(o);
}

// A short stable fingerprint of an unmatched message (review R1-05/R2-05): a hash of the message TYPE and its shape (first 40
// characters with every digit masked) plus the length. The message text itself - which may carry a customer name, an address or an
// order - is never written to the log.
function fingerprintOf(body) {
  const text = body.type === 'text' ? (body.text && body.text.body) : (body.interactive && body.interactive.body && body.interactive.body.text);
  if (typeof text !== 'string') return { id: 'none', length: 0 };
  const shape = Array.from(text.replace(/\p{Nd}/gu, '#')).slice(0, 40).join('');
  const id = crypto.createHash('sha256').update(`${body.type}|${shape}`).digest('hex').slice(0, 10);
  return { id, length: charLength(text) };
}

const lastFour = (to) => `...${String(to === undefined || to === null ? '' : to).slice(-4)}`;

function logUnmatched(body) {
  const { id, length } = fingerprintOf(body);
  // LOCALIZATION_DEBUG=1 only: the payload (it can hold customer text) with the recipient masked to its last 4 digits.
  if (debugOn()) { console.error(`[localization] outbound: sent in English (no Arabic shape): shape=${id} len=${length}`, JSON.stringify({ ...body, to: lastFour(body.to) }).slice(0, 400)); return; }
  if (unmatchedSeen.has(id)) return;
  if (unmatchedSeen.size >= UNMATCHED_LOG_MAX) unmatchedSeen.clear();
  unmatchedSeen.add(id);
  console.warn(`[localization] outbound: sent in English (no Arabic shape): shape=${id} len=${length}`);
}

// -> the Arabic payload, or the ORIGINAL body object. Never rejects and never holds the reply longer than APPLY_BUDGET_MS.
async function apply(body) {
  try {
    if (!mayApply(body)) return body;
    const store = als.getStore(); // read before the first await: the context belongs to this call chain
    const out = await raceBudget(applyChecked(body, store), APPLY_BUDGET_MS);
    if (out === TIMED_OUT) { logSlow('localisation lookup took more than ' + APPLY_BUDGET_MS + ' ms'); return body; }
    return out;
  } catch (err) {
    log('apply failed (English is sent):', err && err.message);
    return body;
  }
}

// The awaited part of apply(); never rejects (an abandoned run after a timeout just warms the caches).
async function applyChecked(body, store) {
  try {
    await ensureFlags();
    if (!flagged) return body;
    const def = flagged.get(store.workspaceId);
    if (def === undefined) return body;
    if (typeof body.to !== 'string' || !body.to) return body;
    const lang = await languageOf({ workspaceId: store.workspaceId, phone: body.to, defaultLanguage: def });
    if (lang !== 'ar') return body;
    const names = await namesFor(store.workspaceId);
    const res = getMatcher().localize(body, { names, payUrl });
    if (!res) { logUnmatched(body); return body; }
    if (!draftAllowed() && !res.keys.every((k) => { const e = matcherEntries.get(k); return e && e.status === 'reviewed'; })) return body;
    if (!outputIsSane(body, res.payload)) { log(`unresolved placeholder in ${res.shape}: sent in English`); return body; }
    if (debugOn()) console.error(`[localization] outbound: ${res.shape} -> Arabic for ...${String(body.to).slice(-4)}`);
    return res.payload;
  } catch (err) {
    log('apply failed (English is sent):', err && err.message);
    return body;
  }
}

// Inbox "Send payment link" (hunk I1): the Arabic text for an Arabic-speaking customer of a flagged workspace, else null.
// This is a dashboard send with an explicit workspace, so it does not use the webhook context.
async function paymentLinkBody({ workspaceId, phone, amount, url }) {
  try {
    if (settings.killSwitchOn() || !wsKey(workspaceId) || !phone || !amount || !url) return null;
    const out = await raceBudget(paymentLinkChecked({ workspaceId, phone, amount, url }), APPLY_BUDGET_MS);
    if (out === TIMED_OUT) { logSlow('payment-link localisation lookup took more than ' + APPLY_BUDGET_MS + ' ms'); return null; }
    return out;
  } catch (err) {
    log('paymentLinkBody failed (English is sent):', err && err.message);
    return null;
  }
}

async function paymentLinkChecked({ workspaceId, phone, amount, url }) {
  await ensureFlags();
  const def = flagged && flagged.get(wsKey(workspaceId));
  if (def === undefined || def === null) return null;
  const lang = await languageOf({ workspaceId, phone, defaultLanguage: def });
  if (lang !== 'ar') return null;
  const entry = catalog.load().get('inbox.paymentLink');
  if (!entry || !entry.ar) return null;
  if (!draftAllowed() && entry.status !== 'reviewed') return null;
  return catalog.t('ar', 'inbox.paymentLink', { amount: arMoney(String(amount)), link: payUrl(String(url)) });
}

function _resetForTests() {
  flagged = null; flagLoad = null; flagFailedAt = 0; loadedAt = 0; budgetLoggedAt = 0;
  langCache.clear(); langInflight.clear(); namesCache.clear(); namesInflight.clear(); unmatchedSeen.clear();
  matcher = null; matcherEntries = null;
}

module.exports = {
  mayApply, apply, enterContext, runWithWorkspace, withoutLocalization, languageOf, noteLanguage, paymentLinkBody, refreshFlags, _resetForTests,
};
