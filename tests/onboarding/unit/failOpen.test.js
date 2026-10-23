'use strict';
// Review R1-F3: the hooks on a LEGACY request path (httpGuard, webhookEvents.intercept, sendGate) race their database lookup against a
// short timeout that FAILS OPEN (never cached), and every fail-open path writes at most one log line per minute per module.
const failOpen = require('../../../shared/onboarding/failOpen');
const { createHttpGuard } = require('../../../shared/onboarding/httpGuard');
const sendGate = require('../../../shared/onboarding/sendGate');

const WS = '507f1f77bcf86cd799439011';
const ID = '507f1f77bcf86cd799439022';
const NEVER = () => new Promise(() => {});

let saved;
let warn;
beforeEach(() => {
  saved = process.env.ONBOARDING_FLOW;
  process.env.ONBOARDING_FLOW = 'on';
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  failOpen._resetLog();
});
afterEach(() => {
  jest.restoreAllMocks();
  if (saved === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = saved;
});
const failOpenLines = () => warn.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('fail-open'));

describe('withTimeout', () => {
  test('resolves with the value of a fast call (sync or async) and clears its timer', async () => {
    await expect(failOpen.withTimeout(() => 5, 1000)).resolves.toBe(5);
    await expect(failOpen.withTimeout(async () => 'x', 1000)).resolves.toBe('x');
  });
  test('rejects with ONB_LOOKUP_TIMEOUT when the call never settles; a late rejection of the abandoned call is absorbed', async () => {
    await expect(failOpen.withTimeout(NEVER, 20, 'thing')).rejects.toMatchObject({ code: 'ONB_LOOKUP_TIMEOUT' });
    let rejectLate;
    const late = new Promise((_, rej) => { rejectLate = rej; });
    await expect(failOpen.withTimeout(() => late, 20)).rejects.toMatchObject({ code: 'ONB_LOOKUP_TIMEOUT' });
    rejectLate(new Error('late'));
    await new Promise((r) => setImmediate(r)); // no unhandled rejection
  });
  test('a rejecting or throwing call rejects with its own error; the default timeout is 1.5 s', async () => {
    await expect(failOpen.withTimeout(async () => { throw new Error('db down'); }, 1000)).rejects.toThrow('db down');
    await expect(failOpen.withTimeout(() => { throw new Error('sync boom'); }, 1000)).rejects.toThrow('sync boom');
    expect(failOpen.TIMEOUT_MS).toBe(1500);
  });
});

describe('logFailOpen: one line per minute per module, the code only', () => {
  test('throttled per module, again after a minute, never the message', () => {
    const err = Object.assign(new Error('secret message with 966500000001 and EAAFtoken0123456789012345678901234567890123'), { code: 'ONB_LOOKUP_TIMEOUT' });
    failOpen.logFailOpen('modA', err, 0);
    failOpen.logFailOpen('modA', err, 1000);
    failOpen.logFailOpen('modB', err, 1000);
    expect(failOpenLines()).toHaveLength(2);
    failOpen.logFailOpen('modA', err, 61000);
    expect(failOpenLines()).toHaveLength(3);
    const text = failOpenLines().join('\n');
    expect(text).toContain('ONB_LOOKUP_TIMEOUT');
    expect(text).not.toMatch(/secret message|966500000001|EAAFtoken/);
  });
  test('an error without a safe code logs ERROR; it never throws', () => {
    expect(() => failOpen.logFailOpen('modC', { code: 'has spaces and !' }, 0)).not.toThrow();
    expect(() => failOpen.logFailOpen('modD', undefined, 0)).not.toThrow();
    expect(failOpenLines().join('\n')).toContain('ERROR');
  });
});

