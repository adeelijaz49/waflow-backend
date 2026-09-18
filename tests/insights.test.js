require('dotenv').config();
const mongoose = require('mongoose');

const { connectOnce } = require('./dbSetup');
const insights = require('../shared/insights');
const Workspace = require('../models/Workspace');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const InsightState = require('../models/InsightState');

const DAY_MS = 24 * 60 * 60 * 1000;

describe('shared/insights', () => {
  describe('campaign performance rules (campaigns surface)', () => {
    let workspace, customer, bestPromo, worstPromo;

    beforeAll(async () => {
      await connectOnce();
      workspace = await Workspace.create({ name: '__test_insights_campaigns__' });
      customer = await Customer.create({ firstname: '__insights_camp__', lastname: 'Test', phone: '15557710001', workspaceId: workspace._id });
      bestPromo = await Promotion.create({ name: '__test_best_campaign__', scope: 'products', customerType: 'cash', workspaceId: workspace._id });
      worstPromo = await Promotion.create({ name: '__test_worst_campaign__', scope: 'products', customerType: 'cash', workspaceId: workspace._id });

      const now = new Date();
      const msgs = [];
      // Best: 5 sent, 3 ordered ($50 each) -> 60% conversion, $150 revenue.
      for (let i = 0; i < 5; i++) {
        msgs.push({
          kind: 'promotion', promotion: bestPromo._id, customer: customer._id, phone: customer.phone,
          workspaceId: workspace._id, wamid: `wamid.best.${i}`, messageType: 'interactive', status: 'sent', sentAt: now,
          ...(i < 3 ? { order: new mongoose.Types.ObjectId(), revenue: 50 } : {}),
        });
      }
      // Worst: 5 sent, 0 ordered -> 0% conversion, $0 revenue.
      for (let i = 0; i < 5; i++) {
        msgs.push({
          kind: 'promotion', promotion: worstPromo._id, customer: customer._id, phone: customer.phone,
          workspaceId: workspace._id, wamid: `wamid.worst.${i}`, messageType: 'interactive', status: 'sent', sentAt: now,
        });
      }
      await CampaignMessage.insertMany(msgs);
    }, 20000);

    afterAll(async () => {
      await CampaignMessage.deleteMany({ workspaceId: workspace._id });
      await Promotion.deleteMany({ workspaceId: workspace._id });
      await Customer.deleteMany({ workspaceId: workspace._id });
      await InsightState.deleteMany({ workspaceId: workspace._id });
      await Workspace.findByIdAndDelete(workspace._id);
    });

    test('surfaces the highest-revenue campaign as best and the lowest-conversion one as worst', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'campaigns' });

      const bestCard = cards.find(c => c.insightKey.startsWith('best_campaign_'));
      expect(bestCard).toBeDefined();
      expect(bestCard.title).toContain(bestPromo.name);
      expect(bestCard.rawMetric).toBeCloseTo(150);
      expect(bestCard.primaryCta.action.queryParams.runAgainPromotionId.toString()).toBe(bestPromo._id.toString());

      const worstCard = cards.find(c => c.insightKey.startsWith('worst_campaign_'));
      expect(worstCard).toBeDefined();
      expect(worstCard.title).toContain(worstPromo.name);
      expect(worstCard.rawMetric).toBe(0);
    });

    test('a campaign sent to fewer than 5 customers is too noisy to call best/worst', async () => {
      const quietPromo = await Promotion.create({ name: '__test_quiet_campaign__', scope: 'products', customerType: 'cash', workspaceId: workspace._id });
      await CampaignMessage.create({
        kind: 'promotion', promotion: quietPromo._id, customer: customer._id, phone: customer.phone,
        workspaceId: workspace._id, wamid: 'wamid.quiet.0', messageType: 'interactive', status: 'sent', sentAt: new Date(),
        order: new mongoose.Types.ObjectId(), revenue: 500,
      });

      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'campaigns' });
      expect(cards.some(c => c.title.includes(quietPromo.name))).toBe(false);

      await Promotion.findByIdAndDelete(quietPromo._id);
      await CampaignMessage.deleteMany({ promotion: quietPromo._id });
    });
  });

  describe('customer retention + loyalty rules (customers surface)', () => {
    let workspace, inactiveCustomer, loyalCustomer;

    beforeAll(async () => {
      await connectOnce();
      workspace = await Workspace.create({ name: '__test_insights_customers__' });
      inactiveCustomer = await Customer.create({ firstname: '__insights_inactive__', lastname: 'Test', phone: '15557720001', workspaceId: workspace._id });
      loyalCustomer = await Customer.create({ firstname: '__insights_loyal__', lastname: 'Test', phone: '15557720002', workspaceId: workspace._id });

      // Inactive: only order was 45 days ago.
      await Order.create({
        customer: inactiveCustomer._id, workspaceId: workspace._id, subtotal: 40, total: 40,
        status: 'delivered', paymentStatus: 'paid', createdAt: new Date(Date.now() - 45 * DAY_MS),
      });
      // Loyal: two orders in the last 7 days.
      await Order.create({ customer: loyalCustomer._id, workspaceId: workspace._id, subtotal: 20, total: 20, status: 'confirmed', createdAt: new Date(Date.now() - 1 * DAY_MS) });
      await Order.create({ customer: loyalCustomer._id, workspaceId: workspace._id, subtotal: 20, total: 20, status: 'confirmed', createdAt: new Date(Date.now() - 2 * DAY_MS) });
    });

    afterAll(async () => {
      await Order.deleteMany({ workspaceId: workspace._id });
      await Customer.deleteMany({ workspaceId: workspace._id });
      await InsightState.deleteMany({ workspaceId: workspace._id });
      await Workspace.findByIdAndDelete(workspace._id);
    });

    test('flags a customer whose last order is more than 30 days old', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'customers' });
      const card = cards.find(c => c.insightKey === 'inactive_customers_30');
      expect(card).toBeDefined();
      expect(card.rawMetric).toBe(1);
      expect(card.primaryCta.action.queryParams.customerIds).toContain(inactiveCustomer._id.toString());
    });

    test('flags a customer with 2+ orders in the last 7 days as a loyal customer', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'customers' });
      const card = cards.find(c => c.insightKey.startsWith('loyal_customers_'));
      expect(card).toBeDefined();
      expect(card.rawMetric).toBe(1);
      expect(card.secondaryCta.action.queryParams.ids).toContain(loyalCustomer._id.toString());
    });
  });

  describe('revenue + payment rules (dashboard surface)', () => {
    let workspace, customer;

    beforeAll(async () => {
      await connectOnce();
      workspace = await Workspace.create({ name: '__test_insights_revenue__' });
      customer = await Customer.create({ firstname: '__insights_revenue__', lastname: 'Test', phone: '15557730001', workspaceId: workspace._id });

      // Best-selling product this week: Widget (qty 8) beats Gadget (qty 2).
      // paymentStatus explicitly 'paid' so these don't also count as abandoned
      // payments below (Order.paymentStatus otherwise defaults to 'pending').
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 80, total: 80, status: 'confirmed', paymentStatus: 'paid',
        createdAt: new Date(Date.now() - 1 * DAY_MS), items: [{ productName: 'Widget', quantity: 5, unitPrice: 10 }],
      });
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 60, total: 60, status: 'confirmed', paymentStatus: 'paid',
        createdAt: new Date(Date.now() - 2 * DAY_MS),
        items: [{ productName: 'Widget', quantity: 3, unitPrice: 10 }, { productName: 'Gadget', quantity: 2, unitPrice: 15 }],
      });
      // Abandoned payment: pending, created 2 days ago (older than 1h, newer than 30d).
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 25, total: 25,
        paymentStatus: 'pending', createdAt: new Date(Date.now() - 2 * DAY_MS),
      });
    });

    afterAll(async () => {
      await Order.deleteMany({ workspaceId: workspace._id });
      await Customer.deleteMany({ workspaceId: workspace._id });
      await InsightState.deleteMany({ workspaceId: workspace._id });
      await Workspace.findByIdAndDelete(workspace._id);
    });

    test('surfaces the highest-quantity product sold this week', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      const card = cards.find(c => c.insightKey.startsWith('best_product_'));
      expect(card).toBeDefined();
      expect(card.title).toContain('Widget');
      expect(card.rawMetric).toBe(8);
    });

    test('flags a customer who opened a payment link but never completed it', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      const card = cards.find(c => c.insightKey.startsWith('abandoned_payments_'));
      expect(card).toBeDefined();
      expect(card.rawMetric).toBe(1);
    });
  });

  describe('dismiss/actioned persistence', () => {
    let workspace, customer;
    let insightKey; // resolved from the first live card — stable for the whole block (keyed by year+month)

    beforeAll(async () => {
      await connectOnce();
      workspace = await Workspace.create({ name: '__test_insights_state__' });
      customer = await Customer.create({ firstname: '__insights_state__', lastname: 'Test', phone: '15557750001', workspaceId: workspace._id });
      // Issues 100 unredeemed points this month.
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 100, total: 100, status: 'confirmed',
        createdAt: new Date(), loyaltyPointsEarned: 100, loyaltyPointsUsed: 0,
      });

      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      insightKey = cards.find(c => c.insightKey.startsWith('unused_points_')).insightKey;
    });

    afterAll(async () => {
      await Order.deleteMany({ workspaceId: workspace._id });
      await Customer.deleteMany({ workspaceId: workspace._id });
      await InsightState.deleteMany({ workspaceId: workspace._id });
      await Workspace.findByIdAndDelete(workspace._id);
    });

    test('dismissing an insight hides it while the underlying metric is unchanged', async () => {
      let cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      const card = cards.find(c => c.insightKey === insightKey);
      expect(card.rawMetric).toBe(100);

      await insights.updateInsightStatus({ workspaceId: workspace._id, insightKey, status: 'dismissed', rawMetric: card.rawMetric });

      cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      expect(cards.find(c => c.insightKey === insightKey)).toBeUndefined();
    });

    test('a materially changed metric un-suppresses a previously dismissed insight', async () => {
      // Issue more points -> unredeemed total moves from 100 to 250.
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 150, total: 150, status: 'confirmed',
        createdAt: new Date(), loyaltyPointsEarned: 150, loyaltyPointsUsed: 0,
      });

      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      const card = cards.find(c => c.insightKey === insightKey);
      expect(card).toBeDefined();
      expect(card.rawMetric).toBe(250);
    });

    test('actioning an insight hides it permanently, even if the metric changes again', async () => {
      const cards = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      const card = cards.find(c => c.insightKey === insightKey);
      await insights.updateInsightStatus({ workspaceId: workspace._id, insightKey, status: 'actioned', rawMetric: card.rawMetric });

      let after = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      expect(after.find(c => c.insightKey === insightKey)).toBeUndefined();

      // Push the metric further (100+150+500=750 issued) — actioned must stay hidden regardless of the metric, unlike dismissed.
      await Order.create({
        customer: customer._id, workspaceId: workspace._id, subtotal: 10, total: 10, status: 'confirmed',
        createdAt: new Date(), loyaltyPointsEarned: 500, loyaltyPointsUsed: 0,
      });
      after = await insights.generateInsights({ workspaceId: workspace._id, surface: 'dashboard' });
      expect(after.find(c => c.insightKey === insightKey)).toBeUndefined();
    });
  });

  describe('workspace isolation', () => {
    let wsA, wsB, customerA, customerB;

    beforeAll(async () => {
      await connectOnce();
      wsA = await Workspace.create({ name: '__test_insights_wsA__' });
      wsB = await Workspace.create({ name: '__test_insights_wsB__' });
      customerA = await Customer.create({ firstname: '__insights_wsA__', lastname: 'Test', phone: '15557760001', workspaceId: wsA._id });
      customerB = await Customer.create({ firstname: '__insights_wsB__', lastname: 'Test', phone: '15557760002', workspaceId: wsB._id });

      // Only workspace A starts with an old order.
      await Order.create({
        customer: customerA._id, workspaceId: wsA._id, subtotal: 40, total: 40,
        status: 'delivered', createdAt: new Date(Date.now() - 45 * DAY_MS),
      });
      // Workspace B's only order is recent — must not be flagged, and must never see A's card.
      await Order.create({
        customer: customerB._id, workspaceId: wsB._id, subtotal: 40, total: 40,
        status: 'delivered', createdAt: new Date(Date.now() - 1 * DAY_MS),
      });
    });

    afterAll(async () => {
      await Order.deleteMany({ workspaceId: { $in: [wsA._id, wsB._id] } });
      await Customer.deleteMany({ workspaceId: { $in: [wsA._id, wsB._id] } });
      await InsightState.deleteMany({ workspaceId: { $in: [wsA._id, wsB._id] } });
      await Workspace.deleteMany({ _id: { $in: [wsA._id, wsB._id] } });
    });

    test('an insight computed for workspace A never appears for workspace B', async () => {
      const cardsA = await insights.generateInsights({ workspaceId: wsA._id, surface: 'customers' });
      const cardsB = await insights.generateInsights({ workspaceId: wsB._id, surface: 'customers' });
      expect(cardsA.find(c => c.insightKey === 'inactive_customers_30')).toBeDefined();
      expect(cardsB.find(c => c.insightKey === 'inactive_customers_30')).toBeUndefined();
    });

    test('dismissing an insight in workspace A does not affect the same insight key in workspace B', async () => {
      // Give B a second customer whose *only* order is old, so the same
      // insightKey becomes eligible in both workspaces (customerB already has
      // a recent order, so backdating one of their orders wouldn't work —
      // listInactiveCustomers looks at each customer's most recent order).
      const customerB2 = await Customer.create({ firstname: '__insights_wsB2__', lastname: 'Test', phone: '15557760003', workspaceId: wsB._id });
      await Order.create({
        customer: customerB2._id, workspaceId: wsB._id, subtotal: 40, total: 40,
        status: 'delivered', createdAt: new Date(Date.now() - 45 * DAY_MS),
      });

      await insights.updateInsightStatus({ workspaceId: wsA._id, insightKey: 'inactive_customers_30', status: 'dismissed', rawMetric: 1 });

      const cardsA = await insights.generateInsights({ workspaceId: wsA._id, surface: 'customers' });
      const cardsB = await insights.generateInsights({ workspaceId: wsB._id, surface: 'customers' });
      expect(cardsA.find(c => c.insightKey === 'inactive_customers_30')).toBeUndefined();
      expect(cardsB.find(c => c.insightKey === 'inactive_customers_30')).toBeDefined();
    });
  });
});
