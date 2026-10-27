// Unit tests for shared/templateApproval.js (pending-template sweep, Meta's template-status webhook, the "approved" notice).
// No database, no network: models, the status re-read and the lock are injected fakes.
const senderContext = require('../utils/senderContext');
const approval = require('../shared/templateApproval');

const WS_A = '64b00000000000000000000a';
const WS_B = '64b00000000000000000000b';
const NOW = Date.UTC(2026, 9, 26, 9, 0, 0);

function q(value) {
  const p = Promise.resolve(value);
  const chain = { sort: () => chain, limit: () => chain, lean: () => chain, select: () => chain, then: (a, b) => p.then(a, b), catch: (f) => p.catch(f) };
  return chain;
}

// statuses: what the (fake) Graph re-read reports per node id.
function world({ nodes = [], statuses = {}, findError } = {}) {
  const w = { seenWorkspace: {}, log: jest.fn() };
  const byId = Object.fromEntries(nodes.map((n) => [String(n._id), { ...n }]));
  w.MessageNode = {
    find: jest.fn(() => { if (findError) throw findError; return q(nodes); }),
    findById: jest.fn((id) => q(byId[String(id)] || null)),
    updateOne: jest.fn(async () => ({})),
  };
  w.Promotion = { updateMany: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })) };
  w.refreshNode = jest.fn(async (node) => {
    w.seenWorkspace[String(node._id)] = senderContext.currentWorkspaceId();
    const s = statuses[String(node._id)];
    if (s instanceof Error) throw s;
    if (s === undefined) return undefined; // the refresh gave nothing back: the sweep re-reads the node
    byId[String(node._id)].templateStatus = s;
    return { ...byId[String(node._id)] };
  });
  w.deps = { MessageNode: w.MessageNode, Promotion: w.Promotion, refreshNode: w.refreshNode, now: () => NOW, log: w.log };
  return w;
}
const node = (id, over = {}) => ({ _id: id, workspaceId: WS_A, templateName: `waflow_flow_${id}`, templateStatus: 'pending', ...over });

describe('markApprovedNotice', () => {
  test('targets only this workspace\'s promotions on this node with an undismissed, not-yet-announced send request', async () => {
    const w = world();
    const res = await approval.markApprovedNotice({ _id: 'n1', workspaceId: WS_A }, w.deps);
    expect(res).toEqual({ matched: 1, modified: 1 });
    const [filter, update] = w.Promotion.updateMany.mock.calls[0];
    expect(filter).toEqual({
      entryNodeId: 'n1', workspaceId: WS_A,
      sendRequest: { $exists: true, $ne: null },
      'sendRequest.dismissedAt': null,
      'sendRequest.approvedNoticeAt': null,
    });
    expect(update).toEqual({ $set: { 'sendRequest.approvedNoticeAt': new Date(NOW) } });
  });

  test('a legacy node without a workspace is not filtered by workspace; nothing / failures are harmless', async () => {
    const w = world();
    await approval.markApprovedNotice({ _id: 'n1' }, w.deps);
    expect(w.Promotion.updateMany.mock.calls[0][0].workspaceId).toBeUndefined();
    expect(await approval.markApprovedNotice(null, w.deps)).toEqual({ matched: 0, modified: 0 });
    expect(await approval.markApprovedNotice({}, w.deps)).toEqual({ matched: 0, modified: 0 });
    w.Promotion.updateMany.mockRejectedValue(new Error('db down'));
    const res = await approval.markApprovedNotice({ _id: 'n1', workspaceId: WS_A }, w.deps);
    expect(res).toMatchObject({ matched: 0, modified: 0, error: 'db down' });
  });
});

