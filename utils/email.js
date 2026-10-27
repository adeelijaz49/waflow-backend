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

// Resend's SDK does NOT throw on an API-level failure (bad key, unverified
// domain, etc.) — send() resolves with { data: null, error: {...} } instead.
// Silently "succeeding" here is exactly how the magic-link route reported
// success to the merchant while never actually sending anything - always
// unwrap and throw on `error` so callers' try/catch actually catches it.
async function send(payload) {
  const { data, error } = await resend().emails.send(payload);
  if (error) throw new Error(`Resend: ${error.message || error.name || JSON.stringify(error)}`);
  return data;
}

// Anything a person typed (a customer's name, a support message, a contact address) is text, never markup: it is escaped before it
// goes into the HTML of a message that other people open, and stripped of line breaks before it goes into a subject line.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function oneLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n\u{2028}\u{2029}]+/gu, ' ').trim();
}

async function sendMagicLinkEmail(to, link) {
  return send({
    from: FROM,
    to,
    subject: 'Your Waflow login link',
    html: `<p>Click below to log in to Waflow. This link expires in 15 minutes and can only be used once.</p>
<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>
<p>If you didn't request this, you can ignore this email.</p>`,
  });
}

async function sendInviteEmail(to, workspaceName, link) {
  return send({
    from: FROM,
    to,
    subject: `You've been invited to join ${oneLine(workspaceName)} on Waflow`,
    html: `<p>You've been invited to join <strong>${escapeHtml(workspaceName)}</strong> on Waflow.</p>
<p><a href="${escapeHtml(link)}">Log in with this email address</a> to get started — no password needed.</p>`,
  });
}

const SUPPORT_DESK_EMAIL = process.env.SUPPORT_DESK_EMAIL || 'support@waflow.app';

async function sendSupportTicketEmail({ workspaceName, userLabel, contactEmail, message }) {
  return send({
    from: FROM,
    to: SUPPORT_DESK_EMAIL,
    replyTo: contactEmail,
    subject: `Support request from ${oneLine(workspaceName)}`,
    html: `<p><strong>Workspace:</strong> ${escapeHtml(workspaceName)}</p>
<p><strong>From:</strong> ${escapeHtml(userLabel)}</p>
<p><strong>Contact email:</strong> ${escapeHtml(contactEmail)}</p>
<p><strong>Message:</strong></p>
<p>${escapeHtml(message).replace(/\r?\n/g, '<br>')}</p>`,
  });
}

module.exports = { sendMagicLinkEmail, sendInviteEmail, sendSupportTicketEmail, escapeHtml };
