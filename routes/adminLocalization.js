'use strict';
// Waflow-staff page for the Arabic localisation rollout, mounted at
// /internal-admin-localization behind middleware/requireInternalAdmin (HTTP
// Basic Auth, same gate as the other internal-admin tools). Style and helpers
// (esc / getAdminUser / layout) are copied from routes/adminInstagram.js.
//
// What it does: find a workspace, see its Arabic flag + counts + the kill-switch
// state, switch the flag on/off one merchant at a time (spec section 8), and see
// how many strings still await native review.
//
// Safety decisions:
//  * Basic-auth pages are CSRF-able (the browser re-sends credentials on any
//    cross-site form post), so the toggle needs a token: HMAC-SHA256 of
//    "adminUser:workspaceId:UTC-date" keyed by INTERNAL_ADMIN_PASSWORD. Missing
//    key, missing/other-day/other-workspace token => 403. Fails closed.
//  * Every dynamic value is HTML-escaped; search input is a length-capped,
//    regex-escaped string; ids are checked before any query.
//  * Writes only LocaleSettings (through the settings service) and the
//    append-only LocalizationAdminLog. Never deletes.
//  * The audit row is written BEFORE the flag changes (log-before-mutate, like
//    shared/consent.js): if the row cannot be written the flag is not touched and the
//    operator gets a friendly "nothing was changed" page.
// Dependencies are injectable (createRouter) so the page is tested without a DB.
const crypto = require('crypto');
const express = require('express');
const { isObjectIdLike } = require('../shared/localization/scope');

