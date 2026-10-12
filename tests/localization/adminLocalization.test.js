// Tests for the staff page routes/adminLocalization.js: the real router with injected fakes (no
// database, no network). Auth is the lead's mount (requireInternalAdmin), so a stub sets req.adminIp
// and the Basic Authorization header carries the admin user name used in the CSRF token.
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../routes/adminLocalization');

const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_WS = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const KEY = 'test-admin-password';
const AUTH = `Basic ${Buffer.from('staff:whatever').toString('base64')}`;

function chain(value, calls, name, filter) {
  calls.push({ name, filter });
  const q = {};
  for (const m of ['select', 'limit', 'sort', 'lean']) q[m] = () => q;
  q.then = (resolve, reject) => Promise.resolve(value).then(resolve, reject);
  return q;
}

function setup({ now = new Date('2026-10-12T10:00:00Z'), killSwitch = false, key = KEY, workspaces, library } = {}) {
  const calls = [];
  const wsRows = workspaces || [{ _id: WS, name: 'Salon <img src=x onerror=alert(1)>' }];
  const deps = {
    Workspace: {
      find: (f) => chain(wsRows, calls, 'ws.find', f),
      findById: (id) => chain(wsRows.find((w) => String(w._id) === String(id)) || null, calls, 'ws.findById', id),
    },
    User: { find: (f) => chain([], calls, 'user.find', f) },
    Membership: { find: (f) => chain([], calls, 'membership.find', f) },
    LocaleSettings: { findOne: (f) => chain({ arabicEnabled: true, arabicEnabledAt: new Date('2026-10-01T00:00:00Z'), arabicEnabledBy: '<b>bob</b>', notes: '"><script>x</script>' }, calls, 'ls.findOne', f) },
    LocalizationAdminLog: {
      find: (f) => chain([{ createdAt: new Date('2026-10-02T00:00:00Z'), action: 'enable', adminUser: '<i>x</i>', notes: '<script>1</script>' }], calls, 'log.find', f),
      create: jest.fn(async (row) => row),
    },
    settings: { killSwitchOn: () => killSwitch, setArabicEnabled: jest.fn(async () => ({})) },
    overview: {
      overview: async () => ({
        customers: { total: 10, en: 3, ar: 4, unknown: 3 },
        templates: { total: 2, withArabic: 1, arabicApproved: 1, arabicPending: 0, arabicRejected: 0, arabicNotSubmitted: 0, arabicOther: 0 },
        campaigns: { total: 1, lastSentAt: null }, review: { templatesDraft: 2, catalogDraft: 5, backendStringsDraft: 9 },
      }),
      translationCounts: async () => ({ draft: 5, reviewed: 1, missing: 2 }),
    },
    catalog: {
      counts: () => ({ total: 4, arabicTotal: 3, arabicDraft: 3, arabicReviewed: 0, arabicMissing: 1, needsLegalApproval: 1 }),
      listEntries: () => [{ key: 'consent.a', ar: 'x', en: 'y', status: 'draft' }, { key: 'consent.b', ar: '', en: 'y', status: 'draft' }],
    },
    getLibrary: () => library || null,
    getCsrfKey: () => key,
    now: () => now,
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.adminIp = '203.0.113.9'; next(); });
  app.use('/internal-admin-localization', createRouter(deps));
  return { app, deps, calls };
}

function token(user, workspaceId, day, key = KEY) {
  return crypto.createHmac('sha256', key).update(`${user}:${workspaceId}:${day}`).digest('hex');
}

