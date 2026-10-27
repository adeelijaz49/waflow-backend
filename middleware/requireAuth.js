const jwt = require('jsonwebtoken');
const { APP_URL } = require('../utils/config');
const senderContext = require('../utils/senderContext');

const JWT_SECRET = process.env.AUTH_JWT_SECRET;
const ISSUER = APP_URL;
const AUDIENCE = `${APP_URL}/api`;

if (!JWT_SECRET) {
  console.warn('[auth] AUTH_JWT_SECRET not set — login will be unusable until configured.');
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

// A session token always carries the workspace it is for. The 10-minute pre-auth token (issued to people in 2+ workspaces
// so they can pick one) has none: it is only valid for POST /api/auth/select-workspace, which verifies it itself. Letting
// it through here made every workspace-scoped route run UNSCOPED (a missing workspaceId means "no filter" in
// shared/operations.js), so it is refused outright, as is any token whose workspaceId is not a real ObjectId.
function rejectSession(res) {
  return res.status(401).json({ error: 'Session expired or invalid — please log in again' });
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
  } catch (err) {
    return rejectSession(res);
  }

  if (!payload || payload.preAuth) return rejectSession(res);
  const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : '';
  if (!OBJECT_ID_RE.test(workspaceId)) return rejectSession(res);

  req.user = { id: payload.sub, workspaceId, role: payload.role };
  if (payload.sa === true) req.user.sa = true;

  if (payload.actAs === true) {
    // A super admin "entering" a customer: an 8-hour token with no Membership row. It must carry sa, and it is only good
    // while the person is STILL on the allowlist (removing a contact from SUPER_ADMIN_CONTACTS ends their sessions at the
    // next request instead of at expiry).
    if (payload.sa !== true) return rejectSession(res);
    let staff;
    try {
      const User = require('../models/User');
      const { isSuperAdminUser } = require('../shared/platformAdmin');
      staff = await User.findById(payload.sub).select('phone email').lean();
      if (!isSuperAdminUser(staff)) return rejectSession(res);
    } catch (err) {
      return res.status(503).json({ error: 'Could not verify your session right now — please try again' });
    }
    req.user.actAs = true;

    // Everything WaFlow staff CHANGE inside a customer is written to the platform audit trail first (method and path, never the
    // body); if that cannot be written the change is refused. Reading is not logged, and leaving the customer logs itself.
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(String(req.method).toUpperCase());
    if (isWrite && !(req.method === 'POST' && path.replace(/\/+$/, '') === '/api/platform/exit')) {
      try {
        const PlatformAuditLog = require('../models/PlatformAuditLog');
        const { maskUser } = require('../shared/platformAdmin');
        await PlatformAuditLog.create({
          actorUserId: payload.sub, actorLabel: maskUser(staff), action: 'act_as_write', workspaceId,
          ip: req.ip, forwardedFor: String(req.headers['x-forwarded-for'] || '').slice(0, 200),
          userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
          detail: { method: String(req.method).toUpperCase(), path: path.slice(0, 200) },
        });
      } catch (err) {
        console.error('[auth] act-as audit write failed, change refused:', err && err.message);
        return res.status(503).json({ error: 'Could not record this action in the audit log, so nothing was changed. Please try again.' });
      }
    }
  }

  // One hook for every /api route: which customer (workspace) this request's WhatsApp work is for.
  return senderContext.run(workspaceId, next);
}

module.exports = { requireAuth, JWT_SECRET, ISSUER, AUDIENCE };
