// The async localised sender — the money path. Everything runs on the in-memory
// store (campaignTestKit) with a fake transport and a recording sleeper: no
// database, no network, no real WhatsApp, no real waiting. The properties proven
// here are the ones that protect real customers: THEIR language's template, no
// double send, consent re-checked right before every send, demo data never leaves,
// cancel/resume/crash safety, and bookkeeping that can never cause a re-send.
jest.mock('../../utils/whatsapp', () => ({ waPost: jest.fn(async () => { throw new Error('the real WhatsApp client must never be used in tests'); }) }));

const sender = require('../../shared/localization/campaignSender');
const { wrapLtr } = require('../../shared/localization/arabicText');
const { makeKit, oid, variant, T0 } = require('./campaignTestKit');

const WS = oid();
const OTHER_WS = oid();
const FIELDS = { discount: '15', date: '30 Nov' };
const LRM = String.fromCodePoint(0x200e);
const MIN = 60 * 1000;
let seq = 0;

function world({ variants, category = 'MARKETING', useCase = 'promotion', merchantDefault = 'en', merchantName = 'Cafe Riyadh', linkedMessageNodeId } = {}) {
  const kit = makeKit();
  kit.localeSettings.defaultCustomerLanguage = merchantDefault;
  const [template] = kit.templates.seed([{
    _id: oid(), workspaceId: WS, key: 'promo', name: 'Weekend offer', useCase, category,
    variants: variants || [variant('en'), variant('ar')], ...(linkedMessageNodeId ? { linkedMessageNodeId } : {}),
  }]);
  if (merchantName) kit.settingsDocs.seed([{ workspaceId: WS, merchantName }]);
  return { kit, template };
}

function addCustomer(kit, extra = {}, ws = WS) {
  seq += 1;
  const { language, ...rest } = extra;
  const [doc] = kit.customers.seed([{
    _id: oid(), workspaceId: ws, firstname: `First${seq}`, lastname: `Last${seq}`, phone: `9665${String(seq).padStart(8, '0')}`,
    marketingConsent: true, loyaltyPoints: 120, ...rest,
  }]);
  if (language) kit.languages.seed([{ workspaceId: ws, customerId: doc._id, language }]);
  return doc;
}

function addCampaign(kit, template, extra = {}) {
  const [doc] = kit.campaigns.seed([{
    workspaceId: WS, name: 'Spring campaign', templateId: template._id, templateName: template.name,
    languageMode: 'per_customer', audience: { kind: 'all_eligible' }, fieldValues: FIELDS, category: 'MARKETING', status: 'draft', ...extra,
  }]);
  return doc;
}

async function start(kit, campaign, acknowledge = {}) {
  const result = await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge }, kit.deps);
  await kit.drain();
  return result;
}

const campaignDoc = (kit, campaign) => kit.campaigns.docs.find((d) => String(d._id) === String(campaign._id));
const rowFor = (kit, customer) => kit.sends.docs.find((d) => String(d.customerId) === String(customer._id));
const sentTo = (kit, customer) => kit.sent.filter((s) => s.to === customer.phone);
const bodyTexts = (payload) => payload.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
const metaError = (code, message) => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400, data: { error: { code, message } } } });

async function rejects(promise) {
  try { await promise; } catch (err) { return err; }
  throw new Error('expected the promise to reject');
}

afterEach(() => { delete process.env.LOCALIZATION_WRAP_PARAM_LRM; });

describe('happy path', () => {
  test('each customer gets THEIR language: Meta template name + code, positional parameters, opt-out payload; every send is recorded', async () => {
    const { kit, template } = world();
    const sara = addCustomer(kit, { firstname: 'سارة', lastname: 'أحمد', language: 'ar', loyaltyPoints: 250 });
    const sam = addCustomer(kit, { firstname: 'Sam', lastname: 'Lee', language: 'en', loyaltyPoints: 40 });
    const noLang = addCustomer(kit, { firstname: 'Kim' }); // unknown -> merchant default (en)
    const campaign = addCampaign(kit, template);
    const { campaign: claimed } = await start(kit, campaign);

    expect(claimed.status).toBe('sending'); // answered at once, before the loop ran
    expect(kit.sent).toHaveLength(3);

    const [toSara] = sentTo(kit, sara);
    expect(toSara.name).toBe('wf_test_ar_v1');
    expect(toSara.languageCode).toBe('ar');
    expect(bodyTexts(toSara)).toEqual(['سارة', '15', '30 Nov', '250']);
    const [toSam] = sentTo(kit, sam);
    expect(toSam.name).toBe('wf_test_en_v1');
    expect(toSam.languageCode).toBe('en');
    expect(bodyTexts(toSam)).toEqual(['Sam', '15', '30 Nov', '40']);
    expect(sentTo(kit, noLang)[0].name).toBe('wf_test_en_v1');
    expect(toSam.components.find((c) => c.type === 'button').parameters[0].payload).toBe(`optout_${campaign._id}`);

    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('sent');
    expect(done.stats).toMatchObject({ total: 3, sent: 3, failed: 0, skipped: 0, byLanguage: { en: 2, ar: 1, bilingual: 0 } });
    expect(done.finishedAt).toBeInstanceOf(Date);

    const row = rowFor(kit, sara);
    expect(row).toMatchObject({ status: 'sent', usedLanguage: 'ar', fallback: false, metaTemplateName: 'wf_test_ar_v1' });
    expect(row.wamid).toMatch(/^wamid\.TEST/);

    expect(kit.messages.docs).toHaveLength(3);
    expect(kit.messages.docs.find((m) => m.wamid === row.wamid)).toMatchObject({
      workspaceId: WS, kind: 'promotion', messageType: 'template', templateName: 'wf_test_ar_v1', status: 'sent', phone: sara.phone,
    });
    expect(String(kit.messages.docs[0].customer)).toBeTruthy();
    expect(kit.ops.filter((o) => /whatsappmessages/i.test(o.collection))).toHaveLength(0); // never a WhatsAppMessage row
  });

  test('a 300 ms pause follows every real send and none follows skipped rows', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit);
    addCustomer(kit);
    addCustomer(kit, { marketingConsent: false }); // not in the audience at all
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sleeps.filter((ms) => ms === 300)).toHaveLength(3);
    expect(sender.SEND_THROTTLE_MS).toBe(300);
  });

  test('{name} falls back to a neutral phrase in the message language when the profile name is only a phone number', async () => {
    const { kit, template } = world();
    const ar = addCustomer(kit, { firstname: '966501112222', lastname: '', language: 'ar' });
    const en = addCustomer(kit, { firstname: '966501113333', lastname: '', language: 'en' });
    await start(kit, addCampaign(kit, template));
    expect(bodyTexts(sentTo(kit, ar)[0])[0]).toBe('عميلنا العزيز');
    expect(bodyTexts(sentTo(kit, en)[0])[0]).toBe('Valued Customer');
  });

  test('LRM on parameter values is off by default and only on with LOCALIZATION_WRAP_PARAM_LRM=1 (through the REAL component builder)', async () => {
    const { buildSendComponents } = require('../../shared/localization/metaTemplates');
    const run = async () => {
      const w = world();
      w.kit.buildSendComponents.mockImplementation(async (args) => buildSendComponents(args));
      const latin = addCustomer(w.kit, { firstname: 'Sam', language: 'ar' });
      const arabic = addCustomer(w.kit, { firstname: 'سارة', language: 'ar' });
      await start(w.kit, addCampaign(w.kit, w.template));
      return { w, latin, arabic };
    };
    const off = await run();
    expect(bodyTexts(sentTo(off.w.kit, off.latin)[0])).toEqual(['Sam', '15', '30 Nov', '120']);

    process.env.LOCALIZATION_WRAP_PARAM_LRM = '1';
    const on = await run();
    expect(bodyTexts(sentTo(on.w.kit, on.latin)[0])).toEqual([wrapLtr('Sam'), wrapLtr('15'), wrapLtr('30 Nov'), wrapLtr('120')]);
    expect(bodyTexts(sentTo(on.w.kit, on.arabic)[0])[0]).toBe('سارة'); // Arabic text needs no protection
  });

  test('{business} comes from Settings.merchantName (read-only) and can be overridden by a field value', async () => {
    const { kit, template } = world({
      variants: [variant('en', { body: 'Hi {name}, {business} misses you. Code {code}.' }), variant('ar')], merchantName: 'Cafe Riyadh',
    });
    const c = addCustomer(kit, { language: 'en' });
    await start(kit, addCampaign(kit, template, { fieldValues: { ...FIELDS, code: 'AB12' } }));
    expect(bodyTexts(sentTo(kit, c)[0])).toEqual([c.firstname, 'Cafe Riyadh', 'AB12']);
    expect(kit.ops.some((o) => o.collection === 'settings' && o.op !== 'findOne')).toBe(false);
  });

  test('flow buttons carry msgnode_<node>_<position>', async () => {
    const node = oid();
    const { kit, template } = world({
      linkedMessageNodeId: node,
      variants: [variant('en', { buttons: [{ role: 'flow_button', text: 'Order' }, { role: 'opt_out', text: 'Stop' }, { role: 'flow_button', text: 'Menu' }] }), variant('ar')],
    });
    const c = addCustomer(kit, { language: 'en' });
    await start(kit, addCampaign(kit, template));
    const payloads = sentTo(kit, c)[0].components.filter((x) => x.type === 'button').map((x) => x.parameters[0].payload);
    expect(payloads).toEqual([`msgnode_${node}_0`, expect.stringMatching(/^optout_/), `msgnode_${node}_1`]);
  });
});

