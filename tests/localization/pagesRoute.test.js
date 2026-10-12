// Route-level behaviour of the Arabic customer pages: which requests the router touches
// at all, that EVERYTHING else (and every English decision) falls through to the
// existing handlers untouched, and that mounting it has no side effects. A sentinel
// handler registered after the router stands in for the existing English pages
// (routes/pay.js, referralRedirect.js, instagramRedirect.js).
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const pagesRouter = require('../../routes/localization/pages');
const catalog = require('../../shared/localization/catalog');

const { createRouter, ROUTES } = pagesRouter;
const WS = '64b000000000000000000001';
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const SENTINEL = 'EXISTING-ENGLISH-HANDLER';
const ROOT = path.join(__dirname, '..', '..');

const SIX_URLS = [
  '/pay/pi_3Abc123',
  '/payment-result?payment_intent=pi_3Abc123',
  '/payment-cancelled',
  '/r/ABCDEF1234',
  '/c/ABCDEF1234',
  '/t/ABCDEF1234',
];
const withQuery = (url, extra) => `${url}${url.includes('?') ? '&' : '?'}${extra}`;

const query = (value) => { const q = { select: () => q, sort: () => q, lean: () => Promise.resolve(value) }; return q; };
const model = (value) => ({ findOne: jest.fn(() => query(value)), findById: jest.fn(() => query(value)) });

function makeDeps(over = {}) {
  const stripe = {
    paymentIntents: {
      retrieve: jest.fn(async () => ({
        id: 'pi_3Abc123', status: 'requires_payment_method', amount: 15000, currency: 'sar', client_secret: 'pi_3Abc123_secret_xyz',
        metadata: { buyerPhone: '966500000001', subtotal: '145', shippingCost: '5' },
      })),
    },
  };
  return {
    env: {},
    now: () => NOW,
    precheckTimeoutMs: 1000,
    settings: { killSwitchOn: jest.fn(() => false), isArabicEnabled: jest.fn(async (ws) => ws === WS) },
    catalog,
    dbReady: () => true,
    anyArabicEnabled: jest.fn(async () => true),
    oldestWorkspaceId: jest.fn(async () => WS),
    stripe,
    getStripe: jest.fn(() => stripe),
    publishableKey: () => 'pk_test_123',
    carts: new Map(),
    models: {
      Order: model({ workspaceId: WS, customer: '64b0000000000000000000c1' }),
      Service: model(null),
      TimeSlot: model(null),
      Customer: model({ _id: '64b0000000000000000000c1', firstname: 'محمد' }),
      CustomerLanguage: model(null),
      ReferralCode: model({ workspaceId: WS, referralPromotionId: 'p1', referrerCustomerId: 'c1', status: 'active' }),
      ReferralPromotion: model({ name: 'x', status: 'active' }),
      TrackingLink: model({ workspaceId: WS, instagramPostId: 'ig1' }),
      InstagramPost: model({ name: 'Sale' }),
    },
    recordReferralClick: jest.fn(async () => ({ waLink: 'https://wa.me/966500000000?text=Hi', referralCode: { code: 'ABCDEF1234' } })),
    recordTrackingClick: jest.fn(async () => ({ waLink: 'https://wa.me/966500000000?text=Hi', post: { name: 'Sale', promotionCode: 'IG-ABCD1234' } })),
    ...over,
  };
}

function makeApp(getDeps) {
  const app = express();
  app.use(createRouter(getDeps));
  app.use((req, res) => res.status(200).send(SENTINEL));
  return app;
}

let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('what the router declares', () => {
  test('exactly six GET routes and nothing else (no path-less middleware, no other methods)', () => {
    const layers = pagesRouter.stack;
    expect(layers).toHaveLength(6);
    for (const layer of layers) {
      expect(layer.route).toBeTruthy(); // a path-less router.use() would have no route
      expect(Object.keys(layer.route.methods)).toEqual(['get']);
    }
    expect(layers.map((l) => l.route.path)).toEqual(['/pay/:piId', '/payment-result', '/payment-cancelled', '/r/:code', '/c/:code', '/t/:code']);
    expect(ROUTES.map(([routePath]) => routePath)).toEqual(layers.map((l) => l.route.path));
  });

  test('the module export is a router that server.js can mount at the root', () => {
    const app = express();
    expect(() => app.use(pagesRouter)).not.toThrow();
    expect(typeof pagesRouter).toBe('function');
    expect(typeof createRouter).toBe('function');
  });
});

