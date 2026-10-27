'use strict';
// Unit tests for the promotion / consent-request operations in shared/operations.js (DESIGN 7.3): button validation, the
// template pre-checks and versioned names, the status reset after an edit, the approval gate (block, auto-submit, send
// request, kill switch), the audience rules of a consent request, tap payloads, the consent snapshot, the report maths and
// the consent-log CSV. No database and no network: every model the operations touch is mocked, and so is utils/whatsapp
// (nothing here can reach Meta). The DB-backed end-to-end version is localization/integration/consentPromo.itest.js.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy_not_real';

jest.mock('../utils/whatsapp', () => ({
  createTemplate: jest.fn(), getTemplate: jest.fn(), getWabaId: jest.fn(), sendCustomFlowTemplate: jest.fn(), waPost: jest.fn(),
  sendPromoAnnouncement: jest.fn(), sendPointsPromoMessage: jest.fn(), sendPromoTemplate: jest.fn(),
  buildPromoAnnouncementPayload: jest.fn(), buildPointsPromoPayload: jest.fn(),
  PROMO_TEMPLATE: 'waflow_promo_v2',
}));
jest.mock('../utils/waTenant', () => ({ resolveCurrent: jest.fn() }));
jest.mock('../utils/settingsCache', () => ({ getCurrency: jest.fn(async () => 'SAR'), invalidate: jest.fn() }));
jest.mock('../shared/localization/legacySenders', () => ({ begin: jest.fn(async () => null) }));
jest.mock('../shared/templateApproval', () => ({ markApprovedNotice: jest.fn(async () => ({ matched: 0, modified: 0 })) }));
jest.mock('../models/WhatsAppMessage', () => ({ distinct: jest.fn(async () => []) }));
jest.mock('../models/Customer', () => ({ find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/Promotion', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), updateOne: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() }));
jest.mock('../models/CampaignMessage', () => ({ create: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), find: jest.fn() }));
jest.mock('../models/MessageNode', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn(), create: jest.fn() }));
jest.mock('../models/ConsentEvent', () => ({ find: jest.fn(), distinct: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Order', () => ({ aggregate: jest.fn(), create: jest.fn() }));

const { Types } = require('mongoose');
const wa = require('../utils/whatsapp');
const waTenant = require('../utils/waTenant');
const templateApproval = require('../shared/templateApproval');
const Customer = require('../models/Customer');
const Promotion = require('../models/Promotion');
const CampaignMessage = require('../models/CampaignMessage');
const MessageNode = require('../models/MessageNode');
const ConsentEvent = require('../models/ConsentEvent');
const Order = require('../models/Order');
const ops = require('../shared/operations');

const WS = new Types.ObjectId();
const OTHER_WS = new Types.ObjectId();
const USER = String(new Types.ObjectId());
const DAY = 86400000;

// A mongoose-like query: chainable, awaitable, .lean() resolves too.
function query(result) {
  const q = {};
  for (const m of ['populate', 'select', 'sort', 'skip', 'limit']) q[m] = jest.fn(() => q);
  q.lean = jest.fn(async () => result);
  q.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return q;
}

let savedEnv;
beforeEach(() => {
  savedEnv = { f: process.env.PROMO_ENTRY_FALLBACK, c: process.env.CONSENT_ASK_COOLDOWN_DAYS, d: process.env.PROMO_DELIVERY_FIX };
  delete process.env.PROMO_ENTRY_FALLBACK; delete process.env.CONSENT_ASK_COOLDOWN_DAYS; delete process.env.PROMO_DELIVERY_FIX;
  for (const m of [wa.createTemplate, wa.getTemplate, wa.getWabaId, wa.sendCustomFlowTemplate, waTenant.resolveCurrent, templateApproval.markApprovedNotice,
    Customer.find, Customer.findOne, Customer.updateOne, Customer.findOneAndUpdate, Promotion.find, Promotion.findOne, Promotion.findById, Promotion.updateOne, Promotion.findOneAndUpdate, Promotion.create,
    CampaignMessage.create, CampaignMessage.aggregate, MessageNode.find, MessageNode.findOne, MessageNode.findById, MessageNode.findOneAndUpdate,
    ConsentEvent.find, ConsentEvent.distinct, ConsentEvent.aggregate, ConsentEvent.countDocuments, Customer.countDocuments, Customer.aggregate, Order.aggregate]) m.mockReset();
  Order.aggregate.mockResolvedValue([]);
  ConsentEvent.aggregate.mockResolvedValue([]);
  wa.createTemplate.mockResolvedValue({ id: 'tpl1' });
  wa.getWabaId.mockResolvedValue('PLATFORM_WABA');
  wa.sendCustomFlowTemplate.mockImplementation(async () => ({ messages: [{ id: `wamid.${Math.random().toString(36).slice(2)}` }] }));
  waTenant.resolveCurrent.mockResolvedValue({ wabaId: 'WABA_A' });
  templateApproval.markApprovedNotice.mockResolvedValue({ matched: 0, modified: 0 });
  // the atomic claim of a customer for a consent request (findOneAndUpdate returns the customer as it was BEFORE, null = lost the claim)
  // succeeds unless a test says otherwise; giving it back after a failed send is an updateOne
  Customer.findOneAndUpdate.mockImplementation(async () => ({}));
  Customer.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Promotion.updateOne.mockResolvedValue({});
  CampaignMessage.create.mockResolvedValue({});
});
afterEach(() => {
  for (const [k, v] of [['PROMO_ENTRY_FALLBACK', savedEnv.f], ['CONSENT_ASK_COOLDOWN_DAYS', savedEnv.c], ['PROMO_DELIVERY_FIX', savedEnv.d]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const button = (position, label, type = 'end_flow', extra = {}) => ({ position, label, nextAction: { type, ...extra } });
function makeNode(over = {}) {
  const node = {
    _id: new Types.ObjectId(), workspaceId: WS, ownerType: 'promotion', ownerId: new Types.ObjectId(), isEntryNode: true,
    bodyText: 'Hi {{1}}, want offers from us on WhatsApp? Tap below, you can stop any time.',
    templateStatus: 'not_created', buttons: [button(0, 'Yes, send me offers', 'opt_in'), button(1, 'No thanks', 'opt_out')],
    save: jest.fn(async function save() { return this; }),
    ...over,
  };
  return node;
}
function makePromotion(over = {}) {
  return {
    _id: new Types.ObjectId(), workspaceId: WS, name: 'Opt in', purpose: 'consent_request', customerType: 'cash', scope: 'products',
    products: [{ name: 'Beans', basePrice: 10, category: 'Coffee' }], services: [], discountPercent: 0, isDemo: false, ...over,
  };
}
const makeCustomer = (over = {}) => ({ _id: new Types.ObjectId(), workspaceId: WS, firstname: 'Sara', lastname: 'T', phone: `9665${Math.floor(Math.random() * 1e8)}`, marketingConsent: false, ...over });

// ─── button validation ───────────────────────────────────────────────────────

describe('validateButtons', () => {
  const L = (n) => 'x'.repeat(n);
  test('entry message: 25 characters allowed, 26 refused; follow-up: 20 allowed, 21 refused', () => {
    expect(() => ops.validateButtons([button(0, L(25))], { isEntryNode: true })).not.toThrow();
    expect(() => ops.validateButtons([button(0, L(26))], { isEntryNode: true })).toThrow('exceeds 25 characters');
    expect(() => ops.validateButtons([button(0, L(20))])).not.toThrow();
    expect(() => ops.validateButtons([button(0, L(21))])).toThrow('exceeds 20 characters');
  });
  test('at most 3 buttons, on either kind of message', () => {
    const four = [0, 1, 2, 3].map(i => button(i, `B${i}`));
    expect(() => ops.validateButtons(four, { isEntryNode: true })).toThrow('at most 3 buttons');
    expect(() => ops.validateButtons(four)).toThrow('at most 3 buttons');
  });
  test('consent actions only on a promotion entry message, with a plain-language error elsewhere', () => {
    for (const t of ['opt_in', 'opt_out', 'interested']) {
      expect(() => ops.validateButtons([button(0, 'Yes', t)], { isEntryNode: true, ownerType: 'promotion' })).not.toThrow();
      expect(() => ops.validateButtons([button(0, 'Yes', t)], { isEntryNode: false, ownerType: 'promotion' })).toThrow(/first message of a promotion/);
      expect(() => ops.validateButtons([button(0, 'Yes', t)], { isEntryNode: true, ownerType: 'flow' })).toThrow(/first message of a promotion/);
      expect(() => ops.validateButtons([button(0, 'Yes', t)])).toThrow(/first message of a promotion/);
    }
  });
  test('"None" (end_flow), follow-up and discount actions are not consent actions', () => {
    expect(() => ops.validateButtons([button(0, 'Ok', 'end_flow'), button(1, 'Go', 'send_message'), button(2, 'Disc', 'apply_discount')])).not.toThrow();
  });
  test('non-array input is ignored (as before)', () => {
    expect(() => ops.validateButtons(undefined)).not.toThrow();
  });
});

// ─── template pre-checks ─────────────────────────────────────────────────────

describe('validateTemplateSubmission', () => {
  const ok = () => makeNode();
  test('a well-formed consent message passes', () => {
    expect(ops.validateTemplateSubmission(ok(), { promotion: { purpose: 'consent_request' } })).toEqual([]);
  });
  test('the suggested bodies of the owner pass (the name is mid-text, the text ends with words)', () => {
    for (const bodyText of [
      "Hi {{1}}, it's Aroma Cafe. This Ramadan, 20% off beans. Want first access to offers like this on WhatsApp? Tap below. We'll only message you with offers we think you'll like, and you can stop any time.",
      'Hi {{1}}, Aroma Cafe has 20% off beans. Tap "Yes, I\'m in" to get it, and to hear about future offers here on WhatsApp. Reply STOP any time to opt out.',
    ]) expect(ops.validateTemplateSubmission(makeNode({ bodyText }), { promotion: { purpose: 'consent_request' } })).toEqual([]);
  });
  test('empty text, too long, starts with a variable, ends with a variable', () => {
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: '   ' }))[0]).toMatch(/empty/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'a'.repeat(1025) })).join(' ')).toMatch(/too long \(1025/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'a'.repeat(1024) }))).toEqual([]);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: '{{1}} hello there' })).join(' ')).toMatch(/cannot start with a variable/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hello there {{1}}' })).join(' ')).toMatch(/cannot end with a variable/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: '  Hello there {{1}}  ' })).join(' ')).toMatch(/cannot end with a variable/);
  });
  test('variables must be numbered {{1}}.. in order with no gaps; a promotion message has four slots', () => {
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{name}}, hello' })).join(' ')).toMatch(/numbered like \{\{1\}\}/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{ 1 }}, hello' })).join(' ')).toMatch(/numbered like \{\{1\}\}/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{2}}, hello' })).join(' ')).toMatch(/in order starting at \{\{1\}\}/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{1}} and {{3}}, hello' })).join(' ')).toMatch(/in order starting at \{\{1\}\}/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{1}} {{2}} {{3}} {{4}}, hello' }))).toEqual([]);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{1}} {{2}} {{3}} {{4}} {{5}}, hello' })).join(' ')).toMatch(/\{\{1\}\} to \{\{4\}\} only/);
    expect(ops.validateTemplateSubmission(makeNode({ bodyText: 'Hi {{1}} and again {{1}}, hello' }))).toEqual([]);
  });
  test('button labels: at most 25 characters, at most 3 buttons, none empty, none repeated', () => {
    expect(ops.validateTemplateSubmission(makeNode({ buttons: [button(0, 'x'.repeat(26))] })).join(' ')).toMatch(/too long \(26/);
    expect(ops.validateTemplateSubmission(makeNode({ buttons: [button(0, 'x'.repeat(25))] }))).toEqual([]);
    expect(ops.validateTemplateSubmission(makeNode({ buttons: [0, 1, 2, 3].map(i => button(i, `B${i}`)) })).join(' ')).toMatch(/at most 3 buttons/);
    expect(ops.validateTemplateSubmission(makeNode({ buttons: [button(0, '  ')] })).join(' ')).toMatch(/no text/);
    expect(ops.validateTemplateSubmission(makeNode({ buttons: [button(0, 'Yes'), button(1, 'yes')] })).join(' ')).toMatch(/both called "yes"/);
  });
  test('a consent request needs an Opt in button; an ordinary promotion does not', () => {
    const noOptIn = makeNode({ buttons: [button(0, 'No thanks', 'opt_out')] });
    expect(ops.validateTemplateSubmission(noOptIn, { promotion: { purpose: 'consent_request' } }).join(' ')).toMatch(/needs an "Opt in" button/);
    expect(ops.validateTemplateSubmission(noOptIn, { promotion: { purpose: 'standard' } })).toEqual([]);
    expect(ops.validateTemplateSubmission(noOptIn)).toEqual([]);
  });
});

