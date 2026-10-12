'use strict';
// Arabic payment pages: /pay/:piId, /payment-result and /payment-cancelled
// (spec §3.5). Each planner returns a plan for routes/localization/pages.js:
//   { next: true }          the English handler (routes/pay.js) answers instead
//   { status, html }        an Arabic page
// and only READS: Stripe `paymentIntents.retrieve`, a few indexed/bounded database
// lookups, the in-memory carts. Nothing is written, no message is sent.
//
// Differences from the English pages, all deliberate:
//   * /payment-cancelled only renders. The English handler also deletes the in-memory
//     cart and sends the customer a WhatsApp text for any `?phone=` it is given
//     (R7 §1.7: unauthenticated, usable against any number) - that is NOT copied. The
//     Arabic "cancel" links carry no phone, so an Arabic customer who cancels keeps
//     their cart and gets no "your cart has been cleared" message.
//   * The payment message sits outside the <form>. The English page writes its
//     success text into a div INSIDE the form and then hides the form, so the text
//     is never visible.
//   * A cancelled PaymentIntent shows the "link may have expired" page instead of a
//     form that can only fail; line items from the in-memory cart are shown only when
//     they add up to the PaymentIntent's subtotal (a stale or foreign cart is omitted);
//     service bookings show the service and slot; the Stripe.js `locale` is also set on
//     the Stripe object itself so `confirmPayment` error text is Arabic too.
//   * Amounts follow the glossary ("150.00 ر.س", Western digits, comma thousands).
const layout = require('./layout');
const { fallThrough, page, firstString, isPlausiblePaymentIntentId, decidePageLanguage } = require('./index');
const { isObjectIdLike } = require('../scope');

const GROUPS = ['common', 'pay'];
// shared/inbox.js#sendPaymentLink creates PaymentIntents with this metadata.source;
// they never have an Order, so looking one up would only be a wasted collection scan.
const INBOX_PAYMENT_SOURCE = 'inbox_manual_payment_link';
const MAX_ITEMS = 50;
const CANCEL_HREF = `/payment-cancelled${layout.queryString({ lang: 'ar' })}`;

// ── Read-only lookups ────────────────────────────────────────────────────────
// Like the English page, ANY failure to retrieve the PaymentIntent means "not
// found". A missing id is routine; anything else is worth a log line.
async function retrievePaymentIntent(stripe, piId) {
  if (!isPlausiblePaymentIntentId(piId)) return null;
  try {
    return await stripe.paymentIntents.retrieve(piId);
  } catch (err) {
    if (!err || err.code !== 'resource_missing') console.error('[localization:pages] Stripe retrieve failed:', err && err.message);
    return null;
  }
}

// Which workspace does this PaymentIntent belong to? None of the four creation sites
// stores it, so, cheapest and most precise first:
//   booking PIs   metadata.serviceId  -> Service.workspaceId        (by _id)
//   cart PIs      the Order created for it (also gives the buyer)   (Order.stripePaymentIntentId
//                 is NOT indexed: a scan, acceptable because it only runs after the cheap gates
//                 and only for PaymentIntents that exist in our own Stripe account)
//   everything else (inbox links, unknown ids): the oldest workspace, exactly the fallback
//                 server.js uses for its public webhooks.
async function resolvePaymentWorkspace(deps, pi) {
  const metadata = (pi && pi.metadata) || {};
  const { Service, Order } = deps.models;
  if (isObjectIdLike(metadata.serviceId)) {
    const service = await Service.findById(metadata.serviceId).select('workspaceId').lean();
    if (service && service.workspaceId) return { workspaceId: String(service.workspaceId), customerId: null };
  }
  if (pi && pi.id && metadata.source !== INBOX_PAYMENT_SOURCE) {
    const order = await Order.findOne({ stripePaymentIntentId: pi.id }).select('workspaceId customer').lean();
    if (order && order.workspaceId) return { workspaceId: String(order.workspaceId), customerId: order.customer ? String(order.customer) : null };
  }
  return { workspaceId: await deps.oldestWorkspaceId(), customerId: null };
}

