// The Arabic overlay for Smart Insights. The English engine (shared/insights.js) is
// never loaded (it needs the database); its cards are rebuilt here in the exact shape
// the engine produces, and the engine's SOURCE is read as text to prove that the
// English templates the overlay parses have not changed.
const fs = require('fs');
const path = require('path');
const { localizeCard, localizeInsights, localizeMoney, RULES } = require('../../shared/localization/aiMode/insights');

const nav = (route, queryParams) => ({ type: 'navigate', route, queryParams });
const base = (key, category, labels, extra) => {
  const meta = {
    campaign_performance: ['Campaign Performance', '📢'], customer_retention: ['Customer Recovery', '🔄'], loyalty: ['Loyalty', '💎'],
    revenue: ['Revenue', '💰'], payment: ['Payment', '💳'],
  }[category];
  return {
    insightKey: key, category, categoryLabel: meta[0], icon: meta[1], ...labels, ...extra, priorityTier: 'high', priorityScore: 80, status: 'active', secondaryCta: extra.secondaryCta || null,
  };
};

const CARDS = {
  best: () => base('best_campaign_2026W41', 'campaign_performance', {
    title: 'Eid Offer was your top campaign this week',
    message: 'It generated 1,250.00 SAR from 3 orders. Run it again?',
    metricLabel: 'Revenue generated', metricValue: '1,250.00 SAR',
  }, { rawMetric: 1250, primaryCta: { label: 'Run Again', action: nav('/promotions', { runAgainPromotionId: 'p1' }) }, secondaryCta: { label: 'View Campaign', action: nav('/promotions', { viewPromotionId: 'p1' }) } }),
  worst: () => base('worst_campaign_2026W41', 'campaign_performance', {
    title: 'Summer Sale had a low conversion rate',
    message: 'Only 4.5% of customers who got it ordered. Try a different offer?',
    metricLabel: 'Conversion rate', metricValue: '4.5%',
  }, { rawMetric: 4.5, primaryCta: { label: 'Create Similar Campaign', action: nav('/promotions', { openCreate: true }) }, secondaryCta: { label: 'View Campaign', action: nav('/promotions', { viewPromotionId: 'p2' }) } }),
  inactive: (n = 15, money = true) => base('inactive_customers_30', 'customer_retention', {
    title: `${n} customers haven't returned`, message: `${n} customers have not ordered in 30 days.`,
    metricLabel: 'Estimated opportunity', metricValue: money ? '2,400.00 SAR' : `${n} customers`,
  }, { rawMetric: n, primaryCta: { label: 'Create Comeback Campaign', action: nav('/promotions', { customerIds: 'a,b' }) }, secondaryCta: { label: 'View Customers', action: nav('/customers', { ids: 'a,b' }) } }),
  points: () => base('unused_points_202610', 'loyalty', {
    title: 'Most loyalty points issued this month are unused',
    message: 'You issued 1,000 loyalty points this month, but only 200 have been redeemed.',
    metricLabel: 'Unredeemed points', metricValue: '800',
  }, { rawMetric: 800, primaryCta: { label: 'Send Points Reminder', action: nav('/promotions', { openLoyalty: true }) } }),
  abandoned: (n = 4) => base('abandoned_payments_2026W41', 'payment', {
    title: `${n} customers didn't complete payment`,
    message: `${n} customer${n === 1 ? '' : 's'} opened a payment link but did not complete payment.`,
    metricLabel: 'Unpaid orders', metricValue: n,
  }, { rawMetric: n, primaryCta: { label: 'View Unpaid Orders', action: nav('/orders', { paymentStatus: 'pending' }) } }),
  product: (name = 'Oud Deluxe') => base('best_product_2026W41', 'revenue', {
    title: `${name} was your best-selling product this week`,
    message: `${name} was your best-selling product this week. Create a promotion to drive repeat orders?`,
    metricLabel: 'Units sold', metricValue: 42,
  }, { rawMetric: 42, primaryCta: { label: 'Create Product Campaign', action: nav('/promotions', { productName: name }) }, secondaryCta: { label: 'View Product Sales', action: nav('/products', { search: name }) } }),
  loyal: (n = 9) => base('loyal_customers_2026W41', 'loyalty', {
    title: `${n} loyal customers this week`, message: `${n} customers ordered more than once this week. Send them a loyalty reward?`,
    metricLabel: 'Repeat customers', metricValue: n,
  }, { rawMetric: n, primaryCta: { label: 'Send Loyalty Reward', action: nav('/promotions', { customerIds: 'a' }) }, secondaryCta: { label: 'View Customers', action: nav('/customers', { ids: 'a' }) } }),
};

