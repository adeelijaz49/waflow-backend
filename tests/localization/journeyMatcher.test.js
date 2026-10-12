// Unit tests for the shopping-journey reverse matcher (shared/localization/journeyMatcher.js, design D3).
// The English side is the REAL output of the utils/whatsapp.js builders (axios stubbed: nothing leaves the machine) plus
// literal fixtures of the server.js message strings; the Arabic side is the real catalogue. The webhook-level drift test
// (arabicJourney.itest.js) drives the real handlers; this file pins the matcher's own rules and Arabic edge cases.
jest.mock('../../utils/tokenManager', () => ({ getToken: () => 'dummy-token' }));
jest.mock('../../utils/settingsCache', () => ({ getCurrency: async () => 'SAR' }));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const catalog = require('../../shared/localization/catalog');
const { createMatcher, entriesFromCatalog, arMoney } = require('../../shared/localization/journeyMatcher');
const { containsArabic } = require('../../shared/localization/arabicText');
const wa = require('../../utils/whatsapp');

const LRM = '\u{200E}';
const TO = '966500000001';
const entries = entriesFromCatalog(catalog);
const matcher = createMatcher(entries);

const NAMES = { 'Blue Shirt': { ar: 'قميص أزرق', description: 'قميص قطني مريح' }, Massage: { ar: 'جلسة مساج' }, 'Red Hat': { ar: 'قبعة حمراء' } };
const BYID = { p1: 'قميص أزرق', p2: 'قبعة حمراء' };
const ctx = {
  names: {
    name: (kind, raw) => { const m = /^(.*?) \(([^()]+)\)$/.exec(raw); const base = m ? m[1] : raw; const e = NAMES[base]; if (!e) return raw; return m ? `${e.ar} (${m[2]})` : e.ar; },
    byId: (kind, id) => BYID[id] || null,
    description: (kind, name, en) => (NAMES[name] && NAMES[name].description) || en,
  },
  payUrl: (u) => (/\/pay\/pi_[A-Za-z0-9_]+$/.test(u) ? `${u}?lang=ar` : u),
};

const text = (body, to = TO) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { body } });
const buttons = (body, list, to = TO) => ({ messaging_product: 'whatsapp', to, type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: list.map(([id, title]) => ({ type: 'reply', reply: { id, title } })) } } });
const L = (payload, c = ctx) => matcher.localize(payload, c);
const bodyOf = (p) => (p.type === 'text' ? p.text.body : p.interactive.body.text);

// every customer-visible string of a payload, with the limit it must respect
function visibleStrings(p) {
  const out = [];
  if (p.type === 'text') { out.push(['text', p.text.body, 4096]); return out; }
  const it = p.interactive;
  if (it.header && it.header.text) out.push(['header', it.header.text, 60]);
  if (it.body) out.push(['body', it.body.text, 1024]);
  if (it.footer) out.push(['footer', it.footer.text, 60]);
  if (it.type === 'button') it.action.buttons.forEach((b) => out.push(['button', b.reply.title, 20]));
  if (it.type === 'list') {
    out.push(['listButton', it.action.button, 20]);
    it.action.sections.forEach((s) => { out.push(['section', s.title, 24]); s.rows.forEach((r) => { out.push(['rowTitle', r.title, 24]); if (r.description) out.push(['rowDesc', r.description, 72]); }); });
  }
  return out;
}
const cp = (s) => Array.from(s).length;
function expectLimits(p) { for (const [kind, s, max] of visibleStrings(p)) expect([kind, cp(s) <= max, s]).toEqual([kind, true, s]); }
const BIDI_OR_ZW = /[\u{200B}-\u{200D}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{061C}\u{FEFF}]/u;

