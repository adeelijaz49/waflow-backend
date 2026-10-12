const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for the inbound consent hook (slice B10):
// shared/localization/inboundHook.handleInbound driven with the REAL Customer,
// ConsentEvent and CustomerLanguage models and the real shared/consent.js.
// Replies go through the real transport.js in dry-run, so they are captured, never sent.
const fx = require('./_fixtures');
const crypto = require('crypto');
const hook = require('../../../shared/localization/inboundHook');
const settings = require('../../../shared/localization/settings');
const transport = require('../../../shared/localization/transport');
const Customer = require('../../../models/Customer');
const ConsentEvent = require('../../../models/ConsentEvent');
const CustomerLanguage = require('../../../models/CustomerLanguage');

jest.setTimeout(60000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { transport.clearDryRuns(); hook.resetHandled(); });

const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
const textMsg = (body) => ({ id: wid(), type: 'text', text: { body } });
const templateTap = (payload, title) => ({ id: wid(), type: 'button', button: { payload, text: title } });
const replyTap = (id, title) => ({ id: wid(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
const RLM = String.fromCodePoint(0x200f);

function deps(over = {}) { return { ...hook.realDeps(), log: () => {}, sleep: async () => {}, ...over }; }
const inbound = (ws, customer, message, d = deps()) => hook.handleInbound({ workspaceId: ws.workspaceId, from: customer.phone, message, contactName: 'x' }, d);
const events = (customer) => ConsentEvent.find({ customerId: customer._id }).sort({ createdAt: 1 }).lean();
const sentTo = (phone) => transport.lastDryRuns().filter((d) => d.payload.to === phone).map((d) => d.payload.text && d.payload.text.body);

describe('typed Arabic opt-out keywords (always on, flag-independent)', () => {
  test.each([
    ['إلغاء الاشتراك'], ['توقف'], ['ستوب'], ['  توقف  '], ['إلغاء الاشتراك.'], ['ايقاف'],
  ])('%s opts the customer out, logs the event first, replies in Arabic and stops the webhook', async (word) => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, { marketingConsent: true });
    expect(await inbound(ws, c, textMsg(word))).toBe(true);
    const after = await Customer.findById(c._id).lean();
    expect(after.optedOut).toBe(true);
    expect(after.optedOutAt).toBeTruthy();
    const ev = await events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ type: 'consent_withdrawn', method: 'whatsapp_stop_command', workspaceId: ws.workspaceId, phone: c.phone });
    expect(ev[0].source).toContain('Arabic reply');
    const replies = sentTo(c.phone);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/\p{Script=Arabic}{3,}/u);
  });

  test('repeating it does not write a second event; the customer is told they are already out; a redelivery is ignored', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId);
    const first = textMsg('توقف');
    expect(await inbound(ws, c, first)).toBe(true);
    expect(await inbound(ws, c, first)).toBe(true); // Meta redelivery of the SAME message id
    expect(await events(c)).toHaveLength(1);
    expect(sentTo(c.phone)).toHaveLength(1);
    expect(await inbound(ws, c, textMsg('توقف'))).toBe(true); // a new message
    expect(await events(c)).toHaveLength(1);
    expect(sentTo(c.phone)).toHaveLength(2);
  });

  test('negation and ordinary Arabic sentences are NOT opt-outs', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId);
    for (const body of ['لا تلغي اشتراكي', 'أريد قهوة', 'متى تفتحون غدا؟', 'شكرا لكم']) {
      expect(await inbound(ws, c, textMsg(body))).toBe(false);
    }
    expect((await Customer.findById(c._id).lean()).optedOut).not.toBe(true);
    expect(await events(c)).toHaveLength(0);
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('an English STOP with an RTL direction mark (U+200F) is honoured; a plain English STOP is left to the existing handler', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const marked = await fx.makeCustomer(ws.workspaceId);
    const plain = await fx.makeCustomer(ws.workspaceId);
    expect(await inbound(ws, marked, textMsg(`STOP${RLM}`))).toBe(true);
    expect((await Customer.findById(marked._id).lean()).optedOut).toBe(true);
    expect(await inbound(ws, plain, textMsg('STOP'))).toBe(false);
    expect(await inbound(ws, plain, textMsg('stop'))).toBe(false);
    expect((await Customer.findById(plain._id).lean()).optedOut).not.toBe(true);
    expect(await events(plain)).toHaveLength(0);
  });

  test('the same phone in two workspaces: opting out in one never touches the other', async () => {
    const a = await fx.makeWorkspace({ arabic: false }); const b = await fx.makeWorkspace({ arabic: false });
    const phone = fx.nextPhone();
    const ca = await fx.makeCustomer(a.workspaceId, { phone }); const cb = await fx.makeCustomer(b.workspaceId, { phone });
    expect(await inbound(a, ca, textMsg('إلغاء الاشتراك'))).toBe(true);
    expect((await Customer.findById(ca._id).lean()).optedOut).toBe(true);
    expect((await Customer.findById(cb._id).lean()).optedOut).not.toBe(true);
    expect(await events(cb)).toHaveLength(0);
  });

  test('an unknown number typing an opt-out is answered and the hook does not crash (nothing to write)', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const ghost = { phone: fx.nextPhone() };
    expect(await inbound(ws, ghost, textMsg('توقف'))).toBe(true);
    expect(sentTo(ghost.phone)).toHaveLength(1);
  });

  test('a failing consent write is retried once, then the customer is asked to retry (never a false success) and a redelivery may try again', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId);
    const real = hook.realDeps();
    let calls = 0;
    const failing = deps({ consent: { ...real.consent, withdrawMarketingConsent: async () => { calls += 1; throw new Error('cosmos 429'); } } });
    const message = textMsg('توقف');
    expect(await inbound(ws, c, message, failing)).toBe(true);
    expect(calls).toBe(2);
    expect((await Customer.findById(c._id).lean()).optedOut).not.toBe(true);
    // redelivery with a healthy database now succeeds (a failed attempt is not remembered as handled)
    expect(await inbound(ws, c, message)).toBe(true);
    expect((await Customer.findById(c._id).lean()).optedOut).toBe(true);
    expect(sentTo(c.phone)).toHaveLength(2);
  });
});

