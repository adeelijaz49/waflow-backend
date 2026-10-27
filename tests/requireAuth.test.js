'use strict';
// Unit tests for middleware/requireAuth.js (hardening) and middleware/requireSuperAdmin.js. No database: models/User is mocked.
process.env.AUTH_JWT_SECRET = process.env.AUTH_JWT_SECRET || 'unit-test-secret-not-real';

jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/PlatformAuditLog', () => ({ create: jest.fn() }));

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const PlatformAuditLog = require('../models/PlatformAuditLog');
const senderContext = require('../utils/senderContext');
const { requireAuth, JWT_SECRET, ISSUER, AUDIENCE } = require('../middleware/requireAuth');
const requireSuperAdmin = require('../middleware/requireSuperAdmin');

const WS = '64b64c64b64c64b64c64b64c';
const USER_ID = '64b64c64b64c64b64c64b64d';
const sign = (claims, opts = {}) => jwt.sign(claims, JWT_SECRET, { expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE, ...opts });

function makeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}
const makeReq = (token, extra = {}) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, method: 'GET', path: '/x', ...extra });

// requireAuth is async only when it has to look something up; await it either way.
async function runAuth(token) {
  const req = makeReq(token);
  const res = makeRes();
  let nextCalled = 0;
  let ctxInsideNext;
  await requireAuth(req, res, () => { nextCalled += 1; ctxInsideNext = senderContext.currentWorkspaceId(); });
  return { req, res, nextCalled, ctxInsideNext };
}

function mockStaff(user) {
  User.findById.mockReturnValue({ select: () => ({ lean: async () => user }) });
}

let savedAdmins;
beforeEach(() => {
  savedAdmins = process.env.SUPER_ADMIN_CONTACTS;
  delete process.env.SUPER_ADMIN_CONTACTS;
  User.findById.mockReset();
});
afterEach(() => {
  if (savedAdmins === undefined) delete process.env.SUPER_ADMIN_CONTACTS; else process.env.SUPER_ADMIN_CONTACTS = savedAdmins;
});

