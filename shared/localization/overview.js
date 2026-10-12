'use strict';
// Workspace-scoped counters for the localisation hub (GET /settings/overview),
// the native-review panel (GET /review/summary) and the staff page. Read-only,
// independent of the arabic_enabled flag (a merchant who is not enabled simply
// sees zeros).
//
// Deliberately simple queries (countDocuments + one bounded lean read of the
// template variants, tallied in JS) so they behave identically on MongoDB and
// Cosmos DB: no $function / $lookup / exotic aggregation.
//
// Decisions:
//  * "Arabic variant" = a variant with language 'ar' or 'bilingual' and a
//    non-empty body (an empty variant is a savable draft, not content).
//  * Meta status buckets follow design/META-REALITY.md section 1 (FLAGGED is
//    not a status). Unknown future statuses land in arabicOther, not nowhere.
//  * Customer counts come from customerLanguage.getCounts — the same function the
//    Customers page uses — so the hub and the page always agree: only real
//    (non-erased, non-demo) customers count, and CustomerLanguage rows of erased/demo
//    customers are not added to en/ar. unknown = total - en - ar.
const catalog = require('./catalog');
const { getCounts } = require('./customerLanguage');

const MAX_TEMPLATES = 2000;
const NON_ENGLISH = ['ar', 'bilingual'];

const STATUS_BUCKET = {
  APPROVED: 'arabicApproved',
  PENDING: 'arabicPending',
  IN_APPEAL: 'arabicPending',
  REJECTED: 'arabicRejected',
  DISABLED: 'arabicRejected',
  ERROR: 'arabicRejected',
  NOT_CREATED: 'arabicNotSubmitted',
};

function defaultDeps() {
  return {
    Customer: require('../../models/Customer'),
    CustomerLanguage: require('../../models/CustomerLanguage'),
    LocalizedTemplate: require('../../models/LocalizedTemplate'),
    LocalizedCampaign: require('../../models/LocalizedCampaign'),
    ProductTranslation: require('../../models/ProductTranslation'),
    Product: require('../../models/Product'),
    Service: require('../../models/Service'),
    catalog,
  };
}

function nonEnglishVariants(template) {
  return (template.variants || []).filter((v) => NON_ENGLISH.includes(v.language)
    && typeof v.body === 'string' && v.body.trim());
}

function createOverviewService(overrides = {}) {
  const deps = () => ({ ...defaultDeps(), ...overrides });

  async function templateCounts(workspaceId) {
    const templates = await deps().LocalizedTemplate.find({ workspaceId, archived: { $ne: true } })
      .select('variants.language variants.body variants.metaStatus variants.reviewStatus')
      .limit(MAX_TEMPLATES).lean();
    const out = {
      total: templates.length, withArabic: 0, arabicApproved: 0, arabicPending: 0,
      arabicRejected: 0, arabicNotSubmitted: 0, arabicOther: 0, draft: 0, reviewed: 0,
    };
    for (const template of templates) {
      const variants = nonEnglishVariants(template);
      if (variants.length) out.withArabic += 1;
      for (const v of variants) {
        out[STATUS_BUCKET[v.metaStatus || 'NOT_CREATED'] || 'arabicOther'] += 1;
        out[v.reviewStatus === 'reviewed' ? 'reviewed' : 'draft'] += 1;
      }
    }
    return out;
  }

  async function translationCounts(workspaceId) {
    const { ProductTranslation, Product, Service } = deps();
    const ar = { workspaceId, language: 'ar' };
    const [draft, reviewed, productsDone, servicesDone, products, services] = await Promise.all([
      ProductTranslation.countDocuments({ ...ar, status: { $ne: 'reviewed' } }),
      ProductTranslation.countDocuments({ ...ar, status: 'reviewed' }),
      ProductTranslation.countDocuments({ ...ar, kind: 'product' }),
      ProductTranslation.countDocuments({ ...ar, kind: 'service' }),
      Product.countDocuments({ workspaceId, active: { $ne: false } }),
      Service.countDocuments({ workspaceId, active: { $ne: false } }),
    ]);
    const missing = Math.max(0, products - productsDone) + Math.max(0, services - servicesDone);
    return { draft, reviewed, missing };
  }

  async function overview(workspaceId) {
    const { Customer, CustomerLanguage, LocalizedCampaign } = deps();
    const [counts, templates, translations, campaignTotal, lastCampaign] = await Promise.all([
      getCounts(workspaceId, { Customer, CustomerLanguage }),
      templateCounts(workspaceId),
      translationCounts(workspaceId),
      LocalizedCampaign.countDocuments({ workspaceId }),
      LocalizedCampaign.findOne({ workspaceId, finishedAt: { $ne: null } }).sort({ finishedAt: -1 }).select('finishedAt').lean(),
    ]);
    const backend = deps().catalog.counts();
    return {
      customers: { total: counts.total, en: counts.en, ar: counts.ar, unknown: counts.unknown },
      templates: {
        total: templates.total, withArabic: templates.withArabic, arabicApproved: templates.arabicApproved,
        arabicPending: templates.arabicPending, arabicRejected: templates.arabicRejected,
        arabicNotSubmitted: templates.arabicNotSubmitted, arabicOther: templates.arabicOther,
      },
      campaigns: {
        total: campaignTotal,
        lastSentAt: lastCampaign && lastCampaign.finishedAt ? new Date(lastCampaign.finishedAt).toISOString() : null,
      },
      review: { templatesDraft: templates.draft, catalogDraft: translations.draft, backendStringsDraft: backend.arabicDraft },
    };
  }

  async function reviewSummary(workspaceId) {
    const [templates, translations] = await Promise.all([templateCounts(workspaceId), translationCounts(workspaceId)]);
    const backend = deps().catalog.counts();
    return {
      templates: { draft: templates.draft, reviewed: templates.reviewed },
      catalog: translations,
      backendStrings: {
        total: backend.total, draft: backend.arabicDraft, reviewed: backend.arabicReviewed,
        needsLegalApproval: backend.needsLegalApproval,
      },
    };
  }

  return { overview, reviewSummary, templateCounts, translationCounts };
}

module.exports = { createOverviewService, STATUS_BUCKET, ...createOverviewService() };
