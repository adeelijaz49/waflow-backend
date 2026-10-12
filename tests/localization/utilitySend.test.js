// Unit tests for shared/localization/utilitySend.js: Arabic session notices for the existing booking / order senders.
const notice = require('../../shared/localization/utilitySend');
const catalog = require('../../shared/localization/catalog');
const { id, WS, OTHER_WS, template, arabicVariant, customerDoc, world } = require('./legacyTestKit');

const LRM = '\u{200E}';
const metaError = (code, message = 'Meta says no') => Object.assign(new Error(message), { response: { data: { error: { code, message } } } });
const bookingValues = () => ({ service: 'جلسة عناية', date: '2026-11-03', time: '16:30' });
const confirmed = (over = {}) => ({ key: 'senders.bookingConfirmed', values: bookingValues, ...over });

function setup({ language = 'ar', customer, templates = [], flagged = [WS] } = {}) {
  const c = customer || customerDoc({ firstname: 'سارة', marketingConsent: true });
  const w = world({ customers: [c], languages: language ? { [c._id]: language } : {}, templates, flagged });
  return { c, w, deps: { ...w.deps, LocalizedTemplate: w.deps.LocalizedTemplate } };
}

describe('not applicable: null (the caller\'s English path runs untouched)', () => {
  test('no localized argument, kill switch, flag off, English customer, unknown key, a value that throws, a missing value', async () => {
    const { c, deps } = setup();
    expect(await notice.sendNotice({ customer: c, workspaceId: WS }, deps)).toBeNull();
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.bookingConfirmed' } }, deps)).toBeNull(); // no values closure
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.nope', values: bookingValues } }, deps)).toBeNull();
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ values: () => { throw new Error('x'); } }) }, deps)).toBeNull();
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ values: () => ({ service: 'x', date: '', time: '1' }) }) }, deps)).toBeNull();
    expect(deps.transport.sendText).not.toHaveBeenCalled();

    deps.settings.killSwitchOn.mockReturnValue(true);
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed() }, deps)).toBeNull();
    deps.settings.killSwitchOn.mockReturnValue(false);

    const off = setup({ flagged: [] });
    expect(await notice.sendNotice({ customer: off.c, workspaceId: WS, localized: confirmed() }, off.deps)).toBeNull();
    expect(off.deps.CustomerLanguage.findOne).not.toHaveBeenCalled(); // an unflagged merchant costs no language lookup
    expect(off.deps.Customer.findOne).not.toHaveBeenCalled();

    const english = setup({ language: 'en' });
    expect(await notice.sendNotice({ customer: english.c, workspaceId: WS, localized: confirmed() }, english.deps)).toBeNull();
    const unknown = setup({ language: null });
    expect(await notice.sendNotice({ customer: unknown.c, workspaceId: WS, localized: confirmed() }, unknown.deps)).toBeNull();
    expect(unknown.w.sent).toHaveLength(0);
  });

  test('an erased customer, another workspace and a customer looked up by id behave', async () => {
    const erased = setup({ customer: customerDoc({ deletedAt: new Date() }) });
    expect(await notice.sendNotice({ customer: erased.c, workspaceId: WS, localized: confirmed() }, erased.deps)).toBeNull();

    const { c, deps } = setup();
    // by id: workspace-scoped lookup
    const out = await notice.sendNotice({ customerId: c._id, workspaceId: WS, localized: confirmed() }, deps);
    expect(out.via).toBe('session');
    expect(deps.Customer.findOne).toHaveBeenCalledWith({ _id: c._id, workspaceId: WS });
    const stranger = await notice.sendNotice({ customerId: c._id, workspaceId: OTHER_WS, localized: confirmed() }, deps);
    expect(stranger).toBeNull();
  });

  test('LOCALIZATION_ALLOW_DRAFT_SESSION=0 refuses draft copy; unset serves it (G1)', async () => {
    const { c, deps } = setup();
    process.env.LOCALIZATION_ALLOW_DRAFT_SESSION = '0';
    try {
      expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed() }, deps)).toBeNull();
    } finally { delete process.env.LOCALIZATION_ALLOW_DRAFT_SESSION; }
    expect(await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed() }, deps)).not.toBeNull();
  });
});