const ARABIC = /[\u{0600}-\u{06FF}]/u;
const LATIN_WORD = /[A-Za-z]{3,}/;

describe('the engine still produces the English templates the overlay parses', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'insights.js'), 'utf8');

  test('every English fragment the rules rely on is still in shared/insights.js (update insights.js here when it changes)', () => {
    const fragments = [
      'was your top campaign this week', "It generated ${money(best.revenue, currency)} from ${best.ordered} order${best.ordered === 1 ? '' : 's'}. Run it again?",
      'had a low conversion rate', '% of customers who got it ordered. Try a different offer?',
      "customers haven't returned", 'customers have not ordered in ${DAYS} days.',
      'Most loyalty points issued this month are unused', 'loyalty points this month, but only ${redeemed.toLocaleString()} have been redeemed.',
      "customers didn't complete payment", 'opened a payment link but did not complete payment.',
      'was your best-selling product this week', 'Create a promotion to drive repeat orders?',
      'loyal customers this week', 'customers ordered more than once this week. Send them a loyalty reward?',
      "label: 'Run Again'", "label: 'View Campaign'", "label: 'Create Similar Campaign'", "label: 'Create Comeback Campaign'", "label: 'View Customers'",
      "label: 'Send Points Reminder'", "label: 'View Unpaid Orders'", "label: 'Create Product Campaign'", "label: 'View Product Sales'", "label: 'Send Loyalty Reward'",
      "metricLabel: 'Revenue generated'", "metricLabel: 'Conversion rate'", "metricLabel: 'Estimated opportunity'", "metricLabel: 'Unredeemed points'",
      "metricLabel: 'Unpaid orders'", "metricLabel: 'Units sold'", "metricLabel: 'Repeat customers'",
      "label: 'Campaign Performance'", "label: 'Customer Recovery'", "label: 'Loyalty'", "label: 'Revenue'", "label: 'Payment'",
      '`${customers.length} customers`',
    ];
    for (const fragment of fragments) expect(source).toContain(fragment);
  });

  test('every insight key prefix the engine emits has a rule, and every rule has a prefix the engine emits', () => {
    const emitted = [...source.matchAll(/key: `([a-z_]+_)/g)].map((m) => m[1]).sort();
    expect(emitted).toEqual(RULES.map((r) => r.prefix).sort());
  });
});

describe('Arabic overlay: every card kind', () => {
  test.each(Object.entries(CARDS))('%s is localised, and nothing but text changes', (_name, make) => {
    const card = make();
    const { card: out, localized } = localizeCard(card);
    expect(localized).toBe(true);
    for (const field of ['categoryLabel', 'title', 'message', 'metricLabel']) {
      expect(out[field]).toMatch(ARABIC);
      expect(out[field]).not.toBe(card[field]);
    }
    expect(out.primaryCta.label).toMatch(ARABIC);
    // untouched: identity, numbers, tiers, state, icon and every CTA action (same object)
    for (const field of ['insightKey', 'category', 'icon', 'rawMetric', 'priorityTier', 'priorityScore', 'status']) expect(out[field]).toEqual(card[field]);
    expect(out.primaryCta.action).toBe(card.primaryCta.action);
    if (card.secondaryCta) {
      expect(out.secondaryCta.action).toBe(card.secondaryCta.action);
      expect(out.secondaryCta.label).toMatch(ARABIC);
    } else {
      expect(out.secondaryCta).toBeNull();
    }
  });

  test('no English sentence is left behind in a localised card (apart from names and numbers)', () => {
    const noNames = [CARDS.inactive(), CARDS.points(), CARDS.abandoned(), CARDS.loyal(), CARDS.best(), CARDS.worst()];
    for (const card of noNames) {
      const { card: out } = localizeCard(card);
      const visible = [out.categoryLabel, out.title, out.message, out.metricLabel, out.primaryCta.label, out.secondaryCta && out.secondaryCta.label].filter(Boolean);
      for (const text of visible) {
        const withoutNames = text.replace(/«[^»]*»/g, '').replace(/Eid Offer|Summer Sale/g, '').replace(/SAR|ر\.س/g, '');
        expect(withoutNames).not.toMatch(LATIN_WORD);
      }
    }
  });

  test('values are carried over exactly, with Arabic plural-aware counts', () => {
    const best = localizeCard(CARDS.best()).card;
    expect(best.title).toContain('Eid Offer');
    expect(best.message).toContain('1,250.00 ر.س');
    expect(best.message).toContain('3');
    expect(best.metricValue).toBe('1,250.00 ر.س');

    const worst = localizeCard(CARDS.worst()).card;
    expect(worst.message).toContain('4.5');
    expect(worst.metricValue).toBe('4.5%');

    const inactive = localizeCard(CARDS.inactive(15)).card;
    expect(inactive.title).toContain('15');
    expect(inactive.message).toContain('30 يوماً');
    expect(inactive.metricValue).toBe('2,400.00 ر.س');
    expect(localizeCard(CARDS.inactive(15, false)).card.metricValue).toBe('15 عميلاً');
    expect(localizeCard(CARDS.inactive(1, false)).card.metricValue).toBe('عميل واحد');
    expect(localizeCard(CARDS.inactive(2, false)).card.metricValue).toBe('عميلان');
    expect(localizeCard(CARDS.inactive(7, false)).card.metricValue).toBe('7 عملاء');

    const points = localizeCard(CARDS.points()).card;
    expect(points.message).toContain('1,000');
    expect(points.message).toContain('200');
    expect(points.metricValue).toBe('800');

    const product = localizeCard(CARDS.product('Oud Deluxe')).card;
    expect(product.title).toContain('Oud Deluxe');
    expect(product.message).toContain('Oud Deluxe');
    expect(product.metricValue).toBe('42');
  });

  test('a singular English card ("1 customer ...") is still recognised', () => {
    const { localized, card } = localizeCard(CARDS.abandoned(1));
    expect(localized).toBe(true);
    expect(card.message).toContain('1');
  });

  test('the engine formats counts with the server locale: "1.250" and Arabic-Indic digits still parse', () => {
    for (const [issued, redeemed, raw] of [['1.250', '250', 1000], ['١٬٢٥٠', '٢٥٠', 1000]]) {
      const card = CARDS.points();
      card.message = `You issued ${issued} loyalty points this month, but only ${redeemed} have been redeemed.`;
      card.rawMetric = raw;
      card.metricValue = String(raw);
      const out = localizeCard(card);
      expect(out.localized).toBe(true);
      expect(out.card.message).toContain('1,250');
    }
  });
});

describe('Arabic overlay: anything unexpected falls back to the English card, marked localized:false', () => {
  const english = (card) => ({ card: { ...card, metricValue: String(card.metricValue) }, localized: false });

  test.each([
    ['a changed message template', (c) => { c.message = 'It made 1,250.00 SAR from 3 orders. Run it again?'; return c; }, CARDS.best],
    ['a changed title template', (c) => { c.title = 'Eid Offer was the best campaign'; return c; }, CARDS.best],
    ['a metric value that disagrees with the message', (c) => { c.metricValue = '999.00 SAR'; return c; }, CARDS.best],
    ['a rate that disagrees with rawMetric', (c) => { c.rawMetric = 9; return c; }, CARDS.worst],
    ['titles and messages with different counts', (c) => { c.message = '16 customers have not ordered in 30 days.'; return c; }, () => CARDS.inactive(15)],
    ['a key whose days differ from the text', (c) => { c.insightKey = 'inactive_customers_60'; return c; }, () => CARDS.inactive(15)],
    ['a count that disagrees with rawMetric', (c) => { c.rawMetric = 99; return c; }, () => CARDS.loyal(9)],
    ['points that do not add up', (c) => { c.rawMetric = 1; return c; }, CARDS.points],
    ['an unexpected CTA label', (c) => { c.primaryCta = { ...c.primaryCta, label: 'Do Something Else' }; return c; }, CARDS.best],
    ['a CTA the rule does not expect', (c) => { c.secondaryCta = { label: 'View Customers', action: nav('/customers', {}) }; return c; }, CARDS.points],
    ['a missing expected CTA', (c) => { c.secondaryCta = null; return c; }, CARDS.best],
    ['a different category', (c) => { c.category = 'revenue'; return c; }, CARDS.best],
    ['a changed category label', (c) => { c.categoryLabel = 'Campaigns'; return c; }, CARDS.best],
    ['a changed metric label', (c) => { c.metricLabel = 'Revenue'; return c; }, CARDS.best],
    ['a product name that differs from the CTA query', (c) => { c.primaryCta.action.queryParams.productName = 'Other'; return c; }, () => CARDS.product()],
    ['an unknown insight key', (c) => { c.insightKey = 'brand_new_rule_1'; return c; }, CARDS.best],
    ['a missing title', (c) => { delete c.title; return c; }, CARDS.best],
  ])('%s', (_label, mutate, make) => {
    const card = mutate(make());
    const out = localizeCard(card);
    expect(out.localized).toBe(false);
    expect(out).toEqual(english(card));
  });

  test.each([[null], [undefined], ['x'], [5], [{}], [[]], [{ insightKey: 7 }]])('garbage card %j does not throw', (garbage) => {
    expect(() => localizeCard(garbage)).not.toThrow();
    expect(localizeCard(garbage).localized).toBe(false);
  });

  test('a hostile title cannot make the overlay throw (regex safety)', () => {
    const card = CARDS.best();
    card.title = `${'a'.repeat(100000)} was your top campaign this week`;
    const start = Date.now();
    localizeCard(card);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe('localizeInsights (what GET /ai-mode/insights returns)', () => {
  test('Arabic: the AiModeInsight shape, one entry per card, order kept, mixed localised/fallback', () => {
    const odd = CARDS.best();
    odd.insightKey = 'future_rule_3';
    const list = localizeInsights([CARDS.inactive(), odd, CARDS.loyal()], 'ar');
    expect(list.map((i) => i.insightKey)).toEqual(['inactive_customers_30', 'future_rule_3', 'loyal_customers_2026W41']);
    expect(list.map((i) => i.localized)).toEqual([true, false, true]);
    expect(Object.keys(list[0]).sort()).toEqual([
      'category', 'categoryLabel', 'icon', 'insightKey', 'localized', 'message', 'metricLabel', 'metricValue',
      'primaryCta', 'primaryCtaLabel', 'secondaryCta', 'secondaryCtaLabel', 'title',
    ]);
    expect(list[0].primaryCtaLabel).toBe(list[0].primaryCta.label);
    expect(list[0].secondaryCtaLabel).toBe(list[0].secondaryCta.label);
    expect(list[1].title).toBe('Eid Offer was your top campaign this week'); // English fallback untouched
    expect(typeof list[1].metricValue).toBe('string');
  });

  test('missing secondary CTA gives null label and null cta; numeric metric values become strings', () => {
    const [item] = localizeInsights([CARDS.points()], 'ar');
    expect(item.secondaryCta).toBeNull();
    expect(item.secondaryCtaLabel).toBeNull();
    expect(item.metricValue).toBe('800');
    const [abandoned] = localizeInsights([CARDS.abandoned(4)], 'ar');
    expect(abandoned.metricValue).toBe('4');
  });

  test('English (or anything else) returns the engine text unchanged', () => {
    const cards = [CARDS.best(), CARDS.loyal()];
    for (const language of ['en', undefined, 'fr']) {
      const list = localizeInsights(cards, language);
      expect(list.map((i) => i.title)).toEqual(cards.map((c) => c.title));
      expect(list.every((i) => i.localized === true)).toBe(true);
    }
  });

  test('a non-array from the engine is an empty list', () => {
    expect(localizeInsights(undefined, 'ar')).toEqual([]);
    expect(localizeInsights({ not: 'an array' }, 'ar')).toEqual([]);
  });

  test('the engine cards are not mutated', () => {
    const card = CARDS.best();
    const snapshot = JSON.stringify(card);
    localizeInsights([card], 'ar');
    expect(JSON.stringify(card)).toBe(snapshot);
  });

  test('localizeMoney converts only known currencies in the exact "<amount> <CODE>" form', () => {
    expect(localizeMoney('1,250.00 SAR')).toBe('1,250.00 ر.س');
    expect(localizeMoney('99.50 AED')).toBe('99.50 د.إ');
    expect(localizeMoney('$99.50')).toBe('$99.50');
    expect(localizeMoney('99.50 XYZ')).toBe('99.50 XYZ');
    expect(localizeMoney(undefined)).toBe('');
  });
});