describe('catalogue namespace', () => {
  test('journey.* is loaded, drafts only, no Latin WhatsApp, no hidden characters', () => {
    const journey = [...entries].filter(([k]) => k.startsWith('journey.'));
    expect(journey.length).toBeGreaterThan(70);
    for (const [k, e] of journey) {
      expect([k, e.status]).toEqual([k, 'draft']);
      expect([k, /whatsapp/i.test(e.ar)]).toEqual([k, false]);
      expect([k, BIDI_OR_ZW.test(e.ar) || BIDI_OR_ZW.test(e.en)]).toEqual([k, false]);
      if (/[A-Za-z]/.test(e.en.replace(/{[A-Za-z0-9]+}/g, ''))) expect([k, containsArabic(e.ar)]).toEqual([k, true]); // a pure-placeholder entry has no words to translate
    }
  });
  test('the existing consent.* and inbox.* strings are reused (no duplicates under journey.*)', () => {
    for (const k of ['consent.optOutAck', 'consent.optInAck', 'consent.declineAck', 'consent.startAck', 'consent.startNoConsent', 'consent.askSuffix', 'consent.buttonOptIn', 'consent.buttonDecline', 'inbox.paymentLink']) expect(entries.has(k)).toBe(true);
    for (const [k] of entries) expect(k.startsWith('journey.consent')).toBe(false);
  });
  test('placeholders: every journey.* Arabic string has exactly the placeholders of its English one', () => {
    const names = (s) => [...s.matchAll(/\{([A-Za-z0-9]+)\}/g)].map((m) => m[1]).sort();
    for (const [k, e] of entries) if (k.startsWith('journey.')) expect([k, names(e.ar).filter((n) => n !== 's')]).toEqual([k, names(e.en).filter((n) => n !== 's')]);
  });
});

describe('real utils/whatsapp.js builders', () => {
  let sent;
  beforeEach(() => { sent = []; axios.post.mockReset(); axios.post.mockImplementation(async (url, body) => { sent.push(body); return { data: { messages: [{ id: 'wamid.stub' }] } }; }); });

  const products = [
    { _id: 'p1', name: 'Blue Shirt', basePrice: 100, description: 'Comfortable cotton shirt, long text '.repeat(6), images: [], variants: [{ size: 'M', color: 'Blue', stock: 3 }], stock: 5 },
    { _id: 'p2', name: 'Red Hat', basePrice: 40, description: '', images: [], variants: [], stock: 2 },
  ];
  const sale = { _id: 'pr1', name: 'Summer Sale', discountPercent: 15, customerType: 'cash', pointsPrice: 0 };
  const pointsPromo = { _id: 'pr2', name: 'Points Week', discountPercent: 0, customerType: 'points', pointsPrice: 200 };

  test('catalogue list (<= 10): sale, points and no promotion', async () => {
    await wa.sendCatalog(TO, products, sale); await wa.sendCatalog(TO, products, pointsPromo); await wa.sendCatalog(TO, products, null);
    expect(sent).toHaveLength(3);
    sent.forEach((p) => { const r = L(p); expect(r).not.toBeNull(); expect(r.shape).toBe('catalogList'); expectLimits(r.payload); });
    const r = L(sent[0]);
    expect(r.payload.interactive.header.text).toContain('15');
    expect(r.payload.interactive.action.sections[0].rows.map((x) => x.title)).toEqual(['قميص أزرق', 'قبعة حمراء']); // names by id
    expect(r.payload.interactive.action.sections[0].rows.map((x) => x.id)).toEqual(sent[0].interactive.action.sections[0].rows.map((x) => x.id)); // ids untouched
    expect(r.payload.interactive.action.sections[0].rows[0].description).toContain('ر.س');
    expect(r.payload.interactive.action.sections[0].rows[0].description).not.toMatch(/SAR/);
  });

  test('catalogue as numbered text (> 10 products), both customer types', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ _id: `m${i}`, name: i % 2 ? 'Blue Shirt' : 'Red Hat', basePrice: 10 + i }));
    await wa.sendCatalog(TO, many, sale); await wa.sendCatalog(TO, many, pointsPromo);
    expect(sent).toHaveLength(2);
    sent.forEach((p) => { expect(p.type).toBe('text'); const r = L(p); expect(r).not.toBeNull(); expectLimits(r.payload); });
    const ar = bodyOf(L(sent[0]).payload);
    expect(ar).toContain('قميص أزرق');
    expect(ar).toContain('قبعة حمراء');
    expect(ar.split(LRM).join('')).toMatch(/1\. \*قبعة حمراء\*/);
    expect(ar.split('\n').length).toBe(bodyOf(sent[0]).split('\n').length); // same line structure
  });

  test('product cards: names, Arabic description (cut at 150), plain/sale/points', async () => {
    await wa.sendProductCards(TO, products, sale); await wa.sendProductCards(TO, products, pointsPromo); await wa.sendProductCards(TO, products, null);
    expect(sent).toHaveLength(6);
    sent.forEach((p) => { const r = L(p); expect(r).not.toBeNull(); expect(r.shape).toMatch(/^card/); expectLimits(r.payload); expect(r.payload.interactive.action.buttons[0].reply.id).toBe(p.interactive.action.buttons[0].reply.id); });
    expect(bodyOf(L(sent[0]).payload)).toContain('قميص قطني مريح'); // the Arabic description replaces the English one
    expect(bodyOf(L(sent[1]).payload)).toContain('قبعة حمراء'); // no description: nothing appended
  });

  test('"See next" card, variants picker and slot lists', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ _id: `m${i}`, name: 'Red Hat', basePrice: 10 + i, description: '', images: [], variants: [], stock: 1 }));
    await wa.sendProductCarousel(TO, many, sale, 0);
    await wa.sendVariantPicker(TO, products[0], sale); await wa.sendVariantPicker(TO, products[0], pointsPromo);
    const svc = { _id: 's1', name: 'Massage', duration: 60 };
    const slots = [{ _id: 'sl1', date: '2030-01-15', startTime: '09:00', endTime: '10:00', capacity: 3, bookedCount: 2 }, { _id: 'sl2', date: '2030-01-15', startTime: '10:00', endTime: '11:00', capacity: 3, bookedCount: 0 }];
    await wa.sendServiceSlots(TO, svc, slots, 'pr1', false); await wa.sendServiceSlots(TO, svc, slots, null, true); await wa.sendServiceSlots(TO, svc, [], 'pr1', false);
    expect(sent.length).toBeGreaterThanOrEqual(6);
    let matched = 0;
    for (const p of sent) { const r = L(p); if (r) { matched += 1; expectLimits(r.payload); } }
    expect(matched).toBe(sent.length); // nothing the builders send stays English
    const slotsMsg = sent.find((p) => p.interactive && p.interactive.header && /Book/.test(p.interactive.header.text));
    expect(L(slotsMsg).payload.interactive.header.text).toContain('جلسة مساج');
    const none = sent[sent.length - 1];
    expect(bodyOf(none)).toMatch(/no available slots/);
    expect(bodyOf(L(none).payload)).toContain('جلسة مساج');
  });
});

