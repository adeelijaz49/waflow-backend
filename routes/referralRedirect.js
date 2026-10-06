// Public, unauthenticated referral link redirects — /r/:code (customer-
// specific) and /c/:code (generic/social). A friend's browser hits one of
// these directly, so there's no JWT to check; the only "auth" here is the
// random code itself. Mounted at the app root in server.js, same pattern as
// routes/pay.js.
const router = require('express').Router();
const referrals = require('../shared/referrals');

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(title, message) {
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

async function handleRedirect(req, res) {
  try {
    const result = await referrals.recordClickAndGetRedirect({
      code: req.params.code,
      source: req.query.src || req.query.source,
      medium: req.query.medium || (req.path.startsWith('/c/') ? 'generic_link' : 'customer_link'),
      ip: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
    });
    if (!result || !result.waLink) {
      return res.status(404).send(errorPage('Link not found', 'This referral link is invalid, expired, or no longer active.'));
    }
    res.redirect(302, result.waLink);
  } catch (err) {
    console.error('[referralRedirect] error:', err.message);
    res.status(500).send(errorPage('Something went wrong', 'Please try again in a moment.'));
  }
}

router.get('/r/:code', handleRedirect);
router.get('/c/:code', handleRedirect);

module.exports = router;
