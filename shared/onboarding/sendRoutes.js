'use strict';
// Data table of the existing routes that SEND (or connect/publish) and therefore
// sit behind the onboarding access rule (DB design 4.6). Matching is done on
// req.baseUrl + req.path (Express 5 strips the mount prefix from req.url under
// app.use('/api', ...)). Drift protection: tests/onboarding/routeInventory.test.js
// fails when a non-GET /api route is neither here nor on its explicit
// "not sending" list. `kind` drives gate.evaluate: 'send' = subscription +
// connection + legacy-number policy, 'connect' = subscription only.

const ROUTES = Object.freeze([
  { name: 'promotions.send', method: 'POST', kind: 'send', re: /^\/api\/promotions\/[^/]+\/(test-send|send|send-live-demo)$/i },
  { name: 'promotions.loyalty.remind', method: 'POST', kind: 'send', re: /^\/api\/promotions\/loyalty\/remind$/i },
  { name: 'customers.consent-requests', method: 'POST', kind: 'send', re: /^\/api\/customers\/consent-requests$/i },
  { name: 'inbox.send', method: 'POST', kind: 'send', re: /^\/api\/inbox\/conversations\/[^/]+\/(messages|payment-link|loyalty-reminder)$/i },
  { name: 'referrals.send', method: 'POST', kind: 'send', re: /^\/api\/referrals\/promotions\/[^/]+\/(send|status)$/i },
  { name: 'flows.activate', method: 'POST', kind: 'send', re: /^\/api\/flows\/[^/]+\/activate$/i },
  { name: 'message-nodes.template', method: 'POST', kind: 'send', re: /^\/api\/message-nodes\/[^/]+\/(submit-template|refresh-status)$/i },
  { name: 'whatsapp.platform', method: 'POST', kind: 'send', re: /^\/api\/whatsapp\/(refresh-token|create-[a-z-]+-template)$/i },
  { name: 'whatsapp.templates.delete', method: 'DELETE', kind: 'send', re: /^\/api\/whatsapp\/templates\/[^/]+$/i },
  { name: 'ai-chat.confirm-action', method: 'POST', kind: 'send', re: /^\/api\/ai-chat\/confirm-action$/i },
  {
    name: 'localization.send', method: 'POST', kind: 'send',
    re: /^\/api\/localization\/(campaigns\/[^/]+\/send|templates\/from-library|templates\/[^/]+\/variants\/[^/]+\/(submit|test-send)|inbox\/conversations\/[^/]+\/(payment-link|loyalty-reminder)|ai-mode\/confirm|senders\/.*|promotions\/.*)$/i,
  },
  { name: 'instagram.connect-url', method: 'GET', kind: 'connect', re: /^\/api\/social-accounts\/instagram\/connect-url$/i },
  { name: 'instagram.disconnect', method: 'POST', kind: 'connect', re: /^\/api\/social-accounts\/instagram\/disconnect$/i },
  { name: 'instagram-posts.publish', method: 'POST', kind: 'connect', re: /^\/api\/instagram-posts\/posts\/[^/]+\/(schedule|publish-now)$/i },
]);

/** The path the table is matched against: baseUrl + path, no query string. */
function pathOf(req) {
  return `${req.baseUrl || ''}${req.path || ''}`;
}

/**
 * @param {string} method HTTP method (HEAD is treated as GET)
 * @param {string} path e.g. '/api/promotions/abc/send' (case-insensitive, trailing slash tolerated)
 * @returns {{name:string, kind:'send'|'connect'}|null}
 */
function match(method, path) {
  let m = String(method || '').toUpperCase();
  if (m === 'HEAD') m = 'GET';
  let p = String(path || '');
  const q = p.search(/[?#]/);
  if (q >= 0) p = p.slice(0, q);
  p = p.replace(/\/+$/, '');
  if (!p) return null;
  for (const row of ROUTES) {
    if (row.method === m && row.re.test(p)) return { name: row.name, kind: row.kind };
  }
  return null;
}

module.exports = { ROUTES, match, pathOf };