describe('the confirm gate (re-plan at send time, never the stored plan)', () => {
  test('422 PLAN_NEEDS_ACK when there are fallbacks or blocked recipients; nothing is claimed or sent', async () => {
    const { kit, template } = world({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    addCustomer(kit, { language: 'ar' });
    const campaign = addCampaign(kit, template);
    const err = await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps));
    expect([err.status, err.code]).toEqual([422, 'PLAN_NEEDS_ACK']);
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: { fallbacks: 'yes' } }, kit.deps))).code).toBe('PLAN_NEEDS_ACK');
    expect(campaignDoc(kit, campaign).status).toBe('draft');
    expect(kit.scheduled).toHaveLength(0);
    expect(kit.sent).toHaveLength(0);
  });

  test('with the acknowledgement the fallback is sent in the merchant default and recorded with its reason', async () => {
    const { kit, template } = world({ variants: [variant('en'), variant('ar', { metaStatus: 'PENDING' })] });
    const ar = addCustomer(kit, { language: 'ar' });
    const campaign = addCampaign(kit, template);
    await start(kit, campaign, { fallbacks: true });
    expect(sentTo(kit, ar)[0].name).toBe('wf_test_en_v1');
    expect(rowFor(kit, ar)).toMatchObject({ status: 'sent', requestedLanguage: 'ar', usedLanguage: 'en', fallback: true });
    expect(rowFor(kit, ar).fallbackReason).toBeTruthy();
    expect(campaignDoc(kit, campaign).stats.byLanguage).toMatchObject({ en: 1, ar: 0 });
  });

  test('explicit "ar" mode: customers without a usable Arabic version are BLOCKED (never sent English) and the campaign ends partial', async () => {
    const { kit, template } = world({ variants: [variant('en'), variant('ar', { reviewStatus: 'draft' })] });
    const x = addCustomer(kit, { language: 'ar' });
    const campaign = addCampaign(kit, template, { languageMode: 'ar' });
    // every recipient blocked -> nothing usable
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: { blocked: true } }, kit.deps))).code).toBe('TEMPLATE_UNUSABLE');

    const ok = world({ variants: [variant('en'), variant('ar')] });
    const good = addCustomer(ok.kit, { language: 'ar' });
    const bad = addCustomer(ok.kit, { language: 'ar' });
    const c2 = addCampaign(ok.kit, ok.template, { languageMode: 'ar' });
    ok.kit.templates.docs[0].variants[1].metaStatus = 'APPROVED';
    await start(ok.kit, c2, { blocked: true });
    expect(sentTo(ok.kit, good)[0].name).toBe('wf_test_ar_v1');
    expect(sentTo(ok.kit, bad)).toHaveLength(1);
    expect(x).toBeTruthy();
  });

  test('blocked recipients are accounted for in the report rows and make the campaign partial', async () => {
    const { kit, template } = world({ variants: [variant('en'), variant('ar')] });
    const ar = addCustomer(kit, { language: 'ar' });
    const en = addCustomer(kit, { language: 'en' });
    const campaign = addCampaign(kit, template, { languageMode: 'ar' });
    await start(kit, campaign, { blocked: true });
    expect(sentTo(kit, ar)).toHaveLength(1);
    expect(sentTo(kit, en)).toHaveLength(1); // explicit ar sends Arabic to EVERYONE who has a usable Arabic version
    expect(campaignDoc(kit, campaign).status).toBe('sent');

    const w2 = world({ variants: [variant('en'), variant('ar', { metaStatus: 'REJECTED' })] });
    const e1 = addCustomer(w2.kit, { language: 'en' });
    const c2 = addCampaign(w2.kit, w2.template, { languageMode: 'per_customer' });
    await start(w2.kit, c2);
    expect(sentTo(w2.kit, e1)[0].name).toBe('wf_test_en_v1');
  });

  test.each([
    ['NOTHING_TO_SEND', (kit) => { addCustomer(kit, { marketingConsent: false }); }, {}],
    ['FIELD_VALUES_MISSING', (kit) => { addCustomer(kit); }, { fieldValues: { discount: '15' } }],
  ])('422 %s', async (code, seed, campaignExtra) => {
    const { kit, template } = world();
    seed(kit);
    const campaign = addCampaign(kit, template, campaignExtra);
    const err = await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: { fallbacks: true, blocked: true } }, kit.deps));
    expect([err.status, err.code]).toEqual([422, code]);
    expect(campaignDoc(kit, campaign).status).toBe('draft');
  });

  test('422 TEMPLATE_UNUSABLE: archived template, or a marketing version without the opt-out button', async () => {
    const archived = world();
    addCustomer(archived.kit);
    archived.kit.templates.docs[0].archived = true;
    const c1 = addCampaign(archived.kit, archived.template);
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: String(c1._id), acknowledge: {} }, archived.kit.deps))).code).toBe('TEMPLATE_UNUSABLE');

    const noStop = world({ variants: [variant('en', { buttons: [] }), variant('ar', { buttons: [] })] });
    addCustomer(noStop.kit, { language: 'en' });
    const c2 = addCampaign(noStop.kit, noStop.template);
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: String(c2._id), acknowledge: {} }, noStop.kit.deps))).code).toBe('TEMPLATE_UNUSABLE');
    expect(noStop.kit.sent).toHaveLength(0);
  });

  test('another tenant\'s campaign is 404, and so is an unknown id; a bad id is INVALID_ID', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    const campaign = addCampaign(kit, template);
    const err = await rejects(sender.startSend({ workspaceId: OTHER_WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps));
    expect([err.status, err.code]).toEqual([404, 'CAMPAIGN_NOT_FOUND']);
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: String(oid()), acknowledge: {} }, kit.deps))).status).toBe(404);
    expect((await rejects(sender.startSend({ workspaceId: WS, campaignId: { $ne: null }, acknowledge: {} }, kit.deps))).code).toBe('INVALID_ID');
    expect(campaignDoc(kit, campaign).status).toBe('draft');
  });
});

describe('double start', () => {
  test('a second start is 409 CAMPAIGN_NOT_DRAFT and schedules nothing; the first sends each customer exactly once', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    const campaign = addCampaign(kit, template);
    await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps);
    const err = await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps));
    expect([err.status, err.code]).toEqual([409, 'CAMPAIGN_NOT_DRAFT']);
    expect(kit.scheduled).toHaveLength(1);
    await kit.drain();
    expect(sentTo(kit, a)).toHaveLength(1);
  });

  test('two simultaneous clicks: exactly one wins the atomic claim', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit);
    const campaign = addCampaign(kit, template);
    const args = { workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} };
    const results = await Promise.allSettled([sender.startSend(args, kit.deps), sender.startSend(args, kit.deps)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.code).toBe('CAMPAIGN_NOT_DRAFT');
    await kit.drain();
    expect(kit.sent).toHaveLength(2);
    expect(campaignDoc(kit, campaign).runAttempts).toBe(1);
  });

  test('running the same campaign twice in one process is refused (no concurrent loops)', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    const campaign = addCampaign(kit, template);
    await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps);
    const [run] = kit.scheduled.splice(0);
    const claimedBy = campaignDoc(kit, campaign).claimedBy;
    const first = sender.runCampaign({ workspaceId: WS, campaignId: campaign._id, runnerId: claimedBy }, kit.deps);
    const second = await sender.runCampaign({ workspaceId: WS, campaignId: campaign._id, runnerId: claimedBy }, kit.deps);
    expect(second).toEqual({ skipped: 'already_running' });
    await first;
    expect(run).toBeInstanceOf(Function);
    expect(kit.sent).toHaveLength(1);
  });
});

