'use strict';
// DB design 4.6 drift protection. Walks the Express 5 router stack of the REAL app and fails when a
// non-GET /api route is neither (a) in the send/connect table (shared/onboarding/sendRoutes.js),
// (b) on the explicit "other mutation, not sending" list below, nor (c) under /api/onboarding.
// Adding a new mutating /api route therefore forces a decision: does it send?
//
// Runs ONLY in the throwaway sandbox (requiring server.js loads dotenv); mongoose.connect is stubbed so
// no connection is made by this file at all. In a plain unit run it is skipped.
const SANDBOX = /^mongodb:\/\/127\.0\.0\.1:27099\/waflow_loc_test/.test(process.env.MONGODB_URI || '');
const maybe = SANDBOX ? describe : describe.skip;

// Mutating /api routes that do NOT send a WhatsApp message and are not a connect/publish route.
// Pattern = method + path with ":param" kept verbatim as written in the route files.
const NOT_SENDING = new Set([
  // Public/pre-login auth routes (the OTP template is a platform login message, never a merchant send)
  'POST /api/auth/dev-login',
  'POST /api/auth/magic-link/request',
  'POST /api/auth/magic-link/verify',
  'POST /api/auth/otp/request',
  'POST /api/auth/otp/verify',
  'POST /api/auth/select-workspace',
  // AI / LLM assistance only (no WhatsApp message is sent from these routes)
  'POST /api/ai-chat/message',
  'POST /api/instagram-posts/posts/:id/generate-content',
  'POST /api/instagram-posts/refine-content',
  'POST /api/localization/ai-mode/message',
  'POST /api/localization/ai/reply-in-arabic',
  'POST /api/localization/ai/saudi-friendly',
  'POST /api/localization/ai/suggest-product-translation',
  'POST /api/localization/ai/translate',
  'POST /api/localization/ai/translate-inbound',
  // Business state changes that send a BEST-EFFORT notification as a side effect (booking and order notices). Not blocked here: blocking would stop the state change itself; the service-level hunks are decision D19 (later phase)
  'POST /api/orders/:id/refund',
  'POST /api/services/bookings/:bookingId/cancel',
  'POST /api/services/bookings/:bookingId/complete',
  'POST /api/services/bookings/:bookingId/confirm',
  'POST /api/services/bookings/:bookingId/decline',
  'POST /api/services/bookings/:bookingId/no-show',
  'POST /api/services/bookings/:bookingId/reschedule',
  'PUT /api/orders/:id/status',
  // Instagram drafting (publish/schedule/connect are in the send table)
  'POST /api/instagram-media/upload',
  'POST /api/instagram-posts/posts',
  'POST /api/instagram-posts/posts/:id/cancel',
  'POST /api/instagram-posts/posts/:id/duplicate',
  'PUT /api/instagram-posts/posts/:id',
  // Arabic localisation authoring and review (sending is in the send table)
  'POST /api/localization/campaigns',
  'POST /api/localization/campaigns/:id/cancel',
  'POST /api/localization/campaigns/plan',
  'POST /api/localization/catalog/:kind/:refId/translation/review',
  'POST /api/localization/catalog/import',
  'POST /api/localization/customers/language/bulk',
  'POST /api/localization/customers/language/import',
  'POST /api/localization/flows/followups/:nodeId/variants/ar/review',
  'POST /api/localization/flows/messages/:messageNodeId/localize',
  'POST /api/localization/templates',
  'POST /api/localization/templates/:id/archive',
  'POST /api/localization/templates/:id/unarchive',
  'POST /api/localization/templates/:id/variants/:language/review',
  'POST /api/localization/templates/:id/variants/:language/validate',
  'POST /api/localization/templates/preview',
  'POST /api/localization/templates/refresh-status',
  'PUT /api/localization/catalog/:kind/:refId/translation',
  'PUT /api/localization/customers/:id/language',
  'PUT /api/localization/flows/followups/:nodeId/variants/ar',
  'PUT /api/localization/settings',
  'PUT /api/localization/settings/me',
  'PUT /api/localization/templates/:id',
  'PUT /api/localization/templates/:id/variants/:language',
  // Referral authoring and admin (sending is in the send table)
  'POST /api/referrals/promotions',
  'POST /api/referrals/promotions/:id/customer-links',
  'POST /api/referrals/referrals/:id/approve',
  'POST /api/referrals/referrals/:id/void',
  'POST /api/referrals/vouchers/:id/redeem',
  'PUT /api/referrals/promotions/:id',
  // Catalogue, customers, promotions, flows, services and other CRUD
  'DELETE /api/flows/:id',
  'DELETE /api/message-nodes/:id',
  'DELETE /api/products/:id',
  'DELETE /api/promotions/:id',
  'DELETE /api/services/:id',
  'DELETE /api/services/:id/slots/:slotId',
  'DELETE /api/workspaces/me/invites/:id',
  'DELETE /api/workspaces/me/members/:userId',
  'PATCH /api/imports/:id/mapping',
  'PATCH /api/workspaces/me/onboarding',
  'POST /api/customers',
  'POST /api/customers/:id/consent',
  'POST /api/entitlements/campaigns/estimate',
  'POST /api/entitlements/campaigns/reserve',
  'POST /api/flows',
  'POST /api/flows/:id/pause',
  'POST /api/imports',
  'POST /api/imports/:id/run',
  'POST /api/insights/status',
  'POST /api/legal/accept/combined',
  'POST /api/legal/accept/dpa',
  'POST /api/message-nodes',
  'POST /api/products',
  'POST /api/promotions',
  'POST /api/services',
  'POST /api/services/:id/slots',
  'POST /api/support',
  'POST /api/uploads/image',
  'POST /api/workspaces/me/invites',
  'PUT /api/customers/:id',
  'PUT /api/flows/:id',
  'PUT /api/message-nodes/:id',
  'PUT /api/products/:id',
  'PUT /api/promotions/:id',
  'PUT /api/services/:id',
  'PUT /api/services/:id/slots/:slotId',
  'PUT /api/settings/loyalty',
]);

