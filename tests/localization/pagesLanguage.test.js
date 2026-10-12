// Language and rollout decisions for the Arabic customer pages (spec §3.5, CONTRACT
// "Customer pages"), plus the string catalogue those pages render. Pure unit tests:
// every collaborator is a fake, so no database, Stripe or network is ever touched.
const fs = require('fs');
const path = require('path');
const pages = require('../../shared/localization/pages');
const catalog = require('../../shared/localization/catalog');

const PAGES_DIR = path.join(__dirname, '..', '..', 'shared', 'localization', 'pages');

describe('?lang parameter', () => {
  test.each([
    ['ar', 'ar'], ['AR', 'ar'], ['  ar  ', 'ar'], ['ar-SA', 'ar'], ['ar_SA', 'ar'], ['ar-sa', 'ar'],
    ['en', 'en'], ['EN', 'en'], ['en-US', 'en'], ['en_GB', 'en'],
  ])('%j -> %s', (value, expected) => {
    expect(pages.parseLangParam(value)).toBe(expected);
  });

  test.each([
    [''], ['fr'], ['arabic'], ['ar;en'], ['a r'], ['ar<script>'], ['ar-'], ['ar-x'], ['../ar'],
    [undefined], [null], [5], [{}], [{ $ne: 'en' }], [['x']], ['a'.repeat(10000)],
  ])('%j is ignored', (value) => {
    expect(pages.parseLangParam(value)).toBeNull();
  });

  test('a repeated parameter: any "en" wins, so an explicit English request always reaches the English page', () => {
    expect(pages.parseLangParam(['ar', 'en'])).toBe('en');
    expect(pages.parseLangParam(['en', 'ar'])).toBe('en');
    expect(pages.parseLangParam(['ar'])).toBe('ar');
    expect(pages.parseLangParam(['fr', 'ar'])).toBe('ar');
    expect(pages.parseLangParam([1, 'ar'])).toBe('ar');
  });

  test('only the first five repeated values are looked at', () => {
    expect(pages.parseLangParam(['x', 'x', 'x', 'x', 'x', 'en'])).toBeNull();
  });
});