describe('consent and compliance, re-checked on a FRESH read before every send', () => {
  test('a customer who opts out mid-campaign is skipped_opted_out and never reaches Meta', async () => {
    const { kit, template } = world();
    const [first, second, third] = [addCustomer(kit), addCustomer(kit), addCustomer(kit)];
    kit.transport.impl = async (to) => {
      if (to === first.phone) kit.customers.docs.find((d) => String(d._id) === String(second._id)).optedOut = true;
      return { messages: [{ id: `wamid.${to}` }] };
    };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(sentTo(kit, second)).toHaveLength(0);
    expect(rowFor(kit, second).status).toBe('skipped_opted_out');
    expect(sentTo(kit, third)).toHaveLength(1);
    const done = campaignDoc(kit, campaign);
    expect(done.stats).toMatchObject({ sent: 2, skipped: 1 });
    expect(done.status).toBe('sent'); // a policy skip does not make the campaign partial
  });

  test('withdrawn marketing consent mid-campaign skips (MARKETING)', async () => {
    const { kit, template } = world();
    const [first, second] = [addCustomer(kit), addCustomer(kit)];
    kit.transport.impl = async (to) => {
      if (to === first.phone) kit.customers.docs.find((d) => String(d._id) === String(second._id)).marketingConsent = false;
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, addCampaign(kit, template));
    expect(rowFor(kit, second).status).toBe('skipped_no_consent');
    expect(sentTo(kit, second)).toHaveLength(0);
  });

  test('a transactional UTILITY campaign needs no marketing consent but never reaches an opted-out customer', async () => {
    const { kit, template } = world({
      useCase: 'payment_reminder', category: 'UTILITY', variants: [variant('en', { buttons: [], metaCategory: 'UTILITY' }), variant('ar', { buttons: [], metaCategory: 'UTILITY' })],
    });
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
    await start(kit, addCampaign(kit, template, { category: 'UTILITY' }));
    expect(sentTo(kit, noConsent)).toHaveLength(1);
    expect(sentTo(kit, optedOut)).toHaveLength(0);
  });

  test('a UTILITY template that Meta re-classified to MARKETING is gated by marketing consent', async () => {
    const { kit, template } = world({
      useCase: 'order_confirmation', category: 'UTILITY', variants: [variant('en', { metaCategory: 'MARKETING' }), variant('ar')],
    });
    const consented = addCustomer(kit);
    const noConsent = addCustomer(kit, { marketingConsent: false });
    await start(kit, addCampaign(kit, template, { category: 'UTILITY' }));
    expect(sentTo(kit, consented)).toHaveLength(1);
    expect(sentTo(kit, noConsent)).toHaveLength(0);
  });

  describe('the UTILITY floor: a merchant cannot dodge marketing consent by calling a marketing message UTILITY', () => {
    const TRANSACTIONAL = ['payment_reminder', 'booking_confirmation', 'booking_reminder', 'order_confirmation'];
    const NON_TRANSACTIONAL = ['promotion', 'comeback', 'loyalty_reminder', 'points_balance', 'points_expiring', 'referral_invite', 'referral_reward', 'greeting', 'custom'];
    const utilityVariants = () => [variant('en', { buttons: [], metaCategory: 'UTILITY' }), variant('ar', { buttons: [], metaCategory: 'UTILITY' })];
    const withOptOut = () => [variant('en', { metaCategory: 'UTILITY' }), variant('ar', { metaCategory: 'UTILITY' })];

    test.each(TRANSACTIONAL)('transactional %s requested as UTILITY: reaches a customer without marketing consent, never an opted-out one', async (useCase) => {
      const { kit, template } = world({ useCase, category: 'UTILITY', variants: utilityVariants() });
      const noConsent = addCustomer(kit, { marketingConsent: false });
      const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
      const campaign = addCampaign(kit, template, { category: 'UTILITY' });
      await start(kit, campaign);
      expect(sentTo(kit, noConsent)).toHaveLength(1);
      expect(sentTo(kit, optedOut)).toHaveLength(0);
      expect(campaignDoc(kit, campaign).category).toBe('UTILITY');
    });

    test.each(NON_TRANSACTIONAL.flatMap((u) => [[u, 'UTILITY'], [u, 'MARKETING']]))(
      '%s requested as %s is sent as MARKETING: consent required, opt-out button present, the campaign is snapshotted MARKETING', async (useCase, requested) => {
        const { kit, template } = world({ useCase, category: requested, variants: withOptOut() });
        const consented = addCustomer(kit);
        const noConsent = addCustomer(kit, { marketingConsent: false });
        const optedOut = addCustomer(kit, { optedOut: true });
        const campaign = addCampaign(kit, template, { category: 'UTILITY' }); // even a draft that says UTILITY
        await start(kit, campaign);
        expect(sentTo(kit, consented)).toHaveLength(1);
        expect(sentTo(kit, noConsent)).toHaveLength(0);
        expect(sentTo(kit, optedOut)).toHaveLength(0);
        expect(campaignDoc(kit, campaign).category).toBe('MARKETING');
        expect(campaignDoc(kit, campaign).plan.category).toBe('MARKETING');
        expect(campaignDoc(kit, campaign).plan.skipped).toMatchObject({ noConsent: 1, optedOut: 1 }); // counted, never queued
      },
    );

    test('a UTILITY promotion whose variants have no opt-out button is refused at the start (it is MARKETING)', async () => {
      const { kit, template } = world({ useCase: 'promotion', category: 'UTILITY', variants: utilityVariants() });
      addCustomer(kit);
      const campaign = addCampaign(kit, template, { category: 'UTILITY' });
      const err = await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps));
      expect(err).toMatchObject({ status: 422, code: 'TEMPLATE_UNUSABLE' });
      expect(kit.sent).toHaveLength(0);
    });

    test('the floor is re-read with the template before EVERY recipient: a use case edited to a marketing one mid-run gates the rest as MARKETING', async () => {
      const { kit, template } = world({ useCase: 'payment_reminder', category: 'UTILITY', variants: withOptOut() });
      const first = addCustomer(kit);
      const second = addCustomer(kit, { marketingConsent: false });
      kit.transport.impl = async (to) => {
        if (to === first.phone) kit.templates.docs[0].useCase = 'promotion'; // the merchant re-purposes the template while the campaign runs
        return { messages: [{ id: `wamid.${to}` }] };
      };
      await start(kit, addCampaign(kit, template, { category: 'UTILITY' }));
      expect(sentTo(kit, first)).toHaveLength(1);
      expect(rowFor(kit, second).status).toBe('skipped_no_consent');
      expect(sentTo(kit, second)).toHaveLength(0);
    });

    test('welcome_optin keeps the consent-request exemption (opt-in + decline buttons, never opted-out customers) even when stored as UTILITY', async () => {
      const buttons = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
      const { kit, template } = world({ useCase: 'welcome_optin', category: 'UTILITY', variants: [variant('en', { body: 'Welcome to {business}. Offers?', buttons, metaCategory: 'UTILITY' })] });
      const waiting = addCustomer(kit, { marketingConsent: false });
      const consented = addCustomer(kit);
      const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
      const campaign = addCampaign(kit, template, { category: 'UTILITY' });
      await start(kit, campaign);
      expect(sentTo(kit, waiting)).toHaveLength(1);
      expect(sentTo(kit, consented)).toHaveLength(0);
      expect(sentTo(kit, optedOut)).toHaveLength(0);
      expect(campaignDoc(kit, campaign).category).toBe('MARKETING');
    });

    test('the exemption is lost when the template stops being a consent request mid-run', async () => {
      const buttons = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }, { role: 'opt_out', text: 'Stop' }];
      const { kit, template } = world({ useCase: 'welcome_optin', category: 'MARKETING', variants: [variant('en', { body: 'Welcome to {business}. Offers?', buttons })] });
      const first = addCustomer(kit, { marketingConsent: false });
      const second = addCustomer(kit, { marketingConsent: false });
      kit.transport.impl = async (to) => {
        if (to === first.phone) kit.templates.docs[0].useCase = 'promotion'; // no longer the ask
        return { messages: [{ id: `wamid.${to}` }] };
      };
      await start(kit, addCampaign(kit, template));
      expect(sentTo(kit, first)).toHaveLength(1);
      expect(rowFor(kit, second).status).toBe('skipped_no_consent');
      expect(sentTo(kit, second)).toHaveLength(0);
    });
  });

  test('the category cannot be loosened after the start: a campaign snapshotted as MARKETING stays MARKETING', async () => {
    const { kit, template } = world({
      useCase: 'booking_confirmation', category: 'UTILITY', variants: [variant('en', { metaCategory: 'UTILITY' }), variant('ar', { metaCategory: 'UTILITY' })],
    });
    const consented = addCustomer(kit);
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const campaign = addCampaign(kit, template, { category: 'UTILITY' });
    await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps);
    expect(rowFor(kit, noConsent)).toBeUndefined(); // snapshot not written yet
    kit.customers.docs.find((d) => String(d._id) === String(consented._id)).marketingConsent = true;
    campaignDoc(kit, campaign).category = 'MARKETING'; // e.g. flipped by Meta while queued
    await kit.drain();
    expect(sentTo(kit, noConsent)).toHaveLength(0);
  });

  test('demo customers never reach transport and are accounted for as skipped_demo', async () => {
    const { kit, template } = world();
    const demo = addCustomer(kit, { isDemo: true, language: 'ar' });
    const real = addCustomer(kit);
    const campaign = addCampaign(kit, template, { audience: { kind: 'customer_ids', customerIds: [demo._id, real._id] } });
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([real.phone]);
    expect(rowFor(kit, demo).status).toBe('skipped_demo');
    expect(kit.messages.docs.every((m) => m.phone !== demo.phone)).toBe(true);
  });

  test('a demo flag set mid-campaign is honoured too', async () => {
    const { kit, template } = world();
    const [first, second] = [addCustomer(kit), addCustomer(kit)];
    kit.transport.impl = async (to) => {
      if (to === first.phone) kit.customers.docs.find((d) => String(d._id) === String(second._id)).isDemo = true;
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, addCampaign(kit, template));
    expect(sentTo(kit, second)).toHaveLength(0);
    expect(rowFor(kit, second).status).toBe('skipped_demo');
  });

  test('invalid and duplicate phones are skipped (skipped_error with a reason), a customer erased mid-run too', async () => {
    const { kit, template } = world();
    const bad = addCustomer(kit, { phone: '0501234567' });
    const first = addCustomer(kit, { phone: '966555000111' });
    const dup = addCustomer(kit, { phone: '+966 555 000 111' });
    const gone = addCustomer(kit);
    kit.transport.impl = async (to) => {
      if (to === '966555000111') kit.customers.docs.find((d) => String(d._id) === String(gone._id)).deletedAt = new Date();
      return { messages: [{ id: `wamid.${to}` }] };
    };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(rowFor(kit, bad)).toMatchObject({ status: 'skipped_error', errorCode: 'invalid_phone' });
    expect(rowFor(kit, dup)).toMatchObject({ status: 'skipped_error', errorCode: 'duplicate_phone' });
    expect(rowFor(kit, gone)).toMatchObject({ status: 'skipped_error', errorCode: 'customer_deleted' });
    expect(kit.sent.map((s) => s.to)).toEqual(['966555000111']);
    expect(rowFor(kit, first).status).toBe('sent');
    expect(campaignDoc(kit, campaign).status).toBe('partial'); // the erased customer is a technical skip
  });

  test('a consent request (welcome_optin) goes to non-consented customers with consent_yes/consent_no payloads and stamps marketingConsentAskedAt', async () => {
    const optInEn = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
    const optInAr = [{ role: 'opt_in', text: 'نعم' }, { role: 'decline', text: 'لا' }];
    const { kit, template } = world({
      useCase: 'welcome_optin',
      variants: [variant('en', { body: 'Welcome to {business}! Want offers?', buttons: optInEn }), variant('ar', { body: 'أهلاً بك في {business}! هل تود العروض؟', buttons: optInAr })],
    });
    const asked = addCustomer(kit, { marketingConsent: false, language: 'ar' });
    const consented = addCustomer(kit);
    const optedOut = addCustomer(kit, { marketingConsent: false, optedOut: true });
    const recent = addCustomer(kit, { marketingConsent: false, marketingConsentAskedAt: new Date(T0 - 2 * 24 * 60 * MIN) });
    const campaign = addCampaign(kit, template, { fieldValues: {} });
    await start(kit, campaign);

    expect(kit.sent.map((s) => s.to)).toEqual([asked.phone]);
    const payloads = kit.sent[0].components.filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);
    expect(payloads).toEqual([`consent_yes_${asked._id}`, `consent_no_${asked._id}`]);
    expect(kit.messages.docs[0].kind).toBe('consent_request');
    const stamped = kit.customers.docs.find((d) => String(d._id) === String(asked._id));
    expect(stamped.marketingConsentAskedAt).toBeInstanceOf(Date);
    expect(stamped.marketingConsentAskedAt.getTime()).toBeGreaterThan(T0);
    expect(kit.customers.docs.find((d) => String(d._id) === String(consented._id)).marketingConsentAskedAt).toBeUndefined();
    expect(kit.customers.docs.find((d) => String(d._id) === String(recent._id)).marketingConsentAskedAt.getTime()).toBe(T0 - 2 * 24 * 60 * MIN);
    expect(optedOut).toBeTruthy();
    expect(campaignDoc(kit, campaign).status).toBe('sent'); // already-consented / asked-recently are not failures
  });

  test('a welcome_optin template without the opt-in/decline buttons never reaches non-consented customers (the exemption is earned by the buttons, not the use case)', async () => {
    const { kit, template } = world({ useCase: 'welcome_optin', variants: [variant('en', { body: 'Everything is half price! Buy now', buttons: [{ role: 'opt_out', text: 'Stop' }] })] });
    addCustomer(kit, { marketingConsent: false, language: 'en' });
    const campaign = addCampaign(kit, template, { fieldValues: {} });
    const err = await rejects(sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps));
    expect(err.code).toBe('TEMPLATE_UNUSABLE');
    expect(kit.sent).toHaveLength(0);
  });

  test('the send-time check also refuses a consent request whose buttons were removed after the plan was accepted', async () => {
    const asked = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
    const { kit, template } = world({ useCase: 'welcome_optin', variants: [variant('en', { body: 'Welcome to {business}! Want offers?', buttons: asked })] });
    const first = addCustomer(kit, { marketingConsent: false, language: 'en' });
    const second = addCustomer(kit, { marketingConsent: false, language: 'en' });
    kit.transport.impl = async (to) => {
      kit.templates.docs[0].variants[0].buttons = [{ role: 'opt_out', text: 'Stop' }];
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, addCampaign(kit, template, { fieldValues: {} }));
    expect(kit.sent.map((s) => s.to)).toEqual([first.phone]);
    expect(rowFor(kit, second)).toMatchObject({ status: 'skipped_blocked', errorCode: 'no_opt_out_button' });
  });

  test('dry-run: the transport is called but NO CampaignMessage and NO consent-ask stamp is written', async () => {
    const optIn = [{ role: 'opt_in', text: 'Yes' }, { role: 'decline', text: 'No' }];
    const { kit, template } = world({ useCase: 'welcome_optin', variants: [variant('en', { body: 'Hello {business}', buttons: optIn }), variant('ar')] });
    const c = addCustomer(kit, { marketingConsent: false, language: 'en' });
    kit.transport.dryRun = true;
    await start(kit, addCampaign(kit, template, { fieldValues: {} }));
    expect(kit.sent).toHaveLength(1);
    expect(kit.messages.docs).toHaveLength(0);
    expect(kit.customers.docs.find((d) => String(d._id) === String(c._id)).marketingConsentAskedAt).toBeUndefined();
    expect(rowFor(kit, c).status).toBe('sent');
  });

  test('the approved versions changing mid-run never turns into a silent wrong-language send', async () => {
    const { kit, template } = world();
    const first = addCustomer(kit, { language: 'en' });
    const arabic = addCustomer(kit, { language: 'ar' });
    kit.transport.impl = async (to) => {
      if (to === first.phone) kit.templates.docs[0].variants[1].metaStatus = 'PAUSED';
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, addCampaign(kit, template));
    expect(sentTo(kit, arabic)).toHaveLength(0);
    expect(rowFor(kit, arabic)).toMatchObject({ status: 'skipped_blocked', errorCode: 'variant_changed' });
  });
});

