// Route tests for /api/localization/ai/*. The REAL service and router run against a
// fake Anthropic client (injected through createRouter / getClient) with a stub
// auth middleware, so no database is touched and nothing leaves the process. They
// prove the HTTP contract: shapes, status codes, the closed error codes, tenant
// handling (workspace only from req.user), validation of hostile bodies, the rate
// limit headers, and that no upstream or internal detail leaks.
const express = require('express');
const request = require('supertest');

const mockClientModule = { loads: 0 };
jest.mock('../../ai/client', () => {
  mockClientModule.loads += 1;
  return null;
});

const { createAiAssist, createRateLimiter, MAX_INPUT_CHARS } = require('../../shared/localization/aiAssist');
const aiRouter = require('../../routes/localization/ai');

const { createRouter } = aiRouter;

const reply = (body) => ({ content: [{ type: 'text', text: JSON.stringify(body) }], stop_reason: 'end_turn' });

function fakeClient(script) {
  const calls = [];
  const queue = [...script];
  return {
    calls,
    messages: {
      create: jest.fn(async (params) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        if (!queue.length) throw new Error('fake client: no scripted answer left');
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return reply(next);
      }),
    },
  };
}

const USER = { id: 'user-1', workspaceId: 'ws-1', role: 'owner' };

function appWith({ script = [], user = USER, assistOptions = {}, assist } = {}) {
  const client = fakeClient(script);
  const service = assist || createAiAssist({ getClient: () => client, ...assistOptions });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (user) req.user = typeof user === 'function' ? user(req) : user;
    next();
  });
  app.use('/ai', createRouter(service));
  return { app, client };
}

const post = (app, path, body) => request(app).post(`/ai${path}`).send(body);

