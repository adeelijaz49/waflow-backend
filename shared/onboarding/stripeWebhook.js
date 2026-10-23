'use strict';
// POST /stripe-billing-webhook (DB design 4.9, steps 1-7). A NEW endpoint with its own signing secret;
// the existing /stripe-webhook is never touched and payment_intent.* is never handled here.
// server.js (hunk E1 via earlyMounts) registers it with express.raw, so `req.body` is a Buffer.
//
//   1. verify the signature on the RAW body against every configured secret   -> 400 / 503
//   2. claim OnboardingInbound _id 'stripe:<event id>' (idempotency, re-claim of failed / stale rows)
//   3. allow-list of event types
//   4. resolve the workspace (our metadata, then the stored ids; NEVER by e-mail)
//   5. canonical state by subscriptions.retrieve (payload fallback only for customer.subscription.*)
//   6. ordering (stale payload-only events are ignored)
//   7. billing.applyStripeState + notifications; mark the row done (failed -> 500 so Stripe retries)
// Never logs a payload body or customer details: event ids and types only.
const config = require('./config');
const adapter = require('./stripeAdapter');
const { OnbError, respond } = require('./errors');

const EVENT_TYPES = Object.freeze([
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'invoice.paid',
  'invoice.payment_succeeded',
  'invoice.payment_failed',
  'invoice.payment_action_required',
]);
const PROCESSING_STALE_MS = 2 * 60 * 1000;
const ID_RE = /^[0-9a-f]{24}$/i;

const MODEL_PATHS = { OnboardingInbound: '../../models/OnboardingInbound', OnboardingState: '../../models/OnboardingState' };
function M(deps, name) { return deps && deps[name] ? deps[name] : require(MODEL_PATHS[name]); }
function nowOf(deps) { return deps && typeof deps.now === 'function' ? deps.now() : new Date(); }
function billingOf(deps) { return (deps && deps.billing) || require('./billing'); }
function notifyOf(deps) {
  if (deps && typeof deps.notify === 'function') return deps.notify;
  return require('./notifications').notify;
}
function modified(res) { return !!(res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified)); }
function safeCode(err) {
  for (const c of [err && err.code, err && err.type, err && err.name]) {
    if (typeof c === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(c)) return c;
  }
  return 'ERROR';
}

// ── Step 2: claim ───────────────────────────────────────────────────────────

async function claimEvent(event, deps) {
  const Inbound = M(deps, 'OnboardingInbound');
  const id = `stripe:${event.id}`;
  const now = nowOf(deps);
  try {
    await Inbound.create({ _id: id, source: 'stripe', type: String(event.type || '').slice(0, 80), status: 'processing', attempts: 1, startedAt: now });
    return { claimed: true, id };
  } catch (err) {
    if (!(err && err.code === 11000)) throw err;
  }
  const row = await Inbound.findOne({ _id: id }).lean();
  if (!row) return { claimed: false, id, outcome: 'in_progress' };
  if (['done', 'ignored', 'unmatched'].includes(row.status)) return { claimed: false, id, outcome: 'duplicate' };
  const cutoff = new Date(now.getTime() - PROCESSING_STALE_MS);
  if (row.status === 'processing' && row.startedAt && new Date(row.startedAt) >= cutoff) return { claimed: false, id, outcome: 'in_progress' };
  const patch = { $set: { status: 'processing', startedAt: now }, $inc: { attempts: 1 }, $unset: { errorCode: 1, finishedAt: 1 } };
  // two atomic attempts (a failed row, then a stale processing row): whoever modifies the row owns it
  let res = await Inbound.updateOne({ _id: id, status: 'failed' }, patch);
  if (!modified(res)) {
    res = await Inbound.updateOne({ _id: id, status: 'processing', $or: [{ startedAt: { $lt: cutoff } }, { startedAt: null }] }, patch);
  }
  return modified(res) ? { claimed: true, id, reclaimed: true } : { claimed: false, id, outcome: 'in_progress' };
}

async function finishRow(deps, id, fields) {
  try {
    await M(deps, 'OnboardingInbound').updateOne({ _id: id }, { $set: { ...fields, finishedAt: nowOf(deps) } });
  } catch (err) {
    config.safeLog('warn', '[onboarding] could not close the inbound row:', safeCode(err));
  }
}

// ── Step 4: resolve the workspace ───────────────────────────────────────────