describe('template versions and names', () => {
  test('first submission is waflow_flow_<last 10 of the id>, later ones add _v<n>; only lowercase letters, digits, underscore', () => {
    const node = makeNode();
    const base = `waflow_flow_${String(node._id).slice(-10)}`;
    expect(ops.nextTemplateVersion(node)).toBe(1);
    expect(ops.templateNameFor(node, 1)).toBe(base);
    expect(ops.templateNameFor(node, 2)).toBe(`${base}_v2`);
    expect(ops.templateNameFor(node, 11)).toBe(`${base}_v11`);
    for (const v of [1, 2, 3, 10]) expect(ops.templateNameFor(node, v)).toMatch(/^[a-z0-9_]+$/);
  });
  test('a node that already has a name goes to the next version, also an older one with no version number and a timestamp name', () => {
    expect(ops.nextTemplateVersion(makeNode({ templateName: 'x', templateVersion: 1 }))).toBe(2);
    expect(ops.nextTemplateVersion(makeNode({ templateName: 'x', templateVersion: 4 }))).toBe(5);
    expect(ops.nextTemplateVersion(makeNode({ templateName: 'waflow_flow_abc_lf9a2' }))).toBe(2);
  });
});

// ─── status reset after an edit ──────────────────────────────────────────────

describe('updateMessageNode: an approved message goes back to "needs submitting" when what Meta reviewed changes', () => {
  const approved = (over = {}) => makeNode({ templateName: 'waflow_flow_abc', templateStatus: 'approved', templateVersion: 1, ...over });
  async function edit(existing, change) {
    MessageNode.findOne.mockResolvedValue(existing);
    MessageNode.find.mockResolvedValue([]);
    MessageNode.findOneAndUpdate.mockImplementation(async (_f, update) => ({ ...existing, ...update }));
    await ops.updateMessageNode({ id: existing._id, workspaceId: WS, ...change });
    return MessageNode.findOneAndUpdate.mock.calls[0][1];
  }
  test('changed text: status reset, name kept, approval time cleared', async () => {
    const update = await edit(approved(), { bodyText: 'Hi {{1}}, a different text, stop any time.' });
    expect(update.templateStatus).toBe('not_created');
    expect(update.$unset).toEqual({ templateApprovedAt: 1, templateRejectedReason: 1 });
    expect(update.templateName).toBeUndefined(); // the name stays: the next submission is the next version
  });
  test('changed button label, and a changed number of buttons: reset', async () => {
    const e = approved();
    expect((await edit(e, { buttons: [button(0, 'Yes please', 'opt_in'), button(1, 'No thanks', 'opt_out')] })).templateStatus).toBe('not_created');
    MessageNode.findOneAndUpdate.mockReset();
    expect((await edit(approved(), { buttons: [button(0, 'Yes, send me offers', 'opt_in')] })).templateStatus).toBe('not_created');
  });
  test('a rejected or pending message that is edited is reset too', async () => {
    expect((await edit(approved({ templateStatus: 'rejected' }), { bodyText: 'Changed text, stop any time.' })).templateStatus).toBe('not_created');
    MessageNode.findOneAndUpdate.mockReset();
    expect((await edit(approved({ templateStatus: 'pending' }), { bodyText: 'Changed text, stop any time.' })).templateStatus).toBe('not_created');
  });
  test('changing only an action or only a reply text does NOT reset', async () => {
    const e = approved();
    let update = await edit(e, { buttons: [button(0, 'Yes, send me offers', 'interested'), button(1, 'No thanks', 'opt_out')] });
    expect(update.templateStatus).toBeUndefined();
    expect(update.$unset).toBeUndefined();
    MessageNode.findOneAndUpdate.mockReset();
    update = await edit(approved(), { buttons: [button(0, 'Yes, send me offers', 'opt_in', { replyText: 'Welcome!' }), button(1, 'No thanks', 'opt_out')] });
    expect(update.templateStatus).toBeUndefined();
  });
  test('the same text and labels saved again does NOT reset', async () => {
    const e = approved();
    const update = await edit(e, { bodyText: e.bodyText, buttons: e.buttons });
    expect(update.templateStatus).toBeUndefined();
  });
  test('a message never submitted, or already needing submission, or not an entry message: no status write', async () => {
    for (const existing of [
      makeNode({ templateStatus: 'not_created' }),
      makeNode({ templateName: 'n', templateStatus: 'not_created' }),
      makeNode({ isEntryNode: false, templateName: 'n', templateStatus: 'approved' }),
      makeNode({ templateStatus: 'approved' }), // no name
    ]) {
      MessageNode.findOneAndUpdate.mockReset();
      const update = await edit(existing, { bodyText: 'Another text, stop any time.' });
      expect(update.templateStatus).toBeUndefined();
    }
  });
});

// ─── submit ──────────────────────────────────────────────────────────────────

