'use strict';
// Opt-out / opt-in / start keyword recognition for inbound WhatsApp text,
// English and Arabic. Spec §3.4 (compliance-critical):
//   opt-out : STOP, إلغاء الاشتراك، إلغاء، الغاء، توقف، ايقاف، إيقاف
//   opt-in  : نعم، موافق، اشترك  (only where an opt-in is pending)
// Both the keyword lists and the inbound text go through normalizeForMatch,
// so tashkeel, tatweel, alef/hamza spelling, yeh/teh-marbuta variants,
// punctuation, emoji and Arabic-Indic digits never defeat a match.
// Matching is on the WHOLE message (after dropping polite filler words such as
// "من فضلك"): "توقف من فضلك" is an opt-out, "لا تتوقف الخدمة عندكم؟" is not.
//
// Second tier (opt-out only, see classifyPhrase): a SHORT Arabic sentence that
// states the unsubscribe intent explicitly ("أبغى إلغاء الاشتراك", "ما أبغى
// رسائل") is also an opt-out. Rule and rationale: compliance treats a missed
// opt-out as worse than an unwanted one, so a clear unsubscribe phrase inside a
// short sentence counts. But a NEGATION in front of a cancel phrase ("ما أبغى
// إلغاء الاشتراك" = "I don't want to cancel the subscription") means the
// customer wants to KEEP it, so any negator word vetoes the cancel-style
// phrases. The refusal phrases ("لا أريد رسائل") are the one place a negator IS
// the intent, so they are listed with their object noun, and a cancel verb
// next to a refusal ("لا أريد إيقاف الرسائل") is a double negative and vetoes it.
const { normalizeForMatch, containsArabic } = require('./arabicText');

// Raw (human-readable) lists — edit here; they are normalised at load time.
const RAW = Object.freeze({
  opt_out: [
    'STOP', 'UNSUBSCRIBE',
    'إلغاء الاشتراك', 'إلغاء', 'الغاء', 'توقف', 'ايقاف', 'إيقاف',
    // "ستوب" is STOP typed in Arabic letters; "وقف/أوقف/توقفوا" are the same verb in other forms.
    'ستوب', 'وقف', 'أوقف', 'توقفوا',
    'إلغاء اشتراك', 'إلغاء الإشتراك', 'ايقاف الاشتراك', 'إيقاف الاشتراك', 'ايقاف الرسائل', 'إيقاف الرسائل',
    'توقف عن الارسال', 'توقف عن الإرسال',
  ],
  // "subscribe"/"start": re-subscribes someone who opted out (only if they had
  // genuinely consented before, same as English START) or confirms a pending ask.
  // NOT included on purpose: "أبدًا" (= "never"), which normalises to the same
  // letters as "ابدأ" (= "start") and must never re-subscribe anyone.
  subscribe: ['START', 'SUBSCRIBE', 'اشترك', 'اشتراك', 'تفعيل', 'تفعيل الاشتراك'],
  // Typed answers to a pending consent ask ("Yes, sign me up" / "No thanks").
  affirm: ['نعم', 'موافق', 'موافقة', 'أوافق', 'اوافق', 'نعم أوافق', 'نعم اوافق', 'نعم موافق', 'ايوه', 'أيوه'],
  decline: ['لا', 'لا شكرا', 'لا شكرًا', 'لا أوافق', 'لا اوافق', 'غير موافق', 'كلا'],
});

// Words that carry no intent and may surround a keyword.
const RAW_FILLERS = [
  'من فضلك', 'من فضلكم', 'لو سمحت', 'لو سمحتي', 'لو سمحتوا', 'رجاء', 'رجاءا', 'الرجاء', 'يرجى', 'لطفا',
  'شكرا', 'شكرا لكم', 'مشكور', 'يعطيك العافية', 'please', 'thanks', 'thank you', 'pls', 'plz',
];

const SETS = {};
for (const [kind, list] of Object.entries(RAW)) {
  SETS[kind] = new Set(list.map(normalizeForMatch).filter(Boolean));
}
const FILLER_PHRASES = RAW_FILLERS.map(normalizeForMatch).filter(Boolean).sort((a, b) => b.length - a.length);

