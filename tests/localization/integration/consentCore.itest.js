const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for the consent core and the promotion consent tap:
// shared/consent.js (opt-in / opt-out / START, the unique inboundWamid index), shared/promoConsentTap.js (REAL models, two
// tenants) and shared/templateApproval.js (REAL Promotion queries). Only the outgoing WhatsApp text and the Graph status
// re-read are injected, so nothing leaves the machine. Nothing is ever deleted; every test makes its own workspaces.
const crypto = require('crypto');
const fx = require('./_fixtures');
const consent = require('../../../shared/consent');
const { handlePromoConsentTap } = require('../../../shared/promoConsentTap');
const approval = require('../../../shared/templateApproval');
const Customer = require('../../../models/Customer');
const ConsentEvent = require('../../../models/ConsentEvent');
const Promotion = require('../../../models/Promotion');
const MessageNode = require('../../../models/MessageNode');
const CampaignMessage = require('../../../models/CampaignMessage');

jest.setTimeout(60000);

beforeAll(async () => {
  await fx.connect();
  for (const M of [Promotion, MessageNode, CampaignMessage]) await M.init();
});
afterAll(async () => { await fx.disconnect(); });

let savedSig;
beforeEach(() => { savedSig = process.env.CONSENT_REQUIRE_SIGNATURE; delete process.env.CONSENT_REQUIRE_SIGNATURE; });
afterEach(() => { if (savedSig === undefined) delete process.env.CONSENT_REQUIRE_SIGNATURE; else process.env.CONSENT_REQUIRE_SIGNATURE = savedSig; });

const wid = () => `wamid.${crypto.randomBytes(8).toString('hex')}`;
const TS = String(Math.floor(Date.UTC(2026, 9, 26, 9, 0, 0) / 1000));
// A tap made now. A "Yes" stamped BEFORE the opt-out on record is a late (or repeated) delivery of an old tap and is ignored (outcome stale_tap),
// so a change of mind after an opt-out has to be stamped later than the opt-out.
const nowTs = () => String(Math.floor(Date.now() / 1000));

// One tenant with a consent-request promotion that was "sent" to one customer.
async function tenant({ merchantName = 'Aroma Cafe', phone, consentFields = {}, withSendRequest = false } = {}) {
  const ws = await fx.makeWorkspace({ arabic: false, merchantName });
  const customer = await fx.makeCustomer(ws.workspaceId, { phone: phone || fx.nextPhone(), marketingConsent: false, firstname: 'Sara', ...consentFields });
  const promotion = await Promotion.create({
    workspaceId: ws.workspaceId, name: `Opt in ${fx.uniq()}`, scope: 'products', customerType: 'cash', status: 'active',
    purpose: 'consent_request', campaignType: 'consent_request',
    ...(withSendRequest ? { sendRequest: { customerIds: [customer._id], requestedAt: new Date() } } : {}),
  });
  const node = await MessageNode.create({
    workspaceId: ws.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true,
    bodyText: 'Hi {{1}}, want offers from us on WhatsApp? Reply STOP any time.', templateName: `waflow_flow_${fx.uniq()}`,
    templateStatus: 'approved', templateVersion: 1,
    templateSnapshot: { bodyText: 'Hi {{1}}, want offers from us on WhatsApp? Reply STOP any time.', footer: 'Reply STOP to unsubscribe', language: 'en', buttons: [] },
    buttons: [
      { position: 0, label: 'Yes, send me offers', nextAction: { type: 'opt_in', replyText: 'Welcome aboard!' } },
      { position: 1, label: 'No thanks', nextAction: { type: 'opt_out' } },
      { position: 2, label: 'Tell me more', nextAction: { type: 'interested' } },
    ],
  });
  await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: node._id } });
  const wamid = wid();
  const payload = (action, pos) => `promo:${promotion._id}:${action}:${pos}`;
  const cm = await CampaignMessage.create({
    workspaceId: ws.workspaceId, kind: 'promotion', promotion: promotion._id, customer: customer._id, phone: customer.phone, wamid,
    messageType: 'template', templateName: node.templateName, status: 'delivered', messageNode: node._id,
    consentSnapshot: {
      promotionName: promotion.name, purpose: 'consent_request', templateName: node.templateName, templateVersion: 1, language: 'en',
      bodyTemplate: node.bodyText, renderedBody: 'Hi Sara, want offers from us on WhatsApp? Reply STOP any time.', footer: 'Reply STOP to unsubscribe',
      buttons: [
        { position: 0, label: 'Yes, send me offers', action: 'opt_in', payload: payload('opt_in', 0) },
        { position: 1, label: 'No thanks', action: 'opt_out', payload: payload('opt_out', 1) },
        { position: 2, label: 'Tell me more', action: 'interested', payload: payload('interested', 2) },
      ],
    },
  });
  const sent = [];
  const deps = { sendText: async (to, body, opts) => { sent.push({ to, body, opts }); }, log: () => {} };
  const tapMsg = (action, pos, text, over = {}) => ({
    id: wid(), from: String(customer.phone).replace(/\D/g, ''), timestamp: TS, type: 'button',
    context: { id: wamid }, button: { payload: payload(action, pos), text }, ...over,
  });
  const press = (message, extra = {}) => handlePromoConsentTap({ from: String(customer.phone).replace(/\D/g, ''), message, signature: 'valid', deps, ...extra });
  return { ws, workspaceId: ws.workspaceId, customer, promotion, node, cm, wamid, sent, deps, tapMsg, press, payload };
}
const reload = (c) => Customer.findById(c._id).lean();
const events = (c) => ConsentEvent.find({ customerId: c._id }).sort({ createdAt: 1, _id: 1 }).lean();

