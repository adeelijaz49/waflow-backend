'use strict';
// The UTILITY floor (compliance, 2026-10-12). Marketing consent is gated on the template
// category, and the category is something a merchant types and Meta may re-classify, so a
// merchant must not be able to dodge consent by labelling a marketing message UTILITY.
//
// Only TRANSACTIONAL use cases may ever be treated as UTILITY - payment_reminder,
// booking_confirmation, booking_reminder, order_confirmation. Everything else (promotion,
// comeback, loyalty_reminder, points_balance, points_expiring, referral_invite,
// referral_reward, greeting, welcome_optin, custom, and any use case this file has never
// heard of) is MARKETING, whatever category was requested and whatever Meta reports.
//
// Two places apply it, both through this module so the list exists once:
//   * templates.js    - the REQUESTED category stored on create / update / library copy is
//                       corrected to MARKETING (never rejected), and the category a version
//                       is validated and submitted under is the floored one;
//   * campaignPlanner.js#effectiveCategory - the category used for audience eligibility,
//                       planning AND sending (what Meta reports is still stored untouched,
//                       in variants[].metaCategory).
// welcome_optin keeps its documented exemption (audience.js, a consent request is the ASK:
// opt_in + decline buttons, never opted-out customers, not asked within 7 days); that
// exemption is decided by the use case itself, not by the category.
const TRANSACTIONAL_USE_CASES = Object.freeze(['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation']);

function isTransactionalUseCase(useCase) {
  return typeof useCase === 'string' && TRANSACTIONAL_USE_CASES.includes(useCase);
}

// (use case, requested category) -> 'UTILITY' | 'MARKETING'. UTILITY survives only when it was
// asked for AND the use case is transactional.
function floorCategory(useCase, requested) {
  return requested === 'UTILITY' && isTransactionalUseCase(useCase) ? 'UTILITY' : 'MARKETING';
}

module.exports = { TRANSACTIONAL_USE_CASES, isTransactionalUseCase, floorCategory };
