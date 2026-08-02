const jwt = require('jsonwebtoken');
const { APP_URL } = require('../utils/config');

const JWT_SECRET = process.env.AUTH_JWT_SECRET;
const ISSUER = APP_URL;
const AUDIENCE = `${APP_URL}/api`;

if (!JWT_SECRET) {
  console.warn('[auth] AUTH_JWT_SECRET not set — login will be unusable until configured.');
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
    req.user = { id: payload.sub, workspaceId: payload.workspaceId, role: payload.role };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Session expired or invalid — please log in again' });
  }
}

module.exports = { requireAuth, JWT_SECRET, ISSUER, AUDIENCE };