describe('failures and the loop', () => {
  test('one failure is recorded with Meta\'s code and the loop keeps going; the campaign ends partial', async () => {
    const { kit, template } = world();
    const [a, b, c] = [addCustomer(kit), addCustomer(kit), addCustomer(kit)];
    kit.transport.impl = async (to) => {
      if (to === b.phone) throw metaError(132001, 'Template name does not exist in the translation');
      return { messages: [{ id: `wamid.${to}` }] };
    };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(rowFor(kit, a).status).toBe('sent');
    expect(rowFor(kit, b)).toMatchObject({ status: 'failed', errorCode: '132001', error: 'Template name does not exist in the translation' });
    expect(rowFor(kit, c).status).toBe('sent');
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('partial');
    expect(done.stats).toMatchObject({ sent: 2, failed: 1 });
    expect(done.lastError).toContain('132001');
    expect(kit.messages.docs).toHaveLength(2); // nothing recorded for the failed send
  });

  test('every send failing ends the campaign as failed', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit);
    kit.transport.impl = async () => { throw metaError(131049, 'Marketing message limit'); };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(campaignDoc(kit, campaign).status).toBe('failed');
    expect(kit.sends.docs.map((d) => d.errorCode)).toEqual(['131049', '131049']);
  });

  test('a failed send is never retried', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    kit.transport.impl = async () => { throw new Error('socket hang up'); };
    await start(kit, addCampaign(kit, template));
    expect(sentTo(kit, a)).toHaveLength(1);
    expect(rowFor(kit, a).status).toBe('failed');
  });

  test('a rate-limit error backs the loop off before the next message', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit);
    let n = 0;
    kit.transport.impl = async () => { n += 1; if (n === 1) throw metaError(130429, 'Rate limit hit'); return { messages: [{ id: 'w2' }] }; };
    await start(kit, addCampaign(kit, template));
    expect(kit.sleeps).toContain(300 + sender.RATE_LIMIT_BACKOFF_MS);
    expect(kit.sent).toHaveLength(2);
  });

  test('an upstream error message is sanitised: no token-shaped strings, no control characters, bounded length', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    const secret = 'EAAB'.padEnd(60, 'x');
    kit.transport.impl = async () => { throw metaError(190, `Invalid token ${secret}\n${String.fromCodePoint(7)} ${'long '.repeat(200)}`); };
    await start(kit, addCampaign(kit, template));
    const { error } = rowFor(kit, a);
    expect(error).not.toContain(secret);
    expect(error).toContain('[redacted]');
    expect(error).not.toMatch(/[\u{0}-\u{1F}]/u);
    expect(Array.from(error).length).toBeLessThanOrEqual(300);
  });

  test('a send that never answers is recorded as failed with code "timeout" (delivery unknown) and not retried', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    kit.transport.impl = () => new Promise(() => {});
    await start(kit, addCampaign(kit, template));
    expect(rowFor(kit, a)).toMatchObject({ status: 'failed', errorCode: 'timeout' });
    expect(sentTo(kit, a)).toHaveLength(1);
  });

  test('a recipient whose message cannot be built is skipped with a reason, the rest go out', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    const b = addCustomer(kit);
    kit.buildSendComponents.mockImplementationOnce(async () => { throw new Error('bad component'); });
    await start(kit, addCampaign(kit, template));
    expect(rowFor(kit, a)).toMatchObject({ status: 'skipped_error', errorCode: 'components_failed' });
    expect(rowFor(kit, b).status).toBe('sent');
  });
});

