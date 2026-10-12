// The Arabic referral (/r/:code, /c/:code) and Instagram tracking (/t/:code) pages,
// through the real router with FAKE models and FAKE click recorders: no database, no
// WhatsApp, no network. The properties that matter:
//   * the Arabic interstitial NEVER records a click; only the "continue" tap (?go=1) does,
//     exactly once, through the same exported function the English handler calls;
//   * the redirect goes to wa.me with Arabic text that still carries a plain Latin
//     `Code: <TOKEN>` (the inbound detection regexes are copied from shared/referrals.js
//     and shared/instagram.js below), with no direction mark between the colon and the code;
//   * once a click is recorded the English handler can never run (it would record it twice);
//   * the page is PUBLIC (anyone holding the link sees it), so it shows nothing about the
//     customer who shared it - not even a first name - only the merchant's business name,
//     the promotion and its reward text; the referrer's customer record is never read.
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/localization/pages');
const catalog = require('../../shared/localization/catalog');
const { classifyInboundText } = require('../../shared/localization/keywords');

const WS = '64b000000000000000000001';
const OTHER_WS = '64b000000000000000000002';
const PROMO = '64b0000000000000000000d1';
const REFERRER = '64b0000000000000000000c1';
const POST = '64b0000000000000000000e1';
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const SENTINEL = 'EXISTING-ENGLISH-HANDLER';
const WA_LINK = 'https://wa.me/966500000000?text=Hi%2C%20I%27d%20like%20to%20claim%20my%20referral%20offer.%20Code%3A%20ABCDEF1234';

// The detection regexes the existing inbound hooks use (shared/referrals.js, shared/instagram.js).
const REFERRAL_CODE_PATTERN = /code:\s*([A-F0-9]{10})/i;
const TRACKING_CODE_PATTERN = new RegExp('code:\\s*(IG-[A-Z0-9]{8})', 'i');
const BIDI_AND_INVISIBLES = /[\p{Cf}\u{2028}\u{2029}\u{00A0}]/u;

const query = (value) => { const q = { select: () => q, sort: () => q, lean: () => Promise.resolve(value) }; return q; };
function model(resolve) {
  const calls = [];
  const run = (filter) => { calls.push(filter); return query(typeof resolve === 'function' ? resolve(filter) : resolve); };
  return { calls, findOne: run, findById: (id) => run({ _id: id }) };
}

const activeCode = (over = {}) => ({ workspaceId: WS, referralPromotionId: PROMO, referrerCustomerId: REFERRER, status: 'active', ...over });

function makeDeps(over = {}) {
  return {
    env: {},
    now: () => NOW,
    precheckTimeoutMs: 1000,
    settings: { killSwitchOn: jest.fn(() => false), isArabicEnabled: jest.fn(async (ws) => ws === WS) },
    catalog,
    dbReady: () => true,
    anyArabicEnabled: jest.fn(async () => true),
    oldestWorkspaceId: jest.fn(async () => WS),
    models: {
      ReferralCode: model(activeCode()),
      ReferralPromotion: model({ name: 'خصم 15% للأصدقاء', status: 'active' }),
      Customer: model({ firstname: 'محمد' }), // the REFERRER: must never be read for the page (see "privacy")
      CustomerLanguage: model(null),
      Settings: model({ merchantName: 'مقهى الرياض' }),
      Workspace: model({ name: 'Riyadh Cafe' }),
      TrackingLink: model({ workspaceId: WS, instagramPostId: POST }),
      InstagramPost: model({ name: 'Summer Sale 2026' }),
    },
    recordReferralClick: jest.fn(async () => ({ waLink: WA_LINK, referralCode: { code: 'ABCDEF1234' }, promotion: {}, referral: {} })),
    recordTrackingClick: jest.fn(async () => ({ waLink: WA_LINK, post: { name: 'Summer Sale 2026', promotionCode: 'IG-ABCD1234' } })),
    ...over,
  };
}

function makeApp(deps) {
  const app = express();
  app.use(createRouter(() => deps));
  app.use((req, res) => res.status(200).send(SENTINEL));
  return app;
}
const get = (deps, url, headers = {}) => request(makeApp(deps)).get(url).set(headers);
const AR = { 'Accept-Language': 'ar-SA,ar;q=0.9' };

// The prefilled WhatsApp text a redirect carries, decoded.
function prefilled(res) {
  const location = new URL(res.headers.location);
  expect(location.origin).toBe('https://wa.me');
  return location.searchParams.get('text');
}

