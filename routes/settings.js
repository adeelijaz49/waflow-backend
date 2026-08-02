const router = require('express').Router();
const ops    = require('../shared/operations');

router.get('/loyalty', async (req, res) => {
  try {
    const s = await ops.getLoyaltySettings({ workspaceId: req.user.workspaceId });
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/loyalty', async (req, res) => {
  try {
    const { loyaltyPointsPerUnit, minPointsPerPurchase, currency, flowCooldownDays, merchantName } = req.body;
    const s = await ops.updateLoyaltySettings(
      { loyaltyPointsPerUnit, minPointsPerPurchase, currency, flowCooldownDays, merchantName },
      { workspaceId: req.user.workspaceId }
    );
    res.json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
