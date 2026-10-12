// Unit tests for shared/localization/legacyPlan.js: the read-only language plan for the existing sender screens and the
// per-language send report. The plan runs the SAME decision code as the send, so these tests also pin plan == send.
const fs = require('fs');
const path = require('path');
const plan = require('../../shared/localization/legacyPlan');
const legacy = require('../../shared/localization/legacySenders');
const {
  id, WS, OTHER_WS, PROMOTION_ID, fakeModel, template, arabicVariant, promotionDoc, productDoc, customerDoc, world, OPT_OUT,
} = require('./legacyTestKit');

const linked = (over = {}) => template({ linkedPromotionId: PROMOTION_ID, ...over });

function planWorld({ customers, languages = {}, templates = [linked()], promotion = promotionDoc(), extra = {} }) {
  const w = world({ customers, languages, templates, items: [productDoc({ workspaceId: WS, active: true })], ...extra });
  w.deps.Promotion = fakeModel([promotion]);
  return w;
}

describe('planPromotionSend', () => {
  // A Arabic ok, A2 Arabic ok, B English, C Arabic without consent, D Arabic opted out, E Arabic demo, F Arabic whose number is opted out on another record
  const A = customerDoc({ firstname: 'سارة' });
  const A2 = customerDoc({ firstname: 'نورة' });
  const B = customerDoc({ firstname: 'Bob' });
  const C = customerDoc({ firstname: 'Cons', marketingConsent: false });
  const D = customerDoc({ firstname: 'Opt', optedOut: true });
  const E = customerDoc({ firstname: 'Demo', isDemo: true });
  const F = customerDoc({ firstname: 'Dup', phone: '966507770000' });
  const sibling = customerDoc({ firstname: 'Old', phone: '+966 50 777 0000', optedOut: true, marketingConsent: false });
  const all = [A, A2, B, C, D, E, F, sibling];
  const languages = Object.fromEntries([A, A2, C, D, E, F].map((c) => [c._id, 'ar']));
  const ids = [A, A2, B, C, D, E, F].map((c) => c._id);

  test('counts per language, skips and the variant: what each ELIGIBLE customer will receive', async () => {
    const w = planWorld({ customers: all, languages });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ids }, w.deps);
    expect(out).toMatchObject({
      promotionId: PROMOTION_ID, promotionName: 'Summer Sale', sendFormat: 'separate',
      selected: 7, eligible: 5, // A, A2, B, E (demo), F pass the existing filter; C (no consent) and D (opted out) do not
      skipped: { noConsent: 1, optedOut: 1, demoSimulated: 1, optedOutSamePhone: 1 },
      byLanguage: { ar: 2, en: 1 },
      fallbacks: [], blocked: [{ reason: 'opted_out_same_phone', count: 1 }],
      canSend: true, needsAcknowledgement: true, // someone is blocked
    });
    expect(out.variant).toEqual({
      source: 'promotion', templateId: expect.any(String), templateName: expect.any(String), language: 'ar', metaStatus: 'APPROVED', reviewStatus: 'reviewed',
      sendable: true, notSendableReason: null, hasOptOut: true, hasShopButton: true, missingFields: [],
    });
    expect(out.buckets).toBeUndefined();
    expect(w.sent).toHaveLength(0); // read-only: no network
    expect(w.rows).toHaveLength(0); // and no writes
  });

  test('R2-03: the plan blocks an Arabic customer whose number is opted out on another record stored in a LOCAL spelling (same rule as the send)', async () => {
    const G = customerDoc({ firstname: 'Local', phone: '966508880000' });
    const localSibling = customerDoc({ firstname: 'Old', phone: '0508880000', optedOut: true, marketingConsent: false });
    const w = planWorld({ customers: [G, localSibling], languages: { [G._id]: 'ar' } });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [G._id] }, w.deps);
    expect(out.skipped.optedOutSamePhone).toBe(1);
    expect(out.blocked).toEqual([{ reason: 'opted_out_same_phone', count: 1 }]);
    expect(out.byLanguage.ar).toBe(0);
  });

  test('includeIds returns the buckets the composer can use to deselect English-fallback customers', async () => {
    const w = planWorld({ customers: all, languages, templates: [] });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ids, includeIds: true }, w.deps);
    expect(out.buckets.arabic).toEqual([]);
    expect(out.buckets.englishFallback.sort()).toEqual([A, A2].map((c) => String(c._id)).sort());
    expect(out.buckets.excluded).toEqual([String(F._id)]); // the same-phone rule applies before the variant lookup: nothing is sent, not even English
    const withVariant = planWorld({ customers: all, languages });
    const ok = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ids, includeIds: true }, withVariant.deps);
    expect(ok.buckets.arabic.sort()).toEqual([A, A2].map((c) => String(c._id)).sort());
    expect(ok.buckets.excluded).toEqual([String(F._id)]);
  });

  test('plan == send: the customers the plan puts in the Arabic bucket are exactly the ones the real send delivers in Arabic', async () => {
    const w = planWorld({ customers: all, languages });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ids, includeIds: true }, w.deps);
    const eligible = [A, A2, B, F]; // the existing filter minus demo (never sent for real)
    const run = await legacy.begin({ sender: 'promotion', workspaceId: WS, customers: eligible, promotion: promotionDoc(), items: [productDoc()] }, w.deps);
    const delivered = [];
    const skipped = [];
    for (const c of eligible) {
      const r = await run.trySend(c);
      if (r && r.sent) delivered.push(String(c._id));
      else if (r && r.skip) skipped.push(String(c._id));
    }
    expect(delivered.sort()).toEqual(out.buckets.arabic.slice().sort());
    expect(skipped).toEqual(out.buckets.excluded);
  });

  test('no Arabic version: every Arabic customer is listed as an English fallback with the reason, the merchant must acknowledge', async () => {
    const w = planWorld({ customers: all, languages, templates: [] });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ids }, w.deps);
    expect(out.byLanguage).toEqual({ ar: 0, en: 3 }); // B + the two Arabic customers that fall back; F is excluded, E is a demo
    expect(out.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'no_arabic_version', count: 2 }]);
    expect(out.blocked).toEqual([{ reason: 'opted_out_same_phone', count: 1 }]);
    expect(out.needsAcknowledgement).toBe(true);
  });

  test('a pending Arabic version: fallback reason pending + the plan\'s variant says why', async () => {
    const w = planWorld({ customers: [A, B], languages: { [A._id]: 'ar' }, templates: [linked({ variants: [arabicVariant({ metaStatus: 'PENDING' })] })] });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [A._id, B._id] }, w.deps);
    expect(out.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'pending', count: 1 }]);
    expect(out.warnings).toContainEqual({ code: 'arabic_fallback', detail: { count: 1, reason: 'pending' } });
    expect(out.variant).toMatchObject({ sendable: false, notSendableReason: 'pending', metaStatus: 'PENDING' });
    expect(out.needsAcknowledgement).toBe(true);
    expect(out.byLanguage).toEqual({ ar: 0, en: 2 });
  });

  test('an all-English audience: nothing to acknowledge, no warnings', async () => {
    const w = planWorld({ customers: [B], languages: {} });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [B._id] }, w.deps);
    expect(out).toMatchObject({ byLanguage: { ar: 0, en: 1 }, fallbacks: [], blocked: [], needsAcknowledgement: false, warnings: [] });
  });

  test('warnings: marketing version without opt-out, no shop button, large audience, duplicate phones', async () => {
    const noOptOut = planWorld({ customers: [A], languages: { [A._id]: 'ar' }, templates: [linked({ variants: [arabicVariant({ buttons: [{ role: 'shop_now', text: 'x' }] })] })] });
    expect((await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [A._id] }, noOptOut.deps)).warnings)
      .toContainEqual({ code: 'marketing_variant_missing_opt_out', detail: { language: 'ar' } });

    const noShop = planWorld({ customers: [A], languages: { [A._id]: 'ar' }, templates: [linked({ variants: [arabicVariant({ buttons: [{ ...OPT_OUT }] })] })] });
    expect((await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [A._id] }, noShop.deps)).warnings).toContainEqual({ code: 'no_shop_now_button' });

    const many = Array.from({ length: 260 }, (_, i) => customerDoc({ firstname: `c${i}`, phone: `9665${String(10000000 + i)}` }));
    const big = planWorld({ customers: many });
    const bigOut = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: many.map((c) => c._id) }, big.deps);
    expect(bigOut.warnings).toContainEqual({ code: 'large_audience', detail: { count: 260 } });

    const twins = [customerDoc({ phone: '966501234567' }), customerDoc({ phone: '+966 50 123 4567' }), customerDoc({ phone: '00966501234567' })];
    const dup = planWorld({ customers: twins });
    const dupOut = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: twins.map((c) => c._id) }, dup.deps);
    expect(dupOut.warnings).toContainEqual({ code: 'duplicate_phones_in_selection', detail: { count: 2 } });
  });

  test('a carousel promotion is English only: the plan says so and counts everyone as English', async () => {
    const w = planWorld({ customers: [A, B], languages: { [A._id]: 'ar' }, promotion: promotionDoc({ sendFormat: 'carousel' }) });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [A._id, B._id] }, w.deps);
    expect(out.sendFormat).toBe('carousel');
    expect(out.warnings).toContainEqual({ code: 'carousel_english_only' });
    expect(out.byLanguage).toEqual({ ar: 0, en: 2 });
    expect(out.variant).toBeNull();
    expect(out.fallbacks).toEqual([]);
  });

  test('validation and tenant isolation: bad ids are 400, more than 5000 ids is 400, another workspace\'s promotion is 404, its customers are invisible', async () => {
    const w = planWorld({ customers: [A, customerDoc({ workspaceId: OTHER_WS, firstname: 'Stranger' })], languages: {} });
    await expect(plan.planPromotionSend({ workspaceId: WS, promotionId: 'nope', customerIds: [] }, w.deps)).rejects.toMatchObject({ status: 400 });
    await expect(plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: ['{"$ne":null}'] }, w.deps)).rejects.toMatchObject({ status: 400 });
    await expect(plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: { $ne: null } }, w.deps)).rejects.toMatchObject({ status: 400 });
    const tooMany = Array.from({ length: 5001 }, (_, i) => id(i + 1));
    await expect(plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: tooMany }, w.deps)).rejects.toMatchObject({ status: 400 });
    await expect(plan.planPromotionSend({ workspaceId: OTHER_WS, promotionId: PROMOTION_ID, customerIds: [] }, w.deps)).rejects.toMatchObject({ status: 404, code: 'PROMOTION_NOT_FOUND' });
    await expect(plan.planPromotionSend({ promotionId: PROMOTION_ID, customerIds: [] }, w.deps)).rejects.toMatchObject({ status: 403 });
    const stranger = w.deps.Customer.docs[1];
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [A._id, stranger._id] }, w.deps);
    expect(out.selected).toBe(1);
  });

  test('an empty selection is an empty plan, not an error', async () => {
    const w = planWorld({ customers: [A] });
    const out = await plan.planPromotionSend({ workspaceId: WS, promotionId: PROMOTION_ID, customerIds: [] }, w.deps);
    expect(out).toMatchObject({ selected: 0, eligible: 0, byLanguage: { ar: 0, en: 0 } });
  });
});