describe('consent core on the real database', () => {
  test('START after an opt-out is a fresh opt-in; a bare START from a never-asked customer changes nothing', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const out = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    await consent.withdrawMarketingConsent({ customer: out, method: 'whatsapp_optout_button', source: 'promo button', workspaceId: ws.workspaceId });
    const doc = await Customer.findById(out._id);
    expect(await consent.reinstateMarketingConsent({ customer: doc, method: 'whatsapp_start_command', source: 'x', workspaceId: ws.workspaceId })).toBe(true);
    const after = await reload(out);
    expect(after).toMatchObject({ marketingConsent: true, optedOut: false, marketingConsentMethod: 'whatsapp_button' });
    expect((await events(out)).map((e) => [e.type, e.method, e.source])).toEqual([
      ['consent_withdrawn', 'whatsapp_optout_button', 'promo button'],
      ['consent_given', 'whatsapp_start_command', 'START after opt-out'],
    ]);

    const never = await Customer.findById((await fx.makeCustomer(ws.workspaceId, { marketingConsent: false }))._id);
    expect(await consent.reinstateMarketingConsent({ customer: never, method: 'whatsapp_start_command', source: 'x', workspaceId: ws.workspaceId })).toBe(false);
    expect(await events(never)).toHaveLength(0);
    expect((await reload(never)).marketingConsent).toBe(false);
  });

  test('a staff grant does not clear an opt-out; a customer-initiated opt-in does', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false, optedOut: true, optedOutAt: new Date() });
    await consent.grantMarketingConsent({ customer: await Customer.findById(c._id), method: 'manual_staff_entry', source: 'Add Customer form', workspaceId: ws.workspaceId });
    expect(await reload(c)).toMatchObject({ marketingConsent: true, optedOut: true });
    await consent.recordCustomerOptIn({ customer: await Customer.findById(c._id), method: 'whatsapp_button', source: 'tap', workspaceId: ws.workspaceId });
    const after = await reload(c);
    expect(after.optedOut).toBe(false);
    expect(after.optedOutAt).toBeNull();
    expect(consent.canSendMarketing(after)).toBe(true);
  });

  test('the unique sparse index: a repeated inboundWamid is a duplicate, events WITHOUT one never collide', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    const doc = () => Customer.findById(c._id);
    const wamid = wid();
    const first = await consent.recordCustomerOptIn({ customer: await doc(), method: 'whatsapp_button', source: 's', workspaceId: ws.workspaceId, evidence: { inboundWamid: wamid } });
    const second = await consent.recordCustomerOptIn({ customer: await doc(), method: 'whatsapp_button', source: 's', workspaceId: ws.workspaceId, evidence: { inboundWamid: wamid } });
    expect([first.duplicate, second.duplicate]).toEqual([false, true]);
    // three events with no inbound id at all (staff / typed paths) are fine under a sparse index
    for (let i = 0; i < 3; i += 1) await consent.declineMarketingConsent({ customer: await doc(), method: 'whatsapp_button', source: 'typed', workspaceId: ws.workspaceId });
    expect(await events(c)).toHaveLength(4);
    const raw = await ConsentEvent.collection.findOne({ customerId: c._id, type: 'consent_declined' });
    expect(Object.keys(raw)).not.toContain('inboundWamid');
  });

  test('a late redelivery of an old opt-in never undoes a later opt-out', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId, { marketingConsent: false });
    const yes = wid();
    await consent.recordCustomerOptIn({ customer: await Customer.findById(c._id), method: 'whatsapp_button', source: 's', workspaceId: ws.workspaceId, evidence: { inboundWamid: yes } });
    await consent.withdrawMarketingConsent({ customer: await Customer.findById(c._id), method: 'whatsapp_optout_button', source: 's', workspaceId: ws.workspaceId, evidence: { inboundWamid: wid() } });
    const redelivered = await consent.recordCustomerOptIn({ customer: await Customer.findById(c._id), method: 'whatsapp_button', source: 's', workspaceId: ws.workspaceId, evidence: { inboundWamid: yes } });
    expect(redelivered.duplicate).toBe(true);
    const after = await reload(c);
    expect(after.optedOut).toBe(true);
    expect(consent.canSendMarketing(after)).toBe(false);
    expect(await events(c)).toHaveLength(2);
  });
});

