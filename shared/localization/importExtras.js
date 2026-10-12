'use strict';
// Arabic additions to the EXISTING import wizard (shared/importEngine.js), design D4.
//
// Two independent pieces live here:
//
//  1. arabicHeaderFor(entityType, fieldKey, headers)   (approved global change B2c)
//     Arabic column-header aliases for the wizard's own fields (الاسم, الجوال, السعر ...).
//     Pure, no flag. importEngine.autoDetectMapping calls it ONLY as the `||` fallback when
//     the existing English alias search found nothing, so a file that maps today maps
//     identically (also when it has both an English and an Arabic column); only a field
//     that was previously unmapped can now be mapped automatically, and the merchant still
//     confirms / edits the mapping in step 2.
//
//  2. forWorkspace(entityType, workspaceId, userId)    (FLAGGED workspaces only)
//     null unless Arabic is switched on for the workspace (kill switch / error => null),
//     so every hook in importEngine is `if (arExtras)` and the unflagged / kill-switch
//     behaviour is byte-identical. When non-null it carries the extra wizard fields
//     (customer: language; product/service: Arabic name + description), their
//     auto-mapping, a per-row reader (a bad cell becomes an ordinary row error), a
//     collector for the rows that were created or matched, and finish(), which writes the
//     sidecar data (customer language = source csv_import, never over a language the
//     customer chose; Arabic text = a DRAFT, never reviewed) and returns a summary.
//     Nothing here deletes; blank cells mean "no information"; readRow/afterRow/finish
//     never throw (a failure is counted, the import itself carries on).
const { normalizeArabic, normalizeForMatch } = require('./arabicText');
const { parseLanguageValue } = require('./languageDetect');
const { cleanName, cleanDescription } = require('./catalogTranslations');

const NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;
const LANGUAGE_ERROR = 'Language must be ar, en, Arabic or English';

// ── B2c: Arabic header aliases for the wizard's own fields ────────────────────
const ARABIC_ALIASES = {
  customer: {
    name: ['الاسم', 'اسم العميل', 'الاسم الكامل', 'اسم الزبون'],
    phone: ['الجوال', 'جوال', 'رقم الجوال', 'الهاتف', 'هاتف', 'رقم الهاتف', 'واتساب', 'رقم الواتساب', 'رقم واتساب', 'موبايل', 'رقم الموبايل'],
    email: ['البريد الإلكتروني', 'البريد الالكتروني', 'الايميل', 'الإيميل', 'ايميل'],
    startingPoints: ['النقاط', 'رصيد النقاط', 'نقاط الولاء', 'رصيد نقاط الولاء'],
    notes: ['ملاحظات', 'ملاحظة'],
  },
  product: {
    name: ['اسم المنتج', 'الاسم', 'المنتج'],
    basePrice: ['السعر', 'سعر المنتج'],
    category: ['الفئة', 'التصنيف', 'القسم'],
    description: ['الوصف', 'وصف المنتج'],
    size: ['المقاس', 'الحجم'],
    color: ['اللون'],
    stock: ['المخزون', 'الكمية'],
    sku: ['رمز المنتج', 'رمز الصنف'],
    imageUrl: ['الصورة', 'رابط الصورة'],
  },
  service: {
    name: ['اسم الخدمة', 'الاسم', 'الخدمة'],
    basePrice: ['السعر', 'سعر الخدمة'],
    category: ['الفئة', 'التصنيف', 'القسم'],
    description: ['الوصف', 'وصف الخدمة'],
    duration: ['المدة', 'مدة الخدمة'],
  },
};

const ALIAS_SETS = {};
for (const [entityType, fields] of Object.entries(ARABIC_ALIASES)) {
  ALIAS_SETS[entityType] = {};
  for (const [fieldKey, aliases] of Object.entries(fields)) {
    ALIAS_SETS[entityType][fieldKey] = new Set(aliases.map(normalizeForMatch));
  }
}