describe('everything that is not one of the six GET pages is left alone (and never touches a collaborator)', () => {
  test.each([
    ['GET', '/'], ['GET', '/pay'], ['GET', '/pay/'], ['GET', '/payments'], ['GET', '/payment'], ['GET', '/payment-results'],
    ['GET', '/r'], ['GET', '/r/'], ['GET', '/c'], ['GET', '/t'], ['GET', '/rr/ABC'], ['GET', '/pay/pi_1/extra'],
    ['GET', '/auth/instagram/callback?code=1'], ['GET', '/uploads/x.png'], ['GET', '/api/localization/templates'],
    ['GET', '/oauth/authorize'], ['GET', '/webhook'], ['GET', '/internal-admin'],
    ['POST', '/pay/pi_3Abc123'], ['POST', '/payment-result'], ['POST', '/payment-cancelled'], ['POST', '/r/ABCDEF1234?go=1'],
    ['PUT', '/c/ABCDEF1234'], ['DELETE', '/t/ABCDEF1234'], ['PATCH', '/pay/pi_3Abc123'],
  ])('%s %s', async (method, url) => {
    const getDeps = jest.fn(() => makeDeps());
    const res = await request(makeApp(getDeps))[method.toLowerCase()](url).set('Accept-Language', 'ar');
    expect(res.text).toBe(SENTINEL);
    expect(getDeps).not.toHaveBeenCalled();
  });
});

describe('every English decision falls through untouched, on all six routes', () => {
  const CASES = [
    ['?lang=en', (deps) => deps, (url) => withQuery(url, 'lang=en'), { 'Accept-Language': 'ar' }],
    ['kill switch', (deps) => { deps.settings.killSwitchOn.mockReturnValue(true); return deps; }, (url) => withQuery(url, 'lang=ar'), { 'Accept-Language': 'ar' }],
    ['merchant without Arabic', (deps) => { deps.settings.isArabicEnabled.mockResolvedValue(false); return deps; }, (url) => withQuery(url, 'lang=ar'), { 'Accept-Language': 'ar' }],
    ['no merchant has Arabic', (deps) => { deps.anyArabicEnabled.mockResolvedValue(false); return deps; }, (url) => withQuery(url, 'lang=ar'), { 'Accept-Language': 'ar' }],
    ['English browser, no ?lang', (deps) => deps, (url) => url, { 'Accept-Language': 'en-US,en;q=0.9' }],
    ['no language signal at all', (deps) => deps, (url) => url, {}],
    ['database not connected', (deps) => { deps.dbReady = () => false; return deps; }, (url) => withQuery(url, 'lang=ar'), { 'Accept-Language': 'ar' }],
    ['draft copy blocked by LOCALIZATION_ALLOW_DRAFT_PAGES=0', (deps) => { deps.env = { LOCALIZATION_ALLOW_DRAFT_PAGES: '0' }; return deps; }, (url) => withQuery(url, 'lang=ar'), {}],
  ];

  describe.each(CASES)('%s', (label, arrange, shape, headers) => {
    test.each(SIX_URLS)('%s', async (url) => {
      const deps = arrange(makeDeps());
      const res = await request(makeApp(() => deps)).get(shape(url)).set(headers);
      expect(res.status).toBe(200);
      expect(res.text).toBe(SENTINEL);
      // the router must have set NOTHING before stepping aside
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers['content-language']).toBeUndefined();
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers.location).toBeUndefined();
      // and recorded nothing: the English handler records the click, once
      expect(deps.recordReferralClick).not.toHaveBeenCalled();
      expect(deps.recordTrackingClick).not.toHaveBeenCalled();
    });
  });
});