describe('typed opt-in / decline words only count while a consent ask is pending', () => {
  const askedNow = () => ({ marketingConsent: false, marketingConsentAskedAt: new Date() });

  test('"نعم" with a pending ask grants consent (ConsentEvent first) and replies; a second "نعم" changes nothing', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, askedNow());
    expect(await inbound(ws, c, textMsg('نعم'))).toBe(true);
    const after = await Customer.findById(c._id).lean();
    expect(after.marketingConsent).toBe(true);
    expect(after.marketingConsentMethod).toBe('whatsapp_button');
    expect((await events(c)).map((e) => e.type)).toEqual(['consent_given']);
    expect(await inbound(ws, c, textMsg('نعم'))).toBe(false); // nothing pending any more: ordinary conversation
    expect(await events(c)).toHaveLength(1);
  });

  test('"لا" with a pending ask records a decline without opting the customer out', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, askedNow());
    expect(await inbound(ws, c, textMsg('لا'))).toBe(true);
    expect((await events(c)).map((e) => e.type)).toEqual(['consent_declined']);
    const after = await Customer.findById(c._id).lean();
    expect(after.optedOut).not.toBe(true);
    expect(after.marketingConsent).not.toBe(true);
  });

  test('without a pending ask, an ask older than 24h, or a text-consuming flow waiting on the phone, "نعم" is left alone', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const none = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    const stale = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, marketingConsentAskedAt: new Date(Date.now() - 25 * 3600 * 1000) });
    const busy = await fx.makeCustomer(ws.workspaceId, askedNow());
    expect(await inbound(ws, none, textMsg('نعم'))).toBe(false);
    expect(await inbound(ws, stale, textMsg('نعم'))).toBe(false);
    const state = require('../../../utils/state');
    state.pendingAddressReqs.set(busy.phone, { fake: true });
    try {
      expect(await inbound(ws, busy, textMsg('نعم'))).toBe(false);
    } finally { state.pendingAddressReqs.delete(busy.phone); }
    for (const c of [none, stale, busy]) {
      expect(await events(c)).toHaveLength(0);
      expect((await Customer.findById(c._id).lean()).marketingConsent).not.toBe(true);
    }
  });

  test('"اشترك" (START-like) never fabricates consent for someone who never consented', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const never = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    expect(await inbound(ws, never, textMsg('اشترك'))).toBe(true);
    expect((await Customer.findById(never._id).lean()).marketingConsent).not.toBe(true);
    expect(await events(never)).toHaveLength(0);
    // someone who consented, opted out, and now comes back IS reinstated (and logged)
    const back = await fx.makeCustomer(ws.workspaceId, { marketingConsent: true, optedOut: true, optedOutAt: new Date() });
    expect(await inbound(ws, back, textMsg('اشترك'))).toBe(true);
    expect((await Customer.findById(back._id).lean()).optedOut).toBe(false);
    expect((await events(back)).map((e) => e.type)).toEqual(['consent_reinstated']);
  });
});

