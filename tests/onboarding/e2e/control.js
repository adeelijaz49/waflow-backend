'use strict';
// The CONTROL endpoint of the sandbox launcher (task I1b): a tiny HTTP server on its OWN port, in the same process as
// the real server.js, that lets browser / end-to-end tests flip the fake world: Graph scenarios, template statuses,
// display-name decisions, token revocation, signed Stripe and Meta webhooks, the scheduler sweep, e-mail failures,
// per-scenario env switches, call logs and DB counters. It is NEVER part of server.js and refuses to exist outside a
// sandbox (boot() already asserted the throwaway database and the dead proxy).
const http = require('http');
const fs = require('fs');
const { applyGraphOp } = require('./multiGraph');

const COLLECTIONS = ['OnboardingState', 'WhatsAppConnection', 'WhatsAppClaim', 'OnboardingEvent', 'OnboardingSupportRequest', 'OnboardingNotification',
  'OnboardingTemplate', 'OnboardingInbound', 'OnboardingAdminLog'];
const ENV_WHITELIST = ['ONBOARDING_LEGACY_SEND_POLICY', 'ONBOARDING_UNLOCK_AT', 'ONBOARDING_WEBHOOK_SIGNATURE', 'ONBOARDING_CHECKOUT', 'ONBOARDING_BILLING_PORTAL',
  'ONBOARDING_ACCEPT_TRIALING', 'ONBOARDING_SUPPORT_EMAIL', 'ONBOARDING_SUPPORT_WHATSAPP', 'ONBOARDING_BILLING_RECONCILE_ON_DEMAND', 'ONBOARDING_FLOW',
  'ONBOARDING_ENROL_FROM', 'ONBOARDING_STRIPE_PRICES', 'ONBOARDING_PLAN_LABELS', 'ONBOARDING_TEMPLATE_CEILING', 'META_PAYMENT_PROBE'];

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

/** Compact, JSON-safe view of the Graph call log (tokens are reported by KIND only, never by value). */
function compactGraphCall(c) {
  return { fake: c.fake, seq: c.seq, name: c.name, method: c.method, path: c.path, status: c.status, errorCode: c.errorCode, tokenKind: c.tokenKind, viaPaging: !!c.viaPaging, foreign: !!c.foreign, networkError: c.networkError };
}

/** Rebuild one fake per WhatsAppConnection of the database (so a launcher restart still talks to every seeded merchant). */
async function syncGraphFromDb(handle, graphState = {}, labels = {}) {
  const Conn = handle.model('WhatsAppConnection');
  const Template = handle.model('OnboardingTemplate');
  const vault = require('../../../shared/onboarding/tokenVault');
  const rows = await Conn.find({ 'ids.wabaId': { $exists: true } }).select('+tokenEncrypted').lean();
  const created = [];
  for (const row of rows) {
    const ws = String(row.workspaceId);
    const key = labels[ws] || `ws:${ws}`;
    if (handle.graph.get(key)) continue;
    let token = null;
    try { token = row.tokenEncrypted ? vault.decrypt(row.tokenEncrypted, { workspaceId: ws, purpose: 'token' }) : null; } catch (_) { token = null; }
    const opts = Object.assign({
      wabaId: row.ids.wabaId, phoneId: row.ids.phoneNumberId, businessId: row.ids.businessId || undefined,
      displayNumber: (row.display && row.display.displayPhoneNumber) || undefined, verifiedName: (row.display && row.display.verifiedName) || undefined,
    }, graphState[key] || {});
    if (token) opts.merchantToken = token;
    Object.keys(opts).forEach((k) => { if (opts[k] === undefined) delete opts[k]; });
    const scenarios = Array.isArray(opts.scenarios) ? opts.scenarios : [];
    delete opts.scenarios;
    const g = handle.graph.add(key, opts);
    scenarios.forEach((n) => { if (g.scenarios && typeof g.scenarios[n] === 'function') g.scenarios[n](); });
    const tpls = await Template.find({ workspaceId: ws, metaTemplateId: { $exists: true, $ne: null } }).lean();
    let maxId = Number(g.state.nextTemplateId);
    tpls.forEach((t, i) => {
      const id = String(t.metaTemplateId);
      if (/^\d+$/.test(id)) maxId = Math.max(maxId, Number(id) + 1);
      g.state.templates.push({
        id, name: t.metaTemplateName, language: t.language === 'ar' ? 'ar' : 'en', status: t.metaStatusRaw || t.metaStatus || 'PENDING', category: t.category || 'UTILITY',
        components: [{ type: 'BODY', text: 'x' }], quality_score: { score: 'UNKNOWN' }, rejected_reason: t.rejectedReason || undefined, createdSeq: i + 1,
      });
    });
    g.state.nextTemplateId = maxId;
    created.push(key);
  }
  return created;
}

