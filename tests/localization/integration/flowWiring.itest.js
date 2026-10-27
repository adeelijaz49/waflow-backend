const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();
// Flow engine + follow-up wiring on a REAL mongod (the throwaway one), no network:
//   * utils/flowScheduler.js processEnrollment (the real engine, real triggers, real models) with Arabic and
//     English customers, flagged and unflagged workspaces: the Arabic send goes through transport.js in
//     LOCALIZATION_SEND_MODE=dry_run (captured, never sent); the English path is observed through a stubbed axios
//     adapter that records every outbound call and answers with a fake wamid. Nothing leaves the machine.
//   * every fall-through condition (English customer, flag off, kill switch, no / draft / unapproved variant,
//     English node not approved, foreign-tenant customer, cooldown), claim semantics (one send under two
//     concurrent processEnrollment calls, never a second one), the failed-send row (no English afterwards), the
//     workspaceId on the Arabic CampaignMessage, the legacy entryNodeId flow and the {service} of booking no-show.
//   * the follow-up helper (shared/localization/followUpSender.js) over the real authoring routes: draft / reviewed /
//     stale variants, tenant isolation, interactive payload ids; the tap path itself lives in server.js (IM-C).
const axios = require('axios');
const mongoose = require('mongoose');
const h = require('./helpers/_harness');
const Flow = require('../../../models/Flow');
const FlowEnrollment = require('../../../models/FlowEnrollment');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const Customer = require('../../../models/Customer');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const LocalizedFlowNode = require('../../../models/LocalizedFlowNode');
const Order = require('../../../models/Order');
const Booking = require('../../../models/Booking');
const Service = require('../../../models/Service');
const ProductTranslation = require('../../../models/ProductTranslation');
const settings = require('../../../shared/localization/settings');
const transport = require('../../../shared/localization/transport');
const { processEnrollment } = require('../../../utils/flowScheduler');
const { sendLocalizedFollowUp } = require('../../../shared/localization/followUpSender');

jest.setTimeout(90000);

// ── outbound stub: nothing leaves the machine ────────────────────────────
const calls = [];
let wamidSeq = 0;
let failNextMessage = null;
function installAdapter() {
  axios.defaults.adapter = async (config) => {
    let body = config.data;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
    const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body };
    calls.push(rec);
    const isMessage = /\/messages$/.test(rec.url) && rec.method === 'POST';
    if (isMessage && failNextMessage) {
      const message = failNextMessage;
      failNextMessage = null;
      const response = { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message, code: 131047 } } };
      throw new axios.AxiosError(`Request failed with status code 400`, 'ERR_BAD_REQUEST', config, {}, response);
    }
    const data = isMessage
      ? { messaging_product: 'whatsapp', messages: [{ id: `wamid.ENG${++wamidSeq}` }] }
      : (rec.method === 'GET' ? { data: [{ name: 'x', status: 'APPROVED' }] } : { id: `stub${++wamidSeq}` });
    return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
  };
}
const messageCalls = () => calls.filter((c) => /\/messages$/.test(c.url) && c.method === 'POST');

const button = (position, label, next) => ({ position, label, nextAction: next || { type: 'end_flow' } });
const oid = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const LRM = '\u{200E}';

let ctx; // { A, B, C }: A flagged, B flagged, C unflagged tenants (harness)

beforeAll(async () => {
  ctx = await h.setup();
  await LocalizedFlowNode.createIndexes();
  await FlowEnrollment.createIndexes();
  installAdapter();
});
beforeEach(() => {
  calls.length = 0;
  transport.clearDryRuns();
  settings.clearCache();
  failNextMessage = null;
  delete process.env.LOCALIZATION_DISABLED;
});
afterEach(() => { delete process.env.LOCALIZATION_DISABLED; });

