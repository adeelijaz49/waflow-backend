// Starter-message library (shared/localization/templateLibrary.js): the content is
// the deliverable, so these tests pin the rules the copy must satisfy — Meta's
// template limits (via the real validator), consent buttons in the message's own
// language, Arabic orthography decisions from design/GLOSSARY.md, and the exact
// protected wording of the spec §3.3 drafts. Pure: no DB, no network.
const {
  listLibrary, getLibraryEntry, listLibraryStrings, LIBRARY_KEYS,
} = require('../../shared/localization/templateLibrary');
const { validateVariant, charLength, LIMITS, BUTTON_ROLES } = require('../../shared/localization/metaConstraints');
const {
  FIELD_RE, KNOWN_FIELDS, extractFields, extractOccurrences, fieldSetsMatch, findInvalidPlaceholders,
  renderMessageSafe, sampleValue, sampleValues, toPositional,
} = require('../../shared/localization/mergeFields');
const { LRM, countLetters, normalizeForMatch } = require('../../shared/localization/arabicText');
const { classifyInboundText } = require('../../shared/localization/keywords');
const catalog = require('../../shared/localization/catalog');

// key, useCase, category — in the order the picker shows them.
const EXPECTED = [
  ['comeback', 'comeback', 'MARKETING'],
  ['loyalty_reminder', 'loyalty_reminder', 'MARKETING'],
  ['payment_reminder', 'payment_reminder', 'UTILITY'],
  ['booking_confirmation', 'booking_confirmation', 'UTILITY'],
  ['referral_invite', 'referral_invite', 'MARKETING'],
  ['points_balance', 'points_balance', 'MARKETING'],
  ['points_expiring', 'points_expiring', 'MARKETING'],
  ['booking_reminder', 'booking_reminder', 'UTILITY'],
  ['order_confirmation', 'order_confirmation', 'UTILITY'],
  ['referral_reward', 'referral_reward', 'MARKETING'],
  ['welcome_optin', 'welcome_optin', 'MARKETING'],
  ['promotion_weekend', 'promotion', 'MARKETING'],
  ['promotion_new_arrival', 'promotion', 'MARKETING'],
  ['promotion_flash_sale', 'promotion', 'MARKETING'],
  ['greeting_ramadan', 'greeting', 'MARKETING'],
  ['greeting_eid', 'greeting', 'MARKETING'],
  ['greeting_national_day', 'greeting', 'MARKETING'],
];

const LANGUAGES = ['en', 'ar'];
const ENTRIES = listLibrary();
const entryByKey = (key) => ENTRIES.find((e) => e.key === key);
const VARIANTS = ENTRIES.flatMap((entry) => LANGUAGES.map((language) => ({
  id: `${entry.key}/${language}`, entry, language, variant: entry.variants[language],
})));
const variantCases = VARIANTS.map((v) => [v.id, v]);
// welcome_optin is MARKETING at Meta (live finding) but is the consent request itself: it carries opt-in + decline buttons instead of an opt-out button.
const MARKETING = ENTRIES.filter((e) => e.category === 'MARKETING' && e.key !== 'welcome_optin');
const UTILITY = ENTRIES.filter((e) => e.category === 'UTILITY');

// Everything a customer or reviewer can read in one variant.
function textsOf(variant) {
  const out = [variant.body];
  if (variant.header) out.push(variant.header);
  if (variant.footer) out.push(variant.footer);
  for (const b of variant.buttons) out.push(b.text);
  return out;
}
function allTexts(entry) {
  return [entry.name.en, entry.name.ar, ...LANGUAGES.flatMap((l) => textsOf(entry.variants[l]))];
}

// ── Text hygiene checks. Each is proven against a deliberately bad string below,
// so a regex slip cannot turn them into tautologies. Code points are built with
// String.fromCodePoint / \u{...} escapes, never pasted as invisible characters.
const FATHATAN = String.fromCodePoint(0x064B);
const ALEF = String.fromCodePoint(0x0627);
const TEH_MARBUTA = String.fromCodePoint(0x0629);
const HAMZA = String.fromCodePoint(0x0621);
const TATWEEL = String.fromCodePoint(0x0640);
const REVERSED_TANWEEN = FATHATAN + ALEF; // fathatan BEFORE the alef: the spelling the glossary rules out (D7)
const ALLOWED_EMOJI = new Set([
  0x1F31F, 0x2705, 0x2615, 0x1F381, 0x1F48E, 0x1F389, 0x1F319, 0x1F44B, 0x2728, 0x23F3, 0x23F0, 0x1F525,
].map((cp) => String.fromCodePoint(cp)).concat(String.fromCodePoint(0x1F1F8, 0x1F1E6)));
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu;

