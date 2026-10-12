'use strict';
// Pure core of the native-review workflow (spec §8): export every Arabic
// string to a spreadsheet-friendly CSV, validate and import the reviewer's
// edits back. scripts/i18n-review.js is the thin CLI around it (all disk access
// lives there; nothing here touches the filesystem, the DB or the network).
//
// Rules that make the workflow safe (the reviewer is a human in a spreadsheet,
// the text ends up in customer-facing WhatsApp messages):
//  * Machine/edited text is never silently "reviewed": if the Arabic CHANGED and
//    the row does not explicitly say `reviewed`, the string becomes `draft`.
//    `reviewed` needs a reviewer name and a date; a reviewed row with changed
//    text is accepted (the reviewer's edit IS the review) and listed in the summary.
//  * Placeholders `{x}` must equal the English ones, no invisible/bidi control
//    characters, no Arabic-Indic digits (Western digits always, glossary), no
//    leading/trailing spaces, tanween written like the website (alef + fathatan).
//  * Template-library strings (`library.*`) live in templateLibrary.js and are
//    edited by hand: they are exported (column apply=manual) but never written back.
//  * Never deletes a key, never touches `en`, never reorders unrelated keys.
const { stringifyCsv, parseCsv, un_neutralize } = require('./csv');

const COLUMNS = ['key', 'english', 'arabic', 'status', 'reviewer', 'reviewed_at', 'needs_legal', 'notes', 'apply'];
const STATUSES = ['draft', 'reviewed'];
const LIBRARY_PREFIX = 'library.';

const INVISIBLES = /[\u{00AD}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}]/u;
const ARABIC_INDIC_DIGITS = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u;
const REVERSED_TANWEEN = /\u{064B}\u{0627}/gu; // fathatan then alef (canonical order) -> alef then fathatan
const ALEF_FATHATAN = String.fromCodePoint(0x0627, 0x064b);
const PLACEHOLDER = /\{[^{}\s]+\}/g;

