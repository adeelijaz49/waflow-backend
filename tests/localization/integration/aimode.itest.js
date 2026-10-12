const { assertThrowawayDb } = require('./_guard');

assertThrowawayDb();

// Real-MongoDB integration tests for AI Mode (slice B7a): the session store's
// atomic claim / upsert / duplicate-key paths on the real AiChatSession model,
// the read-only lookups, and the whole agent -> confirm gate -> store round trip
// driven by a FAKE Claude client and FAKE tools (the real Anthropic API and the
// real tool implementations - which would message customers - are never reached).
const fx = require('./_fixtures');
const mongoose = require('mongoose');
const { createMongoSessionStore } = require('../../../shared/localization/aiMode/sessionStore');
const { createModelLookups, createSettingsProvider } = require('../../../shared/localization/aiMode/lookups');
const { createAiModeAgent, createAiModeService } = require('../../../shared/localization/aiMode');
const AiChatSession = require('../../../models/AiChatSession');
const Promotion = require('../../../models/Promotion');
const Flow = require('../../../models/Flow');
const Order = require('../../../models/Order');
const UserLocalePreference = require('../../../models/UserLocalePreference');
const F = require('../helpers/aiModeFakes');

const { text, toolUse, response } = F;
jest.setTimeout(60000);

beforeAll(async () => { await fx.connect(); });
afterAll(async () => { await fx.disconnect(); });

const sid = () => `itest-session-${fx.uniq()}`;

describe('session store on the real AiChatSession model', () => {
  const store = createMongoSessionStore();
  let a; let b;
  beforeAll(async () => { a = await fx.makeWorkspace(); b = await fx.makeWorkspace(); });
  const msg = (role, t) => ({ role, text: t, createdAt: new Date() });

  test('findOrCreate is in-memory until the first saveTurn creates the document; later turns append', async () => {
    const id = sid();
    const session = await store.findOrCreate(id, a.workspaceId);
    expect(session).toMatchObject({ sessionId: id, messages: [], pendingAction: null });
    expect(await AiChatSession.countDocuments({ sessionId: id })).toBe(0);
    await store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'مرحبا'), msg('assistant', 'أهلاً')], pendingAction: null });
    await store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'كم عميل؟'), msg('assistant', '٣')], pendingAction: null });
    const found = await store.find(id, a.workspaceId);
    expect(found.messages.map((m) => m.text)).toEqual(['مرحبا', 'أهلاً', 'كم عميل؟', '٣']);
    expect(await AiChatSession.countDocuments({ sessionId: id })).toBe(1);
  });

  test('a session id owned by another workspace is SESSION_NOT_FOUND everywhere and is never read or written', async () => {
    const id = sid();
    await store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'secret plan')], pendingAction: { id: 'p1', toolName: 'send_promotion', args: {}, summary: 's', createdAt: new Date() } });
    expect(await store.find(id, b.workspaceId)).toBeNull();
    await expect(store.findOrCreate(id, b.workspaceId)).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    // saveTurn: the upsert hits the unique sessionId index (E11000) and must surface as 404, not a 500 / overwrite
    await expect(store.saveTurn({ sessionId: id, workspaceId: b.workspaceId, messages: [msg('user', 'hijack')], pendingAction: null })).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    expect(await store.claimPendingAction({ sessionId: id, workspaceId: b.workspaceId, actionId: 'p1' })).toBe(false);
    await store.appendMessages({ sessionId: id, workspaceId: b.workspaceId, messages: [msg('assistant', 'hijack')] });
    const mine = await store.find(id, a.workspaceId);
    expect(mine.messages.map((m) => m.text)).toEqual(['secret plan']);
    expect(mine.pendingAction.id).toBe('p1');
  });

  test('two simultaneous FIRST turns both land (duplicate-key retry path), nothing is lost and there is one document', async () => {
    const id = sid();
    await Promise.all([
      store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'one'), msg('assistant', 'one!')], pendingAction: null }),
      store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'two'), msg('assistant', 'two!')], pendingAction: null }),
    ]);
    expect(await AiChatSession.countDocuments({ sessionId: id })).toBe(1);
    const found = await store.find(id, a.workspaceId);
    expect(found.messages).toHaveLength(4);
  });

  test('claimPendingAction: of 8 simultaneous claims exactly one wins; a wrong id never claims', async () => {
    const id = sid();
    await store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [msg('user', 'send it')], pendingAction: { id: 'act-1', toolName: 'send_promotion', args: { promotionId: 'x' }, summary: 'ok', createdAt: new Date() } });
    expect(await store.claimPendingAction({ sessionId: id, workspaceId: a.workspaceId, actionId: 'other' })).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claimPendingAction({ sessionId: id, workspaceId: a.workspaceId, actionId: 'act-1' })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.find(id, a.workspaceId)).pendingAction).toBeNull();
    expect(await store.claimPendingAction({ sessionId: id, workspaceId: a.workspaceId, actionId: 'act-1' })).toBe(false);
  });

  test('the pending action keeps exactly id/toolName/args/summary/createdAt', async () => {
    const id = sid();
    await store.saveTurn({ sessionId: id, workspaceId: a.workspaceId, messages: [], pendingAction: { id: 'p', toolName: 't', args: { n: 1 }, summary: 's', createdAt: new Date(), $where: '1', evil: 'x' } });
    const raw = await AiChatSession.findOne({ sessionId: id }).lean();
    expect(Object.keys(raw.pendingAction).sort()).toEqual(['args', 'createdAt', 'id', 'summary', 'toolName']);
  });

  test('operator injection through the ids is rejected before reaching Mongo', async () => {
    await expect(store.find({ $ne: '' }, a.workspaceId)).rejects.toMatchObject({ status: 400 });
    await expect(store.claimPendingAction({ sessionId: sid(), workspaceId: a.workspaceId, actionId: { $ne: null } })).resolves.toBe(false);
  });
});