describe('submitMessageNodeTemplate', () => {
  function withPromotion(promo) { Promotion.findById.mockReturnValue(query(promo)); }

  test('first submission: base name, MARKETING, footer + language, and everything stored (version, time, account, snapshot)', async () => {
    const node = makeNode({ buttons: [button(0, 'Yes, send me offers', 'opt_in', { replyText: 'Welcome!' }), button(1, 'No thanks', 'opt_out')] });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    const out = await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS });
    const name = `waflow_flow_${String(node._id).slice(-10)}`;
    expect(wa.createTemplate).toHaveBeenCalledTimes(1);
    expect(wa.createTemplate).toHaveBeenCalledWith(name, node.bodyText, 'MARKETING', ['Yes, send me offers', 'No thanks'], { footer: 'Reply STOP to unsubscribe', language: 'en' });
    expect(out.templateName).toBe(name);
    expect(out.templateStatus).toBe('pending');
    expect(out.templateVersion).toBe(1);
    expect(out.templateWabaId).toBe('WABA_A');
    expect(out.templateCategory).toBe('MARKETING');
    expect(out.templateSubmittedAt).toBeInstanceOf(Date);
    expect(out.templateSnapshot).toEqual({
      bodyText: node.bodyText, footer: 'Reply STOP to unsubscribe', language: 'en',
      buttons: [{ position: 0, label: 'Yes, send me offers', action: 'opt_in', replyText: 'Welcome!' }, { position: 1, label: 'No thanks', action: 'opt_out' }],
    });
    expect(node.save).toHaveBeenCalledTimes(1);
  });

  test('resubmission after an edit (status reset, name kept): the next version, a new name', async () => {
    const node = makeNode({ templateName: 'waflow_flow_old', templateStatus: 'not_created', templateVersion: 1, templateApprovedAt: new Date(), templateRejectedReason: 'x' });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    const out = await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS });
    expect(out.templateName).toBe(`waflow_flow_${String(node._id).slice(-10)}_v2`);
    expect(out.templateVersion).toBe(2);
    expect(out.templateStatus).toBe('pending');
    expect(out.templateApprovedAt).toBeUndefined();
    expect(out.templateRejectedReason).toBeUndefined();
  });

  test('a rejected message is submitted again as the next version', async () => {
    const node = makeNode({ templateName: 'n', templateStatus: 'rejected', templateVersion: 3 });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    const out = await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS });
    expect(out.templateVersion).toBe(4);
    expect(out.templateName).toMatch(/_v4$/);
  });

  test('already pending with exactly these words: nothing is sent again (no second template slot used)', async () => {
    const first = makeNode();
    MessageNode.findOne.mockResolvedValue(first);
    withPromotion({ purpose: 'consent_request' });
    await ops.submitMessageNodeTemplate({ nodeId: first._id, workspaceId: WS });
    wa.createTemplate.mockClear();
    const again = await ops.submitMessageNodeTemplate({ nodeId: first._id, workspaceId: WS });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(again.templateStatus).toBe('pending');
  });

  test('pre-validation failure is a structured 400 with the reasons, and nothing reaches Meta', async () => {
    const node = makeNode({ bodyText: 'Hello {{1}}', buttons: [button(0, 'x'.repeat(30), 'opt_in')] });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    await expect(ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS })).rejects.toMatchObject({
      code: 'TEMPLATE_INVALID', status: 400, reasons: expect.arrayContaining([expect.stringMatching(/cannot end with a variable/), expect.stringMatching(/too long/)]),
    });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(node.save).not.toHaveBeenCalled();
  });

  test('a consent request without an Opt in button is refused before anything is sent', async () => {
    const node = makeNode({ buttons: [button(0, 'No thanks', 'opt_out')] });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    await expect(ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS })).rejects.toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect(wa.createTemplate).not.toHaveBeenCalled();
  });

  test('a Meta failure leaves the node untouched (no version burned)', async () => {
    const node = makeNode({ templateName: 'n', templateStatus: 'not_created', templateVersion: 1 });
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    wa.createTemplate.mockRejectedValue(Object.assign(new Error('Request failed with status code 400'), { response: { data: { error: { message: 'Template name exists' } } } }));
    await expect(ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS })).rejects.toThrow('status code 400');
    expect(node.save).not.toHaveBeenCalled();
    expect(node.templateVersion).toBe(1);
    expect(node.templateStatus).toBe('not_created');
  });

  test('only entry messages have a template; an unknown or foreign message is "not found"', async () => {
    MessageNode.findOne.mockResolvedValue(makeNode({ isEntryNode: false }));
    await expect(ops.submitMessageNodeTemplate({ nodeId: new Types.ObjectId(), workspaceId: WS })).rejects.toThrow('Only entry nodes need a template.');
    MessageNode.findOne.mockResolvedValue(null);
    await expect(ops.submitMessageNodeTemplate({ nodeId: new Types.ObjectId(), workspaceId: OTHER_WS })).rejects.toThrow('MessageNode not found');
    // the lookup is scoped by the caller's workspace
    expect(MessageNode.findOne.mock.calls[1][0]).toMatchObject({ workspaceId: OTHER_WS });
  });

  test('two submissions of one message at the same moment share one Meta call', async () => {
    const node = makeNode();
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'consent_request' });
    const [a, b] = await Promise.all([
      ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS }),
      ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS }),
    ]);
    expect(wa.createTemplate).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  test('the account the message was submitted under is stored; when it cannot be told nothing is stamped', async () => {
    const node = makeNode();
    MessageNode.findOne.mockResolvedValue(node);
    withPromotion({ purpose: 'standard' });
    waTenant.resolveCurrent.mockRejectedValue(new Error('unavailable'));
    const out = await ops.submitMessageNodeTemplate({ nodeId: node._id, workspaceId: WS });
    expect(out.templateWabaId).toBeUndefined();
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe('refreshMessageNodeTemplateStatus', () => {
  const pending = (over = {}) => makeNode({ templateName: 'waflow_flow_x', templateStatus: 'pending', templateVersion: 1, ...over });

  test('looks the template up by NAME and stores category, check time and approval time; the approval notice is raised once', async () => {
    const node = pending();
    MessageNode.findOne.mockResolvedValue(node);
    wa.getTemplate.mockResolvedValue({ name: 'waflow_flow_x', status: 'APPROVED', category: 'MARKETING' });
    const out = await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS });
    expect(wa.getTemplate).toHaveBeenCalledWith('waflow_flow_x');
    expect(out.templateStatus).toBe('approved');
    expect(out.templateCategory).toBe('MARKETING');
    expect(out.templateApprovedAt).toBeInstanceOf(Date);
    expect(out.templateLastCheckedAt).toBeInstanceOf(Date);
    expect(templateApproval.markApprovedNotice).toHaveBeenCalledTimes(1);
    expect(templateApproval.markApprovedNotice).toHaveBeenCalledWith(node);
    // refreshing an already approved message again changes nothing and raises no second notice
    const approvedAt = out.templateApprovedAt;
    await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS });
    expect(templateApproval.markApprovedNotice).toHaveBeenCalledTimes(1);
    expect(node.templateApprovedAt).toBe(approvedAt);
  });

  test('statuses: PENDING and IN_APPEAL stay pending; REJECTED stores Meta\'s reason; PAUSED and DISABLED become rejected', async () => {
    const cases = [
      [{ status: 'PENDING' }, 'pending', undefined],
      [{ status: 'IN_APPEAL' }, 'pending', undefined],
      [{ status: 'REJECTED', rejected_reason: 'INVALID_FORMAT' }, 'rejected', /INVALID_FORMAT/],
      [{ status: 'REJECTED', rejected_reason: 'NONE' }, 'rejected', /did not approve this message\.$/],
      [{ status: 'PAUSED' }, 'rejected', /paused/],
      [{ status: 'DISABLED' }, 'rejected', /disabled/],
    ];
    for (const [tpl, status, reason] of cases) {
      const node = pending();
      MessageNode.findOne.mockResolvedValue(node);
      wa.getTemplate.mockResolvedValue({ name: 'waflow_flow_x', ...tpl });
      const out = await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS });
      expect(out.templateStatus).toBe(status);
      if (reason) expect(out.templateRejectedReason).toMatch(reason); else expect(out.templateRejectedReason).toBeUndefined();
    }
    expect(templateApproval.markApprovedNotice).not.toHaveBeenCalled();
  });

  test('an unknown status keeps the current one; a template Meta does not list changes nothing', async () => {
    const node = pending();
    MessageNode.findOne.mockResolvedValue(node);
    wa.getTemplate.mockResolvedValue({ status: 'SOMETHING_NEW' });
    expect((await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS })).templateStatus).toBe('pending');
    wa.getTemplate.mockResolvedValue(null);
    node.save.mockClear();
    await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS });
    expect(node.save).not.toHaveBeenCalled();
  });

  test('a message edited since it was submitted (needs submitting) is NOT refreshed from the old version\'s status', async () => {
    const node = pending({ templateStatus: 'not_created' });
    MessageNode.findOne.mockResolvedValue(node);
    wa.getTemplate.mockResolvedValue({ status: 'APPROVED' });
    const out = await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS });
    expect(wa.getTemplate).not.toHaveBeenCalled();
    expect(out.templateStatus).toBe('not_created');
  });

  test('a message never submitted has nothing to refresh', async () => {
    const node = makeNode();
    MessageNode.findOne.mockResolvedValue(node);
    expect((await ops.refreshMessageNodeTemplateStatus({ nodeId: node._id, workspaceId: WS })).templateStatus).toBe('not_created');
    expect(wa.getTemplate).not.toHaveBeenCalled();
  });
});

// ─── approval check against the sending account ──────────────────────────────

describe('resolveApprovedEntryNode', () => {
  const promo = (node) => ({ workspaceId: WS, entryNodeId: node._id });
  test('approved message: used; any other status: null; no entry message: null', async () => {
    const node = makeNode({ templateStatus: 'approved' });
    MessageNode.findById.mockResolvedValue(node);
    expect(await ops.resolveApprovedEntryNode(promo(node))).toBe(node);
    for (const s of ['pending', 'rejected', 'not_created']) {
      MessageNode.findById.mockResolvedValue(makeNode({ templateStatus: s }));
      expect(await ops.resolveApprovedEntryNode(promo(node))).toBeNull();
    }
    expect(await ops.resolveApprovedEntryNode({ workspaceId: WS })).toBeNull();
  });
  test('approved under ANOTHER WhatsApp account counts as not approved; the same account, or an older message with none recorded, is fine', async () => {
    const node = makeNode({ templateStatus: 'approved', templateWabaId: 'WABA_OLD' });
    MessageNode.findById.mockResolvedValue(node);
    expect(await ops.resolveApprovedEntryNode(promo(node))).toBeNull();
    waTenant.resolveCurrent.mockResolvedValue({ wabaId: 'WABA_OLD' });
    expect(await ops.resolveApprovedEntryNode(promo(node))).toBe(node);
    MessageNode.findById.mockResolvedValue(makeNode({ templateStatus: 'approved' }));
    waTenant.resolveCurrent.mockResolvedValue({ wabaId: 'ANY' });
    expect(await ops.resolveApprovedEntryNode(promo(node))).not.toBeNull();
  });
  test('when the sending account cannot be told, the stored approval is trusted (the send itself fails closed)', async () => {
    const node = makeNode({ templateStatus: 'approved', templateWabaId: 'WABA_OLD' });
    MessageNode.findById.mockResolvedValue(node);
    waTenant.resolveCurrent.mockRejectedValue(Object.assign(new Error('number unusable'), { code: 'WHATSAPP_NUMBER_UNAVAILABLE' }));
    expect(await ops.resolveApprovedEntryNode(promo(node))).toBe(node);
  });
  test('a message that belongs to another workspace is treated as missing', async () => {
    const node = makeNode({ templateStatus: 'approved', workspaceId: OTHER_WS });
    MessageNode.findById.mockResolvedValue(node);
    expect(await ops.resolveApprovedEntryNode(promo(node))).toBeNull();
  });
});

// ─── tap payloads ────────────────────────────────────────────────────────────

describe('buildEntryButtonPayloads', () => {
  const promotion = { _id: new Types.ObjectId() };
  test('consent actions carry promo:<promotion>:<action>:<position>; every other button keeps msgnode_<node>_<position>', () => {
    const node = makeNode({ buttons: [button(0, 'Yes', 'opt_in'), button(1, 'No', 'opt_out'), button(2, 'Tell me more', 'interested')] });
    expect(ops.buildEntryButtonPayloads(node, promotion)).toEqual([
      `promo:${promotion._id}:opt_in:0`, `promo:${promotion._id}:opt_out:1`, `promo:${promotion._id}:interested:2`,
    ]);
    const mixed = makeNode({ buttons: [button(0, 'Yes', 'opt_in'), button(1, 'Shop', 'end_flow'), button(2, 'More', 'send_message')] });
    expect(ops.buildEntryButtonPayloads(mixed, promotion)).toEqual([`promo:${promotion._id}:opt_in:0`, `msgnode_${mixed._id}_1`, `msgnode_${mixed._id}_2`]);
  });
  test('a test send uses the inert promotest: prefix for the consent actions only (so a test tap never writes consent)', () => {
    const node = makeNode({ buttons: [button(0, 'Yes', 'opt_in'), button(1, 'Shop', 'end_flow')] });
    expect(ops.buildEntryButtonPayloads(node, promotion, { test: true })).toEqual([`promotest:${promotion._id}:opt_in:0`, `msgnode_${node._id}_1`]);
  });
  test('a legacy entry message (no consent actions) is byte-identical to before', () => {
    const node = makeNode({ buttons: [button(0, 'Shop', 'end_flow'), button(1, 'Later', 'send_message')] });
    expect(ops.buildEntryButtonPayloads(node, promotion)).toEqual(node.buttons.map(b => `msgnode_${node._id}_${b.position}`));
  });
  test('payloads stay far below the 256 character limit', () => {
    const node = makeNode({ buttons: [button(2, 'Yes', 'interested')] });
    expect(ops.buildEntryButtonPayloads(node, promotion)[0].length).toBeLessThan(60);
  });
});

// ─── consent-request audience ────────────────────────────────────────────────