let errorSpy;
beforeEach(() => { errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { errorSpy.mockRestore(); });

describe('referral link: the Arabic interstitial', () => {
  test('is a right-to-left Arabic page with ONE big continue button and a visible English switch', async () => {
    const deps = makeDeps();
    const res = await get(deps, '/r/ABCDEF1234', AR);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-language']).toBe('ar');
    const html = res.text;
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('<title>عرض خاص لك</title>');
    expect(html).toContain('<h1>عرض خاص لك</h1>');
    expect(html).toContain('<p>تمت دعوتك للاستفادة من هذا العرض من <bdi>مقهى الرياض</bdi>.</p>');
    expect(html).not.toContain('محمد'); // the referrer's first name is gone
    expect(html).not.toContain('دعاك');
    expect(html).toContain('<p class="muted">العرض: <bdi>خصم 15% للأصدقاء</bdi></p>');
    expect(html).toContain('اضغط الزر أدناه لفتح واتساب برسالة جاهزة والاستفادة من عرضك.');
    expect(html).toContain('<a class="btn" href="/r/ABCDEF1234?lang=ar&amp;go=1" rel="nofollow">المتابعة على واتساب</a>');
    expect(html.match(/class="btn"/g)).toHaveLength(1);
    expect(html).toContain('<a href="/r/ABCDEF1234?lang=en" hreflang="en" lang="en" dir="ltr"');
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('<script');
  });

  test('NEVER records a click: not on the page, not on a 404, not for HEAD', async () => {
    const deps = makeDeps();
    await get(deps, '/r/ABCDEF1234', AR);
    await get(deps, '/r/ABCDEF1234?lang=ar');
    await request(makeApp(deps)).head('/r/ABCDEF1234?lang=ar&go=1');
    deps.models.ReferralCode = model(null);
    await get(deps, '/r/ABCDEF1234?lang=ar');
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
    expect(deps.recordTrackingClick).not.toHaveBeenCalled();
  });

  test('the generic /c/ link has no referrer: the same business invitation, no customer lookup', async () => {
    const deps = makeDeps();
    deps.models.ReferralCode = model(activeCode({ referrerCustomerId: undefined }));
    const html = (await get(deps, '/c/ABCDEF1234?lang=ar')).text;
    expect(html).toContain('<p>تمت دعوتك للاستفادة من هذا العرض من <bdi>مقهى الرياض</bdi>.</p>');
    expect(html).toContain('href="/c/ABCDEF1234?lang=ar&amp;go=1"');
    expect(html).toContain('href="/c/ABCDEF1234?lang=en"');
    expect(deps.models.Customer.calls).toEqual([]);
    expect(deps.models.CustomerLanguage.calls).toEqual([]);
  });

  test('attribution parameters survive the tap and the language switch (encoded)', async () => {
    const html = (await get(makeDeps(), '/c/ABCDEF1234?lang=ar&src=flyer%20A&medium=qr&junk=1')).text;
    expect(html).toContain('href="/c/ABCDEF1234?lang=ar&amp;go=1&amp;src=flyer%20A&amp;medium=qr"');
    expect(html).toContain('href="/c/ABCDEF1234?lang=en&amp;src=flyer%20A&amp;medium=qr"');
    expect(html).not.toContain('junk');
  });

  test('hostile merchant, offer and reward text is escaped; there is no script on the page', async () => {
    const deps = makeDeps();
    deps.models.Settings = model({ merchantName: '<script>alert(1)</script>' });
    deps.models.ReferralPromotion = model({ name: '"><img src=x onerror=alert(2)>', status: 'active', friendRewardLabel: "<b onmouseover=alert(3)>free</b>'" });
    const html = (await get(deps, '/r/ABCDEF1234?lang=ar&src=%22%3E%3Cscript%3E')).text;
    expect(html).toContain('<bdi>&lt;script&gt;alert(1)&lt;/script&gt;</bdi>');
    expect(html).toContain('<bdi>&quot;&gt;&lt;img src=x onerror=alert(2)&gt;</bdi>');
    expect(html).toContain('<bdi>&lt;b onmouseover=alert(3)&gt;free&lt;/b&gt;&#39;</bdi>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b onmouseover');
    expect(html).not.toContain('<script');
    expect(html).toContain('src=%22%3E%3Cscript%3E'); // the hostile ?src= only ever appears percent-encoded
  });

  describe('the merchant context: business name and reward text (everything the page may show)', () => {
    test('the merchant name comes from Settings.merchantName, then the workspace name; an auto-generated "<x>\'s Workspace" is never shown', async () => {
      const fromSettings = makeDeps();
      expect((await get(fromSettings, '/r/ABCDEF1234?lang=ar')).text).toContain('<bdi>مقهى الرياض</bdi>');
      expect(fromSettings.models.Settings.calls).toEqual([{ workspaceId: WS }]);
      expect(fromSettings.models.Workspace.calls).toEqual([]); // not needed

      const fromWorkspace = makeDeps();
      fromWorkspace.models.Settings = model({ merchantName: '   ' });
      expect((await get(fromWorkspace, '/r/ABCDEF1234?lang=ar')).text).toContain('<bdi>Riyadh Cafe</bdi>');
      expect(fromWorkspace.models.Workspace.calls).toEqual([{ _id: WS }]);

      for (const settings of [null, { merchantName: '' }]) {
        const auto = makeDeps();
        auto.models.Settings = model(settings);
        auto.models.Workspace = model({ name: "Sara's Workspace" });
        const html = (await get(auto, '/r/ABCDEF1234?lang=ar')).text;
        expect(html).toContain('<p>تمت دعوتك للاستفادة من هذا العرض.</p>'); // generic invitation
        expect(html).not.toContain('Workspace');
        expect(html).not.toContain('Sara');
      }
    });

    test('a long merchant name is shortened and bidi controls are stripped', async () => {
      const long = makeDeps();
      long.models.Settings = model({ merchantName: 'س'.repeat(120) });
      const html = (await get(long, '/r/ABCDEF1234?lang=ar')).text;
      expect(html).toContain(`<bdi>${'س'.repeat(80)}</bdi>`);
      expect(html).not.toContain('س'.repeat(81));

      const bidi = makeDeps();
      bidi.models.Settings = model({ merchantName: 'Cafe\u{202E}x\u{200F}' });
      expect((await get(bidi, '/r/ABCDEF1234?lang=ar')).text).toContain('<bdi>Cafe x</bdi>');
    });

    test('the reward text of the promotion is shown on its own line when the merchant wrote one', async () => {
      const deps = makeDeps();
      deps.models.ReferralPromotion = model({ name: 'خصم للأصدقاء', status: 'active', friendRewardLabel: 'حلى مجاني' });
      const html = (await get(deps, '/r/ABCDEF1234?lang=ar')).text;
      expect(html).toContain('<p class="muted">العرض: <bdi>خصم للأصدقاء</bdi><br>مكافأتك: <bdi>حلى مجاني</bdi></p>');
      expect(deps.models.ReferralPromotion.calls).toEqual([{ _id: PROMO, workspaceId: WS }]);

      const rewardOnly = makeDeps();
      rewardOnly.models.ReferralPromotion = model({ name: '', status: 'active', friendRewardLabel: 'حلى مجاني' });
      expect((await get(rewardOnly, '/r/ABCDEF1234?lang=ar')).text).toContain('<p class="muted">مكافأتك: <bdi>حلى مجاني</bdi></p>');
    });

    test('the business-name lookup is cosmetic: when it fails the page still renders with the generic invitation', async () => {
      const deps = makeDeps();
      deps.models.Settings = model(() => { throw new Error('cosmos'); });
      const res = await get(deps, '/r/ABCDEF1234?lang=ar');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<p>تمت دعوتك للاستفادة من هذا العرض.</p>');
      expect(res.text).toContain('المتابعة على واتساب');
    });
  });

  describe('privacy: the page is public, so it shows nothing about the customer who shared the link', () => {
    test.each([
      ['a first name', { firstname: 'محمد', lastname: 'العتيبي', phone: '966501234567', email: 'mohammed@example.com' }],
      ['a Latin first name', { firstname: 'Sara', lastname: 'Khan', phone: '+966 50 765 4321', email: 'sara@example.com' }],
      ['a phone number as the name (WhatsApp contact without a profile name)', { firstname: '966501234567', phone: '966501234567' }],
      ['an email address', { firstname: 'sara@example.com' }],
      ['an erased customer', { firstname: 'محمد', deletedAt: new Date() }],
    ])('a referrer with %s: none of it appears, and the customer record is never even read', async (label, referrer) => {
      const deps = makeDeps();
      deps.models.Customer = model(referrer);
      const res = await get(deps, '/r/ABCDEF1234?lang=ar');
      expect(res.status).toBe(200);
      for (const value of Object.values(referrer)) {
        if (typeof value === 'string' && value) expect(res.text).not.toContain(value);
      }
      expect(res.text).not.toContain('دعاك');
      expect(res.text).not.toMatch(/invited you/i);
      expect(deps.models.Customer.calls).toEqual([]); // not a single lookup of the referrer
    });

    test('a personal link (/r/) and the generic link (/c/) show exactly the same content', async () => {
      const personal = (await get(makeDeps(), '/r/ABCDEF1234?lang=ar')).text;
      const deps = makeDeps();
      deps.models.ReferralCode = model(activeCode({ referrerCustomerId: undefined }));
      const generic = (await get(deps, '/c/ABCDEF1234?lang=ar')).text;
      expect(personal.replace(/\/r\//g, '/c/')).toBe(generic);
    });

    test('the only thing the referrer record still contributes is its stored LANGUAGE, as a hint that picks the page language and is never displayed', async () => {
      const deps = makeDeps();
      deps.models.CustomerLanguage = model({ language: 'ar' });
      const html = (await get(deps, '/r/ABCDEF1234')).text; // no ?lang, no Accept-Language
      expect(html).toContain('lang="ar"');
      expect(deps.models.CustomerLanguage.calls).toEqual([{ workspaceId: WS, customerId: REFERRER }]);
      expect(deps.models.Customer.calls).toEqual([]);
    });

    test('the catalogue has no string that names the referrer (no "{name}" placeholder in the referral group)', () => {
      const keys = catalog.listEntries().map((e) => e.key).filter((k) => k.startsWith('pages.referral.'));
      expect(keys).not.toContain('pages.referral.invitedBy');
      for (const key of keys) {
        const entry = catalog.listEntries().find((e) => e.key === key);
        expect(`${entry.en} ${entry.ar}`).not.toContain('{name}');
      }
    });
  });

  test('a promotion without a name simply omits the offer line', async () => {
    const deps = makeDeps();
    deps.models.ReferralPromotion = model({ name: '', status: 'active' });
    const html = (await get(deps, '/r/ABCDEF1234?lang=ar')).text;
    expect(html).not.toContain('العرض:');
    expect(html).toContain('المتابعة على واتساب');
  });
});

describe('referral link: unusable links get an Arabic 404 (and still record nothing)', () => {
  test.each([
    ['a code that does not exist', (d) => { d.models.ReferralCode = model(null); }],
    ['a disabled code', (d) => { d.models.ReferralCode = model(activeCode({ status: 'disabled' })); }],
    ['an expired code', (d) => { d.models.ReferralCode = model(activeCode({ status: 'expired' })); }],
    ['a promotion that ended', (d) => { d.models.ReferralPromotion = model({ name: 'x', status: 'ended' }); }],
    ['a promotion past its end date', (d) => { d.models.ReferralPromotion = model({ name: 'x', status: 'active', endsAt: new Date(NOW - 1000) }); }],
    ['a promotion that was removed', (d) => { d.models.ReferralPromotion = model(null); }],
    ['a code without a promotion id', (d) => { d.models.ReferralCode = model(activeCode({ referralPromotionId: undefined })); }],
  ])('%s', async (label, arrange) => {
    const deps = makeDeps();
    arrange(deps);
    const res = await get(deps, '/r/ABCDEF1234?lang=ar');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<html lang="ar" dir="rtl">');
    expect(res.text).toContain('<h1>الرابط غير موجود</h1>');
    expect(res.text).toContain('رابط الإحالة هذا غير صالح أو منتهي الصلاحية أو لم يعد نشطاً.');
    expect(res.text).toContain('href="/r/ABCDEF1234?lang=en"');
    expect(res.text).not.toContain('class="btn"'); // no continue button on a dead link
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
  });

  test('a promotion whose end date is still ahead is fine', async () => {
    const deps = makeDeps();
    deps.models.ReferralPromotion = model({ name: 'x', status: 'active', endsAt: new Date(NOW + 86400000) });
    expect((await get(deps, '/r/ABCDEF1234?lang=ar')).status).toBe(200);
  });

  test('an unknown code is judged by the oldest workspace (there is no other workspace to ask)', async () => {
    const deps = makeDeps();
    deps.models.ReferralCode = model(null);
    deps.settings.isArabicEnabled.mockResolvedValue(false);
    expect((await get(deps, '/r/ABCDEF1234?lang=ar')).text).toBe(SENTINEL);
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(WS);
  });
});

describe('referral link: the tap (?go=1) records the click once and redirects to WhatsApp in Arabic', () => {
  test('calls the existing recorder exactly once, with the same arguments the English handler passes', async () => {
    const deps = makeDeps();
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1', { 'User-Agent': 'jest-agent/1.0' });
    expect(res.status).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
    expect(deps.recordReferralClick).toHaveBeenCalledWith({
      code: 'ABCDEF1234', source: undefined, medium: 'customer_link', ip: expect.any(String), userAgent: 'jest-agent/1.0',
    });
    expect(deps.recordTrackingClick).not.toHaveBeenCalled();
  });

  test('the generic link uses the generic medium; src / source / medium are passed through, shortened to one line', async () => {
    const generic = makeDeps();
    await get(generic, '/c/ABCDEF1234?lang=ar&go=1');
    expect(generic.recordReferralClick).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABCDEF1234', medium: 'generic_link' }));

    const tagged = makeDeps();
    await get(tagged, `/r/ABCDEF1234?lang=ar&go=1&src=flyer&medium=${'m'.repeat(300)}`);
    expect(tagged.recordReferralClick.mock.calls[0][0].source).toBe('flyer');
    expect(tagged.recordReferralClick.mock.calls[0][0].medium).toHaveLength(100);

    const alias = makeDeps();
    await get(alias, '/r/ABCDEF1234?lang=ar&go=1&source=ig');
    expect(alias.recordReferralClick.mock.calls[0][0].source).toBe('ig');

    const odd = makeDeps();
    await get(odd, '/r/ABCDEF1234?lang=ar&go=1&src=a&src=b&medium[x]=1');
    expect(odd.recordReferralClick.mock.calls[0][0]).toMatchObject({ source: 'a', medium: 'customer_link' });
  });

  test('the redirect is https://wa.me/<number> with an Arabic text that keeps the Latin "Code: <CODE>" detectable', async () => {
    const res = await get(makeDeps(), '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.headers.location.startsWith('https://wa.me/966500000000?text=')).toBe(true);
    expect(res.headers.location).not.toContain('+');
    const text = prefilled(res);
    expect(text).toBe('مرحباً، أرغب في الاستفادة من عرض الإحالة الخاص بي.\nCode: ABCDEF1234');
    expect(text.match(REFERRAL_CODE_PATTERN)[1]).toBe('ABCDEF1234');
    expect(text.match(TRACKING_CODE_PATTERN)).toBeNull(); // the two detectors never cross-match
    expect(text).not.toMatch(BIDI_AND_INVISIBLES); // no direction mark anywhere, least of all between "Code:" and the token
    expect(text).toMatch(/Code: ABCDEF1234$/);
  });

  test('the token comes from the stored code, cleaned to plain characters (never a URL-supplied value)', async () => {
    const deps = makeDeps();
    deps.recordReferralClick.mockResolvedValue({ waLink: WA_LINK, referralCode: { code: 'AB CD\nEF12"<>34' } });
    const text = prefilled(await get(deps, '/r/ABCDEF1234?lang=ar&go=1'));
    expect(text.endsWith('\nCode: ABCDEF1234')).toBe(true);

    const bare = makeDeps();
    bare.recordReferralClick.mockResolvedValue({ waLink: WA_LINK });
    expect(prefilled(await get(bare, '/r/ABCDEF1234?lang=ar&go=1')).endsWith('\nCode: ABCDEF1234')).toBe(true);
  });

  test('the prefilled text is not mistaken for a consent keyword by the inbound Arabic opt-out/opt-in classifier', async () => {
    const referral = prefilled(await get(makeDeps(), '/r/ABCDEF1234?lang=ar&go=1'));
    const tracking = prefilled(await get(makeDeps(), '/t/ABCDEF1234?lang=ar&go=1'));
    expect(classifyInboundText(referral)).toBeNull();
    expect(classifyInboundText(tracking)).toBeNull();
  });

  test('English paths: ?lang=en (even with go=1), kill switch, merchant without Arabic, English browser, no signal', async () => {
    const cases = [
      [makeDeps(), '/r/ABCDEF1234?lang=en&go=1', AR],
      [makeDeps(), '/r/ABCDEF1234?lang=en', AR],
      [makeDeps({ settings: { killSwitchOn: () => true, isArabicEnabled: async () => true } }), '/r/ABCDEF1234?lang=ar&go=1', AR],
      [makeDeps({ settings: { killSwitchOn: () => false, isArabicEnabled: async () => false } }), '/r/ABCDEF1234?lang=ar&go=1', AR],
      [makeDeps({ anyArabicEnabled: async () => false }), '/r/ABCDEF1234?lang=ar&go=1', AR],
      [makeDeps(), '/r/ABCDEF1234?go=1', { 'Accept-Language': 'en-US,en;q=0.9' }],
      [makeDeps(), '/r/ABCDEF1234?go=1', {}],
    ];
    for (const [deps, url, headers] of cases) {
      const res = await get(deps, url, headers);
      expect(res.text).toBe(SENTINEL);
      expect(res.headers['cache-control']).toBeUndefined();
      expect(res.headers.location).toBeUndefined();
      expect(deps.recordReferralClick).not.toHaveBeenCalled(); // the English handler records it (once), not us
    }
  });

  test('a tap on a stale link (the recorder answers null) is an Arabic 404, not the English page', async () => {
    const deps = makeDeps();
    deps.recordReferralClick.mockResolvedValue(null);
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(404);
    expect(res.text).toContain('<h1>الرابط غير موجود</h1>');
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
  });

  test('the tap does not depend on the page pre-check (the recorder is the authority)', async () => {
    const deps = makeDeps();
    deps.models.ReferralPromotion = model({ name: 'x', status: 'ended' });
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(302);
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
  });

  test('WhatsApp number not resolvable (waLink null): an honest Arabic "unavailable" page, click recorded once', async () => {
    const deps = makeDeps();
    deps.recordReferralClick.mockResolvedValue({ waLink: null, referralCode: { code: 'ABCDEF1234' } });
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(503);
    expect(res.text).toContain('<h1>واتساب غير متاح حالياً</h1>');
    expect(res.text).toContain('تعذّر فتح واتساب حالياً. يرجى المحاولة بعد قليل.');
    expect(res.text).toContain('hreflang="en"');
    expect(res.headers.location).toBeUndefined();
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
  });

  test.each([['https://evil.example/966500000000?text=x'], ['http://wa.me/966500000000'], ['javascript:alert(1)'], ['not a url']])('a redirect target that is not https://wa.me (%s) is refused', async (waLink) => {
    const deps = makeDeps();
    deps.recordReferralClick.mockResolvedValue({ waLink, referralCode: { code: 'ABCDEF1234' } });
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(503);
    expect(res.headers.location).toBeUndefined();
  });

  test('once the click may have been recorded, a failure is an Arabic 500 page and the English handler NEVER runs (it would count the click twice)', async () => {
    const deps = makeDeps();
    deps.recordReferralClick.mockRejectedValue(new Error('referral write failed'));
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(500);
    expect(res.text).not.toBe(SENTINEL);
    expect(res.text).toContain('<h1>حدث خطأ ما</h1>');
    expect(res.text).toContain('يرجى المحاولة مرة أخرى بعد قليل.');
    expect(res.text).toContain('hreflang="en"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[localization:pages] Arabic page failed:', 'referral write failed');
  });

  test('a synchronous throw inside the recorder is handled the same way', async () => {
    const deps = makeDeps();
    deps.recordReferralClick.mockImplementation(() => { throw new Error('sync boom'); });
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(500);
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
  });

  test('only a GET tap counts: POST is not handled at all', async () => {
    const deps = makeDeps();
    const res = await request(makeApp(deps)).post('/r/ABCDEF1234?lang=ar&go=1');
    expect(res.text).toBe(SENTINEL);
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
  });
});

describe('referral link: before the tap, everything fails open', () => {
  test.each([
    ['the code lookup fails', (d) => { d.models.ReferralCode = model(() => { throw new Error('cosmos'); }); }],
    ['the flag lookup fails', (d) => { d.settings.isArabicEnabled.mockRejectedValue(new Error('flag')); }],
    ['the rollout lookup fails', (d) => { d.anyArabicEnabled = jest.fn(async () => { throw new Error('down'); }); }],
  ])('%s -> the English page answers, page and tap alike, and nothing is recorded by us', async (label, arrange) => {
    const deps = makeDeps();
    arrange(deps);
    for (const url of ['/r/ABCDEF1234?lang=ar', '/r/ABCDEF1234?lang=ar&go=1']) {
      expect((await get(deps, url)).text).toBe(SENTINEL);
    }
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
  });

  test.each([
    ['the promotion lookup fails', (d) => { d.models.ReferralPromotion = model(() => { throw new Error('cosmos'); }); }],
  ])('%s -> the page falls through to English, but the tap never needs it and still works', async (label, arrange) => {
    const deps = makeDeps();
    arrange(deps);
    expect((await get(deps, '/r/ABCDEF1234?lang=ar')).text).toBe(SENTINEL);
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
    const tap = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(tap.status).toBe(302);
    expect(deps.recordReferralClick).toHaveBeenCalledTimes(1);
  });

  test('the tap makes the minimum of lookups: the code (for the workspace flag) and nothing else', async () => {
    const deps = makeDeps();
    await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(deps.models.ReferralCode.calls).toEqual([{ code: 'ABCDEF1234' }]);
    expect(deps.models.ReferralPromotion.calls).toEqual([]);
    expect(deps.models.Customer.calls).toEqual([]);
    expect(deps.models.CustomerLanguage.calls).toEqual([]);
    expect(deps.models.Settings.calls).toEqual([]); // the business name is for the page only
    expect(deps.models.Workspace.calls).toEqual([]);
  });

  test('a lookup that never answers falls through within the time budget and records nothing', async () => {
    const deps = makeDeps({ precheckTimeoutMs: 40 });
    deps.models.ReferralCode = { findOne: () => ({ select: () => ({ lean: () => new Promise(() => {}) }) }) };
    const started = Date.now();
    const res = await get(deps, '/r/ABCDEF1234?lang=ar&go=1');
    expect(res.text).toBe(SENTINEL);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
  });

  test.each([['a b'], ['a%2Fb'], ['%3Cscript%3E'], ['A'.repeat(65)]])('a code that cannot be ours (%s) is left to the English handler without any lookup', async (code) => {
    const deps = makeDeps();
    expect((await get(deps, `/r/${code}?lang=ar`, AR)).text).toBe(SENTINEL);
    expect(deps.models.ReferralCode.calls).toEqual([]);
  });
});

describe('referral link: which language, and for which merchant', () => {
  test("the code's own workspace decides the flag (a code of a merchant without Arabic stays English)", async () => {
    const deps = makeDeps();
    deps.models.ReferralCode = model(activeCode({ workspaceId: OTHER_WS }));
    expect((await get(deps, '/r/ABCDEF1234?lang=ar', AR)).text).toBe(SENTINEL);
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(OTHER_WS);
    // English decided: nothing else is looked up for this visitor.
    expect(deps.models.ReferralPromotion.calls).toEqual([]);
    expect(deps.models.Customer.calls).toEqual([]);
  });

  test('an Arabic browser is enough (friends are not customers yet)', async () => {
    expect((await get(makeDeps(), '/r/ABCDEF1234', AR)).text).toContain('lang="ar"');
  });

  test('an English browser stays English even for an Arabic-speaking referrer', async () => {
    const deps = makeDeps();
    deps.models.CustomerLanguage = model({ language: 'ar' });
    expect((await get(deps, '/r/ABCDEF1234', { 'Accept-Language': 'en-US,en;q=0.9' })).text).toBe(SENTINEL);
    expect(deps.models.CustomerLanguage.calls).toEqual([]); // not even asked
  });

  test("the referrer's language is only a last-resort hint when the browser says nothing", async () => {
    const arabic = makeDeps();
    arabic.models.CustomerLanguage = model({ language: 'ar' });
    expect((await get(arabic, '/r/ABCDEF1234')).text).toContain('lang="ar"');
    expect(arabic.models.CustomerLanguage.calls).toEqual([{ workspaceId: WS, customerId: REFERRER }]); // tenant-scoped

    const english = makeDeps();
    english.models.CustomerLanguage = model({ language: 'en' });
    expect((await get(english, '/r/ABCDEF1234')).text).toBe(SENTINEL);

    const generic = makeDeps();
    generic.models.ReferralCode = model(activeCode({ referrerCustomerId: undefined }));
    expect((await get(generic, '/c/ABCDEF1234')).text).toBe(SENTINEL);
  });

  test('?lang=ar is explicit: nothing about the referrer is consulted for the language', async () => {
    const deps = makeDeps();
    deps.models.CustomerLanguage = model({ language: 'en' });
    expect((await get(deps, '/r/ABCDEF1234?lang=ar', { 'Accept-Language': 'en' })).text).toContain('lang="ar"');
    expect(deps.models.CustomerLanguage.calls).toEqual([]);
  });

  test('every lookup is scoped to the code\'s workspace', async () => {
    const deps = makeDeps();
    await get(deps, '/r/ABCDEF1234?lang=ar');
    expect(deps.models.ReferralCode.calls).toEqual([{ code: 'ABCDEF1234' }]);
    expect(deps.models.ReferralPromotion.calls).toEqual([{ _id: PROMO, workspaceId: WS }]);
    expect(deps.models.Settings.calls).toEqual([{ workspaceId: WS }]);
    expect(deps.models.Customer.calls).toEqual([]); // the referrer's record is not read at all
  });

  test('a hostile code never reaches a query as anything but a plain string', async () => {
    const deps = makeDeps();
    await get(deps, '/r/%7B%22%24ne%22%3Anull%7D?lang=ar');
    await get(deps, '/r/ABCDEF1234?lang=ar&code[$ne]=x&go[$ne]=1');
    for (const call of deps.models.ReferralCode.calls) expect(typeof call.code).toBe('string');
  });
});

describe('Instagram tracking link /t/:code', () => {
  test('the interstitial: Arabic, RTL, the post name, one button, and no click recorded', async () => {
    const deps = makeDeps();
    const res = await get(deps, '/t/ABCDEF1234?lang=ar');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('<html lang="ar" dir="rtl">');
    expect(res.text).toContain('<title>عرض خاص</title>');
    expect(res.text).toContain('<p class="muted">العرض: <bdi>Summer Sale 2026</bdi></p>');
    expect(res.text).toContain('اضغط الزر أدناه لفتح واتساب برسالة جاهزة والاستفادة من هذا العرض.');
    expect(res.text).toContain('<a class="btn" href="/t/ABCDEF1234?lang=ar&amp;go=1" rel="nofollow">المتابعة على واتساب</a>');
    expect(res.text).toContain('href="/t/ABCDEF1234?lang=en"');
    expect(deps.recordTrackingClick).not.toHaveBeenCalled();
    expect(deps.models.TrackingLink.calls).toEqual([{ code: 'ABCDEF1234' }]);
    expect(deps.models.InstagramPost.calls).toEqual([{ _id: POST, workspaceId: WS }]);
  });

  test('the tap: the existing recorder once, then wa.me with an Arabic text and an intact "Code: IG-..." token', async () => {
    const deps = makeDeps();
    const res = await get(deps, '/t/ABCDEF1234?lang=ar&go=1&src=bio', { 'User-Agent': 'ua' });
    expect(res.status).toBe(302);
    expect(deps.recordTrackingClick).toHaveBeenCalledTimes(1);
    expect(deps.recordTrackingClick).toHaveBeenCalledWith({ code: 'ABCDEF1234', source: 'bio', medium: undefined, ip: expect.any(String), userAgent: 'ua' });
    expect(deps.recordReferralClick).not.toHaveBeenCalled();
    const text = prefilled(res);
    expect(text).toBe('مرحباً، أرغب في الاستفادة من عرض «\u{200E}Summer Sale 2026\u{200E}».\nCode: IG-ABCD1234');
    expect(text.match(TRACKING_CODE_PATTERN)[1]).toBe('IG-ABCD1234');
    expect(text.match(REFERRAL_CODE_PATTERN)).toBeNull();
    expect(text).toMatch(/Code: IG-ABCD1234$/);
  });

  test('an Arabic promotion name needs no direction marks; a Latin one is wrapped only INSIDE the guillemets', async () => {
    const arabic = makeDeps();
    arabic.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: 'تخفيضات الصيف', promotionCode: 'IG-ABCD1234' } });
    const text = prefilled(await get(arabic, '/t/ABCDEF1234?lang=ar&go=1'));
    expect(text).toBe('مرحباً، أرغب في الاستفادة من عرض «تخفيضات الصيف».\nCode: IG-ABCD1234');
    expect(text).not.toMatch(BIDI_AND_INVISIBLES);

    const latin = prefilled(await get(makeDeps(), '/t/ABCDEF1234?lang=ar&go=1'));
    const afterColon = latin.slice(latin.indexOf('Code:') - 1);
    expect(afterColon).toBe('\nCode: IG-ABCD1234');
    expect(afterColon).not.toMatch(BIDI_AND_INVISIBLES);
  });

  test('a promotion name that contains "Code:" cannot hijack the detection (the first "Code:" is always the real one)', async () => {
    const deps = makeDeps();
    deps.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: 'Win! Code: IG-00000000 now', promotionCode: 'IG-ABCD1234' } });
    const text = prefilled(await get(deps, '/t/ABCDEF1234?lang=ar&go=1'));
    expect(text.match(TRACKING_CODE_PATTERN)[1]).toBe('IG-ABCD1234');
    expect(text.match(/code\s*:/gi)).toHaveLength(1); // only ours is left
  });

  test('the name is one short line: newlines collapse, controls vanish, length is capped', async () => {
    const deps = makeDeps();
    deps.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: `Line1\nLine2\u{202E}\u{0000}${'z'.repeat(200)}`, promotionCode: 'IG-ABCD1234' } });
    const text = prefilled(await get(deps, '/t/ABCDEF1234?lang=ar&go=1'));
    const [sentence, codeLine, ...rest] = text.split('\n');
    expect(rest).toEqual([]);
    expect(codeLine).toBe('Code: IG-ABCD1234');
    expect(sentence).toContain('Line1 Line2');
    expect(sentence).not.toContain('z'.repeat(81));
    expect(sentence).not.toMatch(/[\u{202A}-\u{202E}\u{0000}]/u);
  });

  test('no usable name -> the generic sentence; no promotion code -> no code line; no post at all -> still a valid redirect', async () => {
    const noName = makeDeps();
    noName.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: '  ', promotionCode: 'IG-ABCD1234' } });
    expect(prefilled(await get(noName, '/t/ABCDEF1234?lang=ar&go=1'))).toBe('مرحباً، أرغب في الاستفادة من هذا العرض.\nCode: IG-ABCD1234');

    const noCode = makeDeps();
    noCode.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: 'Sale' } });
    expect(prefilled(await get(noCode, '/t/ABCDEF1234?lang=ar&go=1'))).not.toContain('Code');

    const noPost = makeDeps();
    noPost.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK });
    const res = await get(noPost, '/t/ABCDEF1234?lang=ar&go=1');
    expect(res.status).toBe(302);
    expect(prefilled(res)).toBe('مرحباً، أرغب في الاستفادة من هذا العرض.');
  });

  test('a name made only of "Code:" does not leave a half sentence behind', async () => {
    const deps = makeDeps();
    deps.recordTrackingClick.mockResolvedValue({ waLink: WA_LINK, post: { name: 'code:', promotionCode: 'IG-ABCD1234' } });
    expect(prefilled(await get(deps, '/t/ABCDEF1234?lang=ar&go=1'))).toBe('مرحباً، أرغب في الاستفادة من هذا العرض.\nCode: IG-ABCD1234');
  });

  test('unknown link or missing post: Arabic 404; the tap on a stale link too; no WhatsApp number: 503; failures after the click: 500 and never English', async () => {
    const missingLink = makeDeps();
    missingLink.models.TrackingLink = model(null);
    const a = await get(missingLink, '/t/ABCDEF1234?lang=ar');
    expect(a.status).toBe(404);
    expect(a.text).toContain('هذا الرابط غير صالح أو لم يعد نشطاً.');
    expect(missingLink.recordTrackingClick).not.toHaveBeenCalled();

    const missingPost = makeDeps();
    missingPost.models.InstagramPost = model(null);
    expect((await get(missingPost, '/t/ABCDEF1234?lang=ar')).status).toBe(404);

    const stale = makeDeps();
    stale.recordTrackingClick.mockResolvedValue(null);
    expect((await get(stale, '/t/ABCDEF1234?lang=ar&go=1')).status).toBe(404);

    const noNumber = makeDeps();
    noNumber.recordTrackingClick.mockResolvedValue({ waLink: null, post: { name: 'x', promotionCode: 'IG-ABCD1234' } });
    expect((await get(noNumber, '/t/ABCDEF1234?lang=ar&go=1')).status).toBe(503);

    const failing = makeDeps();
    failing.recordTrackingClick.mockRejectedValue(new Error('write failed'));
    const f = await get(failing, '/t/ABCDEF1234?lang=ar&go=1');
    expect(f.status).toBe(500);
    expect(f.text).not.toBe(SENTINEL);
    expect(failing.recordTrackingClick).toHaveBeenCalledTimes(1);
  });

  test('language and flag: ?lang=en, no flag, English browser and failures all leave the English handler in charge', async () => {
    const cases = [
      [makeDeps(), '/t/ABCDEF1234?lang=en&go=1', AR],
      [makeDeps({ settings: { killSwitchOn: () => false, isArabicEnabled: async () => false } }), '/t/ABCDEF1234?lang=ar&go=1', AR],
      [makeDeps(), '/t/ABCDEF1234', { 'Accept-Language': 'en' }],
      [makeDeps(), '/t/ABCDEF1234', {}],
      [(() => { const d = makeDeps(); d.models.TrackingLink = model(() => { throw new Error('cosmos'); }); return d; })(), '/t/ABCDEF1234?lang=ar&go=1', AR],
      [(() => { const d = makeDeps(); d.models.InstagramPost = model(() => { throw new Error('cosmos'); }); return d; })(), '/t/ABCDEF1234?lang=ar', AR],
    ];
    for (const [deps, url, headers] of cases) {
      expect((await get(deps, url, headers)).text).toBe(SENTINEL);
      expect(deps.recordTrackingClick).not.toHaveBeenCalled();
    }
  });

  test("the link's own workspace decides the flag, and there is no customer language behind a tracking link", async () => {
    const deps = makeDeps();
    deps.models.TrackingLink = model({ workspaceId: OTHER_WS, instagramPostId: POST });
    expect((await get(deps, '/t/ABCDEF1234?lang=ar', AR)).text).toBe(SENTINEL);
    expect(deps.settings.isArabicEnabled).toHaveBeenCalledWith(OTHER_WS);

    const arabicBrowser = makeDeps();
    expect((await get(arabicBrowser, '/t/ABCDEF1234', AR)).text).toContain('lang="ar"');
    expect(arabicBrowser.models.CustomerLanguage.calls).toEqual([]);
  });

  describe('an Arabic post caption chooses Arabic when ?lang is absent (META-REALITY section 11)', () => {
    const withCaption = (caption) => {
      const deps = makeDeps();
      deps.models.InstagramPost = model({ name: 'Summer Sale 2026', caption });
      return deps;
    };
    const ARABIC_CAPTION = 'عرض الصيف الكبير! خصم ٣٠٪ على جميع المنتجات #عرض';
    const ENGLISH = { 'Accept-Language': 'en-US,en;q=0.9' };

    test('Arabic caption beats an English Accept-Language and no Arabic browser is needed', async () => {
      const deps = withCaption(ARABIC_CAPTION);
      const res = await get(deps, '/t/ABCDEF1234', ENGLISH);
      expect(res.text).toContain('lang="ar" dir="rtl"');
      expect(deps.recordTrackingClick).not.toHaveBeenCalled();
      expect((await get(withCaption(ARABIC_CAPTION), '/t/ABCDEF1234', {})).text).toContain('lang="ar"');
    });

    test('the tap still works and the English prefill of the caption never decides anything', async () => {
      const deps = withCaption(ARABIC_CAPTION);
      const text = prefilled(await get(deps, '/t/ABCDEF1234?go=1', ENGLISH));
      expect(text).toContain('Code: IG-ABCD1234');
      expect(deps.recordTrackingClick).toHaveBeenCalledTimes(1);
    });

    test('?lang=en wins over an Arabic caption, and an English or mixed caption leaves it to the browser', async () => {
      expect((await get(withCaption(ARABIC_CAPTION), '/t/ABCDEF1234?lang=en', AR)).text).toBe(SENTINEL);
      expect((await get(withCaption('Summer sale! 30% off everything'), '/t/ABCDEF1234', ENGLISH)).text).toBe(SENTINEL);
      expect((await get(withCaption('Summer sale! 30% off everything'), '/t/ABCDEF1234', AR)).text).toContain('lang="ar"');
      expect((await get(withCaption('Summer sale 30% off عرض'), '/t/ABCDEF1234', ENGLISH)).text).toBe(SENTINEL);
      expect((await get(withCaption(undefined), '/t/ABCDEF1234', ENGLISH)).text).toBe(SENTINEL);
    });

    test('an Arabic caption never overrides the merchant flag', async () => {
      const deps = withCaption(ARABIC_CAPTION);
      deps.settings = { killSwitchOn: () => false, isArabicEnabled: async () => false };
      expect((await get(deps, '/t/ABCDEF1234', ENGLISH)).text).toBe(SENTINEL);
    });
  });

  test('hostile promotion names are escaped on the page', async () => {
    const deps = makeDeps();
    deps.models.InstagramPost = model({ name: '<script>alert(1)</script>' });
    const html = (await get(deps, '/t/ABCDEF1234?lang=ar')).text;
    expect(html).toContain('<bdi>&lt;script&gt;alert(1)&lt;/script&gt;</bdi>');
    expect(html).not.toContain('<script');
  });
});
