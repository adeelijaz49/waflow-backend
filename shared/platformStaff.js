'use strict';
// Who may manage a WhatsApp account's token and message templates (routes/whatsapp.js enforces it; GET /api/auth/me reports it so the
// Settings page shows those cards to exactly the people the server will let use them).
//
//   * the PLATFORM's own account (every customer on the shared number lives in it, and so does the login-code template) belongs to
//     WaFlow staff:
//       - super admins are configured (SUPER_ADMIN_CONTACTS): a super admin - but never while "inside" a customer (act-as), where
//         they work as that customer's owner;
//       - none configured (the setup before customers were onboarded): the people of the OLDEST workspace, the account that owned the
//         platform and the one the webhook falls back to. Nobody in a customer's workspace gets platform rights by default.
//   * a customer that has its OWN number inside its OWN WhatsApp account: that customer's owner (also a super admin acting as it).
//     A number added inside the platform's account is still the platform's: its owner gets no rights there.
const platformAdmin = require('./platformAdmin');

/** Is this the oldest workspace (the platform default)? false when it cannot be told. Never throws. */
async function isOldestWorkspace(workspaceId) {
  if (!workspaceId) return false;
  try {
    const Workspace = require('../models/Workspace');
    const oldest = await Workspace.findOne().sort({ createdAt: 1 }).select('_id').lean();
    return !!oldest && String(oldest._id) === String(workspaceId);
  } catch (_) {
    return false;
  }
}

/**
 * Platform staff: see above.
 * @param {{ user?: { phone?: string, email?: string } | null, actAs?: boolean, workspaceId?: any }} args
 *   user = the signed-in User (phone / email), read fresh from the database by the caller
 * @returns {Promise<boolean>}
 */
async function isPlatformStaff({ user, actAs = false, workspaceId } = {}) {
  if (actAs) return false;
  let configured = false;
  try { configured = platformAdmin.isConfigured(); } catch (_) { configured = false; }
  if (configured) {
    try { return !!user && !!platformAdmin.isSuperAdminUser(user); } catch (_) { return false; }
  }
  return isOldestWorkspace(workspaceId);
}

/** The owner of a customer whose WhatsApp number sits in the customer's OWN account (`sender` = waTenant.resolveCurrent({ waba: false })). */
function ownsItsWhatsAppAccount(sender, role) {
  return !!sender && sender.source === 'tenant' && !sender.sharesPlatformWaba && role === 'owner';
}

/**
 * May this session manage the token and templates of the WhatsApp account its workspace sends from? Never throws: a number that
 * cannot be used right now is simply "no". (The route itself lets that error through, to answer 409 with its plain message.)
 * Must run inside the workspace's sender context (requireAuth sets it for every /api request).
 * @param {{ user?: object | null, actAs?: boolean, workspaceId?: any, role?: string }} args
 */
async function canManageWhatsApp({ user, actAs = false, workspaceId, role } = {}) {
  if (await isPlatformStaff({ user, actAs, workspaceId })) return true;
  if (role !== 'owner') return false;
  try {
    const sender = await require('../utils/waTenant').resolveCurrent({ waba: false });
    return ownsItsWhatsAppAccount(sender, role);
  } catch (_) {
    return false;
  }
}

module.exports = { isPlatformStaff, isOldestWorkspace, ownsItsWhatsAppAccount, canManageWhatsApp };
