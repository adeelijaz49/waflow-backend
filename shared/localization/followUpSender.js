'use strict';
// Sends the ARABIC version of a branching follow-up message (backlog A4). Called by server.js
// handleMessageNodeTap right where the English follow-up is sent (the single hunk S8, inside try/catch):
//
//   sendLocalizedFollowUp({ workspaceId, to, node, customer, enrollmentId })
//     -> null                                    the English send runs unchanged (the answer to every "not applicable")
//      | { language: 'ar', result }              sent; `result?.messages?.[0]?.id` is the wamid (dry-run included)
//      | { language: 'ar', error: Error }        the send itself failed: the handler records the row as failed and
//                                                never re-sends (no second, English message after an attempt)
// It NEVER throws and performs no database write (the CampaignMessage row is written by the existing handler).
//
// It returns an Arabic send only when ALL of:
//   * the kill switch is off and the workspace has arabic_enabled (cached flag read; checked first, so an
//     unflagged workspace costs nothing more);
//   * the target node is a follow-up (not an entry message), the customer has not opted out;
//   * the customer's resolved language (customer -> merchant default -> English) is Arabic: the CUSTOMER's
//     language, not the entry message's (simple and stable; there are no bilingual follow-ups);
//   * an Arabic LocalizedFlowNode row exists for the node AND flowFollowUps.evaluateVariant says it is
//     `sendable`: no structural issues, reviewed by a native reader, and not stale (the English text did not
//     change after it was written);
//   * the node is provably this workspace's (flowMessages.loadOwnedNode) and every {field} is fillable
//     (name falls back to the Arabic fallback name, never the English "there"; points; promotion item / price /
//     promo_name; {service} through enrollment -> booking -> service, all workspace-scoped);
//   * the rendered text fits (1024 code points with buttons, 4096 without).
// Payload: free-form (the customer's tap just opened the 24-hour window): the node's buttons in NODE order with
// the tap ids msgnode_<nodeId>_<position> and the Arabic labels (interactive reply buttons), or a plain text
// message when the node has no buttons. nextAction stays on the neutral MessageNode, so taps behave exactly as
// for English. Everything goes through transport.js (LOCALIZATION_SEND_MODE=dry_run honoured).
const { isObjectIdLike } = require('./scope');
const { resolveLanguage } = require('./languageDetect');
const { sanitizeValue, extractFields } = require('./mergeFields');
const { fillFields } = require('./sessionBidi');
const { charLength } = require('./metaConstraints');
const { loadOwnedNode } = require('./flowMessages');
const followUps = require('./flowFollowUps');
const bridge = require('./flowBridge');

function realDeps() {
  // Own properties only for what the bridge does not have; the bridge's lazy `ops` getter stays lazy
  // (shared/operations.js builds a Stripe client when loaded).
  return Object.assign(Object.create(bridge.realDeps()), {
    LocalizedFlowNode: require('../../models/LocalizedFlowNode'),
    FlowEnrollment: require('../../models/FlowEnrollment'),
  });
}

// {service} through the enrollment that produced this conversation. FlowEnrollment rows carry no workspaceId
// (existing engine), so the tenant proof is the flow they belong to.
async function serviceViaEnrollment(deps, workspaceId, enrollmentId) {
  if (!isObjectIdLike(enrollmentId)) return {};
  const enrollment = await deps.FlowEnrollment.findOne({ _id: enrollmentId }).select('flow sourceModel sourceRef').lean();
  if (!enrollment || enrollment.sourceModel !== 'Booking' || !isObjectIdLike(enrollment.flow)) return {};
  const flow = await deps.Flow.findOne({ _id: enrollment.flow, workspaceId }).select('_id').lean();
  if (!flow) return {};
  return bridge.serviceFieldValue(deps, { workspaceId, bookingId: enrollment.sourceRef });
}

function failure(err) {
  return { language: 'ar', error: err instanceof Error ? err : new Error(String((err && err.message) || err || 'Send failed')) };
}

