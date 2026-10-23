'use strict';
// The dedicated "setup test" template (DB design 6.8, DECISIONS D9): one short, plain,
// NO-VARIABLE, non-promotional UTILITY template that is submitted on the merchant's own
// WhatsApp Business account together with the starter set. It exists so the test message of
// step 5 can always be sent as soon as ONE template is approved, without merge fields and
// without any marketing wording.
//
// Pure content + one thin DB helper. Nothing is executed at require time. The Arabic copy
// is a draft (glossary: brand stays Latin, WhatsApp = واتساب, second person masculine).
const TEST_TEMPLATE_KEY = 'setup_test';
const TEST_TEMPLATE_CATEGORY = 'UTILITY';
const TEST_TEMPLATE_TITLE = Object.freeze({ en: 'Setup test message', ar: 'رسالة اختبار الإعداد' });

const BODIES = Object.freeze({
  en: 'This is a test message from your WaFlow setup. If you can read it, your WhatsApp Business number is working. There is nothing you need to do.',
  ar: 'هذه رسالة تجريبية من إعداد WaFlow. إذا وصلتك هذه الرسالة فهذا يعني أن رقم واتساب لنشاطك التجاري يعمل بشكل صحيح. لا يلزمك أي إجراء.',
});

/**
 * The language variant of the test template, in the shape metaConstraints.validateVariant and
 * metaTemplates.buildSubmissionPayload take. No variables, no header, no footer, no buttons.
 * @param {'en'|'ar'} language
 * @returns {{language:string, body:string, buttons:Array, source:string}}
 */
function buildTestTemplate(language) {
  if (language !== 'en' && language !== 'ar') throw new RangeError('buildTestTemplate: language must be en or ar');
  return { language, body: BODIES[language], buttons: [], source: 'setup_test' };
}

/**
 * Queue (NO Meta call) the test template rows (en + ar) for a workspace. Idempotent: the unique
 * index {workspaceId, key, language} makes a second call a no-op. The Arabic row follows the same
 * rule as every starter template (queued only when the merchant chose Arabic).
 * @param {string} workspaceId
 * @param {object} [deps] same deps as starterTemplates (model, stateModel, now, library ...)
 * @returns {Promise<{created:number, existing:number, total:number}>}
 */
async function ensureTestTemplate(workspaceId, deps) {
  // lazy: starterTemplates requires this module too (no cycle at load time)
  return require('./starterTemplates').seedRows(workspaceId, [TEST_TEMPLATE_KEY], deps);
}

module.exports = { TEST_TEMPLATE_KEY, TEST_TEMPLATE_CATEGORY, TEST_TEMPLATE_TITLE, buildTestTemplate, ensureTestTemplate };