function placeholders(text) {
  return (String(text).match(PLACEHOLDER) || []).sort();
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// ---- state ------------------------------------------------------------------

// catalogFiles: { <ns>: parsed catalog JSON }, libraryRows: listLibraryStrings() output.
// -> Map(key -> { key, namespace, english, arabic, status, reviewer, reviewedAt, needsLegal, notes, readonly })
function buildState(catalogFiles, libraryRows = []) {
  const state = new Map();
  for (const ns of Object.keys(catalogFiles).sort()) {
    for (const key of Object.keys(catalogFiles[ns])) {
      const e = catalogFiles[ns][key] || {};
      state.set(`${ns}.${key}`, {
        key: `${ns}.${key}`,
        namespace: ns,
        english: typeof e.en === 'string' ? e.en : '',
        arabic: typeof e.ar === 'string' ? e.ar : '',
        status: e.status === 'reviewed' ? 'reviewed' : 'draft',
        reviewer: e.reviewer || null,
        reviewedAt: e.reviewedAt || null,
        needsLegal: !!e.needsLegalApproval,
        notes: e.notes || '',
        readonly: false,
      });
    }
  }
  for (const row of libraryRows) {
    state.set(row.key, {
      key: row.key,
      namespace: 'library',
      english: row.english || '',
      arabic: row.arabic || '',
      status: row.status === 'reviewed' ? 'reviewed' : 'draft',
      reviewer: null,
      reviewedAt: null,
      needsLegal: !!row.needsLegalApproval,
      notes: 'Template library: edit shared/localization/templateLibrary.js by hand',
      readonly: true,
    });
  }
  return state;
}

function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function sortedEntries(state) {
  return Array.from(state.values()).sort((a, b) => compare(a.namespace, b.namespace) || compare(a.key, b.key));
}

// ---- export -----------------------------------------------------------------

function exportCsv(state, { onlyUnreviewed = false, namespace = null } = {}) {
  const rows = [COLUMNS];
  for (const e of sortedEntries(state)) {
    if (namespace && e.namespace !== namespace) continue;
    if (onlyUnreviewed && e.status === 'reviewed' && e.arabic) continue;
    rows.push([
      e.key, e.english, e.arabic, e.arabic ? e.status : 'draft', e.reviewer || '', e.reviewedAt || '',
      e.needsLegal ? 'yes' : '', e.notes, e.readonly ? 'manual' : 'auto',
    ]);
  }
  return { csv: stringifyCsv(rows), count: rows.length - 1 };
}

// ---- import -----------------------------------------------------------------

function toIso(value) {
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const d = new Date(/T/.test(s) ? s : `${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function todayUtc() { return new Date().toISOString().slice(0, 10); }

// Reasons the text itself is unacceptable ([] = fine).
function textProblems(arabic, english) {
  const problems = [];
  if (INVISIBLES.test(arabic)) problems.push('contains invisible/bidi control characters');
  if (ARABIC_INDIC_DIGITS.test(arabic)) problems.push('contains Arabic-Indic digits (use 0-9)');
  if (arabic !== arabic.trim()) problems.push('has leading or trailing spaces');
  if (!sameList(placeholders(arabic), placeholders(english))) {
    problems.push(`placeholders differ from English (expected ${placeholders(english).join(' ') || 'none'})`);
  }
  if (english.length >= 12 && (arabic.length > english.length * 3 + 20 || arabic.length * 4 < english.length)) {
    problems.push('length is implausible compared with the English');
  }
  return problems;
}

function cell(value) {
  return un_neutralize(value === undefined ? '' : value).replace(/\r\n?/g, '\n');
}

function decideRow(row, stored, opts) {
  const reasons = [];
  const notes = [];
  const rawArabic = cell(row.arabic);
  const arabic = rawArabic.replace(REVERSED_TANWEEN, ALEF_FATHATAN);
  if (arabic !== rawArabic) notes.push('tanween normalised to alef + fathatan');
  const statusCell = String(row.status || '').trim().toLowerCase();
  const english = cell(row.english);
  if (english && english !== stored.english) notes.push('English column differs from the source and was ignored');
  if (statusCell && !STATUSES.includes(statusCell)) reasons.push(`status must be draft or reviewed (got "${statusCell}")`);

  const changed = arabic !== stored.arabic;
  if (stored.readonly) {
    if (changed || (statusCell && statusCell !== stored.status)) reasons.push('template library string: edit templateLibrary.js by hand (apply=manual)');
    return { reasons, notes, unchanged: true };
  }
  if (!arabic && stored.arabic) reasons.push('Arabic cell is empty (keys are never erased)');
  if (arabic && (changed || statusCell === 'reviewed')) reasons.push(...textProblems(arabic, stored.english));

  let status = stored.status;
  if (statusCell === 'reviewed') status = 'reviewed';
  else if (changed || statusCell === 'draft') status = 'draft';

  let reviewer = null;
  let reviewedAt = null;
  if (status === 'reviewed') {
    if (!arabic) reasons.push('cannot mark an empty Arabic string as reviewed');
    reviewer = String(row.reviewer || '').trim() || String(opts.reviewer || '').trim()
      || (!changed && stored.status === 'reviewed' ? stored.reviewer : null);
    if (!reviewer) reasons.push('reviewed needs a reviewer name (reviewer column or --reviewer)');
    const given = String(row.reviewed_at || '').trim();
    reviewedAt = given ? toIso(given) : (!changed && stored.status === 'reviewed' && stored.reviewedAt) || toIso(opts.today || todayUtc());
    if (!reviewedAt) reasons.push('reviewed_at must be an ISO date (YYYY-MM-DD)');
    if (stored.needsLegal) notes.push("flagged needsLegalApproval: also needs the owner's lawyer");
    if (changed && stored.arabic) notes.push('reviewed with edited text (reviewer edit accepted)');
  }
  const next = { arabic, status, reviewer, reviewedAt };
  const same = arabic === stored.arabic && status === stored.status
    && (reviewer || null) === (stored.reviewer || null) && (reviewedAt || null) === (stored.reviewedAt || null);
  return { reasons, notes, next, unchanged: same, textChanged: changed };
}

// csvText -> { results[], updates[], summary }. `updates` are only the accepted,
// actually-changing rows ({ key, arabic, status, reviewer, reviewedAt }); with
// strict:true ANY rejected row empties `updates` (all-or-nothing).
function planImport(csvText, state, opts = {}) {
  const { headers, rows } = parseCsv(csvText);
  for (const need of ['key', 'arabic']) {
    if (!headers.includes(need)) throw new Error(`CSV is missing the "${need}" column`);
  }
  const seen = new Set();
  const results = [];
  const updates = [];
  for (const row of rows) {
    const key = cell(row.key).trim();
    if (!key && !String(row.arabic || '').trim()) continue; // blank spreadsheet line
    const res = { key, line: row._line, outcome: 'rejected', reasons: [], notes: [] };
    results.push(res);
    if (!state.has(key)) { res.reasons.push('unknown key'); continue; }
    if (seen.has(key)) { res.reasons.push('duplicate key in the file'); continue; }
    seen.add(key);
    const d = decideRow(row, state.get(key), opts);
    res.reasons = d.reasons;
    res.notes = d.notes;
    if (d.reasons.length) continue;
    if (d.unchanged) { res.outcome = 'unchanged'; continue; }
    res.outcome = 'updated';
    res.reviewedWithEdit = !!d.textChanged && d.next.status === 'reviewed';
    updates.push({ key, ...d.next });
  }
  const rejected = results.filter((r) => r.outcome === 'rejected').length;
  const blocked = !!opts.strict && rejected > 0;
  return {
    results,
    updates: blocked ? [] : updates,
    summary: {
      updated: blocked ? 0 : updates.length,
      unchanged: results.filter((r) => r.outcome === 'unchanged').length,
      rejected,
      blockedByStrict: blocked ? updates.length : 0,
      reviewedWithEdits: results.filter((r) => r.reviewedWithEdit).map((r) => r.key),
    },
  };
}

// ---- apply to catalogue files ---------------------------------------------------

// files: { <ns>: JSON text }, updates from planImport -> { <ns>: new JSON text } for changed files only.
// Existing key order is preserved (only the entry's fields are assigned); output uses the
// repo format (2-space JSON, trailing newline).
function applyUpdates(files, updates) {
  const has = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k);
  const parsed = {};
  for (const u of updates) {
    const dot = u.key.indexOf('.');
    const ns = u.key.slice(0, dot);
    const key = u.key.slice(dot + 1);
    if (dot < 0 || !has(files, ns)) throw new Error(`no catalogue file for key ${u.key}`);
    if (!parsed[ns]) parsed[ns] = JSON.parse(files[ns]);
    if (!has(parsed[ns], key) || !parsed[ns][key]) throw new Error(`unknown key ${u.key}`);
    const entry = parsed[ns][key];
    entry.ar = u.arabic;
    entry.status = u.status;
    for (const field of ['reviewer', 'reviewedAt']) {
      if (u[field]) entry[field] = u[field];
      else if (field in entry) entry[field] = null;
    }
  }
  const out = {};
  for (const ns of Object.keys(parsed)) out[ns] = `${JSON.stringify(parsed[ns], null, 2)}\n`;
  return out;
}

module.exports = { COLUMNS, LIBRARY_PREFIX, buildState, exportCsv, planImport, applyUpdates, textProblems };
