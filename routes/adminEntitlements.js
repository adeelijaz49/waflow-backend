// Waflow-staff-only billing/entitlements admin tool — search a workspace,
// view its plan/usage/add-ons, and make manual adjustments (plan changes,
// entitlement overrides, credit grants, add-ons) with a full audit trail.
// Mounted at /internal-admin-billing under middleware/requireInternalAdmin.js
// (same HTTP Basic Auth gate as routes/internalAdmin.js, imported not
// modified) — deliberately a separate path prefix from that router so
// mounting this one is a single additive app.use() line in server.js.
const router = require('express').Router();
const mongoose = require('mongoose');

const Workspace   = require('../models/Workspace');
const Plan        = require('../models/Plan');
const AddOn        = require('../models/AddOn');
const CreditReservation = require('../models/CreditReservation');
const EntitlementAdjustment = require('../models/EntitlementAdjustment');
const entitlements = require('../shared/entitlements');
const rateCard = require('../shared/whatsappRateCard');

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// middleware/requireInternalAdmin.js exposes req.adminIp but not the
// username it already validated — re-decode the same Basic Auth header
// rather than modifying that shared middleware just for this.
function getAdminUser(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return 'unknown';
  const [user] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
  return user || 'unknown';
}

function layout(title, body) {
  return `<!doctype html><html><head><title>${esc(title)} — Waflow Billing Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body{font-family:system-ui,sans-serif;background:#0b0f14;color:#e6e6e6;margin:0;padding:2rem}
  a{color:#4f8cff}
  h1{font-size:1.2rem} h2{font-size:1rem}
  .card{background:#151b23;padding:1.25rem;border-radius:10px;margin-bottom:1rem;max-width:920px}
  input,select{padding:.5rem;border-radius:6px;border:1px solid #2a333d;background:#0b0f14;color:#e6e6e6;box-sizing:border-box}
  button{padding:.5rem 1rem;border-radius:6px;border:none;background:#4f8cff;color:#fff;font-weight:600;cursor:pointer}
  button.danger{background:#e5484d}
  table{width:100%;border-collapse:collapse;margin-top:.5rem}
  td,th{text-align:left;padding:.4rem;border-bottom:1px solid #2a333d;font-size:.9rem}
  .muted{color:#9aa4af;font-size:.8rem}
  .warn{color:#ffcc66;font-size:.85rem}
  .field{margin-bottom:.75rem}
  label{display:block;font-size:.8rem;color:#9aa4af;margin-bottom:.25rem}
  .row{display:flex;gap:1rem;flex-wrap:wrap}
  .bar{background:#0b0f14;border:1px solid #2a333d;border-radius:6px;height:10px;overflow:hidden;width:220px}
  .bar > div{height:100%;background:#4f8cff}
  .bar.warn90 > div, .bar.exceeded > div{background:#e5484d}
  .bar.warn75 > div{background:#ffcc66}
  .pill{display:inline-block;padding:.1rem .5rem;border-radius:100px;font-size:.75rem;background:#243044}
</style></head><body>
<div class="muted"><a href="/internal-admin-billing">&larr; Search</a></div>
<h1>${esc(title)}</h1>
${body}
</body></html>`;
}

async function logAdjustment({ workspaceId, adminUser, field, oldValue, newValue, reason }) {
  await EntitlementAdjustment.create({ workspaceId, adminUser, field, oldValue, newValue, reason }).catch(() => {});
}

