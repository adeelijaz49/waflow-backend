'use strict';
// Stripe billing of the onboarding flow (DB design 4.9): checkout creation, billing portal, the one
// place that turns Stripe facts into subscription.stripe.* (applyStripeState), and reconciliation
// (on demand from the browser, and a bounded sweep for the scheduler). The browser never decides
// anything: every state change comes from a verified webhook or from asking Stripe with the secret key.
// Every external effect is injectable through `deps` (stripe client, models, state module, now, track);
// models and the Stripe client are created lazily. Nothing runs at require time.
const config = require('./config');
const adapter = require('./stripeAdapter');
const gate = require('./gate');
const { OnbError, isOnbError } = require('./errors');

const MODEL_PATHS = {
  OnboardingState: '../../models/OnboardingState',
  User: '../../models/User',
};
const ID_RE = /^[0-9a-f]{24}$/i;
const PENDING_RECHECK_MS = 30 * 60 * 1000;
const DAILY_RECHECK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SWEEP_LIMIT = 25;

/** Resolve a model: injected first, real (lazily required) otherwise. */
function M(deps, name) {
  if (deps && deps[name]) return deps[name];
  return require(MODEL_PATHS[name]);
}
function stateMod(deps) { return (deps && deps.state) || require('./state'); }
function nowOf(deps) { return deps && typeof deps.now === 'function' ? deps.now() : new Date(); }
/** The `deps` handed to state.js (models + now + track), plus any explicit override. */
function stateDeps(deps, now) {
  const d = {};
  if (deps && deps.OnboardingState) d.OnboardingState = deps.OnboardingState;
  if (deps && typeof deps.track === 'function') d.track = deps.track;
  d.now = () => now || nowOf(deps);
  return Object.assign(d, (deps && deps.stateDeps) || {});
}
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }
function modified(res) { return !!(res && (res.modifiedCount !== undefined ? res.modifiedCount : res.nModified)); }

/**
 * Raised by createCheckout when a live subscription already exists: the catalogue code SUBSCRIPTION_EXISTS (HTTP 409,
 * nextStep billing); the JSON body carries `subscription` ({state, source, retry}) as an extra top-level key.
 */
class SubscriptionExistsError extends OnbError {
  constructor(sub) {
    super('SUBSCRIPTION_EXISTS', { extra: { subscription: sub } });
    this.name = 'SubscriptionExistsError';
    this.subscription = sub;
  }
}

/** Log a Stripe client failure by type/code only (never the message: it can echo ids and customer details). */
function logStripeFailure(where, err) {
  config.safeLog('warn', `[onboarding] stripe ${where} failed:`, err && (err.type || err.name), err && err.code, err && err.statusCode);
}

/** Retry flags for a subscription state (all false when active). */
function retryFor(state) {
  const d = gate.subscriptionDenial(state);
  return d ? { ...d.retry } : { checkout: false, billingPortal: false, reconnect: false };
}
/** The `subscription` object of the billing responses. */
function summarize(state, source) {
  return { state: state || 'none', source: source || null, retry: retryFor(state || 'none') };
}
function subOf(doc) {
  const s = (doc && doc.subscription) || {};
  return { state: s.state || 'none', source: s.source || null };
}

async function retrieveSubscription(stripe, id, where) {
  try {
    return await stripe.subscriptions.retrieve(id);
  } catch (err) {
    logStripeFailure(where || 'subscriptions.retrieve', err);
    throw new OnbError('STRIPE_ERROR', { cause: err });
  }
}

/**
 * The single writer of subscription.stripe.* : one atomic updateOne of the derived fields, then
 * state.recomputeSubscription (B0) derives the effective state and writes the transition (and the
 * payment_state analytics event: do NOT write another one here).
 * Guards: an unknown Stripe status leaves the stored state untouched; a payload-only (non-canonical,
 * non-deleted) event older than the last applied one is ignored; an event about a DIFFERENT
 * subscription than the stored live one is ignored unless it is an active/trialing one replacing a
 * non-active one (a late `deleted` of an old subscription must not cancel the new one).
 * @param {string} workspaceId
 * @param {object} stripeSub Stripe subscription object
 * @param {{eventId?:string, eventCreated?:number, canonical?:boolean, deleted?:boolean, planCode?:string,
 *   checkoutSessionId?:string, failure?:{code?:string}}} [ctx]
 * @param {object} [deps]
 * @returns {Promise<{changed:boolean, before:object|null, after:object|null, ignored?:string}>}
 */
