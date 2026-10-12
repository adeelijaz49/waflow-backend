'use strict';
// Detects whether a piece of text is Arabic or English from its letters.
// Used to infer a customer's language from their first inbound WhatsApp
// message (spec §3.1) — deliberately conservative: when the evidence is weak
// or mixed it answers 'unknown' rather than guessing.
const { countLetters } = require('./arabicText');

const SUPPORTED_LANGUAGES = ['en', 'ar'];
const CUSTOMER_LANGUAGES = ['en', 'ar', 'unknown'];

function stripNoise(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ')
    .replace(/[@#]\w+/g, ' ');
}

// -> { language: 'ar'|'en'|'unknown', confidence: 0..1, counts }
function detectLanguage(text, { minLetters = 2, dominance = 0.7 } = {}) {
  const counts = countLetters(stripNoise(text));
  const total = counts.arabic + counts.latin;
  if (total < minLetters) return { language: 'unknown', confidence: 0, counts };
  const arShare = counts.arabic / total;
  if (arShare >= dominance) return { language: 'ar', confidence: arShare, counts };
  if (1 - arShare >= dominance) return { language: 'en', confidence: 1 - arShare, counts };
  return { language: 'unknown', confidence: Math.max(arShare, 1 - arShare), counts };
}

function isSupportedLanguage(value) { return SUPPORTED_LANGUAGES.includes(value); }
function isCustomerLanguage(value) { return CUSTOMER_LANGUAGES.includes(value); }

// Fallback order from spec §2: customer -> merchant default -> English.
function resolveLanguage(customerLanguage, merchantDefault) {
  if (isSupportedLanguage(customerLanguage)) return customerLanguage;
  if (isSupportedLanguage(merchantDefault)) return merchantDefault;
  return 'en';
}

// Accepts what a merchant might type in a CSV cell (spec §3.1: ar, en, Arabic,
// English) plus a few natural variants. Returns 'ar' | 'en' | 'unknown' | null
// (null = unrecognised value, so callers can report it instead of guessing).
const LANGUAGE_ALIASES = new Map([
  ['ar', 'ar'], ['arabic', 'ar'], ['ara', 'ar'], ['ar-sa', 'ar'], ['ar_sa', 'ar'], ['arabe', 'ar'],
  ['عربي', 'ar'], ['عربى', 'ar'], ['العربية', 'ar'], ['العربيه', 'ar'], ['عربية', 'ar'], ['عربيه', 'ar'],
  ['en', 'en'], ['english', 'en'], ['eng', 'en'], ['en-us', 'en'], ['en_us', 'en'], ['en-gb', 'en'], ['en_gb', 'en'],
  ['انجليزي', 'en'], ['إنجليزي', 'en'], ['انجليزى', 'en'], ['الانجليزية', 'en'], ['الإنجليزية', 'en'], ['انجليزية', 'en'], ['إنجليزية', 'en'],
  ['unknown', 'unknown'], ['', 'unknown'],
]);

function parseLanguageValue(value) {
  if (value === undefined || value === null) return 'unknown';
  const key = String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  if (LANGUAGE_ALIASES.has(key)) return LANGUAGE_ALIASES.get(key);
  // Tolerate Arabic hamza/alef spelling differences without importing the
  // heavier normaliser into this hot path.
  const loose = key.replace(/[آأإ]/g, 'ا').replace(/ى/g, 'ي');
  if (LANGUAGE_ALIASES.has(loose)) return LANGUAGE_ALIASES.get(loose);
  return null;
}

module.exports = {
  SUPPORTED_LANGUAGES,
  CUSTOMER_LANGUAGES,
  detectLanguage,
  isSupportedLanguage,
  isCustomerLanguage,
  resolveLanguage,
  parseLanguageValue,
};
