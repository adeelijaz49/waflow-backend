const mongoose = require('mongoose');

// A single fixed-_id document used as a lightweight advisory lock so the flow
// scheduler doesn't run two overlapping sweeps if this app is ever scaled to
// multiple instances. This is an efficiency/thundering-herd guard only — the
// actual "no duplicate send" guarantee comes from FlowEnrollment's atomic
// per-document claim (see utils/flowScheduler.js), which holds regardless of
// whether this lock is held.
const schema = new mongoose.Schema({
  _id:         String,
  lockedAt:    Date,
  lockedUntil: Date,
});

module.exports = mongoose.model('SchedulerLock', schema);
