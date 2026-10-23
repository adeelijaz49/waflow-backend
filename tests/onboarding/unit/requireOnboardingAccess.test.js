'use strict';
const requireOnboardingAccess = require('../../../shared/onboarding/requireOnboardingAccess');

const WS = '507f1f77bcf86cd799439011';
const conn = (status) => ({ status, needsReconnect: false });
const gs = (state) => ({ enrolled: true, sub: { state, source: null }, conn: conn('connected'), legacyPolicy: 'block' });

function fakeRes() {
  const res = { headers: {}, statusCode: null, body: null, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; res.headersSent = true; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}
async function run(mw, req) {
  const res = fakeRes();
  const next = jest.fn();
  await mw(req, res, next);
  return { res, next };
}
const user = (extra = {}) => ({ user: { id: '507f1f77bcf86cd799439099', workspaceId: WS, role: 'owner', ...extra } });
function membership(role) {
  return { findOne: jest.fn(() => ({ select: () => ({ lean: async () => (role ? { role } : null) }) })) };
}

describe('export shape', () => {
  test('both import styles work', () => {
    expect(typeof requireOnboardingAccess).toBe('function');
    expect(requireOnboardingAccess.requireOnboardingAccess).toBe(requireOnboardingAccess);
  });
});

describe('not enrolled', () => {
  test('404 ONBOARDING_NOT_AVAILABLE (same answer for every flavour of the gate)', async () => {
    for (const opts of [{}, { billingExempt: true }, { ownerOnly: true }, { ownerOnly: true, needsLegal: true }]) {
      const mw = requireOnboardingAccess(opts, { getGateState: async () => ({ enrolled: false }) });
      const { res, next } = await run(mw, user());
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('ONBOARDING_NOT_AVAILABLE');
    }
  });
  test('no user / no workspace in the token -> 404 and the gate is not consulted', async () => {
    const getGateState = jest.fn();
    const mw = requireOnboardingAccess({}, { getGateState });
    for (const req of [{}, { user: {} }, { user: { workspaceId: '' } }]) {
      expect((await run(mw, req)).res.statusCode).toBe(404);
    }
    expect(getGateState).not.toHaveBeenCalled();
  });
  test('the workspace id comes ONLY from the token, never from body or query', async () => {
    const getGateState = jest.fn(async () => ({ enrolled: false }));
    const mw = requireOnboardingAccess({}, { getGateState });
    await run(mw, { ...user(), body: { workspaceId: '507f1f77bcf86cd799439777' }, query: { workspaceId: '507f1f77bcf86cd799439888' }, params: { workspaceId: '507f1f77bcf86cd799439999' } });
    expect(getGateState).toHaveBeenCalledWith(WS);
  });
});

describe('subscription state', () => {
  const DENY = { none: 'SUBSCRIPTION_REQUIRED', pending: 'PAYMENT_PENDING', past_due: 'PAYMENT_PAST_DUE', cancelled: 'SUBSCRIPTION_CANCELLED' };
  test.each(Object.entries(DENY))('%s -> 402 %s with retry flags', async (state, code) => {
    const mw = requireOnboardingAccess({}, { getGateState: async () => gs(state) });
    const { res, next } = await run(mw, user());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body.code).toBe(code);
    expect(res.body.retry).toEqual(expect.objectContaining({ checkout: expect.any(Boolean) }));
  });
  test('active -> next() and req.onboarding.gate is set', async () => {
    const mw = requireOnboardingAccess({}, { getGateState: async () => gs('active') });
    const req = user();
    const { next } = await run(mw, req);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.onboarding.gate.sub.state).toBe('active');
  });
  test.each(Object.keys(DENY))('billingExempt passes for %s', async (state) => {
    const mw = requireOnboardingAccess({ billingExempt: true }, { getGateState: async () => gs(state) });
    expect((await run(mw, user())).next).toHaveBeenCalledTimes(1);
  });
  test('billingExempt still 404s a legacy workspace', async () => {
    const mw = requireOnboardingAccess({ billingExempt: true }, { getGateState: async () => ({ enrolled: false }) });
    expect((await run(mw, user())).res.statusCode).toBe(404);
  });
});