describe('lookups and settings on real models', () => {
  let a; let b;
  beforeAll(async () => { a = await fx.makeWorkspace({ merchantName: 'مقهى الأصالة' }); b = await fx.makeWorkspace(); });

  test('promotion / order / customers lookups are workspace scoped', async () => {
    const lookups = createModelLookups({ getCurrency: async () => 'SAR' });
    const promo = await Promotion.create({ workspaceId: a.workspaceId, name: 'عرض العيد' });
    const c1 = await fx.makeCustomer(a.workspaceId, { firstname: 'منى', lastname: 'العتيبي', loyaltyPoints: 10 });
    const c2 = await fx.makeCustomer(a.workspaceId, { loyaltyPoints: 0 });
    const cb = await fx.makeCustomer(b.workspaceId, { loyaltyPoints: 99 });
    const order = await Order.create({ workspaceId: a.workspaceId, customer: c1._id, total: 150, status: 'delivered' });

    expect(await lookups.promotion(a.workspaceId, promo._id)).toEqual({ name: 'عرض العيد', isDemo: false });
    expect(await lookups.promotion(b.workspaceId, promo._id)).toBeNull();
    expect(await lookups.order(a.workspaceId, order._id)).toMatchObject({ total: 150, currency: 'SAR', customerName: 'منى العتيبي' });
    expect(await lookups.order(b.workspaceId, order._id)).toBeNull();
    const many = await lookups.customers(a.workspaceId, [c1._id, c2._id, cb._id]);
    expect(many.found).toBe(2);
    expect(many.names).toContain('منى العتيبي');
    expect(await lookups.loyaltyAudience(a.workspaceId)).toBe(1);
    expect(await lookups.loyaltyAudience(b.workspaceId)).toBe(1);
  });

  test('flow lookup is workspace scoped', async () => {
    const lookups = createModelLookups({ getCurrency: async () => 'SAR' });
    const flow = await Flow.create({ workspaceId: a.workspaceId, name: 'Win-back', status: 'paused', triggerType: 'inactive_customer' });
    expect(await lookups.flow(a.workspaceId, flow._id)).toMatchObject({ name: 'Win-back', status: 'paused' });
    expect(await lookups.flow(b.workspaceId, flow._id)).toBeNull();
  });

  test('settings provider: defaults, stored preference, merchant name', async () => {
    const settings = createSettingsProvider();
    expect(await settings.getUserPrefs(a.workspaceId, a.user._id)).toEqual({ aiLanguage: 'auto', uiLanguage: 'en' });
    await UserLocalePreference.create({ workspaceId: a.workspaceId, userId: a.user._id, uiLanguage: 'ar', aiLanguage: 'ar' });
    expect(await settings.getUserPrefs(a.workspaceId, a.user._id)).toEqual({ aiLanguage: 'ar', uiLanguage: 'ar' });
    expect(await settings.getUserPrefs(b.workspaceId, a.user._id)).toEqual({ aiLanguage: 'auto', uiLanguage: 'en' });
    expect(await settings.getMerchantName(a.workspaceId)).toBe('مقهى الأصالة');
  });
});