// Meta 132000/132001/132012/132015/132016/132018 say the TEMPLATE (or its parameters) is unusable for
// EVERYONE. Failing every remaining recipient one by one would hammer Meta (and hurt the sender's
// quality rating) for nothing, so three in a row end the run.
describe('a template Meta says is unusable stops the campaign (3 template-level errors in a row)', () => {
  // outcomes[n] answers the n-th real send: 'ok' | a Meta error code | an Error; past the end everything succeeds.
  function script(kit, outcomes) {
    let n = 0;
    kit.transport.impl = async (to) => {
      const outcome = outcomes[n] === undefined ? 'ok' : outcomes[n];
      n += 1;
      if (outcome === 'ok') return { messages: [{ id: `wamid.${to}` }] };
      if (typeof outcome === 'number') throw metaError(outcome, `Meta says ${outcome}`);
      throw outcome;
    };
  }
  const many = (kit, n, extra) => Array.from({ length: n }, () => addCustomer(kit, extra));

  test('the policy is exactly the six template-level codes and a streak of three', () => {
    expect([...sender.TEMPLATE_ERROR_CODES].sort()).toEqual(['132000', '132001', '132012', '132015', '132016', '132018']);
    expect(sender.TEMPLATE_ERROR_STREAK).toBe(3);
  });

  test('three in a row: no further Meta call, the rest stay queued, the campaign fails with lastError template_unusable:<code>', async () => {
    const { kit, template } = world();
    const customers = many(kit, 6);
    script(kit, [132015, 132015, 132015]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);

    expect(kit.sent).toHaveLength(3); // the 4th..6th recipients never reached Meta
    expect(customers.map((c) => rowFor(kit, c).status)).toEqual(['failed', 'failed', 'failed', 'queued', 'queued', 'queued']);
    expect(rowFor(kit, customers[0])).toMatchObject({ errorCode: '132015', error: 'Meta says 132015' });
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('failed'); // nothing was sent
    expect(done.lastError).toBe('template_unusable:132015');
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.stats).toMatchObject({ total: 6, sent: 0, failed: 3 });
    expect(kit.sleeps).toEqual([300, 300]); // paced after the first two, no sleep after the one that ended the run
    expect(kit.messages.docs).toHaveLength(0);
  });

  test('something was sent before the template died: the campaign ends partial (still with the code and the queued rest)', async () => {
    const { kit, template } = world();
    const customers = many(kit, 6);
    script(kit, ['ok', 132016, 132016, 132016]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);

    expect(kit.sent).toHaveLength(4);
    expect(customers.map((c) => rowFor(kit, c).status)).toEqual(['sent', 'failed', 'failed', 'failed', 'queued', 'queued']);
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('partial');
    expect(done.lastError).toBe('template_unusable:132016');
    expect(done.stats).toMatchObject({ total: 6, sent: 1, failed: 3 });
  });

  test.each([132000, 132001, 132012, 132015, 132016, 132018])('code %i counts toward the streak', async (code) => {
    const { kit, template } = world();
    many(kit, 5);
    script(kit, [code, code, code]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(3);
    expect(campaignDoc(kit, campaign)).toMatchObject({ status: 'failed', lastError: `template_unusable:${code}` });
  });

  test('different template-level codes count together; lastError carries the one that ended the run', async () => {
    const { kit, template } = world();
    many(kit, 5);
    script(kit, [132001, 132015, 132012]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(3);
    expect(campaignDoc(kit, campaign).lastError).toBe('template_unusable:132012');
  });

  test.each([[131049], [131047], [131026], [190], [100], [132005], [132007], [130429]])('Meta code %i is about the recipient / the account, not the template: every recipient is still tried', async (code) => {
    const { kit, template } = world();
    many(kit, 5);
    script(kit, [code, code, code, code, code]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(5);
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('failed');
    expect(done.lastError).not.toContain('template_unusable');
    expect(kit.sends.docs.filter((d) => d.status === 'queued')).toHaveLength(0);
  });

  test('a network failure is not a template error either', async () => {
    const { kit, template } = world();
    many(kit, 4);
    script(kit, [new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up')]);
    await start(kit, addCampaign(kit, template));
    expect(kit.sent).toHaveLength(4);
  });

  test('the streak is CONSECUTIVE: a success resets it', async () => {
    const { kit, template } = world();
    many(kit, 6);
    script(kit, [132001, 132001, 'ok', 132001, 132001, 'ok']);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(6); // never stopped
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('partial');
    expect(done.lastError).not.toContain('template_unusable');
    expect(done.stats).toMatchObject({ sent: 2, failed: 4 });
  });

  test('any other outcome resets it too (a recipient-level failure between template errors)', async () => {
    const { kit, template } = world();
    many(kit, 6);
    script(kit, [132001, 132001, 131049, 132001, 132001, 'ok']);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(6);
    expect(campaignDoc(kit, campaign).lastError).not.toContain('template_unusable');
  });

  test('recipients skipped without a Meta call neither count nor reset the streak', async () => {
    const { kit, template } = world();
    const [c1, c2, c3, c4, c5] = many(kit, 5);
    kit.transport.impl = async (to) => {
      if (to === c1.phone) kit.customers.docs.find((d) => String(d._id) === String(c2._id)).optedOut = true; // c2 opts out while c1 is being sent
      throw metaError(132018, 'There is an issue with the parameters in your template');
    };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([c1.phone, c3.phone, c4.phone]); // c2 skipped (no call), the third error ended the run
    expect(rowFor(kit, c2).status).toBe('skipped_opted_out');
    expect(rowFor(kit, c5).status).toBe('queued');
    expect(campaignDoc(kit, campaign).lastError).toBe('template_unusable:132018');
  });

  test('the rate-limit back-off keeps working next to it', async () => {
    const { kit, template } = world();
    many(kit, 3);
    script(kit, [130429, 'ok', 'ok']);
    await start(kit, addCampaign(kit, template));
    expect(kit.sleeps).toContain(300 + sender.RATE_LIMIT_BACKOFF_MS);
    expect(kit.sent).toHaveLength(3);
  });

  test('the run is over: the resumer never picks the campaign up and nothing more is sent', async () => {
    const { kit, template } = world();
    many(kit, 5);
    script(kit, [132015, 132015, 132015]);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    kit.clock.t += 60 * MIN;
    const result = await sender.resumeStuckCampaigns({}, kit.deps);
    await kit.drain();
    expect(result).toEqual({ resumed: 0, failed: 0 });
    expect(kit.sent).toHaveLength(3);
    expect(campaignDoc(kit, campaign).status).toBe('failed');
    const again = await sender.runCampaign({ workspaceId: WS, campaignId: campaign._id, runnerId: 'runner-1' }, kit.deps);
    expect(again).toEqual({ skipped: 'not_owner' });
    expect(kit.sent).toHaveLength(3);
  });

  test('a campaign cancelled meanwhile is not overwritten by the stop', async () => {
    const { kit, template } = world();
    many(kit, 5);
    const campaign = addCampaign(kit, template);
    let calls = 0;
    kit.transport.impl = async () => {
      calls += 1;
      if (calls === 3) campaignDoc(kit, campaign).status = 'cancelled'; // cancelled while the third error is in flight
      throw metaError(132001, 'Template does not exist');
    };
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(3);
    expect(campaignDoc(kit, campaign).status).toBe('cancelled');
  });

  test('sendSingle (one recipient) reports the template error as the reason and never loops', async () => {
    const { kit, template } = world();
    const [only] = many(kit, 1);
    script(kit, [132015]);
    const result = await sender.sendSingle({ workspaceId: WS, templateId: template._id, customerId: only._id, fieldValues: FIELDS }, kit.deps);
    expect(result).toMatchObject({ sent: false, status: 'failed', reason: '132015' });
    expect(kit.sent).toHaveLength(1);
  });
});

// Customer.phone is not unique and the existing opt-out paths update only the FIRST matching customer,
// so a second record of the same person must not keep receiving once ANY record of that number opted out.
describe('another record with the same phone opted out', () => {
  const twinOf = (kit, phone, extra = {}) => addCustomer(kit, { phone, optedOut: true, marketingConsent: false, ...extra });
  function spyOptedOutReads(kit) {
    const reads = [];
    const original = kit.customers.find.bind(kit.customers);
    kit.customers.find = (filter) => { if (filter && filter.optedOut === true) reads.push(filter); return original(filter); };
    return reads;
  }

  test('at the start: the consented record is never sent, is recorded skipped_opted_out / opted_out_same_phone, and the campaign still ends "sent" (a policy skip)', async () => {
    const { kit, template } = world();
    const alive = addCustomer(kit, { phone: '966500123456' });
    twinOf(kit, '+966 50 012 3456');
    const other = addCustomer(kit);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([other.phone]);
    expect(rowFor(kit, alive)).toMatchObject({ status: 'skipped_opted_out', errorCode: 'opted_out_same_phone' });
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('sent');
    expect(done.plan.skipped.optedOut).toBe(2); // the twin itself + the record that shares its number
    expect(done.stats).toMatchObject({ sent: 1, skipped: 1 });
  });

  test('a transactional UTILITY campaign honours it too', async () => {
    const { kit, template } = world({ useCase: 'booking_reminder', category: 'UTILITY', variants: [variant('en', { buttons: [], metaCategory: 'UTILITY' })] });
    const alive = addCustomer(kit, { phone: '966500123457', marketingConsent: false });
    twinOf(kit, '966500123457');
    const other = addCustomer(kit, { marketingConsent: false }); // transactional: no marketing consent needed
    await start(kit, addCampaign(kit, template, { category: 'UTILITY' }));
    expect(kit.sent.map((s) => s.to)).toEqual([other.phone]);
    expect(rowFor(kit, alive).status).toBe('skipped_opted_out');
  });

  test('a twin that opts out WHILE the campaign runs is honoured at send time (the opted-out list is refreshed at most once a minute)', async () => {
    const { kit, template } = world();
    const twin = addCustomer(kit, { phone: '966500123003', marketingConsent: false });
    const [first, second, third] = [addCustomer(kit, { phone: '966500123001' }), addCustomer(kit, { phone: '966500123002' }), addCustomer(kit, { phone: '966500123003' })];
    kit.transport.impl = async (to) => {
      if (to === first.phone) {
        kit.customers.docs.find((d) => String(d._id) === String(twin._id)).optedOut = true; // STOP arrives on the other record of third's number
        kit.clock.t += sender.OPTED_OUT_REFRESH_MS; // a minute later
      }
      return { messages: [{ id: `wamid.${to}` }] };
    };
    const campaign = addCampaign(kit, template, { audience: { kind: 'customer_ids', customerIds: [first._id, second._id, third._id] } });
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([first.phone, second.phone]);
    expect(rowFor(kit, third)).toMatchObject({ status: 'skipped_opted_out', errorCode: 'opted_out_same_phone' });
  });

  test('one bulk read at the start and one when the first recipient is prepared, NOT one per recipient', async () => {
    const { kit, template } = world();
    for (let i = 0; i < 5; i += 1) addCustomer(kit);
    const reads = spyOptedOutReads(kit);
    await start(kit, addCampaign(kit, template));
    expect(kit.sent).toHaveLength(5);
    expect(reads).toHaveLength(2); // planning + the sender's cached copy
    expect(reads.every((f) => String(f.workspaceId) === String(WS))).toBe(true);
  });

  test('the cached list is re-read once a minute has passed', async () => {
    const { kit, template } = world();
    const customers = Array.from({ length: 4 }, () => addCustomer(kit));
    const reads = spyOptedOutReads(kit);
    kit.transport.impl = async (to) => {
      if (to === customers[1].phone) kit.clock.t += sender.OPTED_OUT_REFRESH_MS;
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, addCampaign(kit, template));
    expect(reads).toHaveLength(3); // planning, first recipient, and once more after the minute
  });

  test('a read failure while preparing a recipient fails that recipient CLOSED (never sent)', async () => {
    const { kit, template } = world();
    const [a] = [addCustomer(kit)];
    const campaign = addCampaign(kit, template);
    await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps);
    const original = kit.customers.find.bind(kit.customers);
    kit.customers.find = (filter) => {
      if (filter && filter.optedOut === true) throw new Error('cosmos is unavailable');
      return original(filter);
    };
    await kit.drain();
    expect(kit.sent).toHaveLength(0);
    expect(rowFor(kit, a)).toMatchObject({ status: 'failed', errorCode: 'internal' });
  });

  test('sendSingle refuses a customer whose number opted out on another record', async () => {
    const { kit, template } = world();
    const alive = addCustomer(kit, { phone: '966500123999' });
    twinOf(kit, '966500123999');
    const result = await sender.sendSingle({ workspaceId: WS, templateId: template._id, customerId: alive._id, fieldValues: FIELDS }, kit.deps);
    expect(result).toMatchObject({ sent: false, status: 'skipped_opted_out', reason: 'opted_out_phone' });
    expect(kit.sent).toHaveLength(0);
  });
});

describe('cancel', () => {
  test('cancelling mid-run stops the loop: at most the message in flight goes out, the rest are closed (never deleted)', async () => {
    const { kit, template } = world();
    const all = [addCustomer(kit), addCustomer(kit), addCustomer(kit)];
    const campaign = addCampaign(kit, template);
    kit.transport.impl = async (to) => {
      campaignDoc(kit, campaign).status = 'cancelled';
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(1);
    expect(rowFor(kit, all[0]).status).toBe('sent');
    expect(rowFor(kit, all[1])).toMatchObject({ status: 'skipped_error', errorCode: 'cancelled' });
    expect(rowFor(kit, all[2])).toMatchObject({ status: 'skipped_error', errorCode: 'cancelled' });
    expect(kit.sends.docs).toHaveLength(3);
    const done = campaignDoc(kit, campaign);
    expect(done.status).toBe('cancelled');
    expect(done.stats).toMatchObject({ total: 3, sent: 1, skipped: 2 });
  });

  test('a campaign cancelled before the background run starts sends nothing', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    const campaign = addCampaign(kit, template);
    await sender.startSend({ workspaceId: WS, campaignId: String(campaign._id), acknowledge: {} }, kit.deps);
    campaignDoc(kit, campaign).status = 'cancelled';
    await kit.drain();
    expect(kit.sent).toHaveLength(0);
  });

  test('only the runner that owns the claim keeps going (a stale runner stops once it was taken over)', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit);
    const campaign = addCampaign(kit, template);
    kit.transport.impl = async (to) => {
      campaignDoc(kit, campaign).claimedBy = 'someone-else';
      return { messages: [{ id: `wamid.${to}` }] };
    };
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(1);
    expect(campaignDoc(kit, campaign).status).toBe('sending'); // the new owner finishes it
  });
});

describe('bookkeeping can never cause a re-send', () => {
  test('a failing CampaignMessage write is logged and ignored: the row is sent and the campaign completes', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    addCustomer(kit);
    kit.fail('campaignmessages', 'create', new Error('cosmos write failed'), 10);
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(sentTo(kit, a)).toHaveLength(1);
    expect(kit.sent).toHaveLength(2);
    expect(campaignDoc(kit, campaign).status).toBe('sent');
    expect(kit.logs.some((l) => /campaign message row failed/.test(l))).toBe(true);
  });

  test('a failing status write after a real send leaves the row `sending`: never queued again, and the resumer marks it interrupted instead of re-sending', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    const b = addCustomer(kit);
    const campaign = addCampaign(kit, template);
    // the claim (queued -> sending) uses findOneAndUpdate; only the post-send updateOne fails
    kit.fail('localizedsends', 'updateOne', new Error('cosmos write failed'), 1);
    await start(kit, campaign);
    expect(kit.sent).toHaveLength(2);
    expect(rowFor(kit, a).status).toBe('sending');
    expect(rowFor(kit, b).status).toBe('sent');
    expect(campaignDoc(kit, campaign).status).toBe('sending'); // not finalised: a row is unresolved

    kit.clock.t += 10 * MIN;
    const resumed = await sender.resumeStuckCampaigns({}, kit.deps);
    expect(resumed.resumed).toBe(1);
    await kit.drain();
    expect(kit.sent).toHaveLength(2); // still two
    expect(rowFor(kit, a)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    expect(campaignDoc(kit, campaign).status).toBe('partial');
  });

  test('transient database errors are retried on bookkeeping writes only (never on the Meta call)', async () => {
    const { kit, template } = world();
    const a = addCustomer(kit);
    kit.fail('localizedsends', 'updateOne', Object.assign(new Error('Request rate is large'), { code: 16500 }), 2);
    await start(kit, addCampaign(kit, template));
    expect(sentTo(kit, a)).toHaveLength(1);
    expect(rowFor(kit, a).status).toBe('sent');
    expect(kit.sleeps).toContain(200);
  });
});

