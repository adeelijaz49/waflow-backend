require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const app = require('../server');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Membership = require('../models/Membership');
const LoginChallenge = require('../models/LoginChallenge');

const NEW_PHONE = '15559991000';
const NEW_EMAIL = '__test_auth_signup__@example.com';

async function cleanupUser(matcher) {
  const user = await User.findOne(matcher);
  if (!user) return;
  const memberships = await Membership.find({ userId: user._id });
  await Workspace.deleteMany({ _id: { $in: memberships.map(m => m.workspaceId) } });
  await Membership.deleteMany({ userId: user._id });
  await User.deleteOne({ _id: user._id });
}

describe('routes/auth.js — passwordless login', () => {
  beforeAll(async () => {
    await connectOnce();
    if (process.env.AUTH_TEST_MODE !== 'true') {
      throw new Error('AUTH_TEST_MODE must be true in .env to run this suite (never set it in production)');
    }
  }, 15000);

  afterAll(async () => {
    await cleanupUser({ phone: NEW_PHONE });
    await cleanupUser({ email: NEW_EMAIL });
    await LoginChallenge.deleteMany({ contact: { $in: [NEW_PHONE, NEW_EMAIL] } });
  });

  test('WhatsApp OTP: request -> wrong code fails -> correct code signs up a brand-new phone as Owner of a new workspace', async () => {
    const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: NEW_PHONE });
    expect(otpRes.status).toBe(200);
    expect(otpRes.body.testCode).toMatch(/^\d{6}$/);

    const wrong = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: '000000' });
    expect(wrong.status).toBe(400);

    const right = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: otpRes.body.testCode });
    expect(right.status).toBe(200);
    expect(right.body.token).toBeTruthy();
    expect(right.body.role).toBe('owner');
    expect(right.body.workspace?.id).toBeTruthy();

    // Single-use: the same code cannot be replayed
    const replay = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: otpRes.body.testCode });
    expect(replay.status).toBe(400);
  }, 30000);

  test('a valid session token unlocks a protected route; no token gets 401', async () => {
    const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: NEW_PHONE });
    const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: otpRes.body.testCode });
    const token = verifyRes.body.token;

    const noAuth = await request(app).get('/api/products');
    expect(noAuth.status).toBe(401);

    const withAuth = await request(app).get('/api/products').set('Authorization', `Bearer ${token}`);
    expect(withAuth.status).toBe(200);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('owner');
  }, 30000);

  test('logging in again with the same phone reuses the existing workspace, not a new one', async () => {
    const first = await request(app).post('/api/auth/otp/request').send({ phone: NEW_PHONE });
    const firstVerify = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: first.body.testCode });

    const second = await request(app).post('/api/auth/otp/request').send({ phone: NEW_PHONE });
    const secondVerify = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: second.body.testCode });

    expect(secondVerify.body.workspace.id).toBe(firstVerify.body.workspace.id);
  }, 30000);

  test('email magic link: request -> verify creates/reuses a user and is single-use', async () => {
    const linkRes = await request(app).post('/api/auth/magic-link/request').send({ email: NEW_EMAIL });
    expect(linkRes.status).toBe(200);
    expect(linkRes.body.testToken).toBeTruthy();

    const bad = await request(app).post('/api/auth/magic-link/verify').send({ token: 'not-a-real-token' });
    expect(bad.status).toBe(400);

    const good = await request(app).post('/api/auth/magic-link/verify').send({ token: linkRes.body.testToken });
    expect(good.status).toBe(200);
    expect(good.body.token).toBeTruthy();
    expect(good.body.role).toBe('owner');

    const replay = await request(app).post('/api/auth/magic-link/verify').send({ token: linkRes.body.testToken });
    expect(replay.status).toBe(400);
  }, 30000);

  test('a user in 2+ workspaces gets a chooseWorkspace prompt, and /select-workspace resolves it', async () => {
    // Build a second membership for the already-signed-up NEW_PHONE user.
    const user = await User.findOne({ phone: NEW_PHONE });
    const secondWorkspace = await Workspace.create({ name: '__test_auth_second_workspace__' });
    await Membership.create({ userId: user._id, workspaceId: secondWorkspace._id, role: 'member' });

    const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: NEW_PHONE });
    const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: NEW_PHONE, code: otpRes.body.testCode });

    expect(verifyRes.body.chooseWorkspace).toBe(true);
    expect(verifyRes.body.workspaces.length).toBe(2);
    expect(verifyRes.body.preAuthToken).toBeTruthy();

    const selectRes = await request(app).post('/api/auth/select-workspace').send({
      preAuthToken: verifyRes.body.preAuthToken, workspaceId: secondWorkspace._id.toString(),
    });
    expect(selectRes.status).toBe(200);
    expect(selectRes.body.role).toBe('member');
    expect(selectRes.body.workspace.id).toBe(secondWorkspace._id.toString());

    // Cleanup this test's extra workspace/membership (the main afterAll only
    // knows about the user's original workspace).
    await Membership.deleteOne({ userId: user._id, workspaceId: secondWorkspace._id });
    await Workspace.deleteOne({ _id: secondWorkspace._id });
  }, 30000);

  test('dev-login rejects a wrong secret and accepts the real one from DEV_LOGIN_SECRET', async () => {
    if (!process.env.DEV_LOGIN_SECRET) return; // not configured in this env - nothing to test
    const wrong = await request(app).post('/api/auth/dev-login').send({ secret: 'not-the-real-secret' });
    expect(wrong.status).toBe(401);

    const right = await request(app).post('/api/auth/dev-login').send({ secret: process.env.DEV_LOGIN_SECRET });
    expect(right.status).toBe(200);
    expect(right.body.token).toBeTruthy();
  }, 15000);
});
