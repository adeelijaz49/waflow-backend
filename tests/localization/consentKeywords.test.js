// Spec §3.4: "automated tests for each keyword and each normalisation case".
// Every typed opt-out keyword x every normalisation variant must be honoured
// immediately (consent function called with the right method, Arabic
// acknowledgement sent, webhook stopped), and opt-in words only count while a
// consent ask is pending. All collaborators are faked: no DB, no network.
const { handleInbound, resetHandled } = require('../../shared/localization/inboundHook');
const { RAW, classifyInboundText } = require('../../shared/localization/keywords');
const catalog = require('../../shared/localization/catalog');

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const WS = 'ws1';
const FROM = '966500000001';
const cp = (n) => String.fromCodePoint(n);
const FATHA = cp(0x064E);
const SHADDA = cp(0x0651);
const TATWEEL = cp(0x0640);
const RLM = cp(0x200F);
const LRM = cp(0x200E);
const ZWSP = cp(0x200B);
const ARABIC_LETTER = /\p{Script=Arabic}/u;

function makeDeps({ customer, pendingState = {}, enabled = false } = {}) {
  const cust = customer === undefined ? { _id: 'c1', phone: FROM, marketingConsent: false, marketingConsentAskedAt: null } : customer;
  const calls = { withdraw: [], grant: [], reinstate: [], decline: [], sent: [] };
  return {
    calls,
    Customer: { findOne: jest.fn(async () => cust) },
    ConsentEvent: { exists: jest.fn(async () => null) },
    CustomerLanguage: { findOne: jest.fn(() => ({ lean: async () => null })), updateOne: jest.fn(), create: jest.fn() },
    CampaignMessage: { findOneAndUpdate: jest.fn() },
    consent: {
      withdrawMarketingConsent: jest.fn(async (a) => { calls.withdraw.push(a); }),
      grantMarketingConsent: jest.fn(async (a) => { calls.grant.push(a); }),
      reinstateMarketingConsent: jest.fn(async (a) => { calls.reinstate.push(a); return true; }),
      declineMarketingConsent: jest.fn(async (a) => { calls.decline.push(a); }),
    },
    settings: { killSwitchOn: () => false, isArabicEnabled: jest.fn(async () => enabled) },
    transport: { sendText: jest.fn(async (to, body) => { calls.sent.push({ to, body }); }) },
    catalog,
    state: {
      pendingServiceCheckouts: new Map(), pendingPointsCheckouts: new Map(), pendingAddressReqs: new Map(), pendingCatalogs: new Map(), ...pendingState,
    },
    now: () => NOW,
    sleep: async () => {},
    log: jest.fn(),
    debug: jest.fn(),
  };
}
const run = (deps, body) => handleInbound({ workspaceId: WS, from: FROM, message: { type: 'text', text: { body } } }, deps);
const askedCustomer = (over = {}) => ({ _id: 'c1', phone: FROM, marketingConsent: false, marketingConsentAskedAt: new Date(NOW - 60 * 60 * 1000), ...over });

beforeEach(() => resetHandled());

// ── normalisation variants (each one is a distinct case the spec names) ────
const afterEachLetter = (s, mark) => Array.from(s).map((ch) => (ARABIC_LETTER.test(ch) ? ch + mark : ch)).join('');
const VARIANTS = [
  ['plain', (k) => k],
  ['tashkeel (fatha after every letter)', (k) => afterEachLetter(k, FATHA)],
  ['tashkeel (shadda + fatha)', (k) => afterEachLetter(k, SHADDA + FATHA)],
  ['tatweel (kashida)', (k) => afterEachLetter(k, TATWEEL)],
  ['alef -> alef with madda', (k) => k.replace(/ا/g, cp(0x0622))],
  ['alef -> alef with hamza above', (k) => k.replace(/ا/g, cp(0x0623))],
  ['alef -> alef with hamza below', (k) => k.replace(/ا/g, cp(0x0625))],
  ['hamza alefs -> bare alef', (k) => k.replace(/[أإآ]/g, 'ا')],
  ['extra spaces and a newline', (k) => `  \n ${k.replace(/ /g, '   ')}  \n`],
  ['trailing punctuation', (k) => `${k}!!!`],
  ['Arabic question mark and comma', (k) => `${k}${cp(0x061F)}${cp(0x060C)}`],
  ['guillemets', (k) => `«${k}»`],
  ['emoji', (k) => `${k} 🙏🛑`],
  ['leading emoji', (k) => `🛑 ${k}`],
  ['RLM / LRM marks around it', (k) => `${RLM}${k}${LRM}`],
  ['zero-width space inside the message edges', (k) => `${ZWSP}${k}${ZWSP}`],
  ['polite filler', (k) => `${k} من فضلك`],
  ['polite filler in front', (k) => `لو سمحت ${k}`],
  ['thanks', (k) => `${k} شكرا`],
];

