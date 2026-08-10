// Small, concrete v1 breach/anomaly alerting — not a SIEM. Watches only the
// /internal-admin surface (the one place PII deletion/correction/search
// happens outside the normal per-workspace merchant app), reusing the same
// Resend email helper already used for magic-link/invite mail. Full log
// aggregation and merchant-side (non-admin-tool) anomaly detection are
// explicitly out of scope for v1 — see the Data Protection Compliance plan.
const { Resend } = require('resend');

const FROM = process.env.RESEND_FROM_EMAIL || 'Waflow <login@waflow.app>';
const ALERT_TO = process.env.SECURITY_ALERT_EMAIL;

let _resend = null;
function resend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY || 're_placeholder');
  return _resend;
}

async function sendAlert(subject, html) {
  if (!ALERT_TO) {
    console.warn('[breachAlert] SECURITY_ALERT_EMAIL not set — alert suppressed:', subject);
    return;
  }
  try {
    const { error } = await resend().emails.send({ from: FROM, to: ALERT_TO, subject: `[Waflow Security] ${subject}`, html });
    if (error) console.error('[breachAlert] send failed:', error.message || error);
  } catch (err) {
    console.error('[breachAlert] send failed:', err.message);
  }
}

// Sliding-window counters per IP, same Map-based shape as the brute-force
// guards in mcp/oauth.js and middleware/requireInternalAdmin.js.
const activityCounts = new Map(); // ip -> { count, windowStart }
const ACTIVITY_WINDOW_MS = 10 * 60 * 1000;
const ACTIVITY_THRESHOLD = 20;

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of activityCounts) if (now - rec.windowStart > ACTIVITY_WINDOW_MS) activityCounts.delete(ip);
}, 60 * 1000).unref();

// Called after every AdminAuditLog write. `type` distinguishes the trigger:
//  - 'bulk_activity': many search/view actions from one IP in a short window
//  - 'delete_customer': always alerts — sensitive, low volume, cheap to always notify
//  - 'admin_bruteforce' / 'admin_lockout': login-failure threshold crossed
function checkBreach({ type, ip, detail }) {
  if (type === 'delete_customer') {
    return sendAlert('Customer data deleted via internal admin tool', `<p>IP: ${ip}</p><p>Detail: ${JSON.stringify(detail || {})}</p>`);
  }
  if (type === 'admin_bruteforce' || type === 'admin_lockout') {
    return sendAlert('Repeated failed logins to /internal-admin', `<p>IP: ${ip}</p>`);
  }
  if (type === 'bulk_activity') {
    return sendAlert('Unusually high /internal-admin activity from one IP', `<p>IP: ${ip}</p><p>${JSON.stringify(detail || {})}</p>`);
  }
}

// Called after search/view_customer actions to detect bulk-scraping.
function trackActivity(ip) {
  const now = Date.now();
  const rec = activityCounts.get(ip);
  if (!rec || now - rec.windowStart > ACTIVITY_WINDOW_MS) {
    activityCounts.set(ip, { count: 1, windowStart: now });
    return;
  }
  rec.count++;
  if (rec.count === ACTIVITY_THRESHOLD) {
    checkBreach({ type: 'bulk_activity', ip, detail: { count: rec.count, windowMinutes: ACTIVITY_WINDOW_MS / 60000 } });
  }
}

module.exports = { checkBreach, trackActivity };
