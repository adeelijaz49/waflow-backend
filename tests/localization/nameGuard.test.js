// Pure unit tests (no database): the one-word / missing-name guard (backlog B4). It must return
// exactly '' (today's value, which makes Customer.create fail as it does now) unless the workspace
// is flagged, and must never throw.
jest.mock('../../models/LocaleSettings', () => ({ findOne: jest.fn() }));

const LocaleSettings = require('../../models/LocaleSettings');
const settings = require('../../shared/localization/settings');
const { oneWordLastname, FALLBACK_LASTNAME } = require('../../shared/localization/nameGuard');

const WS = '0123456789abcdef01234567';
const flagRow = (arabicEnabled) => ({ select: () => ({ lean: async () => (arabicEnabled === null ? null : { arabicEnabled }) }) });

beforeEach(() => {
  settings.clearCache();
  LocaleSettings.findOne.mockReset();
  delete process.env.LOCALIZATION_DISABLED;
});
afterAll(() => { delete process.env.LOCALIZATION_DISABLED; });

describe('oneWordLastname', () => {
  test('flagged workspace -> a single ASCII space', async () => {
    LocaleSettings.findOne.mockReturnValue(flagRow(true));
    const value = await oneWordLastname(WS);
    expect(value).toBe(' ');
    expect(value).toBe(FALLBACK_LASTNAME);
    expect(value.trim()).toBe('');
  });

  test.each([[false], [null]])('unflagged (%s) -> empty string, i.e. exactly today\'s value', async (row) => {
    LocaleSettings.findOne.mockReturnValue(flagRow(row));
    expect(await oneWordLastname(WS)).toBe('');
  });

  test('kill switch -> empty string without reading anything', async () => {
    process.env.LOCALIZATION_DISABLED = '1';
    expect(await oneWordLastname(WS)).toBe('');
    expect(LocaleSettings.findOne).not.toHaveBeenCalled();
  });

  test('a failing flag lookup never throws: empty string', async () => {
    LocaleSettings.findOne.mockImplementation(() => { throw new Error('db down'); });
    expect(await oneWordLastname(WS)).toBe('');
    LocaleSettings.findOne.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('timeout'); } }) });
    settings.clearCache();
    expect(await oneWordLastname(WS)).toBe('');
  });

  test.each([[undefined], [null], ['']])('no workspace (%s) -> empty string, nothing read', async (ws) => {
    expect(await oneWordLastname(ws)).toBe('');
    expect(LocaleSettings.findOne).not.toHaveBeenCalled();
  });

  test('the answer is cached for the flag TTL: one read for many creations', async () => {
    LocaleSettings.findOne.mockReturnValue(flagRow(true));
    await oneWordLastname(WS);
    await oneWordLastname(WS);
    await oneWordLastname(WS);
    expect(LocaleSettings.findOne).toHaveBeenCalledTimes(1);
  });
});

// The three call sites use:  lastname: rest.join(' ') || await oneWordLastname(workspaceId)
describe('call-site expression', () => {
  const lastnameFor = async (name, ws) => {
    const [firstname, ...rest] = name.trim().split(/\s+/);
    return { firstname, lastname: rest.join(' ') || await oneWordLastname(ws) };
  };

  test('two or more words: the guard is not even evaluated', async () => {
    expect(await lastnameFor('Sara Ahmed', WS)).toEqual({ firstname: 'Sara', lastname: 'Ahmed' });
    expect(await lastnameFor('\u{0633}\u{0627}\u{0631}\u{0629} \u{0623}\u{062D}\u{0645}\u{062F} \u{0627}\u{0644}\u{0639}\u{062A}\u{064A}\u{0628}\u{064A}', WS).then((r) => r.lastname)).toBe('\u{0623}\u{062D}\u{0645}\u{062F} \u{0627}\u{0644}\u{0639}\u{062A}\u{064A}\u{0628}\u{064A}');
    expect(LocaleSettings.findOne).not.toHaveBeenCalled();
  });

  test('one word, flagged: Arabic, Latin, emoji and a bare phone number all get the single space', async () => {
    LocaleSettings.findOne.mockReturnValue(flagRow(true));
    for (const name of ['\u{0633}\u{0627}\u{0631}\u{0629}', 'Sara', '\u{1F600}', '966501234567']) {
      expect((await lastnameFor(name, WS)).lastname).toBe(' ');
    }
  });

  test('one word, unflagged: the empty string (so Customer.create fails exactly as today)', async () => {
    LocaleSettings.findOne.mockReturnValue(flagRow(false));
    expect((await lastnameFor('Sara', WS)).lastname).toBe('');
  });

  test('a single space passes Mongoose "required" and a Customer name reads as the first name alone', async () => {
    const Customer = jest.requireActual('../../models/Customer');
    const doc = new Customer({ workspaceId: WS, firstname: '\u{0633}\u{0627}\u{0631}\u{0629}', lastname: ' ', phone: '966501234567' });
    await expect(doc.validate()).resolves.toBeUndefined();
    expect(`${doc.firstname} ${doc.lastname}`.trim()).toBe('\u{0633}\u{0627}\u{0631}\u{0629}');
    const empty = new Customer({ workspaceId: WS, firstname: 'Sara', lastname: '', phone: '966501234567' });
    await expect(empty.validate()).rejects.toMatchObject({ errors: { lastname: expect.anything() } }); // today's failure, unchanged
  });
});
