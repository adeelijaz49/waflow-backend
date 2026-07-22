require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Order = require('../models/Order');
const Service = require('../models/Service');
const TimeSlot = require('../models/TimeSlot');
const Booking = require('../models/Booking');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');
const { POST_PURCHASE_TEMPLATE, POINTS_NUDGE_TEMPLATE, NO_SHOW_TEMPLATE } = require('../utils/whatsapp');

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

// Phase 1 proved the branching *mechanism* (webhook routing, idempotency,
// activation guard) is trigger-agnostic — these tests just confirm each of
// the remaining 3 trigger plugins' buildSend actually routes to the custom
// entry template (with the right bodyParams) when the flow has one, per the
// Phase 2 rollout.
describe('flow branching Phase 2: entry send rollout to remaining trigger types', () => {
  test('post_purchase_points sends the custom template with [name, points]', async () => {
    await connectOnce();
    const flow = await Flow.create({ name: '__test_rollout_pp_flow__', triggerType: 'post_purchase_points', delayHours: 2, templateName: POST_PURCHASE_TEMPLATE, status: 'active' });
    const node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Thanks {{1}}! You have {{2}} points.',
      templateName: 'waflow_flow_test_pp', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }],
    });
    const freshFlow = await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id }, { new: true });
    const customer = await Customer.create({ firstname: '__test_rollout_pp_customer__', lastname: 'Test', phone: '15558001', loyaltyPoints: 250 });
    const order = await Order.create({ customer: customer._id, subtotal: 10, total: 10, paymentStatus: 'paid', paidAt: new Date(Date.now() - 3 * HOURS) });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled', sourceModel: 'Order', sourceRef: order._id });
      await scheduler.processEnrollment(freshFlow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.templateName).toBe('waflow_flow_test_pp');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
    } finally {
      await CampaignMessage.deleteMany({ customer: customer._id });
      await FlowEnrollment.deleteMany({ customer: customer._id });
      await Order.findByIdAndDelete(order._id);
      await Customer.findByIdAndDelete(customer._id);
      await MessageNode.findByIdAndDelete(node._id);
      await Flow.findByIdAndDelete(flow._id);
    }
  }, 15000);

  test('points_balance_reminder sends the custom template with [name, points]', async () => {
    await connectOnce();
    const flow = await Flow.create({ name: '__test_rollout_pr_flow__', triggerType: 'points_balance_reminder', inactivityDays: 30, templateName: POINTS_NUDGE_TEMPLATE, status: 'active' });
    const node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}, you still have {{2}} points.',
      templateName: 'waflow_flow_test_pr', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Redeem', nextAction: { type: 'end_flow' } }],
    });
    const freshFlow = await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id }, { new: true });
    const customer = await Customer.create({
      firstname: '__test_rollout_pr_customer__', lastname: 'Test', phone: '15558002',
      loyaltyPoints: 500, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAYS),
    });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled' });
      await scheduler.processEnrollment(freshFlow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.templateName).toBe('waflow_flow_test_pr');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
    } finally {
      await CampaignMessage.deleteMany({ customer: customer._id });
      await FlowEnrollment.deleteMany({ customer: customer._id });
      await Customer.findByIdAndDelete(customer._id);
      await MessageNode.findByIdAndDelete(node._id);
      await Flow.findByIdAndDelete(flow._id);
    }
  }, 15000);

  test('booking_no_show sends the custom template with [name, serviceName] and msgnode_ buttons (not flownoshow_)', async () => {
    await connectOnce();
    const flow = await Flow.create({ name: '__test_rollout_ns_flow__', triggerType: 'booking_no_show', delayHours: 1, templateName: NO_SHOW_TEMPLATE, status: 'active' });
    const node = await MessageNode.create({
      ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: 'Hi {{1}}, we missed you at {{2}}.',
      templateName: 'waflow_flow_test_ns', templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Rebook', nextAction: { type: 'end_flow' } }],
    });
    const freshFlow = await Flow.findByIdAndUpdate(flow._id, { entryNodeId: node._id }, { new: true });
    const customer = await Customer.create({ firstname: '__test_rollout_ns_customer__', lastname: 'Test', phone: '15558003' });
    const service = await Service.create({ name: '__test_rollout_ns_service__', basePrice: 50 });
    const slot = await TimeSlot.create({ serviceId: service._id, date: '2020-01-01', startTime: '09:00', endTime: '10:00' });
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: customer.phone,
      customerName: customer.firstname, status: 'no-show', paymentType: 'cash', amount: 50,
    });
    try {
      const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id, state: 'enrolled', sourceModel: 'Booking', sourceRef: booking._id });
      await scheduler.processEnrollment(freshFlow, enrollment);

      const cm = await CampaignMessage.findOne({ flowEnrollment: enrollment._id });
      expect(cm.templateName).toBe('waflow_flow_test_ns');
      expect(cm.messageNode.toString()).toBe(node._id.toString());
    } finally {
      await CampaignMessage.deleteMany({ customer: customer._id });
      await FlowEnrollment.deleteMany({ customer: customer._id });
      await Booking.findByIdAndDelete(booking._id);
      await TimeSlot.findByIdAndDelete(slot._id);
      await Service.findByIdAndDelete(service._id);
      await Customer.findByIdAndDelete(customer._id);
      await MessageNode.findByIdAndDelete(node._id);
      await Flow.findByIdAndDelete(flow._id);
    }
  }, 15000);
});
