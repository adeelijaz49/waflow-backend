'use strict';
// Schema-level checks only (no database connection): field names, select:false,
// string _ids, the exact index list and the unique indexes of DB design section 2.
const mongoose = require('mongoose');

const names = ['OnboardingState', 'WhatsAppConnection', 'OnboardingEvent', 'OnboardingSupportRequest', 'OnboardingNotification', 'OnboardingTemplate', 'WhatsAppClaim', 'OnboardingInbound', 'OnboardingAdminLog'];
const models = {};
beforeAll(() => { for (const n of names) models[n] = require(`../../../models/${n}`); });

async function check(doc) { try { await doc.validate(); return undefined; } catch (e) { return e; } }
const idx = (n) => models[n].schema.indexes().map(([fields, opts]) => ({ fields, unique: !!(opts && opts.unique) }));
const paths = (n) => Object.keys(models[n].schema.paths);

describe('registration', () => {
  test('nine models, registered under their file names, nothing connected', () => {
    for (const n of names) expect(mongoose.modelNames()).toContain(n);
    expect(mongoose.connection.readyState).toBe(0);
  });
  test('collection names are the new ones (no existing collection reused)', () => {
    const existing = ['workspaces', 'users', 'memberships', 'settings', 'subscriptions', 'supporttickets', 'customers'];
    for (const n of names) expect(existing).not.toContain(models[n].collection.collectionName);
    expect(models.OnboardingState.collection.collectionName).toBe('onboardingstates');
  });
});

describe('secrets', () => {
  test('tokenEncrypted and pinEncrypted are select:false', () => {
    const s = models.WhatsAppConnection.schema;
    expect(s.path('tokenEncrypted').options.select).toBe(false);
    expect(s.path('pinEncrypted').options.select).toBe(false);
  });
  test('no other model stores a token or pin', () => {
    for (const n of names.filter((x) => x !== 'WhatsAppConnection')) {
      expect(paths(n).filter((p) => /token|pin|secret|password/i.test(p))).toEqual([]);
    }
  });
});