describe('requireAuth', () => {
  test('no header: 401 Not logged in, next not called', async () => {
    const out = await runAuth(null);
    expect(out.res.statusCode).toBe(401);
    expect(out.res.body).toEqual({ error: 'Not logged in' });
    expect(out.nextCalled).toBe(0);
  });

  test('garbage, expired and wrongly-signed tokens: 401', async () => {
    const wrongSecret = jwt.sign({ sub: USER_ID, workspaceId: WS, role: 'owner' }, 'another-secret', { issuer: ISSUER, audience: AUDIENCE });
    const expired = sign({ sub: USER_ID, workspaceId: WS, role: 'owner' }, { expiresIn: -10 });
    const wrongAudience = sign({ sub: USER_ID, workspaceId: WS, role: 'owner' }, { audience: 'someone-else' });
    for (const token of ['not-a-jwt', wrongSecret, expired, wrongAudience]) {
      const out = await runAuth(token);
      expect(out.res.statusCode).toBe(401);
      expect(out.nextCalled).toBe(0);
    }
  });

  test('a normal session token passes with exactly {id, workspaceId, role}', async () => {
    const out = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'member' }));
    expect(out.nextCalled).toBe(1);
    expect(out.req.user).toEqual({ id: USER_ID, workspaceId: WS, role: 'member' });
  });

  test('the pre-auth token (the 10-minute workspace-picker token) is rejected', async () => {
    const out = await runAuth(sign({ sub: USER_ID, preAuth: true }, { expiresIn: '10m' }));
    expect(out.res.statusCode).toBe(401);
    expect(out.nextCalled).toBe(0);
    expect(out.req.user).toBeUndefined();
  });

  test('a pre-auth flag is refused even when the token also carries a valid workspace id', async () => {
    const out = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner', preAuth: true }));
    expect(out.res.statusCode).toBe(401);
    expect(out.nextCalled).toBe(0);
  });

  test('a token with no workspace id, or one that is not a 24-hex ObjectId, is rejected', async () => {
    const bad = [undefined, null, '', 'abc', 'x'.repeat(24), WS + '0', WS.slice(1), `{"$ne":null}`, 12345, { $ne: null }, [WS]];
    for (const workspaceId of bad) {
      const out = await runAuth(sign({ sub: USER_ID, workspaceId, role: 'owner' }));
      expect(out.res.statusCode).toBe(401);
      expect(out.nextCalled).toBe(0);
    }
  });

  test('upper-case hex workspace ids are still accepted (they are valid ObjectIds)', async () => {
    const out = await runAuth(sign({ sub: USER_ID, workspaceId: WS.toUpperCase(), role: 'owner' }));
    expect(out.nextCalled).toBe(1);
  });

  test('the sender context holds the token\'s workspace while next() runs, and is not leaked afterwards', async () => {
    expect(senderContext.currentWorkspaceId()).toBeNull();
    const out = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner' }));
    expect(out.ctxInsideNext).toBe(WS);
    expect(senderContext.currentWorkspaceId()).toBeNull();
  });

  test('async work started inside next() still sees the workspace', async () => {
    const seen = [];
    await new Promise((resolve) => {
      requireAuth(makeReq(sign({ sub: USER_ID, workspaceId: WS, role: 'owner' })), makeRes(), () => {
        setTimeout(() => { seen.push(senderContext.currentWorkspaceId()); resolve(); }, 5);
      });
    });
    expect(seen).toEqual([WS]);
  });

  test('an error thrown by the next handler is not turned into a 401 by the middleware', async () => {
    const res = makeRes();
    await expect(Promise.resolve().then(() => requireAuth(makeReq(sign({ sub: USER_ID, workspaceId: WS, role: 'owner' })), res, () => { throw new Error('boom'); }))).rejects.toThrow('boom');
    expect(res.statusCode).toBe(200);
  });

  test('the sa claim is copied to req.user.sa (only when exactly true)', async () => {
    const yes = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner', sa: true }));
    expect(yes.req.user).toEqual({ id: USER_ID, workspaceId: WS, role: 'owner', sa: true });
    const truthy = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner', sa: 'true' }));
    expect(truthy.req.user.sa).toBeUndefined();
    const no = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner', sa: false }));
    expect(no.req.user.sa).toBeUndefined();
  });

  describe('act-as ("enter this customer") tokens', () => {
    const actAsToken = (over = {}) => sign({ sub: USER_ID, workspaceId: WS, role: 'owner', sa: true, actAs: true, ...over }, { expiresIn: '8h' });

    test('copies actAs and sa to req.user and runs next in the customer\'s sender context while the staff user is still allowlisted', async () => {
      process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
      mockStaff({ email: 'boss@example.com' });
      const out = await runAuth(actAsToken());
      expect(out.nextCalled).toBe(1);
      expect(out.req.user).toEqual({ id: USER_ID, workspaceId: WS, role: 'owner', sa: true, actAs: true });
      expect(out.ctxInsideNext).toBe(WS);
      expect(User.findById).toHaveBeenCalledWith(USER_ID);
    });

    test('is rejected (401) once the person is no longer on the allowlist: revocation does not wait for the 8 hours', async () => {
      process.env.SUPER_ADMIN_CONTACTS = 'someone-else@example.com';
      mockStaff({ email: 'boss@example.com' });
      const out = await runAuth(actAsToken());
      expect(out.res.statusCode).toBe(401);
      expect(out.nextCalled).toBe(0);
    });

    test('is rejected when the allowlist is empty, when the user no longer exists, and when sa is missing from the claims', async () => {
      mockStaff({ email: 'boss@example.com' });
      expect((await runAuth(actAsToken())).res.statusCode).toBe(401); // env empty
      process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
      mockStaff(null);
      expect((await runAuth(actAsToken())).res.statusCode).toBe(401); // user gone
      mockStaff({ email: 'boss@example.com' });
      const noSa = await runAuth(sign({ sub: USER_ID, workspaceId: WS, role: 'owner', actAs: true }));
      expect(noSa.res.statusCode).toBe(401);
      expect(noSa.nextCalled).toBe(0);
    });

    test('a database failure while checking answers 503, never lets the request through', async () => {
      process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
      User.findById.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db down'); } }) });
      const out = await runAuth(actAsToken());
      expect(out.res.statusCode).toBe(503);
      expect(out.nextCalled).toBe(0);
    });

    test('an act-as token with a bad workspace id is rejected before any lookup', async () => {
      const out = await runAuth(actAsToken({ workspaceId: 'nope' }));
      expect(out.res.statusCode).toBe(401);
      expect(User.findById).not.toHaveBeenCalled();
    });

    describe('what WaFlow staff change inside a customer is written to the audit trail first', () => {
      async function runWith(token, extra) {
        const req = makeReq(token, extra);
        const res = makeRes();
        const order = [];
        PlatformAuditLog.create.mockImplementation(async () => { order.push('audit'); });
        await requireAuth(req, res, () => { order.push('next'); });
        return { req, res, order };
      }
      beforeEach(() => {
        process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
        mockStaff({ email: 'boss@example.com' });
        PlatformAuditLog.create.mockReset();
      });

      test('a change (POST) is recorded BEFORE the request goes on: who, which customer, method and path (no query string, no body)', async () => {
        const out = await runWith(actAsToken(), {
          method: 'POST', originalUrl: '/api/products/abc?secret=1', ip: '10.0.0.4',
          headers: { authorization: `Bearer ${actAsToken()}`, 'x-forwarded-for': '203.0.113.9', 'user-agent': 'jest' },
          body: { name: 'Hat', note: 'must never be logged' },
        });
        expect(out.order).toEqual(['audit', 'next']);
        expect(PlatformAuditLog.create).toHaveBeenCalledTimes(1);
        const row = PlatformAuditLog.create.mock.calls[0][0];
        expect(row).toMatchObject({
          actorUserId: USER_ID, action: 'act_as_write', workspaceId: WS, ip: '10.0.0.4', forwardedFor: '203.0.113.9', userAgent: 'jest',
          detail: { method: 'POST', path: '/api/products/abc' },
        });
        expect(row.actorLabel).toMatch(/\*\*\*/); // masked, never the full contact
        expect(JSON.stringify(row)).not.toContain('boss@example.com');
        expect(JSON.stringify(row)).not.toContain('must never be logged');
        expect(JSON.stringify(row)).not.toContain('secret=1');
      });

      test.each(['PUT', 'PATCH', 'DELETE'])('%s is recorded too', async (method) => {
        const out = await runWith(actAsToken(), { method, originalUrl: '/api/customers/1' });
        expect(out.order).toEqual(['audit', 'next']);
        expect(PlatformAuditLog.create.mock.calls[0][0].detail).toEqual({ method, path: '/api/customers/1' });
      });

      test('reading (GET, HEAD, OPTIONS) is not logged', async () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS']) {
          const out = await runWith(actAsToken(), { method, originalUrl: '/api/customers' });
          expect(out.order).toEqual(['next']);
        }
        expect(PlatformAuditLog.create).not.toHaveBeenCalled();
      });

      test('leaving the customer (POST /api/platform/exit) is not logged twice: it writes its own "exit" row', async () => {
        for (const originalUrl of ['/api/platform/exit', '/api/platform/exit/', '/api/platform/exit?x=1']) {
          const out = await runWith(actAsToken(), { method: 'POST', originalUrl });
          expect(out.order).toEqual(['next']);
        }
        expect(PlatformAuditLog.create).not.toHaveBeenCalled();
      });

      test('if the row cannot be written the change is refused (503) and never reaches the route', async () => {
        const req = makeReq(actAsToken(), { method: 'POST', originalUrl: '/api/products' });
        const res = makeRes();
        let nextCalled = 0;
        PlatformAuditLog.create.mockRejectedValue(new Error('db down'));
        await requireAuth(req, res, () => { nextCalled += 1; });
        expect(res.statusCode).toBe(503);
        expect(res.body.error).toMatch(/audit log/);
        expect(nextCalled).toBe(0);
      });

      test('a long X-Forwarded-For is capped, a missing one is an empty string', async () => {
        await runWith(actAsToken(), { method: 'POST', originalUrl: '/api/products', headers: { authorization: `Bearer ${actAsToken()}`, 'x-forwarded-for': 'a'.repeat(500) } });
        expect(PlatformAuditLog.create.mock.calls[0][0].forwardedFor).toHaveLength(200);
        PlatformAuditLog.create.mockReset();
        await runWith(actAsToken(), { method: 'POST', originalUrl: '/api/products' });
        expect(PlatformAuditLog.create.mock.calls[0][0].forwardedFor).toBe('');
      });

      test('an ordinary session (not act-as) writes nothing to the platform trail', async () => {
        const out = await runWith(sign({ sub: USER_ID, workspaceId: WS, role: 'owner' }), { method: 'POST', originalUrl: '/api/products' });
        expect(out.order).toEqual(['next']);
        expect(PlatformAuditLog.create).not.toHaveBeenCalled();
      });
    });
  });
});

