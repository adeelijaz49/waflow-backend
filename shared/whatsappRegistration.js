'use strict';
// Is a WhatsApp business phone number ready to send? Meta's own word for it is the `status` field of the phone-number node.
// Meta documents that "Business phone numbers must have a status of connected in order to send and receive messages via the API".
// We read PENDING and UNVERIFIED as "not connected" (Meta does not define PENDING for a phone number). Error 133010 ("Account not
// registered") was observed with a PENDING number on 2026-10-25 and 2026-10-30, so we say WhatsApp is likely to refuse, not that it
// always does. Pure: no I/O, no requires.

// Meta's word as plain upper-case text, or null when Meta did not say (or said something that is not text).
function cleanStatus(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  return text || null;
}

// registrationOf({ status }) -> { status, registered }
//   registered: CONNECTED -> true; PENDING or UNVERIFIED -> false; anything else, or unknown -> null.
// We only claim what we know: FLAGGED / RESTRICTED are about quality and sending limits, and DISCONNECTED / OFFLINE / MIGRATED /
// DELETED / BANNED are other problems with other symptoms, so none of those says "not registered".
function registrationOf(input) {
  const status = cleanStatus(input && input.status);
  let registered = null;
  if (status === 'CONNECTED') registered = true;
  else if (status === 'PENDING' || status === 'UNVERIFIED') registered = false;
  return { status, registered };
}

// The sentence shown for a number that is not ready to send (registered === false). It does not tell anyone to "finish
// registering": a Meta test number has no registration step to finish.
function registrationMessage(status) {
  const word = cleanStatus(status);
  const shows = word ? `Meta shows this number's status as ${word}, not CONNECTED` : 'Meta does not show this number as CONNECTED';
  return `${shows}, so it is not ready to send: WhatsApp is likely to refuse its messages with error 133010 (Account not registered). Check its status in Meta, then check again.`;
}

module.exports = { registrationOf, registrationMessage };
