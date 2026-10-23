'use strict';
// EXPORT CONTRACT of the onboarding backend (INTERFACES.md sections 2.16 / 2.17, as amended by the integration task I1a).
// For every module / router / CLI the promised export names must exist with the right KIND (function, class,
// constant object, primitive constant). The B0 stubs are long gone: this test asserts NO behaviour, it only requires
// the modules and looks at their exports (no module function is called, nothing touches a database or the network),
// so it can never crash or hang when the whole directory runs.
const FN = 'function';
const OBJ = 'object';
const PRIM = 'primitive';

// name -> { fn: [...], obj: [...], prim: [...] } ; `fn` includes classes
const SHARED = {
  steps: {
    fn: ['validateBusinessInput', 'nextStep', 'markStep', 'buildState', 'buildBillingState', 'cleanText', 'toIso', 'businessComplete', 'isFinished', 'deriveProgress', 'stepStatus', 'stepDone', 'numberPaused', 'connectionBroken', 'isOwner', 'readCounts', 'requestContext', 'trackEvent', 'connectStepView', 'lastErrorOf'],
    obj: ['STEP_KEYS', 'STEP_INDEX', 'INDUSTRY_KEYS', 'COUNTRY_CODES', 'STEP_STATUSES', 'CONNECTION_EXISTS_STATUSES'],
  },
  support: {
    fn: ['getHelpContext', 'createSupportRequest', 'buildPrefilledText', 'safeLabel', 'emailErrorCode'],
    obj: ['KINDS', 'STEP_NUMBER'],
    prim: ['LIMIT_PER_DAY', 'DUPLICATE_WINDOW_MS', 'MESSAGE_MAX'],
  },
  stripeAdapter: {
    fn: ['mapStripeStatus', 'readPeriodEnd', 'readSubscriptionIdFromInvoice', 'getStripeClient', 'verifyEvent', 'buildCheckoutParams', 'idOf', 'readCustomerId', 'readPriceId', 'hasDefaultPaymentMethod', 'extractPrefill', 'classifyStripeError', 'cleanEmail', 'cleanPlanCode', 'WebhookSignatureError', '_resetClient'],
    obj: ['TERMINAL_STATUSES'],
    prim: ['PURPOSE'],
  },
  stripeWebhook: { fn: ['handler', 'createHandler', 'processEvent', 'resolveWorkspace', 'claimEvent'], obj: ['EVENT_TYPES'] },
  billing: { fn: ['createCheckout', 'createPortal', 'refreshBilling', 'applyStripeState', 'reconcileSweep', 'reconcileOne', 'capturePrefill', 'summarize', 'retryFor', 'existingSubscription', 'SubscriptionExistsError'] },
  metaClient: { fn: ['createMetaGraphClient', 'getDefaultClient', 'MetaGraphError', 'sanitizeMessage', 'appSecretProof'], prim: ['WABA_FIELDS_CORE'] },
  metaErrors: { fn: ['classify', 'popupOutcome'], obj: ['TABLE', 'NETWORK_CODES', 'POPUP_CODES'], prim: ['SUBCODE_DUPLICATE_TEMPLATE'] },
  connect: {
    fn: ['getConnectConfig', 'recordConnectEvent', 'completeConnect', 'resumeConnect', 'requestDisconnect', 'disconnect', 'reportGraphError'],
    obj: ['CONNECT_CONSTANTS', '_internal'],
  },
  statusRefresh: {
    fn: ['refreshConnection', 'snapshot', 'connectionLevel', 'nextCheckDelayMs', 'markNeedsReconnect', 'markNeedsAttention', 'templateAggregate', 'computeDisplayName', 'attentionCause', 'causeOf', 'kindOf', 'toOnbError', 'isWaiting', 'transitions', 'displayNameKey', 'epochOf', 'commitPatch', 'withPatch'],
    obj: ['CADENCE', 'POLLABLE_STATUSES', 'ATTENTION_ISSUE_CODES', 'PATHS'],
  },
  approvals: { fn: ['buildApprovals', 'confirmPayment', 'changeDisplayName', 'reRegisterDueNames', 'touchProgress', 'cleanName'], prim: ['REREGISTER_WINDOW_MS', 'REREGISTER_MAX_ATTEMPTS'] },
  scheduler: {
    fn: ['startOnboardingScheduler', 'runOnboardingSweep', 'stopOnboardingScheduler', 'acquireLock', 'tick', 'realDeps', 'sweepConnections', 'sweepTemplates', 'sweepResume'],
    prim: ['LOCK_ID', 'DEFAULT_INTERVAL_MS'],
  },
  webhookEvents: { fn: ['enabled', 'intercept', 'handleEntry', 'createWebhookEvents', 'clearMemo', 'matchesMerchant'], obj: ['REVOKE_EVENTS', 'ATTENTION_EVENTS', 'REFRESH_EVENTS', 'LIMITS'] },
  webhookSignature: { fn: ['middleware', 'computeSignature', 'verify', 'createMiddleware', 'readRawBody', 'conformingJson', 'parseLikeLegacy'], prim: ['MAX_BYTES', 'MAX_UNSIGNED_BYTES', 'LOOKUP_TIMEOUT_MS'] },
  metaCallbacks: { fn: ['router', 'createRouter', 'verifySignedRequest'] },
  starterTemplates: {
    fn: ['seedStarterTemplates', 'seedRows', 'requeueForAccount', 'listStatuses', 'getCapacity', 'submitQueued', 'submitPending', 'resubmit', 'applyTemplateStatusUpdate', 'pollStatuses', 'loadMerchantContext', 'merchantGraph', 'clientFor', 'kindOf', 'toOnbError', 'getSpec', 'legalKeys', 'buildPlan'],
    obj: ['CAMPAIGN_TYPE', 'STARTER_KEYS'],
    prim: ['TEST_TEMPLATE_KEY', 'MAX_PER_TICK', 'MAX_ATTEMPTS'],
  },
  testTemplate: { fn: ['buildTestTemplate', 'ensureTestTemplate'], obj: ['TEST_TEMPLATE_TITLE'], prim: ['TEST_TEMPLATE_KEY', 'TEST_TEMPLATE_CATEGORY'] },
  testMessage: { fn: ['sendTestMessage', 'numberHash', 'resolveRecipient', 'isOptedOut', 'isOwnerNow'], prim: ['RATE_LIMIT', 'MAX_DISTINCT_NUMBERS'] },
  firstPromotion: { fn: ['getFirstPromotion', 'setFirstPromotionState'], obj: ['STATES'] },
  email: { fn: ['sendNotificationEmail', 'send', 'resolveRecipient', 'sendSupportEmail', 'sendDataDeletionNotice', 'isConfigured', 'isEmail'] },
  emailCopy: { fn: ['render', 'renderSupport', 'esc'], obj: ['KINDS'], prim: ['ARABIC_STATUS', 'FEES_EN', 'FEES_AR'] },
  reminders: { fn: ['runPathBReminders'], obj: ['OFFSETS_MS'], prim: ['MAX_REMINDERS', 'MIN_GAP_MS'] },
  // B0 foundation modules (contract sections 2.1 - 2.15)
  config: {
    fn: ['enabled', 'legacySendPolicy', 'unlockAt', 'strictLock', 'enrolFrom', 'checkoutEnabled', 'billingPortalEnabled', 'acceptTrialing', 'reconcileOnDemand', 'stripeSecretKey', 'stripeWebhookSecrets', 'stripePrices', 'planLabels', 'webhookSignatureMode', 'dropUnknownWaba', 'schedulerIntervalMs', 'starterTemplateKeys', 'templateCeiling', 'supportConfig', 'allowSharedKey', 'platformIds', 'isPlatformAccount', 'frontendUrl', 'appUrl', 'maskPhone', 'safeLog', 'scrub'],
    obj: ['STEP_KEYS', 'STEP_INDEX', 'NEXT_STEPS', 'INDUSTRY_KEYS', 'COUNTRY_CODES', 'LANGUAGES', 'CONNECTED_LIKE', 'DEFAULT_STARTER_KEYS'],
  },
  errors: { fn: ['OnbError', 'isOnbError', 'statusFor', 'fail', 'respond', 'bodyOf'], obj: ['CODES', 'ACCESS_CODES'] },
  metaConfig: {
    fn: ['GRAPH_VERSION', 'GRAPH_BASE', 'EXCHANGE_REDIRECT_URI', 'ES_EXTRAS', 'WABA_FIELDS', 'mapVerification', 'mapNameStatus', 'tierFromRaw', 'META_PAYMENT_HELP_URL', 'META_PAYMENT_SETTINGS_URL', 'META_SECURITY_CENTER_URL', 'META_WHATSAPP_MANAGER_URL', 'APPSECRET_PROOF_ON', 'metaEsAppId', 'metaEsConfigId', 'paymentProbe', 'defaultHttp'],
    obj: ['CONFIDENCE', 'VERIFICATION_MAP', 'NAME_STATUS_MAP', 'NAME_REJECTION_KEYS', 'TIER_MAP', 'HEALTH_MAP', 'MERCHANT_WEBHOOK_FIELDS'],
    prim: ['DEBUG_TOKEN_AUTH', 'PHONE_FIELDS_FULL', 'PHONE_FIELDS_CORE', 'REGISTER_PIN_LENGTH', 'REQUEST_TIMEOUT_MS', 'DISPLAY_NAME_MIN', 'DISPLAY_NAME_MAX', 'DISPLAY_NAME_EDITS_PER_30D'],
  },
  tokenVault: { fn: ['encrypt', 'decrypt', 'isConfigured', 'assertConfigured', 'keyVersion', 'EncryptionNotConfigured', 'DecryptionFailed'], prim: ['PREFIX'] },
  rateLimit: { fn: ['consume', 'middleware', 'createLimiter', 'clear'] },
  analytics: { fn: ['track', 'sanitizeEvent', 'createAnalytics', '_resetMemo', 'funnel'], obj: ['EVENT_TYPES', 'EVENT_STEPS', 'UI_EVENT_TYPES', 'UI_FAIL_CODES', 'CAPS'] },
  notifications: { fn: ['notify', 'retryEmails', 'list', 'markRead', 'unreadCount', 'createNotifications'], obj: ['KINDS', 'SEVERITIES'], prim: ['MAX_EMAIL_ATTEMPTS'] },
  subscription: { fn: ['mapRawStatus', 'effectiveState', 'transitionPatch'], obj: ['STATES', 'SOURCES'] },
  gate: { fn: ['evaluate', 'subscriptionDenial', 'connectionDenial', 'isConnectedLike'], obj: ['SUBSCRIPTION_CODES'] },
  state: {
    fn: ['getGateState', 'buildGateState', 'invalidate', 'clearCache', 'getState', 'ensureState', 'ensureConnection', 'recomputeSubscription', 'enrol', 'unenrol', 'unenrolAll', 'adminActivate', 'adminDeactivate', 'autoEnrolIfEligible', 'getOldestWorkspace'],
    prim: ['POSITIVE_TTL_MS', 'NEGATIVE_TTL_MS', 'STALE_MAX_MS'],
  },
  sendRoutes: { fn: ['match', 'pathOf'], obj: ['ROUTES'] },
  sendGate: { fn: ['checkSending', 'assertSendingAllowed', 'flowBlocked'] },
  httpGuard: { fn: ['middleware', 'createHttpGuard'] },
  requireOnboardingAccess: { fn: ['requireOnboardingAccess'] },
  earlyMounts: { fn: ['mount'] },
  mount: { fn: ['mount'] },
  // added by the review fixes (BF2)
  failOpen: { fn: ['withTimeout', 'logFailOpen', '_resetLog'], prim: ['TIMEOUT_MS', 'LOG_EVERY_MS'] },
  dataDeletion: { fn: ['listRequests', 'markProcessed'], obj: ['CODE_RE'] },
  indexCheck: { fn: ['inspect', 'create', 'keyString', 'declaredOf'], obj: ['MODEL_NAMES'] },
};

