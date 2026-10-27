const router = require('express').Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const LoginChallenge = require('../models/LoginChallenge');
const User = require('../models/User');
const Workspace = require('../models/Workspace');
const Membership = require('../models/Membership');
const Invite = require('../models/Invite');
const { sendOtpTemplate } = require('../utils/whatsapp');
const { sendMagicLinkEmail } = require('../utils/email');
const { FRONTEND_URL } = require('../utils/config');
const { JWT_SECRET, ISSUER, AUDIENCE } = require('../middleware/requireAuth');
const { toWesternDigits } = require('../shared/localization/arabicText');
const { normalizePhone, normalizeEmail, isSuperAdminUser, selfServeSignupAllowed } = require('../shared/platformAdmin');
const otpLockout = require('../shared/otpLockout');

// Set only in local/CI env, NEVER in Azure App Service production settings —
// echoes the real code/token back in the response so tests don't need a real
// WhatsApp/email round trip. Mirrors this app's __test_-prefixed safe-test-data
// convention elsewhere.
// (Read at each use, not once at load: it is fixed for the life of a real process, and a test can switch it.)
const testMode = () => process.env.AUTH_TEST_MODE === 'true';

const OTP_TTL_MS = 5 * 60 * 1000;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

// A code is usable for OTP_TTL_MS (a link for MAGIC_LINK_TTL_MS): that is `validUntil`. The ROW stays in the database for a day and an
// hour: the limits count it (3 requests per 10 minutes, and the wrong-guess lockout over 24 hours: shared/otpLockout.js), and the
// collection's TTL index on `expiresAt` would otherwise delete it five minutes after it was written and quietly shrink those windows.
const ROW_RETENTION_MS = 25 * 60 * 60 * 1000;
const challengeTimes = (ttlMs) => ({ validUntil: new Date(Date.now() + ttlMs), expiresAt: new Date(Date.now() + ROW_RETENTION_MS) });
// Rows written before `validUntil` existed still end at `expiresAt`.
const stillUsable = () => {
  const now = new Date();
  return { $or: [{ validUntil: { $gt: now } }, { validUntil: { $exists: false }, expiresAt: { $gt: now } }] };
};
function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `about ${Math.ceil(minutes / 60)} hours`;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

async function underRateLimit(contact, method) {
  if (testMode()) return true; // avoids flaking whenever the test suite reruns within one window
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);
  const count = await LoginChallenge.countDocuments({ contact, method, createdAt: { $gte: since } });
  return count < RATE_LIMIT_MAX;
}

