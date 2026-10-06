// Merchant-facing Instagram account connection API — mounted at
// /api/social-accounts under requireAuth. The actual OAuth callback is
// public (Meta redirects the merchant's bare browser, no Bearer token) and
// lives in routes/instagramRedirect.js instead.
const router = require('express').Router();
const instagram = require('../shared/instagram');

router.get('/instagram/status', async (req, res) => {
  try {
    res.json(await instagram.getSocialAccountStatus(req.user.workspaceId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instagram/connect-url', async (req, res) => {
  try {
    res.json({ url: instagram.getAuthorizeUrl(req.user.workspaceId) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/instagram/disconnect', async (req, res) => {
  try {
    res.json(await instagram.disconnectAccount(req.user.workspaceId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