// ── fixtures ─────────────────────────────────────────────────────────────
const AR_BUTTONS = [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقًا' }, { role: 'opt_out', text: 'إلغاء الاشتراك' }];

// A promotion flow: Promotion + approved English entry node (+ one follow-up node) + a linked template with an
// approved + reviewed Arabic variant + an inactive_customer flow + a stale customer with a past order.
async function promotionFlowWorld(tenant, { language = 'ar', arabic = {}, nodeStatus = 'approved', template = true, firstname = 'Sara', customerWorkspace, useCase = 'custom' } = {}) {
  const workspaceId = tenant.wsId;
  const promotion = await Promotion.create({ workspaceId, name: 'Eid Sale', customerType: 'cash', scope: 'products', discountPercent: 20 });
  const followUp = await MessageNode.create({ workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: false, depth: 1, bodyText: 'Great choice {{1}}! Your order is on its way.', buttons: [button(0, 'Track it'), button(1, 'Done')] });
  const entry = await MessageNode.create({
    workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}',
    templateName: `wf_en_${h.uniq()}`, templateStatus: nodeStatus,
    buttons: [button(0, 'Shop now', { type: 'send_message', targetNodeId: followUp._id }), button(1, 'Not now')],
  });
  await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: entry._id } });
  if (template) {
    await LocalizedTemplate.create({
      workspaceId, key: `flow_message_${entry._id}`, name: 'Eid Sale', category: 'MARKETING', useCase, linkedMessageNodeId: entry._id,
      variants: [
        { language: 'en', body: 'Hi {name}! {item} for {price} - {promo_name}', buttons: [{ role: 'flow_button', text: 'Shop now' }, { role: 'flow_button', text: 'Not now' }], metaStatus: 'APPROVED', metaTemplateName: entry.templateName, metaLanguage: 'en' },
        { language: 'ar', body: 'أهلاً {name}! لدينا {promo_name} لك', footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك', buttons: AR_BUTTONS, metaStatus: 'APPROVED', metaTemplateName: `wf_ar_${h.uniq()}`, metaLanguage: 'ar', reviewStatus: 'reviewed', ...arabic },
      ],
    });
  }
  const flow = await Flow.create({ workspaceId, name: 'Win-back', triggerType: 'inactive_customer', status: 'active', promotionId: promotion._id, inactivityDays: 1 });
  const customer = await staleCustomer(customerWorkspace || workspaceId, { language, firstname });
  const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id }); // like the engine: no workspaceId
  return { workspaceId, promotion, entry, followUp, flow, customer, enrollment };
}

async function staleCustomer(workspaceId, { language, firstname = 'Sara' } = {}) {
  const customer = await h.makeCustomer(workspaceId, { firstname, marketingConsent: true });
  if (language) await CustomerLanguage.create({ workspaceId, customerId: customer._id, language, languageSource: 'merchant_set' });
  const order = await Order.create({ workspaceId, customer: customer._id, total: 10, status: 'delivered' });
  await Order.collection.updateOne({ _id: order._id }, { $set: { createdAt: new Date(Date.now() - 5 * DAY) } }); // update only: never a delete
  return customer;
}

async function run(world) {
  const flow = await Flow.findById(world.flow._id);
  const enrollment = await FlowEnrollment.findById(world.enrollment._id);
  await processEnrollment(flow, enrollment);
}
const rows = (world) => CampaignMessage.find({ flow: world.flow._id }).lean();
const stateOf = async (world) => (await FlowEnrollment.findById(world.enrollment._id).lean()).state;
const dryRuns = () => transport.lastDryRuns().filter((d) => d.label === 'template');

