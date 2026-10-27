'use strict';
// "Which customer (workspace) is this WhatsApp work for?" - carried through async calls with AsyncLocalStorage so
// utils/whatsapp.js can pick that customer's own WhatsApp number (utils/waTenant.js) without every sender having to
// pass a workspace id down. Deliberately separate from shared/localization/outbound.js's store (that one only exists for
// Arabic-flagged workspaces).
//
//   run(workspaceId, fn[, opts])   run fn inside a context (Express: middleware/requireAuth.js wraps next() in it)
//   enter(workspaceId[, opts])     set the context for the rest of the current async chain (webhook events, scheduler sweeps)
//   runLike(workspaceId, fn)       run fn for ANOTHER workspace inside work in progress, answering the way that work is answering
//   runPlatform(fn)                force the PLATFORM number for fn (OTP login, team invites: messages that belong to WaFlow itself)
//   currentWorkspaceId()           the workspace id string, or null (no context, or platform forced)
//   isPlatformForced()             true inside runPlatform
//   isViaPlatformNumber()          true when the work in progress arrived on the SHARED number (see below)
//
// opts.viaPlatformNumber: a webhook event that arrived on the shared WaFlow number belongs to a customer, but the customer's
// 24-hour window is with THAT number: the answer must leave from it even when the customer has a number of its own by now (a
// message from the customer's own number would be accepted by WhatsApp and refused a moment later). The workspace is kept (its
// settings, its language), only the sender is the shared number.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const idOf = (workspaceId) => (workspaceId ? String(workspaceId) : null);
const storeFor = (workspaceId, opts) => ({ workspaceId: idOf(workspaceId), platform: false, viaPlatform: !!(opts && opts.viaPlatformNumber) });

function run(workspaceId, fn, opts) {
  return als.run(storeFor(workspaceId, opts), fn);
}
function enter(workspaceId, opts) {
  als.enterWith(storeFor(workspaceId, opts));
}
function runPlatform(fn) {
  return als.run({ workspaceId: null, platform: true, viaPlatform: false }, fn);
}
function current() {
  return als.getStore() || null;
}
function currentWorkspaceId() {
  const s = als.getStore();
  return s && !s.platform ? s.workspaceId : null;
}
function isPlatformForced() {
  const s = als.getStore();
  return !!(s && s.platform);
}
function isViaPlatformNumber() {
  const s = als.getStore();
  return !!(s && !s.platform && s.viaPlatform);
}
// A context for another workspace (the consent tap handler works in the workspace of the message that was tapped) that keeps
// answering the way the work in progress is answering: from the shared number when that is where the event came in.
function runLike(workspaceId, fn) {
  const s = als.getStore();
  return run(workspaceId, fn, { viaPlatformNumber: !!(s && (s.viaPlatform || s.platform)) });
}

module.exports = { run, enter, runLike, runPlatform, current, currentWorkspaceId, isPlatformForced, isViaPlatformNumber };