describe('Arabic button taps', () => {
  test('an Arabic-language customer tapping the opt-in / decline / opt-out buttons gets the same consent writes, answered in Arabic', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const yes = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'ar' });
    const no = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'ar' });
    const out = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
    expect(await inbound(ws, yes, templateTap(`consent_yes_${yes._id}`, 'نعم، سجلني'))).toBe(true);
    expect(await inbound(ws, no, replyTap(`consent_no_${no._id}`, 'لا شكراً'))).toBe(true);
    expect(await inbound(ws, out, templateTap(`optout_${new (require('mongoose').Types.ObjectId)()}`, 'إلغاء الاشتراك'))).toBe(true);
    expect((await Customer.findById(yes._id).lean()).marketingConsent).toBe(true);
    expect((await events(yes)).map((e) => [e.type, e.method])).toEqual([['consent_given', 'whatsapp_button']]);
    expect((await events(no)).map((e) => e.type)).toEqual(['consent_declined']);
    expect((await Customer.findById(no._id).lean()).marketingConsent).not.toBe(true);
    expect((await Customer.findById(out._id).lean()).optedOut).toBe(true);
    expect((await events(out)).map((e) => [e.type, e.method])).toEqual([['consent_withdrawn', 'whatsapp_optout_button']]);
    for (const c of [yes, no, out]) expect(sentTo(c.phone)[0]).toMatch(/\p{Script=Arabic}{3,}/u);
  });

  test('an English customer tapping an English-titled button falls through untouched', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const en = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'en' });
    const unknown = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    expect(await inbound(ws, en, templateTap(`consent_yes_${en._id}`, 'Yes, sign me up'))).toBe(false);
    expect(await inbound(ws, unknown, replyTap(`consent_yes_${unknown._id}`, 'Yes, sign me up'))).toBe(false);
    expect(await inbound(ws, en, templateTap('optout_507f1f77bcf86cd799439011', 'Opt out'))).toBe(false);
    for (const c of [en, unknown]) {
      expect(await events(c)).toHaveLength(0);
      expect((await Customer.findById(c._id).lean()).marketingConsent).not.toBe(true);
    }
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('a payload naming ANOTHER customer or another workspace is ignored', async () => {
    const a = await fx.makeWorkspace({ arabic: false }); const b = await fx.makeWorkspace({ arabic: false });
    const sender = await fx.makeCustomer(a.workspaceId, { language: 'ar' });
    const victim = await fx.makeCustomer(a.workspaceId, { marketingConsent: false, language: 'ar' });
    const foreign = await fx.makeCustomer(b.workspaceId, { marketingConsent: false, language: 'ar' });
    expect(await inbound(a, sender, templateTap(`consent_yes_${victim._id}`, 'نعم'))).toBe(false);
    expect(await inbound(a, sender, templateTap(`consent_yes_${foreign._id}`, 'نعم'))).toBe(false);
    expect(await inbound(a, sender, templateTap('consent_yes_not-an-id', 'نعم'))).toBe(false);
    for (const c of [victim, foreign]) {
      expect((await Customer.findById(c._id).lean()).marketingConsent).not.toBe(true);
      expect(await events(c)).toHaveLength(0);
    }
  });

  test('the same tap delivered twice writes one event and sends one reply', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, language: 'ar' });
    const tap = templateTap(`consent_yes_${c._id}`, 'نعم');
    expect(await inbound(ws, c, tap)).toBe(true);
    expect(await inbound(ws, c, tap)).toBe(true);
    expect(await events(c)).toHaveLength(1);
    expect(sentTo(c.phone)).toHaveLength(1);
  });
});

