const router = require('express').Router();
const Stripe = require('stripe');
const wa     = require('../utils/whatsapp');
const { carts } = require('../utils/state');
const { APP_URL } = require('../utils/config');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pageShell(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #111;
    padding: 24px; box-sizing: border-box;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d0d10; color: #eee; }
    .card { background: #1a1a1f !important; border-color: #2a2a30 !important; }
    .muted { color: #999 !important; }
    input, #payment-element { color-scheme: dark; }
  }
  .card {
    width: 100%; max-width: 440px; background: #fff; border: 1px solid #e4e4e7;
    border-radius: 16px; padding: 28px; box-shadow: 0 2px 12px rgba(0,0,0,.06);
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .muted { color: #666; font-size: 14px; }
  .row { display: flex; justify-content: space-between; font-size: 14px; padding: 4px 0; }
  .row.total { font-weight: 700; font-size: 16px; border-top: 1px solid #e4e4e7; margin-top: 8px; padding-top: 10px; }
  .summary { margin: 18px 0; }
  button.pay {
    width: 100%; padding: 13px; border: none; border-radius: 10px; background: #16a34a; color: #fff;
    font-size: 16px; font-weight: 600; cursor: pointer; margin-top: 18px;
  }
  button.pay:disabled { opacity: .6; cursor: default; }
  a.exit { display: block; text-align: center; margin-top: 14px; font-size: 13px; color: #888; text-decoration: none; }
  #payment-message { margin-top: 12px; font-size: 14px; color: #dc2626; }
  #payment-message.success { color: #16a34a; }
  .icon { font-size: 42px; text-align: center; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="card">${bodyHtml}</div>
</body>
</html>`;
}

// ── Custom branded payment page (Stripe Elements) ────────────────────────────
router.get('/pay/:piId', async (req, res) => {
  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(req.params.piId);
  } catch {
    return res.status(404).send(pageShell('Not found', '<h1>Payment link not found</h1><p class="muted">This link may have expired.</p>'));
  }

  if (pi.status === 'succeeded') {
    return res.send(pageShell('Already paid', '<div class="icon">✅</div><h1>Already paid</h1><p class="muted">This order has already been paid. You can return to WhatsApp.</p>'));
  }

  const phone        = pi.metadata?.buyerPhone || '';
  const subtotal      = parseFloat(pi.metadata?.subtotal || '0');
  const shippingCost  = parseFloat(pi.metadata?.shippingCost || '0');
  const address       = pi.metadata?.address || '';
  const total         = pi.amount / 100;
  const cart          = carts.get(phone) || [];

  const itemsHtml = cart.map(item => `<div class="row"><span>${escapeHtml(item.name)}</span><span>$${item.priceAud.toFixed(2)}</span></div>`).join('');

  const body = `
    <h1>Complete Your Payment</h1>
    <p class="muted">${escapeHtml(pi.currency.toUpperCase())} · Order total below</p>
    <div class="summary">
      ${itemsHtml}
      <div class="row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
      <div class="row"><span>Shipping</span><span>$${shippingCost.toFixed(2)}</span></div>
      <div class="row total"><span>Total</span><span>$${total.toFixed(2)} AUD</span></div>
      ${address ? `<p class="muted" style="margin-top:14px">📍 Delivering to: ${escapeHtml(address)}</p>` : ''}
    </div>
    <form id="payment-form">
      <div id="payment-element"></div>
      <button id="submit" class="pay" type="submit">Pay $${total.toFixed(2)} AUD</button>
      <div id="payment-message"></div>
    </form>
    <a class="exit" href="/payment-cancelled?phone=${encodeURIComponent(phone)}">Cancel and return to WhatsApp</a>
    <script src="https://js.stripe.com/v3/"></script>
    <script>
      const stripe = Stripe(${JSON.stringify(PUBLISHABLE_KEY)});
      const elements = stripe.elements({ clientSecret: ${JSON.stringify(pi.client_secret)} });
      const paymentElement = elements.create('payment');
      paymentElement.mount('#payment-element');

      const form = document.getElementById('payment-form');
      const submitBtn = document.getElementById('submit');
      const messageEl = document.getElementById('payment-message');

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        submitBtn.disabled = true;
        messageEl.textContent = '';
        messageEl.className = '';

        const { error, paymentIntent } = await stripe.confirmPayment({
          elements,
          confirmParams: { return_url: window.location.origin + '/payment-result' },
          redirect: 'if_required',
        });

        if (error) {
          messageEl.textContent = error.message || 'Payment failed. Please try again.';
          submitBtn.disabled = false;
        } else if (paymentIntent && paymentIntent.status === 'succeeded') {
          messageEl.textContent = '✅ Payment successful! You can return to WhatsApp now.';
          messageEl.className = 'success';
          form.style.display = 'none';
        }
      });
    </script>
  `;

  res.send(pageShell('Complete Your Payment', body));
});

// ── Redirect landing for 3DS / wallet payment methods ────────────────────────
router.get('/payment-result', async (req, res) => {
  const { payment_intent: piId } = req.query;
  if (!piId) return res.send(pageShell('Payment', '<h1>Payment status unknown</h1>'));

  let pi;
  try {
    pi = await stripe.paymentIntents.retrieve(piId);
  } catch {
    return res.send(pageShell('Payment', '<h1>Payment status unknown</h1>'));
  }

  if (pi.status === 'succeeded') {
    return res.send(pageShell('Payment successful', '<div class="icon">✅</div><h1>Payment successful!</h1><p class="muted">You can return to WhatsApp now.</p>'));
  }

  const phone = pi.metadata?.buyerPhone || '';
  return res.send(pageShell('Payment failed', `
    <div class="icon">❌</div>
    <h1>Payment not completed</h1>
    <p class="muted">Your payment wasn't completed. You can try again or cancel.</p>
    <a class="exit" style="margin-top:20px" href="/pay/${encodeURIComponent(piId)}">Try Again</a>
    <a class="exit" href="/payment-cancelled?phone=${encodeURIComponent(phone)}">Cancel and return to WhatsApp</a>
  `));
});

// ── Explicit cancel from the payment page ────────────────────────────────────
router.get('/payment-cancelled', async (req, res) => {
  const phone = req.query.phone;
  if (phone) {
    carts.delete(phone);
    await wa.waPost({
      messaging_product: 'whatsapp', to: phone, type: 'text',
      text: { body: 'No worries! Your cart has been cleared. Feel free to browse again anytime. 🛍️' },
    }).catch(err => console.error('payment-cancelled notify error:', err.message));
  }
  res.send(pageShell('Cancelled', '<h1>Payment cancelled</h1><p class="muted">Return to WhatsApp to keep shopping.</p>'));
});

module.exports = router;