describe('sweep: the template state machine', () => {
  test('looks only at pending nodes that have a template name, oldest check first, capped', async () => {
    const w = world();
    await approval.sweep(w.deps);
    expect(w.MessageNode.find).toHaveBeenCalledWith({ templateStatus: 'pending', templateName: { $exists: true, $ne: null } });
  });

  test('pending -> approved: stamps templateApprovedAt and raises the notice, reading the status inside that workspace\'s sender context', async () => {
    const w = world({ nodes: [node('n1'), node('n2', { workspaceId: WS_B })], statuses: { n1: 'approved', n2: 'approved' } });
    const out = await approval.sweep(w.deps);
    expect(out).toEqual({ checked: 2, approved: 2, rejected: 0, failed: 0 });
    expect(w.seenWorkspace).toEqual({ n1: WS_A, n2: WS_B }); // each Graph read ran as its own customer
    expect(w.MessageNode.updateOne).toHaveBeenCalledWith({ _id: 'n1', templateApprovedAt: null }, { $set: { templateApprovedAt: new Date(NOW) } });
    expect(w.Promotion.updateMany).toHaveBeenCalledTimes(2);
    expect(w.Promotion.updateMany.mock.calls.map((c) => [c[0].entryNodeId, String(c[0].workspaceId)])).toEqual([['n1', WS_A], ['n2', WS_B]]);
    expect(senderContext.currentWorkspaceId()).toBeNull(); // the context does not leak out of the sweep
  });

  test('pending -> pending changes nothing; pending -> rejected raises no notice', async () => {
    const w = world({ nodes: [node('n1'), node('n2')], statuses: { n1: 'pending', n2: 'rejected' } });
    const out = await approval.sweep(w.deps);
    expect(out).toEqual({ checked: 2, approved: 0, rejected: 1, failed: 0 });
    expect(w.Promotion.updateMany).not.toHaveBeenCalled();
    expect(w.MessageNode.updateOne).not.toHaveBeenCalled();
  });

  test('when the refresh returns nothing, the status is re-read from the node itself', async () => {
    const w = world({ nodes: [node('n1')], statuses: {} });
    // the refresh stored 'approved' on the node but returned nothing
    w.refreshNode.mockImplementation(async () => { w.MessageNode.findById.mockReturnValue(q({ _id: 'n1', templateStatus: 'approved' })); });
    const out = await approval.sweep(w.deps);
    expect(out.approved).toBe(1);
    expect(w.Promotion.updateMany).toHaveBeenCalledTimes(1);
  });

  test('fail-open: one node failing is logged and the rest still run; a failing query returns zeros; nothing throws', async () => {
    const w = world({ nodes: [node('n1'), node('n2')], statuses: { n1: new Error('Graph 500'), n2: 'approved' } });
    const out = await approval.sweep(w.deps);
    expect(out).toEqual({ checked: 1, approved: 1, rejected: 0, failed: 1 });
    expect(w.log).toHaveBeenCalled();

    const broken = world({ findError: new Error('db down') });
    await expect(approval.sweep(broken.deps)).resolves.toEqual({ checked: 0, approved: 0, rejected: 0, failed: 0 });

    const noteFail = world({ nodes: [node('n1')], statuses: { n1: 'approved' } });
    noteFail.MessageNode.updateOne.mockRejectedValue(new Error('write failed'));
    const out3 = await approval.sweep(noteFail.deps);
    expect(out3.approved).toBe(1); // a failed stamp does not stop the notice
    expect(noteFail.Promotion.updateMany).toHaveBeenCalledTimes(1);
  });

  test('a node without a workspace is read through the platform sender (no workspace in the context)', async () => {
    const w = world({ nodes: [node('n1', { workspaceId: undefined })], statuses: { n1: 'pending' } });
    await approval.sweep(w.deps);
    expect(w.seenWorkspace.n1).toBeNull();
  });

  test('running the sweep twice does not repeat the approval work for an already approved node', async () => {
    const w = world({ nodes: [], statuses: {} });
    expect(await approval.sweep(w.deps)).toEqual({ checked: 0, approved: 0, rejected: 0, failed: 0 });
    expect(w.refreshNode).not.toHaveBeenCalled();
  });
});

