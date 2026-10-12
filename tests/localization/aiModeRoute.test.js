// /api/localization/ai-mode/* end to end with everything external faked: the router,
// the service, the REAL agent (confirm gate included) and the session-store contract
// run together over a scripted Claude client, a recording tool registry and an
// in-memory session store. A stub middleware plays requireAuth. No database, no
// network, nothing sent. Focus: validation, tenant scoping (the workspace comes from
// the token only), the human-approval gate through HTTP, rate limits, language
// resolution, error shapes, and the Mongo store's query scoping.
const express = require('express');
const request = require('supertest');
const { createRouter, LIMITS } = require('../../routes/localization/aiMode');
const { createAiModeAgent } = require('../../shared/localization/aiMode/agent');
const { createAiModeService, toApiError } = require('../../shared/localization/aiMode/service');
const { createMongoSessionStore } = require('../../shared/localization/aiMode/sessionStore');
const { createRateLimiter } = require('../../shared/localization/aiMode/rateLimit');
const { parseLanguage } = require('../../shared/localization/aiMode/validate');
const F = require('./helpers/aiModeFakes');

const { IDS, text, toolUse, response } = F;
const NOW = new Date('2026-10-11T18:30:00Z');
const WS_A = '65f2a1b3c4d5e6f708192a01';
const WS_B = '65f2a1b3c4d5e6f708192a02';
const USERS = { a: { id: '65f2a1b3c4d5e6f708192b01', workspaceId: WS_A, role: 'admin' }, b: { id: '65f2a1b3c4d5e6f708192b02', workspaceId: WS_B, role: 'admin' }, none: { id: 'u' } };
const BASE = '/api/localization/ai-mode';
const SID = 'c0ffee00-1111-4222-8333-444455556666';

const proposal = (input = { promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] }) => response([text('Preparing that.'), toolUse('tu_1', 'send_promotion', input)]);

function stack({ responses = [response([text('Hello!')])], prefs, results, onPromptCompleted, limiters, generateInsights } = {}) {
  const client = F.scriptedClient(responses);
  const rec = F.recorderRegistry(results);
  const sessions = F.createMemorySessionStore();
  const log = jest.fn();
  const agent = createAiModeAgent({ client, tools: rec.registry, sessions, lookups: F.makeLookups(), now: () => NOW, log });
  const settings = { getUserPrefs: jest.fn(async () => prefs || { aiLanguage: 'auto', uiLanguage: 'en' }), getMerchantName: jest.fn(async () => 'Al Noor') };
  const gen = generateInsights || jest.fn(async () => []);
  const service = createAiModeService({ agent, sessions, settings, generateInsights: gen, onPromptCompleted, log });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.get('x-user') || 'a']; next(); });
  app.use(BASE, createRouter({ service, limiters }));
  return { app, client, sessions, settings, service, log, gen, ...rec };
}

const as = (user, req) => req.set('x-user', user);
const post = (s, path, body, user = 'a') => as(user, request(s.app).post(`${BASE}${path}`)).send(body);
const get = (s, path, user = 'a') => as(user, request(s.app).get(`${BASE}${path}`));

