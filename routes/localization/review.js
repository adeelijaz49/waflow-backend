'use strict';
// /api/localization/review: native-review progress for the signed-in
// workspace (spec section 8). Read-only; mounted behind requireArabicEnabled.
const router = require('express').Router();
const overview = require('../../shared/localization/overview');
const { handler } = require('../../shared/localization/scope');

router.get('/summary', handler(async (req, res) => {
  res.json(await overview.reviewSummary(req.user.workspaceId));
}));

module.exports = router;