// ── Arabic send ──────────────────────────────────────────────────────────
describe('processEnrollment: an Arabic customer of a flagged workspace', () => {
  test('gets the Arabic template (name, language, params, payloads); the row carries the workspace; English is not sent', async () => {
    const world = await promotionFlowWorld(ctx.A, {});
    await run(world);
    const sent = dryRuns();
    expect(sent).toHaveLength(1);
    const t = sent[0].payload.template;
    const tpl = await LocalizedTemplate.findOne({ linkedMessageNodeId: world.entry._id }).lean();
    expect(sent[0].payload.to).toBe(world.customer.phone);
    expect(t.name).toBe(tpl.variants.find((v) => v.language === 'ar').metaTemplateName);
    expect(t.language).toEqual({ code: 'ar' });
    expect(t.components.find((c) => c.type === 'body').parameters.map((p) => p.text)).toEqual(['Sara', 'Eid Sale']);
    const buttons = t.components.filter((c) => c.type === 'button');
    expect(buttons.map((b) => b.parameters[0].payload)).toEqual([`msgnode_${world.entry._id}_0`, `msgnode_${world.entry._id}_1`, `optout_${world.entry._id}`]);
    expect(messageCalls()).toHaveLength(0); // nothing went out through the English builders

    const [row, ...others] = await rows(world);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      kind: 'flow', status: 'sent', messageType: 'template', templateName: t.name, phone: world.customer.phone,
    });
    expect(String(row.workspaceId)).toBe(String(world.workspaceId));
    expect(String(row.flow)).toBe(String(world.flow._id));
    expect(String(row.flowEnrollment)).toBe(String(world.enrollment._id));
    expect(String(row.promotion)).toBe(String(world.promotion._id));
    expect(String(row.messageNode)).toBe(String(world.entry._id));
    expect(row.wamid).toMatch(/^dryrun\./);
    expect(row.sentAt).toBeInstanceOf(Date);
    expect(await stateOf(world)).toBe('messaged');
  });

  test('the {price} of a cash promotion is written the Arabic way (80.00 ر.س style), from the English amount and currency', async () => {
    const Product = require('../../../models/Product');
    const world = await promotionFlowWorld(ctx.A, { arabic: { body: 'أهلاً {name}! {item} بسعر {price} ضمن {promo_name}' } });
    const product = await Product.create({ workspaceId: world.workspaceId, name: 'Blue Shirt', category: 'Shirts', basePrice: 100 });
    await Promotion.updateOne({ _id: world.promotion._id }, { $set: { products: [product._id] } });
    await run(world);
    expect(dryRuns()).toHaveLength(1);
    const params = dryRuns()[0].payload.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text);
    const currency = await require('../../../utils/settingsCache').getCurrency();
    expect(params).toEqual(['Sara', 'Blue Shirt', require('../../../shared/localization/senderValues').formatMoney(80, currency, 'ar'), 'Eid Sale']);
    expect(params[2]).toMatch(/^80[.]00 /);
    await Product.updateOne({ _id: product._id }, { $set: { active: false } }); // never a delete; keeps the shared catalogue clean for the 'no products' case below
  });

  test('a second processEnrollment, and two concurrent ones, never send again (the claim is atomic)', async () => {
    const world = await promotionFlowWorld(ctx.A, {});
    await run(world);
    await run(world);
    expect(dryRuns()).toHaveLength(1);
    const racing = await promotionFlowWorld(ctx.A, {});
    transport.clearDryRuns();
    await Promise.all([run(racing), run(racing), run(racing)]);
    expect(dryRuns()).toHaveLength(1);
    expect(messageCalls()).toHaveLength(0);
    expect(await rows(racing)).toHaveLength(1);
  });

  test('Latin first name inside the Arabic text, a missing name, a phone-like name and a 100-character name', async () => {
    const cases = [['Sara', 'Sara'], ['Mohammed محمد', 'Mohammed محمد'], ['', 'عميلنا العزيز'], ['+966 50 000 0001', 'عميلنا العزيز'], ['N'.repeat(100), 'N'.repeat(100)]];
    for (const [firstname, shown] of cases) {
      transport.clearDryRuns();
      const world = await promotionFlowWorld(ctx.A, { firstname: firstname || 'x' });
      if (!firstname || firstname.startsWith('+')) await Customer.updateOne({ _id: world.customer._id }, { $set: { firstname } });
      await run(world);
      expect(dryRuns()).toHaveLength(1);
      expect(dryRuns()[0].payload.template.components.find((c) => c.type === 'body').parameters[0].text).toBe(shown);
    }
  });

  test('the cooldown of another flow is honoured: nothing sent, the enrollment stays for the next tick', async () => {
    const world = await promotionFlowWorld(ctx.A, {});
    const other = await Flow.create({ workspaceId: world.workspaceId, name: 'Other', triggerType: 'inactive_customer', status: 'active', promotionId: world.promotion._id });
    await CampaignMessage.create({ workspaceId: world.workspaceId, kind: 'flow', flow: other._id, customer: world.customer._id, phone: world.customer.phone, status: 'sent', sentAt: new Date() });
    await run(world);
    expect(dryRuns()).toHaveLength(0);
    expect(messageCalls()).toHaveLength(0);
    expect(await stateOf(world)).toBe('enrolled');
  });

  test('an Arabic row counts for the cooldown of a LATER flow (customer-keyed)', async () => {
    const world = await promotionFlowWorld(ctx.A, {});
    await run(world);
    const second = await Flow.create({ workspaceId: world.workspaceId, name: 'Second', triggerType: 'inactive_customer', status: 'active', promotionId: world.promotion._id, inactivityDays: 1 });
    const enrollment = await FlowEnrollment.create({ flow: second._id, customer: world.customer._id });
    transport.clearDryRuns();
    await processEnrollment(await Flow.findById(second._id), await FlowEnrollment.findById(enrollment._id));
    expect(dryRuns()).toHaveLength(0);
    expect((await FlowEnrollment.findById(enrollment._id).lean()).state).toBe('enrolled');
  });

  test('a failed Arabic send is recorded failed, with the reason and the workspace, and is NOT followed by an English send', async () => {
    const world = await promotionFlowWorld(ctx.A, {});
    const spy = jest.spyOn(transport, 'sendTemplate').mockRejectedValueOnce(new Error('(#131026) Message undeliverable'));
    try { await run(world); } finally { spy.mockRestore(); }
    expect(messageCalls()).toHaveLength(0);
    expect(dryRuns()).toHaveLength(0);
    const [row] = await rows(world);
    expect(row).toMatchObject({ status: 'failed', statusReason: '(#131026) Message undeliverable', kind: 'flow' });
    expect(String(row.workspaceId)).toBe(String(world.workspaceId));
    expect(row.wamid).toBeUndefined();
    expect(await stateOf(world)).toBe('messaged');
    await run(world);
    expect(dryRuns()).toHaveLength(0); // never retried
  });
});

