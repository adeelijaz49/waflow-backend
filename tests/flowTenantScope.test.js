// One app, many customers: every flow trigger query and the scheduler are scoped by flow.workspaceId. Models are mocks that
// record the filters they are asked for, so this proves the filter is on the wire without a database
// (the two-workspace behaviour on a real mongod is tests/localization/integration/flowTenants.itest.js).
const mongoose = require('mongoose');

const WS = '1'.repeat(24);
const OTHER = '2'.repeat(24);

// jest only lets a mock factory reference variables named mock*
const mockQuery = (result) => {
  const p = Promise.resolve(result);
  p.distinct = jest.fn().mockResolvedValue(Array.isArray(result) ? result : []);
  p.sort = jest.fn(() => p);
  p.populate = jest.fn(() => p);
  return p;
};

jest.mock('../models/Order', () => ({ aggregate: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Customer', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Booking', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/FlowEnrollment', () => ({ find: jest.fn(), create: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/CampaignMessage', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../models/Flow', () => ({ find: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../models/SchedulerLock', () => ({ findOneAndUpdate: jest.fn(), create: jest.fn() }));
jest.mock('../models/Settings', () => ({ findOne: jest.fn() }));
jest.mock('../models/MessageNode', () => ({ findOne: jest.fn() }));
jest.mock('../models/Promotion', () => ({ findOne: jest.fn() }));
jest.mock('../utils/whatsapp', () => ({
  sendWinbackTemplate: jest.fn(), sendPostPurchaseTemplate: jest.fn(), sendPointsNudgeTemplate: jest.fn(),
  sendNoShowTemplate: jest.fn(), sendCustomFlowTemplate: jest.fn(),
}));
jest.mock('../shared/consent', () => ({
  MARKETING_ELIGIBLE_QUERY: { marketingConsent: true, optedOut: { $ne: true } },
  canSendMarketing: jest.fn(() => true),
}));
jest.mock('../shared/onboarding/sendGate', () => ({ flowBlocked: jest.fn(async () => false) }));
jest.mock('../shared/localization/flowBridge', () => ({ sendLocalizedFlowMessage: jest.fn(async () => null) }));
jest.mock('../utils/settingsCache', () => ({ getSettings: jest.fn(async () => ({ flowCooldownDays: 3 })), getCurrency: jest.fn(), invalidate: jest.fn() }));

const Order = require('../models/Order');
const Customer = require('../models/Customer');
const Booking = require('../models/Booking');
const FlowEnrollment = require('../models/FlowEnrollment');
const CampaignMessage = require('../models/CampaignMessage');
const Flow = require('../models/Flow');
const SchedulerLock = require('../models/SchedulerLock');
const Settings = require('../models/Settings');
const MessageNode = require('../models/MessageNode');
const settingsCache = require('../utils/settingsCache');
const wa = require('../utils/whatsapp');
const senderContext = require('../utils/senderContext');
const triggers = require('../utils/flowTriggers');
const scheduler = require('../utils/flowScheduler');

const oid = (hex) => new mongoose.Types.ObjectId(hex);
const flowOf = (type, extra = {}) => ({ _id: oid('f'.repeat(24)), triggerType: type, workspaceId: oid(WS), ...extra });
const custId = oid('c'.repeat(24));

// the filter every data query must carry / the tolerant one for the engine's own rows
const isScoped = (filter) => filter && String(filter.workspaceId) === WS && filter.workspaceId instanceof mongoose.Types.ObjectId;
const isLedgerScoped = (filter) => filter && filter.workspaceId && Array.isArray(filter.workspaceId.$in)
  && String(filter.workspaceId.$in[0]) === WS && filter.workspaceId.$in[1] === null;

beforeEach(() => {
  jest.clearAllMocks();
  Order.aggregate.mockResolvedValue([]);
  Order.find.mockImplementation(() => mockQuery([]));
  Order.findOne.mockImplementation(() => mockQuery(null));
  Customer.find.mockImplementation(() => mockQuery([]));
  Customer.findOne.mockImplementation(() => mockQuery(null));
  Booking.find.mockImplementation(() => mockQuery([]));
  Booking.findOne.mockImplementation(() => mockQuery(null));
  FlowEnrollment.find.mockImplementation(() => mockQuery([]));
  FlowEnrollment.create.mockResolvedValue({});
  CampaignMessage.findOne.mockResolvedValue(null);
  CampaignMessage.create.mockImplementation(() => Promise.resolve({}));
  MessageNode.findOne.mockResolvedValue(null);
  Flow.findByIdAndUpdate.mockResolvedValue({});
  SchedulerLock.findOneAndUpdate.mockResolvedValue({ locked: true });
  settingsCache.getSettings.mockResolvedValue({ flowCooldownDays: 3 });
  require('../shared/consent').canSendMarketing.mockReturnValue(true);
  require('../shared/onboarding/sendGate').flowBlocked.mockResolvedValue(false);
  require('../shared/localization/flowBridge').sendLocalizedFlowMessage.mockResolvedValue(null);
});

// ── findEligible ─────────────────────────────────────────────────────────────
describe('findEligible: every query carries the flow\'s workspace', () => {
  test('inactive_customer: the order aggregation, the enrollment dedup and the customer lookup', async () => {
    Order.aggregate.mockResolvedValue([{ _id: custId, lastOrderAt: new Date(0) }]);
    Customer.find.mockImplementation(() => mockQuery([{ _id: custId }]));
    const out = await triggers.inactive_customer.findEligible(flowOf('inactive_customer', { inactivityDays: 60 }));
    expect(out).toEqual([{ customerId: custId }]);
    const match = Order.aggregate.mock.calls[0][0][0].$match;
    expect(isScoped(match)).toBe(true);
    expect(match.status).toEqual({ $ne: 'cancelled' }); // the old condition is kept
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
    expect(isScoped(Customer.find.mock.calls[0][0])).toBe(true);
    expect(Customer.find.mock.calls[0][0].isDemo).toEqual({ $ne: true });
  });

  test('purchase_frequency: the order aggregation, the enrollment dedup and the customer lookup', async () => {
    Order.aggregate.mockResolvedValue([{ _id: custId, orderCount: 5 }]);
    Customer.find.mockImplementation(() => mockQuery([{ _id: custId }]));
    await triggers.purchase_frequency.findEligible(flowOf('purchase_frequency', { inactivityDays: 30, orderCountThreshold: 2 }));
    expect(isScoped(Order.aggregate.mock.calls[0][0][0].$match)).toBe(true);
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
    expect(isScoped(Customer.find.mock.calls[0][0])).toBe(true);
  });

  test('post_purchase_points: the paid-order lookup and the per-order dedup', async () => {
    const orderId = oid('d'.repeat(24));
    Order.find.mockImplementation(() => mockQuery([{ _id: orderId, customer: custId }]));
    const out = await triggers.post_purchase_points.findEligible(flowOf('post_purchase_points'));
    expect(out).toEqual([{ customerId: custId, sourceModel: 'Order', sourceRef: orderId }]);
    expect(isScoped(Order.find.mock.calls[0][0])).toBe(true);
    expect(Order.find.mock.calls[0][0].paymentStatus).toBe('paid');
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
  });

  test('booking_no_show: the booking lookup and the per-booking dedup', async () => {
    const bookingId = oid('e'.repeat(24));
    Booking.find.mockImplementation(() => mockQuery([{ _id: bookingId, customerId: custId }]));
    const out = await triggers.booking_no_show.findEligible(flowOf('booking_no_show'));
    expect(out).toEqual([{ customerId: custId, sourceModel: 'Booking', sourceRef: bookingId }]);
    expect(isScoped(Booking.find.mock.calls[0][0])).toBe(true);
    expect(Booking.find.mock.calls[0][0].status).toBe('no-show');
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
  });

  test('points_balance_reminder: the customer scan and the enrollment dedup', async () => {
    Customer.find.mockImplementation(() => mockQuery([{ _id: custId }]));
    await triggers.points_balance_reminder.findEligible(flowOf('points_balance_reminder', { inactivityDays: 30 }));
    expect(isScoped(Customer.find.mock.calls[0][0])).toBe(true);
    expect(Customer.find.mock.calls[0][0].loyaltyPoints).toEqual({ $gt: 0 });
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
  });

  test('points_threshold: the customer scan and the ever-enrolled check', async () => {
    Customer.find.mockImplementation(() => mockQuery([{ _id: custId }]));
    await triggers.points_threshold.findEligible(flowOf('points_threshold', { pointsThreshold: 1000 }));
    expect(isScoped(Customer.find.mock.calls[0][0])).toBe(true);
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
  });

  test('a workspace id given as a string is cast to an ObjectId (aggregate does not cast on its own)', async () => {
    Order.aggregate.mockResolvedValue([]);
    await triggers.inactive_customer.findEligible(flowOf('inactive_customer', { workspaceId: WS }));
    expect(Order.aggregate.mock.calls[0][0][0].$match.workspaceId).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  test('two workspaces produce two different filters (no shared state between calls)', async () => {
    Order.aggregate.mockResolvedValue([]);
    await triggers.inactive_customer.findEligible(flowOf('inactive_customer', { workspaceId: oid(WS) }));
    await triggers.inactive_customer.findEligible(flowOf('inactive_customer', { workspaceId: oid(OTHER) }));
    expect(String(Order.aggregate.mock.calls[0][0][0].$match.workspaceId)).toBe(WS);
    expect(String(Order.aggregate.mock.calls[1][0][0].$match.workspaceId)).toBe(OTHER);
  });

  test.each(Object.keys(triggers))('%s: a malformed workspaceId fails closed (throws) instead of running unscoped', async (type) => {
    await expect(triggers[type].findEligible(flowOf(type, { workspaceId: 'garbage' }))).rejects.toThrow(/invalid workspaceId/);
    expect(Order.aggregate).not.toHaveBeenCalled();
    expect(Customer.find).not.toHaveBeenCalled();
    expect(Booking.find).not.toHaveBeenCalled();
  });

  test('a hand-built flow with no workspaceId keeps the old unscoped queries (runSweep never lets one run)', async () => {
    Order.aggregate.mockResolvedValue([{ _id: custId, lastOrderAt: new Date(0) }]);
    Customer.find.mockImplementation(() => mockQuery([{ _id: custId }]));
    await triggers.inactive_customer.findEligible(flowOf('inactive_customer', { workspaceId: undefined }));
    expect(Order.aggregate.mock.calls[0][0][0].$match).toEqual({ status: { $ne: 'cancelled' } });
    expect('workspaceId' in FlowEnrollment.find.mock.calls[0][0]).toBe(false);
    expect('workspaceId' in Customer.find.mock.calls[0][0]).toBe(false);
  });
});

// ── revalidate ───────────────────────────────────────────────────────────────
describe('revalidate: lookups by id are scoped too (an enrollment of another workspace is closed out, never messaged)', () => {
  const enrollment = { customer: custId, sourceRef: oid('d'.repeat(24)) };

  test.each(Object.keys(triggers))('%s: a customer that is not in the flow\'s workspace -> exit customer_deleted', async (type) => {
    Customer.findOne.mockImplementation(() => mockQuery(null)); // the scoped query finds nothing
    const verdict = await triggers[type].revalidate(flowOf(type), enrollment);
    expect(verdict).toEqual({ outcome: 'exit', reason: 'customer_deleted' });
    expect(isScoped(Customer.findOne.mock.calls[0][0])).toBe(true);
    expect(String(Customer.findOne.mock.calls[0][0]._id)).toBe(String(custId));
  });

  test('post_purchase_points: the order and its customer are both read inside the workspace', async () => {
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, marketingConsent: true }));
    Order.findOne.mockImplementation(() => mockQuery(null));
    expect(await triggers.post_purchase_points.revalidate(flowOf('post_purchase_points'), enrollment)).toEqual({ outcome: 'exit', reason: 'order_deleted' });
    expect(isScoped(Order.findOne.mock.calls[0][0])).toBe(true);
  });

  test('booking_no_show: the booking is read inside the workspace', async () => {
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, marketingConsent: true }));
    Booking.findOne.mockImplementation(() => mockQuery(null));
    expect(await triggers.booking_no_show.revalidate(flowOf('booking_no_show'), enrollment)).toEqual({ outcome: 'exit', reason: 'booking_deleted' });
    expect(isScoped(Booking.findOne.mock.calls[0][0])).toBe(true);
  });

  test('inactive_customer: the "most recent order" check is read inside the workspace', async () => {
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, marketingConsent: true }));
    Order.findOne.mockImplementation(() => mockQuery(null));
    expect(await triggers.inactive_customer.revalidate(flowOf('inactive_customer'), enrollment)).toEqual({ outcome: 'exit', reason: 'no_order_history' });
    expect(isScoped(Order.findOne.mock.calls[0][0])).toBe(true);
  });
});

