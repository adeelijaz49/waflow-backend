'use strict';
const { assertThrowawayDb } = require('./_guard');
assertThrowawayDb();
process.env.MONGODB_URI = `${process.env.MONGODB_URI}_e2eappr`;
assertThrowawayDb();

// END TO END (task I1b): step 4 (approvals + starter templates) with Meta's statuses flipped through the fake, the
// unlock point, and the Arabic-preferring owner. REAL server.js, signed Meta webhooks, the real scheduler sweep.
const { createWorld, spyConsole } = require('./_e2eWorld');

jest.setTimeout(120000);

let w;
let con;
const stateOf = async (t) => (await w.get(t.owner, '/state')).body;

beforeAll(async () => { w = await createWorld({ policy: 'block' }); con = spyConsole(); });
afterAll(async () => { con.restore(); await w.handle.stop(); });

describe('F) step 4 with Meta statuses flipped through the fake (nothing blocks, everything is visible)', () => {
  const rateLimit = require('../../../shared/onboarding/rateLimit');
  const starter = require('../../../shared/onboarding/starterTemplates');
  let t;
  let ctx;
  const rows = async () => (await w.get(t.owner, '/approvals')).body;
  const row = (a, key) => a.rows.find((r) => r.key === key);
  const refresh = async () => { rateLimit.clear(); return w.post(t.owner, '/connection/refresh', {}); };
  const kinds = async () => (await w.get(t.owner, '/notifications')).body.notifications.map((n) => n.kind);
  // the e-mails the owner received (the provider is the fake behind the real e-mail module; sending is asynchronous, so settle first)
  const mailsOf = (tenant) => w.mail.sent.filter((m) => m.to === tenant.owner.email).map((m) => m.subject);
  const settleMail = () => new Promise((r) => { setTimeout(r, 400); });
  beforeAll(async () => {
    t = await w.tenant('Approvals');
    ctx = await w.connectTenant(t, { phoneStatus: 'PENDING', verificationStatus: 'not_verified', nameStatus: 'PENDING_REVIEW', tier: 'TIER_50', health: 'LIMITED' });
  });

  test('right after connecting: waiting on Meta is visible and non-blocking, the prompts are already offered', async () => {
    const a = await rows();
    expect(a.overall).toBe('needs_you');
    expect(a.rows.map((r) => [r.key, r.status])).toEqual([['verification', 'needs_you'], ['displayName', 'waiting'], ['payment', 'needs_you'], ['messagingLimit', 'done'], ['templates', 'waiting']]);
    expect(row(a, 'messagingLimit')).toMatchObject({ tierNumber: 50, raw: 'TIER_50' });
    expect(a.rows.every((r) => r.blocking === false && r.links.securityCenter.startsWith('https://') && r.links.paymentHelp.startsWith('https://'))).toBe(true);
    const s = await stateOf(t);
    expect(s).toMatchObject({ nextStep: 'customers', locked: false, connection: { level: 'needs_attention', causeCode: 'HEALTH_LIMITED', causePath: '/setup/approvals' }, steps: { connect: { status: 'done' }, approvals: { status: 'in_progress' } } });
  });

  test('Meta moves on: the refresh turns verification, name and limit into ONE notification each and the connection back to healthy', async () => {
    ctx.graph.setVerification('verified');
    ctx.graph.setNameStatus('APPROVED');
    ctx.graph.setHealth('AVAILABLE');
    ctx.graph.setTier('TIER_1K');
    const r = await refresh();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ level: 'connected', causeCode: null });
    const a = await rows();
    expect([row(a, 'verification').status, row(a, 'displayName').status, row(a, 'messagingLimit').tierNumber]).toEqual(['done', 'done', 1000]);
    const ks = await kinds();
    for (const k of ['verification_changed', 'display_name_decided', 'messaging_limit_changed']) expect([k, ks.filter((x) => x === k).length]).toEqual([k, 1]);
    await refresh(); // nothing changed: no duplicate notification
    expect((await kinds()).filter((x) => x === 'verification_changed')).toHaveLength(1);
    expect((await stateOf(t)).connection.level).toBe('connected');
    // spec Step 4: "an email and an in-app notification when anything changes": exactly one e-mail per change, none for the repeat refresh
    await settleMail();
    const mails = mailsOf(t);
    for (const subject of ['Your business verification was updated', 'Meta decided on your display name', 'Your messaging limit changed']) expect([subject, mails.filter((x) => x === subject).length]).toEqual([subject, 1]);
    expect(mails).not.toContain('A WhatsApp account alert'); // the health recovered: nothing needs the merchant any more
  });

  test('payment is a self-attestation (Meta has no API to read it); templates arrive by signed webhook; a rejected one can be resubmitted', async () => {
    expect(row(await rows(), 'payment')).toMatchObject({ status: 'needs_you', value: 'unknown' });
    expect((await w.post(t.owner, '/approvals/payment-confirmed', { confirmed: true })).status).toBe(200);
    expect((await w.post(t.owner, '/approvals/payment-confirmed', { confirmed: false })).status).toBe(422);
    expect(row(await rows(), 'payment')).toMatchObject({ status: 'done', value: 'merchant_confirmed' });
    for (let i = 0; i < 3; i += 1) await starter.submitPending({ workspaceId: t.ws });
    for (const tpl of ctx.graph.templates().filter((x) => x.language === 'en')) {
      const bad = tpl.name.includes('booking_confirmation');
      ctx.graph.setTemplateStatus(tpl.name, 'en', bad ? 'REJECTED' : 'APPROVED', 'INVALID_FORMAT');
      expect((await w.deliverMeta(ctx.graph.webhook.templateStatus(tpl.name, 'en', bad ? 'REJECTED' : 'APPROVED', 'INVALID_FORMAT'))).status).toBe(200);
    }
    const a = await rows();
    expect(row(a, 'templates')).toMatchObject({ status: 'needs_you', value: '6/7', rejectedReason: 'INVALID_FORMAT', counts: { approved: 6, total: 7, problem: 1 } });
    const list = (await w.get(t.owner, '/templates')).body.templates.find((x) => x.key === 'booking_confirmation' && x.language === 'en');
    expect(list).toMatchObject({ status: 'rejected', canResubmit: true, revision: 1 });
    const again = await w.post(t.owner, '/templates/booking_confirmation/en/resubmit', {});
    expect(again.status).toBe(200);
    expect(again.body.template).toMatchObject({ status: 'pending', revision: 2 });
    const v2 = ctx.graph.templates().find((x) => x.name.endsWith('booking_confirmation_en_v2'));
    expect(v2).toBeTruthy();
    ctx.graph.setTemplateStatus(v2.name, 'en', 'APPROVED');
    await w.deliverMeta(ctx.graph.webhook.templateStatus(v2.name, 'en', 'APPROVED'));
    const done = await rows();
    expect(done.overall).toBe('done');
    expect((await stateOf(t)).steps.approvals.status).toBe('done'); // every row done completes step 4
    // the approvals are COALESCED: 7 per-template notifications in the app, but only the two milestone mails (+ the rejection)
    await settleMail();
    const mails = mailsOf(t);
    expect(mails.filter((x) => x === 'Your first message template was approved')).toHaveLength(1);
    expect(mails.filter((x) => x === 'Your starter message templates are approved')).toHaveLength(1);
    expect(mails.filter((x) => x === 'A message template was rejected')).toHaveLength(1);
    expect(mails.filter((x) => x === 'A message template was approved')).toHaveLength(0); // never one mail per template
    const approvedRows = await w.M('OnboardingNotification').find({ workspaceId: t.ws, kind: 'template_approved' }).lean();
    expect(approvedRows).toHaveLength(9); // 7 per-template notifications (6 + the resubmitted booking_confirmation) + the 2 milestones
    expect(approvedRows.filter((n) => /^templates:/.test(n.dedupeKey)).map((n) => n.dedupeKey).sort()).toEqual(['templates:all_approved', 'templates:first_approved']);
    expect(approvedRows.filter((n) => /^template:/.test(n.dedupeKey) && n.emailAttempts > 0)).toHaveLength(0);
    const first = w.mail.sent.find((m) => m.to === t.owner.email && m.subject === 'Your first message template was approved');
    expect(first.text).toContain('Approved: 1 of 7');
    w.mail.fake.assertNoLeak(['Weekend offer', 'Welcome and opt-in', ctx.graph.ids.merchantToken]);
  });

  test('a display-name change is "waiting" and cannot be edited meanwhile; the approval flips it and the PIN stored at connect re-registers the number', async () => {
    const dn = await w.post(t.owner, '/display-name', { newName: 'Approvals Official' });
    expect(dn.status).toBe(200);
    expect(dn.body.displayName).toMatchObject({ value: 'Approvals Official', status: 'waiting', editsRemaining: 9 });
    expect(row(await rows(), 'displayName')).toMatchObject({ status: 'waiting', canEdit: false, editsRemaining: 9 });
    expect((await w.post(t.member, '/display-name', { newName: 'Member Tries' })).status).toBe(403);
    ctx.graph.approveDisplayName();
    await w.deliverMeta(ctx.graph.webhook.envelope('phone_number_name_update', { decision: 'APPROVED', requested_verified_name: 'Approvals Official' }, ctx.graph.ids.wabaId));
    expect(row(await rows(), 'displayName')).toMatchObject({ status: 'done', value: 'Approvals Official', canEdit: true });
    const registered = ctx.graph.callsTo('register').length;
    const scheduler = require('../../../shared/onboarding/scheduler');
    const sweep = await scheduler.runOnboardingSweep(scheduler.realDeps());
    expect(sweep.displayName).toMatchObject({ registered: 1, failed: 0 });
    const regs = ctx.graph.callsTo('register');
    expect(regs.length).toBe(registered + 1);
    expect(regs[regs.length - 1].data.pin).toBe(regs[0].data.pin); // the same PIN, decrypted from the vault, only ever sent to Graph
    expect(regs[regs.length - 1].token).toBe(ctx.graph.ids.merchantToken);
    expect(await w.M('WhatsAppConnection').countDocuments({ workspaceId: t.ws, 'displayName.newName': { $exists: true } })).toBe(0);
  });

  test('Meta blocks the account: the connection needs attention with a cause (never silent); it clears when Meta clears it', async () => {
    ctx.graph.setHealth('BLOCKED');
    const r = await refresh();
    expect(r.body.level).toBe('needs_attention');
    expect(r.body.causeCode).toEqual(expect.stringMatching(/^HEALTH_/));
    expect((await stateOf(t)).connection).toMatchObject({ level: 'needs_attention', causePath: expect.any(String) });
    // needs action: an e-mail too, once
    await settleMail();
    expect(mailsOf(t).filter((x) => x === 'A WhatsApp account alert')).toHaveLength(1);
    ctx.graph.setHealth('AVAILABLE');
    expect((await refresh()).body.level).toBe('connected');
    await refresh();
    await settleMail();
    expect(mailsOf(t).filter((x) => x === 'A WhatsApp account alert')).toHaveLength(1);
  });

  test('a failing e-mail provider never blocks the state change: the notification exists, the scheduler retries the mail and it is delivered exactly once', async () => {
    const subject = 'Your business verification was updated';
    const before = mailsOf(t).filter((x) => x === subject).length;
    w.mail.failNext(1);
    ctx.graph.setVerification('rejected');
    expect((await refresh()).status).toBe(200);
    expect(row(await rows(), 'verification')).toMatchObject({ status: 'needs_you' }); // the state changed although the mail failed
    await settleMail();
    expect(mailsOf(t).filter((x) => x === subject)).toHaveLength(before); // not delivered yet
    const Notification = w.M('OnboardingNotification');
    // the key carries an epoch since R7-04 (a recurring condition is announced again): find the notification by what it says
    const stuck = await Notification.findOne({ workspaceId: t.ws, kind: 'verification_changed', 'params.status': 'needs_you' }).lean();
    expect(stuck).toMatchObject({ kind: 'verification_changed', emailAttempts: 1 });
    expect(stuck.emailError).toBeTruthy();
    expect(stuck.emailSentAt).toBeFalsy();
    expect((await kinds()).filter((k) => k === 'verification_changed')).toHaveLength(2); // the in-app notifications (done, then needs_you) are there
    const scheduler = require('../../../shared/onboarding/scheduler');
    const sweep = await scheduler.runOnboardingSweep(scheduler.realDeps());
    expect(sweep.emails).toMatchObject({ attempted: expect.any(Number), sent: expect.any(Number) });
    await settleMail();
    expect(mailsOf(t).filter((x) => x === subject)).toHaveLength(before + 1);
    const delivered = await Notification.findOne({ workspaceId: t.ws, kind: 'verification_changed', 'params.status': 'needs_you' }).lean();
    expect(delivered.emailSentAt).toBeTruthy();
    expect(delivered.emailAttempts).toBe(2); // the first try failed, the retry delivered
    await scheduler.runOnboardingSweep(scheduler.realDeps());
    await settleMail();
    expect(mailsOf(t).filter((x) => x === subject)).toHaveLength(before + 1); // never twice
  });
});