// -> the first header that is an Arabic alias of the field, or undefined. Never throws.
function arabicHeaderFor(entityType, fieldKey, headers) {
  try {
    const set = ALIAS_SETS[entityType] && ALIAS_SETS[entityType][fieldKey];
    if (!set || !Array.isArray(headers)) return undefined;
    return headers.find((h) => set.has(normalizeForMatch(h)));
  } catch (err) {
    return undefined;
  }
}

// ── Flagged-only extra wizard fields ──────────────────────────────────────────
const EXTRA_FIELDS = {
  customer: [
    {
      key: 'language', label: 'Language', required: false, type: 'language', hint: 'ar, en, Arabic or English',
      aliases: ['language', 'lang', 'preferred language', 'customer language', 'اللغة', 'لغة', 'اللغة المفضلة', 'لغة العميل'],
    },
  ],
  product: arabicTextFields(['name_ar', 'name (arabic)', 'arabic name', 'الاسم بالعربية', 'اسم المنتج بالعربية'],
    ['description_ar', 'description (arabic)', 'arabic description', 'الوصف بالعربية']),
  service: arabicTextFields(['name_ar', 'name (arabic)', 'arabic name', 'الاسم بالعربية', 'اسم الخدمة بالعربية'],
    ['description_ar', 'description (arabic)', 'arabic description', 'الوصف بالعربية']),
};

function arabicTextFields(nameAliases, descriptionAliases) {
  return [
    { key: 'nameAr', label: 'Arabic name', required: false, type: 'string', hint: 'Saved as a draft for review', aliases: nameAliases },
    { key: 'descriptionAr', label: 'Arabic description', required: false, type: 'string', hint: 'Saved as a draft for review', aliases: descriptionAliases },
  ];
}

const normalizedAliases = new Map(); // `${entityType}:${key}` -> Set of normalised aliases
for (const [entityType, fields] of Object.entries(EXTRA_FIELDS)) {
  for (const field of fields) normalizedAliases.set(`${entityType}:${field.key}`, new Set(field.aliases.map(normalizeForMatch)));
}

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';
const codePoints = (text) => Array.from(text).length;

function emptySummary() {
  return {
    languagesSet: 0, languagesProtected: 0, languagesUnchanged: 0, languagesSkipped: 0, languagesFailed: 0,
    translationsSaved: 0, translationsUnchanged: 0, translationsFailed: 0,
  };
}

function realDeps() {
  return {
    isArabicEnabled: (workspaceId) => require('./settings').isArabicEnabled(workspaceId),
    customerLanguage: () => require('./customerLanguage'),
    catalogTranslations: () => require('./catalogTranslations'),
  };
}

