require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops       = require('../shared/operations');
const Service   = require('../models/Service');
const TimeSlot  = require('../models/TimeSlot');
const Customer  = require('../models/Customer');
const Booking   = require('../models/Booking');

const TEST_PHONE = '15550004444';

describe('booking approval workflow: confirm / decline / no-show', () => {
  let service, slot, customer;

  beforeAll(async () => {
    await connectOnce();
    service  = await Service.create({ name: '__test_service__', category: 'Test', duration: 30, basePrice: 50 });
    customer = await Customer.create({ firstname: 'Booking', lastname: 'Test', phone: TEST_PHONE });
  }, 15000);

  afterAll(async () => {
    await Booking.deleteMany({ serviceId: service._id });
    await TimeSlot.deleteMany({ serviceId: service._id });
    await Service.findByIdAndDelete(service._id);
    await Customer.findByIdAndDelete(customer._id);
  });

  beforeEach(async () => {
    // A fresh slot per test — capacity 3, already holding 1 (the requested booking below).
    slot = await TimeSlot.create({ serviceId: service._id, date: '2099-01-01', startTime: '10:00', endTime: '10:30', capacity: 3, bookedCount: 1 });
  });

  afterEach(async () => {
    await TimeSlot.findByIdAndDelete(slot._id);
  });

  test('confirmBooking moves a requested booking to confirmed', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'requested', paymentType: 'pay_later', amount: 50,
    });
    const updated = await ops.confirmBooking({ bookingId: booking._id });
    expect(updated.status).toBe('confirmed');
  });

  test('confirmBooking rejects a booking that is not requested', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'confirmed', paymentType: 'cash', amount: 50,
    });
    await expect(ops.confirmBooking({ bookingId: booking._id })).rejects.toThrow('Only requested bookings can be confirmed');
  });

  test('declineBooking cancels the booking and frees the slot', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'requested', paymentType: 'pay_later', amount: 50,
    });
    const updated = await ops.declineBooking({ bookingId: booking._id });
    expect(updated.status).toBe('cancelled');
    const freedSlot = await TimeSlot.findById(slot._id);
    expect(freedSlot.bookedCount).toBe(0);
  });

  test('declineBooking rejects a booking that is not requested', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'completed', paymentType: 'cash', amount: 50,
    });
    await expect(ops.declineBooking({ bookingId: booking._id })).rejects.toThrow('Only requested bookings can be declined');
  });

  test('markNoShow moves a confirmed booking to no-show without touching slot capacity', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'confirmed', paymentType: 'cash', amount: 50,
    });
    const updated = await ops.markNoShow({ bookingId: booking._id });
    expect(updated.status).toBe('no-show');
    const unchangedSlot = await TimeSlot.findById(slot._id);
    expect(unchangedSlot.bookedCount).toBe(1);
  });

  test('markNoShow rejects a booking that is not confirmed', async () => {
    const booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'requested', paymentType: 'pay_later', amount: 50,
    });
    await expect(ops.markNoShow({ bookingId: booking._id })).rejects.toThrow('Only confirmed bookings can be marked no-show');
  });
});
