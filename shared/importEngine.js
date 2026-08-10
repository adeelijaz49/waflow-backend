// Generic bulk CSV/XLSX import engine — one engine configured per entity
// type (customer/product/service), not three separate implementations. See
// the "Bulk CSV/XLSX Import" plan for the full design rationale.
const XLSX = require('xlsx');

const Customer = require('../models/Customer');
const Product  = require('../models/Product');
const Service  = require('../models/Service');
const ImportJob = require('../models/ImportJob');
const PointsLedgerEntry = require('../models/PointsLedgerEntry');
const { withWorkspace } = require('./operations');
const { normalizePhoneForDedup } = require('../utils/phoneNormalize');
const { parsePrice } = require('../utils/currency');

const MAX_ROWS = 5000;

// ─── Per-entity-type configuration ────────────────────────────────────────────
const ENTITY_CONFIGS = {
  customer: {
    label: 'Customers',
    Model: Customer,
    matchType: 'phone',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'string',
        aliases: ['name', 'full name', 'customer name'] },
      { key: 'phone', label: 'Phone', required: true, type: 'phone',
        aliases: ['phone', 'mobile', 'contact number', 'phone number', 'whatsapp', 'whatsapp number'] },
      { key: 'email', label: 'Email', required: false, type: 'email',
        aliases: ['email', 'e-mail'] },
      { key: 'startingPoints', label: 'Starting Loyalty Points Balance', required: false, type: 'number',
        aliases: ['points', 'loyalty points', 'starting balance', 'loyalty balance', 'starting loyalty points balance'] },
      { key: 'notes', label: 'Notes', required: false, type: 'string',
        aliases: ['notes', 'tags', 'note'] },
    ],
  },
  product: {
    label: 'Products',
    Model: Product,
    matchType: 'name',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'string',
        aliases: ['name', 'product name', 'item'] },
      { key: 'basePrice', label: 'Price', required: true, type: 'price',
        aliases: ['price', 'base price', 'cost'] },
      { key: 'category', label: 'Category', required: false, type: 'string',
        aliases: ['category', 'type'] },
      { key: 'description', label: 'Description', required: false, type: 'string',
        aliases: ['description', 'desc'] },
    ],
  },
  service: {
    label: 'Services',
    Model: Service,
    matchType: 'name',
    fields: [
      { key: 'name', label: 'Name', required: true, type: 'string',
        aliases: ['name', 'service name'] },
      { key: 'basePrice', label: 'Price', required: true, type: 'price',
        aliases: ['price', 'base price', 'cost'] },
      { key: 'category', label: 'Category', required: false, type: 'string',
        aliases: ['category', 'type'] },
      { key: 'description', label: 'Description', required: false, type: 'string',
        aliases: ['description', 'desc'] },
      { key: 'duration', label: 'Duration (minutes)', required: false, type: 'number',
        aliases: ['duration', 'duration (min)', 'length'] },
    ],
  },
};

function getConfig(entityType) {
  const cfg = ENTITY_CONFIGS[entityType];
  if (!cfg) throw new Error('Unknown entity type');
  return cfg;
}

// ─── File parsing ──────────────────────────────────────────────────────────────
// XLSX.read() auto-detects CSV vs XLSX content from the buffer — one code
// path covers both formats, so no separate CSV-only library is needed.
// raw:false formats every cell as its display string rather than XLSX's
// inferred JS type — without it, a bare phone number like "0501234567"
// silently becomes the *number* 501234567 (leading zero dropped), which is
// exactly the kind of cosmetic-formatting loss the phone matching in this
// engine is supposed to tolerate, not get corrupted by upstream.
function parseFile(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const headerRow = XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || [];
  const headers = headerRow.map(h => String(h).trim()).filter(Boolean);
  return { headers, rows };
}

function autoDetectMapping(headers, entityType) {
  const cfg = getConfig(entityType);
  const mapping = {};
  for (const field of cfg.fields) {
    const hit = headers.find(h => field.aliases.includes(String(h).trim().toLowerCase()));
    if (hit) mapping[field.key] = hit;
  }
  return mapping;
}

