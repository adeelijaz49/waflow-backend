const inactiveCustomer = require('./inactiveCustomer');
const postPurchasePoints = require('./postPurchasePoints');

// Registry mapping Flow.triggerType -> a plugin exposing exactly three
// functions. utils/flowScheduler.js (the engine) is entirely trigger-agnostic
// — it only ever calls through this registry, so adding a new trigger type
// never touches the engine, only adds a new file here.
//
// Plugin contract:
//   findEligible(flow) -> Promise<Array<{ customerId, sourceModel?, sourceRef? }>>
//     Candidates for enrollment this tick. sourceModel/sourceRef ('Order' or
//     'Booking' + its id) are only set for event-sourced triggers.
//
//   revalidate(flow, enrollment) -> Promise<{ outcome: 'proceed'|'skip'|'exit', reason? }>
//     Re-checks the trigger condition at send time, right before a message
//     would go out. 'proceed' = still eligible, send now. 'skip' = transient
//     (not yet due, or blocked this tick only) — retried next tick, no state
//     change. 'exit' = the underlying condition is permanently no longer
//     true (e.g. customer reordered) — the enrollment is closed out, no send.
//
//   buildSend(flow, enrollment, customer) -> Promise<sendResult>
//     Performs the actual WhatsApp template send (via utils/whatsapp.js) and
//     returns the raw API response, exactly like every other send* function
//     in this codebase — the caller extracts the wamid from it.
module.exports = {
  inactive_customer: inactiveCustomer,
  post_purchase_points: postPurchasePoints,
  // points_balance_reminder: added in Phase 3
  // booking_no_show: added in Phase 4
};
