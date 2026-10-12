// FIX-Y (review R3): the ONE session bidi rule in the journey matcher, the 60-character header budget, money grouping, and the
// real English builders with worst-case data (long names, 150.00 SAR, emoji). The English side is the real utils/whatsapp.js
// output (axios stubbed: nothing leaves the machine); the Arabic side is the real catalogue.
jest.mock('../../utils/tokenManager', () => ({ getToken: () => 'dummy-token' }));
jest.mock('../../utils/settingsCache', () => ({ getCurrency: async () => 'SAR' }));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

const axios = require('axios');
const catalog = require('../../shared/localization/catalog');
const { createMatcher, entriesFromCatalog, arMoney } = require('../../shared/localization/journeyMatcher');
const senderValues = require('../../shared/localization/senderValues');
const bidi = require('../../shared/localization/sessionBidi');
const wa = require('../../utils/whatsapp');

const LRM = '\u{200E}';
const TO = '966500000001';
const matcher = createMatcher(entriesFromCatalog(catalog));
const NAMES = { Massage: 'جلسة مساج', 'Red Hat': 'قبعة حمراء' };
const ctx = {
  names: { name: (kind, raw) => NAMES[raw] || raw, byId: () => null, description: (kind, name, en) => en },
  payUrl: (u) => `${u}?lang=ar`,
};
const text = (body) => ({ messaging_product: 'whatsapp', to: TO, type: 'text', text: { body } });
const buttons = (body, list) => ({ messaging_product: 'whatsapp', to: TO, type: 'interactive', interactive: { type: 'button', body: { text: body }, action: { buttons: list.map(([id, title]) => ({ type: 'reply', reply: { id, title } })) } } });
const L = (payload) => matcher.localize(payload, ctx);
const bodyOf = (p) => (p.type === 'text' ? p.text.body : p.interactive.body.text);
const cp = (s) => Array.from(s).length;

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
function expectLimits(p) { for (const [kind, s, max] of visibleStrings(p)) expect([kind, cp(s) <= max, s]).toEqual([kind, true, s]); }
const MARK_NEXT_TO_FORMAT = /[*_]\u{200E}|\u{200E}[*_]/u;
const boldSpans = (s) => Array.from(s.matchAll(/\*[^*\n]+\*/g), (m) => m[0]);
const ADDED = (name, price, total) => `✅ *${name}* added!\n💰 ${price}\n\n🛒 Cart: 12 items · ${total} total\n\n_Keep tapping cards to add more, or checkout when ready._`;
const ADDED_BUTTONS = [['continue_shopping', 'Keep Browsing 🛍️'], ['checkout', 'Checkout ✅']];

describe('sessionBidi: the rule itself', () => {
  test('markAllowed: false when the character before OR after the value is * or _ ; true otherwise', () => {
    const t = (s, v) => bidi.markAllowed(s, s.indexOf(v), v.length);
    expect(t('*Total: 150*', '150')).toBe(false); // after: *
    expect(t('x 150 total*', '150')).toBe(true); // before: space, after: space (the asterisk is further away)
    expect(t('*{x}* tail', '{x}')).toBe(false); // both
    expect(t('_{x}_', '{x}')).toBe(false);
    expect(t('a {x} b', '{x}')).toBe(true);
    expect(t('{x}', '{x}')).toBe(true); // string edges
    expect(t('(قيمة {x})_', '{x}')).toBe(true); // ) is not a delimiter, even if the italic closes later
  });
  test('fillFields: Latin/number values are isolated, never next to * or _ , links and flagged values are left alone, missing fields are reported', () => {
    const values = { a: 'Sara', b: '500', c: 'https://x.example/p', d: 'ليلى' };
    const r = bidi.fillFields('مرحباً {a}! *{b}* و {b}* و _{a}_ و {c} و {d} {zzz}', (name) => (name in values ? { value: values[name], isolate: name !== 'c' } : null));
    expect(r.missing).toEqual(['zzz']);
    expect(r.text).toBe(`مرحباً ${LRM}Sara${LRM}! *500* و 500* و _Sara_ و https://x.example/p و ليلى {zzz}`);
  });
  test('the env kill switch removes every mark', () => {
    const before = process.env.LOCALIZATION_WRAP_SESSION_LRM;
    process.env.LOCALIZATION_WRAP_SESSION_LRM = '0';
    try { expect(bidi.fillFields('يا {a}!', () => ({ value: 'Sara' })).text).toBe('يا Sara!'); } finally { if (before === undefined) delete process.env.LOCALIZATION_WRAP_SESSION_LRM; else process.env.LOCALIZATION_WRAP_SESSION_LRM = before; }
  });
});