// ── fall-through conditions: the unchanged English engine ─────────────────
describe('processEnrollment: everything else is the unchanged English path', () => {
  const english = async (world, expectStatus = 'sent') => {
    await run(world);
    expect(dryRuns()).toHaveLength(0); // no Arabic send
    const [row] = await rows(world);
    expect(row.status).toBe(expectStatus);
    // The English engine row now carries the flow's workspace too (one app, many customers: delivery callbacks, reports and
    // msgnode_ taps look the row up by it). It used to be written without one (IB-13).
    expect(String(row.workspaceId)).toBe(String(world.workspaceId));
    return { row, out: messageCalls() };
  };

  test('an English customer of a flagged workspace', async () => {
    const world = await promotionFlowWorld(ctx.A, { language: 'en' });
    const { row, out } = await english(world);
    expect(out).toHaveLength(1);
    expect(out[0].body.template).toMatchObject({ name: world.entry.templateName, language: { code: 'en' } });
    expect(row.templateName).toBe(world.entry.templateName);
    expect(String(row.messageNode)).toBe(String(world.entry._id));
  });

  test('a customer with no language record and an English merchant default', async () => {
    const { out } = await english(await promotionFlowWorld(ctx.A, { language: null }));
    expect(out).toHaveLength(1);
  });

  test('an Arabic customer of an UNFLAGGED workspace', async () => {
    const { out } = await english(await promotionFlowWorld(ctx.C, { language: 'ar' }));
    expect(out[0].body.template.language).toEqual({ code: 'en' });
  });

  test('the kill switch LOCALIZATION_DISABLED=1', async () => {
    process.env.LOCALIZATION_DISABLED = '1';
    const { out } = await english(await promotionFlowWorld(ctx.A, { language: 'ar' }));
    expect(out[0].body.template.language).toEqual({ code: 'en' });
  });

  test.each([
    ['no linked template', { template: false }],
    ['an unreviewed (draft) Arabic variant', { arabic: { reviewStatus: 'draft' } }],
    ['an Arabic variant Meta has not approved', { arabic: { metaStatus: 'PENDING' } }],
    ['an Arabic variant without its Meta name', { arabic: { metaTemplateName: undefined } }],
    ['an Arabic variant without the opt-out button (every flow message is marketing, R2-02)', { arabic: { buttons: [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقًا' }] } }],
    ['a UTILITY-floor use case template linked to the node whose Arabic variant has no opt-out button', { useCase: 'order_confirmation', arabic: { buttons: [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقًا' }] } }],
    ['an Arabic variant whose buttons no longer match the node', { arabic: { buttons: [{ role: 'flow_button', text: 'واحد' }, { role: 'opt_out', text: 'إلغاء' }] } }],
  ])('%s', async (_, options) => {
    const { out } = await english(await promotionFlowWorld(ctx.A, { language: 'ar', ...options }));
    expect(out).toHaveLength(1);
    expect(out[0].body.template.language).toEqual({ code: 'en' });
  });

  test('an Arabic field nobody can fill ({item} of a cash promotion without products) keeps the English message', async () => {
    const world = await promotionFlowWorld(ctx.A, { language: 'ar', arabic: { body: 'أهلاً {name}! {item} بسعر {price}' } });
    await Promotion.updateOne({ _id: world.promotion._id }, { $set: { products: [] } });
    await run(world);
    // {item} falls back to the Arabic default and {price} needs an item: no price -> English
    expect(dryRuns()).toHaveLength(0);
    expect(messageCalls()).toHaveLength(1);
  });

  test('the English node is NOT approved (edited and resubmitted): the English engine fails exactly as today and no Arabic is sent', async () => {
    const world = await promotionFlowWorld(ctx.A, { language: 'ar', nodeStatus: 'pending' });
    const { row, out } = await english(world, 'failed');
    expect(out).toHaveLength(0);
    expect(row.statusReason).toMatch(/approved custom message/);
  });

  // The triggers used to be tenant-blind: a customer of ANOTHER workspace could be enrolled in this flow and was sent the English
  // message (the cross-tenant leak itself). Every lookup is now scoped to the flow's workspace, so that enrollment is closed
  // out and nothing is sent - in any language.
  test('a customer of ANOTHER workspace enrolled by the old tenant-blind trigger is exited and gets nothing (no Arabic, no English)', async () => {
    const world = await promotionFlowWorld(ctx.A, { language: 'ar', customerWorkspace: ctx.B.wsId });
    await run(world);
    expect(dryRuns()).toHaveLength(0);
    expect(messageCalls()).toHaveLength(0);
    expect(await rows(world)).toHaveLength(0);
    const enrollment = await FlowEnrollment.findById(world.enrollment._id).lean();
    expect(enrollment.state).toBe('exited');
    expect(enrollment.exitReason).toBe('customer_deleted');
  });

  test('an opted-out customer exits before anything is sent (engine behaviour)', async () => {
    const world = await promotionFlowWorld(ctx.A, { language: 'ar' });
    await Customer.updateOne({ _id: world.customer._id }, { $set: { optedOut: true } });
    await run(world);
    expect(dryRuns()).toHaveLength(0);
    expect(messageCalls()).toHaveLength(0);
    expect(await stateOf(world)).toBe('exited');
  });

  test('a fixed default template flow (no promotion, no entry node) stays English even for an Arabic customer', async () => {
    const workspaceId = ctx.A.wsId;
    const flow = await Flow.create({ workspaceId, name: 'Default winback', triggerType: 'inactive_customer', status: 'active', inactivityDays: 1, templateName: 'waflow_winback' });
    const customer = await staleCustomer(workspaceId, { language: 'ar' });
    const enrollment = await FlowEnrollment.create({ flow: flow._id, customer: customer._id });
    await processEnrollment(await Flow.findById(flow._id), await FlowEnrollment.findById(enrollment._id));
    expect(dryRuns()).toHaveLength(0);
    const out = messageCalls();
    expect(out).toHaveLength(1);
    expect(out[0].body.template).toMatchObject({ name: 'waflow_winback', language: { code: 'en' } });
  });
});

// ── legacy entryNodeId flow and booking no-show {service} ───────────────────
describe('processEnrollment: legacy flows', () => {
  async function legacyWorld(tenant, { trigger = 'inactive_customer', body = 'Hi {{1}}, we miss you!', arabicBody = 'أهلاً {name}، اشتقنا لك' } = {}) {
    const workspaceId = tenant.wsId;
    const flow = await Flow.create({ workspaceId, name: `Legacy ${trigger}`, triggerType: trigger, status: 'active', inactivityDays: 1 });
    const entry = await MessageNode.create({ workspaceId, ownerType: 'flow', ownerId: flow._id, isEntryNode: true, bodyText: body, templateName: `wf_en_${h.uniq()}`, templateStatus: 'approved', buttons: [button(0, 'Come back')] });
    await Flow.updateOne({ _id: flow._id }, { $set: { entryNodeId: entry._id } });
    await LocalizedTemplate.create({
      workspaceId, key: `flow_message_${entry._id}`, name: 'Legacy', category: 'MARKETING', useCase: 'custom', linkedMessageNodeId: entry._id,
      variants: [
        { language: 'en', body: 'x', buttons: [{ role: 'flow_button', text: 'Come back' }], metaStatus: 'APPROVED', metaTemplateName: entry.templateName, metaLanguage: 'en' },
        { language: 'ar', body: arabicBody, footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك', buttons: [{ role: 'flow_button', text: 'عد إلينا' }, { role: 'opt_out', text: 'إلغاء الاشتراك' }], metaStatus: 'APPROVED', metaTemplateName: `wf_ar_${h.uniq()}`, metaLanguage: 'ar', reviewStatus: 'reviewed' },
      ],
    });
    return { workspaceId, flow, entry };
  }

  test('inactive_customer with its own entryNodeId: Arabic for an Arabic customer, English for an English one', async () => {
    const legacy = await legacyWorld(ctx.A);
    const arabic = await staleCustomer(legacy.workspaceId, { language: 'ar' });
    const english = await staleCustomer(legacy.workspaceId, { language: 'en' });
    const [ea, ee] = await Promise.all([arabic, english].map((c) => FlowEnrollment.create({ flow: legacy.flow._id, customer: c._id })));
    const flow = await Flow.findById(legacy.flow._id);
    await processEnrollment(flow, await FlowEnrollment.findById(ea._id));
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0].payload.template.language).toEqual({ code: 'ar' });
    // the cross-flow cooldown only blocks OTHER flows, so the English customer of the same flow goes out in English
    await processEnrollment(flow, await FlowEnrollment.findById(ee._id));
    expect(dryRuns()).toHaveLength(1);
    expect(messageCalls()).toHaveLength(1);
    expect(messageCalls()[0].body.template.language).toEqual({ code: 'en' });
    const sent = await CampaignMessage.find({ flow: legacy.flow._id }).lean();
    expect(sent).toHaveLength(2); // the Arabic row and the English row: both carry the flow's workspace now
    expect(sent.every((r) => String(r.workspaceId) === String(legacy.workspaceId))).toBe(true);
  });

  test('booking_no_show with {service}: the booking\'s service (reviewed Arabic name first) fills the Arabic message', async () => {
    const legacy = await legacyWorld(ctx.A, { trigger: 'booking_no_show', body: 'Hi {{1}}, we missed you for {{2}}', arabicBody: 'أهلاً {name}، فاتنا موعدك لـ {service}' });
    const service = await Service.create({ workspaceId: legacy.workspaceId, name: 'Facial' });
    await ProductTranslation.create({ workspaceId: legacy.workspaceId, kind: 'service', refId: service._id, language: 'ar', name: 'جلسة عناية', status: 'reviewed' });
    const customer = await h.makeCustomer(legacy.workspaceId, { firstname: 'Sara', marketingConsent: true });
    await CustomerLanguage.create({ workspaceId: legacy.workspaceId, customerId: customer._id, language: 'ar', languageSource: 'merchant_set' });
    const booking = await Booking.create({ workspaceId: legacy.workspaceId, serviceId: service._id, slotId: oid(), phone: customer.phone, customerId: customer._id, status: 'no-show' });
    const enrollment = await FlowEnrollment.create({ flow: legacy.flow._id, customer: customer._id, sourceModel: 'Booking', sourceRef: booking._id });
    await processEnrollment(await Flow.findById(legacy.flow._id), await FlowEnrollment.findById(enrollment._id));
    expect(dryRuns()).toHaveLength(1);
    expect(dryRuns()[0].payload.template.components.find((c) => c.type === 'body').parameters.map((p) => p.text)).toEqual(['Sara', 'جلسة عناية']);
    expect(messageCalls()).toHaveLength(0);
  });

  test('booking_no_show whose service row is missing: the Arabic fallback fills {service}', async () => {
    const legacy = await legacyWorld(ctx.A, { trigger: 'booking_no_show', body: 'Hi {{1}}, we missed you for {{2}}', arabicBody: 'أهلاً {name}، فاتنا موعدك لـ {service}' });
    const customer = await h.makeCustomer(legacy.workspaceId, { firstname: 'Sara', marketingConsent: true });
    await CustomerLanguage.create({ workspaceId: legacy.workspaceId, customerId: customer._id, language: 'ar', languageSource: 'merchant_set' });
    const booking = await Booking.create({ workspaceId: legacy.workspaceId, serviceId: oid(), slotId: oid(), phone: customer.phone, customerId: customer._id, status: 'no-show' });
    const enrollment = await FlowEnrollment.create({ flow: legacy.flow._id, customer: customer._id, sourceModel: 'Booking', sourceRef: booking._id });
    await processEnrollment(await Flow.findById(legacy.flow._id), await FlowEnrollment.findById(enrollment._id));
    expect(dryRuns()).toHaveLength(1); // the service has no row, so the Arabic fallback fills {service}: still a ready, reviewed message
  });
});

// ── the follow-up helper over the real authoring routes ───────────────────
describe('Arabic follow-ups: authoring routes + sender helper', () => {
  const A = () => ctx.api(ctx.A);
  async function followUpWorld(tenant = ctx.A, language = 'ar') {
    const world = await promotionFlowWorld(tenant, { language });
    return { ...world, to: world.customer.phone };
  }
  const body = { body: 'اختيار رائع يا {name}! طلبك في الطريق.', buttons: [{ position: 0, text: 'تتبع الطلب' }, { position: 1, text: 'تم' }] };
  const sendFollowUp = (world, over = {}) => sendLocalizedFollowUp({ workspaceId: String(world.workspaceId), to: world.to, node: world.followUp, customer: world.customer, enrollmentId: world.enrollment._id, ...over });
  const save = (world, payload = body) => ctx.api(ctx.A).put(`/flows/followups/${world.followUp._id}/variants/ar`).send(payload);
  const review = (world, contentVersion, status = 'reviewed') => ctx.api(ctx.A).post(`/flows/followups/${world.followUp._id}/variants/ar/review`).send({ status, contentVersion });
  const buttonsDryRuns = () => transport.lastDryRuns().filter((d) => d.label === 'buttons');

  test('no Arabic row: the helper answers null (English)', async () => {
    const world = await followUpWorld();
    expect(await sendFollowUp(world)).toBeNull();
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('draft -> not sent; reviewed -> interactive Arabic message with the positional ids; edited again -> draft -> not sent', async () => {
    const world = await followUpWorld();
    const saved = await save(world);
    expect(saved.status).toBe(200);
    expect(saved.body.variant).toMatchObject({ reviewStatus: 'draft', sendable: false, contentVersion: 1 });
    expect(await sendFollowUp(world)).toBeNull();

    const reviewed = await review(world, 1);
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.variant).toMatchObject({ reviewStatus: 'reviewed', sendable: true });
    const out = await sendFollowUp(world);
    expect(out.language).toBe('ar');
    expect(out.result.messages[0].id).toMatch(/^dryrun\./);
    const [sent] = buttonsDryRuns();
    expect(sent.payload.to).toBe(world.to);
    expect(sent.payload.interactive.type).toBe('button');
    expect(sent.payload.interactive.body.text).toBe(`اختيار رائع يا ${LRM}Sara${LRM}! طلبك في الطريق.`); // the Latin name is isolated from the Arabic text
    expect(sent.payload.interactive.action.buttons).toEqual([
      { type: 'reply', reply: { id: `msgnode_${world.followUp._id}_0`, title: 'تتبع الطلب' } },
      { type: 'reply', reply: { id: `msgnode_${world.followUp._id}_1`, title: 'تم' } },
    ]);

    transport.clearDryRuns();
    await save(world, { ...body, body: 'اختيار ممتاز يا {name}!' });
    expect(await sendFollowUp(world)).toBeNull();
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('the English text edited after the review makes the Arabic version stale: English until it is saved and reviewed again', async () => {
    const world = await followUpWorld();
    await save(world);
    await review(world, 1);
    expect(await sendFollowUp(world)).not.toBeNull();
    await MessageNode.updateOne({ _id: world.followUp._id }, { $set: { bodyText: 'A different offer for {{1}}' } });
    transport.clearDryRuns();
    expect(await sendFollowUp(world)).toBeNull();
    const view = await ctx.api(ctx.A).get(`/flows/followups/${world.followUp._id}`);
    expect(view.body).toMatchObject({ stale: true, sendable: false });
    const stale = await review(world, 1);
    expect(stale.status).toBe(409);
    const resaved = await save(world);
    expect(resaved.body).toMatchObject({ stale: false });
    expect(resaved.body.variant.reviewStatus).toBe('draft');
    expect((await review(world, resaved.body.variant.contentVersion)).status).toBe(200);
    expect(await sendFollowUp(world)).not.toBeNull();
  });

  test('English customers, opted-out customers, unflagged workspaces and the kill switch get null', async () => {
    const english = await followUpWorld(ctx.A, 'en');
    await save(english);
    await review(english, 1);
    expect(await sendFollowUp(english)).toBeNull();

    const arabic = await followUpWorld();
    await save(arabic);
    await review(arabic, 1);
    expect(await sendFollowUp(arabic, { customer: { ...arabic.customer.toObject(), optedOut: true } })).toBeNull();
    process.env.LOCALIZATION_DISABLED = '1';
    expect(await sendFollowUp(arabic)).toBeNull();
    delete process.env.LOCALIZATION_DISABLED;
    await settings.setArabicEnabled({ workspaceId: arabic.workspaceId, enabled: false, grantedBy: 'itest' });
    settings.clearCache();
    expect(await sendFollowUp(arabic)).toBeNull();
    await settings.setArabicEnabled({ workspaceId: arabic.workspaceId, enabled: true, grantedBy: 'itest' });
    settings.clearCache();
    expect(await sendFollowUp(arabic)).not.toBeNull();
  });

  test('tenant isolation: another workspace cannot read or write this node, and a workspace id mismatch sends nothing', async () => {
    const world = await followUpWorld();
    await save(world);
    await review(world, 1);
    const b = ctx.api(ctx.B);
    expect((await b.get(`/flows/followups/${world.followUp._id}`)).status).toBe(404);
    expect((await b.put(`/flows/followups/${world.followUp._id}/variants/ar`).send(body)).status).toBe(404);
    expect((await b.post(`/flows/followups/${world.followUp._id}/variants/ar/review`).send({ status: 'draft', contentVersion: 1 })).status).toBe(404);
    expect((await b.get('/flows/tree')).body.items.map((i) => i.flowId)).not.toContain(String(world.flow._id));
    expect(await sendFollowUp(world, { workspaceId: String(ctx.B.wsId) })).toBeNull();
    expect((await ctx.api(ctx.C).get(`/flows/followups/${world.followUp._id}`)).status).toBe(402); // unflagged workspace: the hub routes are closed
  });

  test('a failing send is { error }, never thrown, never re-sent', async () => {
    const world = await followUpWorld();
    await save(world);
    await review(world, 1);
    const spy = jest.spyOn(transport, 'sendButtons').mockRejectedValueOnce(new Error('(#131047) Re-engagement message'));
    let out;
    try { out = await sendFollowUp(world); } finally { spy.mockRestore(); }
    expect(out.language).toBe('ar');
    expect(out.error).toBeInstanceOf(Error);
    expect(out.error.message).toBe('(#131047) Re-engagement message');
    expect(transport.lastDryRuns()).toHaveLength(0);
  });

  test('the tree answer lists the entry, the follow-up and its Arabic state for the hub', async () => {
    const world = await followUpWorld();
    await save(world);
    await review(world, 1);
    const res = await A().get('/flows/tree');
    expect(res.status).toBe(200);
    const row = res.body.items.find((i) => i.flowId === String(world.flow._id));
    expect(row).toMatchObject({ messageSource: 'promotion', promotionName: 'Eid Sale', triggerType: 'inactive_customer' });
    expect(row.nodes.map((n) => [n.messageNodeId, n.isEntry, n.depth])).toEqual([[String(world.entry._id), true, 0], [String(world.followUp._id), false, 1]]);
    const [entry, followUp] = row.nodes;
    expect(entry.versions.map((v) => v.language)).toEqual(['en', 'ar']);
    expect(entry.versions[1]).toMatchObject({ metaStatus: 'APPROVED', reviewStatus: 'reviewed', sendable: true });
    expect(followUp.parentNodeId).toBe(String(world.entry._id));
    expect(followUp.parentButtonPosition).toBe(0);
    expect(followUp.versions).toEqual([expect.objectContaining({ language: 'ar', metaStatus: 'NOT_REQUIRED', reviewStatus: 'reviewed', sendable: true, stale: false, contentVersion: 1 })]);
    const owner = await A().get(`/flows/owners/promotion/${world.promotion._id}/tree`);
    expect(owner.status).toBe(200);
    expect(owner.body.nodes).toHaveLength(2);
    expect((await ctx.api(ctx.B).get(`/flows/owners/promotion/${world.promotion._id}/tree`)).status).toBe(404);
  });

  test('a concurrent double save creates exactly one row (unique index) and both succeed', async () => {
    const world = await followUpWorld();
    const [one, two] = await Promise.all([save(world), save(world)]);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(await LocalizedFlowNode.countDocuments({ workspaceId: world.workspaceId, messageNodeId: world.followUp._id })).toBe(1);
  });
});