describe('server.js message literals (fixtures)', () => {
  const cases = [
    ['order summary', '🛒 *Your Order Summary*\n\n1. Blue Shirt (M · Blue) — 100.00 SAR\n2. Red Hat — 25.00 SAR\n\nSubtotal: 125.00 SAR\nShipping: 0.50 SAR\n*Total: 125.50 SAR*\n\n📍 Delivering to:\n12 King Fahd Rd\nRiyadh 12345\n\nPay securely:\nhttps://app.example/pay/pi_3Abc123', 'orderSummary'],
    ['checkout unavailable', 'Sorry, checkout is unavailable right now. Please try again.', 'checkoutUnavailable'],
    ['points short', '⚠️ You need 400 pts but only have 100 pts. Add fewer items or earn more points first.', 'pointsShort'],
    ['slot taken', '⚠️ Sorry, that slot just got booked up. Please pick another time.', 'slotTaken'],
    ['happy shopping', '🛍️ Happy shopping! Take your time browsing our latest collection.', 'happyShopping'],
    ['no profile', "We couldn't find your profile. Please contact support.", 'noProfile'],
    ['opt-out ack (existing consent key)', "You've been unsubscribed from promotional messages. Reply START to opt back in anytime.", 'optOutAck'],
    ['start ack', "You're subscribed to promotional messages again. Welcome back! 🎉", 'startAck'],
    ['no products promo', 'Sorry, no products are available for this promotion right now.', 'noProductsPromo'],
    ['booked free', '✅ *Booked!* Your appointment for *Massage* on *2030-01-15 at 09:00* is confirmed.\n\nSee you then! 🎉', 'bookedFree'],
    ['no worries', '👍 No worries! Your points are safe. Feel free to browse again anytime.', 'noWorries'],
  ];
  test.each(cases)('%s', (label, english, shape) => {
    const r = L(text(english));
    expect(r).not.toBeNull();
    expect(r.shape).toContain(shape);
    expect(containsArabic(bodyOf(r.payload))).toBe(true);
    expect(bodyOf(r.payload)).not.toMatch(/Sorry|Total|Please|unsubscribed|Welcome/);
    expectLimits(r.payload);
    expect(r.keys.length).toBeGreaterThan(0);
  });

  test('order summary: product names, SAR sign, pay link gets ?lang=ar, address and numbers verbatim', () => {
    const r = L(text(cases[0][1]));
    const ar = bodyOf(r.payload);
    expect(ar).toContain('قميص أزرق (M · Blue)');
    expect(ar).toContain('قبعة حمراء');
    expect(ar).toContain('125.50 ر.س');
    expect(ar).toContain('https://app.example/pay/pi_3Abc123?lang=ar');
    expect(ar).toContain('12 King Fahd Rd\nRiyadh 12345');
    expect(ar).not.toMatch(/SAR/);
  });

  test('good-choice buttons, cart-added card (cash, discount, singular/plural, points), pay-later', () => {
    const good = L(buttons('Great choice! 🎉 What would you like to do next?', [['continue_shopping', 'Keep Shopping'], ['checkout', 'Checkout ✅']]));
    expect(good.shape).toContain('goodChoice');
    expect(good.payload.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['continue_shopping', 'checkout']);
    expectLimits(good.payload);

    const cash1 = L(buttons('✅ *Red Hat* added!\n💰 40.00 SAR\n\n🛒 Cart: 1 item · 40.00 SAR total\n\n_Keep tapping cards to add more, or checkout when ready._', [['continue_shopping', 'Keep Browsing 🛍️'], ['checkout', 'Checkout ✅']]));
    expect(cash1.shape).toContain('added');
    expect(bodyOf(cash1.payload)).toContain('*قبعة حمراء*'); // no direction mark inside the bold pair
    expect(bodyOf(cash1.payload)).not.toContain(`*${LRM}`);
    const disc = L(buttons('✅ *Red Hat* added!\n💰 34.00 SAR (15% OFF)\n\n🛒 Cart: 3 items · 90.00 SAR total\n\n_Keep tapping cards to add more, or checkout when ready._', [['continue_shopping', 'Keep Browsing 🛍️'], ['checkout', 'Checkout ✅']]));
    expect(bodyOf(disc.payload)).toContain('15');
    expect(bodyOf(disc.payload)).toContain('%');
    expect(bodyOf(disc.payload)).toContain('34.00 ر.س');
    const pts = L(buttons('✅ *Red Hat* added!\n💎 200 pts\n\n🛒 Cart: 2 items · 400 pts total\n\n_Keep tapping cards to add more, or checkout when ready._', [['continue_shopping', 'Keep Browsing 🛍️'], ['points_checkout', 'Redeem Points 💎']]));
    expect(pts).not.toBeNull();
    expect(pts.payload.interactive.action.buttons[1].reply.id).toBe('points_checkout');

    const later = L(buttons('Prefer to pay when you arrive?', [['paylater_sl1', 'Reserve, Pay in Person']]));
    expect(later.shape).toContain('payLater');
    expect(later.payload.interactive.action.buttons[0].reply.title).toBe('احجز وادفع حضورياً'); // R3-03: one phrase for paying in person
  });

  test('consent carrier over a utility body: body + both buttons Arabic, ids kept', () => {
    const ask = entries.get('consent.askSuffix').en;
    const p = buttons(`✅ Payment of 100.00 SAR received! Your order is confirmed.\n\n🎁 You've earned *100 loyalty points*! Thank you for shopping with us! 🎉\n\n${ask}`, [['consent_yes_64b64b64b64b64b64b64b64b', 'Yes, sign me up'], ['consent_no_64b64b64b64b64b64b64b64b', 'No thanks']]);
    const r = L(p);
    expect(r).not.toBeNull();
    expect(r.shape).toContain('consentCarrier');
    expect(r.payload.interactive.action.buttons.map((b) => b.reply.id)).toEqual(['consent_yes_64b64b64b64b64b64b64b64b', 'consent_no_64b64b64b64b64b64b64b64b']);
    expect(r.payload.interactive.action.buttons.map((b) => b.reply.title)).toEqual([entries.get('consent.buttonOptIn').ar, entries.get('consent.buttonDecline').ar]);
    expect(bodyOf(r.payload)).toContain('100.00 ر.س');
    expectLimits(r.payload);
    expect(r.keys).toEqual(expect.arrayContaining(['consent.askSuffix', 'consent.buttonOptIn', 'consent.buttonDecline']));
  });
});

