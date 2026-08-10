// Internal Waflow-staff-only tooling for Data Protection Compliance: look up
// a customer across all workspaces (not merchant-scoped — this is the
// operator, not a merchant), correct their PII, or anonymize it in response
// to a deletion request. Gated by middleware/requireInternalAdmin.js, mounted
// outside /api and outside the normal per-workspace requireAuth JWT path.
const router = require('express').Router();
const Customer = require('../models/Customer');
const Workspace = require('../models/Workspace');
const ConsentEvent = require('../models/ConsentEvent');
const Order = require('../models/Order');
const Booking = require('../models/Booking');
const AdminAuditLog = require('../models/AdminAuditLog');
const { trackActivity, checkBreach } = require('../utils/breachAlert');

function layout(title, body) {
  return `<!doctype html><html><head><title>${title} — Waflow Internal Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;margin:0;padding:2rem}
  a{color:#4f8cff}
  h1{font-size:1.2rem}
  .card{background:#151b23;padding:1.25rem;border-radius:10px;margin-bottom:1rem;max-width:720px}
  input,select{padding:.5rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box}
  button{padding:.5rem 1rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  button.danger{background:#e5484d}
  table{width:100%;border-collapse:collapse;margin-top:.5rem}
  td,th{text-align:left;padding:.4rem;border-bottom:1px solid #2a333d;font-size:.9rem}
  .muted{color:#9aa4af;font-size:.8rem}
  .warn{color:#ffcc66;font-size:.85rem}
  .field{margin-bottom:.75rem}
  label{display:block;font-size:.8rem;color:#9aa4af;margin-bottom:.25rem}
</style></head><body>
<div class="muted"><a href="/internal-admin">&larr; Search</a></div>
<h1>${title}</h1>
${body}
</body></html>`;
}

async function logAction(req, action, extra = {}) {
  await AdminAuditLog.create({ action, ip: req.adminIp, ...extra }).catch(() => {});
}

router.get('/', (req, res) => {
  res.send(layout('Waflow Internal Admin', `
    <div class="card">
      <form method="GET" action="/internal-admin/customers">
        <div class="field"><label>Phone or email</label><input type="text" name="q" required autofocus></div>
        <button type="submit">Search</button>
      </form>
    </div>
  `));
});

router.get('/customers', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/internal-admin');

  await logAction(req, 'search', { detail: { q } });
  trackActivity(req.adminIp);

  const isEmail = q.includes('@');
  const filter = isEmail ? { email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') } : { phone: new RegExp(q.replace(/\D/g, '')) };
  const customers = await Customer.find(filter).limit(50).lean();
  const workspaceIds = [...new Set(customers.map(c => String(c.workspaceId)))];
  const workspaces = await Workspace.find({ _id: { $in: workspaceIds } }, 'name').lean();
  const wsName = Object.fromEntries(workspaces.map(w => [String(w._id), w.name]));

  const rows = customers.map(c => `
    <tr>
      <td><a href="/internal-admin/customers/${c._id}">${c.firstname} ${c.lastname}</a>${c.deletedAt ? ' <span class="muted">(deleted)</span>' : ''}</td>
      <td>${c.phone}</td><td>${c.email || ''}</td><td>${wsName[String(c.workspaceId)] || c.workspaceId}</td>
    </tr>`).join('');

  res.send(layout('Search results', `
    <div class="card">
      <p class="muted">${customers.length} match${customers.length === 1 ? '' : 'es'} for "${q}"</p>
      <table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Workspace</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
  `));
});