describe('splitConsentRequestAudience', () => {
  const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
  const promotion = { isDemo: false };
  test('only customers who have not opted in, are not opted out and were not asked within 7 days are asked', () => {
    const fresh = makeCustomer();
    const optedIn = makeCustomer({ marketingConsent: true });
    const optedOut = makeCustomer({ optedOut: true });
    const optedInThenOut = makeCustomer({ marketingConsent: true, optedOut: true });
    const erased = makeCustomer({ deletedAt: new Date() });
    const askedYesterday = makeCustomer({ marketingConsentAskedAt: new Date(NOW - 1 * DAY) });
    const askedLongAgo = makeCustomer({ marketingConsentAskedAt: new Date(NOW - 8 * DAY) });
    const out = ops.splitConsentRequestAudience([fresh, optedIn, optedOut, optedInThenOut, erased, askedYesterday, askedLongAgo], promotion, NOW);
    expect(out.eligible).toEqual([fresh, askedLongAgo]);
    expect(out.skippedOptedOut).toBe(3); // opted out, opted in then out, erased: never reached
    expect(out.skippedAlreadyOptedIn).toBe(1);
    expect(out.skippedAskedRecently).toBe(1);
  });
  test('the cooldown boundary: 6.9 days is still "recently", 7.1 days is not', () => {
    const a = makeCustomer({ marketingConsentAskedAt: new Date(NOW - 6.9 * DAY) });
    const b = makeCustomer({ marketingConsentAskedAt: new Date(NOW - 7.1 * DAY) });
    const out = ops.splitConsentRequestAudience([a, b], promotion, NOW);
    expect(out.eligible).toEqual([b]);
    expect(out.skippedAskedRecently).toBe(1);
  });
  test('CONSENT_ASK_COOLDOWN_DAYS: custom value, 0 = no cooldown, garbage or empty = the default 7', () => {
    const askedTwoDaysAgo = makeCustomer({ marketingConsentAskedAt: new Date(NOW - 2 * DAY) });
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '1';
    expect(ops.splitConsentRequestAudience([askedTwoDaysAgo], promotion, NOW).eligible).toHaveLength(1);
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '14';
    expect(ops.splitConsentRequestAudience([askedTwoDaysAgo], promotion, NOW).eligible).toHaveLength(0);
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '0';
    expect(ops.consentAskCooldownDays()).toBe(0);
    expect(ops.splitConsentRequestAudience([askedTwoDaysAgo], promotion, NOW).eligible).toHaveLength(1);
    for (const bad of ['', '  ', 'abc', '-3', 'NaN']) {
      process.env.CONSENT_ASK_COOLDOWN_DAYS = bad;
      expect(ops.consentAskCooldownDays()).toBe(7);
    }
  });
  test('demo data is exempt (nothing real is sent to it), whatever its consent state', () => {
    const demoCustomer = makeCustomer({ isDemo: true, optedOut: true });
    expect(ops.splitConsentRequestAudience([demoCustomer], promotion, NOW).eligible).toEqual([demoCustomer]);
    const real = makeCustomer({ optedOut: true });
    expect(ops.splitConsentRequestAudience([real], { isDemo: true }, NOW).eligible).toEqual([real]);
  });
  test('an empty request gives an empty split', () => {
    expect(ops.splitConsentRequestAudience([], promotion, NOW)).toEqual({ eligible: [], skippedOptedOut: 0, skippedAlreadyOptedIn: 0, skippedAskedRecently: 0 });
  });
});

// ─── consent snapshot ────────────────────────────────────────────────────────

describe('buildConsentSnapshot', () => {
  const promotion = { _id: new Types.ObjectId(), name: 'Opt in' };
  test('quotes the SUBMITTED text (not the live edit), rendered with this customer\'s values, with footer, version and every button', () => {
    const node = makeNode({
      bodyText: 'LIVE EDIT, not yet submitted', templateName: 'waflow_flow_x_v2', templateVersion: 2,
      templateSnapshot: { bodyText: 'Hi {{1}}, offers from us on WhatsApp? Stop any time.', footer: 'Reply STOP to unsubscribe', language: 'en',
        buttons: [{ position: 0, label: 'Yes, send me offers', action: 'opt_in' }, { position: 1, label: 'No thanks', action: 'opt_out' }] },
    });
    const payloads = ops.buildEntryButtonPayloads(node, promotion);
    const snap = ops.buildConsentSnapshot({ promotion, node, params: ['Sara'], payloads });
    expect(snap).toEqual({
      promotionName: 'Opt in', purpose: 'consent_request', templateName: 'waflow_flow_x_v2', templateVersion: 2, language: 'en',
      bodyTemplate: 'Hi {{1}}, offers from us on WhatsApp? Stop any time.', renderedBody: 'Hi Sara, offers from us on WhatsApp? Stop any time.',
      footer: 'Reply STOP to unsubscribe',
      buttons: [
        { position: 0, label: 'Yes, send me offers', action: 'opt_in', payload: `promo:${promotion._id}:opt_in:0` },
        { position: 1, label: 'No thanks', action: 'opt_out', payload: `promo:${promotion._id}:opt_out:1` },
      ],
    });
  });
  test('a message approved before snapshots existed falls back to the live node, the default footer and English', () => {
    const node = makeNode({ templateName: 'old', bodyText: 'Hi {{1}}, hello there friend.', buttons: [button(0, 'Yes', 'opt_in')] });
    const snap = ops.buildConsentSnapshot({ promotion, node, params: ['Omar'], payloads: ops.buildEntryButtonPayloads(node, promotion) });
    expect(snap.renderedBody).toBe('Hi Omar, hello there friend.');
    expect(snap.footer).toBe('Reply STOP to unsubscribe');
    expect(snap.language).toBe('en');
    expect(snap.templateVersion).toBeUndefined();
    expect(snap.buttons).toEqual([{ position: 0, label: 'Yes', action: 'opt_in', payload: `promo:${promotion._id}:opt_in:0` }]);
  });
  test('a customer name that contains a placeholder-looking text is inserted literally', () => {
    const node = makeNode({ bodyText: 'Hi {{1}}, hello there friend.' });
    const snap = ops.buildConsentSnapshot({ promotion, node, params: ['{{2}}'], payloads: [] });
    expect(snap.renderedBody).toBe('Hi {{2}}, hello there friend.');
  });
});

// ─── report maths ────────────────────────────────────────────────────────────

describe('consent report maths', () => {
  test('rates are over delivered messages, one decimal; sent is the fallback while nothing is delivered yet', () => {
    expect(ops.buildConsentReport({ optIns: 3, optOuts: 1, interested: 2, otherTaps: 4, delivered: 8, sent: 10 }))
      .toEqual({ optIns: 3, optOuts: 1, interested: 2, otherTaps: 4, optInRate: 37.5, optOutRate: 12.5 });
    expect(ops.buildConsentReport({ optIns: 1, optOuts: 0, interested: 0, otherTaps: 0, delivered: 0, sent: 3 }).optInRate).toBe(33.3);
    expect(ops.buildConsentReport({ optIns: 2, optOuts: 1, interested: 0, otherTaps: 0, delivered: 3, sent: 3 })).toMatchObject({ optInRate: 66.7, optOutRate: 33.3 });
  });
  test('nothing sent: rates are 0, never NaN or Infinity', () => {
    const r = ops.buildConsentReport({ optIns: 0, optOuts: 0, interested: 0, otherTaps: 0, delivered: 0, sent: 0 });
    expect(r.optInRate).toBe(0); expect(r.optOutRate).toBe(0);
    expect(ops.consentRate(5, 0, 0)).toBe(0);
  });
});

describe('getCampaignReport', () => {
  const agg = [{ sent: 10, delivered: 8, read: 4, failed: 0, clicked: 0, ordered: 0, revenue: 0, pointsIssued: 0 }];
  test('an ordinary promotion keeps exactly the legacy shape (no consent key)', async () => {
    Promotion.findOne.mockResolvedValue({ _id: new Types.ObjectId(), workspaceId: WS, name: 'Sale', purpose: 'standard' });
    CampaignMessage.aggregate.mockResolvedValue(agg);
    const report = await ops.getCampaignReport({ promotionId: new Types.ObjectId(), workspaceId: WS });
    expect(Object.keys(report)).toEqual(['promotionId', 'name', 'messagesSent', 'messagesDelivered', 'messagesRead', 'messagesFailed', 'clicked', 'ordersCreated', 'revenue', 'pointsIssued', 'conversionRate']);
    expect(ConsentEvent.distinct).not.toHaveBeenCalled();
  });
  test('a consent request adds consent {optIns, optOuts, interested, otherTaps, optInRate, optOutRate} from the consent log and the taps', async () => {
    const promotionId = new Types.ObjectId();
    Promotion.findOne.mockResolvedValue({ _id: promotionId, workspaceId: WS, name: 'Opt in', purpose: 'consent_request' });
    CampaignMessage.aggregate
      .mockResolvedValueOnce(agg) // funnel
      .mockResolvedValueOnce([{ _id: 'opt_in', count: 3 }, { _id: 'opt_out', count: 1 }, { _id: 'interested', count: 2 }, { _id: 'end_flow', count: 1 }, { _id: null, count: 2 }]);
    ConsentEvent.distinct
      .mockResolvedValueOnce([new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()]) // opted in
      .mockResolvedValueOnce([new Types.ObjectId()]); // opted out
    const report = await ops.getCampaignReport({ promotionId, workspaceId: WS });
    expect(report.consent).toEqual({ optIns: 3, optOuts: 1, interested: 2, otherTaps: 3, optInRate: 37.5, optOutRate: 12.5 });
    // the log lookups are by this promotion and this workspace only
    expect(ConsentEvent.distinct.mock.calls[0]).toEqual(['customerId', { promotionId, workspaceId: WS, type: 'consent_given' }]);
    expect(ConsentEvent.distinct.mock.calls[1]).toEqual(['customerId', { promotionId, workspaceId: WS, type: 'consent_withdrawn' }]);
  });
  test('an ordinary promotion whose first message has a consent button also gets the block', async () => {
    const promotionId = new Types.ObjectId();
    const entry = makeNode({ buttons: [button(0, 'Join', 'opt_in')] });
    Promotion.findOne.mockResolvedValue({ _id: promotionId, workspaceId: WS, name: 'Sale', purpose: 'standard', entryNodeId: entry._id });
    MessageNode.findById.mockResolvedValue(entry);
    CampaignMessage.aggregate.mockResolvedValueOnce(agg).mockResolvedValueOnce([]);
    ConsentEvent.distinct.mockResolvedValue([]);
    const report = await ops.getCampaignReport({ promotionId, workspaceId: WS });
    expect(report.consent).toEqual({ optIns: 0, optOuts: 0, interested: 0, otherTaps: 0, optInRate: 0, optOutRate: 0 });
  });
  test('an ordinary promotion with a custom message without consent buttons has no consent key', async () => {
    const entry = makeNode({ buttons: [button(0, 'Shop', 'end_flow')] });
    Promotion.findOne.mockResolvedValue({ _id: new Types.ObjectId(), workspaceId: WS, name: 'Sale', purpose: 'standard', entryNodeId: entry._id });
    MessageNode.findById.mockResolvedValue(entry);
    CampaignMessage.aggregate.mockResolvedValue(agg);
    expect((await ops.getCampaignReport({ promotionId: new Types.ObjectId(), workspaceId: WS })).consent).toBeUndefined();
  });
});

// ─── consent log + CSV ───────────────────────────────────────────────────────