// ─── Field coercion ─────────────────────────────────────────────────────────────
function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  const firstname = parts[0] || '';
  const lastname = parts.slice(1).join(' ') || firstname;
  return { firstname, lastname };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Returns { value, error, normalizedPhone? } — value is undefined (not an
// error) for an empty cell on an optional field; error is set only when the
// cell has content but doesn't parse.
function coerceField(rawValue, field, defaultCountryCode) {
  const isEmpty = rawValue === undefined || rawValue === null || String(rawValue).trim() === '';
  if (isEmpty) {
    if (field.required) return { value: undefined, error: `${field.label} is required` };
    return { value: undefined, error: null };
  }
  switch (field.type) {
    case 'phone': {
      const normalizedPhone = normalizePhoneForDedup(rawValue, defaultCountryCode);
      if (!normalizedPhone) return { value: undefined, error: `${field.label} is not a valid phone number` };
      return { value: normalizedPhone, normalizedPhone };
    }
    case 'price': {
      const n = parsePrice(rawValue);
      if (n === null || n < 0) return { value: undefined, error: `${field.label} is not a valid price` };
      return { value: n };
    }
    case 'number': {
      const n = parsePrice(rawValue); // same tolerant strip-then-parse works for plain numbers too
      if (n === null) return { value: undefined, error: `${field.label} is not a valid number` };
      return { value: n };
    }
    case 'email': {
      const v = String(rawValue).trim();
      if (!EMAIL_RE.test(v)) return { value: undefined, error: `${field.label} is not a valid email address` };
      return { value: v };
    }
    default:
      return { value: String(rawValue).trim() };
  }
}

function mapRow(row, mapping, config, defaultCountryCode) {
  const mapped = {};
  const errors = [];
  for (const field of config.fields) {
    const header = mapping[field.key];
    const raw = header ? row[header] : undefined;
    const { value, error, normalizedPhone } = coerceField(raw, field, defaultCountryCode);
    if (error) errors.push({ field: field.key, reason: error });
    if (value !== undefined) mapped[field.key] = value;
    if (normalizedPhone) mapped._normalizedPhone = normalizedPhone;
  }
  return { mapped, errors };
}

function dedupKey(mapped, config) {
  if (config.matchType === 'phone') return mapped._normalizedPhone || null;
  if (config.matchType === 'name') return mapped.name ? mapped.name.trim().toLowerCase() : null;
  return null;
}

// ─── Dedup index (built once per job, not once per row) ────────────────────────
async function buildDedupIndex(entityType, workspaceId, defaultCountryCode) {
  const config = getConfig(entityType);
  const index = new Map(); // dedupKey -> existing document id
  if (config.matchType === 'phone') {
    const customers = await Customer.find(withWorkspace({}, workspaceId), '_id phone').lean();
    for (const c of customers) {
      const key = normalizePhoneForDedup(c.phone, defaultCountryCode);
      if (key) index.set(key, c._id);
    }
  } else {
    const docs = await config.Model.find(withWorkspace({}, workspaceId), '_id name').lean();
    for (const d of docs) index.set(d.name.trim().toLowerCase(), d._id);
  }
  return index;
}

async function loadImportedBalanceTotals(workspaceId, customerIds) {
  if (!customerIds.length) return new Map();
  const entries = await PointsLedgerEntry.find({
    workspaceId, type: 'imported_balance', customerId: { $in: customerIds },
  }).lean();
  const totals = new Map();
  for (const e of entries) {
    const key = String(e.customerId);
    totals.set(key, (totals.get(key) || 0) + e.amount);
  }
  return totals;
}

// ─── Classification (shared by preview-validate and run) ───────────────────────
// Iterates rows IN ORDER, consulting/growing `index` as it goes so a
// within-file duplicate (the same phone/name appearing twice in one upload)
// correctly resolves against the earlier row instead of creating a second
// copy of it — the same guarantee "re-running an import merges, not
// duplicates" needs to hold within a single file too.
async function classifyRows({ job, defaultCountryCode, index, importedBalanceTotals }) {
  const config = getConfig(job.entityType);
  const results = [];

  for (let i = 0; i < job.rows.length; i++) {
    const row = job.rows[i];
    const { mapped, errors } = mapRow(row, job.columnMapping, config, defaultCountryCode);

    if (errors.length) {
      results.push({ rowIndex: i, mapped, status: 'error', errors, matchedId: null, discrepancy: null });
      continue;
    }

    const key = dedupKey(mapped, config);
    const existing = key ? index.get(key) : null;
    const isNewInThisFile = existing && existing.__pendingRowIndex !== undefined;

    let discrepancy = null;
    if (job.entityType === 'customer' && mapped.startingPoints !== undefined && existing && !isNewInThisFile) {
      const prior = importedBalanceTotals.get(String(existing));
      if (prior !== undefined && prior !== mapped.startingPoints) {
        discrepancy = { previousImportedBalance: prior, newFileValue: mapped.startingPoints };
      }
    }

    const status = existing ? 'duplicate' : 'clean';
    results.push({ rowIndex: i, mapped, status, matchedId: existing || null, discrepancy });

    if (!existing && key) {
      // Placeholder so a LATER row in this same file with the same key
      // resolves as 'duplicate' against this one, not a second insert.
      index.set(key, { __pendingRowIndex: i });
    }
  }

  return results;
}

function summarize(results) {
  return {
    totalRows: results.length,
    clean: results.filter(r => r.status === 'clean').length,
    duplicate: results.filter(r => r.status === 'duplicate').length,
    error: results.filter(r => r.status === 'error').length,
    discrepancy: results.filter(r => r.discrepancy).length,
  };
}

// ─── Job lifecycle ──────────────────────────────────────────────────────────────
async function createImportJob({ file, entityType, workspaceId, userId }) {
  if (!file) throw new Error('No file uploaded');
  getConfig(entityType); // throws on an unknown entityType

  const { headers, rows } = parseFile(file.buffer);
  if (rows.length === 0) throw new Error('The file has no data rows');
  if (rows.length > MAX_ROWS) {
    throw new Error(`This file has ${rows.length} rows — the limit is ${MAX_ROWS}. Please split it into smaller files.`);
  }

  const job = await ImportJob.create({
    workspaceId, entityType, originalFilename: file.originalname,
    headers, rows, totalRows: rows.length,
    columnMapping: autoDetectMapping(headers, entityType),
    status: 'mapping', createdBy: userId,
  });

  return {
    id: job._id, entityType, headers, totalRows: rows.length,
    columnMapping: job.columnMapping, fields: getConfig(entityType).fields,
  };
}

async function getImportJob({ id, workspaceId }) {
  const job = await ImportJob.findOne(withWorkspace({ _id: id }, workspaceId));
  if (!job) throw new Error('Import job not found');
  return job;
}

async function setMappingAndValidate({ id, columnMapping, workspaceId, defaultCountryCode }) {
  const job = await getImportJob({ id, workspaceId });
  const config = getConfig(job.entityType);

  const missingRequired = config.fields.filter(f => f.required && !columnMapping[f.key]);
  if (missingRequired.length) {
    throw new Error(`Please map the required field${missingRequired.length > 1 ? 's' : ''}: ${missingRequired.map(f => f.label).join(', ')}`);
  }

  job.columnMapping = columnMapping;
  job.status = 'validating';

  const index = await buildDedupIndex(job.entityType, workspaceId, defaultCountryCode);
  let importedBalanceTotals = new Map();
  if (job.entityType === 'customer') {
    const existingIds = [...index.values()].filter(v => !(v && v.__pendingRowIndex !== undefined));
    importedBalanceTotals = await loadImportedBalanceTotals(workspaceId, existingIds);
  }

  const results = await classifyRows({ job, defaultCountryCode, index, importedBalanceTotals });

  job.rowErrors = results.filter(r => r.status === 'error')
    .flatMap(r => r.errors.map(e => ({ rowIndex: r.rowIndex, field: e.field, reason: e.reason })));

  job.discrepancies = await Promise.all(
    results.filter(r => r.discrepancy).map(async r => {
      const doc = job.entityType === 'customer' ? await Customer.findById(r.matchedId, 'firstname lastname phone').lean() : null;
      return {
        rowIndex: r.rowIndex, customerId: r.matchedId,
        customerName: doc ? `${doc.firstname} ${doc.lastname}`.trim() : undefined,
        phone: doc?.phone,
        previousImportedBalance: r.discrepancy.previousImportedBalance,
        newFileValue: r.discrepancy.newFileValue,
        resolution: 'pending',
      };
    })
  );

  job.status = 'ready';
  await job.save();

  const summary = summarize(results);
  const preview = (status) => results.filter(r => r.status === status).slice(0, 10)
    .map(r => ({ rowIndex: r.rowIndex, mapped: r.mapped, errors: r.errors }));

  return {
    id: job._id, status: job.status, summary,
    preview: { clean: preview('clean'), duplicate: preview('duplicate'), error: preview('error') },
    discrepancies: job.discrepancies,
  };
}

async function runImport({ id, workspaceId, defaultCountryCode, discrepancyResolutions = [] }) {
  const job = await getImportJob({ id, workspaceId });
  const config = getConfig(job.entityType);
  job.status = 'importing';
  await job.save();

  const resolutionByRow = new Map(discrepancyResolutions.map(r => [r.rowIndex, r.action]));

  const index = await buildDedupIndex(job.entityType, workspaceId, defaultCountryCode);
  let importedBalanceTotals = new Map();
  if (job.entityType === 'customer') {
    const existingIds = [...index.values()].filter(v => !(v && v.__pendingRowIndex !== undefined));
    importedBalanceTotals = await loadImportedBalanceTotals(workspaceId, existingIds);
  }

  let importedCount = 0, skippedDuplicateCount = 0, failedCount = 0;
  const rowErrors = [];

  for (let i = 0; i < job.rows.length; i++) {
    const row = job.rows[i];
    const { mapped, errors } = mapRow(row, job.columnMapping, config, defaultCountryCode);

    if (errors.length) {
      failedCount++;
      rowErrors.push({ rowIndex: i, field: errors[0].field, reason: errors.map(e => e.reason).join('; ') });
      continue;
    }

    const key = dedupKey(mapped, config);
    const existingRaw = key ? index.get(key) : null;
    const existingId = existingRaw && existingRaw.__pendingRowIndex === undefined ? existingRaw : null;

    try {
      if (job.entityType === 'customer') {
        if (existingId) {
          skippedDuplicateCount++;
          const $set = {};
          if (mapped.email !== undefined) $set.email = mapped.email;
          if (mapped.notes !== undefined) $set.notes = mapped.notes;
          if (Object.keys($set).length) await Customer.updateOne({ _id: existingId }, { $set });

          if (mapped.startingPoints !== undefined) {
            const prior = importedBalanceTotals.get(String(existingId));
            if (prior === undefined) {
              await PointsLedgerEntry.create({ workspaceId, customerId: existingId, type: 'imported_balance', amount: mapped.startingPoints, importJobId: job._id });
              await Customer.updateOne({ _id: existingId }, { $inc: { loyaltyPoints: mapped.startingPoints }, $set: { loyaltyPointsUpdatedAt: new Date() } });
              importedBalanceTotals.set(String(existingId), mapped.startingPoints);
            } else if (prior !== mapped.startingPoints) {
              const action = resolutionByRow.get(i) || 'skip';
              if (action === 'apply') {
                const delta = mapped.startingPoints - prior;
                await PointsLedgerEntry.create({ workspaceId, customerId: existingId, type: 'imported_balance', amount: delta, importJobId: job._id });
                await Customer.updateOne({ _id: existingId }, { $inc: { loyaltyPoints: delta }, $set: { loyaltyPointsUpdatedAt: new Date() } });
                importedBalanceTotals.set(String(existingId), mapped.startingPoints);
              }
              // 'skip' (or unresolved): points untouched, other fields still updated above.
            }
          }
        } else {
          const { firstname, lastname } = splitName(mapped.name);
          const doc = await Customer.create({
            workspaceId, firstname, lastname, phone: mapped._normalizedPhone,
            email: mapped.email, notes: mapped.notes,
            loyaltyPoints: mapped.startingPoints || 0,
            loyaltyPointsUpdatedAt: mapped.startingPoints ? new Date() : undefined,
          });
          if (mapped.startingPoints) {
            await PointsLedgerEntry.create({ workspaceId, customerId: doc._id, type: 'imported_balance', amount: mapped.startingPoints, importJobId: job._id });
            importedBalanceTotals.set(String(doc._id), mapped.startingPoints);
          }
          importedCount++;
          if (key) index.set(key, doc._id);
        }
      } else {
        // product / service — identical shape, just a different Model + field set.
        if (existingId) {
          skippedDuplicateCount++;
          const $set = {};
          if (mapped.basePrice !== undefined) $set.basePrice = mapped.basePrice;
          if (mapped.category !== undefined) $set.category = mapped.category;
          if (mapped.description !== undefined) $set.description = mapped.description;
          if (job.entityType === 'service' && mapped.duration !== undefined) $set.duration = mapped.duration;
          if (Object.keys($set).length) await config.Model.updateOne({ _id: existingId }, { $set });
        } else {
          const doc = await config.Model.create({
            workspaceId, name: mapped.name, basePrice: mapped.basePrice,
            category: job.entityType === 'product' ? (mapped.category || 'Uncategorized') : mapped.category,
            description: mapped.description,
            ...(job.entityType === 'service' && mapped.duration !== undefined ? { duration: mapped.duration } : {}),
          });
          importedCount++;
          if (key) index.set(key, doc._id);
        }
      }
    } catch (err) {
      failedCount++;
      rowErrors.push({ rowIndex: i, reason: err.message });
    }
  }

  job.importedCount = importedCount;
  job.skippedDuplicateCount = skippedDuplicateCount;
  job.failedCount = failedCount;
  job.rowErrors = rowErrors;
  job.status = 'completed';
  await job.save();

  return { id: job._id, status: job.status, importedCount, skippedDuplicateCount, failedCount, totalRows: job.totalRows };
}

// ─── Templates & error export ───────────────────────────────────────────────────
function toCsv(headerRow, dataRows) {
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headerRow, ...dataRows].map(r => r.map(esc).join(',')).join('\n');
}

const SAMPLE_VALUES = {
  customer: [['Sara Ahmed', '0501234567', 'sara@example.com', '500', 'VIP customer']],
  product:  [['Beard Balm', 'SAR 45.00', 'Grooming', 'Hydrating beard balm, 50ml']],
  service:  [['Classic Haircut', 'SAR 60.00', 'Hair', 'Includes wash and style', '45']],
};

function buildSampleCsv(entityType) {
  const config = getConfig(entityType);
  const header = config.fields.map(f => f.label);
  return toCsv(header, SAMPLE_VALUES[entityType] || []);
}

async function buildErrorReportCsv({ id, workspaceId }) {
  const job = await getImportJob({ id, workspaceId });
  const header = [...job.headers, 'Reason'];
  const rows = job.rowErrors.map(e => {
    const raw = job.rows[e.rowIndex] || {};
    return [...job.headers.map(h => raw[h]), e.reason];
  });
  return toCsv(header, rows);
}

module.exports = {
  ENTITY_CONFIGS, MAX_ROWS,
  autoDetectMapping, createImportJob, getImportJob,
  setMappingAndValidate, runImport,
  buildSampleCsv, buildErrorReportCsv,
};
