'use strict';
// Starter-message library: ready-made English + Arabic WhatsApp template copy
// a merchant can insert in the template editor and then edit (spec §3.3 "Arabic
// versions of these system messages", §4 "an insertable library per use case,
// editable by the merchant", §8 draft/review rules).
//
// Content only: no I/O, no models, no side effects at require time.
// shared/localization/templates.js ("from-library") turns an entry into a
// LocalizedTemplate; the native-review script reads listLibraryStrings().
//
// Decisions worth knowing before editing the copy:
//  * Every variant is `source:'library'` and the Arabic is a DRAFT. Nothing in
//    this file may ever claim to be reviewed (spec §8) — a native reader does that.
//  * The Arabic is written the way a Saudi shop would write it (warm MSA, short
//    clauses, emoji at the end of a clause), not translated from the English.
//    Glossary + orthography: design/GLOSSARY.md — tanween as alef + fathatan
//    like the website (مرحباً, never the reversed order), Western digits, no
//    tatweel, واتساب (never Latin), second person masculine singular.
//  * Counted nouns are never hard-wired after a merge field ("{points} نقطة" is
//    wrong for 1, 2 and 3-10): the balance is introduced with count-neutral
//    wording, "رصيدك الحالي من النقاط: {points}" (glossary D10).
//  * Meta rules the copy is written against (tests/localization/templateLibrary.test.js
//    enforces them): body <= 1024; button label <= 20; footer <= 60 with no
//    variable; a body never starts or ends with a variable; no adjacent
//    variables; each variable used once with plenty of fixed text around it (Meta
//    rejects "parameters words ratio exceeds limit", error subcode 2388293);
//    UTILITY copy stays non-promotional.
//  * Consent (spec §3.4, compliance-critical): every MARKETING variant carries
//    an opt-out QUICK_REPLY button in ITS OWN language plus the keyword footer;
//    welcome_optin (the consent request) carries opt-in / decline buttons. The
//    footers and labels equal consent.footerOptOutHint / consent.button* and
//    templates.defaultMarketingFooter in catalog/*.json, so a merchant never
//    sees two different wordings for the same thing.
//  * No headers: a header is the strictest part of a template (60 chars, one
//    variable, no line breaks), so the starters stay body-first and the merchant
//    adds a title in the editor if wanted.
//  * referral_invite addresses the RECIPIENT (the existing English referral text
//    in shared/referrals.js does too). The spec draft puts the referrer's name in
//    {name}, but a campaign fills {name} with the recipient's own first name, so
//    that wording would tell Sara she was invited by Sara.
//  * Merge fields come from mergeFields.KNOWN_FIELDS only. name, full_name, points
//    and business are filled per customer by the campaign sender; every other field
//    is supplied by the merchant, so the starters keep the number of those small.

const { extractFields } = require('./mergeFields');

const SOURCE = 'library';

// The consent request is the wording itself, so the owner's lawyer must approve it
// as well as the native reader (GLOSSARY.md "needsLegalApproval").
const NEEDS_LEGAL_APPROVAL = new Set(['welcome_optin']);

const OPT_OUT = Object.freeze({
  en: { button: 'Opt Out', footer: 'Reply STOP to unsubscribe' },
  ar: { button: 'إلغاء الاشتراك', footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك' },
});

const CONSENT_BUTTONS = Object.freeze({
  en: [{ role: 'opt_in', text: 'Yes, sign me up' }, { role: 'decline', text: 'No thanks' }],
  ar: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }],
});

// Paragraphs are separated by one blank line; inside a paragraph "\n" starts a new line.
function paragraphs(...parts) { return parts.join('\n\n'); }

