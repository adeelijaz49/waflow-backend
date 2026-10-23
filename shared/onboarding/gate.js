'use strict';
// The server-side access rule (DB design 4.4): a pure function over the gate
// state. Not enrolled -> allow. No I/O.
const { CODES } = require('./errors');
const { CONNECTED_LIKE, legacySendPolicy } = require('./config');

const SUBSCRIPTION_CODES = Object.freeze({
  none: 'SUBSCRIPTION_REQUIRED',
  pending: 'PAYMENT_PENDING',
  past_due: 'PAYMENT_PAST_DUE',
  cancelled: 'SUBSCRIPTION_CANCELLED',
});

const RETRY = {
  SUBSCRIPTION_REQUIRED: { checkout: true, billingPortal: false, reconnect: false },
  PAYMENT_PENDING: { checkout: false, billingPortal: false, reconnect: false },
  PAYMENT_PAST_DUE: { checkout: false, billingPortal: true, reconnect: false },
  SUBSCRIPTION_CANCELLED: { checkout: true, billingPortal: true, reconnect: false },
  WHATSAPP_NOT_CONNECTED: { checkout: false, billingPortal: false, reconnect: false },
  WHATSAPP_RECONNECT_REQUIRED: { checkout: false, billingPortal: false, reconnect: true },
  SENDING_NOT_AVAILABLE_YET: { checkout: false, billingPortal: false, reconnect: false },
};

function denial(code) {
  const def = CODES[code];
  return { allowed: false, code, status: def.status, nextStep: def.nextStep, retry: { ...RETRY[code] } };
}

/**
 * @param {string} state subscription state
 * @returns {{code:string, nextStep:string|null, retry:object}|null} null when active
 */
function subscriptionDenial(state) {
  if (state === 'active') return null;
  const code = SUBSCRIPTION_CODES[state] || SUBSCRIPTION_CODES.none; // unknown value on an enrolled workspace: deny
  const d = denial(code);
  return { code, status: d.status, nextStep: d.nextStep, retry: d.retry };
}

function isConnectedLike(conn) {
  return !!conn && !conn.needsReconnect && CONNECTED_LIKE.includes(conn.status);
}

/** @returns {'WHATSAPP_NOT_CONNECTED'|'WHATSAPP_RECONNECT_REQUIRED'|null} */
function connectionDenial(conn) {
  if (!conn) return 'WHATSAPP_NOT_CONNECTED';
  if (conn.needsReconnect || conn.status === 'reconnect_required') return 'WHATSAPP_RECONNECT_REQUIRED';
  if (!CONNECTED_LIKE.includes(conn.status)) return 'WHATSAPP_NOT_CONNECTED';
  return null;
}

/**
 * @param {object} gateState result of state.getGateState
 * @param {{policy?:'block'|'platform_number', kind?:'send'|'connect'}|string} [options] a string is the policy
 * @returns {{allowed:true}|{allowed:false, code:string, status:402, nextStep:string|null, retry:object}}
 */
function evaluate(gateState, options) {
  if (!gateState || !gateState.enrolled) return { allowed: true };
  const opts = typeof options === 'string' ? { policy: options } : (options || {});
  const kind = opts.kind === 'connect' ? 'connect' : 'send';
  const policy = opts.policy || gateState.legacyPolicy || legacySendPolicy();

  const subState = gateState.sub && gateState.sub.state;
  const sd = subscriptionDenial(subState);
  if (sd) return denial(sd.code);
  if (kind === 'connect') return { allowed: true }; // subscription only (Instagram connect/publish routes)

  const cd = connectionDenial(gateState.conn);
  if (cd) return denial(cd);
  if (policy !== 'platform_number') return denial('SENDING_NOT_AVAILABLE_YET');
  return { allowed: true };
}

module.exports = { evaluate, subscriptionDenial, connectionDenial, isConnectedLike, SUBSCRIPTION_CODES };
