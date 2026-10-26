'use strict';
// "Has this customer written to the business number in the last 24 hours?"
//
// WhatsApp only delivers a free-form (interactive) message inside that window. Meta does not refuse an out-of-window
// interactive message when it is posted: it answers HTTP 200 with a message id and rejects it about a second later
// through the status webhook (error 131047, "Re-engagement message"). A sender that only reacts to a thrown error therefore
// reports "sent" for a message that can never arrive and never reaches its template fallback. shared/operations.js
// uses this answer to send the approved template to customers outside the window instead.
//
// The answer comes from the stored inbound messages (WhatsAppMessage, direction 'inbound'), matched on the phone number
// (digits only) and scoped to the promotion's workspace.
//
// KILL SWITCH: PROMO_DELIVERY_FIX=off turns this module (no lookup) AND the error-text change in shared/promoDelivery.js
// off, so sendPromotion / sendTestMessage behave exactly as they did before this fix. Default: on.
const WhatsAppMessage = require('../models/WhatsAppMessage');

const WINDOW_MS = 24 * 60 * 60 * 1000;
// The last hour of the window counts as closed: the two clocks differ a little and a send takes a moment to arrive.
const SAFETY_MS = 60 * 60 * 1000;
const CHUNK = 500;

function enabled() {
  return !/^(off|0|false|no)$/i.test(String(process.env.PROMO_DELIVERY_FIX || '').trim());
}

// WhatsApp's `from` is digits only, with the country code. Customer.phone is stored as typed ("+61 4.." / "0061 4.." /
// "61 4.."), so compare on digits, a leading 00 international prefix dropped. A local-format number ("04..") never matches
// and is treated as outside the window - the safe side, because the template reaches the customer either way.
function phoneKey(phone) {
  return String(phone == null ? '' : phone).replace(/\D/g, '').replace(/^00/, '');
}

// Resolves to the Set of phoneKeys that wrote to the business inside the window, or null when no answer is available
// (switch off, or the lookup failed) - callers then keep the previous behaviour.
async function insideWindow({ phones, workspaceId, now = Date.now() }) {
  if (!enabled()) return null;
  try {
    const keys = [...new Set((phones || []).map(phoneKey).filter(Boolean))];
    const inside = new Set();
    if (!keys.length) return inside;
    const cutoff = new Date(now - WINDOW_MS + SAFETY_MS);
    for (let i = 0; i < keys.length; i += CHUNK) {
      const filter = {
        direction: 'inbound',
        phone: { $in: keys.slice(i, i + CHUNK) },
        // receivedAt is the time the webhook stored the message; createdAt covers any row that lacks it.
        $or: [{ receivedAt: { $gte: cutoff } }, { receivedAt: null, createdAt: { $gte: cutoff } }],
      };
      if (workspaceId) filter.workspaceId = workspaceId;
      const phonesInside = await WhatsAppMessage.distinct('phone', filter);
      for (const p of phonesInside) inside.add(phoneKey(p));
    }
    return inside;
  } catch (err) {
    console.error('[promoWindow] inbound lookup failed, sending as before:', err && err.message);
    return null;
  }
}

module.exports = { enabled, phoneKey, insideWindow, WINDOW_MS, SAFETY_MS };