const hasReversedTanween = (t) => t.includes(REVERSED_TANWEEN);
const hasArabicIndicDigits = (t) => /[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u.test(t);
const hasTatweel = (t) => t.includes(TATWEEL);
const invisibleCodePoints = (t) => Array.from(t)
  .filter((ch) => /[\p{Cf}\u{2028}\u{2029}\u{00A0}\u{FEFF}\u{FE00}-\u{FE0F}]/u.test(ch))
  .map((ch) => ch.codePointAt(0).toString(16));
// A fathatan must sit on an alef (the website style), a teh marbuta or a hamza.
const hasDetachedFathatan = (t) => {
  const cps = Array.from(t);
  return cps.some((ch, i) => ch === FATHATAN && ![ALEF, TEH_MARBUTA, HAMZA].includes(cps[i - 1]));
};
// Harakat U+064B..U+0652 are fine (the website uses a few); anything else is a Quranic/exotic mark.
const hasExoticMarks = (t) => /[\u{0653}-\u{065F}\u{0670}\u{06D6}-\u{06ED}]/u.test(t);
const latinLettersOutsideFields = (t) => /\p{Script=Latin}/u.test(t.replace(FIELD_RE, ''));
const hasArabicPunctuation = (t) => /[\u{060C}\u{061B}\u{061F}]/u.test(t);
const layoutProblems = (t) => {
  const p = [];
  if (t !== t.trim()) p.push('outer_whitespace');
  if (/\n{3,}/.test(t)) p.push('more_than_one_blank_line');
  if (/[ \t]\n|\n[ \t]/.test(t)) p.push('space_next_to_newline');
  if (/ {2,}/.test(t)) p.push('double_space');
  if (/[\t\r]/.test(t)) p.push('tab_or_cr');
  return p;
};
const emojiOf = (t) => Array.from(t.matchAll(EMOJI_RE), (m) => m[0]);
// An emoji closes a clause: after a space, never first, followed by end/space/newline.
const emojiPlacementProblems = (t) => {
  const p = [];
  for (const m of t.matchAll(EMOJI_RE)) {
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (!before || !before.endsWith(' ')) p.push('emoji_not_after_space');
    if (after && !/^[ \n]/.test(after)) p.push('emoji_not_at_clause_end');
  }
  return p;
};
const wordsOf = (body) => body.replace(EMOJI_RE, ' ').split(/\s+/).filter(Boolean);
const lineBreaks = (t) => (t.match(/\n/g) || []).length;
// The fixed text must not begin or end with a variable, even behind punctuation/emoji.
const startsWithVariable = (body) => /^\{[A-Za-z][A-Za-z0-9_]*\}/.test(body);
const endsWithVariable = (body) => /\{[A-Za-z][A-Za-z0-9_]*\}[\s.,;:!?\u{060C}\u{061B}\u{061F}]*(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})?[\s.,;:!?]*$/u.test(body);

describe('the hygiene checks catch what they claim to (negative controls)', () => {
  test('reversed tanween, detached fathatan, Arabic-Indic digits, tatweel, exotic marks', () => {
    expect(hasReversedTanween(`مرحب${REVERSED_TANWEEN}`)).toBe(true);
    expect(hasReversedTanween(`مرحب${ALEF}${FATHATAN}`)).toBe(false);
    expect(hasDetachedFathatan(`مرحب${REVERSED_TANWEEN}`)).toBe(true);
    expect(hasDetachedFathatan(`مرحب${ALEF}${FATHATAN}`)).toBe(false);
    expect(hasDetachedFathatan(`عاد${TEH_MARBUTA}${FATHATAN}`)).toBe(false);
    expect(hasArabicIndicDigits(`خصم ${String.fromCodePoint(0x0662, 0x0660)}%`)).toBe(true);
    expect(hasArabicIndicDigits(`خصم ${String.fromCodePoint(0x06F2, 0x06F0)}%`)).toBe(true);
    expect(hasArabicIndicDigits('خصم 20%')).toBe(false);
    expect(hasTatweel(`مرحب${TATWEEL}ا`)).toBe(true);
    expect(hasTatweel('مرحبا')).toBe(false);
    expect(hasExoticMarks(`س${String.fromCodePoint(0x0670)}`)).toBe(true);
    expect(hasExoticMarks(`نذك${String.fromCodePoint(0x0651)}رك`)).toBe(false);
  });

  test('invisible characters: bidi marks, isolates, ZWJ, NBSP, BOM, variation selectors', () => {
    for (const cp of [0x200E, 0x200F, 0x2066, 0x2069, 0x200D, 0x00A0, 0xFEFF, 0xFE0F, 0x061C, 0x2028]) {
      expect(invisibleCodePoints(`a${String.fromCodePoint(cp)}b`)).toEqual([cp.toString(16)]);
    }
    expect(invisibleCodePoints('مرحباً {name} 🌟')).toEqual([]);
  });

  test('Latin letters in Arabic copy are found, placeholders are not Latin text', () => {
    expect(latinLettersOutsideFields('واتساب WhatsApp')).toBe(true);
    expect(latinLettersOutsideFields('مرحباً {name}، رابط {order_id}')).toBe(false);
    expect(hasArabicPunctuation('Hi, there؟')).toBe(true);
    expect(hasArabicPunctuation('Hi, there?')).toBe(false);
  });

  test('layout, emoji placement and variable position', () => {
    expect(layoutProblems(' a')).toContain('outer_whitespace');
    expect(layoutProblems('a\n\n\nb')).toContain('more_than_one_blank_line');
    expect(layoutProblems('a \nb')).toContain('space_next_to_newline');
    expect(layoutProblems('a  b')).toContain('double_space');
    expect(layoutProblems('a\tb')).toContain('tab_or_cr');
    expect(layoutProblems('a\n\nb')).toEqual([]);
    expect(emojiPlacementProblems('🎁 hello')).toContain('emoji_not_after_space');
    expect(emojiPlacementProblems('hello🎁')).toContain('emoji_not_after_space');
    expect(emojiPlacementProblems('hello 🎁world')).toContain('emoji_not_at_clause_end');
    expect(emojiPlacementProblems('hello 🎁\n\nworld')).toEqual([]);
    expect(emojiPlacementProblems('hello 🇸🇦')).toEqual([]);
    expect(startsWithVariable('{name} hi')).toBe(true);
    expect(endsWithVariable('hi {name}')).toBe(true);
    expect(endsWithVariable('hi {name}.')).toBe(true);
    expect(endsWithVariable('hi {name} 🎁')).toBe(true);
    expect(endsWithVariable('hi {name} there.')).toBe(false);
  });
});

