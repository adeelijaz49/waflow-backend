'use strict';
// How much work ONE inbound WhatsApp webhook request may make this server do.
//
// Meta's own requests are signed and are processed whole, however much they batch. A request that is NOT positively signed (a forged one,
// or genuine traffic while the signature cannot be verified - WA_APP_SECRET not set yet, a wrong secret, WEBHOOK_SIGNATURE_MODE=off; the
// default 'log' mode accepts them) is capped, so that it cannot multiply the database and WhatsApp work it costs. The legacy handler read
// only the first message of a request; these caps are far looser on purpose, so that genuine traffic still gets through in a setup where
// the signature cannot be verified. WEBHOOK_SIGNATURE_MODE=enforce closes the door completely.
//
//   MAX_UNSIGNED_EVENTS    messages and template news together: they write consent, open conversations, send replies and call Meta
//   MAX_UNSIGNED_STATUSES  delivery updates: each is an idempotent, rank-guarded update of a message whose id the sender must know, and the
//                          legacy handler applied every status of a batch (a promotion to a few hundred customers makes batches that big)
//   TEMPLATE_EVENT_COST    a template change counts this many events: each one makes the server read the real status from Meta
const MAX_UNSIGNED_EVENTS = 25;
const MAX_UNSIGNED_STATUSES = 500;
const TEMPLATE_EVENT_COST = 5;

/** The allowance of one request: unlimited when its signature is valid, capped otherwise. `skipped` counts what was left unprocessed. */
function newBudget(signature) {
  const open = signature === 'valid';
  return { left: open ? Infinity : MAX_UNSIGNED_EVENTS, statusesLeft: open ? Infinity : MAX_UNSIGNED_STATUSES, skipped: 0 };
}

// The part of `list` this request may still process (all of it with an unlimited budget); the rest is counted in budget.skipped.
// `key` names the counter to draw from, `cost` is what each item costs.
function takeFrom(budget, key, list, cost = 1) {
  const items = Array.isArray(list) ? list : [];
  if (budget[key] === Infinity) return items;
  const allowed = items.slice(0, Math.max(0, Math.floor(budget[key] / cost)));
  budget[key] -= allowed.length * cost;
  budget.skipped += items.length - allowed.length;
  return allowed;
}

const takeEvents = (budget, list, cost = 1) => takeFrom(budget, 'left', list, cost);
const takeStatuses = (budget, list) => takeFrom(budget, 'statusesLeft', list);

module.exports = { MAX_UNSIGNED_EVENTS, MAX_UNSIGNED_STATUSES, TEMPLATE_EVENT_COST, newBudget, takeEvents, takeStatuses };
