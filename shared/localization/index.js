'use strict';
// Entry point of the Arabic localisation feature as seen by server.js.
// server.js touches this feature in exactly three places (all additive):
//   1. require('./shared/localization')            -> this file
//   2. app.use('/api/localization', requireAuth, require('./routes/localization')) (+ admin + customer-page mounts)
//   3. one call in the WhatsApp webhook, right after the Inbox hook:
//        if (await localization.handleInbound({ workspaceId, from, message, contactName })) return;
//
// handleInbound is the only function the existing webhook runs. It must NEVER
// throw and must return false (meaning: carry on with the existing flow) for
// anything it does not fully handle — see shared/localization/inboundHook.js.
let hook = null;

async function handleInbound(args) {
  try {
    if (!hook) hook = require('./inboundHook');
    return await hook.handleInbound(args);
  } catch (err) {
    console.error('[localization] handleInbound failed (ignored, existing flow continues):', err && err.message);
    return false;
  }
}

module.exports = { handleInbound };
