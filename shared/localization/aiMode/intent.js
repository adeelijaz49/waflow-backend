'use strict';
// A soft check for one specific failure of an Arabic-capable agent: the model
// proposes a send / activation / refund although the merchant's message
// contains no recognisable request for it (a data question read as a command, a
// dialect word read as a different verb). The confirmation card is the real
// safety net and nothing here blocks anything; this only decides whether the
// card gets an extra caution line ("I wasn't sure you asked for this...", see
// catalog aimode.caution.noIntent).
//
// Why it must not block: legitimate flows have no verb in them. After "should I
// send them a reminder?" the merchant answers "تمام" or "yes", and the model
// then proposes the send. Short affirmations therefore count as intent for any
// action. A false "no intent" only costs one extra sentence on the card; a
// false "intent" costs nothing more than today, so the lists below lean wide.
//
// Matching is symmetric: the message AND every stem go through
// arabicText.normalizeForMatch (diacritics, tatweel, alef/yeh/teh-marbuta
// variants, digits, case) so "أرسِل", "ارسل" and "ارسلها" meet the same stem.
// Arabic stems are matched anywhere inside the text (verbs carry prefixes like
// ن/ي/ت/س: "نرسل" contains the stem "رسل"); Latin stems only at the start of a
// word, so "text" does not match "context".
const { normalizeForMatch } = require('../arabicText');

const SEND = ['send', 'resend', 'text', 'message', 'msg', 'whatsapp', 'broadcast', 'blast', 'dispatch', 'share', 'push', 'promote', 'launch',
  'go ahead', 'do it', 'رسل', 'بعث', 'عمم', 'نفذ', 'روج', 'اطلق'];
const REMIND = ['remind', 'reminder', 'notify', 'nudge', 'ذكر', 'تذكير', 'نبه'];
const TEST = ['test', 'trial', 'تجرب', 'تجريب', 'جرب'];
const ACTIVATE = ['activate', 'enable', 'turn on', 'switch on', 'start', 'launch', 'go live', 'run', 'publish', 'فعل', 'تفعيل', 'شغل', 'تشغيل', 'ابدا', 'اطلق'];
const REFUND = ['refund', 'reimburs', 'money back', 'chargeback', 'استرجع', 'استرجاع', 'استرد', 'ريفند', 'ارجاع', 'ارجع', 'رد المبلغ', 'رد مبلغ', 'رد الفلوس', 'رد فلوس', 'تعويض'];

// Whole-message answers to "should I go ahead?".
const AFFIRMATIONS = ['نعم', 'ايوه', 'ايوا', 'اي', 'ايه', 'اكيد', 'تمام', 'طيب', 'ماشي', 'يلا', 'موافق', 'اوافق', 'ابشر',
  'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'confirm', 'proceed', 'continue', 'approve', 'approved', 'go'];
const MAX_AFFIRMATION_TOKENS = 6;

const norm = (list) => list.map((s) => normalizeForMatch(s)).filter(Boolean);
const STEMS = Object.freeze({
  send_promotion: norm(SEND),
  send_test_message: norm([...SEND, ...TEST]),
  send_loyalty_reminders: norm([...SEND, ...REMIND]),
  activate_flow: norm(ACTIVATE),
  refund_order: norm(REFUND),
});
const AFFIRMATION_SET = new Set(norm(AFFIRMATIONS));

function startsWord(padded, stem) {
  return padded.includes(` ${stem}`);
}

function hasStem(normalized, padded, stem) {
  return /^[a-z]/.test(stem) ? startsWord(padded, stem) : normalized.includes(stem);
}

// True when `text` (the merchant's latest message, any language) contains a
// request that fits `toolName`, or is a short "yes / تمام" style answer.
// Unknown tools are never "recognised" so they always carry the caution.
function hasActionIntent(toolName, text) {
  const stems = STEMS[toolName];
  const normalized = normalizeForMatch(text);
  if (!stems || !normalized) return false;
  const tokens = normalized.split(' ');
  if (tokens.length <= MAX_AFFIRMATION_TOKENS && tokens.some((t) => AFFIRMATION_SET.has(t))) return true;
  const padded = ` ${normalized}`;
  return stems.some((stem) => hasStem(normalized, padded, stem));
}

module.exports = { hasActionIntent, STEMS };