describe('Arabic edge cases', () => {
  const added = (name, price = '40.00 SAR') => `✅ *${name}* added!\n💰 ${price}\n\n🛒 Cart: 1 item · ${price} total\n\n_Keep tapping cards to add more, or checkout when ready._`;
  const addedButtons = [['continue_shopping', 'Keep Browsing 🛍️'], ['checkout', 'Checkout ✅']];

  test('a Latin product name without a translation stays Latin inside the Arabic sentence', () => {
    const r = L(buttons(added('Nike Air Max 90'), addedButtons));
    expect(bodyOf(r.payload)).toContain('*Nike Air Max 90*');
  });
  test('Latin numbers/amount values outside bold get LRM protection; inside * or _ they do not', () => {
    const r = L(buttons(added('Red Hat', '40.00 AUD'), addedButtons));
    const ar = bodyOf(r.payload);
    expect(ar).toContain(`${LRM}40.00 AUD${LRM}`); // foreign currency kept and protected
    expect(ar).not.toMatch(/\*\u{200E}|\u{200E}\*|_\u{200E}/u);
  });
  test('currencies: SAR -> ر.س, AED -> د.إ, dollar sign / unknown codes untouched', () => {
    expect(arMoney('150.00 SAR')).toBe('150.00 ر.س');
    expect(arMoney('7.50 AED')).toBe('7.50 د.إ');
    expect(arMoney('$12.50')).toBe('$12.50');
    expect(arMoney('100.00 AUD')).toBe('100.00 AUD');
    expect(arMoney('-5.00 SAR')).toBe('-5.00 ر.س');
  });
  test('emoji and punctuation in a product name survive', () => {
    const r = L(buttons(added('Cake 🎂 (large)'), addedButtons));
    expect(r).not.toBeNull();
    expect(bodyOf(r.payload)).toContain('Cake 🎂 (large)');
  });
  test('a very long (300 character) product name: still matches while the text limit holds', () => {
    const name = 'A'.repeat(300);
    const r = L(text(`Sorry, no products are available for this promotion right now.`));
    expect(r).not.toBeNull();
    const added300 = L(buttons(added(name), addedButtons));
    expect(added300).not.toBeNull();
    expect(bodyOf(added300.payload)).toContain(name);
  });
  test('over the WhatsApp body limit after translation: the whole message stays English (null)', () => {
    const name = 'B'.repeat(1000);
    expect(L(buttons(added(name), addedButtons))).toBeNull();
  });
  test('row title from a long Arabic name is cut to 24 code points', () => {
    const longCtx = { ...ctx, names: { ...ctx.names, byId: () => 'ا'.repeat(40) } };
    const english = { messaging_product: 'whatsapp', to: TO, type: 'interactive', interactive: { type: 'list', header: { type: 'text', text: '🛍️ Browse Products' }, body: { text: 'Tap a product to add it to your cart. You can select multiple items one by one.' }, footer: { text: 'Prices shown are after discount' }, action: { button: 'View Products', sections: [{ title: 'Products on Sale', rows: [{ id: 'cart_p1', title: 'Blue Shirt', description: '40.00 SAR (was 50.00 SAR)' }] }] } } };
    const r = L(english, longCtx);
    expect(cp(r.payload.interactive.action.sections[0].rows[0].title)).toBe(24);
  });
  test('multi-line addresses and ISO dates are carried verbatim; Western digits stay Western', () => {
    const r = L(text('📍 Please reply with your delivery address (street, suburb, state, postcode) so we can calculate shipping.'));
    expect(r).not.toBeNull();
    const booked = L(text('✅ *Booked!* Your appointment for *Blue Shirt Fitting* on *2030-01-15 at 09:00* is confirmed.\n\nSee you then! 🎉'));
    const ar = bodyOf(booked.payload);
    expect(ar).toContain('2030-01-15');
    expect(ar).toContain('الساعة');
    expect(ar).not.toMatch(/[\u{0660}-\u{0669}]/u);
  });
  test('mixed Arabic/English customer text is not touched (only exact English shapes match)', () => {
    expect(L(text('Hello مرحبا, your order is on its way'))).toBeNull();
    expect(L(text('تم استلام طلبك'))).toBeNull();
  });
});