// ─── Search ──────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.send(layout('Waflow Billing Admin', `
    <div class="card">
      <form method="GET" action="/internal-admin-billing/search">
        <div class="field"><label>Workspace name or ID</label><input type="text" name="q" required autofocus></div>
        <button type="submit">Search</button>
      </form>
    </div>
  `));
});

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.redirect('/internal-admin-billing');

  const filter = mongoose.isValidObjectId(q)
    ? { _id: q }
    : { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
  const workspaces = await Workspace.find(filter).limit(50).lean();

  const rows = workspaces.map(w => `<tr><td><a href="/internal-admin-billing/${w._id}">${esc(w.name)}</a></td><td class="muted">${w._id}</td></tr>`).join('')
    || '<tr><td colspan="2" class="muted">No matches.</td></tr>';

  res.send(layout('Search results', `<div class="card"><table><thead><tr><th>Workspace</th><th>ID</th></tr></thead><tbody>${rows}</tbody></table></div>`));
});

// ─── Rate card (must stay above /:workspaceId) ──────────────────────────────
router.get('/rate-card', async (req, res) => {
  const rates = await rateCard.listRates();
  const rows = rates.map(r => `
    <tr>
      <td>${esc(r.countryCode)}</td><td>${esc(r.messageCategory)}</td>
      <td>${r.providerCost} ${esc(r.currency)}</td><td>${r.customerCharge} ${esc(r.currency)}</td>
      <td class="muted">${new Date(r.effectiveFrom).toLocaleDateString()}${r.effectiveTo ? ` – ${new Date(r.effectiveTo).toLocaleDateString()}` : ' – current'}</td>
      <td class="muted">${esc(r.source || '')}</td>
    </tr>`).join('');

  res.send(layout('WhatsApp Rate Card', `
    <div class="card">
      <p class="muted">Adding a new rate for a country+category closes out whichever row is currently in effect for that pair — historical campaign costs never change retroactively.</p>
      <table><thead><tr><th>Country</th><th>Category</th><th>Provider Cost</th><th>Customer Charge</th><th>Effective</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table>
    </div>
    <div class="card">
      <h2>Add rate version</h2>
      <form method="POST" action="/internal-admin-billing/rate-card">
        <div class="row">
          <div class="field"><label>Country code (or * for default)</label><input name="countryCode" placeholder="SA" required></div>
          <div class="field"><label>Category</label>
            <select name="messageCategory">
              <option value="marketing">marketing</option><option value="utility">utility</option>
              <option value="authentication">authentication</option><option value="service">service</option>
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>Provider cost (Meta's actual cost)</label><input type="number" step="0.0001" name="providerCost" required></div>
          <div class="field"><label>Customer charge (deducted from merchant credit)</label><input type="number" step="0.0001" name="customerCharge" required></div>
          <div class="field"><label>Currency</label><input name="currency" placeholder="SAR" required></div>
        </div>
        <div class="field"><label>Source note</label><input name="source" placeholder="e.g. Meta Q2 2026 published rate"></div>
        <button type="submit">Add rate version</button>
      </form>
    </div>
  `));
});

router.post('/rate-card', async (req, res) => {
  const { countryCode, messageCategory, providerCost, customerCharge, currency, source } = req.body;
  if (!countryCode?.trim() || !currency?.trim() || providerCost === undefined || customerCharge === undefined) {
    return res.status(400).send(layout('Missing fields', '<p>Country code, currency, provider cost and customer charge are all required.</p>'));
  }
  try {
    await rateCard.addRateVersion({
      countryCode: countryCode.trim(), messageCategory,
      providerCost: +providerCost, customerCharge: +customerCharge,
      currency: currency.trim().toUpperCase(), source: source || 'manual_admin_entry',
    });
  } catch (err) {
    return res.status(400).send(layout('Could not add rate', `<p>${esc(err.message)}</p>`));
  }
  res.redirect('/internal-admin-billing/rate-card');
});

// ─── Workspace detail ────────────────────────────────────────────────────────
router.get('/:workspaceId', async (req, res) => {
  const workspace = await Workspace.findById(req.params.workspaceId).lean();
  if (!workspace) return res.status(404).send(layout('Not found', '<p>No workspace with that ID.</p>'));

  const [summary, plans, addOns, reservations, adjustments] = await Promise.all([
    entitlements.getUsageSummary(workspace._id),
    Plan.find({ active: true }).sort({ priceMonthly: 1 }).lean(),
    AddOn.find({ workspaceId: workspace._id }).sort({ createdAt: -1 }).lean(),
    CreditReservation.find({ workspaceId: workspace._id }).sort({ createdAt: -1 }).limit(20).lean(),
    EntitlementAdjustment.find({ workspaceId: workspace._id }).sort({ createdAt: -1 }).limit(30).lean(),
  ]);

  const usageRows = summary.usage.map(u => `
    <tr>
      <td>${esc(u.label)}</td>
      <td><div class="bar ${u.warningLevel || ''}"><div style="width:${u.percentUsed}%"></div></div></td>
      <td>${u.kind === 'cycle_currency' ? `${u.used.toFixed(2)} / ${u.limit.toFixed(2)} ${esc(u.currency)}` : `${u.used} / ${u.limit}`}</td>
      <td class="muted">${u.warningLevel || ''}</td>
    </tr>`).join('');

  const addOnRows = addOns.map(a => `
    <tr>
      <td>${esc(entitlements.LABELS[a.type] || a.type)}</td><td>${a.quantity}</td>
      <td><span class="pill">${esc(a.status)}</span></td>
      <td class="muted">${a.expiresAt ? new Date(a.expiresAt).toLocaleDateString() : 'no expiry'}</td>
      <td>
        <form method="POST" action="/internal-admin-billing/${workspace._id}/addon/${a._id}/status" style="display:inline">
          <select name="status" onchange="this.form.submit()">
            ${['pending_payment', 'active', 'expired', 'cancelled', 'failed'].map(s => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </form>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="muted">No add-ons.</td></tr>';

  const reservationRows = reservations.map(r => `
    <tr><td class="muted">${new Date(r.createdAt).toLocaleString()}</td><td>${r.recipientCount}</td>
      <td>${r.estimatedCost} ${esc(r.currency)}</td><td>${r.actualCost != null ? `${r.actualCost} ${esc(r.currency)}` : '—'}</td>
      <td><span class="pill">${esc(r.status)}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No reservations yet.</td></tr>';

  const adjustmentRows = adjustments.map(a => `
    <tr><td class="muted">${new Date(a.createdAt).toLocaleString()}</td><td>${esc(a.adminUser)}</td><td>${esc(a.field)}</td>
      <td class="muted">${esc(JSON.stringify(a.oldValue))} → ${esc(JSON.stringify(a.newValue))}</td><td class="muted">${esc(a.reason)}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">No manual adjustments recorded.</td></tr>';

  res.send(layout(workspace.name, `
    <div class="card">
      <p><strong>Plan:</strong> ${esc(summary.plan.name)} (${esc(summary.plan.code)})${summary.plan.isCustom ? ' <span class="pill">custom</span>' : ''}
      &nbsp; <strong>Status:</strong> <span class="pill">${esc(summary.subscription.status)}</span>
      &nbsp; <strong>Billing:</strong> ${esc(summary.subscription.billingProvider)}
      &nbsp; <strong>Overage billing:</strong> ${summary.subscription.overageBillingEnabled ? 'enabled' : 'disabled'}</p>
      <p class="muted">Cycle: ${new Date(summary.billingPeriod.start).toLocaleDateString()} – ${new Date(summary.billingPeriod.end).toLocaleDateString()} (${summary.billingPeriod.daysRemaining} days left)</p>
      <form method="POST" action="/internal-admin-billing/${workspace._id}/overage" style="display:inline">
        <input type="hidden" name="enabled" value="${summary.subscription.overageBillingEnabled ? 'false' : 'true'}">
        <button type="submit">${summary.subscription.overageBillingEnabled ? 'Disable' : 'Enable'} overage billing</button>
      </form>
    </div>

    <div class="card">
      <h2>Usage this cycle</h2>
      <table><thead><tr><th>Dimension</th><th>Usage</th><th>Used / Limit</th><th>Warning</th></tr></thead><tbody>${usageRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Change plan</h2>
      <form method="POST" action="/internal-admin-billing/${workspace._id}/plan">
        <div class="row">
          <div class="field"><label>Plan</label>
            <select name="planId">${plans.map(p => `<option value="${p._id}" ${p.code === summary.plan.code ? 'selected' : ''}>${esc(p.name)} (${esc(p.code)})</option>`).join('')}</select>
          </div>
          <div class="field"><label>Reason</label><input name="reason" placeholder="e.g. upgraded to Growth" required></div>
        </div>
        <button type="submit">Change plan</button>
      </form>
    </div>

    <div class="card">
      <h2>Entitlement overrides</h2>
      <p class="muted">Set a custom limit for one dimension (e.g. a founding-merchant deal). Leave blank and submit to clear an existing override back to the plan default.</p>
      <form method="POST" action="/internal-admin-billing/${workspace._id}/override">
        <div class="row">
          <div class="field"><label>Dimension</label>
            <select name="field">${entitlements.ENTITLEMENT_KEYS.map(k => `<option value="${k}">${esc(entitlements.LABELS[k])}</option>`).join('')}</select>
          </div>
          <div class="field"><label>New limit (blank clears override)</label><input type="number" name="value"></div>
        </div>
        <div class="field"><label>Reason</label><input name="reason" placeholder="e.g. founding merchant deal" required></div>
        <button type="submit">Apply override</button>
      </form>
    </div>

    <div class="card">
      <h2>Add-ons</h2>
      <table><thead><tr><th>Type</th><th>Qty</th><th>Status</th><th>Expires</th><th>Change status</th></tr></thead><tbody>${addOnRows}</tbody></table>
      <h2 style="margin-top:1rem">Add a new add-on</h2>
      <form method="POST" action="/internal-admin-billing/${workspace._id}/addon">
        <div class="row">
          <div class="field"><label>Type</label>
            <select name="type">${entitlements.ENTITLEMENT_KEYS.map(k => `<option value="${k}">${esc(entitlements.LABELS[k])}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Quantity</label><input type="number" name="quantity" required></div>
          <div class="field"><label>Status</label>
            <select name="status"><option value="active">active</option><option value="pending_payment">pending_payment</option></select>
          </div>
          <div class="field"><label>Expires (optional)</label><input type="date" name="expiresAt"></div>
        </div>
        <div class="field"><label>Notes / reason</label><input name="reason" placeholder="e.g. manual add-on purchase" required></div>
        <button type="submit">Add add-on</button>
      </form>
    </div>

    <div class="card">
      <h2>Grant bonus WhatsApp credit</h2>
      <form method="POST" action="/internal-admin-billing/${workspace._id}/credit-grant">
        <div class="row">
          <div class="field"><label>Amount (${esc(summary.currency)})</label><input type="number" step="0.01" name="amount" required></div>
          <div class="field"><label>Expires (optional — blank = persists every cycle)</label><input type="date" name="expiresAt"></div>
        </div>
        <div class="field"><label>Reason</label><input name="reason" placeholder="e.g. goodwill credit for a delivery incident" required></div>
        <button type="submit">Grant credit</button>
      </form>
    </div>

    <div class="card">
      <h2>Recent credit reservations</h2>
      <table><thead><tr><th>When</th><th>Recipients</th><th>Estimated</th><th>Actual</th><th>Status</th></tr></thead><tbody>${reservationRows}</tbody></table>
    </div>

    <div class="card">
      <h2>Adjustment audit trail</h2>
      <table><thead><tr><th>When</th><th>Admin</th><th>Field</th><th>Change</th><th>Reason</th></tr></thead><tbody>${adjustmentRows}</tbody></table>
    </div>
  `));
});

router.post('/:workspaceId/overage', async (req, res) => {
  const { workspaceId } = req.params;
  const enabled = req.body.enabled === 'true';
  const sub = await entitlements.getOrCreateSubscription(workspaceId);
  const oldValue = sub.overageBillingEnabled;
  sub.overageBillingEnabled = enabled;
  await sub.save();
  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: 'overageBillingEnabled', oldValue, newValue: enabled, reason: enabled ? 'Enabled via admin toggle' : 'Disabled via admin toggle' });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

router.post('/:workspaceId/plan', async (req, res) => {
  const { workspaceId } = req.params;
  const { planId, reason } = req.body;

  // Plan is only a Mongoose `ref` (a populate hint, never a foreign-key
  // constraint) — a dangling planId would otherwise save successfully and
  // then null-dereference every later entitlements read for this workspace.
  const newPlan = await Plan.findById(planId).lean();
  if (!newPlan) return res.status(400).send(layout('Invalid plan', '<p>No plan with that ID exists.</p>'));

  const sub = await entitlements.getOrCreateSubscription(workspaceId);
  const oldPlan = await Plan.findById(sub.planId).lean();
  sub.planId = planId;
  await sub.save();
  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: 'plan', oldValue: oldPlan?.code, newValue: newPlan.code, reason });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

router.post('/:workspaceId/override', async (req, res) => {
  const { workspaceId } = req.params;
  const { field, value, reason } = req.body;
  if (!entitlements.ENTITLEMENT_KEYS.includes(field)) return res.status(400).send(layout('Invalid field', '<p>Unknown entitlement dimension.</p>'));

  let newValue;
  if (value === '' || value === undefined) {
    newValue = undefined; // clears the override back to the plan default
  } else {
    newValue = +value;
    if (Number.isNaN(newValue)) return res.status(400).send(layout('Invalid value', '<p>Override value must be a number, or blank to clear it.</p>'));
  }

  const sub = await entitlements.getOrCreateSubscription(workspaceId);
  const oldValue = sub.overrides?.[field] ?? null;
  sub.overrides = sub.overrides || {};
  sub.overrides[field] = newValue;
  sub.markModified('overrides');
  await sub.save();

  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: `overrides.${field}`, oldValue, newValue: newValue ?? null, reason });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

router.post('/:workspaceId/addon', async (req, res) => {
  const { workspaceId } = req.params;
  const { type, quantity, status, expiresAt, reason } = req.body;
  if (!entitlements.ENTITLEMENT_KEYS.includes(type)) return res.status(400).send(layout('Invalid type', '<p>Unknown entitlement dimension.</p>'));
  const qty = +quantity;
  if (!quantity || Number.isNaN(qty)) return res.status(400).send(layout('Invalid quantity', '<p>Quantity must be a number.</p>'));

  const addOn = await AddOn.create({
    workspaceId, type, quantity: qty, status,
    activatedAt: status === 'active' ? new Date() : undefined,
    expiresAt: expiresAt ? new Date(expiresAt) : undefined,
    source: 'manual', notes: reason,
  });
  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: `addOn:${addOn._id}`, oldValue: null, newValue: { type, quantity: qty, status }, reason });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

router.post('/:workspaceId/addon/:addonId/status', async (req, res) => {
  const { workspaceId, addonId } = req.params;
  const addOn = await AddOn.findOne({ _id: addonId, workspaceId });
  if (!addOn) return res.status(404).send(layout('Not found', '<p>Add-on not found.</p>'));

  const oldStatus = addOn.status;
  addOn.status = req.body.status;
  if (addOn.status === 'active' && !addOn.activatedAt) addOn.activatedAt = new Date();
  await addOn.save();
  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: `addOn:${addOn._id}.status`, oldValue: oldStatus, newValue: addOn.status, reason: 'Status changed via admin tool' });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

// Modeled as a manual whatsappCreditPerCycle AddOn — reuses the same
// limit-contribution machinery (shared/entitlements.js#resolveEntitlements)
// instead of inventing a second, parallel "credit balance" concept.
router.post('/:workspaceId/credit-grant', async (req, res) => {
  const { workspaceId } = req.params;
  const { amount, expiresAt, reason } = req.body;
  const amt = +amount;
  if (!amount || Number.isNaN(amt)) return res.status(400).send(layout('Invalid amount', '<p>Amount must be a number.</p>'));

  const addOn = await AddOn.create({
    workspaceId, type: 'whatsappCreditPerCycle', quantity: amt, status: 'active', activatedAt: new Date(),
    expiresAt: expiresAt ? new Date(expiresAt) : undefined, source: 'manual', notes: `Credit grant: ${reason}`,
  });
  await logAdjustment({ workspaceId, adminUser: getAdminUser(req), field: 'creditGrant', oldValue: null, newValue: amt, reason });
  res.redirect(`/internal-admin-billing/${workspaceId}`);
});

module.exports = router;