describe('library shape', () => {
  test('exactly the 17 required entries, in picker order, with the model use cases and categories', () => {
    expect(LIBRARY_KEYS).toEqual(EXPECTED.map(([key]) => key));
    expect(ENTRIES.map((e) => [e.key, e.useCase, e.category])).toEqual(EXPECTED);
  });

  test('keys are unique, snake_case and frozen', () => {
    expect(new Set(LIBRARY_KEYS).size).toBe(LIBRARY_KEYS.length);
    for (const key of LIBRARY_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(Object.isFrozen(LIBRARY_KEYS)).toBe(true);
    expect(() => LIBRARY_KEYS.push('x')).toThrow(TypeError);
    expect(LIBRARY_KEYS).toEqual(listLibrary().map((e) => e.key));
  });

  test('an entry has exactly the LibraryEntry shape; variants only carry VariantInput fields', () => {
    for (const entry of ENTRIES) {
      expect(Object.keys(entry).sort()).toEqual(['category', 'fields', 'key', 'name', 'useCase', 'variants']);
      expect(Object.keys(entry.name).sort()).toEqual(['ar', 'en']);
      expect(Object.keys(entry.variants).sort()).toEqual(['ar', 'en']);
      for (const language of LANGUAGES) {
        const v = entry.variants[language];
        expect(Object.keys(v).every((k) => ['body', 'footer', 'buttons', 'source'].includes(k))).toBe(true);
        expect(v.source).toBe('library');
        expect(Array.isArray(v.buttons)).toBe(true);
        for (const b of v.buttons) expect(Object.keys(b).sort()).toEqual(['role', 'text']);
      }
    }
  });

  test('no variant has a header (the starters are body-first; the merchant adds a title in the editor)', () => {
    for (const { id, variant } of VARIANTS) expect([id, variant.header]).toEqual([id, undefined]);
  });

  test('names are present, unique per language and in the right script', () => {
    for (const language of LANGUAGES) {
      const names = ENTRIES.map((e) => e.name[language]);
      expect(new Set(names).size).toBe(names.length);
    }
    for (const entry of ENTRIES) {
      expect(countLetters(entry.name.ar).arabic).toBeGreaterThan(0);
      expect(latinLettersOutsideFields(entry.name.ar)).toBe(false);
      expect(countLetters(entry.name.en).arabic).toBe(0);
      expect(entry.name.en.trim().length).toBeGreaterThan(0);
      expect(charLength(entry.name.en)).toBeLessThanOrEqual(60);
      expect(charLength(entry.name.ar)).toBeLessThanOrEqual(60);
    }
  });
});

describe('Meta template rules, per entry and language', () => {
  test.each(variantCases)('%s passes the template validator with no errors and no warnings', (_id, { entry, language, variant }) => {
    const result = validateVariant({ language, ...variant }, { category: entry.category });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test.each(variantCases)('%s: body <= 1024, footer <= 60 with no variable, button labels <= 20, <= 2 buttons', (_id, { variant }) => {
    expect(charLength(toPositional(variant.body).text)).toBeLessThanOrEqual(LIMITS.BODY);
    if (variant.footer) {
      expect(charLength(variant.footer)).toBeLessThanOrEqual(LIMITS.FOOTER);
      expect(extractFields(variant.footer)).toEqual([]);
    }
    expect(variant.buttons.length).toBeLessThanOrEqual(2);
    for (const b of variant.buttons) {
      expect(charLength(b.text)).toBeLessThanOrEqual(LIMITS.BUTTON_LABEL);
      expect(b.text.trim()).toBe(b.text);
      expect(BUTTON_ROLES).toContain(b.role);
    }
    expect(new Set(variant.buttons.map((b) => b.text)).size).toBe(variant.buttons.length);
  });

  test.each(variantCases)('%s: never starts or ends with a variable, no {{n}} or stray braces, no adjacent variables', (_id, { variant }) => {
    expect(startsWithVariable(variant.body)).toBe(false);
    expect(endsWithVariable(variant.body)).toBe(false);
    expect(findInvalidPlaceholders(variant.body)).toEqual([]);
    expect(variant.body).not.toMatch(/\}\s*\{/);
    expect(variant.body).not.toMatch(/\}[\s.,;:!?\u{060C}]{0,3}\{/u);
  });

  test.each(variantCases)('%s: each variable once, from the known field set, with plenty of fixed text around it', (_id, { variant }) => {
    const occurrences = extractOccurrences(variant.body);
    expect(new Set(occurrences).size).toBe(occurrences.length);
    for (const field of occurrences) expect(Object.keys(KNOWN_FIELDS)).toContain(field);
    // Meta rejects a body with too many variables for its length (error subcode 2388293).
    // The account's own approved template sits near 0.27 variables per word; stay under that.
    expect(occurrences.length / wordsOf(variant.body).length).toBeLessThanOrEqual(0.25);
    expect(charLength(toPositional(variant.body).text) / occurrences.length).toBeGreaterThanOrEqual(25);
    expect(charLength(variant.body)).toBeLessThanOrEqual(450);
  });

  test.each(variantCases)('%s: layout is clean (no stray whitespace, at most one blank line between paragraphs)', (_id, { variant }) => {
    for (const text of textsOf(variant)) expect(layoutProblems(text)).toEqual([]);
  });

  test('MARKETING variants cannot pass without their opt-out button (the guard is live)', () => {
    for (const entry of MARKETING) {
      for (const language of LANGUAGES) {
        const stripped = { language, ...entry.variants[language], buttons: [] };
        expect(validateVariant(stripped, { category: 'MARKETING' }).errors.map((e) => e.code)).toContain('marketing_requires_opt_out_button');
      }
    }
  });
});

describe('both languages say the same thing', () => {
  test.each(ENTRIES.map((e) => [e.key, e]))('%s: same fields, same number of times, same buttons in the same order', (_key, entry) => {
    const { en, ar } = entry.variants;
    expect(fieldSetsMatch(en.body, ar.body)).toEqual({ same: true, missingInB: [], extraInB: [] });
    expect(extractOccurrences(ar.body).sort()).toEqual(extractOccurrences(en.body).sort());
    expect(entry.fields).toEqual(extractFields(en.body));
    expect([...entry.fields].sort()).toEqual([...extractFields(ar.body)].sort());
    expect(entry.fields.length).toBeGreaterThan(0);
    // Payloads are chosen by button position, so role and order must match across languages.
    expect(ar.buttons.map((b) => b.role)).toEqual(en.buttons.map((b) => b.role));
    expect(Boolean(ar.footer)).toBe(Boolean(en.footer));
    // Same paragraph structure, so the side-by-side picker preview and the bilingual join read alike.
    expect(lineBreaks(ar.body)).toBe(lineBreaks(en.body));
  });

  test('percent signs follow the number directly in both languages, and a points balance is never followed by a counted noun', () => {
    for (const { variant } of VARIANTS) {
      for (const m of variant.body.matchAll(/\{discount\}(.?)/gu)) expect(m[1]).toBe('%');
      for (const m of variant.body.matchAll(/\{points\}(.?)/gu)) expect(m[1] === '' || /[.,:!\n\u{060C}]/u.test(m[1])).toBe(true);
    }
  });
});

describe('English copy', () => {
  test.each(ENTRIES.map((e) => [e.key, e]))('%s: no Arabic letters or Arabic punctuation, straight quotes only', (_key, entry) => {
    for (const text of textsOf(entry.variants.en)) {
      expect(countLetters(text).arabic).toBe(0);
      expect(hasArabicPunctuation(text)).toBe(false);
      expect(text).not.toMatch(/[\u{2018}\u{2019}\u{201C}\u{201D}]/u);
    }
  });
});

describe('Arabic copy', () => {
  test.each(ENTRIES.map((e) => [e.key, e]))('%s: Arabic body, Western digits, glossary orthography, no Latin text', (_key, entry) => {
    const ar = entry.variants.ar;
    expect(countLetters(ar.body).arabic).toBeGreaterThan(0);
    for (const text of textsOf(ar)) {
      expect(latinLettersOutsideFields(text)).toBe(false); // واتساب, never WhatsApp (spec §1)
      expect(hasArabicIndicDigits(text)).toBe(false);
      expect(hasReversedTanween(text)).toBe(false); // D7: alef then fathatan, as on the website
      expect(hasDetachedFathatan(text)).toBe(false);
      expect(hasTatweel(text)).toBe(false);
      expect(hasExoticMarks(text)).toBe(false);
      expect(text).not.toMatch(/["'\u{201C}\u{201D}\u{2018}\u{2019}]/u); // quotes are « »
    }
  });

  test.each(ENTRIES.map((e) => [e.key, e]))('%s: no invisible or bidi control characters in any text', (_key, entry) => {
    for (const text of allTexts(entry)) expect(invisibleCodePoints(text)).toEqual([]);
  });

  test('the Arabic uses the website tanween (alef then fathatan) where it uses tanween at all', () => {
    const arabic = ENTRIES.flatMap((e) => allTexts(e)).filter((t) => countLetters(t).arabic > 0).join('\n');
    expect(arabic).toContain(`مرحب${ALEF}${FATHATAN}`);
    expect(arabic).toContain(`أهل${ALEF}${FATHATAN}`);
    expect(arabic).toContain(`شكر${ALEF}${FATHATAN}`);
  });

  test('the second-person voice is masculine singular with possessive ـك (no feminine ـكِ, no plural address)', () => {
    const bodies = ENTRIES.map((e) => e.variants.ar.body).join('\n');
    expect(bodies).not.toMatch(/\u{0643}\u{0651}?[\u{0650}\u{064D}]/u); // a kaf with kasra marks feminine address (رصيدكِ)
    expect(bodies).toMatch(/رصيدك|مكافأتك|حجزك|طلبك/u);
    expect(bodies).not.toMatch(/(^|\s)(استبدلي|احصلي|شاركي|تواصلي|تصفحي)(\s|$)/u);
    expect(bodies).not.toMatch(/(^|\s)(استبدلوا|احصلوا|شاركوا|تواصلوا|تصفحوا)(\s|$)/u);
  });

  test('counted nouns are never hard-wired after a merge field; balances use the count-neutral phrase', () => {
    for (const entry of ENTRIES) {
      const { body } = entry.variants.ar;
      expect(body).not.toMatch(/\{points\}\s*(نقطة|نقاط|نقط)/u);
      expect(body).not.toMatch(/\{(discount|amount|order_id)\}\s+(ريال|درهم|عميل|طلب)/u);
      if (body.includes('{points}')) expect(body).toContain('رصيدك الحالي من النقاط: {points}');
    }
    expect(ENTRIES.filter((e) => e.variants.ar.body.includes('{points}')).map((e) => e.key))
      .toEqual(['loyalty_reminder', 'points_balance', 'points_expiring', 'referral_reward']);
  });
});

describe('emoji', () => {
  test.each(variantCases)('%s: at most two emoji, from the approved set, each closing a clause; none in footers or buttons', (_id, { variant }) => {
    const emoji = emojiOf(variant.body);
    expect(emoji.length).toBeLessThanOrEqual(2);
    for (const e of emoji) expect(ALLOWED_EMOJI.has(e)).toBe(true);
    expect(emojiPlacementProblems(variant.body)).toEqual([]);
    for (const text of [variant.footer || '', ...variant.buttons.map((b) => b.text)]) expect(emojiOf(text)).toEqual([]);
  });
});

describe('consent (spec §3.4, compliance-critical)', () => {
  test('every MARKETING variant has exactly one opt-out button in ITS OWN language', () => {
    expect(MARKETING.length).toBe(12);
    for (const entry of MARKETING) {
      expect(entry.variants.en.buttons).toEqual([{ role: 'opt_out', text: 'Opt Out' }]);
      expect(entry.variants.ar.buttons).toEqual([{ role: 'opt_out', text: 'إلغاء الاشتراك' }]);
    }
  });

  test('MARKETING footers carry the unsubscribe keyword, in Latin STOP for English and the Arabic keyword for Arabic', () => {
    for (const entry of MARKETING) {
      expect(entry.variants.en.footer).toBe('Reply STOP to unsubscribe');
      expect(entry.variants.ar.footer).toBe('لإلغاء الاشتراك أرسل: إلغاء الاشتراك');
      expect(countLetters(entry.variants.ar.footer).arabic).toBeGreaterThan(0);
    }
  });

  test('the keywords the footers tell customers to send are recognised as opt-out by the inbound matcher', () => {
    expect(classifyInboundText('STOP')).toMatchObject({ kind: 'opt_out' });
    expect(classifyInboundText('إلغاء الاشتراك')).toMatchObject({ kind: 'opt_out', isArabic: true });
    // the label a customer might type back instead of tapping
    expect(classifyInboundText(entryByKey('comeback').variants.ar.buttons[0].text)).toMatchObject({ kind: 'opt_out' });
  });

  test('UTILITY entries have no opt-out button; only welcome_optin has buttons, opt_in then decline', () => {
    for (const entry of UTILITY) {
      for (const language of LANGUAGES) {
        expect(entry.variants[language].buttons.some((b) => b.role === 'opt_out')).toBe(false);
      }
      if (entry.key !== 'welcome_optin') {
        expect(entry.variants.en.buttons).toEqual([]);
        expect(entry.variants.ar.buttons).toEqual([]);
      }
    }
    const welcome = entryByKey('welcome_optin');
    expect(welcome.variants.en.buttons).toEqual([{ role: 'opt_in', text: 'Yes, sign me up' }, { role: 'decline', text: 'No thanks' }]);
    expect(welcome.variants.ar.buttons).toEqual([{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }]);
  });

  test('the consent wording agrees with the consent catalogue (same labels, same question, modulo tanween spelling)', () => {
    catalog.reload();
    const norm = normalizeForMatch;
    const welcome = entryByKey('welcome_optin');
    const comeback = entryByKey('comeback');
    for (const language of LANGUAGES) {
      const lib = [...welcome.variants[language].buttons.map((b) => b.text), comeback.variants[language].buttons[0].text, comeback.variants[language].footer];
      const cat = ['consent.buttonOptIn', 'consent.buttonDecline', 'consent.buttonOptOut', 'consent.footerOptOutHint'].map((k) => catalog.t(language, k));
      expect(lib.map(norm)).toEqual(cat.map(norm));
    }
    const askParagraph = welcome.variants.ar.body.split('\n\n')[1];
    expect(norm(askParagraph)).toBe(norm(catalog.t('ar', 'consent.askSuffix')));
  });

  test('UTILITY copy stays non-promotional (welcome_optin must mention offers: it is the consent ask)', () => {
    const promoEn = /\b(discounts?|offers?|sales?|deals?|promo(?:tion)?s?|coupons?|vouchers?|free|bonus|rewards?|save|limited|hurry|win)\b|% off/i;
    const promoAr = /خصم|عرض|عروض|تخفيض|قسيمة|مجان|مكافأ|هدية|سارع|بادر|فرصة|محدودة/u;
    expect(promoEn.test(entryByKey('comeback').variants.en.body)).toBe(true); // the detector works
    expect(promoAr.test(entryByKey('comeback').variants.ar.body)).toBe(true);
    for (const entry of UTILITY.filter((e) => e.key !== 'welcome_optin')) {
      expect([entry.key, promoEn.test(entry.variants.en.body)]).toEqual([entry.key, false]);
      expect([entry.key, promoAr.test(entry.variants.ar.body)]).toEqual([entry.key, false]);
    }
  });
});

describe('spec §3.3 drafts: protected wording survives the rewrite', () => {
  const ar = (key) => entryByKey(key).variants.ar.body;
  const en = (key) => entryByKey(key).variants.en.body;

  test('comeback offer', () => {
    expect(ar('comeback')).toContain('اشتقنا لك');
    expect(ar('comeback')).toMatch(/مرحباً \{name\}، اشتقنا لك/u);
    expect(ar('comeback')).toContain('{discount}%');
    expect(ar('comeback')).toMatch(/حتى \{date\}/u);
    expect(entryByKey('comeback').fields).toEqual(['name', 'discount', 'date']);
    expect(en('comeback')).toMatch(/\{discount\}% off/);
    expect(en('comeback')).toMatch(/until \{date\}/);
  });

  test('loyalty reminder: count-neutral balance, redeem before the date', () => {
    expect(ar('loyalty_reminder')).toContain('أهلاً {name}');
    expect(ar('loyalty_reminder')).toContain('رصيدك الحالي من النقاط: {points}');
    expect(ar('loyalty_reminder')).toMatch(/استبدلها قبل \{date\} واستمتع بمكافأتك/u);
    expect(entryByKey('loyalty_reminder').fields).toEqual(['name', 'points', 'date']);
  });

  test('payment reminder: order number and payment link', () => {
    expect(ar('payment_reminder')).toContain('نذكّرك بإتمام الدفع لطلبك رقم {order_id}');
    expect(ar('payment_reminder')).toContain('رابط الدفع: {link}');
    expect(entryByKey('payment_reminder').fields).toEqual(['name', 'order_id', 'link']);
    expect(en('payment_reminder')).toContain('{order_id}');
    expect(en('payment_reminder')).toContain('{link}');
  });

  test('booking confirmation: the confirmation wording, service, date and time', () => {
    expect(ar('booking_confirmation')).toContain('تم تأكيد حجزك يا {name}');
    expect(ar('booking_confirmation')).toContain('الخدمة: {service}');
    expect(ar('booking_confirmation')).toContain('الموعد: {date} الساعة {time}');
    expect(ar('booking_confirmation')).toContain('بانتظارك');
    expect(entryByKey('booking_confirmation').fields).toEqual(['name', 'service', 'date', 'time']);
  });

  test('referral invitation: the invite link and the discount on the first order', () => {
    expect(ar('referral_invite')).toContain('دعوة خاصة');
    expect(ar('referral_invite')).toContain('{discount}%');
    expect(ar('referral_invite')).toContain('أول طلب');
    expect(ar('referral_invite')).toContain('{link}');
    expect(en('referral_invite')).toContain('special invitation');
    expect(en('referral_invite')).toContain('{discount}% off their first order');
    expect(entryByKey('referral_invite').fields).toEqual(['name', 'discount', 'link']);
    // {name} is the RECIPIENT's first name in a campaign: it must never be the one who "sent" the invite.
    expect(ar('referral_invite')).not.toMatch(/\{name\} أرسل لك/u);
    expect(en('referral_invite')).not.toMatch(/\{name\} (has )?(sent|invited)/);
  });
});

describe('the library renders and submits cleanly with the existing helpers', () => {
  test.each(variantCases)('%s renders with sample values, no leftover placeholders', (_id, { language, variant }) => {
    const values = Object.fromEntries(Object.keys(KNOWN_FIELDS).map((field) => [field, sampleValue(field, language)]));
    const rendered = renderMessageSafe(variant.body, values, { language });
    expect(rendered.missing).toEqual([]);
    expect(rendered.text).not.toMatch(/[{}]/);
    expect(layoutProblems(rendered.text.replace(new RegExp(LRM, 'gu'), ''))).toEqual([]);
  });

  test('Arabic renders with Latin/number values protected by LRM and the Arabic wording intact', () => {
    const body = entryByKey('booking_confirmation').variants.ar.body;
    const out = renderMessageSafe(body, { name: 'Sara', service: 'Haircut', date: '30 Nov', time: '4:30 PM' }, { language: 'ar' }).text;
    expect(out).toContain(`${LRM}Sara${LRM}`);
    expect(out).toContain(`${LRM}30 Nov${LRM}`);
    expect(out).toContain('تم تأكيد حجزك يا');
    expect(out).not.toMatch(/[{}]/);
    const arabicValues = renderMessageSafe(body, { name: 'سارة', service: 'قص شعر', date: '30 نوفمبر', time: '4:30 م' }, { language: 'ar' }).text;
    expect(arabicValues).toContain('تم تأكيد حجزك يا سارة');
    expect(arabicValues).not.toContain(LRM);
  });

  test.each(variantCases)('%s: Meta example values can be built for every positional parameter', (_id, { language, variant }) => {
    const { params } = toPositional(variant.body);
    const examples = sampleValues(params, language);
    expect(examples).toHaveLength(params.length);
    for (const example of examples) {
      expect(example.trim().length).toBeGreaterThan(0);
      expect(example).not.toMatch(/[\r\n\t]/);
    }
    // every starter greets by {name}, so an Arabic variant's examples are Arabic too
    if (language === 'ar') expect(examples.some((x) => countLetters(x).arabic > 0)).toBe(true);
  });
});

describe('listLibrary / getLibraryEntry return deep copies', () => {
  test('mutating a returned list or entry never changes the library', () => {
    const first = listLibrary();
    first[0].variants.ar.body = 'changed';
    first[0].variants.ar.buttons.push({ role: 'opt_in', text: 'x' });
    first[0].variants.en.buttons[0].text = 'changed';
    first[0].fields.push('bogus');
    first[0].name.ar = 'changed';
    first.pop();
    first.length = 0;

    const second = listLibrary();
    expect(second).toHaveLength(17);
    expect(second[0].variants.ar.body).toContain('اشتقنا لك');
    expect(second[0].variants.ar.buttons).toEqual([{ role: 'opt_out', text: 'إلغاء الاشتراك' }]);
    expect(second[0].variants.en.buttons[0].text).toBe('Opt Out');
    expect(second[0].fields).toEqual(['name', 'discount', 'date']);
    expect(second[0].name.ar).toBe('عرض عودة');

    const entry = getLibraryEntry('comeback');
    entry.variants.ar.body = 'changed again';
    delete entry.variants.en;
    expect(getLibraryEntry('comeback').variants.ar.body).toContain('اشتقنا لك');
    expect(getLibraryEntry('comeback').variants.en).toBeDefined();
    expect(listLibrary()[0].variants.ar.body).toContain('اشتقنا لك');
  });

  test('copies are fresh objects each call, with identical content', () => {
    const a = listLibrary();
    const b = listLibrary();
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(b[0]);
    expect(a[0].variants).not.toBe(b[0].variants);
    expect(a[0].variants.ar.buttons).not.toBe(b[0].variants.ar.buttons);
    expect(getLibraryEntry('comeback')).toEqual(a[0]);
    expect(getLibraryEntry('comeback')).not.toBe(a[0]);
  });

  test('getLibraryEntry finds every key and returns null for anything else', () => {
    for (const key of LIBRARY_KEYS) expect(getLibraryEntry(key)).toMatchObject({ key });
    const unknown = ['nope', '', ' ', 'Comeback', ' comeback', 'comeback ', 'comeback\0', 'greeting', 'library.comeback',
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'x'.repeat(100000)];
    for (const key of unknown) expect(getLibraryEntry(key)).toBeNull();
    // non-strings, including NoSQL-operator-looking objects
    for (const key of [undefined, null, 0, 1, true, {}, { $ne: null }, ['comeback'], () => 'comeback', Symbol('comeback')]) {
      expect(getLibraryEntry(key)).toBeNull();
    }
  });
});

describe('listLibraryStrings (feeds the native-review export)', () => {
  const rows = listLibraryStrings();

  test('one row per Arabic string with its English source, in a stable order', () => {
    const expected = [];
    for (const e of ENTRIES) {
      const prefix = `library.${e.key}.ar`;
      expected.push([`${prefix}.name`, e.name.en, e.name.ar]);
      expected.push([`${prefix}.body`, e.variants.en.body, e.variants.ar.body]);
      if (e.variants.ar.footer) expected.push([`${prefix}.footer`, e.variants.en.footer, e.variants.ar.footer]);
      e.variants.ar.buttons.forEach((b, i) => expected.push([`${prefix}.button${i}`, e.variants.en.buttons[i].text, b.text]));
    }
    expect(rows.map((r) => [r.key, r.english, r.arabic])).toEqual(expected);
    expect(listLibraryStrings()).toEqual(rows);
  });

  test('covers every text the library holds, in both languages', () => {
    const covered = new Set(rows.flatMap((r) => [r.english, r.arabic]));
    for (const entry of ENTRIES) for (const text of allTexts(entry)) expect(covered.has(text)).toBe(true);
    // 17 names + 17 bodies + 12 footers + 12 opt-out buttons + 2 consent buttons
    expect(rows).toHaveLength(17 + 17 + 12 + 12 + 2);
  });

  test('keys are unique and follow library.<entryKey>.ar.<name|header|body|footer|button<N>> (one row per Arabic string)', () => {
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    for (const row of rows) expect(row.key).toMatch(/^library\.[a-z_]+\.ar\.(name|header|body|footer|button\d+)$/);
    expect(rows.map((r) => r.key)).toContain('library.comeback.ar.body');
    expect(rows.map((r) => r.key)).toContain('library.welcome_optin.ar.button1');
  });

  test('every row is a draft with exactly the review-script shape; both sides use the same placeholders', () => {
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['arabic', 'english', 'key', 'needsLegalApproval', 'status']);
      expect(row.status).toBe('draft');
      expect(typeof row.needsLegalApproval).toBe('boolean');
      expect(row.english.length).toBeGreaterThan(0);
      expect(countLetters(row.arabic).arabic).toBeGreaterThan(0);
      expect(extractFields(row.arabic).sort()).toEqual(extractFields(row.english).sort());
    }
  });

  test('only the consent request needs the lawyer: welcome_optin body and its two buttons', () => {
    expect(rows.filter((r) => r.needsLegalApproval).map((r) => r.key)).toEqual([
      'library.welcome_optin.ar.body', 'library.welcome_optin.ar.button0', 'library.welcome_optin.ar.button1',
    ]);
  });

  test('rows are copies: editing one never changes the next call or the library', () => {
    const mine = listLibraryStrings();
    mine[0].arabic = 'changed';
    mine.length = 0;
    expect(listLibraryStrings()[0].arabic).toBe(ENTRIES[0].name.ar);
    expect(listLibraryStrings()).toHaveLength(rows.length);
  });
});