const ARABIC_OPT_OUT = RAW.opt_out.filter((k) => /\p{Script=Arabic}/u.test(k));

describe('every Arabic opt-out keyword x every normalisation variant is honoured immediately', () => {
  const cases = [];
  for (const kw of ARABIC_OPT_OUT) for (const [name, fn] of VARIANTS) cases.push([kw, name, fn(kw)]);

  test.each(cases)('keyword %j, variant: %s', async (kw, variant, input) => {
    const deps = makeDeps();
    await expect(run(deps, input)).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
    expect(deps.calls.withdraw[0]).toMatchObject({ method: 'whatsapp_stop_command', workspaceId: WS });
    expect(deps.calls.withdraw[0].source).toContain('Arabic');
    expect(deps.calls.sent).toEqual([{ to: FROM, body: catalog.t('ar', 'consent.optOutAck') }]);
    expect(deps.calls.grant).toHaveLength(0);
  });

  test('the keyword list really contains every keyword the spec names', () => {
    const normalised = new Set(ARABIC_OPT_OUT);
    for (const k of ['إلغاء الاشتراك', 'إلغاء', 'الغاء', 'توقف', 'ايقاف', 'إيقاف']) expect(normalised.has(k)).toBe(true);
    expect(RAW.opt_out).toContain('STOP');
  });
});

describe('STOP typed on an Arabic keyboard or with direction marks', () => {
  test.each([['ستوب'], ['ستـــوب'], ['ستوب!'], ['STOP' + RLM], [RLM + 'STOP'], ['Stop' + RLM + '.'], ['sToP' + LRM], ['UNSUBSCRIBE' + RLM], ['stop' + ZWSP]])(
    '%j is an opt-out',
    async (input) => {
      const deps = makeDeps();
      await expect(run(deps, input)).resolves.toBe(true);
      expect(deps.calls.withdraw).toHaveLength(1);
      expect(deps.calls.withdraw[0].method).toBe('whatsapp_stop_command');
    },
  );

  test('a Latin STOP that carries marks is answered in English for an English customer', async () => {
    const deps = makeDeps();
    await run(deps, 'STOP' + RLM);
    expect(deps.calls.sent[0].body).toBe(catalog.t('en', 'consent.optOutAck'));
  });

  test('...and in Arabic when the customer language is Arabic', async () => {
    const deps = makeDeps();
    deps.CustomerLanguage.findOne = jest.fn(() => ({ lean: async () => ({ language: 'ar' }) }));
    await run(deps, 'STOP' + RLM);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.optOutAck'));
  });

  test.each([['STOP'], ['stop'], ['Stop.'], ['UNSUBSCRIBE'], ['START'], ['STOP' + RLM + ' sending me stuff']])('plain English %j is left to the existing code (zero side effects)', async (input) => {
    const deps = makeDeps();
    await expect(run(deps, input)).resolves.toBe(false);
    expect(deps.Customer.findOne).not.toHaveBeenCalled();
    expect(deps.calls.withdraw).toHaveLength(0);
    expect(deps.calls.sent).toHaveLength(0);
  });
});

describe('a short sentence that says "unsubscribe me" is an opt-out', () => {
  test.each([
    ['أبغى إلغاء الاشتراك'],
    ['ابغى الغاء الاشتراك لو سمحت'],
    ['الرجاء إلغاء اشتراكي'],
    ['ممكن توقفون الرسائل؟ إيقاف الرسائل'],
    ['إيقاف الرسائل الترويجية'],
    ['أوقفوا الرسائل'],
    ['توقفوا عن الإرسال لي'],
    ['توقف عن مراسلتي'],
    ['لا أريد رسائل'],
    ['ما أبغى عروض'],
    ['لا تراسلوني بالعروض'],
    ['لا تراسلوني'],
    ['لا تراسلوني ابدا'],
    ['لا تراسلنا من فضلك'],
    ['وقفوا الرسايل'],
    ['وقفوا الرسائل لو سمحتم'],
    ['لا ترسلوا لي رسائل ترويجية'],
    ['ستوب الرسائل'],
    ['وقف stop'],
    ['ايقاف الرسايل'],
    ['إلغاء الاشتراك في الرسائل'],
  ])('%j', async (input) => {
    const deps = makeDeps();
    await expect(run(deps, input)).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
  });

  test('the whole message is what is stored in the source, capped by the sentence limit', async () => {
    const deps = makeDeps();
    await run(deps, 'أبغى إلغاء الاشتراك');
    expect(deps.calls.withdraw[0].source.length).toBeLessThan(200);
  });
});

