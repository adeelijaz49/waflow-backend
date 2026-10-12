// The senders.* catalogue namespace (shared/localization/catalog/senders.json): the Arabic session text of the booking /
// order notices and the referral link text. Every string is a draft; the opt-out hint is legal-flagged.
const fs = require('fs');
const path = require('path');
const catalog = require('../../shared/localization/catalog');
const { LIMITS, charLength } = require('../../shared/localization/metaConstraints');

const entries = () => catalog.listEntries().filter((e) => e.key.startsWith('senders.'));
const fields = (text) => Array.from(text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (m) => m[1]).sort();
const HIDDEN_RE = /[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}\u{0640}]/u; // zero-width, bidi, BOM, tatweel
const ARABIC_INDIC_RE = /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u;

beforeAll(() => catalog.reload());

describe('senders.* catalogue entries', () => {
  test('every key the senders use exists, with Arabic text', () => {
    const used = new Set();
    for (const rel of ['shared/operations.js', 'shared/localization/legacySenders.js', 'shared/localization/utilitySend.js', 'shared/localization/senderValues.js', 'shared/consent.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
      // senders.referralFriend / senders.referralReferrer are prefixes (completed below), not keys
      for (const m of source.matchAll(/['"`](senders\.[A-Za-z]+)['"`]/g)) if (!/^senders\.referral(Friend|Referrer)$/.test(m[1])) used.add(m[1]);
    }
    for (const prefix of ['senders.referralFriend', 'senders.referralReferrer']) for (const kind of ['Percent', 'Fixed', 'Points', 'Offer']) used.add(`${prefix}${kind}`);
    expect(used.size).toBeGreaterThan(10);
    for (const key of used) {
      expect(catalog.has(key)).toBe(true);
      expect(catalog.load().get(key).ar.length).toBeGreaterThan(0);
    }
  });

  test('both languages are there, the Arabic is a draft, and the placeholders are the same set in both', () => {
    const list = entries();
    expect(list.length).toBeGreaterThanOrEqual(16);
    for (const e of list) {
      expect(e.en.length).toBeGreaterThan(0);
      expect(e.ar.length).toBeGreaterThan(0);
      expect(e.status).toBe('draft');
      expect(fields(e.ar)).toEqual(fields(e.en));
    }
  });

  test('only the opt-out hint needs the owner\'s lawyer (it is the one legal-sensitive sentence); the others do not', () => {
    for (const e of entries()) expect(e.needsLegalApproval).toBe(e.key === 'senders.optOutHint');
    expect(catalog.load().get('senders.optOutHint').ar).toContain('إلغاء الاشتراك'); // the typed keyword the inbound hook recognises
  });

  test('Arabic copy rules: واتساب never WhatsApp, Western digits, no hidden/bidi characters, no Latin letters outside placeholders and brand', () => {
    for (const e of entries()) {
      expect(e.ar).not.toMatch(/whatsapp/i);
      expect(e.ar).not.toMatch(ARABIC_INDIC_RE);
      expect(e.ar).not.toMatch(HIDDEN_RE);
      // STOP is the one English keyword the opt-out line has to name (R3-07): it is honoured for every workspace.
      const bare = e.ar.replace(/\{[A-Za-z0-9_]+\}/g, '').replace(e.key === 'senders.optOutHint' ? /\bSTOP\b/ : /(?!)/, '');
      expect(bare).not.toMatch(/[A-Za-z]/);
    }
  });

  test('R3-07: the Arabic opt-out hint names BOTH the Arabic phrase and STOP, and stays legal-flagged', () => {
    const e = catalog.load().get('senders.optOutHint');
    expect(e.ar).toContain('«إلغاء الاشتراك»');
    expect(e.ar).toMatch(/\bSTOP\b/);
    expect(e.status).toBe('draft');
    expect(e.needsLegalApproval).toBe(true);
  });

  test('R3-02: the rebook button leaves a margin under the 20 limit (<= 18 code points, <= 19 UTF-16 units) and the body has no comma splice', () => {
    const button = catalog.t('ar', 'senders.bookingCancelledButton');
    expect(charLength(button)).toBeLessThanOrEqual(18);
    expect(button.length).toBeLessThanOrEqual(19);
    expect(catalog.t('ar', 'senders.bookingCancelled')).toContain('وقت آخر. اضغط الزر أدناه لإعادة الحجز *مجاناً*!');
  });

  test('R3-06: the referral text has no clause-internal colon before the link, the reward phrases are count-neutral, no reward phrase carries a colon', () => {
    const share = catalog.t('ar', 'senders.referralShare');
    expect(share).toContain('سيحصل صديقك على {friend_reward}، وستحصل أنت على {referrer_reward} عند شرائه: {link}');
    expect(share.split(':').length - 1).toBe(1); // only the one colon before the link
    expect(catalog.t('ar', 'senders.referralFriendPoints')).toBe('{value} من نقاط الولاء الإضافية');
    expect(catalog.t('ar', 'senders.referralReferrerPoints')).toBe('{value} من نقاط الولاء');
    for (const key of ['referralFriendPercent', 'referralFriendFixed', 'referralFriendPoints', 'referralFriendOffer', 'referralReferrerPoints', 'referralReferrerPercent', 'referralReferrerFixed', 'referralReferrerOffer']) {
      expect(catalog.t('ar', `senders.${key}`)).not.toContain(':');
    }
  });

  test('R3-11: one "see you then" phrase across the booking notices and the journey; one "pay securely" phrase', () => {
    for (const key of ['senders.bookingConfirmed', 'senders.bookingRescheduled', 'journey.text.bookedFree', 'journey.text.bookedPoints', 'journey.text.bookingConfirmedPaid']) {
      expect([key, catalog.t('ar', key).includes('نراك في الموعد!')]).toEqual([key, true]);
      expect(catalog.t('ar', key)).not.toContain('بانتظارك');
    }
    for (const key of ['senders.orderSummary', 'journey.text.orderSummary', 'journey.text.payBooking']) expect([key, catalog.t('ar', key).includes('ادفع بأمان عبر الرابط')]).toEqual([key, true]);
  });

  test('the reply button of the cancelled-booking notice fits a WhatsApp reply button (20 characters) in both languages', () => {
    for (const lang of ['en', 'ar']) expect(charLength(catalog.t(lang, 'senders.bookingCancelledButton'))).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
  });

  test('every notice fits one WhatsApp text message with generous room for its values', () => {
    for (const key of ['bookingConfirmed', 'bookingRescheduled', 'bookingDeclined', 'bookingCancelled', 'orderSummary', 'referralShare']) {
      expect(charLength(catalog.t('ar', `senders.${key}`))).toBeLessThan(600);
    }
  });

  test('the English text is the existing sender text (the catalogue entry and the source never drift apart)', () => {
    const ops = fs.readFileSync(path.join(__dirname, '..', '..', 'shared/operations.js'), 'utf8');
    const whatsapp = fs.readFileSync(path.join(__dirname, '..', '..', 'utils/whatsapp.js'), 'utf8');
    const referrals = fs.readFileSync(path.join(__dirname, '..', '..', 'shared/referrals.js'), 'utf8');
    expect(ops).toContain('Booking Confirmed!*');
    expect(catalog.t('en', 'senders.bookingConfirmed')).toContain('*Booking Confirmed!*');
    expect(ops).toContain('has been rescheduled to');
    expect(catalog.t('en', 'senders.bookingRescheduled')).toContain('has been rescheduled to');
    expect(ops).toContain("we're unable to accommodate your request for");
    expect(catalog.t('en', 'senders.bookingDeclined')).toContain("we're unable to accommodate your request for");
    expect(whatsapp).toContain('has been cancelled.');
    expect(catalog.t('en', 'senders.bookingCancelled')).toContain('has been cancelled.');
    expect(whatsapp).toContain('Rebook Free');
    expect(catalog.t('en', 'senders.bookingCancelledButton')).toBe('Rebook Free 🔄');
    expect(ops).toContain('*Your Order Summary*');
    expect(catalog.t('en', 'senders.orderSummary')).toContain('*Your Order Summary*');
    expect(referrals).toContain('Share this link with a friend.');
    expect(catalog.t('en', 'senders.referralShare')).toContain('Share this link with a friend.');
    expect(catalog.t('en', 'senders.referralFriendPercent')).toBe('{value}% off their first order');
    expect(referrals).toContain('% off their first order');
  });
});
