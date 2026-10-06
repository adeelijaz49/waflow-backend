// Public, unauthenticated Instagram-feature endpoints — a friend's browser
// hits /t/:code directly (click tracking + WhatsApp redirect, same pattern
// as routes/referralRedirect.js), and Meta redirects the merchant's own
// browser straight here after OAuth consent (no Bearer token available on
// that redirect). Mounted at the app root in server.js.
const router = require('express').Router();
const instagram = require('../shared/instagram');
const { FRONTEND_URL } = require('../utils/config');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function simplePage(title, message) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#f5f5f7; color:#111; padding:24px; box-sizing:border-box; }
  @media (prefers-color-scheme: dark) { body { background:#0d0d10; color:#eee; } }
  .card { max-width:420px; text-align:center; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#888; font-size:14px; }
</style></head><body>
<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
</body></html>`;
}

router.get('/t/:code', async (req, res) => {
  try {
    const result = await instagram.recordClickAndGetRedirect({
      code: req.params.code,
      source: req.query.src || req.query.source,
      medium: req.query.medium,
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
    if (!result || !result.waLink) return res.status(404).send(simplePage('Link not found', 'This link is invalid or no longer active.'));
    res.redirect(302, result.waLink);
  } catch (err) {
    console.error('[instagramRedirect] /t/:code error:', err.message);
    res.status(500).send(simplePage('Something went wrong', 'Please try again in a moment.'));
  }
});

// Meta redirects here after the merchant grants (or denies) Instagram
// permission — see shared/instagram.js#handleOAuthCallback for the actual
// token exchange. FRONTEND_URL (not APP_URL) since this should land the
// merchant back in the Angular app, not the API.
router.get('/auth/instagram/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res.redirect(`${FRONTEND_URL}/instagram-promotions?ig_error=${encodeURIComponent(error_description || error)}`);
  }
  try {
    await instagram.handleOAuthCallback({ code, state });
    res.redirect(`${FRONTEND_URL}/instagram-promotions?ig_connected=1`);
  } catch (err) {
    console.error('[instagramRedirect] oauth callback error:', err.message);
    res.redirect(`${FRONTEND_URL}/instagram-promotions?ig_error=${encodeURIComponent(err.message)}`);
  }
});

module.exports = router;
