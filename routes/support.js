const router = require('express').Router();
const SupportTicket = require('../models/SupportTicket');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const { sendSupportTicketEmail } = require('../utils/email');

router.post('/', async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    const contactEmail = String(req.body.contactEmail || '').trim().toLowerCase();
    if (!message) return res.status(400).json({ error: 'message is required' });
    if (!contactEmail) return res.status(400).json({ error: 'contactEmail is required' });

    const ticket = await SupportTicket.create({
      workspaceId: req.user.workspaceId, userId: req.user.id, message, contactEmail,
    });

    // The ticket record is the source of truth — kept even if the email fails
    // to send, matching routes/workspaces.js's invite-send resilience pattern.
    let sendWarning;
    try {
      const [workspace, user] = await Promise.all([
        Workspace.findById(req.user.workspaceId),
        User.findById(req.user.id),
      ]);
      await sendSupportTicketEmail({
        workspaceName: workspace?.name || 'Unknown workspace',
        userLabel: user?.name || user?.phone || user?.email || 'Unknown user',
        contactEmail, message,
      });
      ticket.emailSent = true;
      await ticket.save();
    } catch (err) {
      console.error('[support] ticket email send failed:', err.message);
      sendWarning = "We saved your request, but couldn't send the notification email — we'll still follow up.";
    }

    res.status(201).json({ success: true, sendWarning });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
