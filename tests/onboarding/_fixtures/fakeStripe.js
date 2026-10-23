'use strict';
// Fake Stripe for the onboarding tests. Two independent parts:
//  1. createFakeStripe(): an object shaped like the `stripe` npm client for exactly
//     checkout.sessions.create/retrieve, subscriptions.retrieve, billingPortal.sessions.create
//     (+ webhooks.constructEvent/generateTestHeaderString from the REAL package, offline).
//  2. Pure builders: makeSubscription / makeInvoice / makeCheckoutSession / makeEvent / signedEvent.
// Nothing here ever opens a socket: the real `stripe` package is only used for its offline
// webhook-signature helpers, with a dummy key and an unroutable host as a second safety net.

const Stripe = require('stripe');
const { fixedClock } = require('./helpers');

/** Dummy endpoint secret. Never a real secret. */
const TEST_WEBHOOK_SECRET = 'whsec_fixture_dummy_secret_not_real_0123456789';
const DUMMY_API_KEY = 'sk_test_dummy_fixture';

let realClient = null;
function real() {
  if (!realClient) {
    realClient = new Stripe(DUMMY_API_KEY, { host: 'localhost.invalid', maxNetworkRetries: 0, telemetry: false });
  }
  return realClient;
}

const DEFAULT_NOW_SEC = Math.floor(new Date('2026-10-15T09:00:00.000Z').getTime() / 1000);
const DAY = 86400;