describe('consent log', () => {
  const event = (over = {}) => ({
    _id: new Types.ObjectId(), customerId: new Types.ObjectId(), phone: '+966501234567', type: 'consent_given', method: 'whatsapp_button',
    source: 'Promotion: Opt in', createdAt: new Date(Date.UTC(2026, 9, 26, 10, 0, 5)), tappedAt: new Date(Date.UTC(2026, 9, 26, 10, 0, 1)),
    promotionId: new Types.ObjectId(), promotionName: 'Opt in', messageText: 'Hi Sara, ok?', buttonLabel: 'Yes', buttonAction: 'opt_in',
    sourceWamid: 'wamid.SRC', inboundWamid: 'wamid.IN', signature: 'valid', ...over,
  });
  const logQueries = (events, customers = []) => {
    ConsentEvent.find.mockReturnValue(query(events));
    Customer.find.mockReturnValue(query(customers));
  };

  test('a row: eventTimeUtc is the tap time, falling back to the recorded time; names joined; missing values are empty strings', () => {
    const e = event();
    const row = ops.consentLogRow(e, { firstname: 'Sara', lastname: 'Test' });
    expect(row).toMatchObject({ eventTimeUtc: '2026-10-26T10:00:01.000Z', recordedAtUtc: '2026-10-26T10:00:05.000Z', customerName: 'Sara Test', phone: '+966501234567', type: 'consent_given', buttonAction: 'opt_in', inboundWamid: 'wamid.IN', signature: 'valid' });
    const bare = ops.consentLogRow({ _id: new Types.ObjectId(), customerId: e.customerId, phone: '1', type: 'consent_withdrawn', createdAt: e.createdAt });
    expect(bare.eventTimeUtc).toBe('2026-10-26T10:00:05.000Z');
    expect(bare).toMatchObject({ customerName: '', method: '', source: '', promotionId: '', messageText: '', buttonLabel: '', inboundWamid: '', signature: '' });
  });

  test('the CSV: UTF-8 BOM, the 14 columns in order, CRLF, one row per event', async () => {
    const e = event();
    logQueries([e], [{ _id: e.customerId, firstname: 'Sara', lastname: 'Test' }]);
    const { csv, count, truncated } = await ops.getConsentLogCsv({ workspaceId: WS });
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('eventTimeUtc,customerName,phone,type,method,source,promotionId,promotionName,messageText,buttonLabel,buttonAction,sourceWamid,inboundWamid,signature');
    expect(lines[1]).toBe(`2026-10-26T10:00:01.000Z,Sara Test,+966501234567,consent_given,whatsapp_button,Promotion: Opt in,${e.promotionId},Opt in,"Hi Sara, ok?",Yes,opt_in,wamid.SRC,wamid.IN,valid`);
    expect(lines[2]).toBe('');
    expect(count).toBe(1); expect(truncated).toBe(false);
  });

  test('formula injection is neutralised in every text column (customer name, promotion name, message text, label)', async () => {
    const e = event({ promotionName: '=HYPERLINK("http://evil","x")', messageText: '+cmd|calc', buttonLabel: '@SUM(A1)', source: '-2+3' });
    logQueries([e], [{ _id: e.customerId, firstname: '=1+1', lastname: 'Test' }]);
    const { csv } = await ops.getConsentLogCsv({ workspaceId: WS });
    const row = csv.slice(1).split('\r\n')[1];
    expect(row).toContain("'=1+1 Test");
    expect(row).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(row).toContain("'+cmd|calc");
    expect(row).toContain("'@SUM(A1)");
    expect(row).toContain("'-2+3");
    // no cell may start with a bare formula character
    for (const cell of row.split(',')) expect(cell).not.toMatch(/^[=@]/);
  });

  test('csvSafe keeps phone numbers and plain numbers and neutralises every other cell that starts with a formula character', () => {
    for (const fine of ['+966501234567', '+1 (555) 123-4567', '-12.5', '0966501234567', 'hello', '', 'a=b']) expect(ops.csvSafe(fine)).toBe(fine);
    expect(ops.csvSafe(null)).toBe('');
    expect(ops.csvSafe(undefined)).toBe('');
    // "+1+cmd..." starts with a digit after the sign, which the generic neutraliser would let through
    for (const bad of ["+1+cmd|' /C calc'!A0", '=1+1', '@SUM(1)', '-2+3', '\t=1', '\r=1', '+cmd', '-cmd', "=cmd|' /C calc'!A0", '=', '+', '-', '@']) expect(ops.csvSafe(bad)).toBe(`'${bad}`);
  });

  test('quotes, commas, newlines and non-Latin text survive', async () => {
    const e = event({ messageText: 'He said "yes",\nthen left', buttonLabel: 'نعم' });
    logQueries([e], [{ _id: e.customerId, firstname: 'Omar', lastname: 'Ali' }]);
    const { csv } = await ops.getConsentLogCsv({ workspaceId: WS });
    expect(csv).toContain('"He said ""yes"",\nthen left"');
    expect(csv).toContain(',نعم,');
  });

  test('an erased customer (no name) and a missing customer give an empty name cell, not "undefined"', async () => {
    const e = event();
    logQueries([e], []);
    const { csv } = await ops.getConsentLogCsv({ workspaceId: WS });
    expect(csv).not.toMatch(/undefined|null/);
    expect(csv.slice(1).split('\r\n')[1].split(',')[1]).toBe('');
  });

  test('the query is always scoped to the caller\'s workspace, with the status and promotion filters', async () => {
    logQueries([]);
    const promotionId = String(new Types.ObjectId());
    await ops.getConsentLog({ workspaceId: String(WS), status: 'opted_in', promotionId, page: 2, limit: 500 });
    const filter = ConsentEvent.find.mock.calls[0][0];
    expect(String(filter.workspaceId)).toBe(String(WS));
    expect(filter.type).toEqual({ $in: ['consent_given', 'consent_reinstated'] });
    expect(String(filter.promotionId)).toBe(promotionId);
  });

  test('paging: limit is capped at 200 and defaults to 50, page at least 1; the totals are returned', async () => {
    ConsentEvent.find.mockReturnValue(query([]));
    ConsentEvent.countDocuments.mockResolvedValue(401);
    Customer.find.mockReturnValue(query([]));
    let out = await ops.getConsentLog({ workspaceId: WS, page: '0', limit: '9999' });
    expect(out).toMatchObject({ page: 1, limit: 200, total: 401, pages: 3, events: [] });
    out = await ops.getConsentLog({ workspaceId: WS });
    expect(out).toMatchObject({ page: 1, limit: 50, pages: 9 });
  });

  test('status values: opted_out, not_responded and a raw event type; anything else is a 400', async () => {
    logQueries([]);
    await ops.getConsentLog({ workspaceId: WS, status: 'opted_out' });
    expect(ConsentEvent.find.mock.calls[0][0].type).toEqual({ $in: ['consent_withdrawn'] });
    await ops.getConsentLog({ workspaceId: WS, status: 'not_responded' });
    expect(ConsentEvent.find.mock.calls[1][0].type).toEqual({ $in: ['consent_declined'] });
    await ops.getConsentLog({ workspaceId: WS, status: 'consent_withdrawn' });
    expect(ConsentEvent.find.mock.calls[2][0].type).toBe('consent_withdrawn');
    await expect(ops.getConsentLog({ workspaceId: WS, status: 'constructor' })).rejects.toMatchObject({ status: 400 });
    await expect(ops.getConsentLog({ workspaceId: WS, status: { $ne: 'x' } })).rejects.toMatchObject({ status: 400 });
    await expect(ops.getConsentLog({ workspaceId: WS, promotionId: 'not-an-id' })).rejects.toMatchObject({ status: 400 });
    await expect(ops.getConsentLog({ workspaceId: WS, promotionId: { $ne: null } })).rejects.toMatchObject({ status: 400 });
  });

  test('no workspace, no log (never an unscoped read)', async () => {
    await expect(ops.getConsentLog({})).rejects.toMatchObject({ status: 400, code: 'WORKSPACE_REQUIRED' });
    await expect(ops.getConsentLogCsv({})).rejects.toMatchObject({ status: 400 });
    await expect(ops.getCustomerConsentEvents({ customerId: new Types.ObjectId() })).rejects.toMatchObject({ status: 400 });
    expect(ConsentEvent.find).not.toHaveBeenCalled();
  });

  test('one customer\'s history: 404 for a customer of another workspace', async () => {
    Customer.findOne.mockReturnValue(query(null));
    await expect(ops.getCustomerConsentEvents({ customerId: new Types.ObjectId(), workspaceId: OTHER_WS })).rejects.toThrow('Customer not found');
    expect(Customer.findOne.mock.calls[0][0]).toMatchObject({ workspaceId: OTHER_WS });
    expect(ConsentEvent.find).not.toHaveBeenCalled();
  });
});

// ─── customers: consent filter ───────────────────────────────────────────────

describe('listCustomers consent filter', () => {
  beforeEach(() => {
    Customer.find.mockReturnValue(query([]));
    Customer.countDocuments.mockResolvedValue(0);
  });
  test('opted_in / opted_out / not_responded map to the right queries, inside the workspace', async () => {
    await ops.listCustomers({ workspaceId: WS, consent: 'opted_in' });
    expect(Customer.find.mock.calls[0][0]).toMatchObject({ workspaceId: WS, marketingConsent: true, optedOut: { $ne: true } });
    await ops.listCustomers({ workspaceId: WS, consent: 'opted_out' });
    expect(Customer.find.mock.calls[1][0]).toMatchObject({ workspaceId: WS, optedOut: true });
    await ops.listCustomers({ workspaceId: WS, consent: 'not_responded' });
    expect(Customer.find.mock.calls[2][0]).toMatchObject({ workspaceId: WS, marketingConsent: { $ne: true }, optedOut: { $ne: true }, deletedAt: null });
  });
  test('no filter (or an empty one) adds nothing: the legacy query', async () => {
    await ops.listCustomers({ workspaceId: WS });
    await ops.listCustomers({ workspaceId: WS, consent: '' });
    expect(Customer.find.mock.calls[0][0]).toEqual({ workspaceId: WS });
    expect(Customer.find.mock.calls[1][0]).toEqual({ workspaceId: WS });
  });
  test('an unknown value (including object keys) is a 400', async () => {
    for (const bad of ['everyone', 'constructor', '__proto__', 'toString']) {
      await expect(ops.listCustomers({ workspaceId: WS, consent: bad })).rejects.toMatchObject({ status: 400, code: 'INVALID_CONSENT_FILTER' });
    }
    expect(Customer.find).not.toHaveBeenCalled();
  });
});