describe('field names verbatim from DB section 2', () => {
  test('OnboardingState', () => {
    const p = paths('OnboardingState');
    for (const f of ['workspaceId', 'enrolled', 'enrolledAt', 'enrolledVia', 'enrolledBy', 'unenrolledAt', 'unenrolledBy', 'r1Applied', 'schemaVersion',
      'subscription.state', 'subscription.source', 'subscription.stripe.customerId', 'subscription.stripe.subscriptionId', 'subscription.stripe.status',
      'subscription.stripe.priceId', 'subscription.stripe.planCode', 'subscription.stripe.currentPeriodEnd', 'subscription.stripe.cancelAtPeriodEnd',
      'subscription.stripe.lastEventId', 'subscription.stripe.lastEventCreated', 'subscription.stripe.lastSyncedAt', 'subscription.stripe.checkoutSessionId',
      'subscription.stripe.checkoutStartedAt', 'subscription.stripe.lastPaymentFailedAt', 'subscription.stripe.lastPaymentFailureCode', 'subscription.stripe.hasDefaultPaymentMethod',
      'subscription.admin.active', 'subscription.admin.by', 'subscription.admin.at', 'subscription.admin.notes',
      'subscription.activatedAt', 'subscription.pastDueAt', 'subscription.cancelledAt', 'subscription.changedAt',
      'prefill.businessName', 'prefill.email', 'prefill.planCode', 'prefill.source', 'prefill.capturedAt',
      'progress.currentStep', 'progress.furthestStep', 'progress.startedAt', 'progress.lastActivityAt', 'progress.completedAt', 'progress.status',
      'steps.business.status', 'steps.number.status', 'steps.connect.status', 'steps.approvals.status', 'steps.promotion.status', 'steps.connect.enteredAt', 'steps.connect.completedAt', 'steps.connect.attempts',
      'business.name', 'business.country', 'business.industry', 'business.website', 'business.instagram', 'business.crNumber', 'business.crSkipped', 'business.crSkippedAt',
      'business.verificationNeedsCr', 'business.contactEmail', 'business.uiLanguage', 'business.languages',
      'number.path', 'number.hasNumber', 'number.usage', 'number.usageAnsweredAt', 'number.personalWarningAcknowledged', 'number.businessAppChoice', 'number.numberReady',
      'number.pausedAt', 'number.reminderCount', 'number.lastReminderAt', 'number.helpRequestedAt', 'number.helpRequestId',
      'prompts.customers.state', 'prompts.customers.updatedAt', 'prompts.products.state', 'prompts.promptedAt',
      'firstPromotion.state', 'firstPromotion.suggestedKey', 'firstPromotion.testMessageCount', 'firstPromotion.lastTestAt', 'firstPromotion.testPhoneMasked', 'firstPromotion.startedAt', 'firstPromotion.doneAt',
      'lastError.code', 'lastError.step', 'lastError.at', 'ui.seenNotificationsAt', 'createdAt', 'updatedAt']) {
      expect(p).toContain(f);
    }
  });
  test('WhatsAppConnection', () => {
    const p = paths('WhatsAppConnection');
    for (const f of ['workspaceId', 'status', 'ids.wabaId', 'ids.phoneNumberId', 'ids.businessId', 'ids.wabaSource', 'ids.onboardingEvent', 'ids.platformType', 'ids.isOnBizApp', 'ids.metaUserId',
      'display.displayPhoneNumber', 'display.last4', 'display.verifiedName', 'tokenEncrypted', 'tokenKeyVersion', 'tokenExpiresAt', 'tokenDataAccessExpiresAt', 'tokenIsValid', 'tokenCheckedAt', 'pinEncrypted',
      'registration.registeredAt', 'registration.attempts', 'registration.lastErrorCode', 'webhook.subscribed', 'webhook.subscribedAt', 'webhook.checkedAt',
      'verification.businessRaw', 'verification.mapped', 'verification.checkedAt',
      'displayName.requested', 'displayName.nameStatusRaw', 'displayName.newName', 'displayName.newNameStatusRaw', 'displayName.decision', 'displayName.rejectionReason', 'displayName.mapped', 'displayName.checkedAt', 'displayName.editsLast30d',
      'payment.status', 'payment.confirmedAt', 'payment.probeFundingIdPresent', 'payment.checkedAt',
      'messagingLimit.raw', 'messagingLimit.tierNumber', 'messagingLimit.checkedAt', 'messagingLimit.lastEventAt', 'quality.ratingRaw', 'quality.checkedAt',
      'health.canSend', 'health.issues', 'health.checkedAt', 'needsReconnect', 'reconnectReason', 'lastStatusCheckAt', 'nextCheckAt', 'checkFailures',
      'lastError.code', 'lastError.subcode', 'lastError.kind', 'lastError.at',
      'connectAttempt.id', 'connectAttempt.createdAt', 'connectAttempt.expectWabaId', 'connectAttempt.usedAt', 'connectAttempt.codeHash', 'connectAttempt.result', 'connectLockUntil',
      'connectSteps.exchange.status', 'connectSteps.debugToken.status', 'connectSteps.phone.status', 'connectSteps.register.status', 'connectSteps.subscribe.status', 'connectSteps.details.status',
      'connectSteps.exchange.at', 'connectSteps.exchange.errorCode',
      'connectedAt', 'connectedByUserId', 'disconnectedAt', 'disconnectedByUserId', 'createdAt', 'updatedAt']) {
      expect(p).toContain(f);
    }
  });
  test('the raw connect code is never a field (only its hash)', () => {
    expect(paths('WhatsAppConnection').filter((p) => /code/i.test(p))).toEqual(expect.arrayContaining(['connectAttempt.codeHash']));
    expect(paths('WhatsAppConnection')).not.toContain('connectAttempt.code');
  });
  test('the small models', () => {
    expect(paths('OnboardingEvent')).toEqual(expect.arrayContaining(['workspaceId', 'type', 'step', 'code', 'reason', 'durationMs', 'meta', 'at']));
    expect(paths('OnboardingSupportRequest')).toEqual(expect.arrayContaining(['workspaceId', 'userId', 'kind', 'step', 'lastErrorCode', 'message', 'businessName', 'contactEmail', 'status', 'emailSentAt', 'emailError', 'handledBy', 'handledAt']));
    expect(paths('OnboardingNotification')).toEqual(expect.arrayContaining(['workspaceId', 'dedupeKey', 'kind', 'severity', 'titleKey', 'bodyKey', 'params', 'actionPath', 'createdAt', 'readAt', 'emailSentAt', 'emailAttempts', 'emailError']));
    expect(paths('OnboardingTemplate')).toEqual(expect.arrayContaining(['workspaceId', 'key', 'language', 'revision', 'metaTemplateName', 'metaTemplateId', 'category', 'metaStatus', 'metaStatusRaw', 'rejectedReason', 'rejectionRecommendation', 'qualityScore', 'submittedAt', 'submitClaimedAt', 'attempts', 'lastCheckedAt', 'lastErrorCode', 'source', 'blockedReason']));
    expect(paths('WhatsAppClaim')).toEqual(expect.arrayContaining(['_id', 'workspaceId', 'claimedAt', 'releasedAt']));
    expect(paths('OnboardingInbound')).toEqual(expect.arrayContaining(['_id', 'source', 'type', 'workspaceId', 'status', 'attempts', 'outcome', 'startedAt', 'finishedAt', 'errorCode']));
    expect(paths('OnboardingAdminLog')).toEqual(expect.arrayContaining(['workspaceId', 'action', 'adminUser', 'notes', 'ip', 'before', 'after']));
  });
});

