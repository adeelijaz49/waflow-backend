const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// DB-backed integration tests for the 24-hour-window routing of promotion sends (shared/promoWindow.js, used by
// shared/operations.js#sendPromotion and #sendTestMessage), Meta's real error text on refused sends, and the delivery summary
// (GET /api/promotions/:id/delivery). The real operations run against the throwaway mongod; every outbound WhatsApp call is
// captured by an axios adapter stub (nothing leaves the machine). Every test uses its own workspace; nothing is ever deleted.
//
// Why: WhatsApp only delivers a free-form (interactive) message to a customer who wrote to the business number in the last
// 24 hours. Meta ACCEPTS an out-of-window one (HTTP 200 + message id) and refuses it a second later through the status webhook
// (131047), so the old code reported "sent" and never reached its template fallback. Now a customer outside the window gets
// the approved template (waflow_promo_v2) directly; a customer inside it gets exactly the same chat-style message as before.
const fx = require('./_fixtures');
// Real (stubbed) HTTP, not dry-run: the English path goes through utils/whatsapp, the Arabic one through transport.js, and both
// end in the same axios stub, so ONE recorder sees every message in order.
process.env.LOCALIZATION_SEND_MODE = '';
const axios = require('axios');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const calls = [];
let wamidSeq = 0;
let failRules = [];
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  const rec = { method: String(config.method || '').toUpperCase(), url: String(config.url || ''), body: body === undefined ? null : body };
  calls.push(rec);
  for (const rule of failRules) {
    if (rule.remaining !== 0 && rule.match(rec)) {
      if (rule.remaining > 0) rule.remaining -= 1;
      if (rule.noResponse) throw new axios.AxiosError('socket hang up', 'ECONNRESET', config); // a network error: no Meta body at all
      const response = { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: rule.message || 'Meta stub rejected this call', code: rule.code, type: 'OAuthException' } } };
      throw new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, {}, response);
    }
  }
  const isMessage = /\/messages$/.test(rec.url);
  let data;
  if (rec.method === 'GET' && config.params && config.params.fields === 'display_phone_number') data = { display_phone_number: '+1 555 000 0000', id: '111111111111111' };
  else if (rec.method === 'GET') data = { data: [] };
  else if (isMessage) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.W${++wamidSeq}_${Date.now()}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const isMessage = (rec) => /\/messages$/.test(rec.url) && rec.method === 'POST';
const ofType = (type) => (rec) => isMessage(rec) && rec.body && rec.body.type === type;
const sent = () => calls.filter(isMessage).map((c) => c.body);
const sentTo = (customer) => sent().filter((m) => m.to === customer.phone);
const reset = () => { calls.length = 0; failRules = []; };

const ops = require('../../../shared/operations');
const settingsCache = require('../../../utils/settingsCache');
const { requireAuth } = require('../../../middleware/requireAuth');
const Customer = require('../../../models/Customer');
const CampaignMessage = require('../../../models/CampaignMessage');
const WhatsAppMessage = require('../../../models/WhatsAppMessage');
const Promotion = require('../../../models/Promotion');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const MessageNode = require('../../../models/MessageNode');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const jwt = require('jsonwebtoken');

jest.setTimeout(120000);

const HOUR = 60 * 60 * 1000;
let savedSwitch;

beforeAll(async () => {
  await fx.connect();
  for (const name of ['Promotion', 'Product', 'Service', 'WhatsAppMessage']) {
    try { await require(`../../../models/${name}`).init(); } catch (e) { /* index build is best effort here */ }
  }
  await fx.makeWorkspace({ arabic: false, merchantName: 'Aroma Cafe' }); // the first Settings in this database feeds settingsCache
});
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => {
  reset(); settingsCache.invalidate();
  savedSwitch = process.env.PROMO_DELIVERY_FIX;
  delete process.env.PROMO_DELIVERY_FIX; // the fix is on unless a test turns it off
});
afterEach(() => {
  jest.restoreAllMocks();
  if (savedSwitch === undefined) delete process.env.PROMO_DELIVERY_FIX; else process.env.PROMO_DELIVERY_FIX = savedSwitch;
});