describe('the reason an English page answers is remembered for the pay-page switch link (IM-D)', () => {
  const reasonApp = (deps) => {
    const app = express();
    app.use(createRouter(() => deps));
    app.use((req, res) => res.status(200).send(`reason=${res.locals.arabicPageReason === undefined ? 'none' : res.locals.arabicPageReason}`));
    return app;
  };

  test.each([
    ['?lang=en', (d) => d, '/pay/pi_3Abc123?lang=en', {}, 'explicit_en'],
    ['kill switch', (d) => { d.settings.killSwitchOn.mockReturnValue(true); return d; }, '/pay/pi_3Abc123', {}, 'kill_switch'],
    ['merchant without Arabic', (d) => { d.settings.isArabicEnabled.mockResolvedValue(false); return d; }, '/pay/pi_3Abc123', {}, 'flag_off'],
    ['nobody has Arabic', (d) => { d.anyArabicEnabled.mockResolvedValue(false); return d; }, '/payment-result?payment_intent=pi_3Abc123', {}, 'not_rolled_out'],
    ['English browser', (d) => d, '/pay/pi_3Abc123', { 'Accept-Language': 'en-US,en;q=0.9' }, 'browser'],
    ['no signal', (d) => d, '/pay/pi_3Abc123', {}, 'default'],
    ['database down', (d) => { d.dbReady = () => false; return d; }, '/pay/pi_3Abc123', {}, 'db_unavailable'],
  ])('%s -> %s', async (label, arrange, url, headers, expected) => {
    const res = await request(reasonApp(arrange(makeDeps()))).get(url).set(headers);
    expect(res.text).toBe(`reason=${expected}`);
  });

  test('a lookup failure leaves no reason (so no switch link is shown)', async () => {
    const deps = makeDeps({ anyArabicEnabled: jest.fn(async () => { throw new Error('boom'); }) });
    const res = await request(reasonApp(deps)).get('/pay/pi_3Abc123');
    expect(res.text).toBe('reason=none');
  });

  test('a request the router does not own never gets a reason', async () => {
    const res = await request(reasonApp(makeDeps())).get('/payments');
    expect(res.text).toBe('reason=none');
  });
});

describe('English pays for as little as possible', () => {
  test('?lang=en and the kill switch cost no lookup at all; "nobody has Arabic" costs one cached boolean', async () => {
    const english = makeDeps();
    for (const url of SIX_URLS) await request(makeApp(() => english)).get(withQuery(url, 'lang=en'));
    expect(english.anyArabicEnabled).not.toHaveBeenCalled();
    expect(english.getStripe).not.toHaveBeenCalled();

    const none = makeDeps({ anyArabicEnabled: jest.fn(async () => false) });
    for (const url of SIX_URLS) await request(makeApp(() => none)).get(url).set('Accept-Language', 'ar');
    expect(none.anyArabicEnabled).toHaveBeenCalledTimes(6);
    expect(none.getStripe).not.toHaveBeenCalled();
    for (const m of Object.values(none.models)) expect(m.findOne).not.toHaveBeenCalled();
    expect(none.oldestWorkspaceId).not.toHaveBeenCalled();
  });
});

describe('the Arabic responses of the router itself', () => {
  test('all six routes answer an Arabic-capable request: right-to-left HTML (or a redirect) that is never cacheable', async () => {
    for (const url of SIX_URLS) {
      const res = await request(makeApp(() => makeDeps())).get(withQuery(url, 'lang=ar'));
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
      expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-language']).toBe('ar');
      expect(res.text).toContain('<html lang="ar" dir="rtl">');
      expect(res.text).toContain('hreflang="en"'); // the visible language switch
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  test('the redirect after a tap is not cacheable either', async () => {
    for (const url of ['/r/ABCDEF1234?lang=ar&go=1', '/c/ABCDEF1234?lang=ar&go=1', '/t/ABCDEF1234?lang=ar&go=1']) {
      const res = await request(makeApp(() => makeDeps())).get(url);
      expect(res.status).toBe(302);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.location).toMatch(/^https:\/\/wa\.me\/966500000000\?text=/);
    }
  });

  test('HEAD is answered like GET (headers only) and never records a click', async () => {
    const deps = makeDeps();
    const page = await request(makeApp(() => deps)).head('/pay/pi_3Abc123?lang=ar');
    expect(page.status).toBe(200);
    expect(page.headers['content-language']).toBe('ar');
    const tap = await request(makeApp(() => deps)).head('/r/ABCDEF1234?lang=ar&go=1');
    expect(tap.status).toBe(200);
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
  });

  test('requests are independent: concurrent renders never bleed into each other', async () => {
    const deps = makeDeps();
    const app = makeApp(() => deps);
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => request(app).get(`/pay/pi_3Abc123?lang=${i % 2 ? 'ar' : 'en'}`)));
    results.forEach((res, i) => {
      if (i % 2) expect(res.text).toContain('<html lang="ar" dir="rtl">');
      else expect(res.text).toBe(SENTINEL);
    });
    const first = results.find((r, i) => i % 2).text;
    for (const res of results.filter((r, i) => i % 2)) expect(res.text).toBe(first);
  });
});