describe('planSender', () => {
  const balance = () => template({ useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount} هذا الشهر', buttons: [{ ...OPT_OUT }] })] });

  test('loyalty reminder: the audience filter of the sender (points > 0, consent, demo exempt), Arabic customers and the variant', async () => {
    const ar = customerDoc({ firstname: 'سارة', loyaltyPoints: 125 });
    const en = customerDoc({ firstname: 'Bob', loyaltyPoints: 10 });
    const noPoints = customerDoc({ loyaltyPoints: 0 });
    const noConsent = customerDoc({ loyaltyPoints: 50, marketingConsent: false });
    const w = world({ customers: [ar, en, noPoints, noConsent], languages: { [ar._id]: 'ar' }, templates: [balance()] });
    const out = await plan.planSender({ workspaceId: WS, sender: 'loyalty_reminder' }, w.deps);
    // no ids: the sender's own filter is loyaltyPoints > 0 (the fake Customer.find honours $gt)
    expect(out).toMatchObject({ selected: 3, eligible: 2, byLanguage: { ar: 1, en: 1 }, skipped: { noConsent: 1 }, needsAcknowledgement: false });
    expect(out.promotionId).toBeUndefined();
    expect(out.variant).toMatchObject({ source: 'unlinked', sendable: true, hasOptOut: true });
    const withIds = await plan.planSender({ workspaceId: WS, sender: 'loyalty_reminder', customerIds: [noPoints._id, ar._id] }, w.deps);
    expect(withIds.skipped.noPoints).toBe(1);
    expect(withIds.eligible).toBe(1);
  });

  test('loyalty reminder with only the {date} template: Arabic customers fall back with the reason and the plan says which field is missing', async () => {
    const ar = customerDoc({ firstname: 'سارة' });
    const dated = template({ useCase: 'loyalty_reminder', variants: [arabicVariant({ body: 'رصيدك {points} استبدله قبل {date} واستمتع بمكافأتك', buttons: [{ ...OPT_OUT }] })] });
    const w = world({ customers: [ar], languages: { [ar._id]: 'ar' }, templates: [dated] });
    const out = await plan.planSender({ workspaceId: WS, sender: 'loyalty_reminder' }, w.deps);
    expect(out.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'field_values_missing:date', count: 1 }]);
    expect(out.variant).toMatchObject({ sendable: false, missingFields: ['date'] });
  });

  test('consent request: only the customers the sender would ask (no consent, never asked, not opted out, not demo)', async () => {
    const eligibleAr = customerDoc({ firstname: 'سارة', marketingConsent: false });
    const asked = customerDoc({ marketingConsent: false, marketingConsentAskedAt: new Date() });
    const consented = customerDoc({ marketingConsent: true });
    const w = world({ customers: [eligibleAr, asked, consented], languages: { [eligibleAr._id]: 'ar' } });
    const out = await plan.planSender({ workspaceId: WS, sender: 'consent_request' }, w.deps);
    expect(out).toMatchObject({ selected: 1, eligible: 1, byLanguage: { ar: 0, en: 1 } });
    expect(out.fallbacks).toEqual([{ from: 'ar', to: 'en', reason: 'no_arabic_version', count: 1 }]);
  });

  test('unknown sender is 404; foreign workspace customers are invisible', async () => {
    const w = world({ customers: [customerDoc({ workspaceId: OTHER_WS, marketingConsent: false })] });
    await expect(plan.planSender({ workspaceId: WS, sender: 'campaign' }, w.deps)).rejects.toMatchObject({ status: 404 });
    expect((await plan.planSender({ workspaceId: WS, sender: 'consent_request' }, w.deps)).selected).toBe(0);
  });

  test('the audience filters are pinned to the existing sender code (they cannot drift silently)', () => {
    const ops = fs.readFileSync(path.join(__dirname, '../../shared/operations.js'), 'utf8');
    const start = ops.indexOf('function consentRequestEligibleFilter');
    const filterSource = ops.slice(start, ops.indexOf('}, workspaceId);', start));
    for (const fragment of ['marketingConsent: { $ne: true }', 'marketingConsentAskedAt: { $exists: false }', 'optedOut: { $ne: true }', 'isDemo: { $ne: true }', '_id: { $in: customerIds }']) {
      expect(filterSource).toContain(fragment);
    }
    expect(plan.consentEligibleFilter(WS, [id(1)])).toEqual({
      workspaceId: WS, marketingConsent: { $ne: true }, marketingConsentAskedAt: { $exists: false }, optedOut: { $ne: true }, isDemo: { $ne: true }, _id: { $in: [id(1)] },
    });
    expect(ops).toContain("{ loyaltyPoints: { $gt: 0 } }");
  });
});