function createImportExtras(deps = realDeps()) {
  function build(entityType, workspaceId, userId) {
    const fields = EXTRA_FIELDS[entityType];
    const languageEntries = new Map(); // customerId -> 'ar' | 'en' (first row wins)
    const translationItems = new Map(); // `${kind}:${id}` -> { kind, refId, name, description }

    return {
      entityType,
      fields,

      // header for each extra field that is not already mapped to a base field
      autoMap(headers, taken = new Set()) {
        const mapping = {};
        try {
          const used = new Set(taken);
          for (const field of fields) {
            const set = normalizedAliases.get(`${entityType}:${field.key}`);
            const hit = (headers || []).find((h) => !used.has(h) && set.has(normalizeForMatch(h)));
            if (hit !== undefined) { mapping[field.key] = hit; used.add(hit); }
          }
        } catch (err) { /* no auto-mapping; the merchant can still pick the column */ }
        return mapping;
      },

      // Reads the extra cells of one row into `mapped` (underscore keys) and pushes ordinary
      // row errors, exactly like an invalid email. Never throws.
      readRow(row, mapping, mapped, errors) {
        try {
          const cell = (key) => {
            const header = mapping && mapping[key];
            return header ? row[header] : undefined;
          };
          if (entityType === 'customer') {
            const raw = cell('language');
            if (isBlank(raw)) return;
            const parsed = parseLanguageValue(normalizeArabic(String(raw)));
            if (parsed === 'ar' || parsed === 'en') mapped._language = parsed;
            else if (parsed === null) errors.push({ field: 'language', reason: LANGUAGE_ERROR });
            return; // 'unknown' = no information
          }
          const nameRaw = cell('nameAr');
          const descRaw = cell('descriptionAr');
          const name = isBlank(nameRaw) ? '' : cleanName(nameRaw);
          const description = isBlank(descRaw) ? '' : cleanDescription(descRaw);
          if (name && codePoints(name) > NAME_MAX) errors.push({ field: 'nameAr', reason: `Arabic name is too long (max ${NAME_MAX} characters)` });
          if (description && codePoints(description) > DESCRIPTION_MAX) errors.push({ field: 'descriptionAr', reason: `Arabic description is too long (max ${DESCRIPTION_MAX} characters)` });
          if (description && !name) errors.push({ field: 'descriptionAr', reason: 'Arabic description needs an Arabic name' });
          if (name) mapped._nameAr = name;
          if (description) mapped._descriptionAr = description;
        } catch (err) {
          console.error('[localization:import] readRow failed:', err && err.message);
        }
      },

      // Called for every created or matched row. Collects only; first row per record wins.
      afterRow(kind, id, mapped) {
        try {
          if (id === undefined || id === null || !mapped) return;
          if (kind === 'customer') {
            if (mapped._language && !languageEntries.has(String(id))) languageEntries.set(String(id), mapped._language);
            return;
          }
          const key = `${kind}:${String(id)}`;
          if (mapped._nameAr && !translationItems.has(key)) {
            translationItems.set(key, { kind, refId: String(id), name: mapped._nameAr, description: mapped._descriptionAr });
          }
        } catch (err) { /* collecting is best effort */ }
      },

      // Writes the collected sidecar data. Never throws; failures are counted.
      async finish() {
        const summary = emptySummary();
        if (languageEntries.size) {
          try {
            const entries = Array.from(languageEntries, ([customerId, language]) => ({ customerId, language }));
            const r = await deps.customerLanguage().setImportedLanguages({ workspaceId, userId, entries });
            summary.languagesSet = r.written || 0;
            summary.languagesProtected = r.protected || 0;
            summary.languagesUnchanged = r.unchanged || 0;
            summary.languagesSkipped = r.skipped || 0;
          } catch (err) {
            console.error('[localization:import] saving languages failed:', err && err.message);
            summary.languagesFailed = languageEntries.size;
          }
        }
        if (translationItems.size) {
          try {
            const r = await deps.catalogTranslations().saveImportedDrafts({ workspaceId, userId, items: Array.from(translationItems.values()) });
            summary.translationsSaved = r.saved || 0;
            summary.translationsUnchanged = r.unchanged || 0;
            summary.translationsFailed = r.failed || 0;
          } catch (err) {
            console.error('[localization:import] saving Arabic texts failed:', err && err.message);
            summary.translationsFailed = translationItems.size;
          }
        }
        return summary;
      },
    };
  }

  return {
    // null unless the workspace is flagged (kill switch / any error => null = today's behaviour)
    async forWorkspace(entityType, workspaceId, userId) {
      try {
        if (!workspaceId || !EXTRA_FIELDS[entityType]) return null;
        if (!(await deps.isArabicEnabled(workspaceId))) return null;
        return build(entityType, workspaceId, userId);
      } catch (err) {
        return null;
      }
    },
    withExtraFields(extras, fields) {
      return extras ? [...fields, ...extras.fields] : fields;
    },
    withExtraMapping(extras, headers, mapping) {
      return extras ? { ...mapping, ...extras.autoMap(headers, new Set(Object.values(mapping))) } : mapping;
    },
  };
}

const shared = createImportExtras();

module.exports = {
  LANGUAGE_ERROR,
  NAME_MAX,
  DESCRIPTION_MAX,
  EXTRA_FIELDS,
  arabicHeaderFor,
  createImportExtras,
  forWorkspace: (entityType, workspaceId, userId) => shared.forWorkspace(entityType, workspaceId, userId),
  withExtraFields: (extras, fields) => shared.withExtraFields(extras, fields),
  withExtraMapping: (extras, headers, mapping) => shared.withExtraMapping(extras, headers, mapping),
};