describe('ownerOnly (live Membership check, not the JWT role)', () => {
  test('owner passes', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: membership('owner') });
    expect((await run(mw, user())).next).toHaveBeenCalledTimes(1);
  });
  test('member -> 403 OWNER_ONLY', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: membership('member') });
    const { res, next } = await run(mw, user({ role: 'member' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('OWNER_ONLY');
  });
  test('a stale JWT that still says owner is overruled by the live Membership', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: membership('member') });
    const { res } = await run(mw, user({ role: 'owner' }));
    expect(res.statusCode).toBe(403);
  });
  test('a stale JWT that says member is overruled upward (promoted to owner)', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: membership('owner') });
    expect((await run(mw, user({ role: 'member' }))).next).toHaveBeenCalledTimes(1);
  });
  test('no membership at all, or a lookup error -> 403', async () => {
    const none = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: membership(null) });
    expect((await run(none, user())).res.statusCode).toBe(403);
    const broken = { findOne: () => { throw new Error('cast error'); } };
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: broken });
    expect((await run(mw, user())).res.statusCode).toBe(403);
  });
  test('the Membership query is scoped by the token workspace and user', async () => {
    const m = membership('owner');
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('active'), Membership: m });
    await run(mw, { ...user(), body: { workspaceId: 'other' } });
    expect(m.findOne).toHaveBeenCalledWith({ userId: '507f1f77bcf86cd799439099', workspaceId: WS });
  });
  test('the subscription check comes before the owner check', async () => {
    const m = membership('member');
    const mw = requireOnboardingAccess({ ownerOnly: true }, { getGateState: async () => gs('past_due'), Membership: m });
    const { res } = await run(mw, user());
    expect(res.body.code).toBe('PAYMENT_PAST_DUE');
    expect(m.findOne).not.toHaveBeenCalled();
  });
  test('not requested -> no Membership lookup', async () => {
    const m = membership('member');
    const mw = requireOnboardingAccess({}, { getGateState: async () => gs('active'), Membership: m });
    await run(mw, user());
    expect(m.findOne).not.toHaveBeenCalled();
  });
});

describe('needsLegal', () => {
  const deps = (status, role = 'owner') => ({ getGateState: async () => gs('active'), Membership: membership(role), getAcceptanceStatus: jest.fn(async () => status) });
  test('accepted -> next()', async () => {
    const d = deps({ requiresCombinedAcceptance: false, requiresDpaAcceptance: false });
    const mw = requireOnboardingAccess({ ownerOnly: true, needsLegal: true }, d);
    expect((await run(mw, user())).next).toHaveBeenCalledTimes(1);
    expect(d.getAcceptanceStatus).toHaveBeenCalledWith({ userId: '507f1f77bcf86cd799439099', workspaceId: WS, role: 'owner' });
  });
  test('combined terms not accepted -> 403 LEGAL_ACCEPTANCE_REQUIRED', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true, needsLegal: true }, deps({ requiresCombinedAcceptance: true, requiresDpaAcceptance: false }));
    const { res } = await run(mw, user());
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
  test('DPA not accepted blocks the owner', async () => {
    const mw = requireOnboardingAccess({ ownerOnly: true, needsLegal: true }, deps({ requiresCombinedAcceptance: false, requiresDpaAcceptance: true }));
    expect((await run(mw, user())).res.body.code).toBe('LEGAL_ACCEPTANCE_REQUIRED');
  });
  test('DPA does not block a non-owner (needsLegal without ownerOnly)', async () => {
    const mw = requireOnboardingAccess({ needsLegal: true }, deps({ requiresCombinedAcceptance: false, requiresDpaAcceptance: true }, 'member'));
    expect((await run(mw, user({ role: 'member' }))).next).toHaveBeenCalledTimes(1);
  });
  test('legal is checked after owner', async () => {
    const d = deps({ requiresCombinedAcceptance: true }, 'member');
    const mw = requireOnboardingAccess({ ownerOnly: true, needsLegal: true }, d);
    expect((await run(mw, user())).res.body.code).toBe('OWNER_ONLY');
    expect(d.getAcceptanceStatus).not.toHaveBeenCalled();
  });
});