/** The sidecar of a workspace id (valid ObjectId) or null. */
async function sidecarById(deps, workspaceId) {
  if (!ID_RE.test(String(workspaceId || ''))) return null;
  const doc = await M(deps, 'OnboardingState').findOne({ workspaceId: String(workspaceId) }).select('workspaceId enrolled').lean();
  return doc || null;
}
async function sidecarBy(deps, path, value) {
  if (!value) return null;
  const doc = await M(deps, 'OnboardingState').findOne({ [path]: value }).select('workspaceId enrolled').lean();
  return doc || null;
}
const found = (doc, extra) => ({ workspaceId: String(doc.workspaceId), enrolled: doc.enrolled !== false, ...(extra || {}) });

/**
 * @returns {Promise<{workspaceId:string, enrolled:boolean, subscription?:object}|{outcome:'ignored_not_ours'|'unmatched'}>}
 */
async function resolveWorkspace(event, deps) {
  const type = event.type;
  const obj = (event.data && event.data.object) || {};

  if (type === 'checkout.session.completed') {
    const md = obj.metadata || {};
    if ((obj.mode && obj.mode !== 'subscription') || md.waflow_purpose !== adapter.PURPOSE) return { outcome: 'ignored_not_ours' };
    const ref = String(obj.client_reference_id || '');
    if (md.workspaceId && String(md.workspaceId) !== ref) return { outcome: 'unmatched' };
    const doc = await sidecarById(deps, ref);
    return doc ? found(doc) : { outcome: 'unmatched' };
  }

  if (type.startsWith('customer.subscription.')) {
    const md = obj.metadata || {};
    const ours = md.waflow_purpose === adapter.PURPOSE;
    if (ours) {
      const byMeta = await sidecarById(deps, md.workspaceId);
      if (byMeta) return found(byMeta);
    }
    const bySub = await sidecarBy(deps, 'subscription.stripe.subscriptionId', adapter.idOf(obj.id));
    if (bySub) return found(bySub);
    const byCustomer = await sidecarBy(deps, 'subscription.stripe.customerId', adapter.readCustomerId(obj));
    if (byCustomer) return found(byCustomer);
    return { outcome: ours ? 'unmatched' : 'ignored_not_ours' };
  }

  // invoice.*: through the subscription id (both API shapes)
  const subId = adapter.readSubscriptionIdFromInvoice(obj);
  if (!subId) return { outcome: 'ignored_not_ours' };
  const bySub = await sidecarBy(deps, 'subscription.stripe.subscriptionId', subId);
  if (bySub) return found(bySub);
  const byCustomer = await sidecarBy(deps, 'subscription.stripe.customerId', adapter.readCustomerId(obj));
  if (byCustomer) return found(byCustomer);
  // First invoice before any checkout/subscription event reached us: ask Stripe who this subscription belongs to.
  const stripe = adapter.getStripeClient(deps);
  const sub = await stripe.subscriptions.retrieve(subId); // a failure propagates: 500, Stripe retries
  const md = (sub && sub.metadata) || {};
  if (md.waflow_purpose !== adapter.PURPOSE) return { outcome: 'ignored_not_ours' };
  const byMeta = await sidecarById(deps, md.workspaceId);
  return byMeta ? found(byMeta, { subscription: sub }) : { outcome: 'unmatched' };
}

// ── Steps 5-7 ───────────────────────────────────────────────────────────────

async function notifySafe(deps, args, sink) {
  try {
    const r = await notifyOf(deps)(args);
    if (r && r.emailPromise && typeof r.emailPromise.then === 'function') sink.push(r.emailPromise);
    return r;
  } catch (err) {
    config.safeLog('warn', '[onboarding] billing notification failed:', safeCode(err));
    return null;
  }
}

function periodKey(sub, event) {
  const d = adapter.readPeriodEnd(sub);
  return d ? String(Math.floor(d.getTime() / 1000)) : String(Number.isFinite(event.created) ? event.created : 'na');
}

/**
 * Epoch of a state change (review R7-04): the time of the Stripe event that CAUSED it. Only the event that wins the state transition notifies, so a
 * re-delivery of that event (same id, same time) is one key, while a later activation or cancellation of the SAME subscription in the same period
 * (cancelled then reactivated, past due then paid) is a new key and tells the merchant again.
 */
function eventEpoch(event) {
  return String(Number.isFinite(event.created) ? event.created : 'na');
}