describe('negation guards: "keep my subscription" is NEVER an opt-out', () => {
  test.each([
    ['لا تلغي اشتراكي'],
    ['لا تلغون اشتراكي'],
    ['ما أبغى إلغاء الاشتراك'],
    ['لا أريد إلغاء الاشتراك'],
    ['لا أبغى إيقاف الرسائل'],
    ['لا تتوقف الخدمة عندكم؟'],
    ['لن ألغي الاشتراك'],
    ['بدون إلغاء الاشتراك'],
    ['ليس لدي نية إلغاء الاشتراك'],
    ['متى توقف العرض؟'],
    ['ليش وقف الموقع'],
    ['وين طلبي'],
    ['هل ممكن اشترك في العروض؟'],
    ['أبدًا'],
  ])('%j does not touch consent', async (input) => {
    const deps = makeDeps();
    await expect(run(deps, input)).resolves.toBe(false);
    expect(deps.calls.withdraw).toHaveLength(0);
    expect(deps.calls.sent).toHaveLength(0);
  });

  test('a long message that merely mentions the phrase is ignored', async () => {
    const deps = makeDeps();
    const long = `${'مرحبا '.repeat(30)} إلغاء الاشتراك`;
    await expect(run(deps, long)).resolves.toBe(false);
    expect(deps.calls.withdraw).toHaveLength(0);
  });

  test('refusal sentences without an object noun are not opt-outs ("I do not want the red one")', async () => {
    const deps = makeDeps();
    await expect(run(deps, 'لا أريد اللون الأحمر')).resolves.toBe(false);
    await expect(run(deps, 'لا ترسلوا الطلب اليوم')).resolves.toBe(false);
    expect(deps.calls.withdraw).toHaveLength(0);
  });

  test('classifier reports how it matched', () => {
    expect(classifyInboundText('توقف')).toMatchObject({ kind: 'opt_out', match: 'exact' });
    expect(classifyInboundText('أبغى إلغاء الاشتراك')).toMatchObject({ kind: 'opt_out', match: 'phrase' });
    expect(classifyInboundText('لا تلغي اشتراكي')).toBeNull();
  });
});

describe('opt-out wins over a pending flow (like English STOP), and the flow is left alone', () => {
  test.each([['pendingAddressReqs', 'cash'], ['pendingServiceCheckouts', {}], ['pendingPointsCheckouts', {}]])('with %s set', async (map, value) => {
    const deps = makeDeps({ pendingState: { [map]: new Map([[FROM, value]]) } });
    await expect(run(deps, 'إلغاء الاشتراك')).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
    expect(deps.state[map].has(FROM)).toBe(true); // untouched, as in the existing code
  });

  test('even the ambiguous bare "إلغاء" typed mid-checkout opts out (a missed opt-out is the worse error)', async () => {
    const deps = makeDeps({ pendingState: { pendingServiceCheckouts: new Map([[FROM, {}]]) }, enabled: true });
    const message = { type: 'text', text: { body: 'إلغاء' } };
    await expect(handleInbound({ workspaceId: WS, from: FROM, message }, deps)).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
    expect(message.text.body).toBe('إلغاء'); // never rewritten to NO
  });
});