describe('reportPromotionSends', () => {
  test('language split with the delivery funnel joined by wamid; fallbacks and skips counted; English customers are not in it', async () => {
    const w = world({ customers: [] });
    w.deps.Promotion = fakeModel([promotionDoc()]);
    const row = (over) => ({ workspaceId: WS, sender: 'promotion', refId: PROMOTION_ID, runId: 'r1', customerId: id(1), usedLanguage: 'ar', status: 'sent', createdAt: new Date('2026-10-01T10:00:00Z'), ...over });
    w.rows.push(
      row({ customerId: id(1), wamid: 'w1' }),
      row({ customerId: id(2), wamid: 'w2' }),
      row({ customerId: id(3), status: 'failed', errorCode: '131026' }),
      row({ customerId: id(4), status: 'skipped', errorCode: 'opted_out_same_phone' }),
      row({ customerId: id(5), usedLanguage: 'en', fallbackReason: 'pending', wamid: 'w5', createdAt: new Date('2026-10-02T10:00:00Z') }),
      row({ workspaceId: OTHER_WS, customerId: id(6), wamid: 'w6' }), // other workspace: invisible
      row({ refId: id(99), customerId: id(7), wamid: 'w7' }), // other promotion
    );
    w.deps.CampaignMessage = fakeModel([
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w1', status: 'read', deliveredAt: new Date(), readAt: new Date(), clickedAt: new Date(), order: id(500) },
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w2', status: 'delivered', deliveredAt: new Date() },
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w5', status: 'sent' },
    ]);
    const out = await plan.reportPromotionSends({ workspaceId: WS, promotionId: PROMOTION_ID }, w.deps);
    expect(out).toMatchObject({
      promotionId: PROMOTION_ID, promotionName: 'Summer Sale', runs: 1, arabicCustomers: 5, truncated: false,
      byLanguage: {
        ar: { sent: 2, failed: 1, skipped: 1, delivered: 2, read: 1, clicked: 1, ordered: 1 },
        en: { sent: 1, failed: 0, skipped: 0, delivered: 0, read: 0, clicked: 0, ordered: 0 },
      },
      fallbacks: [{ reason: 'pending', count: 1 }],
      skipped: [{ reason: 'opted_out_same_phone', count: 1 }],
      lastRunAt: '2026-10-02T10:00:00.000Z',
    });
    await expect(plan.reportPromotionSends({ workspaceId: OTHER_WS, promotionId: PROMOTION_ID }, w.deps)).rejects.toMatchObject({ status: 404 });
    await expect(plan.reportPromotionSends({ workspaceId: WS, promotionId: 'x' }, w.deps)).rejects.toMatchObject({ status: 400 });
  });
});