describe('requireSuperAdmin', () => {
  async function runGate(user, { method = 'GET', path = '/tenants' } = {}) {
    const req = { user, method, path };
    const res = makeRes();
    let nextCalled = 0;
    await requireSuperAdmin(req, res, () => { nextCalled += 1; });
    return { req, res, nextCalled };
  }
  const staff = { id: USER_ID, workspaceId: WS, role: 'owner' };

  test('without a req.user it answers 401 (it must run after requireAuth)', async () => {
    const out = await runGate(undefined);
    expect(out.res.statusCode).toBe(401);
    expect(out.nextCalled).toBe(0);
  });

  test('env empty: 403 Super admin only, and the database is not even asked', async () => {
    const out = await runGate(staff);
    expect(out.res.statusCode).toBe(403);
    expect(out.res.body).toEqual({ error: 'Super admin only' });
    expect(User.findById).not.toHaveBeenCalled();
  });

  test('allowlisted user (by email or by phone) passes and is exposed as req.platformActor', async () => {
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com, +61 422 286 126';
    mockStaff({ _id: USER_ID, email: 'Boss@Example.com' });
    const a = await runGate(staff);
    expect(a.nextCalled).toBe(1);
    expect(a.req.platformActor.email).toBe('Boss@Example.com');
    mockStaff({ _id: USER_ID, phone: '61422286126' });
    expect((await runGate(staff)).nextCalled).toBe(1);
  });

  test('a user who is not on the allowlist, or who no longer exists, gets 403 even if the token said sa', async () => {
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    mockStaff({ email: 'intruder@example.com' });
    const out = await runGate({ ...staff, sa: true });
    expect(out.res.statusCode).toBe(403);
    expect(out.nextCalled).toBe(0);
    mockStaff(null);
    expect((await runGate({ ...staff, sa: true })).res.statusCode).toBe(403);
  });

  test('every request re-reads the database: removing the contact from the env revokes access immediately', async () => {
    mockStaff({ email: 'boss@example.com' });
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    expect((await runGate(staff)).nextCalled).toBe(1);
    process.env.SUPER_ADMIN_CONTACTS = 'someone-else@example.com';
    expect((await runGate(staff)).res.statusCode).toBe(403);
    expect(User.findById).toHaveBeenCalledTimes(2);
  });

  test('an act-as session is refused everywhere except POST /exit', async () => {
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    mockStaff({ email: 'boss@example.com' });
    const acting = { ...staff, sa: true, actAs: true };
    for (const [method, path] of [['GET', '/tenants'], ['POST', '/tenants'], ['POST', '/tenants/abc/enter'], ['GET', '/exit'], ['POST', '/exit/x'], ['PUT', '/tenants/abc/whatsapp']]) {
      const out = await runGate(acting, { method, path });
      expect(out.res.statusCode).toBe(403);
      expect(out.res.body.error).toBe('Super admin only');
      expect(out.nextCalled).toBe(0);
    }
    expect((await runGate(acting, { method: 'POST', path: '/exit' })).nextCalled).toBe(1);
    expect((await runGate(acting, { method: 'POST', path: '/exit/' })).nextCalled).toBe(1);
  });

  test('a database error while checking answers 500, never lets the request through', async () => {
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    User.findById.mockReturnValue({ select: () => ({ lean: async () => { throw new Error('db down'); } }) });
    const out = await runGate(staff);
    expect(out.res.statusCode).toBe(500);
    expect(out.nextCalled).toBe(0);
  });

  test('a second pass on the same request (the router re-checks defensively) does not query again', async () => {
    process.env.SUPER_ADMIN_CONTACTS = 'boss@example.com';
    mockStaff({ email: 'boss@example.com' });
    const req = { user: staff, method: 'GET', path: '/tenants' };
    let nexts = 0;
    await requireSuperAdmin(req, makeRes(), () => { nexts += 1; });
    await requireSuperAdmin(req, makeRes(), () => { nexts += 1; });
    expect(nexts).toBe(2);
    expect(User.findById).toHaveBeenCalledTimes(1);
  });
});
