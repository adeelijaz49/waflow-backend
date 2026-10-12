'use strict';
// Customers' languages (spec §3.1): list/search, set, bulk set, CSV import/export
// and counts. The language lives ONLY in the sidecar collection CustomerLanguage
// (unique workspaceId+customerId); models/Customer.js is read-only here, so the
// existing customer code paths stay untouched.
//
// Rules this service applies everywhere
//  * Scope: every filter carries the caller's workspaceId (taken from the token by
//    the route). The "customer set" this feature manages is the SAME one the list
//    shows: not erased (deletedAt) and not demo (isDemo). Writes never touch other
//    customers — an erased customer must not receive a language (audit R3 §6).
//  * language per row = the sidecar value or 'unknown' (no document). effective =
//    customer -> merchant default -> 'en' (languageDetect.resolveLanguage).
//  * Merchant edits (single + bulk) override any source — an explicit merchant act.
//    Setting 'unknown' stores language 'unknown' with languageSource null (NOT
//    merchant_set) so the first-message inference in inboundHook.js can still fill it.
//  * CSV import never creates customers, never overrides a language the customer
//    chose themselves (outcome 'protected', enforced atomically in the write
//    filter), and a blank/'unknown' cell means "no information" — it never resets
//    anything. Nothing in this file deletes data; archive/reset are field updates.
//
// Listing without unbounded query arrays (there is no language on Customer, so
// "language = ar" is a join between two collections):
//  * language 'all' (default view): ONE page query on Customer (sort/skip/limit)
//    + one sidecar lookup limited to that page's ids (<= 200).
//  * en | ar | unknown: the sidecar side is queried by (workspaceId, language)
//    (indexed). When the class has <= CLAUSE_MAX customers the id list becomes an
//    $in (en/ar) or $nin (unknown) clause on the same page query, so Mongo still
//    sorts/skips/limits and counts. Bigger classes (a 10k-row CSV import) take a
//    bounded fallback that streams only { _id, firstname, lastname } of the
//    matching customers, intersects in memory and sorts by code point (= MongoDB's
//    binary order), so no query ever carries a huge id array. Only plain find /
//    countDocuments / bulkWrite are used (works on MongoDB and Cosmos DB for MongoDB).
//  * counts (en/ar/unknown/total, base set, search ignored): total = count of the
//    base set; en/ar = sidecar counts minus the sidecar rows of erased/demo
//    customers (a small, separately fetched id list); unknown = the rest.
//    Orphan sidecar rows (their customer hard-deleted) are not expected — the app
//    never deletes customers — and would only inflate en/ar slightly.
const { normalizeArabic, normalizeForMatch, toWesternDigits } = require('./arabicText');
const { CUSTOMER_LANGUAGES, parseLanguageValue, resolveLanguage } = require('./languageDetect');
const { decodeCsvBuffer, detectDelimiter, parseRows, stringifyCsv } = require('./csv');
const { buildSearchFilter } = require('./arabicSearch');
const { assertObjectId, assertObjectIdArray, assertString, isObjectIdLike, withWorkspace } = require('./scope');
const { normalizePhoneForDedup } = require('../../utils/phoneNormalize');

const LANGUAGE_FILTERS = ['all', ...CUSTOMER_LANGUAGES];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_PAGE = 100000;
const MAX_BULK = 1000;
const CLAUSE_MAX = 5000;
const CHUNK = 1000; // ids per $in query
const BULK_CHUNK = 500; // operations per bulkWrite call
const IMPORT_PREVIEW_ROWS = 200;
const EXPORT_MAX_ROWS = 100000;
const DEFAULT_COUNTRY_CODE = '966';
const CLEAR_SOURCE = null;

const ROW_FIELDS = '_id firstname lastname phone marketingConsent optedOut';
const NAME_SORT = { firstname: 1, lastname: 1, _id: 1 };

