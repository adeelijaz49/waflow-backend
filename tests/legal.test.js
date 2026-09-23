require('dotenv').config();
const request = require('supertest');
const jwt = require('jsonwebtoken');

const app = require('../server');
const { connectOnce } = require('./dbSetup');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../middleware/requireAuth');
const Workspace = require('../models/Workspace');
const User = require('../models/User');
const Membership = require('../models/Membership');
const LegalAcceptance = require('../models/LegalAcceptance');
const legalDocuments = require('../shared/legalDocuments');

// Dedicated fixtures (not the shared real test account from tests/testAuth.js)
// so acceptance history here never mixes with — or depends on the order of —
// any other test file's run. Tokens are minted directly, same shape
// requireAuth.js expects, rather than driving a real OTP login.
function tokenFor(userId, workspaceId, role) {
  return jwt.sign({ sub: String(userId), workspaceId: String(workspaceId), role }, JWT_SECRET, {
    expiresIn: '1h', issuer: ISSUER, audience: AUDIENCE,
  });
}

describe('routes/legal', () => {
  let workspace, ownerUser, memberUser, ownerToken, memberToken;

  beforeAll(async () => {
    await connectOnce();
    [workspace, ownerUser, memberUser] = await Promise.all([
      Workspace.create({ name: '__test_legal_workspace__' }),
      User.create({ phone: '15558870001', name: '__test_legal_owner__' }),
      User.create({ phone: '15558870002', name: '__test_legal_member__' }),
    ]);
    await Promise.all([
      Membership.create({ userId: ownerUser._id, workspaceId: workspace._id, role: 'owner' }),
      Membership.create({ userId: memberUser._id, workspaceId: workspace._id, role: 'member' }),
    ]);
    ownerToken = tokenFor(ownerUser._id, workspace._id, 'owner');
    memberToken = tokenFor(memberUser._id, workspace._id, 'member');
  }, 45000);

  afterAll(async () => {
    await LegalAcceptance.deleteMany({ workspaceId: workspace._id });
    await Membership.deleteMany({ workspaceId: workspace._id });
    await User.deleteMany({ _id: { $in: [ownerUser._id, memberUser._id] } });
    await Workspace.findByIdAndDelete(workspace._id);
  });

  test('GET /documents lists all five, each with a current version and draft status', async () => {
    const res = await request(app).get('/api/legal/documents').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(5);
    expect(res.body.every((d) => d.status === 'draft')).toBe(true);
  });

  test('GET /documents/:slug?version=<current> matches the no-param response; an unknown version 404s', async () => {
    const noParam = await request(app).get('/api/legal/documents/terms_of_service').set('Authorization', `Bearer ${ownerToken}`);
    const current = legalDocuments.getCurrentVersion('terms_of_service');
    const withParam = await request(app).get(`/api/legal/documents/terms_of_service?version=${current}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(withParam.body.body).toBe(noParam.body.body);

    const missing = await request(app).get('/api/legal/documents/terms_of_service?version=nonexistent').set('Authorization', `Bearer ${ownerToken}`);
    expect(missing.status).toBe(404);
  });

  test('a fresh workspace/user requires both the combined acceptance and the DPA (owner)', async () => {
    const res = await request(app).get('/api/legal/acceptance-status').set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requiresCombinedAcceptance).toBe(true);
    expect(res.body.requiresDpaAcceptance).toBe(true);
    expect(res.body.combined.documents).toHaveLength(3);
    expect(res.body.combined.documents.every((d) => !d.accepted)).toBe(true);
  });

  test('a non-owner never requires DPA acceptance, even though it is unaccepted', async () => {
    const res = await request(app).get('/api/legal/acceptance-status').set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body.requiresDpaAcceptance).toBe(false);
    expect(res.body.dpa.accepted).toBe(false);
  });

  test('accepting the combined step inserts 3 rows and clears the flag for that user only', async () => {
    const res = await request(app).post('/api/legal/accept/combined').set('Authorization', `Bearer ${memberToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.requiresCombinedAcceptance).toBe(false);
    expect(res.body.combined.documents.every((d) => d.accepted)).toBe(true);

    const rows = await LegalAcceptance.find({ userId: memberUser._id, flow: 'combined_tos_privacy_aup' });
    expect(rows).toHaveLength(3);

    // A different user in the same workspace is unaffected — acceptance is per-user.
    const ownerStatus = await request(app).get('/api/legal/acceptance-status').set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerStatus.body.requiresCombinedAcceptance).toBe(true);
  });

  test('a non-owner cannot accept the DPA (403), and nothing is logged', async () => {
    const res = await request(app).post('/api/legal/accept/dpa').set('Authorization', `Bearer ${memberToken}`).send({});
    expect(res.status).toBe(403);
    const rows = await LegalAcceptance.find({ documentSlug: legalDocuments.DPA_SLUG, workspaceId: workspace._id });
    expect(rows).toHaveLength(0);
  });

  test('the owner can accept the DPA, and it becomes visible workspace-wide (including to non-owners)', async () => {
    const res = await request(app).post('/api/legal/accept/dpa').set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.requiresDpaAcceptance).toBe(false);
    expect(res.body.dpa.acceptedByUserId).toBe(String(ownerUser._id));

    const memberStatus = await request(app).get('/api/legal/acceptance-status').set('Authorization', `Bearer ${memberToken}`);
    expect(memberStatus.body.dpa.accepted).toBe(true);
    expect(memberStatus.body.requiresDpaAcceptance).toBe(false); // never true for a non-owner anyway
  });

  test('a stale document version does not count as accepted, even though a row exists', async () => {
    await LegalAcceptance.create({
      workspaceId: workspace._id, userId: ownerUser._id, documentSlug: 'terms_of_service',
      documentVersion: 'draft-0-old', flow: 'combined_tos_privacy_aup',
    });
    const status = await request(app).get('/api/legal/acceptance-status').set('Authorization', `Bearer ${ownerToken}`);
    const tos = status.body.combined.documents.find((d) => d.slug === 'terms_of_service');
    expect(tos.accepted).toBe(false);
    expect(tos.acceptedVersion).toBe('draft-0-old');
  });
});
