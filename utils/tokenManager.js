const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CACHE_FILE = path.join(__dirname, '../.wa-token-cache.json');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

const state = {
  token:     process.env.WA_TOKEN || '',
  expiresAt: null,   // ms timestamp; null = unknown or never-expires
  isValid:   null,
  checkedAt: null,
};

// Load cached long-lived token from previous run
try {
  if (fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (cached.token && (!cached.expiresAt || cached.expiresAt > Date.now())) {
      state.token     = cached.token;
      state.expiresAt = cached.expiresAt;
      process.env.WA_TOKEN = cached.token;
      console.log('[WA Token] Loaded from cache' + (cached.expiresAt ? ', expires ' + new Date(cached.expiresAt).toISOString() : ' (non-expiring)'));
    }
  }
} catch (_) {}

function hasAppCreds() {
  return !!(process.env.WA_APP_ID && process.env.WA_APP_SECRET);
}

async function debugToken(token) {
  const appToken = `${process.env.WA_APP_ID}|${process.env.WA_APP_SECRET}`;
  const res = await axios.get('https://graph.facebook.com/debug_token', {
    params: { input_token: token, access_token: appToken },
  });
  return res.data.data;
}

async function exchangeForLongLived(token) {
  const res = await axios.get('https://graph.facebook.com/oauth/access_token', {
    params: {
      grant_type:       'fb_exchange_token',
      client_id:        process.env.WA_APP_ID,
      client_secret:    process.env.WA_APP_SECRET,
      fb_exchange_token: token,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ token: state.token, expiresAt: state.expiresAt }), 'utf8');
  } catch (_) {}
}

async function refresh() {
  if (!hasAppCreds()) {
    throw new Error('Set WA_APP_ID and WA_APP_SECRET in env to enable token refresh');
  }

  const info = await debugToken(state.token);
  state.isValid   = info.is_valid;
  state.checkedAt = Date.now();

  if (!info.is_valid) {
    throw new Error('WhatsApp token is invalid or expired — paste a new token into WA_TOKEN');
  }

  // expires_at === 0 means System User token (never expires)
  if (info.expires_at === 0) {
    state.expiresAt = null;
    console.log('[WA Token] System User token — never expires, no refresh needed');
    saveCache();
    return getStatus();
  }

  const expiresAt = info.expires_at * 1000;
  const remaining = expiresAt - Date.now();

  // Exchange for long-lived if it'll expire within 7 days
  if (remaining < SEVEN_DAYS) {
    console.log('[WA Token] Exchanging for long-lived token...');
    const result    = await exchangeForLongLived(state.token);
    state.token     = result.access_token;
    state.expiresAt = Date.now() + (result.expires_in || 5184000) * 1000; // default 60 days
    process.env.WA_TOKEN = state.token;
    console.log('[WA Token] Refreshed, expires', new Date(state.expiresAt).toISOString());
  } else {
    state.expiresAt = expiresAt;
    console.log('[WA Token] Valid, expires', new Date(state.expiresAt).toISOString());
  }

  saveCache();
  return getStatus();
}

async function init() {
  if (!state.token) {
    console.warn('[WA Token] WA_TOKEN not set — WhatsApp features disabled');
    return;
  }
  if (!hasAppCreds()) {
    console.log('[WA Token] WA_APP_ID/WA_APP_SECRET not set — skipping auto-refresh. Token used as-is.');
    state.isValid = true;
    return;
  }
  try {
    await refresh();
  } catch (err) {
    console.error('[WA Token] Init check failed:', err.message);
  }
}

function getToken() {
  return state.token;
}

function getStatus() {
  const expiresAt  = state.expiresAt;
  const remaining  = expiresAt ? expiresAt - Date.now() : null;
  const daysLeft   = remaining ? Math.floor(remaining / 86400000) : null;
  return {
    isValid:           state.isValid,
    neverExpires:      expiresAt === null && state.isValid !== false,
    expiresAt:         expiresAt ? new Date(expiresAt).toISOString() : null,
    daysLeft,
    checkedAt:         state.checkedAt ? new Date(state.checkedAt).toISOString() : null,
    hasAppCredentials: hasAppCreds(),
  };
}

module.exports = { init, refresh, getToken, getStatus };
