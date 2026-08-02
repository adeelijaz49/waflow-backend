const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const LoginChallenge = require('../models/LoginChallenge');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Membership = require('../models/Membership');
const { sendOtpTemplate } = require('../utils/whatsapp');
const { sendMagicLinkEmail } = require('../utils/email');
const { FRONTEND_URL } = require('../utils/config');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../middleware/requireAuth');

// Set only in local/CI env, NEVER in Azure App Service production settings —
// echoes the real code/token back in the response so tests don't need a real
// WhatsApp/email round trip. Mirrors this app's __test_-prefixed safe-test-data
// convention elsewhere.
const TEST_MODE = process.env.AUTH_TEST_MODE === 'true';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}
function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function underRateLimit(contact, method) {
  if (TEST_MODE) return true; // avoids flaking whenever the test suite reruns within one window
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const count = await LoginChallenge.countDocuments({ contact, method, createdAt: { $gte: since } });
  return count < RATE_LIMIT_MAX;
}

function issueSessionToken(userId, workspaceId, role) {
  return jwt.sign({ sub: String(userId), workspaceId: String(workspaceId), role }, JWT_SECRET, {
    expiresIn: '30d', issuer: ISSUER, audience: AUDIENCE,
  });
}

// Short-lived token identifying a verified-but-not-yet-workspace-scoped user —
// only used by POST /select-workspace, for people in 2+ workspaces.
function issuePreAuthToken(userId) {
  return jwt.sign({ sub: String(userId), preAuth: true }, JWT_SECRET, {
    expiresIn: '10m', issuer: ISSUER, audience: AUDIENCE,
  });
}

// Shared post-verification step: resolve which workspace(s) a confirmed User
// belongs to. Zero memberships -> self-serve into a brand-new workspace as
// Owner (confirmed product decision — this is what makes login = signup for
// a first-time contact). Exactly one -> issue the real session immediately.
// Two or more -> hand back a picker instead of guessing.
async function resolveSessionForUser(res, user) {
  const memberships = await Membership.find({ userId: user._id });

  if (memberships.length === 0) {
    const workspace = await Workspace.create({ name: `${user.name || user.phone || user.email}'s Workspace` });
    await Membership.create({ userId: user._id, workspaceId: workspace._id, role: 'owner' });
    const token = issueSessionToken(user._id, workspace._id, 'owner');
    return res.json({ token, workspace: { id: workspace._id, name: workspace.name }, role: 'owner' });
  }

  if (memberships.length === 1) {
    const m = memberships[0];
    const workspace = await Workspace.findById(m.workspaceId);
    const token = issueSessionToken(user._id, m.workspaceId, m.role);
    return res.json({ token, workspace: { id: workspace._id, name: workspace.name }, role: m.role });
  }

  const workspaces = await Workspace.find({ _id: { $in: memberships.map(m => m.workspaceId) } });
  const preAuthToken = issuePreAuthToken(user._id);
  res.json({
    chooseWorkspace: true,
    preAuthToken,
    workspaces: workspaces.map(w => ({
      id: w._id, name: w.name,
      role: memberships.find(m => String(m.workspaceId) === String(w._id)).role,
    })),
  });
}

// ── WhatsApp OTP ─────────────────────────────────────────────────────────────

