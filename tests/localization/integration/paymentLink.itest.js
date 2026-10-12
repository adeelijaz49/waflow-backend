'use strict';
// Inbox "Send payment link" (hunk I1 in shared/inbox.js) against a REAL MongoDB with Stripe and the WhatsApp HTTP calls stubbed:
// an Arabic-speaking customer of a flagged workspace gets the Arabic text (and the thread stores that text); an English customer,
// an unflagged workspace and the kill switch get the English text exactly as before.
const { assertThrowawayDb } = require('./_guard'); assertThrowawayDb();

const axios = require('axios');
const fx = require('./_fixtures');

let mockPi = 0;
jest.mock('stripe', () => () => ({ paymentIntents: { create: async () => ({ id: `pi_stub_${++mockPi}` }) } }));
jest.setTimeout(120000);

const sent = [];
let wamidSeq = 0; // never reset: WhatsAppMessage.wamid is a unique index, so every stubbed send needs its own id (a per-test counter collides in a fresh database)
axios.defaults.adapter = async (config) => {
  let body = config.data;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep */ } }
  sent.push({ url: String(config.url || ''), body });
  return { data: { messages: [{ id: `wamid.PL${++wamidSeq}` }] }, status: 200, statusText: 'OK', headers: {}, config, request: {} };
};

const catalog = require('../../../shared/localization/catalog');
let inbox; let money; let currency;

beforeAll(async () => {
  process.env.WA_TOKEN = process.env.WA_TOKEN || 'dummy';
  process.env.APP_URL = 'http://localhost:3999';
  await fx.connect();
  require('../../../models/WhatsAppMessage');
  inbox = require('../../../shared/inbox');
  money = require('../../../utils/currency').money;
  currency = await require('../../../utils/settingsCache').getCurrency();
});
afterAll(async () => { await fx.disconnect(); });
beforeEach(() => { sent.length = 0; });

const lastText = () => { const m = sent.filter((c) => /\/messages$/.test(c.url)).pop(); return m && m.body.text.body; };
const stored = (customerId) => require('../../../models/WhatsAppMessage').findOne({ customer: customerId, messageType: 'payment' }).sort({ createdAt: -1 }).lean();

test('Arabic customer of a flagged workspace: Arabic text with ?lang=ar, stored in the thread', async () => {
  const ws = await fx.makeWorkspace();
  const c = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
  await inbox.sendPaymentLink({ customerId: c._id, workspaceId: ws.workspaceId, amount: 49.5, performedBy: ws.user._id });
  const text = lastText();
  expect(text).toContain('💳 رابط الدفع');
  expect(text).toMatch(/http:\/\/localhost:3999\/pay\/pi_stub_\d+\?lang=ar$/);
  expect(text).not.toMatch(/Here's/);
  expect((await stored(c._id)).messageBody).toBe(text);
});

test('English customer of the same flagged workspace: the unchanged English text', async () => {
  const ws = await fx.makeWorkspace();
  const c = await fx.makeCustomer(ws.workspaceId, { language: 'en' });
  await inbox.sendPaymentLink({ customerId: c._id, workspaceId: ws.workspaceId, amount: 49.5, performedBy: ws.user._id });
  expect(lastText()).toMatch(new RegExp(`^💳 Here's your payment link for ${money(49.5, currency).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\nhttp://localhost:3999/pay/pi_stub_\\d+$`));
  expect((await stored(c._id)).messageBody).toBe(lastText());
});

test('unflagged workspace (even for an Arabic-language customer) and the kill switch: English', async () => {
  const off = await fx.makeWorkspace({ arabic: false });
  const c = await fx.makeCustomer(off.workspaceId, { language: 'ar' });
  await inbox.sendPaymentLink({ customerId: c._id, workspaceId: off.workspaceId, amount: 10, performedBy: off.user._id });
  expect(lastText()).toContain("Here's your payment link");
  const on = await fx.makeWorkspace();
  const d = await fx.makeCustomer(on.workspaceId, { language: 'ar' });
  process.env.LOCALIZATION_DISABLED = '1';
  try {
    await inbox.sendPaymentLink({ customerId: d._id, workspaceId: on.workspaceId, amount: 10, performedBy: on.user._id });
  } finally { delete process.env.LOCALIZATION_DISABLED; }
  expect(lastText()).toContain("Here's your payment link");
});

test('the Arabic copy follows the catalogue (inbox.paymentLink)', async () => {
  const ws = await fx.makeWorkspace();
  const c = await fx.makeCustomer(ws.workspaceId, { language: 'ar' });
  await inbox.sendPaymentLink({ customerId: c._id, workspaceId: ws.workspaceId, amount: 120, performedBy: ws.user._id });
  const head = catalog.t('ar', 'inbox.paymentLink', { amount: 'X', link: 'Y' }).split('\n')[0].split('X')[0];
  expect(lastText().startsWith(head)).toBe(true);
});