const ROUTERS = ['state', 'business', 'number', 'prompts', 'billing', 'connect', 'connection', 'approvals', 'templates', 'test', 'notifications', 'events'];

/** test.each that tolerates an empty list (jest throws on an empty table). */
function eachName(names, title, fn) {
  if (names && names.length) test.each(names)(title, fn);
}
const kindOf = (v) => (typeof v === 'function' ? FN : (v !== null && typeof v === 'object' ? OBJ : PRIM));

describe.each(Object.entries(SHARED))('shared/onboarding/%s export contract', (mod, spec) => {
  const m = require(`../../../shared/onboarding/${mod}`);
  eachName(spec.fn, '%s is a function / class', (name) => {
    expect(typeof m[name]).toBe('function');
  });
  eachName(spec.obj, '%s is a constant object / array', (name) => {
    expect(kindOf(m[name])).toBe(OBJ);
  });
  eachName(spec.prim, '%s is a primitive constant', (name) => {
    expect(m[name]).toBeDefined();
    expect(kindOf(m[name])).toBe(PRIM);
  });
  test('the module is not a stub: no export is the NOT_IMPLEMENTED thrower', () => {
    for (const name of spec.fn || []) {
      if (typeof m[name] === 'function') expect(String(m[name])).not.toMatch(/notImplementedStub/);
    }
  });
});

