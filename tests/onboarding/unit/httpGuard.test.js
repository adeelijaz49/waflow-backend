'use strict';
const { createHttpGuard } = require('../../../shared/onboarding/httpGuard');

const WS = '507f1f77bcf86cd799439011';
const ID = '507f1f77bcf86cd799439022';
const conn = (status, needsReconnect = false) => ({ status, needsReconnect });
const gs = (state, connection, policy = 'block') => ({ enrolled: true, sub: { state, source: null }, conn: connection, legacyPolicy: policy });

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
const req = (method, baseUrl, path, token = 'tok') => ({ method, baseUrl, path, headers: token ? { authorization: `Bearer ${token}` } : {} });
const send = (token) => req('POST', '/api/promotions', `/${ID}/send`, token);

let savedFlag;
beforeEach(() => { savedFlag = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; });
afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

async function run(guard, request) {
  const res = fakeRes();
  const next = jest.fn();
  await guard(request, res, next);
  return { res, next };
}
function make(gateState, over = {}) {
  const deps = {
    verify: jest.fn(() => ({ sub: 'u1', workspaceId: WS, role: 'owner' })),
    getGateState: jest.fn(async () => gateState),
    autoEnrol: jest.fn(async () => ({ enrolled: false, reason: 'x' })),
    ...over,
  };
  return { deps, guard: createHttpGuard(deps) };
}

describe('flag off', () => {
  test('first statement is the flag check: next() and nothing else is touched', async () => {
    delete process.env.ONBOARDING_FLOW;
    const { guard, deps } = make(gs('none', null));
    const { res, next } = await run(guard, send());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(deps.verify).not.toHaveBeenCalled();
    expect(deps.getGateState).not.toHaveBeenCalled();
    expect(deps.autoEnrol).not.toHaveBeenCalled();
  });
  test('only the exact value "on" counts', async () => {
    process.env.ONBOARDING_FLOW = 'true';
    const { guard, deps } = make(gs('none', null));
    await run(guard, send());
    expect(deps.verify).not.toHaveBeenCalled();
  });
});

describe('requests it cannot attribute fall through to the route (its own requireAuth answers 401)', () => {
  test('no Authorization header', async () => {
    const { guard, deps } = make(gs('none', null));
    const { next, res } = await run(guard, send(null));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(deps.verify).not.toHaveBeenCalled();
  });
  test('non-Bearer header', async () => {
    const { guard } = make(gs('none', null));
    const r = send(null);
    r.headers.authorization = 'Basic abc';
    expect((await run(guard, r)).next).toHaveBeenCalledTimes(1);
  });
  test('invalid / expired token (verify throws)', async () => {
    const { guard, deps } = make(gs('none', null), { verify: jest.fn(() => { throw new Error('jwt expired'); }) });
    const { next, res } = await run(guard, send());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(deps.getGateState).not.toHaveBeenCalled();
  });
  test('pre-auth token (no workspace) and odd workspace ids', async () => {
    for (const payload of [{ sub: 'u', preAuth: true }, { sub: 'u' }, { sub: 'u', workspaceId: 'not-an-id' }, { sub: 'u', workspaceId: WS, preAuth: true }, null]) {
      const { guard, deps } = make(gs('none', null), { verify: jest.fn(() => payload) });
      const { next, res } = await run(guard, send());
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
      expect(deps.getGateState).not.toHaveBeenCalled();
    }
  });
});

