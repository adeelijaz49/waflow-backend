// The Arabic payment pages (/pay/:piId, /payment-result, /payment-cancelled), rendered
// through the real router with a FAKE Stripe client and FAKE database models: no
// network, no database, no WhatsApp. A sentinel handler stands in for the existing
// English page, so "fell through to English" is an observable fact, not an assumption.
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/localization/pages');
const catalog = require('../../shared/localization/catalog');
const layout = require('../../shared/localization/pages/layout');

const WS = '64b000000000000000000001';
const OTHER_WS = '64b000000000000000000002';
const CUSTOMER = '64b0000000000000000000c1';
const SERVICE_ID = '64b0000000000000000000a1';
const SLOT_ID = '64b0000000000000000000b1';
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const SENTINEL = 'EXISTING-ENGLISH-HANDLER';

// Stand-in for the Mongoose query chain the pages use: findOne(f).select(s).lean().
const query = (value) => { const q = { select: () => q, sort: () => q, lean: () => Promise.resolve(value) }; return q; };
function model(resolve) {
  const calls = [];
  const run = (filter) => { calls.push(filter); return query(typeof resolve === 'function' ? resolve(filter) : resolve); };
  return { calls, findOne: run, findById: (id) => run({ _id: id }) };
}

const makePi = (over = {}) => ({
  id: 'pi_3Abc123',
  status: 'requires_payment_method',
  amount: 15000,
  currency: 'sar',
  client_secret: 'pi_3Abc123_secret_xyz',
  metadata: { buyerPhone: '966500000001', subtotal: '145', shippingCost: '5', address: 'Riyadh, King Fahd Rd 12' },
  ...over,
});

function makeDeps(over = {}) {
  const stripe = { paymentIntents: { retrieve: jest.fn(async () => makePi()) } };
  return {
    env: {},
    now: () => NOW,
    precheckTimeoutMs: 1000,
    settings: { killSwitchOn: jest.fn(() => false), isArabicEnabled: jest.fn(async (ws) => ws === WS) },
    catalog,
    dbReady: () => true,
    anyArabicEnabled: jest.fn(async () => true),
    oldestWorkspaceId: jest.fn(async () => WS),
    stripe,
    getStripe: jest.fn(() => stripe),
    publishableKey: jest.fn(() => 'pk_test_123'),
    carts: new Map(),
    models: {
      Order: model({ workspaceId: WS, customer: CUSTOMER }),
      Service: model(null),
      TimeSlot: model(null),
      Customer: model({ _id: CUSTOMER }),
      CustomerLanguage: model(null),
    },
    ...over,
  };
}

function makeApp(deps) {
  const app = express();
  app.use(createRouter(() => deps));
  app.use((req, res) => res.status(200).send(SENTINEL));
  return app;
}
const get = (deps, url, headers = {}) => request(makeApp(deps)).get(url).set(headers);

const scriptBlocks = (html) => Array.from(html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g), (m) => m[1]);