const PHONE_HEADERS = new Set([
  'phone', 'phone number', 'mobile', 'mobile number', 'mobile phone', 'cell', 'cellphone', 'whatsapp', 'whatsapp number',
  'tel', 'telephone', 'number', 'contact', 'contact number', 'customer phone', 'customer mobile',
  'جوال', 'الجوال', 'رقم الجوال', 'رقم الهاتف', 'الهاتف', 'هاتف', 'واتساب', 'رقم الواتساب', 'رقم واتساب', 'رقم الموبايل', 'موبايل', 'رقم',
].map(normalizeForMatch));
const LANGUAGE_HEADERS = new Set([
  'language', 'lang', 'preferred language', 'customer language', 'language code',
  'اللغة', 'لغة', 'اللغة المفضلة', 'لغة العميل',
].map(normalizeForMatch));

// ── small helpers ──────────────────────────────────────────────────────────

function realDeps() {
  return {
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    Settings: require('../../models/Settings'),
    localeSettings: require('./settings'),
  };
}

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// Foundation validators throw { status: 400 } without a code; the API contract
// wants one on every error body.
function withCode(code, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.status === 400 && !err.code) err.code = code;
    throw err;
  }
}

function requireWorkspace(workspaceId) {
  if (!workspaceId) throw httpError(403, 'No workspace in this session', 'FORBIDDEN');
  return workspaceId;
}

function parseId(value, label = 'id') {
  return withCode('INVALID_ID', () => assertObjectId(value, label));
}

function parseIdList(value, label = 'customerIds') {
  if (!Array.isArray(value)) throw httpError(400, `${label} must be an array`, 'INVALID_INPUT');
  if (!value.length) throw httpError(400, `${label} must contain at least one id`, 'INVALID_INPUT');
  if (value.length > MAX_BULK) throw httpError(400, `${label} may contain at most ${MAX_BULK} ids`, 'INVALID_INPUT');
  return Array.from(new Set(withCode('INVALID_ID', () => assertObjectIdArray(value, label, { max: MAX_BULK }))));
}

function parseLanguage(value) {
  if (!CUSTOMER_LANGUAGES.includes(value)) throw httpError(400, `language must be one of: ${CUSTOMER_LANGUAGES.join(', ')}`, 'INVALID_LANGUAGE');
  return value;
}

function parseLanguageFilter(value) {
  if (value === undefined || value === null || value === '') return 'all';
  if (!LANGUAGE_FILTERS.includes(value)) throw httpError(400, `language must be one of: ${LANGUAGE_FILTERS.join(', ')}`, 'INVALID_LANGUAGE');
  return value;
}

// A search box value: a string (objects such as {"$ne":""} are rejected). The
// builder truncates to 100 characters; this only turns away absurd payloads.
function parseSearch(value) {
  return withCode('INVALID_INPUT', () => assertString(value, 'search', { max: 500 }));
}