describe('validation', () => {
  test.each([
    [{ message: 'hi' }, 'INVALID_INPUT'],
    [{ sessionId: 'short', message: 'hi' }, 'INVALID_INPUT'],
    [{ sessionId: { $ne: null }, message: 'hi' }, 'INVALID_INPUT'],
    [{ sessionId: `${SID}${'x'.repeat(100)}`, message: 'hi' }, 'INVALID_INPUT'],
    [{ sessionId: 'has spaces and /slashes', message: 'hi' }, 'INVALID_INPUT'],
    [{ sessionId: SID }, 'MESSAGE_REQUIRED'],
    [{ sessionId: SID, message: '' }, 'MESSAGE_REQUIRED'],
    [{ sessionId: SID, message: '   \u{200F}\u{202E} ' }, 'MESSAGE_REQUIRED'],
    [{ sessionId: SID, message: 'x'.repeat(2001) }, 'MESSAGE_TOO_LONG'],
    [{ sessionId: SID, message: 12345 }, 'INVALID_INPUT'],
    [{ sessionId: SID, message: { $gt: '' } }, 'INVALID_INPUT'],
    [{ sessionId: SID, message: 'hi', language: 'fr' }, 'INVALID_LANGUAGE'],
    [{ sessionId: SID, message: 'hi', language: { $ne: 'en' } }, 'INVALID_LANGUAGE'],
  ])('POST /message %j -> 400 %s and no model call', async (body, code) => {
    const s = stack();
    const res = await post(s, '/message', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe('string');
    expect(s.client.messages.create).not.toHaveBeenCalled();
  });

  test('a JSON array or a missing body is treated as an empty body', async () => {
    const s = stack();
    expect((await post(s, '/message', [1, 2])).body.code).toBe('INVALID_INPUT');
    const res = await as('a', request(s.app).post(`${BASE}/message`));
    expect(res.status).toBe(400);
  });

  test('a message of exactly 2000 characters is accepted', async () => {
    const s = stack();
    expect((await post(s, '/message', { sessionId: SID, message: 'ا'.repeat(2000) })).status).toBe(200);
  });

  test.each([
    [{ sessionId: SID, confirm: true }],
    [{ sessionId: SID, actionId: '', confirm: true }],
    [{ sessionId: SID, actionId: { $ne: null }, confirm: true }],
    [{ sessionId: SID, actionId: 'x'.repeat(101), confirm: true }],
    [{ sessionId: SID, actionId: 'abc' }],
    [{ sessionId: SID, actionId: 'abc', confirm: 'true' }],
    [{ sessionId: SID, actionId: 'abc', confirm: 1 }],
    [{ actionId: 'abc', confirm: true }],
  ])('POST /confirm %j -> 400 INVALID_INPUT', async (body) => {
    const s = stack();
    const res = await post(s, '/confirm', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('GET /session/:id validates the id; GET /insights validates the language', async () => {
    const s = stack();
    expect((await get(s, '/session/x')).body.code).toBe('INVALID_INPUT');
    expect((await get(s, '/insights?language=fr')).body.code).toBe('INVALID_LANGUAGE');
    expect((await get(s, '/insights?language=auto')).body.code).toBe('INVALID_LANGUAGE');
    expect(() => parseLanguage({ $ne: 'ar' }, ['en', 'ar'])).toThrow(expect.objectContaining({ code: 'INVALID_LANGUAGE' }));
  });
});

describe('authentication context', () => {
  test('a token without a workspace is 403 FORBIDDEN on every endpoint', async () => {
    const s = stack();
    for (const res of [
      await post(s, '/message', { sessionId: SID, message: 'hi' }, 'none'),
      await post(s, '/confirm', { sessionId: SID, actionId: 'a', confirm: true }, 'none'),
      await get(s, `/session/${SID}`, 'none'),
      await get(s, '/insights', 'none'),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
    expect(s.client.messages.create).not.toHaveBeenCalled();
  });

  test('chat content is never cacheable', async () => {
    const s = stack();
    expect((await get(s, `/session/${SID}`)).headers['cache-control']).toBe('no-store');
  });

  test('workspaceId / userId in the body are ignored: the token decides', async () => {
    const s = stack({ responses: [response([toolUse('t', 'get_order_stats', {})]), response([text('ok')])] });
    const res = await post(s, '/message', { sessionId: SID, message: 'orders?', workspaceId: WS_B, userId: 'x' });
    expect(res.status).toBe(200);
    expect(s.runs.get_order_stats).toHaveBeenCalledWith({}, WS_A);
    expect(s.sessions.docs.get(SID).workspaceId).toBe(WS_A);
  });
});

describe('a conversation through HTTP', () => {
  test('message -> reply (AiModeTurn shape) and the session can be read back', async () => {
    const s = stack({ responses: [response([text('عندك 5 عملاء.')])] });
    const res = await post(s, '/message', { sessionId: SID, message: 'كم عميل عندي؟' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionId: SID, reply: 'عندك 5 عملاء.', pendingAction: null, language: 'ar',
      usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20 }),
    });
    const session = await get(s, `/session/${SID}`);
    expect(session.body.messages.map((m) => [m.role, m.text])).toEqual([['user', 'كم عميل عندي؟'], ['assistant', 'عندك 5 عملاء.']]);
    expect(session.body.pendingAction).toBeNull();
  });

  test('an unknown session is an empty session, not an error', async () => {
    const s = stack();
    const res = await get(s, '/session/00000000-aaaa-bbbb-cccc-000000000000');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: '00000000-aaaa-bbbb-cccc-000000000000', messages: [], pendingAction: null });
  });

  test('propose -> confirm runs the SERVER-stored action once; the reply is localised; a replay is 409', async () => {
    const s = stack({ responses: [proposal()], results: { send_promotion: { sentCount: 2 } } });
    const turn = await post(s, '/message', { sessionId: SID, message: 'أبغى أرسل العرض لسارة وأحمد' });
    expect(turn.status).toBe(200);
    expect(turn.body.pendingAction).toMatchObject({ toolName: 'send_promotion', args: { promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] } });
    expect(turn.body.reply).toBe(turn.body.pendingAction.summary);
    expect(turn.body.reply).toContain('عميلين');
    expect(s.runs.send_promotion).not.toHaveBeenCalled();

    const stored = await get(s, `/session/${SID}`);
    expect(stored.body.pendingAction.id).toBe(turn.body.pendingAction.id);

    const evil = { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true, args: { customerIds: [IDS.c3] }, toolName: 'refund_order', workspaceId: WS_B };
    const done = await post(s, '/confirm', evil);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ reply: expect.stringContaining('عميلين'), pendingAction: null });
    expect(s.runs.send_promotion).toHaveBeenCalledTimes(1);
    expect(s.runs.send_promotion).toHaveBeenCalledWith({ promotionId: IDS.promo, customerIds: [IDS.c1, IDS.c2] }, WS_A);
    expect(s.runs.refund_order).not.toHaveBeenCalled();

    const replay = await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true });
    expect(replay.status).toBe(409);
    expect(replay.body.code).toBe('ACTION_NOT_PENDING');
    expect(s.runs.send_promotion).toHaveBeenCalledTimes(1);

    const after = await get(s, `/session/${SID}`);
    expect(after.body.pendingAction).toBeNull();
    expect(after.body.messages.at(-1).role).toBe('assistant');
  });

  test('declining runs nothing and answers in Arabic for an Arabic conversation', async () => {
    const s = stack({ responses: [proposal()] });
    const turn = await post(s, '/message', { sessionId: SID, message: 'أبغى أرسل العرض' });
    const res = await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: false });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/لا مشكلة/);
    expect(Object.values(s.runs).every((run) => run.mock.calls.length === 0)).toBe(true);
    expect((await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true })).status).toBe(409);
  });

  test('a stale or invented action id is 409 and runs nothing', async () => {
    const s = stack({ responses: [proposal()] });
    await post(s, '/message', { sessionId: SID, message: 'send the promotion' });
    const res = await post(s, '/confirm', { sessionId: SID, actionId: '00000000-0000-4000-8000-000000000000', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ACTION_NOT_PENDING');
    expect(s.runs.send_promotion).not.toHaveBeenCalled();
  });

  test('confirming in a session that does not exist is 404 SESSION_NOT_FOUND', async () => {
    const s = stack();
    const res = await post(s, '/confirm', { sessionId: SID, actionId: 'abc', confirm: true });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  test('a new message supersedes the pending action: the old card can no longer be confirmed', async () => {
    const s = stack({ responses: [proposal(), response([text('Sure.')])] });
    const first = await post(s, '/message', { sessionId: SID, message: 'send the promotion' });
    const second = await post(s, '/message', { sessionId: SID, message: 'actually, never mind' });
    expect(second.body.pendingAction).toBeNull();
    expect((await post(s, '/confirm', { sessionId: SID, actionId: first.body.pendingAction.id, confirm: true })).status).toBe(409);
    expect(s.runs.send_promotion).not.toHaveBeenCalled();
  });

  test('two simultaneous confirms (double click): exactly one runs the action', async () => {
    const s = stack({ responses: [proposal()], results: { send_promotion: { sentCount: 2 } } });
    const turn = await post(s, '/message', { sessionId: SID, message: 'send the promotion' });
    const body = { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true };
    const [r1, r2] = await Promise.all([post(s, '/confirm', body), post(s, '/confirm', body)]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(s.runs.send_promotion).toHaveBeenCalledTimes(1);
  });

  test('an action whose execution throws still clears the card, reports a generic failure and leaks nothing', async () => {
    const s = stack({ responses: [proposal()] });
    s.runs.send_promotion.mockRejectedValueOnce(new Error('Stripe key sk_live_SECRET mongodb://u:p@h/db'));
    const turn = await post(s, '/message', { sessionId: SID, message: 'send the promotion' });
    const res = await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_live|mongodb/);
    expect((await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: true })).status).toBe(409);
    expect(s.runs.send_promotion).toHaveBeenCalledTimes(1);
  });
});

