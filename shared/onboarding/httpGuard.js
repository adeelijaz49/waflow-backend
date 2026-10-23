'use strict';
// Pre-router HTTP guard (DB design 4.6 "Flow", hunk E2): mounted as
// app.use('/api', guard) BEFORE every existing /api router. It never rejects a
// request it cannot positively attribute to an enrolled workspace:
//   - first statement: flag check (flag off = next(), nothing else runs);
//   - it verifies the JWT ITSELF (own jwt.verify, exports of middleware/requireAuth)
//     and ANY failure/absence/pre-auth token/odd workspaceId -> next(), so the
//     route's own requireAuth produces the normal 401;
//   - legacy (no sidecar) -> next() (after the auto-enrolment check of DB 3.2);
//   - enrolled + a route of the send/connect table -> gate.evaluate -> 402 or next().
// Never throws; any internal failure -> next().
const config = require('./config');
const stateModule = require('./state');
const gate = require('./gate');
const sendRoutes = require('./sendRoutes');
const { respond, OnbError } = require('./errors');
const failOpen = require('./failOpen');

const ID_RE = /^[0-9a-f]{24}$/i;

function defaultVerify(token) {
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../middleware/requireAuth');
  return jwt.verify(token, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
}

/**
 * @param {{verify?:Function, getGateState?:Function, autoEnrol?:Function}} [deps]
 */
function createHttpGuard(deps = {}) {
  return async function onboardingHttpGuard(req, res, next) {
    if (!config.enabled()) return next();
    try {
      const header = (req.headers && req.headers.authorization) || '';
      const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
      if (!token) return next();

      let payload;
      try { payload = (deps.verify || defaultVerify)(token); } catch (_) { return next(); }
      if (!payload || payload.preAuth || !ID_RE.test(String(payload.workspaceId || ''))) return next();
      const workspaceId = String(payload.workspaceId);

      const getGateState = deps.getGateState || stateModule.getGateState;
      // every lookup is bounded (R1-F3): a lookup that never settles must not hold the legacy /api request, so it fails open (next())
      const bounded = (fn) => failOpen.withTimeout(fn, deps.lookupTimeoutMs, 'gate lookup');
      let gs = await bounded(() => getGateState(workspaceId));
      if (!gs || !gs.enrolled) {
        const auto = await bounded(() => (deps.autoEnrol || stateModule.autoEnrolIfEligible)({ workspaceId }));
        if (!auto || !auto.enrolled) return next();
        gs = await bounded(() => getGateState(workspaceId, { fresh: true }));
        if (!gs || !gs.enrolled) return next();
      }

      const row = sendRoutes.match(req.method, sendRoutes.pathOf(req));
      if (!row) return next();
      const verdict = gate.evaluate(gs, { kind: row.kind });
      if (verdict.allowed) return next();
      return respond(res, new OnbError(verdict.code, { retry: verdict.retry }));
    } catch (err) {
      failOpen.logFailOpen('httpGuard', err); // one throttled line per minute, the code only
      return next();
    }
  };
}

const middleware = createHttpGuard();

module.exports = { middleware, createHttpGuard };
