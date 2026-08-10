const mongoose = require('mongoose');

// Deliberately minimal (Phase: Bulk Import) — this ledger exists ONLY to make
// the CSV-import re-import safety rule possible ("don't re-credit a starting
// balance this customer already received"). Normal earning/redemption is NOT
// retrofitted to write here — Customer.loyaltyPoints stays the single flat
// running total for everything except imported starting balances, exactly as
// before this feature. Append-only: entries are never edited or deleted, so
// summing a customer's 'imported_balance' entries always equals "total ever
// imported," which is what a future re-import's discrepancy check compares
// the file's value against.
const schema = new mongoose.Schema({
  workspaceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  customerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  type:        { type: String, enum: ['imported_balance'], required: true },
  // A correction on re-import records only the delta (newValue - previousTotal),
  // not the raw file value — see shared/importEngine.js.
  amount:      { type: Number, required: true },
  importJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'ImportJob', required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

schema.index({ customerId: 1, type: 1 });

module.exports = mongoose.model('PointsLedgerEntry', schema);