describe('httpGuard: a lookup that never settles must not hold the legacy /api request', () => {
  const send = { method: 'POST', baseUrl: '/api/promotions', path: `/${ID}/send`, headers: { authorization: 'Bearer tok' } };
  const guardOf = (over) => createHttpGuard({ verify: () => ({ sub: 'u1', workspaceId: WS, role: 'owner' }), lookupTimeoutMs: 30, ...over });
  const run = async (guard) => {
    const res = { statusCode: null, status() { return this; }, json() { return this; }, set() { return this; }, headersSent: false };
    const next = jest.fn();
    const started = Date.now();
    await guard(send, res, next);
    return { res, next, ms: Date.now() - started };
  };

  test('getGateState never settles -> next() after the timeout, one throttled line', async () => {
    const getGateState = jest.fn(NEVER);
    const { next, ms, res } = await run(guardOf({ getGateState }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBeNull();
    expect(ms).toBeLessThan(1000);
    expect(failOpenLines()).toHaveLength(1);
    expect(failOpenLines()[0]).toMatch(/httpGuard ONB_LOOKUP_TIMEOUT/);
    await run(guardOf({ getGateState }));
    await run(guardOf({ getGateState }));
    expect(failOpenLines()).toHaveLength(1); // throttled
  });
  test('the auto-enrolment lookup and the fresh re-read are bounded too', async () => {
    const legacy = { enrolled: false };
    const a = await run(guardOf({ getGateState: async () => legacy, autoEnrol: NEVER }));
    expect(a.next).toHaveBeenCalledWith();
    failOpen._resetLog();
    let calls = 0;
    const b = await run(guardOf({ getGateState: async () => { calls += 1; return calls === 1 ? legacy : NEVER(); }, autoEnrol: async () => ({ enrolled: true }) }));
    expect(b.next).toHaveBeenCalledWith();
    expect(calls).toBe(2);
  });
  test('an unexpected failure inside the guard is logged (throttled) and still falls through', async () => {
    const { next } = await run(guardOf({ getGateState: async () => { throw Object.assign(new Error('x'), { code: 'EBROKEN' }); } }));
    expect(next).toHaveBeenCalledWith();
    expect(failOpenLines()).toHaveLength(1);
    expect(failOpenLines()[0]).toContain('EBROKEN');
  });
  test('a lookup that settles in time still gates exactly as before (402 for an unpaid enrolled workspace)', async () => {
    const gs = { enrolled: true, sub: { state: 'none', source: null }, conn: null, legacyPolicy: 'block' };
    const res = { statusCode: null, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, headersSent: false };
    const next = jest.fn();
    await guardOf({ getGateState: async () => gs })(send, res, next);
    expect(res.statusCode).toBe(402);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('sendGate: a lookup that never settles means "allowed"', () => {
  test('checkSending fails open after the timeout and logs once per minute', async () => {
    const started = Date.now();
    expect(await sendGate.checkSending(WS, { getGateState: NEVER, lookupTimeoutMs: 30 })).toEqual({ allowed: true });
    expect(Date.now() - started).toBeLessThan(1000);
    await sendGate.checkSending(WS, { getGateState: NEVER, lookupTimeoutMs: 30 });
    expect(failOpenLines()).toHaveLength(1);
    expect(failOpenLines()[0]).toMatch(/sendGate ONB_LOOKUP_TIMEOUT/);
  });
  test('a plain error is fail-open and logged too', async () => {
    expect(await sendGate.checkSending(WS, { getGateState: async () => { throw new Error('boom'); } })).toEqual({ allowed: true });
    expect(failOpenLines()).toHaveLength(1);
  });
  test('flowBlocked: false for a hung gate lookup; the flow sweep (hunk E5 shape) goes on with the next flow', async () => {
    const hung = { _id: 'f1', workspaceId: WS };
    const second = { _id: 'f2', workspaceId: ID };
    const blocked = { enrolled: true, sub: { state: 'past_due', source: null }, conn: null, legacyPolicy: 'block' };
    const deps = {
      lookupTimeoutMs: 30,
      getGateState: jest.fn((ws) => (ws === WS ? NEVER() : Promise.resolve(blocked))),
      notify: jest.fn(async () => ({ created: true })),
      track: jest.fn(async () => {}),
    };
    const ran = [];
    for (const flow of [hung, second, { _id: 'f3', workspaceId: ID }]) {
      // exactly the shape of the hunk in utils/flowScheduler.js
      try { if (await sendGate.flowBlocked(flow, deps)) continue; } catch (_) { /* fail open */ }
      ran.push(flow._id);
    }
    expect(ran).toEqual(['f1']); // f1 fails open and runs; f2 / f3 (past due) are skipped; the loop was never stalled
    expect(deps.notify).toHaveBeenCalled();
  });
  test('flowBlocked: a trail write that never settles does not stall the sweep and the flow stays blocked', async () => {
    const blocked = { enrolled: true, sub: { state: 'cancelled', source: null }, conn: null, legacyPolicy: 'block' };
    const deps = { lookupTimeoutMs: 30, getGateState: async () => blocked, notify: NEVER, track: async () => {} };
    const started = Date.now();
    expect(await sendGate.flowBlocked({ workspaceId: WS }, deps)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(failOpenLines()).toHaveLength(1);
  });
  test('flag off: no lookup, no timer, no log', async () => {
    delete process.env.ONBOARDING_FLOW;
    const getGateState = jest.fn(NEVER);
    expect(await sendGate.flowBlocked({ workspaceId: WS }, { getGateState })).toBe(false);
    expect(getGateState).not.toHaveBeenCalled();
    expect(failOpenLines()).toHaveLength(0);
  });
});