describe('promotion consent taps (real models, two tenants)', () => {
  test('opt-in stores the evidence on the tapper\'s own tenant and leaves the same phone in another tenant alone', async () => {
    const phone = fx.nextPhone();
    const a = await tenant({ phone, merchantName: 'Tenant A Cafe' });
    const b = await tenant({ phone, merchantName: 'MegaSun' });
    const msg = b.tapMsg('opt_in', 0, 'Yes, send me offers');
    const out = await b.press(msg);
    expect(out).toMatchObject({ handled: true, outcome: 'opted_in', workspaceId: String(b.workspaceId) });

    expect(await reload(b.customer)).toMatchObject({ marketingConsent: true, optedOut: false, marketingConsentMethod: 'whatsapp_button' });
    expect(await reload(a.customer)).toMatchObject({ marketingConsent: false });
    expect(await events(a.customer)).toHaveLength(0);

    const [ev] = await events(b.customer);
    expect(ev).toMatchObject({
      type: 'consent_given', method: 'whatsapp_button', phone: b.customer.phone,
      promotionId: b.promotion._id, promotionName: b.promotion.name,
      messageText: 'Hi Sara, want offers from us on WhatsApp? Reply STOP any time.',
      buttonLabel: 'Yes, send me offers', buttonPosition: 0, buttonAction: 'opt_in',
      templateName: b.node.templateName, templateVersion: 1, sourceWamid: b.wamid, inboundWamid: msg.id, signature: 'valid',
    });
    expect(String(ev.workspaceId)).toBe(String(b.workspaceId));
    expect(ev.tappedAt).toEqual(new Date(Number(TS) * 1000));
    expect(ev.receivedAt).toBeInstanceOf(Date);

    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]).toMatchObject({ body: 'Welcome aboard!', opts: { workspaceId: String(b.workspaceId) } }); // the merchant's own confirmation
    expect(a.sent).toHaveLength(0);

    const cm = await CampaignMessage.findById(b.cm._id).lean();
    expect(cm).toMatchObject({ clickedButtonAction: 'opt_in', clickedButtonPosition: 0, lastTapWamid: msg.id });
    expect(cm.clickedAt).toBeInstanceOf(Date);
    expect(cm.respondedAt).toBeInstanceOf(Date);
  });

  test('a redelivered tap records one event and sends one reply', async () => {
    const t = await tenant();
    const msg = t.tapMsg('opt_in', 0, 'Yes, send me offers');
    expect((await t.press(msg)).outcome).toBe('opted_in');
    expect(await t.press(msg)).toMatchObject({ outcome: 'duplicate', duplicate: true });
    expect(await events(t.customer)).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
    expect((await reload(t.customer)).marketingConsent).toBe(true);
  });

  test('opt in, opt out, opt in again: latest action wins, the full history stays, and a late redelivery changes nothing', async () => {
    const t = await tenant();
    const yes1 = t.tapMsg('opt_in', 0, 'Yes, send me offers');
    await t.press(yes1);
    const no = t.tapMsg('opt_out', 1, 'No thanks');
    expect((await t.press(no)).outcome).toBe('opted_out');
    let c = await reload(t.customer);
    expect(consent.deriveConsentStatus(c)).toBe('opted_out');
    expect(t.sent.map((s) => s.body)).toEqual(['Welcome aboard!', "No problem, Sara. We won't send you any more offers. Reply START if you change your mind."]);

    await t.press(yes1); // Meta redelivers the first tap late
    c = await reload(t.customer);
    expect(consent.deriveConsentStatus(c)).toBe('opted_out'); // still out
    expect(t.sent).toHaveLength(2); // and no third message

    const late = await t.press(t.tapMsg('opt_in', 0, 'Yes, send me offers')); // a different message id, but stamped BEFORE the opt-out: not a change of mind
    expect(late.outcome).toBe('stale_tap');
    expect(consent.deriveConsentStatus(await reload(t.customer))).toBe('opted_out');
    const yes2 = t.tapMsg('opt_in', 0, 'Yes, send me offers', { timestamp: nowTs() });
    expect((await t.press(yes2)).outcome).toBe('opted_in');
    c = await reload(t.customer);
    expect(consent.deriveConsentStatus(c)).toBe('opted_in');
    expect(c.optedOut).toBe(false);
    expect((await events(t.customer)).map((e) => [e.type, e.method, e.buttonAction])).toEqual([
      ['consent_given', 'whatsapp_button', 'opt_in'],
      ['consent_withdrawn', 'whatsapp_optout_button', 'opt_out'],
      ['consent_given', 'whatsapp_button', 'opt_in'],
    ]);
  });

  test('a tap from a different phone changes nothing', async () => {
    const t = await tenant();
    const out = await handlePromoConsentTap({ from: '61400000000', message: t.tapMsg('opt_in', 0, 'Yes', { from: '61400000000' }), signature: 'valid', deps: t.deps });
    expect(out).toMatchObject({ handled: false, outcome: 'phone_mismatch' });
    expect(await events(t.customer)).toHaveLength(0);
    expect((await reload(t.customer)).marketingConsent).toBe(false);
    expect(t.sent).toHaveLength(0);
  });

  test('a till-captured local-format number still owns its tap (stored 05..., WhatsApp says 9665...)', async () => {
    const t = await tenant({ phone: '0501234567' });
    const out = await handlePromoConsentTap({ from: '966501234567', message: t.tapMsg('opt_in', 0, 'Yes', { from: '966501234567' }), signature: 'valid', deps: t.deps });
    expect(out.outcome).toBe('opted_in');
  });

  test('unknown wamid, wrong promotion and an erased customer are refused', async () => {
    const t = await tenant();
    const other = await tenant();
    // an unknown context id still finds the latest message sent to that phone for that promotion (the documented fallback)...
    expect((await t.press(t.tapMsg('opt_in', 0, 'Yes', { context: { id: 'wamid.NOPE' } }))).outcome).toBe('opted_in');
    // ...but nobody who was never sent that promotion can use it
    const stranger = other.customer.phone;
    expect((await handlePromoConsentTap({ from: stranger, message: t.tapMsg('opt_in', 0, 'Yes', { from: stranger, context: { id: 'wamid.NOPE' } }), signature: 'valid', deps: t.deps })).outcome).toBe('unknown_message');
    // the payload names the other tenant's promotion but the tapped message is ours
    expect((await t.press(t.tapMsg('opt_in', 0, 'Yes', { button: { payload: other.payload('opt_in', 0), text: 'Yes' } }))).outcome).toBe('promotion_mismatch');
    await Customer.updateOne({ _id: t.customer._id }, { $set: { deletedAt: new Date() } });
    expect((await t.press(t.tapMsg('opt_in', 0, 'Yes'))).outcome).toBe('customer_erased');
    expect(await events(t.customer)).toHaveLength(1); // only the fallback tap above, none after the erasure
    expect(await events(other.customer)).toHaveLength(0);
  });

  test('CONSENT_REQUIRE_SIGNATURE=on: an unverified opt-in is not applied, an unverified opt-out is', async () => {
    process.env.CONSENT_REQUIRE_SIGNATURE = 'on';
    const t = await tenant();
    expect((await t.press(t.tapMsg('opt_in', 0, 'Yes'), { signature: 'invalid' })).outcome).toBe('signature_required');
    expect((await reload(t.customer)).marketingConsent).toBe(false);
    expect(await events(t.customer)).toHaveLength(0);
    expect((await t.press(t.tapMsg('opt_out', 1, 'No thanks'), { signature: 'missing' })).outcome).toBe('opted_out');
    expect((await reload(t.customer)).optedOut).toBe(true);
    expect((await t.press(t.tapMsg('opt_in', 0, 'Yes', { timestamp: nowTs() }), { signature: 'valid' })).outcome).toBe('opted_in');
    expect((await events(t.customer)).map((e) => e.signature)).toEqual(['missing', 'valid']);
  });

  test('opt-out also opts out a second record of the same number in the same workspace', async () => {
    const t = await tenant({ phone: '966501110001' });
    const sibling = await fx.makeCustomer(t.workspaceId, { phone: '+966 50 111 0001', marketingConsent: true });
    await t.press(t.tapMsg('opt_out', 1, 'No thanks'));
    expect((await reload(sibling)).optedOut).toBe(true);
  });

  test('"interested" records the tap and flags the conversation open; it is not consent; a redelivery does nothing twice', async () => {
    const t = await tenant();
    await Customer.updateOne({ _id: t.customer._id }, { $set: { conversationStatus: 'resolved' } });
    const calls = [];
    const deps = { ...t.deps, handlePromoInterest: async (...args) => { calls.push(args); } };
    await Promotion.updateOne({ _id: t.promotion._id }, { $set: { type: 'store_wide' } });
    const msg = t.tapMsg('interested', 2, 'Tell me more');
    const press = () => handlePromoConsentTap({ from: String(t.customer.phone).replace(/\D/g, ''), message: msg, signature: 'valid', deps });
    expect((await press()).outcome).toBe('interested');
    expect((await press()).outcome).toBe('duplicate');
    expect(calls).toHaveLength(1);
    expect(String(calls[0][3])).toBe(String(t.workspaceId));
    const c = await reload(t.customer);
    expect(c).toMatchObject({ conversationStatus: 'open', marketingConsent: false });
    expect(await events(t.customer)).toHaveLength(0);
    expect((await CampaignMessage.findById(t.cm._id).lean()).clickedButtonAction).toBe('interested');
  });
});

