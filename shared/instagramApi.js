// Low-level Meta/Instagram Graph API client — the only place this feature
// should ever build a Graph API URL or know a permission scope name.
// Implements the "Instagram API with Instagram Login" route (instagram_
// business_* scopes) rather than the Facebook-Page-linked route, since the
// spec explicitly allows either and this one doesn't require the merchant
// to also have/connect a Facebook Page.
//
// Requires three env vars this app doesn't have yet (no Meta Developer App
// is registered for Instagram publishing in this environment — only the
// existing WhatsApp Business API app, which is a different Meta product):
//   META_APP_ID, META_APP_SECRET, META_INSTAGRAM_REDIRECT_URI
// Every function here throws a clear "not configured" error instead of a
// confusing network failure when they're absent — see isConfigured().
const axios = require('axios');

const IG_OAUTH_BASE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN_BASE = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH_BASE = 'https://graph.instagram.com/v21.0';
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];

function isConfigured() {
  return !!(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_INSTAGRAM_REDIRECT_URI);
}

function assertConfigured() {
  if (!isConfigured()) {
    throw new Error('Instagram integration is not configured yet — a Meta Developer App with the Instagram API product needs to be set up (META_APP_ID, META_APP_SECRET, META_INSTAGRAM_REDIRECT_URI).');
  }
}

function getAuthorizeUrl(state) {
  assertConfigured();
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.META_INSTAGRAM_REDIRECT_URI,
    scope: SCOPES.join(','),
    response_type: 'code',
    state,
  });
  return `${IG_OAUTH_BASE}?${params.toString()}`;
}

// Step 1 of 2 — short-lived token (valid ~1 hour), via a form-encoded POST.
async function exchangeCodeForToken(code) {
  assertConfigured();
  const form = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: process.env.META_INSTAGRAM_REDIRECT_URI,
    code,
  });
  const res = await axios.post(IG_TOKEN_BASE, form.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return res.data; // { access_token, user_id, permissions }
}

// Step 2 of 2 — exchanges the short-lived token for a long-lived one
// (valid ~60 days) — this is the token actually stored/used thereafter.
async function exchangeForLongLivedToken(shortLivedToken) {
  assertConfigured();
  const res = await axios.get(`${IG_GRAPH_BASE}/access_token`, {
    params: { grant_type: 'ig_exchange_token', client_secret: process.env.META_APP_SECRET, access_token: shortLivedToken },
  });
  return res.data; // { access_token, token_type, expires_in }
}

// Refreshes a still-valid long-lived token for another ~60 days — should be
// called periodically (see shared/instagram.js's scheduler) well before expiry.
async function refreshLongLivedToken(longLivedToken) {
  const res = await axios.get(`${IG_GRAPH_BASE}/refresh_access_token`, {
    params: { grant_type: 'ig_refresh_token', access_token: longLivedToken },
  });
  return res.data; // { access_token, token_type, expires_in }
}

async function getAccountInfo(accessToken) {
  const res = await axios.get(`${IG_GRAPH_BASE}/me`, { params: { fields: 'id,username,account_type', access_token: accessToken } });
  return res.data; // { id, username, account_type }
}

// Step 1 of the 2-step publish flow — creates a media container. videoUrl
// (vs. imageUrl) selects REELS media_type automatically.
async function createMediaContainer({ accessToken, igUserId, imageUrl, videoUrl, caption }) {
  const body = { caption, access_token: accessToken };
  if (videoUrl) { body.media_type = 'REELS'; body.video_url = videoUrl; }
  else { body.image_url = imageUrl; }
  const res = await axios.post(`${IG_GRAPH_BASE}/${igUserId}/media`, null, { params: body });
  return res.data; // { id: containerId }
}

async function getContainerStatus({ accessToken, containerId }) {
  const res = await axios.get(`${IG_GRAPH_BASE}/${containerId}`, { params: { fields: 'status_code,status', access_token: accessToken } });
  return res.data; // { status_code: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED', status }
}

// Step 2 of the 2-step publish flow.
async function publishContainer({ accessToken, igUserId, containerId }) {
  const res = await axios.post(`${IG_GRAPH_BASE}/${igUserId}/media_publish`, null, { params: { creation_id: containerId, access_token: accessToken } });
  return res.data; // { id: providerPostId }
}

module.exports = {
  isConfigured, assertConfigured, getAuthorizeUrl,
  exchangeCodeForToken, exchangeForLongLivedToken, refreshLongLivedToken,
  getAccountInfo, createMediaContainer, getContainerStatus, publishContainer,
};