describe('reportPromotionSends: delivery failures from the status callbacks (C3, ACC-BE)', () => {
  test('a sent row whose delivery came back failed is counted per language and per Meta error code, with the code description; codes stay workspace scoped', async () => {
    const w = world({ customers: [] });
    w.deps.Promotion = fakeModel([promotionDoc()]);
    const row = (over) => ({ workspaceId: WS, sender: 'promotion', refId: PROMOTION_ID, runId: 'r1', usedLanguage: 'ar', status: 'sent', createdAt: new Date('2026-10-01T10:00:00Z'), ...over });
    w.rows.push(
      row({ customerId: id(1), wamid: 'w1' }),
      row({ customerId: id(2), wamid: 'w2' }),
      row({ customerId: id(3), wamid: 'w3' }),
      row({ customerId: id(4), wamid: 'w4' }),
    );
    w.deps.CampaignMessage = fakeModel([
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w1', status: 'failed', errorCode: '131049', statusReason: 'Per-user marketing limit' },
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w2', status: 'failed', errorCode: '131049' },
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w3', status: 'failed' }, // failed without a code
      { workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w4', status: 'delivered', deliveredAt: new Date() },
    ]);
    const out = await plan.reportPromotionSends({ workspaceId: WS, promotionId: PROMOTION_ID }, w.deps);
    expect(out.byLanguage.ar).toMatchObject({ sent: 4, delivered: 1, deliveryFailed: 3 });
    expect(out.byLanguage.en.deliveryFailed).toBe(0);
    expect(out.deliveryErrors).toEqual([
      { code: '131049', count: 2, group: 'marketing_limit', retryable: true },
      { code: null, count: 1, group: 'none', retryable: false },
    ]);
  });

  test('no failed deliveries: an empty list, not a missing key', async () => {
    const w = world({ customers: [] });
    w.deps.Promotion = fakeModel([promotionDoc()]);
    w.rows.push({ workspaceId: WS, sender: 'promotion', refId: PROMOTION_ID, runId: 'r1', customerId: id(1), usedLanguage: 'ar', status: 'sent', wamid: 'w1', createdAt: new Date() });
    w.deps.CampaignMessage = fakeModel([{ workspaceId: WS, promotion: PROMOTION_ID, wamid: 'w1', status: 'delivered', deliveredAt: new Date() }]);
    const out = await plan.reportPromotionSends({ workspaceId: WS, promotionId: PROMOTION_ID }, w.deps);
    expect(out.deliveryErrors).toEqual([]);
  });
});