describe('agent + confirm gate + real store, fake Claude and fake tools', () => {
  function build({ responses, results } = {}) {
    const client = F.scriptedClient(responses);
    const rec = F.recorderRegistry(results);
    const sessions = createMongoSessionStore();
    const lookups = createModelLookups({ getCurrency: async () => 'SAR' });
    const settings = createSettingsProvider();
    const agent = createAiModeAgent({ client, tools: rec.registry, sessions, lookups, settings, log: () => {} });
    const service = createAiModeService({ agent, sessions, settings, generateInsights: async () => [], log: () => {} });
    return { client, service, sessions, ...rec };
  }

  let ws; let other; let promo; let c1; let c2;
  beforeAll(async () => {
    ws = await fx.makeWorkspace(); other = await fx.makeWorkspace();
    promo = await Promotion.create({ workspaceId: ws.workspaceId, name: 'Eid Offer' });
    c1 = await fx.makeCustomer(ws.workspaceId, { firstname: 'Sara' });
    c2 = await fx.makeCustomer(ws.workspaceId, { firstname: 'أحمد' });
  });
  const proposal = () => response([toolUse('tu_1', 'send_promotion', { promotionId: String(promo._id), customerIds: [String(c1._id), String(c2._id)] }), text('سأرسل العرض')]);
  const who = () => ({ workspaceId: ws.workspaceId, userId: ws.user._id });

  test('a send is only PROPOSED (nothing runs), the card is server-built and persisted; confirm runs it exactly once', async () => {
    const { service, runs } = build({ responses: [proposal()] });
    const sessionId = sid();
    const turn = await service.message({ ...who(), sessionId, message: 'أرسل عرض العيد لسارة وأحمد', language: 'ar' });
    expect(runs.send_promotion).not.toHaveBeenCalled();
    expect(turn.pendingAction).toMatchObject({ toolName: 'send_promotion' });
    expect(turn.pendingAction.summary).toContain('Eid Offer'); // resolved from the REAL promotion by the real lookup

    const stored = await AiChatSession.findOne({ sessionId }).lean();
    expect(stored.pendingAction.id).toBe(turn.pendingAction.id);
    expect(stored.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(stored.messages[0].text).toBe('أرسل عرض العيد لسارة وأحمد');

    const results = await Promise.allSettled([
      service.confirm({ ...who(), sessionId, actionId: turn.pendingAction.id, confirm: true, language: 'ar' }),
      service.confirm({ ...who(), sessionId, actionId: turn.pendingAction.id, confirm: true, language: 'ar' }),
      service.confirm({ ...who(), sessionId, actionId: turn.pendingAction.id, confirm: true, language: 'ar' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) expect(r.reason).toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(runs.send_promotion).toHaveBeenCalledTimes(1);
    expect(runs.send_promotion).toHaveBeenCalledWith({ promotionId: String(promo._id), customerIds: [String(c1._id), String(c2._id)] }, ws.workspaceId);
    const after = await AiChatSession.findOne({ sessionId }).lean();
    expect(after.pendingAction).toBeNull();
    expect(after.messages.length).toBe(3); // user, assistant card reply, confirmation
  });

  test("another workspace cannot confirm or read someone else's session", async () => {
    const { service, runs } = build({ responses: [proposal()] });
    const sessionId = sid();
    const turn = await service.message({ ...who(), sessionId, message: 'send the Eid offer to Sara', language: 'en' });
    const intruder = { workspaceId: other.workspaceId, userId: other.user._id };
    await expect(service.confirm({ ...intruder, sessionId, actionId: turn.pendingAction.id, confirm: true })).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    await expect(service.message({ ...intruder, sessionId, message: 'hi' })).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    expect(await service.getSession({ ...intruder, sessionId })).toEqual({ sessionId, messages: [], pendingAction: null });
    expect(runs.send_promotion).not.toHaveBeenCalled();
    expect((await AiChatSession.findOne({ sessionId }).lean()).pendingAction.id).toBe(turn.pendingAction.id);
  });

  test('a promotion of another workspace cannot even be proposed', async () => {
    const foreignPromo = await Promotion.create({ workspaceId: other.workspaceId, name: 'Foreign' });
    const bad = build({ responses: [response([toolUse('tu_1', 'send_promotion', { promotionId: String(foreignPromo._id), customerIds: [String(c1._id)] })]), response([text('I could not find that promotion.')])] });
    const t1 = await bad.service.message({ ...who(), sessionId: sid(), message: 'send the Foreign promotion to Sara', language: 'en' });
    expect(t1.pendingAction).toBeNull();
    expect(bad.runs.send_promotion).not.toHaveBeenCalled();
  });

  test('declining runs nothing; a new message supersedes the pending action', async () => {
    const ok = build({ responses: [proposal()] });
    const sessionId = sid();
    const t2 = await ok.service.message({ ...who(), sessionId, message: 'send Eid offer to Sara and Ahmad', language: 'en' });
    const declined = await ok.service.confirm({ ...who(), sessionId, actionId: t2.pendingAction.id, confirm: false, language: 'en' });
    expect(declined.pendingAction).toBeNull();
    expect(ok.runs.send_promotion).not.toHaveBeenCalled();

    const ok2 = build({ responses: [proposal(), response([text('Sure, what else?')])] });
    const sid2 = sid();
    const p = await ok2.service.message({ ...who(), sessionId: sid2, message: 'send Eid offer to Sara and Ahmad', language: 'en' });
    await ok2.service.message({ ...who(), sessionId: sid2, message: 'actually never mind', language: 'en' });
    await expect(ok2.service.confirm({ ...who(), sessionId: sid2, actionId: p.pendingAction.id, confirm: true })).rejects.toMatchObject({ status: 409, code: 'ACTION_NOT_PENDING' });
    expect(ok2.runs.send_promotion).not.toHaveBeenCalled();
  });

  test('history is stored as clean text only (no tool blocks), Arabic round-trips byte for byte', async () => {
    const { service } = build({ responses: [response([toolUse('tu_1', 'get_order_stats', {})]), response([text('لديك ٥ طلبات اليوم')])], results: { get_order_stats: { today: 5 } } });
    const sessionId = sid();
    const turn = await service.message({ ...who(), sessionId, message: 'كم طلب اليوم؟', language: 'ar' });
    expect(turn.reply).toBe('لديك ٥ طلبات اليوم');
    const stored = await AiChatSession.findOne({ sessionId }).lean();
    expect(stored.messages.map((m) => [m.role, m.text])).toEqual([['user', 'كم طلب اليوم؟'], ['assistant', 'لديك ٥ طلبات اليوم']]);
    expect(JSON.stringify(stored)).not.toContain('tool_use');
  });
});

describe('HTTP: /api/localization/ai-mode behind requireAuth and the flag', () => {
  const express = require('express');
  const request = require('supertest');
  const { requireAuth } = require('../../../middleware/requireAuth');
  const { createRouter } = require('../../../routes/localization/aiMode');
  const { requireArabicEnabled } = require('../../../shared/localization/settings');

  test("the router round-trips a turn and a session read for the token's workspace only", async () => {
    const ws = await fx.makeWorkspace(); const other = await fx.makeWorkspace();
    const client = F.scriptedClient([response([text('أهلاً بك')])]);
    const rec = F.recorderRegistry();
    const sessions = createMongoSessionStore();
    const settings = createSettingsProvider();
    const agent = createAiModeAgent({ client, tools: rec.registry, sessions, lookups: createModelLookups(), settings, log: () => {} });
    const service = createAiModeService({ agent, sessions, settings, generateInsights: async () => [], log: () => {} });
    const app = express();
    app.use(express.json());
    app.use('/api/localization/ai-mode', requireAuth, requireArabicEnabled, createRouter({ service }));

    expect((await request(app).post('/api/localization/ai-mode/message').send({ sessionId: 'abcdefgh1', message: 'hi' })).status).toBe(401);
    const off = await fx.makeWorkspace({ arabic: false });
    expect((await request(app).post('/api/localization/ai-mode/message').set(off.auth).send({ sessionId: 'abcdefgh1', message: 'hi' })).status).toBe(402);

    const sessionId = sid();
    const res = await request(app).post('/api/localization/ai-mode/message').set(ws.auth).send({ sessionId, message: 'مرحبا', language: 'ar' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId, reply: 'أهلاً بك', pendingAction: null });
    const mine = await request(app).get(`/api/localization/ai-mode/session/${sessionId}`).set(ws.auth);
    expect(mine.body.messages.map((m) => m.text)).toEqual(['مرحبا', 'أهلاً بك']);
    const theirs = await request(app).get(`/api/localization/ai-mode/session/${sessionId}`).set(other.auth);
    expect(theirs.body.messages).toEqual([]);
    expect(mongoose.connection.readyState).toBe(1);
  });
});
