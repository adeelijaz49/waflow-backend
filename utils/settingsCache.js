// In-memory cache of the single Settings doc so every WhatsApp send doesn't hit
// Mongo just to read the currency code. Invalidated explicitly on save
// (shared/operations.js#updateLoyaltySettings) rather than on a TTL, since
// Settings changes are rare and admin-driven.
const Settings = require('../models/Settings');

let cached = null;
let inflight = null;

async function getSettings() {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    cached = (await Settings.findOne()) || (await Settings.create({}));
    inflight = null;
    return cached;
  })();
  return inflight;
}

async function getCurrency() {
  const settings = await getSettings();
  return settings.currency || 'AUD';
}

function invalidate() {
  cached = null;
}

module.exports = { getSettings, getCurrency, invalidate };
