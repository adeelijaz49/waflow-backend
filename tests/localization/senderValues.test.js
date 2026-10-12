// Unit tests for shared/localization/senderValues.js: the merge-field values of the Arabic versions of the
// existing senders. Pure functions + injected fakes; no database, no network.
const values = require('../../shared/localization/senderValues');
const { id, productDoc } = require('./legacyTestKit');

const LRM = '\u{200E}';
const BIDI_RE = /[\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

describe('names', () => {
  test('a usable first name is kept, Latin names inside Arabic text stay as typed', () => {
    expect(values.nameValue({ firstname: 'Sara' })).toBe('Sara');
    expect(values.nameValue({ firstname: 'سارة' })).toBe('سارة');
    expect(values.nameValue({ firstname: '  Mohammed   Ali ' })).toBe('Mohammed Ali');
  });

  test('a phone-number name, a name without a letter or an empty one gives the Arabic fallback', () => {
    for (const firstname of ['966501234567', '+966 50 123 4567', '٠٥٠١٢٣٤٥٦٧', '', '   ', undefined, null, '1234', '😀😀', '---']) {
      expect(values.nameValue({ firstname })).toBe('عميلنا العزيز');
    }
  });

  test('a long name is clipped by code points (an emoji is never cut in half)', () => {
    const long = `${'م'.repeat(70)}`;
    expect(Array.from(values.nameValue({ firstname: long }))).toHaveLength(60);
    const emoji = `Ali${'😀'.repeat(80)}`;
    const clipped = values.nameValue({ firstname: emoji });
    expect(Array.from(clipped)).toHaveLength(60);
    expect(clipped).not.toMatch(/[\u{D800}-\u{DFFF}]/u); // a lone surrogate would mean a cut emoji
    expect(Array.from(values.fullNameValue({ firstname: 'Ali', lastname: 'ب'.repeat(200) })).length).toBeLessThanOrEqual(90);
  });

  test('bidi controls, zero-width characters and line breaks are removed (a name cannot reorder the sentence)', () => {
    const spoof = values.nameValue({ firstname: '\u{202E}evil\u{202C}\u{200B}\nname' });
    expect(spoof).not.toMatch(BIDI_RE);
    expect(spoof).not.toMatch(/[\u{200B}\n]/u);
    expect(spoof).toBe('evil name');
  });

  test('full name = first + last, the last name only when it is usable', () => {
    expect(values.fullNameValue({ firstname: 'Sara', lastname: 'Ahmed' })).toBe('Sara Ahmed');
    expect(values.fullNameValue({ firstname: 'سارة', lastname: 'الأحمد' })).toBe('سارة الأحمد');
    expect(values.fullNameValue({ firstname: 'Sara', lastname: '966501234567' })).toBe('Sara');
    expect(values.fullNameValue({ firstname: '966501234567', lastname: 'Ahmed' })).toBe('عميلنا العزيز');
  });
});

describe('points, money and dates', () => {
  test('points are a whole non-negative number', () => {
    expect(values.pointsValue({ loyaltyPoints: 125 })).toBe('125');
    expect(values.pointsValue({ loyaltyPoints: 12.6 })).toBe('13');
    expect(values.pointsValue({ loyaltyPoints: -5 })).toBe('0');
    expect(values.pointsValue({ loyaltyPoints: 'abc' })).toBe('0');
    expect(values.pointsValue({})).toBe('0');
  });

  test('SAR amounts are written like 150.00 ر.س with Western digits and a thousands comma', () => {
    expect(values.formatMoney(150, 'SAR', 'ar')).toBe('150.00 ر.س');
    expect(values.formatMoney(0, 'SAR', 'ar')).toBe('0.00 ر.س');
    expect(values.formatMoney(1234.5, 'SAR', 'ar')).toBe('1,234.50 ر.س');
    expect(values.formatMoney(1234567.891, 'sar', 'ar')).toBe('1,234,567.89 ر.س');
    expect(values.formatMoney(45, 'AED', 'ar')).toBe('45.00 د.إ');
    expect(values.formatMoney(45, 'AUD', 'ar')).toBe('45.00 AUD');
    expect(values.formatMoney(45, 'SAR', 'en')).toBe('45.00 SAR');
    expect(values.formatMoney('abc', 'SAR', 'ar')).toBeNull();
    expect(values.formatMoney(null, 'SAR', 'ar')).toBeNull();
    expect(values.formatMoney(undefined, 'SAR', 'ar')).toBeNull();
  });

  test('the worth of loyalty points is points / 10, as the English loyalty template computes it', () => {
    expect(values.amountValue({ loyaltyPoints: 125 }, 'SAR')).toBe('12.50 ر.س');
    expect(values.amountValue({ loyaltyPoints: 3 }, 'SAR')).toBe('0.30 ر.س');
    expect(values.amountValue({ loyaltyPoints: 100000 }, 'SAR')).toBe('10,000.00 ر.س');
  });

  test('dates are Gregorian, Western digits, UTC; the year only when it is not the current one', () => {
    const now = Date.UTC(2026, 9, 12);
    expect(values.formatDate(new Date(Date.UTC(2026, 10, 30)), { now })).toBe('30 نوفمبر');
    expect(values.formatDate('2027-03-05T00:00:00Z', { now })).toBe('5 مارس 2027');
    expect(values.formatDate(new Date(Date.UTC(2026, 0, 1, 23, 59)), { now })).toBe('1 يناير');
    expect(values.formatDate(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)), { now })).toBe('31 ديسمبر'); // UTC edge: still the 31st
    expect(values.formatDate(undefined, { now })).toBeNull();
    expect(values.formatDate('', { now })).toBeNull();
    expect(values.formatDate('not a date', { now })).toBeNull();
  });
});