async function applyStripeState(workspaceId, stripeSub, ctx = {}, deps = {}) {
  const id = String(workspaceId || '');
  if (!ID_RE.test(id)) throw new OnbError('VALIDATION_FAILED', { details: { reason: 'INVALID_WORKSPACE_ID' } });
  const State = M(deps, 'OnboardingState');
  const now = nowOf(deps);
  const sub = stripeSub && typeof stripeSub === 'object' ? stripeSub : {};
  const c = ctx || {};

  const doc = await State.findOne({ workspaceId: id }).select('subscription').lean();
  if (!doc) return { changed: false, before: null, after: null, ignored: 'NOT_ENROLLED' };
  const current = subOf(doc);
  const stored = (doc.subscription && doc.subscription.stripe) || {};

  const subId = adapter.idOf(sub.id);
  const raw = c.deleted ? 'canceled' : (typeof sub.status === 'string' ? sub.status.trim().toLowerCase().slice(0, 40) : '');
  const storedRaw = String(stored.status || '').toLowerCase();

  if (subId && stored.subscriptionId && stored.subscriptionId !== subId && !adapter.TERMINAL_STATUSES.includes(storedRaw)) {
    const storedActive = adapter.mapStripeStatus(storedRaw, {}).state === 'active';
    const upgrade = (raw === 'active' || raw === 'trialing') && !storedActive;
    if (!upgrade) return { changed: false, before: current, after: current, ignored: 'OTHER_SUBSCRIPTION' };
  }
  if (c.canonical === false && !c.deleted && Number.isFinite(c.eventCreated)
      && Number.isFinite(stored.lastEventCreated) && c.eventCreated < stored.lastEventCreated) {
    return { changed: false, before: current, after: current, ignored: 'STALE_EVENT' };
  }

  const set = { 'subscription.stripe.lastSyncedAt': now };
  if (typeof c.eventId === 'string' && c.eventId) set['subscription.stripe.lastEventId'] = c.eventId.slice(0, 80);
  if (Number.isFinite(c.eventCreated)) {
    set['subscription.stripe.lastEventCreated'] = Math.max(Number.isFinite(stored.lastEventCreated) ? stored.lastEventCreated : 0, c.eventCreated);
  }

  const hasPm = adapter.hasDefaultPaymentMethod(sub);
  const mapped = adapter.mapStripeStatus(raw, { hasDefaultPaymentMethod: hasPm, acceptTrialing: config.acceptTrialing() });
  if (!mapped.state) {
    config.safeLog('warn', '[onboarding] unknown stripe status:', raw || '(missing)');
    await State.updateOne({ workspaceId: id }, { $set: set });
    return { changed: false, before: current, after: current, ignored: 'UNKNOWN_STATUS' };
  }

  set['subscription.stripe.status'] = raw;
  set['subscription.stripe.hasDefaultPaymentMethod'] = hasPm;
  const customerId = adapter.readCustomerId(sub);
  if (customerId) set['subscription.stripe.customerId'] = customerId;
  if (subId) set['subscription.stripe.subscriptionId'] = subId;
  const priceId = adapter.readPriceId(sub);
  if (priceId) set['subscription.stripe.priceId'] = priceId;
  const prices = config.stripePrices();
  const planCode = adapter.cleanPlanCode(c.planCode)
    || adapter.cleanPlanCode(sub.metadata && sub.metadata.planCode)
    || (priceId ? Object.keys(prices).find((k) => prices[k] === priceId) : null);
  if (planCode) set['subscription.stripe.planCode'] = planCode;
  const periodEnd = adapter.readPeriodEnd(sub);
  if (periodEnd) set['subscription.stripe.currentPeriodEnd'] = periodEnd;
  if (typeof sub.cancel_at_period_end === 'boolean') set['subscription.stripe.cancelAtPeriodEnd'] = sub.cancel_at_period_end;
  if (typeof c.checkoutSessionId === 'string' && c.checkoutSessionId) set['subscription.stripe.checkoutSessionId'] = c.checkoutSessionId.slice(0, 200);
  if (raw === 'incomplete_expired') set['subscription.stripe.lastPaymentFailedAt'] = now;
  if (c.failure) {
    set['subscription.stripe.lastPaymentFailedAt'] = now;
    const code = c.failure.code && /^[a-z0-9_]{1,64}$/.test(c.failure.code) ? c.failure.code : 'payment_failed';
    set['subscription.stripe.lastPaymentFailureCode'] = code;
  }

  await State.updateOne({ workspaceId: id }, { $set: set });
  const rec = await stateMod(deps).recomputeSubscription(id, { now }, stateDeps(deps, now));
  return { changed: !!rec.changed, before: rec.before, after: rec.after };
}