describe('tenant isolation', () => {
  test("another workspace cannot post into, read, or confirm a session it does not own", async () => {
    const s = stack({ responses: [proposal()] });
    const turn = await post(s, '/message', { sessionId: SID, message: 'send the promotion', }, 'a');
    const actionId = turn.body.pendingAction.id;

    const intrude = await post(s, '/message', { sessionId: SID, message: 'hello' }, 'b');
    expect(intrude.status).toBe(404);
    expect(intrude.body.code).toBe('SESSION_NOT_FOUND');

    const read = await get(s, `/session/${SID}`, 'b');
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ sessionId: SID, messages: [], pendingAction: null });

    const confirm = await post(s, '/confirm', { sessionId: SID, actionId, confirm: true }, 'b');
    expect(confirm.status).toBe(404);
    expect(s.runs.send_promotion).not.toHaveBeenCalled();

    const mine = await get(s, `/session/${SID}`, 'a');
    expect(mine.body.pendingAction.id).toBe(actionId);
    expect(mine.body.messages).toHaveLength(2);
  });

  test("the prompt metering hook and insights always receive the token's workspace", async () => {
    const onPromptCompleted = jest.fn();
    const s = stack({ onPromptCompleted });
    await post(s, '/message', { sessionId: SID, message: 'hi' }, 'b');
    expect(onPromptCompleted).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS_B, userId: USERS.b.id }));
    await get(s, '/insights?language=ar', 'b');
    expect(s.gen).toHaveBeenCalledWith({ workspaceId: WS_B, surface: 'aimode' });
  });
});

