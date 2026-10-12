'use strict';
// Backend message catalogue: customer-facing text the server itself sends or
// renders (consent acknowledgements, button labels, customer-page strings,
// AI notices...). One JSON file per namespace in ./catalog/ — slices add their
// own file, so parallel work never collides:
//   { "<key>": { "en": "...", "ar": "...", "status": "draft"|"reviewed",
//                "reviewer": null, "reviewedAt": null, "needsLegalApproval": false, "notes": "" } }
// Full key = "<file name without .json>.<key>", e.g. "consent.optOutAck".
// Every Arabic string starts as `draft` (spec §8); only the review import
// script (scripts/i18n-review.js) may mark one `reviewed`.
const fs = require('fs');
const path = require('path');
const { renderMessageSafe } = require('./mergeFields');

const DIR = path.join(__dirname, 'catalog');
let cache = null;

function normalizeEntry(e) {
  return {
    en: typeof e.en === 'string' ? e.en : '',
    ar: typeof e.ar === 'string' ? e.ar : '',
    status: e.status === 'reviewed' ? 'reviewed' : 'draft',
    reviewer: e.reviewer || null,
    reviewedAt: e.reviewedAt || null,
    needsLegalApproval: !!e.needsLegalApproval,
    notes: e.notes || '',
  };
}

function load() {
  if (cache) return cache;
  const entries = new Map();
  if (fs.existsSync(DIR)) {
    for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
      const ns = file.slice(0, -'.json'.length);
      const data = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
      for (const [key, entry] of Object.entries(data)) entries.set(`${ns}.${key}`, normalizeEntry(entry));
    }
  }
  cache = entries;
  return cache;
}

function reload() { cache = null; return load(); }

function has(key) { return load().has(key); }

// Translate. Falls back: requested language -> English -> the key itself (so a
// missing string is visible in review rather than blank). Arabic output wraps
// Latin/number params in LRM (see mergeFields.renderMessageSafe). Unfilled
// {params} are left in place — never throws.
function t(language, key, params) {
  const entry = load().get(key);
  if (!entry) return key;
  const lang = language === 'ar' ? 'ar' : 'en';
  const raw = (lang === 'ar' && entry.ar) ? entry.ar : (entry.en || entry.ar || key);
  const usedLang = (lang === 'ar' && entry.ar) ? 'ar' : 'en';
  return params ? renderMessageSafe(raw, params, { language: usedLang }).text : raw;
}

function listEntries() {
  return Array.from(load(), ([key, e]) => ({ key, ...e }));
}

// Counts for the admin view (spec §8: "show a count of unreviewed strings").
function counts() {
  const all = listEntries().filter((e) => e.ar || e.en);
  const arabic = all.filter((e) => e.ar);
  return {
    total: all.length,
    arabicTotal: arabic.length,
    arabicDraft: arabic.filter((e) => e.status !== 'reviewed').length,
    arabicReviewed: arabic.filter((e) => e.status === 'reviewed').length,
    arabicMissing: all.length - arabic.length,
    needsLegalApproval: arabic.filter((e) => e.needsLegalApproval && e.status !== 'reviewed').length,
  };
}

module.exports = { DIR, load, reload, has, t, listEntries, counts, normalizeEntry };