// ── the engine ───────────────────────────────────────────────────────────────
describe('scheduler: stamping and scoping', () => {
  const stubTrigger = (candidates = []) => {
    const t = triggers.inactive_customer;
    jest.spyOn(t, 'findEligible').mockResolvedValue(candidates);
    jest.spyOn(t, 'revalidate').mockResolvedValue({ outcome: 'proceed' });
    jest.spyOn(t, 'buildSend').mockImplementation(async () => ({ messages: [{ id: 'wamid.X' }], ctx: senderContext.currentWorkspaceId() }));
    return t;
  };
  afterEach(() => { jest.restoreAllMocks(); });

  test('enrollEligibleCustomers stamps the flow\'s workspaceId on every FlowEnrollment it creates', async () => {
    stubTrigger([{ customerId: custId }, { customerId: oid('9'.repeat(24)) }]);
    await scheduler.enrollEligibleCustomers(flowOf('inactive_customer'));
    expect(FlowEnrollment.create).toHaveBeenCalledTimes(2);
    for (const [row] of FlowEnrollment.create.mock.calls) expect(String(row.workspaceId)).toBe(WS);
  });

  test('a hand-built flow with no workspaceId creates the enrollment exactly as before (no workspaceId key)', async () => {
    stubTrigger([{ customerId: custId }]);
    await scheduler.enrollEligibleCustomers(flowOf('inactive_customer', { workspaceId: undefined }));
    expect('workspaceId' in FlowEnrollment.create.mock.calls[0][0]).toBe(false);
  });

  test('the requiresPriorFlow check looks only at this workspace\'s (or legacy unstamped) enrollments', async () => {
    stubTrigger([{ customerId: custId }]);
    FlowEnrollment.find.mockImplementation(() => mockQuery([custId]));
    await scheduler.enrollEligibleCustomers(flowOf('inactive_customer', { requiresPriorFlowId: oid('a1'.repeat(12)) }));
    expect(isLedgerScoped(FlowEnrollment.find.mock.calls[0][0])).toBe(true);
    expect(FlowEnrollment.create).toHaveBeenCalledTimes(1);
  });

  test('sendPendingEnrollments only reads this workspace\'s (or legacy unstamped) pending enrollments', async () => {
    await scheduler.sendPendingEnrollments(flowOf('inactive_customer'));
    const filter = FlowEnrollment.find.mock.calls[0][0];
    expect(filter.state).toBe('enrolled');
    expect(isLedgerScoped(filter)).toBe(true);
  });

  test('processEnrollment: cooldown read from the flow\'s own workspace, cooldown query scoped, customer scoped, CampaignMessage stamped, runs in the workspace context', async () => {
    const t = stubTrigger();
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, phone: '15550001', firstname: 'Sara', marketingConsent: true }));
    FlowEnrollment.findOneAndUpdate.mockResolvedValue({ _id: oid('b'.repeat(24)), state: 'messaged' });
    const enrollment = { _id: oid('b'.repeat(24)), customer: custId };
    await scheduler.processEnrollment(flowOf('inactive_customer'), enrollment);

    expect(settingsCache.getSettings).toHaveBeenCalledTimes(1);
    expect(String(settingsCache.getSettings.mock.calls[0][0])).toBe(WS);
    expect(Settings.findOne).not.toHaveBeenCalled(); // never the unscoped first-document read for a flow with a workspace
    expect(isLedgerScoped(CampaignMessage.findOne.mock.calls[0][0])).toBe(true);
    expect(CampaignMessage.findOne.mock.calls[0][0].kind).toBe('flow');
    expect(isScoped(Customer.findOne.mock.calls[0][0])).toBe(true);

    expect(CampaignMessage.create).toHaveBeenCalledTimes(1);
    const row = CampaignMessage.create.mock.calls[0][0];
    expect(String(row.workspaceId)).toBe(WS);
    expect(row).toMatchObject({ kind: 'flow', wamid: 'wamid.X', status: 'sent' });
    // the send ran inside senderContext.run(<flow's workspace>)
    const result = await t.buildSend.mock.results[0].value;
    expect(result.ctx).toBe(WS);
  });

  test('processEnrollment: the flow\'s promotion / entry node are looked up inside the workspace', async () => {
    stubTrigger();
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, phone: '15550001', marketingConsent: true }));
    FlowEnrollment.findOneAndUpdate.mockResolvedValue({ _id: oid('b'.repeat(24)), state: 'messaged' });
    await scheduler.processEnrollment(flowOf('inactive_customer', { entryNodeId: oid('9'.repeat(24)) }), { _id: oid('b'.repeat(24)), customer: custId });
    expect(isLedgerScoped(MessageNode.findOne.mock.calls[0][0])).toBe(true);
  });

  test('processEnrollment: a customer that is not in the flow\'s workspace is exited, nothing is sent, no row is written', async () => {
    const t = stubTrigger();
    Customer.findOne.mockImplementation(() => mockQuery(null));
    FlowEnrollment.findOneAndUpdate.mockResolvedValue({});
    await scheduler.processEnrollment(flowOf('inactive_customer'), { _id: oid('b'.repeat(24)), customer: custId });
    expect(t.buildSend).not.toHaveBeenCalled();
    expect(CampaignMessage.create).not.toHaveBeenCalled();
    expect(FlowEnrollment.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ state: 'enrolled' }), expect.objectContaining({ state: 'exited' }));
  });

  test('processEnrollment for a hand-built flow with no workspaceId keeps the old unscoped reads and writes (no context, first Settings document)', async () => {
    const t = stubTrigger();
    Settings.findOne.mockResolvedValue({ flowCooldownDays: 3 });
    Customer.findOne.mockImplementation(() => mockQuery({ _id: custId, phone: '15550001', marketingConsent: true }));
    FlowEnrollment.findOneAndUpdate.mockResolvedValue({ _id: oid('b'.repeat(24)), state: 'messaged' });
    await scheduler.processEnrollment(flowOf('inactive_customer', { workspaceId: undefined }), { _id: oid('b'.repeat(24)), customer: custId });
    expect(Settings.findOne).toHaveBeenCalledTimes(1);
    expect(settingsCache.getSettings).not.toHaveBeenCalled();
    expect('workspaceId' in CampaignMessage.create.mock.calls[0][0]).toBe(false);
    expect('workspaceId' in CampaignMessage.findOne.mock.calls[0][0]).toBe(false);
    expect((await t.buildSend.mock.results[0].value).ctx).toBeNull();
  });
});