// The buyer's stored language, scoped to the workspace: 'ar' | 'en' | 'unknown' | null.
async function storedLanguage(deps, { workspaceId, customerId, phone }) {
  const { Customer, CustomerLanguage } = deps.models;
  let id = customerId;
  if (!id) {
    if (typeof phone !== 'string' || !phone || phone.length > 32) return null;
    const customer = await Customer.findOne({ workspaceId, phone }).select('_id').lean();
    if (!customer) return null;
    id = customer._id;
  }
  const doc = await CustomerLanguage.findOne({ workspaceId, customerId: id }).select('language').lean();
  return doc ? doc.language : null;
}

async function loadPayContext(deps, piId) {
  const stripe = deps.getStripe();
  if (!stripe) return null;
  const pi = await retrievePaymentIntent(stripe, piId);
  const base = await resolvePaymentWorkspace(deps, pi);
  const phone = pi && pi.metadata ? pi.metadata.buyerPhone : null;
  return { pi, workspaceId: base.workspaceId, getStoredLanguage: () => storedLanguage(deps, { ...base, phone }) };
}

// /payment-cancelled has no PaymentIntent, only an optional ?phone= that is used
// purely to find the customer's language (it is never shown and never acted upon).
async function loadCancelContext(deps, rawPhone) {
  const workspaceId = await deps.oldestWorkspaceId();
  const phone = String(rawPhone || '').replace(/\D/g, '');
  const usable = phone.length >= 5 && phone.length <= 20;
  return { workspaceId, getStoredLanguage: usable ? () => storedLanguage(deps, { workspaceId, phone }) : undefined };
}

// ── The checkout model ───────────────────────────────────────────────────────
function amountOf(value) {
  const n = Number.parseFloat(value || '0');
  return Number.isFinite(n) ? n : 0;
}

// Items from the in-memory cart, only when they demonstrably belong to this
// PaymentIntent (their prices add up to its subtotal).
function cartItemsFor(deps, metadata, subtotal) {
  const cart = deps.carts && deps.carts.get(metadata.buyerPhone);
  if (!Array.isArray(cart) || !cart.length || cart.length > MAX_ITEMS) return [];
  const prices = cart.map((item) => Number(item && item.priceAud));
  if (prices.some((price) => !Number.isFinite(price))) return [];
  if (Math.abs(prices.reduce((sum, price) => sum + price, 0) - subtotal) > 0.01) return [];
  return cart.map((item, index) => ({ name: layout.cleanText(item.name, 120), price: prices[index] }));
}

async function bookingFor(deps, metadata, workspaceId) {
  const service = layout.cleanText(metadata.serviceName, 120);
  let slot = null;
  if (workspaceId && isObjectIdLike(metadata.slotId)) {
    const doc = await deps.models.TimeSlot.findOne({ _id: metadata.slotId, workspaceId }).select('date startTime').lean();
    if (doc && /^\d{4}-\d{2}-\d{2}$/.test(doc.date) && /^\d{1,2}:\d{2}$/.test(doc.startTime)) slot = { date: doc.date, time: doc.startTime };
  }
  return service || slot ? { service, slot } : null;
}