/**
 * Store the Step-1 pre-fill captured from a Checkout Session (spec 1b.6). Fields that are absent are not touched.
 * @returns {Promise<boolean>} whether anything was written
 */
async function capturePrefill(workspaceId, prefill, deps = {}) {
  const p = prefill || {};
  const set = {};
  if (p.email) set['prefill.email'] = p.email;
  if (p.businessName) set['prefill.businessName'] = p.businessName;
  if (p.planCode) set['prefill.planCode'] = p.planCode;
  if (!Object.keys(set).length) return false;
  set['prefill.source'] = 'stripe_checkout';
  set['prefill.capturedAt'] = nowOf(deps);
  await M(deps, 'OnboardingState').updateOne({ workspaceId: String(workspaceId) }, { $set: set });
  return true;
}

// ── Checkout ────────────────────────────────────────────────────────────────

/** A live (non-terminal) subscription or an active state: a second checkout would double-bill. */
function existingSubscription(doc) {
  const s = (doc && doc.subscription) || {};
  const cur = subOf(doc);
  if (cur.state === 'active') return cur;
  const st = s.stripe || {};
  if (st.subscriptionId && st.status && !adapter.TERMINAL_STATUSES.includes(String(st.status).toLowerCase())) return cur;
  return null;
}

async function knownEmail(doc, userId, deps) {
  const fromPrefill = adapter.cleanEmail(doc && doc.prefill && doc.prefill.email);
  if (fromPrefill) return fromPrefill;
  if (!userId || !ID_RE.test(String(userId))) return null;
  try {
    const user = await M(deps, 'User').findById(String(userId)).select('email').lean();
    return adapter.cleanEmail(user && user.email);
  } catch (_) {
    return null;
  }
}

function httpsUrl(value) {
  return typeof value === 'string' && /^https:\/\/[^\s]+$/i.test(value) ? value : null;
}

/**
 * Create a Stripe Checkout Session for the owner's workspace (DB 4.9). The price comes ONLY from
 * config.stripePrices() (a plan code the client sends is validated against it, never a price id).
 * Writes stripe.checkoutSessionId/checkoutStartedAt; the state becomes `pending` only when it was `none`
 * (via state.recomputeSubscription). A started checkout is not a payment.
 * @param {{workspaceId:string, userId?:string, planCode:string}} args
 * @param {object} [deps]
 * @returns {Promise<{url:string}>}
 * @throws {OnbError} CHECKOUT_NOT_CONFIGURED | PLAN_UNKNOWN | STRIPE_ERROR | ONBOARDING_NOT_AVAILABLE
 * @throws {SubscriptionExistsError} (409) an active or live subscription already exists
 */
async function createCheckout({ workspaceId, userId, planCode } = {}, deps = {}) {
  if (!config.checkoutEnabled()) throw new OnbError('CHECKOUT_NOT_CONFIGURED');
  const prices = config.stripePrices();
  if (!Object.keys(prices).length) throw new OnbError('CHECKOUT_NOT_CONFIGURED');
  const code = typeof planCode === 'string' ? planCode.trim() : '';
  if (!code || !hasOwn(prices, code)) throw new OnbError('PLAN_UNKNOWN');
  const stripe = adapter.getStripeClient(deps);

  const doc = await stateMod(deps).ensureState(workspaceId, stateDeps(deps));
  const existing = existingSubscription(doc);
  if (existing) throw new SubscriptionExistsError(summarize(existing.state, existing.source));

  const email = await knownEmail(doc, userId, deps);
  const params = adapter.buildCheckoutParams({ workspaceId: String(workspaceId), planCode: code, priceId: prices[code], email });
  const now = nowOf(deps);
  const idempotencyKey = `onb-checkout-${workspaceId}-${code}-${Math.floor(now.getTime() / 60000)}`;
  let session;
  try {
    session = await stripe.checkout.sessions.create(params, { idempotencyKey });
  } catch (err) {
    logStripeFailure('checkout.sessions.create', err);
    throw new OnbError(adapter.classifyStripeError(err) === 'config' ? 'CHECKOUT_NOT_CONFIGURED' : 'STRIPE_ERROR', { cause: err });
  }
  const url = httpsUrl(session && session.url);
  if (!url || !adapter.idOf(session.id)) {
    config.safeLog('warn', '[onboarding] stripe checkout session had no usable url');
    throw new OnbError('STRIPE_ERROR');
  }

  try {
    await M(deps, 'OnboardingState').updateOne({ workspaceId: String(workspaceId) }, {
      $set: { 'subscription.stripe.checkoutSessionId': session.id, 'subscription.stripe.checkoutStartedAt': now },
    });
    // none -> pending happens here (no Stripe facts yet + checkoutStartedAt), through the one state writer
    await stateMod(deps).recomputeSubscription(String(workspaceId), { now }, stateDeps(deps, now));
  } catch (err) {
    // The session exists and the webhook resolves by metadata: never lose the URL over bookkeeping.
    config.safeLog('warn', '[onboarding] could not record the checkout start:', err && err.code, err && err.message);
  }
  return { url };
}