describe('language resolution: request override -> saved preference -> auto', () => {
  const systemOf = (s) => s.client.calls[0].body.system[1].text;

  test('the request wins over the saved preference', async () => {
    const s = stack({ prefs: { aiLanguage: 'en', uiLanguage: 'en' } });
    const res = await post(s, '/message', { sessionId: SID, message: 'hello', language: 'ar' });
    expect(systemOf(s)).toMatch(/ALWAYS reply in Arabic/);
    expect(res.body.language).toBe('ar');
  });
  test('without a request language the saved preference applies', async () => {
    const s = stack({ prefs: { aiLanguage: 'ar', uiLanguage: 'en' } });
    const res = await post(s, '/message', { sessionId: SID, message: 'hello' });
    expect(systemOf(s)).toMatch(/ALWAYS reply in Arabic/);
    expect(res.body.language).toBe('ar');
  });
  test('"auto" (or nothing saved) follows the message', async () => {
    const s = stack({ prefs: { aiLanguage: 'auto', uiLanguage: 'en' } });
    const res = await post(s, '/message', { sessionId: SID, message: 'وش أكثر عرض جاب مبيعات' });
    expect(systemOf(s)).toMatch(/latest message looks like Arabic/);
    expect(res.body.language).toBe('ar');
  });
  test('a failing preference lookup falls back to auto instead of failing the turn', async () => {
    const s = stack();
    s.settings.getUserPrefs.mockRejectedValue(new Error('db down'));
    const res = await post(s, '/message', { sessionId: SID, message: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.language).toBe('en');
  });
  test('garbage in the saved preference is ignored', async () => {
    const s = stack({ prefs: { aiLanguage: { $ne: 1 }, uiLanguage: 'zz' } });
    expect((await post(s, '/message', { sessionId: SID, message: 'hello' })).body.language).toBe('en');
  });
  test('confirm uses the same resolution: an Arabic preference gets an Arabic decline', async () => {
    const s = stack({ responses: [proposal()], prefs: { aiLanguage: 'ar', uiLanguage: 'en' } });
    const turn = await post(s, '/message', { sessionId: SID, message: 'send it' });
    const res = await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: false });
    expect(res.body.reply).toMatch(/لا مشكلة/);
  });
});

