const router   = require('express').Router();
const Service  = require('../models/Service');
const TimeSlot = require('../models/TimeSlot');
const Booking  = require('../models/Booking');
const Customer = require('../models/Customer');
const { sendRebookMessage } = require('../utils/whatsapp');

// ─── Services CRUD ────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const services = await Service.find({ active: true }).sort({ name: 1 });
    res.json(services);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', async (req, res) => {
  try {
    const service = await Service.create(req.body);
    res.json(service);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const service  = await Service.findById(req.params.id);
    if (!service) return res.status(404).json({ error: 'Not found' });
    const slots    = await TimeSlot.find({ serviceId: req.params.id }).sort({ date: 1, startTime: 1 });
    const bookings = await Booking.find({ serviceId: req.params.id })
      .sort({ createdAt: -1 })
      .populate('customerId', 'firstname lastname phone');
    res.json({ service, slots, bookings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const service = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(service);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await Service.findByIdAndUpdate(req.params.id, { active: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Time Slots ───────────────────────────────────────────────────────────────

router.get('/:id/slots', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const slots = await TimeSlot.find({
      serviceId: req.params.id,
      date:      { $gte: today },
    }).sort({ date: 1, startTime: 1 });
    res.json(slots);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/slots', async (req, res) => {
  try {
    const slot = await TimeSlot.create({ ...req.body, serviceId: req.params.id });
    res.json(slot);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id/slots/:slotId', async (req, res) => {
  try {
    const slot = await TimeSlot.findByIdAndUpdate(req.params.slotId, req.body, { new: true });
    res.json(slot);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id/slots/:slotId', async (req, res) => {
  try {
    await TimeSlot.findByIdAndDelete(req.params.slotId);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bookings ─────────────────────────────────────────────────────────────────

router.get('/:id/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find({ serviceId: req.params.id })
      .sort({ createdAt: -1 })
      .populate('slotId')
      .populate('customerId', 'firstname lastname phone');
    res.json(bookings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancel a booking — marks it cancelled, frees the slot capacity, sends WA rebook message
router.post('/bookings/:bookingId/cancel', async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId)
      .populate('serviceId')
      .populate('slotId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status === 'cancelled') return res.status(400).json({ error: 'Already cancelled' });

    booking.status = 'cancelled';
    await booking.save();

    // Free up the slot
    await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });

    // Send WhatsApp rebook message to the customer
    try {
      await sendRebookMessage(
        booking.phone,
        booking.customerName || 'Valued Customer',
        booking.serviceId?.name || 'your service',
        booking.slotId,
        booking.serviceId?._id?.toString(),
        booking._id.toString(),
      );
    } catch (waErr) {
      console.warn('WA rebook message failed:', waErr.message);
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reschedule — manager picks new slot; sends WA asking customer to confirm (free of charge)
router.post('/bookings/:bookingId/reschedule', async (req, res) => {
  try {
    const { newSlotId } = req.body;
    const booking = await Booking.findById(req.params.bookingId)
      .populate('serviceId')
      .populate('slotId');
    if (!booking) return res.status(404).json({ error: 'Booking not found' });

    const newSlot = await TimeSlot.findById(newSlotId);
    if (!newSlot) return res.status(404).json({ error: 'New slot not found' });
    if (newSlot.bookedCount >= newSlot.capacity) return res.status(400).json({ error: 'Slot is full' });

    // Free old slot, fill new slot
    await TimeSlot.findByIdAndUpdate(booking.slotId._id, { $inc: { bookedCount: -1 } });
    await TimeSlot.findByIdAndUpdate(newSlotId, { $inc: { bookedCount: 1 } });

    booking.slotId = newSlotId;
    booking.status = 'confirmed';
    await booking.save();

    // Notify customer
    try {
      const { waPost } = require('../utils/whatsapp');
      const slotLabel = `${newSlot.date} at ${newSlot.startTime}`;
      await waPost({
        messaging_product: 'whatsapp',
        to: booking.phone,
        type: 'text',
        text: { body: `📅 Your booking for *${booking.serviceId?.name}* has been rescheduled to *${slotLabel}*. See you then! 🎉` },
      });
    } catch (waErr) {
      console.warn('WA reschedule notify failed:', waErr.message);
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark booking complete
router.post('/bookings/:bookingId/complete', async (req, res) => {
  try {
    await Booking.findByIdAndUpdate(req.params.bookingId, { status: 'completed' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// All bookings (cross-service, for dashboard)
router.get('/bookings/all', async (req, res) => {
  try {
    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('serviceId', 'name category')
      .populate('slotId')
      .populate('customerId', 'firstname lastname phone');
    res.json(bookings);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