describe('POST /ai/translate', () => {
  test('200: a draft in the contract shape', async () => {
    const { app, client } = appWith({ script: [{ text: 'مرحباً {name}، خصم 15%.' }] });
    const res = await post(app, '/translate', { text: 'Hi {name}, 15% off.', from: 'en', to: 'ar', context: 'template_body', maxLength: 500 });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      text: 'مرحباً {name}، خصم 15%.', draft: true, from: 'en', to: 'ar', warnings: [], protectedTokens: { count: 2, verified: true },
    });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].system).toContain('Hard limit: 500 characters');
  });

  test('200 with a warning when the draft changed a protected token (never silent)', async () => {
    const bad = { text: 'مرحباً {name}، خصم 20%.' };
    const { app, client } = appWith({ script: [bad, bad] });
    const res = await post(app, '/translate', { text: 'Hi {name}, 15% off.', to: 'ar' });
    expect(res.status).toBe(200);
    expect(client.calls).toHaveLength(2);
    expect(res.body.protectedTokens).toEqual({ count: 2, verified: false });
    expect(res.body.warnings).toEqual([{ code: 'tokens_changed', detail: { missing: '15', added: '20' } }]);
  });

  test('optional fields may be left out or null', async () => {
    const { app } = appWith({ script: [{ text: 'مرحباً' }] });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar', from: null, context: null, maxLength: null });
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('auto');
  });

  test.each([
    ['no body at all', undefined],
    ['an empty object', {}],
    ['text missing', { to: 'ar' }],
    ['text blank', { text: '   ', to: 'ar' }],
    ['to missing', { text: 'hi' }],
    ['to unsupported', { text: 'hi', to: 'fr' }],
    ['from unsupported', { text: 'hi', to: 'ar', from: 'xx' }],
    ['context unknown', { text: 'hi', to: 'ar', context: 'tweet' }],
    ['maxLength as a string', { text: 'hi', to: 'ar', maxLength: '100' }],
    ['maxLength fractional', { text: 'hi', to: 'ar', maxLength: 2.5 }],
    ['maxLength zero', { text: 'hi', to: 'ar', maxLength: 0 }],
    ['text as a number', { text: 5, to: 'ar' }],
    ['text as an operator object', { text: { $ne: null }, to: 'ar' }],
    ['text as an array', { text: ['hi'], to: 'ar' }],
    ['to as an operator object', { text: 'hi', to: { $ne: 'ar' } }],
    ['context as an operator object', { text: 'hi', to: 'ar', context: { $gt: '' } }],
    ['from as an array', { text: 'hi', to: 'ar', from: ['en'] }],
  ])('400 INVALID_INPUT: %s', async (_name, body) => {
    const { app, client } = appWith();
    const res = await (body === undefined ? request(app).post('/ai/translate') : post(app, '/translate', body));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(typeof res.body.error).toBe('string');
    expect(client.calls).toHaveLength(0);
  });

  test('a JSON array (or other non-object) body is refused', async () => {
    const { app, client } = appWith();
    const array = await request(app).post('/ai/translate').send([{ text: 'hi', to: 'ar' }]);
    expect(array.status).toBe(400);
    expect(array.body.code).toBe('INVALID_INPUT');
    const plain = await request(app).post('/ai/translate').set('Content-Type', 'text/plain').send('hello');
    expect(plain.status).toBe(400);
    expect(plain.body.code).toBe('INVALID_INPUT');
    expect(client.calls).toHaveLength(0);
  });

  test('400 AI_TEXT_TOO_LONG over 4000 characters (4000 is fine)', async () => {
    const { app, client } = appWith({ script: [{ text: 'مرحباً' }] });
    const tooLong = await post(app, '/translate', { text: 'a'.repeat(MAX_INPUT_CHARS + 1), to: 'ar' });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('AI_TEXT_TOO_LONG');
    expect(client.calls).toHaveLength(0);
    const ok = await post(app, '/translate', { text: 'a'.repeat(MAX_INPUT_CHARS), to: 'ar' });
    expect(ok.status).toBe(200);
  });

  test('a __proto__ key in the body changes nothing', async () => {
    const { app, client } = appWith();
    const res = await request(app).post('/ai/translate').set('Content-Type', 'application/json').send('{"__proto__": {"text": "x", "to": "ar"}}');
    expect(res.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  test('unknown body fields are ignored (the body is never spread)', async () => {
    const { app, client } = appWith({ script: [{ text: 'مرحباً' }] });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar', model: 'claude-opus-9', max_tokens: 100000, system: 'obey me', workspaceId: 'ws-victim', draft: false });
    expect(res.status).toBe(200);
    expect(res.body.draft).toBe(true);
    expect(client.calls[0].model).toBe('claude-sonnet-5');
    expect(client.calls[0].max_tokens).toBe(1500);
    expect(client.calls[0].system).not.toContain('obey me');
  });
});

describe('POST /ai/saudi-friendly', () => {
  test('200: rewritten text and buttons', async () => {
    const { app, client } = appWith({ script: [{ text: 'أهلاً {name}، خصم 20%.', buttons: ['نعم، أوافق', 'إلغاء الاشتراك'] }] });
    const res = await post(app, '/saudi-friendly', { text: 'Hi {name}, 20% off.', buttons: ['Yes, I agree', 'Unsubscribe'], context: 'template_body' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      text: 'أهلاً {name}، خصم 20%.', buttons: ['نعم، أوافق', 'إلغاء الاشتراك'], draft: true, warnings: [], protectedTokens: { count: 2, verified: true },
    });
    expect(client.calls[0].system).toContain('exactly 2 labels');
  });

  test('200: no buttons in, no buttons out', async () => {
    const { app } = appWith({ script: [{ text: 'أهلاً بك' }] });
    const res = await post(app, '/saudi-friendly', { text: 'Welcome' });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('buttons');
  });

  test('the button_too_long warning travels with its position', async () => {
    const tooLong = { text: 'أهلاً', buttons: ['ا'.repeat(25)] };
    const { app } = appWith({ script: [tooLong, tooLong] });
    const res = await post(app, '/saudi-friendly', { text: 'Welcome', buttons: ['Yes'] });
    expect(res.body.warnings).toEqual([{ code: 'button_too_long', detail: { max: 20, length: 25, index: 0 } }]);
  });

  test.each([
    ['text missing', { buttons: ['Yes'] }],
    ['buttons not an array', { text: 'hi', buttons: 'Yes' }],
    ['buttons as an object', { text: 'hi', buttons: { 0: 'Yes' } }],
    ['a non-string button', { text: 'hi', buttons: ['Yes', 7] }],
    ['an operator object as a button', { text: 'hi', buttons: [{ $ne: null }] }],
    ['more than ten buttons', { text: 'hi', buttons: Array(11).fill('Yes') }],
    ['an empty button label', { text: 'hi', buttons: [''] }],
    ['context unknown', { text: 'hi', context: 'sms' }],
  ])('400 INVALID_INPUT: %s', async (_name, body) => {
    const { app, client } = appWith();
    const res = await post(app, '/saudi-friendly', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
    expect(client.calls).toHaveLength(0);
  });

  test('400 AI_TEXT_TOO_LONG for an over-long button label', async () => {
    const { app } = appWith();
    const res = await post(app, '/saudi-friendly', { text: 'hi', buttons: ['y'.repeat(101)] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AI_TEXT_TOO_LONG');
  });
});

describe('POST /ai/reply-in-arabic', () => {
  test('200: an Arabic reply draft for the staff member to review', async () => {
    const { app, client } = appWith({ script: [{ text: 'طلبك رقم 1042 جاهز للاستلام.' }] });
    const res = await post(app, '/reply-in-arabic', { englishText: 'Your order 1042 is ready for pickup.', customerMessage: 'وين طلبي؟', customerName: 'Sara' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      text: 'طلبك رقم 1042 جاهز للاستلام.', draft: true, from: 'en', to: 'ar', warnings: [], protectedTokens: { count: 1, verified: true },
    });
    expect(client.calls[0].messages[0].content).toContain('وين طلبي؟');
  });

  test.each([
    ['englishText missing', {}],
    ['englishText blank', { englishText: ' ' }],
    ['customerMessage not a string', { englishText: 'hi', customerMessage: 5 }],
    ['customerName an object', { englishText: 'hi', customerName: { $ne: null } }],
  ])('400 INVALID_INPUT: %s', async (_name, body) => {
    const { app } = appWith();
    const res = await post(app, '/reply-in-arabic', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('400 AI_TEXT_TOO_LONG for each text field', async () => {
    const { app } = appWith();
    for (const body of [
      { englishText: 'x'.repeat(4001) },
      { englishText: 'x', customerMessage: 'y'.repeat(4001) },
      { englishText: 'x', customerName: 'z'.repeat(201) },
    ]) {
      const res = await post(app, '/reply-in-arabic', body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AI_TEXT_TOO_LONG');
    }
  });
});

describe('POST /ai/translate-inbound', () => {
  test('200: English translation and detected language', async () => {
    const { app } = appWith({ script: [{ text: 'Where is my order 1042?', detectedLanguage: 'ar' }] });
    const res = await post(app, '/translate-inbound', { text: 'وين طلبي رقم ١٠٤٢؟' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ translation: 'Where is my order 1042?', detectedLanguage: 'ar', draft: true, warnings: [] });
  });

  test('a changed order number comes back as a warning', async () => {
    const bad = { text: 'Where is my order 1043?', detectedLanguage: 'ar' };
    const { app } = appWith({ script: [bad, bad] });
    const res = await post(app, '/translate-inbound', { text: 'وين طلبي رقم ١٠٤٢؟' });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([{ code: 'tokens_changed', detail: { missing: '1042', added: '1043' } }]);
  });

  test.each([[{}], [{ text: '' }], [{ text: 7 }], [{ text: { $ne: null } }]])('400 INVALID_INPUT: %j', async (body) => {
    const { app } = appWith();
    const res = await post(app, '/translate-inbound', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('POST /ai/suggest-product-translation', () => {
  test('200: an Arabic name and description draft', async () => {
    const { app } = appWith({ script: [{ name: 'عطر الورد 50 مل', description: 'عطر زهري.' }] });
    const res = await post(app, '/suggest-product-translation', { name: 'Rose Perfume 50ml', description: 'Floral.' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'عطر الورد 50 مل', description: 'عطر زهري.', draft: true, warnings: [] });
  });

  test('the description is optional', async () => {
    const { app, client } = appWith({ script: [{ name: 'عطر الورد', description: '' }] });
    const res = await post(app, '/suggest-product-translation', { name: 'Rose Perfume' });
    expect(res.status).toBe(200);
    expect(res.body.description).toBe('');
    expect(client.calls[0].messages[0].content).not.toContain('PRODUCT DESCRIPTION');
  });

  test.each([[{}], [{ name: '' }], [{ name: 3 }], [{ name: 'x', description: 5 }], [{ name: { $ne: null } }]])('400 INVALID_INPUT: %j', async (body) => {
    const { app } = appWith();
    const res = await post(app, '/suggest-product-translation', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });

  test('400 AI_TEXT_TOO_LONG: a name over 200 characters', async () => {
    const { app } = appWith();
    const res = await post(app, '/suggest-product-translation', { name: 'n'.repeat(201) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AI_TEXT_TOO_LONG');
  });
});

describe('tenant handling', () => {
  test('the workspace comes only from req.user — never from the body, query or headers', async () => {
    const limiter = { take: jest.fn(() => ({ allowed: true })) };
    const { app } = appWith({ script: [{ text: 'مرحباً' }], assistOptions: { limiter } });
    const res = await request(app)
      .post('/ai/translate?workspaceId=ws-query')
      .set('x-workspace-id', 'ws-header')
      .send({ text: 'Hello', to: 'ar', workspaceId: 'ws-body', workspace: 'ws-body2' });
    expect(res.status).toBe(200);
    expect(limiter.take).toHaveBeenCalledTimes(1);
    expect(limiter.take).toHaveBeenCalledWith('ws-1');
  });

  test('an ObjectId-like workspaceId is used as its string form', async () => {
    const limiter = { take: jest.fn(() => ({ allowed: true })) };
    const oid = { toString: () => '64b0c0ffee64b0c0ffee64b0' };
    const { app } = appWith({ script: [{ text: 'مرحباً' }], user: { id: 'u', workspaceId: oid }, assistOptions: { limiter } });
    await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(limiter.take).toHaveBeenCalledWith('64b0c0ffee64b0c0ffee64b0');
  });

  test.each([
    ['no user', null],
    ['a user without a workspace', { id: 'u1' }],
    ['an empty workspace id', { id: 'u1', workspaceId: '' }],
  ])('403 FORBIDDEN for %s', async (_name, user) => {
    const { app, client } = appWith({ user });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(client.calls).toHaveLength(0);
  });
});

describe('429 AI_RATE_LIMITED', () => {
  test('30 calls a minute per workspace; the 31st gets 429 with Retry-After', async () => {
    let t = 10_000_000;
    const script = Array.from({ length: 31 }, () => ({ text: 'مرحباً' }));
    const { app, client } = appWith({ script, assistOptions: { now: () => t } });
    for (let i = 0; i < 30; i += 1) {
      const ok = await post(app, '/translate', { text: 'Hello', to: 'ar' });
      expect(ok.status).toBe(200);
      t += 100;
    }
    const limited = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('AI_RATE_LIMITED');
    expect(typeof limited.body.error).toBe('string');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(client.calls).toHaveLength(30);
    t += 61_000;
    expect((await post(app, '/translate', { text: 'Hello', to: 'ar' })).status).toBe(200);
  });

  test('the quota is per workspace and shared by all five endpoints', async () => {
    const limiter = createRateLimiter({ limit: 2 });
    let user = { id: 'u1', workspaceId: 'ws-a' };
    const { app } = appWith({ user: () => user, script: Array.from({ length: 6 }, () => ({ text: 'مرحباً', name: 'عطر', description: '' })), assistOptions: { limiter } });
    expect((await post(app, '/translate', { text: 'Hello', to: 'ar' })).status).toBe(200);
    expect((await post(app, '/saudi-friendly', { text: 'Hello' })).status).toBe(200);
    expect((await post(app, '/translate-inbound', { text: 'مرحبا' })).status).toBe(429);
    expect((await post(app, '/suggest-product-translation', { name: 'x' })).status).toBe(429);
    user = { id: 'u2', workspaceId: 'ws-b' };
    expect((await post(app, '/translate', { text: 'Hello', to: 'ar' })).status).toBe(200);
  });

  test('a validation failure does not spend quota', async () => {
    const limiter = createRateLimiter({ limit: 1 });
    const { app } = appWith({ script: [{ text: 'مرحباً' }], assistOptions: { limiter } });
    expect((await post(app, '/translate', { to: 'ar' })).status).toBe(400);
    expect((await post(app, '/translate', { text: 'Hello', to: 'ar' })).status).toBe(200);
  });
});

describe('failures never leak', () => {
  const SECRET = 'secret-key-leak sk-ant-0123456789';
  let spy;
  beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { spy.mockRestore(); });

  test('503 AI_UNAVAILABLE when the AI is not configured', async () => {
    const assist = createAiAssist({ getClient: () => null });
    const { app } = appWith({ assist });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'AI_UNAVAILABLE' });
  });

  test.each([401, 429, 529])('503 AI_UNAVAILABLE when the provider answers %i', async (status) => {
    const { app } = appWith({ script: [Object.assign(new Error(SECRET), { status })] });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/secret|sk-ant/);
  });

  test.each([500, 400, 504])('502 AI_FAILED when the provider answers %i, with no provider text', async (status) => {
    const { app } = appWith({ script: [Object.assign(new Error(SECRET), { status })] });
    const res = await post(app, '/translate', { text: 'UNIQUE-USER-TEXT Hello', to: 'ar' });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'AI_FAILED' });
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret|sk-ant|UNIQUE-USER-TEXT/);
  });

  test('502 AI_FAILED when the model never returns usable JSON', async () => {
    const { app } = appWith({ script: [{ nothing: true }, { nothing: true }] });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_FAILED');
  });

  test('a timeout is a 502 AI_FAILED', async () => {
    const hangs = { messages: { create: (p, o) => new Promise((resolve, reject) => o.signal.addEventListener('abort', () => reject(new Error('aborted')))) } };
    const assist = createAiAssist({ getClient: () => hangs, timeoutMs: 30 });
    const { app } = appWith({ assist });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_FAILED');
  });

  test('an unexpected exception is a 500 INTERNAL with no stack or message', async () => {
    const assist = { translate: jest.fn(async () => { throw new TypeError(`boom ${SECRET}`); }) };
    const { app } = appWith({ assist });
    const res = await post(app, '/translate', { text: 'Hello', to: 'ar' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Something went wrong', code: 'INTERNAL' });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|boom|stack/i);
  });

  test('a service error without a code still answers with one', async () => {
    const assist = { translateInbound: jest.fn(async () => { const err = new Error('bad input from a lower layer'); err.status = 400; throw err; }) };
    const { app } = appWith({ assist });
    const res = await post(app, '/translate-inbound', { text: 'Hello' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('the router itself', () => {
  test('exposes exactly the five POST endpoints', () => {
    const routes = aiRouter.stack.map((layer) => `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${layer.route.path}`).sort();
    expect(routes).toEqual([
      'POST /reply-in-arabic', 'POST /saudi-friendly', 'POST /suggest-product-translation', 'POST /translate', 'POST /translate-inbound',
    ]);
  });

  test('GET and other verbs are not routed', async () => {
    const { app } = appWith();
    expect((await request(app).get('/ai/translate')).status).toBe(404);
    expect((await request(app).put('/ai/translate').send({ text: 'x', to: 'ar' })).status).toBe(404);
    expect((await request(app).delete('/ai/translate')).status).toBe(404);
  });

  test('loading the router (and the service behind it) does not load the AI client or need a key', () => {
    mockClientModule.loads = 0;
    jest.isolateModules(() => { require('../../routes/localization/ai'); });
    expect(mockClientModule.loads).toBe(0);
  });

  test('the default export is a mountable Express router bound to the shared service', async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const app = express();
      app.use(express.json());
      app.use((req, res, next) => { req.user = USER; next(); });
      app.use('/api/localization/ai', aiRouter);
      const res = await request(app).post('/api/localization/ai/translate').send({ text: 'Hello', to: 'ar' });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('AI_UNAVAILABLE');
    } finally {
      spy.mockRestore();
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});