describe('strictness: everything else stays English (null)', () => {
  test('merchant free text, drifted copy, templates, already-Arabic text', () => {
    expect(L(text('Hello! Your order is on its way, thanks for waiting.'))).toBeNull();
    expect(L(text('Sorry, checkout is not available at the moment. Please try again.'))).toBeNull();
    expect(L({ messaging_product: 'whatsapp', to: TO, type: 'template', template: { name: 'x', language: { code: 'en' } } })).toBeNull();
    expect(L(text('عذراً، خدمة الدفع غير متاحة حالياً. يرجى المحاولة مرة أخرى.'))).toBeNull();
  });
  test('one drifted button keeps the WHOLE message English', () => {
    expect(L(buttons('Great choice! 🎉 What would you like to do next?', [['continue_shopping', 'Keep Shopping'], ['checkout', 'Pay now']]))).toBeNull();
  });
  test('an unknown button id keeps the whole message English', () => {
    expect(L(buttons('Great choice! 🎉 What would you like to do next?', [['continue_shopping', 'Keep Shopping'], ['something_else', 'Checkout ✅']]))).toBeNull();
  });
  test('missing/odd payloads never throw', () => {
    for (const p of [null, undefined, {}, { messaging_product: 'whatsapp' }, { messaging_product: 'whatsapp', to: 5 }, text(undefined), { messaging_product: 'whatsapp', to: TO, type: 'interactive' }, { messaging_product: 'whatsapp', to: TO, type: 'interactive', interactive: { type: 'list', action: {} } }]) {
      expect(() => L(p)).not.toThrow();
      expect(L(p)).toBeNull();
    }
  });
  test('a translation entry without Arabic text keeps the message English', () => {
    const local = new Map(entries); local.set('journey.text.happyShopping', { ...local.get('journey.text.happyShopping'), ar: '' });
    expect(createMatcher(local).localize(text('🛍️ Happy shopping! Take your time browsing our latest collection.'), ctx)).toBeNull();
  });
  test('an Arabic template with an unresolvable placeholder never leaks "{...}"', () => {
    const local = new Map(entries); local.set('journey.text.noWorries', { ...local.get('journey.text.noWorries'), ar: 'لا بأس {missing}' });
    expect(createMatcher(local).localize(text('👍 No worries! Your points are safe. Feel free to browse again anytime.'), ctx)).toBeNull();
  });
});

describe('result metadata', () => {
  test('the input payload is never mutated and unrelated keys are preserved', () => {
    const p = buttons('Great choice! 🎉 What would you like to do next?', [['continue_shopping', 'Keep Shopping'], ['checkout', 'Checkout ✅']]);
    p.recipient_type = 'individual';
    const snapshot = JSON.stringify(p);
    const r = L(p);
    expect(JSON.stringify(p)).toBe(snapshot);
    expect(r.payload.recipient_type).toBe('individual');
    expect(r.payload).not.toBe(p);
    expect(r.keys).toEqual(expect.arrayContaining(['journey.goodChoice.body', 'journey.btn.keepShopping', 'journey.btn.checkout']));
  });
  test('translate() helper: one string against a key list', () => {
    const t = matcher.translate(['journey.btn.checkout'], 'Checkout ✅', ctx);
    expect(t).toEqual({ key: 'journey.btn.checkout', text: 'إتمام الطلب ✅' });
    expect(matcher.translate(['journey.btn.checkout'], 'Pay', ctx)).toBeNull();
  });
});
