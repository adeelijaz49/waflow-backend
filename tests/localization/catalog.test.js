const catalog = require('../../shared/localization/catalog');
const { validateButtonLabel, LIMITS, charLength } = require('../../shared/localization/metaConstraints');

describe('backend message catalogue', () => {
  beforeAll(() => catalog.reload());

  test('loads every namespace file with its full keys', () => {
    expect(catalog.has('consent.optOutAck')).toBe(true);
    expect(catalog.has('consent.nope')).toBe(false);
  });

  test('English strings match the existing server.js acknowledgements exactly', () => {
    expect(catalog.t('en', 'consent.optOutAck')).toBe("You've been unsubscribed from promotional messages. Reply START to opt back in anytime.");
    expect(catalog.t('en', 'consent.optInAck')).toBe("🎉 You're subscribed! We'll send occasional offers and updates. Reply STOP anytime to opt out.");
    expect(catalog.t('en', 'consent.declineAck')).toBe('No problem! You can always opt in later.');
    expect(catalog.t('en', 'consent.startNoConsent')).toBe("Got it — you won't receive promotional messages unless you opt in.");
    expect(catalog.t('en', 'consent.buttonOptIn')).toBe('Yes, sign me up');
    expect(catalog.t('en', 'consent.buttonDecline')).toBe('No thanks');
  });

  test('Arabic is returned for ar, English for anything else, key itself when unknown', () => {
    expect(catalog.t('ar', 'consent.buttonOptOut')).toBe('إلغاء الاشتراك');
    expect(catalog.t('en', 'consent.buttonOptOut')).toBe('Opt Out');
    expect(catalog.t('fr', 'consent.buttonOptOut')).toBe('Opt Out');
    expect(catalog.t('ar', 'no.such.key')).toBe('no.such.key');
  });

  test('params are filled; Latin values in Arabic text get direction marks', () => {
    const entries = catalog.listEntries();
    expect(entries.length).toBeGreaterThan(5);
    expect(catalog.t('en', 'consent.askSuffix', { x: 1 })).toContain('WhatsApp');
  });

  test('every Arabic string starts as draft, with an English source (spec §8)', () => {
    for (const e of catalog.listEntries()) {
      if (e.ar) expect(e.status).toBe('draft');
      expect(e.en.length).toBeGreaterThan(0);
    }
  });

  test('Arabic copy uses "واتساب" for WhatsApp and never "WhatsApp" in Latin (spec §1)', () => {
    for (const e of catalog.listEntries()) {
      if (e.ar) expect(e.ar).not.toMatch(/whatsapp/i);
    }
  });

  test('button labels fit the 20-character limit in both languages', () => {
    for (const key of ['consent.buttonOptIn', 'consent.buttonDecline', 'consent.buttonOptOut']) {
      for (const lang of ['en', 'ar']) {
        const label = catalog.t(lang, key);
        expect(validateButtonLabel(label).ok).toBe(true);
        expect(charLength(label)).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
      }
    }
  });

  test('footer hint fits the 60-character template footer limit', () => {
    expect(charLength(catalog.t('en', 'consent.footerOptOutHint'))).toBeLessThanOrEqual(LIMITS.FOOTER);
    expect(charLength(catalog.t('ar', 'consent.footerOptOutHint'))).toBeLessThanOrEqual(LIMITS.FOOTER);
  });

  test('counts() reports draft vs reviewed Arabic strings', () => {
    const c = catalog.counts();
    expect(c.arabicDraft + c.arabicReviewed).toBe(c.arabicTotal);
    expect(c.arabicDraft).toBeGreaterThan(0);
  });
});
