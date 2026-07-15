const router   = require('express').Router();
const Service  = require('../models/Service');
const TimeSlot = require('../models/TimeSlot');
const Booking  = require('../models/Booking');
const Customer = require('../models/Customer');
const ops      = require('../shared/operations');

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
    res.json(await ops.cancelBooking({ bookingId: req.params.bookingId }));
  } catch (err) {
    if (err.message === 'Booking not found') return res.status(404).json({ error: 'Booking not found' });
    if (err.message === 'Already cancelled') return res.status(400).json({ error: 'Already cancelled' });
    res.status(500).json({ error: err.message });
  }
});

// Reschedule — manager picks new slot; sends WA asking customer to confirm (free of charge)
router.post('/bookings/:bookingId/reschedule', async (req, res) => {
  try {
    res.json(await ops.rescheduleBooking({ bookingId: req.params.bookingId, newSlotId: req.body.newSlotId }));
  } catch (err) {
    if (err.message === 'Booking not found') return res.status(404).json({ error: 'Booking not found' });
    if (err.message === 'New slot not found') return res.status(404).json({ error: 'New slot not found' });
    if (err.message === 'Slot is full') return res.status(400).json({ error: 'Slot is full' });
    res.status(500).json({ error: err.message });
  }
});

// Mark booking complete
router.post('/bookings/:bookingId/complete', async (req, res) => {
  try {
    res.json(await ops.completeBooking({ bookingId: req.params.bookingId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve a "Reserve — Pay in Person" request
router.post('/bookings/:bookingId/confirm', async (req, res) => {
  try {
    res.json(await ops.confirmBooking({ bookingId: req.params.bookingId }));
  } catch (err) {
    if (err.message === 'Booking not found') return res.status(404).json({ error: 'Booking not found' });
    res.status(400).json({ error: err.message });
  }
});

// Decline a "Reserve — Pay in Person" request — frees the slot
router.post('/bookings/:bookingId/decline', async (req, res) => {
  try {
    res.json(await ops.declineBooking({ bookingId: req.params.bookingId }));
  } catch (err) {
    if (err.message === 'Booking not found') return res.status(404).json({ error: 'Booking not found' });
    res.status(400).json({ error: err.message });
  }
});

// Manually mark a confirmed booking as a no-show
router.post('/bookings/:bookingId/no-show', async (req, res) => {
  try {
    res.json(await ops.markNoShow({ bookingId: req.params.bookingId }));
  } catch (err) {
    if (err.message === 'Booking not found') return res.status(404).json({ error: 'Booking not found' });
    res.status(400).json({ error: err.message });
  }
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