describe('failures', () => {
  test('an unexpected error becomes a generic 500 (never 401, no leak)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mw = requireOnboardingAccess({}, { getGateState: async () => { throw new Error('secret db detail'); } });
    const { res } = await run(mw, user());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret db detail');
    spy.mockRestore();
  });
});

describe('liveMember (review R2-05): a removed member\'s 30-day JWT is refused on the routes that spend the merchant\'s Meta credentials', () => {
  const active = { getGateState: async () => gs('active') };
  test('no Membership row any more -> 403 NOT_A_MEMBER (never 401), whatever role the stale JWT claims', async () => {
    const m = membership(null);
    const mw = requireOnboardingAccess({ liveMember: true }, { ...active, Membership: m });
    const { res, next } = await run(mw, user({ role: 'owner' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'NOT_A_MEMBER', error: 'You are no longer a member of this workspace.' });
    expect(m.findOne).toHaveBeenCalledWith({ userId: '507f1f77bcf86cd799439099', workspaceId: WS }); // ONE indexed read of this user in this workspace
    expect(m.findOne).toHaveBeenCalledTimes(1);
  });
  test('a current member (any role) passes, with the stale JWT role ignored', async () => {
    for (const role of ['member', 'owner']) {
      const mw = requireOnboardingAccess({ liveMember: true }, { ...active, Membership: membership(role) });
      const { next } = await run(mw, user({ role: role === 'owner' ? 'member' : 'owner' }));
      expect(next).toHaveBeenCalledTimes(1);
    }
  });
  test('a failing membership read is "not a member" (fail closed), the other gates still come first', async () => {
    const throwing = { findOne: () => { throw new Error('malformed id'); } };
    const mw = requireOnboardingAccess({ liveMember: true }, { ...active, Membership: throwing });
    expect((await run(mw, user())).res.body.code).toBe('NOT_A_MEMBER');
    const unpaid = requireOnboardingAccess({ liveMember: true }, { getGateState: async () => gs('past_due'), Membership: membership(null) });
    expect((await run(unpaid, user())).res.body.code).toBe('PAYMENT_PAST_DUE'); // the subscription answer comes before the membership one
    const legacy = requireOnboardingAccess({ liveMember: true }, { getGateState: async () => ({ enrolled: false }), Membership: membership(null) });
    expect((await run(legacy, user())).res.statusCode).toBe(404);
  });
  test('without the option nothing reads the Membership (gate A stays as cheap as before)', async () => {
    const m = membership(null);
    const mw = requireOnboardingAccess({}, { ...active, Membership: m });
    expect((await run(mw, user())).next).toHaveBeenCalledTimes(1);
    expect(m.findOne).not.toHaveBeenCalled();
  });
  test('combined with ownerOnly the membership is read ONCE and a non-owner member still gets OWNER_ONLY, a removed one NOT_A_MEMBER', async () => {
    const m = membership('member');
    const mw = requireOnboardingAccess({ liveMember: true, ownerOnly: true }, { ...active, Membership: m });
    expect((await run(mw, user())).res.body.code).toBe('OWNER_ONLY');
    expect(m.findOne).toHaveBeenCalledTimes(1);
    const gone = requireOnboardingAccess({ liveMember: true, ownerOnly: true }, { ...active, Membership: membership(null) });
    expect((await run(gone, user())).res.body.code).toBe('NOT_A_MEMBER');
  });
});
