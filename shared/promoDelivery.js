'use strict';
// What WhatsApp actually did with a promotion send, and why when it refused.
//
//   metaErrorInfo(err)          Meta's own words for a rejected API call (HTTP 4xx with a body {error:{code,message,...}}),
//                               instead of axios's bare "Request failed with status code 400".
//   describeFailure(row)        a plain-language label for a failed CampaignMessage (by Meta error code).
//   getPromotionDelivery(args)  per-promotion summary read from CampaignMessage rows (written at send time, updated by the
//                               webhook's status callbacks): accepted / delivered / read / waiting / rejected + reasons.
//
// "HTTP 200 + message id" from Meta only means the request was ACCEPTED. Delivery (or a rejection such as 131047, outside the
// 24-hour window) is reported afterwards through the status webhook (server.js#handleStatusCallbacks), so that is what the
// dashboard has to show.
//
// metaErrorInfo honours the PROMO_DELIVERY_FIX=off kill switch (see shared/promoWindow.js): off = the plain err.message as before.
const CampaignMessage = require('../models/CampaignMessage');
const Promotion = require('../models/Promotion');
const { enabled } = require('./promoWindow');

function metaErrorInfo(err) {
  const plain = { message: err ? err.message : undefined };
  if (!enabled()) return plain;
  const e = err && err.response && err.response.data && err.response.data.error;
  if (!e || typeof e !== 'object') return plain;
  const base = typeof e.message === 'string' && e.message ? e.message : plain.message;
  const details = e.error_data && typeof e.error_data.details === 'string' ? e.error_data.details : '';
  const message = (details && base && !String(base).includes(details) ? `${base} - ${details}` : base);
  return {
    message: typeof message === 'string' ? message.slice(0, 400) : plain.message,
    code: e.code != null ? String(e.code).slice(0, 20) : undefined,
    meta: true, // this text/code came from Meta's own error body (callers only replace their own wording for these)
  };
}

// Meaning of the Meta error codes this app meets when sending (Meta's WhatsApp Cloud API error-code reference).
const LABELS = {
  '131047': { group: 'window', label: '24-hour window closed: this customer has not messaged your WhatsApp number in the last 24 hours, so only an approved template can reach them.' },
  '131049': { group: 'marketing_limit', label: 'WhatsApp chose not to deliver this marketing message (Meta does not say why; it keeps the customer experience healthy). It may deliver if you try again later.' },
  '131026': { group: 'undeliverable', label: 'WhatsApp could not deliver this message (the number may not be on WhatsApp, the customer may not have accepted its latest terms, or may use an old WhatsApp version).' },
  '131030': { group: 'allow_list', label: "This number is not on your test number's allowed-recipient list (Meta App Dashboard > WhatsApp > API Setup)." },
  '131042': { group: 'payment', label: 'WhatsApp could not charge for this message: check the payment method on your WhatsApp Business Account.' },
  '131053': { group: 'media', label: 'WhatsApp could not upload the media used in this message (check the image format and size).' },
  '132001': { group: 'template', label: 'The message template does not exist, or is not approved, in this language.' },
  '132015': { group: 'template', label: 'The message template is paused by WhatsApp.' },
  '132016': { group: 'template', label: 'The message template was permanently disabled by WhatsApp.' },
  '133010': { group: 'not_registered', label: "Your sending WhatsApp number is not registered with the WhatsApp Business Platform (check its status in Meta)." },
};

function describeFailure({ errorCode, statusReason } = {}) {
  const code = errorCode ? String(errorCode) : '';
  const reason = String(statusReason || '').trim();
  if (LABELS[code]) return { code, ...LABELS[code] };
  // rows written before errorCode was captured carry only Meta's title
  if (!code && /re-?engagement/i.test(reason)) return { code: '131047', ...LABELS['131047'] };
  if (!reason || /^Request failed with status code \d+$/.test(reason) || reason === 'Send failed') {
    return { code, group: 'other', label: `WhatsApp refused the message${code ? ` (code ${code})` : ''}; the reason was not recorded for this send.` };
  }
  return { code, group: 'other', label: `Refused by WhatsApp${code ? ` (code ${code})` : ''}: ${reason}` };
}

// Summary of the CampaignMessage rows of one promotion, optionally only the rows created at/after `since` (one send).
//   accepted             WhatsApp accepted the request (has a message id)
//   delivered / read     confirmed by the status webhook (read counts as delivered)
//   waiting              accepted, no delivery or failure report yet
//   failed               refused: rejectedImmediately (the API call itself failed) + failedAfterAccepted (rejected by webhook)
//   viaTemplate          accepted by WhatsApp as an approved template (works outside the 24-hour window)
//   failures[]           one entry per distinct reason: { code, group, label, count }
async function getPromotionDelivery({ promotionId, workspaceId, since } = {}) {
  const filter = { _id: promotionId };
  if (workspaceId) filter.workspaceId = workspaceId;
  const promotion = await Promotion.findOne(filter).select('_id').lean();
  if (!promotion) throw new Error('Promotion not found');

  const match = { promotion: promotion._id, kind: 'promotion' };
  if (since instanceof Date && !isNaN(since)) match.createdAt = { $gte: since };
  const groups = await CampaignMessage.aggregate([
    { $match: match },
    { $group: {
      _id: {
        status: '$status', messageType: '$messageType', errorCode: '$errorCode', statusReason: '$statusReason',
        accepted: { $cond: [{ $gt: ['$wamid', null] }, true, false] },
      },
      count: { $sum: 1 },
    } },
  ]);

  const out = {
    promotionId: String(promotion._id), since: match.createdAt ? match.createdAt.$gte.toISOString() : null,
    total: 0, accepted: 0, delivered: 0, read: 0, waiting: 0, failed: 0, rejectedImmediately: 0, failedAfterAccepted: 0,
    viaTemplate: 0, failures: [],
  };
  const byReason = new Map();
  for (const g of groups) {
    const { status, messageType, errorCode, statusReason, accepted } = g._id;
    const n = g.count;
    out.total += n;
    if (accepted) out.accepted += n;
    if (messageType === 'template' && accepted) out.viaTemplate += n;
    if (status === 'read') { out.read += n; out.delivered += n; }
    else if (status === 'delivered') out.delivered += n;
    else if (status === 'failed') {
      out.failed += n;
      if (accepted) out.failedAfterAccepted += n; else out.rejectedImmediately += n;
      const d = describeFailure({ errorCode, statusReason });
      const key = `${d.code}|${d.label}`;
      const prev = byReason.get(key);
      if (prev) prev.count += n; else byReason.set(key, { code: d.code, group: d.group, label: d.label, count: n });
    } else out.waiting += n; // sent / queued
  }
  out.failures = [...byReason.values()].sort((a, b) => b.count - a.count);
  return out;
}

module.exports = { metaErrorInfo, describeFailure, getPromotionDelivery };
