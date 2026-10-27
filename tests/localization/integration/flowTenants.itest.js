const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// One app, many customers: the automated-flow engine on a REAL mongod (the throwaway one), no network. Two (three) workspaces
// each with their own customers, orders, bookings and flows, driven through the REAL utils/flowScheduler.js and the six REAL
// triggers. Every outbound WhatsApp call goes into an axios adapter stub that records the call AND the workspace context it
// was made in (utils/senderContext.js); nothing leaves the machine and nothing is ever deleted.
//   * a flow of workspace A never enrols or messages a customer of workspace B, and vice versa (all six trigger types), also
//     when both workspaces hold the SAME phone number;
//   * FlowEnrollment and CampaignMessage rows are stamped with the flow's workspaceId;
//   * a flow with no workspaceId is skipped by runSweep (one log line) and never touches anybody;
//   * each flow runs in its own workspace context: currency in the template parameters and the cooldown setting are that
//     workspace's own, also when processEnrollment is called directly;
//   * rows the old engine wrote WITHOUT a workspaceId still count (no second enrolment, cooldown still honoured) and an old
//     enrollment that points at another workspace's customer is closed out instead of messaged.
const fx = require('./_fixtures');
process.env.LOCALIZATION_SEND_MODE = ''; // real (stubbed) http, not dry-run
const axios = require('axios');
const mongoose = require('mongoose');

