// Gate for /internal-admin — Waflow-staff-only PII deletion/correction
// tooling (Data Protection Compliance feature). Deliberately separate from
// the normal workspace owner/member JWT auth (middleware/requireAuth.js) and
// from the MCP connector's admin credential (mcp/oauth.js) — a distinct
// credential pair for a distinct, internal-only concern. HTTP Basic Auth
// (browser-native prompt) rather than a full OAuth flow, since this is
// low-frequency staff tooling, not a public-facing integration.
const AdminAuditLog = require('../models/AdminAuditLog');
const { checkBreach } = require('../utils/breachAlert');

const ADMIN_USER = process.env.INTERNAL_ADMIN_USER;
const ADMIN_PASS = process.env.INTERNAL_ADMIN_PASSWORD;

if (!ADMIN_USER || !ADMIN_PASS) {
  console.warn('[internal-admin] INTERNAL_ADMIN_USER / INTERNAL_ADMIN_PASSWORD not set — /internal-admin will be unusable until configured.');
}

// Same Map-based brute-force guard shape as mcp/oauth.js's loginAttempts.
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
  for (const [ip, rec] of loginAttempts) if (rec.resetAt < now) loginAttempts.delete(ip);
}, 60 * 1000).unref();

function challenge(res) {
  res.set('WWW-Authenticate', 'Basic realm="Waflow Internal Admin"');
  return res.status(401).send('Authentication required');
}

module.exports = async function requireInternalAdmin(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (tooManyAttempts(ip)) {
    await AdminAuditLog.create({ action: 'login_failed', ip, detail: { reason: 'rate_limited' } }).catch(() => {});
    checkBreach({ type: 'admin_lockout', ip });
    return res.status(429).send('Too many failed attempts — try again later.');
  }

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return challenge(res);

  const [user, pass] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  if (!ADMIN_USER || !ADMIN_PASS || user !== ADMIN_USER || pass !== ADMIN_PASS) {
    recordFailedAttempt(ip);
    await AdminAuditLog.create({ action: 'login_failed', ip, detail: { user } }).catch(() => {});
    if (tooManyAttempts(ip)) checkBreach({ type: 'admin_bruteforce', ip });
    return challenge(res);
  }

  await AdminAuditLog.create({ action: 'login_success', ip }).catch(() => {});
  req.adminIp = ip;
  next();
};