maybe('route inventory (DB 4.6 drift protection)', () => {
  let routes;
  beforeAll(() => {
    process.env.ONBOARDING_FLOW = 'on';
    const mongoose = require('mongoose');
    jest.spyOn(mongoose, 'connect').mockResolvedValue(mongoose);
    // record the mount path of every layer created through Router.use (Express 5 keeps only matcher functions)
    const Router = require('router');
    const originalUse = Router.prototype.use;
    Router.prototype.use = function patchedUse(...args) {
      const before = this.stack.length;
      const out = originalUse.apply(this, args);
      const first = args[0];
      const mount = typeof first === 'string' ? first : (Array.isArray(first) && typeof first[0] === 'string' ? first[0] : '/');
      for (const layer of this.stack.slice(before)) layer.__mountPath = mount;
      return out;
    };
    let app;
    try { app = require('../../server'); } finally { Router.prototype.use = originalUse; }

    const found = [];
    const walk = (stack, prefix) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const method of Object.keys(layer.route.methods)) {
            if (layer.route.methods[method]) found.push({ method: method.toUpperCase(), path: join(prefix, String(layer.route.path)) });
          }
        } else if (layer.handle && Array.isArray(layer.handle.stack)) {
          walk(layer.handle.stack, join(prefix, layer.__mountPath || '/'));
        }
      }
    };
    walk(app.router.stack, '');
    routes = found;
  });
  afterAll(() => { jest.restoreAllMocks(); });

  function join(a, b) { return `${a}/${b}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/'; }
  const sample = (p) => p.replace(/\/:[A-Za-z0-9_]+(\([^)]*\))?\??/g, '/x').replace(/\/\*[A-Za-z0-9_]*/g, '/x');

  test('the walker actually found the app\'s routes', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.method === 'POST' && /^\/api\/promotions\/:id\/send$/.test(r.path))).toBe(true);
  });

  test('every table row matches at least one real route (no stale rows)', () => {
    const { ROUTES, match } = require('../../shared/onboarding/sendRoutes');
    const live = routes.filter((r) => r.path.startsWith('/api/')).map((r) => ({ ...r, sample: sample(r.path) }));
    for (const row of ROUTES) {
      const hit = live.some((r) => match(r.method, r.sample) && match(r.method, r.sample).name === row.name);
      if (!hit) throw new Error(`table row ${row.name} matches no real route: the route was renamed or removed`);
    }
  });

  test('every non-GET /api route is classified', () => {
    const { match } = require('../../shared/onboarding/sendRoutes');
    const unclassified = [];
    for (const r of routes) {
      if (r.method === 'GET' || r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      if (!r.path.startsWith('/api/')) continue;
      if (r.path.startsWith('/api/onboarding')) continue;
      const s = sample(r.path);
      if (match(r.method, s)) continue;
      if (NOT_SENDING.has(`${r.method} ${r.path}`)) continue;
      unclassified.push(`${r.method} ${r.path}`);
    }
    if (unclassified.length) {
      throw new Error(`Unclassified mutating /api routes (add to sendRoutes.ROUTES if they send, else to NOT_SENDING):\n${[...new Set(unclassified)].sort().join('\n')}`);
    }
  });

  test('NOT_SENDING has no stale entries and no entry that the send table already covers', () => {
    const { match } = require('../../shared/onboarding/sendRoutes');
    const live = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const entry of NOT_SENDING) {
      if (!live.has(entry)) throw new Error(`NOT_SENDING lists a route that no longer exists: ${entry}`);
      const [method, path] = entry.split(' ');
      if (match(method, sample(path))) throw new Error(`NOT_SENDING lists a route the send table already covers: ${entry}`);
    }
  });
});