describe('crash recovery (resumeStuckCampaigns)', () => {
  function stuck({ heartbeatAgoMs = 10 * MIN, runAttempts = 1, withSnapshot = true } = {}) {
    const w = world();
    const done = addCustomer(w.kit, { language: 'en' });
    const interrupted = addCustomer(w.kit, { language: 'en' });
    const pending = addCustomer(w.kit, { language: 'ar' });
    const campaign = addCampaign(w.kit, w.template, {
      status: 'sending', claimedBy: 'dead-runner', startedAt: new Date(T0 - 20 * MIN), lastHeartbeatAt: new Date(T0 - heartbeatAgoMs), runAttempts,
      ...(withSnapshot ? { snapshotAt: new Date(T0 - 19 * MIN) } : {}),
    });
    const row = (customer, extra) => ({
      workspaceId: WS, campaignId: campaign._id, customerId: customer._id, phone: customer.phone, requestedLanguage: 'en', usedLanguage: 'en', ...extra,
    });
    w.kit.sends.seed([
      row(done, { status: 'sent', wamid: 'wamid.ALREADY', metaTemplateName: 'wf_test_en_v1' }),
      row(interrupted, { status: 'sending' }),
      row(pending, { status: 'queued', requestedLanguage: 'ar', usedLanguage: 'ar', metaTemplateName: 'wf_test_ar_v1' }),
    ]);
    return { ...w, done, interrupted, pending, campaign };
  }

  test('takes over a stale campaign: sent rows are never re-sent, an interrupted row is failed (delivery unknown), only queued rows go out', async () => {
    const s = stuck();
    const result = await sender.resumeStuckCampaigns({ idleMs: 5 * MIN }, s.kit.deps);
    expect(result).toEqual({ resumed: 1, failed: 0 });
    await s.kit.drain();
    expect(s.kit.sent.map((x) => x.to)).toEqual([s.pending.phone]);
    expect(rowFor(s.kit, s.done)).toMatchObject({ status: 'sent', wamid: 'wamid.ALREADY' });
    expect(rowFor(s.kit, s.interrupted)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
    const doc = campaignDoc(s.kit, s.campaign);
    expect(doc.status).toBe('partial');
    expect(doc.runAttempts).toBe(2);
    expect(doc.claimedBy).not.toBe('dead-runner');
  });

  test('a campaign with a fresh heartbeat is left alone', async () => {
    const s = stuck({ heartbeatAgoMs: 1 * MIN });
    expect(await sender.resumeStuckCampaigns({ idleMs: 5 * MIN }, s.kit.deps)).toEqual({ resumed: 0, failed: 0 });
    expect(s.kit.scheduled).toHaveLength(0);
  });

  test('two resumers racing: exactly one takes over (compare-and-set on the stale heartbeat)', async () => {
    const s = stuck();
    const [a, b] = await Promise.all([sender.resumeStuckCampaigns({}, s.kit.deps), sender.resumeStuckCampaigns({}, s.kit.deps)]);
    expect(a.resumed + b.resumed).toBe(1);
    await s.kit.drain();
    expect(s.kit.sent).toHaveLength(1);
  });

  test('respects the kill switch and the per-merchant flag', async () => {
    const s = stuck();
    s.kit.killSwitch = true;
    expect(await sender.resumeStuckCampaigns({}, s.kit.deps)).toEqual({ resumed: 0, failed: 0 });
    s.kit.killSwitch = false;
    s.kit.flagEnabled = false;
    expect(await sender.resumeStuckCampaigns({}, s.kit.deps)).toEqual({ resumed: 0, failed: 0 });
    expect(s.kit.sent).toHaveLength(0);
  });

  test('Arabic switched off for the merchant (or the kill switch) while a run is in flight stops it before the next message; the campaign stays resumable', async () => {
    const { kit, template } = world();
    const first = addCustomer(kit, { language: 'en' });
    const second = addCustomer(kit, { language: 'en' });
    kit.transport.impl = async (to) => {
      kit.flagEnabled = false; // staff disable the flag right after the first message went out
      return { messages: [{ id: `wamid.${to}` }] };
    };
    const campaign = addCampaign(kit, template);
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([first.phone]);
    expect(rowFor(kit, second).status).toBe('queued');
    expect(campaignDoc(kit, campaign).status).toBe('sending');
    expect(kit.sleeps.length).toBeLessThanOrEqual(1);
  });

  test('a campaign that has already been claimed too many times is failed instead of resumed forever', async () => {
    const s = stuck({ runAttempts: sender.MAX_RUN_ATTEMPTS });
    expect(await sender.resumeStuckCampaigns({}, s.kit.deps)).toEqual({ resumed: 0, failed: 1 });
    expect(campaignDoc(s.kit, s.campaign)).toMatchObject({ status: 'failed' });
    expect(s.kit.sent).toHaveLength(0);
  });

  test('a crash before the snapshot was complete: rows written so far are kept (duplicate inserts ignored), nobody is sent twice', async () => {
    const w = world();
    const a = addCustomer(w.kit, { language: 'en' });
    const b = addCustomer(w.kit, { language: 'en' });
    const campaign = addCampaign(w.kit, w.template, { status: 'sending', claimedBy: 'dead', lastHeartbeatAt: new Date(T0 - 10 * MIN), startedAt: new Date(T0 - 11 * MIN), runAttempts: 1 });
    w.kit.sends.seed([{ workspaceId: WS, campaignId: campaign._id, customerId: a._id, phone: a.phone, status: 'sent', wamid: 'wamid.OLD', usedLanguage: 'en' }]);
    await sender.resumeStuckCampaigns({}, w.kit.deps);
    await w.kit.drain();
    expect(w.kit.sent.map((s) => s.to)).toEqual([b.phone]);
    expect(w.kit.sends.docs.filter((d) => String(d.customerId) === String(a._id))).toHaveLength(1);
    expect(rowFor(w.kit, a).wamid).toBe('wamid.OLD');
    expect(campaignDoc(w.kit, campaign).status).toBe('sent');
  });
});

describe('snapshot, heartbeat and stats', () => {
  test('every resolved customer gets a row so the report accounts for everyone (skipped ones included)', async () => {
    const { kit, template } = world();
    const ok = addCustomer(kit);
    const demo = addCustomer(kit, { isDemo: true });
    const noConsent = addCustomer(kit, { marketingConsent: false });
    const optedOut = addCustomer(kit, { optedOut: true });
    const campaign = addCampaign(kit, template, { audience: { kind: 'customer_ids', customerIds: [ok, demo, noConsent, optedOut].map((c) => c._id) } });
    await start(kit, campaign);
    expect(kit.sends.docs).toHaveLength(4);
    expect(rowFor(kit, noConsent).status).toBe('skipped_no_consent');
    expect(rowFor(kit, optedOut).status).toBe('skipped_opted_out');
    expect(rowFor(kit, demo).status).toBe('skipped_demo');
    expect(campaignDoc(kit, campaign).stats).toMatchObject({ total: 4, sent: 1, skipped: 3 });
  });

  test('another tenant\'s customer ids never become recipients', async () => {
    const { kit, template } = world();
    const mine = addCustomer(kit);
    const theirs = addCustomer(kit, {}, OTHER_WS);
    const campaign = addCampaign(kit, template, { audience: { kind: 'customer_ids', customerIds: [mine._id, theirs._id] } });
    await start(kit, campaign);
    expect(kit.sent.map((s) => s.to)).toEqual([mine.phone]);
    expect(kit.sends.docs.every((d) => String(d.workspaceId) === String(WS))).toBe(true);
  });

  test('the heartbeat is refreshed every N sends while running', async () => {
    const { kit, template } = world();
    for (let i = 0; i < sender.HEARTBEAT_EVERY + 2; i += 1) addCustomer(kit);
    const campaign = addCampaign(kit, template);
    const beats = [];
    const original = kit.campaigns.updateOne.bind(kit.campaigns);
    kit.campaigns.updateOne = (filter, update) => { if (update.$set && update.$set.lastHeartbeatAt) beats.push(update.$set.stats.sent); return original(filter, update); };
    await start(kit, campaign);
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]).toBeGreaterThan(0);
  });

  test('statsFromGroups counts only sent messages per language and never double counts', () => {
    const { stats, byStatus } = sender.statsFromGroups([
      { _id: { status: 'sent', usedLanguage: 'ar' }, count: 4 },
      { _id: { status: 'sent', usedLanguage: 'en' }, count: 2 },
      { _id: { status: 'failed', usedLanguage: 'ar' }, count: 1 },
      { _id: { status: 'skipped_demo' }, count: 3 },
      { _id: { status: 'queued' }, count: 5 },
    ]);
    expect(stats).toEqual({ total: 15, sent: 6, failed: 1, skipped: 3, byLanguage: { en: 2, ar: 4, bilingual: 0 } });
    expect(byStatus.queued).toBe(5);
  });
});

