'use strict';
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const cli = require('../../../scripts/onboarding-admin');
const realState = require('../../../shared/onboarding/state');
const config = require('../../../shared/onboarding/config');
const { OnbError } = require('../../../shared/onboarding/errors');
const { createFakeModel } = require('./_b0Store');

const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const WS2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const OLDEST = 'cccccccccccccccccccccccc';
const NOW = new Date('2026-10-15T10:00:00Z');
const SCRIPT = path.join(__dirname, '../../../scripts/onboarding-admin.js');

describe('parseArgs', () => {
  test('every command and its flags', () => {
    expect(cli.parseArgs(['list'])).toMatchObject({ command: 'list' });
    expect(cli.parseArgs(['funnel'])).toMatchObject({ command: 'funnel' });
    expect(cli.parseArgs(['status', WS])).toMatchObject({ command: 'status', workspaceId: WS });
    expect(cli.parseArgs(['enrol', WS])).toMatchObject({ command: 'enrol', workspaceId: WS, activate: false, forceOldest: false, confirmExistingData: false, dryRun: false });
    expect(cli.parseArgs(['enrol', WS, '--activate', '--notes', 'KSA pilot', '--force-oldest', '--confirm-existing-data', '--dry-run']))
      .toMatchObject({ activate: true, notes: 'KSA pilot', forceOldest: true, confirmExistingData: true, dryRun: true });
    expect(cli.parseArgs(['--dry-run', 'enrol', '--notes=x y', WS])).toMatchObject({ command: 'enrol', workspaceId: WS, notes: 'x y', dryRun: true });
    expect(cli.parseArgs(['unenrol', WS])).toMatchObject({ command: 'unenrol', workspaceId: WS, all: false });
    expect(cli.parseArgs(['unenrol', '--all'])).toMatchObject({ command: 'unenrol', all: true, workspaceId: null });
    expect(cli.parseArgs(['unenrol', '--all', '--dry-run', '--notes', 'rollback'])).toMatchObject({ all: true, dryRun: true, notes: 'rollback' });
    expect(cli.parseArgs(['activate', WS, '--notes', 'Riyadh partner'])).toMatchObject({ command: 'activate', notes: 'Riyadh partner' });
    expect(cli.parseArgs(['deactivate', WS])).toMatchObject({ command: 'deactivate', workspaceId: WS });
  });
  test('notes are capped at 500 characters', () => {
    expect(cli.parseArgs(['activate', WS, '--notes', 'n'.repeat(900)]).notes).toHaveLength(500);
    expect(cli.parseArgs(['enrol', WS, `--notes=${'n'.repeat(900)}`]).notes).toHaveLength(500);
  });
  test.each([
    [[], 'Missing or unknown command'],
    [['bogus'], 'Missing or unknown command'],
    [['status'], '24-character'],
    [['status', 'not-an-id'], '24-character'],
    [['enrol', 'a'.repeat(23)], '24-character'],
    [['status', WS, '--dry-run'], 'does not apply'],
    [['list', '--notes', 'x'], 'does not apply'],
    [['funnel', '--all'], 'does not apply'],
    [['enrol', WS, '--all'], 'does not apply'],
    [['unenrol', WS, '--activate'], 'does not apply'],
    [['activate', WS, '--force-oldest', '--notes', 'x'], 'does not apply'],
    [['activate', WS], 'needs --notes'],
    [['activate', WS, '--notes', '   '], 'needs --notes'],
    [['activate', WS, '--notes'], '--notes needs a value'],
    [['unenrol'], 'workspace id (or --all)'],
    [['unenrol', WS, '--all'], 'not both'],
    [['enrol', WS, 'extra'], 'Too many arguments'],
    [['list', WS], 'Too many arguments'],
    [['enrol', WS, '--frobnicate'], 'Unknown option'],
  ])('%j -> UsageError', (argv, message) => {
    let err;
    try { cli.parseArgs(argv); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(cli.UsageError);
    expect(err.message).toContain(message);
  });
  test('USAGE lists every command and no secret-looking value', () => {
    for (const c of ['list', 'status', 'enrol', 'unenrol', 'activate', 'deactivate', 'funnel', '--all', '--dry-run', '--force-oldest', '--confirm-existing-data']) expect(cli.USAGE).toContain(c);
    expect(cli.USAGE).not.toMatch(/mongodb/i);
  });
});

function fakeDeps(over = {}) {
  const state = {
    enrol: jest.fn(async () => ({ ok: true, dryRun: false, alreadyEnrolled: false, enrolled: true, r1Applied: true, activated: false, warnings: [] })),
    unenrol: jest.fn(async () => ({ ok: true, dryRun: false, wasEnrolled: true })),
    unenrolAll: jest.fn(async () => ({ ok: true, dryRun: false, count: 3 })),
    adminActivate: jest.fn(async () => ({ ok: true, dryRun: false, before: { state: 'none' }, after: { state: 'active' } })),
    adminDeactivate: jest.fn(async () => ({ ok: true, dryRun: false, before: { state: 'active' }, after: { state: 'none' } })),
  };
  return {
    adminUser: 'cli:tester',
    state,
    analytics: { funnel: jest.fn(async () => ({ generatedAt: NOW.toISOString(), enrolled: 2, completed: 1, truncated: false, steps: { business: { entered: 2, completed: 2, skipped: 0, medianMinutes: 12.5, dropOff: 1 } }, failureCodes: [{ code: 'ONB_NETWORK', count: 3 }], subscription: { active: 2 }, connection: { connected: 1 }, warnings: [] })) },
    findWorkspace: async (id) => ({ name: id === OLDEST ? 'Owner WS' : 'Salon', createdAt: new Date('2026-10-01T00:00:00Z') }),
    getState: async () => ({
      enrolled: true, enrolledAt: NOW, enrolledVia: 'admin', enrolledBy: 'staff', r1Applied: true,
      subscription: { state: 'active', source: 'admin', stripe: { status: 'trialing', currentPeriodEnd: NOW }, admin: { active: true, by: 'staff', at: NOW, notes: 'partner' } },
      progress: { status: 'in_progress', currentStep: 3, lastActivityAt: NOW }, steps: { business: { status: 'done', enteredAt: NOW, completedAt: NOW } }, number: { path: 'A', usage: 'unused', numberReady: false, reminderCount: 0 },
    }),
    getConnection: async () => ({ status: 'connected', display: { displayPhoneNumber: '966501234567', last4: '4567' }, tokenIsValid: true, tokenExpiresAt: NOW, needsReconnect: false, lastStatusCheckAt: NOW }),
    resolveRecipient: async () => ({ to: 'x@example.test', language: 'en' }),
    findWebhookWorkspace: async () => ({ workspaceId: OLDEST, name: 'Owner WS', createdAt: new Date('2026-01-01T00:00:00Z') }),
    listStates: async () => [
      { workspaceId: WS, name: 'Salon', enrolled: true, enrolledAt: NOW, subscription: { state: 'active', source: 'admin' }, progress: { status: 'in_progress' } },
      { workspaceId: WS2, name: 'Old pilot', enrolled: false, enrolledAt: NOW, subscription: { state: 'none' }, progress: { status: 'paused_number' } },
    ],
    ...over,
  };
}
const args = (argv) => cli.parseArgs(argv);

describe('run: read-only commands', () => {
  test('list marks the oldest workspace even when it is not enrolled, and shows un-enrolled rows', async () => {
    const r = await cli.run(args(['list']), fakeDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${WS}  Salon  ENROLLED  sub:active/admin`);
    expect(r.out).toContain(`${WS2}  Old pilot  un-enrolled`);
    expect(r.out).toContain(`${OLDEST}  Owner WS  legacy (not enrolled)`);
    expect(r.out).toContain('[webhook workspace / owner]');
  });
  test('list with nothing enrolled and no webhook workspace', async () => {
    const r = await cli.run(args(['list']), fakeDeps({ listStates: async () => [], findWebhookWorkspace: undefined }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('No workspace is enrolled');
  });
  test('status of an enrolled workspace: masked number, token health, subscription, no secrets, no full number', async () => {
    const r = await cli.run(args(['status', WS]), fakeDeps());
    expect(r.code).toBe(0);
    expect(r.out).toContain('Workspace: Salon');
    expect(r.out).toContain('Subscription: active (source admin), raw Stripe status trialing');
    expect(r.out).toContain('*******4567');
    expect(r.out).toContain('token valid yes');
    expect(r.out).toContain('E-mail on file: yes');
    expect(r.out).not.toContain('966501234567');
    expect(r.out).not.toContain('WARNING');
  });
  test('status: no e-mail warning, legacy workspace, un-enrolled workspace, oldest warning, unknown workspace', async () => {
    expect((await cli.run(args(['status', WS]), fakeDeps({ resolveRecipient: async () => null }))).out).toContain('WARNING: no e-mail on file');
    expect((await cli.run(args(['status', WS]), fakeDeps({ getState: async () => null }))).out).toContain('not enrolled (legacy workspace: nothing is gated)');
    expect((await cli.run(args(['status', WS]), fakeDeps({ getState: async () => ({ enrolled: false, unenrolledAt: NOW, unenrolledBy: 'cli:x' }) }))).out).toContain('un-enrolled');
    const oldest = await cli.run(args(['status', OLDEST]), fakeDeps());
    expect(oldest.out).toContain('WARNING: this is the OLDEST workspace [webhook workspace / owner]');
    const missing = await cli.run(args(['status', WS]), fakeDeps({ findWorkspace: async () => null }));
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(`No workspace with id ${WS}`);
  });
  test('funnel prints the numbers', async () => {
    const d = fakeDeps();
    const r = await cli.run(args(['funnel']), d);
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 enrolled, 1 finished');
    expect(r.out).toContain('business');
    expect(r.out).toContain('12.5');
    expect(r.out).toContain('ONB_NETWORK=3');
    expect(d.analytics.funnel).toHaveBeenCalledTimes(1);
  });
});

describe('run: commands that change things go through state.js with the CLI identity', () => {
  test('enrol passes every flag, "cli:<user>" as admin and ip "cli"', async () => {
    const d = fakeDeps();
    const r = await cli.run(args(['enrol', WS, '--activate', '--notes', 'KSA pilot', '--force-oldest', '--confirm-existing-data']), d);
    expect(r.code).toBe(0);
    expect(d.state.enrol).toHaveBeenCalledWith({ workspaceId: WS, via: 'admin', by: 'cli:tester', notes: 'KSA pilot', ip: 'cli', dryRun: false, activate: true, forceOldest: true, confirmExistingData: true }, undefined);
    expect(r.out).toContain('Enrolled');
    expect(r.out).toContain('only takes effect while ONBOARDING_FLOW=on');
  });
  test('enrol --dry-run says nothing was written; already enrolled is a no-op message', async () => {
    const d = fakeDeps();
    d.state.enrol.mockResolvedValue({ ok: true, dryRun: true, alreadyEnrolled: false, enrolled: false, warnings: ['existing_data_confirmed'] });
    const r = await cli.run(args(['enrol', WS, '--dry-run', '--activate']), d);
    expect(r.out).toContain('Dry run: would enrol this workspace and admin-activate its subscription');
    expect(r.out).toContain('Nothing was written');
    expect(r.out).toContain('Note: existing_data_confirmed');
    expect(d.state.enrol.mock.calls[0][0].dryRun).toBe(true);
    d.state.enrol.mockResolvedValue({ ok: true, dryRun: false, alreadyEnrolled: true, enrolled: true, warnings: [] });
    expect((await cli.run(args(['enrol', WS]), d)).out).toContain('Already enrolled; nothing to do.');
  });
  test('the oldest workspace prints the warning before it is refused (exit 1, names the flag)', async () => {
    const d = fakeDeps();
    d.state.enrol.mockRejectedValue(new OnbError('VALIDATION_FAILED', { details: { reason: 'OLDEST_WORKSPACE' } }));
    const r = await cli.run(args(['enrol', OLDEST]), d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('[webhook workspace / owner]');
    expect(r.out).toContain('--force-oldest');
  });
  test('existing data refusal names --confirm-existing-data and lists the reasons', async () => {
    const d = fakeDeps();
    d.state.enrol.mockRejectedValue(new OnbError('VALIDATION_FAILED', { details: { reason: 'EXISTING_DATA', reasons: ['customers', 'orders'] } }));
    const r = await cli.run(args(['enrol', WS]), d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--confirm-existing-data');
    expect(r.out).toContain('(customers, orders)');
  });
  test('unenrol <id>, unenrol --all, activate, deactivate and their dry runs', async () => {
    const d = fakeDeps();
    expect((await cli.run(args(['unenrol', WS, '--notes', 'over']), d)).out).toContain('Un-enrolled.');
    expect(d.state.unenrol).toHaveBeenCalledWith({ workspaceId: WS, by: 'cli:tester', notes: 'over', ip: 'cli', dryRun: false }, undefined);
    d.state.unenrol.mockResolvedValue({ ok: true, dryRun: false, wasEnrolled: false });
    expect((await cli.run(args(['unenrol', WS]), d)).out).toContain('Not enrolled; nothing to do.');
    d.state.unenrol.mockResolvedValue({ ok: true, dryRun: true, wasEnrolled: true });
    expect((await cli.run(args(['unenrol', WS, '--dry-run']), d)).out).toContain('Nothing was written');

    const all = await cli.run(args(['unenrol', '--all']), d);
    expect(all.out).toContain('Un-enrolled 3 workspace(s)');
    expect(d.state.unenrolAll).toHaveBeenCalledWith({ by: 'cli:tester', notes: undefined, dryRun: false, ip: 'cli' }, undefined);
    d.state.unenrolAll.mockResolvedValue({ ok: true, dryRun: true, count: 3 });
    expect((await cli.run(args(['unenrol', '--all', '--dry-run']), d)).out).toContain('Dry run: would un-enrol 3 workspace(s). Nothing was written.');

    expect((await cli.run(args(['activate', WS, '--notes', 'Riyadh partner']), d)).out).toContain('Subscription none -> active.');
    expect(d.state.adminActivate).toHaveBeenCalledWith({ workspaceId: WS, by: 'cli:tester', notes: 'Riyadh partner', ip: 'cli', dryRun: false }, undefined);
    expect((await cli.run(args(['deactivate', WS]), d)).out).toContain('Subscription active -> none.');
    d.state.adminActivate.mockResolvedValue({ ok: true, dryRun: true, before: { state: 'none' }, after: { state: 'active' } });
    expect((await cli.run(args(['activate', WS, '--notes', 'x', '--dry-run']), d)).out).toContain('Dry run: would change none -> active. Nothing was written.');
  });
  test('exit codes: unknown workspace 1, refused safeguard 1, runtime failure 1 (message redacted), success 0', async () => {
    const d = fakeDeps({ findWorkspace: async () => null });
    expect((await cli.run(args(['enrol', WS]), d)).code).toBe(1);
    expect(d.state.enrol).not.toHaveBeenCalled();
    const e = fakeDeps();
    e.state.adminDeactivate.mockRejectedValue(new Error('connect ECONNREFUSED mongodb+srv://user:p4ss@cluster0.example.mongodb.net/waflow?retryWrites=true'));
    const r = await cli.run(args(['deactivate', WS]), e);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Failed:');
    expect(r.out).not.toMatch(/mongodb|p4ss|cluster0/);
    e.state.adminDeactivate.mockRejectedValue(new OnbError('VALIDATION_FAILED', { details: { reason: 'NOT_ENROLLED' } }));
    expect((await cli.run(args(['deactivate', WS]), e)).code).toBe(1);
    e.state.adminActivate.mockRejectedValue(new OnbError('VALIDATION_FAILED', { details: { reason: 'NOTES_REQUIRED' } }));
    expect((await cli.run(args(['activate', WS, '--notes', 'x']), e)).out).toContain('--notes');
    expect((await cli.run(args(['funnel']), fakeDeps())).code).toBe(0);
  });
  test('redact removes connection strings only', () => {
    expect(cli.redact('boom mongodb://u:p@h:1/db?x=1 end')).toBe('boom [redacted] end');
    expect(cli.redact('plain message')).toBe('plain message');
    expect(cli.redact(undefined)).toBe('');
  });
});

describe('run with the REAL state.js (fake models) and the flag OFF', () => {
  let savedFlag;
  beforeEach(() => { savedFlag = process.env.ONBOARDING_FLOW; delete process.env.ONBOARDING_FLOW; realState.clearCache(); });
  afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

  function world() {
    const OnboardingState = createFakeModel({ defaults: { 'subscription.state': 'none' } }); // the schema default
    const Workspace = createFakeModel();
    const ws = (id, created) => Workspace.seed({ _id: id, name: `WS ${id.slice(0, 2)}`, createdAt: new Date(created), onboarding: { completed: false } });
    ws(WS, '2026-10-01T00:00:00Z'); ws(WS2, '2026-10-02T00:00:00Z'); ws(OLDEST, '2026-01-01T00:00:00Z');
    const log = [];
    const OnboardingAdminLog = { create: async (row) => { log.push(row); return row; } };
    const stateDeps = { OnboardingState, Workspace, OnboardingAdminLog, Customer: createFakeModel(), Order: createFakeModel(), Promotion: createFakeModel(), WhatsAppConnection: createFakeModel(), now: () => NOW, track: async () => {} };
    const deps = fakeDeps({
      state: realState, stateDeps,
      findWorkspace: async (id) => Workspace.findOne({ _id: id }).lean(),
      getState: async (id) => OnboardingState.findOne({ workspaceId: id }).lean(),
      listStates: async () => OnboardingState.find({}).lean(),
    });
    return { deps, OnboardingState, Workspace, log };
  }
  const flagIsOff = () => { expect(config.enabled()).toBe(false); expect(process.env.ONBOARDING_FLOW).toBeUndefined(); };

  test('enrol, activate, status, deactivate, unenrol all work with ONBOARDING_FLOW unset', async () => {
    const w = world();
    flagIsOff();
    let r = await cli.run(args(['enrol', WS, '--notes', 'pilot']), w.deps);
    expect(r).toMatchObject({ code: 0 });
    expect(w.OnboardingState.rows).toHaveLength(1);
    expect(w.log.map((l) => [l.action, l.adminUser, l.ip])).toEqual([['enrol', 'cli:tester', 'cli']]);
    r = await cli.run(args(['activate', WS, '--notes', 'Riyadh partner']), w.deps);
    expect(r.code).toBe(0);
    expect(w.OnboardingState.rows[0].subscription.state).toBe('active');
    r = await cli.run(args(['status', WS]), w.deps);
    expect(r.code).toBe(0);
    r = await cli.run(args(['deactivate', WS]), w.deps);
    expect(r.code).toBe(0);
    r = await cli.run(args(['unenrol', WS]), w.deps);
    expect(r.code).toBe(0);
    expect(w.OnboardingState.rows[0].enrolled).toBe(false);
    expect(w.log.map((l) => l.action)).toEqual(['enrol', 'activate', 'deactivate', 'unenrol']);
    flagIsOff();
  });
  test('--dry-run writes NOTHING (no sidecar row, no audit row, no R1)', async () => {
    const w = world();
    const r = await cli.run(args(['enrol', WS, '--dry-run', '--activate']), w.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Dry run');
    expect(w.OnboardingState.rows).toHaveLength(0);
    expect(w.log).toHaveLength(0);
    expect(w.Workspace.rows.find((x) => x._id === WS).onboarding.completed).toBe(false);
    expect(w.OnboardingState.calls.filter((c) => ['create', 'updateOne'].includes(c[0]))).toHaveLength(0);
  });
  test('the safeguards hold from the CLI: oldest workspace and existing data are refused (exit 1, nothing written), then pass with their flags', async () => {
    const w = world();
    let r = await cli.run(args(['enrol', OLDEST]), w.deps);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--force-oldest');
    expect(w.OnboardingState.rows).toHaveLength(0);
    expect(w.log).toHaveLength(0);
    r = await cli.run(args(['enrol', OLDEST, '--force-oldest']), w.deps);
    expect(r.code).toBe(0);
    expect(w.OnboardingState.rows).toHaveLength(1);
    w.deps.stateDeps.Customer.seed({ workspaceId: WS2, name: 'c' });
    r = await cli.run(args(['enrol', WS2]), w.deps);
    expect(r.code).toBe(1);
    expect(r.out).toContain('--confirm-existing-data');
    expect((await cli.run(args(['enrol', WS2, '--confirm-existing-data']), w.deps)).code).toBe(0);
  });
  test('unenrol --all un-enrols every enrolled workspace, keeps the rows and logs each one; --all --dry-run writes nothing', async () => {
    const w = world();
    for (const id of [WS, WS2]) await cli.run(args(['enrol', id]), w.deps);
    await cli.run(args(['enrol', OLDEST, '--force-oldest']), w.deps);
    w.log.length = 0;
    const dry = await cli.run(args(['unenrol', '--all', '--dry-run']), w.deps);
    expect(dry.out).toContain('would un-enrol 3');
    expect(w.OnboardingState.rows.every((x) => x.enrolled === true)).toBe(true);
    expect(w.log).toHaveLength(0);
    const r = await cli.run(args(['unenrol', '--all', '--notes', 'rollback']), w.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Un-enrolled 3 workspace(s)');
    expect(w.OnboardingState.rows).toHaveLength(3); // rows kept
    expect(w.OnboardingState.rows.every((x) => x.enrolled === false)).toBe(true);
    expect(w.log.map((l) => l.action)).toEqual(['unenrol', 'unenrol', 'unenrol']);
    expect(w.log.every((l) => l.adminUser === 'cli:tester' && l.notes === 'rollback')).toBe(true);
    expect((await realState.getGateState(WS, { fresh: true, deps: w.deps.stateDeps })).enrolled).toBe(false);
    const again = await cli.run(args(['unenrol', '--all']), w.deps);
    expect(again.out).toContain('Un-enrolled 0 workspace(s)');
  });
});

describe('thin wrapper', () => {
  test('buildDeps identifies the operator as cli:<osuser>', () => {
    let user = 'unknown';
    try { user = os.userInfo().username; } catch (e) { /* none */ }
    const deps = cli.buildDeps();
    expect(deps.adminUser).toBe(`cli:${user}`);
    for (const k of ['state', 'analytics', 'findWorkspace', 'getState', 'getConnection', 'listStates', 'findWebhookWorkspace']) expect(deps[k]).toBeDefined();
  });
  test('main() only runs when executed directly: bad usage exits 2 with the usage text, before touching any environment or database', () => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    for (const argv of [['bogus'], [], ['activate', WS], ['unenrol'], ['enrol', 'x']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...argv], { env, encoding: 'utf8', timeout: 20000 });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('Usage:');
      expect(r.stdout).toBe('');
    }
  });
  test('requiring the module has no side effects (no exit, no output)', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit called'); });
    jest.isolateModules(() => { require('../../../scripts/onboarding-admin'); });
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });
});