describe('the Arabic text', () => {
  test('plain text: the catalogue text with the values filled in', async () => {
    const { c, deps, w } = setup();
    const out = await notice.sendNotice({ customer: c, workspaceId: WS, withConsentAsk: false, localized: confirmed() }, deps);
    expect(out).toMatchObject({ via: 'session', result: { messages: [{ id: expect.any(String) }] } });
    expect(w.sent).toEqual([{ to: c.phone, text: '✅ *تم تأكيد حجزك!*\n\n📋 جلسة عناية\n📅 2026-11-03 الساعة 16:30\n\nنراك في الموعد! 🎉' }].map((m) => ({ ...m, text: expect.stringContaining('تم تأكيد حجزك') })));
    expect(w.sent[0].text).toContain(`${LRM}2026-11-03${LRM}`); // Latin/number values are isolated inside Arabic text
    expect(w.rows[0]).toMatchObject({ sender: 'notice', usedLanguage: 'ar', via: 'session', status: 'sent', customerId: c._id });
  });

  test('a Latin service name inside the Arabic sentence is isolated; a link is left alone; line breaks of a value are kept', async () => {
    const { c, deps, w } = setup();
    await notice.sendNotice({
      customer: c, workspaceId: WS,
      localized: {
        key: 'senders.orderSummary',
        values: () => ({ items: '1. Coffee beans — 50.00 ر.س\n2. Mug — 25.00 ر.س', subtotal: '75.00 ر.س', shipping: '0.50 ر.س', total: '75.50 ر.س', address: 'Riyadh', link: 'https://app.test/pay/pi_1?lang=ar' }),
      },
    }, deps);
    const text = w.sent[0].text;
    expect(text).toContain('1. Coffee beans — 50.00 ر.س\n2. Mug — 25.00 ر.س'); // multi-line value kept intact
    expect(text).toContain(`${LRM}Riyadh${LRM}`);
    expect(text).toContain('\nhttps://app.test/pay/pi_1?lang=ar'); // URL not wrapped
    expect(text).not.toContain(`${LRM}https`);
  });

  test('R3-04: no direction mark next to the * / _ of a bold or italic pair (booking confirmed / rescheduled / cancelled / order total), marks elsewhere unchanged', async () => {
    const MARK_NEXT_TO_FORMAT = /[*_]\u{200E}|\u{200E}[*_]/u;
    const { c, deps, w } = setup();
    // bookingRescheduled: "*{service}*" and "*{date} الساعة {time}*": the service, the date (after *) and the time (before *) are all inside bold
    await notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.bookingRescheduled', values: () => ({ service: 'Deep Tissue Massage', date: '2026-10-12', time: '10:00' }) } }, deps);
    expect(w.sent[0].text).toContain('*Deep Tissue Massage*');
    expect(w.sent[0].text).toContain('*2026-10-12 الساعة 10:00*');
    expect(w.sent[0].text).not.toMatch(MARK_NEXT_TO_FORMAT);
    // bookingCancelled: "{name}!" (not bold: keeps its marks) and "*{slot}*" (bold: none)
    await notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.bookingCancelled', values: () => ({ name: 'Sara', service: 'Massage', slot: '2026-10-12 10:00' }) } }, deps);
    expect(w.sent[1].text).toContain(`أهلاً ${LRM}Sara${LRM}!`);
    expect(w.sent[1].text).toContain('*2026-10-12 10:00*');
    expect(w.sent[1].text).not.toMatch(MARK_NEXT_TO_FORMAT);
    // order summary: "*الإجمالي: {total}*" with a Latin total directly before the closing asterisk
    await notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.orderSummary', values: () => ({ items: '1. Mug', subtotal: 'USD 70', shipping: 'USD 5', total: 'USD 75', address: 'Riyadh', link: 'https://app.test/pay/pi_1?lang=ar' }) } }, deps);
    expect(w.sent[2].text).toContain('*الإجمالي: USD 75*');
    expect(w.sent[2].text).toContain(`المجموع الفرعي: ${LRM}USD 70${LRM}`);
    expect(w.sent[2].text).not.toMatch(MARK_NEXT_TO_FORMAT);
  });

  test('LOCALIZATION_WRAP_SESSION_LRM=0 sends the notice without any direction mark', async () => {
    const { c, deps, w } = setup();
    process.env.LOCALIZATION_WRAP_SESSION_LRM = '0';
    try { await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed() }, deps); } finally { delete process.env.LOCALIZATION_WRAP_SESSION_LRM; }
    expect(w.sent[0].text).not.toContain(LRM);
    expect(w.sent[0].text).toContain('2026-11-03');
  });

  test('bidi spoofing and control characters in a value are removed', async () => {
    const { c, deps, w } = setup();
    await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ values: () => ({ service: '\u{202E}evil\u{0007}', date: '2026-11-03', time: '10:00' }) }) }, deps);
    expect(w.sent[0].text).not.toMatch(/[\u{202A}-\u{202E}\u{0007}]/u);
    expect(w.sent[0].text).toContain('evil');
  });

  test('every senders.* catalogue entry used by a notice has the same placeholders in both languages', () => {
    for (const key of ['bookingConfirmed', 'bookingRescheduled', 'bookingDeclined', 'bookingCancelled', 'orderSummary', 'referralShare']) {
      const entry = catalog.load().get(`senders.${key}`);
      const fields = (text) => Array.from(text.matchAll(/\{([a-z_]+)\}/g), (m) => m[1]).sort();
      expect(fields(entry.ar)).toEqual(fields(entry.en));
    }
  });

  test('a text over the WhatsApp limit is not attempted in Arabic (English path)', async () => {
    const { c, deps, w } = setup();
    const out = await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ values: () => ({ service: 'ب'.repeat(5000), date: 'd', time: 't' }) }) }, deps);
    expect(out).toBeNull();
    expect(w.sent).toHaveLength(0);
  });
});