const BASE = '/internal-admin-localization';
const MAX_QUERY = 100;
const MAX_NOTES = 500;

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function getAdminUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return 'unknown';
  const [user] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return user || 'unknown';
}

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} - Waflow Localisation Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;margin:0;padding:2rem}
  a{color:#4f8cff}
  .card{background:#151b23;padding:1.25rem;border-radius:10px;margin-bottom:1rem;max-width:760px}
  input,select{padding:.5rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box;width:100%}
  button{padding:.5rem 1rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  .muted{color:#9aa4af;font-size:.8rem}
  .field{margin-bottom:.75rem}
  label{display:block;font-size:.8rem;color:#9aa4af;margin-bottom:.25rem}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:100px;font-size:.75rem;background:#243044}
  .banner{background:#5a1f1f;border:1px solid #a33;padding:.75rem 1rem;border-radius:8px;margin-bottom:1rem;max-width:760px}
  table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.25rem .5rem;border-bottom:1px solid #2a333d;font-size:.85rem}
  code{background:#0b0f14;padding:.1rem .3rem;border-radius:4px}
</style></head><body>
<div class="muted"><a href="${BASE}">&larr; Search</a></div>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function defaultDeps() {
  return {
    Workspace: require('../models/Workspace'),
    Membership: require('../models/Membership'),
    User: require('../models/User'),
    LocaleSettings: require('../models/LocaleSettings'),
    LocalizationAdminLog: require('../models/LocalizationAdminLog'),
    settings: require('../shared/localization/settings'),
    overview: require('../shared/localization/overview'),
    catalog: require('../shared/localization/catalog'),
    // Optional: the template library is built by another slice; "n/a" until it exists.
    getLibrary() {
      try { return require('../shared/localization/templateLibrary'); } catch (err) { return null; }
    },
    getCsrfKey: () => process.env.INTERNAL_ADMIN_PASSWORD,
    now: () => new Date(),
  };
}

function createRouter(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const router = express.Router();

  function csrfToken(adminUser, workspaceId) {
    const key = deps.getCsrfKey();
    if (!key) return null;
    return crypto.createHmac('sha256', key).update(`${adminUser}:${workspaceId}:${utcDay(deps.now())}`).digest('hex');
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
      console.error('[admin-localization]', err && err.message);
      if (!res.headersSent) res.status(500).send(layout('Error', '<div class="card"><p>Something went wrong. Check the server log and try again.</p></div>'));
    }
  };

  const notFound = (res) => res.status(404).send(layout('Not found', '<div class="card"><p>No workspace with that ID.</p></div>'));

  function killSwitchBanner() {
    return deps.settings.killSwitchOn()
      ? '<div class="banner"><strong>Kill switch is ON</strong> (LOCALIZATION_DISABLED): every Arabic feature is off for every merchant, whatever their flag says.</div>'
      : '';
  }

  function reviewPanel() {
    const counts = deps.catalog.counts();
    const byNamespace = new Map();
    for (const entry of deps.catalog.listEntries()) {
      const ns = entry.key.split('.')[0];
      const row = byNamespace.get(ns) || { total: 0, draft: 0, reviewed: 0 };
      row.total += 1;
      if (entry.ar) row[entry.status === 'reviewed' ? 'reviewed' : 'draft'] += 1;
      byNamespace.set(ns, row);
    }
    const rows = Array.from(byNamespace, ([ns, r]) => `<tr><td>${esc(ns)}</td><td>${r.total}</td><td>${r.draft}</td><td>${r.reviewed}</td></tr>`).join('');
    let library = 'n/a';
    let legal = 0;
    const lib = deps.getLibrary();
    if (lib && typeof lib.listLibraryStrings === 'function') {
      const strings = lib.listLibraryStrings();
      library = `${strings.filter((s) => s.status !== 'reviewed').length} unreviewed of ${strings.length}`;
      legal = strings.filter((s) => s.needsLegalApproval && s.status !== 'reviewed').length;
    }
    return `<div class="card"><h3>String review (native Arabic speaker)</h3>
      <p>Backend catalogue: <strong>${counts.arabicDraft}</strong> unreviewed, ${counts.arabicReviewed} reviewed, ${counts.arabicMissing} without Arabic (of ${counts.total}).</p>
      <p>Template library: ${esc(library)}.</p>
      <p>Strings that need legal approval before going live: <strong>${counts.needsLegalApproval + legal}</strong>.</p>
      <table><tr><th>Namespace</th><th>Strings</th><th>Draft</th><th>Reviewed</th></tr>${rows}</table>
      <p class="muted">How to review: run the export script (<code>node scripts/i18n-review.js export</code>) to get a CSV with an English and an Arabic column per string,
      give it to the native reviewer, then load their corrected file back with the import script (<code>node scripts/i18n-review.js import file.csv</code>).
      Only the import marks strings as reviewed. Nothing here edits strings.</p></div>`;
  }

  router.get('/', page(async (req, res) => {
    res.send(layout('Arabic Localisation Admin', `
      ${killSwitchBanner()}
      <div class="card">
        <form method="GET" action="${BASE}/search">
          <div class="field"><label>Workspace name, ID, or a member's phone / name / email</label><input type="text" name="q" maxlength="${MAX_QUERY}" required autofocus></div>
          <button type="submit">Search</button>
        </form>
      </div>
      ${reviewPanel()}
    `));
  }));

  async function findWorkspaces(q) {
    if (isObjectIdLike(q)) return deps.Workspace.find({ _id: q }).limit(1).lean();
    const rx = new RegExp(escapeRegex(q), 'i');
    const ids = new Set();
    const byName = await deps.Workspace.find({ name: rx }).limit(50).lean();
    const digits = q.replace(/\D/g, '');
    const userFilter = [{ name: rx }, { email: rx }];
    if (digits.length >= 3) userFilter.push({ phone: new RegExp(escapeRegex(digits)) });
    const users = await deps.User.find({ $or: userFilter }).select('_id').limit(50).lean();
    let byMember = [];
    if (users.length) {
      const memberships = await deps.Membership.find({ userId: { $in: users.map((u) => u._id) } }).select('workspaceId').limit(100).lean();
      memberships.forEach((m) => ids.add(String(m.workspaceId)));
      byName.forEach((w) => ids.delete(String(w._id)));
      if (ids.size) byMember = await deps.Workspace.find({ _id: { $in: Array.from(ids) } }).limit(50).lean();
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
    if (!isObjectIdLike(workspaceId)) return notFound(res);
    const workspace = await deps.Workspace.findById(workspaceId).lean();
    if (!workspace) return notFound(res);

    const [flag, summary, translations, log] = await Promise.all([
      deps.LocaleSettings.findOne({ workspaceId: workspace._id }).lean(),
      deps.overview.overview(workspace._id),
      deps.overview.translationCounts(workspace._id),
      deps.LocalizationAdminLog.find({ workspaceId: workspace._id }).sort({ createdAt: -1 }).limit(20).lean(),
    ]);
    const enabled = !!(flag && flag.arabicEnabled);
    const adminUser = getAdminUser(req);
    const token = csrfToken(adminUser, String(workspace._id));
    const t = summary.templates;
    const logRows = log.map((l) => `<tr><td>${esc(new Date(l.createdAt).toISOString())}</td><td>${esc(l.action)}</td><td>${esc(l.adminUser)}</td><td>${esc(l.notes)}</td></tr>`).join('')
      || '<tr><td colspan="4" class="muted">No changes yet.</td></tr>';

    res.send(layout(workspace.name, `
      ${killSwitchBanner()}
      <div class="card">
        <p>Arabic localisation: <span class="pill">${enabled ? 'enabled' : 'disabled'}</span></p>
        <p class="muted">${enabled && flag.arabicEnabledAt ? `Enabled ${esc(new Date(flag.arabicEnabledAt).toISOString())} by ${esc(flag.arabicEnabledBy)}. ` : ''}Notes: ${esc(flag && flag.notes)}</p>
        ${token ? `<form method="POST" action="${BASE}/${esc(workspace._id)}/toggle">
          <input type="hidden" name="csrf" value="${esc(token)}">
          <input type="hidden" name="enabled" value="${enabled ? 'false' : 'true'}">
          <div class="field"><label>Notes (optional, max ${MAX_NOTES})</label><input name="notes" maxlength="${MAX_NOTES}" value="${esc(flag && flag.notes)}"></div>
          <button type="submit">${enabled ? 'Disable' : 'Enable'} for this workspace</button>
        </form>` : '<p class="muted">Toggling is unavailable: INTERNAL_ADMIN_PASSWORD is not set on this server. Use scripts/localization-flag.js.</p>'}
      </div>
      <div class="card"><h3>Counts</h3>
        <p>Customers: ${summary.customers.total} (English ${summary.customers.en}, Arabic ${summary.customers.ar}, unknown ${summary.customers.unknown})</p>
        <p>Templates: ${t.total}, with Arabic ${t.withArabic} (approved ${t.arabicApproved}, pending ${t.arabicPending}, rejected ${t.arabicRejected}, not submitted ${t.arabicNotSubmitted}, other ${t.arabicOther})</p>
        <p>Product translations: ${translations.draft} draft, ${translations.reviewed} reviewed, ${translations.missing} missing</p>
        <p>Campaigns: ${summary.campaigns.total}${summary.campaigns.lastSentAt ? `, last sent ${esc(summary.campaigns.lastSentAt)}` : ''}</p>
        <p>Unreviewed: ${summary.review.templatesDraft} template variants, ${summary.review.catalogDraft} product translations</p>
      </div>
      <div class="card"><h3>Last changes</h3><table><tr><th>When (UTC)</th><th>Action</th><th>By</th><th>Notes</th></tr>${logRows}</table></div>
    `));
  }));

  router.post('/:workspaceId/toggle', page(async (req, res) => {
    const { workspaceId } = req.params;
    if (!isObjectIdLike(workspaceId)) return notFound(res);
    const body = req.body ?? {};
    const adminUser = getAdminUser(req);
    if (!csrfValid(adminUser, workspaceId, body.csrf)) {
      return res.status(403).send(layout('Request rejected', '<div class="card"><p>This form has expired or is invalid. Go back, reload the workspace page and try again.</p></div>'));
    }
    const workspace = await deps.Workspace.findById(workspaceId).select('_id').lean();
    if (!workspace) return notFound(res);

    const enabled = body.enabled === 'true';
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, MAX_NOTES) : undefined;
    // LOG BEFORE MUTATE (the shared/consent.js rule): the audit row is written first, so a flag
    // change can never exist without its trail. If the row cannot be written the flag is left
    // exactly as it was and the operator is told so.
    try {
      await deps.LocalizationAdminLog.create({
        workspaceId, action: enabled ? 'enable' : 'disable', adminUser, notes: notes || '', ip: req.adminIp,
      });
    } catch (err) {
      console.error('[admin-localization] audit log write failed - the flag was NOT changed:', err && err.message);
      return res.status(500).send(layout('Not changed', '<div class="card"><p>Nothing was changed: the audit log could not be written, so the Arabic flag was left as it was. Go back, reload the workspace page and try again.</p></div>'));
    }
    try {
      await deps.settings.setArabicEnabled({ workspaceId, enabled, grantedBy: adminUser, notes });
    } catch (err) {
      console.error('[admin-localization] flag change failed after its audit entry was written:', err && err.message);
      return res.status(500).send(layout('Not changed', '<div class="card"><p>The Arabic flag could not be changed. An audit entry for this attempt was already recorded, so check the current state on the workspace page before trying again.</p></div>'));
    }
    res.redirect(303, `${BASE}/${workspaceId}`);
  }));

  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
module.exports.esc = esc;
