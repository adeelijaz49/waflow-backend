// The consent ASK in the customer's language: payload shape (ids, titles <= 20,
// language) and the recording side effect, mirroring the existing English
// shared/consent.js#sendUtilityMessageWithConsentAsk. No DB, no WhatsApp.
const { buildConsentAsk, sendConsentAsk, YES_PREFIX, NO_PREFIX } = require('../../shared/localization/consentAsk');
const catalog = require('../../shared/localization/catalog');
const transport = require('../../shared/localization/transport');

const CID = '64b7f0f0f0f0f0f0f0f0f0f0';
const WS = '64b7f0f0f0f0f0f0f0f0f0f9';
const customer = (over = {}) => ({ _id: CID, workspaceId: WS, phone: '966500000001', marketingConsent: false, optedOut: false, marketingConsentAskedAt: null, ...over });

function makeDeps() {
  return { Customer: { updateOne: jest.fn(async () => ({})) }, log: jest.fn() };
}
function makeTransport(impl) {
  return { sendButtons: jest.fn(impl || (async () => ({ messages: [{ id: 'wamid.ASK' }] }))), extractWamid: transport.extractWamid };
}

describe('buildConsentAsk', () => {
  test('Arabic: body is the ask text, buttons use the spec labels and the existing id prefixes', () => {
    const ask = buildConsentAsk('ar', { customerId: CID });
    expect(ask.language).toBe('ar');
    expect(ask.body).toBe(catalog.t('ar', 'consent.askSuffix'));
    expect(ask.footer).toBe(catalog.t('ar', 'consent.footerOptOutHint'));
    expect(ask.buttons).toEqual([
      { role: 'opt_in', idPrefix: 'consent_yes_', id: `consent_yes_${CID}`, title: 'نعم، أوافق' },
      { role: 'decline', idPrefix: 'consent_no_', id: `consent_no_${CID}`, title: 'لا، شكراً' },
    ]);
  });

  test('English mirrors the existing carrier wording', () => {
    const ask = buildConsentAsk('en', { customerId: CID });
    expect(ask.body).toBe('Would you like occasional offers & updates from us on WhatsApp?');
    expect(ask.buttons.map((b) => b.title)).toEqual(['Yes, sign me up', 'No thanks']);
  });

  test.each([[undefined], ['fr'], [null], ['AR ']])('an unsupported language %j falls back to English', (lang) => {
    expect(buildConsentAsk(lang).language).toBe('en');
  });

  test('without a customer id only the id prefixes are returned (never a half-built id)', () => {
    const ask = buildConsentAsk('ar');
    for (const b of ask.buttons) expect(b.id).toBeUndefined();
    expect(ask.buttons.map((b) => b.idPrefix)).toEqual([YES_PREFIX, NO_PREFIX]);
  });

  test.each([['ar'], ['en']])('titles fit the 20-character limit and the footer the 60-character limit (%s)', (lang) => {
    const ask = buildConsentAsk(lang, { customerId: CID });
    for (const b of ask.buttons) expect(Array.from(b.title).length).toBeLessThanOrEqual(20);
    expect(Array.from(ask.footer).length).toBeLessThanOrEqual(60);
  });

  test('a lead (e.g. the order confirmation) is carried above the ask, like the English carrier', () => {
    const ask = buildConsentAsk('ar', { customerId: CID, lead: 'تم تأكيد طلبك' });
    expect(ask.body).toBe(`تم تأكيد طلبك\n\n${catalog.t('ar', 'consent.askSuffix')}`);
  });

  test('the id prefixes are exactly the ones the webhook routes', () => {
    expect(YES_PREFIX).toBe('consent_yes_');
    expect(NO_PREFIX).toBe('consent_no_');
  });
});

