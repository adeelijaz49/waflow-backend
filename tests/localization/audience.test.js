// Audience resolution for localised campaigns: consent, opt-out, demo, phone
// validity, de-duplication, segments, the recipient cap and tenant isolation.
// Everything runs on the in-memory store (campaignTestKit) with the REAL consent
// module (its WhatsApp dependency is mocked) — no database, no network.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const {
  MAX_RECIPIENTS, MAX_CUSTOMER_IDS, MAX_CANDIDATES, SEGMENTS, normalizeAudienceSpec, normalizeRecipientPhone, classifyCustomer, loadOptedOutPhones, resolveAudience,
} = require('../../shared/localization/audience');
const consent = require('../../shared/consent');
const { makeKit, oid, ObjectId } = require('./campaignTestKit');

const WS = oid();
const OTHER_WS = oid();
const DAY = 24 * 60 * 60 * 1000;
let seq = 0;

function addCustomer(kit, extra = {}, ws = WS) {
  seq += 1;
  const [doc] = kit.customers.seed([{
    _id: oid(), workspaceId: ws, firstname: `First${seq}`, lastname: `Last${seq}`, phone: `9665${String(seq).padStart(8, '0')}`,
    marketingConsent: true, ...extra,
  }]);
  return doc;
}

const resolve = (kit, audience, category = 'MARKETING', ws = WS) => resolveAudience({ workspaceId: ws, audience, category }, kit.deps);
const ids = (result) => result.customers.map((c) => c.id);
const skipOf = (result, doc) => result.customers.find((c) => c.id === String(doc._id)).skip;

describe('normalizeAudienceSpec — what a request may say about the audience', () => {
  test('all_eligible keeps only its kind', () => {
    expect(normalizeAudienceSpec({ kind: 'all_eligible', customerIds: ['x'], extra: 1 })).toEqual({ kind: 'all_eligible' });
  });

  test.each([[undefined], [null], ['all_eligible'], [[]], [42], [{}], [{ kind: 'nope' }], [{ kind: ['all_eligible'] }], [{ kind: { $ne: 1 } }]])(
    'rejects a malformed audience %j with INVALID_INPUT', (raw) => {
      expect.assertions(2);
      try { normalizeAudienceSpec(raw); } catch (err) { expect(err.status).toBe(400); expect(err.code).toBe('INVALID_INPUT'); }
    },
  );

  test('customer_ids are validated, lower-cased and de-duplicated in order', () => {
    const a = String(oid());
    const b = String(oid());
    const spec = normalizeAudienceSpec({ kind: 'customer_ids', customerIds: [a.toUpperCase(), b, a, oid()] });
    expect(spec.customerIds).toHaveLength(3);
    expect(spec.customerIds.slice(0, 2)).toEqual([a, b]);
    expect(spec.customerIds.every((x) => /^[a-f0-9]{24}$/.test(x))).toBe(true);
  });

  test.each([
    [{ $ne: null }], ['not-an-id'], [123], [null], [['nested']], [{ $gt: '' }], ['0'.repeat(23)], ['g'.repeat(24)],
  ])('an element %j in customerIds is INVALID_ID (NoSQL-operator injection never reaches a query)', (bad) => {
    expect.assertions(2);
    try { normalizeAudienceSpec({ kind: 'customer_ids', customerIds: [String(oid()), bad] }); } catch (err) { expect(err.status).toBe(400); expect(err.code).toBe('INVALID_ID'); }
  });

  test('customerIds must be a non-empty array of at most MAX_CUSTOMER_IDS (the 100 kB body limit)', () => {
    expect(() => normalizeAudienceSpec({ kind: 'customer_ids' })).toThrow(/array/);
    expect(() => normalizeAudienceSpec({ kind: 'customer_ids', customerIds: [] })).toThrow(/at least one/);
    expect(() => normalizeAudienceSpec({ kind: 'customer_ids', customerIds: { $in: [] } })).toThrow(/array/);
    expect(MAX_CUSTOMER_IDS).toBe(2000);
    const tooMany = Array.from({ length: MAX_CUSTOMER_IDS + 1 }, () => String(oid()));
    expect(() => normalizeAudienceSpec({ kind: 'customer_ids', customerIds: tooMany })).toThrow(/At most 2000/);
    expect(normalizeAudienceSpec({ kind: 'customer_ids', customerIds: tooMany.slice(0, MAX_CUSTOMER_IDS) }).customerIds).toHaveLength(MAX_CUSTOMER_IDS);
  });

  test('segments: only known keys, checked parameters, extras dropped', () => {
    expect(normalizeAudienceSpec({ kind: 'segment', segmentKey: 'language', segmentParams: { language: 'ar', days: 5, x: 1 } }))
      .toEqual({ kind: 'segment', segmentKey: 'language', segmentParams: { language: 'ar' } });
    expect(normalizeAudienceSpec({ kind: 'segment', segmentKey: 'awaiting_consent', segmentParams: { language: 'ar' } }))
      .toEqual({ kind: 'segment', segmentKey: 'awaiting_consent', segmentParams: {} });
    expect(normalizeAudienceSpec({ kind: 'segment', segmentKey: 'has_points', segmentParams: { minPoints: '٥٠٠' } }).segmentParams).toEqual({ minPoints: 500 });
    expect(normalizeAudienceSpec({ kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: '٣٠' } }).segmentParams).toEqual({ days: 30 });
    expect(normalizeAudienceSpec({ kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 60 } }).segmentParams).toEqual({ days: 60 });
  });

  test.each([
    [{ segmentKey: 'nope' }], [{ segmentKey: { $ne: 1 } }], [{ segmentKey: 'language' }], [{ segmentKey: 'language', segmentParams: { language: 'fr' } }],
    [{ segmentKey: 'language', segmentParams: { language: { $ne: 'ar' } } }], [{ segmentKey: 'inactive_days' }],
    [{ segmentKey: 'inactive_days', segmentParams: { days: 0 } }], [{ segmentKey: 'inactive_days', segmentParams: { days: 3651 } }],
    [{ segmentKey: 'inactive_days', segmentParams: { days: 1.5 } }], [{ segmentKey: 'inactive_days', segmentParams: { days: 'abc' } }],
    [{ segmentKey: 'inactive_days', segmentParams: { days: { $gt: 0 } } }], [{ segmentKey: 'inactive_days', segmentParams: { days: true } }],
    [{ segmentKey: 'has_points', segmentParams: { minPoints: -1 } }], [{ segmentKey: 'has_points', segmentParams: { minPoints: 1e12 } }],
  ])('rejects segment %j', (partial) => {
    expect.assertions(2);
    try { normalizeAudienceSpec({ kind: 'segment', ...partial }); } catch (err) { expect(err.status).toBe(400); expect(err.code).toBe('INVALID_INPUT'); }
  });

  test('the advertised segments match the contract', () => {
    expect(SEGMENTS.map((s) => [s.key, [...s.params]])).toEqual([
      ['language', ['language']], ['inactive_days', ['days']], ['has_points', ['minPoints']], ['awaiting_consent', []],
    ]);
  });
});