describe('getRecommendedCustomers audience', () => {
  const setup = (promotion) => {
    Promotion.findOne.mockReturnValue(query({ ...promotion, products: [] }));
    Customer.find.mockReturnValue(query([]));
  };
  test('no audience: the same filter as always (everyone not opted out, no demo)', async () => {
    setup({ _id: new Types.ObjectId(), customerType: 'cash', type: 'store_wide', purpose: 'standard' });
    await ops.getRecommendedCustomers({ promotionId: new Types.ObjectId(), workspaceId: WS });
    expect(Customer.find.mock.calls[0][0]).toEqual({ optedOut: { $ne: true }, isDemo: { $ne: true }, workspaceId: WS });
  });
  test('audience opted_in / not_responded / opted_out', async () => {
    for (const [audience, expected] of [
      ['opted_in', { marketingConsent: true, optedOut: { $ne: true } }],
      ['not_responded', { marketingConsent: { $ne: true }, optedOut: { $ne: true }, deletedAt: null }],
      ['opted_out', { optedOut: true }],
    ]) {
      Customer.find.mockClear();
      setup({ _id: new Types.ObjectId(), customerType: 'cash', type: 'store_wide', purpose: 'standard' });
      await ops.getRecommendedCustomers({ promotionId: new Types.ObjectId(), workspaceId: WS, audience });
      expect(Customer.find.mock.calls[0][0]).toMatchObject({ ...expected, isDemo: { $ne: true }, workspaceId: WS });
    }
  });
  test('a consent request defaults to the customers who have not answered, and never lists opted-out customers', async () => {
    setup({ _id: new Types.ObjectId(), customerType: 'cash', type: 'store_wide', purpose: 'consent_request' });
    await ops.getRecommendedCustomers({ promotionId: new Types.ObjectId(), workspaceId: WS });
    expect(Customer.find.mock.calls[0][0]).toMatchObject({ marketingConsent: { $ne: true }, optedOut: { $ne: true }, deletedAt: null });
    Customer.find.mockClear();
    setup({ _id: new Types.ObjectId(), customerType: 'cash', type: 'store_wide', purpose: 'consent_request' });
    expect(await ops.getRecommendedCustomers({ promotionId: new Types.ObjectId(), workspaceId: WS, audience: 'opted_out' })).toEqual([]);
    expect(Customer.find).not.toHaveBeenCalled();
  });
  test('a bad audience is a 400', async () => {
    setup({ _id: new Types.ObjectId(), customerType: 'cash', type: 'store_wide', purpose: 'standard' });
    await expect(ops.getRecommendedCustomers({ promotionId: new Types.ObjectId(), workspaceId: WS, audience: 'nope' })).rejects.toMatchObject({ status: 400 });
  });
});

// ─── the approval gate in sendPromotion / sendTestMessage ────────────────────