async function world({ arabic = false, withProduct = true } = {}) {
  const ws = await fx.makeWorkspace({ arabic, merchantName: 'Aroma Cafe' });
  const product = withProduct ? await Product.create({ workspaceId: ws.workspaceId, name: 'Coffee beans', category: 'Coffee', basePrice: 50 }) : null;
  return { ws, product };
}
const promo = (ws, product, over = {}) => Promotion.create({
  workspaceId: ws.workspaceId, name: 'Summer Sale', customerType: 'cash', scope: 'products', type: 'specific_products',
  products: product ? [product._id] : [], discountPercent: 20, status: 'draft', endDate: new Date(Date.UTC(2026, 10, 30)), ...over,
});
const cust = (ws, over = {}) => fx.makeCustomer(ws.workspaceId, { firstname: 'Bob', lastname: 'Smith', ...over });
// A customer message to the business, `hoursAgo` hours ago (what the inbound webhook stores).
const wrote = (customer, hoursAgo, over = {}) => WhatsAppMessage.create({
  workspaceId: customer.workspaceId, customer: customer._id, phone: String(customer.phone).replace(/\D/g, ''), direction: 'inbound',
  messageType: 'manual', messageBody: 'hi', wamid: `wamid.IN_${fx.uniq()}`, receivedAt: new Date(Date.now() - hoursAgo * HOUR), deliveryStatus: 'delivered', ...over,
});
const send = (ws, p, customers) => ops.sendPromotion({ promotionId: String(p._id), customerIds: customers.map((c) => String(c._id)), workspaceId: ws.workspaceId });
const rowOf = (p, c) => CampaignMessage.findOne({ promotion: p._id, customer: c._id }).sort({ createdAt: -1 }).lean();
const errs = (out) => out.errors.map((e) => ({ customer: String(e.customer), error: e.error }));
const bodyParams = (message) => (((message.template && message.template.components) || []).find((c) => c.type === 'body') || { parameters: [] }).parameters.map((x) => x.text);