// ── Portal ──────────────────────────────────────────────────────────────────

/**
 * Stripe billing-portal session for "Update your payment to continue". Needs a stored customer id.
 * @param {{workspaceId:string}} args
 * @param {object} [deps]
 * @returns {Promise<{url:string}>}
 * @throws {OnbError} BILLING_PORTAL_UNAVAILABLE (disabled / no customer / portal not configured in Stripe) | STRIPE_ERROR
 */
async function createPortal({ workspaceId } = {}, deps = {}) {
  if (!config.billingPortalEnabled()) throw new OnbError('BILLING_PORTAL_UNAVAILABLE');
  const doc = await stateMod(deps).ensureState(workspaceId, stateDeps(deps));
  const customerId = adapter.idOf(doc.subscription && doc.subscription.stripe && doc.subscription.stripe.customerId);
  if (!customerId) throw new OnbError('BILLING_PORTAL_UNAVAILABLE');
  let stripe;
  try { stripe = adapter.getStripeClient(deps); } catch (_) { throw new OnbError('BILLING_PORTAL_UNAVAILABLE'); }
  let session;
  try {
    session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${config.frontendUrl()}/setup` });
  } catch (err) {
    logStripeFailure('billingPortal.sessions.create', err);
    throw new OnbError(adapter.classifyStripeError(err) === 'config' ? 'BILLING_PORTAL_UNAVAILABLE' : 'STRIPE_ERROR', { cause: err });
  }
  const url = httpsUrl(session && session.url);
  if (!url) throw new OnbError('STRIPE_ERROR');
  return { url };
}

// ── Reconcile ───────────────────────────────────────────────────────────────

async function touchSynced(workspaceId, deps) {
  await M(deps, 'OnboardingState').updateOne({ workspaceId }, { $set: { 'subscription.stripe.lastSyncedAt': nowOf(deps) } });
}

/**
 * Re-read the stored Stripe subscription (or, before one exists, the stored Checkout Session) FROM STRIPE and
 * apply it through applyStripeState. Nothing to reconcile = no Stripe call.
 * @param {string} workspaceId
 * @param {object} doc lean OnboardingState
 * @param {object} deps
 * @returns {Promise<{changed:boolean, noop:boolean, after:{state:string,source:string|null}, ignored?:string}>}
 */
async function reconcileOne(workspaceId, doc, deps) {
  const ws = String(workspaceId);
  const cur = subOf(doc);
  const st = (doc.subscription && doc.subscription.stripe) || {};

  if (adapter.idOf(st.subscriptionId)) {
    const stripe = adapter.getStripeClient(deps);
    const sub = await retrieveSubscription(stripe, st.subscriptionId);
    const r = await applyStripeState(ws, sub, { canonical: true }, deps);
    return { changed: r.changed, noop: false, after: r.after || cur, ...(r.ignored ? { ignored: r.ignored } : {}) };
  }

  if (adapter.idOf(st.checkoutSessionId)) {
    const stripe = adapter.getStripeClient(deps);
    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(st.checkoutSessionId);
    } catch (err) {
      logStripeFailure('checkout.sessions.retrieve', err);
      throw new OnbError('STRIPE_ERROR', { cause: err });
    }
    const ours = session && session.metadata && session.metadata.waflow_purpose === adapter.PURPOSE
      && String(session.client_reference_id || '') === ws;
    if (!ours) { await touchSynced(ws, deps); return { changed: false, noop: false, after: cur, ignored: 'NOT_OURS' }; }
    const paid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
    const subId = adapter.idOf(session.subscription);
    if (session.status === 'complete' && paid && subId) {
      await capturePrefill(ws, adapter.extractPrefill(session), deps);
      const sub = await retrieveSubscription(stripe, subId);
      const r = await applyStripeState(ws, sub, { canonical: true, planCode: session.metadata.planCode, checkoutSessionId: session.id }, deps);
      return { changed: r.changed, noop: false, after: r.after || cur, ...(r.ignored ? { ignored: r.ignored } : {}) };
    }
    if (session.status === 'expired') {
      // The checkout was abandoned: forget it so the workspace is `none` again and can retry (the stored ids stay in Stripe).
      await M(deps, 'OnboardingState').updateOne({ workspaceId: ws }, {
        $set: { 'subscription.stripe.lastSyncedAt': nowOf(deps) },
        $unset: { 'subscription.stripe.checkoutSessionId': 1, 'subscription.stripe.checkoutStartedAt': 1 },
      });
      const rec = await stateMod(deps).recomputeSubscription(ws, { now: nowOf(deps) }, stateDeps(deps));
      return { changed: !!rec.changed, noop: false, after: rec.after || cur };
    }
    await touchSynced(ws, deps); // still open (or unpaid async): nothing to do yet
    return { changed: false, noop: false, after: cur };
  }

  return { changed: false, noop: true, after: cur };
}

/**
 * On-demand reconcile for the owner's browser ("I just paid"): the SERVER asks Stripe, it never trusts the
 * browser. Rate limiting (1 per 15 s) is applied by the route through rateLimit. Honours
 * config.reconcileOnDemand() (off = no Stripe call, current stored state returned).
 * @param {{workspaceId:string}} args
 * @param {object} [deps]
 * @returns {Promise<{changed:boolean, subscription:{state:string, source:string|null, retry:object}}>}
 */
async function refreshBilling({ workspaceId } = {}, deps = {}) {
  const doc = await stateMod(deps).ensureState(workspaceId, stateDeps(deps));
  const cur = subOf(doc);
  if (!config.reconcileOnDemand()) return { changed: false, subscription: summarize(cur.state, cur.source) };
  try {
    const r = await reconcileOne(workspaceId, doc, deps);
    return { changed: r.changed, subscription: summarize(r.after.state, r.after.source) };
  } catch (err) {
    if (isOnbError(err)) throw err;
    logStripeFailure('reconcile', err);
    throw new OnbError('STRIPE_ERROR', { cause: err });
  }
}

/**
 * Bounded reconcile for the scheduler (B1-d): pending > 30 min, and past_due/active once a day.
 * At most `limit` (default 25) Stripe round trips per call; every check stamps lastSyncedAt so the next
 * sweep moves on. NEVER throws. Does nothing when the flow is off or no Stripe key is configured.
 * @param {{now?:Date|number, limit?:number}} [opts]
 * @param {object} [deps]
 * @returns {Promise<{checked:number, changed:number}>}
 */
async function reconcileSweep(opts = {}, deps = {}) {
  const out = { checked: 0, changed: 0 };
  try {
    if (!config.enabled()) return out;
    const o = opts || {};
    const limit = Math.max(1, Math.min(100, Number(o.limit) || DEFAULT_SWEEP_LIMIT));
    const nowD = o.now !== undefined && o.now !== null ? new Date(o.now) : nowOf(deps);
    const nowMs = nowD.getTime();
    const sweepDeps = { ...deps, now: () => new Date(nowMs) };
    try { adapter.getStripeClient(sweepDeps); } catch (_) { return out; }
    const State = M(sweepDeps, 'OnboardingState');
    const fields = 'workspaceId subscription';

    const pending = await State.find({ enrolled: { $ne: false }, 'subscription.state': 'pending' }).select(fields).limit(limit * 2).lean();
    const duePending = (pending || []).filter((d) => {
      const s = (d.subscription && d.subscription.stripe) || {};
      const ref = s.lastSyncedAt || s.checkoutStartedAt || (d.subscription && d.subscription.changedAt);
      return !ref || nowMs - new Date(ref).getTime() > PENDING_RECHECK_MS;
    });
    const daily = await State.find({
      enrolled: { $ne: false },
      'subscription.state': { $in: ['past_due', 'active'] },
      'subscription.stripe.subscriptionId': { $exists: true },
      'subscription.stripe.lastSyncedAt': { $lt: new Date(nowMs - DAILY_RECHECK_MS) },
    }).select(fields).limit(limit).lean();

    for (const d of [...duePending, ...(daily || [])]) {
      if (out.checked >= limit) break;
      out.checked += 1;
      try {
        const r = await reconcileOne(String(d.workspaceId), d, sweepDeps);
        if (r.changed) out.changed += 1;
      } catch (err) {
        config.safeLog('warn', '[onboarding] billing reconcile failed for one workspace:', err && err.code);
      }
    }
  } catch (err) {
    config.safeLog('warn', '[onboarding] billing reconcile sweep failed:', err && err.code, err && err.message);
  }
  return out;
}

module.exports = {
  createCheckout,
  createPortal,
  refreshBilling,
  applyStripeState,
  reconcileSweep,
  // additions (B1-b)
  reconcileOne,
  capturePrefill,
  summarize,
  retryFor,
  existingSubscription,
  SubscriptionExistsError,
};
