// Workspace scoping shared by every flow trigger and by utils/flowScheduler.js (one app, many customers: a flow of
// workspace A may only ever read, enroll and message workspace A's data).
//
//   dataScope(flow)   filter for the TENANT DATA a trigger reads (Order, Customer, Booking): exactly that workspace.
//   ledgerScope(flow) filter for the engine's OWN bookkeeping rows (FlowEnrollment, CampaignMessage): that workspace OR
//                     a row with no workspaceId. The scheduler used to create those rows WITHOUT a workspaceId, so rows
//                     written before this change are unstamped; they must still count for "already enrolled",
//                     "already attempted" and the cross-flow cooldown, or every one of them would be enrolled and
//                     messaged a second time. They cannot belong to another tenant (they are keyed by this flow's /
//                     this customer's ids, which are unique), so including them leaks nothing.
//
// A flow with NO workspaceId gets {} from both (the old, unscoped query). utils/flowScheduler.js#runSweep never lets such
// a flow run (it skips it with a log line), so this only keeps the exported single-step functions (enrollEligibleCustomers,
// processEnrollment, ...) behaving exactly as before for callers that build a flow by hand.
const mongoose = require('mongoose');

function workspaceOid(flow) {
  const raw = flow && flow.workspaceId;
  if (!raw) return null;
  const s = String(raw);
  // Fail closed: a garbage id must never degrade into an unscoped (all customers) query.
  if (!/^[0-9a-fA-F]{24}$/.test(s)) throw new Error('flow has an invalid workspaceId');
  return new mongoose.Types.ObjectId(s);
}

function dataScope(flow) {
  const oid = workspaceOid(flow);
  return oid ? { workspaceId: oid } : {};
}

function ledgerScope(flow) {
  const oid = workspaceOid(flow);
  return oid ? { workspaceId: { $in: [oid, null] } } : {};
}

module.exports = { workspaceOid, dataScope, ledgerScope };