// Explicit unsubscribe phrases accepted inside a short sentence (spelling is
// normalised, so alef/hamza/yeh/teh-marbuta variants all match).
const RAW_OPT_OUT_PHRASES = [
  'إلغاء الاشتراك', 'إلغاء اشتراكي', 'إلغاء اشتراك', 'الغي الاشتراك', 'الغي اشتراكي', 'الغوا الاشتراك', 'الغوا اشتراكي', 'الغو الاشتراك', 'الغو اشتراكي',
  'إيقاف الاشتراك', 'ايقاف الرسائل', 'ايقاف الرسايل', 'إلغاء الرسائل', 'الغاء الرسايل', 'وقف الرسائل', 'وقف الرسايل',
  'أوقف الرسائل', 'أوقفوا الرسائل', 'أوقفو الرسائل', 'أوقف الرسايل', 'أوقفوا الرسايل',
  'وقفوا الرسائل', 'وقفو الرسائل', 'وقفوا الرسايل', 'وقفو الرسايل',
  'توقف عن الإرسال', 'توقفوا عن الإرسال', 'توقفو عن الإرسال', 'توقف عن مراسلتي', 'توقفوا عن مراسلتي',
];
// Refusal sentences: <lead> ... <object> with the object within a few words.
const RAW_REFUSAL_LEADS = [
  'لا أريد', 'لا أرغب', 'لا أبغى', 'لا أبي', 'ما أريد', 'ما أرغب', 'ما أبغى', 'ما أبي',
  'لا ترسل', 'لا ترسلوا', 'لا ترسلو', 'لا تراسل', 'لا تراسلني', 'لا تراسلوني', 'لا تراسلوا', 'لا تراسلو', 'لا تبعث', 'لا تبعثوا',
];
// "Do not message ME": the verb itself is the object, so no noun is needed ("لا تراسلوني" alone,
// "لا تراسلوني أبدا") and a missed opt-out is the worse error. "لا ترسلوا" (do not SEND) is NOT
// here: it needs its noun ("لا ترسلوا الطلب اليوم" is about an order, not an unsubscribe).
const RAW_STANDALONE_REFUSALS = ['لا تراسلني', 'لا تراسلوني', 'لا تراسلنا'];
const RAW_REFUSAL_OBJECTS = [
  'رسائل', 'رسايل', 'عروض', 'إعلانات', 'ترويجية', 'ترويجيات', 'تسويقية', 'رسائلكم', 'رسايلكم', 'عروضكم',
  'الرسائل', 'الرسايل', 'العروض', 'الإعلانات', 'برسائل', 'برسايل', 'بعروض', 'بالرسائل', 'بالرسايل', 'بالعروض', 'بالإعلانات',
];
const RAW_CANCEL_WORDS = ['إلغاء', 'الغي', 'الغوا', 'الغو', 'إيقاف', 'أوقف', 'أوقفوا', 'وقف', 'توقف', 'توقفوا'];
// Words that flip the meaning of a cancel-style phrase.
const RAW_NEGATORS = ['لا', 'لن', 'لم', 'ما', 'مو', 'مب', 'ليس', 'ليست', 'غير', 'بدون', 'دون', 'عدم', 'no', 'not', 'dont', 'don', 'never'];
// A bare STOP-like token inside an Arabic sentence ("وقف stop الرسائل", "ستوب ليش ترسلون").
const RAW_STOP_TOKENS = ['stop', 'unsubscribe', 'ستوب'];

const MAX_COMMAND_LENGTH = 60;
const MAX_SENTENCE_LENGTH = 120;
const MAX_SENTENCE_WORDS = 12;
const REFUSAL_OBJECT_WINDOW = 5;

const OPT_OUT_PHRASES = RAW_OPT_OUT_PHRASES.map(normalizeForMatch).filter(Boolean);
const REFUSAL_LEADS = RAW_REFUSAL_LEADS.map((p) => normalizeForMatch(p).split(' '));
const STANDALONE_REFUSALS = RAW_STANDALONE_REFUSALS.map((p) => normalizeForMatch(p).split(' '));
const REFUSAL_OBJECTS = new Set(RAW_REFUSAL_OBJECTS.map(normalizeForMatch));
const CANCEL_WORDS = new Set(RAW_CANCEL_WORDS.map(normalizeForMatch));
const NEGATORS = new Set(RAW_NEGATORS.map(normalizeForMatch));
const STOP_TOKENS = new Set(RAW_STOP_TOKENS.map(normalizeForMatch));

function stripFillers(normalized) {
  let s = ` ${normalized} `;
  for (const phrase of FILLER_PHRASES) {
    s = s.split(` ${phrase} `).join(' ');
  }
  return s.replace(/\s+/g, ' ').trim();
}

function startsWithAt(tokens, i, lead) {
  return lead.every((w, k) => tokens[i + k] === w);
}

function hasRefusal(tokens) {
  if (tokens.some((w) => CANCEL_WORDS.has(w))) return false;
  for (let i = 0; i < tokens.length; i += 1) {
    if (STANDALONE_REFUSALS.some((l) => startsWithAt(tokens, i, l))) return true;
    const lead = REFUSAL_LEADS.find((l) => startsWithAt(tokens, i, l));
    if (!lead) continue;
    const rest = tokens.slice(i + lead.length, i + lead.length + REFUSAL_OBJECT_WINDOW);
    if (rest.some((w) => REFUSAL_OBJECTS.has(w))) return true;
  }
  return false;
}

// Second tier: a short Arabic sentence that explicitly asks to stop the messages.
function isOptOutSentence(text, normalized) {
  if (normalized.length > MAX_SENTENCE_LENGTH || !containsArabic(text)) return false;
  const tokens = normalized.split(' ');
  if (tokens.length > MAX_SENTENCE_WORDS) return false;
  if (hasRefusal(tokens)) return true;
  if (tokens.some((w) => NEGATORS.has(w))) return false;
  const padded = ` ${normalized} `;
  return OPT_OUT_PHRASES.some((p) => padded.includes(` ${p} `)) || tokens.some((w) => STOP_TOKENS.has(w));
}

// -> null | { kind: 'opt_out'|'subscribe'|'affirm'|'decline', keyword, isArabic, match: 'exact'|'phrase' }
// `kind` priority when a phrase appears in several lists: opt_out wins.
function classifyInboundText(text) {
  const normalized = normalizeForMatch(text);
  if (!normalized) return null;
  if (normalized.length <= MAX_COMMAND_LENGTH) {
    const core = stripFillers(normalized);
    if (!core) return null;
    for (const kind of ['opt_out', 'subscribe', 'affirm', 'decline']) {
      if (SETS[kind].has(core)) return { kind, keyword: core, isArabic: containsArabic(text), match: 'exact' };
    }
  }
  return isOptOutSentence(text, normalized) ? { kind: 'opt_out', keyword: normalized, isArabic: true, match: 'phrase' } : null;
}

module.exports = { RAW, RAW_FILLERS, MAX_COMMAND_LENGTH, MAX_SENTENCE_LENGTH, classifyInboundText, stripFillers, SETS };