describe('Accept-Language', () => {
  test.each([
    ['ar', 'ar'],
    ['ar-SA', 'ar'],
    ['ar-SA,ar;q=0.9,en;q=0.8', 'ar'],
    ['en-US,en;q=0.9,ar;q=0.8', 'en'],
    ['fr-FR,fr;q=0.9,ar;q=0.8', 'ar'],
    ['fr-FR,fr;q=0.9,en;q=0.2', 'en'],
    ['ar;q=0,en;q=0.5', 'en'],
    ['en;q=0.5,ar;q=0.5', 'en'],
    ['ar;q=0.5,en;q=0.5', 'ar'],
    ['en,ar;q=1.0', 'en'],
    ['ar;q=0.9, en;q=0.95', 'en'],
    ['AR-sa', 'ar'],
    ['ar-Latn-SA', 'ar'],
    ['  ar  ', 'ar'],
    ['ar;q=abc,en;q=0.1', 'ar'],
    ['ar;q=7,en', 'ar'],
  ])('%j -> %s', (header, expected) => {
    expect(pages.parseAcceptLanguage(header)).toBe(expected);
  });

  test.each([
    [undefined], [null], [''], ['*'], ['fr'], ['fr-FR,de;q=0.8'], ['ar;q=0'], ['ar;q=0,en;q=0'], ['arabic'], ['aragonese'], [42], [['ar']],
  ])('%j -> no usable preference', (header) => {
    expect(pages.parseAcceptLanguage(header)).toBeNull();
  });

  test('a hostile header is bounded: only the first 24 entries / 512 characters count', () => {
    expect(pages.parseAcceptLanguage(`${'x,'.repeat(100)}ar`)).toBeNull();
    expect(pages.parseAcceptLanguage(`${'x'.repeat(600)},ar`)).toBeNull();
    expect(pages.parseAcceptLanguage(`${'x,'.repeat(10)}ar`)).toBe('ar');
    const started = Date.now();
    pages.parseAcceptLanguage(`${'ar-'.repeat(5000)}x`);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('request helpers', () => {
  test('firstString only ever returns a string', () => {
    expect(pages.firstString('a')).toBe('a');
    expect(pages.firstString(['x', 'y'])).toBe('x');
    expect(pages.firstString([1, 'y'])).toBe('y');
    expect(pages.firstString([1, 2])).toBe('');
    expect(pages.firstString({ a: 1 })).toBe('');
    expect(pages.firstString(undefined)).toBe('');
  });

  test('codes and PaymentIntent ids must look like ours before anything is looked up', () => {
    expect(pages.isPlausibleCode('ABCDEF1234')).toBe(true);
    expect(pages.isPlausibleCode('IG-ABCD1234')).toBe(true);
    for (const bad of ['', 'a b', 'a/b', '../x', '<x>', 'a'.repeat(65), undefined, null, 5, {}, ['x']]) {
      expect(pages.isPlausibleCode(bad)).toBe(false);
    }
    expect(pages.isPlausiblePaymentIntentId('pi_3PqXyZ2eZvKYlo2C1abcdEFG')).toBe(true);
    for (const bad of ['', 'pi_', 'cs_test_123', 'pi_a/b', 'pi_ a', `pi_${'a'.repeat(101)}`, 'PI_123', undefined, {}]) {
      expect(pages.isPlausiblePaymentIntentId(bad)).toBe(false);
    }
  });

  test('attribution parameters are coerced to short single-line strings', () => {
    expect(pages.readAttribution({ query: { src: 'flyer', medium: 'qr' } })).toEqual({ source: 'flyer', medium: 'qr' });
    expect(pages.readAttribution({ query: { source: 'ig' } })).toEqual({ source: 'ig', medium: undefined });
    expect(pages.readAttribution({ query: { src: 'a', source: 'b' } }).source).toBe('a');
    expect(pages.readAttribution({ query: { src: ['x', 'y'], medium: ['m'] } })).toEqual({ source: 'x', medium: 'm' });
    expect(pages.readAttribution({ query: { src: { $ne: 1 }, medium: 5 } })).toEqual({ source: undefined, medium: undefined });
    expect(pages.readAttribution({ query: { src: `a\nb\r\n${'z'.repeat(300)}` } }).source).toHaveLength(100);
    expect(pages.readAttribution({ query: { src: `a\nb` } }).source).toBe('a b');
    expect(pages.readAttribution({ query: { src: '   ' } }).source).toBeUndefined();
    expect(pages.readAttribution({})).toEqual({ source: undefined, medium: undefined });
  });

  test('"go" is a tap only for GET ?go=1 (HEAD requests from crawlers are not)', () => {
    expect(pages.isGoRequest({ method: 'GET', query: { go: '1' } })).toBe(true);
    expect(pages.isGoRequest({ method: 'GET', query: { go: ['1'] } })).toBe(true);
    expect(pages.isGoRequest({ method: 'HEAD', query: { go: '1' } })).toBe(false);
    for (const go of ['0', 'true', '', undefined, 1, { a: '1' }]) {
      expect(pages.isGoRequest({ method: 'GET', query: { go } })).toBe(false);
    }
    expect(pages.isGoRequest({ method: 'GET' })).toBe(false);
  });
});

describe('rebuildWaLink: the wa.me redirect target', () => {
  const link = 'https://wa.me/966500000000?text=Hi%2C%20English%20text';

  test('keeps the number, replaces the text, encodes spaces as %20 (WhatsApp shows "+" literally)', () => {
    const out = pages.rebuildWaLink(link, 'مرحباً Code: ABCDEF1234');
    expect(out.startsWith('https://wa.me/966500000000?text=')).toBe(true);
    expect(out).not.toContain('+');
    expect(out).toContain('%20Code%3A%20ABCDEF1234');
    expect(decodeURIComponent(out.split('?text=')[1])).toBe('مرحباً Code: ABCDEF1234');
    expect(out).not.toContain('English');
  });

  test('characters that would break a query string are encoded', () => {
    const out = pages.rebuildWaLink(link, 'a&b=c#d?e\nf');
    expect(out.split('?')).toHaveLength(2);
    expect(out).not.toMatch(/[&#\n ]/);
    expect(decodeURIComponent(out.split('?text=')[1])).toBe('a&b=c#d?e\nf');
  });

  test('business short links are accepted, credentials are dropped', () => {
    expect(pages.rebuildWaLink('https://wa.me/message/ABC123XYZ', 'x')).toBe('https://wa.me/message/ABC123XYZ?text=x');
    expect(pages.rebuildWaLink('https://user:pw@wa.me/966500000000', 'x')).toBe('https://wa.me/966500000000?text=x');
  });

  test.each([
    ['http://wa.me/966500000000'],
    ['https://evil.example/966500000000'],
    ['https://wa.me.evil.example/966500000000'],
    ['https://evilwa.me/966500000000'],
    ['https://wa.me@evil.example/966500000000'],
    ['https://wa.me/'],
    ['https://wa.me/../etc'],
    ['https://wa.me/966 500'],
    ['javascript:alert(1)'],
    ['//evil.example/966500000000'],
    ['not a url'],
    [''],
    [null],
    [undefined],
  ])('%j is never used as a redirect target', (bad) => {
    expect(pages.rebuildWaLink(bad, 'x')).toBeNull();
  });
});

describe('draft-copy policy (LOCALIZATION_ALLOW_DRAFT_PAGES)', () => {
  test('draft copy is served unless the variable is exactly "0"', () => {
    expect(pages.draftPagesAllowed({})).toBe(true);
    expect(pages.draftPagesAllowed(undefined)).toBe(true);
    expect(pages.draftPagesAllowed({ LOCALIZATION_ALLOW_DRAFT_PAGES: '1' })).toBe(true);
    expect(pages.draftPagesAllowed({ LOCALIZATION_ALLOW_DRAFT_PAGES: '' })).toBe(true);
    expect(pages.draftPagesAllowed({ LOCALIZATION_ALLOW_DRAFT_PAGES: '0' })).toBe(false);
  });

  test('all pages.* Arabic strings ship as draft, so a "reviewed only" policy blocks them today', () => {
    for (const groups of [['common', 'pay'], ['common', 'referral'], ['common', 'instagram']]) {
      expect(pages.arabicCopyReviewed(catalog, groups)).toBe(false);
    }
  });

  test('a group counts as reviewed only when EVERY Arabic string of the groups is reviewed', () => {
    const entries = [
      { key: 'pages.common.a', ar: 'x', status: 'reviewed' },
      { key: 'pages.pay.a', ar: 'x', status: 'reviewed' },
      { key: 'pages.pay.b', ar: 'x', status: 'draft' },
      { key: 'pages.referral.a', ar: 'x', status: 'reviewed' },
      { key: 'consent.a', ar: 'x', status: 'draft' },
      { key: 'pages.instagram.a', ar: '', status: 'draft' },
    ];
    const fake = { listEntries: () => entries };
    expect(pages.arabicCopyReviewed(fake, ['common', 'pay'])).toBe(false);
    expect(pages.arabicCopyReviewed(fake, ['common', 'referral'])).toBe(true);
    expect(pages.arabicCopyReviewed(fake, ['common', 'instagram'])).toBe(true); // an entry without Arabic is not an Arabic string
    expect(pages.arabicCopyReviewed({ listEntries: () => [] }, ['common'])).toBe(false);
  });
});

describe('ttlMemo', () => {
  test('one load per TTL window, concurrent callers share the in-flight load', async () => {
    let clock = 1000;
    const load = jest.fn(async () => { await Promise.resolve(); return `v${clock}`; });
    const get = pages.ttlMemo(load, { ttlMs: 100, now: () => clock });
    const [a, b] = await Promise.all([get(), get()]);
    expect([a, b]).toEqual(['v1000', 'v1000']);
    expect(load).toHaveBeenCalledTimes(1);
    clock += 99;
    expect(await get()).toBe('v1000');
    expect(load).toHaveBeenCalledTimes(1);
    clock += 2;
    expect(await get()).toBe('v1101');
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('a failure is not cached and does not block the next attempt', async () => {
    const load = jest.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(true);
    const get = pages.ttlMemo(load, { ttlMs: 1000, now: () => 5 });
    await expect(get()).rejects.toThrow('db down');
    await expect(get()).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test('falsy results (false / null) are cached too', async () => {
    const load = jest.fn(async () => null);
    const get = pages.ttlMemo(load, { ttlMs: 1000, now: () => 5 });
    await get();
    await get();
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  test('passes the result through and clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const p = pages.withTimeout(Promise.resolve('ok'), 50, 'x');
      await expect(p).resolves.toBe('ok');
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  test('passes failures through', async () => {
    await expect(pages.withTimeout(Promise.reject(new Error('boom')), 50, 'x')).rejects.toThrow('boom');
  });

  test('rejects once the budget is spent', async () => {
    await expect(pages.withTimeout(new Promise(() => {}), 15, 'lookup')).rejects.toThrow('lookup timed out after 15 ms');
  });

  test('a promise that fails AFTER the timeout never becomes an unhandled rejection (it would kill Node 22)', async () => {
    // Jest fails a test whose run produces an unhandled rejection, so reaching the end proves there was none.
    let fail;
    const slow = new Promise((resolve, reject) => { fail = reject; });
    await expect(pages.withTimeout(slow, 10, 'x')).rejects.toThrow(/timed out/);
    fail(new Error('late failure'));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
});

describe('rollout lookups', () => {
  test('anyArabicEnabled asks the flag collection once per 30 s', async () => {
    let clock = 0;
    const LocaleSettings = { exists: jest.fn(async () => ({ _id: 'x' })) };
    const { anyArabicEnabled } = pages.createRolloutLookups({ LocaleSettings, Workspace: {}, now: () => clock });
    expect(await anyArabicEnabled()).toBe(true);
    expect(await anyArabicEnabled()).toBe(true);
    expect(LocaleSettings.exists).toHaveBeenCalledTimes(1);
    expect(LocaleSettings.exists).toHaveBeenCalledWith({ arabicEnabled: true });
    LocaleSettings.exists.mockResolvedValue(null);
    clock += 30001;
    expect(await anyArabicEnabled()).toBe(false);
    expect(LocaleSettings.exists).toHaveBeenCalledTimes(2);
  });

  test('oldestWorkspaceId mirrors server.js: oldest workspace first, id as a string, null when none', async () => {
    const calls = [];
    const query = (value) => {
      const q = { sort: (s) => { calls.push(['sort', s]); return q; }, select: (s) => { calls.push(['select', s]); return q; }, lean: async () => value };
      return q;
    };
    const Workspace = { findOne: jest.fn(() => query({ _id: { toString: () => '64b000000000000000000001' } })) };
    const { oldestWorkspaceId } = pages.createRolloutLookups({ LocaleSettings: {}, Workspace });
    expect(await oldestWorkspaceId()).toBe('64b000000000000000000001');
    expect(calls).toContainEqual(['sort', { createdAt: 1 }]);

    const empty = pages.createRolloutLookups({ LocaleSettings: {}, Workspace: { findOne: () => query(null) } });
    expect(await empty.oldestWorkspaceId()).toBeNull();
  });
});

describe('lazy Stripe client', () => {
  test('the SDK is only loaded when a key exists, memoised, and rebuilt when the key changes', () => {
    jest.isolateModules(() => {
      const ctor = jest.fn((key) => ({ key }));
      jest.doMock('stripe', () => ctor);
      const { createStripeGetter } = require('../../shared/localization/pages');
      const env = {};
      const getStripe = createStripeGetter(env);
      expect(getStripe()).toBeNull();
      expect(ctor).not.toHaveBeenCalled();
      env.STRIPE_SECRET_KEY = 'sk_test_a';
      const first = getStripe();
      expect(first).toEqual({ key: 'sk_test_a' });
      expect(getStripe()).toBe(first);
      env.STRIPE_SECRET_KEY = 'sk_test_b';
      expect(getStripe()).toEqual({ key: 'sk_test_b' });
      expect(ctor).toHaveBeenCalledTimes(2);
      delete env.STRIPE_SECRET_KEY;
      expect(getStripe()).toBeNull();
    });
  });
});

describe('decidePageLanguage', () => {
  function makeDeps(over = {}) {
    return {
      env: {},
      catalog,
      settings: { killSwitchOn: jest.fn(() => false), isArabicEnabled: jest.fn(async () => true) },
      dbReady: jest.fn(() => true),
      anyArabicEnabled: jest.fn(async () => true),
      ...over,
    };
  }
  const request = (query = {}, headers = {}) => ({ query, headers });
  const PAGE_CTX = { workspaceId: 'ws1' };
  // ctx is passed through exactly as given (null / undefined / {} included).
  function decide(deps, req, ctx = PAGE_CTX, groups = ['common']) {
    const loadContext = jest.fn(async () => ctx);
    const promise = pages.decidePageLanguage({ req, deps, groups, loadContext });
    return promise.then((decision) => ({ decision, loadContext }));
  }

  test('kill switch: English before anything else is touched', async () => {
    const deps = makeDeps({ settings: { killSwitchOn: jest.fn(() => true), isArabicEnabled: jest.fn() } });
    const { decision, loadContext } = await decide(deps, request({ lang: 'ar' }, { 'accept-language': 'ar' }));
    expect(decision).toMatchObject({ language: 'en', reason: 'kill_switch' });
    expect(deps.dbReady).not.toHaveBeenCalled();
    expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
  });

  test('?lang=en is English with no lookups at all, even for an Arabic browser and an Arabic customer', async () => {
    const deps = makeDeps();
    const ctx = { workspaceId: 'ws1', getStoredLanguage: jest.fn(async () => 'ar') };
    const { decision, loadContext } = await decide(deps, request({ lang: 'en' }, { 'accept-language': 'ar' }), ctx);
    expect(decision).toMatchObject({ language: 'en', reason: 'explicit_en' });
    expect(deps.dbReady).not.toHaveBeenCalled();
    expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
    expect(ctx.getStoredLanguage).not.toHaveBeenCalled();
  });

  test('a repeated ?lang with an "en" in it is English', async () => {
    const { decision } = await decide(makeDeps(), request({ lang: ['ar', 'en'] }));
    expect(decision.language).toBe('en');
  });

  test('database not connected: English immediately, no waiting on a dead connection', async () => {
    const deps = makeDeps({ dbReady: jest.fn(() => false) });
    const { decision, loadContext } = await decide(deps, request({ lang: 'ar' }));
    expect(decision).toMatchObject({ language: 'en', reason: 'db_unavailable' });
    expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
  });

  test('draft-copy policy blocks Arabic before any database lookup', async () => {
    const deps = makeDeps({ env: { LOCALIZATION_ALLOW_DRAFT_PAGES: '0' } });
    const { decision, loadContext } = await decide(deps, request({ lang: 'ar' }), undefined, ['common', 'pay']);
    expect(decision).toMatchObject({ language: 'en', reason: 'draft_copy_blocked' });
    expect(deps.anyArabicEnabled).not.toHaveBeenCalled();
    expect(loadContext).not.toHaveBeenCalled();
  });

  test('draft-copy policy lets reviewed copy through, and the default allows drafts', async () => {
    const reviewed = { listEntries: () => [{ key: 'pages.common.a', ar: 'x', status: 'reviewed' }] };
    const blockedEnv = { LOCALIZATION_ALLOW_DRAFT_PAGES: '0' };
    expect((await decide(makeDeps({ env: blockedEnv, catalog: reviewed }), request({ lang: 'ar' }))).decision.language).toBe('ar');
    expect((await decide(makeDeps({ env: {} }), request({ lang: 'ar' }), undefined, ['common', 'pay'])).decision.language).toBe('ar');
  });

  test('no merchant anywhere has Arabic: English without looking up a workspace', async () => {
    const deps = makeDeps({ anyArabicEnabled: jest.fn(async () => false) });
    const { decision, loadContext } = await decide(deps, request({ lang: 'ar' }, { 'accept-language': 'ar' }));
    expect(decision).toMatchObject({ language: 'en', reason: 'not_rolled_out' });
    expect(loadContext).not.toHaveBeenCalled();
    expect(deps.settings.isArabicEnabled).not.toHaveBeenCalled();
  });

  test.each([[null], [{}], [{ workspaceId: null }], [{ workspaceId: '' }]])('no workspace (%j): English', async (ctx) => {
    const { decision } = await decide(makeDeps(), request({ lang: 'ar' }), ctx);
    expect(decision).toMatchObject({ language: 'en', reason: 'no_workspace' });
  });

  test('a lookup that returns nothing at all (undefined) is also "no workspace"', async () => {
    const deps = makeDeps();
    const decision = await pages.decidePageLanguage({ req: request({ lang: 'ar' }), deps, groups: ['common'], loadContext: async () => undefined });
    expect(decision).toMatchObject({ language: 'en', reason: 'no_workspace' });
    expect(deps.settings.isArabicEnabled).not.toHaveBeenCalled();
  });

  test('the flag is checked for exactly the page\'s workspace, and a workspace without it is English whatever the visitor asks for', async () => {
    const deps = makeDeps({ settings: { killSwitchOn: () => false, isArabicEnabled: jest.fn(async () => false) } });
    const ctx = { workspaceId: 'ws-other', getStoredLanguage: jest.fn(async () => 'ar') };
    for (const [query, headers] of [[{ lang: 'ar' }, {}], [{}, { 'accept-language': 'ar' }], [{}, {}]]) {
      const { decision } = await decide(deps, request(query, headers), ctx);
      expect(decision).toMatchObject({ language: 'en', reason: 'flag_off' });
    }
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith('ws-other');
    expect(ctx.getStoredLanguage).not.toHaveBeenCalled();
  });

  test('?lang=ar wins over everything, and the customer lookup is never made', async () => {
    const ctx = { workspaceId: 'ws1', getStoredLanguage: jest.fn(async () => 'en'), getHintLanguage: jest.fn(async () => 'en') };
    const { decision } = await decide(makeDeps(), request({ lang: 'ar' }, { 'accept-language': 'en-US,en;q=0.9' }), ctx);
    expect(decision).toMatchObject({ language: 'ar', reason: 'explicit' });
    expect(ctx.getStoredLanguage).not.toHaveBeenCalled();
    expect(ctx.getHintLanguage).not.toHaveBeenCalled();
  });

  test('stored customer language beats the browser, in both directions', async () => {
    const arabicCustomer = { workspaceId: 'ws1', getStoredLanguage: async () => 'ar' };
    const englishCustomer = { workspaceId: 'ws1', getStoredLanguage: async () => 'en' };
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'en-US' }), arabicCustomer)).decision).toMatchObject({ language: 'ar', reason: 'customer' });
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'ar-SA' }), englishCustomer)).decision).toMatchObject({ language: 'en', reason: 'customer' });
  });

  test('an unknown or missing customer language defers to the browser', async () => {
    for (const stored of ['unknown', null, undefined, 'fr']) {
      const ctx = { workspaceId: 'ws1', getStoredLanguage: async () => stored };
      expect((await decide(makeDeps(), request({}, { 'accept-language': 'ar' }), ctx)).decision).toMatchObject({ language: 'ar', reason: 'browser' });
      expect((await decide(makeDeps(), request({}, { 'accept-language': 'en' }), ctx)).decision).toMatchObject({ language: 'en', reason: 'browser' });
    }
  });

  test('an invalid ?lang is ignored (it is not an explicit choice)', async () => {
    const ctx = { workspaceId: 'ws1', getStoredLanguage: async () => 'ar' };
    expect((await decide(makeDeps(), request({ lang: 'fr' }), ctx)).decision).toMatchObject({ language: 'ar', reason: 'customer' });
  });

  test('Arabic browser alone is enough once the merchant is enabled; no signal at all is English', async () => {
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'ar-SA,ar;q=0.9,en;q=0.8' }))).decision).toMatchObject({ language: 'ar', reason: 'browser' });
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'en-US,en;q=0.9,ar;q=0.8' }))).decision).toMatchObject({ language: 'en', reason: 'browser' });
    expect((await decide(makeDeps(), request())).decision).toMatchObject({ language: 'en', reason: 'default' });
    expect((await decide(makeDeps(), { query: undefined, headers: undefined })).decision).toMatchObject({ language: 'en', reason: 'default' });
  });

  test('the referrer-language hint only matters when the browser says nothing about ar/en', async () => {
    const arabicReferrer = { workspaceId: 'ws1', getHintLanguage: jest.fn(async () => 'ar') };
    expect((await decide(makeDeps(), request(), arabicReferrer)).decision).toMatchObject({ language: 'ar', reason: 'hint' });
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'fr' }), arabicReferrer)).decision).toMatchObject({ language: 'ar', reason: 'hint' });
    arabicReferrer.getHintLanguage.mockClear();
    expect((await decide(makeDeps(), request({}, { 'accept-language': 'en-US' }), arabicReferrer)).decision).toMatchObject({ language: 'en', reason: 'browser' });
    expect(arabicReferrer.getHintLanguage).not.toHaveBeenCalled();
    for (const hint of ['en', 'unknown', null]) {
      expect((await decide(makeDeps(), request(), { workspaceId: 'ws1', getHintLanguage: async () => hint })).decision).toMatchObject({ language: 'en', reason: 'default' });
    }
  });

  test('a failing lookup rejects (the router turns that into "fall through to English")', async () => {
    const deps = makeDeps();
    await expect(pages.decidePageLanguage({ req: request({ lang: 'ar' }), deps, groups: [], loadContext: async () => { throw new Error('db'); } })).rejects.toThrow('db');
    const flagFails = makeDeps({ settings: { killSwitchOn: () => false, isArabicEnabled: jest.fn(async () => { throw new Error('flag'); }) } });
    await expect(decide(flagFails, request({ lang: 'ar' }))).rejects.toThrow('flag');
    const gateFails = makeDeps({ anyArabicEnabled: jest.fn(async () => { throw new Error('gate'); }) });
    await expect(decide(gateFails, request({ lang: 'ar' }))).rejects.toThrow('gate');
  });
});

