const request = require('supertest');

// Every real route is now gated by requireAuth. Rather than hand-mint JWTs,
// this drives the actual login endpoints (AUTH_TEST_MODE must be true so the
// OTP code comes back in the response) so the tests exercise the same code
// path a real login does. Cached at module scope — Jest --runInBand shares
// one process across every test file, so this only logs in once per run.
const TEST_PHONE = '61422286126'; // the real migrated Owner account (scripts/migrate-to-workspace.js)
let cachedToken = null;

async function getTestToken(app) {
  if (cachedToken) return cachedToken;
  if (process.env.AUTH_TEST_MODE !== 'true') {
    throw new Error('tests/testAuth.js requires AUTH_TEST_MODE=true in .env — never set this in production');
  }
  const otpRes = await request(app).post('/api/auth/otp/request').send({ phone: TEST_PHONE });
  const verifyRes = await request(app).post('/api/auth/otp/verify').send({ phone: TEST_PHONE, code: otpRes.body.testCode });
  cachedToken = verifyRes.body.token;
  if (!cachedToken) throw new Error(`testAuth login failed: ${JSON.stringify(verifyRes.body)}`);
  return cachedToken;
}

// Returns a supertest-shaped object whose get/post/put/patch/delete calls
// already carry a valid Authorization header — drop-in replacement for
// request(app) in existing test files.
async function authedAgent(app) {
  const token = await getTestToken(app);
  const base = request(app);
  const withAuth = (method) => (url) => base[method](url).set('Authorization', `Bearer ${token}`);
  return {
    get: withAuth('get'), post: withAuth('post'), put: withAuth('put'),
    patch: withAuth('patch'), delete: withAuth('delete'),
  };
}

module.exports = { authedAgent, getTestToken, TEST_PHONE };