describe('fail open', () => {
  test('collaborators that cannot be built, on every route', async () => {
    for (const url of SIX_URLS) {
      const app = makeApp(() => { throw new Error('model failed to load'); });
      const res = await request(app).get(withQuery(url, 'lang=ar'));
      expect(res.text).toBe(SENTINEL);
    }
    expect(errorSpy).toHaveBeenCalledWith('[localization:pages] falling back to the English page:', 'model failed to load');
  });

  test('a collaborator that throws synchronously or asynchronously, on every route', async () => {
    for (const url of SIX_URLS) {
      const sync = makeDeps({ settings: { killSwitchOn: () => { throw new Error('sync'); }, isArabicEnabled: async () => true } });
      expect((await request(makeApp(() => sync)).get(withQuery(url, 'lang=ar'))).text).toBe(SENTINEL);
      const asyncFail = makeDeps({ anyArabicEnabled: async () => { throw new Error('async'); } });
      expect((await request(makeApp(() => asyncFail)).get(withQuery(url, 'lang=ar'))).text).toBe(SENTINEL);
    }
  });

  test('a lookup that outlives its time budget is abandoned: the English page answers once, and the late result never touches the response', async () => {
    let finish;
    const slow = makeDeps({ precheckTimeoutMs: 30 });
    slow.stripe.paymentIntents.retrieve.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const res = await request(makeApp(() => slow)).get('/pay/pi_3Abc123?lang=ar');
    expect(res.text).toBe(SENTINEL);
    finish({ id: 'pi_3Abc123', status: 'requires_payment_method', amount: 100, currency: 'sar', client_secret: 's', metadata: {} });
    await new Promise((resolve) => setTimeout(resolve, 60)); // the abandoned plan now completes in the background
    const messages = errorSpy.mock.calls.map((call) => String(call[1] || call[0]));
    expect(messages.filter((m) => /headers|already sent|ERR_HTTP/i.test(m))).toEqual([]);
  });

  test('a lookup that fails after the budget was spent is not an unhandled rejection', async () => {
    const slow = makeDeps({ precheckTimeoutMs: 20 });
    slow.settings.isArabicEnabled.mockImplementation(() => new Promise((resolve, reject) => setTimeout(() => reject(new Error('late')), 60)));
    const res = await request(makeApp(() => slow)).get('/pay/pi_3Abc123?lang=ar');
    expect(res.text).toBe(SENTINEL);
    await new Promise((resolve) => setTimeout(resolve, 100)); // Jest fails a test that leaves an unhandled rejection behind
  });
});