describe('R3-04 in the journey matcher: no mark next to * or _ ; a nested placeholder is never wrapped inside bold', () => {
  test('booked (free): the nested slot inside *bold* carries no mark at all, not even around its own date and time', () => {
    const r = L(text('✅ *Booked!* Your appointment for *Massage* on *2030-01-15 at 09:00* is confirmed.\n\nSee you then! 🎉'));
    const ar = bodyOf(r.payload);
    expect(ar).toContain('*2030-01-15 الساعة 09:00*');
    expect(ar).toContain('*جلسة مساج*');
    expect(ar).not.toMatch(MARK_NEXT_TO_FORMAT);
    for (const span of boldSpans(ar)) expect(span).not.toContain(LRM);
  });
  test('the same nested slot OUTSIDE bold keeps the existing default marks', () => {
    const r = L(text('📋 *Massage*\n📅 2030-01-15 at 09:00–10:00\n💰 150.00 SAR\n\nPay securely to confirm your booking:\nhttps://app.example/pay/pi_3Abc123'));
    const ar = bodyOf(r ? r.payload : text(''));
    if (r) expect(ar).toContain('*جلسة مساج*');
    const free = L(text('✅ *Booking Confirmed!*\n\n📋 Massage\n📅 2030-01-15 at 09:00\n💰 150.00 SAR paid\n\nSee you then! 🎉'));
    expect(free).not.toBeNull();
    expect(bodyOf(free.payload)).toContain(`📅 ${LRM}2030-01-15${LRM} الساعة ${LRM}09:00${LRM}`);
  });
  test('booking summary (points): the value directly BEFORE the closing asterisk gets no mark; the unbolded numbers keep theirs', () => {
    const b = L(text('💎 *Booking Summary*\n\n📋 Massage\n📅 2030-01-15 at 09:00\n\n*500 points will be deducted*\nYou have: 700 pts → after: 200 pts\n\nReply *YES* to confirm or *NO* to cancel.'));
    expect(b).not.toBeNull();
    const ar = bodyOf(b.payload);
    expect(ar).toContain('*سيتم خصم النقاط: 500*');
    expect(ar).toContain(`رصيدك الحالي: ${LRM}700${LRM}`);
    expect(ar).not.toMatch(MARK_NEXT_TO_FORMAT);
    for (const span of boldSpans(ar)) expect(span).not.toContain(LRM);
  });
  test('cart card: Latin names / numbers in bold or italic carry no mark next to the delimiters', () => {
    const added = L(buttons(ADDED('Nike Air Max 90', '40.00 AUD', '480.00 AUD'), ADDED_BUTTONS));
    const ar = bodyOf(added.payload);
    expect(ar).toContain('*Nike Air Max 90*');
    expect(ar).toContain(`${LRM}480.00 AUD${LRM}`); // not next to a delimiter: the existing default
    expect(ar).not.toMatch(MARK_NEXT_TO_FORMAT);
    expect(ar).toContain('عند الانتهاء._');
  });
  test('LOCALIZATION_WRAP_SESSION_LRM=0 switches every session mark off', () => {
    const before = process.env.LOCALIZATION_WRAP_SESSION_LRM;
    process.env.LOCALIZATION_WRAP_SESSION_LRM = '0';
    try {
      const r = L(buttons(ADDED('Red Hat', '40.00 AUD', '480.00 AUD'), ADDED_BUTTONS));
      expect(bodyOf(r.payload)).not.toContain(LRM);
      expect(bodyOf(r.payload)).toContain('480.00 AUD');
    } finally { if (before === undefined) delete process.env.LOCALIZATION_WRAP_SESSION_LRM; else process.env.LOCALIZATION_WRAP_SESSION_LRM = before; }
  });
});