describe('sendPromotion: 24-hour window routing', () => {
  test('a customer who wrote 2 hours ago gets the same chat-style (interactive) message as before - nothing changes for them', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    await wrote(a, 2);
    const out = await send(ws, p, [a]);
    expect(out).toMatchObject({ success: true, sentCount: 1, errors: [] });
    expect(sentTo(a)).toHaveLength(1);
    expect(sentTo(a)[0].type).toBe('interactive');
    expect(sent().filter((m) => m.type === 'template')).toHaveLength(0);
    const row = await rowOf(p, a);
    expect(row).toMatchObject({ messageType: 'interactive', status: 'sent' });
    expect(row.templateName).toBeUndefined();
    expect(row.wamid).toMatch(/^wamid\./);
  });

  test('a customer who wrote 30 hours ago, and one who never wrote, get the approved template waflow_promo_v2 instead', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const old = await cust(ws, { firstname: 'Olga' });
    const never = await cust(ws, { firstname: 'Nina' });
    await wrote(old, 30);
    const out = await send(ws, p, [old, never]);
    expect(out).toMatchObject({ success: true, sentCount: 2, errors: [] });
    expect(sent().filter((m) => m.type === 'interactive')).toHaveLength(0);
    for (const [c, name] of [[old, 'Olga'], [never, 'Nina']]) {
      const [m] = sentTo(c);
      expect(m.type).toBe('template');
      expect(m.template.name).toBe('waflow_promo_v2');
      expect(m.template.language.code).toBe('en');
      expect(bodyParams(m).slice(0, 3)).toEqual([name, 'Coffee beans', '20']);
      const payloads = m.template.components.filter((x) => x.type === 'button').map((x) => x.parameters[0].payload);
      expect(payloads).toEqual([`promo_${p._id}`, `optout_${p._id}`]);
      const row = await rowOf(p, c);
      expect(row).toMatchObject({ messageType: 'template', templateName: 'waflow_promo_v2', status: 'sent' });
    }
  });

  test('a mixed audience in ONE run: each customer is routed on their own last message', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const [fresh, recent, stale, never] = [await cust(ws), await cust(ws), await cust(ws), await cust(ws)];
    await wrote(fresh, 0.1); await wrote(recent, 22); await wrote(stale, 40);
    const out = await send(ws, p, [fresh, recent, stale, never]);
    expect(out.sentCount).toBe(4);
    const typeOf = (c) => sentTo(c)[0].type;
    expect([typeOf(fresh), typeOf(recent), typeOf(stale), typeOf(never)]).toEqual(['interactive', 'interactive', 'template', 'template']);
  });

  test('the last hour of the window counts as closed: 22.5 h is inside, 23.5 h is outside', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const inside = await cust(ws); const edge = await cust(ws);
    await wrote(inside, 22.5); await wrote(edge, 23.5);
    await send(ws, p, [inside, edge]);
    expect(sentTo(inside)[0].type).toBe('interactive');
    expect(sentTo(edge)[0].type).toBe('template');
  });

  test('a phone stored as "+971 50 123 4567" still matches the digits-only number WhatsApp reports; `to` stays exactly as stored', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws, { phone: '+971 50 123 4567' });
    await wrote(a, 1, { phone: '971501234567' });
    await send(ws, p, [a]);
    expect(sentTo(a)).toHaveLength(1);
    expect(sentTo(a)[0].type).toBe('interactive');
    expect(sentTo(a)[0].to).toBe('+971 50 123 4567');
  });

  test('another workspace\'s conversation with the same phone number does not open the window (tenant isolation)', async () => {
    const { ws, product } = await world();
    const other = await fx.makeWorkspace({ arabic: false });
    const p = await promo(ws, product);
    const mine = await cust(ws);
    const theirs = await fx.makeCustomer(other.workspaceId, { phone: mine.phone });
    await wrote(theirs, 0.5);
    await send(ws, p, [mine]);
    expect(sentTo(mine)[0].type).toBe('template');
  });

  test('only INBOUND messages count: a manual outbound message in the last hour does not open the window', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    await wrote(a, 0.2, { direction: 'outbound' });
    await send(ws, p, [a]);
    expect(sentTo(a)[0].type).toBe('template');
  });

  test('a services promotion goes out as the template too (name and price come from the service)', async () => {
    const { ws } = await world();
    const svc = await Service.create({ workspaceId: ws.workspaceId, name: 'Classic Haircut', duration: 45, basePrice: 60 });
    const p = await Promotion.create({ workspaceId: ws.workspaceId, name: 'Get a 50% off this season', customerType: 'cash', scope: 'services', type: 'specific_services', services: [svc._id], discountPercent: 50, status: 'draft' });
    const a = await cust(ws);
    const out = await send(ws, p, [a]);
    expect(out).toMatchObject({ sentCount: 1, errors: [] });
    const [m] = sentTo(a);
    expect(m.template.name).toBe('waflow_promo_v2');
    expect(bodyParams(m).slice(0, 4)).toEqual(['Bob', 'Classic Haircut', '50', '30.00']);
  });

  test("template refused for an outside-window customer: Meta's own reason and code are recorded and reported, and NO chat-style message is tried (it would only be accepted and refused again, hiding the reason)", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    failRules.push({ match: ofType('template'), remaining: -1, code: 132015, message: '(#132015) Template is paused' });
    const out = await send(ws, p, [a]);
    expect(out.sentCount).toBe(0);
    expect(errs(out)).toEqual([{ customer: String(a._id), error: '(#132015) Template is paused' }]);
    expect(sent().map((m) => m.type)).toEqual(['template']);
    const row = await rowOf(p, a);
    expect(row).toMatchObject({ status: 'failed', messageType: 'template', templateName: 'waflow_promo_v2', statusReason: '(#132015) Template is paused', errorCode: '132015' });
    expect(row.wamid).toBeUndefined();
  });

  test('one refused customer does not stop the others in the same run', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const [a, b] = [await cust(ws), await cust(ws)];
    failRules.push({ match: (rec) => ofType('template')(rec) && rec.body.to === a.phone, remaining: -1, code: 132015, message: '(#132015) Template is paused' });
    const out = await send(ws, p, [a, b]);
    expect(out.sentCount).toBe(1);
    expect(out.errors).toHaveLength(1);
    expect((await rowOf(p, a)).status).toBe('failed');
    expect((await rowOf(p, b)).status).toBe('sent');
  });

  test('inside the window, chat-style refused and template fallback refused: Meta\'s reason and code are recorded too', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    await wrote(a, 1);
    failRules.push({ match: ofType('interactive'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    failRules.push({ match: ofType('template'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    const out = await send(ws, p, [a]);
    expect(out.sentCount).toBe(0);
    expect(errs(out)).toEqual([{ customer: String(a._id), error: '(#133010) Account not registered' }]);
    expect(await rowOf(p, a)).toMatchObject({ status: 'failed', statusReason: '(#133010) Account not registered', errorCode: '133010' });
  });

  test('a points promotion has no template: still the chat-style message for everyone, and a refusal shows Meta\'s reason', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product, { customerType: 'points', pointsPrice: 100, discountPercent: 0 });
    const a = await cust(ws, { loyaltyPoints: 500 });
    failRules.push({ match: ofType('interactive'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    failRules.push({ match: ofType('text'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    const out = await send(ws, p, [a]);
    expect(sent().some((m) => m.type === 'template')).toBe(false);
    expect(out.sentCount).toBe(0);
    expect(errs(out)).toEqual([{ customer: String(a._id), error: '(#133010) Account not registered' }]);
    expect(await rowOf(p, a)).toMatchObject({ status: 'failed', statusReason: '(#133010) Account not registered', errorCode: '133010' });
  });

  test('a points promotion to a customer outside the window is attempted exactly as before (no template exists for it)', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product, { customerType: 'points', pointsPrice: 100, discountPercent: 0 });
    const a = await cust(ws, { loyaltyPoints: 500 });
    const out = await send(ws, p, [a]);
    expect(out.sentCount).toBe(1);
    expect(sentTo(a)[0].type).toBe('interactive');
  });

  test('demo customers never reach WhatsApp (unchanged)', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const d = await cust(ws, { isDemo: true });
    const out = await send(ws, p, [d]);
    expect(out).toMatchObject({ sentCount: 1, demoCount: 1 });
    expect(sent()).toHaveLength(0);
  });

  test('KILL SWITCH PROMO_DELIVERY_FIX=off: exactly the previous behaviour - no lookup, chat-style message for an outside-window customer, bare axios error text, no code', async () => {
    process.env.PROMO_DELIVERY_FIX = 'off';
    const spy = jest.spyOn(WhatsAppMessage, 'distinct');
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    const out = await send(ws, p, [a]);
    expect(out.sentCount).toBe(1);
    expect(sentTo(a)[0].type).toBe('interactive');
    expect(spy).not.toHaveBeenCalled();

    reset();
    const b = await cust(ws);
    failRules.push({ match: ofType('interactive'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    failRules.push({ match: ofType('template'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    const out2 = await send(ws, p, [b]);
    expect(errs(out2)).toEqual([{ customer: String(b._id), error: 'Request failed with status code 400' }]);
    const row = await rowOf(p, b);
    expect(row.statusReason).toBe('Request failed with status code 400');
    expect(row.errorCode).toBeUndefined();
  });

  test('a failed inbound lookup (database error) falls back to the previous behaviour instead of breaking the send', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(WhatsAppMessage, 'distinct').mockRejectedValueOnce(new Error('db down'));
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    const out = await send(ws, p, [a]);
    expect(out).toMatchObject({ sentCount: 1, errors: [] });
    expect(sentTo(a)[0].type).toBe('interactive');
    expect(quiet).toHaveBeenCalled();
  });
  test('an inbound row that lacks receivedAt falls back to createdAt (recent = inside the window, stale = outside)', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const [recent, stale] = [await cust(ws), await cust(ws)];
    const row = (c, hoursAgo) => ({
      workspaceId: c.workspaceId, customer: c._id, phone: String(c.phone).replace(/\D/g, ''), direction: 'inbound', messageType: 'manual',
      messageBody: 'hi', wamid: `wamid.IN_${fx.uniq()}`, createdAt: new Date(Date.now() - hoursAgo * HOUR), updatedAt: new Date(),
    });
    await mongoose.connection.db.collection('whatsappmessages').insertMany([row(recent, 1), row(stale, 40)]); // no receivedAt on either
    await send(ws, p, [recent, stale]);
    expect(sentTo(recent)[0].type).toBe('interactive');
    expect(sentTo(stale)[0].type).toBe('template');
  });

  test('an Arabic customer of a flagged merchant is still served by the Arabic path, outside the window too; the English customers around them are routed by the window', async () => {
    const { ws, product } = await world({ arabic: true });
    const p = await promo(ws, product);
    const tag = fx.uniq();
    const tpl = await LocalizedTemplate.create({
      workspaceId: ws.workspaceId, key: `pw-${tag}`, name: `Arabic promotion ${tag}`, useCase: 'promotion', category: 'MARKETING', linkedPromotionId: p._id,
      variants: [
        { language: 'en', body: 'Hi {name}', buttons: [{ role: 'opt_out', text: 'Opt Out' }], metaStatus: 'NOT_CREATED' },
        {
          language: 'ar', body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name}', buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { role: 'opt_out', text: 'إلغاء الاشتراك' }],
          metaTemplateName: `wf_pw_${tag}_ar_v1`, metaLanguage: 'ar', metaStatus: 'APPROVED', reviewStatus: 'reviewed', reviewedBy: 'Native Reviewer',
        },
      ],
    });
    const arabic = await cust(ws, { language: 'ar', firstname: 'سارة', lastname: 'الأحمد' });
    const coldEn = await cust(ws, { firstname: 'Cold' });
    const warmEn = await cust(ws, { firstname: 'Warm' });
    await wrote(warmEn, 1);
    const out = await send(ws, p, [arabic, coldEn, warmEn]);
    expect(out).toMatchObject({ sentCount: 3, errors: [] });
    expect(sentTo(arabic)).toHaveLength(1);
    expect(sentTo(arabic)[0].template.name).toBe(tpl.variants[1].metaTemplateName); // the Arabic template, never waflow_promo_v2
    expect(sentTo(coldEn)[0].template.name).toBe('waflow_promo_v2');
    expect(sentTo(warmEn)[0].type).toBe('interactive');
  });

  test('a promotion with nothing to show (no items): no window lookup and no template (it needs an item) - the previous path', async () => {
    const spy = jest.spyOn(WhatsAppMessage, 'distinct');
    const { ws } = await world({ withProduct: false });
    const p = await promo(ws, null);
    const a = await cust(ws);
    const out = await send(ws, p, [a]);
    expect(spy).not.toHaveBeenCalled();
    expect(sent().some((m) => m.type === 'template')).toBe(false);
    expect(out.sentCount + out.errors.length).toBe(1);
  });

  test("a promotion with an approved custom entry message is untouched by the window: its own template for everyone, Meta's reason and code when refused", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const node = await MessageNode.create({
      workspaceId: ws.workspaceId, ownerType: 'promotion', ownerId: p._id, isEntryNode: true, bodyText: 'Hi {{1}}, {{2}} for {{3}}',
      templateName: `wf_entry_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.updateOne({ _id: p._id }, { entryNodeId: node._id });
    const [a, b] = [await cust(ws), await cust(ws)];
    failRules.push({ match: (rec) => ofType('template')(rec) && rec.body.to === b.phone, remaining: -1, code: 132015, message: '(#132015) Template is paused' });
    const out = await send(ws, p, [a, b]);
    expect(out.sentCount).toBe(1);
    expect(sentTo(a)[0].template.name).toBe(node.templateName);
    expect(errs(out)).toEqual([{ customer: String(b._id), error: '(#132015) Template is paused' }]);
    expect(await rowOf(p, b)).toMatchObject({ status: 'failed', messageType: 'template', templateName: node.templateName, statusReason: '(#132015) Template is paused', errorCode: '132015' });
  });

  test("a points promotion failing with a NETWORK error (no Meta body) keeps the previous 'Send failed' and records no code", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product, { customerType: 'points', pointsPrice: 100, discountPercent: 0 });
    const a = await cust(ws, { loyaltyPoints: 500 });
    failRules.push({ match: ofType('interactive'), remaining: -1, noResponse: true });
    failRules.push({ match: ofType('text'), remaining: -1, noResponse: true });
    const out = await send(ws, p, [a]);
    expect(errs(out)).toEqual([{ customer: String(a._id), error: 'Send failed' }]);
    const row = await rowOf(p, a);
    expect(row.statusReason).toBe('Send failed');
    expect(row.errorCode).toBeUndefined();
  });

  test("kill switch off, points promotion refused by Meta: 'Send failed' and no code, exactly as before", async () => {
    process.env.PROMO_DELIVERY_FIX = 'off';
    const { ws, product } = await world();
    const p = await promo(ws, product, { customerType: 'points', pointsPrice: 100, discountPercent: 0 });
    const a = await cust(ws, { loyaltyPoints: 500 });
    failRules.push({ match: ofType('interactive'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    failRules.push({ match: ofType('text'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    const out = await send(ws, p, [a]);
    expect(errs(out)).toEqual([{ customer: String(a._id), error: 'Send failed' }]);
    const row = await rowOf(p, a);
    expect(row.statusReason).toBe('Send failed');
    expect(row.errorCode).toBeUndefined();
  });
});

describe('sendTestMessage: same routing, Meta\'s real error text', () => {
  test('a phone that has not written recently gets the template; one that wrote an hour ago gets the chat-style message', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const known = await cust(ws);
    await wrote(known, 1);
    const stranger = fx.nextPhone();
    await ops.sendTestMessage({ promotionId: String(p._id), phone: stranger, workspaceId: ws.workspaceId });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: stranger, type: 'template' });
    expect(sent()[0].template.name).toBe('waflow_promo_v2');

    reset();
    await ops.sendTestMessage({ promotionId: String(p._id), phone: known.phone, workspaceId: ws.workspaceId });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: known.phone, type: 'interactive' });
  });

  test("a refused test message throws Meta's reason, not 'Request failed with status code 400'", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    failRules.push({ match: ofType('template'), remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    await expect(ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId })).rejects.toThrow('(#133010) Account not registered');
  });

  test('kill switch off: the test message is the chat-style one for every phone', async () => {
    process.env.PROMO_DELIVERY_FIX = 'off';
    const { ws, product } = await world();
    const p = await promo(ws, product);
    await ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].type).toBe('interactive');
  });
  test('a points promotion: the chat-style message as before (there is no template for it)', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product, { customerType: 'points', pointsPrice: 100, discountPercent: 0 });
    const phone = fx.nextPhone();
    await ops.sendTestMessage({ promotionId: String(p._id), phone, workspaceId: ws.workspaceId });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({ to: phone, type: 'interactive' });
  });

  test('a promotion with an approved custom entry message: that template, whatever the window', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const node = await MessageNode.create({
      workspaceId: ws.workspaceId, ownerType: 'promotion', ownerId: p._id, isEntryNode: true, bodyText: 'Hi {{1}}, {{2}} for {{3}}',
      templateName: `wf_entry_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.updateOne({ _id: p._id }, { entryNodeId: node._id });
    await ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId });
    expect(sent()).toHaveLength(1);
    expect(sent()[0].template.name).toBe(node.templateName);
  });

  test('an error without a Meta body (network) is rethrown untouched, with the kill switch on or off', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    failRules.push({ match: isMessage, remaining: -1, noResponse: true });
    await expect(ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId })).rejects.toThrow('socket hang up');
    process.env.PROMO_DELIVERY_FIX = 'off';
    await expect(ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId })).rejects.toThrow('socket hang up');
  });

  test("a Meta refusal throws a new error with Meta's text and keeps the original as its cause", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    failRules.push({ match: isMessage, remaining: -1, code: 133010, message: '(#133010) Account not registered' });
    const err = await ops.sendTestMessage({ promotionId: String(p._id), phone: fx.nextPhone(), workspaceId: ws.workspaceId }).catch((e) => e);
    expect(err.message).toBe('(#133010) Account not registered');
    expect(err.cause && err.cause.response && err.cause.response.status).toBe(400);
  });
});