/** Notifications of a processed event (payment_failed / subscription_active / subscription_cancelled). */
async function sendNotifications(event, ws, sub, res, deps, emailPromises) {
  if (!ws.enrolled || !res || res.ignored || !res.after) return [];
  const subId = adapter.idOf(sub && sub.id) || 'unknown';
  const sent = [];
  const base = { workspaceId: ws.workspaceId, email: true };

  if (event.type === 'invoice.payment_failed') {
    if (res.after.state === 'past_due' || res.after.state === 'pending') {
      const invId = adapter.idOf(event.data && event.data.object && event.data.object.id) || `evt-${event.id}`;
      const r = await notifySafe(deps, { ...base, kind: 'payment_failed', severity: 'action', dedupeKey: `sub:past_due:${subId}:${invId}`, params: {}, actionPath: '/setup' }, emailPromises);
      sent.push({ kind: 'payment_failed', created: !!(r && r.created) });
    }
    return sent;
  }
  if (res.after.state === 'active' && res.before && res.before.state !== 'active' && res.after.source === 'stripe') {
    const r = await notifySafe(deps, { ...base, kind: 'subscription_active', severity: 'success', dedupeKey: `sub:active:${subId}:${periodKey(sub, event)}:${eventEpoch(event)}`, params: {}, actionPath: '/setup' }, emailPromises);
    sent.push({ kind: 'subscription_active', created: !!(r && r.created) });
  }
  if (res.after.state === 'cancelled' && res.before && res.before.state !== 'cancelled') {
    const r = await notifySafe(deps, { ...base, kind: 'subscription_cancelled', severity: 'warning', dedupeKey: `sub:cancelled:${subId}:${periodKey(sub, event)}:${eventEpoch(event)}`, params: {}, actionPath: '/setup' }, emailPromises);
    sent.push({ kind: 'subscription_cancelled', created: !!(r && r.created) });
  }
  return sent;
}

async function handleResolved(event, ws, deps) {
  const billing = billingOf(deps);
  const obj = (event.data && event.data.object) || {};
  const base = { eventId: event.id, eventCreated: Number.isFinite(event.created) ? event.created : undefined };
  const emailPromises = [];
  const stripe = () => adapter.getStripeClient(deps);

  let sub;
  let ctx;
  if (event.type === 'checkout.session.completed') {
    await billing.capturePrefill(ws.workspaceId, adapter.extractPrefill(obj), deps);
    const paid = obj.payment_status === 'paid' || obj.payment_status === 'no_payment_required';
    const subId = adapter.idOf(obj.subscription);
    if (!paid || !subId) {
      await recordPendingSession(ws.workspaceId, obj, deps);
      return { outcome: 'processed', detail: 'session_unpaid', emailPromises };
    }
    sub = await stripe().subscriptions.retrieve(subId);
    ctx = { ...base, canonical: true, planCode: obj.metadata && obj.metadata.planCode, checkoutSessionId: adapter.idOf(obj.id) || undefined };
  } else if (event.type === 'customer.subscription.deleted') {
    sub = { ...obj, status: 'canceled' };
    ctx = { ...base, canonical: false, deleted: true };
  } else if (event.type.startsWith('customer.subscription.')) {
    try {
      sub = ws.subscription || await stripe().subscriptions.retrieve(adapter.idOf(obj.id));
      ctx = { ...base, canonical: true };
    } catch (err) {
      config.safeLog('warn', '[onboarding] subscriptions.retrieve failed, using the event payload:', event.type, safeCode(err));
      sub = obj;
      ctx = { ...base, canonical: false };
    }
  } else {
    const subId = adapter.readSubscriptionIdFromInvoice(obj);
    sub = ws.subscription || await stripe().subscriptions.retrieve(subId);
    ctx = { ...base, canonical: true };
    if (event.type === 'invoice.payment_failed') {
      const fe = obj.last_finalization_error;
      ctx.failure = { code: fe && typeof fe.code === 'string' ? fe.code.toLowerCase() : undefined };
    }
  }

  const res = await billing.applyStripeState(ws.workspaceId, sub, ctx, deps);
  const notified = await sendNotifications(event, ws, sub, res, deps, emailPromises);
  return { outcome: 'processed', changed: !!res.changed, ignored: res.ignored, state: res.after && res.after.state, notified, emailPromises };
}

