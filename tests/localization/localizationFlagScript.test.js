// Tests for the testable core of scripts/localization-flag.js (arg parsing + commands with injected
// dependencies). The script's connect/disconnect wrapper only runs under `node scripts/...`, never here.
const { parseArgs, run, describeFlag, UsageError } = require('../../scripts/localization-flag');

const WS = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function makeDeps({ workspace = { name: 'Salon' }, flag = null, flags = [] } = {}) {
  const lines = [];
  return {
    lines,
    adminUser: 'cli:tester',
    print: (l) => lines.push(l),
    findWorkspace: jest.fn(async () => workspace),
    getFlag: jest.fn(async () => flag),
    listFlags: jest.fn(async () => flags),
    setFlag: jest.fn(async ({ enabled }) => ({ arabicEnabled: enabled, arabicEnabledBy: 'cli:tester', arabicEnabledAt: new Date('2026-10-12T00:00:00Z') })),
    addLog: jest.fn(async () => ({})),
  };
}

describe('parseArgs', () => {
  test('parses commands, notes (both forms) and dry-run', () => {
    expect(parseArgs(['list'])).toMatchObject({ command: 'list' });
    expect(parseArgs(['enable', WS, '--notes', 'KSA pilot', '--dry-run'])).toMatchObject({ command: 'enable', workspaceId: WS, notes: 'KSA pilot', dryRun: true });
    expect(parseArgs(['disable', WS, '--notes=bye'])).toMatchObject({ notes: 'bye', dryRun: false });
    expect(parseArgs(['status', WS]).notes).toBeUndefined();
  });

  test('keeps Arabic notes intact and caps their length', () => {
    expect(parseArgs(['enable', WS, '--notes', 'تجربة العميل']).notes).toBe('تجربة العميل');
    expect(parseArgs(['enable', WS, '--notes', 'x'.repeat(900)]).notes).toHaveLength(500);
  });

  test.each([
    [[]], [['bogus']], [['enable']], [['enable', 'not-an-id']], [['enable', `${WS}zz`]],
    [['enable', WS, '--notes']], [['enable', WS, '--force']], [['list', WS]], [['status', WS, 'extra']],
    [['enable', '{"$ne":null}']],
  ])('rejects bad usage %j', (argv) => {
    expect(() => parseArgs(argv)).toThrow(UsageError);
  });
});

describe('run', () => {
  test('list prints each record or an empty message', async () => {
    const deps = makeDeps({ flags: [{ workspaceId: WS, name: 'Salon', arabicEnabled: true, notes: 'pilot' }] });
    expect(await run({ command: 'list' }, deps)).toBe(0);
    expect(deps.lines[0]).toContain(`${WS}  Salon  ENABLED`);
    const empty = makeDeps();
    await run({ command: 'list' }, empty);
    expect(empty.lines[0]).toMatch(/No workspace/);
  });

  test('refuses an unknown workspace with exit 1 and writes nothing', async () => {
    const deps = makeDeps({ workspace: null });
    expect(await run({ command: 'enable', workspaceId: WS }, deps)).toBe(1);
    expect(deps.setFlag).not.toHaveBeenCalled();
    expect(deps.addLog).not.toHaveBeenCalled();
  });

  test('status is read-only', async () => {
    const deps = makeDeps({ flag: { arabicEnabled: true } });
    expect(await run({ command: 'status', workspaceId: WS }, deps)).toBe(0);
    expect(deps.setFlag).not.toHaveBeenCalled();
    expect(deps.lines.join('\n')).toContain('ENABLED');
  });

  test('enable writes through the service as cli:<user>, logs, prints before and after', async () => {
    const deps = makeDeps();
    expect(await run({ command: 'enable', workspaceId: WS, notes: 'pilot' }, deps)).toBe(0);
    expect(deps.setFlag).toHaveBeenCalledWith({ workspaceId: WS, enabled: true, grantedBy: 'cli:tester', notes: 'pilot' });
    expect(deps.addLog).toHaveBeenCalledWith({ workspaceId: WS, action: 'enable', adminUser: 'cli:tester', notes: 'pilot', ip: 'cli' });
    const out = deps.lines.join('\n');
    expect(out).toContain('Before:    disabled');
    expect(out).toContain('After:     ENABLED');
  });

  test('disable logs action disable', async () => {
    const deps = makeDeps({ flag: { arabicEnabled: true } });
    await run({ command: 'disable', workspaceId: WS }, deps);
    expect(deps.setFlag.mock.calls[0][0].enabled).toBe(false);
    expect(deps.addLog.mock.calls[0][0].action).toBe('disable');
  });

  test('LOG BEFORE MUTATE (as the admin page does): the audit row is written before the flag changes, and a failed log write leaves the flag alone', async () => {
    const ordered = makeDeps();
    await run({ command: 'enable', workspaceId: WS }, ordered);
    expect(ordered.addLog.mock.invocationCallOrder[0]).toBeLessThan(ordered.setFlag.mock.invocationCallOrder[0]);

    const failing = makeDeps({ flag: { arabicEnabled: true } });
    failing.addLog.mockRejectedValue(new Error('log collection unavailable'));
    await expect(run({ command: 'disable', workspaceId: WS }, failing)).rejects.toThrow('log collection unavailable');
    expect(failing.setFlag).not.toHaveBeenCalled();
    expect(failing.lines.join('\n')).not.toContain('After:');
  });

  test('dry-run writes and logs nothing', async () => {
    const deps = makeDeps();
    expect(await run({ command: 'enable', workspaceId: WS, dryRun: true }, deps)).toBe(0);
    expect(deps.setFlag).not.toHaveBeenCalled();
    expect(deps.addLog).not.toHaveBeenCalled();
    expect(deps.lines.join('\n')).toMatch(/Nothing was written/);
  });

  test('already in the requested state is a no-op unless notes are supplied', async () => {
    const deps = makeDeps({ flag: { arabicEnabled: true } });
    await run({ command: 'enable', workspaceId: WS }, deps);
    expect(deps.setFlag).not.toHaveBeenCalled();
    await run({ command: 'enable', workspaceId: WS, notes: 'updated note' }, deps);
    expect(deps.setFlag).toHaveBeenCalledTimes(1);
  });

  test('describeFlag never prints more than the flag fields', () => {
    expect(describeFlag(null)).toBe('disabled');
    expect(describeFlag({ arabicEnabled: true, arabicEnabledBy: 'x', secret: 'mongodb://u:p@h' })).not.toContain('mongodb');
  });
});
