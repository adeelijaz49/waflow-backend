'use strict';
// Waflow-staff page for the WhatsApp onboarding rollout, mounted at /internal-admin-onboarding behind
// middleware/requireInternalAdmin (HTTP Basic Auth) by shared/onboarding/mount.js (and only while
// ONBOARDING_FLOW=on). Conventions copied from routes/adminLocalization.js (DB design 3.5).
//
// What it does: find a workspace, see its onboarding state (enrolment, subscription, progress,
// number path, connection with a MASKED number and token-health flags only, templates, last 20
// events, open support requests, unmatched Stripe events), see the funnel, and act: Enrol,
// Un-enrol, Admin-activate (notes required), Admin-deactivate, Refresh connection now, Reconcile
// billing now. The home page also lists the Meta DATA-DELETION requests (open first) with a CSRF-protected "mark processed" action (status
// done, nothing is deleted, written to the admin log first; review R7-11).
//
// Safety decisions:
//  * CSRF: a Basic-auth page can be driven cross-site, so every POST needs HMAC-SHA256 of
//    "adminUser:workspaceId:UTC-day" keyed by INTERNAL_ADMIN_PASSWORD. Missing key, or a missing /
//    other-day / other-workspace token, is a 403 (fails closed, timing-safe compare).
//  * state.enrol / unenrol / adminActivate / adminDeactivate ALREADY write the OnboardingAdminLog
//    row BEFORE they mutate (a failing row = nothing changed); this page therefore never logs those
//    again, it only logs its own extra actions (refresh, reconcile), also BEFORE they act.
//  * Every dynamic value is HTML-escaped; the search text is length-capped and regex-escaped.
//  * Never shows a token, PIN or full phone number (the connection projection excludes them and
//    the number is masked with config.maskPhone). Never deletes anything.
// Every dependency is injectable (createRouter(overrides)) and loaded lazily: requiring this file
// loads no model and starts nothing.
const crypto = require('crypto');
const express = require('express');
const config = require('../shared/onboarding/config');

const BASE = '/internal-admin-onboarding';
const MAX_QUERY = 100;
const MAX_NOTES = 500;
const ID_RE = /^[a-fA-F0-9]{24}$/;
const OLDEST_MARK = '[webhook workspace / owner]';
const DONE_MESSAGES = Object.freeze({
  enrol: 'Workspace enrolled.',
  unenrol: 'Workspace un-enrolled.',
  activate: 'Subscription activated by an admin.',
  deactivate: 'Admin activation removed.',
  refresh: 'The connection will be re-checked at the next scheduler run.',
  reconcile: 'Billing was reconciled with Stripe.',
  deletion_done: 'The data-deletion request was marked processed.',
});
const REASON_MESSAGES = Object.freeze({
  INVALID_WORKSPACE_ID: 'That is not a valid workspace id.',
  WORKSPACE_NOT_FOUND: 'No workspace with that ID.',
  OLDEST_WORKSPACE: 'This is the OLDEST workspace (the webhook workspace / the owner). Tick the box that confirms you really want to enrol it.',
  EXISTING_DATA: 'This workspace already has data (customers, orders or promotions, or it is older than the enrolment cut-over). Tick the existing-data confirmation to enrol it anyway.',
  NOT_ENROLLED: 'This workspace is not enrolled.',
  NOTES_REQUIRED: 'Notes are required for an admin activation (say why, for example the partner name).',
});

