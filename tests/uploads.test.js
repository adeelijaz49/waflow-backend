require('dotenv').config();
const request = require('supertest');
const axios = require('axios');

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

  // Fetches the URL directly (not via request(app)) since it may be a local
  // /uploads path (blobStorage.js's fallback when AZURE_STORAGE_CONNECTION_STRING
  // is unset) OR a real blob.core.windows.net URL (when this env has real Azure
  // credentials, as local .env now does) — either way it must be immediately,
  // publicly reachable with no auth, same guarantee the old local-disk /uploads
  // static route always gave.
  test('uploads a PNG and returns an immediately-reachable URL', async () => {
    const res = await req.post('/api/uploads/image').attach('image', TINY_PNG, { filename: 'test.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\.png$/);

    // APP_URL-prefixed means blobStorage.js's local-disk fallback wrote it and
    // this app's own static route serves it; anything else is a real external
    // URL (e.g. blob.core.windows.net) fetched directly.
    const url = res.body.url;
    const isLocal = process.env.APP_URL && url.startsWith(process.env.APP_URL);
    const fetched = isLocal
      ? await request(app).get(new URL(url).pathname)
      : await axios.get(url, { responseType: 'arraybuffer', validateStatus: () => true });
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toMatch(/png/);
  });
});
