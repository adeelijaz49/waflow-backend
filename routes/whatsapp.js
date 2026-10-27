const router       = require('express').Router();
const tokenManager = require('../utils/tokenManager');
const wa           = require('../utils/whatsapp');
const waTenant     = require('../utils/waTenant');
const senderContext = require('../utils/senderContext');

// ── Who may do what ─────────────────────────────────────────────────────────────
// These routes act on a WhatsApp Business Account's templates and token. On the shared PLATFORM number that is WaFlow's own
// account (every customer's templates live in it, including waflow_login_otp), so once super admins are configured
// (SUPER_ADMIN_CONTACTS, see shared/platformAdmin.js) the mutating routes are for them only - or for the OWNER of a customer
// that has its OWN number in its OWN WhatsApp account. With no super admins configured the people of the OLDEST workspace (the
// account that owned the platform before customers were onboarded, the one the webhook falls back to) keep exactly what they had,
// so the Settings page keeps working until the env is set - and nobody in a customer's workspace gets platform rights by default.

// The decision itself lives in shared/platformStaff.js (GET /api/auth/me reports the same answer to the Settings page). The User row is
// re-read on every call: the JWT claim alone is not trusted.
async function isStaff(req) {
  if (!req.user || req.user.actAs) return false;
  let user = null;
  try {
    const User = require('../models/User');
    user = await User.findById(req.user.id).select('phone email').lean();
  } catch (_) { user = null; }
  return require('../shared/platformStaff').isPlatformStaff({ user, actAs: !!req.user.actAs, workspaceId: req.user.workspaceId });
}

function sendError(res, err) {
  if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') return res.status(409).json({ error: err.message, code: err.code });
  return res.status(500).json({ error: err.response?.data ?? err.message });
}

// Everything below runs for the logged-in customer's number. requireAuth already sets this context for every /api route;
// repeating it here keeps this router correct on its own.
router.use((req, res, next) => (
  req.user && req.user.workspaceId ? senderContext.run(req.user.workspaceId, next) : next()
));

async function requireTemplateAdmin(req, res, next) {
  try {
    if (await isStaff(req)) return next();
    const sender = await waTenant.resolveCurrent({ waba: false });
    // Owner of a customer with its OWN number in its OWN WABA. A number added inside the platform WABA is still the platform's
    // account: its owner gets no template rights there.
    if (require('../shared/platformStaff').ownsItsWhatsAppAccount(sender, req.user && req.user.role)) return next();
    return res.status(403).json({ error: 'Only WaFlow staff can change WhatsApp templates for this number.' });
  } catch (err) {
    return sendError(res, err);
  }
}

// ── Token ─────────────────────────────────────────────────────────────────────

// Reports the token of the number the logged-in customer sends from: the platform token for everyone on the shared number
// (exactly the legacy answer), or the saved status of the customer's own token. Never returns a token.
router.get('/token-status', async (req, res) => {
  try {
    const sender = await waTenant.resolveCurrent({ waba: false });
    if (sender.source === 'tenant' && sender.ownToken) {
      const Workspace = require('../models/Workspace');
      const ws = await Workspace.findById(sender.workspaceId).select('whatsapp.tokenIsValid whatsapp.tokenCheckedAt').lean();
      const w = (ws && ws.whatsapp) || {};
      return res.json({
        source: 'tenant',
        isValid: typeof w.tokenIsValid === 'boolean' ? w.tokenIsValid : null,
        neverExpires: null,
        expiresAt: null,
        daysLeft: null,
        checkedAt: w.tokenCheckedAt ? new Date(w.tokenCheckedAt).toISOString() : null,
        hasAppCredentials: false,
      });
    }
    return res.json(tokenManager.getStatus());
  } catch (err) {
    if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE' && err.reason !== 'lookup_failed') {
      return res.json({ source: 'tenant', isValid: false, neverExpires: false, expiresAt: null, daysLeft: null, checkedAt: null, hasAppCredentials: false, error: err.code });
    }
    return res.json(tokenManager.getStatus());
  }
});

router.post('/refresh-token', requireTemplateAdmin, async (req, res) => {
  try {
    const sender = await waTenant.resolveCurrent({ waba: false });
    if (sender.source === 'tenant' && sender.ownToken) {
      // tokenManager refreshes the PLATFORM token only; a customer's own token is entered and checked by WaFlow staff.
      return res.status(400).json({ error: 'This number uses its own access token, which WaFlow staff manage. Ask your WaFlow administrator to update it.' });
    }
    const status = await tokenManager.refresh();
    res.json({ success: true, status });
  } catch (err) {
    if (err && err.code === 'WHATSAPP_NUMBER_UNAVAILABLE') return sendError(res, err);
    res.status(400).json({ error: err.message });
  }
});

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    let templates = await wa.listTemplates();

    // Not a super admin, on WaFlow's own WABA: that account holds every customer's templates, so show only the ones this
    // workspace's own message nodes use.
    if (!(await isStaff(req))) {
      const sender = await waTenant.resolveCurrent({ waba: false });
      if (sender.sharesPlatformWaba) {
        const MessageNode = require('../models/MessageNode');
        const own = new Set((await MessageNode.find({ workspaceId: req.user.workspaceId, templateName: { $exists: true, $nin: [null, ''] } }).select('templateName').lean())
          .map(n => n.templateName));
        templates = templates.filter(t => own.has(t.name));
      }
    }

    // Annotate which ones Waflow uses
    const roleByName = {
      [wa.PROMO_TEMPLATE]: 'promo',
      [wa.LOYALTY_TEMPLATE]: 'loyalty',
      [wa.WINBACK_TEMPLATE]: 'winback',
      [wa.POST_PURCHASE_TEMPLATE]: 'post_purchase',
      [wa.POINTS_NUDGE_TEMPLATE]: 'points_nudge',
      [wa.NO_SHOW_TEMPLATE]: 'no_show',
    };
    const annotated = templates.map(t => ({ ...t, waflowRole: roleByName[t.name] || null }));
    res.json({
      templates: annotated,
      promoTemplate: wa.PROMO_TEMPLATE,
      loyaltyTemplate: wa.LOYALTY_TEMPLATE,
      winbackTemplate: wa.WINBACK_TEMPLATE,
      postPurchaseTemplate: wa.POST_PURCHASE_TEMPLATE,
      pointsNudgeTemplate: wa.POINTS_NUDGE_TEMPLATE,
      noShowTemplate: wa.NO_SHOW_TEMPLATE,
    });
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-promo-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createPromoTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-loyalty-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createLoyaltyTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-winback-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createWinbackTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-post-purchase-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createPostPurchaseTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-points-nudge-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createPointsNudgeTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/create-no-show-template', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.createNoShowTemplate();
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

// Delete a template by name (needed to recreate with updated structure)
router.delete('/templates/:name', requireTemplateAdmin, async (req, res) => {
  try {
    const result = await wa.deleteTemplate(req.params.name);
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

module.exports = router;
