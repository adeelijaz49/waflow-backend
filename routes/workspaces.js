const router = require('express').Router();
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Membership = require('../models/Membership');
const Invite = require('../models/Invite');
const { sendInviteTemplate } = require('../utils/whatsapp');
const { sendInviteEmail } = require('../utils/email');
const { FRONTEND_URL } = require('../utils/config');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the workspace Owner can do this' });
  next();
}

// ── Members ──────────────────────────────────────────────────────────────────

router.get('/me/members', async (req, res) => {
  try {
    const memberships = await Membership.find({ workspaceId: req.user.workspaceId }).sort({ createdAt: 1 });
    const users = await User.find({ _id: { $in: memberships.map(m => m.userId) } });
    const userById = Object.fromEntries(users.map(u => [u._id.toString(), u]));
    res.json(memberships.map(m => {
      const u = userById[m.userId.toString()];
      return { userId: m.userId, name: u?.name, phone: u?.phone, email: u?.email, role: m.role, joinedAt: m.createdAt };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/me/members/:userId', requireOwner, async (req, res) => {
  try {
    const target = await Membership.findOne({ workspaceId: req.user.workspaceId, userId: req.params.userId });
    if (!target) return res.status(404).json({ error: 'Not found' });

    if (target.role === 'owner') {
      const ownerCount = await Membership.countDocuments({ workspaceId: req.user.workspaceId, role: 'owner' });
      if (ownerCount <= 1) return res.status(400).json({ error: "Can't remove the only Owner — promote someone else first" });
    }

    await Membership.deleteOne({ _id: target._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invites ──────────────────────────────────────────────────────────────────

router.get('/me/invites', async (req, res) => {
  try {
    const invites = await Invite.find({ workspaceId: req.user.workspaceId, status: 'pending' }).sort({ createdAt: -1 });
    res.json(invites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/me/invites', requireOwner, async (req, res) => {
  try {
    const { contactType, role = 'member' } = req.body;
    if (!['phone', 'email'].includes(contactType)) return res.status(400).json({ error: 'contactType must be "phone" or "email"' });
    if (!['owner', 'member'].includes(role)) return res.status(400).json({ error: 'role must be "owner" or "member"' });

    const contact = contactType === 'phone' ? normalizePhone(req.body.contact) : normalizeEmail(req.body.contact);
    if (!contact) return res.status(400).json({ error: 'contact is required' });

    const existingUser = await User.findOne(contactType === 'phone' ? { phone: contact } : { email: contact });
    if (existingUser) {
      const existingMembership = await Membership.findOne({ userId: existingUser._id, workspaceId: req.user.workspaceId });
      if (existingMembership) return res.status(400).json({ error: 'This person is already a member of this workspace' });
    }

    const already = await Invite.findOne({ workspaceId: req.user.workspaceId, contact, status: 'pending' });
    if (already) return res.status(400).json({ error: 'There is already a pending invite for this contact' });

    const workspace = await Workspace.findById(req.user.workspaceId);
    const invite = await Invite.create({
      workspaceId: req.user.workspaceId, invitedByUserId: req.user.id, contactType, contact, role,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    });

    // The Invite record itself is the source of truth (matched by contact at
    // login time, not a link/token) — keep it even if the notification fails
    // to send, and just tell the Owner so they can reach the person another
    // way. The invited person can still just go log in directly either way.
    let sendWarning;
    try {
      if (contactType === 'phone') await sendInviteTemplate(contact, workspace.name);
      else await sendInviteEmail(contact, workspace.name, `${FRONTEND_URL}/login`);
    } catch (err) {
      console.error('[workspaces] invite send failed:', err.message);
      sendWarning = "Invite created, but we couldn't send the notification — let them know directly.";
    }

    res.status(201).json({ ...invite.toObject(), sendWarning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/me/invites/:id', requireOwner, async (req, res) => {
  try {
    const invite = await Invite.findOne({ _id: req.params.id, workspaceId: req.user.workspaceId });
    if (!invite) return res.status(404).json({ error: 'Not found' });
    await Invite.deleteOne({ _id: invite._id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Onboarding ───────────────────────────────────────────────────────────────
// Not Owner-gated — any authenticated member can be the one running through
// first-time setup, same as Products/Customers/Promotions creation.

router.patch('/me/onboarding', async (req, res) => {
  try {
    const update = {};
    if (typeof req.body.completed === 'boolean') update['onboarding.completed'] = req.body.completed;
    if (typeof req.body.currentStep === 'number') update['onboarding.currentStep'] = req.body.currentStep;

    const workspace = await Workspace.findByIdAndUpdate(req.user.workspaceId, { $set: update }, { new: true });
    if (!workspace) return res.status(404).json({ error: 'Not found' });
    res.json({ completed: workspace.onboarding?.completed !== false, currentStep: workspace.onboarding?.currentStep || 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
