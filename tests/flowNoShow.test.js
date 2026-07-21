require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const scheduler = require('../utils/flowScheduler');
const Customer = require('../models/Customer');
const Service = require('../models/Service');
const TimeSlot = require('../models/TimeSlot');
const Booking = require('../models/Booking');
const Flow = require('../models/Flow');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const { NO_SHOW_TEMPLATE } = require('../utils/whatsapp');

const HOURS = 60 * 60 * 1000;

describe('flow trigger: booking_no_show', () => {
  let flow, service, slot;

  beforeAll(async () => {
    await connectOnce();
    flow = await Flow.create({ name: '__test_no_show_flow__', triggerType: 'booking_no_show', delayHours: 1, templateName: NO_SHOW_TEMPLATE, status: 'active' });
    service = await Service.create({ name: '__test_no_show_service__', basePrice: 50 });
    slot = await TimeSlot.create({ serviceId: service._id, date: '2020-01-01', startTime: '09:00', endTime: '10:00' });
  }, 15000);

  afterAll(async () => {
    await Flow.findByIdAndDelete(flow._id);
    await TimeSlot.findByIdAndDelete(slot._id);
    await Service.findByIdAndDelete(service._id);
  });

  async function makeCustomer(phoneSuffix) {
    return Customer.create({ firstname: '__test_noshow_customer__', lastname: 'Test', phone: `1555300${phoneSuffix}` });
  }

  // Bypasses Mongoose's timestamps hook via the native collection so updatedAt
  // reflects "how long ago this became no-show" instead of "just now" — a
  // regular save()/findByIdAndUpdate() would always stamp updatedAt to now.
  async function makeBooking(customer, { ageHours = 3 } = {}) {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer ? customer._id : null,
      phone: customer ? customer.phone : '15553099', customerName: customer ? customer.firstname : 'Walk-in',
      status: 'confirmed', paymentType: 'cash', amount: 50,
    });
    await Booking.collection.updateOne(
      { _id: booking._id },
      { $set: { status: 'no-show', updatedAt: new Date(Date.now() - ageHours * HOURS) } },
    );
    return Booking.findById(booking._id);
  }

  async function cleanup(customer, booking) {
    if (customer) await CampaignMessage.deleteMany({ customer: customer._id });
    if (customer) await FlowEnrollment.deleteMany({ customer: customer._id });
    await Booking.findByIdAndDelete(booking._id);
    if (customer) await Customer.findByIdAndDelete(customer._id);
  }

  test('a linked no-show past its delay is eligible and gets sent', async () => {
    const customer = await makeCustomer('01');
    const booking = await makeBooking(customer, { ageHours: 3 });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: booking._id });
      expect(enrollment).toBeTruthy();

      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('messaged');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(1);
    } finally {
      await cleanup(customer, booking);
    }
  }, 15000);

  test('a no-show not yet past its delay is not eligible', async () => {
    const customer = await makeCustomer('02');
    const booking = await makeBooking(customer, { ageHours: 0.1 });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: booking._id });
      expect(enrollment).toBeNull();
    } finally {
      await cleanup(customer, booking);
    }
  }, 15000);

  test('a no-show with no linked customer is never eligible', async () => {
    const booking = await makeBooking(null, { ageHours: 3 });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: booking._id });
      expect(enrollment).toBeNull();
    } finally {
      await cleanup(null, booking);
    }
  }, 15000);

  test('a booking whose status reverses before send exits instead of sending', async () => {
    const customer = await makeCustomer('04');
    const booking = await makeBooking(customer, { ageHours: 3 });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      const enrollment = await FlowEnrollment.findOne({ flow: flow._id, sourceRef: booking._id });
      expect(enrollment).toBeTruthy();

      // Merchant corrects a mis-marked no-show back to confirmed before the send sweep runs
      await Booking.findByIdAndUpdate(booking._id, { status: 'confirmed' });
      await scheduler.sendPendingEnrollments(flow);

      const updated = await FlowEnrollment.findById(enrollment._id);
      expect(updated.state).toBe('exited');
      expect(updated.exitReason).toBe('status_changed');
      const messageCount = await CampaignMessage.countDocuments({ flowEnrollment: enrollment._id });
      expect(messageCount).toBe(0);
    } finally {
      await cleanup(customer, booking);
    }
  }, 15000);

  test('the same booking never enrolls twice, even across repeated sweeps', async () => {
    const customer = await makeCustomer('05');
    const booking = await makeBooking(customer, { ageHours: 3 });
    try {
      await scheduler.enrollEligibleCustomers(flow);
      await scheduler.enrollEligibleCustomers(flow);
      await scheduler.enrollEligibleCustomers(flow);
      const count = await FlowEnrollment.countDocuments({ flow: flow._id, sourceRef: booking._id });
      expect(count).toBe(1);
    } finally {
      await cleanup(customer, booking);
    }
  }, 15000);
});