describe('R3-09: the journey groups thousands like the order / promotion notices', () => {
  test('arMoney groups the integer part with a comma and keeps decimals, sign and the other-currency rule', () => {
    expect(arMoney('1250.00 SAR')).toBe('1,250.00 ر.س');
    expect(arMoney('1234567.50 SAR')).toBe('1,234,567.50 ر.س');
    expect(arMoney('999.00 SAR')).toBe('999.00 ر.س');
    expect(arMoney('1000.00 AED')).toBe('1,000.00 د.إ');
    expect(arMoney('-12500.00 SAR')).toBe('-12,500.00 ر.س');
    expect(arMoney('$1250.00')).toBe('$1250.00'); // not a recognised currency token: the merchant's own formatting
    expect(arMoney('1250.00 AUD')).toBe('1250.00 AUD');
  });
  test.each([0, 5.5, 150, 999.99, 1000, 1250, 12345.6, 1234567.89])('arMoney(%p SAR) equals senderValues.formatMoney', (n) => {
    expect(arMoney(`${n.toFixed(2)} SAR`)).toBe(senderValues.formatMoney(n, 'SAR', 'ar'));
  });
  test('the cart card of a 1,250.00 SAR product uses the grouped form', () => {
    const r = L(buttons(ADDED('Red Hat', '1250.00 SAR', '2500.00 SAR'), ADDED_BUTTONS));
    expect(bodyOf(r.payload)).toContain('1,250.00 ر.س');
    expect(bodyOf(r.payload)).toContain('2,500.00 ر.س');
  });
});

describe('real English builders with worst-case data', () => {
  let sent;
  beforeEach(() => { sent = []; axios.post.mockReset(); axios.post.mockImplementation(async (url, body) => { sent.push(body); return { data: { messages: [{ id: 'wamid.stub' }] } }; }); });
  const prods = [{ _id: 'p1', name: 'Blue Shirt', basePrice: 100, description: '', images: [], variants: [], stock: 5 }, { _id: 'p2', name: 'Red Hat', basePrice: 40, description: '', images: [], variants: [], stock: 2 }];

  // grows the promotion name until the ENGLISH header sits exactly at the 60-character limit
  async function longestEnglishHeader(promo) {
    let name = 'N';
    for (;;) {
      sent.length = 0; await wa.sendCatalog(TO, prods, { ...promo, name: `${name}N` });
      if (cp(sent[0].interactive.header.text) > 60) break;
      name = `${name}N`;
    }
    sent.length = 0; await wa.sendCatalog(TO, prods, { ...promo, name });
    expect(cp(sent[0].interactive.header.text)).toBe(60);
    return { name, payload: sent[0] };
  }

  test.each([5, 200, 5000, 99999])('R3-01 points promotion at %i pts: the longest name that fits the ENGLISH header (>= 36 characters) is still translated; the Arabic header is <= 60', async (pts) => {
    const { name, payload } = await longestEnglishHeader({ _id: 'pr2', discountPercent: 0, customerType: 'points', pointsPrice: pts });
    expect(cp(name)).toBeGreaterThanOrEqual(36);
    const r = L(payload);
    expect(r).not.toBeNull(); // never silently the English catalogue
    expect(cp(r.payload.interactive.header.text)).toBeLessThanOrEqual(60);
    expect(r.payload.interactive.header.text).toContain(name);
    expectLimits(r.payload);
  });
  test('R3-01 the review example: a 38-character promotion name at 5000 pts', async () => {
    const name = 'Ramadan Mega Sale 2026 - Electronics!!';
    expect(cp(name)).toBe(38);
    await wa.sendCatalog(TO, prods, { _id: 'pr2', name, discountPercent: 0, customerType: 'points', pointsPrice: 5000 });
    expect(cp(sent[0].interactive.header.text)).toBeLessThanOrEqual(60);
    const r = L(sent[0]);
    expect(r).not.toBeNull();
    expect(r.payload.interactive.header.text).toBe(`💎 ${LRM}${name}${LRM} — النقاط: ${LRM}5000${LRM}`);
    expect(cp(r.payload.interactive.header.text)).toBeLessThanOrEqual(60);
  });
  test('sale promotion: names up to 43 characters are translated; one that overflows only in Arabic keeps the WHOLE message English', async () => {
    for (const n of [20, 43]) {
      sent.length = 0; await wa.sendCatalog(TO, prods, { _id: 'pr1', name: 'S'.repeat(n), discountPercent: 15, customerType: 'cash', pointsPrice: 0 });
      const r = L(sent[0]); expect([n, r === null]).toEqual([n, false]); expect(cp(r.payload.interactive.header.text)).toBeLessThanOrEqual(60);
    }
    sent.length = 0; await wa.sendCatalog(TO, prods, { _id: 'pr1', name: 'S'.repeat(46), discountPercent: 15, customerType: 'cash', pointsPrice: 0 });
    expect(L(sent[0])).toBeNull();
  });

  const longName = 'Premium Hand-Stitched Leather Messenger Bag'.slice(0, 40);
  const emojiName = '🎂 Birthday Cake 🎉 (large) ❤️ ✨';
  const worst = [
    { _id: 'w1', name: longName, basePrice: 1250, description: 'x '.repeat(200), images: [], variants: [{ size: 'XXL', color: 'Midnight Blue', stock: 999 }], stock: 999 },
    { _id: 'w2', name: emojiName, basePrice: 150, description: '', images: [], variants: [], stock: 123 },
  ];
  const promos = [
    { _id: 'pr1', name: 'Summer Sale', discountPercent: 15, customerType: 'cash', pointsPrice: 0 },
    { _id: 'pr2', name: 'P'.repeat(30), discountPercent: 0, customerType: 'points', pointsPrice: 12345 },
  ];
  test('catalogue list, plain catalogue (> 10), cards, variants, slots: every limit holds in every translated message', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ _id: `m${i}`, name: i % 2 ? longName : emojiName, basePrice: 1250.5 + i }));
    for (const promo of [...promos, null]) {
      await wa.sendCatalog(TO, worst, promo); await wa.sendCatalog(TO, many, promo); await wa.sendProductCards(TO, worst, promo);
      await wa.sendVariantPicker(TO, worst[0], promo);
    }
    const svc = { _id: 's1', name: 'Deep Tissue Massage & Aromatherapy', duration: 120 };
    const slots = Array.from({ length: 6 }, (_, i) => ({ _id: `sl${i}`, date: '2030-12-31', startTime: '23:30', endTime: '23:59', capacity: 100, bookedCount: i }));
    await wa.sendServiceSlots(TO, svc, slots, 'pr1', false); await wa.sendServiceSlots(TO, svc, slots, null, true);
    expect(sent.length).toBeGreaterThan(10);
    let translated = 0;
    for (const p of sent) {
      const r = L(p);
      if (!r) continue; // stays English (the builder already enforced the English limits)
      translated += 1; expectLimits(r.payload);
      expect(boldSpans(bodyOf(r.payload)).join('')).not.toContain(LRM);
    }
    expect(translated).toBe(sent.length); // nothing of this worst case silently stays English
  });
  test('cart messages: a 40-character name, 150.00 SAR, an emoji name, a 99,999.99 SAR total', () => {
    for (const [name, price] of [[longName, '150.00 SAR'], [emojiName, '1250.00 SAR'], ['Z'.repeat(40), '99999.99 SAR']]) {
      const r = L(buttons(ADDED(name, price, price), ADDED_BUTTONS));
      expect(r).not.toBeNull(); expectLimits(r.payload);
      expect(r.payload.interactive.body.text).toContain(`*${name}*`);
    }
  });
});