// `user` (optional) is the signed-in User document: a super admin's token carries `sa: true` (a UI hint only - every
// platform route re-checks the allowlist against the database, see middleware/requireSuperAdmin.js).
function issueSessionToken(userId, workspaceId, role, user) {
  const claims = { sub: String(userId), workspaceId: String(workspaceId), role };
  if (user && isSuperAdminUser(user)) claims.sa = true;
  return jwt.sign(claims, JWT_SECRET, {
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
// belongs to. Zero memberships -> check for a pending Invite matching this
// contact first (join that workspace with the invited role - "logs in using
// the same passwordless methods above, and lands directly in the right
// workspace with the right role already assigned"); no invite -> self-serve
// into a brand-new workspace as Owner (this is what makes login = signup for
// a first-time contact). Exactly one membership -> issue the real session
// immediately. Two or more -> hand back a picker instead of guessing.
function workspaceSummary(workspace) {
  return {
    id: workspace._id, name: workspace.name,
    onboarding: { completed: workspace.onboarding?.completed !== false, currentStep: workspace.onboarding?.currentStep || 1 },
  };
}

async function resolveSessionForUser(res, user) {
  const memberships = await Membership.find({ userId: user._id });
  const superAdmin = isSuperAdminUser(user); // also returned to the app so it can offer the Platform area

  if (memberships.length === 0) {
    const contactFilters = [];
    if (user.phone) contactFilters.push({ contactType: 'phone', contact: user.phone });
    if (user.email) contactFilters.push({ contactType: 'email', contact: user.email });
    const invite = contactFilters.length
      ? await Invite.findOne({ status: 'pending', expiresAt: { $gt: new Date() }, $or: contactFilters })
      : null;

    if (invite) {
      await Membership.create({ userId: user._id, workspaceId: invite.workspaceId, role: invite.role });
      invite.status = 'accepted';
      await invite.save();
      const workspace = await Workspace.findById(invite.workspaceId);
      const token = issueSessionToken(user._id, invite.workspaceId, invite.role, user);
      return res.json({ token, workspace: workspaceSummary(workspace), role: invite.role, superAdmin });
    }

    // ALLOW_SELF_SERVE_SIGNUP=false: a stranger (no membership, no invite) does not get a workspace of their own - the
    // customers of this deployment are created by a super admin. Super admins still get one.
    if (!superAdmin && !selfServeSignupAllowed()) {
      return res.status(403).json({ error: 'Ask your administrator to invite you.' });
    }

    // Explicitly false — this is the one place the onboarding wizard actually
    // gets triggered from; the schema default (true) is what keeps every
    // pre-existing workspace unaffected by this field's introduction.
    const workspace = await Workspace.create({
      name: `${user.name || user.phone || user.email}'s Workspace`,
      onboarding: { completed: false, currentStep: 1 },
    });
    await Membership.create({ userId: user._id, workspaceId: workspace._id, role: 'owner' });
    const token = issueSessionToken(user._id, workspace._id, 'owner', user);
    return res.json({ token, workspace: workspaceSummary(workspace), role: 'owner', superAdmin });
  }

  if (memberships.length === 1) {
    const m = memberships[0];
    const workspace = await Workspace.findById(m.workspaceId);
    const token = issueSessionToken(user._id, m.workspaceId, m.role, user);
    return res.json({ token, workspace: workspaceSummary(workspace), role: m.role, superAdmin });
  }

  const workspaces = await Workspace.find({ _id: { $in: memberships.map(m => m.workspaceId) } });
  const preAuthToken = issuePreAuthToken(user._id);
  res.json({
    chooseWorkspace: true,
    superAdmin,
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
      method: 'whatsapp_otp', contact: phone, codeHash: hashCode(code), ...challengeTimes(OTP_TTL_MS),
    });

    if (testMode()) return res.json({ success: true, testCode: code });
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
    const code = toWesternDigits(String(req.body.code || '')); // IM-D O4: Arabic-Indic digits accepted in the typed code
    if (!phone || !code) return res.status(400).json({ error: 'phone and code are required' });

    // Wrong guesses are counted across every code of this number, not only the latest one (see shared/otpLockout.js).
    if (!testMode()) {
      const wait = await otpLockout.waitMs({ model: LoginChallenge, contact: phone, method: 'whatsapp_otp' });
      if (wait > 0) {
        res.set('Retry-After', String(Math.ceil(wait / 1000)));
        return res.status(429).json({ error: `Too many incorrect codes for this number - please wait ${waitText(wait)} and try again, or ask your administrator.` });
      }
    }

    const challenge = await LoginChallenge.findOne({
      contact: phone, method: 'whatsapp_otp', consumedAt: null, ...stillUsable(),
    }).sort({ createdAt: -1 });
    if (!challenge) return res.status(400).json({ error: 'No pending code for this number — request a new one' });
    if (challenge.attempts >= MAX_ATTEMPTS) return res.status(400).json({ error: 'Too many incorrect attempts — request a new code' });

    // The guess is counted BEFORE it is looked at, in one atomic step: requests sent in parallel cannot all get past the limit on the
    // same count (a read-then-save counter loses updates, so a burst of guesses would count as one).
    const taken = await LoginChallenge.findOneAndUpdate(
      { _id: challenge._id, consumedAt: null, attempts: { $lt: MAX_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    );
    if (!taken) return res.status(400).json({ error: 'Too many incorrect attempts — request a new code' });
    if (taken.codeHash !== hashCode(code)) return res.status(400).json({ error: 'Incorrect code' });

    // The right code: used exactly once (a second request with it at the same moment finds it gone), and the guess is given back so
    // that signing in is never counted as a wrong guess.
    const used = await LoginChallenge.findOneAndUpdate( // (findOneAndUpdate and the returned document: the way every other claim in this app is made)
      { _id: taken._id, consumedAt: null },
      { $set: { consumedAt: new Date() }, $inc: { attempts: -1 } },
      { returnDocument: 'after' },
    );
    if (!used) {
      // A second request with the same right code at the same moment: the first one signed in. This guess was not a wrong one either, so
      // it is given back too (never below zero).
      await LoginChallenge.findOneAndUpdate({ _id: taken._id, attempts: { $gt: 0 } }, { $inc: { attempts: -1 } }).catch(() => {});
      return res.status(400).json({ error: 'No pending code for this number — request a new one' });
    }

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
      method: 'email_link', contact: email, codeHash: hashCode(token), ...challengeTimes(MAGIC_LINK_TTL_MS),
    });

    if (testMode()) return res.json({ success: true, testToken: token });
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
      method: 'email_link', codeHash: hashCode(token), consumedAt: null, ...stillUsable(),
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

    const [workspace, user] = await Promise.all([Workspace.findById(workspaceId), User.findById(payload.sub)]);
    const token = issueSessionToken(payload.sub, workspaceId, membership.role, user);
    res.json({ token, workspace: workspaceSummary(workspace), role: membership.role, superAdmin: isSuperAdminUser(user) });
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
    const body = {
      user: { id: user._id, name: user.name, phone: user.phone, email: user.email },
      workspace: workspaceSummary(workspace),
      role: req.user.role,
      // Re-checked against the database on every call (the token's `sa` claim is only a hint), so removing a contact
      // from SUPER_ADMIN_CONTACTS stops the Platform area showing at the next refresh.
      superAdmin: isSuperAdminUser(user),
      // May this session manage the WhatsApp token and templates it sends from (the Settings cards)? The very rule routes/whatsapp.js
      // enforces (shared/platformStaff.js): platform staff for the platform's account, the owner of a customer for its own account.
      canManageWhatsApp: await require('../shared/platformStaff').canManageWhatsApp({ user, actAs: !!req.user.actAs, workspaceId: req.user.workspaceId, role: req.user.role }),
    };
    // "Enter this customer" sessions (token claim actAs): tell the app who it is looking at so it can show the banner.
    if (req.user.actAs) body.actingAs = { workspaceId: String(workspace._id), customerName: workspace.name, homeWorkspaceId: null };
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