describe('what is stored on documents that do not use the new features', () => {
  test('a plain CampaignMessage / Promotion / MessageNode carries none of the new keys in the database', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const c = await fx.makeCustomer(ws.workspaceId);
    const promo = await Promotion.create({ workspaceId: ws.workspaceId, name: 'Plain', scope: 'products' });
    const cm = await CampaignMessage.create({ workspaceId: ws.workspaceId, customer: c._id, phone: c.phone, promotion: promo._id, wamid: wid() });
    const node = await MessageNode.create({ workspaceId: ws.workspaceId, ownerType: 'promotion', ownerId: promo._id, isEntryNode: true, bodyText: 'b', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }] });
    const rawCm = await CampaignMessage.collection.findOne({ _id: cm._id });
    const rawPromo = await Promotion.collection.findOne({ _id: promo._id });
    const rawNode = await MessageNode.collection.findOne({ _id: node._id });
    expect(Object.keys(rawCm)).not.toEqual(expect.arrayContaining(['consentSnapshot']));
    expect(Object.keys(rawCm)).not.toContain('clickedButtonAction');
    expect(Object.keys(rawPromo)).not.toContain('sendRequest');
    expect(Object.keys(rawPromo)).not.toContain('consentWordingAck');
    expect(rawPromo.purpose).toBe('standard');
    expect(Object.keys(rawNode)).not.toContain('templateSnapshot');
    expect(rawNode.buttons[0].nextAction).toEqual({ type: 'end_flow' });
  });

  test('an existing promotion document written before the change reads as purpose standard', async () => {
    const ws = await fx.makeWorkspace({ arabic: false });
    const raw = await Promotion.collection.insertOne({ workspaceId: ws.workspaceId, name: 'Legacy', scope: 'products', status: 'active', customerType: 'cash', sentCount: 3 });
    const p = await Promotion.findById(raw.insertedId);
    expect(p.purpose).toBe('standard');
    expect(p.sendRequest).toBeUndefined();
  });
});