describe('routes/onboarding sub-routers', () => {
  test.each(ROUTERS)('routes/onboarding/%s exports a Router, createRouter(deps) and the Router it builds', (name) => {
    const r = require(`../../../routes/onboarding/${name}`);
    expect(typeof r).toBe('function');
    expect(typeof r.createRouter).toBe('function');
    expect(typeof r.createRouter({})).toBe('function');
  });
  test('routes/onboarding/index exports the lazy Router, createRouter, SUBROUTERS, gateFor and _reset', () => {
    const idx = require('../../../routes/onboarding');
    expect(typeof idx).toBe('function');
    expect(typeof idx.createRouter).toBe('function');
    expect(typeof idx.gateFor).toBe('function');
    expect(typeof idx._reset).toBe('function');
    expect(idx.SUBROUTERS).toBeDefined();
  });
  test('sub-router additions: number (interpretAnswer, sameAnswer), connection (fallbackSnapshot, levelOf), events (buildEvent)', () => {
    const number = require('../../../routes/onboarding/number');
    expect(typeof number.interpretAnswer).toBe('function');
    expect(typeof number.sameAnswer).toBe('function');
    expect(typeof number.REMOVAL_WAIT_MINUTES).toBe('number');
    const connection = require('../../../routes/onboarding/connection');
    expect(typeof connection.fallbackSnapshot).toBe('function');
    expect(typeof connection.levelOf).toBe('function');
    expect(typeof require('../../../routes/onboarding/events').buildEvent).toBe('function');
  });
  test('routes/adminOnboarding exports a Router, createRouter, esc and OLDEST_MARK', () => {
    const r = require('../../../routes/adminOnboarding');
    expect(typeof r).toBe('function');
    expect(typeof r.createRouter).toBe('function');
    expect(typeof r.esc).toBe('function');
    expect(r.OLDEST_MARK).toBeDefined();
    expect(typeof r.createRouter({})).toBe('function');
  });
});

describe('scripts/onboarding-admin.js (CLI) export contract', () => {
  const cli = require('../../../scripts/onboarding-admin');
  test.each(['parseArgs', 'run', 'UsageError', 'buildDeps', 'main', 'redact'])('%s is a function / class', (name) => {
    expect(typeof cli[name]).toBe('function');
  });
  test('USAGE and OLDEST_MARK are constants', () => {
    expect(typeof cli.USAGE).toBe('string');
    expect(cli.OLDEST_MARK).toBeDefined();
  });
});

describe('models', () => {
  test.each(['OnboardingState', 'WhatsAppConnection', 'OnboardingEvent', 'OnboardingSupportRequest', 'OnboardingNotification', 'OnboardingTemplate', 'WhatsAppClaim', 'OnboardingInbound', 'OnboardingAdminLog'])('models/%s is a mongoose model', (name) => {
    const model = require(`../../../models/${name}`);
    expect(typeof model).toBe('function');
    expect(model.modelName).toBe(name);
    expect(model.schema).toBeDefined();
  });
});