let uid = 0;
function nextId(prefix) {
  uid += 1;
  return prefix + '_fixture_' + uid;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function stripeError(kind, message, extra) {
  const Cls = Stripe.errors[kind] || Stripe.errors.StripeError;
  return new Cls(Object.assign({ message, type: 'invalid_request_error' }, extra || {}));
}

// --------------------------------------------------------------------------------------------
// Builders
// --------------------------------------------------------------------------------------------

/**
 * A subscription object.
 * shape 'current' (default): period fields live on the subscription (pre-2025-03-31.basil).
 * shape 'basil'            : period fields live on items.data[i] and NOT on the subscription.
 * @param {object} [o] {id,status,customer,metadata,shape,priceId,quantity,currentPeriodStart,
 *   currentPeriodEnd,cancelAtPeriodEnd,defaultPaymentMethod (null = none),trialEnd,created,
 *   latestInvoice,canceledAt,items (array of item overrides),extra}
 */
function makeSubscription(o = {}) {
  const shape = o.shape || 'current';
  const created = o.created === undefined ? DEFAULT_NOW_SEC : o.created;
  const start = o.currentPeriodStart === undefined ? created : o.currentPeriodStart;
  const end = o.currentPeriodEnd === undefined ? start + 30 * DAY : o.currentPeriodEnd;
  const id = o.id || nextId('sub');
  const itemDefs = Array.isArray(o.items) && o.items.length ? o.items : [{}];
  const items = itemDefs.map((it, i) => {
    const item = {
      id: it.id || (id + '_item_' + (i + 1)).replace('sub_', 'si_'),
      object: 'subscription_item',
      created,
      quantity: it.quantity === undefined ? (o.quantity === undefined ? 1 : o.quantity) : it.quantity,
      price: Object.assign({ id: it.priceId || o.priceId || 'price_fixture_1', object: 'price', active: true, currency: 'sar', type: 'recurring' }, it.price || {}),
      subscription: id,
      metadata: it.metadata || {},
    };
    if (shape === 'basil') {
      item.current_period_start = it.currentPeriodStart === undefined ? start : it.currentPeriodStart;
      item.current_period_end = it.currentPeriodEnd === undefined ? end : it.currentPeriodEnd;
    }
    return item;
  });
  const sub = {
    id,
    object: 'subscription',
    status: o.status || 'active',
    customer: o.customer === undefined ? 'cus_fixture_1' : o.customer,
    created,
    start_date: created,
    livemode: false,
    metadata: clone(o.metadata) || {},
    cancel_at_period_end: !!o.cancelAtPeriodEnd,
    canceled_at: o.canceledAt === undefined ? null : o.canceledAt,
    ended_at: o.endedAt === undefined ? null : o.endedAt,
    trial_end: o.trialEnd === undefined ? null : o.trialEnd,
    trial_start: o.trialStart === undefined ? null : o.trialStart,
    collection_method: 'charge_automatically',
    default_payment_method: o.defaultPaymentMethod === undefined ? 'pm_fixture_1' : o.defaultPaymentMethod,
    latest_invoice: o.latestInvoice === undefined ? null : o.latestInvoice,
    items: { object: 'list', data: items, has_more: false, url: '/v1/subscription_items?subscription=' + id },
    currency: 'sar',
  };
  if (shape !== 'basil') {
    sub.current_period_start = start;
    sub.current_period_end = end;
  }
  return Object.assign(sub, clone(o.extra) || {});
}

/**
 * An invoice object.
 * shape 'current': `invoice.subscription` = 'sub_..' (pre-basil).
 * shape 'basil'  : `invoice.parent.subscription_details.subscription` and NO top-level subscription.
 * @param {object} [o] {id,status,subscription,customer,shape,amountPaid,amountDue,currency,
 *   billingReason,attemptCount,nextPaymentAttempt,created,metadata,extra}
 */
function makeInvoice(o = {}) {
  const shape = o.shape || 'current';
  const subscription = o.subscription === undefined ? 'sub_fixture_1' : o.subscription;
  const status = o.status || 'paid';
  const amount = o.amountDue === undefined ? 10000 : o.amountDue;
  const inv = {
    id: o.id || nextId('in'),
    object: 'invoice',
    status,
    customer: o.customer === undefined ? 'cus_fixture_1' : o.customer,
    created: o.created === undefined ? DEFAULT_NOW_SEC : o.created,
    currency: o.currency || 'sar',
    amount_due: amount,
    amount_paid: o.amountPaid === undefined ? (status === 'paid' ? amount : 0) : o.amountPaid,
    billing_reason: o.billingReason || 'subscription_create',
    attempt_count: o.attemptCount === undefined ? (status === 'paid' ? 1 : 1) : o.attemptCount,
    next_payment_attempt: o.nextPaymentAttempt === undefined ? null : o.nextPaymentAttempt,
    hosted_invoice_url: 'https://invoice.stripe.test/i/fixture',
    livemode: false,
    paid: status === 'paid',
  };
  if (shape === 'basil') {
    inv.parent = {
      type: 'subscription_details',
      quote_details: null,
      subscription_details: { subscription, metadata: clone(o.metadata) || {} },
    };
    delete inv.paid;
  } else {
    inv.subscription = subscription;
    inv.subscription_details = { metadata: clone(o.metadata) || {} };
  }
  return Object.assign(inv, clone(o.extra) || {});
}

/**
 * A Checkout Session object (as returned by retrieve / carried by checkout.session.completed).
 * @param {object} [o] {id,status,paymentStatus,mode,clientReferenceId,metadata,customer,
 *   subscription,email,businessName,businessNameVia ('custom_fields'|'customer_details'),
 *   url,created,extra}
 */
function makeCheckoutSession(o = {}) {
  const complete = (o.status || 'complete') === 'complete';
  const email = o.email === undefined ? 'owner@example.test' : o.email;
  const sess = {
    id: o.id || nextId('cs_test'),
    object: 'checkout.session',
    mode: o.mode || 'subscription',
    status: o.status || 'complete',
    payment_status: o.paymentStatus || (complete ? 'paid' : 'unpaid'),
    client_reference_id: o.clientReferenceId === undefined ? null : o.clientReferenceId,
    metadata: clone(o.metadata) || {},
    customer: o.customer === undefined ? (complete ? 'cus_fixture_1' : null) : o.customer,
    subscription: o.subscription === undefined ? (complete ? 'sub_fixture_1' : null) : o.subscription,
    customer_email: o.customerEmail === undefined ? null : o.customerEmail,
    customer_details: email === null ? null : { email, name: null, phone: null, address: null },
    custom_fields: [],
    url: o.url === undefined ? null : o.url,
    created: o.created === undefined ? DEFAULT_NOW_SEC : o.created,
    livemode: false,
    currency: 'sar',
    amount_total: 10000,
    payment_method_collection: 'always',
  };
  if (o.businessName) {
    if ((o.businessNameVia || 'custom_fields') === 'customer_details') {
      sess.customer_details = Object.assign(sess.customer_details || {}, { business_name: o.businessName });
    } else {
      sess.custom_fields = [{ key: 'business_name', label: { type: 'custom', custom: 'Business name' }, type: 'text', optional: false, text: { value: o.businessName, minimum_length: null, maximum_length: null } }];
    }
  }
  return Object.assign(sess, clone(o.extra) || {});
}

/**
 * An Event envelope around an object. `created` is in seconds.
 * @param {{type: string, object: object, id?: string, created?: number, apiVersion?: string}} o
 */
function makeEvent(o) {
  if (!o || !o.type) throw new Error('makeEvent: type is required');
  return {
    id: o.id || nextId('evt'),
    object: 'event',
    api_version: o.apiVersion || '2024-06-20',
    created: o.created === undefined ? DEFAULT_NOW_SEC : o.created,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: o.type,
    data: { object: clone(o.object) || {} },
  };
}

/**
 * Build a signed webhook delivery with the REAL stripe package, offline.
 * @param {{type: string, object: object, id?: string, created?: number, secret?: string,
 *   timestamp?: number, apiVersion?: string}} o
 *   `timestamp` (seconds) overrides the header timestamp (default = now) to test stale deliveries.
 * @returns {{event: object, payload: string, body: Buffer, header: string, secret: string}}
 */
function signedEvent(o) {
  const event = makeEvent(o);
  const secret = o.secret || TEST_WEBHOOK_SECRET;
  const payload = JSON.stringify(event);
  const args = { payload, secret };
  if (o.timestamp !== undefined) args.timestamp = o.timestamp;
  const header = real().webhooks.generateTestHeaderString(args);
  return { event, payload, body: Buffer.from(payload, 'utf8'), header, secret };
}

// --------------------------------------------------------------------------------------------
// The fake client
// --------------------------------------------------------------------------------------------

/**
 * @param {{checkoutUrlBase?: string, portalUrlBase?: string, shape?: 'current'|'basil',
 *   webhookSecret?: string, clock?: object}} [options]
 *  Scriptable failures: failNext('checkout.sessions.create', { type, message, statusCode, code })
 *  (`type` is a stripe error class name such as 'StripeInvalidRequestError', 'StripeConnectionError',
 *  'StripeRateLimitError'; default StripeAPIError).
 */
function createFakeStripe(options = {}) {
  const clock = options.clock || fixedClock();
  const shape = options.shape || 'current';
  const checkoutBase = options.checkoutUrlBase || 'https://checkout.stripe.com/c/pay/';
  const portalBase = options.portalUrlBase || 'https://billing.stripe.com/p/session/';
  const webhookSecret = options.webhookSecret || TEST_WEBHOOK_SECRET;

  const calls = [];
  const failures = []; // { method, times, error }
  const sessions = new Map();
  const subscriptions = new Map();
  let counter = 0;

  function record(method, args) {
    calls.push({ seq: calls.length + 1, method, args: clone(args), at: clock.ms() });
  }

  function maybeFail(method) {
    const idx = failures.findIndex((f) => f.method === method && f.times > 0);
    if (idx === -1) return;
    const f = failures[idx];
    f.times -= 1;
    if (f.times <= 0) failures.splice(idx, 1);
    const spec = f.error || {};
    if (spec instanceof Error) throw spec;
    throw stripeError(spec.type || 'StripeAPIError', spec.message || 'Fake Stripe failure', {
      code: spec.code, statusCode: spec.statusCode || (spec.type === 'StripeConnectionError' ? undefined : 500),
    });
  }

  const checkout = {
    sessions: {
      async create(params, reqOpts) {
        record('checkout.sessions.create', { params, reqOpts });
        maybeFail('checkout.sessions.create');
        const p = params || {};
        const missing = ['mode', 'success_url'].filter((k) => !p[k]);
        if (missing.length) throw stripeError('StripeInvalidRequestError', 'Missing required param: ' + missing[0] + '.', { code: 'parameter_missing', statusCode: 400 });
        if (p.mode === 'subscription' && !(Array.isArray(p.line_items) && p.line_items.length)) {
          throw stripeError('StripeInvalidRequestError', 'Missing required param: line_items.', { code: 'parameter_missing', statusCode: 400 });
        }
        if (p.client_reference_id && String(p.client_reference_id).length > 200) {
          throw stripeError('StripeInvalidRequestError', 'client_reference_id too long.', { code: 'parameter_invalid_string_length', statusCode: 400 });
        }
        counter += 1;
        const id = 'cs_test_fixture_' + counter;
        const sess = makeCheckoutSession({
          id, status: 'open', paymentStatus: 'unpaid', mode: p.mode, clientReferenceId: p.client_reference_id,
          metadata: p.metadata, customer: null, subscription: null, email: null, customerEmail: p.customer_email,
          url: checkoutBase + id, created: clock.sec(),
        });
        sess.success_url = p.success_url;
        sess.cancel_url = p.cancel_url || null;
        sess.line_items_requested = clone(p.line_items);
        sess.subscription_data_requested = clone(p.subscription_data);
        sess.payment_method_collection = p.payment_method_collection || 'always';
        sessions.set(id, sess);
        return clone(sess);
      },
      async retrieve(id, params) {
        record('checkout.sessions.retrieve', { id, params });
        maybeFail('checkout.sessions.retrieve');
        if (!sessions.has(id)) throw stripeError('StripeInvalidRequestError', 'No such checkout.session: ' + id, { code: 'resource_missing', statusCode: 404 });
        return clone(sessions.get(id));
      },
    },
  };

  const subs = {
    async retrieve(id, params) {
      record('subscriptions.retrieve', { id, params });
      maybeFail('subscriptions.retrieve');
      if (!subscriptions.has(id)) throw stripeError('StripeInvalidRequestError', 'No such subscription: ' + id, { code: 'resource_missing', statusCode: 404 });
      return clone(subscriptions.get(id));
    },
  };

  const billingPortal = {
    sessions: {
      async create(params, reqOpts) {
        record('billingPortal.sessions.create', { params, reqOpts });
        maybeFail('billingPortal.sessions.create');
        const p = params || {};
        if (!p.customer) throw stripeError('StripeInvalidRequestError', 'Missing required param: customer.', { code: 'parameter_missing', statusCode: 400 });
        counter += 1;
        return { id: 'bps_fixture_' + counter, object: 'billing_portal.session', customer: p.customer, return_url: p.return_url || null, url: portalBase + 'test_fixture_' + counter, created: clock.sec(), livemode: false };
      },
    },
  };

  const client = {
    checkout,
    subscriptions: subs,
    billingPortal,
    webhooks: {
      constructEvent: (payload, header, secret, tolerance) => real().webhooks.constructEvent(payload, header, secret, tolerance),
      generateTestHeaderString: (args) => real().webhooks.generateTestHeaderString(args),
    },
    // ---- test helpers (not part of the real client) ----
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method),
    webhookSecret,
    failNext(method, error, opts) {
      failures.push({ method, error: error || {}, times: (opts && opts.times) || 1 });
      return client;
    },
    reset() {
      calls.length = 0; failures.length = 0; sessions.clear(); subscriptions.clear(); counter = 0;
    },
    /** Seed or replace a subscription in the fake's store (returns the stored copy). */
    setSubscription(sub) {
      const s = sub && sub.object === 'subscription' ? sub : makeSubscription(Object.assign({ shape }, sub || {}));
      subscriptions.set(s.id, clone(s));
      return clone(s);
    },
    getSubscription: (id) => clone(subscriptions.get(id)),
    getSession: (id) => clone(sessions.get(id)),
    /**
     * Simulate the customer finishing Checkout: marks the session complete, creates the
     * subscription in the store (status from `subscriptionStatus`, default 'active'), links them.
     * @returns {{session: object, subscription: object}}
     */
    completeCheckout(sessionId, o = {}) {
      const sess = sessions.get(sessionId);
      if (!sess) throw new Error('completeCheckout: unknown session ' + sessionId);
      const subId = o.subscriptionId || nextId('sub');
      const customer = o.customer || 'cus_fixture_1';
      const meta = (sess.subscription_data_requested && sess.subscription_data_requested.metadata) || {};
      const sub = makeSubscription(Object.assign({ shape, id: subId, customer, status: o.subscriptionStatus || 'active', metadata: meta, created: clock.sec() }, o.subscription || {}));
      subscriptions.set(subId, clone(sub));
      sess.status = 'complete';
      sess.payment_status = o.paymentStatus || 'paid';
      sess.customer = customer;
      sess.subscription = subId;
      sess.customer_details = { email: o.email === undefined ? 'owner@example.test' : o.email, name: null, phone: null, address: null };
      if (o.businessName) sess.custom_fields = [{ key: 'business_name', type: 'text', text: { value: o.businessName } }];
      return { session: clone(sess), subscription: clone(sub) };
    },
    signedEvent: (o) => signedEvent(Object.assign({ secret: webhookSecret }, o)),
    makeSubscription: (o) => makeSubscription(Object.assign({ shape }, o)),
    makeInvoice: (o) => makeInvoice(Object.assign({ shape }, o)),
    makeCheckoutSession,
    makeEvent,
  };
  return client;
}

module.exports = {
  createFakeStripe, signedEvent, makeEvent, makeSubscription, makeInvoice, makeCheckoutSession,
  TEST_WEBHOOK_SECRET,
};