describe('rate limits', () => {
  const tight = (limit) => ({ message: createRateLimiter({ limit }), confirm: createRateLimiter({ limit }), insights: createRateLimiter({ limit }) });

  test('the default budget is 20 turns a minute per workspace', () => {
    expect(LIMITS.message).toBe(20);
  });

  test('over the limit -> 429 RATE_LIMITED with Retry-After, per workspace, and no model call', async () => {
    const s = stack({ limiters: tight(2) });
    expect((await post(s, '/message', { sessionId: SID, message: 'one' })).status).toBe(200);
    expect((await post(s, '/message', { sessionId: SID, message: 'two' })).status).toBe(200);
    const third = await post(s, '/message', { sessionId: SID, message: 'three' });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(Number(third.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(s.client.messages.create).toHaveBeenCalledTimes(2);
    const other = await post(s, '/message', { sessionId: 'another-session-1', message: 'hi' }, 'b');
    expect(other.status).toBe(200);
  });

  test('confirm and insights are limited too; invalid requests do not use up the budget', async () => {
    const s = stack({ limiters: tight(1) });
    for (let i = 0; i < 5; i += 1) await post(s, '/message', { sessionId: 'bad id', message: 'x' });
    expect((await post(s, '/message', { sessionId: SID, message: 'ok now' })).status).toBe(200);
    expect((await get(s, '/insights')).status).toBe(200);
    expect((await get(s, '/insights')).status).toBe(429);
    expect((await post(s, '/confirm', { sessionId: SID, actionId: 'a', confirm: true })).status).toBe(409);
    expect((await post(s, '/confirm', { sessionId: SID, actionId: 'a', confirm: true })).status).toBe(429);
  });

  test('the limiter is a sliding window', () => {
    let t = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect(limiter.check('k').ok).toBe(true);
    expect(limiter.check('k').ok).toBe(true);
    expect(limiter.check('k')).toEqual({ ok: false, retryAfterSec: 1 });
    t = 1001;
    expect(limiter.check('k').ok).toBe(true);
    expect(limiter.check('other').ok).toBe(true);
  });
});

describe('prompt metering hook (not wired by default)', () => {
  test('called once per answered message, with usage; not for confirm, not for a failed turn', async () => {
    const onPromptCompleted = jest.fn();
    const s = stack({ responses: [proposal(), new Error('boom')], onPromptCompleted });
    const turn = await post(s, '/message', { sessionId: SID, message: 'send it' });
    expect(onPromptCompleted).toHaveBeenCalledTimes(1);
    expect(onPromptCompleted.mock.calls[0][0]).toMatchObject({ workspaceId: WS_A, sessionId: SID, proposedAction: true, usage: { inputTokens: 100, outputTokens: 20 } });
    await post(s, '/confirm', { sessionId: SID, actionId: turn.body.pendingAction.id, confirm: false });
    expect(onPromptCompleted).toHaveBeenCalledTimes(1);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await post(s, '/message', { sessionId: SID, message: 'again' });
    console.error.mockRestore();
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(onPromptCompleted).toHaveBeenCalledTimes(1);
  });

  test('a throwing or rejecting hook can never break or delay the reply', async () => {
    for (const hook of [jest.fn(() => { throw new Error('sync'); }), jest.fn(async () => { throw new Error('async'); })]) {
      const s = stack({ onPromptCompleted: hook });
      expect((await post(s, '/message', { sessionId: SID, message: 'hi' })).status).toBe(200);
      await new Promise((resolve) => setImmediate(resolve));
      expect(s.log).toHaveBeenCalledWith(expect.stringContaining('metering hook failed'), expect.any(String));
    }
  });

  test('the default hook is a no-op', async () => {
    const s = stack();
    expect((await post(s, '/message', { sessionId: SID, message: 'hi' })).status).toBe(200);
  });
});

describe('error shapes', () => {
  const upstream = (status, message) => Object.assign(new Error(message), { status });

  test.each([
    [upstream(429, 'rate limit: org key sk-ant-SECRET'), 429, 'AI_RATE_LIMITED'],
    [upstream(401, 'invalid x-api-key sk-ant-SECRET'), 503, 'AI_UNAVAILABLE'],
    [upstream(529, 'overloaded'), 503, 'AI_UNAVAILABLE'],
    [upstream(400, 'prompt is too long: sk-ant-SECRET'), 502, 'AI_FAILED'],
    [Object.assign(new Error('socket hang up sk-ant-SECRET'), { name: 'APIConnectionError' }), 502, 'AI_FAILED'],
    [new Error('TypeError: cannot read x of undefined at /srv/app.js:1:1'), 500, 'INTERNAL'],
  ])('model failure %#: mapped to a stable code and the upstream text is never returned', async (err, status, code) => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const s = stack({ responses: [err] });
    const res = await post(s, '/message', { sessionId: SID, message: 'hi' });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-ant|socket|TypeError|app\.js/);
    console.error.mockRestore();
  });

  test('toApiError passes known codes through and hides everything else', () => {
    const known = Object.assign(new Error('Session not found'), { status: 404, code: 'SESSION_NOT_FOUND' });
    expect(toApiError(known, () => {})).toBe(known);
    expect(toApiError(Object.assign(new Error('x'), { status: 404, code: 'MADE_UP' }), () => {})).toMatchObject({ status: 502, code: 'AI_FAILED' });
    expect(toApiError(undefined, () => {})).toMatchObject({ status: 500, code: 'INTERNAL' });
  });

  test('a model that never answers an Arabic question still produces a clean reply', async () => {
    const s = stack({ responses: [response([])] });
    const res = await post(s, '/message', { sessionId: SID, message: 'وش أحسن عرض؟' });
    expect(res.status).toBe(200);
    expect(res.body.reply).toMatch(/لست متأكداً/);
  });
});