describe('string _ids', () => {
  test('WhatsAppClaim and OnboardingInbound use String _id', () => {
    expect(models.WhatsAppClaim.schema.path('_id').instance).toBe('String');
    expect(models.OnboardingInbound.schema.path('_id').instance).toBe('String');
    expect(models.OnboardingState.schema.path('_id').instance).toBe('ObjectId');
  });
});

describe('indexes: exactly the listed ones, unique only where listed', () => {
  const sortByJson = (a) => a.slice().sort((x, y) => JSON.stringify(x.fields).localeCompare(JSON.stringify(y.fields)));
  test('OnboardingState', () => {
    expect(sortByJson(idx('OnboardingState'))).toEqual(sortByJson([
      { fields: { workspaceId: 1 }, unique: true },
      { fields: { 'subscription.stripe.subscriptionId': 1 }, unique: false },
      { fields: { 'subscription.stripe.customerId': 1 }, unique: false },
      { fields: { 'progress.status': 1 }, unique: false },
    ]));
  });
  test('WhatsAppConnection', () => {
    expect(sortByJson(idx('WhatsAppConnection'))).toEqual(sortByJson([
      { fields: { workspaceId: 1 }, unique: true },
      { fields: { 'ids.wabaId': 1 }, unique: false },
      { fields: { 'ids.phoneNumberId': 1 }, unique: false },
      { fields: { nextCheckAt: 1 }, unique: false },
    ]));
  });
  test('OnboardingEvent', () => {
    expect(sortByJson(idx('OnboardingEvent'))).toEqual(sortByJson([
      { fields: { workspaceId: 1, at: -1 }, unique: false },
      { fields: { type: 1, code: 1 }, unique: false },
      { fields: { type: 1, step: 1 }, unique: false },
    ]));
  });
  test('OnboardingSupportRequest', () => {
    expect(sortByJson(idx('OnboardingSupportRequest'))).toEqual(sortByJson([
      { fields: { workspaceId: 1, createdAt: -1 }, unique: false },
      { fields: { status: 1, createdAt: -1 }, unique: false },
      // review R7-05: one request per workspace, kind and 10-minute window (the atomic de-duplication), on this NEW collection only
      { fields: { workspaceId: 1, kind: 1, windowKey: 1 }, unique: true },
    ]));
  });
  test('OnboardingNotification', () => {
    expect(sortByJson(idx('OnboardingNotification'))).toEqual(sortByJson([
      { fields: { workspaceId: 1, dedupeKey: 1 }, unique: true },
      { fields: { workspaceId: 1, createdAt: -1 }, unique: false },
    ]));
  });
  test('OnboardingTemplate', () => {
    expect(sortByJson(idx('OnboardingTemplate'))).toEqual(sortByJson([
      { fields: { workspaceId: 1, key: 1, language: 1 }, unique: true },
      { fields: { workspaceId: 1, metaTemplateId: 1 }, unique: false },
      { fields: { workspaceId: 1, metaTemplateName: 1 }, unique: false },
    ]));
  });
  test('WhatsAppClaim has ZERO extra indexes (the _id is the uniqueness)', () => {
    expect(idx('WhatsAppClaim')).toEqual([]);
  });
  test('OnboardingInbound', () => {
    expect(idx('OnboardingInbound')).toEqual([{ fields: { status: 1 }, unique: false }]);
  });
  test('OnboardingAdminLog (same pair as LocalizationAdminLog)', () => {
    expect(sortByJson(idx('OnboardingAdminLog'))).toEqual(sortByJson([
      { fields: { workspaceId: 1, createdAt: -1 }, unique: false },
      { fields: { createdAt: -1 }, unique: false },
    ]));
  });
  test('no TTL, no partial, no sparse, no text indexes anywhere (Cosmos)', () => {
    for (const n of names) {
      for (const [fields, opts] of models[n].schema.indexes()) {
        expect(opts && (opts.expireAfterSeconds !== undefined || opts.partialFilterExpression || opts.sparse)).toBeFalsy();
        expect(Object.values(fields)).not.toContain('text');
      }
    }
  });
  test('no model declares an inline index/unique on a field', () => {
    for (const n of names) {
      for (const p of Object.values(models[n].schema.paths)) {
        expect(p.options.index).toBeFalsy();
        if (p.options.unique) throw new Error(`${n}.${p.path} declares an inline unique index`);
      }
    }
  });
});