function esc(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getAdminUser(req) {
  const header = (req.headers && req.headers.authorization) || '';
  if (!header.startsWith('Basic ')) return 'unknown';
  const [user] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return user || 'unknown';
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function utcDay(date) { return date.toISOString().slice(0, 10); }
function isId(value) { return typeof value === 'string' && ID_RE.test(value); }
function isTrue(value) { return value === 'on' || value === 'true' || value === '1' || value === true; }
function iso(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toISOString();
}
/** Arabic-Indic / Persian digits to Western (a phone typed in Arabic digits still finds its member). */
function westernDigits(text) {
  return String(text).replace(/[\u{660}-\u{669}]/gu, (c) => String(c.codePointAt(0) - 0x660))
    .replace(/[\u{6f0}-\u{6f9}]/gu, (c) => String(c.codePointAt(0) - 0x6f0));
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Waflow Onboarding Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;margin:0;padding:2rem}
  a{color:#4f8cff}
  .card{background:#151b23;padding:1.25rem;border-radius:10px;margin-bottom:1rem;max-width:860px}
  input[type=text],select{padding:.5rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box;width:100%}
  button{padding:.5rem 1rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  button.danger{background:#b3402f}
  .muted{color:#9aa4af;font-size:.8rem}
  .field{margin-bottom:.75rem}
  label{display:block;font-size:.8rem;color:#9aa4af;margin-bottom:.25rem}
  label.check{display:flex;gap:.5rem;align-items:flex-start;color:#e6e6e6;font-size:.85rem}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:100px;font-size:.75rem;background:#243044}
  .ok{background:#12351f;border:1px solid #2f8f4e;padding:.6rem .9rem;border-radius:8px;margin:.5rem 0 .75rem;font-size:.85rem;max-width:860px}
  .warn{background:#3d3410;border:1px solid #a88a1f;padding:.6rem .9rem;border-radius:8px;margin:.5rem 0 .75rem;font-size:.85rem}
  .banner{background:#5a1f1f;border:1px solid #a33;padding:.75rem 1rem;border-radius:8px;margin-bottom:1rem;max-width:860px}
  table{border-collapse:collapse;width:100%}td,th{text-align:start;padding:.25rem .5rem;border-bottom:1px solid #2a333d;font-size:.85rem;vertical-align:top}
  code{background:#0b0f14;padding:.1rem .3rem;border-radius:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
</style></head><body>
<div class="muted"><a href="${BASE}">&larr; Search</a></div>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

// Models and collaborators, loaded on first use (never at require time).
const LOADERS = {
  Workspace: () => require('../models/Workspace'),
  Membership: () => require('../models/Membership'),
  User: () => require('../models/User'),
  OnboardingState: () => require('../models/OnboardingState'),
  WhatsAppConnection: () => require('../models/WhatsAppConnection'),
  OnboardingTemplate: () => require('../models/OnboardingTemplate'),
  OnboardingEvent: () => require('../models/OnboardingEvent'),
  OnboardingSupportRequest: () => require('../models/OnboardingSupportRequest'),
  OnboardingInbound: () => require('../models/OnboardingInbound'),
  OnboardingAdminLog: () => require('../models/OnboardingAdminLog'),
  state: () => require('../shared/onboarding/state'),
  analytics: () => require('../shared/onboarding/analytics'),
  email: () => require('../shared/onboarding/email'),
  billing: () => require('../shared/onboarding/billing'),
  dataDeletion: () => require('../shared/onboarding/dataDeletion'),
};

// Connection fields that may be shown: never tokenEncrypted / pinEncrypted (select:false anyway).
const CONNECTION_FIELDS = [
  'status', 'ids.wabaId', 'ids.phoneNumberId', 'ids.onboardingEvent', 'display.displayPhoneNumber', 'display.last4', 'display.verifiedName',
  'tokenKeyVersion', 'tokenExpiresAt', 'tokenIsValid', 'tokenCheckedAt', 'needsReconnect', 'reconnectReason', 'lastStatusCheckAt', 'nextCheckAt',
  'checkFailures', 'lastError', 'webhook', 'verification.mapped', 'displayName.mapped', 'displayName.nameStatusRaw', 'messagingLimit',
  'quality.ratingRaw', 'health.canSend', 'payment.status', 'connectedAt', 'disconnectedAt',
].join(' ');

function createRouter(overrides = {}) {
  const router = express.Router();
  const o = overrides || {};
  const cache = {};
  /** Injected dependency, else the real one (created once, lazily). */
  const d = (name) => {
    if (o[name]) return o[name];
    if (!cache[name]) cache[name] = LOADERS[name]();
    return cache[name];
  };
  const getCsrfKey = () => (typeof o.getCsrfKey === 'function' ? o.getCsrfKey() : process.env.INTERNAL_ADMIN_PASSWORD);
  const nowDate = () => (typeof o.now === 'function' ? o.now() : new Date());

  function csrfToken(adminUser, workspaceId) {
    const key = getCsrfKey();
    if (!key) return null;
    return crypto.createHmac('sha256', key).update(`${adminUser}:${workspaceId}:${utcDay(nowDate())}`).digest('hex');
  }
  function csrfValid(adminUser, workspaceId, supplied) {
    const expected = csrfToken(adminUser, workspaceId);
    if (!expected || typeof supplied !== 'string' || supplied.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  }

  const page = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      config.safeLog('error', '[admin-onboarding]', err && err.code ? err.code : '', err && err.message ? err.message : '');
      if (!res.headersSent) res.status(500).send(layout('Error', '<div class="card"><p>Something went wrong. Check the server log, then check the current state on the workspace page before trying again.</p></div>'));
    }
  };

  const notFound = (res) => res.status(404).send(layout('Not found', '<div class="card"><p>No workspace with that ID.</p></div>'));
  const rejected = (res) => res.status(403).send(layout('Request rejected', '<div class="card"><p>This form has expired or is invalid. Go back, reload the workspace page and try again.</p></div>'));
  const problem = (res, status, message) => res.status(status).send(layout('Not changed', `<div class="card"><p>${esc(message)}</p><p class="muted">Nothing was changed.</p></div>`));

  // The oldest workspace = the one the single-workspace webhook serves ({ workspaceId, name, createdAt } or null).
  // Read-only and fail-soft: a problem simply means "no marker".
  async function webhookWorkspace() {
    try {
      let w = null;
      if (typeof o.findWebhookWorkspace === 'function') w = await o.findWebhookWorkspace();
      else w = await d('Workspace').findOne().sort({ createdAt: 1 }).select('name createdAt').lean();
      if (!w || !(w.workspaceId || w._id)) return null;
      return { workspaceId: String(w.workspaceId || w._id), name: w.name, createdAt: w.createdAt };
    } catch (err) {
      return null;
    }
  }

  async function safe(fn, fallback) {
    try { return await fn(); } catch (err) { return fallback; }
  }

  // ── Panels ──────────────────────────────────────────────────────────────
  function funnelPanel(f) {
    if (!f) return '<div class="card"><h3>Funnel</h3><p class="muted">The funnel could not be loaded.</p></div>';
    const stepRows = Object.entries(f.steps || {}).map(([k, s]) => `<tr><td>${esc(k)}</td><td>${esc(s.entered)}</td><td>${esc(s.completed)}</td><td>${esc(s.skipped)}</td><td>${s.medianMinutes === null || s.medianMinutes === undefined ? '-' : esc(s.medianMinutes)}</td><td>${esc(s.dropOff)}</td></tr>`).join('');
    const codes = (f.failureCodes || []).map((c) => `<tr><td><code>${esc(c.code)}</code></td><td>${esc(c.count)}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None recorded.</td></tr>';
    const counts = (obj) => Object.entries(obj || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    const warn = (f.warnings || []).length ? `<div class="warn">Incomplete data: ${esc(f.warnings.join(', '))}</div>` : '';
    return `<div class="card"><h3>Funnel</h3>${warn}
      <p>Enrolled workspaces: <strong>${esc(f.enrolled)}</strong>, finished: <strong>${esc(f.completed)}</strong>. <span class="muted">Drop-off = stuck on that step with no activity for 7 days.</span></p>
      <table><tr><th>Step</th><th>Entered</th><th>Completed</th><th>Skipped</th><th>Median minutes</th><th>Drop-off</th></tr>${stepRows}</table>
      <div class="grid"><div><h4>Top failure codes</h4><table><tr><th>Code</th><th>Count</th></tr>${codes}</table></div>
      <div><h4>Subscription</h4><table>${counts(f.subscription)}</table></div>
      <div><h4>Connection</h4><table>${counts(f.connection)}</table></div></div></div>`;
  }

  function section(title, rows) {
    return `<div class="card"><h3>${esc(title)}</h3><table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  }

  function subscriptionPanel(st) {
    const sub = st.subscription || {};
    const stripe = sub.stripe || {};
    const admin = sub.admin || {};
    return section('Subscription', [
      ['State', `<span class="pill">${esc(sub.state || 'none')}</span> source: ${esc(sub.source || '-')}`],
      ['Raw Stripe status', esc(stripe.status || '-')],
      ['Plan code', esc(stripe.planCode || '-')],
      ['Current period ends', esc(iso(stripe.currentPeriodEnd))],
      ['Cancels at period end', esc(stripe.cancelAtPeriodEnd ? 'yes' : 'no')],
      ['Last Stripe sync', esc(iso(stripe.lastSyncedAt))],
      ['Last payment failure', esc(stripe.lastPaymentFailedAt ? `${iso(stripe.lastPaymentFailedAt)} ${stripe.lastPaymentFailureCode || ''}` : '-')],
      ['Admin activation', admin.active ? `active, by ${esc(admin.by)} on ${esc(iso(admin.at))}, notes: ${esc(admin.notes)}` : 'none'],
      ['Changed / activated / past due / cancelled', `${esc(iso(sub.changedAt))} / ${esc(iso(sub.activatedAt))} / ${esc(iso(sub.pastDueAt))} / ${esc(iso(sub.cancelledAt))}`],
    ]);
  }

  function progressPanel(st) {
    const p = st.progress || {};
    const n = st.number || {};
    const steps = st.steps || {};
    const stepRows = config.STEP_KEYS.map((k) => {
      const s = steps[k] || {};
      return `<tr><td>${esc(k)}</td><td>${esc(s.status || 'todo')}</td><td>${esc(iso(s.enteredAt))}</td><td>${esc(iso(s.completedAt))}</td><td>${esc(s.attempts || 0)}</td></tr>`;
    }).join('');
    return `<div class="card"><h3>Progress</h3>
      <p>Status: <span class="pill">${esc(p.status || 'in_progress')}</span> current step ${esc(p.currentStep || 1)}, last activity ${esc(iso(p.lastActivityAt))}, completed ${esc(iso(p.completedAt))}</p>
      <table><tr><th>Step</th><th>Status</th><th>Entered</th><th>Completed</th><th>Attempts</th></tr>${stepRows}</table>
      <p class="muted">Number path: ${esc(n.path || '-')}, usage ${esc(n.usage || '-')}, number ready: ${esc(n.numberReady ? 'yes' : 'no')}, reminders sent: ${esc(n.reminderCount || 0)}, paused at ${esc(iso(n.pausedAt))}</p></div>`;
  }

  function connectionPanel(conn) {
    if (!conn) return '<div class="card"><h3>WhatsApp connection</h3><p class="muted">No connection record yet.</p></div>';
    const disp = conn.display || {};
    const masked = disp.displayPhoneNumber ? config.maskPhone(disp.displayPhoneNumber) : (disp.last4 ? `****${disp.last4}` : '-');
    const ids = conn.ids || {};
    const wh = conn.webhook || {};
    const le = conn.lastError || {};
    return section('WhatsApp connection', [
      ['Status', `<span class="pill">${esc(conn.status || '-')}</span>${conn.needsReconnect ? ` needs reconnect (${esc(conn.reconnectReason || 'unknown')})` : ''}`],
      ['Number (masked)', esc(masked)],
      ['Verified name', esc(disp.verifiedName || '-')],
      ['Business account / phone id set', `${esc(ids.wabaId ? 'yes' : 'no')} / ${esc(ids.phoneNumberId ? 'yes' : 'no')}`],
      ['Token health', `valid: ${esc(conn.tokenIsValid === undefined || conn.tokenIsValid === null ? 'unknown' : conn.tokenIsValid ? 'yes' : 'no')}, expires ${esc(iso(conn.tokenExpiresAt))}, checked ${esc(iso(conn.tokenCheckedAt))}, key version ${esc(conn.tokenKeyVersion || '-')}`],
      ['Webhook subscribed', esc(wh.subscribed ? 'yes' : 'no')],
      ['Approvals', `verification ${esc((conn.verification && conn.verification.mapped) || '-')}, display name ${esc((conn.displayName && conn.displayName.mapped) || '-')}, payment ${esc((conn.payment && conn.payment.status) || '-')}, limit ${esc((conn.messagingLimit && conn.messagingLimit.raw) || '-')}, quality ${esc((conn.quality && conn.quality.ratingRaw) || '-')}, can send ${esc((conn.health && conn.health.canSend) || '-')}`],
      ['Last check / next check / failures', `${esc(iso(conn.lastStatusCheckAt))} / ${esc(iso(conn.nextCheckAt))} / ${esc(conn.checkFailures || 0)}`],
      ['Last error', esc(le.code ? `${le.code} (${le.kind || ''}) ${iso(le.at)}` : '-')],
      ['Connected / disconnected', `${esc(iso(conn.connectedAt))} / ${esc(iso(conn.disconnectedAt))}`],
    ]);
  }

  function listPanel(title, headers, rows, emptyText) {
    const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
    const body = rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}" class="muted">${esc(emptyText)}</td></tr>`;
    return `<div class="card"><h3>${esc(title)}</h3><table><tr>${head}</tr>${body}</table></div>`;
  }

  function actionsPanel({ workspace, enrolled, isOldest, token, sub }) {
    if (!token) {
      return '<div class="card"><h3>Actions</h3><p class="muted">Actions are unavailable: INTERNAL_ADMIN_PASSWORD is not set on this server. Use scripts/onboarding-admin.js.</p></div>';
    }
    const wsId = esc(workspace._id);
    const hidden = `<input type="hidden" name="csrf" value="${esc(token)}">`;
    const form = (action, inner, button, cls) => `<form method="POST" action="${BASE}/${wsId}/${action}" class="field">${hidden}${inner}<button type="submit"${cls ? ` class="${cls}"` : ''}>${esc(button)}</button></form>`;
    const notes = (required) => `<div class="field"><label>Notes${required ? ' (required)' : ' (optional)'}, max ${MAX_NOTES}</label><input type="text" name="notes" maxlength="${MAX_NOTES}"${required ? ' required' : ''}></div>`;
    if (!enrolled) {
      const oldestBox = isOldest
        ? `<div class="banner"><strong>${esc(OLDEST_MARK)}</strong> This is the OLDEST workspace: the single WhatsApp webhook serves it and it is the owner's own workspace. Enrolling it puts the new onboarding flow, the subscription lock and the legacy-send policy on it.</div>
           <label class="check"><input type="checkbox" name="forceOldest" value="on"> I understand: enrol the OLDEST workspace anyway</label>`
        : '';
      return `<div class="card"><h3>Enrol in the onboarding flow</h3>
        ${form('enrol', `${oldestBox}
          <label class="check"><input type="checkbox" name="confirmExistingData" value="on"> This workspace may already have customers, orders or promotions: confirm enrolling it anyway</label>
          <label class="check"><input type="checkbox" name="activate" value="on"> Also admin-activate the subscription (partner account)</label>
          ${notes(false)}`, 'Enrol this workspace')}
        <p class="muted">Enrolment is only active while ONBOARDING_FLOW=on. Nothing else about this workspace changes.</p></div>`;
    }
    const adminActive = !!(sub && sub.admin && sub.admin.active);
    return `<div class="card"><h3>Actions</h3>
      ${isOldest ? `<div class="banner"><strong>${esc(OLDEST_MARK)}</strong> This is the OLDEST workspace.</div>` : ''}
      <div class="grid">
        <div>${form('activate', notes(true), 'Admin-activate subscription')}</div>
        <div>${adminActive ? form('deactivate', notes(false), 'Admin-deactivate') : '<p class="muted">No admin activation to remove.</p>'}</div>
        <div>${form('refresh', '', 'Refresh connection now')}</div>
        <div>${form('reconcile', '', 'Reconcile billing now')}</div>
        <div>${form('unenrol', notes(false), 'Un-enrol this workspace', 'danger')}</div>
      </div></div>`;
  }

  /** Meta data-deletion requests: open first. Each open one has a "mark processed" form (CSRF scope: the request code). */
  function deletionPanel(lists, adminUser) {
    const rows = [...lists.open, ...lists.done];
    const table = rows.map((r) => {
      const open = r.status !== 'done';
      const token = csrfToken(adminUser, `data-deletion:${r.code}`);
      const action = !open ? '<span class="muted">processed</span>'
        : (token
          ? `<form method="POST" action="${BASE}/data-deletion/${esc(r.code)}/done" class="field"><input type="hidden" name="csrf" value="${esc(token)}"><input type="text" name="notes" maxlength="${MAX_NOTES}" placeholder="Notes (optional)"><button type="submit">Mark processed</button></form>`
          : '<span class="muted">use scripts/onboarding-admin.js</span>');
      return [`<code>${esc(r.code)}</code>`, `<span class="pill">${esc(open ? 'open' : 'processed')}</span>`, esc(iso(r.receivedAt)),
        r.workspaceId ? `<a href="${BASE}/${esc(r.workspaceId)}">${esc(r.workspaceId)}</a>` : '-', esc(r.outcome || '-'), action];
    });
    const warn = lists.open.length ? `<div class="warn"><strong>${esc(lists.open.length)} open request(s)</strong>: Meta asked WaFlow to delete a user's data. Nothing is deleted automatically: process each one with the internal admin PII tooling, then mark it processed.</div>` : '';
    return `${warn}${listPanel('Meta data-deletion requests', ['Request id', 'Status', 'Received (UTC)', 'Workspace', 'Note', 'Action'], table, 'No data-deletion request has been received.')}`;
  }

  // ── Pages ───────────────────────────────────────────────────────────────
  router.get('/', page(async (req, res) => {
    const webhook = await webhookWorkspace();
    const funnel = await safe(() => d('analytics').funnel(), null);
    const deletions = await safe(() => d('dataDeletion').listRequests(), { open: [], done: [] });
    const homeDone = typeof req.query.done === 'string' && DONE_MESSAGES[req.query.done] ? `<div class="ok">${esc(DONE_MESSAGES[req.query.done])}</div>` : '';
    const enrolledRows = await safe(async () => {
      const rows = await d('OnboardingState').find({ enrolled: { $ne: false } }).select('workspaceId enrolledAt subscription.state progress.status').limit(50).lean();
      return rows;
    }, []);
    const names = await safe(async () => {
      if (!enrolledRows.length) return new Map();
      const ws = await d('Workspace').find({ _id: { $in: enrolledRows.map((r) => r.workspaceId) } }).select('name').lean();
      return new Map(ws.map((w) => [String(w._id), w.name]));
    }, new Map());
    const enrolledList = enrolledRows.map((r) => [
      `<a href="${BASE}/${esc(r.workspaceId)}">${esc(names.get(String(r.workspaceId)) || r.workspaceId)}</a>`,
      esc((r.subscription && r.subscription.state) || 'none'),
      esc((r.progress && r.progress.status) || '-'),
      esc(iso(r.enrolledAt)),
    ]);
    res.send(layout('Onboarding Admin', `
      ${homeDone}
      ${deletionPanel(deletions, getAdminUser(req))}
      ${webhook ? `<div class="card"><p>${esc(OLDEST_MARK)} the OLDEST workspace: <a href="${BASE}/${esc(webhook.workspaceId)}">${esc(webhook.name || webhook.workspaceId)}</a> <span class="muted">${esc(webhook.workspaceId)}</span></p></div>` : ''}
      <div class="card">
        <form method="GET" action="${BASE}/search">
          <div class="field"><label>Workspace name, ID, or a member's phone / name / email</label><input type="text" name="q" maxlength="${MAX_QUERY}" required autofocus></div>
          <button type="submit">Search</button>
        </form>
      </div>
      ${listPanel('Enrolled workspaces', ['Workspace', 'Subscription', 'Progress', 'Enrolled at (UTC)'], enrolledList, 'No workspace is enrolled.')}
      ${funnelPanel(funnel)}
    `));
  }));

  async function findWorkspaces(q) {
    const Workspace = d('Workspace');
    if (isId(q)) return Workspace.find({ _id: q }).limit(1).lean();
    const rx = new RegExp(escapeRegex(q), 'i');
    const byName = await Workspace.find({ name: rx }).limit(50).lean();
    const digits = westernDigits(q).replace(/\D/g, '');
    const userFilter = [{ name: rx }, { email: rx }];
    if (digits.length >= 3) userFilter.push({ phone: new RegExp(escapeRegex(digits)) });
    const users = await d('User').find({ $or: userFilter }).select('_id').limit(50).lean();
    let byMember = [];
    if (users.length) {
      const memberships = await d('Membership').find({ userId: { $in: users.map((u) => u._id) } }).select('workspaceId').limit(100).lean();
      const ids = new Set(memberships.map((m) => String(m.workspaceId)));
      byName.forEach((w) => ids.delete(String(w._id)));
      if (ids.size) byMember = await Workspace.find({ _id: { $in: Array.from(ids) } }).limit(50).lean();
    }
    return [...byName, ...byMember].slice(0, 50);
  }

  router.get('/search', page(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, MAX_QUERY) : '';
    if (!q) return res.redirect(BASE);
    const workspaces = await findWorkspaces(q);
    const rows = workspaces.map((w) => `<li><a href="${BASE}/${esc(w._id)}">${esc(w.name)}</a> <span class="muted">${esc(w._id)}</span></li>`).join('')
      || '<li class="muted">No matches.</li>';
    res.send(layout('Search results', `<div class="card"><ul>${rows}</ul></div>`));
  }));

  router.get('/:workspaceId', page(async (req, res) => {
    const { workspaceId } = req.params;
    if (!isId(workspaceId)) return notFound(res);
    const workspace = await d('Workspace').findById(workspaceId).select('name createdAt').lean();
    if (!workspace) return notFound(res);

    const [webhook, st, conn, templates, events, requests, unmatched, log] = await Promise.all([
      webhookWorkspace(),
      safe(() => d('OnboardingState').findOne({ workspaceId: workspace._id }).lean(), null),
      safe(() => d('WhatsAppConnection').findOne({ workspaceId: workspace._id }).select(CONNECTION_FIELDS).lean(), null),
      safe(() => d('OnboardingTemplate').find({ workspaceId: workspace._id }).select('key language metaStatus metaStatusRaw blockedReason lastErrorCode').limit(60).lean(), []),
      safe(() => d('OnboardingEvent').find({ workspaceId: workspace._id }).sort({ at: -1 }).limit(20).lean(), []),
      safe(() => d('OnboardingSupportRequest').find({ workspaceId: workspace._id, status: 'open' }).sort({ createdAt: -1 }).limit(10).lean(), []),
      safe(() => d('OnboardingInbound').find({ status: 'unmatched' }).select('source type startedAt outcome').limit(20).lean(), []),
      safe(() => d('OnboardingAdminLog').find({ workspaceId: workspace._id }).sort({ createdAt: -1 }).limit(20).lean(), []),
    ]);
    const enrolled = !!st && st.enrolled !== false;
    const isOldest = !!webhook && webhook.workspaceId === String(workspace._id);
    const adminUser = getAdminUser(req);
    const token = csrfToken(adminUser, String(workspace._id));

    let emailWarning = '';
    if (enrolled) {
      const recipient = await safe(() => d('email').resolveRecipient({ workspaceId: String(workspace._id) }), undefined);
      if (recipient === null) emailWarning = '<div class="warn"><strong>No e-mail on file</strong> (phone-only account): this workspace gets in-app notifications only.</div>';
    }
    const done = typeof req.query.done === 'string' && DONE_MESSAGES[req.query.done] ? `<div class="ok">${esc(DONE_MESSAGES[req.query.done])}</div>` : '';

    const stateBlock = enrolled
      ? `${subscriptionPanel(st)}${progressPanel(st)}`
      : `<div class="card"><p>Not enrolled${st ? ` (un-enrolled ${esc(iso(st.unenrolledAt))} by ${esc(st.unenrolledBy)})` : ''}. Legacy workspace: nothing is gated.</p></div>`;
    const enrolment = enrolled
      ? `<p>Enrolled <span class="pill">yes</span> ${esc(iso(st.enrolledAt))} via ${esc(st.enrolledVia || '-')} by ${esc(st.enrolledBy || '-')}. Existing wizard marked completed (R1): ${esc(st.r1Applied ? 'yes' : 'no')}.</p>`
      : '<p>Enrolled <span class="pill">no</span></p>';

    res.send(layout(workspace.name, `
      ${done}
      ${isOldest ? `<div class="banner"><strong>${esc(OLDEST_MARK)}</strong> This is the OLDEST workspace: the WhatsApp webhook serves it.</div>` : ''}
      <div class="card"><p class="muted">Workspace ${esc(workspace._id)}, created ${esc(iso(workspace.createdAt))}</p>${enrolment}</div>
      ${emailWarning}
      ${actionsPanel({ workspace, enrolled, isOldest, token, sub: st && st.subscription })}
      ${stateBlock}
      ${enrolled ? connectionPanel(conn) : ''}
      ${enrolled ? listPanel('Starter templates', ['Key', 'Language', 'Status', 'Raw status', 'Blocked', 'Last error'],
        templates.map((t) => [esc(t.key), esc(t.language), esc(t.metaStatus || '-'), esc(t.metaStatusRaw || '-'), esc(t.blockedReason || '-'), esc(t.lastErrorCode || '-')]), 'No templates yet.') : ''}
      ${enrolled ? listPanel('Last 20 events', ['When (UTC)', 'Type', 'Step', 'Code', 'Reason'],
        events.map((e) => [esc(iso(e.at)), esc(e.type), esc(e.step || '-'), esc(e.code || '-'), esc(e.reason || '-')]), 'No events yet.') : ''}
      ${enrolled ? listPanel('Open support requests', ['When (UTC)', 'Kind', 'Step', 'Last error', 'Message'],
        requests.map((r) => [esc(iso(r.createdAt)), esc(r.kind), esc(r.step || '-'), esc(r.lastErrorCode || '-'), esc(String(r.message || '').slice(0, 200))]), 'No open requests.') : ''}
      ${listPanel('Unmatched Stripe events (all workspaces)', ['Event', 'Type', 'When (UTC)', 'Outcome'],
        unmatched.filter((u) => !u.source || u.source === 'stripe').map((u) => [esc(u._id), esc(u.type || '-'), esc(iso(u.startedAt)), esc(u.outcome || '-')]), 'None.')}
      ${listPanel('Last changes', ['When (UTC)', 'Action', 'By', 'Notes'],
        log.map((l) => [esc(iso(l.createdAt)), esc(l.action), esc(l.adminUser), esc(l.notes)]), 'No changes yet.')}
    `));
  }));

  // ── Actions ─────────────────────────────────────────────────────────────
  /** Common prologue of every POST: id check, CSRF (fails closed), admin user. Returns null after answering. */
  function guard(req, res) {
    const { workspaceId } = req.params;
    if (!isId(workspaceId)) { notFound(res); return null; }
    const body = req.body || {};
    const adminUser = getAdminUser(req);
    if (!csrfValid(adminUser, workspaceId, body.csrf)) { rejected(res); return null; }
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, MAX_NOTES) : '';
    return { workspaceId, body, adminUser, notes, ip: req.adminIp };
  }

  /** Map a state.js VALIDATION_FAILED (reason) to a friendly page; anything else is rethrown. */
  function stateError(res, err) {
    const reason = err && err.details && err.details.reason;
    if (err && err.code === 'VALIDATION_FAILED' && reason && REASON_MESSAGES[reason]) {
      const extra = Array.isArray(err.details.reasons) && err.details.reasons.length ? ` (${err.details.reasons.join(', ')})` : '';
      return problem(res, reason === 'WORKSPACE_NOT_FOUND' ? 404 : 422, `${REASON_MESSAGES[reason]}${extra}`);
    }
    throw err;
  }

  const done = (res, workspaceId, action) => res.redirect(303, `${BASE}/${workspaceId}?done=${action}`);

  router.post('/:workspaceId/enrol', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    try {
      await d('state').enrol({
        workspaceId: g.workspaceId, via: 'admin', by: g.adminUser, notes: g.notes, ip: g.ip,
        activate: isTrue(g.body.activate), forceOldest: isTrue(g.body.forceOldest), confirmExistingData: isTrue(g.body.confirmExistingData),
      });
    } catch (err) { return stateError(res, err); }
    return done(res, g.workspaceId, 'enrol');
  }));

  router.post('/:workspaceId/unenrol', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    try {
      await d('state').unenrol({ workspaceId: g.workspaceId, by: g.adminUser, notes: g.notes, ip: g.ip });
    } catch (err) { return stateError(res, err); }
    return done(res, g.workspaceId, 'unenrol');
  }));

  router.post('/:workspaceId/activate', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    if (!g.notes.trim()) return problem(res, 422, REASON_MESSAGES.NOTES_REQUIRED);
    try {
      await d('state').adminActivate({ workspaceId: g.workspaceId, by: g.adminUser, notes: g.notes, ip: g.ip });
    } catch (err) { return stateError(res, err); }
    return done(res, g.workspaceId, 'activate');
  }));

  router.post('/:workspaceId/deactivate', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    try {
      await d('state').adminDeactivate({ workspaceId: g.workspaceId, by: g.adminUser, notes: g.notes, ip: g.ip });
    } catch (err) { return stateError(res, err); }
    return done(res, g.workspaceId, 'deactivate');
  }));

  router.post('/data-deletion/:code/done', page(async (req, res) => {
    const { code } = req.params;
    const mod = d('dataDeletion');
    if (typeof code !== 'string' || !mod.CODE_RE.test(code)) return notFound(res);
    const body = req.body || {};
    const adminUser = getAdminUser(req);
    if (!csrfValid(adminUser, `data-deletion:${code}`, body.csrf)) return rejected(res);
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, MAX_NOTES) : '';
    try {
      await mod.markProcessed({ code, by: adminUser, notes, ip: req.adminIp });
    } catch (err) {
      if (err && err.code === 'VALIDATION_FAILED' && err.details && err.details.reason === 'NOT_FOUND') return notFound(res);
      config.safeLog('error', '[admin-onboarding] data-deletion mark failed - nothing was changed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
      return problem(res, 500, 'The request could not be marked processed (the audit log is written first). Nothing was changed; try again.');
    }
    return res.redirect(303, `${BASE}?done=deletion_done`);
  }));

  /** The audit row of this page's own actions, written BEFORE the action (a failing row = nothing changed). */
  async function logOwnAction(g, notes, before, after) {
    await d('OnboardingAdminLog').create({
      workspaceId: g.workspaceId, action: 'refresh', adminUser: g.adminUser, notes, ip: g.ip, before, after,
    });
  }

  router.post('/:workspaceId/refresh', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    const st = await d('OnboardingState').findOne({ workspaceId: g.workspaceId }).select('enrolled').lean();
    if (!st || st.enrolled === false) return problem(res, 422, REASON_MESSAGES.NOT_ENROLLED);
    const conn = await d('WhatsAppConnection').findOne({ workspaceId: g.workspaceId }).select('nextCheckAt').lean();
    if (!conn) return problem(res, 422, 'This workspace has no WhatsApp connection record yet.');
    const now = nowDate();
    try {
      await logOwnAction(g, 'refresh connection now', { nextCheckAt: conn.nextCheckAt || null }, { nextCheckAt: now });
    } catch (err) {
      config.safeLog('error', '[admin-onboarding] audit log write failed - nothing was changed:', err && err.message);
      return problem(res, 500, 'The audit log could not be written, so the connection was left as it was.');
    }
    await d('WhatsAppConnection').updateOne({ workspaceId: g.workspaceId }, { $set: { nextCheckAt: now } });
    return done(res, g.workspaceId, 'refresh');
  }));

  router.post('/:workspaceId/reconcile', page(async (req, res) => {
    const g = guard(req, res);
    if (!g) return undefined;
    const st = await d('OnboardingState').findOne({ workspaceId: g.workspaceId }).select('enrolled subscription.state').lean();
    if (!st || st.enrolled === false) return problem(res, 422, REASON_MESSAGES.NOT_ENROLLED);
    try {
      await logOwnAction(g, 'reconcile billing now', { state: (st.subscription && st.subscription.state) || 'none' }, { requested: true });
    } catch (err) {
      config.safeLog('error', '[admin-onboarding] audit log write failed - nothing was changed:', err && err.message);
      return problem(res, 500, 'The audit log could not be written, so billing was not reconciled.');
    }
    try {
      await d('billing').refreshBilling({ workspaceId: g.workspaceId });
    } catch (err) {
      config.safeLog('warn', '[admin-onboarding] billing reconcile failed:', err && err.code ? err.code : '', err && err.message ? err.message : '');
      return problem(res, 502, `Billing could not be reconciled right now (${(err && err.code) || 'error'}). The attempt was recorded; check the workspace page and try again.`);
    }
    return done(res, g.workspaceId, 'reconcile');
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.esc = esc;
module.exports.OLDEST_MARK = OLDEST_MARK;