describe('insights endpoint', () => {
  const card = () => ({
    insightKey: 'loyal_customers_2026W41', category: 'loyalty', categoryLabel: 'Loyalty', icon: '💎', title: '9 loyal customers this week',
    message: '9 customers ordered more than once this week. Send them a loyalty reward?', metricLabel: 'Repeat customers', metricValue: 9, rawMetric: 9,
    priorityTier: 'high', priorityScore: 70, status: 'active',
    primaryCta: { label: 'Send Loyalty Reward', action: { type: 'navigate', route: '/promotions', queryParams: { customerIds: 'a' } } },
    secondaryCta: { label: 'View Customers', action: { type: 'navigate', route: '/customers', queryParams: { ids: 'a' } } },
  });

  test('?language=ar localises; ?language=en leaves the engine text; both return { items }', async () => {
    const s = stack({ generateInsights: jest.fn(async () => [card()]) });
    const ar = await get(s, '/insights?language=ar');
    expect(ar.status).toBe(200);
    expect(ar.body.items).toHaveLength(1);
    expect(ar.body.items[0]).toMatchObject({ insightKey: 'loyal_customers_2026W41', localized: true, metricValue: '9' });
    expect(ar.body.items[0].title).toMatch(/[\u{0600}-\u{06FF}]/u);
    expect(ar.body.items[0].primaryCta.action.queryParams).toEqual({ customerIds: 'a' });
    const en = await get(s, '/insights?language=en');
    expect(en.body.items[0].title).toBe('9 loyal customers this week');
  });

  test('without ?language the saved AI language (or, for auto, the UI language) decides', async () => {
    const forPrefs = (prefs) => stack({ prefs, generateInsights: jest.fn(async () => [card()]) });
    expect((await get(forPrefs({ aiLanguage: 'ar', uiLanguage: 'en' }), '/insights')).body.items[0].localized).toBe(true);
    const autoAr = await get(forPrefs({ aiLanguage: 'auto', uiLanguage: 'ar' }), '/insights');
    expect(autoAr.body.items[0].title).toMatch(/[\u{0600}-\u{06FF}]/u);
    const en = await get(forPrefs({ aiLanguage: 'en', uiLanguage: 'ar' }), '/insights');
    expect(en.body.items[0].title).toBe('9 loyal customers this week');
  });

  test('an engine failure is a clean 500 without its message', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const s = stack({ generateInsights: jest.fn(async () => { throw new Error('E11000 duplicate key collection: waflow.insightstates'); }) });
    const res = await get(s, '/insights?language=ar');
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL');
    expect(JSON.stringify(res.body)).not.toMatch(/E11000|insightstates/);
    console.error.mockRestore();
  });
});