describe('language inference and English text', () => {
  test('flag ON: an Arabic message from a customer with no language records "ar" (inferred); a human-set language is never overridden', async () => {
    const ws = await fx.makeWorkspace({ arabic: true });
    const fresh = await fx.makeCustomer(ws.workspaceId);
    const manual = await fx.makeCustomer(ws.workspaceId, { language: 'en' });
    expect(await inbound(ws, fresh, textMsg('مرحبا، أريد أن أطلب قهوة'))).toBe(false); // not a consent word: the existing flow still runs
    const rec = await CustomerLanguage.findOne({ customerId: fresh._id }).lean();
    expect(rec).toMatchObject({ language: 'ar', languageSource: 'inferred' });
    await inbound(ws, manual, textMsg('مرحبا، أريد أن أطلب قهوة'));
    expect((await CustomerLanguage.findOne({ customerId: manual._id }).lean()).language).toBe('en');
  });

  test('flag OFF: no language is inferred and nothing is written', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId);
    expect(await inbound(ws, c, textMsg('مرحبا، أريد أن أطلب قهوة'))).toBe(false);
    expect(await CustomerLanguage.countDocuments({ customerId: c._id })).toBe(0);
  });

  test.each([[false], [true]])('English text (flag %s) returns false and changes no consent state, sends nothing', async (arabic) => {
    const ws = await fx.makeWorkspace({ arabic });
    const c = await fx.makeCustomer(ws.workspaceId);
    const before = await Customer.findById(c._id).lean();
    for (const body of ['hi', 'I want to order two coffees', 'STOP', 'START', 'YES', 'no thanks', '1', 'menu']) {
      expect(await inbound(ws, c, textMsg(body))).toBe(false);
    }
    expect(await Customer.findById(c._id).lean()).toEqual(before);
    expect(await events(c)).toHaveLength(0);
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('the kill switch turns the hook off EXCEPT the exact opt-out keywords (compliance; README + backlog C4)', async () => {
    const ws = await fx.makeWorkspace({ arabic: true });
    const phrase = await fx.makeCustomer(ws.workspaceId);
    const exact = await fx.makeCustomer(ws.workspaceId);
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      expect(settings.killSwitchOn()).toBe(true);
      // a phrase-level opt-out falls through to the existing flow
      expect(await inbound(ws, phrase, textMsg('أرجو إلغاء اشتراكي في الرسائل'))).toBe(false);
      // an exact keyword is still honoured
      expect(await inbound(ws, exact, textMsg('توقف'))).toBe(true);
    } finally { delete process.env.LOCALIZATION_DISABLED; }
    expect((await Customer.findById(phrase._id).lean()).optedOut).not.toBe(true);
    expect((await Customer.findById(exact._id).lean()).optedOut).toBe(true);
  });

  test('malformed input never throws: false is returned', async () => {
    const ws = await fx.makeWorkspace({ arabic: true });
    const c = await fx.makeCustomer(ws.workspaceId);
    for (const message of [null, {}, { type: 'text' }, { type: 'text', text: { body: 42 } }, { type: 'image' }, { type: 'button', button: {} }, { type: 'interactive' }]) {
      expect(await hook.handleInbound({ workspaceId: ws.workspaceId, from: c.phone, message }, deps())).toBe(false);
    }
    expect(await hook.handleInbound({}, deps())).toBe(false);
  });
});
