const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// This suite characterises the sending behaviour as it was BEFORE the 24-hour-window delivery fix (docs/promo-delivery-fix.md), so it
// runs with the fix's kill switch off. The fix itself is covered by promoWindowRouting.itest.js.
process.env.PROMO_DELIVERY_FIX = 'off';
// An unapproved custom message used to fall back to the default message silently; it is now refused (and submitted to Meta)
// unless this kill switch is on. This suite pins the old behaviour, so it keeps the switch on.
process.env.PROMO_ENTRY_FALLBACK = 'on';

// DB-backed integration tests for the Arabic delivery of the EXISTING senders (D1): the real shared/operations.js
// sendPromotion / sendLoyaltyReminders / sendConsentRequests / booking notices and the referral link text run against the
// throwaway mongod; every outbound WhatsApp call is captured by an axios adapter stub (nothing leaves the machine) and the
// inbound webhook hook is the real one. Every test uses its own workspace; nothing is ever deleted.
//
// Spec acceptance (Phase 1/2 "done when"): an Arabic-language and an English customer in the SAME run - the Arabic one gets
// the Arabic template with the correct opt-out payload, the English one the unchanged English template; replying the
// Arabic opt-out word opts the Arabic customer out immediately; the fallback path (no variant) is the English message
// exactly as today; demo customers are unaffected; three consecutive template-level errors stop the Arabic customers.
const fx = require('./_fixtures');
// Real (stubbed) HTTP, not dry-run: the English path goes through utils/whatsapp, the Arabic one through transport.js, and
// both end in the same axios stub, so ONE recorder sees every message in order.
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
      const response = { status: 400, statusText: 'Bad Request', headers: {}, config, data: { error: { message: rule.message || 'Meta stub rejected this call', code: rule.code, type: 'OAuthException' } } };
      throw new axios.AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', config, {}, response);
    }
  }
  const isMessage = /\/messages$/.test(rec.url);
  let data;
  if (rec.method === 'GET' && config.params && config.params.fields === 'display_phone_number') data = { display_phone_number: '+1 555 000 0000', id: '111111111111111' };
  else if (rec.method === 'GET') data = { data: [] };
  else if (isMessage) data = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.L${++wamidSeq}` }] };
  else data = { id: `stub${++wamidSeq}` };
  return { data, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const isMessage = (rec) => /\/messages$/.test(rec.url) && rec.method === 'POST';
const messages = () => calls.filter(isMessage).map((c) => c.body);
const messagesTo = (phone) => messages().filter((m) => m.to === phone);
const reset = () => { calls.length = 0; failRules = []; };

const ops = require('../../../shared/operations');
const settings = require('../../../shared/localization/settings');
const settingsCache = require('../../../utils/settingsCache');
const hook = require('../../../shared/localization/inboundHook');
const legacy = require('../../../shared/localization/legacySenders');
const plan = require('../../../shared/localization/legacyPlan');
const Customer = require('../../../models/Customer');
const CustomerLanguage = require('../../../models/CustomerLanguage');
const CampaignMessage = require('../../../models/CampaignMessage');
const LocalizedTemplate = require('../../../models/LocalizedTemplate');
const LocalizedLegacySend = require('../../../models/LocalizedLegacySend');
const Promotion = require('../../../models/Promotion');
const Product = require('../../../models/Product');
const Service = require('../../../models/Service');
const TimeSlot = require('../../../models/TimeSlot');
const Booking = require('../../../models/Booking');
const Settings = require('../../../models/Settings');

jest.setTimeout(120000);

let first; // the workspace whose Settings (currency SAR) is the first one in this database: settingsCache reads that one

beforeAll(async () => {
  await fx.connect();
  for (const name of ['Promotion', 'Product', 'Service', 'TimeSlot', 'Booking', 'LocalizedLegacySend', 'MessageNode']) {
    try { await require(`../../../models/${name}`).init(); } catch (e) { /* index build is best effort here */ }
  }
  first = await fx.makeWorkspace({ merchantName: 'Aroma Cafe' });
  await Settings.updateOne({ workspaceId: first.workspaceId }, { $set: { currency: 'SAR' } });
  settingsCache.invalidate();
});
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { reset(); settingsCache.invalidate(); });

const OPT_OUT_AR = { role: 'opt_out', text: 'إلغاء الاشتراك' };

// An approved + reviewed Arabic version (plus the English mirror) as a native-reviewed, Meta-approved fixture.
async function arabicTemplate(workspaceId, { useCase, body, buttons, linkedPromotionId, linkedMessageNodeId, name, category = 'MARKETING', footer }) {
  const tag = fx.uniq();
  return LocalizedTemplate.create({
    workspaceId, key: `ima-${tag}`, name: name || `Arabic ${useCase} ${tag}`, useCase, category,
    ...(linkedPromotionId ? { linkedPromotionId } : {}), ...(linkedMessageNodeId ? { linkedMessageNodeId } : {}),
    variants: [
      { language: 'en', body: 'Hi {name}', buttons: [{ role: 'opt_out', text: 'Opt Out' }], metaStatus: 'NOT_CREATED' },
      {
        language: 'ar', body, buttons, ...(footer ? { footer } : {}), metaTemplateName: `wf_ima_${tag}_ar_v1`, metaLanguage: 'ar', metaStatus: 'APPROVED', reviewStatus: 'reviewed', reviewedBy: 'Native Reviewer',
      },
    ],
  });
}

async function world({ withProduct = true } = {}) {
  const ws = await fx.makeWorkspace({ merchantName: 'Aroma Cafe' });
  const product = withProduct ? await Product.create({ workspaceId: ws.workspaceId, name: 'Coffee beans', category: 'Coffee', basePrice: 50 }) : null;
  return { ws, product };
}

const promo = (ws, product, over = {}) => Promotion.create({
  workspaceId: ws.workspaceId, name: 'Summer Sale', customerType: 'cash', scope: 'products', type: 'specific_products',
  products: [product._id], discountPercent: 20, status: 'draft', endDate: new Date(Date.UTC(2026, 10, 30)), ...over,
});

const ar = (ws, over = {}) => fx.makeCustomer(ws.workspaceId, { language: 'ar', firstname: 'سارة', lastname: 'الأحمد', ...over });
const en = (ws, over = {}) => fx.makeCustomer(ws.workspaceId, { firstname: 'Bob', lastname: 'Smith', ...over });
const buttonPayloads = (message) => ((message.template && message.template.components) || []).filter((c) => c.type === 'button').map((c) => c.parameters[0].payload);
const bodyParams = (message) => (((message.template && message.template.components) || []).find((c) => c.type === 'body') || { parameters: [] }).parameters.map((p) => p.text);

describe('loyalty reminder: an Arabic and an English customer in the SAME run (spec Phase 1 scenario)', () => {
  test('Arabic customer: the Arabic template with the Arabic opt-out payload; English customer: the unchanged English template; typed Arabic opt-out opts out at once; the next run skips them', async () => {
    const { ws } = await world({ withProduct: false });
    const tpl = await arabicTemplate(ws.workspaceId, {
      useCase: 'loyalty_reminder', buttons: [{ ...OPT_OUT_AR }], footer: 'لإلغاء الاشتراك أرسل: إلغاء الاشتراك',
      body: 'أهلاً {name}، نقاط ولائك بانتظارك 💎\n\nرصيدك الحالي من النقاط: {points}، وقيمته {amount}. زرنا واستخدمها في مشترياتك القادمة، يسعدنا استقبالك!',
    });
    const arabic = await ar(ws, { loyaltyPoints: 125 });
    const english = await en(ws, { loyaltyPoints: 80 });

    const out = await ops.sendLoyaltyReminders({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id), String(english._id)] });
    expect(out).toMatchObject({ success: true, sentCount: 2, skippedOptedOut: 0, skippedNoConsent: 0, demoCount: 0, languageCounts: { ar: 1, en: 1 } });
    expect(out.localization).toMatchObject({ arabicCustomers: 1, arabicSent: 1, arabicFailed: 0, fallbackToEnglish: [], excludedOptedOutPhone: 0 });
    expect(Object.keys(out).slice(0, 5)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']); // existing keys first, same order

    // the Arabic customer
    const arMessages = messagesTo(arabic.phone);
    expect(arMessages).toHaveLength(1);
    const arMsg = arMessages[0];
    expect(arMsg.type).toBe('template');
    expect(arMsg.template.name).toBe(tpl.variants[1].metaTemplateName);
    expect(arMsg.template.language).toEqual({ code: 'ar' });
    expect(bodyParams(arMsg)).toEqual(['سارة', '125', '12.50 ر.س']);
    expect(buttonPayloads(arMsg)).toEqual(['optout_loyalty_reminder']);

    // the English customer: exactly the English loyalty template as before (waflow loyalty, language en, 4 params, no buttons)
    const enMessages = messagesTo(english.phone);
    expect(enMessages).toHaveLength(1);
    expect(enMessages[0].template.language).toEqual({ code: 'en' });
    expect(bodyParams(enMessages[0])).toEqual(['Bob', '80', '8.00', 'SAR']);
    expect(buttonPayloads(enMessages[0])).toEqual([]);

    // CampaignMessage rows written by the existing code: same kind/template/wamid bookkeeping for both
    const rows = await CampaignMessage.find({ workspaceId: ws.workspaceId, kind: 'loyalty_reminder' }).lean();
    expect(rows).toHaveLength(2);
    const arRow = rows.find((r) => String(r.customer) === String(arabic._id));
    expect(arRow).toMatchObject({ status: 'sent', messageType: 'template', templateName: tpl.variants[1].metaTemplateName, phone: arabic.phone });
    expect(arRow.wamid).toMatch(/^wamid\.L/);
    expect(rows.find((r) => String(r.customer) === String(english._id)).templateName).not.toBe(tpl.variants[1].metaTemplateName);

    // sidecar language rows exist ONLY for the Arabic customer
    const sidecar = await LocalizedLegacySend.find({ workspaceId: ws.workspaceId }).lean();
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]).toMatchObject({ sender: 'loyalty_reminder', customerId: arabic._id, usedLanguage: 'ar', status: 'sent', via: 'template', wamid: arRow.wamid });
    expect(sidecar[0].phone).toBeUndefined(); // review R4-3: no phone number on the sidecar row

    // replying the Arabic opt-out word opts the Arabic customer out immediately (inbound hook, real Customer + consent writes)
    hook.resetHandled();
    const handled = await hook.handleInbound({ workspaceId: ws.workspaceId, from: arabic.phone, message: { id: `wamid.in.${fx.uniq()}`, type: 'text', text: { body: 'إلغاء الاشتراك' } }, contactName: 'سارة' });
    expect(handled).toBe(true);
    expect((await Customer.findById(arabic._id).lean()).optedOut).toBe(true);

    reset();
    const second = await ops.sendLoyaltyReminders({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id), String(english._id)] });
    expect(second).toMatchObject({ sentCount: 1, skippedOptedOut: 1 });
    expect(messagesTo(arabic.phone)).toHaveLength(0);
    expect(messagesTo(english.phone)).toHaveLength(1);
  });

  test('no approved Arabic template: the Arabic customer gets the English message exactly as an English customer would (fallback), recorded with its reason', async () => {
    const { ws } = await world({ withProduct: false });
    const arabic = await ar(ws, { firstname: 'Omar', loyaltyPoints: 60 });
    const english = await en(ws, { firstname: 'Omar', loyaltyPoints: 60 });
    const out = await ops.sendLoyaltyReminders({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id), String(english._id)] });
    expect(out).toMatchObject({ sentCount: 2, languageCounts: { ar: 0, en: 2 }, localization: { arabicCustomers: 1, arabicSent: 0, fallbackToEnglish: [{ reason: 'no_arabic_version', count: 1 }] } });
    const a = messagesTo(arabic.phone)[0];
    const e = messagesTo(english.phone)[0];
    expect({ ...a, to: 'x' }).toEqual({ ...e, to: 'x' }); // identical payload (same name, same points, same template)
    const sidecar = await LocalizedLegacySend.find({ workspaceId: ws.workspaceId }).lean();
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]).toMatchObject({ usedLanguage: 'en', fallback: true, fallbackReason: 'no_arabic_version', status: 'sent' });
  });

  test('an all-English run of a flagged merchant: no new response keys, no sidecar rows', async () => {
    const { ws } = await world({ withProduct: false });
    const a = await en(ws, { loyaltyPoints: 10 });
    const b = await en(ws, { loyaltyPoints: 20 });
    const out = await ops.sendLoyaltyReminders({ workspaceId: ws.workspaceId, customerIds: [String(a._id), String(b._id)] });
    expect(Object.keys(out)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: ws.workspaceId })).toBe(0);
  });

  test('an unflagged merchant with an Arabic-language customer: untouched English behaviour', async () => {
    const off = await fx.makeWorkspace({ arabic: false });
    await arabicTemplate(off.workspaceId, { useCase: 'loyalty_reminder', buttons: [{ ...OPT_OUT_AR }], body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount} هذا الشهر' });
    const arabic = await fx.makeCustomer(off.workspaceId, { language: 'ar', firstname: 'Sara', loyaltyPoints: 50 });
    const out = await ops.sendLoyaltyReminders({ workspaceId: off.workspaceId, customerIds: [String(arabic._id)] });
    expect(Object.keys(out)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    expect(messagesTo(arabic.phone)[0].template.language).toEqual({ code: 'en' });
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: off.workspaceId })).toBe(0);
  });

  test('the kill switch LOCALIZATION_DISABLED=1 keeps everyone English even for a flagged merchant', async () => {
    const { ws } = await world({ withProduct: false });
    await arabicTemplate(ws.workspaceId, { useCase: 'loyalty_reminder', buttons: [{ ...OPT_OUT_AR }], body: 'أهلاً {name}، رصيدك الحالي من النقاط: {points}، وقيمته {amount} هذا الشهر' });
    const arabic = await ar(ws, { loyaltyPoints: 50 });
    process.env.LOCALIZATION_DISABLED = '1';
    try {
      const out = await ops.sendLoyaltyReminders({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id)] });
      expect(Object.keys(out)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'demoCount']);
    } finally { delete process.env.LOCALIZATION_DISABLED; settings.clearCache(); }
    expect(messagesTo(arabic.phone)[0].template.language).toEqual({ code: 'en' });
  });
});

describe('promotion send (ops.sendPromotion)', () => {
  const linkedBody = 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name} وسارع قبل انتهاء العرض';

  test('promotion-linked Arabic version: Arabic customer in Arabic (shop_now + opt-out payloads), English customer unchanged, same CampaignMessage rows', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const tpl = await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: linkedBody, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const arabic = await ar(ws);
    const english = await en(ws);

    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id), String(english._id)], workspaceId: ws.workspaceId });
    expect(out).toMatchObject({ success: true, sentCount: 2, skippedOptedOut: 0, skippedNoConsent: 0, errors: [], demoCount: 0, languageCounts: { ar: 1, en: 1 } });
    expect(Object.keys(out).slice(0, 6)).toEqual(['success', 'sentCount', 'skippedOptedOut', 'skippedNoConsent', 'errors', 'demoCount']);

    const arMsg = messagesTo(arabic.phone)[0];
    expect(arMsg.template.name).toBe(tpl.variants[1].metaTemplateName);
    expect(arMsg.template.language).toEqual({ code: 'ar' });
    expect(bodyParams(arMsg)).toEqual(['سارة', 'Coffee beans', '40.00 ر.س', 'Summer Sale']);
    expect(buttonPayloads(arMsg)).toEqual([`promo_${promotion._id}`, `optout_${promotion._id}`]);

    const enMsg = messagesTo(english.phone)[0];
    expect(enMsg.type).toBe('interactive'); // the English announcement, unchanged
    expect(enMsg.interactive.action.buttons.map((b) => b.reply.id)).toEqual([`promo_${promotion._id}`, `optout_${promotion._id}`]);

    const rows = await CampaignMessage.find({ promotion: promotion._id }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === 'promotion' && r.status === 'sent' && String(r.workspaceId) === String(ws.workspaceId))).toBe(true);
    const arRow = rows.find((r) => String(r.customer) === String(arabic._id));
    expect(arRow).toMatchObject({ messageType: 'template', templateName: tpl.variants[1].metaTemplateName });
    expect(arRow.wamid).toMatch(/^wamid\.L/);
    expect(rows.find((r) => String(r.customer) === String(english._id)).messageType).toBe('interactive');
    expect((await Promotion.findById(promotion._id).lean()).sentCount).toBe(2);

    // the existing campaign report keeps counting every row
    const report = await ops.getCampaignReport({ promotionId: String(promotion._id), workspaceId: ws.workspaceId });
    expect(report.messagesSent).toBe(2);

    // the plan said the same thing beforehand (plan == send)
    const planned = await plan.planPromotionSend({ workspaceId: ws.workspaceId, promotionId: String(promotion._id), customerIds: [String(arabic._id), String(english._id)] });
    expect(planned.byLanguage).toEqual({ ar: 1, en: 1 });
    expect(planned.variant).toMatchObject({ source: 'promotion', sendable: true, templateId: String(tpl._id) });
  });

  test('fallback: no Arabic version at all -> the Arabic customer gets the English announcement exactly as before, recorded as a fallback', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const arabic = await ar(ws, { firstname: 'Omar' });
    const english = await en(ws, { firstname: 'Omar' });
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id), String(english._id)], workspaceId: ws.workspaceId });
    expect(out.languageCounts).toEqual({ ar: 0, en: 2 });
    expect(out.localization.fallbackToEnglish).toEqual([{ reason: 'no_arabic_version', count: 1 }]);
    const a = messagesTo(arabic.phone)[0];
    const e = messagesTo(english.phone)[0];
    expect({ ...a, to: 'x' }).toEqual({ ...e, to: 'x' });
    const sidecar = await LocalizedLegacySend.find({ workspaceId: ws.workspaceId }).lean();
    expect(sidecar).toHaveLength(1);
    expect(sidecar[0]).toMatchObject({ sender: 'promotion', refId: String(promotion._id), usedLanguage: 'en', fallback: true, status: 'sent', wamid: expect.stringMatching(/^wamid\.L/) });
  });

  test('a pending (not yet approved) Arabic version falls back with the reason', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const tpl = await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: linkedBody, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    await LocalizedTemplate.updateOne({ _id: tpl._id, 'variants.language': 'ar' }, { $set: { 'variants.$.metaStatus': 'PENDING' } });
    const arabic = await ar(ws);
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id)], workspaceId: ws.workspaceId });
    expect(out.localization.fallbackToEnglish).toEqual([{ reason: 'pending', count: 1 }]);
    expect(messagesTo(arabic.phone)[0].type).toBe('interactive');
  });

  test('demo customers are unaffected: still simulated, never sent, no sidecar row, even with an Arabic language and an approved version', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: linkedBody, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const demo = await ar(ws, { isDemo: true, marketingConsent: false });
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(demo._id)], workspaceId: ws.workspaceId });
    expect(out.demoCount).toBe(1);
    expect(out.sentCount).toBe(1);
    expect(messages()).toHaveLength(0); // nothing reached WhatsApp
    const row = await CampaignMessage.findOne({ promotion: promotion._id, customer: demo._id }).lean();
    expect(row.status).toBe('read'); // the existing simulation
    expect(row.wamid).toMatch(/^demo_/);
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: ws.workspaceId })).toBe(0);
  });

  test('the same-phone opt-out rule: an Arabic customer whose number is opted out on another record is not messaged at all', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: linkedBody, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const phone = '966507771234';
    const arabic = await ar(ws, { phone });
    await fx.makeCustomer(ws.workspaceId, { firstname: 'Old record', phone: '+966 50 777 1234', optedOut: true, marketingConsent: false });
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id)], workspaceId: ws.workspaceId });
    expect(out.sentCount).toBe(0);
    expect(out.localization.excludedOptedOutPhone).toBe(1);
    expect(messages()).toHaveLength(0);
    expect(await CampaignMessage.countDocuments({ promotion: promotion._id })).toBe(0);
    expect((await LocalizedLegacySend.findOne({ workspaceId: ws.workspaceId }).lean())).toMatchObject({ status: 'skipped', errorCode: 'opted_out_same_phone' });
  });

  test('template-level stop: three consecutive 132001 errors stop the remaining Arabic customers; they are neither sent nor retried in English', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const tpl = await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: linkedBody, buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const customers = [];
    for (let i = 0; i < 5; i += 1) customers.push(await ar(ws, { firstname: `عميل${i}` }));
    failRules.push({ code: 132001, remaining: -1, message: 'Template name does not exist', match: (rec) => isMessage(rec) && rec.body.type === 'template' && rec.body.template.name === tpl.variants[1].metaTemplateName });
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: customers.map((c) => String(c._id)), workspaceId: ws.workspaceId });
    expect(out.sentCount).toBe(0);
    expect(out.errors).toHaveLength(3);
    expect(out.localization).toMatchObject({ arabicSent: 0, arabicFailed: 3, stopped: 'template_unusable:132001' });
    expect(messages()).toHaveLength(3); // three attempts, then nothing - and no English fallback messages
    expect(messages().every((m) => m.type === 'template' && m.template.language.code === 'ar')).toBe(true);
    const rows = await CampaignMessage.find({ promotion: promotion._id }).lean();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'failed' && /does not exist/.test(r.statusReason))).toBe(true);
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: ws.workspaceId, status: 'skipped' })).toBe(2);
  });

  test('node-linked Arabic version: the approved custom entry message gets its Arabic variant with the node\'s flow-button payloads', async () => {
    const { ws, product } = await world();
    const MessageNode = require('../../../models/MessageNode');
    const promotion = await promo(ws, product);
    const node = await MessageNode.create({
      workspaceId: ws.workspaceId, ownerType: 'promotion', ownerId: promotion._id, isEntryNode: true, bodyText: 'Hi {{1}}! {{2}} for {{3}} - {{4}}',
      templateName: `custom_${fx.uniq()}`, templateStatus: 'approved', buttons: [{ position: 0, label: 'Shop', nextAction: { type: 'end_flow' } }, { position: 1, label: 'Later', nextAction: { type: 'end_flow' } }],
    });
    await Promotion.updateOne({ _id: promotion._id }, { $set: { entryNodeId: node._id } });
    const tpl = await arabicTemplate(ws.workspaceId, {
      useCase: 'promotion', linkedMessageNodeId: node._id, body: linkedBody,
      buttons: [{ role: 'flow_button', text: 'تسوق الآن' }, { role: 'flow_button', text: 'لاحقاً' }, { ...OPT_OUT_AR }],
    });
    const arabic = await ar(ws);
    const english = await en(ws);
    const out = await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id), String(english._id)], workspaceId: ws.workspaceId });
    expect(out.languageCounts).toEqual({ ar: 1, en: 1 });
    expect(buttonPayloads(messagesTo(arabic.phone)[0])).toEqual([`msgnode_${node._id}_0`, `msgnode_${node._id}_1`, `optout_${promotion._id}`]);
    expect(messagesTo(arabic.phone)[0].template.name).toBe(tpl.variants[1].metaTemplateName);
    // English: the node's own template with the node's payloads, language en
    const enMsg = messagesTo(english.phone)[0];
    expect(enMsg.template.name).toBe(node.templateName);
    expect(enMsg.template.language).toEqual({ code: 'en' });
    expect(buttonPayloads(enMsg)).toEqual([`msgnode_${node._id}_0`, `msgnode_${node._id}_1`]);
    // the CampaignMessage of the Arabic send keeps the node for tap correlation
    const row = await CampaignMessage.findOne({ promotion: promotion._id, customer: arabic._id }).lean();
    expect(String(row.messageNode)).toBe(String(node._id));
  });
});

describe('consent requests (ops.sendConsentRequests)', () => {
  test('the Arabic ask template with consent_yes_/consent_no_ payloads; the ask is stamped and a consent_request CampaignMessage written; English customers unchanged', async () => {
    const { ws } = await world({ withProduct: false });
    const tpl = await arabicTemplate(ws.workspaceId, {
      useCase: 'welcome_optin', category: 'MARKETING', body: 'مرحباً {name}، هل تود أن تصلك عروضنا وتحديثاتنا عبر واتساب؟ يسعدنا ذلك دائماً',
      buttons: [{ role: 'opt_in', text: 'نعم، أوافق' }, { role: 'decline', text: 'لا، شكراً' }],
    });
    const arabic = await ar(ws, { marketingConsent: false });
    const english = await en(ws, { marketingConsent: false });
    const out = await ops.sendConsentRequests({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id), String(english._id)] });
    expect(out).toMatchObject({ totalEligible: 2, sentCount: 2, errors: [], languageCounts: { ar: 1, en: 1 } });
    expect(Object.keys(out).slice(0, 3)).toEqual(['totalEligible', 'sentCount', 'errors']);
    const arMsg = messagesTo(arabic.phone)[0];
    expect(arMsg.template.name).toBe(tpl.variants[1].metaTemplateName);
    expect(buttonPayloads(arMsg)).toEqual([`consent_yes_${arabic._id}`, `consent_no_${arabic._id}`]);
    expect(bodyParams(arMsg)).toEqual(['سارة']);
    const enMsg = messagesTo(english.phone)[0];
    expect(enMsg.template.language).toEqual({ code: 'en' });
    expect(buttonPayloads(enMsg)).toEqual([`consent_yes_${english._id}`, `consent_no_${english._id}`]);
    for (const c of [arabic, english]) {
      expect((await Customer.findById(c._id).lean()).marketingConsentAskedAt).toBeTruthy();
      const row = await CampaignMessage.findOne({ customer: c._id, kind: 'consent_request' }).lean();
      expect(row).toMatchObject({ status: 'sent', messageType: 'template' });
    }
    expect((await CampaignMessage.findOne({ customer: arabic._id, kind: 'consent_request' }).lean()).templateName).toBe(tpl.variants[1].metaTemplateName);
    // asked at most once: a second run finds nobody
    reset();
    expect((await ops.sendConsentRequests({ workspaceId: ws.workspaceId, customerIds: [String(arabic._id), String(english._id)] })).totalEligible).toBe(0);
  });
});

describe('booking notices (session text, P2)', () => {
  async function booking(ws, customer, status = 'requested') {
    const service = await Service.create({ workspaceId: ws.workspaceId, name: 'Facial', basePrice: 100 });
    const slot = await TimeSlot.create({ workspaceId: ws.workspaceId, serviceId: service._id, date: '2026-11-03', startTime: '16:30', endTime: '17:30', capacity: 3, bookedCount: 1 });
    return Booking.create({ workspaceId: ws.workspaceId, serviceId: service._id, slotId: slot._id, customerId: customer._id, phone: customer.phone, customerName: customer.firstname, status, paymentType: 'cash' });
  }

  test('confirmBooking: an Arabic customer gets the Arabic confirmation with the Arabic consent ask; an English customer the English one', async () => {
    const { ws } = await world({ withProduct: false });
    const arabic = await ar(ws, { marketingConsent: false });
    const english = await en(ws, { marketingConsent: false });
    const a = await booking(ws, arabic);
    const e = await booking(ws, english);
    await ops.confirmBooking({ bookingId: String(a._id), workspaceId: ws.workspaceId });
    await ops.confirmBooking({ bookingId: String(e._id), workspaceId: ws.workspaceId });
    const arMsg = messagesTo(arabic.phone)[0];
    expect(arMsg.type).toBe('interactive');
    expect(arMsg.interactive.body.text).toContain('تم تأكيد حجزك');
    expect(arMsg.interactive.body.text).toContain('Facial');
    expect(arMsg.interactive.action.buttons.map((b) => b.reply.id)).toEqual([`consent_yes_${arabic._id}`, `consent_no_${arabic._id}`]);
    expect(arMsg.interactive.action.buttons.map((b) => b.reply.title)).toEqual(['نعم، أوافق', 'لا، شكراً']);
    const enMsg = messagesTo(english.phone)[0];
    expect(enMsg.interactive.body.text).toContain('Booking Confirmed!');
    expect(enMsg.interactive.action.buttons.map((b) => b.reply.title)).toEqual(['Yes, sign me up', 'No thanks']);
    expect((await Customer.findById(arabic._id).lean()).marketingConsentAskedAt).toBeTruthy();
    // the existing code writes booking_notification rows without a workspaceId: find them by customer
    const rows = await CampaignMessage.find({ customer: { $in: [arabic._id, english._id] }, kind: 'booking_notification' }).lean();
    expect(rows).toHaveLength(2);
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: ws.workspaceId, sender: 'notice' })).toBe(1);
  });

  test('decline / reschedule / cancel: Arabic text for the Arabic customer (cancel keeps the rebook button), English text unchanged for the English one', async () => {
    const { ws } = await world({ withProduct: false });
    const arabic = await ar(ws);
    const english = await en(ws);
    const declined = await booking(ws, arabic);
    await ops.declineBooking({ bookingId: String(declined._id), workspaceId: ws.workspaceId });
    expect(messagesTo(arabic.phone)[0]).toMatchObject({ type: 'text' });
    expect(messagesTo(arabic.phone)[0].text.body).toContain('نعتذر');

    reset();
    const resched = await booking(ws, arabic, 'confirmed');
    const newSlot = await TimeSlot.create({ workspaceId: ws.workspaceId, serviceId: resched.serviceId, date: '2026-12-01', startTime: '09:00', endTime: '10:00', capacity: 3, bookedCount: 0 });
    await ops.rescheduleBooking({ bookingId: String(resched._id), newSlotId: String(newSlot._id), workspaceId: ws.workspaceId });
    const reMsg = messagesTo(arabic.phone)[0];
    expect(reMsg.text.body).toContain('تم تغيير موعد حجزك');
    expect(reMsg.text.body).toContain('2026-12-01');

    reset();
    const toCancel = await booking(ws, arabic, 'confirmed');
    await ops.cancelBooking({ bookingId: String(toCancel._id), workspaceId: ws.workspaceId });
    const cMsg = messagesTo(arabic.phone)[0];
    expect(cMsg.type).toBe('interactive');
    expect(cMsg.interactive.body.text).toContain('تم إلغاء حجزك');
    expect(cMsg.interactive.action.buttons).toEqual([{ type: 'reply', reply: { id: `rebook_${toCancel.serviceId}_${toCancel._id}`, title: 'أعد الحجز مجاناً 🔄' } }]);

    reset();
    const enBooking = await booking(ws, english);
    await ops.declineBooking({ bookingId: String(enBooking._id), workspaceId: ws.workspaceId });
    expect(messagesTo(english.phone)[0].text.body).toContain("we're unable to accommodate your request");
    const enCancel = await booking(ws, english, 'confirmed');
    await ops.cancelBooking({ bookingId: String(enCancel._id), workspaceId: ws.workspaceId });
    expect(messagesTo(english.phone)[1].interactive.action.buttons[0].reply.title).toBe('Rebook Free 🔄');
  });

  test('a failed Arabic notice is NOT retried in English (the best-effort catch of the existing code swallows it)', async () => {
    const { ws } = await world({ withProduct: false });
    const arabic = await ar(ws);
    const b = await booking(ws, arabic);
    failRules.push({ code: 131026, remaining: -1, message: 'Message undeliverable', match: (rec) => isMessage(rec) && rec.body.to === arabic.phone });
    await expect(ops.declineBooking({ bookingId: String(b._id), workspaceId: ws.workspaceId })).resolves.toBeTruthy();
    expect(messages()).toHaveLength(1); // one attempt (the Arabic one), no second English message
    expect(messages()[0].text.body).toContain('نعتذر');
    expect(await CampaignMessage.countDocuments({ customer: arabic._id, kind: 'booking_notification' })).toBe(0);
  });
});

describe('referral link text', () => {
  test('an Arabic customer gets the Arabic text with the opt-out hint and ?lang=ar; an English customer gets the unchanged English text', async () => {
    const referrals = require('../../../shared/referrals');
    const ReferralPromotion = require('../../../models/ReferralPromotion');
    const { ws } = await world({ withProduct: false });
    const refPromo = await ReferralPromotion.create({
      workspaceId: ws.workspaceId, name: 'Bring a friend', status: 'active', friendRewardType: 'percent_discount', friendRewardValue: 10, referrerRewardType: 'loyalty_points', referrerRewardValue: 50,
    });
    const arabic = await ar(ws);
    const english = await en(ws);
    const out = await referrals.sendReferralLinksToCustomers({ referralPromotionId: String(refPromo._id), customerIds: [String(arabic._id), String(english._id)], workspaceId: ws.workspaceId });
    expect(out).toMatchObject({ sentCount: 2, total: 2, languageCounts: { ar: 1, en: 1 } });
    const arText = messagesTo(arabic.phone)[0].text.body;
    expect(arText).toContain('شارك هذا الرابط مع صديق');
    expect(arText).toContain('?lang=ar');
    expect(arText.trim().endsWith(require('../../../shared/localization/catalog').t('ar', 'senders.optOutHint'))).toBe(true); // the opt-out hint line of the catalog (wording owned by the catalog)
    const enText = messagesTo(english.phone)[0].text.body;
    expect(enText).toContain('Share this link with a friend.');
    expect(enText).not.toContain('lang=ar');
    expect(await LocalizedLegacySend.countDocuments({ workspaceId: ws.workspaceId, sender: 'referral_link', usedLanguage: 'ar', status: 'sent' })).toBe(1);
  });
});

describe('HTTP: plan, test send and report behind requireAuth + the Arabic flag', () => {
  function app() {
    const { requireAuth } = require('../../../middleware/requireAuth');
    const a = express();
    a.use(express.json());
    a.use('/api/localization', requireAuth, require('../../../routes/localization'));
    return a;
  }

  test('402 for an unflagged merchant, 401 without a token; the plan, the test send and the report work for a flagged one', async () => {
    const server = app();
    const off = await fx.makeWorkspace({ arabic: false });
    expect((await request(server).post('/api/localization/senders/loyalty_reminder/plan').set(off.auth).send({})).status).toBe(402);
    expect((await request(server).post(`/api/localization/promotions/${new mongoose.Types.ObjectId()}/send-plan`).send({})).status).toBe(401);

    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const tpl = await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name} وسارع قبل انتهاء العرض', buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const arabic = await ar(ws);
    const english = await en(ws);

    const planned = await request(server).post(`/api/localization/promotions/${promotion._id}/send-plan`).set(ws.auth).send({ customerIds: [String(arabic._id), String(english._id)], includeIds: true });
    expect(planned.status).toBe(200);
    expect(planned.body).toMatchObject({ promotionId: String(promotion._id), selected: 2, eligible: 2, byLanguage: { ar: 1, en: 1 }, fallbacks: [], canSend: true });
    expect(planned.body.buckets.arabic).toEqual([String(arabic._id)]);
    expect(planned.body.variant).toMatchObject({ source: 'promotion', templateId: String(tpl._id), sendable: true });

    // another workspace's promotion / customers: invisible
    const other = await fx.makeWorkspace();
    expect((await request(server).post(`/api/localization/promotions/${promotion._id}/send-plan`).set(other.auth).send({ customerIds: [String(arabic._id)] })).status).toBe(404);

    // the Arabic test send: the same version, inert opt-out, to the typed number
    const test = await request(server).post(`/api/localization/promotions/${promotion._id}/test-send`).set(ws.auth).send({ phone: '+966 50 999 0000', language: 'ar' });
    expect(test.status).toBe(200);
    expect(test.body).toEqual({ sent: true, dryRun: false, usedLanguage: 'ar', templateName: tpl.variants[1].metaTemplateName });
    expect(buttonPayloads(messagesTo('966509990000')[0])).toEqual([`promo_${promotion._id}`, 'l10ntest_optout']);
    expect(await CampaignMessage.countDocuments({ promotion: promotion._id })).toBe(0); // a test send writes no campaign rows

    // a real send, then the per-language report
    await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: [String(arabic._id), String(english._id)], workspaceId: ws.workspaceId });
    const report = await request(server).get(`/api/localization/promotions/${promotion._id}/send-report`).set(ws.auth);
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ promotionId: String(promotion._id), runs: 1, arabicCustomers: 1, byLanguage: { ar: { sent: 1, failed: 0 }, en: { sent: 0 } } });
    expect((await request(server).get(`/api/localization/promotions/${promotion._id}/send-report`).set(other.auth)).status).toBe(404);

    // a promotion without an Arabic version: 409, never English silently
    const bare = await promo(ws, product, { name: 'Bare' });
    const none = await request(server).post(`/api/localization/promotions/${bare._id}/test-send`).set(ws.auth).send({ phone: '966509990000' });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ code: 'NO_ARABIC_VERSION', reason: 'no_arabic_version' });

    // sender plans
    const loyalty = await request(server).post('/api/localization/senders/loyalty_reminder/plan').set(ws.auth).send({});
    expect(loyalty.status).toBe(200);
    expect(loyalty.body).toMatchObject({ selected: expect.any(Number), byLanguage: expect.any(Object), variant: { source: 'none' } });
    expect((await request(server).post('/api/localization/senders/nope/plan').set(ws.auth).send({})).status).toBe(404);
  });

  test('the template API creates a promotion-linked template with a shop_now button and lists it by promotion', async () => {
    const server = app();
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    const created = await request(server).post('/api/localization/templates').set(ws.auth).send({
      name: 'Summer sale (Arabic)', useCase: 'promotion', linkedPromotionId: String(promotion._id),
      variants: [{ language: 'ar', body: 'أهلاً {name}، عرضنا الجديد بانتظارك اليوم في متجرنا', buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] }],
    });
    expect(created.status).toBe(201);
    expect(created.body.linkedPromotionId).toBe(String(promotion._id));
    expect(created.body.variants[0].validation.ok).toBe(true);
    const listed = await request(server).get(`/api/localization/templates?linkedPromotionId=${promotion._id}`).set(ws.auth);
    expect(listed.body.items.map((t) => t.id)).toEqual([created.body.id]);
    const foreign = await request(server).post('/api/localization/templates').set((await fx.makeWorkspace()).auth).send({ name: 'x', useCase: 'promotion', linkedPromotionId: String(promotion._id) });
    expect(foreign.status).toBe(404);
  });
});

describe('plan == send on a real database', () => {
  test('the customers the plan puts in each bucket are the ones the real send delivers in that language', async () => {
    const { ws, product } = await world();
    const promotion = await promo(ws, product);
    await arabicTemplate(ws.workspaceId, { useCase: 'promotion', linkedPromotionId: promotion._id, body: 'أهلاً {name}، جرّب {item} بسعر {price} ضمن {promo_name} وسارع قبل انتهاء العرض', buttons: [{ role: 'shop_now', text: 'تسوق الآن' }, { ...OPT_OUT_AR }] });
    const customers = [await ar(ws), await ar(ws, { firstname: 'نورة' }), await en(ws), await en(ws, { firstname: 'Cara' })];
    await fx.makeCustomer(ws.workspaceId, { firstname: 'NoConsent', marketingConsent: false });
    const ids = customers.map((c) => String(c._id));
    const planned = await plan.planPromotionSend({ workspaceId: ws.workspaceId, promotionId: String(promotion._id), customerIds: ids, includeIds: true });
    await ops.sendPromotion({ promotionId: String(promotion._id), customerIds: ids, workspaceId: ws.workspaceId });
    const delivered = (customer) => messagesTo(customer.phone)[0];
    const arabicDelivered = customers.filter((c) => delivered(c).type === 'template' && delivered(c).template.language.code === 'ar').map((c) => String(c._id));
    expect(arabicDelivered.sort()).toEqual(planned.buckets.arabic.slice().sort());
    expect(planned.byLanguage).toEqual({ ar: arabicDelivered.length, en: customers.length - arabicDelivered.length });
  });

  test('legacySenders.begin never throws and is null when the database lookup fails', async () => {
    const run = await legacy.begin({ sender: 'promotion', workspaceId: 'not-an-object-id', customers: [{ _id: 'x', workspaceId: 'not-an-object-id', phone: '1' }], promotion: null });
    expect(run).toBeNull();
  });
});