describe('sendPromotion: the approval gate', () => {
  function world({ purpose = 'consent_request', node = makeNode(), promotion, customers } = {}) {
    const promo = promotion || makePromotion({ purpose, entryNodeId: node._id });
    const custs = customers || [makeCustomer(), makeCustomer()];
    Promotion.findOne.mockReturnValue(query(promo));
    Customer.find.mockResolvedValue(custs);
    MessageNode.findById.mockResolvedValue(node);
    MessageNode.findOne.mockResolvedValue(node);
    Promotion.findById.mockReturnValue(query({ purpose }));
    return { promo, node, custs, ids: custs.map(c => c._id) };
  }
  const run = (w, extra = {}) => ops.sendPromotion({ promotionId: w.promo._id, customerIds: w.ids, workspaceId: WS, userId: USER, ...extra });

  test('never submitted: submitted now, send refused with the typed error BEFORE any customer, send request recorded', async () => {
    const w = world();
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', status: 409, templateStatus: 'pending', submittedNow: true, message: expect.stringMatching(/sent to Facebook \(Meta\) for approval/) });
    expect(wa.createTemplate).toHaveBeenCalledTimes(1);
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
    expect(CampaignMessage.create).not.toHaveBeenCalled();
    expect(Customer.findOneAndUpdate).not.toHaveBeenCalled(); // nobody was marked as asked
    expect(Customer.updateOne).not.toHaveBeenCalled();
    const [filter, update] = Promotion.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: w.promo._id });
    expect(update.$set.sendRequest.customerIds).toEqual(w.ids);
    expect(update.$set.sendRequest.requestedAt).toBeInstanceOf(Date);
    expect(update.$set.sendRequest.requestedBy).toBe(USER);
  });

  test('already waiting for Meta: not submitted again, submittedNow false, and a live status check first (it may be approved by now)', async () => {
    const node = makeNode({ templateName: 'waflow_flow_x', templateStatus: 'pending', templateVersion: 1 });
    const w = world({ node });
    wa.getTemplate.mockResolvedValue({ name: 'waflow_flow_x', status: 'PENDING' });
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', templateStatus: 'pending', submittedNow: false, message: expect.stringMatching(/still being reviewed/) });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(wa.getTemplate).toHaveBeenCalledWith('waflow_flow_x');
    expect(Promotion.updateOne).toHaveBeenCalledTimes(1); // the send request
  });

  test('pending but approved by now: the live check lets the send go through', async () => {
    const node = makeNode({ templateName: 'waflow_flow_x', templateStatus: 'pending', templateVersion: 1 });
    const w = world({ node });
    wa.getTemplate.mockResolvedValue({ name: 'waflow_flow_x', status: 'APPROVED', category: 'MARKETING' });
    const out = await run(w);
    expect(out.sentCount).toBe(2);
    expect(wa.sendCustomFlowTemplate).toHaveBeenCalledTimes(2);
    expect(templateApproval.markApprovedNotice).toHaveBeenCalledTimes(1);
  }, 10000);

  test('rejected: refused with Meta\'s reason, not resubmitted automatically', async () => {
    const node = makeNode({ templateName: 'waflow_flow_x', templateStatus: 'rejected', templateRejectedReason: 'Facebook (Meta) did not approve this message (INVALID_FORMAT).' });
    const w = world({ node });
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', templateStatus: 'rejected', submittedNow: false, message: expect.stringMatching(/INVALID_FORMAT.*Edit the message/) });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(wa.getTemplate).toHaveBeenCalledWith('waflow_flow_x'); // one live check first: a paused message may be active again
  });

  test('rejected (paused) by the time of the send but active again at Meta: the live check lets the send go through', async () => {
    const node = makeNode({ templateName: 'waflow_flow_x', templateStatus: 'rejected', templateVersion: 1, templateRejectedReason: 'Facebook (Meta) has paused this message because customers reacted badly to it. Edit it, or try again later.' });
    const w = world({ node, customers: [makeCustomer()] });
    wa.getTemplate.mockResolvedValue({ name: 'waflow_flow_x', status: 'APPROVED', category: 'MARKETING' });
    const out = await run(w);
    expect(out.sentCount).toBe(1);
    expect(node.templateStatus).toBe('approved');
    expect(node.templateRejectedReason).toBeUndefined();
  }, 10000);

  test('the submission itself fails (Meta refuses, or our pre-check does): still refused, the reason is given, the intended send is still recorded', async () => {
    const node = makeNode({ bodyText: 'Hi {{1}}' }); // ends with a variable
    const w = world({ node });
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', templateStatus: 'not_created', submittedNow: false, reason: expect.stringMatching(/cannot end with a variable/), message: expect.stringMatching(/could not be sent to Facebook/) });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(Promotion.updateOne).toHaveBeenCalledTimes(1);

    const node2 = makeNode();
    const w2 = world({ node: node2 });
    wa.createTemplate.mockRejectedValue(Object.assign(new Error('Request failed'), { response: { data: { error: { message: 'Invalid parameter', error_user_msg: 'The name is taken.' } } } }));
    await expect(run(w2)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', submittedNow: false, reason: 'The name is taken.' });
  });

  test('a number that cannot be used is reported as it is (409 WHATSAPP_NUMBER_UNAVAILABLE), not as a template problem', async () => {
    const w = world();
    wa.createTemplate.mockRejectedValue(Object.assign(new Error('This WhatsApp number cannot be used right now.'), { code: 'WHATSAPP_NUMBER_UNAVAILABLE', status: 409 }));
    await expect(run(w)).rejects.toMatchObject({ code: 'WHATSAPP_NUMBER_UNAVAILABLE' });
  });

  test('approved under another WhatsApp account: submitted again (next version) under the sending account', async () => {
    const node = makeNode({ templateName: 'waflow_flow_old', templateStatus: 'approved', templateVersion: 1, templateWabaId: 'WABA_OLD' });
    const w = world({ node });
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', templateStatus: 'pending', submittedNow: true });
    expect(wa.createTemplate.mock.calls[0][0]).toMatch(/_v2$/);
    expect(node.templateWabaId).toBe('WABA_A');
  });

  test('KILL SWITCH PROMO_ENTRY_FALLBACK=on: an ordinary promotion silently falls back to the default message, as before', async () => {
    process.env.PROMO_ENTRY_FALLBACK = 'on';
    const node = makeNode({ templateName: 'waflow_flow_x', templateStatus: 'pending', ownerType: 'promotion', buttons: [button(0, 'Shop', 'end_flow')] });
    const w = world({ purpose: 'standard', node, customers: [makeCustomer({ marketingConsent: true })] });
    wa.sendPromoAnnouncement.mockResolvedValue({ messages: [{ id: 'wamid.DEFAULT' }] });
    const out = await run(w);
    expect(out.sentCount).toBe(1);
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(Promotion.updateOne.mock.calls.every(([, u]) => !u.$set)).toBe(true); // no send request recorded
  });

  test('...but never for a consent request (it has no default message): still blocked with the switch on', async () => {
    process.env.PROMO_ENTRY_FALLBACK = 'on';
    const w = world();
    await expect(run(w)).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED' });
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
  });

  test('a consent request with no message of its own, or no Opt in button: 400 CONSENT_REQUEST_INVALID, nothing submitted or sent', async () => {
    const noNode = makePromotion({ purpose: 'consent_request' });
    Promotion.findOne.mockReturnValue(query(noNode));
    Customer.find.mockResolvedValue([makeCustomer()]);
    await expect(ops.sendPromotion({ promotionId: noNode._id, customerIds: [new Types.ObjectId()], workspaceId: WS })).rejects.toMatchObject({ code: 'CONSENT_REQUEST_INVALID', status: 400 });

    const node = makeNode({ buttons: [button(0, 'No thanks', 'opt_out')], templateStatus: 'approved' });
    const w = world({ node });
    await expect(run(w)).rejects.toMatchObject({ code: 'CONSENT_REQUEST_INVALID', status: 400, message: expect.stringMatching(/Opt in/) });

    MessageNode.findById.mockResolvedValue(null); // the message was deleted
    await expect(run(w)).rejects.toMatchObject({ code: 'CONSENT_REQUEST_INVALID' });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
  });

  test('demo data is never gated: a demo promotion simulates even with an unapproved message', async () => {
    const node = makeNode({ templateStatus: 'not_created' });
    const promo = makePromotion({ purpose: 'standard', isDemo: true, entryNodeId: node._id });
    const w = world({ node, promotion: promo, customers: [makeCustomer({ marketingConsent: true })] });
    const spy = jest.spyOn(Math, 'random').mockReturnValue(0.99); // > 0.55: no simulated conversion
    try {
      const out = await run(w);
      expect(out).toMatchObject({ sentCount: 1, demoCount: 1 });
    } finally { spy.mockRestore(); }
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
  });

  test('a consent request where nobody is eligible does not touch Meta at all', async () => {
    const w = world({ customers: [makeCustomer({ marketingConsent: true }), makeCustomer({ optedOut: true })] });
    const out = await run(w);
    expect(out).toMatchObject({ sentCount: 0, skippedOptedOut: 1, skippedAlreadyOptedIn: 1, skippedAskedRecently: 0, skippedNoConsent: 0 });
    expect(wa.createTemplate).not.toHaveBeenCalled();
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();
  });

  test('the send request holds at most 2000 customers and takes requestedBy only from a valid id', async () => {
    const many = Array.from({ length: 2105 }, () => makeCustomer());
    const w = world({ customers: many });
    await expect(ops.sendPromotion({ promotionId: w.promo._id, customerIds: w.ids, workspaceId: WS, userId: 'not-an-object-id' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED' });
    const request = Promotion.updateOne.mock.calls[0][1].$set.sendRequest;
    expect(request.customerIds).toHaveLength(2000);
    expect('requestedBy' in request).toBe(false);
  });

  test('sendTestMessage is gated too, but records no send request and uses the inert promotest: payload', async () => {
    const node = makeNode({ templateStatus: 'not_created' });
    const w = world({ node });
    await expect(ops.sendTestMessage({ promotionId: w.promo._id, phone: '966500000001', workspaceId: WS, userId: USER })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_APPROVED', submittedNow: true });
    expect(Promotion.updateOne).not.toHaveBeenCalled();
    expect(wa.sendCustomFlowTemplate).not.toHaveBeenCalled();

    const approved = makeNode({ templateStatus: 'approved', templateName: 'waflow_flow_ok', templateSnapshot: { bodyText: 'Hi {{1}}, offers from us on WhatsApp? Stop any time.' } });
    const w2 = world({ node: approved });
    await ops.sendTestMessage({ promotionId: w2.promo._id, phone: '966500000001', workspaceId: WS });
    const [phone, name, params, payloads] = wa.sendCustomFlowTemplate.mock.calls[0];
    expect(phone).toBe('966500000001');
    expect(name).toBe('waflow_flow_ok');
    expect(params).toEqual(['Test']); // one value: the submitted text has one variable
    expect(payloads).toEqual([`promotest:${w2.promo._id}:opt_in:0`, `promotest:${w2.promo._id}:opt_out:1`]);
  });
});

describe('sendPromotion: sending a consent request', () => {
  const approvedNode = (over = {}) => makeNode({
    templateStatus: 'approved', templateName: 'waflow_flow_ok_v2', templateVersion: 2, templateWabaId: 'WABA_A',
    bodyText: 'LIVE EDIT {{1}}', // unsubmitted edit: must never be what is recorded
    templateSnapshot: { bodyText: 'Hi {{1}}, offers from us on WhatsApp? Stop any time.', footer: 'Reply STOP to unsubscribe', language: 'en',
      buttons: [{ position: 0, label: 'Yes, send me offers', action: 'opt_in' }, { position: 1, label: 'No thanks', action: 'opt_out' }] },
    ...over,
  });
  function setup(customers, { node = approvedNode(), promotion } = {}) {
    const promo = promotion || makePromotion({ entryNodeId: node._id });
    Promotion.findOne.mockReturnValue(query(promo));
    Customer.find.mockResolvedValue(customers);
    MessageNode.findById.mockResolvedValue(node);
    return { promo, node };
  }

  test('sends to the eligible only, with promo: payloads and exactly the submitted number of values; response carries the extra counters', async () => {
    const fresh = makeCustomer({ firstname: 'Sara' });
    const optedIn = makeCustomer({ marketingConsent: true });
    const optedOut = makeCustomer({ optedOut: true });
    const asked = makeCustomer({ marketingConsentAskedAt: new Date() });
    const { promo, node } = setup([fresh, optedIn, optedOut, asked]);
    const out = await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh, optedIn, optedOut, asked].map(c => c._id), workspaceId: WS });
    expect(out).toEqual({ success: true, sentCount: 1, skippedOptedOut: 1, skippedNoConsent: 0, skippedAlreadyOptedIn: 1, skippedAskedRecently: 1, errors: [], demoCount: 0 });
    expect(wa.sendCustomFlowTemplate).toHaveBeenCalledTimes(1);
    const [phone, name, params, payloads] = wa.sendCustomFlowTemplate.mock.calls[0];
    expect(phone).toBe(fresh.phone);
    expect(name).toBe('waflow_flow_ok_v2');
    expect(params).toEqual(['Sara']);
    expect(payloads).toEqual([`promo:${promo._id}:opt_in:0`, `promo:${promo._id}:opt_out:1`]);
    expect(node.save).not.toHaveBeenCalled();
  });

  test('the CampaignMessage keeps the submitted text as sent (consentSnapshot) and the customer is marked as asked', async () => {
    const fresh = makeCustomer({ firstname: 'Sara' });
    const { promo } = setup([fresh]);
    await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh._id], workspaceId: WS });
    const row = CampaignMessage.create.mock.calls[0][0];
    expect(row).toMatchObject({ kind: 'promotion', promotion: promo._id, customer: fresh._id, workspaceId: WS, messageType: 'template', templateName: 'waflow_flow_ok_v2', status: 'sent' });
    expect(row.consentSnapshot).toMatchObject({
      promotionName: 'Opt in', purpose: 'consent_request', templateName: 'waflow_flow_ok_v2', templateVersion: 2, language: 'en',
      renderedBody: 'Hi Sara, offers from us on WhatsApp? Stop any time.', footer: 'Reply STOP to unsubscribe',
    });
    expect(row.consentSnapshot.buttons.map(b => [b.label, b.action, b.payload])).toEqual([
      ['Yes, send me offers', 'opt_in', `promo:${promo._id}:opt_in:0`], ['No thanks', 'opt_out', `promo:${promo._id}:opt_out:1`],
    ]);
    // marked as asked BEFORE the send, by one conditional update (a second request at the same moment loses the claim)
    const [filter, update, options] = Customer.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: fresh._id, workspaceId: WS, optedOut: { $ne: true }, marketingConsent: { $ne: true }, deletedAt: { $exists: false } });
    expect(filter.$or).toHaveLength(3); // never asked, or not asked within the cooldown
    expect(update.$set.marketingConsentAskedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ returnDocument: 'before' }); // what the person's asked date WAS, to give back after a failed send
    expect(Customer.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Customer.updateOne).not.toHaveBeenCalled(); // a send that went out keeps the claim
  });

  test('the claim is a skip, never a send: a customer somebody else claimed first, or a claim the database could not make, is counted as asked recently', async () => {
    const lost = makeCustomer({ firstname: 'Lost' });
    const broken = makeCustomer({ firstname: 'Broken' });
    const won = makeCustomer({ firstname: 'Won' });
    const { promo } = setup([lost, broken, won]);
    Customer.findOneAndUpdate.mockImplementation(async (filter) => {
      if (String(filter._id) === String(lost._id)) return null; // nothing matched: somebody else asked first
      if (String(filter._id) === String(broken._id)) throw new Error('db down');
      return {};
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const out = await ops.sendPromotion({ promotionId: promo._id, customerIds: [lost, broken, won].map(c => c._id), workspaceId: WS });
      expect(out).toMatchObject({ sentCount: 1, skippedAskedRecently: 2, errors: [] });
    } finally { errorSpy.mockRestore(); }
    expect(wa.sendCustomFlowTemplate).toHaveBeenCalledTimes(1);
    expect(wa.sendCustomFlowTemplate.mock.calls[0][0]).toBe(won.phone);
    expect(CampaignMessage.create).toHaveBeenCalledTimes(1);
  });

  test('a cooldown of 0 days asks again at once: the claim only holds back a person asked within the last minute (a second request at the same moment)', async () => {
    const saved = process.env.CONSENT_ASK_COOLDOWN_DAYS;
    process.env.CONSENT_ASK_COOLDOWN_DAYS = '0';
    try {
      const again = makeCustomer({ marketingConsentAskedAt: new Date(Date.now() - 2 * DAY) });
      const { promo } = setup([again]);
      const before = Date.now();
      const out = await ops.sendPromotion({ promotionId: promo._id, customerIds: [again._id], workspaceId: WS });
      expect(out).toMatchObject({ sentCount: 1, skippedAskedRecently: 0 }); // the audience itself applies no cooldown
      const [filter] = Customer.findOneAndUpdate.mock.calls[0];
      expect(filter).toMatchObject({ optedOut: { $ne: true }, marketingConsent: { $ne: true } });
      expect(filter.$or).toHaveLength(3);
      const bound = filter.$or[2].marketingConsentAskedAt.$lt.getTime(); // asked more than a minute ago (not "any time")
      expect(bound).toBeGreaterThanOrEqual(before - 60000);
      expect(bound).toBeLessThanOrEqual(Date.now() - 60000 + 5);
    } finally { if (saved === undefined) delete process.env.CONSENT_ASK_COOLDOWN_DAYS; else process.env.CONSENT_ASK_COOLDOWN_DAYS = saved; }
  });

  test('with the default cooldown the claim holds back a person asked within the cooldown, not only within the last minute', async () => {
    const fresh = makeCustomer();
    const { promo } = setup([fresh]);
    const before = Date.now();
    await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh._id], workspaceId: WS });
    const bound = Customer.findOneAndUpdate.mock.calls[0][0].$or[2].marketingConsentAskedAt.$lt.getTime();
    expect(bound).toBeGreaterThanOrEqual(before - 7 * DAY);
    expect(bound).toBeLessThanOrEqual(Date.now() - 7 * DAY + 5);
  });

  test('a failed send writes a failed row with no snapshot and does NOT mark the customer as asked', async () => {
    const fresh = makeCustomer();
    const { promo } = setup([fresh]);
    wa.sendCustomFlowTemplate.mockRejectedValue(new Error('Request failed with status code 400'));
    const out = await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh._id], workspaceId: WS });
    expect(out.sentCount).toBe(0);
    expect(out.errors).toHaveLength(1);
    expect(CampaignMessage.create.mock.calls[0][0]).toMatchObject({ status: 'failed' });
    expect(CampaignMessage.create.mock.calls[0][0].consentSnapshot).toBeUndefined();
    // claimed before the send, given back after it failed: never left marked as asked
    expect(Customer.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(Customer.updateOne).toHaveBeenCalledTimes(1);
    const [claimFilter, claimUpdate] = Customer.findOneAndUpdate.mock.calls[0];
    const [releaseFilter, releaseUpdate] = Customer.updateOne.mock.calls[0];
    expect(releaseFilter).toEqual({ _id: fresh._id, workspaceId: WS, marketingConsentAskedAt: claimUpdate.$set.marketingConsentAskedAt }); // only if nobody asked in between
    expect(releaseUpdate).toEqual({ $unset: { marketingConsentAskedAt: 1 } });
    expect(claimFilter._id).toEqual(fresh._id);
  });

  test('a failed send gives back the PREVIOUS asked date (a person asked a month ago is not made to look un-asked, nor asked today)', async () => {
    const monthAgo = new Date(Date.now() - 30 * 86400000);
    const fresh = makeCustomer({ marketingConsentAskedAt: monthAgo });
    const { promo } = setup([fresh]);
    Customer.findOneAndUpdate.mockImplementation(async () => ({ marketingConsentAskedAt: monthAgo })); // the document as it was before the claim
    wa.sendCustomFlowTemplate.mockRejectedValue(new Error('Request failed with status code 400'));
    await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh._id], workspaceId: WS });
    expect(Customer.updateOne).toHaveBeenCalledTimes(1);
    expect(Customer.updateOne.mock.calls[0][1]).toEqual({ $set: { marketingConsentAskedAt: monthAgo } });
  });

  test('if the CampaignMessage write fails once it is tried again (a tap could not be tied to the customer otherwise)', async () => {
    const fresh = makeCustomer();
    const { promo } = setup([fresh]);
    CampaignMessage.create.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce({});
    await ops.sendPromotion({ promotionId: promo._id, customerIds: [fresh._id], workspaceId: WS });
    expect(CampaignMessage.create).toHaveBeenCalledTimes(2);
  });

  test('the send request is cleared after a send that went out, kept when everything failed, and absent updates stay legacy-identical', async () => {
    const fresh = makeCustomer();
    const withRequest = makePromotion({ sendRequest: { customerIds: [fresh._id], requestedAt: new Date() } });
    const node = approvedNode();
    withRequest.entryNodeId = node._id;
    setup([fresh], { node, promotion: withRequest });
    await ops.sendPromotion({ promotionId: withRequest._id, customerIds: [fresh._id], workspaceId: WS });
    let [filter, update] = Promotion.updateOne.mock.calls.at(-1);
    expect(filter).toEqual({ _id: withRequest._id });
    expect(update.$unset).toEqual({ sendRequest: 1 });
    expect(update).toMatchObject({ sentCount: 1, status: 'active' });

    Promotion.updateOne.mockClear();
    wa.sendCustomFlowTemplate.mockRejectedValue(new Error('boom'));
    setup([fresh], { node, promotion: withRequest });
    await ops.sendPromotion({ promotionId: withRequest._id, customerIds: [fresh._id], workspaceId: WS });
    [, update] = Promotion.updateOne.mock.calls.at(-1);
    expect(update.$unset).toBeUndefined();

    // a promotion that never had a send request: the post-send update is exactly the old one
    Promotion.updateOne.mockClear();
    wa.sendCustomFlowTemplate.mockImplementation(async () => ({ messages: [{ id: 'wamid.OK' }] }));
    const plain = makePromotion({ sendRequest: undefined, entryNodeId: node._id });
    setup([fresh], { node, promotion: plain });
    await ops.sendPromotion({ promotionId: plain._id, customerIds: [fresh._id], workspaceId: WS });
    [, update] = Promotion.updateOne.mock.calls.at(-1);
    expect(Object.keys(update).sort()).toEqual(['sentAt', 'sentCount', 'status']);
  });

  test('a standard promotion: the response has exactly the legacy keys and the consent rules are unchanged (opted-in only)', async () => {
    const consented = makeCustomer({ marketingConsent: true });
    const notYet = makeCustomer();
    const node = approvedNode({ buttons: [button(0, 'Shop', 'end_flow')], templateSnapshot: undefined, bodyText: 'Hi {{1}} {{2}} {{3}} {{4}} see you.' });
    const promo = makePromotion({ purpose: 'standard', entryNodeId: node._id });
    setup([consented, notYet], { node, promotion: promo });
    const out = await ops.sendPromotion({ promotionId: promo._id, customerIds: [consented._id, notYet._id], workspaceId: WS });
    expect(Object.keys(out)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'errors', 'demoCount']);
    expect(out).toMatchObject({ sentCount: 1, skippedNoConsent: 1, skippedOptedOut: 0 });
    // all four values and msgnode_ payloads, as before; no snapshot, nobody marked as asked
    const [, , params, payloads] = wa.sendCustomFlowTemplate.mock.calls[0];
    expect(params).toHaveLength(4);
    expect(payloads).toEqual([`msgnode_${node._id}_0`]);
    expect(CampaignMessage.create.mock.calls[0][0].consentSnapshot).toBeUndefined();
    expect(Customer.findOneAndUpdate).not.toHaveBeenCalled();
    expect(Customer.updateOne).not.toHaveBeenCalled();
  });
});