async function buildCheckoutModel(pi, ctx, deps) {
  const metadata = pi.metadata || {};
  const isBooking = metadata.bookingType === 'service';
  const hasBreakdown = !isBooking && metadata.subtotal !== undefined && metadata.subtotal !== '';
  const subtotal = hasBreakdown ? amountOf(metadata.subtotal) : 0;
  return {
    currency: String(pi.currency || '').toUpperCase(),
    total: Number(pi.amount) / 100,
    hasBreakdown,
    subtotal,
    shipping: hasBreakdown ? amountOf(metadata.shippingCost) : 0,
    address: layout.cleanText(metadata.address, 300),
    items: hasBreakdown ? cartItemsFor(deps, metadata, subtotal) : [],
    booking: isBooking ? await bookingFor(deps, metadata, ctx.workspaceId) : null,
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────
function row(labelHtml, valueHtml, extraClass = '') {
  return `<div class="row${extraClass ? ` ${extraClass}` : ''}"><span>${labelHtml}</span><span>${valueHtml}</span></div>`;
}

// The page script is static: nothing user- or Stripe-controlled is interpolated into
// it. The publishable key, client secret and messages travel as escaped data-
// attributes on the form and are read with dataset, so there is no script-injection
// surface. `locale: 'ar'` localises the Payment Element (labels, placeholders, errors)
// and, set on the Stripe object, the error text confirmPayment returns.
const STRIPE_SCRIPT = '<script src="https://js.stripe.com/v3/"></script>';
const CHECKOUT_SCRIPT = `<script>
(function () {
  var form = document.getElementById('payment-form');
  var cfg = form.dataset;
  var submitBtn = document.getElementById('submit');
  var messageEl = document.getElementById('payment-message');
  function show(message, ok) {
    messageEl.textContent = message;
    messageEl.className = ok ? 'success' : '';
  }
  if (typeof Stripe !== 'function') {
    show(cfg.msgFailed, false);
    submitBtn.disabled = true;
    return;
  }
  var stripe = Stripe(cfg.publishableKey, { locale: 'ar' });
  var elements = stripe.elements({ clientSecret: cfg.clientSecret, locale: 'ar' });
  elements.create('payment').mount('#payment-element');
  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    submitBtn.disabled = true;
    show('', false);
    try {
      var result = await stripe.confirmPayment({
        elements: elements,
        confirmParams: { return_url: window.location.origin + '/payment-result?lang=ar' },
        redirect: 'if_required'
      });
      if (result.error) {
        show(result.error.message || cfg.msgFailed, false);
        submitBtn.disabled = false;
      } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
        show(cfg.msgSuccess, true);
        form.style.display = 'none';
      }
    } catch (err) {
      show(cfg.msgFailed, false);
      submitBtn.disabled = false;
    }
  });
})();
</script>`;

function currencyLabelHtml(currency) {
  return currency === 'SAR' ? layout.text('pay.currencyName.SAR') : layout.ltr(currency);
}

function summaryHtml(model) {
  const rows = [];
  for (const item of model.items) rows.push(row(layout.bdi(item.name, 120), layout.amountHtml(item.price, model.currency)));
  if (model.booking && model.booking.service) rows.push(row(layout.text('pay.service'), layout.bdi(model.booking.service, 120)));
  if (model.booking && model.booking.slot) {
    rows.push(row(layout.text('pay.appointment'), layout.fill('pay.slot', { date: layout.ltr(model.booking.slot.date), time: layout.ltr(model.booking.slot.time) })));
  }
  if (model.hasBreakdown) {
    rows.push(row(layout.text('pay.subtotal'), layout.amountHtml(model.subtotal, model.currency)));
    rows.push(row(layout.text('pay.shipping'), layout.amountHtml(model.shipping, model.currency)));
  }
  rows.push(row(layout.text('pay.total'), layout.amountHtml(model.total, model.currency), 'total'));
  const address = model.address ? `<p class="muted addr">${layout.fill('pay.deliveringTo', { address: layout.bdi(model.address, 300) })}</p>` : '';
  return `<div class="summary">${rows.join('')}${address}</div>`;
}

function checkoutHtml(model, { publishableKey, clientSecret, switchHref }) {
  const body = `<h1>${layout.text('pay.checkout.heading')}</h1>
<p class="muted">${layout.fill('pay.checkout.subtitle', { currency: currencyLabelHtml(model.currency) })}</p>
${summaryHtml(model)}
<form id="payment-form" data-publishable-key="${layout.escapeHtml(publishableKey)}" data-client-secret="${layout.escapeHtml(clientSecret)}" data-msg-failed="${layout.text('pay.failedFallback')}" data-msg-success="${layout.text('pay.successMessage')}">
<div id="payment-element"></div>
<button id="submit" class="pay" type="submit">${layout.fill('pay.payButton', { amount: layout.amountHtml(model.total, model.currency) })}</button>
</form>
<div id="payment-message" role="alert" dir="auto"></div>
<a class="exit" href="${layout.escapeHtml(CANCEL_HREF)}">${layout.text('pay.cancelLink')}</a>`;
  return layout.renderPage({
    title: layout.raw('pay.checkout.heading'), body, switchHref, scripts: `${STRIPE_SCRIPT}\n${CHECKOUT_SCRIPT}`,
  });
}

function notFoundPage(switchHref) {
  return layout.messagePage({ titleKey: 'pay.notFound.title', headingKey: 'pay.notFound.heading', bodyKey: 'pay.notFound.body', switchHref });
}

// ── Planners ─────────────────────────────────────────────────────────────────
async function planPay(req, deps) {
  const piId = String(req.params.piId || '');
  const decision = await decidePageLanguage({ req, deps, groups: GROUPS, loadContext: () => loadPayContext(deps, piId) });
  if (decision.language !== 'ar') return fallThrough(decision.reason);

  const { pi } = decision.ctx;
  const switchHref = `/pay/${encodeURIComponent(piId)}${layout.queryString({ lang: 'en' })}`;
  if (!pi || pi.status === 'canceled') return page(404, notFoundPage(switchHref));
  if (pi.status === 'succeeded') {
    return page(200, layout.messagePage({ titleKey: 'pay.paid.heading', bodyKey: 'pay.paid.body', icon: '✅', switchHref }));
  }
  const publishableKey = deps.publishableKey();
  if (!publishableKey || !pi.client_secret) return fallThrough('checkout_unavailable');
  const model = await buildCheckoutModel(pi, decision.ctx, deps);
  return page(200, checkoutHtml(model, { publishableKey, clientSecret: pi.client_secret, switchHref }));
}

// The landing page Stripe redirects to after 3-D Secure / wallet payments. The
// Arabic checkout puts ?lang=ar on its return_url, so the language is explicit.
async function planPaymentResult(req, deps) {
  const requested = firstString(req.query && req.query.payment_intent);
  const decision = await decidePageLanguage({ req, deps, groups: GROUPS, loadContext: () => loadPayContext(deps, requested) });
  if (decision.language !== 'ar') return fallThrough(decision.reason);

  const { pi } = decision.ctx;
  const switchHref = `/payment-result${layout.queryString({ payment_intent: pi ? pi.id : '', lang: 'en' })}`;
  if (!pi) {
    return page(200, layout.messagePage({ titleKey: 'pay.unknown.title', headingKey: 'pay.unknown.heading', switchHref }));
  }
  if (pi.status === 'succeeded') {
    return page(200, layout.messagePage({ titleKey: 'pay.success.title', headingKey: 'pay.success.heading', bodyKey: 'pay.success.body', icon: '✅', switchHref }));
  }
  const retryHref = `/pay/${encodeURIComponent(pi.id)}${layout.queryString({ lang: 'ar' })}`;
  const links = `<a class="exit first" href="${layout.escapeHtml(retryHref)}">${layout.text('pay.tryAgain')}</a>`
    + `<a class="exit" href="${layout.escapeHtml(CANCEL_HREF)}">${layout.text('pay.cancelLink')}</a>`;
  return page(200, layout.messagePage({
    titleKey: 'pay.failed.title', headingKey: 'pay.failed.heading', bodyKey: 'pay.failed.body', icon: '❌', extraHtml: links, switchHref,
  }));
}

async function planPaymentCancelled(req, deps) {
  const decision = await decidePageLanguage({
    req, deps, groups: GROUPS, loadContext: () => loadCancelContext(deps, firstString(req.query && req.query.phone)),
  });
  if (decision.language !== 'ar') return fallThrough(decision.reason);
  const switchHref = `/payment-cancelled${layout.queryString({ lang: 'en' })}`;
  return page(200, layout.messagePage({ titleKey: 'pay.cancelled.title', headingKey: 'pay.cancelled.heading', bodyKey: 'pay.cancelled.body', switchHref }));
}

module.exports = {
  CHECKOUT_SCRIPT, planPay, planPaymentResult, planPaymentCancelled,
  // exported for unit tests
  resolvePaymentWorkspace, storedLanguage, buildCheckoutModel, cartItemsFor,
};