router.post('/otp/request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'phone is required' });
    if (!(await underRateLimit(phone, 'whatsapp_otp'))) {
      return res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again' });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    await LoginChallenge.create({
      method: 'whatsapp_otp', contact: phone, codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });

    if (TEST_MODE) return res.json({ success: true, testCode: code });
    try {
      await sendOtpTemplate(phone, code);
    } catch (err) {
      // Don't leak a raw Graph API error (e.g. axios's "Request failed with
      // status code 404") to the merchant — point them at the working
      // fallback. Logged server-side so the real cause is still visible.
      console.error('[auth] WhatsApp OTP send failed:', err.response?.data || err.message);
      return res.status(503).json({ error: "We couldn't send a WhatsApp code right now — please use the Email tab instead." });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/otp/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '');
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required' });

    const challenge = await LoginChallenge.findOne({
      contact: phone, method: 'whatsapp_otp', consumedAt: null, expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });
    if (!challenge) return res.status(400).json({ error: 'No pending code for this number — request a new one' });
    if (challenge.attempts >= MAX_ATTEMPTS) return res.status(400).json({ error: 'Too many incorrect attempts — request a new code' });

    if (challenge.codeHash !== hashCode(code)) {
      challenge.attempts += 1;
      await challenge.save();
      return res.status(400).json({ error: 'Incorrect code' });
    }
    challenge.consumedAt = new Date();
    await challenge.save();

    let user = await User.findOne({ phone });
    if (!user) user = await User.create({ phone });

    await resolveSessionForUser(res, user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Email magic link ─────────────────────────────────────────────────────────

router.post('/magic-link/request', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email) return res.status(400).json({ error: 'email is required' });
    if (!(await underRateLimit(email, 'email_link'))) {
      return res.status(429).json({ error: 'Too many requests — please wait a few minutes and try again' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    await LoginChallenge.create({
      method: 'email_link', contact: email, codeHash: hashCode(token),
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
    });

    if (TEST_MODE) return res.json({ success: true, testToken: token });
    try {
      await sendMagicLinkEmail(email, `${FRONTEND_URL}/auth/verify?token=${token}`);
    } catch (err) {
      console.error('[auth] magic-link email send failed:', err.message);
      return res.status(503).json({ error: "We couldn't send that email right now — please try WhatsApp instead, or try again shortly." });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/magic-link/verify', async (req, res) => {
  try {
    const token = String(req.body.token || '');
    if (!token) return res.status(400).json({ error: 'token is required' });

    const challenge = await LoginChallenge.findOne({
      method: 'email_link', codeHash: hashCode(token), consumedAt: null, expiresAt: { $gt: new Date() },
    });
    if (!challenge) return res.status(400).json({ error: 'This link is invalid or has expired — request a new one' });
    challenge.consumedAt = new Date();
    await challenge.save();

    let user = await User.findOne({ email: challenge.contact });
    if (!user) user = await User.create({ email: challenge.contact });

    await resolveSessionForUser(res, user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Workspace selection (users belonging to 2+ workspaces) ──────────────────

router.post('/select-workspace', async (req, res) => {
  try {
    const { preAuthToken, workspaceId } = req.body;
    if (!preAuthToken || !workspaceId) return res.status(400).json({ error: 'preAuthToken and workspaceId are required' });

    let payload;
    try {
      payload = jwt.verify(preAuthToken, JWT_SECRET, { issuer: ISSUER, audience: AUDIENCE });
    } catch {
      return res.status(401).json({ error: 'This selection has expired — please log in again' });
    }
    if (!payload.preAuth) return res.status(400).json({ error: 'Invalid token' });

    const membership = await Membership.findOne({ userId: payload.sub, workspaceId });
    if (!membership) return res.status(403).json({ error: "You don't have access to that workspace" });

    const workspace = await Workspace.findById(workspaceId);
    const token = issueSessionToken(payload.sub, workspaceId, membership.role);
    res.json({ token, workspace: { id: workspace._id, name: workspace.name }, role: membership.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Temporary dev bypass ─────────────────────────────────────────────────────
// For continuing work before WhatsApp OTP / email magic link are configured
// (Meta Authentication template permission, Resend). Deliberately NOT the
// same mechanism as AUTH_TEST_MODE: that echoes real codes back to anyone who
// asks, which would be a real hole if ever left on in production. This is a
// no-op unless DEV_LOGIN_SECRET is explicitly set, requires that exact secret,
// and always logs in as the existing (oldest) account rather than anyone the
// caller names — remove or unset DEV_LOGIN_SECRET once real login works.
router.post('/dev-login', async (req, res) => {
  try {
    const secret = process.env.DEV_LOGIN_SECRET;
    if (!secret) return res.status(404).json({ error: 'Not found' });
    if (req.body.secret !== secret) return res.status(401).json({ error: 'Invalid secret' });

    const user = await User.findOne().sort({ createdAt: 1 });
    if (!user) return res.status(404).json({ error: 'No account exists yet — run scripts/migrate-to-workspace.js first' });

    await resolveSessionForUser(res, user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Current session ──────────────────────────────────────────────────────────

router.get('/me', require('../middleware/requireAuth').requireAuth, async (req, res) => {
  try {
    const [user, workspace] = await Promise.all([
      User.findById(req.user.id),
      Workspace.findById(req.user.workspaceId),
    ]);
    if (!user || !workspace) return res.status(401).json({ error: 'Session no longer valid' });
    res.json({
      user: { id: user._id, name: user.name, phone: user.phone, email: user.email },
      workspace: { id: workspace._id, name: workspace.name },
      role: req.user.role,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