describe('mounting and wiring have no side effects', () => {
  const HEAVY = ['../../utils/whatsapp', '../../shared/referrals', '../../shared/instagram', '../../shared/localization/transport', 'stripe'];

  function withHeavyModulesForbidden(fn) {
    jest.isolateModules(() => {
      for (const mod of HEAVY) jest.doMock(mod, () => { throw new Error(`${mod} must not be loaded at mount time`); });
      fn();
    });
  }

  test('requiring the router loads none of the WhatsApp / Meta / Stripe stack and opens no database connection', () => {
    withHeavyModulesForbidden(() => {
      const router = require('../../routes/localization/pages');
      expect(typeof router.createRouter).toBe('function');
      expect(require('mongoose').connection.readyState).toBe(0);
    });
  });

  test('building the production collaborators is lazy too: nothing heavy is loaded until a click is recorded', () => {
    withHeavyModulesForbidden(() => {
      const pages = require('../../shared/localization/pages');
      const deps = pages.realDeps({});
      for (const fn of ['dbReady', 'getStripe', 'publishableKey', 'anyArabicEnabled', 'oldestWorkspaceId', 'recordReferralClick', 'recordTrackingClick']) {
        expect(typeof deps[fn]).toBe('function');
      }
      expect(deps.dbReady()).toBe(false);
      expect(deps.getStripe()).toBeNull();
      expect(deps.publishableKey()).toBe('');
      expect(deps.carts instanceof Map).toBe(true);
      expect(typeof deps.settings.isArabicEnabled).toBe('function');
      expect(deps.precheckTimeoutMs).toBe(pages.PRECHECK_TIMEOUT_MS);
      expect(Object.keys(deps.models).sort()).toEqual([
        'Customer', 'CustomerLanguage', 'InstagramPost', 'LocaleSettings', 'Order', 'ReferralCode', 'ReferralPromotion', 'Service', 'Settings', 'TimeSlot', 'TrackingLink', 'Workspace',
      ]);
    });
  });

  test('the click recorders are the EXISTING exported functions, required only when a click happens, called with the arguments given', async () => {
    jest.isolateModules(() => {
      const referral = jest.fn(async () => 'referral-result');
      const tracking = jest.fn(async () => 'tracking-result');
      jest.doMock('../../shared/referrals', () => ({ recordClickAndGetRedirect: referral }));
      jest.doMock('../../shared/instagram', () => ({ recordClickAndGetRedirect: tracking }));
      const deps = require('../../shared/localization/pages').realDeps({});
      expect(referral).not.toHaveBeenCalled();
      return Promise.all([deps.recordReferralClick({ code: 'A' }), deps.recordTrackingClick({ code: 'B' })]).then((results) => {
        expect(results).toEqual(['referral-result', 'tracking-result']);
        expect(referral).toHaveBeenCalledWith({ code: 'A' });
        expect(tracking).toHaveBeenCalledWith({ code: 'B' });
      });
    });
  });

  test('with the real collaborators and no database connection, all six routes fall through immediately (English never waits on a dead database)', async () => {
    const pages = require('../../shared/localization/pages');
    const deps = pages.realDeps({});
    expect(deps.dbReady()).toBe(false);
    const started = Date.now();
    for (const url of SIX_URLS) {
      const res = await request(makeApp(() => deps)).get(withQuery(url, 'lang=ar')).set('Accept-Language', 'ar');
      expect(res.text).toBe(SENTINEL);
    }
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('the real kill switch (LOCALIZATION_DISABLED) is honoured', async () => {
    const pages = require('../../shared/localization/pages');
    const deps = { ...pages.realDeps({}), dbReady: () => true };
    const previous = process.env.LOCALIZATION_DISABLED;
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const res = await request(makeApp(() => deps)).get('/pay/pi_3Abc123?lang=ar').set('Accept-Language', 'ar');
      expect(res.text).toBe(SENTINEL);
      expect(await Promise.resolve(deps.settings.killSwitchOn())).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LOCALIZATION_DISABLED; else process.env.LOCALIZATION_DISABLED = previous;
    }
  });
});

describe('source guards: this feature only ever reads, never writes or sends', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'shared', 'localization', 'pages')).filter((f) => f.endsWith('.js')).map((f) => path.join('shared', 'localization', 'pages', f)),
    path.join('routes', 'localization', 'pages.js'),
  ];
  const source = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
  // comments may talk about what the English handler does; only code counts
  const code = (file) => source(file).split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

  test('there are page sources to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  test.each(files)('%s: no database writes or deletes, no cart changes', (file) => {
    // The payment page's inline browser script legitimately calls Stripe.js `elements.create('payment')`;
    // that runs in the customer's browser and is not a database write.
    const serverCode = code(file).replace(/\belements\.create\('payment'\)/g, '');
    expect(serverCode).not.toMatch(/\.(deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|findOneAndRemove|remove|drop|dropCollection|bulkWrite|insertOne|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|replaceOne|create|save|insert|upsert)\s*\(/);
    expect(code(file)).not.toMatch(/\bcarts\.(delete|set|clear)\b|\bcart\.(push|splice|pop|shift)\b/);
  });

  test.each(files)('%s: no cookies, no body parsing, no messaging, no secrets in output', (file) => {
    const text = code(file);
    expect(text).not.toMatch(/res\.cookie|Set-Cookie|cookie\(|req\.body|express\.json|bodyParser|urlencoded/i);
    expect(text).not.toMatch(/\bwaPost\b|sendText|sendTemplate|sendButtons|require\([^)]*(whatsapp|transport)[^)]*\)/i);
    expect(text).not.toMatch(/process\.env\.(STRIPE_SECRET_KEY|WA_TOKEN|JWT|MONGODB)/);
  });

  test('the only top-level requires of the pages sources are local helpers, express and the catalogue (nothing that connects or calls out)', () => {
    const allowed = /^(express|\.\/(index|layout|landing|pay|referral|instagram)|\.\.\/(catalog|mergeFields|scope|languageDetect)|\.\.\/\.\.\/shared\/localization\/pages(\/(pay|referral|instagram))?)$/;
    for (const file of files) {
      const topLevel = source(file).split('\n').filter((line) => /^(const|let|var)\b.*= require\(/.test(line) || /^const \{.*\} = require\(/.test(line));
      for (const line of topLevel) {
        const target = /require\('([^']+)'\)/.exec(line)[1];
        expect({ file, target, ok: allowed.test(target) }).toEqual({ file, target, ok: true });
      }
    }
  });
});
