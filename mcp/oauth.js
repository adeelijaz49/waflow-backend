const router = require('express').Router();
const crypto = require('crypto');
const jwt    = require('jsonwebtoken');
const { APP_URL } = require('../utils/config');
const { OAuthClient, OAuthRefreshToken } = require('./models');

const JWT_SECRET   = process.env.MCP_JWT_SECRET;
const ADMIN_USER   = process.env.MCP_ADMIN_USER;
const ADMIN_PASS   = process.env.MCP_ADMIN_PASSWORD;
const ISSUER       = APP_URL;
const ACCESS_TOKEN_TTL_SEC  = 60 * 60;          // 1h
const REFRESH_TOKEN_TTL_MS  = 30 * 24 * 60 * 60 * 1000; // 30d
const AUTH_CODE_TTL_MS      = 5 * 60 * 1000;    // 5min

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS) {
  console.warn('[mcp] MCP_JWT_SECRET / MCP_ADMIN_USER / MCP_ADMIN_PASSWORD not set — /mcp will be unusable until configured.');
}

// Short-lived authorization codes. In-memory is fine: the whole code_issued -> code_redeemed
// round trip happens within one live browser session (~seconds), so a process restart mid-flow
// just means the user retries the "connect" click in Claude/ChatGPT.
const authCodes = new Map(); // code -> { clientId, redirectUri, codeChallenge, expiresAt }

// Basic brute-force guard on the login form.
const loginAttempts = new Map(); // ip -> { count, resetAt }
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) return false;
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailedAttempt(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < Date.now()) {
    loginAttempts.set(ip, { count: 1, resetAt: Date.now() + ATTEMPT_WINDOW_MS });
  } else {
    rec.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) if (entry.expiresAt < now) authCodes.delete(code);
  for (const [ip, rec] of loginAttempts) if (rec.resetAt < now) loginAttempts.delete(ip);
}, 60 * 1000).unref();

function base64url(input) {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ─── Discovery metadata ───────────────────────────────────────────────────────

router.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: `${APP_URL}/mcp`,
    authorization_servers: [ISSUER],
  });
});
// Some clients probe a path-suffixed variant of the resource metadata URL.
router.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.json({
    resource: `${APP_URL}/mcp`,
    authorization_servers: [ISSUER],
  });
});

router.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer:                                ISSUER,
    authorization_endpoint:                `${APP_URL}/oauth/authorize`,
    token_endpoint:                        `${APP_URL}/oauth/token`,
    registration_endpoint:                 `${APP_URL}/oauth/register`,
    response_types_supported:              ['code'],
    grant_types_supported:                 ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported:      ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported:                      ['mcp'],
  });
});

// ─── Dynamic client registration (RFC 7591) ──────────────────────────────────