let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('the Arabic checkout page', () => {
  test('is right-to-left Arabic with the Stripe Payment Element in Arabic', async () => {
    const deps = makeDeps();
    const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-language']).toBe('ar');
    const html = res.text;
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>إتمام الدفع</title>');
    expect(html).toContain('<h1>إتمام الدفع</h1>');
    expect(html).toContain('<script src="https://js.stripe.com/v3/"></script>');
    expect(html).toContain("stripe.elements({ clientSecret: cfg.clientSecret, locale: 'ar' })");
    expect(html).toContain("Stripe(cfg.publishableKey, { locale: 'ar' })");
    expect(html.match(/locale: 'ar'/g)).toHaveLength(2);
    expect(html).toContain("return_url: window.location.origin + '/payment-result?lang=ar'");
    expect(html).toContain("redirect: 'if_required'");
    expect(deps.stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_3Abc123');
  });

  test('every Arabic page carries the visible language switch to ?lang=en (which falls through to the untouched English page)', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).toContain('<a href="/pay/pi_3Abc123?lang=en" hreflang="en" lang="en" dir="ltr"');
    expect(html).toContain('>English</a>');
    const english = await get(makeDeps(), '/pay/pi_3Abc123?lang=en');
    expect(english.text).toBe(SENTINEL);
  });

  test('shows the order summary: Arabic labels, SAR as "150.00 ر.س", Western digits', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).toContain('الريال السعودي · إجمالي الطلب أدناه');
    expect(html).toContain('<span>المجموع الفرعي</span><span><span class="amt" dir="rtl">145.00 ر.س</span></span>');
    expect(html).toContain('<span>الشحن</span><span><span class="amt" dir="rtl">5.00 ر.س</span></span>');
    expect(html).toContain('<div class="row total"><span>الإجمالي</span><span><span class="amt" dir="rtl">150.00 ر.س</span></span></div>');
    expect(html).toContain('<button id="submit" class="pay" type="submit">ادفع <span class="amt" dir="rtl">150.00 ر.س</span></button>');
    expect(html).toContain('📍 التوصيل إلى: <bdi>Riyadh, King Fahd Rd 12</bdi>');
    expect(html).not.toMatch(/[\u{0660}-\u{0669}]/u);
  });

  test('thousands separators and rounding follow the glossary', async () => {
    const deps = makeDeps();
    deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ amount: 123456, metadata: { buyerPhone: '9665', subtotal: '1234.5', shippingCost: '0' } }));
    const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).toContain('1,234.56 ر.س');
    expect(html).toContain('1,234.50 ر.س');
  });

  test('other currencies keep their code, as a left-to-right isolate', async () => {
    const deps = makeDeps();
    deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ currency: 'aed' }));
    const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).toContain('<span class="amt" dir="ltr">150.00 AED</span>');
    expect(html).toContain('<bdi dir="ltr">AED</bdi> · إجمالي الطلب أدناه');
    expect(html).toContain('ادفع <span class="amt" dir="ltr">150.00 AED</span>');
    expect(html).not.toContain('ر.س');
  });

  test('no English interface text remains on the page', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    for (const english of ['Complete Your Payment', 'Order total below', 'Subtotal', 'Shipping', 'Delivering to', 'Cancel and return', 'Payment failed', 'Payment successful', 'Pay ']) {
      expect(html).not.toContain(english);
    }
    expect(html).not.toContain('pages.'); // a missing catalogue key would print the key itself
  });

  test('cancel link goes to the Arabic cancelled page and carries no phone number (the English link does)', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).toContain('<a class="exit" href="/payment-cancelled?lang=ar">إلغاء الدفع والعودة إلى واتساب</a>');
    expect(html).not.toContain('phone=');
    expect(html).not.toContain('966500000001');
  });

  test('the message area is OUTSIDE the form, so a success message is not hidden together with it', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    const form = html.slice(html.indexOf('<form'), html.indexOf('</form>'));
    expect(form).not.toContain('payment-message');
    expect(html).toContain('<div id="payment-message" role="alert" dir="auto"></div>');
  });

  test('the inline script is static: nothing dynamic is interpolated into it, data travels in escaped attributes', async () => {
    const deps = makeDeps();
    deps.publishableKey.mockReturnValue('pk_live_SECRETISH');
    deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({
      client_secret: 'pi_3Abc123_secret_ZZZ',
      metadata: { buyerPhone: '966500000001', subtotal: '145', shippingCost: '5', address: 'unique-address-marker' },
    }));
    const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
    const scripts = scriptBlocks(html).join('\n');
    for (const dynamic of ['pk_live_SECRETISH', 'pi_3Abc123', 'secret_ZZZ', 'unique-address-marker', '966500000001', '150.00']) {
      expect(scripts).not.toContain(dynamic);
    }
    expect(html).toContain('data-publishable-key="pk_live_SECRETISH"');
    expect(html).toContain('data-client-secret="pi_3Abc123_secret_ZZZ"');
    expect(html).toContain('data-msg-failed="تعذّر إتمام الدفع. يرجى المحاولة مرة أخرى."');
    expect(html).toContain('data-msg-success="✅ تم الدفع بنجاح! يمكنك العودة إلى واتساب الآن."');
  });

  test('the page script never injects HTML: Stripe error text goes in through textContent', async () => {
    const { CHECKOUT_SCRIPT } = require('../../shared/localization/pages/pay');
    expect(CHECKOUT_SCRIPT).toContain('messageEl.textContent = message');
    expect(CHECKOUT_SCRIPT).not.toMatch(/innerHTML|outerHTML|document\.write|insertAdjacentHTML|eval\(/);
    expect(CHECKOUT_SCRIPT).toContain('result.error.message || cfg.msgFailed');
    expect(CHECKOUT_SCRIPT).toContain('submitBtn.disabled = true');
    expect(CHECKOUT_SCRIPT).toContain("typeof Stripe !== 'function'");
  });

  test('no inline event handlers and no inline styles anywhere', async () => {
    const html = (await get(makeDeps(), '/pay/pi_3Abc123?lang=ar')).text;
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  describe('hostile data', () => {
    const HOSTILE = '<script>alert(1)</script>"><img src=x onerror=alert(2)>\'&';
    const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&gt;&lt;img src=x onerror=alert(2)&gt;&#39;&amp;';

    test('the delivery address is escaped', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ metadata: { buyerPhone: '1', subtotal: '1', shippingCost: '0', address: HOSTILE } }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain(`<bdi>${ESCAPED}</bdi>`);
      expect(html).not.toContain('<img src=x');
      expect(html).not.toContain('<script>alert');
      expect(html.match(/<script/g)).toHaveLength(2); // Stripe.js and ours - nothing injected
    });

    test('cart item names are escaped (and long ones shortened)', async () => {
      const deps = makeDeps();
      deps.carts.set('966500000001', [{ name: HOSTILE, priceAud: 100 }, { name: `${'x'.repeat(500)}`, priceAud: 45 }]);
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain(`<bdi>${ESCAPED}</bdi>`);
      expect(html).not.toContain('<img src=x');
      expect(html).toContain(`<bdi>${'x'.repeat(120)}</bdi>`);
      expect(html).not.toContain('x'.repeat(121));
    });

    test('publishable key and client secret cannot break out of their attributes', async () => {
      const deps = makeDeps();
      deps.publishableKey.mockReturnValue('pk"><script>alert(3)</script>');
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ client_secret: 's"><img src=x onerror=alert(4)>' }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain('data-publishable-key="pk&quot;&gt;&lt;script&gt;alert(3)&lt;/script&gt;"');
      expect(html).toContain('data-client-secret="s&quot;&gt;&lt;img src=x onerror=alert(4)&gt;"');
      expect(html.match(/<script/g)).toHaveLength(2);
    });

    test('bidi controls and newlines in person-written text are stripped, so they cannot reorder the page', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({
        metadata: { buyerPhone: '1', subtotal: '1', shippingCost: '0', address: 'Line1\nLine2 \u{202E}evil\u{202C}\u{200F}' },
      }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain('<bdi>Line1 Line2 evil</bdi>');
      expect(html).not.toMatch(/[\u{202A}-\u{202E}\u{200E}\u{200F}\u{2066}-\u{2069}]/u);
    });

    test('a hostile PaymentIntent id in the URL only ever appears percent-encoded inside links', async () => {
      const deps = makeDeps();
      const res = await get(deps, `/pay/${encodeURIComponent('"><script>alert(5)</script>')}?lang=ar`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('<script>alert(5)');
      expect(res.text).toContain('href="/pay/%22%3E%3Cscript%3Ealert(5)%3C%2Fscript%3E?lang=en"');
      expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    });
  });

  describe('line items from the in-memory cart', () => {
    const cart = [{ name: 'Blue Shirt', priceAud: 100 }, { name: 'قميص أحمر', priceAud: 45 }];

    test('shown, escaped and bidi-isolated, when they add up to the PaymentIntent subtotal', async () => {
      const deps = makeDeps();
      deps.carts.set('966500000001', cart);
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain('<span><bdi>Blue Shirt</bdi></span><span><span class="amt" dir="rtl">100.00 ر.س</span></span>');
      expect(html).toContain('<span><bdi>قميص أحمر</bdi></span><span><span class="amt" dir="rtl">45.00 ر.س</span></span>');
    });

    test.each([
      ['a stale cart whose prices no longer add up', [{ name: 'Blue Shirt', priceAud: 100 }]],
      ['a cart with a non-numeric price', [{ name: 'x', priceAud: 'abc' }, { name: 'y', priceAud: 45 }]],
      ['a cart with no price at all', [{ name: 'x' }]],
      ['an empty cart', []],
      ['something that is not a list', { name: 'x', priceAud: 145 }],
      ['an absurdly long cart', Array.from({ length: 51 }, () => ({ name: 'x', priceAud: 145 / 51 }))],
    ])('omitted for %s', async (label, value) => {
      const deps = makeDeps();
      deps.carts.set('966500000001', value);
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).not.toContain('<span><bdi>');
      expect(html).toContain('145.00 ر.س'); // the subtotal row is still there
    });

    test("omitted when the cart belongs to somebody else's phone number", async () => {
      const deps = makeDeps();
      deps.carts.set('966599999999', cart);
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).not.toContain('Blue Shirt');
    });

    test('never read for PaymentIntents without a subtotal (service bookings, inbox links)', async () => {
      const deps = makeDeps();
      deps.carts.set('966500000001', cart);
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ metadata: { buyerPhone: '966500000001', source: 'inbox_manual_payment_link' } }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).not.toContain('Blue Shirt');
    });
  });

  describe('PaymentIntents that are not a cart checkout', () => {
    test('an inbox payment link shows only the total (not "Subtotal 0.00 / Shipping 0.00") and never scans Orders', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ metadata: { buyerPhone: '966500000001', source: 'inbox_manual_payment_link' } }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain('<div class="row total"><span>الإجمالي</span>');
      expect(html).not.toContain('المجموع الفرعي');
      expect(html).not.toContain('الشحن');
      expect(html).not.toContain('التوصيل إلى');
      expect(deps.models.Order.calls).toEqual([]);
      expect(deps.oldestWorkspaceId).toHaveBeenCalled();
    });

    test('a service booking shows the service and the slot rebuilt from the TimeSlot (not the English slotLabel)', async () => {
      const deps = makeDeps();
      deps.models.Service = model({ workspaceId: WS });
      deps.models.TimeSlot = model({ date: '2026-10-12', startTime: '10:00' });
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({
        amount: 9000,
        metadata: {
          bookingType: 'service', buyerPhone: '966500000001', serviceId: SERVICE_ID, slotId: SLOT_ID,
          serviceName: 'Hair <b>Cut</b>', slotLabel: '2026-10-12 at 10:00',
        },
      }));
      const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
      expect(html).toContain('<span>الخدمة</span><span><bdi>Hair &lt;b&gt;Cut&lt;/b&gt;</bdi></span>');
      expect(html).toContain('<span>الموعد</span><span><bdi dir="ltr">2026-10-12</bdi> الساعة <bdi dir="ltr">10:00</bdi></span>');
      expect(html).toContain('<span>الإجمالي</span><span><span class="amt" dir="rtl">90.00 ر.س</span></span>');
      expect(html).not.toContain('2026-10-12 at 10:00');
      expect(html).not.toContain('المجموع الفرعي');
      expect(deps.models.Order.calls).toEqual([]);
      expect(deps.models.Service.calls).toEqual([{ _id: SERVICE_ID }]);
      expect(deps.models.TimeSlot.calls).toEqual([{ _id: SLOT_ID, workspaceId: WS }]); // scoped to the service's workspace
    });

    test('a slot that is missing or malformed is simply left out', async () => {
      for (const slot of [null, { date: 'tomorrow', startTime: '10:00' }, { date: '2026-10-12', startTime: '<b>' }]) {
        const deps = makeDeps();
        deps.models.Service = model({ workspaceId: WS });
        deps.models.TimeSlot = model(slot);
        deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({
          metadata: { bookingType: 'service', buyerPhone: '1', serviceId: SERVICE_ID, slotId: SLOT_ID, serviceName: 'Cut' },
        }));
        const html = (await get(deps, '/pay/pi_3Abc123?lang=ar')).text;
        expect(html).toContain('<span>الخدمة</span>');
        expect(html).not.toContain('الموعد');
      }
    });

    test('a hostile slotId / serviceId is never used in a query', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({
        metadata: { bookingType: 'service', buyerPhone: '1', serviceId: '{"$ne":null}', slotId: '{"$gt":""}', serviceName: 'Cut' },
      }));
      await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(deps.models.Service.calls).toEqual([]);
      expect(deps.models.TimeSlot.calls).toEqual([]);
    });
  });

  describe('other PaymentIntent states', () => {
    test('already paid: the Arabic paid page, no form, no Stripe script', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ status: 'succeeded' }));
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<title>تم الدفع مسبقاً</title>');
      expect(res.text).toContain('<h1>تم الدفع مسبقاً</h1>');
      expect(res.text).toContain('تم دفع هذا الطلب مسبقاً. يمكنك العودة إلى واتساب.');
      expect(res.text).not.toContain('payment-form');
      expect(res.text).not.toContain('js.stripe.com');
      expect(res.text).toContain('hreflang="en"');
      expect(res.headers['cache-control']).toBe('no-store');
    });

    test('a cancelled PaymentIntent gets the "link may have expired" page instead of a form that can only fail', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ status: 'canceled' }));
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.status).toBe(404);
      expect(res.text).toContain('رابط الدفع غير موجود');
      expect(res.text).not.toContain('payment-form');
    });

    test('statuses the English page also treats as payable still show the form', async () => {
      for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing']) {
        const deps = makeDeps();
        deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ status }));
        expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toContain('id="payment-form"');
      }
    });

    test('not found: Stripe says the id does not exist (routine, not logged)', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockRejectedValue(Object.assign(new Error('No such payment_intent'), { code: 'resource_missing' }));
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.status).toBe(404);
      expect(res.text).toContain('<title>غير موجود</title>');
      expect(res.text).toContain('<h1>رابط الدفع غير موجود</h1>');
      expect(res.text).toContain('ربما انتهت صلاحية هذا الرابط.');
      expect(res.text).toContain('hreflang="en"');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    test('any other Stripe failure is also "not found" (like the English page) but is logged', async () => {
      const deps = makeDeps();
      deps.stripe.paymentIntents.retrieve.mockRejectedValue(new Error('socket hang up'));
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.status).toBe(404);
      expect(res.text).toContain('رابط الدفع غير موجود');
      expect(errorSpy).toHaveBeenCalledWith('[localization:pages] Stripe retrieve failed:', 'socket hang up');
    });

    test('an id that cannot be a PaymentIntent is not sent to Stripe at all', async () => {
      const deps = makeDeps();
      const res = await get(deps, '/pay/not-a-payment-intent?lang=ar');
      expect(res.status).toBe(404);
      expect(res.text).toContain('رابط الدفع غير موجود');
      expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
    });
  });

  describe('when the Arabic page is NOT used (the existing English handler answers)', () => {
    async function expectEnglish(deps, url, headers) {
      const res = await get(deps, url, headers);
      expect(res.text).toBe(SENTINEL);
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers['content-language']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
    }

    test('?lang=en: instantly, with no Stripe client and no lookup', async () => {
      const deps = makeDeps();
      await expectEnglish(deps, '/pay/pi_3Abc123?lang=en', { 'Accept-Language': 'ar' });
      expect(deps.getStripe).not.toHaveBeenCalled();
      expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
      expect(deps.models.Order.calls).toEqual([]);
    });

    test('kill switch (LOCALIZATION_DISABLED)', async () => {
      const deps = makeDeps();
      deps.settings.killSwitchOn.mockReturnValue(true);
      await expectEnglish(deps, '/pay/pi_3Abc123?lang=ar', { 'Accept-Language': 'ar' });
      expect(deps.getStripe).not.toHaveBeenCalled();
    });

    test('no merchant has Arabic yet: English pays nothing (no Stripe call, no lookup)', async () => {
      const deps = makeDeps({ anyArabicEnabled: jest.fn(async () => false) });
      await expectEnglish(deps, '/pay/pi_3Abc123?lang=ar', { 'Accept-Language': 'ar' });
      expect(deps.getStripe).not.toHaveBeenCalled();
      expect(deps.models.Order.calls).toEqual([]);
    });

    test("the PaymentIntent's merchant has Arabic switched off, even though the visitor asks for Arabic", async () => {
      const deps = makeDeps();
      deps.models.Order = model({ workspaceId: OTHER_WS, customer: CUSTOMER });
      await expectEnglish(deps, '/pay/pi_3Abc123?lang=ar', { 'Accept-Language': 'ar' });
      expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(OTHER_WS);
    });

    test("the PaymentIntent's own workspace decides, not the oldest-workspace fallback", async () => {
      const deps = makeDeps({ oldestWorkspaceId: jest.fn(async () => OTHER_WS) });
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toContain('<html lang="ar" dir="rtl">');
    });

    test('an English browser and no stored language', async () => {
      await expectEnglish(makeDeps(), '/pay/pi_3Abc123', { 'Accept-Language': 'en-US,en;q=0.9' });
      await expectEnglish(makeDeps(), '/pay/pi_3Abc123');
    });

    test('a visitor with no Arabic signal and a merchant with Arabic: English', async () => {
      await expectEnglish(makeDeps(), '/pay/pi_3Abc123?lang=fr', { 'Accept-Language': 'fr-FR' });
    });

    test('Stripe not configured / no publishable key / no client secret: the English page (which has the same problem) answers', async () => {
      await expectEnglish(makeDeps({ getStripe: jest.fn(() => null) }), '/pay/pi_3Abc123?lang=ar');
      const noKey = makeDeps({ publishableKey: jest.fn(() => '') });
      await expectEnglish(noKey, '/pay/pi_3Abc123?lang=ar');
      const noSecret = makeDeps();
      noSecret.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ client_secret: undefined }));
      await expectEnglish(noSecret, '/pay/pi_3Abc123?lang=ar');
    });
  });

  describe('which language: ?lang > stored customer language > Accept-Language > English', () => {
    test('Arabic from the browser alone', async () => {
      const res = await get(makeDeps(), '/pay/pi_3Abc123', { 'Accept-Language': 'ar-SA,ar;q=0.9,en;q=0.8' });
      expect(res.text).toContain('<html lang="ar" dir="rtl">');
    });

    test('a customer whose stored language is Arabic gets Arabic even with an English browser', async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model({ language: 'ar' });
      const res = await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'en-US' });
      expect(res.text).toContain('<html lang="ar" dir="rtl">');
      expect(deps.models.CustomerLanguage.calls).toEqual([{ workspaceId: WS, customerId: CUSTOMER }]); // tenant-scoped
      expect(deps.models.Customer.calls).toEqual([]); // the Order already named the buyer
    });

    test('a customer whose stored language is English gets English even with an Arabic browser', async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model({ language: 'en' });
      expect((await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'ar' })).text).toBe(SENTINEL);
    });

    test("an 'unknown' stored language defers to the browser", async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model({ language: 'unknown' });
      expect((await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'ar' })).text).toContain('lang="ar"');
      expect((await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'en' })).text).toBe(SENTINEL);
    });

    test('?lang=ar beats a stored English language, and then no customer lookup is made at all', async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model({ language: 'en' });
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar', { 'Accept-Language': 'en' });
      expect(res.text).toContain('<html lang="ar" dir="rtl">');
      expect(deps.models.CustomerLanguage.calls).toEqual([]);
      expect(deps.models.Customer.calls).toEqual([]);
    });

    test('without an Order the buyer is found by phone inside the PaymentIntent\'s workspace', async () => {
      const deps = makeDeps();
      deps.models.Order = model(null);
      deps.models.CustomerLanguage = model({ language: 'ar' });
      const res = await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'en' });
      expect(res.text).toContain('lang="ar"');
      expect(deps.models.Customer.calls).toEqual([{ workspaceId: WS, phone: '966500000001' }]);
      expect(deps.models.CustomerLanguage.calls).toEqual([{ workspaceId: WS, customerId: CUSTOMER }]);
    });

    test('a buyer phone that is missing, huge or not a string is never looked up', async () => {
      for (const buyerPhone of [undefined, '', 'x'.repeat(40), { $ne: null }, 5]) {
        const deps = makeDeps();
        deps.models.Order = model(null);
        deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ metadata: { buyerPhone, subtotal: '1' } }));
        const res = await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'ar' });
        expect(res.text).toContain('lang="ar"');
        expect(deps.models.Customer.calls).toEqual([]);
      }
    });
  });

  describe('workspace resolution', () => {
    const resolve = (deps, pi) => require('../../shared/localization/pages/pay').resolvePaymentWorkspace(deps, pi);

    test('booking PaymentIntents: the service\'s workspace, found by id, no Order scan', async () => {
      const deps = makeDeps();
      deps.models.Service = model({ workspaceId: OTHER_WS });
      expect(await resolve(deps, makePi({ metadata: { serviceId: SERVICE_ID } }))).toEqual({ workspaceId: OTHER_WS, customerId: null });
      expect(deps.models.Order.calls).toEqual([]);
    });

    test('cart PaymentIntents: the Order named after the PaymentIntent (workspace and buyer)', async () => {
      const deps = makeDeps();
      expect(await resolve(deps, makePi())).toEqual({ workspaceId: WS, customerId: CUSTOMER });
      expect(deps.models.Order.calls).toEqual([{ stripePaymentIntentId: 'pi_3Abc123' }]);
    });

    test('everything else: the oldest workspace', async () => {
      const deps = makeDeps({ oldestWorkspaceId: jest.fn(async () => OTHER_WS) });
      deps.models.Order = model(null);
      expect(await resolve(deps, makePi())).toEqual({ workspaceId: OTHER_WS, customerId: null });
      expect(await resolve(deps, null)).toEqual({ workspaceId: OTHER_WS, customerId: null });
    });

    test('an Order without a workspace (pre-multi-tenant data) falls back instead of guessing', async () => {
      const deps = makeDeps();
      deps.models.Order = model({ customer: CUSTOMER });
      expect(await resolve(deps, makePi())).toEqual({ workspaceId: WS, customerId: null });
    });

    test('a service that does not exist falls through to the Order lookup', async () => {
      const deps = makeDeps();
      deps.models.Service = model(null);
      expect(await resolve(deps, makePi({ metadata: { serviceId: SERVICE_ID } }))).toEqual({ workspaceId: WS, customerId: CUSTOMER });
    });
  });

  describe('fails open', () => {
    test('a failing database lookup falls through to English', async () => {
      const deps = makeDeps();
      deps.models.Order = model(() => { throw new Error('cosmos 429'); });
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.text).toBe(SENTINEL);
      expect(errorSpy).toHaveBeenCalledWith('[localization:pages] falling back to the English page:', 'cosmos 429');
    });

    test('a failing flag lookup falls through to English', async () => {
      const deps = makeDeps();
      deps.settings.isArabicEnabled.mockRejectedValue(new Error('flag store down'));
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toBe(SENTINEL);
    });

    test('a failing rollout lookup falls through to English', async () => {
      const deps = makeDeps({ anyArabicEnabled: jest.fn(async () => { throw new Error('down'); }) });
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toBe(SENTINEL);
    });

    test('a failing stored-language lookup falls through to English', async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model(() => { throw new Error('boom'); });
      expect((await get(deps, '/pay/pi_3Abc123', { 'Accept-Language': 'ar' })).text).toBe(SENTINEL);
    });

    test('a failing slot lookup falls through to English (nothing half-rendered)', async () => {
      const deps = makeDeps();
      deps.models.Service = model({ workspaceId: WS });
      deps.models.TimeSlot = model(() => { throw new Error('boom'); });
      deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ metadata: { bookingType: 'service', buyerPhone: '1', serviceId: SERVICE_ID, slotId: SLOT_ID } }));
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toBe(SENTINEL);
    });

    test('a Stripe call that never answers does not hold the English page hostage', async () => {
      const deps = makeDeps({ precheckTimeoutMs: 40 });
      deps.stripe.paymentIntents.retrieve.mockImplementation(() => new Promise(() => {}));
      const started = Date.now();
      const res = await get(deps, '/pay/pi_3Abc123?lang=ar');
      expect(res.text).toBe(SENTINEL);
      expect(Date.now() - started).toBeLessThan(1500);
    });

    test('building the collaborators can fail too', async () => {
      const app = express();
      app.use(createRouter(() => { throw new Error('model failed to load'); }));
      app.use((req, res) => res.send(SENTINEL));
      expect((await request(app).get('/pay/pi_3Abc123?lang=ar')).text).toBe(SENTINEL);
    });

    test('the database being disconnected never delays English', async () => {
      const deps = makeDeps({ dbReady: () => false });
      expect((await get(deps, '/pay/pi_3Abc123?lang=ar')).text).toBe(SENTINEL);
      expect(deps.getStripe).not.toHaveBeenCalled();
      expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
    });
  });
});

