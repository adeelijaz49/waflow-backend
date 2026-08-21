require('dotenv').config();
const request = require('supertest');

const { connectOnce } = require('./dbSetup');
const { authedAgent } = require('./testAuth');
const app = require('../server');

// 1x1 transparent PNG.
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('POST /api/uploads/image', () => {
  let req;

  beforeAll(async () => {
    await connectOnce();
    req = await authedAgent(app);
  }, 30000);

  test('rejects a non-image file', async () => {
    const res = await req.post('/api/uploads/image').attach('image', Buffer.from('not an image'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  test('rejects when no file is provided', async () => {
    const res = await req.post('/api/uploads/image');
    expect(res.status).toBe(400);
  });

  // This env doesn't have AZURE_STORAGE_CONNECTION_STRING set, so this
  // exercises utils/blobStorage.js's local-disk fallback path — the same
  // path local dev uses. The real Azure Blob path isn't covered here (no
  // real Azure credentials in this test environment), same as this
  // codebase's existing convention for other optional external services
  // (e.g. Resend email isn't tested against a real API either).
  test('uploads a PNG and returns an immediately-reachable URL', async () => {
    const res = await req.post('/api/uploads/image').attach('image', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/uploads\/.+\.png$/);

    const fetched = await request(app).get(new URL(res.body.url).pathname);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toMatch(/png/);
  });
});
