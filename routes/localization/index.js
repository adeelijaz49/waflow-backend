// All /api/localization/* routes, mounted once in server.js under requireAuth:
//   app.use('/api/localization', requireAuth, require('./routes/localization'));
// Everything except /settings (and the read-only language lookups the UI needs
// to render its locked state) requires the per-merchant arabic_enabled flag.
const router = require('express').Router();
const { requireArabicEnabled } = require('../../shared/localization/settings');

router.use('/settings', require('./settings'));

router.use('/customers', requireArabicEnabled, require('./customers'));
router.use('/templates', requireArabicEnabled, require('./templates'));
router.use('/campaigns', requireArabicEnabled, require('./campaigns'));
router.use('/ai', requireArabicEnabled, require('./ai'));
router.use('/catalog', requireArabicEnabled, require('./catalog'));
router.use('/inbox', requireArabicEnabled, require('./inbox'));
router.use('/ai-mode', requireArabicEnabled, require('./aiMode'));
router.use('/flows', requireArabicEnabled, require('./flows'));
router.use('/review', requireArabicEnabled, require('./review'));
// Legacy senders (shared/localization/legacySenders.js): language plan for the existing promotion / loyalty reminder /
// consent request screens, the Arabic promotion test send and the per-language send report.
const senderRoutes = require('./senders');
router.use('/senders', requireArabicEnabled, senderRoutes.senders);
router.use('/promotions', requireArabicEnabled, senderRoutes.promotions);

module.exports = router;