// What the handler reads as `result?.messages?.[0]?.id`, whatever transport/Graph returned.
function normalise(deps, result) {
  if (result && typeof result === 'object' && Array.isArray(result.messages)) return result;
  let wamid;
  try { wamid = deps.transport.extractWamid(result); } catch (err) { wamid = undefined; }
  return { ...(result && typeof result === 'object' ? result : {}), messages: wamid ? [{ id: wamid }] : [] };
}

// Everything up to (not including) the send. -> null | { body, buttons: [{id, title}] }
async function prepare(args, deps) {
  const { workspaceId, to, node, customer, enrollmentId } = args || {};
  if (!isObjectIdLike(workspaceId) || typeof to !== 'string' || !to || !node || !customer) return null;
  if (!isObjectIdLike(node._id) || node.isEntryNode === true || customer.optedOut === true) return null;
  const ws = String(workspaceId);
  const nodeId = String(node._id);
  if (deps.settings.killSwitchOn() || !(await deps.settings.isArabicEnabled(ws))) return null;

  const stored = isObjectIdLike(customer._id)
    ? await deps.CustomerLanguage.findOne({ workspaceId: ws, customerId: customer._id }).select('language').lean()
    : null;
  const merchantDefault = (await deps.settings.getSettings(ws)).defaultCustomerLanguage;
  if (resolveLanguage(stored && stored.language, merchantDefault) !== 'ar') return null;

  const row = await deps.LocalizedFlowNode.findOne({ workspaceId: ws, messageNodeId: nodeId, language: 'ar' }).lean();
  if (!row) return null;
  const owned = await loadOwnedNode(deps, ws, nodeId);
  if (!owned || owned.node.isEntryNode === true) return null;
  const evaluation = followUps.evaluateVariant(owned.node, owned.owner, row);
  if (!evaluation.sendable) return null;

  const needed = new Set(extractFields(row.body));
  const owner = owned.owner || { kind: owned.node.ownerType === 'promotion' ? 'promotion' : 'flow' };
  const values = await bridge.collectValues(deps, {
    workspaceId: ws,
    owner,
    node: owned.node,
    customer,
    needed,
    fieldValuesFor: (set) => (set.has('service') ? serviceViaEnrollment(deps, ws, enrollmentId) : {}),
  });
  // The same session bidi rule as the journey / notice texts (sessionBidi.js): no direction mark next to a bold / italic * or _.
  const rendered = fillFields(row.body, (name) => {
    const raw = values ? values[name] : undefined;
    if (raw === undefined || raw === null || sanitizeValue(raw) === '') return null;
    const value = sanitizeValue(raw);
    return { value, isolate: !/^https?:\/\//i.test(value) };
  });
  if (rendered.missing.length) return null;
  const buttons = Array.isArray(owned.node.buttons) ? owned.node.buttons : [];
  if (charLength(rendered.text) > (buttons.length ? followUps.FOLLOWUP_LIMITS.bodyInteractive : followUps.FOLLOWUP_LIMITS.bodyText)) return null;

  const payloadButtons = [];
  for (const button of buttons) {
    const label = (row.buttons || []).find((b) => b.position === button.position);
    if (!label || !String(label.text || '').trim()) return null;
    payloadButtons.push({ id: `msgnode_${nodeId}_${button.position}`, title: String(label.text).trim() });
  }
  return { body: rendered.text, buttons: payloadButtons };
}

async function sendLocalizedFollowUp(args, injected) {
  let plan;
  let deps = injected;
  try {
    if (!deps) deps = realDeps();
    plan = await prepare(args, deps);
  } catch (err) {
    ((deps && deps.log) || console.error)('localized follow-up skipped (the English message is sent):', err && err.message);
    return null;
  }
  if (!plan) return null;
  // From here on a failure is OUR answer ({ error }): the caller must not send English after an attempt.
  try {
    const result = plan.buttons.length
      ? await deps.transport.sendButtons(args.to, { body: plan.body, buttons: plan.buttons })
      : await deps.transport.sendText(args.to, plan.body);
    return { language: 'ar', result: normalise(deps, result) };
  } catch (err) {
    return failure(err);
  }
}

module.exports = { sendLocalizedFollowUp, realDeps };