/** An unpaid / async Checkout Session: remember the ids, keep the workspace `pending` (no subscription id yet). */
async function recordPendingSession(workspaceId, session, deps) {
  const State = M(deps, 'OnboardingState');
  const doc = await State.findOne({ workspaceId }).select('subscription').lean();
  const st = (doc && doc.subscription && doc.subscription.stripe) || {};
  const set = {};
  const customerId = adapter.readCustomerId(session);
  if (customerId) set['subscription.stripe.customerId'] = customerId;
  const sessionId = adapter.idOf(session.id);
  if (sessionId) set['subscription.stripe.checkoutSessionId'] = sessionId;
  if (!st.checkoutStartedAt) set['subscription.stripe.checkoutStartedAt'] = nowOf(deps);
  if (Object.keys(set).length) await State.updateOne({ workspaceId }, { $set: set });
  const stateMod = (deps && deps.state) || require('./state');
  const sd = { now: () => nowOf(deps) };
  if (deps && deps.OnboardingState) sd.OnboardingState = deps.OnboardingState;
  if (deps && typeof deps.track === 'function') sd.track = deps.track;
  await stateMod.recomputeSubscription(workspaceId, { now: nowOf(deps) }, Object.assign(sd, (deps && deps.stateDeps) || {}));
}

/**
 * Process one VERIFIED event (steps 2-7). Throws after marking the inbound row `failed` (the handler answers 500).
 * @param {object} event verified Stripe event
 * @param {object} [deps] { OnboardingInbound, OnboardingState, stripe, billing, state, notify, now, track }
 * @returns {Promise<{outcome:string, [k:string]:any}>} outcome: processed | ignored | ignored_not_ours | unmatched | duplicate | in_progress
 */
async function processEvent(event, deps = {}) {
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return { outcome: 'ignored', detail: 'malformed' };
  const claim = await claimEvent(event, deps);
  if (!claim.claimed) return { outcome: claim.outcome };
  try {
    if (!EVENT_TYPES.includes(event.type)) {
      await finishRow(deps, claim.id, { status: 'ignored', outcome: 'ignored' });
      return { outcome: 'ignored' };
    }
    const ws = await resolveWorkspace(event, deps);
    if (ws.outcome === 'ignored_not_ours') {
      await finishRow(deps, claim.id, { status: 'ignored', outcome: 'ignored_not_ours' });
      return { outcome: 'ignored_not_ours' };
    }
    if (ws.outcome === 'unmatched') {
      await finishRow(deps, claim.id, { status: 'unmatched', outcome: 'unmatched' });
      config.safeLog('warn', '[onboarding] stripe event without a matching workspace:', event.type, event.id);
      return { outcome: 'unmatched' };
    }
    const out = await handleResolved(event, ws, deps);
    await finishRow(deps, claim.id, { status: 'done', outcome: out.outcome, workspaceId: ws.workspaceId });
    return out;
  } catch (err) {
    await finishRow(deps, claim.id, { status: 'failed', errorCode: safeCode(err) });
    config.safeLog('error', '[onboarding] stripe event failed:', event.type, event.id, safeCode(err));
    throw err;
  }
}

/**
 * Express handler factory. `deps` are the processEvent deps plus { secrets?, stripe? } for tests.
 * @param {object} [deps]
 * @returns {(req:object, res:object, next?:Function) => Promise<void>}
 */
function createHandler(deps = {}) {
  return async function stripeBillingWebhook(req, res, next) {
    if (!config.enabled()) {
      if (typeof next === 'function') return next('route');
      return res.status(404).json({ error: 'Not found' });
    }
    const secrets = deps.secrets || config.stripeWebhookSecrets();
    if (!secrets.length) return respond(res, new OnbError('CHECKOUT_NOT_CONFIGURED'));
    let event;
    try {
      const signature = req.headers && req.headers['stripe-signature'];
      event = adapter.verifyEvent(req.body, signature, { secrets, stripe: deps.stripe });
    } catch (err) {
      config.safeLog('warn', '[onboarding] stripe billing webhook rejected:', safeCode(err));
      return res.status(400).json({ error: 'Invalid signature', code: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    try {
      const out = await processEvent(event, deps);
      return res.status(200).json({ received: true, outcome: out.outcome });
    } catch (_) {
      return res.status(500).json({ error: 'Processing failed', code: 'INTERNAL_ERROR' });
    }
  };
}

const handler = createHandler();

module.exports = { handler, createHandler, processEvent, EVENT_TYPES, resolveWorkspace, claimEvent };