describe('/payment-result', () => {
  test('success: Arabic success page', async () => {
    const deps = makeDeps();
    deps.stripe.paymentIntents.retrieve.mockResolvedValue(makePi({ status: 'succeeded' }));
    const res = await get(deps, '/payment-result?lang=ar&payment_intent=pi_3Abc123&payment_intent_client_secret=pi_3Abc123_secret_xyz&redirect_status=succeeded');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<html lang="ar" dir="rtl">');
    expect(res.text).toContain('<title>تم الدفع بنجاح</title>');
    expect(res.text).toContain('<h1>تم الدفع بنجاح!</h1>');
    expect(res.text).toContain('يمكنك العودة إلى واتساب الآن.');
    expect(res.text).toContain('href="/payment-result?payment_intent=pi_3Abc123&amp;lang=en"');
    expect(deps.stripe.paymentIntents.retrieve).toHaveBeenCalledWith('pi_3Abc123');
  });

  test('not completed: a retry link back to the Arabic payment page and a cancel link without any phone number', async () => {
    const res = await get(makeDeps(), '/payment-result?lang=ar&payment_intent=pi_3Abc123');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<title>تعذّر الدفع</title>');
    expect(res.text).toContain('<h1>لم تكتمل عملية الدفع</h1>');
    expect(res.text).toContain('لم تكتمل عملية الدفع. يمكنك المحاولة مرة أخرى أو الإلغاء.');
    expect(res.text).toContain('<a class="exit first" href="/pay/pi_3Abc123?lang=ar">حاول مرة أخرى</a>');
    expect(res.text).toContain('<a class="exit" href="/payment-cancelled?lang=ar">إلغاء الدفع والعودة إلى واتساب</a>');
    expect(res.text).not.toContain('phone=');
    expect(res.text).not.toContain('966500000001');
  });

  test('unknown status: no PaymentIntent id, a bogus one, or a lookup that fails', async () => {
    const deps = makeDeps();
    const none = await get(deps, '/payment-result?lang=ar');
    expect(none.text).toContain('<h1>حالة الدفع غير معروفة</h1>');
    expect(none.text).toContain('<title>الدفع</title>');
    expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();

    const bogus = await get(deps, '/payment-result?lang=ar&payment_intent=%3Cb%3E');
    expect(bogus.text).toContain('حالة الدفع غير معروفة');
    expect(bogus.text).not.toContain('<b>');
    expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();

    deps.stripe.paymentIntents.retrieve.mockRejectedValue(new Error('network'));
    const failing = await get(deps, '/payment-result?lang=ar&payment_intent=pi_3Abc123');
    expect(failing.status).toBe(200);
    expect(failing.text).toContain('حالة الدفع غير معروفة');
  });

  test('repeated or nested query values cannot reach Stripe or break the page', async () => {
    const deps = makeDeps();
    const repeated = await get(deps, '/payment-result?lang=ar&payment_intent=a&payment_intent=pi_3Abc123');
    expect(repeated.text).toContain('حالة الدفع غير معروفة');
    const nested = await get(deps, '/payment-result?lang=ar&payment_intent[$ne]=x');
    expect(nested.text).toContain('حالة الدفع غير معروفة');
    expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('the language switch keeps the PaymentIntent so the English page can show the result', async () => {
    const res = await get(makeDeps(), '/payment-result?lang=ar&payment_intent=pi_3Abc123');
    expect(res.text).toContain('hreflang="en"');
    expect(res.text).toContain('href="/payment-result?payment_intent=pi_3Abc123&amp;lang=en"');
  });

  test('English paths fall through untouched', async () => {
    const deps = makeDeps();
    expect((await get(deps, '/payment-result?lang=en&payment_intent=pi_3Abc123')).text).toBe(SENTINEL);
    expect(deps.getStripe).not.toHaveBeenCalled();
    deps.settings.isArabicEnabled.mockResolvedValue(false);
    expect((await get(deps, '/payment-result?payment_intent=pi_3Abc123', { 'Accept-Language': 'ar' })).text).toBe(SENTINEL);
    expect((await get(makeDeps(), '/payment-result?payment_intent=pi_3Abc123', { 'Accept-Language': 'en' })).text).toBe(SENTINEL);
  });

  test('a stored Arabic language is honoured here too (the English checkout carries no ?lang on its return_url)', async () => {
    const deps = makeDeps();
    deps.models.CustomerLanguage = model({ language: 'ar' });
    const res = await get(deps, '/payment-result?payment_intent=pi_3Abc123', { 'Accept-Language': 'en' });
    expect(res.text).toContain('lang="ar"');
  });

  test('fails open', async () => {
    const deps = makeDeps();
    deps.models.Order = model(() => { throw new Error('boom'); });
    expect((await get(deps, '/payment-result?lang=ar&payment_intent=pi_3Abc123')).text).toBe(SENTINEL);
  });
});

describe('/payment-cancelled', () => {
  test('renders the Arabic page and does NOT do what the English handler does (no cart clearing, no WhatsApp message)', async () => {
    const deps = makeDeps();
    const cart = [{ name: 'Blue Shirt', priceAud: 100 }];
    deps.carts.set('966500000001', cart);
    const deleteSpy = jest.spyOn(deps.carts, 'delete');
    const res = await get(deps, '/payment-cancelled?lang=ar&phone=966500000001');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<html lang="ar" dir="rtl">');
    expect(res.text).toContain('<title>تم الإلغاء</title>');
    expect(res.text).toContain('<h1>تم إلغاء الدفع</h1>');
    expect(res.text).toContain('ارجع إلى واتساب لمواصلة التسوق.');
    expect(res.text).toContain('href="/payment-cancelled?lang=en"');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(deps.carts.get('966500000001')).toBe(cart);
    expect(res.text).not.toContain('966500000001'); // the phone is never reflected
    expect(deps.stripe.paymentIntents.retrieve).not.toHaveBeenCalled();
  });

  test('the customer language is found through ?phone= (inside the fallback workspace) when no ?lang is given', async () => {
    const deps = makeDeps();
    deps.models.CustomerLanguage = model({ language: 'ar' });
    const res = await get(deps, '/payment-cancelled?phone=%2B966500000001', { 'Accept-Language': 'en' });
    expect(res.text).toContain('lang="ar"');
    expect(deps.models.Customer.calls).toEqual([{ workspaceId: WS, phone: '966500000001' }]);
    expect(deps.models.CustomerLanguage.calls).toEqual([{ workspaceId: WS, customerId: CUSTOMER }]);
  });

  test.each([['abc'], ['1234'], ['1'.repeat(25)], ['']])('a phone that is not plausible (%j) is not looked up', async (phone) => {
    const deps = makeDeps();
    const res = await get(deps, `/payment-cancelled?phone=${phone}`, { 'Accept-Language': 'ar' });
    expect(res.text).toContain('lang="ar"');
    expect(deps.models.Customer.calls).toEqual([]);
  });

  test('English paths fall through, and the English handler keeps its own behaviour', async () => {
    const deps = makeDeps();
    expect((await get(deps, '/payment-cancelled?lang=en&phone=966500000001')).text).toBe(SENTINEL);
    expect((await get(deps, '/payment-cancelled?phone=966500000001', { 'Accept-Language': 'en' })).text).toBe(SENTINEL);
    deps.settings.isArabicEnabled.mockResolvedValue(false);
    expect((await get(deps, '/payment-cancelled?lang=ar')).text).toBe(SENTINEL);
  });

  test('fails open', async () => {
    const deps = makeDeps({ oldestWorkspaceId: jest.fn(async () => { throw new Error('boom'); }) });
    expect((await get(deps, '/payment-cancelled?lang=ar')).text).toBe(SENTINEL);
  });
});

describe('layout helpers', () => {
  test('escapeHtml escapes the five HTML-significant characters and tolerates non-strings', () => {
    expect(layout.escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
    expect(layout.escapeHtml(null)).toBe('');
    expect(layout.escapeHtml(undefined)).toBe('');
    expect(layout.escapeHtml(0)).toBe('0');
    expect(layout.escapeHtml('مرحباً')).toBe('مرحباً');
  });

  test('cleanText: one line, no control or bidi characters, shortened by code points', () => {
    expect(layout.cleanText('  a\n\tb\r\n  c  ')).toBe('a b c');
    expect(layout.cleanText('x\u{202E}y\u{200F}z\u{2066}w\u{2069}')).toBe('x y z w');
    expect(layout.cleanText('a\u{2028}b\u{2029}c\u{0007}d')).toBe('a b c d');
    expect(layout.cleanText('👍'.repeat(5), 3)).toBe('👍👍👍');
    expect(layout.cleanText('abcdef', 3)).toBe('abc');
    expect(layout.cleanText('ab  ', 3)).toBe('ab');
    expect(layout.cleanText(null)).toBe('');
    expect(layout.cleanText(undefined)).toBe('');
    expect(layout.cleanText(42)).toBe('42');
    expect(layout.cleanText('محمد الأحمد')).toBe('محمد الأحمد');
  });

  test('fill puts ready-made HTML into escaped catalogue text and leaves unknown placeholders alone', () => {
    expect(layout.fill('pay.deliveringTo', { address: '<bdi>x</bdi>' })).toBe('📍 التوصيل إلى: <bdi>x</bdi>');
    expect(layout.fill('pay.deliveringTo')).toBe('📍 التوصيل إلى: {address}');
    expect(layout.fill('pay.deliveringTo', { constructor: 'x', toString: 'y' })).toBe('📍 التوصيل إلى: {address}');
    expect(layout.fill('pay.slot', { date: 'D', time: 'T' })).toBe('D الساعة T');
  });

  test.each([
    [1234.5, '1,234.50'], [0, '0.00'], [150, '150.00'], [12.3, '12.30'], [1000000, '1,000,000.00'], [999.999, '1,000.00'],
    ['150', '150.00'], [-5, '-5.00'], [-0.001, '0.00'], [-1234.5, '-1,234.50'],
    [NaN, '0.00'], [undefined, '0.00'], [null, '0.00'], ['abc', '0.00'], [Infinity, '0.00'], [1e12, '0.00'], [999999999999.99, '999,999,999,999.99'],
  ])('formatNumber(%j) = %s', (value, expected) => {
    expect(layout.formatNumber(value)).toBe(expected);
  });

  test('amountHtml: SAR reads number then ر.س; everything else keeps its code as an LTR isolate', () => {
    expect(layout.amountHtml(150, 'SAR')).toBe('<span class="amt" dir="rtl">150.00 ر.س</span>');
    expect(layout.amountHtml(150, 'sar')).toBe('<span class="amt" dir="rtl">150.00 ر.س</span>');
    expect(layout.amountHtml(150, 'AED')).toBe('<span class="amt" dir="ltr">150.00 AED</span>');
    expect(layout.amountHtml(1234.5, 'usd')).toBe('<span class="amt" dir="ltr">1,234.50 USD</span>');
    expect(layout.amountHtml(150, '')).toBe('<span class="amt" dir="ltr">150.00</span>');
    expect(layout.amountHtml(150, undefined)).toBe('<span class="amt" dir="ltr">150.00</span>');
    expect(layout.amountHtml(150, '<b>x')).toBe('<span class="amt" dir="ltr">150.00 &lt;B&gt;X</span>');
  });

  test('queryString encodes values, keeps order and skips empty ones', () => {
    expect(layout.queryString({ lang: 'en', src: 'a b&c', medium: 'مرحبا', x: '', y: undefined, z: null })).toBe('?lang=en&src=a%20b%26c&medium=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7');
    expect(layout.queryString({})).toBe('');
    expect(layout.queryString({ a: '' })).toBe('');
  });

  test('the shell escapes its title and always links to ?lang=en', () => {
    const html = layout.renderPage({ title: '<x>"', body: '<p>b</p>', switchHref: '/p?a=1&b=2' });
    expect(html).toContain('<title>&lt;x&gt;&quot;</title>');
    expect(html).toContain('href="/p?a=1&amp;b=2"');
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });

  test('the stylesheet is logical-only, system-font-only and loads nothing from anywhere', () => {
    expect(layout.CSS).not.toMatch(/\b(left|right)\b/i);
    expect(layout.CSS).not.toMatch(/margin-(top|bottom)|padding-(top|bottom)/);
    expect(layout.CSS).toContain('letter-spacing:0');
    expect(layout.CSS).toContain('"Noto Sans Arabic"');
    expect(layout.CSS).not.toMatch(/@import|@font-face|url\(|https?:/i);
    expect(layout.CSS).toContain('prefers-color-scheme:dark');
  });
});