describe('normalizeRecipientPhone — only numbers WhatsApp can deliver to', () => {
  const LRM = String.fromCodePoint(0x200E);
  const RLM = String.fromCodePoint(0x200F);
  test.each([
    ['966501234567', '966501234567'], ['+966 50 123 4567', '966501234567'], ['00966501234567', '966501234567'], ['(966) 50-123.4567', '966501234567'],
    ['٩٦٦٥٠١٢٣٤٥٦٧', '966501234567'], ['۹۶۶۵۰۱۲۳۴۵۶۷', '966501234567'], [`${LRM}+966501234567${RLM}`, '966501234567'], [966501234567, '966501234567'],
    ['12345678', '12345678'], ['123456789012345', '123456789012345'], ['  966501234567  ', '966501234567'],
  ])('%j -> %s', (raw, expected) => {
    expect(normalizeRecipientPhone(raw)).toBe(expected);
  });

  test.each([
    ['0501234567'], ['050 123 4567'], [''], [null], [undefined], ['abc'], ['1234567'], ['1234567890123456'], ['deleted-65f0c1a2b3c4d5e6f7a8b9c0'],
    ['+0966501234567'], ['966501234567x'], ['966-501-234-567-890-123'], ['++966501234567'], [{ $ne: null }], [[]],
  ])('%j is invalid', (raw) => {
    expect(normalizeRecipientPhone(raw)).toBeNull();
  });
});

