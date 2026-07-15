require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const ops       = require('../shared/operations');
const Customer  = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const Service   = require('../models/Service');
const TimeSlot  = require('../models/TimeSlot');
const Booking   = require('../models/Booking');

const TEST_PHONE = '15550005555';

describe('customer WhatsApp history + bookings', () => {
  let customer, promotion, cm, service, slot, booking;

  beforeAll(async () => {
    await connectOnce();
    customer  = await Customer.create({ firstname: 'History', lastname: 'Test', phone: TEST_PHONE });
    promotion = await Promotion.create({ name: '__test_history_campaign__', scope: 'products', customerType: 'cash' });
    cm = await CampaignMessage.create({
      kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: TEST_PHONE,
      wamid: 'wamid.HISTORYTEST', messageType: 'interactive', status: 'sent', sentAt: new Date(),
    });
    service = await Service.create({ name: '__test_history_service__', category: 'Test', duration: 30, basePrice: 30 });
    slot = await TimeSlot.create({ serviceId: service._id, date: '2099-01-01', startTime: '09:00', endTime: '09:30', capacity: 1, bookedCount: 1 });
    booking = await Booking.create({
      serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: TEST_PHONE,
      status: 'confirmed', paymentType: 'cash', amount: 30,
    });
  }, 15000);

  afterAll(async () => {
    await Booking.deleteMany({ customerId: customer._id });
    await TimeSlot.findByIdAndDelete(slot._id);
    await Service.findByIdAndDelete(service._id);
    await CampaignMessage.deleteMany({ customer: customer._id });
    await Promotion.findByIdAndDelete(promotion._id);
    await Customer.findByIdAndDelete(customer._id);
  });

  test('getCustomerWhatsAppHistory returns this customer\'s campaign messages with promotion populated', async () => {
    const history = await ops.getCustomerWhatsAppHistory({ customerId: customer._id });
    expect(history.length).toBeGreaterThanOrEqual(1);
    const entry = history.find(h => h._id.toString() === cm._id.toString());
    expect(entry).toBeTruthy();
    expect(entry.promotion?.name).toBe('__test_history_campaign__');
  });

  test('listBookings filters by customerId', async () => {
    const bookings = await ops.listBookings({ customerId: customer._id });
    expect(bookings.length).toBeGreaterThanOrEqual(1);
    const entry = bookings.find(b => b._id.toString() === booking._id.toString());
    expect(entry).toBeTruthy();
    expect(entry.serviceId?.name).toBe('__test_history_service__');
  });
});
