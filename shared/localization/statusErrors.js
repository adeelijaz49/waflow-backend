'use strict';
// C3 (backlog C3; design D3 section 7; approved GLOBAL change #3): reader for the Meta error code that
// server.js#handleStatusCallbacks now stores on a FAILED delivery callback (CampaignMessage.errorCode, a String, additive:
// absent on every older row). The existing statusReason line is untouched.
//
//   getMessageErrors(workspaceId, wamids) -> Map(wamid -> { status, errorCode, statusReason })
//       workspace-scoped, one `wamid $in` query per chunk (uses the unique wamid index), never throws.
//   describeMetaError(code) -> { group, retryable }
//       only the codes already named elsewhere in this repo (campaignSender.js, promotionCarousel.js); not extended
//       without checking Meta's documentation.
const CampaignMessage = require('../../models/CampaignMessage');

const CHUNK = 1000;
const TEMPLATE_CODES = new Set(['132000', '132001', '132012', '132015', '132016', '132018']); // same set as campaignSender.TEMPLATE_ERROR_CODES

function describeMetaError(code) {
  const c = code === undefined || code === null ? '' : String(code).trim();
  if (!c) return { group: 'none', retryable: false };
  if (TEMPLATE_CODES.has(c)) return { group: 'template', retryable: false }; // the template is wrong: retrying cannot help
  if (c === '131049') return { group: 'marketing_limit', retryable: true };   // Meta's per-user marketing cap: try again later
  if (c === '131047') return { group: 'window', retryable: false };           // 24-hour window closed: needs a template
  return { group: 'other', retryable: false };
}

async function getMessageErrors(workspaceId, wamids) {
  const out = new Map();
  try {
    if (!workspaceId || !Array.isArray(wamids)) return out;
    const ids = Array.from(new Set(wamids.filter((w) => typeof w === 'string' && w)));
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = await CampaignMessage.find({ workspaceId, wamid: { $in: ids.slice(i, i + CHUNK) } }).select('wamid status errorCode statusReason').lean();
      for (const r of rows) out.set(r.wamid, { status: r.status || null, errorCode: r.errorCode || null, statusReason: r.statusReason || null });
    }
  } catch (err) {
    console.error('[localization] statusErrors lookup failed (ignored):', err && err.message);
  }
  return out;
}

module.exports = { getMessageErrors, describeMetaError, TEMPLATE_CODES };