describe('the consent-ask carrier (mirror of the English condition)', () => {
  const ask = (c, extra = {}) => ({ customer: c, workspaceId: WS, withConsentAsk: true, localized: confirmed(), ...extra });

  test('not consented and never asked: ONE interactive message with the Arabic ask and consent_yes_/consent_no_ buttons, then the ask is stamped', async () => {
    const c = customerDoc({ firstname: 'سارة', marketingConsent: false });
    const { deps, w } = setup({ customer: c });
    const out = await notice.sendNotice(ask(c), deps);
    expect(out.via).toBe('interactive');
    expect(w.sent).toHaveLength(1);
    const { buttons } = w.sent[0];
    expect(buttons.body).toContain('تم تأكيد حجزك');
    expect(buttons.body).toContain(catalog.t('ar', 'consent.askSuffix'));
    expect(buttons.buttons).toEqual([
      { id: `consent_yes_${c._id}`, title: 'نعم، أوافق' },
      { id: `consent_no_${c._id}`, title: 'لا، شكراً' },
    ]);
    expect(deps.Customer.updateOne).toHaveBeenCalledWith({ _id: c._id, workspaceId: WS }, { $set: { marketingConsentAskedAt: expect.any(Date) } });
  });

  test.each([
    ['already consented', { marketingConsent: true }],
    ['already asked', { marketingConsent: false, marketingConsentAskedAt: new Date() }],
    ['opted out', { marketingConsent: false, optedOut: true }],
  ])('%s: plain text, no ask', async (label, over) => {
    const c = customerDoc({ firstname: 'سارة', ...over });
    const { deps, w } = setup({ customer: c });
    const out = await notice.sendNotice(ask(c), deps);
    expect(out.via).toBe('session');
    expect(w.transport.sendButtons).not.toHaveBeenCalled();
    expect(deps.Customer.updateOne).not.toHaveBeenCalled();
  });

  test('withConsentAsk false (booking notices): never asks', async () => {
    const c = customerDoc({ marketingConsent: false });
    const { deps, w } = setup({ customer: c });
    expect((await notice.sendNotice(ask(c, { withConsentAsk: false }), deps)).via).toBe('session');
    expect(w.transport.sendButtons).not.toHaveBeenCalled();
  });

  test('the interactive ask fails (outside the 24 h window): the notice goes as plain text and the ask is NOT stamped', async () => {
    const c = customerDoc({ marketingConsent: false });
    const { deps, w } = setup({ customer: c });
    w.transport.sendButtons.mockRejectedValueOnce(metaError(131047));
    const out = await notice.sendNotice(ask(c), deps);
    expect(out.via).toBe('session');
    expect(w.transport.sendText).toHaveBeenCalledTimes(1);
    expect(deps.Customer.updateOne).not.toHaveBeenCalled();
  });

  test('a body too long for an interactive message goes as plain text without trying the ask', async () => {
    const c = customerDoc({ marketingConsent: false });
    const { deps, w } = setup({ customer: c });
    const out = await notice.sendNotice(ask(c, { localized: confirmed({ values: () => ({ service: 'ب'.repeat(1000), date: 'd', time: 't' }) }) }), deps);
    expect(out.via).toBe('session');
    expect(w.transport.sendButtons).not.toHaveBeenCalled();
  });

  test('a rehearsal (dry run) does not stamp the ask', async () => {
    const c = customerDoc({ marketingConsent: false });
    const { deps, w } = setup({ customer: c });
    w.transport.isDryRun.mockReturnValue(true);
    await notice.sendNotice(ask(c), deps);
    expect(deps.Customer.updateOne).not.toHaveBeenCalled();
  });
});