describe('runSweep', () => {
  let warn;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('a flow with no workspaceId is skipped with a one-line log; flows of different workspaces each run in their own context', async () => {
    const seen = [];
    jest.spyOn(triggers.inactive_customer, 'findEligible').mockImplementation(async (flow) => {
      seen.push({ flow: String(flow._id), ctx: senderContext.currentWorkspaceId() });
      return [];
    });
    const noWs = flowOf('inactive_customer', { _id: oid('a'.repeat(24)), workspaceId: undefined });
    const badWs = flowOf('inactive_customer', { _id: oid('b'.repeat(24)), workspaceId: 'not-an-id' });
    const inA = flowOf('inactive_customer', { _id: oid('c'.repeat(24)), workspaceId: oid(WS) });
    const inB = flowOf('inactive_customer', { _id: oid('d'.repeat(24)), workspaceId: oid(OTHER) });
    Flow.find.mockResolvedValue([noWs, badWs, inA, inB]);

    await scheduler.runSweep();

    expect(seen).toEqual([
      { flow: String(inA._id), ctx: WS },
      { flow: String(inB._id), ctx: OTHER },
    ]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain(String(noWs._id));
    expect(warn.mock.calls[0][0]).toMatch(/no workspaceId/);
    expect(warn.mock.calls[0][0]).not.toContain('\n');
    // only the swept flows got their lastRunAt
    expect(Flow.findByIdAndUpdate.mock.calls.map((c) => String(c[0]))).toEqual([String(inA._id), String(inB._id)]);
  });

  test('the onboarding send gate (sendGate.flowBlocked) is still consulted for every flow that is swept, and a blocked flow is skipped', async () => {
    const sendGate = require('../shared/onboarding/sendGate');
    const seen = [];
    jest.spyOn(triggers.inactive_customer, 'findEligible').mockImplementation(async (flow) => { seen.push(String(flow._id)); return []; });
    const inA = flowOf('inactive_customer', { _id: oid('c'.repeat(24)), workspaceId: oid(WS) });
    const inB = flowOf('inactive_customer', { _id: oid('d'.repeat(24)), workspaceId: oid(OTHER) });
    Flow.find.mockResolvedValue([inA, inB]);
    sendGate.flowBlocked.mockImplementation(async (flow) => String(flow.workspaceId) === OTHER);
    await scheduler.runSweep();
    expect(sendGate.flowBlocked).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([String(inA._id)]);
  });

  test('one flow that throws does not stop the next workspace\'s flow', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const seen = [];
    jest.spyOn(triggers.inactive_customer, 'findEligible').mockImplementation(async (flow) => {
      seen.push(String(flow._id));
      if (String(flow.workspaceId) === WS) throw new Error('boom');
      return [];
    });
    Flow.find.mockResolvedValue([
      flowOf('inactive_customer', { _id: oid('c'.repeat(24)), workspaceId: oid(WS) }),
      flowOf('inactive_customer', { _id: oid('d'.repeat(24)), workspaceId: oid(OTHER) }),
    ]);
    await scheduler.runSweep();
    expect(seen).toHaveLength(2);
    expect(err).toHaveBeenCalled();
  });

  test('the scheduler lock still gates the sweep', async () => {
    SchedulerLock.findOneAndUpdate.mockResolvedValue(null);
    SchedulerLock.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await scheduler.runSweep();
    expect(Flow.find).not.toHaveBeenCalled();
  });
});

describe('the engine source keeps the onboarding hook line', () => {
  test('flowBlocked is called inside runSweep before the sweep, unchanged', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'utils', 'flowScheduler.js'), 'utf8');
    const hook = "try { if (await require('../shared/onboarding/sendGate').flowBlocked(flow)) continue; } catch (_) { /* fail open: sweep as before */ }";
    expect(src).toContain(hook);
    expect(src.indexOf(hook)).toBeLessThan(src.indexOf('sweepFlow(flow)', src.indexOf(hook)));
  });
});