const calls = [];
let wamidSeq = 0;
const senderContext = require('../../../utils/senderContext');
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body, ctx: senderContext.currentWorkspaceId() };
  calls.push(rec);
  const isMessage = /\/messages$/.test(rec.url) && rec.method === 'POST';
  let data;
  if (isMessage) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.FT${++wamidSeq}_${Date.now()}` }] };
  else if (rec.method === 'GET') data = { data: [] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};
const messages = () => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST' && c.body && c.body.type === 'template');
const buttonPayload = (m) => {
  const b = (m.body.template.components || []).find((c) => c.type === 'button');
  return b ? b.parameters[0].payload : null;
};
const bodyParams = (m) => ((m.body.template.components || []).find((c) => c.type === 'body') || { parameters: [] }).parameters.map((p) => p.text);

const scheduler = require('../../../utils/flowScheduler');
const settingsCache = require('../../../utils/settingsCache');
const { money } = require('../../../utils/currency');
const triggers = require('../../../utils/flowTriggers');
const Flow = require('../../../models/Flow');
const FlowEnrollment = require('../../../models/FlowEnrollment');
const CampaignMessage = require('../../../models/CampaignMessage');
const Customer = require('../../../models/Customer');
const Order = require('../../../models/Order');
const Booking = require('../../../models/Booking');
const Service = require('../../../models/Service');
const Product = require('../../../models/Product');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const Settings = require('../../../models/Settings');
const Workspace = require('../../../models/Workspace');
const SchedulerLock = require('../../../models/SchedulerLock');

jest.setTimeout(120000);

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const oid = () => new mongoose.Types.ObjectId();
const ids = (docs) => docs.map((d) => String(d)).sort();

beforeAll(async () => {
  await fx.connect();
  for (const model of [FlowEnrollment, CampaignMessage, Flow, Order, Booking, Customer]) {
    try { await model.init(); } catch (e) { /* index build is best effort here */ }
  }
});
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { calls.length = 0; });
// Every flow created by a test is retired afterwards (an update, never a delete) so the next runSweep only sees its own flows.
afterEach(async () => { await Flow.updateMany({ status: 'active' }, { $set: { status: 'paused' } }); });

const releaseLock = () => SchedulerLock.updateOne({ _id: 'flowScheduler' }, { $set: { lockedUntil: new Date(0) } }).catch(() => {});

// A workspace with its own Settings (currency, cooldown). fx.makeWorkspace already creates the Settings document.
async function tenant(label, { currency = 'AUD', flowCooldownDays } = {}) {
  const w = await fx.makeWorkspace({ arabic: false, merchantName: `Shop ${label}` });
  await Settings.updateOne({ workspaceId: w.workspaceId }, { $set: { currency, ...(flowCooldownDays != null ? { flowCooldownDays } : {}) } });
  settingsCache.invalidate(w.workspaceId);
  return w.workspaceId;
}

const makeFlow = (workspaceId, triggerType, extra = {}) => Flow.create({ workspaceId, name: `${triggerType} ${fx.uniq()}`, triggerType, status: 'active', cooldownDaysOverride: 0, ...extra });
const backdate = (model, id, field, ms) => model.collection.updateOne({ _id: id }, { $set: { [field]: new Date(Date.now() - ms) } }); // update only: never a delete

async function staleCustomer(workspaceId, extra = {}) {
  const customer = await fx.makeCustomer(workspaceId, { firstname: 'Stale', ...extra });
  const order = await Order.create({ workspaceId, customer: customer._id, total: 10, status: 'delivered' });
  await backdate(Order, order._id, 'createdAt', 90 * DAY);
  return customer;
}

// One qualifying customer per trigger type in a workspace -> [customer, flowExtra]
const QUALIFIERS = {
  inactive_customer: { flow: { inactivityDays: 60 }, make: (ws) => staleCustomer(ws) },
  post_purchase_points: {
    flow: { delayHours: 2 },
    make: async (ws) => {
      const c = await fx.makeCustomer(ws, { firstname: 'Buyer' });
      await Order.create({ workspaceId: ws, customer: c._id, total: 30, status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(Date.now() - 3 * HOUR) });
      return c;
    },
  },
  points_balance_reminder: {
    flow: { inactivityDays: 30 },
    make: (ws) => fx.makeCustomer(ws, { firstname: 'Points', loyaltyPoints: 50, loyaltyPointsUpdatedAt: new Date(Date.now() - 40 * DAY) }),
  },
  booking_no_show: {
    flow: { delayHours: 1 },
    make: async (ws) => {
      const c = await fx.makeCustomer(ws, { firstname: 'Booker' });
      const service = await Service.create({ workspaceId: ws, name: 'Massage', basePrice: 50 });
      const booking = await Booking.create({ workspaceId: ws, serviceId: service._id, slotId: oid(), customerId: c._id, phone: c.phone, status: 'no-show' });
      await backdate(Booking, booking._id, 'updatedAt', 3 * HOUR);
      return c;
    },
  },
  points_threshold: {
    flow: { pointsThreshold: 1000 },
    make: (ws) => fx.makeCustomer(ws, { firstname: 'Rich', loyaltyPoints: 5000 }),
  },
  purchase_frequency: {
    flow: { inactivityDays: 30, orderCountThreshold: 2 },
    make: async (ws) => {
      const c = await fx.makeCustomer(ws, { firstname: 'Regular' });
      for (let i = 0; i < 3; i += 1) await Order.create({ workspaceId: ws, customer: c._id, total: 5, status: 'confirmed' });
      return c;
    },
  },
};
const enrolledCustomers = async (flow) => ids((await FlowEnrollment.find({ flow: flow._id }).lean()).map((e) => e.customer));

// ── 1. the real scheduler tick, two workspaces, one number ───────────────────
describe('runSweep with two workspaces (inactive_customer, default template)', () => {
  test('each flow enrols and messages only its own workspace; rows are stamped; contexts are per workspace; a flow with no workspaceId is skipped', async () => {
    const A = await tenant('A', { currency: 'SAR' });
    const B = await tenant('B', { currency: 'USD' });
    const a1 = await staleCustomer(A);
    const a2 = await staleCustomer(A);
    const sharedPhone = fx.nextPhone();
    const sA = await staleCustomer(A, { phone: sharedPhone }); // the SAME phone is a customer of both workspaces
    const b1 = await staleCustomer(B);
    const b2 = await staleCustomer(B);
    const sB = await staleCustomer(B, { phone: sharedPhone });
    const flowA = await makeFlow(A, 'inactive_customer', { inactivityDays: 60 });
    const flowB = await makeFlow(B, 'inactive_customer', { inactivityDays: 60 });

    // A flow with NO workspaceId and an orphan customer: the old engine would sweep every workspace's customers with it.
    const orphan = await staleCustomer(undefined);
    const flowOrphan = await makeFlow(undefined, 'inactive_customer', { inactivityDays: 60 });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await releaseLock();
    await scheduler.runSweep();
    const warnings = warn.mock.calls.map((c) => String(c[0]));

    // enrolment: exactly the flow's own workspace
    expect(await enrolledCustomers(flowA)).toEqual(ids([a1._id, a2._id, sA._id]));
    expect(await enrolledCustomers(flowB)).toEqual(ids([b1._id, b2._id, sB._id]));
    for (const e of await FlowEnrollment.find({ flow: flowA._id }).lean()) { expect(String(e.workspaceId)).toBe(String(A)); expect(e.state).toBe('messaged'); }
    for (const e of await FlowEnrollment.find({ flow: flowB._id }).lean()) { expect(String(e.workspaceId)).toBe(String(B)); expect(e.state).toBe('messaged'); }

    // the no-workspace flow: skipped with one log line, never ran, nobody enrolled
    expect(await FlowEnrollment.countDocuments({ flow: flowOrphan._id })).toBe(0);
    expect((await Flow.findById(flowOrphan._id).lean()).lastRunAt).toBeUndefined();
    expect(await CampaignMessage.countDocuments({ customer: orphan._id })).toBe(0);
    const skipLines = warnings.filter((w) => w.includes(String(flowOrphan._id)));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toMatch(/no workspaceId/);
    expect(skipLines[0]).not.toContain('\n');
    expect((await Flow.findById(flowA._id).lean()).lastRunAt).toBeInstanceOf(Date);
    expect((await Flow.findById(flowB._id).lean()).lastRunAt).toBeInstanceOf(Date);

    // campaign messages: stamped, one per customer, linked to the right flow
    const rowsA = await CampaignMessage.find({ flow: flowA._id }).lean();
    const rowsB = await CampaignMessage.find({ flow: flowB._id }).lean();
    expect(ids(rowsA.map((r) => r.customer))).toEqual(ids([a1._id, a2._id, sA._id]));
    expect(ids(rowsB.map((r) => r.customer))).toEqual(ids([b1._id, b2._id, sB._id]));
    for (const r of rowsA) { expect(String(r.workspaceId)).toBe(String(A)); expect(r).toMatchObject({ kind: 'flow', status: 'sent', messageType: 'template' }); }
    for (const r of rowsB) { expect(String(r.workspaceId)).toBe(String(B)); expect(r).toMatchObject({ kind: 'flow', status: 'sent', messageType: 'template' }); }

    // what actually went out: every customer got exactly one message, from THEIR flow, in THEIR workspace's context
    const sent = messages();
    const mine = [a1, a2, sA, b1, b2, sB].map((c) => c.phone);
    expect(sent.filter((m) => mine.includes(m.body.to))).toHaveLength(6); // the shared phone is two customers: two messages
    expect(sent.filter((m) => m.body.to === orphan.phone)).toHaveLength(0);
    const flowOfMessage = (m) => buttonPayload(m).split('_')[1]; // flowbrowse_<flowId>_<enrollmentId>
    for (const c of [a1, a2, sA]) {
      const forThem = sent.filter((m) => m.body.to === c.phone && flowOfMessage(m) === String(flowA._id));
      expect(forThem).toHaveLength(1);
      expect(forThem[0].ctx).toBe(String(A));
    }
    for (const c of [b1, b2, sB]) {
      const forThem = sent.filter((m) => m.body.to === c.phone && flowOfMessage(m) === String(flowB._id));
      expect(forThem).toHaveLength(1);
      expect(forThem[0].ctx).toBe(String(B));
    }
    expect(sent.filter((m) => m.body.to === sharedPhone)).toHaveLength(2);
    expect(sent.filter((m) => m.body.to === a1.phone && flowOfMessage(m) === String(flowB._id))).toHaveLength(0);
    expect(sent.filter((m) => m.body.to === b1.phone && flowOfMessage(m) === String(flowA._id))).toHaveLength(0);

    // a second tick sends nothing new
    calls.length = 0;
    await releaseLock();
    await scheduler.runSweep();
    expect(messages()).toHaveLength(0);
    expect(await FlowEnrollment.countDocuments({ flow: flowA._id })).toBe(3);
    expect(await FlowEnrollment.countDocuments({ flow: flowB._id })).toBe(3);
    warn.mockRestore();
  });
});

// ── 2. every trigger type, both directions ───────────────────────────────────
describe('every trigger type: findEligible / enrollment never cross workspaces', () => {
  let A; let B; let C;
  beforeAll(async () => { A = await tenant('A2'); B = await tenant('B2'); C = await tenant('C2'); });

  for (const type of Object.keys(QUALIFIERS)) {
    test(`${type}: A's flow enrols only A's customers, B's only B's, and a workspace with no data enrols nobody`, async () => {
      const q = QUALIFIERS[type];
      const [ca1, ca2] = [await q.make(A), await q.make(A)];
      const [cb1, cb2] = [await q.make(B), await q.make(B)];
      const flowA = await makeFlow(A, type, { ...q.flow, status: 'paused' });
      const flowB = await makeFlow(B, type, { ...q.flow, status: 'paused' });
      const flowC = await makeFlow(C, type, { ...q.flow, status: 'paused' });

      // the raw trigger answer is already scoped
      const eligibleA = await triggers[type].findEligible(flowA);
      const eligibleC = await triggers[type].findEligible(flowC);
      expect(ids(eligibleA.map((e) => e.customerId))).toEqual(ids([ca1._id, ca2._id]));
      expect(eligibleC).toEqual([]);

      await scheduler.enrollEligibleCustomers(flowA);
      await scheduler.enrollEligibleCustomers(flowB);
      await scheduler.enrollEligibleCustomers(flowC);
      expect(await enrolledCustomers(flowA)).toEqual(ids([ca1._id, ca2._id]));
      expect(await enrolledCustomers(flowB)).toEqual(ids([cb1._id, cb2._id]));
      expect(await enrolledCustomers(flowC)).toEqual([]);
      for (const e of await FlowEnrollment.find({ flow: { $in: [flowA._id, flowB._id] } }).lean()) {
        expect(String(e.workspaceId)).toBe(String(e.flow) === String(flowA._id) ? String(A) : String(B));
      }
      // event-sourced triggers point at the right workspace's order / booking
      if (type === 'post_purchase_points' || type === 'booking_no_show') {
        const Model = type === 'post_purchase_points' ? Order : Booking;
        for (const e of await FlowEnrollment.find({ flow: flowA._id }).lean()) {
          expect(String((await Model.findById(e.sourceRef).lean()).workspaceId)).toBe(String(A));
        }
      }

      // a second pass enrols nobody twice
      const before = await FlowEnrollment.countDocuments({ flow: { $in: [flowA._id, flowB._id, flowC._id] } });
      await scheduler.enrollEligibleCustomers(flowA);
      await scheduler.enrollEligibleCustomers(flowB);
      expect(await FlowEnrollment.countDocuments({ flow: { $in: [flowA._id, flowB._id, flowC._id] } })).toBe(before);
    });
  }

  test('sending phase for every type: each enrolled customer is messaged once, in their own workspace context, with a stamped row', async () => {
    const AA = await tenant('A3');
    const BB = await tenant('B3');
    const flows = [];
    for (const [type, q] of Object.entries(QUALIFIERS)) {
      if (type === 'points_threshold' || type === 'purchase_frequency') continue; // no fixed default template: they send only through a promotion / entry node (covered below)
      const ca = await q.make(AA);
      const cb = await q.make(BB);
      const fa = await makeFlow(AA, type, { ...q.flow });
      const fb = await makeFlow(BB, type, { ...q.flow });
      flows.push({ type, ca, cb, fa, fb });
    }
    calls.length = 0;
    for (const f of flows) { await scheduler.sweepFlow(f.fa); await scheduler.sweepFlow(f.fb); }
    for (const f of flows) {
      const rowsA = await CampaignMessage.find({ flow: f.fa._id }).lean();
      const rowsB = await CampaignMessage.find({ flow: f.fb._id }).lean();
      expect(rowsA.map((r) => String(r.customer))).toEqual([String(f.ca._id)]);
      expect(rowsB.map((r) => String(r.customer))).toEqual([String(f.cb._id)]);
      expect(String(rowsA[0].workspaceId)).toBe(String(AA));
      expect(String(rowsB[0].workspaceId)).toBe(String(BB));
      expect(rowsA[0].status).toBe('sent');
      expect(rowsB[0].status).toBe('sent');
      const toA = messages().filter((m) => m.body.to === f.ca.phone);
      const toB = messages().filter((m) => m.body.to === f.cb.phone);
      expect(toA).toHaveLength(1);
      expect(toB).toHaveLength(1);
      expect(toA[0].ctx).toBe(String(AA));
      expect(toB[0].ctx).toBe(String(BB));
    }
  });
});

// ── 2b. a flow never sends an "Ask customers to opt in" promotion ────────────
describe('a flow and a consent request', () => {
  async function consentRequest(workspaceId) {
    const promotion = await Promotion.create({ workspaceId, name: 'Opt in', customerType: 'cash', scope: 'products', purpose: 'consent_request', campaignType: 'consent_request' });
    const entry = await MessageNode.create({
      workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}, offers on WhatsApp? Stop any time.',
      templateName: `wf_${fx.uniq()}`, templateStatus: 'approved',
      buttons: [{ position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in' } }, { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } }],
    });
    await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
    return promotion;
  }

  test('creating or editing a flow that points at a consent request is refused (it is sent by hand to people who have not answered yet); a normal promotion is accepted', async () => {
    const ops = require('../../../shared/operations');
    const A = await tenant('Aflowconsent');
    const request = await consentRequest(A);
    const normal = await Promotion.create({ workspaceId: A, name: 'Sale', customerType: 'cash', scope: 'products', discountPercent: 10 });
    await expect(ops.createFlow({ workspaceId: A, name: 'F1', triggerType: 'points_threshold', promotionId: request._id })).rejects.toThrow(/Ask customers to opt in/);
    const flow = await ops.createFlow({ workspaceId: A, name: 'F2', triggerType: 'points_threshold', promotionId: normal._id });
    await expect(ops.updateFlow({ id: flow._id, workspaceId: A, promotionId: request._id })).rejects.toThrow(/Ask customers to opt in/);
    expect(String((await Flow.findById(flow._id).lean()).promotionId)).toBe(String(normal._id)); // unchanged
  });

  test('a flow that points at one anyway (changed behind the app\'s back) sends NOTHING: the enrollment fails with the reason, no message leaves, nobody is marked as asked', async () => {
    const A = await tenant('Aflowconsent2');
    const request = await consentRequest(A);
    const customer = await fx.makeCustomer(A, { firstname: 'Sara', marketingConsent: true, loyaltyPoints: 5000 });
    const flow = await makeFlow(A, 'points_threshold', { pointsThreshold: 1000, promotionId: request._id });
    const enrollment = await FlowEnrollment.create({ workspaceId: A, flow: flow._id, customer: customer._id });
    calls.length = 0;
    await scheduler.processEnrollment(await Flow.findById(flow._id), enrollment);
    expect(messages()).toHaveLength(0);
    const row = await CampaignMessage.findOne({ flow: flow._id, customer: customer._id }).lean();
    expect(row).toMatchObject({ status: 'failed' });
    expect(row.statusReason).toMatch(/cannot send an "Ask customers to opt in" promotion/);
    expect((await Customer.findById(customer._id).lean()).marketingConsentAskedAt).toBeUndefined();
  });
});

// ── 3. currency per workspace in the template parameters ─────────────────────
describe('currency in the message parameters is the flow\'s own workspace\'s', () => {
  async function promotionFlow(workspaceId) {
    const product = await Product.create({ workspaceId, name: 'Blue Shirt', category: 'Shirts', basePrice: 100 });
    const promotion = await Promotion.create({ workspaceId, name: 'Big Sale', customerType: 'cash', scope: 'products', discountPercent: 20, products: [product._id] });
    const entry = await MessageNode.create({
      workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}',
      templateName: `wf_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop now', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
    const flow = await makeFlow(workspaceId, 'inactive_customer', { inactivityDays: 1, promotionId: promotion._id });
    return { promotion, entry, flow };
  }

  test('SAR for the Saudi workspace, USD for the other, from the same process; changing one invalidates only that one', async () => {
    const A = await tenant('Acur', { currency: 'SAR' });
    const B = await tenant('Bcur', { currency: 'USD' });
    const wa = await promotionFlow(A);
    const wb = await promotionFlow(B);
    const ca = await staleCustomer(A, { firstname: 'Sara' });
    const cb = await staleCustomer(B, { firstname: 'Bob' });

    await scheduler.sweepFlow(wa.flow);
    await scheduler.sweepFlow(wb.flow);
    const mA = messages().filter((m) => m.body.to === ca.phone);
    const mB = messages().filter((m) => m.body.to === cb.phone);
    expect(mA).toHaveLength(1);
    expect(mB).toHaveLength(1);
    expect(mA[0].body.template.name).toBe(wa.entry.templateName);
    expect(bodyParams(mA[0])).toEqual(['Sara', 'Blue Shirt', money(80, 'SAR'), 'Big Sale']);
    expect(bodyParams(mB[0])).toEqual(['Bob', 'Blue Shirt', money(80, 'USD'), 'Big Sale']);
    expect(bodyParams(mA[0])[2]).not.toBe(bodyParams(mB[0])[2]);
    expect(mA[0].ctx).toBe(String(A));
    expect(mB[0].ctx).toBe(String(B));
    const rowA = await CampaignMessage.findOne({ flow: wa.flow._id }).lean();
    expect(String(rowA.workspaceId)).toBe(String(A));
    expect(String(rowA.promotion)).toBe(String(wa.promotion._id));
    expect(String(rowA.messageNode)).toBe(String(wa.entry._id));

    // processEnrollment called directly (no sweep, no ambient context) still sends in the flow's workspace currency
    const ca2 = await staleCustomer(A, { firstname: 'Dana' });
    const enrollment = await FlowEnrollment.create({ workspaceId: A, flow: wa.flow._id, customer: ca2._id });
    calls.length = 0;
    await scheduler.processEnrollment(await Flow.findById(wa.flow._id), enrollment);
    expect(bodyParams(messages()[0])[2]).toBe(money(80, 'SAR'));

    // saving settings through the real operations invalidates the cache; the next send uses the new currency
    require('../../../shared/operations');
    await require('../../../shared/operations').updateLoyaltySettings({ currency: 'EUR' }, { workspaceId: A });
    const ca3 = await staleCustomer(A, { firstname: 'Eve' });
    calls.length = 0;
    await scheduler.sweepFlow(await Flow.findById(wa.flow._id));
    expect(bodyParams(messages().find((m) => m.body.to === ca3.phone))[2]).toBe(money(80, 'EUR'));
    // ... and B is unaffected
    const cb2 = await staleCustomer(B, { firstname: 'Finn' });
    calls.length = 0;
    await scheduler.sweepFlow(await Flow.findById(wb.flow._id));
    expect(bodyParams(messages().find((m) => m.body.to === cb2.phone))[2]).toBe(money(80, 'USD'));
  });

  test('the cache itself: per workspace, ALS default, legacy first document with no context', async () => {
    const A = await tenant('Acache', { currency: 'SAR' });
    const B = await tenant('Bcache', { currency: 'USD' });
    expect(await settingsCache.getCurrency(A)).toBe('SAR');
    expect(await settingsCache.getCurrency(B)).toBe('USD');
    expect(await senderContext.run(String(A), () => settingsCache.getCurrency())).toBe('SAR');
    expect(await senderContext.run(String(B), () => settingsCache.getCurrency())).toBe('USD');
    settingsCache.invalidate();
    const first = await Settings.findOne();
    expect(await settingsCache.getCurrency()).toBe(first.currency || 'AUD'); // no context: the first Settings document, as before
    // a workspace with no Settings document yet gets one of its own (stamped), with the default currency
    const lone = await Workspace.create({ name: `lone ${fx.uniq()}` });
    expect(await settingsCache.getCurrency(lone._id)).toBe('AUD');
    expect(await Settings.countDocuments({ workspaceId: lone._id })).toBe(1);
  });
});

