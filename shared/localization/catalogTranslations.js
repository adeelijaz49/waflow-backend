'use strict';
// Arabic names and descriptions for products and services (spec §3.6).
//
// WHY A SIDECAR. models/Product.js and models/Service.js are strict Mongoose schemas
// shared with the SPA, MCP, GPT and AI tools: an Arabic field added to a request would
// be silently dropped by every existing write path, and those files are not ours to
// change. The text lives in models/ProductTranslation.js instead (unique workspaceId +
// kind + refId + language). This module only ever READS Product/Service and only ever
// WRITES ProductTranslation — and never deletes anything (a blank CSV cell means "no
// change", not "remove").
//
// RULES
//  * The merchant's text is stored exactly as typed. Only control characters and
//    invisible/bidi format characters are stripped (they make names unmatchable and can
//    reorder what the reader sees); nothing else is normalised, so diacritics, alef
//    forms and Arabic-Indic digits all survive. A zero-width joiner is kept where it
//    glues an emoji sequence together.
//  * Any change of name or description saves as `draft` and clears the reviewer in the
//    SAME atomic update as the text, so a `reviewed` row can never hold text the
//    reviewer did not see. Saving identical text is a no-op (keeps `reviewed`).
//    `source:'ai'` is only a label for text the merchant confirmed in the UI; it is a
//    draft like everything else (spec §8). Nothing is ever auto-translated here.
//  * CSV import applies only what the file says, as drafts with source 'csv', matched
//    by kind+id or by exact English name. A name that matches several items is reported
//    as `ambiguous` and is NOT applied; the first row wins when a file names the same
//    item twice. The import never marks anything reviewed and ignores a `status` column.
//
// SEARCH. The list is built from one bounded pass over the workspace's items and
// translations, filtered in JavaScript. Arabic-aware matching (diacritics, alef forms,
// yeh / alef-maksura, teh-marbuta, Arabic-Indic digits) cannot be expressed as a Mongo
// regex without exploding the pattern, Cosmos DB has no collation support, and the join
// with translations plus the whole-catalogue counts need every row anyway. A catalogue
// is hundreds to low thousands of rows; the scan is capped at LIMITS.scanPerKind per
// kind (the overflow is logged, never silent) and no query value ever reaches a regex.
//
// MESSAGE RENDERING. resolveItemNames()/resolveItemName() are for NEW code (the campaign
// sender, customer pages):
//     resolveItemNames({ workspaceId, kind, ids, language, allowDraft? }) -> Map(id -> name)
//     resolveItemNames(workspaceId, kind, ids, language, { allowDraft }?)   (CONTRACT §2 spelling)
// The existing English message builders (utils/whatsapp.js, shared/operations.js,
// server.js) are deliberately NOT changed — see the integration backlog in the slice
// report. Customer-facing Arabic only uses REVIEWED translations unless the caller
// explicitly allows drafts.
const { isObjectIdLike, assertObjectId, withWorkspace } = require('./scope');
const { normalizeForMatch, stripInvisibles, toWesternDigits } = require('./arabicText');
const { decodeCsvBuffer, parseRows, stringifyCsv } = require('./csv');

const KINDS = Object.freeze(['product', 'service']);
const LIMITS = Object.freeze({
  nameMax: 200,
  descriptionMax: 2000,
  searchMax: 200,
  pageDefault: 50,
  pageMax: 200,
  scanPerKind: 10000,
  importRows: 5000, // same ceiling as the existing product/service CSV import
  importConcurrency: 8,
  reportRows: 200,
  displayNameMax: 120,
  resolveIds: 1000,
});

const ITEM_FIELDS = 'name description category active';
const TRANSLATION_FIELDS = 'kind refId name description status source reviewedBy reviewedAt createdAt updatedAt';
const EXPORT_HEADER = ['kind', 'id', 'name', 'category', 'name_ar', 'description_ar', 'status'];

// ── Errors ─────────────────────────────────────────────────────────────────
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
const invalid = (message) => httpError(400, 'INVALID_INPUT', message);

// workspaceId always comes from the verified token; a request without one is refused.
function scopeOf(workspaceId) {
  if (!isObjectIdLike(workspaceId)) throw httpError(403, 'FORBIDDEN', 'No workspace for this request');
  return String(workspaceId);
}