describe('G) ONBOARDING_UNLOCK_AT=finished keeps the app locked until the whole setup is finished', () => {
  afterAll(() => { delete process.env.ONBOARDING_UNLOCK_AT; w.state.clearCache(); });
  test('connected but not finished: still locked; finished: unlocked', async () => {
    process.env.ONBOARDING_UNLOCK_AT = 'finished';
    w.state.clearCache();
    const t = await w.tenant('UnlockFinished');
    await w.connectTenant(t);
    expect(await stateOf(t)).toMatchObject({ locked: true, unlockAt: 'finished', connection: { level: 'connected' } });
    await w.get(t.owner, '/approvals');
    await w.post(t.owner, '/prompts/customers', { state: 'skipped' });
    await w.post(t.owner, '/prompts/products', { state: 'skipped' });
    await w.post(t.owner, '/first-promotion/state', { state: 'skipped' });
    expect(await stateOf(t)).toMatchObject({ locked: false, view: 'done' });
  });
});

describe('H) an Arabic-preferring owner gets Arabic template variants (the legal-sensitive one stays English) and Arabic e-mails', () => {
  test('languages ar+en: Arabic rows are queued and submitted as "ar"; welcome_optin stays English-only; the reconnect e-mail is Arabic RTL', async () => {
    const t = await w.tenant('Arabic Owner');
    const b = await w.put(t.owner, '/business', w.BUSINESS(t, { uiLanguage: 'ar', languages: ['ar', 'en'] }));
    expect(b.body.business).toMatchObject({ uiLanguage: 'ar', languages: ['ar', 'en'] });
    const ctx = await w.connectTenant(t);
    const list = (await w.get(t.owner, '/templates')).body;
    expect(list.capacity.arabicRequested).toBe(true);
    expect(list.templates.find((x) => x.key === 'welcome_optin' && x.language === 'ar')).toMatchObject({ status: 'blocked', blockedReason: 'legal' });
    expect(list.templates.find((x) => x.key === 'promotion_weekend' && x.language === 'ar').status).toBe('queued');
    for (let i = 0; i < 4; i += 1) await require('../../../shared/onboarding/starterTemplates').submitPending({ workspaceId: t.ws });
    const made = ctx.graph.templates();
    expect(made.some((x) => x.language === 'ar' && x.name.includes('promotion_weekend'))).toBe(true);
    expect(made.some((x) => x.language === 'ar' && x.name.includes('welcome_optin'))).toBe(false);
    w.mail.reset();
    ctx.graph.scenarios.token190();
    require('../../../shared/onboarding/rateLimit').clear();
    await w.post(t.owner, '/connection/refresh', {});
    await new Promise((r) => setTimeout(r, 300));
    const mail = w.mail.sent.find((m) => m.to === t.owner.email);
    expect(mail).toBeTruthy();
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.html).toMatch(/[\u{0600}-\u{06FF}]/u);
  });
});

describe('I1b regression: looking at the approvals BEFORE connecting must not skip step 4', () => {
  test('a view before step 3 leaves step 4 untouched; after connecting the checklist still offers the approvals once', async () => {
    const t = await w.tenant('EarlyApprovals');
    await w.put(t.owner, '/business', w.BUSINESS(t));
    await w.post(t.owner, '/number/path', { hasNumber: true, usage: 'unused' });
    const early = await w.get(t.owner, '/approvals');
    expect(early.status).toBe(200);
    expect(early.body.level).toBe('not_connected');
    expect((await stateOf(t)).steps.approvals.status).toBe('todo');
    expect((await stateOf(t)).nextStep).toBe('connect');
    const ctx = await w.prepareConnect(t);
    expect((await w.complete(t, ctx)).body.nextStep).toBe('approvals');
    expect((await stateOf(t)).nextStep).toBe('approvals'); // the connect answer and /state agree
    await w.get(t.owner, '/approvals');
    expect((await stateOf(t))).toMatchObject({ steps: { approvals: { status: 'in_progress' } }, nextStep: 'customers' });
  });
});
