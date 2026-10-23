'use strict';
// SANDBOX-ONLY contract dump (task I1b): seeds a fresh throwaway database (seed.js), then calls every GET endpoint of
// the onboarding API and the key POST answers for each seeded workspace against the REAL server.js (fakes only) and
// writes the JSON BODIES to <out>/<workspace>-<endpoint>.json. The frontend contract check consumes them.
// <out>/_index.json lists every file with method, path, request body (secret-free) and HTTP status.
// After writing, the script scans every file for secrets (tokens, app secret, codes, PINs, JWTs, vault envelopes,
// login phone numbers) and exits non-zero when it finds one.
//
//   node tests/onboarding/e2e/dump-contract.js            (from a SANDBOX copy; fresh waflow_loc_test_* database)
//   E2E_CONTRACT_DIR=<dir>                                 output directory (default: <os tmp>/waflow-onboarding-e2e/contract-samples)
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { boot } = require('./boot');
const { seed } = require('./seed');

const DEFAULT_DIR = path.join(require('os').tmpdir(), 'waflow-onboarding-e2e', 'contract-samples');
const flat = (s) => Object.assign({ event: s.event }, s.data);

/** Strings that must never appear in a sample (collected from the live fakes and the seeded users). */
function secretsOf(handle, result) {
  const secrets = new Set();
  secrets.add(handle.graph.platformToken);
  secrets.add(handle.env.appSecret);
  secrets.add(handle.env.jwtSecret);
  secrets.add(handle.env.stripeWebhookSecret);
  secrets.add(process.env.WA_TOKEN_ENCRYPTION_KEY);
  for (const g of handle.graph.fakes.values()) {
    secrets.add(g.ids.merchantToken);
    g.state.phones.forEach((p) => { if (p.pin) secrets.add(String(p.pin)); });
  }
  for (const w of Object.values(result.workspaces)) {
    [w.owner, w.member].filter(Boolean).forEach((u) => { secrets.add(u.token); secrets.add(u.phone); });
  }
  return [...secrets].filter((s) => typeof s === 'string' && s.length >= 6);
}

/** Scan text for the secrets above plus generic secret shapes. Returns a list of findings (no secret values). */
function scanText(file, text, secrets) {
  const hits = [];
  secrets.forEach((s, i) => { if (text.includes(s)) hits.push(`${file}: contains secret #${i} (len ${s.length})`); });
  if (/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text)) hits.push(`${file}: looks like a JWT`);
  if (/v1:[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=]{8,}/.test(text)) hits.push(`${file}: looks like a vault envelope`);
  if (/\bEAA[A-Za-z0-9_]{20,}/.test(text)) hits.push(`${file}: looks like a Meta access token`);
  if (/\b(sk|rk|whsec)_[A-Za-z0-9_]{8,}/.test(text)) hits.push(`${file}: looks like a Stripe secret`);
  if (/AQD[A-Za-z0-9]{6,}SECRET/.test(text)) hits.push(`${file}: contains an authorization code`);
  return hits;
}

/** The request body as recorded in _index.json: authorization codes, confirmation tokens, sessions and phone numbers are dropped. */
function redactRequest(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  Object.keys(body).forEach((k) => { out[k] = ['code', 'confirmationToken', 'session', 'phone', 'to'].includes(k) ? '[omitted]' : body[k]; });
  return out;
}

