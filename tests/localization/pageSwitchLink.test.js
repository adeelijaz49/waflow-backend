// Pure unit tests (no database, no Stripe): the "Arabic" switch link on the existing English
// payment pages (backlog D1). '' unless the visitor's workspace is flagged.
const { arabicSwitchHtml, linkHtml, SHOW_WITHOUT_LOOKUP } = require('../../shared/localization/pages/switchLink');

const WS = '0123456789abcdef01234567';
const resWith = (reason) => ({ locals: reason === undefined ? {} : { arabicPageReason: reason } });
const HREF = '/pay/pi_123?lang=ar';
const LABEL = '\u{0627}\u{0644}\u{0639}\u{0631}\u{0628}\u{064A}\u{0629}';

function deps(overrides = {}) {
  return {
    env: {},
    dbReady: () => true,
    catalog: { listEntries: () => [] },
    anyArabicEnabled: jest.fn(async () => true),
    oldestWorkspaceId: jest.fn(async () => WS),
    settings: { isArabicEnabled: jest.fn(async () => true) },
    models: { Service: { findById: jest.fn() }, Order: { findOne: jest.fn(() => ({ select: () => ({ lean: async () => null }) })) } },
    ...overrides,
  };
}

describe('reasons decided after the flag check -> link without any lookup', () => {
  test.each([['customer'], ['browser'], ['default']])('%s', async (reason) => {
    const d = deps();
    const html = await arabicSwitchHtml(resWith(reason), { href: HREF, pi: { id: 'pi_123' } }, d);
    expect(html).toBe(`<a class="exit" href="${HREF}" hreflang="ar" lang="ar" dir="rtl" rel="nofollow">${LABEL}</a>`);
    expect(d.anyArabicEnabled).not.toHaveBeenCalled();
    expect(d.settings.isArabicEnabled).not.toHaveBeenCalled();
  });

  test('the set is exactly the three reasons', () => {
    expect([...SHOW_WITHOUT_LOOKUP].sort()).toEqual(['browser', 'customer', 'default']);
  });
});

describe('everything else is the empty string (English page byte-identical)', () => {
  test.each([
    [undefined], ['kill_switch'], ['not_rolled_out'], ['flag_off'], ['no_workspace'], ['db_unavailable'],
    ['draft_copy_blocked'], ['checkout_unavailable'], ['explicit'], ['content'], ['hint'], ['something_new'], [''], [null],
  ])('reason %j', async (reason) => {
    expect(await arabicSwitchHtml(resWith(reason), { href: HREF, pi: {} }, deps())).toBe('');
  });

  test('no res, no locals, no href, no arguments, garbage', async () => {
    expect(await arabicSwitchHtml(undefined, { href: HREF })).toBe('');
    expect(await arabicSwitchHtml({}, { href: HREF })).toBe('');
    expect(await arabicSwitchHtml(resWith('customer'), {})).toBe('');
    expect(await arabicSwitchHtml(resWith('customer'))).toBe('');
    expect(await arabicSwitchHtml(null, null)).toBe('');
  });
});

describe('explicit_en (?lang=en: the flag is not known yet)', () => {
  const run = (d, pi = { id: 'pi_123', metadata: {} }) => arabicSwitchHtml(resWith('explicit_en'), { href: HREF, pi }, d);

  test('flagged workspace -> link (one cheap lookup chain)', async () => {
    const d = deps();
    expect(await run(d)).toContain('hreflang="ar"');
    expect(d.anyArabicEnabled).toHaveBeenCalledTimes(1);
    expect(d.settings.isArabicEnabled).toHaveBeenCalledWith(WS);
  });

  test('workspace found through the booking service of the PaymentIntent', async () => {
    const other = '89abcdef0123456789abcdef';
    const d = deps({ models: { Service: { findById: () => ({ select: () => ({ lean: async () => ({ workspaceId: other }) }) }) }, Order: { findOne: jest.fn() } } });
    const pi = { id: 'pi_1', metadata: { serviceId: '0123456789abcdef01234567' } };
    expect(await run(d, pi)).toContain('hreflang="ar"');
    expect(d.settings.isArabicEnabled).toHaveBeenCalledWith(other);
  });

  test.each([
    ['workspace not flagged', { settings: { isArabicEnabled: async () => false } }],
    ['no merchant anywhere is flagged', { anyArabicEnabled: async () => false }],
    ['database not connected', { dbReady: () => false }],
    ['draft pages disabled and copy not reviewed', { env: { LOCALIZATION_ALLOW_DRAFT_PAGES: '0' }, catalog: { listEntries: () => [{ key: 'pages.pay.title', ar: 'x', status: 'draft' }] } }],
    ['no workspace can be resolved', { oldestWorkspaceId: async () => null }],
    ['a lookup throws', { anyArabicEnabled: async () => { throw new Error('db'); } }],
    ['the flag read throws', { settings: { isArabicEnabled: async () => { throw new Error('db'); } } }],
  ])('%s -> empty string', async (name, overrides) => {
    expect(await run(deps(overrides))).toBe('');
  });

  test('a lookup slower than the 1.5 s budget is abandoned (empty string, no unhandled rejection)', async () => {
    jest.useFakeTimers();
    try {
      const d = deps({ anyArabicEnabled: () => new Promise(() => {}) });
      const pending = run(d);
      await jest.advanceTimersByTimeAsync(1600);
      expect(await pending).toBe('');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('markup', () => {
  test('the href is HTML-escaped; the label is the constant autonym', () => {
    const html = linkHtml('/payment-result?payment_intent=pi_1&lang=ar"><script>');
    expect(html).toContain('href="/payment-result?payment_intent=pi_1&amp;lang=ar&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain('<script>');
    expect(html).toContain(`>${LABEL}</a>`);
  });

  test('no invisible / bidi characters in the output', () => {
    expect(linkHtml(HREF)).not.toMatch(/[\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u);
  });
});