describe('GET /api/promotions/:id/delivery', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/promotions', requireAuth, require('../../../routes/promotions'));
  const get = (url, auth) => { const r = request(app).get(url); return auth ? r.set(auth) : r; };

  test('accepted vs delivered vs refused, with the reasons in plain language', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const cs = [];
    for (let i = 0; i < 5; i += 1) cs.push(await cust(ws));
    await send(ws, p, cs);
    // what the status webhook would have written afterwards
    const upd = (c, set, unset) => CampaignMessage.updateOne({ promotion: p._id, customer: c._id }, { $set: set, ...(unset ? { $unset: unset } : {}) });
    await upd(cs[0], { status: 'read' });
    await upd(cs[1], { status: 'delivered' });
    await upd(cs[2], { status: 'failed', errorCode: '131047', statusReason: 'Re-engagement message' });
    // cs[3] stays 'sent' (waiting for WhatsApp)
    await upd(cs[4], { status: 'failed', statusReason: 'Request failed with status code 400' }, { wamid: 1 });

    const res = await get(`/api/promotions/${p._id}/delivery`, ws.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 5, accepted: 4, delivered: 2, read: 1, waiting: 1, failed: 2, failedAfterAccepted: 1, rejectedImmediately: 1, viaTemplate: 4, since: null,
    });
    const windowFailure = res.body.failures.find((f) => f.code === '131047');
    expect(windowFailure).toMatchObject({ group: 'window', count: 1 });
    expect(windowFailure.label).toMatch(/24-hour window/);
    expect(res.body.failures).toHaveLength(2);
  });

  test('sinceSeconds limits the summary to one send (older rows are left out)', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const first = await cust(ws);
    await send(ws, p, [first]);
    await mongoose.connection.db.collection('campaignmessages').updateMany({ promotion: p._id }, { $set: { createdAt: new Date(Date.now() - 3 * HOUR) } });
    const second = await cust(ws);
    await send(ws, p, [second]);

    const all = await get(`/api/promotions/${p._id}/delivery`, ws.auth);
    expect(all.body.total).toBe(2);
    const latest = await get(`/api/promotions/${p._id}/delivery?sinceSeconds=600`, ws.auth);
    expect(latest.body.total).toBe(1);
    expect(latest.body.since).toEqual(expect.any(String));
    const byDate = await get(`/api/promotions/${p._id}/delivery?since=${encodeURIComponent(new Date(Date.now() - 600 * 1000).toISOString())}`, ws.auth);
    expect(byDate.body.total).toBe(1);
  });

  test("another workspace cannot read it (404), an unknown or malformed id is a 404, and it needs a login", async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const other = await fx.makeWorkspace({ arabic: false });
    expect((await get(`/api/promotions/${p._id}/delivery`, other.auth)).status).toBe(404);
    expect((await get(`/api/promotions/${new mongoose.Types.ObjectId()}/delivery`, ws.auth)).status).toBe(404);
    expect((await get('/api/promotions/not-an-id/delivery', ws.auth)).status).toBe(404);
    expect((await get(`/api/promotions/${p._id}/delivery`)).status).toBe(401);
  });

  test('a promotion nothing was sent for: all zeros', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const res = await get(`/api/promotions/${p._id}/delivery`, ws.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, accepted: 0, delivered: 0, failed: 0, failures: [] });
  });
  test('query parsing: odd or malicious values never break the summary and fall back to the whole promotion', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const a = await cust(ws);
    await send(ws, p, [a]);
    const total = async (q) => get(`/api/promotions/${p._id}/delivery${q}`, ws.auth);
    for (const q of ['?sinceSeconds=0', '?sinceSeconds=-5', '?sinceSeconds=abc', '?sinceSeconds=', '?since=garbage', '?since[$gt]=x', '?sinceSeconds[$gt]=1']) {
      const r = await total(q);
      expect([q, r.status]).toEqual([q, 200]);
      expect([q, r.body.total]).toEqual([q, 1]);
    }
    expect((await total('?sinceSeconds=999999999')).body.total).toBe(1); // capped at 7 days, still includes this send
    const both = await total(`?sinceSeconds=600&since=${encodeURIComponent(new Date(Date.now() + 3600 * 1000).toISOString())}`);
    expect(both.body.total).toBe(1); // sinceSeconds wins over since
  });

  // The short-lived pre-login token is now turned away by requireAuth itself (401, before any route runs); it used to reach the
  // route, which answered 403. Either way it never reads across tenants (the route keeps its own 403 as a second guard).
  test('a token without a workspace (the short-lived pre-login one) is refused with 401 and never reads across tenants', async () => {
    const { ws, product } = await world();
    const p = await promo(ws, product);
    const { JWT_SECRET, ISSUER, AUDIENCE } = require('../../../middleware/requireAuth');
    const pre = jwt.sign({ sub: String(ws.user._id), preAuth: true }, JWT_SECRET, { expiresIn: '10m', issuer: ISSUER, audience: AUDIENCE });
    const res = await get(`/api/promotions/${p._id}/delivery`, { Authorization: `Bearer ${pre}` });
    expect(res.status).toBe(401);
    expect(res.body.total).toBeUndefined();
  });
});