function validId(value, label) {
  try {
    return assertObjectId(value, label);
  } catch (err) {
    err.code = 'INVALID_ID';
    throw err;
  }
}

function optionalChoice(value, allowed, label, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) throw invalid(`${label} must be one of: ${allowed.join(', ')}`);
  return value;
}

function requiredChoice(value, allowed, label) {
  const chosen = optionalChoice(value, allowed, label, undefined);
  if (chosen === undefined) throw invalid(`${label} is required (one of: ${allowed.join(', ')})`);
  return chosen;
}

function intParam(value, label, { fallback, min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid(`${label} must be a number`);
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// ── Text hygiene ───────────────────────────────────────────────────────────
// A zero-width joiner between two pictographs holds an emoji sequence together (a
// "woman cook" is woman + joiner + cooking); stripping it would split the emoji into
// separate ones. Everywhere else it is invisible and removed.
const ZWJ = '\u{200D}';
const EMOJI_JOIN_RE = /(?<=\p{Extended_Pictographic}\u{FE0F}?)\u{200D}(?=\p{Extended_Pictographic})/gu;
const LINE_BREAK_RE = /\r\n|[\r\n\u{000B}\u{000C}\u{0085}\u{2028}\u{2029}]/gu;
const NAME_BREAK_RUN_RE = /(?:\r\n|[\r\n\t\u{000B}\u{000C}\u{0085}\u{2028}\u{2029}])+/gu;
const CONTROL_RE = /[\u{0000}-\u{0008}\u{000E}-\u{001F}\u{007F}-\u{009F}]/gu;

function stripHidden(text) {
  return text.split(EMOJI_JOIN_RE).map(stripInvisibles).join(ZWJ);
}

// One line: breaks and tabs become a single space, control/invisible characters go.
function cleanName(value) {
  return stripHidden(String(value)).replace(NAME_BREAK_RUN_RE, ' ').replace(CONTROL_RE, '').trim();
}

// Multi-line: line breaks are normalised to \n (paragraphs survive), tabs become spaces.
function cleanDescription(value) {
  return stripHidden(String(value)).replace(LINE_BREAK_RE, '\n').replace(/\t/g, ' ').replace(CONTROL_RE, '').trim();
}

const codePoints = (text) => Array.from(text).length;

function readName(value) {
  const required = () => httpError(400, 'TRANSLATION_NAME_REQUIRED', 'The Arabic name is required');
  if (value === undefined || value === null) throw required();
  if (typeof value !== 'string') throw invalid('name must be a string');
  const name = cleanName(value);
  if (!name) throw required();
  if (codePoints(name) > LIMITS.nameMax) throw invalid(`name is too long (max ${LIMITS.nameMax})`);
  return name;
}

// undefined = "not supplied": the stored description is kept (an explicit "" clears it).
function readDescription(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid('description must be a string');
  const description = cleanDescription(value);
  if (codePoints(description) > LIMITS.descriptionMax) throw invalid(`description is too long (max ${LIMITS.descriptionMax})`);
  return description;
}

function readSource(value) {
  if (value === undefined || value === null) return 'merchant';
  if (value !== 'merchant' && value !== 'ai') throw invalid('source must be one of: merchant, ai');
  return value;
}

// ── Views ──────────────────────────────────────────────────────────────────
function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toTranslationView(doc) {
  return {
    name: doc.name || '',
    description: doc.description || '',
    status: doc.status === 'reviewed' ? 'reviewed' : 'draft',
    source: doc.source === 'csv' || doc.source === 'ai' ? doc.source : 'merchant',
    reviewedBy: doc.reviewedBy || null,
    reviewedAt: toIso(doc.reviewedAt),
    updatedAt: toIso(doc.updatedAt) || toIso(doc.createdAt) || '',
  };
}

function toItemView(row) {
  return {
    kind: row.kind,
    refId: row.refId,
    name: row.name,
    description: row.description,
    category: row.category,
    active: row.active,
    translation: row.translation ? toTranslationView(row.translation) : null,
  };
}

// ── Catalogue loading (read-only) ──────────────────────────────────────────
function modelFor(deps, kind) {
  return kind === 'service' ? deps.Service : deps.Product;
}

async function scan(Model, filter, fields, cap, label) {
  const docs = await Model.find(filter).select(fields).limit(cap + 1).lean();
  if (docs.length <= cap) return docs;
  console.error(`[localization] catalogue ${label} exceed ${cap} rows - only the first ${cap} are covered`);
  return docs.slice(0, cap);
}

const kindOrder = (kind) => KINDS.indexOf(kind);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function compareRows(a, b) {
  return kindOrder(a.kind) - kindOrder(b.kind)
    || collator.compare(a.name, b.name)
    || (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0);
}

function makeRow(kind, doc, translation) {
  const usable = !!translation && typeof translation.name === 'string' && translation.name.trim() !== '';
  return {
    kind,
    refId: String(doc._id),
    name: doc.name || '',
    description: doc.description || '',
    category: doc.category || '',
    active: doc.active !== false,
    translation: usable ? translation : null,
    status: usable ? (translation.status === 'reviewed' ? 'reviewed' : 'draft') : 'missing',
  };
}

// Every product and service of the workspace (active or not) joined with its Arabic
// translation. `translations` keeps the raw rows (including unusable blank-name ones)
// keyed `${kind}:${refId}` for the import's comparisons.
async function loadCatalogue(deps, workspaceId) {
  const [products, services, stored] = await Promise.all([
    scan(deps.Product, { workspaceId }, ITEM_FIELDS, LIMITS.scanPerKind, 'products'),
    scan(deps.Service, { workspaceId }, ITEM_FIELDS, LIMITS.scanPerKind, 'services'),
    scan(deps.ProductTranslation, { workspaceId, language: 'ar' }, TRANSLATION_FIELDS, 2 * LIMITS.scanPerKind, 'translations'),
  ]);
  const translations = new Map(stored.map((t) => [`${t.kind}:${String(t.refId)}`, t]));
  const rows = [];
  for (const [kind, docs] of [['product', products], ['service', services]]) {
    for (const doc of docs) rows.push(makeRow(kind, doc, translations.get(`${kind}:${String(doc._id)}`)));
  }
  rows.sort(compareRows);
  return { rows, translations };
}

function countStatuses(rows) {
  const counts = { missing: 0, draft: 0, reviewed: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

// ── List ───────────────────────────────────────────────────────────────────
function searchTokens(value) {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') throw invalid('search must be a string');
  if (value.length > LIMITS.searchMax) throw invalid(`search is too long (max ${LIMITS.searchMax})`);
  const normalised = normalizeForMatch(value);
  return normalised ? normalised.split(' ') : [];
}

// English name + Arabic name + category, normalised the same way as the query; every
// token of the query must appear somewhere in it.
function matchesTokens(row, tokens) {
  if (row.haystack === undefined) {
    row.haystack = normalizeForMatch(`${row.name} ${row.translation ? row.translation.name : ''} ${row.category}`);
  }
  return tokens.every((token) => row.haystack.includes(token));
}

async function listItems(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const kind = optionalChoice(args.kind, ['all', ...KINDS], 'kind', 'all');
  const status = optionalChoice(args.status, ['all', 'missing', 'draft', 'reviewed'], 'status', 'all');
  const tokens = searchTokens(args.search);
  const limit = intParam(args.limit, 'limit', { fallback: LIMITS.pageDefault, min: 1, max: LIMITS.pageMax });
  const page = intParam(args.page, 'page', { fallback: 1, min: 1, max: 1000000 });

  const { rows } = await loadCatalogue(deps, workspaceId);
  let matched = rows;
  if (kind !== 'all') matched = matched.filter((row) => row.kind === kind);
  if (status !== 'all') matched = matched.filter((row) => row.status === status);
  if (tokens.length) matched = matched.filter((row) => matchesTokens(row, tokens));

  const start = (page - 1) * limit;
  return {
    items: matched.slice(start, start + limit).map(toItemView),
    total: matched.length,
    page,
    limit,
    counts: countStatuses(rows), // the whole catalogue: filters never change them
  };
}

// ── Save / review ──────────────────────────────────────────────────────────
async function itemExists(deps, workspaceId, kind, refId) {
  return !!(await modelFor(deps, kind).findOne({ _id: refId, workspaceId }).select('_id').lean());
}

function draftUpdate({ name, description, source, userId }) {
  const set = { name, description, status: 'draft', source };
  if (isObjectIdLike(userId)) set.updatedBy = String(userId);
  return { $set: set, $unset: { reviewedBy: '', reviewedAt: '' } };
}

// One attempt = read, decide, (maybe) write. The write replaces the text, sets draft
// and clears the reviewer in a single update, so concurrent saves/reviews can only end
// in a state that is safe (a draft, or a reviewed row whose text was reviewed). A lost
// insert race (unique index) re-runs the whole decision once.
async function upsertDraft(deps, { workspaceId, kind, refId, name, description, source, userId }) {
  const key = { workspaceId, kind, refId, language: 'ar' };
  for (let attempt = 1; ; attempt += 1) {
    const existing = await deps.ProductTranslation.findOne(key).lean();
    const nextDescription = description === undefined ? (existing && existing.description) || '' : description;
    if (existing && existing.name === name && (existing.description || '') === nextDescription) {
      return { translation: toTranslationView(existing), changed: false };
    }
    try {
      const saved = await deps.ProductTranslation.findOneAndUpdate(
        key,
        draftUpdate({ name, description: nextDescription, source, userId }),
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true, runValidators: true },
      ).lean();
      return { translation: toTranslationView(saved), changed: true };
    } catch (err) {
      if (!err || err.code !== 11000 || attempt >= 2) throw err;
    }
  }
}

async function saveTranslation(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const kind = requiredChoice(args.kind, KINDS, 'kind');
  const refId = validId(args.refId, 'refId');
  const name = readName(args.name);
  const description = readDescription(args.description);
  const source = readSource(args.source);
  if (!(await itemExists(deps, workspaceId, kind, refId))) throw httpError(404, 'ITEM_NOT_FOUND', 'Product or service not found');
  const { translation } = await upsertDraft(deps, { workspaceId, kind, refId, name, description, source, userId: args.userId });
  return translation;
}

// One item's current Arabic text for the Product / Service form (IM-D / B3-forms).
// -> { translation: view | null }; null while no usable Arabic name exists. 404 when the
// item is not in the caller's workspace (the ownership check is the workspace-scoped item read).
async function getTranslation(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const kind = requiredChoice(args.kind, KINDS, 'kind');
  const refId = validId(args.refId, 'refId');
  if (!(await itemExists(deps, workspaceId, kind, refId))) throw httpError(404, 'ITEM_NOT_FOUND', 'Product or service not found');
  const row = await deps.ProductTranslation.findOne({ workspaceId, kind, refId, language: 'ar' }).select(TRANSLATION_FIELDS).lean();
  const usable = !!row && typeof row.name === 'string' && row.name.trim() !== '';
  return { translation: usable ? toTranslationView(row) : null };
}

// The main import wizard's Arabic name / description columns (IM-D / B3-forms). items:
// [{ kind, refId, name, description? }], first entry per item wins (callers already
// collapse them). Same rules as the hub CSV import: ownership is re-checked per item,
// text is cleaned exactly like a typed save, identical text is a no-op (a reviewed row
// stays reviewed), changed text is saved as a DRAFT with source 'csv' and the reviewer is
// cleared. A blank description keeps the stored one; nothing is ever deleted. Failures are
// counted per item and never thrown. -> { saved, unchanged, failed }
async function saveImportedDrafts(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const result = { saved: 0, unchanged: 0, failed: 0 };
  const seen = new Set();
  const work = [];
  for (const item of Array.isArray(args.items) ? args.items : []) {
    const key = item ? `${item.kind}:${String(item.refId)}` : '';
    if (!item || seen.has(key)) continue;
    seen.add(key);
    work.push(item);
  }
  await mapLimit(work, LIMITS.importConcurrency, async (item) => {
    try {
      const kind = requiredChoice(item.kind, KINDS, 'kind');
      const refId = validId(String(item.refId), 'refId');
      const name = readName(item.name);
      const description = readDescription(item.description === '' ? undefined : item.description);
      if (!(await itemExists(deps, workspaceId, kind, refId))) { result.failed += 1; return; }
      const { changed } = await upsertDraft(deps, { workspaceId, kind, refId, name, description, source: 'csv', userId: args.userId });
      if (changed) result.saved += 1; else result.unchanged += 1;
    } catch (err) {
      result.failed += 1;
    }
  });
  return result;
}

async function reviewerLabel(deps, userId) {
  if (!isObjectIdLike(userId)) return 'Unknown user';
  const user = await deps.User.findById(userId).select('name email phone').lean();
  const label = user && (user.name || user.email || user.phone);
  return String(label || userId).trim().slice(0, 120);
}

// Marks the translation reviewed (by the signed-in user) or back to draft. Asking for
// the state it is already in changes nothing, so the first reviewer stays on record.
async function reviewTranslation(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const kind = requiredChoice(args.kind, KINDS, 'kind');
  const refId = validId(args.refId, 'refId');
  const status = requiredChoice(args.status, ['reviewed', 'draft'], 'status');
  const key = { workspaceId, kind, refId, language: 'ar' };
  const update = status === 'reviewed'
    ? { $set: { status, reviewedBy: await reviewerLabel(deps, args.userId), reviewedAt: deps.now() } }
    : { $set: { status }, $unset: { reviewedBy: '', reviewedAt: '' } };

  const updated = await deps.ProductTranslation.findOneAndUpdate({ ...key, status: { $ne: status } }, update, { returnDocument: 'after' }).lean();
  if (updated) return toTranslationView(updated);
  const current = await deps.ProductTranslation.findOne(key).lean();
  if (current) return toTranslationView(current);
  if (!(await itemExists(deps, workspaceId, kind, refId))) throw httpError(404, 'ITEM_NOT_FOUND', 'Product or service not found');
  throw httpError(404, 'NOT_FOUND', 'This item has no Arabic translation yet');
}

// ── CSV export ─────────────────────────────────────────────────────────────
// Product names and categories are free text that anyone on the team (or an import) can
// set, so every cell is guarded against spreadsheet formula injection: a cell that starts
// with = + - @ tab or CR gets a leading apostrophe unless it is a plain number. This is
// stricter than the shared writer's own check, which leaves anything that starts with a
// signed digit alone (and "-2+3+cmd|..." does). restoreCell() undoes it on import.
const PLAIN_NUMBER_RE = /^[+-]?\d+(?:\.\d+)?$/;

function guardCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) && !PLAIN_NUMBER_RE.test(text) ? `'${text}` : text;
}

const restoreCell = (value) => (/^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value);

async function exportCsv(deps, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  const { rows } = await loadCatalogue(deps, workspaceId);
  return stringifyCsv([
    EXPORT_HEADER,
    ...rows.map((row) => [
      row.kind, row.refId, row.name, row.category,
      row.translation ? row.translation.name : '',
      row.translation ? row.translation.description || '' : '',
      row.status,
    ].map(guardCell)),
  ]);
}

// ── CSV import ─────────────────────────────────────────────────────────────
// Header aliases (matched after Arabic-aware normalisation, so spacing, case,
// underscores, diacritics and alef/teh-marbuta spellings do not matter).
const COLUMN_ALIASES = {
  kind: ['kind', 'type', 'item type', 'النوع'],
  id: ['id', 'ref id', 'item id', 'product id', 'service id', 'المعرف'],
  name: ['name', 'name en', 'name english', 'english name', 'product name', 'service name', 'item name', 'الاسم بالانجليزية', 'الاسم الانجليزي'],
  name_ar: ['name ar', 'arabic name', 'name arabic', 'name in arabic', 'الاسم بالعربية', 'الاسم العربي', 'اسم عربي'],
  description_ar: ['description ar', 'arabic description', 'description arabic', 'description in arabic', 'الوصف بالعربية', 'الوصف العربي'],
};
const COLUMN_LOOKUP = new Map();
for (const [column, aliases] of Object.entries(COLUMN_ALIASES)) {
  for (const alias of aliases) COLUMN_LOOKUP.set(normalizeForMatch(alias), column);
}

const KIND_WORDS = {
  product: new Set(['product', 'products', 'item', 'منتج', 'منتجات'].map(normalizeForMatch)),
  service: new Set(['service', 'services', 'خدمة', 'خدمات'].map(normalizeForMatch)),
};

function mapColumns(headerCells) {
  const columns = {};
  headerCells.forEach((cell, index) => {
    const column = COLUMN_LOOKUP.get(normalizeForMatch(restoreCell(cell)));
    if (column && columns[column] === undefined) columns[column] = index; // first one wins
  });
  return columns;
}

function csvError(err) {
  const tooBig = /too large|too many rows/i.test(err && err.message);
  return httpError(tooBig ? 413 : 400, tooBig ? 'FILE_TOO_LARGE' : 'FILE_INVALID', (err && err.message) || 'The file could not be read');
}

const isBlankRow = (cells) => cells.every((cell) => String(cell).trim() === '');

// Bytes -> { encoding, columns, records: [{ line, cells }] }. `line` counts records
// like the shared CSV reader does (the header is line 1).
function readImportFile(buffer) {
  const { text, encoding } = decodeCsvBuffer(buffer);
  let grid;
  try {
    grid = parseRows(text);
  } catch (err) {
    throw csvError(err);
  }
  if (!grid.length) throw httpError(400, 'FILE_INVALID', 'The file has no rows');
  const columns = mapColumns(grid[0]);
  if (columns.name_ar === undefined) throw httpError(400, 'FILE_INVALID', 'The file needs a name_ar column');
  if (columns.id === undefined && columns.name === undefined) throw httpError(400, 'FILE_INVALID', 'The file needs an id or a name column');
  const records = [];
  grid.slice(1).forEach((cells, index) => {
    if (!isBlankRow(cells)) records.push({ line: index + 2, cells });
  });
  if (records.length > LIMITS.importRows) throw httpError(413, 'FILE_TOO_LARGE', `The file has too many rows (max ${LIMITS.importRows})`);
  return { encoding, columns, records };
}

// Exact English-name key: case-insensitive, trimmed, whitespace runs collapsed.
function exactKey(value) {
  return stripHidden(String(value)).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function indexCatalogue({ rows, translations }) {
  const byId = new Map();
  const byName = new Map();
  const add = (key, row) => {
    const bucket = byName.get(key);
    if (bucket) bucket.push(row); else byName.set(key, [row]);
  };
  for (const row of rows) {
    byId.set(`${row.kind}:${row.refId}`, row);
    const key = exactKey(row.name);
    if (key) { add(`${row.kind}:${key}`, row); add(`*:${key}`, row); }
  }
  return { byId, byName, translations };
}

function parseKindCell(raw) {
  const word = normalizeForMatch(raw);
  if (!word) return { kind: null };
  if (KIND_WORDS.product.has(word)) return { kind: 'product' };
  if (KIND_WORDS.service.has(word)) return { kind: 'service' };
  return { bad: true };
}

const HEX_ID_RE = /^[a-f0-9]{24}$/;
const shorten = (text) => Array.from(text).slice(0, LIMITS.displayNameMax).join('');

// One CSV record -> { line, name, outcome, write? }. Pure: no database access. Outcomes:
//  unchanged  nothing to apply (blank Arabic cells) or the stored text is already identical
//  updated    would save/save a draft          unmatched  no item          ambiguous  several items
//  invalid    unusable row                     duplicate  item already handled by an earlier row
function planRecord({ line, cells }, columns, index, seen) {
  const cell = (column) => (columns[column] === undefined || cells[columns[column]] === undefined ? '' : restoreCell(cells[columns[column]]));
  const nameAr = cleanName(cell('name_ar'));
  const descriptionAr = cleanDescription(cell('description_ar'));
  const shownName = cleanName(cell('name'));
  const result = (outcome, target, write) => ({
    line, outcome, write, name: shorten(shownName || (target && target.name) || cleanName(cell('id'))),
  });

  if (!nameAr && !descriptionAr) return result('unchanged');
  if (!nameAr) return result('invalid'); // a description needs its name
  if (codePoints(nameAr) > LIMITS.nameMax || codePoints(descriptionAr) > LIMITS.descriptionMax) return result('invalid');
  const kindCell = parseKindCell(cell('kind'));
  if (kindCell.bad) return result('invalid');

  const idText = toWesternDigits(cell('id')).trim().toLowerCase();
  let target;
  if (HEX_ID_RE.test(idText)) {
    target = (kindCell.kind ? [kindCell.kind] : KINDS).map((kind) => index.byId.get(`${kind}:${idText}`)).find(Boolean);
    if (!target) return result('unmatched');
  } else {
    // No usable id (blank, or mangled by a spreadsheet): fall back to the exact name.
    const key = exactKey(cell('name'));
    if (!key) return result('invalid');
    const matches = index.byName.get(`${kindCell.kind || '*'}:${key}`) || [];
    if (!matches.length) return result('unmatched');
    if (matches.length > 1) return result('ambiguous');
    target = matches[0];
  }

  const targetKey = `${target.kind}:${target.refId}`;
  if (seen.has(targetKey)) return result('duplicate', target);
  seen.add(targetKey);

  // A blank description cell keeps the stored description (a CSV cannot clear one).
  const existing = index.translations.get(targetKey);
  const effectiveDescription = descriptionAr || (existing && existing.description) || '';
  if (existing && existing.name === nameAr && (existing.description || '') === effectiveDescription) return result('unchanged', target);
  return result('updated', target, { kind: target.kind, refId: target.refId, name: nameAr, description: descriptionAr || undefined });
}

function planImport(file, catalogue) {
  const index = indexCatalogue(catalogue);
  const seen = new Set();
  return file.records.map((record) => planRecord(record, file.columns, index, seen));
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next];
      next += 1;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// The plan came from a snapshot, so every write re-reads the row it replaces and the
// final outcome (updated vs unchanged) is taken from that write.
async function applyPlan(deps, { workspaceId, userId }, planned) {
  await mapLimit(planned.filter((row) => row.outcome === 'updated'), LIMITS.importConcurrency, async (row) => {
    const { changed } = await upsertDraft(deps, { workspaceId, ...row.write, source: 'csv', userId });
    if (!changed) row.outcome = 'unchanged';
  });
}

function summarize(planned) {
  const summary = { rows: planned.length, updated: 0, unchanged: 0, unmatched: 0, invalid: 0 };
  for (const { outcome } of planned) {
    if (outcome === 'updated') summary.updated += 1;
    else if (outcome === 'unchanged') summary.unchanged += 1;
    else if (outcome === 'unmatched' || outcome === 'ambiguous') summary.unmatched += 1; // not matched to exactly one item
    else summary.invalid += 1; // invalid + duplicate
  }
  return summary;
}

// Rows that need the merchant's attention come first when the report is cut at
// LIMITS.reportRows; the rows kept are shown in file order.
const REPORT_PRIORITY = { invalid: 0, duplicate: 0, ambiguous: 0, unmatched: 0, updated: 1, unchanged: 2 };

function reportRows(planned) {
  const strip = ({ line, name, outcome }) => ({ line, name, outcome });
  if (planned.length <= LIMITS.reportRows) return { rows: planned.map(strip), truncated: false };
  const kept = planned
    .map((row, position) => ({ row, position }))
    .sort((a, b) => REPORT_PRIORITY[a.row.outcome] - REPORT_PRIORITY[b.row.outcome] || a.position - b.position)
    .slice(0, LIMITS.reportRows)
    .map(({ row }) => row)
    .sort((a, b) => a.line - b.line);
  return { rows: kept.map(strip), truncated: true };
}

// Only one applying import per workspace at a time (a double click would otherwise
// run the same file twice); previews are read-only and never blocked.
function claimImport(state, workspaceId) {
  if (state.importing.has(workspaceId)) throw httpError(429, 'RATE_LIMITED', 'An import is already running for this workspace');
  state.importing.add(workspaceId);
  return () => state.importing.delete(workspaceId);
}

// dryRun is a preview unless it is explicitly `false`.
async function importCsv(deps, state, args = {}) {
  const workspaceId = scopeOf(args.workspaceId);
  if (!Buffer.isBuffer(args.buffer)) throw httpError(400, 'FILE_REQUIRED', 'Choose a CSV file to upload');
  const dryRun = args.dryRun !== false;
  const file = readImportFile(args.buffer);
  const release = dryRun ? null : claimImport(state, workspaceId);
  try {
    const planned = planImport(file, await loadCatalogue(deps, workspaceId));
    if (!dryRun) await applyPlan(deps, { workspaceId, userId: args.userId }, planned);
    return { dryRun, encoding: file.encoding, summary: summarize(planned), ...reportRows(planned) };
  } finally {
    if (release) release();
  }
}

// ── Helper for message rendering (new code only) ───────────────────────────
// ids -> Map(lowercase 24-hex id -> display name). Arabic name when language is 'ar'
// and the item has a translation with a non-empty name that is REVIEWED (drafts only
// when allowDraft is true — customer-facing text must have been reviewed); otherwise
// the English name. Ids that are malformed, belong to another workspace or do not
// exist are simply absent from the map so the caller can fall back to its own data.
function uniqueValidIds(ids) {
  if (!Array.isArray(ids)) throw invalid('ids must be an array');
  if (ids.length > LIMITS.resolveIds) throw invalid(`ids may contain at most ${LIMITS.resolveIds} entries`);
  const wanted = new Set();
  for (const id of ids) {
    if (isObjectIdLike(id)) wanted.add(String(id).toLowerCase());
  }
  return Array.from(wanted);
}

async function resolveItemNames(deps, { workspaceId, kind, ids, language, allowDraft = false } = {}) {
  withWorkspace({}, workspaceId);
  const chosenKind = requiredChoice(kind, KINDS, 'kind');
  const wanted = uniqueValidIds(ids);
  const names = new Map();
  if (!wanted.length) return names;

  const items = await modelFor(deps, chosenKind).find({ workspaceId, _id: { $in: wanted } }).select('name').lean();
  const arabic = new Map();
  if (String(language).toLowerCase() === 'ar' && items.length) {
    const filter = { workspaceId, kind: chosenKind, language: 'ar', refId: { $in: items.map((item) => String(item._id)) } };
    if (!allowDraft) filter.status = 'reviewed';
    for (const row of await deps.ProductTranslation.find(filter).select('refId name').lean()) {
      if (typeof row.name === 'string' && row.name.trim()) arabic.set(String(row.refId), row.name);
    }
  }
  for (const item of items) names.set(String(item._id), arabic.get(String(item._id)) || item.name || '');
  return names;
}

async function resolveItemName(deps, args = {}) {
  const names = await resolveItemNames(deps, { ...args, ids: [args.id] });
  return names.has(String(args.id).toLowerCase()) ? names.get(String(args.id).toLowerCase()) : null;
}

// ── Wiring ─────────────────────────────────────────────────────────────────
function realDeps() {
  return {
    Product: require('../../models/Product'),
    Service: require('../../models/Service'),
    ProductTranslation: require('../../models/ProductTranslation'),
    User: require('../../models/User'),
    now: () => new Date(),
  };
}

// CONTRACT §2 writes the rendering helpers positionally — (workspaceId, kind, ids|id,
// language) — and the slice brief with one options object; both spellings are accepted
// (a fifth { allowDraft } argument goes with the positional one).
function renderingArgs(args, idsKey) {
  const [first, kind, idsOrId, language, options] = args;
  if (first !== null && typeof first === 'object' && !isObjectIdLike(first)) return first;
  return { workspaceId: first, kind, [idsKey]: idsOrId, language, allowDraft: !!(options && options.allowDraft) };
}

// Every collaborator is injectable so tests need no database (same idea as inboundHook.js).
function createCatalogService(deps = realDeps()) {
  const state = { importing: new Set() };
  return {
    listItems: (args) => listItems(deps, args),
    saveTranslation: (args) => saveTranslation(deps, args),
    getTranslation: (args) => getTranslation(deps, args),
    saveImportedDrafts: (args) => saveImportedDrafts(deps, args),
    reviewTranslation: (args) => reviewTranslation(deps, args),
    exportCsv: (args) => exportCsv(deps, args),
    importCsv: (args) => importCsv(deps, state, args),
    resolveItemNames: (...args) => resolveItemNames(deps, renderingArgs(args, 'ids')),
    resolveItemName: (...args) => resolveItemName(deps, renderingArgs(args, 'id')),
  };
}

// The default instance is built on first use so requiring this module loads no model.
let shared = null;
const real = () => { if (!shared) shared = createCatalogService(); return shared; };

module.exports = {
  LIMITS,
  cleanName,
  cleanDescription,
  createCatalogService,
  listItems: (args) => real().listItems(args),
  saveTranslation: (args) => real().saveTranslation(args),
  getTranslation: (args) => real().getTranslation(args),
  saveImportedDrafts: (args) => real().saveImportedDrafts(args),
  reviewTranslation: (args) => real().reviewTranslation(args),
  exportCsv: (args) => real().exportCsv(args),
  importCsv: (args) => real().importCsv(args),
  resolveItemNames: (...args) => real().resolveItemNames(...args),
  resolveItemName: (...args) => real().resolveItemName(...args),
};