// ── 4. cooldown per workspace; rows written by the old engine (no workspaceId) still count ──
describe('cooldown and the old unstamped rows', () => {
  test('each workspace\'s own flowCooldownDays applies; an unstamped CampaignMessage from before still blocks', async () => {
    const A = await tenant('Acool', { flowCooldownDays: 0 }); // no cooldown
    const B = await tenant('Bcool', { flowCooldownDays: 10 }); // ten days
    const ca = await staleCustomer(A);
    const cb = await staleCustomer(B);
    const cb2 = await staleCustomer(B); // nothing sent to this one before
    const otherA = await Flow.create({ workspaceId: A, name: 'earlier A', triggerType: 'inactive_customer', status: 'paused' });
    const otherB = await Flow.create({ workspaceId: B, name: 'earlier B', triggerType: 'inactive_customer', status: 'paused' });
    // yesterday's flow message to each: A's is stamped, B's is a legacy row written by the old engine (no workspaceId)
    const mkMsg = (customer, flow, extra) => CampaignMessage.create({ kind: 'flow', flow: flow._id, customer: customer._id, phone: customer.phone, wamid: `wamid.OLD${++wamidSeq}${fx.uniq()}`, messageType: 'template', status: 'sent', sentAt: new Date(Date.now() - DAY), ...extra });
    await mkMsg(ca, otherA, { workspaceId: A });
    await mkMsg(cb, otherB, {});
    const flowA = await makeFlow(A, 'inactive_customer', { inactivityDays: 60, cooldownDaysOverride: undefined });
    const flowB = await makeFlow(B, 'inactive_customer', { inactivityDays: 60, cooldownDaysOverride: undefined });
    await Flow.updateMany({ _id: { $in: [flowA._id, flowB._id] } }, { $unset: { cooldownDaysOverride: '' } });

    await scheduler.sweepFlow(await Flow.findById(flowA._id));
    await scheduler.sweepFlow(await Flow.findById(flowB._id));

    const stateOf = async (flow, customer) => (await FlowEnrollment.findOne({ flow: flow._id, customer: customer._id }).lean()).state;
    expect(await stateOf(flowA, ca)).toBe('messaged'); // A: cooldown 0 days
    expect(await stateOf(flowB, cb)).toBe('enrolled'); // B: 10 days, blocked by the unstamped legacy row (skip this tick)
    expect(await stateOf(flowB, cb2)).toBe('messaged'); // B: nothing recent for this customer
    expect(messages().filter((m) => m.body.to === ca.phone)).toHaveLength(1);
    expect(messages().filter((m) => m.body.to === cb.phone)).toHaveLength(0);
    expect(messages().filter((m) => m.body.to === cb2.phone)).toHaveLength(1);
  });

  test('an enrollment written by the old engine (no workspaceId) still counts as "already enrolled" / "already attempted": nobody is enrolled or messaged twice', async () => {
    const A = await tenant('Alegacy');
    // inactive_customer: a live legacy enrollment
    const stale = await staleCustomer(A);
    const flowInactive = await makeFlow(A, 'inactive_customer', { inactivityDays: 60, status: 'paused' });
    await FlowEnrollment.create({ flow: flowInactive._id, customer: stale._id, state: 'messaged' }); // no workspaceId
    // post_purchase_points: a resolved legacy enrollment for the order
    const buyer = await fx.makeCustomer(A);
    const order = await Order.create({ workspaceId: A, customer: buyer._id, total: 30, status: 'confirmed', paymentStatus: 'paid', paidAt: new Date(Date.now() - 3 * HOUR) });
    const flowPost = await makeFlow(A, 'post_purchase_points', { delayHours: 2, status: 'paused' });
    await FlowEnrollment.create({ flow: flowPost._id, customer: buyer._id, sourceModel: 'Order', sourceRef: order._id, state: 'exited' });
    // points_threshold: ever-enrolled legacy row
    const rich = await fx.makeCustomer(A, { loyaltyPoints: 5000 });
    const flowThreshold = await makeFlow(A, 'points_threshold', { pointsThreshold: 1000, status: 'paused' });
    await FlowEnrollment.create({ flow: flowThreshold._id, customer: rich._id, state: 'completed' });

    for (const f of [flowInactive, flowPost, flowThreshold]) await scheduler.enrollEligibleCustomers(f);
    expect(await FlowEnrollment.countDocuments({ flow: flowInactive._id })).toBe(1);
    expect(await FlowEnrollment.countDocuments({ flow: flowPost._id })).toBe(1);
    expect(await FlowEnrollment.countDocuments({ flow: flowThreshold._id })).toBe(1);
  });

  test('an old enrollment that points at ANOTHER workspace\'s customer (written by the unscoped engine) is closed out, nothing is sent', async () => {
    const A = await tenant('Aleak');
    const B = await tenant('Bleak');
    const victim = await staleCustomer(B);
    const flowA = await makeFlow(A, 'inactive_customer', { inactivityDays: 60 });
    const leaked = await FlowEnrollment.create({ flow: flowA._id, customer: victim._id }); // state 'enrolled', no workspaceId
    await scheduler.sendPendingEnrollments(flowA);
    const after = await FlowEnrollment.findById(leaked._id).lean();
    expect(after.state).toBe('exited');
    expect(after.exitReason).toBe('customer_deleted');
    expect(messages().filter((m) => m.body.to === victim.phone)).toHaveLength(0);
    expect(await CampaignMessage.countDocuments({ customer: victim._id })).toBe(0);
  });

  test('requiresPriorFlowId: the prior-stage check reads this workspace\'s enrollments (and legacy unstamped ones), not another workspace\'s', async () => {
    const A = await tenant('Aprior');
    const B = await tenant('Bprior');
    const cA = await staleCustomer(A);
    const cB = await staleCustomer(B);
    const priorA = await makeFlow(A, 'inactive_customer', { inactivityDays: 30, status: 'paused' });
    const priorB = await makeFlow(B, 'inactive_customer', { inactivityDays: 30, status: 'paused' });
    await FlowEnrollment.create({ flow: priorA._id, customer: cA._id, state: 'messaged' }); // legacy unstamped
    await FlowEnrollment.create({ workspaceId: B, flow: priorB._id, customer: cB._id, state: 'messaged' });
    const stageA = await makeFlow(A, 'inactive_customer', { inactivityDays: 60, status: 'paused', requiresPriorFlowId: priorA._id });
    const stageB = await makeFlow(B, 'inactive_customer', { inactivityDays: 60, status: 'paused', requiresPriorFlowId: priorB._id });
    await scheduler.enrollEligibleCustomers(stageA);
    await scheduler.enrollEligibleCustomers(stageB);
    expect(await enrolledCustomers(stageA)).toEqual(ids([cA._id]));
    expect(await enrolledCustomers(stageB)).toEqual(ids([cB._id]));
  });
});

