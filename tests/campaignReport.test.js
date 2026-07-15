require('dotenv').config();
const mongoose = require('mongoose');

const { connectOnce } = require('./dbSetup');
const ops              = require('../shared/operations');
const Customer         = require('../models/Customer');
const Promotion        = require('../models/Promotion');
const CampaignMessage  = require('../models/CampaignMessage');

const TEST_PHONE = '15550002222';

describe('getCampaignReport', () => {
  let customer, promotion;

  beforeAll(async () => {
    await connectOnce();
    customer = await Customer.create({ firstname: 'Report', lastname: 'Test', phone: TEST_PHONE });
    promotion = await Promotion.create({ name: '__test_report_campaign__', scope: 'products', customerType: 'cash' });
  });

  afterAll(async () => {
    await CampaignMessage.deleteMany({ promotion: promotion._id });
    await Promotion.findByIdAndDelete(promotion._id);
    await Customer.findByIdAndDelete(customer._id);
  });

  // Regression test: a genuinely missing field is a distinct BSON type from
  // null in aggregation expressions, so `{ $ne: ['$order', null] }` counts
  // every never-ordered message as "ordered". Must use $gt instead.
  test('a message with clickedAt/order left unset does not count as clicked/ordered', async () => {
    await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.NOCLICK', messageType: 'interactive', status: 'sent', sentAt: new Date(),
    });

    const report = await ops.getCampaignReport({ promotionId: promotion._id });
    expect(report.messagesSent).toBe(1);
    expect(report.clicked).toBe(0);
    expect(report.ordersCreated).toBe(0);
  });

  test('a message with clickedAt and order explicitly set counts correctly', async () => {
    const fakeOrderId = new mongoose.Types.ObjectId();
    await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.CLICKED', messageType: 'interactive', status: 'delivered', sentAt: new Date(),
      clickedAt: new Date(), order: fakeOrderId, revenue: 42, pointsIssued: 10,
    });

    const report = await ops.getCampaignReport({ promotionId: promotion._id });
    expect(report.clicked).toBe(1);
    expect(report.ordersCreated).toBe(1);
    expect(report.revenue).toBeCloseTo(42);
    expect(report.pointsIssued).toBe(10);
  });
});