function request(method, port, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: new http.Agent({ keepAlive: false }), headers: Object.assign({ 'content-type': 'application/json' }, headers || {}, data ? { 'content-length': Buffer.byteLength(data) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { json = null; }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * @param {object} handle the boot() result
 * @param {{appPort:number, seedFile?:string}} opts
 */
function createControlServer(handle, opts) {
  const { appPort } = opts;
  const labels = {};
  let graphState = {};
  let seed = null;
  try { if (opts.seedFile && fs.existsSync(opts.seedFile)) seed = JSON.parse(fs.readFileSync(opts.seedFile, 'utf8')); } catch (_) { seed = null; }
  if (seed) {
    graphState = seed.graph || {};
    Object.keys(seed.workspaces || {}).forEach((label) => { if (seed.workspaces[label] && seed.workspaces[label].id && !labels[String(seed.workspaces[label].id)]) labels[String(seed.workspaces[label].id)] = label; });
  }
  const send = (res, status, body) => { const text = JSON.stringify(body === undefined ? {} : body); res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(text); };

  async function deliverStripe(type, object, extra = {}) {
    const d = handle.stripe.signedEvent(Object.assign({ type, object }, extra));
    const r = await request('POST', appPort, '/stripe-billing-webhook', { body: d.body, headers: { 'stripe-signature': d.header } });
    return { status: r.status, body: r.json || r.text, eventId: d.event.id };
  }

  async function deliverMeta(payload, mode = 'valid') {
    const raw = JSON.stringify(payload);
    const headers = {};
    if (mode === 'valid') headers['x-hub-signature-256'] = `sha256=${require('crypto').createHmac('sha256', handle.env.appSecret).update(raw).digest('hex')}`;
    else if (mode === 'invalid') headers['x-hub-signature-256'] = `sha256=${'0'.repeat(64)}`;
    const r = await request('POST', appPort, '/webhook', { body: raw, headers });
    return { status: r.status, body: r.json || r.text };
  }

  const routes = {
    'GET /__control/health': async () => ({ sandbox: true, db: handle.db, flow: process.env.ONBOARDING_FLOW, policy: process.env.ONBOARDING_LEGACY_SEND_POLICY, graphFakes: [...handle.graph.fakes.keys()], target: handle.graph.targetKey }),
    'GET /__control/calls': async (q) => ({
      graph: handle.graph.calls().filter((c) => (!q.fake || c.fake === q.fake) && (!q.name || c.name === q.name)).map(compactGraphCall),
      platform: handle.graph.platformCalls.map((c) => ({ seq: c.seq, method: c.method, path: c.path, to: c.to ? String(c.to).replace(/\d(?=\d{4})/g, '*') : undefined, type: c.type })),
      stripe: handle.stripe.calls.map((c) => ({ seq: c.seq, method: c.method })),
      mail: handle.mail.sent.map((m) => ({ id: m.id, to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo })),
    }),
    'POST /__control/reset-logs': async () => { handle.graph.resetCalls(); handle.stripe.calls.length = 0; handle.mail.reset(); return { ok: true }; },
    'GET /__control/counters': async () => {
      const out = {};
      for (const name of COLLECTIONS) out[name] = await handle.model(name).countDocuments({});
      out.Workspace = await handle.model('Workspace').countDocuments({});
      out.Customer = await handle.model('Customer').countDocuments({});
      out.CampaignMessage = await handle.model('CampaignMessage').countDocuments({});
      return out;
    },
    'POST /__control/env': async (q, b) => {
      const applied = {};
      for (const [k, v] of Object.entries((b && b.set) || {})) {
        if (!ENV_WHITELIST.includes(k)) throw Object.assign(new Error(`env ${k} is not switchable`), { status: 400 });
        if (v === null) delete process.env[k]; else process.env[k] = String(v);
        applied[k] = v === null ? null : String(v);
      }
      require('../../../shared/onboarding/state').clearCache();
      return { ok: true, applied };
    },
    'POST /__control/clear-cache': async () => { require('../../../shared/onboarding/state').clearCache(); return { ok: true }; },
    'GET /__control/graph/ids': async (q) => {
      const g = handle.graph.get(q.fake || handle.graph.targetKey);
      if (!g) throw Object.assign(new Error('no such fake'), { status: 404 });
      const ph = g.state.phones[0] || {};
      return { fake: q.fake || handle.graph.targetKey, wabaId: g.ids.wabaId, phoneId: ph.id || g.ids.phoneId, businessId: g.ids.businessId, appId: g.ids.appId, displayNumber: ph.display_phone_number, templates: g.state.templates.length };
    },
    'POST /__control/graph': async (q, b) => {
      const g = handle.graph.get((b && b.fake) || handle.graph.targetKey);
      if (!g) throw Object.assign(new Error('no such fake'), { status: 404 });
      try { return applyGraphOp(g, b || {}); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    },
    'POST /__control/graph/new-target': async (q, b) => {
      const key = (b && b.key) || `target-${handle.graph.fakes.size + 1}`;
      const g = handle.graph.newTarget(key, (b && b.options) || {});
      const ph = g.state.phones[0] || {};
      return { key, wabaId: g.ids.wabaId, phoneId: ph.id || g.ids.phoneId, businessId: g.ids.businessId };
    },
    'POST /__control/graph/set-target': async (q, b) => { handle.graph.setTarget(b.key); return { ok: true, target: handle.graph.targetKey }; },
    'POST /__control/graph/sync': async () => ({ created: await syncGraphFromDb(handle, graphState, labels) }),
    'POST /__control/stripe/webhook': async (q, b) => deliverStripe(b.type, b.object || {}, b.extra || {}),
    'POST /__control/stripe/complete-checkout': async (q, b) => {
      // the customer finished Checkout: complete the session in the fake, then deliver the signed checkout.session.completed event
      const done = handle.stripe.completeCheckout(b.sessionId, b.options || {});
      const delivered = await deliverStripe('checkout.session.completed', done.session);
      return { session: { id: done.session.id, subscription: done.session.subscription }, delivered };
    },
    'POST /__control/stripe/subscription': async (q, b) => {
      // b: { subscriptionId, status, type? (customer.subscription.updated|deleted), invoice?: 'payment_failed'|'paid' }
      const sub = handle.stripe.getSubscription(b.subscriptionId);
      if (!sub) throw Object.assign(new Error('unknown subscription'), { status: 404 });
      const next = handle.stripe.setSubscription(Object.assign({}, sub, { status: b.status || sub.status }));
      if (b.invoice) {
        const inv = handle.stripe.makeInvoice({ subscription: next.id, customer: next.customer, status: b.invoice === 'paid' ? 'paid' : 'open', billingReason: 'subscription_cycle' });
        return deliverStripe(b.invoice === 'paid' ? 'invoice.paid' : 'invoice.payment_failed', inv);
      }
      return deliverStripe(b.type || 'customer.subscription.updated', next);
    },
    'POST /__control/meta-webhook': async (q, b) => deliverMeta(b.payload, b.signature || 'valid'),
    'POST /__control/mail': async (q, b) => { if (b && b.failNext) handle.mail.failNext(Number(b.failNext) || 1, Number(b.statusCode) || 503); return { ok: true }; },
    'POST /__control/sweep': async (q, b) => {
      const scheduler = require('../../../shared/onboarding/scheduler');
      return scheduler.runOnboardingSweep((b && b.deps) || undefined);
    },
    'POST /__control/mint': async (q, b) => {
      const jwt = require('jsonwebtoken');
      const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
      const token = jwt.sign({ sub: String(b.userId), workspaceId: String(b.workspaceId), role: b.role === 'member' ? 'member' : 'owner' }, JWT_SECRET, { expiresIn: b.expiresIn || '1d', issuer: ISSUER, audience: AUDIENCE });
      return { token };
    },
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const key = `${req.method} ${url.pathname}`;
      const fn = routes[key];
      if (!fn) return send(res, 404, { error: 'unknown control route', routes: Object.keys(routes) });
      let body = null;
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        body = text ? JSON.parse(text) : {};
      }
      const q = {};
      url.searchParams.forEach((v, k) => { q[k] = v; });
      return send(res, 200, clone(await fn(q, body)));
    } catch (e) {
      return send(res, (e && e.status) || 500, { error: (e && e.message) || 'control error' });
    }
  });
  return { server, syncGraphFromDb: () => syncGraphFromDb(handle, graphState, labels), request, deliverStripe, deliverMeta };
}

module.exports = { createControlServer, syncGraphFromDb, request, COLLECTIONS, ENV_WHITELIST };
