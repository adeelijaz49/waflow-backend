'use strict';
const sendGate = require('../../../shared/onboarding/sendGate');

const WS = '507f1f77bcf86cd799439011';
const conn = (status, needsReconnect = false) => ({ status, needsReconnect });
const gs = (state, connection, policy = 'block') => ({ enrolled: true, sub: { state, source: null }, conn: connection, legacyPolicy: policy });

let savedFlag;
beforeEach(() => { savedFlag = process.env.ONBOARDING_FLOW; process.env.ONBOARDING_FLOW = 'on'; });
afterEach(() => { if (savedFlag === undefined) delete process.env.ONBOARDING_FLOW; else process.env.ONBOARDING_FLOW = savedFlag; });

describe('checkSending', () => {
  test('flag off: allowed and the gate state is never read', async () => {
    delete process.env.ONBOARDING_FLOW;
    const getGateState = jest.fn();
    expect(await sendGate.checkSending(WS, { getGateState })).toEqual({ allowed: true });
    expect(getGateState).not.toHaveBeenCalled();
  });
  test('legacy workspace: allowed', async () => {
    expect(await sendGate.checkSending(WS, { getGateState: async () => ({ enrolled: false }) })).toEqual({ allowed: true });
  });
  test.each([
    [gs('none', null), 'SUBSCRIPTION_REQUIRED', 'billing'],
    [gs('past_due', conn('connected'), 'platform_number'), 'PAYMENT_PAST_DUE', 'billing'],
    [gs('active', null), 'WHATSAPP_NOT_CONNECTED', 'connect'],
    [gs('active', conn('reconnect_required')), 'WHATSAPP_RECONNECT_REQUIRED', 'connect'],
    [gs('active', conn('connected'), 'block'), 'SENDING_NOT_AVAILABLE_YET', null],
  ])('blocked: %j -> %s', async (gateState, code, nextStep) => {
    expect(await sendGate.checkSending(WS, { getGateState: async () => gateState })).toEqual({ allowed: false, code, status: 402, nextStep });
  });
  test('connected + platform_number policy: allowed', async () => {
    expect(await sendGate.checkSending(WS, { getGateState: async () => gs('active', conn('connected'), 'platform_number') })).toEqual({ allowed: true });
  });
  test('ANY error is fail-open', async () => {
    expect(await sendGate.checkSending(WS, { getGateState: async () => { throw new Error('boom'); } })).toEqual({ allowed: true });
  });
});

describe('assertSendingAllowed', () => {
  test('resolves when allowed', async () => {
    await expect(sendGate.assertSendingAllowed(WS, { getGateState: async () => ({ enrolled: false }) })).resolves.toBeUndefined();
  });
  test('throws Error{status:402, code, message} when blocked', async () => {
    let err;
    try { await sendGate.assertSendingAllowed(WS, { getGateState: async () => gs('past_due', null) }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 402, code: 'PAYMENT_PAST_DUE', nextStep: 'billing' });
    expect(err.message).toMatch(/payment/i);
  });
});

describe('flowBlocked', () => {
  function deps(gateState, over = {}) {
    return {
      getGateState: jest.fn(async () => gateState),
      notify: jest.fn(async () => ({ created: true })),
      track: jest.fn(async () => {}),
      now: () => new Date('2026-10-15T23:59:00Z'),
      ...over,
    };
  }
  test('flag off: false without any read', async () => {
    delete process.env.ONBOARDING_FLOW;
    const d = deps(gs('none', null));
    expect(await sendGate.flowBlocked({ workspaceId: WS }, d)).toBe(false);
    expect(d.getGateState).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });
  test('legacy / allowed / no workspace -> false and no trail', async () => {
    const legacy = deps({ enrolled: false });
    expect(await sendGate.flowBlocked({ workspaceId: WS }, legacy)).toBe(false);
    const ok = deps(gs('active', conn('connected'), 'platform_number'));
    expect(await sendGate.flowBlocked({ workspaceId: WS }, ok)).toBe(false);
    expect(await sendGate.flowBlocked({}, ok)).toBe(false);
    expect(await sendGate.flowBlocked(null, ok)).toBe(false);
    expect(legacy.notify).not.toHaveBeenCalled();
    expect(ok.notify).not.toHaveBeenCalled();
  });
  test('blocked -> true and the visible trail (notification + event) is written', async () => {
    const d = deps(gs('past_due', conn('connected'), 'platform_number'));
    expect(await sendGate.flowBlocked({ workspaceId: WS }, d)).toBe(true);
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS, kind: 'sending_paused', dedupeKey: 'send_blocked:PAYMENT_PAST_DUE:2026-10-15', severity: 'warning',
    }));
    expect(d.notify.mock.calls[0][0].email).toBeUndefined(); // in-app only: the payment_failed mail already covers an unpaid workspace
    expect(d.track).toHaveBeenCalledWith(WS, { type: 'send_blocked', code: 'PAYMENT_PAST_DUE', step: 'billing' });
  });
  test('the event is written only when the notification was newly created (once per workspace/code/UTC day)', async () => {
    const d = deps(gs('active', null), { notify: jest.fn(async () => ({ created: false })) });
    expect(await sendGate.flowBlocked({ workspaceId: WS }, d)).toBe(true);
    expect(d.track).not.toHaveBeenCalled();
  });
  test('the dedupe key rolls over at UTC midnight', async () => {
    const dayOne = deps(gs('active', null));
    const dayTwo = deps(gs('active', null), { now: () => new Date('2026-10-16T00:00:01Z') });
    await sendGate.flowBlocked({ workspaceId: WS }, dayOne);
    await sendGate.flowBlocked({ workspaceId: WS }, dayTwo);
    expect(dayOne.notify.mock.calls[0][0].dedupeKey).toBe('send_blocked:WHATSAPP_NOT_CONNECTED:2026-10-15');
    expect(dayTwo.notify.mock.calls[0][0].dedupeKey).toBe('send_blocked:WHATSAPP_NOT_CONNECTED:2026-10-16');
  });
  test('connection codes point the notification at the connect step', async () => {
    const d = deps(gs('active', conn('reconnect_required')));
    await sendGate.flowBlocked({ workspaceId: WS }, d);
    expect(d.notify.mock.calls[0][0].actionPath).toBe('/setup/connect');
  });
  test('a failing trail never changes the answer; any error -> false', async () => {
    const d = deps(gs('none', null), { notify: jest.fn(async () => { throw new Error('db down'); }) });
    expect(await sendGate.flowBlocked({ workspaceId: WS }, d)).toBe(true);
    const e = deps(null, { getGateState: async () => { throw new Error('boom'); } });
    expect(await sendGate.flowBlocked({ workspaceId: WS }, e)).toBe(false);
  });
  test('ObjectId-like workspace ids are accepted', async () => {
    const d = deps(gs('none', null));
    expect(await sendGate.flowBlocked({ workspaceId: { toString: () => WS } }, d)).toBe(true);
    expect(d.getGateState).toHaveBeenCalledWith(WS);
  });
});
