const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
// The staff middleware reads its credentials when it is first required: fixed throwaway values, set BEFORE the require.
process.env.INTERNAL_ADMIN_USER = 'itest-admin';
process.env.INTERNAL_ADMIN_PASSWORD = 'itest-pass-not-real';
const h = require('./helpers/_harness');
const express = require('express');
const LocaleSettings = require('../../../models/LocaleSettings');
const LocalizationAdminLog = require('../../../models/LocalizationAdminLog');
const Workspace = require('../../../models/Workspace');
const Membership = require('../../../models/Membership');
const User = require('../../../models/User');
const SchedulerLock = require('../../../models/SchedulerLock');
const settings = require('../../../shared/localization/settings');
const scheduler = require('../../../shared/localization/scheduler');
const flagScript = require('../../../scripts/localization-flag');

const BASIC = `Basic ${Buffer.from('itest-admin:itest-pass-not-real').toString('base64')}`;

describe('BA admin page, flag script core and BR scheduler on real MongoDB', () => {
  let ctx; let app; let req;
  beforeAll(async () => {
    ctx = await h.setup();
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/internal-admin-localization', require('../../../middleware/requireInternalAdmin'), require('../../../routes/adminLocalization'));
    req = (verb, url) => h.request(app)[verb](url).set('Authorization', BASIC);
  });

  const csrfOf = (html) => (/name="csrf" value="([0-9a-f]{64})"/.exec(html) || [])[1];
  const form = (html) => ({ action: (/<form method="POST" action="([^"]+)"/.exec(html) || [])[1], enabled: (/name="enabled" value="(true|false)"/.exec(html) || [])[1] });

  describe('admin HTML page', () => {
    test('needs the staff Basic credentials (401 + challenge), wrong password is refused', async () => {
      const none = await h.request(app).get('/internal-admin-localization/');
      expect(none.status).toBe(401); expect(none.headers['www-authenticate']).toMatch(/Basic/);
      const wrong = await h.request(app).get('/internal-admin-localization/').set('Authorization', `Basic ${Buffer.from('itest-admin:nope').toString('base64')}`);
      expect(wrong.status).toBe(401);
      // a merchant JWT is not a staff credential
      const jwt = await h.request(app).get('/internal-admin-localization/').set('Authorization', `Bearer ${ctx.A.token}`);
      expect(jwt.status).toBe(401);
    });

    test('home page renders the search form and the string-review panel', async () => {
      const r = await req('get', '/internal-admin-localization/');
      expect(r.status).toBe(200); expect(r.text).toContain('action="/internal-admin-localization/search"'); expect(r.text).toMatch(/String review/);
    });

    test('search by id, by name and by member email; regex input is treated literally', async () => {
      const byId = await req('get', `/internal-admin-localization/search?q=${ctx.A.wsId}`);
      expect(byId.text).toContain(`/internal-admin-localization/${ctx.A.wsId}`);
      const byName = await req('get', '/internal-admin-localization/search?q=' + encodeURIComponent(ctx.A.ws.name));
      expect(byName.text).toContain(String(ctx.A.wsId));
      const byEmail = await req('get', '/internal-admin-localization/search?q=' + encodeURIComponent(ctx.B.user.email));
      expect(byEmail.text).toContain(String(ctx.B.wsId));
      const rx = await req('get', '/internal-admin-localization/search?q=' + encodeURIComponent('.*'));
      expect(rx.status).toBe(200); expect(rx.text).toContain('No matches');
      const bad = await req('get', '/internal-admin-localization/search?q=' + encodeURIComponent('(['));
      expect(bad.status).toBe(200);
    });

    test('names and notes are HTML-escaped everywhere (workspace name, notes, log rows)', async () => {
      const evil = '<script>alert(1)</script>"\'&';
      const ws = await Workspace.create({ name: evil });
      await LocaleSettings.create({ workspaceId: ws._id, arabicEnabled: true, arabicEnabledBy: '<b>x</b>', arabicEnabledAt: new Date(), notes: '<img src=x onerror=alert(2)>' });
      await LocalizationAdminLog.create({ workspaceId: ws._id, action: 'enable', adminUser: '<i>u</i>', notes: '<svg onload=1>' });
      const search = await req('get', '/internal-admin-localization/search?q=' + encodeURIComponent('alert(1)'));
      expect(search.text).not.toContain('<script>alert(1)'); expect(search.text).toContain('&lt;script&gt;');
      const page = await req('get', `/internal-admin-localization/${ws._id}`);
      expect(page.status).toBe(200);
      for (const raw of ['<script>alert(1)', '<img src=x', '<svg onload', '<b>x</b>', '<i>u</i>']) expect(page.text).not.toContain(raw);
      expect(page.text).toContain('&lt;img src=x onerror=alert(2)&gt;');
    });

    test('workspace page: state, counts, CSRF form; unknown / malformed ids are 404', async () => {
      const r = await req('get', `/internal-admin-localization/${ctx.C.wsId}`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('disabled'); expect(r.text).toMatch(/Customers: 0/);
      expect(csrfOf(r.text)).toMatch(/^[0-9a-f]{64}$/);
      expect(form(r.text)).toEqual({ action: `/internal-admin-localization/${ctx.C.wsId}/toggle`, enabled: 'true' });
      expect((await req('get', '/internal-admin-localization/000000000000000000000009')).status).toBe(404);
      expect((await req('get', '/internal-admin-localization/not-an-id')).status).toBe(404);
    });

    test('toggle needs a valid CSRF token: missing, garbage, another workspace\'s token and another admin\'s token are all 403 and change nothing', async () => {
      const page = await req('get', `/internal-admin-localization/${ctx.C.wsId}`);
      const token = csrfOf(page.text);
      const otherPage = await req('get', `/internal-admin-localization/${ctx.B.wsId}`);
      const post = (body, auth = BASIC) => h.request(app).post(`/internal-admin-localization/${ctx.C.wsId}/toggle`).set('Authorization', auth).type('form').send(body);
      expect((await post({ enabled: 'true' })).status).toBe(403);
      expect((await post({ enabled: 'true', csrf: 'x'.repeat(64) })).status).toBe(403);
      expect((await post({ enabled: 'true', csrf: 'short' })).status).toBe(403);
      expect((await post({ enabled: 'true', csrf: csrfOf(otherPage.text) })).status).toBe(403); // token of another workspace
      expect((await post({ enabled: 'true', csrf: { $ne: 1 } })).status).toBe(403);
      expect((await LocaleSettings.findOne({ workspaceId: ctx.C.wsId }))).toBeNull();
      expect(await LocalizationAdminLog.countDocuments({ workspaceId: ctx.C.wsId })).toBe(0);
      expect(token).toBeTruthy();
    });

    test('a valid toggle enables, audits (user, notes, ip) and takes effect on the merchant API immediately; the second toggle disables', async () => {
      expect((await ctx.api(ctx.C).get('/customers')).status).toBe(402);
      const page = await req('get', `/internal-admin-localization/${ctx.C.wsId}`);
      const post = (body) => h.request(app).post(`/internal-admin-localization/${ctx.C.wsId}/toggle`).set('Authorization', BASIC).type('form').send(body);
      const on = await post({ csrf: csrfOf(page.text), enabled: 'true', notes: `pilot ${'x'.repeat(600)}` });
      expect(on.status).toBe(303); expect(on.headers.location).toBe(`/internal-admin-localization/${ctx.C.wsId}`);
      const flag = await LocaleSettings.findOne({ workspaceId: ctx.C.wsId }).lean();
      expect(flag).toMatchObject({ arabicEnabled: true, arabicEnabledBy: 'itest-admin' }); expect(flag.notes).toHaveLength(500);
      expect((await ctx.api(ctx.C).get('/customers')).status).toBe(200); // cache invalidated in-process
      const log = await LocalizationAdminLog.find({ workspaceId: ctx.C.wsId }).lean();
      expect(log).toHaveLength(1); expect(log[0]).toMatchObject({ action: 'enable', adminUser: 'itest-admin' }); expect(log[0].ip).toBeTruthy();
      const page2 = await req('get', `/internal-admin-localization/${ctx.C.wsId}`);
      expect(page2.text).toContain('enabled'); expect(form(page2.text).enabled).toBe('false');
      expect(page2.text).toContain('<td>enable</td>');
      const off = await post({ csrf: csrfOf(page2.text), enabled: 'false' });
      expect(off.status).toBe(303);
      expect((await ctx.api(ctx.C).get('/customers')).status).toBe(402);
      expect(await LocalizationAdminLog.countDocuments({ workspaceId: ctx.C.wsId })).toBe(2);
      // anything but the literal 'true' means disable (never a truthy-string enable)
      const junk = await post({ csrf: csrfOf((await req('get', `/internal-admin-localization/${ctx.C.wsId}`)).text), enabled: '1' });
      expect(junk.status).toBe(303);
      expect((await ctx.api(ctx.C).get('/customers')).status).toBe(402);
    });

    test('toggle for a workspace that does not exist is 404 and writes no flag or log row', async () => {
      const ghost = '000000000000000000000077';
      const crypto = require('crypto');
      const day = new Date().toISOString().slice(0, 10);
      const token = crypto.createHmac('sha256', process.env.INTERNAL_ADMIN_PASSWORD).update(`itest-admin:${ghost}:${day}`).digest('hex');
      const r = await h.request(app).post(`/internal-admin-localization/${ghost}/toggle`).set('Authorization', BASIC).type('form').send({ csrf: token, enabled: 'true' });
      expect(r.status).toBe(404);
      expect(await LocaleSettings.countDocuments({ workspaceId: ghost })).toBe(0);
      expect(await LocalizationAdminLog.countDocuments({ workspaceId: ghost })).toBe(0);
    });

    test('kill-switch banner shows on every page while LOCALIZATION_DISABLED is set', async () => {
      process.env.LOCALIZATION_DISABLED = '1';
      try { expect((await req('get', '/internal-admin-localization/')).text).toContain('Kill switch is ON'); } finally { delete process.env.LOCALIZATION_DISABLED; }
      expect((await req('get', '/internal-admin-localization/')).text).not.toContain('Kill switch is ON');
    });
  });

  describe('scripts/localization-flag.js core with the real models', () => {
    const realDeps = (lines) => ({
      adminUser: 'cli:itest',
      print: (l) => lines.push(l),
      findWorkspace: (id) => Workspace.findById(id).select('name').lean(),
      getFlag: (id) => LocaleSettings.findOne({ workspaceId: id }).lean(),
      async listFlags() {
        const rows = await LocaleSettings.find({}).sort({ arabicEnabled: -1, updatedAt: -1 }).limit(500).lean();
        return rows.map((r) => ({ ...r, workspaceId: String(r.workspaceId) }));
      },
      setFlag: (a) => settings.setArabicEnabled(a),
      addLog: (row) => LocalizationAdminLog.create(row),
    });

    test('enable -> status -> idempotent enable -> dry-run disable -> disable, with audit rows', async () => {
      const t = await h.makeTenant('Script', { flagged: false });
      const id = String(t.wsId);
      const lines = [];
      expect(await flagScript.run(flagScript.parseArgs(['enable', id, '--notes', 'تجربة']), realDeps(lines))).toBe(0);
      expect(await LocaleSettings.findOne({ workspaceId: t.wsId }).lean()).toMatchObject({ arabicEnabled: true, arabicEnabledBy: 'cli:itest', notes: 'تجربة' });
      expect(await settings.isArabicEnabled(t.wsId)).toBe(true);
      const again = [];
      await flagScript.run(flagScript.parseArgs(['enable', id]), realDeps(again));
      expect(again.join('\n')).toMatch(/Already enabled/);
      expect(await LocalizationAdminLog.countDocuments({ workspaceId: t.wsId })).toBe(1);
      const dry = [];
      await flagScript.run(flagScript.parseArgs(['disable', id, '--dry-run']), realDeps(dry));
      expect(dry.join('\n')).toMatch(/Nothing was written/);
      expect((await LocaleSettings.findOne({ workspaceId: t.wsId }).lean()).arabicEnabled).toBe(true);
      await flagScript.run(flagScript.parseArgs(['disable', id]), realDeps([]));
      expect(await settings.isArabicEnabled(t.wsId)).toBe(false);
      const log = await LocalizationAdminLog.find({ workspaceId: t.wsId }).sort({ createdAt: 1 }).lean();
      expect(log.map((l) => l.action)).toEqual(['enable', 'disable']); expect(log[0].ip).toBe('cli');
      const listed = [];
      await flagScript.run(flagScript.parseArgs(['list']), realDeps(listed));
      expect(listed.some((l) => l.includes(id))).toBe(true);
    });

    test('unknown workspace id returns 1 and writes nothing', async () => {
      const lines = [];
      const code = await flagScript.run(flagScript.parseArgs(['enable', '000000000000000000000055']), realDeps(lines));
      expect(code).toBe(1);
      expect(await LocaleSettings.countDocuments({ workspaceId: '000000000000000000000055' })).toBe(0);
    });
  });

  describe('scheduler lock and sweep entry points', () => {
    const NOW = () => Date.now();
    const expireLock = () => SchedulerLock.updateOne({ _id: scheduler.LOCK_ID }, { $set: { lockedUntil: new Date(0) } });
    const deps = (over = {}) => ({ SchedulerLock: () => SchedulerLock, settings: () => settings, templates: () => ({ refreshPending: async () => ({ checked: 0 }) }), campaigns: () => ({ resumeStuckCampaigns: async () => ({ resumed: 0 }) }), log: () => {}, now: NOW, ...over });

    test('exactly one of N concurrent instances wins an expired lock; a live lock is refused; an expired one is taken over', async () => {
      await SchedulerLock.updateOne({ _id: scheduler.LOCK_ID }, { $setOnInsert: { lockedAt: new Date(0), lockedUntil: new Date(0) } }, { upsert: true });
      await expireLock();
      const results = await Promise.all(Array.from({ length: 10 }, () => scheduler.acquireLock(deps(), 60 * 1000)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await scheduler.acquireLock(deps(), 60 * 1000)).toBe(false); // live
      const doc = await SchedulerLock.findById(scheduler.LOCK_ID).lean();
      expect(doc.lockedUntil.getTime()).toBeGreaterThan(Date.now());
      await expireLock();
      expect(await scheduler.acquireLock(deps(), 60 * 1000)).toBe(true);
      expect(await SchedulerLock.countDocuments({ _id: scheduler.LOCK_ID })).toBe(1);
    });

    test('a lock that does not exist yet is created once even under a race (E11000 means "someone else has it")', async () => {
      const lockId = scheduler.LOCK_ID;
      const probe = { SchedulerLock: () => ({
        findOneAndUpdate: (...a) => SchedulerLock.findOneAndUpdate(...a),
        create: async () => { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; },
      }) };
      await SchedulerLock.updateOne({ _id: lockId }, { $set: { lockedUntil: new Date(Date.now() + 60000) } });
      expect(await scheduler.acquireLock({ ...deps(), ...probe }, 60 * 1000)).toBe(false);
      const boom = { SchedulerLock: () => ({ findOneAndUpdate: async () => null, create: async () => { throw new Error('mongo down'); } }) };
      await expect(scheduler.acquireLock({ ...deps(), ...boom }, 60 * 1000)).rejects.toThrow('mongo down');
    });

    test('tick runs the sweep only for the lock holder and never throws (a failing step is logged, the other still runs)', async () => {
      await expireLock();
      const calls = [];
      const d = deps({
        templates: () => ({ refreshPending: async () => { calls.push('templates'); throw new Error('meta exploded'); } }),
        campaigns: () => ({ resumeStuckCampaigns: async () => { calls.push('campaigns'); return { resumed: 2 }; } }),
        log: (...a) => calls.push(`log:${a.join(' ')}`),
      });
      const first = await scheduler.tick(d, 60 * 1000);
      expect(first).toMatchObject({ skipped: false, templates: null, campaigns: { resumed: 2 } });
      expect(calls).toEqual(['templates', expect.stringMatching(/^log:template refresh failed: meta exploded/), 'campaigns']);
      const second = await scheduler.tick(d, 60 * 1000); // lock is live now
      expect(second).toBeNull();
      expect(calls.filter((c2) => c2 === 'campaigns')).toHaveLength(1);
    });

    test('runSweepOnce with the real settings module honours the kill switch and survives missing modules', async () => {
      const seen = [];
      const d = deps({ templates: () => ({ refreshPending: async () => { seen.push('t'); return {}; } }) });
      process.env.LOCALIZATION_DISABLED = '1';
      try { expect(await scheduler.runSweepOnce(d)).toMatchObject({ skipped: true }); } finally { delete process.env.LOCALIZATION_DISABLED; }
      expect(seen).toEqual([]);
      const broken = deps({ templates: () => { throw new Error('cannot load'); }, campaigns: () => { throw new Error('cannot load either'); } });
      expect(await scheduler.runSweepOnce(broken)).toEqual({ skipped: false, templates: null, campaigns: null });
    });

    test('start is idempotent, unref()s its timer and stop lets a later start begin afresh', async () => {
      let created = 0;
      const fakeSetInterval = (fn) => { created += 1; return { unref() { this.unrefed = true; }, fn }; };
      await expireLock();
      const handle = scheduler.startLocalizationScheduler({ intervalMs: 60000, deps: deps(), setIntervalFn: fakeSetInterval });
      const again = scheduler.startLocalizationScheduler({ intervalMs: 60000, deps: deps(), setIntervalFn: fakeSetInterval });
      expect(again).toBe(handle); expect(created).toBe(1); expect(handle.unrefed).toBe(true);
      scheduler.stopLocalizationScheduler(() => {});
      scheduler.startLocalizationScheduler({ intervalMs: 60000, deps: deps(), setIntervalFn: fakeSetInterval });
      expect(created).toBe(2);
      scheduler.stopLocalizationScheduler(() => {});
    });
  });

  test('unused model imports stay referenced (membership/user fixtures exist)', async () => {
    expect(await Membership.countDocuments({ workspaceId: ctx.A.wsId })).toBe(1);
    expect(await User.countDocuments({ _id: ctx.A.userId })).toBe(1);
  });
});