// ─── promotion input rules ───────────────────────────────────────────────────

describe('createPromotion / updatePromotion input rules', () => {
  beforeEach(() => {
    Promotion.create.mockImplementation(async (doc) => doc);
    Promotion.findOneAndUpdate.mockImplementation(async (_f, update) => ({ _id: 'p', ...update }));
  });
  test('sendRequest is server-managed: a client cannot write it', async () => {
    await ops.createPromotion({ name: 'x', workspaceId: WS, sendRequest: { approvedNoticeAt: new Date() } });
    expect(Promotion.create.mock.calls[0][0].sendRequest).toBeUndefined();
    await ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, sendRequest: { dismissedAt: new Date() }, name: 'y' });
    expect(Promotion.findOneAndUpdate.mock.calls[0][1].sendRequest).toBeUndefined();
    expect(Promotion.findOneAndUpdate.mock.calls[0][1].name).toBe('y');
  });
  test('the wording acknowledgement: time and person are the server\'s, the hash is the client\'s; the same hash again keeps the original', async () => {
    await ops.createPromotion({ name: 'x', workspaceId: WS, userId: USER, consentWordingAck: { at: '2001-01-01', by: 'someone-else', textHash: 'abc123' } });
    const ack = Promotion.create.mock.calls[0][0].consentWordingAck;
    expect(ack.textHash).toBe('abc123');
    expect(ack.by).toBe(USER);
    expect(ack.at).toBeInstanceOf(Date);
    expect(ack.at.getFullYear()).toBeGreaterThan(2020);

    const before = { _id: 'p', purpose: 'consent_request', consentWordingAck: { at: new Date(Date.UTC(2026, 0, 1)), by: USER, textHash: 'abc123' } };
    Promotion.findOne.mockReturnValue(query(before));
    await ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, userId: USER, consentWordingAck: { textHash: 'abc123' } });
    expect(Promotion.findOneAndUpdate.mock.calls[0][1].consentWordingAck).toBeUndefined(); // unchanged: the original time stays
    await ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, userId: USER, consentWordingAck: { textHash: 'new-hash' } });
    expect(Promotion.findOneAndUpdate.mock.calls[1][1].consentWordingAck.textHash).toBe('new-hash');
    await ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, userId: USER, consentWordingAck: false });
    expect('consentWordingAck' in Promotion.findOneAndUpdate.mock.calls[2][1]).toBe(false); // the acknowledgement can only be given, never silently cleared
  });
  test('a consent request cannot be a carousel (create, or update of either field)', async () => {
    await expect(ops.createPromotion({ name: 'x', workspaceId: WS, purpose: 'consent_request', sendFormat: 'carousel' })).rejects.toThrow('not as a carousel');
    Promotion.findOne.mockReturnValue(query({ purpose: 'consent_request', sendFormat: 'separate' }));
    await expect(ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, sendFormat: 'carousel' })).rejects.toThrow('not as a carousel');
    Promotion.findOne.mockReturnValue(query({ purpose: 'standard', sendFormat: 'carousel' }));
    await expect(ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, purpose: 'consent_request' })).rejects.toThrow('not as a carousel');
    await expect(ops.createPromotion({ name: 'ok', workspaceId: WS, purpose: 'standard', sendFormat: 'carousel' })).resolves.toBeTruthy();
  });
  test('an entry message of another workspace cannot be attached; one of the same workspace (or a legacy one with none) can', async () => {
    const mine = new Types.ObjectId(); const foreign = new Types.ObjectId(); const legacy = new Types.ObjectId();
    MessageNode.findById.mockImplementation(async (id) => (String(id) === String(foreign) ? { workspaceId: OTHER_WS } : String(id) === String(mine) ? { workspaceId: WS } : { workspaceId: undefined }));
    await expect(ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, entryNodeId: foreign })).rejects.toThrow('does not belong to this workspace');
    await expect(ops.createPromotion({ name: 'x', workspaceId: WS, entryNodeId: foreign })).rejects.toThrow('does not belong to this workspace');
    await expect(ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, entryNodeId: mine })).resolves.toBeTruthy();
    await expect(ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, entryNodeId: legacy })).resolves.toBeTruthy();
  });
  test('an ordinary update makes no extra read of the promotion (legacy cost)', async () => {
    await ops.updatePromotion({ id: new Types.ObjectId(), workspaceId: WS, name: 'z', discountPercent: 5 });
    expect(Promotion.findOne).not.toHaveBeenCalled();
  });
});

describe('dismissSendRequest', () => {
  test('sets dismissedAt only on a promotion of this workspace that has a request, then returns the promotion', async () => {
    const id = new Types.ObjectId();
    Promotion.findOne.mockReturnValue(query({ _id: id, name: 'p' }));
    const out = await ops.dismissSendRequest({ promotionId: id, workspaceId: WS });
    const [filter, update] = Promotion.updateOne.mock.calls[0];
    expect(filter).toMatchObject({ _id: id, workspaceId: WS, 'sendRequest.requestedAt': { $exists: true } });
    expect(update.$set['sendRequest.dismissedAt']).toBeInstanceOf(Date);
    expect(out).toMatchObject({ name: 'p' });
  });
  test('another workspace\'s promotion: not found', async () => {
    Promotion.findOne.mockReturnValue(query(null));
    await expect(ops.dismissSendRequest({ promotionId: new Types.ObjectId(), workspaceId: OTHER_WS })).rejects.toThrow('Promotion not found');
  });
});

describe('previewPromotionMessage', () => {
  const previewWorld = (promotion, node) => {
    Promotion.findOne.mockReturnValue(query({ ...promotion, products: [{ name: 'Beans', basePrice: 10 }], services: [] }));
    MessageNode.findById.mockResolvedValue(node);
  };
  test('a custom message: every button with its action, the footer, isConsentRequest, version and status', async () => {
    const node = makeNode({ templateStatus: 'approved', templateVersion: 2, templateApprovedAt: new Date(0), buttons: [button(1, 'No thanks', 'opt_out', { replyText: 'Bye' }), button(0, 'Yes', 'opt_in')] });
    previewWorld(makePromotion({ entryNodeId: node._id }), node);
    const p = await ops.previewPromotionMessage({ promotionId: new Types.ObjectId(), workspaceId: WS });
    expect(p).toMatchObject({
      messageType: 'interactive', isCustomEntryNode: true, isConsentRequest: true, templateStatus: 'approved', templateVersion: 2,
      footer: 'Reply STOP to unsubscribe', buttonLabel: 'No thanks',
      buttons: [{ position: 0, label: 'Yes', action: 'opt_in', replyText: null }, { position: 1, label: 'No thanks', action: 'opt_out', replyText: 'Bye' }],
    });
    expect(p.body).toMatch(/^Hi Valued Customer, want offers/);
  });
  test('a consent request with no message yet says so instead of previewing a default announcement', async () => {
    Promotion.findOne.mockReturnValue(query({ ...makePromotion(), products: [{ name: 'Beans', basePrice: 10 }], services: [] }));
    const p = await ops.previewPromotionMessage({ promotionId: new Types.ObjectId(), workspaceId: WS });
    expect(p).toMatchObject({ isConsentRequest: true, needsMessage: true, buttons: [], body: '' });
  });
});