describe('admin localisation page', () => {
  test('workspace page escapes hostile names, notes and log fields', async () => {
    const { app } = setup();
    const res = await request(app).get(`/internal-admin-localization/${WS}`).set('Authorization', AUTH);
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<img src=x/);
    expect(res.text).not.toMatch(/<script>/);
    expect(res.text).not.toMatch(/<b>bob/);
    expect(res.text).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(res.text).toContain('<meta charset="utf-8">');
    expect(res.text).toContain('lang="en"');
    expect(res.text).toContain('enabled');
  });

  test('shows the kill-switch banner only when LOCALIZATION_DISABLED is on', async () => {
    const on = await request(setup({ killSwitch: true }).app).get(`/internal-admin-localization/${WS}`).set('Authorization', AUTH);
    const off = await request(setup().app).get(`/internal-admin-localization/${WS}`).set('Authorization', AUTH);
    expect(on.text).toContain('Kill switch is ON');
    expect(off.text).not.toContain('Kill switch is ON');
  });

  test('unknown workspace and malformed ids are 404 with an escaped body', async () => {
    const { app } = setup();
    expect((await request(app).get(`/internal-admin-localization/${OTHER_WS}`)).status).toBe(404);
    const bad = await request(app).get('/internal-admin-localization/%3Cscript%3E');
    expect(bad.status).toBe(404);
    expect(bad.text).not.toContain('<script>');
  });

  test('the form carries a token bound to admin user, workspace and UTC day', async () => {
    const { app } = setup();
    const res = await request(app).get(`/internal-admin-localization/${WS}`).set('Authorization', AUTH);
    expect(res.text).toContain(`name="csrf" value="${token('staff', WS, '2026-10-12')}"`);
  });

  test('without INTERNAL_ADMIN_PASSWORD the form is not rendered', async () => {
    const res = await request(setup({ key: '' }).app).get(`/internal-admin-localization/${WS}`).set('Authorization', AUTH);
    expect(res.text).not.toContain('name="csrf"');
    expect(res.text).toContain('scripts/localization-flag.js');
  });

  test('search escapes regex metacharacters and caps length; non-string q is ignored', async () => {
    const { app, calls } = setup();
    await request(app).get('/internal-admin-localization/search').query({ q: '.*(a+)+$' }).set('Authorization', AUTH);
    const nameFilter = calls.find((c) => c.name === 'ws.find').filter.name;
    expect(nameFilter.source).toBe('\\.\\*\\(a\\+\\)\\+\\$');
    await request(app).get('/internal-admin-localization/search').query({ q: 'x'.repeat(500) }).set('Authorization', AUTH);
    expect(calls.filter((c) => c.name === 'ws.find').pop().filter.name.source.length).toBe(100);
    const before = calls.length;
    const res = await request(app).get('/internal-admin-localization/search?q[$ne]=1').set('Authorization', AUTH);
    expect(res.status).toBe(302);
    expect(calls.length).toBe(before);
  });

  test('search by id looks the workspace up by that exact id; results escape names', async () => {
    const { app, calls } = setup();
    const res = await request(app).get('/internal-admin-localization/search').query({ q: WS }).set('Authorization', AUTH);
    expect(calls.find((c) => c.name === 'ws.find').filter).toEqual({ _id: WS });
    expect(res.text).not.toContain('<img src=x');
  });

  test('phone search goes through users and memberships using digits only', async () => {
    const { app, calls } = setup();
    await request(app).get('/internal-admin-localization/search').query({ q: '+966 50-123 4567' }).set('Authorization', AUTH);
    const users = calls.find((c) => c.name === 'user.find').filter.$or;
    expect(users.some((f) => f.phone && f.phone.source === '966501234567')).toBe(true);
  });

  test('the index page lists catalogue review counts and the legal-approval count, library n/a when absent', async () => {
    const res = await request(setup().app).get('/internal-admin-localization/').set('Authorization', AUTH);
    expect(res.text).toContain('<strong>3</strong> unreviewed');
    expect(res.text).toContain('Template library: n/a');
    expect(res.text).toContain('<td>consent</td>');
  });

  test('library strings are included when the module exists', async () => {
    const library = { listLibraryStrings: () => [{ status: 'draft', needsLegalApproval: true }, { status: 'draft', needsLegalApproval: false }] };
    const res = await request(setup({ library }).app).get('/internal-admin-localization/').set('Authorization', AUTH);
    expect(res.text).toContain('2 unreviewed of 2');
    expect(res.text).toContain('<strong>2</strong>'); // 1 catalogue + 1 library string need legal approval
  });
});

