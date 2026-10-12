// Pure unit tests of the Meta wire format and the Graph client. Nothing here can
// reach the network: the HTTP client is a fake, and the two existing modules that
// would (utils/whatsapp.js, utils/tokenManager.js) are replaced by factories that
// throw if anything ever loads them.
jest.mock('../../utils/whatsapp', () => { throw new Error('utils/whatsapp.js must not be loaded by these tests'); });
jest.mock('../../utils/tokenManager', () => { throw new Error('utils/tokenManager.js must not be loaded by these tests'); });

const mt = require('../../shared/localization/metaTemplates');
const { validateTemplateName } = require('../../shared/localization/metaConstraints');
const { LRM } = require('../../shared/localization/arabicText');
const { MissingMergeFieldError } = require('../../shared/localization/mergeFields');

const WS = '65a1b2c3d4e5f60718293a4b';
const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };
const AR_BODY = 'أهلاً {name}، رصيدك الحالي من النقاط: {points}. استبدلها قبل {date} واستمتع بمكافأتك.';
const arVariant = (over = {}) => ({ language: 'ar', body: AR_BODY, buttons: [OPT_OUT_AR], ...over });

describe('buildTemplateName', () => {
  const name = (over = {}) => mt.buildTemplateName({ workspaceId: WS, key: 'comeback', language: 'ar', revision: 1, fallbackId: WS, ...over });

  test('wf_<last 6 hex of the workspace>_<key>_<lang>_v<revision>', () => {
    expect(name()).toBe('wf_293a4b_comeback_ar_v1');
    expect(name({ language: 'en', revision: 12 })).toBe('wf_293a4b_comeback_en_v12');
    expect(name({ language: 'bilingual' })).toBe('wf_293a4b_comeback_bi_v1');
  });

  test('is always a valid Meta name: lowercase letters, digits, underscores, <= 512', () => {
    for (const key of ['Comeback Offer!', 'عرض نهاية الأسبوع', '🎉🎉', 'a'.repeat(300), '  spaced  out  ', 'Ünïcödé-Ñame', '___', 'x_y__z']) {
      for (const language of ['en', 'ar', 'bilingual']) {
        expect(validateTemplateName(name({ key, language })).ok).toBe(true);
      }
    }
  });

  test('uses an ASCII slug of the key (diacritics folded, symbols collapsed) capped at 40 characters', () => {
    expect(name({ key: 'Comeback Offer!' })).toBe('wf_293a4b_comeback_offer_ar_v1');
    expect(name({ key: 'Café déjà-vu' })).toBe('wf_293a4b_cafe_deja_vu_ar_v1');
    const long = name({ key: 'x'.repeat(100) });
    expect(long).toBe(`wf_293a4b_${'x'.repeat(40)}_ar_v1`);
  });

  test('an Arabic-only key falls back to a short base36 id derived from the template id (deterministic)', () => {
    const a = name({ key: 'عرض_نهاية_الاسبوع', fallbackId: '65a1b2c3d4e5f60718293a4b' });
    const b = name({ key: 'عرض_نهاية_الاسبوع', fallbackId: '65a1b2c3d4e5f60718293a4b' });
    const other = name({ key: 'عرض_نهاية_الاسبوع', fallbackId: '65a1b2c3d4e5f60718293fff' });
    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).toMatch(/^wf_293a4b_[a-z0-9]{1,8}_ar_v1$/);
    expect(a).toBe(`wf_293a4b_${parseInt('18293a4b', 16).toString(36)}_ar_v1`);
  });

  test('English and Arabic of the same template never share a name, and no revision is ever repeated', () => {
    const seen = new Set();
    for (const language of ['en', 'ar', 'bilingual']) {
      for (let revision = 1; revision <= 25; revision += 1) seen.add(name({ language, revision }));
    }
    expect(seen.size).toBe(75);
  });

  test('two workspaces never produce the same name for the same key (different id suffix)', () => {
    expect(name({ workspaceId: '65a1b2c3d4e5f60718293a4b' })).not.toBe(name({ workspaceId: '65a1b2c3d4e5f60718293a4c' }));
  });

  test('rejects unsupported languages and revisions', () => {
    expect(() => name({ language: 'fr' })).toThrow(/language/);
    expect(() => name({ revision: 0 })).toThrow(/revision/);
    expect(() => name({ revision: 1.5 })).toThrow(/revision/);
    expect(() => name({ revision: '2' })).toThrow(/revision/);
  });
});

describe('metaLanguageFor', () => {
  test('en/ar as is; bilingual follows the FIRST language', () => {
    expect(mt.metaLanguageFor({ language: 'en' })).toBe('en');
    expect(mt.metaLanguageFor({ language: 'ar' })).toBe('ar');
    expect(mt.metaLanguageFor({ language: 'bilingual', bilingualOrder: 'ar_first' })).toBe('ar');
    expect(mt.metaLanguageFor({ language: 'bilingual', bilingualOrder: 'en_first' })).toBe('en');
    expect(mt.metaLanguageFor({ language: 'bilingual' })).toBe('ar');
    expect(mt.metaLanguageFor({ language: 'fr' })).toBeNull();
    expect(mt.metaLanguageFor(null)).toBeNull();
  });
});