router.get('/customers/:id', async (req, res) => {
  const customer = await Customer.findById(req.params.id).lean();
  if (!customer) return res.status(404).send(layout('Not found', '<p>No customer with that ID.</p>'));

  await logAction(req, 'view_customer', { targetCustomerId: customer._id, targetPhone: customer.phone, targetWorkspaceId: customer.workspaceId });
  trackActivity(req.adminIp);

  const workspace = await Workspace.findById(customer.workspaceId, 'name').lean();
  const [orderCount, bookingCount, events] = await Promise.all([
    Order.countDocuments({ customer: customer._id }),
    Booking.countDocuments({ customerId: customer._id }),
    ConsentEvent.find({ customerId: customer._id }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  const eventRows = events.map(e => `
    <tr><td>${new Date(e.createdAt).toLocaleString()}</td><td>${e.type}</td><td>${e.method}</td><td>${e.source || ''}</td></tr>
  `).join('') || '<tr><td colspan="4" class="muted">No consent events recorded.</td></tr>';

  res.send(layout(`${customer.firstname} ${customer.lastname}`, `
    <div class="card">
      <p class="muted">Workspace: ${workspace?.name || customer.workspaceId} ${customer.isDemo ? '· <strong>DEMO</strong>' : ''} ${customer.deletedAt ? '· <strong>DELETED</strong>' : ''}</p>
      <p>Orders: ${orderCount} · Bookings: ${bookingCount}</p>
      <p>Marketing consent: ${customer.marketingConsent ? `Yes (${customer.marketingConsentMethod || 'unknown'})` : 'No'} · Opted out: ${customer.optedOut ? 'Yes' : 'No'}</p>
    </div>

    <div class="card">
      <h2 style="font-size:1rem">Correct details</h2>
      <form method="POST" action="/internal-admin/customers/${customer._id}/correct">
        <div class="field"><label>First name</label><input name="firstname" value="${customer.firstname || ''}"></div>
        <div class="field"><label>Last name</label><input name="lastname" value="${customer.lastname || ''}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${customer.phone || ''}"></div>
        <div class="field"><label>Email</label><input name="email" value="${customer.email || ''}"></div>
        <div class="field"><label>Address</label><input name="address" value="${customer.address || ''}"></div>
        <button type="submit">Save correction</button>
      </form>
    </div>

    <div class="card">
      <h2 style="font-size:1rem">Consent / opt-out history</h2>
      <table><thead><tr><th>When</th><th>Type</th><th>Method</th><th>Source</th></tr></thead><tbody>${eventRows}</tbody></table>
    </div>

    ${!customer.deletedAt ? `
    <div class="card">
      <h2 style="font-size:1rem">Delete this customer's data</h2>
      <p class="warn">Anonymizes name/phone/email/address/notes on this record. Orders, bookings, and message-send history are kept for financial record-keeping — some of those already-existing records (e.g. delivery notifications) retain the original phone number, matching how this data is stored elsewhere in the app. This cannot be undone.</p>
      <form method="POST" action="/internal-admin/customers/${customer._id}/delete" onsubmit="return confirm('Anonymize this customer\\'s PII? This cannot be undone.');">
        <div class="field"><label>Reason</label><input name="reason" placeholder="e.g. customer data-deletion request"></div>
        <button type="submit" class="danger">Delete customer data</button>
      </form>
    </div>` : ''}
  `));
});

router.post('/customers/:id/correct', async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).send(layout('Not found', '<p>No customer with that ID.</p>'));

  const fields = ['firstname', 'lastname', 'phone', 'email', 'address'];
  const oldValues = {}, newValues = {};
  for (const f of fields) {
    if (req.body[f] !== undefined && req.body[f] !== customer[f]) {
      oldValues[f] = customer[f];
      newValues[f] = req.body[f];
      customer[f] = req.body[f];
    }
  }
  await customer.save();
  await logAction(req, 'correct_customer', {
    targetCustomerId: customer._id, targetPhone: customer.phone, targetWorkspaceId: customer.workspaceId,
    detail: { fieldsChanged: Object.keys(newValues), oldValues, newValues },
  });

  res.redirect(`/internal-admin/customers/${customer._id}`);
});

router.post('/customers/:id/delete', async (req, res) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return res.status(404).send(layout('Not found', '<p>No customer with that ID.</p>'));

  const targetPhone = customer.phone;
  customer.firstname = 'Deleted';
  customer.lastname = 'Customer';
  customer.phone = `deleted-${customer._id}`;
  customer.email = undefined;
  customer.address = undefined;
  customer.notes = undefined;
  customer.optedOut = true;
  customer.optedOutAt = new Date();
  customer.marketingConsent = false;
  customer.deletedAt = new Date();
  customer.deletionReason = req.body.reason || 'Data deletion request';
  await customer.save();

  await logAction(req, 'delete_customer', {
    targetCustomerId: customer._id, targetPhone, targetWorkspaceId: customer.workspaceId,
    detail: { reason: customer.deletionReason },
  });
  checkBreach({ type: 'delete_customer', ip: req.adminIp, detail: { customerId: String(customer._id) } });

  res.redirect(`/internal-admin/customers/${customer._id}`);
});

module.exports = router;
