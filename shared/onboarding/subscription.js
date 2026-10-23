'use strict';
// Pure subscription-state logic of the onboarding flow (DB design 4.1-4.3).
// No I/O. The EFFECTIVE state combines the stored Stripe facts and the admin
// activation, so an admin activation and later Stripe events never fight.
const { acceptTrialing: acceptTrialingFlag } = require('./config');

const STATES = Object.freeze(['none', 'pending', 'active', 'past_due', 'cancelled']);
const SOURCES = Object.freeze(['stripe', 'admin']);

/**
 * Map a raw Stripe subscription status to our state (DB 4.2).
 * @param {string} rawStatus
 * @param {{hasDefaultPaymentMethod?:boolean, acceptTrialing?:boolean}} [ctx]
 * @returns {{state:string|null, reason?:string}} state null = unknown status (caller keeps the stored state; never guess)
 */
function mapRawStatus(rawStatus, ctx = {}) {
  switch (String(rawStatus || '').toLowerCase()) {
    case 'active': return { state: 'active' };
    case 'trialing':
      if (ctx.acceptTrialing && ctx.hasDefaultPaymentMethod) return { state: 'active', reason: 'TRIAL_ACCEPTED' };
      return { state: 'pending', reason: 'TRIAL_NOT_RECOGNISED' };
    case 'incomplete': return { state: 'pending' };
    case 'incomplete_expired': return { state: 'none', reason: 'INCOMPLETE_EXPIRED' };
    case 'past_due':
    case 'unpaid':
    case 'paused': return { state: 'past_due' };
    case 'canceled': return { state: 'cancelled' };
    default: return { state: null, reason: 'UNKNOWN_STATUS' };
  }
}

/**
 * Effective subscription state (DB 4.3).
 * @param {object} sub OnboardingState.subscription (plain object or undefined)
 * @param {{acceptTrialing?:boolean}} [opts]
 * @returns {{state:string, source:'stripe'|'admin'|null, reason?:string}}
 */
function effectiveState(sub, opts = {}) {
  const s = sub || {};
  const stripe = s.stripe || {};
  const accept = opts.acceptTrialing !== undefined ? !!opts.acceptTrialing : acceptTrialingFlag();

  let stripeState = 'none';
  let reason;
  if (stripe.status) {
    const m = mapRawStatus(stripe.status, { hasDefaultPaymentMethod: !!stripe.hasDefaultPaymentMethod, acceptTrialing: accept });
    if (m.state) {
      stripeState = m.state; reason = m.reason;
    } else if (s.source !== 'admin' && STATES.includes(s.state) && s.state !== 'active') {
      stripeState = s.state; // unknown raw status: keep what was stored, never guess
      reason = m.reason;
    }
  } else if (stripe.checkoutStartedAt && !stripe.subscriptionId) {
    stripeState = 'pending';
  }

  if (stripeState === 'active') return { state: 'active', source: 'stripe', ...(reason ? { reason } : {}) };
  if (s.admin && s.admin.active) return { state: 'active', source: 'admin' };
  return { state: stripeState, source: null, ...(reason ? { reason } : {}) };
}

/**
 * The $set patch for a transition (idempotent: nothing to write when unchanged).
 * @param {{state?:string, source?:string|null}} prev
 * @param {{state:string, source?:string|null}} next
 * @param {Date} now
 * @returns {{changed:boolean, set:object}}
 */
function transitionPatch(prev, next, now) {
  const p = prev || {};
  const pState = p.state || 'none';
  const pSource = p.source || null;
  const nSource = next.source || null;
  if (pState === next.state && pSource === nSource) return { changed: false, set: {} };
  const set = {
    'subscription.state': next.state,
    'subscription.source': nSource,
    'subscription.changedAt': now,
  };
  if (next.state !== pState) {
    if (next.state === 'active') set['subscription.activatedAt'] = now;
    if (next.state === 'past_due') set['subscription.pastDueAt'] = now;
    if (next.state === 'cancelled') set['subscription.cancelledAt'] = now;
  }
  return { changed: true, set };
}

module.exports = { mapRawStatus, effectiveState, transitionPatch, STATES, SOURCES };
