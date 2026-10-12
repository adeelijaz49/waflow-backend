// /api/localization/settings — merchant default customer language, bilingual
// order, the arabic_enabled flag (read-only here) and the signed-in user's own
// language preferences. This file doubles as the reference for how every
// localisation route is written:
//   * mounted under requireAuth, so req.user = { id, workspaceId, role }
//   * workspaceId comes ONLY from req.user, never from the body
//   * explicit field allow-lists (pick / assertEnum) — never spread req.body
//   * handler() turns thrown { status } errors into JSON, never leaks stacks
const router = require('express').Router();
const UserLocalePreference = require('../../models/UserLocalePreference');
const settings = require('../../shared/localization/settings');
const overview = require('../../shared/localization/overview');
const { handler, pick, assertEnum } = require('../../shared/localization/scope');

router.get('/', handler(async (req, res) => {
  res.json(await settings.getSettings(req.user.workspaceId));
}));

router.put('/', handler(async (req, res) => {
  const patch = pick(req.body, ['defaultCustomerLanguage', 'bilingualOrder']);
  res.json(await settings.updateMerchantSettings(req.user.workspaceId, patch));
}));

// Hub counters (customers by language, Arabic template status, review backlog). Works with the flag off.
router.get('/overview', handler(async (req, res) => {
  res.json(await overview.overview(req.user.workspaceId));
}));

// The signed-in user's own language preferences (platform user language + AI reply language).
router.get('/me', handler(async (req, res) => {
  const doc = await UserLocalePreference.findOne({ workspaceId: req.user.workspaceId, userId: req.user.id }).lean();
  res.json({ uiLanguage: (doc && doc.uiLanguage) || 'en', aiLanguage: (doc && doc.aiLanguage) || 'auto' });
}));

router.put('/me', handler(async (req, res) => {
  const set = {};
  if (req.body && req.body.uiLanguage !== undefined) set.uiLanguage = assertEnum(req.body.uiLanguage, ['en', 'ar'], 'uiLanguage');
  if (req.body && req.body.aiLanguage !== undefined) set.aiLanguage = assertEnum(req.body.aiLanguage, ['auto', 'en', 'ar'], 'aiLanguage');
  const doc = await UserLocalePreference.findOneAndUpdate(
    { workspaceId: req.user.workspaceId, userId: req.user.id },
    { $set: set, $setOnInsert: { workspaceId: req.user.workspaceId, userId: req.user.id } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  ).lean();
  res.json({ uiLanguage: doc.uiLanguage, aiLanguage: doc.aiLanguage });
}));

module.exports = router;
