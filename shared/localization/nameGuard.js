'use strict';
// One-word / missing-name guard (backlog B4), FLAGGED WORKSPACES ONLY.
//
// models/Customer.js requires a non-empty `lastname`. The three customer-creating
// first-contact paths (shared/inbox.js, shared/referrals.js, shared/instagram.js) set
// `lastname: rest.join(' ')`, which is '' for a one-word name ("Sara", "سارة") and for a
// WhatsApp contact without a profile name (firstname = the phone), so Customer.create
// throws and the customer is never created (no inbox thread, no referral attribution).
// shared/operations.js createCustomer has the same hole for the dashboard / MCP / GPT.
//
// oneWordLastname(workspaceId) returns:
//   ''  (exactly today's value, so the caller behaves exactly as before) unless the
//       workspace has Arabic switched on;
//   ' ' (ONE ASCII space) for a flagged workspace. A single space satisfies Mongoose's
//       `required` check, and every reader of the name trims, so the full name reads
//       "Sara" in the inbox / dashboard / {full_name} merge field. A '-' would show
//       "Sara -" inside Arabic WhatsApp text.
// It never throws (kill switch, a failed flag lookup and a missing workspace all give '').
// Call sites use it only as the right operand of `||`, so it runs ONLY when the name
// actually has no second word.
const { isArabicEnabled } = require('./settings');

const FALLBACK_LASTNAME = ' ';

async function oneWordLastname(workspaceId) {
  try {
    return workspaceId && (await isArabicEnabled(workspaceId)) ? FALLBACK_LASTNAME : '';
  } catch (err) {
    return '';
  }
}

module.exports = { FALLBACK_LASTNAME, oneWordLastname };