describe('promotion values', () => {
  const resolveItemNames = jest.fn();
  const deps = { catalogTranslations: { resolveItemNames } };
  const now = Date.UTC(2026, 9, 12);
  beforeEach(() => { resolveItemNames.mockReset(); resolveItemNames.mockResolvedValue(new Map()); });

  test('cash promotion: reviewed Arabic item name, discounted price in SAR, discount percent, date', async () => {
    resolveItemNames.mockResolvedValue(new Map([[id(30), 'حبوب قهوة']]));
    const promotion = { _id: id(10), name: 'Summer Sale', customerType: 'cash', scope: 'products', discountPercent: 20, endDate: new Date(Date.UTC(2026, 10, 30)) };
    const out = await values.promotionValues(deps, { promotion, items: [productDoc()], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(out).toEqual({ promo_name: 'Summer Sale', item: 'حبوب قهوة', price: '40.00 ر.س', discount: '20', date: '30 نوفمبر' });
    expect(resolveItemNames).toHaveBeenCalledWith({ workspaceId: id(0xa1), kind: 'product', ids: [id(30)], language: 'ar' });
  });

  test('no reviewed translation: the English item name; no item at all: the catalogue fallback', async () => {
    const promotion = { _id: id(10), name: 'Sale', customerType: 'cash', scope: 'products', discountPercent: 0 };
    const english = await values.promotionValues(deps, { promotion, items: [productDoc({ name: 'Coffee beans' })], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(english.item).toBe('Coffee beans');
    expect(english.price).toBe('50.00 ر.س'); // no discount
    expect(english.discount).toBeUndefined(); // 0% cannot be promoted
    const none = await values.promotionValues(deps, { promotion, items: [], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(none.item).toBe('عرضنا الجديد');
    expect(none.price).toBeUndefined(); // a cash promotion without an item has no knowable price
  });

  test('a failing translation lookup never breaks the values (English name is used)', async () => {
    resolveItemNames.mockRejectedValue(new Error('db down'));
    const promotion = { _id: id(10), name: 'Sale', customerType: 'cash', scope: 'products', discountPercent: 10 };
    const out = await values.promotionValues(deps, { promotion, items: [productDoc()], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(out.item).toBe('Coffee beans');
  });

  test('services use the service kind', async () => {
    const promotion = { _id: id(10), name: 'Spa day', customerType: 'cash', scope: 'services', discountPercent: 10 };
    await values.promotionValues(deps, { promotion, items: [{ _id: id(31), name: 'Facial', basePrice: 100 }], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(resolveItemNames).toHaveBeenCalledWith(expect.objectContaining({ kind: 'service' }));
  });

  test('points promotion: the points price as an Arabic counted phrase (1, 2, 3-10, 11+) and as a bare number', async () => {
    const phrase = async (pointsPrice) => (await values.promotionValues(deps, {
      promotion: { _id: id(10), name: 'P', customerType: 'points', scope: 'products', pointsPrice }, items: [productDoc()], currency: 'SAR', workspaceId: id(0xa1), now,
    }));
    expect((await phrase(1)).price).toBe('نقطة واحدة');
    expect((await phrase(2)).price).toBe('نقطتان');
    expect((await phrase(5)).price).toBe('5 نقاط');
    expect((await phrase(11)).price).toBe('11 نقطة');
    expect((await phrase(100)).points_price).toBe('100');
    expect((await phrase(0)).price).toBeUndefined();
  });

  test('emoji and very long promotion names are clipped / kept intact', async () => {
    const promotion = { _id: id(10), name: `Eid 🎉 ${'x'.repeat(300)}`, customerType: 'cash', scope: 'products', discountPercent: 10 };
    const out = await values.promotionValues(deps, { promotion, items: [productDoc()], currency: 'SAR', workspaceId: id(0xa1), now });
    expect(Array.from(out.promo_name).length).toBeLessThanOrEqual(100);
    expect(out.promo_name.startsWith('Eid 🎉 ')).toBe(true);
  });
});

describe('valuesFor / unfillableFields', () => {
  const customer = { firstname: 'سارة', lastname: 'الأحمد', loyaltyPoints: 125 };
  const ctx = { business: 'مقهى أروما', currency: 'SAR', promotion: { promo_name: 'عرض الصيف', item: 'قهوة', price: '40.00 ر.س', discount: '20', date: '30 نوفمبر' } };

  test('fills every known field per customer and per workspace', () => {
    const { values: v, missing } = values.valuesFor(['name', 'full_name', 'points', 'business', 'amount', 'promo_name', 'item', 'price', 'discount', 'date'], customer, ctx);
    expect(missing).toEqual([]);
    expect(v.name).toBe('سارة');
    expect(v.full_name).toBe('سارة الأحمد');
    expect(v.points).toBe('125');
    expect(v.business).toBe('مقهى أروما');
    expect(v.amount).toBe('12.50 ر.س');
    expect(v.price).toBe('40.00 ر.س');
    expect(Object.getPrototypeOf(v)).toBeNull(); // a field named like an Object.prototype member never resolves to an inherited value
  });

  test('a field nobody can fill is reported, never invented', () => {
    const r = values.valuesFor(['name', 'order_id', 'constructor', 'date'], customer, { business: 'x', promotion: {} });
    expect(r.missing).toEqual(['order_id', 'constructor', 'date']);
    expect(r.values.name).toBe('سارة');
  });

  test('unfillableFields: outside the sender registry, no business name, a promotion without that value', () => {
    expect(values.unfillableFields(['name', 'points', 'amount'], 'loyalty_reminder', { business: 'x' })).toEqual([]);
    expect(values.unfillableFields(['date'], 'loyalty_reminder', { business: 'x' })).toEqual(['date']);
    expect(values.unfillableFields(['business'], 'consent_request', { business: '' })).toEqual(['business']);
    expect(values.unfillableFields(['points'], 'consent_request', { business: 'x' })).toEqual(['points']);
    expect(values.unfillableFields(['item', 'date'], 'promotion', { business: 'x', promotion: { item: 'قهوة' } })).toEqual(['date']);
  });
});

describe('booking and order notice values', () => {
  test('booking values: service, date, time, slot text, name with fallbacks', () => {
    const booking = { customerName: 'Sara', serviceId: { name: 'Facial' }, slotId: { date: '2026-11-03', startTime: '16:30' } };
    expect(values.bookingNoticeValues(booking)).toEqual({ name: 'Sara', service: 'Facial', date: '2026-11-03', time: '16:30', slot: '2026-11-03 16:30' });
    expect(values.bookingNoticeValues(booking, { date: '2026-12-01', startTime: '09:00' }).slot).toBe('2026-12-01 09:00'); // the NEW slot wins
    const bare = values.bookingNoticeValues({ customerName: '966500000000', serviceId: null, slotId: null });
    expect(bare.name).toBe('عميلنا العزيز');
    expect(bare.service).toBe('خدمتك'); // flows.fallbackService (R3-08), not the promotion-item fallback
    expect(bare.slot).toBe('موعدك المحجوز');
  });

  test('booking values (async): the REVIEWED Arabic service name replaces the English one; no translation, a lookup error or no workspace keeps the English name (ACC-BE)', async () => {
    const booking = { workspaceId: id(0xa1), customerName: 'Sara', serviceId: { _id: id(40), name: 'Facial' }, slotId: { date: '2026-11-03', startTime: '16:30' } };
    const resolveItemNames = jest.fn(async () => new Map([[id(40), 'جلسة عناية بالوجه']]));
    const out = await values.bookingNoticeValuesAsync(booking, undefined, { catalogTranslations: { resolveItemNames } });
    expect(out).toEqual({ name: 'Sara', service: 'جلسة عناية بالوجه', date: '2026-11-03', time: '16:30', slot: '2026-11-03 16:30' });
    expect(resolveItemNames).toHaveBeenCalledWith({ workspaceId: String(id(0xa1)), kind: 'service', ids: [String(id(40))], language: 'ar' }); // workspace scoped, service kind
    const none = await values.bookingNoticeValuesAsync(booking, undefined, { catalogTranslations: { resolveItemNames: async () => new Map() } });
    expect(none.service).toBe('Facial');
    const broken = await values.bookingNoticeValuesAsync(booking, undefined, { catalogTranslations: { resolveItemNames: async () => { throw new Error('db down'); } } });
    expect(broken.service).toBe('Facial');
    const noWorkspace = await values.bookingNoticeValuesAsync({ ...booking, workspaceId: undefined }, undefined, { catalogTranslations: { resolveItemNames } });
    expect(noWorkspace.service).toBe('Facial');
    expect((await values.bookingNoticeValuesAsync(booking, { date: '2026-12-01', startTime: '09:00' }, { catalogTranslations: { resolveItemNames } })).slot).toBe('2026-12-01 09:00');
  });

  test('order summary: one line per cart item with the reviewed Arabic product name, SAR amounts, pay link with ?lang=ar', async () => {
    const resolveItemNames = jest.fn(async () => new Map([[id(30), 'حبوب قهوة']]));
    const out = await values.orderSummaryValues({
      workspaceId: id(0xa1),
      items: [{ productId: id(30), quantity: 2 }, { productId: id(31) }],
      cartItems: [{ name: 'Coffee beans', priceAud: 50 }, { name: 'Coffee beans', priceAud: 50 }, { name: 'Mug', priceAud: 25.5 }],
      subtotal: 125.5, shipping: 0.5, total: 126, currency: 'SAR', address: '1 King Fahd Rd,\nRiyadh', link: 'https://app.test/pay/pi_123',
    }, { catalogTranslations: { resolveItemNames } });
    expect(out.items).toBe('1. حبوب قهوة — 50.00 ر.س\n2. حبوب قهوة — 50.00 ر.س\n3. Mug — 25.50 ر.س');
    expect(out.subtotal).toBe('125.50 ر.س');
    expect(out.shipping).toBe('0.50 ر.س');
    expect(out.total).toBe('126.00 ر.س');
    expect(out.address).toBe('1 King Fahd Rd, Riyadh');
    expect(out.link).toBe('https://app.test/pay/pi_123?lang=ar');
  });

  test('order summary survives a failing translation lookup and a link that already has a query', async () => {
    const out = await values.orderSummaryValues({
      workspaceId: id(0xa1), items: [{ productId: id(30) }], cartItems: [{ name: 'Coffee beans', priceAud: 50 }],
      subtotal: 50, shipping: 0.5, total: 50.5, currency: 'SAR', address: 'x', link: 'https://app.test/pay/pi_1?x=1',
    }, { catalogTranslations: { resolveItemNames: async () => { throw new Error('down'); } } });
    expect(out.items).toBe('1. Coffee beans — 50.00 ر.س');
    expect(out.link).toBe('https://app.test/pay/pi_1?x=1&lang=ar');
  });
});

describe('source hygiene of the module itself', () => {
  test('the direction mark constant used by the renderer tests is the real LRM', () => { expect(LRM.codePointAt(0)).toBe(0x200e); });
});