describe('handleTemplateStatusEvent (Meta webhook)', () => {
  const event = (name, status = 'APPROVED') => ({ value: { event: status, message_template_id: 1, message_template_name: name, message_template_language: 'en' }, change: { field: 'message_template_status_update' } });

  test('finds the node by template name and RE-READS the status through that workspace\'s sender: the payload is never trusted', async () => {
    const w = world({ nodes: [node('n1', { workspaceId: WS_B, templateName: 'waflow_flow_abc' })], statuses: { n1: 'pending' } });
    const out = await approval.handleTemplateStatusEvent(event('waflow_flow_abc', 'APPROVED'), w.deps); // the payload claims approved...
    expect(out.handled).toBe(true);
    expect(w.MessageNode.find).toHaveBeenCalledWith({ templateName: 'waflow_flow_abc' });
    expect(w.seenWorkspace.n1).toBe(WS_B);
    expect(w.Promotion.updateMany).not.toHaveBeenCalled(); // ...but Graph says pending, so nothing happens
    expect(out.results[0]).toEqual({ nodeId: 'n1', from: 'pending', to: 'pending' });
  });

  test('a genuine approval updates the node and raises the notice', async () => {
    const w = world({ nodes: [node('n1', { templateName: 'waflow_flow_abc' })], statuses: { n1: 'approved' } });
    const out = await approval.handleTemplateStatusEvent(event('waflow_flow_abc'), w.deps);
    expect(out.results[0]).toEqual({ nodeId: 'n1', from: 'pending', to: 'approved' });
    expect(w.MessageNode.updateOne).toHaveBeenCalledTimes(1);
    expect(w.Promotion.updateMany).toHaveBeenCalledTimes(1);
  });

  test('a later rejection or pause of an approved template is re-read too (status moves, no notice)', async () => {
    const w = world({ nodes: [node('n1', { templateStatus: 'approved', templateName: 't' })], statuses: { n1: 'rejected' } });
    const out = await approval.handleTemplateStatusEvent(event('t', 'PAUSED'), w.deps);
    expect(out.results[0]).toEqual({ nodeId: 'n1', from: 'approved', to: 'rejected' });
    expect(w.Promotion.updateMany).not.toHaveBeenCalled();
  });

  test('an already approved node that is re-announced does not raise the notice again', async () => {
    const w = world({ nodes: [node('n1', { templateStatus: 'approved', templateName: 't' })], statuses: { n1: 'approved' } });
    await approval.handleTemplateStatusEvent(event('t'), w.deps);
    expect(w.Promotion.updateMany).not.toHaveBeenCalled();
  });

  test('unknown template (a fixed WaFlow template, another app) and junk payloads are not handled and never throw', async () => {
    const w = world({ nodes: [] });
    expect(await approval.handleTemplateStatusEvent(event('waflow_promo_v2'), w.deps)).toEqual({ handled: false, reason: 'no_node' });
    expect(w.refreshNode).not.toHaveBeenCalled();
    for (const bad of [undefined, {}, { value: null }, { value: {} }, { value: { message_template_name: 5 } }, { value: { message_template_name: '   ' } }]) {
      expect(await approval.handleTemplateStatusEvent(bad, w.deps)).toMatchObject({ handled: false, reason: 'no_template_name' });
    }
  });

  test('a Graph failure is logged and reported per node, and a broken lookup returns a result instead of throwing', async () => {
    const w = world({ nodes: [node('n1', { templateName: 't' })], statuses: { n1: new Error('Graph 190') } });
    const out = await approval.handleTemplateStatusEvent(event('t'), w.deps);
    expect(out.handled).toBe(true);
    expect(out.results[0]).toMatchObject({ nodeId: 'n1', error: 'Graph 190' });
    const broken = world({ findError: new Error('db down') });
    expect(await approval.handleTemplateStatusEvent(event('t'), broken.deps)).toMatchObject({ handled: false, reason: 'error' });
  });

  test('the same template name on several nodes refreshes each through its own workspace', async () => {
    const w = world({ nodes: [node('n1', { templateName: 't', workspaceId: WS_A }), node('n2', { templateName: 't', workspaceId: WS_B })], statuses: { n1: 'approved', n2: 'pending' } });
    await approval.handleTemplateStatusEvent(event('t'), w.deps);
    expect(w.seenWorkspace).toEqual({ n1: WS_A, n2: WS_B });
    expect(w.Promotion.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('the timer and the lock', () => {
  let saved;
  beforeEach(() => { saved = process.env.TEMPLATE_APPROVAL_SWEEP; delete process.env.TEMPLATE_APPROVAL_SWEEP; approval.stopTemplateApprovalSweeper(() => {}); });
  afterEach(() => {
    approval.stopTemplateApprovalSweeper(() => {});
    if (saved === undefined) delete process.env.TEMPLATE_APPROVAL_SWEEP; else process.env.TEMPLATE_APPROVAL_SWEEP = saved;
  });

  function lockWorld({ holder = false } = {}) {
    const lock = { findOneAndUpdate: jest.fn(async () => null), create: jest.fn(async () => ({})) };
    if (holder) lock.create.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000 }));
    return lock;
  }

  test('TEMPLATE_APPROVAL_SWEEP=off starts nothing', () => {
    process.env.TEMPLATE_APPROVAL_SWEEP = 'off';
    const setIntervalFn = jest.fn();
    expect(approval.startTemplateApprovalSweeper({ setIntervalFn, deps: { SchedulerLock: lockWorld() } })).toBeNull();
    expect(setIntervalFn).not.toHaveBeenCalled();
    process.env.TEMPLATE_APPROVAL_SWEEP = ' OFF ';
    expect(approval.startTemplateApprovalSweeper({ setIntervalFn })).toBeNull();
  });

  test('by default it ticks every 5 minutes, the timer is unref()\'d and a second start is a no-op', async () => {
    const w = world();
    const handle = { unref: jest.fn() };
    const setIntervalFn = jest.fn(() => handle);
    const lock = lockWorld();
    const deps = { ...w.deps, SchedulerLock: lock };
    expect(approval.startTemplateApprovalSweeper({ setIntervalFn, deps })).toBe(handle);
    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 5 * 60 * 1000);
    expect(handle.unref).toHaveBeenCalled();
    expect(approval.startTemplateApprovalSweeper({ setIntervalFn, deps })).toBe(handle);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(lock.create).toHaveBeenCalledWith({ _id: 'templateApprovalSweep', lockedAt: new Date(NOW), lockedUntil: new Date(NOW + 5 * 60 * 1000 - 30 * 1000) });
  });

  test('a tick sweeps when it gets the lock and skips the sweep when another instance holds it', async () => {
    const w = world();
    const got = { ...w.deps, SchedulerLock: lockWorld() };
    await approval.tick(got, 300000);
    expect(w.MessageNode.find).toHaveBeenCalledTimes(1);

    const w2 = world();
    const held = { ...w2.deps, SchedulerLock: lockWorld({ holder: true }) };
    expect(await approval.tick(held, 300000)).toBeNull();
    expect(w2.MessageNode.find).not.toHaveBeenCalled();

    const w3 = world();
    const renew = lockWorld(); renew.findOneAndUpdate.mockResolvedValue({ _id: 'templateApprovalSweep' }); // an expired lock we could take over
    await approval.tick({ ...w3.deps, SchedulerLock: renew }, 300000);
    expect(renew.create).not.toHaveBeenCalled();
    expect(w3.MessageNode.find).toHaveBeenCalledTimes(1);
  });

  test('a lock error is logged and swallowed', async () => {
    const w = world();
    const lock = lockWorld(); lock.create.mockRejectedValue(new Error('lock db down'));
    await expect(approval.tick({ ...w.deps, SchedulerLock: lock }, 300000)).resolves.toBeNull();
    expect(w.log).toHaveBeenCalled();
    expect(w.MessageNode.find).not.toHaveBeenCalled();
  });

  test('sweep() itself is the lock-free pass: calling it twice in a row processes both times', async () => {
    const w = world({ nodes: [node('n1')], statuses: { n1: 'pending' } });
    await approval.sweep(w.deps);
    await approval.sweep(w.deps);
    expect(w.refreshNode).toHaveBeenCalledTimes(2);
  });

  test('the interval can be tuned by env, and bad values fall back to 5 minutes', () => {
    const run = (value) => {
      if (value === undefined) delete process.env.TEMPLATE_APPROVAL_SWEEP_INTERVAL_MS; else process.env.TEMPLATE_APPROVAL_SWEEP_INTERVAL_MS = value;
      approval.stopTemplateApprovalSweeper(() => {});
      const setIntervalFn = jest.fn(() => ({ unref() {} }));
      approval.startTemplateApprovalSweeper({ setIntervalFn, deps: { ...world().deps, SchedulerLock: lockWorld() } });
      return setIntervalFn.mock.calls[0][1];
    };
    try {
      expect(run('60000')).toBe(60000);
      expect(run('5')).toBe(approval.DEFAULT_INTERVAL_MS);
      expect(run('abc')).toBe(approval.DEFAULT_INTERVAL_MS);
      expect(run(undefined)).toBe(approval.DEFAULT_INTERVAL_MS);
    } finally { delete process.env.TEMPLATE_APPROVAL_SWEEP_INTERVAL_MS; }
  });
});
