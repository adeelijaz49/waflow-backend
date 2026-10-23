'use strict';
const { match, ROUTES, pathOf } = require('../../../shared/onboarding/sendRoutes');

const ID = '507f1f77bcf86cd799439011';

// Every route of DB 4.6, one concrete sample each.
const POSITIVE = [
  ['POST', `/api/promotions/${ID}/test-send`, 'send'],
  ['POST', `/api/promotions/${ID}/send`, 'send'],
  ['POST', `/api/promotions/${ID}/send-live-demo`, 'send'],
  ['POST', '/api/promotions/loyalty/remind', 'send'],
  ['POST', '/api/customers/consent-requests', 'send'],
  ['POST', `/api/inbox/conversations/${ID}/messages`, 'send'],
  ['POST', `/api/inbox/conversations/${ID}/payment-link`, 'send'],
  ['POST', `/api/inbox/conversations/${ID}/loyalty-reminder`, 'send'],
  ['POST', `/api/referrals/promotions/${ID}/send`, 'send'],
  ['POST', `/api/referrals/promotions/${ID}/status`, 'send'],
  ['POST', `/api/flows/${ID}/activate`, 'send'],
  ['POST', `/api/message-nodes/${ID}/submit-template`, 'send'],
  ['POST', `/api/message-nodes/${ID}/refresh-status`, 'send'],
  ['POST', '/api/whatsapp/refresh-token', 'send'],
  ['POST', '/api/whatsapp/create-promotion-template', 'send'],
  ['POST', '/api/whatsapp/create-order-status-template', 'send'],
  ['DELETE', `/api/whatsapp/templates/${ID}`, 'send'],
  ['POST', '/api/ai-chat/confirm-action', 'send'],
  ['POST', `/api/localization/campaigns/${ID}/send`, 'send'],
  ['POST', '/api/localization/templates/from-library', 'send'],
  ['POST', `/api/localization/templates/${ID}/variants/ar/submit`, 'send'],
  ['POST', `/api/localization/templates/${ID}/variants/ar/test-send`, 'send'],
  ['POST', `/api/localization/inbox/conversations/${ID}/payment-link`, 'send'],
  ['POST', `/api/localization/inbox/conversations/${ID}/loyalty-reminder`, 'send'],
  ['POST', '/api/localization/ai-mode/confirm', 'send'],
  ['POST', '/api/localization/senders/anything/at/all', 'send'],
  ['POST', '/api/localization/promotions/x/y', 'send'],
  ['GET', '/api/social-accounts/instagram/connect-url', 'connect'],
  ['POST', '/api/social-accounts/instagram/disconnect', 'connect'],
  ['POST', `/api/instagram-posts/posts/${ID}/schedule`, 'connect'],
  ['POST', `/api/instagram-posts/posts/${ID}/publish-now`, 'connect'],
];

describe('every route of the DB 4.6 table matches with the right kind', () => {
  test.each(POSITIVE)('%s %s -> %s', (method, path, kind) => {
    const m = match(method, path);
    expect(m).not.toBeNull();
    expect(m.kind).toBe(kind);
  });
  test('the sample list covers every row of the table', () => {
    const covered = new Set(POSITIVE.map(([method, path]) => match(method, path).name));
    expect([...covered].sort()).toEqual(ROUTES.map((r) => r.name).sort());
  });
});

describe('negative cases', () => {
  const NEGATIVE = [
    ['GET', `/api/promotions/${ID}/send`],             // wrong method
    ['PUT', `/api/promotions/${ID}/send`],
    ['POST', '/api/promotions/send'],                  // no id segment
    ['POST', `/api/promotions/${ID}/send/extra`],      // extra segment
    ['POST', `/api/promotions/${ID}/sendx`],
    ['POST', `/api/promotions/${ID}`],
    ['POST', '/api/promotions'],
    ['POST', '/api/customers'],                        // plain customer create is not sending
    ['POST', '/api/customers/import'],
    ['POST', `/api/imports/${ID}/run`],                // deliberately NOT blocked (spec 0b)
    ['GET', '/api/customers'],
    ['GET', '/api/whatsapp/templates'],
    ['POST', '/api/whatsapp/create-promotion-template/extra'],
    ['POST', '/api/whatsapp/create--template-x'],
    ['DELETE', '/api/whatsapp/templates'],
    ['POST', '/api/onboarding/connect/complete'],      // onboarding routes have their own gate
    ['POST', '/api/auth/login'],
    ['POST', '/api/localization/settings'],
    ['POST', '/api/localization/templates/x/variants/ar/preview'],
    ['POST', '/api/social-accounts/instagram/connect-url'], // connect-url is GET only
    ['GET', '/api/social-accounts/instagram/disconnect'],
    ['POST', '/api/instagram-posts/posts/x/delete'],
    ['POST', '/webhook'],
    ['POST', '/stripe-webhook'],
    ['POST', '/send-message'],
    ['POST', ''],
    ['POST', undefined],
    [undefined, '/api/promotions/x/send'],
  ];
  test.each(NEGATIVE)('%s %s is not matched', (method, path) => {
    expect(match(method, path)).toBeNull();
  });
});

describe('normalisation', () => {
  test('case-insensitive (Express routing is case-insensitive by default)', () => {
    expect(match('POST', `/API/Promotions/${ID}/SEND`)).not.toBeNull();
    expect(match('post', `/api/promotions/${ID}/send`)).not.toBeNull();
  });
  test('a trailing slash and a query string do not bypass the table', () => {
    expect(match('POST', `/api/promotions/${ID}/send/`)).not.toBeNull();
    expect(match('POST', `/api/promotions/${ID}/send///`)).not.toBeNull();
    expect(match('POST', `/api/promotions/${ID}/send?x=1`)).not.toBeNull();
    expect(match('POST', `/api/promotions/${ID}/send#frag`)).not.toBeNull();
  });
  test('HEAD is treated as GET', () => {
    expect(match('HEAD', '/api/social-accounts/instagram/connect-url')).not.toBeNull();
    expect(match('HEAD', `/api/promotions/${ID}/send`)).toBeNull();
  });
  test('a different mount prefix does not match (the table is anchored)', () => {
    expect(match('POST', `/x/api/promotions/${ID}/send`)).toBeNull();
    expect(match('POST', `/promotions/${ID}/send`)).toBeNull();
  });
  test('pathOf = baseUrl + path (Express 5 strips the mount prefix under app.use)', () => {
    expect(pathOf({ baseUrl: '/api', path: `/promotions/${ID}/send` })).toBe(`/api/promotions/${ID}/send`);
    expect(pathOf({ path: '/x' })).toBe('/x');
    expect(pathOf({})).toBe('');
  });
  test('the table is frozen and every row is well formed', () => {
    expect(Object.isFrozen(ROUTES)).toBe(true);
    for (const r of ROUTES) {
      expect(['GET', 'POST', 'DELETE']).toContain(r.method);
      expect(['send', 'connect']).toContain(r.kind);
      expect(r.re).toBeInstanceOf(RegExp);
      expect(r.name).toMatch(/^[a-z-]+(\.[a-z-]+)*$/);
    }
  });
});
