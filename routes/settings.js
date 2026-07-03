const router   = require('express').Router();
const Settings = require('../models/Settings');

router.get('/loyalty', async (req, res) => {
  try {
    let s = await Settings.findOne();
    if (!s) s = await Settings.create({});
    res.json(s);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/loyalty', async (req, res) => {
  try {
    const { loyaltyPointsPerUnit, minPointsPerPurchase, currency } = req.body;
    let s = await Settings.findOne();
    if (!s) s = new Settings();
    if (loyaltyPointsPerUnit != null) s.loyaltyPointsPerUnit = +loyaltyPointsPerUnit;
    if (minPointsPerPurchase != null) s.minPointsPerPurchase = +minPointsPerPurchase;
    if (currency) s.currency = currency;
    await s.save();
    res.json(s);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
