'use strict';
// H1 (backlog H1; design D3 section 6; approved GLOBAL change #2): a STOP / opt-out opts out EVERY customer record of the
// same workspace that has the same normalised phone number.
//
// WHY. Customer.phone is not unique and the existing STOP / "optout_" handlers do Customer.findOne({ phone: from }) and
// opt out only the FIRST match. A number stored twice (e.g. "966501234567" next to "+966 50 123 4567" or "0501234567",
// typical after CSV imports) therefore kept receiving marketing after a STOP - a compliance gap. campaignPlanner already
// SKIPS such sends (opted_out_phone); this closes the gap at the source so the English senders are protected too.
//
// BLAST RADIUS (all merchants - this change is global): triggered only by STOP/UNSUBSCRIBE, the "optout_" quick-reply
// and the Arabic/marked-STOP equivalents of the localisation inbound hook. It changes behaviour ONLY when another
// customer record of the SAME workspace with the same normalised number is not yet opted out. It never touches other
// workspaces, never re-opts-in anybody (START still reinstates only the record the customer's own phone string resolves
// to), and never changes a reply. Demo records are included (an opt-out is the restrictive direction).
// Cost per event (review R4-1/R1-03/R2-04: the webhook is unauthenticated, so a forged STOP must stay cheap):
//   1. ALWAYS first one workspace-scoped query for the EXACT stored spellings of the number (international digits, +digits,
//      00digits, and the national forms 0xxxxxxxxx / xxxxxxxxx using the workspace country code): these siblings are opted out at once;
//   2. then, ONLY as a bounded fallback for odd spellings (spaces, dashes, Arabic digits, direction marks), a lean read of the
//      workspace's customers: MAX_SCAN = 20,000 rows (a larger workspace skips the scan and logs once per workspace per hour), and
//      at most one scan per (workspace, normalised phone) per 60 s (in-memory, bounded), so repeated STOPs do not repeat it;
//   3. one hydrate/write per sibling.
//
// Every sibling is written through shared/consent.js#withdrawMarketingConsent, so each one logs its own ConsentEvent
// BEFORE the record is mutated (the existing audit rule). A failure is retried once and never blocks the reply.
const { normalizeRecipientPhone } = require('./audience');
const { toWesternDigits, stripInvisibles } = require('./arabicText');
const { normalizePhoneForDedup } = require('../../utils/phoneNormalize');

const DEFAULT_COUNTRY_CODE = '966';
const MAX_SCAN = 20000;
const SCAN_COOLDOWN_MS = 60 * 1000;
const TOO_LARGE_LOG_MS = 60 * 60 * 1000;
const STATE_MAX = 5000;
const RETRY_DELAY_MS = 250;
const HYDRATE_CHUNK = 500;
const SOURCE_SUFFIX = ' (same number, other customer record)';

function realDeps() {
  return {
    Customer: require('../../models/Customer'),
    Settings: require('../../models/Settings'),
    consent: require('../consent'),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (...a) => console.error(...a),
  };
}

// All the digit strings a stored/typed phone can stand for (see utils/phoneNormalize + audience.normalizeRecipientPhone).
// Without a country code (cc falsy) only the unambiguous international spelling is used: a local number is never guessed.
function phoneKeys(raw, cc) {
  const keys = new Set();
  if (raw === undefined || raw === null) return keys;
  const a = normalizeRecipientPhone(raw); if (a) keys.add(a);
  if (!cc) return keys;
  const text = stripInvisibles(toWesternDigits(String(raw))).trim();
  const b = text ? normalizePhoneForDedup(text, cc) : null;
  if (b && /^[1-9]\d{7,14}$/.test(b)) keys.add(b);
  return keys;
}

function sameNumber(a, b, cc) {
  const ka = phoneKeys(a, cc);
  for (const k of phoneKeys(b, cc)) if (ka.has(k)) return true;
  return false;
}

async function countryCodeOf(deps, workspaceId) {
  try {
    const s = await deps.Settings.findOne({ workspaceId }).select('defaultCountryCode').lean();
    const cc = String((s && s.defaultCountryCode) || '').replace(/\D/g, '');
    return cc || DEFAULT_COUNTRY_CODE;
  } catch (_) { return DEFAULT_COUNTRY_CODE; }
}

// Erased records carry "deleted-<id>" phones and are excluded.
const baseFilter = (workspaceId) => ({ workspaceId, deletedAt: { $exists: false } });
const nowOf = (deps) => (typeof deps.now === 'function' ? deps.now() : Date.now());

// The exact stored spellings a number can have (see the header): international digits, +, 00, and the national forms.
function spellingVariants(from, keys, cc) {
  const out = new Set([String(from)]);
  for (const k of keys) {
    out.add(k); out.add(`+${k}`); out.add(`00${k}`);
    if (cc && k.startsWith(cc) && k.length > cc.length) { const national = k.slice(cc.length); out.add(national); out.add(`0${national}`); }
  }
  return [...out];
}

// ---- in-memory throttles (process-local, bounded) ----
const scanCooldown = new Map(); // `${workspace}|${normalised phone}` -> expiry ms
const tooLargeUntil = new Map(); // workspace -> expiry ms (also the "log once per hour" marker)