router.post('/oauth/register', async (req, res) => {
  try {
    const { redirect_uris, client_name } = req.body || {};
    if (!Array.isArray(redirect_uris) || !redirect_uris.length) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris is required' });
    }
    const clientId = crypto.randomBytes(16).toString('hex');
    await OAuthClient.create({ clientId, clientName: client_name || 'MCP client', redirectUris: redirect_uris });
    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'MCP client',
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ─── Authorize (login + consent) ─────────────────────────────────────────────

function renderLoginPage({ clientName, error, params }) {
  const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${k}" value="${v ?? ''}">`).join('\n');
  return `<!doctype html><html><head><title>Sign in to Waflow</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  form{background:#151b23;padding:2rem;border-radius:12px;width:320px;box-shadow:0 4px 24px rgba(0,0,0,.4)}
  h1{font-size:1.1rem;margin:0 0 .25rem}
  p{color:#9aa4af;font-size:.85rem;margin:0 0 1.25rem}
  input[type=text],input[type=password]{width:100%;padding:.6rem;margin-bottom:.75rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box}
  button{width:100%;padding:.65rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  .err{color:#ff6b6b;font-size:.85rem;margin-bottom:.75rem}
</style></head><body>
<form method="POST" action="/oauth/authorize">
  <h1>Sign in to Waflow</h1>
  <p>${clientName ? `"${clientName}" wants to access your Waflow data.` : 'Authorize this application.'}</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  ${hidden}
  <input type="text" name="username" placeholder="Username" autofocus required>
  <input type="password" name="password" placeholder="Password" required>
  <button type="submit">Sign in & Authorize</button>
</form>
</body></html>`;
}

router.get('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;

  if (response_type !== 'code') return res.status(400).send('unsupported response_type');
  if (code_challenge_method && code_challenge_method !== 'S256') return res.status(400).send('unsupported code_challenge_method');
  if (!code_challenge) return res.status(400).send('code_challenge (PKCE) is required');

  const client = await OAuthClient.findOne({ clientId: client_id });
  if (!client) return res.status(400).send('unknown client_id');
  if (!client.redirectUris.includes(redirect_uri)) return res.status(400).send('redirect_uri not registered for this client');

  res.type('html').send(renderLoginPage({
    clientName: client.clientName,
    params: { client_id, redirect_uri, state, code_challenge, code_challenge_method: code_challenge_method || 'S256' },
  }));
});

router.post('/oauth/authorize', async (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method, username, password } = req.body || {};
  const ip = req.ip;

  const client = await OAuthClient.findOne({ clientId: client_id });
  if (!client || !client.redirectUris.includes(redirect_uri)) return res.status(400).send('invalid client or redirect_uri');

  if (tooManyAttempts(ip)) {
    return res.type('html').status(429).send(renderLoginPage({
      clientName: client.clientName,
      error: 'Too many attempts. Try again later.',
      params: { client_id, redirect_uri, state, code_challenge, code_challenge_method },
    }));
  }

  if (username !== ADMIN_USER || password !== ADMIN_PASS) {
    recordFailedAttempt(ip);
    return res.type('html').status(401).send(renderLoginPage({
      clientName: client.clientName,
      error: 'Incorrect username or password.',
      params: { client_id, redirect_uri, state, code_challenge, code_challenge_method },
    }));
  }

  const code = crypto.randomBytes(24).toString('hex');
  authCodes.set(code, {
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set('code', code);
  if (state) redirect.searchParams.set('state', state);
  res.redirect(redirect.toString());
});

// ─── Token endpoint ───────────────────────────────────────────────────────────

function issueAccessToken(clientId) {
  return jwt.sign({ sub: 'admin', client_id: clientId }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SEC,
    issuer: ISSUER,
    audience: `${APP_URL}/mcp`,
  });
}

async function issueRefreshToken(clientId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await OAuthRefreshToken.create({ tokenHash, clientId, expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS) });
  return token;
}

router.post('/oauth/token', async (req, res) => {
  const { grant_type } = req.body || {};

  try {
    if (grant_type === 'authorization_code') {
      const { code, redirect_uri, client_id, code_verifier } = req.body;
      const entry = authCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) return res.status(400).json({ error: 'invalid_grant', error_description: 'code expired or unknown' });
      authCodes.delete(code); // single use

      if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id/redirect_uri mismatch' });
      }
      if (!code_verifier) return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier required' });

      const computed = base64url(crypto.createHash('sha256').update(code_verifier).digest());
      if (computed !== entry.codeChallenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });

      const access_token  = issueAccessToken(client_id);
      const refresh_token = await issueRefreshToken(client_id);
      return res.json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token, scope: 'mcp' });
    }

    if (grant_type === 'refresh_token') {
      const { refresh_token, client_id } = req.body;
      if (!refresh_token) return res.status(400).json({ error: 'invalid_request' });
      const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      const stored = await OAuthRefreshToken.findOne({ tokenHash });
      if (!stored || stored.expiresAt < new Date()) return res.status(400).json({ error: 'invalid_grant', error_description: 'refresh token expired or unknown' });
      if (client_id && stored.clientId !== client_id) return res.status(400).json({ error: 'invalid_grant' });

      // Rotate: delete old, issue new.
      await OAuthRefreshToken.deleteOne({ _id: stored._id });
      const access_token   = issueAccessToken(stored.clientId);
      const new_refresh    = await issueRefreshToken(stored.clientId);
      return res.json({ access_token, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_SEC, refresh_token: new_refresh, scope: 'mcp' });
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  } catch (err) {
    res.status(500).json({ error: 'server_error', error_description: err.message });
  }
});

// ─── Bearer auth middleware for the /mcp endpoint ────────────────────────────

function requireBearerAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer (.+)$/i);
  const unauthorized = () => {
    res.set('WWW-Authenticate', `Bearer resource_metadata="${APP_URL}/.well-known/oauth-protected-resource"`);
    res.status(401).json({ error: 'invalid_token' });
  };
  if (!match) return unauthorized();

  try {
    const payload = jwt.verify(match[1], JWT_SECRET, { issuer: ISSUER, audience: `${APP_URL}/mcp` });
    req.mcpAuth = payload;
    next();
  } catch (_) {
    unauthorized();
  }
}

module.exports = { router, requireBearerAuth };
