// Versioned WhatsApp pricing lookups — the only place campaign-send logic
// should ever learn a per-message cost. Never hardcode a rate elsewhere.
const WhatsAppRateCard = require('../models/WhatsAppRateCard');

const MESSAGE_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'];
// ISO 3166-1 alpha-2 or the '*' wildcard — rejects anything else, including a
// Mongo query-operator object (e.g. {"$gt": ""}), before it ever reaches a
// filter. countryCode/category can arrive straight from a merchant's JSON
// request body (routes/entitlements.js's /campaigns/estimate and /reserve),
// so this is the actual security boundary, not just input hygiene.
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function assertValidCategory(category) {
  if (typeof category !== 'string' || !MESSAGE_CATEGORIES.includes(category)) {
    throw new Error(`Invalid message category "${JSON.stringify(category)}"`);
  }
}

// For a *lookup* (getRate) — empty/missing means "fall back to the wildcard
// row", anything non-empty must be a real 2-letter code.
function normalizeCountryCodeForLookup(countryCode) {
  if (countryCode === undefined || countryCode === null || countryCode === '') return null;
  if (typeof countryCode !== 'string') throw new Error('countryCode must be a string');
  const code = countryCode.toUpperCase();
  if (!COUNTRY_CODE_PATTERN.test(code)) throw new Error(`Invalid country code "${countryCode}"`);
  return code;
}

// For *creating* a rate row — always required, never falls back to '*'
// unless the admin explicitly typed '*' itself.
function assertValidCountryCodeForWrite(countryCode) {
  if (typeof countryCode !== 'string' || !(countryCode === '*' || COUNTRY_CODE_PATTERN.test(countryCode.toUpperCase()))) {
    throw new Error(`Invalid country code "${countryCode}"`);
  }
  return countryCode === '*' ? '*' : countryCode.toUpperCase();
}

// Placeholder defaults so the system is usable before an admin enters real
// negotiated/published rates via the admin billing tool (routes/
// adminEntitlements.js). Deliberately modest markups over an assumed Meta
// conversation cost — an admin should review/replace these for real pricing.
// Source: 'seed_default' marks them clearly as placeholders in the rate list.
const DEFAULT_RATES = [
  { countryCode: '*', messageCategory: 'marketing',      providerCost: 0.0400, customerCharge: 0.0500, currency: 'USD' },
  { countryCode: '*', messageCategory: 'utility',         providerCost: 0.0150, customerCharge: 0.0200, currency: 'USD' },
  { countryCode: '*', messageCategory: 'authentication',  providerCost: 0.0150, customerCharge: 0.0200, currency: 'USD' },
  { countryCode: '*', messageCategory: 'service',         providerCost: 0,      customerCharge: 0,      currency: 'USD' },
  { countryCode: 'SA', messageCategory: 'marketing',      providerCost: 0.2160, customerCharge: 0.2500, currency: 'SAR' },
  { countryCode: 'SA', messageCategory: 'utility',         providerCost: 0.0800, customerCharge: 0.1000, currency: 'SAR' },
  { countryCode: 'AE', messageCategory: 'marketing',      providerCost: 0.2000, customerCharge: 0.2400, currency: 'AED' },
  { countryCode: 'AU', messageCategory: 'marketing',      providerCost: 0.0700, customerCharge: 0.0900, currency: 'AUD' },
  { countryCode: 'AU', messageCategory: 'utility',         providerCost: 0.0250, customerCharge: 0.0350, currency: 'AUD' },
];

// True if every failure in a (possibly bulk) write error is a duplicate-key
// (E11000) — i.e. "a concurrent call already inserted this exact row", which
// is fine to swallow, versus a real failure that must propagate.
function isPureDuplicateKeyError(err) {
  if (err.code === 11000) return true;
  if (Array.isArray(err.writeErrors) && err.writeErrors.length) {
    return err.writeErrors.every(e => (e.code ?? e.err?.code) === 11000);
  }
  return false;
}

async function ensureDefaultRates() {
  const existing = await WhatsAppRateCard.countDocuments();
  if (existing > 0) return;
  const now = new Date();
  try {
    // unordered so one racing duplicate doesn't abort the rest of the seed —
    // see models/WhatsAppRateCard.js's partial-unique index this can now hit.
    await WhatsAppRateCard.insertMany(
      DEFAULT_RATES.map(r => ({ ...r, effectiveFrom: now, source: 'seed_default' })),
      { ordered: false },
    );
  } catch (err) {
    if (!isPureDuplicateKeyError(err)) throw err;
  }
}

// Resolves the rate in effect at `at` (default now) for a country+category —
// falls back to the '*' wildcard row when no country-specific rate exists.
// Throws if genuinely nothing matches even after lazily seeding defaults
// (should only happen for a messageCategory outside the known enum).
async function getRate({ countryCode, category, at = new Date() }) {
  assertValidCategory(category);
  const safeCountryCode = normalizeCountryCodeForLookup(countryCode);
  await ensureDefaultRates();

  const query = (code) => WhatsAppRateCard.findOne({
    countryCode: code, messageCategory: category,
    effectiveFrom: { $lte: at },
    $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }, { effectiveTo: { $gt: at } }],
  }).sort({ effectiveFrom: -1 });

  let rate = (safeCountryCode && await query(safeCountryCode)) || await query('*');

  // Cosmos DB's eventual-consistency window can make a query miss rows this
  // same request just inserted via ensureDefaultRates' very first seed — a
  // one-time cold-start hiccup on a brand-new empty collection. One short
  // retry covers it without masking a genuinely-missing rate (a second
  // empty result still throws below).
  if (!rate) {
    await new Promise(r => setTimeout(r, 200));
    rate = (safeCountryCode && await query(safeCountryCode)) || await query('*');
  }

  if (!rate) throw new Error(`No WhatsApp rate configured for category "${category}"`);
  return rate;
}

async function listRates({ countryCode } = {}) {
  await ensureDefaultRates();
  const filter = countryCode ? { countryCode } : {};
  return WhatsAppRateCard.find(filter).sort({ countryCode: 1, messageCategory: 1, effectiveFrom: -1 }).lean();
}

// Adds a new rate version, closing out whichever row is currently in effect
// for the same country+category so historical UsageEvents (which store their
// own providerCost/customerCharge at send time) never retroactively change —
// only future lookups see the new rate. The partial-unique index on
// {countryCode, messageCategory} (open rows only) means a second concurrent
// call for the same pair fails loudly on create() instead of silently
// leaving two "current" rows — caught here and turned into a clear,
// retryable error for the admin form.
async function addRateVersion({ countryCode, messageCategory, providerCost, customerCharge, currency, effectiveFrom = new Date(), source = 'manual_admin_entry' }) {
  assertValidCategory(messageCategory);
  const safeCountryCode = assertValidCountryCodeForWrite(countryCode);

  const current = await WhatsAppRateCard.findOne({
    countryCode: safeCountryCode, messageCategory,
    $or: [{ effectiveTo: { $exists: false } }, { effectiveTo: null }],
  }).sort({ effectiveFrom: -1 });

  if (current) await WhatsAppRateCard.findByIdAndUpdate(current._id, { effectiveTo: effectiveFrom });

  try {
    return await WhatsAppRateCard.create({ countryCode: safeCountryCode, messageCategory, providerCost, customerCharge, currency, effectiveFrom, source });
  } catch (err) {
    if (err.code === 11000) throw new Error('Another rate update for this country/category just landed — please refresh and try again.');
    throw err;
  }
}

module.exports = { getRate, listRates, addRateVersion, ensureDefaultRates };