describe('sendConsentAsk', () => {
  test('sends the interactive reply buttons to the customer and records the ask afterwards (workspace-scoped)', async () => {
    const deps = makeDeps();
    const t = makeTransport();
    const result = await sendConsentAsk({ customer: customer(), language: 'ar', transport: t }, deps);
    expect(result).toEqual({ sent: true, wamid: 'wamid.ASK' });
    expect(t.sendButtons).toHaveBeenCalledWith('966500000001', {
      body: catalog.t('ar', 'consent.askSuffix'),
      buttons: [{ id: `consent_yes_${CID}`, title: 'نعم، أوافق' }, { id: `consent_no_${CID}`, title: 'لا، شكراً' }],
    });
    expect(deps.Customer.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = deps.Customer.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: CID, workspaceId: WS });
    expect(update.$set.marketingConsentAskedAt).toBeInstanceOf(Date);
    expect(t.sendButtons.mock.invocationCallOrder[0]).toBeLessThan(deps.Customer.updateOne.mock.invocationCallOrder[0]);
  });

  test('the real transport payload is a Meta interactive button message (dry run, nothing leaves the process)', async () => {
    const previous = process.env.LOCALIZATION_SEND_MODE;
    process.env.LOCALIZATION_SEND_MODE = 'dry_run';
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    transport.clearDryRuns();
    try {
      const deps = makeDeps();
      const result = await sendConsentAsk({ customer: customer(), language: 'ar', transport }, deps);
      expect(result.sent).toBe(true);
      const [run] = transport.lastDryRuns();
      expect(run.payload).toMatchObject({
        messaging_product: 'whatsapp', to: '966500000001', type: 'interactive',
        interactive: { type: 'button', body: { text: catalog.t('ar', 'consent.askSuffix') } },
      });
      expect(run.payload.interactive.action.buttons).toEqual([
        { type: 'reply', reply: { id: `consent_yes_${CID}`, title: 'نعم، أوافق' } },
        { type: 'reply', reply: { id: `consent_no_${CID}`, title: 'لا، شكراً' } },
      ]);
    } finally {
      log.mockRestore();
      transport.clearDryRuns();
      if (previous === undefined) delete process.env.LOCALIZATION_SEND_MODE; else process.env.LOCALIZATION_SEND_MODE = previous;
    }
  });

  test.each([
    ['a demo customer', { isDemo: true }, 'no_customer'],
    ['an erased customer', { deletedAt: new Date() }, 'no_customer'],
    ['already consented', { marketingConsent: true }, 'already_consented'],
    ['opted out', { optedOut: true }, 'opted_out'],
    ['already asked (at most once)', { marketingConsentAskedAt: new Date() }, 'already_asked'],
  ])('never asks a customer who is %s', async (name, over, reason) => {
    const deps = makeDeps();
    const t = makeTransport();
    await expect(sendConsentAsk({ customer: customer(over), language: 'ar', transport: t }, deps)).resolves.toEqual({ sent: false, reason });
    expect(t.sendButtons).not.toHaveBeenCalled();
    expect(deps.Customer.updateOne).not.toHaveBeenCalled();
  });

  test.each([[undefined], [null], [{}], [{ _id: CID }]])('a missing/incomplete customer %j is refused', async (c) => {
    const deps = makeDeps();
    const t = makeTransport();
    await expect(sendConsentAsk({ customer: c, language: 'ar', transport: t }, deps)).resolves.toEqual({ sent: false, reason: 'no_customer' });
    expect(t.sendButtons).not.toHaveBeenCalled();
  });

  test('a failed send (e.g. outside the 24h window) records nothing, so the customer is not considered asked', async () => {
    const deps = makeDeps();
    const t = makeTransport(async () => { throw new Error('(#131047) Re-engagement message'); });
    await expect(sendConsentAsk({ customer: customer(), language: 'ar', transport: t }, deps)).resolves.toEqual({ sent: false, reason: 'send_failed' });
    expect(deps.Customer.updateOne).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  test('a failure while recording the ask does not turn a delivered ask into an error', async () => {
    const deps = makeDeps();
    deps.Customer.updateOne = jest.fn(async () => { throw new Error('db down'); });
    const result = await sendConsentAsk({ customer: customer(), language: 'ar', transport: makeTransport() }, deps);
    expect(result.sent).toBe(true);
    expect(deps.log).toHaveBeenCalled();
  });

  test('an over-long lead is refused instead of being truncated or rejected by Meta', async () => {
    const deps = makeDeps();
    const t = makeTransport();
    await expect(sendConsentAsk({ customer: customer(), language: 'ar', transport: t, lead: 'ا'.repeat(1100) }, deps)).resolves.toEqual({ sent: false, reason: 'too_long' });
    expect(t.sendButtons).not.toHaveBeenCalled();
  });

  test('never throws, whatever is thrown', async () => {
    const deps = makeDeps();
    deps.log = jest.fn(() => { throw new Error('logger broke'); });
    const t = { sendButtons: () => { throw new Error('sync boom'); } };
    await expect(sendConsentAsk({ customer: customer(), language: 'ar', transport: t }, deps)).resolves.toEqual({ sent: false, reason: 'send_failed' });
    await expect(sendConsentAsk(undefined, deps)).resolves.toEqual({ sent: false, reason: 'no_customer' });
  });

  test('a customer asked here is then "pending" for the typed-reply logic in the inbound hook', async () => {
    const { hasPendingConsentAsk } = require('../../shared/localization/inboundHook');
    const askedAt = new Date();
    const asked = customer({ marketingConsentAskedAt: askedAt });
    const deps = { now: () => askedAt.getTime() + 1000, ConsentEvent: { exists: async () => null } };
    await expect(hasPendingConsentAsk(deps, asked)).resolves.toBe(true);
  });
});
