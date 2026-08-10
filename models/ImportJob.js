const mongoose = require('mongoose');

const rowErrorSchema = new mongoose.Schema({
  rowIndex: { type: Number, required: true },
  field:    { type: String }, // omitted for row-level (not field-specific) errors
  reason:   { type: String, required: true },
}, { _id: false });

// Customer-only — a re-imported starting balance that differs from what this
// customer already received on a prior import. Never auto-applied; the
// merchant resolves each one explicitly (see shared/importEngine.js).
const discrepancySchema = new mongoose.Schema({
  rowIndex:                { type: Number, required: true },
  customerId:               { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  customerName:             { type: String },
  phone:                    { type: String },
  previousImportedBalance: { type: Number, required: true },
  newFileValue:             { type: Number, required: true },
  resolution:               { type: String, enum: ['pending', 'apply', 'skip'], default: 'pending' },
}, { _id: false });

const schema = new mongoose.Schema({
  workspaceId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  entityType:       { type: String, enum: ['customer', 'product', 'service'], required: true },
  status:           { type: String, enum: ['uploaded', 'mapping', 'validating', 'ready', 'importing', 'completed', 'failed'], default: 'uploaded' },
  originalFilename: { type: String },
  headers:          { type: [String], default: [] },
  // { waflowFieldKey: sourceCsvHeader } — set once the merchant confirms Step 2.
  columnMapping:    { type: mongoose.Schema.Types.Mixed, default: {} },
  // Raw parsed rows, capped at 5,000 (enforced at upload time) — kept on the
  // job itself rather than a temp file so re-validating after a mapping edit
  // needs no re-upload, and nothing orphaned survives an abandoned job.
  rows:             { type: [mongoose.Schema.Types.Mixed], default: [] },
  totalRows:             { type: Number, default: 0 },
  importedCount:         { type: Number, default: 0 },
  skippedDuplicateCount: { type: Number, default: 0 }, // matched an existing record -> updated, not inserted
  failedCount:           { type: Number, default: 0 },
  rowErrors:     { type: [rowErrorSchema], default: [] },
  discrepancies: { type: [discrepancySchema], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  // Customer imports only — file-level attestation checkbox from the upload
  // step ("these contacts have agreed to receive marketing messages"). When
  // true, every clean/duplicate customer row grants marketingConsent with a
  // logged ConsentEvent; left unchecked, imported customers stay unconsented
  // until captured some other way. See shared/importEngine.js#runImport.
  marketingConsentAttested: { type: Boolean, default: false },
}, { timestamps: true });

schema.index({ workspaceId: 1, createdAt: -1 });

module.exports = mongoose.model('ImportJob', schema);