// Safe by default: only an explicit false-like value applies the import.
function parseDryRun(value) {
  return !['false', '0', 'no', 'off'].includes(String(value === undefined || value === null ? '' : value).trim().toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// The customers this feature manages: the real, non-erased ones.
function baseFilter(workspaceId) {
  return withWorkspace({ deletedAt: { $exists: false }, isDemo: { $ne: true } }, workspaceId);
}

// MongoDB orders strings by their UTF-8 bytes, i.e. by code point. JS compares
// UTF-16 code units, which differs for astral characters (emoji) vs U+E000..FFFF;
// shifting the surrogate range above the BMP restores code point order.
function compareStrings(a, b) {
  const x = typeof a === 'string' ? a : '';
  const y = typeof b === 'string' ? b : '';
  const fix = (c) => (c >= 0xE000 ? c - 0x800 : c >= 0xD800 ? c + 0x2000 : c);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const cx = x.charCodeAt(i);
    const cy = y.charCodeAt(i);
    if (cx !== cy) return fix(cx) - fix(cy);
  }
  return x.length - y.length;
}

function compareCustomers(a, b) {
  return compareStrings(a.firstname, b.firstname) || compareStrings(a.lastname, b.lastname) || compareStrings(String(a._id), String(b._id));
}

// A one-word name is stored in both fields by the existing importer ("Sara Sara").
function displayName(customer) {
  const first = String(customer.firstname || '').trim();
  const last = String(customer.lastname || '').trim();
  const name = first === last ? first : `${first} ${last}`.trim();
  return name || String(customer.phone || '');
}

function toRow(customer, languageDoc, merchantDefault) {
  const language = languageDoc && CUSTOMER_LANGUAGES.includes(languageDoc.language) ? languageDoc.language : 'unknown';
  return {
    id: String(customer._id),
    name: displayName(customer),
    phone: String(customer.phone || ''),
    language,
    languageSource: (languageDoc && languageDoc.languageSource) || null,
    effectiveLanguage: resolveLanguage(language, merchantDefault),
    marketingConsent: customer.marketingConsent === true,
    optedOut: customer.optedOut === true,
  };
}

async function merchantDefaultLanguage(deps, workspaceId) {
  const settings = await deps.localeSettings.getSettings(workspaceId);
  return settings && settings.defaultCustomerLanguage;
}

async function countryCodeFor(deps, workspaceId) {
  const doc = await deps.Settings.findOne({ workspaceId }).select('defaultCountryCode').lean();
  return (doc && doc.defaultCountryCode) || DEFAULT_COUNTRY_CODE;
}

// Sidecar documents for some customers: Map(customerId string -> doc), queried in id chunks.
async function languagesFor(workspaceId, customerIds, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const map = new Map();
  for (const ids of chunks(Array.from(new Set(customerIds.map(String))), CHUNK)) {
    const docs = await deps.CustomerLanguage.find({ workspaceId: ws, customerId: { $in: ids } }).select('customerId language languageSource').lean();
    for (const doc of docs) map.set(String(doc.customerId), doc);
  }
  return map;
}

// ── counts ─────────────────────────────────────────────────────────────────

async function getCounts(workspaceId, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const [total, enAll, arAll] = await Promise.all([
    deps.Customer.countDocuments(baseFilter(ws)),
    deps.CustomerLanguage.countDocuments({ workspaceId: ws, language: 'en' }),
    deps.CustomerLanguage.countDocuments({ workspaceId: ws, language: 'ar' }),
  ]);
  let enOut = 0;
  let arOut = 0;
  if (enAll + arAll > 0) {
    // Sidecar rows of erased/demo customers are outside the managed set.
    const outside = await deps.Customer.find(withWorkspace({ $or: [{ deletedAt: { $exists: true } }, { isDemo: true }] }, ws)).select('_id').lean();
    for (const ids of chunks(outside.map((d) => d._id), CHUNK)) {
      const scope = { workspaceId: ws, customerId: { $in: ids } };
      const [e, a] = await Promise.all([
        deps.CustomerLanguage.countDocuments({ ...scope, language: 'en' }),
        deps.CustomerLanguage.countDocuments({ ...scope, language: 'ar' }),
      ]);
      enOut += e;
      arOut += a;
    }
  }
  const en = Math.max(0, enAll - enOut);
  const ar = Math.max(0, arAll - arOut);
  return { en, ar, unknown: Math.max(0, total - en - ar), total };
}

// ── list ───────────────────────────────────────────────────────────────────

// Cosmos DB for MongoDB rejects a multi-field sort that no compound index serves, and the existing
// Customer model declares none (this feature may not change it). The deterministic name order is
// tried first; if the database refuses it, the page is read with the single-field sort the existing
// /api/customers list already uses (shared/operations.js), so the screen degrades to a looser
// tie order instead of failing.
const FALLBACK_NAME_SORT = { firstname: 1 };
async function findNamePage(deps, filter, skip, limit) {
  const run = (sort) => deps.Customer.find(filter).select(ROW_FIELDS).sort(sort).skip(skip).limit(limit).lean();
  try {
    return await run(NAME_SORT);
  } catch (err) {
    return run(FALLBACK_NAME_SORT);
  }
}

async function pageQuery(deps, filter, skip, limit, { count = true } = {}) {
  const [docs, total] = await Promise.all([
    findNamePage(deps, filter, skip, limit),
    count ? deps.Customer.countDocuments(filter) : Promise.resolve(null),
  ]);
  return { docs, total };
}

// Big language classes: stream names only, intersect in memory, then load the page.
async function pageByIntersection(deps, ws, filter, language, classIds, skip, limit) {
  const wanted = new Set(classIds.map(String));
  const people = await deps.Customer.find(filter).select('_id firstname lastname').lean();
  const matching = people.filter((p) => (language === 'unknown' ? !wanted.has(String(p._id)) : wanted.has(String(p._id)))).sort(compareCustomers);
  const slice = matching.slice(skip, skip + limit);
  if (!slice.length) return { docs: [], total: matching.length };
  const rows = await deps.Customer.find(withWorkspace({ _id: { $in: slice.map((p) => p._id) } }, ws)).select(ROW_FIELDS).lean();
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return { docs: slice.map((p) => byId.get(String(p._id))).filter(Boolean), total: matching.length };
}

async function pageByLanguage(deps, ws, filter, language, skip, limit) {
  const classFilter = language === 'unknown' ? { $in: ['en', 'ar'] } : language;
  const classDocs = await deps.CustomerLanguage.find({ workspaceId: ws, language: classFilter }).select('customerId').lean();
  const ids = classDocs.map((d) => d.customerId);
  const clauseMax = (deps.limits && deps.limits.clauseMax) || CLAUSE_MAX;
  if (ids.length > clauseMax) return pageByIntersection(deps, ws, filter, language, ids, skip, limit);
  if (language === 'unknown') return pageQuery(deps, ids.length ? { ...filter, _id: { $nin: ids } } : filter, skip, limit);
  if (!ids.length) return { docs: [], total: 0 };
  return pageQuery(deps, { ...filter, _id: { $in: ids } }, skip, limit);
}

// -> { items: CustomerLanguageRow[], total, page, limit, counts }
async function listCustomers({ workspaceId, search, language, page, limit } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const filterLanguage = parseLanguageFilter(language);
  const pageNo = clampInt(page, 1, 1, MAX_PAGE);
  const perPage = clampInt(limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const skip = (pageNo - 1) * perPage;

  const countryCode = typeof search === 'string' && search.trim() ? await countryCodeFor(deps, ws) : undefined;
  const { filter: searchFilter } = buildSearchFilter(search, { countryCode });
  const searching = Object.keys(searchFilter).length > 0;
  const filter = { ...baseFilter(ws), ...searchFilter };

  const [counts, merchantDefault, selected] = await Promise.all([
    getCounts(ws, deps),
    merchantDefaultLanguage(deps, ws),
    filterLanguage === 'all'
      ? pageQuery(deps, filter, skip, perPage, { count: searching })
      : pageByLanguage(deps, ws, filter, filterLanguage, skip, perPage),
  ]);
  const total = filterLanguage === 'all' && !searching ? counts.total : selected.total;
  const languages = await languagesFor(ws, selected.docs.map((d) => d._id), deps);
  return {
    items: selected.docs.map((c) => toRow(c, languages.get(String(c._id)), merchantDefault)),
    total,
    page: pageNo,
    limit: perPage,
    counts,
  };
}

// ── writes ─────────────────────────────────────────────────────────────────

function upsertOp(workspaceId, customerId, language, source, userId, { protectCustomerChoice = false } = {}) {
  const filter = { workspaceId, customerId };
  // Atomic guard for the CSV import: a row the customer chose themselves does not
  // match, the upsert then tries to insert and the unique index rejects it.
  if (protectCustomerChoice) filter.languageSource = { $ne: 'customer_chose' };
  const $set = { language, languageSource: source };
  if (userId && isObjectIdLike(userId)) $set.updatedBy = userId;
  return { updateOne: { filter, update: { $set }, upsert: true, setDefaultsOnInsert: true } };
}

// Operations that failed ONLY because of the unique index (E11000), or null when
// the error is anything else. A concurrent writer inserting the same row first
// makes an upsert fail once; running it again then updates that row.
function duplicateKeyFailures(err, operations) {
  const raw = err && err.writeErrors;
  if (!raw) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  if (!list.length || list.some((e) => e.code !== 11000)) return null;
  return list.map((e) => operations[e.index]).filter(Boolean);
}

async function runBulk(Model, operations) {
  let conflicts = [];
  for (const slice of chunks(operations, BULK_CHUNK)) {
    try {
      await Model.bulkWrite(slice, { ordered: false });
    } catch (err) {
      const failed = duplicateKeyFailures(err, slice);
      if (!failed) throw err;
      conflicts = conflicts.concat(failed);
    }
  }
  return conflicts;
}

// -> operations that STILL conflict after one retry.
async function runBulkWithRetry(Model, operations) {
  const conflicts = await runBulk(Model, operations);
  return conflicts.length ? runBulk(Model, conflicts) : [];
}

async function setCustomerLanguage({ workspaceId, customerId, language, userId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const id = parseId(customerId, 'customerId');
  const value = parseLanguage(language);
  const customer = await deps.Customer.findOne({ _id: id, ...baseFilter(ws) }).select(ROW_FIELDS).lean();
  if (!customer) throw httpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');

  const op = upsertOp(ws, id, value, value === 'unknown' ? CLEAR_SOURCE : 'merchant_set', userId).updateOne;
  const options = { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true };
  let doc;
  try {
    doc = await deps.CustomerLanguage.findOneAndUpdate(op.filter, op.update, options).lean();
  } catch (err) {
    if (!err || err.code !== 11000) throw err;
    doc = await deps.CustomerLanguage.findOneAndUpdate(op.filter, op.update, options).lean(); // lost an insert race: update the winner
  }
  return toRow(customer, doc, await merchantDefaultLanguage(deps, ws));
}

// One customer's row for the profile panel on the existing Customers page (IM-D / B1):
// the same shape the list and the PUT answer with. 404 for another workspace's, erased or
// demo customer (the same customer set every other call here manages).
async function getCustomerLanguage({ workspaceId, customerId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const id = parseId(customerId, 'customerId');
  const customer = await deps.Customer.findOne({ _id: id, ...baseFilter(ws) }).select(ROW_FIELDS).lean();
  if (!customer) throw httpError(404, 'Customer not found', 'CUSTOMER_NOT_FOUND');
  const doc = await deps.CustomerLanguage.findOne({ workspaceId: ws, customerId: id }).select('customerId language languageSource').lean();
  return toRow(customer, doc, await merchantDefaultLanguage(deps, ws));
}

// The main import wizard's language column (IM-D / B1). entries: [{ customerId, language }]
// with language 'en' | 'ar' only (a blank / 'unknown' cell is "no information" and never
// reaches this function). Exactly the hub CSV import's rules: the first entry per customer
// wins, a customer outside this workspace (or erased / demo) is skipped, an identical
// language is left alone (the stored source is not touched), a language the customer chose
// themselves is never overwritten (atomic guard in the write filter), merchant_set and
// inferred values are overwritten and recorded as csv_import. Never deletes anything.
// -> { written, protected, unchanged, skipped }
async function setImportedLanguages({ workspaceId, userId, entries } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const wanted = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const id = entry && entry.customerId !== undefined && entry.customerId !== null ? String(entry.customerId) : '';
    if (!isObjectIdLike(id) || (entry.language !== 'en' && entry.language !== 'ar') || wanted.has(id)) continue;
    wanted.set(id, entry.language);
  }
  const result = { written: 0, protected: 0, unchanged: 0, skipped: 0 };
  if (!wanted.size) return result;

  const owned = new Set();
  for (const part of chunks(Array.from(wanted.keys()), CHUNK)) {
    const docs = await deps.Customer.find({ _id: { $in: part }, ...baseFilter(ws) }).select('_id').lean();
    docs.forEach((d) => owned.add(String(d._id)));
  }
  const languages = await languagesFor(ws, Array.from(owned), deps);
  const operations = [];
  for (const [id, target] of wanted) {
    if (!owned.has(id)) { result.skipped += 1; continue; }
    const effect = effectOf(languages.get(id), target);
    if (effect === 'unchanged') result.unchanged += 1;
    else if (effect === 'protected') result.protected += 1;
    else operations.push(upsertOp(ws, id, target, 'csv_import', userId, { protectCustomerChoice: true }));
  }
  if (operations.length) {
    const rejected = await runBulkWithRetry(deps.CustomerLanguage, operations); // still blocked = chosen by the customer in the meantime
    result.protected += rejected.length;
    result.written += operations.length - rejected.length;
  }
  return result;
}

// -> { updated }: exactly the requested customers that belong to this workspace.
async function bulkSetCustomerLanguage({ workspaceId, customerIds, language, userId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const ids = parseIdList(customerIds);
  const value = parseLanguage(language);
  const owned = await deps.Customer.find({ _id: { $in: ids }, ...baseFilter(ws) }).select('_id').lean();
  const ownedIds = owned.map((d) => String(d._id));
  const source = value === 'unknown' ? CLEAR_SOURCE : 'merchant_set';
  const remaining = await runBulkWithRetry(deps.CustomerLanguage, ownedIds.map((id) => upsertOp(ws, id, value, source, userId)));
  if (remaining.length) throw new Error('Bulk language update could not complete');
  return { updated: ownedIds.length };
}

// ── CSV import ─────────────────────────────────────────────────────────────

function fileProblem(err) {
  if (err && err.code) return err;
  const tooMany = /too many rows/i.test((err && err.message) || '');
  return tooMany
    ? httpError(413, 'The file has too many rows (max 50,000)', 'FILE_TOO_LARGE')
    : httpError(400, 'The file is not a valid CSV', 'FILE_INVALID');
}

// Excel can prepend a "sep=;" line that states the delimiter.
function readCsv(text) {
  let body = text;
  let delimiter = null;
  const firstLine = body.split(/\r\n|\n|\r/, 1)[0];
  const directive = /^sep=([,;\t])$/i.exec(firstLine.trim());
  if (directive) {
    delimiter = directive[1];
    body = body.slice(firstLine.length).replace(/^(\r\n|\n|\r)/, '');
  }
  delimiter = delimiter || detectDelimiter(body);
  try {
    return { delimiter, rows: parseRows(body, { delimiter }) };
  } catch (err) {
    throw fileProblem(err);
  }
}

function findColumns(headerRow) {
  const keys = headerRow.map((cell) => normalizeForMatch(cell));
  const phone = keys.findIndex((k) => PHONE_HEADERS.has(k));
  if (phone < 0) throw httpError(400, 'No phone column found — add a column named phone', 'CSV_NO_PHONE_COLUMN');
  const language = keys.findIndex((k, i) => i !== phone && LANGUAGE_HEADERS.has(k));
  if (language < 0) throw httpError(400, 'No language column found — add a column named language', 'CSV_NO_LANGUAGE_COLUMN');
  return { phone, language };
}

const MIN_PHONE_DIGITS = 7;
const MAX_PHONE_DIGITS = 15; // E.164
const SCIENTIFIC_NOTATION_RE = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i; // Excel's "9.66501E+11" — digits already lost
const onlyDigits = (text) => text.replace(/\D/g, '');

// Normalised phone key (same function the existing import engine dedupes with, run
// AFTER Arabic-Indic -> Western digits) or null when it cannot be a phone number.
function phoneKey(raw, countryCode) {
  const text = toWesternDigits(raw).trim();
  if (!text || SCIENTIFIC_NOTATION_RE.test(text) || onlyDigits(text).length < MIN_PHONE_DIGITS) return null;
  const key = normalizePhoneForDedup(text, countryCode);
  return key && key.length <= MAX_PHONE_DIGITS ? key : null;
}

const cellText = (cells, index) => String(cells[index] === undefined || cells[index] === null ? '' : cells[index]).trim();
const clip = (text) => (text.length > 40 ? `${text.slice(0, 40)}\u{2026}` : text);

// One entry per non-blank data row; `outcome` is set for rows that are decided
// without touching the database (invalid / duplicate).
function classifyRows(dataRows, columns, countryCode) {
  const seen = new Set();
  const entries = [];
  dataRows.forEach((cells, i) => {
    if (cells.every((c) => !String(c || '').trim())) return;
    const phone = cellText(cells, columns.phone);
    const languageText = cellText(cells, columns.language);
    const entry = { line: i + 2, phone: clip(phone), language: clip(languageText), key: phoneKey(phone, countryCode), digits: onlyDigits(toWesternDigits(phone)), target: null, outcome: null, customerIds: [], writeIds: [] };
    entries.push(entry);
    if (!entry.key) { entry.outcome = 'invalid_phone'; return; }
    const parsed = parseLanguageValue(normalizeArabic(languageText));
    if (parsed === null) { entry.outcome = 'invalid_language'; return; }
    if (parsed === 'unknown') return; // blank / "unknown": no information, nothing to apply
    if (seen.has(entry.key)) { entry.outcome = 'duplicate'; return; }
    seen.add(entry.key);
    entry.target = parsed;
  });
  return entries;
}

// Map(phone key -> customer ids) over the managed customers. Each stored phone is
// indexed by its normalised form and by its plain digits (numbers with another
// country code than the workspace default).
async function loadPhoneIndex(deps, ws, countryCode) {
  const customers = await deps.Customer.find(baseFilter(ws)).select('_id phone').lean();
  const index = new Map();
  const add = (key, id) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    if (!index.get(key).includes(id)) index.get(key).push(id);
  };
  for (const c of customers) {
    const text = toWesternDigits(c.phone || '');
    add(normalizePhoneForDedup(text, countryCode), String(c._id));
    add(onlyDigits(text), String(c._id));
  }
  return index;
}

function effectOf(languageDoc, target) {
  const current = languageDoc && CUSTOMER_LANGUAGES.includes(languageDoc.language) ? languageDoc.language : 'unknown';
  if (current === target) return 'unchanged';
  if (languageDoc && languageDoc.languageSource === 'customer_chose') return 'protected';
  return 'updated';
}

function rowOutcome(effects) {
  if (effects.includes('updated')) return 'updated';
  return effects.includes('protected') ? 'protected' : 'unchanged';
}

async function matchRows(deps, ws, entries, countryCode) {
  const candidates = entries.filter((e) => !e.outcome);
  if (!candidates.length) return;
  const index = await loadPhoneIndex(deps, ws, countryCode);
  for (const e of candidates) e.customerIds = Array.from(new Set([...(index.get(e.key) || []), ...(index.get(e.digits) || [])]));
  const languages = await languagesFor(ws, candidates.flatMap((e) => e.customerIds), deps);
  const claimed = new Set();
  for (const e of candidates) {
    if (!e.customerIds.length) { e.outcome = 'unmatched'; continue; }
    if (!e.target) { e.outcome = 'unchanged'; continue; }
    const effects = e.customerIds.map((id) => effectOf(languages.get(id), e.target));
    e.writeIds = e.customerIds.filter((id, i) => effects[i] === 'updated' && !claimed.has(id));
    e.writeIds.forEach((id) => claimed.add(id));
    e.outcome = rowOutcome(effects);
    if (e.outcome === 'updated' && !e.writeIds.length) e.outcome = 'duplicate'; // an earlier row already writes every customer this number resolves to
  }
}

async function applyRows(deps, ws, entries, userId) {
  const writers = entries.filter((e) => e.writeIds.length);
  const operations = writers.flatMap((e) => e.writeIds.map((id) => upsertOp(ws, id, e.target, 'csv_import', userId, { protectCustomerChoice: true })));
  if (!operations.length) return;
  const rejected = await runBulkWithRetry(deps.CustomerLanguage, operations);
  const blocked = new Set(rejected.map((op) => String(op.updateOne.filter.customerId)));
  for (const e of writers) {
    const written = e.writeIds.filter((id) => !blocked.has(id));
    // Every target was protected by a language the customer chose in the meantime.
    if (!written.length) e.outcome = 'protected';
  }
}

function summarize(entries) {
  const summary = { rows: entries.length, updated: 0, unchanged: 0, unmatched: 0, invalid: 0, duplicate: 0, protected: 0 };
  for (const e of entries) {
    if (e.outcome === 'invalid_phone' || e.outcome === 'invalid_language') summary.invalid += 1;
    else summary[e.outcome] += 1;
  }
  return summary;
}

// file: { buffer }. dryRun (default true) reports exactly what would change and writes nothing.
async function importLanguages({ workspaceId, userId, file, dryRun = true } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const { text, encoding } = decodeCsvBuffer(file && file.buffer);
  const { delimiter, rows } = readCsv(text);
  if (!rows.length) throw httpError(400, 'The file is empty', 'FILE_INVALID');
  const columns = findColumns(rows[0]);
  const countryCode = await countryCodeFor(deps, ws);
  const entries = classifyRows(rows.slice(1), columns, countryCode);
  if (!entries.length) throw httpError(400, 'The file has no data rows', 'FILE_INVALID');
  await matchRows(deps, ws, entries, countryCode);
  if (!dryRun) await applyRows(deps, ws, entries, userId);
  return {
    dryRun: !!dryRun,
    encoding,
    delimiter,
    summary: summarize(entries),
    rows: entries.slice(0, IMPORT_PREVIEW_ROWS).map(({ line, phone, language, outcome }) => ({ line, phone, language, outcome })),
    truncated: entries.length > IMPORT_PREVIEW_ROWS,
  };
}

// ── CSV export / template ──────────────────────────────────────────────────

function templateCsv() {
  return stringifyCsv([
    ['phone', 'language'],
    ['0500000001', 'ar'],
    ['966500000002', 'en'],
    ['+966 50 000 0003', 'Arabic'],
  ]);
}

// Names come from customers' WhatsApp profile names — text an attacker controls —
// and end up in a file the merchant opens in Excel. csv.stringifyCsv neutralises
// formulas but exempts any cell that merely STARTS with a signed digit
// ("+1+cmd|' /C calc'!A0"), so names get the stricter rule: only a plain number
// is left alone.
function spreadsheetSafe(text) {
  return /^[=+\-@\t\r]/.test(text) && !/^[+-]?\d+([.,]\d+)?$/.test(text) ? `'${text}` : text;
}

// name,phone,language,source for every managed customer, by name. Read in _id
// chunks so memory stays flat, with a ceiling so a runaway workspace cannot OOM the server.
async function exportCsv({ workspaceId } = {}, deps = realDeps()) {
  const ws = requireWorkspace(workspaceId);
  const people = [];
  let lastId = null;
  for (;;) {
    const filter = lastId ? { ...baseFilter(ws), _id: { $gt: lastId } } : baseFilter(ws);
    const docs = await deps.Customer.find(filter).select('_id firstname lastname phone').sort({ _id: 1 }).limit(CHUNK).lean();
    if (!docs.length) break;
    const languages = await languagesFor(ws, docs.map((d) => d._id), deps);
    for (const d of docs) people.push({ ...d, doc: languages.get(String(d._id)) });
    if (people.length > EXPORT_MAX_ROWS) throw httpError(413, 'Too many customers to export in one file', 'FILE_TOO_LARGE');
    lastId = docs[docs.length - 1]._id;
    if (docs.length < CHUNK) break;
  }
  people.sort(compareCustomers);
  const rows = people.map((p) => {
    const language = p.doc && CUSTOMER_LANGUAGES.includes(p.doc.language) ? p.doc.language : 'unknown';
    return [spreadsheetSafe(displayName(p)), p.phone || '', language, (p.doc && p.doc.languageSource) || ''];
  });
  return stringifyCsv([['name', 'phone', 'language', 'source'], ...rows]);
}

module.exports = {
  LANGUAGE_FILTERS,
  MAX_BULK,
  MAX_LIMIT,
  CLAUSE_MAX,
  IMPORT_PREVIEW_ROWS,
  baseFilter,
  compareStrings,
  parseId,
  parseIdList,
  parseLanguage,
  parseLanguageFilter,
  parseSearch,
  parseDryRun,
  spreadsheetSafe,
  toRow,
  languagesFor,
  getCounts,
  listCustomers,
  setCustomerLanguage,
  getCustomerLanguage,
  setImportedLanguages,
  bulkSetCustomerLanguage,
  importLanguages,
  exportCsv,
  templateCsv,
};