describe('classifyCustomer — one rule set for the plan and for the last-second re-check', () => {
  const base = { phone: '966501234567', marketingConsent: true, optedOut: false, isDemo: false };
  const classify = (extra, category = 'MARKETING') => classifyCustomer({ ...base, ...extra }, category, consent);

  test('eligible', () => { expect(classify({})).toBeNull(); });
  test('demo customers never reach Meta, whatever else is true', () => {
    expect(classify({ isDemo: true })).toBe('demo');
    expect(classify({ isDemo: true, optedOut: true, marketingConsent: false })).toBe('demo');
  });
  test('opted-out customers receive nothing, even with a consent flag', () => {
    expect(classify({ optedOut: true })).toBe('opted_out');
    expect(classify({ optedOut: true }, 'UTILITY')).toBe('opted_out');
  });
  test('MARKETING needs consent (canSendMarketing); UTILITY does not', () => {
    expect(classify({ marketingConsent: false })).toBe('no_consent');
    expect(classify({ marketingConsent: undefined })).toBe('no_consent');
    expect(classify({ marketingConsent: 'true' })).toBe('no_consent'); // strictly === true, like canSendMarketing
    expect(classify({ marketingConsent: false }, 'UTILITY')).toBeNull();
  });
  test('unknown categories are treated as MARKETING (the strict rule)', () => {
    expect(classify({ marketingConsent: false }, 'SOMETHING')).toBe('no_consent');
  });
  test('an undeliverable number is skipped last', () => {
    expect(classify({ phone: '0501234567' })).toBe('invalid_phone');
    expect(classify({ phone: '0501234567', marketingConsent: false })).toBe('no_consent');
  });

  describe('options.optedOutPhones (another record with the same number opted out)', () => {
    const phones = (...list) => new Set(list);
    const classifyWith = (extra, optedOutPhones, category = 'MARKETING', options = {}) => classifyCustomer({ ...base, ...extra }, category, consent, { optedOutPhones, ...options });

    test('a customer whose normalised phone is in the set is skipped as opted_out_phone — MARKETING and UTILITY alike', () => {
      expect(classifyWith({}, phones('966501234567'))).toBe('opted_out_phone');
      expect(classifyWith({}, phones('966501234567'), 'UTILITY')).toBe('opted_out_phone');
      expect(classifyWith({ phone: '+966 50 123 4567' }, phones('966501234567'))).toBe('opted_out_phone'); // the stored format does not matter
      expect(classifyWith({ phone: '٩٦٦٥٠١٢٣٤٥٦٧' }, phones('966501234567'))).toBe('opted_out_phone');
    });

    test('other numbers, an empty set and an absent set leave the customer eligible', () => {
      expect(classifyWith({}, phones('966501234568'))).toBeNull();
      expect(classifyWith({}, phones())).toBeNull();
      expect(classifyWith({}, undefined)).toBeNull();
    });

    test('an undeliverable number never matches the set (null is not a phone)', () => {
      expect(classifyWith({ phone: '0501234567' }, phones('966501234567'))).toBe('invalid_phone');
    });

    test('precedence: demo, then the customer\'s own opt-out, then the sibling, then no_consent / consent-request rules', () => {
      const set = phones('966501234567');
      expect(classifyWith({ isDemo: true }, set)).toBe('demo');
      expect(classifyWith({ optedOut: true }, set)).toBe('opted_out');
      expect(classifyWith({ marketingConsent: false }, set)).toBe('opted_out_phone');
      expect(classifyWith({ marketingConsent: false }, set, 'MARKETING', { consentRequest: true })).toBe('opted_out_phone'); // an ask never goes to a number that opted out
      expect(classifyWith({ marketingConsent: false }, phones('966501234568'), 'MARKETING', { consentRequest: true })).toBeNull();
    });
  });
});