describe('catalogue: pages namespace (customer-visible strings)', () => {
  beforeAll(() => catalog.reload());
  const entries = () => catalog.listEntries().filter((e) => e.key.startsWith('pages.'));

  test('the namespace exists and only uses the four string groups', () => {
    expect(entries().length).toBeGreaterThan(40);
    for (const e of entries()) expect(e.key).toMatch(/^pages\.(common|pay|referral|instagram)\./);
  });

  test('every string has English and Arabic, ships as draft and carries no review claim (spec §8)', () => {
    for (const e of entries()) {
      expect(e.en.length).toBeGreaterThan(0);
      expect(e.ar.length).toBeGreaterThan(0);
      expect(e.status).toBe('draft');
      expect(e.reviewer).toBeNull();
      expect(e.needsLegalApproval).toBe(false);
    }
  });

  test('{placeholders} are identical in English and Arabic', () => {
    for (const e of entries()) {
      const fields = (s) => Array.from(s.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g), (m) => m[1]).sort();
      expect({ key: e.key, fields: fields(e.ar) }).toEqual({ key: e.key, fields: fields(e.en) });
    }
  });

  test('Arabic copy follows the glossary: واتساب (never Latin WhatsApp), Western digits, ر.س, website tanween, clean whitespace', () => {
    for (const e of entries()) {
      expect(e.ar).not.toMatch(/whatsapp/i);
      expect(e.ar).not.toMatch(/[\u{0660}-\u{0669}\u{06F0}-\u{06F9}]/u);
      expect(e.ar).not.toMatch(/\u{064B}\u{0627}/u); // fathatan before alef (شكرًا) - the website writes alef then fathatan (شكراً)
      expect(e.ar).not.toMatch(/[\p{Cf}\u{00A0}]/u);
      expect(e.ar).toBe(e.ar.trim());
      expect(e.ar).not.toMatch(/ {2,}/);
    }
    expect(catalog.t('ar', 'pages.common.currencySAR')).toBe('ر.س');
    expect(catalog.t('ar', 'pages.common.continueToWhatsApp')).toBe('المتابعة على واتساب');
  });

  test('every English string of the existing customer pages (audit R7 §1.2) has an Arabic counterpart', () => {
    const existingEnglish = [
      'Not found', 'Payment link not found', 'This link may have expired.',
      'Already paid', 'This order has already been paid. You can return to WhatsApp.',
      'Complete Your Payment', '{currency} · Order total below', 'Subtotal', 'Shipping', 'Total', '📍 Delivering to: {address}', 'Pay {amount}',
      'Cancel and return to WhatsApp', 'Payment failed. Please try again.', '✅ Payment successful! You can return to WhatsApp now.',
      'Payment', 'Payment status unknown', 'Payment successful', 'Payment successful!', 'You can return to WhatsApp now.',
      'Payment failed', 'Payment not completed', "Your payment wasn't completed. You can try again or cancel.", 'Try Again',
      'No worries! Your cart has been cleared. Feel free to browse again anytime. 🛍️',
      'Cancelled', 'Payment cancelled', 'Return to WhatsApp to keep shopping.',
      'Link not found', 'This referral link is invalid, expired, or no longer active.',
      'Something went wrong', 'Please try again in a moment.',
      "Hi, I'd like to claim my referral offer.", "Hi, I'd like to claim the {name} offer.",
      'This link is invalid or no longer active.',
    ];
    const byEnglish = new Map(entries().map((e) => [e.en, e]));
    for (const english of existingEnglish) {
      const entry = byEnglish.get(english);
      expect({ english, found: !!entry }).toEqual({ english, found: true });
      expect(entry.ar.length).toBeGreaterThan(0);
    }
  });

  test('every key the page modules use exists, and only the reference-only string is unused', () => {
    const used = new Set();
    for (const file of fs.readdirSync(PAGES_DIR).filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
      for (const m of source.matchAll(/['"`](?:pages\.)?((?:common|pay|referral|instagram)\.[A-Za-z0-9.]+)['"`]/g)) used.add(`pages.${m[1]}`);
    }
    const defined = new Set(entries().map((e) => e.key));
    expect(Array.from(used).filter((k) => !defined.has(k))).toEqual([]);
    expect(Array.from(defined).filter((k) => !used.has(k))).toEqual(['pages.pay.cancelledWhatsApp']);
  });

  test('the prefilled WhatsApp sentences contain no merge field and no Latin "Code:" (the code appends its own)', () => {
    for (const key of ['pages.referral.prefill', 'pages.instagram.prefillGeneric']) {
      expect(catalog.t('ar', key)).not.toMatch(/[{}]/);
    }
    for (const key of ['pages.referral.prefill', 'pages.instagram.prefill', 'pages.instagram.prefillGeneric']) {
      expect(catalog.t('ar', key)).not.toMatch(/code/i);
      expect(catalog.t('en', key)).not.toMatch(/code/i);
    }
  });
});
