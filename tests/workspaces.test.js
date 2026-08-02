require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { authedAgent } = require('./testAuth');
const app = require('../server');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Invite = require('../models/Invite');

const INVITED_PHONE = '15559992000';
const INVITED_EMAIL = '__test_workspace_invite__@example.com';

describe('routes/workspaces.js — team invites and members', () => {
  let owner; // authenticated as the real migrated Owner (see tests/testAuth.js)
  let ownerWorkspaceId;

  beforeAll(async () => {
    await connectOnce();
    if (process.env.AUTH_TEST_MODE !== 'true') {
      throw new Error('AUTH_TEST_MODE must be true in .env to run this suite (never set it in production)');
    }
    owner = await authedAgent(app);
    const me = await owner.get('/api/auth/me');
    ownerWorkspaceId = me.body.workspace.id;
  }, 30000);

  afterAll(async () => {
    await Invite.deleteMany({ contact: { $in: [INVITED_PHONE, INVITED_EMAIL] } });
    const phoneUser = await User.findOne({ phone: INVITED_PHONE });
    if (phoneUser) {
      await Membership.deleteMany({ userId: phoneUser._id });
      await User.deleteOne({ _id: phoneUser._id });
    }
    const emailUser = await User.findOne({ email: INVITED_EMAIL });
    if (emailUser) {
      await Membership.deleteMany({ userId: emailUser._id });
      await User.deleteOne({ _id: emailUser._id });
    }
  });

  test('Owner invites a new phone number; a duplicate pending invite is rejected', async () => {
    const res = await owner.post('/api/workspaces/me/invites').send({ contactType: 'phone', contact: INVITED_PHONE, role: 'member' });
    expect(res.status).toBe(201);
    expect(res.body.contact).toBe(INVITED_PHONE);
    expect(res.body.role).toBe('member');
    expect(res.body.status).toBe('pending');

    const dupe = await owner.post('/api/workspaces/me/invites').send({ contactType: 'phone', contact: INVITED_PHONE, role: 'member' });
    expect(dupe.status).toBe(400);
  }, 30000);

  test('the invited phone logs in via OTP and lands directly in the Owner\'s workspace with the invited role', async () => {
    const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: INVITED_PHONE });
    const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: INVITED_PHONE, code: otpRes.body.testCode });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.role).toBe('member');
    expect(verifyRes.body.workspace.id).toBe(ownerWorkspaceId); // joined the INVITING workspace, not a fresh self-serve one

    const invite = await Invite.findOne({ contact: INVITED_PHONE });
    expect(invite.status).toBe('accepted');
  }, 30000);

  test('the member now shows up in the members list, and cannot invite others (Owner-only)', async () => {
    const members = await owner.get('/api/workspaces/me/members');
    expect(members.status).toBe(200);
    const joined = members.body.find(m => m.phone === INVITED_PHONE);
    expect(joined).toBeTruthy();
    expect(joined.role).toBe('member');

    const memberOtp = await request(app).post('/api/auth/otp/request').send({ phone: INVITED_PHONE });
    const memberVerify = await request(app).post('/api/auth/otp/verify').send({ phone: INVITED_PHONE, code: memberOtp.body.testCode });
    const memberToken = memberVerify.body.token;

    const forbidden = await request(app).post('/api/workspaces/me/invites')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ contactType: 'email', contact: '__test_should_not_work__@example.com', role: 'member' });
    expect(forbidden.status).toBe(403);
  }, 30000);

  test('Owner removes the member; the only Owner cannot remove themselves', async () => {
    const joinedUser = await User.findOne({ phone: INVITED_PHONE });
    const removeRes = await owner.delete(`/api/workspaces/me/members/${joinedUser._id}`);
    expect(removeRes.status).toBe(200);

    const stillMember = await Membership.findOne({ userId: joinedUser._id, workspaceId: ownerWorkspaceId });
    expect(stillMember).toBeNull();

    const me = await owner.get('/api/auth/me');
    const selfRemove = await owner.delete(`/api/workspaces/me/members/${me.body.user.id}`);
    expect(selfRemove.status).toBe(400);
  }, 30000);

  test('Owner invites by email; a pending invite can be revoked', async () => {
    const inviteRes = await owner.post('/api/workspaces/me/invites').send({ contactType: 'email', contact: INVITED_EMAIL, role: 'member' });
    expect(inviteRes.status).toBe(201);

    const revokeRes = await owner.delete(`/api/workspaces/me/invites/${inviteRes.body._id}`);
    expect(revokeRes.status).toBe(200);

    const list = await owner.get('/api/workspaces/me/invites');
    expect(list.body.find(i => i.contact === INVITED_EMAIL)).toBeUndefined();
  }, 30000);
});
