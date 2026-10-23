'use strict';
// Per-route access middleware for /api/onboarding/* (DB design 4.5). Runs after
// requireAuth (req.user = { id, workspaceId, role }); the workspace id is only
// ever taken from the verified token, never from the body or query.
//   1. not enrolled            -> 404 ONBOARDING_NOT_AVAILABLE (same answer as an unknown route)
//   2. billingExempt           -> pass for any enrolled state
//   3. subscription != active  -> 402 with the code of DB 4.4
//   4. ownerOnly               -> live Membership check (the JWT role can be 30 days stale), else 403 OWNER_ONLY
//   4b. liveMember             -> live Membership check (one indexed read) for the routes that spend the merchant's Meta credentials or send:
//                                 a member who was REMOVED still holds a 30-day JWT, and gets 403 NOT_A_MEMBER (review R2-05)
//   5. needsLegal              -> 403 LEGAL_ACCEPTANCE_REQUIRED
const stateModule = require('./state');
const gate = require('./gate');
const { respond, OnbError } = require('./errors');

/**
 * @param {{ownerOnly?:boolean, billingExempt?:boolean, needsLegal?:boolean, liveMember?:boolean}} [options]
 * @param {{getGateState?:Function, Membership?:object, getAcceptanceStatus?:Function}} [deps]
 */
function requireOnboardingAccess(options = {}, deps = {}) {
  const { ownerOnly = false, billingExempt = false, needsLegal = false, liveMember = false } = options || {};
  return async function onboardingAccess(req, res, next) {
    try {
      const user = req.user || {};
      const workspaceId = user.workspaceId ? String(user.workspaceId) : '';
      const getGateState = deps.getGateState || stateModule.getGateState;
      const gs = workspaceId ? await getGateState(workspaceId) : { enrolled: false };
      if (!gs || !gs.enrolled) return respond(res, new OnbError('ONBOARDING_NOT_AVAILABLE'));
      req.onboarding = { gate: gs };

      if (!billingExempt) {
        const sd = gate.subscriptionDenial(gs.sub && gs.sub.state);
        if (sd) return respond(res, new OnbError(sd.code, { retry: sd.retry }));
      }

      let role = user.role;
      if (ownerOnly || needsLegal || liveMember) {
        const Membership = deps.Membership || require('../../models/Membership');
        let membership = null;
        try {
          membership = await Membership.findOne({ userId: user.id, workspaceId }).select('role').lean();
        } catch (_) { membership = null; } // e.g. a malformed id: not a member
        role = membership ? membership.role : null;
        if (liveMember && !membership) return respond(res, new OnbError('NOT_A_MEMBER'));
        if (ownerOnly && role !== 'owner') return respond(res, new OnbError('OWNER_ONLY'));
      }

      if (needsLegal) {
        const getAcceptanceStatus = deps.getAcceptanceStatus || require('../legalAcceptance').getAcceptanceStatus;
        const status = await getAcceptanceStatus({ userId: user.id, workspaceId, role: role || 'member' });
        if (status && (status.requiresCombinedAcceptance || (role === 'owner' && status.requiresDpaAcceptance))) {
          return respond(res, new OnbError('LEGAL_ACCEPTANCE_REQUIRED'));
        }
      }
      return next();
    } catch (err) {
      return respond(res, err);
    }
  };
}

module.exports = requireOnboardingAccess;
module.exports.requireOnboardingAccess = requireOnboardingAccess;
