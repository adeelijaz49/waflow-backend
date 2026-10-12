'use strict';
// Helpers for wiringAcceptance.itest.js (the combined end-to-end acceptance suite of the Arabic wiring phase).
// Pure functions only (no DB, no network): payload inspection, Arabic/English text rules and normalisation.
// Not a test file.

const ARABIC_LETTER = /[\u{0621}-\u{064A}]/u;
const LATIN_LETTER = /[A-Za-z]/;
// English words the shopping journey / senders / opt-out texts use as chrome. If one of them survives in a message sent to an
// Arabic customer, the message is mixed-language. (Merchant-typed text such as product names is removed first.)
const CHROME = /\b(Sorry|Checkout|Cart|Subtotal|Shipping|Total|Delivering|securely|added|Keep|Browsing|Browse|Redeem|Prices|Tap|Booked|Please|points|pts|OFF|was|worth|Choose|Options|View|Slots|Reply|STOP|START|unsubscribed|subscribed|Opt|Out|Hi|Hello|Thanks|Thank|Welcome|Confirmed|order|booking|payment|received|reserve|Reserve)\b/;

const cp = (text) => Array.from(String(text)).length;
const isMessagesCall = (call) => /\/messages$/.test(call.url) && call.method === 'POST' && call.body && call.body.messaging_product === 'whatsapp';
const messagesOf = (calls) => calls.filter(isMessagesCall);

// Every customer-visible string of a free-form payload with its WhatsApp limit.
function visible(payload) {
  const out = [];
  if (!payload) return out;
  if (payload.type === 'text') { out.push({ kind: 'text', text: payload.text.body, max: 4096 }); return out; }
  if (payload.type !== 'interactive') return out;
  const it = payload.interactive;
  if (it.header && it.header.text) out.push({ kind: 'header', text: it.header.text, max: 60 });
  if (it.body) out.push({ kind: 'body', text: it.body.text, max: 1024 });
  if (it.footer) out.push({ kind: 'footer', text: it.footer.text, max: 60 });
  if (it.type === 'button') it.action.buttons.forEach((b) => out.push({ kind: 'button', text: b.reply.title, max: 20 }));
  if (it.type === 'list') {
    out.push({ kind: 'listButton', text: it.action.button, max: 20 });
    it.action.sections.forEach((s) => {
      out.push({ kind: 'section', text: s.title, max: 24 });
      s.rows.forEach((r) => { out.push({ kind: 'rowTitle', text: r.title, max: 24 }); if (r.description) out.push({ kind: 'rowDesc', text: r.description, max: 72 }); });
    });
  }
  return out;
}

// The same payload with every customer-visible string replaced by a placeholder: the "structure" (ids, types, counts).
function stripText(payload) {
  const c = JSON.parse(JSON.stringify(payload));
  if (c.type === 'text') c.text.body = '<t>';
  if (c.type === 'interactive') {
    const it = c.interactive;
    if (it.header && it.header.text !== undefined) it.header.text = '<t>';
    if (it.body) it.body.text = '<t>';
    if (it.footer) it.footer.text = '<t>';
    if (it.action && it.action.buttons) it.action.buttons.forEach((b) => { b.reply.title = '<t>'; });
    if (it.action && it.action.button) it.action.button = '<t>';
    if (it.action && it.action.sections) it.action.sections.forEach((s) => { s.title = '<t>'; s.rows.forEach((r) => { r.title = '<t>'; if (r.description) r.description = '<t>'; }); });
  }
  return c;
}

function withoutMerchantText(text, merchantStrings) {
  let out = String(text).replace(/https?:\/\/\S+/g, ' ');
  for (const m of merchantStrings) out = out.split(m).join(' ');
  return out.replace(/\bBulk \d+\b/g, ' ');
}

// Problems (strings) of one free-form payload sent to an ARABIC customer: a limit broken, English chrome, a field with no Arabic letter.
// `merchantStrings` = text the merchant typed (product names without a reviewed translation, addresses, variant labels): it may stay Latin.
function arabicProblems(payload, merchantStrings = []) {
  const problems = [];
  for (const v of visible(payload)) {
    if (cp(v.text) > v.max) problems.push(`${v.kind} over ${v.max}: ${v.text}`);
    const rest = withoutMerchantText(v.text, merchantStrings);
    if (CHROME.test(rest)) problems.push(`English chrome in ${v.kind}: ${v.text}`);
    if (!ARABIC_LETTER.test(v.text) && LATIN_LETTER.test(rest)) problems.push(`no Arabic letter in ${v.kind}: ${v.text}`);
  }
  return problems;
}

// Problems of one payload sent to an ENGLISH customer: any Arabic letter in a visible field.
function englishProblems(payload, merchantStrings = []) {
  const problems = [];
  for (const v of visible(payload)) {
    if (ARABIC_LETTER.test(withoutMerchantText(v.text, merchantStrings))) problems.push(`Arabic in ${v.kind}: ${v.text}`);
  }
  return problems;
}

// Replace everything that differs per run (phones, ids, payment intents, wamids) so two runs can be compared byte for byte.
function normalise(calls, customer) {
  let s = JSON.stringify(calls);
  if (customer) s = s.split(customer.phone).join('<P>').split(String(customer._id)).join('<C>');
  return JSON.parse(s.replace(/pi_stub_\d+/g, '<PI>').replace(/wamid\.[A-Za-z0-9._-]+/g, '<W>'));
}

const signature = (calls) => calls.map((c) => `${c.method} ${c.url.replace(/^https?:\/\/[^/]+/, '')} ${(c.body && c.body.type) || ''}`);

const templateBody = (message) => (((message.template && message.template.components) || []).find((c) => c.type === 'body') || { parameters: [] }).parameters.map((p) => p.text);
const templateButtons = (message) => ((message.template && message.template.components) || []).filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);

module.exports = {
  ARABIC_LETTER, LATIN_LETTER, CHROME, cp, isMessagesCall, messagesOf, visible, stripText, arabicProblems, englishProblems, normalise, signature, templateBody, templateButtons,
};