describe('opt-out outcomes', () => {
  test('already opted out: acknowledged as such and no duplicate consent event is written', async () => {
    const deps = makeDeps({ customer: { _id: 'c1', phone: FROM, optedOut: true } });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.alreadyOptedOut'));
  });

  test('a failed withdrawal is retried once and then succeeds', async () => {
    const deps = makeDeps();
    let n = 0;
    deps.consent.withdrawMarketingConsent = jest.fn(async () => { n += 1; if (n === 1) throw new Error('429 throttled'); });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.consent.withdrawMarketingConsent).toHaveBeenCalledTimes(2);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.optOutAck'));
  });

  test('a withdrawal that keeps failing is NEVER acknowledged as success: neutral retry message + loud log + handled', async () => {
    const deps = makeDeps();
    deps.consent.withdrawMarketingConsent = jest.fn(async () => { throw new Error('db down'); });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.calls.sent).toEqual([{ to: FROM, body: catalog.t('ar', 'consent.tryAgain') }]);
    expect(deps.calls.sent[0].body).not.toBe(catalog.t('ar', 'consent.optOutAck'));
    expect(deps.log.mock.calls.some((c) => String(c[0]).includes('CONSENT WRITE FAILED'))).toBe(true);
  });

  test('a customer lookup failure on an opt-out is answered with the retry message, not dropped', async () => {
    const deps = makeDeps();
    deps.Customer.findOne = jest.fn(async () => { throw new Error('db down'); });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.tryAgain'));
    expect(deps.calls.withdraw).toHaveLength(0);
  });

  test('a flag-lookup failure does not cost the customer their opt-out', async () => {
    const deps = makeDeps();
    deps.settings.isArabicEnabled = jest.fn(async () => { throw new Error('flag db down'); });
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
  });

  test('a redelivered webhook (same message id) does not write a second consent event', async () => {
    const deps = makeDeps();
    const message = { id: 'wamid.X', type: 'text', text: { body: 'توقف' } };
    await expect(handleInbound({ workspaceId: WS, from: FROM, message }, deps)).resolves.toBe(true);
    await expect(handleInbound({ workspaceId: WS, from: FROM, message }, deps)).resolves.toBe(true);
    expect(deps.calls.withdraw).toHaveLength(1);
    expect(deps.calls.sent).toHaveLength(1);
  });

  test('a failed attempt is not remembered as handled (the redelivery gets another chance)', async () => {
    const deps = makeDeps();
    const message = { id: 'wamid.Y', type: 'text', text: { body: 'توقف' } };
    deps.consent.withdrawMarketingConsent = jest.fn(async () => { throw new Error('db down'); });
    await handleInbound({ workspaceId: WS, from: FROM, message }, deps);
    deps.consent.withdrawMarketingConsent = jest.fn(async (a) => { deps.calls.withdraw.push(a); });
    await handleInbound({ workspaceId: WS, from: FROM, message }, deps);
    expect(deps.calls.withdraw).toHaveLength(1);
  });

  test('works for a customer whose language is English or unknown (Arabic keywords from anyone)', async () => {
    const deps = makeDeps();
    deps.CustomerLanguage.findOne = jest.fn(() => ({ lean: async () => ({ language: 'en' }) }));
    await expect(run(deps, 'توقف')).resolves.toBe(true);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.optOutAck'));
  });
});

describe('typed opt-in / decline words — only while an ask is genuinely pending', () => {
  const AFFIRM = ['نعم', 'موافق', 'موافقة', 'أوافق', 'اوافق', 'نعم أوافق', 'نعم موافق', 'ايوه', 'أيوه'];
  const SUBSCRIBE = ['اشترك', 'اشتراك', 'تفعيل'];
  const DECLINE = ['لا', 'لا شكرا', 'غير موافق', 'كلا', 'لا أوافق'];
  const light = VARIANTS.filter(([name]) => ['plain', 'tashkeel (fatha after every letter)', 'tatweel (kashida)', 'alef -> alef with hamza above', 'guillemets', 'emoji', 'RLM / LRM marks around it', 'trailing punctuation'].includes(name));

  const optIn = [];
  for (const w of [...AFFIRM, ...SUBSCRIBE]) for (const [name, fn] of light) optIn.push([w, name, fn(w)]);
  test.each(optIn)('opt-in word %j (%s) grants consent when an ask is pending', async (w, name, input) => {
    const deps = makeDeps({ customer: askedCustomer() });
    await expect(run(deps, input)).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(1);
    expect(deps.calls.grant[0]).toMatchObject({ method: 'whatsapp_button', workspaceId: WS });
    expect(deps.calls.grant[0].source).toContain('typed');
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.optInAck'));
  });

  const declines = [];
  for (const w of DECLINE) for (const [name, fn] of light) declines.push([w, name, fn(w)]);
  test.each(declines)('decline word %j (%s) declines a pending ask', async (w, name, input) => {
    const deps = makeDeps({ customer: askedCustomer() });
    await expect(run(deps, input)).resolves.toBe(true);
    expect(deps.calls.decline).toHaveLength(1);
    expect(deps.calls.grant).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.declineAck'));
  });

  test.each([...AFFIRM, ...DECLINE].map((w) => [w]))('%j with NO pending ask is just conversation', async (w) => {
    const deps = makeDeps();
    await expect(run(deps, w)).resolves.toBe(false);
    expect(deps.calls.grant).toHaveLength(0);
    expect(deps.calls.decline).toHaveLength(0);
    expect(deps.calls.sent).toHaveLength(0);
  });

  test.each([
    ['older than 24h', askedCustomer({ marketingConsentAskedAt: new Date(NOW - 25 * 60 * 60 * 1000) })],
    ['already consented', askedCustomer({ marketingConsent: true })],
    ['opted out', askedCustomer({ optedOut: true })],
    ['never asked', askedCustomer({ marketingConsentAskedAt: null })],
  ])('an ask that is %s is not pending', async (name, customer) => {
    const deps = makeDeps({ customer });
    await expect(run(deps, 'نعم')).resolves.toBe(false);
    expect(deps.calls.grant).toHaveLength(0);
  });

  test('an ask that was already answered is not pending', async () => {
    const deps = makeDeps({ customer: askedCustomer() });
    deps.ConsentEvent.exists = jest.fn(async () => ({ _id: 'evt' }));
    await expect(run(deps, 'نعم')).resolves.toBe(false);
  });

  test.each([['pendingAddressReqs', 'cash'], ['pendingServiceCheckouts', {}], ['pendingPointsCheckouts', {}]])(
    'a bare نعم / لا belongs to the %s flow, not to the consent ask',
    async (map, value) => {
      for (const word of ['نعم', 'لا']) {
        const deps = makeDeps({ customer: askedCustomer(), pendingState: { [map]: new Map([[FROM, value]]) } });
        await expect(run(deps, word)).resolves.toBe(false);
        expect(deps.calls.grant).toHaveLength(0);
        expect(deps.calls.decline).toHaveLength(0);
      }
    },
  );

  test('a pending catalogue does not steal نعم (the catalogue ignores it anyway)', async () => {
    const deps = makeDeps({ customer: askedCustomer(), pendingState: { pendingCatalogs: new Map([[FROM, {}]]) } });
    await expect(run(deps, 'نعم')).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(1);
  });

  test('a write failure while granting is not acknowledged as success', async () => {
    const deps = makeDeps({ customer: askedCustomer() });
    deps.consent.grantMarketingConsent = jest.fn(async () => { throw new Error('db down'); });
    await expect(run(deps, 'نعم')).resolves.toBe(true);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.tryAgain'));
  });
});