describe('defaults and tolerance', () => {
  test('OnboardingState defaults', async () => {
    const d = new models.OnboardingState({ workspaceId: new mongoose.Types.ObjectId() });
    expect(d.enrolled).toBe(true);
    expect(d.subscription.state).toBe('none');
    expect(d.subscription.admin.active).toBe(false);
    expect(d.progress.currentStep).toBe(1);
    expect(d.progress.status).toBe('in_progress');
    expect(d.steps.business.status).toBe('todo');
    expect(d.business.country).toBe('SA');
    expect(d.business.uiLanguage).toBe('en');
    expect(d.prompts.customers.state).toBe('pending');
    expect(d.firstPromotion.state).toBe('locked');
    expect(d.number.personalWarningAcknowledged).toBe(false);
    expect(await check(d)).toBeUndefined();
  });
  test('workspaceId is required', async () => {
    expect((await check(new models.OnboardingState({}))).errors.workspaceId).toBeDefined();
    expect((await check(new models.WhatsAppConnection({}))).errors.workspaceId).toBeDefined();
  });
  test('enums are validated on write but unknown values read back unchanged (tolerant on read)', async () => {
    expect((await check(new models.WhatsAppConnection({ workspaceId: new mongoose.Types.ObjectId(), status: 'something_new' }))).errors.status).toBeDefined();
    const doc = models.WhatsAppConnection.hydrate({ _id: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId(), status: 'something_new', payment: { status: 'brand_new' } });
    expect(doc.status).toBe('something_new');
    expect(doc.payment.status).toBe('brand_new');
    const sub = models.OnboardingState.hydrate({ _id: new mongoose.Types.ObjectId(), workspaceId: new mongoose.Types.ObjectId(), subscription: { state: 'paused_by_stripe' } });
    expect(sub.subscription.state).toBe('paused_by_stripe');
  });
  test('WhatsAppConnection defaults: not_connected, no reconnect, unknown payment', () => {
    const d = new models.WhatsAppConnection({ workspaceId: new mongoose.Types.ObjectId() });
    expect(d.status).toBe('not_connected');
    expect(d.needsReconnect).toBe(false);
    expect(d.payment.status).toBe('unknown');
    expect(d.tokenEncrypted).toBeUndefined();
  });
  test('support message is capped at 500 characters', async () => {
    const d = new models.OnboardingSupportRequest({ workspaceId: new mongoose.Types.ObjectId(), kind: 'help', message: 'x'.repeat(501) });
    expect((await check(d)).errors.message).toBeDefined();
  });
  test('claims accept string ids', async () => {
    const d = new models.WhatsAppClaim({ _id: 'waba:123', workspaceId: new mongoose.Types.ObjectId() });
    expect(await check(d)).toBeUndefined();
    expect(d._id).toBe('waba:123');
  });
});
