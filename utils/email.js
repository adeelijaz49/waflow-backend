const { Resend } = require('resend');

const FROM = process.env.RESEND_FROM_EMAIL || 'Waflow <login@waflow.app>';

// Lazy — Resend's constructor throws synchronously if the key is missing,
// which would otherwise crash the whole server at require-time before
// RESEND_API_KEY is ever configured. Fail only when an email is actually sent.
let _resend = null;
function resend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) console.warn('[email] RESEND_API_KEY not set — magic-link/invite emails will fail until configured.');
    _resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');
  }
  return _resend;
}

async function sendMagicLinkEmail(to, link) {
  return resend().emails.send({
    from: FROM,
    to,
    subject: 'Your Waflow login link',
    html: `<p>Click below to log in to Waflow. This link expires in 15 minutes and can only be used once.</p>
<p><a href="${link}">${link}</a></p>
<p>If you didn't request this, you can ignore this email.</p>`,
  });
}

async function sendInviteEmail(to, workspaceName, link) {
  return resend().emails.send({
    from: FROM,
    to,
    subject: `You've been invited to join ${workspaceName} on Waflow`,
    html: `<p>You've been invited to join <strong>${workspaceName}</strong> on Waflow.</p>
<p><a href="${link}">Log in with this email address</a> to get started — no password needed.</p>`,
  });
}

module.exports = { sendMagicLinkEmail, sendInviteEmail };