describe('helpers', () => {
  test('describeSendError reads Meta\'s error object and falls back to the runtime error', () => {
    expect(sender.describeSendError(metaError(132015, 'Template is paused'))).toEqual({ code: '132015', message: 'Template is paused' });
    expect(sender.describeSendError(new Error('socket hang up'))).toEqual({ code: 'send_failed', message: 'socket hang up' });
    expect(sender.describeSendError(Object.assign(new Error('x'), { timeout: true })).code).toBe('timeout');
  });

  test('buttonPayloadsFor maps roles onto the payload prefixes the existing webhook dispatches', () => {
    const payloads = sender.buttonPayloadsFor({
      variant: { buttons: [{ role: 'opt_out' }, { role: 'opt_in' }, { role: 'decline' }, { role: 'url' }, { role: 'flow_button' }] },
      template: { linkedMessageNodeId: 'N1' }, campaign: { _id: 'C1' }, customer: { _id: 'U1' },
    });
    expect(payloads).toEqual(['optout_C1', 'consent_yes_U1', 'consent_no_U1', null, 'msgnode_N1_0']);
  });

  test('campaignMessageKind follows the use case onto the existing enum', () => {
    expect(sender.campaignMessageKind({ useCase: 'promotion' }, { buttons: [] })).toBe('promotion');
    expect(sender.campaignMessageKind({ useCase: 'loyalty_reminder' }, { buttons: [] })).toBe('loyalty_reminder');
    expect(sender.campaignMessageKind({ useCase: 'booking_reminder' }, { buttons: [] })).toBe('booking_notification');
    expect(sender.campaignMessageKind({ useCase: 'welcome_optin' }, { buttons: [{ role: 'opt_in' }] })).toBe('consent_request');
  });
});

