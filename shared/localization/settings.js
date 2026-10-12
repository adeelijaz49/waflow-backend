'use strict';
// Localisation settings + the per-merchant `arabic_enabled` rollout flag.
// Read paths never create documents (the webhook hook calls isArabicEnabled for
// every inbound message of every merchant — it must stay a cheap, write-free,
// cached lookup). LOCALIZATION_DISABLED=1 is an operational kill switch that
// turns every localisation behaviour off without a redeploy.
const LocaleSettings = require('../../models/LocaleSettings');
const { assertEnum } = require('./scope');

const TTL_MS = 30 * 1000;
const flagCache = new Map(); // workspaceId -> { value, expires }

function killSwitchOn() {
  return process.env.LOCALIZATION_DISABLED === '1' || process.env.LOCALIZATION_DISABLED === 'true';
}

function cacheKey(workspaceId) { return String(workspaceId); }
function invalidate(workspaceId) { flagCache.delete(cacheKey(workspaceId)); }
function clearCache() { flagCache.clear(); }

async function isArabicEnabled(workspaceId) {
  if (!workspaceId || killSwitchOn()) return false;
  const key = cacheKey(workspaceId);
  const hit = flagCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const doc = await LocaleSettings.findOne({ workspaceId }).select('arabicEnabled').lean();
  const value = !!(doc && doc.arabicEnabled);
  flagCache.set(key, { value, expires: Date.now() + TTL_MS });
  return value;
}

const DEFAULTS = Object.freeze({ arabicEnabled: false, defaultCustomerLanguage: 'en', bilingualOrder: 'ar_first' });

function toView(doc) {
  const d = doc || {};
  return {
    arabicEnabled: !!d.arabicEnabled,
    arabicEnabledAt: d.arabicEnabledAt || null,
    defaultCustomerLanguage: d.defaultCustomerLanguage || DEFAULTS.defaultCustomerLanguage,
    bilingualOrder: d.bilingualOrder || DEFAULTS.bilingualOrder,
  };
}

// Merchant-facing read: defaults when nothing has been saved yet (no write).
async function getSettings(workspaceId) {
  const doc = await LocaleSettings.findOne({ workspaceId }).lean();
  return toView(doc);
}

// Merchant-controlled fields only. The flag is NOT writable here.
async function updateMerchantSettings(workspaceId, patch = {}) {
  const set = {};
  if (patch.defaultCustomerLanguage !== undefined) set.defaultCustomerLanguage = assertEnum(patch.defaultCustomerLanguage, ['en', 'ar'], 'defaultCustomerLanguage');
  if (patch.bilingualOrder !== undefined) set.bilingualOrder = assertEnum(patch.bilingualOrder, ['ar_first', 'en_first'], 'bilingualOrder');
  const doc = await LocaleSettings.findOneAndUpdate(
    { workspaceId },
    { $set: set, $setOnInsert: { workspaceId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  return toView(doc);
}

// Waflow-staff only (routes/adminLocalization.js).
async function setArabicEnabled({ workspaceId, enabled, grantedBy, notes }) {
  const set = { arabicEnabled: !!enabled };
  if (enabled) { set.arabicEnabledAt = new Date(); set.arabicEnabledBy = grantedBy || 'unknown'; }
  if (notes !== undefined) set.notes = String(notes).slice(0, 500);
  const doc = await LocaleSettings.findOneAndUpdate(
    { workspaceId },
    { $set: set, $setOnInsert: { workspaceId } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  invalidate(workspaceId);
  return { ...toView(doc), notes: doc.notes || '', arabicEnabledBy: doc.arabicEnabledBy || null };
}

// Express middleware: 402 + code ARABIC_NOT_ENABLED unless the flag is on
// (same shape as the Instagram add-on's INSTAGRAM_NOT_ENABLED).
async function requireArabicEnabled(req, res, next) {
  try {
    if (await isArabicEnabled(req.user && req.user.workspaceId)) return next();
    return res.status(402).json({ error: 'Arabic localisation is not enabled for this workspace — contact WaFlow to enable it.', code: 'ARABIC_NOT_ENABLED' });
  } catch (err) {
    console.error('[localization] flag check failed:', err.message);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = {
  DEFAULTS, killSwitchOn, isArabicEnabled, getSettings, updateMerchantSettings, setArabicEnabled,
  requireArabicEnabled, invalidate, clearCache,
};