// Explicit `buttons` (the consent request) win. Otherwise MARKETING gets the opt-out
// button and keyword footer in its own language, and UTILITY gets neither.
function buildVariant(language, category, body, buttons) {
  if (buttons) return { body, buttons: buttons.map((b) => ({ ...b })), source: SOURCE };
  if (category === 'MARKETING') {
    return {
      body,
      footer: OPT_OUT[language].footer,
      buttons: [{ role: 'opt_out', text: OPT_OUT[language].button }],
      source: SOURCE,
    };
  }
  return { body, buttons: [], source: SOURCE };
}

// `fields` is derived from the English body so it can never drift from the copy;
// the tests assert the Arabic body uses exactly the same set.
function define({ key, useCase, category, name, en, ar, buttons }) {
  return {
    key,
    useCase,
    category,
    name,
    fields: extractFields(en),
    variants: {
      en: buildVariant('en', category, en, buttons && buttons.en),
      ar: buildVariant('ar', category, ar, buttons && buttons.ar),
    },
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// Order = the order the picker shows: the five spec §3.3 messages first, then the
// remaining system messages, promotions and greetings.
const ENTRIES = deepFreeze([
  define({
    key: 'comeback',
    useCase: 'comeback',
    category: 'MARKETING',
    name: { en: 'Come-back offer', ar: 'عرض عودة' },
    en: paragraphs(
      "Hi {name}, we've missed you! 🌟",
      'Enjoy {discount}% off your next order. The offer is valid until {date}, so come back and see us soon.',
    ),
    ar: paragraphs(
      'مرحباً {name}، اشتقنا لك 🌟',
      'استمتع بخصم {discount}% على طلبك القادم، والعرض ساري حتى {date}. بانتظارك!',
    ),
  }),

  define({
    key: 'loyalty_reminder',
    useCase: 'loyalty_reminder',
    category: 'MARKETING',
    name: { en: 'Loyalty points reminder', ar: 'تذكير بنقاط الولاء' },
    en: paragraphs(
      'Hi {name}, your points are waiting for you 🎁',
      'Your current points balance is {points}. Redeem your points before {date} and enjoy your reward.',
    ),
    ar: paragraphs(
      'أهلاً {name}، نقاطك بانتظارك 🎁',
      'رصيدك الحالي من النقاط: {points}. استبدلها قبل {date} واستمتع بمكافأتك.',
    ),
  }),

  define({
    key: 'payment_reminder',
    useCase: 'payment_reminder',
    category: 'UTILITY',
    name: { en: 'Payment reminder', ar: 'تذكير بالدفع' },
    en: paragraphs(
      'Hi {name}, this is a friendly reminder to complete the payment for your order {order_id}.',
      'Payment link: {link}',
      "If you've already paid, no further action is needed. Thank you!",
    ),
    ar: paragraphs(
      'مرحباً {name}، نذكّرك بإتمام الدفع لطلبك رقم {order_id}.',
      'رابط الدفع: {link}',
      'إذا أتممت الدفع بالفعل، فلا داعي لأي إجراء. شكراً لك!',
    ),
  }),

  define({
    key: 'booking_confirmation',
    useCase: 'booking_confirmation',
    category: 'UTILITY',
    name: { en: 'Booking confirmation', ar: 'تأكيد الحجز' },
    en: paragraphs(
      'Your booking is confirmed, {name} ✅',
      'Service: {service}\nDate & time: {date} at {time}',
      'Need to change something? Just reply to this message. We look forward to seeing you!',
    ),
    ar: paragraphs(
      'تم تأكيد حجزك يا {name} ✅',
      'الخدمة: {service}\nالموعد: {date} الساعة {time}',
      'إذا احتجت إلى تعديل الموعد، فتواصل معنا هنا. بانتظارك!',
    ),
  }),

  define({
    key: 'referral_invite',
    useCase: 'referral_invite',
    category: 'MARKETING',
    name: { en: 'Referral invitation', ar: 'دعوة إحالة' },
    en: paragraphs(
      'Hi {name}, you have a special invitation to share with a friend: they get {discount}% off their first order, and you earn your own reward after their first purchase! 🎁',
      'Invite link: {link}',
      'Thank you for spreading the word!',
    ),
    ar: paragraphs(
      'أهلاً {name}، لديك دعوة خاصة لتشاركها مع صديق: يحصل على خصم {discount}% على أول طلب، وتنال أنت مكافأتك بعد أول شراء له 🎁',
      'رابط الدعوة: {link}',
      'شكراً لدعمك لنا!',
    ),
  }),

  define({
    key: 'points_balance',
    useCase: 'points_balance',
    category: 'MARKETING',
    name: { en: 'Points balance', ar: 'رصيد النقاط' },
    en: paragraphs(
      'Hi {name}, thanks for shopping with us! 💎',
      'Your current points balance is {points}. Keep collecting points and redeem them for great rewards on your next visit.',
    ),
    ar: paragraphs(
      'أهلاً {name}، شكراً لتعاملك معنا 💎',
      'رصيدك الحالي من النقاط: {points}. واصل جمع النقاط واستبدلها بمكافآت مميزة في زيارتك القادمة.',
    ),
  }),

  define({
    key: 'points_expiring',
    useCase: 'points_expiring',
    category: 'MARKETING',
    name: { en: 'Points expiring soon', ar: 'نقاط على وشك الانتهاء' },
    en: paragraphs(
      'Hi {name}, your points are about to expire ⏳',
      "Your current points balance is {points}, and it expires on {date}. Redeem your points before then so you don't miss out on your reward!",
    ),
    ar: paragraphs(
      'أهلاً {name}، نقاطك على وشك الانتهاء ⏳',
      'رصيدك الحالي من النقاط: {points}، وتنتهي صلاحيتها في {date}. استبدلها قبل ذلك ولا تفوّت مكافأتك!',
    ),
  }),

  define({
    key: 'booking_reminder',
    useCase: 'booking_reminder',
    category: 'UTILITY',
    name: { en: 'Booking reminder', ar: 'تذكير بالحجز' },
    en: paragraphs(
      'Hi {name}, a quick reminder about your upcoming appointment ⏰',
      'Service: {service}\nDate & time: {date} at {time}',
      "Can't make it? Please let us know by replying to this message. See you soon!",
    ),
    ar: paragraphs(
      'تذكير بموعدك القادم يا {name} ⏰',
      'الخدمة: {service}\nالموعد: {date} الساعة {time}',
      'إذا لم تتمكن من الحضور، فنرجو إبلاغنا بالرد على هذه الرسالة. بانتظارك!',
    ),
  }),

  define({
    key: 'order_confirmation',
    useCase: 'order_confirmation',
    category: 'UTILITY',
    name: { en: 'Order confirmation', ar: 'تأكيد الطلب' },
    en: paragraphs(
      'Thank you, {name}! Your order {order_id} is confirmed ✅',
      'Order total: {amount}',
      "We'll keep you updated about your order right here. We appreciate your trust in us.",
    ),
    ar: paragraphs(
      'شكراً يا {name}! تم تأكيد طلبك رقم {order_id} ✅',
      'المبلغ الإجمالي: {amount}',
      'سنوافيك بأي تحديثات عن طلبك هنا. نقدّر ثقتك بنا.',
    ),
  }),

  define({
    key: 'referral_reward',
    useCase: 'referral_reward',
    category: 'MARKETING',
    name: { en: 'Referral reward', ar: 'مكافأة الإحالة' },
    en: paragraphs(
      "Congratulations, {name}! 🎉 Your friend just completed their first order, and we've added your referral reward to your balance.",
      'Your current points balance is {points}. Thank you for recommending us!',
    ),
    ar: paragraphs(
      'مبروك يا {name}! 🎉 أكمل صديقك أول طلب له، وأضفنا مكافأة الإحالة إلى رصيدك.',
      'رصيدك الحالي من النقاط: {points}. شكراً لتوصيتك بنا!',
    ),
  }),

  // The consent request. Mirrors the wording of catalog/consent.json (askSuffix and
  // the three button labels) so the opt-in question reads the same everywhere.
  define({
    key: 'welcome_optin',
    useCase: 'welcome_optin',
    category: 'MARKETING',
    name: { en: 'Welcome and opt-in', ar: 'ترحيب وطلب الموافقة' },
    en: paragraphs(
      'Hi {name}, welcome to {business}! 👋',
      'Would you like to receive occasional offers and updates from us on WhatsApp?',
    ),
    ar: paragraphs(
      'حياك الله يا {name} في {business} 👋',
      'هل تود أن تصلك عروضنا وتحديثاتنا عبر واتساب بين وقت وآخر؟',
    ),
    buttons: CONSENT_BUTTONS,
  }),

  define({
    key: 'promotion_weekend',
    useCase: 'promotion',
    category: 'MARKETING',
    name: { en: 'Weekend offer', ar: 'عرض نهاية الأسبوع' },
    en: paragraphs(
      'Hi {name}, our weekend offer is here! 🎁',
      "Enjoy {discount}% off your purchases until {date}. Don't miss out!",
    ),
    ar: paragraphs(
      'مرحباً {name}، عرض نهاية الأسبوع وصل 🎁',
      'استمتع بخصم {discount}% على مشترياتك حتى {date}. لا تفوّت الفرصة!',
    ),
  }),

  define({
    key: 'promotion_new_arrival',
    useCase: 'promotion',
    category: 'MARKETING',
    name: { en: 'New arrivals', ar: 'وصل حديثاً' },
    en: paragraphs(
      "Hi {name}, our new collection has just arrived and we think you'll love it ✨",
      'Take a look: {link}',
      'Be among the first to get yours while stock lasts!',
    ),
    ar: paragraphs(
      'أهلاً {name}، وصلتنا تشكيلة جديدة نظن أنها ستعجبك ✨',
      'تصفحها الآن: {link}',
      'كن من أوائل من يحصل عليها قبل نفاد الكمية!',
    ),
  }),

  define({
    key: 'promotion_flash_sale',
    useCase: 'promotion',
    category: 'MARKETING',
    name: { en: 'Flash sale', ar: 'تخفيضات خاطفة' },
    en: paragraphs(
      'Hi {name}, flash sale! For a limited time only 🔥',
      'Enjoy {discount}% off your purchases. The offer ends today at {time}, so hurry!',
    ),
    ar: paragraphs(
      'مرحباً {name}، تخفيضات خاطفة لفترة محدودة 🔥',
      'خصم {discount}% على مشترياتك، وينتهي العرض اليوم الساعة {time}. سارع قبل انتهاء الوقت!',
    ),
  }),

  define({
    key: 'greeting_ramadan',
    useCase: 'greeting',
    category: 'MARKETING',
    name: { en: 'Ramadan greeting', ar: 'تهنئة رمضان' },
    en: paragraphs(
      'Ramadan Kareem, {name} 🌙',
      'Everyone at {business} wishes you a blessed month filled with goodness and joy. Wishing you and your family all the best!',
    ),
    ar: paragraphs(
      'رمضان كريم يا {name} 🌙',
      'يتمنى لك فريق {business} شهراً مباركاً مليئاً بالخير والسعادة. كل عام وأنت وأسرتك بخير!',
    ),
  }),

  define({
    key: 'greeting_eid',
    useCase: 'greeting',
    category: 'MARKETING',
    name: { en: 'Eid greeting', ar: 'تهنئة العيد' },
    en: paragraphs(
      'Eid Mubarak, {name} 🎉',
      'Everyone at {business} wishes you and your family days full of joy and happiness. Wishing you all the best!',
    ),
    ar: paragraphs(
      'عيد مبارك يا {name} 🎉',
      'يهنئك فريق {business} بالعيد، ويتمنى لك ولأسرتك أياماً مليئة بالفرح والسعادة. كل عام وأنت بخير!',
    ),
  }),

  define({
    key: 'greeting_national_day',
    useCase: 'greeting',
    category: 'MARKETING',
    name: { en: 'Saudi National Day greeting', ar: 'تهنئة اليوم الوطني السعودي' },
    en: paragraphs(
      'Happy Saudi National Day, {name}! 🇸🇦',
      'Everyone at {business} wishes you and your family a day full of pride and joy.',
    ),
    ar: paragraphs(
      'يوم وطني سعيد يا {name} 🇸🇦',
      'يهنئك فريق {business} بمناسبة اليوم الوطني السعودي، ويتمنى لك ولأسرتك يوماً مليئاً بالفخر والفرح.',
    ),
  }),

  // Last on purpose (the picker order above is unchanged). The one loyalty reminder every existing sender can fill without
  // help: {name}, {points} and {amount} (the points' worth, points / 10 written like 12.50 ر.س) are all derived per
  // customer by shared/localization/senderValues.js, unlike loyalty_reminder whose {date} nobody can supply
  // (there is no points expiry). It mirrors the English loyalty template shared/operations.js#sendLoyaltyReminders sends.
  define({
    key: 'loyalty_reminder_balance',
    useCase: 'loyalty_reminder',
    category: 'MARKETING',
    name: { en: 'Loyalty points balance reminder', ar: 'تذكير برصيد نقاط الولاء' },
    en: paragraphs(
      'Hi {name}, your loyalty points are waiting for you 💎',
      'Your current points balance is {points}, worth {amount}. Pop in and use them on your next purchase, we would love to see you!',
    ),
    ar: paragraphs(
      'أهلاً {name}، نقاط ولائك بانتظارك 💎',
      'رصيدك الحالي من النقاط: {points}، وقيمته {amount}. زرنا واستخدمها في مشترياتك القادمة، يسعدنا استقبالك!',
    ),
  }),
]);

const LIBRARY_KEYS = Object.freeze(ENTRIES.map((e) => e.key));
const BY_KEY = new Map(ENTRIES.map((e) => [e.key, e]));

// Callers (the editor, from-library) mutate what they get, so hand out copies.
function clone(value) { return JSON.parse(JSON.stringify(value)); }

// -> LibraryEntry[] (deep copies)
function listLibrary() { return clone(ENTRIES); }

// Exact key only; anything else (unknown key, wrong case, non-string) -> null.
function getLibraryEntry(key) {
  const found = typeof key === 'string' ? BY_KEY.get(key) : undefined;
  return found ? clone(found) : null;
}

// One row per Arabic string, for the native-review export (spec §8: "key, English,
// Arabic, status"). The key names the Arabic text; `english` is the source it is
// reviewed against. Rows are read-only for the review script: the library lives in
// this file, so an accepted correction is applied here by hand.
//   key: library.<entryKey>.ar.<name|header|body|footer|button<N>>   (N = 0-based)
function listLibraryStrings() {
  const rows = [];
  for (const entry of ENTRIES) {
    const legal = NEEDS_LEGAL_APPROVAL.has(entry.key);
    const add = (part, english, arabic, needsLegalApproval) => {
      rows.push({ key: `library.${entry.key}.ar.${part}`, english, arabic, status: 'draft', needsLegalApproval });
    };
    add('name', entry.name.en, entry.name.ar, false);
    const { en, ar } = entry.variants;
    for (const part of ['header', 'body', 'footer']) {
      if (ar[part]) add(part, en[part] || '', ar[part], legal && part === 'body');
    }
    ar.buttons.forEach((button, i) => add(`button${i}`, (en.buttons[i] || {}).text || '', button.text, legal));
  }
  return rows;
}

module.exports = { listLibrary, getLibraryEntry, listLibraryStrings, LIBRARY_KEYS };