function remember(map, key, expires, now) {
  if (map.size >= STATE_MAX) {
    for (const [k, v] of map) if (v <= now) map.delete(k);
    if (map.size >= STATE_MAX) map.delete(map.keys().next().value); // still full: drop the oldest entry
  }
  map.set(key, expires);
}

// The cheap query: workspace-scoped, phone $in the exact spellings.
async function variantRows(deps, workspaceId, from, keys, cc) {
  return deps.Customer.find({ ...baseFilter(workspaceId), phone: { $in: spellingVariants(from, keys, cc) } }).select('phone optedOut').lean();
}

// The bounded fallback scan. -> rows, or null when it is skipped (cooling down / workspace too large).
async function scanRows(deps, workspaceId, keys) {
  const now = nowOf(deps);
  const ws = String(workspaceId);
  const big = tooLargeUntil.get(ws);
  if (big && big > now) return null;
  const cooldownKey = `${ws}|${[...keys].sort().join(',')}`;
  const until = scanCooldown.get(cooldownKey);
  if (until && until > now) return null;
  remember(scanCooldown, cooldownKey, now + SCAN_COOLDOWN_MS, now);
  const maxScan = deps.maxScan || MAX_SCAN;
  const rows = await deps.Customer.find(baseFilter(workspaceId)).select('phone optedOut').limit(maxScan + 1).lean();
  if (rows.length <= maxScan) return rows;
  remember(tooLargeUntil, ws, now + TOO_LARGE_LOG_MS, now);
  deps.log(`[consent] same-number opt-out: workspace ${ws} has more than ${maxScan} customers - the full scan is skipped (only the exact stored spellings of the number are checked); logged once per hour`);
  return null;
}

async function withdrawOne(deps, { customer, method, source, workspaceId }) {
  const args = { customer, method, source, workspaceId };
  try {
    await deps.consent.withdrawMarketingConsent(args);
    return true;
  } catch (err) {
    if (err && err.name === 'ValidationError') {
      // A legacy record missing a required name field cannot save(): the ConsentEvent is already logged, so apply the flag directly.
      await deps.Customer.updateOne({ _id: customer._id, workspaceId }, { $set: { optedOut: true, optedOutAt: new Date() } });
      return true;
    }
    deps.log('[consent] same-number opt-out write failed, retrying once:', err && err.message);
    await deps.sleep(RETRY_DELAY_MS);
    await deps.consent.withdrawMarketingConsent(args);
    return true;
  }
}

// -> { matched, optedOut, failed }. NEVER throws.
async function optOutSamePhone({ workspaceId, from, exceptCustomerId, method, source } = {}, rawDeps) {
  const result = { matched: 0, optedOut: 0, failed: 0 };
  let deps;
  try {
    deps = rawDeps || realDeps();
    if (!workspaceId || from === undefined || from === null || from === '') return result;
    const cc = await countryCodeOf(deps, workspaceId);
    const keys = phoneKeys(from, cc);
    if (!keys.size) return result;

    const except = exceptCustomerId === undefined || exceptCustomerId === null ? null : String(exceptCustomerId);
    const tagged = `${source || 'WhatsApp opt-out'}${SOURCE_SUFFIX}`;
    const done = new Set(); // sibling ids already handled by an earlier phase
    const siblingsOf = (rows) => rows
      .filter((r) => r && String(r._id) !== except && !done.has(String(r._id)) && r.optedOut !== true && sameNumber(from, r.phone, cc))
      .map((r) => r._id);
    const optOutAll = async (ids) => {
      ids.forEach((id) => done.add(String(id)));
      result.matched += ids.length;
      for (let i = 0; i < ids.length; i += HYDRATE_CHUNK) {
        const docs = await deps.Customer.find({ _id: { $in: ids.slice(i, i + HYDRATE_CHUNK) }, workspaceId });
        for (const customer of docs) {
          try {
            await withdrawOne(deps, { customer, method, source: tagged, workspaceId });
            result.optedOut += 1;
          } catch (err) {
            result.failed += 1;
            deps.log(`[consent] SAME-NUMBER OPT-OUT FAILED for customer ${customer && customer._id} - the number may still receive marketing on that record:`, err && err.message);
          }
        }
      }
    };

    // Phase 1 (cheap, always): the exact stored spellings. Opted out before anything slower can fail.
    const cheap = siblingsOf(await variantRows(deps, workspaceId, from, keys, cc));
    if (cheap.length) await optOutAll(cheap);

    // Phase 2 (bounded fallback): odd spellings found by a capped scan, throttled per (workspace, number).
    try {
      const rows = await scanRows(deps, workspaceId, keys);
      if (rows) {
        const rest = siblingsOf(rows);
        if (rest.length) await optOutAll(rest);
      }
    } catch (err) {
      deps.log('[consent] same-number opt-out: fallback scan failed (exact spellings were already handled):', err && err.message);
    }
    return result;
  } catch (err) {
    try { (deps ? deps.log : console.error)('[consent] same-number opt-out failed (the reply still goes out):', err && err.message); } catch (_) { /* never throws */ }
    return result;
  }
}

function _resetForTests() { scanCooldown.clear(); tooLargeUntil.clear(); }

module.exports = { optOutSamePhone, phoneKeys, sameNumber, countryCodeOf, spellingVariants, MAX_SCAN, SCAN_COOLDOWN_MS, _resetForTests };
