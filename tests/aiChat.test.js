require('dotenv').config();

const { connectOnce } = require('./dbSetup');
const { authedAgent } = require('./testAuth');
const app = require('../server');
const AiChatSession = require('../models/AiChatSession');

const TEST_SESSION_ID = '__test_ai_chat_session__';

describe('AI Mode chat (Phase 1 core)', () => {
  let request;

  beforeAll(async () => {
    await connectOnce();
    request = await authedAgent(app);
  }, 30000);

  afterAll(async () => {
    await AiChatSession.deleteOne({ sessionId: TEST_SESSION_ID });
  });

  test('a read-only question round-trips through Claude and gets a real answer', async () => {
    const res = await request
      .post('/api/ai-chat/message')
      .send({ sessionId: TEST_SESSION_ID, message: 'How many total orders does the store have? Use your tool to check, then tell me the exact number.' });

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(TEST_SESSION_ID);
    expect(typeof res.body.reply).toBe('string');
    expect(res.body.reply.length).toBeGreaterThan(0);
    expect(res.body.pendingAction).toBeNull(); // read-only question, nothing to confirm
  }, 30000);

  test('the conversation persists and rehydrates via GET /session/:id', async () => {
    const res = await request.get(`/api/ai-chat/session/${TEST_SESSION_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe(TEST_SESSION_ID);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2); // user turn + assistant reply
    expect(res.body.messages[0].role).toBe('user');
    expect(res.body.pendingAction).toBeNull();
  });

  test('GET /session/:id for an unknown session returns an empty session, not an error', async () => {
    const res = await request.get('/api/ai-chat/session/__nonexistent_session__');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
    expect(res.body.pendingAction).toBeNull();
  });
});