describe('the cancelled-booking notice (interactive rebook button)', () => {
  const localized = (c) => ({
    key: 'senders.bookingCancelled',
    buttons: [{ id: `rebook_${id(5)}_${id(6)}`, titleKey: 'senders.bookingCancelledButton' }],
    values: () => ({ name: 'سارة', service: 'جلسة عناية', slot: '2026-11-03 16:30' }),
  });

  test('sends the Arabic body with one reply button (<= 20 characters); a failure falls back to text, like the English one', async () => {
    const { c, deps, w } = setup();
    const out = await notice.sendNotice({ customer: c, workspaceId: WS, withConsentAsk: false, localized: localized(c) }, deps);
    expect(out.via).toBe('session');
    expect(w.sent[0].buttons.buttons).toEqual([{ id: `rebook_${id(5)}_${id(6)}`, title: 'أعد الحجز مجاناً 🔄' }]);
    expect(Array.from(w.sent[0].buttons.buttons[0].title).length).toBeLessThanOrEqual(20);
    w.transport.sendButtons.mockRejectedValueOnce(metaError(131047));
    const again = await notice.sendNotice({ customer: c, workspaceId: WS, withConsentAsk: false, localized: localized(c) }, deps);
    expect(again.via).toBe('session');
    expect(w.sent[w.sent.length - 1].text).toContain('تم إلغاء حجزك');
  });
});