describe('R3-02 / R3-03 / R3-10 / R3-11 journey copy', () => {
  const ar = (key) => catalog.t('ar', key);
  test('pay-in-person wording is one phrase (عند الحضور / حضورياً), never "الموقع"', () => {
    expect(ar('journey.btn.payInPerson')).toBe('احجز وادفع حضورياً');
    expect(cp(ar('journey.btn.payInPerson'))).toBeLessThanOrEqual(20);
    expect(ar('journey.text.reservationRequested')).toContain('يتم الدفع عند الحضور يوم الموعد.');
    for (const key of ['journey.btn.payInPerson', 'journey.text.reservationRequested', 'journey.payLater.body']) expect(ar(key)).not.toContain('الموقع');
  });
  test('no gendered predicate in the cart cards; bodyCash grammar; seats -> places', () => {
    for (const key of ['journey.added.cash', 'journey.added.cashDiscount', 'journey.added.points']) {
      expect(ar(key)).toContain('أو أتمم الطلب عند الانتهاء.');
      expect(ar(key)).not.toContain('جاهزاً');
    }
    expect(ar('journey.catalog.bodyCash')).toContain('أكثر من منتج، واحداً تلو الآخر.');
    expect(ar('journey.slots.rowLeft')).toBe('الأماكن المتبقية: {n}');
  });
  test('points header: shorter wording, same placeholders', () => {
    expect(ar('journey.catalog.headerPoints')).toBe('💎 {promo} — النقاط: {pts}');
  });
});