describe('buildSubmissionPayload', () => {
  const build = (variant, over = {}) => mt.buildSubmissionPayload({ name: 'wf_293a4b_comeback_ar_v1', variant, category: 'MARKETING', ...over });
  const component = (payload, type) => payload.components.find((c) => c.type === type);

  test('Arabic variant: language code ar, body positional with the Arabic text intact, Arabic examples', () => {
    const p = build(arVariant());
    expect(p.name).toBe('wf_293a4b_comeback_ar_v1');
    expect(p.language).toBe('ar');
    expect(p.category).toBe('MARKETING');
    expect(component(p, 'BODY')).toEqual({
      type: 'BODY',
      text: 'أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها قبل {{3}} واستمتع بمكافأتك.',
      example: { body_text: [['سارة', '120', '30 نوفمبر']] },
    });
  });

  test('English variant: language code en, English examples', () => {
    const p = build({ language: 'en', body: 'Hi {name}, you have {points} points to use before {date}.', buttons: [{ role: 'opt_out', text: 'Opt Out' }] });
    expect(p.language).toBe('en');
    expect(component(p, 'BODY').example).toEqual({ body_text: [['Sara', '120', '30 Nov']] });
  });

  test('every occurrence gets its own index (a field used twice is still valid)', () => {
    const p = build({ language: 'en', body: 'Hi {name}, {name} you win {points} points today.', buttons: [] }, { category: 'UTILITY' });
    expect(component(p, 'BODY').text).toBe('Hi {{1}}, {{2}} you win {{3}} points today.');
    expect(component(p, 'BODY').example.body_text[0]).toHaveLength(3);
  });

  test('unknown fields get a generic example in the variant language', () => {
    expect(component(build({ language: 'en', body: 'Your code is {coupon_zz} today ok.', buttons: [] }, { category: 'UTILITY' }), 'BODY').example).toEqual({ body_text: [['Example']] });
    expect(component(build({ language: 'ar', body: 'رمزك هو {coupon_zz} لهذا اليوم.', buttons: [] }, { category: 'UTILITY' }), 'BODY').example).toEqual({ body_text: [['مثال']] });
  });

  test('a body without variables has no example block (Meta rejects empty examples)', () => {
    const body = component(build({ language: 'ar', body: 'شكراً لزيارتك لنا اليوم.', buttons: [] }, { category: 'UTILITY' }), 'BODY');
    expect(body).toEqual({ type: 'BODY', text: 'شكراً لزيارتك لنا اليوم.' });
  });

  test('header text with one variable carries header_text; footer is plain; both optional', () => {
    const p = build(arVariant({ header: 'عرض خاص لك يا {name}', footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك' }));
    expect(component(p, 'HEADER')).toEqual({ type: 'HEADER', format: 'TEXT', text: 'عرض خاص لك يا {{1}}', example: { header_text: ['سارة'] } });
    expect(component(p, 'FOOTER')).toEqual({ type: 'FOOTER', text: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك' });
    const bare = build(arVariant());
    expect(component(bare, 'HEADER')).toBeUndefined();
    expect(component(bare, 'FOOTER')).toBeUndefined();
    expect(build(arVariant({ header: 'عرض خاص لك اليوم' })).components.find((c) => c.type === 'HEADER')).toEqual({ type: 'HEADER', format: 'TEXT', text: 'عرض خاص لك اليوم' });
  });

  test('no direction marks are ever submitted: not in the body, header, footer or button text, nor in the examples', () => {
    const marks = [0x200e, 0x200f, 0x061c, 0x202b, 0x2067].map((c) => String.fromCodePoint(c));
    const marked = (text) => `${marks[0]}${text}${marks[1]}${marks[2]}`;
    const payload = mt.buildSubmissionPayload({
      name: 'wf_x_a_ar_v1',
      variant: arVariant({ header: marked('عرض لك'), footer: marked('تذييل'), body: `${marks[3]}${AR_BODY}${marks[4]}`, buttons: [{ role: 'opt_out', text: marked('إلغاء الاشتراك') }, { role: 'url', text: marked('تسوق'), url: 'https://example.com/x' }] }),
    });
    const text = JSON.stringify(payload);
    for (const mark of marks) expect(text.includes(mark)).toBe(false);
    expect(payload.components.find((c) => c.type === 'BODY').text).toBe('أهلاً {{1}}، رصيدك الحالي من النقاط: {{2}}. استبدلها قبل {{3}} واستمتع بمكافأتك.');
    expect(payload.components.find((c) => c.type === 'BUTTONS').buttons).toEqual([{ type: 'QUICK_REPLY', text: 'إلغاء الاشتراك' }, { type: 'URL', text: 'تسوق', url: 'https://example.com/x' }]);
  });

  test('component order is HEADER, BODY, FOOTER, BUTTONS', () => {
    const p = build(arVariant({ header: 'عرض', footer: 'تذييل' }));
    expect(p.components.map((c) => c.type)).toEqual(['HEADER', 'BODY', 'FOOTER', 'BUTTONS']);
  });

  test('quick replies first, then URL buttons, each in its Meta shape', () => {
    const p = build(arVariant({ buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, OPT_OUT_AR, { role: 'url', text: 'تصفح العروض', url: 'https://waflowtech.com/offers' }] }));
    expect(component(p, 'BUTTONS').buttons).toEqual([
      { type: 'QUICK_REPLY', text: 'نعم، أوافق' },
      { type: 'QUICK_REPLY', text: 'إلغاء الاشتراك' },
      { type: 'URL', text: 'تصفح العروض', url: 'https://waflowtech.com/offers' },
    ]);
  });

  test('flow buttons are quick replies too; decline likewise', () => {
    const p = build(arVariant({ buttons: [{ role: 'flow_button', text: 'تسوق' }, { role: 'decline', text: 'لا، شكراً' }, OPT_OUT_AR] }));
    expect(component(p, 'BUTTONS').buttons.map((b) => b.type)).toEqual(['QUICK_REPLY', 'QUICK_REPLY', 'QUICK_REPLY']);
  });

  test('refuses what Meta would reject instead of emitting it', () => {
    expect(() => build(arVariant({ buttons: [{ role: 'url', text: 'x', url: 'https://example.com' }, OPT_OUT_AR] }))).toThrow(/before URL/);
    expect(() => build(arVariant({ buttons: [{ role: 'custom', text: 'x' }] }))).toThrow(/role/);
    expect(() => build(arVariant({ buttons: [null] }))).toThrow(/role/);
    expect(() => build(arVariant({ body: '   ' }))).toThrow(/body/);
    expect(() => build(arVariant(), { name: 'Bad Name' })).toThrow(/name/);
    expect(() => build(arVariant(), { category: 'AUTHENTICATION' })).toThrow(/category/);
    expect(() => build({ language: 'fr', body: 'x', buttons: [] })).toThrow(/language/);
  });

  test('bilingual: the code and example language follow the first language', () => {
    const body = 'مرحباً {name}، لدينا عرض لك.\n\nHello {name}, we have an offer for you.';
    const arFirst = build({ language: 'bilingual', bilingualOrder: 'ar_first', body, buttons: [OPT_OUT_AR] });
    expect(arFirst.language).toBe('ar');
    expect(component(arFirst, 'BODY').example.body_text).toEqual([['سارة', 'سارة']]);
    const enFirst = build({ language: 'bilingual', bilingualOrder: 'en_first', body, buttons: [OPT_OUT_AR] });
    expect(enFirst.language).toBe('en');
    expect(component(enFirst, 'BODY').example.body_text).toEqual([['Sara', 'Sara']]);
    expect(component(enFirst, 'BODY').text).toBe('مرحباً {{1}}، لدينا عرض لك.\n\nHello {{2}}, we have an offer for you.');
  });

  test('the input is not mutated and the payload survives JSON (Arabic byte-exact)', () => {
    const variant = arVariant({ footer: 'تذييل' });
    const before = JSON.stringify(variant);
    const p = build(variant);
    expect(JSON.stringify(variant)).toBe(before);
    const round = JSON.parse(JSON.stringify(p));
    expect(round).toEqual(p);
    expect(component(round, 'BODY').text).toContain('استبدلها قبل');
  });
});

describe('buildSendComponents', () => {
  const values = { name: 'Sara', points: 120, date: '30 Nov' };

  // Direction marks around parameter values are an unproven experiment: off by default (META-REALITY §4).
  const withLrm = (fn) => {
    process.env.LOCALIZATION_WRAP_PARAM_LRM = '1';
    try { fn(); } finally { delete process.env.LOCALIZATION_WRAP_PARAM_LRM; }
  };

  test('body parameters in order; button payloads by position; quick replies carry the payload (no direction marks by default)', () => {
    const c = mt.buildSendComponents({ variant: arVariant(), values, buttonPayloads: ['optout_abc'] });
    expect(c).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sara' }, { type: 'text', text: '120' }, { type: 'text', text: '30 Nov' }] },
      { type: 'button', sub_type: 'quick_reply', index: '0', parameters: [{ type: 'payload', payload: 'optout_abc' }] },
    ]);
  });

  test('Arabic: values go out as they are by default; with LOCALIZATION_WRAP_PARAM_LRM=1 Latin/number values (never URLs or Arabic) are wrapped', () => {
    const variant = arVariant({ body: 'أهلاً {name}، رابطك: {link} والرصيد {points} نقطة وكودك {code} اليوم.', buttons: [] });
    const given = { name: 'سارة', link: 'https://x.example/p', points: '5', code: 'AB12' };
    expect(mt.buildSendComponents({ variant, values: given })[0].parameters.map((p) => p.text)).toEqual(['سارة', 'https://x.example/p', '5', 'AB12']);
    withLrm(() => {
      expect(mt.buildSendComponents({ variant, values: given })[0].parameters.map((p) => p.text)).toEqual(['سارة', 'https://x.example/p', `${LRM}5${LRM}`, `${LRM}AB12${LRM}`]);
      const en = mt.buildSendComponents({ variant: { language: 'en', body: 'Hi {name}, you have {points} points today.', buttons: [] }, values });
      expect(en[0].parameters.map((p) => p.text)).toEqual(['Sara', '120']);
    });
  });

  test('bilingual: with the experiment on, only the parameters inside the Arabic paragraph are protected; off, none', () => {
    const variant = { language: 'bilingual', bilingualOrder: 'ar_first', body: 'مرحباً {name}، عرض لك اليوم.\n\nHello {name}, an offer for you today.', buttons: [] };
    expect(mt.buildSendComponents({ variant, values: { name: 'Sara' } })[0].parameters.map((p) => p.text)).toEqual(['Sara', 'Sara']);
    withLrm(() => {
      const c = mt.buildSendComponents({ variant, values: { name: 'Sara' } });
      expect(c[0].parameters.map((p) => p.text)).toEqual([`${LRM}Sara${LRM}`, 'Sara']);
      const enFirst = mt.buildSendComponents({ variant: { ...variant, bilingualOrder: 'en_first', body: 'Hello {name}, an offer for you today.\n\nمرحباً {name}، عرض لك اليوم.' }, values: { name: 'Sara' } });
      expect(enFirst[0].parameters.map((p) => p.text)).toEqual(['Sara', `${LRM}Sara${LRM}`]);
    });
  });

  test('a paragraph with no letters (only {link}) takes the first language of the variant', () => {
    expect(mt.occurrenceLanguages('{link}\n\nمرحباً {name} بك', 'bilingual', 'en_first')).toEqual(['en', 'ar']);
    expect(mt.occurrenceLanguages('{link}\n\nHello {name}', 'bilingual', 'ar_first')).toEqual(['ar', 'en']);
    expect(mt.occurrenceLanguages('Hi {a} {b}', 'en')).toEqual(['en', 'en']);
    expect(mt.occurrenceLanguages('مرحباً {a} {b}', 'ar')).toEqual(['ar', 'ar']);
    expect(mt.occurrenceLanguages('', 'ar')).toEqual([]);
  });

  test('a header variable becomes a header component before the body', () => {
    const c = mt.buildSendComponents({ variant: arVariant({ header: 'عرض لك يا {name}' }), values, buttonPayloads: ['optout_abc'] });
    expect(c.map((x) => x.type)).toEqual(['header', 'body', 'button']);
    expect(c[0].parameters).toEqual([{ type: 'text', text: 'Sara' }]);
  });

  test('no variables -> no body component at all', () => {
    expect(mt.buildSendComponents({ variant: { language: 'ar', body: 'شكراً لزيارتك لنا.', buttons: [] }, values: {} })).toEqual([]);
  });

  test('a missing or blank value throws instead of sending an empty parameter', () => {
    let error;
    try { mt.buildSendComponents({ variant: arVariant(), values: { name: 'Sara', points: '   ' }, buttonPayloads: ['x'] }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(MissingMergeFieldError);
    expect(error.fields).toEqual(['points', 'date']);
    expect(() => mt.buildSendComponents({ variant: arVariant(), values: undefined, buttonPayloads: ['x'] })).toThrow(MissingMergeFieldError);
  });

  test('values are sanitised for WhatsApp (no newlines, tabs or runs of spaces)', () => {
    const c = mt.buildSendComponents({ variant: { language: 'en', body: 'Hi {name}, welcome to the shop today.', buttons: [] }, values: { name: 'Sara\n\tAli    Hassan' } });
    expect(c[0].parameters[0].text).toBe('Sara Ali Hassan');
  });

  test('a field named like an Object.prototype member never resolves to an inherited value', () => {
    const variant = { language: 'en', body: 'Hello {constructor} and {toString} welcome today.', buttons: [] };
    let error;
    try { mt.buildSendComponents({ variant, values: {} }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(MissingMergeFieldError);
    expect(error.fields).toEqual(['constructor', 'toString']);
    expect(mt.buildSendComponents({ variant, values: { constructor: 'A', toString: 'B' } })[0].parameters.map((p) => p.text)).toEqual(['A', 'B']);
  });

  describe('button payloads', () => {
    const variant = arVariant({ buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }, OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'https://example.com' }] });
    const buttons = (c) => c.filter((x) => x.type === 'button');

    test('array aligned with the buttons (the shape sendCustomFlowTemplate uses); URL buttons need none', () => {
      const c = buttons(mt.buildSendComponents({ variant, values, buttonPayloads: ['consent_yes_1', 'consent_no_1', 'optout_9'] }));
      expect(c.map((x) => [x.index, x.parameters[0].payload])).toEqual([['0', 'consent_yes_1'], ['1', 'consent_no_1'], ['2', 'optout_9']]);
    });

    test('object keyed by role, by index, or with a function; index wins over role', () => {
      const byRole = buttons(mt.buildSendComponents({ variant, values, buttonPayloads: { opt_in: 'a', decline: 'b', opt_out: 'c' } }));
      expect(byRole.map((x) => x.parameters[0].payload)).toEqual(['a', 'b', 'c']);
      const mixed = buttons(mt.buildSendComponents({ variant, values, buttonPayloads: { 1: 'by-index', opt_in: 'a', decline: 'b', opt_out: (button, i) => `fn-${button.role}-${i}` } }));
      expect(mixed.map((x) => x.parameters[0].payload)).toEqual(['a', 'by-index', 'fn-opt_out-2']);
    });

    test('a quick reply without a usable payload is a hard error (a dead opt-out button is a compliance failure)', () => {
      for (const buttonPayloads of [undefined, null, [], ['a', 'b'], { opt_in: 'a', decline: 'b' }, ['a', 'b', ''], ['a', 'b', 5], 'optout']) {
        let error;
        try { mt.buildSendComponents({ variant, values, buttonPayloads }); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(mt.SendComponentsError);
        expect(error.code).toBe('BUTTON_PAYLOAD_MISSING');
      }
    });

    test(`a payload longer than ${mt.MAX_PAYLOAD_CHARS} characters is refused`, () => {
      let error;
      try { mt.buildSendComponents({ variant, values, buttonPayloads: ['a', 'b', 'x'.repeat(mt.MAX_PAYLOAD_CHARS + 1)] }); } catch (e) { error = e; }
      expect(error.code).toBe('BUTTON_PAYLOAD_TOO_LONG');
      expect(() => mt.buildSendComponents({ variant, values, buttonPayloads: ['a', 'b', 'x'.repeat(mt.MAX_PAYLOAD_CHARS)] })).not.toThrow();
    });

    test('the index is the button position in the template, so it matches what was submitted', () => {
      const onlyUrlFirst = arVariant({ buttons: [{ role: 'flow_button', text: 'تسوق' }, OPT_OUT_AR, { role: 'url', text: 'تصفح', url: 'https://example.com' }] });
      const c = buttons(mt.buildSendComponents({ variant: onlyUrlFirst, values, buttonPayloads: ['msgnode_n1_0', 'optout_c'] }));
      expect(c.map((x) => x.index)).toEqual(['0', '1']);
    });
  });
});

describe('Meta responses', () => {
  test.each([
    ['APPROVED', 'APPROVED'], ['pending', 'PENDING'], [' Rejected ', 'REJECTED'], ['PAUSED', 'PAUSED'], ['DISABLED', 'DISABLED'],
    ['IN_APPEAL', 'IN_APPEAL'], ['DELETED', 'DELETED'], ['PENDING_DELETION', 'PENDING_DELETION'], ['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED'], ['ARCHIVED', 'ARCHIVED'],
    // FLAGGED is a webhook event, not a status; anything unknown becomes the non-sendable ERROR (never a throw)
    ['FLAGGED', 'ERROR'], ['SOMETHING_NEW', 'ERROR'], ['__proto__', 'ERROR'], ['constructor', 'ERROR'],
    ['', null], ['  ', null], [undefined, null], [null, null],
  ])('status %j -> %j', (input, expected) => {
    expect(mt.mapMetaStatus(input)).toBe(expected);
  });

  test('every status the model enum stores is one mapMetaStatus can return, and the unknown ones are flagged unknown', () => {
    const { META_STATUSES } = require('../../models/LocalizedTemplate');
    for (const status of mt.KNOWN_STATUSES) expect(META_STATUSES).toContain(mt.mapMetaStatus(status));
    expect(META_STATUSES).toContain(mt.mapMetaStatus('SOMETHING_NEW'));
    expect(mt.isKnownMetaStatus('approved')).toBe(true);
    expect(mt.isKnownMetaStatus('FLAGGED')).toBe(false);
  });

  test('quality_score: Graph sends { score } (or a bare string); nothing usable is null', () => {
    expect(mt.cleanQualityScore({ score: 'green', date: 1 })).toBe('GREEN');
    expect(mt.cleanQualityScore('RED')).toBe('RED');
    expect(mt.cleanQualityScore(undefined)).toBeNull();
    expect(mt.cleanQualityScore({})).toBeNull();
  });

  test('rejected_reason: "NONE" means not rejected', () => {
    expect(mt.cleanRejectedReason('NONE')).toBeNull();
    expect(mt.cleanRejectedReason('none')).toBeNull();
    expect(mt.cleanRejectedReason('')).toBeNull();
    expect(mt.cleanRejectedReason(undefined)).toBeNull();
    expect(mt.cleanRejectedReason('INVALID_FORMAT')).toBe('INVALID_FORMAT');
  });

  describe('sanitizeMetaError (upstream text is shown to merchants)', () => {
    const graph = (error) => ({ response: { status: 400, data: { error } } });

    test('code, subcode and the most helpful message', () => {
      expect(mt.sanitizeMetaError(graph({ message: 'Invalid parameter', code: 100, error_subcode: 2388023, error_user_title: 'Title', error_user_msg: 'The template already exists.' })))
        .toEqual({ code: 100, subcode: 2388023, message: 'The template already exists.' });
      expect(mt.sanitizeMetaError(graph({ message: 'Invalid parameter', code: '100', error_user_title: 'Bad content' }))).toEqual({ code: 100, message: 'Bad content' });
      expect(mt.sanitizeMetaError(graph({ message: 'Invalid parameter' }))).toEqual({ message: 'Invalid parameter' });
      expect(mt.sanitizeMetaError(graph({}))).toEqual({ message: 'WhatsApp (Meta) rejected the request' });
    });

    test('secrets, control characters and bidi marks are stripped; length is capped', () => {
      const out = mt.sanitizeMetaError(graph({
        message: `Bad token Bearer EAAGm0PX4ZCpsBAKZB1234567890abcdef and access_token=EAAxyz123&x=1 \u{0007}bell\u{202E}rtl\u{200F}mark\nnew\tline ${'long '.repeat(200)}`,
        code: 190,
      }));
      expect(out.code).toBe(190);
      expect(out.message).not.toMatch(/EAA/);
      expect(out.message).not.toMatch(/access_token=EA/);
      expect(out.message).not.toMatch(/[\u{0000}-\u{001F}\u{202A}-\u{202E}\u{200B}-\u{200F}]/u);
      expect(out.message).toContain('[redacted]');
      expect(Array.from(out.message).length).toBeLessThanOrEqual(300);
    });

    test('anything that is not a Graph error body becomes a generic message (never the raw error, a stack or the request config)', () => {
      const generic = { message: 'Could not reach WhatsApp (Meta). Please try again.' };
      expect(mt.sanitizeMetaError(new Error('getaddrinfo ENOTFOUND graph.facebook.com'))).toEqual(generic);
      expect(mt.sanitizeMetaError({ response: { status: 502, data: '<html>Bad gateway</html>' } })).toEqual(generic);
      expect(mt.sanitizeMetaError({ response: { data: { error: 'a string' } } })).toEqual(generic);
      expect(mt.sanitizeMetaError({ response: { data: { error: { message: { nested: 'object' } } } } })).toEqual({ message: 'WhatsApp (Meta) rejected the request' });
      expect(mt.sanitizeMetaError(null)).toEqual(generic);
      const secretConfig = { config: { headers: { Authorization: 'Bearer EAASECRETSECRETSECRETSECRET' } }, message: 'boom' };
      expect(JSON.stringify(mt.sanitizeMetaError(secretConfig))).not.toMatch(/SECRET/);
    });
  });
});

describe('createMetaClient', () => {
  const ok = (data) => ({ data });
  function makeClient(over = {}) {
    const http = {
      post: jest.fn(async () => ok({ id: '555', status: 'PENDING', category: 'MARKETING' })),
      get: jest.fn(async () => ok({ data: [] })),
      delete: jest.fn(() => { throw new Error('delete must never be called'); }),
      put: jest.fn(() => { throw new Error('put must never be called'); }),
      ...over.http,
    };
    const client = mt.createMetaClient({ http, getToken: () => 'TOKEN123', getWabaId: async () => '999000111', ...over.deps });
    return { http, client };
  }

  afterEach(() => { delete process.env.LOCALIZATION_SEND_MODE; });

  describe('submitTemplate', () => {
    test('POSTs the payload to {graph}/{waba}/message_templates with a bearer token and a timeout', async () => {
      const { http, client } = makeClient();
      const payload = mt.buildSubmissionPayload({ name: 'wf_x_a_ar_v1', variant: arVariant(), category: 'MARKETING' });
      await expect(client.submitTemplate(payload)).resolves.toEqual({ id: '555', status: 'PENDING', category: 'MARKETING' });
      expect(http.post).toHaveBeenCalledTimes(1);
      const [url, body, config] = http.post.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/999000111/message_templates');
      expect(body).toBe(payload);
      expect(config.headers).toEqual({ Authorization: 'Bearer TOKEN123', 'Content-Type': 'application/json' });
      expect(config.timeout).toBeGreaterThan(0);
    });

    test('normalises the response (upper-case status/category; tolerates a missing id)', async () => {
      const { client } = makeClient({ http: { post: jest.fn(async () => ok({ status: 'approved', category: 'utility' })) } });
      await expect(client.submitTemplate({})).resolves.toEqual({ id: null, status: 'APPROVED', category: 'UTILITY' });
      const { client: empty } = makeClient({ http: { post: jest.fn(async () => ok(undefined)) } });
      await expect(empty.submitTemplate({})).resolves.toEqual({ id: null, status: null, category: null });
    });

    test('a Graph error becomes a MetaApiError with a sanitised body (no request config, no token)', async () => {
      const err = Object.assign(new Error('Request failed with status code 400'), {
        config: { headers: { Authorization: 'Bearer TOKEN123' } },
        response: { status: 400, data: { error: { message: 'Invalid parameter', code: 100, error_subcode: 2388023, error_user_msg: 'Template exists, Bearer TOKEN123abc' } } },
      });
      const { client } = makeClient({ http: { post: jest.fn(async () => { throw err; }) } });
      let caught;
      try { await client.submitTemplate({}); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(mt.MetaApiError);
      expect(caught.httpStatus).toBe(400);
      expect(caught.metaError).toEqual({ code: 100, subcode: 2388023, message: 'Template exists, [redacted]' });
      expect(JSON.stringify(caught.metaError)).not.toMatch(/TOKEN123/);
    });

    test('a network failure becomes a generic MetaApiError', async () => {
      const { client } = makeClient({ http: { post: jest.fn(async () => { throw new Error('ECONNRESET'); }) } });
      await expect(client.submitTemplate({})).rejects.toMatchObject({ name: 'MetaApiError', metaError: { message: 'Could not reach WhatsApp (Meta). Please try again.' } });
    });
  });

  describe('credentials', () => {
    test.each([['no token', { getToken: () => '' }], ['non-string token', { getToken: () => null }], ['token lookup throws', { getToken: () => { throw new Error('x'); } }]])('%s -> MetaNotConfiguredError, nothing is sent', async (_, deps) => {
      const { http, client } = makeClient({ deps });
      await expect(client.assertConfigured()).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.submitTemplate({})).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.listTemplatesByName('x')).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      expect(http.post).not.toHaveBeenCalled();
      expect(http.get).not.toHaveBeenCalled();
    });

    test.each([['cannot be detected', async () => { throw new Error('Cannot detect WABA ID'); }], ['empty', async () => ''], ['null', async () => null], ['path-injection', async () => '123/../../me'], ['query-injection', async () => '1?access_token=x'], ['too long', async () => '1'.repeat(65)]])('WABA id %s -> MetaNotConfiguredError', async (_, getWabaId) => {
      const { http, client } = makeClient({ deps: { getWabaId } });
      await expect(client.assertConfigured()).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.submitTemplate({})).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      expect(http.post).not.toHaveBeenCalled();
    });

    test('configured: assertConfigured resolves true (and works with async token getters)', async () => {
      const { client } = makeClient({ deps: { getToken: async () => 'T' } });
      await expect(client.assertConfigured()).resolves.toBe(true);
    });

    test('dry-run mode can never reach Graph, even if a caller forgets to check', async () => {
      process.env.LOCALIZATION_SEND_MODE = 'dry_run';
      const { http, client } = makeClient();
      await expect(client.submitTemplate({})).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.listTemplatesByName('x')).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.assertConfigured()).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      expect(http.post).not.toHaveBeenCalled();
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  describe('listTemplatesByName', () => {
    test('GETs by name with the fields the refresh needs and returns the rows', async () => {
      const rows = [{ id: '1', name: 'wf_x_ar_v1', status: 'APPROVED', language: 'ar' }];
      const { http, client } = makeClient({ http: { get: jest.fn(async () => ok({ data: rows })) } });
      await expect(client.listTemplatesByName('wf_x_ar_v1')).resolves.toEqual(rows);
      const [url, config] = http.get.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/999000111/message_templates');
      expect(config.params).toEqual({ name: 'wf_x_ar_v1', fields: 'id,name,status,category,previous_category,language,rejected_reason,quality_score,last_updated_time', limit: 100 });
      expect(config.params.fields).not.toContain('components');
      expect(config.headers.Authorization).toBe('Bearer TOKEN123');
    });

    test('follows paging.next (without re-sending params) until there is no next page', async () => {
      const pages = [
        { data: [{ id: '1' }], paging: { next: 'https://graph.facebook.com/v25.0/999000111/message_templates?after=A' } },
        { data: [{ id: '2' }], paging: { next: 'https://graph.facebook.com/v25.0/999000111/message_templates?after=B' } },
        { data: [{ id: '3' }] },
      ];
      const get = jest.fn(async () => ok(pages.shift()));
      const { client } = makeClient({ http: { get } });
      await expect(client.listTemplatesByName('x')).resolves.toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
      expect(get).toHaveBeenCalledTimes(3);
      expect(get.mock.calls[1][0]).toContain('after=A');
      expect(get.mock.calls[1][1].params).toBeUndefined();
    });

    test('never follows a paging link that leaves Graph (the link carries credentials), or a malformed one', async () => {
      for (const next of ['https://evil.example.com/steal?x=1', 'http://graph.facebook.com/v25.0/x', 'not a url', 'https://graph.facebook.com.evil.com/x']) {
        const get = jest.fn(async () => ok({ data: [{ id: '1' }], paging: { next } }));
        const { client } = makeClient({ http: { get } });
        await expect(client.listTemplatesByName('x')).resolves.toEqual([{ id: '1' }]);
        expect(get).toHaveBeenCalledTimes(1);
      }
    });

    test('a runaway paging chain stops after 10 pages', async () => {
      const get = jest.fn(async () => ok({ data: [{ id: 'r' }], paging: { next: 'https://graph.facebook.com/v25.0/999000111/message_templates?after=again' } }));
      const { client } = makeClient({ http: { get } });
      const rows = await client.listTemplatesByName('x');
      expect(get).toHaveBeenCalledTimes(10);
      expect(rows).toHaveLength(10);
    });

    test('a malformed body is an empty list; an error is a MetaApiError', async () => {
      const { client } = makeClient({ http: { get: jest.fn(async () => ok({ data: 'nope' })) } });
      await expect(client.listTemplatesByName('x')).resolves.toEqual([]);
      const { client: failing } = makeClient({ http: { get: jest.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { error: { message: 'Unsupported get request', code: 100 } } } }); }) } });
      await expect(failing.listTemplatesByName('x')).rejects.toMatchObject({ name: 'MetaApiError', metaError: { code: 100, message: 'Unsupported get request' } });
    });
  });

  describe('getTemplateById (the exact, cheap poll)', () => {
    test('GET /{id} with the status fields; the row carries the id it was asked for', async () => {
      const { http, client } = makeClient({ http: { get: jest.fn(async () => ok({ name: 'wf_x_ar_v1', status: 'APPROVED', language: 'ar', category: 'MARKETING', previous_category: 'UTILITY', rejected_reason: 'NONE' })) } });
      await expect(client.getTemplateById('12345')).resolves.toMatchObject({ id: '12345', status: 'APPROVED', previous_category: 'UTILITY' });
      const [url, config] = http.get.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/12345');
      expect(config.params).toEqual({ fields: 'name,status,category,previous_category,language,rejected_reason,quality_score,last_updated_time' });
      expect(config.headers.Authorization).toBe('Bearer TOKEN123');
    });

    test.each([['../me'], ['1/2'], ['1?x=y'], [''], ['1'.repeat(65)], [undefined]])('id %j is refused before anything is sent (path injection)', async (id) => {
      const { http, client } = makeClient();
      await expect(client.getTemplateById(id)).rejects.toBeInstanceOf(mt.MetaApiError);
      expect(http.get).not.toHaveBeenCalled();
    });

    test('a 404 is null; any other error is a MetaApiError carrying the Graph code', async () => {
      const fail = (status, error) => makeClient({ http: { get: jest.fn(async () => { throw Object.assign(new Error('x'), { response: { status, data: { error } } }); }) } }).client;
      await expect(fail(404, { message: 'gone', code: 100 }).getTemplateById('1')).resolves.toBeNull();
      await expect(fail(400, { message: 'Unsupported get request', code: 100, error_subcode: 33 }).getTemplateById('1')).rejects.toMatchObject({ metaError: { code: 100, subcode: 33 } });
    });
  });

  describe('listTemplatesSince (the delta sweep)', () => {
    test('passes since (unix seconds, 5 minutes earlier), the sweep fields (never components) and limit 100', async () => {
      const { http, client } = makeClient({ http: { get: jest.fn(async () => ok({ data: [{ id: '1' }] })) } });
      await expect(client.listTemplatesSince({ since: new Date('2026-10-12T10:00:00Z') })).resolves.toEqual([{ id: '1' }]);
      const [url, config] = http.get.mock.calls[0];
      expect(url).toBe('https://graph.facebook.com/v25.0/999000111/message_templates');
      expect(config.params).toEqual({ fields: 'id,name,status,category,previous_category,language,rejected_reason,quality_score,last_updated_time', limit: 100, since: Math.floor(Date.parse('2026-10-12T10:00:00Z') / 1000) - 300 });
      expect(config.params.fields).not.toContain('components');
    });

    test('no usable since means a full sweep; ISO strings and unix seconds are accepted', async () => {
      const { http, client } = makeClient();
      await client.listTemplatesSince({});
      await client.listTemplatesSince({ since: 'not a date' });
      expect(http.get.mock.calls.every(([, c]) => c.params.since === undefined)).toBe(true);
      await client.listTemplatesSince({ since: '2026-10-12T10:00:00Z' });
      await client.listTemplatesSince({ since: 1791799200 });
      expect(http.get.mock.calls[2][1].params.since).toBe(1791799200 - 300);
      expect(http.get.mock.calls[3][1].params.since).toBe(1791799200 - 300);
    });

    test('follows paging.cursors.after until there is no next page; stops at 20 pages', async () => {
      const pages = [
        { data: [{ id: '1' }], paging: { cursors: { after: 'A' }, next: 'https://graph.facebook.com/x?after=A' } },
        { data: [{ id: '2' }], paging: { cursors: { after: 'B' }, next: 'https://graph.facebook.com/x?after=B' } },
        { data: [{ id: '3' }], paging: { cursors: { after: 'C' } } },
      ];
      const get = jest.fn(async () => ok(pages.shift()));
      const { client } = makeClient({ http: { get } });
      await expect(client.listTemplatesSince({})).resolves.toEqual([{ id: '1' }, { id: '2' }, { id: '3' }]);
      expect(get.mock.calls.map(([, c]) => c.params.after)).toEqual([undefined, 'A', 'B']);
      const runaway = jest.fn(async () => ok({ data: [{ id: 'r' }], paging: { cursors: { after: 'again' }, next: 'https://graph.facebook.com/x' } }));
      const { client: endless } = makeClient({ http: { get: runaway } });
      expect(await endless.listTemplatesSince({})).toHaveLength(20);
    });
  });

  describe('getUsage', () => {
    test('reads summary.total_count and message_template_limit from a one-row list', async () => {
      const { http, client } = makeClient({ http: { get: jest.fn(async () => ok({ data: [], summary: { total_count: 15, message_template_limit: 250 } })) } });
      await expect(client.getUsage()).resolves.toEqual({ used: 15, limit: 250 });
      expect(http.get.mock.calls[0][1].params).toEqual({ summary: 'total_count,message_template_limit', fields: 'id', limit: 1 });
    });

    test('missing or garbage numbers are null; errors are MetaApiError', async () => {
      const { client } = makeClient({ http: { get: jest.fn(async () => ok({ summary: { total_count: 'x', message_template_limit: null } })) } });
      await expect(client.getUsage()).resolves.toEqual({ used: null, limit: null });
      const { client: failing } = makeClient({ http: { get: jest.fn(async () => { throw new Error('ECONNRESET'); }) } });
      await expect(failing.getUsage()).rejects.toBeInstanceOf(mt.MetaApiError);
    });

    test('not configured / dry-run: nothing is sent', async () => {
      const { http, client } = makeClient({ deps: { getToken: () => '' } });
      await expect(client.getUsage()).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.getTemplateById('1')).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      await expect(client.listTemplatesSince({})).rejects.toBeInstanceOf(mt.MetaNotConfiguredError);
      expect(http.get).not.toHaveBeenCalled();
    });
  });

  test('the client has no way to delete or edit a template at Meta (names are never recycled)', async () => {
    const { client, http } = makeClient();
    expect(Object.keys(client).sort()).toEqual(['assertConfigured', 'getTemplateById', 'getUsage', 'listTemplatesByName', 'listTemplatesSince', 'submitTemplate']);
    await client.submitTemplate({});
    await client.listTemplatesByName('x');
    await client.getUsage();
    await client.getTemplateById('1');
    await client.listTemplatesSince({});
    expect(http.delete).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
  });

  test('creating a client with injected dependencies never loads the real WhatsApp modules', async () => {
    const { client } = makeClient();
    await client.assertConfigured();
    await client.submitTemplate({});
    // utils/whatsapp.js and utils/tokenManager.js are mocked to throw on load at the top of this file.
    expect(true).toBe(true);
  });
});
