'use strict';
// Shared setup of the B1-b unit suites: in-memory models (B0's fake store), fakeStripe, a fixed clock and a
// recording `notify`. No mongoose connection, no network. Not a test file (the name does not match jest's pattern).
const { createFakeModel, newId } = require('./_b0Store');
const { createFakeStripe, fixedClock, createFakeSend } = require('../_fixtures');

/**
 * @param {{shape?:'current'|'basil'}} [opts]
 */
function makeHarness(opts = {}) {
  const clock = fixedClock();
  const stripe = createFakeStripe({ shape: opts.shape || 'current', clock });
  const OnboardingState = createFakeModel();
  const OnboardingInbound = createFakeModel({ unique: [['_id']] });
  const User = createFakeModel();
  const notifications = [];
  const seenKeys = new Set();
  const notify = async (args) => {
    const key = `${args.workspaceId}|${args.dedupeKey}`;
    const dup = seenKeys.has(key);
    seenKeys.add(key);
    if (!dup) notifications.push(args);
    return { created: !dup, notification: dup ? null : { kind: args.kind }, emailPromise: null };
  };
  const tracked = [];
  const deps = {
    OnboardingState, OnboardingInbound, User, stripe, notify,
    now: () => clock.now(),
    track: async (workspaceId, evt) => { tracked.push({ workspaceId, ...evt }); },
  };

  /** Seed an enrolled sidecar; `sub` overrides subscription fields. Returns the workspace id. */
  function seedWorkspace(sub = {}, extra = {}) {
    const workspaceId = newId();
    OnboardingState.seed({
      workspaceId,
      enrolled: true,
      subscription: { state: 'none', source: null, ...sub },
      steps: { business: { status: 'done' }, number: { status: 'in_progress' } },
      progress: { currentStep: 2, furthestStep: 2, status: 'in_progress' },
      ...extra,
    });
    return workspaceId;
  }
  const row = (workspaceId) => OnboardingState.rows.find((r) => String(r.workspaceId) === String(workspaceId));
  const inbound = (eventId) => OnboardingInbound.rows.find((r) => r._id === `stripe:${eventId}`);
  const metaFor = (workspaceId, planCode = 'standard') => ({ workspaceId, planCode, waflow_purpose: 'merchant_subscription' });
  return { clock, stripe, deps, seedWorkspace, row, inbound, metaFor, notifications, tracked, OnboardingState, OnboardingInbound, User, createFakeSend };
}

module.exports = { makeHarness, newId };