describe('the Mongo session store scopes every query by workspace', () => {
  // A tiny stand-in for the AiChatSession model: one collection, unique sessionId,
  // $push / $set / upsert, matching on `pendingAction.id`. It records every filter.
  function fakeModel() {
    const docs = [];
    const filters = [];
    const same = (a, b) => String(a) === String(b);
    const matches = (doc, filter) => Object.entries(filter).every(([k, v]) => {
      if (v !== null && typeof v === 'object') throw new Error(`operator in filter: ${JSON.stringify(v)}`);
      if (k === 'pendingAction.id') return doc.pendingAction && doc.pendingAction.id === v;
      return same(doc[k], v);
    });
    const Model = {
      docs,
      filters,
      findOne: (filter) => { filters.push(filter); return { lean: async () => docs.find((d) => matches(d, filter)) || null }; },
      exists: async (filter) => { filters.push(filter); return docs.some((d) => matches(d, filter)) ? { _id: 1 } : null; },
      updateOne: async (filter, update, options = {}) => {
        filters.push(filter);
        let doc = docs.find((d) => matches(d, filter));
        if (!doc && options.upsert) {
          if (docs.some((d) => d.sessionId === filter.sessionId)) throw Object.assign(new Error('E11000'), { code: 11000 });
          doc = { workspaceId: filter.workspaceId, sessionId: filter.sessionId, messages: [], pendingAction: null };
          docs.push(doc);
        }
        if (!doc) return { modifiedCount: 0 };
        if (update.$push) doc.messages.push(...update.$push.messages.$each);
        if (update.$set) Object.assign(doc, update.$set);
        return { modifiedCount: 1 };
      },
    };
    return Model;
  }
  const msg = (role, textValue) => ({ role, text: textValue, createdAt: NOW, extra: 'dropped' });
  const pending = { id: 'act-1', toolName: 'send_promotion', args: { promotionId: IDS.promo }, summary: 's', createdAt: NOW, junk: true };

  test('save, read back, claim once; messages and the pending action keep only their known fields', async () => {
    const Model = fakeModel();
    const store = createMongoSessionStore({ Model });
    await store.saveTurn({ sessionId: SID, workspaceId: WS_A, messages: [msg('user', 'hi'), msg('assistant', 'hello')], pendingAction: pending });
    const found = await store.find(SID, WS_A);
    expect(found.messages).toEqual([{ role: 'user', text: 'hi', createdAt: NOW }, { role: 'assistant', text: 'hello', createdAt: NOW }]);
    expect(found.pendingAction).toEqual({ id: 'act-1', toolName: 'send_promotion', args: { promotionId: IDS.promo }, summary: 's', createdAt: NOW });
    expect(await store.claimPendingAction({ sessionId: SID, workspaceId: WS_A, actionId: 'act-1' })).toBe(true);
    expect(await store.claimPendingAction({ sessionId: SID, workspaceId: WS_A, actionId: 'act-1' })).toBe(false);
    expect((await store.find(SID, WS_A)).pendingAction).toBeNull();
  });

  test('every query carries the workspace; another workspace sees nothing and cannot claim, append or overwrite', async () => {
    const Model = fakeModel();
    const store = createMongoSessionStore({ Model });
    await store.saveTurn({ sessionId: SID, workspaceId: WS_A, messages: [msg('user', 'secret')], pendingAction: pending });

    expect(await store.find(SID, WS_B)).toBeNull();
    await expect(store.findOrCreate(SID, WS_B)).rejects.toMatchObject({ status: 404, code: 'SESSION_NOT_FOUND' });
    expect(await store.claimPendingAction({ sessionId: SID, workspaceId: WS_B, actionId: 'act-1' })).toBe(false);
    await expect(store.saveTurn({ sessionId: SID, workspaceId: WS_B, messages: [msg('user', 'x')], pendingAction: null })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await store.appendMessages({ sessionId: SID, workspaceId: WS_B, messages: [msg('assistant', 'x')] });

    expect(Model.docs).toHaveLength(1);
    expect(Model.docs[0].messages).toHaveLength(1);
    expect(Model.docs[0].pendingAction.id).toBe('act-1');
    expect(Model.filters.every((f) => f.workspaceId !== undefined || f.sessionId !== undefined)).toBe(true);
    expect(Model.filters.filter((f) => f.workspaceId === undefined && !('pendingAction.id' in f))).toEqual([{ sessionId: SID }]); // only findOrCreate's ownership probe
  });

  test('a store call without a workspace, or with a non-string session id, is refused before any query', async () => {
    const Model = fakeModel();
    const store = createMongoSessionStore({ Model });
    await expect(store.find(SID, undefined)).rejects.toThrow();
    await expect(store.find({ $ne: null }, WS_A)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await store.claimPendingAction({ sessionId: SID, workspaceId: WS_A, actionId: { $ne: null } })).toBe(false);
    expect(Model.filters).toHaveLength(0);
  });

  test('a first-message race (duplicate key) is retried once for the owner and is 404 for another workspace', async () => {
    const Model = fakeModel();
    const store = createMongoSessionStore({ Model });
    const realUpdate = Model.updateOne;
    let first = true;
    Model.updateOne = async (...args) => {
      if (first) { first = false; Model.docs.push({ workspaceId: WS_A, sessionId: 'race-session-1', messages: [], pendingAction: null }); throw Object.assign(new Error('E11000'), { code: 11000 }); }
      return realUpdate(...args);
    };
    await store.saveTurn({ sessionId: 'race-session-1', workspaceId: WS_A, messages: [msg('user', 'hi')], pendingAction: null });
    expect(Model.docs[0].messages).toHaveLength(1);

    Model.docs.push({ workspaceId: WS_A, sessionId: 'taken-session-1', messages: [], pendingAction: null });
    await expect(store.saveTurn({ sessionId: 'taken-session-1', workspaceId: WS_B, messages: [msg('user', 'x')], pendingAction: null })).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });
});