describe('template approval on the real database', () => {
  const fresh = (id) => Promotion.findById(id).lean();

  test('markApprovedNotice raises the notice only for this workspace\'s undismissed, not-yet-announced requests on this node', async () => {
    const a = await tenant({ withSendRequest: true });
    const b = await tenant({ withSendRequest: true });
    const dismissed = await Promotion.create({
      workspaceId: a.workspaceId, name: 'Dismissed', scope: 'products', entryNodeId: a.node._id,
      sendRequest: { customerIds: [], requestedAt: new Date(), dismissedAt: new Date() },
    });
    const noRequest = await Promotion.create({ workspaceId: a.workspaceId, name: 'No request', scope: 'products', entryNodeId: a.node._id });
    const crossTenant = await Promotion.create({
      workspaceId: b.workspaceId, name: 'Same node id, other tenant (impossible but guarded)', scope: 'products', entryNodeId: a.node._id,
      sendRequest: { customerIds: [], requestedAt: new Date() },
    });

    const res = await approval.markApprovedNotice(a.node);
    expect(res.modified).toBe(1);
    expect((await fresh(a.promotion._id)).sendRequest.approvedNoticeAt).toBeInstanceOf(Date);
    expect((await fresh(dismissed._id)).sendRequest.approvedNoticeAt).toBeUndefined();
    expect((await fresh(noRequest._id)).sendRequest).toBeUndefined();
    expect((await fresh(crossTenant._id)).sendRequest.approvedNoticeAt).toBeUndefined();
    expect((await fresh(b.promotion._id)).sendRequest.approvedNoticeAt).toBeUndefined();

    const again = await approval.markApprovedNotice(a.node); // idempotent
    expect(again.modified).toBe(0);
  });

  test('sweep: a pending node that Graph now reports approved gets its approval stamped and the notice raised', async () => {
    const t = await tenant({ withSendRequest: true });
    await MessageNode.updateOne({ _id: t.node._id }, { $set: { templateStatus: 'pending' } });
    const seen = [];
    const refreshNode = async (node) => {
      seen.push(String(node.workspaceId));
      await MessageNode.updateOne({ _id: node._id }, { $set: { templateStatus: 'approved' } });
      return MessageNode.findById(node._id).lean();
    };
    const out = await approval.sweep({ refreshNode, log: () => {} });
    expect(out.approved).toBeGreaterThanOrEqual(1);
    expect(seen).toContain(String(t.workspaceId));
    const node = await MessageNode.findById(t.node._id).lean();
    expect(node.templateStatus).toBe('approved');
    expect(node.templateApprovedAt).toBeInstanceOf(Date);
    expect((await fresh(t.promotion._id)).sendRequest.approvedNoticeAt).toBeInstanceOf(Date);
  });

  test('handleTemplateStatusEvent re-reads the status instead of trusting the payload', async () => {
    const t = await tenant({ withSendRequest: true });
    await MessageNode.updateOne({ _id: t.node._id }, { $set: { templateStatus: 'pending' } });
    const refreshNode = async () => MessageNode.findById(t.node._id).lean(); // Graph still says pending
    const event = { value: { event: 'APPROVED', message_template_name: t.node.templateName } };
    const out = await approval.handleTemplateStatusEvent(event, { refreshNode, log: () => {} });
    expect(out.handled).toBe(true);
    expect((await MessageNode.findById(t.node._id).lean()).templateStatus).toBe('pending');
    expect((await fresh(t.promotion._id)).sendRequest.approvedNoticeAt).toBeUndefined();

    // now Graph agrees
    const approve = async () => { await MessageNode.updateOne({ _id: t.node._id }, { $set: { templateStatus: 'approved' } }); return MessageNode.findById(t.node._id).lean(); };
    const out2 = await approval.handleTemplateStatusEvent(event, { refreshNode: approve, log: () => {} });
    expect(out2.results[0]).toMatchObject({ from: 'pending', to: 'approved' });
    expect((await fresh(t.promotion._id)).sendRequest.approvedNoticeAt).toBeInstanceOf(Date);
  });
});