describe('legacy workspace (not enrolled) is untouched', () => {
  test('send routes pass through; auto-enrolment is consulted and declines', async () => {
    const { guard, deps } = make({ enrolled: false });
    const { next, res } = await run(guard, send());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
    expect(deps.autoEnrol).toHaveBeenCalledWith({ workspaceId: WS });
  });
  test('a fresh signup is auto-enrolled on first sight and then evaluated (402 on a send route)', async () => {
    const calls = [];
    const { guard, deps } = make(null, {
      getGateState: jest.fn(async (id, opts) => { calls.push(opts); return calls.length === 1 ? { enrolled: false } : gs('none', null); }),
      autoEnrol: jest.fn(async () => ({ enrolled: true, reason: 'eligible' })),
    });
    const { res, next } = await run(guard, send());
    expect(deps.autoEnrol).toHaveBeenCalledTimes(1);
    expect(calls[1]).toEqual({ fresh: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe('SUBSCRIPTION_REQUIRED');
  });
  test('auto-enrolment that says enrolled but the gate still shows legacy -> pass through', async () => {
    const { guard } = make({ enrolled: false }, { autoEnrol: jest.fn(async () => ({ enrolled: true })) });
    const { next } = await run(guard, send());
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('enrolled workspaces', () => {
  test('subscription none -> 402 SUBSCRIPTION_REQUIRED with the retry flags on a send route', async () => {
    const { guard } = make(gs('none', null));
    const { res, next } = await run(guard, send());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body).toMatchObject({ code: 'SUBSCRIPTION_REQUIRED', nextStep: 'billing', retry: { checkout: true, billingPortal: false, reconnect: false } });
    expect(typeof res.body.error).toBe('string');
  });
  test('non-send routes pass through for the same workspace (data stays readable)', async () => {
    const { guard } = make(gs('none', null));
    for (const r of [req('GET', '/api/customers', ''), req('POST', '/api/customers', ''), req('GET', '/api/promotions', `/${ID}`), req('POST', '/api/imports', `/${ID}/run`), req('POST', '/api/onboarding', '/connect/complete'), req('GET', '/api/auth', '/me')]) {
      const { next, res } = await run(guard, r);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
    }
  });
  test.each([
    [gs('pending', null), 'PAYMENT_PENDING'],
    [gs('past_due', conn('connected')), 'PAYMENT_PAST_DUE'],
    [gs('cancelled', conn('connected')), 'SUBSCRIPTION_CANCELLED'],
    [gs('active', null), 'WHATSAPP_NOT_CONNECTED'],
    [gs('active', conn('reconnect_required')), 'WHATSAPP_RECONNECT_REQUIRED'],
    [gs('active', conn('connected'), 'block'), 'SENDING_NOT_AVAILABLE_YET'],
  ])('send route, %j -> 402 %s', async (gateState, code) => {
    const { guard } = make(gateState);
    const { res } = await run(guard, send());
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe(code);
  });
  test('connected + platform_number -> allowed', async () => {
    const { guard } = make(gs('active', conn('connected'), 'platform_number'));
    expect((await run(guard, send())).next).toHaveBeenCalledTimes(1);
  });
  test('Instagram connect routes only need an active subscription', async () => {
    const ig = req('GET', '/api/social-accounts', '/instagram/connect-url');
    expect((await run(make(gs('active', null)).guard, ig)).next).toHaveBeenCalledTimes(1);
    const denied = await run(make(gs('past_due', null)).guard, ig);
    expect(denied.res.statusCode).toBe(402);
    expect(denied.res.body.code).toBe('PAYMENT_PAST_DUE');
  });
  test('matching uses baseUrl + path (Express 5 strips the /api prefix)', async () => {
    const { guard } = make(gs('none', null));
    const viaBase = await run(guard, req('POST', '/api', `/promotions/${ID}/send`));
    expect(viaBase.res.statusCode).toBe(402);
    const noBase = await run(guard, req('POST', '', `/promotions/${ID}/send`));
    expect(noBase.next).toHaveBeenCalledTimes(1); // not under /api: not in the table
  });
  test('case and trailing-slash variants cannot bypass the table', async () => {
    const { guard } = make(gs('none', null));
    expect((await run(guard, req('POST', '/api', `/Promotions/${ID}/SEND/`))).res.statusCode).toBe(402);
  });
});

describe('never throws', () => {
  test('any internal failure falls through to next()', async () => {
    for (const bad of [
      { getGateState: jest.fn(async () => { throw new Error('boom'); }) },
      { autoEnrol: jest.fn(async () => { throw new Error('boom'); }), getGateState: jest.fn(async () => ({ enrolled: false })) },
    ]) {
      const { guard } = make(gs('none', null), bad);
      const { next, res } = await run(guard, send());
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBeNull();
    }
  });
  test('a request without headers does not throw', async () => {
    const { guard } = make(gs('none', null));
    const res = fakeRes(); const next = jest.fn();
    await expect(guard({ method: 'POST', baseUrl: '/api', path: '/x' }, res, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
