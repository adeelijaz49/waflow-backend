require('dotenv').config();

// Regression test for a real bug: Resend's SDK does NOT throw on an API-level
// failure - send() resolves with { data: null, error: {...} } instead.
// utils/email.js originally returned that raw promise, so a magic-link send
// silently "succeeded" from the caller's perspective while never actually
// sending anything - the merchant saw "check your email" and nothing ever
// arrived.
//
// Mocked rather than hitting the real Resend API (unlike this app's other,
// real-service integration tests): what's under test here is purely
// utils/email.js's own {data,error} unwrapping, not Resend's actual behavior -
// and a real call left a lingering network handle that crashed Jest's
// --forceExit teardown on Windows (libuv UV_HANDLE_CLOSING assertion),
// silently turning `npm test`'s exit code non-zero even with every test green.
jest.mock('resend', () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: jest.fn().mockResolvedValue({ data: null, error: { message: 'mocked Resend failure' } }) },
  })),
}));

describe('utils/email.js surfaces Resend API-level failures as thrown errors', () => {
  test('sendMagicLinkEmail rejects instead of silently "succeeding" when Resend returns an error', async () => {
    const { sendMagicLinkEmail } = require('../utils/email');
    await expect(sendMagicLinkEmail('test@example.com', 'https://example.com/verify?token=abc'))
      .rejects.toThrow(/mocked Resend failure/);
  });

  test('sendInviteEmail rejects instead of silently "succeeding" when Resend returns an error', async () => {
    const { sendInviteEmail } = require('../utils/email');
    await expect(sendInviteEmail('test@example.com', '__test_workspace__', 'https://example.com/login'))
      .rejects.toThrow(/mocked Resend failure/);
  });
});
