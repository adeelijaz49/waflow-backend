const {
  startLocalizationScheduler, stopLocalizationScheduler, runSweepOnce, acquireLock, tick, LOCK_ID, DEFAULT_INTERVAL_MS,
} = require('../../shared/localization/scheduler');

function makeLock({ renewed = null, createError = null } = {}) {
  return {
    findOneAndUpdate: jest.fn(async () => renewed),
    create: jest.fn(async () => { if (createError) throw createError; return {}; }),
  };
}

function makeDeps(over = {}) {
  const lock = over.lock || makeLock();
  const templates = over.templates === undefined ? { refreshPending: jest.fn(async () => ({ checked: 2 })) } : over.templates;
  const campaigns = over.campaigns === undefined ? { resumeStuckCampaigns: jest.fn(async () => ({ resumed: 1 })) } : over.campaigns;
  const settings = over.settings || { killSwitchOn: () => false };
  const load = (mod, name) => () => { if (mod instanceof Error) throw mod; if (!mod) throw new Error(`Cannot find module ${name}`); return mod; };
  return {
    lock, templates, campaigns,
    deps: {
      SchedulerLock: () => lock,
      settings: load(settings, 'settings'),
      templates: load(templates, './templates'),
      campaigns: load(campaigns, './campaigns'),
      log: jest.fn(),
      now: () => Date.parse('2026-05-05T10:00:00Z'),
    },
  };
}

afterEach(() => stopLocalizationScheduler(() => {}));

describe('acquireLock', () => {
  test('renews an expired lock with returnDocument:after and TTL = interval - 30s', async () => {
    const { lock, deps } = makeDeps({ lock: makeLock({ renewed: { _id: LOCK_ID } }) });
    expect(await acquireLock(deps, 600000)).toBe(true);
    const [filter, update, opts] = lock.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe('localizationScheduler');
    expect(filter.lockedUntil.$lt).toEqual(new Date('2026-05-05T10:00:00Z'));
    expect(update.$set.lockedUntil).toEqual(new Date(Date.parse('2026-05-05T10:00:00Z') + 570000));
    expect(opts).toEqual({ returnDocument: 'after' });
    expect(lock.create).not.toHaveBeenCalled();
  });

  test('creates the lock when none exists; loses to a live lock (duplicate key)', async () => {
    const a = makeDeps();
    expect(await acquireLock(a.deps, 600000)).toBe(true);
    expect(a.lock.create).toHaveBeenCalledTimes(1);
    const b = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('dup'), { code: 11000 }) }) });
    expect(await acquireLock(b.deps, 600000)).toBe(false);
  });

  test('other database errors propagate', async () => {
    const { deps } = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('boom'), { code: 1 }) }) });
    await expect(acquireLock(deps, 600000)).rejects.toThrow('boom');
  });
});

describe('runSweepOnce', () => {
  test('runs template refresh and campaign resume', async () => {
    const { deps, templates, campaigns } = makeDeps();
    const res = await runSweepOnce(deps);
    expect(templates.refreshPending).toHaveBeenCalledTimes(1);
    expect(campaigns.resumeStuckCampaigns).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ skipped: false, templates: { checked: 2 }, campaigns: { resumed: 1 } });
  });

  test('the kill switch skips everything', async () => {
    const { deps, templates, campaigns } = makeDeps({ settings: { killSwitchOn: () => true } });
    expect((await runSweepOnce(deps)).skipped).toBe(true);
    expect(templates.refreshPending).not.toHaveBeenCalled();
    expect(campaigns.resumeStuckCampaigns).not.toHaveBeenCalled();
  });

  test('missing modules are tolerated and logged; the other step still runs', async () => {
    const { deps, campaigns } = makeDeps({ templates: null });
    const res = await runSweepOnce(deps);
    expect(res.templates).toBeNull();
    expect(campaigns.resumeStuckCampaigns).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('templates unavailable:', expect.stringContaining('Cannot find module'));
  });

  test('a module without the expected function is ignored', async () => {
    const { deps } = makeDeps({ templates: {}, campaigns: {} });
    expect(await runSweepOnce(deps)).toEqual({ skipped: false, templates: null, campaigns: null });
  });

  test('a throwing step is caught, logged, and does not stop the next step', async () => {
    const templates = { refreshPending: jest.fn(async () => { throw new Error('meta down'); }) };
    const { deps, campaigns } = makeDeps({ templates });
    const res = await runSweepOnce(deps);
    expect(res.templates).toBeNull();
    expect(campaigns.resumeStuckCampaigns).toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('template refresh failed:', 'meta down');
  });

  test('a module that throws at require time is tolerated', async () => {
    const { deps } = makeDeps({ campaigns: new Error('syntax error') });
    await expect(runSweepOnce(deps)).resolves.toMatchObject({ campaigns: null });
  });
});

describe('tick', () => {
  test('sweeps only when the lock is won', async () => {
    const won = makeDeps();
    await tick(won.deps, 600000);
    expect(won.templates.refreshPending).toHaveBeenCalledTimes(1);
    const lost = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('dup'), { code: 11000 }) }) });
    await tick(lost.deps, 600000);
    expect(lost.templates.refreshPending).not.toHaveBeenCalled();
  });

  test('lock errors are caught, never rejected', async () => {
    const { deps } = makeDeps({ lock: makeLock({ createError: Object.assign(new Error('db gone'), { code: 5 }) }) });
    await expect(tick(deps, 600000)).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith('tick error:', 'db gone');
  });
});

describe('startLocalizationScheduler', () => {
  test('is idempotent, unref()s the timer, and uses the 10 minute default', () => {
    const { deps } = makeDeps();
    const handle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => handle);
    expect(DEFAULT_INTERVAL_MS).toBe(600000);
    expect(startLocalizationScheduler({ deps, setIntervalFn })).toBe(handle);
    expect(startLocalizationScheduler({ deps, setIntervalFn })).toBe(handle);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(600000);
    expect(handle.unref).toHaveBeenCalledTimes(1);
  });

  test('honours an explicit intervalMs and ignores junk values', () => {
    const { deps } = makeDeps();
    const setIntervalFn = jest.fn(() => ({ unref() {} }));
    startLocalizationScheduler({ intervalMs: 120000, deps, setIntervalFn });
    expect(setIntervalFn.mock.calls[0][1]).toBe(120000);
    stopLocalizationScheduler(() => {});
    startLocalizationScheduler({ intervalMs: 5, deps, setIntervalFn });
    expect(setIntervalFn.mock.calls[1][1]).toBe(600000);
  });

  test('the first tick runs immediately and the interval callback ticks again', async () => {
    const { deps, templates } = makeDeps();
    let cb;
    startLocalizationScheduler({ deps, setIntervalFn: (fn) => { cb = fn; return { unref() {} }; } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(templates.refreshPending).toHaveBeenCalledTimes(1);
    cb();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(templates.refreshPending).toHaveBeenCalledTimes(2);
  });

  test('requiring the module starts no timer and loads no models', () => {
    jest.isolateModules(() => {
      const spy = jest.spyOn(global, 'setInterval');
      require('../../shared/localization/scheduler');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