describe('admin localisation toggle', () => {
  const post = (app, id, body, auth = AUTH) => request(app).post(`/internal-admin-localization/${id}/toggle`).set('Authorization', auth).type('form').send(body);

  test('valid token enables via the service, writes a log row, redirects', async () => {
    const { app, deps } = setup();
    const res = await post(app, WS, { csrf: token('staff', WS, '2026-10-12'), enabled: 'true', notes: 'KSA pilot' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`/internal-admin-localization/${WS}`);
    expect(deps.settings.setArabicEnabled).toHaveBeenCalledWith({ workspaceId: WS, enabled: true, grantedBy: 'staff', notes: 'KSA pilot' });
    expect(deps.LocalizationAdminLog.create).toHaveBeenCalledWith({ workspaceId: WS, action: 'enable', adminUser: 'staff', notes: 'KSA pilot', ip: '203.0.113.9' });
  });

  test('disable logs action disable; non-"true" values never enable', async () => {
    const { app, deps } = setup();
    await post(app, WS, { csrf: token('staff', WS, '2026-10-12'), enabled: 'yes' });
    expect(deps.settings.setArabicEnabled.mock.calls[0][0].enabled).toBe(false);
    expect(deps.LocalizationAdminLog.create.mock.calls[0][0].action).toBe('disable');
  });

  test.each([
    ['missing token', {}],
    ['token for another day', { csrf: token('staff', WS, '2026-10-11') }],
    ['token for another workspace', { csrf: token('staff', OTHER_WS, '2026-10-12') }],
    ['token for another admin user', { csrf: token('mallory', WS, '2026-10-12') }],
    ['token signed with another key', { csrf: token('staff', WS, '2026-10-12', 'other') }],
    ['short token', { csrf: 'abc' }],
    ['array token', { 'csrf[]': 'a' }],
  ])('rejects %s with 403 and writes nothing', async (_name, body) => {
    const { app, deps } = setup();
    const res = await post(app, WS, { enabled: 'true', ...body });
    expect(res.status).toBe(403);
    expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled();
    expect(deps.LocalizationAdminLog.create).not.toHaveBeenCalled();
  });

  test('fails closed when no CSRF key is configured', async () => {
    const { app, deps } = setup({ key: '' });
    const res = await post(app, WS, { csrf: token('staff', WS, '2026-10-12', ''), enabled: 'true' });
    expect(res.status).toBe(403);
    expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled();
  });

  test('a valid token for an unknown workspace is 404 and writes nothing', async () => {
    const { app, deps } = setup();
    const res = await post(app, OTHER_WS, { csrf: token('staff', OTHER_WS, '2026-10-12'), enabled: 'true' });
    expect(res.status).toBe(404);
    expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled();
  });

  test('over-long notes are cut to 500; a non-string notes value is ignored', async () => {
    const { app, deps } = setup();
    await post(app, WS, { csrf: token('staff', WS, '2026-10-12'), enabled: 'true', notes: 'n'.repeat(900) });
    expect(deps.settings.setArabicEnabled.mock.calls[0][0].notes).toHaveLength(500);
    await post(app, WS, { csrf: token('staff', WS, '2026-10-12'), enabled: 'true', 'notes[a]': 'x' });
    expect(deps.settings.setArabicEnabled.mock.calls[1][0].notes).toBeUndefined();
  });

  test('a flag-change failure renders a generic escaped error page without internals; its audit entry was already written', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { app, deps } = setup();
    deps.settings.setArabicEnabled.mockRejectedValue(new Error('mongodb://user:secret@host exploded'));
    const res = await post(app, WS, { csrf: token('staff', WS, '2026-10-12'), enabled: 'true' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret');
    expect(res.text).toContain('could not be changed');
    expect(res.text).toContain('audit entry');
    expect(deps.LocalizationAdminLog.create).toHaveBeenCalledTimes(1); // log-before-mutate: the attempt is on record
  });

  describe('LOG BEFORE MUTATE (the shared/consent.js rule): a flag change can never exist without its audit row', () => {
    const body = (over = {}) => ({ csrf: token('staff', WS, '2026-10-12'), enabled: 'true', notes: 'KSA pilot', ...over });

    test.each([['enable', 'true'], ['disable', 'false']])('%s: the audit row is written BEFORE the flag is changed', async (action, enabled) => {
      const { app, deps } = setup();
      const res = await post(app, WS, body({ enabled }));
      expect(res.status).toBe(303);
      const logOrder = deps.LocalizationAdminLog.create.mock.invocationCallOrder[0];
      const flagOrder = deps.settings.setArabicEnabled.mock.invocationCallOrder[0];
      expect(logOrder).toBeLessThan(flagOrder);
      expect(deps.LocalizationAdminLog.create.mock.calls[0][0].action).toBe(action);
    });

    test('the flag change does not start until the audit row has been stored (the log write is awaited)', async () => {
      const { app, deps } = setup();
      const events = [];
      deps.LocalizationAdminLog.create.mockImplementation(async (row) => { events.push('log:start'); await new Promise((r) => setTimeout(r, 20)); events.push('log:done'); return row; });
      deps.settings.setArabicEnabled.mockImplementation(async () => { events.push('flag'); return {}; });
      await post(app, WS, body());
      expect(events).toEqual(['log:start', 'log:done', 'flag']);
    });

    test.each([
      ['rejects', (deps) => deps.LocalizationAdminLog.create.mockRejectedValue(new Error('mongodb://user:secret@host log collection unavailable'))],
      ['throws synchronously', (deps) => deps.LocalizationAdminLog.create.mockImplementation(() => { throw new Error('mongodb://user:secret@host boom'); })],
    ])('if the audit insert %s the flag is NOT changed and the operator gets the friendly "nothing was changed" page', async (_name, arrange) => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { app, deps } = setup();
      arrange(deps);
      const res = await post(app, WS, body());
      expect(res.status).toBe(500);
      expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled(); // the whole point
      expect(res.text).toContain('Nothing was changed');
      expect(res.text).toContain('audit log could not be written');
      expect(res.text).not.toContain('secret'); // no internals
      expect(res.text).not.toContain('mongodb');
      expect(res.headers.location).toBeUndefined(); // no redirect that would look like success
      expect(spy).toHaveBeenCalled(); // the real reason goes to the server log
      expect(String(spy.mock.calls[0].join(' '))).toContain('NOT changed');
      spy.mockRestore();
    });

    test('a failed audit insert for a disable leaves an enabled flag enabled', async () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const { app, deps } = setup();
      deps.LocalizationAdminLog.create.mockRejectedValue(new Error('down'));
      const res = await post(app, WS, body({ enabled: 'false' }));
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled();
    });

    test('nothing is logged or changed for a request that fails the CSRF check or names an unknown workspace (no orphan audit rows)', async () => {
      const bad = setup();
      expect((await post(bad.app, WS, { enabled: 'true' })).status).toBe(403);
      const unknown = setup();
      expect((await post(unknown.app, OTHER_WS, { csrf: token('staff', OTHER_WS, '2026-10-12'), enabled: 'true' })).status).toBe(404);
      for (const { deps } of [bad, unknown]) {
        expect(deps.LocalizationAdminLog.create).not.toHaveBeenCalled();
        expect(deps.settings.setArabicEnabled).not.toHaveBeenCalled();
      }
    });
  });
});
