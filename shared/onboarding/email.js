'use strict';
// E-mail delivery of the onboarding notifications (DB design 7.1, INTERFACES 0.6 / 2.16).
// Its own lazy Resend client (RESEND_API_KEY, RESEND_FROM_EMAIL) and its own send() that THROWS on
// an API-level error (the pattern of utils/email.js: the Resend SDK resolves { data:null, error }
// instead of throwing, so the error is unwrapped here). utils/email.js is NOT touched.
// Everything external is injectable (deps.send / deps.resend / models) and nothing runs at require
// time. Never logs or returns an e-mail body, token or phone number.
const config = require('./config');
const emailCopy = require('./emailCopy');

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;
const DEFAULT_FROM = 'Waflow <login@waflow.app>';

let resendSingleton = null;

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/** The Resend client: injected (deps.resend) or created lazily from RESEND_API_KEY. */
function resendClient(deps) {
  if (deps && deps.resend) return deps.resend;
  if (!process.env.RESEND_API_KEY) {
    const err = new Error('RESEND_API_KEY is not configured');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  if (!resendSingleton) {
    const { Resend } = require('resend');
    resendSingleton = new Resend(process.env.RESEND_API_KEY);
  }
  return resendSingleton;
}

/** True when an e-mail can be attempted (an injected send/resend, or RESEND_API_KEY). */
function isConfigured(deps) {
  return !!((deps && (deps.send || deps.resend)) || process.env.RESEND_API_KEY);
}

/**
 * Send one message through Resend. THROWS on an API error (code EMAIL_SEND_FAILED) or when the
 * client is not configured (code EMAIL_NOT_CONFIGURED).
 * @param {{to:string, subject:string, html:string, text?:string, replyTo?:string, from?:string}} message
 * @param {{resend?:object}} [deps]
 * @returns {Promise<{id:string|null}>}
 */
async function send(message, deps) {
  const m = message || {};
  const payload = {
    from: m.from || process.env.RESEND_FROM_EMAIL || DEFAULT_FROM,
    to: m.to,
    subject: m.subject,
    html: m.html,
  };
  if (m.text) payload.text = m.text;
  if (m.replyTo) payload.replyTo = m.replyTo;
  const out = await resendClient(deps).emails.send(payload);
  const error = out && out.error;
  if (error) {
    // Only the error name and HTTP status: provider messages can echo the recipient address.
    const err = new Error(`Resend: ${error.name || 'error'}${error.statusCode ? ` (${error.statusCode})` : ''}`);
    err.code = 'EMAIL_SEND_FAILED';
    if (error.statusCode) err.statusCode = error.statusCode;
    throw err;
  }
  const data = out && out.data;
  return { id: (data && data.id) || null };
}

function M(deps, name) {
  if (deps && deps[name]) return deps[name];
  return require(`../../models/${name}`);
}

async function resolveQuery(q) {
  let query = q;
  if (query && typeof query.lean === 'function') query = query.lean();
  return query;
}

/**
 * Who gets the mail: prefill.email -> the owner's User.email (Membership role owner) -> business.contactEmail, but only an address the OWNER typed
 * (business.contactEmailByOwner, review R2-09: nobody else can name a third party that receives the platform's system e-mails).
 * Language = business.uiLanguage. null for a phone-only account (in-app notification only).
 * @param {{workspaceId:string}} args
 * @param {{OnboardingState?:object, Membership?:object, User?:object}} [deps]
 * @returns {Promise<{to:string, language:'en'|'ar'}|null>}
 */
async function resolveRecipient(args, deps) {
  const workspaceId = args && args.workspaceId;
  if (!workspaceId) return null;
  const state = await resolveQuery(M(deps, 'OnboardingState').findOne({ workspaceId }).select('prefill.email business.contactEmail business.contactEmailByOwner business.uiLanguage'));
  const language = state && state.business && state.business.uiLanguage === 'ar' ? 'ar' : 'en';

  const prefill = state && state.prefill && state.prefill.email;
  if (isEmail(prefill)) return { to: prefill.trim(), language };

  const membership = await resolveQuery(M(deps, 'Membership').findOne({ workspaceId, role: 'owner' }).select('userId'));
  if (membership && membership.userId) {
    const user = await resolveQuery(M(deps, 'User').findById(membership.userId).select('email'));
    if (user && isEmail(user.email)) return { to: user.email.trim(), language };
  }

  const contact = state && state.business && state.business.contactEmailByOwner === true ? state.business.contactEmail : null;
  if (isEmail(contact)) return { to: contact.trim(), language };
  return null;
}

/**
 * The e-mail leg of notifications.notify (INTERFACES 0.6). Resolves { sent, id? } or
 * { sent:false, skipped:'no_recipient'|'not_configured' }; THROWS when the provider fails (the caller
 * records emailError and retries up to 3 times).
 * @param {{workspaceId:string, notification?:object, kind?:string, params?:object, to?:string, language?:string}} args
 * @param {{send?:Function, resend?:object, resolveRecipient?:Function}} [deps]
 */
async function sendNotificationEmail(args, deps) {
  const a = args || {};
  if (!isConfigured(deps)) return { sent: false, skipped: 'not_configured' };
  const kind = a.kind || (a.notification && a.notification.kind);
  const resolver = (deps && deps.resolveRecipient) || ((x) => resolveRecipient(x, deps));

  let to = null;
  let language = a.language === 'ar' || a.language === 'en' ? a.language : null;
  if (isEmail(a.to)) {
    to = a.to.trim();
    if (!language) {
      const r = await Promise.resolve().then(() => resolver({ workspaceId: a.workspaceId })).catch(() => null);
      language = r && r.language ? r.language : 'en';
    }
  } else {
    const r = await resolver({ workspaceId: a.workspaceId });
    if (r && isEmail(r.to)) {
      to = r.to;
      language = language || r.language || 'en';
    }
  }
  if (!to) return { sent: false, skipped: 'no_recipient' };

  const actionPath = a.notification && a.notification.actionPath;
  const rendered = emailCopy.render(kind, language, { ...(a.params || {}), ...(actionPath ? { actionPath } : {}) });
  const sender = (deps && deps.send) || ((m) => send(m, deps));
  const res = await sender({ to, subject: rendered.subject, html: rendered.html, text: rendered.text });
  return { sent: true, id: (res && res.id) || undefined };
}

/**
 * Mail the support desk about an OnboardingSupportRequest (escaped context). Recipient:
 * ONBOARDING_SUPPORT_EMAIL || SUPPORT_DESK_EMAIL. THROWS on a provider error.
 * @param {{kind?:string, step?:string, lastErrorCode?:string, message?:string, businessName?:string, contactEmail?:string}} request
 * @param {{send?:Function, resend?:object, supportConfig?:Function}} [deps]
 * @returns {Promise<{sent:boolean, id?:string, skipped?:string}>}
 */
async function sendSupportEmail(request, deps) {
  const cfg = ((deps && deps.supportConfig) || config.supportConfig)();
  const to = cfg && (cfg.email || cfg.deskEmail);
  if (!isEmail(to)) return { sent: false, skipped: 'no_recipient' };
  if (!isConfigured(deps)) return { sent: false, skipped: 'not_configured' };
  const rendered = emailCopy.renderSupport(request);
  const msg = { to: to.trim(), subject: rendered.subject, html: rendered.html, text: rendered.text };
  if (request && isEmail(request.contactEmail)) msg.replyTo = request.contactEmail.trim();
  const sender = (deps && deps.send) || ((m) => send(m, deps));
  const res = await sender(msg);
  return { sent: true, id: (res && res.id) || undefined };
}

/**
 * Mail the support desk about a Meta data-deletion request (once per request, the caller decides). Recipient: ONBOARDING_SUPPORT_EMAIL ||
 * SUPPORT_DESK_EMAIL; nothing is sent when none is configured. The mail carries the request id only (escaped). THROWS on a provider error.
 * @param {{requestId:string}} request
 * @param {{send?:Function, resend?:object, supportConfig?:Function}} [deps]
 * @returns {Promise<{sent:boolean, id?:string, skipped?:string}>}
 */
async function sendDataDeletionNotice(request, deps) {
  const cfg = ((deps && deps.supportConfig) || config.supportConfig)();
  const to = cfg && (cfg.email || cfg.deskEmail);
  if (!isEmail(to)) return { sent: false, skipped: 'no_recipient' };
  if (!isConfigured(deps)) return { sent: false, skipped: 'not_configured' };
  const rendered = emailCopy.renderDataDeletion(request);
  const sender = (deps && deps.send) || ((m) => send(m, deps));
  const res = await sender({ to: to.trim(), subject: rendered.subject, html: rendered.html, text: rendered.text });
  return { sent: true, id: (res && res.id) || undefined };
}

module.exports = { sendNotificationEmail, send, resolveRecipient, sendSupportEmail, sendDataDeletionNotice, isConfigured, isEmail };