describe('failures: nothing falls back to English once an Arabic send was attempted', () => {
  test('another Meta error is rethrown flagged localizedSendFailed (the caller\'s best-effort catch swallows it like an English failure)', async () => {
    const { c, deps, w } = setup();
    w.transport.sendText.mockRejectedValueOnce(metaError(131026, 'Undeliverable'));
    await expect(notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed() }, deps)).rejects.toMatchObject({ localizedSendFailed: true, message: 'Undeliverable' });
    expect(w.sent).toHaveLength(0);
    expect(w.rows[0]).toMatchObject({ status: 'failed', errorCode: '131026' });
  });

  test('outside the 24 h window (131047) with no template to fall back to: rethrown flagged', async () => {
    const { c, deps, w } = setup();
    w.transport.sendText.mockRejectedValueOnce(metaError(131047));
    await expect(notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ templateFallback: 'booking_confirmation' }) }, deps)).rejects.toMatchObject({ localizedSendFailed: true });
  });

  test('outside the window with an approved + reviewed UTILITY booking_confirmation template: that template is sent (name, service, date, time, business)', async () => {
    const utility = template({
      useCase: 'booking_confirmation', category: 'UTILITY',
      variants: [arabicVariant({ body: 'مرحباً {name}، تم تأكيد حجزك لخدمة {service} بتاريخ {date} الساعة {time} لدى {business}. بانتظارك', buttons: [], footer: undefined, metaTemplateName: 'wf_booking_ar_v1' })],
    });
    const { c, deps, w } = setup({ templates: [utility] });
    w.transport.sendText.mockRejectedValueOnce(metaError(131047));
    const out = await notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ templateFallback: 'booking_confirmation' }) }, deps);
    expect(out.via).toBe('template');
    expect(w.sent[0]).toEqual({
      to: c.phone, name: 'wf_booking_ar_v1', languageCode: 'ar',
      components: [{ type: 'body', parameters: [
        { type: 'text', text: 'سارة' }, { type: 'text', text: 'جلسة عناية' }, { type: 'text', text: '2026-11-03' }, { type: 'text', text: '16:30' }, { type: 'text', text: 'Aroma Cafe' },
      ] }],
    });
    expect(w.rows[0]).toMatchObject({ via: 'template', status: 'sent', metaTemplateName: 'wf_booking_ar_v1' });
  });

  test.each([
    ['not reviewed', { reviewStatus: 'draft' }, {}],
    ['not approved', { metaStatus: 'PENDING' }, {}],
    ['a field it cannot fill', { body: 'مرحباً {name}، حجزك {order_id} مؤكد لدى {business} اليوم' }, {}],
    ['a button (a dead payload)', { buttons: [{ role: 'opt_out', text: 'إلغاء الاشتراك' }] }, {}],
    ['a MARKETING category', {}, { category: 'MARKETING' }],
    ['a linked template', {}, { linkedPromotionId: id(9) }],
  ])('a fallback template that is %s is never used', async (label, variantOver, templateOver) => {
    const unusable = template({
      useCase: 'booking_confirmation', category: 'UTILITY',
      variants: [arabicVariant({ body: 'مرحباً {name}، تم تأكيد حجزك لخدمة {service} بتاريخ {date} الساعة {time} لدى {business}. بانتظارك', buttons: [], footer: undefined, ...variantOver })],
      ...templateOver,
    });
    const { c, deps, w } = setup({ templates: [unusable] });
    w.transport.sendText.mockRejectedValueOnce(metaError(131047));
    await expect(notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ templateFallback: 'booking_confirmation' }) }, deps)).rejects.toMatchObject({ localizedSendFailed: true });
    expect(w.transport.sendTemplate).not.toHaveBeenCalled();
  });

  test('the fallback template itself failing is a flagged failure and recorded', async () => {
    const utility = template({
      useCase: 'booking_confirmation', category: 'UTILITY',
      variants: [arabicVariant({ body: 'مرحباً {name}، تم تأكيد حجزك لخدمة {service} بتاريخ {date} الساعة {time} لدى {business}. بانتظارك', buttons: [], footer: undefined })],
    });
    const { c, deps, w } = setup({ templates: [utility] });
    w.transport.sendText.mockRejectedValueOnce(metaError(131047));
    w.transport.sendTemplate.mockRejectedValueOnce(metaError(132001, 'Template missing'));
    await expect(notice.sendNotice({ customer: c, workspaceId: WS, localized: confirmed({ templateFallback: 'booking_confirmation' }) }, deps)).rejects.toMatchObject({ localizedSendFailed: true });
    expect(w.rows[0]).toMatchObject({ via: 'template', status: 'failed', errorCode: '132001' });
  });

  test('only booking_confirmation maps to a template: an order summary outside the window just fails', async () => {
    expect(Object.keys(notice.TEMPLATE_FALLBACKS)).toEqual(['booking_confirmation']);
    const { c, deps, w } = setup();
    w.transport.sendText.mockRejectedValueOnce(metaError(131047));
    await expect(notice.sendNotice({ customer: c, workspaceId: WS, localized: { key: 'senders.orderSummary', values: () => ({ items: '1. x — 1.00 ر.س', subtotal: 'a', shipping: 'b', total: 'c', address: 'd', link: 'https://x.test' }), templateFallback: 'order_confirmation' } }, deps)).rejects.toMatchObject({ localizedSendFailed: true });
  });
});

describe('renderSession', () => {
  test('missing and blank values are reported, never filled with a hole', () => {
    expect(notice.renderSession('أهلاً {name} من {city}', { name: 'سارة' })).toEqual({ text: 'أهلاً سارة من {city}', missing: true });
    expect(notice.renderSession('أهلاً {name}', { name: '   ' }).missing).toBe(true);
    expect(notice.renderSession('أهلاً {name}', { name: 'سارة' }).missing).toBe(false);
    expect(notice.renderSession('{constructor}', {}).missing).toBe(true); // an inherited property is not a value
  });
});