describe('Arabic "subscribe" without a pending ask mirrors the English START rules', () => {
  test('reinstates someone who consented before and was opted out', async () => {
    const deps = makeDeps({ customer: { _id: 'c1', phone: FROM, marketingConsent: true, optedOut: true } });
    await expect(run(deps, 'اشترك')).resolves.toBe(true);
    expect(deps.calls.reinstate[0]).toMatchObject({ method: 'whatsapp_start_command' });
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.startAck'));
  });

  test('already subscribed: acknowledged, nothing written', async () => {
    const deps = makeDeps({ customer: { _id: 'c1', phone: FROM, marketingConsent: true, optedOut: false } });
    await expect(run(deps, 'اشترك')).resolves.toBe(true);
    expect(deps.calls.reinstate).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.alreadySubscribed'));
  });

  test('never fabricates consent for someone who never consented', async () => {
    const deps = makeDeps();
    deps.consent.reinstateMarketingConsent = jest.fn(async () => false);
    await expect(run(deps, 'اشتراك')).resolves.toBe(true);
    expect(deps.calls.grant).toHaveLength(0);
    expect(deps.calls.sent[0].body).toBe(catalog.t('ar', 'consent.startNoConsent'));
  });
});

describe('arabic orthography is consistent across the consent catalogue', () => {
  test('every Arabic consent string uses the website tanween style and is a draft needing legal approval', () => {
    const entries = catalog.listEntries().filter((e) => e.key.startsWith('consent.'));
    expect(entries.length).toBeGreaterThanOrEqual(13);
    for (const e of entries) {
      expect(e.ar).not.toMatch(/\u{064B}\u{0627}/u); // fathatan before alef is the old style; the website writes alef + fathatan
      expect(e.status).toBe('draft');
      expect(e.needsLegalApproval).toBe(true);
    }
  });

  test.each([['consent.buttonOptIn'], ['consent.buttonDecline'], ['consent.buttonOptOut']])('%s fits the 20-character button limit in both languages', (key) => {
    expect(Array.from(catalog.t('ar', key)).length).toBeLessThanOrEqual(20);
    expect(Array.from(catalog.t('en', key)).length).toBeLessThanOrEqual(20);
  });

  test('the spec labels are exact', () => {
    expect(catalog.t('ar', 'consent.buttonOptIn')).toBe('نعم، أوافق');
    expect(catalog.t('ar', 'consent.buttonDecline')).toBe('لا، شكراً');
    expect(catalog.t('ar', 'consent.buttonOptOut')).toBe('إلغاء الاشتراك');
  });
});
