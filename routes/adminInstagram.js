// Waflow-staff-only toggle for the Instagram Promotion Scheduler add-on —
// mounted at /internal-admin-instagram under middleware/requireInternalAdmin.js
// (same HTTP Basic Auth gate as the other internal-admin tools, imported not
// modified), on its own path prefix so mounting it is a single additive line.
const router = require('express').Router();
const mongoose = require('mongoose');
const Workspace = require('../models/Workspace');
const instagram = require('../shared/instagram');

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function getAdminUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return 'unknown';
  const [user] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return user || 'unknown';
}
function layout(title, body) {
  return `<!doctype html><html><head><title>${esc(title)} — Waflow Instagram Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;margin:0;padding:2rem}
  a{color:#4f8cff}
  .card{background:#151b23;padding:1.25rem;border-radius:10px;margin-bottom:1rem;max-width:720px}
  input,select{padding:.5rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box}
  button{padding:.5rem 1rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  .muted{color:#9aa4af;font-size:.8rem}
  .field{margin-bottom:.75rem}
  label{display:block;font-size:.8rem;color:#9aa4af;margin-bottom:.25rem}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:100px;font-size:.75rem;background:#243044}
</style></head><body>
<div class="muted"><a href="/internal-admin-instagram">&larr; Search</a></div>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

router.get('/', (req, res) => {
  res.send(layout('Instagram Scheduler Admin', `
    <div class="card">
      <form method="GET" action="/internal-admin-instagram/search">
        <div class="field"><label>Workspace name or ID</label><input type="text" name="q" required autofocus></div>
        <button type="submit">Search</button>
      </form>
    </div>
  `));
});

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/internal-admin-instagram');
  const filter = mongoose.isValidObjectId(q) ? { _id: q } : { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  const workspaces = await Workspace.find(filter).limit(50).lean();
  const rows = workspaces.map(w => `<li><a href="/internal-admin-instagram/${w._id}">${esc(w.name)}</a></li>`).join('') || '<li class="muted">No matches.</li>';
  res.send(layout('Search results', `<div class="card"><ul>${rows}</ul></div>`));
});

router.get('/:workspaceId', async (req, res) => {
  const workspace = await Workspace.findById(req.params.workspaceId).lean();
  if (!workspace) return res.status(404).send(layout('Not found', '<p>No workspace with that ID.</p>'));
  const ent = await instagram.getOrCreateEntitlement(workspace._id);
  const account = await instagram.getSocialAccountStatus(workspace._id);

  res.send(layout(workspace.name, `
    <div class="card">
      <p>Instagram Promotion Scheduler: <span class="pill">${ent.enabled ? 'enabled' : 'disabled'}</span></p>
      <p class="muted">Instagram account: ${esc(account.status)}${account.accountHandle ? ` (${esc(account.accountHandle)})` : ''}</p>
      <form method="POST" action="/internal-admin-instagram/${workspace._id}/toggle">
        <input type="hidden" name="enabled" value="${ent.enabled ? 'false' : 'true'}">
        <div class="field"><label>Notes (optional)</label><input name="notes" value="${esc(ent.notes || '')}"></div>
        <button type="submit">${ent.enabled ? 'Disable' : 'Enable'} for this workspace</button>
      </form>
    </div>
  `));
});

router.post('/:workspaceId/toggle', async (req, res) => {
  await instagram.setEntitlement({
    workspaceId: req.params.workspaceId, enabled: req.body.enabled === 'true',
    grantedBy: getAdminUser(req), notes: req.body.notes,
  });
  res.redirect(`/internal-admin-instagram/${req.params.workspaceId}`);
});

module.exports = router;
