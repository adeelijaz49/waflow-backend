require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { authedAgent, getTestWorkspaceId } = require('./testAuth');
const app = require('../server');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const ConsentEvent = require('../models/ConsentEvent');
const { buildPromoAnnouncementPayload, buildPointsPromoPayload } = require('../utils/whatsapp');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function waitUntil(checkFn, { timeout = 4000, interval = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await checkFn();
    if (result) return result;
    await wait(interval);
  }
  throw new Error(`waitUntil: condition not met within ${timeout}ms`);
}

describe('Opt Out button on promo payload builders', () => {
  test('buildPromoAnnouncementPayload puts Opt Out as the second button, below the shop/book action', () => {
    const promo = { _id: 'p1', scope: 'products', customerType: 'cash', discountPercent: 20, name: 'Sale' };
    const payload = buildPromoAnnouncementPayload({ firstname: 'Sam' }, promo, []);
    expect(payload.action.buttons.length).toBe(2);
    expect(payload.action.buttons[0].reply.title).toBe('Shop Now! 🛍️');
    expect(payload.action.buttons[1].reply.title).toBe('Opt Out');
    expect(payload.action.buttons[1].reply.id).toBe('optout_p1');
  });

  test('buildPromoAnnouncementPayload uses Book Now for services, Opt Out still second', () => {
    const promo = { _id: 'p2', scope: 'services', customerType: 'cash', discountPercent: 10, name: 'Sale' };
    const payload = buildPromoAnnouncementPayload({ firstname: 'Sam' }, promo, []);
    expect(payload.action.buttons[0].reply.title).toBe('Book Now! 📅');
    expect(payload.action.buttons[1].reply.title).toBe('Opt Out');
  });

  test('buildPointsPromoPayload also carries Opt Out as the second button', () => {
    const promo = { _id: 'p3', customerType: 'points', pointsPrice: 100, name: 'Redeem' };
    const { interactive, textFallback } = buildPointsPromoPayload({ firstname: 'Sam', loyaltyPoints: 500 }, promo, []);
    expect(interactive.action.buttons.length).toBe(2);
    expect(interactive.action.buttons[1].reply.title).toBe('Opt Out');
    expect(textFallback).toMatch(/STOP/);
  });
});

describe('webhook: Opt Out button tap withdraws consent', () => {
  let workspaceId, promotion;

  beforeAll(async () => {
    await connectOnce();
    workspaceId = await getTestWorkspaceId(app);
    promotion = await Promotion.create({ name: '__test_optout_promo__', scope: 'products', customerType: 'cash', workspaceId });
  }, 30000);

  afterAll(async () => {
    await Promotion.findByIdAndDelete(promotion._id);
  });

  async function cleanup(customer) {
    await ConsentEvent.deleteMany({ customerId: customer._id });
    await Customer.findByIdAndDelete(customer._id);
  }

  test('interactive button_reply: withdraws consent and logs whatsapp_optout_button', async () => {
    const phone = '15559995001';
    const customer = await Customer.create({
      firstname: 'Test', lastname: 'OptOutInteractive', phone, workspaceId,
      marketingConsent: true, marketingConsentAt: new Date(), marketingConsentMethod: 'manual_staff_entry',
    });
    try {
      await request(app).post('/webhook').send({
        entry: [{ changes: [{ value: {
          messages: [{
            from: phone, type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: `optout_${promotion._id}` } },
          }],
        } }] }],
      });

      const updated = await waitUntil(async () => {
        const doc = await Customer.findById(customer._id);
        return doc.optedOut ? doc : null;
      });
      expect(updated.optedOut).toBe(true);

      const events = await ConsentEvent.find({ customerId: customer._id });
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('consent_withdrawn');
      expect(events[0].method).toBe('whatsapp_optout_button');
    } finally {
      await cleanup(customer);
    }
  }, 15000);

  test('template quick-reply (message.type:"button"): also withdraws consent', async () => {
    const phone = '15559995002';
    const customer = await Customer.create({ firstname: 'Test', lastname: 'OptOutTemplate', phone, workspaceId, marketingConsent: true });
    try {
      await request(app).post('/webhook').send({
        entry: [{ changes: [{ value: {
          messages: [{ from: phone, type: 'button', button: { payload: `optout_${promotion._id}` } }],
        } }] }],
      });

      const updated = await waitUntil(async () => {
        const doc = await Customer.findById(customer._id);
        return doc.optedOut ? doc : null;
      });
      expect(updated.optedOut).toBe(true);
    } finally {
      await cleanup(customer);
    }
  }, 15000);

  test('tapping Opt Out again when already opted out still runs and logs a new event (no skip)', async () => {
    const phone = '15559995003';
    const customer = await Customer.create({ firstname: 'Test', lastname: 'OptOutTwice', phone, workspaceId, marketingConsent: false, optedOut: true, optedOutAt: new Date(Date.now() - 60000) });
    try {
      await request(app).post('/webhook').send({
        entry: [{ changes: [{ value: {
          messages: [{
            from: phone, type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: `optout_${promotion._id}` } },
          }],
        } }] }],
      });

      const events = await waitUntil(async () => {
        const evs = await ConsentEvent.find({ customerId: customer._id });
        return evs.length ? evs : null;
      });
      expect(events.length).toBe(1); // ran and logged even though marketingConsent was already false / already opted out
      expect(events[0].type).toBe('consent_withdrawn');

      const updated = await Customer.findById(customer._id);
      expect(updated.optedOut).toBe(true);
    } finally {
      await cleanup(customer);
    }
  }, 15000);
});