describe('resolveAudience — all_eligible', () => {
  test('MARKETING: eligible = consented, not opted out; the rest are counted, demo/invalid/duplicates are skipped explicitly', async () => {
    const kit = makeKit();
    const ok = addCustomer(kit);
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const optedOut = addCustomer(kit, { optedOut: true });
    const demo = addCustomer(kit, { isDemo: true });
    const badPhone = addCustomer(kit, { phone: '0501234567' });
    const duplicate = addCustomer(kit, { phone: ok.phone });
    addCustomer(kit, {}, OTHER_WS); // another tenant: never visible
    addCustomer(kit, { deletedAt: new Date() }); // erased: never visible

    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(ids(r)).toEqual([ok, demo, badPhone, duplicate].map((c) => String(c._id)).sort());
    expect(skipOf(r, ok)).toBeNull();
    expect(skipOf(r, demo)).toBe('demo');
    expect(skipOf(r, badPhone)).toBe('invalid_phone');
    expect(skipOf(r, duplicate)).toBe('duplicate_phone');
    expect(r.skipped).toEqual({ noConsent: 1, optedOut: 1, demo: 1, invalidPhone: 1, duplicatePhone: 1, alreadyConsented: 0, askedRecently: 0 });
    expect(r.eligible).toBe(1);
    expect(r.selected).toBe(6); // 4 loaded + the opted-out and the no-consent customer counted outside the audience
    expect(r.customers.find((c) => c.id === String(noConsent._id))).toBeUndefined(); // counted, not loaded
    expect(r.customers.find((c) => c.id === String(optedOut._id))).toBeUndefined();
  });

  test('UTILITY: consent is not required, opted-out customers are still excluded', async () => {
    const kit = makeKit();
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const consented = addCustomer(kit);
    addCustomer(kit, { optedOut: true, marketingConsent: false });
    const r = await resolve(kit, { kind: 'all_eligible' }, 'UTILITY');
    expect(ids(r).sort()).toEqual([noConsent, consented].map((c) => String(c._id)).sort());
    expect(r.skipped).toMatchObject({ noConsent: 0, optedOut: 1 });
    expect(r.eligible).toBe(2);
  });

  test('uses the shared MARKETING_ELIGIBLE_QUERY and never mutates it', async () => {
    const kit = makeKit();
    const before = JSON.stringify(consent.MARKETING_ELIGIBLE_QUERY);
    addCustomer(kit);
    await resolve(kit, { kind: 'all_eligible' });
    expect(JSON.stringify(consent.MARKETING_ELIGIBLE_QUERY)).toBe(before);
  });

  test('customers are returned in _id order (deterministic plans)', async () => {
    const kit = makeKit();
    const created = [addCustomer(kit), addCustomer(kit), addCustomer(kit)];
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(ids(r)).toEqual(created.map((c) => String(c._id)));
  });

  test('refuses an audience larger than MAX_RECIPIENTS with a clear INVALID_INPUT', async () => {
    const kit = makeKit();
    kit.customers.seed(Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => ({
      workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9665${String(i).padStart(8, '0')}`, marketingConsent: true,
    })), { raw: true });
    await expect(resolve(kit, { kind: 'all_eligible' })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT', message: expect.stringMatching(/more than 5000/) });
  });

  test('exactly MAX_RECIPIENTS is allowed', async () => {
    const kit = makeKit();
    kit.customers.seed(Array.from({ length: MAX_RECIPIENTS }, (_, i) => ({
      workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9665${String(i).padStart(8, '0')}`, marketingConsent: true, optedOut: false, isDemo: false,
    })), { raw: true });
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(r.eligible).toBe(MAX_RECIPIENTS);
  });

  test('attaches each customer\'s stored language, unknown when there is none', async () => {
    const kit = makeKit();
    const a = addCustomer(kit);
    const b = addCustomer(kit);
    const c = addCustomer(kit);
    kit.languages.seed([
      { workspaceId: WS, customerId: a._id, language: 'ar' }, { workspaceId: WS, customerId: b._id, language: 'en' },
      { workspaceId: OTHER_WS, customerId: c._id, language: 'ar' }, // another tenant's row for the same customer id must not leak in
    ]);
    const r = await resolve(kit, { kind: 'all_eligible' });
    const lang = (doc) => r.customers.find((x) => x.id === String(doc._id)).language;
    expect([lang(a), lang(b), lang(c)]).toEqual(['ar', 'en', 'unknown']);
  });

  test('duplicate phones: the first customer (by id) keeps the send; invalid numbers are never "duplicates"', async () => {
    const kit = makeKit();
    const first = addCustomer(kit, { phone: '+966 50 000 0001' });
    const second = addCustomer(kit, { phone: '966500000001' });
    const bad1 = addCustomer(kit, { phone: 'abc' });
    const bad2 = addCustomer(kit, { phone: 'abc' });
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(skipOf(r, first)).toBeNull();
    expect(skipOf(r, second)).toBe('duplicate_phone');
    expect(skipOf(r, bad1)).toBe('invalid_phone');
    expect(skipOf(r, bad2)).toBe('invalid_phone');
    expect(r.skipped).toMatchObject({ duplicatePhone: 1, invalidPhone: 2 });
  });
});

