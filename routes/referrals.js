// Merchant-facing Referral Promotions API — mounted at /api/referrals under
// the existing requireAuth JWT middleware, same convention as every other
// dashboard route. All business logic lives in shared/referrals.js.
const router = require('express').Router();
const referrals = require('../shared/referrals');

router.get('/promotions', async (req, res) => {
  try {
    res.json(await referrals.listReferralPromotions({ workspaceId: req.user.workspaceId, status: req.query.status }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/promotions', async (req, res) => {
  try {
    const promo = await referrals.createReferralPromotion({ ...req.body, workspaceId: req.user.workspaceId, createdByUserId: req.user.id });
    res.status(201).json(promo);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/promotions/:id', async (req, res) => {
  try {
    res.json(await referrals.getReferralPromotion({ id: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Referral promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/promotions/:id', async (req, res) => {
  try {
    res.json(await referrals.updateReferralPromotion({ id: req.params.id, workspaceId: req.user.workspaceId, ...req.body }));
  } catch (err) {
    if (err.message === 'Referral promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/promotions/:id/status', async (req, res) => {
  try {
    res.json(await referrals.setReferralPromotionStatus({ id: req.params.id, workspaceId: req.user.workspaceId, status: req.body.status }));
  } catch (err) {
    if (err.message === 'Referral promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.get('/promotions/:id/report', async (req, res) => {
  try {
    res.json(await referrals.getReferralReport({ referralPromotionId: req.params.id, workspaceId: req.user.workspaceId }));
  } catch (err) {
    if (err.message === 'Referral promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/promotions/:id/generic-link', async (req, res) => {
  try {
    const code = await referrals.getOrCreateGenericCode({ referralPromotionId: req.params.id, workspaceId: req.user.workspaceId });
    res.json(code);
  } catch (err) {
    if (err.message === 'Referral promotion not found') return res.status(404).json({ error: 'Not found' });
    res.status(400).json({ error: err.message });
  }
});

router.post('/promotions/:id/customer-links', async (req, res) => {
  try {
    const codes = await referrals.generateCustomerCodes({ referralPromotionId: req.params.id, customerIds: req.body.customerIds || [], workspaceId: req.user.workspaceId });
    res.json(codes);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/promotions/:id/send', async (req, res) => {
  try {
    res.json(await referrals.sendReferralLinksToCustomers({ referralPromotionId: req.params.id, customerIds: req.body.customerIds || [], workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/codes/:codeId/qr', async (req, res) => {
  try {
    res.json({ qrCodeDataUrl: await referrals.getQrCodeDataUrl({ referralCodeId: req.params.codeId, workspaceId: req.user.workspaceId }) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/referrals/:id/void', async (req, res) => {
  try {
    res.json(await referrals.voidReferral({ id: req.params.id, workspaceId: req.user.workspaceId, reason: req.body.reason }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/pending-approvals', async (req, res) => {
  try {
    res.json(await referrals.listPendingRewardApprovals({ workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/referrals/:id/approve', async (req, res) => {
  try {
    res.json(await referrals.approveReferralReward({ referralId: req.params.id, workspaceId: req.user.workspaceId, approve: !!req.body.approve, userId: req.user.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/customers/:customerId/summary', async (req, res) => {
  try {
    res.json(await referrals.getCustomerReferralSummary({ customerId: req.params.customerId, workspaceId: req.user.workspaceId }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/vouchers/:id/redeem', async (req, res) => {
  try {
    res.json(await referrals.redeemVoucher({ id: req.params.id, workspaceId: req.user.workspaceId, userId: req.user.id }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
