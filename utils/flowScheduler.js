// Sweeps every active Flow on an interval and drives customers through it —
// enroll newly-eligible customers, then re-validate and send to enrolled
// ones. No new send-tracking mechanism: every send writes a CampaignMessage
// exactly like promotion/loyalty/booking-notification sends already do.
//
// Two independent safety nets make this safe even under concurrent runs
// (see models/FlowEnrollment.js for the index details):
//   - No double-enrollment: a partial unique index on {flow, customer} for
//     live states — a losing concurrent insert hits E11000, caught below.
//   - No double-send: an atomic claim (state 'enrolled' -> 'messaged') right
//     before sending — a losing concurrent claim gets null back and skips.
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const SchedulerLock = require('../models/SchedulerLock');
const Customer = require('../models/Customer');
const CampaignMessage = require('../models/CampaignMessage');
const Settings = require('../models/Settings');
const triggers = require('./flowTriggers');

const FLOW_SCHEDULER_INTERVAL_MS = +(process.env.FLOW_SCHEDULER_INTERVAL_MS || 5 * 60 * 1000);
const LOCK_ID = 'flowScheduler';
const DEFAULT_COOLDOWN_DAYS = 3;

function wamidOf(sendResult) {
  return sendResult?.messages?.[0]?.id;
}

// Classic Mongo TTL-lock pattern. This is an efficiency/thundering-herd guard
// only — not the correctness mechanism (that's the per-enrollment claim
// above), so it's safe even if this ever races or is skipped.
async function acquireLock() {
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + FLOW_SCHEDULER_INTERVAL_MS - 60000);

  const renewed = await SchedulerLock.findOneAndUpdate(
    { _id: LOCK_ID, lockedUntil: { $lt: now } },
    { $set: { lockedAt: now, lockedUntil } },
    { new: true },
  );
  if (renewed) return true;

  try {
    await SchedulerLock.create({ _id: LOCK_ID, lockedAt: now, lockedUntil });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // another process holds a live lock
    throw err;
  }
}

// Phase A — create a FlowEnrollment for every newly-eligible customer.
async function enrollEligibleCustomers(flow) {
  const trigger = triggers[flow.triggerType];
  if (!trigger) return;
  const candidates = await trigger.findEligible(flow);
  for (const c of candidates) {
    try {
      await FlowEnrollment.create({
        flow: flow._id, customer: c.customerId,
        sourceModel: c.sourceModel, sourceRef: c.sourceRef,
      });
    } catch (err) {
      if (err.code !== 11000) console.error(`Flow enrollment error (flow ${flow._id}):`, err.message);
      // else: already enrolled, or lost a concurrent race to enroll — expected, skip.
    }
  }
}

// Phase B, one enrollment — revalidate, cooldown/opt-out check, atomic claim,
// then the real send. Exported standalone so tests can exercise concurrency
// on a single enrollment directly.
async function processEnrollment(flow, enrollment) {
  const trigger = triggers[flow.triggerType];
  if (!trigger) return;

  const verdict = await trigger.revalidate(flow, enrollment);
  if (verdict.outcome === 'exit') {
    await FlowEnrollment.findOneAndUpdate(
      { _id: enrollment._id, state: 'enrolled' },
      { state: 'exited', exitedAt: new Date(), exitReason: verdict.reason },
    );
    return;
  }
  if (verdict.outcome !== 'proceed') return; // 'skip' — try again next tick

  const settings = await Settings.findOne();
  const cooldownDays = flow.cooldownDaysOverride ?? settings?.flowCooldownDays ?? DEFAULT_COOLDOWN_DAYS;
  const cooldownSince = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
  const blockedByOtherFlow = await CampaignMessage.findOne({
    customer: enrollment.customer, kind: 'flow', flow: { $ne: flow._id }, sentAt: { $gte: cooldownSince },
  });
  if (blockedByOtherFlow) return; // skip this tick only — retried once the cooldown window rolls past

  const customer = await Customer.findById(enrollment.customer);
  if (!customer || customer.optedOut) { // defense in depth — most triggers already check this in revalidate
    await FlowEnrollment.findOneAndUpdate(
      { _id: enrollment._id, state: 'enrolled' },
      { state: 'exited', exitedAt: new Date(), exitReason: 'opted_out' },
    );
    return;
  }

  const claimed = await FlowEnrollment.findOneAndUpdate(
    { _id: enrollment._id, state: 'enrolled' },
    { state: 'messaged', messagedAt: new Date() },
    { new: true },
  );
  if (!claimed) return; // another tick/instance already claimed this enrollment

  let status = 'sent';
  let statusReason;
  let wamid;
  try {
    const result = await trigger.buildSend(flow, claimed, customer);
    wamid = wamidOf(result);
  } catch (err) {
    status = 'failed';
    statusReason = err.message;
  }

  await CampaignMessage.create({
    kind: 'flow', flow: flow._id, flowEnrollment: claimed._id,
    customer: customer._id, phone: customer.phone,
    wamid, messageType: 'template', templateName: flow.templateName,
    status, statusReason, sentAt: new Date(),
  }).catch(() => {});
}

// Phase B — every currently-enrolled (unsent) FlowEnrollment for this flow.
async function sendPendingEnrollments(flow) {
  const pending = await FlowEnrollment.find({ flow: flow._id, state: 'enrolled' });
  for (const enrollment of pending) {
    await processEnrollment(flow, enrollment);
  }
}

async function sweepFlow(flow) {
  await enrollEligibleCustomers(flow);
  await sendPendingEnrollments(flow);
  await Flow.findByIdAndUpdate(flow._id, { lastRunAt: new Date() });
}

async function runSweep() {
  const gotLock = await acquireLock();
  if (!gotLock) return;

  const activeFlows = await Flow.find({ status: 'active' });
  for (const flow of activeFlows) {
    try {
      await sweepFlow(flow);
    } catch (err) {
      console.error(`Flow scheduler error (flow ${flow._id}, ${flow.triggerType}):`, err.message);
    }
  }
}

let intervalHandle = null;

function startFlowScheduler() {
  if (intervalHandle) return; // idempotent
  runSweep().catch(err => console.error('Flow scheduler tick error:', err.message));
  intervalHandle = setInterval(() => {
    runSweep().catch(err => console.error('Flow scheduler tick error:', err.message));
  }, FLOW_SCHEDULER_INTERVAL_MS);
}

module.exports = {
  startFlowScheduler,
  runSweep,
  sweepFlow,
  enrollEligibleCustomers,
  sendPendingEnrollments,
  processEnrollment,
};
