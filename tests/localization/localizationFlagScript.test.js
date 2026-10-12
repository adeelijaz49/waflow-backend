// Tests for the testable core of scripts/localization-flag.js (arg parsing + commands with injected
// dependencies). The script's connect/disconnect wrapper only runs under `node scripts/...`, never here.
const { parseArgs, run, describeFlag, webhookWarning, UsageError, WEBHOOK_MARK } = require('../../scripts/localization-flag');

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

const OLDEST = 'cccccccccccccccccccccccc';
const OLDEST_WS = { workspaceId: OLDEST, name: 'First Salon', createdAt: new Date('2025-01-02T03:04:05Z') };

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

  describe('R5-2: the webhook workspace (the OLDEST one) is visible to the operator', () => {
    test('list shows the oldest workspace marked even when it has no LocaleSettings row yet', async () => {
      const deps = makeDeps({ flags: [{ workspaceId: WS, name: 'Salon', arabicEnabled: true }] });
      deps.findWebhookWorkspace = jest.fn(async () => OLDEST_WS);
      expect(await run({ command: 'list' }, deps)).toBe(0);
      expect(deps.lines[0]).toBe(`${WS}  Salon  ENABLED`); // the row of another workspace is unchanged
      const oldestLine = deps.lines.find((l) => l.startsWith(OLDEST));
      expect(oldestLine).toContain('First Salon');
      expect(oldestLine).toContain('no localisation record yet');
      expect(oldestLine).toContain(WEBHOOK_MARK);
      expect(deps.lines.join('\n')).toMatch(/OLDEST workspace/);
      expect(deps.findWebhookWorkspace).toHaveBeenCalledTimes(1);
    });

    test('list marks the oldest workspace once when it already has a record, and prints no duplicate row', async () => {
      const deps = makeDeps({ flags: [{ workspaceId: OLDEST, name: 'First Salon', arabicEnabled: false }] });
      deps.findWebhookWorkspace = async () => OLDEST_WS;
      await run({ command: 'list' }, deps);
      expect(deps.lines.filter((l) => l.startsWith(OLDEST))).toHaveLength(1);
      expect(deps.lines[0]).toContain(WEBHOOK_MARK);
    });

    test('list with no records at all still shows the webhook workspace instead of "No workspace"', async () => {
      const deps = makeDeps();
      deps.findWebhookWorkspace = async () => OLDEST_WS;
      await run({ command: 'list' }, deps);
      expect(deps.lines.join('\n')).not.toMatch(/No workspace has/);
      expect(deps.lines[0]).toContain(WEBHOOK_MARK);
    });

    test('status and enable print a WARNING (not an error: exit 0, the write still happens) for a workspace that is not the oldest', async () => {
      const status = makeDeps();
      status.findWebhookWorkspace = async () => OLDEST_WS;
      expect(await run({ command: 'status', workspaceId: WS }, status)).toBe(0);
      const out = status.lines.join('\n');
      expect(out).toContain('WARNING: Arabic in WhatsApp conversations only reaches the OLDEST workspace');
      expect(out).toContain('First Salon');
      expect(out).toContain(OLDEST);
      expect(out).toContain('2025-01-02');

      const enable = makeDeps();
      enable.findWebhookWorkspace = async () => OLDEST_WS;
      expect(await run({ command: 'enable', workspaceId: WS }, enable)).toBe(0);
      expect(enable.lines.join('\n')).toContain('WARNING: Arabic in WhatsApp conversations only reaches the OLDEST workspace');
      expect(enable.setFlag).toHaveBeenCalledTimes(1); // may still proceed
    });

    test('the oldest workspace itself gets no warning, only a statement that it is the webhook workspace', async () => {
      const deps = makeDeps();
      deps.findWebhookWorkspace = async () => OLDEST_WS;
      await run({ command: 'status', workspaceId: OLDEST }, deps);
      const out = deps.lines.join('\n');
      expect(out).not.toContain('WARNING');
      expect(out).toContain('This is the webhook workspace');
    });

    test('a failing or absent lookup never blocks a command and prints no warning', async () => {
      const failing = makeDeps();
      failing.findWebhookWorkspace = async () => { throw new Error('db down'); };
      expect(await run({ command: 'enable', workspaceId: WS }, failing)).toBe(0);
      expect(failing.lines.join('\n')).not.toContain('WARNING');
      expect(failing.setFlag).toHaveBeenCalledTimes(1);
      const none = makeDeps();
      none.findWebhookWorkspace = async () => null;
      await run({ command: 'status', workspaceId: WS }, none);
      expect(none.lines.join('\n')).not.toContain('WARNING');
    });

    test('dry-run and log-before-mutate are unchanged with the warning present', async () => {
      const deps = makeDeps();
      deps.findWebhookWorkspace = async () => OLDEST_WS;
      await run({ command: 'enable', workspaceId: WS, dryRun: true }, deps);
      expect(deps.addLog).not.toHaveBeenCalled();
      const real = makeDeps();
      real.findWebhookWorkspace = async () => OLDEST_WS;
      await run({ command: 'enable', workspaceId: WS }, real);
      expect(real.addLog.mock.invocationCallOrder[0]).toBeLessThan(real.setFlag.mock.invocationCallOrder[0]);
    });

    test('webhookWarning tolerates a missing name or date', () => {
      expect(webhookWarning({ workspaceId: OLDEST })).toContain('(unnamed workspace)');
      expect(webhookWarning({ workspaceId: OLDEST, createdAt: 'garbage' })).not.toContain('created');
    });
  });

  test('describeFlag never prints more than the flag fields', () => {
    expect(describeFlag(null)).toBe('disabled');
    expect(describeFlag({ arabicEnabled: true, arabicEnabledBy: 'x', secret: 'mongodb://u:p@h' })).not.toContain('mongodb');
  });
});