// ── 5. edge cases ────────────────────────────────────────────────────────────
describe('edge cases', () => {
  test('opted-out and demo customers of the flow\'s own workspace are still never enrolled (scoping did not loosen anything)', async () => {
    const A = await tenant('Aedge');
    const optedOut = await staleCustomer(A, { optedOut: true });
    const demo = await staleCustomer(A, { isDemo: true });
    const noConsent = await staleCustomer(A, { marketingConsent: false });
    const ok = await staleCustomer(A);
    const flow = await makeFlow(A, 'inactive_customer', { inactivityDays: 60, status: 'paused' });
    await scheduler.enrollEligibleCustomers(flow);
    expect(await enrolledCustomers(flow)).toEqual(ids([ok._id]));
    expect(await FlowEnrollment.countDocuments({ flow: flow._id, customer: { $in: [optedOut._id, demo._id, noConsent._id] } })).toBe(0);
  });

  test('a workspace with no customers or orders at all: every trigger answers empty, nothing throws', async () => {
    const empty = await tenant('Aempty');
    for (const [type, q] of Object.entries(QUALIFIERS)) {
      const flow = await makeFlow(empty, type, { ...q.flow, status: 'paused' });
      expect(await triggers[type].findEligible(flow)).toEqual([]);
    }
  });

  test('a flow with a malformed workspaceId cannot enrol anybody when driven by hand (fails closed, never runs unscoped)', async () => {
    const A = await tenant('Abad');
    const c = await staleCustomer(A);
    const bad = { _id: oid(), triggerType: 'inactive_customer', inactivityDays: 60, workspaceId: 'not-an-object-id' };
    await expect(scheduler.enrollEligibleCustomers(bad)).rejects.toThrow(/invalid workspaceId/);
    expect(await FlowEnrollment.countDocuments({ customer: c._id })).toBe(0);
  });

  test('the shared phone: opt-out in workspace A does not stop workspace B\'s flow (separate customer rows, separate consent)', async () => {
    const A = await tenant('Aphone');
    const B = await tenant('Bphone');
    const phone = fx.nextPhone();
    const inA = await staleCustomer(A, { phone, optedOut: true });
    const inB = await staleCustomer(B, { phone });
    const flowA = await makeFlow(A, 'inactive_customer', { inactivityDays: 60, status: 'paused' });
    const flowB = await makeFlow(B, 'inactive_customer', { inactivityDays: 60, status: 'paused' });
    await scheduler.enrollEligibleCustomers(flowA);
    await scheduler.enrollEligibleCustomers(flowB);
    expect(await enrolledCustomers(flowA)).toEqual([]);
    expect(await enrolledCustomers(flowB)).toEqual(ids([inB._id]));
    expect(inA.phone).toBe(inB.phone);
  });
});