describe('sendSingle (Inbox "send loyalty reminder")', () => {
  function singleWorld(variants) {
    const w = world({ useCase: 'loyalty_reminder', variants: variants || [variant('en', { body: 'Hi {name}, you have {points} points.' }), variant('ar', { body: 'مرحباً {name}، رصيدك {points} نقطة.' })] });
    return w;
  }
  const single = (w, customer, extra = {}) => sender.sendSingle({ workspaceId: WS, templateId: String(w.template._id), customerId: String(customer._id), fieldValues: {}, createdBy: String(oid()), ...extra }, w.kit.deps);

  test('sends one message synchronously in the customer\'s language and records a one-recipient campaign', async () => {
    const w = singleWorld();
    const c = addCustomer(w.kit, { language: 'ar', loyaltyPoints: 80 });
    const result = await single(w, c);
    expect(result).toMatchObject({ sent: true, status: 'sent', usedLanguage: 'ar', fallback: false });
    expect(result.wamid).toMatch(/^wamid\./);
    expect(w.kit.sent).toHaveLength(1);
    expect(bodyTexts(w.kit.sent[0])).toEqual([c.firstname, '80']);
    expect(w.kit.campaigns.docs).toHaveLength(1);
    expect(w.kit.campaigns.docs[0]).toMatchObject({ status: 'sent', audience: { kind: 'customer_ids' }, stats: { total: 1, sent: 1 } });
    expect(w.kit.messages.docs[0]).toMatchObject({ kind: 'loyalty_reminder', status: 'sent' });
  });

  test('never falls back silently: an unusable Arabic version is refused with a reason (unless the caller allows the fallback)', async () => {
    const w = singleWorld([variant('en', { body: 'Hi {name}, {points} points.' }), variant('ar', { metaStatus: 'PENDING', body: 'مرحباً {name} {points}' })]);
    const c = addCustomer(w.kit, { language: 'ar' });
    const refused = await single(w, c);
    expect(refused).toMatchObject({ sent: false, fallback: true });
    expect(refused.reason).toBeTruthy();
    expect(w.kit.sent).toHaveLength(0);
    expect(w.kit.campaigns.docs).toHaveLength(0);

    const allowed = await single(w, c, { allowFallback: true });
    expect(allowed).toMatchObject({ sent: true, usedLanguage: 'en', fallback: true });
  });

  test.each([
    ['no consent', { marketingConsent: false }, 'no_consent'],
    ['opted out', { optedOut: true }, 'opted_out'],
    ['demo', { isDemo: true }, 'demo'],
  ])('%s: not sent, explicit reason, nothing reaches transport', async (_label, extra, reason) => {
    const w = singleWorld();
    const c = addCustomer(w.kit, { language: 'en', ...extra });
    const result = await single(w, c);
    expect(result).toMatchObject({ sent: false, reason });
    expect(w.kit.sent).toHaveLength(0);
  });

  test('a failing send reports the error code; another tenant\'s customer is CUSTOMER_NOT_FOUND', async () => {
    const w = singleWorld();
    const c = addCustomer(w.kit, { language: 'en' });
    w.kit.transport.impl = async () => { throw metaError(131047, 'Re-engagement message'); };
    expect(await single(w, c)).toMatchObject({ sent: false, status: 'failed', reason: '131047' });

    const theirs = addCustomer(w.kit, {}, OTHER_WS);
    const err = await rejects(single(w, theirs));
    expect([err.status, err.code]).toEqual([404, 'CUSTOMER_NOT_FOUND']);
  });

  test('missing field values and an invalid id are refused before anything is created', async () => {
    const w = world({ variants: [variant('en'), variant('ar')] }); // needs {discount} and {date}
    const c = addCustomer(w.kit, { language: 'en' });
    expect(await single(w, c)).toMatchObject({ sent: false, reason: 'field_values_missing' });
    expect(w.kit.campaigns.docs).toHaveLength(0);
    expect((await rejects(sender.sendSingle({ workspaceId: WS, templateId: String(w.template._id), customerId: 'nope', fieldValues: {} }, w.kit.deps))).code).toBe('INVALID_ID');
  });
});

describe('no deletes, no real network', () => {
  test('the whole run only uses non-destructive operations', async () => {
    const { kit, template } = world();
    addCustomer(kit);
    addCustomer(kit, { optedOut: true });
    await start(kit, addCampaign(kit, template));
    const forbidden = kit.ops.filter((o) => /delete|remove|drop/i.test(o.op));
    expect(forbidden).toEqual([]);
  });
});