describe('resolveAudience — customer_ids', () => {
  test('classifies every chosen customer; other tenants\' ids, erased and unknown ids are ignored and reported as notFound', async () => {
    const kit = makeKit();
    const ok = addCustomer(kit);
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const optedOut = addCustomer(kit, { optedOut: true });
    const foreign = addCustomer(kit, {}, OTHER_WS);
    const erased = addCustomer(kit, { deletedAt: new Date() });
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [ok, noConsent, optedOut, foreign, erased, oid()].map((c) => String(c._id || c)) });
    expect(ids(r)).toEqual([ok, noConsent, optedOut].map((c) => String(c._id)));
    expect(r.customers.map((c) => c.skip)).toEqual([null, 'no_consent', 'opted_out']);
    expect(r.notFound).toBe(3);
    expect(r.selected).toBe(3);
    expect(r.eligible).toBe(1);
    expect(r.skipped).toMatchObject({ noConsent: 1, optedOut: 1 });
    expect(ids(r)).not.toContain(String(foreign._id));
  });

  test('the query is always scoped by workspace, never by the ids alone', async () => {
    const kit = makeKit();
    const foreign = addCustomer(kit, {}, OTHER_WS);
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [String(foreign._id)] });
    expect(r.customers).toEqual([]);
    expect(r.notFound).toBe(1);
    const r2 = await resolve(kit, { kind: 'customer_ids', customerIds: [String(foreign._id)] }, 'MARKETING', OTHER_WS);
    expect(r2.customers).toHaveLength(1);
  });

  test('queries ids in slices (an audience of thousands never becomes one giant $in)', async () => {
    const kit = makeKit();
    const wanted = Array.from({ length: 1300 }, (_, i) => ({
      _id: oid(), workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9665${String(i).padStart(8, '0')}`, marketingConsent: true, optedOut: false, isDemo: false,
    }));
    kit.customers.seed(wanted, { raw: true });
    const before = kit.ops.filter((o) => o.collection === 'customers').length;
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: wanted.map((c) => String(c._id)) });
    expect(r.customers).toHaveLength(1300);
    // 1000 + 300 ids, plus the ONE bulk read of opted-out phones for the same-phone rule (not one per customer)
    expect(kit.ops.filter((o) => o.collection === 'customers').length - before).toBe(3);
  });
});

describe('resolveAudience — segments', () => {
  test('language ar / en: only that language, per tenant; unknown = no row or an "unknown" row', async () => {
    const kit = makeKit();
    const ar = addCustomer(kit);
    const en = addCustomer(kit);
    const none = addCustomer(kit);
    const explicitUnknown = addCustomer(kit);
    const foreignAr = addCustomer(kit, {}, OTHER_WS);
    kit.languages.seed([
      { workspaceId: WS, customerId: ar._id, language: 'ar' }, { workspaceId: WS, customerId: en._id, language: 'en' },
      { workspaceId: WS, customerId: explicitUnknown._id, language: 'unknown' }, { workspaceId: OTHER_WS, customerId: foreignAr._id, language: 'ar' },
    ]);
    const seg = (language) => resolve(kit, { kind: 'segment', segmentKey: 'language', segmentParams: { language } });
    expect(ids(await seg('ar'))).toEqual([String(ar._id)]);
    expect(ids(await seg('en'))).toEqual([String(en._id)]);
    expect(ids(await seg('unknown')).sort()).toEqual([String(none._id), String(explicitUnknown._id)].sort());
  });

  test('has_points: at least N points', async () => {
    const kit = makeKit();
    addCustomer(kit, { loyaltyPoints: 99 });
    const exact = addCustomer(kit, { loyaltyPoints: 100 });
    const more = addCustomer(kit, { loyaltyPoints: 5000 });
    addCustomer(kit, { loyaltyPoints: 5000 }, OTHER_WS);
    const r = await resolve(kit, { kind: 'segment', segmentKey: 'has_points', segmentParams: { minPoints: 100 } });
    expect(ids(r)).toEqual([exact, more].map((c) => String(c._id)));
  });

  test('awaiting_consent: not consented and not opted out — MARKETING skips them all, UTILITY (a consent request) reaches them', async () => {
    const kit = makeKit();
    const waiting = addCustomer(kit, { marketingConsent: false });
    addCustomer(kit, { marketingConsent: true });
    addCustomer(kit, { marketingConsent: false, optedOut: true });
    const spec = { kind: 'segment', segmentKey: 'awaiting_consent', segmentParams: {} };
    const marketing = await resolve(kit, spec, 'MARKETING');
    expect(ids(marketing)).toEqual([String(waiting._id)]);
    expect(marketing.eligible).toBe(0);
    expect(marketing.skipped.noConsent).toBe(1);
    const utility = await resolve(kit, spec, 'UTILITY');
    expect(utility.eligible).toBe(1);
  });

  describe('inactive_days (same meaning as listInactiveCustomers: ordered before, latest non-cancelled order older than N days)', () => {
    function world() {
      const kit = makeKit();
      const now = kit.clock.t;
      const stale = addCustomer(kit);
      const recent = addCustomer(kit);
      const onlyCancelled = addCustomer(kit);
      const never = addCustomer(kit);
      const staleWithRecentCancelled = addCustomer(kit);
      const foreign = addCustomer(kit, {}, OTHER_WS);
      const order = (customer, daysAgo, status, ws = WS) => ({ workspaceId: ws, customer: customer._id, status, createdAt: new Date(now - daysAgo * DAY) });
      kit.orders.seed([
        order(stale, 100, 'delivered'), order(stale, 120, 'delivered'),
        order(recent, 5, 'delivered'), order(recent, 200, 'delivered'),
        order(onlyCancelled, 90, 'cancelled'),
        order(staleWithRecentCancelled, 100, 'confirmed'), order(staleWithRecentCancelled, 1, 'cancelled'),
        order(foreign, 100, 'delivered', OTHER_WS),
      ]);
      return { kit, stale, recent, onlyCancelled, never, staleWithRecentCancelled, foreign };
    }

    test('30 days', async () => {
      const w = world();
      const r = await resolve(w.kit, { kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 30 } });
      expect(ids(r).sort()).toEqual([w.stale, w.staleWithRecentCancelled].map((c) => String(c._id)).sort());
    });

    test('a threshold older than every order matches nobody; a short one matches only customers whose latest order is older', async () => {
      const w = world();
      expect(ids(await resolve(w.kit, { kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 365 } }))).toEqual([]);
      const r = await resolve(w.kit, { kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 2 } });
      expect(ids(r)).toEqual(expect.arrayContaining([String(w.recent._id), String(w.stale._id)]));
      expect(ids(r)).not.toContain(String(w.never._id));
      expect(ids(r)).not.toContain(String(w.onlyCancelled._id));
    });

    test('orders are matched by workspace with a real ObjectId (aggregation does not cast): another tenant\'s orders never count', async () => {
      const w = world();
      const mine = await resolve(w.kit, { kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 30 } });
      expect(ids(mine)).not.toContain(String(w.foreign._id));
      const theirs = await resolve(w.kit, { kind: 'segment', segmentKey: 'inactive_days', segmentParams: { days: 30 } }, 'MARKETING', OTHER_WS);
      expect(ids(theirs)).toEqual([String(w.foreign._id)]);
    });
  });

  test('a segment matching more than MAX_CANDIDATES customers is refused', async () => {
    const kit = makeKit();
    kit.customers.seed(Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
      workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9665${String(i).padStart(8, '0')}`, marketingConsent: false, loyaltyPoints: 10,
    })), { raw: true });
    await expect(resolve(kit, { kind: 'segment', segmentKey: 'has_points', segmentParams: { minPoints: 1 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('resolveAudience — the same-phone opt-out rule (Customer.phone is not unique; opt-out updates only the first record)', () => {
  // Spies on every Customer.find so a test can say HOW MANY reads the rule costs.
  function spyFinds(kit) {
    const filters = [];
    const original = kit.customers.find.bind(kit.customers);
    kit.customers.find = (filter) => { filters.push(filter); return original(filter); };
    return filters;
  }

  test('MARKETING all_eligible: a consented record is excluded when ANOTHER record with the same phone is opted out, and counted under skipped.optedOut', async () => {
    const kit = makeKit();
    const phone = '966500000777';
    const alive = addCustomer(kit, { phone }); // consented, not opted out - but the person replied STOP on the other record
    const optedOutTwin = addCustomer(kit, { phone, optedOut: true, marketingConsent: false });
    const other = addCustomer(kit);
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(skipOf(r, alive)).toBe('opted_out_phone');
    expect(skipOf(r, other)).toBeNull();
    expect(r.customers.find((c) => c.id === String(optedOutTwin._id))).toBeUndefined(); // the opted-out twin itself is only counted
    expect(r.skipped).toMatchObject({ optedOut: 2, noConsent: 0, duplicatePhone: 0 });
    expect(r.eligible).toBe(1);
    expect(r.selected).toBe(3);
  });

  test('the stored format of either record does not matter: 966…, +966…, 00966…, spaced and Arabic-Indic digits are one number', async () => {
    const kit = makeKit();
    const twins = [
      [addCustomer(kit, { phone: '+966 50 000 0001' }), '966500000001'],
      [addCustomer(kit, { phone: '966500000002' }), '+966500000002'],
      [addCustomer(kit, { phone: '00966500000003' }), '966-500-000-003'],
      [addCustomer(kit, { phone: '٩٦٦٥٠٠٠٠٠٠٠٤' }), '966500000004'],
    ];
    for (const [, optedOutPhone] of twins) addCustomer(kit, { phone: optedOutPhone, optedOut: true, marketingConsent: false });
    const bystander = addCustomer(kit, { phone: '966500000005' });
    const r = await resolve(kit, { kind: 'all_eligible' });
    for (const [alive] of twins) expect(skipOf(r, alive)).toBe('opted_out_phone');
    expect(skipOf(r, bystander)).toBeNull();
    expect(r.skipped.optedOut).toBe(8); // 4 recipients skipped because of the twin + the 4 opted-out records themselves
  });

  test('customer_ids and segments: the excluded recipient is listed with its skip key; the opted-out record chosen by hand is still opted_out', async () => {
    const kit = makeKit();
    const phone = '966500000888';
    const alive = addCustomer(kit, { phone });
    const twin = addCustomer(kit, { phone, optedOut: true });
    const free = addCustomer(kit);
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [alive, twin, free].map((c) => String(c._id)) });
    expect(r.customers.map((c) => [c.id, c.skip])).toEqual([[String(alive._id), 'opted_out_phone'], [String(twin._id), 'opted_out'], [String(free._id), null]]);
    expect(r.skipped.optedOut).toBe(2);
    expect(r.eligible).toBe(1);

    kit.languages.seed([{ workspaceId: WS, customerId: alive._id, language: 'ar' }, { workspaceId: WS, customerId: free._id, language: 'ar' }]);
    const seg = await resolve(kit, { kind: 'segment', segmentKey: 'language', segmentParams: { language: 'ar' } });
    expect(seg.customers.map((c) => [c.id, c.skip])).toEqual([[String(alive._id), 'opted_out_phone'], [String(free._id), null]]);
    expect(seg.skipped.optedOut).toBe(1);
  });

  test('UTILITY (transactional) audiences and consent requests honour it too: nobody who opted out is contacted through another record', async () => {
    const kit = makeKit();
    const phone = '966500000999';
    const alive = addCustomer(kit, { phone, marketingConsent: false });
    addCustomer(kit, { phone, optedOut: true, marketingConsent: false });
    const utility = await resolve(kit, { kind: 'all_eligible' }, 'UTILITY');
    expect(skipOf(utility, alive)).toBe('opted_out_phone');
    expect(utility.eligible).toBe(0);

    const ask = await resolveAudience({ workspaceId: WS, audience: { kind: 'all_eligible' }, category: 'MARKETING', consentRequest: true }, kit.deps);
    expect(skipOf(ask, alive)).toBe('opted_out_phone');
    expect(ask.eligible).toBe(0);
  });

  test('only an OPTED-OUT record counts: a sibling that merely lacks consent (or is a demo record) does not exclude anybody', async () => {
    const kit = makeKit();
    const phone = '966500000111';
    const alive = addCustomer(kit, { phone, marketingConsent: true });
    addCustomer(kit, { phone, marketingConsent: false });
    addCustomer(kit, { phone, marketingConsent: false, optedOut: false, isDemo: true });
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(skipOf(r, alive)).toBeNull();
    expect(r.skipped.optedOut).toBe(0);
  });

  test('tenant isolation: an opted-out record of ANOTHER workspace with the same phone excludes nobody here, and ours excludes nobody there', async () => {
    const kit = makeKit();
    const phone = '966500000222';
    const mine = addCustomer(kit, { phone });
    const theirs = addCustomer(kit, { phone, optedOut: true }, OTHER_WS);
    const r = await resolve(kit, { kind: 'all_eligible' });
    expect(skipOf(r, mine)).toBeNull();
    const other = await resolve(kit, { kind: 'all_eligible' }, 'MARKETING', OTHER_WS);
    expect(other.customers).toEqual([]); // theirs is opted out (counted, not loaded)
    expect(other.skipped.optedOut).toBe(1);
    expect(theirs).toBeTruthy();
  });

  test('one bulk read per audience, never one per recipient: 1 opted-out lookup for 1 recipient and for 1200', async () => {
    for (const size of [1, 1200]) {
      const kit = makeKit();
      kit.customers.seed(Array.from({ length: size }, (_, i) => ({
        workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9665${String(i).padStart(8, '0')}`, marketingConsent: true, optedOut: false, isDemo: false,
      })), { raw: true });
      const filters = spyFinds(kit);
      const r = await resolve(kit, { kind: 'all_eligible' });
      expect(r.eligible).toBe(size);
      const lookups = filters.filter((f) => f.optedOut === true);
      expect(lookups).toHaveLength(1);
      expect(lookups[0]).toEqual({ workspaceId: WS, optedOut: true }); // scoped to the workspace, never unscoped
    }
  });

  test('no extra read at all when nobody in the audience could be messaged (demo / opted-out / undeliverable only)', async () => {
    const kit = makeKit();
    const demo = addCustomer(kit, { isDemo: true });
    const out = addCustomer(kit, { optedOut: true });
    const bad = addCustomer(kit, { phone: '0501234567' });
    const filters = spyFinds(kit);
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [demo, out, bad].map((c) => String(c._id)) });
    expect(r.eligible).toBe(0);
    expect(filters.filter((f) => f.optedOut === true)).toHaveLength(0);
  });

  test('the opted-out phone list is read through loadOptedOutPhones: normalised digits only, junk dropped, local spellings resolved with the workspace country code (R2-03)', async () => {
    const kit = makeKit();
    addCustomer(kit, { phone: '+966 50 000 0001', optedOut: true });
    addCustomer(kit, { phone: '0500000002', optedOut: true }); // local form: resolved with the default country code (966), like H1
    addCustomer(kit, { phone: '500000005', optedOut: true }); // bare national number
    addCustomer(kit, { phone: '00966500000006', optedOut: true });
    addCustomer(kit, { phone: 'not a number', optedOut: true });
    addCustomer(kit, { phone: '966500000003', optedOut: false });
    addCustomer(kit, { phone: '966500000004', optedOut: true }, OTHER_WS);
    const phones = await loadOptedOutPhones(kit.deps, WS);
    expect([...phones].sort()).toEqual(['500000005', '966500000001', '966500000002', '966500000005', '966500000006']);
  });

  test('R2-03: the workspace default country code decides what a local number means; without Settings only the international spelling is used', async () => {
    const kit = makeKit();
    addCustomer(kit, { phone: '0412345678', optedOut: true });
    kit.deps.Settings = { findOne: () => ({ select: () => ({ lean: async () => ({ defaultCountryCode: '61' }) }) }) };
    expect([...(await loadOptedOutPhones(kit.deps, WS))]).toEqual(['61412345678']);
    delete kit.deps.Settings;
    expect([...(await loadOptedOutPhones(kit.deps, WS))]).toEqual([]);
  });

  test('a workspace with more opted-out records than the limit fails CLOSED with a clear error, never a silently partial check', async () => {
    const kit = makeKit();
    addCustomer(kit);
    kit.customers.seed(Array.from({ length: MAX_CANDIDATES + 1 }, (_, i) => ({
      workspaceId: WS, firstname: 'A', lastname: 'B', phone: `9664${String(i).padStart(8, '0')}`, marketingConsent: false, optedOut: true,
    })), { raw: true });
    await expect(resolve(kit, { kind: 'all_eligible' })).rejects.toMatchObject({ status: 400, code: 'INVALID_INPUT', message: expect.stringMatching(/opted-out/) });
  });
});

describe('resolveAudience — guards', () => {
  test('a missing workspace is a programming error, never an unscoped query', async () => {
    const kit = makeKit();
    await expect(resolveAudience({ workspaceId: undefined, audience: { kind: 'all_eligible' } }, kit.deps)).rejects.toThrow(/workspaceId/);
    expect(kit.ops).toHaveLength(0);
  });

  test('an invalid audience fails before any query', async () => {
    const kit = makeKit();
    await expect(resolve(kit, { kind: 'customer_ids', customerIds: [{ $ne: null }] })).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(kit.ops).toHaveLength(0);
  });

  test('accepts ObjectId instances for ids', async () => {
    const kit = makeKit();
    const c = addCustomer(kit);
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [new ObjectId(String(c._id))] });
    expect(r.eligible).toBe(1);
  });
});

describe('consent request (welcome_optin): the ask goes to people who have NOT consented', () => {
  const consentResolve = (kit, audience, ws = WS) => resolveAudience({ workspaceId: ws, audience, category: 'MARKETING', consentRequest: true }, kit.deps);

  test('all_eligible: not consented + not opted out + not asked within 7 days; everyone else is counted, nobody is demo', async () => {
    const kit = makeKit();
    const fresh = addCustomer(kit, { marketingConsent: false });
    const oldAsk = addCustomer(kit, { marketingConsent: false, marketingConsentAskedAt: new Date(kit.deps.now() - 8 * DAY) });
    const recentAsk = addCustomer(kit, { marketingConsent: false, marketingConsentAskedAt: new Date(kit.deps.now() - 2 * DAY) });
    const consented = addCustomer(kit, { marketingConsent: true });
    const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
    const demo = addCustomer(kit, { marketingConsent: false, isDemo: true });
    const r = await consentResolve(kit, { kind: 'all_eligible' });
    expect(r.customers.filter((c) => !c.skip).map((c) => c.id)).toEqual([String(fresh._id), String(oldAsk._id)].sort());
    expect(r.eligible).toBe(2);
    expect(r.skipped.alreadyConsented).toBe(1);
    expect(r.skipped.askedRecently).toBe(1);
    expect(r.skipped.optedOut).toBe(1);
    expect(r.skipped.demo).toBe(1);
    expect(r.skipped.noConsent).toBe(0);
    expect(ids(r)).not.toContain(String(recentAsk._id)); // counted, not loaded
    expect(ids(r)).not.toContain(String(consented._id));
    expect(ids(r)).not.toContain(String(optedOut._id)); // opted-out customers are counted outside the audience
    expect(skipOf(r, demo)).toBe('demo');
  });

  test('customer_ids: explicit skip reasons, and an opted-out customer is never asked', async () => {
    const kit = makeKit();
    const fresh = addCustomer(kit, { marketingConsent: false });
    const consented = addCustomer(kit, { marketingConsent: true });
    const recent = addCustomer(kit, { marketingConsent: false, marketingConsentAskedAt: new Date(kit.deps.now() - DAY) });
    const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
    const r = await consentResolve(kit, { kind: 'customer_ids', customerIds: [fresh, consented, recent, optedOut].map((c) => String(c._id)) });
    expect(skipOf(r, fresh)).toBeNull();
    expect(skipOf(r, consented)).toBe('already_consented');
    expect(skipOf(r, recent)).toBe('asked_recently');
    expect(skipOf(r, optedOut)).toBe('opted_out');
    expect(r.eligible).toBe(1);
  });

  test('without consentRequest the same non-consented customer is skipped as no_consent (marketing rule unchanged)', async () => {
    const kit = makeKit();
    const fresh = addCustomer(kit, { marketingConsent: false });
    const r = await resolve(kit, { kind: 'customer_ids', customerIds: [String(fresh._id)] });
    expect(skipOf(r, fresh)).toBe('no_consent');
  });

  test('classifyCustomer: boundary of the 7-day window', () => {
    const now = Date.now();
    const asked = (ms) => ({ marketingConsent: false, marketingConsentAskedAt: new Date(now - ms) });
    expect(classifyCustomer({ ...asked(7 * DAY - 1000), phone: '966500000001' }, 'MARKETING', consent, { consentRequest: true, nowMs: now })).toBe('asked_recently');
    expect(classifyCustomer({ ...asked(7 * DAY + 1000), phone: '966500000001' }, 'MARKETING', consent, { consentRequest: true, nowMs: now })).toBeNull();
  });
});