async function main() {
  const handle = await boot({ policy: process.env.E2E_POLICY || 'block' });
  const outDir = process.env.E2E_CONTRACT_DIR || DEFAULT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const result = await seed(handle);
  const W = result.workspaces;
  const agent = request(handle.app);
  const index = [];

  async function rec(label, name, method, url, token, body) {
    let r = agent[method](url);
    if (token) r = r.set('Authorization', `Bearer ${token}`);
    if (body !== undefined && method !== 'get') r = r.send(body);
    const res = await r;
    // a completed connect starts the immediate starter-template submission in the background: later samples come from a settled world
    if (url.endsWith('/connect/complete') || url.endsWith('/connect/resume')) await require('../../../shared/onboarding/connect')._internal.idle();
    const file = `${label}-${name}.json`;
    const payload = res.body && Object.keys(res.body).length ? res.body : (res.text ? { _text: res.text.slice(0, 500) } : {});
    fs.writeFileSync(path.join(outDir, file), `${JSON.stringify(payload, null, 2)}\n`);
    index.push({ file, workspace: label, method: method.toUpperCase(), path: url, request: body === undefined ? undefined : redactRequest(body), status: res.status });
    return res;
  }
  const O = (label) => (W[label].owner || W[label].member).token;
  const api = (label, name, method, url, body, token) => rec(label, name, method, `/api/onboarding${url}`, token || O(label), body);

  // ---- every GET for every seeded workspace (read samples first: nothing below has changed any state yet) ------
  const GETS = [['state', '/state'], ['connection', '/connection'], ['approvals', '/approvals'], ['templates', '/templates'], ['first-promotion', '/first-promotion'],
    ['notifications', '/notifications'], ['help-context', '/help-context'], ['connect-config', '/connect/config']];
  for (const label of Object.keys(W)) {
    for (const [name, url] of GETS) await api(label, name, 'get', url);
  }

  // ---- W3: the whole happy path through the API with a sample after every step --------------------------------------
  await api('W3', 'state-after-0-start', 'get', '/state');
  await api('W3', 'business-invalid', 'put', '/business', { name: 'x', country: 'ZZ', industry: 'nope' });
  await api('W3', 'business', 'put', '/business', { name: 'E2E W3 Shop', country: 'SA', industry: 'fashion', instagram: '@w3shop', contactEmail: 'w3-owner@example.test' });
  await api('W3', 'number-path-invalid', 'post', '/number/path', { hasNumber: 'maybe' });
  await api('W3', 'number-path-B', 'post', '/number/path', { hasNumber: false });
  await api('W3', 'state-after-number-B', 'get', '/state');
  await api('W3', 'number-ready', 'post', '/number/ready', {});
  await api('W3', 'number-support-request', 'post', '/number/support-request', { message: 'I need help getting a number' });
  await api('W3', 'help-context-after-support', 'get', '/help-context');
  await api('W3', 'number-path-personal-unacknowledged', 'post', '/number/path', { hasNumber: true, usage: 'personal' });
  await api('W3', 'number-path-personal', 'post', '/number/path', { hasNumber: true, usage: 'personal', acknowledgeRemoval: true });
  await api('W3', 'number-path-business-app-migrate', 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'migrate' });
  await api('W3', 'number-path-business-app-coexistence', 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'coexistence' });
  await api('W3', 'number-path-business-app-different-number', 'post', '/number/path', { hasNumber: true, usage: 'business_app', businessAppChoice: 'different_number' });
  await api('W3', 'number-path-landline', 'post', '/number/path', { hasNumber: true, usage: 'landline' });
  await api('W3', 'number-path-unused', 'post', '/number/path', { hasNumber: true, usage: 'unused' });
  await api('W3', 'state-after-2-number', 'get', '/state');
  const cfg = await api('W3', 'connect-config-ready', 'get', '/connect/config');
  const attemptId = cfg.body.attemptId;
  await api('W3', 'connect-event-cancel', 'post', '/connect/event', { attemptId, event: 'CANCEL', currentStep: 'PHONE_NUMBER_SETUP' });
  await api('W3', 'connect-event-error', 'post', '/connect/event', { attemptId, event: 'ERROR', errorCode: '3441030', errorMessage: 'Something went wrong' });
  await api('W3', 'connect-event-no-facebook', 'post', '/connect/event', { attemptId, event: 'NO_FACEBOOK' });
  const g3 = handle.graph.newTarget('W3', { displayNumber: '+966 55 933 4567', verifiedName: 'E2E W3 Shop' });
  g3.scenarios.codeExpired();
  await api('W3', 'connect-complete-code-expired', 'post', '/connect/complete', { attemptId, code: 'AQDcontractW3codeOneSECRETvalue1', session: flat(g3.session('FINISH')) });
  g3.scenarios.register133016();
  g3.setPhone({ status: 'PENDING' });
  await api('W3', 'connect-complete-partial', 'post', '/connect/complete', { attemptId, code: 'AQDcontractW3codeTwoSECRETvalue2', session: flat(g3.session('FINISH')) });
  await api('W3', 'state-partial-connect', 'get', '/state');
  await api('W3', 'connection-partial', 'get', '/connection');
  await api('W3', 'connect-resume', 'post', '/connect/resume', {});
  await api('W3', 'connect-complete-replay', 'post', '/connect/complete', { attemptId, code: 'AQDcontractW3codeTwoSECRETvalue2', session: flat(g3.session('FINISH')) });
  await api('W3', 'state-after-3-connect', 'get', '/state');
  await api('W3', 'connection-after-connect', 'get', '/connection');
  await api('W3', 'approvals-after-connect', 'get', '/approvals');
  await api('W3', 'templates-after-connect', 'get', '/templates');
  await api('W3', 'templates-submit', 'post', '/templates/submit', {});
  await api('W3', 'first-promotion-no-template', 'get', '/first-promotion');
  await api('W3', 'test-message-no-template', 'post', '/test-message', {});
  await api('W3', 'prompts-customers-nothing-added', 'post', '/prompts/customers', { state: 'done' });
  await api('W3', 'prompts-customers-skipped', 'post', '/prompts/customers', { state: 'skipped' });
  await api('W3', 'prompts-products-skipped', 'post', '/prompts/products', { state: 'skipped' });
  await api('W3', 'events', 'post', '/events', { type: 'step_enter', step: 'business' });
  await api('W3', 'preferences', 'post', '/preferences', { uiLanguage: 'ar', languages: ['ar', 'en'] });
  await api('W3', 'notifications-after', 'get', '/notifications');
  await api('W3', 'notifications-read', 'post', '/notifications/read', { all: true });
  await api('W3', 'state-after-5-prompts', 'get', '/state');

  // ---- W5: connected workspace, approvals mixed: refresh, payment, display name, test message, first promotion --------
  await api('W5', 'connection-refresh', 'post', '/connection/refresh', {});
  await api('W5', 'approvals-payment-confirmed', 'post', '/approvals/payment-confirmed', { confirmed: true });
  await api('W5', 'approvals-after-payment', 'get', '/approvals');
  await api('W5', 'display-name', 'post', '/display-name', { newName: 'E2E Mixed Shop Official' });
  await api('W5', 'display-name-invalid', 'post', '/display-name', { newName: 'x' });
  await api('W5', 'test-message', 'post', '/test-message', {});
  await api('W5', 'test-message-second-number', 'post', '/test-message', { phone: '+966555000777' });
  await api('W5', 'test-message-third-number', 'post', '/test-message', { phone: '+966555000888' });
  await api('W5', 'first-promotion-after-test', 'get', '/first-promotion');
  await api('W5', 'first-promotion-state-done', 'post', '/first-promotion/state', { state: 'done' });
  await api('W5', 'first-promotion-state-skipped', 'post', '/first-promotion/state', { state: 'skipped' });
  await api('W5', 'templates-resubmit', 'post', '/templates/booking_confirmation/en/resubmit', {});
  await api('W5', 'connection-disconnect-request', 'post', '/connection/disconnect/request', {});
  await api('W5', 'prompts-customers-done', 'post', '/prompts/customers', { state: 'done' });
  await api('W5', 'state-after-actions', 'get', '/state');
  // member (W10) of W5: the same read, owner-only refusals
  await api('W10', 'checkout-owner-only', 'post', '/checkout', { planCode: 'basic' });
  await api('W10', 'connect-complete-owner-only', 'post', '/connect/complete', { attemptId: 'x', code: 'y', session: {} });
  await api('W10', 'disconnect-owner-only', 'post', '/connection/disconnect', { confirmationToken: 'x', confirmText: 'DISCONNECT' });

  // ---- W6 reconnect --------------------------------------------------------------------------------------------------
  await api('W6', 'connection-reconnect', 'post', '/connection/reconnect', {});

  // ---- billing: W1 (none), W2 (pending), W7 (past_due), W8 (cancelled) -----------------------------------------------
  await api('W1', 'checkout-unknown-plan', 'post', '/checkout', { planCode: 'does-not-exist' });
  await api('W1', 'billing-portal-unavailable', 'post', '/billing-portal', {});
  await api('W1', 'billing-refresh', 'post', '/billing/refresh', {});
  await api('W1', 'billing-refresh-too-soon', 'post', '/billing/refresh', {});
  await api('W1', 'checkout', 'post', '/checkout', { planCode: 'basic' });
  await api('W1', 'state-after-checkout', 'get', '/state');
  await api('W2', 'billing-refresh', 'post', '/billing/refresh', {});
  await api('W2', 'checkout-again', 'post', '/checkout', { planCode: 'pro' });
  await api('W7', 'business-write-refused', 'put', '/business', { name: 'Changed Name' });
  await api('W7', 'checkout-subscription-exists', 'post', '/checkout', { planCode: 'basic' });
  await api('W7', 'billing-portal', 'post', '/billing-portal', {});
  await api('W7', 'billing-refresh', 'post', '/billing/refresh', {});
  await api('W8', 'business-write-refused', 'put', '/business', { name: 'Changed Name' });
  await api('W8', 'billing-portal', 'post', '/billing-portal', {});
  await api('W8', 'connection-refresh-refused', 'post', '/connection/refresh', {});

  // ---- legacy workspaces: every onboarding route is "not available" ----------------------------------------------------
  await api('W0', 'checkout-not-available', 'post', '/checkout', { planCode: 'basic' });
  await api('W0', 'business-not-available', 'put', '/business', { name: 'x' });
  await api('W0b', 'connect-config-not-available', 'get', '/connect/config');
  await api('W0', 'no-token', 'get', '/state', undefined, 'not-a-token');

  fs.writeFileSync(path.join(outDir, '_index.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), db: handle.db, count: index.length, files: index }, null, 2)}\n`);

  // ---- secret scan over every written file ---------------------------------------------------------------------------
  const secrets = secretsOf(handle, result);
  const findings = [];
  for (const f of fs.readdirSync(outDir).filter((x) => x.endsWith('.json'))) {
    findings.push(...scanText(f, fs.readFileSync(path.join(outDir, f), 'utf8'), secrets));
  }
  console.log(`[dump-contract] ${index.length} samples written to ${outDir}; secrets scanned: ${secrets.length}; findings: ${findings.length}`);
  findings.forEach((f) => console.error(`[dump-contract] SECRET FINDING ${f}`));
  const statuses = {};
  index.forEach((i) => { statuses[i.status] = (statuses[i.status] || 0) + 1; });
  console.log('[dump-contract] statuses', JSON.stringify(statuses));
  await handle.stop();
  process.exit(findings.length ? 2 : 0);
}

if (require.main === module) {
  main().catch((err) => { console.error('[dump-contract] failed:', err && err.stack || err); process.exit(1); });
}

module.exports = { main, scanText, secretsOf, DEFAULT_DIR };
